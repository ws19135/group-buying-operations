import { z } from 'zod';
import type { Queryable, Tx } from '../lib/db';
import { pool, query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, requirePerm } from '../lib/permissions';
import { AppError, conflict, notFound, precondition, validation } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids, todayTaipei } from '../lib/ids';
import { camelize } from '../lib/case';
import { campaignScope } from '../lib/scope';
import { addDays } from '../lib/dates';
import { isIsoDate } from '../lib/dates';
import {
  COMPLIANCE_STATUSES, DEFAULT_SELECTION_CONFIG, SEL_KEYS, scoreSelection, selectionConfigProblems, submitProblems,
  type SelInput, type SelKey, type SelectionConfig,
} from '../lib/selection-score';
import { evidenceState } from '../lib/dd-catalog';
import { containsPii } from './aftersales';

/**
 * SOP 02 商品選品評估與選品設定。評分規則在 lib/selection-score.ts（純函式）；這裡負責取資料、版本、覆核、稽核。
 * 評估只是決策建議：不改商品審核狀態、不核准 G1。設計見 docs/phase2/PRODUCT_SELECTION_TRIAL.md。
 */
const CONFIG_KEY = 'selection.scoring';

// ---------------- 共用 ----------------
export async function assertCampaignVisible(actor: Actor, campaignId: string): Promise<Record<string, unknown>> {
  const sc = campaignScope(actor, 2, 'c');
  if (sc.sql === 'FALSE') throw notFound('檔期');
  const r = await query('SELECT c.id, c.title, c.status, c.vendor_id FROM campaigns c WHERE c.id=$1 AND (' + sc.sql + ')', [campaignId, ...sc.params]);
  if (!r.length) throw notFound('檔期');
  return r[0];
}

/** 該檔期是否在使用者的資料範圍內（不拋例外） */
export async function campaignVisible(actor: Actor, campaignId: string | null): Promise<boolean> {
  if (!campaignId) return true;
  try { await assertCampaignVisible(actor, campaignId); return true; } catch { return false; }
}

export async function loadProductBasic(db: Queryable, orgId: string, productId: string): Promise<{ id: string; name: string; category: string | null; vendorId: string; reviewStatus: string; complianceNote: string | null }> {
  const r = await db.query(`SELECT id, name, category, vendor_id, review_status, compliance_note FROM products WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL`, [productId, orgId]);
  if (!r.rowCount) throw notFound('商品');
  const p = r.rows[0] as Record<string, string | null>;
  return { id: p.id as string, name: p.name as string, category: p.category, vendorId: p.vendor_id as string, reviewStatus: p.review_status as string, complianceNote: p.compliance_note };
}

export function assertNoPii(fields: Record<string, string | null | undefined>): void {
  for (const [label, v] of Object.entries(fields)) if (containsPii(v)) throw validation(`「${label}」請勿填寫電話或 Email`);
}

/** 把 PG 唯一／檢查／觸發器錯誤轉成可讀的 409／422，其餘照舊拋出 */
export function mapDbError(e: unknown, uniqueMessage?: string): never {
  const err = e as { code?: string; message?: string; constraint?: string };
  if (err?.code === '23505') throw conflict(uniqueMessage ?? '資料重複，請重新整理後再試');
  if (err?.code === '23514') throw validation(`資料不符合規則（${err.constraint ?? '檢查條件'}）`);
  if (err?.code === '23001') throw precondition(err.message ?? '目前狀態不允許這個操作');
  throw e;
}

// ---------------- 設定（system_settings） ----------------
export const selectionConfigSchema = z.object({
  weights: z.object({ need: z.number(), quality: z.number(), profit: z.number(), supply: z.number(), content: z.number(), repeat: z.number() }).strict(),
  thresholds: z.object({ proceed: z.number(), supplement: z.number(), minCompleteness: z.number(), highConfidence: z.number(), mediumConfidence: z.number() }).strict().optional(),
  ddValidDays: z.number().int().optional(),
  trialValidDays: z.number().int().optional(),
  expiringSoonDays: z.number().int().optional(),
  evidenceHosts: z.array(z.string().trim().toLowerCase().regex(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/, '網域格式不正確（例：drive.example.com）')).max(30).optional(),
  approved: z.boolean().optional(),
  version: z.number().int().optional(),
});

export async function loadSelectionConfig(db: Queryable, orgId: string): Promise<SelectionConfig & { persisted: boolean }> {
  const r = await db.query<{ value: Partial<SelectionConfig> }>('SELECT value FROM system_settings WHERE organization_id=$1 AND key=$2', [orgId, CONFIG_KEY]);
  const v = r.rows[0]?.value;
  if (!v) return { ...DEFAULT_SELECTION_CONFIG, persisted: false };
  return {
    ...DEFAULT_SELECTION_CONFIG, ...v,
    weights: { ...DEFAULT_SELECTION_CONFIG.weights, ...(v.weights ?? {}) },
    thresholds: { ...DEFAULT_SELECTION_CONFIG.thresholds, ...(v.thresholds ?? {}) },
    persisted: true,
  };
}
const configStatus = (c: { approved: boolean }) => (c.approved ? '已確認採用' : '建議值，待 Owner 確認');

export async function getSelectionConfig(actor: Actor) {
  requirePerm(actor, 'selection.read');
  const c = await loadSelectionConfig(pool(), actor.orgId);
  return { ...c, status: configStatus(c) };
}

export async function putSelectionConfig(actor: Actor, raw: z.input<typeof selectionConfigSchema>) {
  requirePerm(actor, 'selection.config');
  const input = selectionConfigSchema.parse(raw);
  return withTx(async (tx) => {
    const prev = await loadSelectionConfig(tx, actor.orgId);
    if (input.version != null && input.version !== prev.version) throw new AppError('CONFLICT', '選品設定已被其他人更新，請重新整理後再試', { currentVersion: prev.version });
    const next: SelectionConfig = {
      version: prev.version + 1,   // 內建建議值是版本 1，第一次儲存＝版本 2
      approved: input.approved ?? false,
      weights: input.weights,
      thresholds: input.thresholds ?? prev.thresholds,
      ddValidDays: input.ddValidDays ?? prev.ddValidDays,
      trialValidDays: input.trialValidDays ?? prev.trialValidDays,
      expiringSoonDays: input.expiringSoonDays ?? prev.expiringSoonDays,
      evidenceHosts: input.evidenceHosts ?? prev.evidenceHosts,
    };
    const problems = selectionConfigProblems(next);
    if (problems.length) throw validation(problems.join('；'), { problems });
    await tx.query(
      `INSERT INTO system_settings (organization_id, key, value, updated_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (organization_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`,
      [actor.orgId, CONFIG_KEY, JSON.stringify(next), actor.userId]);
    await audit(tx, actor, { action: 'selection.config.update', entityType: 'selection_config', entityId: CONFIG_KEY,
      before: { version: prev.version, approved: prev.approved, weights: prev.weights, thresholds: prev.thresholds, ddValidDays: prev.ddValidDays, trialValidDays: prev.trialValidDays, evidenceHosts: prev.evidenceHosts },
      after: { version: next.version, approved: next.approved, weights: next.weights, thresholds: next.thresholds, ddValidDays: next.ddValidDays, trialValidDays: next.trialValidDays, evidenceHosts: next.evidenceHosts } });
    return { ...next, persisted: true, status: configStatus(next) };
  });
}

// ---------------- 商品選品評估 ----------------
const reasonText = z.string().trim().max(500);
const scoreEntry = z.object({
  score: z.number().int('分數需為整數').min(1, '分數最低 1').max(5, '分數最高 5').nullable().optional(),
  reason: reasonText.nullable().optional(),
  evidenceIds: z.array(z.string().max(40)).max(20).optional(),
}).strict();
const scoresShape = Object.fromEntries(SEL_KEYS.map((k) => [k, scoreEntry.optional()])) as Record<SelKey, z.ZodOptional<typeof scoreEntry>>;
export const evaluationPatchSchema = z.object({
  scores: z.object(scoresShape).strict().optional(),
  compliance: z.object({ status: z.enum(COMPLIANCE_STATUSES), note: reasonText.nullable().optional(), evidenceIds: z.array(z.string().max(40)).max(20).optional() }).strict().optional(),
  evaluatedOn: z.string().refine(isIsoDate, '日期格式需為 YYYY-MM-DD').optional(),
  version: z.number().int().optional(),
}).strict();

interface StoredScore { score: number | null; reason: string | null; evidenceIds: string[]; evidenceCount?: number }
interface EvalRow {
  id: string; product_id: string; version_no: number; status: string; scores: Record<string, StoredScore>; compliance: { status?: string; note?: string | null; evidenceIds?: string[] };
  config_version: number | null; config_snapshot: SelectionConfig | null; total_score: number | null; completeness: number | null; confidence: string | null; recommendation: string | null;
  evidence_gaps: string[] | null; evaluator_id: string | null; evaluated_on: string | null; submitted_at: string | null; review_decision: string | null; review_note: string | null;
  reviewed_by: string | null; reviewed_at: string | null; superseded_at: string | null; version: number;
}

async function validEvidenceCount(db: Queryable, orgId: string, evalId: string, idsList: string[], today: string, soon: number): Promise<number> {
  if (!idsList.length) return 0;
  const r = await db.query<{ id: string; valid_until: string | null }>(
    `SELECT id, valid_until FROM evidence_items WHERE organization_id=$1 AND subject_type='EVALUATION' AND subject_id=$2 AND deleted_at IS NULL AND id = ANY($3::text[])`, [orgId, evalId, idsList]);
  return r.rows.filter((e) => evidenceState({ id: e.id, validUntil: e.valid_until }, today, soon) !== 'EXPIRED').length;
}

async function toSelInput(db: Queryable, orgId: string, row: Pick<EvalRow, 'id' | 'scores' | 'compliance'>, cfg: SelectionConfig, today: string): Promise<SelInput> {
  const scores: SelInput['scores'] = {};
  for (const k of SEL_KEYS) {
    const s = row.scores?.[k];
    if (!s) continue;
    scores[k] = { score: s.score ?? null, reason: s.reason ?? null, evidenceCount: await validEvidenceCount(db, orgId, row.id, s.evidenceIds ?? [], today, cfg.expiringSoonDays) };
  }
  const cs = (row.compliance?.status ?? 'UNKNOWN') as SelInput['compliance']['status'];
  return { scores, compliance: { status: cs, note: row.compliance?.note ?? null } };
}

const SELECT_EVAL = `SELECT e.*, u.name AS evaluator_name, ru.name AS reviewed_by_name FROM product_evaluations e
  LEFT JOIN users u ON u.id=e.evaluator_id LEFT JOIN users ru ON ru.id=e.reviewed_by`;

export async function evidenceFor(db: Queryable, orgId: string, subjectType: string, subjectIds: string[], today: string, soon: number) {
  if (!subjectIds.length) return new Map<string, unknown[]>();
  const r = await db.query(
    `SELECT id, subject_id, kind, title, url, source_label, valid_from, valid_until, note, asset_id, created_at FROM evidence_items
     WHERE organization_id=$1 AND subject_type=$2 AND subject_id = ANY($3::text[]) AND deleted_at IS NULL ORDER BY created_at, id`, [orgId, subjectType, subjectIds]);
  const m = new Map<string, unknown[]>();
  for (const e of camelize<{ id: string; subjectId: string; validUntil: string | null }[]>(r.rows)) {
    const list = m.get(e.subjectId) ?? [];
    list.push({ ...e, state: evidenceState({ id: e.id, validUntil: e.validUntil }, today, soon) });
    m.set(e.subjectId, list);
  }
  return m;
}

export interface EvaluationView {
  id: string; productId: string; versionNo: number; status: string; totalScore: number | null; completeness: number | null; confidence: string | null; recommendation: string | null;
  evidenceGaps: string[] | null; compliance: { status?: string; note?: string | null }; scores: Record<string, StoredScore>; configVersion: number | null;
  configSnapshot: { weights: Record<string, number>; thresholds: Record<string, number> } | null; evaluatedOn: string | null; evaluatorName: string | null;
  reviewDecision: string | null; reviewNote: string | null; reviewedByName: string | null; supersededAt: string | null; version: number;
  evidence: unknown[]; preview: ReturnType<typeof scoreSelection> | null; current: boolean; [k: string]: unknown;
}

async function present(db: Queryable, orgId: string, rows: (EvalRow & Record<string, unknown>)[], cfg: SelectionConfig): Promise<EvaluationView[]> {
  const today = todayTaipei();
  const ev = await evidenceFor(db, orgId, 'EVALUATION', rows.map((r) => r.id), today, cfg.expiringSoonDays);
  const out: EvaluationView[] = [];
  for (const r of rows) {
    // 草稿：用目前設定即時試算（預覽）；已送出：顯示當時保存的結果與設定快照
    const preview = r.status === 'DRAFT' ? scoreSelection(await toSelInput(db, orgId, r, cfg, today), cfg) : null;
    out.push({ ...camelize<Record<string, unknown>>(r), evidence: ev.get(r.id) ?? [], preview, current: r.status === 'SUBMITTED' && !r.superseded_at } as EvaluationView);
  }
  return out;
}

async function fitReference(db: Queryable, orgId: string, productId: string) {
  const r = await db.query<{ recommendation: string; n: number; top: number | null }>(
    `SELECT recommendation, count(*)::int AS n, max(total_score) AS top FROM product_fit_assessments
     WHERE organization_id=$1 AND product_id=$2 AND superseded_at IS NULL AND campaign_id IS NULL GROUP BY recommendation`, [orgId, productId]);
  return { byRecommendation: Object.fromEntries(r.rows.map((x) => [x.recommendation, { hosts: Number(x.n), topScore: x.top == null ? null : Number(x.top) }])), note: '唯讀參考（SOP 01 客群適配）：不複製、不重算，請評估人自行判斷後填寫「客群需求符合度」' };
}

export async function listProductEvaluations(actor: Actor, productId: string) {
  requirePerm(actor, 'selection.read');
  const p = await loadProductBasic(pool(), actor.orgId, productId);
  const cfg = await loadSelectionConfig(pool(), actor.orgId);
  const rows = await query(`${SELECT_EVAL} WHERE e.organization_id=$1 AND e.product_id=$2 ORDER BY e.version_no DESC`, [actor.orgId, productId]);
  const items = await present(pool(), actor.orgId, rows as never, cfg);
  return {
    productId, productName: p.name, productCategory: p.category, reviewStatus: p.reviewStatus,
    config: { version: cfg.version, approved: cfg.approved, status: configStatus(cfg), weights: cfg.weights, thresholds: cfg.thresholds },
    draft: items.find((i) => i.status === 'DRAFT') ?? null,
    current: items.find((i) => i.current) ?? null,
    versions: items,
    fitReference: can(actor, 'fit.read') ? await fitReference(pool(), actor.orgId, productId) : null,
  };
}

export async function createEvaluation(actor: Actor, productId: string) {
  requirePerm(actor, 'selection.write');
  await loadProductBasic(pool(), actor.orgId, productId);
  try {
    return await withTx(async (tx) => {
      const mx = await tx.query<{ n: number }>('SELECT coalesce(max(version_no),0)::int AS n FROM product_evaluations WHERE product_id=$1', [productId]);
      const id = await ids.evaluation(tx);
      const versionNo = Number(mx.rows[0].n) + 1;
      await tx.query(`INSERT INTO product_evaluations (id, organization_id, product_id, version_no, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$5)`, [id, actor.orgId, productId, versionNo, actor.userId]);
      await audit(tx, actor, { action: 'selection.evaluation.create', entityType: 'product_evaluation', entityId: id, after: { productId, versionNo } });
      return { id, productId, versionNo };
    });
  } catch (e) { return mapDbError(e, '這個商品已有一份進行中的評估草稿，請先送出或繼續編輯'); }
}

async function lockEval(tx: Tx, actor: Actor, id: string): Promise<EvalRow & Record<string, unknown>> {
  const cur = await tx.query(`SELECT * FROM product_evaluations WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [id, actor.orgId]);
  if (!cur.rowCount) throw notFound('選品評估');
  return cur.rows[0] as never;
}

export async function getEvaluation(actor: Actor, id: string) {
  requirePerm(actor, 'selection.read');
  const rows = await query(`${SELECT_EVAL} WHERE e.id=$1 AND e.organization_id=$2`, [id, actor.orgId]);
  if (!rows.length) throw notFound('選品評估');
  const cfg = await loadSelectionConfig(pool(), actor.orgId);
  const [item] = await present(pool(), actor.orgId, rows as never, cfg);
  return item;
}

export async function updateEvaluation(actor: Actor, id: string, raw: z.input<typeof evaluationPatchSchema>) {
  requirePerm(actor, 'selection.write');
  const input = evaluationPatchSchema.parse(raw);
  for (const k of SEL_KEYS) assertNoPii({ [`${k} 理由`]: input.scores?.[k]?.reason });
  assertNoPii({ 合規說明: input.compliance?.note });
  return withTx(async (tx) => {
    const row = await lockEval(tx, actor, id);
    if (row.status !== 'DRAFT') throw precondition('已送出的評估不可修改；請建立新版本');
    if (input.version != null && input.version !== row.version) throw conflict('資料已被其他人更新，請重新整理後再試', { currentVersion: row.version });
    const scores: Record<string, StoredScore> = { ...(row.scores ?? {}) };
    for (const k of SEL_KEYS) {
      const s = input.scores?.[k];
      if (!s) continue;
      const evidenceIds = s.evidenceIds ?? scores[k]?.evidenceIds ?? [];
      scores[k] = { score: s.score ?? null, reason: s.reason?.trim() || null, evidenceIds };
    }
    let compliance = row.compliance ?? {};
    if (input.compliance) compliance = { status: input.compliance.status, note: input.compliance.note?.trim() || null, evidenceIds: input.compliance.evidenceIds ?? compliance.evidenceIds ?? [] };
    // 引用的證據必須是這份評估自己的證據
    const refs = [...new Set([...Object.values(scores).flatMap((s) => s.evidenceIds ?? []), ...(compliance.evidenceIds ?? [])])];
    if (refs.length) {
      const ok = await tx.query<{ id: string }>(`SELECT id FROM evidence_items WHERE organization_id=$1 AND subject_type='EVALUATION' AND subject_id=$2 AND deleted_at IS NULL AND id = ANY($3::text[])`, [actor.orgId, id, refs]);
      const found = new Set(ok.rows.map((r) => r.id));
      const bad = refs.filter((r) => !found.has(r));
      if (bad.length) throw validation(`引用的證據不屬於這份評估：${bad.join('、')}`);
    }
    await tx.query(`UPDATE product_evaluations SET scores=$2, compliance=$3, evaluated_on=coalesce($4, evaluated_on), updated_by=$5 WHERE id=$1`,
      [id, JSON.stringify(scores), JSON.stringify(compliance), input.evaluatedOn ?? null, actor.userId]);
    await audit(tx, actor, { action: 'selection.evaluation.update', entityType: 'product_evaluation', entityId: id,
      before: { scores: row.scores, compliance: row.compliance }, after: { scores, compliance } });
    return { id };
  }).then(() => getEvaluation(actor, id));
}

export async function submitEvaluation(actor: Actor, id: string) {
  requirePerm(actor, 'selection.write');
  return withTx(async (tx) => {
    const row = await lockEval(tx, actor, id);
    if (row.status !== 'DRAFT') throw precondition('這份評估已送出');
    const cfg = await loadSelectionConfig(tx, actor.orgId);
    const today = todayTaipei();
    const input = await toSelInput(tx, actor.orgId, row, cfg, today);
    const problems = submitProblems(input);
    if (!SEL_KEYS.some((k) => input.scores[k]?.score != null)) problems.push('至少要有一項評分才能送出');
    if (problems.length) throw validation(problems.join('；'), { problems });
    const res = scoreSelection(input, cfg);
    const scores: Record<string, StoredScore> = {};
    for (const k of SEL_KEYS) { const s = row.scores?.[k]; if (s) scores[k] = { ...s, evidenceCount: input.scores[k]?.evidenceCount ?? 0 }; }
    const snapshot = { version: cfg.version, approved: cfg.approved, weights: cfg.weights, thresholds: cfg.thresholds, expiringSoonDays: cfg.expiringSoonDays };
    const evaluatedOn = (row.evaluated_on as string | null) ?? today;
    await tx.query(
      `UPDATE product_evaluations SET status='SUBMITTED', scores=$2, config_version=$3, config_snapshot=$4, total_score=$5, completeness=$6, confidence=$7, recommendation=$8,
         evidence_gaps=$9, evaluator_id=$10, evaluated_on=$11, submitted_at=now(), updated_by=$10 WHERE id=$1`,
      [id, JSON.stringify(scores), cfg.version, JSON.stringify(snapshot), res.totalScore, res.completeness, res.confidence, res.recommendation, JSON.stringify(res.evidenceGaps), actor.userId, evaluatedOn]);
    const old = await tx.query(`UPDATE product_evaluations SET superseded_at=now() WHERE product_id=$1 AND id<>$2 AND status='SUBMITTED' AND superseded_at IS NULL RETURNING id`, [row.product_id, id]);
    await audit(tx, actor, { action: 'selection.evaluation.submit', entityType: 'product_evaluation', entityId: id,
      after: { productId: row.product_id, versionNo: row.version_no, totalScore: res.totalScore, recommendation: res.recommendation, confidence: res.confidence, completeness: res.completeness, configVersion: cfg.version, supersedes: old.rows.map((r) => r.id) } });
    return { id, totalScore: res.totalScore, recommendation: res.recommendation, confidence: res.confidence, completeness: res.completeness, reasons: res.reasons, evidenceGaps: res.evidenceGaps, supersedes: old.rows.map((r) => r.id) };
  });
}

export const evalReviewSchema = z.object({ decision: z.enum(['ACCEPTED', 'REJECTED', 'NEEDS_MORE']), note: z.string().trim().max(1000).optional().or(z.literal('').transform(() => undefined)) });

/** 覆核只記錄人的意見：不改評分、不改商品審核狀態、不核准 G1 */
export async function reviewEvaluation(actor: Actor, id: string, raw: z.input<typeof evalReviewSchema>) {
  requirePerm(actor, 'product.review');
  requirePerm(actor, 'selection.read');
  const input = evalReviewSchema.parse(raw);
  if (input.decision !== 'ACCEPTED' && !input.note) throw validation('不採用或需補資料時，請填寫原因');
  assertNoPii({ 覆核意見: input.note });
  return withTx(async (tx) => {
    const row = await lockEval(tx, actor, id);
    if (row.status !== 'SUBMITTED') throw precondition('草稿尚未送出，不能覆核');
    if (row.superseded_at) throw conflict('這份評估已被新版本取代，請覆核最新版本');
    await tx.query(`UPDATE product_evaluations SET review_decision=$2, review_note=$3, reviewed_by=$4, reviewed_at=now(), updated_by=$4 WHERE id=$1`, [id, input.decision, input.note ?? null, actor.userId]);
    await audit(tx, actor, { action: 'selection.evaluation.review', entityType: 'product_evaluation', entityId: id,
      before: { reviewDecision: row.review_decision ?? null }, after: { reviewDecision: input.decision, reviewNote: input.note ?? null, recommendation: row.recommendation, totalScore: row.total_score } });
    return { id, reviewDecision: input.decision };
  });
}

/** 供 G1 摘要等唯讀使用：該商品現行（已送出、未被取代）的評估 */
export async function currentEvaluation(db: Queryable, orgId: string, productId: string) {
  const r = await db.query(`${SELECT_EVAL} WHERE e.organization_id=$1 AND e.product_id=$2 AND e.status='SUBMITTED' AND e.superseded_at IS NULL ORDER BY e.version_no DESC LIMIT 1`, [orgId, productId]);
  return r.rows[0] ? camelize<Record<string, unknown>>(r.rows[0]) : null;
}

// ---------------- 總覽（/selection） ----------------
export async function selectionOverview(actor: Actor) {
  requirePerm(actor, 'selection.read');
  const cfg = await loadSelectionConfig(pool(), actor.orgId);
  const today = todayTaipei();
  const soon = addDays(today, cfg.expiringSoonDays);
  const sc = campaignScope(actor, 2, 'c');
  const trialScope = sc.sql === 'FALSE' ? 't.campaign_id IS NULL' : `(t.campaign_id IS NULL OR EXISTS (SELECT 1 FROM campaigns c WHERE c.id=t.campaign_id AND (${sc.sql})))`;
  const sensitiveOk = can(actor, 'product.cost.read');
  const [evals, dds, trials, recov, expiring] = await Promise.all([
    query(`SELECT e.id, e.product_id, p.name AS product_name, e.version_no, e.total_score, e.recommendation, e.submitted_at FROM product_evaluations e JOIN products p ON p.id=e.product_id
           WHERE e.organization_id=$1 AND e.status='SUBMITTED' AND e.superseded_at IS NULL AND e.review_decision IS NULL ORDER BY e.submitted_at DESC LIMIT 30`, [actor.orgId]),
    query(`SELECT r.id, r.vendor_id, v.name AS vendor_name, r.product_id, r.contract_version, r.submitted_at FROM vendor_dd_records r JOIN vendors v ON v.id=r.vendor_id
           WHERE r.organization_id=$1 AND r.status='IN_REVIEW' AND r.deleted_at IS NULL ORDER BY r.submitted_at DESC LIMIT 30`, [actor.orgId]),
    query(`SELECT t.id, t.product_id, p.name AS product_name, t.level, t.trial_type, t.conclusion, t.concluded_at, t.campaign_id FROM product_trials t JOIN products p ON p.id=t.product_id
           WHERE t.organization_id=$1 AND t.status='CONCLUDED' AND t.review_decision IS NULL AND ${trialScope} ORDER BY t.concluded_at DESC LIMIT 30`, [actor.orgId, ...sc.params]),
    query(`SELECT count(*)::int AS n FROM product_trials t WHERE t.organization_id=$1 AND t.recovery_status='PENDING' AND t.status <> 'CANCELLED' AND ${trialScope}`, [actor.orgId, ...sc.params]),
    query(`SELECT x.id, x.subject_type, x.subject_id, x.kind, x.title, x.valid_until, x.vendor_id, x.product_id,
             CASE WHEN x.valid_until < $2::date THEN 'EXPIRED' ELSE 'EXPIRING' END AS state
           FROM evidence_items x LEFT JOIN vendor_dd_items i ON x.subject_type='DD_ITEM' AND i.id=x.subject_id
           WHERE x.organization_id=$1 AND x.deleted_at IS NULL AND x.valid_until IS NOT NULL AND x.valid_until <= $3::date
             AND ($4::boolean OR i.category_key IS DISTINCT FROM 'COMMISSION_TERMS')
           ORDER BY x.valid_until LIMIT 40`, [actor.orgId, today, soon, sensitiveOk]),
  ]);
  return {
    config: { ...cfg, status: configStatus(cfg) },
    pendingEvaluations: camelize(evals), ddInReview: camelize(dds), trialsToReview: camelize(trials),
    recoveryPending: Number(recov[0].n),
    expiringEvidence: camelize(expiring),
    canReview: can(actor, 'product.review'), canConfig: can(actor, 'selection.config'),
  };
}

