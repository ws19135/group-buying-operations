import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { getAdminDashboard } from '@/server/modules/dashboard';
import { importOrders } from '@/server/modules/orders';
import { todayTaipei } from '@/server/lib/ids';
import { Client } from './api-helper';
import { dayOffset, makeWorld, mkCampaign, mkHost, mkProduct, mkVendor, type World } from './helpers';

const HEADER = 'source_order_id,campaign_id,ordered_at,status,quantity,unit_price,sku_code,buyer_ref,host_id,community_id,refund_amount';

let w: World, other: World;
let vA: string, vB: string, h1: string, h2: string;
let pA1: string, pA2: string, pB: string;
let campA: string, campB: string, campEd2: string;
let mgr: Client, ed: Client;
const chart = async (filter: { vendorId?: string | null; productId?: string | null } = {}, as = w.manager) => {
  const d = (await getAdminDashboard(as, null, null, filter)) as unknown as { hostChart: { items: { hostId: string; name: string; net: number; orders: number }[]; filter: unknown; options: { vendors: { id: string }[]; products: { id: string; vendorId: string }[] } } };
  return d.hostChart;
};
const nets = (c: Awaited<ReturnType<typeof chart>>) => Object.fromEntries(c.items.map((i) => [i.hostId, i.net]));

beforeAll(async () => {
  w = await makeWorld(); other = await makeWorld();
  vA = (await mkVendor(w, '[DEMO] 廠商甲')).id; vB = (await mkVendor(w, '[DEMO] 廠商乙')).id;
  h1 = (await mkHost(w, '[DEMO] 團主一')).id; h2 = (await mkHost(w, '[DEMO] 團主二')).id;
  const prod = async (vendorId: string, name: string, code: string) => (await mkProduct(w, vendorId, { name, approve: true, skus: [{ skuCode: code, name: code, listPrice: 2000, groupPrice: 1000, costPrice: 100 }] }));
  const a1 = await prod(vA, '[DEMO] 甲商品一', 'A1'), a2 = await prod(vA, '[DEMO] 甲商品二', 'A2'), b1 = await prod(vB, '[DEMO] 乙商品', 'B1');
  pA1 = a1.id; pA2 = a2.id; pB = b1.id;
  const base = { sampleReadyDate: dayOffset(-10), openDate: dayOffset(-3), closeDate: dayOffset(20) };
  campA = (await mkCampaign(w, vA, { ...base, products: [{ productId: pA1, skuId: a1.skuIds[0] }, { productId: pA2, skuId: a2.skuIds[0] }], hosts: [{ hostId: h1 }, { hostId: h2 }] }, w.manager)).id;
  campB = (await mkCampaign(w, vB, { ...base, products: [{ productId: pB, skuId: b1.skuIds[0] }], hosts: [{ hostId: h2 }] }, w.manager)).id;
  campEd2 = (await mkCampaign(w, vB, { ...base, products: [{ productId: pB, skuId: b1.skuIds[0] }], hosts: [{ hostId: h1 }] }, w.editor2)).id;
  await query(`UPDATE campaigns SET status='RUNNING' WHERE id = ANY($1::text[])`, [[campA, campB, campEd2]]);
  const t = `${todayTaipei()} 09:00`;
  const rows = [
    `O1,${campA},${t},PAID,1,1000,A1,b1,${h1},,`,
    `O2,${campA},${t},PAID,1,600,A2,b2,${h2},,`,
    `O3,${campA},${t},PARTIAL_REFUND,1,500,A1,b3,${h1},,100`,
    `O4,${campB},${t},PAID,1,2000,B1,b4,${h2},,`,
    `O5,${campA},${t},PARTIAL_REFUND,1,300,A1,b5,${h1},,200`,      // 同一張訂單兩個商品：A1 300 + A2 700 = 1000，退款 200 → 淨額 800
    `O5,${campA},${t},PARTIAL_REFUND,1,700,A2,b5,${h1},,`,
  ];
  const r = await importOrders(w.manager, { sourceSystem: 'DEMO_SHOP', fileName: 'chart.csv', csv: [HEADER, ...rows].join('\n') });
  expect(r).toMatchObject({ errorRows: 0 });
  [mgr, ed] = await Promise.all([Client.forActor(w.manager), Client.forActor(w.editor)]);
});

describe('跨團主業績比較：廠商與商品篩選', () => {
  it('不篩選：全部廠商合計（與原本的團主績效一致）', async () => {
    const c = await chart();
    expect(nets(c)).toEqual({ [h1]: 1000 + 400 + 800, [h2]: 600 + 2000 });
    const d = (await getAdminDashboard(w.manager)) as unknown as { hostPerformance: { hostId: string; net: number }[] };
    expect(Object.fromEntries(d.hostPerformance.map((x) => [x.hostId, x.net]))).toEqual(nets(c));   // 圖表與下方團主績效表同口徑
    expect(c.filter).toEqual({ vendorId: null, productId: null });
  });
  it('只選廠商：只算該廠商檔期的訂單', async () => {
    expect(nets(await chart({ vendorId: vA }))).toEqual({ [h1]: 2200, [h2]: 600 });
    expect(nets(await chart({ vendorId: vB }))).toEqual({ [h2]: 2000 });
  });
  it('選廠商＋商品：只算該商品的明細；同一張訂單有多個商品時，依明細占比分攤、退款按比例扣', async () => {
    // A1：O1 1000 + O3 400 + O5（800 × 300/1000 = 240）＝ 1640，團主二沒有 A1
    expect(nets(await chart({ vendorId: vA, productId: pA1 }))).toEqual({ [h1]: 1640 });
    // A2：團主二 600；團主一 O5（800 × 700/1000 = 560）
    expect(nets(await chart({ vendorId: vA, productId: pA2 }))).toEqual({ [h1]: 560, [h2]: 600 });
  });
  it('各商品加總＝廠商整體；各廠商加總＝全部', async () => {
    const [p1, p2, all] = await Promise.all([chart({ vendorId: vA, productId: pA1 }), chart({ vendorId: vA, productId: pA2 }), chart({ vendorId: vA })]);
    for (const h of [h1, h2]) expect((nets(p1)[h] ?? 0) + (nets(p2)[h] ?? 0)).toBe(nets(all)[h] ?? 0);
    const [va, vb, full] = await Promise.all([chart({ vendorId: vA }), chart({ vendorId: vB }), chart()]);
    for (const h of [h1, h2]) expect((nets(va)[h] ?? 0) + (nets(vb)[h] ?? 0)).toBe(nets(full)[h] ?? 0);
  });
  it('選項：廠商列出有檔期的廠商；商品附所屬廠商（畫面只列所選廠商的商品）', async () => {
    const c = await chart();
    expect(c.options.vendors.map((v) => v.id).sort()).toEqual([vA, vB].sort());
    expect(c.options.products.filter((p) => p.vendorId === vA).map((p) => p.id).sort()).toEqual([pA1, pA2].sort());
    expect(c.options.products.filter((p) => p.vendorId === vB).map((p) => p.id)).toEqual([pB]);
  });
  it('不合法的篩選一律 422（不靜默忽略）：不存在的廠商、別的廠商的商品、其他組織的廠商', async () => {
    await expect(chart({ vendorId: 'VEN-9999' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(chart({ vendorId: vA, productId: pB })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(chart({ productId: 'PRD-999999' })).rejects.toMatchObject({ code: 'VALIDATION' });
    const ov = (await mkVendor(other)).id;
    await expect(chart({ vendorId: ov })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await mgr.call('GET', '/dashboard/admin?vendorId=VEN-9999')).status).toBe(422);
    expect((await mgr.call('GET', `/dashboard/admin?vendorId=${vA}&productId=${pA1}`)).data.hostChart.items).toHaveLength(1);
  });
  it('資料範圍：營運小編只看得到自己負責的檔期——選項與數字都不含別人的', async () => {
    // 小編一沒有負責任何有訂單的檔期；campEd2 屬小編二
    const edChart = await chart({}, w.editor);
    expect(edChart.options.vendors.map((v) => v.id)).not.toContain(vB);
    expect(edChart.items).toEqual([]);
    await expect(chart({ vendorId: vB }, w.editor)).rejects.toMatchObject({ code: 'VALIDATION' });
    const ed2Chart = await chart({}, w.editor2);
    expect(ed2Chart.options.vendors.map((v) => v.id)).toEqual([vB]);
    expect((await ed.call('GET', `/dashboard/admin?vendorId=${vB}`)).status).toBe(422);
  });
  it('財務（有訂單檢視權限）可看；團主與廠商沒有管理者儀表板（403）', async () => {
    expect(((await getAdminDashboard(w.finance)) as unknown as { hostChart: unknown }).hostChart).not.toBeNull();
    const { addUser } = await import('./helpers');
    const host = await addUser(w.orgId, 'HOST', { hostIds: [h1] });
    await expect(getAdminDashboard(host)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
