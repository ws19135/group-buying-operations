import { pool, query } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, requirePerm } from '../lib/permissions';
import { camelize } from '../lib/case';
import { todayTaipei } from '../lib/ids';
import { LIGHT_LABEL, buildRisks, lightOf, type Light, type Risk } from '../lib/decision-risk';
import { assertCampaignVisible, currentEvaluation, loadSelectionConfig } from './selection';
import { bestDiligence } from './diligence';
import { qualificationFor } from './trials';
import { latestFeasibility } from './feasibility';

/**
 * G1 選品核准的統一決策摘要（唯讀）。把商品評估、廠商合作資格審查、試用、商業可行性與 SOP 01 客群適配彙整成一頁，
 * 附證據連結與風險清單。**gateImpact 恆為 NONE**：不改變 G1 的檢查項、申請與核准結果，也不新增核准列或通知。
 */
const WORST: Record<Light, number> = { GREEN: 0, YELLOW: 1, RED: 2 };

export async function g1Summary(actor: Actor, campaignId: string) {
  requirePerm(actor, 'selection.read');
  const camp = await assertCampaignVisible(actor, campaignId);
  const cfg = await loadSelectionConfig(pool(), actor.orgId);
  const canMoney = can(actor, 'product.cost.read');
  const canFit = can(actor, 'fit.read');
  const rows = await query<{ product_id: string }>(`SELECT DISTINCT product_id FROM campaign_products WHERE campaign_id=$1 AND organization_id=$2 AND deleted_at IS NULL ORDER BY product_id`, [campaignId, actor.orgId]);
  const products = [];
  let overall: Light = 'GREEN';
  const allRisks: (Risk & { productId: string })[] = [];
  if (!rows.length) { overall = 'YELLOW'; }
  for (const { product_id: pid } of rows) {
    const p = (await query<{ id: string; name: string; category: string | null; vendor_id: string; review_status: string; vendor_name: string; vendor_status: string }>(
      `SELECT p.id, p.name, p.category, p.vendor_id, p.review_status, v.name AS vendor_name, v.status AS vendor_status FROM products p JOIN vendors v ON v.id=p.vendor_id WHERE p.id=$1 AND p.organization_id=$2 AND p.deleted_at IS NULL`, [pid, actor.orgId]))[0];
    if (!p) continue;
    const ev = await currentEvaluation(pool(), actor.orgId, pid);
    const dd = await bestDiligence(actor, p.vendor_id, pid);
    const qual = await qualificationFor(pool(), actor.orgId, pid);
    const trials = camelize<{ id: string; status: string; level: string; trialType: string; hostId: string | null; conclusion: string | null; reviewDecision: string | null; validUntil: string | null; createdAt: string }[]>(
      await query(`SELECT id, status, level, trial_type, host_id, conclusion, review_decision, valid_until, created_at FROM product_trials WHERE organization_id=$1 AND product_id=$2 AND campaign_id=$3 ORDER BY created_at DESC, id DESC`, [actor.orgId, pid, campaignId]));
    const fz = await latestFeasibility(actor, pid, campaignId);
    const fit = canFit
      ? Object.fromEntries((await query<{ recommendation: string; n: number; top: number | null }>(
          `SELECT recommendation, count(*)::int AS n, max(total_score) AS top FROM product_fit_assessments WHERE organization_id=$1 AND product_id=$2 AND campaign_id=$3 AND superseded_at IS NULL GROUP BY recommendation`, [actor.orgId, pid, campaignId]))
          .map((x) => [x.recommendation, { hosts: Number(x.n), topScore: x.top == null ? null : Number(x.top) }]))
      : null;
    const evView = ev as (Record<string, unknown> & { compliance?: { status?: string | null; note?: string | null }; recommendation?: string | null; reviewDecision?: string | null }) | null;
    const ddView = dd;
    const risks = buildRisks({
      reviewStatus: p.review_status,
      evaluation: evView ? { recommendation: evView.recommendation ?? null, complianceStatus: evView.compliance?.status ?? null, reviewDecision: evView.reviewDecision ?? null } : null,
      diligence: ddView ? { status: ddView.status, valid: ddView.validity.valid, invalidReasons: ddView.validity.reasons, expiredEvidence: ddView.readiness.expired, legalBlocked: ddView.itemStates.some((s) => s.legalStatus === 'BLOCKED'), legalPending: ddView.readiness.legalPending, atRisk: ddView.readiness.risks } : null,
      qualification: qual ? { conclusion: qual.conclusion, valid: qual.valid, reasons: qual.reasons } : null,
      trials,
      feasibility: fz ? { incomplete: Object.keys((fz.raw.results as { missing?: Record<string, unknown> }).missing ?? {}).length > 0, canSeeMoney: canMoney, brandProfit: (fz.raw.results.brandProfit as number | null) ?? null, companyContribution: (fz.raw.results.companyContribution as number | null) ?? null } : null,
    });
    const light = lightOf(risks);
    if (WORST[light] > WORST[overall]) overall = light;
    for (const r of risks) allRisks.push({ ...r, productId: pid });
    products.push({
      productId: pid, productName: p.name, category: p.category, reviewStatus: p.review_status, vendorId: p.vendor_id, vendorName: p.vendor_name, vendorStatus: p.vendor_status,
      light, lightLabel: LIGHT_LABEL[light], risks,
      evaluation: evView && { id: evView.id, versionNo: evView.versionNo, totalScore: evView.totalScore, recommendation: evView.recommendation, confidence: evView.confidence, completeness: evView.completeness,
        compliance: evView.compliance, reviewDecision: evView.reviewDecision, evaluatedOn: evView.evaluatedOn, evaluatorName: evView.evaluatorName, evidenceGaps: evView.evidenceGaps, configVersion: evView.configVersion },
      diligence: ddView && { id: ddView.id, contractVersion: ddView.contractVersion, status: ddView.status, validUntil: ddView.validUntil, validity: ddView.validity, readiness: ddView.readiness, scope: ddView.productId ? 'PRODUCT' : 'VENDOR' },
      qualification: qual, trials,
      feasibility: fz && { id: fz.view.id, versionNo: fz.view.versionNo, label: fz.view.label, results: fz.view.results, restricted: fz.view.restricted, hasActuals: !!fz.raw.actuals, scope: fz.raw.campaign_id ? 'CAMPAIGN' : 'PRODUCT' },
      fit, evidenceHint: '證據連結在各項目的詳細頁（評估、合作資格審查、試用、可行性）',
    });
  }
  return {
    campaignId, campaignTitle: camp.title as string, campaignStatus: camp.status as string,
    /** 恆為 NONE：此摘要不改變 G1 的檢查項、申請與核准結果 */
    gateImpact: 'NONE' as const,
    note: '此摘要只供核准者查閱，不是 G1 的檢查項；是否核准仍由核准者依既有 G1 流程決定。',
    generatedAt: new Date().toISOString(), today: todayTaipei(),
    light: overall, lightLabel: LIGHT_LABEL[overall],
    counts: { products: products.length, blocking: allRisks.filter((r) => r.level === 'BLOCKING').length, gaps: allRisks.filter((r) => r.level === 'GAP').length },
    config: { version: cfg.version, approved: cfg.approved, status: cfg.approved ? '已確認採用' : '建議值，待 Owner 確認' },
    canSeeMoney: canMoney, products,
  };
}
