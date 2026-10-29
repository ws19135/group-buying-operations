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
  // 埠號已被舊的伺服器佔用時，新啟動的會失敗、測試卻打到舊程式——先確認沒有舊伺服器，避免測到過期的版本
  const stale = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
  if (stale) throw new Error(`${BASE} 已有伺服器在執行（可能是上一次測試殘留的舊版本）。請先停止它，或設定 E2E_BASE_URL 指向要測的伺服器。`);
  // detached：讓 npx 與底下的 next-server 同屬一個行程群組，結束時才能一起收掉
  const child = spawn('npx', ['next', 'start', '-p', String(PORT)], { env: { ...process.env, APP_ENV: process.env.APP_ENV ?? 'development' }, stdio: 'ignore', detached: true });
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

    // ---- 客群分析與商品適配（SOP 01） ----
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); const w = new Watch(page);
      await login(ctx, page, 'demo-manager@example.invalid');
      // 每次執行都先建一位全新的團主（可重複執行），用來驗證「尚未建立客群分析」的空狀態
      const freshName = `[E2E] 新團主 ${Date.now().toString(36)}`;
      await page.goto(`${BASE}/hosts`, { waitUntil: 'networkidle' });
      const created = await page.evaluate(async (n) => (await fetch('/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: n }) })).json(), freshName);
      const freshId = created?.data?.id as string;
      await page.evaluate(async (n) => (await fetch('/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: n }) })).json(), `${freshName} 無客群`);   // 這一位保持沒有客群分析，供「資料不足」檢查
      const list = await visit(page, w, '/hosts', '團主列表顯示客群分析欄', { expectText: /客群分析/ });
      const filtered = await visit(page, w, `/hosts?q=${encodeURIComponent(freshName)}`, '以名稱篩出新團主');
      record('團主列表：有客群者顯示個數、沒有者顯示「未建立」', /\d+ 個客群/.test(list) && /未建立/.test(filtered));
      await page.goto(`${BASE}/hosts?q=${encodeURIComponent('小雅')}`, { waitUntil: 'networkidle' });
      const yaLink = page.locator('[data-testid^="host-row-"] a').first();
      await Promise.all([page.waitForURL(/\/hosts\/OWN-/), yaLink.click()]);
      await page.waitForLoadState('networkidle');
      const ya = await page.locator('body').innerText();
      record('團主詳情有「客群分析」：輪廓、動機、阻力、品類、週期、通路、觀察來源', ['客群分析', '育兒家庭 30–44 歲', '省時間', '品質安心', '陌生品牌', '怕踩雷', '家庭清潔', '親子用品', 'LINE', '每月', '觀察來源', '客群經常討論育兒'].every((t) => ya.includes(t)));
      record('合作對象類型顯示「團媽」；未提供的價格帶顯示「未知」而不是 0', (await page.getByTestId('host-partner-type').innerText()).includes('團媽') && /價格帶[\s\S]{0,40}未知/.test(ya));
      record('每個偏好標示事實／估計', (await page.locator('[data-testid^="seg-motives-"] .chip .b').count()) >= 2);
      await page.screenshot({ path: path.join(SHOTS, '20-host-segments.png'), fullPage: true });
      w.take();

      // 為全新團主用畫面建立客群分析
      await page.goto(`${BASE}/hosts/${freshId}`, { waitUntil: 'networkidle' });
      record('尚未建立客群分析的團主顯示空狀態與引導', (await page.getByTestId('segment-empty').count()) > 0);
      const segName = `[E2E] 家庭主婦 ${Date.now().toString(36)}`;
      await page.getByTestId('btn-add-segment').click();
      const dlg = page.getByTestId('btn-add-segment-dialog');
      await dlg.getByTestId('seg-name').fill(segName);
      await dlg.getByTestId('seg-ageBand').selectOption('30_44');
      await dlg.getByTestId('seg-familyType').selectOption('PARENTING');
      await dlg.getByTestId('seg-cycle').selectOption('MONTHLY');
      await dlg.getByTestId('seg-suggest-MOTIVE-省時間').click();
      await dlg.getByTestId('seg-add-BARRIER').fill('怕踩雷');
      await dlg.getByTestId('seg-add-BARRIER-btn').click();
      await dlg.getByTestId('seg-suggest-CATEGORY-家庭清潔').click();
      await dlg.getByTestId('seg-channel-LINE').check();
      await dlg.getByTestId('seg-share').fill('100');
      await dlg.getByTestId('seg-evSummary').fill('E2E：客群常在群組詢問補貨時間。');
      await dlg.getByTestId('seg-submit').click();
      await page.getByText(segName).first().waitFor({ timeout: 15_000 });
      const after = await page.locator('body').innerText();
      record('用畫面建立客群分析並連結：讀回輪廓、動機、阻力、品類、通路、觀察來源', [segName, '省時間', '怕踩雷', '家庭清潔', 'LINE', '客群常在群組詢問補貨時間'].every((t) => after.includes(t)));
      const hostId = page.url().split('/').pop() as string;
      const api = await (await ctx.request.get(`${BASE}/api/hosts/${hostId}/segments`)).json();
      record('API 讀回與畫面一致（狀態為待補資料：缺合作對象類型等）', api?.data?.links?.length === 1 && api.data.links[0].segment.motives[0].value === '省時間' && api.data.links[0].segment.motives[0].basis === 'ESTIMATE', `status=${api?.data?.status}`);
      w.take();

      // 商品頁：候選團主適配
      await page.goto(`${BASE}/products?q=${encodeURIComponent('除菌')}`, { waitUntil: 'networkidle' });
      await Promise.all([page.waitForURL(/\/products\/PRD-/), page.locator('a[href^="/products/PRD-"]').first().click()]);
      await page.waitForLoadState('networkidle');
      await page.getByTestId('btn-assess-product').click();   // 先評估，讓剛建立、尚無客群分析的團主也有一列
      await page.getByTestId('product-fit').getByText(`${freshName} 無客群`).first().waitFor({ timeout: 15_000 });   // 限定在適配表內（商品頁的試用表單選單也會列出團主名稱）
      const prod = await page.locator('body').innerText();
      record('商品頁有「候選團主適配」：總分、建議、信心、資料完整度、覆核狀態', ['候選團主適配', '資料完整度', '待覆核'].every((t) => prod.includes(t)) && /建議合作|需人工評估|不建議/.test(prod) && (await page.locator('[data-testid^="fit-row-"]').count()) >= 3);
      record('資料不足的團主標示「資料不足」與「僅供參考」，不是 0 分', /資料不足/.test(prod) && /分數僅供參考/.test(prod));
      await page.locator('[data-testid^="fit-detail-"]').first().click();
      record('展開可看各維度、依據與理由；未知維度標示「未知，未計分」', /未知，未計分/.test(await page.locator('body').innerText()));
      await page.screenshot({ path: path.join(SHOTS, '21-product-fit.png'), fullPage: true });
      await page.getByTestId('btn-assess-product').click();
      await page.waitForLoadState('networkidle');
      record('再次評估：資料沒變就不新增版本（畫面無錯誤）', w.take().length === 0);

      // 檔期頁：客群適配分頁與 G1 提示
      await page.goto(`${BASE}/campaigns?q=${encodeURIComponent('保濕面膜')}`, { waitUntil: 'networkidle' });
      await Promise.all([page.waitForURL(/\/campaigns\/CMP-/), page.locator('[data-testid^="campaign-link-"]').first().click()]);
      await page.waitForLoadState('networkidle');
      const campUrl = page.url().split('?')[0];
      await page.goto(`${campUrl}?tab=fit`, { waitUntil: 'networkidle' });
      const fitTab = await page.locator('body').innerText();
      record('檔期「客群適配」分頁：說明不影響核准、列出評估與人工覆核入口', /不會.*自動核准/.test(fitTab) && (await page.locator('[data-testid^="fit-row-"]').count()) >= 1 && (await page.locator('[data-testid^="btn-fit-review-"]').count()) >= 1);
      await page.screenshot({ path: path.join(SHOTS, '22-campaign-fit.png'), fullPage: true });
      await page.goto(`${campUrl}?tab=approvals`, { waitUntil: 'networkidle' });
      record('G1 核准區有唯讀的適配評估提示（不影響申請）', (await page.getByTestId('g1-fit-note').count()) > 0 && (await page.getByTestId('btn-request-G1').count()) >= 0);

      // 總覽：覆核流程
      await visit(page, w, '/fit', '客群適配總覽', { shot: '23-fit-overview.png', expectText: /建議值，待 Owner 確認/ });
      const firstReview = page.locator('[data-testid^="btn-fit-review-"]').first();
      record('總覽有待覆核清單', (await firstReview.count()) > 0);
      if (await firstReview.count()) {
        const rid = ((await firstReview.getAttribute('data-testid')) as string).replace('btn-fit-review-', '');
        await firstReview.click();
        const rdlg = page.getByTestId(`btn-fit-review-${rid}-dialog`);
        await rdlg.getByTestId('field-decision').selectOption('NEEDS_DATA');
        await rdlg.getByTestId('field-note').fill('E2E：請先補價格帶與觀察來源');
        await rdlg.getByTestId(`fit-review-form-${rid}-submit`).click();
        await page.waitForLoadState('networkidle');
        await page.goto(`${BASE}/fit?tab=done`, { waitUntil: 'networkidle' });
        record('覆核後出現在「已覆核」並顯示覆核人、時間與意見', /需補資料/.test(await page.getByTestId(`fit-review-${rid}`).innerText()) && /E2E：請先補價格帶/.test(await page.getByTestId(`fit-review-${rid}`).innerText()));
        const stat = await (await ctx.request.get(`${BASE}/api/fit/${rid}`)).json();
        record('覆核不改檔期／商品狀態（評估內容仍不變）', stat?.data?.reviewDecision === 'NEEDS_DATA' && stat?.data?.id === rid);
      }
      await visit(page, w, '/fit?tab=config', '評分設定頁（建議值待確認、權重合計 100）', { expectText: /建議值，待 Owner 確認/ });
      record('評分設定顯示權重合計與儲存按鈕', (await page.getByTestId('cfg-sum').innerText()).includes('100%') && (await page.getByTestId('cfg-submit').isEnabled()));
      await visit(page, w, '/segments', '客群清單', { shot: '24-segments.png', expectText: /育兒家庭/ });
      await Promise.all([page.waitForURL(/\/segments\/SEG-/), page.locator('[data-testid^="segment-row-"] a').first().click()]);
      await page.waitForLoadState('networkidle');
      const segDetail = await page.locator('body').innerText();
      record('客群詳情：輪廓、連結團主、研究證據、版本與變更紀錄', ['客群輪廓', '連結的團主', '研究證據', '版本與變更紀錄'].every((t) => segDetail.includes(t)));
      await ctx.close();
    }

    // ---- 選品與試用（SOP 02／03）：主管 ----
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); const w = new Watch(page);
      await login(ctx, page, 'demo-manager@example.invalid');
      const sel = await visit(page, w, '/selection', '選品與試用總覽', { shot: '26-selection.png', expectText: /建議值，待 Owner 確認/ });
      record('導覽有「選品與試用」；說明分數不會自動核准商品或 G1', (await page.getByTestId('nav-selection').count()) > 0 && /不會.*自動核准商品或 G1/.test(sel));
      record('總覽列出待覆核的評估、審查中調查、待覆核試用、到期證據', ['待覆核的選品評估', '審查中的廠商合作資格審查', '待覆核的試用結論', '即將到期或已過期的證據'].every((t) => sel.includes(t)));
      await visit(page, w, '/selection?tab=config', '評分與有效期設定頁', { expectText: /建議值，待 Owner 確認/ });
      record('設定頁權重合計 100、可儲存', (await page.getByTestId('sel-sum').innerText()).includes('100%') && (await page.getByTestId('sel-submit').isEnabled()));

      // 廠商頁：合作資格審查
      await page.goto(`${BASE}/vendors?q=${encodeURIComponent('晴空保養')}`, { waitUntil: 'networkidle' });
      await Promise.all([page.waitForURL(/\/vendors\/VEN-/), page.locator('a[href^="/vendors/VEN-"]').first().click()]);
      await page.waitForLoadState('networkidle');
      const vend = await page.locator('body').innerText();
      record('廠商頁有「合作資格審查」：合約版本、狀態、進度、有效期；說明不阻擋 G1', vend.includes('合作資格審查') && (await page.locator('[data-testid^="dd-row-"]').count()) >= 1 && /不會.*阻擋或放行 G1/.test(vend));
      await page.screenshot({ path: path.join(SHOTS, '27-vendor-diligence.png'), fullPage: true });
      await Promise.all([page.waitForURL(/\/diligence\/VDD-/), page.locator('[data-testid^="dd-row-"] a').first().click()]);
      await page.waitForLoadState('networkidle');
      const dd = await page.locator('body').innerText();
      record('合作資格審查詳情：12 類、已核准、有效期、證據、法務標示', (await page.locator('[data-testid^="dd-item-"]').count()) === 12 && /已核准/.test(dd) && /核准有效至/.test(dd) && /已確認無虞/.test(dd) && /不判斷是否合法/.test(dd));
      await page.locator('[data-testid="dd-item-COMMISSION_TERMS"] summary').click();
      const c10m = await page.getByTestId('dd-item-COMMISSION_TERMS').innerText();   // 已核准的調查是唯讀檢視
      record('分潤條款（第 10 類）主管看得到數值', /分潤比例（%）[\s\S]{0,6}10/.test(c10m) && /結算週期（天）[\s\S]{0,6}30/.test(c10m));
      await page.screenshot({ path: path.join(SHOTS, '28-diligence.png'), fullPage: true });
      w.take();

      // 暖食堂：草稿調查含風險與法務標示；實際在畫面修改一項並讀回
      await page.goto(`${BASE}/vendors?q=${encodeURIComponent('暖食堂')}`, { waitUntil: 'networkidle' });
      await Promise.all([page.waitForURL(/\/vendors\/VEN-/), page.locator('a[href^="/vendors/VEN-"]').first().click()]);
      await page.waitForLoadState('networkidle');
      await Promise.all([page.waitForURL(/\/diligence\/VDD-/), page.locator('[data-testid^="dd-row-"] a').first().click()]);
      await page.waitForLoadState('networkidle');
      const dd2 = await page.locator('body').innerText();
      record('草稿調查：有風險、需法務／合規審查、尚不能送審', /有風險/.test(dd2) && /需法務／合規審查/.test(dd2) && /尚不能送審/.test(dd2));
      await page.locator('[data-testid="dd-item-PRICING"] summary').click();
      await page.getByTestId('dd-t-PRICING-listPrice').fill('680');
      await page.getByTestId('dd-t-PRICING-groupPrice').fill('520');
      await page.getByTestId('dd-f-status-PRICING').selectOption('CONFIRMED');
      await page.getByTestId('dd-save-PRICING').click();
      await page.waitForLoadState('networkidle');
      const ddUrl = page.url();
      await page.goto(ddUrl, { waitUntil: 'networkidle' });
      await page.locator('[data-testid="dd-item-PRICING"] summary').click();
      record('在畫面填寫的條款與狀態存檔後讀回一致', (await page.getByTestId('dd-t-PRICING-listPrice').inputValue()) === '680' && (await page.getByTestId('dd-status-PRICING').innerText()).includes('已確認'));
      w.take();

      // 商品頁：評估、試用、可行性
      await page.goto(`${BASE}/products?q=${encodeURIComponent('保濕面膜')}`, { waitUntil: 'networkidle' });
      await Promise.all([page.waitForURL(/\/products\/PRD-/), page.locator('a[href^="/products/PRD-"]').first().click()]);
      await page.waitForLoadState('networkidle');
      const prod = await page.locator('body').innerText();
      record('商品頁有「選品評估」：80 分、建議進入商務審查、合規通過、已覆核', (await page.getByTestId('eval-total').innerText()) === '80' && /建議進入商務審查/.test(prod) && /合規通過/.test(prod) && /同意採用/.test(await page.getByTestId('eval-review-line').innerText()));
      record('商品頁有「商品試用」：商品資格仍有效，可沿用', /仍有效/.test(await page.getByTestId('trial-qualification').innerText()) && (await page.locator('[data-testid^="trial-row-"]').count()) >= 2);
      record('商品頁有「商業可行性」：GMV、淨銷售額、品牌利潤、公司營業收入分開呈現', (await page.locator('[data-testid^="fz-row-"]').count()) >= 1 && ['GMV', 'NSV', '品牌利潤', '公司營業收入'].every((t) => prod.includes(t)));
      await page.screenshot({ path: path.join(SHOTS, '29-product-selection.png'), fullPage: true });

      // 在畫面完成一份評估草稿（香氛蠟燭）：缺證據 → 補測／補件；缺的項目是未知，不是 0
      await page.goto(`${BASE}/products?q=${encodeURIComponent('香氛蠟燭')}`, { waitUntil: 'networkidle' });
      await Promise.all([page.waitForURL(/\/products\/PRD-/), page.locator('a[href^="/products/PRD-"]').first().click()]);
      await page.waitForLoadState('networkidle');
      if ((await page.getByTestId('eval-draft').count()) === 0) {   // 重跑時上次的草稿已送出：開新版本
        await page.getByTestId('btn-eval-new').click();
        await page.getByTestId('eval-draft').waitFor({ timeout: 15_000 });
      }
      record('評估草稿顯示即時試算與未評項目（未知）', (await page.getByTestId('eval-draft').count()) > 0 && /完整度/.test(await page.getByTestId('eval-preview').innerText()));
      await page.getByTestId('eval-score-quality').selectOption('4');
      await page.getByTestId('eval-reason-quality').fill('E2E：樣品質感佳');
      await page.getByTestId('eval-compliance').selectOption('PASS');
      await page.getByTestId('btn-eval-submit').click();
      await page.waitForLoadState('networkidle');
      await page.getByTestId('eval-current').waitFor({ timeout: 15_000 });
      const cand = await page.getByTestId('eval-current').innerText();
      record('送出後現行評估：品質沒附證據 → 補測／補件並列出缺證據；未評項目顯示未知', /補測／補件/.test(cand) && /缺證據/.test(cand) && /未評（未知）/.test(cand));
      w.take();

      // 試用詳情：在畫面更新檢核項
      await page.goto(`${BASE}/campaigns?q=${encodeURIComponent('保濕面膜')}`, { waitUntil: 'networkidle' });
      await Promise.all([page.waitForURL(/\/campaigns\/CMP-/), page.locator('[data-testid^="campaign-link-"]').first().click()]);
      await page.waitForLoadState('networkidle');
      const campUrl2 = page.url().split('?')[0];
      await page.goto(`${campUrl2}?tab=selection`, { waitUntil: 'networkidle' });
      const selTab = await page.locator('body').innerText();
      record('檔期「選品與試用」分頁：決策摘要（燈號、風險）、本檔試用、相關任務；明講不是 G1 檢查項', (await page.getByTestId('g1-summary').count()) > 0 && /不是 G1 的檢查項/.test(selTab) && (await page.locator('[data-testid^="g1s-product-"]').count()) >= 1 && /風險與缺口/.test(selTab) && (await page.getByTestId('campaign-trials').count()) > 0);
      await page.screenshot({ path: path.join(SHOTS, '30-campaign-selection.png'), fullPage: true });
      await page.goto(`${campUrl2}?tab=approvals`, { waitUntil: 'networkidle' });
      record('G1 核准區有唯讀的決策摘要提示（不影響申請）', (await page.getByTestId('g1-selection-note').count()) > 0 && /不影響核准/.test(await page.getByTestId('g1-selection-note').innerText()));
      await page.goto(`${campUrl2}?tab=selection`, { waitUntil: 'networkidle' });
      const openTrial = page.locator('[data-testid="campaign-trials"] a[href^="/trials/"]').first();
      await Promise.all([page.waitForURL(/\/trials\/TRL-/), openTrial.click()]);
      await page.waitForLoadState('networkidle');
      const tr = await page.locator('body').innerText();
      record('試用詳情：四大面向、系統建議、相關任務唯讀、不新增任務狀態機', ['商品本身', '顧客體驗', '內容素材', '商業效益'].every((t) => tr.includes(t)) || ['顧客體驗', '內容素材', '商業效益'].every((t) => tr.includes(t)));
      record('試用詳情：系統建議存在，尚有未測項目 → 需重測', /系統建議/.test(tr) && /需重測/.test(await page.getByTestId('trial-suggestion').innerText()));
      await page.getByTestId('check-result-demonstrable').selectOption('PASS');
      await page.getByTestId('check-evidence-demonstrable').fill('E2E：現場示範 3 次皆成功');
      await page.getByTestId('check-save-demonstrable').click();
      await page.waitForLoadState('networkidle');
      await page.goto(page.url(), { waitUntil: 'networkidle' });
      record('檢核項在畫面存檔後讀回（結果、客觀證據、驗證人）', (await page.getByTestId('check-result-demonstrable').inputValue()) === 'PASS' && (await page.getByTestId('check-evidence-demonstrable').inputValue()).includes('現場示範'));
      await page.screenshot({ path: path.join(SHOTS, '31-trial.png'), fullPage: true });
      // 沒有客觀證據就不能標通過
      const failedSave = await (async () => {
        const keyEl = page.getByTestId('check-result-quality');
        if (!(await keyEl.count())) return true;   // 沿用資格時沒有商品面向
        await keyEl.selectOption('PASS'); await page.getByTestId('check-evidence-quality').fill('');
        await page.getByTestId('check-save-quality').click();
        await page.waitForTimeout(800);
        return /客觀證據/.test(await page.locator('body').innerText());
      })();
      record('「通過」但沒填客觀證據 → 被擋並提示', failedSave);
      w.take();

      // 可行性詳情
      await page.goto(`${BASE}/products?q=${encodeURIComponent('保濕面膜')}`, { waitUntil: 'networkidle' });
      await Promise.all([page.waitForURL(/\/products\/PRD-/), page.locator('a[href^="/products/PRD-"]').first().click()]);
      await page.waitForLoadState('networkidle');
      await Promise.all([page.waitForURL(/\/feasibility\/FSB-/), page.locator('[data-testid^="fz-row-"] a').first().click()]);
      await page.waitForLoadState('networkidle');
      const fz = await page.locator('body').innerText();
      record('可行性詳情：試算結果、輸入與假設來源、版本；GMV 與公司營業收入分開', /試算結果/.test(fz) && /假設來源/.test(fz) && /GMV/.test(fz) && /公司營業收入/.test(fz) && /待 Owner 確認/.test(fz));
      await page.screenshot({ path: path.join(SHOTS, '32-feasibility.png'), fullPage: true });
      const fzId = page.url().split('/').pop() as string;
      const fzApi = await (await ctx.request.get(`${BASE}/api/feasibility/${fzId}`)).json();
      record('API 讀回：主管看得到成本與利潤', typeof fzApi?.data?.results?.brandProfit === 'number' && fzApi.data.inputs.unitCost === 200, `brandProfit=${fzApi?.data?.results?.brandProfit}`);
      w.take();
      await ctx.close();
    }

    // ---- 選品與試用：營運小編不能看到成本與分潤 ----
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); const w = new Watch(page);
      await login(ctx, page, 'demo-editor@example.invalid');
      await visit(page, w, '/selection?tab=config', '小編看得到設定但不能改', { expectText: /只有系統管理者與營運主管可以調整設定/ });
      await page.goto(`${BASE}/products?q=${encodeURIComponent('保濕面膜')}`, { waitUntil: 'networkidle' });
      await Promise.all([page.waitForURL(/\/products\/PRD-/), page.locator('a[href^="/products/PRD-"]').first().click()]);
      await page.waitForLoadState('networkidle');
      const prod = await page.locator('body').innerText();
      record('小編商品頁：可行性的成本與利潤顯示「無權限」，不顯示數字', /無權限/.test(await page.getByTestId('product-feasibility').innerText()) && /成本：無權限查看/.test(prod));
      await Promise.all([page.waitForURL(/\/feasibility\/FSB-/), page.locator('[data-testid^="fz-row-"] a').first().click()]);
      await page.waitForLoadState('networkidle');
      const fzId = page.url().split('/').pop() as string;
      const fzApi = await (await ctx.request.get(`${BASE}/api/feasibility/${fzId}`)).json();
      record('小編的 API 回應：成本、利潤、分潤為 null 並標 restricted', fzApi?.data?.restricted === true && fzApi.data.results.brandProfit === null && fzApi.data.inputs.unitCost === null && fzApi.data.inputs.hostCommissionPct === null);
      record('小編的可行性頁不顯示成本、分潤等敏感輸入項目', !/單位商品成本|團主分潤比例|品牌端服務費比例/.test(await page.locator('body').innerText()));
      // 暖食堂 / 晴空保養的第 10 類：條款被隱藏
      await page.goto(`${BASE}/vendors?q=${encodeURIComponent('晴空保養')}`, { waitUntil: 'networkidle' });
      await Promise.all([page.waitForURL(/\/vendors\/VEN-/), page.locator('a[href^="/vendors/VEN-"]').first().click()]);
      await page.waitForLoadState('networkidle');
      await Promise.all([page.waitForURL(/\/diligence\/VDD-/), page.locator('[data-testid^="dd-row-"] a').first().click()]);
      await page.waitForLoadState('networkidle');
      await page.locator('[data-testid="dd-item-COMMISSION_TERMS"] summary').click();
      const c10 = await page.getByTestId('dd-item-COMMISSION_TERMS').innerText();
      record('小編看第 10 類（分潤）：條款隱藏、提示敏感資料', /敏感資料/.test(c10) && !/10\b.*%/.test(c10));
      const ddId = page.url().split('/').pop() as string;
      const ddApi = JSON.stringify(await (await ctx.request.get(`${BASE}/api/diligence/${ddId}`)).json());
      record('小編的調查 API 回應不含分潤數值', !ddApi.includes('"ratePercent":10') && !ddApi.includes('settlementCycleDays":30'));
      const approveBtn = await page.getByTestId('btn-dd-approve').count();
      record('小編沒有核准／退回調查的按鈕', approveBtn === 0 && (await page.getByTestId('btn-dd-reject').count()) === 0);
      w.take();
      await ctx.close();
    }

    // ---- 客群分析：非授權角色看不到 ----
    {
      for (const [email, label] of [['demo-host1@example.invalid', '團主'], ['demo-vendor@example.invalid', '廠商'], ['demo-finance@example.invalid', '財務']] as const) {
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); const w = new Watch(page);
        await login(ctx, page, email);
        await visit(page, w, '/fit', `${label}不可看客群適配`, { expectText: /沒有權限/ });
        await visit(page, w, '/segments', `${label}不可看客群清單`, { expectText: /沒有權限/ });
        if (email !== 'demo-finance@example.invalid') {
          await visit(page, w, '/selection', `${label}不可看選品與試用`, { expectText: /沒有權限/ });
          record(`${label}的導覽沒有「選品與試用」`, !/選品與試用/.test(await page.locator('nav').innerText()));
        }
        const nav = await page.locator('nav').innerText();
        record(`${label}的導覽沒有「客群」與「客群適配」`, !/客群適配/.test(nav) && !/客群\n/.test(`${nav}\n`));
        if (email === 'demo-finance@example.invalid') {
          const hostsPage = await visit(page, w, '/hosts', '財務的團主列表沒有客群分析欄', { notText: /客群分析/ });
          void hostsPage;
        }
        await ctx.close();
      }
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
      for (const [url, shot] of [['/dashboard', '14-mobile-dashboard.png'], ['/campaigns', '15-mobile-campaigns.png'], ['/tasks', ''], ['/fit', '25-mobile-fit.png'], ['/segments', ''], ['/selection', '33-mobile-selection.png']] as const) {
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
    if (server?.pid) { try { process.kill(-server.pid); } catch { server.kill(); } }   // 連同 next-server 一起結束
  }
  const failed = checks.filter((c) => !c.ok);
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, total: checks.length, passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
  console.log(`\nE2E：${checks.length - failed.length}/${checks.length} 通過`);
  if (failed.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
