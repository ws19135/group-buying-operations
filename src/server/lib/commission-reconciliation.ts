/**
 * 分潤口徑差異核對（Owner 決策 K-6；純函式，只讀、只比較）。
 * 比較同一個「檔期 × 團主 × 商品」的三個來源：
 *   ① 合約約定（廠商合作資格審查第 10 題「分潤基礎、比例、結算週期」，含合約版本與核准狀態）
 *   ② 商業可行性採用的條款（每個欄位有「假設來源」；來源為合約或正式商務條件才算已確認）
 *   ③ 財務結算實際使用的佣金規則與版本（commission_rules，以及已產生的結算明細）
 * 三者不同時：列出差異項目、來源版本、是否已有正式核准、影響範圍，並產生「待人工覆核」清單。
 * **不會**自動以任一方覆蓋另一方；財務規則調整、已確認結算更正、實際付款、發票與歷史回填都不在這裡，需 Owner 或既有有權角色另案核准。
 * 缺少正式合約條件時標示「資料不足」，暫估條款不視為已核准。
 */
export type ReconField = 'ratePercent' | 'basis' | 'paidBy' | 'period';
export const RECON_FIELD_LABEL: Record<ReconField, string> = { ratePercent: '團主分潤比例', basis: '分潤基礎', paidBy: '團主分潤付款方', period: '適用期間' };
export type ReconSource = 'CONTRACT' | 'FEASIBILITY' | 'FINANCE';
export const RECON_SOURCE_LABEL: Record<ReconSource, string> = { CONTRACT: '合約約定', FEASIBILITY: '商業可行性', FINANCE: '財務結算規則' };
export type ReconVerdict = 'CONSISTENT' | 'DIFFERENT' | 'INSUFFICIENT';
export const RECON_VERDICT_LABEL: Record<ReconVerdict, string> = { CONSISTENT: '一致', DIFFERENT: '有差異', INSUFFICIENT: '資料不足' };

const CONFIRMED_KINDS = ['CONTRACT', 'FORMAL_TERMS'];

export interface ContractSnap {
  recordId: string; contractVersion: string; recordStatus: string; validUntil: string | null; superseded: boolean; itemStatus: string;
  basis: string | null; hostCommissionPct: number | null; legacyRatePct: number | null; hostPaidBy: string | null; effectiveFrom: string | null; effectiveTo: string | null;
}
export interface FeasibilitySnap {
  scenarioId: string; versionNo: number;
  commissionBasis: string | null; hostCommissionPct: number | null; hostPaidBy: string | null;
  sources: Record<string, { kind?: string } | undefined>;
}
export interface FinanceSnap {
  ruleId: string; ruleVersion: number; scopeType: string; ratePercent: number; effectiveFrom: string; effectiveTo: string | null; ruleStatus: string;
  settlement: { id: string; status: string; ratePercent: number | null; ruleVersion: number | null; netSales: number | null } | null;
}
export interface ReconInput {
  campaignId: string; campaignTitle: string; campaignOpenDate: string | null;
  hostId: string; hostName: string; productId: string; productName: string;
  contract: ContractSnap | null; feasibility: FeasibilitySnap | null; finance: FinanceSnap | null;
  /** 該團主在該檔期計入銷售的歸因淨銷售額（用來估算比例差異的影響範圍） */
  attributedNetSales: number;
}

export interface SourceValue {
  source: ReconSource;
  /** 顯示用的值（null＝這個來源沒有這項資料） */
  value: string | number | null;
  display: string;
  /** 來源版本（合約版本、可行性版本、規則版本） */
  version: string | null;
  /** 這個來源的值是否「已正式確認／核准」，以及依據 */
  approved: boolean;
  approvalNote: string;
}
export interface FieldRecon { field: ReconField; label: string; values: SourceValue[]; verdict: ReconVerdict; differences: string[]; insufficientReasons: string[] }
export interface ReconRow {
  key: string; campaignId: string; campaignTitle: string; hostId: string; hostName: string; productId: string; productName: string;
  fields: FieldRecon[]; verdict: ReconVerdict; needsManualReview: boolean; reviewReasons: string[];
  /** 影響範圍（只估算、不入帳）：比例差異 × 歸因淨銷售額 */
  impact: { attributedNetSales: number; maxRateGapPct: number | null; estimatedGap: number | null; settlementConfirmed: boolean; note: string };
}

const pct = (v: number | null) => (v == null ? '未提供' : `${v}%`);
const labelBasis = (v: string | null) => (v == null ? '未提供' : v === 'NSV' ? 'NSV（有效淨銷售額）' : v === 'GMV' ? 'GMV（成交總額）' : v);
const labelPayer = (v: string | null) => (v == null ? '未提供' : v === 'COMPANY' ? '公司' : v === 'BRAND' ? '品牌' : v);
const period = (a: string | null, b: string | null) => (a || b ? `${a ?? '不限'} ～ ${b ?? '不限'}` : '未提供');

function contractApproved(c: ContractSnap, today: string): { approved: boolean; note: string } {
  if (c.recordStatus !== 'APPROVED') return { approved: false, note: `廠商合作資格審查狀態為「${c.recordStatus}」，尚未核准` };
  if (c.superseded) return { approved: false, note: '這份審查已被新版取代' };
  if (c.validUntil && c.validUntil < today) return { approved: false, note: `核准已於 ${c.validUntil} 過期` };
  if (c.itemStatus !== 'CONFIRMED') return { approved: false, note: `第 10 題「分潤基礎、比例、結算週期」狀態為「${c.itemStatus}」，尚未確認` };
  return { approved: true, note: `已核准（合約版本 ${c.contractVersion}${c.validUntil ? `，核准有效至 ${c.validUntil}` : ''}）` };
}

export function reconcileRow(i: ReconInput, today: string): ReconRow {
  const ca = i.contract ? contractApproved(i.contract, today) : null;
  const feaConfirmed = (k: string) => !!i.feasibility && CONFIRMED_KINDS.includes(i.feasibility.sources[k]?.kind ?? '');
  const feaNote = (k: string) => (!i.feasibility ? '' : feaConfirmed(k) ? `來源為「${i.feasibility.sources[k]?.kind === 'CONTRACT' ? '合約' : '正式商務條件'}」，視為已確認` : `來源為「${i.feasibility.sources[k]?.kind ?? '未註明'}」，是暫估、不視為已核准`);
  const fin = i.finance;
  const finNote = fin ? `財務生效規則（${fin.ruleStatus}）；由財務維護，不等於合約核准` : '';
  const sv = (source: ReconSource, value: string | number | null, display: string, version: string | null, approved: boolean, approvalNote: string): SourceValue => ({ source, value, display, version, approved, approvalNote });

  const fields: FieldRecon[] = [];
  const addField = (field: ReconField, values: SourceValue[]) => {
    const present = values.filter((v) => v.value != null);
    const insufficientReasons: string[] = [];
    for (const v of values) if (v.value == null) insufficientReasons.push(`${RECON_SOURCE_LABEL[v.source]}沒有「${RECON_FIELD_LABEL[field]}」資料`);
    let verdict: ReconVerdict;
    const differences: string[] = [];
    if (present.length < 2) verdict = 'INSUFFICIENT';
    else if (new Set(present.map((v) => String(v.value))).size === 1) verdict = 'CONSISTENT';
    else { verdict = 'DIFFERENT'; differences.push(present.map((v) => `${RECON_SOURCE_LABEL[v.source]} ${v.display}${v.version ? `（${v.version}）` : ''}${v.approved ? '【已核准／確認】' : '【未核准】'}`).join(' ≠ ')); }
    fields.push({ field, label: RECON_FIELD_LABEL[field], values, verdict, differences, insufficientReasons });
  };

  const c = i.contract, f = i.feasibility;
  const cVer = c ? `合約版本 ${c.contractVersion}` : null;
  const fVer = f ? `可行性 v${f.versionNo}` : null;
  const fnVer = fin ? `規則 v${fin.ruleVersion}` : null;
  const cAp = ca?.approved ?? false;

  addField('ratePercent', [
    sv('CONTRACT', c?.hostCommissionPct ?? null, pct(c?.hostCommissionPct ?? null), cVer, cAp && c?.hostCommissionPct != null, c ? (c.hostCommissionPct == null ? (c.legacyRatePct != null ? `舊欄位「分潤比例 ${c.legacyRatePct}%」沒有標明適用對象，不當作團主分潤比例（請在第 10 題補填「團主分潤比例」）` : '合約條件沒有填團主分潤比例') : ca!.note) : '沒有廠商合作資格審查（合約條件）'),
    sv('FEASIBILITY', f?.hostCommissionPct ?? null, pct(f?.hostCommissionPct ?? null), fVer, feaConfirmed('hostCommissionPct'), f ? feaNote('hostCommissionPct') : '沒有這個商品在此檔期的商業可行性'),
    sv('FINANCE', fin?.ratePercent ?? null, pct(fin?.ratePercent ?? null), fnVer, !!fin && fin.ruleStatus === 'ACTIVE', fin ? finNote : '財務「分潤規則」沒有這位團主在此檔期的費率'),
  ]);
  addField('basis', [
    sv('CONTRACT', c?.basis ?? null, labelBasis(c?.basis ?? null), cVer, cAp && c?.basis != null, c ? (c.basis == null ? '合約條件沒有填分潤基礎' : ca!.note) : '沒有廠商合作資格審查（合約條件）'),
    sv('FEASIBILITY', f?.commissionBasis ?? null, labelBasis(f?.commissionBasis ?? null), fVer, feaConfirmed('commissionBasis'), f ? feaNote('commissionBasis') : '沒有這個商品在此檔期的商業可行性'),
    // 財務結算的分潤基礎由程式固定為「計入銷售訂單的歸因有效淨銷售額」（lib/commission-calc）
    sv('FINANCE', fin ? 'NSV' : null, labelBasis(fin ? 'NSV' : null), fnVer, !!fin, fin ? '結算固定以歸因有效淨銷售額計算（程式規則，lib/commission-calc）' : '沒有適用的財務規則'),
  ]);
  addField('paidBy', [
    sv('CONTRACT', c?.hostPaidBy ?? null, labelPayer(c?.hostPaidBy ?? null), cVer, cAp && c?.hostPaidBy != null, c ? (c.hostPaidBy == null ? '合約條件沒有填付款方' : ca!.note) : '沒有廠商合作資格審查（合約條件）'),
    sv('FEASIBILITY', f?.hostPaidBy ?? null, labelPayer(f?.hostPaidBy ?? null), fVer, feaConfirmed('hostPaidBy'), f ? feaNote('hostPaidBy') : '沒有這個商品在此檔期的商業可行性'),
    sv('FINANCE', null, '未記錄', fnVer, false, '財務結算規則沒有記錄「付款方」（只算佣金金額）'),
  ]);
  addField('period', [
    sv('CONTRACT', c && (c.effectiveFrom || c.effectiveTo) ? period(c.effectiveFrom, c.effectiveTo) : null, period(c?.effectiveFrom ?? null, c?.effectiveTo ?? null), cVer, cAp && !!(c?.effectiveFrom || c?.effectiveTo), c ? (c.effectiveFrom || c.effectiveTo ? ca!.note : '合約條件沒有填適用期間') : '沒有廠商合作資格審查（合約條件）'),
    sv('FINANCE', fin ? period(fin.effectiveFrom, fin.effectiveTo) : null, fin ? period(fin.effectiveFrom, fin.effectiveTo) : '未提供', fnVer, !!fin && fin.ruleStatus === 'ACTIVE', fin ? finNote : '沒有適用的財務規則'),
  ]);

  // 影響範圍：比例差異 × 歸因淨銷售額（只估算；已確認的結算不會被更動）
  const rates = fields[0].values.filter((v) => v.value != null).map((v) => Number(v.value));
  const gap = rates.length >= 2 ? Math.round((Math.max(...rates) - Math.min(...rates)) * 1000) / 1000 : null;
  const settlementConfirmed = fin?.settlement?.status === 'CONFIRMED';
  const impact = {
    attributedNetSales: i.attributedNetSales, maxRateGapPct: gap, estimatedGap: gap == null || gap === 0 ? null : Math.round((i.attributedNetSales * gap) / 100),
    settlementConfirmed,
    note: gap == null || gap === 0 ? '比例沒有差異或資料不足，沒有可估算的金額影響'
      : settlementConfirmed ? '此檔期結算已確認：已確認的結算不會被更動；若要更正，需 Owner 或既有有權角色另案核准'
        : fin?.settlement ? `此檔期有結算草稿（${fin.settlement.status}）：僅供參考，不自動修改` : '此檔期尚無結算；金額為「最大比例差距 × 歸因有效淨銷售額」的估算，不入帳',
  };

  const reviewReasons: string[] = [];
  const different = fields.filter((x) => x.verdict === 'DIFFERENT');
  for (const x of different) reviewReasons.push(`${x.label}：${x.differences[0]}`);
  if (!c) reviewReasons.push('缺少合約條件（廠商合作資格審查）：暫估的可行性條款與財務規則都不視為已核准，需補齊正式合約條件');
  else if (!cAp) reviewReasons.push(`合約條件尚未核准：${ca!.note}`);
  if (f && !['hostCommissionPct', 'commissionBasis', 'hostPaidBy'].every((k) => feaConfirmed(k)) && (f.hostCommissionPct != null || f.commissionBasis != null || f.hostPaidBy != null)) reviewReasons.push('商業可行性的分潤條件有欄位的來源不是合約／正式商務條件（暫估）');
  if (fin?.settlement && fin.settlement.ratePercent != null && fin.settlement.ratePercent !== fin.ratePercent) reviewReasons.push(`結算明細使用的費率（${fin.settlement.ratePercent}%，規則 v${fin.settlement.ruleVersion ?? '—'}）與目前生效規則（${fin.ratePercent}%，v${fin.ruleVersion}）不同`);

  // 缺少正式合約條件：整體標示「資料不足」（其餘兩個來源之間若有差異，仍逐欄列出並列入待覆核）；暫估條款不視為已核准
  const verdict: ReconVerdict = !c ? 'INSUFFICIENT' : different.length ? 'DIFFERENT' : fields.some((x) => x.verdict === 'CONSISTENT') ? 'CONSISTENT' : 'INSUFFICIENT';
  return {
    key: `${i.campaignId}:${i.hostId}:${i.productId}`, campaignId: i.campaignId, campaignTitle: i.campaignTitle, hostId: i.hostId, hostName: i.hostName, productId: i.productId, productName: i.productName,
    fields, verdict, needsManualReview: reviewReasons.length > 0, reviewReasons, impact,
  };
}
