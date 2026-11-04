/**
 * KPI（試算）與正式結算的團主分潤「口徑差異提醒」（Owner 決策 K-6a；純函式，只提醒、不改任何一邊）。
 * KPI 側：商業可行性條款（比例、分潤基礎）× 實際訂單；結算側：財務分潤規則費率 × 歸因有效淨銷售額（覆寫、調整另計）。
 * 兩者不一致時顯示清楚的口徑差異與可能原因；KPI 不覆蓋結算，結算也不被 KPI 影響。
 */
export interface KpiCommissionSide { hostCommissionPct: number | null; basis: string | null; nsv: number; gmv: number; paidBy: string | null }
export interface SettlementCommissionSide {
  status: string; ratePercent: number | null; ruleVersion: number | null; netSales: number | null;
  commissionAuto: number | null; commissionOverride: number | null; adjustmentsTotal: number;
}
export interface SettlementDifference {
  differs: boolean;
  kpiCommission: number | null; settlementCommission: number | null; gap: number | null;
  reasons: string[]; text: string | null;
}

export function settlementDifference(k: KpiCommissionSide, s: SettlementCommissionSide): SettlementDifference {
  const kpiBase = k.basis === 'GMV' ? k.gmv : k.basis === 'NSV' ? k.nsv : null;
  const kpiCommission = k.hostCommissionPct != null && kpiBase != null ? Math.round((kpiBase * Math.round(k.hostCommissionPct * 1000)) / 100_000) : null;
  const base = s.commissionOverride ?? s.commissionAuto;
  const settlementCommission = base == null ? null : base + s.adjustmentsTotal;
  if (kpiCommission == null || settlementCommission == null) return { differs: false, kpiCommission, settlementCommission, gap: null, reasons: [], text: null };
  const gap = kpiCommission - settlementCommission;
  if (gap === 0) return { differs: false, kpiCommission, settlementCommission, gap: 0, reasons: [], text: null };
  const reasons: string[] = [];
  if (s.ratePercent != null && k.hostCommissionPct != null && s.ratePercent !== k.hostCommissionPct) reasons.push(`比例不同：KPI 用可行性條款 ${k.hostCommissionPct}%，結算用財務規則 ${s.ratePercent}%（規則 v${s.ruleVersion ?? '—'}）`);
  if (k.basis === 'GMV') reasons.push('基礎不同：KPI 依條款以 GMV（成交總額）計算，結算固定以歸因有效淨銷售額計算');
  if (s.netSales != null && s.netSales !== k.nsv) reasons.push(`淨銷售額不同：KPI 取目前的實際訂單 ${k.nsv}，結算明細當時的歸因淨銷售額為 ${s.netSales}（訂單資料更新時點或歸因比例不同）`);
  if (s.commissionOverride != null) reasons.push('結算有人工覆寫佣金（需原因，由財務維護）');
  if (s.adjustmentsTotal !== 0) reasons.push(`結算有調整項合計 ${s.adjustmentsTotal} 元`);
  if (!reasons.length) reasons.push('無法由比例、基礎、淨銷售額、覆寫或調整解釋，請財務核對');
  const text = `口徑差異提醒：KPI 試算的團主分潤 ${kpiCommission} 元與結算（${s.status === 'CONFIRMED' ? '已確認' : '草稿'}）的 ${settlementCommission} 元不一致（差 ${gap > 0 ? '+' : ''}${gap} 元）。${reasons.join('；')}。KPI 不覆蓋結算，結算也不受 KPI 影響；請財務依既有規則版本與核准流程處理。`;
  return { differs: true, kpiCommission, settlementCommission, gap, reasons, text };
}
