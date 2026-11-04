import { z } from 'zod';
import { pool, query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { requirePerm } from '../lib/permissions';
import { notFound, precondition, validation } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids, todayTaipei } from '../lib/ids';
import { camelize } from '../lib/case';
import { campaignScope } from '../lib/scope';
import { CREDIBILITY, REACH_METRICS, REACH_SOURCE_KINDS, sourceProblem, type ReachMetric, type ReachRecord, type ReachSourceKind } from '../lib/trial-reach';
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

const SELECT = `SELECT r.*, u.name AS created_by_name FROM trial_reach_records r LEFT JOIN users u ON u.id=r.created_by`;
export function presentReach(r: Record<string, unknown>): ReachRecord {
  const c = camelize<Record<string, unknown>>(r);
  return {
    id: String(r.id), metric: r.metric as ReachMetric, value: Number(r.value), sourceKind: r.source_kind as ReachSourceKind, sourceText: String(r.source_text),
    periodStart: String(r.period_start), periodEnd: String(r.period_end), credibility: r.credibility as ReachRecord['credibility'], note: (r.note as string | null) ?? null,
    filledOn: String(r.filled_on), createdBy: String(r.created_by), createdByName: (c.createdByName as string | null) ?? null, createdAt: new Date(r.created_at as string).toISOString(),
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
  assertNoPii({ 來源說明: input.sourceText, 備註: input.note });
  const bad = sourceProblem(input.metric, input.sourceKind);
  if (bad) throw validation(bad);
  if (input.periodEnd < input.periodStart) throw validation('統計期間的結束日不能早於開始日');
  try {
    return await withTx(async (tx) => {
      const t = await visibleTrial(actor, trialId, true, tx as never);
      if (t.status === 'CANCELLED') throw precondition('已取消的試用不能新增觸及與導購資料');
      const id = await ids.reachRecord(tx);
      await tx.query(
        `INSERT INTO trial_reach_records (id, organization_id, trial_id, metric, value, source_kind, source_text, period_start, period_end, credibility, note, filled_on, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
        [id, actor.orgId, trialId, input.metric, input.value, input.sourceKind, input.sourceText, input.periodStart, input.periodEnd, input.credibility, input.note ?? null, todayTaipei(), actor.userId]);
      await audit(tx, actor, { action: 'selection.trial.reach.add', entityType: 'trial_reach_record', entityId: id, campaignId: t.campaign_id,
        after: { trialId, metric: input.metric, value: input.value, sourceKind: input.sourceKind, periodStart: input.periodStart, periodEnd: input.periodEnd, credibility: input.credibility } });
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
