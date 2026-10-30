import { describe, expect, it } from 'vitest';
import {
  DD_CATEGORIES, DD_KEYS, DD_UI_FIELDS, ddReadiness, evidenceHostAllowed, evidenceState, legalTriggers, maskTerms, parseTerms, suspectRegulated, touchesSensitive,
} from '@/server/lib/dd-catalog';

describe('SOP02 盡職調查 12 類目錄', () => {
  it('恰好 12 類、鍵不重複、編號 1–12、每類有問題與結構化欄位', () => {
    expect(DD_CATEGORIES).toHaveLength(12);
    expect(new Set(DD_KEYS).size).toBe(12);
    expect(DD_CATEGORIES.map((c) => c.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const c of DD_CATEGORIES) { expect(c.question.length).toBeGreaterThan(5); expect(Object.keys(c.terms.shape).length).toBeGreaterThan(0); }
  });
  it('必附證據的類別是 1、7、8、9、10、11（D-35 建議值）', () => {
    expect(DD_CATEGORIES.filter((c) => c.evidenceRequired).map((c) => c.no)).toEqual([1, 7, 8, 9, 10, 11]);
  });
  it('條款是結構化欄位並驗證：責任方、期限、金額、比例', () => {
    expect(parseTerms('PAYMENT_LIABILITY', { collector: 'BRAND', invoicer: 'COMPANY', afterSalesOwner: 'SHARED' })).toEqual({ collector: 'BRAND', invoicer: 'COMPANY', afterSalesOwner: 'SHARED' });
    expect(() => parseTerms('PAYMENT_LIABILITY', { collector: '廠商' })).toThrow();
    expect(() => parseTerms('PAYMENT_LIABILITY', { unknownField: 1 })).toThrow();              // strict：多餘欄位被拒
    expect(() => parseTerms('COMMISSION_TERMS', { ratePercent: 120 })).toThrow();
    expect(() => parseTerms('MOQ', { moqQty: -1 })).toThrow();
    expect(() => parseTerms('SOURCE_LICENSE_QA', { authorizationValidUntil: '2026/01/01' })).toThrow();
    expect(parseTerms('CONTINGENCY', undefined)).toEqual({});
  });
});

describe('畫面欄位定義與條款 schema 一致', () => {
  it('每一類的畫面欄位與 zod 條款欄位完全相同（名稱），選項值都被 schema 接受', () => {
    for (const c of DD_CATEGORIES) {
      expect(DD_UI_FIELDS[c.key].map((f) => f.name).sort(), c.key).toEqual(Object.keys(c.terms.shape).sort());
      for (const f of DD_UI_FIELDS[c.key]) for (const o of f.options ?? []) expect(() => parseTerms(c.key, { [f.name]: o.value }), `${c.key}.${f.name}=${o.value}`).not.toThrow();
    }
  });
});

describe('敏感條款（第 10 類分潤）', () => {
  const terms = { basis: 'NSV', ratePercent: 12, settlementCycleDays: 30, termsNote: 'x' };
  it('沒有權限的角色看不到分潤欄位並標示 restricted；有權限者完整', () => {
    expect(maskTerms('COMMISSION_TERMS', terms, false)).toEqual({ terms: {}, restricted: true });
    expect(maskTerms('COMMISSION_TERMS', terms, true)).toEqual({ terms, restricted: false });
    expect(maskTerms('PRICING', { listPrice: 100 }, false)).toEqual({ terms: { listPrice: 100 }, restricted: false });   // 其他類別不受影響
  });
  it('touchesSensitive 辨識敏感欄位', () => {
    expect(touchesSensitive('COMMISSION_TERMS', { ratePercent: 5 })).toBe(true);
    expect(touchesSensitive('COMMISSION_TERMS', {})).toBe(false);
    expect(touchesSensitive('PRICING', { listPrice: 5 })).toBe(false);
  });
});

describe('法務／合規審查標示（不自行假定合法）', () => {
  it('轉售價格限制 → 需法務審查', () => {
    const t = legalTriggers({ categoryKey: 'EXCLUSIVITY_RESALE', terms: { resalePriceRestriction: true }, regulatedCategory: null, suspected: [] });
    expect(t.required).toBe(true);
    expect(t.reasons[0]).toContain('轉售價格限制');
    expect(legalTriggers({ categoryKey: 'EXCLUSIVITY_RESALE', terms: { resalePriceRestriction: false }, regulatedCategory: null, suspected: [] }).required).toBe(false);
  });
  it('受規範品類（明示或疑似）→ 需法務／合規審查，標在第 1 類', () => {
    expect(legalTriggers({ categoryKey: 'SOURCE_LICENSE_QA', terms: {}, regulatedCategory: 'FOOD', suspected: [] }).required).toBe(true);
    const sus = legalTriggers({ categoryKey: 'SOURCE_LICENSE_QA', terms: {}, regulatedCategory: null, suspected: ['SUPPLEMENT'] });
    expect(sus.required).toBe(true);
    expect(sus.reasons[0]).toContain('疑似');
    expect(legalTriggers({ categoryKey: 'PRICING', terms: {}, regulatedCategory: 'FOOD', suspected: [] }).required).toBe(false);
  });
  it('關鍵字偵測：食品、保健、醫療、化妝、嬰幼兒；一般商品不誤報', () => {
    expect(suspectRegulated('冷凍水餃 食品')).toContain('FOOD');
    expect(suspectRegulated('益生菌膠囊')).toContain('SUPPLEMENT');
    expect(suspectRegulated('家用血壓計')).toContain('MEDICAL_DEVICE');
    expect(suspectRegulated('保濕面膜')).toContain('COSMETIC');
    expect(suspectRegulated('嬰兒奶瓶')).toContain('CHILD_PRODUCT');
    expect(suspectRegulated('不鏽鋼保溫杯', '廚房用品', null)).toEqual([]);
  });
});

describe('證據有效期與調查準備度', () => {
  it('證據狀態：已過期／即將到期／有效／無期限', () => {
    expect(evidenceState({ id: 'a', validUntil: '2026-01-01' }, '2026-02-01', 30)).toBe('EXPIRED');
    expect(evidenceState({ id: 'a', validUntil: '2026-02-01' }, '2026-02-01', 30)).toBe('EXPIRING');   // 當天到期仍算有效但即將到期
    expect(evidenceState({ id: 'a', validUntil: '2026-03-03' }, '2026-02-01', 30)).toBe('EXPIRING');   // 30 天邊界
    expect(evidenceState({ id: 'a', validUntil: '2026-03-04' }, '2026-02-01', 30)).toBe('VALID');
    expect(evidenceState({ id: 'a', validUntil: null }, '2026-02-01', 30)).toBe('NO_EXPIRY');
  });
  const item = (key: string, status: string, ev: { validUntil: string | null }[] = [], legalStatus = 'NOT_REQUIRED') => ({ key, status, legalStatus, evidence: ev.map((e, i) => ({ id: `E${i}`, ...e })) });
  const twelve = (over: Record<string, ReturnType<typeof item>> = {}) => DD_CATEGORIES.map((c) => over[c.key] ?? item(c.key, c.evidenceRequired ? 'CONFIRMED' : 'NOT_APPLICABLE', c.evidenceRequired ? [{ validUntil: '2027-01-01' }] : []));
  it('12 項皆已確認／不適用、證據有效、無風險、無法務 → ready', () => {
    const r = ddReadiness(twelve(), '2026-06-01', 30);
    expect(r.ready).toBe(true);
    expect(r.reasons).toEqual([]);
  });
  it('待補件、有風險、證據過期、法務未結、已確認但沒有有效證據、項目不足 → 都擋下並說明原因', () => {
    expect(ddReadiness(twelve({ MOQ: item('MOQ', 'PENDING_DOCS') }), '2026-06-01', 30).reasons).toContain('1 項待補件');
    expect(ddReadiness(twelve({ MOQ: item('MOQ', 'AT_RISK') }), '2026-06-01', 30).reasons).toContain('1 項有風險');
    const expired = ddReadiness(twelve({ SOURCE_LICENSE_QA: item('SOURCE_LICENSE_QA', 'CONFIRMED', [{ validUntil: '2026-05-01' }]) }), '2026-06-01', 30);
    expect(expired.ready).toBe(false);
    expect(expired.expired).toBe(1);
    expect(expired.missingEvidence).toContain('商品來源、品牌授權與品質檢驗');   // 唯一證據已過期＝等於沒有有效證據
    expect(ddReadiness(twelve({ EXCLUSIVITY_RESALE: item('EXCLUSIVITY_RESALE', 'CONFIRMED', [{ validUntil: null }], 'REQUIRED') }), '2026-06-01', 30).legalPending).toBe(1);
    expect(ddReadiness(twelve({ EXCLUSIVITY_RESALE: item('EXCLUSIVITY_RESALE', 'CONFIRMED', [{ validUntil: null }], 'BLOCKED') }), '2026-06-01', 30).ready).toBe(false);
    expect(ddReadiness(twelve({ EXCLUSIVITY_RESALE: item('EXCLUSIVITY_RESALE', 'CONFIRMED', [{ validUntil: null }], 'CLEARED') }), '2026-06-01', 30).ready).toBe(true);
    expect(ddReadiness(twelve().slice(0, 11), '2026-06-01', 30).reasons).toContain('12 類問題尚未全部建立');
  });
});

describe('證據連結網域白名單', () => {
  it('空白名單＝不限制；有名單時只接受網域本身或子網域', () => {
    expect(evidenceHostAllowed('https://anything.example/x', [])).toBe(true);
    expect(evidenceHostAllowed('https://drive.corp.example/x', ['corp.example'])).toBe(true);
    expect(evidenceHostAllowed('https://corp.example/x', ['*.corp.example'])).toBe(true);
    expect(evidenceHostAllowed('https://evilcorp.example/x', ['corp.example'])).toBe(false);   // 不能只比結尾字串
    expect(evidenceHostAllowed('not a url', ['corp.example'])).toBe(false);
  });
});
