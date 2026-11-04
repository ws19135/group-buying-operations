import { CONFIRMED_SOURCE_KINDS, INPUT_LABEL, calcFeasibility, feasibilityInputSchema, type ActualBasis, type FeasibilityResults } from './feasibility-calc';

/**
 * 實際「公司貢獻利潤」（純函式；Owner 決策 K-3）。與商業可行性試算共用同一個 calcFeasibility（實際值模式），
 * 公式＝公司確認收入 − 團主分潤（若由公司支付）− 公司實際負擔的可歸屬成本；每單＝公司貢獻利潤 ÷ 有效訂單數。
 * 不把收款方、費用負擔方寫死：全部取自該檔期（合作案）的商業可行性條件，且這些條件必須來自「已確認的合作合約或正式商務條件」
 * （假設來源為「合約」或「正式商務條件（已確認）」）。條件不全、來源未確認、或任何成本未知：一律「資料不足」，未知成本不當 0。
 * 不碰分潤結算：結算（lib/commission-calc）有自己的規則，這裡只讀、只算顯示用的 KPI。
 */
/** 必須有確認來源的條款（只檢查有填的；沒填的由計算的 missing 擋下） */
export const TERM_KEYS = [
  'cashFlowMode', 'commissionBasis', 'brandFeePct', 'serviceFeeFixed', 'hostCommissionPct', 'hostPaidBy',
  'shippingPerOrder', 'shippingBorneBy', 'platformFeePct', 'platformFeePerOrder', 'platformFeeBorneBy',
  'otherVariablePerOrder', 'otherCostBorneBy', 'fixedCost', 'fixedCostBorneBy', 'returnCostPerRefundOrder', 'returnCostBorneBy',
] as const;

export interface ActualProfitInput {
  inputs: Record<string, unknown>;
  sources: Record<string, { kind?: string } | undefined>;
  actual: ActualBasis;
  validOrders: number;
  /** 訂單只算某位團主的歸因部分，且檔期還有其他團主：檔期層級的固定費用／固定服務費無法分攤到單一團主 */
  hostScopedWithOtherHosts: boolean;
  /** 檔期有多個商品：訂單無法歸屬到單一商品的成本 */
  multiProduct: boolean;
}
export interface ActualProfitResult {
  status: 'OK' | 'INSUFFICIENT';
  total: number | null;
  perOrder: number | null;
  /** 為什麼資料不足（白話） */
  reasons: string[];
  /** 缺少的輸入（含負擔方） */
  missing: string[];
  /** 已填但來源不是合約／正式商務條件的條款 */
  unconfirmed: string[];
  /** 成功時的完整結果（含公司營業收入、團主分潤等），給有權限者查看；資料不足時為 null（不顯示暫估） */
  results: FeasibilityResults | null;
}

export function computeActualContribution(i: ActualProfitInput): ActualProfitResult {
  const reasons: string[] = [], missing: string[] = [], unconfirmed: string[] = [];
  const fail = (): ActualProfitResult => ({ status: 'INSUFFICIENT', total: null, perOrder: null, reasons, missing, unconfirmed, results: null });
  if (i.multiProduct) reasons.push('這個檔期有多個商品，訂單無法歸屬到單一商品的成本與費用（不猜測）');
  if (i.validOrders <= 0) reasons.push('沒有有效訂單');
  const parsed = feasibilityInputSchema.safeParse(i.inputs);
  if (!parsed.success) { reasons.push('商業可行性的條款格式不完整，無法計算'); return fail(); }
  const inp = parsed.data;
  if (Object.keys(i.inputs).length === 0) { reasons.push('這個檔期還沒有填商業可行性的合作條款（收款方、費用負擔方、分潤等）'); return fail(); }
  if (inp.cashFlowMode == null) missing.push(INPUT_LABEL.cashFlowMode);
  for (const k of TERM_KEYS) {
    if (i.inputs[k] == null) continue;
    const kind = i.sources[k]?.kind;
    if (!kind || !CONFIRMED_SOURCE_KINDS.includes(kind)) unconfirmed.push(INPUT_LABEL[k] ?? k);
  }
  if (i.hostScopedWithOtherHosts && ((inp.fixedCost ?? 0) > 0 && inp.fixedCostBorneBy === 'COMPANY')) reasons.push('檔期有其他團主，固定費用無法分攤到單一團主');
  if (i.hostScopedWithOtherHosts && (inp.serviceFeeFixed ?? 0) > 0) reasons.push('檔期有其他團主，固定服務費無法分攤到單一團主');
  const calc = calcFeasibility(inp, { actual: i.actual, requireReturnCost: true });
  for (const m of calc.missing.companyContribution ?? []) if (!missing.includes(m)) missing.push(m);
  if (missing.length) reasons.push(`缺少：${missing.join('、')}（未知的成本不會被當成 0）`);
  if (unconfirmed.length) reasons.push(`這些條款的來源還不是合約或正式商務條件：${unconfirmed.join('、')}`);
  if (reasons.length || calc.companyContribution == null) { if (!reasons.length) reasons.push('公司貢獻利潤無法計算'); return fail(); }
  return { status: 'OK', total: calc.companyContribution, perOrder: Math.round(calc.companyContribution / i.validOrders), reasons: [], missing: [], unconfirmed: [], results: calc };
}
