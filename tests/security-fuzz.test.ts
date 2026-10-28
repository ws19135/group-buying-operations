import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { importOrders } from '@/server/modules/orders';
import { routes } from '@/server/api/routes';
import * as ful from '@/server/modules/fulfillment';
import * as as from '@/server/modules/aftersales';
import * as fin from '@/server/modules/finance';
import * as st from '@/server/modules/settlements';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkCampaign, mkHost, mkProduct, mkVendor, type World } from './helpers';

/**
 * API 全面模糊測試：每條路由 × 每個角色 × 壞的 id／內容／查詢參數。
 * 性質：任何輸入都不得讓伺服器回 5xx（那代表未處理的例外，也可能洩漏內部狀態）。
 */
const HEADER = 'source_order_id,campaign_id,ordered_at,status,quantity,unit_price,sku_code,buyer_ref,host_id,community_id,refund_amount';
let w: World;
const D: Record<string, string> = {};
let cl: Record<string, Client>;

beforeAll(async () => {
  w = await makeWorld();
  const v = (await mkVendor(w)).id;
  const p = await mkProduct(w, v, { approve: true });
  const h = (await mkHost(w)).id;
  D.camp = (await mkCampaign(w, v, { products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: [{ hostId: h, targetRevenue: 1000 }], sampleReadyDate: dayOffset(-40), openDate: dayOffset(-3), closeDate: dayOffset(7) }, w.editor)).id;
  await query(`UPDATE campaigns SET status='RUNNING' WHERE id=$1`, [D.camp]);
  D.host = h; D.vendor = v; D.product = p.id; D.sku = p.skuIds[0];
  await importOrders(w.manager, { sourceSystem: 'SHOP_Z', csv: [HEADER, `Z1,${D.camp},${dayOffset(-1)} 09:00,PAID,1,1000,,b1,${h},,`].join('\n') });
  D.order = (await query<{ id: string }>('SELECT id FROM orders WHERE organization_id=$1', [w.orgId]))[0].id;
  D.batch = (await ful.createBatch(w.editor, D.camp, { kind: 'ORDER', label: 'x' })).id;
  D.ship = (await ful.addShipment(w.editor, D.batch, { quantity: 1 })).id;
  D.case = (await as.createCase(w.editor, { campaignId: D.camp, caseType: 'REFUND', title: 'x', orderId: D.order })).id;
  D.refund = (await as.requestRefund(w.editor, D.case, { amount: 10, reason: 'x', orderId: D.order })).id;
  D.settle = (await st.createSettlement(w.finance, { campaignId: D.camp })).id;
  D.item = (await st.getSettlement(w.finance, D.settle)).items[0].id;
  D.pay = (await fin.createPayment(w.finance, { direction: 'IN', counterpartyType: 'PLATFORM', amount: 5, paidOn: dayOffset(-1) })).id;
  D.inv = (await fin.createInvoice(w.finance, { invoiceNo: 'FUZZ-1', invoiceDate: dayOffset(-1), amount: 1 })).id;
  D.exp = (await fin.createExpense(w.finance, { category: 'OTHER', amount: 1, incurredOn: dayOffset(-1) })).id;
  const hostU = await addUser(w.orgId, 'HOST', { hostIds: [h] });
  const vendU = await addUser(w.orgId, 'VENDOR', { vendorIds: [v] });
  cl = {};
  for (const [k, a] of Object.entries({ admin: w.admin, manager: w.manager, editor: w.editor, finance: w.finance, host: hostU, vendor: vendU })) cl[k] = await Client.forActor(a);
});

/** 依路由網址猜它的 :id 是哪一種資料；猜不到就用假 id */
function realFor(path: string, key: string): string {
  if (path.startsWith('/fulfillment/batches')) return D.batch;
  if (path.startsWith('/fulfillment/shipments')) return D.ship;
  if (path.startsWith('/aftersales/cases')) return D.case;
  if (path.startsWith('/aftersales/refunds')) return D.refund;
  if (path.startsWith('/settlements')) return D.settle;
  if (path.startsWith('/settlement-items')) return D.item;
  if (path.startsWith('/payments')) return D.pay;
  if (path.startsWith('/invoices')) return D.inv;
  if (path.startsWith('/expenses')) return D.exp;
  if (path.startsWith('/campaigns')) return D.camp;
  if (path.startsWith('/vendors')) return D.vendor;
  if (path.startsWith('/hosts')) return D.host;
  if (path.startsWith('/products')) return D.product;
  if (path.startsWith('/skus')) return D.sku;
  if (path.startsWith('/inventory/movements')) return 'INV-000001';
  return key === 'key' ? 'daily_summary' : 'ZZZ-000000';
}

const BODIES: unknown[] = [undefined, {}, { x: 1 }, [], 'str', 123, null, { reason: 5, note: {}, amount: 'x', quantity: -1, to: 'NOPE', status: 'NOPE', decision: 'NOPE', changes: 5, token: [], payload: 1 }];
const QUERIES = ['', 'limit=-5&page=-1', "q=%27%22%5C&status=%27", 'limit=1e999&page=1e999', 'month=2026-99', 'hostId=%27', 'campaignId=%00'];

describe('API 模糊測試：不得出現 5xx', () => {
  const skip = new Set(['/auth/login', '/auth/logout']);
  for (const who of ['admin', 'manager', 'editor', 'finance', 'host', 'vendor']) {
    it(`${who}：每條路由 × 假／真 id × 壞 body／壞 query → 無 5xx`, async () => {
      const bad: string[] = [];
      for (const r of routes) {
        if (skip.has(r.path)) continue;
        const keys = [...r.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]);
        const variants = [0, 1];
        for (const v of variants) {
          let path = r.path;
          for (const k of keys) path = path.replace(`:${k}`, encodeURIComponent(v === 0 ? 'ZZZ-000000' : realFor(r.path, k)));
          if (r.method === 'GET') {
            for (const q of QUERIES) {
              const res = await cl[who].call('GET', `${path}${q ? `?${q}` : ''}`);
              if (res.status >= 500) bad.push(`GET ${path}?${q} → ${res.status} ${res.error?.message}`);
            }
          } else {
            for (const b of BODIES) {
              const res = await cl[who].call(r.method, path, b as never);
              if (res.status >= 500) bad.push(`${r.method} ${path} ${JSON.stringify(b)} → ${res.status} ${res.error?.message}`);
            }
          }
        }
      }
      expect(bad).toEqual([]);
    }, 240_000);
  }
  it('壞 cookie／壞 Origin／壞 content-type／超大 body 都不得 5xx', async () => {
    const c = cl.manager;
    const outs = [];
    for (const cookie of ['erp_session=%E0%A4%A', 'erp_session=%', 'erp_session=' + 'x'.repeat(10_000), 'garbage', 'erp_session=;;;=']) {
      outs.push(['cookie ' + cookie.slice(0, 20), await new Client().call('GET', '/auth/me', undefined, { cookie })]);
    }
    outs.push(['origin null', await c.call('POST', '/aftersales/cases', { campaignId: D.camp, caseType: 'OTHER', title: 'x' }, { origin: 'null' })]);
    outs.push(['bad ct', await c.call('POST', '/aftersales/cases', '{"a":1}', { 'content-type': 'text/plain' })]);
    outs.push(['bad json', await c.call('POST', '/aftersales/cases', '{', { 'content-type': 'application/json' })]);
    outs.push(['idem huge', await c.call('POST', '/aftersales/cases', { campaignId: D.camp, caseType: 'OTHER', title: 'x' }, { 'idempotency-key': 'k'.repeat(5000) })]);
    const bad = outs.filter(([, r]) => (r as { status: number }).status >= 500).map(([n, r]) => `${n} → ${(r as { status: number }).status}`);
    expect(bad).toEqual([]);
  });
});
