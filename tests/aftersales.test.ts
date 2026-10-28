import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { importOrders } from '@/server/modules/orders';
import * as as from '@/server/modules/aftersales';
import { CASE_TRANSITIONS, ACTIVE_CASE_STATUSES } from '@/server/modules/aftersales';
import { ROLE_PERMISSIONS, type Actor } from '@/server/lib/permissions';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkCampaign, mkHost, mkProduct, mkVendor, type World } from './helpers';

const HEADER = 'source_order_id,campaign_id,ordered_at,status,quantity,unit_price,sku_code,buyer_ref,host_id,community_id,refund_amount';
const at = () => `${dayOffset(-1)} 09:00`;

let w: World;
let cid: string, cid2: string, h1: string;
let hostUser: Actor, otherHostUser: Actor, vendorUser: Actor, otherVendorUser: Actor;
let ord: Record<string, string>;   // source id → internal order id

const orderRow = async (id: string) => (await query<{ gross_amount: number; refund_amount: number; status: string; version: number }>('SELECT gross_amount, refund_amount, status, version FROM orders WHERE id=$1', [id]))[0];
const caseRow = async (id: string) => (await query('SELECT * FROM service_cases WHERE id=$1', [id]))[0];
const refundRow = async (id: string) => (await query('SELECT * FROM refund_requests WHERE id=$1', [id]))[0];
const eventsOf = async (id: string) => query<{ event_type: string; from_status: string | null; to_status: string | null; note: string | null; is_internal: boolean }>('SELECT * FROM case_events WHERE case_id=$1 ORDER BY id', [id]);
const auditOf = async (type: string, id: string) => query<{ action: string; before_data: Record<string, unknown> | null; after_data: Record<string, unknown> | null; reason: string | null }>(
  `SELECT action, before_data, after_data, reason FROM audit_logs WHERE entity_type=$1 AND entity_id=$2 ORDER BY id`, [type, id]);

async function newCase(by: Actor = w.manager, over: Record<string, unknown> = {}) {
  return (await as.createCase(by, { campaignId: cid, caseType: 'REFUND', title: '商品破損', ...over } as never)).id;
}
let orderSeq = 0;
/** 每個需要精確餘額的測試用自己的訂單，避免互相影響 */
async function mkOrder(gross = 1000): Promise<string> {
  const sid = `N${Date.now().toString(36)}${orderSeq++}`;
  await importOrders(w.manager, { sourceSystem: 'SHOP_X', csv: [HEADER, `${sid},${cid},${at()},PAID,1,${gross},,b-${sid},${h1},,`].join('\n') });
  return (await query<{ id: string }>('SELECT id FROM orders WHERE organization_id=$1 AND source_order_id=$2', [w.orgId, sid]))[0].id;
}
/** 建立「已核准」的退款申請 */
async function approvedRefund(amount: number, orderId: string | undefined, caseId?: string) {
  const c = caseId ?? await newCase(w.manager, orderId ? { orderId } : {});
  const r = await as.requestRefund(w.editor, c, { amount, reason: '商品破損', orderId });
  await as.decideRefund(w.manager, r.id, { decision: 'APPROVED' });
  return { caseId: c, refundId: r.id };
}

beforeAll(async () => {
  w = await makeWorld();
  const v = await mkVendor(w);
  const v2 = await mkVendor(w);
  const p = await mkProduct(w, v.id, { approve: true });
  h1 = (await mkHost(w, '團主一')).id;
  const h2 = (await mkHost(w, '團主二')).id;
  cid = (await mkCampaign(w, v.id, { products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: [{ hostId: h1, targetRevenue: 10000 }] }, w.editor)).id;
  cid2 = (await mkCampaign(w, v2.id, { hosts: [{ hostId: h2, targetRevenue: 10000 }] }, w.editor2)).id;
  await query(`UPDATE campaigns SET status='RUNNING' WHERE id = ANY($1::text[])`, [[cid, cid2]]);
  await importOrders(w.manager, { sourceSystem: 'SHOP_X', csv: [HEADER,
    `A1,${cid},${at()},PAID,2,800,,b-a1,${h1},,`,        // 1600
    `A2,${cid},${at()},PAID,1,1000,,b-a2,${h1},,`,       // 1000
    `A3,${cid},${at()},PENDING,1,500,,b-a3,${h1},,`,
    `A4,${cid},${at()},PAID,1,3000,,b-a4,${h1},,`,       // 3000：寫回與滿額
    `A5,${cid},${at()},PAID,1,2000,,b-a5,${h1},,`,       // 2000：併發
    `A6,${cid},${at()},PAID,1,900,,b-a6,${h1},,`,        // 900：交易回滾
    `A7,${cid},${at()},PAID,1,1200,,b-a7,${h1},,`,       // 1200：餘額漂移
    `B1,${cid2},${at()},PAID,1,700,,b-b1,,,`,
  ].join('\n') });
  ord = Object.fromEntries((await query<{ source_order_id: string; id: string }>('SELECT source_order_id, id FROM orders WHERE organization_id=$1', [w.orgId])).map((r) => [r.source_order_id, r.id]));
  hostUser = await addUser(w.orgId, 'HOST', { hostIds: [h1] });
  otherHostUser = await addUser(w.orgId, 'HOST', { hostIds: [h2] });
  vendorUser = await addUser(w.orgId, 'VENDOR', { vendorIds: [v.id] });
  otherVendorUser = await addUser(w.orgId, 'VENDOR', { vendorIds: [v2.id] });
});

afterAll(async () => { await query('DROP TRIGGER IF EXISTS zz_boom ON refund_requests'); await query('DROP FUNCTION IF EXISTS zz_boom()'); });

describe('權限矩陣（定義）', () => {
  it('新增權限的角色分配：小編可處理不可核准；主管可核准不可完成；財務可讀與完成不可核准；團主廠商只能讀', () => {
    const has = (r: keyof typeof ROLE_PERMISSIONS, p: string) => (ROLE_PERMISSIONS[r] as string[]).includes(p);
    expect([has('OPS_EDITOR', 'aftersales.read'), has('OPS_EDITOR', 'aftersales.write'), has('OPS_EDITOR', 'refund.approve'), has('OPS_EDITOR', 'refund.complete')]).toEqual([true, true, false, false]);
    expect([has('OPS_MANAGER', 'aftersales.write'), has('OPS_MANAGER', 'refund.approve'), has('OPS_MANAGER', 'refund.complete')]).toEqual([true, true, false]);
    expect([has('SYSTEM_ADMIN', 'aftersales.write'), has('SYSTEM_ADMIN', 'refund.approve'), has('SYSTEM_ADMIN', 'refund.complete')]).toEqual([true, true, true]);
    expect([has('FINANCE', 'aftersales.read'), has('FINANCE', 'aftersales.write'), has('FINANCE', 'refund.approve'), has('FINANCE', 'refund.complete')]).toEqual([true, false, false, true]);
    for (const r of ['HOST', 'VENDOR'] as const) expect([has(r, 'aftersales.read'), has(r, 'aftersales.write'), has(r, 'refund.approve'), has(r, 'refund.complete')]).toEqual([true, false, false, false]);
  });
});

describe('建立案件', () => {
  it('成功：寫入欄位、預設值、買家代號由訂單帶入、處理紀錄與稽核都有，讀回核對', async () => {
    const r = await as.createCase(w.manager, { campaignId: cid, orderId: ord['A1'], caseType: 'COMPLAINT', priority: 'HIGH', title: '外盒破損', description: '收到時外盒壓壞', dueDate: dayOffset(3), internalNote: '先問廠商庫存', assigneeUserId: w.editor.userId as string });
    expect(r.id).toMatch(/^CAS-\d{6}$/);
    const row = await caseRow(r.id);
    expect(row).toMatchObject({ organization_id: w.orgId, campaign_id: cid, order_id: ord['A1'], case_type: 'COMPLAINT', status: 'OPEN', priority: 'HIGH', title: '外盒破損', buyer_ref: 'b-a1', assignee_user_id: w.editor.userId, internal_note: '先問廠商庫存', created_by: w.manager.userId, version: 1 });
    expect(row.due_date).toBe(dayOffset(3));
    expect((await eventsOf(r.id)).map((e) => [e.event_type, e.to_status])).toEqual([['CREATED', 'OPEN']]);
    const a = await auditOf('service_case', r.id);
    expect(a.map((x) => x.action)).toEqual(['service_case.create']);
    expect(a[0].after_data).toMatchObject({ caseType: 'COMPLAINT', orderId: ord['A1'] });
    const n = await query('SELECT recipient_user_id, channel, status FROM notifications WHERE entity_id=$1', [r.id]);
    expect(n).toEqual([{ recipient_user_id: w.editor.userId, channel: 'IN_APP', status: 'QUEUED' }]);
  });

  it('輸入驗證：個資、錯的檔期／訂單、非內部負責人、壞日期、空標題', async () => {
    await expect(newCase(w.manager, { description: '請聯絡 0912-345-678' })).rejects.toThrow(/請勿填寫電話或 Email/);
    await expect(newCase(w.manager, { internalNote: 'buyer@example.com 要求退款' })).rejects.toThrow(/請勿填寫電話或 Email/);
    await expect(newCase(w.manager, { description: '訂單編號 20261090123456789 已核對' })).resolves.toBeTruthy();   // 長數字不是手機
    await expect(as.createCase(w.manager, { campaignId: 'CMP-NOPE', caseType: 'OTHER', title: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(newCase(w.manager, { orderId: ord['B1'] })).rejects.toThrow(/訂單不屬於所選檔期/);
    await expect(newCase(w.manager, { orderId: 'ORD-999999' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(newCase(w.manager, { assigneeUserId: hostUser.userId })).rejects.toThrow(/內部使用者/);
    await expect(newCase(w.manager, { dueDate: '2026-13-40' })).rejects.toThrow(/日期格式/);
    await expect(newCase(w.manager, { title: '   ' })).rejects.toThrow(/標題/);
  });

  it('冪等：相同 Idempotency-Key 只建一件；內容不同但 key 相同 → 422', async () => {
    const c = await Client.forActor(w.manager);
    const body = { campaignId: cid, caseType: 'OTHER', title: '冪等測試' };
    const r1 = await c.call('POST', '/aftersales/cases', body, { 'idempotency-key': 'idem-case-1' });
    const r2 = await c.call('POST', '/aftersales/cases', body, { 'idempotency-key': 'idem-case-1' });
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(r2.data.id).toBe(r1.data.id);
    expect(r2.data.replayed).toBe(true);
    expect((await query('SELECT 1 FROM service_cases WHERE title=$1 AND organization_id=$2', ['冪等測試', w.orgId])).length).toBe(1);
    const r3 = await c.call('POST', '/aftersales/cases', { ...body, title: '另一件' }, { 'idempotency-key': 'idem-case-1' });
    expect(r3.status).toBe(422);
  });
});

describe('權限與資料範圍', () => {
  it('財務、團主、廠商不能建案／編輯／改狀態／申請退款（403）；未登入 401', async () => {
    const id = await newCase();
    const body = { campaignId: cid, caseType: 'OTHER', title: 'x' };
    for (const a of [w.finance, hostUser, vendorUser]) {
      const c = await Client.forActor(a);
      expect((await c.call('POST', '/aftersales/cases', body)).status, a.role).toBe(403);
      expect((await c.call('PATCH', `/aftersales/cases/${id}`, { title: 'y' })).status, a.role).toBe(403);
      expect((await c.call('POST', `/aftersales/cases/${id}/status`, { to: 'IN_PROGRESS' })).status, a.role).toBe(403);
      expect((await c.call('POST', `/aftersales/cases/${id}/notes`, { note: 'z' })).status, a.role).toBe(403);
      expect((await c.call('POST', `/aftersales/cases/${id}/refunds`, { amount: 10, reason: 'r' })).status, a.role).toBe(403);
    }
    expect((await new Client().call('GET', '/aftersales/cases')).status).toBe(401);
  });

  it('營運小編只能處理自己負責檔期的案件；別人的檔期 → 404（不洩漏存在）', async () => {
    const mine = await newCase(w.editor);
    await expect(as.getCase(w.editor, mine)).resolves.toMatchObject({ id: mine });
    // 檔期 2 屬於 editor2
    const other = (await as.createCase(w.manager, { campaignId: cid2, caseType: 'OTHER', title: '他檔' })).id;
    await expect(as.getCase(w.editor, other)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(as.setCaseStatus(w.editor, other, { to: 'IN_PROGRESS' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(as.createCase(w.editor, { campaignId: cid2, caseType: 'OTHER', title: '越權' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const ids = (await as.listCases(w.editor, new URLSearchParams())).items.map((x) => x.id);
    expect(ids).toContain(mine); expect(ids).not.toContain(other);
  });

  it('團主／廠商：只看得到自己範圍的案件摘要，沒有內部備註、描述、買家、訂單、負責人、退款；公開備註看得到、內部備註看不到', async () => {
    const id = await newCase(w.manager, { orderId: ord['A1'], description: '含客戶描述', internalNote: '內部：廠商要賠', assigneeUserId: w.editor.userId as string, dueDate: dayOffset(5) });
    await as.addCaseNote(w.manager, id, { note: '內部：不要告訴團主' });
    await as.addCaseNote(w.manager, id, { note: '已安排補寄', public: true });
    await as.requestRefund(w.editor, id, { amount: 100, reason: '內部退款原因' });
    for (const a of [hostUser, vendorUser]) {
      const d = (await as.getCase(a, id)) as Record<string, unknown>;
      expect(Object.keys(d).sort(), a.role).toEqual(['campaignId', 'campaignTitle', 'caseType', 'closedAt', 'createdAt', 'dueDate', 'events', 'id', 'overdue', 'priority', 'resolution', 'resolvedAt', 'status', 'title']);
      expect(JSON.stringify(d)).not.toMatch(/內部|含客戶描述|b-a1|ORD-|退款|assignee/);
      expect((d.events as { note: string }[]).map((e) => e.note)).toEqual(['已安排補寄']);
      const l = (await as.listCases(a, new URLSearchParams())).items.find((x) => x.id === id) as Record<string, unknown>;
      expect(l).toBeTruthy();
      expect(Object.keys(l)).not.toContain('internalNote'); expect(Object.keys(l)).not.toContain('buyerRef'); expect(Object.keys(l)).not.toContain('orderId');
      await expect(as.listRefunds(a, new URLSearchParams())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    // 別的團主／廠商：看不到
    for (const a of [otherHostUser, otherVendorUser]) {
      await expect(as.getCase(a, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await as.listCases(a, new URLSearchParams())).items.map((x) => x.id)).not.toContain(id);
    }
    // 內部角色：完整
    const full = (await as.getCase(w.manager, id)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(full).toMatchObject({ internalNote: '內部：廠商要賠', description: '含客戶描述', buyerRef: 'b-a1', orderId: ord['A1'] });
    expect(full.events.length).toBeGreaterThanOrEqual(4); expect(full.refunds).toHaveLength(1);
  });
});

describe('案件狀態機', () => {
  it('合法路徑逐步轉移並留下處理紀錄；RESOLVED 需處理結果；CLOSED 後不可再動', async () => {
    const id = await newCase();
    await as.setCaseStatus(w.editor, id, { to: 'IN_PROGRESS' });
    await as.setCaseStatus(w.editor, id, { to: 'WAITING_VENDOR', note: '等廠商回覆' });
    await as.setCaseStatus(w.editor, id, { to: 'IN_PROGRESS' });
    await expect(as.setCaseStatus(w.editor, id, { to: 'RESOLVED' })).rejects.toThrow(/處理結果/);
    const r = await as.setCaseStatus(w.editor, id, { to: 'RESOLVED', resolution: '已補寄新品' });
    expect(r.status).toBe('RESOLVED');
    const row = await caseRow(id);
    expect(row).toMatchObject({ status: 'RESOLVED', resolution: '已補寄新品' });
    expect(row.resolved_at).toBeTruthy();
    await as.setCaseStatus(w.manager, id, { to: 'CLOSED' });
    expect((await caseRow(id)).closed_at).toBeTruthy();
    expect((await eventsOf(id)).filter((e) => e.event_type === 'STATUS').map((e) => `${e.from_status}>${e.to_status}`)).toEqual(['OPEN>IN_PROGRESS', 'IN_PROGRESS>WAITING_VENDOR', 'WAITING_VENDOR>IN_PROGRESS', 'IN_PROGRESS>RESOLVED', 'RESOLVED>CLOSED']);
    await expect(as.setCaseStatus(w.manager, id, { to: 'IN_PROGRESS', note: 'x' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(as.updateCase(w.manager, id, { title: '改' })).rejects.toThrow(/不可編輯/);
    await expect(as.addCaseNote(w.manager, id, { note: '再補一筆' })).rejects.toThrow(/不可再新增/);
    expect((await auditOf('service_case', id)).map((x) => x.action)).toEqual(['service_case.create', 'service_case.status', 'service_case.status', 'service_case.status', 'service_case.status', 'service_case.status']);
  });

  it('非法轉移 412（含每個狀態的完整轉移表）；取消與重新開啟必須填原因；終態不可離開', async () => {
    for (const from of Object.keys(CASE_TRANSITIONS) as (keyof typeof CASE_TRANSITIONS)[]) {
      expect(CASE_TRANSITIONS[from].includes(from)).toBe(false);
    }
    expect(CASE_TRANSITIONS.CLOSED).toEqual([]); expect(CASE_TRANSITIONS.CANCELLED).toEqual([]);
    const id = await newCase();
    await expect(as.setCaseStatus(w.manager, id, { to: 'CLOSED' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(as.setCaseStatus(w.manager, id, { to: 'OPEN' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(as.setCaseStatus(w.manager, id, { to: 'CANCELLED' })).rejects.toThrow(/取消案件請填寫原因/);
    await as.setCaseStatus(w.manager, id, { to: 'RESOLVED', resolution: '客戶撤銷' });
    await expect(as.setCaseStatus(w.manager, id, { to: 'IN_PROGRESS' })).rejects.toThrow(/重新開啟案件請填寫原因/);
    await as.setCaseStatus(w.manager, id, { to: 'IN_PROGRESS', note: '客戶又來信' });
    expect((await caseRow(id)).resolved_at).toBeNull();
    expect((await auditOf('service_case', id)).map((x) => x.action)).toContain('service_case.reopen');
    await as.setCaseStatus(w.manager, id, { to: 'CANCELLED', note: '重複開案' });
    const row = await caseRow(id);
    expect(row.status).toBe('CANCELLED'); expect(row.cancelled_at).toBeTruthy();
    await expect(as.setCaseStatus(w.manager, id, { to: 'IN_PROGRESS', note: 'x' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(ACTIVE_CASE_STATUSES).toEqual(['OPEN', 'IN_PROGRESS', 'WAITING_VENDOR']);
  });

  it('樂觀鎖：帶舊版本號 → 409', async () => {
    const id = await newCase();
    const v = (await caseRow(id)).version as number;
    await as.updateCase(w.manager, id, { title: '第一次修改', version: v });
    await expect(as.updateCase(w.editor, id, { title: '第二次（舊版本）', version: v })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(as.setCaseStatus(w.editor, id, { to: 'IN_PROGRESS', version: v })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await caseRow(id)).title).toBe('第一次修改');
  });
});

describe('更新案件', () => {
  it('更新欄位、空字串清空、換負責人會通知新負責人、稽核有前後值', async () => {
    const id = await newCase(w.manager, { description: '舊描述', dueDate: dayOffset(2), assigneeUserId: w.editor.userId as string });
    const r = await as.updateCase(w.manager, id, { priority: 'HIGH', description: '新描述', assigneeUserId: w.manager.userId as string });
    expect(r.changed).toBe(true);
    expect(await caseRow(id)).toMatchObject({ priority: 'HIGH', description: '新描述', assignee_user_id: w.manager.userId });
    const n = await query('SELECT recipient_user_id FROM notifications WHERE entity_id=$1 ORDER BY created_at', [id]);
    expect(n.map((x) => x.recipient_user_id)).toEqual([w.editor.userId]);   // 換給自己不通知；原先指派給 editor 的有通知
    await as.updateCase(w.manager, id, { description: '', dueDate: '', assigneeUserId: '' });
    expect(await caseRow(id)).toMatchObject({ description: null, due_date: null, assignee_user_id: null });
    const a = (await auditOf('service_case', id)).filter((x) => x.action === 'service_case.update');
    expect(a).toHaveLength(2);
    expect(a[0].before_data).toMatchObject({ priority: 'MEDIUM', description: '舊描述' });
    expect(a[0].after_data).toMatchObject({ priority: 'HIGH', description: '新描述' });
    const noop = await as.updateCase(w.manager, id, { priority: 'HIGH' });
    expect(noop.changed).toBe(false);
    await expect(as.updateCase(w.manager, id, { assigneeUserId: hostUser.userId as string })).rejects.toThrow(/內部使用者/);
    await expect(as.updateCase(w.manager, id, { description: '電話 0987654321' })).rejects.toThrow(/請勿填寫/);
  });
});

describe('不可實體刪除／處理紀錄不可改', () => {
  it('service_cases、refund_requests 不能 DELETE；case_events 不能 UPDATE 也不能 DELETE', async () => {
    const { caseId, refundId } = await approvedRefund(10, await mkOrder());
    await expect(query('DELETE FROM service_cases WHERE id=$1', [caseId])).rejects.toThrow(/physical delete forbidden/);
    await expect(query('DELETE FROM refund_requests WHERE id=$1', [refundId])).rejects.toThrow(/physical delete forbidden/);
    await expect(query('UPDATE case_events SET note=$2 WHERE case_id=$1', [caseId, '竄改'])).rejects.toThrow(/append-only/);
    await expect(query('DELETE FROM case_events WHERE case_id=$1', [caseId])).rejects.toThrow(/append-only/);
    expect((await eventsOf(caseId)).length).toBeGreaterThan(0);
  });
});

describe('退款申請：金額邊界', () => {
  it('不能超過可退餘額（訂單金額 − 已退 − 其他申請中）；剛好等於餘額可以；併發申請只會成功一筆', async () => {
    const o1 = await mkOrder(1000);
    const c1 = await newCase(w.manager, { orderId: o1 });
    await expect(as.requestRefund(w.editor, c1, { amount: 1001, reason: '超過' })).rejects.toThrow(/超過可退餘額/);
    await expect(as.requestRefund(w.editor, c1, { amount: 0, reason: '零' })).rejects.toThrow();
    await expect(as.requestRefund(w.editor, c1, { amount: -5, reason: '負' })).rejects.toThrow();
    await expect(as.requestRefund(w.editor, c1, { amount: 10.5, reason: '小數' })).rejects.toThrow(/整數/);
    await expect(as.requestRefund(w.editor, c1, { amount: 100, reason: '' })).rejects.toThrow(/退款原因/);
    const ok = await as.requestRefund(w.editor, c1, { amount: 400, reason: '部分退款' });
    expect(await refundRow(ok.id)).toMatchObject({ amount: 400, status: 'REQUESTED', order_id: o1, campaign_id: cid, requested_by: w.editor.userId, writeback_applied: false });
    await expect(as.requestRefund(w.editor, c1, { amount: 601, reason: '連同前一筆超過' })).rejects.toThrow(/剩餘 600/);
    const exact = await as.requestRefund(w.editor, c1, { amount: 600, reason: '剛好等於餘額' });
    expect(exact.id).not.toBe(ok.id);
    expect((await as.getCase(w.manager, c1) as Record<string, any>).refunds).toHaveLength(2); // eslint-disable-line @typescript-eslint/no-explicit-any

    // 併發：訂單 2000，兩個 1500 同時申請 → 只成功一個
    const o2 = await mkOrder(2000);
    const c2 = await newCase(w.manager, { orderId: o2 });
    const c3 = await newCase(w.manager, { orderId: o2 });
    const rs = await Promise.allSettled([as.requestRefund(w.editor, c2, { amount: 1500, reason: 'p1' }), as.requestRefund(w.editor, c3, { amount: 1500, reason: 'p2' })]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await query(`SELECT 1 FROM refund_requests WHERE order_id=$1`, [o2])).length).toBe(1);
  });

  it('訂單狀態不可退款（PENDING）、案件非處理中、訂單屬於別的檔期 → 拒絕；無訂單的案件不檢查餘額', async () => {
    const c = await newCase(w.manager, { orderId: ord['A3'] });
    await expect(as.requestRefund(w.editor, c, { amount: 10, reason: 'r' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const c2 = await newCase(w.manager);
    await expect(as.requestRefund(w.editor, c2, { amount: 10, reason: 'r', orderId: ord['B1'] })).rejects.toThrow(/不屬於此案件的檔期/);
    await expect(as.requestRefund(w.editor, c2, { amount: 10, reason: 'r', orderId: 'ORD-999999' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(as.requestRefund(w.editor, c2, { amount: 999_999, reason: '無訂單' })).resolves.toBeTruthy();
    await as.setCaseStatus(w.manager, c2, { to: 'IN_PROGRESS' });
    const c3 = await newCase(w.manager);
    await as.setCaseStatus(w.manager, c3, { to: 'RESOLVED', resolution: '不需處理' });
    await expect(as.requestRefund(w.editor, c3, { amount: 10, reason: 'r' })).rejects.toThrow(/處理中的案件/);
  });

  it('申請會通知核准者（不通知申請者本人）；Idempotency-Key 重送只建一筆', async () => {
    const c = await newCase(w.manager, { orderId: await mkOrder() });
    const cl = await Client.forActor(w.editor);
    const b = { amount: 5, reason: '冪等退款' };
    const r1 = await cl.call('POST', `/aftersales/cases/${c}/refunds`, b, { 'idempotency-key': 'idem-rf-1' });
    const r2 = await cl.call('POST', `/aftersales/cases/${c}/refunds`, b, { 'idempotency-key': 'idem-rf-1' });
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(r2.data.id).toBe(r1.data.id);
    expect((await query('SELECT 1 FROM refund_requests WHERE case_id=$1', [c])).length).toBe(1);
    const rc = (await query<{ recipient_user_id: string }>('SELECT recipient_user_id FROM notifications WHERE entity_id=$1', [r1.data.id])).map((x) => x.recipient_user_id).sort();
    expect(rc).toEqual([w.manager.userId, w.admin.userId].sort());
  });
});

describe('退款核准', () => {
  it('小編／財務／團主不能核准（403）；主管可核准；退回必須填原因；已決定的不能再決定；申請者收到通知', async () => {
    const c = await newCase(w.manager, { orderId: await mkOrder() });
    const r = await as.requestRefund(w.editor, c, { amount: 50, reason: '退款' });
    const api = async (a: Actor, body: unknown) => (await Client.forActor(a)).call('POST', `/aftersales/refunds/${r.id}/decision`, body);
    for (const a of [w.editor, w.finance, hostUser, vendorUser]) expect((await api(a, { decision: 'APPROVED' })).status, a.role).toBe(403);
    expect((await refundRow(r.id)).status).toBe('REQUESTED');
    await expect(as.decideRefund(w.manager, r.id, { decision: 'REJECTED' })).rejects.toThrow(/填寫原因/);
    expect((await api(w.manager, { decision: 'APPROVED', note: '同意' })).status).toBe(200);
    expect(await refundRow(r.id)).toMatchObject({ status: 'APPROVED', decided_by: w.manager.userId, decision_note: '同意' });
    await expect(as.decideRefund(w.admin, r.id, { decision: 'REJECTED', note: '改變心意' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await query('SELECT 1 FROM notifications WHERE entity_id=$1 AND recipient_user_id=$2 AND subject LIKE $3', [r.id, w.editor.userId, '%已核准'])).length).toBe(1);
    const act = (await auditOf('refund_request', r.id)).map((x) => x.action);
    expect(act).toEqual(['refund.request', 'refund.approve']);
    const ev = (await eventsOf(c)).map((e) => e.event_type);
    expect(ev).toEqual(['CREATED', 'REFUND_REQUESTED', 'REFUND_APPROVED']);
  });

  it('系統管理者可退回，退回的申請不能完成', async () => {
    const c = await newCase(w.manager, { orderId: await mkOrder() });
    const r = await as.requestRefund(w.editor, c, { amount: 60, reason: '退款' });
    await as.decideRefund(w.admin, r.id, { decision: 'REJECTED', note: '不符規定' });
    expect(await refundRow(r.id)).toMatchObject({ status: 'REJECTED', decision_note: '不符規定' });
    await expect(as.completeRefund(w.finance, r.id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('範圍外的使用者核准 → 404（小編不在此檔期時也看不到）', async () => {
    const c = await newCase(w.manager, { orderId: await mkOrder() });
    const r = await as.requestRefund(w.editor, c, { amount: 20, reason: '退款' });
    await expect(as.decideRefund(w.manager, 'RFD-999999', { decision: 'APPROVED' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(r.id).toMatch(/^RFD-\d{6}$/);
  });
});

describe('完成退款與寫回訂單', () => {
  it('只有財務／管理者能完成（主管、小編 403）；未核准不能完成', async () => {
    const c = await newCase(w.manager, { orderId: await mkOrder() });
    const r = await as.requestRefund(w.editor, c, { amount: 30, reason: '退款' });
    await expect(as.completeRefund(w.finance, r.id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await as.decideRefund(w.manager, r.id, { decision: 'APPROVED' });
    for (const a of [w.manager, w.editor, hostUser]) {
      expect((await (await Client.forActor(a)).call('POST', `/aftersales/refunds/${r.id}/complete`, {})).status, a.role).toBe(403);
    }
    expect((await refundRow(r.id)).status).toBe('APPROVED');
  });

  it('預設不寫回：訂單原封不動、writeback_applied=false；已完成不能重複完成', async () => {
    const o = await mkOrder();
    const before = await orderRow(o);
    const { refundId, caseId } = await approvedRefund(70, o);
    const res = await as.completeRefund(w.finance, refundId, { note: '已匯款' });
    expect(res).toMatchObject({ status: 'COMPLETED', writebackApplied: false, order: null });
    expect(await refundRow(refundId)).toMatchObject({ status: 'COMPLETED', completed_by: w.finance.userId, completion_note: '已匯款', writeback_applied: false });
    expect(await orderRow(o)).toEqual(before);
    expect((await auditOf('order', o)).map((x) => x.action)).not.toContain('order.refund_writeback');
    await expect(as.completeRefund(w.finance, refundId)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await eventsOf(caseId)).map((e) => e.event_type)).toEqual(['CREATED', 'REFUND_REQUESTED', 'REFUND_APPROVED', 'REFUND_COMPLETED']);
  });

  it('writeback=true：累計退款寫回、狀態 PAID→PARTIAL_REFUND→REFUNDED，每次都有稽核前後值', async () => {
    const o = ord['A4'];   // 3000
    expect(await orderRow(o)).toMatchObject({ gross_amount: 3000, refund_amount: 0, status: 'PAID' });
    const r1 = await approvedRefund(1200, o);
    const res1 = await as.completeRefund(w.finance, r1.refundId, { writeback: true });
    expect(res1).toMatchObject({ writebackApplied: true, order: { refundAmount: 1200, status: 'PARTIAL_REFUND' } });
    expect(await orderRow(o)).toMatchObject({ refund_amount: 1200, status: 'PARTIAL_REFUND' });
    expect(await refundRow(r1.refundId)).toMatchObject({ writeback_applied: true });
    // 第二筆超過剩餘 1800：申請階段就被擋
    const c2 = await newCase(w.manager, { orderId: o });
    await expect(as.requestRefund(w.editor, c2, { amount: 1801, reason: '超過' })).rejects.toThrow(/剩餘 1800/);
    const r2 = await approvedRefund(1800, o, c2);
    await as.completeRefund(w.admin, r2.refundId, { writeback: true });
    expect(await orderRow(o)).toMatchObject({ refund_amount: 3000, status: 'REFUNDED' });
    const wb = (await auditOf('order', o)).filter((x) => x.action === 'order.refund_writeback');
    expect(wb).toHaveLength(2);
    expect(wb[0].before_data).toMatchObject({ refund_amount: 0, status: 'PAID' });
    expect(wb[0].after_data).toMatchObject({ refund_amount: 1200, status: 'PARTIAL_REFUND' });
    expect(wb[1].after_data).toMatchObject({ refund_amount: 3000, status: 'REFUNDED' });
    expect(wb[1].reason).toBe(`退款申請 ${r2.refundId}`);
    // 已全額退款的訂單不能再申請
    const c3 = await newCase(w.manager, { orderId: o });
    await expect(as.requestRefund(w.editor, c3, { amount: 1, reason: '再退' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('寫回需要關聯訂單；餘額漂移（訂單被匯入更新）→ 驗證失敗且整筆回滾，退款維持「已核准」', async () => {
    // 無訂單
    const cNo = await newCase();
    const rNo = await as.requestRefund(w.editor, cNo, { amount: 100, reason: '無訂單退款' });
    await as.decideRefund(w.manager, rNo.id, { decision: 'APPROVED' });
    await expect(as.completeRefund(w.finance, rNo.id, { writeback: true })).rejects.toThrow(/沒有關聯訂單/);
    expect((await refundRow(rNo.id)).status).toBe('APPROVED');
    // 漂移：A7 = 1200，申請 1000 並核准後，訂單被另行更新為已退 500
    const { refundId, caseId } = await approvedRefund(1000, ord['A7']);
    await query(`UPDATE orders SET refund_amount=500, status='PARTIAL_REFUND' WHERE id=$1`, [ord['A7']]);
    const ordBefore = await orderRow(ord['A7']);
    await expect(as.completeRefund(w.finance, refundId, { writeback: true })).rejects.toThrow(/超過訂單金額/);
    expect(await orderRow(ord['A7'])).toEqual(ordBefore);
    expect(await refundRow(refundId)).toMatchObject({ status: 'APPROVED', completed_by: null, writeback_applied: false });
    expect((await eventsOf(caseId)).map((e) => e.event_type)).not.toContain('REFUND_COMPLETED');
    // 不寫回仍可完成（金額由財務自行處理）
    await expect(as.completeRefund(w.finance, refundId, { writeback: false })).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(await orderRow(ord['A7'])).toEqual(ordBefore);
  });

  it('訂單已被取消／全額退款 → 不可寫回', async () => {
    const { refundId } = await approvedRefund(100, ord['A6']);
    await query(`UPDATE orders SET status='CANCELLED' WHERE id=$1`, [ord['A6']]);
    await expect(as.completeRefund(w.finance, refundId, { writeback: true })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await query(`UPDATE orders SET status='PAID' WHERE id=$1`, [ord['A6']]);
  });

  it('交易回滾：寫回訂單後若完成退款本身失敗，訂單的變更一起還原', async () => {
    const { refundId, caseId } = await approvedRefund(300, ord['A6']);
    await query(`CREATE OR REPLACE FUNCTION zz_boom() RETURNS trigger AS $$ BEGIN IF NEW.status='COMPLETED' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await query(`CREATE TRIGGER zz_boom BEFORE UPDATE ON refund_requests FOR EACH ROW WHEN (NEW.id = '${refundId}') EXECUTE FUNCTION zz_boom()`);
    const before = await orderRow(ord['A6']);
    const auditBefore = (await auditOf('order', ord['A6'])).length;
    await expect(as.completeRefund(w.finance, refundId, { writeback: true })).rejects.toThrow(/boom/);
    await query('DROP TRIGGER zz_boom ON refund_requests');
    expect(await orderRow(ord['A6'])).toEqual(before);
    expect((await auditOf('order', ord['A6'])).length).toBe(auditBefore);
    expect((await refundRow(refundId)).status).toBe('APPROVED');
    expect((await eventsOf(caseId)).map((e) => e.event_type)).not.toContain('REFUND_COMPLETED');
    // 觸發器移除後可正常完成
    await expect(as.completeRefund(w.finance, refundId, { writeback: true })).resolves.toMatchObject({ order: { refundAmount: 300 } });
  });

  it('併發完成同一筆退款：只會成功一次，訂單只寫回一次', async () => {
    const o = ord['A5'];   // 2000；前面併發測試已有一筆 1500 申請中（REQUESTED）。這裡直接用 SQL 建立已核准申請以排除餘額檢查干擾
    const c = await newCase(w.manager, { orderId: o });
    const id = 'RFD-900001';
    await query(`INSERT INTO refund_requests (id, organization_id, case_id, campaign_id, order_id, amount, reason, status, requested_by, decided_by, decided_at) VALUES ($1,$2,$3,$4,$5,200,'併發','APPROVED',$6,$7,now())`, [id, w.orgId, c, cid, o, w.editor.userId, w.manager.userId]);
    const before = (await orderRow(o)).refund_amount;
    const rs = await Promise.allSettled([as.completeRefund(w.finance, id, { writeback: true }), as.completeRefund(w.admin, id, { writeback: true }), as.completeRefund(w.finance, id, { writeback: true })]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rs.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'PRECONDITION_FAILED')).toBe(true);
    expect((await orderRow(o)).refund_amount).toBe(before + 200);
    expect((await auditOf('order', o)).filter((x) => x.action === 'order.refund_writeback' && x.reason === `退款申請 ${id}`)).toHaveLength(1);
  });
});

describe('案件與退款的連動限制', () => {
  it('還有「待核准／待完成」的退款時，案件不能標記已解決或取消；退款完成後才可以', async () => {
    const c = await newCase(w.manager, { orderId: await mkOrder() });
    const r = await as.requestRefund(w.editor, c, { amount: 15, reason: '退款' });
    await expect(as.setCaseStatus(w.manager, c, { to: 'RESOLVED', resolution: '好了' })).rejects.toThrow(/未完成的退款申請/);
    await expect(as.setCaseStatus(w.manager, c, { to: 'CANCELLED', note: '取消' })).rejects.toThrow(/未完成的退款申請/);
    await as.decideRefund(w.manager, r.id, { decision: 'APPROVED' });
    await expect(as.setCaseStatus(w.manager, c, { to: 'RESOLVED', resolution: '好了' })).rejects.toThrow(/未完成的退款申請/);
    await as.completeRefund(w.finance, r.id);
    await expect(as.setCaseStatus(w.manager, c, { to: 'RESOLVED', resolution: '已退款' })).resolves.toMatchObject({ status: 'RESOLVED' });
  });
});

describe('列表與總覽', () => {
  it('篩選：狀態／類型／優先級／檔期／負責人／逾期／搜尋；結果受範圍限制', async () => {
    const late = await newCase(w.manager, { title: '逾期的案件XYZ', priority: 'HIGH', caseType: 'EXCHANGE', dueDate: dayOffset(-2), assigneeUserId: w.manager.userId as string });
    const q = async (s: string, a: Actor = w.manager) => (await as.listCases(a, new URLSearchParams(s))).items as unknown as { id: string; overdue: boolean; status: string }[];
    expect((await q('overdue=1')).map((x) => x.id)).toContain(late);
    expect((await q('overdue=1')).every((x) => x.overdue)).toBe(true);
    expect((await q('q=XYZ')).map((x) => x.id)).toEqual([late]);
    expect((await q('caseType=EXCHANGE&priority=HIGH&mine=1')).map((x) => x.id)).toContain(late);
    expect((await q('mine=1', w.editor)).map((x) => x.id)).not.toContain(late);
    expect((await q('status=ACTIVE')).every((x) => ['OPEN', 'IN_PROGRESS', 'WAITING_VENDOR'].includes(x.status))).toBe(true);
    expect((await q(`campaignId=${cid2}`)).length).toBeGreaterThanOrEqual(1);
    expect((await q(`campaignId=${cid2}`, w.editor)).length).toBe(0);   // editor 不在 cid2
    expect((await q('q=%25')).length).toBe(0);                          // LIKE 萬用字元被跳脫
    await as.setCaseStatus(w.manager, late, { to: 'RESOLVED', resolution: '完成' });
    expect((await q('overdue=1')).map((x) => x.id)).not.toContain(late);   // 已解決不算逾期
    // 優先級排序：HIGH 在前
    const all = (await as.listCases(w.manager, new URLSearchParams('limit=200'))).items as unknown as { priority: string }[];
    const rank = all.map((x) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 })[x.priority] as number);
    expect([...rank].sort((a, b) => a - b)).toEqual(rank);
  });

  it('總覽：與資料庫直接計算一致；團主只看到自己範圍的案件數且沒有退款金額；財務看得到退款彙總', async () => {
    const o = await as.getAftersalesOverview(w.manager);
    const st = await query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM service_cases WHERE organization_id=$1 GROUP BY status`, [w.orgId]);
    const dbBy = Object.fromEntries(st.map((r) => [r.status, r.n]));
    expect(o.byStatus).toEqual(dbBy);
    expect(o.totals.active).toBe((dbBy['OPEN'] ?? 0) + (dbBy['IN_PROGRESS'] ?? 0) + (dbBy['WAITING_VENDOR'] ?? 0));
    const od = await query<{ n: number }>(`SELECT count(*)::int AS n FROM service_cases WHERE organization_id=$1 AND status IN ('OPEN','IN_PROGRESS','WAITING_VENDOR') AND due_date < (now() AT TIME ZONE 'Asia/Taipei')::date`, [w.orgId]);
    expect(o.totals.overdue).toBe(od[0].n);
    expect(o.totals.overdue).toBeGreaterThanOrEqual(0);
    expect(o.byCampaign.reduce((a, c) => a + c.total, 0)).toBe(Object.values(dbBy).reduce((a, b) => a + b, 0));
    const rr = await query<{ status: string; n: number; amt: number }>(`SELECT status, count(*)::int AS n, sum(amount)::bigint AS amt FROM refund_requests WHERE organization_id=$1 GROUP BY status`, [w.orgId]);
    for (const s of ['REQUESTED', 'APPROVED', 'REJECTED', 'COMPLETED'] as const) {
      expect(o.refunds?.[s]).toEqual({ count: rr.find((x) => x.status === s)?.n ?? 0, amount: Number(rr.find((x) => x.status === s)?.amt ?? 0) });
    }
    expect((await as.getAftersalesOverview(w.finance)).refunds).toEqual(o.refunds);
    const h = await as.getAftersalesOverview(hostUser);
    expect(h.refunds).toBeNull();
    expect(h.byCampaign.every((c) => c.campaignId === cid)).toBe(true);
    const none = await as.getAftersalesOverview(otherVendorUser);
    expect(none.byCampaign.every((c) => c.campaignId === cid2)).toBe(true);
    const noScope = await addUser(w.orgId, 'HOST', { hostIds: [] });
    expect((await as.getAftersalesOverview(noScope)).totals.active).toBe(0);
  });

  it('退款列表：內部角色可看、可依狀態篩選；財務有 aftersales.read', async () => {
    const pend = (await as.listRefunds(w.finance, new URLSearchParams('pending=1'))).items as unknown as { status: string }[];
    expect(pend.length).toBeGreaterThan(0);
    expect(pend.every((r) => ['REQUESTED', 'APPROVED'].includes(r.status))).toBe(true);
    const done = (await as.listRefunds(w.manager, new URLSearchParams('status=COMPLETED'))).items as unknown as { status: string; amount: number }[];
    expect(done.every((r) => r.status === 'COMPLETED')).toBe(true);
    const mineOnly = (await as.listRefunds(w.editor, new URLSearchParams())).items as unknown as { campaignId: string }[];
    expect(mineOnly.every((r) => r.campaignId === cid)).toBe(true);
  });
});

describe('API 串接（HTTP 層）', () => {
  it('完整流程：建案 → 處理中 → 申請退款 → 核准 → 完成（預設不寫回）→ 已解決 → 結案；狀態碼與回傳形狀', async () => {
    const o = await mkOrder();
    const ed = await Client.forActor(w.editor);
    const mg = await Client.forActor(w.manager);
    const fin = await Client.forActor(w.finance);
    const created = await ed.call('POST', '/aftersales/cases', { campaignId: cid, orderId: o, caseType: 'REFUND', title: 'API 流程' });
    expect(created.status).toBe(201);
    const id = created.data.id as string;
    expect((await ed.call('POST', `/aftersales/cases/${id}/status`, { to: 'IN_PROGRESS' })).status).toBe(200);
    const rf = await ed.call('POST', `/aftersales/cases/${id}/refunds`, { amount: 25, reason: 'API 退款' });
    expect(rf.status).toBe(201);
    expect((await ed.call('POST', `/aftersales/refunds/${rf.data.id}/decision`, { decision: 'APPROVED' })).status).toBe(403);
    expect((await mg.call('POST', `/aftersales/refunds/${rf.data.id}/decision`, { decision: 'APPROVED' })).status).toBe(200);
    const before = await orderRow(o);
    const done = await fin.call('POST', `/aftersales/refunds/${rf.data.id}/complete`, {});
    expect(done.status).toBe(200);
    expect(done.data.writebackApplied).toBe(false);
    expect(await orderRow(o)).toEqual(before);
    expect((await ed.call('POST', `/aftersales/cases/${id}/status`, { to: 'RESOLVED', resolution: 'API 完成' })).status).toBe(200);
    expect((await mg.call('POST', `/aftersales/cases/${id}/status`, { to: 'CLOSED' })).status).toBe(200);
    const detail = await mg.call('GET', `/aftersales/cases/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.data).toMatchObject({ id, status: 'CLOSED', resolution: 'API 完成', refunds: [{ status: 'COMPLETED', amount: 25 }] });
    expect((await ed.call('POST', `/aftersales/cases/${id}/status`, { to: 'IN_PROGRESS', note: 'x' })).status).toBe(412);
    expect((await ed.call('GET', '/aftersales/cases/CAS-999999')).status).toBe(404);
    expect((await ed.call('POST', '/aftersales/cases', { campaignId: cid, caseType: 'BAD', title: 'x' })).status).toBe(422);
    expect((await mg.call('GET', '/aftersales/overview')).status).toBe(200);
    expect((await mg.call('GET', '/aftersales/refunds?status=COMPLETED')).data.items.length).toBeGreaterThan(0);
    const note = await mg.call('POST', `/aftersales/cases/${id}/notes`, { note: '結案後補充' });
    expect(note.status).toBe(412);
  });

  it('writeback 一定要明確傳 true 才會寫回（字串 "true" 不算，422）', async () => {
    const o = await mkOrder();
    const { refundId } = await approvedRefund(40, o);
    const fin = await Client.forActor(w.finance);
    const before = await orderRow(o);
    expect((await fin.call('POST', `/aftersales/refunds/${refundId}/complete`, { writeback: 'true' })).status).toBe(422);
    expect(await orderRow(o)).toEqual(before);
    expect((await refundRow(refundId)).status).toBe('APPROVED');
    const ok = await fin.call('POST', `/aftersales/refunds/${refundId}/complete`, { writeback: true });
    expect(ok.status).toBe(200);
    expect((await orderRow(o)).refund_amount).toBe(before.refund_amount + 40);
  });
});
