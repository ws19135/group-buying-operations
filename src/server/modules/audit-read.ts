import { query } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { isInternal, requirePerm } from '../lib/permissions';
import { forbidden } from '../lib/errors';
import { camelize } from '../lib/case';
import { nonEmpty } from '../lib/text';
import { campaignScope } from '../lib/scope';

const FINANCE_ENTITIES = ['order', 'import_batch', 'import_error', 'commission_rule', 'settlement'];

export async function listAudit(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'audit.read');
  const params: unknown[] = [actor.orgId];
  const where = ['a.organization_id=$1'];
  if (actor.role === 'FINANCE') { params.push(FINANCE_ENTITIES); where.push(`a.entity_type = ANY($${params.length}::text[])`); }
  const add = (col: string, v: string | null) => { if (v) { params.push(v); where.push(`${col}=$${params.length}`); } };
  add('a.entity_type', nonEmpty(q.get('entityType')));
  add('a.entity_id', nonEmpty(q.get('entityId')));
  add('a.campaign_id', nonEmpty(q.get('campaignId')));
  add('a.actor_user_id', nonEmpty(q.get('actorUserId')));
  add('a.action', nonEmpty(q.get('action')));
  const limit = Math.min(Number(q.get('limit') ?? 100) || 100, 500);
  const rows = await query(
    `SELECT a.id, a.occurred_at, a.actor_user_id, u.name AS actor_name, a.actor_role, a.actor_type, a.action, a.entity_type, a.entity_id, a.campaign_id,
       a.before_data, a.after_data, a.reason, a.request_id, a.source
     FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ${limit}`, params);
  return camelize(rows);
}

/** 單一檔期的異動紀錄：內部人員、且該檔期在其資料範圍內 */
export async function listCampaignAudit(actor: Actor, campaignId: string) {
  if (!isInternal(actor)) throw forbidden();
  const sc = campaignScope(actor, 2, 'c');
  const ok = sc.sql === 'FALSE' ? [] : await query('SELECT 1 FROM campaigns c WHERE c.id=$1 AND (' + sc.sql + ')', [campaignId, ...sc.params]);
  if (!ok.length) throw forbidden('找不到此檔期或沒有權限');
  const rows = await query(
    `SELECT a.id, a.occurred_at, u.name AS actor_name, a.actor_role, a.actor_type, a.action, a.entity_type, a.entity_id, a.before_data, a.after_data, a.reason, a.source
     FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.organization_id=$1 AND a.campaign_id=$2 ORDER BY a.id DESC LIMIT 300`, [actor.orgId, campaignId]);
  return camelize(rows);
}
