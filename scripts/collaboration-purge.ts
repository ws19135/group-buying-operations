import { closePool, query } from '../src/server/lib/db';
import { systemActor } from '../src/server/lib/permissions';
import { runRecipientPurge } from '../src/server/modules/collaboration-retention';
import { loadEnv } from './load-env';

/**
 * 合作申請收件個資清除（手動／隔離環境用；D-40）。
 *
 * 預設是「試跑」：只列出會清除、延後、被保留例外擋下的項目，不改任何資料。要真的清除請加 --execute。
 * 這支腳本不是排程：本系統沒有任何 cron 或 worker 會自動呼叫它。
 *
 * 安全閘門：
 *  - APP_ENV=production 時一律拒絕，除非同時設定 COLLABORATION_PURGE_PRODUCTION_AUTHORIZED=yes。
 *    這個變數只在 Owner 以書面授權「正式環境清除」之後才可設定；開發與驗證環境不需要也不應該設定。
 *  - 還原備份之後必須先在隔離環境跑這支腳本（見 docs/phase2/SECURITY_REVIEW.md「備份中的個資」），
 *    再把資料庫交付使用，否則已過期的個資會隨備份「復活」。
 * 用法：npm run collab:purge            （試跑）
 *       npm run collab:purge -- --execute
 */
async function main() {
  loadEnv();
  const env = process.env.APP_ENV ?? 'development';
  if (env === 'production' && process.env.COLLABORATION_PURGE_PRODUCTION_AUTHORIZED !== 'yes') {
    console.error('拒絕執行：APP_ENV=production。正式環境的個資清除需要 Owner 另行書面授權（COLLABORATION_PURGE_PRODUCTION_AUTHORIZED=yes）。');
    process.exitCode = 2;
    return;
  }
  const execute = process.argv.includes('--execute');
  const orgs = await query<{ id: string }>('SELECT id FROM organizations ORDER BY id');
  let failed = 0;
  for (const o of orgs) {
    const r = await runRecipientPurge(systemActor(o.id, 'WORKER', 'collaboration-purge-script'), { dryRun: !execute, source: 'SCRIPT' });
    console.info(`[${o.id}] ${execute ? '清除' : '試跑'} run=${r.runId} 結果=${r.status} 候選=${r.candidates} 已清除=${r.purged} 例外保留=${r.skippedHold} 履約延後=${r.skippedFulfilment} 上限強制=${r.forcedByCap} 失敗=${r.failed} 匯入暫存清理=${r.stagingScrubbed}`);
    failed += r.failed;
  }
  if (failed) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(closePool);
