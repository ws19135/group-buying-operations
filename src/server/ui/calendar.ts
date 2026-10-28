import { pool, query } from '@/server/lib/db';
import type { Actor } from '@/server/lib/permissions';
import { isInternal, requirePerm } from '@/server/lib/permissions';
import { campaignScope } from '@/server/lib/scope';
import { addDays } from '@/server/lib/dates';
import { todayTaipei } from '@/server/lib/ids';
import { detectConflicts } from '@/server/modules/conflicts';

export interface CalCampaign { id: string; title: string; status: string; openDate: string | null; closeDate: string | null; conflicts: number; highConflicts: number }
export interface CalPlacement { id: string; campaignId: string; campaignTitle: string; hostName: string; communityName: string; type: string; on: string; status: string }

export async function loadCalendar(actor: Actor, days = 90): Promise<{ from: string; to: string; campaigns: CalCampaign[]; placements: CalPlacement[] }> {
  requirePerm(actor, 'campaign.read');
  const from = todayTaipei();
  const to = addDays(from, days);
  const sc = campaignScope(actor, 1, 'c');
  if (sc.sql === 'FALSE') return { from, to, campaigns: [], placements: [] };
  const n = sc.params.length;
  const rows = await query<{ id: string; title: string; status: string; open_date: string | null; close_date: string | null }>(
    `SELECT c.id, c.title, c.status, c.open_date, c.close_date FROM campaigns c
     WHERE (${sc.sql}) AND c.status NOT IN ('CANCELLED') AND c.open_date IS NOT NULL AND c.close_date IS NOT NULL
       AND c.close_date >= $${n + 1}::date AND c.open_date <= $${n + 2}::date ORDER BY c.open_date, c.id LIMIT 60`, [...sc.params, from, to]);
  const internal = isInternal(actor);
  const campaigns: CalCampaign[] = [];
  for (const r of rows) {
    const cf = internal ? await detectConflicts(pool(), actor.orgId, r.id) : [];
    campaigns.push({ id: r.id, title: r.title, status: r.status, openDate: r.open_date, closeDate: r.close_date, conflicts: cf.length, highConflicts: cf.filter((x) => x.severity === 'HIGH').length });
  }
  const hostFilter = actor.role === 'HOST' ? `AND p.host_id = ANY($${n + 3}::text[])` : '';
  const pr = await query<{ id: string; campaign_id: string; title: string; host_name: string; community_name: string; placement_type: string; scheduled_on: string; status: string }>(
    `SELECT p.id, p.campaign_id, c.title, h.display_name AS host_name, cm.name AS community_name, p.placement_type, p.scheduled_on, p.status
     FROM campaign_placements p JOIN campaigns c ON c.id=p.campaign_id JOIN hosts h ON h.id=p.host_id JOIN communities cm ON cm.id=p.community_id
     WHERE (${sc.sql}) AND p.deleted_at IS NULL AND p.status<>'CANCELLED' AND p.scheduled_on BETWEEN $${n + 1}::date AND $${n + 2}::date ${hostFilter}
     ORDER BY p.scheduled_on, p.id LIMIT 300`, actor.role === 'HOST' ? [...sc.params, from, to, actor.hostIds] : [...sc.params, from, to]);
  return {
    from, to, campaigns,
    placements: pr.map((p) => ({ id: p.id, campaignId: p.campaign_id, campaignTitle: p.title, hostName: p.host_name, communityName: p.community_name, type: p.placement_type, on: p.scheduled_on, status: p.status })),
  };
}
