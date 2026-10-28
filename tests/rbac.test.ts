import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { resetRateLimits } from '@/server/lib/rate-limit';
import { Client } from './api-helper';
import { PW, addUser, dayOffset, emailOf, makeWorld, mkCampaign, mkCommunity, mkHost, mkProduct, mkVendor, type World } from './helpers';
import type { Actor } from '@/server/lib/permissions';

let w: World;
// 兩位團主、兩家廠商，各自一檔，另有一檔兩位團主共同參與
let hostA: { id: string }, hostB: { id: string }, vendorA: { id: string }, vendorB: { id: string };
let campA: string, campB: string, campShared: string;
let hostAUser: Actor, hostBUser: Actor, vendorAUser: Actor, vendorBUser: Actor;
let productA: { id: string; skuIds: string[] };

beforeAll(async () => {
  resetRateLimits();
  w = await makeWorld();
  hostA = await mkHost(w, '團主甲'); hostB = await mkHost(w, '團主乙');
  vendorA = await mkVendor(w, '廠商甲'); vendorB = await mkVendor(w, '廠商乙');
  productA = await mkProduct(w, vendorA.id, { approve: true });
  const productB = await mkProduct(w, vendorB.id, { approve: true });
  const base = { sampleReadyDate: dayOffset(1), openDate: dayOffset(20), closeDate: dayOffset(30), targetRevenue: 500000, internalNote: '內部機密備註' };
  campA = (await mkCampaign(w, vendorA.id, { ...base, products: [{ productId: productA.id, skuId: productA.skuIds[0] }], hosts: [{ hostId: hostA.id, targetRevenue: 100000 }] }, w.manager)).id;
  campB = (await mkCampaign(w, vendorB.id, { ...base, products: [{ productId: productB.id, skuId: productB.skuIds[0] }], hosts: [{ hostId: hostB.id, targetRevenue: 200000 }] }, w.manager)).id;
  campShared = (await mkCampaign(w, vendorA.id, { ...base, title: '共同檔期', hosts: [{ hostId: hostA.id, targetRevenue: 10 }, { hostId: hostB.id, targetRevenue: 20 }] }, w.manager)).id;
  hostAUser = await addUser(w.orgId, 'HOST', { hostIds: [hostA.id] });
  hostBUser = await addUser(w.orgId, 'HOST', { hostIds: [hostB.id] });
  vendorAUser = await addUser(w.orgId, 'VENDOR', { vendorIds: [vendorA.id] });
  vendorBUser = await addUser(w.orgId, 'VENDOR', { vendorIds: [vendorB.id] });
});

describe('未登入與認證', () => {
  it('未登入存取任何受保護 API 一律 401；健康檢查公開且不洩漏資料', async () => {
    const c = new Client();
    for (const p of ['/vendors', '/campaigns', '/tasks', '/dashboard/admin', '/orders', '/audit', '/users', '/auth/me']) {
      const r = await c.call('GET', p);
      expect(r.status, p).toBe(401);
    }
    const h = await c.call('GET', '/health');
    expect(h.status).toBe(200);
    expect(JSON.stringify(h.data)).not.toMatch(/password|DATABASE|erp_dev/);
  });

  it('登入：錯誤帳密訊息一致不洩漏帳號是否存在；cookie 為 HttpOnly；登出後 session 失效', async () => {
    const c = new Client();
    const bad1 = await c.call('POST', '/auth/login', { email: emailOf(w.admin), password: 'wrong-password-1' });
    const bad2 = await c.call('POST', '/auth/login', { email: 'nobody@example.invalid', password: 'wrong-password-1' });
    expect(bad1.status).toBe(401); expect(bad2.status).toBe(401);
    expect(bad1.error?.message).toBe(bad2.error?.message);
    const ok = await c.call('POST', '/auth/login', { email: emailOf(w.admin), password: PW });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(ok.headers.get('set-cookie')).toMatch(/SameSite=Lax/i);
    expect((await c.call('GET', '/auth/me')).data.role).toBe('SYSTEM_ADMIN');
    const cookie = c.cookie;
    await c.call('POST', '/auth/logout', {});
    const stale = new Client(); stale.cookie = cookie;
    expect((await stale.call('GET', '/auth/me')).status).toBe(401);
  });

  it('連續登入失敗會暫時鎖定帳號（即使之後密碼正確）', async () => {
    const u = await addUser(w.orgId, 'OPS_EDITOR');
    const c = new Client();
    for (let i = 0; i < 5; i++) { resetRateLimits(); await c.call('POST', '/auth/login', { email: emailOf(u), password: 'wrong-password-1' }); }
    resetRateLimits();
    const r = await c.call('POST', '/auth/login', { email: emailOf(u), password: PW });
    expect(r.status).toBe(429);
  });

  it('停用帳號後既有 session 立即失效', async () => {
    const u = await addUser(w.orgId, 'OPS_EDITOR');
    const c = await Client.forActor(u);
    expect((await c.call('GET', '/auth/me')).status).toBe(200);
    const admin = await Client.forActor(w.admin);
    expect((await admin.call('POST', `/users/${u.userId}/status`, { status: 'DISABLED' })).status).toBe(200);
    expect((await c.call('GET', '/auth/me')).status).toBe(401);
    const relog = new Client(emailOf(u));
    expect((await relog.call('POST', '/auth/login', { email: emailOf(u), password: PW })).status).toBe(401);
  });

  it('過期的 session 失效', async () => {
    const u = await addUser(w.orgId, 'OPS_EDITOR');
    const c = await Client.forActor(u);
    await query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id=$1`, [u.userId]);
    expect((await c.call('GET', '/auth/me')).status).toBe(401);
  });
});

describe('CSRF 與請求格式', () => {
  it('跨來源（Origin 與 Host 不同）的寫入被拒；非 JSON 內容被拒', async () => {
    const c = await Client.forActor(w.manager);
    const evil = await c.call('POST', '/vendors', { name: 'x' }, { origin: 'https://evil.example', host: 'localhost:3000' });
    expect(evil.status).toBe(403);
    const form = await c.call('POST', '/vendors', 'name=x', { 'content-type': 'application/x-www-form-urlencoded' });
    expect(form.status).toBe(415);
    const bad = await c.call('POST', '/vendors', '{not json', { 'content-type': 'application/json' });
    expect(bad.status).toBe(400);
  });
});

describe('團主資料隔離（後端強制，不只是前端隱藏）', () => {
  it('團主甲只看得到自己參與的檔期；讀乙的檔期得到 404（不洩漏存在與否）', async () => {
    const c = await Client.forActor(hostAUser);
    const list = await c.call('GET', '/campaigns');
    const ids = list.data.items.map((x: { id: string }) => x.id).sort();
    expect(ids).toEqual([campA, campShared].sort());
    expect((await c.call('GET', `/campaigns/${campB}`)).status).toBe(404);
    expect((await c.call('GET', `/campaigns/${campA}`)).status).toBe(200);
  });

  it('團主看不到內部欄位、其他團主、檔期目標、內部備註、審核紀錄、衝突、例外', async () => {
    const c = await Client.forActor(hostAUser);
    const d = (await c.call('GET', `/campaigns/${campShared}`)).data;
    const text = JSON.stringify(d);
    expect(d.hosts).toHaveLength(1);
    expect(d.hosts[0].hostId).toBe(hostA.id);
    expect(text).not.toContain(hostB.id);
    expect(text).not.toContain('團主乙');
    expect(d.targetRevenue).toBeUndefined();
    expect(d.internalNote).toBeUndefined();
    expect(d.approvals).toBeUndefined();
    expect(d.conflicts).toBeUndefined();
    expect(d.workflowParams).toBeUndefined();
    expect(d.hosts[0].targetRevenue).toBe(10);       // 只看得到「自己的」目標
    expect(d.tasks.every((t: { ownerRole: string }) => t.ownerRole === 'HOST')).toBe(true);
    // 列表也不帶 target_revenue
    const l = (await c.call('GET', '/campaigns')).data.items;
    expect(l.every((x: Record<string, unknown>) => x.targetRevenue === undefined)).toBe(true);
    expect(JSON.stringify(l)).not.toContain('團主乙');
  });

  it('團主不能讀其他團主資料、全部廠商、商品成本、訂單、佣金設定、稽核、使用者、自動化', async () => {
    const c = await Client.forActor(hostAUser);
    expect((await c.call('GET', `/hosts/${hostB.id}`)).status).toBe(403);
    expect((await c.call('GET', `/hosts/${hostA.id}`)).status).toBe(200);
    expect((await c.call('GET', '/hosts')).data.items.map((h: { id: string }) => h.id)).toEqual([hostA.id]);
    expect((await c.call('GET', '/vendors')).status).toBe(403);
    for (const p of ['/orders', '/imports', '/audit', '/users', '/automation/jobs', '/exceptions', '/dashboard/admin', '/intake', '/approvals?status=PENDING']) {
      expect((await c.call('GET', p)).status, p).toBe(403);
    }
    expect((await c.call('GET', `/campaigns/${campA}/audit`)).status).toBe(403);
    expect((await c.call('GET', `/campaigns/${campA}/gates/G2`)).status).toBe(403);
  });

  it('團主不能寫入主檔或檔期、不能核准、不能變更他人的團主回覆', async () => {
    const c = await Client.forActor(hostAUser);
    expect((await c.call('POST', '/vendors', { name: '駭入廠商' })).status).toBe(403);
    expect((await c.call('POST', '/hosts', { displayName: '駭入團主' })).status).toBe(403);
    expect((await c.call('POST', '/campaigns', { title: 'x', vendorId: vendorA.id })).status).toBe(403);
    expect((await c.call('PATCH', `/campaigns/${campA}`, { title: '改名' })).status).toBe(403);
    expect((await c.call('POST', `/campaigns/${campA}/status`, { action: 'cancel', reason: 'x' })).status).toBe(403);
    expect((await c.call('POST', `/campaigns/${campA}/hosts/${hostB.id}/respond`, { status: 'DECLINED', note: '代替乙婉拒' })).status).toBe(403);
    expect((await c.call('POST', '/commission-rules', { scopeType: 'HOST_DEFAULT', hostId: hostA.id, ratePercent: 99, effectiveFrom: '2026-01-01' })).status).toBe(403);
    const after = await query('SELECT status FROM campaign_hosts WHERE campaign_id=$1 AND host_id=$2', [campA, hostB.id]);
    expect(after.length).toBe(0);
  });

  it('團主只能操作自己角色的任務；不能完成營運／廠商的任務', async () => {
    const c = await Client.forActor(hostAUser);
    const tasks = (await c.call('GET', `/tasks?campaignId=${campA}`)).data.items as { id: string; ownerRole: string }[];
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((t) => t.ownerRole === 'HOST')).toBe(true);
    const opsTask = (await query<{ id: string }>(`SELECT id FROM tasks WHERE campaign_id=$1 AND owner_role='OPS_EDITOR' LIMIT 1`, [campA]))[0].id;
    expect((await c.call('GET', `/tasks/${opsTask}`)).status).toBe(404);
    expect((await c.call('POST', `/tasks/${opsTask}/status`, { to: 'DONE' })).status).toBe(404);
    const otherCampaignTask = (await query<{ id: string }>(`SELECT id FROM tasks WHERE campaign_id=$1 AND owner_role='HOST' LIMIT 1`, [campB]))[0].id;
    expect((await c.call('POST', `/tasks/${otherCampaignTask}/status`, { to: 'IN_PROGRESS' })).status).toBe(404);
  });

  it('團主 Dashboard：只能看自己；指定別人的 hostId 被拒；內部人員可用團主視角預覽', async () => {
    const c = await Client.forActor(hostAUser);
    expect((await c.call('GET', '/dashboard/host')).status).toBe(200);
    expect((await c.call('GET', `/dashboard/host?hostId=${hostA.id}`)).status).toBe(200);
    expect((await c.call('GET', `/dashboard/host?hostId=${hostB.id}`)).status).toBe(403);
    const mgr = await Client.forActor(w.manager);
    expect((await mgr.call('GET', `/dashboard/host?hostId=${hostB.id}`)).status).toBe(200);
    expect((await mgr.call('GET', '/dashboard/host')).status).toBe(422);
  });
});

describe('廠商資料隔離', () => {
  it('廠商只看得到自己的廠商資料、商品與檔期；看不到團主、佣金、訂單、成本', async () => {
    const c = await Client.forActor(vendorAUser);
    expect((await c.call('GET', '/vendors')).data.items.map((v: { id: string }) => v.id)).toEqual([vendorA.id]);
    expect((await c.call('GET', `/vendors/${vendorB.id}`)).status).toBe(403);
    const mine = (await c.call('GET', `/vendors/${vendorA.id}`)).data;
    expect(mine.internalNote).toBeUndefined();
    expect(mine.anomalies).toEqual([]);
    const camps = (await c.call('GET', '/campaigns')).data.items.map((x: { id: string }) => x.id);
    expect(camps).toContain(campA); expect(camps).not.toContain(campB);
    const d = (await c.call('GET', `/campaigns/${campA}`)).data;
    expect(d.hosts).toEqual([]); expect(d.placements).toEqual([]);
    expect(d.targetRevenue).toBeUndefined(); expect(d.internalNote).toBeUndefined();
    expect(d.tasks.every((t: { ownerRole: string }) => t.ownerRole === 'VENDOR')).toBe(true);
    const prod = (await c.call('GET', `/products/${productA.id}`)).data;
    expect(JSON.stringify(prod)).not.toMatch(/costPrice|cost_price/);
    expect((await c.call('GET', '/orders')).status).toBe(403);
    expect((await c.call('GET', '/commission-rules')).status).toBe(403);
    expect((await c.call('GET', '/hosts')).status).toBe(403);
    expect((await c.call('GET', `/campaigns/${campB}`)).status).toBe(404);
  });

  it('廠商 B 看不到廠商 A 的商品', async () => {
    const c = await Client.forActor(vendorBUser);
    expect((await c.call('GET', `/products/${productA.id}`)).status).toBe(404);
    expect((await c.call('GET', '/products')).data.items.every((p: { vendorId: string }) => p.vendorId === vendorB.id)).toBe(true);
  });

  it('廠商不能核准商品、不能改價格', async () => {
    const c = await Client.forActor(vendorAUser);
    expect((await c.call('POST', `/products/${productA.id}/review`, { to: 'APPROVED' })).status).toBe(403);
    expect((await c.call('PATCH', `/skus/${productA.skuIds[0]}`, { groupPrice: 1 })).status).toBe(403);
  });
});

describe('敏感財務資料與角色分權', () => {
  it('營運小編看不到成本，也不能寫入成本；營運主管／財務可以', async () => {
    const ed = await Client.forActor(w.editor);
    const p = (await ed.call('GET', `/products/${productA.id}`)).data;
    expect(JSON.stringify(p)).not.toMatch(/costPrice/);
    expect((await ed.call('PATCH', `/skus/${productA.skuIds[0]}`, { costPrice: 1 })).status).toBe(403);
    const fin = await Client.forActor(w.finance);
    expect(JSON.stringify((await fin.call('GET', `/products/${productA.id}`)).data)).toMatch(/costPrice/);
  });

  it('營運小編只看得到自己負責的檔期；其他小編的看不到', async () => {
    const v = await mkVendor(w);
    const mine = await mkCampaign(w, v.id);
    const theirs = (await (await import('@/server/modules/campaigns')).createCampaign(w.editor2, { title: `編輯二的檔期${Date.now()}`, vendorId: v.id })).id;
    const c = await Client.forActor(w.editor);
    const ids = (await c.call('GET', '/campaigns?limit=200')).data.items.map((x: { id: string }) => x.id);
    expect(ids).toContain(mine.id); expect(ids).not.toContain(theirs);
    expect((await c.call('GET', `/campaigns/${theirs}`)).status).toBe(404);
    const m = await Client.forActor(w.manager);
    expect((await m.call('GET', `/campaigns/${theirs}`)).status).toBe(200);
  });

  it('只有管理者能管理使用者；營運主管不行；新增團主帳號必須綁定團主', async () => {
    const mgr = await Client.forActor(w.manager);
    expect((await mgr.call('GET', '/users')).status).toBe(403);
    const adm = await Client.forActor(w.admin);
    const noScope = await adm.call('POST', '/users', { email: `h-${Date.now()}@example.invalid`, name: 'x', role: 'HOST', password: PW });
    expect(noScope.status).toBe(422);
    const ok = await adm.call('POST', '/users', { email: `h2-${Date.now()}@example.invalid`, name: 'x', role: 'HOST', password: PW, hostIds: [hostA.id] });
    expect(ok.status).toBe(201);
    const weak = await adm.call('POST', '/users', { email: `h3-${Date.now()}@example.invalid`, name: 'x', role: 'OPS_EDITOR', password: 'short' });
    expect(weak.status).toBe(422);
  });

  it('佣金規則：只有財務／管理者可寫；團主只讀到自己的', async () => {
    const mgr = await Client.forActor(w.manager);
    expect((await mgr.call('POST', '/commission-rules', { scopeType: 'HOST_DEFAULT', hostId: hostA.id, ratePercent: 10, effectiveFrom: dayOffset(-30) })).status).toBe(403);
    const fin = await Client.forActor(w.finance);
    expect((await fin.call('POST', '/commission-rules', { scopeType: 'HOST_DEFAULT', hostId: hostA.id, ratePercent: 10, effectiveFrom: dayOffset(-30) })).status).toBe(201);
    expect((await fin.call('POST', '/commission-rules', { scopeType: 'HOST_DEFAULT', hostId: hostB.id, ratePercent: 15, effectiveFrom: dayOffset(-30) })).status).toBe(201);
    const c = await Client.forActor(hostAUser);
    const rules = (await c.call('GET', '/commission-rules')).data;
    expect(rules).toHaveLength(1);
    expect(rules[0].hostId).toBe(hostA.id);
    expect((await c.call('GET', `/commission-rules?hostId=${hostB.id}`)).data).toHaveLength(0);
  });

  it('財務的稽核只看到財務相關實體；營運主管看全部', async () => {
    const fin = await Client.forActor(w.finance);
    const rows = (await fin.call('GET', '/audit')).data as { entityType: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => ['order', 'import_batch', 'import_error', 'commission_rule', 'settlement'].includes(r.entityType))).toBe(true);
    const mgr = await Client.forActor(w.manager);
    const all = (await mgr.call('GET', '/audit?limit=500')).data as { entityType: string }[];
    expect(new Set(all.map((r) => r.entityType)).size).toBeGreaterThan(5);
  });

  it('跨組織隔離：另一個組織的管理者看不到這個組織的任何資料', async () => {
    const w2 = await makeWorld();
    const c = await Client.forActor(w2.admin);
    for (const p of ['/campaigns', '/vendors', '/hosts', '/products', '/tasks', '/exceptions']) {
      const r = await c.call('GET', p);
      expect(r.data.items?.length ?? r.data.length ?? 0, p).toBe(0);
    }
    expect((await c.call('GET', `/campaigns/${campA}`)).status).toBe(404);
    expect((await c.call('GET', `/vendors/${vendorA.id}`)).status).toBe(404);
    expect((await c.call('GET', `/hosts/${hostA.id}`)).status).toBe(404);
    expect((await c.call('PATCH', `/vendors/${vendorA.id}`, { name: '被改名' })).status).toBe(404);
    expect((await c.call('POST', `/campaigns/${campA}/status`, { action: 'cancel', reason: '跨組織' })).status).toBe(404);
    expect((await c.call('GET', `/dashboard/admin`)).data.pipeline).toEqual([]);
    // 另一組織不能把本組織的廠商掛到自己的檔期
    expect((await c.call('POST', '/campaigns', { title: '跨組織', vendorId: vendorA.id })).status).toBe(404);
  });
});

void mkCommunity;
