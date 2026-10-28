import type { Queryable } from './db';
import { SALES_STATUSES, estimateCommission } from './kpi';
import { todayTaipei } from './ids';

/**
 * 佣金口徑（單一定義）：團主 Dashboard 的預估佣金與財務結算試算共用，避免兩處各算一份。
 *   預估佣金 = 歸因有效淨銷售額（Σ (gross − refund) × share_percent / 100，計入銷售的訂單狀態）× 生效中的佣金費率
 * 費率選取順序：檔期團主已綁定的規則 → 該檔期專屬規則 → 團主預設規則（以開團日為基準日、需在生效區間內）
 * 沒有規則就回傳 undefined，不猜費率。
 */
export interface CommissionRuleRow {
  id: string;
  scope_type: string;
  campaign_id: string | null;
  rate_percent: number;
  effective_from: string;
  effective_to: string | null;
  rule_version?: number;
}

export function pickCommissionRule<R extends CommissionRuleRow>(
  rules: R[],
  c: { id: string; open_date: string | null; commission_rule_id: string | null },
  today: string,
): R | undefined {
  const byId = rules.find((r) => r.id === c.commission_rule_id);
  if (byId) return byId;
  const ref = c.open_date ?? today;
  return rules.find((r) => r.scope_type === 'CAMPAIGN_HOST' && r.campaign_id === c.id)
    ?? rules.find((r) => r.scope_type === 'HOST_DEFAULT' && r.effective_from <= ref && (!r.effective_to || r.effective_to >= ref));
}

export async function activeRulesForHost(db: Queryable, orgId: string, hostId: string): Promise<CommissionRuleRow[]> {
  const r = await db.query(
    `SELECT id, scope_type, campaign_id, rate_percent, effective_from, effective_to, rule_version FROM commission_rules
     WHERE organization_id=$1 AND host_id=$2 AND status='ACTIVE' ORDER BY effective_from DESC`, [orgId, hostId]);
  return r.rows as unknown as CommissionRuleRow[];
}

export interface HostCommissionCalc {
  hostId: string;
  hostName: string;
  netSales: number;
  orderRows: number;
  ruleId: string | null;
  ruleVersion: number | null;
  ratePercent: number | null;
  commissionAuto: number | null;
}

/** 某檔期每位團主的歸因淨銷售額與試算佣金（含檔期內未婉拒的團主，以及雖已移出檔期但有歸因訂單的團主） */
export async function campaignHostCommission(db: Queryable, orgId: string, campaignId: string): Promise<HostCommissionCalc[]> {
  const camp = (await db.query<{ id: string; open_date: string | null }>(`SELECT id, open_date FROM campaigns WHERE id=$1 AND organization_id=$2`, [campaignId, orgId])).rows[0];
  if (!camp) return [];
  const members = (await db.query<{ host_id: string; commission_rule_id: string | null; name: string }>(
    `SELECT ch.host_id, ch.commission_rule_id, h.display_name AS name FROM campaign_hosts ch JOIN hosts h ON h.id=ch.host_id
     WHERE ch.campaign_id=$1 AND ch.organization_id=$2 AND ch.deleted_at IS NULL AND ch.status <> 'DECLINED'`, [campaignId, orgId])).rows;
  const sales = (await db.query<{ host_id: string; net: number; order_rows: number; name: string }>(
    `SELECT a.host_id, h.display_name AS name,
       coalesce(sum((o.gross_amount - o.refund_amount) * a.share_percent / 100.0) FILTER (WHERE o.status = ANY($3::text[])),0) AS net,
       count(*)::int AS order_rows
     FROM orders o JOIN attributions a ON a.order_id=o.id JOIN hosts h ON h.id=a.host_id
     WHERE o.organization_id=$1 AND o.campaign_id=$2 GROUP BY a.host_id, h.display_name`, [orgId, campaignId, [...SALES_STATUSES]])).rows;
  const hostIds = new Map<string, { name: string; ruleId: string | null }>();
  for (const m of members) hostIds.set(m.host_id, { name: m.name, ruleId: m.commission_rule_id });
  for (const s of sales) if (!hostIds.has(s.host_id)) hostIds.set(s.host_id, { name: s.name, ruleId: null });
  const today = todayTaipei();
  const out: HostCommissionCalc[] = [];
  for (const [hostId, m] of [...hostIds.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const s = sales.find((x) => x.host_id === hostId);
    const rules = await activeRulesForHost(db, orgId, hostId);
    const rule = pickCommissionRule(rules, { id: camp.id, open_date: camp.open_date, commission_rule_id: m.ruleId }, today);
    const net = Number(s?.net ?? 0);
    // 淨銷售為 0 時，不論費率為何佣金都是 0（不是新增公式）；有銷售卻沒有費率則不猜（null）
    const auto = rule ? estimateCommission(net, Number(rule.rate_percent)) : net === 0 ? 0 : null;
    out.push({
      hostId, hostName: m.name, netSales: Math.round(net), orderRows: s?.order_rows ?? 0,
      ruleId: rule?.id ?? null, ruleVersion: rule?.rule_version ?? null, ratePercent: rule ? Number(rule.rate_percent) : null, commissionAuto: auto,
    });
  }
  return out;
}
