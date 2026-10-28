import fs from 'node:fs';
import path from 'node:path';
import { closePool, query } from '../src/server/lib/db';
import { migrate } from '../src/server/lib/migrate';
import { routes } from '../src/server/api/routes';
import { loadEnv } from './load-env';

/** 從實際資料庫與路由表產生資料字典、ERD、API 清單，確保文件與程式一致。 */
async function main() {
  loadEnv();
  await migrate();
  const out = path.resolve('docs/generated');
  fs.mkdirSync(out, { recursive: true });
  const cols = await query<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null; ordinal_position: number }>(
    `SELECT table_name, column_name, data_type, is_nullable, column_default, ordinal_position FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position`);
  const fks = await query<{ t: string; c: string; ft: string; fc: string }>(
    `SELECT tc.table_name AS t, kcu.column_name AS c, ccu.table_name AS ft, ccu.column_name AS fc
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.table_schema=tc.table_schema
     WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public' ORDER BY 1,2`);
  const idx = await query<{ tablename: string; indexname: string; indexdef: string }>(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename, indexname`);
  const tables = [...new Set(cols.map((c) => c.table_name))].filter((t) => t !== 'schema_migrations');

  let dd = '# 資料字典（由資料庫實際結構產生）\n\n> 由 `npm run docs:gen` 自動產生，請勿手動編輯。欄位的業務定義見 [DASHBOARD_SPEC.md](../DASHBOARD_SPEC.md) 與 [ARCHITECTURE.md](../ARCHITECTURE.md)。\n\n';
  for (const t of tables) {
    dd += `## \`${t}\`\n\n| 欄位 | 型別 | 可空 | 預設 | 參照 |\n|---|---|:-:|---|---|\n`;
    for (const c of cols.filter((x) => x.table_name === t)) {
      const fk = fks.find((f) => f.t === t && f.c === c.column_name);
      dd += `| ${c.column_name} | ${c.data_type} | ${c.is_nullable === 'YES' ? '是' : '否'} | ${c.column_default ? '`' + c.column_default.replace(/\|/g, '\\|') + '`' : ''} | ${fk ? `${fk.ft}.${fk.fc}` : ''} |\n`;
    }
    const ti = idx.filter((i) => i.tablename === t);
    if (ti.length) dd += `\n索引：${ti.map((i) => `\`${i.indexname}\`${/UNIQUE/.test(i.indexdef) ? '（唯一）' : ''}`).join('、')}\n`;
    dd += '\n';
  }
  fs.writeFileSync(path.join(out, 'DATA_DICTIONARY.md'), dd);

  let erd = '# ERD（由外鍵關係自動產生）\n\n> 由 `npm run docs:gen` 產生。只畫外鍵關係；欄位請見 [DATA_DICTIONARY.md](DATA_DICTIONARY.md)。\n\n```mermaid\nerDiagram\n';
  const seen = new Set<string>();
  for (const f of fks) {
    if (f.ft === 'organizations' || f.c === 'created_by' || f.c === 'updated_by') continue;
    const k = `${f.ft}-${f.t}-${f.c}`;
    if (seen.has(k)) continue;
    seen.add(k);
    erd += `    ${f.ft} ||--o{ ${f.t} : "${f.c}"\n`;
  }
  erd += '```\n\n所有業務表另帶 `organization_id → organizations`（多租戶隔離，未畫出以保持圖面清楚）。\n';
  fs.writeFileSync(path.join(out, 'ERD.md'), erd);

  let api = '# API 端點清單（由路由表產生）\n\n> 由 `npm run docs:gen` 產生。請求/回應格式、錯誤碼與驗證方式見 [API.md](../API.md)。\n\n| 方法 | 路徑 | 需登入 |\n|---|---|:-:|\n';
  for (const r of routes) api += `| ${r.method} | \`/api${r.path}\` | ${r.public ? '否（公開）' : '是'} |\n`;
  fs.writeFileSync(path.join(out, 'API_ENDPOINTS.md'), api);
  console.info(`已產生：${tables.length} 張表、${fks.length} 個外鍵、${routes.length} 個端點`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(closePool);
