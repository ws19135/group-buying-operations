import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import type { Actor } from '@/server/lib/permissions';
import * as collab from '@/server/modules/collaboration';
import { addUser, dayOffset, makeWorld, mkCampaign, mkHost, mkProduct, mkVendor, type World } from './helpers';
import { addDaysIso, RECIPIENT_RETENTION_DAYS_AFTER_APPROVAL, RECIPIENT_RETENTION_DAYS_AFTER_DELIVERY } from '@/server/lib/collaboration-rules';
import { todayTaipei } from '@/server/lib/ids';

/**
 * 合作申請與樣品管理：完整流程、四個維度的狀態、以及「不能只有畫面」的真實資料驗證。
 * 全部打真實 PostgreSQL 與真實服務層，不使用假資料。
 */
let w: World;
let vendorId: string;
let hostId: string;
let productId: string;
let skuIds: string[];
let product2: { id: string; skuIds: string[] };
let hostActor: Actor;
let vendorActor: Actor;

beforeAll(async () => {
  w = await makeWorld();
  vendorId = (await mkVendor(w)).id;
  const p = await mkProduct(w, vendorId, {
    approve: true,
    skus: [
      { skuCode: 'S1', name: '小包裝', listPrice: 500, groupPrice: 400, costPrice: 300 },
      { skuCode: 'S2', name: '大包裝', listPrice: 900, groupPrice: 700, costPrice: 500 },
    ],
  });
  productId = p.id; skuIds = p.skuIds;
  product2 = await mkProduct(w, vendorId, { approve: true });
  hostId = (await mkHost(w)).id;
  hostActor = await addUser(w.orgId, 'HOST', { hostIds: [hostId] });
  vendorActor = await addUser(w.orgId, 'VENDOR', { vendorIds: [vendorId] });
});

/** 建立一筆已核准、可以開始寄樣的申請（流程前半段的捷徑，後面多個案例都要用） */
async function approvedApplication(items?: { productId: string; skuId?: string | null; requestedQty?: number }[]) {
  const r = await collab.createApplication(w.manager, { ownerUserId: w.editor.userId,
    vendorId, hostId,
    items: items ?? [{ productId, skuId: skuIds[0], requestedQty: 2 }],
  });
  await collab.submitApplication(w.manager, r.id);
  await collab.internalReview(w.manager, r.id, { decision: 'TO_VENDOR' });
  const detail = await collab.getApplication(w.manager, r.id);
  const its = detail.items as { id: string; requestedQty: number }[];
  await collab.vendorReview(vendorActor, r.id, { items: its.map((i) => ({ itemId: i.id, approvedQty: i.requestedQty })) });
  return r.id;
}

describe('完整流程：營運建立 → 廠商供樣 → 寄送 → 團主收件 → 回覆意願 → 確認合作 → 關聯檔期', () => {
  it('一路走完，每一步的狀態與稽核都落在真實資料庫', async () => {
    // 1. 營運建立（一筆申請、兩個商品，其中一個指定規格）
    const created = await collab.createApplication(w.manager, { ownerUserId: w.editor.userId,
      vendorId, hostId, note: '十月團主試樣',
      items: [
        { productId, skuId: skuIds[0], requestedQty: 2, requestReason: '想試小包裝' },
        { productId: product2.id, requestedQty: 1 },
      ],
    });
    const id = created.id;
    expect(id).toMatch(/^CLB-\d{6}$/);

    let d = await collab.getApplication(w.manager, id);
    expect(d.status).toBe('DRAFT');
    expect((d.items as unknown[]).length).toBe(2);
    expect(d.sampleBucket).toBe('NONE');

    // 2. 送出 → 內部審核 → 轉廠商
    await collab.submitApplication(w.manager, id);
    expect((await collab.getApplication(w.manager, id)).status).toBe('SUBMITTED');
    await collab.internalReview(w.manager, id, { decision: 'TO_VENDOR', note: '請廠商確認供樣' });
    expect((await collab.getApplication(w.manager, id)).status).toBe('VENDOR_REVIEW');

    // 3. 廠商確認供樣（其中一項只能部分供應）
    d = await collab.getApplication(vendorActor, id);
    const its = d.items as { id: string; productId: string; requestedQty: number }[];
    await collab.vendorReview(vendorActor, id, {
      items: [
        { itemId: its[0].id, approvedQty: 1, vendorNote: '只剩一組' },
        { itemId: its[1].id, approvedQty: 1 },
      ],
    });
    d = await collab.getApplication(w.manager, id);
    expect(d.status).toBe('APPROVED');
    expect(d.collaborationStatus).toBe('SAMPLE_IN_PROGRESS');
    const supply = (d.items as { supplyStatus: string }[]).map((i) => i.supplyStatus).sort();
    expect(supply).toEqual(['AVAILABLE', 'PARTIAL']);

    // 4. 團主填收件資訊（不會覆寫團主主檔）
    const before = await query<{ id: string }>('SELECT id FROM hosts WHERE id=$1', [hostId]);
    await collab.putRecipient(hostActor, id, {
      recipientName: '王小花', recipientPhone: '0912345678',
      postalCode: '10491', addressLine: '台北市中山區某路 1 號 5 樓', deliveryNote: '請放管理室', confirm: true,
    });
    expect(before.length).toBe(1);
    const hostCols = await query<Record<string, unknown>>('SELECT * FROM hosts WHERE id=$1', [hostId]);
    expect(Object.keys(hostCols[0]).some((k) => k.includes('address'))).toBe(false);   // 團主主檔沒有地址欄位可被覆寫

    // 5. 廠商寄出樣品
    const ship = await collab.addShipment(vendorActor, id, {
      shipmentType: 'INITIAL', shipDate: dayOffset(-5), carrier: '黑貓', trackingNo: 'TN-0001', quantity: 2,
    });
    d = await collab.getApplication(w.manager, id);
    expect((d.sample as { progress: string }).progress).toBe('SHIPPED');
    expect((d.sample as { resent: boolean }).resent).toBe(false);

    // 6. 團主確認收件 → 自動進入試用
    await collab.confirmReceipt(hostActor, ship.id, { receivedOn: dayOffset(-3), receiptNote: '已收到' });
    d = await collab.getApplication(w.manager, id);
    expect((d.sample as { progress: string }).progress).toBe('DELIVERED');
    expect(d.collaborationStatus).toBe('TRIAL_IN_PROGRESS');

    // 7. 團主回覆開團意願
    await collab.putLaunch(hostActor, id, { intent: 'WILLING', plannedOpenDate: dayOffset(20), launchUrl: 'https://example.invalid/open' });
    d = await collab.getApplication(w.manager, id);
    expect((d.launch as { intent: string }).intent).toBe('WILLING');
    expect((d.launch as { intentRespondedOn: string | null }).intentRespondedOn).toBeTruthy();
    expect(d.collaborationStatus).toBe('AWAITING_INTENT');

    // 8. 營運確認正式合作
    await collab.confirmCollaboration(w.manager, id, { confirmedOpenDate: dayOffset(25), note: '排入十一月檔期' });
    d = await collab.getApplication(w.manager, id);
    expect(d.collaborationStatus).toBe('COLLABORATION_CONFIRMED');
    // 預計開團日與實際（已確認）開團日必須分得開
    expect((d.launch as { plannedOpenDate: string }).plannedOpenDate).toBe(dayOffset(20));
    expect((d.launch as { confirmedOpenDate: string }).confirmedOpenDate).toBe(dayOffset(25));

    // 9. 廠商回填後台連結與後台設定 Mail（後台設定狀態與聯絡信箱分開記錄，系統不寄信）
    await collab.putVendorLaunch(vendorActor, id, {
      vendorPortalUrl: 'https://example.invalid/vendor-admin',
      backendSetupEmail: 'shop@example.invalid', backendSetupStatus: 'DONE',
    });
    d = await collab.getApplication(w.manager, id);
    expect((d.launch as { backendSetupEmail: string }).backendSetupEmail).toBe('shop@example.invalid');
    expect((d.launch as { backendSetupStatus: string }).backendSetupStatus).toBe('DONE');
    const mails = await query('SELECT 1 FROM notifications WHERE organization_id=$1', [w.orgId]);
    expect(mails.length).toBe(0);   // 不自動寄信

    // 10. 關聯既有檔期：不建立檔期、不碰 G1～G5
    const camp = await mkCampaign(w, vendorId);
    const gatesBefore = await query('SELECT 1 FROM approvals WHERE campaign_id=$1', [camp.id]);
    await collab.linkCampaign(w.manager, id, camp.id);
    const gatesAfter = await query('SELECT 1 FROM approvals WHERE campaign_id=$1', [camp.id]);
    expect(gatesAfter.length).toBe(gatesBefore.length);
    d = await collab.getApplication(w.manager, id);
    expect(d.collaborationStatus).toBe('CAMPAIGN_LINKED');
    expect(d.campaignId).toBe(camp.id);

    // 11. 各方從自己的工作台追蹤
    const opsView = await collab.overview(w.manager);
    const vendorView = await collab.overview(vendorActor);
    const hostView = await collab.overview(hostActor);
    for (const v of [opsView, vendorView, hostView]) {
      expect(v.buckets.some((b) => b.bucket === 'CAMPAIGN_LINKED' && b.count >= 1)).toBe(true);
    }

    // 12. 稽核完整：每一個寫入動作都有紀錄
    const actions = (await query<{ action: string }>(
      `SELECT DISTINCT action FROM audit_logs WHERE organization_id=$1 AND action LIKE 'collaboration.%'`, [w.orgId]))
      .map((r) => r.action);
    for (const a of ['collaboration.application.create', 'collaboration.application.status', 'collaboration.item.vendor_review',
      'collaboration.recipient.write', 'collaboration.shipment.create', 'collaboration.shipment.confirm_receipt',
      'collaboration.launch.update', 'collaboration.application.link_campaign']) {
      expect(actions).toContain(a);
    }
    // 四個維度的事件分別留痕
    const dims = (await query<{ dimension: string }>(
      'SELECT DISTINCT dimension FROM collaboration_events WHERE application_id=$1', [id])).map((r) => r.dimension).sort();
    expect(dims).toEqual(expect.arrayContaining(['APPLICATION', 'CAMPAIGN', 'COLLABORATION', 'DATA', 'INTENT', 'SAMPLE']));
  });
});

describe('三種建立來源', () => {
  it('團主自己建立，來源記為 HOST_FORM', async () => {
    const r = await collab.createApplication(hostActor, { vendorId, hostId, items: [{ productId, skuId: skuIds[1] }] });
    const d = await collab.getApplication(hostActor, r.id);
    expect(d.source).toBe('HOST_FORM');
  });

  it('廠商代建，來源記為 VENDOR_FORM', async () => {
    const r = await collab.createApplication(vendorActor, { vendorId, hostId, items: [{ productId: product2.id }] });
    const d = await collab.getApplication(vendorActor, r.id);
    expect(d.source).toBe('VENDOR_FORM');
  });

  it('同一個人代表多家廠商時，兩家的申請都看得到、別家的看不到', async () => {
    const v2 = (await mkVendor(w)).id;
    const p2 = await mkProduct(w, v2, { approve: true });
    const v3 = (await mkVendor(w)).id;
    const p3 = await mkProduct(w, v3, { approve: true });
    const multi = await addUser(w.orgId, 'VENDOR', { vendorIds: [vendorId, v2] });
    const a1 = await collab.createApplication(w.manager, { ownerUserId: w.editor.userId, vendorId, hostId, items: [{ productId }] });
    const a2 = await collab.createApplication(w.manager, { ownerUserId: w.editor.userId, vendorId: v2, hostId, items: [{ productId: p2.id }] });
    const a3 = await collab.createApplication(w.manager, { ownerUserId: w.editor.userId, vendorId: v3, hostId, items: [{ productId: p3.id }] });
    const seen = (await collab.listApplications(multi, new URLSearchParams({ limit: '200' }))).items.map((x) => x.id);
    expect(seen).toContain(a1.id);
    expect(seen).toContain(a2.id);
    expect(seen).not.toContain(a3.id);
  });

  it('同一筆申請可含同商品的多個規格，且重複送出不會長出重複明細', async () => {
    const r = await collab.createApplication(w.manager, { ownerUserId: w.editor.userId,
      vendorId, hostId,
      items: [{ productId, skuId: skuIds[0], requestedQty: 1 }, { productId, skuId: skuIds[1], requestedQty: 1 }],
    });
    expect((await collab.getApplication(w.manager, r.id)).items).toHaveLength(2);
    await expect(collab.addItem(w.manager, r.id, { productId, skuId: skuIds[0] })).rejects.toThrow();
    expect((await collab.getApplication(w.manager, r.id)).items).toHaveLength(2);
  });

  it('同一個 Idempotency-Key 重複建立只會有一筆', async () => {
    const key = `collab-test-${Date.now()}`;
    const a = await collab.createApplication(w.manager, { ownerUserId: w.editor.userId, vendorId, hostId, items: [{ productId }] }, key);
    const b = await collab.createApplication(w.manager, { ownerUserId: w.editor.userId, vendorId, hostId, items: [{ productId }] }, key);
    expect(b.id).toBe(a.id);
    expect(b.replayed).toBe(true);
  });
});

describe('樣品寄送：首次 + 補寄', () => {
  it('「是否已補寄」只有在補寄真的寄出後才為真', async () => {
    const id = await approvedApplication();
    const first = await collab.addShipment(w.editor, id, { shipmentType: 'INITIAL', shipDate: dayOffset(-10) });
    expect(first.status).toBe('SHIPPED');

    // 不能重複建立首次寄送
    await expect(collab.addShipment(w.editor, id, { shipmentType: 'INITIAL' })).rejects.toThrow();

    // 補寄先建立、還沒寄出
    const resend = await collab.addShipment(w.editor, id, { shipmentType: 'RESEND' });
    let d = await collab.getApplication(w.manager, id);
    expect((d.sample as { resent: boolean; resendPending: boolean }).resent).toBe(false);
    expect((d.sample as { resendPending: boolean }).resendPending).toBe(true);
    expect(d.sampleBucket).toBe('RESEND_PENDING');

    // 填上寄出日期＝視為已寄出（對應表單一「品牌若寄出請改日期」）
    await collab.updateShipment(w.editor, resend.id, { shipDate: dayOffset(-2), carrier: '新竹', trackingNo: 'TN-0002' });
    d = await collab.getApplication(w.manager, id);
    expect((d.sample as { resent: boolean }).resent).toBe(true);
    expect((d.sample as { lastShipDate: string }).lastShipDate).toBe(dayOffset(-2));

    // 列表與詳情的推導口徑一致
    const listed = (await collab.listApplications(w.manager, new URLSearchParams({ q: id })))
      .items.find((x) => x.id === id) as { sample: { resent: boolean } };
    expect(listed.sample.resent).toBe(true);
  });

  it('還沒核准供樣不能建立寄送紀錄；沒有首次寄送不能先補寄', async () => {
    const r = await collab.createApplication(w.manager, { ownerUserId: w.editor.userId, vendorId, hostId, items: [{ productId }] });
    await expect(collab.addShipment(w.editor, r.id, { shipmentType: 'INITIAL' })).rejects.toThrow();
    const id = await approvedApplication();
    await expect(collab.addShipment(w.editor, id, { shipmentType: 'RESEND' })).rejects.toThrow();
  });

  it('收件日不可早於寄出日；已送達不可改回待寄出', async () => {
    const id = await approvedApplication();
    const s = await collab.addShipment(w.editor, id, { shipmentType: 'INITIAL', shipDate: dayOffset(-2) });
    await expect(collab.confirmReceipt(hostActor, s.id, { receivedOn: dayOffset(-5) })).rejects.toThrow();
    await collab.confirmReceipt(hostActor, s.id, { receivedOn: dayOffset(-1) });
    await expect(collab.updateShipment(w.editor, s.id, { status: 'PENDING' })).rejects.toThrow();
  });

  it('收件個資保留期會隨「核准 → 寄出 → 送達 → 補寄」重算，送達後改以最後寄送日起算 30 天', async () => {
    const id = await approvedApplication();
    await collab.putRecipient(w.editor, id, {
      recipientName: '保留期測試', recipientPhone: '0912000111', addressLine: '台北市測試路 1 號', confirm: true,
    });
    const until = async () => (await query<{ retention_until: string | null }>(
      `SELECT to_char(retention_until,'YYYY-MM-DD') AS retention_until FROM collaboration_recipients
         WHERE application_id=$1 AND deleted_at IS NULL`, [id]))[0].retention_until;

    // 還沒送達：以核准日起算 90 天
    const afterApproval = await until();
    expect(afterApproval).toBe(addDaysIso(todayTaipei(), RECIPIENT_RETENTION_DAYS_AFTER_APPROVAL));

    // 送達後：改以最後寄送日起算 30 天（比核准基準早，所以要縮短）
    const first = await collab.addShipment(w.editor, id, { shipmentType: 'INITIAL', shipDate: dayOffset(-5) });
    await collab.confirmReceipt(hostActor, first.id, { receivedOn: dayOffset(-3) });
    const afterDelivery = await until();
    expect(afterDelivery).toBe(addDaysIso(dayOffset(-5), RECIPIENT_RETENTION_DAYS_AFTER_DELIVERY));
    expect(afterDelivery! < afterApproval!).toBe(true);

    // 補寄還在路上時不能讓個資先過期：基準跟著最後寄送日往後移
    await collab.addShipment(w.editor, id, { shipmentType: 'RESEND', shipDate: dayOffset(-1) });
    expect(await until()).toBe(addDaysIso(dayOffset(-1), RECIPIENT_RETENTION_DAYS_AFTER_DELIVERY));

    // 每次調整都留下可查的紀錄
    const ev = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM collaboration_events WHERE application_id=$1 AND event_type='RECIPIENT_RETENTION_UPDATE'`, [id]);
    expect(ev[0].n).toBeGreaterThanOrEqual(2);
    const au = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs WHERE organization_id=$1 AND action='collaboration.recipient.retention'`, [w.orgId]);
    expect(au[0].n).toBeGreaterThanOrEqual(2);
  });

  it('取消的寄送紀錄不影響補寄判定，且取消需填原因', async () => {
    const id = await approvedApplication();
    const s = await collab.addShipment(w.editor, id, { shipmentType: 'INITIAL', shipDate: dayOffset(-3) });
    const r2 = await collab.addShipment(w.editor, id, { shipmentType: 'RESEND', shipDate: dayOffset(-1) });
    await expect(collab.cancelShipment(w.editor, r2.id, '')).rejects.toThrow();
    await collab.cancelShipment(w.editor, r2.id, '物流取件失敗');
    const d = await collab.getApplication(w.manager, id);
    expect((d.sample as { resent: boolean }).resent).toBe(false);
    expect(s.status).toBe('SHIPPED');
  });
});

describe('平行進行的情境（不是一條長鏈）', () => {
  it('團主可以在樣品寄出前就先確認預計開團日', async () => {
    const id = await approvedApplication();
    await collab.putLaunch(hostActor, id, { intent: 'WILLING', plannedOpenDate: dayOffset(30) });
    const d = await collab.getApplication(w.manager, id);
    expect((d.launch as { plannedOpenDate: string }).plannedOpenDate).toBe(dayOffset(30));
    expect((d.sample as { progress: string }).progress).toBe('NOT_REQUESTED');
    expect(d.collaborationStatus).toBe('AWAITING_INTENT');
    // 之後才寄樣，兩個維度互不干擾
    await collab.addShipment(w.editor, id, { shipmentType: 'INITIAL', shipDate: dayOffset(-1) });
    expect((await collab.getApplication(w.manager, id)).collaborationStatus).toBe('AWAITING_INTENT');
  });

  it('團主試用後暫不決定＝待回覆，不會被推進合作確認', async () => {
    const id = await approvedApplication();
    await collab.putLaunch(hostActor, id, { intent: 'UNDECIDED', intentNote: '再觀察一季' });
    const d = await collab.getApplication(w.manager, id);
    expect(d.collaborationStatus).toBe('AWAITING_INTENT');
    await expect(collab.confirmCollaboration(w.manager, id, {})).rejects.toThrow();
  });

  it('團主回覆不開團＝合作狀態 DECLINED，且不能關聯檔期', async () => {
    const id = await approvedApplication();
    await collab.putLaunch(hostActor, id, { intent: 'UNWILLING', intentNote: '客群不合' });
    const d = await collab.getApplication(w.manager, id);
    expect(d.collaborationStatus).toBe('DECLINED');
    const camp = await mkCampaign(w, vendorId);
    await expect(collab.linkCampaign(w.manager, id, camp.id)).rejects.toThrow();
  });

  it('意願還沒回覆時不能確認合作', async () => {
    const id = await approvedApplication();
    await expect(collab.confirmCollaboration(w.manager, id, {})).rejects.toThrow();
  });

  it('暫緩需填原因，恢復後可繼續', async () => {
    const id = await approvedApplication();
    await expect(collab.holdApplication(w.manager, id, '')).rejects.toThrow();
    await collab.holdApplication(w.manager, id, '等廠商補檢驗報告');
    expect((await collab.getApplication(w.manager, id)).status).toBe('ON_HOLD');
    await collab.resumeApplication(w.manager, id, 'APPROVED');
    expect((await collab.getApplication(w.manager, id)).status).toBe('APPROVED');
  });
});

describe('檔期關聯', () => {
  async function confirmedApplication(hId: string = hostId) {
    const r = await collab.createApplication(w.manager, { ownerUserId: w.editor.userId, vendorId, hostId: hId, items: [{ productId }] });
    await collab.submitApplication(w.manager, r.id);
    await collab.internalReview(w.manager, r.id, { decision: 'APPROVE' });
    const hA = hId === hostId ? hostActor : await addUser(w.orgId, 'HOST', { hostIds: [hId] });
    await collab.putLaunch(hA, r.id, { intent: 'WILLING' });
    await collab.confirmCollaboration(w.manager, r.id, {});
    return r.id;
  }

  it('一個檔期可以關聯多筆合作申請（多位團主同團）', async () => {
    const camp = await mkCampaign(w, vendorId);
    const host2 = (await mkHost(w)).id;
    const a1 = await confirmedApplication();
    const a2 = await confirmedApplication(host2);
    await collab.linkCampaign(w.manager, a1, camp.id);
    await collab.linkCampaign(w.manager, a2, camp.id);
    const linked = await query<{ id: string }>(
      `SELECT id FROM collaboration_applications WHERE campaign_id=$1 AND deleted_at IS NULL`, [camp.id]);
    expect(linked.map((r) => r.id).sort()).toEqual([a1, a2].sort());
  });

  it('不可關聯別家廠商的檔期；已關聯後要換檔期必須先解除', async () => {
    const otherVendor = (await mkVendor(w)).id;
    const otherCamp = await mkCampaign(w, otherVendor);
    const id = await confirmedApplication();
    await expect(collab.linkCampaign(w.manager, id, otherCamp.id)).rejects.toThrow();
    const camp = await mkCampaign(w, vendorId);
    const camp2 = await mkCampaign(w, vendorId);
    await collab.linkCampaign(w.manager, id, camp.id);
    await expect(collab.linkCampaign(w.manager, id, camp2.id)).rejects.toThrow();
    await collab.unlinkCampaign(w.manager, id, '改排別的檔期');
    await collab.linkCampaign(w.manager, id, camp2.id);
    expect((await collab.getApplication(w.manager, id)).campaignId).toBe(camp2.id);
  });

  it('還沒確認合作就關聯檔期會被擋（資料庫層也有 CHECK）', async () => {
    const id = await approvedApplication();
    const camp = await mkCampaign(w, vendorId);
    await expect(collab.linkCampaign(w.manager, id, camp.id)).rejects.toThrow();
    await expect(query(
      `UPDATE collaboration_applications SET campaign_id=$2 WHERE id=$1`, [id, camp.id])).rejects.toThrow();
  });
});

describe('與既有模組的關聯', () => {
  it('SOP 03 試用紀錄只建立引用關係，不改試用結論', async () => {
    const id = await approvedApplication();
    const trial = await query<{ id: string; conclusion: string | null; status: string }>(
      `INSERT INTO product_trials (id, organization_id, vendor_id, product_id, host_id, level, trial_type, status, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,'HOST_FIT','DESIGNATED_HOST','OPEN',$6,$6) RETURNING id, conclusion, status`,
      [`TRL-TEST-${Date.now().toString(36)}`, w.orgId, vendorId, productId, hostId, w.manager.userId]);
    await collab.linkTrial(w.manager, id, trial[0].id);
    const after = await query<{ conclusion: string | null; status: string }>(
      'SELECT conclusion, status FROM product_trials WHERE id=$1', [trial[0].id]);
    expect(after[0].status).toBe(trial[0].status);
    expect(after[0].conclusion).toBe(trial[0].conclusion);
    expect((await collab.getApplication(w.manager, id)).trialId).toBe(trial[0].id);
  });

  it('團主／廠商／商品詳情頁的合作申請區塊都讀得到', async () => {
    const id = await approvedApplication();
    const hostRows = await collab.hostApplications(w.manager, hostId);
    expect(hostRows.items.some((x) => x.id === id)).toBe(true);
    const vSummary = await collab.vendorSummary(w.manager, vendorId);
    expect(vSummary.hostCount).toBeGreaterThan(0);
    const pRows = await collab.productApplications(w.manager, productId);
    expect(pRows.items.some((x) => x.id === id)).toBe(true);
  });

  it('沒有另外建立平行的任務引擎（tasks 不被本模組寫入）', async () => {
    const before = await query('SELECT count(*)::int AS n FROM tasks WHERE organization_id=$1', [w.orgId]);
    const id = await approvedApplication();
    await collab.addShipment(w.editor, id, { shipmentType: 'INITIAL', shipDate: dayOffset(-1) });
    const after = await query<{ n: number }>('SELECT count(*)::int AS n FROM tasks WHERE organization_id=$1', [w.orgId]);
    expect(after[0].n).toBe((before[0] as { n: number }).n);
  });

  it('樣品申請不扣庫存、不產生任何財務或結算紀錄', async () => {
    const snap = async () => ({
      inv: (await query<{ n: number }>('SELECT count(*)::int AS n FROM inventory_movements WHERE organization_id=$1', [w.orgId]))[0].n,
      settle: (await query<{ n: number }>('SELECT count(*)::int AS n FROM settlements WHERE organization_id=$1', [w.orgId]))[0].n,
      pay: (await query<{ n: number }>('SELECT count(*)::int AS n FROM payments WHERE organization_id=$1', [w.orgId]))[0].n,
      items: (await query<{ n: number }>('SELECT count(*)::int AS n FROM settlement_items WHERE organization_id=$1', [w.orgId]))[0].n,
    });
    const before = await snap();
    const id = await approvedApplication();
    const s = await collab.addShipment(w.editor, id, { shipmentType: 'INITIAL', shipDate: dayOffset(-2) });
    await collab.confirmReceipt(hostActor, s.id, { receivedOn: dayOffset(-1) });
    expect(await snap()).toEqual(before);
  });
});

describe('列表篩選與匯出', () => {
  it('預計開團日與實際開團日可分開篩選', async () => {
    const id = await approvedApplication();
    await collab.putLaunch(hostActor, id, { intent: 'WILLING', plannedOpenDate: dayOffset(60) });
    const byPlanned = await collab.listApplications(w.manager, new URLSearchParams({ plannedFrom: dayOffset(59), plannedTo: dayOffset(61) }));
    expect(byPlanned.items.some((x) => x.id === id)).toBe(true);
    const byConfirmed = await collab.listApplications(w.manager, new URLSearchParams({ confirmedFrom: dayOffset(59), confirmedTo: dayOffset(61) }));
    expect(byConfirmed.items.some((x) => x.id === id)).toBe(false);
  });

  it('依寄送進度篩選（待寄出／已寄出／待補寄）', async () => {
    const id = await approvedApplication();
    expect((await collab.listApplications(w.manager, new URLSearchParams({ shipment: 'TO_SHIP' }))).items.some((x) => x.id === id)).toBe(true);
    await collab.addShipment(w.editor, id, { shipmentType: 'INITIAL', shipDate: dayOffset(-1) });
    expect((await collab.listApplications(w.manager, new URLSearchParams({ shipment: 'SHIPPED' }))).items.some((x) => x.id === id)).toBe(true);
    await collab.addShipment(w.editor, id, { shipmentType: 'RESEND' });
    expect((await collab.listApplications(w.manager, new URLSearchParams({ shipment: 'RESEND_PENDING' }))).items.some((x) => x.id === id)).toBe(true);
  });

  it('兩種表單格式都匯得出來，檔名與 BOM 正確', async () => {
    const f1 = await collab.exportApplications(w.manager, new URLSearchParams({ form: 'form1' }));
    const f2 = await collab.exportApplications(w.manager, new URLSearchParams({ form: 'form2' }));
    expect(f1.filename).toMatch(/^collaboration-form1-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(f1.csv.startsWith('﻿')).toBe(true);
    expect(f1.csv.split('\n')[0]).toContain('是否已補寄');
    expect(f2.csv.split('\n')[0]).toContain('收件人');
    const audited = await query(
      `SELECT 1 FROM audit_logs WHERE organization_id=$1 AND action='collaboration.export'`, [w.orgId]);
    expect(audited.length).toBeGreaterThanOrEqual(2);
  });
});
