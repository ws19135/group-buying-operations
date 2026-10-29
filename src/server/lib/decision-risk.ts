/**
 * G1 統一決策摘要的風險規則（純函式）。只彙整、不阻擋：摘要的 gateImpact 恆為 NONE，不改 G1 的檢查項與核准結果。
 * 🔴 BLOCKING＝有阻礙性風險（合規未過、法務封鎖、試用不通過、關鍵證據過期、被退回）；🟡 GAP＝有缺口；🟢＝沒有已知缺口。
 */
export type RiskLevel = 'BLOCKING' | 'GAP';
export type RiskArea = 'PRODUCT' | 'EVALUATION' | 'DILIGENCE' | 'TRIAL' | 'FEASIBILITY';
export interface Risk { level: RiskLevel; area: RiskArea; message: string }
export type Light = 'RED' | 'YELLOW' | 'GREEN';

export interface SummaryInput {
  reviewStatus: string;
  evaluation: { recommendation: string | null; complianceStatus: string | null; reviewDecision: string | null } | null;
  diligence: { status: string; valid: boolean; invalidReasons: string[]; expiredEvidence: number; legalBlocked: boolean; legalPending: number; atRisk: number } | null;
  qualification: { conclusion: string | null; valid: boolean; reasons: string[] } | null;
  /** 本檔期內該商品的試用（新到舊） */
  trials: { status: string; level: string; trialType: string; hostId: string | null; conclusion: string | null; reviewDecision: string | null }[];
  feasibility: { incomplete: boolean; canSeeMoney: boolean; brandProfit: number | null; companyContribution: number | null } | null;
}

export function buildRisks(i: SummaryInput): Risk[] {
  const out: Risk[] = [];
  const add = (level: RiskLevel, area: RiskArea, message: string) => out.push({ level, area, message });

  if (i.reviewStatus === 'REJECTED') add('BLOCKING', 'PRODUCT', '商品審核被退回');
  else if (i.reviewStatus !== 'APPROVED') add('GAP', 'PRODUCT', `商品尚未核准（目前 ${i.reviewStatus}）`);

  const e = i.evaluation;
  if (!e) add('GAP', 'EVALUATION', '尚無已送出的選品評估');
  else {
    if (e.complianceStatus === 'FAIL' || e.recommendation === 'BLOCKED') add('BLOCKING', 'EVALUATION', '安全與合規查核未通過');
    else if (e.complianceStatus === 'NEEDS_LEGAL') add('GAP', 'EVALUATION', '安全與合規需法務或合規審查');
    else if (e.complianceStatus !== 'PASS') add('GAP', 'EVALUATION', '安全與合規尚未查核');
    if (e.reviewDecision === 'REJECTED') add('BLOCKING', 'EVALUATION', '選品評估被退回');
    else if (e.reviewDecision === 'NEEDS_MORE') add('GAP', 'EVALUATION', '選品評估要求補資料');
    else if (!e.reviewDecision) add('GAP', 'EVALUATION', '選品評估尚未覆核');
    if (e.recommendation === 'HOLD') add('GAP', 'EVALUATION', '評估建議暫緩');
    else if (e.recommendation === 'SUPPLEMENT') add('GAP', 'EVALUATION', '評估建議補測／補件');
    else if (e.recommendation === 'INSUFFICIENT_DATA') add('GAP', 'EVALUATION', '評估資料不足');
  }

  const d = i.diligence;
  if (!d) add('GAP', 'DILIGENCE', '尚無廠商合作資格審查');
  else {
    if (d.status === 'REJECTED') add('BLOCKING', 'DILIGENCE', '合作資格審查被退回或撤銷');
    else if (d.status !== 'APPROVED') add('GAP', 'DILIGENCE', '合作資格審查尚未核准');
    else if (!d.valid) add(d.expiredEvidence > 0 ? 'BLOCKING' : 'GAP', 'DILIGENCE', `合作資格審查已失效：${d.invalidReasons.join('；')}`);
    if (d.legalBlocked) add('BLOCKING', 'DILIGENCE', '有項目被法務封鎖，不得合作');
    else if (d.legalPending > 0) add('GAP', 'DILIGENCE', `${d.legalPending} 項法務／合規審查未結案`);
    if (d.atRisk > 0) add('GAP', 'DILIGENCE', `${d.atRisk} 項標示有風險`);
  }

  const q = i.qualification;
  if (q && q.conclusion === 'FAIL') add('BLOCKING', 'TRIAL', '商品資格試用不通過');
  else if (q && !q.valid) add('GAP', 'TRIAL', `商品資格已失效：${q.reasons.join('；')}`);
  const latest = new Map<string, SummaryInput['trials'][number]>();
  for (const t of i.trials) {
    if (t.status === 'CANCELLED') continue;
    const k = `${t.level}|${t.trialType}|${t.hostId ?? ''}`;
    if (!latest.has(k)) latest.set(k, t);
  }
  for (const t of latest.values()) {
    if (t.status === 'OPEN') add('GAP', 'TRIAL', '本檔試用進行中，尚未結論');
    else if (t.conclusion === 'FAIL') add('BLOCKING', 'TRIAL', '本檔試用不通過');
    else if (t.reviewDecision === 'REJECTED') add('BLOCKING', 'TRIAL', '本檔試用結論被覆核退回');
    else if (t.conclusion === 'RETEST') add('GAP', 'TRIAL', '本檔試用需重測');
    else if (t.conclusion === 'CONDITIONAL') add('GAP', 'TRIAL', '本檔試用為有條件通過');
    else if (!t.reviewDecision) add('GAP', 'TRIAL', '本檔試用結論尚未覆核');
  }
  if (!latest.size && !(q && q.valid)) add('GAP', 'TRIAL', '尚未做商品試用（無有效的商品資格，本檔也沒有試用）');

  const f = i.feasibility;
  if (!f) add('GAP', 'FEASIBILITY', '尚無商業可行性試算');
  else {
    if (f.incomplete) add('GAP', 'FEASIBILITY', '商業可行性試算不完整（缺少輸入）');
    if (f.canSeeMoney && f.brandProfit != null && f.brandProfit < 0) add('GAP', 'FEASIBILITY', '試算的品牌利潤為負');
    if (f.canSeeMoney && f.companyContribution != null && f.companyContribution < 0) add('GAP', 'FEASIBILITY', '試算的公司貢獻利潤為負');
  }
  return out;
}

export function lightOf(risks: Risk[]): Light {
  if (risks.some((r) => r.level === 'BLOCKING')) return 'RED';
  return risks.length ? 'YELLOW' : 'GREEN';
}
export const LIGHT_LABEL: Record<Light, string> = { RED: '有阻礙性風險', YELLOW: '有缺口', GREEN: '無已知缺口' };
