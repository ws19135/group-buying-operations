import { query } from '@/server/lib/db';
import type { Actor } from '@/server/lib/permissions';
import { isInternal } from '@/server/lib/permissions';
import { forbidden } from '@/server/lib/errors';

/** 可被指派的營運人員（內部人員才能讀） */
export async function listAssignableUsers(actor: Actor): Promise<{ value: string; label: string }[]> {
  if (!isInternal(actor)) throw forbidden();
  const rows = await query<{ id: string; name: string; role_key: string }>(
    `SELECT id, name, role_key FROM users WHERE organization_id=$1 AND status='ACTIVE' AND deleted_at IS NULL AND role_key IN ('SYSTEM_ADMIN','OPS_MANAGER','OPS_EDITOR') ORDER BY name`, [actor.orgId]);
  return rows.map((r) => ({ value: r.id, label: `${r.name}（${r.role_key}）` }));
}
