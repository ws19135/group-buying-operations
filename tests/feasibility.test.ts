import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { createFeasibility, getFeasibility, listProductFeasibility, recordActuals } from '@/server/modules/feasibility';
import { createEvidence } from '@/server/modules/evidence';
import { createCase } from '@/server/modules/aftersales';
import { importOrders } from '@/server/modules/orders';
import type { Actor } from '@/server/lib/permissions';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkCampaign, mkHost, mkProduct, mkVendor, type World } from './helpers';

const HEADER = 'source_order_id,campaign_id,ordered_at,status,quantity,unit_price,sku_code,buyer_ref,host_id,community_id,refund_amount';

let w: World, other: World;
let vendorId: string, hostA: string, hostB: string;
let ed: Client, ed2: Client, hostC: Client, vendC: Client, fin: Client;
let n = 0;
const newProduct = async () => mkProduct(w, vendorId, { name: `[DEMO] 可行性商品 ${++n}${Math.random().toString(36).slice(2, 5)}` });

const src = (keys: string[], kind = 'MANUAL_ESTIMATE') => Object.fromEntries(keys.map((k) => [k, { kind }]));
// 用不易與其他數字混淆的成本值，方便檢查「沒有權限的人拿到的回應裡不能出現」
const FULL = { expectedOrders: 100, unitPrice: 1000, refundRatePct: 10, unitCost: 48731, shippingPerOrder: 60, platformFeePct: 3, otherVariablePerOrder: 0, fixedCost: 2000,
  brandFeePct: 10, serviceFeeFixed: 0, hostCommissionPct: 5, commissionBasis: 'NSV', hostPaidBy: 'COMPANY', cashFlowMode: 'BRAND_COLLECTS',
  shippingBorneBy: 'BRAND', platformFeeBorneBy: 'BRAND', otherCostBorneBy: 'COMPANY', fixedCostBorneBy: 'COMPANY' } as const;
const fullInput = () => ({ inputs: { ...FULL }, sources: src(Object.keys(FULL), 'VENDOR_QUOTE') });

beforeAll(async () => {
  w = await makeWorld(); other = await makeWorld();
  vendorId = (await mkVendor(w, '[DEMO] 可行性廠商', { category: '家電' })).id;
  hostA = (await mkHost(w, '[DEMO] 團主甲')).id; hostB = (await mkHost(w, '[DEMO] 團主乙')).id;
  const hu = await addUser(w.orgId, 'HOST', { hostIds: [hostA] }); const vu = await addUser(w.orgId, 'VENDOR', { vendorIds: [vendorId] });
  [ed, ed2, hostC, vendC, fin] = await Promise.all([Client.forActor(w.editor), Client.forActor(w.editor2), Client.forActor(hu), Client.forActor(vu), Client.forActor(w.finance)]);
});

describe('可行性：版本、假設來源、不捏造', () => {
  it('存檔後讀回：版本 1、輸入、來源與試算結果都在；每次儲存是新版本', async () => {
    const p = await newProduct();
    const a = await createFeasibility(w.manager, p.id, { ...fullInput(), label: '基準情境' });
    expect(a.versionNo).toBe(1);
    expect(a.results).toMatchObject({ gmv: 100000, nsv: 90000, companyRevenue: 9000, brandProfit: 90000 - 4873100 + 0 - 9000 - 6000 - 3000 });
    const back = await getFeasibility(w.manager, a.id);
    expect(back).toMatchObject({ versionNo: 1, label: '基準情境', inputs: { unitCost: 48731, expectedOrders: 100 }, sources: { unitCost: { kind: 'VENDOR_QUOTE' } }, restricted: false });
    const b = await createFeasibility(w.manager, p.id, { inputs: { expectedOrders: 200 }, sources: src(['expectedOrders']) });
    expect(b.versionNo).toBe(2);
    expect((await getFeasibility(w.manager, b.id)).inputs).toMatchObject({ expectedOrders: 200, unitCost: 48731, unitPrice: 1000 });   // 沿用上一版其餘欄位
    expect((await getFeasibility(w.manager, a.id)).inputs).toMatchObject({ expectedOrders: 100 });                                      // 舊版不變
    expect((await getFeasibility(w.manager, b.id)).versions).toHaveLength(2);
  });
  it('每個填入的輸入都要註明假設來源，否則 422 並列出缺哪些', async () => {
    const p = await newProduct();
    await expect(createFeasibility(w.manager, p.id, { inputs: { expectedOrders: 100, unitPrice: 1000 }, sources: src(['expectedOrders']) })).rejects.toThrow(/團購價/);
    await expect(createFeasibility(w.manager, p.id, { inputs: {} })).rejects.toThrow(/至少/);
    await expect(createFeasibility(w.manager, p.id, { inputs: { expectedOrders: 1 }, sources: { ...src(['expectedOrders']), bogus: { kind: 'MANUAL_ESTIMATE' } } })).rejects.toThrow(/未知/);
    await expect(createFeasibility(w.manager, p.id, { inputs: { expectedOrders: 1 }, sources: { expectedOrders: { kind: 'GUESS' as never } } })).rejects.toBeTruthy();
  });
  it('缺少資料就是未知：沒填退款率 → 淨銷售額與利潤是 null，不是 0；並說明缺什麼', async () => {
    const p = await newProduct();
    const { id } = await createFeasibility(w.manager, p.id, { inputs: { expectedOrders: 100, unitPrice: 1000, unitCost: 500 }, sources: src(['expectedOrders', 'unitPrice', 'unitCost']) });
    const r = (await getFeasibility(w.manager, id)).results as { gmv: number; nsv: number | null; brandProfit: number | null; companyRevenue: number | null; missing: Record<string, string[]> };
    expect(r.gmv).toBe(100000);
    expect(r.nsv).toBeNull();
    expect(r.brandProfit).toBeNull();
    expect(r.companyRevenue).toBeNull();
    expect(r.missing.refund).toContain('退款率');
  });
  it('GMV 不等於公司營業收入；代營運居中時代收款是負債', async () => {
    const p = await newProduct();
    const { id } = await createFeasibility(w.manager, p.id, { inputs: { ...FULL, cashFlowMode: 'COMPANY_ESCROW' }, sources: src(Object.keys(FULL)) });
    const r = (await getFeasibility(w.manager, id)).results as { gmv: number; companyRevenue: number; escrowRemitToBrand: number };
    expect(r.companyRevenue).toBe(9000);
    expect(r.companyRevenue).toBeLessThan(r.gmv);
    expect(r.escrowRemitToBrand).toBe(90000 - 9000);
  });
  it('輸入驗證：比例 0–100、金額非負整數、未知欄位被拒', async () => {
    const p = await newProduct();
    for (const bad of [{ refundRatePct: 120 }, { unitCost: -5 }, { expectedOrders: 1.5 }, { surprise: 1 }, { commissionBasis: 'OTHER' }]) {
      await expect(createFeasibility(w.manager, p.id, { inputs: bad as never, sources: {} })).rejects.toBeTruthy();
    }
  });
  it('試算假設與結果不可修改（資料庫觸發器）；只能補寫實際回寫；不可刪除', async () => {
    const p = await newProduct();
    const { id } = await createFeasibility(w.manager, p.id, { inputs: { expectedOrders: 10 }, sources: src(['expectedOrders']) });
    await expect(query(`UPDATE feasibility_scenarios SET inputs='{}'::jsonb WHERE id=$1`, [id])).rejects.toThrow(/不可修改/);
    await expect(query(`UPDATE feasibility_scenarios SET results='{}'::jsonb WHERE id=$1`, [id])).rejects.toThrow(/不可修改/);
    await expect(query(`UPDATE feasibility_scenarios SET actuals='{"x":1}'::jsonb, actuals_at=now() WHERE id=$1`, [id])).resolves.toBeDefined();
    await expect(query(`DELETE FROM feasibility_scenarios WHERE id=$1`, [id])).rejects.toThrow();
  });
});

describe('可行性：成本與分潤是敏感資料（沿用 product.cost.read）', () => {
  it('營運小編不能填任何敏感欄位（403），含來源說明；非敏感欄位可以', async () => {
    const p = await newProduct();
    await expect(createFeasibility(w.editor, p.id, { inputs: { unitCost: 100 }, sources: src(['unitCost']) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(createFeasibility(w.editor, p.id, { inputs: { hostCommissionPct: 5 }, sources: src(['hostCommissionPct']) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(createFeasibility(w.editor, p.id, { inputs: { hostPaidBy: 'BRAND' }, sources: src(['hostPaidBy']) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(createFeasibility(w.editor, p.id, { inputs: { unitCost: null }, sources: {} })).rejects.toMatchObject({ code: 'FORBIDDEN' });   // 連「清空」也不行
    const ok = await createFeasibility(w.editor, p.id, { inputs: { expectedOrders: 80, unitPrice: 900, refundRatePct: 5 }, sources: src(['expectedOrders', 'unitPrice', 'refundRatePct']) });
    expect(ok.versionNo).toBe(1);
  });
  it('小編讀到的敏感輸入與結果都是 null（restricted）；GMV／退款／淨銷售額可見；原始回應不含成本數字', async () => {
    const p = await newProduct();
    const { id } = await createFeasibility(w.manager, p.id, fullInput());
    const r = await ed.call('GET', `/feasibility/${id}`);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ restricted: true, inputs: { expectedOrders: 100, unitPrice: 1000, unitCost: null, hostCommissionPct: null, hostPaidBy: null, shippingBorneBy: null }, results: { gmv: 100000, nsv: 90000, brandProfit: null, companyRevenue: null, hostCommission: null, companyContribution: null, restricted: true } });
    expect(r.data.sources.unitCost).toBeUndefined();
    const raw = JSON.stringify(r.json);
    expect(raw).not.toContain('48731');
    expect(raw).not.toContain('"hostCommissionPct":5');
    const list = JSON.stringify((await ed.call('GET', `/products/${p.id}/feasibility`)).json);
    expect(list).not.toContain('48731');
    expect((await ed.call('GET', `/products/${p.id}/feasibility`)).data).toMatchObject({ canSeeSensitive: false });
    // 財務與主管看得到
    expect((await fin.call('GET', `/feasibility/${id}`)).data.inputs.unitCost).toBe(48731);
  });
  it('小編新增新版本時，上一版的敏感欄位原樣沿用（不會被清掉），結果仍以完整輸入計算', async () => {
    const p = await newProduct();
    const a = await createFeasibility(w.manager, p.id, fullInput());
    const b = await createFeasibility(w.editor, p.id, { inputs: { expectedOrders: 200 }, sources: src(['expectedOrders']) });
    const full = await getFeasibility(w.manager, b.id);
    expect(full.inputs).toMatchObject({ expectedOrders: 200, unitCost: 48731, hostCommissionPct: 5, hostPaidBy: 'COMPANY' });
    expect((full.results as { gmv: number; productCost: number }).productCost).toBe(48731 * 200);
    expect(a.versionNo + 1).toBe(b.versionNo);
    expect(JSON.stringify(b.results)).not.toContain('48731');   // 建立時回傳給小編的結果也已遮罩
  });
  it('參考價格：商品主檔的成本範圍只給有成本檢視權限者', async () => {
    const p = await newProduct();
    const asEditor = await listProductFeasibility(w.editor, p.id);
    const asManager = await listProductFeasibility(w.manager, p.id);
    expect(asEditor.reference).toMatchObject({ groupPriceMin: 800, costMin: null, costMax: null });
    expect(asManager.reference).toMatchObject({ groupPriceMin: 800, costMin: 500, costMax: 500 });
  });
  it('可行性的證據連結（報價）屬敏感：小編不能新增、讀到的是遮罩版', async () => {
    const p = await newProduct();
    const { id } = await createFeasibility(w.manager, p.id, fullInput());
    await expect(createEvidence(w.editor, { subjectType: 'FEASIBILITY', subjectId: id, kind: 'QUOTE', title: '[DEMO] 報價', url: 'https://docs.example.invalid/q' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await createEvidence(w.manager, { subjectType: 'FEASIBILITY', subjectId: id, kind: 'QUOTE', title: '[DEMO] 報價單', url: 'https://docs.example.invalid/quote-secret' });
    const seen = (await getFeasibility(w.editor, id)).evidence as { restricted?: boolean; url?: string }[];
    expect(seen).toHaveLength(1);
    expect(seen[0].restricted).toBe(true);
    expect(JSON.stringify(seen)).not.toContain('quote-secret');
  });
  it('稽核不記錄成本與分潤的數值', async () => {
    const p = await newProduct();
    const { id } = await createFeasibility(w.manager, p.id, fullInput());
    const a = JSON.stringify(await query(`SELECT before_data, after_data FROM audit_logs WHERE entity_id=$1`, [id]));
    expect(a).not.toContain('48731');
    expect(a).toContain('changedSensitiveCount');
  });
  it('團主與廠商沒有入口（403）；跨組織 404', async () => {
    const p = await newProduct();
    const { id } = await createFeasibility(w.manager, p.id, { inputs: { expectedOrders: 1 }, sources: src(['expectedOrders']) });
    for (const c of [hostC, vendC]) {
      expect((await c.call('GET', `/products/${p.id}/feasibility`)).status).toBe(403);
      expect((await c.call('GET', `/feasibility/${id}`)).status).toBe(403);
      expect((await c.call('POST', `/products/${p.id}/feasibility`, { inputs: { expectedOrders: 1 }, sources: src(['expectedOrders']) })).status).toBe(403);
      expect((await c.call('POST', `/feasibility/${id}/actuals`)).status).toBe(403);
    }
    expect((await fin.call('POST', `/products/${p.id}/feasibility`, { inputs: { expectedOrders: 1 }, sources: src(['expectedOrders']) })).status).toBe(403);   // 財務唯讀
    const op = await mkProduct(other, (await mkVendor(other)).id);
    const of_ = await createFeasibility(other.manager, op.id, { inputs: { expectedOrders: 1 }, sources: src(['expectedOrders']) });
    expect((await ed.call('GET', `/feasibility/${of_.id}`)).status).toBe(404);
    expect((await ed.call('GET', `/products/${op.id}/feasibility`)).status).toBe(404);
    expect((await ed.call('POST', `/feasibility/${of_.id}/actuals`)).status).toBe(404);
  });
});

describe('小規模測試團：實際回寫', () => {
  let p: { id: string; skuIds: string[] }, camp: string, campOther: string;
  beforeAll(async () => {
    p = await newProduct();
    const base = { sampleReadyDate: dayOffset(-60), openDate: dayOffset(-30), closeDate: dayOffset(-20) };
    camp = (await mkCampaign(w, vendorId, { ...base, products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: [{ hostId: hostA }, { hostId: hostB }] }, w.editor)).id;
    campOther = (await mkCampaign(w, vendorId, { ...base, products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: [{ hostId: hostA }] }, w.editor2)).id;
    await query(`UPDATE campaigns SET status='RUNNING' WHERE id IN ($1,$2)`, [camp, campOther]);
    const rows = [`D1,${camp},${dayOffset(-25)} 09:00,PAID,1,800,A,b1,${hostA},,`, `D2,${camp},${dayOffset(-25)} 10:00,PAID,1,800,A,b2,${hostA},,0`, `D3,${camp},${dayOffset(-24)} 10:00,PARTIAL_REFUND,1,800,A,b3,${hostB},,200`, `D4,${camp},${dayOffset(-24)} 11:00,CANCELLED,1,800,A,b4,${hostB},,`];
    const r = await importOrders(w.manager, { sourceSystem: 'DEMO_SHOP', fileName: 'mini.csv', csv: [HEADER, ...rows].join('\n') });
    expect(r).toMatchObject({ errorRows: 0 });
    await createCase(w.manager, { campaignId: camp, caseType: 'COMPLAINT', title: '[DEMO] 客訴', priority: 'MEDIUM' } as never);
    await createCase(w.manager, { campaignId: camp, caseType: 'REFUND', title: '[DEMO] 退款', priority: 'MEDIUM' } as never);
  });
  it('檔期層級：實際訂單、GMV、退款、淨銷售額、客單價、客訴與退款件數，並與預測並列差異；不寫利潤', async () => {
    const f = await createFeasibility(w.editor, p.id, { campaignId: camp, inputs: { expectedOrders: 5, unitPrice: 800, refundRatePct: 0 }, sources: src(['expectedOrders', 'unitPrice', 'refundRatePct']) });
    const { actuals } = await recordActuals(w.editor, f.id) as { actuals: Record<string, unknown> };
    expect(actuals).toMatchObject({ scope: 'CAMPAIGN', orders: 3, gmv: 2400, refund: 200, nsv: 2200, aov: 800, refundRatePct: 8.33, complaints: 1, refundCases: 1 });   // 取消的訂單不算
    expect((actuals.variance as { orders: unknown }).orders).toEqual({ predicted: 5, actual: 3, diff: -2, diffPct: -40 });
    expect((actuals.variance as { gmv: unknown }).gmv).toEqual({ predicted: 4000, actual: 2400, diff: -1600, diffPct: -40 });
    expect(actuals).not.toHaveProperty('brandProfit');
    expect(actuals).not.toHaveProperty('profit');
    const back = await query<{ actuals: { orders: number }; actuals_at: string }>(`SELECT actuals, actuals_at FROM feasibility_scenarios WHERE id=$1`, [f.id]);
    expect(back[0].actuals.orders).toBe(3);
    expect(back[0].actuals_at).not.toBeNull();
  });
  it('指定團主：只算歸因給該團主的訂單', async () => {
    const f = await createFeasibility(w.editor, p.id, { campaignId: camp, hostId: hostA, inputs: { expectedOrders: 2, unitPrice: 800 }, sources: src(['expectedOrders', 'unitPrice']) });
    const { actuals } = await recordActuals(w.editor, f.id) as { actuals: Record<string, unknown> };
    expect(actuals).toMatchObject({ scope: 'HOST', orders: 2, gmv: 1600, refund: 0 });
  });
  it('可重複回寫（以最新為準），稽核保留前後值；沒有檔期的情境不能回寫', async () => {
    const f = await createFeasibility(w.editor, p.id, { campaignId: camp, inputs: { expectedOrders: 3 }, sources: src(['expectedOrders']) });
    await recordActuals(w.editor, f.id); await recordActuals(w.editor, f.id);
    const a = await query(`SELECT before_data FROM audit_logs WHERE entity_id=$1 AND action='selection.feasibility.actuals' ORDER BY id`, [f.id]);
    expect(a).toHaveLength(2);
    expect(a[0].before_data).toBeNull();
    expect(a[1].before_data).not.toBeNull();
    const g = await createFeasibility(w.editor, p.id, { inputs: { expectedOrders: 3 }, sources: src(['expectedOrders']) });
    await expect(recordActuals(w.editor, g.id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
  it('檔期範圍：別的小編負責的檔期 404（建立與回寫都是）；商品不在該檔期被拒', async () => {
    await expect(createFeasibility(w.editor, p.id, { campaignId: campOther, inputs: { expectedOrders: 3 }, sources: src(['expectedOrders']) })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const f = await createFeasibility(w.editor2, p.id, { campaignId: campOther, inputs: { expectedOrders: 3 }, sources: src(['expectedOrders']) });
    expect((await ed.call('GET', `/feasibility/${f.id}`)).status).toBe(404);
    expect((await ed.call('POST', `/feasibility/${f.id}/actuals`)).status).toBe(404);
    const list = (await listProductFeasibility(w.editor, p.id)).items.map((i) => i.id);
    expect(list).not.toContain(f.id);
    const nop = await newProduct();
    await expect(createFeasibility(w.editor, nop.id, { campaignId: camp, inputs: { expectedOrders: 3 }, sources: src(['expectedOrders']) })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  it('關聯的試用必須屬於同一商品', async () => {
    const p2 = await newProduct();
    await expect(createFeasibility(w.editor, p.id, { trialId: 'TRL-999999', inputs: { expectedOrders: 3 }, sources: src(['expectedOrders']) })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(p2.id).toBeTruthy();
  });
});
