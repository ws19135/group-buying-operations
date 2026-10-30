/**
 * 唯讀快照站產生器：把「正在跑的示範站」逐角色爬一遍，存成純靜態 HTML（可放 GitHub Pages）。
 *
 *   BASE_URL=http://127.0.0.1:3100 SNAPSHOT_PASSWORD=<DEMO_PASSWORD> npm run snapshot
 *
 * 只用 DEMO 帳號與虛構資料。輸出到 site/（預設）：每個角色一套頁面，頁內連結改寫成快照內的連結，
 * 移除所有 script（所以沒有任何寫入功能），並在頂端加上「唯讀快照」橫幅。
 * 環境變數：SNAPSHOT_BASE（發布路徑前綴，預設 /）、SNAPSHOT_OUT（輸出資料夾）、SNAPSHOT_MAX_PAGES（每個角色頁數上限，預設 400）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';

const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:3100').replace(/\/$/, '');
const PASSWORD = process.env.SNAPSHOT_PASSWORD ?? process.env.DEMO_PASSWORD ?? '';
const PUBLISH_BASE = (process.env.SNAPSHOT_BASE ?? '/').replace(/\/?$/, '/');
const OUT = path.resolve(process.env.SNAPSHOT_OUT ?? 'site');
const MAX_PAGES = Number(process.env.SNAPSHOT_MAX_PAGES ?? 400);

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
      // 下拉選單的選項（data-nav）也算連結：快照站沒有 script，改用下面那一小段導覽程式換頁
      const links: string[] = await page.evaluate(() => [
        ...[...document.querySelectorAll('a[href]')].map((a) => (a as HTMLAnchorElement).href),
        ...[...document.querySelectorAll('select[data-nav-select] option[data-nav]')].map((o) => new URL((o as HTMLElement).dataset.nav as string, location.href).href),
      ]);
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
        document.querySelectorAll('select[data-nav-select] option').forEach((o) => {
          const opt = o as HTMLOptionElement;
          if (opt.selected) opt.setAttribute('selected', ''); else opt.removeAttribute('selected');
          if (opt.dataset.nav) opt.setAttribute('data-snap', `@@SNAP:${encodeURIComponent(new URL(opt.dataset.nav, location.href).href)}@@`);
        });
        return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
      });
      const title = await page.title();
      saved.set(key, { html, title });
      fileOf.set(key, fileFor(role.key, u));
      if (finalUrl.pathname !== u.pathname) fileOf.set(canonical(finalUrl), fileFor(role.key, u));
    }

    const banner = `<div id="snap-banner" style="position:sticky;top:0;z-index:9999;background:#fff3cd;color:#664d03;border-bottom:1px solid #e6c866;padding:8px 14px;font:14px/1.5 sans-serif">` +
      `📸 <b>唯讀快照</b>｜視角：<b>${role.label}</b>｜資料皆為虛構 DEMO｜按鈕與表單在快照中不會動作｜` +
      `<a href="${PUBLISH_BASE}index.html" style="color:#664d03">換角色／回首頁</a></div>` +
      // 內嵌在「單頁檢視」時，橫幅由外層提供，這裡隱藏（唯一保留的 script，只做這件事）
      `<script>if(window.top!==window.self){var b=document.getElementById('snap-banner');if(b)b.style.display='none'}</script>`;
    const freeze = '<style>form button,form input,form select,form textarea,button{pointer-events:none!important;opacity:.55}</style>';
    // 唯一例外：標了 data-nav-select 的篩選下拉只負責換頁（讀取不同網址的快照），不會寫入任何資料
    const nav = `<script>document.querySelectorAll('select[data-nav-select]').forEach(function(s){s.addEventListener('change',function(){var o=s.options[s.selectedIndex];if(o&&o.getAttribute('data-snap'))location.href=o.getAttribute('data-snap')})})</script>`;

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
        .replace(/<body([^>]*)>/, `<body$1>${banner}`)
        .replace('</body>', `${nav}</body>`);
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
  const roleData = ROLES.map((r) => ({ key: r.key, label: r.label, hint: r.hint, pages: summary[r.key], src: `${PUBLISH_BASE}${r.key}/index.html` }));
  const noscript = ROLES.map((r) => `<li><a href="${PUBLISH_BASE}${r.key}/index.html">${r.label}</a>：${r.hint}</li>`).join('');
  fs.writeFileSync(path.join(OUT, 'index.html'), `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>團購 ERP：各角色介面（唯讀示範）</title>
<style>
*{box-sizing:border-box}html,body{height:100%;margin:0}body{display:flex;flex-direction:column;font-family:system-ui,'PingFang TC','Noto Sans TC',sans-serif;background:#f6f3ec;color:#172a3a}
header{background:#172a3a;color:#f6f3ec;padding:10px 16px;display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center}
header h1{font-size:18px;margin:0;font-weight:700}header .tabs{display:flex;flex-wrap:wrap;gap:6px}
header button{font:inherit;font-size:15px;padding:7px 14px;border-radius:999px;border:1px solid #4a6073;background:transparent;color:#e3eaf0;cursor:pointer}
header button[aria-selected="true"]{background:#e9a15b;border-color:#e9a15b;color:#172a3a;font-weight:700}
header .grow{flex:1}header a{color:#e9a15b;font-size:14px;text-decoration:none}
.sub{background:#fff3cd;color:#664d03;border-bottom:1px solid #e6c866;padding:6px 16px;font-size:14px;line-height:1.5}
iframe{flex:1;width:100%;border:0;background:#fff}noscript{display:block;padding:24px}
</style></head><body>
<header><h1>🛒 團購 ERP：各角色介面</h1><div class="tabs" role="tablist" id="tabs"></div><span class="grow"></span><a id="open" href="#" target="_blank" rel="noopener">在新分頁開啟 ↗</a></header>
<div class="sub"><b id="hint"></b>&emsp;｜&emsp;<b>唯讀快照</b>：不需要登入；資料皆為虛構（[DEMO]）；按鈕與表單不會動作。快照產生時間：${generatedAt}</div>
<iframe id="view" title="角色介面"></iframe>
<noscript><p>需要啟用 JavaScript 才能在同一頁切換角色；也可以直接開啟各角色：</p><ul>${noscript}</ul></noscript>
<script>
var ROLES=${JSON.stringify(roleData)};
var tabs=document.getElementById('tabs'),view=document.getElementById('view'),hint=document.getElementById('hint'),open=document.getElementById('open');
function show(key){var r=ROLES.filter(function(x){return x.key===key})[0]||ROLES[0];
  view.src=r.src;open.href=r.src;hint.textContent=r.label+'視角（約 '+r.pages+' 頁）：'+r.hint;
  Array.prototype.forEach.call(tabs.children,function(b){b.setAttribute('aria-selected',String(b.dataset.key===r.key))});
  try{history.replaceState(null,'','#'+r.key)}catch(e){}}
ROLES.forEach(function(r){var b=document.createElement('button');b.type='button';b.textContent=r.label;b.dataset.key=r.key;b.setAttribute('role','tab');b.onclick=function(){show(r.key)};tabs.appendChild(b)});
show(location.hash.replace('#',''));
</script></body></html>`);
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  console.info(`完成：${Object.values(summary).reduce((a, b) => a + b, 0)} 頁、${assets.size} 個靜態資源 → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
