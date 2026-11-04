import { describe, expect, it } from 'vitest';
import { ATTRIBUTION_KEYS, claimHint, claimProblems, evidenceUrlProblem, maskExpenseAttribution, paymentProblems, NOT_A_PAYMENT_INSTRUCTION } from '@/server/lib/expense-attribution';

describe('K-8a 費用歸屬規則（純函式）', () => {
  it('承擔方與實際付款方可以分別記錄、可以不同；系統提示只是「可能」，永遠不自動成為應收應付', () => {
    expect(claimHint('BRAND', 'COMPANY')).toMatchObject({ kind: 'RECEIVABLE', party: 'BRAND' });
    expect(claimHint('COMPANY', 'HOST')).toMatchObject({ kind: 'PAYABLE', party: 'HOST' });
    expect(claimHint('COMPANY', 'COMPANY')).toMatchObject({ kind: 'NONE' });
    expect(claimHint('BRAND', 'HOST')).toMatchObject({ kind: 'NONE' });             // 公司不是承擔方也不是付款方
    expect(claimHint('BRAND', null).kind).toBe('UNKNOWN');                           // 缺資料＝無法判斷，不是「沒有往來款」
    expect(claimHint(null, 'COMPANY').kind).toBe('UNKNOWN');
    expect(claimHint('BRAND', 'COMPANY').text).toContain('未確認，非付款指示');
    expect(claimHint('COMPANY', 'BRAND').text).toContain('未確認，非付款指示');
  });
  it('付款狀態與日期、已付金額必須一致', () => {
    expect(paymentProblems({ paymentStatus: 'PAID', paidOn: null, amount: 100 }).join()).toContain('付款日期');
    expect(paymentProblems({ paymentStatus: 'PAID', paidOn: '2026-11-01', amount: 100 })).toEqual([]);
    expect(paymentProblems({ paymentStatus: 'PARTIALLY_PAID', paidOn: '2026-11-01', paidAmount: 100, amount: 100 }).join()).toContain('大於 0 且小於');
    expect(paymentProblems({ paymentStatus: 'PARTIALLY_PAID', paidOn: '2026-11-01', paidAmount: 40, amount: 100 })).toEqual([]);
    expect(paymentProblems({ paymentStatus: 'UNPAID', paidOn: '2026-11-01', amount: 100 }).join()).toContain('不應填');
    expect(paymentProblems({ amount: 100 })).toEqual([]);                            // 沒填＝未記錄（舊資料相容）
  });
  it('應收或應付一定要指定對象', () => {
    expect(claimProblems({ claimDirection: 'RECEIVABLE', claimParty: null }).join()).toContain('指定對象');
    expect(claimProblems({ claimDirection: 'PAYABLE', claimParty: 'HOST' })).toEqual([]);
    expect(claimProblems({ claimDirection: 'UNDETERMINED' })).toEqual([]);
  });
  it('付款憑證連結：只收 http／https、不含帳密', () => {
    expect(evidenceUrlProblem('https://docs.example.invalid/receipt/1')).toBeNull();
    expect(evidenceUrlProblem('')).toBeNull();
    expect(evidenceUrlProblem('javascript:alert(1)')).toContain('http');
    expect(evidenceUrlProblem('ftp://x.example.invalid/a')).toContain('http');
    expect(evidenceUrlProblem('https://user:pass@docs.example.invalid/a')).toContain('帳號或密碼');
    expect(evidenceUrlProblem('not a url')).toContain('格式');
  });
  it('沒有成本檢視權限：歸屬欄位全部移除並標示受限；有權限者原樣', () => {
    const row = { id: 'EXP-1', category: 'SHIPPING', amount: 700, bearerParty: 'BRAND', payerParty: 'COMPANY', claimDirection: 'RECEIVABLE', claimStatus: 'CONFIRMED', evidenceUrl: 'https://x.example.invalid/r', paidAmount: 10 };
    const m = maskExpenseAttribution(row, false) as Record<string, unknown>;
    for (const k of ATTRIBUTION_KEYS) expect(m).not.toHaveProperty(k);
    expect(m).toMatchObject({ id: 'EXP-1', category: 'SHIPPING', amount: 700, attributionRestricted: true });
    expect(maskExpenseAttribution(row, true)).toEqual(row);
  });
  it('明講應收應付不是付款指示', () => {
    expect(NOT_A_PAYMENT_INSTRUCTION).toContain('不是付款指示');
    expect(NOT_A_PAYMENT_INSTRUCTION).toContain('撥款');
    expect(NOT_A_PAYMENT_INSTRUCTION).toContain('扣款');
  });
});
