import { beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '@/server/lib/db';
import { createExpense } from '@/server/modules/finance';
import { createTrial } from '@/server/modules/trials';
import { getTrialKpis } from '@/server/modules/trial-kpis';
import { importOrders } from '@/server/modules/orders';
import { createFeasibility } from '@/server/modules/feasibility';
import { getCostAllocationAnalysis } from '@/server/modules/finance-comparison';
import { campaignHostCommission } from '@/server/lib/commission-calc';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkCampaign, mkHost, mkProduct, mkVendor, type World } from './helpers';
import type { Actor } from '@/server/lib/permissions';

/** Owner 決策 K-7a～e：費用分類、各方法對公司與商品利潤的影響、重複／未分攤／跨期風險。唯讀試算：不寫入、不自動分攤、多商品仍資料不足 */
const HEADER = 'source_order_id,campaign_id,ordered_at,status,quantity,unit_price,sku_code,buyer_ref,host_id,community_id,refund_amount';
let w: World, other: World, hostA: string, hostUser: Actor;
let n = 0;
const TERMS = { cashFlowMode: 'BRAND_COLLECTS', commissionBasis: 'NSV', brandFeePct: 10, serviceFeeFixed: 0, hostCommissionPct: 5, hostPaidBy: 'COMPANY', shippingPerOrder: 60, shippingBorneBy: 'BRAND', platformFeePct: 3, platformFeeBorneBy: 'BRAND', otherVariablePerOrder: 0, otherCostBorneBy: 'COMPANY', fixedCost: 0, fixedCostBorneBy: 'COMPANY', returnCostPerRefundOrder: 20, returnCostBorneBy: 'COMPANY' };
const TABLES = ['feasibility_scenarios', 'commission_rules', 'settlements', 'settlement_items', 'settlement_adjustments', 'expenses', 'payments', 'invoices', 'orders', 'attributions', 'product_trials'];
const counts = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, Number((await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE organization_id=$1`, [w.orgId]))[0].n)])));

beforeAll(async () => {
  w = await makeWorld(); other = await makeWorld();
  hostA = (await mkHost(w, '[DEMO] I 團主甲')).id;
  hostUser = await addUser(w.orgId, 'HOST', { hostIds: [hostA] });
});

async function multi() {
  const v = (await mkVendor(w, `[DEMO] I 多商品 ${++n}`)).id;
  const pa = await mkProduct(w, v, { name: `[DEMO] I 高單價 ${n}`, skus: [{ skuCode: `IA${n}`, name: 'a', groupPrice: 800, costPrice: 500 }] });
  const pb = await mkProduct(w, v, { name: `[DEMO] I 低單價 ${n}`, skus: [{ skuCode: `IB${n}`, name: 'b', groupPrice: 100, costPrice: 40 }] });
  const camp = (await mkCampaign(w, v, { products: [{ productId: pa.id, skuId: pa.skuIds[0] }, { productId: pb.id, skuId: pb.skuIds[0] }], hosts: [{ hostId: hostA }], sampleReadyDate: dayOffset(-30), openDate: dayOffset(-10), closeDate: dayOffset(10) })).id;
  await query(`UPDATE campaigns SET status='RUNNING' WHERE id=$1`, [camp]);
  const rows = [HEADER];
  for (let i = 1; i <= 2; i++) rows.push(`IM-${n}-A${i},${camp},${dayOffset(-5)} 10:00,PAID,1,800,IA${n},bi${i},${hostA},,`);
  for (let i = 1; i <= 8; i++) rows.push(`IM-${n}-B${i},${camp},${dayOffset(-5)} 11:00,PAID,1,100,IB${n},bj${i},${hostA},,`);
  await importOrders({ ...w.admin, source: 'TEST' }, { sourceSystem: 'T', origin: 'DEMO', fileName: `im${n}.csv`, csv: rows.join('\n') });
  return { v, pa, pb, camp };
}
const exp = (camp: string, o: Record<string, unknown>) => createExpense(w.finance, { category: 'SHIPPING', amount: 1000, incurredOn: dayOffset(-3), campaignId: camp, bearerParty: 'COMPANY', ...o } as never);

describe('K-7a：費用分類（依財務填的對應商品／團主；不推測）', () => {
  it('直接歸屬商品、檔期共同、特定團主分開；只有共同費用進入分攤池，不再重複分攤', async () => {
    const { pa, camp } = await multi();
    await exp(camp, { amount: 1000 });                                             // 共同運費
    await exp(camp, { category: 'SAMPLE', amount: 300, productId: pa.id });        // 直接歸屬高單價
    await exp(camp, { category: 'MARKETING', amount: 200, hostId: hostA });        // 特定團主
    const a = await getCostAllocationAnalysis(w.finance, camp);
    const by = Object.fromEntries(a.impact!.classes.map((c) => [c.cls, c]));
    expect(by.CAMPAIGN_SHARED).toMatchObject({ count: 1, amount: 1000 });
    expect(by.DIRECT_PRODUCT).toMatchObject({ count: 1, amount: 300 });
    expect(by.HOST_SPECIFIC).toMatchObject({ count: 1, amount: 200 });
    // 分攤池只含共同費用 1000：依淨銷售額 1600:800（高:低）→ 667／333
    expect(a.costs.map((c) => [c.key, c.amount])).toEqual([['SHIPPING', 1000]]);
    const nsv = a.comparison!.methods.find((m) => m.method === 'BY_NSV')!;
    expect(nsv.allocations.reduce((s, x) => s + x.total, 0)).toBe(1000);
  });
});

describe('K-7b／c：各方法對公司利潤與商品利潤的影響', () => {
  it('公司利潤不隨方法改變；商品利潤隨方法改變；加總對得上；差額明講', async () => {
    const { pa, pb, camp } = await multi();
    await exp(camp, { amount: 1000 });
    await exp(camp, { category: 'SAMPLE', amount: 300, productId: pa.id });
    await exp(camp, { category: 'MARKETING', amount: 200, hostId: hostA });
    const imp = (await getCostAllocationAnalysis(w.finance, camp)).impact!;
    // 銷售：高 2×800＝1600、成本 2×500＝1000；低 8×100＝800、成本 8×40＝320 → 毛利 1080；公司承擔費用 1500 → −420
    for (const i of imp.impact) expect(i).toMatchObject({ usable: true, companyProfit: -420, reconciles: true, poolGap: 0 });
    expect(imp.companyProfitInvariant).toBe(true);
    const prof = (m: string, id: string) => imp.impact.find((i) => i.method === m)!.products.find((p) => p.productId === id)!.productProfit;
    expect(prof('BY_NSV', pa.id)).toBe(1600 - 1000 - 300 - 667); expect(prof('BY_NSV', pb.id)).toBe(800 - 320 - 333);
    expect(prof('BY_QUANTITY', pa.id)).toBe(1600 - 1000 - 300 - 200); expect(prof('BY_QUANTITY', pb.id)).toBe(800 - 320 - 800);
    expect(imp.productProfitSpread[pa.id]).toBeGreaterThan(0);
    expect(imp.note).toContain('公司利潤不因分攤方法改變');
  });
  it('承擔方是品牌／團主的費用不計入公司利潤也不分攤', async () => {
    const { camp } = await multi();
    await exp(camp, { amount: 1000 }); await exp(camp, { category: 'OTHER', amount: 900, bearerParty: 'BRAND' });
    const a = await getCostAllocationAnalysis(w.finance, camp);
    expect(a.costs.map((c) => c.key)).toEqual(['SHIPPING']);
    expect(a.impact!.excludedNotCompanyTotal).toBe(900); expect(a.impact!.companyCostTotal).toBe(1000);
    expect(a.impact!.risks.some((r) => r.code === 'UNALLOCATED' && r.message.includes('品牌或團主承擔'))).toBe(true);
  });
});

describe('K-7d：風險偵測（只提示，不自動排除或改資料）', () => {
  it('重複分攤：同類別同時有共同費用與指定商品費用', async () => {
    const { pa, camp } = await multi();
    await exp(camp, { amount: 1000 }); await exp(camp, { amount: 400, productId: pa.id });
    const r = (await getCostAllocationAnalysis(w.finance, camp)).impact!.risks.find((x) => x.code === 'DOUBLE_ALLOCATION')!;
    expect(r).toMatchObject({ level: 'REVIEW' }); expect(r.message).toContain('算兩次'); expect(r.expenseIds).toHaveLength(2);
  });
  it('未分攤：特定團主費用、承擔方未記錄、指定商品缺成本；跨期：發生日在檔期外', async () => {
    const { camp } = await multi();
    await exp(camp, { amount: 1000, incurredOn: dayOffset(-60) });                 // 檔期（-10～+10）之外
    await exp(camp, { category: 'MARKETING', amount: 200, hostId: hostA });
    await exp(camp, { category: 'OTHER', amount: 80, bearerParty: undefined });
    const risks = (await getCostAllocationAnalysis(w.finance, camp)).impact!.risks;
    const msg = (c: string) => risks.filter((x) => x.code === c).map((x) => x.message).join('\n');
    expect(msg('UNALLOCATED')).toContain('特定團主費用 200 元'); expect(msg('UNALLOCATED')).toContain('尚未記錄承擔方');
    expect(msg('CROSS_PERIOD')).toContain('1 筆費用（1000 元）發生日在檔期'); expect(msg('CROSS_PERIOD')).toContain('不自動排除');
  });
  it('跨期的費用仍留在分攤池（不自動排除）', async () => {
    const { camp } = await multi();
    await exp(camp, { amount: 1000, incurredOn: dayOffset(-60) });
    expect((await getCostAllocationAnalysis(w.finance, camp)).costs[0].amount).toBe(1000);
  });
});

describe('K-7e：唯讀；沒有核准的規則前多商品仍是資料不足', () => {
  it('分析不寫入任何資料、不改結算佣金、不產生分攤規則；每單貢獻利潤維持資料不足；權限隔離', async () => {
    const { pa, camp } = await multi();
    await exp(camp, { amount: 1000 }); await exp(camp, { category: 'SAMPLE', amount: 300, productId: pa.id });
    await createFeasibility(w.manager, pa.id, { campaignId: camp, inputs: TERMS, sources: Object.fromEntries(Object.keys(TERMS).map((k) => [k, { kind: 'CONTRACT' }])) } as never);
    const t = (await createTrial(w.manager, pa.id, { level: 'HOST_FIT', trialType: 'MINI_GROUP', hostId: hostA, campaignId: camp })).id;
    const before = await counts();
    const commission = await campaignHostCommission(pool(), w.orgId, camp);
    const a = await getCostAllocationAnalysis(w.finance, camp);
    expect(a.impact).toMatchObject({ effective: false });
    expect(await counts()).toEqual(before);
    expect(await campaignHostCommission(pool(), w.orgId, camp)).toEqual(commission);
    const k = (await getTrialKpis(w.manager, t)).items.find((x) => x.key === 'contributionPerOrder')!;
    expect(k).toMatchObject({ status: 'INSUFFICIENT', value: null }); expect(k.reason).toContain('多個商品');
    for (const actor of [w.editor, hostUser]) expect((await (await Client.forActor(actor)).call('GET', `/campaigns/${camp}/cost-allocation-analysis`)).status).toBe(403);
    expect((await (await Client.forActor(other.finance)).call('GET', `/campaigns/${camp}/cost-allocation-analysis`)).status).toBe(404);
    // 沒有分攤相關資料表或設定
    expect((await query<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE '%alloc%'`))[0].n).toBe(0);
  });
  it('單一商品檔期不需要分攤：impact 為 null', async () => {
    const v = (await mkVendor(w, `[DEMO] I 單品 ${++n}`)).id;
    const p = await mkProduct(w, v, { name: `[DEMO] I 單品商品 ${n}`, skus: [{ skuCode: `IS${n}`, name: 'a', groupPrice: 800, costPrice: 500 }] });
    const camp = (await mkCampaign(w, v, { products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: [{ hostId: hostA }], sampleReadyDate: dayOffset(-30), openDate: dayOffset(-10), closeDate: dayOffset(10) })).id;
    expect((await getCostAllocationAnalysis(w.finance, camp)).impact).toBeNull();
  });
});
