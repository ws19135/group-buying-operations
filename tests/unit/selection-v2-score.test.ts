import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMERCE_MODELS, COND_BY_ID, CONDITIONS, DEFAULT_V2_CONFIG, condsOf, effectiveThreshold, v2ConfigProblems, type V2Config } from '@/server/lib/selection-v2-catalog';
import { bandScore, manualInputProblems, maskV2Result, numberScore, scoreV2, submitProblemsV2, type AutoEntry, type ManualEntry, type V2Input } from '@/server/lib/selection-v2-score';
import { SEL_KEYS } from '@/server/lib/selection-score';

const cfg: V2Config = DEFAULT_V2_CONFIG;

/** 理想輸入：所有自動條件取理想值、人工條件全答「是」並附證據 */
function ideal(): V2Input {
  const auto: Record<string, AutoEntry> = {};
  const manual: Record<string, ManualEntry> = {};
  for (const c of CONDITIONS) {
    const t = effectiveThreshold(c, cfg, 'AGENCY');
    let v: AutoEntry['value'];
    if (c.kind === 'BOOL') v = true;
    else if (c.kind === 'ENUM') v = Object.entries(c.options!).sort((a, b) => b[1].score - a[1].score)[0][0];
    else if (c.kind === 'BAND') v = ((t!.lo as number) + (t!.hi as number)) / 2;
    else v = t!.target as number;
    if (c.source === 'AUTO' || c.source === 'EITHER') auto[c.id] = { value: v, sampleSize: 1000, sourceLabel: 'test' };
    if (c.source === 'MANUAL') manual[c.id] = { value: v, evidenceCount: 1 };
  }
  return { manual, auto, ctx: { commerceModel: 'AGENCY', regulatedSuspected: false }, compliance: { status: 'PASS' } };
}
const clone = (i: V2Input): V2Input => JSON.parse(JSON.stringify(i));

describe('V2 目錄與設定', () => {
  it('子條件編號不重複；每個維度的權重合計 100；預設設定通過驗證', () => {
    expect(new Set(CONDITIONS.map((c) => c.id)).size).toBe(CONDITIONS.length);
    for (const d of SEL_KEYS) expect(condsOf(d).reduce((a, c) => a + c.weight, 0)).toBe(100);
    expect(v2ConfigProblems(cfg)).toEqual([]);
    expect(cfg.approved).toBe(false);   // 提案設定，預設未核准
  });
  it('規格文件列出的子條件與程式目錄完全一致（避免文件與程式脫節）', () => {
    const doc = fs.readFileSync(path.join(process.cwd(), 'docs/phase2/SELECTION_V2.md'), 'utf8');
    const ids = [...doc.matchAll(/^\| `((?:NEED|QUAL|PROF|SUP|CON|REP)_[A-Z_]+)` \|/gm)].map((m) => m[1]);
    expect(ids.sort()).toEqual(CONDITIONS.map((c) => c.id).sort());
  });
  it('利潤維度的敏感條件全部由系統自動取得（營運小編不能手填）', () => {
    for (const c of CONDITIONS.filter((x) => x.sensitive)) expect(c.source).toBe('AUTO');
  });
  it('設定驗證：權重不為 100、門檻方向錯誤都會被擋', () => {
    expect(v2ConfigProblems({ ...cfg, dimWeights: { ...cfg.dimWeights, need: 30 } }).join()).toContain('合計必須是 100');
    expect(v2ConfigProblems({ ...cfg, condWeights: { NEED_FIT_SCORE: 40 } }).join()).toContain('子條件權重合計必須是 100');
    expect(v2ConfigProblems({ ...cfg, thresholds: { NEED_FIT_SCORE: { floor: 90, target: 50 } } }).join()).toContain('floor < target');
    expect(v2ConfigProblems({ ...cfg, thresholds: { QUAL_REFUND_RATE: { floor: 3, target: 15 } } }).join()).toContain('floor > target');
    expect(v2ConfigProblems({ ...cfg, thresholds: { QUAL_CERTS: { floor: 1, target: 2 } } }).join()).toContain('沒有數值門檻');
    expect(v2ConfigProblems({ ...cfg, thresholds: { NOPE: { floor: 1, target: 2 } } }).join()).toContain('未知的子條件');
  });
});

describe('V2 子條件分數公式', () => {
  it('越高越好：線性、兩端截斷', () => {
    const t = { floor: 50, target: 80 };
    expect(numberScore(80, t)).toBe(1); expect(numberScore(95, t)).toBe(1);
    expect(numberScore(50, t)).toBe(0); expect(numberScore(10, t)).toBe(0);
    expect(numberScore(65, t)).toBeCloseTo(0.5, 10);
  });
  it('越低越好：同一條線性公式反向', () => {
    const t = { floor: 15, target: 3 };
    expect(numberScore(3, t)).toBe(1); expect(numberScore(0, t)).toBe(1);
    expect(numberScore(15, t)).toBe(0); expect(numberScore(30, t)).toBe(0);
    expect(numberScore(9, t)).toBeCloseTo(0.5, 10);
  });
  it('區間型：區間內滿分，區間外按容忍度遞減', () => {
    const t = { lo: 10, hi: 35, tol: 20 };
    expect(bandScore(10, t)).toBe(1); expect(bandScore(35, t)).toBe(1); expect(bandScore(20, t)).toBe(1);
    expect(bandScore(0, t)).toBeCloseTo(0.5, 10); expect(bandScore(45, t)).toBeCloseTo(0.5, 10);
    expect(bandScore(-20, t)).toBe(0); expect(bandScore(60, t)).toBe(0);
  });
});

describe('V2 計分：完整、未知、不適用', () => {
  it('理想輸入：總分 100、完整度 100%、證據完整度 100%、建議進入商務審查', () => {
    const r = scoreV2(ideal(), cfg);
    expect(r.totalScore).toBe(100);
    expect(r.completeness).toBe(1);
    expect(r.evidenceCompleteness).toBe(1);
    expect(r.confidence).toBe('HIGH');
    expect(r.recommendation).toBe('PROCEED');
    expect(r.problems).toEqual([]);
  });
  it('未知不是 0 分：拿掉一個自動值，總分不變，完整度下降，且被列為未知', () => {
    const i = ideal(); delete i.auto.NEED_FIT_SCORE;
    const r = scoreV2(i, cfg);
    expect(r.totalScore).toBe(100);
    expect(r.completeness).toBeLessThan(1);
    expect(r.conditions.find((c) => c.id === 'NEED_FIT_SCORE')).toMatchObject({ status: 'UNKNOWN', score: null });
    expect(r.dimensions.find((d) => d.dim === 'need')!.unknownIds).toContain('NEED_FIT_SCORE');
  });
  it('整個維度未知：從總分分母排除（不當 0），完整度扣掉該維度權重', () => {
    const i = ideal();
    for (const c of condsOf('repeat')) { delete i.auto[c.id]; delete i.manual[c.id]; }
    const r = scoreV2(i, cfg);
    expect(r.totalScore).toBe(100);
    expect(r.completeness).toBeCloseTo(0.95, 3);
    expect(r.dimensions.find((d) => d.dim === 'repeat')!.score).toBeNull();
  });
  it('低分是真的低分：把退款率拉到 floor 以上 → 品質維度下降，總分下降', () => {
    const i = ideal(); i.auto.QUAL_REFUND_RATE = { value: 20, sampleSize: 1000 };
    const r = scoreV2(i, cfg);
    expect(r.conditions.find((c) => c.id === 'QUAL_REFUND_RATE')!.score).toBe(0);
    expect(r.totalScore!).toBeLessThan(100);
  });
  it('樣本數不足：視為未知而不是 0（退款率、回購率）', () => {
    const i = ideal(); i.auto.QUAL_REFUND_RATE = { value: 1, sampleSize: 5 }; i.auto.REP_REPEAT_RATE = { value: 30, sampleSize: 29 };
    const r = scoreV2(i, cfg);
    for (const id of ['QUAL_REFUND_RATE', 'REP_REPEAT_RATE']) expect(r.conditions.find((c) => c.id === id)).toMatchObject({ status: 'UNKNOWN', score: null });
    expect(r.conditions.find((c) => c.id === 'QUAL_REFUND_RATE')!.reason).toContain('樣本數不足');
  });
  it('不適用：非受規範品類、有原因、條件允許才成立；排除該權重後其餘重新計算', () => {
    const i = ideal(); i.manual.QUAL_CERTS = { na: true, naReason: '一般文具，無受規範認證' };
    const r = scoreV2(i, cfg);
    expect(r.conditions.find((c) => c.id === 'QUAL_CERTS')).toMatchObject({ status: 'NA', reason: '一般文具，無受規範認證' });
    expect(r.problems).toEqual([]);
    expect(r.dimensions.find((d) => d.dim === 'quality')!.naWeight).toBe(25);
  });
  it('不可任意不適用：沒有原因、條件不允許、或有受規範品類跡象，都被拒絕並視為未知', () => {
    let i = ideal(); i.manual.QUAL_CERTS = { na: true, naReason: '  ' };
    let r = scoreV2(i, cfg);
    expect(r.conditions.find((c) => c.id === 'QUAL_CERTS')!.status).toBe('UNKNOWN');
    expect(r.problems.join()).toContain('必須填寫原因');
    i = ideal(); i.manual.NEED_DEMAND_PROOF = { na: true, naReason: '想排除低分項目' };
    r = scoreV2(i, cfg);
    expect(r.conditions.find((c) => c.id === 'NEED_DEMAND_PROOF')!.status).toBe('UNKNOWN');
    expect(r.problems.join()).toContain('不允許選不適用');
    i = ideal(); i.ctx.regulatedSuspected = true; i.manual.QUAL_CERTS = { na: true, naReason: '應該不用' };
    r = scoreV2(i, cfg);
    expect(r.conditions.find((c) => c.id === 'QUAL_CERTS')!.status).toBe('UNKNOWN');
    expect(r.problems.join()).toContain('受規範品類跡象');
  });
  it('不適用占比超過上限：標示需覆核，可信度最高只到 MEDIUM', () => {
    const i = ideal();
    i.manual.QUAL_CERTS = { na: true, naReason: '非受規範' }; i.auto.QUAL_TEST_REPORT = undefined as never; i.manual.QUAL_TEST_REPORT = { na: true, naReason: '非受規範' };
    const r = scoreV2(i, cfg);   // 25+15 = 40% > 30%
    expect(r.naExcessiveDims).toContain('quality');
    expect(r.confidence).toBe('MEDIUM');
    expect(r.reasons.join()).toContain('不適用占比過高');
  });
});

describe('V2 硬性檢查與建議（高分不代表通過）', () => {
  it('硬性條件為「否」：不論總分一律阻擋', () => {
    const i = ideal(); i.manual.QUAL_CERTS = { value: false, evidenceCount: 1 };
    const r = scoreV2(i, cfg);
    expect(r.totalScore!).toBeGreaterThanOrEqual(80);
    expect(r.hardFails).toEqual(['QUAL_CERTS']);
    expect(r.recommendation).toBe('BLOCKED');
  });
  it('硬性條件未知：最多只能補件', () => {
    const i = ideal(); delete i.manual.QUAL_CERTS;
    const r = scoreV2(i, cfg);
    expect(r.hardUnknowns).toContain('QUAL_CERTS');
    expect(r.recommendation).toBe('SUPPLEMENT');
  });
  it('廠商調查未核准（未知）：最多只能補件；法務封鎖（否）：阻擋', () => {
    let i = ideal(); i.auto.SUP_DD_APPROVED = { value: null, unknownReason: '調查審查中' };
    let r = scoreV2(i, cfg);
    expect(r.recommendation).toBe('SUPPLEMENT'); expect(r.conditions.find((c) => c.id === 'SUP_DD_APPROVED')!.reason).toBe('調查審查中');
    i = ideal(); i.auto.SUP_DD_APPROVED = { value: false };
    r = scoreV2(i, cfg);
    expect(r.recommendation).toBe('BLOCKED');
  });
  it('合規未通過：阻擋；未查核或需法務：最多補件', () => {
    const i = ideal();
    expect(scoreV2({ ...i, compliance: { status: 'FAIL', note: 'x' } }, cfg).recommendation).toBe('BLOCKED');
    expect(scoreV2({ ...i, compliance: { status: 'UNKNOWN' } }, cfg).recommendation).toBe('SUPPLEMENT');
    expect(scoreV2({ ...i, compliance: { status: 'NEEDS_LEGAL', note: 'x' } }, cfg).recommendation).toBe('SUPPLEMENT');
  });
  it('要求證據但沒有有效證據：列為證據缺口並阻止進入商務審查', () => {
    const i = ideal(); i.manual.NEED_DEMAND_PROOF = { value: true, evidenceCount: 0 };
    const r = scoreV2(i, cfg);
    expect(r.evidenceGaps).toEqual(['NEED_DEMAND_PROOF']);
    expect(r.evidenceCompleteness).toBeLessThan(1);
    expect(r.recommendation).toBe('SUPPLEMENT');
  });
  it('資料完整度太低：資料不足；總分低：暫緩', () => {
    const i = ideal();
    for (const c of CONDITIONS) if (c.dim !== 'need') { delete i.auto[c.id]; delete i.manual[c.id]; }
    expect(scoreV2(i, cfg).recommendation).toBe('INSUFFICIENT_DATA');
    const low = ideal();
    for (const c of CONDITIONS) { const a = low.auto[c.id]; if (a && c.kind === 'BOOL') a.value = false; if (low.manual[c.id]) low.manual[c.id] = { value: false, evidenceCount: 1 }; }
    for (const c of CONDITIONS.filter((x) => x.hard)) { low.auto[c.id] = { value: null }; delete low.manual[c.id]; }
    low.auto.QUAL_REFUND_RATE = { value: 40, sampleSize: 999 };
    expect(['HOLD', 'SUPPLEMENT']).toContain(scoreV2(low, cfg).recommendation);
    expect(scoreV2(low, cfg).totalScore!).toBeLessThan(65);
    expect(scoreV2(low, cfg).recommendation).toBe('HOLD');
  });
});

describe('V2 資料來源規則', () => {
  it('AUTO 條件不接受手填（避免繞過）；計分只採用自動值', () => {
    const i = ideal(); i.manual.NEED_FIT_SCORE = { value: 100 };
    expect(manualInputProblems(i.manual).join()).toContain('由系統自動取得，不可手填');
    i.auto.NEED_FIT_SCORE = { value: 50, sampleSize: 3 };
    expect(scoreV2(i, cfg).conditions.find((c) => c.id === 'NEED_FIT_SCORE')).toMatchObject({ origin: 'AUTO', score: 0 });
  });
  it('EITHER 條件：有自動值以自動值為準；沒有才採用手填；手填且要求證據需有證據', () => {
    let i = ideal(); i.auto.QUAL_TEST_REPORT = { value: false }; i.manual.QUAL_TEST_REPORT = { value: true, evidenceCount: 1 };
    expect(scoreV2(i, cfg).conditions.find((c) => c.id === 'QUAL_TEST_REPORT')).toMatchObject({ origin: 'AUTO', score: 0 });
    i = ideal(); delete i.auto.QUAL_TEST_REPORT; i.manual.QUAL_TEST_REPORT = { value: true, evidenceCount: 0 };
    const r = scoreV2(i, cfg);
    expect(r.conditions.find((c) => c.id === 'QUAL_TEST_REPORT')).toMatchObject({ origin: 'MANUAL', evidenceOk: false });
    expect(r.evidenceGaps).toContain('QUAL_TEST_REPORT');
  });
  it('人工答案格式錯誤被擋：BOOL 要 true／false、數值要數字、選項要在目錄內', () => {
    const p = manualInputProblems({ NEED_DEMAND_PROOF: { value: 'YES' as never }, REP_CONSUMABLE: { value: 'FOREVER' }, NOPE: { value: true } });
    expect(p.join()).toContain('請選是或否'); expect(p.join()).toContain('選項不正確'); expect(p.join()).toContain('未知的子條件');
  });
});

describe('V2 商業模式的利潤口徑', () => {
  it('同一個貢獻利潤率，在不同模式下得到不同分數；沒選模式＝未知（不套預設）', () => {
    const base = ideal(); base.auto.PROF_CONTRIB_MARGIN = { value: 20 };
    const score = (m: V2Input['ctx']['commerceModel']) => { const i = clone(base); i.ctx.commerceModel = m; return scoreV2(i, cfg).conditions.find((c) => c.id === 'PROF_CONTRIB_MARGIN')!; };
    expect(score('AGENCY').score).toBeCloseTo(0.5, 5);      // 10→30
    expect(score('KOL_CPS').score).toBeCloseTo(0.25, 5);    // 15→35
    expect(score('MOM_GROUP').score).toBeCloseTo(12 / 17, 5); // 8→25
    expect(score(null)).toMatchObject({ status: 'UNKNOWN', score: null });
    expect(score(null).reason).toContain('商業模式');
    expect(COMMERCE_MODELS).toHaveLength(3);
  });
  it('折扣深度與商業模式無關（不敏感，區間型）', () => {
    const i = ideal(); i.auto.PROF_DISCOUNT_DEPTH = { value: 50 }; i.ctx.commerceModel = null;
    expect(scoreV2(i, cfg).conditions.find((c) => c.id === 'PROF_DISCOUNT_DEPTH')!.score).toBeCloseTo(0.25, 5);
  });
});

describe('V2 敏感資訊遮蔽', () => {
  it('沒有成本權限：利潤維度的子條件只剩狀態，看不到數值、分數、來源', () => {
    const i = ideal(); i.auto.PROF_CONTRIB_MARGIN = { value: 23.456, sourceLabel: '可行性試算 FSB-000001', sourceRefs: ['FSB-000001'] };
    const full = scoreV2(i, cfg);
    const masked = maskV2Result(full, false);
    for (const c of masked.conditions.filter((x) => COND_BY_ID[x.id].sensitive)) {
      expect(c.value).toBeNull(); expect(c.score).toBeNull(); expect(c.auto).toBeUndefined(); expect(c.status).toBe('KNOWN');
    }
    expect(JSON.stringify(masked)).not.toContain('23.456');
    expect(JSON.stringify(masked)).not.toContain('FSB-000001');
    expect(masked.conditions.find((c) => c.id === 'NEED_FIT_SCORE')!.score).not.toBeNull();   // 非敏感不受影響
    expect(maskV2Result(full, true)).toEqual(full);
  });
});

describe('V2 送出前檢查', () => {
  it('沒有任何已知項目、合規未說明原因時不可送出', () => {
    const empty: V2Input = { manual: {}, auto: {}, ctx: { commerceModel: null, regulatedSuspected: false }, compliance: { status: 'FAIL' } };
    const p = submitProblemsV2(empty, scoreV2(empty, cfg));
    expect(p.join()).toContain('至少要有一項已知'); expect(p.join()).toContain('合規查核未通過時');
    expect(submitProblemsV2(ideal(), scoreV2(ideal(), cfg))).toEqual([]);
  });
});
