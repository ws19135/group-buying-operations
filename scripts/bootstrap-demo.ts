import { execFileSync } from 'node:child_process';
import { loadEnv } from './load-env';

/**
 * 示範環境啟動前置：建 schema → 基礎資料（組織、流程模板、管理者）→ DEMO 虛構資料。
 * 全部冪等：已存在就略過，可在每次啟動前執行。
 * 只給「公開示範環境」用，需要 ALLOW_DEMO_IN_PRODUCTION=yes；真實環境請勿使用。
 */
loadEnv();
if (process.env.ALLOW_DEMO_IN_PRODUCTION !== 'yes') {
  console.error('bootstrap:demo 只用於示範環境，請設定 ALLOW_DEMO_IN_PRODUCTION=yes 確認這是放虛構資料的環境。');
  process.exit(1);
}
for (const f of ['scripts/seed.ts', 'scripts/seed-demo.ts', 'scripts/seed-demo-fulfillment.ts', 'scripts/seed-demo-aftersales.ts', 'scripts/seed-demo-finance.ts', 'scripts/seed-demo-segments.ts', 'scripts/seed-demo-selection.ts', 'scripts/seed-demo-catalog.ts']) {
  console.info(`> tsx ${f}`);
  execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', f], { stdio: 'inherit', env: process.env });
}
