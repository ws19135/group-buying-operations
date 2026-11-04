import type { Queryable } from '../lib/db';
import { computeActualContribution, type ActualProfitResult } from '../lib/actual-profit';

/**
 * 實際公司貢獻利潤的資料彙整（KPI 與商業可行性「實際值回寫」共用）：取檔期有幾個商品、有幾位其他團主，再交給純函式 lib/actual-profit。
 * 只讀取，不寫入、不碰分潤結算。
 */
export async function actualContribution(db: Queryable, p: {
  campaignId: string; hostId: string | null;
  scenario: { inputs: Record<string, unknown>; sources: Record<string, { kind?: string }> } | null;
  actual: { valid: number; gmv: number; refund: number; refunded: number };
}): Promise<ActualProfitResult> {
  const prods = Number((await db.query<{ n: number }>(`SELECT count(DISTINCT product_id)::int AS n FROM campaign_products WHERE campaign_id=$1 AND deleted_at IS NULL`, [p.campaignId])).rows[0].n);
  const others = p.hostId ? Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM campaign_hosts WHERE campaign_id=$1 AND host_id<>$2 AND deleted_at IS NULL AND status <> 'DECLINED'`, [p.campaignId, p.hostId])).rows[0].n) : 0;
  // D-4：承擔方未確認的費用（此檔期；團主層級只算沒有指定團主或指定此團主的）
  const pendingBearer = Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM expenses WHERE campaign_id=$1 AND status='RECORDED' AND bearer_party IS NULL AND ($2::text IS NULL OR host_id IS NULL OR host_id=$2)`, [p.campaignId, p.hostId])).rows[0].n);
  return computeActualContribution({
    inputs: p.scenario?.inputs ?? {}, sources: p.scenario?.sources ?? {},
    actual: { orders: p.actual.valid, gmv: p.actual.gmv, refund: p.actual.refund, refundedOrders: p.actual.refunded },
    validOrders: p.actual.valid, hostScopedWithOtherHosts: others > 0, multiProduct: prods > 1, pendingBearerExpenses: pendingBearer,
  });
}
