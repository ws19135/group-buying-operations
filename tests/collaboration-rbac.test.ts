import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import type { Actor } from '@/server/lib/permissions';
import { ROLE_PERMISSIONS, roleCan } from '@/server/lib/permissions';
import * as collab from '@/server/modules/collaboration';
import * as gates from '@/server/modules/gates';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkCampaign, mkHost, mkProduct, mkVendor, type World } from './helpers';

/**
 * 合作申請與樣品管理：授權、個資與越權的獨立審查。
 * 每一條都在後端驗證——前端隱藏按鈕不算，所以全部打服務層與真實 API。
 */

/** 哨兵字串：只要在不該出現的回應或 CSV 裡看到它，就是洩漏 */
const PII = {
  name: 'SENTINEL-收件人-ABC',
  phone: '0900111222',
  address: 'SENTINEL-地址-台北市某路 9 號',
  note: 'SENTINEL-到貨備註',
};

let w: World, w2: World;
let vA: string, vB: string, hA: string, hB: string, pA: string, pB: string;
let hostA: Actor, hostB: Actor, vendA: Actor, vendB: Actor;
let appA: string;      // 團主甲 × 廠商甲，已核准、已填收件、已寄出
let appB: string;      // 團主乙 × 廠商乙
let shipA: string;
let crossOrgApp: string;
let cl: Record<string, Client>;

beforeAll(async () => {
  w = await makeWorld();
  w2 = await makeWorld();
  vA = (await mkVendor(w, '廠商甲RBAC')).id;
  vB = (await mkVendor(w, '廠商乙RBAC')).id;
  pA = (await mkProduct(w, vA, { approve: true })).id;
  pB = (await mkProduct(w, vB, { approve: true })).id;
  hA = (await mkHost(w, '團主甲RBAC')).id;
  hB = (await mkHost(w, '團主乙RBAC')).id;
  hostA = await addUser(w.orgId, 'HOST', { hostIds: [hA] });
  hostB = await addUser(w.orgId, 'HOST', { hostIds: [hB] });
  vendA = await addUser(w.orgId, 'VENDOR', { vendorIds: [vA] });
  vendB = await addUser(w.orgId, 'VENDOR', { vendorIds: [vB] });

  appA = (await collab.createApplication(w.manager, { ownerUserId: w.editor.userId, vendorId: vA, hostId: hA, items: [{ productId: pA, requestedQty: 1 }] })).id;
  await collab.submitApplication(w.manager, appA);
  await collab.internalReview(w.manager, appA, { decision: 'APPROVE' });
  await collab.putRecipient(hostA, appA, {
    recipientName: PII.name, recipientPhone: PII.phone, addressLine: PII.address, deliveryNote: PII.note, confirm: true,
  });
  shipA = (await collab.addShipment(w.editor, appA, { shipmentType: 'INITIAL', shipDate: dayOffset(-2) })).id;

  appB = (await collab.createApplication(w.manager, { ownerUserId: w.editor.userId, vendorId: vB, hostId: hB, items: [{ productId: pB }] })).id;

  // 另一個組織的同類資料：任何角色都不該看見
  const v2 = (await mkVendor(w2, '別組織廠商')).id;
  const p2 = (await mkProduct(w2, v2, { approve: true })).id;
  const h2 = (await mkHost(w2, '別組織團主')).id;
  crossOrgApp = (await collab.createApplication(w2.manager, { vendorId: v2, hostId: h2, items: [{ productId: p2 }] })).id;

  cl = {};
  for (const k of ['admin', 'manager', 'editor', 'finance'] as const) cl[k] = await Client.forActor(w[k]);
  cl.hostA = await Client.forActor(hostA);
  cl.hostB = await Client.forActor(hostB);
  cl.vendA = await Client.forActor(vendA);
  cl.vendB = await Client.forActor(vendB);
});

describe('角色矩陣：沒有第七種角色，財務第一階段完全不開放', () => {
  it('只用既有六種角色；本模組沒有新增角色', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort())
      .toEqual(['FINANCE', 'HOST', 'OPS_EDITOR', 'OPS_MANAGER', 'SYSTEM_ADMIN', 'VENDOR']);
  });

  it('FINANCE 沒有任何 collaboration 權限，也拿不到收件個資', () => {
    expect(ROLE_PERMISSIONS.FINANCE.filter((p) => p.startsWith('collaboration.'))).toEqual([]);
    expect(roleCan('FINANCE', 'collaboration.pii.read')).toBe(false);
  });

  it('FINANCE 打本模組的 API 一律被拒，列表也看不到任何一筆', async () => {
    const list = await cl.finance.call('GET', '/collaboration/applications');
    expect(list.status).toBe(403);
    for (const [m, p] of [['GET', `/collaboration/applications/${appA}`], ['GET', `/collaboration/applications/${appA}/recipient`],
      ['GET', '/collaboration/applications/export'], ['POST', '/collaboration/applications']] as const) {
      const r = await cl.finance.call(m, p, m === 'POST' ? { vendorId: vA, hostId: hA, items: [{ productId: pA }] } : undefined);
      expect([403, 404]).toContain(r.status);
    }
  });

  it('營運小編（OPS_EDITOR）不可代替主管做需核准權限的決策', () => {
    expect(roleCan('OPS_EDITOR', 'collaboration.update')).toBe(true);
    expect(roleCan('OPS_EDITOR', 'collaboration.review')).toBe(false);
  });

  it('OPS_EDITOR 呼叫內部審核／確認合作／結案都被拒', async () => {
    await expect(collab.internalReview(w.editor, appB, { decision: 'APPROVE' })).rejects.toThrow();
    await expect(collab.confirmCollaboration(w.editor, appA, {})).rejects.toThrow();
    await expect(collab.closeApplication(w.editor, appA, 'x')).rejects.toThrow();
  });
});

describe('資料範圍：團主看不到別的團主，廠商看不到別的廠商', () => {
  /** 存在性洩漏檢查：真實 id 與不存在的 id 必須得到一樣的回應 */
  async function sameAsFake(c: Client, realPath: string, fakePath: string) {
    const real = await c.call('GET', realPath);
    const fake = await c.call('GET', fakePath);
    expect(real.status).toBe(fake.status);
    expect(real.error?.code).toBe(fake.error?.code);
    return real.status;
  }

  it('團主甲讀團主乙的申請＝與讀不存在的 id 同樣回應（404，不洩漏存在性）', async () => {
    const s = await sameAsFake(cl.hostA, `/collaboration/applications/${appB}`, '/collaboration/applications/CLB-999999');
    expect(s).toBe(404);
  });

  it('廠商甲讀廠商乙的申請＝404，且列表裡沒有別家的資料', async () => {
    const s = await sameAsFake(cl.vendA, `/collaboration/applications/${appB}`, '/collaboration/applications/CLB-999999');
    expect(s).toBe(404);
    const list = await cl.vendA.call<{ items: { id: string }[] }>('GET', '/collaboration/applications?limit=200');
    expect(list.data.items.map((x) => x.id)).not.toContain(appB);
    expect(list.data.items.map((x) => x.id)).toContain(appA);
  });

  it('團主與廠商的列表帶得到自己案件的進度欄位（工作台要靠這些），但不含內部備註與收件個資', async () => {
    for (const [who, c] of [['團主', cl.hostA], ['廠商', cl.vendA]] as const) {
      const list = await c.call<{ items: Record<string, unknown>[] }>('GET', '/collaboration/applications?limit=200');
      const row = list.data.items.find((x) => x.id === appA);
      expect(row, `${who}應該看得到自己的申請`).toBeTruthy();
      // 少了這些欄位，工作台會整頁爆掉（曾經真的 500 過）
      for (const k of ['sample', 'sampleBucket', 'itemCount', 'recipientConfirmed', 'intent', 'plannedOpenDate', 'confirmedOpenDate']) {
        expect(row!, `${who}的列表缺少 ${k}`).toHaveProperty(k);
      }
      expect((row!.sample as { progress: string }).progress).toBe('SHIPPED');
      // 不該多給的：內部欄位與收件個資
      for (const k of ['internalNote', 'ownerName', 'dedupeKey', 'recipientName', 'recipientPhone', 'addressLine']) {
        expect(row!, `${who}的列表不該有 ${k}`).not.toHaveProperty(k);
      }
      const raw = JSON.stringify(list.data);
      for (const v of Object.values(PII)) expect(raw).not.toContain(v);
    }
  });

  it('廠商的後台設定狀態只給廠商看，團主看不到', async () => {
    await collab.putVendorLaunch(vendA, appA, { backendSetupStatus: 'DONE', backendSetupNote: '後台已開' });
    const vendorRow = (await cl.vendA.call<{ items: Record<string, unknown>[] }>('GET', '/collaboration/applications?limit=200'))
      .data.items.find((x) => x.id === appA)!;
    const hostRow = (await cl.hostA.call<{ items: Record<string, unknown>[] }>('GET', '/collaboration/applications?limit=200'))
      .data.items.find((x) => x.id === appA)!;
    expect(vendorRow.backendSetupStatus).toBe('DONE');
    expect(hostRow).not.toHaveProperty('backendSetupStatus');
    // 後台 Mail 與廠商入口連結不論哪一方都不走列表
    for (const row of [vendorRow, hostRow]) {
      expect(row).not.toHaveProperty('backendSetupEmail');
      expect(row).not.toHaveProperty('vendorPortalUrl');
    }
  });

  it('跨組織一律 404（即使是系統管理者）', async () => {
    const s = await sameAsFake(cl.admin, `/collaboration/applications/${crossOrgApp}`, '/collaboration/applications/CLB-999999');
    expect(s).toBe(404);
    await expect(collab.getApplication(w.admin, crossOrgApp)).rejects.toThrow();
  });

  it('團主不能替別的團主建立申請；廠商不能替別家廠商建立', async () => {
    await expect(collab.createApplication(hostA, { vendorId: vA, hostId: hB, items: [{ productId: pA }] })).rejects.toThrow();
    await expect(collab.createApplication(vendA, { vendorId: vB, hostId: hA, items: [{ productId: pB }] })).rejects.toThrow();
  });

  it('團主／廠商主檔串接也受範圍限制', async () => {
    await expect(collab.hostApplications(hostA, hB)).rejects.toThrow();
    await expect(collab.vendorSummary(vendA, vB)).rejects.toThrow();
  });
});

describe('收件個資：欄位層級保護、履約期間限制、讀取稽核', () => {
  it('詳情頁本身不回傳收件內容，只回傳「有沒有、確認了沒」', async () => {
    const r = await cl.manager.call('GET', `/collaboration/applications/${appA}`);
    expect(JSON.stringify(r.data)).not.toContain(PII.name);
    expect(JSON.stringify(r.data)).not.toContain(PII.phone);
    expect(JSON.stringify(r.data)).not.toContain(PII.address);
    expect((r.data as { recipient: { present: boolean; confirmed: boolean } }).recipient).toMatchObject({ present: true, confirmed: true });
  });

  it('有 collaboration.pii.read 的內部角色讀得到，且每次讀取都寫一筆稽核', async () => {
    const before = (await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs WHERE organization_id=$1 AND action='collaboration.recipient.read'`, [w.orgId]))[0].n;
    const r = await cl.manager.call<{ recipientName: string }>('GET', `/collaboration/applications/${appA}/recipient`);
    expect(r.status).toBe(200);
    expect(r.data.recipientName).toBe(PII.name);
    const after = (await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs WHERE organization_id=$1 AND action='collaboration.recipient.read'`, [w.orgId]))[0].n;
    expect(after).toBe(before + 1);
    // 稽核本身不得存個資內容
    const rows = await query<{ after_data: unknown }>(
      `SELECT after_data FROM audit_logs WHERE organization_id=$1 AND action='collaboration.recipient.read' ORDER BY id DESC LIMIT 1`, [w.orgId]);
    expect(JSON.stringify(rows[0])).not.toContain(PII.phone);
  });

  it('團主只讀得到自己的收件資料，別人的＝404', async () => {
    const own = await cl.hostA.call<{ recipientPhone: string }>('GET', `/collaboration/applications/${appA}/recipient`);
    expect(own.status).toBe(200);
    expect(own.data.recipientPhone).toBe(PII.phone);
    const other = await cl.hostB.call('GET', `/collaboration/applications/${appA}/recipient`);
    expect(other.status).toBe(404);
  });

  it('廠商只能寫不了收件資料（只有團主與營運可以寫）', async () => {
    const r = await cl.vendA.call('PUT', `/collaboration/applications/${appA}/recipient`, {
      recipientName: '想改', recipientPhone: '0911000000', addressLine: '想換地址', confirm: true,
    });
    expect(r.status).toBe(403);
    const unchanged = await query<{ recipient_name: string }>(
      'SELECT recipient_name FROM collaboration_recipients WHERE application_id=$1 AND deleted_at IS NULL', [appA]);
    expect(unchanged[0].recipient_name).toBe(PII.name);
  });

  it('申請還沒核准時，廠商拿不到收件資料（履約必需期間之外）', async () => {
    const pending = (await collab.createApplication(w.manager, { ownerUserId: w.editor.userId, vendorId: vB, hostId: hB, items: [{ productId: pB }] })).id;
    await collab.putRecipient(hostB, pending, { recipientName: '乙收件', recipientPhone: '0922333444', addressLine: '某路 2 號', confirm: true });
    const r = await cl.vendB.call('GET', `/collaboration/applications/${pending}/recipient`);
    expect(r.status).toBe(403);
    expect(r.error?.message).toContain('尚未核准');
    // 被拒也要留痕（內部事件）
    const denied = await query(
      `SELECT 1 FROM collaboration_events WHERE application_id=$1 AND event_type='RECIPIENT_READ_DENIED'`, [pending]);
    expect(denied.length).toBeGreaterThan(0);
  });

  it('已核准＋團主已確認＋還有待寄出的寄送時，廠商讀得到（履約必需），而且同樣寫稽核；寄出之後視窗關閉（D-44）', async () => {
    // appA 的首次寄送已經寄出（履約不再需要地址），另建一筆「還沒寄」的案件驗證履約例外
    const open = (await collab.createApplication(w.manager, { ownerUserId: w.editor.userId, vendorId: vA, hostId: hA, items: [{ productId: pA }] })).id;
    await collab.submitApplication(w.manager, open);
    await collab.internalReview(w.manager, open, { decision: 'APPROVE' });
    await collab.putRecipient(hostA, open, { recipientName: PII.name, recipientPhone: PII.phone, addressLine: PII.address, confirm: true });
    const pending = await collab.addShipment(w.editor, open, { shipmentType: 'INITIAL' });   // 沒有寄出日＝待寄出
    const r = await cl.vendA.call<{ addressLine: string }>('GET', `/collaboration/applications/${open}/recipient`);
    expect(r.status).toBe(200);
    expect(r.data.addressLine).toBe(PII.address);
    await collab.updateShipment(w.editor, pending.id, { shipDate: dayOffset(-1) });
    const closed = await cl.vendA.call('GET', `/collaboration/applications/${open}/recipient`);
    expect(closed.status).toBe(403);
    expect(closed.error?.message).toContain('寄送');
    const audited = await query(
      `SELECT 1 FROM audit_logs WHERE organization_id=$1 AND action='collaboration.recipient.read' AND actor_user_id=$2`,
      [w.orgId, vendA.userId]);
    expect(audited.length).toBeGreaterThan(0);
  });

  it('超過保留期之後，廠商就讀不到了', async () => {
    await query(`UPDATE collaboration_recipients SET retention_until=$2 WHERE application_id=$1`, [appA, dayOffset(-1)]);
    const r = await cl.vendA.call('GET', `/collaboration/applications/${appA}/recipient`);
    expect(r.status).toBe(403);
    expect(r.error?.message).toContain('保留期');
    await query(`UPDATE collaboration_recipients SET retention_until=$2 WHERE application_id=$1`, [appA, dayOffset(60)]);
  });

  it('清除保留期已過的收件資料後，內容真的不見（不是只軟刪除）', async () => {
    const tmp = (await collab.createApplication(w.manager, { ownerUserId: w.editor.userId, vendorId: vA, hostId: hA, items: [{ productId: pA }] })).id;
    await collab.putRecipient(w.manager, tmp, { recipientName: 'SENTINEL-待清除', recipientPhone: '0955666777', addressLine: 'SENTINEL-待清除地址', confirm: true });
    await query(`UPDATE collaboration_recipients SET retention_until=$2 WHERE application_id=$1`, [tmp, dayOffset(-10)]);
    const res = await collab.purgeExpiredRecipients(w.admin);
    expect(res.purged).toBeGreaterThan(0);
    const after = await query<{ recipient_name: string; recipient_phone: string; address_line: string }>(
      'SELECT recipient_name, recipient_phone, address_line FROM collaboration_recipients WHERE application_id=$1', [tmp]);
    expect(JSON.stringify(after)).not.toContain('0955666777');
    expect(JSON.stringify(after)).not.toContain('SENTINEL-待清除地址');
    await expect(collab.getRecipient(w.manager, tmp)).rejects.toThrow();
    // 只有系統管理者可以執行清除
    await expect(collab.purgeExpiredRecipients(w.manager)).rejects.toThrow();
  });
});

describe('匯出：沒有個資權限的人帶不走收件人、電話與地址', () => {
  it('廠商可以匯出自己的案件，但表單二根本沒有收件人／電話／地址欄位（D-38）', async () => {
    const r = await cl.vendA.call('GET', '/collaboration/applications/export?form=form2');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    const header = r.text.replace('\uFEFF', '').split('\r\n')[0];
    for (const col of ['收件人', '聯繫電話', '地址']) expect(header).not.toContain(col);
    expect(r.text).toContain(appA);
    for (const leak of [PII.name, PII.phone, PII.address]) expect(r.text).not.toContain(leak);
  });

  it('營運主管匯出表單二才拿得到真實收件資料，而且匯出動作有稽核', async () => {
    const r = await cl.manager.call('GET', '/collaboration/applications/export?form=form2');
    expect(r.status).toBe(200);
    expect(r.text).toContain(PII.name);
    const audited = await query<{ after_data: { piiIncluded?: boolean } }>(
      `SELECT after_data FROM audit_logs WHERE organization_id=$1 AND action='collaboration.export' ORDER BY id DESC LIMIT 1`, [w.orgId]);
    expect(audited[0].after_data.piiIncluded).toBe(true);
  });

  it('表單一的匯出永遠不含收件個資', async () => {
    const r = await cl.manager.call('GET', '/collaboration/applications/export?form=form1');
    for (const leak of [PII.name, PII.phone, PII.address]) expect(r.text).not.toContain(leak);
  });

  it('團主沒有匯出權限', async () => {
    const r = await cl.hostA.call('GET', '/collaboration/applications/export?form=form2');
    expect(r.status).toBe(403);
  });
});

describe('廠商確認供樣不等於公司核准：G1～G5 完全不受影響', () => {
  it('廠商確認供樣不會新增任何 approvals，也不會改變任何 Gate 狀態', async () => {
    const camp = await mkCampaign(w, vA);
    const before = await query<{ id: string; gate_key: string; status: string }>(
      'SELECT id, gate_key, status FROM approvals WHERE campaign_id=$1 ORDER BY id', [camp.id]);
    const id = (await collab.createApplication(w.manager, { ownerUserId: w.editor.userId, vendorId: vA, hostId: hA, items: [{ productId: pA, requestedQty: 1 }] })).id;
    await collab.submitApplication(w.manager, id);
    await collab.internalReview(w.manager, id, { decision: 'TO_VENDOR' });
    const its = (await collab.getApplication(vendA, id)).items as { id: string }[];
    await collab.vendorReview(vendA, id, { items: [{ itemId: its[0].id, approvedQty: 1 }] });
    const after = await query<{ id: string; gate_key: string; status: string }>(
      'SELECT id, gate_key, status FROM approvals WHERE campaign_id=$1 ORDER BY id', [camp.id]);
    expect(after).toEqual(before);
  });

  it('廠商無法對任何 Gate 做出核准決定', async () => {
    const camp = await mkCampaign(w, vA);
    await expect(gates.requestApproval(vendA, camp.id, { gateKey: 'G1' } as never)).rejects.toThrow();
    await expect(gates.decideApproval(vendA, 'APV-000001', { decision: 'APPROVED' } as never)).rejects.toThrow();
  });

  it('關聯檔期只寫關聯欄位，稽核明確記錄對 Gate 沒有影響', async () => {
    const camp = await mkCampaign(w, vA);
    const id = (await collab.createApplication(w.manager, { ownerUserId: w.editor.userId, vendorId: vA, hostId: hA, items: [{ productId: pA }] })).id;
    await collab.submitApplication(w.manager, id);
    await collab.internalReview(w.manager, id, { decision: 'APPROVE' });
    await collab.putLaunch(hostA, id, { intent: 'WILLING' });
    await collab.confirmCollaboration(w.manager, id, {});
    const r = await collab.linkCampaign(w.manager, id, camp.id);
    expect(r.gateImpact).toBe('NONE');
    const log = await query<{ after_data: { gateImpact?: string } }>(
      `SELECT after_data FROM audit_logs WHERE entity_id=$1 AND action='collaboration.application.link_campaign'`, [id]);
    expect(log[0].after_data.gateImpact).toBe('NONE');
  });
});

describe('越權寫入：欄位層級與動作層級都在後端擋', () => {
  it('團主不能改內部備註、負責人或申請日期', async () => {
    const r = await cl.hostA.call('PATCH', `/collaboration/applications/${appA}`, { internalNote: '想偷寫' });
    expect(r.status).toBe(403);
    await expect(collab.updateApplication(hostA, appA, { ownerUserId: hostA.userId } as never)).rejects.toThrow();
    await expect(collab.updateApplication(hostA, appA, { appliedOn: dayOffset(0) } as never)).rejects.toThrow();
  });

  it('團主不能自己填「已確認的開團日」（那是營運的決定）', async () => {
    await expect(collab.putLaunch(hostA, appA, { confirmedOpenDate: dayOffset(10) } as never)).rejects.toThrow();
  });

  it('團主只能寫意願與開團日期；投廣與合作備註是內部欄位（畫面也不得把這些欄位給團主）', async () => {
    // 團主可以寫的
    await collab.putLaunch(hostA, appA, { intent: 'WILLING', plannedOpenDate: dayOffset(14), intentNote: '願意開團' });
    // 團主不能寫的——這組欄位曾經被誤放進團主的表單，導致團主永遠存不了意願
    for (const bad of [{ adsIntent: 'YES' }, { adsNote: '品牌出廣告費' }, { collaborationNote: '內部談的條件' }]) {
      await expect(collab.putLaunch(hostA, appA, bad as never), JSON.stringify(bad)).rejects.toThrow();
    }
    // 擋下來之後，原本寫好的意願不受影響
    const d = await collab.getApplication(hostA, appA);
    expect((d.launch as { intent: string; adsIntent: string }).intent).toBe('WILLING');
    expect((d.launch as { adsIntent: string }).adsIntent).toBe('PENDING');
  });

  it('廠商改不到申請主檔任何欄位，也改不到開團意願', async () => {
    await expect(collab.updateApplication(vendA, appA, { note: '想改' })).rejects.toThrow();
    await expect(collab.putLaunch(vendA, appA, { intent: 'WILLING' })).rejects.toThrow();
  });

  it('團主改不到寄送紀錄（沒有 shipping.write）', async () => {
    const r = await cl.hostA.call('PATCH', `/collaboration/shipments/${shipA}`, { carrier: '想改物流' });
    expect(r.status).toBe(403);
    const unchanged = await query<{ carrier: string | null }>('SELECT carrier FROM collaboration_shipments WHERE id=$1', [shipA]);
    expect(unchanged[0].carrier).toBe(null);
  });

  it('廠商不能代替團主簽收', async () => {
    const id = (await collab.createApplication(w.manager, { ownerUserId: w.editor.userId, vendorId: vA, hostId: hA, items: [{ productId: pA }] })).id;
    await collab.submitApplication(w.manager, id);
    await collab.internalReview(w.manager, id, { decision: 'APPROVE' });
    const s = await collab.addShipment(vendA, id, { shipmentType: 'INITIAL', shipDate: dayOffset(-1) });
    await expect(collab.confirmReceipt(vendA, s.id, { receivedOn: dayOffset(0) })).rejects.toThrow();
  });

  it('團主送審之後就不能再改明細，必須找營運', async () => {
    const id = (await collab.createApplication(hostA, { vendorId: vA, hostId: hA, items: [{ productId: pA }] })).id;
    await collab.submitApplication(hostA, id);
    await collab.internalReview(w.manager, id, { decision: 'TO_VENDOR' });
    await expect(collab.addItem(hostA, id, { productId: pA })).rejects.toThrow();
    await expect(collab.cancelApplication(hostA, id, '想取消')).rejects.toThrow();
  });

  it('已退回／已取消的申請不可再被修改', async () => {
    const id = (await collab.createApplication(w.manager, { ownerUserId: w.editor.userId, vendorId: vA, hostId: hA, items: [{ productId: pA }] })).id;
    await collab.submitApplication(w.manager, id);
    await collab.internalReview(w.manager, id, { decision: 'REJECT', note: '這一季不做' });
    expect((await collab.getApplication(w.manager, id)).status).toBe('REJECTED');
    await expect(collab.updateApplication(w.manager, id, { note: 'x' })).rejects.toThrow();
    await expect(collab.addShipment(w.editor, id, { shipmentType: 'INITIAL' })).rejects.toThrow();
  });

  it('核准數量不可大於申請數量（廠商無法藉此多發樣品）', async () => {
    const id = (await collab.createApplication(w.manager, { ownerUserId: w.editor.userId, vendorId: vA, hostId: hA, items: [{ productId: pA, requestedQty: 2 }] })).id;
    await collab.submitApplication(w.manager, id);
    await collab.internalReview(w.manager, id, { decision: 'TO_VENDOR' });
    const its = (await collab.getApplication(vendA, id)).items as { id: string }[];
    await expect(collab.vendorReview(vendA, id, { items: [{ itemId: its[0].id, approvedQty: 99 }] })).rejects.toThrow();
  });

  it('樂觀鎖：帶舊版號更新會得到 409', async () => {
    const d = await collab.getApplication(w.manager, appB);
    const r1 = await cl.manager.call('PATCH', `/collaboration/applications/${appB}`, { note: '第一次', version: d.version });
    expect(r1.status).toBe(200);
    const r2 = await cl.manager.call('PATCH', `/collaboration/applications/${appB}`, { note: '第二次', version: d.version });
    expect(r2.status).toBe(409);
  });
});

describe('匯入：只有內部營運可以用，而且不自動猜主檔對應', () => {
  it('團主與廠商都不能匯入', async () => {
    for (const c of [cl.hostA, cl.vendA]) {
      const r = await c.call('POST', '/collaboration/imports/preview', { kind: 'FORM2_SAMPLE', vendorId: vA, csv: 'x\n1' });
      expect([403, 404]).toContain(r.status);
    }
  });

  it('找不到團主主檔的列會被列為待確認，不會自動建立團主，也不會建立申請單', async () => {
    const csv = ['網紅名稱,收件人,聯繫電話,地址,申請樣品,配送日期,開團意願',
      `查無此人XYZ,收件甲,0911222333,某路 1 號,${'商品不存在ABC'},2026/10/01,願意`].join('\n');
    const hostsBefore = (await query<{ n: number }>('SELECT count(*)::int AS n FROM hosts WHERE organization_id=$1', [w.orgId]))[0].n;
    const r = await cl.manager.call<{ batchId: string; needsReview: number; rows: { issues: { code: string }[] }[] }>(
      'POST', '/collaboration/imports/preview', { kind: 'FORM2_SAMPLE', vendorId: vA, csv });
    expect(r.status).toBe(201);
    expect(r.data.needsReview).toBe(1);
    expect(r.data.rows[0].issues.map((i) => i.code)).toContain('HOST_NOT_FOUND');
    const hostsAfter = (await query<{ n: number }>('SELECT count(*)::int AS n FROM hosts WHERE organization_id=$1', [w.orgId]))[0].n;
    expect(hostsAfter).toBe(hostsBefore);
    const commit = await cl.manager.call<{ created: number }>('POST', `/collaboration/imports/${r.data.batchId}/commit`);
    expect(commit.data.created).toBe(0);
  });

  it('同一份檔案不能匯入兩次', async () => {
    const csv = ['團購主,檔期,是否已補寄,補寄日期,開團連結,是否投廣,後台設定 Mail',
      '團主甲RBAC,十月團,是,2026/10/09,https://example.invalid/a,是,shop@example.invalid'].join('\n');
    const first = await cl.manager.call('POST', '/collaboration/imports/preview', { kind: 'FORM1_LAUNCH', vendorId: vA, csv });
    expect(first.status).toBe(201);
    const second = await cl.manager.call('POST', '/collaboration/imports/preview', { kind: 'FORM1_LAUNCH', vendorId: vA, csv });
    expect(second.status).toBe(409);
  });

  it('對應好之後才建立申請單，而且重複 commit 不會重複建立', async () => {
    const csv = ['網紅名稱,收件人,聯繫電話,地址,申請樣品,配送日期,開團意願,備註',
      `團主甲RBAC,匯入收件人,0933444555,匯入地址 3 號,${'查無商品QQ'},2026/10/02,再考慮,匯入備註`].join('\n');
    const prev = await cl.manager.call<{ batchId: string }>('POST', '/collaboration/imports/preview', { kind: 'FORM2_SAMPLE', vendorId: vA, csv });
    const rows = await cl.manager.call<{ items: { id: string; resolution: string }[] }>('GET', `/collaboration/import-rows?batchId=${prev.data.batchId}`);
    const row = rows.data.items[0];
    expect(row.resolution).toBe('NEEDS_REVIEW');
    const fixed = await cl.manager.call<{ resolution: string }>('PATCH', `/collaboration/import-rows/${row.id}`, { productId: pA });
    expect(fixed.data.resolution).toBe('RESOLVED');
    const c1 = await cl.manager.call<{ created: number; applicationIds: string[] }>('POST', `/collaboration/imports/${prev.data.batchId}/commit`);
    expect(c1.error?.message ?? null).toBe(null);
    expect(c1.data.created).toBe(1);
    const c2 = await cl.manager.call<{ created: number }>('POST', `/collaboration/imports/${prev.data.batchId}/commit`);
    expect(c2.data.created).toBe(0);
    // 匯入來源與原始備註都落在真實資料上
    const app = await collab.getApplication(w.manager, c1.data.applicationIds[0]);
    expect(app.source).toBe('IMPORT');
    expect(app.note).toBe('匯入備註');
    expect((app.launch as { intent: string }).intent).toBe('UNDECIDED');
  });
});

describe('稽核與事件：每一個寫入都留得下來', () => {
  it('稽核表不可被修改（append-only）', async () => {
    await expect(query(
      `UPDATE audit_logs SET action='tampered' WHERE organization_id=$1 AND action LIKE 'collaboration.%'`, [w.orgId]))
      .rejects.toThrow();
  });

  it('合作申請與相關資料都不可實體刪除', async () => {
    for (const t of ['collaboration_applications', 'collaboration_application_items', 'collaboration_recipients',
      'collaboration_shipments', 'collaboration_launch_details', 'collaboration_events', 'collaboration_import_rows']) {
      await expect(query(`DELETE FROM ${t} WHERE organization_id=$1`, [w.orgId])).rejects.toThrow();
    }
  });

  it('合作事件表是 append-only（補登的歷程不可被改寫）', async () => {
    await expect(query(
      `UPDATE collaboration_events SET note='tampered' WHERE application_id=$1`, [appA])).rejects.toThrow();
  });
});
