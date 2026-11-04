import { z } from 'zod';

/**
 * 費用歸屬（Owner 決策 K-8a；純規則，沒有資料庫相依）。
 * 區分「費用承擔方」（誰最終負擔）與「實際付款方」（誰實際付錢）；兩者可以不同。
 * 應收／應付是財務的「確認紀錄」，不是付款指示：未確認（UNCONFIRMED）的應收應付只供對照；已確認也不會產生付款、撥款、扣款或發票。
 * 系統提示（claimHint）只是依承擔方與付款方推導的「可能」，永遠不會自動寫入應收應付欄位。
 */
export const PARTIES = ['BRAND', 'COMPANY', 'HOST'] as const;
export const PAYER_PARTIES = ['BRAND', 'COMPANY', 'HOST', 'OTHER'] as const;
export const PARTY_LABEL: Record<string, string> = { BRAND: '品牌', COMPANY: '公司', HOST: '團主', OTHER: '其他（第三方）' };
export const CLAIM_DIRECTIONS = ['RECEIVABLE', 'PAYABLE', 'NONE', 'UNDETERMINED'] as const;
export const CLAIM_LABEL: Record<string, string> = { RECEIVABLE: '公司應收', PAYABLE: '公司應付', NONE: '不產生往來款', UNDETERMINED: '尚未判斷' };
export const PAYMENT_STATUSES = ['UNRECORDED', 'UNPAID', 'PARTIALLY_PAID', 'PAID', 'NOT_APPLICABLE'] as const;
export const PAYMENT_STATUS_LABEL: Record<string, string> = { UNRECORDED: '未記錄', UNPAID: '尚未付款', PARTIALLY_PAID: '部分付款', PAID: '已付款', NOT_APPLICABLE: '不適用' };
export const TERMS_SOURCES = ['CONTRACT', 'FORMAL_TERMS', 'FEASIBILITY', 'MANUAL_ESTIMATE'] as const;
export const TERMS_SOURCE_LABEL: Record<string, string> = { CONTRACT: '合約', FORMAL_TERMS: '正式商務條件（已確認）', FEASIBILITY: '商業可行性條款', MANUAL_ESTIMATE: '人工估計' };
export const NOT_A_PAYMENT_INSTRUCTION = '應收／應付只是財務的確認紀錄，不是付款指示：系統不會因此產生應付款、撥款、扣款或發票；實際付款、發票與結算更正都需另案核准。';

/** 付款憑證／證據連結：只接受 http／https，不含帳號密碼 */
export function evidenceUrlProblem(url: string | null | undefined): string | null {
  if (url == null || url.trim() === '') return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '付款憑證連結只接受 http 或 https';
    if (u.username || u.password) return '付款憑證連結不可含帳號或密碼';
    return null;
  } catch { return '付款憑證連結格式不正確'; }
}

const optParty = z.enum(PARTIES).nullable().optional();
const optPayer = z.enum(PAYER_PARTIES).nullable().optional();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式需為 YYYY-MM-DD');
/** 歸屬欄位（建立與更新共用；全部選填）。金額、類別、日期、檔期沿用既有的費用欄位 */
export const attributionShape = {
  bearerParty: optParty, payerParty: optPayer,
  hostId: z.string().trim().max(40).nullable().optional(), productId: z.string().trim().max(40).nullable().optional(),
  termsSourceKind: z.enum(TERMS_SOURCES).nullable().optional(), termsRef: z.string().trim().max(120).nullable().optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(), paidOn: day.nullable().optional(), paidAmount: z.number().int().min(0).max(10_000_000_000).nullable().optional(),
  evidenceUrl: z.string().trim().max(500).nullable().optional(),
  claimDirection: z.enum(CLAIM_DIRECTIONS).optional(), claimParty: z.enum(PAYER_PARTIES).nullable().optional(), claimNote: z.string().trim().max(300).nullable().optional(),
};

/** 付款狀態與日期、金額的一致性（服務層與資料庫都檢查）；回傳問題清單 */
export function paymentProblems(i: { paymentStatus?: string; paidOn?: string | null; paidAmount?: number | null; amount: number }): string[] {
  const p: string[] = [];
  const st = i.paymentStatus ?? 'UNRECORDED';
  if (st === 'PAID' && !i.paidOn) p.push('已付款需填付款日期');
  if (st === 'PARTIALLY_PAID') {
    if (!i.paidOn) p.push('部分付款需填付款日期');
    if (!i.paidAmount || i.paidAmount <= 0 || i.paidAmount >= i.amount) p.push('部分付款的已付金額需大於 0 且小於費用金額');
  }
  if (['UNRECORDED', 'UNPAID', 'NOT_APPLICABLE'].includes(st) && (i.paidOn || i.paidAmount)) p.push('這個付款狀態不應填付款日期或已付金額');
  return p;
}

/** 應收／應付方向欄位的檢查：有方向就要有對象；承擔方與付款方不必相同 */
export function claimProblems(i: { claimDirection?: string; claimParty?: string | null }): string[] {
  const d = i.claimDirection ?? 'UNDETERMINED';
  return (d === 'RECEIVABLE' || d === 'PAYABLE') && !i.claimParty ? ['填寫應收或應付時需指定對象（向誰收、付給誰）'] : [];
}

/**
 * 依承擔方與實際付款方推導「可能」的往來款（只是提示，永遠不自動寫入）：
 *   公司付款、承擔方是品牌／團主 → 公司可能向承擔方有應收；承擔方是公司、付款方是品牌／團主／第三方 → 公司可能對付款方有應付；其餘沒有或無法判斷。
 */
export function claimHint(bearer: string | null | undefined, payer: string | null | undefined): { kind: 'RECEIVABLE' | 'PAYABLE' | 'NONE' | 'UNKNOWN'; party: string | null; text: string } {
  if (!bearer || !payer) return { kind: 'UNKNOWN', party: null, text: '承擔方或實際付款方未填，無法判斷（不會被當成沒有往來款）' };
  if (bearer === payer) return { kind: 'NONE', party: null, text: '承擔方與付款方相同，沒有往來款' };
  if (payer === 'COMPANY') return { kind: 'RECEIVABLE', party: bearer, text: `公司先付、但由${PARTY_LABEL[bearer]}承擔：公司可能向${PARTY_LABEL[bearer]}有應收（未確認，非付款指示）` };
  if (bearer === 'COMPANY') return { kind: 'PAYABLE', party: payer, text: `由公司承擔、但${PARTY_LABEL[payer]}先付：公司可能對${PARTY_LABEL[payer]}有應付（未確認，非付款指示）` };
  return { kind: 'NONE', party: null, text: `由${PARTY_LABEL[bearer]}承擔、${PARTY_LABEL[payer]}先付：與公司無直接往來（公司不是承擔方或付款方）` };
}

export const ATTRIBUTION_KEYS = ['bearerParty', 'payerParty', 'claimDirection', 'claimParty', 'claimStatus', 'claimConfirmedBy', 'claimConfirmedAt', 'claimNote', 'hostId', 'productId', 'termsSourceKind', 'termsRef', 'paymentStatus', 'paidOn', 'paidAmount', 'evidenceUrl'] as const;

/** 沒有成本檢視權限者看不到費用歸屬（承擔方、付款方、應收應付、憑證等屬敏感商務資料）；只留編號、類別、金額、日期、檔期、狀態 */
export function maskExpenseAttribution<T extends Record<string, unknown>>(row: T, canSee: boolean): T {
  if (canSee) return row;
  const out: Record<string, unknown> = { ...row };
  for (const k of ATTRIBUTION_KEYS) delete out[k];
  out.attributionRestricted = true;
  return out as T;
}
