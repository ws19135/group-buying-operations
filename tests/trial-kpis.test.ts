import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { createTrial, updateTrial, updateTrialCheck, getTrial } from '@/server/modules/trials';
import { getTrialKpis } from '@/server/modules/trial-kpis';
import { createCase } from '@/server/modules/aftersales';
import { createBatch, addShipment, setShipmentStatus } from '@/server/modules/fulfillment';
import { createFeasibility } from '@/server/modules/feasibility';
import { importOrders } from '@/server/modules/orders';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkCampaign, mkHost, mkProduct, mkVendor, type World } from './helpers';
import type { Actor } from '@/server/lib/permissions';

const HEADER = 'source_order_id,campaign_id,ordered_at,status,quantity,unit_price,sku_code,buyer_ref,host_id,community_id,refund_amount';
const COST = 59317;
let w: World, other: World;
let vendorId: string, hostA: string, hostB: string, hostUser: Actor;
let ed: Client, mgr: Client, hostC: Client;
let n = 0;
const kpi = (r: Awaited<ReturnType<typeof getTrialKpis>>, key: string) => r.items.find((x) => x.key === key)!;

beforeAll(async () => {
  w = await makeWorld(); other = await makeWorld();
  vendorId = (await mkVendor(w, '[DEMO] KPI 廠商')).id;
  hostA = (await mkHost(w, '[DEMO] KPI 團主甲')).id; hostB = (await mkHost(w, '[DEMO] KPI 團主乙')).id;
  hostUser = await addUser(w.orgId, 'HOST', { hostIds: [hostA] });
  [ed, mgr, hostC] = await Promise.all([Client.forActor(w.editor), Client.forActor(w.manager), Client.forActor(hostUser)]);
});

async function scenario() {
  const p = await mkProduct(w, vendorId, { name: `[DEMO] KPI 商品 ${++n}`, skus: [{ skuCode: `K${n}`, name: 'a', listPrice: 1000, groupPrice: 800, costPrice: COST }] });
  const camp = (await mkCampaign(w, vendorId, { products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: [{ hostId: hostA }, { hostId: hostB }], sampleReadyDate: dayOffset(-30), openDate: dayOffset(-10), closeDate: dayOffset(10) })).id;   // 由營運小編建立（小編只看得到自己負責的檔期）
  await query(`UPDATE campaigns SET status='RUNNING' WHERE id=$1`, [camp]);
  return { p, camp, sku: `K${n}` };
}

describe('小規模測試團 KPI：整合（真實資料庫）', () => {
  it('沒有任何資料：訂單、出貨類是資料不足（不是 0）；團主意願未記錄也是資料不足；不做通過判定', async () => {
    const { p, camp } = await scenario();
    const t = (await createTrial(w.manager, p.id, { level: 'HOST_FIT', trialType: 'MINI_GROUP', hostId: hostA, campaignId: camp })).id;
    const r = await getTrialKpis(w.manager, t);
    expect(r.items).toHaveLength(8);
    for (const key of ['validOrders', 'conversionRate', 'aov', 'contributionPerOrder', 'refundCancel', 'onTimeShip', 'hostIntent']) expect(kpi(r, key)).toMatchObject({ status: 'INSUFFICIENT', value: null });
    expect(kpi(r, 'validOrders').reason).toContain('尚無訂單');
    expect(r.thresholds.applied).toBe(false);
    expect(r.insufficient).toContain('導購轉換率（CVR）');
  });

  it('有團主：只算該團主歸因的訂單；有效訂單、客單價、退貨與取消比例、客訴、出貨準時率、缺陷率都依公式', async () => {
    const { p, camp, sku } = await scenario();
    const t = (await createTrial(w.manager, p.id, { level: 'HOST_FIT', trialType: 'MINI_GROUP', hostId: hostA, campaignId: camp })).id;
    const rows = [HEADER];
    // 團主甲：6 張有效（4 PAID、2 PARTIAL_REFUND 各退 100）、1 張 REFUNDED、1 張 CANCELLED、1 張 PENDING；團主乙：3 張（不應被計入）
    for (let i = 1; i <= 4; i++) rows.push(`KP-A${i}-${n},${camp},${dayOffset(-5)} 10:00,PAID,1,800,${sku},ba${i},${hostA},,`);
    for (let i = 5; i <= 6; i++) rows.push(`KP-A${i}-${n},${camp},${dayOffset(-5)} 10:00,PARTIAL_REFUND,1,800,${sku},ba${i},${hostA},,100`);
    rows.push(`KP-A7-${n},${camp},${dayOffset(-5)} 11:00,REFUNDED,1,800,${sku},ba7,${hostA},,800`);
    rows.push(`KP-A8-${n},${camp},${dayOffset(-5)} 11:00,CANCELLED,1,800,${sku},ba8,${hostA},,`);
    rows.push(`KP-A9-${n},${camp},${dayOffset(-5)} 11:00,PENDING,1,800,${sku},ba9,${hostA},,`);
    for (let i = 1; i <= 3; i++) rows.push(`KP-B${i}-${n},${camp},${dayOffset(-5)} 12:00,PAID,1,800,${sku},bb${i},${hostB},,`);
    const imp = await importOrders({ ...w.admin, source: 'TEST' }, { sourceSystem: 'T', origin: 'DEMO', fileName: 'kpi.csv', csv: rows.join('\n') });
    expect(imp.insertedOrders).toBe(12);
    // 客訴 1 件（檔期層級）、出貨 4 張：3 準時、1 逾期（皆有日期）
    await createCase(w.manager, { campaignId: camp, caseType: 'COMPLAINT', title: '[DEMO] 客訴', priority: 'MEDIUM' } as never);
    const b = await createBatch(w.manager, camp, { kind: 'ORDER', label: '[DEMO] KPI 出貨' });
    const planned = dayOffset(-4);
    for (const shippedOn of [dayOffset(-5), dayOffset(-4), dayOffset(-4), dayOffset(-2)]) {
      const s = await addShipment(w.manager, b.id, { skuId: p.skuIds[0], quantity: 1, plannedDate: planned });
      await setShipmentStatus(w.manager, s.id, { to: 'PACKED' } as never);
      await setShipmentStatus(w.manager, s.id, { to: 'SHIPPED', date: shippedOn, carrier: '自送' } as never);
    }
    // 試用檢核：測 5 項，2 項未通過
    const ck = (await getTrial(w.manager, t)).checks as unknown as { id: string; itemKey: string }[];
    for (const [i, c] of ck.slice(0, 5).entries()) await updateTrialCheck(w.manager, c.id, (i < 2 ? { result: 'FAIL', defectSeverity: 'MINOR', defectNote: '[DEMO] 缺陷', evidenceText: '[DEMO] 實測' } : { result: 'PASS', evidenceText: '[DEMO] 實測' }) as never);
    const r = await getTrialKpis(w.manager, t);
    expect(kpi(r, 'validOrders')).toMatchObject({ status: 'OK', value: 6 });                          // 只有團主甲、PAID＋PARTIAL_REFUND
    expect(kpi(r, 'aov').value).toBe(Math.round((6 * 800 - 200) / 6));                                // 有效淨銷售額 ÷ 有效訂單數
    const rc = kpi(r, 'refundCancel');
    expect(rc.value).toBe(42.86);                                                                     // 3 張有退款（2 部分退款＋1 全額退款）÷ 7 張計入銷售（4＋2＋1）
    expect(rc.parts!.find((x) => x.key === 'cancelRate')!.value).toBe(12.5);                          // 1 ÷（7＋1）
    const cd = kpi(r, 'complaintDefect');
    expect(cd.parts!.find((x) => x.key === 'complaintPer100')!.value).toBe(11.11);                    // 檔期整體：1 件 ÷ 檔期有效訂單 9（團主甲 6＋團主乙 3）× 100
    expect(cd.parts!.find((x) => x.key === 'hostComplaintPer100')!.value).toBe(0);                    // 這件客訴沒有關聯訂單＝未歸屬，不計入任何團主
    expect(cd.facts!.join()).toContain('未歸屬 1 件');
    expect(cd.parts!.find((x) => x.key === 'defectRate')!.value).toBe(40);                            // 2 ÷ 5
    expect(kpi(r, 'onTimeShip')).toMatchObject({ status: 'OK', value: 75, completeness: 1 });
    expect(kpi(r, 'conversionRate').status).toBe('INSUFFICIENT');
    expect(kpi(r, 'contributionPerOrder')).toMatchObject({ status: 'INSUFFICIENT', value: null });
    expect(kpi(r, 'validOrders').lowSample).toBe(true);                                               // 6 < 30，只提醒
    expect(r.scopeNote).toContain('這位團主歸因');
  });

  it('沒有指定團主的試用算整個檔期（團主甲＋乙）', async () => {
    const { p, camp, sku } = await scenario();
    const t = (await createTrial(w.manager, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' })).id;
    expect((await getTrialKpis(w.manager, t)).scopeNote).toContain('沒有關聯檔期');
    expect(kpi(await getTrialKpis(w.manager, t), 'validOrders').status).toBe('INSUFFICIENT');
    const t2 = (await createTrial(w.manager, p.id, { level: 'HOST_FIT', trialType: 'MINI_GROUP', campaignId: camp })).id;
    const rows = [HEADER, `KQ-1-${n},${camp},${dayOffset(-5)} 10:00,PAID,1,800,${sku},bq1,${hostA},,`, `KQ-2-${n},${camp},${dayOffset(-5)} 10:00,PAID,1,800,${sku},bq2,${hostB},,`];
    await importOrders({ ...w.admin, source: 'TEST' }, { sourceSystem: 'T', origin: 'DEMO', fileName: 'kpi2.csv', csv: rows.join('\n') });
    expect(kpi(await getTrialKpis(w.manager, t2), 'validOrders').value).toBe(2);
  });

  it('團主再次合作意願：人工記錄、結論後仍可記錄、需有團主；記錄後 KPI 顯示；備註不得含電話', async () => {
    const { p, camp } = await scenario();
    const t = (await createTrial(w.manager, p.id, { level: 'HOST_FIT', trialType: 'MINI_GROUP', hostId: hostA, campaignId: camp })).id;
    expect(kpi(await getTrialKpis(w.manager, t), 'hostIntent').status).toBe('INSUFFICIENT');
    await updateTrial(w.editor, t, { hostIntent: 'WILLING', hostIntentNote: '[DEMO] 對成效滿意' });
    expect(kpi(await getTrialKpis(w.editor, t), 'hostIntent')).toMatchObject({ status: 'OK', value: 'WILLING' });
    await expect(updateTrial(w.editor, t, { hostIntentNote: '請打 0912345678' })).rejects.toThrow(/電話/);
    const noHost = (await createTrial(w.manager, p.id, { level: 'HOST_FIT', trialType: 'MINI_GROUP', campaignId: camp })).id;
    await expect(updateTrial(w.editor, noHost, { hostIntent: 'WILLING' })).rejects.toThrow(/沒有指定團主/);
    expect((await query(`SELECT 1 FROM audit_logs WHERE organization_id=$1 AND action='selection.trial.update' AND entity_id=$2`, [w.orgId, t])).length).toBeGreaterThan(0);
  });

  it('預估每單貢獻利潤只來自可行性試算、只給有成本權限者；實際值仍是資料不足；小編的回應不含成本數字', async () => {
    const { p, camp } = await scenario();
    const t = (await createTrial(w.manager, p.id, { level: 'HOST_FIT', trialType: 'MINI_GROUP', hostId: hostA, campaignId: camp })).id;
    const FULL = { expectedOrders: 100, unitPrice: 1000, refundRatePct: 10, unitCost: 700, shippingPerOrder: 60, platformFeePct: 3, otherVariablePerOrder: 0, fixedCost: 2000, brandFeePct: 10, serviceFeeFixed: 0, hostCommissionPct: 5, commissionBasis: 'NSV', hostPaidBy: 'COMPANY', cashFlowMode: 'BRAND_COLLECTS', shippingBorneBy: 'BRAND', platformFeeBorneBy: 'BRAND', otherCostBorneBy: 'COMPANY', fixedCostBorneBy: 'COMPANY' };
    await createFeasibility(w.manager, p.id, { campaignId: camp, trialId: t, inputs: FULL, sources: Object.fromEntries(Object.keys(FULL).map((k) => [k, { kind: 'VENDOR_QUOTE' }])) } as never);
    const fz = (await query<{ results: { companyContribution: number } }>(`SELECT results FROM feasibility_scenarios WHERE trial_id=$1`, [t]))[0];
    const asMgr = kpi(await getTrialKpis(w.manager, t), 'contributionPerOrder');
    expect(asMgr.status).toBe('INSUFFICIENT'); expect(asMgr.value).toBeNull();
    expect(asMgr.reference!.value).toBe(Math.round(fz.results.companyContribution / 100));
    const asEd = kpi(await getTrialKpis(w.editor, t), 'contributionPerOrder');
    expect(asEd.reference!.value).toBeNull();
    const raw = JSON.stringify((await ed.call('GET', `/trials/${t}/kpis`)).json);
    expect(raw).not.toContain(String(COST));
    expect(raw).not.toContain(`"value":${Math.round(fz.results.companyContribution / 100)}`);   // 比對 JSON 的值，不比對任意子字串（日期裡可能剛好有相同數字）
  });

  it('權限與隔離：團主與廠商不能看；其他組織看不到；範圍外的檔期看不到', async () => {
    const { p, camp } = await scenario();
    const t = (await createTrial(w.manager, p.id, { level: 'HOST_FIT', trialType: 'MINI_GROUP', hostId: hostA, campaignId: camp })).id;
    expect((await hostC.call('GET', `/trials/${t}/kpis`)).status).toBe(403);
    expect((await (await Client.forActor(other.manager)).call('GET', `/trials/${t}/kpis`)).status).toBe(404);
    expect((await mgr.call('GET', `/trials/${t}/kpis`)).status).toBe(200);
    const ed2 = await Client.forActor(w.editor2);   // 另一位小編：不負責這個檔期（建立者是 editor）
    expect([403, 404]).toContain((await ed2.call('GET', `/trials/${t}/kpis`)).status);
  });
});
