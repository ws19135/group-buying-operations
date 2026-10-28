import { query } from '@/server/lib/db';
import type { Actor } from '@/server/lib/permissions';
import { hostOptions, vendorOptions, type Opt } from '@/server/ui/options';

export async function financeCampaignOptions(actor: Actor): Promise<Opt[]> {
  const rows = await query<{ id: string; title: string; status: string }>(
    `SELECT id, title, status FROM campaigns WHERE organization_id=$1 AND deleted_at IS NULL AND status NOT IN ('DRAFT','CANCELLED') ORDER BY created_at DESC LIMIT 200`, [actor.orgId]);
  return rows.map((r) => ({ value: r.id, label: `${r.title}（${r.id}）` }));
}

/** 入帳對象：廠商與團主放在同一個下拉；對象類型要和這裡選的一致，系統會檢查 */
export async function counterpartyOptions(actor: Actor): Promise<Opt[]> {
  const [v, h] = await Promise.all([vendorOptions(actor), hostOptions(actor)]);
  return [...v.map((o) => ({ ...o, label: `[廠商] ${o.label}` })), ...h.map((o) => ({ ...o, label: `[團主] ${o.label}` }))];
}
