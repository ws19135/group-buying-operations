import { z } from 'zod';
import type { Tx } from '../lib/db';
import { query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { INTERNAL_ROLES, isInternal, requirePerm } from '../lib/permissions';
import { AppError, forbidden, notFound, precondition, validation } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids, todayTaipei } from '../lib/ids';
import { camelize } from '../lib/case';
import { isIsoDate } from '../lib/dates';
import { nonEmpty } from '../lib/text';
import { applyClears, likePattern, listPaged, pageParams, patchEntity } from '../lib/repo';
import { campaignScope } from '../lib/scope';
import { idempotent } from '../lib/idempotency';
import { queueNotification } from './notifications';

export const CASE_TYPES = ['REFUND', 'COMPLAINT', 'EXCHANGE', 'OTHER'] as const;
export const CASE_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_VENDOR', 'RESOLVED', 'CLOSED', 'CANCELLED'] as const;
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const REFUND_STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'COMPLETED'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** 還在處理中的案件狀態（會計入逾期、可編輯） */
export const ACTIVE_CASE_STATUSES: CaseStatus[] = ['OPEN', 'IN_PROGRESS', 'WAITING_VENDOR'];

/** 案件狀態轉移。RESOLVED → IN_PROGRESS 視為「重新開啟」，必須填原因。CLOSED／CANCELLED 為終態 */
export const CASE_TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  OPEN: ['IN_PROGRESS', 'WAITING_VENDOR', 'RESOLVED', 'CANCELLED'],
  IN_PROGRESS: ['WAITING_VENDOR', 'RESOLVED', 'CANCELLED'],
  WAITING_VENDOR: ['IN_PROGRESS', 'RESOLVED', 'CANCELLED'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'],
  CLOSED: [],
  CANCELLED: [],
};

/** 外部角色（團主／廠商）看得到的案件欄位；不含描述、買家代號、訂單、負責人、內部備註 */
const EXTERNAL_FIELDS = ['id', 'campaignId', 'campaignTitle', 'caseType', 'status', 'priority', 'title', 'dueDate', 'resolution', 'createdAt', 'resolvedAt', 'closedAt', 'overdue'] as const;

const optText = (max: number) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));

/** 描述與備註不得放個資：偵測台灣手機號碼與 Email（盡力而為的防呆，不是完整的個資偵測） */
const PHONE_RE = /(?<![0-9])09\d{2}[-\s]?\d{3}[-\s]?\d{3}(?![0-9])/;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
export function containsPii(s: string | null | undefined): boolean {
  return !!s && (PHONE_RE.test(s) || EMAIL_RE.test(s));
}
function assertNoPii(fields: Record<string, string | null | undefined>) {
  for (const [label, v] of Object.entries(fields)) {
    if (containsPii(v)) throw validation(`「${label}」請勿填寫電話或 Email；買家只用去識別化代號（buyerRef）`);
  }
}

const isoDate = z.string().refine(isIsoDate, '日期格式需為 YYYY-MM-DD');

export const caseCreateSchema = z.object({
  campaignId: z.string().min(1, '請選擇檔期'),
  orderId: optText(40),
  caseType: z.enum(CASE_TYPES),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
  title: z.string().trim().min(1, '請輸入標題').max(120),
  description: optText(2000),
  buyerRef: optText(60),
  assigneeUserId: optText(40),
  dueDate: isoDate.optional().or(z.literal('').transform(() => undefined)),
  internalNote: optText(2000),
});

export const caseUpdateSchema = z.object({
  title: z.string().trim().min(1, '請輸入標題').max(120).optional(),
  description: optText(2000),
  priority: z.enum(PRIORITIES).optional(),
  buyerRef: optText(60),
  assigneeUserId: optText(40),
  dueDate: isoDate.optional().or(z.literal('').transform(() => undefined)),
  internalNote: optText(2000),
  resolution: optText(2000),
  version: z.number().int().optional(),
});
const CASE_UPDATE_FIELDS = ['title', 'description', 'priority', 'buyerRef', 'assigneeUserId', 'dueDate', 'internalNote', 'resolution'] as const;
const CASE_CLEARABLE = ['description', 'buyerRef', 'assigneeUserId', 'dueDate', 'internalNote', 'resolution'] as const;

async function logEvent(tx: Tx, actor: Actor, caseId: string, type: string, o: { from?: string | null; to?: string | null; note?: string | null; internal?: boolean } = {}) {
  await tx.query(
    `INSERT INTO case_events (organization_id, case_id, event_type, from_status, to_status, note, is_internal, actor_user_id, actor_role)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [actor.orgId, caseId, type, o.from ?? null, o.to ?? null, o.note ?? null, o.internal ?? true, actor.userId, actor.role]);
}

/** 載入案件並套用檔期資料範圍；範圍外一律回報「找不到」（不洩漏存在與否） */
async function loadCaseScoped(tx: Tx, actor: Actor, id: string, lock = false) {
  const sc = campaignScope(actor, 2, 'c');
  if (sc.sql === 'FALSE') throw notFound('售後案件');
  const r = await tx.query(
    `SELECT s.*, c.title AS campaign_title FROM service_cases s JOIN campaigns c ON c.id=s.campaign_id
     WHERE s.id=$1 AND s.organization_id=$2 AND (${sc.sql}) ${lock ? 'FOR UPDATE OF s' : ''}`, [id, ...sc.params]);
  if (!r.rowCount) throw notFound('售後案件');
  return r.rows[0] as Record<string, unknown>;
}

async function assertAssignable(tx: Tx, actor: Actor, userId: string) {
  const r = await tx.query(`SELECT 1 FROM users WHERE id=$1 AND organization_id=$2 AND status='ACTIVE' AND deleted_at IS NULL AND role_key = ANY($3::text[])`, [userId, actor.orgId, INTERNAL_ROLES]);
  if (!r.rowCount) throw validation('負責人需為啟用中的內部使用者');
}

async function notifyAssignee(tx: Tx, actor: Actor, caseId: string, title: string, assignee: string | null) {
  if (!assignee || assignee === actor.userId) return;
  await queueNotification(tx, actor.orgId, {
    recipientUserId: assignee, subject: `售後案件指派給你：${title}`, body: `案件 ${caseId} 已指派給你，請至「售後」查看。`,
    entityType: 'service_case', entityId: caseId, dedupeKey: `case:${caseId}:assigned:${assignee}`,
  });
}

function withOverdue<T extends Record<string, unknown>>(row: T, today = todayTaipei()): T & { overdue: boolean } {
  const due = (row['dueDate'] ?? row['due_date']) as string | null | undefined;
  const st = row['status'] as CaseStatus;
  return { ...row, overdue: !!due && ACTIVE_CASE_STATUSES.includes(st) && due < today };
}

function projectCase(actor: Actor, row: Record<string, unknown>): Record<string, unknown> {
  if (isInternal(actor)) return row;
  const out: Record<string, unknown> = {};
  for (const k of EXTERNAL_FIELDS) if (k in row) out[k] = row[k];
  return out;
}

// ---------- 建立／查詢／更新 ----------

export async function createCase(actor: Actor, raw: z.input<typeof caseCreateSchema>, idemKey?: string | null) {
  requirePerm(actor, 'aftersales.write');
  const input = caseCreateSchema.parse(raw);
  assertNoPii({ 標題: input.title, 描述: input.description, 內部備註: input.internalNote });
  return withTx(async (tx) => {
    const { result, replayed } = await idempotent(tx, actor, 'aftersales.case.create', idemKey, async () => {
      const sc = campaignScope(actor, 2, 'c');
      if (sc.sql === 'FALSE') throw notFound('檔期');
      const camp = await tx.query(`SELECT c.id FROM campaigns c WHERE c.id=$1 AND (${sc.sql})`, [input.campaignId, ...sc.params]);
      if (!camp.rowCount) throw notFound('檔期');
      let buyerRef = input.buyerRef ?? null;
      if (input.orderId) {
        const o = await tx.query('SELECT campaign_id, buyer_ref FROM orders WHERE id=$1 AND organization_id=$2', [input.orderId, actor.orgId]);
        if (!o.rowCount) throw notFound('訂單');
        if (o.rows[0].campaign_id !== input.campaignId) throw validation('訂單不屬於所選檔期');
        buyerRef = buyerRef ?? o.rows[0].buyer_ref ?? null;
      }
      if (input.assigneeUserId) await assertAssignable(tx, actor, input.assigneeUserId);
      const id = await ids.serviceCase(tx);
      await tx.query(
        `INSERT INTO service_cases (id, organization_id, campaign_id, order_id, case_type, priority, title, description, buyer_ref, assignee_user_id, due_date, internal_note, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
        [id, actor.orgId, input.campaignId, input.orderId ?? null, input.caseType, input.priority, input.title, input.description ?? null, buyerRef,
          input.assigneeUserId ?? null, input.dueDate ?? null, input.internalNote ?? null, actor.userId]);
      await logEvent(tx, actor, id, 'CREATED', { to: 'OPEN', note: input.title });
      await audit(tx, actor, { action: 'service_case.create', entityType: 'service_case', entityId: id, campaignId: input.campaignId, after: { caseType: input.caseType, priority: input.priority, title: input.title, orderId: input.orderId ?? null, assigneeUserId: input.assigneeUserId ?? null } });
      await notifyAssignee(tx, actor, id, input.title, input.assigneeUserId ?? null);
      return { id };
    }, input);
    return { ...result, replayed };
  });
}

export async function listCases(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'aftersales.read');
  const sc = campaignScope(actor, 1, 'c');
  if (sc.sql === 'FALSE') return { items: [], total: 0, limit: 50, offset: 0 };
  const params: unknown[] = [...sc.params];
  const where = [`(${sc.sql})`];
  const add = (cond: (n: number) => string, v: unknown) => { params.push(v); where.push(cond(params.length)); };
  const st = nonEmpty(q.get('status'));
  if (st === 'ACTIVE') where.push(`s.status IN ('OPEN','IN_PROGRESS','WAITING_VENDOR')`);
  else if (st && (CASE_STATUSES as readonly string[]).includes(st)) add((n) => `s.status=$${n}`, st);
  const ty = nonEmpty(q.get('caseType')); if (ty && (CASE_TYPES as readonly string[]).includes(ty)) add((n) => `s.case_type=$${n}`, ty);
  const pr = nonEmpty(q.get('priority')); if (pr && (PRIORITIES as readonly string[]).includes(pr)) add((n) => `s.priority=$${n}`, pr);
  const cid = nonEmpty(q.get('campaignId')); if (cid) add((n) => `s.campaign_id=$${n}`, cid);
  const oid = nonEmpty(q.get('orderId')); if (oid) add((n) => `s.order_id=$${n}`, oid);
  if (q.get('mine') === '1') add((n) => `s.assignee_user_id=$${n}`, actor.userId);
  if (q.get('overdue') === '1') add((n) => `s.status IN ('OPEN','IN_PROGRESS','WAITING_VENDOR') AND s.due_date < $${n}::date`, todayTaipei());
  const text = nonEmpty(q.get('q')); if (text) add((n) => `(s.title ILIKE $${n} OR s.id ILIKE $${n})`, likePattern(text));
  where.push('s.organization_id=$1');
  const res = await listPaged<Record<string, unknown>>(
    `SELECT s.id, s.campaign_id, c.title AS campaign_title, s.order_id, s.case_type, s.status, s.priority, s.title, s.buyer_ref,
       s.assignee_user_id, u.name AS assignee_name, s.due_date, s.resolution, s.created_at, s.resolved_at, s.closed_at, s.version,
       (SELECT count(*)::int FROM refund_requests r WHERE r.case_id=s.id AND r.status IN ('REQUESTED','APPROVED')) AS open_refunds
     FROM service_cases s JOIN campaigns c ON c.id=s.campaign_id LEFT JOIN users u ON u.id=s.assignee_user_id
     WHERE ${where.join(' AND ')}`, params,
    `CASE s.priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, s.due_date ASC NULLS LAST, s.created_at DESC`, pageParams(q));
  const today = todayTaipei();
  return { ...res, items: res.items.map((r) => projectCase(actor, withOverdue(camelize<Record<string, unknown>>(r), today))) };
}

export async function getCase(actor: Actor, id: string) {
  requirePerm(actor, 'aftersales.read');
  const row = await withTx(async (tx) => loadCaseScoped(tx, actor, id));
  const c = withOverdue(camelize<Record<string, unknown>>(row));
  const internal = isInternal(actor);
  const events = camelize(await query(
    `SELECT e.id, e.event_type, e.from_status, e.to_status, e.note, e.is_internal, e.actor_role, e.created_at, u.name AS actor_name
     FROM case_events e LEFT JOIN users u ON u.id=e.actor_user_id
     WHERE e.case_id=$1 ${internal ? '' : 'AND e.is_internal=false'} ORDER BY e.id`, [id]));
  if (!internal) return { ...projectCase(actor, c), events };
  const refunds = camelize(await query(
    `SELECT r.*, d.name AS decided_by_name, rq.name AS requested_by_name FROM refund_requests r
     LEFT JOIN users d ON d.id=r.decided_by LEFT JOIN users rq ON rq.id=r.requested_by WHERE r.case_id=$1 ORDER BY r.created_at`, [id]));
  const order = row['order_id']
    ? camelize((await query(`SELECT id, source_system, source_order_id, status, gross_amount, refund_amount, ordered_at FROM orders WHERE id=$1`, [row['order_id']]))[0] ?? null)
    : null;
  const assignee = row['assignee_user_id'] ? (await query<{ name: string }>('SELECT name FROM users WHERE id=$1', [row['assignee_user_id']]))[0]?.name ?? null : null;
  return { ...c, assigneeName: assignee, events, refunds, order };
}

export async function updateCase(actor: Actor, id: string, raw: z.input<typeof caseUpdateSchema>) {
  requirePerm(actor, 'aftersales.write');
  const parsed = caseUpdateSchema.parse(raw);
  const input = applyClears(parsed, raw, CASE_CLEARABLE);
  assertNoPii({ 標題: input.title, 描述: input.description, 內部備註: input.internalNote, 處理結果: input.resolution });
  return withTx(async (tx) => {
    const cur = await loadCaseScoped(tx, actor, id, true);
    if (!ACTIVE_CASE_STATUSES.includes(cur['status'] as CaseStatus) && cur['status'] !== 'RESOLVED') throw precondition('已結案或已取消的案件不可編輯');
    if (input.assigneeUserId) await assertAssignable(tx, actor, input.assigneeUserId);
    const { after, changed } = await patchEntity(tx, actor, {
      table: 'service_cases', entityType: 'service_case', id, patch: input as Record<string, unknown>, allowed: CASE_UPDATE_FIELDS,
      expectedVersion: input.version, campaignId: () => cur['campaign_id'] as string,
    });
    if (changed) {
      const assigneeChanged = (cur['assignee_user_id'] ?? null) !== (after['assignee_user_id'] ?? null);
      await logEvent(tx, actor, id, assigneeChanged ? 'ASSIGN' : 'UPDATE', { note: assigneeChanged ? `負責人變更` : '更新案件內容' });
      if (assigneeChanged) await notifyAssignee(tx, actor, id, String(after['title']), (after['assignee_user_id'] as string | null) ?? null);
    }
    return { id, version: after['version'] as number, changed };
  });
}

export const noteSchema = z.object({ note: z.string().trim().min(1, '請輸入內容').max(2000), public: z.boolean().optional() });

/** 新增處理紀錄（備註）。public=true 的備註團主／廠商看得到（僅限他們範圍內的案件），預設為內部 */
export async function addCaseNote(actor: Actor, id: string, raw: z.input<typeof noteSchema>) {
  requirePerm(actor, 'aftersales.write');
  const input = noteSchema.parse(raw);
  assertNoPii({ 備註: input.note });
  return withTx(async (tx) => {
    const cur = await loadCaseScoped(tx, actor, id, true);
    if (['CLOSED', 'CANCELLED'].includes(cur['status'] as string)) throw precondition('已結案或已取消的案件不可再新增紀錄');
    await logEvent(tx, actor, id, 'NOTE', { note: input.note, internal: !input.public });
    await audit(tx, actor, { action: 'service_case.note', entityType: 'service_case', entityId: id, campaignId: cur['campaign_id'] as string, after: { public: !!input.public } });
    return { id };
  });
}

export const statusSchema = z.object({
  to: z.enum(CASE_STATUSES),
  note: optText(1000),
  resolution: optText(2000),
  version: z.number().int().optional(),
});

export async function setCaseStatus(actor: Actor, id: string, raw: z.input<typeof statusSchema>) {
  requirePerm(actor, 'aftersales.write');
  const input = statusSchema.parse(raw);
  assertNoPii({ 說明: input.note, 處理結果: input.resolution });
  return withTx(async (tx) => {
    const cur = await loadCaseScoped(tx, actor, id, true);
    const from = cur['status'] as CaseStatus;
    if (input.version != null && input.version !== cur['version']) throw new AppError('CONFLICT', '資料已被其他人更新，請重新整理後再試', { currentVersion: cur['version'] });
    if (!CASE_TRANSITIONS[from].includes(input.to)) throw precondition(`不可從「${from}」變更為「${input.to}」`);
    const reopen = from === 'RESOLVED' && input.to === 'IN_PROGRESS';
    if ((input.to === 'CANCELLED' || reopen) && !input.note) throw validation(reopen ? '重新開啟案件請填寫原因' : '取消案件請填寫原因');
    if (['RESOLVED', 'CLOSED', 'CANCELLED'].includes(input.to)) {
      const pending = await tx.query(`SELECT count(*)::int AS n FROM refund_requests WHERE case_id=$1 AND status IN ('REQUESTED','APPROVED')`, [id]);
      if (pending.rows[0].n > 0) throw precondition('還有未完成的退款申請（待核准或待完成），請先處理退款再變更案件狀態');
    }
    const resolution = input.resolution ?? (cur['resolution'] as string | null);
    if (input.to === 'RESOLVED' && !nonEmpty(resolution)) throw validation('標記為已解決前，請填寫處理結果');
    const stamp = input.to === 'RESOLVED' ? ', resolved_at=now()' : input.to === 'CLOSED' ? ', closed_at=now()' : input.to === 'CANCELLED' ? ', cancelled_at=now()' : reopen ? ', resolved_at=NULL' : '';
    const upd = await tx.query(
      `UPDATE service_cases SET status=$3, resolution=$4, updated_by=$5${stamp} WHERE id=$1 AND organization_id=$2 RETURNING version`,
      [id, actor.orgId, input.to, input.to === 'RESOLVED' ? resolution : (cur['resolution'] ?? null), actor.userId]);
    await logEvent(tx, actor, id, 'STATUS', { from, to: input.to, note: input.note ?? null });
    await audit(tx, actor, { action: reopen ? 'service_case.reopen' : 'service_case.status', entityType: 'service_case', entityId: id, campaignId: cur['campaign_id'] as string, before: { status: from }, after: { status: input.to }, reason: input.note ?? null });
    return { id, status: input.to, version: upd.rows[0].version as number };
  });
}

// ---------- 退款申請 ----------

export const refundRequestSchema = z.object({
  amount: z.number().int('金額需為整數（TWD）').positive('金額需大於 0').max(100_000_000),
  reason: z.string().trim().min(1, '請填寫退款原因').max(500),
  orderId: optText(40),
});

const ORDER_REFUNDABLE = ['PAID', 'PARTIAL_REFUND'];

export async function requestRefund(actor: Actor, caseId: string, raw: z.input<typeof refundRequestSchema>, idemKey?: string | null) {
  requirePerm(actor, 'aftersales.write');
  const input = refundRequestSchema.parse(raw);
  assertNoPii({ 原因: input.reason });
  return withTx(async (tx) => {
    const { result, replayed } = await idempotent(tx, actor, 'aftersales.refund.request', idemKey, async () => {
      const c = await loadCaseScoped(tx, actor, caseId, true);
      if (!ACTIVE_CASE_STATUSES.includes(c['status'] as CaseStatus)) throw precondition('只有處理中的案件可以申請退款');
      const orderId = input.orderId ?? (c['order_id'] as string | null);
      if (orderId) {
        const o = await tx.query('SELECT * FROM orders WHERE id=$1 AND organization_id=$2 FOR UPDATE', [orderId, actor.orgId]);
        if (!o.rowCount) throw notFound('訂單');
        const ord = o.rows[0];
        if (ord.campaign_id !== c['campaign_id']) throw validation('訂單不屬於此案件的檔期');
        if (!ORDER_REFUNDABLE.includes(ord.status)) throw precondition(`此訂單狀態為「${ord.status}」，不可申請退款`);
        const active = await tx.query(`SELECT COALESCE(sum(amount),0)::bigint AS s FROM refund_requests WHERE order_id=$1 AND status IN ('REQUESTED','APPROVED')`, [orderId]);
        const remaining = Number(ord.gross_amount) - Number(ord.refund_amount) - Number(active.rows[0].s);
        if (input.amount > remaining) throw validation(`退款金額超過可退餘額（訂單金額 ${ord.gross_amount}、已退 ${ord.refund_amount}、其他申請中 ${active.rows[0].s}，剩餘 ${Math.max(remaining, 0)}）`);
      }
      const id = await ids.refundRequest(tx);
      await tx.query(
        `INSERT INTO refund_requests (id, organization_id, case_id, campaign_id, order_id, amount, reason, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, actor.orgId, caseId, c['campaign_id'], orderId, input.amount, input.reason, actor.userId]);
      await logEvent(tx, actor, caseId, 'REFUND_REQUESTED', { note: `申請退款 ${input.amount}：${input.reason}` });
      await audit(tx, actor, { action: 'refund.request', entityType: 'refund_request', entityId: id, campaignId: c['campaign_id'] as string, after: { caseId, orderId, amount: input.amount } });
      const approvers = await tx.query<{ id: string }>(`SELECT id FROM users WHERE organization_id=$1 AND status='ACTIVE' AND deleted_at IS NULL AND role_key IN ('OPS_MANAGER','SYSTEM_ADMIN')`, [actor.orgId]);
      for (const a of approvers.rows) {
        if (a.id === actor.userId) continue;
        await queueNotification(tx, actor.orgId, { recipientUserId: a.id, subject: `退款申請待核准：${input.amount}`, body: `案件 ${caseId} 有新的退款申請 ${id}，請至「售後」核准或退回。`, entityType: 'refund_request', entityId: id, dedupeKey: `refund:${id}:requested:${a.id}` });
      }
      return { id };
    }, { caseId, ...input });
    return { ...result, replayed };
  });
}

async function loadRefundScoped(tx: Tx, actor: Actor, id: string) {
  const sc = campaignScope(actor, 2, 'c');
  if (sc.sql === 'FALSE') throw notFound('退款申請');
  const r = await tx.query(
    `SELECT r.* FROM refund_requests r JOIN campaigns c ON c.id=r.campaign_id WHERE r.id=$1 AND r.organization_id=$2 AND (${sc.sql}) FOR UPDATE OF r`, [id, ...sc.params]);
  if (!r.rowCount) throw notFound('退款申請');
  return r.rows[0] as Record<string, unknown>;
}

export const refundDecisionSchema = z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: optText(500) });

export async function decideRefund(actor: Actor, id: string, raw: z.input<typeof refundDecisionSchema>) {
  requirePerm(actor, 'refund.approve');
  const input = refundDecisionSchema.parse(raw);
  assertNoPii({ 說明: input.note });
  if (input.decision === 'REJECTED' && !input.note) throw validation('退回退款申請請填寫原因');
  return withTx(async (tx) => {
    const r = await loadRefundScoped(tx, actor, id);
    if (r['status'] !== 'REQUESTED') throw precondition(`此申請目前為「${r['status']}」，不能再決定`);
    await tx.query(`UPDATE refund_requests SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1`, [id, input.decision, actor.userId, input.note ?? null]);
    const caseId = r['case_id'] as string;
    await logEvent(tx, actor, caseId, input.decision === 'APPROVED' ? 'REFUND_APPROVED' : 'REFUND_REJECTED', { note: input.note ?? null });
    await audit(tx, actor, { action: input.decision === 'APPROVED' ? 'refund.approve' : 'refund.reject', entityType: 'refund_request', entityId: id, campaignId: r['campaign_id'] as string, before: { status: 'REQUESTED' }, after: { status: input.decision }, reason: input.note ?? null });
    if (r['requested_by'] && r['requested_by'] !== actor.userId) {
      await queueNotification(tx, actor.orgId, { recipientUserId: r['requested_by'] as string, subject: `退款申請${input.decision === 'APPROVED' ? '已核准' : '已退回'}`, body: `退款申請 ${id}（案件 ${caseId}）${input.decision === 'APPROVED' ? '已核准，待財務完成' : '已退回'}。`, entityType: 'refund_request', entityId: id, dedupeKey: `refund:${id}:decided` });
    }
    return { id, status: input.decision };
  });
}

export const refundCompleteSchema = z.object({
  /** 是否把金額寫回 orders.refund_amount（並更新訂單狀態）。預設不寫回，避免重複計入（例如退款已由下次 CSV 匯入反映） */
  writeback: z.boolean().default(false),
  note: optText(500),
});

export async function completeRefund(actor: Actor, id: string, raw: z.input<typeof refundCompleteSchema> = {}) {
  requirePerm(actor, 'refund.complete');
  const input = refundCompleteSchema.parse(raw ?? {});
  assertNoPii({ 說明: input.note });
  return withTx(async (tx) => {
    const r = await loadRefundScoped(tx, actor, id);
    if (r['status'] !== 'APPROVED') throw precondition(`只有「已核准」的退款可以標記完成（目前為「${r['status']}」）`);
    const amount = Number(r['amount']);
    const orderId = r['order_id'] as string | null;
    let orderAfter: Record<string, unknown> | null = null;
    if (input.writeback) {
      if (!orderId) throw validation('此退款申請沒有關聯訂單，無法寫回訂單退款金額');
      const o = await tx.query('SELECT * FROM orders WHERE id=$1 AND organization_id=$2 FOR UPDATE', [orderId, actor.orgId]);
      if (!o.rowCount) throw notFound('訂單');
      const ord = o.rows[0];
      if (!ORDER_REFUNDABLE.includes(ord.status)) throw precondition(`此訂單狀態為「${ord.status}」，不可寫回退款`);
      const newRefund = Number(ord.refund_amount) + amount;
      if (newRefund > Number(ord.gross_amount)) throw validation(`寫回後累計退款 ${newRefund} 會超過訂單金額 ${ord.gross_amount}`);
      const newStatus = newRefund === Number(ord.gross_amount) ? 'REFUNDED' : 'PARTIAL_REFUND';
      const upd = await tx.query('UPDATE orders SET refund_amount=$2, status=$3 WHERE id=$1 RETURNING refund_amount, status', [orderId, newRefund, newStatus]);
      orderAfter = upd.rows[0];
      await audit(tx, actor, { action: 'order.refund_writeback', entityType: 'order', entityId: orderId, campaignId: ord.campaign_id,
        before: { refund_amount: Number(ord.refund_amount), status: ord.status }, after: { refund_amount: newRefund, status: newStatus }, reason: `退款申請 ${id}` });
    }
    await tx.query(
      `UPDATE refund_requests SET status='COMPLETED', completed_by=$2, completed_at=now(), completion_note=$3, writeback_applied=$4 WHERE id=$1`,
      [id, actor.userId, input.note ?? null, input.writeback]);
    const caseId = r['case_id'] as string;
    await logEvent(tx, actor, caseId, 'REFUND_COMPLETED', { note: `${amount}${input.writeback ? '（已寫回訂單）' : ''}${input.note ? `：${input.note}` : ''}` });
    await audit(tx, actor, { action: 'refund.complete', entityType: 'refund_request', entityId: id, campaignId: r['campaign_id'] as string, before: { status: 'APPROVED' }, after: { status: 'COMPLETED', writeback: input.writeback }, reason: input.note ?? null });
    return { id, status: 'COMPLETED', writebackApplied: input.writeback, order: orderAfter ? camelize(orderAfter) : null };
  });
}

export async function listRefunds(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'aftersales.read');
  if (!isInternal(actor)) throw forbidden();
  const sc = campaignScope(actor, 1, 'c');
  if (sc.sql === 'FALSE') return { items: [], total: 0, limit: 50, offset: 0 };
  const params: unknown[] = [...sc.params];
  const where = [`(${sc.sql})`, 'r.organization_id=$1'];
  const st = nonEmpty(q.get('status')); if (st && (REFUND_STATUSES as readonly string[]).includes(st)) { params.push(st); where.push(`r.status=$${params.length}`); }
  if (q.get('pending') === '1') where.push(`r.status IN ('REQUESTED','APPROVED')`);
  const cid = nonEmpty(q.get('caseId')); if (cid) { params.push(cid); where.push(`r.case_id=$${params.length}`); }
  const res = await listPaged<Record<string, unknown>>(
    `SELECT r.id, r.case_id, s.title AS case_title, r.campaign_id, c.title AS campaign_title, r.order_id, r.amount, r.reason, r.status,
       r.requested_by, rq.name AS requested_by_name, r.decided_by, r.decision_note, r.decided_at, r.completed_at, r.writeback_applied, r.created_at, r.version
     FROM refund_requests r JOIN campaigns c ON c.id=r.campaign_id JOIN service_cases s ON s.id=r.case_id LEFT JOIN users rq ON rq.id=r.requested_by
     WHERE ${where.join(' AND ')}`, params, `CASE r.status WHEN 'REQUESTED' THEN 0 WHEN 'APPROVED' THEN 1 ELSE 2 END, r.created_at DESC`, pageParams(q));
  return { ...res, items: camelize(res.items) };
}

// ---------- 總覽（供儀表板卡片使用；不改既有 dashboard.ts） ----------

export async function getAftersalesOverview(actor: Actor) {
  requirePerm(actor, 'aftersales.read');
  const empty = { asOf: new Date().toISOString(), totals: { active: 0, overdue: 0, highPriority: 0, resolved: 0, closed: 0, cancelled: 0 }, byStatus: {}, byType: {}, byCampaign: [], refunds: null };
  const sc = campaignScope(actor, 1, 'c');
  if (sc.sql === 'FALSE') return empty;
  const params = [...sc.params];
  const today = todayTaipei();
  const base = `FROM service_cases s JOIN campaigns c ON c.id=s.campaign_id WHERE s.organization_id=$1 AND (${sc.sql})`;
  const [byStatus, byType, overdue, high, byCampaign] = await Promise.all([
    query<{ k: string; n: number }>(`SELECT s.status AS k, count(*)::int AS n ${base} GROUP BY s.status`, params),
    query<{ k: string; n: number }>(`SELECT s.case_type AS k, count(*)::int AS n ${base} AND s.status IN ('OPEN','IN_PROGRESS','WAITING_VENDOR') GROUP BY s.case_type`, params),
    query<{ n: number }>(`SELECT count(*)::int AS n ${base} AND s.status IN ('OPEN','IN_PROGRESS','WAITING_VENDOR') AND s.due_date < $${params.length + 1}::date`, [...params, today]),
    query<{ n: number }>(`SELECT count(*)::int AS n ${base} AND s.status IN ('OPEN','IN_PROGRESS','WAITING_VENDOR') AND s.priority='HIGH'`, params),
    query<{ campaign_id: string; title: string; active: number; total: number }>(
      `SELECT s.campaign_id, c.title, count(*) FILTER (WHERE s.status IN ('OPEN','IN_PROGRESS','WAITING_VENDOR'))::int AS active, count(*)::int AS total
       ${base} GROUP BY s.campaign_id, c.title ORDER BY active DESC, total DESC, s.campaign_id LIMIT 10`, params),
  ]);
  const st: Record<string, number> = Object.fromEntries(byStatus.map((r) => [r.k, r.n]));
  const totals = {
    active: ACTIVE_CASE_STATUSES.reduce((a, k) => a + (st[k] ?? 0), 0), overdue: overdue[0].n, highPriority: high[0].n,
    resolved: st['RESOLVED'] ?? 0, closed: st['CLOSED'] ?? 0, cancelled: st['CANCELLED'] ?? 0,
  };
  let refunds: Record<string, { count: number; amount: number }> | null = null;
  if (isInternal(actor)) {
    const rr = await query<{ status: string; n: number; amt: number }>(
      `SELECT r.status, count(*)::int AS n, COALESCE(sum(r.amount),0)::bigint AS amt FROM refund_requests r JOIN campaigns c ON c.id=r.campaign_id
       WHERE r.organization_id=$1 AND (${sc.sql}) GROUP BY r.status`, params);
    refunds = Object.fromEntries(REFUND_STATUSES.map((k) => { const x = rr.find((r) => r.status === k); return [k, { count: x?.n ?? 0, amount: Number(x?.amt ?? 0) }]; }));
  }
  return {
    asOf: new Date().toISOString(), totals,
    byStatus: st, byType: Object.fromEntries(byType.map((r) => [r.k, r.n])),
    byCampaign: byCampaign.map((r) => ({ campaignId: r.campaign_id, title: r.title, active: r.active, total: r.total })),
    refunds,
  };
}
