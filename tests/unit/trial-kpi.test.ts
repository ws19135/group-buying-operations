import { describe, expect, it } from 'vitest';
import { computeTrialKpis, maskTrialKpis, type TrialKpiInput } from '@/server/lib/trial-kpi';
import type { ReachRecord } from '@/server/lib/trial-reach';
import { visitorsUsable } from '@/server/lib/trial-reach';
import type { ActualProfitResult } from '@/server/lib/actual-profit';

const rec = (over: Partial<ReachRecord>): ReachRecord => ({
  id: 'RCH-000001', metric: 'QUALIFIED_VISITORS', value: 400, sourceKind: 'SHORT_LINK_UNIQUE_VISITORS', sourceText: '導購短連結後台（虛構）', periodStart: '2026-11-01', periodEnd: '2026-11-10',
  credibility: 'HIGH', note: null, filledOn: '2026-11-11', createdBy: 'USR-1', createdByName: '營運人員', createdAt: '2026-11-11T01:00:00Z', deleted: false, deletedAt: null, deleteReason: null,
  evidenceRef: 'REPORT-001', dedupeMethod: 'SHORT_LINK_UNIQUE_CLIENTS', dedupeNote: null, rulesVersion: 'reach-rules/2026-11-04.1', verificationStatus: 'VERIFIED', verifiedBy: 'USR-2', verifiedByName: '主管', verifiedAt: '2026-11-12T01:00:00Z', verifyNote: '已對照後台報表', verifyRulesVersion: 'reach-rules/2026-11-04.1', ...over,
});
const noReach = (): TrialKpiInput['reach'] => ({ potential: null, actual: null, visitors: null, visitorsUsable: visitorsUsable(null, { from: '2026-11-01', to: '2026-11-10' }) });
const withVisitors = (r: ReachRecord): TrialKpiInput['reach'] => ({ potential: null, actual: null, visitors: r, visitorsUsable: visitorsUsable(r, { from: '2026-11-01', to: '2026-11-10' }) });
const okProfit: ActualProfitResult = { status: 'OK', total: 960, perOrder: 120, reasons: [], missing: [], unconfirmed: [], results: null };
const noProfit: ActualProfitResult = { status: 'INSUFFICIENT', total: null, perOrder: null, reasons: ['缺少：退款／退貨處理成本'], missing: ['退款／退貨處理成本'], unconfirmed: [], results: null };

const base = (): TrialKpiInput => ({
  period: { from: '2026-11-01', to: '2026-11-10' }, dataAsOf: '2026-11-10 09:00',
  orders: { total: 12, established: 10, valid: 8, refunded: 2, cancelled: 2, gmv: 8000, refund: 400 },
  reach: noReach(), contribution: noProfit, complaints: { total: 1, unattributed: 0, sharedCases: 0, hostExclusive: 0, hostShared: 0, hostWeighted: 0, hostRelated: 0, hostValidWeighted: 0, campaignValid: 8 }, hostScoped: false, checks: { tested: 10, failed: 2 }, shipments: { nonCancelled: 8, withDates: 8, onTime: 6 }, hostIntent: 'WILLING', estimatedContributionPerOrder: 123, lowSampleBelow: 30,
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
  it('沒有「有效導購訪客」＝CVR 資料不足；即使訂單很多、也有群組人數與觸及人數，都不能湊分母', () => {
    const i = base(); i.reach = { ...noReach(), potential: rec({ metric: 'POTENTIAL_REACH', value: 500, sourceKind: 'LINE_GROUP_MEMBERS' }), actual: rec({ metric: 'ACTUAL_REACH', value: 900, sourceKind: 'PLATFORM_POST_REACH' }) };
    const k = get(computeTrialKpis(i), 'conversionRate');
    expect(k).toMatchObject({ status: 'INSUFFICIENT', value: null });
    expect(k.reason).toContain('有效導購訪客');
  });
  it('有可信的有效導購訪客才算 CVR＝有效成交訂單 ÷ 有效導購訪客', () => {
    const i = base(); i.reach = withVisitors(rec({ value: 400 }));
    expect(get(computeTrialKpis(i), 'conversionRate')).toMatchObject({ status: 'OK', value: 2, sampleSize: 400 });   // 8 ÷ 400
  });
  it('導購訪客可信度為低、統計期間與檔期不重疊、來源種類不合規：都不採用，維持資料不足並說明原因', () => {
    const low = base(); low.reach = withVisitors(rec({ credibility: 'LOW' }));
    expect(get(computeTrialKpis(low), 'conversionRate').reason).toContain('可信度為低');
    const off = base(); off.reach = withVisitors(rec({ periodStart: '2026-10-01', periodEnd: '2026-10-05' }));
    expect(get(computeTrialKpis(off), 'conversionRate').reason).toContain('沒有重疊');
    const bad = base(); bad.reach = withVisitors(rec({ sourceKind: 'LINE_GROUP_MEMBERS' }));
    expect(get(computeTrialKpis(bad), 'conversionRate').reason).toContain('來源種類不合規');
  });
  it('有效成交訂單多於有效導購訪客：資料不合理，資料不足（不顯示超過 100% 的 CVR）', () => {
    const i = base(); i.reach = withVisitors(rec({ value: 5 }));
    const k = get(computeTrialKpis(i), 'conversionRate');
    expect(k.status).toBe('INSUFFICIENT'); expect(k.reason).toContain('資料不合理');
  });
  it('群組成員訂單比另列、明確標示不是 CVR，也不把群組人數當成實際觸及；有 CVR 時兩者並存', () => {
    const i = base(); i.reach = { potential: rec({ metric: 'POTENTIAL_REACH', value: 200, sourceKind: 'LINE_GROUP_MEMBERS' }), actual: rec({ metric: 'ACTUAL_REACH', value: 90, sourceKind: 'PLATFORM_POST_REACH' }), visitors: null, visitorsUsable: visitorsUsable(null, { from: null, to: null }) };
    const k = get(computeTrialKpis(i), 'conversionRate');
    expect(k.status).toBe('INSUFFICIENT');                                   // 沒有導購訪客，CVR 照樣資料不足
    const part = k.parts!.find((p) => p.key === 'groupMemberOrderRatio')!;
    expect(part.value).toBe(4);                                              // 8 ÷ 200
    expect(part.label).toContain('不是 CVR'); expect(part.label).toContain('不代表實際觸及');
    expect(k.facts!.join('\n')).toContain('潛在觸及人數：200 人'); expect(k.facts!.join('\n')).toContain('實際觸及人數：90 人');
    expect(k.facts!.find((f) => f.startsWith('潛在觸及'))).toContain('營運人員 2026-11-11');   // 填寫人與填寫日期
  });
  it('沒有潛在觸及人數：群組成員訂單比資料不足，不是 0', () => {
    const p = get(computeTrialKpis(base()), 'conversionRate').parts!.find((x) => x.key === 'groupMemberOrderRatio')!;
    expect(p.value).toBeNull(); expect(p.reason).toContain('尚未填寫');
  });
  it('每單貢獻利潤：條款已確認且完整才有值；否則資料不足並說明缺什麼，不是 0', () => {
    const bad = get(computeTrialKpis(base()), 'contributionPerOrder');
    expect(bad).toMatchObject({ status: 'INSUFFICIENT', value: null });
    expect(bad.reason).toContain('退款／退貨處理成本');
    const i = base(); i.contribution = okProfit;
    const ok = get(computeTrialKpis(i), 'contributionPerOrder');
    expect(ok).toMatchObject({ status: 'OK', value: 120 });
    expect(ok.parts![0].value).toBe(960);
    expect(ok.formula).toContain('不寫死');
  });
  it('預估貢獻利潤只當參考附上，並標明不是實際值', () => {
    const k = get(computeTrialKpis(base()), 'contributionPerOrder');
    expect(k.reference).toMatchObject({ value: 123, sensitive: true });
    expect(k.reference!.label).toContain('預估');
  });
  it('沒有任何訂單：訂單類指標都是資料不足（不是 0）；其餘不受影響', () => {
    const i = base(); i.orders = { total: 0, established: 0, valid: 0, refunded: 0, cancelled: 0, gmv: 0, refund: 0 }; i.complaints = { ...i.complaints, campaignValid: 0 }; i.shipments = { nonCancelled: 0, withDates: 0, onTime: 0 };
    const r = computeTrialKpis(i);
    for (const key of ['validOrders', 'aov', 'refundCancel', 'onTimeShip']) expect(get(r, key)).toMatchObject({ status: 'INSUFFICIENT', value: null });
    expect(get(r, 'validOrders').reason).toContain('尚無訂單');
    expect(get(r, 'complaintDefect').parts!.find((p) => p.key === 'defectRate')!.value).toBe(20);   // 缺陷率仍有資料
    expect(get(r, 'complaintDefect').parts!.find((p) => p.key === 'complaintPer100')!.value).toBeNull();
    expect(get(r, 'hostIntent').status).toBe('OK');
  });
  it('沒有已測檢核項也沒有有效訂單：客訴與缺陷率資料不足；其中一項不足時完整度減半並說明', () => {
    const i = base(); i.orders = { ...i.orders, valid: 0, established: 0, refunded: 0, gmv: 0, refund: 0 }; i.complaints = { ...i.complaints, campaignValid: 0 }; i.checks = { tested: 0, failed: 0 };
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
    expect(r.insufficient).toEqual(['導購轉換率（CVR）', '每單貢獻利潤']);
    for (const x of r.items) expect(Object.keys(x)).not.toContain('pass');
  });
  it('風險提示只陳述事實與資料品質，沒有「建議放大」或通過／不通過的字眼', () => {
    const r = computeTrialKpis(base());
    const text = r.notices.join('\n');
    expect(text).toContain('資料不足 2 項'); expect(text).toContain('樣本偏小'); expect(text).toContain('2 筆訂單發生退貨'); expect(text).toContain('試用檢核有 2 項未通過');
    expect(text).not.toMatch(/建議放大|建議擴大|通過門檻|不通過|達標/);
  });
  it('沒有成本權限：每單貢獻利潤只顯示「需權限」（連資料不足的原因與預估值都不給）；其餘不變', () => {
    const i = base(); i.contribution = okProfit;
    const r = computeTrialKpis(i);
    const m = maskTrialKpis(r, false);
    const k = get(m, 'contributionPerOrder');
    expect(k).toMatchObject({ status: 'RESTRICTED', value: null });
    expect(k.parts).toBeUndefined(); expect(k.reference!.value).toBeNull();
    expect(JSON.stringify(m)).not.toContain('"value":120'); expect(JSON.stringify(m)).not.toContain('960'); expect(JSON.stringify(m)).not.toContain('123');
    expect(maskTrialKpis(r, true)).toEqual(r);
    expect(get(m, 'aov').value).toBe(950);
    const bad = maskTrialKpis(computeTrialKpis(base()), false);
    expect(get(bad, 'contributionPerOrder').reason).toBe('需有成本檢視權限才能查看');   // 不洩漏缺少哪個成本欄位
    expect(JSON.stringify(bad)).not.toContain('退款／退貨處理成本');
  });
  it('AOV 沿用 Dashboard 定義：計入銷售訂單的 GMV − 退款，再除以有效訂單數', () => {
    const i = base(); i.orders = { ...i.orders, gmv: 10_000, refund: 1_000, valid: 8 };
    expect(get(computeTrialKpis(i), 'aov').value).toBe(Math.round(9000 / 8));
  });
});

describe('K-5／K-5a：客訴率分開呈現（檔期整體 vs 團主層級加權），未歸屬保留', () => {
  const hostCase = (over: Partial<TrialKpiInput['complaints']> = {}): TrialKpiInput => {
    const i = base();
    i.hostScoped = true;
    // 檔期 20 張有效訂單；此團主歸因的有效訂單（加權）8 張；5 件案件：單一歸屬 1、共同歸因 1（此團主分到 0.6 件）、未歸屬 2、其他團主 1
    i.complaints = { total: 5, unattributed: 2, sharedCases: 1, hostExclusive: 1, hostShared: 1, hostWeighted: 1.6, hostRelated: 2, hostValidWeighted: 8, campaignValid: 20, ...over };
    return i;
  };
  it('檔期整體＝全部案件（每件一次）÷ 檔期有效訂單；團主層級＝加權客訴數 ÷ 此團主有效訂單（加權）；兩個分母不同、不混用', () => {
    const k = get(computeTrialKpis(hostCase()), 'complaintDefect');
    expect(k.parts!.find((p) => p.key === 'complaintPer100')!.value).toBe(25);          // 5 ÷ 20
    expect(k.parts!.find((p) => p.key === 'hostComplaintPer100')!.value).toBe(20);      // 1.6 ÷ 8
    expect(k.parts!.find((p) => p.key === 'hostComplaintPer100')!.label).toContain('加權');
    expect(k.parts!.find((p) => p.key === 'hostComplaintPer100')!.reason).toContain('2 件未歸屬');
  });
  it('清楚標示分攤口徑與分母：共同歸因依訂單歸因比例分攤、每件合計 1、完整關聯不可加總、兩個分母各是多少', () => {
    const f = get(computeTrialKpis(hostCase()), 'complaintDefect');
    const facts = f.facts!.join('\n');
    expect(facts).toContain('加權客訴數 1.6 件（共同歸因依訂單歸因比例分攤，每件合計 1 件）');
    expect(facts).toContain('涉及此團主的案件共 2 件（完整關聯，不可加總）');
    expect(facts).toContain('團主層級分母：此團主歸因的有效訂單（依歸因比例加權）8 張；檔期整體分母：檔期有效訂單 20 張');
    expect(f.formula).toContain('各團主加權客訴數合計＋未歸屬＝公司整體件數');
  });
  it('未歸屬的案件不計入任何團主；說明裡明講「保留未歸屬，不分配」；共同歸因整體只算一次', () => {
    const k = get(computeTrialKpis(hostCase()), 'complaintDefect');
    const facts = k.facts!.join('\n');
    expect(facts).toContain('客訴（客服案件）5 件（檔期整體，每件只算一次）');
    expect(facts).toContain('歸屬此團主 1 件、與其他團主共同歸因 1 件');
    expect(facts).toContain('未歸屬 2 件（保留未歸屬，不分配給任何團主）');
    expect(facts).toContain('共同歸因 1 件（整體只算一次）');
    expect(computeTrialKpis(hostCase()).notices.join()).toContain('2 件客服案件無法歸屬團主');
  });
  it('沒有指定團主的試用：只有檔期整體，沒有團主層級', () => {
    const k = get(computeTrialKpis(base()), 'complaintDefect');
    expect(k.parts!.some((p) => p.key === 'hostComplaintPer100')).toBe(false);
  });
  it('這位團主沒有有效訂單：團主層級客訴率是資料不足（不是 0）', () => {
    const i = hostCase({ hostValidWeighted: 0 });
    expect(get(computeTrialKpis(i), 'complaintDefect').parts!.find((p) => p.key === 'hostComplaintPer100')!.value).toBeNull();
  });
  it('公式明講客訴率不作為團主懲罰、停權或自動處置的依據；結果裡沒有任何處置欄位', () => {
    const k = get(computeTrialKpis(hostCase()), 'complaintDefect');
    expect(k.formula).toContain('不作為團主懲罰、停權或任何自動處置的依據');
    expect(JSON.stringify(computeTrialKpis(hostCase()))).not.toMatch(/suspend|penalty|ban|停權處置/);
  });
  it('沒有有效訂單、沒有已測檢核項時比率資料不足，但案件件數與歸屬狀況仍照實列出（不隱藏事實）', () => {
    const i = base(); i.hostScoped = true;
    i.orders = { total: 0, established: 0, valid: 0, refunded: 0, cancelled: 0, gmv: 0, refund: 0 };
    i.checks = { tested: 0, failed: 0 };
    i.complaints = { total: 2, unattributed: 1, sharedCases: 0, hostExclusive: 1, hostShared: 0, hostWeighted: 1, hostRelated: 1, hostValidWeighted: 0, campaignValid: 0 };
    const k = get(computeTrialKpis(i), 'complaintDefect');
    expect(k).toMatchObject({ status: 'INSUFFICIENT', value: null });
    expect(k.facts!.join()).toContain('客訴（客服案件）2 件'); expect(k.facts!.join()).toContain('未歸屬 1 件');
    expect(k.parts!.every((p) => p.value === null)).toBe(true);
  });
});
