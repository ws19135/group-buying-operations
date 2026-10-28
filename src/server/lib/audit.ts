import type { Queryable } from './db';
import type { Actor } from './permissions';

const REDACT = new Set(['password_hash', 'token_hash']);
const META = new Set(['updated_at', 'version', 'updated_by', 'created_at', 'created_by']);

export function redact<T extends Record<string, unknown> | null | undefined>(row: T): T {
  if (!row) return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = REDACT.has(k) ? '[REDACTED]' : v;
  return out as T;
}

/** 只留下有變動的欄位（前後值） */
export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    if (META.has(k)) continue;
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) {
      b[k] = REDACT.has(k) ? '[REDACTED]' : (before[k] ?? null);
      a[k] = REDACT.has(k) ? '[REDACTED]' : (after[k] ?? null);
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}

export interface AuditInput {
  action: string;
  entityType: string;
  entityId: string;
  campaignId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
}

export async function audit(db: Queryable, actor: Actor, a: AuditInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (organization_id, actor_user_id, actor_role, actor_type, action, entity_type, entity_id,
       campaign_id, before_data, after_data, reason, request_id, source, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      actor.orgId, actor.userId, actor.role, actor.type, a.action, a.entityType, a.entityId,
      a.campaignId ?? null,
      a.before ? JSON.stringify(redact(a.before)) : null,
      a.after ? JSON.stringify(redact(a.after)) : null,
      a.reason ?? null, actor.requestId, actor.source, actor.ip ?? null,
    ],
  );
}

export async function emitEvent(
  db: Queryable,
  actor: Actor,
  type: string,
  entityType: string,
  entityId: string,
  payload: Record<string, unknown> = {},
  dedupeKey?: string,
): Promise<void> {
  await db.query(
    `INSERT INTO events (organization_id, type, entity_type, entity_id, payload, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [actor.orgId, type, entityType, entityId, JSON.stringify(payload), dedupeKey ?? null],
  );
}
