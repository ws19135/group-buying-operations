/**
 * 小規模測試團的觸及與導購資料（Owner 決策 K-2；純規則，沒有資料庫相依）。三種資料各自獨立，不可互相替代：
 *   潛在觸及人數＝團主社群規模（例如 LINE 群組成員數）；實際觸及人數＝平台提供的貼文觸及；有效導購訪客＝有可信來源的不重複導購訪客。
 * 真正的導購轉換率 CVR＝有效成交訂單數 ÷ 有效導購訪客數：只有「有效導購訪客」可以當分母，群組人數與觸及人數都不行。
 */
export const REACH_METRICS = ['POTENTIAL_REACH', 'ACTUAL_REACH', 'QUALIFIED_VISITORS'] as const;
export type ReachMetric = (typeof REACH_METRICS)[number];
export const REACH_METRIC_LABEL: Record<ReachMetric, string> = { POTENTIAL_REACH: '潛在觸及人數', ACTUAL_REACH: '實際觸及人數', QUALIFIED_VISITORS: '有效導購訪客' };
export const REACH_METRIC_HELP: Record<ReachMetric, string> = {
  POTENTIAL_REACH: '團主社群的規模，例如 LINE 群組成員數。這不是「實際看到訊息的人」。',
  ACTUAL_REACH: '平台提供的貼文觸及人數（例如社群貼文後台的觸及數）。',
  QUALIFIED_VISITORS: '有可信來源的「不重複」導購訪客數（例如導購短連結的不重複點擊人數、平台提供的不重複訪客）。轉換率 CVR 只用這一項當分母。',
};
export const REACH_SOURCE_KINDS = ['LINE_GROUP_MEMBERS', 'PLATFORM_POST_REACH', 'SHORT_LINK_UNIQUE_VISITORS', 'PLATFORM_ANALYTICS', 'HOST_SELF_REPORT', 'OTHER'] as const;
export type ReachSourceKind = (typeof REACH_SOURCE_KINDS)[number];
export const REACH_SOURCE_LABEL: Record<ReachSourceKind, string> = {
  LINE_GROUP_MEMBERS: 'LINE 群組成員數', PLATFORM_POST_REACH: '平台貼文觸及', SHORT_LINK_UNIQUE_VISITORS: '導購短連結不重複訪客', PLATFORM_ANALYTICS: '平台統計後台', HOST_SELF_REPORT: '團主自行回報', OTHER: '其他（請在來源說明寫清楚）',
};
/** 每種資料可以用哪些來源種類：避免把「群組人數」或「貼文觸及」標成有效導購訪客 */
export const ALLOWED_SOURCES: Record<ReachMetric, readonly ReachSourceKind[]> = {
  POTENTIAL_REACH: ['LINE_GROUP_MEMBERS', 'HOST_SELF_REPORT', 'OTHER'],
  ACTUAL_REACH: ['PLATFORM_POST_REACH', 'PLATFORM_ANALYTICS', 'HOST_SELF_REPORT', 'OTHER'],
  QUALIFIED_VISITORS: ['SHORT_LINK_UNIQUE_VISITORS', 'PLATFORM_ANALYTICS', 'HOST_SELF_REPORT', 'OTHER'],
};
export const CREDIBILITY = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type Credibility = (typeof CREDIBILITY)[number];
export const CREDIBILITY_LABEL: Record<Credibility, string> = { HIGH: '高（平台或系統直接產出）', MEDIUM: '中（有佐證，但非系統直接產出）', LOW: '低（估計或口頭回報）' };

export interface ReachRecord {
  id: string; metric: ReachMetric; value: number; sourceKind: ReachSourceKind; sourceText: string; periodStart: string; periodEnd: string;
  credibility: Credibility; note: string | null; filledOn: string; createdBy: string; createdByName: string | null; createdAt: string;
  deleted: boolean; deletedAt: string | null; deleteReason: string | null;
}

export function sourceProblem(metric: ReachMetric, kind: ReachSourceKind): string | null {
  return ALLOWED_SOURCES[metric].includes(kind) ? null : `「${REACH_METRIC_LABEL[metric]}」不能使用來源「${REACH_SOURCE_LABEL[kind]}」（${metric === 'QUALIFIED_VISITORS' ? '群組成員數與貼文觸及都不是不重複導購訪客' : '來源種類與這項資料不符'}）`;
}

/** 同一種資料有多筆時，用統計期間最晚、再用填寫時間最晚的一筆（舊的保留在紀錄裡，不刪除） */
export function pickLatest(records: ReachRecord[], metric: ReachMetric): ReachRecord | null {
  const list = records.filter((r) => !r.deleted && r.metric === metric);
  list.sort((a, b) => (a.periodEnd === b.periodEnd ? (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1) : a.periodEnd < b.periodEnd ? 1 : -1));
  return list[0] ?? null;
}

/**
 * 有效導購訪客能不能當 CVR 的分母：可信度不是「低」、來源種類合規、統計期間與檔期有重疊（檔期日期已知時）。
 * 不可靠就回傳原因，CVR 維持「資料不足」。
 */
export function visitorsUsable(rec: ReachRecord | null, campaign: { from: string | null; to: string | null }): { usable: boolean; reason: string | null } {
  if (!rec) return { usable: false, reason: '尚未填寫「有效導購訪客」（需有可信來源的不重複導購訪客數）' };
  if (rec.credibility === 'LOW') return { usable: false, reason: '「有效導購訪客」的資料可信度為低，不採用為 CVR 的分母' };
  if (sourceProblem('QUALIFIED_VISITORS', rec.sourceKind)) return { usable: false, reason: '「有效導購訪客」的來源種類不合規，不採用' };
  if (campaign.from && campaign.to && (rec.periodEnd < campaign.from || rec.periodStart > campaign.to)) return { usable: false, reason: `「有效導購訪客」的統計期間（${rec.periodStart}～${rec.periodEnd}）與檔期（${campaign.from}～${campaign.to}）沒有重疊，不採用` };
  return { usable: true, reason: null };
}
