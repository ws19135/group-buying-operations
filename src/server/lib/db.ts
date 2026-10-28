import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';
import { databaseUrl } from './config';

// 型別解析：date 以 'YYYY-MM-DD' 字串回傳（避免時區位移）；bigint / numeric 轉成 number
types.setTypeParser(1082, (v) => v);
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

const g = globalThis as unknown as { __erpPool?: Pool };

export function pool(): Pool {
  if (!g.__erpPool) {
    g.__erpPool = new Pool({ connectionString: databaseUrl(), max: 10, idleTimeoutMillis: 10_000 });
    g.__erpPool.on('error', (e) => console.error('[db] idle client error', e.message));
  }
  return g.__erpPool;
}

export async function closePool(): Promise<void> {
  if (g.__erpPool) {
    await g.__erpPool.end();
    g.__erpPool = undefined;
  }
}

/** 查詢介面：Pool 與 PoolClient 皆可 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export async function query<R extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<R[]> {
  const r = await pool().query<R>(text, params);
  return r.rows;
}

/** 交易：callback 成功 commit，丟例外 rollback */
export async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw e;
  } finally {
    client.release();
  }
}

export type Tx = PoolClient;
