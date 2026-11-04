import type { AllocationComparison, ProductBasis } from './cost-allocation-proposal';

/**
 * 多商品成本分攤：費用分類、各方法對「公司利潤」與「商品利潤」的影響、風險偵測（Owner 決策 K-7a～e；純函式；**唯讀試算，未生效**）。
 * - 分類：直接歸屬商品／檔期共同／特定團主（依 K-8a 的「對應商品」「對應團主」欄位；不推測）。
 * - 公司利潤與分攤方法無關（只要每一筆費用都被計入一次）；方法只改變「商品之間」怎麼分；差額（分不掉、算太多）要明講。
 * - Owner 決策 D-4：**承擔方未知的費用＝待確認，不是公司正式成本**；有待確認費用時，已確認口徑的公司利潤與受影響的商品利潤一律「資料不足」（不當 0、不自動算公司成本）；
 *   另外單獨列出「保守情境估計」（假設待確認費用全由公司承擔）供參考，**明確標示不是已確認成本，不得用於正式 KPI 或結算**。
 * - 風險：重複分攤、未分攤、跨期；只提示，不改任何資料，也不自動排除。
 * - 沒有核准的分攤規則前，多商品每單貢獻利潤仍是「資料不足」（本檔不影響 KPI）。
 */
export type CostClass = 'DIRECT_PRODUCT' | 'CAMPAIGN_SHARED' | 'HOST_SPECIFIC';
export const COST_CLASS_LABEL: Record<CostClass, string> = { DIRECT_PRODUCT: '直接歸屬商品', CAMPAIGN_SHARED: '檔期共同費用', HOST_SPECIFIC: '特定團主費用' };
export const COST_CLASS_NOTE: Record<CostClass, string> = {
  DIRECT_PRODUCT: '已指定對應商品：直接算在該商品，不進入共同費用池，不再分攤',
  CAMPAIGN_SHARED: '沒有對應商品或團主：屬於檔期共同費用，才需要選擇分攤方法',
  HOST_SPECIFIC: '已指定對應團主、沒有對應商品：不分到商品，列在公司層級（團主層級另行處理）',
};

export interface ExpenseForAllocation {
  id: string; category: string; amount: number;
  incurredOn: string | null;                 // YYYY-MM-DD
  bearerParty: string | null;                // BRAND／COMPANY／HOST；null＝未記錄
  productId: string | null; hostId: string | null;
  /** 承擔方的依據（條款來源種類：CONTRACT／FORMAL_TERMS／FEASIBILITY／MANUAL_ESTIMATE）；未記錄為 null */
  bearerBasisKind?: string | null;
  /** D-6：財務標記的費用歸屬範圍（DIRECT_PRODUCT／HOST_SPECIFIC／SHARED）；null＝尚未標記 */
  costScope?: string | null;
}
export type BearerStatus = 'COMPANY' | 'NOT_COMPANY' | 'PENDING';
export const BEARER_STATUS_LABEL: Record<BearerStatus, string> = { COMPANY: '公司承擔（已確認）', NOT_COMPANY: '品牌或團主承擔（不計入公司）', PENDING: '承擔方待確認' };
export interface ClassifiedExpense extends ExpenseForAllocation { cls: CostClass; bearerStatus: BearerStatus; /** 只有「公司承擔（已確認）」才是公司正式成本 */ countsAsCompanyCost: boolean; bearerUnknown: boolean }

export type RiskCode = 'DOUBLE_ALLOCATION' | 'UNALLOCATED' | 'CROSS_PERIOD';
export const RISK_LABEL: Record<RiskCode, string> = { DOUBLE_ALLOCATION: '重複分攤', UNALLOCATED: '未分攤', CROSS_PERIOD: '跨期' };
export interface AllocationRisk { code: RiskCode; level: 'REVIEW' | 'INFO'; message: string; expenseIds: string[]; amount: number | null }

export interface ProductImpact { productId: string; name: string; directExpense: number; allocatedShared: number; productCost: number | null; nsv: number | null; productProfit: number | null }
export interface MethodImpact {
  method: string; label: string; usable: boolean;
  products: ProductImpact[];
  /** 共同費用池合計 − 實際分到各商品的合計：>0 分不掉（未分攤）；<0 算太多（重複分攤）；0＝剛好 */
  poolGap: number | null;
  /** 與方法無關的公司層級毛利（扣商品成本與公司承擔的已記錄費用）；任何必要資料未知則為 null */
  companyProfit: number | null;
  /** 各商品利潤合計 − 特定團主費用 − 池差額 ＝ 公司利潤 */
  reconciles: boolean | null;
}
export interface CostImpactReport {
  effective: false;
  classes: { cls: CostClass; label: string; note: string; count: number; amount: number }[];
  classified: ClassifiedExpense[];
  sharedPoolTotal: number; hostSpecificTotal: number; directTotal: number; excludedNotCompanyTotal: number;
  /** 已確認的公司成本（承擔方明確是公司）合計；承擔方待確認的不在內 */
  companyCostTotal: number;
  /** D-4：承擔方待確認的費用（不是公司正式成本；已確認口徑的相關利潤為資料不足） */
  pendingBearer: { count: number; total: number; expenseIds: string[] };
  /** D-4：保守情境估計（假設待確認費用全由公司承擔）；不是已確認成本，不得用於正式 KPI 或結算；沒有待確認費用時為 null */
  conservative: { label: string; note: string; companyCostTotal: number; companyProfit: number | null; impact: MethodImpact[] } | null;
  impact: MethodImpact[];
  risks: AllocationRisk[];
  /** 不同方法下，商品利潤的最大差距（元），及公司利潤是否與方法無關 */
  productProfitSpread: Record<string, number | null>;
  companyProfitInvariant: boolean | null;
  note: string;
}

export function classifyExpense(e: ExpenseForAllocation): ClassifiedExpense {
  const cls: CostClass = e.productId ? 'DIRECT_PRODUCT' : e.hostId ? 'HOST_SPECIFIC' : 'CAMPAIGN_SHARED';
  const bearerUnknown = e.bearerParty == null;
  // 承擔方是公司才是正式成本；品牌或團主承擔：不計入公司；承擔方未知：待確認（D-4：不自動視為公司成本、不當 0）
  const bearerStatus: BearerStatus = bearerUnknown ? 'PENDING' : e.bearerParty === 'COMPANY' ? 'COMPANY' : 'NOT_COMPANY';
  return { ...e, cls, bearerStatus, countsAsCompanyCost: bearerStatus === 'COMPANY', bearerUnknown };
}

export interface ImpactInput {
  products: ProductBasis[];
  expenses: ExpenseForAllocation[];
  period: { openDate: string | null; closeDate: string | null };
  comparison: AllocationComparison | null;
  /** 保守情境用的比較（共同費用池含承擔方待確認者）；沒有待確認的共同費用時可省略 */
  conservativeComparison?: AllocationComparison | null;
  /** 以費率直接歸屬（RATE_ON_NSV）的共同費用類別（例如條款一致的平台費） */
  rateDirectCategories?: string[];
}

const sumOf = (xs: ClassifiedExpense[]) => xs.reduce((a, e) => a + e.amount, 0);

/** 以「被視為公司成本的那組費用」計算分類合計與各方法的利潤影響（已確認口徑與保守情境共用） */
function computeImpact(products: ProductBasis[], company: ClassifiedExpense[], comparison: AllocationComparison | null) {
  const productIds = new Set(products.map((p) => p.productId));
  // 對應商品不在此檔期：不能直接歸屬，列為未分攤（不猜測歸到誰）
  const orphanDirect = company.filter((e) => e.cls === 'DIRECT_PRODUCT' && !productIds.has(e.productId as string));
  const directOk = company.filter((e) => e.cls === 'DIRECT_PRODUCT' && productIds.has(e.productId as string));
  const hostSpecific = company.filter((e) => e.cls === 'HOST_SPECIFIC');
  const shared = company.filter((e) => e.cls === 'CAMPAIGN_SHARED');
  const directByProduct = new Map<string, number>();
  for (const e of directOk) directByProduct.set(e.productId as string, (directByProduct.get(e.productId as string) ?? 0) + e.amount);
  const sharedPoolTotal = sumOf(shared), hostSpecificTotal = sumOf(hostSpecific), directTotal = sumOf(directOk), orphanTotal = sumOf(orphanDirect);
  const companyCostTotal = sharedPoolTotal + hostSpecificTotal + directTotal + orphanTotal;
  const nsvKnown = products.every((p) => p.nsv != null), costKnown = products.every((p) => p.productCost != null);
  const companyProfit = nsvKnown && costKnown ? products.reduce((a, p) => a + (p.nsv as number) - (p.productCost as number), 0) - companyCostTotal : null;
  const impact: MethodImpact[] = (comparison?.methods ?? []).map((m) => {
    const prodImpacts: ProductImpact[] = products.map((p) => {
      const alloc = m.usable ? (m.allocations.find((a) => a.productId === p.productId)?.total ?? 0) : 0;
      // 直接歸屬的共同費用（按費率）已在分攤結果中；商品自己的直接費用另計
      const directExpense = directByProduct.get(p.productId) ?? 0;
      const profit = m.usable && p.nsv != null && p.productCost != null ? p.nsv - p.productCost - directExpense - alloc : null;
      return { productId: p.productId, name: p.name, directExpense, allocatedShared: alloc, productCost: p.productCost, nsv: p.nsv, productProfit: profit };
    });
    const allocatedSum = prodImpacts.reduce((a, x) => a + x.allocatedShared, 0);
    const poolGap = m.usable ? sharedPoolTotal - allocatedSum : null;
    const allKnown = m.usable && prodImpacts.every((x) => x.productProfit != null);
    const reconciles = allKnown && companyProfit != null
      ? prodImpacts.reduce((a, x) => a + (x.productProfit as number), 0) - hostSpecificTotal - orphanTotal - (poolGap as number) === companyProfit
      : null;
    return { method: m.method, label: m.label, usable: m.usable, products: prodImpacts, poolGap, companyProfit, reconciles };
  });
  return { orphanDirect, directOk, hostSpecific, shared, sharedPoolTotal, hostSpecificTotal, directTotal, orphanTotal, companyCostTotal, companyProfit, impact };
}

const spreadOf = (products: ProductBasis[], impact: MethodImpact[]) => {
  const usable = impact.filter((i) => i.usable);
  const out: Record<string, number | null> = {};
  for (const p of products) {
    const vs = usable.map((i) => i.products.find((x) => x.productId === p.productId)?.productProfit).filter((v): v is number => v != null);
    out[p.productId] = vs.length >= 2 && vs.length === usable.length ? Math.max(...vs) - Math.min(...vs) : null;
  }
  return out;
};

export const CONSERVATIVE_LABEL = '保守情境估計（假設承擔方待確認的費用全由公司承擔）';
export const CONSERVATIVE_NOTE = '這不是已確認的公司成本：只是「若待確認的費用最後都由公司承擔」的最壞情況估計，僅供財務判斷優先順序；不得用於正式 KPI、結算或任何對外數字。';

export function analyzeCostImpact(input: ImpactInput): CostImpactReport {
  const { products, period, comparison } = input;
  const classified = input.expenses.map(classifyExpense);
  const confirmed = classified.filter((e) => e.bearerStatus === 'COMPANY');
  const pending = classified.filter((e) => e.bearerStatus === 'PENDING');
  const excluded = classified.filter((e) => e.bearerStatus === 'NOT_COMPANY');
  const sum = sumOf;
  const base = computeImpact(products, confirmed, comparison);
  const { orphanDirect, directOk, hostSpecific, shared, sharedPoolTotal, hostSpecificTotal, directTotal, orphanTotal, companyCostTotal } = base;

  const classes = (['DIRECT_PRODUCT', 'CAMPAIGN_SHARED', 'HOST_SPECIFIC'] as CostClass[]).map((cls) => {
    const xs = classified.filter((e) => e.cls === cls);
    return { cls, label: COST_CLASS_LABEL[cls], note: COST_CLASS_NOTE[cls], count: xs.length, amount: sum(xs) };
  });

  // D-4：有承擔方待確認的費用時，已確認口徑的公司利潤與受影響的商品利潤一律「資料不足」（未知不當 0、不自動算公司成本）
  const pendingShared = pending.some((e) => e.cls === 'CAMPAIGN_SHARED');
  const pendingDirect = new Set(pending.filter((e) => e.cls === 'DIRECT_PRODUCT').map((e) => e.productId));
  const hasPending = pending.length > 0;
  const impact: MethodImpact[] = hasPending
    ? base.impact.map((i) => ({ ...i, companyProfit: null, reconciles: null, products: i.products.map((x) => (pendingShared || pendingDirect.has(x.productId) ? { ...x, productProfit: null } : x)) }))
    : base.impact;
  const companyProfit = hasPending ? null : base.companyProfit;
  const usable = impact.filter((i) => i.usable);
  const productProfitSpread = spreadOf(products, impact);
  const companyProfitInvariant = usable.length >= 1 && companyProfit != null ? usable.every((i) => i.reconciles === true) : null;

  // 保守情境（獨立計算，不混入已確認口徑）
  let conservative: CostImpactReport['conservative'] = null;
  if (hasPending) {
    const cons = computeImpact(products, [...confirmed, ...pending], input.conservativeComparison ?? comparison);
    conservative = { label: CONSERVATIVE_LABEL, note: CONSERVATIVE_NOTE, companyCostTotal: cons.companyCostTotal, companyProfit: cons.companyProfit, impact: cons.impact };
  }

  // 風險
  const risks: AllocationRisk[] = [];
  const ids = (xs: ClassifiedExpense[]) => xs.map((e) => e.id);
  // 重複分攤
  for (const cat of new Set(directOk.map((e) => e.category))) {
    const d = directOk.filter((e) => e.category === cat), s = shared.filter((e) => e.category === cat);
    if (s.length) risks.push({ code: 'DOUBLE_ALLOCATION', level: 'REVIEW', message: `「${cat}」同時有已指定商品的費用（${d.length} 筆，${sum(d)} 元）與檔期共同費用（${s.length} 筆，${sum(s)} 元）：請確認同一筆沒有兩邊都記，否則會被算兩次`, expenseIds: ids([...d, ...s]), amount: sum(d) });
  }
  for (const cat of input.rateDirectCategories ?? []) {
    const d = directOk.filter((e) => e.category === cat);
    if (d.length) risks.push({ code: 'DOUBLE_ALLOCATION', level: 'REVIEW', message: `「${cat}」在「可直接歸屬者直接算」的方法中已依費率直接計入各商品，但財務又記錄了指定商品的同類費用（${d.length} 筆，${sum(d)} 元）：可能重複`, expenseIds: ids(d), amount: sum(d) });
  }
  for (const i of usable) if (i.poolGap != null && i.poolGap < 0) risks.push({ code: 'DOUBLE_ALLOCATION', level: 'REVIEW', message: `「${i.label}」分到各商品的合計比共同費用池多 ${-i.poolGap} 元（分攤後算太多）：請確認費率或金額`, expenseIds: [], amount: -i.poolGap });
  const bothIds = classified.filter((e) => e.productId && e.hostId);
  if (bothIds.length) risks.push({ code: 'DOUBLE_ALLOCATION', level: 'INFO', message: `${bothIds.length} 筆費用同時指定了商品與團主：本分析只算在商品上一次，不另列入團主費用`, expenseIds: ids(bothIds), amount: sum(bothIds) });
  // 未分攤
  if (hostSpecificTotal > 0) risks.push({ code: 'UNALLOCATED', level: 'INFO', message: `特定團主費用 ${hostSpecificTotal} 元不分到商品，列在公司層級；若要分到商品需另有規則`, expenseIds: ids(hostSpecific), amount: hostSpecificTotal });
  if (orphanDirect.length) risks.push({ code: 'UNALLOCATED', level: 'REVIEW', message: `${orphanDirect.length} 筆費用（${orphanTotal} 元）指定的商品不在此檔期，無法歸屬：不猜測，列為未分攤`, expenseIds: ids(orphanDirect), amount: orphanTotal });
  for (const i of usable) if (i.poolGap != null && i.poolGap > 0) risks.push({ code: 'UNALLOCATED', level: 'REVIEW', message: `「${i.label}」仍有 ${i.poolGap} 元共同費用沒有分到任何商品（直接歸屬的計算與記錄金額不一致）：需人工確認`, expenseIds: [], amount: i.poolGap });
  if (hasPending) risks.push({ code: 'UNALLOCATED', level: 'REVIEW', message: `${pending.length} 筆費用（${sum(pending)} 元）承擔方待確認：不算公司正式成本、也不當 0；已確認口徑的公司利潤${pendingShared ? '與所有商品利潤' : '與受影響的商品利潤'}顯示資料不足。請財務依正式合約或已確認的商務條件補充承擔方；「保守情境估計」只是最壞情況參考，不是已確認成本`, expenseIds: ids(pending), amount: sum(pending) });
  // D-6：沒有對應商品或團主、也沒有標記為「檔期共同費用」的費用——暫依共同費用處理（只供唯讀分析），請財務明確標記
  const unmarkedShared = classified.filter((e) => e.cls === 'CAMPAIGN_SHARED' && e.costScope == null);
  if (unmarkedShared.length) risks.push({ code: 'UNALLOCATED', level: 'REVIEW', message: `${unmarkedShared.length} 筆費用（${sum(unmarkedShared)} 元）沒有對應商品或團主，也未標記為「檔期共同費用」：目前暫依共同費用處理（只供唯讀分析，不是正式分攤）；請財務標記為共同費用，或指定對應商品／團主（可直接歸屬者優先記錄明確歸屬）`, expenseIds: ids(unmarkedShared), amount: sum(unmarkedShared) });
  const weakBasis = classified.filter((e) => e.bearerStatus !== 'PENDING' && e.bearerBasisKind != null && !['CONTRACT', 'FORMAL_TERMS'].includes(e.bearerBasisKind));
  if (weakBasis.length) risks.push({ code: 'UNALLOCATED', level: 'INFO', message: `${weakBasis.length} 筆費用的承擔方依據不是正式合約或已確認的商務條件（可行性條款或人工估計）：已依財務填寫的承擔方處理，建議補上正式依據`, expenseIds: ids(weakBasis), amount: sum(weakBasis) });
  if (excluded.length) risks.push({ code: 'UNALLOCATED', level: 'INFO', message: `${excluded.length} 筆費用（${sum(excluded)} 元）由品牌或團主承擔，不計入公司利潤，也不進入分攤`, expenseIds: ids(excluded), amount: sum(excluded) });
  for (const p of products) if (p.nsv == null || p.productCost == null) risks.push({ code: 'UNALLOCATED', level: 'REVIEW', message: `商品「${p.name}」缺${p.nsv == null ? '銷售資料' : 'SKU 成本'}：利潤維持資料不足，不當 0`, expenseIds: [], amount: null });
  // 跨期
  if (period.openDate == null || period.closeDate == null) {
    risks.push({ code: 'CROSS_PERIOD', level: 'INFO', message: '檔期沒有完整的開賣／結束日期，無法判斷費用是否跨期', expenseIds: [], amount: null });
  } else {
    const out = classified.filter((e) => e.incurredOn != null && (e.incurredOn < (period.openDate as string) || e.incurredOn > (period.closeDate as string)));
    if (out.length) risks.push({ code: 'CROSS_PERIOD', level: 'REVIEW', message: `${out.length} 筆費用（${sum(out)} 元）發生日在檔期（${period.openDate}～${period.closeDate}）之外：請確認是否應計入本檔期（本分析不自動排除）`, expenseIds: ids(out), amount: sum(out) });
  }

  return {
    effective: false, classes, classified, sharedPoolTotal, hostSpecificTotal, directTotal: directTotal + orphanTotal, excludedNotCompanyTotal: sum(excluded), companyCostTotal,
    pendingBearer: { count: pending.length, total: sum(pending), expenseIds: ids(pending) }, conservative,
    impact, risks, productProfitSpread, companyProfitInvariant,
    note: '唯讀試算：公司利潤不因分攤方法改變，方法只改變商品之間的分法；毛利僅扣商品成本與「已確認由公司承擔」的費用（不含團主分潤、服務費、佣金）；承擔方待確認的費用不算公司正式成本，相關利潤為資料不足。不寫入任何資料，不影響 KPI、實際值回寫或結算。',
  };
}
