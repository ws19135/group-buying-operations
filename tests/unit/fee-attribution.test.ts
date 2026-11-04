import { describe, expect, it } from 'vitest';
import { buildFeeReport, type FeeInput } from '@/server/lib/fee-attribution';
import { calcFeasibility, type FeasibilityInputs } from '@/server/lib/feasibility-calc';

const TERMS = {
  cashFlowMode: 'BRAND_COLLECTS', commissionBasis: 'NSV', brandFeePct: 10, serviceFeeFixed: 0, hostCommissionPct: 8, hostPaidBy: 'COMPANY',
  shippingPerOrder: 60, shippingBorneBy: 'BRAND', platformFeePct: 3, platformFeeBorneBy: 'BRAND', otherVariablePerOrder: 0, otherCostBorneBy: 'COMPANY',
  fixedCost: 500, fixedCostBorneBy: 'COMPANY', returnCostPerRefundOrder: 20, returnCostBorneBy: 'COMPANY',
} as unknown as FeasibilityInputs;
const sources = (kind: string) => Object.fromEntries(Object.keys(TERMS).map((k) => [k, { kind }]));
const calc = calcFeasibility(TERMS, { actual: { orders: 10, gmv: 10_000, refund: 1_000, refundedOrders: 2 } });
const input = (o: Partial<FeeInput> = {}): FeeInput => ({
  campaignId: 'CMP-1', campaignTitle: '[DEMO] 檔期', productId: 'PRD-1', productName: '[DEMO] 商品',
  scenario: { id: 'FSB-1', versionNo: 3, inputs: TERMS, sources: sources('CONTRACT') }, calc, multiProduct: false,
  expenses: { SHIPPING: { total: 700, count: 2 } }, settlement: { exists: true, status: 'DRAFT', adjustmentCount: 0, hasHostCommissionItems: true }, refunds: { total: 1_000, count: 2 }, ...o,
});
const row = (r: ReturnType<typeof buildFeeReport>, k: string) => r.rows.find((x) => x.item === k)!;

describe('K-8 費用歸屬對照報告（唯讀；KPI 試算與正式結算分離）', () => {
  it('每項費用列出：試算負擔方與條款版本、財務已記錄支出、正式結算是否處理、是否一致與原因', () => {
    const r = buildFeeReport(input());
    expect(r.rows.map((x) => x.item)).toEqual(['hostCommission', 'companyServiceFee', 'shipping', 'platformFee', 'returnCost', 'otherVariable', 'fixed']);
    const ship = row(r, 'shipping');
    expect(ship.kpi).toMatchObject({ bearer: 'BRAND', bearerLabel: '品牌', amount: 600, confirmed: true, termsVersion: '可行性 v3（FSB-1）' });
    expect(ship.formal).toMatchObject({ recordedExpense: 700, expenseCount: 2, handledBySettlement: false });
    expect(ship.alignment).toBe('NOT_ALIGNED');
    expect(ship.reasons.join()).toContain('正式結算沒有處理這項費用');
    expect(ship.reasons.join()).toContain('沒有記錄「承擔方」或「實際付款方」');
  });

  it('團主佣金：正式結算有處理（金額、費率、規則版本）；付款方設定為品牌時提示結算沒有記錄付款方', () => {
    expect(row(buildFeeReport(input()), 'hostCommission').alignment).toBe('ALIGNED');
    const r = buildFeeReport(input({ scenario: { id: 'FSB-1', versionNo: 3, inputs: { ...TERMS, hostPaidBy: 'BRAND' }, sources: sources('CONTRACT') } }));
    expect(row(r, 'hostCommission').reasons.join()).toContain('沒有記錄「付款方」');
    expect(buildFeeReport(input({ settlement: { exists: false, status: null, adjustmentCount: 0, hasHostCommissionItems: false } })).rows[0].alignment).toBe('INSUFFICIENT');
  });

  it('尚未一致的項目一律列出（運費、平台費、退款處理、其他、固定費用、公司服務費）', () => {
    const r = buildFeeReport(input());
    expect(r.notAlignedItems).toEqual(['公司服務費／經紀費（品牌端）', '運費', '平台及金流費', '退款／退貨處理成本', '其他變動成本', '固定費用']);
  });

  it('退款申請是退給買家的款項，不是「退款／退貨處理成本」：兩者分開並明講', () => {
    const rc = row(buildFeeReport(input()), 'returnCost');
    expect(rc.reasons.join()).toContain('退給買家的款項，不是「退款／退貨處理成本」');
    expect(rc.formal.recordedExpense).toBeNull();     // 財務支出類別沒有對應「退款處理」
  });

  it('可能的應收／應付：負擔方是品牌、但財務已記錄這類支出 → 公司可能對品牌有應收；沒有記錄就無法判斷；公司負擔＝公司成本', () => {
    const r = buildFeeReport(input());
    expect(row(r, 'shipping').obligation.kind).toBe('RECEIVABLE');
    expect(row(r, 'shipping').obligation.toConfirm.join()).toContain('墊付');
    expect(row(r, 'platformFee').obligation.kind).toBe('UNKNOWN');          // 品牌負擔，但財務沒有平台費支出紀錄
    expect(row(r, 'fixed').obligation.kind).toBe('NONE');                    // 公司負擔
    expect(row(r, 'hostCommission').obligation.kind).toBe('PAYABLE');       // 公司付團主
  });

  it('收款模式決定服務費往來：品牌自收／團主代收＝公司可能有應收；公司代收＝代收款是負債、不是收入；沒設定＝無法判斷', () => {
    const mk = (mode: string | null) => buildFeeReport(input({ scenario: { id: 'FSB-1', versionNo: 1, inputs: { ...TERMS, cashFlowMode: mode as never }, sources: sources('CONTRACT') } }));
    expect(row(mk('BRAND_COLLECTS'), 'companyServiceFee').obligation.kind).toBe('RECEIVABLE');
    expect(row(mk('HOST_COLLECTS'), 'companyServiceFee').obligation.kind).toBe('RECEIVABLE');
    expect(row(mk('COMPANY_ESCROW'), 'companyServiceFee').obligation.kind).toBe('NONE');
    expect(mk('COMPANY_ESCROW').cashFlowNote).toContain('負債');
    expect(row(mk(null), 'companyServiceFee').obligation.kind).toBe('UNKNOWN');
    expect(mk(null).cashFlowNote).toContain('尚未設定收款方');
  });

  it('條款來源不是合約／正式商務條件：標示暫估；沒有可行性條款：資料不足', () => {
    const r = buildFeeReport(input({ scenario: { id: 'FSB-1', versionNo: 3, inputs: TERMS, sources: sources('MANUAL_ESTIMATE') } }));
    expect(row(r, 'shipping').kpi.confirmed).toBe(false);
    expect(row(r, 'shipping').reasons.join()).toContain('不是合約或正式商務條件（暫估）');
    const none = buildFeeReport(input({ scenario: null, calc: null }));
    expect(none.rows.every((x) => x.alignment === 'INSUFFICIENT')).toBe(true);
    expect(none.rows[0].reasons.join()).toContain('沒有商業可行性條款');
  });

  it('多商品檔期：費用金額不估算（K-7），並說明', () => {
    const r = buildFeeReport(input({ multiProduct: true, calc: null }));
    expect(row(r, 'shipping').kpi.amount).toBeNull();
    expect(row(r, 'shipping').reasons.join()).toContain('多個商品');
  });
});

describe('K-8a 費用紀錄有承擔方與實際付款方之後的對照', () => {
  const rec = (o: Partial<import('@/server/lib/fee-attribution').ExpenseLite> = {}) => ({ id: 'EXP-1', category: 'SHIPPING', amount: 700, bearerParty: 'BRAND', payerParty: 'COMPANY', claimDirection: 'UNDETERMINED', claimParty: null, claimStatus: 'UNCONFIRMED', paymentStatus: 'PAID', productId: null, hostId: null, ...o });
  it('承擔方（品牌）≠ 實際付款方（公司）：可能對品牌有應收；紀錄完整時可逐筆核對；未確認的應收應付明講不是付款指示', () => {
    const r = buildFeeReport(input({ expenseRecords: [rec()] }));
    const ship = row(r, 'shipping');
    expect(ship.formal.records).toMatchObject({ total: 1, withBearerAndPayer: 1, payerDiffersFromBearer: 1, possibleReceivable: 1, possiblePayable: 0, claimsUnconfirmed: 0 });
    expect(ship.reasons.join()).toContain('皆已記錄承擔方與實際付款方');
    expect(ship.reasons.join()).toContain('可能形成應收或應付');
    expect(ship.reasons.join()).toContain('不是付款指示');
    expect(ship.obligation.kind).toBe('RECEIVABLE');
    expect(ship.obligation.explanation).toContain('尚未確認');
  });
  it('承擔方（公司）≠ 實際付款方（團主）：可能對團主有應付；方向混雜時無法判斷；承擔方與試算條款不同時列出', () => {
    const pay = buildFeeReport(input({ expenseRecords: [rec({ bearerParty: 'COMPANY', payerParty: 'HOST' })], scenario: { id: 'FSB-1', versionNo: 3, inputs: { ...TERMS, shippingBorneBy: 'COMPANY' }, sources: sources('CONTRACT') } }));
    expect(row(pay, 'shipping').obligation.kind).toBe('PAYABLE');
    const mixed = buildFeeReport(input({ expenseRecords: [rec(), rec({ id: 'EXP-2', bearerParty: 'COMPANY', payerParty: 'BRAND' })] }));
    expect(row(mixed, 'shipping').obligation.kind).toBe('UNKNOWN');
    const diff = buildFeeReport(input({ expenseRecords: [rec({ bearerParty: 'COMPANY', payerParty: 'COMPANY' })] }));   // 條款說品牌負擔，紀錄說公司承擔
    expect(row(diff, 'shipping').reasons.join()).toContain('承擔方與試算條款的負擔方不同');
  });
  it('只計入對應類別、且沒有指定其他商品的支出；缺承擔方或付款方的紀錄不會被當成「沒有往來款」', () => {
    const r = buildFeeReport(input({ expenseRecords: [rec({ category: 'PLATFORM_FEE' }), rec({ id: 'EXP-3', productId: 'PRD-OTHER' }), rec({ id: 'EXP-4', payerParty: null })] }));
    const ship = row(r, 'shipping');
    expect(ship.formal.records).toMatchObject({ total: 1, withBearerAndPayer: 0, payerDiffersFromBearer: 0 });
    expect(ship.reasons.join()).toContain('沒有記錄「承擔方」或「實際付款方」');
    expect(ship.obligation.kind).not.toBe('NONE');
  });
});

