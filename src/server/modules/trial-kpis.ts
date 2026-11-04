import { pool, query } from '../lib/db';
import type { Queryable } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, requirePerm } from '../lib/permissions';
import { notFound } from '../lib/errors';
import { campaignScope } from '../lib/scope';
import { loadActualSales } from '../lib/actual-sales';
import type { ActualProfitResult } from '../lib/actual-profit';
import { computeTrialKpis, maskTrialKpis, type HostIntent, type TrialKpiInput, type TrialKpiResult } from '../lib/trial-kpi';
import { pickLatest, visitorsUsable } from '../lib/trial-reach';
import { loadV2Config } from './selection-v2';
import { activeReach } from './trial-reach';
import { actualContribution } from './actual-contribution';
import { activeRulesForHost, pickCommissionRule } from '../lib/commission-calc';
import { todayTaipei } from '../lib/ids';

/**
 * 小規模測試團（及任何有關聯檔期的試用）的成效 KPI。公式、來源、期間見 docs/phase2/TRIAL_KPI.md；純計算在 lib/trial-kpi.ts。
 * 這裡只「讀取」既有資料並聚合（訂單、歸因、出貨單、客服案件、試用檢核項、可行性條款、人工填寫的觸及與導購資料）：不寫入、不改分潤結算口徑、不套用任何門檻。
 * 訂單與實際銷售用 lib/actual-sales（與商業可行性「實際值回寫」同一定義）；每單貢獻利潤用 lib/actual-profit（與試算共用 calcFeasibility）。
 * 有團主的試用只算該團主歸因的訂單；沒有團主的試用算整個檔期。客訴是檔期層級（客服案件沒有團主）。
 */
export const KPI_THRESHOLD_NOTE = 'KPI 達標門檻尚未制定（Owner 決策 K-1）：累積至少 5 檔小規模測試團並經 Owner 審查後才會決定；目前只顯示數值、資料完整度與風險提示，不判定是否值得放大銷售';

interface TrialLite { id: string; product_id: string; level: string; trial_type: string; host_id: string | null; campaign_id: string | null; host_intent: HostIntent | null; host_intent_note: string | null }

async function loadCampaignForKpi(actor: Actor, campaignId: string) {
  const sc = campaignScope(actor, 2, 'c');
  if (sc.sql === 'FALSE') throw notFound('試用');
  const r = await query<{ open_date: string | null; close_date: string | null; status: string }>(`SELECT c.open_date, c.close_date, c.status FROM campaigns c WHERE c.id=$1 AND (${sc.sql})`, [campaignId, ...sc.params]);
  if (!r[0]) throw notFound('試用');
  return r[0];
}

async function contributionFor(db: Queryable, orgId: string, t: TrialLite, actual: { valid: number; gmv: number; refund: number; refunded: number }): Promise<{ result: ActualProfitResult; estimate: number | null; consistency: string | null }> {
  // 條款來自「這個商品、這個檔期」最新的商業可行性（有團主專屬的優先；團主不同的不採用）
  const fz = (await db.query<{ inputs: Record<string, unknown>; sources: Record<string, { kind?: string }> }>(
    `SELECT inputs, sources FROM feasibility_scenarios WHERE organization_id=$1 AND product_id=$2 AND campaign_id=$3 AND (host_id IS NULL OR host_id=$4)
     ORDER BY (host_id IS NOT NULL) DESC, created_at DESC, id DESC LIMIT 1`, [orgId, t.product_id, t.campaign_id, t.host_id])).rows[0];
  const result = await actualContribution(db, { campaignId: t.campaign_id as string, hostId: t.host_id, scenario: fz ?? null, actual });
  // 一致性提醒（只讀、只提示）：可行性條款的團主分潤比例，與財務「分潤規則」（結算用）是否一致。兩者是不同來源，這裡不改任何一邊
  let consistency: string | null = null;
  const termPct = fz?.inputs?.hostCommissionPct;
  if (t.host_id && typeof termPct === 'number') {
    const camp = (await db.query<{ id: string; open_date: string | null; commission_rule_id: string | null }>(
      `SELECT c.id, c.open_date, ch.commission_rule_id FROM campaigns c LEFT JOIN campaign_hosts ch ON ch.campaign_id=c.id AND ch.host_id=$3 AND ch.deleted_at IS NULL WHERE c.id=$1 AND c.organization_id=$2`, [t.campaign_id, orgId, t.host_id])).rows[0];
    const rule = camp ? pickCommissionRule(await activeRulesForHost(db, orgId, t.host_id), camp, todayTaipei()) : undefined;
    if (!rule) consistency = '財務「分潤規則」沒有這位團主在此檔期的費率；可行性條款的團主分潤比例與結算來源不同，請確認結算規則已建立';
    else if (Number(rule.rate_percent) !== termPct) consistency = `可行性條款的團主分潤比例（${termPct}%）與財務分潤規則（${Number(rule.rate_percent)}%）不一致：每單貢獻利潤用前者、結算用後者，請確認哪一個是合約條件`;
  }
  // 預估（只供參考）：同商品同檔期（或這次試用）最新的可行性試算
  const est = (await db.query<{ results: Record<string, number | null>; inputs: Record<string, number | null> }>(
    `SELECT results, inputs FROM feasibility_scenarios WHERE organization_id=$1 AND product_id=$2 AND (trial_id=$3 OR campaign_id=$4) ORDER BY (trial_id=$3) DESC, created_at DESC, id DESC LIMIT 1`, [orgId, t.product_id, t.id, t.campaign_id])).rows[0];
  const estimate = est && est.results.companyContribution != null && est.inputs.expectedOrders ? Math.round(Number(est.results.companyContribution) / Number(est.inputs.expectedOrders)) : null;
  return { result, estimate, consistency };
}

/** 計算一個試用的 KPI（呼叫端需已確認權限與範圍）；回傳未遮罩與遮罩前的完整結果 */
export async function buildTrialKpis(actor: Actor, t: TrialLite, camp: { open_date: string | null; close_date: string | null; status: string } | null): Promise<{ result: TrialKpiResult; dataAsOf: string | null }> {
  const db = pool();
  const cfg = await loadV2Config(db, actor.orgId);
  let orders: TrialKpiInput['orders'] = { total: 0, established: 0, valid: 0, refunded: 0, cancelled: 0, gmv: 0, refund: 0 };
  let complaintCases = 0;
  let shipments: TrialKpiInput['shipments'] = { nonCancelled: 0, withDates: 0, onTime: 0 };
  let dataAsOf: string | null = null;
  let contribution: ActualProfitResult | null = null;
  let estimate: number | null = null;
  let consistency: string | null = null;
  if (t.campaign_id) {
    const a = await loadActualSales(db, { orgId: actor.orgId, campaignId: t.campaign_id, hostId: t.host_id });
    orders = { total: a.total, established: a.established, valid: a.valid, refunded: a.refundedOrders, cancelled: a.cancelled, gmv: a.gmv, refund: a.refund };
    complaintCases = Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM service_cases WHERE campaign_id=$1 AND organization_id=$2 AND status <> 'CANCELLED'`, [t.campaign_id, actor.orgId])).rows[0].n);
    const sh = (await db.query<{ n: number; w: number; ok: number }>(
      `SELECT count(*) FILTER (WHERE s.status <> 'CANCELLED')::int AS n,
              count(*) FILTER (WHERE s.status IN ('SHIPPED','DELIVERED') AND s.shipped_date IS NOT NULL AND s.planned_date IS NOT NULL)::int AS w,
              count(*) FILTER (WHERE s.status IN ('SHIPPED','DELIVERED') AND s.shipped_date IS NOT NULL AND s.planned_date IS NOT NULL AND s.shipped_date <= s.planned_date)::int AS ok
       FROM shipments s JOIN fulfillment_batches b ON b.id=s.batch_id WHERE s.campaign_id=$1 AND b.organization_id=$2 AND b.kind='ORDER'`, [t.campaign_id, actor.orgId])).rows[0];
    shipments = { nonCancelled: Number(sh.n), withDates: Number(sh.w), onTime: Number(sh.ok) };
    const ia = (await db.query<{ d: string | null }>(`SELECT max(b.data_as_of) AS d FROM import_batches b WHERE b.organization_id=$1 AND b.id IN (SELECT import_batch_id FROM orders WHERE campaign_id=$2)`, [actor.orgId, t.campaign_id])).rows[0];
    dataAsOf = ia?.d ? String(ia.d) : null;
    const c = await contributionFor(db, actor.orgId, t, { valid: a.valid, gmv: a.gmv, refund: a.refund, refunded: a.refundedOrders });
    contribution = c.result; estimate = c.estimate; consistency = c.consistency;
  }
  const chk = (await db.query<{ tested: number; failed: number }>(`SELECT count(*) FILTER (WHERE result <> 'NOT_TESTED')::int AS tested, count(*) FILTER (WHERE result = 'FAIL')::int AS failed FROM trial_checks WHERE trial_id=$1`, [t.id])).rows[0];
  const records = await activeReach(actor.orgId, t.id);
  const visitors = pickLatest(records, 'QUALIFIED_VISITORS');
  const input: TrialKpiInput = {
    period: { from: camp?.open_date ?? null, to: camp?.close_date ?? null }, dataAsOf, orders,
    reach: { potential: pickLatest(records, 'POTENTIAL_REACH'), actual: pickLatest(records, 'ACTUAL_REACH'), visitors, visitorsUsable: visitorsUsable(visitors, { from: camp?.open_date ?? null, to: camp?.close_date ?? null }) },
    contribution, complaintCases, checks: { tested: Number(chk.tested), failed: Number(chk.failed) }, shipments, hostIntent: t.host_intent, estimatedContributionPerOrder: estimate, lowSampleBelow: cfg.minSample.orders,
  };
  const canCost = can(actor, 'product.cost.read');
  const result = maskTrialKpis(computeTrialKpis(input), canCost);
  if (consistency && canCost) result.notices.push(consistency);   // 含費率，只給有成本檢視權限者
  return { result, dataAsOf };
}

export async function getTrialKpis(actor: Actor, trialId: string) {
  requirePerm(actor, 'selection.read');
  const [t] = await query<TrialLite>(
    `SELECT id, product_id, level, trial_type, host_id, campaign_id, host_intent, host_intent_note FROM product_trials WHERE id=$1 AND organization_id=$2`, [trialId, actor.orgId]);
  if (!t) throw notFound('試用');
  const camp = t.campaign_id ? await loadCampaignForKpi(actor, t.campaign_id) : null;
  const { result } = await buildTrialKpis(actor, t, camp);
  return {
    trialId, trialType: t.trial_type, level: t.level, hostId: t.host_id, campaignId: t.campaign_id, campaignStatus: camp?.status ?? null,
    scopeNote: !t.campaign_id ? '這個試用沒有關聯檔期，訂單、客訴與出貨類指標沒有資料來源' : t.host_id ? '訂單只算這位團主歸因的部分（金額依歸因比例分攤）；客訴與出貨是檔期層級（不分團主）' : '整個檔期（沒有指定團主）',
    hostIntentNote: t.host_intent_note, ...result,
    thresholds: { applied: false, note: KPI_THRESHOLD_NOTE },
  };
}

// ---------------- K-1：累積彙整（累積至少 5 檔後整理給 Owner 審查；本身不判定任何門檻） ----------------
export const KPI_REVIEW_MIN_TRIALS = 5;

export async function getTrialKpiSummary(actor: Actor) {
  requirePerm(actor, 'selection.read');
  const sc = campaignScope(actor, 2, 'c');
  if (sc.sql === 'FALSE') return emptySummary();
  const rows = await query<TrialLite & { product_name: string; category: string | null; host_name: string | null; partner_type: string | null; campaign_title: string; open_date: string | null; close_date: string | null; camp_status: string; trial_status: string; created_at: string }>(
    `SELECT t.id, t.product_id, t.level, t.trial_type, t.host_id, t.campaign_id, t.host_intent, t.host_intent_note, t.status AS trial_status, t.created_at,
            p.name AS product_name, p.category, h.display_name AS host_name, h.partner_type, c.title AS campaign_title, c.open_date, c.close_date, c.status AS camp_status
     FROM product_trials t JOIN campaigns c ON c.id=t.campaign_id JOIN products p ON p.id=t.product_id LEFT JOIN hosts h ON h.id=t.host_id
     WHERE t.organization_id=$1 AND t.trial_type='MINI_GROUP' AND t.status <> 'CANCELLED' AND (${campaignScope(actor, 2, 'c').sql})
     ORDER BY c.open_date NULLS LAST, t.created_at, t.id LIMIT 100`, [actor.orgId, ...sc.params]);
  const out = [];
  const prev = new Map<string, { value: number; trialId: string }>();
  for (const r of rows) {
    const { result } = await buildTrialKpis(actor, r, { open_date: r.open_date, close_date: r.close_date, status: r.camp_status });
    const items = result.items.map((k) => {
      const numeric = k.status === 'OK' && typeof k.value === 'number' ? k.value : null;
      const p = prev.get(k.key);
      const trend = numeric != null && p ? { previous: p.value, delta: Math.round((numeric - p.value) * 100) / 100, previousTrialId: p.trialId } : null;
      if (numeric != null) prev.set(k.key, { value: numeric, trialId: r.id });
      return { key: k.key, no: k.no, label: k.label, status: k.status, value: k.value, unit: k.unit, sampleSize: k.sampleSize, completeness: k.completeness, lowSample: k.lowSample, reason: k.reason, trend };
    });
    const validOrders = result.items.find((k) => k.key === 'validOrders');
    out.push({
      trialId: r.id, trialStatus: r.trial_status, productId: r.product_id, productName: r.product_name, category: r.category, hostId: r.host_id, hostName: r.host_name, partnerType: r.partner_type,
      campaignId: r.campaign_id, campaignTitle: r.campaign_title, period: result.period, hasData: validOrders?.status === 'OK', okCount: result.okCount, total: result.total, notices: result.notices, items,
    });
  }
  const counted = out.filter((x) => x.hasData).length;
  return {
    required: KPI_REVIEW_MIN_TRIALS, counted, total: out.length, ready: counted >= KPI_REVIEW_MIN_TRIALS, rows: out,
    note: `累積至少 ${KPI_REVIEW_MIN_TRIALS} 檔「已有有效訂單」的小規模測試團後，整理各指標的實際表現、樣本數、商品類別與團主類型，提交 Owner 審查，再決定是否制定門檻。${KPI_THRESHOLD_NOTE}。趨勢只是與前一檔比較數值的差，不代表好壞。`,
  };
}
function emptySummary() { return { required: KPI_REVIEW_MIN_TRIALS, counted: 0, total: 0, ready: false, rows: [], note: '' }; }
