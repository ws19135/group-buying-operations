import type { Queryable } from './db';
import { EFFECTIVE_ORDER_STATUSES, SALES_STATUSES } from './kpi';

/**
 * 實際銷售的「單一定義」：小規模測試團 KPI（modules/trial-kpis）與商業可行性「實際值回寫」（modules/feasibility.recordActuals）共用，
 * 避免兩處各算一套。口徑沿用 lib/kpi.ts（Dashboard 同一組）：
 *   計入銷售＝PAID／PARTIAL_REFUND／REFUNDED；有效訂單＝PAID／PARTIAL_REFUND；GMV、退款＝計入銷售的訂單；有效淨銷售額＝GMV − 退款；
 *   有退款的訂單＝計入銷售中狀態為 PARTIAL_REFUND／REFUNDED、或退款金額 > 0；取消＝CANCELLED。
 * 有團主：只算該團主有歸因的訂單，金額依歸因比例分攤；沒有團主：整個檔期。
 * 只讀取訂單；與分潤結算（lib/commission-calc、modules/settlements）完全無關，不改任何結算結果。
 */
export interface ActualSales {
  total: number; established: number; valid: number; refundedOrders: number; cancelled: number;
  gmv: number; refund: number; nsv: number;
  /** 有效訂單依歸因比例加權後的件數（有團主＝Σ share/100；沒有團主＝有效訂單數）：團主層級加權客訴率的分母 */
  validWeighted: number;
  /** 有效淨銷售額 ÷ 有效訂單數；沒有有效訂單為 null */
  aov: number | null;
  /** 退款金額 ÷ GMV（金額口徑，沿用商業可行性實際值回寫既有欄位）；GMV 為 0 為 null */
  refundRateByAmountPct: number | null;
}

export function foldActualSales(r: { total: unknown; established: unknown; valid: unknown; refunded: unknown; cancelled: unknown; gmv: unknown; refund: unknown; valid_weighted?: unknown }): ActualSales {
  const gmv = Math.round(Number(r.gmv)), refund = Math.round(Number(r.refund)), valid = Number(r.valid);
  const nsv = gmv - refund;
  return {
    total: Number(r.total), established: Number(r.established), valid, refundedOrders: Number(r.refunded), cancelled: Number(r.cancelled),
    gmv, refund, nsv, validWeighted: r.valid_weighted == null ? valid : Math.round(Number(r.valid_weighted) * 1e6) / 1e6, aov: valid > 0 ? Math.round(nsv / valid) : null,
    refundRateByAmountPct: gmv > 0 ? Math.round((refund / gmv) * 10_000) / 100 : null,
  };
}

export async function loadActualSales(db: Queryable, p: { orgId: string; campaignId: string; hostId: string | null }): Promise<ActualSales> {
  const SALES = [...SALES_STATUSES], VALID = [...EFFECTIVE_ORDER_STATUSES];
  const res = p.hostId
    ? await db.query(
        `SELECT count(DISTINCT o.id)::int AS total,
                count(DISTINCT o.id) FILTER (WHERE o.status = ANY($3::text[]))::int AS established,
                count(DISTINCT o.id) FILTER (WHERE o.status = ANY($4::text[]))::int AS valid,
                count(DISTINCT o.id) FILTER (WHERE o.status = ANY($3::text[]) AND (o.status IN ('PARTIAL_REFUND','REFUNDED') OR o.refund_amount > 0))::int AS refunded,
                count(DISTINCT o.id) FILTER (WHERE o.status = 'CANCELLED')::int AS cancelled,
                coalesce(sum(o.gross_amount * a.share_percent / 100.0) FILTER (WHERE o.status = ANY($3::text[])),0) AS gmv,
                coalesce(sum(o.refund_amount * a.share_percent / 100.0) FILTER (WHERE o.status = ANY($3::text[])),0) AS refund,
                coalesce(sum(a.share_percent / 100.0) FILTER (WHERE o.status = ANY($4::text[])),0) AS valid_weighted
         FROM orders o JOIN attributions a ON a.order_id=o.id AND a.host_id=$5 WHERE o.campaign_id=$1 AND o.organization_id=$2`, [p.campaignId, p.orgId, SALES, VALID, p.hostId])
    : await db.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = ANY($3::text[]))::int AS established,
                count(*) FILTER (WHERE status = ANY($4::text[]))::int AS valid,
                count(*) FILTER (WHERE status = ANY($3::text[]) AND (status IN ('PARTIAL_REFUND','REFUNDED') OR refund_amount > 0))::int AS refunded,
                count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
                coalesce(sum(gross_amount) FILTER (WHERE status = ANY($3::text[])),0) AS gmv,
                coalesce(sum(refund_amount) FILTER (WHERE status = ANY($3::text[])),0) AS refund
         FROM orders WHERE campaign_id=$1 AND organization_id=$2`, [p.campaignId, p.orgId, SALES, VALID]);
  return foldActualSales(res.rows[0] as never);
}
