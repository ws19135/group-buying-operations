/**
 * 唯讀快照站產生器：把「正在跑的示範站」逐角色爬一遍，存成純靜態 HTML（可放 GitHub Pages）。
 *
 *   BASE_URL=http://127.0.0.1:3100 SNAPSHOT_PASSWORD=<DEMO_PASSWORD> npm run snapshot
 *
 * 只用 DEMO 帳號與虛構資料。輸出到 site/（預設）：每個角色一套頁面，頁內連結改寫成快照內的連結，
 * 移除所有 script（所以沒有任何寫入功能），並在頂端加上「唯讀快照」橫幅。
 * 環境變數：SNAPSHOT_BASE（發布路徑前綴，預設 /）、SNAPSHOT_OUT（輸出資料夾）、SNAPSHOT_MAX_PAGES（每個角色頁數上限，預設 200）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';

const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:3100').replace(/\/$/, '');
const PASSWORD = process.env.SNAPSHOT_PASSWORD ?? process.env.DEMO_PASSWORD ?? '';
const PUBLISH_BASE = (process.env.SNAPSHOT_BASE ?? '/').replace(/\/?$/, '/');
const OUT = path.resolve(process.env.SNAPSHOT_OUT ?? 'site');
const MAX_PAGES = Number(process.env.SNAPSHOT_MAX_PAGES ?? 200);

const ROLES: { key: string; email: string; label: string; hint: string }[] = [
  { key: 'manager', email: 'demo-manager@example.invalid', label: '營運主管', hint: '看得最完整：總覽、檔期、核准、履約、售後、財務' },
  { key: 'editor', email: 'demo-editor@example.invalid', label: '營運小編', hint: '日常建檔與排檔期；看不到成本與稽核' },
  { key: 'finance', email: 'demo-finance@example.invalid', label: '財務', hint: '結算試算、入帳、費用、發票紀錄' },
  { key: 'host1', email: 'demo-host1@example.invalid', label: '團主', hint: '只看自己的檔期、任務與預估佣金' },
  { key: 'vendor', email: 'demo-vendor@example.invalid', label: '廠商', hint: '只看自己品牌的商品、檔期與任務' },
];

interface Saved { html: string; title: string }

/** 網址（含查詢字串）→ 快照內檔名 */
function fileFor(role: string, u: URL): string {
  // 根路徑不能叫 index（會與每個角色的入口頁 index.html 撞名，造成無限轉址）
  const p = decodeURIComponent(u.pathname).replace(/\/+$/, '') || '/_home';
  const q = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}-${v}`).join('_');
  let name = p.replace(/^\//, '') + (q ? `~${q}` : '');
  name = name.replace(/[^A-Za-z0-9_\-./~一-鿿]/g, '_');
  return `${role}/${name}.html`;
}

const canonical = (u: URL) => {
  const q = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  return u.pathname.replace(/\/+$/, '') + (q.length ? '?' + q.map(([k, v]) => `${k}=${v}`).join('&') : '');
};

// 月份切換會產生無限多個幾乎空白的頁面，不擷取
const skip = (u: URL) => u.origin !== BASE_URL || /^\/(api|login|logout|_next)(\/|$)/.test(u.pathname) || u.searchParams.has('month');

async function login(page: Page, email: string) {
  await page.goto(`${BASE_URL}/login`);
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 }), page.click('button[type="submit"]')]);
}

async function main() {
  if (!PASSWORD) throw new Error('需要 SNAPSHOT_PASSWORD（示範帳號密碼）');
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const assets = new Map<string, Buffer>();       // 路徑（/_next/static/...）→ 內容
  const summary: Record<string, number> = {};

  for (const role of ROLES) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    page.on('response', async (res) => {
      try {
        const u = new URL(res.url());
        if (u.origin === BASE_URL && u.pathname.startsWith('/_next/static/') && res.ok()) assets.set(u.pathname, await res.body());
      } catch { /* 靜態資源抓不到就略過 */ }
    });
    await login(page, role.email);
    const start = new URL(page.url());
    const saved = new Map<string, Saved>();        // canonical → 頁面
    const fileOf = new Map<string, string>();      // canonical → 檔名
    const queue: URL[] = [start];
    const seen = new Set<string>([canonical(start)]);
    const home = canonical(start);

    while (queue.length && saved.size < MAX_PAGES) {
      const u = queue.shift()!;
      try {
        await page.goto(u.toString(), { waitUntil: 'networkidle', timeout: 30000 });
      } catch { continue; }
      const finalUrl = new URL(page.url());
      if (finalUrl.pathname.startsWith('/login')) continue;
      const key = canonical(u);
      const links: string[] = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => (a as HTMLAnchorElement).href));
      for (const l of links) {
        try {
          const lu = new URL(l);
          lu.hash = '';
          if (skip(lu)) continue;
          const ck = canonical(lu);
          if (!seen.has(ck)) { seen.add(ck); queue.push(lu); }
        } catch { /* 無效連結 */ }
      }
      // 在瀏覽器內標記連結、移除 script，再取出 HTML
      const html = await page.evaluate(() => {
        document.querySelectorAll('script, link[rel="preload"], link[rel="modulepreload"], noscript').forEach((n) => n.remove());
        document.querySelectorAll('a[href]').forEach((a) => a.setAttribute('href', `@@SNAP:${encodeURIComponent((a as HTMLAnchorElement).href)}@@`));
        return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
      });
      const title = await page.title();
      saved.set(key, { html, title });
      fileOf.set(key, fileFor(role.key, u));
      if (finalUrl.pathname !== u.pathname) fileOf.set(canonical(finalUrl), fileFor(role.key, u));
    }

    const banner = `<div style="position:sticky;top:0;z-index:9999;background:#fff3cd;color:#664d03;border-bottom:1px solid #e6c866;padding:8px 14px;font:14px/1.5 sans-serif">` +
      `📸 <b>唯讀快照</b>｜視角：<b>${role.label}</b>｜資料皆為虛構 DEMO｜按鈕與表單在快照中不會動作｜` +
      `<a href="${PUBLISH_BASE}index.html" style="color:#664d03">換角色／回首頁</a></div>`;
    const freeze = '<style>form button,form input,form select,form textarea,button{pointer-events:none!important;opacity:.55}</style>';

    for (const [key, s] of saved) {
      const html = s.html
        .replace(/(href|src)="\/_next\//g, `$1="${PUBLISH_BASE}assets/_next/`)
        .replace(/@@SNAP:([^@]*)@@/g, (_m, enc: string) => {
          const lu = new URL(decodeURIComponent(enc));
          if (lu.origin !== BASE_URL) return lu.toString();
          lu.hash = '';
          const f = fileOf.get(canonical(lu));
          return f ? `${PUBLISH_BASE}${f}` : '#snapshot-not-captured';
        })
        .replace('</head>', `${freeze}</head>`)
        .replace(/<body([^>]*)>/, `<body$1>${banner}`);
      const f = fileOf.get(key)!;
      const dest = path.join(OUT, f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, html);
    }
    // 各角色入口
    const homeFile = fileOf.get(home)!;
    fs.writeFileSync(path.join(OUT, role.key, 'index.html'),
      `<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${PUBLISH_BASE}${homeFile}"><a href="${PUBLISH_BASE}${homeFile}">進入${role.label}視角</a>`);
    summary[role.key] = saved.size;
    console.info(`✔ ${role.label}：${saved.size} 頁${queue.length ? `（上限 ${MAX_PAGES}，尚有 ${queue.length} 個連結未擷取）` : ''}`);
    await ctx.close();
  }
  await browser.close();

  for (const [p, buf] of assets) {
    const dest = path.join(OUT, 'assets', p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  }
  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const cards = ROLES.map((r) => `<a class="card" href="${PUBLISH_BASE}${r.key}/index.html"><h2>${r.label}</h2><p>${r.hint}</p><small>${summary[r.key]} 頁</small></a>`).join('');
  fs.writeFileSync(path.join(OUT, 'index.html'), `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>團購 ERP 唯讀示範快照</title>
<style>body{font-family:system-ui,'PingFang TC','Noto Sans TC',sans-serif;background:#f6f3ec;color:#172a3a;margin:0;padding:48px 24px}main{max-width:860px;margin:0 auto}h1{font-size:30px;margin:0 0 8px}p.lead{color:#3c4a57;line-height:1.7}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin:28px 0}.card{display:block;background:#fff;border:1px solid #ddd8cc;border-radius:14px;padding:20px;text-decoration:none;color:inherit}.card:hover{border-color:#1f7a72}.card h2{margin:0 0 6px;font-size:20px;color:#1f7a72}.card p{margin:0 0 10px;color:#3c4a57;font-size:15px;line-height:1.6}.card small{color:#6a7179}
.note{background:#fff3cd;border:1px solid #e6c866;border-radius:10px;padding:14px 16px;color:#664d03;line-height:1.7;font-size:15px}</style></head><body><main>
<h1>團購 ERP：唯讀示範快照</h1>
<p class="lead">選一個角色，看他登入後實際會看到的畫面。每個角色看到的範圍不同（例如團主與廠商看不到成本與他人資料）。</p>
<div class="grid">${cards}</div>
<div class="note"><b>請注意：</b>這是從示範環境擷取的<b>唯讀快照</b>，不是可操作的系統。所有資料皆為虛構（名稱帶 [DEMO]）；按鈕、表單與登入在這裡都不會動作。<br>快照產生時間：${generatedAt}</div>
</main></body></html>`);
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  console.info(`完成：${Object.values(summary).reduce((a, b) => a + b, 0)} 頁、${assets.size} 個靜態資源 → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
