import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { DD_CATEGORIES } from '@/server/lib/dd-catalog';
import { createDiligence, getDiligence, listVendorDiligence, reviewDiligence, setLegalStatus, submitDiligence, updateDiligence, updateDiligenceItem } from '@/server/modules/diligence';
import { createEvidence } from '@/server/modules/evidence';
import { todayTaipei } from '@/server/lib/ids';
import { addDays } from '@/server/lib/dates';
import type { Actor } from '@/server/lib/permissions';
import { Client } from './api-helper';
import { addUser, makeWorld, mkProduct, mkVendor, type World } from './helpers';

let w: World, other: World;
let ed: Client, mgr: Client, fin: Client, hostC: Client;
let vendorId: string, productId: string;
let hostUser: Actor;
let n = 0;
const today = todayTaipei();

const ver = () => `v${++n}`;
type Item = { id: string; categoryKey: string; status: string; legalStatus: string; terms: Record<string, unknown>; restricted: boolean; evidence: { id: string; url?: string; title?: string; restricted?: boolean }[] };
const items = async (id: string, as: Actor = w.manager) => (await getDiligence(as, id)).items as unknown as Item[];
const item = async (id: string, key: string, as: Actor = w.manager) => (await items(id, as)).find((i) => i.categoryKey === key) as Item;
const evid = (itemId: string, over: Record<string, unknown> = {}, as: Actor = w.manager) =>
  createEvidence(as, { subjectType: 'DD_ITEM', subjectId: itemId, kind: 'CERTIFICATE', title: '[DEMO] 文件', url: 'https://docs.example.invalid/dd', validUntil: addDays(today, 200), ...over } as never);

/** 把 12 類都整理到「可送審」：需證據的附證據並確認、其餘標不適用；法務待審的由主管附法務意見後確認無虞 */
async function makeReady(id: string) {
  for (const c of DD_CATEGORIES) {
    const it = await item(id, c.key);
    if (c.evidenceRequired) { await evid(it.id); await updateDiligenceItem(w.manager, it.id, { status: 'CONFIRMED' }); }
    else await updateDiligenceItem(w.manager, it.id, { status: 'NOT_APPLICABLE', naReason: '[DEMO] 本案無此情況' });
  }
  for (const it of await items(id)) {
    if (it.legalStatus === 'REQUIRED') {
      await evid(it.id, { kind: 'LEGAL_OPINION', title: '[DEMO] 法務意見' });
      await setLegalStatus(w.manager, it.id, { action: 'CLEAR', note: '[DEMO] 法務已確認' });
    }
  }
}

beforeAll(async () => {
  w = await makeWorld(); other = await makeWorld();
  vendorId = (await mkVendor(w, '[DEMO] 家電廠商', { category: '家電' })).id;
  productId = (await mkProduct(w, vendorId, { name: '[DEMO] 不鏽鋼保溫杯' })).id;
  hostUser = await addUser(w.orgId, 'HOST');
  [ed, mgr, fin, hostC] = await Promise.all([Client.forActor(w.editor), Client.forActor(w.manager), Client.forActor(w.finance), Client.forActor(hostUser)]);
});

describe('盡職調查：建立與 12 類', () => {
  it('建立後自動產生 12 類項目（待補件、責任方待確認），含合約版本', async () => {
    const { id } = await createDiligence(w.editor, vendorId, { contractVersion: ver(), contractRef: 'DEMO-合約-001' });
    const list = await items(id);
    expect(list).toHaveLength(12);
    expect(list.map((i) => i.categoryKey).sort()).toEqual(DD_CATEGORIES.map((c) => c.key).sort());
    expect(list.every((i) => i.status === 'PENDING_DOCS')).toBe(true);
    const rec = await getDiligence(w.editor, id);
    expect(rec).toMatchObject({ status: 'DRAFT', contractRef: 'DEMO-合約-001', readiness: { ready: false } });
  });
  it('同廠商＋同商品＋同合約版本不可重複（409）；換新合約版本或限定商品可以；兩份並存', async () => {
    const v = ver();
    await createDiligence(w.editor, vendorId, { contractVersion: v });
    await expect(createDiligence(w.editor, vendorId, { contractVersion: v })).rejects.toMatchObject({ code: 'CONFLICT' });
    await createDiligence(w.editor, vendorId, { contractVersion: v, productId });
    await createDiligence(w.editor, vendorId, { contractVersion: ver() });
    expect((await listVendorDiligence(w.editor, vendorId)).items.length).toBeGreaterThanOrEqual(3);
  });
  it('合約版本必填；商品必須屬於該廠商；冪等鍵重送回同一筆', async () => {
    await expect(createDiligence(w.editor, vendorId, { contractVersion: '  ' })).rejects.toBeTruthy();
    const otherVendor = (await mkVendor(w, '[DEMO] 另一家')).id;
    await expect(createDiligence(w.editor, otherVendor, { contractVersion: ver(), productId })).rejects.toMatchObject({ code: 'VALIDATION' });
    const v = ver();
    const a = await createDiligence(w.editor, vendorId, { contractVersion: v, productId }, 'idem-dd-1');
    const b = await createDiligence(w.editor, vendorId, { contractVersion: v, productId }, 'idem-dd-1');
    expect(b.id).toBe(a.id);
  });
  it('備註含電話被拒；團主沒有入口；跨組織 404', async () => {
    await expect(createDiligence(w.editor, vendorId, { contractVersion: ver(), note: '聯絡 0912-345-678' })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await hostC.call('GET', `/vendors/${vendorId}/diligence`)).status).toBe(403);
    expect((await hostC.call('POST', `/vendors/${vendorId}/diligence`, { contractVersion: 'x' })).status).toBe(403);
    const ov = (await mkVendor(other)).id;
    const od = await createDiligence(other.editor, ov, { contractVersion: ver() });
    expect((await ed.call('GET', `/vendors/${ov}/diligence`)).status).toBe(404);
    expect((await ed.call('GET', `/diligence/${od.id}`)).status).toBe(404);
    expect((await mgr.call('POST', `/diligence/${od.id}/review`, { decision: 'REJECTED', note: 'x' })).status).toBe(404);
  });
});

describe('盡職調查項目：結構化條款、負責人、責任方、證據', () => {
  let id: string;
  beforeAll(async () => { id = (await createDiligence(w.editor, vendorId, { contractVersion: ver() })).id; });

  it('條款依類別驗證；責任方、負責人、備註寫入後讀回', async () => {
    const it7 = await item(id, 'PAYMENT_LIABILITY');
    await updateDiligenceItem(w.editor, it7.id, { terms: { collector: 'BRAND', invoicer: 'COMPANY', afterSalesOwner: 'SHARED' }, responsibleParty: 'SHARED', ownerUserId: w.editor.userId, note: '[DEMO] 備註' });
    expect(await item(id, 'PAYMENT_LIABILITY')).toMatchObject({ terms: { collector: 'BRAND', invoicer: 'COMPANY', afterSalesOwner: 'SHARED' }, responsibleParty: 'SHARED', ownerUserId: w.editor.userId, note: '[DEMO] 備註' });
    await expect(updateDiligenceItem(w.editor, it7.id, { terms: { collector: '廠商' } })).rejects.toBeTruthy();
    await expect(updateDiligenceItem(w.editor, it7.id, { terms: { collector: 'BRAND', extra: 1 } })).rejects.toBeTruthy();
  });
  it('負責人必須是啟用中的內部使用者（團主帳號、不存在者被拒）', async () => {
    const it2 = await item(id, 'PRICING');
    await expect(updateDiligenceItem(w.editor, it2.id, { ownerUserId: hostUser.userId })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateDiligenceItem(w.editor, it2.id, { ownerUserId: 'USR-9999' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  it('不適用必填原因、有風險必填說明', async () => {
    const it3 = await item(id, 'MOQ');
    await expect(updateDiligenceItem(w.editor, it3.id, { status: 'NOT_APPLICABLE' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateDiligenceItem(w.editor, it3.id, { status: 'AT_RISK' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await updateDiligenceItem(w.editor, it3.id, { status: 'AT_RISK', riskNote: '[DEMO] MOQ 偏高' });
    expect(await item(id, 'MOQ')).toMatchObject({ status: 'AT_RISK' });
  });
  it('需證據的類別：沒有證據、只有過期證據都不能標已確認；有一筆有效證據才行', async () => {
    const it1 = await item(id, 'SOURCE_LICENSE_QA');
    await expect(updateDiligenceItem(w.editor, it1.id, { status: 'CONFIRMED' })).rejects.toThrow(/有效/);
    await evid(it1.id, { validUntil: addDays(today, -1) }, w.editor);
    await expect(updateDiligenceItem(w.editor, it1.id, { status: 'CONFIRMED' })).rejects.toThrow(/有效/);
    await evid(it1.id, {}, w.editor);
    await updateDiligenceItem(w.editor, it1.id, { status: 'CONFIRMED' });
    expect(await item(id, 'SOURCE_LICENSE_QA')).toMatchObject({ status: 'CONFIRMED' });
  });
  it('樂觀鎖：用舊版本更新 → 409', async () => {
    const it4 = await item(id, 'STOCK_LEADTIME') as Item & { version: number };
    await updateDiligenceItem(w.editor, it4.id, { terms: { leadTimeDays: 7 } });
    await expect(updateDiligenceItem(w.editor, it4.id, { terms: { leadTimeDays: 9 }, version: it4.version })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('稽核留下前後值', async () => {
    const a = await query(`SELECT before_data, after_data FROM audit_logs WHERE organization_id=$1 AND action='selection.dd.item.update' AND after_data->>'category'='PAYMENT_LIABILITY'`, [w.orgId]);
    expect(a.length).toBeGreaterThan(0);
    expect(JSON.stringify(a[0].after_data)).toContain('SHARED');
  });
});

describe('敏感條款：第 10 類分潤，沿用 product.cost.read', () => {
  let id: string;
  beforeAll(async () => { id = (await createDiligence(w.editor, vendorId, { contractVersion: ver() })).id; });

  it('營運小編不能填分潤條款、狀態、備註（403），只能指派負責人與責任方', async () => {
    const it10 = await item(id, 'COMMISSION_TERMS');
    await expect(updateDiligenceItem(w.editor, it10.id, { terms: { ratePercent: 10 } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(updateDiligenceItem(w.editor, it10.id, { status: 'NOT_APPLICABLE', naReason: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(updateDiligenceItem(w.editor, it10.id, { note: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await updateDiligenceItem(w.editor, it10.id, { ownerUserId: w.finance.userId, responsibleParty: 'COMPANY' });
    expect(await item(id, 'COMMISSION_TERMS')).toMatchObject({ ownerUserId: w.finance.userId, responsibleParty: 'COMPANY' });
  });
  it('主管填入後：主管與財務讀得到；營運小編讀到的條款是空的並標 restricted，備註也不外露', async () => {
    const it10 = await item(id, 'COMMISSION_TERMS');
    await updateDiligenceItem(w.manager, it10.id, { terms: { basis: 'NSV', ratePercent: 12, settlementCycleDays: 30 }, note: '[DEMO] 內部分潤備註' });
    expect((await item(id, 'COMMISSION_TERMS', w.manager)).terms).toEqual({ basis: 'NSV', ratePercent: 12, settlementCycleDays: 30 });
    expect((await item(id, 'COMMISSION_TERMS', w.finance)).terms).toMatchObject({ ratePercent: 12 });
    const seen = await item(id, 'COMMISSION_TERMS', w.editor);
    expect(seen).toMatchObject({ terms: {}, restricted: true, note: null });
    // 透過 API 的原始回應也不含數字
    const raw = JSON.stringify((await ed.call('GET', `/diligence/${id}`)).json);
    expect(raw).not.toContain('"ratePercent":12');      // 欄位名稱會出現在表單定義，數值不可出現
    expect(raw).not.toContain('settlementCycleDays":30');
    expect(raw).not.toContain('內部分潤備註');
  });
  it('這一類的證據連結：小編看不到標題與連結，也不能新增；主管可以', async () => {
    const it10 = await item(id, 'COMMISSION_TERMS');
    await expect(evid(it10.id, {}, w.editor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await evid(it10.id, { kind: 'CONTRACT', title: '[DEMO] 分潤合約', url: 'https://docs.example.invalid/commission-contract' });
    const seen = await item(id, 'COMMISSION_TERMS', w.editor);
    expect(seen.evidence).toHaveLength(1);
    expect(seen.evidence[0]).toMatchObject({ restricted: true });
    expect(seen.evidence[0].url).toBeUndefined();
    expect(seen.evidence[0].title).toBeUndefined();
    expect((await item(id, 'COMMISSION_TERMS', w.manager)).evidence[0].url).toContain('commission-contract');
  });
  it('編輯其他欄位時，小編不會把既有的分潤條款清掉', async () => {
    const it10 = await item(id, 'COMMISSION_TERMS');
    await updateDiligenceItem(w.editor, it10.id, { responsibleParty: 'BRAND' });
    expect((await item(id, 'COMMISSION_TERMS', w.manager)).terms).toMatchObject({ ratePercent: 12 });
  });
  it('稽核不記錄分潤條款內容', async () => {
    const a = await query<{ after_data: unknown; before_data: unknown }>(`SELECT before_data, after_data FROM audit_logs WHERE organization_id=$1 AND action='selection.dd.item.update' AND after_data->>'category'='COMMISSION_TERMS'`, [w.orgId]);
    expect(a.length).toBeGreaterThan(0);
    expect(JSON.stringify(a)).not.toContain('ratePercent');
  });
});

describe('法務／合規審查標示：不自行假定合法', () => {
  it('勾選轉售價格限制 → 第 11 類自動標「需法務／合規審查」', async () => {
    const { id } = await createDiligence(w.editor, vendorId, { contractVersion: ver() });
    const it11 = await item(id, 'EXCLUSIVITY_RESALE');
    expect(it11.legalStatus).toBe('NOT_REQUIRED');
    await updateDiligenceItem(w.editor, it11.id, { terms: { resalePriceRestriction: true } });
    expect(await item(id, 'EXCLUSIVITY_RESALE')).toMatchObject({ legalStatus: 'REQUIRED' });
  });
  it('選了受規範品類 → 第 1 類標需審；食品類廠商建立時直接標疑似', async () => {
    const { id } = await createDiligence(w.editor, vendorId, { contractVersion: ver() });
    await updateDiligence(w.editor, id, { regulatedCategory: 'SUPPLEMENT' });
    expect(await item(id, 'SOURCE_LICENSE_QA')).toMatchObject({ legalStatus: 'REQUIRED' });
    const food = await mkVendor(w, '[DEMO] 食品廠商', { category: '食品' });
    const d2 = await createDiligence(w.editor, food.id, { contractVersion: ver() });
    expect(await item(d2.id, 'SOURCE_LICENSE_QA')).toMatchObject({ legalStatus: 'REQUIRED' });
    const sup = await mkProduct(w, vendorId, { name: '[DEMO] 益生菌膠囊' });
    const d3 = await createDiligence(w.editor, vendorId, { contractVersion: ver(), productId: sup.id });
    expect(await item(d3.id, 'SOURCE_LICENSE_QA')).toMatchObject({ legalStatus: 'REQUIRED' });
  });
  it('未結案的法務審查擋住送審；小編不能確認無虞（403）；確認無虞需先附法務意見證據', async () => {
    const { id } = await createDiligence(w.editor, vendorId, { contractVersion: ver() });
    await updateDiligence(w.editor, id, { regulatedCategory: 'FOOD' });
    const it1 = await item(id, 'SOURCE_LICENSE_QA');
    await expect(setLegalStatus(w.editor, it1.id, { action: 'CLEAR', note: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(setLegalStatus(w.manager, it1.id, { action: 'CLEAR', note: '[DEMO] ok' })).rejects.toThrow(/法務意見/);
    await evid(it1.id, { kind: 'CERTIFICATE' });                                         // 不是法務意見類 → 仍不行
    await expect(setLegalStatus(w.manager, it1.id, { action: 'CLEAR', note: '[DEMO] ok' })).rejects.toThrow(/法務意見/);
    await evid(it1.id, { kind: 'LEGAL_OPINION', validUntil: addDays(today, -1) });       // 過期的法務意見 → 不行
    await expect(setLegalStatus(w.manager, it1.id, { action: 'CLEAR', note: '[DEMO] ok' })).rejects.toThrow(/法務意見/);
    await evid(it1.id, { kind: 'LEGAL_OPINION' });
    expect(await setLegalStatus(w.manager, it1.id, { action: 'CLEAR', note: '[DEMO] 法務已確認標示' })).toMatchObject({ legalStatus: 'CLEARED' });
    const done = await item(id, 'SOURCE_LICENSE_QA') as Item & { legalClearedBy: string };
    expect(done.legalClearedBy).toBe(w.manager.userId);
  });
  it('法務封鎖＝不得合作；自動觸發條件仍成立時不能直接解除標示', async () => {
    const { id } = await createDiligence(w.editor, vendorId, { contractVersion: ver() });
    await updateDiligence(w.editor, id, { regulatedCategory: 'MEDICAL_DEVICE' });
    const it1 = await item(id, 'SOURCE_LICENSE_QA');
    await expect(setLegalStatus(w.manager, it1.id, { action: 'RELEASE', note: '[DEMO] 解除' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await setLegalStatus(w.manager, it1.id, { action: 'BLOCK', note: '[DEMO] 標示不合規' });
    expect(await item(id, 'SOURCE_LICENSE_QA')).toMatchObject({ legalStatus: 'BLOCKED' });
    await expect(submitDiligence(w.editor, id)).rejects.toThrow(/法務/);
  });
  it('手動標示需審：任何填報者可以；說明必填', async () => {
    const { id } = await createDiligence(w.editor, vendorId, { contractVersion: ver() });
    const it2 = await item(id, 'PRICING');
    await expect(setLegalStatus(w.editor, it2.id, { action: 'REQUIRE' } as never)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await setLegalStatus(w.editor, it2.id, { action: 'REQUIRE', note: '[DEMO] 價格條款需確認' })).toMatchObject({ legalStatus: 'REQUIRED' });
    // 沒有觸發條件 → 可由主管解除
    expect(await setLegalStatus(w.manager, it2.id, { action: 'RELEASE', note: '[DEMO] 經確認不需審' })).toMatchObject({ legalStatus: 'NOT_REQUIRED' });
  });
});

describe('送審、核准、有效期、撤銷', () => {
  it('未備齊不能送審，並說明原因', async () => {
    const { id } = await createDiligence(w.editor, vendorId, { contractVersion: ver() });
    await expect(submitDiligence(w.editor, id)).rejects.toThrow(/待補件/);
  });
  it('備齊 → 送審（審查中不可再編輯）→ 小編不能核准 → 主管核准，有效期預設 365 天', async () => {
    const { id } = await createDiligence(w.editor, vendorId, { contractVersion: ver(), contractRef: 'DEMO-合約-A' });
    await makeReady(id);
    expect((await getDiligence(w.editor, id)).readiness).toMatchObject({ ready: true });
    expect(await submitDiligence(w.editor, id)).toMatchObject({ status: 'IN_REVIEW' });
    const it2 = await item(id, 'PRICING');
    await expect(updateDiligenceItem(w.manager, it2.id, { note: 'x' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(updateDiligence(w.manager, id, { note: 'x' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(reviewDiligence(w.editor, id, { decision: 'APPROVED' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const r = await reviewDiligence(w.manager, id, { decision: 'APPROVED', note: '[DEMO] 通過' });
    expect(r).toMatchObject({ status: 'APPROVED', validUntil: addDays(today, 365) });
    expect(await getDiligence(w.manager, id)).toMatchObject({ status: 'APPROVED', validUntil: addDays(today, 365), validity: { valid: true }, reviewedByName: expect.any(String) });
  });
  it('有效期不得超過上限或早於今天；退回需原因；已核准的調查不能增減證據', async () => {
    const { id } = await createDiligence(w.editor, vendorId, { contractVersion: ver() });
    await makeReady(id); await submitDiligence(w.editor, id);
    await expect(reviewDiligence(w.manager, id, { decision: 'APPROVED', validUntil: addDays(today, 366) })).rejects.toThrow(/不可超過/);
    await expect(reviewDiligence(w.manager, id, { decision: 'APPROVED', validUntil: addDays(today, -1) })).rejects.toThrow(/早於今天/);
    await expect(reviewDiligence(w.manager, id, { decision: 'REJECTED' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await reviewDiligence(w.manager, id, { decision: 'APPROVED', validUntil: addDays(today, 30) });
    const it1 = await item(id, 'SOURCE_LICENSE_QA');
    await expect(evid(it1.id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
  it('到期自動視為失效（不改資料）：valid_until 已過 → validity.valid=false 且說明原因', async () => {
    const { id } = await createDiligence(w.editor, vendorId, { contractVersion: ver() });
    await makeReady(id); await submitDiligence(w.editor, id); await reviewDiligence(w.manager, id, { decision: 'APPROVED' });
    await query(`UPDATE vendor_dd_records SET valid_until=$2 WHERE id=$1`, [id, addDays(today, -1)]);
    const rec = await getDiligence(w.manager, id);
    expect(rec).toMatchObject({ status: 'APPROVED', validity: { valid: false } });
    expect((rec.validity as { reasons: string[] }).reasons[0]).toContain('到期');
  });
  it('核准後證據過期 → 也視為失效', async () => {
    const { id } = await createDiligence(w.editor, vendorId, { contractVersion: ver() });
    await makeReady(id); await submitDiligence(w.editor, id); await reviewDiligence(w.manager, id, { decision: 'APPROVED' });
    await query(`UPDATE evidence_items SET valid_until=$2 WHERE organization_id=$1 AND subject_type='DD_ITEM' AND subject_id IN (SELECT id FROM vendor_dd_items WHERE record_id=$3) AND kind='CERTIFICATE'`, [w.orgId, addDays(today, -2), id]);
    const rec = await getDiligence(w.manager, id);
    expect((rec.validity as { valid: boolean; reasons: string[] }).valid).toBe(false);
    expect((rec.validity as { reasons: string[] }).reasons.join()).toContain('證據已過期');
  });
  it('送審後才發現證據過期 → 核准被擋', async () => {
    const { id } = await createDiligence(w.editor, vendorId, { contractVersion: ver() });
    await makeReady(id); await submitDiligence(w.editor, id);
    await query(`UPDATE evidence_items SET valid_until=$2 WHERE organization_id=$1 AND subject_type='DD_ITEM' AND subject_id IN (SELECT id FROM vendor_dd_items WHERE record_id=$3)`, [w.orgId, addDays(today, -2), id]);
    await expect(reviewDiligence(w.manager, id, { decision: 'APPROVED' })).rejects.toThrow(/過期/);
  });
  it('退回後可再編輯、再送審；撤銷已核准的調查需原因，之後回到可編輯', async () => {
    const { id } = await createDiligence(w.editor, vendorId, { contractVersion: ver() });
    await makeReady(id); await submitDiligence(w.editor, id);
    await reviewDiligence(w.manager, id, { decision: 'REJECTED', note: '[DEMO] 請補報價' });
    expect(await getDiligence(w.editor, id)).toMatchObject({ status: 'REJECTED', reviewNote: '[DEMO] 請補報價', editable: true });
    await submitDiligence(w.editor, id);
    await reviewDiligence(w.manager, id, { decision: 'APPROVED' });
    await expect(reviewDiligence(w.manager, id, { decision: 'REJECTED' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await reviewDiligence(w.manager, id, { decision: 'REJECTED', note: '[DEMO] 發現合約變更' });
    expect(await getDiligence(w.editor, id)).toMatchObject({ status: 'REJECTED', validUntil: null, editable: true });
    const acts = (await query<{ action: string }>(`SELECT action FROM audit_logs WHERE entity_id=$1 ORDER BY id`, [id])).map((a) => a.action);
    expect(acts).toEqual(expect.arrayContaining(['selection.dd.create', 'selection.dd.submit', 'selection.dd.reject', 'selection.dd.approve', 'selection.dd.revoke']));
  });
  it('資料庫保證：只軟刪除；核准必有有效期與審核者', async () => {
    const { id } = await createDiligence(w.editor, vendorId, { contractVersion: ver() });
    await expect(query(`DELETE FROM vendor_dd_records WHERE id=$1`, [id])).rejects.toThrow();
    await expect(query(`DELETE FROM vendor_dd_items WHERE record_id=$1`, [id])).rejects.toThrow();
    await expect(query(`UPDATE vendor_dd_records SET status='APPROVED' WHERE id=$1`, [id])).rejects.toThrow();
  });
});

describe('財務唯讀、列表', () => {
  it('財務可讀不可寫（403）', async () => {
    const { id } = await createDiligence(w.editor, vendorId, { contractVersion: ver() });
    expect((await fin.call('GET', `/diligence/${id}`)).status).toBe(200);
    expect((await fin.call('PATCH', `/diligence/${id}`, { note: 'x' })).status).toBe(403);
    expect((await fin.call('POST', `/vendors/${vendorId}/diligence`, { contractVersion: 'zz' })).status).toBe(403);
  });
  it('廠商詳情列表附準備度與有效性摘要', async () => {
    const r = await listVendorDiligence(w.manager, vendorId);
    expect(r.items.length).toBeGreaterThan(5);
    expect(r.items[0]).toHaveProperty('readiness');
    expect(r.items[0]).toHaveProperty('validity');
    expect(r.config.ddValidDays).toBe(365);
  });
});
