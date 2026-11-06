import type { Queryable, Tx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { notFound } from '../lib/errors';
import { collaborationScope } from '../lib/scope';
import {
  type ApplicationStatus, type CollabShipmentStatus, type CollaborationStatus, type EventDimension, type ShipmentFact,
} from '../lib/collaboration-rules';

/** 合作申請各模組（主流程、指派、保留與清除）共用的小工具；不含任何對外端點 */
export interface AppRow {
  id: string; organization_id: string; vendor_id: string; host_id: string; product_id: string | null;
  source: string; applied_on: string; owner_user_id: string | null; status: ApplicationStatus;
  collaboration_status: CollaborationStatus; campaign_id: string | null; trial_id: string | null;
  status_reason: string | null; hold_reason: string | null; note: string | null; internal_note: string | null;
  decided_at: string | null; version: number; deleted_at: string | null;
  [k: string]: unknown;
}

/** 依資料範圍載入申請；範圍外一律 404（不洩漏存在性） */
export async function loadApp(db: Queryable, actor: Actor, id: string, forUpdate = false): Promise<AppRow> {
  const sc = collaborationScope(actor, 2, 'a');
  if (sc.sql === 'FALSE') throw notFound('合作申請');
  const r = await db.query<AppRow>(
    `SELECT a.* FROM collaboration_applications a WHERE a.id=$1 AND (${sc.sql})${forUpdate ? ' FOR UPDATE' : ''}`,
    [id, ...sc.params]);
  if (!r.rowCount) throw notFound('合作申請');
  return r.rows[0];
}

/** timestamptz 欄位轉成 YYYY-MM-DD；pg 回傳 Date 物件，直接 String() 並不是 ISO 格式 */
export function isoDateOf(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export async function logEvent(tx: Tx, actor: Actor, appId: string, dimension: EventDimension, eventType: string,
  opts: { from?: string | null; to?: string | null; note?: string | null; internal?: boolean } = {}): Promise<void> {
  await tx.query(
    `INSERT INTO collaboration_events (organization_id, application_id, dimension, event_type, from_status, to_status, note, is_internal, actor_user_id, actor_role)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [actor.orgId, appId, dimension, eventType, opts.from ?? null, opts.to ?? null, opts.note ?? null, opts.internal ?? false, actor.userId, actor.role]);
}

export async function shipmentFacts(db: Queryable, appId: string): Promise<ShipmentFact[]> {
  const r = await db.query<{ shipment_type: 'INITIAL' | 'RESEND'; status: CollabShipmentStatus; ship_date: string | null }>(
    `SELECT shipment_type, status, ship_date FROM collaboration_shipments WHERE application_id=$1`, [appId]);
  return r.rows.map((x) => ({ shipmentType: x.shipment_type, status: x.status, shipDate: x.ship_date }));
}
