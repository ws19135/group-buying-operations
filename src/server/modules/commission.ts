import { z } from 'zod';
import { query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, requirePerm } from '../lib/permissions';
import { AppError, forbidden, notFound, validation } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids } from '../lib/ids';
import { camelize } from '../lib/case';
import { isIsoDate } from '../lib/dates';

export const ruleSchema = z.object({
  scopeType: z.enum(['HOST_DEFAULT', 'CAMPAIGN_HOST']),
  hostId: z.string(),
  campaignId: z.string().optional(),
  ratePercent: z.number().min(0).max(100),
  effectiveFrom: z.string().refine(isIsoDate, '日期格式需為 YYYY-MM-DD'),
  effectiveTo: z.string().refine(isIsoDate, '日期格式需為 YYYY-MM-DD').optional(),
  note: z.string().trim().max(500).optional(),
});

/** 佣金規則為版本化資料：修改＝新增一版並封存舊版，舊版保留供重算 */
export async function createCommissionRule(actor: Actor, raw: z.input<typeof ruleSchema>) {
  requirePerm(actor, 'commission.write');
  const r = ruleSchema.parse(raw);
  if ((r.scopeType === 'CAMPAIGN_HOST') !== !!r.campaignId) throw validation('檔期專屬規則必須指定 campaignId，團主預設規則不可指定');
  if (r.effectiveTo && r.effectiveTo < r.effectiveFrom) throw validation('結束日不可早於生效日');
  return withTx(async (tx) => {
    const h = await tx.query('SELECT 1 FROM hosts WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [r.hostId, actor.orgId]);
    if (!h.rowCount) throw notFound('團主');
    if (r.campaignId) {
      const ch = await tx.query('SELECT id FROM campaign_hosts WHERE campaign_id=$1 AND host_id=$2 AND organization_id=$3 AND deleted_at IS NULL', [r.campaignId, r.hostId, actor.orgId]);
      if (!ch.rowCount) throw new AppError('PRECONDITION_FAILED', '該團主不在此檔期內');
    }
    const prev = await tx.query(
      `SELECT id, rule_version FROM commission_rules WHERE organization_id=$1 AND host_id=$2 AND scope_type=$3 AND COALESCE(campaign_id,'')=COALESCE($4,'') AND status='ACTIVE' ORDER BY rule_version DESC LIMIT 1 FOR UPDATE`,
      [actor.orgId, r.hostId, r.scopeType, r.campaignId ?? null]);
    const id = await ids.commissionRule(tx);
    const version = (prev.rows[0]?.rule_version ?? 0) + 1;
    if (prev.rowCount) await tx.query(`UPDATE commission_rules SET status='ARCHIVED' WHERE id=$1`, [prev.rows[0].id]);
    await tx.query(
      `INSERT INTO commission_rules (id, organization_id, scope_type, host_id, campaign_id, rate_percent, rule_version, effective_from, effective_to, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, actor.orgId, r.scopeType, r.hostId, r.campaignId ?? null, r.ratePercent, version, r.effectiveFrom, r.effectiveTo ?? null, r.note ?? null, actor.userId]);
    if (r.scopeType === 'CAMPAIGN_HOST') await tx.query('UPDATE campaign_hosts SET commission_rule_id=$3 WHERE campaign_id=$1 AND host_id=$2 AND deleted_at IS NULL', [r.campaignId, r.hostId, id]);
    await audit(tx, actor, { action: 'commission_rule.create', entityType: 'commission_rule', entityId: id, campaignId: r.campaignId ?? null, before: prev.rowCount ? { id: prev.rows[0].id, version: prev.rows[0].rule_version } : null, after: { ...r, version } });
    return { id, version };
  });
}

export async function listCommissionRules(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'commission.read');
  const params: unknown[] = [actor.orgId];
  const where = ['r.organization_id=$1'];
  if (actor.role === 'HOST') { params.push(actor.hostIds); where.push(`r.host_id = ANY($${params.length}::text[])`); }
  else if (!can(actor, 'commission.write') && actor.role !== 'OPS_MANAGER') throw forbidden();
  const hid = q.get('hostId'); if (hid) { params.push(hid); where.push(`r.host_id=$${params.length}`); }
  if (q.get('all') !== '1') where.push(`r.status='ACTIVE'`);
  return camelize(await query(
    `SELECT r.*, h.display_name AS host_name FROM commission_rules r JOIN hosts h ON h.id=r.host_id WHERE ${where.join(' AND ')} ORDER BY r.host_id, r.rule_version DESC LIMIT 300`, params));
}
