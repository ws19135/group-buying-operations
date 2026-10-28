import { migrate } from '../src/server/lib/migrate';
import { closePool } from '../src/server/lib/db';
import { loadEnv } from './load-env';

async function main() {
  loadEnv();
  const r = await migrate();
  console.log(`已套用：${r.applied.join(', ') || '(無新增)'}`);
  console.log(`已略過：${r.skipped.length} 個既有 migration`);
  await closePool();
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
