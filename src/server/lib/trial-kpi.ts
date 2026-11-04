/**
 * SOP 03 小規模測試團 KPI（純函式，沒有資料庫相依）。規格見 docs/phase2/TRIAL_KPI.md。
 * 原則：有可靠資料來源才算；沒有來源或樣本為零就是「資料不足」（value 為 null），絕不當 0、也不捏造；
 *      沿用既有口徑（lib/kpi.ts：有效訂單＝PAID／PARTIAL_REFUND、客單價＝有效淨銷售額÷有效訂單數、退款率＝有退款的訂單÷計入銷售的訂單）；
 *      不套用任何通過／不通過的門檻（Owner 決策 K-1：累積至少 5 檔小規模測試團後再提交審查；核准前只顯示數值、完整度與風險提示，不判定是否值得放大銷售）；
 *      導購轉換率（K-2）：CVR＝有效成交訂單 ÷ 有效導購訪客；潛在觸及（群組人數）只能另列「群組成員訂單比」，不能當 CVR、也不能當實際觸及；
 *      每單貢獻利潤（K-3）：由 lib/actual-profit 以「已確認的合作合約或正式商務條件」計算；條件不全或未確認一律資料不足，未知成本不當 0。
 */
import type { ActualProfitResult } from './actual-profit';
import { REACH_METRIC_LABEL, REACH_SOURCE_LABEL, CREDIBILITY_LABEL, type ReachRecord } from './trial-reach';

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
    /** 計入銷售的訂單的 GMV 與退款額（與 lib/kpi、商業可行性實際值回寫同一組訂單；有效淨銷售額＝GMV − 退款） */
    gmv: number; refund: number;
  };
  /** 觸及與導購資料（人工填寫；三種各取最新一筆）。visitorsUsable＝有效導購訪客能否當 CVR 的分母 */
  reach: { potential: ReachRecord | null; actual: ReachRecord | null; visitors: ReachRecord | null; visitorsUsable: { usable: boolean; reason: string | null } };
  /** 實際貢獻利潤（lib/actual-profit）；沒有檔期為 null */
  contribution: ActualProfitResult | null;
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

export type KpiStatus = 'OK' | 'INSUFFICIENT' | 'RESTRICTED';
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
  /** 這一項採用的人工資料明細（來源、期間、填寫人、可信度），一行一筆 */
  facts?: string[];
  /** 數值含成本等敏感資料：沒有成本檢視權限者只看到「需權限」 */
  sensitive?: boolean;
}
export interface TrialKpiResult { period: { from: string | null; to: string | null }; dataAsOf: string | null; items: KpiItem[]; okCount: number; total: number; insufficient: string[]; /** 風險提示：只陳述事實與資料品質，不是通過／不通過的判定 */ notices: string[] }

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

  // 2 導購轉換率（CVR）：分母只用「有效導購訪客」；群組成員數（潛在觸及）只能另列「群組成員訂單比」
  const k2 = { key: 'conversionRate', no: 2, label: '導購轉換率（CVR）', unit: '%', formula: 'CVR＝有效成交訂單數 ÷ 有效導購訪客數 × 100（分母只用「有效導購訪客」；群組人數與貼文觸及都不是分母）', source: '試用的「觸及與導購資料」（人工填寫，記錄來源、期間、填寫人、可信度）＋ orders', periodNote: '同上；導購訪客的統計期間需與檔期重疊' };
  const rc = i.reach;
  const fact = (r: ReachRecord | null) => (r ? `${REACH_METRIC_LABEL[r.metric]}：${r.value} 人（${REACH_SOURCE_LABEL[r.sourceKind]}；來源：${r.sourceText}；統計 ${r.periodStart}～${r.periodEnd}；填寫 ${r.createdByName ?? r.createdBy} ${r.filledOn}；可信度${CREDIBILITY_LABEL[r.credibility].slice(0, 1)}）` : null);
  const facts2 = [fact(rc.potential), fact(rc.actual), fact(rc.visitors)].filter((x): x is string => x != null);
  const groupRatioPart = { key: 'groupMemberOrderRatio', label: '群組成員訂單比（有效訂單 ÷ 潛在觸及人數；不是 CVR，也不代表實際觸及）',
    value: rc.potential && rc.potential.value > 0 && o.valid > 0 ? pct(o.valid, rc.potential.value) : null, unit: '%',
    reason: !rc.potential ? '尚未填寫潛在觸及人數（例如 LINE 群組成員數）' : rc.potential.value <= 0 ? '潛在觸及人數為 0' : o.valid === 0 ? '沒有有效訂單' : null, sampleSize: rc.potential?.value ?? 0 };
  let cvr: KpiItem;
  if (!rc.visitorsUsable.usable) cvr = insufficient(k2, rc.visitorsUsable.reason ?? '沒有可靠的有效導購訪客數');
  else if (noOrders || o.valid === 0) cvr = insufficient(k2, noOrders ? NO_ORDERS : '沒有有效訂單');
  else if (!rc.visitors || rc.visitors.value <= 0) cvr = insufficient(k2, '有效導購訪客數為 0，無法計算');
  else if (o.valid > rc.visitors.value) cvr = insufficient(k2, `有效成交訂單（${o.valid}）多於有效導購訪客（${rc.visitors.value}），資料不合理，請檢查訪客數的來源與統計期間`, rc.visitors.value);
  else cvr = { ...k2, status: 'OK', value: pct(o.valid, rc.visitors.value), completeness: 1, sampleSize: rc.visitors.value, lowSample: low(o.valid), reason: low(o.valid) ? `樣本偏小（有效訂單少於 ${i.lowSampleBelow} 筆）` : null };
  items.push({ ...cvr, parts: [groupRatioPart], facts: facts2.length ? facts2 : undefined });

  // 3 有效平均客單價（沿用 lib/kpi 的 AOV 口徑）
  const k3 = { key: 'aov', no: 3, label: '有效平均客單價', unit: 'TWD', formula: '有效淨銷售額 ÷ 有效訂單數（有效淨銷售額＝計入銷售訂單的 GMV − 退款；與 Dashboard、商業可行性實際值回寫同一定義）', source: 'orders', periodNote: '同上' };
  items.push(o.valid === 0 ? insufficient(k3, noOrders ? NO_ORDERS : '沒有有效訂單') : { ...k3, status: 'OK', value: Math.round((o.gmv - o.refund) / o.valid), completeness: 1, sampleSize: o.valid, lowSample: low(o.valid), reason: low(o.valid) ? `樣本偏小（少於 ${i.lowSampleBelow} 筆）` : null });

  // 4 每單貢獻利潤（K-3）：公司貢獻利潤 ÷ 有效訂單數；條款須為已確認的合約／正式商務條件，否則資料不足
  const k4 = { key: 'contributionPerOrder', no: 4, label: '每單貢獻利潤', unit: 'TWD', formula: '每單 ＝ 公司貢獻利潤 ÷ 有效訂單數；公司貢獻利潤 ＝ 公司確認收入 − 團主分潤（若由公司支付）− 公司實際負擔的可歸屬成本。收款方與各項費用負擔方依該檔期的合作條款，不寫死', source: '該檔期「商業可行性」的合作條款（假設來源須為「合約」或「正式商務條件」）＋實際訂單；與商業可行性實際值回寫共用同一計算', periodNote: '同上', sensitive: true };
  const ref = { label: '預估（來自商業可行性試算，不是實際值）', value: i.estimatedContributionPerOrder, sensitive: true };
  const cp = i.contribution;
  items.push(cp && cp.status === 'OK' && cp.perOrder != null
    ? { ...k4, status: 'OK', value: cp.perOrder, completeness: 1, sampleSize: o.valid, lowSample: low(o.valid), reason: low(o.valid) ? `樣本偏小（有效訂單少於 ${i.lowSampleBelow} 筆）` : null,
        parts: [{ key: 'contributionTotal', label: '公司貢獻利潤（總額）', value: cp.total, unit: 'TWD', reason: null, sampleSize: o.valid }], reference: ref }
    : { ...insufficient(k4, cp ? cp.reasons.join('；') : '這個試用沒有關聯檔期，沒有可用的合作條款與訂單'), reference: ref });

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

  return finalize(i, items);
}

/** 風險提示：只陳述事實與資料品質（不是門檻、不是通過／不通過），讓審查的人知道哪裡要多看一眼 */
function noticesOf(i: TrialKpiInput, items: KpiItem[]): string[] {
  const n: string[] = [];
  const insuff = items.filter((x) => x.status === 'INSUFFICIENT');
  if (insuff.length) n.push(`資料不足 ${insuff.length} 項：${insuff.map((x) => x.label).join('、')}`);
  const low = items.filter((x) => x.lowSample);
  if (low.length) n.push(`樣本偏小：${low.map((x) => x.label).join('、')}`);
  const partial = items.filter((x) => x.status === 'OK' && x.completeness < 1);
  if (partial.length) n.push(`資料完整度未達 100%：${partial.map((x) => `${x.label}（${Math.round(x.completeness * 100)}%）`).join('、')}`);
  if (i.orders.refunded > 0) n.push(`有 ${i.orders.refunded} 筆訂單發生退貨（款）`);
  if (i.orders.cancelled > 0) n.push(`有 ${i.orders.cancelled} 筆訂單被取消`);
  if (i.complaintCases > 0) n.push(`本檔期有 ${i.complaintCases} 件客服案件（檔期層級）`);
  if (i.checks.failed > 0) n.push(`試用檢核有 ${i.checks.failed} 項未通過`);
  if (i.hostIntent === 'UNWILLING' || i.hostIntent === 'UNDECIDED') n.push(`團主再次合作意願：${HOST_INTENT_LABEL[i.hostIntent]}`);
  return n;
}

function finalize(i: TrialKpiInput, items: KpiItem[]): TrialKpiResult {
  const insuff = items.filter((x) => x.status === 'INSUFFICIENT');
  return { period: i.period, dataAsOf: i.dataAsOf, items, okCount: items.length - insuff.length, total: items.length, insufficient: insuff.map((x) => x.label), notices: noticesOf(i, items) };
}

/** 沒有成本權限者：含成本的指標（每單貢獻利潤）只看到「需權限」，連資料不足的原因（會洩漏條款欄位）與預估值都不給 */
export function maskTrialKpis(r: TrialKpiResult, canSeeSensitive: boolean): TrialKpiResult {
  if (canSeeSensitive) return r;
  const items = r.items.map((x): KpiItem => (x.sensitive
    ? { ...x, status: 'RESTRICTED', value: null, parts: undefined, reason: '需有成本檢視權限才能查看', facts: undefined, reference: x.reference ? { ...x.reference, value: null } : undefined }
    : x));
  const restricted = items.filter((x) => x.status === 'RESTRICTED');
  const insuff = items.filter((x) => x.status === 'INSUFFICIENT');
  return { ...r, items, okCount: items.length - insuff.length - restricted.length, insufficient: insuff.map((x) => x.label),
    notices: r.notices.filter((n) => !n.startsWith('資料不足')).concat(insuff.length ? [`資料不足 ${insuff.length} 項：${insuff.map((x) => x.label).join('、')}`] : []) };
}
