import { describe, expect, it } from 'vitest';
import { settlementDifference, type KpiCommissionSide, type SettlementCommissionSide } from '@/server/lib/kpi-settlement-reminder';

const k = (o: Partial<KpiCommissionSide> = {}): KpiCommissionSide => ({ hostCommissionPct: 5, basis: 'NSV', nsv: 4600, gmv: 5600, paidBy: 'COMPANY', ...o });
const s = (o: Partial<SettlementCommissionSide> = {}): SettlementCommissionSide => ({ status: 'DRAFT', ratePercent: 5, ruleVersion: 1, netSales: 4600, commissionAuto: 230, commissionOverride: null, adjustmentsTotal: 0, ...o });

describe('K-6a KPI 與結算的團主分潤口徑差異提醒（純函式；只提醒）', () => {
  it('一致：沒有提醒', () => {
    expect(settlementDifference(k(), s())).toMatchObject({ differs: false, kpiCommission: 230, settlementCommission: 230, gap: 0, text: null });
  });
  it('比例不同（可行性 5%、財務規則 8%）：顯示兩邊金額、差額、原因與規則版本；明講 KPI 不覆蓋結算', () => {
    const d = settlementDifference(k(), s({ ratePercent: 8, ruleVersion: 4, commissionAuto: 368 }));
    expect(d).toMatchObject({ differs: true, kpiCommission: 230, settlementCommission: 368, gap: -138 });
    expect(d.reasons[0]).toContain('KPI 用可行性條款 5%，結算用財務規則 8%（規則 v4）');
    expect(d.text).toContain('口徑差異提醒'); expect(d.text).toContain('KPI 不覆蓋結算'); expect(d.text).toContain('既有規則版本與核准流程');
  });
  it('基礎不同（條款用 GMV、結算固定用淨銷售額）、淨銷售額不同、覆寫、調整都會被列為原因', () => {
    const d = settlementDifference(k({ basis: 'GMV' }), s({ netSales: 4000, commissionAuto: 200, commissionOverride: 250, adjustmentsTotal: -20 }));
    expect(d.differs).toBe(true);
    expect(d.reasons.join()).toContain('基礎不同'); expect(d.reasons.join()).toContain('淨銷售額不同'); expect(d.reasons.join()).toContain('人工覆寫'); expect(d.reasons.join()).toContain('調整項合計 -20');
    expect(d.settlementCommission).toBe(230);        // 覆寫 250 ＋ 調整 −20
    expect(d.kpiCommission).toBe(280);               // GMV 5600 × 5%
  });
  it('已確認的結算：文字註明已確認；缺資料（沒有比例、沒有結算金額）時不提醒、不推測', () => {
    expect(settlementDifference(k(), s({ status: 'CONFIRMED', commissionAuto: 300 })).text).toContain('結算（已確認）');
    expect(settlementDifference(k({ hostCommissionPct: null }), s())).toMatchObject({ differs: false, kpiCommission: null });
    expect(settlementDifference(k(), s({ commissionAuto: null }))).toMatchObject({ differs: false, settlementCommission: null });
  });
  it('純函式、不改輸入', () => {
    const a = k(), b = s({ ratePercent: 8, commissionAuto: 368 });
    const before = JSON.stringify([a, b]);
    settlementDifference(a, b);
    expect(JSON.stringify([a, b])).toBe(before);
  });
});
