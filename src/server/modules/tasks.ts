import { z } from 'zod';
import type { Tx } from '../lib/db';
import { query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, requirePerm } from '../lib/permissions';
import { AppError, forbidden, notFound, validation } from '../lib/errors';
import { audit, emitEvent } from '../lib/audit';
import { ids, todayTaipei } from '../lib/ids';
import { camelize } from '../lib/case';
import { isIsoDate } from '../lib/dates';
import { isHttpUrl, nonEmpty } from '../lib/text';
import { listPaged, pageParams } from '../lib/repo';
import { campaignScope } from '../lib/scope';
import { computeSchedule, type CampaignInputs, type FixedDates, type Params } from '../workflow/schedule';
import { loadTemplate } from '../workflow/templates';

export const OPEN_TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'WAITING_APPROVAL'];
const CLOSED_TASK = ['DONE', 'SKIPPED', 'CANCELLED'];

export function toInputs(c: Record<string, unknown>): CampaignInputs {
  return {
    open_date: (c['open_date'] as string | null) ?? null,
    close_date: (c['close_date'] as string | null) ?? null,
    sample_ready_date: (c['sample_ready_date'] as string | null) ?? null,
    live_talk_date: (c['live_talk_date'] as string | null) ?? null,
    needs_sample_recovery: !!c['needs_sample_recovery'],
  };
}

/**
 * 依模板為檔期建立任務。冪等：已存在的 (campaign_id, step_key) 不會重複建立、也不會被覆寫。
 * 條件不成立的選擇性步驟會建立為 SKIPPED（保留紀錄，之後條件成立可自動恢復）。
 */
export async function generateTasks(tx: Tx, actor: Actor, campaignId: string): Promise<{ created: number; existing: number }> {
  const cr = await tx.query('SELECT * FROM campaigns WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [campaignId, actor.orgId]);
  const c = cr.rows[0];
  if (!c) throw notFound('檔期');
  if (!c.workflow_template_id) throw new AppError('PRECONDITION_FAILED', '檔期尚未綁定流程模板');
  const tpl = await loadTemplate(tx, actor.orgId, c.workflow_template_id);
  const params: Params = { ...tpl.params, ...(c.workflow_params as Params) };
  const plan = computeSchedule(tpl.steps, toInputs(c), params);

  const existing = await tx.query<{ step_key: string; id: string }>('SELECT step_key, id FROM tasks WHERE campaign_id=$1', [campaignId]);
  const idByKey = new Map(existing.rows.map((r) => [r.step_key, r.id]));
  let created = 0;
  for (const s of tpl.steps) {
    if (idByKey.has(s.stepKey)) continue;
    const p = plan.get(s.stepKey);
    const id = await ids.task(tx);
    const status = p?.applicable ? 'TODO' : 'SKIPPED';
    const assignee = s.ownerRole === 'OPS_EDITOR' || s.ownerRole === 'OPS_MANAGER' ? (c.owner_user_id ?? null) : null;
    const r = await tx.query(
      `INSERT INTO tasks (id, organization_id, campaign_id, step_key, name, phase, seq, owner_role, assignee_user_id, kind, gate_key, status,
         planned_start, planned_end, optional, skip_reason, schedule_issue, template_version, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)
       ON CONFLICT (campaign_id, step_key) DO NOTHING RETURNING id`,
      [id, actor.orgId, campaignId, s.stepKey, s.name, s.phase, s.seq, s.ownerRole, assignee, s.kind, s.gateKey, status,
        p?.plannedStart ?? null, p?.plannedEnd ?? null, s.optional, status === 'SKIPPED' ? '條件不成立（選擇性步驟）' : null,
        p?.issue ?? null, tpl.version, actor.userId]);
    if (r.rowCount) { idByKey.set(s.stepKey, id); created++; }
  }
  for (const s of tpl.steps) {
    for (const d of s.dependsOn) {
      await tx.query('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [idByKey.get(s.stepKey), idByKey.get(d)]);
    }
  }
  if (created) await audit(tx, actor, { action: 'task.generate', entityType: 'campaign', entityId: campaignId, campaignId, after: { created, templateVersion: tpl.version } });
  return { created, existing: existing.rows.length };
}

export function isOverdue(t: { status: string; planned_end?: string | null; plannedEnd?: string | null }, today = todayTaipei()): boolean {
  const end = t.planned_end ?? t.plannedEnd ?? null;
  return !!end && !CLOSED_TASK.includes(t.status) && end < today;
}

export async function listTasks(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'task.read');
  const sc = campaignScope(actor, 1, 'c');
  if (sc.sql === 'FALSE') return { items: [], total: 0, limit: 50, offset: 0 };
  const params = [...sc.params];
  const where = ['t.organization_id=$1', `(${sc.sql})`, `c.status NOT IN ('CANCELLED')`];
  if (actor.role === 'HOST') where.push(`t.owner_role='HOST'`);
  if (actor.role === 'VENDOR') where.push(`t.owner_role='VENDOR'`);
  const add = (cond: (n: number) => string, v: unknown) => { params.push(v); where.push(cond(params.length)); };
  const cid = nonEmpty(q.get('campaignId')); if (cid) add((n) => `t.campaign_id=$${n}`, cid);
  const st = nonEmpty(q.get('status')); if (st) add((n) => `t.status=$${n}`, st);
  const role = nonEmpty(q.get('ownerRole')); if (role) add((n) => `t.owner_role=$${n}`, role);
  if (q.get('mine') === '1') add((n) => `t.assignee_user_id=$${n}`, actor.userId);
  if (q.get('open') === '1') where.push(`t.status IN ('TODO','IN_PROGRESS','BLOCKED','WAITING_APPROVAL')`);
  if (q.get('overdue') === '1') add((n) => `t.status IN ('TODO','IN_PROGRESS','BLOCKED','WAITING_APPROVAL') AND t.planned_end < $${n}::date`, todayTaipei());
  const dueTo = nonEmpty(q.get('dueTo')); if (dueTo && isIsoDate(dueTo)) add((n) => `t.planned_end <= $${n}::date`, dueTo);
  const res = await listPaged<Record<string, unknown>>(
    `SELECT t.id, t.campaign_id, c.title AS campaign_title, c.status AS campaign_status, t.step_key, t.name, t.phase, t.seq, t.owner_role,
       t.assignee_user_id, u.name AS assignee_name, t.kind, t.gate_key, t.status, t.planned_start, t.planned_end, t.completed_at,
       t.date_locked, t.optional, t.blocker_reason, t.schedule_issue, t.skip_reason, t.version
     FROM tasks t JOIN campaigns c ON c.id=t.campaign_id LEFT JOIN users u ON u.id=t.assignee_user_id
     WHERE ${where.join(' AND ')}`, params, `t.planned_end ASC NULLS LAST, t.campaign_id, t.seq`, pageParams(q));
  const today = todayTaipei();
  res.items = res.items.map((t) => ({ ...camelize<Record<string, unknown>>(t), overdue: isOverdue(t as { status: string; planned_end: string | null }, today) }));
  return res;
}

async function loadTaskScoped(tx: Tx, actor: Actor, id: string, lock = false) {
  const sc = campaignScope(actor, 2, 'c');
  if (sc.sql === 'FALSE') throw notFound('任務');
  const r = await tx.query(
    `SELECT t.*, c.status AS campaign_status, c.title AS campaign_title FROM tasks t JOIN campaigns c ON c.id=t.campaign_id
     WHERE t.id=$1 AND t.organization_id=$2 AND (${sc.sql}) ${lock ? 'FOR UPDATE OF t' : ''}`,
    [id, ...sc.params]);
  if (!r.rowCount) throw notFound('任務');
  return r.rows[0] as Record<string, unknown>;
}

/** 這位使用者能不能操作這個任務：負責角色本人，或有任務管理權限的內部角色 */
function assertCanActOn(actor: Actor, t: Record<string, unknown>) {
  // 團主／廠商看不到其他角色的任務：一律回報「找不到」，不洩漏任務是否存在
  if ((actor.role === 'HOST' || actor.role === 'VENDOR') && t['owner_role'] !== actor.role) throw notFound('任務');
  if (can(actor, 'task.write')) return;
  if (can(actor, 'task.complete') && actor.role === t['owner_role']) return;
  throw forbidden('你不是此任務的負責角色');
}

const statusInput = z.object({
  to: z.enum(['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'SKIPPED']),
  reason: z.string().trim().max(500).optional(),
  evidenceNote: z.string().trim().max(1000).optional(),
  evidenceUrl: z.string().trim().max(500).refine(isHttpUrl, '連結需為 http:// 或 https:// 開頭的網址').optional().or(z.literal('').transform(() => undefined)),
  force: z.boolean().optional(),
});

export async function setTaskStatus(actor: Actor, id: string, raw: z.input<typeof statusInput>) {
  requirePerm(actor, 'task.complete');
  const input = statusInput.parse(raw);
  return withTx(async (tx) => {
    const t = await loadTaskScoped(tx, actor, id, true);
    assertCanActOn(actor, t);
    const from = t['status'] as string;
    const campaignStatus = t['campaign_status'] as string;
    if (['CANCELLED', 'ON_HOLD', 'CLOSED'].includes(campaignStatus)) throw new AppError('PRECONDITION_FAILED', '此檔期已取消、暫緩或結案，任務不可變更');
    if (t['kind'] === 'GATE') throw new AppError('PRECONDITION_FAILED', '關卡任務請透過「核准」流程處理，不能直接變更狀態');
    if (from === 'CANCELLED') throw new AppError('PRECONDITION_FAILED', '任務已取消');

    const reopen = from === 'DONE' && input.to !== 'DONE';
    if (reopen && !can(actor, 'task.write')) throw forbidden('只有營運人員可以重開已完成的任務');
    if ((reopen || input.to === 'BLOCKED' || input.to === 'SKIPPED') && !input.reason) throw validation('此操作需填寫原因');
    if (input.to === 'SKIPPED' && !t['optional']) throw new AppError('PRECONDITION_FAILED', '只有選擇性任務可以略過');
    if (from === input.to) return { id, status: from, unchanged: true };

    if (input.to === 'IN_PROGRESS' || input.to === 'DONE') {
      const deps = await tx.query(
        `SELECT d.step_key, d.name, d.status FROM task_dependencies td JOIN tasks d ON d.id=td.depends_on_task_id
         WHERE td.task_id=$1 AND d.status NOT IN ('DONE','SKIPPED')`, [id]);
      if (deps.rowCount && !(input.force && can(actor, 'campaign.transition') && input.reason)) {
        throw new AppError('PRECONDITION_FAILED', `前置任務尚未完成：${deps.rows.map((d) => d.name).join('、')}`, { blockedBy: deps.rows.map((d) => d.step_key) });
      }
    }
    const done = input.to === 'DONE';
    await tx.query(
      `UPDATE tasks SET status=$2, completed_at=$3, completed_by=$4, actual_start=COALESCE(actual_start, CASE WHEN $2 IN ('IN_PROGRESS','DONE') THEN $7::date END),
         blocker_reason=$5, skip_reason=CASE WHEN $2='SKIPPED' THEN $6 ELSE skip_reason END,
         evidence_note=COALESCE($8, evidence_note), evidence_url=COALESCE($9, evidence_url), overdue_flagged_at=CASE WHEN $2 IN ('DONE','SKIPPED') THEN NULL ELSE overdue_flagged_at END,
         updated_by=$4
       WHERE id=$1`,
      [id, input.to, done ? new Date() : null, actor.userId, input.to === 'BLOCKED' ? input.reason : null, input.reason ?? null,
        todayTaipei(), input.evidenceNote ?? null, input.evidenceUrl ?? null]);
    await audit(tx, actor, {
      action: `task.${done ? 'complete' : 'status'}`, entityType: 'task', entityId: id, campaignId: t['campaign_id'] as string,
      before: { status: from }, after: { status: input.to, evidenceNote: input.evidenceNote ?? null }, reason: input.reason ?? null,
    });
    if (done || input.to === 'SKIPPED') {
      await tx.query(`UPDATE exceptions SET status='RESOLVED', resolved_at=now(), resolution_note='任務已完成', version=version+1
                      WHERE organization_id=$1 AND dedupe_key=$2 AND status<>'RESOLVED'`, [actor.orgId, `task_overdue:${id}`]);
      await emitEvent(tx, actor, 'task.completed', 'task', id, { campaignId: t['campaign_id'], stepKey: t['step_key'] }, `task.completed:${id}`);
    }
    return { id, status: input.to };
  });
}

const updateInput = z.object({
  assigneeUserId: z.string().nullable().optional().transform((v) => (v === '' ? null : v)),
  plannedStart: z.string().refine(isIsoDate, '日期格式需為 YYYY-MM-DD').optional(),
  plannedEnd: z.string().refine(isIsoDate, '日期格式需為 YYYY-MM-DD').optional(),
  reason: z.string().trim().max(500).optional(),
  unlockDates: z.boolean().optional(),
  version: z.number().int().optional(),
});

/** 指派負責人、人工調整單一任務日期（調整後鎖定，自動重排不得覆寫；需填原因） */
export async function updateTask(actor: Actor, id: string, raw: z.input<typeof updateInput>) {
  requirePerm(actor, 'task.write');
  const input = updateInput.parse(raw);
  return withTx(async (tx) => {
    const t = await loadTaskScoped(tx, actor, id, true);
    if (input.version != null && t['version'] !== input.version) throw new AppError('CONFLICT', '任務已被其他人更新，請重新整理後再試');
    if (CLOSED_TASK.includes(t['status'] as string)) throw new AppError('PRECONDITION_FAILED', '已完成、略過或取消的任務不可修改');
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };

    if (input.assigneeUserId !== undefined) {
      if (input.assigneeUserId) {
        const u = await tx.query(`SELECT 1 FROM users WHERE id=$1 AND organization_id=$2 AND status='ACTIVE' AND deleted_at IS NULL`, [input.assigneeUserId, actor.orgId]);
        if (!u.rowCount) throw notFound('指派對象');
      }
      before['assigneeUserId'] = t['assignee_user_id']; after['assigneeUserId'] = input.assigneeUserId;
      set('assignee_user_id', input.assigneeUserId);
    }
    if (input.unlockDates) {
      if (!input.reason) throw validation('解除日期鎖定需填寫原因');
      before['dateLocked'] = t['date_locked']; after['dateLocked'] = false;
      set('date_locked', false); set('date_lock_reason', null);
    }
    if (input.plannedStart || input.plannedEnd) {
      if (!input.reason) throw validation('人工調整任務日期需填寫原因');
      const ns = input.plannedStart ?? (t['planned_start'] as string | null);
      const ne = input.plannedEnd ?? (t['planned_end'] as string | null);
      if (ns && ne && ns > ne) throw validation('開始日不可晚於結束日');
      before['plannedStart'] = t['planned_start']; before['plannedEnd'] = t['planned_end'];
      after['plannedStart'] = ns; after['plannedEnd'] = ne;
      set('planned_start', ns); set('planned_end', ne); set('date_locked', true); set('date_lock_reason', input.reason);
      set('schedule_issue', null);
    }
    if (!sets.length) return { id, unchanged: true };
    vals.push(actor.userId);
    await tx.query(`UPDATE tasks SET ${sets.join(', ')}, updated_by=$${vals.length} WHERE id=$1`, vals);
    await audit(tx, actor, { action: 'task.update', entityType: 'task', entityId: id, campaignId: t['campaign_id'] as string, before, after, reason: input.reason ?? null });
    return { id };
  });
}

export async function getTask(actor: Actor, id: string) {
  requirePerm(actor, 'task.read');
  const t = await withTx((tx) => loadTaskScoped(tx, actor, id));
  if (actor.role === 'HOST' && t['owner_role'] !== 'HOST') throw notFound('任務');
  if (actor.role === 'VENDOR' && t['owner_role'] !== 'VENDOR') throw notFound('任務');
  const deps = await query(
    `SELECT d.id, d.step_key, d.name, d.status FROM task_dependencies td JOIN tasks d ON d.id=td.depends_on_task_id WHERE td.task_id=$1 ORDER BY d.seq`, [id]);
  return { ...camelize<Record<string, unknown>>(t), dependsOn: camelize(deps), overdue: isOverdue(t as { status: string; planned_end: string | null }) };
}

export type { FixedDates };
