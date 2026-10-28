import { query } from '@/server/lib/db';
import type { Actor } from '@/server/lib/permissions';
import { campaignScope } from '@/server/lib/scope';

/** 目前使用者範圍內、可建立售後案件的檔期（已取消的檔期不列出） */
export async function aftersalesCampaignOptions(actor: Actor): Promise<{ value: string; label: string }[]> {
  const sc = campaignScope(actor, 1, 'c');
  if (sc.sql === 'FALSE') return [];
  const rows = await query<{ id: string; title: string }>(
    `SELECT c.id, c.title FROM campaigns c WHERE (${sc.sql}) AND c.status <> 'CANCELLED' ORDER BY c.id DESC LIMIT 200`, sc.params);
  return rows.map((r) => ({ value: r.id, label: `${r.title}（${r.id}）` }));
}
