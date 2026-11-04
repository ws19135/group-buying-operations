import type { Queryable } from '../lib/db';
import { resolveCaseAttribution, summarizeComplaints, type CaseAttribution, type ComplaintStats } from '../lib/complaint-attribution';

/**
 * 客服案件（客訴）的團主歸屬資料彙整（只讀）。規則在 lib/complaint-attribution.ts：優先由訂單歸因推導，人工指定只用於無法推導的案件，其餘保持未歸屬。
 * 公司整體客訴件數每件只算一次；團主層級另列，共同歸因的件數整體不重複計算。
 */
export async function loadCaseAttributions(db: Queryable, orgId: string, caseRows: { id: string; order_id: string | null; attributed_host_id: string | null }[]): Promise<CaseAttribution[]> {
  const orderIds = Array.from(new Set(caseRows.map((c) => c.order_id).filter((x): x is string => !!x)));
  const byOrder = new Map<string, string[]>();
  if (orderIds.length) {
    const rows = await db.query<{ order_id: string; host_id: string }>(`SELECT order_id, host_id FROM attributions WHERE organization_id=$1 AND order_id = ANY($2::text[])`, [orgId, orderIds]);
    for (const r of rows.rows) byOrder.set(r.order_id, [...(byOrder.get(r.order_id) ?? []), r.host_id]);
  }
  return caseRows.map((c) => resolveCaseAttribution({ caseId: c.id, manualHostId: c.attributed_host_id, orderId: c.order_id, orderHostIds: c.order_id ? byOrder.get(c.order_id) ?? [] : [] }));
}

/** 某檔期的客訴統計（排除已取消）：整體、未歸屬、共同歸因、各團主 */
export async function loadComplaintStats(db: Queryable, orgId: string, campaignId: string): Promise<ComplaintStats> {
  const cases = await db.query<{ id: string; order_id: string | null; attributed_host_id: string | null }>(
    `SELECT id, order_id, attributed_host_id FROM service_cases WHERE organization_id=$1 AND campaign_id=$2 AND status <> 'CANCELLED'`, [orgId, campaignId]);
  return summarizeComplaints(await loadCaseAttributions(db, orgId, cases.rows));
}
