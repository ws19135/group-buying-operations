import { SEL_KEYS, type SelKey } from './selection-score';

/**
 * SOP 02 選品評分 V2 的子條件目錄（版本 1）。規格見 docs/phase2/SELECTION_V2.md §6。
 * 這裡只有「定義」（純資料），沒有資料庫相依；計算在 selection-v2-score.ts，自動取值在 modules/selection-v2.ts。
 * 所有權重與門檻都是「提案，待 Owner 核准」（設定 approved=false）。
 */
export const CATALOG_VERSION = 1;
export const COMMERCE_MODELS = ['AGENCY', 'KOL_CPS', 'MOM_GROUP'] as const;
export type CommerceModel = (typeof COMMERCE_MODELS)[number];
export const COMMERCE_MODEL_LABEL: Record<CommerceModel, string> = { AGENCY: '代營運', KOL_CPS: 'KOL／KOC', MOM_GROUP: '團媽／社群主' };

export type CondKind = 'BOOL' | 'NUMBER' | 'BAND' | 'ENUM';
export type CondSource = 'AUTO' | 'MANUAL' | 'EITHER';
export type EvidenceReq = 'NONE' | 'RECOMMENDED' | 'REQUIRED';
/** 不適用規則：NOT_REGULATED＝商品與廠商調查都沒有受規範品類跡象才可選不適用 */
export type NaRule = 'NOT_REGULATED';

/** 數值型門檻。越高越好：floor<target；越低越好：floor>target；BAND：lo/hi/tol */
export interface Threshold { floor?: number; target?: number; lo?: number; hi?: number; tol?: number }

export interface CondDef {
  id: string;
  dim: SelKey;
  label: string;
  desc: string;
  kind: CondKind;
  source: CondSource;
  evidence: EvidenceReq;
  /** 維度內權重（同維度合計 100） */
  weight: number;
  /** 硬性：答案為「否」→ 阻擋；為「未知」→ 最多只能補件 */
  hard?: boolean;
  /** 敏感：沒有 product.cost.read 的角色看不到數值、分數與來源細節 */
  sensitive?: boolean;
  naRule?: NaRule;
  /** 數值型的單位標示與方向 */
  unit?: string;
  direction?: 'HIGHER' | 'LOWER';
  threshold?: Threshold;
  /** 依商業模式覆寫門檻（利潤維度） */
  modelThreshold?: Partial<Record<CommerceModel, Threshold>>;
  /** ENUM：選項→分數(0～1)與中文 */
  options?: Record<string, { label: string; score: number }>;
  /** 自動取值鍵（modules/selection-v2.ts 的 resolver） */
  autoKey?: string;
  /** 歷史統計需要的最小樣本（沒有達到＝未知） */
  minSampleKey?: 'orders' | 'buyers';
  /** 規格章節與判定說明（顯示用） */
  basis: string;
}

const B = (c: Omit<CondDef, 'kind'>): CondDef => ({ ...c, kind: 'BOOL' });

export const CONDITIONS: CondDef[] = [
  // ---- need 客群需求符合度 ----
  { id: 'NEED_FIT_SCORE', dim: 'need', label: '客群適配評估最高分', desc: 'SOP 01 現行商品適配評估的最高總分', kind: 'NUMBER', direction: 'HIGHER', unit: '分', threshold: { floor: 50, target: 80 }, source: 'AUTO', autoKey: 'fit.topScore', evidence: 'NONE', weight: 30, basis: '取 SOP 01 現行（未被取代、非檔期）評估的最高總分；無評估＝未知' },
  B({ id: 'NEED_FIT_REVIEWED', dim: 'need', label: '適配評估已有人工採用', desc: '至少一筆適配評估被覆核者採用', source: 'AUTO', autoKey: 'fit.reviewed', evidence: 'NONE', weight: 15, basis: '現行適配評估中至少一筆覆核決定為「採用」；無評估＝未知' }),
  B({ id: 'NEED_SEGMENT_MATCH', dim: 'need', label: '目標客群與團主社群有明確交集', desc: '人工判斷；建議附客群研究連結', source: 'MANUAL', evidence: 'RECOMMENDED', weight: 20, basis: '人工判斷' }),
  B({ id: 'NEED_PRICE_ACCEPTABLE', dim: 'need', label: '團購價落在目標客群可接受價格帶', desc: '對照客群的價格區間', source: 'MANUAL', evidence: 'RECOMMENDED', weight: 15, basis: '人工對照客群價格區間' }),
  B({ id: 'NEED_DEMAND_PROOF', dim: 'need', label: '有需求佐證', desc: '社群詢問、投票、搜尋量等', source: 'MANUAL', evidence: 'REQUIRED', weight: 20, basis: '人工；要求證據' }),

  // ---- quality 商品品質與安全性 ----
  B({ id: 'QUAL_CERTS', dim: 'quality', label: '必要認證與登記齊全', desc: '受規範品類（食品、保健、醫材、化妝品、兒童用品…）必須有認證或登記', source: 'MANUAL', evidence: 'REQUIRED', weight: 25, hard: true, naRule: 'NOT_REGULATED', basis: '硬性條件：「否」→ 阻擋；非受規範品類才可不適用' }),
  B({ id: 'QUAL_TEST_REPORT', dim: 'quality', label: '檢驗報告有效', desc: '廠商調查第 1 題掛有未過期的檢驗報告或證書', source: 'EITHER', autoKey: 'dd.testReport', evidence: 'REQUIRED', weight: 15, naRule: 'NOT_REGULATED', basis: '自動：調查第 1 題有未過期的檢驗／證書證據＝是；否則可手填並附證據' }),
  { id: 'QUAL_DD_RISK', dim: 'quality', label: '廠商調查中「有風險」的題數', desc: '廠商現行調查狀態為「有風險」的題數', kind: 'NUMBER', direction: 'LOWER', unit: '題', threshold: { floor: 3, target: 0 }, source: 'AUTO', autoKey: 'dd.atRisk', evidence: 'NONE', weight: 15, basis: '無調查＝未知' },
  { id: 'QUAL_TRIAL', dim: 'quality', label: '商品資格試用結論', desc: '最新已結論的資格試用', kind: 'ENUM', source: 'AUTO', autoKey: 'trial.conclusion', evidence: 'NONE', weight: 20,
    options: { PASS: { label: '通過', score: 1 }, CONDITIONAL: { label: '有條件通過', score: 0.5 }, FAIL: { label: '未通過', score: 0 } }, basis: '無試用＝未知' },
  { id: 'QUAL_REFUND_RATE', dim: 'quality', label: '歷史退款率', desc: '該商品歷史有效訂單中有退款的比例', kind: 'NUMBER', direction: 'LOWER', unit: '%', threshold: { floor: 15, target: 3 }, source: 'AUTO', autoKey: 'history.refundRate', minSampleKey: 'orders', evidence: 'NONE', weight: 15, basis: '樣本數小於最小樣本＝未知' },
  { id: 'QUAL_COMPLAINT_RATE', dim: 'quality', label: '歷史客訴率（每百單）', desc: '該商品相關客服案件數 ÷ 訂單數 × 100', kind: 'NUMBER', direction: 'LOWER', unit: '件／百單', threshold: { floor: 10, target: 2 }, source: 'AUTO', autoKey: 'history.complaintRate', minSampleKey: 'orders', evidence: 'NONE', weight: 10, basis: '樣本不足＝未知' },

  // ---- profit 利潤與價格競爭力（依商業模式；除折扣深度外皆敏感、皆自動）----
  { id: 'PROF_CONTRIB_MARGIN', dim: 'profit', label: '貢獻利潤率（可行性試算）', desc: '公司貢獻利潤 ÷ 公司營業收入（biz-model 04 §2.2 口徑，讀取 SOP 03 試算結果）', kind: 'NUMBER', direction: 'HIGHER', unit: '%', source: 'AUTO', autoKey: 'feas.contributionMarginPct', evidence: 'NONE', weight: 30, sensitive: true,
    modelThreshold: { AGENCY: { floor: 10, target: 30 }, KOL_CPS: { floor: 15, target: 35 }, MOM_GROUP: { floor: 8, target: 25 } }, basis: '商品最新可行性試算；無試算＝未知；依商業模式的門檻判定' },
  { id: 'PROF_TAKE_RATE', dim: 'profit', label: '抽成率（可行性試算）', desc: '公司營業收入 ÷ 有效淨銷售額', kind: 'NUMBER', direction: 'HIGHER', unit: '%', source: 'AUTO', autoKey: 'feas.takeRatePct', evidence: 'NONE', weight: 15, sensitive: true,
    modelThreshold: { AGENCY: { floor: 5, target: 15 }, KOL_CPS: { floor: 8, target: 20 }, MOM_GROUP: { floor: 5, target: 15 } }, basis: '同上' },
  B({ id: 'PROF_CONTRIB_POSITIVE', dim: 'profit', label: '公司貢獻利潤為正', desc: '可行性試算的公司貢獻利潤 > 0', source: 'AUTO', autoKey: 'feas.contribPositive', evidence: 'NONE', weight: 15, sensitive: true, basis: '無試算＝未知' }),
  { id: 'PROF_SCENARIO_BASIS', dim: 'profit', label: '試算假設的可靠度', desc: '試算各輸入的來源，取最不可靠的一項', kind: 'ENUM', source: 'AUTO', autoKey: 'feas.basis', evidence: 'NONE', weight: 10, sensitive: true,
    options: { RELIABLE: { label: '合約／試用實際', score: 1 }, QUOTED: { label: '廠商報價／歷史資料', score: 0.7 }, ESTIMATE: { label: '人工估計', score: 0.3 } }, basis: '無試算＝未知' },
  { id: 'PROF_GROSS_MARGIN', dim: 'profit', label: 'SKU 毛利率（參考）', desc: '(團購價 − 成本價) ÷ 團購價，取啟用中 SKU 的最低值；不含分潤與費用', kind: 'NUMBER', direction: 'HIGHER', unit: '%', source: 'AUTO', autoKey: 'sku.grossMargin', evidence: 'NONE', weight: 15, sensitive: true,
    modelThreshold: { AGENCY: { floor: 15, target: 40 }, KOL_CPS: { floor: 20, target: 45 }, MOM_GROUP: { floor: 15, target: 40 } }, basis: '缺價格或成本＝未知' },
  { id: 'PROF_DISCOUNT_DEPTH', dim: 'profit', label: '團購價相對原價的折扣深度', desc: '1 − 團購價 ÷ 原價；最佳區間內最好', kind: 'BAND', unit: '%', threshold: { lo: 10, hi: 35, tol: 20 }, source: 'AUTO', autoKey: 'sku.discountDepth', evidence: 'NONE', weight: 15, basis: '原價與團購價不屬敏感資料；缺價格＝未知' },

  // ---- supply 供應商履約能力 ----
  B({ id: 'SUP_DD_APPROVED', dim: 'supply', label: '廠商合作資格審查已核准且在有效期內', desc: '廠商最新調查已核准、未過期；含法務封鎖項＝否', source: 'AUTO', autoKey: 'dd.approved', evidence: 'NONE', weight: 25, hard: true, basis: '硬性：草稿／審查中／已過期＝未知（最多補件）；法務封鎖＝否（阻擋）' }),
  { id: 'SUP_DD_COMPLETE', dim: 'supply', label: '12 題完成度', desc: '調查 12 題中「已確認」或「不適用」的比例', kind: 'NUMBER', direction: 'HIGHER', unit: '%', threshold: { floor: 50, target: 100 }, source: 'AUTO', autoKey: 'dd.complete', evidence: 'NONE', weight: 15, basis: '無調查＝未知' },
  { id: 'SUP_LEAD_TIME', dim: 'supply', label: '出貨交期', desc: '調查第 4 題的下單到出貨天數', kind: 'NUMBER', direction: 'LOWER', unit: '天', threshold: { floor: 14, target: 3 }, source: 'AUTO', autoKey: 'dd.leadTime', evidence: 'NONE', weight: 15, basis: '未填＝未知' },
  { id: 'SUP_ONTIME_SHIP', dim: 'supply', label: '歷史準時出貨率', desc: '該廠商歷史出貨單中，出貨日不晚於預計出貨日的比例', kind: 'NUMBER', direction: 'HIGHER', unit: '%', threshold: { floor: 80, target: 95 }, source: 'AUTO', autoKey: 'history.onTimeShip', minSampleKey: 'orders', evidence: 'NONE', weight: 20, basis: '樣本不足＝未知' },
  B({ id: 'SUP_STOCK_POLICY', dim: 'supply', label: '有庫存與超賣處理機制', desc: '調查第 5 題已確認', source: 'AUTO', autoKey: 'dd.stockPolicy', evidence: 'NONE', weight: 10, basis: '已確認＝是；其餘未知' }),
  B({ id: 'SUP_RETURNS_CLEAR', dim: 'supply', label: '退貨與售後責任已明確', desc: '調查第 7、8 題皆已確認', source: 'AUTO', autoKey: 'dd.returnsClear', evidence: 'NONE', weight: 15, basis: '皆已確認＝是；其餘未知' }),

  // ---- content 內容展示與說服力 ----
  B({ id: 'CON_MEDIA_LICENSED', dim: 'content', label: '圖片與影片已授權且未過期', desc: '調查第 9 題圖片與影片皆授權，授權期限未過', source: 'AUTO', autoKey: 'dd.mediaLicensed', evidence: 'NONE', weight: 35, basis: '未填＝未知；授權期限已過＝否' }),
  B({ id: 'CON_SAMPLE_READY', dim: 'content', label: '可提供試用品', desc: '調查第 9 題有試用品政策或已有試用紀錄；否則手填', source: 'EITHER', autoKey: 'dd.sampleReady', evidence: 'RECOMMENDED', weight: 20, basis: '自動優先；無自動值才可手填' }),
  B({ id: 'CON_USP_CLEAR', dim: 'content', label: '賣點能用一句話說清楚且有素材', desc: '人工；建議附素材連結', source: 'MANUAL', evidence: 'RECOMMENDED', weight: 25, basis: '人工' }),
  B({ id: 'CON_CLAIM_VERIFIED', dim: 'content', label: '廣告宣稱已逐項有佐證', desc: '人工；要求證據', source: 'MANUAL', evidence: 'REQUIRED', weight: 20, naRule: 'NOT_REGULATED', basis: '非受規範品類且無功效宣稱才可不適用' }),

  // ---- repeat 複購潛力 ----
  { id: 'REP_CONSUMABLE', dim: 'repeat', label: '消耗性程度', desc: '商品使用後是否需要再買', kind: 'ENUM', source: 'MANUAL', evidence: 'NONE', weight: 30,
    options: { CONSUMABLE: { label: '消耗品', score: 1 }, SEMI: { label: '半耐久', score: 0.6 }, DURABLE: { label: '耐久品', score: 0.2 } }, basis: '人工' },
  { id: 'REP_REPEAT_RATE', dim: 'repeat', label: '可辨識客戶的回購率', desc: '有買家代碼的買家中，在 2 個以上不同檔期購買的比例', kind: 'NUMBER', direction: 'HIGHER', unit: '%', threshold: { floor: 5, target: 25 }, source: 'AUTO', autoKey: 'history.repeatRate', minSampleKey: 'buyers', evidence: 'NONE', weight: 50, basis: '買家代碼不是個資；有買家代碼的買家數不足＝未知' },
  B({ id: 'REP_SUPPLY_CONTINUITY', dim: 'repeat', label: '廠商可長期穩定供貨', desc: '調查第 12 題已確認', source: 'AUTO', autoKey: 'dd.continuity', evidence: 'NONE', weight: 20, basis: '已確認＝是；其餘未知' }),
];

export const COND_BY_ID: Record<string, CondDef> = Object.fromEntries(CONDITIONS.map((c) => [c.id, c]));
export const condsOf = (dim: SelKey): CondDef[] => CONDITIONS.filter((c) => c.dim === dim);

/** 預設提案設定（approved=false）。權重沿用 V1 的建議值，門檻為提案 */
export interface V2Config {
  version: number;
  approved: boolean;
  /** false＝停用 V2：新評估改建 V1（既有 V2 評估仍可閱讀） */
  enabled: boolean;
  dimWeights: Record<SelKey, number>;
  /** 覆寫子條件權重（維度內合計需 100）；未列出者用目錄預設 */
  condWeights: Record<string, number>;
  /** 覆寫子條件門檻（含各商業模式）；未列出者用目錄預設 */
  thresholds: Record<string, Threshold>;
  modelThresholds: Record<string, Partial<Record<CommerceModel, Threshold>>>;
  proceed: number; supplement: number; minCompleteness: number; highConfidence: number; mediumConfidence: number;
  /** 證據完整度門檻：HIGH 需 ≥ highEvidence，MEDIUM 需 ≥ mediumEvidence */
  highEvidence: number; mediumEvidence: number;
  /** 不適用權重占維度權重的上限，超過標示需覆核並把可信度壓到 MEDIUM 以下 */
  naShareMax: number;
  minSample: { orders: number; buyers: number };
}

export const DEFAULT_V2_CONFIG: V2Config = {
  version: 1,
  approved: false,
  enabled: true,
  dimWeights: { need: 25, quality: 25, profit: 20, supply: 15, content: 10, repeat: 5 },
  condWeights: {},
  thresholds: {},
  modelThresholds: {},
  proceed: 80, supplement: 65, minCompleteness: 0.5, highConfidence: 0.85, mediumConfidence: 0.6,
  highEvidence: 0.8, mediumEvidence: 0.5,
  naShareMax: 0.3,
  minSample: { orders: 30, buyers: 30 },
};

export function effectiveWeight(c: CondDef, cfg: V2Config): number { return cfg.condWeights[c.id] ?? c.weight; }
export function effectiveThreshold(c: CondDef, cfg: V2Config, model: CommerceModel | null): Threshold | null {
  const m = model ? (cfg.modelThresholds[c.id]?.[model] ?? c.modelThreshold?.[model]) : undefined;
  if (c.modelThreshold && !m) return null;   // 需要商業模式才能判定
  return m ?? cfg.thresholds[c.id] ?? c.threshold ?? null;
}

/** 設定驗證：維度權重合計 100、各維度內子條件權重合計 100、門檻方向正確、比例在範圍內 */
export function v2ConfigProblems(cfg: V2Config): string[] {
  const out: string[] = [];
  const sum = SEL_KEYS.reduce((a, k) => a + (cfg.dimWeights[k] ?? 0), 0);
  for (const k of SEL_KEYS) if (!Number.isInteger(cfg.dimWeights[k]) || cfg.dimWeights[k] < 0) out.push(`維度「${k}」權重需為 0 以上的整數`);
  if (sum !== 100) out.push(`六個維度的權重合計必須是 100（目前 ${sum}）`);
  for (const k of SEL_KEYS) {
    const s = condsOf(k).reduce((a, c) => a + effectiveWeight(c, cfg), 0);
    if (s !== 100) out.push(`維度「${k}」內的子條件權重合計必須是 100（目前 ${s}）`);
  }
  for (const id of Object.keys(cfg.condWeights)) if (!COND_BY_ID[id]) out.push(`未知的子條件 ${id}`);
  for (const [id, t] of Object.entries(cfg.thresholds)) {
    const c = COND_BY_ID[id];
    if (!c) { out.push(`未知的子條件 ${id}`); continue; }
    const p = thresholdProblem(c, t);
    if (p) out.push(`${id}：${p}`);
  }
  for (const [id, byModel] of Object.entries(cfg.modelThresholds)) {
    const c = COND_BY_ID[id];
    if (!c) { out.push(`未知的子條件 ${id}`); continue; }
    for (const [m, t] of Object.entries(byModel)) { const p = t ? thresholdProblem(c, t) : null; if (p) out.push(`${id}（${m}）：${p}`); }
  }
  if (!(cfg.supplement >= 0 && cfg.supplement <= cfg.proceed && cfg.proceed <= 100)) out.push('門檻需符合 0 ≤ 補測門檻 ≤ 進入商務審查門檻 ≤ 100');
  if (!(cfg.minCompleteness > 0 && cfg.minCompleteness <= cfg.mediumConfidence && cfg.mediumConfidence <= cfg.highConfidence && cfg.highConfidence <= 1)) out.push('完整度門檻需符合 0 < 最低 ≤ 中 ≤ 高 ≤ 1');
  if (!(cfg.mediumEvidence >= 0 && cfg.mediumEvidence <= cfg.highEvidence && cfg.highEvidence <= 1)) out.push('證據完整度門檻需符合 0 ≤ 中 ≤ 高 ≤ 1');
  if (!(cfg.naShareMax >= 0 && cfg.naShareMax <= 1)) out.push('不適用占比上限需在 0～1');
  for (const k of ['orders', 'buyers'] as const) if (!Number.isInteger(cfg.minSample[k]) || cfg.minSample[k] < 1) out.push(`最小樣本（${k}）需為 1 以上的整數`);
  return out;
}

function thresholdProblem(c: CondDef, t: Threshold): string | null {
  if (c.kind === 'NUMBER') {
    if (t.floor == null || t.target == null) return '需要 floor 與 target';
    if (t.floor === t.target) return 'floor 與 target 不可相同';
    if (c.direction === 'HIGHER' && !(t.floor < t.target)) return '越高越好的條件需 floor < target';
    if (c.direction === 'LOWER' && !(t.floor > t.target)) return '越低越好的條件需 floor > target';
    return null;
  }
  if (c.kind === 'BAND') {
    if (t.lo == null || t.hi == null || t.tol == null) return '需要 lo、hi 與 tol';
    if (!(t.lo <= t.hi)) return 'lo 需 ≤ hi';
    if (!(t.tol > 0)) return 'tol 需 > 0';
    return null;
  }
  return '此條件沒有數值門檻';
}
