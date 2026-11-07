import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { Client as PgClient } from 'pg';
import { query } from '@/server/lib/db';
import { changePassword, validateNewPassword } from '@/server/modules/auth';
import { correctPaidExpense, createExpense, expenseHistory, updateExpense } from '@/server/modules/finance';
import { Client } from './api-helper';
import { PW, addUser, dayOffset, emailOf, makeWorld, mkCampaign, mkVendor, mkProduct, type World } from './helpers';

/** 正式環境上線準備：初次啟用（強制變更密碼）、受控更正已付款費用（O-2）、健康／就緒檢查、正式環境建置腳本的安全保證 */
let w: World, other: World, camp: string;
const NEW_PW = 'Prod-Strong-Pass-9271';

beforeAll(async () => {
  w = await makeWorld(); other = await makeWorld();
  const v = (await mkVendor(w, '[DEMO] 上線廠商')).id;
  const p = await mkProduct(w, v, { name: '[DEMO] 上線商品' });
  camp = (await mkCampaign(w, v, { products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: [], sampleReadyDate: dayOffset(-30), openDate: dayOffset(-10), closeDate: dayOffset(10) })).id;
});

describe('初次啟用：強制變更密碼（後端 API 也擋，不只靠前端導頁）', () => {
  it('密碼規則：至少 12 字元、含英文字母與數字、不含帳號名稱、不可是已公開的測試密碼', () => {
    expect(validateNewPassword('short1A', 'a@b.co')).toBeTruthy();
    expect(validateNewPassword('onlyletterspassword', 'a@b.co')).toBeTruthy();
    expect(validateNewPassword('Admin-Dev-Pass-123', 'x@y.co')).toContain('常見或已公開');
    expect(validateNewPassword('Demo-Dev-Pass-123', 'x@y.co')).toContain('常見或已公開');
    expect(validateNewPassword('Test-Password-123', 'x@y.co')).toContain('常見或已公開');
    expect(validateNewPassword('wei-ming-pass-12345', 'wei-ming@corp.co')).toContain('帳號');
    expect(validateNewPassword(NEW_PW, 'a@b.co')).toBeNull();
  });
  it('必須變更密碼的帳號：除了變更密碼、登出、讀取自己的狀態，所有 API 一律 403 PASSWORD_CHANGE_REQUIRED；變更後旗標清除、其他 session 全部失效、舊密碼不能再登入；稽核不含密碼', async () => {
    const u = await addUser(w.orgId, 'SYSTEM_ADMIN');
    await query(`UPDATE users SET must_change_password=true WHERE id=$1`, [u.userId]);
    const a = await Client.forActor(u);                           // session A
    const b = await Client.forActor(u);                           // session B（之後應被撤銷）
    const r = await a.call('GET', '/vendors');
    expect(r.status).toBe(403); expect(r.error?.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await a.call('GET', '/users')).status).toBe(403);
    expect((await a.call('POST', '/vendors', { name: 'x' })).status).toBe(403);
    const me = await a.call('GET', '/auth/me'); expect(me.status).toBe(200); expect(me.data.mustChangePassword).toBe(true);
    expect((await a.call('POST', '/auth/change-password', { currentPassword: 'wrong-password-1', newPassword: NEW_PW })).status).toBe(401);
    expect((await a.call('POST', '/auth/change-password', { currentPassword: PW, newPassword: PW })).status).toBe(422);        // 與舊密碼相同
    expect((await a.call('POST', '/auth/change-password', { currentPassword: PW, newPassword: 'short1' })).status).toBe(422);
    expect((await a.call('POST', '/auth/change-password', { currentPassword: PW, newPassword: 'Admin-Dev-Pass-123' })).status).toBe(422);
    const ok = await a.call('POST', '/auth/change-password', { currentPassword: PW, newPassword: NEW_PW });
    expect(ok.status).toBe(200);
    expect((await a.call('GET', '/vendors')).status).toBe(200);                                  // 目前這個 session 保留並解除限制
    expect((await b.call('GET', '/auth/me')).status).toBe(401);                                  // 其他 session 已撤銷
    const row = (await query(`SELECT must_change_password, password_changed_at FROM users WHERE id=$1`, [u.userId]))[0];
    expect(row.must_change_password).toBe(false); expect(row.password_changed_at).not.toBeNull();
    const old = new Client(emailOf(u)); expect((await old.call('POST', '/auth/login', { email: emailOf(u), password: PW })).status).toBe(401);
    const fresh = new Client(emailOf(u)); expect((await fresh.call('POST', '/auth/login', { email: emailOf(u), password: NEW_PW })).status).toBe(200);
    const audits = JSON.stringify(await query(`SELECT before_data, after_data, reason FROM audit_logs WHERE entity_id=$1 AND action='user.password_change'`, [u.userId]));
    expect(audits).toContain('mustChangePassword'); expect(audits).not.toContain(NEW_PW); expect(audits).not.toContain(PW);
    // 一般帳號（沒被要求變更）不受影響；服務層函式本身也要求目前密碼
    await expect(changePassword(u, null, { currentPassword: 'nope-nope-nope1', newPassword: 'Another-Strong-Pass-1' })).rejects.toThrow();
  });
  it('登入回應告知是否需要變更密碼；未登入不可變更密碼', async () => {
    const u = await addUser(w.orgId, 'OPS_MANAGER');
    await query(`UPDATE users SET must_change_password=true WHERE id=$1`, [u.userId]);
    const c = new Client(emailOf(u));
    const r = await c.call('POST', '/auth/login', { email: emailOf(u), password: PW });
    expect(r.status).toBe(200); expect(r.data.mustChangePassword).toBe(true);
    expect((await new Client().call('POST', '/auth/change-password', { currentPassword: PW, newPassword: NEW_PW })).status).toBe(401);
  });
});

describe('O-2：已付款費用不可直接改金額；只能走受控更正（保留稽核與歷史）', () => {
  const paid = async (o: Record<string, unknown> = {}) => createExpense(w.finance, { category: 'SHIPPING', amount: 1000, incurredOn: dayOffset(-5), campaignId: camp, bearerParty: 'COMPANY', payerParty: 'COMPANY', paymentStatus: 'PAID', paidOn: dayOffset(-3), ...o } as never);
  const exp = async (id: string) => (await query(`SELECT * FROM expenses WHERE id=$1`, [id]))[0] as Record<string, unknown>;
  it('一般修改被擋；受控更正需要原因、財務權限；舊值與新值完整保留；不產生付款或結算', async () => {
    const e = await paid();
    await expect(updateExpense(w.finance, e.id, { amount: 900 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(correctPaidExpense(w.finance, e.id, { newAmount: 900, reason: '短' })).rejects.toThrow();                         // 原因太短
    const before = await Promise.all(['payments', 'invoices', 'settlements'].map(async (t) => Number((await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE organization_id=$1`, [w.orgId]))[0].n)));
    const out = await correctPaidExpense(w.finance, e.id, { newAmount: 900, reason: '[DEMO] 廠商開立折讓，實際運費為 900 元' });
    expect(out).toMatchObject({ paymentInstruction: false });
    expect((await exp(e.id)).amount).toBe(900);
    const c = (await query(`SELECT * FROM expense_corrections WHERE expense_id=$1`, [e.id]))[0];
    expect(c).toMatchObject({ old_amount: 1000, new_amount: 900, old_payment_status: 'PAID', new_payment_status: 'PAID', corrected_by: w.finance.userId });
    const a = (await query(`SELECT before_data, after_data, reason FROM audit_logs WHERE entity_id=$1 AND action='expense.correct_paid'`, [e.id]))[0];
    expect(a.before_data).toMatchObject({ amount: 1000 }); expect(a.after_data).toMatchObject({ amount: 900 }); expect(a.reason).toContain('折讓');
    const h = await expenseHistory(w.finance, e.id) as { corrections: { oldAmount: number; newAmount: number }[] };
    expect(h.corrections).toHaveLength(1); expect(h.corrections[0]).toMatchObject({ oldAmount: 1000, newAmount: 900 });
    expect(await Promise.all(['payments', 'invoices', 'settlements'].map(async (t) => Number((await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE organization_id=$1`, [w.orgId]))[0].n)))).toEqual(before);
    // 歷史不可修改、不可刪除
    await expect(query(`UPDATE expense_corrections SET new_amount=1 WHERE expense_id=$1`, [e.id])).rejects.toThrow();
    await expect(query(`DELETE FROM expense_corrections WHERE expense_id=$1`, [e.id])).rejects.toThrow();
  });
  it('部分付款與狀態更正的一致性；已確認的應收應付退回未確認；未付款的費用不走這條路', async () => {
    const part = await paid({ paymentStatus: 'PARTIALLY_PAID', paidAmount: 600 });
    await expect(correctPaidExpense(w.finance, part.id, { newAmount: 500, reason: '[DEMO] 金額更正測試' })).rejects.toMatchObject({ code: 'VALIDATION' });   // 已付 600 ≥ 新金額
    await correctPaidExpense(w.finance, part.id, { newAmount: 500, paymentStatus: 'PAID', paidAmount: null, reason: '[DEMO] 金額降為 500，已視為付清' });
    expect(await exp(part.id)).toMatchObject({ amount: 500, payment_status: 'PAID', paid_amount: null });
    const conf = await paid({ claimDirection: 'PAYABLE', claimParty: 'HOST' });
    await query(`UPDATE expenses SET claim_status='CONFIRMED', claim_confirmed_by=$2, claim_confirmed_at=now() WHERE id=$1`, [conf.id, w.finance.userId]);
    const r = await correctPaidExpense(w.finance, conf.id, { newAmount: 800, reason: '[DEMO] 更正後需重新確認應付' });
    expect(r.reconfirmRequired).toBe(true); expect((await exp(conf.id)).claim_status).toBe('UNCONFIRMED');
    const unpaid = await paid({ paymentStatus: 'UNPAID', paidOn: undefined });
    await expect(correctPaidExpense(w.finance, unpaid.id, { newAmount: 700, reason: '[DEMO] 未付款不需要受控更正' })).rejects.toThrow(/只有已付款或部分付款/);
    await expect(correctPaidExpense(w.finance, part.id, { newAmount: 500, reason: '[DEMO] 內容與目前相同' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  it('權限與隔離：營運主管（只讀）、小編 403；他組織 404；作廢的費用不可更正', async () => {
    const e = await paid();
    for (const actor of [w.manager, w.editor]) expect((await (await Client.forActor(actor)).call('POST', `/expenses/${e.id}/correct-paid`, { newAmount: 800, reason: '[DEMO] 權限測試' })).status).toBe(403);
    expect((await (await Client.forActor(other.finance)).call('POST', `/expenses/${e.id}/correct-paid`, { newAmount: 800, reason: '[DEMO] 跨組織' })).status).toBe(404);
    expect((await exp(e.id)).amount).toBe(1000);
    const fin = await Client.forActor(w.finance);
    expect((await fin.call('POST', `/expenses/${e.id}/correct-paid`, { newAmount: 800, reason: '[DEMO] 透過 API 更正' })).status).toBe(200);
  });
});

describe('健康與就緒檢查（公開、不含資料）', () => {
  it('/health 回報版本與 commit；/ready 回報 migration 已全部套用', async () => {
    const c = new Client();
    const h = await c.call('GET', '/health');
    expect(h.status).toBe(200); expect(h.data).toMatchObject({ ok: true, db: 'up' }); expect(h.data).toHaveProperty('version'); expect(h.data).toHaveProperty('commit');
    const r = await c.call('GET', '/ready');
    expect(r.status).toBe(200); expect(r.data.ok).toBe(true); expect(r.data.migrationsApplied).toBeGreaterThanOrEqual(27);
    expect(JSON.stringify(h.json) + JSON.stringify(r.json)).not.toMatch(/password|secret|DATABASE_URL/i);
  });
});

describe('正式環境建置腳本 prod:bootstrap 的安全保證（在暫存資料庫實際執行）', () => {
  const DB = 'erp_bootstrap_test';
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
  const urlFor = (name: string) => { const u = new URL(base); u.pathname = `/${name}`; return u.toString(); };
  const run = (env: Record<string, string>, args: string[] = []) => spawnSync('npx', ['tsx', 'scripts/prod-bootstrap.ts', ...args], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production', DATABASE_URL: urlFor(DB), BOOTSTRAP_CONFIRM: 'yes', ...env } as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 120_000 });
  const admin = async () => { const c = new PgClient({ connectionString: base }); await c.connect(); return c; };
  const good = { APP_ENV: 'production', ORG_NAME: '[測試] 正式環境演練', ADMIN_EMAIL: 'owner@company-ci.test', ADMIN_INITIAL_PASSWORD: 'Init-Strong-Pass-5530' };

  it('拒絕：非 production、示範旗標、範例信箱、弱密碼、缺少必要值；成功時建立空組織與一位須變更密碼的管理者；密碼不出現在輸出；重跑冪等且不重設既有帳號；唯讀檢查可用；有 DEMO 資料就拒絕', async () => {
    const a = await admin();
    await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`);
    try {
      const text = (r: ReturnType<typeof run>) => `${r.stdout}${r.stderr}`;
      expect(text(run({ ...good, APP_ENV: 'development' }))).toContain('只能在 APP_ENV=production');
      expect(text(run({ ...good, ALLOW_DEMO_IN_PRODUCTION: 'yes' }))).toContain('ALLOW_DEMO_IN_PRODUCTION');
      expect(text(run({ ...good, ADMIN_EMAIL: 'admin@example.invalid' }))).toContain('範例網域');
      expect(text(run({ ...good, ADMIN_INITIAL_PASSWORD: 'Admin-Dev-Pass-123' }))).toContain('不符合規則');
      expect(text(run({ ...good, ADMIN_INITIAL_PASSWORD: 'short1A' }))).toContain('不符合規則');
      expect(text(run({ ...good, ADMIN_EMAIL: '' }))).toContain('需要 ADMIN_EMAIL');
      // 失敗的嘗試沒有建立任何管理者
      const conn = new PgClient({ connectionString: urlFor(DB) }); await conn.connect();
      expect((await conn.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n).toBe(0);
      const ok = run(good);
      expect(ok.status, text(ok)).toBe(0);
      expect(text(ok)).not.toContain(good.ADMIN_INITIAL_PASSWORD);
      const u = (await conn.query(`SELECT email, role_key, must_change_password, password_hash FROM users`)).rows;
      expect(u).toHaveLength(1); expect(u[0]).toMatchObject({ email: 'owner@company-ci.test', role_key: 'SYSTEM_ADMIN', must_change_password: true });
      expect(u[0].password_hash).not.toContain(good.ADMIN_INITIAL_PASSWORD);
      expect((await conn.query(`SELECT count(*)::int AS n FROM orders`)).rows[0].n).toBe(0);
      expect((await conn.query(`SELECT count(*)::int AS n FROM vendors`)).rows[0].n).toBe(0);
      expect((await conn.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n).toBe(1);
      const again = run({ ...good, ADMIN_EMAIL: 'someone-else@company-ci.test' });
      expect(again.status).toBe(0); expect(text(again)).toContain('已有系統管理者');
      expect((await conn.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n).toBe(1);        // 不新增、不重設
      const chk = run({ APP_ENV: 'production' }, ['--check']);
      expect(chk.status, text(chk)).toBe(0); expect(chk.stdout).toContain('"activeSystemAdmins":1'); expect(chk.stdout).toContain('"demoRows":0');
      // 混入 DEMO 資料 → 拒絕作為正式資料庫
      await conn.query(`INSERT INTO vendors (id, organization_id, name, normalized_name) SELECT 'VEN-D1', id, '[DEMO] 示範廠商', '示範廠商' FROM organizations LIMIT 1`);
      expect(text(run(good))).toContain('DEMO');
      const chk2 = run({ APP_ENV: 'production' }, ['--check']);
      expect(chk2.status).toBe(1);
      await conn.end();
    } finally { await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.end(); }
  }, 300_000);

  it('正式建置前必須先確認已依清單設置：沒有確認（或回答不是 yes）就拒絕，而且在詢問之前不對資料庫做任何寫入', async () => {
    const a = await admin();
    await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`);
    try {
      const conn = new PgClient({ connectionString: urlFor(DB) }); await conn.connect();
      for (const confirm of ['', 'no', 'YES', 'true']) {
        const x = spawnSync('npx', ['tsx', 'scripts/prod-bootstrap.ts'], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production', DATABASE_URL: urlFor(DB), ...good, BOOTSTRAP_CONFIRM: confirm } as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 120_000 });
        expect(x.status, `confirm="${confirm}"`).toBe(1);
        expect(`${x.stdout}${x.stderr}`).toContain('OWNER_SETUP_CHECKLIST');
      }
      // 被拒絕的嘗試完全沒有動資料庫：連 schema_migrations 都不存在（migrate 尚未執行）
      expect((await conn.query(`SELECT to_regclass('public.schema_migrations') AS t`)).rows[0].t).toBeNull();
      // 唯讀檢查模式不需要確認
      const chk = run({ APP_ENV: 'production', BOOTSTRAP_CONFIRM: '' }, ['--check']);
      expect(`${chk.stdout}${chk.stderr}`).not.toContain('OWNER_SETUP_CHECKLIST');
      await conn.end();
    } finally { await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.end(); }
  }, 300_000);
});
