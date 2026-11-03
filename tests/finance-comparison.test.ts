import { beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '@/server/lib/db';
import { createTrial } from '@/server/modules/trials';
import { getTrialKpis } from '@/server/modules/trial-kpis';
import { createFeasibility } from '@/server/modules/feasibility';
import { importOrders } from '@/server/modules/orders';
import { createCommissionRule } from '@/server/modules/commission';
import { createExpense } from '@/server/modules/finance';
import { getCommissionReconciliation } from '@/server/modules/commission-reconciliation';
import { getCostAllocationAnalysis, getFeeAttributionReport } from '@/server/modules/finance-comparison';
import { campaignHostCommission } from '@/server/lib/commission-calc';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkCampaign, mkHost, mkProduct, mkVendor, type World } from './helpers';
import type { Actor } from '@/server/lib/permissions';

/** Owner 決策 K-6／K-7／K-8：唯讀核對與提案分析（真實資料庫）。重點：只讀、不覆蓋任何一方、不改結算、缺合約＝資料不足、多商品維持資料不足、權限隔離 */
const HEADER = 'source_order_id,campaign_id,ordered_at,status,quantity,unit_price,sku_code,buyer_ref,host_id,community_id,refund_amount';
let w: World, other: World;
let hostA: string, hostUser: Actor;
let n = 0;
const TERMS = {
  cashFlowMode: 'BRAND_COLLECTS', commissionBasis: 'NSV', brandFeePct: 10, serviceFeeFixed: 0, hostCommissionPct: 5, hostPaidBy: 'COMPANY',
  shippingPerOrder: 60, shippingBorneBy: 'BRAND', platformFeePct: 3, platformFeeBorneBy: 'BRAND', otherVariablePerOrder: 0, otherCostBorneBy: 'COMPANY',
  fixedCost: 0, fixedCostBorneBy: 'COMPANY', returnCostPerRefundOrder: 20, returnCostBorneBy: 'COMPANY',
};
const src = (kind: string, keys = Object.keys(TERMS)) => Object.fromEntries(keys.map((k) => [k, { kind }]));
const TABLES = ['feasibility_scenarios', 'commission_rules', 'settlements', 'settlement_items', 'settlement_adjustments', 'vendor_dd_records', 'vendor_dd_items', 'expenses', 'payments', 'invoices', 'service_cases', 'orders', 'attributions', 'product_trials', 'trial_reach_records'];
const counts = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, Number((await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE organization_id=$1`, [w.orgId]))[0].n)])));

async function approvedContract(vId: string, terms: Record<string, unknown>, status = 'APPROVED', itemStatus = 'CONFIRMED') {
  const rid = `VDD-T${++n}${Date.now() % 100000}`;
  await query(`INSERT INTO vendor_dd_records (id, organization_id, vendor_id, contract_version, status, valid_until, reviewed_by, reviewed_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$7)`, [rid, w.orgId, vId, `C-TEST-${n}`, status, dayOffset(200), w.manager.userId]);
  await query(`INSERT INTO vendor_dd_items (id, organization_id, record_id, category_key, status, terms, confirmed_by, confirmed_at) VALUES ($1,$2,$3,'COMMISSION_TERMS',$4,$5,$6,now())`, [`VDI-T${n}${Date.now() % 100000}`, w.orgId, rid, itemStatus, JSON.stringify(terms), w.manager.userId]);
  return rid;
}

beforeAll(async () => {
  w = await makeWorld(); other = await makeWorld();
  hostA = (await mkHost(w, '[DEMO] F 團主甲')).id;
  hostUser = await addUser(w.orgId, 'HOST', { hostIds: [hostA] });
});

async function single() {
  const v = (await mkVendor(w, `[DEMO] F 廠商 ${++n}`)).id;
  const p = await mkProduct(w, v, { name: `[DEMO] F 商品 ${n}`, skus: [{ skuCode: `F${n}`, name: 'a', listPrice: 1000, groupPrice: 800, costPrice: 500 }] });
  const camp = (await mkCampaign(w, v, { products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: [{ hostId: hostA }], sampleReadyDate: dayOffset(-30), openDate: dayOffset(-10), closeDate: dayOffset(10) })).id;
  await query(`UPDATE campaigns SET status='RUNNING' WHERE id=$1`, [camp]);
  const rows = [HEADER];
  for (let i = 1; i <= 5; i++) rows.push(`FC-${n}-${i},${camp},${dayOffset(-5)} 10:00,PAID,1,800,F${n},bf${i},${hostA},,`);
  rows.push(`FC-${n}-6,${camp},${dayOffset(-5)} 10:00,PARTIAL_REFUND,1,800,F${n},bf6,${hostA},,100`);
  await importOrders({ ...w.admin, source: 'TEST' }, { sourceSystem: 'T', origin: 'DEMO', fileName: `fc${n}.csv`, csv: rows.join('\n') });
  return { v, p, camp };
}
const recon = async (camp: string) => (await getCommissionReconciliation(w.finance, { campaignId: camp })).rows;

describe('K-6：分潤口徑差異核對（唯讀）', () => {
  it('合約 8%／可行性 5%／財務規則 10% 三者不同：列出差異、版本、核准狀態與影響範圍；不覆蓋任何一方、不改任何資料', async () => {
    const { v, p, camp } = await single();
    await approvedContract(v, { basis: 'NSV', hostCommissionPct: 8, hostPaidBy: 'COMPANY', effectiveFrom: dayOffset(-300), effectiveTo: dayOffset(300) });
    await createFeasibility(w.manager, p.id, { campaignId: camp, inputs: TERMS, sources: src('CONTRACT') } as never);
    await createCommissionRule(w.finance, { scopeType: 'CAMPAIGN_HOST', hostId: hostA, campaignId: camp, ratePercent: 10, effectiveFrom: dayOffset(-365) });
    const before = await counts();
    const settleBefore = (await campaignHostCommission(pool(), w.orgId, camp)).find((x) => x.hostId === hostA)!;
    const rows = await recon(camp);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    const rate = r.fields.find((f) => f.field === 'ratePercent')!;
    expect(rate.verdict).toBe('DIFFERENT');
    expect(rate.values.map((x) => [x.source, x.value])).toEqual([['CONTRACT', 8], ['FEASIBILITY', 5], ['FINANCE', 10]]);
    expect(rate.values.find((x) => x.source === 'CONTRACT')).toMatchObject({ approved: true, version: expect.stringContaining('合約版本 C-TEST') });
    expect(rate.values.find((x) => x.source === 'FEASIBILITY')).toMatchObject({ approved: true, version: expect.stringContaining('可行性 v') });   // 來源是合約：已確認，但值與合約不同
    expect(rate.values.find((x) => x.source === 'FINANCE')).toMatchObject({ version: expect.stringContaining('規則 v') });
    expect(r.needsManualReview).toBe(true);
    // 影響範圍：最大差距 5 個百分點 × 歸因有效淨銷售額 4,700（5×800＋(800−100)＝4,700）
    expect(r.impact).toMatchObject({ attributedNetSales: 4700, maxRateGapPct: 5, estimatedGap: 235 });
    // 唯讀：沒有任何資料表的筆數改變；結算的佣金計算結果完全相同；三個來源的值都沒被覆蓋
    expect(await counts()).toEqual(before);
    expect((await campaignHostCommission(pool(), w.orgId, camp)).find((x) => x.hostId === hostA)).toEqual(settleBefore);
    expect(settleBefore.ratePercent).toBe(10);
    expect((await query<{ inputs: { hostCommissionPct: number } }>(`SELECT inputs FROM feasibility_scenarios WHERE campaign_id=$1`, [camp]))[0].inputs.hostCommissionPct).toBe(5);
  });

  it('缺少正式合約條件：資料不足；暫估（人工估計）的可行性條款不視為已核准；仍列入待覆核', async () => {
    const { p, camp } = await single();
    await createFeasibility(w.manager, p.id, { campaignId: camp, inputs: TERMS, sources: src('MANUAL_ESTIMATE') } as never);
    await createCommissionRule(w.finance, { scopeType: 'CAMPAIGN_HOST', hostId: hostA, campaignId: camp, ratePercent: 8, effectiveFrom: dayOffset(-365) });
    const r = (await recon(camp))[0];
    expect(r.verdict).toBe('INSUFFICIENT');
    expect(r.needsManualReview).toBe(true);
    expect(r.reviewReasons.join()).toContain('缺少合約條件');
    expect(r.fields[0].values.find((x) => x.source === 'FEASIBILITY')).toMatchObject({ approved: false });
    expect(r.fields[0].values.find((x) => x.source === 'CONTRACT')).toMatchObject({ value: null });
  });

  it('合約尚未核准（審查中）、第 10 題舊欄位沒標明適用對象：都不算已核准／不當作團主分潤比例', async () => {
    const a = await single();
    await approvedContract(a.v, { basis: 'NSV', hostCommissionPct: 8 }, 'IN_REVIEW');
    expect((await recon(a.camp))[0].fields[0].values.find((x) => x.source === 'CONTRACT')).toMatchObject({ value: 8, approved: false });
    const b = await single();
    await approvedContract(b.v, { basis: 'NSV', ratePercent: 12 });
    const c = (await recon(b.camp))[0].fields[0].values.find((x) => x.source === 'CONTRACT')!;
    expect(c.value).toBeNull();
    expect(c.approvalNote).toContain('沒有標明適用對象');
  });

  it('三者一致：不產生待覆核；財務沒記錄付款方只是資料不足，不算差異', async () => {
    const { v, p, camp } = await single();
    await approvedContract(v, { basis: 'NSV', hostCommissionPct: 5, hostPaidBy: 'COMPANY', effectiveFrom: dayOffset(-365), effectiveTo: null });
    await createFeasibility(w.manager, p.id, { campaignId: camp, inputs: TERMS, sources: src('CONTRACT') } as never);
    await createCommissionRule(w.finance, { scopeType: 'CAMPAIGN_HOST', hostId: hostA, campaignId: camp, ratePercent: 5, effectiveFrom: dayOffset(-365) });
    const r = (await recon(camp))[0];
    expect(r.fields.find((f) => f.field === 'ratePercent')!.verdict).toBe('CONSISTENT');
    expect(r.fields.find((f) => f.field === 'paidBy')!.values.find((x) => x.source === 'FINANCE')).toMatchObject({ value: null, display: '未記錄' });
    expect(r.needsManualReview).toBe(false);
  });

  it('權限：需要財務讀取與成本檢視權限；小編、團主、其他組織都看不到', async () => {
    const { camp } = await single();
    await expect(getCommissionReconciliation(w.editor, { campaignId: camp })).rejects.toThrow();
    const ed = await Client.forActor(w.editor), hc = await Client.forActor(hostUser);
    expect((await ed.call('GET', '/reconciliation/commission')).status).toBe(403);
    expect((await hc.call('GET', '/reconciliation/commission')).status).toBe(403);
    expect((await hc.call('GET', '/reconciliation/fees')).status).toBe(403);
    expect((await hc.call('GET', `/campaigns/${camp}/cost-allocation-analysis`)).status).toBe(403);
    expect((await getCommissionReconciliation(other.finance, { campaignId: camp })).rows).toHaveLength(0);
    const fin = await Client.forActor(w.finance);
    expect((await fin.call('GET', '/reconciliation/commission')).status).toBe(200);
  });
});

describe('K-8：費用歸屬對照報告（唯讀）', () => {
  it('列出各項費用的試算負擔方、財務已記錄支出、結算是否處理；標示尚未一致的項目與可能的應收／應付；唯讀', async () => {
    const { p, camp } = await single();
    await createFeasibility(w.manager, p.id, { campaignId: camp, inputs: TERMS, sources: src('CONTRACT') } as never);
    await createExpense(w.finance, { category: 'SHIPPING', amount: 700, incurredOn: dayOffset(-3), campaignId: camp } as never);
    const before = await counts();
    const rep = (await getFeeAttributionReport(w.finance, { campaignId: camp })).reports[0];
    const ship = rep.rows.find((x) => x.item === 'shipping')!;
    expect(ship.kpi).toMatchObject({ bearer: 'BRAND', amount: 360, confirmed: true });        // 運費 60 × 6 張有效訂單
    expect(ship.formal).toMatchObject({ recordedExpense: 700, expenseCount: 1, handledBySettlement: false });
    expect(ship.alignment).toBe('NOT_ALIGNED');
    expect(ship.obligation.kind).toBe('RECEIVABLE');
    expect(rep.rows.find((x) => x.item === 'hostCommission')!.alignment).toBe('INSUFFICIENT');   // 此檔期尚無結算明細
    expect(rep.notAlignedItems).toContain('運費');
    expect(rep.termsVersion).toContain('可行性 v');
    expect(await counts()).toEqual(before);
  });

  it('多商品檔期：費用金額不估算；權限同樣需要財務讀取與成本檢視', async () => {
    const v = (await mkVendor(w, '[DEMO] F 多商品廠商')).id;
    const pa = await mkProduct(w, v, { name: '[DEMO] F 甲', skus: [{ skuCode: `MA${++n}`, name: 'a', groupPrice: 800, costPrice: 500 }] });
    const pb = await mkProduct(w, v, { name: '[DEMO] F 乙', skus: [{ skuCode: `MB${n}`, name: 'b', groupPrice: 200, costPrice: 50 }] });
    const camp = (await mkCampaign(w, v, { products: [{ productId: pa.id, skuId: pa.skuIds[0] }, { productId: pb.id, skuId: pb.skuIds[0] }], hosts: [{ hostId: hostA }], sampleReadyDate: dayOffset(-30), openDate: dayOffset(-10), closeDate: dayOffset(10) })).id;
    await createFeasibility(w.manager, pa.id, { campaignId: camp, inputs: TERMS, sources: src('CONTRACT') } as never);
    const reps = (await getFeeAttributionReport(w.finance, { campaignId: camp })).reports;
    expect(reps).toHaveLength(2);
    expect(reps[0].rows.find((x) => x.item === 'shipping')!.kpi.amount).toBeNull();
    await expect(getFeeAttributionReport(w.editor, { campaignId: camp })).rejects.toThrow();
  });
});

describe('K-7：多商品檔期成本分攤提案分析（唯讀、未生效）', () => {
  async function multi() {
    const v = (await mkVendor(w, `[DEMO] F 多商品 ${++n}`)).id;
    const pa = await mkProduct(w, v, { name: `[DEMO] 高單價 ${n}`, skus: [{ skuCode: `HA${n}`, name: 'a', groupPrice: 800, costPrice: 500 }] });
    const pb = await mkProduct(w, v, { name: `[DEMO] 低單價 ${n}`, skus: [{ skuCode: `HB${n}`, name: 'b', groupPrice: 100, costPrice: 40 }] });
    const camp = (await mkCampaign(w, v, { products: [{ productId: pa.id, skuId: pa.skuIds[0] }, { productId: pb.id, skuId: pb.skuIds[0] }], hosts: [{ hostId: hostA }], sampleReadyDate: dayOffset(-30), openDate: dayOffset(-10), closeDate: dayOffset(10) })).id;
    await query(`UPDATE campaigns SET status='RUNNING' WHERE id=$1`, [camp]);
    const rows = [HEADER];
    for (let i = 1; i <= 2; i++) rows.push(`MP-${n}-A${i},${camp},${dayOffset(-5)} 10:00,PAID,1,800,HA${n},bm${i},${hostA},,`);
    for (let i = 1; i <= 8; i++) rows.push(`MP-${n}-B${i},${camp},${dayOffset(-5)} 11:00,PAID,1,100,HB${n},bn${i},${hostA},,`);
    await importOrders({ ...w.admin, source: 'TEST' }, { sourceSystem: 'T', origin: 'DEMO', fileName: `mp${n}.csv`, csv: rows.join('\n') });
    return { v, pa, pb, camp };
  }

  it('盤點資料可用性，並用財務已記錄的共同費用比較四種候選方法；明確標示提案、未生效；缺資料的項目維持缺資料', async () => {
    const { camp } = await multi();
    await createExpense(w.finance, { category: 'SHIPPING', amount: 1000, incurredOn: dayOffset(-3), campaignId: camp } as never);
    const before = await counts();
    const a = await getCostAllocationAnalysis(w.finance, camp);
    expect(a).toMatchObject({ multiProduct: true, effective: false });
    expect(a.note).toContain('提案，未生效');
    expect(a.products.map((p) => p.name.replace(/ \d+$/, '').replace('[DEMO] ', ''))).toEqual(['低單價', '高單價']);   // 依商品名稱排序
    expect(a.products.map((p) => p.nsv)).toEqual([800, 1600]);      // 低單價 8×100；高單價 2×800
    expect(a.products.map((p) => p.quantity)).toEqual([8, 2]);
    expect(a.products.every((p) => p.productCost != null)).toBe(true);
    const inv = Object.fromEntries(a.inventory.map((x) => [x.key, x.status]));
    expect(inv).toMatchObject({ orderItems: 'AVAILABLE', productCost: 'AVAILABLE', refundLine: 'MISSING', fixedCost: 'MISSING', returnCost: 'MISSING' });
    const cmp = a.comparison!;
    expect(cmp.status).toBe('PROPOSAL_ONLY');
    const t = (m: string, i: number) => cmp.methods.find((x) => x.method === m)!.allocations[i].total;
    expect(t('BY_NSV', 0)).toBe(333); expect(t('BY_NSV', 1)).toBe(667);              // 800:1600
    expect(t('BY_QUANTITY', 0)).toBe(800); expect(t('BY_QUANTITY', 1)).toBe(200);    // 8:2
    expect(await counts()).toEqual(before);                                          // 唯讀
  });

  it('核准前不啟用：多商品檔期的每單貢獻利潤維持資料不足（即使條款完整、來源都是合約），分析結果不會被 KPI 使用', async () => {
    const { pa, camp } = await multi();
    const t = (await createTrial(w.manager, pa.id, { level: 'HOST_FIT', trialType: 'MINI_GROUP', hostId: hostA, campaignId: camp })).id;
    await createFeasibility(w.manager, pa.id, { campaignId: camp, inputs: TERMS, sources: src('CONTRACT') } as never);
    await getCostAllocationAnalysis(w.finance, camp);
    const k = (await getTrialKpis(w.manager, t)).items.find((x) => x.key === 'contributionPerOrder')!;
    expect(k).toMatchObject({ status: 'INSUFFICIENT', value: null });
    expect(k.reason).toContain('多個商品');
    // 沒有任何新增生效的分攤規則：沒有分攤相關的資料表或系統設定
    const t2 = await query<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE '%alloc%'`);
    expect(t2[0].n).toBe(0);
    expect((await query<{ n: number }>(`SELECT count(*)::int AS n FROM system_settings WHERE organization_id=$1 AND key ILIKE '%alloc%'`, [w.orgId]))[0].n).toBe(0);
  });

  it('單一商品檔期不需要分攤；財務沒有共同費用紀錄時金額未知、不分攤；權限與隔離', async () => {
    const s = await single();
    const a = await getCostAllocationAnalysis(w.finance, s.camp);
    expect(a.multiProduct).toBe(false);
    expect(a.comparison).toBeNull();
    expect(a.kpiImpact).toContain('不需要分攤');
    const m = await multi();
    const none = await getCostAllocationAnalysis(w.finance, m.camp);
    expect(none.costs).toEqual([]);
    expect(none.inventory.find((x) => x.key === 'expenses')!.status).toBe('MISSING');
    await expect(getCostAllocationAnalysis(w.editor, m.camp)).rejects.toThrow();
    await expect(getCostAllocationAnalysis(other.finance, m.camp)).rejects.toThrow();
  });
});

describe('既有結算與 G1–G5 不受影響', () => {
  it('分潤結算只讀 commission_rules：可行性條款與合約的比例不影響結算佣金', async () => {
    const { p, camp } = await single();
    await createCommissionRule(w.finance, { scopeType: 'CAMPAIGN_HOST', hostId: hostA, campaignId: camp, ratePercent: 8, effectiveFrom: dayOffset(-365) });
    const a = (await campaignHostCommission(pool(), w.orgId, camp)).find((x) => x.hostId === hostA)!;
    await createFeasibility(w.manager, p.id, { campaignId: camp, inputs: { ...TERMS, hostCommissionPct: 1 }, sources: src('CONTRACT') } as never);
    await recon(camp);
    const b = (await campaignHostCommission(pool(), w.orgId, camp)).find((x) => x.hostId === hostA)!;
    expect(b).toEqual(a);
    expect(a).toMatchObject({ ratePercent: 8, netSales: 4700, commissionAuto: 376 });
  });
});
