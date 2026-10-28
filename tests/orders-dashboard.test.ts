import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { importOrders } from '@/server/modules/orders';
import { createCommissionRule } from '@/server/modules/commission';
import { getAdminDashboard, getHostDashboard } from '@/server/modules/dashboard';
import { computeSales } from '@/server/lib/kpi';
import { todayTaipei } from '@/server/lib/ids';
import type { Actor } from '@/server/lib/permissions';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkCampaign, mkCommunity, mkHost, mkProduct, mkVendor, type World } from './helpers';

const HEADER = 'source_order_id,campaign_id,ordered_at,status,quantity,unit_price,sku_code,buyer_ref,host_id,community_id,refund_amount';
const today = todayTaipei();
const csv = (rows: string[]) => [HEADER, ...rows].join('\n');

let w: World;
let cid: string, h1: string, h2: string, comm1: string;
let hostUser1: Actor, hostUser2: Actor;
let fileSeq = 0;

beforeAll(async () => {
  w = await makeWorld();
  const v = await mkVendor(w);
  const p = await mkProduct(w, v.id, { approve: true, skus: [{ skuCode: 'A', name: 'A', listPrice: 1000, groupPrice: 800 }, { skuCode: 'B', name: 'B', listPrice: 2000, groupPrice: 1500 }] });
  h1 = (await mkHost(w, '團主一')).id; h2 = (await mkHost(w, '團主二')).id;
  comm1 = (await mkCommunity(w, [h1])).id;
  cid = (await mkCampaign(w, v.id, { products: p.skuIds.map((s) => ({ productId: p.id, skuId: s })), hosts: [{ hostId: h1, targetRevenue: 10000 }, { hostId: h2, targetRevenue: 5000 }], targetRevenue: 20000,
    sampleReadyDate: dayOffset(-40), openDate: dayOffset(-3), closeDate: dayOffset(7) }, w.manager)).id;
  await query(`UPDATE campaigns SET status='RUNNING' WHERE id=$1`, [cid]);
  hostUser1 = await addUser(w.orgId, 'HOST', { hostIds: [h1] });
  hostUser2 = await addUser(w.orgId, 'HOST', { hostIds: [h2] });
});

describe('尚無訂單：待串接狀態，不顯示任何假業績', () => {
  it('管理者與團主 Dashboard 都標示 NO_DATA，KPI 值為 null（不是 0）', async () => {
    const a = await getAdminDashboard(w.manager);
    expect(a.dataQuality.status).toBe('NO_DATA');
    expect(a.dataQuality.statusLabel).toContain('待串接');
    expect(a.sales?.gmv.value).toBeNull();
    expect(a.sales?.net.value).toBeNull();
    expect(a.targets?.attainment.value).toBeNull();
    const h = await getHostDashboard(hostUser1);
    expect(h.dataQuality.status).toBe('NO_DATA');
    expect(h.performance.net.value).toBeNull();
    expect(h.commission.estimatedTotal.value).toBeNull();
  });
});

describe('訂單 CSV 匯入', () => {
  it('成功匯入：訂單、品項、歸因都建立；金額由品項加總；批次可追溯', async () => {
    const r = await importOrders(w.manager, { sourceSystem: 'SHOP_X', fileName: 'a.csv', csv: csv([
      `O1,${cid},${today} 09:00,PAID,2,800,A,b1,${h1},${comm1},`,
      `O1,${cid},${today} 09:00,PAID,1,1500,B,b1,${h1},${comm1},`,
      `O2,${cid},${today} 10:00,PAID,1,800,A,b2,${h1},,`,
      `O3,${cid},${today} 11:00,PARTIAL_REFUND,1,1500,B,b3,${h2},,500`,
      `O4,${cid},${today} 12:00,REFUNDED,1,800,A,b4,${h2},,`,
      `O5,${cid},${today} 13:00,CANCELLED,1,800,A,b5,${h2},,`,
      `O6,${cid},${today} 14:00,PENDING,1,800,A,b6,${h1},,`,
    ]) });
    expect(r).toMatchObject({ status: 'COMPLETED', insertedOrders: 6, errorRows: 0, updatedOrders: 0, duplicateOrders: 0 });
    const o1 = (await query(`SELECT gross_amount FROM orders WHERE source_order_id='O1' AND organization_id=$1`, [w.orgId]))[0];
    expect(o1.gross_amount).toBe(3100);
    expect((await query(`SELECT count(*)::int AS n FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.source_order_id='O1' AND o.organization_id=$1`, [w.orgId]))[0].n).toBe(2);
    expect(r.dataAsOf).toBeTruthy();
  });

  it('同一份檔案不能匯入兩次（內容 checksum）', async () => {
    const content = csv([`DUP1,${cid},${today} 08:00,PAID,1,800,A,,,,`]);
    await importOrders(w.manager, { sourceSystem: 'SHOP_X', csv: content });
    await expect(importOrders(w.manager, { sourceSystem: 'SHOP_X', csv: content })).rejects.toThrow(/已匯入過/);
    expect((await query(`SELECT count(*)::int AS n FROM orders WHERE source_order_id='DUP1' AND organization_id=$1`, [w.orgId]))[0].n).toBe(1);
  });

  it('不同檔案含重疊訂單：內容相同略過、退款有變動則更新（留稽核）、品項被改則進錯誤佇列', async () => {
    const r = await importOrders(w.manager, { sourceSystem: 'SHOP_X', csv: csv([
      `O2,${cid},${today} 10:00,PAID,1,800,A,b2,${h1},,`,                  // 完全相同 → 略過
      `O3,${cid},${today} 11:00,PARTIAL_REFUND,1,1500,B,b3,${h2},,900`,    // 退款變動 → 更新
      `O1,${cid},${today} 09:00,PAID,3,800,A,b1,${h1},,`,                  // 品項不同 → 錯誤
      `O7,${cid},${today} 15:00,PAID,1,1500,B,b7,${h2},,`,                 // 新訂單
    ]) });
    expect(r).toMatchObject({ status: 'PARTIAL', insertedOrders: 1, updatedOrders: 1, duplicateOrders: 1, errorRows: 1 });
    const errs = await query(`SELECT code FROM import_errors WHERE batch_id=$1`, [r.batchId]);
    expect(errs.map((e) => e.code)).toEqual(['ITEMS_CHANGED']);
    expect((await query(`SELECT refund_amount FROM orders WHERE source_order_id='O3' AND organization_id=$1`, [w.orgId]))[0].refund_amount).toBe(900);
    const a = await query(`SELECT before_data, after_data FROM audit_logs WHERE action='order.update_from_import' AND organization_id=$1`, [w.orgId]);
    expect(a[0].before_data.refundAmount).toBe(500); expect(a[0].after_data.refundAmount).toBe(900);
  });

  it('錯誤列進入待處理佇列而不是消失；正確的列照常匯入', async () => {
    const r = await importOrders(w.manager, { sourceSystem: 'SHOP_X', csv: csv([
      `E1,CMP-999999-9999,${today} 09:00,PAID,1,800,A,,,,`,
      `E2,${cid},2026/11/03,PAID,1,800,A,,,,`,
      `E3,${cid},${today} 09:00,WEIRD,1,800,A,,,,`,
      `E4,${cid},${today} 09:00,PAID,0,800,A,,,,`,
      `E5,${cid},${today} 09:00,PAID,1,-5,A,,,,`,
      `E6,${cid},${today} 09:00,PAID,1,800,ZZZ,,,,`,
      `E7,${cid},${today} 09:00,PARTIAL_REFUND,1,800,A,,,,800`,
      `E8,${cid},${today} 09:00,PAID,1,800,A,,${h1.replace(/\d+$/, '9999')},,`,
      `E9,${cid},${today} 09:00,REFUNDED,1,800,A,,,,100`,
      `E10,${cid},2999-01-01 09:00,PAID,1,800,A,,,,`,
      `,${cid},${today} 09:00,PAID,1,800,A,,,,`,
      `OK1,${cid},${today} 09:30,PAID,1,800,A,,,,`,
    ]) });
    expect(r).toMatchObject({ status: 'PARTIAL', insertedOrders: 1, errorRows: 11 });
    const codes = (await query(`SELECT code FROM import_errors WHERE batch_id=$1 ORDER BY line_no`, [r.batchId])).map((e) => e.code);
    expect(codes).toEqual(['UNKNOWN_CAMPAIGN', 'BAD_ORDERED_AT', 'BAD_STATUS', 'BAD_QUANTITY', 'BAD_PRICE', 'UNKNOWN_SKU', 'BAD_REFUND', 'HOST_NOT_IN_CAMPAIGN', 'BAD_REFUND', 'FUTURE_ORDER', 'MISSING_ORDER_ID']);
  });

  it('檔案層級的錯誤：缺必要欄位、未知欄位、空檔、非 CSV', async () => {
    await expect(importOrders(w.manager, { sourceSystem: 'S', csv: 'a,b\n1,2' })).rejects.toThrow(/缺少必要欄位/);
    await expect(importOrders(w.manager, { sourceSystem: 'S', csv: HEADER + ',hack\n' + `x,${cid},${today} 09:00,PAID,1,1,,,,,,1` })).rejects.toThrow(/未知欄位/);
    await expect(importOrders(w.manager, { sourceSystem: 'S', csv: HEADER })).rejects.toThrow(/標題列與一筆資料/);
    await expect(importOrders(w.manager, { sourceSystem: 'S', csv: '' })).rejects.toThrow();
  });

  it('取消的檔期不接受新訂單；DEMO 資料不能由使用者匯入', async () => {
    const v = await mkVendor(w); const camp = await mkCampaign(w, v.id);
    await query(`UPDATE campaigns SET status='CANCELLED' WHERE id=$1`, [camp.id]);
    const r = await importOrders(w.manager, { sourceSystem: 'SHOP_C', csv: csv([`C1,${camp.id},${today} 09:00,PAID,1,800,,,,,`]) });
    expect(r.status).toBe('FAILED');
    expect((await query(`SELECT code FROM import_errors WHERE batch_id=$1`, [r.batchId]))[0].code).toBe('CAMPAIGN_CANCELLED');
    const viaApi = await Client.forActor(w.manager);
    const res = await viaApi.call('POST', '/imports', { sourceSystem: 'X', origin: 'DEMO', csv: csv([`D1,${cid},${today} 09:00,PAID,1,800,,,,,`]) });
    expect(res.status).toBe(422);
  });

  it('團主與廠商不能匯入訂單', async () => {
    await expect(importOrders(hostUser1, { sourceSystem: 'S', csv: csv([`H1,${cid},${today} 09:00,PAID,1,800,,,,,`]) })).rejects.toThrow(/沒有權限/);
  });
});

describe('Dashboard 口徑與一致性', () => {
  // 目前資料庫內本檔期的有效訂單（由前面的匯入產生）：
  // O1 3100 PAID(h1)；O2 800 PAID(h1)；O3 1500 PARTIAL_REFUND refund 900(h2)；O4 800 REFUNDED(h2)；O5 CANCELLED；O6 PENDING；O7 1500 PAID(h2)；DUP1 800 PAID(無歸因)；OK1 800 PAID(無歸因)
  const expected = computeSales([
    { status: 'PAID', grossAmount: 3100, refundAmount: 0 }, { status: 'PAID', grossAmount: 800, refundAmount: 0 },
    { status: 'PARTIAL_REFUND', grossAmount: 1500, refundAmount: 900 }, { status: 'REFUNDED', grossAmount: 800, refundAmount: 800 },
    { status: 'CANCELLED', grossAmount: 800, refundAmount: 0 }, { status: 'PENDING', grossAmount: 800, refundAmount: 0 },
    { status: 'PAID', grossAmount: 1500, refundAmount: 0 }, { status: 'PAID', grossAmount: 800, refundAmount: 0 }, { status: 'PAID', grossAmount: 800, refundAmount: 0 },
  ]);

  it('管理者 KPI 等於以口徑定義手算的結果（GMV／退款／淨銷售／有效訂單／AOV／退款率）', async () => {
    const a = await getAdminDashboard(w.manager);
    expect(a.sales?.gmv.value).toBe(expected.gmv);
    expect(a.sales?.refund.value).toBe(expected.refund);
    expect(a.sales?.net.value).toBe(expected.net);
    expect(a.sales?.orders.value).toBe(expected.orders);
    expect(a.sales?.aov.value).toBe(expected.aov);
    expect(a.sales?.refundRate.value).toBeCloseTo(expected.refundRate as number, 6);
    expect(expected.net).toBe(3100 + 800 + 600 + 0 + 1500 + 800 + 800);
    // 每個 KPI 都帶口徑說明（來源與公式）
    for (const k of ['gmv', 'net', 'orders', 'aov', 'refundRate'] as const) { expect(a.sales?.[k].source).toBeTruthy(); expect(a.sales?.[k].formula).toBeTruthy(); }
    expect(a.dataQuality.lastImport?.sourceSystem).toBeTruthy();
  });

  it('目標達成率＝累計淨銷售 ÷ 目標；未歸因金額被明確列出', async () => {
    const a = await getAdminDashboard(w.manager);
    expect(a.targets?.total).toBe(20000);
    expect(a.targets?.attainment.value).toBeCloseTo(expected.net / 20000, 6);
    // 歸因：h1 = 3100+800；h2 = 600+0+1500；未歸因 = 800 + 800
    expect(a.unattributedNet).toBe(1600);
    const perf = Object.fromEntries((a.hostPerformance as { hostId: string; net: number }[]).map((x) => [x.hostId, x.net]));
    expect(perf[h1]).toBe(3900);
    expect(perf[h2]).toBe(2100);
  });

  it('管理端與團主端同口徑：同一位團主的淨銷售在兩邊一致', async () => {
    const a = await getAdminDashboard(w.manager);
    const perf = Object.fromEntries((a.hostPerformance as { hostId: string; net: number }[]).map((x) => [x.hostId, x.net]));
    const d1 = await getHostDashboard(hostUser1);
    const d2 = await getHostDashboard(hostUser2);
    expect(d1.performance.net.value).toBe(perf[h1]);
    expect(d2.performance.net.value).toBe(perf[h2]);
    expect(d1.myCampaigns[0].myNet).toBe(perf[h1]);
    expect(d1.myCampaigns[0].attainment).toBeCloseTo(3900 / 10000, 6);
    // 內部人員的團主視角與團主本人完全相同
    const asManager = await getHostDashboard(w.manager, h1);
    expect(asManager.performance).toEqual(d1.performance);
    expect(asManager.myCampaigns).toEqual(d1.myCampaigns);
  });

  it('預估佣金：有費率才估、四捨五入、標示為預估；沒有費率不猜並提示', async () => {
    let d = await getHostDashboard(hostUser1);
    expect(d.myCampaigns[0].estimatedCommission).toBeNull();
    expect(d.myCampaigns[0].commissionNote).toContain('尚未設定');
    expect(d.dataQuality.warnings.join()).toContain('尚未設定佣金費率');
    await createCommissionRule(w.finance, { scopeType: 'HOST_DEFAULT', hostId: h1, ratePercent: 12.5, effectiveFrom: dayOffset(-365) });
    d = await getHostDashboard(hostUser1);
    expect(d.myCampaigns[0].commissionRate).toBe(12.5);
    expect(d.myCampaigns[0].estimatedCommission).toBe(Math.round((3900 * 12.5) / 100)); // 488
    expect(d.myCampaigns[0].commissionNote).toContain('預估');
    expect(d.commission.basis).toContain('預估');
    expect(d.commission.estimatedTotal.value).toBe(488);
    // 檔期專屬規則優先於團主預設，且舊版本被封存而非覆蓋
    await createCommissionRule(w.finance, { scopeType: 'CAMPAIGN_HOST', hostId: h1, campaignId: cid, ratePercent: 20, effectiveFrom: dayOffset(-365) });
    d = await getHostDashboard(hostUser1);
    expect(d.myCampaigns[0].commissionRate).toBe(20);
    expect(d.myCampaigns[0].estimatedCommission).toBe(780);
    const v2 = await createCommissionRule(w.finance, { scopeType: 'HOST_DEFAULT', hostId: h1, ratePercent: 15, effectiveFrom: dayOffset(-365) });
    expect(v2.version).toBe(2);
    const rules = await query(`SELECT rule_version, status FROM commission_rules WHERE host_id=$1 AND scope_type='HOST_DEFAULT' ORDER BY rule_version`, [h1]);
    expect(rules).toEqual([{ rule_version: 1, status: 'ARCHIVED' }, { rule_version: 2, status: 'ACTIVE' }]);
  });

  it('團主看到的資料不含其他團主的業績', async () => {
    const d = await getHostDashboard(hostUser2);
    expect(JSON.stringify(d)).not.toContain('團主一');
    expect(JSON.stringify(d)).not.toContain(h1);
  });

  it('資料品質：有未處理的匯入錯誤時，兩邊都有警告', async () => {
    const a = await getAdminDashboard(w.manager);
    expect(a.dataQuality.openImportErrors).toBeGreaterThan(0);
    expect(a.dataQuality.warnings.join()).toContain('匯入錯誤待處理');
    const d = await getHostDashboard(hostUser1);
    expect(d.dataQuality.warnings.join()).toContain('匯入錯誤待處理');
  });

  it('資料延遲：最近一次資料截至超過 3 天會警告', async () => {
    await query(`UPDATE import_batches SET data_as_of = now() - interval '5 days' WHERE organization_id=$1`, [w.orgId]);
    const a = await getAdminDashboard(w.manager);
    expect(a.dataQuality.warnings.join()).toContain('3 天未更新');
  });

  it('月份切換：其他月份沒有訂單時 KPI 為 0 筆但仍有口徑；非法月份被拒', async () => {
    const a = await getAdminDashboard(w.manager, '2020-01');
    expect(a.sales?.orders.value).toBe(0);
    expect(a.period.month).toBe('2020-01');
    await expect(getAdminDashboard(w.manager, '2020-13')).rejects.toThrow();
  });

  it('營運小編只看到自己負責檔期的業績；沒有 order.read 的角色不會得到業績區塊', async () => {
    const ed = await getAdminDashboard(w.editor);
    expect(ed.sales?.gmv.value).toBeNull();     // 這位小編沒有負責任何有訂單的檔期 → 無資料
    const pipelineTotal = (ed.pipeline as { n: number }[]).reduce((s, x) => s + x.n, 0);
    expect(pipelineTotal).toBeLessThan((await getAdminDashboard(w.manager)).pipeline.reduce((s: number, x: { n: number }) => s + x.n, 0));
  });
});

describe('DEMO 標示', () => {
  it('以 DEMO 來源匯入時，所有 Dashboard 明確標示示範資料', async () => {
    const w2 = await makeWorld();
    const v = await mkVendor(w2); const hh = await mkHost(w2);
    const c = await mkCampaign(w2, v.id, { hosts: [{ hostId: hh.id }] });
    const seedActor = { ...w2.manager, source: 'SEED' as const };
    await importOrders(seedActor, { sourceSystem: 'DEMO_GENERATOR', origin: 'DEMO', csv: csv([`DM1,${c.id},${today} 09:00,PAID,1,800,,,${hh.id},,`]) });
    const a = await getAdminDashboard(w2.manager);
    expect(a.dataQuality.status).toBe('DEMO');
    expect(a.dataQuality.statusLabel).toContain('DEMO');
    expect(a.dataQuality.statusLabel).toContain('不是真實');
  });
});
