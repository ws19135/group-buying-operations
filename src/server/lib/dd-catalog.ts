import { z } from 'zod';

/**
 * 廠商首次合作盡職調查的 12 類問題目錄（SOP 02）。見 docs/phase2/PRODUCT_SELECTION_TRIAL.md §4。
 * 每類有結構化條款欄位（責任方、期限、金額、比例…），不是純勾選框；有些欄位屬敏感（分潤）。
 */
export const DD_STATUSES = ['CONFIRMED', 'PENDING_DOCS', 'NOT_APPLICABLE', 'AT_RISK'] as const;
export const RESPONSIBLE_PARTIES = ['BRAND', 'COMPANY', 'HOST', 'SHARED', 'TBD'] as const;
export const LEGAL_STATUSES = ['NOT_REQUIRED', 'REQUIRED', 'CLEARED', 'BLOCKED'] as const;
export const REGULATED_CATEGORIES = ['FOOD', 'SUPPLEMENT', 'MEDICAL_DEVICE', 'COSMETIC', 'CHILD_PRODUCT', 'OTHER_REGULATED'] as const;
export const EVIDENCE_KINDS = ['CERTIFICATE', 'TEST_REPORT', 'CONTRACT', 'QUOTE', 'PHOTO', 'VIDEO', 'LICENSE', 'LEGAL_OPINION', 'OTHER'] as const;
export type DdStatus = (typeof DD_STATUSES)[number];
export type LegalStatus = (typeof LEGAL_STATUSES)[number];

export const DD_STATUS_LABEL: Record<string, string> = { CONFIRMED: '已確認', PENDING_DOCS: '待補件', NOT_APPLICABLE: '不適用', AT_RISK: '有風險' };
export const PARTY_LABEL: Record<string, string> = { BRAND: '品牌', COMPANY: '公司', HOST: '團主', SHARED: '共同分擔', TBD: '待確認' };
export const LEGAL_LABEL: Record<string, string> = { NOT_REQUIRED: '不需法務審查', REQUIRED: '需法務／合規審查', CLEARED: '已確認無虞', BLOCKED: '法務封鎖（不得合作）' };
export const REGULATED_LABEL: Record<string, string> = { FOOD: '食品', SUPPLEMENT: '保健食品', MEDICAL_DEVICE: '醫療器材', COSMETIC: '化妝品', CHILD_PRODUCT: '兒童／嬰幼兒用品', OTHER_REGULATED: '其他受規範品類' };
export const EVIDENCE_KIND_LABEL: Record<string, string> = { CERTIFICATE: '證書／認證', TEST_REPORT: '檢驗報告', CONTRACT: '合約', QUOTE: '報價', PHOTO: '照片', VIDEO: '影片', LICENSE: '授權文件', LEGAL_OPINION: '法務意見', OTHER: '其他' };

const party = z.enum(RESPONSIBLE_PARTIES);
const money = z.number().int().min(0).max(1_000_000_000);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式需為 YYYY-MM-DD');
const txt = (n = 500) => z.string().trim().max(n);

export interface DdCategory {
  key: string; no: number; label: string; question: string;
  /** 標為「已確認」前必須至少有一筆有效證據 */
  evidenceRequired: boolean;
  /** 沒有 commission.read（或 product.cost.read）的角色看不到、也不能寫的條款欄位 */
  sensitive: string[];
  terms: z.ZodObject<z.ZodRawShape>;
}

const cat = (c: Omit<DdCategory, 'terms'> & { shape: z.ZodRawShape }): DdCategory => ({ ...c, terms: z.object(c.shape).strict() });

export const DD_CATEGORIES: DdCategory[] = [
  cat({ key: 'SOURCE_LICENSE_QA', no: 1, label: '商品來源、品牌授權與品質檢驗', question: '商品從哪來？有沒有品牌授權？有哪些品質檢驗？', evidenceRequired: true, sensitive: [],
    shape: { sourceType: z.enum(['OWN_BRAND', 'AUTHORIZED_AGENT', 'OEM', 'IMPORT', 'OTHER']).optional(), licenseHolder: txt(120).optional(), authorizationValidUntil: day.optional(), inspectionSummary: txt(500).optional() } }),
  cat({ key: 'PRICING', no: 2, label: '售價、團購價與價格條件', question: '原價、團購價、最低價與價格條件？', evidenceRequired: false, sensitive: [],
    shape: { listPrice: money.optional(), groupPrice: money.optional(), minPrice: money.optional(), priceNote: txt(500).optional() } }),
  cat({ key: 'MOQ', no: 3, label: 'MOQ（最低訂購量）與最低採購承諾', question: '最低訂購量？有沒有最低採購金額的承諾？', evidenceRequired: false, sensitive: [],
    shape: { moqQty: z.number().int().min(0).max(10_000_000).optional(), minPurchaseCommitment: money.optional(), commitmentNote: txt(500).optional() } }),
  cat({ key: 'STOCK_LEADTIME', no: 4, label: '現貨／預購與出貨交期', question: '現貨還是預購？下單後幾天出貨？', evidenceRequired: false, sensitive: [],
    shape: { stockMode: z.enum(['IN_STOCK', 'PRE_ORDER']).optional(), leadTimeDays: z.number().int().min(0).max(365).optional(), shipWindowNote: txt(500).optional() } }),
  cat({ key: 'INVENTORY_OVERSELL', no: 5, label: '庫存、缺貨與超賣機制', question: '庫存上限？缺貨怎麼通知？超賣怎麼處理？', evidenceRequired: false, sensitive: [],
    shape: { inventoryCap: z.number().int().min(0).max(100_000_000).optional(), oversellPolicy: z.enum(['BLOCK', 'BACKORDER', 'MANUAL']).optional(), stockoutNotifyHours: z.number().int().min(0).max(720).optional() } }),
  cat({ key: 'DELIVERY_METHOD', no: 6, label: '逐單代發、集貨等配送方式', question: '逐單代發、集貨，還是團主自取？', evidenceRequired: false, sensitive: [],
    shape: { method: z.enum(['DROPSHIP_PER_ORDER', 'CONSOLIDATED', 'HOST_PICKUP', 'MIXED']).optional(), carrier: txt(80).optional(), deliveryNote: txt(500).optional() } }),
  cat({ key: 'PAYMENT_LIABILITY', no: 7, label: '收款、發票與售後責任方', question: '誰收款？誰開發票？誰負責售後？', evidenceRequired: true, sensitive: [],
    shape: { collector: party.optional(), invoicer: party.optional(), afterSalesOwner: party.optional() } }),
  cat({ key: 'RETURNS_LIABILITY', no: 8, label: '退貨、瑕疵、運損、遺失與補寄責任', question: '退貨期限？瑕疵、運損、遺失、補寄各由誰負責？', evidenceRequired: true, sensitive: [],
    shape: { returnWindowDays: z.number().int().min(0).max(365).optional(), defectOwner: party.optional(), damageOwner: party.optional(), lostOwner: party.optional(), reshipOwner: party.optional() } }),
  cat({ key: 'SAMPLE_MEDIA_LICENSE', no: 9, label: '試用品、圖片與影片授權', question: '提供試用品嗎？圖片與影片能不能使用？期限與範圍？', evidenceRequired: true, sensitive: [],
    shape: { samplePolicy: txt(300).optional(), imageLicensed: z.boolean().optional(), videoLicensed: z.boolean().optional(), licenseValidUntil: day.optional(), licenseScope: txt(300).optional() } }),
  cat({ key: 'COMMISSION_TERMS', no: 10, label: '分潤基礎、比例、結算週期', question: '分潤算什麼基礎？比例？多久結算一次？', evidenceRequired: true, sensitive: ['basis', 'ratePercent', 'settlementCycleDays', 'termsNote', 'hostCommissionPct', 'hostPaidBy', 'effectiveFrom', 'effectiveTo'],
    // hostCommissionPct／hostPaidBy／effectiveFrom／effectiveTo 供「分潤口徑差異核對」（Owner 決策 K-6）比對合約、可行性與財務規則；舊欄位 ratePercent 沒有標明適用對象，核對時不當作團主分潤比例
    shape: { basis: z.enum(['NSV', 'GMV', 'OTHER']).optional(), ratePercent: z.number().min(0).max(100).optional(), settlementCycleDays: z.number().int().min(0).max(365).optional(), termsNote: txt(500).optional(),
      hostCommissionPct: z.number().min(0).max(100).optional(), hostPaidBy: z.enum(['COMPANY', 'BRAND']).optional(), effectiveFrom: day.optional(), effectiveTo: day.optional() } }),
  cat({ key: 'EXCLUSIVITY_RESALE', no: 11, label: '競業、排他、價格限制及素材條款', question: '有沒有排他或競業限制？有沒有轉售價格限制？素材使用條款？', evidenceRequired: true, sensitive: [],
    shape: { exclusive: z.boolean().optional(), exclusivityNote: txt(500).optional(), resalePriceRestriction: z.boolean().optional(), assetTerms: txt(500).optional() } }),
  cat({ key: 'CONTINGENCY', no: 12, label: '延遲出貨、缺貨與停止供應的應變', question: '延遲出貨、缺貨、停止供應時怎麼處理？', evidenceRequired: false, sensitive: [],
    shape: { delayHandling: txt(500).optional(), stockoutHandling: txt(500).optional(), supplyStopHandling: txt(500).optional() } }),
];

export const DD_KEYS = DD_CATEGORIES.map((c) => c.key);
export const ddCategory = (key: string): DdCategory | undefined => DD_CATEGORIES.find((c) => c.key === key);

/** 只驗證與保留該類別定義的欄位（多餘欄位拒絕）；回傳整理後的條款 */
export function parseTerms(key: string, raw: unknown): Record<string, unknown> {
  const c = ddCategory(key);
  if (!c) throw new Error(`未知的調查類別 ${key}`);
  return c.terms.parse(raw ?? {}) as Record<string, unknown>;
}

/** 沒有敏感欄位權限的角色看到的條款：敏感欄位移除 */
export function maskTerms(key: string, terms: Record<string, unknown>, canSeeSensitive: boolean): { terms: Record<string, unknown>; restricted: boolean } {
  const c = ddCategory(key);
  if (!c || !c.sensitive.length || canSeeSensitive) return { terms, restricted: false };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(terms)) if (!c.sensitive.includes(k)) out[k] = v;
  return { terms: out, restricted: true };
}

export function touchesSensitive(key: string, terms: Record<string, unknown>): boolean {
  const c = ddCategory(key);
  return !!c && Object.keys(terms).some((k) => c.sensitive.includes(k));
}

// ---------------- 受規範品類偵測（只提醒，不判斷合法性） ----------------
const REGULATED_KEYWORDS: [string, string[]][] = [
  ['FOOD', ['食品', '零食', '飲料', '生鮮', '肉品', '海鮮', '乾貨', '茶', '咖啡']],
  ['SUPPLEMENT', ['保健', '營養品', '益生菌', '維他命', '膠囊', '錠']],
  ['MEDICAL_DEVICE', ['醫療', '醫材', '口罩', '血壓', '血糖', '助聽', '隱形眼鏡']],
  ['COSMETIC', ['化妝', '彩妝', '面膜', '保養', '美白', '精華']],
  ['CHILD_PRODUCT', ['嬰', '幼兒', '兒童', '奶瓶', '尿布', '玩具']],
];
/** 依文字關鍵字猜測可能受規範的品類；只作提醒，會漏判也會誤判 */
export function suspectRegulated(...texts: (string | null | undefined)[]): string[] {
  const t = texts.filter(Boolean).join(' ').toLowerCase();
  return REGULATED_KEYWORDS.filter(([, kws]) => kws.some((k) => t.includes(k))).map(([c]) => c);
}

export interface LegalTrigger { required: boolean; reasons: string[] }
/** 哪些情況要標示「需法務／合規審查」：轉售價格限制、受規範品類（明示或疑似） */
export function legalTriggers(p: { categoryKey: string; terms: Record<string, unknown>; regulatedCategory: string | null; suspected: string[] }): LegalTrigger {
  const reasons: string[] = [];
  if (p.categoryKey === 'EXCLUSIVITY_RESALE' && p.terms.resalePriceRestriction === true) reasons.push('有轉售價格限制：可能涉及公平交易規範，需法務確認');
  if (p.categoryKey === 'SOURCE_LICENSE_QA') {
    if (p.regulatedCategory) reasons.push(`受規範品類（${REGULATED_LABEL[p.regulatedCategory] ?? p.regulatedCategory}）：需法務或合規確認標示、檢驗與廣告用語`);
    else if (p.suspected.length) reasons.push(`商品類別疑似受規範（${p.suspected.map((s) => REGULATED_LABEL[s] ?? s).join('、')}）：請確認並填寫受規範品類，需法務或合規審查`);
  }
  return { required: reasons.length > 0, reasons };
}

// ---------------- 證據有效性與調查準備度 ----------------
export interface EvidenceLite { id: string; validUntil: string | null }
export type EvidenceState = 'VALID' | 'EXPIRING' | 'EXPIRED' | 'NO_EXPIRY';
export function evidenceState(e: EvidenceLite, today: string, soonDays: number): EvidenceState {
  if (!e.validUntil) return 'NO_EXPIRY';
  if (e.validUntil < today) return 'EXPIRED';
  const limit = new Date(`${today}T00:00:00Z`); limit.setUTCDate(limit.getUTCDate() + soonDays);
  return e.validUntil <= limit.toISOString().slice(0, 10) ? 'EXPIRING' : 'VALID';
}

/** 條款內的有效期欄位：授權期限（第 1 題）與圖片／影片授權期限（第 9 題）。過期要擋「可送審」與「核准有效」，不只是格式檢查 */
export const DOC_DATE_FIELDS: Record<string, { field: string; label: string }> = {
  SOURCE_LICENSE_QA: { field: 'authorizationValidUntil', label: '品牌授權' },
  SAMPLE_MEDIA_LICENSE: { field: 'licenseValidUntil', label: '圖片與影片授權' },
};

export interface DdItemLite { key: string; status: string; legalStatus: string; evidence: EvidenceLite[]; terms?: Record<string, unknown> }
export interface DdItemProgress {
  key: string; no: number; label: string; status: string; legalStatus: string;
  /** 已確認但缺有效證據（要求證據的題目） */
  missingEvidence: boolean; evidenceExpired: number; evidenceExpiring: number;
  /** 條款內有效期（授權期限）；到期狀態 */
  docDate: string | null; docState: 'EXPIRED' | 'EXPIRING' | null;
}
export interface DdReadiness {
  ready: boolean; reasons: string[]; counts: Record<string, number>; expired: number; expiring: number; legalPending: number; missingEvidence: string[]; risks: number;
  /** 授權期限已過期／即將到期的文件（含題目與日期） */
  docExpired: string[]; docExpiring: string[];
  /** 12 題完成進度：已確認或不適用的題數 ÷ 12 */
  progress: { done: number; total: number };
  perItem: DdItemProgress[];
}

export function ddReadiness(items: DdItemLite[], today: string, soonDays: number): DdReadiness {
  const counts: Record<string, number> = { CONFIRMED: 0, PENDING_DOCS: 0, NOT_APPLICABLE: 0, AT_RISK: 0 };
  const reasons: string[] = [];
  const missingEvidence: string[] = [];
  const docExpired: string[] = [], docExpiring: string[] = [];
  const perItem: DdItemProgress[] = [];
  let expired = 0, expiring = 0, legalPending = 0;
  for (const it of items) {
    counts[it.status] = (counts[it.status] ?? 0) + 1;
    const c = ddCategory(it.key);
    const states = it.evidence.map((e) => evidenceState(e, today, soonDays));
    const exp = states.filter((s) => s === 'EXPIRED').length, soon = states.filter((s) => s === 'EXPIRING').length;
    expired += exp; expiring += soon;
    if (['REQUIRED', 'BLOCKED'].includes(it.legalStatus)) legalPending++;
    const missing = it.status === 'CONFIRMED' && !!c?.evidenceRequired && !states.some((x) => x !== 'EXPIRED');
    if (missing && c) missingEvidence.push(c.label);
    // 條款內的授權期限（不適用的題目不檢查）
    const dd = DOC_DATE_FIELDS[it.key];
    const raw = dd && it.status !== 'NOT_APPLICABLE' ? it.terms?.[dd.field] : undefined;
    const docDate = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
    let docState: DdItemProgress['docState'] = null;
    if (docDate && dd) {
      const st = evidenceState({ id: it.key, validUntil: docDate }, today, soonDays);
      if (st === 'EXPIRED') { docState = 'EXPIRED'; docExpired.push(`${dd.label}（${docDate}）`); }
      else if (st === 'EXPIRING') { docState = 'EXPIRING'; docExpiring.push(`${dd.label}（${docDate}）`); }
    }
    perItem.push({ key: it.key, no: c?.no ?? 0, label: c?.label ?? it.key, status: it.status, legalStatus: it.legalStatus, missingEvidence: missing, evidenceExpired: exp, evidenceExpiring: soon, docDate, docState });
  }
  perItem.sort((a, b) => a.no - b.no);
  if (items.length < DD_CATEGORIES.length) reasons.push('12 類問題尚未全部建立');
  if (counts.PENDING_DOCS) reasons.push(`${counts.PENDING_DOCS} 項待補件`);
  if (counts.AT_RISK) reasons.push(`${counts.AT_RISK} 項有風險`);
  if (expired) reasons.push(`${expired} 筆證據已過期`);
  if (docExpired.length) reasons.push(`授權期限已過期：${docExpired.join('、')}`);
  if (legalPending) reasons.push(`${legalPending} 項法務／合規審查未結案`);
  if (missingEvidence.length) reasons.push(`已確認但沒有有效證據：${missingEvidence.join('、')}`);
  return {
    ready: reasons.length === 0, reasons, counts, expired, expiring, legalPending, missingEvidence, risks: counts.AT_RISK,
    docExpired, docExpiring, progress: { done: counts.CONFIRMED + counts.NOT_APPLICABLE, total: DD_CATEGORIES.length }, perItem,
  };
}

/** 證據連結的網域白名單（空＝不限制）。比對主機名稱本身或其子網域 */
export function evidenceHostAllowed(url: string, allowed: string[]): boolean {
  if (!allowed.length) return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowed.some((a) => { const d = a.toLowerCase().replace(/^\*?\./, ''); return host === d || host.endsWith(`.${d}`); });
  } catch { return false; }
}

// ---------------- 畫面用的欄位定義（與上面的 zod 條款一一對應；由測試確保兩邊一致） ----------------
export interface UiField { name: string; label: string; type: 'text' | 'number' | 'date' | 'bool' | 'select'; options?: { value: string; label: string }[] }
const PARTY_OPTS = RESPONSIBLE_PARTIES.map((p) => ({ value: p, label: PARTY_LABEL[p] }));
export const DD_UI_FIELDS: Record<string, UiField[]> = {
  SOURCE_LICENSE_QA: [
    { name: 'sourceType', label: '商品來源', type: 'select', options: [{ value: 'OWN_BRAND', label: '自有品牌' }, { value: 'AUTHORIZED_AGENT', label: '授權代理' }, { value: 'OEM', label: '代工' }, { value: 'IMPORT', label: '進口' }, { value: 'OTHER', label: '其他' }] },
    { name: 'licenseHolder', label: '授權人／品牌方', type: 'text' }, { name: 'authorizationValidUntil', label: '授權到期日', type: 'date' }, { name: 'inspectionSummary', label: '品質檢驗摘要', type: 'text' }],
  PRICING: [{ name: 'listPrice', label: '原價', type: 'number' }, { name: 'groupPrice', label: '團購價', type: 'number' }, { name: 'minPrice', label: '最低價', type: 'number' }, { name: 'priceNote', label: '價格條件說明', type: 'text' }],
  MOQ: [{ name: 'moqQty', label: 'MOQ（最低訂購量）數量', type: 'number' }, { name: 'minPurchaseCommitment', label: '最低採購承諾金額', type: 'number' }, { name: 'commitmentNote', label: '承諾說明', type: 'text' }],
  STOCK_LEADTIME: [{ name: 'stockMode', label: '現貨／預購', type: 'select', options: [{ value: 'IN_STOCK', label: '現貨' }, { value: 'PRE_ORDER', label: '預購' }] }, { name: 'leadTimeDays', label: '出貨交期（天）', type: 'number' }, { name: 'shipWindowNote', label: '出貨時段說明', type: 'text' }],
  INVENTORY_OVERSELL: [{ name: 'inventoryCap', label: '庫存上限', type: 'number' }, { name: 'oversellPolicy', label: '超賣處理', type: 'select', options: [{ value: 'BLOCK', label: '停止下單' }, { value: 'BACKORDER', label: '轉預購' }, { value: 'MANUAL', label: '人工處理' }] }, { name: 'stockoutNotifyHours', label: '缺貨通知時限（小時）', type: 'number' }],
  DELIVERY_METHOD: [{ name: 'method', label: '配送方式', type: 'select', options: [{ value: 'DROPSHIP_PER_ORDER', label: '逐單代發' }, { value: 'CONSOLIDATED', label: '集貨' }, { value: 'HOST_PICKUP', label: '團主自取' }, { value: 'MIXED', label: '混合' }] }, { name: 'carrier', label: '物流商', type: 'text' }, { name: 'deliveryNote', label: '說明', type: 'text' }],
  PAYMENT_LIABILITY: [{ name: 'collector', label: '收款方', type: 'select', options: PARTY_OPTS }, { name: 'invoicer', label: '開發票方', type: 'select', options: PARTY_OPTS }, { name: 'afterSalesOwner', label: '售後責任方', type: 'select', options: PARTY_OPTS }],
  RETURNS_LIABILITY: [{ name: 'returnWindowDays', label: '退貨期限（天）', type: 'number' }, { name: 'defectOwner', label: '瑕疵責任方', type: 'select', options: PARTY_OPTS }, { name: 'damageOwner', label: '運損責任方', type: 'select', options: PARTY_OPTS }, { name: 'lostOwner', label: '遺失責任方', type: 'select', options: PARTY_OPTS }, { name: 'reshipOwner', label: '補寄責任方', type: 'select', options: PARTY_OPTS }],
  SAMPLE_MEDIA_LICENSE: [{ name: 'samplePolicy', label: '試用品政策', type: 'text' }, { name: 'imageLicensed', label: '圖片可使用', type: 'bool' }, { name: 'videoLicensed', label: '影片可使用', type: 'bool' }, { name: 'licenseValidUntil', label: '授權期限', type: 'date' }, { name: 'licenseScope', label: '授權範圍', type: 'text' }],
  COMMISSION_TERMS: [{ name: 'basis', label: '分潤基礎', type: 'select', options: [{ value: 'NSV', label: '有效淨銷售額' }, { value: 'GMV', label: 'GMV（成交總額）' }, { value: 'OTHER', label: '其他' }] }, { name: 'ratePercent', label: '分潤比例（%）', type: 'number' }, { name: 'settlementCycleDays', label: '結算週期（天）', type: 'number' }, { name: 'hostCommissionPct', label: '團主分潤比例（%，合約約定）', type: 'number' }, { name: 'hostPaidBy', label: '團主分潤付款方', type: 'select', options: [{ value: 'COMPANY', label: '公司' }, { value: 'BRAND', label: '品牌' }] }, { name: 'effectiveFrom', label: '分潤條件適用期間：開始', type: 'date' }, { name: 'effectiveTo', label: '分潤條件適用期間：結束', type: 'date' }, { name: 'termsNote', label: '條款說明', type: 'text' }],
  EXCLUSIVITY_RESALE: [{ name: 'exclusive', label: '有排他／競業限制', type: 'bool' }, { name: 'exclusivityNote', label: '排他說明', type: 'text' }, { name: 'resalePriceRestriction', label: '有轉售價格限制（將標示需法務審查）', type: 'bool' }, { name: 'assetTerms', label: '素材使用條款', type: 'text' }],
  CONTINGENCY: [{ name: 'delayHandling', label: '延遲出貨處理', type: 'text' }, { name: 'stockoutHandling', label: '缺貨處理', type: 'text' }, { name: 'supplyStopHandling', label: '停止供應處理', type: 'text' }],
};
