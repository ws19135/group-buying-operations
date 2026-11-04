import { beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '@/server/lib/db';
import { createTrial } from '@/server/modules/trials';
import { getTrialKpis } from '@/server/modules/trial-kpis';
import { createCase, getCase, setCaseHostAttribution } from '@/server/modules/aftersales';
import { loadComplaintStats } from '@/server/modules/complaint-attribution';
import { importOrders } from '@/server/modules/orders';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkCampaign, mkHost, mkProduct, mkVendor, type World } from './helpers';
import type { Actor } from '@/server/lib/permissions';

/** Owner 決策 K-5：客訴歸屬團主（優先訂單歸因、人工指定記來源、未歸屬保留、整體不重複、權限隔離） */
const HEADER = 'source_order_id,campaign_id,ordered_at,status,quantity,unit_price,sku_code,buyer_ref,host_id,community_id,refund_amount';
let w: World, other: World;
let vendorId: string, hostA: string, hostB: string, hostC: string, hostUser: Actor;
let n = 0;
const kpi = (r: Awaited<ReturnType<typeof getTrialKpis>>, key: string) => r.items.find((x) => x.key === key)!;

beforeAll(async () => {
  w = await makeWorld(); other = await makeWorld();
  vendorId = (await mkVendor(w, '[DEMO] K5 廠商')).id;
  hostA = (await mkHost(w, '[DEMO] K5 團主甲')).id; hostB = (await mkHost(w, '[DEMO] K5 團主乙')).id; hostC = (await mkHost(w, '[DEMO] K5 團主丙（不在檔期）')).id;
  hostUser = await addUser(w.orgId, 'HOST', { hostIds: [hostA] });
});

async function scenario() {
  const p = await mkProduct(w, vendorId, { name: `[DEMO] K5 商品 ${++n}`, skus: [{ skuCode: `Q${n}`, name: 'a', listPrice: 1000, groupPrice: 800, costPrice: 500 }] });
  const camp = (await mkCampaign(w, vendorId, { products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: [{ hostId: hostA }, { hostId: hostB }], sampleReadyDate: dayOffset(-30), openDate: dayOffset(-10), closeDate: dayOffset(10) })).id;
  await query(`UPDATE campaigns SET status='RUNNING' WHERE id=$1`, [camp]);
  // 訂單：甲 3 張（A1 A2 A3）、乙 2 張（B1 B2）、共同歸因 1 張（S1：甲 60%、乙 40%）
  const rows = [HEADER];
  for (const [id, host] of [['A1', hostA], ['A2', hostA], ['A3', hostA], ['B1', hostB], ['B2', hostB], ['S1', hostA]] as const) rows.push(`K5-${id}-${n},${camp},${dayOffset(-5)} 10:00,PAID,1,800,Q${n},b${id},${host},,`);
  await importOrders({ ...w.admin, source: 'TEST' }, { sourceSystem: 'T', origin: 'DEMO', fileName: `k5-${n}.csv`, csv: rows.join('\n') });
  const oid = async (id: string) => (await query<{ id: string }>(`SELECT id FROM orders WHERE source_order_id=$1 AND organization_id=$2`, [`K5-${id}-${n}`, w.orgId]))[0].id;
  const s1 = await oid('S1');
  await query(`UPDATE attributions SET share_percent=60 WHERE order_id=$1 AND host_id=$2`, [s1, hostA]);
  await query(`INSERT INTO attributions (order_id, host_id, organization_id, share_percent, method) VALUES ($1,$2,$3,40,'MANUAL')`, [s1, hostB, w.orgId]);
  return { p, camp, oid };
}
const mk = (camp: string, orderId: string | null, title: string) => createCase(w.manager, { campaignId: camp, orderId: orderId ?? undefined, caseType: 'COMPLAINT', title, priority: 'MEDIUM' } as never);

describe('K-5：客訴歸屬團主', () => {
  it('優先由訂單歸因推導：單一團主＝訂單歸因（單一）；多位團主＝共同歸因；沒有訂單＝未歸屬；舊案件不需要任何新欄位', async () => {
    const { camp, oid } = await scenario();
    const single = await mk(camp, await oid('A1'), '[DEMO] 單一歸因');
    const shared = await mk(camp, await oid('S1'), '[DEMO] 共同歸因');
    const none = await mk(camp, null, '[DEMO] 沒有訂單');
    const a = (await getCase(w.manager, single.id)) as { hostAttribution: { kind: string; hosts: { id: string }[] } };
    expect(a.hostAttribution).toMatchObject({ kind: 'ORDER_SINGLE', hosts: [{ id: hostA }] });
    const b = (await getCase(w.manager, shared.id)) as { hostAttribution: { kind: string; hosts: { id: string }[] } };
    expect(b.hostAttribution.kind).toBe('ORDER_SHARED');
    expect(b.hostAttribution.hosts.map((h) => h.id).sort()).toEqual([hostA, hostB].sort());
    const c = (await getCase(w.manager, none.id)) as { hostAttribution: { kind: string; manualAllowed: boolean } };
    expect(c.hostAttribution).toMatchObject({ kind: 'UNATTRIBUTED', manualAllowed: true });
    expect((await query(`SELECT attributed_host_id, host_attribution_source FROM service_cases WHERE id=$1`, [none.id]))[0]).toEqual({ attributed_host_id: null, host_attribution_source: null });   // 沒有任何寫入、沒有自動分配
  });

  it('公司整體客訴件數每件只算一次（多團主共同歸因不重複）；團主層級另列；未歸屬不計入任何團主', async () => {
    const { camp, oid } = await scenario();
    await mk(camp, await oid('A1'), '[DEMO] 甲單一'); await mk(camp, await oid('A2'), '[DEMO] 甲單一二'); await mk(camp, await oid('B1'), '[DEMO] 乙單一');
    await mk(camp, await oid('S1'), '[DEMO] 共同'); await mk(camp, null, '[DEMO] 未歸屬一'); await mk(camp, null, '[DEMO] 未歸屬二');
    const s = await loadComplaintStats(pool(), w.orgId, camp);
    expect(s.total).toBe(6);                                              // 6 件案件＝6，共同歸因的那件沒有被算成 2
    expect(s.unattributed).toBe(2);
    expect(s.sharedCases).toBe(1);
    expect(s.byHost[hostA]).toEqual({ exclusive: 2, shared: 1, manual: 0 });
    expect(s.byHost[hostB]).toEqual({ exclusive: 1, shared: 1, manual: 0 });
    expect(Object.values(s.byHost).reduce((x, h) => x + h.exclusive + h.shared, 0) + s.unattributed).toBe(s.total + s.sharedCases);   // 共同歸因在每位相關團主各出現一次，整體只算一次
  });

  it('人工指定：只有無法由訂單歸因推導的案件才可以；需說明；團主需在檔期內；記錄來源、操作者、時間；可清除；稽核有紀錄', async () => {
    const { camp, oid } = await scenario();
    const orderCase = await mk(camp, await oid('A1'), '[DEMO] 有訂單歸因');
    await expect(setCaseHostAttribution(w.manager, orderCase.id, { hostId: hostB, note: '[DEMO] 想改成乙' })).rejects.toThrow(/以訂單歸因為準/);
    const none = await mk(camp, null, '[DEMO] 沒有訂單');
    await expect(setCaseHostAttribution(w.manager, none.id, { hostId: hostB })).rejects.toThrow(/需說明原因/);
    await expect(setCaseHostAttribution(w.manager, none.id, { hostId: hostC, note: '[DEMO] 買家來自丙的群組' })).rejects.toThrow(/不在此檔期/);
    await expect(setCaseHostAttribution(w.manager, none.id, { hostId: hostB, note: '請打 0912345678' })).rejects.toThrow(/電話/);
    await setCaseHostAttribution(w.manager, none.id, { hostId: hostB, note: '[DEMO] 買家說明是從乙的 LINE 群組加入' });
    const row = (await query(`SELECT attributed_host_id, host_attribution_source, host_attribution_note, host_attributed_by, host_attributed_at FROM service_cases WHERE id=$1`, [none.id]))[0];
    expect(row).toMatchObject({ attributed_host_id: hostB, host_attribution_source: 'MANUAL', host_attributed_by: w.manager.userId });
    expect(row.host_attributed_at).toBeTruthy();
    const view = (await getCase(w.manager, none.id)) as { hostAttribution: { kind: string; label: string } };
    expect(view.hostAttribution).toMatchObject({ kind: 'MANUAL', label: '人工指定' });
    expect((await loadComplaintStats(pool(), w.orgId, camp)).byHost[hostB]).toEqual({ exclusive: 1, shared: 0, manual: 1 });
    expect((await query(`SELECT 1 FROM audit_logs WHERE organization_id=$1 AND action='aftersales.case.host_attribution' AND entity_id=$2`, [w.orgId, none.id])).length).toBe(1);
    await setCaseHostAttribution(w.manager, none.id, { hostId: null });                      // 清除：回到未歸屬
    expect((await getCase(w.manager, none.id) as { hostAttribution: { kind: string } }).hostAttribution.kind).toBe('UNATTRIBUTED');
    // 資料庫限制：沒有說明或來源就不能寫入
    await expect(query(`UPDATE service_cases SET attributed_host_id=$2 WHERE id=$1`, [none.id, hostA])).rejects.toThrow();
  });

  it('KPI：檔期整體與團主層級客訴率分開；未歸屬明講保留；共同歸因整體只算一次', async () => {
    const { p, camp, oid } = await scenario();
    const t = (await createTrial(w.manager, p.id, { level: 'HOST_FIT', trialType: 'MINI_GROUP', hostId: hostA, campaignId: camp })).id;
    await mk(camp, await oid('A1'), '[DEMO] 甲單一'); await mk(camp, await oid('S1'), '[DEMO] 共同'); await mk(camp, await oid('B1'), '[DEMO] 乙單一'); await mk(camp, null, '[DEMO] 未歸屬');
    const k = kpi(await getTrialKpis(w.manager, t), 'complaintDefect');
    // 檔期有效訂單 6（甲 3＋共同 1 張也歸甲、乙 2…）：甲歸因 4 張（A1 A2 A3 S1）、乙歸因 3 張（B1 B2 S1），檔期共 6 張
    expect(k.parts!.find((x) => x.key === 'complaintPer100')!.value).toBe(66.67);          // 4 件 ÷ 檔期有效訂單 6 × 100
    expect(k.parts!.find((x) => x.key === 'hostComplaintPer100')!.value).toBe(50);         // 甲：單一 1＋共同 1＝2 件 ÷ 甲有效訂單 4
    expect(k.facts!.join()).toContain('歸屬此團主 1 件、與其他團主共同歸因 1 件');
    expect(k.facts!.join()).toContain('未歸屬 1 件（保留未歸屬，不分配給任何團主）');
    expect(k.formula).toContain('不作為團主懲罰、停權或任何自動處置的依據');
  });

  it('權限隔離：團主不能指定歸屬、不能看歸屬欄位；其他組織看不到；小編（有售後寫入權）可以；範圍外的案件看不到', async () => {
    const { camp } = await scenario();
    const none = await mk(camp, null, '[DEMO] 權限測試');
    const hostC2 = await Client.forActor(hostUser);
    expect((await hostC2.call('POST', `/aftersales/cases/${none.id}/host-attribution`, { hostId: hostA, note: '[DEMO] 團主自己指定' })).status).toBe(403);
    const hostView = (await hostC2.call('GET', `/aftersales/cases/${none.id}`)).json?.data ?? {};
    expect(hostView.hostAttribution).toBeUndefined();
    expect(hostView.attributedHostId).toBeUndefined();
    const otherC = await Client.forActor(other.manager);
    expect((await otherC.call('POST', `/aftersales/cases/${none.id}/host-attribution`, { hostId: null })).status).toBe(404);
    const ed = await Client.forActor(w.editor);
    expect((await ed.call('POST', `/aftersales/cases/${none.id}/host-attribution`, { hostId: hostA, note: '[DEMO] 小編依買家說明指定' })).status).toBe(200);
    const ed2 = await Client.forActor(w.editor2);   // 不負責這個檔期的另一位小編
    expect([403, 404]).toContain((await ed2.call('POST', `/aftersales/cases/${none.id}/host-attribution`, { hostId: null })).status);
  });
});
