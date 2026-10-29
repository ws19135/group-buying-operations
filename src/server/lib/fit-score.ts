import { createHash } from 'node:crypto';
import {
  aliasesOf, DIM_KEYS, DIM_LABEL, HARD_CHECK_LABEL, LEXICON_VERSION, normText, RECOMMENDATION_LABEL,
  type Basis, type Confidence, type DimKey, type PrefKind, type Recommendation,
} from './segment-vocab';

/**
 * 商品 × 團主適配評分（純函式，沒有資料庫相依，方便單元測試）。設計與規則見 docs/phase2/SEGMENT_FIT.md §4。
 *
 * 原則：
 *  1. 未知資料不當 0 分：維度資料不足就標示「未知」，總分只用已知維度重新正規化，並如實回報完整度與信心。
 *  2. 合規與商品品質是硬性檢查，不被總分抵銷。
 *  3. 每個維度都附理由、依據（事實／估計）與用到的資料，讓人工覆核能追溯。
 */
export interface FitConfig {
  version: number;
  /** 是否已由 Owner 核准；預設值是「建議值，待確認」 */
  approved: boolean;
  weights: Record<DimKey, number>;
  thresholds: { recommend: number; review: number; minCompleteness: number; highConfidence: number; mediumConfidence: number };
  minHistoryCampaigns: number;
  minShipments: number;
  lexiconVersion: string;
}

export const DEFAULT_FIT_CONFIG: FitConfig = {
  version: 1,
  approved: false,
  weights: { need: 30, category: 20, price: 15, history: 20, supply: 15 },
  thresholds: { recommend: 80, review: 65, minCompleteness: 0.5, highConfidence: 0.85, mediumConfidence: 0.6 },
  minHistoryCampaigns: 2,
  minShipments: 3,
  lexiconVersion: LEXICON_VERSION,
};

export interface SegPref { kind: PrefKind; value: string; basis: Basis }
export interface FitSegment {
  id: string; name: string;
  basis: Basis;          // 客群輪廓整體依據
  linkBasis: Basis;      // 團主↔客群連結的依據
  sharePercent: number | null;
  priceMin: number | null; priceMax: number | null;
  prefs: SegPref[];
}
export interface FitProduct {
  id: string; name: string; category: string | null;
  sellingPoints: string | null; description: string | null; complianceNote: string | null;
  reviewStatus: string; vendorStatus: string | null;
  /** 啟用中規格的團購價（不含成本） */
  skuPrices: number[];
}
export interface HistoryInput {
  scope: 'SAME_CATEGORY' | 'ALL' | 'NONE';
  hostCampaigns: number;
  hostAvgNet: number | null; hostRefundRate: number | null;
  benchRows: number; benchAvgNet: number | null; benchRefundRate: number | null;
}
export interface SupplyInput { shipments: number; exceptions: number; orders: number; cases: number }
export interface FitInput { segments: FitSegment[]; product: FitProduct; history: HistoryInput; supply: SupplyInput }

export interface DimensionResult {
  key: DimKey;
  weight: number;
  /** 1–5；null＝未知（不計分，也不是 0 分） */
  score: number | null;
  known: boolean;
  basis: Basis | null;
  reason: string;
  detail: Record<string, unknown>;
}
export type HardResult = 'PASS' | 'FAIL' | 'UNKNOWN';
export interface HardCheck { key: 'COMPLIANCE' | 'QUALITY'; result: HardResult; reason: string }
export interface FitResult {
  totalScore: number | null;
  completeness: number;
  estimateShare: number | null;
  confidence: Confidence;
  recommendation: Recommendation;
  dimensions: DimensionResult[];
  hardChecks: HardCheck[];
  reasons: string[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const combine = (...b: Basis[]): Basis => (b.every((x) => x === 'FACT') ? 'FACT' : 'ESTIMATE');

interface SegScore { id: string; name: string; score: number | null; basis: Basis; share: number | null; note: string; detail: Record<string, unknown> }

/** 多客群：各客群先算分，再依占比加權；有任一客群沒填占比就平均；未知客群不拉低分數 */
function aggregate(list: SegScore[]): { score: number | null; basis: Basis | null; reason: string; segments: SegScore[] } {
  const known = list.filter((s) => s.score != null);
  if (!known.length) return { score: null, basis: null, reason: list.length ? list.map((s) => `${s.name}：${s.note}`).join('；') : '團主尚未建立客群分析', segments: list };
  const useShare = known.every((s) => s.share != null && s.share > 0);
  const wsum = known.reduce((a, s) => a + (useShare ? (s.share as number) : 1), 0);
  const score = known.reduce((a, s) => a + (s.score as number) * (useShare ? (s.share as number) : 1), 0) / wsum;
  const basis = combine(...known.map((s) => s.basis));
  const reason = list.map((s) => `${s.name}${s.score == null ? '（未知）' : `（${r2(s.score)} 分）`}：${s.note}`).join('；');
  return { score: r2(score), basis, reason, segments: list };
}

const unknownDim = (key: DimKey, weight: number, reason: string, detail: Record<string, unknown> = {}): DimensionResult => ({ key, weight, score: null, known: false, basis: null, reason, detail });

// ---------------- 品類 ----------------
function scoreCategory(input: FitInput, weight: number): DimensionResult {
  const { product } = input;
  const cat = normText(product.category);
  const name = normText(product.name);
  const list: SegScore[] = input.segments.map((seg) => {
    const cats = seg.prefs.filter((p) => p.kind === 'CATEGORY');
    const base = { id: seg.id, name: seg.name, share: seg.sharePercent };
    if (!cats.length) return { ...base, score: null, basis: 'ESTIMATE' as Basis, note: '客群尚未填偏好品類', detail: {} };
    let best: { value: string; score: number; how: string; basis: Basis } | null = null;
    for (const p of cats) {
      const pn = normText(p.value);
      const direct = !!cat && pn.length >= 1 && (cat.includes(pn) || pn.includes(cat));
      const alias = aliasesOf('CATEGORY', p.value);
      const viaAlias = alias.some((a) => (cat && cat.includes(a)) || name.includes(a)) || (pn.length >= 2 && name.includes(pn));
      const cand = direct ? { value: p.value, score: 5, how: '商品類別直接相符', basis: p.basis } : viaAlias ? { value: p.value, score: 4, how: '以別名或商品名稱命中', basis: p.basis } : null;
      if (cand && (!best || cand.score > best.score)) best = cand;
    }
    if (best) return { ...base, score: best.score, basis: combine(seg.basis, seg.linkBasis, best.basis), note: `偏好「${best.value}」${best.how}`, detail: { matched: best.value, how: best.how } };
    if (!cat) return { ...base, score: null, basis: 'ESTIMATE' as Basis, note: '商品未填類別，且名稱未命中任何偏好品類', detail: {} };
    return { ...base, score: 1, basis: combine(seg.basis, seg.linkBasis, ...cats.map((c) => c.basis)), note: `偏好品類（${cats.map((c) => c.value).join('、')}）與商品類別「${product.category}」沒有對應`, detail: { preferences: cats.map((c) => c.value) } };
  });
  const a = aggregate(list);
  if (a.score == null) return unknownDim('category', weight, a.reason, { segments: a.segments });
  return { key: 'category', weight, score: a.score, known: true, basis: a.basis, reason: a.reason, detail: { segments: a.segments } };
}

// ---------------- 需求 ----------------
function coverageScore(c: number): number {
  return c >= 0.75 ? 5 : c >= 0.5 ? 4 : c >= 0.25 ? 3 : c > 0 ? 2 : 1;
}

function scoreNeed(input: FitInput, weight: number): DimensionResult {
  const { product } = input;
  const body = normText([product.sellingPoints, product.description, product.complianceNote].filter(Boolean).join(' '));
  if (!body) return unknownDim('need', weight, '商品尚未填寫賣點或說明，無法判斷是否回應客群需求');
  const corpus = `${body}${normText(product.name)}`;
  const list: SegScore[] = input.segments.map((seg) => {
    const motives = seg.prefs.filter((p) => p.kind === 'MOTIVE');
    const barriers = seg.prefs.filter((p) => p.kind === 'BARRIER');
    const base = { id: seg.id, name: seg.name, share: seg.sharePercent };
    if (!motives.length && !barriers.length) return { ...base, score: null, basis: 'ESTIMATE' as Basis, note: '客群尚未填購買動機與購買阻力', detail: {} };
    const hitM = motives.filter((m) => corpus.includes(normText(m.value)) || aliasesOf('MOTIVE', m.value).some((a) => corpus.includes(a)));
    const hitB = barriers.filter((b) => aliasesOf('BARRIER', b.value).some((a) => corpus.includes(a)));
    const total = motives.length + barriers.length;
    const cov = (hitM.length + hitB.length) / total;
    const missM = motives.filter((m) => !hitM.includes(m)).map((m) => m.value);
    const missB = barriers.filter((b) => !hitB.includes(b)).map((b) => b.value);
    const parts = [`動機命中 ${hitM.length}/${motives.length}`, `阻力已有化解依據 ${hitB.length}/${barriers.length}`];
    if (missM.length) parts.push(`未回應動機：${missM.join('、')}`);
    if (missB.length) parts.push(`未化解阻力：${missB.join('、')}`);
    // 需求是關鍵字比對，一律視為估計
    return { ...base, score: coverageScore(cov), basis: 'ESTIMATE' as Basis, note: parts.join('，'), detail: { motivesHit: hitM.map((m) => m.value), barriersAddressed: hitB.map((b) => b.value), motivesMissed: missM, barriersOpen: missB, coverage: r2(cov) } };
  });
  const a = aggregate(list);
  if (a.score == null) return unknownDim('need', weight, a.reason, { segments: a.segments });
  return { key: 'need', weight, score: a.score, known: true, basis: 'ESTIMATE', reason: a.reason, detail: { segments: a.segments } };
}

// ---------------- 價格 ----------------
function scorePrice(input: FitInput, weight: number): DimensionResult {
  const prices = input.product.skuPrices.filter((p) => Number.isFinite(p) && p >= 0);
  if (!prices.length) return unknownDim('price', weight, '商品沒有啟用中規格的團購價，無法比對價格帶');
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const list: SegScore[] = input.segments.map((seg) => {
    const base = { id: seg.id, name: seg.name, share: seg.sharePercent };
    if (seg.priceMin == null && seg.priceMax == null) return { ...base, score: null, basis: 'ESTIMATE' as Basis, note: '客群尚未填價格帶', detail: {} };
    const lo = seg.priceMin, hi = seg.priceMax;
    const inRange = (lo == null || avg >= lo) && (hi == null || avg <= hi);
    const near = (lo == null || avg >= lo * 0.8) && (hi == null || avg <= hi * 1.2);
    const range = `${lo ?? '不限'}–${hi ?? '不限'}`;
    const basis = combine(seg.basis, seg.linkBasis);
    if (inRange) return { ...base, score: 5, basis, note: `團購價均價 ${Math.round(avg)} 落在價格帶 ${range} 內`, detail: { avg: Math.round(avg), range } };
    if (near) return { ...base, score: 3, basis, note: `團購價均價 ${Math.round(avg)} 略超出價格帶 ${range}（20% 內）`, detail: { avg: Math.round(avg), range } };
    return { ...base, score: 1, basis, note: `團購價均價 ${Math.round(avg)} 明顯超出價格帶 ${range}`, detail: { avg: Math.round(avg), range } };
  });
  const a = aggregate(list);
  if (a.score == null) return unknownDim('price', weight, a.reason, { segments: a.segments });
  return { key: 'price', weight, score: a.score, known: true, basis: a.basis, reason: a.reason, detail: { avgPrice: Math.round(avg), segments: a.segments } };
}

// ---------------- 歷史績效 ----------------
export function bucketRatio(r: number): number {
  return r >= 1.2 ? 5 : r >= 0.9 ? 4 : r >= 0.6 ? 3 : r >= 0.3 ? 2 : 1;
}

function scoreHistory(input: FitInput, cfg: FitConfig, weight: number): DimensionResult {
  const h = input.history;
  if (h.scope === 'NONE' || h.hostAvgNet == null) return unknownDim('history', weight, `該團主已結單的檔期不足 ${cfg.minHistoryCampaigns} 檔（目前 ${h.hostCampaigns} 檔），無法評估歷史績效`, { hostCampaigns: h.hostCampaigns });
  if (h.benchAvgNet == null || h.benchAvgNet <= 0 || h.benchRows < 3) return unknownDim('history', weight, `全體比較樣本不足（${h.benchRows} 筆），沒有基準可比較`, { hostCampaigns: h.hostCampaigns, benchRows: h.benchRows });
  const ratio = h.hostAvgNet / h.benchAvgNet;
  let score = bucketRatio(ratio);
  let note = `平均每檔淨銷售為全體平均的 ${r2(ratio)} 倍（${h.hostCampaigns} 檔 vs 全體 ${h.benchRows} 筆）`;
  if (h.hostRefundRate != null && h.benchRefundRate != null && h.hostRefundRate - h.benchRefundRate >= 0.1) {
    score = Math.max(1, score - 1);
    note += `；退款率 ${Math.round(h.hostRefundRate * 100)}% 比全體高 10 個百分點以上，扣 1 分`;
  }
  const scopeNote = h.scope === 'SAME_CATEGORY' ? '同類別檔期' : '跨品類（同類別檔期不足，改用全部檔期）';
  return { key: 'history', weight, score, known: true, basis: h.scope === 'SAME_CATEGORY' ? 'FACT' : 'ESTIMATE', reason: `${scopeNote}：${note}`,
    detail: { scope: h.scope, hostCampaigns: h.hostCampaigns, ratio: r2(ratio), hostRefundRate: h.hostRefundRate, benchRefundRate: h.benchRefundRate, benchRows: h.benchRows } };
}

// ---------------- 供應履約 ----------------
export function bucketExceptionRate(r: number): number { return r <= 0.02 ? 5 : r <= 0.05 ? 4 : r <= 0.1 ? 3 : r <= 0.2 ? 2 : 1; }
export function bucketCaseRate(per100: number): number { return per100 <= 1 ? 5 : per100 <= 3 ? 4 : per100 <= 6 ? 3 : per100 <= 10 ? 2 : 1; }

function scoreSupply(input: FitInput, cfg: FitConfig, weight: number): DimensionResult {
  const s = input.supply;
  if (s.shipments < cfg.minShipments) return unknownDim('supply', weight, `廠商歷史出貨單只有 ${s.shipments} 筆（需要至少 ${cfg.minShipments} 筆），無法評估供應履約`, { shipments: s.shipments });
  const exRate = s.exceptions / s.shipments;
  const exScore = bucketExceptionRate(exRate);
  const caseRate = s.orders > 0 ? (s.cases / s.orders) * 100 : null;
  const caseScore = caseRate == null ? null : bucketCaseRate(caseRate);
  const score = caseScore == null ? exScore : Math.min(exScore, caseScore);
  const note = `出貨例外率 ${r1(exRate * 100)}%（${s.exceptions}/${s.shipments}）${caseRate == null ? '；無訂單可計算案件率' : `；每百筆訂單 ${r1(caseRate)} 件售後案件（${s.cases}/${s.orders}）`}`;
  return { key: 'supply', weight, score, known: true, basis: caseScore == null ? 'ESTIMATE' : 'FACT', reason: note, detail: { shipments: s.shipments, exceptions: s.exceptions, orders: s.orders, cases: s.cases, exceptionRate: r3(exRate), casesPer100Orders: caseRate == null ? null : r1(caseRate) } };
}

// ---------------- 硬性檢查 ----------------
export function hardChecks(product: FitProduct): HardCheck[] {
  const vendorBad = product.vendorStatus === 'BLACKLISTED' || product.vendorStatus === 'PAUSED';
  const compliance: HardCheck = vendorBad
    ? { key: 'COMPLIANCE', result: 'FAIL', reason: `廠商狀態為 ${product.vendorStatus === 'BLACKLISTED' ? '黑名單' : '暫停'}，不可合作` }
    : !product.complianceNote?.trim()
      ? { key: 'COMPLIANCE', result: 'UNKNOWN', reason: '商品尚未登錄檢驗／認證／法規備註，合規無法確認' }
      : { key: 'COMPLIANCE', result: 'PASS', reason: '已登錄檢驗／認證／法規備註（內容仍須人工審查）' };
  const quality: HardCheck = product.reviewStatus === 'REJECTED'
    ? { key: 'QUALITY', result: 'FAIL', reason: '商品審核已被退回' }
    : product.reviewStatus === 'APPROVED'
      ? { key: 'QUALITY', result: 'PASS', reason: '商品已通過審核' }
      : { key: 'QUALITY', result: 'UNKNOWN', reason: `商品尚未通過審核（目前：${product.reviewStatus}），品質無法確認` };
  return [compliance, quality];
}

// ---------------- 總評 ----------------
export function scoreFit(input: FitInput, cfg: FitConfig = DEFAULT_FIT_CONFIG): FitResult {
  const w = cfg.weights;
  const dimensions: DimensionResult[] = [
    scoreNeed(input, w.need), scoreCategory(input, w.category), scorePrice(input, w.price),
    scoreHistory(input, cfg, w.history), scoreSupply(input, cfg, w.supply),
  ];
  const checks = hardChecks(input.product);
  const wTotal = DIM_KEYS.reduce((a, k) => a + w[k], 0);
  const known = dimensions.filter((d) => d.known && d.weight > 0);
  const wKnown = known.reduce((a, d) => a + d.weight, 0);
  const completeness = wTotal > 0 ? wKnown / wTotal : 0;
  const totalScore = wKnown > 0 ? r1((100 * known.reduce((a, d) => a + d.weight * ((d.score as number) / 5), 0)) / wKnown) : null;
  const estimateShare = wKnown > 0 ? known.filter((d) => d.basis === 'ESTIMATE').reduce((a, d) => a + d.weight, 0) / wKnown : null;

  const t = cfg.thresholds;
  let confidence: Confidence;
  if (completeness < t.minCompleteness) confidence = 'INSUFFICIENT';
  else if (completeness >= t.highConfidence && (estimateShare ?? 1) <= 0.5) confidence = 'HIGH';
  else if (completeness >= t.mediumConfidence) confidence = 'MEDIUM';
  else confidence = 'LOW';

  const anyFail = checks.some((c) => c.result === 'FAIL');
  const anyHardUnknown = checks.some((c) => c.result === 'UNKNOWN');
  let recommendation: Recommendation;
  if (anyFail) recommendation = 'BLOCKED';
  else if (completeness < t.minCompleteness || totalScore == null) recommendation = 'INSUFFICIENT_DATA';
  else if (totalScore >= t.recommend && confidence !== 'LOW' && !anyHardUnknown) recommendation = 'RECOMMEND';
  else if (totalScore >= t.review) recommendation = 'REVIEW';
  else recommendation = 'NOT_RECOMMENDED';

  const reasons: string[] = [];
  reasons.push(`${RECOMMENDATION_LABEL[recommendation]}：${totalScore == null ? '無足夠資料計分' : `總分 ${totalScore}`}，資料完整度 ${Math.round(completeness * 100)}%`);
  for (const c of checks) if (c.result !== 'PASS') reasons.push(`硬性檢查「${HARD_CHECK_LABEL[c.key]}」${c.result === 'FAIL' ? '未通過' : '尚無法確認'}：${c.reason}`);
  if (anyFail && totalScore != null) reasons.push('硬性條件未過，總分僅供參考，不可用高分抵銷');
  if (!anyFail && anyHardUnknown && totalScore != null && totalScore >= t.recommend) reasons.push('分數達建議門檻，但硬性檢查尚有未知項目，降為「需人工評估」');
  for (const d of dimensions) {
    if (!d.known) reasons.push(`缺資料：${DIM_LABEL[d.key]}未計分（權重 ${d.weight}%）— ${d.reason}`);
    else reasons.push(`${DIM_LABEL[d.key]} ${r2(d.score as number)}/5（${d.basis === 'FACT' ? '事實' : '估計'}）：${d.reason}`);
  }
  return { totalScore, completeness: r3(completeness), estimateShare: estimateShare == null ? null : r3(estimateShare), confidence, recommendation, dimensions, hardChecks: checks, reasons };
}

// ---------------- 輸入雜湊（相同輸入不重複建立評估） ----------------
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** 鍵排序後的 JSON 字串，用於比較兩個物件內容是否相同（不受鍵順序影響） */
export function stableStringify(v: unknown): string {
  return JSON.stringify(stable(v));
}

export function inputHash(input: FitInput, cfg: FitConfig): string {
  const segs = [...input.segments].sort((a, b) => a.id.localeCompare(b.id)).map((s) => ({ ...s, prefs: [...s.prefs].sort((a, b) => `${a.kind}${a.value}`.localeCompare(`${b.kind}${b.value}`)) }));
  const payload = { input: { ...input, segments: segs }, weights: cfg.weights, thresholds: cfg.thresholds, minHistoryCampaigns: cfg.minHistoryCampaigns, minShipments: cfg.minShipments, lexiconVersion: cfg.lexiconVersion };
  return createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex');
}

/** 設定驗證：權重非負整數且合計 100；門檻範圍與順序 */
export function configProblems(c: Pick<FitConfig, 'weights' | 'thresholds' | 'minHistoryCampaigns' | 'minShipments'>): string[] {
  const out: string[] = [];
  const sum = DIM_KEYS.reduce((a, k) => a + (c.weights[k] ?? 0), 0);
  for (const k of DIM_KEYS) if (!Number.isInteger(c.weights[k]) || c.weights[k] < 0) out.push(`「${DIM_LABEL[k]}」權重需為 0 以上的整數`);
  if (sum !== 100) out.push(`五個維度的權重合計必須是 100（目前 ${sum}）`);
  const t = c.thresholds;
  if (!(t.review >= 0 && t.review <= t.recommend && t.recommend <= 100)) out.push('門檻需符合 0 ≤ 需人工評估門檻 ≤ 建議合作門檻 ≤ 100');
  if (!(t.minCompleteness > 0 && t.minCompleteness <= t.mediumConfidence && t.mediumConfidence <= t.highConfidence && t.highConfidence <= 1)) out.push('完整度門檻需符合 0 < 最低完整度 ≤ 中信心 ≤ 高信心 ≤ 1');
  if (!Number.isInteger(c.minHistoryCampaigns) || c.minHistoryCampaigns < 1) out.push('歷史績效最少檔期數需為 1 以上的整數');
  if (!Number.isInteger(c.minShipments) || c.minShipments < 1) out.push('供應履約最少出貨單數需為 1 以上的整數');
  return out;
}
