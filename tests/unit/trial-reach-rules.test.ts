import { describe, expect, it } from 'vitest';
import { REACH_RULES, REACH_RULES_VERSION, dedupeProvesUnique, rulesFingerprint, visitorInputProblems, visitorsUsable, type ReachRecord } from '@/server/lib/trial-reach';

const rec = (over: Partial<ReachRecord> = {}): ReachRecord => ({
  id: 'RCH-000001', metric: 'QUALIFIED_VISITORS', value: 400, sourceKind: 'SHORT_LINK_UNIQUE_VISITORS', sourceText: '導購短連結後台（虛構）', periodStart: '2026-11-01', periodEnd: '2026-11-10',
  credibility: 'HIGH', note: null, filledOn: '2026-11-11', createdBy: 'USR-1', createdByName: '營運人員', createdAt: '2026-11-11T01:00:00Z', deleted: false, deletedAt: null, deleteReason: null,
  evidenceRef: 'REPORT-001', dedupeMethod: 'SHORT_LINK_UNIQUE_CLIENTS', dedupeNote: null, rulesVersion: REACH_RULES_VERSION, verificationStatus: 'VERIFIED', verifiedBy: 'USR-2', verifiedByName: '主管', verifiedAt: '2026-11-12T01:00:00Z', verifyNote: '已對照', verifyRulesVersion: REACH_RULES_VERSION, ...over,
});
const camp = { from: '2026-11-01', to: '2026-11-10' };

describe('K-4 規則版本化：規則內容與版本字串必須同步', () => {
  // 修改 REACH_RULES 的任何內容：請同時更新 REACH_RULES_VERSION 與下面這張表（新增一列，不要改舊列）
  const PINNED: Record<string, string> = { 'reach-rules/2026-11-04.1': 'd101ec013b3cbc4e' };
  it('目前版本的指紋已登記；規則被悄悄改動（沒升版）會讓這個測試失敗', () => {
    expect(REACH_RULES.version).toBe(REACH_RULES_VERSION);
    expect(PINNED[REACH_RULES_VERSION]).toBeDefined();
    expect(rulesFingerprint()).toBe(PINNED[REACH_RULES_VERSION]);
  });
  it('指紋對規則內容敏感、對鍵的順序不敏感', () => {
    const copy = JSON.parse(JSON.stringify(REACH_RULES));
    expect(rulesFingerprint(copy)).toBe(rulesFingerprint());
    copy.visitors.usableCredibility = ['HIGH', 'MEDIUM', 'LOW'];
    expect(rulesFingerprint(copy)).not.toBe(rulesFingerprint());
  });
  it('規則的硬性內容：低可信度不可用、群組成員數與貼文觸及不可當有效導購訪客、必須查核', () => {
    expect(REACH_RULES.visitors.usableCredibility).not.toContain('LOW');
    expect(REACH_RULES.visitors.forbiddenSources).toEqual(['LINE_GROUP_MEMBERS', 'PLATFORM_POST_REACH']);
    expect(REACH_RULES.visitors.verificationRequired).toBe(true);
    expect(REACH_RULES.visitors.verifierMustDiffer).toBe(true);
  });
});

describe('K-4 去重方式能不能證明「不重複」', () => {
  it('平台帳號／裝置去重、短連結不重複用戶端：可以', () => {
    expect(dedupeProvesUnique('PLATFORM_UNIQUE_USERS', null)).toBe(true);
    expect(dedupeProvesUnique('SHORT_LINK_UNIQUE_CLIENTS', null)).toBe(true);
  });
  it('人工去重：要有足夠的說明才算；沒去重、不知道、沒記錄：不行', () => {
    expect(dedupeProvesUnique('MANUAL_DEDUP', null)).toBe(false);
    expect(dedupeProvesUnique('MANUAL_DEDUP', '太短')).toBe(false);
    expect(dedupeProvesUnique('MANUAL_DEDUP', '依 LINE 暱稱與下單帳號比對後去除重複')).toBe(true);
    expect(dedupeProvesUnique('NOT_DEDUPED', '點擊數')).toBe(false);
    expect(dedupeProvesUnique('UNKNOWN', null)).toBe(false);
    expect(dedupeProvesUnique(null, null)).toBe(false);
  });
});

describe('K-4 新增有效導購訪客時的輸入檢查', () => {
  it('高／中可信度需附來源佐證；去重方式必填；人工去重要說明', () => {
    expect(visitorInputProblems({ credibility: 'HIGH', evidenceRef: null, dedupeMethod: 'PLATFORM_UNIQUE_USERS' }).join()).toContain('來源佐證');
    expect(visitorInputProblems({ credibility: 'MEDIUM', evidenceRef: 'ab', dedupeMethod: 'PLATFORM_UNIQUE_USERS' }).join()).toContain('來源佐證');
    expect(visitorInputProblems({ credibility: 'LOW', evidenceRef: null, dedupeMethod: 'UNKNOWN' })).toEqual([]);
    expect(visitorInputProblems({ credibility: 'HIGH', evidenceRef: 'REPORT-1', dedupeMethod: null }).join()).toContain('如何去重');
    expect(visitorInputProblems({ credibility: 'HIGH', evidenceRef: 'REPORT-1', dedupeMethod: 'MANUAL_DEDUP', dedupeNote: '短' }).join()).toContain('去重方法');
    expect(visitorInputProblems({ credibility: 'HIGH', evidenceRef: 'REPORT-1', dedupeMethod: 'PLATFORM_UNIQUE_USERS' })).toEqual([]);
  });
});

describe('K-4 有效導購訪客能不能當 CVR 分母（visitorsUsable）', () => {
  it('完整、已查核、去重可證明、期間重疊：可用', () => {
    expect(visitorsUsable(rec(), camp)).toEqual({ usable: true, reason: null });
    expect(visitorsUsable(rec({ credibility: 'MEDIUM' }), camp).usable).toBe(true);
  });
  it('填寫者自選「高」但沒有查核：不算已驗證', () => {
    const r = visitorsUsable(rec({ verificationStatus: 'UNVERIFIED', verifiedBy: null, verifiedAt: null, verifyNote: null }), camp);
    expect(r.usable).toBe(false); expect(r.reason).toContain('尚未經第二位');
  });
  it('查核退回、低可信度、沒有佐證、去重不能證明、團主自行回報、群組成員數／貼文觸及、期間不重疊：都不可用，並說原因', () => {
    expect(visitorsUsable(rec({ verificationStatus: 'REJECTED' }), camp).reason).toContain('查核退回');
    expect(visitorsUsable(rec({ credibility: 'LOW' }), camp).reason).toContain('可信度為低');
    expect(visitorsUsable(rec({ evidenceRef: null }), camp).reason).toContain('來源佐證');
    expect(visitorsUsable(rec({ dedupeMethod: 'NOT_DEDUPED' }), camp).reason).toContain('不能證明訪客不重複');
    expect(visitorsUsable(rec({ dedupeMethod: 'UNKNOWN' }), camp).reason).toContain('不能證明訪客不重複');
    expect(visitorsUsable(rec({ dedupeMethod: 'MANUAL_DEDUP', dedupeNote: null }), camp).reason).toContain('不能證明訪客不重複');
    expect(visitorsUsable(rec({ sourceKind: 'HOST_SELF_REPORT' }), camp).reason).toContain('團主自行回報');
    expect(visitorsUsable(rec({ sourceKind: 'LINE_GROUP_MEMBERS' }), camp).reason).toContain('來源種類不合規');
    expect(visitorsUsable(rec({ sourceKind: 'PLATFORM_POST_REACH' }), camp).reason).toContain('來源種類不合規');
    expect(visitorsUsable(rec({ periodStart: '2026-10-01', periodEnd: '2026-10-05' }), camp).reason).toContain('沒有重疊');
    expect(visitorsUsable(null, camp).reason).toContain('尚未填寫');
  });
  it('舊資料（沒有佐證、去重方式未知、未查核）不會被當成可用', () => {
    const legacy = rec({ evidenceRef: null, dedupeMethod: 'UNKNOWN', verificationStatus: 'UNVERIFIED', verifiedBy: null, verifiedAt: null, verifyNote: null, rulesVersion: 'reach-rules/legacy' });
    expect(visitorsUsable(legacy, camp).usable).toBe(false);
  });
});
