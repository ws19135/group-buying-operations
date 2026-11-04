import { z } from 'zod';
import { pool, query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { requirePerm, roleCan, INTERNAL_ROLES, type RoleKey } from '../lib/permissions';
import { notFound, precondition, validation } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids, todayTaipei } from '../lib/ids';
import { camelize } from '../lib/case';
import { campaignScope } from '../lib/scope';
import { CREDIBILITY, DEDUPE_METHODS, REACH_METRICS, REACH_RULES_VERSION, REACH_SOURCE_KINDS, sourceProblem, visitorInputProblems, type DedupeMethod, type ReachMetric, type ReachRecord, type ReachSourceKind, type VerificationStatus } from '../lib/trial-reach';
import { conflict, forbidden } from '../lib/errors';
import { assertNoPii, mapDbError } from './selection';

/**
 * 小規模測試團的觸及與導購資料（人工填寫，Owner 決策 K-2）。每筆記錄來源、統計期間、填寫人、填寫日期、資料可信度；
 * 建立後不可改（資料庫觸發器保證），要更正就「刪除」（軟刪除，保留原因與紀錄）後重新填；不做任何外部 API 串接。
 */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式需為 YYYY-MM-DD');
export const reachCreateSchema = z.object({
  metric: z.enum(REACH_METRICS),
  value: z.number().int().min(0).max(100_000_000),
  sourceKind: z.enum(REACH_SOURCE_KINDS),
  sourceText: z.string().trim().min(2, '請寫清楚資料來源（哪個後台、哪份報表、誰提供）').max(300),
  periodStart: day,
  periodEnd: day,
  credibility: z.enum(CREDIBILITY),
  note: z.string().trim().max(300).nullable().optional(),
  /** 有效導購訪客專用（K-4）：來源佐證或可查核的來源識別、去重方式、人工去重的說明 */
  evidenceRef: z.string().trim().max(300).nullable().optional(),
  dedupeMethod: z.enum(DEDUPE_METHODS).nullable().optional(),
  dedupeNote: z.string().trim().max(300).nullable().optional(),
  /** K-4a 補件：指回被查核退回的那一筆（同一個試用、同一種資料，且該筆尚未被補件） */
  resubmitsId: z.string().max(40).nullable().optional(),
}).strict();

async function visibleTrial(actor: Actor, trialId: string, lock: boolean, db = pool()) {
  const r = await db.query<{ id: string; status: string; campaign_id: string | null; host_id: string | null; product_id: string }>(
    `SELECT id, status, campaign_id, host_id, product_id FROM product_trials WHERE id=$1 AND organization_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [trialId, actor.orgId]);
  if (!r.rowCount) throw notFound('試用');
  const t = r.rows[0];
  if (t.campaign_id) {
    const sc = campaignScope(actor, 2, 'c');
    if (sc.sql === 'FALSE') throw notFound('試用');
    const ok = await db.query(`SELECT 1 FROM campaigns c WHERE c.id=$1 AND (${sc.sql})`, [t.campaign_id, ...sc.params]);
    if (!ok.rowCount) throw notFound('試用');
  }
  return t;
}

const SELECT = `SELECT r.*, u.name AS created_by_name, v.name AS verified_by_name, a.name AS assigned_verifier_name FROM trial_reach_records r LEFT JOIN users u ON u.id=r.created_by LEFT JOIN users v ON v.id=r.verified_by LEFT JOIN users a ON a.id=r.assigned_verifier_id`;
export function presentReach(r: Record<string, unknown>): ReachRecord {
  const c = camelize<Record<string, unknown>>(r);
  return {
    id: String(r.id), metric: r.metric as ReachMetric, value: Number(r.value), sourceKind: r.source_kind as ReachSourceKind, sourceText: String(r.source_text),
    periodStart: String(r.period_start), periodEnd: String(r.period_end), credibility: r.credibility as ReachRecord['credibility'], note: (r.note as string | null) ?? null,
    filledOn: String(r.filled_on), createdBy: String(r.created_by), createdByName: (c.createdByName as string | null) ?? null, createdAt: new Date(r.created_at as string).toISOString(),
    evidenceRef: (r.evidence_ref as string | null) ?? null, dedupeMethod: (r.dedupe_method as DedupeMethod | null) ?? null, dedupeNote: (r.dedupe_note as string | null) ?? null, rulesVersion: String(r.rules_version),
    verificationStatus: r.verification_status as VerificationStatus, verifiedBy: (r.verified_by as string | null) ?? null, verifiedByName: (c.verifiedByName as string | null) ?? null,
    verifiedAt: r.verified_at ? new Date(r.verified_at as string).toISOString() : null, verifyNote: (r.verify_note as string | null) ?? null, verifyRulesVersion: (r.verify_rules_version as string | null) ?? null,
    assignedVerifierId: (r.assigned_verifier_id as string | null) ?? null, assignedVerifierName: (c.assignedVerifierName as string | null) ?? null, assignedBy: (r.assigned_by as string | null) ?? null,
    assignedAt: r.assigned_at ? new Date(r.assigned_at as string).toISOString() : null, assignmentNote: (r.assignment_note as string | null) ?? null, resubmitsId: (r.resubmits_id as string | null) ?? null,
    deleted: r.deleted_at != null, deletedAt: r.deleted_at ? new Date(r.deleted_at as string).toISOString() : null, deleteReason: (r.delete_reason as string | null) ?? null,
  };
}

export async function listReach(actor: Actor, trialId: string): Promise<{ trialId: string; records: ReachRecord[] }> {
  requirePerm(actor, 'selection.read');
  await visibleTrial(actor, trialId, false);
  const rows = await query(`${SELECT} WHERE r.trial_id=$1 AND r.organization_id=$2 ORDER BY r.created_at DESC, r.id DESC LIMIT 200`, [trialId, actor.orgId]);
  return { trialId, records: rows.map((r) => presentReach(r as never)) };
}

/** 供 KPI 使用：不含已刪除的紀錄（呼叫端需先確認權限與範圍） */
export async function activeReach(orgId: string, trialId: string): Promise<ReachRecord[]> {
  const rows = await query(`${SELECT} WHERE r.trial_id=$1 AND r.organization_id=$2 AND r.deleted_at IS NULL ORDER BY r.created_at DESC, r.id DESC LIMIT 200`, [trialId, orgId]);
  return rows.map((r) => presentReach(r as never));
}

export async function addReach(actor: Actor, trialId: string, raw: z.input<typeof reachCreateSchema>) {
  requirePerm(actor, 'selection.write');
  const input = reachCreateSchema.parse(raw);
  assertNoPii({ 來源說明: input.sourceText, 備註: input.note, 來源佐證: input.evidenceRef, 去重說明: input.dedupeNote });
  const bad = sourceProblem(input.metric, input.sourceKind);
  if (bad) throw validation(bad);
  if (input.periodEnd < input.periodStart) throw validation('統計期間的結束日不能早於開始日');
  if (input.metric === 'QUALIFIED_VISITORS') {
    const problems = visitorInputProblems(input);
    if (problems.length) throw validation(problems.join('；'), { problems });
  } else if (input.dedupeMethod || input.dedupeNote) throw validation('去重方式只適用於「有效導購訪客」');
  try {
    return await withTx(async (tx) => {
      const t = await visibleTrial(actor, trialId, true, tx as never);
      if (t.status === 'CANCELLED') throw precondition('已取消的試用不能新增觸及與導購資料');
      if (input.resubmitsId) {
        const prev = await tx.query(`SELECT id, trial_id, metric, verification_status, deleted_at FROM trial_reach_records WHERE id=$1 AND organization_id=$2`, [input.resubmitsId, actor.orgId]);
        const pr = prev.rows[0] as { trial_id: string; metric: string; verification_status: string; deleted_at: string | null } | undefined;
        if (!pr || pr.trial_id !== trialId) throw notFound('被退回的紀錄');
        if (pr.metric !== input.metric) throw validation('補件必須是同一種資料');
        if (pr.verification_status !== 'REJECTED' || pr.deleted_at) throw precondition('只有「查核退回」的紀錄可以補件');
      }
      const id = await ids.reachRecord(tx);
      await tx.query(
        `INSERT INTO trial_reach_records (id, organization_id, trial_id, metric, value, source_kind, source_text, period_start, period_end, credibility, note, filled_on, created_by, updated_by, evidence_ref, dedupe_method, dedupe_note, rules_version, resubmits_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$15,$16,$17,$18)`,
        [id, actor.orgId, trialId, input.metric, input.value, input.sourceKind, input.sourceText, input.periodStart, input.periodEnd, input.credibility, input.note ?? null, todayTaipei(), actor.userId, input.evidenceRef ?? null, input.dedupeMethod ?? null, input.dedupeNote ?? null, REACH_RULES_VERSION, input.resubmitsId ?? null]);
      await audit(tx, actor, { action: 'selection.trial.reach.add', entityType: 'trial_reach_record', entityId: id, campaignId: t.campaign_id,
        after: { trialId, metric: input.metric, value: input.value, sourceKind: input.sourceKind, periodStart: input.periodStart, periodEnd: input.periodEnd, credibility: input.credibility, dedupeMethod: input.dedupeMethod ?? null, hasEvidenceRef: !!input.evidenceRef, rulesVersion: REACH_RULES_VERSION, resubmitsId: input.resubmitsId ?? null } });
      return { id };
    });
  } catch (e) { return mapDbError(e); }
}

export const reachVoidSchema = z.object({ reason: z.string().trim().min(2, '請寫刪除原因').max(300) }).strict();
export async function voidReach(actor: Actor, id: string, raw: z.input<typeof reachVoidSchema>) {
  requirePerm(actor, 'selection.write');
  const input = reachVoidSchema.parse(raw);
  assertNoPii({ 刪除原因: input.reason });
  return withTx(async (tx) => {
    const cur = await tx.query(`SELECT * FROM trial_reach_records WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [id, actor.orgId]);
    if (!cur.rowCount || cur.rows[0].deleted_at) throw notFound('觸及與導購資料');
    const r = cur.rows[0] as Record<string, unknown>;
    const t = await visibleTrial(actor, r.trial_id as string, true, tx as never);
    await tx.query(`UPDATE trial_reach_records SET deleted_at=now(), deleted_by=$2, delete_reason=$3, updated_by=$2 WHERE id=$1`, [id, actor.userId, input.reason]);
    await audit(tx, actor, { action: 'selection.trial.reach.remove', entityType: 'trial_reach_record', entityId: id, campaignId: t.campaign_id,
      before: { trialId: r.trial_id, metric: r.metric, value: r.value, periodStart: String(r.period_start), periodEnd: String(r.period_end) }, after: { reason: input.reason } });
    return { id, removed: true };
  });
}

/**
 * 查核有效導購訪客（K-4）：第二位有 product.review 權限的人，確認來源佐證與去重方式後標為「已查核」或「退回」。
 * 填寫者不能查核自己填的資料（服務層與資料庫都擋）；只能查核一次，要更正就刪除後重填。
 */
export const reachVerifySchema = z.object({ decision: z.enum(['VERIFIED', 'REJECTED']), note: z.string().trim().min(2, '請寫查核說明（查了什麼、憑什麼認定）').max(300) }).strict();
export async function verifyReach(actor: Actor, id: string, raw: z.input<typeof reachVerifySchema>) {
  requirePerm(actor, 'product.review');
  const input = reachVerifySchema.parse(raw);
  assertNoPii({ 查核說明: input.note });
  try {
    return await withTx(async (tx) => {
      const cur = await tx.query(`SELECT * FROM trial_reach_records WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [id, actor.orgId]);
      if (!cur.rowCount || cur.rows[0].deleted_at) throw notFound('觸及與導購資料');
      const r = cur.rows[0] as Record<string, unknown>;
      const t = await visibleTrial(actor, r.trial_id as string, true, tx as never);
      if (r.metric !== 'QUALIFIED_VISITORS') throw validation('只有「有效導購訪客」需要查核');
      if (r.verification_status !== 'UNVERIFIED') throw conflict('這筆資料已經查核過；要更正請刪除後重新填寫');
      if (r.created_by === actor.userId) throw forbidden('填寫者不能查核自己填的資料，請由另一位有權限的人查核');
      if (r.assigned_verifier_id && r.assigned_verifier_id !== actor.userId) throw forbidden('這筆資料已指派給另一位查核者，只有被指派者可以查核');
      await tx.query(`UPDATE trial_reach_records SET verification_status=$2, verified_by=$3, verified_at=now(), verify_note=$4, verify_rules_version=$5, updated_by=$3 WHERE id=$1`, [id, input.decision, actor.userId, input.note, REACH_RULES_VERSION]);
      await audit(tx, actor, { action: 'selection.trial.reach.verify', entityType: 'trial_reach_record', entityId: id, campaignId: t.campaign_id,
        before: { verificationStatus: r.verification_status }, after: { verificationStatus: input.decision, rulesVersion: REACH_RULES_VERSION, dedupeMethod: r.dedupe_method } });
      return { id, verificationStatus: input.decision };
    });
  } catch (e) { return mapDbError(e); }
}

// ---------------- K-4a：指派查核者、候選人、完整紀錄 ----------------
/** 有查核權限（product.review）的啟用中內部使用者（不含填寫者）：人力不足時可能是空的——此時資料維持「待查核」，不會自動通過 */
export async function verifierCandidates(orgId: string, createdBy: string): Promise<{ id: string; name: string; role: string }[]> {
  const roles = INTERNAL_ROLES.filter((r) => roleCan(r, 'product.review'));
  const rows = await query<{ id: string; name: string; role_key: string }>(`SELECT id, name, role_key FROM users WHERE organization_id=$1 AND status='ACTIVE' AND deleted_at IS NULL AND role_key = ANY($2::text[]) AND id <> $3 ORDER BY name`, [orgId, roles, createdBy]);
  return rows.map((r) => ({ id: r.id, name: r.name, role: r.role_key }));
}

export const reachAssignSchema = z.object({ userId: z.string().min(1).max(40), note: z.string().trim().max(300).optional() }).strict();
/**
 * 指派查核者（K-4a）：有 product.review 權限的主管，可以指派「另一位」具 product.review 權限的啟用中內部人員查核。
 * 被指派者不能是填寫者；指派後只有被指派者可以查核；可在查核前改派；已查核後不可再變更。沒有第二人時不會自動通過，維持待查核。
 */
export async function assignVerifier(actor: Actor, id: string, raw: z.input<typeof reachAssignSchema>) {
  requirePerm(actor, 'product.review');
  const input = reachAssignSchema.parse(raw);
  assertNoPii({ 指派說明: input.note });
  try {
    return await withTx(async (tx) => {
      const cur = await tx.query(`SELECT * FROM trial_reach_records WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [id, actor.orgId]);
      if (!cur.rowCount || cur.rows[0].deleted_at) throw notFound('觸及與導購資料');
      const r = cur.rows[0] as Record<string, unknown>;
      const t = await visibleTrial(actor, r.trial_id as string, true, tx as never);
      if (r.metric !== 'QUALIFIED_VISITORS') throw validation('只有「有效導購訪客」需要查核');
      if (r.verification_status !== 'UNVERIFIED') throw conflict('這筆資料已經查核過，不能再指派');
      if (input.userId === r.created_by) throw validation('不能指派填寫者查核自己填的資料');
      const u = await tx.query<{ role_key: string }>(`SELECT role_key FROM users WHERE id=$1 AND organization_id=$2 AND status='ACTIVE' AND deleted_at IS NULL`, [input.userId, actor.orgId]);
      if (!u.rowCount || !INTERNAL_ROLES.includes(u.rows[0].role_key as RoleKey) || !roleCan(u.rows[0].role_key as RoleKey, 'product.review')) throw validation('被指派者必須是啟用中、且具有查核權限（product.review）的內部人員');
      await tx.query(`UPDATE trial_reach_records SET assigned_verifier_id=$2, assigned_by=$3, assigned_at=now(), assignment_note=$4, updated_by=$3 WHERE id=$1`, [id, input.userId, actor.userId, input.note ?? null]);
      await audit(tx, actor, { action: 'selection.trial.reach.assign_verifier', entityType: 'trial_reach_record', entityId: id, campaignId: t.campaign_id,
        before: { assignedVerifierId: r.assigned_verifier_id ?? null }, after: { assignedVerifierId: input.userId } });
      return { id, assignedVerifierId: input.userId };
    });
  } catch (e) { return mapDbError(e); }
}

export interface ReachEvent { id: number; recordId: string; action: string; label: string; actorName: string | null; actorRole: string | null; occurredAt: string; detail: string | null }
const EVENT_LABEL: Record<string, string> = {
  'selection.trial.reach.add': '填寫', 'selection.trial.reach.assign_verifier': '指派查核者', 'selection.trial.reach.verify': '查核', 'selection.trial.reach.remove': '刪除',
};
/** 這個試用所有觸及與導購資料的完整事件紀錄：填寫、指派、查核（通過／退回）、補件、刪除（取自稽核紀錄；稽核內容不含敏感資料） */
export async function reachHistory(actor: Actor, trialId: string): Promise<ReachEvent[]> {
  requirePerm(actor, 'selection.read');
  await visibleTrial(actor, trialId, false);
  const rows = await query<{ id: string; entity_id: string; action: string; actor_role: string | null; occurred_at: string; before_data: Record<string, unknown> | null; after_data: Record<string, unknown> | null; reason: string | null; name: string | null }>(
    `SELECT a.id, a.entity_id, a.action, a.actor_role, a.occurred_at, a.before_data, a.after_data, a.reason, u.name FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id
     WHERE a.organization_id=$1 AND a.entity_type='trial_reach_record' AND a.entity_id IN (SELECT id FROM trial_reach_records WHERE trial_id=$2 AND organization_id=$1) AND a.action LIKE 'selection.trial.reach.%' ORDER BY a.id`, [actor.orgId, trialId]);
  return rows.map((r) => {
    const a = r.after_data ?? {};
    let label = EVENT_LABEL[r.action] ?? r.action;
    let detail: string | null = null;
    if (r.action === 'selection.trial.reach.add' && a.resubmitsId) { label = '補件（重新填寫）'; detail = `補件自 ${a.resubmitsId}`; }
    if (r.action === 'selection.trial.reach.verify') { label = a.verificationStatus === 'VERIFIED' ? '查核通過' : '查核退回'; detail = `規則 ${a.rulesVersion ?? ''}`; }
    if (r.action === 'selection.trial.reach.assign_verifier') detail = `指派給 ${a.assignedVerifierId ?? ''}`;
    if (r.action === 'selection.trial.reach.remove') detail = (a.reason as string | undefined) ?? null;
    return { id: Number(r.id), recordId: r.entity_id, action: r.action, label, actorName: r.name, actorRole: r.actor_role, occurredAt: new Date(r.occurred_at).toISOString(), detail };
  });
}
