/**
 * SOP 02 商品選品評分（純函式，沒有資料庫相依）。規則見 docs/phase2/PRODUCT_SELECTION_TRIAL.md §3。
 * 與 SOP 01（lib/fit-score.ts，商品×團主的客群適配）互不相依、互不寫入。
 *
 * 原則：每項 1–5 分、加權 100 分制；未評分＝未知（不當 0 分），只用已知項目重新正規化；
 *      安全與合規是獨立的必要查核，不被總分抵銷；分數只是建議，不核准商品或 G1。
 */
export const SEL_KEYS = ['need', 'quality', 'profit', 'supply', 'content', 'repeat'] as const;
export type SelKey = (typeof SEL_KEYS)[number];
export const SEL_LABEL: Record<SelKey, string> = { need: '客群需求符合度', quality: '商品品質與安全性', profit: '利潤與價格競爭力', supply: '供應商履約能力', content: '內容展示與說服力', repeat: '複購潛力' };
export const COMPLIANCE_STATUSES = ['PASS', 'FAIL', 'UNKNOWN', 'NEEDS_LEGAL'] as const;
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number];
export const SEL_RECOMMENDATIONS = ['PROCEED', 'SUPPLEMENT', 'HOLD', 'BLOCKED', 'INSUFFICIENT_DATA'] as const;
export type SelRecommendation = (typeof SEL_RECOMMENDATIONS)[number];
export type SelConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';

export interface SelectionConfig {
  version: number;
  /** 是否已由 Owner 核准；預設值是「建議值，待確認」 */
  approved: boolean;
  weights: Record<SelKey, number>;
  thresholds: { proceed: number; supplement: number; minCompleteness: number; highConfidence: number; mediumConfidence: number };
  /** 盡職調查核准後的有效天數 */
  ddValidDays: number;
  /** 商品資格試用結論的有效天數 */
  trialValidDays: number;
  /** 證據幾天內到期算「即將到期」 */
  expiringSoonDays: number;
  /** 證據連結的網域白名單；空＝不限制 */
  evidenceHosts: string[];
}

export const DEFAULT_SELECTION_CONFIG: SelectionConfig = {
  version: 1,
  approved: false,
  weights: { need: 25, quality: 25, profit: 20, supply: 15, content: 10, repeat: 5 },
  thresholds: { proceed: 80, supplement: 65, minCompleteness: 0.5, highConfidence: 0.85, mediumConfidence: 0.6 },
  ddValidDays: 365,
  trialValidDays: 180,
  expiringSoonDays: 30,
  evidenceHosts: [],
};

export interface SelScore { score: number | null; reason?: string | null; evidenceCount?: number }
export interface SelInput { scores: Partial<Record<SelKey, SelScore>>; compliance: { status: ComplianceStatus; note?: string | null } }
export interface SelResult {
  totalScore: number | null;
  completeness: number;
  confidence: SelConfidence;
  recommendation: SelRecommendation;
  /** 品質、供應兩項高風險項目若評了分卻沒有附證據，會在這裡列出 */
  evidenceGaps: SelKey[];
  unknownKeys: SelKey[];
  reasons: string[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** 這兩項是風險最高的評分，建議進入商務審查前必須有證據 */
export const EVIDENCE_REQUIRED_KEYS: SelKey[] = ['quality', 'supply'];

export function scoreSelection(input: SelInput, cfg: SelectionConfig = DEFAULT_SELECTION_CONFIG): SelResult {
  const w = cfg.weights;
  const wTotal = SEL_KEYS.reduce((a, k) => a + w[k], 0);
  const known = SEL_KEYS.filter((k) => w[k] > 0 && input.scores[k]?.score != null);
  const unknownKeys = SEL_KEYS.filter((k) => w[k] > 0 && input.scores[k]?.score == null);
  const wKnown = known.reduce((a, k) => a + w[k], 0);
  const completeness = wTotal > 0 ? wKnown / wTotal : 0;
  const totalScore = wKnown > 0 ? r1((100 * known.reduce((a, k) => a + w[k] * ((input.scores[k]?.score as number) / 5), 0)) / wKnown) : null;
  const t = cfg.thresholds;
  const confidence: SelConfidence = completeness < t.minCompleteness ? 'INSUFFICIENT'
    : completeness >= t.highConfidence ? 'HIGH' : completeness >= t.mediumConfidence ? 'MEDIUM' : 'LOW';
  const evidenceGaps = EVIDENCE_REQUIRED_KEYS.filter((k) => input.scores[k]?.score != null && (input.scores[k]?.evidenceCount ?? 0) < 1);
  const cs = input.compliance.status;

  let recommendation: SelRecommendation;
  if (cs === 'FAIL') recommendation = 'BLOCKED';
  else if (completeness < t.minCompleteness || totalScore == null) recommendation = 'INSUFFICIENT_DATA';
  else if (totalScore >= t.proceed && cs === 'PASS' && confidence !== 'LOW' && !evidenceGaps.length) recommendation = 'PROCEED';
  else if (totalScore >= t.supplement) recommendation = 'SUPPLEMENT';
  else recommendation = 'HOLD';

  const reasons: string[] = [];
  reasons.push(`總分 ${totalScore ?? '—'}，資料完整度 ${Math.round(completeness * 100)}%`);
  if (cs === 'FAIL') reasons.push('安全與合規查核未通過：不得以總分抵銷');
  if (cs === 'UNKNOWN') reasons.push('安全與合規尚未查核：最多只能「補測／補件」');
  if (cs === 'NEEDS_LEGAL') reasons.push('安全與合規需法務或合規審查：最多只能「補測／補件」');
  if (unknownKeys.length) reasons.push(`未評分（不當 0 分）：${unknownKeys.map((k) => SEL_LABEL[k]).join('、')}`);
  if (evidenceGaps.length) reasons.push(`缺證據：${evidenceGaps.map((k) => SEL_LABEL[k]).join('、')}（品質與供應評分需附證據才能建議進入商務審查）`);
  return { totalScore, completeness: r3(completeness), confidence, recommendation, evidenceGaps, unknownKeys, reasons };
}

/** 送出前的完整性檢查：分數需為 1–5 整數、每個評分都要有理由；安全合規必須已填 */
export function submitProblems(input: SelInput): string[] {
  const out: string[] = [];
  for (const k of SEL_KEYS) {
    const s = input.scores[k];
    if (!s || s.score == null) continue;
    if (!Number.isInteger(s.score) || s.score < 1 || s.score > 5) out.push(`「${SEL_LABEL[k]}」分數需為 1–5 的整數`);
    if (!s.reason || !s.reason.trim()) out.push(`「${SEL_LABEL[k]}」已評分，請填寫理由`);
  }
  if (!input.compliance?.status) out.push('請填寫安全與合規查核結果（不確定請選「尚未查核」）');
  if (input.compliance?.status === 'FAIL' && !input.compliance.note?.trim()) out.push('合規查核未通過時，請說明原因');
  if (input.compliance?.status === 'NEEDS_LEGAL' && !input.compliance.note?.trim()) out.push('需法務或合規審查時，請說明審查範圍');
  return out;
}

export function selectionConfigProblems(c: Pick<SelectionConfig, 'weights' | 'thresholds' | 'ddValidDays' | 'trialValidDays' | 'expiringSoonDays'>): string[] {
  const out: string[] = [];
  const sum = SEL_KEYS.reduce((a, k) => a + (c.weights[k] ?? 0), 0);
  for (const k of SEL_KEYS) if (!Number.isInteger(c.weights[k]) || c.weights[k] < 0) out.push(`「${SEL_LABEL[k]}」權重需為 0 以上的整數`);
  if (sum !== 100) out.push(`六個項目的權重合計必須是 100（目前 ${sum}）`);
  const t = c.thresholds;
  if (!(t.supplement >= 0 && t.supplement <= t.proceed && t.proceed <= 100)) out.push('門檻需符合 0 ≤ 補測門檻 ≤ 進入商務審查門檻 ≤ 100');
  if (!(t.minCompleteness > 0 && t.minCompleteness <= t.mediumConfidence && t.mediumConfidence <= t.highConfidence && t.highConfidence <= 1)) out.push('完整度門檻需符合 0 < 最低完整度 ≤ 中信心 ≤ 高信心 ≤ 1');
  for (const [k, v] of [['調查有效天數', c.ddValidDays], ['資格試用有效天數', c.trialValidDays], ['即將到期提醒天數', c.expiringSoonDays]] as const) {
    if (!Number.isInteger(v) || v < 1 || v > 3650) out.push(`${k}需為 1–3650 的整數`);
  }
  return out;
}
