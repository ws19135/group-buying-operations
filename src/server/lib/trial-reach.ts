/**
 * 小規模測試團的觸及與導購資料（Owner 決策 K-2；純規則，沒有資料庫相依）。三種資料各自獨立，不可互相替代：
 *   潛在觸及人數＝團主社群規模（例如 LINE 群組成員數）；實際觸及人數＝平台提供的貼文觸及；有效導購訪客＝有可信來源的不重複導購訪客。
 * 真正的導購轉換率 CVR＝有效成交訂單數 ÷ 有效導購訪客數：只有「有效導購訪客」可以當分母，群組人數與觸及人數都不行。
 */
import { createHash } from 'node:crypto';

/**
 * 規則版本（Owner 決策 K-4）：有效導購訪客「可不可以當 CVR 分母」的規則是有版本的；每筆記錄保留填寫當時的版本，查核時另記查核當下的版本。
 * 修改 REACH_RULES 的任何內容，必須同時更新版本字串與 tests/unit/trial-reach-rules.test.ts 的指紋，否則測試會失敗（避免悄悄改規則）。
 */
export const REACH_RULES_VERSION = 'reach-rules/2026-11-04.1';
export const DEDUPE_METHODS = ['PLATFORM_UNIQUE_USERS', 'SHORT_LINK_UNIQUE_CLIENTS', 'MANUAL_DEDUP', 'NOT_DEDUPED', 'UNKNOWN'] as const;
export type DedupeMethod = (typeof DEDUPE_METHODS)[number];
export const DEDUPE_LABEL: Record<DedupeMethod, string> = {
  PLATFORM_UNIQUE_USERS: '平台以登入帳號／裝置去重', SHORT_LINK_UNIQUE_CLIENTS: '導購短連結以不重複用戶端去重', MANUAL_DEDUP: '人工去重（需說明方法）', NOT_DEDUPED: '沒有去重（例如點擊數、瀏覽次數）', UNKNOWN: '不知道有沒有去重',
};
export const VERIFICATION_STATUS = ['UNVERIFIED', 'VERIFIED', 'REJECTED'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUS)[number];
export const VERIFICATION_LABEL: Record<VerificationStatus, string> = { UNVERIFIED: '未查核（填寫者自述）', VERIFIED: '已查核', REJECTED: '查核退回' };
export const REACH_RULES = {
  version: REACH_RULES_VERSION,
  visitors: {
    usableCredibility: ['HIGH', 'MEDIUM'],                                   // 低可信度不得用於 CVR
    evidenceRequiredFor: ['HIGH', 'MEDIUM'],                                  // 高／中需附來源佐證或可查核的來源識別
    dedupeProvable: { PLATFORM_UNIQUE_USERS: true, SHORT_LINK_UNIQUE_CLIENTS: true, MANUAL_DEDUP: 'NEEDS_NOTE', NOT_DEDUPED: false, UNKNOWN: false },
    manualDedupNoteMinLength: 10,
    selfReportNeverProvesUnique: true,                                       // 團主自行回報不能證明不重複
    verificationRequired: true,                                              // 需第二位有 product.review 權限的人查核；填寫者自選高／中不算已驗證
    verifierMustDiffer: true,
    periodMustOverlapCampaign: true,
    forbiddenSources: ['LINE_GROUP_MEMBERS', 'PLATFORM_POST_REACH'],         // 群組成員數與貼文觸及不能當有效導購訪客
  },
} as const;
/** 規則內容的指紋（排序後的 JSON 取 SHA-256 前 16 碼）：測試用它確認「規則內容」與「版本字串」同步 */
export function rulesFingerprint(rules: unknown = REACH_RULES): string {
  const norm = (v: unknown): unknown => (Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, norm(x)])) : v);
  return createHash('sha256').update(JSON.stringify(norm(rules))).digest('hex').slice(0, 16);
}

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
  evidenceRef: string | null; dedupeMethod: DedupeMethod | null; dedupeNote: string | null; rulesVersion: string;
  verificationStatus: VerificationStatus; verifiedBy: string | null; verifiedByName: string | null; verifiedAt: string | null; verifyNote: string | null; verifyRulesVersion: string | null;
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

/** 去重方式能不能證明「不重複」（K-4）：平台帳號／裝置去重、短連結不重複用戶端可以；人工去重要有說明；沒去重或不知道不行 */
export function dedupeProvesUnique(method: DedupeMethod | null, note: string | null): boolean {
  if (!method) return false;
  const rule = REACH_RULES.visitors.dedupeProvable[method];
  if (rule === true) return true;
  if (rule === 'NEEDS_NOTE') return (note ?? '').trim().length >= REACH_RULES.visitors.manualDedupNoteMinLength;
  return false;
}

/** 新增有效導購訪客時的輸入檢查（K-4）；回傳問題清單，空＝通過 */
export function visitorInputProblems(i: { credibility: Credibility; sourceKind?: ReachSourceKind; evidenceRef?: string | null; dedupeMethod?: DedupeMethod | null; dedupeNote?: string | null }): string[] {
  const p: string[] = [];
  if (!i.dedupeMethod) p.push('請說明訪客如何去重（沒有去重或不知道也要如實選擇）');
  if ((REACH_RULES.visitors.evidenceRequiredFor as readonly string[]).includes(i.credibility) && (i.evidenceRef ?? '').trim().length < 4) p.push('可信度為「高」或「中」時，需附來源佐證或可查核的來源識別（報表編號、後台連結、檔名等）');
  if (i.dedupeMethod === 'MANUAL_DEDUP' && (i.dedupeNote ?? '').trim().length < REACH_RULES.visitors.manualDedupNoteMinLength) p.push(`人工去重需說明去重方法（至少 ${REACH_RULES.visitors.manualDedupNoteMinLength} 字）`);
  return p;
}

/**
 * 有效導購訪客能不能當 CVR 的分母（K-4 規則，版本見 REACH_RULES_VERSION）：
 *   可信度不是「低」、來源種類合規且不是團主自行回報、統計期間與檔期有重疊、有來源佐證、去重方式能證明不重複，
 *   並且經第二位有權限的人查核為「已查核」。填寫者自選「高」或「中」不算已驗證。不可靠就回傳原因，CVR 維持「資料不足」。
 */
export function visitorsUsable(rec: ReachRecord | null, campaign: { from: string | null; to: string | null }): { usable: boolean; reason: string | null } {
  if (!rec) return { usable: false, reason: '尚未填寫「有效導購訪客」（需有可信來源的不重複導購訪客數）' };
  if (rec.credibility === 'LOW') return { usable: false, reason: '「有效導購訪客」的資料可信度為低，不採用為 CVR 的分母' };
  if (sourceProblem('QUALIFIED_VISITORS', rec.sourceKind)) return { usable: false, reason: '「有效導購訪客」的來源種類不合規，不採用' };
  if (rec.sourceKind === 'HOST_SELF_REPORT') return { usable: false, reason: '團主自行回報不能證明訪客不重複，不採用為 CVR 的分母' };
  if (campaign.from && campaign.to && (rec.periodEnd < campaign.from || rec.periodStart > campaign.to)) return { usable: false, reason: `「有效導購訪客」的統計期間（${rec.periodStart}～${rec.periodEnd}）與檔期（${campaign.from}～${campaign.to}）沒有重疊，不採用` };
  if ((REACH_RULES.visitors.evidenceRequiredFor as readonly string[]).includes(rec.credibility) && (rec.evidenceRef ?? '').trim().length < 4) return { usable: false, reason: '「有效導購訪客」缺少來源佐證或可查核的來源識別，不採用' };
  if (!dedupeProvesUnique(rec.dedupeMethod, rec.dedupeNote)) return { usable: false, reason: `來源不能證明訪客不重複（去重方式：${rec.dedupeMethod ? DEDUPE_LABEL[rec.dedupeMethod] : '未記錄'}），CVR 資料不足` };
  if (rec.verificationStatus === 'REJECTED') return { usable: false, reason: '「有效導購訪客」查核退回，不採用' };
  if (rec.verificationStatus !== 'VERIFIED') return { usable: false, reason: '「有效導購訪客」尚未經第二位有權限的人查核（填寫者自選的可信度不算已驗證），CVR 資料不足' };
  return { usable: true, reason: null };
}
