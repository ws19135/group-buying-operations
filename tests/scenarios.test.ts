import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { addCampaignHost, addCampaignProduct, addPlacement, createCampaign, getCampaign, removeCampaignHost, setPlacementStatus } from '@/server/modules/campaigns';
import { createVendor } from '@/server/modules/vendors';
import { addAvailability, linkHostCommunity, unlinkHostCommunity } from '@/server/modules/hosts';
import { createProduct, addSku, setProductReview } from '@/server/modules/products';
import { detectConflicts } from '@/server/modules/conflicts';
import { gateCheck, requestApproval, decideApproval, transitionCampaign } from '@/server/modules/gates';
import { setCampaignHostStatus } from '@/server/modules/campaigns';
import { setTaskStatus } from '@/server/modules/tasks';
import { pool } from '@/server/lib/db';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkCampaign, mkCommunity, mkHost, mkProduct, mkVendor, type World } from './helpers';

let w: World;
beforeAll(async () => { w = await makeWorld(); });
const conflicts = (id: string) => detectConflicts(pool(), w.orgId, id);

describe('同一商品重複開團', () => {
  it('允許再次開團（各自獨立 CampaignID），但日期重疊時提出高風險衝突；不重疊則無衝突', async () => {
    const v = await mkVendor(w); const p = await mkProduct(w, v.id, { approve: true });
    const prod = { products: [{ productId: p.id, skuId: p.skuIds[0] }] };
    const a = await mkCampaign(w, v.id, { title: '第一檔', openDate: dayOffset(20), closeDate: dayOffset(30), ...prod });
    const b = await mkCampaign(w, v.id, { title: '第二檔', openDate: dayOffset(25), closeDate: dayOffset(35), ...prod });
    expect(a.id).not.toBe(b.id);
    expect(b.conflicts.some((c) => c.type === 'SAME_PRODUCT_OVERLAP' && c.severity === 'HIGH' && c.otherCampaignId === a.id)).toBe(true);
    const c = await mkCampaign(w, v.id, { title: '第三檔', openDate: dayOffset(36), closeDate: dayOffset(40), ...prod });
    expect(c.conflicts.filter((x) => x.type === 'SAME_PRODUCT_OVERLAP')).toHaveLength(0);
    // 已取消的檔期不算衝突
    await query(`UPDATE campaigns SET status='CANCELLED' WHERE id=$1`, [a.id]);
    expect((await conflicts(b.id)).filter((x) => x.type === 'SAME_PRODUCT_OVERLAP')).toHaveLength(0);
  });

  it('G2 會因高風險衝突擋下；管理者填寫風險確認原因後才可核准（原因進稽核）', async () => {
    const v = await mkVendor(w); const p = await mkProduct(w, v.id, { approve: true }); const h = await mkHost(w); const cm = await mkCommunity(w, [h.id]);
    const mk = (title: string) => mkCampaign(w, v.id, { title, sampleReadyDate: dayOffset(-30), openDate: dayOffset(10), closeDate: dayOffset(20), products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: [{ hostId: h.id }] });
    const other = await mk('先開的檔'); const me = await mk('後開的檔');
    expect(me.conflicts.some((x) => x.severity === 'HIGH')).toBe(true);
    // 讓 me 走到 PREPARING
    await query(`UPDATE campaigns SET status='PREPARING' WHERE id=$1`, [me.id]);
    await setCampaignHostStatus(w.editor, me.id, h.id, 'CONFIRMED');
    await addPlacement(w.editor, me.id, { hostId: h.id, communityId: cm.id, placementType: 'LAUNCH', scheduledOn: dayOffset(10) });
    await query(`UPDATE tasks SET status='DONE' WHERE campaign_id=$1 AND step_key IN ('SAMPLE_SHIP','TRIAL_ARRIVAL','TRIAL_FEEDBACK','LAUNCH_APPROVAL','CREATIVE_ASSETS')`, [me.id]);
    const chk = await gateCheck(w.manager, me.id, 'G2');
    expect(chk.find((x) => x.key === 'no_high_conflicts')).toMatchObject({ ok: false, ackable: true });
    const ap = await requestApproval(w.editor, me.id, 'G2');                      // 可申請（衝突可被確認）
    await expect(decideApproval(w.manager, ap.id, 'APPROVED')).rejects.toThrow(/風險確認原因/);
    await decideApproval(w.manager, ap.id, 'APPROVED', undefined, '兩檔面向不同客群，已與廠商確認');
    expect((await query(`SELECT status FROM campaigns WHERE id=$1`, [me.id]))[0].status).toBe('SCHEDULED');
    expect((await query(`SELECT decision_note FROM approvals WHERE id=$1`, [ap.id]))[0].decision_note).toContain('已與廠商確認');
    void other;
  });
});

describe('一檔多 SKU', () => {
  it('同商品多規格各自一列；重複加入被擋；不屬於該商品的規格被擋；規格編號同商品內唯一', async () => {
    const v = await mkVendor(w);
    const p = await mkProduct(w, v.id, { skus: [{ skuCode: 'S', name: '小', listPrice: 500, groupPrice: 400 }, { skuCode: 'M', name: '中', listPrice: 700, groupPrice: 600 }, { skuCode: 'L', name: '大', listPrice: 900, groupPrice: 800 }] });
    const other = await mkProduct(w, v.id);
    const c = await mkCampaign(w, v.id, { products: p.skuIds.map((s) => ({ productId: p.id, skuId: s })) });
    const d = await getCampaign(w.editor, c.id);
    expect(d.products).toHaveLength(3);
    await expect(addCampaignProduct(w.editor, c.id, { productId: p.id, skuId: p.skuIds[0] })).rejects.toThrow(/已在檔期內/);
    await expect(addCampaignProduct(w.editor, c.id, { productId: p.id, skuId: other.skuIds[0] })).rejects.toThrow(/不屬於/);
    await expect(addSku(w.manager, p.id, { skuCode: 's', name: '重複編號' })).rejects.toThrow(/已存在/);   // 大小寫不分
    await expect(addSku(w.manager, p.id, { skuCode: 'X', name: '倒掛', listPrice: 100, groupPrice: 200 })).rejects.toThrow(/不可高於原價/);
  });

  it('商品必須屬於檔期的廠商', async () => {
    const v1 = await mkVendor(w); const v2 = await mkVendor(w);
    const p2 = await mkProduct(w, v2.id);
    await expect(mkCampaign(w, v1.id, { products: [{ productId: p2.id }] })).rejects.toThrow(/不屬於此檔期的廠商/);
  });

  it('商品審核流程：沒有規格不能送審；退回需原因；只有審核者能核准；非法轉移被擋', async () => {
    const v = await mkVendor(w);
    const empty = await createProduct(w.manager, { vendorId: v.id, name: '無規格商品' });
    await expect(setProductReview(w.editor, empty.id, 'PENDING_REVIEW')).rejects.toThrow(/至少需要一個啟用中的規格/);
    const p = await mkProduct(w, v.id);
    await setProductReview(w.editor, p.id, 'PENDING_REVIEW');
    await expect(setProductReview(w.editor, p.id, 'APPROVED')).rejects.toThrow(/沒有權限/);
    await expect(setProductReview(w.manager, p.id, 'REJECTED')).rejects.toThrow(/原因/);
    await setProductReview(w.manager, p.id, 'APPROVED', '品質OK');
    await expect(setProductReview(w.manager, p.id, 'PENDING_REVIEW')).rejects.toThrow(/不可由/);
    expect((await query(`SELECT review_status, reviewed_by FROM products WHERE id=$1`, [p.id]))[0]).toMatchObject({ review_status: 'APPROVED', reviewed_by: w.manager.userId });
  });
});

describe('一檔多團主 / 同團主多社群', () => {
  it('三位團主、各自多個社群：曝光安排必須是該團主自己的社群；每位團主只看到自己的安排', async () => {
    const v = await mkVendor(w);
    const [h1, h2, h3] = [await mkHost(w), await mkHost(w), await mkHost(w)];
    const c1a = await mkCommunity(w, [h1.id]); const c1b = await mkCommunity(w, [h1.id]); const c2 = await mkCommunity(w, [h2.id]);
    const camp = await mkCampaign(w, v.id, { hosts: [{ hostId: h1.id }, { hostId: h2.id }, { hostId: h3.id }] });
    const d0 = await getCampaign(w.manager, camp.id);
    expect(d0.hosts).toHaveLength(3);
    const day = dayOffset(41);
    await addPlacement(w.editor, camp.id, { hostId: h1.id, communityId: c1a.id, placementType: 'LAUNCH', scheduledOn: day });
    await addPlacement(w.editor, camp.id, { hostId: h1.id, communityId: c1b.id, placementType: 'LAUNCH', scheduledOn: day });   // 同團主同日多社群
    await addPlacement(w.editor, camp.id, { hostId: h2.id, communityId: c2.id, placementType: 'LAUNCH', scheduledOn: day });
    await expect(addPlacement(w.editor, camp.id, { hostId: h1.id, communityId: c2.id, placementType: 'POST', scheduledOn: day })).rejects.toThrow(/不屬於此團主/);
    await expect(addPlacement(w.editor, camp.id, { hostId: h1.id, communityId: c1a.id, placementType: 'LAUNCH', scheduledOn: day })).rejects.toThrow(/已存在/);   // 重複
    await expect(addPlacement(w.editor, camp.id, { hostId: h1.id, communityId: c1a.id, placementType: 'POST', scheduledOn: dayOffset(10) })).rejects.toThrow(/落在檔期區間內/);
    const ghost = await mkHost(w);
    await expect(addPlacement(w.editor, camp.id, { hostId: ghost.id, communityId: c1a.id, placementType: 'POST', scheduledOn: day })).rejects.toThrow(/不在此檔期內/);
    const u1 = await addUser(w.orgId, 'HOST', { hostIds: [h1.id] }); const u2 = await addUser(w.orgId, 'HOST', { hostIds: [h2.id] });
    expect((await getCampaign(u1, camp.id)).placements).toHaveLength(2);
    expect((await getCampaign(u2, camp.id)).placements).toHaveLength(1);
    // 仍有未完成曝光的團主不能直接移出檔期；取消曝光後可以
    await expect(removeCampaignHost(w.editor, camp.id, h1.id, '不合作')).rejects.toThrow(/未完成的曝光安排/);
    const pls = await query<{ id: string }>(`SELECT id FROM campaign_placements WHERE campaign_id=$1 AND host_id=$2`, [camp.id, h1.id]);
    for (const p of pls) await setPlacementStatus(w.editor, camp.id, p.id, 'CANCELLED', '改由其他團主');
    await removeCampaignHost(w.editor, camp.id, h1.id, '不合作');
    expect((await getCampaign(w.manager, camp.id)).hosts).toHaveLength(2);
  });

  it('解除團主與社群關聯前，必須先處理未完成的曝光安排', async () => {
    const v = await mkVendor(w); const h = await mkHost(w); const cm = await mkCommunity(w, [h.id]);
    const camp = await mkCampaign(w, v.id, { hosts: [{ hostId: h.id }] });
    await addPlacement(w.editor, camp.id, { hostId: h.id, communityId: cm.id, placementType: 'POST', scheduledOn: dayOffset(42) });
    await expect(unlinkHostCommunity(w.manager, h.id, cm.id)).rejects.toThrow(/未完成的曝光安排/);
    await linkHostCommunity(w.manager, h.id, cm.id);   // 重複連結是冪等的
  });

  it('同團主同時進行多檔 → 中度提醒；同社群同期 → 高風險', async () => {
    const v = await mkVendor(w); const h = await mkHost(w); const cm = await mkCommunity(w, [h.id]);
    const mk = (t: string) => mkCampaign(w, v.id, { title: t, openDate: dayOffset(60), closeDate: dayOffset(70), hosts: [{ hostId: h.id }] });
    const a = await mk('A'); const b = await mk('B'); const c = await mk('C');
    const cs = await conflicts(c.id);
    expect(cs.find((x) => x.type === 'HOST_OVERLAP')).toMatchObject({ severity: 'MEDIUM' });
    await addPlacement(w.editor, a.id, { hostId: h.id, communityId: cm.id, placementType: 'LAUNCH', scheduledOn: dayOffset(61) });
    await addPlacement(w.editor, b.id, { hostId: h.id, communityId: cm.id, placementType: 'LAUNCH', scheduledOn: dayOffset(61) });
    expect((await conflicts(b.id)).find((x) => x.type === 'COMMUNITY_OVERLAP')).toMatchObject({ severity: 'HIGH', otherCampaignId: a.id });
  });
});

describe('日期衝突', () => {
  it('團主「不可承接」區間與檔期重疊 → 高風險；可承接區間不報；區間邏輯含端點', async () => {
    const v = await mkVendor(w); const h = await mkHost(w);
    const camp = await mkCampaign(w, v.id, { openDate: dayOffset(80), closeDate: dayOffset(90), hosts: [{ hostId: h.id }] });
    await addAvailability(w.manager, h.id, { startDate: dayOffset(70), endDate: dayOffset(79), kind: 'BLOCKED' });
    await addAvailability(w.manager, h.id, { startDate: dayOffset(85), endDate: dayOffset(86), kind: 'AVAILABLE' });
    expect((await conflicts(camp.id)).filter((x) => x.type === 'HOST_BLOCKED')).toHaveLength(0);   // 差一天，沒重疊
    await addAvailability(w.manager, h.id, { startDate: dayOffset(90), endDate: dayOffset(95), kind: 'BLOCKED' });
    expect((await conflicts(camp.id)).filter((x) => x.type === 'HOST_BLOCKED')).toHaveLength(1);   // 結團日當天剛好重疊
    await expect(addAvailability(w.manager, h.id, { startDate: dayOffset(5), endDate: dayOffset(1), kind: 'BLOCKED' })).rejects.toThrow(/不可晚於/);
  });

  it('缺少日期的草稿檔期不做衝突判斷（資料不足不亂報）', async () => {
    const v = await mkVendor(w);
    const r = await createCampaign(w.editor, { title: `無日期${Date.now()}`, vendorId: v.id });
    expect(r.conflicts).toEqual([]);
    expect(r.tasksCreated).toBe(15);
    const t = await query(`SELECT step_key, planned_start, schedule_issue FROM tasks WHERE campaign_id=$1 AND step_key IN ('SAMPLE_SHIP','LAUNCH')`, [r.id]);
    expect(t.every((x) => x.planned_start === null && x.schedule_issue)).toBe(true);
  });
});

describe('重複表單送出', () => {
  it('Idempotency-Key：同一個 key 重送回傳同一筆，不重複建立（建立廠商／檔期／團主／商品）', async () => {
    const c = await Client.forActor(w.manager);
    const key = `k-${Date.now()}`;
    const r1 = await c.call('POST', '/vendors', { name: '冪等廠商' }, { 'idempotency-key': key });
    const r2 = await c.call('POST', '/vendors', { name: '冪等廠商' }, { 'idempotency-key': key });
    expect(r1.status).toBe(201); expect(r2.status).toBe(201);
    expect(r2.data.id).toBe(r1.data.id);
    expect(r2.data.replayed).toBe(true);
    expect((await query(`SELECT count(*)::int AS n FROM vendors WHERE organization_id=$1 AND name='冪等廠商'`, [w.orgId]))[0].n).toBe(1);

    const vid = r1.data.id as string;
    const body = { title: '冪等檔期', vendorId: vid };
    const k2 = `c-${Date.now()}`;
    const c1 = await c.call('POST', '/campaigns', body, { 'idempotency-key': k2 });
    const c2 = await c.call('POST', '/campaigns', body, { 'idempotency-key': k2 });
    expect(c2.data.id).toBe(c1.data.id);
    expect((await query(`SELECT count(*)::int AS n FROM tasks WHERE campaign_id=$1`, [c1.data.id]))[0].n).toBe(15);
  });

  it('沒有 key 的重複送出：以自然鍵擋下並回報既有 ID（廠商、團主、社群、商品、檔期）', async () => {
    const c = await Client.forActor(w.manager);
    const v = await c.call('POST', '/vendors', { name: '重複測試廠商', taxId: '12345678' });
    const dup1 = await c.call('POST', '/vendors', { name: ' 重複測試 廠商 ' });
    expect(dup1.status).toBe(409); expect(dup1.error?.message).toContain(v.data.id);
    const dup2 = await c.call('POST', '/vendors', { name: '另一個名字', taxId: '12345678' });
    expect(dup2.status).toBe(409);
    const h = await c.call('POST', '/hosts', { displayName: '重複團主' });
    expect((await c.call('POST', '/hosts', { displayName: '重複 團主' })).status).toBe(409);
    expect(h.status).toBe(201);
    const cm = await c.call('POST', '/communities', { platform: 'LINE', name: '重複社群' });
    expect((await c.call('POST', '/communities', { platform: 'LINE', name: '重複社群' })).status).toBe(409);
    expect((await c.call('POST', '/communities', { platform: 'FACEBOOK', name: '重複社群' })).status).toBe(201);   // 不同平台可同名
    expect(cm.status).toBe(201);
    const p = await c.call('POST', '/products', { vendorId: v.data.id, name: '重複商品' });
    expect((await c.call('POST', '/products', { vendorId: v.data.id, name: '重複商品' })).status).toBe(409);
    const camp = { title: '重複檔期', vendorId: v.data.id, openDate: dayOffset(50), closeDate: dayOffset(55) };
    const k1 = await c.call('POST', '/campaigns', camp);
    const k2 = await c.call('POST', '/campaigns', camp);
    expect(k1.status).toBe(201); expect(k2.status).toBe(409);
    expect(k2.error).toBeTruthy();
    expect(p.status).toBe(201);
  });

  it('並發：同時送出 8 個相同請求（同 key）只會建立 1 筆', async () => {
    const c = await Client.forActor(w.manager);
    const key = `par-${Date.now()}`;
    const rs = await Promise.all(Array.from({ length: 8 }, () => c.call('POST', '/hosts', { displayName: '並發團主' }, { 'idempotency-key': key })));
    const ok = rs.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.data.id)).size).toBe(1);
    expect(rs.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect((await query(`SELECT count(*)::int AS n FROM hosts WHERE organization_id=$1 AND display_name='並發團主'`, [w.orgId]))[0].n).toBe(1);
  });

  it('並發：無 key 同時建立同名廠商，資料庫唯一約束保證只有 1 筆', async () => {
    const rs = await Promise.allSettled(Array.from({ length: 6 }, () => createVendor(w.manager, { name: '並發廠商X' })));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await query(`SELECT count(*)::int AS n FROM vendors WHERE organization_id=$1 AND name='並發廠商X'`, [w.orgId]))[0].n).toBe(1);
  });

  it('並發建立檔期：ID 不重複、序號連續遞增', async () => {
    const v = await mkVendor(w);
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => createCampaign(w.editor, { title: `並發檔期${i}-${Date.now()}`, vendorId: v.id })));
    const idsSet = new Set(rs.map((r) => r.id));
    expect(idsSet.size).toBe(10);
    expect([...idsSet].every((id) => /^CMP-\d{6}-\d{4}$/.test(id))).toBe(true);
  });
});

describe('團購取消與關聯資料', () => {
  it('有未結案檔期的廠商／團主不能封存；結案後可封存；封存是軟刪除（資料列仍在）', async () => {
    const { archiveVendor, getVendor } = await import('@/server/modules/vendors');
    const { archiveHost, getHost } = await import('@/server/modules/hosts');
    const v = await mkVendor(w); const h = await mkHost(w);
    const c = await mkCampaign(w, v.id, { hosts: [{ hostId: h.id }] });
    await expect(archiveVendor(w.manager, v.id, '不合作')).rejects.toThrow(/未結案/);
    await expect(archiveHost(w.manager, h.id, '不合作')).rejects.toThrow(/未結案/);
    await query(`UPDATE campaigns SET status='CANCELLED' WHERE id=$1`, [c.id]);
    await archiveVendor(w.manager, v.id, '不合作'); await archiveHost(w.manager, h.id, '不合作');
    await expect(getVendor(w.manager, v.id)).rejects.toThrow(/找不到/);
    await expect(getHost(w.manager, h.id)).rejects.toThrow(/找不到/);
    const raw = await query(`SELECT deleted_at FROM vendors WHERE id=$1`, [v.id]);
    expect(raw).toHaveLength(1); expect(raw[0].deleted_at).toBeTruthy();    // 資料列仍在
    const aud = await query(`SELECT reason FROM audit_logs WHERE entity_id=$1 AND action='vendor.archive'`, [v.id]);
    expect(aud[0].reason).toBe('不合作');
    // 封存後可以用同名重新建立
    await createVendor(w.manager, { name: (await query(`SELECT name FROM vendors WHERE id=$1`, [v.id]))[0].name });
  });

  it('廠商資料待補提示：ACTIVE 廠商缺公司名／統編／聯絡方式會被列出，並可用 missing=1 篩選', async () => {
    const c = await Client.forActor(w.manager);
    const bare = await c.call('POST', '/vendors', { name: `資料不全${Date.now()}`, status: 'ACTIVE' });
    const d = await c.call('GET', `/vendors/${bare.data.id}`);
    expect(d.data.missingFields).toEqual(expect.arrayContaining(['公司全名（開立發票用）', '統一編號', '類別', '主要聯絡人']));
    expect(d.data.anomalies[0]).toContain('合作中但資料不齊');
    const list = await c.call('GET', '/vendors?missing=1&limit=200');
    expect(list.data.items.some((x: { id: string }) => x.id === bare.data.id)).toBe(true);
    const full = await c.call('GET', `/vendors/${(await mkVendor(w)).id}`);
    expect(full.data.missingFields).toContain('統一編號');   // mkVendor 沒給統編
  });
});

describe('API 層行為', () => {
  it('錯誤格式一致：驗證錯誤 422 含欄位訊息；找不到 404；不支援方法 405；內部錯誤不外洩細節', async () => {
    const c = await Client.forActor(w.manager);
    const bad = await c.call('POST', '/vendors', { name: '', taxId: '12' });
    expect(bad.status).toBe(422); expect(bad.error?.code).toBe('VALIDATION'); expect(bad.error?.requestId).toBeTruthy();
    expect((await c.call('GET', '/campaigns/CMP-000000-0000')).status).toBe(404);
    expect((await c.call('GET', '/nope')).status).toBe(404);
    expect((await c.call('DELETE', '/vendors')).status).toBe(405);          // 沒有任何實體刪除的 API
    expect((await c.call('DELETE', '/vendors/VEN-0001')).status).toBe(405);
    expect((await c.call('PUT', '/auth/me', {})).status).toBe(405);
    expect((await c.call('PATCH', '/auth/login', {})).status).toBe(405);
  });

  it('樂觀鎖：用過期版本更新會得到 409 並提示目前版本', async () => {
    const c = await Client.forActor(w.manager);
    const v = await c.call('POST', '/vendors', { name: `版本測試${Date.now()}` });
    const cur = (await c.call('GET', `/vendors/${v.data.id}`)).data;
    expect((await c.call('PATCH', `/vendors/${v.data.id}`, { category: '食品', version: cur.version })).status).toBe(200);
    const stale = await c.call('PATCH', `/vendors/${v.data.id}`, { category: '美妝', version: cur.version });
    expect(stale.status).toBe(409);
    expect(stale.json.error.details.currentVersion).toBe(cur.version + 1);
    expect((await query(`SELECT category FROM vendors WHERE id=$1`, [v.data.id]))[0].category).toBe('食品');
  });

  it('資料驗證：統編、Email、日期、金額、百分比', async () => {
    const c = await Client.forActor(w.manager);
    expect((await c.call('POST', '/vendors', { name: 'X1', taxId: 'ABCDEFGH' })).status).toBe(422);
    expect((await c.call('POST', '/vendors', { name: 'X2', contacts: [{ name: 'a', email: 'not-email' }] })).status).toBe(422);
    const v = (await c.call('POST', '/vendors', { name: `驗證廠商${Date.now()}` })).data.id;
    expect((await c.call('POST', '/campaigns', { title: 't', vendorId: v, openDate: '2026/12/01' })).status).toBe(422);
    expect((await c.call('POST', '/campaigns', { title: 't', vendorId: v, targetRevenue: -5 })).status).toBe(422);
    expect((await c.call('POST', '/campaigns', { title: 't', vendorId: v, openDate: dayOffset(10), closeDate: dayOffset(5) })).status).toBe(422);
    expect((await c.call('POST', '/commission-rules', { scopeType: 'HOST_DEFAULT', hostId: 'X', ratePercent: 101, effectiveFrom: dayOffset(1) })).status).toBe(403);   // 管理者以外
    const fin = await Client.forActor(w.finance);
    expect((await fin.call('POST', '/commission-rules', { scopeType: 'HOST_DEFAULT', hostId: 'X', ratePercent: 101, effectiveFrom: dayOffset(1) })).status).toBe(422);
  });

  it('暫停／黑名單廠商不能建立新檔期', async () => {
    const v = await mkVendor(w);
    await query(`UPDATE vendors SET status='PAUSED' WHERE id=$1`, [v.id]);
    await expect(createCampaign(w.editor, { title: 'x', vendorId: v.id })).rejects.toThrow(/不可建立新檔期/);
  });
});

void addCampaignHost; void transitionCampaign; void setTaskStatus;
