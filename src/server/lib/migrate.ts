import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pool } from './db';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

function migrationsDir(): string {
  return path.resolve(process.cwd(), 'migrations');
}

/** 依檔名順序套用 migrations/*.sql；已套用的以 checksum 驗證不可被改動 */
export async function migrate(): Promise<MigrationResult> {
  const p = pool();
  await p.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = fs.readdirSync(migrationsDir()).filter((f) => f.endsWith('.sql')).sort();
  const done = new Map<string, string>();
  for (const r of (await p.query('SELECT name, checksum FROM schema_migrations')).rows) done.set(r.name, r.checksum);

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir(), f), 'utf8');
    const sum = crypto.createHash('sha256').update(sql).digest('hex');
    const prev = done.get(f);
    if (prev) {
      if (prev !== sum) throw new Error(`Migration ${f} 已套用過，但內容被修改（checksum 不符）。請新增新的 migration，不要改舊檔。`);
      skipped.push(f);
      continue;
    }
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [f, sum]);
      await client.query('COMMIT');
      applied.push(f);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${f} 失敗：${(e as Error).message}`);
    } finally {
      client.release();
    }
  }
  return { applied, skipped };
}

/** 測試／本機用：清空 public schema 後重新套用（拒絕在 production 執行） */
export async function resetDatabase(): Promise<void> {
  if ((process.env.APP_ENV ?? '') === 'production') throw new Error('拒絕在 production 重設資料庫');
  await pool().query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
}
