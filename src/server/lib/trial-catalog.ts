import { createHash } from 'node:crypto';

/**
 * SOP 03 商品試用：四大面向檢核目錄、建議結論、商品指紋與資格有效性（純函式）。
 * 見 docs/phase2/PRODUCT_SELECTION_TRIAL.md §5。試用沒有自己的流程狀態機；任務狀態仍由 tasks 模組管理。
 */
export const TRIAL_LEVELS = ['QUALIFICATION', 'HOST_FIT'] as const;
export const TRIAL_TYPES = ['INTERNAL', 'DESIGNATED_HOST', 'MINI_GROUP'] as const;
export const TRIAL_DIMENSIONS = ['PRODUCT', 'CUSTOMER', 'CONTENT', 'BUSINESS'] as const;
export const CHECK_RESULTS = ['NOT_TESTED', 'PASS', 'CONCERN', 'FAIL'] as const;
export const SEVERITIES = ['NONE', 'MINOR', 'MAJOR', 'CRITICAL'] as const;
export const CONCLUSIONS = ['PASS', 'CONDITIONAL', 'FAIL', 'RETEST'] as const;
export const RECOVERY_STATUSES = ['NOT_REQUIRED', 'PENDING', 'RECOVERED', 'WAIVED', 'LOST'] as const;
export type TrialLevel = (typeof TRIAL_LEVELS)[number];
export type Dimension = (typeof TRIAL_DIMENSIONS)[number];
export type Conclusion = (typeof CONCLUSIONS)[number];

export const LEVEL_LABEL: Record<string, string> = { QUALIFICATION: '商品資格驗證', HOST_FIT: '團主／檔期適配試用' };
export const TYPE_LABEL: Record<string, string> = { INTERNAL: '內部試用', DESIGNATED_HOST: '指定團主試用', MINI_GROUP: '小規模測試團' };
export const DIMENSION_LABEL: Record<string, string> = { PRODUCT: '商品本身', CUSTOMER: '顧客體驗', CONTENT: '內容素材', BUSINESS: '商業效益' };
export const RESULT_LABEL: Record<string, string> = { NOT_TESTED: '未測', PASS: '通過', CONCERN: '有疑慮', FAIL: '不通過' };
export const SEVERITY_LABEL: Record<string, string> = { NONE: '無缺陷', MINOR: '輕微', MAJOR: '重大', CRITICAL: '嚴重' };
export const CONCLUSION_LABEL: Record<string, string> = { PASS: '通過', CONDITIONAL: '有條件通過', FAIL: '不通過', RETEST: '需重測' };
export const RECOVERY_LABEL: Record<string, string> = { NOT_REQUIRED: '不需回收', PENDING: '待回收', RECOVERED: '已回收', WAIVED: '免回收', LOST: '遺失' };
export const TRIAL_STATUS_LABEL: Record<string, string> = { OPEN: '進行中', CONCLUDED: '已結論', CANCELLED: '已取消' };

export interface CheckDef { key: string; label: string; dimension: Dimension }
export const CHECK_CATALOG: CheckDef[] = [
  { key: 'quality', label: '品質', dimension: 'PRODUCT' }, { key: 'spec', label: '規格符合', dimension: 'PRODUCT' }, { key: 'packaging', label: '包裝完整', dimension: 'PRODUCT' },
  { key: 'shelf_life', label: '保存期限／效期', dimension: 'PRODUCT' }, { key: 'usage_limits', label: '使用限制', dimension: 'PRODUCT' }, { key: 'safety_label', label: '安全標示與合規', dimension: 'PRODUCT' },
  { key: 'unboxing', label: '開箱體驗', dimension: 'CUSTOMER' }, { key: 'ease_of_use', label: '使用難易', dimension: 'CUSTOMER' }, { key: 'effect', label: '效果感受', dimension: 'CUSTOMER' },
  { key: 'misread_risk', label: '容易誤解之處', dimension: 'CUSTOMER' }, { key: 'service_questions', label: '客服疑問', dimension: 'CUSTOMER' },
  { key: 'demonstrable', label: '可示範性', dimension: 'CONTENT' }, { key: 'material_quality', label: '素材品質', dimension: 'CONTENT' }, { key: 'differentiation', label: '賣點差異', dimension: 'CONTENT' },
  { key: 'margin', label: '預估毛利', dimension: 'BUSINESS' }, { key: 'demand', label: '需求', dimension: 'BUSINESS' }, { key: 'return_risk', label: '退貨風險', dimension: 'BUSINESS' }, { key: 'supply_risk', label: '供應風險', dimension: 'BUSINESS' },
];

/** 資格驗證做全部四面向；團主適配試用若已有仍有效的商品資格，就不重做「商品本身」面向 */
export function checksForLevel(level: TrialLevel, reuseQualification: boolean): CheckDef[] {
  if (level === 'QUALIFICATION' || !reuseQualification) return CHECK_CATALOG;
  return CHECK_CATALOG.filter((c) => c.dimension !== 'PRODUCT');
}

export interface CheckLite { dimension: string; result: string; defectSeverity: string }

/** 系統建議結論：任何不通過或嚴重缺陷 → 不通過；仍有未測 → 需重測；有疑慮或重大缺陷 → 有條件通過；否則通過 */
export function suggestConclusion(checks: CheckLite[]): { conclusion: Conclusion; reasons: string[] } {
  const reasons: string[] = [];
  const fails = checks.filter((c) => c.result === 'FAIL').length;
  const critical = checks.filter((c) => c.defectSeverity === 'CRITICAL').length;
  const untested = checks.filter((c) => c.result === 'NOT_TESTED').length;
  const concerns = checks.filter((c) => c.result === 'CONCERN').length;
  const major = checks.filter((c) => c.defectSeverity === 'MAJOR').length;
  if (!checks.length) return { conclusion: 'RETEST', reasons: ['沒有任何檢核項'] };
  if (fails) reasons.push(`${fails} 項不通過`);
  if (critical) reasons.push(`${critical} 項嚴重缺陷`);
  if (fails || critical) return { conclusion: 'FAIL', reasons };
  if (untested) return { conclusion: 'RETEST', reasons: [`${untested} 項尚未測試`] };
  if (concerns) reasons.push(`${concerns} 項有疑慮`);
  if (major) reasons.push(`${major} 項重大缺陷`);
  if (concerns || major) return { conclusion: 'CONDITIONAL', reasons };
  return { conclusion: 'PASS', reasons: ['全部檢核通過、沒有缺陷'] };
}

const RANK: Record<Conclusion, number> = { FAIL: 0, RETEST: 1, CONDITIONAL: 2, PASS: 3 };
/** 最終建議是否比系統建議更樂觀（需要覆寫原因） */
export const isMoreOptimistic = (final: Conclusion, suggested: Conclusion): boolean => RANK[final] > RANK[suggested];

/** 商品指紋：名稱、類別、啟用規格編號、合規備註。價格不在內（價格變動不使資格失效） */
export function productFingerprint(p: { name: string; category: string | null; complianceNote: string | null; skuCodes: string[] }): string {
  const payload = JSON.stringify({ n: p.name.trim(), c: (p.category ?? '').trim(), k: (p.complianceNote ?? '').trim(), s: [...p.skuCodes].map((x) => x.trim().toLowerCase()).sort() });
  return createHash('sha256').update(payload).digest('hex');
}

export interface QualificationLite { status: string; conclusion: string | null; reviewDecision: string | null; validUntil: string | null; basisFingerprint: string | null }
/** 商品資格試用是否仍可沿用：已結論為通過／有條件通過、已覆核接受、未過期、商品指紋未變 */
export function qualificationValidity(t: QualificationLite, currentFingerprint: string, today: string): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (t.status !== 'CONCLUDED') reasons.push('尚未結論');
  else if (t.conclusion !== 'PASS' && t.conclusion !== 'CONDITIONAL') reasons.push('結論不是通過');
  if (t.status === 'CONCLUDED' && t.reviewDecision !== 'ACCEPTED') reasons.push(t.reviewDecision === 'REJECTED' ? '覆核未接受' : '尚未覆核');
  if (t.validUntil && t.validUntil < today) reasons.push(`已於 ${t.validUntil} 過期`);
  if (t.basisFingerprint && t.basisFingerprint !== currentFingerprint) reasons.push('商品資料（名稱、類別、規格或合規備註）已變更，資格失效');
  return { valid: reasons.length === 0, reasons };
}

export function checkProblems(c: { result: string; evidenceText?: string | null; defectSeverity?: string; defectNote?: string | null; riskNote?: string | null }): string[] {
  const out: string[] = [];
  if (c.result === 'PASS' && !c.evidenceText?.trim()) out.push('結果為「通過」時需填寫客觀證據');
  if (c.defectSeverity && c.defectSeverity !== 'NONE' && !c.defectNote?.trim()) out.push('有缺陷時需說明缺陷');
  if (c.result === 'FAIL' && !c.riskNote?.trim() && !c.defectNote?.trim()) out.push('結果為「不通過」時需說明缺陷或風險');
  return out;
}
