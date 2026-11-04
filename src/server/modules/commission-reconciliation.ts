import { pool, query } from '../lib/db';
import type { Queryable } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, requirePerm } from '../lib/permissions';
import { forbidden } from '../lib/errors';
import { campaignScope } from '../lib/scope';
import { todayTaipei } from '../lib/ids';
import { activeRulesForHost, campaignHostCommission, pickCommissionRule } from '../lib/commission-calc';
import { reconcileRow, type ContractSnap, type FeasibilitySnap, type FinanceSnap, type ReconRow } from '../lib/commission-reconciliation';
import { pickDdRecord } from './selection-v2';

/**
 * 分潤口徑差異核對（唯讀，Owner 決策 K-6）：比較合約約定、商業可行性條款與財務結算規則。
 * 只讀取、只比較；不寫入任何資料、不覆蓋任何一方、不改結算演算法。資料含合約與分潤條件（敏感），需 finance.read 與 product.cost.read。
 */
export const RECON_NOTE = '唯讀比較：不會自動以任何一方覆蓋另一方；財務規則調整、已確認結算更正、實際付款、發票與歷史資料回填，都需 Owner 或既有有權角色另案核准。缺少正式合約條件的項目標示「資料不足」，暫估條款不視為已核准。';

async function contractFor(db: Queryable, orgId: string, vendorId: string, productId: string): Promise<ContractSnap | null> {
  const pick = await pickDdRecord(db, orgId, vendorId, productId);
  if (!pick) return null;
  const it = (await db.query<{ status: string; terms: Record<string, unknown> }>(`SELECT status, terms FROM vendor_dd_items WHERE record_id=$1 AND category_key='COMMISSION_TERMS'`, [pick.id])).rows[0];
  if (!it) return null;
  const t = it.terms ?? {};
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  return {
    recordId: pick.id, contractVersion: pick.contract_version, recordStatus: pick.status, validUntil: pick.valid_until ? String(pick.valid_until) : null, superseded: !!pick.superseded_at, itemStatus: it.status,
    basis: (t.basis as string | undefined) ?? null, hostCommissionPct: num(t.hostCommissionPct), legacyRatePct: num(t.ratePercent), hostPaidBy: (t.hostPaidBy as string | undefined) ?? null,
    effectiveFrom: (t.effectiveFrom as string | undefined) ?? null, effectiveTo: (t.effectiveTo as string | undefined) ?? null,
  };
}

async function feasibilityFor(db: Queryable, orgId: string, productId: string, campaignId: string, hostId: string): Promise<FeasibilitySnap | null> {
  const r = (await db.query<{ id: string; version_no: number; inputs: Record<string, unknown>; sources: Record<string, { kind?: string }> }>(
    `SELECT id, version_no, inputs, sources FROM feasibility_scenarios WHERE organization_id=$1 AND product_id=$2 AND campaign_id=$3 AND (host_id IS NULL OR host_id=$4)
     ORDER BY (host_id IS NOT NULL) DESC, created_at DESC, id DESC LIMIT 1`, [orgId, productId, campaignId, hostId])).rows[0];
  if (!r) return null;
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  return { scenarioId: r.id, versionNo: Number(r.version_no), commissionBasis: (r.inputs.commissionBasis as string | undefined) ?? null, hostCommissionPct: num(r.inputs.hostCommissionPct), hostPaidBy: (r.inputs.hostPaidBy as string | undefined) ?? null, sources: r.sources ?? {} };
}

async function financeFor(db: Queryable, orgId: string, camp: { id: string; open_date: string | null; commission_rule_id: string | null }, hostId: string, today: string): Promise<FinanceSnap | null> {
  const rule = pickCommissionRule(await activeRulesForHost(db, orgId, hostId), camp, today);
  if (!rule) return null;
  const full = (await db.query<{ status: string }>(`SELECT status FROM commission_rules WHERE id=$1`, [rule.id])).rows[0];
  const si = (await db.query<{ id: string; status: string; rate_percent: string | null; rule_version: number | null; net_sales: string | null }>(
    `SELECT si.id, s.status, si.rate_percent, si.rule_version, si.net_sales FROM settlement_items si JOIN settlements s ON s.id=si.settlement_id
     WHERE si.organization_id=$1 AND si.campaign_id=$2 AND si.host_id=$3 AND s.status IN ('DRAFT','CONFIRMED') ORDER BY s.created_at DESC LIMIT 1`, [orgId, camp.id, hostId])).rows[0];
  return {
    ruleId: rule.id, ruleVersion: Number(rule.rule_version ?? 1), scopeType: rule.scope_type, ratePercent: Number(rule.rate_percent), effectiveFrom: String(rule.effective_from), effectiveTo: rule.effective_to ? String(rule.effective_to) : null, ruleStatus: full?.status ?? 'ACTIVE',
    settlement: si ? { id: si.id, status: si.status, ratePercent: si.rate_percent == null ? null : Number(si.rate_percent), ruleVersion: si.rule_version, netSales: si.net_sales == null ? null : Number(si.net_sales) } : null,
  };
}

export async function getCommissionReconciliation(actor: Actor, opts: { campaignId?: string } = {}) {
  requirePerm(actor, 'finance.read');
  if (!can(actor, 'product.cost.read')) throw forbidden('合約與分潤條件屬敏感資料，需有成本檢視權限');
  const db = pool();
  const today = todayTaipei();
  const sc = campaignScope(actor, 2, 'c');
  const empty = { rows: [] as ReconRow[], summary: { rows: 0, different: 0, insufficient: 0, consistent: 0, needsReview: 0 }, note: RECON_NOTE, generatedAt: today };
  if (sc.sql === 'FALSE') return empty;
  const camps = await query<{ id: string; title: string; vendor_id: string; open_date: string | null }>(
    `SELECT c.id, c.title, c.vendor_id, c.open_date FROM campaigns c WHERE c.organization_id=$1 AND c.status <> 'CANCELLED' AND (${sc.sql}) ${opts.campaignId ? `AND c.id=$${sc.params.length + 2}` : ''}
     ORDER BY c.open_date DESC NULLS LAST, c.id DESC LIMIT 60`, [actor.orgId, ...sc.params, ...(opts.campaignId ? [opts.campaignId] : [])]);
  const rows: ReconRow[] = [];
  for (const c of camps) {
    const hosts = await query<{ host_id: string; name: string; commission_rule_id: string | null }>(
      `SELECT ch.host_id, h.display_name AS name, ch.commission_rule_id FROM campaign_hosts ch JOIN hosts h ON h.id=ch.host_id WHERE ch.campaign_id=$1 AND ch.organization_id=$2 AND ch.deleted_at IS NULL AND ch.status <> 'DECLINED' ORDER BY h.display_name`, [c.id, actor.orgId]);
    if (!hosts.length) continue;
    const prods = await query<{ product_id: string; name: string }>(`SELECT DISTINCT cp.product_id, p.name FROM campaign_products cp JOIN products p ON p.id=cp.product_id WHERE cp.campaign_id=$1 AND cp.deleted_at IS NULL ORDER BY p.name`, [c.id]);
    const net = new Map((await campaignHostCommission(db, actor.orgId, c.id)).map((x) => [x.hostId, x.netSales]));
    for (const h of hosts) {
      const fin = await financeFor(db, actor.orgId, { id: c.id, open_date: c.open_date, commission_rule_id: h.commission_rule_id }, h.host_id, today);
      for (const p of prods) {
        rows.push(reconcileRow({
          campaignId: c.id, campaignTitle: c.title, campaignOpenDate: c.open_date, hostId: h.host_id, hostName: h.name, productId: p.product_id, productName: p.name,
          contract: await contractFor(db, actor.orgId, c.vendor_id, p.product_id), feasibility: await feasibilityFor(db, actor.orgId, p.product_id, c.id, h.host_id), finance: fin,
          attributedNetSales: net.get(h.host_id) ?? 0,
        }, today));
      }
    }
  }
  return {
    rows,
    summary: { rows: rows.length, different: rows.filter((r) => r.verdict === 'DIFFERENT').length, insufficient: rows.filter((r) => r.verdict === 'INSUFFICIENT').length, consistent: rows.filter((r) => r.verdict === 'CONSISTENT').length, needsReview: rows.filter((r) => r.needsManualReview).length },
    note: RECON_NOTE, generatedAt: today,
  };
}
