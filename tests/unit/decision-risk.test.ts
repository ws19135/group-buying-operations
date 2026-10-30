import { describe, expect, it } from 'vitest';
import { buildRisks, lightOf, type SummaryInput } from '@/server/lib/decision-risk';

const clean = (): SummaryInput => ({
  reviewStatus: 'APPROVED',
  evaluation: { recommendation: 'PROCEED', complianceStatus: 'PASS', reviewDecision: 'ACCEPTED' },
  diligence: { status: 'APPROVED', valid: true, invalidReasons: [], expiredEvidence: 0, legalBlocked: false, legalPending: 0, atRisk: 0 },
  qualification: { conclusion: 'PASS', valid: true, reasons: [] },
  trials: [],
  feasibility: { incomplete: false, canSeeMoney: true, brandProfit: 1000, companyContribution: 500 },
});
const msgs = (i: SummaryInput, level?: string) => buildRisks(i).filter((r) => !level || r.level === level).map((r) => r.message);

describe('G1 決策摘要風險規則', () => {
  it('全部齊備 → 沒有風險、綠燈', () => {
    expect(buildRisks(clean())).toEqual([]);
    expect(lightOf([])).toBe('GREEN');
  });
  it('什麼都沒有 → 只有缺口（黃燈），不是阻礙', () => {
    const r = buildRisks({ reviewStatus: 'APPROVED', evaluation: null, diligence: null, qualification: null, trials: [], feasibility: null });
    expect(r.every((x) => x.level === 'GAP')).toBe(true);
    expect(r.map((x) => x.area).sort()).toEqual(['DILIGENCE', 'EVALUATION', 'FEASIBILITY', 'TRIAL']);
    expect(lightOf(r)).toBe('YELLOW');
  });
  it('阻礙性風險（紅燈）：合規未過、評估被退回、調查被退回、法務封鎖、資格或試用不通過、關鍵證據過期、商品被退回', () => {
    expect(msgs({ ...clean(), evaluation: { recommendation: 'BLOCKED', complianceStatus: 'FAIL', reviewDecision: 'ACCEPTED' } }, 'BLOCKING')).toContain('安全與合規查核未通過');
    expect(msgs({ ...clean(), evaluation: { recommendation: 'PROCEED', complianceStatus: 'PASS', reviewDecision: 'REJECTED' } }, 'BLOCKING')).toContain('選品評估被退回');
    expect(msgs({ ...clean(), diligence: { ...clean().diligence!, status: 'REJECTED' } }, 'BLOCKING')).toHaveLength(1);
    expect(msgs({ ...clean(), diligence: { ...clean().diligence!, legalBlocked: true } }, 'BLOCKING')).toContain('有項目被法務封鎖，不得合作');
    expect(msgs({ ...clean(), qualification: { conclusion: 'FAIL', valid: false, reasons: ['結論不是通過'] } }, 'BLOCKING')).toContain('商品資格試用不通過');
    expect(msgs({ ...clean(), trials: [{ status: 'CONCLUDED', level: 'HOST_FIT', trialType: 'MINI_GROUP', hostId: null, conclusion: 'FAIL', reviewDecision: null }] }, 'BLOCKING')).toContain('本檔試用不通過');
    expect(msgs({ ...clean(), diligence: { ...clean().diligence!, valid: false, invalidReasons: ['2 筆證據已過期'], expiredEvidence: 2 } }, 'BLOCKING')[0]).toContain('已失效');
    expect(msgs({ ...clean(), reviewStatus: 'REJECTED' }, 'BLOCKING')).toContain('商品審核被退回');
    expect(lightOf(buildRisks({ ...clean(), reviewStatus: 'REJECTED' }))).toBe('RED');
  });
  it('只是到期（證據沒過期）→ 黃燈缺口，不是阻礙', () => {
    const r = buildRisks({ ...clean(), diligence: { ...clean().diligence!, valid: false, invalidReasons: ['核准已於 2026-01-01 到期'], expiredEvidence: 0 } });
    expect(r.map((x) => x.level)).toEqual(['GAP']);
  });
  it('試用：每組（層級×類型×團主）只看最新一次；舊的失敗被後來的通過取代；取消的不算', () => {
    const pass = { status: 'CONCLUDED', level: 'HOST_FIT', trialType: 'DESIGNATED_HOST', hostId: 'H1', conclusion: 'PASS', reviewDecision: 'ACCEPTED' };
    expect(msgs({ ...clean(), trials: [pass, { ...pass, conclusion: 'FAIL', reviewDecision: null }] })).toEqual([]);          // 新→舊：最新是通過
    expect(msgs({ ...clean(), trials: [{ ...pass, conclusion: 'FAIL' }, pass] }, 'BLOCKING')).toContain('本檔試用不通過');   // 最新是失敗
    expect(msgs({ ...clean(), trials: [{ ...pass, status: 'CANCELLED', conclusion: null }, pass] })).toEqual([]);
    expect(msgs({ ...clean(), trials: [{ ...pass, status: 'OPEN', conclusion: null }] })).toContain('本檔試用進行中，尚未結論');
    expect(msgs({ ...clean(), trials: [{ ...pass, conclusion: 'CONDITIONAL' }] })).toContain('本檔試用為有條件通過');
  });
  it('可行性：沒有成本權限時，不會透過風險訊息洩漏利潤正負', () => {
    const neg = { incomplete: false, brandProfit: -500, companyContribution: -100 };
    expect(msgs({ ...clean(), feasibility: { ...neg, canSeeMoney: true } })).toEqual(['試算的品牌利潤為負', '試算的公司貢獻利潤為負']);
    expect(msgs({ ...clean(), feasibility: { ...neg, canSeeMoney: false } })).toEqual([]);
    expect(msgs({ ...clean(), feasibility: { incomplete: true, canSeeMoney: false, brandProfit: null, companyContribution: null } })).toEqual(['商業可行性試算不完整（缺少輸入）']);
  });
});
