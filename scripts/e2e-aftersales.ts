/**
 * 售後模組 E2E（Playwright）。需要：已執行 db:seed:demo 與 db:seed:demo:aftersales 的資料庫，以及已啟動的伺服器。
 *   E2E_BASE_URL=http://127.0.0.1:3000 E2E_PASSWORD=<DEMO_PASSWORD> npx tsx scripts/e2e-aftersales.ts
 * 只用 DEMO 帳號與虛構資料；會在 DEMO 資料上實際操作（核准／完成退款、建立案件）。結果寫入 docs/phase2/aftersales-e2e.json，截圖寫入 docs/phase2/screens。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { loadEnv } from './load-env';

loadEnv();
const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
const PASSWORD = process.env.E2E_PASSWORD ?? process.env.DEMO_PASSWORD ?? '';
const SHOTS = path.resolve('docs/phase2/screens');
const RESULT_FILE = path.resolve('docs/phase2/aftersales-e2e.json');

interface Check { name: string; ok: boolean; detail?: string }
const checks: Check[] = [];
const record = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, detail }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`); };

class Watch {
  errors: string[] = [];
  constructor(page: Page) {
    page.on('console', (m) => { if (m.type() === 'error') this.errors.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => this.errors.push(`pageerror: ${e.message}`));
    page.on('response', (r) => { if (r.status() >= 500) this.errors.push(`HTTP ${r.status()} ${r.url()}`); });
  }
  take(): string[] { const e = this.errors; this.errors = []; return e; }
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${BASE}/login`);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 }), page.getByTestId('login-submit').click()]);
}

async function visit(page: Page, w: Watch, url: string, label: string, opts: { shot?: string; expectText?: RegExp; notText?: RegExp } = {}): Promise<string> {
  const resp = await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
  const status = resp?.status() ?? 0;
  const body = await page.locator('body').innerText();
  const errs = w.take();
  const ok = status === 200 && !errs.length && (!opts.expectText || opts.expectText.test(body)) && (!opts.notText || !opts.notText.test(body));
  record(`${label}（${url}）`, ok, ok ? `HTTP ${status}` : `HTTP ${status}${errs.length ? `；${errs.join(' | ').slice(0, 200)}` : ''}${opts.expectText && !opts.expectText.test(body) ? '；缺少預期文字' : ''}${opts.notText && opts.notText.test(body) ? '；出現不該出現的文字' : ''}`);
  if (opts.shot) await page.screenshot({ path: path.join(SHOTS, opts.shot), fullPage: true });
  return body;
}

async function refundRow(page: Page, reasonText: string) {
  const row = page.locator('[data-testid^="refund-row-"]', { hasText: reasonText }).first();
  await row.waitFor({ timeout: 15_000 });
  return row;
}

async function main() {
  if (!PASSWORD) throw new Error('請設定 E2E_PASSWORD（DEMO 帳號密碼）');
  fs.mkdirSync(SHOTS, { recursive: true });
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM ?? undefined });
    const health = await (await fetch(`${BASE}/api/health`)).json();
    record('健康檢查含資料庫連線', health?.data?.db === 'up');

    // ---- 營運主管：總覽、案件、核准退款 ----
    {
      const ctx: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); const w = new Watch(page);
      page.on('dialog', (d) => { void d.accept(); });
      await login(page, 'demo-manager@example.invalid');
      await visit(page, w, '/aftersales', '售後總覽與案件列表', { shot: 'aftersales-01-list.png', expectText: /處理中案件/ });
      record('總覽卡片：處理中／逾期／高優先／待核准／待完成', (await page.getByTestId('aftersales-overview').locator('[data-testid^="kpi-"]').count()) >= 10);
      const overdue = await page.getByTestId('kpi-as-overdue-value').innerText();
      record('逾期案件數 ≥ 1（DEMO 含一件逾期客訴）', Number(overdue) >= 1, `逾期=${overdue}`);
      const rows = await page.locator('[data-testid^="case-row-"]').count();
      record('列表預設只顯示處理中案件，且有資料', rows >= 3, `${rows} 列`);
      const allBody = await visit(page, w, '/aftersales?status=ALL', '切換為「全部」狀態（含已結案／已取消）', { expectText: /已取消/ });
      record('「全部」會多出已結案與已取消的案件', /已結案/.test(allBody) && /已取消/.test(allBody));
      await visit(page, w, '/aftersales?overdue=1', '只看逾期', { expectText: /收到商品外盒破損/, notText: /想退貨：用不習慣/ });
      await visit(page, w, '/aftersales?q=%25', '搜尋萬用字元不會誤配全部', { expectText: /沒有符合條件的案件/ });

      await page.goto(`${BASE}/aftersales`, { waitUntil: 'networkidle' });
      await Promise.all([page.waitForURL(/\/aftersales\/CAS-/), page.locator('[data-testid^="case-row-"]', { hasText: '想退貨：用不習慣' }).locator('a').first().click()]);
      await page.waitForLoadState('networkidle');
      const detail = await page.locator('body').innerText();
      record('案件詳情：狀態、關聯訂單、處理紀錄、退款申請', /處理中/.test(detail) && /關聯訂單：ORD-/.test(detail) && /申請退款/.test(detail) && /待核准/.test(detail));
      record('有未完成退款時顯示提示橫幅', (await page.getByTestId('pending-refund-banner').count()) > 0);
      await page.screenshot({ path: path.join(SHOTS, 'aftersales-02-case-detail.png'), fullPage: true });

      // 退款佇列：核准
      await visit(page, w, '/aftersales/refunds', '退款申請佇列', { shot: 'aftersales-03-refund-queue.png', expectText: /待核准/ });
      const toApprove = await refundRow(page, '買家要求部分退款，已與團主確認');
      await toApprove.locator('button[data-testid^="btn-approve-"]').click();
      await page.waitForLoadState('networkidle');
      await page.waitForFunction(() => !document.body.innerText.includes('買家要求部分退款，已與團主確認') || document.body.innerText.includes('已核准'), null, { timeout: 15_000 });
      await visit(page, w, '/aftersales/refunds?status=APPROVED', '核准後出現在「已核准」', { expectText: /買家要求部分退款，已與團主確認/ });
      record('主管看不到「標記完成」（只有財務／管理者能完成）', (await page.locator('button[data-testid^="btn-complete-"]').count()) === 0);

      // 手機尺寸
      await page.setViewportSize({ width: 390, height: 844 });
      await visit(page, w, '/aftersales', '手機尺寸可開啟售後列表', { shot: 'aftersales-04-list-mobile.png' });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
      record('手機尺寸頁面沒有橫向捲動', !overflow);
      await ctx.close();
    }

    // ---- 財務：完成退款（預設不寫回）----
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); const w = new Watch(page);
      await login(page, 'demo-finance@example.invalid');
      await visit(page, w, '/aftersales', '財務可看售後列表', { expectText: /處理中案件/ });
      record('財務沒有「新增案件」按鈕', (await page.getByTestId('btn-new-case').count()) === 0);
      await visit(page, w, '/aftersales/refunds?status=APPROVED', '財務退款佇列（已核准）', { expectText: /已核准/ });
      record('財務看不到「核准／退回」按鈕', (await page.locator('button[data-testid^="btn-approve-"]').count()) === 0);
      const row = await refundRow(page, '商品瑕疵，全額退款');
      await row.locator('button[data-testid^="btn-complete-"]').click();
      const dlg = page.locator('dialog[open]');
      await dlg.waitFor({ timeout: 10_000 });
      record('完成退款對話框：寫回訂單核取方塊預設未勾選', !(await dlg.getByTestId('field-writeback').isChecked()));
      await page.screenshot({ path: path.join(SHOTS, 'aftersales-05-complete-dialog.png') });
      await dlg.getByTestId('field-note').fill('E2E：已匯款');
      await dlg.locator('button[type="submit"]').click();
      await page.waitForFunction(() => !document.querySelector('dialog[open]'), null, { timeout: 15_000 });
      await visit(page, w, '/aftersales/refunds?status=COMPLETED', '完成後出現在「已完成」', { expectText: /商品瑕疵，全額退款/ });
      const completedRow = await refundRow(page, '商品瑕疵，全額退款');
      record('預設完成時沒有寫回訂單', !/已寫回訂單/.test(await completedRow.innerText()));
      await page.screenshot({ path: path.join(SHOTS, 'aftersales-06-refund-completed.png'), fullPage: true });
      await ctx.close();
    }

    // ---- 營運小編：建案、處理、備註、個資防呆、申請退款 ----
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); const w = new Watch(page);
      await login(page, 'demo-editor@example.invalid');
      await visit(page, w, '/aftersales/new', '新增案件表單', { shot: 'aftersales-07-new.png', expectText: /請勿填寫買家的姓名/ });
      await page.getByTestId('field-campaignId').selectOption({ index: 1 });
      await page.getByTestId('field-title').fill('E2E：配送延遲詢問');
      await page.getByTestId('field-description').fill('買家來電 0912-345-678 詢問');
      await page.getByTestId('case-create-form-submit').click();
      await page.getByTestId('form-error').waitFor({ timeout: 10_000 });
      record('描述含手機號碼 → 被擋下並提示', /請勿填寫電話或 Email/.test(await page.getByTestId('form-error').innerText()));
      await page.getByTestId('field-description').fill('買家詢問配送進度');
      await Promise.all([page.waitForURL(/\/aftersales\/CAS-/, { timeout: 20_000 }), page.getByTestId('case-create-form-submit').click()]);
      await page.waitForLoadState('networkidle');
      const created = page.url();
      record('建案成功並導向案件詳情', /\/aftersales\/CAS-\d{6}$/.test(created), created);
      record('新案件為「新案件」狀態', /新案件/.test(await page.getByTestId('case-status').innerText()));

      await page.getByTestId('btn-to-IN_PROGRESS').click();
      await page.waitForFunction(() => document.querySelector('[data-testid="case-status"]')?.textContent?.includes('處理中'), null, { timeout: 15_000 });
      record('按「開始處理」→ 狀態變為處理中', true);

      await page.getByTestId('btn-add-note').click();
      const dlg = page.locator('dialog[open]');
      await dlg.getByTestId('field-note').fill('先聯絡物流確認進度');
      await dlg.getByTestId('field-public').check();
      await dlg.locator('button[type="submit"]').click();
      await page.waitForFunction(() => document.body.innerText.includes('先聯絡物流確認進度'), null, { timeout: 15_000 });
      record('新增對外可見備註 → 紀錄出現並標示「對外可見」', /對外可見/.test(await page.getByTestId('case-events').innerText()));

      // 取消需要原因
      await page.getByTestId('btn-to-CANCELLED').click();
      const d2 = page.locator('dialog[open]');
      await d2.locator('button[type="submit"]').click();
      record('取消案件未填原因 → 前端擋下', /請填寫取消原因/.test(await d2.innerText()));
      await d2.locator('button[aria-label="關閉"]').click();

      // 無關聯訂單的案件：可申請退款，列表出現「待核准」
      await page.getByTestId('btn-request-refund').click();
      const d3 = page.locator('dialog[open]');
      await d3.getByTestId('field-amount').fill('123');
      await d3.getByTestId('field-reason').fill('E2E 無訂單退款');
      await d3.locator('button[type="submit"]').click();
      await page.waitForFunction(() => document.body.innerText.includes('E2E 無訂單退款'), null, { timeout: 15_000 });
      record('無訂單的案件可申請退款，出現在退款區塊並為「待核准」', /待核准/.test(await page.getByTestId('case-refunds').innerText()));
      await page.screenshot({ path: path.join(SHOTS, 'aftersales-08-case-processing.png'), fullPage: true });

      // 有訂單的 DEMO 案件：超過可退餘額會被擋下
      await page.goto(`${BASE}/aftersales`, { waitUntil: 'networkidle' });
      await Promise.all([page.waitForURL(/\/aftersales\/CAS-/), page.locator('[data-testid^="case-row-"]', { hasText: '規格選錯，想換 120ml' }).locator('a').first().click()]);
      await page.waitForLoadState('networkidle');
      await page.getByTestId('btn-request-refund').click();
      const d4 = page.locator('dialog[open]');
      await d4.getByTestId('field-amount').fill('99999999');
      await d4.getByTestId('field-reason').fill('E2E 超額退款測試');
      await d4.locator('button[type="submit"]').click();
      await d4.getByTestId('form-error').waitFor({ timeout: 10_000 });
      const msg = await d4.getByTestId('form-error').innerText();
      record('有訂單的案件：退款金額超過可退餘額 → 被擋下並說明餘額', /超過可退餘額/.test(msg), msg.slice(0, 80));
      await ctx.close();
    }

    // ---- 團主／廠商：只看自己範圍的摘要 ----
    for (const [email, label] of [['demo-host1@example.invalid', '團主'], ['demo-vendor@example.invalid', '廠商']] as const) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); const w = new Watch(page);
      await login(page, email);
      record(`${label}側欄有「售後」`, (await page.getByTestId('nav-aftersales').count()) > 0);
      const body = await visit(page, w, '/aftersales', `${label}：售後列表`, { shot: label === '團主' ? 'aftersales-09-host-list.png' : undefined, notText: /內部：|退款申請\b|新增案件/ });
      record(`${label}列表沒有負責人、退款欄位、新增按鈕`, !/負責人/.test(body) && (await page.getByTestId('btn-new-case').count()) === 0 && (await page.getByTestId('btn-refund-queue').count()) === 0);
      record(`${label}看不到待核准／待完成退款卡片`, (await page.getByTestId('kpi-as-refund-requested').count()) === 0);
      const first = page.locator('[data-testid^="case-row-"] a').first();
      if (await first.count()) {
        await Promise.all([page.waitForURL(/\/aftersales\/CAS-/), first.click()]);
        await page.waitForLoadState('networkidle');
        const d = await page.locator('body').innerText();
        record(`${label}看得到對外備註，看不到內部備註與內部處理資訊`, /已安排補寄新品/.test(d) && !/先確認物流|內部：/.test(d));
        record(`${label}案件詳情：沒有內部備註、描述、買家代號、退款區塊`, !/內部備註|問題描述|買家代號|退款申請|內部：/.test(d) && (await page.getByTestId('case-refunds').count()) === 0, d.slice(0, 80).replace(/\n/g, ' '));
        if (label === '團主') await page.screenshot({ path: path.join(SHOTS, 'aftersales-10-host-detail.png'), fullPage: true });
        record(`${label}沒有任何狀態變更按鈕`, (await page.getByTestId('case-actions').count()) === 0);
      } else record(`${label}範圍內有案件可看`, false);
      const r = await page.goto(`${BASE}/aftersales/refunds`, { waitUntil: 'networkidle' });
      record(`${label}不能開退款佇列（顯示權限不足）`, /沒有權限|權限不足/.test(await page.locator('body').innerText()), `HTTP ${r?.status()}`);
      const api = await ctx.request.post(`${BASE}/api/aftersales/cases`, { data: { campaignId: 'CMP-X', caseType: 'OTHER', title: 'x' }, headers: { origin: BASE } });
      record(`${label}直接打 API 建案 → 403`, api.status() === 403, `HTTP ${api.status()}`);
      await ctx.close();
    }

    // 未登入
    {
      const ctx = await browser.newContext(); const page = await ctx.newPage();
      await page.goto(`${BASE}/aftersales`, { waitUntil: 'networkidle' });
      record('未登入造訪 /aftersales 會被導到登入頁', page.url().includes('/login'), page.url());
      const api = await ctx.request.get(`${BASE}/api/aftersales/cases`);
      record('未登入呼叫售後 API → 401', api.status() === 401, `HTTP ${api.status()}`);
      await ctx.close();
    }
  } finally {
    await browser?.close();
  }
  const failed = checks.filter((c) => !c.ok);
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ ranAt: new Date().toISOString(), total: checks.length, passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
  console.log(`\n結果：${checks.length - failed.length}/${checks.length} 通過`);
  if (failed.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
