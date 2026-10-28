import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { resetRateLimits } from '@/server/lib/rate-limit';
import {
  SHIPMENT_STATUSES, SHIPMENT_TRANSITIONS, addShipment, adjustStock, cancelBatch, confirmReceipt, createBatch, fulfillmentWarnings,
  getBatch, getCampaignFulfillment, listMovements, listStock, reverseMovement, rollupBatchStatus, setShipmentStatus, updateBatch, updateShipment,
} from '@/server/modules/fulfillment';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkCampaign, mkHost, mkProduct, mkVendor, type World } from './helpers';
import type { Actor } from '@/server/lib/permissions';

let w: World;
let hostA: { id: string }, hostB: { id: string }, vendorA: { id: string }, vendorB: { id: string };
let product: { id: string; skuIds: string[] };
let campRun: string, campDraft: string, campOther: string, campSettle: string;
let hostAUser: Actor, hostBUser: Actor, vendorAUser: Actor, vendorBUser: Actor;

const setStatus = (id: string, status: string) => query('UPDATE campaigns SET status=$2 WHERE id=$1', [id, status]);
const URLQ = (o: Record<string, string>) => new URLSearchParams(o);

beforeAll(async () => {
  resetRateLimits();
  w = await makeWorld();
  hostA = await mkHost(w, '團主甲'); hostB = await mkHost(w, '團主乙');
  vendorA = await mkVendor(w, '廠商甲'); vendorB = await mkVendor(w, '廠商乙');
  product = await mkProduct(w, vendorA.id, { approve: true, skus: [{ skuCode: 'A', name: '規格A', groupPrice: 800, costPrice: 500 }, { skuCode: 'B', name: '規格B', groupPrice: 900, costPrice: 600 }] });
  const productB = await mkProduct(w, vendorB.id, { approve: true });
  const items = [{ productId: product.id, skuId: product.skuIds[0] }];
  // editor 是這幾檔的負責人；editor2 不是
  campRun = (await mkCampaign(w, vendorA.id, { products: items, hosts: [{ hostId: hostA.id }] }, w.editor)).id;
  campDraft = (await mkCampaign(w, vendorA.id, { products: items, hosts: [{ hostId: hostA.id }] }, w.editor)).id;
  campSettle = (await mkCampaign(w, vendorA.id, { products: items, hosts: [{ hostId: hostA.id }] }, w.editor)).id;
  campOther = (await mkCampaign(w, vendorB.id, { products: [{ productId: productB.id, skuId: productB.skuIds[0] }], hosts: [{ hostId: hostB.id }] }, w.manager)).id;
  await setStatus(campRun, 'RUNNING');
  await setStatus(campSettle, 'PENDING_SETTLEMENT');
  await setStatus(campOther, 'RUNNING');
  hostAUser = await addUser(w.orgId, 'HOST', { hostIds: [hostA.id] });
  hostBUser = await addUser(w.orgId, 'HOST', { hostIds: [hostB.id] });
  vendorAUser = await addUser(w.orgId, 'VENDOR', { vendorIds: [vendorA.id] });
  vendorBUser = await addUser(w.orgId, 'VENDOR', { vendorIds: [vendorB.id] });
});

describe('純函式：批次彙總與提醒', () => {
  it('rollupBatchStatus 依出貨單狀態彙總；已取消的出貨單不算', () => {
    expect(rollupBatchStatus([])).toBe('PENDING');
    expect(rollupBatchStatus(['CANCELLED'])).toBe('PENDING');
    expect(rollupBatchStatus(['PENDING', 'PACKED'])).toBe('PENDING');
    expect(rollupBatchStatus(['PACKED', 'PACKED'])).toBe('PACKED');
    expect(rollupBatchStatus(['PACKED', 'SHIPPED'])).toBe('SHIPPED');
    expect(rollupBatchStatus(['DELIVERED', 'PENDING'])).toBe('SHIPPED');
    expect(rollupBatchStatus(['DELIVERED', 'DELIVERED', 'CANCELLED'])).toBe('DELIVERED');
    expect(rollupBatchStatus(['DELIVERED', 'EXCEPTION', 'SHIPPED'])).toBe('EXCEPTION');
  });
  it('狀態轉移表：終點不可再轉，且所有狀態都有定義', () => {
    expect(Object.keys(SHIPMENT_TRANSITIONS).sort()).toEqual([...SHIPMENT_STATUSES].sort());
    expect(SHIPMENT_TRANSITIONS.DELIVERED).toEqual([]);
    expect(SHIPMENT_TRANSITIONS.CANCELLED).toEqual([]);
    expect(SHIPMENT_TRANSITIONS.PENDING).not.toContain('DELIVERED');
  });
  it('fulfillmentWarnings：履約中沒有批次、異常、逾期未出、結算中未送達、未簽收', () => {
    const today = '2026-11-02';
    expect(fulfillmentWarnings('FULFILLING', [], [], today).map((x) => x.code)).toEqual(['NO_BATCH']);
    expect(fulfillmentWarnings('RUNNING', [], [], today)).toEqual([]);
    const sh = (id: string, status: string, plannedDate: string | null = null, receiptConfirmedAt: string | null = null) => ({ id, batchId: 'B', status, plannedDate, receiptConfirmedAt });
    const w1 = fulfillmentWarnings('PENDING_SETTLEMENT', [{ id: 'B', status: 'EXCEPTION' }], [sh('S1', 'EXCEPTION'), sh('S2', 'PACKED', '2026-10-30'), sh('S3', 'DELIVERED'), sh('S4', 'CANCELLED', '2026-10-01')], today);
    expect(w1.map((x) => x.code).sort()).toEqual(['EXCEPTION', 'LATE_SHIP', 'UNCONFIRMED_RECEIPT', 'UNDELIVERED']);
    expect(w1.find((x) => x.code === 'UNCONFIRMED_RECEIPT')?.severity).toBe('INFO');
    expect(w1.find((x) => x.code === 'LATE_SHIP')?.refId).toBe('S2');
  });
});

describe('出貨批次與出貨單：完整流程', () => {
  let batchId: string, s1: string, s2: string;

  it('訂單出貨批次在「草稿」檔期建立會被擋；寄樣批次可以', async () => {
    await expect(createBatch(w.editor, campDraft, { kind: 'ORDER', label: '太早' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const r = await createBatch(w.editor, campDraft, { kind: 'SAMPLE', label: '寄樣給團主', plannedShipDate: dayOffset(1) });
    expect(r.id).toMatch(/^FBT-\d{6}$/);
    const back = await getBatch(w.editor, r.id);
    expect(back).toMatchObject({ kind: 'SAMPLE', label: '寄樣給團主', status: 'PENDING', campaignId: campDraft, shipmentCount: 0 });
  });

  it('建立批次與出貨單；寫入後讀回一致，批次狀態隨出貨單彙總', async () => {
    batchId = (await createBatch(w.editor, campRun, { label: '第一批出貨', plannedShipDate: dayOffset(3), note: '內部：優先處理' })).id;
    const a = await addShipment(w.editor, batchId, { skuId: product.skuIds[0], quantity: 30, carrier: '黑貓', trackingNo: 'BC-0001', plannedDate: dayOffset(3) });
    const b = await addShipment(w.editor, batchId, { skuId: product.skuIds[0], quantity: 20, carrier: '新竹', trackingNo: 'HC-0002' });
    s1 = a.id; s2 = b.id;
    expect(s1).toMatch(/^SHP-\d{6}$/);
    const back = await getBatch(w.editor, batchId);
    expect(back).toMatchObject({ status: 'PENDING', shipmentCount: 2, totalQuantity: 50, note: '內部：優先處理' });
    const sh = back.shipments as Record<string, unknown>[];
    expect(sh.map((x) => x['id'])).toEqual([s1, s2]);
    expect(sh[0]).toMatchObject({ quantity: 30, carrier: '黑貓', trackingNo: 'BC-0001', status: 'PENDING', skuCode: 'A' });
  });

  it('規格必須屬於該檔期；相同物流商＋追蹤碼不可重複（大小寫不分）', async () => {
    await expect(addShipment(w.editor, batchId, { skuId: product.skuIds[1], quantity: 1 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(addShipment(w.editor, batchId, { quantity: 1, carrier: '黑貓', trackingNo: 'bc-0001' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(addShipment(w.editor, batchId, { quantity: 1, trackingNo: 'NO-CARRIER' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(addShipment(w.editor, batchId, { quantity: 0, carrier: 'X' })).rejects.toThrow();
  });

  it('狀態只能依轉移表走：不可跳過出貨直接簽收；出貨前要有物流商；異常／取消要原因', async () => {
    await expect(setShipmentStatus(w.editor, s1, { to: 'DELIVERED' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(setShipmentStatus(w.editor, s1, { to: 'EXCEPTION' })).rejects.toMatchObject({ code: 'VALIDATION' });
    const noCarrier = await addShipment(w.editor, batchId, { quantity: 5 });
    await setShipmentStatus(w.editor, noCarrier.id, { to: 'PACKED' });
    await expect(setShipmentStatus(w.editor, noCarrier.id, { to: 'SHIPPED' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await setShipmentStatus(w.editor, noCarrier.id, { to: 'SHIPPED', carrier: '自送' });
    const back = await getBatch(w.editor, batchId);
    expect((back.shipments as Record<string, unknown>[]).find((x) => x['id'] === noCarrier.id)).toMatchObject({ status: 'SHIPPED', carrier: '自送' });
    await setShipmentStatus(w.editor, noCarrier.id, { to: 'CANCELLED', reason: '數量搞錯' });
    expect((await getBatch(w.editor, batchId)).shipmentCount).toBe(2);   // 已取消的不算
  });

  it('PACKED → SHIPPED → DELIVERED：批次狀態跟著變；日期不可是未來、送達不可早於出貨', async () => {
    expect((await setShipmentStatus(w.editor, s1, { to: 'PACKED' })).batchStatus).toBe('PENDING');   // 另一張還是 PENDING
    expect((await setShipmentStatus(w.editor, s2, { to: 'PACKED' })).batchStatus).toBe('PACKED');
    await expect(setShipmentStatus(w.editor, s1, { to: 'SHIPPED', date: dayOffset(2) })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await setShipmentStatus(w.editor, s1, { to: 'SHIPPED', date: dayOffset(-3) })).batchStatus).toBe('SHIPPED');
    await expect(setShipmentStatus(w.editor, s1, { to: 'DELIVERED', date: dayOffset(-5) })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(setShipmentStatus(w.editor, s1, { to: 'DELIVERED', date: dayOffset(1) })).rejects.toMatchObject({ code: 'VALIDATION' });
    const d = await setShipmentStatus(w.editor, s1, { to: 'DELIVERED', date: dayOffset(-1) });
    expect(d).toMatchObject({ status: 'DELIVERED', batchStatus: 'SHIPPED' });   // s2 還沒送達
    const row = ((await getBatch(w.editor, batchId)).shipments as Record<string, unknown>[]).find((x) => x['id'] === s1);
    expect(row).toMatchObject({ status: 'DELIVERED', shippedDate: dayOffset(-3), deliveredDate: dayOffset(-1) });
    // 重送同一個狀態不會出錯也不會改資料（冪等）
    expect(await setShipmentStatus(w.editor, s1, { to: 'DELIVERED' })).toMatchObject({ unchanged: true });
  });

  it('異常：必填原因、批次變異常、通知負責人且只通知一次；處理後可繼續', async () => {
    await setShipmentStatus(w.editor, s2, { to: 'SHIPPED' });
    const r = await setShipmentStatus(w.editor, s2, { to: 'EXCEPTION', reason: '貨運遺失，待查' });
    expect(r.batchStatus).toBe('EXCEPTION');
    const n = await query(`SELECT recipient_user_id, channel, subject FROM notifications WHERE organization_id=$1 AND entity_id=$2 AND dedupe_key LIKE 'shipment_exception:%'`, [w.orgId, s2]);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ recipient_user_id: w.editor.userId, channel: 'IN_APP' });
    await setShipmentStatus(w.editor, s2, { to: 'SHIPPED' });   // 重新寄出
    expect((await getBatch(w.editor, batchId)).status).toBe('SHIPPED');
    const sum = await getCampaignFulfillment(w.editor, campRun);
    expect(sum.warnings.map((x) => x.code)).toContain('UNCONFIRMED_RECEIPT');
  });

  it('簽收確認：未送達不能簽；簽收後重送不覆蓋；全部送達後批次為 DELIVERED', async () => {
    await expect(confirmReceipt(w.editor, s2, { signer: '王先生' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(confirmReceipt(w.editor, s1, { signer: '' })).rejects.toThrow();
    const c1 = await confirmReceipt(w.editor, s1, { signer: '王先生', note: '管理室代收' });
    expect(c1).toMatchObject({ confirmed: true, unchanged: false });
    expect(await confirmReceipt(w.editor, s1, { signer: '別人' })).toMatchObject({ unchanged: true, receiptSigner: '王先生' });
    await setShipmentStatus(w.editor, s2, { to: 'DELIVERED' });
    const back = await getBatch(w.editor, batchId);
    expect(back).toMatchObject({ status: 'DELIVERED', deliveredCount: 2, confirmedCount: 1 });
    const row = (back.shipments as Record<string, unknown>[]).find((x) => x['id'] === s1);
    expect(row).toMatchObject({ receiptSigner: '王先生', receiptNote: '管理室代收' });
    expect(row?.['receiptConfirmedAt']).toBeTruthy();
  });

  it('已送達／已取消的出貨單不可再改；送達後不可退回出貨中', async () => {
    await expect(updateShipment(w.editor, s1, { quantity: 99 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(setShipmentStatus(w.editor, s1, { to: 'SHIPPED' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(setShipmentStatus(w.editor, s1, { to: 'CANCELLED', reason: '想取消' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('編輯批次／出貨單：樂觀鎖版本衝突；空字串清空欄位；已出貨不可改數量', async () => {
    const b = await createBatch(w.editor, campRun, { label: '第二批' });
    const sh = await addShipment(w.editor, b.id, { quantity: 10, carrier: '宅配通', note: '備註' });
    const before = await getBatch(w.editor, b.id);
    const u = await updateBatch(w.editor, b.id, { label: '第二批（改）', plannedShipDate: dayOffset(5), version: before.version as number });
    expect(u.unchanged).toBe(false);
    await expect(updateBatch(w.editor, b.id, { label: '舊版本', version: before.version as number })).rejects.toMatchObject({ code: 'CONFLICT' });
    const cleared = await updateBatch(w.editor, b.id, { plannedShipDate: '' as never });
    expect(cleared.unchanged).toBe(false);
    expect(await getBatch(w.editor, b.id)).toMatchObject({ label: '第二批（改）', plannedShipDate: null });
    await updateShipment(w.editor, sh.id, { quantity: 12, carrier: '', note: '' as never });
    expect(((await getBatch(w.editor, b.id)).shipments as Record<string, unknown>[])[0]).toMatchObject({ quantity: 12, carrier: null, note: null });
    await updateShipment(w.editor, sh.id, { carrier: '宅配通' });
    await setShipmentStatus(w.editor, sh.id, { to: 'PACKED' });
    await setShipmentStatus(w.editor, sh.id, { to: 'SHIPPED' });
    await expect(updateShipment(w.editor, sh.id, { quantity: 99 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await updateShipment(w.editor, sh.id, { trackingNo: 'ZT-1' })).toMatchObject({ unchanged: false });
  });

  it('取消批次：需原因、連動取消未送達的出貨單、已有送達者不可整批取消、取消後唯讀', async () => {
    await expect(cancelBatch(w.editor, batchId, '想取消')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });   // 有已送達的
    const b = await createBatch(w.editor, campRun, { label: '要取消的批次' });
    const a = await addShipment(w.editor, b.id, { quantity: 3, carrier: '黑貓', trackingNo: 'CXL-1' });
    await addShipment(w.editor, b.id, { quantity: 4 });
    await expect(cancelBatch(w.editor, b.id, '  ')).rejects.toMatchObject({ code: 'VALIDATION' });
    const r = await cancelBatch(w.editor, b.id, '廠商缺貨');
    expect(r).toMatchObject({ status: 'CANCELLED', cancelledShipments: 2 });
    const back = await getBatch(w.editor, b.id);
    expect(back).toMatchObject({ status: 'CANCELLED', cancelReason: '廠商缺貨', shipmentCount: 0 });
    expect((back.shipments as Record<string, unknown>[]).every((x) => x['status'] === 'CANCELLED' && String(x['cancelReason']).startsWith('批次取消'))).toBe(true);
    expect(await cancelBatch(w.editor, b.id, '再按一次')).toMatchObject({ unchanged: true });
    await expect(addShipment(w.editor, b.id, { quantity: 1 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(setShipmentStatus(w.editor, a.id, { to: 'PACKED' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    // 取消後追蹤碼可被重用
    const reuse = await addShipment(w.editor, batchId, { quantity: 1, carrier: '黑貓', trackingNo: 'CXL-1' });
    expect(reuse.id).toMatch(/^SHP-/);
  });

  it('檔期取消／暫緩／結案後履約資料唯讀（仍可讀取）', async () => {
    await setStatus(campOther, 'ON_HOLD');
    await expect(createBatch(w.manager, campOther, { label: '暫緩中' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await getCampaignFulfillment(w.manager, campOther)).writable).toBe(false);
    await setStatus(campOther, 'RUNNING');
    expect((await getCampaignFulfillment(w.manager, campOther)).writable).toBe(true);
  });

  it('結算中仍有未送達出貨單會出現 WARN，但不阻擋任何動作', async () => {
    await setStatus(campSettle, 'FULFILLING');
    const none = await getCampaignFulfillment(w.editor, campSettle);
    expect(none.warnings.map((x) => x.code)).toContain('NO_BATCH');
    const b = await createBatch(w.editor, campSettle, { label: '結算前' });
    await addShipment(w.editor, b.id, { quantity: 1, carrier: '黑貓', trackingNo: 'WARN-1' });
    await setStatus(campSettle, 'PENDING_SETTLEMENT');
    const sum = await getCampaignFulfillment(w.editor, campSettle);
    expect(sum.warnings.map((x) => x.code)).toContain('UNDELIVERED');
    expect(sum.warnings.every((x) => x.severity === 'WARN' || x.severity === 'INFO')).toBe(true);
  });

  it('每個寫入都有稽核紀錄（含前後值）；資料不能實體刪除', async () => {
    const a = await query(`SELECT action, before_data, after_data FROM audit_logs WHERE organization_id=$1 AND entity_id=$2 ORDER BY id`, [w.orgId, s1]);
    expect(a.map((x) => x.action)).toEqual(expect.arrayContaining(['shipment.create', 'shipment.status', 'shipment.receipt']));
    const st = a.filter((x) => x.action === 'shipment.status');
    expect(st[0].before_data).toMatchObject({ status: 'PENDING' });
    expect(st[0].after_data).toMatchObject({ status: 'PACKED' });
    const ba = await query(`SELECT action FROM audit_logs WHERE organization_id=$1 AND entity_id=$2`, [w.orgId, batchId]);
    expect(ba.map((x) => x.action)).toEqual(expect.arrayContaining(['fulfillment_batch.create', 'fulfillment_batch.status']));
    for (const t of ['shipments', 'fulfillment_batches']) {
      await expect(query(`DELETE FROM ${t} WHERE organization_id=$1`, [w.orgId]), t).rejects.toThrow(/physical delete forbidden/);
    }
  });
});

describe('庫存異動（append-only）', () => {
  const sku = () => product.skuIds[0];
  const balance = async (id = sku()) => ((await listStock(w.manager, URLQ({ campaignId: campRun }))).items as { skuId: string; balance: number }[]).find((x) => x.skuId === id)?.balance;

  it('期初庫存只能設一次；入庫／損耗的正負號要正確；庫存不可為負', async () => {
    await expect(adjustStock(w.editor, { skuId: sku(), delta: -5, reasonCode: 'INITIAL', reason: '期初' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(adjustStock(w.editor, { skuId: sku(), delta: 0, reasonCode: 'ADJUST', reason: '零' })).rejects.toThrow();
    await expect(adjustStock(w.editor, { skuId: sku(), delta: 5, reasonCode: 'ADJUST', reason: '  ' })).rejects.toThrow();
    const i = await adjustStock(w.editor, { skuId: sku(), delta: 100, reasonCode: 'INITIAL', reason: '期初盤點', campaignId: campRun });
    expect(i).toMatchObject({ balance: 100 });
    await expect(adjustStock(w.editor, { skuId: sku(), delta: 10, reasonCode: 'INITIAL', reason: '又一次期初' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(adjustStock(w.editor, { skuId: sku(), delta: 5, reasonCode: 'DAMAGE', reason: '正數損耗' })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await adjustStock(w.editor, { skuId: sku(), delta: -30, reasonCode: 'DAMAGE', reason: '運送破損' })).toMatchObject({ balance: 70 });
    await expect(adjustStock(w.editor, { skuId: sku(), delta: -71, reasonCode: 'ADJUST', reason: '超扣' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await balance()).toBe(70);   // 讀回：被擋下的異動沒有寫入
  });

  it('更正＝新增反向異動；同一筆只能更正一次；原紀錄保留；更正紀錄不能再被更正', async () => {
    const m = await adjustStock(w.editor, { skuId: sku(), delta: 20, reasonCode: 'RESTOCK', reason: '補貨' });
    expect(await balance()).toBe(90);
    const fix = await reverseMovement(w.editor, m.id, '數量打錯');
    expect(fix).toMatchObject({ reverses: m.id, balance: 70 });
    await expect(reverseMovement(w.editor, m.id, '再更正一次')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(reverseMovement(w.editor, fix.id, '更正更正')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(reverseMovement(w.editor, m.id, '')).rejects.toMatchObject({ code: 'VALIDATION' });
    const list = (await listMovements(w.manager, URLQ({ skuId: sku() }))).items as { id: string; delta: number; reversed: boolean; reasonCode: string }[];
    expect(list.find((x) => x.id === m.id)).toMatchObject({ delta: 20, reversed: true });
    expect(list.find((x) => x.id === fix.id)).toMatchObject({ delta: -20, reasonCode: 'CORRECTION' });
    expect(list.reduce((a, x) => a + x.delta, 0)).toBe(70);
  });

  it('更正會讓庫存變負時被擋下', async () => {
    const s = product.skuIds[1];
    const stock = await adjustStock(w.editor, { skuId: s, delta: 10, reasonCode: 'INITIAL', reason: '期初' });
    await adjustStock(w.editor, { skuId: s, delta: -8, reasonCode: 'ADJUST', reason: '盤虧' });
    await expect(reverseMovement(w.editor, stock.id, '期初打錯')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('資料庫層禁止改寫或刪除庫存異動', async () => {
    const [m] = await query(`SELECT id FROM inventory_movements WHERE organization_id=$1 LIMIT 1`, [w.orgId]);
    await expect(query(`UPDATE inventory_movements SET delta=999 WHERE id=$1`, [m.id])).rejects.toThrow(/append-only/);
    await expect(query(`DELETE FROM inventory_movements WHERE id=$1`, [m.id])).rejects.toThrow(/append-only/);
  });

  it('規格不存在回 404；未追蹤規格的庫存顯示為未建立', async () => {
    await expect(adjustStock(w.editor, { skuId: 'SKU-999999', delta: 1, reasonCode: 'RESTOCK', reason: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const rows = (await listStock(w.manager, URLQ({ campaignId: campRun }))).items as { skuId: string; tracked: boolean }[];
    expect(rows.find((x) => x.skuId === product.skuIds[0])?.tracked).toBe(true);
  });
});

describe('API：權限、資料範圍與重複送出', () => {
  let batchId: string, shipId: string;
  let editorC: Client, editor2C: Client, managerC: Client, financeC: Client, hostC: Client, hostBC: Client, vendorC: Client, vendorBC: Client, anon: Client;

  beforeAll(async () => {
    [editorC, editor2C, managerC, financeC, hostC, hostBC, vendorC, vendorBC] = await Promise.all([w.editor, w.editor2, w.manager, w.finance, hostAUser, hostBUser, vendorAUser, vendorBUser].map((a) => Client.forActor(a)));
    anon = new Client();
    batchId = (await createBatch(w.editor, campRun, { label: 'API 測試批', note: '內部機密備註' })).id;
    shipId = (await addShipment(w.editor, batchId, { quantity: 8, carrier: '黑貓', trackingNo: 'API-1', note: '倉內備註' })).id;
  });

  it('未登入一律 401', async () => {
    for (const p of ['/fulfillment/batches', `/fulfillment/batches/${batchId}`, `/campaigns/${campRun}/fulfillment`, '/inventory/stock', '/inventory/movements']) {
      expect((await anon.call('GET', p)).status, p).toBe(401);
    }
    expect((await anon.call('POST', `/campaigns/${campRun}/fulfillment/batches`, { label: 'x' })).status).toBe(401);
  });

  it('營運主管／負責的小編可讀寫；非負責的小編看不到該檔期（404）', async () => {
    const ok = await editorC.call('GET', `/campaigns/${campRun}/fulfillment`);
    expect(ok.status).toBe(200);
    expect(ok.data.batches.length).toBeGreaterThan(0);
    expect((await managerC.call('GET', `/fulfillment/batches/${batchId}`)).status).toBe(200);
    expect((await editor2C.call('GET', `/campaigns/${campRun}/fulfillment`)).status).toBe(404);
    expect((await editor2C.call('GET', `/fulfillment/batches/${batchId}`)).status).toBe(404);
    expect((await editor2C.call('POST', `/fulfillment/shipments/${shipId}/status`, { to: 'PACKED' })).status).toBe(404);
    expect((await editor2C.call('GET', `/fulfillment/batches?campaignId=${campRun}`)).data.items).toHaveLength(0);
  });

  it('財務可讀不可寫', async () => {
    expect((await financeC.call('GET', `/campaigns/${campRun}/fulfillment`)).status).toBe(200);
    expect((await financeC.call('GET', '/inventory/stock')).status).toBe(200);
    expect((await financeC.call('POST', `/campaigns/${campRun}/fulfillment/batches`, { label: '財務想建' })).status).toBe(403);
    expect((await financeC.call('POST', `/fulfillment/shipments/${shipId}/status`, { to: 'PACKED' })).status).toBe(403);
    expect((await financeC.call('POST', '/inventory/movements', { skuId: product.skuIds[0], delta: 1, reasonCode: 'RESTOCK', reason: 'x' })).status).toBe(403);
  });

  it('團主：只讀自己檔期、看不到內部備註、不能寫；別人的檔期 404；看不到庫存', async () => {
    const r = await hostC.call('GET', `/campaigns/${campRun}/fulfillment`);
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.data);
    expect(text).not.toContain('內部機密備註');
    expect(text).not.toContain('倉內備註');
    expect(r.data.batches.find((b: { id: string }) => b.id === batchId).shipments[0]).toMatchObject({ carrier: '黑貓', trackingNo: 'API-1' });
    expect((await hostC.call('GET', `/fulfillment/batches/${batchId}`)).status).toBe(200);
    expect((await hostBC.call('GET', `/fulfillment/batches/${batchId}`)).status).toBe(404);
    expect((await hostBC.call('GET', `/campaigns/${campRun}/fulfillment`)).status).toBe(404);
    expect((await hostC.call('POST', `/fulfillment/shipments/${shipId}/status`, { to: 'PACKED' })).status).toBe(403);
    expect((await hostC.call('POST', `/campaigns/${campRun}/fulfillment/batches`, { label: 'x' })).status).toBe(403);
    expect((await hostC.call('GET', '/inventory/stock')).status).toBe(403);
    expect((await hostC.call('GET', '/inventory/movements')).status).toBe(403);
  });

  it('廠商：只讀自己品牌的檔期，其他廠商 404，不能寫，看不到庫存', async () => {
    const r = await vendorC.call('GET', `/campaigns/${campRun}/fulfillment`);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.data)).not.toContain('內部機密備註');
    expect((await vendorBC.call('GET', `/campaigns/${campRun}/fulfillment`)).status).toBe(404);
    expect((await vendorBC.call('GET', `/fulfillment/batches/${batchId}`)).status).toBe(404);
    expect((await vendorBC.call('GET', '/fulfillment/batches')).data.items.every((b: { campaignId: string }) => b.campaignId !== campRun)).toBe(true);
    expect((await vendorC.call('POST', `/fulfillment/shipments/${shipId}/receipt`, { signer: '廠商' })).status).toBe(403);
    expect((await vendorC.call('GET', '/inventory/stock')).status).toBe(403);
  });

  it('API 寫入後讀回一致：狀態、簽收、列表', async () => {
    expect((await editorC.call('POST', `/fulfillment/shipments/${shipId}/status`, { to: 'PACKED' })).status).toBe(200);
    expect((await editorC.call('POST', `/fulfillment/shipments/${shipId}/status`, { to: 'SHIPPED' })).status).toBe(200);
    expect((await editorC.call('POST', `/fulfillment/shipments/${shipId}/status`, { to: 'DELIVERED' })).status).toBe(200);
    expect((await editorC.call('POST', `/fulfillment/shipments/${shipId}/receipt`, { signer: '陳小姐' })).status).toBe(200);
    const g = await editorC.call('GET', `/fulfillment/batches/${batchId}`);
    expect(g.data).toMatchObject({ status: 'DELIVERED', shipmentCount: 1, confirmedCount: 1 });
    expect(g.data.shipments[0]).toMatchObject({ status: 'DELIVERED', receiptSigner: '陳小姐' });
    const list = await editorC.call('GET', `/fulfillment/batches?campaignId=${campRun}&status=DELIVERED`);
    expect(list.data.items.map((b: { id: string }) => b.id)).toContain(batchId);
    const bad = await editorC.call('POST', `/fulfillment/shipments/${shipId}/status`, { to: 'NOT_A_STATUS' });
    expect(bad.status).toBe(422);
  });

  it('Idempotency-Key：重送不會重複建立；同 key 不同內容被拒；庫存調整同理', async () => {
    const key = `fbt-${Date.now()}`;
    const a = await editorC.call('POST', `/campaigns/${campRun}/fulfillment/batches`, { label: '冪等批次' }, { 'idempotency-key': key });
    const b = await editorC.call('POST', `/campaigns/${campRun}/fulfillment/batches`, { label: '冪等批次' }, { 'idempotency-key': key });
    expect(a.status).toBe(201);
    expect(b.data.id).toBe(a.data.id);
    expect(b.data.replayed).toBe(true);
    const diff = await editorC.call('POST', `/campaigns/${campRun}/fulfillment/batches`, { label: '不同內容' }, { 'idempotency-key': key });
    expect(diff.status).toBe(422);
    const n = await query(`SELECT count(*)::int AS n FROM fulfillment_batches WHERE organization_id=$1 AND label='冪等批次'`, [w.orgId]);
    expect(n[0].n).toBe(1);

    const k2 = `inv-${Date.now()}`;
    const before = (await editorC.call('GET', `/inventory/stock?campaignId=${campRun}`)).data.items.find((x: { skuId: string }) => x.skuId === product.skuIds[0]).balance;
    const body = { skuId: product.skuIds[0], delta: 5, reasonCode: 'RESTOCK', reason: '冪等補貨' };
    const i1 = await editorC.call('POST', '/inventory/movements', body, { 'idempotency-key': k2 });
    const i2 = await editorC.call('POST', '/inventory/movements', body, { 'idempotency-key': k2 });
    expect(i1.status).toBe(201);
    expect(i2.data.id).toBe(i1.data.id);
    const after = (await editorC.call('GET', `/inventory/stock?campaignId=${campRun}`)).data.items.find((x: { skuId: string }) => x.skuId === product.skuIds[0]).balance;
    expect(after - before).toBe(5);   // 只加了一次

    const sk = `ship-${Date.now()}`;
    const s1 = await editorC.call('POST', `/fulfillment/batches/${batchId}/shipments`, { quantity: 2, carrier: '黑貓', trackingNo: 'IDEM-1' }, { 'idempotency-key': sk });
    const s2 = await editorC.call('POST', `/fulfillment/batches/${batchId}/shipments`, { quantity: 2, carrier: '黑貓', trackingNo: 'IDEM-1' }, { 'idempotency-key': sk });
    expect(s1.status).toBe(201);
    expect(s2.data.id).toBe(s1.data.id);
  });

  it('庫存更正 API：需原因；重複更正回 409', async () => {
    const m = await editorC.call('POST', '/inventory/movements', { skuId: product.skuIds[0], delta: 3, reasonCode: 'RESTOCK', reason: '要更正' });
    expect((await editorC.call('POST', `/inventory/movements/${m.data.id}/correct`, { reason: '' })).status).toBe(422);
    const ok = await editorC.call('POST', `/inventory/movements/${m.data.id}/correct`, { reason: '打錯' });
    expect(ok.status).toBe(201);
    expect((await editorC.call('POST', `/inventory/movements/${m.data.id}/correct`, { reason: '又更正' })).status).toBe(409);
  });
});
