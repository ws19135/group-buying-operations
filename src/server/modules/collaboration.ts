import { z } from 'zod';
import type { Queryable, Tx } from '../lib/db';
import { pool, query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, isInternal, requirePerm } from '../lib/permissions';
import { AppError, conflict, forbidden, notFound, precondition, validation } from '../lib/errors';
import { audit, emitEvent } from '../lib/audit';
import { ids, todayTaipei } from '../lib/ids';
import { camelize } from '../lib/case';
import { isIsoDate } from '../lib/dates';
import { nonEmpty } from '../lib/text';
import { idempotent } from '../lib/idempotency';
import { campaignScope, collaborationScope } from '../lib/scope';
import { likePattern, listPaged, pageParams, patchEntity, applyClears, type ListResult } from '../lib/repo';
import { assertNoPii } from './selection';
import { isoDateOf, loadApp, logEvent, shipmentFacts, type AppRow } from './collaboration-shared';
import { startAssignment, assertAssignable, assigneesOf, countUnassigned } from './collaboration-assignment';
import { runRecipientPurge } from './collaboration-retention';
import {
  APPLICATION_PATCH_FIELDS, APPLICATION_SOURCES, APPLICATION_STATUSES, ADS_CONFIRM_STATUSES, ADS_INTENTS,
  BACKEND_SETUP_STATUSES, COLLABORATION_STATUSES, COLLAB_SHIPMENT_STATUSES, HOST_LAUNCH_FIELDS, LAUNCH_FIELDS,
  LAUNCH_INTENTS, SHIPMENT_TYPES, SHIPPABLE_APPLICATION_STATUSES, SHIPPED_BY_PARTIES, SUPPLY_STATUSES,
  VENDOR_LAUNCH_FIELDS, canTransitionApplication, canTransitionCollaboration, canTransitionShipment,
  computeRetentionUntil, isTerminalApplication, shipmentBucket, summarizeShipments, supplyStatusFor,
  toCsv, toForm1Row, toForm2Row, vendorMaySeeRecipient, vendorReviewComplete, allUnavailable,
  FORM1_EXPORT_HEADERS, FORM2_EXPORT_HEADERS, FORM2_VENDOR_EXPORT_HEADERS, RECIPIENT_DENY_MESSAGE, fulfilmentOpen, isSafeHttpUrl,
  type ExportPiiMode,
  type ApplicationStatus, type CollabShipmentStatus, type CollaborationStatus, type ExportRow, type ShipmentFact,
} from '../lib/collaboration-rules';

/**
 * 合作申請與樣品管理（COLLABORATION_APPLICATIONS）。
 *
 * 一筆申請＝「某一位團主，針對某一廠商的商品提出合作或試樣需求」。
 * 四個維度各走各的，不塞成一條超長狀態鏈：
 *   申請狀態 status｜合作狀態 collaboration_status｜物流（每一次寄送自己的 status）｜開團意願（launch.intent）
 *
 * 紅線：
 *  - 重用既有 hosts／vendors／products／skus／campaigns 主檔，不建平行主檔。
 *  - 不改 G1～G5 的核准語意：廠商核准供樣只影響本模組，不觸發任何 Gate。
 *  - 不強制轉成 Campaign；只有合作確認後才允許關聯既有檔期（資料庫 CHECK 也擋）。
 *  - 不產生庫存扣減與財務結算。
 *  - 收件個資獨立成表，欄位層級權限＋每次讀取寫稽核＋保留政策。
 */

// ---------------------------------------------------------------- 共用 schema 片段
const optDate = z.string().refine(isIsoDate, '日期格式需為 YYYY-MM-DD').nullable().optional().or(z.literal('').transform(() => null));
const reqDate = z.string().refine(isIsoDate, '日期格式需為 YYYY-MM-DD');
const txt = (n: number) => z.string().trim().max(n).nullable().optional().or(z.literal('').transform(() => null));
const optUrl = (n = 500) => z.string().trim().max(n).refine(isSafeHttpUrl, '連結需為 http:// 或 https:// 開頭的網址，且不可內嵌帳號密碼').nullable().optional().or(z.literal('').transform(() => null));
const refId = z.string().trim().max(40);

export const applicationCreateSchema = z.object({
  vendorId: refId,
  hostId: refId,
  productId: refId.nullable().optional(),
  source: z.enum(APPLICATION_SOURCES).optional(),
  appliedOn: optDate,
  ownerUserId: refId.nullable().optional(),
  note: txt(2000),
  internalNote: txt(2000),
  items: z.array(z.object({
    productId: refId,
    skuId: refId.nullable().optional(),
    requestedQty: z.number().int().min(1).max(9999).optional(),
    requestReason: txt(500),
  })).max(50).optional(),
}).strict();

export const applicationPatchSchema = z.object({
  productId: refId.nullable().optional(),
  appliedOn: optDate,
  ownerUserId: refId.nullable().optional(),
  note: txt(2000),
  internalNote: txt(2000),
  version: z.number().int().optional(),
}).strict();

export const itemCreateSchema = z.object({
  productId: refId,
  skuId: refId.nullable().optional(),
  requestedQty: z.number().int().min(1).max(9999).optional(),
  requestReason: txt(500),
}).strict();

export const itemPatchSchema = z.object({
  requestedQty: z.number().int().min(1).max(9999).optional(),
  requestReason: txt(500),
  version: z.number().int().optional(),
}).strict();

export const vendorReviewSchema = z.object({
  items: z.array(z.object({
    itemId: refId,
    approvedQty: z.number().int().min(0).max(9999),
    vendorNote: txt(500),
  })).min(1).max(50),
  decision: z.enum(['SUPPLY', 'DECLINE']).optional(),
  note: txt(1000),
}).strict();

export const recipientSchema = z.object({
  recipientName: z.string().trim().min(1, '請填寫收件人').max(80),
  recipientPhone: z.string().trim().min(1, '請填寫聯繫電話').max(40),
  postalCode: z.string().trim().max(10).nullable().optional().or(z.literal('').transform(() => null)),
  addressLine: z.string().trim().min(1, '請填寫收件地址').max(300),
  deliveryNote: txt(300),
  /** 團主（或代填者）確認「這份地址現在可用」；未確認的收件資料不會提供給廠商 */
  confirm: z.boolean().optional(),
}).strict();

export const shipmentCreateSchema = z.object({
  shipmentType: z.enum(SHIPMENT_TYPES),
  shippedByParty: z.enum(SHIPPED_BY_PARTIES).optional(),
  shipDate: optDate,
  carrier: txt(80),
  trackingNo: txt(80),
  quantity: z.number().int().min(1).max(9999).nullable().optional(),
  note: txt(500),
  fulfillmentShipmentId: refId.nullable().optional(),
}).strict();

export const shipmentPatchSchema = z.object({
  shipDate: optDate,
  carrier: txt(80),
  trackingNo: txt(80),
  quantity: z.number().int().min(1).max(9999).nullable().optional(),
  status: z.enum(COLLAB_SHIPMENT_STATUSES).optional(),
  note: txt(500),
  version: z.number().int().optional(),
}).strict();

export const launchSchema = z.object({
  intent: z.enum(LAUNCH_INTENTS).optional(),
  intentRespondedOn: optDate,
  intentNote: txt(500),
  plannedOpenDate: optDate,
  confirmedOpenDate: optDate,
  launchUrl: optUrl(),
  adsIntent: z.enum(ADS_INTENTS).optional(),
  adsNote: txt(500),
  collaborationNote: txt(1000),
}).strict();

export const vendorLaunchSchema = z.object({
  vendorPortalUrl: optUrl(),
  backendSetupEmail: z.string().trim().email('Email 格式不正確').nullable().optional().or(z.literal('').transform(() => null)),
  backendSetupStatus: z.enum(BACKEND_SETUP_STATUSES).optional(),
  backendSetupNote: txt(500),
  adsConfirmStatus: z.enum(ADS_CONFIRM_STATUSES).optional(),
}).strict();

/** 外部角色（團主／廠商）看得到的主檔欄位白名單 */
/**
 * 團主與廠商在自己的工作台看得到的欄位。
 * 都是他們自己案件的非個資資訊（進度、意願、日期）——收件個資一律不在這裡，
 * 必須走 getRecipient 專用端點，而那條路徑每次讀取都會寫稽核。
 * 刻意不含：internalNote（內部備註）、ownerName（內部承辦）、dedupeKey、
 * 以及廠商後台相關欄位（vendorPortalUrl／backendSetupEmail）——那些另外按角色放行。
 */
const EXTERNAL_APP_FIELDS = [
  'id', 'vendorId', 'hostId', 'productId', 'source', 'appliedOn', 'status', 'collaborationStatus',
  'campaignId', 'note', 'version', 'createdAt', 'updatedAt', 'hostName', 'vendorName', 'productName', 'campaignTitle',
  // 衍生的樣品進度與開團資訊：工作台要靠這些才看得懂案件走到哪
  'sample', 'sampleBucket', 'itemCount', 'shipmentCount', 'recipientConfirmed',
  'intent', 'plannedOpenDate', 'confirmedOpenDate', 'launchUrl', 'adsIntent',
];

/** 廠商額外看得到自己的後台設定欄位；團主看不到（可能含商業敏感的後台連結） */
const VENDOR_EXTRA_APP_FIELDS = ['backendSetupStatus'];

function projectApp(actor: Actor, row: Record<string, unknown>): Record<string, unknown> {
  if (isInternal(actor)) return row;
  const allowed = actor.role === 'VENDOR' ? [...EXTERNAL_APP_FIELDS, ...VENDOR_EXTRA_APP_FIELDS] : EXTERNAL_APP_FIELDS;
  const out: Record<string, unknown> = {};
  for (const k of allowed) if (k in row) out[k] = row[k];
  return out;
}

/** 內部角色才能看的操作一律經過這裡，避免各處各寫一次 */
function assertWritableApp(app: AppRow): void {
  if (isTerminalApplication(app.status)) throw precondition(`申請已${app.status === 'REJECTED' ? '退回' : app.status === 'CANCELLED' ? '取消' : '結案'}，不可再修改`);
}

async function itemFacts(db: Queryable, appId: string) {
  const r = await db.query<{ requested_qty: number; approved_qty: number | null; supply_status: string }>(
    `SELECT requested_qty, approved_qty, supply_status FROM collaboration_application_items WHERE application_id=$1 AND deleted_at IS NULL`, [appId]);
  return r.rows.map((x) => ({ requestedQty: x.requested_qty, approvedQty: x.approved_qty, supplyStatus: x.supply_status }));
}

async function ensureLaunch(tx: Tx, actor: Actor, appId: string): Promise<string> {
  const cur = await tx.query<{ id: string }>('SELECT id FROM collaboration_launch_details WHERE application_id=$1 FOR UPDATE', [appId]);
  if (cur.rowCount) return cur.rows[0].id;
  const id = await ids.collaborationLaunch(tx);
  await tx.query(
    `INSERT INTO collaboration_launch_details (id, organization_id, application_id, created_by, updated_by) VALUES ($1,$2,$3,$4,$4)`,
    [id, actor.orgId, appId, actor.userId]);
  return id;
}

/** 合作狀態的變更一律經過這裡（檢查轉換合法性、寫事件、寫稽核） */
async function setCollaborationStatus(tx: Tx, actor: Actor, app: AppRow, to: CollaborationStatus, note?: string | null): Promise<void> {
  if (app.collaboration_status === to) return;
  if (!canTransitionCollaboration(app.collaboration_status, to)) {
    throw precondition(`合作狀態不能由 ${app.collaboration_status} 直接變更為 ${to}`);
  }
  await tx.query('UPDATE collaboration_applications SET collaboration_status=$2, updated_by=$3 WHERE id=$1', [app.id, to, actor.userId]);
  await logEvent(tx, actor, app.id, 'COLLABORATION', 'STATUS', { from: app.collaboration_status, to, note: note ?? null });
  await audit(tx, actor, {
    action: 'collaboration.application.collaboration_status', entityType: 'collaboration_application', entityId: app.id,
    campaignId: app.campaign_id, before: { collaborationStatus: app.collaboration_status }, after: { collaborationStatus: to }, reason: note ?? null,
  });
  app.collaboration_status = to;
}

async function setStatus(tx: Tx, actor: Actor, app: AppRow, to: ApplicationStatus, reason?: string | null, extra: Record<string, unknown> = {}): Promise<void> {
  if (!canTransitionApplication(app.status, to)) throw precondition(`申請狀態不能由 ${app.status} 直接變更為 ${to}`);
  const sets = ['status=$2', 'status_reason=$3', 'updated_by=$4'];
  const params: unknown[] = [app.id, to, reason ?? null, actor.userId];
  for (const [k, v] of Object.entries(extra)) { params.push(v); sets.push(`${k}=$${params.length}`); }
  await tx.query(`UPDATE collaboration_applications SET ${sets.join(', ')} WHERE id=$1`, params);
  await logEvent(tx, actor, app.id, 'APPLICATION', 'STATUS', { from: app.status, to, note: reason ?? null });
  await audit(tx, actor, {
    action: 'collaboration.application.status', entityType: 'collaboration_application', entityId: app.id,
    campaignId: app.campaign_id, before: { status: app.status }, after: { status: to }, reason: reason ?? null,
  });
  await emitEvent(tx, actor, `collaboration.${to.toLowerCase()}`, 'collaboration_application', app.id, { status: to });
  app.status = to;
}

// ---------------------------------------------------------------- 建立
async function assertVendorHostProduct(db: Queryable, actor: Actor, vendorId: string, hostId: string, productIds: string[]): Promise<void> {
  const v = await db.query('SELECT 1 FROM vendors WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [vendorId, actor.orgId]);
  if (!v.rowCount) throw notFound('廠商');
  const h = await db.query('SELECT 1 FROM hosts WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [hostId, actor.orgId]);
  if (!h.rowCount) throw notFound('團主');
  for (const pid of productIds) {
    const p = await db.query<{ vendor_id: string }>('SELECT vendor_id FROM products WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [pid, actor.orgId]);
    if (!p.rowCount) throw notFound('商品');
    if (p.rows[0].vendor_id !== vendorId) throw validation('商品不屬於這個廠商');
  }
}

/**
 * 建立合作申請。三種來源都走這一支：
 *  - 營運建立（OPS）：可指定任意團主與廠商
 *  - 團主自己建立（HOST_FORM）：只能是自己
 *  - 廠商代建（VENDOR_FORM）：只能是自己的廠商
 */
export async function createApplication(actor: Actor, raw: z.input<typeof applicationCreateSchema>, idemKey?: string | null) {
  if (!can(actor, 'collaboration.create')) throw forbidden();
  const input = applicationCreateSchema.parse(raw);
  assertNoPii({ 備註: input.note, 內部備註: input.internalNote });
  for (const it of input.items ?? []) assertNoPii({ 申請原因: it.requestReason });

  // 外部角色只能替自己建立，而且不能自己填內部欄位
  let source = input.source ?? (isInternal(actor) ? 'OPS' : actor.role === 'HOST' ? 'HOST_FORM' : 'VENDOR_FORM');
  if (!isInternal(actor)) {
    if (input.internalNote || input.ownerUserId) throw forbidden();
    if (actor.role === 'HOST') {
      if (!actor.hostIds.includes(input.hostId)) throw forbidden();
      source = 'HOST_FORM';
    } else if (actor.role === 'VENDOR') {
      if (!actor.vendorIds.includes(input.vendorId)) throw forbidden();
      source = 'VENDOR_FORM';
    } else throw forbidden();
  }
  const items = input.items ?? (input.productId ? [{ productId: input.productId, skuId: null, requestedQty: 1, requestReason: null }] : []);
  if (!items.length) throw validation('請至少選擇一項申請樣品');
  await assertVendorHostProduct(pool(), actor, input.vendorId, input.hostId, [...new Set(items.map((i) => i.productId))]);
  // D-39：承辦人。營運小編建立的案件預設由自己承辦（否則建完自己就看不到）；只有具指派權限者可以指定別人；
  // 團主／廠商建立、或主管未指定承辦人的案件，進「待指派佇列」
  let ownerId: string | null = input.ownerUserId ?? null;
  if (isInternal(actor)) {
    if (ownerId && ownerId !== actor.userId && !can(actor, 'collaboration.assign')) throw forbidden();
    if (!ownerId && actor.role === 'OPS_EDITOR') ownerId = actor.userId;
    if (ownerId) await assertAssignable(pool(), actor.orgId, ownerId);
  }
  const appliedOn = input.appliedOn ?? todayTaipei();

  return withTx(async (tx) => {
    const { result, replayed } = await idempotent(tx, actor, 'collaboration.application.create', idemKey, async () => {
      const id = await ids.collaborationApplication(tx);
      await tx.query(
        `INSERT INTO collaboration_applications (id, organization_id, vendor_id, host_id, product_id, source, applied_on,
           owner_user_id, status, note, internal_note, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,'DRAFT',$8,$9,$10,$10)`,
        [id, actor.orgId, input.vendorId, input.hostId, input.productId ?? items[0].productId, source, appliedOn,
          input.note ?? null, input.internalNote ?? null, actor.userId]);
      if (ownerId) {
        await startAssignment(tx, actor, id, ownerId, 'PRIMARY');
        await logEvent(tx, actor, id, 'DATA', 'HANDOVER_ASSIGN', { note: '建立時指定承辦人', internal: true });
      }
      for (const it of items) {
        await tx.query(
          `INSERT INTO collaboration_application_items (id, organization_id, application_id, product_id, sku_id, requested_qty, request_reason, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
           ON CONFLICT (application_id, product_id, coalesce(sku_id, '')) WHERE deleted_at IS NULL DO NOTHING`,
          [await ids.collaborationItem(tx), actor.orgId, id, it.productId, it.skuId ?? null, it.requestedQty ?? 1, it.requestReason ?? null, actor.userId]);
      }
      await ensureLaunch(tx, actor, id);
      await logEvent(tx, actor, id, 'APPLICATION', 'CREATED', { to: 'DRAFT' });
      await audit(tx, actor, {
        action: 'collaboration.application.create', entityType: 'collaboration_application', entityId: id,
        after: { vendorId: input.vendorId, hostId: input.hostId, source, items: items.length, ownerUserId: ownerId },
      });
      return { id };
    }, { ...input, items });
    return { ...result, replayed };
  });
}

// ---------------------------------------------------------------- 列表
const LIST_SQL = `
  SELECT a.id, a.vendor_id, a.host_id, a.product_id, a.source, a.applied_on, a.owner_user_id, a.status,
         a.collaboration_status, a.campaign_id, a.trial_id, a.note, a.internal_note, a.version, a.created_at, a.updated_at,
         h.display_name AS host_name, v.name AS vendor_name, p.name AS product_name, c.title AS campaign_title,
         u.name AS owner_name,
         l.intent, l.planned_open_date, l.confirmed_open_date, l.launch_url, l.ads_intent, l.backend_setup_status,
         (SELECT count(*)::int FROM collaboration_application_items i WHERE i.application_id=a.id AND i.deleted_at IS NULL) AS item_count,
         (SELECT count(*)::int FROM collaboration_shipments s WHERE s.application_id=a.id AND s.status <> 'CANCELLED') AS shipment_count,
         (SELECT count(*)::int FROM collaboration_shipments s WHERE s.application_id=a.id AND s.status <> 'CANCELLED' AND s.shipment_type='RESEND' AND s.status <> 'PENDING') AS resend_done_count,
         (SELECT count(*)::int FROM collaboration_shipments s WHERE s.application_id=a.id AND s.shipment_type='RESEND' AND s.status='PENDING') AS resend_pending_count,
         (SELECT max(s.ship_date) FROM collaboration_shipments s WHERE s.application_id=a.id AND s.status <> 'CANCELLED') AS last_ship_date,
         (SELECT count(*)::int FROM collaboration_shipments s WHERE s.application_id=a.id AND s.status='DELIVERED') AS delivered_count,
         EXISTS (SELECT 1 FROM collaboration_recipients r WHERE r.application_id=a.id AND r.deleted_at IS NULL AND r.confirmed_at IS NOT NULL) AS recipient_confirmed
    FROM collaboration_applications a
    JOIN hosts h ON h.id = a.host_id
    JOIN vendors v ON v.id = a.vendor_id
    LEFT JOIN products p ON p.id = a.product_id
    LEFT JOIN campaigns c ON c.id = a.campaign_id
    LEFT JOIN users u ON u.id = a.owner_user_id
    LEFT JOIN collaboration_launch_details l ON l.application_id = a.id`;

export async function listApplications(actor: Actor, q: URLSearchParams): Promise<ListResult<Record<string, unknown>>> {
  if (!can(actor, 'collaboration.read') && !can(actor, 'collaboration.self')) throw forbidden();
  const sc = collaborationScope(actor, 1, 'a');
  if (sc.sql === 'FALSE') return { items: [], total: 0, limit: 50, offset: 0 };
  const params = [...sc.params];
  const where = [`(${sc.sql})`];
  const add = (cond: (n: number) => string, v: unknown) => { params.push(v); where.push(cond(params.length)); };

  const month = nonEmpty(q.get('month'));
  if (month && /^\d{4}-\d{2}$/.test(month)) add((n) => `to_char(a.applied_on, 'YYYY-MM') = $${n}`, month);
  const vendorId = nonEmpty(q.get('vendorId')); if (vendorId) add((n) => `a.vendor_id=$${n}`, vendorId);
  const hostId = nonEmpty(q.get('hostId')); if (hostId) add((n) => `a.host_id=$${n}`, hostId);
  const productId = nonEmpty(q.get('productId'));
  if (productId) add((n) => `(a.product_id=$${n} OR EXISTS (SELECT 1 FROM collaboration_application_items i WHERE i.application_id=a.id AND i.product_id=$${n} AND i.deleted_at IS NULL))`, productId);
  const status = nonEmpty(q.get('status')); if (status) add((n) => `a.status=$${n}`, status);
  const collab = nonEmpty(q.get('collaborationStatus')); if (collab) add((n) => `a.collaboration_status=$${n}`, collab);
  const intent = nonEmpty(q.get('intent')); if (intent) add((n) => `coalesce(l.intent,'PENDING')=$${n}`, intent);
  const ads = nonEmpty(q.get('adsIntent')); if (ads) add((n) => `coalesce(l.ads_intent,'PENDING')=$${n}`, ads);
  const backend = nonEmpty(q.get('backendSetupStatus')); if (backend) add((n) => `coalesce(l.backend_setup_status,'NOT_REQUIRED')=$${n}`, backend);
  const ownerUserId = nonEmpty(q.get('ownerUserId')); if (ownerUserId) add((n) => `a.owner_user_id=$${n}`, ownerUserId);
  const campaignId = nonEmpty(q.get('campaignId')); if (campaignId) add((n) => `a.campaign_id=$${n}`, campaignId);
  // 預計開團日與實際（已確認）開團日必須能分開篩選
  const plannedFrom = nonEmpty(q.get('plannedFrom')); if (plannedFrom && isIsoDate(plannedFrom)) add((n) => `l.planned_open_date >= $${n}`, plannedFrom);
  const plannedTo = nonEmpty(q.get('plannedTo')); if (plannedTo && isIsoDate(plannedTo)) add((n) => `l.planned_open_date <= $${n}`, plannedTo);
  const confirmedFrom = nonEmpty(q.get('confirmedFrom')); if (confirmedFrom && isIsoDate(confirmedFrom)) add((n) => `l.confirmed_open_date >= $${n}`, confirmedFrom);
  const confirmedTo = nonEmpty(q.get('confirmedTo')); if (confirmedTo && isIsoDate(confirmedTo)) add((n) => `l.confirmed_open_date <= $${n}`, confirmedTo);
  const text = nonEmpty(q.get('q'));
  if (text) add((n) => `(a.id ILIKE $${n} OR h.display_name ILIKE $${n} OR v.name ILIKE $${n} OR p.name ILIKE $${n})`, likePattern(text));
  // 寄送進度：以紀錄推導，不是讀某個布林欄位
  const ship = nonEmpty(q.get('shipment'));
  if (ship === 'TO_SHIP') where.push(`NOT EXISTS (SELECT 1 FROM collaboration_shipments s WHERE s.application_id=a.id AND s.status IN ('SHIPPED','DELIVERED','RETURNED'))`);
  if (ship === 'SHIPPED') where.push(`EXISTS (SELECT 1 FROM collaboration_shipments s WHERE s.application_id=a.id AND s.status IN ('SHIPPED','DELIVERED'))`);
  if (ship === 'RESEND_PENDING') where.push(`EXISTS (SELECT 1 FROM collaboration_shipments s WHERE s.application_id=a.id AND s.shipment_type='RESEND' AND s.status='PENDING')`);
  if (ship === 'RESENT') where.push(`EXISTS (SELECT 1 FROM collaboration_shipments s WHERE s.application_id=a.id AND s.shipment_type='RESEND' AND s.status <> 'PENDING' AND s.status <> 'CANCELLED')`);
  if (ship === 'DELIVERED') where.push(`EXISTS (SELECT 1 FROM collaboration_shipments s WHERE s.application_id=a.id AND s.status='DELIVERED')`);

  const sortable: Record<string, string> = {
    appliedOn: 'a.applied_on', status: 'a.status', host: 'h.display_name', vendor: 'v.name',
    plannedOpenDate: 'l.planned_open_date', confirmedOpenDate: 'l.confirmed_open_date', updatedAt: 'a.updated_at',
  };
  const sortKey = sortable[q.get('sort') ?? ''] ?? 'a.applied_on';
  const dir = q.get('dir') === 'asc' ? 'ASC' : 'DESC';

  const res = await listPaged<Record<string, unknown>>(`${LIST_SQL} WHERE ${where.join(' AND ')}`, params,
    `${sortKey} ${dir} NULLS LAST, a.id DESC`, pageParams(q));
  res.items = res.items.map((row) => {
    const r = row as Record<string, unknown> & { resend_done_count: number; resend_pending_count: number; shipment_count: number; delivered_count: number; last_ship_date: string | null };
    const summary = summarizeShipments(syntheticFacts(r));
    const out = camelize<Record<string, unknown>>(r);
    return projectApp(actor, { ...out, sample: summary, sampleBucket: shipmentBucket(summary) });
  });
  return res;
}

/**
 * 列表為了避免 N+1，用彙總欄位重建出等價的寄送事實，再交給同一個純函式推導進度，
 * 讓列表與詳情頁的「是否已補寄」口徑一定一致。
 */
function syntheticFacts(r: { resend_done_count: number; resend_pending_count: number; shipment_count: number; delivered_count: number; last_ship_date: string | null }): ShipmentFact[] {
  const facts: ShipmentFact[] = [];
  const resendDone = Number(r.resend_done_count ?? 0);
  const resendPending = Number(r.resend_pending_count ?? 0);
  const delivered = Number(r.delivered_count ?? 0);
  const total = Number(r.shipment_count ?? 0) + resendPending;
  const initial = Math.max(total - resendDone - resendPending, 0);
  for (let i = 0; i < initial; i++) {
    facts.push({ shipmentType: 'INITIAL', status: i < delivered ? 'DELIVERED' : r.last_ship_date ? 'SHIPPED' : 'PENDING', shipDate: r.last_ship_date });
  }
  for (let i = 0; i < resendDone; i++) {
    const idx = initial + i;
    facts.push({ shipmentType: 'RESEND', status: idx < delivered ? 'DELIVERED' : 'SHIPPED', shipDate: r.last_ship_date });
  }
  for (let i = 0; i < resendPending; i++) facts.push({ shipmentType: 'RESEND', status: 'PENDING', shipDate: null });
  return facts;
}

// ---------------------------------------------------------------- 詳情
export async function getApplication(actor: Actor, id: string): Promise<Record<string, unknown>> {
  if (!can(actor, 'collaboration.read') && !can(actor, 'collaboration.self')) throw forbidden();
  const sc = collaborationScope(actor, 1, 'a');
  if (sc.sql === 'FALSE') throw notFound('合作申請');
  const rows = await query(`${LIST_SQL} WHERE (${sc.sql}) AND a.id=$${sc.params.length + 1}`, [...sc.params, id]);
  if (!rows.length) throw notFound('合作申請');
  const row = rows[0] as Record<string, unknown> & { resend_done_count: number; resend_pending_count: number; shipment_count: number; delivered_count: number; last_ship_date: string | null };
  const internal = isInternal(actor);

  const items = await query(
    `SELECT i.id, i.product_id, i.sku_id, i.requested_qty, i.approved_qty, i.supply_status, i.request_reason, i.vendor_note, i.version,
            p.name AS product_name, s.sku_code, s.name AS sku_name
       FROM collaboration_application_items i
       JOIN products p ON p.id = i.product_id
       LEFT JOIN skus s ON s.id = i.sku_id
      WHERE i.application_id=$1 AND i.deleted_at IS NULL ORDER BY i.id`, [id]);

  const shipments = await query(
    `SELECT id, shipment_type, shipped_by_party, ship_date, carrier, tracking_no, quantity, status,
            receipt_confirmed_at, receipt_note, fulfillment_shipment_id, cancel_reason, version
            ${internal ? ', note, created_by' : ''}
       FROM collaboration_shipments WHERE application_id=$1 ORDER BY id`, [id]);

  const launch = await query(
    `SELECT id, intent, intent_responded_on, intent_note, planned_open_date, confirmed_open_date, launch_url,
            vendor_portal_url, backend_setup_email, backend_setup_status, backend_setup_note,
            ads_intent, ads_confirm_status, ads_note, collaboration_note, version
       FROM collaboration_launch_details WHERE application_id=$1`, [id]);

  const events = await query(
    `SELECT id, dimension, event_type, from_status, to_status, note, actor_role, created_at
       FROM collaboration_events WHERE application_id=$1 ${internal ? '' : 'AND is_internal = false'} ORDER BY id`, [id]);

  const recipientMeta = await query<{ id: string; confirmed_at: string | null; purged_at: string | null; retention_until: string | null }>(
    `SELECT id, confirmed_at, purged_at, retention_until FROM collaboration_recipients WHERE application_id=$1 AND deleted_at IS NULL`, [id]);

  const summary = summarizeShipments((shipments as { shipment_type: 'INITIAL' | 'RESEND'; status: CollabShipmentStatus; ship_date: string | null }[])
    .map((s) => ({ shipmentType: s.shipment_type, status: s.status, shipDate: s.ship_date })));

  const launchOut = launch.length ? camelize<Record<string, unknown>>(launch[0]) : null;
  // 廠商後台連結屬敏感商務資料：團主看不到
  if (launchOut && actor.role === 'HOST') { delete launchOut.vendorPortalUrl; delete launchOut.backendSetupEmail; delete launchOut.backendSetupNote; }

  const out = projectApp(actor, camelize<Record<string, unknown>>(row));
  return {
    ...out,
    items: camelize(items),
    shipments: camelize(shipments),
    launch: launchOut,
    events: camelize(events),
    sample: summary,
    sampleBucket: shipmentBucket(summary),
    /** 收件資料本體不在詳情頁回傳；要讀必須呼叫專用端點，每次都會寫稽核 */
    recipient: recipientMeta.length
      ? { present: true, confirmed: !!recipientMeta[0].confirmed_at, purged: !!recipientMeta[0].purged_at, retentionUntil: recipientMeta[0].retention_until }
      : { present: false, confirmed: false, purged: false, retentionUntil: null },
    nextActions: nextActions(row as unknown as AppRow, summary, launchOut),
    /** 承辦人與共同承辦（僅內部） */
    ...(internal ? { assignees: await assigneesOf(actor, id) } : {}),
  };
}

/** 未完成事項提示（詳情頁的「還差什麼」） */
function nextActions(app: AppRow, summary: ReturnType<typeof summarizeShipments>, launch: Record<string, unknown> | null): string[] {
  const out: string[] = [];
  if (app.status === 'DRAFT') out.push('申請還是草稿，請送出');
  if (app.status === 'SUBMITTED') out.push('等待內部審核');
  if (app.status === 'INTERNAL_REVIEW') out.push('等待轉給廠商確認供樣');
  if (app.status === 'VENDOR_REVIEW') out.push('等待廠商確認可供應的樣品與數量');
  if (app.status === 'APPROVED' && summary.progress === 'NOT_REQUESTED') out.push('已核准，等待建立寄送紀錄');
  if (summary.resendPending) out.push('有補寄紀錄尚未寄出');
  if (summary.progress === 'SHIPPED' || summary.progress === 'RESENT') out.push('等待團主確認收件');
  if ((launch?.intent ?? 'PENDING') === 'PENDING' && summary.progress === 'DELIVERED') out.push('等待團主回覆開團意願');
  if (app.collaboration_status === 'COLLABORATION_CONFIRMED' && !app.campaign_id) out.push('已確認合作，可關聯正式檔期');
  if (launch && launch.backendSetupStatus === 'PENDING') out.push('等待廠商提供後台設定');
  return out;
}

// ---------------------------------------------------------------- 更新主檔
export async function updateApplication(actor: Actor, id: string, raw: z.input<typeof applicationPatchSchema>) {
  const parsed = applicationPatchSchema.parse(raw);
  const input = applyClears(parsed, raw, ['productId', 'ownerUserId', 'note', 'internalNote']);
  assertNoPii({ 備註: input.note, 內部備註: input.internalNote });

  if (raw && typeof raw === 'object' && 'ownerUserId' in (raw as object)) {
    throw precondition('承辦人請使用「指派／交接」功能變更，不能直接修改欄位');
  }
  const allowed: readonly string[] = isInternal(actor)
    ? (can(actor, 'collaboration.update') ? APPLICATION_PATCH_FIELDS.INTERNAL : [])
    : actor.role === 'HOST' ? APPLICATION_PATCH_FIELDS.HOST : APPLICATION_PATCH_FIELDS.VENDOR;
  if (!allowed.length) throw forbidden();
  for (const k of Object.keys(input)) {
    if (k === 'version') continue;
    if (input[k as keyof typeof input] === undefined) continue;
    if (!allowed.includes(k)) throw forbidden();
  }

  return withTx(async (tx) => {
    const app = await loadApp(tx, actor, id, true);
    assertWritableApp(app);
    if (!isInternal(actor) && app.status !== 'DRAFT' && app.status !== 'SUBMITTED') {
      throw precondition('申請已進入審核流程，請聯繫營運人員修改');
    }
    if (input.productId) {
      const p = await tx.query<{ vendor_id: string }>('SELECT vendor_id FROM products WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [input.productId, actor.orgId]);
      if (!p.rowCount) throw notFound('商品');
      if (p.rows[0].vendor_id !== app.vendor_id) throw validation('商品不屬於這個廠商');
    }
    const { after } = await patchEntity(tx, actor, {
      table: 'collaboration_applications', entityType: 'collaboration_application', id,
      patch: input as Record<string, unknown>, allowed, expectedVersion: input.version,
      action: 'collaboration.application.update', campaignId: (r) => (r['campaign_id'] as string | null) ?? null,
    });
    return { id, version: after['version'] };
  });
}

// ---------------------------------------------------------------- 狀態流轉
export async function submitApplication(actor: Actor, id: string) {
  if (!can(actor, 'collaboration.create') && !can(actor, 'collaboration.update')) throw forbidden();
  return withTx(async (tx) => {
    const app = await loadApp(tx, actor, id, true);
    const items = await itemFacts(tx, id);
    if (!items.length) throw precondition('請先填寫申請樣品明細');
    await setStatus(tx, actor, app, 'SUBMITTED', null, { submitted_at: new Date() });
    return { id, status: app.status };
  });
}

export const internalReviewSchema = z.object({
  decision: z.enum(['TO_VENDOR', 'APPROVE', 'REJECT']),
  note: txt(1000),
}).strict();

/** 內部審核。只有具 collaboration.review 的角色（主管／管理者）可以做需核准權限的決策 */
export async function internalReview(actor: Actor, id: string, raw: z.input<typeof internalReviewSchema>) {
  requirePerm(actor, 'collaboration.review');
  const input = internalReviewSchema.parse(raw);
  assertNoPii({ 審核備註: input.note });
  return withTx(async (tx) => {
    const app = await loadApp(tx, actor, id, true);
    if (!['SUBMITTED', 'INTERNAL_REVIEW', 'VENDOR_REVIEW', 'ON_HOLD'].includes(app.status)) {
      throw precondition('目前狀態不需要內部審核');
    }
    if (app.status !== 'INTERNAL_REVIEW' && input.decision !== 'REJECT') await setStatus(tx, actor, app, 'INTERNAL_REVIEW', input.note);
    const stamp = { internal_reviewed_at: new Date(), internal_reviewed_by: actor.userId };
    if (input.decision === 'REJECT') {
      if (!input.note) throw validation('退回請填寫原因');
      await setStatus(tx, actor, app, 'REJECTED', input.note, { ...stamp, decided_at: new Date(), decided_by: actor.userId });
    } else if (input.decision === 'TO_VENDOR') {
      await setStatus(tx, actor, app, 'VENDOR_REVIEW', input.note, stamp);
    } else {
      await setStatus(tx, actor, app, 'APPROVED', input.note, { ...stamp, decided_at: new Date(), decided_by: actor.userId });
      await setCollaborationStatus(tx, actor, app, 'SAMPLE_IN_PROGRESS', '內部直接核准');
      await refreshRetention(tx, actor, app.id, todayTaipei());
    }
    return { id, status: app.status };
  });
}

/**
 * 廠商確認供樣：逐項填核准數量。
 * ⚠️ 廠商核准供樣只影響本模組，絕不觸發或替代 G1～G5 的任何核准。
 */
export async function vendorReview(actor: Actor, id: string, raw: z.input<typeof vendorReviewSchema>) {
  requirePerm(actor, 'collaboration.vendor.review');
  const input = vendorReviewSchema.parse(raw);
  for (const it of input.items) assertNoPii({ 廠商備註: it.vendorNote });
  assertNoPii({ 審核備註: input.note });

  return withTx(async (tx) => {
    const app = await loadApp(tx, actor, id, true);
    assertWritableApp(app);
    if (!['SUBMITTED', 'INTERNAL_REVIEW', 'VENDOR_REVIEW'].includes(app.status)) throw precondition('目前狀態不開放廠商確認供樣');
    if (app.status !== 'VENDOR_REVIEW') await setStatus(tx, actor, app, 'VENDOR_REVIEW', '廠商開始確認供樣');

    for (const it of input.items) {
      const cur = await tx.query<{ id: string; requested_qty: number }>(
        'SELECT id, requested_qty FROM collaboration_application_items WHERE id=$1 AND application_id=$2 AND organization_id=$3 AND deleted_at IS NULL FOR UPDATE',
        [it.itemId, id, actor.orgId]);
      if (!cur.rowCount) throw notFound('申請樣品明細');
      if (it.approvedQty > cur.rows[0].requested_qty) throw validation('核准數量不可大於申請數量');
      const supply = supplyStatusFor(cur.rows[0].requested_qty, it.approvedQty);
      await tx.query('UPDATE collaboration_application_items SET approved_qty=$2, supply_status=$3, vendor_note=$4, updated_by=$5 WHERE id=$1',
        [it.itemId, it.approvedQty, supply, it.vendorNote ?? null, actor.userId]);
      await audit(tx, actor, {
        action: 'collaboration.item.vendor_review', entityType: 'collaboration_application_item', entityId: it.itemId,
        after: { approvedQty: it.approvedQty, supplyStatus: supply },
      });
    }
    const facts = await itemFacts(tx, id);
    await logEvent(tx, actor, id, 'APPLICATION', 'VENDOR_REVIEW', { note: input.note ?? null });
    const stamp = { vendor_reviewed_at: new Date(), vendor_reviewed_by: actor.userId };

    if (input.decision === 'DECLINE' || allUnavailable(facts)) {
      await setStatus(tx, actor, app, 'REJECTED', input.note ?? '廠商無法供應樣品', { ...stamp, decided_at: new Date(), decided_by: actor.userId });
    } else if (vendorReviewComplete(facts)) {
      await setStatus(tx, actor, app, 'APPROVED', input.note ?? '廠商已確認供樣', { ...stamp, decided_at: new Date(), decided_by: actor.userId });
      await setCollaborationStatus(tx, actor, app, 'SAMPLE_IN_PROGRESS', '廠商已確認供樣');
      await refreshRetention(tx, actor, app.id, todayTaipei());
    } else {
      await tx.query('UPDATE collaboration_applications SET vendor_reviewed_at=$2, vendor_reviewed_by=$3, updated_by=$3 WHERE id=$1', [id, stamp.vendor_reviewed_at, actor.userId]);
    }
    return { id, status: app.status, supplyComplete: vendorReviewComplete(facts) };
  });
}

export async function holdApplication(actor: Actor, id: string, reason: string) {
  requirePerm(actor, 'collaboration.update');
  if (!reason?.trim()) throw validation('請填寫暫緩原因');
  return withTx(async (tx) => {
    const app = await loadApp(tx, actor, id, true);
    assertWritableApp(app);
    await setStatus(tx, actor, app, 'ON_HOLD', reason, { hold_reason: reason });
    return { id, status: app.status };
  });
}

export async function resumeApplication(actor: Actor, id: string, to: ApplicationStatus) {
  requirePerm(actor, 'collaboration.update');
  if (!APPLICATION_STATUSES.includes(to)) throw validation('目標狀態不正確');
  return withTx(async (tx) => {
    const app = await loadApp(tx, actor, id, true);
    if (app.status !== 'ON_HOLD') throw precondition('只有暫緩中的申請可以恢復');
    await setStatus(tx, actor, app, to, '恢復處理', { hold_reason: null });
    return { id, status: app.status };
  });
}

export async function cancelApplication(actor: Actor, id: string, reason: string) {
  if (!reason?.trim()) throw validation('請填寫取消原因');
  return withTx(async (tx) => {
    const app = await loadApp(tx, actor, id, true);
    // 團主／廠商只能取消自己還沒進審核的申請
    if (!isInternal(actor)) {
      if (!can(actor, 'collaboration.self')) throw forbidden();
      if (!['DRAFT', 'SUBMITTED'].includes(app.status)) throw precondition('申請已進入審核流程，請聯繫營運人員');
    } else requirePerm(actor, 'collaboration.update');
    assertWritableApp(app);
    await setStatus(tx, actor, app, 'CANCELLED', reason, { decided_at: new Date(), decided_by: actor.userId });
    return { id, status: app.status };
  });
}

export async function closeApplication(actor: Actor, id: string, reason: string | null) {
  requirePerm(actor, 'collaboration.review');
  return withTx(async (tx) => {
    const app = await loadApp(tx, actor, id, true);
    await setStatus(tx, actor, app, 'CLOSED', reason, { decided_at: new Date(), decided_by: actor.userId });
    return { id, status: app.status };
  });
}

// ---------------------------------------------------------------- 申請樣品明細
export async function addItem(actor: Actor, appId: string, raw: z.input<typeof itemCreateSchema>, idemKey?: string | null) {
  const input = itemCreateSchema.parse(raw);
  assertNoPii({ 申請原因: input.requestReason });
  return withTx(async (tx) => {
    const app = await loadApp(tx, actor, appId, true);
    assertWritableApp(app);
    if (!isInternal(actor)) {
      if (!can(actor, 'collaboration.self')) throw forbidden();
      if (!['DRAFT', 'SUBMITTED'].includes(app.status)) throw precondition('申請已進入審核流程，不可再增加樣品');
    } else requirePerm(actor, 'collaboration.update');
    const p = await tx.query<{ vendor_id: string }>('SELECT vendor_id FROM products WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [input.productId, actor.orgId]);
    if (!p.rowCount) throw notFound('商品');
    if (p.rows[0].vendor_id !== app.vendor_id) throw validation('商品不屬於這個廠商');
    if (input.skuId) {
      const s = await tx.query('SELECT 1 FROM skus WHERE id=$1 AND product_id=$2 AND organization_id=$3 AND deleted_at IS NULL', [input.skuId, input.productId, actor.orgId]);
      if (!s.rowCount) throw validation('規格不屬於這個商品');
    }
    const { result, replayed } = await idempotent(tx, actor, 'collaboration.item.create', idemKey, async () => {
      const id = await ids.collaborationItem(tx);
      const ins = await tx.query(
        `INSERT INTO collaboration_application_items (id, organization_id, application_id, product_id, sku_id, requested_qty, request_reason, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
         ON CONFLICT (application_id, product_id, coalesce(sku_id, '')) WHERE deleted_at IS NULL DO NOTHING RETURNING id`,
        [id, actor.orgId, appId, input.productId, input.skuId ?? null, input.requestedQty ?? 1, input.requestReason ?? null, actor.userId]);
      if (!ins.rowCount) throw conflict('這個商品與規格已經在申請明細中');
      await logEvent(tx, actor, appId, 'DATA', 'ITEM_ADD', { note: `${input.productId}${input.skuId ? `／${input.skuId}` : ''}` });
      await audit(tx, actor, { action: 'collaboration.item.create', entityType: 'collaboration_application_item', entityId: id, after: { applicationId: appId, productId: input.productId, skuId: input.skuId ?? null } });
      return { id };
    }, { applicationId: appId, ...input });
    return { ...result, replayed };
  });
}

export async function updateItem(actor: Actor, itemId: string, raw: z.input<typeof itemPatchSchema>) {
  const parsed = itemPatchSchema.parse(raw);
  const input = applyClears(parsed, raw, ['requestReason']);
  assertNoPii({ 申請原因: input.requestReason });
  return withTx(async (tx) => {
    const cur = await tx.query<{ application_id: string }>('SELECT application_id FROM collaboration_application_items WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [itemId, actor.orgId]);
    if (!cur.rowCount) throw notFound('申請樣品明細');
    const app = await loadApp(tx, actor, cur.rows[0].application_id, true);
    assertWritableApp(app);
    if (!isInternal(actor)) {
      if (!can(actor, 'collaboration.self')) throw forbidden();
      if (!['DRAFT', 'SUBMITTED'].includes(app.status)) throw precondition('申請已進入審核流程，不可再修改樣品明細');
    } else requirePerm(actor, 'collaboration.update');
    const { after } = await patchEntity(tx, actor, {
      table: 'collaboration_application_items', entityType: 'collaboration_application_item', id: itemId,
      patch: input as Record<string, unknown>, allowed: ['requestedQty', 'requestReason'], expectedVersion: input.version,
      action: 'collaboration.item.update',
    });
    return { id: itemId, version: after['version'] };
  });
}

export async function removeItem(actor: Actor, itemId: string, reason: string | null) {
  return withTx(async (tx) => {
    const cur = await tx.query<{ application_id: string; product_id: string }>(
      'SELECT application_id, product_id FROM collaboration_application_items WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL FOR UPDATE', [itemId, actor.orgId]);
    if (!cur.rowCount) throw notFound('申請樣品明細');
    const app = await loadApp(tx, actor, cur.rows[0].application_id, true);
    assertWritableApp(app);
    if (!isInternal(actor)) {
      if (!can(actor, 'collaboration.self')) throw forbidden();
      if (!['DRAFT', 'SUBMITTED'].includes(app.status)) throw precondition('申請已進入審核流程，不可再移除樣品明細');
    } else requirePerm(actor, 'collaboration.update');
    const shipped = await tx.query(`SELECT 1 FROM collaboration_shipments WHERE application_id=$1 AND status IN ('SHIPPED','DELIVERED')`, [app.id]);
    if (shipped.rowCount) throw precondition('已有寄出紀錄，不可移除樣品明細');
    await tx.query('UPDATE collaboration_application_items SET deleted_at=now(), updated_by=$2 WHERE id=$1', [itemId, actor.userId]);
    await logEvent(tx, actor, app.id, 'DATA', 'ITEM_REMOVE', { note: reason ?? null });
    await audit(tx, actor, { action: 'collaboration.item.remove', entityType: 'collaboration_application_item', entityId: itemId, before: { applicationId: app.id, productId: cur.rows[0].product_id }, reason });
    return { id: itemId };
  });
}

// ---------------------------------------------------------------- 收件資訊（個資）
function canWriteRecipient(actor: Actor, app: AppRow): boolean {
  if (can(actor, 'collaboration.pii.read') && can(actor, 'collaboration.update')) return true;   // 營運
  if (actor.role === 'HOST' && actor.hostIds.includes(app.host_id)) return true;                 // 團主填自己的
  return false;
}

/**
 * 保留期是衍生值：核准日起算 90 天；一旦樣品送達，就改以最後寄送日起算 30 天，取較早者。
 * 收件資料通常在送達前就建好了，所以「核准」與「確認收件」發生時都要重算，
 * 否則已送達的案件會一直沿用較長的核准基準，個資留得比政策久。
 */
async function refreshRetention(tx: Tx, actor: Actor, appId: string, approvedOn: string | null) {
  const cur = await tx.query<{ id: string; retention_until: string | null }>(
    `SELECT id, retention_until FROM collaboration_recipients
       WHERE application_id=$1 AND deleted_at IS NULL AND purged_at IS NULL FOR UPDATE`, [appId]);
  if (!cur.rowCount) return;
  const summary = summarizeShipments(await shipmentFacts(tx, appId));
  const next = computeRetentionUntil(approvedOn, summary, todayTaipei());
  const before = isoDateOf(cur.rows[0].retention_until);
  if (next === before) return;
  await tx.query('UPDATE collaboration_recipients SET retention_until=$2, updated_by=$3 WHERE id=$1',
    [cur.rows[0].id, next, actor.userId]);
  await logEvent(tx, actor, appId, 'DATA', 'RECIPIENT_RETENTION_UPDATE', { note: `保留期 ${before ?? '未設定'} → ${next ?? '未設定'}` });
  await audit(tx, actor, {
    action: 'collaboration.recipient.retention', entityType: 'collaboration_recipient', entityId: cur.rows[0].id,
    before: { retentionUntil: before }, after: { retentionUntil: next },
  });
}

/**
 * 建立或更新收件資訊。改地址＝軟刪除舊的、建立新的，留下歷史；不覆寫 hosts 主檔。
 * 廠商永遠不能寫收件資料。
 */
export async function putRecipient(actor: Actor, appId: string, raw: z.input<typeof recipientSchema>) {
  const input = recipientSchema.parse(raw);
  return withTx(async (tx) => {
    const app = await loadApp(tx, actor, appId, true);
    assertWritableApp(app);
    if (!canWriteRecipient(actor, app)) throw forbidden();
    const prev = await tx.query<{ id: string; recipient_name: string; address_line: string }>(
      'SELECT id, recipient_name, address_line FROM collaboration_recipients WHERE application_id=$1 AND deleted_at IS NULL FOR UPDATE', [appId]);
    if (prev.rowCount) {
      // 舊地址不能「只軟刪除」：內容還在表裡就會永遠不被清除。被取代的舊資料立即清空內容，只留下「曾被取代」的紀錄
      await tx.query(
        `UPDATE collaboration_recipients SET deleted_at=now(), recipient_name='［已清除］', recipient_phone='［已清除］', address_line='［已清除］',
           postal_code=NULL, delivery_note=NULL, purged_at=now(), purge_reason='已被新的收件資料取代', updated_by=$2 WHERE id=$1`, [prev.rows[0].id, actor.userId]);
    }
    const id = await ids.collaborationRecipient(tx);
    const summary = summarizeShipments(await shipmentFacts(tx, appId));
    const retention = computeRetentionUntil(isoDateOf(app.decided_at), summary, todayTaipei());
    await tx.query(
      `INSERT INTO collaboration_recipients (id, organization_id, application_id, recipient_name, recipient_phone, postal_code,
         address_line, delivery_note, confirmed_at, confirmed_by, retention_until, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
      [id, actor.orgId, appId, input.recipientName, input.recipientPhone, input.postalCode ?? null, input.addressLine,
        input.deliveryNote ?? null, input.confirm ? new Date() : null, input.confirm ? actor.userId : null, retention, actor.userId]);
    await logEvent(tx, actor, appId, 'DATA', prev.rowCount ? 'RECIPIENT_UPDATE' : 'RECIPIENT_CREATE', { note: input.confirm ? '已確認可用' : '未確認' });
    // 稽核不留個資內容，只留「哪些欄位被寫過、是否已確認」
    await audit(tx, actor, {
      action: 'collaboration.recipient.write', entityType: 'collaboration_recipient', entityId: id,
      campaignId: app.campaign_id,
      before: prev.rowCount ? { replacedId: prev.rows[0].id } : null,
      after: { applicationId: appId, confirmed: !!input.confirm, hasPostalCode: !!input.postalCode, retentionUntil: retention },
    });
    return { id, confirmed: !!input.confirm, retentionUntil: retention };
  });
}

/**
 * 讀取收件資訊（個資）。每一次成功讀取都寫一筆稽核，這是本系統唯一的「讀取也留紀錄」路徑。
 * 內部角色需 collaboration.pii.read；團主只能讀自己的；廠商受履約期間與保留政策限制。
 */
export async function getRecipient(actor: Actor, appId: string) {
  const app = await loadApp(pool(), actor, appId);
  const rows = await query<{ id: string; recipient_name: string; recipient_phone: string; postal_code: string | null; address_line: string | null; delivery_note: string | null; confirmed_at: string | null; purged_at: string | null; retention_until: string | null; version: number }>(
    `SELECT id, recipient_name, recipient_phone, postal_code, address_line, delivery_note, confirmed_at, purged_at, retention_until, version
       FROM collaboration_recipients WHERE application_id=$1 AND deleted_at IS NULL`, [appId]);
  if (!rows.length) throw notFound('收件資料');
  const r = rows[0];

  let reason: string | null = null;
  if (isInternal(actor)) {
    if (!can(actor, 'collaboration.pii.read')) throw forbidden();
    if (r.purged_at) reason = RECIPIENT_DENY_MESSAGE.PURGED;
  } else if (actor.role === 'HOST') {
    if (!actor.hostIds.includes(app.host_id)) throw notFound('收件資料');
    if (r.purged_at) reason = RECIPIENT_DENY_MESSAGE.PURGED;
  } else if (actor.role === 'VENDOR') {
    const v = vendorMaySeeRecipient(
      {
        applicationStatus: app.status, confirmedAt: r.confirmed_at, purgedAt: r.purged_at, retentionUntil: isoDateOf(r.retention_until),
        fulfilmentOpen: fulfilmentOpen(await shipmentFacts(pool(), appId)),
        baseOn: isoDateOf(app.decided_at) ?? isoDateOf(app.created_at),
      },
      todayTaipei());
    if (!v.allowed) reason = RECIPIENT_DENY_MESSAGE[v.reason!];
  } else throw forbidden();

  if (reason) {
    await withTx(async (tx) => logEvent(tx, actor, appId, 'DATA', 'RECIPIENT_READ_DENIED', { note: reason, internal: true }));
    throw new AppError('FORBIDDEN', reason);
  }
  // 個資存取稽核：誰在什麼時候讀了哪一筆收件資料（不記內容）
  await withTx(async (tx) => {
    await audit(tx, actor, {
      action: 'collaboration.recipient.read', entityType: 'collaboration_recipient', entityId: r.id,
      campaignId: app.campaign_id,
      after: { applicationId: appId, purpose: actor.role === 'VENDOR' ? 'VENDOR_FULFILMENT_EXCEPTION' : actor.role === 'HOST' ? 'OWN_DATA' : 'OPS_FULFILMENT', scope: actor.role },
    });
  });
  return {
    id: r.id, applicationId: appId, recipientName: r.recipient_name, recipientPhone: r.recipient_phone,
    postalCode: r.postal_code, addressLine: r.address_line, deliveryNote: r.delivery_note,
    confirmedAt: r.confirmed_at, retentionUntil: r.retention_until, version: r.version,
  };
}

/**
 * 資料最小化：清空到期的收件內容（軟刪除不夠，個資要真的不見）。只有管理者可執行。
 * 實際邏輯（保留例外、履約未結束延後、硬性上限、逐筆結果與失敗紀錄）在 collaboration-retention.ts。
 */
export async function purgeExpiredRecipients(actor: Actor, today: string = todayTaipei(), opts: { dryRun?: boolean } = {}) {
  return runRecipientPurge(actor, { today, dryRun: opts.dryRun, source: 'MANUAL' });
}

// ---------------------------------------------------------------- 樣品寄送
export async function addShipment(actor: Actor, appId: string, raw: z.input<typeof shipmentCreateSchema>, idemKey?: string | null) {
  requirePerm(actor, 'collaboration.shipping.write');
  const input = shipmentCreateSchema.parse(raw);
  assertNoPii({ 寄送備註: input.note, 物流單號: input.trackingNo });
  return withTx(async (tx) => {
    const app = await loadApp(tx, actor, appId, true);
    assertWritableApp(app);
    if (!SHIPPABLE_APPLICATION_STATUSES.includes(app.status)) throw precondition('申請尚未核准供樣，還不能建立寄送紀錄');
    const facts = await shipmentFacts(tx, appId);
    if (input.shipmentType === 'INITIAL' && facts.some((f) => f.shipmentType === 'INITIAL' && f.status !== 'CANCELLED')) {
      throw conflict('已有首次寄送紀錄；補寄請選「補寄」');
    }
    if (input.shipmentType === 'RESEND' && !facts.some((f) => f.shipmentType === 'INITIAL' && f.status !== 'CANCELLED')) {
      throw precondition('還沒有首次寄送紀錄，不能先建立補寄');
    }
    if (input.fulfillmentShipmentId) {
      const fs = await tx.query<{ batch_kind: string }>(
        `SELECT b.kind AS batch_kind FROM shipments s JOIN fulfillment_batches b ON b.id = s.batch_id
          WHERE s.id=$1 AND s.organization_id=$2`, [input.fulfillmentShipmentId, actor.orgId]);
      if (!fs.rowCount) throw notFound('履約出貨單');
      if (fs.rows[0].batch_kind !== 'SAMPLE') throw validation('只能關聯「寄樣」批次的出貨單');
    }
    const status: CollabShipmentStatus = input.shipDate ? 'SHIPPED' : 'PENDING';
    const { result, replayed } = await idempotent(tx, actor, 'collaboration.shipment.create', idemKey, async () => {
      const id = await ids.collaborationShipment(tx);
      await tx.query(
        `INSERT INTO collaboration_shipments (id, organization_id, application_id, shipment_type, shipped_by_party, ship_date,
           carrier, tracking_no, quantity, status, note, fulfillment_shipment_id, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
        [id, actor.orgId, appId, input.shipmentType, input.shippedByParty ?? (actor.role === 'VENDOR' ? 'VENDOR' : 'OPS'),
          input.shipDate ?? null, input.carrier ?? null, input.trackingNo ?? null, input.quantity ?? null, status,
          input.note ?? null, input.fulfillmentShipmentId ?? null, actor.userId]);
      await logEvent(tx, actor, appId, 'SAMPLE', input.shipmentType === 'RESEND' ? 'RESEND_CREATE' : 'SHIPMENT_CREATE', { to: status });
      await audit(tx, actor, {
        action: 'collaboration.shipment.create', entityType: 'collaboration_shipment', entityId: id,
        campaignId: app.campaign_id, after: { applicationId: appId, shipmentType: input.shipmentType, status },
      });
      return { id, status };
    }, { applicationId: appId, ...input });
    if (!replayed && app.collaboration_status === 'NOT_STARTED') await setCollaborationStatus(tx, actor, app, 'SAMPLE_IN_PROGRESS', '已建立寄送紀錄');
    // 新增（尤其是補寄）會改變「最後寄送日」，保留期要跟著重算，不能讓補寄還在路上時個資就過期
    if (!replayed) await refreshRetention(tx, actor, appId, isoDateOf(app.decided_at));
    return { ...result, replayed };
  });
}

export async function updateShipment(actor: Actor, shipmentId: string, raw: z.input<typeof shipmentPatchSchema>) {
  requirePerm(actor, 'collaboration.shipping.write');
  const parsed = shipmentPatchSchema.parse(raw);
  const input = applyClears(parsed, raw, ['carrier', 'trackingNo', 'note']);
  assertNoPii({ 寄送備註: input.note, 物流單號: input.trackingNo });
  return withTx(async (tx) => {
    const cur = await tx.query<{ application_id: string; status: CollabShipmentStatus; ship_date: string | null }>(
      'SELECT application_id, status, ship_date FROM collaboration_shipments WHERE id=$1 AND organization_id=$2 FOR UPDATE', [shipmentId, actor.orgId]);
    if (!cur.rowCount) throw notFound('寄送紀錄');
    const app = await loadApp(tx, actor, cur.rows[0].application_id, true);
    assertWritableApp(app);
    const from = cur.rows[0].status;
    const patch: Record<string, unknown> = { ...input };
    if (input.status && input.status !== from) {
      if (!canTransitionShipment(from, input.status)) throw precondition(`寄送狀態不能由 ${from} 變更為 ${input.status}`);
      if (input.status === 'DELIVERED') throw validation('請用「確認收件」記錄送達，以保留簽收時間');
      if (input.status === 'CANCELLED') throw validation('請用「取消寄送」並填寫原因');
    }
    // 填了寄出日就自動視為已寄出（表單一的「品牌若寄出請改日期」）
    const effectiveDate = input.shipDate !== undefined ? input.shipDate : cur.rows[0].ship_date;
    if (from === 'PENDING' && effectiveDate && !input.status) patch.status = 'SHIPPED';
    if (patch.status === 'SHIPPED' && !effectiveDate) throw validation('標記為已寄出需填寫寄出日期');

    const { after, changed } = await patchEntity(tx, actor, {
      table: 'collaboration_shipments', entityType: 'collaboration_shipment', id: shipmentId,
      patch, allowed: ['shipDate', 'carrier', 'trackingNo', 'quantity', 'status', 'note'], expectedVersion: input.version,
      action: 'collaboration.shipment.update', campaignId: () => app.campaign_id,
    });
    if (changed && after['status'] !== from) {
      await logEvent(tx, actor, app.id, 'SAMPLE', 'SHIPMENT_STATUS', { from, to: String(after['status']) });
    }
    // 改寄出日或狀態也會動到保留期的推導基準
    if (changed) await refreshRetention(tx, actor, app.id, isoDateOf(app.decided_at));
    return { id: shipmentId, status: after['status'], version: after['version'] };
  });
}

export const receiptSchema = z.object({ receivedOn: reqDate, receiptNote: txt(300) }).strict();

/** 團主確認收件（也允許營運代為記錄） */
export async function confirmReceipt(actor: Actor, shipmentId: string, raw: z.input<typeof receiptSchema>) {
  const input = receiptSchema.parse(raw);
  assertNoPii({ 收件備註: input.receiptNote });
  return withTx(async (tx) => {
    const cur = await tx.query<{ application_id: string; status: CollabShipmentStatus; ship_date: string | null }>(
      'SELECT application_id, status, ship_date FROM collaboration_shipments WHERE id=$1 AND organization_id=$2 FOR UPDATE', [shipmentId, actor.orgId]);
    if (!cur.rowCount) throw notFound('寄送紀錄');
    const app = await loadApp(tx, actor, cur.rows[0].application_id, true);
    const isOwnHost = actor.role === 'HOST' && actor.hostIds.includes(app.host_id);
    if (!isOwnHost && !can(actor, 'collaboration.shipping.write')) throw forbidden();
    if (actor.role === 'VENDOR') throw forbidden();   // 廠商不能代替團主簽收
    if (!canTransitionShipment(cur.rows[0].status, 'DELIVERED')) throw precondition('目前狀態不能確認收件');
    if (cur.rows[0].ship_date && input.receivedOn < cur.rows[0].ship_date) throw validation('收件日不可早於寄出日');
    await tx.query(
      `UPDATE collaboration_shipments SET status='DELIVERED', receipt_confirmed_at=now(), receipt_confirmed_by=$2,
         receipt_note=$3, updated_by=$2 WHERE id=$1`, [shipmentId, actor.userId, input.receiptNote ?? null]);
    await logEvent(tx, actor, app.id, 'SAMPLE', 'RECEIPT_CONFIRMED', { from: cur.rows[0].status, to: 'DELIVERED' });
    await audit(tx, actor, {
      action: 'collaboration.shipment.confirm_receipt', entityType: 'collaboration_shipment', entityId: shipmentId,
      campaignId: app.campaign_id, after: { receivedOn: input.receivedOn },
    });
    // 收到樣品就進入試用；意願還沒回覆前不會自動跳到確認合作
    if (['NOT_STARTED', 'SAMPLE_IN_PROGRESS'].includes(app.collaboration_status)) {
      await setCollaborationStatus(tx, actor, app, 'TRIAL_IN_PROGRESS', '團主已確認收件');
    }
    await refreshRetention(tx, actor, app.id, isoDateOf(app.decided_at));
    return { id: shipmentId, status: 'DELIVERED' };
  });
}

export async function cancelShipment(actor: Actor, shipmentId: string, reason: string) {
  requirePerm(actor, 'collaboration.shipping.write');
  if (!reason?.trim()) throw validation('請填寫取消原因');
  return withTx(async (tx) => {
    const cur = await tx.query<{ application_id: string; status: CollabShipmentStatus }>(
      'SELECT application_id, status FROM collaboration_shipments WHERE id=$1 AND organization_id=$2 FOR UPDATE', [shipmentId, actor.orgId]);
    if (!cur.rowCount) throw notFound('寄送紀錄');
    const app = await loadApp(tx, actor, cur.rows[0].application_id, true);
    if (!canTransitionShipment(cur.rows[0].status, 'CANCELLED')) throw precondition('已送達或已退回的寄送紀錄不可取消');
    await tx.query(`UPDATE collaboration_shipments SET status='CANCELLED', cancel_reason=$2, updated_by=$3 WHERE id=$1`, [shipmentId, reason, actor.userId]);
    await logEvent(tx, actor, app.id, 'SAMPLE', 'SHIPMENT_CANCEL', { from: cur.rows[0].status, to: 'CANCELLED', note: reason });
    await audit(tx, actor, { action: 'collaboration.shipment.cancel', entityType: 'collaboration_shipment', entityId: shipmentId, campaignId: app.campaign_id, reason });
    return { id: shipmentId, status: 'CANCELLED' };
  });
}

// ---------------------------------------------------------------- 開團合作資訊
export async function putLaunch(actor: Actor, appId: string, raw: z.input<typeof launchSchema>) {
  const input = launchSchema.parse(raw);
  assertNoPii({ 意願備註: input.intentNote, 投廣備註: input.adsNote, 合作備註: input.collaborationNote });
  const isHost = actor.role === 'HOST';
  if (isHost) {
    if (!can(actor, 'collaboration.intent.write')) throw forbidden();
  } else if (!can(actor, 'collaboration.intent.write') && !can(actor, 'collaboration.update')) throw forbidden();
  if (actor.role === 'VENDOR') throw forbidden();

  const allowed: readonly string[] = isHost ? HOST_LAUNCH_FIELDS : LAUNCH_FIELDS;
  for (const k of Object.keys(input)) {
    if (input[k as keyof typeof input] === undefined) continue;
    if (!allowed.includes(k)) throw forbidden();
  }

  return withTx(async (tx) => {
    const app = await loadApp(tx, actor, appId, true);
    assertWritableApp(app);
    if (isHost && !actor.hostIds.includes(app.host_id)) throw notFound('合作申請');
    const launchId = await ensureLaunch(tx, actor, appId);
    const patch: Record<string, unknown> = { ...input };
    // 回覆了意願就記下回覆日期；不要求先寄到樣品（團主可以在樣品還沒寄出前就先排預計檔期）
    if (input.intent && input.intent !== 'PENDING' && input.intentRespondedOn === undefined) patch.intentRespondedOn = todayTaipei();
    if (input.intent === 'PENDING') patch.intentRespondedOn = null;

    const { before, after, changed } = await patchEntity(tx, actor, {
      table: 'collaboration_launch_details', entityType: 'collaboration_launch', id: launchId,
      patch, allowed, action: 'collaboration.launch.update', campaignId: () => app.campaign_id,
    });
    if (changed && before['intent'] !== after['intent']) {
      await logEvent(tx, actor, appId, 'INTENT', 'INTENT_SET', { from: String(before['intent']), to: String(after['intent']), note: input.intentNote ?? null });
      if (after['intent'] === 'UNWILLING') await setCollaborationStatus(tx, actor, app, 'DECLINED', '團主回覆不開團');
      else if (after['intent'] === 'WILLING' && ['NOT_STARTED', 'SAMPLE_IN_PROGRESS', 'TRIAL_IN_PROGRESS'].includes(app.collaboration_status)) {
        await setCollaborationStatus(tx, actor, app, 'AWAITING_INTENT', '團主表示願意開團，待營運確認合作');
      } else if (after['intent'] === 'UNDECIDED' && ['NOT_STARTED', 'SAMPLE_IN_PROGRESS', 'TRIAL_IN_PROGRESS'].includes(app.collaboration_status)) {
        await setCollaborationStatus(tx, actor, app, 'AWAITING_INTENT', '團主試用後暫不決定');
      }
    }
    return { id: launchId, version: after['version'] };
  });
}

/** 廠商回填後台連結、後台設定與投廣確認。欄位與團主／營運的分開，廠商改不到意願與開團日期 */
export async function putVendorLaunch(actor: Actor, appId: string, raw: z.input<typeof vendorLaunchSchema>) {
  requirePerm(actor, 'collaboration.vendor.review');
  const input = vendorLaunchSchema.parse(raw);
  assertNoPii({ 後台設定備註: input.backendSetupNote });
  for (const k of Object.keys(input)) {
    if (input[k as keyof typeof input] === undefined) continue;
    if (!VENDOR_LAUNCH_FIELDS.includes(k as (typeof VENDOR_LAUNCH_FIELDS)[number])) throw forbidden();
  }
  return withTx(async (tx) => {
    const app = await loadApp(tx, actor, appId, true);
    assertWritableApp(app);
    const launchId = await ensureLaunch(tx, actor, appId);
    // 投廣確認狀態不能在團主還沒表達投廣意願前就被廠商設定（資料庫 CHECK 也擋）
    if (input.adsConfirmStatus && input.adsConfirmStatus !== 'PENDING') {
      const cur = await tx.query<{ ads_intent: string }>('SELECT ads_intent FROM collaboration_launch_details WHERE id=$1', [launchId]);
      if (cur.rows[0]?.ads_intent === 'PENDING') throw precondition('團主尚未表達投廣意願，還不能確認投廣');
    }
    const { after } = await patchEntity(tx, actor, {
      table: 'collaboration_launch_details', entityType: 'collaboration_launch', id: launchId,
      patch: input as Record<string, unknown>, allowed: VENDOR_LAUNCH_FIELDS,
      action: 'collaboration.launch.vendor_update', campaignId: () => app.campaign_id,
    });
    await logEvent(tx, actor, appId, 'DATA', 'VENDOR_LAUNCH_UPDATE', { note: Object.keys(input).join('、') });
    return { id: launchId, version: after['version'] };
  });
}

// ---------------------------------------------------------------- 合作確認與檔期關聯
export const confirmCollaborationSchema = z.object({ confirmedOpenDate: optDate, note: txt(1000) }).strict();

/** 正式合作確認——需核准權限（collaboration.review），營運小編不可代替主管決定 */
export async function confirmCollaboration(actor: Actor, appId: string, raw: z.input<typeof confirmCollaborationSchema>) {
  requirePerm(actor, 'collaboration.review');
  const input = confirmCollaborationSchema.parse(raw);
  assertNoPii({ 合作備註: input.note });
  return withTx(async (tx) => {
    const app = await loadApp(tx, actor, appId, true);
    assertWritableApp(app);
    if (app.status !== 'APPROVED') throw precondition('只有已核准的申請可以確認正式合作');
    const launchId = await ensureLaunch(tx, actor, appId);
    const l = await tx.query<{ intent: string }>('SELECT intent FROM collaboration_launch_details WHERE id=$1', [launchId]);
    if (l.rows[0]?.intent !== 'WILLING') throw precondition('團主尚未回覆願意開團，不能確認正式合作');
    if (input.confirmedOpenDate) {
      await tx.query('UPDATE collaboration_launch_details SET confirmed_open_date=$2, updated_by=$3 WHERE id=$1', [launchId, input.confirmedOpenDate, actor.userId]);
    }
    await setCollaborationStatus(tx, actor, app, 'COLLABORATION_CONFIRMED', input.note ?? '營運確認正式合作');
    return { id: appId, collaborationStatus: app.collaboration_status };
  });
}

export async function declineCollaboration(actor: Actor, appId: string, reason: string) {
  requirePerm(actor, 'collaboration.update');
  if (!reason?.trim()) throw validation('請填寫不合作的原因');
  return withTx(async (tx) => {
    const app = await loadApp(tx, actor, appId, true);
    assertWritableApp(app);
    if (app.campaign_id) throw precondition('已關聯檔期，請先解除關聯');
    await setCollaborationStatus(tx, actor, app, 'DECLINED', reason);
    return { id: appId, collaborationStatus: app.collaboration_status };
  });
}

/**
 * 關聯既有檔期。
 * ⚠️ 只做「關聯」：不建立檔期、不改檔期狀態、不碰 G1～G5，也不會因此讓檔期自動通過任何關卡。
 * 一個檔期可以關聯多筆合作申請（多位團主同團）。
 */
export async function linkCampaign(actor: Actor, appId: string, campaignId: string) {
  requirePerm(actor, 'collaboration.campaign.link');
  return withTx(async (tx) => {
    const app = await loadApp(tx, actor, appId, true);
    assertWritableApp(app);
    if (app.collaboration_status !== 'COLLABORATION_CONFIRMED' && app.collaboration_status !== 'CAMPAIGN_LINKED') {
      throw precondition('只有已確認正式合作的申請可以關聯檔期');
    }
    if (app.campaign_id && app.campaign_id !== campaignId) throw conflict('這筆申請已關聯其他檔期，請先解除關聯');
    // 檔期必須在這位使用者的檔期資料範圍內（沿用既有 campaignScope，不另開後門）
    const sc = campaignScope(actor, 2, 'c');
    if (sc.sql === 'FALSE') throw notFound('檔期');
    const c = await tx.query<{ id: string; vendor_id: string; status: string }>(
      `SELECT c.id, c.vendor_id, c.status FROM campaigns c WHERE c.id=$1 AND (${sc.sql})`, [campaignId, ...sc.params]);
    if (!c.rowCount) throw notFound('檔期');
    if (c.rows[0].vendor_id !== app.vendor_id) throw validation('檔期的廠商與這筆合作申請不同');
    if (['CANCELLED', 'CLOSED'].includes(c.rows[0].status)) throw precondition('檔期已取消或結案，不能關聯');

    await tx.query('UPDATE collaboration_applications SET collaboration_status=$2, campaign_id=$3, updated_by=$4 WHERE id=$1',
      [appId, 'CAMPAIGN_LINKED', campaignId, actor.userId]);
    await logEvent(tx, actor, appId, 'CAMPAIGN', 'LINK', { from: app.collaboration_status, to: 'CAMPAIGN_LINKED', note: campaignId });
    await audit(tx, actor, {
      action: 'collaboration.application.link_campaign', entityType: 'collaboration_application', entityId: appId,
      campaignId, before: { campaignId: app.campaign_id, collaborationStatus: app.collaboration_status },
      after: { campaignId, collaborationStatus: 'CAMPAIGN_LINKED', gateImpact: 'NONE' },
    });
    return { id: appId, campaignId, collaborationStatus: 'CAMPAIGN_LINKED', gateImpact: 'NONE' };
  });
}

export async function unlinkCampaign(actor: Actor, appId: string, reason: string) {
  requirePerm(actor, 'collaboration.campaign.link');
  if (!reason?.trim()) throw validation('請填寫解除關聯的原因');
  return withTx(async (tx) => {
    const app = await loadApp(tx, actor, appId, true);
    if (!app.campaign_id) throw precondition('這筆申請沒有關聯檔期');
    await tx.query(`UPDATE collaboration_applications SET campaign_id=NULL, collaboration_status='COLLABORATION_CONFIRMED', updated_by=$2 WHERE id=$1`, [appId, actor.userId]);
    await logEvent(tx, actor, appId, 'CAMPAIGN', 'UNLINK', { from: 'CAMPAIGN_LINKED', to: 'COLLABORATION_CONFIRMED', note: reason });
    await audit(tx, actor, {
      action: 'collaboration.application.unlink_campaign', entityType: 'collaboration_application', entityId: appId,
      campaignId: app.campaign_id, before: { campaignId: app.campaign_id }, after: { campaignId: null }, reason,
    });
    return { id: appId, campaignId: null };
  });
}

/**
 * 串接 SOP 03 正式試用紀錄。
 * ⚠️ 只建立引用關係：一般樣品申請不等於已完成 SOP 03 的正式試用資格評估，
 * 本模組不會改 product_trials 的結論、覆核或有效期。
 */
export async function linkTrial(actor: Actor, appId: string, trialId: string) {
  requirePerm(actor, 'collaboration.update');
  return withTx(async (tx) => {
    const app = await loadApp(tx, actor, appId, true);
    assertWritableApp(app);
    const t = await tx.query<{ host_id: string | null; vendor_id: string; product_id: string }>(
      'SELECT host_id, vendor_id, product_id FROM product_trials WHERE id=$1 AND organization_id=$2', [trialId, actor.orgId]);
    if (!t.rowCount) throw notFound('試用紀錄');
    if (t.rows[0].vendor_id !== app.vendor_id) throw validation('試用紀錄的廠商與這筆合作申請不同');
    if (t.rows[0].host_id && t.rows[0].host_id !== app.host_id) throw validation('試用紀錄的團主與這筆合作申請不同');
    await tx.query('UPDATE collaboration_applications SET trial_id=$2, updated_by=$3 WHERE id=$1', [appId, trialId, actor.userId]);
    await logEvent(tx, actor, appId, 'DATA', 'TRIAL_LINK', { note: trialId });
    await audit(tx, actor, {
      action: 'collaboration.application.link_trial', entityType: 'collaboration_application', entityId: appId,
      after: { trialId, note: '只建立引用關係，不改 SOP 03 的試用結論' },
    });
    return { id: appId, trialId };
  });
}

// ---------------------------------------------------------------- 工作台分桶
/** 廠商工作台／團主工作台／營運總覽共用的分桶統計 */
export async function overview(actor: Actor) {
  if (!can(actor, 'collaboration.read') && !can(actor, 'collaboration.self')) throw forbidden();
  const sc = collaborationScope(actor, 1, 'a');
  const unassigned = await countUnassigned(actor);
  if (sc.sql === 'FALSE') return { buckets: [], total: 0, unassigned };
  const rows = await query<{ bucket: string; n: number }>(
    `WITH x AS (
       SELECT a.id, a.status, a.collaboration_status, a.campaign_id,
              coalesce(l.intent, 'PENDING') AS intent,
              EXISTS (SELECT 1 FROM collaboration_shipments s WHERE s.application_id=a.id AND s.status IN ('SHIPPED','DELIVERED','RETURNED')) AS any_shipped,
              EXISTS (SELECT 1 FROM collaboration_shipments s WHERE s.application_id=a.id AND s.shipment_type='RESEND' AND s.status='PENDING') AS resend_pending,
              EXISTS (SELECT 1 FROM collaboration_shipments s WHERE s.application_id=a.id AND s.status='DELIVERED') AS delivered
         FROM collaboration_applications a
         LEFT JOIN collaboration_launch_details l ON l.application_id = a.id
        WHERE (${sc.sql})
     )
     SELECT bucket, count(*)::int AS n FROM (
       SELECT CASE
         WHEN status IN ('SUBMITTED','INTERNAL_REVIEW') THEN 'PENDING_INTERNAL_REVIEW'
         WHEN status = 'VENDOR_REVIEW' THEN 'PENDING_VENDOR_REVIEW'
         WHEN status = 'APPROVED' AND resend_pending THEN 'RESEND_PENDING'
         WHEN status = 'APPROVED' AND NOT any_shipped THEN 'TO_SHIP'
         WHEN status = 'APPROVED' AND any_shipped AND NOT delivered THEN 'SHIPPED'
         WHEN status = 'APPROVED' AND delivered AND intent = 'PENDING' THEN 'AWAITING_HOST_INTENT'
         WHEN collaboration_status = 'COLLABORATION_CONFIRMED' AND campaign_id IS NULL THEN 'TO_LINK_CAMPAIGN'
         WHEN collaboration_status = 'CAMPAIGN_LINKED' THEN 'CAMPAIGN_LINKED'
         WHEN status = 'ON_HOLD' THEN 'ON_HOLD'
         WHEN status IN ('REJECTED','CANCELLED','CLOSED') OR collaboration_status = 'DECLINED' THEN 'CLOSED'
         ELSE 'OTHER' END AS bucket
       FROM x) y GROUP BY bucket ORDER BY bucket`, sc.params);
  return { buckets: rows.map((r) => ({ bucket: r.bucket, count: Number(r.n) })), total: rows.reduce((a, r) => a + Number(r.n), 0), unassigned };
}

// ---------------------------------------------------------------- 主檔串接
export async function hostApplications(actor: Actor, hostId: string) {
  if (!can(actor, 'collaboration.read') && !(can(actor, 'collaboration.self') && actor.hostIds.includes(hostId))) throw forbidden();
  const q = new URLSearchParams({ hostId, limit: '200' });
  const res = await listApplications(actor, q);
  return { items: res.items, total: res.total };
}

export async function productApplications(actor: Actor, productId: string) {
  if (!can(actor, 'collaboration.read') && !can(actor, 'collaboration.self')) throw forbidden();
  const res = await listApplications(actor, new URLSearchParams({ productId, limit: '200' }));
  return { items: res.items, total: res.total };
}

/** 廠商詳情頁的「網紅申請與樣品寄送」統計 */
export async function vendorSummary(actor: Actor, vendorId: string) {
  if (!can(actor, 'collaboration.read') && !(can(actor, 'collaboration.self') && actor.vendorIds.includes(vendorId))) throw forbidden();
  const sc = collaborationScope(actor, 2, 'a');
  if (sc.sql === 'FALSE') return { vendorId, hostCount: 0, pendingReview: 0, shippedSamples: 0, confirmedCollaborations: 0, awaitingIntent: 0 };
  const sc2 = collaborationScope(actor, sc.params.length + 2, 'a2');
  const r = await query<{ host_count: number; pending_review: number; shipped_samples: number; confirmed_collaborations: number; awaiting_intent: number }>(
    `SELECT count(DISTINCT a.host_id)::int AS host_count,
            count(*) FILTER (WHERE a.status IN ('SUBMITTED','INTERNAL_REVIEW','VENDOR_REVIEW'))::int AS pending_review,
            (SELECT count(*)::int FROM collaboration_shipments s JOIN collaboration_applications a2 ON a2.id = s.application_id
              WHERE a2.vendor_id=$1 AND (${sc2.sql}) AND s.status IN ('SHIPPED','DELIVERED')) AS shipped_samples,
            count(*) FILTER (WHERE a.collaboration_status IN ('COLLABORATION_CONFIRMED','CAMPAIGN_LINKED'))::int AS confirmed_collaborations,
            count(*) FILTER (WHERE a.collaboration_status = 'AWAITING_INTENT')::int AS awaiting_intent
       FROM collaboration_applications a WHERE a.vendor_id=$1 AND (${sc.sql})`, [vendorId, ...sc.params, ...sc2.params]);
  const row = r[0];
  return {
    vendorId, hostCount: Number(row?.host_count ?? 0), pendingReview: Number(row?.pending_review ?? 0),
    shippedSamples: Number(row?.shipped_samples ?? 0), confirmedCollaborations: Number(row?.confirmed_collaborations ?? 0),
    awaitingIntent: Number(row?.awaiting_intent ?? 0),
  };
}

// ---------------------------------------------------------------- 匯出
/**
 * 匯出成使用者原本的兩種表單格式（D-38）。
 *  - 內部且具 collaboration.pii.read：表單二含收件人／電話／地址（每次匯出寫稽核）。
 *  - 內部但沒有 pii.read：這三欄輸出遮罩字。
 *  - 廠商：匯出自己廠商範圍內的申請紀錄，但表單二「沒有」這三欄（欄位直接不存在，不是遮罩），
 *    不含任何收件人電話與地址；廠商取得地址的唯一途徑是履約期間內的收件資料端點（每次讀取留稽核）。
 *  - 所有儲存格都經過公式注入防護（開頭是 = + - @ 的內容會被當成純文字）。
 */
export async function exportApplications(actor: Actor, q: URLSearchParams): Promise<{ filename: string; csv: string }> {
  requirePerm(actor, 'collaboration.export');
  const form = q.get('form') === 'form1' ? 'form1' : 'form2';
  // 廠商永遠不含個資欄位；內部角色依 pii.read 決定完整或遮罩。以角色判斷在前，避免日後有人誤給廠商 pii.read 就洩漏
  const mode: ExportPiiMode = actor.role === 'VENDOR' ? 'OMIT' : can(actor, 'collaboration.pii.read') ? 'FULL' : 'MASKED';
  const pii = mode === 'FULL';
  const sc = collaborationScope(actor, 1, 'a');
  if (sc.sql === 'FALSE') throw forbidden();

  const inner = new URLSearchParams(q);
  inner.set('limit', '200');
  inner.delete('page');
  const rows: ExportRow[] = [];
  for (let page = 1; page <= 50; page++) {
    inner.set('page', String(page));
    const res = await listApplications(actor, inner);
    for (const it of res.items) rows.push(await toExportRow(actor, it as Record<string, unknown>, pii));
    if (rows.length >= res.total || !res.items.length) break;
  }
  const header = form === 'form1' ? FORM1_EXPORT_HEADERS : mode === 'OMIT' ? FORM2_VENDOR_EXPORT_HEADERS : FORM2_EXPORT_HEADERS;
  const body = rows.map((r) => (form === 'form1' ? toForm1Row(r) : toForm2Row(r, mode)));
  await withTx(async (tx) => {
    await audit(tx, actor, {
      action: 'collaboration.export', entityType: 'collaboration_application', entityId: `export:${form}`,
      after: { form, rows: rows.length, piiIncluded: pii && form === 'form2', piiMode: form === 'form2' ? mode : 'N/A' },
    });
  });
  return { filename: `collaboration-${form}-${todayTaipei()}.csv`, csv: '\uFEFF' + toCsv([header, ...body]) };   // BOM：讓 Excel 正確辨識繁體中文
}

async function toExportRow(actor: Actor, it: Record<string, unknown>, pii: boolean): Promise<ExportRow> {
  const id = String(it.id);
  const sample = it.sample as { resent: boolean; lastShipDate: string | null } | undefined;
  let recipientName: string | null = null;
  let recipientPhone: string | null = null;
  let addressLine: string | null = null;
  if (pii) {
    const r = await query<{ recipient_name: string; recipient_phone: string; address_line: string; purged_at: string | null }>(
      `SELECT recipient_name, recipient_phone, address_line, purged_at FROM collaboration_recipients WHERE application_id=$1 AND deleted_at IS NULL`, [id]);
    if (r.length && !r[0].purged_at) { recipientName = r[0].recipient_name; recipientPhone = r[0].recipient_phone; addressLine = r[0].address_line; }
  } else {
    const r = await query<{ id: string }>(`SELECT id FROM collaboration_recipients WHERE application_id=$1 AND deleted_at IS NULL`, [id]);
    if (r.length) { recipientName = '•'; recipientPhone = '•'; addressLine = '•'; }
  }
  const prods = await query<{ label: string }>(
    `SELECT p.name || coalesce('／' || s.sku_code, '') || ' ×' || i.requested_qty AS label
       FROM collaboration_application_items i JOIN products p ON p.id=i.product_id LEFT JOIN skus s ON s.id=i.sku_id
      WHERE i.application_id=$1 AND i.deleted_at IS NULL ORDER BY i.id`, [id]);
  const resend = await query<{ ship_date: string | null }>(
    `SELECT ship_date FROM collaboration_shipments WHERE application_id=$1 AND shipment_type='RESEND' AND status <> 'CANCELLED' ORDER BY ship_date DESC NULLS LAST LIMIT 1`, [id]);
  const launch = await query<{ backend_setup_email: string | null; vendor_portal_url: string | null }>(
    `SELECT backend_setup_email, vendor_portal_url FROM collaboration_launch_details WHERE application_id=$1`, [id]);
  void actor;
  return {
    id,
    hostName: String(it.hostName ?? ''),
    campaignLabel: (it.campaignTitle as string | null) ?? null,
    resent: !!sample?.resent,
    resendDate: resend.length ? resend[0].ship_date : null,
    launchUrl: (it.launchUrl as string | null) ?? null,
    adsIntent: String(it.adsIntent ?? 'PENDING'),
    backendSetupEmail: launch[0]?.backend_setup_email ?? null,
    backendSetupStatus: String(it.backendSetupStatus ?? 'NOT_REQUIRED'),
    recipientName, recipientPhone, addressLine,
    productSummary: prods.map((p) => p.label).join('；'),
    shipDate: sample?.lastShipDate ?? null,
    intent: String(it.intent ?? 'PENDING'),
    openDate: (it.confirmedOpenDate as string | null) ?? (it.plannedOpenDate as string | null) ?? null,
    note: (it.note as string | null) ?? null,
    vendorPortalUrl: launch[0]?.vendor_portal_url ?? null,
  };
}

export { SUPPLY_STATUSES, COLLABORATION_STATUSES, APPLICATION_STATUSES, COLLAB_SHIPMENT_STATUSES };
