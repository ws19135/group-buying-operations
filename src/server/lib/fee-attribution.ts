import type { FeasibilityInputs, FeasibilityResults } from './feasibility-calc';

/**
 * 費用歸屬對照報告（Owner 決策 K-8；純函式，唯讀）。
 * 本階段 KPI 試算與正式結算維持分離：KPI／商業可行性依各檔期的合作條款計算費用負擔方；正式結算（settlements）目前只處理「團主佣金」，
 * 不處理運費、平台費、退款退貨處理費、固定費用與公司服務費。這份報告把兩邊逐項對照，列出：
 *   ① 試算採用的負擔方與條款來源版本；② 財務已記錄的支出（expenses 只有類別與金額，沒有「誰負擔」「誰實際付款」）；③ 正式結算是否處理；
 *   ④ KPI 與正式結算尚未一致的項目與原因；⑤ 可能產生公司應收或應付的情形（只說「可能」與需要確認什麼，不入帳）。
 * 不修改任何資料、不更動結算演算法；實際付款、發票、已確認結算更正、歷史回填都需另案核准。
 */
export type FeeItemKey = 'hostCommission' | 'companyServiceFee' | 'shipping' | 'platformFee' | 'returnCost' | 'otherVariable' | 'fixed';
export const FEE_ITEM_LABEL: Record<FeeItemKey, string> = {
  hostCommission: '團主佣金', companyServiceFee: '公司服務費／經紀費（品牌端）', shipping: '運費', platformFee: '平台及金流費', returnCost: '退款／退貨處理成本', otherVariable: '其他變動成本', fixed: '固定費用',
};
export type Party = 'BRAND' | 'COMPANY' | 'HOST';
const PARTY_LABEL: Record<string, string> = { BRAND: '品牌', COMPANY: '公司', HOST: '團主' };
export type Alignment = 'ALIGNED' | 'NOT_ALIGNED' | 'INSUFFICIENT';
export const ALIGNMENT_LABEL: Record<Alignment, string> = { ALIGNED: '一致', NOT_ALIGNED: 'KPI 與正式結算尚未一致', INSUFFICIENT: '資料不足' };
export type Obligation = 'RECEIVABLE' | 'PAYABLE' | 'NONE' | 'UNKNOWN';
export const OBLIGATION_LABEL: Record<Obligation, string> = { RECEIVABLE: '公司可能有應收', PAYABLE: '公司可能有應付', NONE: '不產生往來款', UNKNOWN: '無法判斷（缺資料）' };

/** 財務已記錄的支出類別（expenses.category）與各項費用的對應；沒有對應類別的項目（退款處理、固定費用…）只能放在「其他」，無法逐項核對 */
export const EXPENSE_CATEGORY_FOR: Partial<Record<FeeItemKey, string[]>> = { shipping: ['SHIPPING'], platformFee: ['PLATFORM_FEE'], otherVariable: ['OTHER', 'SAMPLE', 'MARKETING'], fixed: ['OTHER', 'MARKETING'] };

export interface FeeInput {
  campaignId: string; campaignTitle: string; productId: string; productName: string;
  scenario: { id: string; versionNo: number; inputs: Partial<FeasibilityInputs>; sources: Record<string, { kind?: string } | undefined> } | null;
  /** 以實際訂單算出的各項費用合計（lib/feasibility-calc 實際值模式，未強制退款退貨成本）；null＝資料不足或多商品檔期無法歸屬 */
  calc: FeasibilityResults | null;
  /** 檔期有多個商品：訂單無法歸屬到單一商品，費用金額不估算（K-7） */
  multiProduct: boolean;
  expenses: Record<string, { total: number; count: number }>;
  settlement: { exists: boolean; status: string | null; adjustmentCount: number; hasHostCommissionItems: boolean };
  /** 退款申請（客服案件的退款）：只是退給買家的款項，不是「退款處理成本」 */
  refunds: { total: number; count: number };
}

export interface FeeRow {
  item: FeeItemKey; label: string;
  /** 試算（KPI）採用的負擔方與條款來源 */
  kpi: { bearer: Party | null; bearerLabel: string; amount: number | null; sourceKind: string | null; confirmed: boolean; termsVersion: string | null; note: string };
  formal: { recordedExpense: number | null; expenseCount: number; handledBySettlement: boolean; note: string };
  alignment: Alignment;
  /** 差異原因（KPI 與正式結算為什麼不一致） */
  reasons: string[];
  obligation: { kind: Obligation; explanation: string; toConfirm: string[] };
}
export interface FeeReport { campaignId: string; campaignTitle: string; productId: string; productName: string; termsVersion: string | null; cashFlowMode: string | null; rows: FeeRow[]; notAlignedItems: string[]; cashFlowNote: string; }

const CONFIRMED = ['CONTRACT', 'FORMAL_TERMS'];
const KEYS: Record<FeeItemKey, { bearer?: keyof FeasibilityInputs; amount?: keyof FeasibilityResults; src: keyof FeasibilityInputs }> = {
  hostCommission: { bearer: 'hostPaidBy', amount: 'hostCommission', src: 'hostCommissionPct' },
  companyServiceFee: { amount: 'companyRevenue', src: 'brandFeePct' },
  shipping: { bearer: 'shippingBorneBy', amount: 'shippingTotal', src: 'shippingPerOrder' },
  platformFee: { bearer: 'platformFeeBorneBy', amount: 'platformFeeTotal', src: 'platformFeePct' },
  returnCost: { bearer: 'returnCostBorneBy', amount: 'returnCostTotal', src: 'returnCostPerRefundOrder' },
  otherVariable: { bearer: 'otherCostBorneBy', amount: 'otherVariableTotal', src: 'otherVariablePerOrder' },
  fixed: { bearer: 'fixedCostBorneBy', amount: 'fixedCost', src: 'fixedCost' },
};

function obligationFor(item: FeeItemKey, bearer: Party | null, mode: string | null, recorded: number | null): FeeRow['obligation'] {
  if (item === 'companyServiceFee') {
    if (!mode) return { kind: 'UNKNOWN', explanation: '沒有設定收款方，無法判斷服務費由誰收、誰付', toConfirm: ['收款方（收款模式）', '服務費的收款與開票安排'] };
    if (mode === 'BRAND_COLLECTS') return { kind: 'RECEIVABLE', explanation: '品牌自收：公司的服務費（營業收入）要向品牌收取，可能形成公司應收', toConfirm: ['服務費結算與開票時點', '品牌端付款條件'] };
    if (mode === 'HOST_COLLECTS') return { kind: 'RECEIVABLE', explanation: '團主代收：款項先在團主端，公司服務費需由代收款項中取得，可能形成公司應收', toConfirm: ['團主回款時點與對帳方式'] };
    return { kind: 'NONE', explanation: '公司代收：公司先收到貨款，服務費可由代收款項中直接扣留；代收款是負債（應付品牌貨款），不是公司收入', toConfirm: ['應付品牌貨款的撥付時點'] };
  }
  if (item === 'hostCommission') {
    if (bearer === 'COMPANY') return { kind: 'PAYABLE', explanation: '分潤由公司支付：公司對團主有應付佣金（正式結算已處理佣金金額）', toConfirm: ['付款時點與方式（本系統只記錄入帳，不執行付款）'] };
    if (bearer === 'BRAND') return { kind: 'RECEIVABLE', explanation: '分潤由品牌負擔：若公司先行支付團主，公司可能對品牌有應收', toConfirm: ['實際由誰付款給團主', '品牌是否已同意償還'] };
    return { kind: 'UNKNOWN', explanation: '沒有設定團主分潤付款方', toConfirm: ['團主分潤付款方'] };
  }
  if (!bearer) return { kind: 'UNKNOWN', explanation: '沒有設定負擔方（或此項費用未填）', toConfirm: ['負擔方', '實際付款方'] };
  if (bearer === 'COMPANY') return { kind: 'NONE', explanation: '由公司負擔：是公司成本；若實際由品牌或團主先付，公司可能有應付', toConfirm: ['實際付款方是否就是公司'] };
  const who = PARTY_LABEL[bearer];
  return recorded != null && recorded > 0
    ? { kind: 'RECEIVABLE', explanation: `負擔方是${who}，但財務已記錄這類支出（${recorded} 元）：若是公司先墊付，公司可能對${who}有應收`, toConfirm: ['支出是否由公司墊付', `${who}是否同意償還`, '支出紀錄需標明所屬檔期與商品'] }
    : { kind: 'UNKNOWN', explanation: `負擔方是${who}；財務沒有對應的支出紀錄，無法判斷是否由公司墊付`, toConfirm: ['實際付款方', '是否有公司墊付'] };
}

export function buildFeeReport(i: FeeInput): FeeReport {
  const inputs = (i.scenario?.inputs ?? {}) as Partial<FeasibilityInputs>;
  const ver = i.scenario ? `可行性 v${i.scenario.versionNo}（${i.scenario.id}）` : null;
  const rows: FeeRow[] = (Object.keys(KEYS) as FeeItemKey[]).map((item) => {
    const k = KEYS[item];
    const bearerRaw = k.bearer ? ((inputs[k.bearer] as Party | null | undefined) ?? null) : null;
    // 公司服務費由公司收取（負擔方不適用）；團主佣金的「付款方」是 COMPANY／BRAND
    const bearer: Party | null = item === 'companyServiceFee' ? 'COMPANY' : bearerRaw;
    const srcKind = i.scenario?.sources[k.src as string]?.kind ?? null;
    const confirmed = !!srcKind && CONFIRMED.includes(srcKind);
    const amount = i.calc && !i.multiProduct ? ((i.calc[k.amount as keyof FeasibilityResults] as number | null | undefined) ?? null) : null;
    const cats = EXPENSE_CATEGORY_FOR[item];
    const rec = cats ? cats.reduce((a, c) => ({ total: a.total + (i.expenses[c]?.total ?? 0), count: a.count + (i.expenses[c]?.count ?? 0) }), { total: 0, count: 0 }) : null;
    const handled = item === 'hostCommission' && i.settlement.hasHostCommissionItems;
    const reasons: string[] = [];
    let alignment: Alignment;
    if (!i.scenario) { alignment = 'INSUFFICIENT'; reasons.push('這個商品在此檔期沒有商業可行性條款，無法對照'); }
    else if (item === 'hostCommission') {
      alignment = handled ? 'ALIGNED' : 'INSUFFICIENT';
      if (handled) reasons.push('正式結算處理團主佣金（金額、費率、規則版本）；比例與付款方是否與合約一致，請看「分潤口徑差異核對」');
      else reasons.push('此檔期尚無結算明細，無法對照');
      if (bearer === 'BRAND') reasons.push('試算設定分潤由品牌負擔，但正式結算沒有記錄「付款方」，無法確認一致');
    } else {
      alignment = 'NOT_ALIGNED';
      reasons.push(item === 'companyServiceFee' ? '正式結算沒有計算公司服務費；KPI 以試算條款的比例與基礎計算' : '正式結算沒有處理這項費用；KPI 依試算條款的負擔方計算');
      if (cats) reasons.push(rec && rec.count > 0 ? `財務有 ${rec.count} 筆相關支出（共 ${rec.total} 元），但支出紀錄沒有「負擔方」與「實際付款方」，無法與試算逐項核對` : '財務沒有對應類別的支出紀錄');
      else reasons.push('財務支出類別沒有對應這項費用，無法逐項核對');
      if (item === 'returnCost') reasons.push(`財務有退款申請 ${i.refunds.count} 筆（共 ${i.refunds.total} 元）：那是退給買家的款項，不是「退款／退貨處理成本」`);
    }
    if (!confirmed && i.scenario && inputs[k.src] != null) reasons.push(`條款來源為「${srcKind ?? '未註明'}」，不是合約或正式商務條件（暫估）`);
    if (i.multiProduct && item !== 'hostCommission') reasons.push('檔期有多個商品：費用金額無法歸屬到單一商品（K-7，維持資料不足）');
    const bearerLabel = item === 'hostCommission' ? (bearer ? `${PARTY_LABEL[bearer]}（付款方）` : '未設定') : item === 'companyServiceFee' ? '公司收取（來源：品牌端服務費）' : bearer ? PARTY_LABEL[bearer] : '未設定';
    return {
      item, label: FEE_ITEM_LABEL[item],
      kpi: { bearer, bearerLabel, amount, sourceKind: srcKind, confirmed, termsVersion: ver, note: amount == null ? (i.multiProduct ? '多商品檔期，不估算' : '資料不足或尚未算出') : '依實際訂單與試算條款計算（KPI／實際值回寫同一定義）' },
      formal: { recordedExpense: rec ? rec.total : null, expenseCount: rec?.count ?? 0, handledBySettlement: handled, note: handled ? '正式結算已處理' : '正式結算未處理這項費用' },
      alignment, reasons,
      obligation: obligationFor(item, bearer, inputs.cashFlowMode ?? null, rec ? rec.total : null),
    };
  });
  const mode = inputs.cashFlowMode ?? null;
  return {
    campaignId: i.campaignId, campaignTitle: i.campaignTitle, productId: i.productId, productName: i.productName, termsVersion: ver, cashFlowMode: mode, rows,
    notAlignedItems: rows.filter((r) => r.alignment === 'NOT_ALIGNED').map((r) => r.label),
    cashFlowNote: mode === 'COMPANY_ESCROW' ? '收款方：公司代收居中。代收款是負債（應付品牌貨款），不是公司收入；本系統不執行任何付款。' : mode === 'HOST_COLLECTS' ? '收款方：團主代收。款項先在團主端，回款與對帳需另行確認；本系統不執行任何付款。' : mode === 'BRAND_COLLECTS' ? '收款方：品牌自收。公司的服務費要向品牌收取；本系統不執行任何收款。' : '尚未設定收款方（收款模式），無法判斷往來款方向。',
  };
}
