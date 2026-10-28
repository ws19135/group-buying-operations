import { z } from 'zod';
import type { Tx } from '../lib/db';
import { query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { isInternal, requirePerm } from '../lib/permissions';
import { AppError, conflict, forbidden, notFound, validation } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids, todayTaipei } from '../lib/ids';
import { camelize } from '../lib/case';
import { isIsoDate } from '../lib/dates';
import { nonEmpty } from '../lib/text';
import { idempotent } from '../lib/idempotency';
import { listPaged, pageParams, patchEntity } from '../lib/repo';
import { campaignScope } from '../lib/scope';
import { queueNotification } from './notifications';

export const SHIPMENT_STATUSES = ['PENDING', 'PACKED', 'SHIPPED', 'DELIVERED', 'EXCEPTION', 'CANCELLED'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** 出貨單狀態轉移。DELIVERED／CANCELLED 為終點（簽收後不可回頭，更正請取消後重建或走售後） */
export const SHIPMENT_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  PENDING: ['PACKED', 'EXCEPTION', 'CANCELLED'],
  PACKED: ['SHIPPED', 'EXCEPTION', 'CANCELLED'],
  SHIPPED: ['DELIVERED', 'EXCEPTION', 'CANCELLED'],
  EXCEPTION: ['PACKED', 'SHIPPED', 'DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};

/** 檔期在這些狀態下，履約資料一律唯讀 */
const WRITE_BLOCKED = ['CANCELLED', 'CLOSED', 'ON_HOLD'];
/** 訂單出貨（ORDER）最早從「已排程」開始；寄樣（SAMPLE）在籌備期就可能發生 */
const ORDER_OK = ['SCHEDULED', 'RUNNING', 'PENDING_CLOSE_CHECK', 'FULFILLING', 'PENDING_SETTLEMENT', 'SETTLED'];

const optText = (max = 500) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));
const isoDate = z.string().refine(isIsoDate, '日期格式需為 YYYY-MM-DD');
const qty = z.number().int().min(1).max(1_000_000);

/** 批次狀態由「有效出貨單」彙總而來，只有取消是人工動作 */
export function rollupBatchStatus(statuses: string[]): Exclude<ShipmentStatus, 'CANCELLED'> {
  const s = statuses.filter((x) => x !== 'CANCELLED');
  if (!s.length) return 'PENDING';
  if (s.includes('EXCEPTION')) return 'EXCEPTION';
  if (s.every((x) => x === 'DELIVERED')) return 'DELIVERED';
  if (s.some((x) => x === 'SHIPPED' || x === 'DELIVERED')) return 'SHIPPED';
  if (s.every((x) => x === 'PACKED')) return 'PACKED';
  return 'PENDING';
}

export interface FulfillmentWarning { code: string; severity: 'WARN' | 'INFO'; message: string; refId?: string }

/** 只提醒、不擋關卡（G 閘門規則未改動）。輸入是該檔期「未取消」的批次與出貨單 */
export function fulfillmentWarnings(
  campaignStatus: string,
  batches: { id: string; status: string }[],
  shipments: { id: string; batchId: string; status: string; plannedDate: string | null; receiptConfirmedAt: string | null }[],
  today: string,
): FulfillmentWarning[] {
  const out: FulfillmentWarning[] = [];
  const liveBatches = batches.filter((b) => b.status !== 'CANCELLED');
  const live = shipments.filter((s) => s.status !== 'CANCELLED');
  if (['FULFILLING', 'PENDING_SETTLEMENT', 'SETTLED'].includes(campaignStatus) && !liveBatches.length) {
    out.push({ code: 'NO_BATCH', severity: 'WARN', message: '檔期已進入履約，但還沒有任何出貨批次' });
  }
  for (const s of live.filter((x) => x.status === 'EXCEPTION')) out.push({ code: 'EXCEPTION', severity: 'WARN', message: `出貨單 ${s.id} 處於異常狀態`, refId: s.id });
  for (const s of live.filter((x) => ['PENDING', 'PACKED'].includes(x.status) && x.plannedDate && x.plannedDate < today)) {
    out.push({ code: 'LATE_SHIP', severity: 'WARN', message: `出貨單 ${s.id} 已超過預計出貨日（${s.plannedDate}）仍未出貨`, refId: s.id });
  }
  if (['PENDING_SETTLEMENT', 'SETTLED'].includes(campaignStatus)) {
    const open = live.filter((x) => x.status !== 'DELIVERED');
    if (open.length) out.push({ code: 'UNDELIVERED', severity: 'WARN', message: `檔期已進入結算，但仍有 ${open.length} 張出貨單未送達` });
  }
  for (const s of live.filter((x) => x.status === 'DELIVERED' && !x.receiptConfirmedAt)) out.push({ code: 'UNCONFIRMED_RECEIPT', severity: 'INFO', message: `出貨單 ${s.id} 已送達，尚未做簽收確認`, refId: s.id });
  return out;
}

// ---------- 載入（皆經資料範圍；範圍外一律 404） ----------

async function loadCampaign(tx: Tx, actor: Actor, campaignId: string, lock = false) {
  const sc = campaignScope(actor, 2, 'c');
  if (sc.sql === 'FALSE') throw notFound('檔期');
  const r = await tx.query(`SELECT c.* FROM campaigns c WHERE c.id=$1 AND (${sc.sql}) ${lock ? 'FOR SHARE OF c' : ''}`, [campaignId, ...sc.params]);
  if (!r.rowCount) throw notFound('檔期');
  return r.rows[0] as Record<string, unknown>;
}

async function loadBatch(tx: Tx, actor: Actor, id: string, lock = false) {
  const sc = campaignScope(actor, 2, 'c');
  if (sc.sql === 'FALSE') throw notFound('出貨批次');
  const r = await tx.query(
    `SELECT b.*, c.status AS campaign_status, c.title AS campaign_title, c.owner_user_id AS campaign_owner
     FROM fulfillment_batches b JOIN campaigns c ON c.id=b.campaign_id WHERE b.id=$1 AND (${sc.sql}) ${lock ? 'FOR UPDATE OF b' : ''}`, [id, ...sc.params]);
  if (!r.rowCount) throw notFound('出貨批次');
  return r.rows[0] as Record<string, unknown>;
}

/** 先鎖批次、再鎖出貨單（所有會同時動到兩者的操作都用這個順序，避免死結） */
async function loadShipmentLocked(tx: Tx, actor: Actor, id: string) {
  const sc = campaignScope(actor, 2, 'c');
  if (sc.sql === 'FALSE') throw notFound('出貨單');
  const peek = await tx.query(
    `SELECT s.batch_id FROM shipments s JOIN campaigns c ON c.id=s.campaign_id WHERE s.id=$1 AND (${sc.sql})`, [id, ...sc.params]);
  if (!peek.rowCount) throw notFound('出貨單');
  const batch = await loadBatch(tx, actor, peek.rows[0].batch_id as string, true);
  const r = await tx.query('SELECT * FROM shipments WHERE id=$1 AND organization_id=$2 FOR UPDATE', [id, actor.orgId]);
  return { batch, shipment: r.rows[0] as Record<string, unknown> };
}

function assertWritable(campaignStatus: string) {
  if (WRITE_BLOCKED.includes(campaignStatus)) throw new AppError('PRECONDITION_FAILED', `檔期目前狀態（${campaignStatus}）不可異動履約資料`);
}

/** 團主／廠商看不到內部備註 */
function project<T extends Record<string, unknown>>(actor: Actor, row: T): T {
  if (isInternal(actor)) return row;
  const { note: _n, createdBy: _c, updatedBy: _u, receiptConfirmedBy: _r, ...rest } = row as Record<string, unknown>;
  return rest as T;
}

async function recomputeBatch(tx: Tx, actor: Actor, batchId: string) {
  const b = await tx.query('SELECT id, status, campaign_id FROM fulfillment_batches WHERE id=$1 FOR UPDATE', [batchId]);
  const cur = b.rows[0];
  if (!cur || cur.status === 'CANCELLED') return cur?.status as string | undefined;
  const sh = await tx.query<{ status: string }>(`SELECT status FROM shipments WHERE batch_id=$1`, [batchId]);
  const next = rollupBatchStatus(sh.rows.map((r) => r.status));
  if (next !== cur.status) {
    await tx.query('UPDATE fulfillment_batches SET status=$2, updated_by=$3 WHERE id=$1', [batchId, next, actor.userId]);
    await audit(tx, actor, { action: 'fulfillment_batch.status', entityType: 'fulfillment_batch', entityId: batchId, campaignId: cur.campaign_id, before: { status: cur.status }, after: { status: next } });
  }
  return next;
}

async function assertTrackingFree(tx: Tx, orgId: string, carrier: string | null, tracking: string | null, selfId?: string) {
  if (!carrier || !tracking) return;
  const dupe = await tx.query(
    `SELECT id FROM shipments WHERE organization_id=$1 AND lower(carrier)=lower($2) AND lower(tracking_no)=lower($3) AND status<>'CANCELLED' AND id<>COALESCE($4,'')`,
    [orgId, carrier, tracking, selfId ?? null]);
  if (dupe.rowCount) throw conflict(`相同的物流商與追蹤碼已用於出貨單 ${dupe.rows[0].id}`, { existingId: dupe.rows[0].id });
}

async function assertSkuInCampaign(tx: Tx, orgId: string, campaignId: string, skuId: string) {
  const r = await tx.query(
    `SELECT 1 FROM campaign_products WHERE organization_id=$1 AND campaign_id=$2 AND sku_id=$3 AND deleted_at IS NULL`, [orgId, campaignId, skuId]);
  if (!r.rowCount) throw validation('這個規格不在此檔期的商品清單內');
}

// ---------- 出貨批次 ----------

const batchCreateSchema = z.object({
  kind: z.enum(['SAMPLE', 'ORDER']).default('ORDER'),
  label: z.string().trim().min(1, '請填寫批次名稱').max(100),
  plannedShipDate: isoDate.optional(),
  note: optText(1000),
});

export async function createBatch(actor: Actor, campaignId: string, raw: z.input<typeof batchCreateSchema>, idemKey?: string | null) {
  requirePerm(actor, 'fulfillment.write');
  const input = batchCreateSchema.parse(raw);
  return withTx(async (tx) => {
    const c = await loadCampaign(tx, actor, campaignId, true);
    assertWritable(c['status'] as string);
    if (input.kind === 'ORDER' && !ORDER_OK.includes(c['status'] as string)) {
      throw new AppError('PRECONDITION_FAILED', `檔期目前狀態（${c['status']}）尚不能建立訂單出貨批次（最早從「已排程」開始；寄樣請選 SAMPLE）`);
    }
    const { result, replayed } = await idempotent(tx, actor, 'fulfillment_batch.create', idemKey, async () => {
      const id = await ids.fulfillmentBatch(tx);
      await tx.query(
        `INSERT INTO fulfillment_batches (id, organization_id, campaign_id, kind, label, planned_ship_date, note, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`, [id, actor.orgId, campaignId, input.kind, input.label, input.plannedShipDate ?? null, input.note ?? null, actor.userId]);
      await audit(tx, actor, { action: 'fulfillment_batch.create', entityType: 'fulfillment_batch', entityId: id, campaignId, after: input });
      return { id };
    }, { campaignId, ...input });
    return { ...result, replayed };
  });
}

const batchUpdateSchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  plannedShipDate: isoDate.nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  version: z.number().int().optional(),
});

export async function updateBatch(actor: Actor, id: string, raw: z.input<typeof batchUpdateSchema>) {
  requirePerm(actor, 'fulfillment.write');
  const rawObj = (raw ?? {}) as Record<string, unknown>;
  const p = batchUpdateSchema.parse({ ...rawObj, ...(rawObj['plannedShipDate'] === '' ? { plannedShipDate: null } : {}), ...(rawObj['note'] === '' ? { note: null } : {}) });
  return withTx(async (tx) => {
    const b = await loadBatch(tx, actor, id, true);
    assertWritable(b['campaign_status'] as string);
    if (b['status'] === 'CANCELLED') throw new AppError('PRECONDITION_FAILED', '批次已取消，不可修改');
    const { after, changed } = await patchEntity(tx, actor, {
      table: 'fulfillment_batches', entityType: 'fulfillment_batch', id, patch: { label: p.label, plannedShipDate: p.plannedShipDate, note: p.note },
      allowed: ['label', 'plannedShipDate', 'note'], expectedVersion: p.version, campaignId: () => b['campaign_id'] as string,
    });
    return { id, version: after['version'], unchanged: !changed };
  });
}

export async function cancelBatch(actor: Actor, id: string, reason: string) {
  requirePerm(actor, 'fulfillment.write');
  const why = nonEmpty(reason);
  if (!why) throw validation('取消批次需填寫原因');
  return withTx(async (tx) => {
    const b = await loadBatch(tx, actor, id, true);
    assertWritable(b['campaign_status'] as string);
    if (b['status'] === 'CANCELLED') return { id, status: 'CANCELLED', unchanged: true };
    const sh = await tx.query('SELECT id, status FROM shipments WHERE batch_id=$1 AND organization_id=$2 FOR UPDATE', [id, actor.orgId]);
    if (sh.rows.some((s) => s.status === 'DELIVERED')) throw new AppError('PRECONDITION_FAILED', '批次內已有送達的出貨單，不能整批取消；請只取消尚未送達的出貨單');
    for (const s of sh.rows.filter((x) => x.status !== 'CANCELLED')) {
      await tx.query(`UPDATE shipments SET status='CANCELLED', cancel_reason=$2, updated_by=$3 WHERE id=$1`, [s.id, `批次取消：${why}`, actor.userId]);
      await audit(tx, actor, { action: 'shipment.status', entityType: 'shipment', entityId: s.id as string, campaignId: b['campaign_id'] as string, before: { status: s.status }, after: { status: 'CANCELLED' }, reason: `批次取消：${why}` });
    }
    await tx.query(`UPDATE fulfillment_batches SET status='CANCELLED', cancel_reason=$2, updated_by=$3 WHERE id=$1`, [id, why, actor.userId]);
    await audit(tx, actor, { action: 'fulfillment_batch.cancel', entityType: 'fulfillment_batch', entityId: id, campaignId: b['campaign_id'] as string, before: { status: b['status'] }, after: { status: 'CANCELLED' }, reason: why });
    return { id, status: 'CANCELLED', cancelledShipments: sh.rows.filter((x) => x.status !== 'CANCELLED').length };
  });
}

const BATCH_SQL = `SELECT b.id, b.campaign_id, c.title AS campaign_title, c.status AS campaign_status, b.kind, b.label, b.status, b.planned_ship_date,
    b.note, b.cancel_reason, b.version, b.created_at, b.updated_at,
    COALESCE(s.total,0)::int AS shipment_count, COALESCE(s.delivered,0)::int AS delivered_count, COALESCE(s.exception,0)::int AS exception_count,
    COALESCE(s.confirmed,0)::int AS confirmed_count, COALESCE(s.qty,0)::int AS total_quantity
  FROM fulfillment_batches b JOIN campaigns c ON c.id=b.campaign_id
  LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE status<>'CANCELLED') AS total, count(*) FILTER (WHERE status='DELIVERED') AS delivered,
      count(*) FILTER (WHERE status='EXCEPTION') AS exception, count(*) FILTER (WHERE receipt_confirmed_at IS NOT NULL) AS confirmed,
      sum(quantity) FILTER (WHERE status<>'CANCELLED') AS qty FROM shipments WHERE batch_id=b.id) s ON true`;

export async function listBatches(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'fulfillment.read');
  const sc = campaignScope(actor, 1, 'c');
  if (sc.sql === 'FALSE') return { items: [], total: 0, limit: 50, offset: 0 };
  const params = [...sc.params];
  const where = [`b.organization_id=$1`, `(${sc.sql})`];
  const add = (cond: (n: number) => string, v: unknown) => { params.push(v); where.push(cond(params.length)); };
  const cid = nonEmpty(q.get('campaignId')); if (cid) add((n) => `b.campaign_id=$${n}`, cid);
  const st = nonEmpty(q.get('status')); if (st) add((n) => `b.status=$${n}`, st);
  const kind = nonEmpty(q.get('kind')); if (kind) add((n) => `b.kind=$${n}`, kind);
  if (q.get('open') === '1') where.push(`b.status IN ('PENDING','PACKED','SHIPPED','EXCEPTION')`);
  const res = await listPaged<Record<string, unknown>>(`${BATCH_SQL} WHERE ${where.join(' AND ')}`, params, 'b.created_at DESC, b.id DESC', pageParams(q));
  res.items = res.items.map((r) => project(actor, camelize<Record<string, unknown>>(r)));
  return res;
}

const SHIPMENT_COLS = `s.id, s.batch_id, s.campaign_id, s.sku_id, k.sku_code, k.name AS sku_name, p.name AS product_name, s.quantity, s.carrier, s.tracking_no, s.status,
  s.planned_date, s.shipped_date, s.delivered_date, s.exception_reason, s.cancel_reason, s.receipt_confirmed_at, s.receipt_confirmed_by,
  s.receipt_signer, s.receipt_note, s.note, s.created_at, s.updated_at, s.version`;

async function shipmentsOf(batchIds: string[]) {
  if (!batchIds.length) return [];
  return query(
    `SELECT ${SHIPMENT_COLS} FROM shipments s LEFT JOIN skus k ON k.id=s.sku_id LEFT JOIN products p ON p.id=k.product_id
     WHERE s.batch_id = ANY($1::text[]) ORDER BY s.created_at, s.id`, [batchIds]);
}

export async function getBatch(actor: Actor, id: string) {
  requirePerm(actor, 'fulfillment.read');
  const b = await withTx((tx) => loadBatch(tx, actor, id));
  const shipments = (await shipmentsOf([id])).map((s) => project(actor, camelize<Record<string, unknown>>(s)));
  const [head] = await query(`${BATCH_SQL} WHERE b.id=$1 AND b.organization_id=$2`, [id, actor.orgId]);
  const row: Record<string, unknown> = project(actor, camelize<Record<string, unknown>>(head ?? b));
  return { ...row, shipments } as Record<string, unknown> & { shipments: Record<string, unknown>[] };
}

/** 檔期層級的履約總覽：批次＋出貨單＋提醒（WARN 只提醒，不阻擋任何關卡） */
export async function getCampaignFulfillment(actor: Actor, campaignId: string) {
  requirePerm(actor, 'fulfillment.read');
  const c = await withTx((tx) => loadCampaign(tx, actor, campaignId));
  const batches = (await listBatches(actor, new URLSearchParams({ campaignId, limit: '200' }))).items as Record<string, unknown>[];
  const shipmentsRaw = (await shipmentsOf(batches.map((b) => b['id'] as string))).map((s) => camelize<Record<string, unknown>>(s));
  const warnings = fulfillmentWarnings(
    c['status'] as string,
    batches.map((b) => ({ id: b['id'] as string, status: b['status'] as string })),
    shipmentsRaw.map((s) => ({ id: s['id'] as string, batchId: s['batchId'] as string, status: s['status'] as string, plannedDate: (s['plannedDate'] as string | null) ?? null, receiptConfirmedAt: (s['receiptConfirmedAt'] as string | null) ?? null })),
    todayTaipei());
  const live = shipmentsRaw.filter((s) => s['status'] !== 'CANCELLED');
  return {
    campaignId, campaignTitle: c['title'], campaignStatus: c['status'], writable: !WRITE_BLOCKED.includes(c['status'] as string),
    totals: {
      batches: batches.filter((b) => b['status'] !== 'CANCELLED').length,
      shipments: live.length,
      delivered: live.filter((s) => s['status'] === 'DELIVERED').length,
      confirmed: live.filter((s) => s['receiptConfirmedAt']).length,
      exception: live.filter((s) => s['status'] === 'EXCEPTION').length,
      quantity: live.reduce((a, s) => a + Number(s['quantity']), 0),
    },
    warnings,
    batches: batches.map((b) => ({ ...b, shipments: shipmentsRaw.filter((s) => s['batchId'] === b['id']).map((s) => project(actor, s)) })),
  };
}

// ---------- 出貨單 ----------

const shipmentCreateSchema = z.object({
  skuId: z.string().optional().or(z.literal('').transform(() => undefined)),
  quantity: qty,
  carrier: optText(50),
  trackingNo: optText(80),
  plannedDate: isoDate.optional().or(z.literal('').transform(() => undefined)),
  note: optText(1000),
});

export async function addShipment(actor: Actor, batchId: string, raw: z.input<typeof shipmentCreateSchema>, idemKey?: string | null) {
  requirePerm(actor, 'fulfillment.write');
  const input = shipmentCreateSchema.parse(raw);
  if (input.trackingNo && !input.carrier) throw validation('填寫追蹤碼時需要同時填寫物流商');
  return withTx(async (tx) => {
    const b = await loadBatch(tx, actor, batchId, true);
    assertWritable(b['campaign_status'] as string);
    if (b['status'] === 'CANCELLED') throw new AppError('PRECONDITION_FAILED', '批次已取消，不能再新增出貨單');
    const { result, replayed } = await idempotent(tx, actor, 'shipment.create', idemKey, async () => {
      if (input.skuId) await assertSkuInCampaign(tx, actor.orgId, b['campaign_id'] as string, input.skuId);
      await assertTrackingFree(tx, actor.orgId, input.carrier ?? null, input.trackingNo ?? null);
      const id = await ids.shipment(tx);
      await tx.query(
        `INSERT INTO shipments (id, organization_id, campaign_id, batch_id, sku_id, quantity, carrier, tracking_no, planned_date, note, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
        [id, actor.orgId, b['campaign_id'], batchId, input.skuId ?? null, input.quantity, input.carrier ?? null, input.trackingNo ?? null, input.plannedDate ?? null, input.note ?? null, actor.userId]);
      await audit(tx, actor, { action: 'shipment.create', entityType: 'shipment', entityId: id, campaignId: b['campaign_id'] as string, after: { batchId, ...input } });
      const batchStatus = await recomputeBatch(tx, actor, batchId);
      return { id, batchStatus };
    }, { batchId, ...input });
    return { ...result, replayed };
  });
}

const shipmentUpdateSchema = z.object({
  skuId: z.string().nullable().optional(),
  quantity: qty.optional(),
  carrier: z.string().trim().max(50).nullable().optional(),
  trackingNo: z.string().trim().max(80).nullable().optional(),
  plannedDate: isoDate.nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  version: z.number().int().optional(),
});

export async function updateShipment(actor: Actor, id: string, raw: z.input<typeof shipmentUpdateSchema>) {
  requirePerm(actor, 'fulfillment.write');
  const r = (raw ?? {}) as Record<string, unknown>;
  const cleared = Object.fromEntries(['skuId', 'carrier', 'trackingNo', 'plannedDate', 'note'].filter((k) => r[k] === '').map((k) => [k, null]));
  const p = shipmentUpdateSchema.parse({ ...r, ...cleared });
  return withTx(async (tx) => {
    const { batch, shipment } = await loadShipmentLocked(tx, actor, id);
    assertWritable(batch['campaign_status'] as string);
    const status = shipment['status'] as ShipmentStatus;
    if (status === 'DELIVERED' || status === 'CANCELLED') throw new AppError('PRECONDITION_FAILED', '已送達或已取消的出貨單不可修改');
    if (p.quantity !== undefined && !['PENDING', 'PACKED', 'EXCEPTION'].includes(status)) throw new AppError('PRECONDITION_FAILED', '已出貨的出貨單不可修改數量');
    const carrier = p.carrier !== undefined ? p.carrier : (shipment['carrier'] as string | null);
    const tracking = p.trackingNo !== undefined ? p.trackingNo : (shipment['tracking_no'] as string | null);
    if (tracking && !carrier) throw validation('填寫追蹤碼時需要同時填寫物流商');
    if (p.skuId) await assertSkuInCampaign(tx, actor.orgId, shipment['campaign_id'] as string, p.skuId);
    await assertTrackingFree(tx, actor.orgId, carrier, tracking, id);
    const { after, changed } = await patchEntity(tx, actor, {
      table: 'shipments', entityType: 'shipment', id, patch: { skuId: p.skuId, quantity: p.quantity, carrier: p.carrier, trackingNo: p.trackingNo, plannedDate: p.plannedDate, note: p.note },
      allowed: ['skuId', 'quantity', 'carrier', 'trackingNo', 'plannedDate', 'note'], expectedVersion: p.version, campaignId: () => shipment['campaign_id'] as string,
    });
    return { id, version: after['version'], unchanged: !changed };
  });
}

const statusSchema = z.object({
  to: z.enum(SHIPMENT_STATUSES),
  reason: z.string().trim().max(500).optional(),
  date: isoDate.optional(),
  carrier: optText(50),
  trackingNo: optText(80),
  version: z.number().int().optional(),
});

export async function setShipmentStatus(actor: Actor, id: string, raw: z.input<typeof statusSchema>) {
  requirePerm(actor, 'fulfillment.write');
  const input = statusSchema.parse(raw);
  const today = todayTaipei();
  return withTx(async (tx) => {
    const { batch, shipment } = await loadShipmentLocked(tx, actor, id);
    assertWritable(batch['campaign_status'] as string);
    if (batch['status'] === 'CANCELLED') throw new AppError('PRECONDITION_FAILED', '批次已取消，出貨單不可變更');
    const from = shipment['status'] as ShipmentStatus;
    if (input.version != null && shipment['version'] !== input.version) throw conflict('出貨單已被其他人更新，請重新整理後再試', { currentVersion: shipment['version'] });
    if (from === input.to) return { id, status: from, unchanged: true };
    if (!SHIPMENT_TRANSITIONS[from].includes(input.to)) throw new AppError('PRECONDITION_FAILED', `出貨單不能從 ${from} 變更為 ${input.to}`, { allowed: SHIPMENT_TRANSITIONS[from] });
    if ((input.to === 'EXCEPTION' || input.to === 'CANCELLED') && !input.reason) throw validation(input.to === 'EXCEPTION' ? '標記異常需填寫原因' : '取消出貨單需填寫原因');

    const sets: Record<string, unknown> = { status: input.to };
    if (input.to === 'EXCEPTION') sets['exception_reason'] = input.reason;
    if (input.to === 'CANCELLED') sets['cancel_reason'] = input.reason;
    if (input.to === 'SHIPPED' || input.to === 'DELIVERED') {
      const carrier = input.carrier ?? (shipment['carrier'] as string | null);
      const tracking = input.trackingNo ?? (shipment['tracking_no'] as string | null);
      if (tracking && !carrier) throw validation('填寫追蹤碼時需要同時填寫物流商');
      if (input.to === 'SHIPPED' && !carrier) throw validation('出貨前請先填寫物流商（自行配送請填「自送」）');
      await assertTrackingFree(tx, actor.orgId, carrier, tracking, id);
      if (input.carrier) sets['carrier'] = input.carrier;
      if (input.trackingNo) sets['tracking_no'] = input.trackingNo;
    }
    if (input.to === 'SHIPPED') {
      const d = input.date ?? today;
      if (d > today) throw validation('出貨日不可是未來日期');
      sets['shipped_date'] = d;
    }
    if (input.to === 'DELIVERED') {
      const d = input.date ?? today;
      if (d > today) throw validation('送達日不可是未來日期');
      const shipped = (shipment['shipped_date'] as string | null) ?? d;
      if (d < shipped) throw validation('送達日不可早於出貨日');
      sets['delivered_date'] = d;
      if (!shipment['shipped_date']) sets['shipped_date'] = shipped;
    }
    const cols = Object.keys(sets);
    const upd = await tx.query(
      `UPDATE shipments SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(', ')}, updated_by=$${cols.length + 2} WHERE id=$1 RETURNING version`,
      [id, ...cols.map((c) => sets[c]), actor.userId]);
    await audit(tx, actor, { action: 'shipment.status', entityType: 'shipment', entityId: id, campaignId: shipment['campaign_id'] as string, before: { status: from }, after: { status: input.to, ...Object.fromEntries(cols.filter((c) => c !== 'status').map((c) => [c, sets[c]])) }, reason: input.reason ?? null });
    const batchStatus = await recomputeBatch(tx, actor, batch['id'] as string);
    const owner = batch['campaign_owner'] as string | null;
    if (input.to === 'EXCEPTION' && owner) {
      await queueNotification(tx, actor.orgId, {
        recipientUserId: owner, subject: `出貨異常：${shipment['id']}`, body: `檔期「${batch['campaign_title']}」的出貨單 ${shipment['id']} 標記為異常：${input.reason}`,
        entityType: 'shipment', entityId: id, dedupeKey: `shipment_exception:${id}:${upd.rows[0].version}`,
      });
    }
    return { id, status: input.to, batchStatus };
  });
}

const receiptSchema = z.object({ signer: z.string().trim().min(1, '請填寫簽收人').max(50), note: optText(500) });

/** 簽收確認：只能對「已送達」的出貨單做；已確認過再送一次不會覆蓋（冪等） */
export async function confirmReceipt(actor: Actor, id: string, raw: z.input<typeof receiptSchema>) {
  requirePerm(actor, 'fulfillment.write');
  const input = receiptSchema.parse(raw);
  return withTx(async (tx) => {
    const { batch, shipment } = await loadShipmentLocked(tx, actor, id);
    assertWritable(batch['campaign_status'] as string);
    if (shipment['status'] !== 'DELIVERED') throw new AppError('PRECONDITION_FAILED', '出貨單需先標記為「已送達」才能做簽收確認');
    if (shipment['receipt_confirmed_at']) return { id, confirmed: true, unchanged: true, receiptSigner: shipment['receipt_signer'] };
    await tx.query(
      `UPDATE shipments SET receipt_confirmed_at=now(), receipt_confirmed_by=$2, receipt_signer=$3, receipt_note=$4, updated_by=$2 WHERE id=$1`,
      [id, actor.userId, input.signer, input.note ?? null]);
    await audit(tx, actor, { action: 'shipment.receipt', entityType: 'shipment', entityId: id, campaignId: shipment['campaign_id'] as string, after: { signer: input.signer, note: input.note ?? null } });
    return { id, confirmed: true, unchanged: false, receiptSigner: input.signer };
  });
}

// ---------- 庫存（append-only 異動；內部角色限定） ----------

function requireInternalRead(actor: Actor) {
  requirePerm(actor, 'fulfillment.read');
  if (!isInternal(actor)) throw forbidden('庫存資料僅限內部人員檢視');
}

async function balanceOf(tx: Tx, orgId: string, skuId: string): Promise<number> {
  const r = await tx.query<{ n: string | null }>('SELECT COALESCE(sum(delta),0)::bigint AS n FROM inventory_movements WHERE organization_id=$1 AND sku_id=$2', [orgId, skuId]);
  return Number(r.rows[0].n);
}

const ADJUST_CODES = ['INITIAL', 'RESTOCK', 'ADJUST', 'DAMAGE', 'RETURN'] as const;
const adjustSchema = z.object({
  skuId: z.string().min(1),
  campaignId: z.string().optional().or(z.literal('').transform(() => undefined)),
  delta: z.number().int().refine((v) => v !== 0 && Math.abs(v) <= 1_000_000, '異動數量不可為 0，且不可超過 1,000,000'),
  reasonCode: z.enum(ADJUST_CODES),
  reason: z.string().trim().min(1, '請填寫異動原因').max(300),
});

export async function adjustStock(actor: Actor, raw: z.input<typeof adjustSchema>, idemKey?: string | null) {
  requirePerm(actor, 'fulfillment.write');
  const input = adjustSchema.parse(raw);
  if (['INITIAL', 'RESTOCK', 'RETURN'].includes(input.reasonCode) && input.delta < 0) throw validation('此原因代碼的異動數量必須為正數');
  if (input.reasonCode === 'DAMAGE' && input.delta > 0) throw validation('報廢／損耗的異動數量必須為負數');
  return withTx(async (tx) => {
    const sku = await tx.query('SELECT id, product_id FROM skus WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL FOR UPDATE', [input.skuId, actor.orgId]);
    if (!sku.rowCount) throw notFound('規格');
    if (input.campaignId) await loadCampaign(tx, actor, input.campaignId);
    const { result, replayed } = await idempotent(tx, actor, 'inventory.adjust', idemKey, async () => {
      const bal = await balanceOf(tx, actor.orgId, input.skuId);
      if (input.reasonCode === 'INITIAL') {
        const any = await tx.query('SELECT 1 FROM inventory_movements WHERE organization_id=$1 AND sku_id=$2 LIMIT 1', [actor.orgId, input.skuId]);
        if (any.rowCount) throw conflict('此規格已有庫存異動，期初庫存只能設定一次；請改用補貨或盤點調整');
      }
      if (bal + input.delta < 0) throw new AppError('PRECONDITION_FAILED', `庫存不可為負（目前 ${bal}，異動 ${input.delta}）`, { balance: bal });
      const id = await ids.inventoryMovement(tx);
      await tx.query(
        `INSERT INTO inventory_movements (id, organization_id, sku_id, campaign_id, delta, reason_code, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, actor.orgId, input.skuId, input.campaignId ?? null, input.delta, input.reasonCode, input.reason, actor.userId]);
      await audit(tx, actor, { action: 'inventory.adjust', entityType: 'inventory_movement', entityId: id, campaignId: input.campaignId ?? null, after: { ...input, balanceAfter: bal + input.delta } });
      return { id, balance: bal + input.delta };
    }, input);
    return { ...result, replayed };
  });
}

/** 更正：新增一筆數量相反的 CORRECTION 異動，原紀錄保留；同一筆只能更正一次 */
export async function reverseMovement(actor: Actor, id: string, reason: string) {
  requirePerm(actor, 'fulfillment.write');
  const why = nonEmpty(reason);
  if (!why) throw validation('更正庫存異動需填寫原因');
  return withTx(async (tx) => {
    const m = await tx.query('SELECT * FROM inventory_movements WHERE id=$1 AND organization_id=$2', [id, actor.orgId]);
    if (!m.rowCount) throw notFound('庫存異動');
    const mv = m.rows[0];
    await tx.query('SELECT 1 FROM skus WHERE id=$1 FOR UPDATE', [mv.sku_id]);
    if (mv.reason_code === 'CORRECTION') throw new AppError('PRECONDITION_FAILED', '更正紀錄本身不能再被更正；請新增一筆調整');
    const done = await tx.query('SELECT id FROM inventory_movements WHERE reverses_id=$1', [id]);
    if (done.rowCount) throw conflict(`這筆異動已被更正（${done.rows[0].id}）`, { existingId: done.rows[0].id });
    const bal = await balanceOf(tx, actor.orgId, mv.sku_id as string);
    const delta = -Number(mv.delta);
    if (bal + delta < 0) throw new AppError('PRECONDITION_FAILED', `更正後庫存會變成負數（目前 ${bal}，更正 ${delta}）`, { balance: bal });
    const nid = await ids.inventoryMovement(tx);
    await tx.query(
      `INSERT INTO inventory_movements (id, organization_id, sku_id, campaign_id, delta, reason_code, reason, reverses_id, created_by) VALUES ($1,$2,$3,$4,$5,'CORRECTION',$6,$7,$8)`,
      [nid, actor.orgId, mv.sku_id, mv.campaign_id, delta, why, id, actor.userId]);
    await audit(tx, actor, { action: 'inventory.correct', entityType: 'inventory_movement', entityId: nid, campaignId: (mv.campaign_id as string | null) ?? null, before: { reversed: id, delta: mv.delta }, after: { delta, balanceAfter: bal + delta }, reason: why });
    return { id: nid, reverses: id, balance: bal + delta };
  });
}

export async function listMovements(actor: Actor, q: URLSearchParams) {
  requireInternalRead(actor);
  const params: unknown[] = [actor.orgId];
  const where = ['m.organization_id=$1'];
  const add = (cond: (n: number) => string, v: unknown) => { params.push(v); where.push(cond(params.length)); };
  const sku = nonEmpty(q.get('skuId')); if (sku) add((n) => `m.sku_id=$${n}`, sku);
  const cid = nonEmpty(q.get('campaignId')); if (cid) add((n) => `m.campaign_id=$${n}`, cid);
  const res = await listPaged<Record<string, unknown>>(
    `SELECT m.id, m.sku_id, k.sku_code, k.name AS sku_name, p.name AS product_name, m.campaign_id, m.delta, m.reason_code, m.reason, m.reverses_id, m.created_at, m.created_by,
       EXISTS (SELECT 1 FROM inventory_movements r WHERE r.reverses_id=m.id) AS reversed
     FROM inventory_movements m JOIN skus k ON k.id=m.sku_id JOIN products p ON p.id=k.product_id WHERE ${where.join(' AND ')}`, params, 'm.created_at DESC, m.id DESC', pageParams(q));
  res.items = res.items.map((r) => camelize(r));
  return res;
}

/** 各規格目前庫存（= 異動加總）。可用 campaignId 只看某檔期的規格 */
export async function listStock(actor: Actor, q: URLSearchParams) {
  requireInternalRead(actor);
  const params: unknown[] = [actor.orgId];
  const where = [`k.organization_id=$1`, `k.deleted_at IS NULL`, `p.deleted_at IS NULL`];
  const add = (cond: (n: number) => string, v: unknown) => { params.push(v); where.push(cond(params.length)); };
  const cid = nonEmpty(q.get('campaignId')); if (cid) add((n) => `EXISTS (SELECT 1 FROM campaign_products cp WHERE cp.sku_id=k.id AND cp.campaign_id=$${n} AND cp.deleted_at IS NULL)`, cid);
  const pid = nonEmpty(q.get('productId')); if (pid) add((n) => `k.product_id=$${n}`, pid);
  if (q.get('tracked') === '1') where.push(`EXISTS (SELECT 1 FROM inventory_movements m WHERE m.sku_id=k.id)`);
  const res = await listPaged<Record<string, unknown>>(
    `SELECT k.id AS sku_id, k.sku_code, k.name AS sku_name, p.id AS product_id, p.name AS product_name,
       COALESCE((SELECT sum(delta) FROM inventory_movements m WHERE m.sku_id=k.id),0)::bigint AS balance,
       EXISTS (SELECT 1 FROM inventory_movements m WHERE m.sku_id=k.id) AS tracked,
       (SELECT max(created_at) FROM inventory_movements m WHERE m.sku_id=k.id) AS last_movement_at
     FROM skus k JOIN products p ON p.id=k.product_id WHERE ${where.join(' AND ')}`, params, 'p.name, k.sku_code', pageParams(q));
  res.items = res.items.map((r) => camelize(r));
  return res;
}
