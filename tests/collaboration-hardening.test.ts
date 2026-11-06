import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '@/server/lib/db';
import type { Actor } from '@/server/lib/permissions';
import { ROLE_PERMISSIONS, roleCan } from '@/server/lib/permissions';
import { campaignScope, collaborationScope } from '@/server/lib/scope';
import * as collab from '@/server/modules/collaboration';
import * as assign from '@/server/modules/collaboration-assignment';
import * as retention from '@/server/modules/collaboration-retention';
import * as imp from '@/server/modules/collaboration-import';
import { setUserStatus } from '@/server/modules/auth';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkHost, mkProduct, mkVendor, type World } from './helpers';

/**
 * Owner 決策 D-37～D-44 的落地驗證：承辦範圍、待指派佇列與交接、個資保留與清除、廠商匯出、
 * CSV 公式注入、匯入暫存去個資、履約視窗、Session／CSRF／限流、權限變更立即失效。
 * 全部打服務層與真實 API；資料只有虛構 DEMO（example.invalid 與測試號碼）。
 */
const PII = { name: 'SENTINEL-收件人-HARD', phone: '0900123456', address: 'SENTINEL-地址-HARD-台北市某路 7 號', note: 'SENTINEL-備註-HARD' };

let w: World, w2: World;
let vA: string, vB: string, hA: string, hB: string, pA: string, pB: string;
let hostA: Actor, hostB: Actor, vendA: Actor, vendB: Actor;
let cl: Record<string, Client>;

beforeAll(async () => {
  w = await makeWorld();
  w2 = await makeWorld();
  vA = (await mkVendor(w, '廠商甲HARD')).id;
  vB = (await mkVendor(w, '廠商乙HARD')).id;
  pA = (await mkProduct(w, vA, { approve: true })).id;
  pB = (await mkProduct(w, vB, { approve: true })).id;
  hA = (await mkHost(w, '團主甲HARD')).id;
  hB = (await mkHost(w, '團主乙HARD')).id;
  hostA = await addUser(w.orgId, 'HOST', { hostIds: [hA] });
  hostB = await addUser(w.orgId, 'HOST', { hostIds: [hB] });
  vendA = await addUser(w.orgId, 'VENDOR', { vendorIds: [vA] });
  vendB = await addUser(w.orgId, 'VENDOR', { vendorIds: [vB] });
  cl = {};
  for (const k of ['admin', 'manager', 'editor', 'editor2', 'finance'] as const) cl[k] = await Client.forActor(w[k]);
  cl.hostA = await Client.forActor(hostA);
  cl.vendA = await Client.forActor(vendA);
  cl.vendB = await Client.forActor(vendB);
});

/** 建立申請（預設由主管建立、沒有承辦人＝進待指派佇列） */
async function mkApp(opts: { by?: Actor; vendorId?: string; hostId?: string; productId?: string; owner?: string | null } = {}) {
  const r = await collab.createApplication(opts.by ?? w.manager, {
    vendorId: opts.vendorId ?? vA, hostId: opts.hostId ?? hA, items: [{ productId: opts.productId ?? pA }],
    ...(opts.owner ? { ownerUserId: opts.owner } : {}),
  });
  return r.id;
}
async function approve(id: string, withRecipient = true) {
  await collab.submitApplication(w.manager, id);
  await collab.internalReview(w.manager, id, { decision: 'APPROVE' });
  if (withRecipient) await collab.putRecipient(hostA, id, { recipientName: PII.name, recipientPhone: PII.phone, addressLine: PII.address, deliveryNote: PII.note, confirm: true });
}
const recipientRow = async (id: string) => (await query<Record<string, unknown>>('SELECT * FROM collaboration_recipients WHERE application_id=$1 ORDER BY created_at, id', [id]));

// ================================================================= D-39
describe('D-39：營運小編只看得到自己承辦或被指派的申請', () => {
  it('權限矩陣：assign／retention.manage 只給管理者與營運主管；小編沒有', () => {
    for (const p of ['collaboration.assign', 'collaboration.retention.manage'] as const) {
      expect(roleCan('SYSTEM_ADMIN', p)).toBe(true);
      expect(roleCan('OPS_MANAGER', p)).toBe(true);
      for (const r of ['OPS_EDITOR', 'HOST', 'VENDOR', 'FINANCE'] as const) expect(ROLE_PERMISSIONS[r]).not.toContain(p);
    }
  });

  it('小編看不到別人承辦的案件（列表、詳情、收件資料、匯出全部）', async () => {
    const id = await mkApp({ owner: w.editor2.userId });
    await approve(id);
    const list = await cl.editor.call<{ items: { id: string }[] }>('GET', '/collaboration/applications?limit=200');
    expect(list.data.items.map((x) => x.id)).not.toContain(id);
    expect((await cl.editor.call('GET', `/collaboration/applications/${id}`)).status).toBe(404);
    expect((await cl.editor.call('GET', `/collaboration/applications/${id}/recipient`)).status).toBe(404);
    const exp = await cl.editor.call('GET', '/collaboration/applications/export?form=form2');
    expect(exp.text).not.toContain(id);
    expect(exp.text).not.toContain(PII.name);
    // 承辦的小編看得到
    expect((await cl.editor2.call('GET', `/collaboration/applications/${id}`)).status).toBe(200);
  });

  it('營運主管與管理者看得到全部', async () => {
    const id = await mkApp({ owner: w.editor2.userId });
    for (const k of ['manager', 'admin'] as const) expect((await cl[k].call('GET', `/collaboration/applications/${id}`)).status).toBe(200);
  });

  it('小編自己建立的案件預設由自己承辦（否則建完自己看不到）；主管建立且沒指定＝待指派', async () => {
    const mine = await mkApp({ by: w.editor });
    expect((await cl.editor.call('GET', `/collaboration/applications/${mine}`)).status).toBe(200);
    const queued = await mkApp({ by: w.manager });
    expect((await cl.editor.call('GET', `/collaboration/applications/${queued}`)).status).toBe(404);
    const q = await cl.manager.call<{ items: { id: string }[] }>('GET', '/collaboration/unassigned?limit=200');
    expect(q.data.items.map((x) => x.id)).toContain(queued);
  });

  it('小編不能替別人建立案件（指定他人承辦需 collaboration.assign）', async () => {
    await expect(collab.createApplication(w.editor, { vendorId: vA, hostId: hA, items: [{ productId: pA }], ownerUserId: w.editor2.userId })).rejects.toThrow();
  });

  it('不能用 PATCH 直接改承辦人（只能走指派／交接），連主管也一樣', async () => {
    const id = await mkApp({ owner: w.editor.userId });
    for (const k of ['manager', 'editor'] as const) {
      const r = await cl[k].call('PATCH', `/collaboration/applications/${id}`, { ownerUserId: w.editor2.userId });
      expect([400, 403, 409, 412, 422]).toContain(r.status);
    }
    const cur = await query<{ owner_user_id: string }>('SELECT owner_user_id FROM collaboration_applications WHERE id=$1', [id]);
    expect(cur[0].owner_user_id).toBe(w.editor.userId);
  });

  it('待指派佇列：小編看得到非個資摘要、看不到收件資料；認領之後才看得到案件', async () => {
    const id = await mkApp({ by: w.manager });
    await approve(id);
    const q = await cl.editor.call<{ items: Record<string, unknown>[] }>('GET', '/collaboration/unassigned?limit=200');
    const row = q.data.items.find((x) => x.id === id);
    expect(row).toBeTruthy();
    for (const k of ['recipientName', 'recipientPhone', 'addressLine', 'internalNote', 'note', 'vendorPortalUrl']) expect(row).not.toHaveProperty(k);
    expect(JSON.stringify(q.data)).not.toContain(PII.address);
    expect((await cl.editor.call('GET', `/collaboration/applications/${id}/recipient`)).status).toBe(404);
    const claim = await cl.editor.call('POST', `/collaboration/applications/${id}/claim`);
    expect(claim.status).toBe(200);
    expect((await cl.editor.call('GET', `/collaboration/applications/${id}`)).status).toBe(200);
    // 已有承辦人就不能再被認領
    expect((await cl.editor2.call('POST', `/collaboration/applications/${id}/claim`)).status).toBe(409);
    const left = await cl.manager.call<{ items: { id: string }[] }>('GET', '/collaboration/unassigned?limit=200');
    expect(left.data.items.map((x) => x.id)).not.toContain(id);
  });

  it('只有主管／管理者可以指派與交接；交接必須填原因；小編被拒', async () => {
    const id = await mkApp({ by: w.manager });
    expect((await cl.editor.call('POST', `/collaboration/applications/${id}/assign`, { userId: w.editor.userId })).status).toBe(403);
    expect((await cl.manager.call('POST', `/collaboration/applications/${id}/assign`, { userId: w.editor.userId })).status).toBe(200);
    // 已有承辦人 → 交接，必須填原因
    expect((await cl.manager.call('POST', `/collaboration/applications/${id}/assign`, { userId: w.editor2.userId })).status).toBe(422);
    expect((await cl.manager.call('POST', `/collaboration/applications/${id}/assign`, { userId: w.editor2.userId, reason: '原承辦人休假' })).status).toBe(200);
    // 舊承辦人立即看不到，新承辦人看得到
    expect((await cl.editor.call('GET', `/collaboration/applications/${id}`)).status).toBe(404);
    expect((await cl.editor2.call('GET', `/collaboration/applications/${id}`)).status).toBe(200);
    const h = await cl.manager.call<{ items: { handoverType: string; reason: string | null }[] }>('GET', `/collaboration/applications/${id}/handovers`);
    expect(h.data.items.map((x) => x.handoverType)).toEqual(['ASSIGN', 'TRANSFER']);
    expect(h.data.items[1].reason).toBe('原承辦人休假');
  });

  it('指派對象必須是啟用中的營運人員（不能指派給團主、廠商、跨組織或已停用者）', async () => {
    const id = await mkApp({ by: w.manager });
    for (const uid of [hostA.userId, vendA.userId, w2.editor.userId, 'USR-NOPE'] as string[]) {
      const r = await cl.manager.call('POST', `/collaboration/applications/${id}/assign`, { userId: uid });
      expect([404, 422]).toContain(r.status);
    }
  });

  it('共同承辦：加入後看得到、移除後立即看不到；承辦人本人可管理共同承辦，非承辦小編不行', async () => {
    const id = await mkApp({ owner: w.editor.userId });
    expect((await cl.editor2.call('POST', `/collaboration/applications/${id}/co-owners`, { userId: w.editor2.userId })).status).toBe(404);
    expect((await cl.editor.call('POST', `/collaboration/applications/${id}/co-owners`, { userId: w.editor2.userId })).status).toBe(201);
    expect((await cl.editor2.call('GET', `/collaboration/applications/${id}`)).status).toBe(200);
    expect((await cl.editor.call('POST', `/collaboration/applications/${id}/co-owners/${w.editor2.userId}/remove`, { reason: '案件結束協作' })).status).toBe(200);
    expect((await cl.editor2.call('GET', `/collaboration/applications/${id}`)).status).toBe(404);
  });

  it('釋出：承辦人把案件放回待指派佇列，必須填原因，佇列看得到', async () => {
    const id = await mkApp({ owner: w.editor.userId });
    expect((await cl.editor.call('POST', `/collaboration/applications/${id}/release`, {})).status).toBe(422);
    expect((await cl.editor.call('POST', `/collaboration/applications/${id}/release`, { reason: '轉調其他專案' })).status).toBe(200);
    expect((await cl.editor.call('GET', `/collaboration/applications/${id}`)).status).toBe(404);
    const q = await cl.manager.call<{ items: { id: string }[] }>('GET', '/collaboration/unassigned?limit=200');
    expect(q.data.items.map((x) => x.id)).toContain(id);
  });

  it('承辦人被停用後，案件不會消失：自動回到待指派佇列，且能被認領', async () => {
    const leaver = await addUser(w.orgId, 'OPS_EDITOR');
    const id = await mkApp({ owner: leaver.userId });
    await setUserStatus(w.admin, leaver.userId as string, 'DISABLED');
    const q = await cl.manager.call<{ items: { id: string; formerOwnerName: string | null }[] }>('GET', '/collaboration/unassigned?limit=200');
    const row = q.data.items.find((x) => x.id === id);
    expect(row, '承辦人停用後案件必須出現在待指派佇列').toBeTruthy();
    expect(row!.formerOwnerName).toBeTruthy();
    expect((await cl.editor.call('POST', `/collaboration/applications/${id}/claim`)).status).toBe(200);
  });

  it('整批交接（離職）：某人所有承辦與共同承辦一次轉給另一人，每筆都有交接紀錄與稽核', async () => {
    const from = await addUser(w.orgId, 'OPS_EDITOR');
    const a1 = await mkApp({ owner: from.userId });
    const a2 = await mkApp({ owner: w.editor2.userId });
    await assign.addCoOwner(w.manager, a2, { userId: from.userId as string });
    const r = await cl.manager.call<{ moved: number }>('POST', '/collaboration/assignments/reassign', { fromUserId: from.userId, toUserId: w.editor.userId, reason: '離職交接' });
    expect(r.status).toBe(200);
    expect(r.data.moved).toBe(2);
    expect((await cl.editor.call('GET', `/collaboration/applications/${a1}`)).status).toBe(200);
    expect((await cl.editor.call('GET', `/collaboration/applications/${a2}`)).status).toBe(200);
    const left = await query('SELECT 1 FROM collaboration_assignments WHERE user_id=$1 AND ended_at IS NULL', [from.userId]);
    expect(left.length).toBe(0);
    const h = await query('SELECT 1 FROM collaboration_handovers WHERE handover_type=\'BULK_REASSIGN\' AND from_user_id=$1', [from.userId]);
    expect(h.length).toBe(2);
    const au = await query('SELECT 1 FROM audit_logs WHERE organization_id=$1 AND action=\'collaboration.assignment.bulk_reassign\'', [w.orgId]);
    expect(au.length).toBeGreaterThanOrEqual(2);
    expect((await cl.editor.call('POST', '/collaboration/assignments/reassign', { fromUserId: from.userId, toUserId: w.editor.userId, reason: 'x' })).status).toBe(403);
  });

  it('交接紀錄 append-only：不能修改或刪除', async () => {
    await expect(query('UPDATE collaboration_handovers SET reason=\'x\'')).rejects.toThrow();
    await expect(query('DELETE FROM collaboration_handovers')).rejects.toThrow();
  });

  it('不影響其他模組：campaignScope 對小編仍是「自己負責或被指派任務」，collaborationScope 才是承辦範圍', () => {
    const c = campaignScope(w.editor, 1, 'c');
    expect(c.sql).toContain('owner_user_id');
    expect(c.sql).toContain('tasks');
    const a = collaborationScope(w.editor, 1, 'a');
    expect(a.sql).toContain('collaboration_assignments');
    expect(collaborationScope(w.manager, 1, 'a').sql).not.toContain('collaboration_assignments');
  });

  it('指派、交接、認領、釋出都不會建立任何通知、不動任何其他模組的資料表', async () => {
    const tables = ['approvals', 'campaigns', 'inventory_movements', 'settlements', 'settlement_items', 'payments', 'tasks', 'notifications'];
    const count = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, (await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`))[0].n])));
    const before = await count();
    const id = await mkApp({ by: w.manager });
    await assign.assignApplication(w.manager, id, { userId: w.editor.userId as string });
    await assign.assignApplication(w.manager, id, { userId: w.editor2.userId as string, reason: '測試交接' });
    await assign.releaseApplication(w.manager, id, { reason: '測試釋出' });
    await assign.claimApplication(w.editor, id);
    const after = await count();
    expect(after).toEqual(before);
  });
});

// ================================================================= D-37 / D-38 / D-44
describe('D-37／D-44：廠商只在自己負責、仍在履約期內才拿得到收件資料', () => {
  it('廠商例外：履約視窗開著才給，並寫帶有用途的稽核；別家廠商一律 404', async () => {
    const id = await mkApp({ owner: w.editor.userId });
    await approve(id);
    await collab.addShipment(w.editor, id, { shipmentType: 'INITIAL' });
    const ok = await cl.vendA.call<{ addressLine: string }>('GET', `/collaboration/applications/${id}/recipient`);
    expect(ok.status).toBe(200);
    expect(ok.data.addressLine).toBe(PII.address);
    const log = await query<{ after_data: { purpose: string; scope: string } }>(
      `SELECT after_data FROM audit_logs WHERE organization_id=$1 AND action='collaboration.recipient.read' AND actor_user_id=$2 ORDER BY id DESC LIMIT 1`, [w.orgId, vendA.userId]);
    expect(log[0].after_data).toMatchObject({ purpose: 'VENDOR_FULFILMENT_EXCEPTION', scope: 'VENDOR' });
    // 別家廠商＝與不存在的 id 同樣回應
    const other = await cl.vendB.call('GET', `/collaboration/applications/${id}/recipient`);
    const fake = await cl.vendB.call('GET', '/collaboration/applications/CLB-999999/recipient');
    expect(other.status).toBe(404);
    expect(other.status).toBe(fake.status);
    expect(other.error?.code).toBe(fake.error?.code);
  });

  it('暫緩、結案、尚未確認地址：廠商拿不到；補寄建立後重新開啟', async () => {
    const id = await mkApp({ owner: w.editor.userId });
    await approve(id, false);
    await collab.addShipment(w.editor, id, { shipmentType: 'INITIAL' });
    await collab.putRecipient(hostA, id, { recipientName: PII.name, recipientPhone: PII.phone, addressLine: PII.address, confirm: false });
    expect((await cl.vendA.call('GET', `/collaboration/applications/${id}/recipient`)).status).toBe(403);       // 未確認
    await collab.putRecipient(hostA, id, { recipientName: PII.name, recipientPhone: PII.phone, addressLine: PII.address, confirm: true });
    expect((await cl.vendA.call('GET', `/collaboration/applications/${id}/recipient`)).status).toBe(200);
    await collab.holdApplication(w.manager, id, '測試暫緩');
    expect((await cl.vendA.call('GET', `/collaboration/applications/${id}/recipient`)).status).toBe(403);       // 暫緩
    await collab.resumeApplication(w.manager, id, 'APPROVED');
    const ship = await query<{ id: string }>('SELECT id FROM collaboration_shipments WHERE application_id=$1', [id]);
    await collab.updateShipment(w.editor, ship[0].id, { shipDate: dayOffset(-1) });
    expect((await cl.vendA.call('GET', `/collaboration/applications/${id}/recipient`)).status).toBe(403);       // 已寄出，視窗關閉
    await collab.addShipment(w.editor, id, { shipmentType: 'RESEND' });
    expect((await cl.vendA.call('GET', `/collaboration/applications/${id}/recipient`)).status).toBe(200);       // 補寄待寄 → 重新開啟
  });

  it('保留期已過但補寄還沒寄出：廠商仍拿得到（履約沒結束不能沒有地址），超過硬性上限才拒絕', async () => {
    const id = await mkApp({ owner: w.editor.userId });
    await approve(id);
    await collab.addShipment(w.editor, id, { shipmentType: 'INITIAL', shipDate: dayOffset(-40) });
    const ship = await query<{ id: string }>('SELECT id FROM collaboration_shipments WHERE application_id=$1', [id]);
    await collab.confirmReceipt(hostA, ship[0].id, { receivedOn: dayOffset(-35) });
    await collab.addShipment(w.editor, id, { shipmentType: 'RESEND' });
    await query('UPDATE collaboration_recipients SET retention_until=$2 WHERE application_id=$1 AND deleted_at IS NULL', [id, dayOffset(-5)]);
    expect((await cl.vendA.call('GET', `/collaboration/applications/${id}/recipient`)).status).toBe(200);
    await query('UPDATE collaboration_applications SET decided_at = now() - interval \'200 days\' WHERE id=$1', [id]);
    const capped = await cl.vendA.call('GET', `/collaboration/applications/${id}/recipient`);
    expect(capped.status).toBe(403);
  });

  it('個資存取一律留稽核；被拒也留事件', async () => {
    const id = await mkApp({ owner: w.editor.userId });
    await approve(id);
    const before = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs WHERE organization_id=$1 AND action='collaboration.recipient.read'`, [w.orgId]))[0].n;
    expect((await cl.editor.call('GET', `/collaboration/applications/${id}/recipient`)).status).toBe(200);
    expect((await cl.hostA.call('GET', `/collaboration/applications/${id}/recipient`)).status).toBe(200);
    const after = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs WHERE organization_id=$1 AND action='collaboration.recipient.read'`, [w.orgId]))[0].n;
    expect(after - before).toBe(2);
  });

  it('團主只能讀自己的收件資料（別的團主＝404）；沒有 pii.read 的內部角色被拒', async () => {
    const id = await mkApp({ owner: w.editor.userId });
    await approve(id);
    const hostBClient = await Client.forActor(hostB);
    expect((await hostBClient.call('GET', `/collaboration/applications/${id}/recipient`)).status).toBe(404);
    expect([403, 404]).toContain((await cl.finance.call('GET', `/collaboration/applications/${id}/recipient`)).status);   // 財務沒有任何合作範圍：不洩漏存在性
  });
});

describe('D-38：廠商匯出沒有個資，也無法從其他端點取得', () => {
  let id: string;
  beforeAll(async () => {
    id = await mkApp({ owner: w.editor.userId });
    await approve(id);
    await collab.putVendorLaunch(vendA, id, { backendSetupEmail: 'shop@example.invalid', backendSetupStatus: 'REQUESTED' });
  });

  it('廠商匯出：兩種表單都不含收件人／電話／地址／備註原文，標題也沒有這些欄位', async () => {
    for (const form of ['form1', 'form2']) {
      const r = await cl.vendA.call('GET', `/collaboration/applications/export?form=${form}`);
      expect(r.status).toBe(200);
      expect(r.text).toContain(id);
      for (const leak of [PII.name, PII.phone, PII.address, PII.note, '［無權限］']) expect(r.text).not.toContain(leak);
      const header = r.text.replace('﻿', '').split('\r\n')[0];
      for (const col of ['收件人', '聯繫電話', '地址']) expect(header).not.toContain(col);
    }
  });

  it('廠商匯出只含自己廠商範圍；別家的案件不在內', async () => {
    const other = await mkApp({ vendorId: vB, productId: pB, hostId: hB, owner: w.editor.userId });
    const r = await cl.vendA.call('GET', '/collaboration/applications/export?form=form1');
    expect(r.text).not.toContain(other);
  });

  it('後台設定 Mail 會出現在表單一匯出（欄位維持兩個：聯絡信箱與完成狀態）', async () => {
    const r = await cl.vendA.call('GET', '/collaboration/applications/export?form=form1');
    expect(r.text).toContain('shop@example.invalid');
    expect(r.text).toContain('已請廠商設定');
  });

  it('掃過所有讀取端點：團主與廠商回應裡都不得出現收件個資哨兵字串', async () => {
    const paths = [
      '/collaboration/overview', '/collaboration/applications?limit=200', `/collaboration/applications/${id}`,
      `/collaboration/applications/export?form=form1`, `/collaboration/applications/export?form=form2`,
      `/hosts/${hA}/collaboration-applications`, `/vendors/${vA}/collaboration-summary`, `/products/${pA}/collaboration-applications`,
      '/collaboration/applications?q=SENTINEL', `/collaboration/applications?q=${PII.phone}`, `/collaboration/applications?q=${encodeURIComponent(PII.address)}`,
      '/collaboration/imports', '/collaboration/import-rows', `/collaboration/applications/${id}/handovers`, '/collaboration/unassigned',
      `/campaigns`, '/audit', '/dashboard/host', '/notifications',
    ];
    for (const [who, c] of [['團主', cl.hostA], ['廠商', cl.vendA]] as const) {
      for (const p of paths) {
        const r = await c.call('GET', p);
        for (const leak of [PII.name, PII.phone, PII.address, PII.note]) expect(r.text, `${who} ${p} 洩漏 ${leak}`).not.toContain(leak);
      }
    }
  });

  it('廠商搜尋收件資料內容找不到任何案件（搜尋不是旁路）', async () => {
    for (const q of [PII.phone, PII.name, 'SENTINEL-地址']) {
      const r = await cl.vendA.call<{ items: unknown[] }>('GET', `/collaboration/applications?q=${encodeURIComponent(q)}`);
      expect(r.data.items.length).toBe(0);
    }
  });

  it('稽核紀錄與案件事件歷程不含收件個資內容（只記誰讀了、何時、什麼用途）', async () => {
    const audits = JSON.stringify(await query('SELECT before_data, after_data, reason FROM audit_logs WHERE organization_id=$1', [w.orgId]));
    const events = JSON.stringify(await query('SELECT note FROM collaboration_events WHERE organization_id=$1', [w.orgId]));
    for (const leak of [PII.name, PII.phone, PII.address, PII.note]) {
      expect(audits, `audit_logs 含 ${leak}`).not.toContain(leak);
      expect(events, `collaboration_events 含 ${leak}`).not.toContain(leak);
    }
  });

  it('跨組織：另一個組織的管理者對這個組織的廠商摘要得不到任何數字（不洩漏跨組織統計）', async () => {
    const r = await collab.vendorSummary(w2.admin, vA);
    expect(r).toMatchObject({ hostCount: 0, pendingReview: 0, shippedSamples: 0, confirmedCollaborations: 0, awaitingIntent: 0 });
  });
});

describe('D-44：CSV 公式注入（匯出端）', () => {
  it('團主顯示名稱以 = 開頭時，匯出檔不會被當成公式（補單引號）', async () => {
    const evil = (await mkHost(w, '=HYPERLINK("http://evil.invalid","x")')).id;
    const id = await mkApp({ hostId: evil, owner: w.editor.userId });
    for (const k of ['manager', 'editor'] as const) {
      for (const form of ['form1', 'form2']) {
        const r = await cl[k].call('GET', `/collaboration/applications/export?form=${form}`);
        const line = r.text.split('\r\n').find((l) => l.includes(id))!;
        expect(line, `${k} ${form}`).toContain(`"'=HYPERLINK(`);
        expect(line).not.toMatch(/(^|,)=HYPERLINK/);
      }
    }
  });
});

describe('D-44：匯入（惡意 CSV、公式注入、URL 安全、重複請求、去個資）', () => {
  const HEAD = '網紅名稱,收件人,聯繫電話,地址,申請樣品,配送日期,開團意願,備註,開團連結,後台連結,後台設定Mail';
  const goodRow = (extra: Record<string, string> = {}) => {
    const v = { host: '團主甲HARD', name: '匯入收件', phone: '0933000111', addr: '匯入地址 9 號', prod: '', ship: '2026/10/03', intent: '願意', note: '', url: 'https://example.invalid/g', portal: 'https://example.invalid/p', mail: 'm@example.invalid', ...extra };
    return `${v.host},${v.name},${v.phone},${v.addr},${v.prod},${v.ship},${v.intent},${v.note},${v.url},${v.portal},${v.mail}`;
  };

  it('含公式字元的列一律待人工確認（blocking），不會建立申請單', async () => {
    const csv = [HEAD, goodRow({ name: '=cmd|\' /C calc\'!A0', prod: '商品X', ship: '2026/10/04' })].join('\n');
    const r = await imp.previewImport(w.manager, { kind: 'FORM2_SAMPLE', vendorId: vA, csv });
    expect(r.rows[0].issues.map((i) => i.code)).toContain('FORMULA_INJECTION');
    expect(r.rows[0].resolution).toBe('NEEDS_REVIEW');
    const c = await imp.commitImport(w.manager, r.batchId);
    expect(c.created).toBe(0);
  });

  it('電話 +886… 與一般內容不被誤判為公式', async () => {
    const csv = [HEAD, goodRow({ phone: '+886933000222', prod: '商品Y', ship: '2026/10/05' })].join('\n');
    const r = await imp.previewImport(w.manager, { kind: 'FORM2_SAMPLE', vendorId: vA, csv });
    expect(r.rows[0].issues.map((i) => i.code)).not.toContain('FORMULA_INJECTION');
  });

  it('匯入錯誤紀錄（import_errors.raw_row）不留收件人、電話、地址', async () => {
    const csv = [HEAD, goodRow({ host: '查無此人HARD', name: 'SENTINEL-匯入錯誤姓名', phone: '0944555666', addr: 'SENTINEL-匯入錯誤地址', prod: '商品Z', ship: '2026/10/06' })].join('\n');
    const r = await imp.previewImport(w.manager, { kind: 'FORM2_SAMPLE', vendorId: vA, csv });
    const errRows = await query<{ code: string }>('SELECT code, raw_row FROM import_errors WHERE batch_id=$1', [r.batchId]);
    expect(errRows.map((e) => e.code)).toContain('HOST_NOT_FOUND');
    const errs = JSON.stringify(errRows);
    for (const leak of ['SENTINEL-匯入錯誤姓名', '0944555666', 'SENTINEL-匯入錯誤地址']) expect(errs).not.toContain(leak);
  });

  it('建立申請單後，匯入暫存列的個資立即清除；收件資料本體只在 collaboration_recipients', async () => {
    const p = (await mkProduct(w, vA, { approve: true, name: '匯入商品HARD' })).id;
    const csv = [HEAD, goodRow({ name: 'SENTINEL-暫存姓名', phone: '0955777888', addr: 'SENTINEL-暫存地址', prod: '匯入商品HARD', ship: '2026/10/07' })].join('\n');
    const prev = await imp.previewImport(w.manager, { kind: 'FORM2_SAMPLE', vendorId: vA, csv });
    expect(prev.rows[0].resolution).toBe('RESOLVED');
    const staged = JSON.stringify(await query('SELECT raw FROM collaboration_import_rows WHERE batch_id=$1', [prev.batchId]));
    expect(staged).toContain('SENTINEL-暫存姓名');        // 還沒 commit 之前需要它來建收件資料
    const c = await imp.commitImport(w.manager, prev.batchId);
    expect(c.created).toBe(1);
    const after = JSON.stringify(await query('SELECT raw, pii_scrubbed_at FROM collaboration_import_rows WHERE batch_id=$1', [prev.batchId]));
    for (const leak of ['SENTINEL-暫存姓名', '0955777888', 'SENTINEL-暫存地址']) expect(after).not.toContain(leak);
    expect(after).not.toContain('"pii_scrubbed_at":null');
    const rec = await recipientRow(c.applicationIds[0]);
    expect(rec[0].recipient_name).toBe('SENTINEL-暫存姓名');
    expect(p).toBeTruthy();
  });

  it('不安全的連結、錯誤的 Email、含電話的備註不會被保存（只列提示，不阻擋整列）', async () => {
    await mkProduct(w, vA, { approve: true, name: '匯入商品URL' });
    const csv = [HEAD, goodRow({ prod: '匯入商品URL', ship: '2026/10/08', url: 'javascript:alert(1)', portal: 'https://u:p@example.invalid/', mail: 'not-an-email', note: '請打 0912345678' })].join('\n');
    const prev = await imp.previewImport(w.manager, { kind: 'FORM2_SAMPLE', vendorId: vA, csv });
    expect(prev.rows[0].issues.map((i) => i.code)).toEqual(expect.arrayContaining(['URL_UNSAFE', 'NOTE_HAS_PII']));
    const c = await imp.commitImport(w.manager, prev.batchId);
    const d = await collab.getApplication(w.manager, c.applicationIds[0]);
    const launch = d.launch as Record<string, unknown>;
    expect(launch.launchUrl).toBeNull();
    expect(launch.vendorPortalUrl).toBeNull();
    expect(d.note ?? null).toBeNull();
  });

  it('表單一的後台設定 Mail 格式不正確會被標示且不保存', async () => {
    const csv = ['團購主,後台設定Mail,開團連結', '團主甲HARD,not-an-email,javascript:alert(1)'].join('\n');
    const prev = await imp.previewImport(w.manager, { kind: 'FORM1_LAUNCH', vendorId: vA, csv });
    expect(prev.rows[0].issues.map((i) => i.code)).toEqual(expect.arrayContaining(['EMAIL_INVALID', 'URL_UNSAFE']));
    const c = await imp.commitImport(w.manager, prev.batchId);
    const d = await collab.getApplication(w.manager, c.applicationIds[0]);
    expect((d.launch as Record<string, unknown>).backendSetupEmail).toBeNull();
    expect((d.launch as Record<string, unknown>).launchUrl).toBeNull();
  });

  it('同一份檔案重複送出＝409；重複 commit 不會重複建立', async () => {
    await mkProduct(w, vA, { approve: true, name: '匯入商品DUP' });
    const csv = [HEAD, goodRow({ prod: '匯入商品DUP', ship: '2026/10/09' })].join('\n');
    const a = await cl.manager.call<{ batchId: string }>('POST', '/collaboration/imports/preview', { kind: 'FORM2_SAMPLE', vendorId: vA, csv });
    expect(a.status).toBe(201);
    expect((await cl.manager.call('POST', '/collaboration/imports/preview', { kind: 'FORM2_SAMPLE', vendorId: vA, csv })).status).toBe(409);
    const [c1, c2] = await Promise.all([
      cl.manager.call<{ created: number }>('POST', `/collaboration/imports/${a.data.batchId}/commit`),
      cl.manager.call<{ created: number }>('POST', `/collaboration/imports/${a.data.batchId}/commit`),
    ]);
    expect([c1.status, c2.status]).toEqual([200, 200]);
    expect(c1.data.created + c2.data.created).toBe(1);
  });

  it('小編匯入的案件由自己承辦；主管匯入的案件進待指派佇列', async () => {
    await mkProduct(w, vA, { approve: true, name: '匯入商品OWN' });
    const mk = async (by: Client, ship: string) => {
      const csv = [HEAD, goodRow({ prod: '匯入商品OWN', ship })].join('\n');
      const p = await by.call<{ batchId: string }>('POST', '/collaboration/imports/preview', { kind: 'FORM2_SAMPLE', vendorId: vA, csv });
      const c = await by.call<{ applicationIds: string[] }>('POST', `/collaboration/imports/${p.data.batchId}/commit`);
      return c.data.applicationIds[0];
    };
    const byEditor = await mk(cl.editor, '2026/09/10');
    const byManager = await mk(cl.manager, '2026/09/11');
    expect((await cl.editor.call('GET', `/collaboration/applications/${byEditor}`)).status).toBe(200);
    expect((await cl.editor2.call('GET', `/collaboration/applications/${byManager}`)).status).toBe(404);
    const q = await cl.manager.call<{ items: { id: string }[] }>('GET', '/collaboration/unassigned?limit=200');
    expect(q.data.items.map((x) => x.id)).toContain(byManager);
  });
});

describe('D-44：URL 安全（廠商後台與開團連結）', () => {
  it('連結內嵌帳號密碼或非 http(s) 一律拒絕', async () => {
    const id = await mkApp({ owner: w.editor.userId });
    await approve(id);
    for (const bad of ['javascript:alert(1)', 'https://user:pw@example.invalid/', 'ftp://example.invalid']) {
      const v = await cl.vendA.call('PUT', `/collaboration/applications/${id}/vendor-launch`, { vendorPortalUrl: bad });
      expect(v.status, bad).toBe(422);
      const h = await cl.hostA.call('PUT', `/collaboration/applications/${id}/launch`, { launchUrl: bad });
      expect(h.status, bad).toBe(422);
    }
  });
});

describe('D-44：401／403／404、CSRF、限流、權限變更立即失效', () => {
  const sensitive: [string, string][] = [
    ['GET', '/collaboration/applications'], ['GET', '/collaboration/overview'], ['GET', '/collaboration/applications/export'],
    ['GET', '/collaboration/unassigned'], ['GET', '/collaboration/retention/status'], ['POST', '/collaboration/recipients/purge-expired'],
    ['GET', '/collaboration/applications/CLB-000001/recipient'],
  ];

  it('未登入＝401（每一條敏感端點）', async () => {
    const anon = new Client();
    for (const [m, p] of sensitive) expect((await anon.call(m, p, m === 'POST' ? {} : undefined)).status, `${m} ${p}`).toBe(401);
  });

  it('無權限＝403：廠商與團主不能碰承辦、保留與清除端點', async () => {
    for (const c of [cl.vendA, cl.hostA]) {
      for (const [m, p] of [['GET', '/collaboration/unassigned'], ['GET', '/collaboration/retention/status'], ['GET', '/collaboration/retention/runs'], ['POST', '/collaboration/recipients/purge-expired'], ['POST', '/collaboration/assignments/reassign']] as const) {
        const r = await c.call(m, p, m === 'POST' ? {} : undefined);
        expect([403], `${m} ${p}`).toContain(r.status);
      }
    }
    for (const [m, p] of [['GET', '/collaboration/retention/status'], ['POST', '/collaboration/recipients/purge-expired'], ['POST', '/collaboration/assignments/reassign']] as const) {
      expect([403], `editor ${m} ${p}`).toContain((await cl.editor.call(m, p, m === 'POST' ? {} : undefined)).status);
    }
  });

  it('跨廠商／跨團主／跨組織＝404，且與不存在的 id 回應一致', async () => {
    const id = await mkApp({ vendorId: vB, productId: pB, hostId: hB, owner: w.editor.userId });
    const fakes = (suffix: string) => `/collaboration/applications/CLB-999999${suffix}`;
    for (const suffix of ['', '/recipient', '/handovers']) {
      const real = await cl.vendA.call('GET', `/collaboration/applications/${id}${suffix}`);
      const fake = await cl.vendA.call('GET', fakes(suffix));
      expect(real.status, suffix).toBe(fake.status);
      expect(real.error?.code).toBe(fake.error?.code);
    }
    const foreign = await collab.createApplication(w2.manager, { vendorId: (await mkVendor(w2, '別組織廠商HARD')).id, hostId: (await mkHost(w2, '別組織團主HARD')).id, items: [{ productId: (await mkProduct(w2, (await query<{ id: string }>('SELECT id FROM vendors WHERE organization_id=$1 LIMIT 1', [w2.orgId]))[0].id, { approve: true })).id }] });
    expect((await cl.admin.call('GET', `/collaboration/applications/${foreign.id}`)).status).toBe(404);
    expect((await cl.admin.call('POST', `/collaboration/applications/${foreign.id}/assign`, { userId: w.editor.userId })).status).toBe(404);
    expect((await cl.admin.call('POST', `/collaboration/applications/${foreign.id}/retention-holds`, { reasonCode: 'DISPUTE', basis: '跨組織測試依據文字十個字以上', holdUntil: dayOffset(30) })).status).toBe(404);
  });

  it('CSRF：跨來源的寫入請求被擋（Origin 與 Host 不符），同源與非瀏覽器客戶端可通過', async () => {
    const id = await mkApp({ owner: w.editor.userId });
    const evil = await cl.manager.call('POST', `/collaboration/applications/${id}/hold`, { reason: '跨站' }, { origin: 'https://evil.invalid', host: 'localhost:3000' });
    expect(evil.status).toBe(403);
    const cur = await query<{ status: string }>('SELECT status FROM collaboration_applications WHERE id=$1', [id]);
    expect(cur[0].status).toBe('DRAFT');
    const same = await cl.manager.call('POST', `/collaboration/applications/${id}/submit`, undefined, { origin: 'http://localhost:3000', host: 'localhost:3000' });
    expect(same.status).toBe(200);
  });

  it('Session：登出後 token 立即失效；Cookie 屬性為 HttpOnly、SameSite', async () => {
    const c = new Client(cl.vendA.email);
    const login = await c.call('POST', '/auth/login', { email: c.email, password: 'Test-Password-123' });
    const set = login.headers.get('set-cookie') ?? '';
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=(Lax|Strict)/i);
    expect((await c.call('GET', '/collaboration/overview')).status).toBe(200);
    await c.call('POST', '/auth/logout', {});
    const stale = new Client();
    stale.cookie = set.split(';')[0];
    expect((await stale.call('GET', '/collaboration/overview')).status).toBe(401);
  });

  it('限流：個資讀取、匯出、匯入都有上限，超過回 429 且不寫入', async () => {
    const vclient = await Client.forActor(vendA);   // 登入會重置限流計數
    const id = await mkApp({ owner: w.editor.userId });
    await approve(id);
    await collab.addShipment(w.editor, id, { shipmentType: 'INITIAL' });
    let got429 = false;
    for (let i = 0; i < 70 && !got429; i++) got429 = (await vclient.call('GET', `/collaboration/applications/${id}/recipient`)).status === 429;
    expect(got429, '連續讀取個資 70 次應該被限流').toBe(true);
    const mclient = await Client.forActor(w.manager);
    let exp429 = false;
    for (let i = 0; i < 15 && !exp429; i++) exp429 = (await mclient.call('GET', '/collaboration/applications/export?form=form1')).status === 429;
    expect(exp429, '連續匯出 15 次應該被限流').toBe(true);
    let imp429 = false;
    for (let i = 0; i < 15 && !imp429; i++) imp429 = (await mclient.call('POST', '/collaboration/imports/preview', { kind: 'FORM2_SAMPLE', vendorId: vA, csv: `網紅名稱\n限流${i}` })).status === 429;
    expect(imp429, '連續匯入 15 次應該被限流').toBe(true);
  });

  it('權限變更後立即失效：撤銷廠商範圍、停用帳號、降級角色，下一個請求就生效（不必重新登入）', async () => {
    const id = await mkApp({ owner: w.editor.userId });
    await approve(id);
    await collab.addShipment(w.editor, id, { shipmentType: 'INITIAL' });
    const vu = await addUser(w.orgId, 'VENDOR', { vendorIds: [vA] });
    const c = await Client.forActor(vu);
    expect((await c.call('GET', `/collaboration/applications/${id}/recipient`)).status).toBe(200);
    // 1. 撤銷廠商範圍
    await query(`UPDATE user_scopes SET revoked_at=now() WHERE user_id=$1 AND scope_type='VENDOR'`, [vu.userId]);
    expect((await c.call('GET', `/collaboration/applications/${id}/recipient`)).status).toBe(404);
    expect((await c.call<{ items: unknown[] }>('GET', '/collaboration/applications')).data.items.length).toBe(0);
    await query(`UPDATE user_scopes SET revoked_at=NULL WHERE user_id=$1 AND scope_type='VENDOR'`, [vu.userId]);
    expect((await c.call('GET', `/collaboration/applications/${id}/recipient`)).status).toBe(200);
    // 2. 內部承辦被移除 → 小編立即看不到
    const ec = await Client.forActor(w.editor);
    expect((await ec.call('GET', `/collaboration/applications/${id}`)).status).toBe(200);
    await assign.assignApplication(w.manager, id, { userId: w.editor2.userId as string, reason: '權限即時性測試' });
    expect((await ec.call('GET', `/collaboration/applications/${id}`)).status).toBe(404);
    // 3. 角色降級（營運小編 → 財務）→ 立即失去合作模組權限
    const demoted = await addUser(w.orgId, 'OPS_EDITOR');
    const dc = await Client.forActor(demoted);
    expect((await dc.call('GET', '/collaboration/overview')).status).toBe(200);
    await query(`UPDATE users SET role_key='FINANCE' WHERE id=$1`, [demoted.userId]);
    expect((await dc.call('GET', '/collaboration/overview')).status).toBe(403);
    // 4. 停用帳號 → 401
    await setUserStatus(w.admin, vu.userId as string, 'DISABLED');
    expect((await c.call('GET', `/collaboration/applications/${id}/recipient`)).status).toBe(401);
  });
});

// ================================================================= D-40
describe('D-40：個資清除機制（保留例外、履約未結束延後、硬性上限、紀錄與失敗）', () => {
  /** 建立一筆已核准、已有確認收件資料的案件；retention 設為已過期，方便觸發清除 */
  async function expired(opts: { shipments?: 'none' | 'delivered' | 'delivered+resend' | 'shipped' } = {}) {
    const id = await mkApp({ owner: w.editor.userId });
    await approve(id);
    if (opts.shipments && opts.shipments !== 'none') {
      const s = await collab.addShipment(w.editor, id, { shipmentType: 'INITIAL', shipDate: dayOffset(-60) });
      if (opts.shipments !== 'shipped') await collab.confirmReceipt(hostA, s.id, { receivedOn: dayOffset(-55) });
      if (opts.shipments === 'delivered+resend') await collab.addShipment(w.editor, id, { shipmentType: 'RESEND' });
    }
    await query('UPDATE collaboration_recipients SET retention_until=$2 WHERE application_id=$1 AND deleted_at IS NULL', [id, dayOffset(-3)]);
    return id;
  }
  const items = async (runId: number) => query<{ application_id: string; outcome: string; detail: string | null }>('SELECT application_id, outcome, detail FROM collaboration_purge_items WHERE run_id=$1', [runId]);
  const contentOf = async (id: string) => (await recipientRow(id)).find((r) => r.deleted_at === null) as Record<string, unknown>;

  it('履約已完成且過保留期 → 清除；內容真的不見，留下清除紀錄與稽核', async () => {
    const id = await expired({ shipments: 'delivered' });
    const r = await retention.runRecipientPurge(w.admin);
    expect((await items(r.runId)).find((x) => x.application_id === id)?.outcome).toBe('PURGED');
    const row = await contentOf(id);
    expect(row.purged_at).not.toBeNull();
    expect(JSON.stringify(row)).not.toMatch(/SENTINEL-收件人-HARD|0900123456|SENTINEL-地址-HARD/);
    const au = await query(`SELECT 1 FROM audit_logs WHERE organization_id=$1 AND action='collaboration.recipient.purge' AND entity_id=$2`, [w.orgId, row.id]);
    expect(au.length).toBe(1);
    const run = await query<{ status: string; finished_at: Date | null }>('SELECT status, finished_at FROM collaboration_purge_runs WHERE id=$1', [r.runId]);
    expect(run[0].status).toBe('SUCCEEDED');
    expect(run[0].finished_at).not.toBeNull();
  });

  it('補寄尚未寄出／首次尚未寄出／已寄出未收件：到期也不清除（延後），個資保留給履約', async () => {
    const ids = [await expired({ shipments: 'delivered+resend' }), await expired({ shipments: 'none' }), await expired({ shipments: 'shipped' })];
    const r = await retention.runRecipientPurge(w.admin);
    const out = await items(r.runId);
    for (const id of ids) {
      expect(out.find((x) => x.application_id === id)?.outcome, id).toBe('SKIPPED_FULFILMENT');
      expect((await contentOf(id)).purged_at).toBeNull();
    }
    expect(r.skippedFulfilment).toBeGreaterThanOrEqual(3);
  });

  it('保留例外（爭議）：阻止清除並寫稽核；到期日有上限、必須有依據、依據不得含個資、小編不能設定', async () => {
    const id = await expired({ shipments: 'delivered' });
    expect((await cl.editor.call('POST', `/collaboration/applications/${id}/retention-holds`, { reasonCode: 'DISPUTE', basis: '客訴案號 X-1 處理中', holdUntil: dayOffset(30) })).status).toBe(403);
    expect((await cl.manager.call('POST', `/collaboration/applications/${id}/retention-holds`, { reasonCode: 'DISPUTE', basis: '太短', holdUntil: dayOffset(30) })).status).toBe(422);
    expect((await cl.manager.call('POST', `/collaboration/applications/${id}/retention-holds`, { reasonCode: 'DISPUTE', basis: '客訴案號 X-1 處理中', holdUntil: dayOffset(366) })).status).toBe(422);
    expect((await cl.manager.call('POST', `/collaboration/applications/${id}/retention-holds`, { reasonCode: 'DISPUTE', basis: '請打 0912345678 詢問依據', holdUntil: dayOffset(30) })).status).toBe(422);
    expect((await cl.manager.call('POST', `/collaboration/applications/${id}/retention-holds`, { reasonCode: 'DISPUTE', basis: '客訴案號 X-1 處理中', holdUntil: dayOffset(-1) })).status).toBe(422);
    const ok = await cl.manager.call<{ id: string }>('POST', `/collaboration/applications/${id}/retention-holds`, { reasonCode: 'DISPUTE', basis: '客訴案號 X-1 處理中', holdUntil: dayOffset(365) });
    expect(ok.status).toBe(201);
    const r1 = await retention.runRecipientPurge(w.admin);
    expect((await items(r1.runId)).find((x) => x.application_id === id)?.outcome).toBe('SKIPPED_HOLD');
    expect((await contentOf(id)).purged_at).toBeNull();
    // 資料庫也擋超過 365 天的例外（不只服務層）
    await expect(query(`INSERT INTO collaboration_retention_holds (id, organization_id, application_id, reason_code, basis, placed_on, hold_until, placed_by)
      VALUES ('CRH-TOOLONG', $1, $2, 'DISPUTE', '資料庫約束測試依據', current_date, current_date + 400, 'x')`, [w.orgId, id])).rejects.toThrow();
    // 解除後恢復清除
    expect((await cl.manager.call('POST', `/collaboration/retention-holds/${ok.data.id}/release`, { reason: '爭議結案' })).status).toBe(200);
    expect((await cl.manager.call('POST', `/collaboration/retention-holds/${ok.data.id}/release`, { reason: '重複' })).status).toBe(409);
    const r2 = await retention.runRecipientPurge(w.admin);
    expect((await items(r2.runId)).find((x) => x.application_id === id)?.outcome).toBe('PURGED');
    const hold = await query('SELECT 1 FROM audit_logs WHERE organization_id=$1 AND action IN (\'collaboration.retention.hold\',\'collaboration.retention.release\')', [w.orgId]);
    expect(hold.length).toBeGreaterThanOrEqual(2);
  });

  it('保留例外到期自動失效（不會無限期保留）', async () => {
    const id = await expired({ shipments: 'delivered' });
    const h = await cl.manager.call<{ id: string }>('POST', `/collaboration/applications/${id}/retention-holds`, { reasonCode: 'LEGAL_OBLIGATION', basis: '法務保存需求編號 L-7', holdUntil: dayOffset(10) });
    await query('UPDATE collaboration_retention_holds SET placed_on = placed_on - 40, hold_until = current_date - 1 WHERE id=$1', [h.data.id]);
    const r = await retention.runRecipientPurge(w.admin);
    expect((await items(r.runId)).find((x) => x.application_id === id)?.outcome).toBe('PURGED');
  });

  it('硬性上限：核准後超過 180 天，履約未結束也強制清除並標示 PURGED_HARD_CAP', async () => {
    const id = await expired({ shipments: 'delivered+resend' });
    await query(`UPDATE collaboration_applications SET decided_at = now() - interval '200 days' WHERE id=$1`, [id]);
    const r = await retention.runRecipientPurge(w.admin);
    expect((await items(r.runId)).find((x) => x.application_id === id)?.outcome).toBe('PURGED_HARD_CAP');
    expect(r.forcedByCap).toBeGreaterThanOrEqual(1);
    expect((await contentOf(id)).purged_at).not.toBeNull();
  });

  it('試跑（dry run）：只列出會清除的項目，不改任何資料', async () => {
    const id = await expired({ shipments: 'delivered' });
    const r = await retention.runRecipientPurge(w.manager, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect((await items(r.runId)).find((x) => x.application_id === id)?.outcome).toBe('WOULD_PURGE');
    expect((await contentOf(id)).purged_at).toBeNull();
    // 非試跑只有管理者可以執行
    await expect(retention.runRecipientPurge(w.manager)).rejects.toThrow();
    expect((await cl.manager.call('POST', '/collaboration/recipients/purge-expired', {})).status).toBe(403);
  });

  it('單筆失敗不會讓整批回滾，也不會被吞掉：記為 FAILED，整體為 PARTIAL，健康狀態出現警示', async () => {
    const bad = await expired({ shipments: 'delivered' });
    const good = await expired({ shipments: 'delivered' });
    const badRec = (await contentOf(bad)).id as string;
    await query(`CREATE OR REPLACE FUNCTION test_fail_purge() RETURNS trigger AS $$ BEGIN IF OLD.id = '${badRec}' THEN RAISE EXCEPTION 'purge boom'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await query(`CREATE TRIGGER test_fail_purge_trg BEFORE UPDATE ON collaboration_recipients FOR EACH ROW EXECUTE FUNCTION test_fail_purge()`);
    try {
      const r = await retention.runRecipientPurge(w.admin);
      expect(r.status).toBe('PARTIAL');
      expect(r.failed).toBeGreaterThanOrEqual(1);
      const out = await items(r.runId);
      expect(out.find((x) => x.application_id === bad)?.outcome).toBe('FAILED');
      expect(out.find((x) => x.application_id === good)?.outcome).toBe('PURGED');
      expect((await contentOf(good)).purged_at).not.toBeNull();
      expect((await contentOf(bad)).purged_at).toBeNull();
      const st = await cl.manager.call<{ alerts: string[]; lastRun: { status: string } }>('GET', '/collaboration/retention/status');
      expect(st.data.alerts).toContain('LAST_RUN_FAILED');
      expect(st.data.lastRun.status).toBe('PARTIAL');
    } finally {
      await query('DROP TRIGGER test_fail_purge_trg ON collaboration_recipients');
      await query('DROP FUNCTION test_fail_purge()');
    }
    const r2 = await retention.runRecipientPurge(w.admin);
    expect(r2.status).toBe('SUCCEEDED');
    expect((await contentOf(bad)).purged_at).not.toBeNull();
  });

  it('改地址時，被取代的舊地址立即清空內容（不是只軟刪除而永遠留在資料庫）', async () => {
    const id = await mkApp({ owner: w.editor.userId });
    await approve(id);
    await collab.putRecipient(hostA, id, { recipientName: 'SENTINEL-新收件人', recipientPhone: '0900999888', addressLine: 'SENTINEL-新地址', confirm: true });
    const rows = await recipientRow(id);
    expect(rows.length).toBe(2);
    const old = rows.find((r) => r.deleted_at !== null)!;
    expect(old.purged_at).not.toBeNull();
    expect(JSON.stringify(old)).not.toMatch(/SENTINEL-收件人-HARD|0900123456|SENTINEL-地址-HARD/);
    // 全表掃描：任何已清除或已刪除的列都不含原始個資
    const dead = JSON.stringify(await query('SELECT recipient_name, recipient_phone, address_line, delivery_note FROM collaboration_recipients WHERE purged_at IS NOT NULL OR deleted_at IS NOT NULL'));
    expect(dead).not.toMatch(/SENTINEL-收件人-HARD|0900123456|SENTINEL-地址-HARD/);
  });

  it('舊版遺留（軟刪除但內容還在）的收件資料，下一次清除一定會處理掉', async () => {
    const id = await mkApp({ owner: w.editor.userId });
    await approve(id);
    const rec = await contentOf(id);
    await query(`INSERT INTO collaboration_recipients (id, organization_id, application_id, recipient_name, recipient_phone, address_line, deleted_at)
      VALUES ('CRP-LEGACY1', $1, $2, 'SENTINEL-遺留姓名', '0900111000', 'SENTINEL-遺留地址', now())`, [w.orgId, id]);
    const r = await retention.runRecipientPurge(w.admin);
    expect((await items(r.runId)).find((x) => x.application_id === id && x.outcome === 'PURGED')).toBeTruthy();
    const dump = JSON.stringify(await query(`SELECT * FROM collaboration_recipients WHERE id='CRP-LEGACY1'`));
    expect(dump).not.toContain('SENTINEL-遺留');
    expect(rec).toBeTruthy();
  });

  it('逾期未處理的匯入暫存列（含原始個資）由清除作業清掉', async () => {
    const csv = ['網紅名稱,收件人,聯繫電話,地址,申請樣品', '查無此人STALE,SENTINEL-逾期姓名,0900222333,SENTINEL-逾期地址,商品STALE'].join('\n');
    const prev = await imp.previewImport(w.manager, { kind: 'FORM2_SAMPLE', vendorId: vA, csv });
    expect(JSON.stringify(await query('SELECT raw FROM collaboration_import_rows WHERE batch_id=$1', [prev.batchId]))).toContain('SENTINEL-逾期姓名');
    await query(`UPDATE collaboration_import_rows SET created_at = now() - interval '40 days' WHERE batch_id=$1`, [prev.batchId]);
    const r = await retention.runRecipientPurge(w.admin);
    expect(r.stagingScrubbed).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(await query('SELECT raw FROM collaboration_import_rows WHERE batch_id=$1', [prev.batchId]))).not.toContain('SENTINEL-逾期姓名');
    expect(JSON.stringify(await query('SELECT raw_row FROM import_errors WHERE batch_id=$1', [prev.batchId]))).not.toContain('SENTINEL-逾期姓名');
  });

  it('監控：從未執行但已有到期資料 → NEVER_RUN／逾期積壓警示；本系統沒有排程', async () => {
    const w3 = await makeWorld();
    const v = (await mkVendor(w3)).id; const p = (await mkProduct(w3, v, { approve: true })).id; const h = (await mkHost(w3)).id;
    const hu = await addUser(w3.orgId, 'HOST', { hostIds: [h] });
    const id = (await collab.createApplication(w3.manager, { vendorId: v, hostId: h, items: [{ productId: p }] })).id;
    await collab.submitApplication(w3.manager, id);
    await collab.internalReview(w3.manager, id, { decision: 'APPROVE' });
    await collab.putRecipient(hu, id, { recipientName: 'x', recipientPhone: '0900', addressLine: 'y', confirm: true });
    await query('UPDATE collaboration_recipients SET retention_until=$2 WHERE application_id=$1', [id, dayOffset(-20)]);
    const st = await retention.retentionStatus(w3.manager);
    expect(st.alerts).toEqual(expect.arrayContaining(['NEVER_RUN', 'OVERDUE_BACKLOG']));
    expect(st.scheduler.enabled).toBe(false);
    expect(await query('SELECT 1 FROM automation_settings WHERE job_key ILIKE \'%collab%\' OR job_key ILIKE \'%purge%\'')).toEqual([]);
  });
});

describe('D-41／D-42：後台設定維持兩欄、不寄信；不改既有 tasks 的 Campaign 綁定', () => {
  it('後台設定只有「聯絡信箱」與「完成狀態」兩個欄位，且更新不產生任何通知', async () => {
    const cols = await query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name='collaboration_launch_details' AND column_name LIKE 'backend_setup%' ORDER BY column_name`);
    expect(cols.map((c) => c.column_name)).toEqual(['backend_setup_email', 'backend_setup_note', 'backend_setup_status']);
    const before = (await query<{ n: number }>('SELECT count(*)::int AS n FROM notifications'))[0].n;
    const id = await mkApp({ owner: w.editor.userId });
    await approve(id);
    await collab.putVendorLaunch(vendA, id, { backendSetupEmail: 'shop@example.invalid', backendSetupStatus: 'DONE' });
    expect((await query<{ n: number }>('SELECT count(*)::int AS n FROM notifications'))[0].n).toBe(before);
  });

  it('tasks.campaign_id 仍為 NOT NULL；合作模組沒有新增任何任務', async () => {
    const col = await query<{ is_nullable: string }>(`SELECT is_nullable FROM information_schema.columns WHERE table_name='tasks' AND column_name='campaign_id'`);
    expect(col[0].is_nullable).toBe('NO');
    const refs = await query(`SELECT 1 FROM information_schema.columns WHERE table_name LIKE 'collaboration_%' AND column_name='task_id'`);
    expect(refs.length).toBe(0);
  });
});

void pool;

describe('D-40：沒有任何排程；清除腳本在正式環境預設拒絕', () => {
  it('worker／自動化模組／workflow 都沒有串接合作申請清除（沒有 cron、沒有 production worker）', () => {
    const files = ['scripts/worker.ts', 'src/server/modules/automation.ts', ...fs.readdirSync('.github/workflows').map((f) => `.github/workflows/${f}`), 'docker-compose.prod.yml', 'render.yaml'];
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      expect(text, `${f} 不應排程合作申請清除`).not.toMatch(/collab:purge|collaboration-purge|runRecipientPurge|purge-expired/);
    }
  });

  it('APP_ENV=production 時腳本直接拒絕（exit 2），不連資料庫；只有明確授權變數才放行', () => {
    const run = () => spawnSync('npx', ['tsx', 'scripts/collaboration-purge.ts'], {
      env: { ...process.env, APP_ENV: 'production', DATABASE_URL: 'postgres://nobody:none@127.0.0.1:1/none', COLLABORATION_PURGE_PRODUCTION_AUTHORIZED: '' },
      encoding: 'utf8', timeout: 60_000,
    });
    const r = run();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('拒絕執行');
  });
});
