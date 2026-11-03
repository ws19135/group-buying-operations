import { SEL_KEYS, type ComplianceStatus, type SelConfidence, type SelKey, type SelRecommendation } from './selection-score';
import {
  COND_BY_ID, CONDITIONS, condsOf, effectiveThreshold, effectiveWeight, type CommerceModel, type CondDef, type Threshold, type V2Config,
} from './selection-v2-catalog';

/**
 * SOP 02 選品評分 V2 計分引擎（純函式，沒有資料庫相依）。規格見 docs/phase2/SELECTION_V2.md §3。
 * 原則：未知不是 0 分（從分母排除、降低完整度）；不適用需原因且受規則限制；硬性條件與合規獨立於總分；
 *      分數只是建議，不核准商品、不核准 G1。
 */
export type AnswerValue = boolean | number | string | null;
/** 人工答案：value 為答案；na＝不適用（需 naReason）；evidenceCount＝有效（未過期）證據數 */
export interface ManualEntry { value?: AnswerValue; na?: boolean; naReason?: string | null; evidenceCount?: number }
/** 系統自動取得的值（含來源快照）；value 為 null 代表「取不到」，unknownReason 說明原因 */
export interface AutoEntry { value: AnswerValue; unknownReason?: string | null; sourceLabel?: string; sourceRefs?: string[]; asOf?: string; sampleSize?: number | null }
export interface V2Context {
  commerceModel: CommerceModel | null;
  /** 商品或廠商調查是否有受規範品類跡象：true 時不允許對 NOT_REGULATED 規則的條件選不適用 */
  regulatedSuspected: boolean;
}
export interface V2Input {
  manual: Record<string, ManualEntry | undefined>;
  auto: Record<string, AutoEntry | undefined>;
  ctx: V2Context;
  compliance: { status: ComplianceStatus; note?: string | null };
}

export type CondStatus = 'KNOWN' | 'UNKNOWN' | 'NA';
export interface CondResult {
  id: string; dim: SelKey; status: CondStatus;
  /** 採用的答案（數值、是否、選項代碼）；未知／不適用為 null */
  value: AnswerValue;
  /** 0～1；未知／不適用為 null */
  score: number | null;
  weight: number;
  origin: 'AUTO' | 'MANUAL' | null;
  /** 為什麼是未知／不適用 */
  reason: string | null;
  /** 要求證據的條件是否已滿足（自動取得視為滿足；不要求證據＝null） */
  evidenceOk: boolean | null;
  auto?: AutoEntry;
}
export interface DimResult {
  dim: SelKey; weight: number;
  /** 0～100；整個維度未知＝null */
  score: number | null;
  completeness: number;
  applicableWeight: number; knownWeight: number; naWeight: number; naShare: number;
  unknownIds: string[];
}
export interface V2Result {
  totalScore: number | null;
  completeness: number;
  evidenceCompleteness: number;
  confidence: SelConfidence;
  recommendation: SelRecommendation;
  dimensions: DimResult[];
  conditions: CondResult[];
  evidenceGaps: string[];
  hardFails: string[];
  hardUnknowns: string[];
  naExcessiveDims: SelKey[];
  /** 輸入的問題（例如不允許的不適用）；有問題的條件視為未知 */
  problems: string[];
  reasons: string[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** 數值型分數（0～1）。thresholds 的方向由 floor／target 的大小決定 */
export function numberScore(x: number, t: Threshold): number {
  const floor = t.floor as number, target = t.target as number;
  return clamp01((x - floor) / (target - floor));   // 越高越好：floor<target；越低越好：floor>target，同一條線性公式
}
export function bandScore(x: number, t: Threshold): number {
  const lo = t.lo as number, hi = t.hi as number, tol = t.tol as number;
  if (x >= lo && x <= hi) return 1;
  const out = x < lo ? lo - x : x - hi;
  return clamp01(1 - out / tol);
}

function scoreOf(c: CondDef, v: AnswerValue, cfg: V2Config, model: CommerceModel | null): { score: number | null; unknown?: string } {
  if (c.kind === 'BOOL') return typeof v === 'boolean' ? { score: v ? 1 : 0 } : { score: null, unknown: '答案格式不正確' };
  if (c.kind === 'ENUM') {
    const o = typeof v === 'string' ? c.options?.[v] : undefined;
    return o ? { score: o.score } : { score: null, unknown: '選項不在目錄內' };
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) return { score: null, unknown: '需要數值' };
  const t = effectiveThreshold(c, cfg, model);
  if (!t) return { score: null, unknown: '請先選擇商業模式（利潤門檻依模式而不同）' };
  return { score: c.kind === 'BAND' ? bandScore(v, t) : numberScore(v, t) };
}

function resolveCond(c: CondDef, input: V2Input, cfg: V2Config, problems: string[]): CondResult {
  const base = { id: c.id, dim: c.dim, weight: effectiveWeight(c, cfg) };
  const autoRaw = input.auto[c.id];
  const manual = input.manual[c.id];
  const autoKnown = !!autoRaw && autoRaw.value != null;
  const useAuto = c.source === 'AUTO' || (c.source === 'EITHER' && autoKnown);
  const unknown = (reason: string, origin: CondResult['origin'] = null): CondResult => ({ ...base, status: 'UNKNOWN', value: null, score: null, origin, reason, evidenceOk: null, ...(autoRaw ? { auto: autoRaw } : {}) });

  if (useAuto) {
    if (!autoRaw || autoRaw.value == null) return unknown(autoRaw?.unknownReason ?? '系統找不到可用的資料', 'AUTO');
    if (c.minSampleKey) {
      const need = cfg.minSample[c.minSampleKey];
      if (autoRaw.sampleSize == null || autoRaw.sampleSize < need) return unknown(`樣本數不足（${autoRaw.sampleSize ?? 0} < ${need}）`, 'AUTO');
    }
    const s = scoreOf(c, autoRaw.value, cfg, input.ctx.commerceModel);
    if (s.score == null) return unknown(s.unknown ?? '無法計算', 'AUTO');
    return { ...base, status: 'KNOWN', value: autoRaw.value, score: s.score, origin: 'AUTO', reason: null, evidenceOk: c.evidence === 'REQUIRED' ? true : null, auto: autoRaw };
  }

  // 人工（MANUAL，或 EITHER 且沒有自動值）
  if (manual?.na) {
    if (!c.naRule) { problems.push(`「${c.label}」不允許選不適用`); return unknown('此條件不允許不適用', 'MANUAL'); }
    if (!manual.naReason?.trim()) { problems.push(`「${c.label}」選不適用時必須填寫原因`); return unknown('不適用缺少原因', 'MANUAL'); }
    if (input.ctx.regulatedSuspected) { problems.push(`「${c.label}」：商品或廠商調查有受規範品類跡象，不可選不適用`); return unknown('有受規範品類跡象，不可不適用', 'MANUAL'); }
    return { ...base, status: 'NA', value: null, score: null, origin: 'MANUAL', reason: manual.naReason.trim(), evidenceOk: null };
  }
  if (manual?.value == null) return unknown(c.source === 'EITHER' ? (autoRaw?.unknownReason ?? '系統沒有資料，請手動確認') : '尚未填寫', null);
  const s = scoreOf(c, manual.value, cfg, input.ctx.commerceModel);
  if (s.score == null) { problems.push(`「${c.label}」：${s.unknown}`); return unknown(s.unknown ?? '無法計算', 'MANUAL'); }
  const ev = c.evidence === 'REQUIRED' ? (manual.evidenceCount ?? 0) >= 1 : null;
  return { ...base, status: 'KNOWN', value: manual.value, score: s.score, origin: 'MANUAL', reason: null, evidenceOk: ev, ...(autoRaw ? { auto: autoRaw } : {}) };
}

export function scoreV2(input: V2Input, cfg: V2Config): V2Result {
  const problems: string[] = [];
  const conditions = CONDITIONS.map((c) => resolveCond(c, input, cfg, problems));
  const byDim = (d: SelKey) => conditions.filter((x) => x.dim === d);

  const dimensions: DimResult[] = SEL_KEYS.map((d) => {
    const cs = byDim(d);
    const naW = cs.filter((x) => x.status === 'NA').reduce((a, x) => a + x.weight, 0);
    const totalW = cs.reduce((a, x) => a + x.weight, 0);
    const applicable = totalW - naW;
    const known = cs.filter((x) => x.status === 'KNOWN');
    const knownW = known.reduce((a, x) => a + x.weight, 0);
    const score = knownW > 0 ? r1((100 * known.reduce((a, x) => a + x.weight * (x.score as number), 0)) / knownW) : null;
    return {
      dim: d, weight: cfg.dimWeights[d], score, completeness: applicable > 0 ? r3(knownW / applicable) : 0,
      applicableWeight: applicable, knownWeight: knownW, naWeight: naW, naShare: totalW > 0 ? r3(naW / totalW) : 0,
      unknownIds: cs.filter((x) => x.status === 'UNKNOWN').map((x) => x.id),
    };
  });

  const scored = dimensions.filter((x) => x.score != null && x.weight > 0);
  const wScored = scored.reduce((a, x) => a + x.weight, 0);
  const totalScore = wScored > 0 ? r1(scored.reduce((a, x) => a + x.weight * (x.score as number), 0) / wScored) : null;
  // 整個維度都是不適用（applicable=0）時不算在完整度的分母裡，但會被「不適用占比」旗標攔下
  const dimsForCompleteness = dimensions.filter((x) => x.weight > 0 && x.applicableWeight > 0);
  const wAll = dimsForCompleteness.reduce((a, x) => a + x.weight, 0);
  const completeness = wAll > 0 ? r3(dimsForCompleteness.reduce((a, x) => a + x.weight * x.completeness, 0) / wAll) : 0;

  const needEv = conditions.filter((x) => x.status === 'KNOWN' && COND_BY_ID[x.id].evidence === 'REQUIRED');
  const evidenceGaps = needEv.filter((x) => x.evidenceOk === false).map((x) => x.id);
  const evidenceCompleteness = needEv.length ? r3(needEv.filter((x) => x.evidenceOk).length / needEv.length) : 1;

  const hardConds = conditions.filter((x) => COND_BY_ID[x.id].hard);
  const hardFails = hardConds.filter((x) => x.status === 'KNOWN' && x.score === 0).map((x) => x.id);
  const hardUnknowns = hardConds.filter((x) => x.status === 'UNKNOWN').map((x) => x.id);
  const naExcessiveDims = dimensions.filter((x) => x.weight > 0 && x.naShare > cfg.naShareMax).map((x) => x.dim);

  let confidence: SelConfidence = completeness < cfg.minCompleteness ? 'INSUFFICIENT'
    : completeness >= cfg.highConfidence && evidenceCompleteness >= cfg.highEvidence ? 'HIGH'
    : completeness >= cfg.mediumConfidence && evidenceCompleteness >= cfg.mediumEvidence ? 'MEDIUM' : 'LOW';
  if (naExcessiveDims.length && confidence === 'HIGH') confidence = 'MEDIUM';

  const cs = input.compliance.status;
  let recommendation: SelRecommendation;
  if (cs === 'FAIL' || hardFails.length) recommendation = 'BLOCKED';
  else if (completeness < cfg.minCompleteness || totalScore == null) recommendation = 'INSUFFICIENT_DATA';
  else if (totalScore >= cfg.proceed && cs === 'PASS' && !hardUnknowns.length && confidence !== 'LOW' && confidence !== 'INSUFFICIENT' && !evidenceGaps.length) recommendation = 'PROCEED';
  else if (totalScore >= cfg.supplement) recommendation = 'SUPPLEMENT';
  else recommendation = 'HOLD';

  const label = (id: string) => COND_BY_ID[id]?.label ?? id;
  const reasons: string[] = [`總分 ${totalScore ?? '—'}，資料完整度 ${Math.round(completeness * 100)}%，證據完整度 ${Math.round(evidenceCompleteness * 100)}%`];
  if (cs === 'FAIL') reasons.push('安全與合規查核未通過：不得以總分抵銷');
  if (cs === 'UNKNOWN') reasons.push('安全與合規尚未查核：最多只能「補測／補件」');
  if (cs === 'NEEDS_LEGAL') reasons.push('安全與合規需法務或合規審查：最多只能「補測／補件」');
  if (hardFails.length) reasons.push(`硬性條件未通過（阻擋）：${hardFails.map(label).join('、')}`);
  if (hardUnknowns.length) reasons.push(`硬性條件尚未確認（最多只能補件）：${hardUnknowns.map(label).join('、')}`);
  if (evidenceGaps.length) reasons.push(`缺有效證據：${evidenceGaps.map(label).join('、')}`);
  if (naExcessiveDims.length) reasons.push(`不適用占比過高，需主管覆核：${naExcessiveDims.join('、')}`);
  const unknownAll = conditions.filter((x) => x.status === 'UNKNOWN');
  if (unknownAll.length) reasons.push(`未知（不當 0 分）：${unknownAll.length} 項`);

  return { totalScore, completeness, evidenceCompleteness, confidence, recommendation, dimensions, conditions, evidenceGaps, hardFails, hardUnknowns, naExcessiveDims, problems, reasons };
}

/** 人工輸入的格式檢查（寫入草稿時用）：AUTO 條件不可手填、答案型別正確、不適用條件需合規 */
export function manualInputProblems(manual: Record<string, ManualEntry | undefined>): string[] {
  const out: string[] = [];
  for (const [id, e] of Object.entries(manual)) {
    const c = COND_BY_ID[id];
    if (!c) { out.push(`未知的子條件 ${id}`); continue; }
    if (!e) continue;
    if (c.source === 'AUTO' && (e.value != null || e.na)) out.push(`「${c.label}」由系統自動取得，不可手填`);
    if (e.na && !c.naRule) out.push(`「${c.label}」不允許選不適用`);
    if (e.na && !e.naReason?.trim()) out.push(`「${c.label}」選不適用時必須填寫原因`);
    if (e.value != null && !e.na) {
      if (c.kind === 'BOOL' && typeof e.value !== 'boolean') out.push(`「${c.label}」請選是或否`);
      if ((c.kind === 'NUMBER' || c.kind === 'BAND') && (typeof e.value !== 'number' || !Number.isFinite(e.value))) out.push(`「${c.label}」需要數值`);
      if (c.kind === 'ENUM' && !(typeof e.value === 'string' && c.options?.[e.value])) out.push(`「${c.label}」選項不正確`);
    }
  }
  return out;
}

/** 送出前檢查：至少一項已知、合規已填、合規未通過需說明 */
export function submitProblemsV2(input: V2Input, result: V2Result): string[] {
  const out = [...result.problems];
  if (!result.conditions.some((c) => c.status === 'KNOWN')) out.push('至少要有一項已知的子條件才能送出');
  if (!input.compliance?.status) out.push('請填寫安全與合規查核結果（不確定請選「尚未查核」）');
  if (input.compliance?.status === 'FAIL' && !input.compliance.note?.trim()) out.push('合規查核未通過時，請說明原因');
  if (input.compliance?.status === 'NEEDS_LEGAL' && !input.compliance.note?.trim()) out.push('需法務或合規審查時，請說明審查範圍');
  return out;
}

/** 依權限遮蔽敏感子條件：沒有 product.cost.read 者只留狀態，看不到數值、分數與來源細節 */
export function maskV2Result(r: V2Result, canSeeSensitive: boolean): V2Result {
  if (canSeeSensitive) return r;
  return {
    ...r,
    conditions: r.conditions.map((x) => (COND_BY_ID[x.id]?.sensitive
      ? { ...x, value: null, score: null, reason: x.status === 'UNKNOWN' ? x.reason : null, auto: undefined, masked: true } as CondResult
      : x)),
  };
}

export { condsOf };
