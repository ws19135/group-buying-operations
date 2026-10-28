import crypto from 'node:crypto';
import { z } from 'zod';
import type { Tx } from '../lib/db';
import { pool, query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, isInternal, requirePerm } from '../lib/permissions';
import { AppError, forbidden, notFound, validation } from '../lib/errors';
import { audit, emitEvent } from '../lib/audit';
import { ids, todayTaipei } from '../lib/ids';
import { camelize } from '../lib/case';
import { isIsoDate } from '../lib/dates';
import { normalizeName, nonEmpty } from '../lib/text';
import { likePattern, listPaged, pageParams, patchEntity } from '../lib/repo';
import { idempotent } from '../lib/idempotency';
import { campaignScope } from '../lib/scope';
import { detectConflicts, type Conflict } from './conflicts';
import { generateTasks, isOverdue, toInputs } from './tasks';
import { loadActiveTemplate, loadTemplate } from '../workflow/templates';
import { previewReschedule, type ExistingTask, type Params } from '../workflow/schedule';
import { CAMPAIGN_STATUSES, TRANSITIONS, type CampaignStatus } from '../workflow/state';

const optText = (max = 500) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));
const isoDate = z.string().refine(isIsoDate, '日期格式需為 YYYY-MM-DD');
const money = z.number().int().min(0).max(10_000_000_000);

export function validateCampaignDates(d: { openDate?: string | null; closeDate?: string | null; sampleReadyDate?: string | null; liveTalkDate?: string | null }) {
  const { openDate: o, closeDate: c, sampleReadyDate: s, liveTalkDate: l } = d;
  if (o && c && o > c) throw validation('開團日不可晚於結團日');
  if (s && o && s >= o) throw validation('試用品可寄出日必須早於開團日');
  if (l && o && l < o) throw validation('Live Talk 日期不可早於開團日');
  if (l && c && l > c) throw validation('Live Talk 日期不可晚於結團日');
}

export const campaignCreateSchema = z.object({
  title: z.string().trim().min(1, '請輸入檔期名稱').max(160),
  vendorId: z.string().min(1, '請選擇廠商'),
  ownerUserId: z.string().optional(),
  campaignType: optText(40),
  description: optText(3000),
  openDate: isoDate.optional(),
  closeDate: isoDate.optional(),
  sampleReadyDate: isoDate.optional(),
  needsSampleRecovery: z.boolean().optional(),
  liveTalkDate: isoDate.optional(),
  targetRevenue: money.optional(),
  internalNote: optText(3000),
  products: z.array(z.object({ productId: z.string(), skuId: z.string().optional(), campaignPrice: money.optional(), limitQty: z.number().int().min(0).optional(), note: optText(300) })).max(100).optional(),
  hosts: z.array(z.object({ hostId: z.string(), role: z.enum(['PRIMARY', 'CO']).optional(), targetRevenue: money.optional() })).max(50).optional(),
});

const DUP_MSG = '相同廠商、相同名稱、相同開團日的檔期已存在（可能是重複送出）';

async function raiseIfDuplicate(e: unknown, tx: Tx, actor: Actor, vendorId: string, title: string, openDate?: string | null): Promise<never> {
  const code = (e as { code?: string; constraint?: string }).code;
  if (code === '23505' && (e as { constraint?: string }).constraint === 'campaigns_natural_uq') {
    const ex = await query<{ id: string }>(
      `SELECT id FROM campaigns WHERE organization_id=$1 AND vendor_id=$2 AND normalized_title=$3
         AND COALESCE(open_date, DATE '1900-01-01') = COALESCE($4::date, DATE '1900-01-01') AND deleted_at IS NULL AND status<>'CANCELLED' LIMIT 1`,
      [actor.orgId, vendorId, normalizeName(title), openDate ?? null]);
    void tx;
    throw new AppError('CONFLICT', DUP_MSG, { existingId: ex[0]?.id });
  }
  throw e;
}

export async function createCampaign(actor: Actor, raw: z.input<typeof campaignCreateSchema>, idemKey?: string | null) {
  requirePerm(actor, 'campaign.write');
  const input = campaignCreateSchema.parse(raw);
  validateCampaignDates(input);
  if (input.targetRevenue != null && !can(actor, 'campaign.sensitive.read')) throw forbidden('沒有設定檔期目標的權限');
  return withTx(async (tx) => {
    const { result, replayed } = await idempotent(tx, actor, 'campaign.create', idemKey, async () => {
      const v = await tx.query('SELECT status FROM vendors WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [input.vendorId, actor.orgId]);
      if (!v.rowCount) throw notFound('廠商');
      if (['BLACKLISTED', 'PAUSED'].includes(v.rows[0].status)) throw new AppError('PRECONDITION_FAILED', `廠商狀態為 ${v.rows[0].status}，不可建立新檔期`);

      let ownerId = input.ownerUserId ?? (isInternal(actor) ? actor.userId : null);
      if (input.ownerUserId) {
        const u = await tx.query(`SELECT role_key FROM users WHERE id=$1 AND organization_id=$2 AND status='ACTIVE' AND deleted_at IS NULL`, [input.ownerUserId, actor.orgId]);
        if (!u.rowCount) throw notFound('檔期負責人');
        if (!['SYSTEM_ADMIN', 'OPS_MANAGER', 'OPS_EDITOR'].includes(u.rows[0].role_key)) throw validation('檔期負責人必須是營運人員');
        ownerId = input.ownerUserId;
      }
      const tpl = await loadActiveTemplate(tx, actor.orgId);
      const id = await ids.campaign(tx);
      try {
        await tx.query(
          `INSERT INTO campaigns (id, organization_id, title, normalized_title, vendor_id, owner_user_id, campaign_type, description, open_date, close_date,
             sample_ready_date, needs_sample_recovery, live_talk_date, target_revenue, internal_note, workflow_template_id, workflow_template_version,
             workflow_params, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)`,
          [id, actor.orgId, input.title, normalizeName(input.title), input.vendorId, ownerId, input.campaignType ?? 'STANDARD', input.description ?? null,
            input.openDate ?? null, input.closeDate ?? null, input.sampleReadyDate ?? null, input.needsSampleRecovery ?? false, input.liveTalkDate ?? null,
            input.targetRevenue ?? null, input.internalNote ?? null, tpl.id, tpl.version, JSON.stringify(tpl.params), actor.userId]);
      } catch (e) {
        await raiseIfDuplicate(e, tx, actor, input.vendorId, input.title, input.openDate);
      }
      for (const p of input.products ?? []) await insertCampaignProduct(tx, actor, id, input.vendorId, p);
      for (const h of input.hosts ?? []) await insertCampaignHost(tx, actor, id, h);
      const gen = await generateTasks(tx, actor, id);
      await audit(tx, actor, { action: 'campaign.create', entityType: 'campaign', entityId: id, campaignId: id,
        after: { title: input.title, vendorId: input.vendorId, openDate: input.openDate ?? null, closeDate: input.closeDate ?? null, tasks: gen.created } });
      await emitEvent(tx, actor, 'campaign.created', 'campaign', id, { vendorId: input.vendorId }, `campaign.created:${id}`);
      return { id, tasksCreated: gen.created };
    }, input);
    const conflicts = await detectConflicts(tx, actor.orgId, result.id);
    return { ...result, replayed, conflicts };
  });
}

async function insertCampaignProduct(tx: Tx, actor: Actor, campaignId: string, vendorId: string, p: { productId: string; skuId?: string; campaignPrice?: number; limitQty?: number; note?: string }) {
  const pr = await tx.query('SELECT vendor_id FROM products WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [p.productId, actor.orgId]);
  if (!pr.rowCount) throw notFound(`商品 ${p.productId}`);
  if (pr.rows[0].vendor_id !== vendorId) throw validation(`商品 ${p.productId} 不屬於此檔期的廠商`);
  if (p.skuId) {
    const s = await tx.query('SELECT product_id, group_price FROM skus WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [p.skuId, actor.orgId]);
    if (!s.rowCount || s.rows[0].product_id !== p.productId) throw validation(`規格 ${p.skuId} 不屬於商品 ${p.productId}`);
  }
  const dupe = await tx.query(`SELECT 1 FROM campaign_products WHERE campaign_id=$1 AND product_id=$2 AND COALESCE(sku_id,'')=COALESCE($3,'') AND deleted_at IS NULL`, [campaignId, p.productId, p.skuId ?? null]);
  if (dupe.rowCount) throw new AppError('CONFLICT', '此商品／規格已在檔期內');
  const id = await ids.campaignProduct(tx);
  await tx.query(
    `INSERT INTO campaign_products (id, organization_id, campaign_id, product_id, sku_id, campaign_price, limit_qty, note, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`, [id, actor.orgId, campaignId, p.productId, p.skuId ?? null, p.campaignPrice ?? null, p.limitQty ?? null, p.note ?? null, actor.userId]);
  await audit(tx, actor, { action: 'campaign_product.add', entityType: 'campaign_product', entityId: id, campaignId, after: p });
  return id;
}

async function insertCampaignHost(tx: Tx, actor: Actor, campaignId: string, h: { hostId: string; role?: 'PRIMARY' | 'CO'; targetRevenue?: number }) {
  const hr = await tx.query('SELECT status FROM hosts WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [h.hostId, actor.orgId]);
  if (!hr.rowCount) throw notFound(`團主 ${h.hostId}`);
  if (hr.rows[0].status === 'ENDED') throw new AppError('PRECONDITION_FAILED', `團主 ${h.hostId} 已結束合作`);
  const dupe = await tx.query('SELECT 1 FROM campaign_hosts WHERE campaign_id=$1 AND host_id=$2 AND deleted_at IS NULL', [campaignId, h.hostId]);
  if (dupe.rowCount) throw new AppError('CONFLICT', `團主 ${h.hostId} 已在此檔期內`);
  const id = await ids.campaignHost(tx);
  await tx.query(
    `INSERT INTO campaign_hosts (id, organization_id, campaign_id, host_id, role, target_revenue, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
    [id, actor.orgId, campaignId, h.hostId, h.role ?? 'PRIMARY', h.targetRevenue ?? null, actor.userId]);
  await audit(tx, actor, { action: 'campaign_host.add', entityType: 'campaign_host', entityId: id, campaignId, after: h });
  return id;
}

// ---------------- 查詢 ----------------
export async function listCampaigns(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'campaign.read');
  const sc = campaignScope(actor, 1, 'c');
  if (sc.sql === 'FALSE') return { items: [], total: 0, limit: 50, offset: 0 };
  const params = [...sc.params];
  const where = [`(${sc.sql})`];
  const add = (cond: (n: number) => string, v: unknown) => { params.push(v); where.push(cond(params.length)); };
  const text = nonEmpty(q.get('q')); if (text) add((n) => `(c.title ILIKE $${n} OR c.id ILIKE $${n})`, likePattern(text));
  const st = nonEmpty(q.get('status')); if (st) add((n) => `c.status = ANY($${n}::text[])`, st.split(','));
  const vid = nonEmpty(q.get('vendorId')); if (vid) add((n) => `c.vendor_id=$${n}`, vid);
  const hid = nonEmpty(q.get('hostId')); if (hid) add((n) => `EXISTS (SELECT 1 FROM campaign_hosts x WHERE x.campaign_id=c.id AND x.host_id=$${n} AND x.deleted_at IS NULL)`, hid);
  const from = nonEmpty(q.get('from')); const to = nonEmpty(q.get('to'));
  if (from && isIsoDate(from)) add((n) => `(c.close_date IS NULL OR c.close_date >= $${n}::date)`, from);
  if (to && isIsoDate(to)) add((n) => `(c.open_date IS NULL OR c.open_date <= $${n}::date)`, to);
  if (q.get('mine') === '1') add((n) => `c.owner_user_id=$${n}`, actor.userId);
  if (q.get('active') === '1') where.push(`c.status NOT IN ('CLOSED','CANCELLED')`);
  const internal = isInternal(actor);
  const sensitive = can(actor, 'campaign.sensitive.read');
  const hostFilter = actor.role === 'HOST' ? `AND ch.host_id = ANY(${(params.push(actor.hostIds), `$${params.length}`)}::text[])` : '';
  params.push(todayTaipei());
  const todayP = `$${params.length}`;
  let roleFilter = '';
  if (!internal) { params.push(actor.role); roleFilter = `AND t.owner_role=$${params.length}`; }
  const res = await listPaged<Record<string, unknown>>(
    `SELECT c.id, c.title, c.status, c.vendor_id, v.name AS vendor_name, c.open_date, c.close_date, c.owner_user_id, ou.name AS owner_name,
       c.version, c.updated_at ${sensitive ? ', c.target_revenue' : ''},
       (SELECT coalesce(json_agg(json_build_object('hostId', h.id, 'name', h.display_name, 'status', ch.status) ORDER BY ch.id), '[]'::json)
          FROM campaign_hosts ch JOIN hosts h ON h.id=ch.host_id WHERE ch.campaign_id=c.id AND ch.deleted_at IS NULL ${hostFilter}) AS hosts,
       (SELECT count(*)::int FROM tasks t WHERE t.campaign_id=c.id AND t.status<>'SKIPPED' AND t.status<>'CANCELLED' ${roleFilter}) AS task_total,
       (SELECT count(*)::int FROM tasks t WHERE t.campaign_id=c.id AND t.status='DONE' ${roleFilter}) AS task_done,
       (SELECT count(*)::int FROM tasks t WHERE t.campaign_id=c.id AND t.status IN ('TODO','IN_PROGRESS','BLOCKED','WAITING_APPROVAL') AND t.planned_end < ${todayP}::date ${roleFilter}) AS overdue_count
     FROM campaigns c JOIN vendors v ON v.id=c.vendor_id LEFT JOIN users ou ON ou.id=c.owner_user_id
     WHERE ${where.join(' AND ')}`, params, 'c.open_date DESC NULLS LAST, c.id DESC', pageParams(q));
  res.items = camelize(res.items);
  return res;
}

async function loadScoped(actor: Actor, id: string, tx?: Tx, lock = false) {
  const sc = campaignScope(actor, 2, 'c');
  if (sc.sql === 'FALSE') throw notFound('檔期');
  const sql = `SELECT c.* FROM campaigns c WHERE c.id=$1 AND (${sc.sql}) ${lock ? 'FOR UPDATE OF c' : ''}`;
  const rows = tx ? (await tx.query(sql, [id, ...sc.params])).rows : await query(sql, [id, ...sc.params]);
  if (!rows.length) throw notFound('檔期');
  return rows[0] as Record<string, unknown>;
}

export async function getCampaign(actor: Actor, id: string) {
  requirePerm(actor, 'campaign.read');
  const c = await loadScoped(actor, id);
  const internal = isInternal(actor);
  const sensitive = can(actor, 'campaign.sensitive.read');
  const roleFilter = actor.role === 'HOST' ? `AND t.owner_role='HOST'` : actor.role === 'VENDOR' ? `AND t.owner_role='VENDOR'` : '';
  const [vendor] = await query('SELECT id, name, status FROM vendors WHERE id=$1', [c['vendor_id']]);
  const products = await query(
    `SELECT cp.id, cp.product_id, p.name AS product_name, p.review_status, cp.sku_id, s.sku_code, s.name AS sku_name, s.list_price, s.group_price,
       cp.campaign_price, cp.limit_qty, cp.note
     FROM campaign_products cp JOIN products p ON p.id=cp.product_id LEFT JOIN skus s ON s.id=cp.sku_id
     WHERE cp.campaign_id=$1 AND cp.deleted_at IS NULL ORDER BY cp.id`, [id]);
  const hostRows = internal || actor.role === 'HOST'
    ? await query(
        `SELECT ch.id, ch.host_id, h.display_name, ch.role, ch.status, ch.responded_at, ch.note ${internal ? ', ch.target_revenue' : ', ch.target_revenue'}
         FROM campaign_hosts ch JOIN hosts h ON h.id=ch.host_id WHERE ch.campaign_id=$1 AND ch.deleted_at IS NULL
         ${actor.role === 'HOST' ? 'AND ch.host_id = ANY($2::text[])' : ''} ORDER BY ch.id`, actor.role === 'HOST' ? [id, actor.hostIds] : [id])
    : [];
  const placements = internal || actor.role === 'HOST'
    ? await query(
        `SELECT p.id, p.host_id, h.display_name AS host_name, p.community_id, cm.name AS community_name, cm.platform, p.placement_type,
           p.scheduled_on, p.scheduled_time, p.status, p.content_ref, p.note
         FROM campaign_placements p JOIN hosts h ON h.id=p.host_id JOIN communities cm ON cm.id=p.community_id
         WHERE p.campaign_id=$1 AND p.deleted_at IS NULL ${actor.role === 'HOST' ? 'AND p.host_id = ANY($2::text[])' : ''}
         ORDER BY p.scheduled_on, p.id`, actor.role === 'HOST' ? [id, actor.hostIds] : [id])
    : [];
  const tasks = await query(
    `SELECT t.id, t.step_key, t.name, t.phase, t.seq, t.owner_role, t.assignee_user_id, u.name AS assignee_name, t.kind, t.gate_key, t.status,
       t.planned_start, t.planned_end, t.completed_at, t.date_locked, t.date_lock_reason, t.optional, t.skip_reason, t.blocker_reason, t.schedule_issue, t.version
     FROM tasks t LEFT JOIN users u ON u.id=t.assignee_user_id WHERE t.campaign_id=$1 ${roleFilter} ORDER BY t.seq`, [id]);
  const today = todayTaipei();
  const out = camelize<Record<string, unknown>>(c);
  if (!sensitive) delete out.targetRevenue;
  if (!internal) { delete out.internalNote; delete out.workflowParams; delete out.statusReason; delete out.previousStatus; }
  if (!sensitive) for (const h of hostRows as Record<string, unknown>[]) if (actor.role !== 'HOST') delete h['target_revenue'];
  const extra = internal ? {
    approvals: camelize(await query('SELECT * FROM approvals WHERE campaign_id=$1 ORDER BY id DESC', [id])),
    conflicts: await detectConflicts(pool(), actor.orgId, id),
    exceptions: camelize(await query(`SELECT id, type, severity, title, detail, status, detected_at FROM exceptions WHERE campaign_id=$1 AND status<>'RESOLVED' ORDER BY id DESC`, [id])),
  } : {};
  const allowed = internal && can(actor, 'campaign.transition')
    ? TRANSITIONS[c['status'] as CampaignStatus].filter((t) => t.kind === 'MANUAL').map((t) => ({ to: t.to, backward: !!t.backward })) : [];
  return {
    ...out,
    vendor: camelize(vendor),
    products: camelize(products),
    hosts: camelize(hostRows),
    placements: camelize(placements),
    tasks: (tasks as { status: string; planned_end: string | null }[]).map((t) => ({ ...camelize<Record<string, unknown>>(t), overdue: isOverdue(t, today) })),
    allowedTransitions: allowed,
    ...extra,
  };
}

// ---------------- 更新（非日期欄位） ----------------
export const campaignUpdateSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: optText(3000),
  campaignType: optText(40),
  ownerUserId: z.string().optional(),
  targetRevenue: money.nullable().optional(),
  internalNote: optText(3000),
  version: z.number().int().optional(),
}).strict();

export async function updateCampaign(actor: Actor, id: string, raw: z.input<typeof campaignUpdateSchema>) {
  requirePerm(actor, 'campaign.write');
  const input = campaignUpdateSchema.parse(raw);
  if (input.targetRevenue !== undefined && !can(actor, 'campaign.sensitive.read')) throw forbidden('沒有修改檔期目標的權限');
  return withTx(async (tx) => {
    const c = await loadScoped(actor, id, tx, true);
    if (['CANCELLED', 'CLOSED'].includes(c['status'] as string)) throw new AppError('PRECONDITION_FAILED', '已取消或結案的檔期不可修改');
    if (input.ownerUserId) {
      const u = await tx.query(`SELECT role_key FROM users WHERE id=$1 AND organization_id=$2 AND status='ACTIVE' AND deleted_at IS NULL`, [input.ownerUserId, actor.orgId]);
      if (!u.rowCount || !['SYSTEM_ADMIN', 'OPS_MANAGER', 'OPS_EDITOR'].includes(u.rows[0].role_key)) throw validation('檔期負責人必須是營運人員');
    }
    try {
      const { after } = await patchEntity(tx, actor, {
        table: 'campaigns', entityType: 'campaign', id, patch: input as Record<string, unknown>,
        allowed: ['title', 'description', 'campaignType', 'ownerUserId', 'targetRevenue', 'internalNote'], expectedVersion: input.version,
        campaignId: () => id, derived: (m) => ({ normalized_title: normalizeName(String(m['title'])) }),
      });
      return { id, version: after['version'] };
    } catch (e) {
      return await raiseIfDuplicate(e, tx, actor, String(c['vendor_id']), input.title ?? String(c['title']), c['open_date'] as string | null);
    }
  });
}

// ---------------- 日期／參數調整：先預覽、確認後才套用 ----------------
export const rescheduleSchema = z.object({
  openDate: isoDate.nullable().optional(),
  closeDate: isoDate.nullable().optional(),
  sampleReadyDate: isoDate.nullable().optional(),
  liveTalkDate: isoDate.nullable().optional(),
  needsSampleRecovery: z.boolean().optional(),
  params: z.record(z.number().int().min(1).max(365)).optional(),
  reason: z.string().trim().max(500).optional(),
}).strict();
type RescheduleInput = z.infer<typeof rescheduleSchema>;

interface ReschedulePlan {
  changes: Record<string, { before: unknown; after: unknown }>;
  rows: ReturnType<typeof previewReschedule>;
  conflicts: Conflict[];
  requiresReason: boolean;
  token: string;
  next: ReturnType<typeof toInputs>;
  params: Params;
  campaignVersion: number;
}

async function buildPlan(tx: Tx, actor: Actor, id: string, input: RescheduleInput): Promise<{ plan: ReschedulePlan; campaign: Record<string, unknown> }> {
  const c = await loadScoped(actor, id, tx, true);
  const status = c['status'] as CampaignStatus;
  if (['CANCELLED', 'CLOSED', 'ON_HOLD', 'SETTLED'].includes(status)) throw new AppError('PRECONDITION_FAILED', '此檔期狀態不可調整日期');
  const cur = toInputs(c);
  const next = { ...cur };
  const changes: ReschedulePlan['changes'] = {};
  const mapField: [keyof RescheduleInput, keyof typeof cur][] = [
    ['openDate', 'open_date'], ['closeDate', 'close_date'], ['sampleReadyDate', 'sample_ready_date'], ['liveTalkDate', 'live_talk_date'],
  ];
  for (const [k, f] of mapField) {
    if (input[k] === undefined) continue;
    const v = (input[k] as string | null) ?? null;
    if (v !== cur[f]) { changes[k] = { before: cur[f], after: v }; (next as Record<string, unknown>)[f] = v; }
  }
  if (input.needsSampleRecovery !== undefined && input.needsSampleRecovery !== cur.needs_sample_recovery) {
    changes['needsSampleRecovery'] = { before: cur.needs_sample_recovery, after: input.needsSampleRecovery };
    next.needs_sample_recovery = input.needsSampleRecovery;
  }
  validateCampaignDates({ openDate: next.open_date, closeDate: next.close_date, sampleReadyDate: next.sample_ready_date, liveTalkDate: next.live_talk_date });

  const tpl = await loadTemplate(tx, actor.orgId, c['workflow_template_id'] as string);
  const baseParams: Params = { ...tpl.params, ...(c['workflow_params'] as Params) };
  const params: Params = { ...baseParams, ...(input.params ?? {}) };
  for (const [k, v] of Object.entries(input.params ?? {})) {
    if (!(k in tpl.params)) throw validation(`未知的天數參數：${k}`);
    if (v !== baseParams[k]) changes[`params.${k}`] = { before: baseParams[k], after: v };
  }
  const taskRows = await tx.query('SELECT * FROM tasks WHERE campaign_id=$1', [id]);
  const existing: ExistingTask[] = taskRows.rows.map((t) => ({
    stepKey: t.step_key, name: t.name, status: t.status, plannedStart: t.planned_start, plannedEnd: t.planned_end, dateLocked: t.date_locked,
  }));
  const rows = previewReschedule(tpl.steps, existing, next, params, { campaign: cur, params: baseParams });

  const fixedStatuses: CampaignStatus[] = ['SCHEDULED', 'RUNNING', 'PENDING_CLOSE_CHECK', 'FULFILLING', 'PENDING_SETTLEMENT', 'PENDING_G2'];
  const requiresReason = fixedStatuses.includes(status);
  if (['RUNNING', 'PENDING_CLOSE_CHECK', 'FULFILLING', 'PENDING_SETTLEMENT'].includes(status) && 'openDate' in changes) {
    throw new AppError('PRECONDITION_FAILED', '檔期已開始，不可更改開團日');
  }
  // 預覽用衝突：暫時以新日期偵測（不寫入）
  const conflicts = await detectConflictsWithDates(tx, actor.orgId, id, next.open_date, next.close_date);
  const token = crypto.createHash('sha256').update(JSON.stringify({ v: c['version'], changes, rows: rows.map((r) => [r.stepKey, r.after, r.effect]) })).digest('hex').slice(0, 32);
  return { plan: { changes, rows, conflicts, requiresReason, token, next, params, campaignVersion: c['version'] as number }, campaign: c };
}

async function detectConflictsWithDates(tx: Tx, orgId: string, id: string, open: string | null, close: string | null): Promise<Conflict[]> {
  // 在同一交易內暫時改日期偵測後 rollback 到 savepoint，避免影響資料
  await tx.query('SAVEPOINT conflict_probe');
  try {
    await tx.query('UPDATE campaigns SET open_date=$2, close_date=$3 WHERE id=$1', [id, open, close]);
    return await detectConflicts(tx, orgId, id);
  } finally {
    await tx.query('ROLLBACK TO SAVEPOINT conflict_probe');
  }
}

export async function previewCampaignReschedule(actor: Actor, id: string, raw: z.input<typeof rescheduleSchema>) {
  requirePerm(actor, 'campaign.write');
  const input = rescheduleSchema.parse(raw);
  return withTx(async (tx) => {
    const { plan } = await buildPlan(tx, actor, id, input);
    const affected = plan.rows.filter((r) => r.effect !== 'unchanged');
    return {
      token: plan.token, changes: plan.changes, requiresReason: plan.requiresReason, rows: plan.rows, affectedCount: affected.length,
      blockedByLock: plan.rows.filter((r) => r.effect === 'blocked_by_lock').map((r) => r.stepKey), conflicts: plan.conflicts,
    };
  });
}

export async function applyCampaignReschedule(actor: Actor, id: string, raw: z.input<typeof rescheduleSchema>, token: string) {
  requirePerm(actor, 'campaign.write');
  const input = rescheduleSchema.parse(raw);
  if (!token) throw validation('請先預覽日期變更影響，並帶入預覽代碼（token）後再確認');
  return withTx(async (tx) => {
    const { plan, campaign } = await buildPlan(tx, actor, id, input);
    if (plan.token !== token) throw new AppError('PRECONDITION_FAILED', '檔期或任務在預覽後已有變動，請重新預覽');
    if (!Object.keys(plan.changes).length) return { id, unchanged: true, updatedTasks: 0 };
    const status = campaign['status'] as CampaignStatus;
    if (plan.requiresReason) {
      if (!input.reason) throw validation('此狀態下調整日期需填寫原因');
      if (!can(actor, 'campaign.transition') || !['SYSTEM_ADMIN', 'OPS_MANAGER'].includes(actor.role)) throw forbidden('已排程或進行中的檔期，只有營運主管／管理者可以調整日期');
    }
    const highConflicts = plan.conflicts.filter((x) => x.severity === 'HIGH');
    if (highConflicts.length && ['SCHEDULED', 'RUNNING'].includes(status) && !input.reason) throw validation('新日期與其他檔期衝突，需填寫原因');

    await tx.query(
      `UPDATE campaigns SET open_date=$2, close_date=$3, sample_ready_date=$4, live_talk_date=$5, needs_sample_recovery=$6, workflow_params=$7, updated_by=$8 WHERE id=$1`,
      [id, plan.next.open_date, plan.next.close_date, plan.next.sample_ready_date, plan.next.live_talk_date, plan.next.needs_sample_recovery,
        JSON.stringify({ ...(campaign['workflow_params'] as object), ...(input.params ?? {}) }), actor.userId]);

    let updated = 0;
    const tasks = await tx.query('SELECT id, step_key, status FROM tasks WHERE campaign_id=$1', [id]);
    const byKey = new Map(tasks.rows.map((t) => [t.step_key as string, t]));
    for (const r of plan.rows) {
      const t = byKey.get(r.stepKey);
      if (!t) continue;
      if (r.effect === 'changed') {
        await tx.query('UPDATE tasks SET planned_start=$2, planned_end=$3, schedule_issue=$4, updated_by=$5 WHERE id=$1', [t.id, r.after.start, r.after.end, r.issue, actor.userId]);
        updated++;
      } else if (r.effect === 'newly_applicable') {
        await tx.query(`UPDATE tasks SET status='TODO', skip_reason=NULL, planned_start=$2, planned_end=$3, schedule_issue=$4, updated_by=$5 WHERE id=$1`, [t.id, r.after.start, r.after.end, r.issue, actor.userId]);
        updated++;
      } else if (r.effect === 'no_longer_applicable' && t.status === 'TODO') {
        await tx.query(`UPDATE tasks SET status='SKIPPED', skip_reason='條件不成立（選擇性步驟）', planned_start=NULL, planned_end=NULL, schedule_issue=NULL, updated_by=$2 WHERE id=$1`, [t.id, actor.userId]);
        updated++;
      } else if (r.effect === 'unchanged' && !r.locked) {
        await tx.query('UPDATE tasks SET schedule_issue=$2 WHERE id=$1 AND schedule_issue IS DISTINCT FROM $2', [t.id, r.issue]);
      }
    }
    await audit(tx, actor, { action: 'campaign.reschedule', entityType: 'campaign', entityId: id, campaignId: id,
      before: Object.fromEntries(Object.entries(plan.changes).map(([k, v]) => [k, v.before])),
      after: { ...Object.fromEntries(Object.entries(plan.changes).map(([k, v]) => [k, v.after])), updatedTasks: updated, lockedUntouched: plan.rows.filter((r) => r.effect === 'blocked_by_lock').map((r) => r.stepKey) },
      reason: input.reason ?? null });
    await emitEvent(tx, actor, 'campaign.dates_changed', 'campaign', id, { changes: Object.keys(plan.changes), updatedTasks: updated }, `campaign.dates_changed:${id}:${plan.token}`);
    if (requiresPostApprovalFlag(status)) {
      await tx.query(
        `INSERT INTO exceptions (id, organization_id, type, severity, entity_type, entity_id, campaign_id, title, detail, dedupe_key)
         VALUES ($1,$2,'SCHEDULE_CHANGED_AFTER_APPROVAL','MEDIUM','campaign',$3,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [await ids.exception(tx), actor.orgId, id, '核准後調整了檔期日期', input.reason ?? '', `schedule_changed:${id}:${plan.token}`]);
    }
    return { id, updatedTasks: updated, lockedUntouched: plan.rows.filter((r) => r.effect === 'blocked_by_lock').map((r) => r.stepKey) };
  });
}
const requiresPostApprovalFlag = (s: CampaignStatus) => ['SCHEDULED', 'PENDING_G2', 'RUNNING'].includes(s);

// ---------------- 檔期商品／團主／曝光安排 ----------------
const EDITABLE_PRODUCT_STATUSES: CampaignStatus[] = ['DRAFT', 'EVALUATING', 'PREPARING'];
const EDITABLE_HOST_STATUSES: CampaignStatus[] = ['DRAFT', 'EVALUATING', 'PREPARING', 'PENDING_G1', 'PENDING_G2', 'SCHEDULED'];

async function lockForEdit(tx: Tx, actor: Actor, id: string, allowed: CampaignStatus[], what: string) {
  const c = await loadScoped(actor, id, tx, true);
  if (!allowed.includes(c['status'] as CampaignStatus)) throw new AppError('PRECONDITION_FAILED', `檔期目前狀態（${c['status']}）不可異動${what}`);
  return c;
}

export async function addCampaignProduct(actor: Actor, campaignId: string, raw: { productId: string; skuId?: string; campaignPrice?: number; limitQty?: number; note?: string }) {
  requirePerm(actor, 'campaign.write');
  const p = z.object({ productId: z.string(), skuId: z.string().optional(), campaignPrice: money.optional(), limitQty: z.number().int().min(0).optional(), note: optText(300) }).parse(raw);
  return withTx(async (tx) => {
    const c = await lockForEdit(tx, actor, campaignId, EDITABLE_PRODUCT_STATUSES, '商品');
    return { id: await insertCampaignProduct(tx, actor, campaignId, String(c['vendor_id']), p) };
  });
}

export async function updateCampaignProduct(actor: Actor, campaignId: string, cpId: string, raw: { campaignPrice?: number | null; limitQty?: number | null; note?: string }) {
  requirePerm(actor, 'campaign.write');
  const p = z.object({ campaignPrice: money.nullable().optional(), limitQty: z.number().int().min(0).nullable().optional(), note: optText(300) }).parse(raw);
  return withTx(async (tx) => {
    await lockForEdit(tx, actor, campaignId, EDITABLE_PRODUCT_STATUSES, '商品');
    const { after } = await patchEntity(tx, actor, { table: 'campaign_products', entityType: 'campaign_product', id: cpId, patch: p, allowed: ['campaignPrice', 'limitQty', 'note'], campaignId: () => campaignId });
    return { id: cpId, version: after['version'] };
  });
}

export async function removeCampaignProduct(actor: Actor, campaignId: string, cpId: string) {
  requirePerm(actor, 'campaign.write');
  return withTx(async (tx) => {
    await lockForEdit(tx, actor, campaignId, EDITABLE_PRODUCT_STATUSES, '商品');
    const r = await tx.query('UPDATE campaign_products SET deleted_at=now(), updated_by=$4 WHERE id=$1 AND campaign_id=$2 AND organization_id=$3 AND deleted_at IS NULL RETURNING product_id, sku_id', [cpId, campaignId, actor.orgId, actor.userId]);
    if (!r.rowCount) throw notFound('檔期商品');
    await audit(tx, actor, { action: 'campaign_product.remove', entityType: 'campaign_product', entityId: cpId, campaignId, before: r.rows[0] });
    return { id: cpId };
  });
}

export async function addCampaignHost(actor: Actor, campaignId: string, raw: { hostId: string; role?: 'PRIMARY' | 'CO'; targetRevenue?: number }) {
  requirePerm(actor, 'campaign.write');
  const h = z.object({ hostId: z.string(), role: z.enum(['PRIMARY', 'CO']).optional(), targetRevenue: money.optional() }).parse(raw);
  if (h.targetRevenue != null && !can(actor, 'campaign.sensitive.read')) throw forbidden('沒有設定團主目標的權限');
  return withTx(async (tx) => {
    await lockForEdit(tx, actor, campaignId, EDITABLE_HOST_STATUSES, '團主');
    return { id: await insertCampaignHost(tx, actor, campaignId, h) };
  });
}

export async function removeCampaignHost(actor: Actor, campaignId: string, hostId: string, reason: string) {
  requirePerm(actor, 'campaign.write');
  if (!reason?.trim()) throw validation('請填寫移除原因');
  return withTx(async (tx) => {
    await lockForEdit(tx, actor, campaignId, EDITABLE_HOST_STATUSES, '團主');
    const pl = await tx.query(`SELECT count(*)::int AS n FROM campaign_placements WHERE campaign_id=$1 AND host_id=$2 AND deleted_at IS NULL AND status='PLANNED'`, [campaignId, hostId]);
    if (pl.rows[0].n > 0) throw new AppError('PRECONDITION_FAILED', `此團主在本檔期仍有 ${pl.rows[0].n} 筆未完成的曝光安排，請先取消`);
    const r = await tx.query('UPDATE campaign_hosts SET deleted_at=now(), updated_by=$4 WHERE campaign_id=$1 AND host_id=$2 AND organization_id=$3 AND deleted_at IS NULL RETURNING id', [campaignId, hostId, actor.orgId, actor.userId]);
    if (!r.rowCount) throw notFound('檔期團主');
    await audit(tx, actor, { action: 'campaign_host.remove', entityType: 'campaign_host', entityId: r.rows[0].id, campaignId, before: { hostId }, reason });
    return { id: r.rows[0].id };
  });
}

/** 團主回覆（確認／婉拒）：團主本人可回覆自己的邀請；營運人員可代為登記 */
export async function setCampaignHostStatus(actor: Actor, campaignId: string, hostId: string, status: 'CONFIRMED' | 'DECLINED' | 'NO_RESPONSE', note?: string) {
  if (actor.role === 'HOST') {
    if (!actor.hostIds.includes(hostId)) throw forbidden();
    if (status === 'NO_RESPONSE') throw forbidden();
  } else requirePerm(actor, 'campaign.write');
  if (status === 'DECLINED' && !note?.trim()) throw validation('婉拒需填寫原因');
  return withTx(async (tx) => {
    const c = await loadScoped(actor, campaignId, tx, true);
    if (['CANCELLED', 'CLOSED', 'ON_HOLD'].includes(c['status'] as string)) throw new AppError('PRECONDITION_FAILED', '此檔期狀態不可回覆');
    const cur = await tx.query('SELECT id, status FROM campaign_hosts WHERE campaign_id=$1 AND host_id=$2 AND organization_id=$3 AND deleted_at IS NULL FOR UPDATE', [campaignId, hostId, actor.orgId]);
    if (!cur.rowCount) throw notFound('檔期團主');
    await tx.query('UPDATE campaign_hosts SET status=$2, responded_at=CASE WHEN $2 IN (\'CONFIRMED\',\'DECLINED\') THEN now() ELSE responded_at END, note=COALESCE($3, note), updated_by=$4 WHERE id=$1',
      [cur.rows[0].id, status, note ?? null, actor.userId]);
    await audit(tx, actor, { action: 'campaign_host.respond', entityType: 'campaign_host', entityId: cur.rows[0].id, campaignId, before: { status: cur.rows[0].status }, after: { status }, reason: note ?? null });
    if (status !== 'NO_RESPONSE') {
      await tx.query(`UPDATE exceptions SET status='RESOLVED', resolved_at=now(), resolution_note='團主已回覆' WHERE organization_id=$1 AND dedupe_key=$2 AND status<>'RESOLVED'`, [actor.orgId, `host_no_response:${campaignId}:${hostId}`]);
    }
    return { campaignId, hostId, status };
  });
}

export const placementSchema = z.object({
  hostId: z.string(),
  communityId: z.string(),
  placementType: z.enum(['LAUNCH', 'POST', 'STORY', 'LIVE_TALK', 'TOPIC', 'REMINDER']),
  scheduledOn: isoDate,
  scheduledTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '時間格式需為 HH:MM').optional(),
  contentRef: optText(500),
  note: optText(500),
});

export async function addPlacement(actor: Actor, campaignId: string, raw: z.input<typeof placementSchema>) {
  requirePerm(actor, 'campaign.write');
  const p = placementSchema.parse(raw);
  return withTx(async (tx) => {
    const c = await lockForEdit(tx, actor, campaignId, [...EDITABLE_HOST_STATUSES, 'RUNNING'], '曝光安排');
    const ch = await tx.query(`SELECT status FROM campaign_hosts WHERE campaign_id=$1 AND host_id=$2 AND deleted_at IS NULL`, [campaignId, p.hostId]);
    if (!ch.rowCount) throw validation('該團主不在此檔期內，請先加入檔期團主');
    if (ch.rows[0].status === 'DECLINED') throw new AppError('PRECONDITION_FAILED', '該團主已婉拒此檔期');
    const link = await tx.query('SELECT 1 FROM host_communities WHERE host_id=$1 AND community_id=$2 AND ended_at IS NULL', [p.hostId, p.communityId]);
    if (!link.rowCount) throw validation('該社群不屬於此團主（請先在社群管理建立團主與社群的關聯）');
    const open = c['open_date'] as string | null, close = c['close_date'] as string | null;
    if ((open && p.scheduledOn < open) || (close && p.scheduledOn > close)) throw validation(`曝光日期需落在檔期區間內（${open ?? '?'} ～ ${close ?? '?'}）`);
    const dupe = await tx.query(
      `SELECT id FROM campaign_placements WHERE campaign_id=$1 AND host_id=$2 AND community_id=$3 AND placement_type=$4 AND scheduled_on=$5 AND deleted_at IS NULL AND status<>'CANCELLED'`,
      [campaignId, p.hostId, p.communityId, p.placementType, p.scheduledOn]);
    if (dupe.rowCount) throw new AppError('CONFLICT', `相同的曝光安排已存在：${dupe.rows[0].id}`, { existingId: dupe.rows[0].id });
    const id = await ids.placement(tx);
    await tx.query(
      `INSERT INTO campaign_placements (id, organization_id, campaign_id, host_id, community_id, placement_type, scheduled_on, scheduled_time, content_ref, note, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
      [id, actor.orgId, campaignId, p.hostId, p.communityId, p.placementType, p.scheduledOn, p.scheduledTime ?? null, p.contentRef ?? null, p.note ?? null, actor.userId]);
    await audit(tx, actor, { action: 'placement.create', entityType: 'placement', entityId: id, campaignId, after: p });
    const conflicts = await detectConflicts(tx, actor.orgId, campaignId);
    return { id, conflicts };
  });
}

export async function setPlacementStatus(actor: Actor, campaignId: string, placementId: string, status: 'PLANNED' | 'DONE' | 'MISSED' | 'CANCELLED', note?: string) {
  requirePerm(actor, 'campaign.write');
  if ((status === 'MISSED' || status === 'CANCELLED') && !note?.trim()) throw validation('此操作需填寫原因');
  return withTx(async (tx) => {
    await loadScoped(actor, campaignId, tx, true);
    const cur = await tx.query('SELECT status FROM campaign_placements WHERE id=$1 AND campaign_id=$2 AND organization_id=$3 AND deleted_at IS NULL FOR UPDATE', [placementId, campaignId, actor.orgId]);
    if (!cur.rowCount) throw notFound('曝光安排');
    await tx.query('UPDATE campaign_placements SET status=$2, actual_at=CASE WHEN $2=\'DONE\' THEN now() ELSE NULL END, note=COALESCE($3, note), updated_by=$4 WHERE id=$1', [placementId, status, note ?? null, actor.userId]);
    await audit(tx, actor, { action: 'placement.status', entityType: 'placement', entityId: placementId, campaignId, before: { status: cur.rows[0].status }, after: { status }, reason: note ?? null });
    return { id: placementId, status };
  });
}

export { CAMPAIGN_STATUSES };
