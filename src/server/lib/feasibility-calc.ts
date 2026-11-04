import { z } from 'zod';

/**
 * SOP 03 商業可行性試算（純函式）。口徑沿用 docs/biz-model/04-FINANCE_AND_COMMISSION.md 的提案（待 Owner 確認）：
 *   GMV、有效淨銷售額、品牌利潤、公司營業收入是四個不同的數字；GMV 與代收款不是公司收入。
 * 原則：缺少的輸入就是「未知」，結果為 null 並列出缺什麼；不捏造、不預設為 0。
 * 只支援單一費率＋固定費；階梯、保底、更正等進階口徑尚未納入。
 */
export const PARTIES = ['BRAND', 'COMPANY', 'HOST'] as const;
export const CASH_FLOW_MODES = ['BRAND_COLLECTS', 'HOST_COLLECTS', 'COMPANY_ESCROW'] as const;
export const SOURCE_KINDS = ['VENDOR_QUOTE', 'TRIAL_ACTUAL', 'HISTORICAL_DATA', 'CONTRACT', 'FORMAL_TERMS', 'MANUAL_ESTIMATE'] as const;
export const SOURCE_LABEL: Record<string, string> = { VENDOR_QUOTE: '廠商報價', TRIAL_ACTUAL: '試用／小團實際', HISTORICAL_DATA: '歷史資料', CONTRACT: '合約', FORMAL_TERMS: '正式商務條件（已確認）', MANUAL_ESTIMATE: '人工估計' };
/** 只有這兩種來源算「已確認的合作合約或正式商務條件」：實際貢獻利潤只採用這類來源的條件（Owner 決策 K-3） */
export const CONFIRMED_SOURCE_KINDS: readonly string[] = ['CONTRACT', 'FORMAL_TERMS'];
export const PARTY_LABEL: Record<string, string> = { BRAND: '品牌', COMPANY: '公司', HOST: '團主' };

const nn = <T extends z.ZodTypeAny>(s: T) => s.nullable().optional();
const money = z.number().int().min(0).max(10_000_000_000);
const pct = z.number().min(0).max(100);

export const feasibilityInputSchema = z.object({
  expectedOrders: nn(z.number().int().min(0).max(100_000_000)),
  unitPrice: nn(money),
  refundRatePct: nn(pct),
  unitCost: nn(money),
  shippingPerOrder: nn(money),
  platformFeePct: nn(pct),
  platformFeePerOrder: nn(money),
  otherVariablePerOrder: nn(money),
  fixedCost: nn(money),
  brandFeePct: nn(pct),
  serviceFeeFixed: nn(money),
  hostCommissionPct: nn(pct),
  commissionBasis: nn(z.enum(['NSV', 'GMV'])),
  hostPaidBy: nn(z.enum(['COMPANY', 'BRAND'])),
  cashFlowMode: nn(z.enum(CASH_FLOW_MODES)),
  shippingBorneBy: nn(z.enum(PARTIES)),
  platformFeeBorneBy: nn(z.enum(PARTIES)),
  otherCostBorneBy: nn(z.enum(PARTIES)),
  fixedCostBorneBy: nn(z.enum(PARTIES)),
  /** 每一筆退款／退貨的處理成本（退貨運費、處理費等）與負擔方 */
  returnCostPerRefundOrder: nn(money),
  returnCostBorneBy: nn(z.enum(PARTIES)),
}).strict();
export type FeasibilityInputs = z.infer<typeof feasibilityInputSchema>;

/** 敏感欄位：成本、費用、分潤與付款／負擔安排。沒有 product.cost.read 的角色不可讀寫 */
export const SENSITIVE_INPUT_KEYS = [
  'unitCost', 'shippingPerOrder', 'platformFeePct', 'platformFeePerOrder', 'otherVariablePerOrder', 'fixedCost',
  'brandFeePct', 'serviceFeeFixed', 'hostCommissionPct', 'commissionBasis', 'hostPaidBy',
  'shippingBorneBy', 'platformFeeBorneBy', 'otherCostBorneBy', 'fixedCostBorneBy', 'returnCostPerRefundOrder', 'returnCostBorneBy',
] as const;
export const NON_SENSITIVE_INPUT_KEYS = ['expectedOrders', 'unitPrice', 'refundRatePct', 'cashFlowMode'] as const;
export const SENSITIVE_RESULT_KEYS = ['productCost', 'shippingTotal', 'platformFeeTotal', 'otherVariableTotal', 'returnCostTotal', 'fixedCost', 'companyRevenue', 'hostCommission', 'companyContribution', 'brandProfit', 'hostIncome', 'takeRatePct', 'brandMarginPct', 'contributionMarginPct', 'escrowRemitToBrand'] as const;

export interface FeasibilityResults {
  gmv: number | null; refund: number | null; nsv: number | null;
  productCost: number | null; shippingTotal: number | null; platformFeeTotal: number | null; otherVariableTotal: number | null; fixedCost: number | null;
  /** 退款／退貨處理成本合計（沒有填這項輸入、也不要求時為 null，不影響其他結果） */
  returnCostTotal?: number | null;
  companyRevenue: number | null; hostCommission: number | null;
  companyContribution: number | null; brandProfit: number | null; hostIncome: number | null;
  takeRatePct: number | null; brandMarginPct: number | null; contributionMarginPct: number | null;
  escrowRemitToBrand: number | null;
  /** 每個結果缺少哪些輸入 */
  missing: Record<string, string[]>;
  notes: string[];
}

export const INPUT_LABEL: Record<string, string> = {
  expectedOrders: '預估訂單數', unitPrice: '團購價', refundRatePct: '退款率', unitCost: '單位商品成本', shippingPerOrder: '運費／單', platformFeePct: '平台費比例', platformFeePerOrder: '平台費／單',
  otherVariablePerOrder: '其他變動成本／單', fixedCost: '固定費用', brandFeePct: '品牌端服務費比例', serviceFeeFixed: '品牌端服務費（固定）', hostCommissionPct: '團主分潤比例',
  commissionBasis: '分潤基礎', hostPaidBy: '團主分潤付款方', cashFlowMode: '收款模式', shippingBorneBy: '運費負擔方', platformFeeBorneBy: '平台費負擔方', otherCostBorneBy: '其他變動成本負擔方', fixedCostBorneBy: '固定費用負擔方',
  returnCostPerRefundOrder: '退款／退貨處理成本（每筆）', returnCostBorneBy: '退款／退貨費用負擔方',
};

/** 四捨五入到整數元（half-up）；費率以千分位整數運算避免浮點誤差 */
const rnd = (n: number) => Math.sign(n) * Math.floor(Math.abs(n) + 0.5);
const pctOf = (amount: number, ratePct: number) => rnd((amount * Math.round(ratePct * 1000)) / 100_000);
const pct2 = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10_000) / 100 : null);
const has = (v: unknown): v is number => typeof v === 'number';

/** 實際值模式：用實際訂單、GMV、退款與退款訂單數取代「預估訂單數 × 團購價 × 退款率」，其餘條款（費率、負擔方、付款方）與試算完全相同 */
export interface ActualBasis { orders: number; gmv: number; refund: number; refundedOrders: number }
export interface CalcOptions { actual?: ActualBasis; /** 退款／退貨處理成本與負擔方一定要填（實際貢獻利潤用）；預設不要求，維持舊試算結果不變 */ requireReturnCost?: boolean }

export function calcFeasibility(input: FeasibilityInputs, opts: CalcOptions = {}): FeasibilityResults {
  const act = opts.actual;
  const i: FeasibilityInputs = act ? { ...input, expectedOrders: act.orders, unitPrice: input.unitPrice ?? 0, refundRatePct: input.refundRatePct ?? 0 } : input;
  const missing: Record<string, string[]> = {};
  const need = (res: string, ...keys: (keyof FeasibilityInputs)[]) => {
    const m = keys.filter((k) => i[k] == null).map((k) => INPUT_LABEL[k] ?? k);
    if (m.length) missing[res] = [...(missing[res] ?? []), ...m];
    return m.length === 0;
  };
  const notes: string[] = [act ? '實際值：訂單、GMV、退款來自實際訂單；費率、負擔方與付款方沿用商業可行性的條件（口徑同 docs/biz-model/04 §2.2）' : '試算：口徑待 Owner 確認（見 docs/biz-model/04）；只支援單一費率與固定費', '商品成本以出貨量（預估訂單數）計算，未扣除退貨回收', '平台費比例以 GMV（成交總額）為基礎'];

  const gmv = act ? act.gmv : need('gmv', 'expectedOrders', 'unitPrice') ? (i.expectedOrders as number) * (i.unitPrice as number) : null;
  const refund = act ? act.refund : gmv != null && need('refund', 'refundRatePct') ? pctOf(gmv, i.refundRatePct as number) : null;
  if (gmv == null) missing.refund = [...(missing.refund ?? []), 'GMV（成交總額）'];
  const nsv = gmv != null && refund != null ? gmv - refund : null;
  if (nsv == null && !missing.nsv) missing.nsv = [...new Set([...(missing.gmv ?? []), ...(missing.refund ?? [])])];

  const productCost = need('productCost', 'unitCost', 'expectedOrders') ? (i.unitCost as number) * (i.expectedOrders as number) : null;
  const shippingTotal = need('shippingTotal', 'shippingPerOrder', 'expectedOrders') ? (i.shippingPerOrder as number) * (i.expectedOrders as number) : null;
  let platformFeeTotal: number | null = null;
  if (i.platformFeePct == null && i.platformFeePerOrder == null) missing.platformFeeTotal = [INPUT_LABEL.platformFeePct, INPUT_LABEL.platformFeePerOrder];
  else {
    let sum = 0, ok = true;
    if (has(i.platformFeePct)) { if (gmv == null) { ok = false; missing.platformFeeTotal = ['GMV（成交總額）']; } else sum += pctOf(gmv, i.platformFeePct); }
    if (has(i.platformFeePerOrder)) { if (!has(i.expectedOrders)) { ok = false; missing.platformFeeTotal = [...(missing.platformFeeTotal ?? []), INPUT_LABEL.expectedOrders]; } else sum += i.platformFeePerOrder * i.expectedOrders; }
    platformFeeTotal = ok ? sum : null;
  }
  const otherVariableTotal = need('otherVariableTotal', 'otherVariablePerOrder', 'expectedOrders') ? (i.otherVariablePerOrder as number) * (i.expectedOrders as number) : null;
  const fixedCost = need('fixedCost', 'fixedCost') ? (i.fixedCost as number) : null;
  // 退款／退貨處理成本：筆數＝（預估）退款訂單數；預估＝預估訂單數 × 退款率，實際＝實際有退款的訂單數
  const refundedOrders = act ? act.refundedOrders : has(i.expectedOrders) && has(i.refundRatePct) ? rnd((i.expectedOrders * Math.round(i.refundRatePct * 1000)) / 100_000) : null;
  const returnCostWanted = opts.requireReturnCost === true || i.returnCostPerRefundOrder != null || i.returnCostBorneBy != null;
  const returnCostTotal = i.returnCostPerRefundOrder != null && refundedOrders != null ? i.returnCostPerRefundOrder * refundedOrders : null;

  const basisAmount = i.commissionBasis === 'NSV' ? nsv : i.commissionBasis === 'GMV' ? gmv : null;
  const basisMissing = (res: string) => {
    if (i.commissionBasis == null) missing[res] = [...(missing[res] ?? []), INPUT_LABEL.commissionBasis];
    else if (basisAmount == null) missing[res] = [...(missing[res] ?? []), i.commissionBasis === 'NSV' ? '有效淨銷售額（NSV）' : 'GMV（成交總額）'];
  };
  let companyRevenue: number | null = null;
  if (need('companyRevenue', 'brandFeePct', 'serviceFeeFixed')) {
    if (basisAmount == null) basisMissing('companyRevenue');
    else companyRevenue = pctOf(basisAmount, i.brandFeePct as number) + (i.serviceFeeFixed as number);
  } else basisMissing('companyRevenue');
  let hostCommission: number | null = null;
  if (need('hostCommission', 'hostCommissionPct')) {
    if (basisAmount == null) basisMissing('hostCommission');
    else hostCommission = pctOf(basisAmount, i.hostCommissionPct as number);
  } else basisMissing('hostCommission');

  const items: [string, number | null, FeasibilityInputs['shippingBorneBy'], keyof FeasibilityInputs][] = [
    ['運費', shippingTotal, i.shippingBorneBy, 'shippingBorneBy'], ['平台費', platformFeeTotal, i.platformFeeBorneBy, 'platformFeeBorneBy'],
    ['其他變動成本', otherVariableTotal, i.otherCostBorneBy, 'otherCostBorneBy'], ['固定費用', fixedCost, i.fixedCostBorneBy, 'fixedCostBorneBy'],
    ...(returnCostWanted ? [['退款／退貨處理成本', returnCostTotal, i.returnCostBorneBy, 'returnCostBorneBy'] as [string, number | null, FeasibilityInputs['shippingBorneBy'], keyof FeasibilityInputs]] : []),
  ];
  /** 某一方負擔的成本合計；任何成本未知，或金額大於 0 卻沒指定負擔方，就是未知 */
  const borne = (who: (typeof PARTIES)[number], res: string): number | null => {
    let sum = 0, ok = true;
    for (const [label, total, by, key] of items) {
      if (total == null) { ok = false; missing[res] = [...(missing[res] ?? []), `${label}`]; continue; }
      if (total > 0 && by == null) { ok = false; missing[res] = [...(missing[res] ?? []), INPUT_LABEL[key as string]]; continue; }
      if (total > 0 && by === who) sum += total;
    }
    return ok ? sum : null;
  };

  let companyContribution: number | null = null;
  {
    const cost = borne('COMPANY', 'companyContribution');
    const need2 = need('companyContribution', 'hostPaidBy');
    if (companyRevenue == null) missing.companyContribution = [...(missing.companyContribution ?? []), '公司營業收入'];
    if (need2 && i.hostPaidBy === 'COMPANY' && hostCommission == null) missing.companyContribution = [...(missing.companyContribution ?? []), '團主分潤'];
    if (cost != null && need2 && companyRevenue != null && (i.hostPaidBy !== 'COMPANY' || hostCommission != null)) companyContribution = companyRevenue - (i.hostPaidBy === 'COMPANY' ? (hostCommission as number) : 0) - cost;
  }
  let brandProfit: number | null = null;
  {
    const cost = borne('BRAND', 'brandProfit');
    const need2 = need('brandProfit', 'hostPaidBy');
    if (nsv == null) missing.brandProfit = [...(missing.brandProfit ?? []), '有效淨銷售額'];
    if (productCost == null) missing.brandProfit = [...(missing.brandProfit ?? []), '商品成本'];
    if (companyRevenue == null) missing.brandProfit = [...(missing.brandProfit ?? []), '公司營業收入'];
    if (need2 && i.hostPaidBy === 'BRAND' && hostCommission == null) missing.brandProfit = [...(missing.brandProfit ?? []), '團主分潤'];
    if (cost != null && need2 && nsv != null && productCost != null && companyRevenue != null && (i.hostPaidBy !== 'BRAND' || hostCommission != null)) {
      brandProfit = nsv - productCost - companyRevenue - (i.hostPaidBy === 'BRAND' ? (hostCommission as number) : 0) - cost;
    }
  }
  let hostIncome: number | null = null;
  {
    const cost = borne('HOST', 'hostIncome');
    if (hostCommission == null) missing.hostIncome = [...(missing.hostIncome ?? []), '團主分潤'];
    if (cost != null && hostCommission != null) hostIncome = hostCommission - cost;
  }
  const uniq = (a: string[]) => [...new Set(a)];
  for (const k of Object.keys(missing)) missing[k] = uniq(missing[k]);
  for (const k of Object.keys(missing)) if (!missing[k].length) delete missing[k];

  const escrowRemitToBrand = i.cashFlowMode === 'COMPANY_ESCROW' && nsv != null && companyRevenue != null ? nsv - companyRevenue : null;
  if (i.cashFlowMode === 'COMPANY_ESCROW') notes.push('代營運居中：代收款是負債（應付品牌貨款），不是公司收入');
  return {
    gmv, refund, nsv, productCost, shippingTotal, platformFeeTotal, otherVariableTotal, fixedCost, returnCostTotal: returnCostWanted ? returnCostTotal : null, companyRevenue, hostCommission,
    companyContribution, brandProfit, hostIncome,
    takeRatePct: companyRevenue != null && nsv != null ? pct2(companyRevenue, nsv) : null,
    brandMarginPct: brandProfit != null && nsv != null ? pct2(brandProfit, nsv) : null,
    contributionMarginPct: companyContribution != null && companyRevenue != null ? pct2(companyContribution, companyRevenue) : null,
    escrowRemitToBrand, missing, notes,
  };
}

/** 沒有敏感權限時：把敏感輸入與結果換成 null，並標示 restricted */
export function maskInputs(inputs: Record<string, unknown>, canSeeSensitive: boolean): Record<string, unknown> {
  if (canSeeSensitive) return inputs;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inputs)) out[k] = (SENSITIVE_INPUT_KEYS as readonly string[]).includes(k) ? null : v;
  return out;
}
export function maskResults(results: Record<string, unknown>, canSeeSensitive: boolean): Record<string, unknown> {
  if (canSeeSensitive) return results;
  const out: Record<string, unknown> = { ...results };
  for (const k of SENSITIVE_RESULT_KEYS) out[k] = null;
  out.missing = {};
  out.notes = [];
  out.restricted = true;
  return out;
}
export const touchesSensitiveInputs = (patch: Record<string, unknown>): boolean => Object.entries(patch).some(([k, v]) => v != null && (SENSITIVE_INPUT_KEYS as readonly string[]).includes(k));
