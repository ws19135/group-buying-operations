import { describe, expect, it } from 'vitest';
import { calcFeasibility, feasibilityInputSchema, maskInputs, maskResults, touchesSensitiveInputs, type FeasibilityInputs } from '@/server/lib/feasibility-calc';

// 手算基準：100 單 × 1,000 = GMV 100,000；退款 10% = 10,000；NSV 90,000；
// 商品成本 500×100 = 50,000；運費 60×100 = 6,000（品牌）；平台費 3% × GMV = 3,000（品牌）；固定費 2,000（公司）；
// 品牌端服務費 10% × NSV = 9,000（＝公司營業收入）；團主分潤 5% × NSV = 4,500，由公司支付。
const full = (over: Partial<FeasibilityInputs> = {}): FeasibilityInputs => ({
  expectedOrders: 100, unitPrice: 1000, refundRatePct: 10, unitCost: 500, shippingPerOrder: 60, platformFeePct: 3, platformFeePerOrder: null, otherVariablePerOrder: 0, fixedCost: 2000,
  brandFeePct: 10, serviceFeeFixed: 0, hostCommissionPct: 5, commissionBasis: 'NSV', hostPaidBy: 'COMPANY', cashFlowMode: 'BRAND_COLLECTS',
  shippingBorneBy: 'BRAND', platformFeeBorneBy: 'BRAND', otherCostBorneBy: 'COMPANY', fixedCostBorneBy: 'COMPANY', ...over,
});

describe('SOP03 可行性試算：口徑與手算對照', () => {
  it('GMV、退款、有效淨銷售額、商品成本', () => {
    const r = calcFeasibility(full());
    expect(r).toMatchObject({ gmv: 100000, refund: 10000, nsv: 90000, productCost: 50000, shippingTotal: 6000, platformFeeTotal: 3000, otherVariableTotal: 0, fixedCost: 2000 });
  });
  it('公司營業收入只是服務費，不是 GMV 也不是代收款', () => {
    const r = calcFeasibility(full());
    expect(r.companyRevenue).toBe(9000);
    expect(r.companyRevenue).not.toBe(r.gmv);
    expect(r.companyRevenue).not.toBe(r.nsv);
    expect(r.takeRatePct).toBe(10);
  });
  it('品牌利潤、公司貢獻利潤、團主收入（付款方＝公司）', () => {
    const r = calcFeasibility(full());
    expect(r.hostCommission).toBe(4500);
    expect(r.companyContribution).toBe(9000 - 4500 - 2000);            // 2,500
    expect(r.brandProfit).toBe(90000 - 50000 - 9000 - 6000 - 3000);    // 22,000
    expect(r.hostIncome).toBe(4500);
    expect(r.brandMarginPct).toBe(24.44);
  });
  it('團主分潤改由品牌支付：公司不再扣分潤、品牌多扣', () => {
    const r = calcFeasibility(full({ hostPaidBy: 'BRAND' }));
    expect(r.companyContribution).toBe(9000 - 2000);
    expect(r.brandProfit).toBe(22000 - 4500);
  });
  it('成本負擔方改變，利潤跟著移動（運費改公司負擔）', () => {
    const r = calcFeasibility(full({ shippingBorneBy: 'COMPANY' }));
    expect(r.brandProfit).toBe(22000 + 6000);
    expect(r.companyContribution).toBe(2500 - 6000);
  });
  it('分潤基礎 GMV 與 NSV 不同結果（GMV 基礎的分潤較高）', () => {
    const nsv = calcFeasibility(full({ commissionBasis: 'NSV' })).hostCommission;
    const gmv = calcFeasibility(full({ commissionBasis: 'GMV' })).hostCommission;
    expect([nsv, gmv]).toEqual([4500, 5000]);
  });
  it('固定費可加在服務費上；平台費可用每單金額', () => {
    expect(calcFeasibility(full({ serviceFeeFixed: 1000 })).companyRevenue).toBe(10000);
    expect(calcFeasibility(full({ platformFeePct: null, platformFeePerOrder: 20 })).platformFeeTotal).toBe(2000);
    expect(calcFeasibility(full({ platformFeePct: 3, platformFeePerOrder: 20 })).platformFeeTotal).toBe(5000);
  });
  it('代營運居中：代收款是負債（應付品牌貨款）＝ NSV − 公司營業收入，不計入公司收入', () => {
    const r = calcFeasibility(full({ cashFlowMode: 'COMPANY_ESCROW' }));
    expect(r.escrowRemitToBrand).toBe(90000 - 9000);
    expect(r.companyRevenue).toBe(9000);
    expect(r.notes.join()).toContain('負債');
    expect(calcFeasibility(full({ cashFlowMode: 'BRAND_COLLECTS' })).escrowRemitToBrand).toBeNull();
  });
  it('金額四捨五入到整數元（half-up），費率以千分位運算不受浮點影響', () => {
    const r = calcFeasibility(full({ expectedOrders: 3, unitPrice: 333, refundRatePct: 0, brandFeePct: 0.5, serviceFeeFixed: 0, platformFeePct: 0 }));
    expect(r.gmv).toBe(999);
    expect(r.companyRevenue).toBe(5);   // 999 × 0.5% = 4.995 → 5
  });
});

describe('SOP03 可行性試算：缺資料不捏造', () => {
  it('沒填退款率：淨銷售額、品牌利潤未知（null），不是當成 0；並說明缺什麼', () => {
    const r = calcFeasibility(full({ refundRatePct: null }));
    expect(r.gmv).toBe(100000);
    expect(r.refund).toBeNull();
    expect(r.nsv).toBeNull();
    expect(r.brandProfit).toBeNull();
    expect(r.missing.refund).toContain('退款率');
    expect(r.missing.brandProfit).toContain('有效淨銷售額');
  });
  it('沒填服務費比例：公司營業收入未知，公司貢獻利潤也未知（不假設 0%）', () => {
    const r = calcFeasibility(full({ brandFeePct: null }));
    expect(r.companyRevenue).toBeNull();
    expect(r.companyContribution).toBeNull();
    expect(r.missing.companyRevenue).toContain('品牌端服務費比例');
  });
  it('明確填 0 與「沒填」不同：服務費 0% 算得出 0', () => {
    const r = calcFeasibility(full({ brandFeePct: 0, serviceFeeFixed: 0 }));
    expect(r.companyRevenue).toBe(0);
  });
  it('有金額的成本沒指定負擔方 → 利潤未知（不替使用者決定誰扛）', () => {
    const r = calcFeasibility(full({ shippingBorneBy: null }));
    expect(r.brandProfit).toBeNull();
    expect(r.companyContribution).toBeNull();
    expect(r.missing.brandProfit).toContain('運費負擔方');
  });
  it('金額為 0 的成本不需要負擔方', () => {
    expect(calcFeasibility(full({ otherVariablePerOrder: 0, otherCostBorneBy: null })).brandProfit).toBe(22000);
  });
  it('沒填分潤付款方 → 公司貢獻與品牌利潤未知', () => {
    const r = calcFeasibility(full({ hostPaidBy: null }));
    expect(r.companyContribution).toBeNull();
    expect(r.brandProfit).toBeNull();
    expect(r.missing.companyContribution).toContain('團主分潤付款方');
  });
  it('什麼都沒填 → 所有結果都是 null，且逐項列出缺漏', () => {
    const r = calcFeasibility({});
    for (const k of ['gmv', 'nsv', 'productCost', 'companyRevenue', 'hostCommission', 'companyContribution', 'brandProfit', 'hostIncome'] as const) expect(r[k]).toBeNull();
    expect(Object.keys(r.missing).length).toBeGreaterThan(5);
  });
  it('輸入檢查：嚴格欄位、比例 0–100、金額非負整數', () => {
    expect(() => feasibilityInputSchema.parse({ surprise: 1 })).toThrow();
    expect(() => feasibilityInputSchema.parse({ refundRatePct: 101 })).toThrow();
    expect(() => feasibilityInputSchema.parse({ unitCost: -1 })).toThrow();
    expect(() => feasibilityInputSchema.parse({ unitCost: 1.5 })).toThrow();
    expect(() => feasibilityInputSchema.parse({ commissionBasis: 'OTHER' })).toThrow();
  });
});

describe('SOP03 可行性：敏感欄位遮罩', () => {
  const inputs = full() as Record<string, unknown>;
  const results = calcFeasibility(full()) as unknown as Record<string, unknown>;
  it('沒有成本檢視權限：成本、費用、分潤與付款安排為 null，非敏感輸入保留', () => {
    const m = maskInputs(inputs, false);
    for (const k of ['unitCost', 'shippingPerOrder', 'platformFeePct', 'fixedCost', 'brandFeePct', 'hostCommissionPct', 'hostPaidBy', 'shippingBorneBy']) expect(m[k]).toBeNull();
    expect(m).toMatchObject({ expectedOrders: 100, unitPrice: 1000, refundRatePct: 10, cashFlowMode: 'BRAND_COLLECTS' });
  });
  it('沒有成本檢視權限：收入、分潤、利潤、成本為 null；GMV／退款／淨銷售額保留；缺漏與備註不外洩', () => {
    const m = maskResults(results, false);
    for (const k of ['productCost', 'companyRevenue', 'hostCommission', 'companyContribution', 'brandProfit', 'hostIncome', 'takeRatePct', 'escrowRemitToBrand']) expect(m[k]).toBeNull();
    expect(m).toMatchObject({ gmv: 100000, refund: 10000, nsv: 90000, restricted: true, missing: {}, notes: [] });
  });
  it('有權限則原樣', () => {
    expect(maskInputs(inputs, true)).toBe(inputs);
    expect(maskResults(results, true)).toBe(results);
  });
  it('touchesSensitiveInputs：只要碰到敏感欄位（非 null）就是 true', () => {
    expect(touchesSensitiveInputs({ expectedOrders: 5, unitPrice: 100 })).toBe(false);
    expect(touchesSensitiveInputs({ unitCost: 5 })).toBe(true);
    expect(touchesSensitiveInputs({ hostPaidBy: 'BRAND' })).toBe(true);
  });
});
