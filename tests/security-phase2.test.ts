import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '@/server/lib/db';
import { importOrders } from '@/server/modules/orders';
import { createCommissionRule } from '@/server/modules/commission';
import * as ful from '@/server/modules/fulfillment';
import * as as from '@/server/modules/aftersales';
import * as fin from '@/server/modules/finance';
import * as st from '@/server/modules/settlements';
import type { Actor } from '@/server/lib/permissions';
import { purgeExpiredIdempotencyKeys } from '@/server/lib/idempotency';
import { pageParams } from '@/server/lib/repo';
import { resetRateLimits } from '@/server/lib/rate-limit';
import { parseCookie } from '@/server/modules/auth';
import { runJob, setJobEnabled } from '@/server/modules/automation';
import { PW } from './helpers';
import { dispatch } from '@/server/api/router';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkCampaign, mkHost, mkProduct, mkVendor, type World } from './helpers';

/**
 * 獨立安全審查（Phase 2 為主）：授權、存在性洩漏、冪等綁定、資料不變條件、輸入邊界、併發。
 * 每個測試描述的是「應該成立的性質」；寫下當時若為紅燈，就是一項發現（見 docs/phase2/SECURITY_REVIEW.md）。
 */
const HEADER = 'source_order_id,campaign_id,ordered_at,status,quantity,unit_price,sku_code,buyer_ref,host_id,community_id,refund_amount';
const at = () => `${dayOffset(-1)} 09:00`;
const M = {
  batchNote: 'MARK-BATCH-NOTE', shipNote: 'MARK-SHIP-NOTE', caseInternal: 'MARK-CASE-INTERNAL', caseDesc: 'MARK-CASE-DESC', buyer: 'MARK-BUYER-REF',
  evInternal: 'MARK-EVENT-INTERNAL', evPublic: 'MARK-EVENT-PUBLIC', refundReason: 'MARK-REFUND-REASON', override: 'MARK-OVERRIDE-REASON', adj: 'MARK-ADJUSTMENT-REASON',
  pay: 'MARK-PAYMENT-NOTE', exp: 'MARK-EXPENSE-NOTE',
};

let w: World, w2: World;
let vA: string, vB: string, hA: string, hB: string, skuA: string, skuB: string;
let cA: string, cB: string;
let hostA: Actor, hostB: Actor, vendA: Actor, vendB: Actor;
let cl: Record<'hostA' | 'hostB' | 'vendA' | 'vendB' | 'editor' | 'editor2' | 'manager' | 'finance' | 'admin' | 'admin2', Client>;
const D: Record<string, string> = {};   // 資料 id

beforeAll(async () => {
  w = await makeWorld();
  w2 = await makeWorld();
  vA = (await mkVendor(w, '廠商甲')).id; vB = (await mkVendor(w, '廠商乙')).id;
  const pA = await mkProduct(w, vA, { approve: true }); const pB = await mkProduct(w, vB, { approve: true });
  skuA = pA.skuIds[0]; skuB = pB.skuIds[0];
  D.prodA = pA.id; D.prodB = pB.id; D.vendA = vA; D.vendB = vB; D.hostA = hA; D.hostB = hB;
  hA = (await mkHost(w, '團主甲')).id; hB = (await mkHost(w, '團主乙')).id;
  cA = (await mkCampaign(w, vA, { products: [{ productId: pA.id, skuId: skuA }], hosts: [{ hostId: hA, targetRevenue: 10000 }], sampleReadyDate: dayOffset(-40), openDate: dayOffset(-3), closeDate: dayOffset(7) }, w.editor)).id;
  cB = (await mkCampaign(w, vB, { products: [{ productId: pB.id, skuId: skuB }], hosts: [{ hostId: hB, targetRevenue: 10000 }], sampleReadyDate: dayOffset(-40), openDate: dayOffset(-3), closeDate: dayOffset(7) }, w.manager)).id;
  await query(`UPDATE campaigns SET status='RUNNING' WHERE id = ANY($1::text[])`, [[cA, cB]]);
  hostA = await addUser(w.orgId, 'HOST', { hostIds: [hA] }); hostB = await addUser(w.orgId, 'HOST', { hostIds: [hB] });
  vendA = await addUser(w.orgId, 'VENDOR', { vendorIds: [vA] }); vendB = await addUser(w.orgId, 'VENDOR', { vendorIds: [vB] });
  await createCommissionRule(w.finance, { scopeType: 'HOST_DEFAULT', hostId: hA, ratePercent: 10, effectiveFrom: dayOffset(-100) });
  await createCommissionRule(w.finance, { scopeType: 'HOST_DEFAULT', hostId: hB, ratePercent: 10, effectiveFrom: dayOffset(-100) });
  await importOrders(w.manager, { sourceSystem: 'SHOP_S', csv: [HEADER,
    `S1,${cA},${at()},PAID,1,1000,,${M.buyer},${hA},,`, `S2,${cA},${at()},PAID,1,2000,,b2,${hA},,`, `S3,${cA},${at()},PAID,1,3000,,b3,${hA},,`,
    `T1,${cB},${at()},PAID,1,1500,,tb1,${hB},,`].join('\n') });
  for (const r of await query<{ source_order_id: string; id: string }>('SELECT source_order_id, id FROM orders WHERE organization_id=$1', [w.orgId])) D[`ord_${r.source_order_id}`] = r.id;

  D.taskA = (await query<{ id: string }>('SELECT id FROM tasks WHERE campaign_id=$1 ORDER BY id LIMIT 1', [cA]))[0].id;
  // ---- 履約 ----
  D.batchA = (await ful.createBatch(w.editor, cA, { kind: 'ORDER', label: '批次甲', note: M.batchNote })).id;
  D.shipA = (await ful.addShipment(w.editor, D.batchA, { skuId: skuA, quantity: 3, carrier: '黑貓', trackingNo: 'TRK-SEC-A1', note: M.shipNote })).id;
  D.batchB = (await ful.createBatch(w.manager, cB, { kind: 'ORDER', label: '批次乙', note: M.batchNote })).id;
  D.shipB = (await ful.addShipment(w.manager, D.batchB, { skuId: skuB, quantity: 2, carrier: '黑貓', trackingNo: 'TRK-SEC-B1', note: M.shipNote })).id;
  // ---- 售後 ----
  D.caseA = (await as.createCase(w.editor, { campaignId: cA, caseType: 'REFUND', title: '甲案件', description: M.caseDesc, internalNote: M.caseInternal, orderId: D.ord_S1 })).id;
  await as.addCaseNote(w.editor, D.caseA, { note: M.evInternal });
  await as.addCaseNote(w.editor, D.caseA, { note: M.evPublic, public: true });
  D.refundA = (await as.requestRefund(w.editor, D.caseA, { amount: 300, reason: M.refundReason, orderId: D.ord_S1 })).id;
  D.caseB = (await as.createCase(w.manager, { campaignId: cB, caseType: 'COMPLAINT', title: '乙案件', description: M.caseDesc, internalNote: M.caseInternal })).id;
  // ---- 財務 ----
  D.setA = (await st.createSettlement(w.finance, { campaignId: cA })).id;
  const items = (await st.getSettlement(w.finance, D.setA)).items;
  D.itemA = items.find((i) => i.hostId === hA)!.id;
  await st.setItemOverride(w.finance, D.itemA, { amount: 111, reason: M.override });
  await st.addAdjustment(w.finance, D.setA, { itemId: D.itemA, amount: 5, reason: M.adj });
  D.payA = (await fin.createPayment(w.finance, { direction: 'OUT', counterpartyType: 'HOST', counterpartyId: hA, amount: 100, paidOn: dayOffset(-1), campaignId: cA, note: M.pay })).id;
  D.expA = (await fin.createExpense(w.finance, { category: 'SHIPPING', amount: 50, incurredOn: dayOffset(-1), campaignId: cA, note: M.exp })).id;
  D.invA = (await fin.createInvoice(w.finance, { invoiceNo: 'SEC-INV-001', invoiceDate: dayOffset(-1), amount: 10, campaignId: cA })).id;

  const mk = (a: Actor) => Client.forActor(a);
  cl = {
    hostA: await mk(hostA), hostB: await mk(hostB), vendA: await mk(vendA), vendB: await mk(vendB),
    editor: await mk(w.editor), editor2: await mk(w.editor2), manager: await mk(w.manager), finance: await mk(w.finance), admin: await mk(w.admin), admin2: await mk(w2.admin),
  };
});

afterAll(async () => { /* 組織各自獨立，不清理 */ });

// ============================================================================
// A. 存在性洩漏：範圍外的真實 id 與不存在的 id，回應必須完全一致
// ============================================================================
type Ep = { m: string; p: (d: Record<string, string>) => string; body?: unknown };
const FAKE = 'ZZZ-000000';
const endpoints: Ep[] = [
  { m: 'GET', p: (d) => `/fulfillment/batches/${d.batchA}` },
  { m: 'PATCH', p: (d) => `/fulfillment/batches/${d.batchA}`, body: { label: 'x' } },
  { m: 'POST', p: (d) => `/fulfillment/batches/${d.batchA}/cancel`, body: { reason: 'x' } },
  { m: 'POST', p: (d) => `/fulfillment/batches/${d.batchA}/shipments`, body: { quantity: 1 } },
  { m: 'GET', p: () => `/campaigns/${cA}/fulfillment` },
  { m: 'POST', p: () => `/campaigns/${cA}/fulfillment/batches`, body: { label: 'x' } },
  { m: 'PATCH', p: (d) => `/fulfillment/shipments/${d.shipA}`, body: { note: 'x' } },
  { m: 'POST', p: (d) => `/fulfillment/shipments/${d.shipA}/status`, body: { to: 'PACKED' } },
  { m: 'POST', p: (d) => `/fulfillment/shipments/${d.shipA}/receipt`, body: { signer: 'x' } },
  { m: 'GET', p: (d) => `/aftersales/cases/${d.caseA}` },
  { m: 'PATCH', p: (d) => `/aftersales/cases/${d.caseA}`, body: { title: 'x' } },
  { m: 'POST', p: (d) => `/aftersales/cases/${d.caseA}/status`, body: { to: 'IN_PROGRESS' } },
  { m: 'POST', p: (d) => `/aftersales/cases/${d.caseA}/notes`, body: { note: 'x' } },
  { m: 'POST', p: (d) => `/aftersales/cases/${d.caseA}/refunds`, body: { amount: 10, reason: 'x' } },
  { m: 'POST', p: (d) => `/aftersales/refunds/${d.refundA}/decision`, body: { decision: 'APPROVED' } },
  { m: 'POST', p: (d) => `/aftersales/refunds/${d.refundA}/complete`, body: {} },
  { m: 'GET', p: (d) => `/settlements/${d.setA}` },
  { m: 'POST', p: (d) => `/settlements/${d.setA}/recalculate` },
  { m: 'POST', p: (d) => `/settlements/${d.setA}/adjustments`, body: { itemId: '$item', amount: 1, reason: 'x' } },
  { m: 'POST', p: (d) => `/settlements/${d.setA}/confirm`, body: {} },
  { m: 'POST', p: (d) => `/settlements/${d.setA}/void`, body: { reason: 'x' } },
  { m: 'POST', p: (d) => `/settlement-items/${d.itemA}/override`, body: { amount: 1, reason: 'x' } },
  { m: 'PATCH', p: (d) => `/payments/${d.payA}`, body: { note: 'x' } },
  { m: 'POST', p: (d) => `/payments/${d.payA}/match`, body: {} },
  { m: 'POST', p: (d) => `/payments/${d.payA}/void`, body: { reason: 'x' } },
  { m: 'PATCH', p: (d) => `/invoices/${d.invA}`, body: { note: 'x' } },
  { m: 'POST', p: (d) => `/invoices/${d.invA}/issue` },
  { m: 'POST', p: (d) => `/invoices/${d.invA}/void`, body: { reason: 'x' } },
  { m: 'PATCH', p: (d) => `/expenses/${d.expA}`, body: { note: 'x' } },
  { m: 'POST', p: (d) => `/expenses/${d.expA}/void`, body: { reason: 'x' } },
];
const realIds = () => ({ ...D });
const bodyOf = (ep: Ep, d: Record<string, string>) => (ep.body === undefined ? undefined : JSON.parse(JSON.stringify(ep.body).replace('$item', d.itemA ?? FAKE)));
const fakeIds = () => Object.fromEntries(Object.keys(D).map((k) => [k, FAKE]));

describe('A. 存在性洩漏（IDOR 預言機）：範圍外的真實 id ≡ 不存在的 id', () => {
  const actors = ['hostB', 'vendB', 'editor2'] as const;
  for (const who of actors) {
    it(`${who}（不在 cA 範圍）對 cA 資源的每條 API，回應與不存在的 id 相同（狀態碼＋錯誤碼）`, async () => {
      const diffs: string[] = [];
      for (const ep of endpoints) {
        const fakePath = ep.p(fakeIds()).replace(cA, 'CMP-000000-0000');
        const real = await cl[who].call(ep.m, ep.p(realIds()), bodyOf(ep, realIds()));
        const fake = await cl[who].call(ep.m, fakePath, bodyOf(ep, fakeIds()));
        if (real.status !== fake.status || real.error?.code !== fake.error?.code) diffs.push(`${ep.m} ${ep.p(realIds())}: real=${real.status}/${real.error?.code} fake=${fake.status}/${fake.error?.code}`);
        // 絕不能成功
        if (real.status < 400) diffs.push(`${ep.m} ${ep.p(realIds())} 竟然成功 ${real.status}`);
      }
      expect(diffs).toEqual([]);
    });
  }
  it('跨組織：另一個組織的管理者對這些資源一律拿不到（不成功、且與不存在 id 相同）', async () => {
    const diffs: string[] = [];
    for (const ep of endpoints) {
      const real = await cl.admin2.call(ep.m, ep.p(realIds()), bodyOf(ep, realIds()));
      const fake = await cl.admin2.call(ep.m, ep.p(fakeIds()).replace(cA, 'CMP-000000-0000'), bodyOf(ep, fakeIds()));
      if (real.status !== fake.status || real.error?.code !== fake.error?.code) diffs.push(`${ep.m} ${ep.p(realIds())}: real=${real.status}/${real.error?.code} fake=${fake.status}/${fake.error?.code}`);
      if (real.status < 400) diffs.push(`${ep.m} ${ep.p(realIds())} 竟然成功 ${real.status}`);
    }
    expect(diffs).toEqual([]);
  });
});

// ============================================================================
// A2. Phase 1 資源的同一類檢查（廠商、團主、商品、檔期、任務、關卡、重排）
// ============================================================================
const p1: Ep[] = [
  { m: 'GET', p: (d) => `/vendors/${d.vendA}` },
  { m: 'GET', p: (d) => `/hosts/${d.hostA}` },
  { m: 'GET', p: (d) => `/products/${d.prodA}` },
  { m: 'GET', p: () => `/campaigns/${cA}` },
  { m: 'GET', p: () => `/campaigns/${cA}/audit` },
  { m: 'GET', p: () => `/campaigns/${cA}/gates/G1` },
  { m: 'POST', p: () => `/campaigns/${cA}/gates/G1/request`, body: { note: 'x' } },
  { m: 'POST', p: () => `/campaigns/${cA}/status`, body: { action: 'hold', reason: 'x' } },
  { m: 'POST', p: () => `/campaigns/${cA}/reschedule`, body: { changes: { openDate: dayOffset(30) } } },
  { m: 'PATCH', p: () => `/campaigns/${cA}`, body: { title: 'hack' } },
  { m: 'GET', p: (d) => `/tasks/${d.taskA}` },
  { m: 'PATCH', p: (d) => `/tasks/${d.taskA}`, body: { note: 'x' } },
  { m: 'POST', p: (d) => `/tasks/${d.taskA}/status`, body: { status: 'DONE' } },
];
describe('A2. Phase 1 資源：範圍外的真實 id ≡ 不存在的 id', () => {
  const fakeP1 = () => ({ ...fakeIds() });
  for (const who of ['hostB', 'vendB'] as const) {
    it(`${who} 對 Phase 1 資源（檔期甲、廠商甲、團主甲、商品甲、任務）的回應與不存在的 id 相同`, async () => {
      const diffs: string[] = [];
      for (const ep of p1) {
        const real = await cl[who].call(ep.m, ep.p(realIds()), bodyOf(ep, realIds()));
        const fake = await cl[who].call(ep.m, ep.p(fakeP1()).replace(cA, 'CMP-000000-0000'), bodyOf(ep, fakeP1()));
        // 廠商／團主可以讀「自己的」廠商或團主資料；這裡全部用「別人的」資料，所以必須與不存在相同
        if (real.status !== fake.status || real.error?.code !== fake.error?.code) diffs.push(`${ep.m} ${ep.p(realIds())}: real=${real.status}/${real.error?.code} fake=${fake.status}/${fake.error?.code}`);
        if (real.status < 400) diffs.push(`${ep.m} ${ep.p(realIds())} 竟然成功 ${real.status}`);
      }
      expect(diffs).toEqual([]);
    });
  }
  it('editor2（非負責人、沒被指派任務）對檔期與任務資源的回應與不存在的 id 相同', async () => {
    const diffs: string[] = [];
    for (const ep of p1.filter((e) => /campaigns|tasks/.test(e.p(realIds())))) {
      const real = await cl.editor2.call(ep.m, ep.p(realIds()), bodyOf(ep, realIds()));
      const fake = await cl.editor2.call(ep.m, ep.p(fakeP1()).replace(cA, 'CMP-000000-0000'), bodyOf(ep, fakeP1()));
      if (real.status !== fake.status || real.error?.code !== fake.error?.code) diffs.push(`${ep.m} ${ep.p(realIds())}: real=${real.status}/${real.error?.code} fake=${fake.status}/${fake.error?.code}`);
    }
    expect(diffs).toEqual([]);
  });
  it('外部角色的清單端點只含自己範圍內的廠商／團主／社群／商品／檔期／任務', async () => {
    const ids = (r: { data: unknown }) => JSON.stringify(r.data);
    const hostList = await cl.hostA.call('GET', '/hosts');
    if (hostList.status === 200) { expect(ids(hostList)).toContain(hA); expect(ids(hostList)).not.toContain(hB); } else expect([403]).toContain(hostList.status);
    const vendList = await cl.vendA.call('GET', '/vendors');
    if (vendList.status === 200) { expect(ids(vendList)).toContain(vA); expect(ids(vendList)).not.toContain(vB); } else expect([403]).toContain(vendList.status);
    for (const [who, p] of [['hostA', '/vendors'], ['vendA', '/hosts'], ['vendA', '/communities'], ['hostA', '/commission-rules?hostId=' + hB], ['hostA', '/orders'], ['vendA', '/orders'], ['hostA', '/audit'], ['vendA', '/automation/jobs'], ['hostA', '/users'], ['vendA', '/exceptions'], ['hostA', '/imports']] as const) {
      const r = await cl[who].call('GET', p);
      const body = JSON.stringify(r.data ?? '');
      expect(r.status, `${who} GET ${p}`).toBeLessThan(500);
      expect(r.status === 200 && (body.includes(hB) || body.includes(vB) || body.includes(cB)), `${who} GET ${p} → ${r.status} 含別人的資料`).toBe(false);
    }
    for (const who of ['hostA', 'vendA'] as const) {
      for (const p of ['/campaigns', '/products', '/tasks', '/communities']) {
        const r = await cl[who].call('GET', p);
        if (r.status !== 200) continue;
        const body = JSON.stringify(r.data);
        expect(body.includes(cB) || body.includes(D.prodB) || body.includes(D.hostB) && who === 'vendA', `${who} GET ${p} 含別人的資料`).toBe(false);
      }
    }
  });

  it('外部角色讀自己範圍內的檔期／商品／廠商／團主：不含成本、目標營收、內部備註', async () => {
    const leaks: string[] = [];
    for (const [who, paths] of [['hostA', [`/campaigns/${cA}`, `/products/${D.prodA}`, `/hosts/${hA}`, '/campaigns', '/products', '/tasks']], ['vendA', [`/campaigns/${cA}`, `/products/${D.prodA}`, `/vendors/${vA}`, '/campaigns', '/products', '/tasks']]] as const) {
      for (const p of paths) {
        const r = await cl[who].call('GET', p);
        if (r.status !== 200) { leaks.push(`${who} GET ${p} → ${r.status}`); continue; }
        const str = JSON.stringify(r.json);
        // 團主可看到「自己」在檔期中的目標（ADR 待決：團主可見資料）；廠商完全不行
        const pattern = who === 'hostA' ? /costPrice|cost_price|internalNote|internal_note/ : /costPrice|cost_price|targetRevenue|target_revenue|internalNote|internal_note/;
        if (pattern.test(str)) leaks.push(`${who} ${p} 含敏感欄位`);
        if (str.includes(cB) || str.includes(D.prodB) || str.includes(vB) || str.includes(hB)) leaks.push(`${who} ${p} 含別人的資料`);
      }
    }
    expect(leaks).toEqual([]);
  });
});

// ============================================================================
// B. 外部角色（團主／廠商）的欄位洩漏：所有 GET 回應都不得含內部標記
// ============================================================================
describe('B. 外部角色看不到內部欄位與別人的資料', () => {
  const SECRET_MARKS = [M.batchNote, M.shipNote, M.caseInternal, M.caseDesc, M.evInternal, M.refundReason, M.override, M.adj, M.pay, M.exp];
  const gets = () => [
    '/fulfillment/batches', `/fulfillment/batches/${D.batchA}`, `/campaigns/${cA}/fulfillment`, '/inventory/stock', '/inventory/movements',
    '/aftersales/overview', '/aftersales/cases', `/aftersales/cases/${D.caseA}`, '/aftersales/refunds',
    '/settlements', `/settlements/${D.setA}`, '/finance/overview', '/payments', '/invoices', '/expenses', '/settlements/mine',
  ];
  for (const who of ['hostA', 'vendA'] as const) {
    it(`${who} 的所有讀取端點：不含內部備註／描述／退款原因／覆寫與調整原因／入帳與費用備註，也不含乙檔期資料`, async () => {
      const leaks: string[] = [];
      for (const p of gets()) {
        const r = await cl[who].call('GET', p);
        const s = JSON.stringify(r.json);
        for (const mk of SECRET_MARKS) if (s.includes(mk)) leaks.push(`${p} 洩漏 ${mk}`);
        for (const other of [D.batchB, D.shipB, D.caseB, cB]) if (s.includes(other)) leaks.push(`${p} 含乙檔期資料 ${other}`);
        if (/costPrice|cost_price|targetRevenue|internalNote|internal_note/.test(s)) leaks.push(`${p} 含敏感欄位名稱`);
      }
      expect(leaks).toEqual([]);
    });
  }
  it('外部角色的案件詳情只含公開處理紀錄；不含買家代號、訂單、負責人、退款', async () => {
    const r = await cl.hostA.call('GET', `/aftersales/cases/${D.caseA}`);
    expect(r.status).toBe(200);
    const s = JSON.stringify(r.json);
    expect(s).toContain(M.evPublic);
    for (const k of ['buyerRef', 'orderId', 'assigneeUserId', 'refunds', 'order', 'description']) expect(Object.keys(r.data)).not.toContain(k);
    expect(s).not.toContain(M.buyer);
  });
  it('團主的 /settlements/mine 只含自己、已確認的項目（草稿看不到）', async () => {
    const r = await cl.hostA.call('GET', '/settlements/mine');
    expect(r.status).toBe(200);
    expect(r.data.items).toEqual([]);
  });
});

// ============================================================================
// C. 角色×權限矩陣：不該有權限的角色一律 403（而不是 200／500）
// ============================================================================
describe('C. 權限矩陣', () => {
  const writes: Ep[] = endpoints.filter((e) => e.m !== 'GET');
  it('團主與廠商對所有寫入端點一律 403', async () => {
    const bad: string[] = [];
    for (const who of ['hostA', 'vendA'] as const) {
      for (const ep of writes) {
        const r = await cl[who].call(ep.m, ep.p(realIds()), bodyOf(ep, realIds()));
        if (r.status !== 403) bad.push(`${who} ${ep.m} ${ep.p(realIds())} → ${r.status}`);
      }
      for (const [m, p, b] of [['POST', '/inventory/movements', { skuId: skuA, delta: 1, reasonCode: 'RESTOCK', reason: 'x' }], ['POST', '/aftersales/cases', { campaignId: cA, caseType: 'OTHER', title: 'x' }], ['POST', '/settlements', { campaignId: cA }], ['POST', '/payments', {}], ['POST', '/invoices', {}], ['POST', '/expenses', {}]] as const) {
        const r = await cl[who].call(m, p, b);
        if (r.status !== 403) bad.push(`${who} ${m} ${p} → ${r.status}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it('營運小編沒有任何財務／結算權限；財務沒有履約與售後寫入權限；營運主管不能確認結算、不能完成退款', async () => {
    const bad: string[] = [];
    const check = async (who: keyof typeof cl, m: string, p: string, body: unknown, want: number) => {
      const r = await cl[who].call(m, p, body);
      if (r.status !== want) bad.push(`${who} ${m} ${p} → ${r.status}（期望 ${want}）`);
    };
    for (const p of ['/settlements', '/payments', '/invoices', '/expenses', '/finance/overview', `/settlements/${D.setA}`]) await check('editor', 'GET', p, undefined, 403);
    await check('editor', 'POST', `/settlements/${D.setA}/confirm`, {}, 403);
    await check('finance', 'POST', `/fulfillment/batches/${D.batchA}/cancel`, { reason: 'x' }, 403);
    await check('finance', 'POST', '/aftersales/cases', { campaignId: cA, caseType: 'OTHER', title: 'x' }, 403);
    await check('finance', 'POST', `/aftersales/refunds/${D.refundA}/decision`, { decision: 'APPROVED' }, 403);
    await check('manager', 'POST', `/settlements/${D.setA}/confirm`, {}, 403);
    await check('manager', 'POST', `/aftersales/refunds/${D.refundA}/complete`, {}, 403);
    await check('manager', 'POST', '/payments', { direction: 'IN', counterpartyType: 'PLATFORM', amount: 1, paidOn: dayOffset(-1) }, 403);
    await check('editor', 'POST', `/aftersales/refunds/${D.refundA}/decision`, { decision: 'APPROVED' }, 403);
    expect(bad).toEqual([]);
  });
  it('未登入一律 401（含新端點）', async () => {
    const anon = new Client();
    const bad: string[] = [];
    for (const ep of endpoints) {
      const r = await anon.call(ep.m, ep.p(realIds()), bodyOf(ep, realIds()));
      if (r.status !== 401) bad.push(`${ep.m} ${ep.p(realIds())} → ${r.status}`);
    }
    expect(bad).toEqual([]);
  });
});

// ============================================================================
// D. 冪等鍵必須綁定「完整請求」（包含網址上的父層 id）
// ============================================================================
describe('D. Idempotency-Key 綁定完整請求', () => {
  it('同一把 key＋同樣的內容＋不同檔期建立批次：不得回放另一個檔期的結果，必須被拒絕', async () => {
    const key = `idem-batch-${Date.now()}`;
    const body = { kind: 'SAMPLE', label: '同一批次內容' };
    const r1 = await cl.manager.call('POST', `/campaigns/${cA}/fulfillment/batches`, body, { 'idempotency-key': key });
    expect(r1.status).toBe(201);
    const r2 = await cl.manager.call('POST', `/campaigns/${cB}/fulfillment/batches`, body, { 'idempotency-key': key });
    expect(r2.status, `回放了別的檔期的結果：${JSON.stringify(r2.json)}`).toBe(422);
    const n = await query(`SELECT count(*)::int AS n FROM fulfillment_batches WHERE campaign_id=$1 AND label='同一批次內容'`, [cB]);
    expect(n[0].n).toBe(0);
  });
  it('同一把 key＋同樣的內容＋不同批次新增出貨單：不得回放，必須被拒絕', async () => {
    const key = `idem-ship-${Date.now()}`;
    const body = { quantity: 1 };
    const r1 = await cl.manager.call('POST', `/fulfillment/batches/${D.batchA}/shipments`, body, { 'idempotency-key': key });
    expect(r1.status).toBe(201);
    const r2 = await cl.manager.call('POST', `/fulfillment/batches/${D.batchB}/shipments`, body, { 'idempotency-key': key });
    expect(r2.status, `回放了別的批次的結果：${JSON.stringify(r2.json)}`).toBe(422);
  });
  it('同 key 同內容同檔期：第二次回放第一次的結果、不重複建立', async () => {
    const key = `idem-same-${Date.now()}`;
    const body = { kind: 'SAMPLE', label: '重送測試' };
    const r1 = await cl.manager.call('POST', `/campaigns/${cA}/fulfillment/batches`, body, { 'idempotency-key': key });
    const r2 = await cl.manager.call('POST', `/campaigns/${cA}/fulfillment/batches`, body, { 'idempotency-key': key });
    expect(r2.status).toBe(201);
    expect(r2.data.id).toBe(r1.data.id);
    expect(r2.data.replayed).toBe(true);
  });
  it('並發 5 個同 key 同內容：只建立 1 筆、其餘回放（無 500）', async () => {
    const key = `idem-conc-${Date.now()}`;
    const rs = await Promise.all(Array.from({ length: 5 }, () => cl.manager.call('POST', '/expenses', { category: 'OTHER', amount: 7, incurredOn: dayOffset(-1), note: `conc-${key}` }, { 'idempotency-key': key })));
    expect(rs.map((r) => r.status).filter((s) => s >= 500)).toEqual([]);
    const n = await query(`SELECT count(*)::int AS n FROM expenses WHERE note=$1`, [`conc-${key}`]);
    // 管理者沒有 finance.write → 全部 403；改用財務帳號重做
    expect(n[0].n).toBe(0);
    const rs2 = await Promise.all(Array.from({ length: 5 }, () => cl.finance.call('POST', '/expenses', { category: 'OTHER', amount: 7, incurredOn: dayOffset(-1), note: `conc2-${key}` }, { 'idempotency-key': key })));
    expect(rs2.map((r) => r.status).filter((s) => s >= 500)).toEqual([]);
    const n2 = await query(`SELECT count(*)::int AS n FROM expenses WHERE note=$1`, [`conc2-${key}`]);
    expect(n2[0].n).toBe(1);
  });
});

// ============================================================================
// E. 資料不變條件（資料庫層，繞過 API 也要擋住）
// ============================================================================
describe('E. 資料庫層不變條件', () => {
  const rejects = async (sql: string, params: unknown[] = []) => {
    let err: unknown = null;
    try { await pool().query(sql, params); } catch (e) { err = e; }
    return err as { code?: string; message?: string } | null;
  };
  it('append-only：庫存異動、售後處理紀錄、結算調整項、稽核紀錄都不可 UPDATE／DELETE', async () => {
    await ful.adjustStock(w.manager, { skuId: skuA, delta: 10, reasonCode: 'INITIAL', reason: '期初' });
    const mv = (await query<{ id: string }>('SELECT id FROM inventory_movements WHERE organization_id=$1 LIMIT 1', [w.orgId]))[0].id;
    const ev = (await query<{ id: number }>('SELECT id FROM case_events WHERE organization_id=$1 LIMIT 1', [w.orgId]))[0].id;
    const adj = (await query<{ id: string }>('SELECT id FROM settlement_adjustments WHERE organization_id=$1 LIMIT 1', [w.orgId]))[0].id;
    const au = (await query<{ id: number }>('SELECT id FROM audit_logs WHERE organization_id=$1 LIMIT 1', [w.orgId]))[0].id;
    const attempts: [string, string, unknown[]][] = [
      ['inventory UPDATE', 'UPDATE inventory_movements SET delta=999 WHERE id=$1', [mv]], ['inventory DELETE', 'DELETE FROM inventory_movements WHERE id=$1', [mv]],
      ['case_events UPDATE', `UPDATE case_events SET note='x' WHERE id=$1`, [ev]], ['case_events DELETE', 'DELETE FROM case_events WHERE id=$1', [ev]],
      ['adjustments UPDATE', 'UPDATE settlement_adjustments SET amount=1 WHERE id=$1', [adj]], ['adjustments DELETE', 'DELETE FROM settlement_adjustments WHERE id=$1', [adj]],
      ['audit UPDATE', `UPDATE audit_logs SET action='x' WHERE id=$1`, [au]], ['audit DELETE', 'DELETE FROM audit_logs WHERE id=$1', [au]],
    ];
    const bad: string[] = [];
    for (const [name, sql, p] of attempts) if (!(await rejects(sql, p))) bad.push(`${name} 竟然成功`);
    expect(bad).toEqual([]);
  });
  it('軟刪除：所有 Phase 2 業務表都不可實體 DELETE', async () => {
    const tables: [string, string][] = [['fulfillment_batches', D.batchA], ['shipments', D.shipA], ['service_cases', D.caseA], ['refund_requests', D.refundA], ['settlements', D.setA], ['settlement_items', D.itemA], ['payments', D.payA], ['invoices', D.invA], ['expenses', D.expA]];
    const bad: string[] = [];
    for (const [t, id] of tables) if (!(await rejects(`DELETE FROM ${t} WHERE id=$1`, [id]))) bad.push(`${t} 可被實體刪除`);
    expect(bad).toEqual([]);
  });
  it('已確認的結算：項目不可被改成指向另一份草稿結算（搬移繞過鎖定）', async () => {
    // 建一份已確認的結算（獨立檔期）與一份草稿結算，嘗試把已確認結算的項目搬到草稿
    const cid = (await mkCampaign(w, vA, { hosts: [{ hostId: hA, targetRevenue: 1000 }], sampleReadyDate: dayOffset(-40), openDate: dayOffset(-3), closeDate: dayOffset(7) }, w.manager)).id;
    await query(`UPDATE campaigns SET status='RUNNING' WHERE id=$1`, [cid]);
    const s1 = (await st.createSettlement(w.finance, { campaignId: cid })).id;
    await st.confirmSettlement(w.finance, s1);
    const it1 = (await query<{ id: string }>('SELECT id FROM settlement_items WHERE settlement_id=$1', [s1]))[0].id;
    const err = await rejects('UPDATE settlement_items SET settlement_id=$2, host_id=$3, net_sales=1 WHERE id=$1', [it1, D.setA, hB]);   // 換掉 host_id 以避開唯一索引，單純測試鎖定
    expect(err, '已確認結算的項目竟然被搬到草稿結算並改了金額').not.toBeNull();
  });
  it('已確認的結算：不可被改回草稿，也不可改 campaign_id', async () => {
    const s = (await query<{ id: string }>(`SELECT id FROM settlements WHERE organization_id=$1 AND status='CONFIRMED' LIMIT 1`, [w.orgId]))[0].id;
    expect(await rejects(`UPDATE settlements SET status='DRAFT' WHERE id=$1`, [s])).not.toBeNull();
    expect(await rejects(`UPDATE settlements SET campaign_id=$2 WHERE id=$1`, [s, cB])).not.toBeNull();
  });
  it('每個 Phase 2 寫入動作都有稽核紀錄（以實際資料抽查）', async () => {
    const need: [string, string][] = [['fulfillment_batch', D.batchA], ['shipment', D.shipA], ['service_case', D.caseA], ['refund_request', D.refundA], ['settlement', D.setA], ['settlement_item', D.itemA], ['payment', D.payA], ['expense', D.expA], ['invoice', D.invA]];
    const missing: string[] = [];
    for (const [t, id] of need) {
      const n = await query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs WHERE entity_type=$1 AND entity_id=$2`, [t, id]);
      if (!n[0].n) missing.push(`${t} ${id}`);
    }
    expect(missing).toEqual([]);
  });
});

// ============================================================================
// F. 財務紀錄的一致性
// ============================================================================
describe('F. 財務關聯一致性', () => {
  it('入帳已關聯結算項目後，不可只改檔期而讓「檔期」與「結算項目所屬檔期」不一致', async () => {
    const p = await fin.createPayment(w.finance, { direction: 'OUT', counterpartyType: 'HOST', counterpartyId: hA, amount: 20, paidOn: dayOffset(-1), settlementItemId: D.itemA });
    await expect(fin.updatePayment(w.finance, p.id, { campaignId: cB })).rejects.toBeTruthy();
    const row = (await query<{ campaign_id: string; settlement_item_id: string }>('SELECT campaign_id, settlement_item_id FROM payments WHERE id=$1', [p.id]))[0];
    expect(row.campaign_id).toBe(cA);
  });
  it('入帳不可關聯到他組織的結算項目／檔期', async () => {
    await expect(fin.createPayment(w2.finance, { direction: 'IN', counterpartyType: 'PLATFORM', amount: 1, paidOn: dayOffset(-1), settlementItemId: D.itemA })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(fin.createExpense(w2.finance, { category: 'OTHER', amount: 1, incurredOn: dayOffset(-1), campaignId: cA })).rejects.toBeTruthy();
  });
  it('同一檔期並發建立結算：恰好 1 個成功、其餘 409（不是 500）', async () => {
    const cid = (await mkCampaign(w, vA, { hosts: [{ hostId: hA, targetRevenue: 1000 }], sampleReadyDate: dayOffset(-40), openDate: dayOffset(-3), closeDate: dayOffset(7) }, w.manager)).id;
    await query(`UPDATE campaigns SET status='RUNNING' WHERE id=$1`, [cid]);
    const rs = await Promise.all(Array.from({ length: 4 }, () => cl.finance.call('POST', '/settlements', { campaignId: cid })));
    const codes = rs.map((r) => r.status).sort();
    expect(codes.filter((c) => c >= 500)).toEqual([]);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    const n = await query(`SELECT count(*)::int AS n FROM settlements WHERE campaign_id=$1 AND status IN ('DRAFT','CONFIRMED')`, [cid]);
    expect(n[0].n).toBe(1);
  });
});

// ============================================================================
// G. 輸入邊界：任何壞輸入都該是 4xx，不得 500
// ============================================================================
describe('G. 輸入邊界（不得出現 500）', () => {
  const bad = [-1, 0, 1.5, 1e21, '100', null, 'NaN', {}, [], Number.MAX_SAFE_INTEGER + 2, 2 ** 53, -(2 ** 53)];
  const calls: [string, string, (v: unknown) => unknown, keyof typeof cl][] = [
    ['POST', `/fulfillment/batches/${'$batch'}/shipments`, (v) => ({ quantity: v }), 'manager'],
    ['POST', '/inventory/movements', (v) => ({ skuId: skuA, delta: v, reasonCode: 'ADJUST', reason: 'x' }), 'manager'],
    ['POST', `/aftersales/cases/${'$case'}/refunds`, (v) => ({ amount: v, reason: 'x' }), 'editor'],
    ['POST', '/payments', (v) => ({ direction: 'IN', counterpartyType: 'PLATFORM', amount: v, paidOn: dayOffset(-1) }), 'finance'],
    ['POST', '/expenses', (v) => ({ category: 'OTHER', amount: v, incurredOn: dayOffset(-1) }), 'finance'],
    ['POST', '/invoices', (v) => ({ invoiceNo: `X${Math.random()}`, invoiceDate: dayOffset(-1), amount: v }), 'finance'],
    ['POST', `/settlements/${'$set'}/adjustments`, (v) => ({ itemId: D.itemA, amount: v, reason: 'x' }), 'finance'],
    ['POST', `/settlement-items/${'$item'}/override`, (v) => ({ amount: v, reason: 'x' }), 'finance'],
  ];
  it('各金額／數量欄位餵入壞值：只能回 4xx，不能 500，也不能寫入', async () => {
    const fails: string[] = [];
    for (const [m, p, mk, who] of calls) {
      const path = p.replace('$batch', D.batchA).replace('$case', D.caseA).replace('$set', D.setA).replace('$item', D.itemA);
      for (const v of bad) {
        const r = await cl[who].call(m, path, mk(v));
        if (r.status >= 500) fails.push(`${m} ${path} ${JSON.stringify(v)} → ${r.status}`);
      }
    }
    expect(fails).toEqual([]);
  });
  it('日期欄位壞值（不存在的日期、格式錯、超長）→ 4xx', async () => {
    const fails: string[] = [];
    for (const v of ['2026-02-30', '2026-13-01', 'abc', '2026/10/10', '', '2026-10-10T00:00:00Z', 'x'.repeat(1000), 20261010, null]) {
      for (const [m, p, b, who] of [
        ['POST', '/payments', { direction: 'IN', counterpartyType: 'PLATFORM', amount: 1, paidOn: v }, 'finance'],
        ['POST', '/expenses', { category: 'OTHER', amount: 1, incurredOn: v }, 'finance'],
        ['POST', '/invoices', { invoiceNo: `D${Math.random()}`, invoiceDate: v, amount: 1 }, 'finance'],
        ['POST', `/campaigns/${cA}/fulfillment/batches`, { label: 'x', kind: 'SAMPLE', plannedShipDate: v }, 'manager'],
        ['POST', '/aftersales/cases', { campaignId: cA, caseType: 'OTHER', title: 'x', dueDate: v }, 'manager'],
      ] as const) {
        const r = await cl[who].call(m, p, b);
        if (r.status >= 500) fails.push(`${m} ${p} ${JSON.stringify(v)} → ${r.status}`);
        if (v !== '' && v !== null && r.status < 400) fails.push(`${m} ${p} ${JSON.stringify(v)} 被接受 ${r.status}`);
      }
    }
    expect(fails).toEqual([]);
  });
  it('字串過長／型別錯誤／不明欄位：4xx 或被忽略，不得 500；不得透過 body 覆寫 status、organization_id、version', async () => {
    const huge = 'x'.repeat(100_000);
    const r1 = await cl.manager.call('POST', `/campaigns/${cA}/fulfillment/batches`, { label: huge });
    expect(r1.status).toBeLessThan(500); expect(r1.status).toBeGreaterThanOrEqual(400);
    const r2 = await cl.editor.call('POST', '/aftersales/cases', { campaignId: cA, caseType: 'OTHER', title: 'x', status: 'CLOSED', organization_id: w2.orgId, organizationId: w2.orgId, id: 'CAS-HACK' });
    expect(r2.status).toBe(201);
    const row = (await query<{ status: string; organization_id: string; id: string }>('SELECT status, organization_id, id FROM service_cases WHERE id=$1', [r2.data.id]))[0];
    expect(row).toMatchObject({ status: 'OPEN', organization_id: w.orgId });
    expect(row.id).not.toBe('CAS-HACK');
    const r3 = await cl.manager.call('PATCH', `/fulfillment/shipments/${D.shipA}`, { status: 'DELIVERED', organizationId: w2.orgId, quantity: 4 });
    expect(r3.status).toBeLessThan(500);
    const sh = (await query<{ status: string; organization_id: string }>('SELECT status, organization_id FROM shipments WHERE id=$1', [D.shipA]))[0];
    expect(sh).toMatchObject({ status: 'PENDING', organization_id: w.orgId });
    for (const body of [null, 'string', 123, [], true]) {
      const r = await cl.manager.call('POST', '/fulfillment/batches', body as never);
      expect(r.status, JSON.stringify(body)).toBeLessThan(500);
    }
  });
  it('路徑參數：特殊字元、超長、百分比編碼 → 404/4xx，不得 500', async () => {
    const fails: string[] = [];
    for (const id of ["'; DROP TABLE shipments;--", '%00', '..%2f..%2fetc', 'x'.repeat(5000), '%E0%A4%A', '１２３']) {
      for (const p of [`/fulfillment/batches/${id}`, `/aftersales/cases/${id}`, `/settlements/${id}`, `/campaigns/${id}/fulfillment`]) {
        const r = await cl.manager.call('GET', p);
        if (r.status >= 500) fails.push(`${p} → ${r.status}`);
      }
    }
    expect(fails).toEqual([]);
    expect((await query('SELECT 1 FROM shipments LIMIT 1')).length).toBe(1);
  });
  it('列表查詢參數：注入字元、負頁、超大 limit → 不得 500', async () => {
    const fails: string[] = [];
    for (const q of ["status=' OR 1=1 --", 'limit=-5', 'limit=99999999999999999999', 'page=0', 'page=abc', 'q=%25%25%25', "campaignId='", 'overdue=1&mine=1']) {
      for (const p of ['/fulfillment/batches', '/aftersales/cases', '/aftersales/refunds', '/settlements', '/payments', '/invoices', '/expenses', '/inventory/stock', '/inventory/movements']) {
        const r = await cl.finance.call('GET', `${p}?${q}`);
        const r2 = await cl.manager.call('GET', `${p}?${q}`);
        if (r.status >= 500 || r2.status >= 500) fails.push(`${p}?${q} → ${r.status}/${r2.status}`);
      }
    }
    expect(fails).toEqual([]);
  });
});

// ============================================================================
// H. 併發與交易
// ============================================================================
describe('H. 併發與交易', () => {
  it('同一張已核准的退款並發「完成」（寫回訂單）：只會寫回一次', async () => {
    const orderId = D.ord_S2;   // gross 2000
    const c = (await as.createCase(w.manager, { campaignId: cA, caseType: 'REFUND', title: '併發完成', orderId })).id;
    const r = await as.requestRefund(w.editor, c, { amount: 500, reason: 'x', orderId });
    await as.decideRefund(w.manager, r.id, { decision: 'APPROVED' });
    const rs = await Promise.all(Array.from({ length: 4 }, () => cl.finance.call('POST', `/aftersales/refunds/${r.id}/complete`, { writeback: true })));
    expect(rs.filter((x) => x.status >= 500)).toEqual([]);
    expect(rs.filter((x) => x.status === 200)).toHaveLength(1);
    const o = (await query<{ refund_amount: number; status: string }>('SELECT refund_amount, status FROM orders WHERE id=$1', [orderId]))[0];
    expect(Number(o.refund_amount)).toBe(500);
    expect(o.status).toBe('PARTIAL_REFUND');
  });
  it('庫存並發扣減：結果永遠不會是負數，且成功筆數 × 數量 ≤ 期初', async () => {
    const sku = skuB;
    await ful.adjustStock(w.manager, { skuId: sku, delta: 10, reasonCode: 'INITIAL', reason: '期初' });
    const rs = await Promise.all(Array.from({ length: 8 }, () => cl.manager.call('POST', '/inventory/movements', { skuId: sku, delta: -3, reasonCode: 'DAMAGE', reason: '併發報廢' })));
    expect(rs.filter((x) => x.status >= 500)).toEqual([]);
    const ok = rs.filter((x) => x.status === 201).length;
    expect(ok).toBe(3);
    const bal = (await query<{ n: number }>('SELECT COALESCE(sum(delta),0)::int AS n FROM inventory_movements WHERE sku_id=$1', [sku]))[0].n;
    expect(bal).toBe(1);
  });
  it('同一追蹤碼並發新增出貨單：只有 1 張成功，其餘衝突（不是 500）', async () => {
    const rs = await Promise.all(Array.from({ length: 4 }, () => cl.manager.call('POST', `/fulfillment/batches/${D.batchA}/shipments`, { quantity: 1, carrier: '新竹', trackingNo: 'TRK-DUP-CONC' })));
    expect(rs.filter((x) => x.status >= 500)).toEqual([]);
    expect(rs.filter((x) => x.status === 201)).toHaveLength(1);
  });
  it('同一庫存異動並發更正：只更正一次', async () => {
    const mv = await ful.adjustStock(w.manager, { skuId: skuA, delta: 5, reasonCode: 'RESTOCK', reason: '補貨' });
    const rs = await Promise.all(Array.from({ length: 4 }, () => cl.manager.call('POST', `/inventory/movements/${mv.id}/correct`, { reason: '更正' })));
    expect(rs.filter((x) => x.status >= 500)).toEqual([]);
    expect(rs.filter((x) => x.status === 201)).toHaveLength(1);
  });
});

// ============================================================================
// I. 已知的資料正確性風險：已完成但未寫回的退款，不應讓同一張訂單被超額退款
// ============================================================================
describe('I. 退款餘額（含「完成但未寫回」）', () => {
  it('訂單 gross=1000：完成一筆 1000（未寫回）後，不得再為同一張訂單申請任何退款', async () => {
    const orderId = D.ord_S1;   // gross 1000（前面已有 300 的申請處理中，此處用另一張訂單）
    const o2 = D.ord_S3;        // gross 3000
    const c = (await as.createCase(w.manager, { campaignId: cA, caseType: 'REFUND', title: '超額退款', orderId: o2 })).id;
    const r = await as.requestRefund(w.editor, c, { amount: 3000, reason: 'x', orderId: o2 });
    await as.decideRefund(w.manager, r.id, { decision: 'APPROVED' });
    await as.completeRefund(w.finance, r.id, { writeback: false });
    const c2 = (await as.createCase(w.manager, { campaignId: cA, caseType: 'REFUND', title: '再退一次', orderId: o2 })).id;
    await expect(as.requestRefund(w.editor, c2, { amount: 1000, reason: 'x', orderId: o2 })).rejects.toBeTruthy();
    void orderId;
  });
});

// ============================================================================
// J. 其他強化：K6 清理、登入鎖定期滿、壞 cookie、分頁／LIMIT 邊界、NUL 字元、稽核範圍
// ============================================================================
describe('J. 強化項目', () => {
  it('K6：過期的 idempotency_keys 只清本組織、只清超過保留天數者；每日工作預設停用、啟用後才清', async () => {
    const old = new Date(Date.now() - 40 * 86_400_000), fresh = new Date(Date.now() - 2 * 86_400_000);
    const ins = (org: string, key: string, at: Date) => query(`INSERT INTO idempotency_keys (organization_id, scope, key, response, created_at) VALUES ($1,'sec.test',$2,'{}'::jsonb,$3)`, [org, key, at]);
    await ins(w.orgId, 'old-1', old); await ins(w.orgId, 'old-2', old); await ins(w.orgId, 'fresh-1', fresh); await ins(w2.orgId, 'old-other-org', old);
    const count = async (org: string, key: string) => (await query<{ n: number }>(`SELECT count(*)::int AS n FROM idempotency_keys WHERE organization_id=$1 AND key=$2`, [org, key]))[0].n;
    // 工作預設停用：執行會被略過，什麼都不清
    const skipped = await runJob(w.orgId, 'daily_summary', { now: new Date() });
    expect(skipped).toMatchObject({ status: 'SKIPPED', reason: 'disabled' });
    expect(await count(w.orgId, 'old-1')).toBe(1);
    await setJobEnabled(w.admin, 'daily_summary', true);
    const ran = await runJob(w.orgId, 'daily_summary', { now: new Date(), idempotencyKey: `purge-test-${Date.now()}` });
    expect(ran.status).toBe('SUCCEEDED');
    expect(Number(ran.stats?.idempotencyKeysPurged)).toBeGreaterThanOrEqual(2);
    expect(await count(w.orgId, 'old-1')).toBe(0);
    expect(await count(w.orgId, 'old-2')).toBe(0);
    expect(await count(w.orgId, 'fresh-1')).toBe(1);
    expect(await count(w2.orgId, 'old-other-org')).toBe(1);   // 別的組織不受影響
    expect(await purgeExpiredIdempotencyKeys(w.orgId)).toBe(0);   // 再跑一次沒有東西可清
    await setJobEnabled(w.admin, 'daily_summary', false);
  });

  it('登入鎖定期滿後重新計數：期滿後輸錯一次不會立刻再鎖 15 分鐘；密碼正確即可登入', async () => {
    resetRateLimits();
    const u = await addUser(w.orgId, 'OPS_EDITOR');
    const email = (await query<{ email: string }>('SELECT email FROM users WHERE id=$1', [u.userId]))[0].email;
    const c = new Client(email);
    for (let i = 0; i < 5; i++) expect((await c.call('POST', '/auth/login', { email, password: 'wrong-password' })).status).toBe(401);
    expect((await c.call('POST', '/auth/login', { email, password: PW })).status).toBe(429);   // 已鎖定，即使密碼正確
    await query(`UPDATE users SET locked_until = now() - interval '1 minute' WHERE id=$1`, [u.userId]);   // 模擬鎖定期滿
    expect((await c.call('POST', '/auth/login', { email, password: 'wrong-password' })).status).toBe(401);
    const row = (await query<{ failed_login_count: number; locked_until: Date | null }>('SELECT failed_login_count, locked_until FROM users WHERE id=$1', [u.userId]))[0];
    expect(row.locked_until).toBeNull();
    expect(row.failed_login_count).toBe(1);
    expect((await c.call('POST', '/auth/login', { email, password: PW })).status).toBe(200);
  });

  it('壞的 cookie 百分比編碼視為沒有 session（401），不是 500', async () => {
    expect(parseCookie('erp_session=%E0%A4%A', 'erp_session')).toBeNull();
    expect(parseCookie('erp_session=%', 'erp_session')).toBeNull();
    expect(parseCookie('a=1; erp_session=abc%20d', 'erp_session')).toBe('abc d');
    const r = await new Client().call('GET', '/auth/me', undefined, { cookie: 'erp_session=%E0%A4%A' });
    expect(r.status).toBe(401);
  });

  it('分頁參數：page／limit 為 Infinity、極大、負數、非數字時都收斂到合法值（不產生 OFFSET Infinity）', () => {
    for (const q of ['page=1e999', 'page=1e30', 'page=-3', 'page=abc', 'limit=1e999', 'limit=-5', 'limit=0', 'limit=2.9', 'page=2.7&limit=10']) {
      const p = pageParams(new URLSearchParams(q));
      expect(Number.isInteger(p.limit) && p.limit >= 1 && p.limit <= 200, q).toBe(true);
      expect(Number.isSafeInteger(p.offset) && p.offset >= 0, q).toBe(true);
    }
    expect(pageParams(new URLSearchParams('page=2&limit=10'))).toEqual({ limit: 10, offset: 10 });
  });

  it('列表 API：page=1e999、page=1e30 回 200（不是 500）、/audit?limit=-5 回 200', async () => {
    for (const q of ['page=1e999', 'page=1e30', 'page=99999999999']) {
      const r1 = await cl.manager.call('GET', `/fulfillment/batches?${q}`);
      expect(r1.status, q).toBe(200);
      expect(Array.isArray(r1.data.items), q).toBe(true);
    }
    for (const q of ['limit=-5', 'limit=0', 'limit=abc', 'limit=1e999']) expect((await cl.admin.call('GET', `/audit?${q}`)).status, q).toBe(200);
  });

  it('NUL 字元：查詢參數、路徑、JSON 內容都回 4xx（不是 500）', async () => {
    expect((await cl.manager.call('GET', `/fulfillment/batches?campaignId=%00`)).status).toBe(422);
    expect((await cl.manager.call('GET', `/fulfillment/batches/x%00y`)).status).toBe(404);
    const r = await cl.manager.call('POST', `/campaigns/${cA}/fulfillment/batches`, '{"label":"a\u0000b"}', { 'content-type': 'application/json' });
    expect(r.status).toBe(422);
    expect((await query(`SELECT 1 FROM fulfillment_batches WHERE label LIKE 'a%b' AND campaign_id=$1`, [cA])).length).toBe(0);
  });

  it('財務人員的稽核紀錄範圍包含入帳、發票、費用、結算項目、退款（Phase 2 的財務實體）', async () => {
    for (const t of ['payment', 'invoice', 'expense', 'settlement_item', 'refund_request']) {
      const r = await cl.finance.call('GET', `/audit?entityType=${t}`);
      expect(r.status).toBe(200);
      expect(r.data.length, t).toBeGreaterThan(0);
    }
    // 其他實體（例如使用者）仍看不到
    const u = await cl.finance.call('GET', '/audit?entityType=user');
    expect(u.data).toEqual([]);
  });

  it('訂單匯入套用檔期資料範圍：營運小編不能把訂單匯入別人負責的檔期（訊息與不存在的檔期相同）', async () => {
    const row = (sid: string, cid: string) => [HEADER, `${sid},${cid},${at()},PAID,1,100,,imp-b,,,`].join('\n');
    const sid = `SCOPE-${Date.now()}`;
    const r = await importOrders(w.editor2, { sourceSystem: 'SHOP_SCOPE', csv: row(sid, cA) });
    expect(r).toMatchObject({ insertedOrders: 0, errorRows: 1 });
    const errs = await query<{ code: string; message: string }>('SELECT code, message FROM import_errors WHERE batch_id=$1', [r.batchId]);
    expect(errs[0].code).toBe('UNKNOWN_CAMPAIGN');
    const fake = await importOrders(w.editor2, { sourceSystem: 'SHOP_SCOPE', csv: row(`${sid}-F`, 'CMP-000000-0000') });
    const errs2 = await query<{ code: string }>('SELECT code FROM import_errors WHERE batch_id=$1', [fake.batchId]);
    expect(errs2[0].code).toBe(errs[0].code);
    expect((await query('SELECT 1 FROM orders WHERE source_order_id=$1', [sid])).length).toBe(0);
    // 負責人與主管仍可匯入
    const ok = await importOrders(w.editor, { sourceSystem: 'SHOP_SCOPE', csv: row(`${sid}-OK`, cA) });
    expect(ok.insertedOrders).toBe(1);
  });

  it('庫存餘額加總超過 int 範圍時，庫存頁仍可顯示（不因 ::int 溢位而整頁失敗）', async () => {
    const sku = (await query<{ id: string }>(`SELECT k.id FROM skus k WHERE k.organization_id=$1 AND k.id <> ALL($2::text[]) LIMIT 1`, [w.orgId, [skuA, skuB]]))[0]?.id
      ?? (await mkProduct(w, vA, { approve: true })).skuIds[0];
    for (let i = 0; i < 2; i++) await query(`INSERT INTO inventory_movements (id, organization_id, sku_id, delta, reason_code, reason) VALUES ($1,$2,$3,2000000000,'RESTOCK','overflow-test')`, [`INV-OVF-${Date.now()}-${i}`, w.orgId, sku]);
    const r = await cl.manager.call('GET', `/inventory/stock?tracked=1&limit=200`);
    expect(r.status).toBe(200);
    expect(r.data.items.find((x: { skuId: string }) => x.skuId === sku)?.balance).toBe(4_000_000_000);
  });

  it('訂單匯入：異常大的數量／單價只讓該列進錯誤佇列，不會讓整批匯入失敗', async () => {
    const t = Date.now();
    const csv = [HEADER, `HUGE-${t}-1,${cA},${at()},PAID,99999999999999999999,100,,hb,,,`, `HUGE-${t}-2,${cA},${at()},PAID,1,99999999999999999999,,hb,,,`, `HUGE-${t}-3,${cA},${at()},PAID,1000000,100000000,,hb,,,`, `HUGE-${t}-4,${cA},${at()},PAID,2,300,,hb,,,`].join('\n');
    const r = await importOrders(w.manager, { sourceSystem: 'SHOP_HUGE', csv });
    expect(r).toMatchObject({ insertedOrders: 2, errorRows: 2 });
    const codes = (await query<{ code: string }>('SELECT code FROM import_errors WHERE batch_id=$1 ORDER BY line_no', [r.batchId])).map((x) => x.code);
    expect(codes).toEqual(['BAD_QUANTITY', 'BAD_PRICE']);
  });

  it('路由層收到無法編碼的路徑片段（例如孤立的代理字元）回 400，不是 500', async () => {
    const res = await dispatch(new Request('http://localhost:3000/api/x', { method: 'GET' }), ['fulfillment', 'batches', '\uD800']);
    expect(res.status).toBe(400);
  });

  it('冪等鍵綁定送出者：另一位使用者拿同一把 key＋同樣內容，不會取回別人建立的資料', async () => {
    const key = `idem-user-${Date.now()}`;
    const body = { category: 'OTHER', amount: 9, incurredOn: dayOffset(-1), note: `user-bind-${key}` };
    const a = await cl.finance.call('POST', '/expenses', body, { 'idempotency-key': key });
    expect(a.status).toBe(201);
    const fin2 = await Client.forActor(await addUser(w.orgId, 'FINANCE'));
    const b = await fin2.call('POST', '/expenses', body, { 'idempotency-key': key });
    expect(b.status).toBe(422);
  });
});

// ============================================================================
// L. 稽核覆蓋：Phase 2 的每一個寫入動作都必須留下稽核紀錄
// ============================================================================
describe('L. 每個寫入動作都有稽核紀錄', () => {
  it('履約／售後／財務共 32 個寫入動作：執行前後 audit_logs 都要增加', async () => {
    const count = async () => (await query<{ n: number }>('SELECT count(*)::int AS n FROM audit_logs WHERE organization_id=$1', [w.orgId]))[0].n;
    const missing: string[] = [];
    const step = async (name: string, fn: () => Promise<unknown>) => {
      const before = await count();
      await fn();
      if ((await count()) <= before) missing.push(name);
    };
    const cid = (await mkCampaign(w, vA, { hosts: [{ hostId: hA, targetRevenue: 1000 }], sampleReadyDate: dayOffset(-40), openDate: dayOffset(-3), closeDate: dayOffset(7) }, w.manager)).id;
    await query(`UPDATE campaigns SET status='RUNNING' WHERE id=$1`, [cid]);
    await importOrders(w.manager, { sourceSystem: 'SHOP_L', csv: [HEADER, `L1,${cid},${at()},PAID,1,1000,,lb,${hA},,`, `L2,${cid},${at()},PAID,1,500,,lb2,${hA},,`].join('\n') });
    const orderId = (await query<{ id: string }>('SELECT id FROM orders WHERE source_order_id=$1 AND organization_id=$2', ['L1', w.orgId]))[0].id;
    const m = w.manager, f = w.finance;
    let batch = '', ship = '', mv = '', cs = '', rf = '', st1 = '', item = '', pay = '', inv = '', ex = '';
    await step('fulfillment.createBatch', async () => { batch = (await ful.createBatch(m, cid, { kind: 'ORDER', label: 'L' })).id; });
    await step('fulfillment.updateBatch', () => ful.updateBatch(m, batch, { label: 'L2' }));
    await step('fulfillment.addShipment', async () => { ship = (await ful.addShipment(m, batch, { quantity: 2, carrier: '黑貓', trackingNo: 'TRK-L-1' })).id; });
    await step('fulfillment.updateShipment', () => ful.updateShipment(m, ship, { quantity: 3 }));
    await step('fulfillment.setShipmentStatus(PACKED)', () => ful.setShipmentStatus(m, ship, { to: 'PACKED' }));
    await step('fulfillment.setShipmentStatus(SHIPPED)', () => ful.setShipmentStatus(m, ship, { to: 'SHIPPED' }));
    await step('fulfillment.setShipmentStatus(DELIVERED)', () => ful.setShipmentStatus(m, ship, { to: 'DELIVERED' }));
    await step('fulfillment.confirmReceipt', () => ful.confirmReceipt(m, ship, { signer: '管理室' }));
    await step('fulfillment.adjustStock', async () => { mv = (await ful.adjustStock(m, { skuId: skuB, delta: 4, reasonCode: 'RESTOCK', reason: 'L' })).id; });
    await step('fulfillment.reverseMovement', () => ful.reverseMovement(m, mv, 'L'));
    await step('fulfillment.cancelBatch', async () => { const b2 = (await ful.createBatch(m, cid, { kind: 'SAMPLE', label: 'L-cancel' })).id; await ful.cancelBatch(m, b2, 'L'); });
    await step('aftersales.createCase', async () => { cs = (await as.createCase(m, { campaignId: cid, caseType: 'REFUND', title: 'L', orderId })).id; });
    await step('aftersales.updateCase', () => as.updateCase(m, cs, { priority: 'HIGH' }));
    await step('aftersales.addCaseNote', () => as.addCaseNote(m, cs, { note: 'L' }));
    await step('aftersales.requestRefund', async () => { rf = (await as.requestRefund(m, cs, { amount: 100, reason: 'L', orderId })).id; });
    await step('aftersales.decideRefund', () => as.decideRefund(m, rf, { decision: 'APPROVED' }));
    await step('aftersales.completeRefund', () => as.completeRefund(f, rf, { writeback: true }));
    await step('aftersales.setCaseStatus(IN_PROGRESS)', () => as.setCaseStatus(m, cs, { to: 'IN_PROGRESS' }));
    await step('aftersales.setCaseStatus(RESOLVED)', () => as.setCaseStatus(m, cs, { to: 'RESOLVED', resolution: 'L' }));
    await step('settlements.createSettlement', async () => { st1 = (await st.createSettlement(f, { campaignId: cid })).id; });
    item = (await st.getSettlement(f, st1)).items[0].id;
    await step('settlements.recalculateSettlement', async () => { await query(`UPDATE orders SET refund_amount=refund_amount WHERE id=$1`, [orderId]); await st.recalculateSettlement(f, st1); });
    await step('settlements.setItemOverride', () => st.setItemOverride(f, item, { amount: 50, reason: 'L' }));
    await step('settlements.addAdjustment', () => st.addAdjustment(f, st1, { itemId: item, amount: 3, reason: 'L' }));
    await step('finance.createPayment', async () => { pay = (await fin.createPayment(f, { direction: 'OUT', counterpartyType: 'HOST', counterpartyId: hA, amount: 10, paidOn: dayOffset(-1) })).id; });
    await step('finance.updatePayment', () => fin.updatePayment(f, pay, { amount: 11 }));
    await step('finance.matchPayment', () => fin.matchPayment(f, pay, { campaignId: cid }));
    await step('finance.unmatchPayment', () => fin.unmatchPayment(f, pay, 'L'));
    await step('finance.voidPayment', () => fin.voidPayment(f, pay, 'L'));
    await step('finance.createInvoice', async () => { inv = (await fin.createInvoice(f, { invoiceNo: `L-${Date.now()}`, invoiceDate: dayOffset(-1), amount: 1 })).id; });
    await step('finance.updateInvoice', () => fin.updateInvoice(f, inv, { amount: 2 }));
    await step('finance.issueInvoice', () => fin.issueInvoice(f, inv));
    await step('finance.voidInvoice', () => fin.voidInvoice(f, inv, 'L'));
    await step('finance.createExpense', async () => { ex = (await fin.createExpense(f, { category: 'OTHER', amount: 1, incurredOn: dayOffset(-1) })).id; });
    await step('finance.updateExpense', () => fin.updateExpense(f, ex, { amount: 2 }));
    await step('finance.voidExpense', () => fin.voidExpense(f, ex, 'L'));
    await step('settlements.confirmSettlement', () => st.confirmSettlement(f, st1));
    await step('settlements.voidSettlement', () => st.voidSettlement(f, st1, 'L'));
    expect(missing).toEqual([]);
  });
});

// ============================================================================
// M. 結算確認要等進行中的訂單匯入／退款寫回完成（避免確認後才變動的訂單讓結算對不上）
// ============================================================================
describe('M. 結算確認與訂單變動的互斥', () => {
  async function mkSettleable() {
    const cid = (await mkCampaign(w, vA, { hosts: [{ hostId: hA, targetRevenue: 1000 }], sampleReadyDate: dayOffset(-40), openDate: dayOffset(-3), closeDate: dayOffset(7) }, w.manager)).id;
    await query(`UPDATE campaigns SET status='RUNNING' WHERE id=$1`, [cid]);
    await importOrders(w.manager, { sourceSystem: 'SHOP_M', csv: [HEADER, `M-${cid}-1,${cid},${at()},PAID,1,1000,,mb,${hA},,`].join('\n') });
    const sid = (await st.createSettlement(w.finance, { campaignId: cid })).id;
    return { cid, sid };
  }
  const settled = (p: Promise<unknown>) => { let done = false; p.then(() => { done = true; }, () => { done = true; }); return () => done; };

  it('訂單匯入進行中（持有匯入鎖）時，確認結算必須等待匯入結束才能完成', async () => {
    const { sid } = await mkSettleable();
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`import:${w.orgId}`]);   // 模擬進行中的匯入
      const p = st.confirmSettlement(w.finance, sid);
      const isDone = settled(p);
      await new Promise((r) => setTimeout(r, 400));
      expect(isDone(), '匯入尚未結束，確認卻已完成').toBe(false);
      await client.query('COMMIT');
      await expect(p).resolves.toMatchObject({ status: 'CONFIRMED' });
    } finally { client.release(); }
  });

  it('訂單列正被更新（例如退款寫回）時，確認結算必須等該交易結束；結束後若資料變動則因過期被擋下', async () => {
    const { cid, sid } = await mkSettleable();
    const oid = (await query<{ id: string }>('SELECT id FROM orders WHERE campaign_id=$1', [cid]))[0].id;
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE orders SET refund_amount=400, status=$2 WHERE id=$1', [oid, 'PARTIAL_REFUND']);   // 未提交的退款寫回
      const p = st.confirmSettlement(w.finance, sid);
      const isDone = settled(p);
      await new Promise((r) => setTimeout(r, 400));
      expect(isDone(), '訂單列尚在更新，確認卻已完成').toBe(false);
      await client.query('COMMIT');
      await expect(p).rejects.toMatchObject({ details: { code: 'STALE_CALCULATION' } });   // 提交後金額已變，必須重新試算
    } finally { client.release(); }
    expect((await query<{ status: string }>('SELECT status FROM settlements WHERE id=$1', [sid]))[0].status).toBe('DRAFT');
  });
});

void ful;
