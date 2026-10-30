import { describe, expect, it } from 'vitest';
import { CHECK_CATALOG, checkProblems, checksForLevel, isMoreOptimistic, productFingerprint, qualificationValidity, suggestConclusion } from '@/server/lib/trial-catalog';

const ck = (result: string, defectSeverity = 'NONE', dimension = 'PRODUCT') => ({ dimension, result, defectSeverity });

describe('SOP03 試用：四大面向與檢核項', () => {
  it('四個面向都有檢核項，共 18 項、鍵不重複', () => {
    expect(new Set(CHECK_CATALOG.map((c) => c.dimension))).toEqual(new Set(['PRODUCT', 'CUSTOMER', 'CONTENT', 'BUSINESS']));
    expect(new Set(CHECK_CATALOG.map((c) => c.key)).size).toBe(CHECK_CATALOG.length);
    expect(CHECK_CATALOG).toHaveLength(18);
  });
  it('資格驗證做全部四面向；沿用資格的團主適配試用只補客戶、內容、商業三面向', () => {
    expect(checksForLevel('QUALIFICATION', true)).toHaveLength(18);
    expect(checksForLevel('HOST_FIT', false)).toHaveLength(18);
    const reuse = checksForLevel('HOST_FIT', true);
    expect(reuse.some((c) => c.dimension === 'PRODUCT')).toBe(false);
    expect(reuse).toHaveLength(12);
  });
});

describe('SOP03 試用：系統建議結論', () => {
  it('全部通過、無缺陷 → PASS', () => expect(suggestConclusion([ck('PASS'), ck('PASS', 'MINOR')]).conclusion).toBe('PASS'));
  it('有疑慮或重大缺陷 → CONDITIONAL', () => {
    expect(suggestConclusion([ck('PASS'), ck('CONCERN')]).conclusion).toBe('CONDITIONAL');
    expect(suggestConclusion([ck('PASS', 'MAJOR')]).conclusion).toBe('CONDITIONAL');
  });
  it('仍有未測 → RETEST', () => expect(suggestConclusion([ck('PASS'), ck('NOT_TESTED')]).conclusion).toBe('RETEST'));
  it('任何不通過或嚴重缺陷 → FAIL（優先於未測）', () => {
    expect(suggestConclusion([ck('FAIL'), ck('NOT_TESTED')]).conclusion).toBe('FAIL');
    expect(suggestConclusion([ck('PASS', 'CRITICAL')]).conclusion).toBe('FAIL');
  });
  it('沒有任何檢核項 → RETEST', () => expect(suggestConclusion([]).conclusion).toBe('RETEST'));
  it('最終建議不得比系統建議更樂觀（需覆寫原因）；更保守不需要', () => {
    expect(isMoreOptimistic('PASS', 'CONDITIONAL')).toBe(true);
    expect(isMoreOptimistic('CONDITIONAL', 'FAIL')).toBe(true);
    expect(isMoreOptimistic('PASS', 'RETEST')).toBe(true);
    expect(isMoreOptimistic('FAIL', 'PASS')).toBe(false);
    expect(isMoreOptimistic('PASS', 'PASS')).toBe(false);
    expect(isMoreOptimistic('RETEST', 'CONDITIONAL')).toBe(false);
  });
});

describe('SOP03 試用：檢核項規則與商品指紋', () => {
  it('通過需客觀證據；缺陷需說明；不通過需缺陷或風險說明', () => {
    expect(checkProblems({ result: 'PASS', evidenceText: '' })).toHaveLength(1);
    expect(checkProblems({ result: 'PASS', evidenceText: '開箱照 3 張' })).toEqual([]);
    expect(checkProblems({ result: 'CONCERN', defectSeverity: 'MINOR', defectNote: null })).toHaveLength(1);
    expect(checkProblems({ result: 'FAIL' })).toHaveLength(1);
    expect(checkProblems({ result: 'FAIL', riskNote: '漏液' })).toEqual([]);
  });
  const base = { name: '洗衣精', category: '家庭清潔', complianceNote: 'SGS-001', skuCodes: ['B', 'A'] };
  it('指紋與規格順序、大小寫、前後空白無關；名稱／類別／合規備註／規格編號改變則不同；價格不在內', () => {
    const f = productFingerprint(base);
    expect(productFingerprint({ ...base, skuCodes: ['a', 'b'] })).toBe(f);
    expect(productFingerprint({ ...base, name: ' 洗衣精 ' })).toBe(f);
    expect(productFingerprint({ ...base, name: '洗衣精 2.0' })).not.toBe(f);
    expect(productFingerprint({ ...base, category: '食品' })).not.toBe(f);
    expect(productFingerprint({ ...base, complianceNote: null })).not.toBe(f);
    expect(productFingerprint({ ...base, skuCodes: ['A', 'B', 'C'] })).not.toBe(f);
  });
  const q = { status: 'CONCLUDED', conclusion: 'PASS', reviewDecision: 'ACCEPTED', validUntil: '2026-12-31', basisFingerprint: 'fp1' };
  it('資格有效：通過／有條件通過、已覆核接受、未過期、指紋相同', () => {
    expect(qualificationValidity(q, 'fp1', '2026-06-01')).toEqual({ valid: true, reasons: [] });
    expect(qualificationValidity({ ...q, conclusion: 'CONDITIONAL' }, 'fp1', '2026-06-01').valid).toBe(true);
  });
  it('資格失效：過期、商品資料改變、結論不通過、尚未覆核、覆核退回、尚未結論，且每項都有原因', () => {
    expect(qualificationValidity(q, 'fp1', '2027-01-01').reasons[0]).toContain('過期');
    expect(qualificationValidity(q, 'fp1', '2026-12-31').valid).toBe(true);   // 到期日當天仍有效
    expect(qualificationValidity(q, 'fp2', '2026-06-01').reasons[0]).toContain('已變更');
    expect(qualificationValidity({ ...q, conclusion: 'FAIL' }, 'fp1', '2026-06-01').valid).toBe(false);
    expect(qualificationValidity({ ...q, conclusion: 'RETEST' }, 'fp1', '2026-06-01').valid).toBe(false);
    expect(qualificationValidity({ ...q, reviewDecision: null }, 'fp1', '2026-06-01').reasons).toContain('尚未覆核');
    expect(qualificationValidity({ ...q, reviewDecision: 'REJECTED' }, 'fp1', '2026-06-01').reasons).toContain('覆核未接受');
    expect(qualificationValidity({ ...q, status: 'OPEN', conclusion: null, reviewDecision: null }, 'fp1', '2026-06-01').valid).toBe(false);
  });
});
