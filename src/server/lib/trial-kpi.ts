/**
 * SOP 03 小規模測試團 KPI（純函式，沒有資料庫相依）。規格見 docs/phase2/TRIAL_KPI.md。
 * 原則：有可靠資料來源才算；沒有來源或樣本為零就是「資料不足」（value 為 null），絕不當 0、也不捏造；
 *      沿用既有口徑（lib/kpi.ts：有效訂單＝PAID／PARTIAL_REFUND、客單價＝有效淨銷售額÷有效訂單數、退款率＝有退款的訂單÷計入銷售的訂單）；
 *      不套用任何通過／不通過的門檻（KPI 門檻尚未經 Owner 核准，見 TRIAL_KPI_OWNER_DECISIONS）；
 *      「每單貢獻利潤」的實際值需先確認費用與收入歸屬，所以實際值一律資料不足，只在有可行性試算時另附「預估」參考。
 */
export const HOST_INTENTS = ['WILLING', 'UNDECIDED', 'UNWILLING'] as const;
export type HostIntent = (typeof HOST_INTENTS)[number];
export const HOST_INTENT_LABEL: Record<HostIntent, string> = { WILLING: '願意再次合作', UNDECIDED: '尚未決定', UNWILLING: '不願意再次合作' };

export interface TrialKpiInput {
  period: { from: string | null; to: string | null };
  /** 資料截至（最近一次訂單匯入）；沒有匯入紀錄為 null */
  dataAsOf: string | null;
  orders: {
    /** 該範圍內所有訂單列（含待付款、已取消） */
    total: number;
    /** 計入銷售：PAID／PARTIAL_REFUND／REFUNDED */
    established: number;
    /** 有效訂單：PAID／PARTIAL_REFUND */
    valid: number;
    /** 計入銷售的訂單中，有退款的（部分退款、已退款，或退款金額 > 0） */
    refunded: number;
    cancelled: number;
    /** 有效訂單的毛額與退款額（同一組訂單） */
    validGross: number; validRefund: number;
  };
  /** 導購觸及人數（曝光／點擊）；目前沒有任何資料來源，固定為 null */
  reach: number | null;
  /** 客服案件數（排除已取消；檔期層級，不分團主） */
  complaintCases: number;
  /** 試用檢核項：已測項目數與其中未通過數 */
  checks: { tested: number; failed: number };
  shipments: { nonCancelled: number; withDates: number; onTime: number };
  hostIntent: HostIntent | null;
  /** 可行性試算的預估每單貢獻利潤（僅供有成本權限者參考；null＝沒有試算或缺輸入） */
  estimatedContributionPerOrder: number | null;
  /** 樣本偏小的提醒門檻（只提醒，不隱藏數值） */
  lowSampleBelow: number;
}

export type KpiStatus = 'OK' | 'INSUFFICIENT';
export interface KpiPart { key: string; label: string; value: number | null; unit: string; reason: string | null; sampleSize: number }
export interface KpiItem {
  key: string; no: number; label: string;
  status: KpiStatus;
  /** 主要數值（數字或選項代碼）；資料不足為 null */
  value: number | string | null;
  unit: string;
  /** 有多個數值的指標（退貨與取消、客訴與缺陷）逐項列出 */
  parts?: KpiPart[];
  formula: string; source: string; periodNote: string;
  /** 資料完整度 0～1：分母的資料有多少可用 */
  completeness: number;
  sampleSize: number;
  lowSample: boolean;
  /** 為什麼資料不足、或需要注意的事 */
  reason: string | null;
  /** 只供參考的另一個數字（例如預估），明確標示不是實際值 */
  reference?: { label: string; value: number | null; sensitive: boolean };
}
export interface TrialKpiResult { period: { from: string | null; to: string | null }; dataAsOf: string | null; items: KpiItem[]; okCount: number; total: number; insufficient: string[] }

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (a: number, b: number) => r2((a / b) * 100);
const NO_ORDERS = '尚無訂單資料（訂單未匯入，或尚未開團）';

export function computeTrialKpis(i: TrialKpiInput): TrialKpiResult {
  const o = i.orders;
  const noOrders = o.total === 0;
  const low = (n: number) => n > 0 && n < i.lowSampleBelow;
  const insufficient = (base: Omit<KpiItem, 'status' | 'value' | 'completeness' | 'sampleSize' | 'lowSample' | 'reason'>, reason: string, sampleSize = 0): KpiItem =>
    ({ ...base, status: 'INSUFFICIENT', value: null, completeness: 0, sampleSize, lowSample: false, reason });
  const items: KpiItem[] = [];

  // 1 有效成交訂單數
  const k1 = { key: 'validOrders', no: 1, label: '有效成交訂單數', unit: '筆', formula: '狀態為已付款（PAID）或部分退款（PARTIAL_REFUND）的訂單數', source: 'orders（有團主時以歸因分攤）', periodNote: '本檔期開團日至結團日（尚未結團則到今天）' };
  items.push(noOrders ? insufficient(k1, NO_ORDERS) : { ...k1, status: 'OK', value: o.valid, completeness: 1, sampleSize: o.total, lowSample: low(o.valid), reason: low(o.valid) ? `樣本偏小（少於 ${i.lowSampleBelow} 筆）` : null });

  // 2 導購轉換率
  const k2 = { key: 'conversionRate', no: 2, label: '導購轉換率', unit: '%', formula: '有效成交訂單數 ÷ 導購觸及人數 × 100', source: '需要曝光／點擊／觸及人數；目前沒有任何資料來源', periodNote: '同上' };
  items.push(i.reach != null && i.reach > 0 && !noOrders
    ? { ...k2, status: 'OK', value: pct(o.valid, i.reach), completeness: 1, sampleSize: i.reach, lowSample: low(o.valid), reason: null }
    : insufficient(k2, '沒有導購觸及人數的資料來源（社群成員數是自報、不是觸及，不當作分母）；需 Owner 決定資料來源'));

  // 3 有效平均客單價（沿用 lib/kpi 的 AOV 口徑）
  const k3 = { key: 'aov', no: 3, label: '有效平均客單價', unit: 'TWD', formula: '有效淨銷售額 ÷ 有效訂單數（有效淨銷售額＝有效訂單毛額 − 退款）', source: 'orders', periodNote: '同上' };
  items.push(o.valid === 0 ? insufficient(k3, noOrders ? NO_ORDERS : '沒有有效訂單') : { ...k3, status: 'OK', value: Math.round((o.validGross - o.validRefund) / o.valid), completeness: 1, sampleSize: o.valid, lowSample: low(o.valid), reason: low(o.valid) ? `樣本偏小（少於 ${i.lowSampleBelow} 筆）` : null });

  // 4 每單貢獻利潤（實際值需先確認費用與收入歸屬）
  const k4 = { key: 'contributionPerOrder', no: 4, label: '每單貢獻利潤', unit: 'TWD', formula: '公司貢獻利潤 ÷ 有效訂單數（biz-model 04 §2.2 代理人口徑）', source: '實際值需要「品牌端收入入帳」與「費用歸屬」資料；目前沒有可靠來源', periodNote: '同上' };
  items.push({ ...insufficient(k4, '實際貢獻利潤需先確認費用與收入的歸屬（品牌端服務費或分潤入帳、費用分攤到檔期的口徑）；不擅自改變既有結算口徑，需 Owner 決定'),
    reference: { label: '預估（來自商業可行性試算，不是實際值）', value: i.estimatedContributionPerOrder, sensitive: true } });

  // 5 退貨與取消比例
  const k5 = { key: 'refundCancel', no: 5, label: '退貨與取消比例', unit: '%', formula: '退貨（款）比例＝有退款的訂單 ÷ 計入銷售的訂單；取消比例＝已取消訂單 ÷（計入銷售的訂單＋已取消訂單）', source: 'orders', periodNote: '同上' };
  const cancelBase = o.established + o.cancelled;
  items.push(o.established === 0 && o.cancelled === 0
    ? insufficient(k5, noOrders ? NO_ORDERS : '沒有計入銷售或已取消的訂單')
    : { ...k5, status: 'OK', value: o.established > 0 ? pct(o.refunded, o.established) : null, completeness: 1, sampleSize: cancelBase, lowSample: low(cancelBase), reason: o.established === 0 ? '尚無計入銷售的訂單，退貨比例為資料不足' : null,
        parts: [
          { key: 'refundRate', label: '退貨（款）比例', value: o.established > 0 ? pct(o.refunded, o.established) : null, unit: '%', reason: o.established > 0 ? null : '尚無計入銷售的訂單', sampleSize: o.established },
          { key: 'cancelRate', label: '取消比例', value: cancelBase > 0 ? pct(o.cancelled, cancelBase) : null, unit: '%', reason: cancelBase > 0 ? null : '尚無訂單', sampleSize: cancelBase }] });

  // 6 客訴與缺陷率
  const k6 = { key: 'complaintDefect', no: 6, label: '客訴與缺陷率', unit: '', formula: '客訴率＝客服案件數 ÷ 有效訂單數 × 100（每百單）；缺陷率＝試用檢核項中未通過的項目 ÷ 已測項目 × 100', source: 'service_cases（檔期層級，不分團主）、trial_checks', periodNote: '客訴：本檔期；缺陷：本次試用' };
  const complaint = o.valid > 0 ? r2((i.complaintCases / o.valid) * 100) : null;
  const defect = i.checks.tested > 0 ? pct(i.checks.failed, i.checks.tested) : null;
  items.push(complaint == null && defect == null
    ? insufficient(k6, '沒有有效訂單，也沒有已測的檢核項')
    : { ...k6, status: 'OK', value: defect ?? complaint, completeness: (complaint == null ? 0 : 0.5) + (defect == null ? 0 : 0.5), sampleSize: o.valid + i.checks.tested, lowSample: low(o.valid), reason: complaint == null || defect == null ? '其中一項資料不足，請看下方分項' : null,
        parts: [
          { key: 'complaintPer100', label: '客訴率（每百單）', value: complaint, unit: '件／百單', reason: complaint == null ? '沒有有效訂單' : null, sampleSize: o.valid },
          { key: 'defectRate', label: '缺陷率（試用檢核項）', value: defect, unit: '%', reason: defect == null ? '尚無已測的檢核項' : null, sampleSize: i.checks.tested }] });

  // 7 出貨準時率
  const k7 = { key: 'onTimeShip', no: 7, label: '出貨準時率', unit: '%', formula: '出貨日不晚於預計出貨日的出貨單 ÷ 有預計與實際出貨日的出貨單 × 100', source: 'shipments（本檔期、訂單出貨）', periodNote: '同上' };
  const s = i.shipments;
  items.push(s.withDates === 0 ? insufficient(k7, s.nonCancelled === 0 ? '本檔期還沒有出貨單' : '出貨單缺少預計或實際出貨日', s.nonCancelled)
    : { ...k7, status: 'OK', value: pct(s.onTime, s.withDates), completeness: r2(s.withDates / Math.max(s.nonCancelled, s.withDates)), sampleSize: s.withDates, lowSample: low(s.withDates), reason: s.withDates < s.nonCancelled ? `只有 ${s.withDates}／${s.nonCancelled} 張出貨單有完整日期` : null });

  // 8 團主再次合作意願（人工記錄於試用）
  const k8 = { key: 'hostIntent', no: 8, label: '團主再次合作意願', unit: '', formula: '試用結束後由營運人員記錄：願意／尚未決定／不願意', source: '試用紀錄的「團主再次合作意願」欄位（人工記錄，非系統推算）', periodNote: '本次試用' };
  items.push(i.hostIntent ? { ...k8, status: 'OK', value: i.hostIntent, completeness: 1, sampleSize: 1, lowSample: false, reason: null } : insufficient(k8, '尚未記錄團主的意願（試用結束後由營運人員記錄）'));

  const insuff = items.filter((x) => x.status === 'INSUFFICIENT');
  return { period: i.period, dataAsOf: i.dataAsOf, items, okCount: items.length - insuff.length, total: items.length, insufficient: insuff.map((x) => x.label) };
}

/** 沒有成本權限者看不到「預估貢獻利潤」參考值（敏感），其餘不變 */
export function maskTrialKpis(r: TrialKpiResult, canSeeSensitive: boolean): TrialKpiResult {
  if (canSeeSensitive) return r;
  return { ...r, items: r.items.map((x) => (x.reference?.sensitive ? { ...x, reference: { ...x.reference, value: null } } : x)) };
}
