import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { DD_CATEGORIES } from '@/server/lib/dd-catalog';
import { bestDiligence, createDiligence, getDiligence, reviewDiligence, setLegalStatus, submitDiligence, updateDiligenceItem, withdrawDiligence } from '@/server/modules/diligence';
import { createEvidence } from '@/server/modules/evidence';
import { todayTaipei } from '@/server/lib/ids';
import { addDays } from '@/server/lib/dates';
import type { Actor } from '@/server/lib/permissions';
import { Client } from './api-helper';
import { addUser, makeWorld, mkProduct, mkVendor, type World } from './helpers';

let w: World;
let ed: Client;
let vendorId: string, other: Actor;
let n = 0;
const today = todayTaipei();
const ver = () => `v2-${++n}`;
type Item = { id: string; categoryKey: string; status: string; legalStatus: string; terms: Record<string, unknown>; naReason?: string | null; legalNote?: string | null; legalReason?: string | null };
const items = async (id: string, as: Actor = w.manager) => (await getDiligence(as, id)).items as unknown as Item[];
const item = async (id: string, key: string, as: Actor = w.manager) => (await items(id, as)).find((i) => i.categoryKey === key) as Item;
const evid = (itemId: string, over: Record<string, unknown> = {}, as: Actor = w.manager) =>
  createEvidence(as, { subjectType: 'DD_ITEM', subjectId: itemId, kind: 'CERTIFICATE', title: '[DEMO] 文件', url: 'https://docs.example.invalid/dd', validUntil: addDays(today, 200), ...over } as never);

async function makeReady(id: string, over: Record<string, Record<string, unknown>> = {}) {
  for (const c of DD_CATEGORIES) {
    const it = await item(id, c.key);
    if (over[c.key]) await updateDiligenceItem(w.manager, it.id, { terms: over[c.key] } as never);
    if (c.evidenceRequired) { await evid(it.id); await updateDiligenceItem(w.manager, it.id, { status: 'CONFIRMED' }); }
    else await updateDiligenceItem(w.manager, it.id, { status: 'NOT_APPLICABLE', naReason: '[DEMO] 本案無此情況' });
  }
  for (const it of await items(id)) if (it.legalStatus === 'REQUIRED') { await evid(it.id, { kind: 'LEGAL_OPINION', title: '[DEMO] 法務意見' }); await setLegalStatus(w.manager, it.id, { action: 'CLEAR', note: '[DEMO] 法務已確認' }); }
}
const approve = async (id: string) => reviewDiligence(w.manager, id, { decision: 'APPROVED' });

beforeAll(async () => {
  w = await makeWorld();
  vendorId = (await mkVendor(w, '[DEMO] 12 題廠商', { category: '文具' })).id;
  other = await addUser(w.orgId, 'OPS_EDITOR');
  ed = await Client.forActor(w.editor);
});

describe('12 題：敏感類別的自由文字不外洩（修補）', () => {
  it('分潤題的不適用原因、法務說明與備註，沒有成本權限者看到的是占位字；原始回應不含內容', async () => {
    const { id } = await createDiligence(w.manager, vendorId, { contractVersion: ver() });
    const it10 = await item(id, 'COMMISSION_TERMS');
    await updateDiligenceItem(w.manager, it10.id, { status: 'NOT_APPLICABLE', naReason: '[DEMO] 分潤固定 13.7%，不適用階梯' });
    await setLegalStatus(w.manager, it10.id, { action: 'REQUIRE', note: '[DEMO] 請法務看 13.7% 抽成條款' });
    const mgrView = await item(id, 'COMMISSION_TERMS', w.manager);
    expect(mgrView.naReason).toContain('13.7%'); expect(mgrView.legalNote).toContain('13.7%');
    const seen = await item(id, 'COMMISSION_TERMS', w.editor);
    expect(seen.naReason).toBe('（敏感類別，內容已隱藏）');
    expect(seen.legalNote).toBe('（敏感類別，內容已隱藏）');
    const raw = JSON.stringify((await ed.call('GET', `/diligence/${id}`)).json);
    expect(raw).not.toContain('13.7%');
    // 沒填的欄位維持空，不憑空顯示占位字
    expect((await item(id, 'PRICING', w.editor)).naReason ?? null).toBeNull();
  });
});

describe('12 題：授權期限要檢查（修補）', () => {
  it('品牌授權期限過期：不能送審；改成未來日期後可以；不適用的題目不檢查；快到期會列在「即將到期」', async () => {
    const { id } = await createDiligence(w.manager, vendorId, { contractVersion: ver() });
    await makeReady(id, { SOURCE_LICENSE_QA: { authorizationValidUntil: addDays(today, -1) } });
    let r = (await getDiligence(w.manager, id)).readiness;
    expect(r.ready).toBe(false);
    expect(r.reasons.join()).toContain('授權期限已過期');
    expect(r.docExpired[0]).toContain('品牌授權');
    await expect(submitDiligence(w.manager, id)).rejects.toThrow(/授權期限已過期/);
    const it1 = await item(id, 'SOURCE_LICENSE_QA');
    await updateDiligenceItem(w.manager, it1.id, { terms: { authorizationValidUntil: addDays(today, 10) } } as never);
    await updateDiligenceItem(w.manager, it1.id, { status: 'CONFIRMED' });   // 改條款後確認作廢（見下一組），重新確認
    r = (await getDiligence(w.manager, id)).readiness;
    expect(r.docExpired).toEqual([]);
    expect(r.docExpiring[0]).toContain('品牌授權');                          // 10 天內到期（預設 30 天內算即將到期）
    expect(r.ready).toBe(true);
    expect((await submitDiligence(w.manager, id)).status).toBe('IN_REVIEW');
  });
  it('標為「不適用」的題目不檢查授權期限（沒有授權就不需要有效期）', async () => {
    const { id } = await createDiligence(w.manager, vendorId, { contractVersion: ver() });
    await makeReady(id, { SOURCE_LICENSE_QA: { authorizationValidUntil: addDays(today, -30) } });
    const it1 = await item(id, 'SOURCE_LICENSE_QA');
    expect((await getDiligence(w.manager, id)).readiness.ready).toBe(false);
    await updateDiligenceItem(w.manager, it1.id, { status: 'NOT_APPLICABLE', naReason: '[DEMO] 自有品牌，無授權' });
    const r = (await getDiligence(w.manager, id)).readiness;
    expect(r.docExpired).toEqual([]); expect(r.ready).toBe(true);
  });
  it('圖片與影片授權期限過期同樣擋下；核准後授權期限才過期則該份核准失效', async () => {
    const { id } = await createDiligence(w.manager, vendorId, { contractVersion: ver() });
    await makeReady(id, { SAMPLE_MEDIA_LICENSE: { imageLicensed: true, videoLicensed: true, licenseValidUntil: addDays(today, 5) } });
    await submitDiligence(w.manager, id); await approve(id);
    expect((await getDiligence(w.manager, id)).validity.valid).toBe(true);
    await query(`UPDATE vendor_dd_items SET terms = jsonb_set(terms, '{licenseValidUntil}', to_jsonb($2::text)) WHERE record_id=$1 AND category_key='SAMPLE_MEDIA_LICENSE'`, [id, addDays(today, -2)]);
    const v = (await getDiligence(w.manager, id)).validity;
    expect(v.valid).toBe(false); expect(v.reasons.join()).toContain('授權期限已過期');
  });
});

describe('12 題：已確認後改條款、證據鎖定、進度（修補）', () => {
  it('已確認的項目事後改條款：確認作廢、退回待補件；條款沒變就維持已確認', async () => {
    const { id } = await createDiligence(w.manager, vendorId, { contractVersion: ver() });
    const it2 = await item(id, 'PRICING');
    await updateDiligenceItem(w.manager, it2.id, { terms: { listPrice: 500, groupPrice: 400 } as never });
    await updateDiligenceItem(w.manager, it2.id, { status: 'CONFIRMED' });
    expect((await item(id, 'PRICING')).status).toBe('CONFIRMED');
    await updateDiligenceItem(w.manager, it2.id, { terms: { groupPrice: 400, listPrice: 500 } as never });   // 內容相同（只是順序不同）
    expect((await item(id, 'PRICING')).status).toBe('CONFIRMED');
    await updateDiligenceItem(w.manager, it2.id, { terms: { listPrice: 500, groupPrice: 450 } as never });
    const after = await item(id, 'PRICING');
    expect(after.status).toBe('PENDING_DOCS');
    expect((await query<{ confirmed_by: string | null }>(`SELECT confirmed_by FROM vendor_dd_items WHERE id=$1`, [it2.id]))[0].confirmed_by).toBeNull();
  });
  it('審查中不能再增減證據（避免審核者看到的內容中途改變）；撤回後可以', async () => {
    const { id } = await createDiligence(w.manager, vendorId, { contractVersion: ver() });
    await makeReady(id); await submitDiligence(w.manager, id);
    const it1 = await item(id, 'SOURCE_LICENSE_QA');
    await expect(evid(it1.id)).rejects.toThrow(/已送審或核准/);
    await withdrawDiligence(w.manager, id);
    await expect(evid(it1.id)).resolves.toBeTruthy();
  });
  it('完成進度與逐題狀態：done＝已確認＋不適用，缺證據、證據過期、授權到期都標在各題', async () => {
    const { id } = await createDiligence(w.manager, vendorId, { contractVersion: ver() });
    let r = (await getDiligence(w.manager, id)).readiness;
    expect(r.progress).toEqual({ done: 0, total: 12 }); expect(r.perItem).toHaveLength(12);
    await makeReady(id, { SOURCE_LICENSE_QA: { authorizationValidUntil: addDays(today, -3) } });
    r = (await getDiligence(w.manager, id)).readiness;
    expect(r.progress).toEqual({ done: 12, total: 12 });
    expect(r.perItem.find((i) => i.key === 'SOURCE_LICENSE_QA')).toMatchObject({ docState: 'EXPIRED', status: 'CONFIRMED', no: 1 });
    expect(r.perItem.map((i) => i.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe('12 題：撤回、版本鏈、沿用、挑選規則（補缺漏）', () => {
  it('撤回：只有審查中的調查可撤回；送審的人或覆核者可撤回，其他編輯不行；撤回後回到草稿並寫稽核', async () => {
    const { id } = await createDiligence(w.editor, vendorId, { contractVersion: ver() });
    await expect(withdrawDiligence(w.editor, id)).rejects.toThrow(/審查中/);
    await makeReady(id); await submitDiligence(w.editor, id);
    await expect(withdrawDiligence(other, id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await withdrawDiligence(w.editor, id)).status).toBe('DRAFT');
    expect((await getDiligence(w.editor, id)).status).toBe('DRAFT');
    await submitDiligence(w.editor, id);
    expect((await withdrawDiligence(w.manager, id)).status).toBe('DRAFT');   // 覆核者也可以
    const a = await query(`SELECT 1 FROM audit_logs WHERE organization_id=$1 AND action='selection.dd.withdraw' AND entity_id=$2`, [w.orgId, id]);
    expect(a).toHaveLength(2);
    await expect(withdrawDiligence(w.manager, id)).rejects.toThrow(/審查中/);
  });
  it('版本鏈：同一廠商同範圍的新版核准後，舊版標為被取代（讀取時失效），新版記錄取代誰；不同範圍不受影響', async () => {
    const vv = (await mkVendor(w, '[DEMO] 版本鏈廠商')).id;
    const pp = (await mkProduct(w, vv, { name: '[DEMO] 版本鏈商品' })).id;
    const a = (await createDiligence(w.manager, vv, { contractVersion: 'A1' })).id; await makeReady(a); await submitDiligence(w.manager, a); await approve(a);
    const sc = (await createDiligence(w.manager, vv, { contractVersion: 'P1', productId: pp })).id; await makeReady(sc); await submitDiligence(w.manager, sc); await approve(sc);
    const b = (await createDiligence(w.manager, vv, { contractVersion: 'A2' })).id; await makeReady(b); await submitDiligence(w.manager, b); await approve(b);
    const oldA = await getDiligence(w.manager, a);
    expect(oldA.supersededAt).not.toBeNull();
    expect(oldA.validity).toMatchObject({ valid: false }); expect(oldA.validity.reasons).toContain('已被新版調查取代');
    const newB = await getDiligence(w.manager, b);
    expect(newB.supersedesId).toBe(a); expect(newB.supersededAt).toBeNull(); expect(newB.validity.valid).toBe(true);
    expect((await getDiligence(w.manager, sc)).supersededAt).toBeNull();   // 商品專屬範圍不同，不受影響
  });
  it('沿用：從同一廠商先前的調查帶入條款、責任方與負責人；項目回到待補件、不複製證據；分潤條款沒有成本權限者不會被沿用出來', async () => {
    const vv = (await mkVendor(w, '[DEMO] 沿用廠商')).id;
    const src = (await createDiligence(w.manager, vv, { contractVersion: 'S1' })).id;
    const s4 = await item(src, 'STOCK_LEADTIME'); const s10 = await item(src, 'COMMISSION_TERMS');
    await updateDiligenceItem(w.manager, s4.id, { terms: { stockMode: 'IN_STOCK', leadTimeDays: 3 }, responsibleParty: 'BRAND', ownerUserId: w.editor.userId } as never);
    await updateDiligenceItem(w.manager, s4.id, { status: 'CONFIRMED' });
    await updateDiligenceItem(w.manager, s10.id, { terms: { basis: 'NSV', ratePercent: 17 } } as never);
    await evid(s4.id);
    const byMgr = (await createDiligence(w.manager, vv, { contractVersion: 'S2', copyFromId: src })).id;
    expect(await item(byMgr, 'STOCK_LEADTIME')).toMatchObject({ status: 'PENDING_DOCS', terms: { stockMode: 'IN_STOCK', leadTimeDays: 3 }, responsibleParty: 'BRAND', ownerUserId: w.editor.userId });
    expect((await item(byMgr, 'COMMISSION_TERMS')).terms).toMatchObject({ ratePercent: 17 });
    expect((await getDiligence(w.manager, byMgr)).copiedFromId).toBe(src);
    expect((await item(byMgr, 'STOCK_LEADTIME') as Item & { evidence?: unknown[] }).evidence ?? []).toHaveLength(0);
    const byEd = (await createDiligence(w.editor, vv, { contractVersion: 'S3', copyFromId: src })).id;
    expect((await item(byEd, 'STOCK_LEADTIME', w.manager)).terms).toMatchObject({ leadTimeDays: 3 });
    expect((await item(byEd, 'COMMISSION_TERMS', w.manager)).terms).toEqual({});        // 沒有成本權限的人沿用，分潤條款不複製
    await expect(createDiligence(w.manager, vendorId, { contractVersion: 'S9', copyFromId: src })).rejects.toThrow(/同一廠商/);
  });
  it('挑選規則：廠商層級已核准的調查不會被「商品專屬的草稿」蓋過；商品專屬已核准優先；商品專屬被退回仍要看得見', async () => {
    const vv = (await mkVendor(w, '[DEMO] 挑選廠商')).id;
    const pp = (await mkProduct(w, vv, { name: '[DEMO] 挑選商品' })).id;
    const vl = (await createDiligence(w.manager, vv, { contractVersion: 'L1' })).id; await makeReady(vl); await submitDiligence(w.manager, vl); await approve(vl);
    const draft = (await createDiligence(w.manager, vv, { contractVersion: 'P-draft', productId: pp })).id;
    expect((await bestDiligence(w.manager, vv, pp))!.id).toBe(vl);                  // 草稿不蓋過已核准的廠商層級
    await makeReady(draft); await submitDiligence(w.manager, draft); await approve(draft);
    expect((await bestDiligence(w.manager, vv, pp))!.id).toBe(draft);               // 商品專屬已核准優先
    await reviewDiligence(w.manager, draft, { decision: 'REJECTED', note: '[DEMO] 撤銷' });
    expect((await bestDiligence(w.manager, vv, pp))!.id).toBe(draft);               // 明確撤銷的決定仍要看得見
  });
});
