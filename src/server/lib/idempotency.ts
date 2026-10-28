import type { Tx } from './db';
import type { Actor } from './permissions';
import { conflict } from './errors';

/**
 * 重複送出保護。必須在與業務寫入「同一個交易」內呼叫。
 * 同一個 (org, scope, key) 的第二次請求會直接回傳第一次的結果（replayed = true）。
 * 並發的兩個請求：第二個會在唯一索引上等待第一個 commit，之後取得已儲存的結果。
 */
export async function idempotent<T>(
  tx: Tx,
  actor: Actor,
  scope: string,
  key: string | null | undefined,
  fn: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  if (!key) return { result: await fn(), replayed: false };
  const ins = await tx.query(
    `INSERT INTO idempotency_keys (organization_id, scope, key) VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING RETURNING key`,
    [actor.orgId, scope, key],
  );
  if (ins.rows.length === 0) {
    const prev = await tx.query<{ response: T | null }>(
      'SELECT response FROM idempotency_keys WHERE organization_id=$1 AND scope=$2 AND key=$3',
      [actor.orgId, scope, key],
    );
    const stored = prev.rows[0]?.response;
    if (stored == null) throw conflict('相同的請求仍在處理中，請稍後再試');
    return { result: stored, replayed: true };
  }
  const result = await fn();
  await tx.query('UPDATE idempotency_keys SET response=$4 WHERE organization_id=$1 AND scope=$2 AND key=$3', [
    actor.orgId, scope, key, JSON.stringify(result),
  ]);
  return { result, replayed: false };
}
