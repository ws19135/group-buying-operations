import { describe, expect, it } from 'vitest';
import { reconcileRow, type ContractSnap, type FeasibilitySnap, type FinanceSnap, type ReconInput } from '@/server/lib/commission-reconciliation';

const TODAY = '2026-11-04';
const contract = (o: Partial<ContractSnap> = {}): ContractSnap => ({ recordId: 'VDD-1', contractVersion: 'C-2026-01', recordStatus: 'APPROVED', validUntil: '2027-01-01', superseded: false, itemStatus: 'CONFIRMED', basis: 'NSV', hostCommissionPct: 8, legacyRatePct: null, hostPaidBy: 'COMPANY', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', ...o });
const feas = (o: Partial<FeasibilitySnap> = {}, kind = 'CONTRACT'): FeasibilitySnap => ({ scenarioId: 'FSB-1', versionNo: 2, commissionBasis: 'NSV', hostCommissionPct: 8, hostPaidBy: 'COMPANY', sources: { hostCommissionPct: { kind }, commissionBasis: { kind }, hostPaidBy: { kind } }, ...o });
const fin = (o: Partial<FinanceSnap> = {}): FinanceSnap => ({ ruleId: 'CRL-1', ruleVersion: 3, scopeType: 'HOST_DEFAULT', ratePercent: 8, effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', ruleStatus: 'ACTIVE', settlement: null, ...o });
const input = (o: Partial<ReconInput> = {}): ReconInput => ({ campaignId: 'CMP-1', campaignTitle: '[DEMO] 檔期', campaignOpenDate: '2026-11-01', hostId: 'OWN-1', hostName: '[DEMO] 團主', productId: 'PRD-1', productName: '[DEMO] 商品', contract: contract(), feasibility: feas(), finance: fin(), attributedNetSales: 10_000, ...o });
const field = (r: ReturnType<typeof reconcileRow>, f: string) => r.fields.find((x) => x.field === f)!;

describe('K-6 分潤口徑差異核對（唯讀比較）', () => {
  it('三方一致：比例與基礎一致、已核准；付款方與期間因財務規則沒記錄而是資料不足，不算差異', () => {
    const r = reconcileRow(input(), TODAY);
    expect(field(r, 'ratePercent')).toMatchObject({ verdict: 'CONSISTENT', differences: [] });
    expect(field(r, 'basis').verdict).toBe('CONSISTENT');
    expect(field(r, 'paidBy').verdict).toBe('CONSISTENT');           // 合約與可行性一致；財務沒記錄（只有兩個來源比較）
    expect(field(r, 'period').verdict).toBe('CONSISTENT');           // 合約與財務規則的期間相同
    expect(r.verdict).toBe('CONSISTENT');
    expect(r.needsManualReview).toBe(false);
    expect(r.impact.estimatedGap).toBeNull();
  });

  it('比例不同：列出各來源的值、來源版本、是否已核准，以及影響範圍（比例差距 × 歸因淨銷售額）', () => {
    const r = reconcileRow(input({ feasibility: feas({ hostCommissionPct: 5 }), finance: fin({ ratePercent: 10, ruleVersion: 4 }) }), TODAY);
    const f = field(r, 'ratePercent');
    expect(f.verdict).toBe('DIFFERENT');
    expect(f.differences[0]).toContain('合約約定 8%（合約版本 C-2026-01）【已核准／確認】');
    expect(f.differences[0]).toContain('商業可行性 5%（可行性 v2）【已核准／確認】');   // 來源是合約＝已確認，但值不同
    expect(f.differences[0]).toContain('財務結算規則 10%（規則 v4）');
    expect(r.verdict).toBe('DIFFERENT');
    expect(r.needsManualReview).toBe(true);
    expect(r.reviewReasons.join()).toContain('團主分潤比例');
    expect(r.impact).toMatchObject({ attributedNetSales: 10_000, maxRateGapPct: 5, estimatedGap: 500, settlementConfirmed: false });
    expect(r.impact.note).toContain('不入帳');
  });

  it('已確認的結算不會被更動：影響範圍註明需另案核准；結算明細費率與目前規則不同也列入待覆核', () => {
    const r = reconcileRow(input({ feasibility: feas({ hostCommissionPct: 5 }), finance: fin({ settlement: { id: 'STI-1', status: 'CONFIRMED', ratePercent: 6, ruleVersion: 2, netSales: 10_000 } }) }), TODAY);
    expect(r.impact.settlementConfirmed).toBe(true);
    expect(r.impact.note).toContain('已確認的結算不會被更動');
    expect(r.reviewReasons.join()).toContain('結算明細使用的費率（6%，規則 v2）與目前生效規則（8%，v3）不同');
  });

  it('缺少正式合約條件：整體標示資料不足；暫估的可行性條款與財務規則都不視為已核准；仍列入待覆核', () => {
    const r = reconcileRow(input({ contract: null, feasibility: feas({ hostCommissionPct: 5 }, 'MANUAL_ESTIMATE') }), TODAY);
    expect(r.verdict).toBe('INSUFFICIENT');
    expect(r.needsManualReview).toBe(true);
    expect(r.reviewReasons.join()).toContain('缺少合約條件');
    const rate = field(r, 'ratePercent');
    expect(rate.values.find((v) => v.source === 'FEASIBILITY')).toMatchObject({ approved: false });
    expect(rate.values.find((v) => v.source === 'FEASIBILITY')!.approvalNote).toContain('暫估');
    expect(rate.values.find((v) => v.source === 'CONTRACT')).toMatchObject({ value: null });
    expect(rate.differences[0]).toContain('商業可行性 5%（可行性 v2）【未核准】');   // 其餘兩者之間的差異仍然列出
  });

  it('合約尚未核准、已過期、被新版取代、第 10 題尚未確認：都不算已核准', () => {
    for (const [o, text] of [[{ recordStatus: 'IN_REVIEW' }, '尚未核准'], [{ validUntil: '2026-10-01' }, '過期'], [{ superseded: true }, '取代'], [{ itemStatus: 'PENDING' }, '尚未確認']] as const) {
      const r = reconcileRow(input({ contract: contract(o as Partial<ContractSnap>) }), TODAY);
      expect(field(r, 'ratePercent').values.find((v) => v.source === 'CONTRACT')!.approved).toBe(false);
      expect(r.reviewReasons.join()).toContain(text);
    }
  });

  it('合約舊欄位「分潤比例」沒有標明適用對象：不當作團主分潤比例，並提示補填', () => {
    const r = reconcileRow(input({ contract: contract({ hostCommissionPct: null, legacyRatePct: 12 }) }), TODAY);
    const c = field(r, 'ratePercent').values.find((v) => v.source === 'CONTRACT')!;
    expect(c.value).toBeNull();
    expect(c.approvalNote).toContain('沒有標明適用對象');
  });

  it('分潤基礎、付款方、適用期間各自比較；財務結算的基礎固定為有效淨銷售額、沒有記錄付款方', () => {
    const r = reconcileRow(input({ contract: contract({ basis: 'GMV', hostPaidBy: 'BRAND', effectiveTo: '2026-10-31' }) }), TODAY);
    expect(field(r, 'basis')).toMatchObject({ verdict: 'DIFFERENT' });
    expect(field(r, 'paidBy')).toMatchObject({ verdict: 'DIFFERENT' });
    expect(field(r, 'paidBy').values.find((v) => v.source === 'FINANCE')).toMatchObject({ value: null, display: '未記錄' });
    expect(field(r, 'period')).toMatchObject({ verdict: 'DIFFERENT' });
    expect(r.reviewReasons.length).toBeGreaterThanOrEqual(3);
  });

  it('財務沒有這位團主的費率：結算規則欄位資料不足；不會假設任何費率', () => {
    const r = reconcileRow(input({ finance: null }), TODAY);
    const rate = field(r, 'ratePercent');
    expect(rate.values.find((v) => v.source === 'FINANCE')).toMatchObject({ value: null });
    expect(rate.insufficientReasons.join()).toContain('財務結算規則沒有');
    expect(rate.verdict).toBe('CONSISTENT');   // 合約與可行性兩者一致，財務缺資料另列
  });

  it('只有一個來源有資料：資料不足，不是一致', () => {
    const r = reconcileRow(input({ contract: null, feasibility: null, finance: fin() }), TODAY);
    expect(field(r, 'ratePercent').verdict).toBe('INSUFFICIENT');
    expect(r.verdict).toBe('INSUFFICIENT');
  });

  it('純函式、不改輸入：不覆蓋任何一方（輸入物件在比較前後完全相同）', () => {
    const i = input({ feasibility: feas({ hostCommissionPct: 5 }) });
    const before = JSON.stringify(i);
    reconcileRow(i, TODAY);
    expect(JSON.stringify(i)).toBe(before);
  });
});
