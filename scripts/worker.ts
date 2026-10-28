import { closePool, query } from '../src/server/lib/db';
import { automationEnabled } from '../src/server/lib/config';
import { runAllDue } from '../src/server/modules/automation';
import { loadEnv } from './load-env';

/**
 * 排程 Worker。安全預設：
 *  1) 環境變數 AUTOMATION_ENABLED 必須為 on，否則直接結束（不做任何事）
 *  2) 每個自動化工作還要在資料庫（automation_settings）被明確啟用才會執行
 *  3) 通知只走測試 Adapter，不會對真人發送（見 src/server/modules/notifications.ts）
 * 用法：npm run worker:once（執行一輪）／npm run worker（每 60 秒一輪，Ctrl+C 結束）
 */
async function cycle(): Promise<void> {
  const orgs = await query<{ id: string }>('SELECT id FROM organizations ORDER BY id');
  for (const o of orgs) {
    const res = await runAllDue(o.id, { trigger: 'SCHEDULED' });
    for (const r of res) console.info(`[${o.id}] ${r.jobKey}: ${r.status}${r.reason ? ` (${r.reason})` : ''}${r.error ? ` ERROR=${r.error}` : ''}${r.stats ? ` ${JSON.stringify(r.stats)}` : ''}`);
  }
}

async function main() {
  loadEnv();
  if (!automationEnabled()) {
    console.info('AUTOMATION_ENABLED 不是 on：Worker 不執行任何自動化。要啟用請設定 AUTOMATION_ENABLED=on，並在「自動化」頁面逐一啟用工作。');
    return;
  }
  const once = process.argv.includes('--once');
  let stop = false;
  process.on('SIGINT', () => { stop = true; });
  process.on('SIGTERM', () => { stop = true; });
  do {
    try { await cycle(); } catch (e) { console.error('[worker] cycle failed', (e as Error).message); }
    if (once) break;
    for (let i = 0; i < 60 && !stop; i++) await new Promise((r) => setTimeout(r, 1000));
  } while (!stop);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(closePool);
