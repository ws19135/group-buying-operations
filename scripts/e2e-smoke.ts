/**
 * E2E 煙霧測試（Playwright）。需要：已 build 的專案、已灌入 DEMO 資料的資料庫。
 *   npm run build && E2E_PASSWORD=<DEMO_PASSWORD> npm run e2e
 * 預設自行啟動 `next start`（port 3100）；若已有伺服器可設 E2E_BASE_URL 並略過啟動。
 * 只用 DEMO 帳號與虛構資料；結果寫入 docs/uat/e2e-results.json，截圖寫入 docs/uat/screens。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { loadEnv } from './load-env';

loadEnv();
const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const PASSWORD = process.env.E2E_PASSWORD ?? process.env.DEMO_PASSWORD ?? '';
const SHOTS = path.resolve('docs/uat/screens');
const RESULT_FILE = path.resolve('docs/uat/e2e-results.json');

interface Check { name: string; ok: boolean; detail?: string }
const checks: Check[] = [];
const record = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, detail }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`); };

async function waitHealthy(timeoutMs = 60_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('伺服器未在時限內啟動');
}

async function startServer(): Promise<ChildProcess | null> {
  if (process.env.E2E_BASE_URL) return null;
  const child = spawn('npx', ['next', 'start', '-p', String(PORT)], { env: { ...process.env, APP_ENV: process.env.APP_ENV ?? 'development', SESSION_SECRET: process.env.SESSION_SECRET ?? 'e2e-only-secret-0123456789abcdef0123' }, stdio: 'ignore' });
  await waitHealthy();
  return child;
}

class Watch {
  errors: string[] = [];
  constructor(page: Page) {
    page.on('console', (m) => { if (m.type() === 'error') this.errors.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => this.errors.push(`pageerror: ${e.message}`));
    page.on('response', (r) => { if (r.status() >= 500) this.errors.push(`HTTP ${r.status()} ${r.url()}`); });
  }
  take(): string[] { const e = this.errors; this.errors = []; return e; }
}

async function login(ctx: BrowserContext, page: Page, email: string): Promise<void> {
  await page.goto(`${BASE}/login`);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 }), page.getByTestId('login-submit').click()]);
  void ctx;
}

async function visit(page: Page, w: Watch, url: string, label: string, opts: { shot?: string; expectText?: RegExp; expectStatus?: number; notText?: RegExp } = {}): Promise<string> {
  const resp = await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
  const status = resp?.status() ?? 0;
  const body = await page.locator('body').innerText();
  const errs = w.take();
  const want = opts.expectStatus ?? 200;
  const ok = status === want && !errs.length && (!opts.expectText || opts.expectText.test(body)) && (!opts.notText || !opts.notText.test(body));
  record(`${label}（${url}）`, ok, ok ? `HTTP ${status}` : `HTTP ${status}${errs.length ? `；${errs.join(' | ').slice(0, 200)}` : ''}${opts.expectText && !opts.expectText.test(body) ? '；缺少預期文字' : ''}${opts.notText && opts.notText.test(body) ? '；出現不該出現的文字' : ''}`);
  if (opts.shot) await page.screenshot({ path: path.join(SHOTS, opts.shot), fullPage: true });
  return body;
}

async function main() {
  if (!PASSWORD) throw new Error('請設定 E2E_PASSWORD（DEMO 帳號密碼）');
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await startServer();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM ?? undefined });
    const health = await (await fetch(`${BASE}/api/health`)).json();
    record('健康檢查含資料庫連線', health?.data?.db === 'up', JSON.stringify(health?.data));

    // ---- 未登入 ----
    {
      const ctx = await browser.newContext(); const page = await ctx.newPage(); const w = new Watch(page);
      await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
      record('未登入造訪 /dashboard 會被導到登入頁', page.url().includes('/login'), page.url());
      await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
      await page.getByTestId('login-email').fill('demo-manager@example.invalid');
      await page.getByTestId('login-password').fill('wrong-password-123');
      await page.getByTestId('login-submit').click();
      await page.getByTestId('login-error').waitFor({ timeout: 10_000 });
      record('錯誤密碼顯示錯誤訊息，不洩漏帳號是否存在', /帳號或密碼錯誤/.test(await page.getByTestId('login-error').innerText()));
      await page.screenshot({ path: path.join(SHOTS, '00-login.png') });
      w.take();
      const api = await ctx.request.get(`${BASE}/api/campaigns`);
      record('未登入呼叫 API 回 401', api.status() === 401, `HTTP ${api.status()}`);
      await ctx.close();
    }

    // ---- 營運主管 ----
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); const w = new Watch(page);
      await login(ctx, page, 'demo-manager@example.invalid');
      const dash = await visit(page, w, '/dashboard', '管理者 Dashboard', { shot: '01-admin-dashboard.png', expectText: /DEMO/ });
      record('Dashboard 顯示 DEMO 橫幅與資料品質區塊', (await page.getByTestId('demo-banner').count()) > 0 && (await page.getByTestId('data-quality').count()) > 0);
      record('Dashboard 有 KPI 區塊與口徑', (await page.getByTestId('kpi-grid').count()) > 0 && /GMV|淨銷售/.test(dash));
      for (const [url, label, shot] of [
        ['/campaigns', '檔期列表', '02-campaigns.png'], ['/calendar', '排程日曆', '03-calendar.png'], ['/tasks', '任務', '04-tasks.png'], ['/approvals', '核准', '05-approvals.png'],
        ['/vendors', '廠商列表', '06-vendors.png'], ['/hosts', '團主列表', ''], ['/communities', '社群列表', ''], ['/products', '商品列表', ''],
        ['/imports', '訂單匯入', '07-imports.png'], ['/exceptions', '例外', '08-exceptions.png'], ['/automation', '自動化', '09-automation.png'], ['/audit', '稽核', ''], ['/notifications', '通知', ''],
        ['/campaigns/new', '新增檔期', ''], ['/vendors/new', '新增廠商', ''], ['/hosts/new', '新增團主', ''], ['/communities/new', '新增社群', ''], ['/products/new', '新增商品', ''],
      ] as const) {
        const body = await visit(page, w, url, label, { shot: shot || undefined });
        if (url === '/automation') record('自動化頁面明示預設停用／僅測試 Adapter／不對真人發送', /預設全部停用/.test(body) && /測試 Adapter/.test(body) && /不會對任何真人發送/.test(body));
      }

      // 檔期詳情與日期調整預覽
      await page.goto(`${BASE}/campaigns?q=${encodeURIComponent('防曬')}`, { waitUntil: 'networkidle' });
      const link = page.locator('[data-testid^="campaign-link-"]').first();
      record('檔期列表找得到 DEMO 檔期', (await link.count()) > 0);
      if (await link.count()) {
        await Promise.all([page.waitForURL(/\/campaigns\/CMP-/), link.click()]);
        await page.waitForLoadState('networkidle');
        const base = page.url().split('?')[0];
        const overview = await page.locator('body').innerText();
        record('檔期詳情顯示狀態與廠商', /進行中/.test(overview) && /晴空保養/.test(overview));
        await page.screenshot({ path: path.join(SHOTS, '10-campaign-detail.png'), fullPage: true });
        await page.goto(`${base}?tab=tasks`, { waitUntil: 'networkidle' });
        const tasksBody = await page.locator('body').innerText();
        record('任務分頁依八階段分組', /籌備與寄樣/.test(tasksBody) && /試用與回饋/.test(tasksBody) && /復盤與結案/.test(tasksBody));
        await page.screenshot({ path: path.join(SHOTS, '10b-campaign-tasks.png'), fullPage: true });
        await page.goto(base, { waitUntil: 'networkidle' });
        await page.getByTestId('btn-reschedule').click();
        const closeInput = page.getByTestId('rs-closeDate');
        const cur = await closeInput.inputValue();
        const next = new Date(`${cur}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
        await closeInput.fill(next.toISOString().slice(0, 10));
        await page.getByTestId('btn-preview').click();
        await page.getByTestId('reschedule-preview').waitFor({ timeout: 15_000 });
        const rows = await page.locator('[data-testid^="preview-row-"]').count();
        record('日期調整先預覽影響（逐任務前後值），尚未套用', rows >= 10, `${rows} 列`);
        record('預覽後才出現「確認」按鈕', (await page.getByTestId('btn-confirm-reschedule').count()) > 0);
        await page.screenshot({ path: path.join(SHOTS, '11-reschedule-preview.png') });
        const still = await (await ctx.request.get(`${BASE}/api/campaigns/${base.split('/').pop()}`)).json();
        record('預覽沒有改動資料（結團日不變）', still?.data?.closeDate === cur, `closeDate=${still?.data?.closeDate}`);
        w.take();
      }
      await ctx.close();
    }

    // ---- 團主 ----
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); const w = new Watch(page);
      await login(ctx, page, 'demo-host1@example.invalid');
      const body = await visit(page, w, '/dashboard/host', '團主 Dashboard', { shot: '12-host-dashboard.png', expectText: /DEMO/, notText: /阿凱生活|米粒日常/ });
      record('團主 Dashboard 有我的檔期與預估佣金（標預估）', (await page.locator('[data-testid^="mycampaign-"]').count()) > 0 && /預估/.test(body));
      await visit(page, w, '/dashboard', '團主不可看管理者 Dashboard', { expectText: /沒有權限/, expectStatus: 200 });
      await visit(page, w, '/vendors', '團主不可看廠商列表', { expectText: /沒有權限/ });
      await visit(page, w, '/users', '團主不可看使用者管理', { expectText: /沒有權限/ });
      const camps = await visit(page, w, '/campaigns', '團主只看到自己的檔期', { notText: /阿凱生活|保濕面膜試用團/ });
      record('團主檔期列表非空', /防曬/.test(camps));
      await ctx.close();
    }

    // ---- 廠商 ----
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); const w = new Watch(page);
      await login(ctx, page, 'demo-vendor@example.invalid');
      await visit(page, w, '/campaigns', '廠商檔期列表', { shot: '13-vendor-campaigns.png' });
      await visit(page, w, '/hosts', '廠商不可看團主', { expectText: /沒有權限/ });
      await visit(page, w, '/imports', '廠商不可看訂單匯入', { expectText: /沒有權限/ });
      await ctx.close();
    }

    // ---- 手機寬度 ----
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true }); const page = await ctx.newPage(); const w = new Watch(page);
      await login(ctx, page, 'demo-manager@example.invalid');
      for (const [url, shot] of [['/dashboard', '14-mobile-dashboard.png'], ['/campaigns', '15-mobile-campaigns.png'], ['/tasks', '']] as const) {
        await visit(page, w, url, `手機版 ${url}`, { shot: shot || undefined });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        record(`手機版 ${url} 無水平溢出`, overflow <= 1, `溢出 ${overflow}px`);
      }
      await ctx.close();
    }

    // ---- 登出 ----
    {
      const ctx = await browser.newContext(); const page = await ctx.newPage();
      await login(ctx, page, 'demo-editor@example.invalid');
      await page.getByTestId('btn-logout').click();
      await page.waitForURL(/\/login/, { timeout: 10_000 });
      const r = await ctx.request.get(`${BASE}/api/auth/me`);
      record('登出後 session 失效', r.status() === 401, `HTTP ${r.status()}`);
      await ctx.close();
    }
  } finally {
    await browser?.close();
    server?.kill();
  }
  const failed = checks.filter((c) => !c.ok);
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, total: checks.length, passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
  console.log(`\nE2E：${checks.length - failed.length}/${checks.length} 通過`);
  if (failed.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
