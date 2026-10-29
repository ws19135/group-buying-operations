import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { importOrders, listOrders } from '@/server/modules/orders';
import { createCommissionRule } from '@/server/modules/commission';
import { createPayment, voidPayment } from '@/server/modules/finance';
import { confirmSettlement, createSettlement } from '@/server/modules/settlements';
import { getAdminDashboard } from '@/server/modules/dashboard';
import { todayTaipei } from '@/server/lib/ids';
import { addDays } from '@/server/lib/dates';
import type { AdminDash } from '@/ui/types';
import { dayOffset, makeWorld, mkCampaign, mkCommunity, mkHost, mkProduct, mkVendor, type World } from './helpers';

const HEADER = 'source_order_id,campaign_id,ordered_at,status,quantity,unit_price,sku_code,buyer_ref,host_id,community_id,refund_amount';
const today = todayTaipei();
const dash = async (w: World, month?: string | null, range?: string | null) => (await getAdminDashboard(w.manager, month, range)) as unknown as AdminDash;

let w: World;
let vendorId: string, vendorName: string, productId: string;
let hA: string, hB: string, hC: string, commA: string, commB: string;
let camp1: string, camp3: string, camp4: string, camp5: string;

beforeAll(async () => {
  w = await makeWorld();
  const v = await mkVendor(w, '示範廠商甲');
  vendorId = v.id; vendorName = '示範廠商甲';
  const p = await mkProduct(w, vendorId, { approve: true });
  productId = p.id;
  const prod = [{ productId, skuId: p.skuIds[0] }];
  hA = (await mkHost(w, '團主甲')).id; hB = (await mkHost(w, '團主乙')).id; hC = (await mkHost(w, '團主丙')).id;
  commA = (await mkCommunity(w, [hA], '社群甲')).id; commB = (await mkCommunity(w, [hB], '社群乙')).id;
  await createCommissionRule(w.finance, { scopeType: 'HOST_DEFAULT', hostId: hA, ratePercent: 10, effectiveFrom: dayOffset(-100) });   // 團主乙沒有費率

  const base = { sampleReadyDate: dayOffset(-40), openDate: dayOffset(-3), closeDate: dayOffset(7), products: prod };
  camp1 = (await mkCampaign(w, vendorId, { ...base, hosts: [{ hostId: hA }] }, w.manager)).id;
  await (mkCampaign(w, vendorId, { ...base, openDate: dayOffset(2), closeDate: dayOffset(12), hosts: [{ hostId: hA }] }, w.manager));   // camp2：草稿，任務逾期、團主未回覆
  camp3 = (await mkCampaign(w, vendorId, { ...base, hosts: [{ hostId: hC }] }, w.manager)).id;
  camp4 = (await mkCampaign(w, vendorId, { ...base, hosts: [{ hostId: hC }] }, w.manager)).id;
  camp5 = (await mkCampaign(w, vendorId, { ...base, hosts: [{ hostId: hB }] }, w.manager)).id;
  await query(`UPDATE campaigns SET status='RUNNING' WHERE id = ANY($1::text[])`, [[camp1, camp5]]);
  await query(`UPDATE campaigns SET status='CANCELLED' WHERE id=$1`, [camp3]);
  await query(`UPDATE campaigns SET status='PENDING_CLOSE_CHECK' WHERE id=$1`, [camp4]);

  await importOrders(w.manager, { sourceSystem: 'GAP_X', fileName: 'gap.csv', csv: [HEADER,
    `G1,${camp1},${today} 09:00,PAID,2,800,A,b1,${hA},${commA},`,
    `G2,${camp1},${today} 10:00,PARTIAL_REFUND,1,1500,A,b2,${hA},${commA},500`,
    `G3,${camp5},${today} 11:00,PAID,1,2000,A,b3,${hB},${commB},`,
  ].join('\n') });
  await query(`UPDATE campaign_hosts SET status='CONFIRMED' WHERE campaign_id=$1 AND host_id=$2`, [camp1, hA]);
});

describe('總覽補齊（對照介面示意）：進行中檔期、預估佣金、已確認佣金、已收款金額', () => {
  it('進行中檔期與跨幾位團主', async () => {
    const d = await dash(w);
    expect(d.overview.liveCampaigns).toBe(3);                                     // camp1、camp5 進行中，camp4 待結單確認；草稿與已取消不算
    expect(d.overview.liveHosts).toBe(3);                                         // 團主甲、乙、丙
  });

  it('預估佣金重用既有口徑；沒有費率的團主不猜，只計入「未設定費率」筆數', async () => {
    const d = await dash(w);
    expect(d.finance.estimatedCommission).toEqual({ value: 260, unrated: 1 });     // 團主甲 (1600+1000) × 10%；團主乙無規則
  });

  it('已收款金額只算「入帳、有效」；出款與已作廢不計；已確認佣金只算已確認結算', async () => {
    await createPayment(w.finance, { direction: 'IN', counterpartyType: 'PLATFORM', amount: 5000, paidOn: today });
    await createPayment(w.finance, { direction: 'OUT', counterpartyType: 'PLATFORM', amount: 300, paidOn: today });
    const voided = await createPayment(w.finance, { direction: 'IN', counterpartyType: 'PLATFORM', amount: 700, paidOn: today });
    await voidPayment(w.finance, voided.id, '輸入錯誤');
    let d = await dash(w);
    expect(d.finance.received).toEqual({ value: 5000, count: 1 });
    expect(d.finance.confirmedCommission).toEqual({ value: 0, items: 0 });         // 尚無已確認結算
    const s = await createSettlement(w.finance, { campaignId: camp1 });
    d = await dash(w);
    expect(d.finance.confirmedCommission?.items).toBe(0);                           // 草稿不算
    await confirmSettlement(w.finance, s.id);
    d = await dash(w);
    expect(d.finance.confirmedCommission).toEqual({ value: 260, items: 1 });
  });

  it('沒有財務／佣金權限的營運小編看不到這三項，但看得到進行中檔期', async () => {
    const d = (await getAdminDashboard(w.editor)) as unknown as AdminDash;
    expect(d.finance).toEqual({ estimatedCommission: null, confirmedCommission: null, received: null });
    expect(d.overview.liveCampaigns).toBeGreaterThanOrEqual(0);
  });
});

describe('總覽補齊：社群排行、每檔產值、廠商成功率、準時開團率、商品復開、資料來源', () => {
  it('社群業績排行依有效淨銷售額由高到低', async () => {
    const d = await dash(w);
    expect(d.communityRank?.map((c) => [c.name, c.orders, c.net])).toEqual([['社群甲', 2, 2600], ['社群乙', 1, 2000]]);
  });

  it('每檔團購產值：有訂單的檔期數與平均；排序由高到低', async () => {
    const d = await dash(w);
    expect(d.campaignOutput?.campaigns).toBe(2);
    expect(d.campaignOutput?.average).toBe(2300);
    expect(d.campaignOutput?.top.map((c) => [c.id, c.net])).toEqual([[camp1, 2600], [camp5, 2000]]);
  });

  it('廠商合作成功率（暫定口徑）＝已開團 ÷（已開團＋已取消）；評估中的不計', async () => {
    const d = await dash(w);
    expect(d.vendorSuccess.overall).toEqual({ launched: 3, cancelled: 1, rate: 75 });
    expect(d.vendorSuccess.byVendor).toHaveLength(1);
    expect(d.vendorSuccess.byVendor[0]).toMatchObject({ name: vendorName, launched: 3, cancelled: 1, rate: 75 });
  });

  it('檔期準時開團率：沒有轉換紀錄就是「資料不足」，不編造；有紀錄才算', async () => {
    let d = await dash(w);
    expect(d.onTimeLaunch).toEqual({ total: 0, onTime: 0, rate: null });
    const ins = (id: string, daysAgo: number) => query(
      `INSERT INTO events (organization_id, type, entity_type, entity_id, payload, occurred_at) VALUES ($1,'campaign.status_changed','campaign',$2,'{"from":"SCHEDULED","to":"RUNNING"}'::jsonb, ($3::date::text || ' 12:00:00+08')::timestamptz)`,
      [w.orgId, id, addDays(today, -daysAgo)]);
    await ins(camp1, 4);   // 預定開團日 = 今天 −3，實際 −4：準時
    await ins(camp5, 0);   // 實際今天，晚於預定（−3）：未準時
    d = await dash(w);
    expect(d.onTimeLaunch).toEqual({ total: 2, onTime: 1, rate: 50 });
  });

  it('商品復開績效：出現在 2 檔以上（不含已取消）才列入，累計淨銷售額與平均每檔', async () => {
    const d = await dash(w);
    expect(d.productRepeat).toHaveLength(1);
    expect(d.productRepeat[0]).toMatchObject({ productId, campaigns: 4, net: 4600, avgPerCampaign: 1150 });   // 檔期 1、2、4、5（3 已取消不計）
  });

  it('資料來源與同步：每個來源與性質各一列，含訂單數與最後同步時間', async () => {
    const d = await dash(w);
    expect(d.dataSources).toHaveLength(1);
    expect(d.dataSources?.[0]).toMatchObject({ sourceSystem: 'GAP_X', dataOrigin: 'IMPORT', orders: 3 });
    expect(d.dataSources?.[0].lastSync).toBeTruthy();
  });
});

describe('營運異常與待辦：逾期、待回覆、異常、缺訂單資料，依緊急程度排序', () => {
  it('各類事項都帶「廠商｜事件」標題與說明，並由緊急到不緊急排序', async () => {
    await query(`INSERT INTO exceptions (id, organization_id, type, severity, entity_type, entity_id, campaign_id, title, detail) VALUES ('EXC-GAP-1',$1,'TEST','HIGH','campaign',$2,$2,'供貨確認逾期','影響預定開團日')`, [w.orgId, camp4]);
    await query(`INSERT INTO exceptions (id, organization_id, type, severity, entity_type, entity_id, campaign_id, title, detail) VALUES ('EXC-GAP-2',$1,'TASK_OVERDUE','HIGH','task','TSK-X',$2,'重複的逾期例外','不應再列一次')`, [w.orgId, camp4]);
    const d = await dash(w);
    expect(d.attention.some((a) => a.title.includes('重複的逾期例外'))).toBe(false);   // 逾期任務與團主未回覆已各自列出，自動化產生的同類例外不重複顯示
    const kinds = new Set(d.attention.map((a) => a.kind));
    expect(kinds).toContain('OVERDUE');
    expect(kinds).toContain('WAITING_HOST');
    expect(kinds).toContain('EXCEPTION');
    expect(kinds).toContain('NO_ORDER_DATA');
    for (const a of d.attention) { expect(a.title).toContain('｜'); expect(a.href.startsWith('/')).toBe(true); }
    const u = d.attention.map((a) => a.urgency);
    expect(u).toEqual([...u].sort((x, y) => y - x));
    const noOrders = d.attention.find((a) => a.kind === 'NO_ORDER_DATA')!;
    expect(noOrders.title).toBe(`${vendorName}｜結團後尚無訂單資料`);
    expect(d.attention.find((a) => a.kind === 'WAITING_HOST')!.detail).toContain('尚未回覆');
    expect(d.attention.find((a) => a.kind === 'EXCEPTION')!.title).toBe(`${vendorName}｜供貨確認逾期`);
    expect(d.attention.length).toBeLessThanOrEqual(12);
    for (const k of kinds) expect(d.attention.filter((a) => a.kind === k).length).toBeLessThanOrEqual(5);   // 每類最多 5 筆，不讓逾期任務擠掉其他類型
  });
});

describe('期間切換（本週／本月）與訂單明細', () => {
  it('本週＝台北時間週一到週日，且包含今天；本月維持原樣', async () => {
    const wk = await dash(w, null, 'week');
    expect(wk.period.mode).toBe('week');
    expect(new Date(`${wk.period.from}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(wk.period.to).toBe(addDays(wk.period.from, 6));
    expect(wk.period.from <= today && today <= wk.period.to).toBe(true);
    const mo = await dash(w);
    expect(mo.period.mode).toBe('month');
    expect(mo.period.month).toBe(today.slice(0, 7));
  });

  it('訂單明細可依日期、團主、退款篩選，帶檔期名稱與團主；日期格式錯誤會被擋下', async () => {
    const q = (o: Record<string, string>) => new URLSearchParams(o);
    const all = await listOrders(w.manager, q({ from: today, to: today })) as { total: number; items: { campaignTitle: string; hostNames: string | null }[] };
    expect(all.total).toBe(3);
    expect(all.items.every((i) => i.campaignTitle && i.hostNames)).toBe(true);
    expect(((await listOrders(w.manager, q({ from: addDays(today, 1) }))) as { total: number }).total).toBe(0);
    expect(((await listOrders(w.manager, q({ hostId: hB }))) as { total: number }).total).toBe(1);
    expect(((await listOrders(w.manager, q({ refunded: '1' }))) as { total: number }).total).toBe(1);
    await expect(listOrders(w.manager, q({ from: '2026/01/01' }))).rejects.toThrow();
  });
});
