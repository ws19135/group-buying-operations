/**
 * 客群分析的受控詞彙與關鍵字別名（SOP 01）。設計見 docs/phase2/SEGMENT_FIT.md。
 * 這裡的別名只用來「比對商品文字」，比對結果一律標為估計，並交給人工覆核。
 */
export const PARTNER_TYPES = ['GROUP_MOM', 'COMMUNITY_OWNER', 'KOL', 'OTHER'] as const;
export const AGE_BANDS = ['U25', '25_29', '30_44', '45_59', '60P'] as const;
export const FAMILY_TYPES = ['SINGLE', 'COUPLE', 'PARENTING', 'TEEN', 'MULTI_GEN', 'EMPTY_NEST', 'OTHER'] as const;
export const CYCLES = ['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'OCCASIONAL'] as const;
export const PREF_KINDS = ['MOTIVE', 'BARRIER', 'CATEGORY', 'CHANNEL'] as const;
export const CHANNELS = ['LINE', 'FACEBOOK', 'INSTAGRAM', 'THREADS', 'YOUTUBE', 'OTHER', 'OFFLINE'] as const;
export const BASES = ['FACT', 'ESTIMATE'] as const;
export const EVIDENCE_KINDS = ['OBSERVATION', 'INTERVIEW', 'SURVEY', 'ORDER_DATA', 'PLATFORM_STAT', 'OTHER'] as const;
export const REVIEW_DECISIONS = ['ACCEPTED', 'REJECTED', 'NEEDS_DATA'] as const;
export const RECOMMENDATIONS = ['RECOMMEND', 'REVIEW', 'NOT_RECOMMENDED', 'BLOCKED', 'INSUFFICIENT_DATA'] as const;
export const CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT'] as const;
export const DIM_KEYS = ['need', 'category', 'price', 'history', 'supply'] as const;

export type PartnerType = (typeof PARTNER_TYPES)[number];
export type PrefKind = (typeof PREF_KINDS)[number];
export type Basis = (typeof BASES)[number];
export type DimKey = (typeof DIM_KEYS)[number];
export type Recommendation = (typeof RECOMMENDATIONS)[number];
export type Confidence = (typeof CONFIDENCES)[number];

export const PARTNER_TYPE_LABEL: Record<string, string> = { GROUP_MOM: '團媽', COMMUNITY_OWNER: '社群主', KOL: '網紅／KOL', OTHER: '其他' };
export const AGE_BAND_LABEL: Record<string, string> = { U25: '25 歲以下', '25_29': '25–29 歲', '30_44': '30–44 歲', '45_59': '45–59 歲', '60P': '60 歲以上' };
export const FAMILY_TYPE_LABEL: Record<string, string> = { SINGLE: '單身', COUPLE: '雙人無子女', PARENTING: '育兒家庭', TEEN: '青少年家庭', MULTI_GEN: '三代同堂', EMPTY_NEST: '空巢／銀髮', OTHER: '其他' };
export const CYCLE_LABEL: Record<string, string> = { WEEKLY: '每週', BIWEEKLY: '每兩週', MONTHLY: '每月', QUARTERLY: '每季', OCCASIONAL: '不定期／節慶' };
export const PREF_KIND_LABEL: Record<string, string> = { MOTIVE: '購買動機', BARRIER: '購買阻力', CATEGORY: '偏好品類', CHANNEL: '活躍通路' };
export const CHANNEL_LABEL: Record<string, string> = { LINE: 'LINE 社群', FACEBOOK: 'Facebook', INSTAGRAM: 'Instagram', THREADS: 'Threads', YOUTUBE: 'YouTube', OTHER: '其他線上', OFFLINE: '實體據點' };
export const BASIS_LABEL: Record<string, string> = { FACT: '事實', ESTIMATE: '估計' };
export const EVIDENCE_KIND_LABEL: Record<string, string> = { OBSERVATION: '觀察紀錄', INTERVIEW: '訪談', SURVEY: '問卷', ORDER_DATA: '訂單資料', PLATFORM_STAT: '平台統計', OTHER: '其他' };
export const REVIEW_DECISION_LABEL: Record<string, string> = { ACCEPTED: '同意採用', REJECTED: '不採用', NEEDS_DATA: '需補資料' };
export const RECOMMENDATION_LABEL: Record<string, string> = { RECOMMEND: '建議合作', REVIEW: '需人工評估', NOT_RECOMMENDED: '不建議', BLOCKED: '硬性條件未過', INSUFFICIENT_DATA: '資料不足' };
export const CONFIDENCE_LABEL: Record<string, string> = { HIGH: '高', MEDIUM: '中', LOW: '低', INSUFFICIENT: '不足' };
export const DIM_LABEL: Record<string, string> = { need: '需求', category: '品類', price: '價格', history: '歷史績效', supply: '供應履約' };
export const HARD_CHECK_LABEL: Record<string, string> = { COMPLIANCE: '合規', QUALITY: '商品品質' };

/** 介面上的建議選項（可自行輸入其他值） */
export const SUGGEST_MOTIVES = ['省時間', '品質安心', '價格划算', '健康養生', '育兒需求', '嚐鮮新奇', '送禮', '環保永續', '補貨囤貨'];
export const SUGGEST_BARRIERS = ['陌生品牌', '怕踩雷', '價格敏感', '運費疑慮', '保存期限', '售後疑慮', '規格不合', '缺乏試用'];
export const SUGGEST_CATEGORIES = ['家庭清潔', '親子用品', '食品零食', '生鮮', '保健食品', '保養美妝', '居家生活', '3C', '寵物'];

export const LEXICON_VERSION = 'v1';

/** 動機：商品文字出現這些詞，視為商品回應了該動機 */
const MOTIVE_ALIASES: Record<string, string[]> = {
  省時間: ['省時', '節省時間', '快速', '方便', '一次', '懶人', '免洗', '一站'],
  品質安心: ['安心', '品質', '檢驗', '認證', '安全', '無毒', 'sgs', '食安', '嚴選'],
  價格划算: ['划算', '優惠', '特價', '組合價', 'cp值', '省錢', '便宜'],
  健康養生: ['健康', '養生', '營養', '無添加', '低糖', '保健'],
  育兒需求: ['寶寶', '嬰兒', '幼兒', '兒童', '親子', '孩子', '媽咪'],
  嚐鮮新奇: ['新品', '限定', '首創', '獨家', '新奇'],
  送禮: ['送禮', '禮盒', '禮物', '伴手禮'],
  環保永續: ['環保', '永續', '可回收', '減塑', '天然'],
  補貨囤貨: ['補貨', '囤貨', '大容量', '家庭號', '量販'],
};

/** 阻力：商品文字出現這些詞，視為商品提供了化解該阻力的依據 */
const BARRIER_ALIASES: Record<string, string[]> = {
  陌生品牌: ['認證', '檢驗', 'sgs', '保證', '試用', '品牌故事', '口碑', '實績', '評價', '大廠'],
  怕踩雷: ['試用', '試吃', '退換', '保固', '保證', '評價', '檢驗', '認證', '鑑賞期', '不滿意'],
  價格敏感: ['優惠', '特價', '組合', '划算', '免運', '折扣'],
  運費疑慮: ['免運', '包郵', '運費'],
  保存期限: ['效期', '保存', '有效期', '新鮮'],
  售後疑慮: ['保固', '退換', '客服', '售後'],
  規格不合: ['規格', '尺寸', '容量', '多種'],
  缺乏試用: ['試用', '試吃', '試喝', '體驗'],
};

const CATEGORY_ALIASES: Record<string, string[]> = {
  家庭清潔: ['清潔', '洗衣', '洗碗', '洗潔', '除菌', '消毒', '抗菌', '衛生'],
  親子用品: ['親子', '嬰幼兒', '寶寶', '兒童', '童裝', '玩具', '奶瓶', '尿布'],
  食品零食: ['食品', '零食', '餅乾', '點心', '糖果'],
  生鮮: ['生鮮', '蔬果', '肉品', '海鮮', '冷凍'],
  保健食品: ['保健', '營養品', '益生菌', '維他命', '膠囊'],
  保養美妝: ['保養', '美妝', '護膚', '面膜', '彩妝'],
  居家生活: ['居家', '收納', '家電', '廚房', '生活用品'],
  '3c': ['3c', '充電', '耳機', '手機', '藍牙'],
  寵物: ['寵物', '貓', '狗', '飼料'],
};

/** 全形轉半形、轉小寫、去空白標點，用於比對 */
export function normText(s: string | null | undefined): string {
  return (s ?? '').normalize('NFKC').toLowerCase().replace(/[\s.,，、:：;；!！?？'"“”‘’()（）[\]【】「」『』\-_/\\|]+/g, '');
}

export function aliasesOf(kind: 'MOTIVE' | 'BARRIER' | 'CATEGORY', value: string): string[] {
  const table = kind === 'MOTIVE' ? MOTIVE_ALIASES : kind === 'BARRIER' ? BARRIER_ALIASES : CATEGORY_ALIASES;
  const key = normText(value);
  for (const [k, list] of Object.entries(table)) if (normText(k) === key) return list.map(normText);
  return [];
}
