import crypto from 'node:crypto';
import type { Actor } from './permissions';
import { query, type Tx } from './db';
import { conflict, validation } from './errors';

/** 重複送出保護只需涵蓋「用戶端重試」的時間窗；超過這個天數的紀錄沒有保留價值 */
export const IDEMPOTENCY_RETENTION_DAYS = 30;

/**
 * 清除過期的 idempotency_keys（K6）。這是技術性的去重快取、不是業務資料，所以用實體刪除；
 * 只清本組織、且超過保留天數者。由每日自動化工作呼叫（預設停用、需手動啟用）。
 */
export async function purgeExpiredIdempotencyKeys(orgId: string, now: Date = new Date(), days: number = IDEMPOTENCY_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const r = await query(`DELETE FROM idempotency_keys WHERE organization_id=$1 AND created_at < $2 RETURNING key`, [orgId, cutoff]);
  return r.length;
}

/**
 * 重複送出保護。必須在與業務寫入「同一個交易」內呼叫。
 * 同一個 (org, scope, key) 的第二次請求會直接回傳第一次的結果（replayed = true）；
 * 但請求雜湊（含送出者與完整內容）不同時一律拒絕（422），呼叫端必須把網址上的父層 id 一併放進 payload。
 * 並發的兩個請求：第二個會在唯一索引上等待第一個 commit，之後取得已儲存的結果。
 */
export async function idempotent<T>(
  tx: Tx,
  actor: Actor,
  scope: string,
  key: string | null | undefined,
  fn: () => Promise<T>,
  payload?: unknown,
): Promise<{ result: T; replayed: boolean }> {
  if (!key) return { result: await fn(), replayed: false };
  // 雜湊綁定「誰送的」與「完整請求內容」：另一位使用者拿到同一把 key，或同一把 key 搭配不同的父層（網址上的 id），都不會回放別人的結果
  const hash = crypto.createHash('sha256').update(JSON.stringify([actor.userId ?? null, payload ?? null])).digest('hex');
  const ins = await tx.query(
    `INSERT INTO idempotency_keys (organization_id, scope, key, request_hash) VALUES ($1,$2,$3,$4)
     ON CONFLICT DO NOTHING RETURNING key`,
    [actor.orgId, scope, key, hash],
  );
  if (ins.rows.length === 0) {
    const prev = await tx.query<{ response: T | null; request_hash: string | null }>(
      'SELECT response, request_hash FROM idempotency_keys WHERE organization_id=$1 AND scope=$2 AND key=$3',
      [actor.orgId, scope, key],
    );
    if (prev.rows[0]?.request_hash && prev.rows[0].request_hash !== hash) throw validation('這個 Idempotency-Key 已用於內容不同的請求，請改用新的 key');
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
