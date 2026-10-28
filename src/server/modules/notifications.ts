import type { Queryable } from '../lib/db';
import { pool, query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { requirePerm } from '../lib/permissions';
import { ids } from '../lib/ids';
import { camelize } from '../lib/case';
import { notFound } from '../lib/errors';

export type Channel = 'IN_APP' | 'EMAIL' | 'LINE';

export interface NotifyInput {
  channel?: Channel;
  recipientUserId: string | null;
  subject: string;
  body: string;
  entityType?: string;
  entityId?: string;
  dedupeKey?: string;
}

/** 排入通知佇列。同一個 dedupeKey 只會建立一次（冪等）。回傳是否為新建立 */
export async function queueNotification(db: Queryable, orgId: string, n: NotifyInput): Promise<boolean> {
  const id = await ids.notification(db);
  const r = await db.query(
    `INSERT INTO notifications (id, organization_id, channel, recipient_user_id, subject, body, entity_type, entity_id, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
    [id, orgId, n.channel ?? 'IN_APP', n.recipientUserId, n.subject, n.body, n.entityType ?? null, n.entityId ?? null, n.dedupeKey ?? null]);
  return !!r.rowCount;
}

export interface OutboundMessage { channel: Channel; to: string; subject: string; body: string }
export interface NotifyAdapter { name: string; send(m: OutboundMessage): Promise<void> }

/** 測試 Adapter：不對任何真人發送，只記錄 */
export class TestAdapter implements NotifyAdapter {
  name = 'test';
  sent: OutboundMessage[] = [];
  async send(m: OutboundMessage): Promise<void> { this.sent.push(m); }
}

export class FailingAdapter implements NotifyAdapter {
  name = 'failing';
  async send(): Promise<void> { throw new Error('外部通知服務無法連線（模擬）'); }
}

export function getAdapter(): NotifyAdapter {
  const name = (process.env.NOTIFY_ADAPTER ?? 'test').toLowerCase();
  if (name === 'test') return new TestAdapter();
  throw new Error(`BLOCKED：通知 Adapter「${name}」尚未實作（需要真實 LINE／Email 憑證與 Owner 授權）；目前僅支援 test`);
}

const MAX_ATTEMPTS = 3;

/**
 * 派送佇列。IN_APP 直接標記為已送達（站內通知）；EMAIL／LINE 交給 Adapter。
 * Adapter 失敗不影響主流程：通知標為 FAILED 並重試，超過上限標為 DEAD 並建立例外供人工處理。
 */
export async function dispatchNotifications(orgId: string, adapter: NotifyAdapter, limit = 100): Promise<{ delivered: number; sentTest: number; failed: number; dead: number }> {
  const rows = await query(
    `SELECT n.*, u.email AS recipient_email FROM notifications n LEFT JOIN users u ON u.id=n.recipient_user_id
     WHERE n.organization_id=$1 AND n.status IN ('QUEUED','FAILED') AND n.attempts < $2 ORDER BY n.created_at LIMIT $3`, [orgId, MAX_ATTEMPTS, limit]);
  const out = { delivered: 0, sentTest: 0, failed: 0, dead: 0 };
  for (const n of rows) {
    if (n.channel === 'IN_APP') {
      await query(`UPDATE notifications SET status='DELIVERED', sent_at=now(), attempts=attempts+1 WHERE id=$1`, [n.id]);
      out.delivered++;
      continue;
    }
    try {
      await adapter.send({ channel: n.channel, to: n.recipient_email ?? '', subject: n.subject, body: n.body });
      await query(`UPDATE notifications SET status=$2, sent_at=now(), attempts=attempts+1, last_error=NULL WHERE id=$1`, [n.id, adapter.name === 'test' ? 'SENT_TEST' : 'DELIVERED']);
      out.sentTest++;
    } catch (e) {
      const attempts = n.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await query(`UPDATE notifications SET status=$2, attempts=$3, last_error=$4 WHERE id=$1`, [n.id, dead ? 'DEAD' : 'FAILED', attempts, String((e as Error).message).slice(0, 300)]);
      if (dead) {
        out.dead++;
        await query(
          `INSERT INTO exceptions (id, organization_id, type, severity, entity_type, entity_id, title, detail, dedupe_key)
           VALUES ($1,$2,'NOTIFICATION_DEAD','MEDIUM','notification',$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [await ids.exception(pool()), orgId, n.id, '通知多次發送失敗', `${n.subject}：${(e as Error).message}`, `notification_dead:${n.id}`]);
      } else out.failed++;
    }
  }
  return out;
}

export async function listMyNotifications(actor: Actor, q: URLSearchParams) {
  const unreadOnly = q.get('unread') === '1';
  const rows = await query(
    `SELECT id, channel, subject, body, entity_type, entity_id, status, created_at, read_at FROM notifications
     WHERE organization_id=$1 AND recipient_user_id=$2 AND channel='IN_APP' AND status IN ('DELIVERED','READ') ${unreadOnly ? 'AND read_at IS NULL' : ''}
     ORDER BY created_at DESC LIMIT 100`, [actor.orgId, actor.userId]);
  const unread = await query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE organization_id=$1 AND recipient_user_id=$2 AND channel='IN_APP' AND status='DELIVERED' AND read_at IS NULL`, [actor.orgId, actor.userId]);
  return { items: camelize(rows), unread: unread[0].n };
}

export async function markNotificationRead(actor: Actor, id: string) {
  return withTx(async (tx) => {
    const r = await tx.query(`UPDATE notifications SET read_at=now(), status='READ' WHERE id=$1 AND organization_id=$2 AND recipient_user_id=$3 AND read_at IS NULL RETURNING id`, [id, actor.orgId, actor.userId]);
    if (!r.rowCount) throw notFound('通知');
    return { id };
  });
}

export async function listAllNotifications(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'automation.manage');
  const status = q.get('status');
  const rows = await query(
    `SELECT id, channel, recipient_user_id, subject, status, attempts, last_error, created_at, sent_at FROM notifications
     WHERE organization_id=$1 ${status ? 'AND status=$2' : ''} ORDER BY created_at DESC LIMIT 200`, status ? [actor.orgId, status] : [actor.orgId]);
  return camelize(rows);
}
