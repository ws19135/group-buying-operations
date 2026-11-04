import { describe, expect, it } from 'vitest';
import { computeActualContribution, type ActualProfitInput } from '../../src/server/lib/actual-profit';
import { calcFeasibility } from '../../src/server/lib/feasibility-calc';
import { foldActualSales } from '../../src/server/lib/actual-sales';

// 代理人口徑範例（虛構）：公司服務費 10%（以有效淨銷售額計）、團主分潤 8% 由公司支付；運費與平台費由品牌負擔；退款退貨處理成本每筆 30 元由公司負擔
const TERMS = {
  cashFlowMode: 'BRAND_COLLECTS', commissionBasis: 'NSV', brandFeePct: 10, serviceFeeFixed: 0, hostCommissionPct: 8, hostPaidBy: 'COMPANY',
  shippingPerOrder: 40, shippingBorneBy: 'BRAND', platformFeePct: 2, platformFeeBorneBy: 'BRAND',
  otherVariablePerOrder: 0, otherCostBorneBy: 'COMPANY', fixedCost: 0, fixedCostBorneBy: 'COMPANY',
  returnCostPerRefundOrder: 30, returnCostBorneBy: 'COMPANY',
};
const confirmed = (keys: string[], kind = 'CONTRACT') => Object.fromEntries(keys.map((k) => [k, { kind }]));
const base = (over: Partial<ActualProfitInput> = {}): ActualProfitInput => ({
  inputs: TERMS, sources: confirmed(Object.keys(TERMS)), actual: { orders: 10, gmv: 10_000, refund: 1_000, refundedOrders: 2 },
  validOrders: 10, hostScopedWithOtherHosts: false, multiProduct: false, ...over,
});

describe('實際公司貢獻利潤（K-3）', () => {
  it('條款都來自合約：公司貢獻利潤＝公司收入 − 公司支付的團主分潤 − 公司負擔的成本；每單＝÷有效訂單', () => {
    const r = computeActualContribution(base());
    // 有效淨銷售額 9000；公司收入 900；團主分潤 720（公司付）；退款退貨處理 30×2=60（公司負擔）；運費與平台費由品牌負擔
    expect(r.status).toBe('OK');
    expect(r.total).toBe(900 - 720 - 60);
    expect(r.perOrder).toBe(12);
    expect(r.results?.companyRevenue).toBe(900);
    expect(r.results?.hostCommission).toBe(720);
  });

  it('負擔方不寫死：運費改由公司負擔，結果跟著變（可為負數）', () => {
    const r = computeActualContribution(base({ inputs: { ...TERMS, shippingBorneBy: 'COMPANY' } }));
    expect(r.total).toBe(120 - 400);
    expect(r.perOrder).toBe(-28);
  });

  it('團主分潤改由品牌支付：公司貢獻利潤不扣分潤', () => {
    const r = computeActualContribution(base({ inputs: { ...TERMS, hostPaidBy: 'BRAND' } }));
    expect(r.total).toBe(900 - 60);
  });

  it('分潤基礎改用 GMV：公司收入與團主分潤都以 GMV 計', () => {
    const r = computeActualContribution(base({ inputs: { ...TERMS, commissionBasis: 'GMV' } }));
    expect(r.results?.companyRevenue).toBe(1000);
    expect(r.results?.hostCommission).toBe(800);
    expect(r.total).toBe(1000 - 800 - 60);
  });

  it('只要有一項條款的來源不是合約／正式商務條件，就是資料不足（不顯示暫估）', () => {
    const r = computeActualContribution(base({ sources: { ...confirmed(Object.keys(TERMS)), hostCommissionPct: { kind: 'MANUAL_ESTIMATE' }, shippingPerOrder: { kind: 'VENDOR_QUOTE' } } }));
    expect(r.status).toBe('INSUFFICIENT');
    expect(r.total).toBeNull();
    expect(r.perOrder).toBeNull();
    expect(r.results).toBeNull();
    expect(r.unconfirmed).toEqual(['團主分潤比例', '運費／單']);
  });

  it('「正式商務條件（已確認）」與「合約」都算已確認', () => {
    const r = computeActualContribution(base({ sources: { ...confirmed(Object.keys(TERMS)), hostCommissionPct: { kind: 'FORMAL_TERMS' } } }));
    expect(r.status).toBe('OK');
  });

  it('沒有填的來源（沒有來源紀錄）也算未確認', () => {
    const { shippingPerOrder: _drop, ...rest } = confirmed(Object.keys(TERMS));
    const r = computeActualContribution(base({ sources: rest }));
    expect(r.status).toBe('INSUFFICIENT');
    expect(r.unconfirmed).toContain('運費／單');
  });

  it('任何成本未填（未知）都不當 0：資料不足並列出缺什麼', () => {
    const { otherVariablePerOrder: _o, ...noOther } = TERMS;
    const r = computeActualContribution(base({ inputs: noOther }));
    expect(r.status).toBe('INSUFFICIENT');
    expect(r.missing.join()).toContain('其他變動成本');
    expect(r.total).toBeNull();
  });

  it('退款／退貨處理成本與負擔方一定要填（實際值模式才要求；舊試算不受影響）', () => {
    const { returnCostPerRefundOrder: _a, returnCostBorneBy: _b, ...noReturn } = TERMS;
    const r = computeActualContribution(base({ inputs: noReturn }));
    expect(r.status).toBe('INSUFFICIENT');
    expect(r.missing.join()).toContain('退款／退貨處理成本');
    // 舊試算：沒填這兩項，公司貢獻利潤照舊算得出來
    const forecast = calcFeasibility({ ...noReturn, expectedOrders: 10, unitPrice: 1000, refundRatePct: 10 } as never);
    expect(forecast.companyContribution).not.toBeNull();
    expect(forecast.returnCostTotal).toBeNull();
  });

  it('收款方（收款模式）沒設定：資料不足', () => {
    const { cashFlowMode: _c, ...noMode } = TERMS;
    const r = computeActualContribution(base({ inputs: noMode }));
    expect(r.status).toBe('INSUFFICIENT');
    expect(r.missing).toContain('收款模式');
  });

  it('沒有任何條款、沒有有效訂單、多商品檔期：資料不足並說明原因', () => {
    expect(computeActualContribution(base({ inputs: {}, sources: {} })).reasons.join()).toContain('還沒有填商業可行性的合作條款');
    expect(computeActualContribution(base({ validOrders: 0 })).reasons).toContain('沒有有效訂單');
    expect(computeActualContribution(base({ multiProduct: true })).reasons.join()).toContain('多個商品');
  });

  it('只算某位團主、檔期還有其他團主：固定費用或固定服務費無法分攤，資料不足', () => {
    const fixed = computeActualContribution(base({ inputs: { ...TERMS, fixedCost: 500 }, hostScopedWithOtherHosts: true }));
    expect(fixed.status).toBe('INSUFFICIENT');
    expect(fixed.reasons.join()).toContain('固定費用無法分攤');
    const svc = computeActualContribution(base({ inputs: { ...TERMS, serviceFeeFixed: 300 }, hostScopedWithOtherHosts: true }));
    expect(svc.reasons.join()).toContain('固定服務費無法分攤');
    // 固定費用由品牌負擔不影響公司，可以算
    expect(computeActualContribution(base({ inputs: { ...TERMS, fixedCost: 500, fixedCostBorneBy: 'BRAND' }, hostScopedWithOtherHosts: true })).status).toBe('OK');
  });

  it('實際值模式與試算共用同一組公式：用相同的訂單、GMV、退款餵給試算，結果一致', () => {
    const forecast = calcFeasibility({ ...TERMS, expectedOrders: 10, unitPrice: 1000, refundRatePct: 10 } as never);
    const actual = calcFeasibility({ ...TERMS } as never, { actual: { orders: 10, gmv: 10_000, refund: 1_000, refundedOrders: 1 }, requireReturnCost: true });
    expect(actual.gmv).toBe(forecast.gmv);
    expect(actual.nsv).toBe(forecast.nsv);
    expect(actual.companyRevenue).toBe(forecast.companyRevenue);
    expect(actual.hostCommission).toBe(forecast.hostCommission);
    expect(actual.companyContribution).toBe(forecast.companyContribution);
  });
});

describe('實際銷售單一定義（KPI 與實際值回寫共用）', () => {
  it('計入銷售的金額、有效淨銷售額、有效客單價', () => {
    const s = foldActualSales({ total: 10, established: 9, valid: 7, refunded: 3, cancelled: 1, gmv: 9000.4, refund: 1200.2 });
    expect(s.gmv).toBe(9000);
    expect(s.refund).toBe(1200);
    expect(s.nsv).toBe(7800);
    expect(s.aov).toBe(Math.round(7800 / 7));
    expect(s.refundRateByAmountPct).toBe(13.33);
  });
  it('沒有有效訂單時客單價為 null，GMV 為 0 時金額退款率為 null', () => {
    const s = foldActualSales({ total: 1, established: 0, valid: 0, refunded: 0, cancelled: 1, gmv: 0, refund: 0 });
    expect(s.aov).toBeNull();
    expect(s.refundRateByAmountPct).toBeNull();
  });
});
