import { pool, query } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, requirePerm } from '../lib/permissions';
import { notFound } from '../lib/errors';
import { campaignScope } from '../lib/scope';
import { loadV2Config } from './selection-v2';
import { computeTrialKpis, maskTrialKpis, type HostIntent, type TrialKpiInput } from '../lib/trial-kpi';

/**
 * 小規模測試團（及任何有關聯檔期的試用）的成效 KPI。公式、來源、期間見 docs/phase2/TRIAL_KPI.md；純計算在 lib/trial-kpi.ts。
 * 這裡只「讀取」既有資料並聚合（訂單、歸因、出貨單、客服案件、試用檢核項、可行性試算）：不寫入、不改結算口徑、不套用任何門檻。
 * 有團主的試用只算該團主歸因的訂單；沒有團主的試用算整個檔期。客訴是檔期層級（客服案件沒有團主）。
 */
export async function getTrialKpis(actor: Actor, trialId: string) {
  requirePerm(actor, 'selection.read');
  const [t] = await query<{ id: string; org: string; product_id: string; level: string; trial_type: string; host_id: string | null; campaign_id: string | null; host_intent: HostIntent | null; host_intent_note: string | null }>(
    `SELECT id, organization_id AS org, product_id, level, trial_type, host_id, campaign_id, host_intent, host_intent_note FROM product_trials WHERE id=$1 AND organization_id=$2`, [trialId, actor.orgId]);
  if (!t) throw notFound('試用');
  let camp: { open_date: string | null; close_date: string | null; status: string } | null = null;
  if (t.campaign_id) {
    const sc = campaignScope(actor, 2, 'c');
    if (sc.sql === 'FALSE') throw notFound('試用');
    const r = await query<{ open_date: string | null; close_date: string | null; status: string }>(`SELECT c.open_date, c.close_date, c.status FROM campaigns c WHERE c.id=$1 AND (${sc.sql})`, [t.campaign_id, ...sc.params]);
    if (!r[0]) throw notFound('試用');
    camp = r[0];
  }
  const db = pool();
  const cfg = await loadV2Config(db, actor.orgId);
  const SALES = ['PAID', 'PARTIAL_REFUND', 'REFUNDED'], VALID = ['PAID', 'PARTIAL_REFUND'];

  let orders: TrialKpiInput['orders'] = { total: 0, established: 0, valid: 0, refunded: 0, cancelled: 0, validGross: 0, validRefund: 0 };
  let complaintCases = 0;
  let shipments: TrialKpiInput['shipments'] = { nonCancelled: 0, withDates: 0, onTime: 0 };
  let dataAsOf: string | null = null;
  if (t.campaign_id) {
    // 有團主：只算該團主有歸因的訂單，金額依歸因比例分攤；沒有團主：整個檔期
    const sc = t.host_id
      ? await db.query<Record<string, number | null>>(
          `SELECT count(DISTINCT o.id)::int AS total,
                  count(DISTINCT o.id) FILTER (WHERE o.status = ANY($3::text[]))::int AS established,
                  count(DISTINCT o.id) FILTER (WHERE o.status = ANY($4::text[]))::int AS valid,
                  count(DISTINCT o.id) FILTER (WHERE o.status = ANY($3::text[]) AND (o.status IN ('PARTIAL_REFUND','REFUNDED') OR o.refund_amount > 0))::int AS refunded,
                  count(DISTINCT o.id) FILTER (WHERE o.status = 'CANCELLED')::int AS cancelled,
                  coalesce(sum(o.gross_amount * a.share_percent / 100.0) FILTER (WHERE o.status = ANY($4::text[])),0) AS valid_gross,
                  coalesce(sum(o.refund_amount * a.share_percent / 100.0) FILTER (WHERE o.status = ANY($4::text[])),0) AS valid_refund
           FROM orders o JOIN attributions a ON a.order_id=o.id AND a.host_id=$5 WHERE o.campaign_id=$1 AND o.organization_id=$2`, [t.campaign_id, actor.orgId, SALES, VALID, t.host_id])
      : await db.query<Record<string, number | null>>(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE status = ANY($3::text[]))::int AS established,
                  count(*) FILTER (WHERE status = ANY($4::text[]))::int AS valid,
                  count(*) FILTER (WHERE status = ANY($3::text[]) AND (status IN ('PARTIAL_REFUND','REFUNDED') OR refund_amount > 0))::int AS refunded,
                  count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
                  coalesce(sum(gross_amount) FILTER (WHERE status = ANY($4::text[])),0) AS valid_gross,
                  coalesce(sum(refund_amount) FILTER (WHERE status = ANY($4::text[])),0) AS valid_refund
           FROM orders WHERE campaign_id=$1 AND organization_id=$2`, [t.campaign_id, actor.orgId, SALES, VALID]);
    const r = sc.rows[0];
    orders = { total: Number(r.total), established: Number(r.established), valid: Number(r.valid), refunded: Number(r.refunded), cancelled: Number(r.cancelled), validGross: Math.round(Number(r.valid_gross)), validRefund: Math.round(Number(r.valid_refund)) };
    complaintCases = Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM service_cases WHERE campaign_id=$1 AND organization_id=$2 AND status <> 'CANCELLED'`, [t.campaign_id, actor.orgId])).rows[0].n);
    const sh = (await db.query<{ n: number; w: number; ok: number }>(
      `SELECT count(*) FILTER (WHERE s.status <> 'CANCELLED')::int AS n,
              count(*) FILTER (WHERE s.status IN ('SHIPPED','DELIVERED') AND s.shipped_date IS NOT NULL AND s.planned_date IS NOT NULL)::int AS w,
              count(*) FILTER (WHERE s.status IN ('SHIPPED','DELIVERED') AND s.shipped_date IS NOT NULL AND s.planned_date IS NOT NULL AND s.shipped_date <= s.planned_date)::int AS ok
       FROM shipments s JOIN fulfillment_batches b ON b.id=s.batch_id WHERE s.campaign_id=$1 AND b.organization_id=$2 AND b.kind='ORDER'`, [t.campaign_id, actor.orgId])).rows[0];
    shipments = { nonCancelled: Number(sh.n), withDates: Number(sh.w), onTime: Number(sh.ok) };
    const ia = (await db.query<{ d: string | null }>(`SELECT max(b.data_as_of) AS d FROM import_batches b WHERE b.organization_id=$1 AND b.id IN (SELECT import_batch_id FROM orders WHERE campaign_id=$2)`, [actor.orgId, t.campaign_id])).rows[0];
    dataAsOf = ia?.d ? String(ia.d) : null;
  }
  const chk = (await db.query<{ tested: number; failed: number }>(`SELECT count(*) FILTER (WHERE result <> 'NOT_TESTED')::int AS tested, count(*) FILTER (WHERE result = 'FAIL')::int AS failed FROM trial_checks WHERE trial_id=$1`, [trialId])).rows[0];
  // 預估每單貢獻利潤：來自這次試用（或同商品同檔期）最新的可行性試算，只當參考
  const fz = (await db.query<{ results: Record<string, number | null>; inputs: Record<string, number | null> }>(
    `SELECT results, inputs FROM feasibility_scenarios WHERE organization_id=$1 AND product_id=$2 AND (trial_id=$3 OR ($4::text IS NOT NULL AND campaign_id=$4)) ORDER BY (trial_id=$3) DESC, created_at DESC, id DESC LIMIT 1`, [actor.orgId, t.product_id, trialId, t.campaign_id])).rows[0];
  const est = fz && fz.results.companyContribution != null && fz.inputs.expectedOrders ? Math.round(Number(fz.results.companyContribution) / Number(fz.inputs.expectedOrders)) : null;

  const input: TrialKpiInput = {
    period: { from: camp?.open_date ?? null, to: camp?.close_date ?? null }, dataAsOf, orders, reach: null, complaintCases,
    checks: { tested: Number(chk.tested), failed: Number(chk.failed) }, shipments, hostIntent: t.host_intent, estimatedContributionPerOrder: est, lowSampleBelow: cfg.minSample.orders,
  };
  const result = maskTrialKpis(computeTrialKpis(input), can(actor, 'product.cost.read'));
  return {
    trialId, trialType: t.trial_type, level: t.level, hostId: t.host_id, campaignId: t.campaign_id, campaignStatus: camp?.status ?? null,
    scopeNote: !t.campaign_id ? '這個試用沒有關聯檔期，訂單、客訴與出貨類指標沒有資料來源' : t.host_id ? '訂單只算這位團主歸因的部分（金額依歸因比例分攤）；客訴與出貨是檔期層級（不分團主）' : '整個檔期（沒有指定團主）',
    hostIntentNote: t.host_intent_note, ...result,
    thresholds: { applied: false, note: 'KPI 門檻尚未經 Owner 核准，這裡只顯示數值與資料完整度，不做通過／不通過的判定' },
  };
}
