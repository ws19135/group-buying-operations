import { describe, expect, it } from 'vitest';
import { computeTrialKpis, maskTrialKpis, type TrialKpiInput } from '@/server/lib/trial-kpi';

const base = (): TrialKpiInput => ({
  period: { from: '2026-11-01', to: '2026-11-10' }, dataAsOf: '2026-11-10 09:00',
  orders: { total: 12, established: 10, valid: 8, refunded: 2, cancelled: 2, validGross: 8000, validRefund: 400 },
  reach: null, complaintCases: 1, checks: { tested: 10, failed: 2 }, shipments: { nonCancelled: 8, withDates: 8, onTime: 6 }, hostIntent: 'WILLING', estimatedContributionPerOrder: 123, lowSampleBelow: 30,
});
const get = (r: ReturnType<typeof computeTrialKpis>, key: string) => r.items.find((x) => x.key === key)!;

describe('小規模測試團 KPI：公式（沿用既有口徑）', () => {
  it('8 項指標都在，每項有公式、資料來源、計算期間與資料完整度', () => {
    const r = computeTrialKpis(base());
    expect(r.items.map((x) => x.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const x of r.items) { expect(x.formula.length).toBeGreaterThan(5); expect(x.source.length).toBeGreaterThan(3); expect(x.periodNote.length).toBeGreaterThan(1); expect(x.completeness).toBeGreaterThanOrEqual(0); expect(x.completeness).toBeLessThanOrEqual(1); }
  });
  it('有效成交訂單數、有效平均客單價＝有效淨銷售額÷有效訂單數（沿用 AOV 口徑）', () => {
    const r = computeTrialKpis(base());
    expect(get(r, 'validOrders').value).toBe(8);
    expect(get(r, 'aov').value).toBe(Math.round((8000 - 400) / 8));   // 950
  });
  it('退貨比例＝有退款的訂單÷計入銷售的訂單；取消比例＝取消÷（計入銷售＋取消）', () => {
    const k = get(computeTrialKpis(base()), 'refundCancel');
    expect(k.value).toBe(20);
    expect(k.parts!.find((p) => p.key === 'cancelRate')!.value).toBe(16.67);   // 2 ÷ 12
  });
  it('客訴率（每百單）與試用缺陷率分開列出', () => {
    const k = get(computeTrialKpis(base()), 'complaintDefect');
    expect(k.parts!.find((p) => p.key === 'complaintPer100')!.value).toBe(12.5);   // 1 ÷ 8 × 100
    expect(k.parts!.find((p) => p.key === 'defectRate')!.value).toBe(20);
  });
  it('出貨準時率＝準時÷有預計與實際日期的出貨單；日期不齊時資料完整度下降並說明', () => {
    expect(get(computeTrialKpis(base()), 'onTimeShip')).toMatchObject({ value: 75, completeness: 1 });
    const i = base(); i.shipments = { nonCancelled: 10, withDates: 8, onTime: 6 };
    const k = get(computeTrialKpis(i), 'onTimeShip');
    expect(k.completeness).toBe(0.8); expect(k.reason).toContain('8／10');
  });
  it('團主再次合作意願是人工記錄的選項，不是推算', () => {
    expect(get(computeTrialKpis(base()), 'hostIntent')).toMatchObject({ status: 'OK', value: 'WILLING' });
  });
});

describe('小規模測試團 KPI：資料不足，不捏造', () => {
  it('導購轉換率沒有資料來源＝資料不足；即使訂單很多也不用社群人數湊分母', () => {
    const k = get(computeTrialKpis(base()), 'conversionRate');
    expect(k).toMatchObject({ status: 'INSUFFICIENT', value: null });
    expect(k.reason).toContain('資料來源');
  });
  it('只有提供可信的觸及人數時才計算轉換率', () => {
    const i = base(); i.reach = 400;
    expect(get(computeTrialKpis(i), 'conversionRate')).toMatchObject({ status: 'OK', value: 2 });   // 8 ÷ 400
  });
  it('實際每單貢獻利潤一律資料不足（須先確認費用與收入歸屬）；預估只當參考附上，並標明不是實際值', () => {
    const k = get(computeTrialKpis(base()), 'contributionPerOrder');
    expect(k).toMatchObject({ status: 'INSUFFICIENT', value: null });
    expect(k.reason).toContain('歸屬');
    expect(k.reference).toMatchObject({ value: 123, sensitive: true });
    expect(k.reference!.label).toContain('預估');
  });
  it('沒有任何訂單：訂單類指標都是資料不足（不是 0）；其餘不受影響', () => {
    const i = base(); i.orders = { total: 0, established: 0, valid: 0, refunded: 0, cancelled: 0, validGross: 0, validRefund: 0 }; i.shipments = { nonCancelled: 0, withDates: 0, onTime: 0 };
    const r = computeTrialKpis(i);
    for (const key of ['validOrders', 'aov', 'refundCancel', 'onTimeShip']) expect(get(r, key)).toMatchObject({ status: 'INSUFFICIENT', value: null });
    expect(get(r, 'validOrders').reason).toContain('尚無訂單');
    expect(get(r, 'complaintDefect').parts!.find((p) => p.key === 'defectRate')!.value).toBe(20);   // 缺陷率仍有資料
    expect(get(r, 'complaintDefect').parts!.find((p) => p.key === 'complaintPer100')!.value).toBeNull();
    expect(get(r, 'hostIntent').status).toBe('OK');
  });
  it('沒有已測檢核項也沒有有效訂單：客訴與缺陷率資料不足；其中一項不足時完整度減半並說明', () => {
    const i = base(); i.orders = { ...i.orders, valid: 0, established: 0, refunded: 0, validGross: 0, validRefund: 0 }; i.checks = { tested: 0, failed: 0 };
    expect(get(computeTrialKpis(i), 'complaintDefect')).toMatchObject({ status: 'INSUFFICIENT', value: null });
    const j = base(); j.checks = { tested: 0, failed: 0 };
    const k = get(computeTrialKpis(j), 'complaintDefect');
    expect(k.completeness).toBe(0.5); expect(k.reason).toContain('分項');
  });
  it('團主意願沒記錄＝資料不足；樣本偏小只提醒、不隱藏數值', () => {
    const i = base(); i.hostIntent = null;
    expect(get(computeTrialKpis(i), 'hostIntent')).toMatchObject({ status: 'INSUFFICIENT', value: null });
    const k = get(computeTrialKpis(base()), 'validOrders');
    expect(k.lowSample).toBe(true); expect(k.value).toBe(8); expect(k.reason).toContain('樣本偏小');
  });
  it('彙總：幾項可用、哪幾項資料不足；沒有任何通過／不通過的判定', () => {
    const r = computeTrialKpis(base());
    expect(r.okCount).toBe(6); expect(r.total).toBe(8);
    expect(r.insufficient).toEqual(['導購轉換率', '每單貢獻利潤']);
    for (const x of r.items) expect(Object.keys(x)).not.toContain('pass');
  });
  it('沒有成本權限：預估貢獻利潤參考值遮蔽；其餘不變', () => {
    const r = computeTrialKpis(base());
    const m = maskTrialKpis(r, false);
    expect(get(m, 'contributionPerOrder').reference!.value).toBeNull();
    expect(JSON.stringify(m)).not.toContain('123');
    expect(maskTrialKpis(r, true)).toEqual(r);
    expect(get(m, 'aov').value).toBe(950);
  });
});
