import { resetDatabase } from '../src/server/lib/migrate';
import { closePool } from '../src/server/lib/db';
import { loadEnv } from './load-env';

loadEnv();
resetDatabase()
  .then(() => console.log('資料庫已重設並重新套用所有 migration。'))
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(closePool);
