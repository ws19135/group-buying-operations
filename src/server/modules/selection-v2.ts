import { z } from 'zod';
import type { Queryable, Tx } from '../lib/db';
import { pool, query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, requirePerm } from '../lib/permissions';
import { AppError, conflict, notFound, precondition, validation } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids, todayTaipei } from '../lib/ids';
import { camelize } from '../lib/case';
import { SALES_STATUSES } from '../lib/kpi';
import { evidenceState, suspectRegulated } from '../lib/dd-catalog';
import { COMPLIANCE_STATUSES, type ComplianceStatus } from '../lib/selection-score';
import {
  COMMERCE_MODELS, CATALOG_VERSION, COND_BY_ID, CONDITIONS, DEFAULT_V2_CONFIG, v2ConfigProblems, type CommerceModel, type V2Config,
} from '../lib/selection-v2-catalog';
import {
  manualInputProblems, maskV2Result, scoreV2, submitProblemsV2, type AutoEntry, type ManualEntry, type V2Context, type V2Input, type V2Result,
} from '../lib/selection-v2-score';

/**
 * SOP 02 選品評分 V2 的資料層：設定、自動取值、草稿更新與送出、補件要求。計分公式在 lib/selection-v2-score.ts（純函式）。
 * 注意：這個檔案不可 import selection.ts／diligence.ts（selection.ts 會呼叫這裡，避免循環相依）。
 * 評估只是決策建議：不改商品審核狀態、不核准 G1。
 */
export const V2_KEY = 'selection.scoring.v2';
const nz = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

// ---------------- 設定（system_settings，版本化） ----------------
const thresholdSchema = z.object({ floor: z.number().optional(), target: z.number().optional(), lo: z.number().optional(), hi: z.number().optional(), tol: z.number().optional() }).strict();
const dimW = z.object({ need: z.number(), quality: z.number(), profit: z.number(), supply: z.number(), content: z.number(), repeat: z.number() }).strict();
export const v2ConfigSchema = z.object({
  dimWeights: dimW.optional(),
  condWeights: z.record(z.number()).optional(),
  thresholds: z.record(thresholdSchema).optional(),
  modelThresholds: z.record(z.record(thresholdSchema)).optional(),
  proceed: z.number().optional(), supplement: z.number().optional(), minCompleteness: z.number().optional(), highConfidence: z.number().optional(), mediumConfidence: z.number().optional(),
  highEvidence: z.number().optional(), mediumEvidence: z.number().optional(), naShareMax: z.number().optional(),
  minSample: z.object({ orders: z.number().int(), buyers: z.number().int() }).strict().optional(),
  approved: z.boolean().optional(),
  enabled: z.boolean().optional(),
  version: z.number().int().optional(),
}).strict();

export async function loadV2Config(db: Queryable, orgId: string): Promise<V2Config & { persisted: boolean }> {
  const r = await db.query<{ value: Partial<V2Config> }>('SELECT value FROM system_settings WHERE organization_id=$1 AND key=$2', [orgId, V2_KEY]);
  const v = r.rows[0]?.value;
  if (!v) return { ...DEFAULT_V2_CONFIG, persisted: false };
  return {
    ...DEFAULT_V2_CONFIG, ...v,
    dimWeights: { ...DEFAULT_V2_CONFIG.dimWeights, ...(v.dimWeights ?? {}) },
    condWeights: { ...(v.condWeights ?? {}) }, thresholds: { ...(v.thresholds ?? {}) }, modelThresholds: { ...(v.modelThresholds ?? {}) },
    minSample: { ...DEFAULT_V2_CONFIG.minSample, ...(v.minSample ?? {}) },
    persisted: true,
  };
}
const v2Status = (c: { approved: boolean }) => (c.approved ? '已確認採用' : '提案設定，待 Owner 核准');

export async function getV2Config(actor: Actor) {
  requirePerm(actor, 'selection.read');
  const c = await loadV2Config(pool(), actor.orgId);
  return { ...c, status: v2Status(c), catalogVersion: CATALOG_VERSION, conditions: CONDITIONS.map(({ id, dim, label, desc, kind, source, evidence, weight, hard, sensitive, naRule, unit, direction, threshold, modelThreshold, options, basis }) => ({ id, dim, label, desc, kind, source, evidence, weight, hard: !!hard, sensitive: !!sensitive, naRule: naRule ?? null, unit: unit ?? null, direction: direction ?? null, threshold: threshold ?? null, modelThreshold: modelThreshold ?? null, options: options ?? null, basis })) };
}

export async function putV2Config(actor: Actor, raw: z.input<typeof v2ConfigSchema>) {
  requirePerm(actor, 'selection.config');
  const input = v2ConfigSchema.parse(raw);
  return withTx(async (tx) => {
    const prev = await loadV2Config(tx, actor.orgId);
    if (input.version != null && input.version !== prev.version) throw new AppError('CONFLICT', '選品 V2 設定已被其他人更新，請重新整理後再試', { currentVersion: prev.version });
    const { persisted: _p, ...base } = prev; void _p;
    const next: V2Config = {
      ...base, version: prev.version + 1,
      dimWeights: input.dimWeights ?? prev.dimWeights,
      condWeights: input.condWeights ?? prev.condWeights,
      thresholds: (input.thresholds ?? prev.thresholds) as V2Config['thresholds'],
      modelThresholds: (input.modelThresholds ?? prev.modelThresholds) as V2Config['modelThresholds'],
      proceed: input.proceed ?? prev.proceed, supplement: input.supplement ?? prev.supplement, minCompleteness: input.minCompleteness ?? prev.minCompleteness,
      highConfidence: input.highConfidence ?? prev.highConfidence, mediumConfidence: input.mediumConfidence ?? prev.mediumConfidence,
      highEvidence: input.highEvidence ?? prev.highEvidence, mediumEvidence: input.mediumEvidence ?? prev.mediumEvidence, naShareMax: input.naShareMax ?? prev.naShareMax,
      minSample: input.minSample ?? prev.minSample,
      approved: input.approved ?? false,   // 沒有明確核准就是提案
      enabled: input.enabled ?? prev.enabled,
    };
    const problems = v2ConfigProblems(next);
    if (problems.length) throw validation(problems.join('；'), { problems });
    await tx.query(
      `INSERT INTO system_settings (organization_id, key, value, updated_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (organization_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`,
      [actor.orgId, V2_KEY, JSON.stringify(next), actor.userId]);
    await audit(tx, actor, { action: 'selection.config.update', entityType: 'selection_config', entityId: V2_KEY,
      before: { version: prev.version, approved: prev.approved, enabled: prev.enabled, dimWeights: prev.dimWeights, proceed: prev.proceed, supplement: prev.supplement },
      after: { version: next.version, approved: next.approved, enabled: next.enabled, dimWeights: next.dimWeights, proceed: next.proceed, supplement: next.supplement } });
    return { ...next, persisted: true, status: v2Status(next) };
  });
}

// ---------------- 自動取值 ----------------
interface ProductLite { id: string; name: string; category: string | null; vendor_id: string }
const unknown = (reason: string): AutoEntry => ({ value: null, unknownReason: reason });
const pct1 = (n: number) => Math.round(n * 10) / 10;

interface DdPick { id: string; status: string; valid_until: string | null; contract_version: string; regulated_category: string | null; superseded_at: string | null; product_id: string | null }
/**
 * 挑選適用的廠商調查（同一規則也用在 G1 摘要）。優先順序：
 *  0 商品專屬、已核准且未被取代 → 1 商品專屬、已退回／撤銷，或含法務封鎖項（明確的否定決定仍要看得見）
 *  → 2 廠商層級、已核准且未被取代 → 3 商品專屬的草稿／審查中（進行中的作業，不能蓋過已核准的廠商層級調查）→ 4 其餘；同級取最新。
 * 已核准但到期或證據過期的調查仍會被選到，讓過期風險被看見，而不是被別份悄悄取代。
 */
export async function pickDdRecord(db: Queryable, orgId: string, vendorId: string, productId: string | null): Promise<DdPick | null> {
  const r = await db.query<DdPick>(
    `SELECT r.id, r.status, r.valid_until, r.contract_version, r.regulated_category, r.superseded_at, r.product_id FROM vendor_dd_records r
     WHERE r.organization_id=$1 AND r.vendor_id=$2 AND r.deleted_at IS NULL AND (r.product_id IS NULL OR r.product_id=$3)
     ORDER BY CASE
         WHEN r.product_id IS NOT NULL AND r.status='APPROVED' AND r.superseded_at IS NULL THEN 0
         WHEN r.product_id IS NOT NULL AND (r.status='REJECTED' OR EXISTS (SELECT 1 FROM vendor_dd_items i WHERE i.record_id=r.id AND i.legal_status='BLOCKED')) THEN 1
         WHEN r.product_id IS NULL AND r.status='APPROVED' AND r.superseded_at IS NULL THEN 2
         WHEN r.product_id IS NOT NULL THEN 3 ELSE 4 END, r.created_at DESC, r.id DESC LIMIT 1`,
    [orgId, vendorId, productId]);
  return r.rows[0] ?? null;
}

export interface AutoBundle { auto: Record<string, AutoEntry>; regulatedSuspected: boolean; vendorId: string; ddRecordId: string | null }

/** 只用「可信、可追溯」的資料；取不到就回「未知＋原因」，絕不捏造數值。敏感欄位（成本、分潤）只在伺服器內運算。 */
export async function resolveAuto(db: Queryable, orgId: string, product: ProductLite, today = todayTaipei()): Promise<AutoBundle> {
  const auto: Record<string, AutoEntry> = {};
  const pid = product.id;

  // SOP 01 適配（唯讀）
  const fit = await db.query<{ id: string; total_score: number | null; review_decision: string | null; assessed_at: string }>(
    `SELECT id, total_score, review_decision, assessed_at FROM product_fit_assessments WHERE organization_id=$1 AND product_id=$2 AND superseded_at IS NULL AND campaign_id IS NULL ORDER BY total_score DESC NULLS LAST, id`, [orgId, pid]);
  if (!fit.rowCount) { auto['fit.topScore'] = unknown('SOP 01 尚無這個商品的適配評估'); auto['fit.reviewed'] = unknown('SOP 01 尚無這個商品的適配評估'); }
  else {
    const top = fit.rows.find((x) => x.total_score != null);
    auto['fit.topScore'] = top ? { value: Number(top.total_score), sourceLabel: 'SOP 01 商品適配評估（最高分）', sourceRefs: [top.id], asOf: String(top.assessed_at).slice(0, 10), sampleSize: fit.rowCount } : unknown('適配評估沒有總分（資料不足）');
    auto['fit.reviewed'] = { value: fit.rows.some((x) => x.review_decision === 'ACCEPTED'), sourceLabel: 'SOP 01 適配評估覆核決定', sourceRefs: fit.rows.map((x) => x.id), sampleSize: fit.rowCount };
  }

  // SKU 價格（成本屬敏感，只算比率）
  const skus = (await db.query<{ id: string; list_price: number | null; group_price: number | null; cost_price: number | null }>(
    `SELECT id, list_price, group_price, cost_price FROM skus WHERE organization_id=$1 AND product_id=$2 AND status='ACTIVE' AND deleted_at IS NULL ORDER BY id`, [orgId, pid])).rows;
  const withG = skus.filter((s) => s.group_price != null && Number(s.group_price) > 0);
  if (!skus.length) { auto['sku.grossMargin'] = unknown('商品沒有啟用中的規格'); auto['sku.discountDepth'] = unknown('商品沒有啟用中的規格'); }
  else {
    const gm = withG.filter((s) => s.cost_price != null);
    auto['sku.grossMargin'] = gm.length === skus.length && gm.length
      ? { value: pct1(Math.min(...gm.map((s) => ((Number(s.group_price) - Number(s.cost_price)) / Number(s.group_price)) * 100))), sourceLabel: 'SKU 團購價與成本價（取最低毛利）', sourceRefs: skus.map((s) => s.id), sampleSize: skus.length }
      : unknown('有規格缺少團購價或成本價');
    const dd = withG.filter((s) => s.list_price != null && Number(s.list_price) > 0);
    auto['sku.discountDepth'] = dd.length === skus.length && dd.length
      ? { value: pct1(dd.reduce((a, s) => a + (1 - Number(s.group_price) / Number(s.list_price)) * 100, 0) / dd.length), sourceLabel: 'SKU 原價與團購價（平均折扣）', sourceRefs: skus.map((s) => s.id), sampleSize: skus.length }
      : unknown('有規格缺少原價或團購價');
  }

  // SOP 03 可行性試算（讀取已算好的結果，不重算金額）
  const fz = (await db.query<{ id: string; results: Record<string, unknown> & { missing?: Record<string, string[]> }; sources: Record<string, { kind: string }>; created_at: string }>(
    `SELECT id, results, sources, created_at FROM feasibility_scenarios WHERE organization_id=$1 AND product_id=$2 ORDER BY created_at DESC, id DESC LIMIT 1`, [orgId, pid])).rows[0];
  const feas = (key: string, label: string, map: (n: number) => AutoEntry['value']): AutoEntry => {
    if (!fz) return unknown('尚無商業可行性試算（請由有成本權限者建立）');
    const v = fz.results[key];
    if (v == null) return unknown(`試算缺少「${label}」所需的輸入`);
    return { value: map(Number(v)), sourceLabel: 'SOP 03 商業可行性試算', sourceRefs: [fz.id], asOf: String(fz.created_at).slice(0, 10) };
  };
  auto['feas.contributionMarginPct'] = feas('contributionMarginPct', '貢獻利潤率', (n) => n);
  auto['feas.takeRatePct'] = feas('takeRatePct', '抽成率', (n) => n);
  auto['feas.contribPositive'] = feas('companyContribution', '公司貢獻利潤', (n) => n > 0);
  if (!fz) auto['feas.basis'] = unknown('尚無商業可行性試算（請由有成本權限者建立）');
  else {
    const kinds = Object.values(fz.sources ?? {}).map((s) => s.kind);
    auto['feas.basis'] = kinds.length
      ? { value: kinds.includes('MANUAL_ESTIMATE') ? 'ESTIMATE' : kinds.some((k) => k === 'VENDOR_QUOTE' || k === 'HISTORICAL_DATA') ? 'QUOTED' : 'RELIABLE', sourceLabel: 'SOP 03 試算各輸入的來源', sourceRefs: [fz.id], asOf: String(fz.created_at).slice(0, 10) }
      : unknown('試算沒有記錄假設來源');
  }

  // 廠商合作資格調查（不讀分潤與排他條款：第 10、11 題）
  const rec = await pickDdRecord(db, orgId, product.vendor_id, pid);
  const regulated = suspectRegulated(product.name, product.category).length > 0 || !!rec?.regulated_category;
  const noDd = unknown('尚無廠商合作資格審查');
  if (!rec) {
    for (const k of ['dd.approved', 'dd.atRisk', 'dd.complete', 'dd.leadTime', 'dd.stockPolicy', 'dd.returnsClear', 'dd.mediaLicensed', 'dd.continuity', 'dd.testReport']) auto[k] = noDd;
    auto['dd.sampleReady'] = noDd;
  } else {
    const items = (await db.query<{ id: string; category_key: string; status: string; legal_status: string; terms: Record<string, unknown> }>(
      `SELECT id, category_key, status, legal_status, terms FROM vendor_dd_items WHERE record_id=$1 AND category_key NOT IN ('COMMISSION_TERMS','EXCLUSIVITY_RESALE')`, [rec.id])).rows;
    const allItems = (await db.query<{ category_key: string; status: string; legal_status: string }>(`SELECT category_key, status, legal_status FROM vendor_dd_items WHERE record_id=$1`, [rec.id])).rows;
    const by = (k: string) => items.find((i) => i.category_key === k);
    const src = (extra: Partial<AutoEntry> = {}): Pick<AutoEntry, 'sourceLabel' | 'sourceRefs' | 'asOf'> & Partial<AutoEntry> => ({ sourceLabel: `廠商合作資格審查（合約版本 ${rec.contract_version}）`, sourceRefs: [rec.id], asOf: today, ...extra });
    const legalBlocked = allItems.some((i) => i.legal_status === 'BLOCKED');
    const valid = rec.status === 'APPROVED' && !rec.superseded_at && (!rec.valid_until || rec.valid_until >= today);
    auto['dd.approved'] = legalBlocked ? { value: false, ...src() }
      : valid ? { value: true, ...src() }
      : unknown(rec.status === 'APPROVED' ? (rec.superseded_at ? '已被新版調查取代' : `核准已於 ${rec.valid_until} 到期`) : `廠商調查尚未核准（目前${rec.status === 'IN_REVIEW' ? '審查中' : rec.status === 'REJECTED' ? '已退回' : '草稿'}）`);
    auto['dd.atRisk'] = { value: allItems.filter((i) => i.status === 'AT_RISK').length, ...src() };
    auto['dd.complete'] = { value: pct1((allItems.filter((i) => i.status === 'CONFIRMED' || i.status === 'NOT_APPLICABLE').length / 12) * 100), ...src() };
    const lt = by('STOCK_LEADTIME')?.terms?.leadTimeDays;
    auto['dd.leadTime'] = typeof lt === 'number' ? { value: lt, ...src() } : unknown('調查第 4 題尚未填交期天數');
    const confirmed = (k: string) => by(k)?.status === 'CONFIRMED';
    auto['dd.stockPolicy'] = confirmed('INVENTORY_OVERSELL') ? { value: true, ...src() } : unknown('調查第 5 題尚未確認');
    auto['dd.returnsClear'] = confirmed('PAYMENT_LIABILITY') && confirmed('RETURNS_LIABILITY') ? { value: true, ...src() } : unknown('調查第 7、8 題尚未都確認');
    auto['dd.continuity'] = confirmed('CONTINGENCY') ? { value: true, ...src() } : unknown('調查第 12 題尚未確認');
    const m = by('SAMPLE_MEDIA_LICENSE')?.terms as { imageLicensed?: boolean; videoLicensed?: boolean; licenseValidUntil?: string; samplePolicy?: string } | undefined;
    if (!m || (m.imageLicensed == null && m.videoLicensed == null)) auto['dd.mediaLicensed'] = unknown('調查第 9 題尚未填圖片／影片授權');
    else auto['dd.mediaLicensed'] = { value: m.imageLicensed === true && m.videoLicensed === true && (!m.licenseValidUntil || m.licenseValidUntil >= today), ...src() };
    const trialsN = Number((await db.query<{ n: number }>(`SELECT count(*)::int n FROM product_trials WHERE organization_id=$1 AND product_id=$2 AND status<>'CANCELLED'`, [orgId, pid])).rows[0].n);
    auto['dd.sampleReady'] = (m?.samplePolicy && m.samplePolicy.trim()) || trialsN > 0 ? { value: true, ...src() } : unknown('沒有試用品政策也沒有試用紀錄');
    const d1 = by('SOURCE_LICENSE_QA');
    const ev = d1 ? (await db.query<{ id: string; valid_until: string | null; kind: string }>(`SELECT id, valid_until, kind FROM evidence_items WHERE organization_id=$1 AND subject_type='DD_ITEM' AND subject_id=$2 AND deleted_at IS NULL AND kind IN ('CERTIFICATE','TEST_REPORT','LICENSE')`, [orgId, d1.id])).rows : [];
    const okEv = ev.filter((e) => evidenceState({ id: e.id, validUntil: e.valid_until }, today, 0) !== 'EXPIRED');
    auto['dd.testReport'] = okEv.length ? { value: true, ...src({ sourceRefs: [rec.id, ...okEv.map((e) => e.id)] }) } : unknown('調查第 1 題沒有未過期的檢驗報告或證書');
  }

  // SOP 03 資格試用
  const tr = (await db.query<{ id: string; conclusion: string; valid_until: string | null; concluded_at: string }>(
    `SELECT id, conclusion, valid_until, concluded_at FROM product_trials WHERE organization_id=$1 AND product_id=$2 AND status='CONCLUDED' ORDER BY concluded_at DESC, id DESC LIMIT 1`, [orgId, pid])).rows[0];
  auto['trial.conclusion'] = !tr ? unknown('尚無已結論的商品試用')
    : tr.conclusion === 'RETEST' ? unknown('最近一次試用結論是「需重測」')
    : tr.valid_until && tr.valid_until < today ? unknown(`試用結論已於 ${tr.valid_until} 過期`)
    : { value: tr.conclusion, sourceLabel: 'SOP 03 商品試用結論', sourceRefs: [tr.id], asOf: String(tr.concluded_at).slice(0, 10) };

  // 歷史訂單（聚合數字＋樣本數）
  const po = `SELECT DISTINCT o.id, o.campaign_id, o.status, o.refund_amount, o.buyer_ref FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN skus k ON k.id=oi.sku_id
              WHERE o.organization_id=$1 AND k.product_id=$2 AND o.status = ANY($3::text[])`;
  const sales = [...SALES_STATUSES];
  const h = (await db.query<{ n: number; refunded: number }>(`WITH po AS (${po}) SELECT count(*)::int n, count(*) FILTER (WHERE status IN ('PARTIAL_REFUND','REFUNDED') OR refund_amount > 0)::int refunded FROM po`, [orgId, pid, sales])).rows[0];
  const n = Number(h.n);
  const hSrc = { sourceLabel: '歷史訂單（有效訂單）', asOf: today, sampleSize: n };
  auto['history.refundRate'] = n ? { value: pct1((Number(h.refunded) / n) * 100), ...hSrc } : unknown('這個商品還沒有歷史訂單');
  const cases = Number((await db.query<{ n: number }>(`WITH po AS (${po}) SELECT count(DISTINCT sc.id)::int n FROM service_cases sc JOIN po ON po.id=sc.order_id WHERE sc.organization_id=$1`, [orgId, pid, sales])).rows[0].n);
  auto['history.complaintRate'] = n ? { value: pct1((cases / n) * 100), ...hSrc, sourceLabel: '歷史客服案件÷訂單' } : unknown('這個商品還沒有歷史訂單');
  const sh = (await db.query<{ n: number; ok: number }>(
    `SELECT count(*)::int n, count(*) FILTER (WHERE s.shipped_date <= s.planned_date)::int ok FROM shipments s JOIN campaigns c ON c.id=s.campaign_id
     WHERE s.organization_id=$1 AND c.vendor_id=$2 AND s.status IN ('SHIPPED','DELIVERED') AND s.shipped_date IS NOT NULL AND s.planned_date IS NOT NULL`, [orgId, product.vendor_id])).rows[0];
  auto['history.onTimeShip'] = Number(sh.n) ? { value: pct1((Number(sh.ok) / Number(sh.n)) * 100), sourceLabel: '該廠商歷史出貨單（出貨日不晚於預計日）', asOf: today, sampleSize: Number(sh.n) } : unknown('該廠商還沒有出貨紀錄');
  const rp = (await db.query<{ buyers: number; repeaters: number }>(
    `SELECT count(*)::int buyers, count(*) FILTER (WHERE c >= 2)::int repeaters FROM (
       SELECT o.buyer_ref, count(DISTINCT o.campaign_id) c FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN skus k ON k.id=oi.sku_id
       WHERE o.organization_id=$1 AND k.product_id=$2 AND o.status = ANY($3::text[]) AND o.buyer_ref IS NOT NULL AND btrim(o.buyer_ref) <> '' GROUP BY o.buyer_ref) t`, [orgId, pid, sales])).rows[0];
  auto['history.repeatRate'] = Number(rp.buyers) ? { value: pct1((Number(rp.repeaters) / Number(rp.buyers)) * 100), sourceLabel: '歷史訂單（有買家代碼的買家）', asOf: today, sampleSize: Number(rp.buyers) } : unknown('歷史訂單沒有可辨識的買家代碼');

  return { auto, regulatedSuspected: regulated, vendorId: product.vendor_id, ddRecordId: rec?.id ?? null };
}

// ---------------- 草稿的人工輸入 ----------------
const manualEntrySchema = z.object({
  value: z.union([z.boolean(), z.number(), z.string().max(40)]).nullable().optional(),
  na: z.boolean().optional(),
  naReason: z.string().trim().max(500).nullable().optional(),
  evidenceIds: z.array(z.string().max(40)).max(20).optional(),
}).strict();
export const v2PatchFields = {
  commerceModel: z.enum(COMMERCE_MODELS).nullable().optional(),
  conditions: z.record(manualEntrySchema).optional(),
};

export interface V2Row {
  id: string; product_id: string; status: string; rubric_version: number | null; commerce_model: string | null;
  v2_input: Record<string, { value?: unknown; na?: boolean; naReason?: string | null; evidenceIds?: string[] }> | null; v2_result: { result: V2Result; ctx: V2Context } | null;
  compliance: { status?: string; note?: string | null; evidenceIds?: string[] };
}

async function evidenceCounts(db: Queryable, orgId: string, evalId: string, entries: Record<string, { evidenceIds?: string[] } | undefined>, today: string): Promise<Record<string, number>> {
  const all = [...new Set(Object.values(entries).flatMap((e) => e?.evidenceIds ?? []))];
  if (!all.length) return {};
  const r = await db.query<{ id: string; valid_until: string | null }>(`SELECT id, valid_until FROM evidence_items WHERE organization_id=$1 AND subject_type='EVALUATION' AND subject_id=$2 AND deleted_at IS NULL AND id = ANY($3::text[])`, [orgId, evalId, all]);
  const ok = new Set(r.rows.filter((e) => evidenceState({ id: e.id, validUntil: e.valid_until }, today, 0) !== 'EXPIRED').map((e) => e.id));
  return Object.fromEntries(Object.entries(entries).map(([k, e]) => [k, (e?.evidenceIds ?? []).filter((x) => ok.has(x)).length]));
}

export async function loadProductLite(db: Queryable, orgId: string, productId: string): Promise<ProductLite> {
  const r = await db.query<ProductLite>(`SELECT id, name, category, vendor_id FROM products WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL`, [productId, orgId]);
  if (!r.rows[0]) throw notFound('商品');
  return r.rows[0];
}

/** 以目前資料即時試算（草稿預覽）。回傳未遮罩的完整結果，呼叫端依權限遮蔽 */
export async function computeDraft(db: Queryable, orgId: string, row: V2Row, cfg: V2Config, today = todayTaipei()): Promise<{ input: V2Input; result: V2Result; bundle: AutoBundle }> {
  const product = await loadProductLite(db, orgId, row.product_id);
  const bundle = await resolveAuto(db, orgId, product, today);
  const counts = await evidenceCounts(db, orgId, row.id, row.v2_input ?? {}, today);
  const manual: Record<string, ManualEntry> = {};
  for (const [id, e] of Object.entries(row.v2_input ?? {})) manual[id] = { value: (e.value ?? null) as ManualEntry['value'], na: e.na, naReason: e.naReason, evidenceCount: counts[id] ?? 0 };
  // 自動取值以 autoKey 取得，計分引擎以子條件編號查找
  const autoById: Record<string, AutoEntry> = {};
  for (const c of CONDITIONS) if (c.autoKey && bundle.auto[c.autoKey]) autoById[c.id] = bundle.auto[c.autoKey];
  const input: V2Input = {
    manual, auto: autoById,
    ctx: { commerceModel: (row.commerce_model as CommerceModel | null) ?? null, regulatedSuspected: bundle.regulatedSuspected },
    compliance: { status: (row.compliance?.status ?? 'UNKNOWN') as ComplianceStatus, note: row.compliance?.note ?? null },
  };
  return { input, result: scoreV2(input, cfg), bundle };
}

/** 給畫面用的 V2 區塊（草稿＝即時預覽；已送出＝當時保存的快照）。沒有成本權限者看不到敏感子條件的數值與來源 */
export async function presentV2(db: Queryable, actor: Actor, row: V2Row & Record<string, unknown>, cfg: V2Config) {
  const canCost = can(actor, 'product.cost.read');
  let result: V2Result; let ctx: V2Context;
  if (row.status === 'SUBMITTED' && row.v2_result) { result = row.v2_result.result; ctx = row.v2_result.ctx; }
  else { const d = await computeDraft(db, actor.orgId, row, cfg); result = d.result; ctx = d.input.ctx; }
  return {
    rubricVersion: 2 as const, commerceModel: row.commerce_model, ctx,
    input: row.v2_input ?? {},
    result: maskV2Result(result, canCost, can(actor, 'fit.read')),
    canSeeSensitive: canCost,
    live: row.status !== 'SUBMITTED',
  };
}

/** 草稿更新（在 updateEvaluation 的交易內呼叫；已鎖定該列） */
export async function applyDraftPatch(tx: Tx, actor: Actor, row: V2Row, patch: { commerceModel?: CommerceModel | null; conditions?: Record<string, z.infer<typeof manualEntrySchema>> }): Promise<{ input: NonNullable<V2Row['v2_input']>; commerceModel: string | null }> {
  const cur: NonNullable<V2Row['v2_input']> = { ...(row.v2_input ?? {}) };
  const incoming = patch.conditions ?? {};
  const asManual: Record<string, ManualEntry> = Object.fromEntries(Object.entries(incoming).map(([k, v]) => [k, { value: (v.value ?? null) as ManualEntry['value'], na: v.na, naReason: v.naReason }]));
  const problems = manualInputProblems(asManual);
  if (problems.length) throw validation(problems.join('；'), { problems });
  const product = await loadProductLite(tx, actor.orgId, row.product_id);
  const { auto } = Object.keys(incoming).some((k) => COND_BY_ID[k]?.source === 'EITHER') ? await resolveAuto(tx, actor.orgId, product) : { auto: {} as Record<string, AutoEntry> };
  for (const [id, e] of Object.entries(incoming)) {
    const c = COND_BY_ID[id];
    const a = c.autoKey ? auto[c.autoKey] : undefined;
    if (c.source === 'EITHER' && a && a.value != null && (e.value != null || e.na)) throw validation(`「${c.label}」系統已有可信資料，不可手填`);
    if (nz(e.naReason) && /\d{4}[- ]?\d{3}[- ]?\d{3}|@/.test(e.naReason as string)) throw validation(`「${c.label}」的不適用原因請勿填寫電話或 Email`);
    const ids2 = e.evidenceIds ?? cur[id]?.evidenceIds ?? [];
    cur[id] = { value: e.na ? null : (e.value ?? null), na: !!e.na, naReason: e.na ? nz(e.naReason) : null, evidenceIds: ids2 };
    if (cur[id].value == null && !cur[id].na && !(cur[id].evidenceIds ?? []).length) delete cur[id];
  }
  const refs = [...new Set(Object.values(cur).flatMap((e) => e.evidenceIds ?? []))];
  if (refs.length) {
    const ok = await tx.query<{ id: string }>(`SELECT id FROM evidence_items WHERE organization_id=$1 AND subject_type='EVALUATION' AND subject_id=$2 AND deleted_at IS NULL AND id = ANY($3::text[])`, [actor.orgId, row.id, refs]);
    const found = new Set(ok.rows.map((r) => r.id));
    const bad = refs.filter((r) => !found.has(r));
    if (bad.length) throw validation(`引用的證據不屬於這份評估：${bad.join('、')}`);
  }
  return { input: cur, commerceModel: patch.commerceModel === undefined ? row.commerce_model : patch.commerceModel };
}

/** 送出（在 submitEvaluation 的交易內呼叫）：保存規則版本、每個子條件的答案與自動值快照 */
export async function computeSubmit(tx: Tx, actor: Actor, row: V2Row, cfg: V2Config, today: string) {
  const { input, result } = await computeDraft(tx, actor.orgId, row, cfg, today);
  const problems = submitProblemsV2(input, result);
  if (problems.length) throw validation(problems.join('；'), { problems });
  return { input, result };
}

export function v2Snapshot(cfg: V2Config) {
  return { rubric: 2, catalogVersion: CATALOG_VERSION, version: cfg.version, approved: cfg.approved, weights: cfg.dimWeights,
    thresholds: { proceed: cfg.proceed, supplement: cfg.supplement, minCompleteness: cfg.minCompleteness, highConfidence: cfg.highConfidence, mediumConfidence: cfg.mediumConfidence },
    v2: cfg };
}

// ---------------- 補件要求（主管對個別子條件提出） ----------------
const reqSchema = z.object({ conditionId: z.string().max(60).nullable().optional(), note: z.string().trim().min(1, '請說明要補什麼').max(500) }).strict();
export const supplementCreateSchema = reqSchema;
export const supplementResolveSchema = z.object({ status: z.enum(['DONE', 'CANCELLED']), note: z.string().trim().max(500).optional() }).strict();

export async function listSupplements(actor: Actor, evaluationId: string) {
  requirePerm(actor, 'selection.read');
  const rows = await query(`SELECT r.*, u.name AS requested_by_name FROM evaluation_supplement_requests r LEFT JOIN users u ON u.id=r.requested_by WHERE r.organization_id=$1 AND r.evaluation_id=$2 ORDER BY r.requested_at, r.id`, [actor.orgId, evaluationId]);
  return camelize<Record<string, unknown>[]>(rows).map((r) => ({ ...r, conditionLabel: r.conditionId ? COND_BY_ID[r.conditionId as string]?.label ?? r.conditionId : '整體' }));
}

export async function createSupplement(actor: Actor, evaluationId: string, raw: z.input<typeof supplementCreateSchema>) {
  requirePerm(actor, 'product.review');
  requirePerm(actor, 'selection.read');
  const input = supplementCreateSchema.parse(raw);
  if (input.conditionId && !COND_BY_ID[input.conditionId]) throw validation('未知的子條件');
  if (/\d{4}[- ]?\d{3}[- ]?\d{3}|@/.test(input.note)) throw validation('補件說明請勿填寫電話或 Email');
  return withTx(async (tx) => {
    const e = await tx.query<{ status: string; rubric_version: number | null; superseded_at: string | null }>(`SELECT status, rubric_version, superseded_at FROM product_evaluations WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [evaluationId, actor.orgId]);
    if (!e.rows[0]) throw notFound('選品評估');
    if (e.rows[0].rubric_version !== 2) throw precondition('只有 V2 評估可以針對子條件提出補件要求');
    if (e.rows[0].status !== 'SUBMITTED') throw precondition('草稿尚未送出，不能提出補件要求');
    if (e.rows[0].superseded_at) throw conflict('這份評估已被新版本取代，請對最新版本提出');
    const id = await ids.supplementRequest(tx);
    await tx.query(`INSERT INTO evaluation_supplement_requests (id, organization_id, evaluation_id, condition_id, note, requested_by) VALUES ($1,$2,$3,$4,$5,$6)`, [id, actor.orgId, evaluationId, input.conditionId ?? null, input.note, actor.userId]);
    await audit(tx, actor, { action: 'selection.evaluation.supplement', entityType: 'product_evaluation', entityId: evaluationId, after: { requestId: id, conditionId: input.conditionId ?? null, note: input.note } });
    return { id };
  });
}

export async function resolveSupplement(actor: Actor, requestId: string, raw: z.input<typeof supplementResolveSchema>) {
  requirePerm(actor, 'selection.write');
  const input = supplementResolveSchema.parse(raw);
  return withTx(async (tx) => {
    const r = await tx.query<{ status: string; evaluation_id: string }>(`SELECT status, evaluation_id FROM evaluation_supplement_requests WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [requestId, actor.orgId]);
    if (!r.rows[0]) throw notFound('補件要求');
    if (r.rows[0].status !== 'OPEN') throw precondition('這個補件要求已處理過');
    await tx.query(`UPDATE evaluation_supplement_requests SET status=$2, resolved_by=$3, resolved_at=now(), resolve_note=$4 WHERE id=$1`, [requestId, input.status, actor.userId, input.note ?? null]);
    await audit(tx, actor, { action: 'selection.evaluation.supplement', entityType: 'product_evaluation', entityId: r.rows[0].evaluation_id, after: { requestId, status: input.status } });
    return { id: requestId, status: input.status };
  });
}

export async function openSupplementCount(db: Queryable, orgId: string, evaluationId: string): Promise<number> {
  return Number((await db.query<{ n: number }>(`SELECT count(*)::int n FROM evaluation_supplement_requests WHERE organization_id=$1 AND evaluation_id=$2 AND status='OPEN'`, [orgId, evaluationId])).rows[0].n);
}

export { COMPLIANCE_STATUSES };
