import type { Tx } from './db';
import { query } from './db';
import type { Actor } from './permissions';
import { audit, changedFields } from './audit';
import { conflict, notFound } from './errors';
import { toSnake } from './case';

export interface Page { limit: number; offset: number }

export function pageParams(q: URLSearchParams | Record<string, string | undefined>): Page {
  const get = (k: string) => (q instanceof URLSearchParams ? q.get(k) : q[k]) ?? undefined;
  const finite = (v: string | undefined, dflt: number) => { const n = Number(v ?? dflt); return Number.isFinite(n) && n !== 0 ? n : dflt; };
  const limit = Math.min(Math.max(Math.trunc(finite(get('limit'), 50)), 1), 200);
  // page 上限避免 OFFSET 變成 Infinity／超出 bigint 而讓資料庫報錯（回 500）
  const page = Math.min(Math.max(Math.trunc(finite(get('page'), 1)), 1), 1_000_000);
  return { limit, offset: (page - 1) * limit };
}

export interface ListResult<T> { items: T[]; total: number; limit: number; offset: number }

export async function listPaged<T>(sqlBase: string, params: unknown[], orderBy: string, page: Page): Promise<ListResult<T>> {
  const total = await query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sqlBase}) x`, params);
  const items = await query(`${sqlBase} ORDER BY ${orderBy} LIMIT ${page.limit} OFFSET ${page.offset}`, params);
  return { items: items as unknown as T[], total: Number(total[0].n), limit: page.limit, offset: page.offset };
}

export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export interface PatchSpec {
  table: string;
  entityType: string;
  id: string;
  /** API 欄位（camelCase）→ 值；只會寫入 allowed 內的欄位 */
  patch: Record<string, unknown>;
  allowed: readonly string[];
  expectedVersion?: number;
  action?: string;
  campaignId?: (row: Record<string, unknown>) => string | null;
  reason?: string | null;
  /** 欄位值需要同步更新的衍生欄位，例如 normalized_name */
  derived?: (merged: Record<string, unknown>) => Record<string, unknown>;
}

/** 通用更新：鎖列、樂觀鎖版本檢查、只更新有變動的欄位、寫稽核（前後值） */
export async function patchEntity(tx: Tx, actor: Actor, spec: PatchSpec): Promise<{ before: Record<string, unknown>; after: Record<string, unknown>; changed: boolean }> {
  const cur = await tx.query(`SELECT * FROM ${spec.table} WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [spec.id, actor.orgId]);
  if (!cur.rowCount) throw notFound();
  const before = cur.rows[0] as Record<string, unknown>;
  if (before['deleted_at']) throw notFound();
  if (spec.expectedVersion != null && before['version'] !== spec.expectedVersion) {
    throw conflict('資料已被其他人更新，請重新整理後再試', { currentVersion: before['version'] });
  }
  const sets: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec.patch)) {
    if (v === undefined) continue;
    if (!spec.allowed.includes(k)) continue;
    sets[toSnake(k)] = v;
  }
  if (spec.derived) Object.assign(sets, spec.derived({ ...before, ...sets }));
  const effective: Record<string, unknown> = {};
  for (const [c, v] of Object.entries(sets)) if (JSON.stringify(before[c] ?? null) !== JSON.stringify(v ?? null)) effective[c] = v;
  if (!Object.keys(effective).length) return { before, after: before, changed: false };

  const cols = Object.keys(effective);
  const hasUpdatedBy = 'updated_by' in before;
  const setSql = cols.map((c, i) => `${c}=$${i + 3}`).join(', ') + (hasUpdatedBy ? `, updated_by=$${cols.length + 3}` : '');
  const values = [spec.id, actor.orgId, ...cols.map((c) => effective[c]), ...(hasUpdatedBy ? [actor.userId] : [])];
  const upd = await tx.query(`UPDATE ${spec.table} SET ${setSql} WHERE id=$1 AND organization_id=$2 RETURNING *`, values);
  const after = upd.rows[0] as Record<string, unknown>;
  const diff = changedFields(before, after);
  await audit(tx, actor, {
    action: spec.action ?? `${spec.entityType}.update`,
    entityType: spec.entityType,
    entityId: spec.id,
    campaignId: spec.campaignId ? spec.campaignId(after) : null,
    before: diff?.before ?? null,
    after: diff?.after ?? null,
    reason: spec.reason ?? null,
  });
  return { before, after, changed: true };
}

/**
 * 更新時「送空字串＝清空欄位」。各 schema 為了建立時的便利把空字串轉成 undefined（略過），
 * 更新時用這個把原始請求中為 '' 的可清空欄位改成 null 後再寫入。必填欄位不在 keys 內，空字串仍會被驗證擋下。
 */
export function applyClears<T extends Record<string, unknown>>(input: T, raw: unknown, keys: readonly string[]): T {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...input };
  for (const k of keys) if (r[k] === '') out[k] = null;
  return out as T;
}
