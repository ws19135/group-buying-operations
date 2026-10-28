import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { importOrders } from '@/server/modules/orders';
import { createCommissionRule } from '@/server/modules/commission';
import { getHostDashboard } from '@/server/modules/dashboard';
import {
  addAdjustment, confirmSettlement, createSettlement, getSettlement, mySettlementItems, recalculateSettlement, setItemOverride, voidSettlement,
} from '@/server/modules/settlements';
import {
  createExpense, createInvoice, createPayment, financeOverview, issueInvoice, listPayments, matchPayment, unmatchPayment,
  updateExpense, updateInvoice, updatePayment, voidExpense, voidInvoice, voidPayment,
} from '@/server/modules/finance';
import { todayTaipei } from '@/server/lib/ids';
import type { Actor } from '@/server/lib/permissions';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkCampaign, mkHost, mkProduct, mkVendor, type World } from './helpers';

const HEADER = 'source_order_id,campaign_id,ordered_at,status,quantity,unit_price,sku_code,buyer_ref,host_id,community_id,refund_amount';
const today = todayTaipei();
const csv = (rows: string[]) => [HEADER, ...rows].join('\n');

let w: World;
let vendorId: string, productId: string, skuId: string;
let h1: string, h2: string, h3: string, h4: string;
let host1User: Actor, host2User: Actor, vendorUser: Actor;
let seq = 0;

/** 建立一個進行中的檔期，含 4 位團主；h1=10%、h2=12.5%、h3 無訂單無規則、h4 有訂單但無規則 */
async function mkRunning(withOrders = true) {
  const camp = await mkCampaign(w, vendorId, {
    products: [{ productId, skuId }], hosts: [h1, h2, h3, h4].map((hostId) => ({ hostId, targetRevenue: 1000 })),
    sampleReadyDate: dayOffset(-40), openDate: dayOffset(-3), closeDate: dayOffset(7),
  }, w.manager);
  await query(`UPDATE campaigns SET status='RUNNING' WHERE id=$1`, [camp.id]);
  if (withOrders) {
    const n = ++seq;
    await importOrders(w.manager, { sourceSystem: 'SHOP_F', csv: csv([
      `F${n}-1,${camp.id},${today} 09:00,PAID,2,800,A,b1,${h1},,`,
      `F${n}-2,${camp.id},${today} 09:10,PAID,1,2300,A,b2,${h1},,`,         // h1 淨 = 1600 + 2300 = 3900
      `F${n}-3,${camp.id},${today} 10:00,PARTIAL_REFUND,1,1500,A,b3,${h2},,500`, // h2 淨 = 1000
      `F${n}-4,${camp.id},${today} 11:00,REFUNDED,1,800,A,b4,${h2},,`,       // 全額退款：淨 0
      `F${n}-5,${camp.id},${today} 12:00,PAID,1,1000,A,b5,${h4},,`,          // h4 淨 = 1000，無費率
      `F${n}-6,${camp.id},${today} 13:00,PENDING,1,800,A,b6,${h1},,`,        // 未付款不計
      `F${n}-7,${camp.id},${today} 14:00,PAID,1,500,A,b7,,,`,                 // 無歸因
    ]) });
  }
  return camp.id;
}

beforeAll(async () => {
  w = await makeWorld();
  const v = await mkVendor(w);
  vendorId = v.id;
  const p = await mkProduct(w, v.id, { approve: true });
  productId = p.id; skuId = p.skuIds[0];
  h1 = (await mkHost(w, '團主一')).id; h2 = (await mkHost(w, '團主二')).id; h3 = (await mkHost(w, '團主三')).id; h4 = (await mkHost(w, '團主四')).id;
  await createCommissionRule(w.finance, { scopeType: 'HOST_DEFAULT', hostId: h1, ratePercent: 10, effectiveFrom: dayOffset(-100) });
  await createCommissionRule(w.finance, { scopeType: 'HOST_DEFAULT', hostId: h2, ratePercent: 12.5, effectiveFrom: dayOffset(-100) });
  host1User = await addUser(w.orgId, 'HOST', { hostIds: [h1] });
  host2User = await addUser(w.orgId, 'HOST', { hostIds: [h2] });
  vendorUser = await addUser(w.orgId, 'VENDOR', { vendorIds: [vendorId] });
});

const itemOf = (d: Awaited<ReturnType<typeof getSettlement>>, hostId: string) => d.items.find((i) => i.hostId === hostId)!;

describe('結算試算：重用既有預估佣金口徑', () => {
  it('試算值與團主 Dashboard 的預估佣金完全一致；無規則不猜、淨銷售 0 則 0', async () => {
    const cid = await mkRunning();
    const { id } = await createSettlement(w.finance, { campaignId: cid });
    const d = await getSettlement(w.finance, id);
    expect(d.notice).toContain('口徑待 Owner 確認');
    expect(d.settlement.status).toBe('DRAFT');
    expect(d.settlement.campaignId).toBe(cid);
    const a = itemOf(d, h1), b = itemOf(d, h2), c = itemOf(d, h3), e = itemOf(d, h4);
    expect(a).toMatchObject({ netSales: 3900, ratePercent: 10, commissionAuto: 390, commissionFinal: 390 });
    expect(b).toMatchObject({ netSales: 1000, ratePercent: 12.5, commissionAuto: 125 });
    expect(c).toMatchObject({ netSales: 0, ratePercent: null, commissionAuto: 0 });
    expect(e).toMatchObject({ netSales: 1000, ratePercent: null, commissionAuto: null, commissionFinal: null });
    expect(d.totals.itemsWithoutAmount).toBe(1);
    // 與既有團主 Dashboard 對照（同一檔期同一團主）
    for (const [user, hostId] of [[host1User, h1], [host2User, h2]] as const) {
      const dash = await getHostDashboard(user);
      const mine = dash.myCampaigns.find((x) => x.id === cid)!;
      const it = itemOf(d, hostId);
      expect(mine.myNet).toBe(it.netSales);
      expect(mine.estimatedCommission).toBe(it.commissionAuto);
      expect(mine.commissionRate).toBe(it.ratePercent);
    }
    // 未歸因的 500 不屬於任何團主
    expect(d.totals.unattributedNetSales).toBe(500);
    // 讀回資料庫核對
    const rows = await query(`SELECT host_id, net_sales, commission_auto, rule_id FROM settlement_items WHERE settlement_id=$1 ORDER BY host_id`, [id]);
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.host_id === h1)).toMatchObject({ net_sales: 3900, commission_auto: 390 });
    expect(rows.find((r) => r.host_id === h1)!.rule_id).toMatch(/^CMR-/);
    expect(d.settlement.ruleVersionNote).toContain('CMR-');
    expect(d.settlement.ruleVersionNote).toContain('無適用規則');
  });

  it('只有已開賣的檔期可以試算；同一檔期不能同時有兩份草稿；作廢後可重開', async () => {
    const draft = await mkCampaign(w, vendorId, {}, w.manager);
    await expect(createSettlement(w.finance, { campaignId: draft.id })).rejects.toThrow(/尚未進入可試算/);
    await expect(createSettlement(w.finance, { campaignId: 'CMP-000000-0000' })).rejects.toThrow(/找不到/);
    const cid = await mkRunning();
    const s1 = await createSettlement(w.finance, { campaignId: cid });
    await expect(createSettlement(w.finance, { campaignId: cid })).rejects.toThrow(/已有草稿/);
    await expect(voidSettlement(w.finance, s1.id, '  ')).rejects.toThrow();
    await voidSettlement(w.finance, s1.id, '重來');
    const s2 = await createSettlement(w.finance, { campaignId: cid });
    expect(s2.id).not.toBe(s1.id);
    expect((await query(`SELECT status, void_reason FROM settlements WHERE id=$1`, [s1.id]))[0]).toMatchObject({ status: 'VOID', void_reason: '重來' });
  });

  it('相同 Idempotency-Key 重送不會重複建立結算', async () => {
    const cid = await mkRunning();
    const a = await createSettlement(w.finance, { campaignId: cid }, 'idem-settle-1');
    const b = await createSettlement(w.finance, { campaignId: cid }, 'idem-settle-1');
    expect(b.replayed).toBe(true);
    expect(b.id).toBe(a.id);
    expect((await query(`SELECT count(*)::int AS n FROM settlements WHERE campaign_id=$1`, [cid]))[0].n).toBe(1);
  });
});

describe('覆寫與調整項', () => {
  let cid: string, sid: string, item1: string, item4: string;
  beforeAll(async () => {
    cid = await mkRunning();
    sid = (await createSettlement(w.finance, { campaignId: cid })).id;
    const d = await getSettlement(w.finance, sid);
    item1 = itemOf(d, h1).id; item4 = itemOf(d, h4).id;
  });

  it('覆寫必填原因、不可為負、可清除；稽核有前後值', async () => {
    await expect(setItemOverride(w.finance, item4, { amount: 100 })).rejects.toThrow(/原因/);
    await expect(setItemOverride(w.finance, item4, { amount: -1, reason: 'x' })).rejects.toThrow();
    await expect(setItemOverride(w.finance, item4, { amount: 1.5, reason: 'x' })).rejects.toThrow(/整數/);
    await setItemOverride(w.finance, item4, { amount: 100, reason: '合約約定固定金額' });
    let d = await getSettlement(w.finance, sid);
    expect(itemOf(d, h4)).toMatchObject({ commissionAuto: null, commissionOverride: 100, overrideReason: '合約約定固定金額', commissionFinal: 100 });
    const a = await query(`SELECT before_data, after_data, reason FROM audit_logs WHERE action='settlement_item.override' AND entity_id=$1`, [item4]);
    expect(a[0].after_data.commissionOverride).toBe(100);
    expect(a[0].reason).toBe('合約約定固定金額');
    await setItemOverride(w.finance, item4, { amount: null });
    d = await getSettlement(w.finance, sid);
    expect(itemOf(d, h4)).toMatchObject({ commissionOverride: null, commissionFinal: null });
    // 資料庫層：有覆寫值卻沒有原因會被擋
    await expect(query(`UPDATE settlement_items SET commission_override=5, override_reason=NULL WHERE id=$1`, [item1])).rejects.toThrow();
  });

  it('調整項：金額不可為 0、原因必填、只能新增不能改或刪（資料庫層強制）；最終金額 = 基準 + 調整', async () => {
    await expect(addAdjustment(w.finance, sid, { itemId: item1, amount: 0, reason: 'x' })).rejects.toThrow(/不可為 0/);
    await expect(addAdjustment(w.finance, sid, { itemId: item1, amount: 10, reason: '  ' })).rejects.toThrow(/原因/);
    await expect(addAdjustment(w.finance, sid, { itemId: 'SIT-999999', amount: 10, reason: 'x' })).rejects.toThrow(/找不到/);
    const a1 = await addAdjustment(w.finance, sid, { itemId: item1, amount: -40, reason: '運費分攤' });
    await addAdjustment(w.finance, sid, { itemId: item1, amount: 15, reason: '活動獎勵（手動）' });
    const d = await getSettlement(w.finance, sid);
    expect(itemOf(d, h1)).toMatchObject({ commissionAuto: 390, adjustmentTotal: -25, commissionFinal: 365 });
    expect(d.adjustments).toHaveLength(2);
    await expect(query(`UPDATE settlement_adjustments SET amount=1 WHERE id=$1`, [a1.id])).rejects.toThrow(/append-only/);
    await expect(query(`DELETE FROM settlement_adjustments WHERE id=$1`, [a1.id])).rejects.toThrow(/append-only/);
    expect((await query(`SELECT amount, reason FROM settlement_adjustments WHERE id=$1`, [a1.id]))[0]).toMatchObject({ amount: -40, reason: '運費分攤' });
  });

  it('重新試算會保留覆寫與調整項，只更新自動算出的欄位', async () => {
    await setItemOverride(w.finance, item4, { amount: 80, reason: '暫定' });
    const before = await getSettlement(w.finance, sid);
    const r = await recalculateSettlement(w.finance, sid);
    expect(r.changedItems).toBe(0);
    const after = await getSettlement(w.finance, sid);
    expect(itemOf(after, h4).commissionOverride).toBe(80);
    expect(after.adjustments).toHaveLength(before.adjustments.length);
  });
});

describe('確認與鎖定', () => {
  it('只有財務／管理者可以確認；營運主管、小編、團主、廠商都不行', async () => {
    const cid = await mkRunning();
    const { id } = await createSettlement(w.finance, { campaignId: cid });
    const d = await getSettlement(w.finance, id);
    await setItemOverride(w.finance, itemOf(d, h4).id, { amount: 0, reason: '無費率，本期不計' });
    for (const a of [w.manager, w.editor, host1User, vendorUser]) await expect(confirmSettlement(a, id)).rejects.toThrow(/沒有權限/);
    expect((await query(`SELECT status FROM settlements WHERE id=$1`, [id]))[0].status).toBe('DRAFT');
    const ok = await confirmSettlement(w.finance, id, { note: '已與主管確認' });
    expect(ok.status).toBe('CONFIRMED');
    const row = (await query(`SELECT status, confirmed_by, confirmed_at, rule_version_note, data_as_of, data_status FROM settlements WHERE id=$1`, [id]))[0];
    expect(row).toMatchObject({ status: 'CONFIRMED', confirmed_by: w.finance.userId });
    expect(row.confirmed_at).toBeTruthy();
    expect(row.rule_version_note).toMatch(/CMR-\d+ v1/);
    expect(row.data_as_of).toBeTruthy();
    expect(row.data_status).toBe('IMPORT');
    const aud = await query(`SELECT reason, after_data FROM audit_logs WHERE action='settlement.confirm' AND entity_id=$1`, [id]);
    expect(aud[0].reason).toBe('已與主管確認');
    expect(aud[0].after_data.status).toBe('CONFIRMED');
  });

  it('尚有團主沒有可用金額（未設定費率且未覆寫）時不能確認', async () => {
    const cid = await mkRunning();
    const { id } = await createSettlement(w.finance, { campaignId: cid });
    await expect(confirmSettlement(w.finance, id)).rejects.toThrow(/團主四/);
    expect((await query(`SELECT status FROM settlements WHERE id=$1`, [id]))[0].status).toBe('DRAFT');
  });

  it('試算後訂單有變動：確認被擋，重新試算後才能確認', async () => {
    const cid = await mkRunning();
    const { id } = await createSettlement(w.finance, { campaignId: cid });
    const d = await getSettlement(w.finance, id);
    await setItemOverride(w.finance, itemOf(d, h4).id, { amount: 0, reason: '不計' });
    await importOrders(w.manager, { sourceSystem: 'SHOP_F', csv: csv([`LATE-${cid},${cid},${today} 15:00,PAID,1,1000,A,b9,${h1},,`]) });
    expect((await getSettlement(w.finance, id)).stale).toBe(true);
    await expect(confirmSettlement(w.finance, id)).rejects.toThrow(/重新試算/);
    const r = await recalculateSettlement(w.finance, id);
    expect(r.changedItems).toBe(1);
    const d2 = await getSettlement(w.finance, id);
    expect(d2.stale).toBe(false);
    expect(itemOf(d2, h1)).toMatchObject({ netSales: 4900, commissionAuto: 490 });
    await confirmSettlement(w.finance, id);
  });

  it('確認後鎖定：不能覆寫、調整、重算、再確認；資料庫層也直接擋；只能作廢後重開', async () => {
    const cid = await mkRunning();
    const { id } = await createSettlement(w.finance, { campaignId: cid });
    const d = await getSettlement(w.finance, id);
    const it4 = itemOf(d, h4).id, it1 = itemOf(d, h1).id;
    await setItemOverride(w.finance, it4, { amount: 0, reason: '不計' });
    await confirmSettlement(w.finance, id);
    await expect(setItemOverride(w.finance, it1, { amount: 1, reason: 'x' })).rejects.toThrow(/已鎖定/);
    await expect(addAdjustment(w.finance, id, { itemId: it1, amount: 1, reason: 'x' })).rejects.toThrow(/不可再新增/);
    await expect(recalculateSettlement(w.finance, id)).rejects.toThrow(/只有草稿/);
    await expect(confirmSettlement(w.finance, id)).rejects.toThrow(/只有草稿/);
    // 繞過服務層直接改資料庫也不行
    await expect(query(`UPDATE settlement_items SET commission_override=999, override_reason='hack' WHERE id=$1`, [it1])).rejects.toThrow(/locked/);
    await expect(query(`INSERT INTO settlement_adjustments (id, organization_id, settlement_id, item_id, amount, reason) VALUES ('ADJ-HACK',$1,$2,$3,5,'x')`, [w.orgId, id, it1])).rejects.toThrow(/locked/);
    await expect(query(`UPDATE settlements SET status='DRAFT' WHERE id=$1`, [id])).rejects.toThrow(/only be voided/);
    await expect(query(`UPDATE settlements SET confirmed_by='hacker' WHERE id=$1`, [id])).rejects.toThrow(/locked/);
    await expect(query(`DELETE FROM settlements WHERE id=$1`, [id])).rejects.toThrow(/delete forbidden/);
    await expect(createSettlement(w.finance, { campaignId: cid })).rejects.toThrow(/已有已確認/);
    // 作廢需要 settlement.confirm 與原因；作廢後鎖定，不能再變回草稿
    await expect(voidSettlement(w.manager, id, '想作廢')).rejects.toThrow(/沒有權限/);
    await voidSettlement(w.finance, id, '金額有誤，重開');
    expect((await query(`SELECT status, void_reason, voided_by FROM settlements WHERE id=$1`, [id]))[0]).toMatchObject({ status: 'VOID', void_reason: '金額有誤，重開', voided_by: w.finance.userId });
    await expect(query(`UPDATE settlements SET status='DRAFT' WHERE id=$1`, [id])).rejects.toThrow(/void/);
    const again = await createSettlement(w.finance, { campaignId: cid });
    expect(again.id).not.toBe(id);
  });
});

describe('權限與資料範圍（API）', () => {
  let sid: string, cid: string;
  beforeAll(async () => {
    cid = await mkRunning();
    sid = (await createSettlement(w.finance, { campaignId: cid })).id;
    const d = await getSettlement(w.finance, sid);
    await setItemOverride(w.finance, itemOf(d, h4).id, { amount: 0, reason: '內部：不計' });
    await addAdjustment(w.finance, sid, { itemId: itemOf(d, h1).id, amount: -10, reason: '內部機密調整原因' });
    await confirmSettlement(w.finance, sid);
    await createPayment(w.finance, { direction: 'IN', counterpartyType: 'PLATFORM', amount: 1234, paidOn: dayOffset(-1), campaignId: cid });
  });

  it('團主與廠商完全不能用財務 API；小編沒有財務權限', async () => {
    for (const actor of [host1User, vendorUser, w.editor]) {
      const c = await Client.forActor(actor);
      for (const path of ['/finance/overview', '/settlements', `/settlements/${sid}`, '/payments', '/invoices', '/expenses']) {
        const r = await c.call('GET', path);
        expect(r.status, `${actor.role} GET ${path}`).toBe(403);
      }
      expect((await c.call('POST', '/payments', { direction: 'IN', counterpartyType: 'PLATFORM', amount: 1, paidOn: today })).status).toBe(403);
    }
  });

  it('營運主管可讀不可寫；財務可讀可寫', async () => {
    const m = await Client.forActor(w.manager);
    expect((await m.call('GET', '/finance/overview')).status).toBe(200);
    expect((await m.call('GET', `/settlements/${sid}`)).status).toBe(200);
    expect((await m.call('GET', '/payments')).status).toBe(200);
    for (const [method, path, body] of [
      ['POST', '/settlements', { campaignId: cid }], ['POST', '/payments', { direction: 'IN', counterpartyType: 'PLATFORM', amount: 1, paidOn: today }],
      ['POST', '/invoices', { invoiceNo: 'X', invoiceDate: today, amount: 1 }], ['POST', '/expenses', { category: 'OTHER', amount: 1, incurredOn: today }],
      ['POST', `/settlements/${sid}/confirm`, {}], ['POST', `/settlements/${sid}/void`, { reason: 'x' }],
    ] as const) {
      expect((await m.call(method, path, body)).status, `${method} ${path}`).toBe(403);
    }
    const f = await Client.forActor(w.finance);
    expect((await f.call('GET', '/finance/overview')).status).toBe(200);
    const r = await f.call('POST', '/expenses', { category: 'OTHER', amount: 10, incurredOn: today });
    expect(r.status).toBe(201);
  });

  it('團主只看得到自己、已確認的結算項摘要；看不到其他團主、原因、調整細節', async () => {
    const c1 = await Client.forActor(host1User);
    const r = await c1.call('GET', '/settlements/mine');
    expect(r.status).toBe(200);
    expect(r.data.notice).toContain('非正式付款依據');
    const mine = r.data.items.filter((i: { campaignId: string }) => i.campaignId === cid);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ netSales: 3900, ratePercent: 10, commission: 380 });
    const text = JSON.stringify(r.data);
    expect(text).not.toContain('內部機密調整原因');
    expect(text).not.toContain('內部：不計');
    expect(text).not.toContain(h2);
    expect(text).not.toContain(h4);
    expect(r.data.items.every((i: Record<string, unknown>) => !('overrideReason' in i) && !('hostId' in i))).toBe(true);
    // 團主二只看得到自己的
    const c2 = await Client.forActor(host2User);
    const r2 = await c2.call('GET', '/settlements/mine');
    const m2 = r2.data.items.filter((i: { campaignId: string }) => i.campaignId === cid);
    expect(m2).toHaveLength(1);
    expect(m2[0]).toMatchObject({ netSales: 1000, commission: 125 });
    // 草稿不會出現在團主視角
    const draftCid = await mkRunning();
    await createSettlement(w.finance, { campaignId: draftCid });
    expect((await mySettlementItems(host1User)).items.some((i) => i.campaignId === draftCid)).toBe(false);
    // 非團主角色不能用這個端點
    expect((await (await Client.forActor(vendorUser)).call('GET', '/settlements/mine')).status).toBe(403);
    expect((await (await Client.forActor(w.finance)).call('GET', '/settlements/mine')).status).toBe(403);
  });

  it('結算確認 API 回傳與稽核一致；越權不會改到資料', async () => {
    const draftCid = await mkRunning();
    const f = await Client.forActor(w.finance);
    const created = await f.call('POST', '/settlements', { campaignId: draftCid }, { 'idempotency-key': 'api-set-1' });
    expect(created.status).toBe(201);
    const id = created.data.id;
    const m = await Client.forActor(w.manager);
    expect((await m.call('POST', `/settlements/${id}/confirm`, {})).status).toBe(403);
    expect((await query(`SELECT status FROM settlements WHERE id=$1`, [id]))[0].status).toBe('DRAFT');
    const blocked = await f.call('POST', `/settlements/${id}/confirm`, {});
    expect(blocked.status).toBe(412);
  });
});

describe('入帳確認紀錄', () => {
  let cid: string, sid: string, item1: string;
  beforeAll(async () => {
    cid = await mkRunning();
    sid = (await createSettlement(w.finance, { campaignId: cid })).id;
    item1 = itemOf(await getSettlement(w.finance, sid), h1).id;
  });

  it('建立後讀回；金額必須是正整數；對象必須存在；平台不可帶對象編號', async () => {
    const p = await createPayment(w.finance, { direction: 'IN', counterpartyType: 'VENDOR', counterpartyId: vendorId, amount: 5000, paidOn: today, referenceNo: 'REF-PLACEHOLDER-1', note: '貨款' });
    const row = (await query(`SELECT * FROM payments WHERE id=$1`, [p.id]))[0];
    expect(row).toMatchObject({ direction: 'IN', counterparty_type: 'VENDOR', counterparty_id: vendorId, amount: 5000, match_status: 'UNMATCHED', status: 'ACTIVE', reference_no: 'REF-PLACEHOLDER-1' });
    await expect(createPayment(w.finance, { direction: 'IN', counterpartyType: 'PLATFORM', amount: 0, paidOn: today })).rejects.toThrow();
    await expect(createPayment(w.finance, { direction: 'IN', counterpartyType: 'PLATFORM', amount: 1.5, paidOn: today })).rejects.toThrow(/整數/);
    await expect(createPayment(w.finance, { direction: 'IN', counterpartyType: 'PLATFORM', amount: 1, paidOn: '2026/01/01' })).rejects.toThrow();
    await expect(createPayment(w.finance, { direction: 'OUT', counterpartyType: 'HOST', counterpartyId: 'OWN-9999', amount: 1, paidOn: today })).rejects.toThrow(/找不到/);
    await expect(createPayment(w.finance, { direction: 'OUT', counterpartyType: 'HOST', amount: 1, paidOn: today })).rejects.toThrow(/對象編號/);
    await expect(createPayment(w.finance, { direction: 'OUT', counterpartyType: 'PLATFORM', counterpartyId: h1, amount: 1, paidOn: today })).rejects.toThrow(/不可指定/);
    await expect(createPayment(w.finance, { direction: 'IN', counterpartyType: 'PLATFORM', amount: 1, paidOn: today, campaignId: 'CMP-000000-0000' })).rejects.toThrow(/找不到/);
  });

  it('重複送出（同 Idempotency-Key）只建立一筆', async () => {
    const body = { direction: 'IN' as const, counterpartyType: 'PLATFORM' as const, amount: 777, paidOn: today, referenceNo: 'DUP-KEY' };
    const a = await createPayment(w.finance, body, 'pay-idem-1');
    const b = await createPayment(w.finance, body, 'pay-idem-1');
    expect(b.replayed).toBe(true); expect(b.id).toBe(a.id);
    expect((await query(`SELECT count(*)::int AS n FROM payments WHERE organization_id=$1 AND reference_no='DUP-KEY'`, [w.orgId]))[0].n).toBe(1);
    await expect(createPayment(w.finance, { ...body, amount: 778 }, 'pay-idem-1')).rejects.toThrow(/Idempotency-Key/);
  });

  it('核對：必須先關聯檔期或結算項目；核對後鎖定；取消核對需原因；已核對不可作廢', async () => {
    const p = await createPayment(w.finance, { direction: 'OUT', counterpartyType: 'HOST', counterpartyId: h1, amount: 390, paidOn: today });
    await expect(matchPayment(w.finance, p.id)).rejects.toThrow(/先關聯/);
    await expect(matchPayment(w.finance, p.id, { settlementItemId: 'SIT-999999' })).rejects.toThrow(/找不到/);
    const otherCid = await mkRunning(false);
    await expect(matchPayment(w.finance, p.id, { campaignId: otherCid, settlementItemId: item1 })).rejects.toThrow(/不一致/);
    await matchPayment(w.finance, p.id, { settlementItemId: item1 });
    let row = (await query(`SELECT match_status, campaign_id, settlement_item_id, matched_by FROM payments WHERE id=$1`, [p.id]))[0];
    expect(row).toMatchObject({ match_status: 'MATCHED', campaign_id: cid, settlement_item_id: item1, matched_by: w.finance.userId });
    await expect(updatePayment(w.finance, p.id, { amount: 1 })).rejects.toThrow(/已核對/);
    await expect(voidPayment(w.finance, p.id, '想作廢')).rejects.toThrow(/先取消核對/);
    await expect(matchPayment(w.finance, p.id)).rejects.toThrow(/已核對/);
    // 有已核對入帳關聯的結算不能作廢
    await expect(voidSettlement(w.finance, sid, '想作廢')).rejects.toThrow(/已核對的入帳/);
    await expect(unmatchPayment(w.finance, p.id, ' ')).rejects.toThrow(/原因/);
    await unmatchPayment(w.finance, p.id, '金額核對有誤');
    row = (await query(`SELECT match_status, matched_by FROM payments WHERE id=$1`, [p.id]))[0];
    expect(row).toMatchObject({ match_status: 'UNMATCHED', matched_by: null });
    await voidPayment(w.finance, p.id, '重複登錄');
    expect((await query(`SELECT status, void_reason FROM payments WHERE id=$1`, [p.id]))[0]).toMatchObject({ status: 'VOID', void_reason: '重複登錄' });
    await expect(updatePayment(w.finance, p.id, { note: 'x' })).rejects.toThrow(/已作廢/);
    await expect(query(`DELETE FROM payments WHERE id=$1`, [p.id])).rejects.toThrow(/delete forbidden/);
    // 資料庫層：MATCHED 但沒有任何關聯會被擋
    const q = await createPayment(w.finance, { direction: 'IN', counterpartyType: 'PLATFORM', amount: 5, paidOn: today });
    await expect(query(`UPDATE payments SET match_status='MATCHED' WHERE id=$1`, [q.id])).rejects.toThrow();
  });

  it('可修改未核對的紀錄；版本衝突被擋；清單可依狀態篩選', async () => {
    const p = await createPayment(w.finance, { direction: 'IN', counterpartyType: 'PLATFORM', amount: 100, paidOn: today, note: '舊備註' });
    await updatePayment(w.finance, p.id, { note: '', amount: 120, campaignId: cid });
    const row = (await query(`SELECT note, amount, campaign_id, version FROM payments WHERE id=$1`, [p.id]))[0];
    expect(row).toMatchObject({ note: null, amount: 120, campaign_id: cid });
    await expect(updatePayment(w.finance, p.id, { amount: 130, version: 1 })).rejects.toThrow(/已被其他人更新/);
    const list = await listPayments(w.finance, new URLSearchParams(`campaignId=${cid}&matchStatus=UNMATCHED`));
    expect(((list as { items: { id: string }[] }).items).some((x) => x.id === p.id)).toBe(true);
  });
});

describe('發票紀錄', () => {
  it('草稿→已開立→作廢；開立後不可改；號碼不可重複（作廢後可重用）；作廢需原因', async () => {
    const inv = await createInvoice(w.finance, { invoiceNo: 'AB-PLACEHOLDER-01', invoiceDate: today, amount: 10500, titleText: '<佔位抬頭>', taxIdText: '<佔位統編>' });
    expect((await query(`SELECT status, amount FROM invoices WHERE id=$1`, [inv.id]))[0]).toMatchObject({ status: 'DRAFT', amount: 10500 });
    await expect(createInvoice(w.finance, { invoiceNo: 'AB-PLACEHOLDER-01', invoiceDate: today, amount: 1 })).rejects.toThrow(/已存在/);
    await updateInvoice(w.finance, inv.id, { amount: 10600, note: '' });
    expect((await query(`SELECT amount FROM invoices WHERE id=$1`, [inv.id]))[0].amount).toBe(10600);
    await issueInvoice(w.finance, inv.id);
    const issued = (await query(`SELECT status, issued_at FROM invoices WHERE id=$1`, [inv.id]))[0];
    expect(issued.status).toBe('ISSUED'); expect(issued.issued_at).toBeTruthy();
    await expect(updateInvoice(w.finance, inv.id, { amount: 1 })).rejects.toThrow(/草稿/);
    await expect(issueInvoice(w.finance, inv.id)).rejects.toThrow(/草稿/);
    await expect(voidInvoice(w.finance, inv.id, '')).rejects.toThrow(/原因/);
    await voidInvoice(w.finance, inv.id, '開錯抬頭');
    expect((await query(`SELECT status, void_reason FROM invoices WHERE id=$1`, [inv.id]))[0]).toMatchObject({ status: 'VOID', void_reason: '開錯抬頭' });
    await expect(query(`DELETE FROM invoices WHERE id=$1`, [inv.id])).rejects.toThrow(/delete forbidden/);
    const again = await createInvoice(w.finance, { invoiceNo: 'AB-PLACEHOLDER-01', invoiceDate: today, amount: 10600 });
    expect(again.id).not.toBe(inv.id);
    const aud = await query(`SELECT action FROM audit_logs WHERE entity_id=$1 ORDER BY id`, [inv.id]);
    expect(aud.map((a) => a.action)).toEqual(['invoice.create', 'invoice.update', 'invoice.issue', 'invoice.void']);
  });
});

describe('費用紀錄與財務總覽', () => {
  it('費用：建立、修改、作廢（不實體刪除）；彙總到財務總覽，不影響試算佣金', async () => {
    const cid = await mkRunning();
    const { id: sid } = await createSettlement(w.finance, { campaignId: cid });
    const before = await getSettlement(w.finance, sid);
    const e1 = await createExpense(w.finance, { category: 'SHIPPING', amount: 300, incurredOn: today, campaignId: cid, note: '樣品運費' });
    const e2 = await createExpense(w.finance, { category: 'MARKETING', amount: 700, incurredOn: today, campaignId: cid });
    const e3 = await createExpense(w.finance, { category: 'OTHER', amount: 50, incurredOn: today, campaignId: cid });
    await expect(createExpense(w.finance, { category: 'WEIRD' as never, amount: 1, incurredOn: today })).rejects.toThrow();
    await expect(createExpense(w.finance, { category: 'OTHER', amount: -5, incurredOn: today })).rejects.toThrow();
    await updateExpense(w.finance, e1.id, { amount: 350 });
    await voidExpense(w.finance, e3.id, '登錄錯誤');
    await expect(updateExpense(w.finance, e3.id, { amount: 1 })).rejects.toThrow(/已作廢/);
    await expect(query(`DELETE FROM expenses WHERE id=$1`, [e2.id])).rejects.toThrow(/delete forbidden/);
    await createPayment(w.finance, { direction: 'IN', counterpartyType: 'VENDOR', counterpartyId: vendorId, amount: 9000, paidOn: today, campaignId: cid });
    await createPayment(w.finance, { direction: 'OUT', counterpartyType: 'HOST', counterpartyId: h1, amount: 390, paidOn: today, campaignId: cid });
    await createInvoice(w.finance, { invoiceNo: `OV-${cid}`, invoiceDate: today, amount: 2000, campaignId: cid }).then((i) => issueInvoice(w.finance, i.id));
    const ov = await financeOverview(w.finance);
    const row = ov.campaigns.find((c) => c.id === cid)!;
    expect(row).toMatchObject({
      netSales: 6400, expenses: 1050, paidIn: 9000, paidOut: 390, invoiced: 2000, unmatchedPayments: 2, settlementId: sid, settlementStatus: 'DRAFT',
      hostsWithoutRate: 1,
    });
    // 試算佣金 = h1 390 + h2 125 + h3 0（h4 無費率不計入）
    expect(row.estimatedCommission).toBe(515);
    expect(ov.notice).toContain('口徑待 Owner 確認');
    expect(ov.totals.paidIn).toBeGreaterThanOrEqual(9000);
    // 費用不進佣金公式
    const after = await getSettlement(w.finance, sid);
    expect(after.items.map((i) => i.commissionAuto)).toEqual(before.items.map((i) => i.commissionAuto));
  });

  it('作廢的入帳／費用不計入總覽', async () => {
    const cid = await mkRunning();
    const p = await createPayment(w.finance, { direction: 'IN', counterpartyType: 'PLATFORM', amount: 4000, paidOn: today, campaignId: cid });
    const e = await createExpense(w.finance, { category: 'OTHER', amount: 40, incurredOn: today, campaignId: cid });
    await voidPayment(w.finance, p.id, '重複');
    await voidExpense(w.finance, e.id, '重複');
    const row = (await financeOverview(w.finance)).campaigns.find((c) => c.id === cid)!;
    expect(row).toMatchObject({ paidIn: 0, expenses: 0, unmatchedPayments: 0 });
  });
});

describe('稽核', () => {
  it('每個寫入動作都有稽核紀錄，且帶操作者與檔期', async () => {
    const rows = await query<{ action: string; actor_user_id: string; campaign_id: string | null }>(
      `SELECT DISTINCT action, actor_user_id, campaign_id IS NOT NULL AS has_campaign FROM audit_logs WHERE organization_id=$1 AND (action LIKE 'settlement%' OR action LIKE 'payment.%' OR action LIKE 'invoice.%' OR action LIKE 'expense.%')`, [w.orgId]);
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ['settlement.create', 'settlement.recalculate', 'settlement.confirm', 'settlement.void', 'settlement.adjustment', 'settlement_item.override', 'payment.create', 'payment.match', 'payment.unmatch', 'payment.void', 'invoice.create', 'invoice.issue', 'invoice.void', 'expense.create', 'expense.void']) {
      expect(actions.has(a), `缺少稽核 ${a}`).toBe(true);
    }
    expect(rows.every((r) => r.actor_user_id === w.finance.userId)).toBe(true);
  });
});
