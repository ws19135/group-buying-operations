import { pool, query } from '../lib/db';
import type { Queryable } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, requirePerm } from '../lib/permissions';
import { forbidden, notFound } from '../lib/errors';
import { campaignScope } from '../lib/scope';
import { SALES_STATUSES } from '../lib/kpi';
import { loadActualSales } from '../lib/actual-sales';
import { calcFeasibility, feasibilityInputSchema, type FeasibilityInputs } from '../lib/feasibility-calc';
import { buildFeeReport, type FeeReport } from '../lib/fee-attribution';
import { compareAllocations, type AllocationComparison, type ProductBasis, type SharedCost } from '../lib/cost-allocation-proposal';

/**
 * 唯讀的財務對照報告（Owner 決策 K-7、K-8）：費用歸屬對照、多商品成本分攤提案分析。
 * 只讀取既有資料；不寫入、不改結算、不產生任何生效的分攤規則；資料含成本與費用負擔（敏感），需 finance.read 與 product.cost.read。
 */
function requireFinanceCost(actor: Actor) {
  requirePerm(actor, 'finance.read');
  if (!can(actor, 'product.cost.read')) throw forbidden('費用負擔與成本屬敏感資料，需有成本檢視權限');
}
export const FEE_NOTE = '唯讀對照：KPI 試算與正式結算維持分離。這份報告不改任何資料；實際付款、發票、已確認結算更正與歷史回填，都需 Owner 或既有有權角色另案核准。「可能的應收／應付」只說明在什麼條件下可能發生與需要確認什麼，不入帳。';

async function expensesByCategory(db: Queryable, orgId: string, campaignId: string): Promise<Record<string, { total: number; count: number }>> {
  const r = await db.query<{ category: string; total: string; n: number }>(`SELECT category, sum(amount) AS total, count(*)::int AS n FROM expenses WHERE organization_id=$1 AND campaign_id=$2 AND status='RECORDED' GROUP BY category`, [orgId, campaignId]);
  return Object.fromEntries(r.rows.map((x) => [x.category, { total: Number(x.total), count: Number(x.n) }]));
}

export async function getFeeAttributionReport(actor: Actor, opts: { campaignId?: string } = {}): Promise<{ reports: FeeReport[]; notAlignedSummary: Record<string, number>; note: string; integrationProposal: string }> {
  requireFinanceCost(actor);
  const db = pool();
  const sc = campaignScope(actor, 2, 'c');
  const base = { reports: [] as FeeReport[], notAlignedSummary: {} as Record<string, number>, note: FEE_NOTE, integrationProposal: 'docs/phase2/KPI_SETTLEMENT_INTEGRATION_PROPOSAL.md' };
  if (sc.sql === 'FALSE') return base;
  const camps = await query<{ id: string; title: string }>(
    `SELECT c.id, c.title FROM campaigns c WHERE c.organization_id=$1 AND c.status <> 'CANCELLED' AND (${sc.sql}) ${opts.campaignId ? `AND c.id=$${sc.params.length + 2}` : ''} ORDER BY c.open_date DESC NULLS LAST, c.id DESC LIMIT 30`,
    [actor.orgId, ...sc.params, ...(opts.campaignId ? [opts.campaignId] : [])]);
  for (const c of camps) {
    const prods = await query<{ product_id: string; name: string }>(`SELECT cp.product_id, p.name FROM campaign_products cp JOIN products p ON p.id=cp.product_id WHERE cp.campaign_id=$1 AND cp.deleted_at IS NULL ORDER BY p.name`, [c.id]);
    if (!prods.length) continue;
    const multi = prods.length > 1;
    const expenses = await expensesByCategory(db, actor.orgId, c.id);
    const st = (await db.query<{ id: string; status: string }>(`SELECT id, status FROM settlements WHERE organization_id=$1 AND campaign_id=$2 AND status IN ('DRAFT','CONFIRMED') ORDER BY created_at DESC LIMIT 1`, [actor.orgId, c.id])).rows[0];
    const items = st ? Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM settlement_items WHERE settlement_id=$1`, [st.id])).rows[0].n) : 0;
    const adj = st ? Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM settlement_adjustments WHERE settlement_id=$1`, [st.id])).rows[0].n) : 0;
    const ref = (await db.query<{ total: string | null; n: number }>(`SELECT sum(amount) AS total, count(*)::int AS n FROM refund_requests WHERE organization_id=$1 AND campaign_id=$2 AND status IN ('APPROVED','COMPLETED')`, [actor.orgId, c.id])).rows[0];
    const sales = multi ? null : await loadActualSales(db, { orgId: actor.orgId, campaignId: c.id, hostId: null });
    for (const p of prods) {
      const fz = (await db.query<{ id: string; version_no: number; inputs: Record<string, unknown>; sources: Record<string, { kind?: string }> }>(
        `SELECT id, version_no, inputs, sources FROM feasibility_scenarios WHERE organization_id=$1 AND product_id=$2 AND campaign_id=$3 ORDER BY (host_id IS NULL) DESC, created_at DESC, id DESC LIMIT 1`, [actor.orgId, p.product_id, c.id])).rows[0];
      let calc = null;
      if (fz && sales) {
        const parsed = feasibilityInputSchema.safeParse(fz.inputs);
        if (parsed.success) calc = calcFeasibility(parsed.data as FeasibilityInputs, { actual: { orders: sales.valid, gmv: sales.gmv, refund: sales.refund, refundedOrders: sales.refundedOrders } });
      }
      base.reports.push(buildFeeReport({
        campaignId: c.id, campaignTitle: c.title, productId: p.product_id, productName: p.name,
        scenario: fz ? { id: fz.id, versionNo: Number(fz.version_no), inputs: fz.inputs as Partial<FeasibilityInputs>, sources: fz.sources ?? {} } : null,
        calc, multiProduct: multi, expenses, settlement: { exists: !!st, status: st?.status ?? null, adjustmentCount: adj, hasHostCommissionItems: items > 0 }, refunds: { total: Number(ref.total ?? 0), count: Number(ref.n) },
      }));
    }
  }
  for (const r of base.reports) for (const label of r.notAlignedItems) base.notAlignedSummary[label] = (base.notAlignedSummary[label] ?? 0) + 1;
  return base;
}

// ---------------- K-7：多商品檔期成本分攤提案分析（提案，未生效） ----------------
export interface InventoryItem { key: string; label: string; status: 'AVAILABLE' | 'PARTIAL' | 'MISSING'; detail: string }
export interface AllocationAnalysis {
  campaignId: string; campaignTitle: string; multiProduct: boolean; effective: false;
  products: ProductBasis[]; inventory: InventoryItem[]; assumptions: string[]; costs: SharedCost[]; comparison: AllocationComparison | null;
  kpiImpact: string; note: string;
}

export async function getCostAllocationAnalysis(actor: Actor, campaignId: string): Promise<AllocationAnalysis> {
  requireFinanceCost(actor);
  const db = pool();
  const sc = campaignScope(actor, 2, 'c');
  const camp = sc.sql === 'FALSE' ? undefined : (await query<{ id: string; title: string }>(`SELECT c.id, c.title FROM campaigns c WHERE c.id=$1 AND (${sc.sql}) AND c.organization_id=$${sc.params.length + 2}`, [campaignId, ...sc.params, actor.orgId]))[0];
  if (!camp) throw notFound('檔期');
  const prods = await query<{ product_id: string; name: string }>(`SELECT cp.product_id, p.name FROM campaign_products cp JOIN products p ON p.id=cp.product_id WHERE cp.campaign_id=$1 AND cp.deleted_at IS NULL ORDER BY p.name`, [campaignId]);
  const multi = prods.length > 1;
  const SALES = [...SALES_STATUSES];
  // 以訂單明細（SKU → 商品）彙整：明細金額、數量、行數、SKU 成本是否齊全
  const lines = await query<{ order_id: string; product_id: string | null; line_amount: string; quantity: number; cost_price: string | null; has_sku: boolean; gross: string; refund: string }>(
    `SELECT oi.order_id, s.product_id, oi.line_amount, oi.quantity, s.cost_price, (oi.sku_id IS NOT NULL) AS has_sku, o.gross_amount AS gross, o.refund_amount AS refund
     FROM order_items oi JOIN orders o ON o.id=oi.order_id LEFT JOIN skus s ON s.id=oi.sku_id WHERE o.organization_id=$1 AND o.campaign_id=$2 AND o.status = ANY($3::text[])`, [actor.orgId, campaignId, SALES]);
  const byOrderTotal = new Map<string, number>();
  for (const l of lines) byOrderTotal.set(l.order_id, (byOrderTotal.get(l.order_id) ?? 0) + Number(l.line_amount));
  const basis = new Map<string, { nsv: number; qty: number; lines: number; cost: number | null; sawUnmapped: boolean }>(prods.map((p) => [p.product_id, { nsv: 0, qty: 0, lines: 0, cost: 0, sawUnmapped: false }]));
  let unmapped = 0;
  for (const l of lines) {
    const b = l.product_id ? basis.get(l.product_id) : undefined;
    if (!b) { unmapped++; continue; }
    const tot = byOrderTotal.get(l.order_id) || 1;
    // 訂單退款是整筆訂單層級（沒有逐明細退款）：依明細金額占比拆分，僅供提案比較（見 assumptions）
    b.nsv += Number(l.line_amount) - (Number(l.refund) * Number(l.line_amount)) / tot;
    b.qty += l.quantity; b.lines += 1;
    if (l.cost_price == null) b.cost = null; else if (b.cost != null) b.cost += Number(l.cost_price) * l.quantity;
  }
  const products: ProductBasis[] = prods.map((p) => { const b = basis.get(p.product_id)!; return { productId: p.product_id, name: p.name, nsv: b.lines ? Math.round(b.nsv) : null, quantity: b.lines ? b.qty : null, orderLines: b.lines || null, productCost: b.lines ? b.cost : null }; });
  const expenses = await expensesByCategory(db, actor.orgId, campaignId);
  const scenarios = await Promise.all(prods.map(async (p) => (await db.query<{ inputs: Record<string, unknown> }>(`SELECT inputs FROM feasibility_scenarios WHERE organization_id=$1 AND product_id=$2 AND campaign_id=$3 ORDER BY (host_id IS NULL) DESC, created_at DESC, id DESC LIMIT 1`, [actor.orgId, p.product_id, campaignId])).rows[0]?.inputs ?? null));
  const platformRates = scenarios.map((s) => (typeof s?.platformFeePct === 'number' ? s.platformFeePct : null));
  const sameRate = platformRates.length > 0 && platformRates.every((r) => r != null && r === platformRates[0]);
  const CAT_LABEL: Record<string, string> = { SHIPPING: '運費', PLATFORM_FEE: '平台費', MARKETING: '行銷費用', SAMPLE: '樣品費用', OTHER: '其他費用' };
  const costs: SharedCost[] = Object.entries(expenses).map(([cat, e]) => ({
    key: cat, label: `${CAT_LABEL[cat] ?? cat}（財務已記錄 ${e.count} 筆）`, amount: e.total,
    ...(cat === 'PLATFORM_FEE' && sameRate ? { direct: { kind: 'RATE_ON_NSV' as const, ratePct: platformRates[0] as number } } : {}),
  }));
  const withScenario = scenarios.filter(Boolean).length;
  const costKnown = products.filter((p) => p.productCost != null).length;
  const inventory: InventoryItem[] = [
    { key: 'orderItems', label: '訂單明細與 SKU 對應', status: lines.length === 0 ? 'MISSING' : unmapped ? 'PARTIAL' : 'AVAILABLE', detail: lines.length === 0 ? '沒有計入銷售的訂單明細' : `${lines.length} 行明細${unmapped ? `，其中 ${unmapped} 行沒有對應到此檔期的商品（SKU 未對應）` : '，皆可對應到商品'}` },
    { key: 'productCost', label: '商品成本（SKU 成本）', status: costKnown === products.length ? 'AVAILABLE' : costKnown ? 'PARTIAL' : 'MISSING', detail: `${costKnown}／${products.length} 個商品的 SKU 成本齊全；缺成本的商品，成本維持未知（不當 0）` },
    { key: 'refundLine', label: '退款（逐明細）', status: 'MISSING', detail: '退款只記在整筆訂單，沒有逐明細的退款；商品層級的有效淨銷售額需依明細金額占比拆分（提案中的假設）' },
    { key: 'expenses', label: '財務已記錄的支出', status: Object.keys(expenses).length ? 'PARTIAL' : 'MISSING', detail: Object.keys(expenses).length ? `已記錄 ${Object.values(expenses).reduce((a, e) => a + e.count, 0)} 筆；但支出只有檔期與類別，沒有商品、負擔方、實際付款方` : '沒有財務支出紀錄；共同費用金額未知，不分攤' },
    { key: 'scenarioTerms', label: '各商品的合作條款（商業可行性）', status: withScenario === products.length ? 'AVAILABLE' : withScenario ? 'PARTIAL' : 'MISSING', detail: `${withScenario}／${products.length} 個商品有此檔期的可行性條款；每個商品各一份，沒有檔期層級的共同費用欄位（固定費用、整筆運費的歸屬不明）` },
    { key: 'serviceFeeCommission', label: '公司服務費與團主分潤', status: withScenario ? 'PARTIAL' : 'MISSING', detail: '以有效淨銷售額乘費率的項目可直接歸屬到商品；固定服務費無法直接歸屬' },
    { key: 'fixedCost', label: '固定成本', status: 'MISSING', detail: '固定費用在每份可行性條款各填一次，沒有「共同費用」層級；需 Owner 決定放在哪個層級' },
    { key: 'returnCost', label: '退款及退貨處理成本', status: 'MISSING', detail: '沒有逐明細的退款，也沒有逐商品的退貨處理紀錄；只能依退款訂單數估算（需明確標示為估算）' },
  ];
  const assumptions = ['商品層級的有效淨銷售額：訂單層級的退款依明細金額占比拆分（沒有逐明細退款資料）', '共同費用金額取自財務「已記錄的支出」（只有檔期與類別）；沒有紀錄的類別視為未知，不分攤', '平台費只有在所有商品的條款費率一致時，才視為可直接歸屬；否則依分攤方法處理'];
  const comparison = multi ? compareAllocations(products, costs) : null;
  return {
    campaignId, campaignTitle: camp.title, multiProduct: multi, effective: false, products, inventory, assumptions, costs, comparison,
    kpiImpact: multi ? '多商品檔期的每單貢獻利潤仍是「資料不足」：在 Owner 核准分攤規則之前，KPI、實際值回寫與結算都不使用這裡的任何結果' : '這不是多商品檔期，每單貢獻利潤依既有規則計算；不需要分攤',
    note: '提案，未生效：只供 Owner 比較不同分攤方法；不寫入任何資料、不新增任何生效的分攤規則、不修改結算；未知金額的費用不分攤、不當 0。',
  };
}
