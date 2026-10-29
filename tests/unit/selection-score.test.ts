import { describe, expect, it } from 'vitest';
import { DEFAULT_SELECTION_CONFIG, SEL_KEYS, scoreSelection, selectionConfigProblems, submitProblems, type SelInput, type SelKey } from '@/server/lib/selection-score';

const all = (n: number, evidence = 1): SelInput['scores'] => Object.fromEntries(SEL_KEYS.map((k) => [k, { score: n, reason: '理由', evidenceCount: evidence }])) as SelInput['scores'];
const input = (scores: SelInput['scores'], status: SelInput['compliance']['status'] = 'PASS'): SelInput => ({ scores, compliance: { status, note: null } });

describe('SOP02 選品評分：加權與門檻', () => {
  it('六項權重合計 100，預設值符合 Owner 提供的 25/25/20/15/10/5', () => {
    expect(DEFAULT_SELECTION_CONFIG.weights).toEqual({ need: 25, quality: 25, profit: 20, supply: 15, content: 10, repeat: 5 });
    expect(Object.values(DEFAULT_SELECTION_CONFIG.weights).reduce((a, b) => a + b, 0)).toBe(100);
  });
  it('全部 5 分＝100 分；全部 4 分＝80 分；全部 1 分＝20 分', () => {
    expect(scoreSelection(input(all(5))).totalScore).toBe(100);
    expect(scoreSelection(input(all(4))).totalScore).toBe(80);
    expect(scoreSelection(input(all(1))).totalScore).toBe(20);
  });
  it('加權計算：需求 5、品質 3，其餘 4 → 25*1+25*.6+20*.8+15*.8+10*.8+5*.8 = 80.0', () => {
    const s = { ...all(4), need: { score: 5, reason: 'x' }, quality: { score: 3, reason: 'x', evidenceCount: 1 } } as SelInput['scores'];
    expect(scoreSelection(input(s)).totalScore).toBe(80);
  });
  it('門檻邊界：80 分且合規通過、有證據 → PROCEED；79.x → SUPPLEMENT；65 → SUPPLEMENT；<65 → HOLD', () => {
    expect(scoreSelection(input(all(4))).recommendation).toBe('PROCEED');
    const s79 = { ...all(4), repeat: { score: 3, reason: 'x' } } as SelInput['scores'];   // 80 - 5*0.2 = 79
    expect(scoreSelection(input(s79)).totalScore).toBe(79);
    expect(scoreSelection(input(s79)).recommendation).toBe('SUPPLEMENT');
    expect(scoreSelection(input(all(3))).totalScore).toBe(60);
    expect(scoreSelection(input(all(3))).recommendation).toBe('HOLD');
    const cfg = { ...DEFAULT_SELECTION_CONFIG, thresholds: { ...DEFAULT_SELECTION_CONFIG.thresholds, supplement: 60 } };
    expect(scoreSelection(input(all(3)), cfg).recommendation).toBe('SUPPLEMENT');   // 門檻可設定
  });
});

describe('SOP02 選品評分：缺資料不當 0 分', () => {
  it('未評分的項目不計入，其餘重新正規化（只評需求與品質各 4 分 → 80，不是 40）', () => {
    const r = scoreSelection(input({ need: { score: 4, reason: 'x' }, quality: { score: 4, reason: 'x', evidenceCount: 1 } }));
    expect(r.totalScore).toBe(80);
    expect(r.completeness).toBe(0.5);
    expect(r.unknownKeys).toEqual(['profit', 'supply', 'content', 'repeat']);
  });
  it('完整度低於最低門檻 → INSUFFICIENT_DATA，即使已知項目是高分', () => {
    const r = scoreSelection(input({ need: { score: 5, reason: 'x' }, repeat: { score: 5, reason: 'x' } }));
    expect(r.completeness).toBe(0.3);
    expect(r.recommendation).toBe('INSUFFICIENT_DATA');
    expect(r.confidence).toBe('INSUFFICIENT');
  });
  it('完全沒有評分 → 分數為 null、資料不足', () => {
    const r = scoreSelection(input({}));
    expect(r.totalScore).toBeNull();
    expect(r.recommendation).toBe('INSUFFICIENT_DATA');
  });
  it('信心：完整度 ≥0.85 高、≥0.6 中、≥最低完整度 0.5 低、其餘資料不足', () => {
    const only = (keys: SelKey[]) => Object.fromEntries(keys.map((k) => [k, { score: 4, reason: 'x', evidenceCount: 1 }])) as SelInput['scores'];
    expect(scoreSelection(input(all(4))).confidence).toBe('HIGH');
    expect(scoreSelection(input(only(['need', 'quality', 'profit', 'supply', 'content']))).confidence).toBe('HIGH');   // 0.95
    expect(scoreSelection(input(only(['need', 'quality', 'profit']))).confidence).toBe('MEDIUM');                    // 0.70
    expect(scoreSelection(input(only(['need', 'quality', 'repeat']))).confidence).toBe('LOW');                       // 0.55
    expect(scoreSelection(input(only(['need', 'content']))).confidence).toBe('INSUFFICIENT');                        // 0.35
  });
});

describe('SOP02 安全與合規是獨立的必要查核，不被總分抵銷', () => {
  it('合規未通過：即使 100 分也是 BLOCKED', () => {
    const r = scoreSelection(input(all(5), 'FAIL'));
    expect(r.totalScore).toBe(100);
    expect(r.recommendation).toBe('BLOCKED');
  });
  it('合規未查核／需法務審查：最多只能 SUPPLEMENT，不能 PROCEED', () => {
    expect(scoreSelection(input(all(5), 'UNKNOWN')).recommendation).toBe('SUPPLEMENT');
    expect(scoreSelection(input(all(5), 'NEEDS_LEGAL')).recommendation).toBe('SUPPLEMENT');
  });
  it('品質或供應評了分卻沒證據：降為 SUPPLEMENT 並列出缺證據項目', () => {
    const s = { ...all(5), quality: { score: 5, reason: 'x', evidenceCount: 0 } } as SelInput['scores'];
    const r = scoreSelection(input(s));
    expect(r.evidenceGaps).toEqual(['quality']);
    expect(r.recommendation).toBe('SUPPLEMENT');
  });
  it('分數只是建議：回傳值沒有任何核准欄位', () => {
    const r = scoreSelection(input(all(5))) as unknown as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(['completeness', 'confidence', 'evidenceGaps', 'reasons', 'recommendation', 'totalScore', 'unknownKeys']);
  });
});

describe('SOP02 送出檢查與設定驗證', () => {
  it('每個評分都要有理由、分數是 1–5 整數、合規必填', () => {
    expect(submitProblems(input({ need: { score: 4, reason: '' } }))).toEqual(['「客群需求符合度」已評分，請填寫理由']);
    expect(submitProblems(input({ need: { score: 6, reason: 'x' } }))[0]).toContain('1–5');
    expect(submitProblems(input({ need: { score: 3.5, reason: 'x' } }))[0]).toContain('1–5');
    expect(submitProblems(input({ need: { score: 4, reason: 'x' } }, 'FAIL'))).toEqual(['合規查核未通過時，請說明原因']);
    expect(submitProblems(input({ need: { score: 4, reason: 'x' } }))).toEqual([]);
  });
  it('權重合計必須 100、門檻要遞增', () => {
    const base = { ...DEFAULT_SELECTION_CONFIG };
    expect(selectionConfigProblems(base)).toEqual([]);
    expect(selectionConfigProblems({ ...base, weights: { ...base.weights, need: 30 } })[0]).toContain('合計必須是 100');
    expect(selectionConfigProblems({ ...base, thresholds: { ...base.thresholds, supplement: 90 } })[0]).toContain('門檻');
    expect(selectionConfigProblems({ ...base, ddValidDays: 0 })[0]).toContain('調查有效天數');
    expect(selectionConfigProblems({ ...base, weights: { ...base.weights, need: -5, quality: 55 } }).join()).toContain('權重需為 0 以上');
  });
});
