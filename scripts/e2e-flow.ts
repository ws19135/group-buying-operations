/**
 * 全流程 UI 驗收（Playwright）：從「新廠商、新商品、新團主」開始，只用 ERP 畫面，不呼叫手動 API、不碰資料庫：
 *   客群建檔 → 商品適配 → 選品 V2 → 廠商 12 題 → 商品試用（資格＋小規模測試團＋KPI）→ 商業可行性 → G1 審核查閱
 * 需要：已 build 的專案、已灌入 DEMO 資料的資料庫（只用虛構 DEMO 帳號與資料）。
 *   npm run build && E2E_PASSWORD=<DEMO_PASSWORD> npx tsx scripts/e2e-flow.ts
 * 結果寫入 docs/uat/e2e-flow-results.json，截圖寫入 docs/uat/screens/flow-*.png。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';
import { CHECK_CATALOG } from '../src/server/lib/trial-catalog';
import { DD_CATEGORIES } from '../src/server/lib/dd-catalog';
import { addDays } from '../src/server/lib/dates';
import { todayTaipei } from '../src/server/lib/ids';
import { loadEnv } from './load-env';

loadEnv();
const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const PASSWORD = process.env.E2E_PASSWORD ?? process.env.DEMO_PASSWORD ?? '';
const SHOTS = path.resolve('docs/uat/screens');
const RESULT_FILE = path.resolve('docs/uat/e2e-flow-results.json');
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const record = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, detail }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`); };
const tag = Date.now().toString(36);
const today = todayTaipei();

async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 500)); }
  throw new Error('伺服器未在時限內啟動');
}
async function startServer(): Promise<ChildProcess | null> {
  if (process.env.E2E_BASE_URL) return null;
  if (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) throw new Error(`${BASE} 已有伺服器在執行，請先停止或設定 E2E_BASE_URL`);
  const child = spawn('npx', ['next', 'start', '-p', String(PORT)], { env: { ...process.env, APP_ENV: process.env.APP_ENV ?? 'development' }, stdio: 'ignore', detached: true });
  await waitHealthy();
  return child;
}
async function login(page: Page, email: string) {
  await page.goto(`${BASE}/login`);
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 }), page.getByTestId('login-submit').click()]);
}
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, `flow-${name}.png`), fullPage: true });
/** 按下按鈕並等該次寫入請求回來（只等 networkidle 會在請求送出前放行） */
async function submitAndWait(page: Page, click: () => Promise<unknown>, urlPart: RegExp, method = /^(POST|PATCH|PUT)$/) {
  const [resp] = await Promise.all([page.waitForResponse((r) => method.test(r.request().method()) && urlPart.test(r.url()), { timeout: 20_000 }), click()]);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(700); // router.refresh() 會重新載入伺服器資料（含版本號），等它完成再操作下一步
  return resp;
}
async function addEvidence(page: Page, subjectId: string, title: string, kind = 'CERTIFICATE') {
  await page.getByTestId(`btn-add-evidence-${subjectId}`).first().click();
  const dlg = page.getByTestId(`btn-add-evidence-${subjectId}-dialog`).first();
  await dlg.getByTestId('field-kind').selectOption(kind);
  await dlg.getByTestId('field-title').fill(title);
  await dlg.getByTestId('field-url').fill('https://docs.example.invalid/e2e-flow');
  await submitAndWait(page, () => dlg.getByTestId(`evidence-form-${subjectId}-submit`).click(), /\/api\/evidence$/);
}

async function main() {
  if (!PASSWORD) throw new Error('請設定 E2E_PASSWORD（DEMO 帳號密碼）');
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await startServer();
  let browser: Browser | null = null; let pageRef: Page | null = null;
  const vendorName = `[E2E] 新廠商 ${tag}`, productName = `[E2E] 文具套組 ${tag}`, hostName = `[E2E] 新團主 ${tag}`, segName = `[E2E] 上班族 ${tag}`;
  try {
    browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM ?? undefined });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage(); pageRef = page;
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror@${page.url()}: ${e.message.slice(0, 40)}`));
    page.on('response', (r) => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); });
    await login(page, 'demo-manager@example.invalid');

    // ---- 0. 新廠商、新商品（含規格價格與成本）、新團主 ----
    await page.goto(`${BASE}/vendors/new`, { waitUntil: 'networkidle' });
    await page.getByTestId('field-name').fill(vendorName);
    await page.getByTestId('field-category').fill('文具');
    await page.getByTestId('field-status').selectOption('ACTIVE');
    await Promise.all([page.waitForURL(/\/vendors\/VEN-/), page.getByTestId('vendor-create-form-submit').click()]);
    const vendorId = page.url().split('/').pop() as string;
    record('新廠商：用畫面建立並導到廠商頁', vendorId.startsWith('VEN-'), vendorId);

    await page.goto(`${BASE}/products/new`, { waitUntil: 'networkidle' });
    await page.getByTestId('field-vendorId').selectOption(vendorId);
    await page.getByTestId('field-name').fill(productName);
    await page.getByTestId('field-skuCode').fill(`E2E-${tag}`);
    await page.getByTestId('field-listPrice').fill('600');
    await page.getByTestId('field-groupPrice').fill('450');
    await page.locator('input[name=costPrice]').fill('220');
    await Promise.all([page.waitForURL(/\/products\/PRD-/), page.getByTestId('product-create-submit').click()]);
    const productUrl = page.url();
    const productId = productUrl.split('/').pop() as string;
    record('新商品：用畫面建立（含規格、原價、團購價、成本）', productId.startsWith('PRD-'), productId);

    await page.goto(`${BASE}/hosts/new`, { waitUntil: 'networkidle' });
    await page.getByTestId('field-displayName').fill(hostName);
    await page.getByTestId('field-partnerType').selectOption('GROUP_MOM');
    await Promise.all([page.waitForURL(/\/hosts\/OWN-/), page.getByTestId('host-create-form-submit').click()]);
    const hostUrl = page.url(); const hostId = hostUrl.split('/').pop() as string;
    record('新團主：用畫面建立並標示合作對象類型（團媽）', hostId.startsWith('OWN-'), hostId);

    // ---- 1. SOP 01：客群建檔 → 連結團主 ----
    await page.getByTestId('btn-add-segment').click();
    const sdlg = page.getByTestId('btn-add-segment-dialog');
    await sdlg.getByTestId('seg-name').fill(segName);
    await sdlg.getByTestId('seg-ageBand').selectOption('25_29');
    await sdlg.getByTestId('seg-familyType').selectOption('SINGLE');
    await sdlg.getByTestId('seg-cycle').selectOption('MONTHLY');
    await sdlg.getByTestId('seg-add-MOTIVE').fill('提升工作效率');
    await sdlg.getByTestId('seg-add-MOTIVE-btn').click();
    await sdlg.getByTestId('seg-add-BARRIER').fill('不確定品質');
    await sdlg.getByTestId('seg-add-BARRIER-btn').click();
    await sdlg.getByTestId('seg-add-CATEGORY').fill('文具');
    await sdlg.getByTestId('seg-add-CATEGORY-btn').click();
    await sdlg.getByTestId('seg-priceMin').fill('200'); await sdlg.getByTestId('seg-priceMax').fill('600');
    await sdlg.getByTestId('seg-channel-LINE').check();
    await sdlg.getByTestId('seg-share').fill('100');
    await sdlg.getByTestId('seg-evSummary').fill('E2E：群組常詢問文具補貨與品質。');
    await sdlg.getByTestId('seg-submit').click();
    await page.getByText(segName).first().waitFor({ timeout: 15_000 });
    const hostBody = await page.locator('body').innerText();
    record('SOP 01 客群建檔（畫面）：輪廓、動機、阻力、品類、價格帶、通路、觀察證據，並連結到新團主', [segName, '提升工作效率', '不確定品質', '文具', 'LINE', '群組常詢問'].every((t) => hostBody.includes(t)));
    await shot(page, '01-host-segment');

    // ---- 2. 檔期：邀請新團主、上架新商品（G1 摘要與適配需要） ----
    await page.goto(`${BASE}/campaigns/new`, { waitUntil: 'networkidle' });
    await page.getByTestId('field-title').fill(`[E2E] 文具團 ${tag}`);
    await page.getByTestId('field-vendorId').selectOption(vendorId);
    await page.getByTestId('field-sampleReadyDate').fill(today);
    await page.getByTestId('field-openDate').fill(addDays(today, 14));
    await page.getByTestId('field-closeDate').fill(addDays(today, 24));
    await page.locator('[data-testid^="pick-PRD-"]').first().check();
    await page.getByTestId(`pick-host-${hostId}`).check();
    await Promise.all([page.waitForURL(/\/campaigns\/CMP-/), page.getByTestId('campaign-create-submit').click()]);
    const campUrl = page.url().split('?')[0]; const campId = campUrl.split('/').pop() as string;
    record('檔期：用畫面建立並邀請新團主、上架新商品', campId.startsWith('CMP-'), campId);

    // ---- 3. SOP 01：商品 × 團主適配 ----
    await page.goto(productUrl, { waitUntil: 'networkidle' });
    await submitAndWait(page, () => page.getByTestId('btn-assess-product').click(), /\/api\/products\/PRD-[^/]+\/fit$/);
    const fitText = await page.getByTestId('product-fit').innerText();
    record('SOP 01 商品適配（畫面）：新團主出現在候選名單，有分數／建議／資料完整度，並列為待覆核', fitText.includes(hostName) && /資料完整度/.test(fitText) && /待覆核/.test(fitText));
    await shot(page, '02-product-fit');

    // ---- 4. SOP 02 V2 評估 ----
    await submitAndWait(page, () => page.getByTestId('btn-eval-new').click(), /\/api\/products\/PRD-[^/]+\/evaluations/);
    await page.getByTestId('evaluation-v2-editor').waitFor({ timeout: 15_000 });
    const evalId = await page.locator('[data-testid^="btn-add-evidence-SEL-"]').first().getAttribute('data-testid').then((t) => (t ?? '').replace('btn-add-evidence-', ''));
    await addEvidence(page, evalId, '[E2E] 社群詢問彙整', 'OTHER');
    await page.getByTestId('v2-model').selectOption('AGENCY');
    await page.getByTestId('v2-input-NEED_SEGMENT_MATCH').selectOption('true');
    await page.getByTestId('v2-input-NEED_PRICE_ACCEPTABLE').selectOption('true');
    await page.getByTestId('v2-input-NEED_DEMAND_PROOF').selectOption('true');
    await page.locator(`[data-testid^="v2-ev-NEED_DEMAND_PROOF-"]`).first().check();
    await page.getByTestId('v2-input-QUAL_CERTS').selectOption('na');     // 文具：非受規範品類，可不適用（需原因）
    await page.getByTestId('v2-na-QUAL_CERTS').fill('一般文具，無受規範認證');
    await page.getByTestId('v2-input-CON_CLAIM_VERIFIED').selectOption('na');
    await page.getByTestId('v2-na-CON_CLAIM_VERIFIED').fill('一般文具，無功效宣稱');
    await page.getByTestId('v2-input-CON_USP_CLEAR').selectOption('true');
    await page.getByTestId('v2-input-REP_CONSUMABLE').selectOption('SEMI');
    await page.getByTestId('eval-compliance').selectOption('PASS');
    await submitAndWait(page, () => page.getByTestId('btn-eval-save').click(), /\/api\/evaluations\/SEL-/);
    const prev = await page.getByTestId('eval-draft').innerText();
    record('SOP 02 V2（畫面）：只列需人工填的條件；利潤條件由系統帶入（成本與價格）並在預覽顯示；SKU 毛利率、折扣深度有值', /毛利率/.test(prev) && /25/.test(await page.getByTestId('eval-draft').getByTestId('v2-value-PROF_DISCOUNT_DEPTH').innerText().catch(() => '')));
    await submitAndWait(page, () => page.getByTestId('btn-eval-submit').click(), /\/api\/evaluations\/SEL-[^/]+\/submit/);
    await page.getByTestId('eval-current').waitFor({ timeout: 15_000 });
    const cur = await page.getByTestId('eval-current').innerText();
    record('SOP 02 V2 送出：現行評估有總分、資料／證據完整度、建議（廠商調查尚未核准＝硬性條件未知，最多補件）', /證據完整度/.test(cur) && (await page.getByTestId('v2-hard-unknown').count()) === 1 && !/建議進入商務審查/.test(await page.getByTestId('v2-summary').innerText()));
    record('SOP 02 V2：不適用有原因並列在結果（認證、宣稱佐證）；沒有舊制 1～5 分表', /一般文具，無受規範認證/.test(cur) && (await page.locator('[data-testid="eval-scores"]').count()) === 0);
    await shot(page, '03-evaluation-v2');
    // 主管覆核：需補資料＋補件要求（畫面）
    await page.getByTestId('btn-eval-review').click();
    const rdlg = page.getByTestId('btn-eval-review-dialog');
    await rdlg.getByTestId('field-decision').selectOption('NEEDS_MORE');
    await rdlg.getByTestId('field-note').fill('E2E：廠商調查尚未核准，核准後請重新評估');
    await submitAndWait(page, () => rdlg.getByTestId('eval-review-form-submit').click(), /\/api\/evaluations\/SEL-[^/]+\/review/);
    await page.getByTestId('btn-supplement-new').click();
    await page.getByTestId('supplement-panel').getByTestId('field-conditionId').selectOption('SUP_DD_APPROVED');
    await page.getByTestId('supplement-panel').getByTestId('field-note').fill('E2E：請先完成並核准廠商合作資格審查');
    await submitAndWait(page, () => page.getByTestId('supplement-form-submit').click(), /\/api\/evaluations\/SEL-[^/]+\/supplements/);
    record('SOP 02 覆核與補件要求（畫面）：覆核「需補資料」並針對子條件提出補件要求，列在評估上', /待補/.test(await page.getByTestId('supplement-panel').innerText()) && /需補資料/.test(await page.getByTestId('eval-review-line').innerText()));

    // ---- 5. 廠商 12 題：建立、逐題填寫、補證據、送審、核准 ----
    await page.goto(`${BASE}/vendors/${vendorId}`, { waitUntil: 'networkidle' });
    await page.getByTestId('btn-dd-new').click();
    const ddlg = page.getByTestId('btn-dd-new-dialog');
    await ddlg.getByTestId('field-contractVersion').fill(`E2E-${tag}`);
    await Promise.all([page.waitForURL(/\/diligence\/VDD-/), ddlg.getByTestId('dd-new-form-submit').click()]);
    await page.waitForLoadState('networkidle');
    const ddUrl = page.url();
    record('廠商 12 題：用畫面建立，12 題完成進度 0/12', (await page.getByTestId('dd-progress-count').first().innerText()).includes('0/12'));
    for (const c of DD_CATEGORIES) {
      const item = page.getByTestId(`dd-item-${c.key}`);
      await item.locator('summary').click(); // 展開這一題
      if (c.evidenceRequired) {
        const itemId = await item.locator('[data-testid^="btn-add-evidence-VDI-"], [data-testid^="btn-add-evidence-"]').first().getAttribute('data-testid').then((t) => (t ?? '').replace('btn-add-evidence-', ''));
        await addEvidence(page, itemId, `[E2E] ${c.label}`, c.key === 'COMMISSION_TERMS' || c.key === 'EXCLUSIVITY_RESALE' ? 'CONTRACT' : c.key === 'SAMPLE_MEDIA_LICENSE' ? 'LICENSE' : 'CERTIFICATE');
        await page.getByTestId(`dd-f-status-${c.key}`).selectOption('CONFIRMED');
      } else {
        await page.getByTestId(`dd-f-status-${c.key}`).selectOption('NOT_APPLICABLE');
        await page.getByTestId(`dd-f-na-${c.key}`).fill('E2E：本案無此情況');
      }
      await submitAndWait(page, () => page.getByTestId(`dd-save-${c.key}`).click(), /\/api\/diligence-items\//);
    }
    const prog = await page.getByTestId('dd-progress-count').first().innerText();
    record('廠商 12 題：逐題填寫、補證據、確認／不適用後，進度 12/12 且可送審', prog.includes('12/12') && /可以送審/.test(await page.getByTestId('dd-ready').innerText()), prog);
    await submitAndWait(page, () => page.getByTestId('btn-dd-submit').click(), /\/api\/diligence\/VDD-[^/]+\/submit/);
    record('廠商 12 題：送審後狀態為審查中，可撤回', (await page.getByTestId('btn-dd-withdraw').count()) === 1);
    await page.getByTestId('btn-dd-approve').click();
    await submitAndWait(page, () => page.getByTestId('btn-dd-approve-submit').click(), /\/api\/diligence\/VDD-[^/]+\/review/);
    record('廠商 12 題：主管核准，顯示核准有效期', /核准有效至/.test(await page.getByTestId('dd-validity').innerText()));
    await shot(page, '04-diligence');
    void ddUrl;

    // ---- 6. 重新評估 V2（廠商調查已核准 → 系統自動帶入，硬性條件解除） ----
    await page.goto(productUrl, { waitUntil: 'networkidle' });
    await submitAndWait(page, () => page.getByTestId('btn-eval-new').click(), /\/api\/products\/PRD-[^/]+\/evaluations/);
    await page.getByTestId('evaluation-v2-editor').waitFor({ timeout: 15_000 });
    const draftAuto = await page.getByTestId('eval-draft').getByTestId('v2-cond-SUP_DD_APPROVED').innerText();
    record('SOP 02 V2：廠商調查核准後，新版評估的「廠商調查已核准」由系統自動取得為「是」', /已知/.test(draftAuto) && /是/.test(await page.getByTestId('eval-draft').getByTestId('v2-value-SUP_DD_APPROVED').innerText()));
    await shot(page, '05-evaluation-v2-after-dd');

    // ---- 7. 商品試用：資格（18 項）→ 結論 → 覆核；小規模測試團＋KPI＋團主意願 ----
    await page.getByTestId('btn-trial-new').click();
    const tdlg = page.getByTestId('btn-trial-new-dialog');
    await tdlg.getByTestId('field-level').selectOption('QUALIFICATION');
    await tdlg.getByTestId('field-trialType').selectOption('INTERNAL');
    await Promise.all([page.waitForURL(/\/trials\/TRL-/), tdlg.getByTestId('trial-new-form-submit').click()]);
    await page.waitForLoadState('networkidle');
    for (const c of CHECK_CATALOG) {
      await page.getByTestId(`check-result-${c.key}`).selectOption('PASS');
      await page.getByTestId(`check-evidence-${c.key}`).fill(`E2E：${c.label} 實測通過`);
      await submitAndWait(page, () => page.getByTestId(`check-save-${c.key}`).click(), /\/api\/trial-checks\//);
    }
    record('SOP 03 商品資格試用：四大面向 18 項逐項填寫（結果＋客觀證據），系統建議「通過」', CHECK_CATALOG.length === 18 && /系統建議[：:\s]*通過/.test((await page.getByTestId('trial-suggestion').innerText()).replace(/\s+/g, ' ')));
    const defConc = await page.getByTestId('trial-conclude-form').getByTestId('field-conclusion').inputValue();
    record('SOP 03：18 項填完後，結論表單的預設值自動跟著系統建議（通過），不需手動改', defConc === 'PASS', defConc);
    await page.getByTestId('trial-conclude-form').getByTestId('field-note').fill('E2E：18 項皆通過');
    await submitAndWait(page, () => page.getByTestId('trial-conclude-form-submit').click(), /\/api\/trials\/TRL-[^/]+\/conclude/);
    await page.getByTestId('btn-trial-accept').click();
    await submitAndWait(page, () => page.getByTestId('btn-trial-accept-submit').click(), /\/api\/trials\/TRL-[^/]+\/review/);
    record('SOP 03：下結論「通過」並由主管覆核接受（資格可沿用）', /通過/.test(await page.locator('body').innerText()) && /同意|接受/.test(await page.locator('body').innerText()));
    await shot(page, '06-trial-qualification');

    await page.goto(productUrl, { waitUntil: 'networkidle' });
    record('SOP 03：商品頁顯示商品資格仍有效（可沿用）', /仍有效/.test(await page.getByTestId('trial-qualification').innerText()));
    await page.getByTestId('btn-trial-new').click();
    const mdlg = page.getByTestId('btn-trial-new-dialog');
    await mdlg.getByTestId('field-level').selectOption('HOST_FIT');
    await mdlg.getByTestId('field-trialType').selectOption('MINI_GROUP');
    await mdlg.getByTestId('field-hostId').selectOption(hostId);
    await mdlg.getByTestId('field-campaignId').selectOption(campId);
    await Promise.all([page.waitForURL(/\/trials\/TRL-/), mdlg.getByTestId('trial-new-form-submit').click()]);
    await page.waitForLoadState('networkidle');
    const miniUrl = page.url();
    const kpiText = await page.getByTestId('trial-kpis').innerText();
    record('SOP 03 小規模測試團：沿用資格後只需 12 項檢核；成效 KPI 8 項，沒有訂單／出貨資料的顯示「資料不足」（不是 0）', (await page.locator('[data-testid^="check-row-"]').count()) === 12 && (await page.locator('[data-testid^="kpi-value-"]').count()) === 8 && /資料不足/.test(kpiText) && /尚未制定/.test(kpiText) && /不判定是否值得放大銷售/.test(kpiText));
    await page.getByTestId('btn-host-intent').click();
    const idlg = page.getByTestId('btn-host-intent-dialog');
    await idlg.getByTestId('field-hostIntent').selectOption('WILLING');
    await submitAndWait(page, () => idlg.getByTestId('host-intent-form-submit').click(), /\/api\/trials\/TRL-/);
    record('SOP 03 KPI：記錄團主再次合作意願（畫面）後，第 8 項顯示「願意再次合作」', /願意再次合作/.test(await page.getByTestId('kpi-value-hostIntent').innerText()));
    // K-2：觸及與導購資料（人工填寫；三種分開；每筆有來源、期間、填寫人、日期、可信度）
    const addReach = async (metric: string, value: number, sourceKind: string, sourceText: string, credibility: string) => {
      await page.getByTestId('btn-reach-add').click();
      const rdlg2 = page.getByTestId('btn-reach-add-dialog');
      await rdlg2.getByTestId('field-metric').selectOption(metric);
      await rdlg2.getByTestId('field-value').fill(String(value));
      await rdlg2.getByTestId('field-sourceKind').selectOption(sourceKind);
      await rdlg2.getByTestId('field-sourceText').fill(sourceText);
      await rdlg2.getByTestId('field-periodStart').fill(addDays(today, 14));
      await rdlg2.getByTestId('field-periodEnd').fill(addDays(today, 24));
      await rdlg2.getByTestId('field-credibility').selectOption(credibility);
      if (metric === 'QUALIFIED_VISITORS') {
        await rdlg2.getByTestId('field-evidenceRef').fill('[E2E] 短連結報表 R-001');
        await rdlg2.getByTestId('field-dedupeMethod').selectOption('SHORT_LINK_UNIQUE_CLIENTS');
      }
      return submitAndWait(page, () => rdlg2.getByTestId('reach-form-submit').click(), /\/api\/trials\/TRL-[^/]+\/reach$/);
    };
    await addReach('POTENTIAL_REACH', 120, 'LINE_GROUP_MEMBERS', '[E2E] LINE 群組成員數（團主截圖）', 'MEDIUM');
    await addReach('ACTUAL_REACH', 80, 'PLATFORM_POST_REACH', '[E2E] 社群貼文後台', 'HIGH');
    await addReach('QUALIFIED_VISITORS', 60, 'SHORT_LINK_UNIQUE_VISITORS', '[E2E] 導購短連結後台', 'HIGH');
    const reachText = await page.getByTestId('trial-reach').innerText();
    record('K-2 觸及與導購資料（畫面）：潛在觸及、實際觸及、有效導購訪客三種分開填寫，每筆有來源、統計期間、填寫人、填寫日期與可信度', ['潛在觸及人數', '實際觸及人數', '有效導購訪客', '[E2E] 導購短連結後台', '導購短連結不重複訪客'].every((t) => reachText.includes(t)) && /\d{4}-\d{2}-\d{2}/.test(reachText));
    // K-4：填寫者自選「高」不算已驗證：自己不能查核；另一位有權限的人（管理者）查核後才採用
    const trialUrl = page.url();
    const own = await page.locator('[data-testid^="reach-verify-status-"]').first().innerText();
    record('K-4 有效導購訪客：填寫後是「未查核（填寫者自述）」，填寫者自己沒有查核按鈕，並提示需另一位有權限的人查核；畫面顯示佐證、去重方式與規則版本', /未查核/.test(own) && (await page.locator('[data-testid^="btn-reach-verify-"]').count()) === 0 && /需由另一位有權限的人查核/.test(await page.getByTestId('trial-reach').innerText()) && /佐證：\[E2E\] 短連結報表 R-001/.test(await page.getByTestId('trial-reach').innerText()) && /reach-rules\//.test(await page.getByTestId('reach-rules').innerText()));
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page2 = await ctx2.newPage();
    await login(page2, 'demo-admin@example.invalid');
    await page2.goto(trialUrl, { waitUntil: 'networkidle' });
    const vbtn = page2.locator('button[data-testid^="btn-reach-verify-"]').first();
    const vid = (await vbtn.getAttribute('data-testid')) as string;
    await vbtn.click();
    await page2.getByTestId(`${vid}-dialog`).getByTestId('field-reason').fill('[E2E] 已對照短連結報表 R-001，去重方式為不重複用戶端');
    await submitAndWait(page2, () => page2.getByTestId(`${vid}-submit`).click(), /\/api\/reach-records\/RCH-[^/]+\/verify$/);
    await ctx2.close();
    await page.goto(trialUrl, { waitUntil: 'networkidle' });
    record('K-4 第二位有權限的人查核後：顯示「已查核」、查核者與說明；CVR 因為沒有有效訂單仍是資料不足，原因不再是「尚未查核」', /已查核/.test(await page.locator('[data-testid^="reach-verify-status-"]').first().innerText()) && !/尚未經第二位/.test(await page.getByTestId('kpi-conversionRate').innerText()));
    const cvrText = await page.getByTestId('kpi-conversionRate').innerText();
    record('K-2 沒有有效訂單時 CVR 仍是資料不足；群組成員訂單比另列且標明「不是 CVR、不代表實際觸及」；潛在與實際觸及不會被當成分母', /資料不足/.test(cvrText) && /群組成員訂單比/.test(cvrText) && /不是 CVR/.test(cvrText) && /不代表實際觸及/.test(cvrText) && /潛在觸及人數：120 人/.test(cvrText) && /實際觸及人數：80 人/.test(cvrText));
    record('K-3 每單貢獻利潤在條款不全或來源未確認時是資料不足（未知成本不當 0）', /資料不足/.test(await page.getByTestId('kpi-value-contributionPerOrder').innerText()));
    await shot(page, '07-trial-mini-group-kpi');
    // 刪除一筆（軟刪除，保留紀錄與原因）
    const voidBtn = page.locator('button[data-testid^="btn-reach-void-"]').first();
    const voidId = (await voidBtn.getAttribute('data-testid')) as string;
    await voidBtn.click();
    const vdlg = page.getByTestId(`${voidId}-dialog`);
    await vdlg.getByTestId('field-reason').fill('[E2E] 數字填錯，重新填寫');
    await submitAndWait(page, () => vdlg.getByTestId(`${voidId}-submit`).click(), /\/api\/reach-records\/RCH-[^/]+\/void$/);
    record('K-2 刪除是軟刪除：畫面保留「已刪除的紀錄」與原因，不計入', (await page.getByTestId('reach-removed-summary').count()) === 1);
    void miniUrl;

    // ---- 8. 商業可行性（試算） ----
    await page.goto(productUrl, { waitUntil: 'networkidle' });
    await page.getByTestId('btn-fz-open').click();
    const fdlg = page.getByTestId('btn-fz-open-dialog');
    record('K-3 可行性表單：有「退款／退貨處理成本與負擔方」、收款方欄位，來源可選「合約」或「正式商務條件（已確認）」，並說明未確認來源的實際貢獻利潤維持資料不足', (await fdlg.getByTestId('fz-terms-note').count()) === 1 && (await fdlg.getByTestId('fz-returnCostPerRefundOrder').count()) === 1 && (await fdlg.getByTestId('fz-returnCostBorneBy').count()) === 1 && (await fdlg.getByTestId('fz-src-hostCommissionPct').locator('option', { hasText: '正式商務條件（已確認）' }).count()) === 1);
    await fdlg.getByTestId('fz-campaign').selectOption(campId).catch(() => undefined);
    const vals: Record<string, string> = { expectedOrders: '100', unitPrice: '450', refundRatePct: '5', unitCost: '220', shippingPerOrder: '40', platformFeePct: '2', otherVariablePerOrder: '0', fixedCost: '1000', brandFeePct: '10', serviceFeeFixed: '0', hostCommissionPct: '8' };
    for (const [k, v] of Object.entries(vals)) await fdlg.getByTestId(`fz-${k}`).fill(v);
    for (const [k, v] of Object.entries({ commissionBasis: 'NSV', hostPaidBy: 'COMPANY', cashFlowMode: 'BRAND_COLLECTS', shippingBorneBy: 'BRAND', platformFeeBorneBy: 'BRAND', otherCostBorneBy: 'COMPANY', fixedCostBorneBy: 'COMPANY' })) await fdlg.getByTestId(`fz-${k}`).selectOption(v);
    await submitAndWait(page, () => fdlg.getByTestId('fz-submit').click(), /\/api\/products\/PRD-[^/]+\/feasibility/);
    const fz = await page.getByTestId('product-feasibility').innerText();
    record('SOP 03 商業可行性（畫面）：GMV、有效淨銷售額、品牌利潤、公司營業收入分開呈現，每個假設標註來源', ['GMV', '品牌利潤', '公司營業收入'].every((t) => fz.includes(t)) && (await page.locator('[data-testid^="fz-row-"]').count()) >= 1);
    await shot(page, '08-feasibility');

    // ---- 9. 新版 V2 評估：自動帶入可行性與調查，送出；覆核採用 ----
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByTestId('v2-model').selectOption('AGENCY');
    await page.getByTestId('v2-input-NEED_SEGMENT_MATCH').selectOption('true');
    await page.getByTestId('v2-input-CON_USP_CLEAR').selectOption('true');
    await page.getByTestId('v2-input-QUAL_CERTS').selectOption('na'); await page.getByTestId('v2-na-QUAL_CERTS').fill('一般文具，無受規範認證');
    await page.getByTestId('v2-input-CON_CLAIM_VERIFIED').selectOption('na'); await page.getByTestId('v2-na-CON_CLAIM_VERIFIED').fill('一般文具，無功效宣稱');
    await page.getByTestId('eval-compliance').selectOption('PASS');
    await submitAndWait(page, () => page.getByTestId('btn-eval-save').click(), /\/api\/evaluations\/SEL-/);
    const auto2 = await page.getByTestId('eval-draft').innerText();
    record('SOP 02 V2：可行性試算、廠商調查、試用結論都由系統自動帶入（貢獻利潤率、廠商已核准、試用通過）', /試算/.test(auto2) && /是/.test(await page.getByTestId('eval-draft').getByTestId('v2-value-SUP_DD_APPROVED').innerText()) && /通過/.test(await page.getByTestId('eval-draft').getByTestId('v2-value-QUAL_TRIAL').innerText()) && (await page.getByTestId('eval-draft').getByTestId('v2-cond-PROF_CONTRIB_MARGIN').innerText()).includes('已知'));
    await submitAndWait(page, () => page.getByTestId('btn-eval-submit').click(), /\/api\/evaluations\/SEL-[^/]+\/submit/);
    await page.getByTestId('eval-current').waitFor({ timeout: 15_000 });
    await shot(page, '09-evaluation-v2-final');

    // ---- 10. G1 審核查閱 ----
    await page.goto(`${campUrl}?tab=selection`, { waitUntil: 'networkidle' });
    const g1 = await page.getByTestId('g1-summary').innerText();
    record('G1 統一決策摘要（畫面）：選品評估（V2）、廠商 12 題進度、試用、可行性彙整在同一頁，並標明不是 G1 檢查項', /V2 子條件評分/.test(g1) && (await page.locator('[data-testid^="g1s-ddprog-"]').count()) >= 1 && /12\/12/.test(g1) && /小規模測試團|試用/.test(g1) && /不是 G1（選品核准）的/.test(await page.locator('body').innerText()));
    await shot(page, '10-g1-summary');
    // 檔期推進到「評估中」（畫面上的推進按鈕），核准區才會出現 G1（選品核准）
    await page.goto(campUrl, { waitUntil: 'networkidle' });
    await submitAndWait(page, () => page.getByTestId('btn-transition-EVALUATING').click(), /\/api\/campaigns\/CMP-[^/]+\/status/);
    await page.goto(`${campUrl}?tab=approvals`, { waitUntil: 'networkidle' });
    await shot(page, '11-approvals-g1');
    record('G1 核准區（檔期推進到「評估中」後）有唯讀的決策摘要提示；必要檢查（前置任務、團主確認）未過時仍「無法申請」——評分與試用不會自動核准、也不會繞過 G1', (await page.getByTestId('g1-selection-note').count()) > 0 && /不影響核准/.test(await page.getByTestId('g1-selection-note').innerText()) && (await page.getByTestId('btn-request-G1').count()) === 0 && /必要檢查未通過，無法申請/.test(await page.locator('body').innerText()));
    // ---- K-5：客訴歸屬團主（優先訂單歸因；無法辨識＝未歸屬；人工指定需說明並記錄來源） ----
    await page.goto(`${BASE}/aftersales/new?campaignId=${campId}`, { waitUntil: 'networkidle' });
    await page.getByTestId('field-title').fill('[E2E] 客訴：外盒破損');
    await Promise.all([page.waitForURL(/\/aftersales\/CAS-/), page.getByTestId('case-create-form-submit').click()]);
    await page.waitForLoadState('networkidle');
    record('K-5 新客訴沒有關聯訂單：團主歸屬顯示「未歸屬（保留未歸屬，不任意分配）」，並明講客訴率不作為懲罰或停權依據', /未歸屬/.test(await page.getByTestId('case-host-attribution').innerText()) && /不作為團主懲罰、停權或自動處置的依據/.test(await page.getByTestId('case-host-attribution').innerText()));
    await page.getByTestId('btn-case-host').click();
    const cdlg = page.getByTestId('btn-case-host-dialog');
    await cdlg.getByTestId('field-hostId').selectOption(hostId);
    await cdlg.getByTestId('field-note').fill('[E2E] 買家說明是從這位團主的群組加入');
    await submitAndWait(page, () => cdlg.getByTestId('case-host-form-submit').click(), /\/api\/aftersales\/cases\/CAS-[^/]+\/host-attribution$/);
    record('K-5 人工指定團主（畫面）：顯示「人工指定」、團主名稱與說明', /人工指定/.test(await page.getByTestId('case-host-attribution').innerText()) && (await page.getByTestId('case-host-attribution').innerText()).includes(hostName) && /買家說明是從這位團主的群組加入/.test(await page.getByTestId('case-host-attribution').innerText()));
    await shot(page, '14-case-host-attribution');
    await page.goto(miniUrl, { waitUntil: 'networkidle' });
    const cd = await page.getByTestId('kpi-complaintDefect').innerText();
    record('K-5 KPI 的客訴率分成「檔期整體」與「此團主層級」，並列出歸屬件數與未歸屬件數', /客訴率（檔期整體/.test(cd) && /客訴率（此團主層級/.test(cd) && /歸屬此團主 1 件/.test(cd) && /未歸屬 0 件/.test(cd));

    // ---- K-6／K-8／K-7：財務口徑核對（唯讀） ----
    await page.goto(`${BASE}/finance/reconciliation`, { waitUntil: 'networkidle' });
    const recon = await page.getByTestId('recon-summary').innerText();
    const reconNote = await page.getByTestId('recon-note').innerText();
    record('K-6 分潤口徑差異核對（畫面）：列出檔期×團主×商品的比較與待人工覆核清單；明講不自動覆蓋任何一方、不改結算；缺合約條件標示資料不足', /待人工覆核/.test(recon) && /不會自動以任何一方覆蓋另一方/.test(reconNote) && (await page.getByTestId('recon-review').innerText()).includes(`[E2E] 文具團 ${tag}`) && /資料不足|沒有填團主分潤比例/.test(await page.getByTestId('recon-table').innerText()));
    await shot(page, '15-commission-reconciliation');
    await page.goto(`${BASE}/finance/reconciliation?tab=fees`, { waitUntil: 'networkidle' });
    const feeText = await page.getByTestId('fee-summary').innerText();
    record('K-8 費用歸屬對照（畫面）：列出 KPI 與正式結算尚未一致的費用項目、可能的應收／應付與需確認事項；唯讀', /尚未一致的費用項目/.test(feeText) && (await page.locator('[data-testid^="fee-row-shipping"]').count()) >= 1 && /可能|無法判斷/.test(await page.locator('[data-testid^="fee-row-shipping"]').first().innerText()) && /不入帳|不改任何資料/.test(await page.getByTestId('fee-note').innerText()));
    await shot(page, '16-fee-attribution');
    await page.goto(`${BASE}/finance/reconciliation?tab=allocation&campaignId=${campId}`, { waitUntil: 'networkidle' });
    record('K-7 多商品成本分攤提案（畫面）：明講提案、未生效、多商品維持資料不足；單一商品檔期不需要分攤', /提案，未生效/.test(await page.getByTestId('alloc-note').innerText()) && /不需要分攤/.test(await page.getByTestId('alloc-inventory').innerText()));
    // ---- K-1：測試團 KPI 累積彙整（只整理，不設門檻） ----
    await page.goto(`${BASE}/selection?tab=kpi`, { waitUntil: 'networkidle' });
    const sumText = await page.getByTestId('kpi-summary-view').innerText();
    record('K-1 測試團 KPI 彙整：顯示累積檔數進度（／5）、各測試團的商品類別與團主類型，明講不判定是否值得放大銷售，沒有任何達標字眼', /已累積/.test(sumText) && /[／/] ?5 檔/.test(sumText) && /不判定是否值得放大銷售/.test(sumText) && sumText.includes(productName) && sumText.includes(hostName) && /團媽/.test(sumText) && !/已達標|未達標|建議放大/.test(sumText));
    await shot(page, '13-kpi-summary');
    // ---- 11. 選品 V2 設定畫面（提案設定；未經 Owner 確認不啟用門檻） ----
    await page.goto(`${BASE}/selection?tab=config2`, { waitUntil: 'networkidle' });
    const cfgBanner = await page.getByTestId('v2-config-banner').innerText();
    record('選品 V2 設定畫面：未確認的權重與門檻明確標示為「提案」，30 個子條件目錄唯讀列出', /提案|尚未確認|未經/.test(cfgBanner) && (await page.locator('[data-testid^="v2-cat-"]').count()) === 30, cfgBanner.slice(0, 40));
    await page.getByTestId('v2-cfg-minCompleteness').fill('0.6');
    const approvedBefore = await page.getByTestId('v2-cfg-approved').isChecked();
    await submitAndWait(page, () => page.getByTestId('v2-cfg-submit').click(), /\/api\/selection\/config-v2$/);
    await page.reload({ waitUntil: 'networkidle' });
    record('選品 V2 設定畫面：儲存新版本（仍為「提案」未確認）、重新載入後數值保留', !approvedBefore && !(await page.getByTestId('v2-cfg-approved').isChecked()) && (await page.getByTestId('v2-cfg-minCompleteness').inputValue()) === '0.6');
    await shot(page, '12-selection-v2-config');
    record('全流程期間沒有 5xx 或前端錯誤', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  } catch (e) {
    record('全流程腳本執行完畢（未中斷）', false, (e as Error).message.split('\n').slice(0, 4).join(' / '));
    try { await pageRef?.screenshot({ path: path.join(SHOTS, 'flow-FAILED.png'), fullPage: true }); console.log('失敗頁：', pageRef?.url()); } catch { /* ignore */ }
  } finally {
    if (browser) await browser.close();
    if (server?.pid) { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* 已結束 */ } }
  }
  const failed = checks.filter((c) => !c.ok).length;
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, total: checks.length, passed: checks.length - failed, failed, checks }, null, 2));
  console.log(`\n全流程：${checks.length - failed}/${checks.length} 通過`);
  process.exit(failed ? 1 : 0);
}
main();
