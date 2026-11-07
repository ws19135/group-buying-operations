import { z } from 'zod';
import type { Queryable, Tx } from '../lib/db';
import { query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, isInternal, requirePerm } from '../lib/permissions';
import { conflict, forbidden, notFound, precondition, validation } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids } from '../lib/ids';
import { camelize } from '../lib/case';
import { collaborationScope, collaborationUnassignedSql } from '../lib/scope';
import { listPaged, pageParams } from '../lib/repo';
import { isTerminalApplication } from '../lib/collaboration-rules';
import { assertNoPii } from './selection';
import { loadApp, logEvent } from './collaboration-shared';

/**
 * 承辦人與交接（D-39）。
 *
 * 規則：
 *  - 營運小編只看得到自己承辦（PRIMARY）或被指派共同承辦（CO_OWNER）的申請（見 scope.ts）。
 *  - 營運主管／管理者看全部，並負責指派、交接、處理待指派佇列。
 *  - 沒有「有效主要承辦人」（沒指派，或承辦人已停用）的案件 → 待指派佇列，小編可看非個資摘要並自行認領。
 *  - 每次指派／交接／釋出都寫一筆 append-only 的 collaboration_handovers、一筆事件與一筆稽核。
 *  - 不建立任何通知（D-41：不自動發信、不產生真實通知）。
 */

const ASSIGNABLE_ROLES = ['SYSTEM_ADMIN', 'OPS_MANAGER', 'OPS_EDITOR'];

/** 被指派的人必須是同組織、啟用中的營運人員 */
export async function assertAssignable(db: Queryable, orgId: string, userId: string): Promise<void> {
  const u = await db.query(
    `SELECT 1 FROM users WHERE id=$1 AND organization_id=$2 AND status='ACTIVE' AND deleted_at IS NULL AND role_key = ANY($3::text[])`,
    [userId, orgId, ASSIGNABLE_ROLES]);
  if (!u.rowCount) throw validation('承辦人必須是啟用中的營運人員');
}

async function insertHandover(tx: Tx, actor: Actor, appId: string,
  type: 'ASSIGN' | 'CLAIM' | 'TRANSFER' | 'RELEASE' | 'ADD_CO_OWNER' | 'REMOVE_CO_OWNER' | 'BULK_REASSIGN',
  fromUser: string | null, toUser: string | null, reason: string | null): Promise<void> {
  await tx.query(
    `INSERT INTO collaboration_handovers (organization_id, application_id, handover_type, from_user_id, to_user_id, reason, actor_user_id, actor_role)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [actor.orgId, appId, type, fromUser, toUser, reason, actor.userId, actor.role]);
  await logEvent(tx, actor, appId, 'DATA', `HANDOVER_${type}`, { note: reason, internal: true });
  await audit(tx, actor, {
    action: `collaboration.assignment.${type.toLowerCase()}`, entityType: 'collaboration_application', entityId: appId,
    before: fromUser ? { userId: fromUser } : null, after: toUser ? { userId: toUser } : null, reason,
  });
}

/** 反正規化欄位 owner_user_id ＝ 目前主要承辦人（列表顯示用；資料範圍不看這個欄位） */
async function syncOwner(tx: Tx, actor: Actor, appId: string): Promise<void> {
  await tx.query(
    `UPDATE collaboration_applications a SET updated_by=$2,
       owner_user_id = (SELECT user_id FROM collaboration_assignments p WHERE p.application_id=a.id AND p.role='PRIMARY' AND p.ended_at IS NULL)
     WHERE a.id=$1`, [appId, actor.userId]);
}

async function endActive(tx: Tx, actor: Actor, appId: string, where: { role?: 'PRIMARY' | 'CO_OWNER'; userId?: string }, reason: string | null): Promise<string[]> {
  const conds = ['application_id=$1', 'ended_at IS NULL'];
  const params: unknown[] = [appId];
  if (where.role) { params.push(where.role); conds.push(`role=$${params.length}`); }
  if (where.userId) { params.push(where.userId); conds.push(`user_id=$${params.length}`); }
  params.push(actor.userId, reason);
  const r = await tx.query<{ user_id: string }>(
    `UPDATE collaboration_assignments SET ended_at=now(), ended_by=$${params.length - 1}, end_reason=$${params.length}
      WHERE ${conds.join(' AND ')} RETURNING user_id`, params);
  return r.rows.map((x) => x.user_id);
}

/** 開始一段承辦關係（呼叫端負責先結束舊的）。只在交易內使用 */
export async function startAssignment(tx: Tx, actor: Actor, appId: string, userId: string, role: 'PRIMARY' | 'CO_OWNER'): Promise<void> {
  await tx.query(
    `INSERT INTO collaboration_assignments (id, organization_id, application_id, user_id, role, assigned_by) VALUES ($1,$2,$3,$4,$5,$6)`,
    [await ids.collaborationAssignment(tx), actor.orgId, appId, userId, role, actor.userId]);
  if (role === 'PRIMARY') await syncOwner(tx, actor, appId);
}

async function activePrimary(tx: Tx, appId: string): Promise<string | null> {
  const r = await tx.query<{ user_id: string }>(
    `SELECT user_id FROM collaboration_assignments WHERE application_id=$1 AND role='PRIMARY' AND ended_at IS NULL FOR UPDATE`, [appId]);
  return r.rows[0]?.user_id ?? null;
}

/** 範圍以 collaborationScope 為準：營運主管／管理者＝全組織；小編只能動自己承辦的案件 */
async function lockApp(tx: Tx, actor: Actor, appId: string) {
  return loadApp(tx, actor, appId, true);
}

// ---------------------------------------------------------------- 指派／交接
export const assignSchema = z.object({
  userId: z.string().trim().min(1).max(40),
  reason: z.string().trim().max(500).nullable().optional(),
  keepPreviousAsCoOwner: z.boolean().optional(),
}).strict();

/** 指派主要承辦人；若已有承辦人就是「交接」，必須填原因 */
export async function assignApplication(actor: Actor, appId: string, raw: z.input<typeof assignSchema>) {
  requirePerm(actor, 'collaboration.assign');
  const input = assignSchema.parse(raw);
  assertNoPii({ 原因: input.reason });
  return withTx(async (tx) => {
    const app = await lockApp(tx, actor, appId);
    await assertAssignable(tx, actor.orgId, input.userId);
    const cur = await activePrimary(tx, appId);
    if (cur === input.userId) throw conflict('這個人已經是主要承辦人');
    if (cur && !input.reason?.trim()) throw validation('交接請填寫原因');
    // 若新承辦人原本是共同承辦，先結束那一列（同一人同一案件只會有一個有效身分）
    await endActive(tx, actor, appId, { userId: input.userId }, '升為主要承辦');
    if (cur) {
      await endActive(tx, actor, appId, { role: 'PRIMARY' }, input.reason ?? null);
      if (input.keepPreviousAsCoOwner) await startAssignment(tx, actor, appId, cur, 'CO_OWNER');
    }
    await startAssignment(tx, actor, appId, input.userId, 'PRIMARY');
    await insertHandover(tx, actor, appId, cur ? 'TRANSFER' : 'ASSIGN', cur, input.userId, input.reason ?? null);
    return { id: app.id, primaryUserId: input.userId, previousUserId: cur };
  });
}

/** 小編從待指派佇列自行認領。只能認領「目前沒有有效主要承辦人」的案件 */
export async function claimApplication(actor: Actor, appId: string) {
  requirePerm(actor, 'collaboration.update');
  if (!isInternal(actor)) throw forbidden();
  return withTx(async (tx) => {
    const r = await tx.query<{ id: string; status: never; unassigned: boolean }>(
      `SELECT a.id, a.status, (${collaborationUnassignedSql('a')}) AS unassigned
         FROM collaboration_applications a WHERE a.id=$1 AND a.organization_id=$2 AND a.deleted_at IS NULL FOR UPDATE`, [appId, actor.orgId]);
    if (!r.rowCount) throw notFound('合作申請');
    if (!r.rows[0].unassigned) throw conflict('這筆申請已經有承辦人');
    if (isTerminalApplication(r.rows[0].status)) throw precondition('申請已結束，不需要認領');
    await assertAssignable(tx, actor.orgId, actor.userId as string);
    await endActive(tx, actor, appId, { role: 'PRIMARY' }, '原承辦人已停用，由新承辦人認領');   // 停用承辦人留下的孤兒承辦列
    await endActive(tx, actor, appId, { userId: actor.userId as string }, '改為主要承辦');
    await startAssignment(tx, actor, appId, actor.userId as string, 'PRIMARY');
    await insertHandover(tx, actor, appId, 'CLAIM', null, actor.userId, null);
    return { id: appId, primaryUserId: actor.userId };
  });
}

const reasonSchema = z.object({ reason: z.string().trim().min(1, '請填寫原因').max(500) }).strict();

/** 主要承辦人（或有指派權限者）把案件釋回待指派佇列 */
export async function releaseApplication(actor: Actor, appId: string, raw: z.input<typeof reasonSchema>) {
  const input = reasonSchema.parse(raw);
  assertNoPii({ 原因: input.reason });
  return withTx(async (tx) => {
    const app = await lockApp(tx, actor, appId);
    const cur = await activePrimary(tx, appId);
    if (!cur) throw conflict('這筆申請目前沒有主要承辦人');
    if (!can(actor, 'collaboration.assign') && cur !== actor.userId) throw forbidden();
    await endActive(tx, actor, appId, { role: 'PRIMARY' }, input.reason);
    await syncOwner(tx, actor, appId);
    await insertHandover(tx, actor, appId, 'RELEASE', cur, null, input.reason);
    return { id: app.id, released: true };
  });
}

export const coOwnerSchema = z.object({ userId: z.string().trim().min(1).max(40), reason: z.string().trim().max(500).nullable().optional() }).strict();

async function assertMayManageCoOwners(tx: Tx, actor: Actor, appId: string) {
  if (can(actor, 'collaboration.assign')) return;
  const cur = await activePrimary(tx, appId);
  if (!(isInternal(actor) && can(actor, 'collaboration.update') && cur === actor.userId)) throw forbidden();
}

export async function addCoOwner(actor: Actor, appId: string, raw: z.input<typeof coOwnerSchema>) {
  const input = coOwnerSchema.parse(raw);
  assertNoPii({ 原因: input.reason });
  return withTx(async (tx) => {
    await lockApp(tx, actor, appId);
    await assertMayManageCoOwners(tx, actor, appId);
    await assertAssignable(tx, actor.orgId, input.userId);
    const exists = await tx.query('SELECT 1 FROM collaboration_assignments WHERE application_id=$1 AND user_id=$2 AND ended_at IS NULL', [appId, input.userId]);
    if (exists.rowCount) throw conflict('這個人已經參與這筆申請');
    await startAssignment(tx, actor, appId, input.userId, 'CO_OWNER');
    await insertHandover(tx, actor, appId, 'ADD_CO_OWNER', null, input.userId, input.reason ?? null);
    return { id: appId, coOwnerUserId: input.userId };
  });
}

export async function removeCoOwner(actor: Actor, appId: string, userId: string, reason: string | null) {
  assertNoPii({ 原因: reason });
  return withTx(async (tx) => {
    await lockApp(tx, actor, appId);
    await assertMayManageCoOwners(tx, actor, appId);
    const ended = await endActive(tx, actor, appId, { role: 'CO_OWNER', userId }, reason);
    if (!ended.length) throw notFound('共同承辦人');
    await insertHandover(tx, actor, appId, 'REMOVE_CO_OWNER', userId, null, reason);
    return { id: appId, removedUserId: userId };
  });
}

export const bulkReassignSchema = z.object({
  fromUserId: z.string().trim().min(1).max(40),
  toUserId: z.string().trim().min(1).max(40),
  reason: z.string().trim().min(1, '請填寫交接原因').max(500),
}).strict();

/** 整批交接（例如承辦人離職或調職）：把某人所有進行中的承辦／共同承辦一次轉給另一人 */
export async function bulkReassign(actor: Actor, raw: z.input<typeof bulkReassignSchema>) {
  requirePerm(actor, 'collaboration.assign');
  const input = bulkReassignSchema.parse(raw);
  assertNoPii({ 原因: input.reason });
  if (input.fromUserId === input.toUserId) throw validation('交接對象不可以是同一個人');
  return withTx(async (tx) => {
    // 來源人可以已經停用（離職）；對象必須是啟用中的營運人員
    const from = await tx.query('SELECT 1 FROM users WHERE id=$1 AND organization_id=$2', [input.fromUserId, actor.orgId]);
    if (!from.rowCount) throw notFound('原承辦人');
    await assertAssignable(tx, actor.orgId, input.toUserId);
    const rows = await tx.query<{ application_id: string; role: 'PRIMARY' | 'CO_OWNER' }>(
      `SELECT ca.application_id, ca.role FROM collaboration_assignments ca
         JOIN collaboration_applications a ON a.id = ca.application_id
        WHERE ca.organization_id=$1 AND ca.user_id=$2 AND ca.ended_at IS NULL AND a.deleted_at IS NULL
        ORDER BY ca.application_id FOR UPDATE OF ca`, [actor.orgId, input.fromUserId]);
    let moved = 0;
    for (const r of rows.rows) {
      await endActive(tx, actor, r.application_id, { userId: input.fromUserId }, input.reason);
      const already = await tx.query('SELECT 1 FROM collaboration_assignments WHERE application_id=$1 AND user_id=$2 AND ended_at IS NULL', [r.application_id, input.toUserId]);
      if (r.role === 'PRIMARY') {
        if (already.rowCount) await endActive(tx, actor, r.application_id, { userId: input.toUserId }, '升為主要承辦');
        await startAssignment(tx, actor, r.application_id, input.toUserId, 'PRIMARY');
      } else if (!already.rowCount) {
        await startAssignment(tx, actor, r.application_id, input.toUserId, 'CO_OWNER');
      }   // 對象已在案件中：只結束來源人的共同承辦即可
      await insertHandover(tx, actor, r.application_id, 'BULK_REASSIGN', input.fromUserId, input.toUserId, input.reason);
      moved++;
    }
    return { fromUserId: input.fromUserId, toUserId: input.toUserId, moved };
  });
}

// ---------------------------------------------------------------- 待指派佇列與承辦資訊
/**
 * 待指派佇列：沒有有效主要承辦人的案件（未指派，或承辦人已停用）。
 * 內部營運角色都看得到「非個資摘要」：不含收件資料、內部備註、廠商後台資訊；要處理必須先認領或被指派。
 */
export async function listUnassigned(actor: Actor, q: URLSearchParams) {
  if (!isInternal(actor) || !(can(actor, 'collaboration.read') || can(actor, 'collaboration.update'))) throw forbidden();
  const res = await listPaged<Record<string, unknown>>(
    `SELECT a.id, a.status, a.collaboration_status, a.source, a.applied_on, a.created_at,
            h.display_name AS host_name, v.name AS vendor_name, p.name AS product_name,
            (current_date - a.created_at::date)::int AS days_waiting,
            (SELECT u.name FROM collaboration_assignments pa JOIN users u ON u.id = pa.user_id
              WHERE pa.application_id=a.id AND pa.role='PRIMARY' AND pa.ended_at IS NULL) AS former_owner_name
       FROM collaboration_applications a
       JOIN hosts h ON h.id=a.host_id JOIN vendors v ON v.id=a.vendor_id LEFT JOIN products p ON p.id=a.product_id
      WHERE a.organization_id=$1 AND a.deleted_at IS NULL AND a.status NOT IN ('REJECTED','CANCELLED','CLOSED')
        AND ${collaborationUnassignedSql('a')}`,
    [actor.orgId], 'a.created_at ASC, a.id ASC', pageParams(q));
  return { ...res, items: camelize(res.items) };
}

export async function countUnassigned(actor: Actor): Promise<number> {
  if (!isInternal(actor) || !(can(actor, 'collaboration.read') || can(actor, 'collaboration.update'))) return 0;
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM collaboration_applications a
      WHERE a.organization_id=$1 AND a.deleted_at IS NULL AND a.status NOT IN ('REJECTED','CANCELLED','CLOSED') AND ${collaborationUnassignedSql('a')}`,
    [actor.orgId]);
  return Number(r[0]?.n ?? 0);
}

/** 申請的承辦人與共同承辦（僅內部、僅範圍內的申請） */
export async function assigneesOf(actor: Actor, appId: string) {
  if (!isInternal(actor)) return [];
  const rows = await query(
    `SELECT ca.user_id, ca.role, ca.assigned_at, u.name, u.status
       FROM collaboration_assignments ca JOIN users u ON u.id = ca.user_id
      WHERE ca.application_id=$1 AND ca.ended_at IS NULL ORDER BY ca.role DESC, ca.assigned_at`, [appId]);
  return camelize(rows);
}

export async function listHandovers(actor: Actor, appId: string) {
  if (!isInternal(actor) || !can(actor, 'collaboration.read')) throw forbidden();
  const sc = collaborationScope(actor, 2, 'a');
  if (sc.sql === 'FALSE') throw notFound('合作申請');
  const ok = await query('SELECT 1 FROM collaboration_applications a WHERE a.id=$1 AND (' + sc.sql + ')', [appId, ...sc.params]);
  if (!ok.length) throw notFound('合作申請');
  const rows = await query(
    `SELECT h.id, h.handover_type, h.reason, h.created_at, h.actor_role,
            fu.name AS from_user_name, tu.name AS to_user_name, au.name AS actor_name
       FROM collaboration_handovers h
       LEFT JOIN users fu ON fu.id=h.from_user_id LEFT JOIN users tu ON tu.id=h.to_user_id LEFT JOIN users au ON au.id=h.actor_user_id
      WHERE h.application_id=$1 ORDER BY h.id`, [appId]);
  return { items: camelize(rows) };
}
