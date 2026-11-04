import type { AllocationComparison, ProductBasis } from './cost-allocation-proposal';

/**
 * 多商品成本分攤：費用分類、各方法對「公司利潤」與「商品利潤」的影響、風險偵測（Owner 決策 K-7a～e；純函式；**唯讀試算，未生效**）。
 * - 分類：直接歸屬商品／檔期共同／特定團主（依 K-8a 的「對應商品」「對應團主」欄位；不推測）。
 * - 公司利潤與分攤方法無關（只要每一筆費用都被計入一次）；方法只改變「商品之間」怎麼分；差額（分不掉、算太多）要明講。
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
}
export interface ClassifiedExpense extends ExpenseForAllocation { cls: CostClass; countsAsCompanyCost: boolean; bearerUnknown: boolean }

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
  companyCostTotal: number;
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
  // 承擔方是品牌或團主：不是公司成本；承擔方未記錄：暫計入（維持既有分析口徑）並提示待確認
  const countsAsCompanyCost = e.bearerParty == null || e.bearerParty === 'COMPANY';
  return { ...e, cls, countsAsCompanyCost, bearerUnknown };
}

export interface ImpactInput {
  products: ProductBasis[];
  expenses: ExpenseForAllocation[];
  period: { openDate: string | null; closeDate: string | null };
  comparison: AllocationComparison | null;
  /** 以費率直接歸屬（RATE_ON_NSV）的共同費用類別（例如條款一致的平台費） */
  rateDirectCategories?: string[];
}

export function analyzeCostImpact(input: ImpactInput): CostImpactReport {
  const { products, period, comparison } = input;
  const productIds = new Set(products.map((p) => p.productId));
  const classified = input.expenses.map(classifyExpense);
  const company = classified.filter((e) => e.countsAsCompanyCost);
  const excluded = classified.filter((e) => !e.countsAsCompanyCost);
  const sum = (xs: ClassifiedExpense[]) => xs.reduce((a, e) => a + e.amount, 0);

  // 對應商品不在此檔期：不能直接歸屬，列為未分攤（不猜測歸到誰）
  const orphanDirect = company.filter((e) => e.cls === 'DIRECT_PRODUCT' && !productIds.has(e.productId as string));
  const directOk = company.filter((e) => e.cls === 'DIRECT_PRODUCT' && productIds.has(e.productId as string));
  const hostSpecific = company.filter((e) => e.cls === 'HOST_SPECIFIC');
  const shared = company.filter((e) => e.cls === 'CAMPAIGN_SHARED');
  const directByProduct = new Map<string, number>();
  for (const e of directOk) directByProduct.set(e.productId as string, (directByProduct.get(e.productId as string) ?? 0) + e.amount);

  const sharedPoolTotal = sum(shared), hostSpecificTotal = sum(hostSpecific), directTotal = sum(directOk), orphanTotal = sum(orphanDirect);
  const companyCostTotal = sharedPoolTotal + hostSpecificTotal + directTotal + orphanTotal;

  const classes = (['DIRECT_PRODUCT', 'CAMPAIGN_SHARED', 'HOST_SPECIFIC'] as CostClass[]).map((cls) => {
    const xs = classified.filter((e) => e.cls === cls);
    return { cls, label: COST_CLASS_LABEL[cls], note: COST_CLASS_NOTE[cls], count: xs.length, amount: sum(xs) };
  });

  // 各方法的影響
  const nsvKnown = products.every((p) => p.nsv != null), costKnown = products.every((p) => p.productCost != null);
  const companyProfit = nsvKnown && costKnown
    ? products.reduce((a, p) => a + (p.nsv as number) - (p.productCost as number), 0) - companyCostTotal
    : null;
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

  const usable = impact.filter((i) => i.usable);
  const productProfitSpread: Record<string, number | null> = {};
  for (const p of products) {
    const vs = usable.map((i) => i.products.find((x) => x.productId === p.productId)?.productProfit).filter((v): v is number => v != null);
    productProfitSpread[p.productId] = vs.length >= 2 && vs.length === usable.length ? Math.max(...vs) - Math.min(...vs) : null;
  }
  const companyProfitInvariant = usable.length >= 1 && companyProfit != null ? usable.every((i) => i.reconciles === true) : null;

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
  const unknownBearer = company.filter((e) => e.bearerUnknown);
  if (unknownBearer.length) risks.push({ code: 'UNALLOCATED', level: 'REVIEW', message: `${unknownBearer.length} 筆費用（${sum(unknownBearer)} 元）尚未記錄承擔方：暫計入公司成本以維持既有口徑，請財務補承擔方後再看結果`, expenseIds: ids(unknownBearer), amount: sum(unknownBearer) });
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
    impact, risks, productProfitSpread, companyProfitInvariant,
    note: '唯讀試算：公司利潤不因分攤方法改變，方法只改變商品之間的分法；毛利僅扣商品成本與財務已記錄且由公司承擔的費用（不含團主分潤、服務費、佣金）。不寫入任何資料，不影響 KPI、實際值回寫或結算。',
  };
}
