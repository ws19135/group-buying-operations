import type { Queryable } from '../lib/db';
import { pool, query } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, requirePerm } from '../lib/permissions';
import { forbidden, validation } from '../lib/errors';
import { addDays, monthRange } from '../lib/dates';
import { todayTaipei } from '../lib/ids';
import { camelize } from '../lib/case';
import { campaignScope } from '../lib/scope';
import { pickCommissionRule } from '../lib/commission-calc';
import { attainment, computeSalesFromAgg, dataStatus, estimateCommission, KPI_DEFS, SALES_STATUSES, type DataStatus, type SalesAggRow } from '../lib/kpi';

export interface DataQuality {
  status: DataStatus;
  statusLabel: string;
  lastImport: { id: string; finishedAt: string | null; dataAsOf: string | null; sourceSystem: string; status: string } | null;
  openImportErrors: number;
  warnings: string[];
}

const STATUS_LABEL: Record<DataStatus, string> = {
  NO_DATA: '待串接：尚無任何訂單資料',
  DEMO: 'DEMO 資料：以下業績為虛構的示範資料，不是真實營運數字',
  IMPORT: '資料來自 CSV 匯入',
  MIXED: '含 DEMO 與匯入資料混合：請勿作為正式業績',
};

function periodBounds(ym?: string | null): { ym: string; startDate: string; endDate: string; from: string; to: string } {
  const month = ym && /^\d{4}-\d{2}$/.test(ym) ? ym : todayTaipei().slice(0, 7);
  const m = Number(month.slice(5));
  if (m < 1 || m > 12) throw validation('月份格式需為 YYYY-MM');
  const { start, end } = monthRange(month);
  return { ym: month, startDate: start, endDate: end, from: `${start}T00:00:00+08:00`, to: `${addDays(end, 1)}T00:00:00+08:00` };
}

async function dataQuality(db: Queryable, orgId: string, scopeSql: string, scopeParams: unknown[]): Promise<DataQuality> {
  const origins = await db.query<{ data_origin: string }>(
    `SELECT DISTINCT o.data_origin FROM orders o JOIN campaigns c ON c.id=o.campaign_id WHERE (${scopeSql})`, scopeParams);
  const last = await db.query(
    `SELECT id, finished_at, data_as_of, source_system, status FROM import_batches WHERE organization_id=$1 ORDER BY started_at DESC LIMIT 1`, [orgId]);
  const err = await db.query(`SELECT count(*)::int AS n FROM import_errors WHERE organization_id=$1 AND status='OPEN'`, [orgId]);
  const st = dataStatus(origins.rows.map((r) => r.data_origin));
  const warnings: string[] = [];
  if (st === 'NO_DATA') warnings.push('尚無訂單資料，所有業績指標暫不顯示數字');
  if (st === 'DEMO' || st === 'MIXED') warnings.push('目前包含 DEMO 示範資料');
  if (err.rows[0].n > 0) warnings.push(`有 ${err.rows[0].n} 筆匯入錯誤待處理，業績可能不完整`);
  const l = last.rows[0];
  if (l?.status === 'PARTIAL' || l?.status === 'FAILED') warnings.push(`最近一次匯入狀態為 ${l.status}，資料可能不完整`);
  if (l?.data_as_of && Date.now() - new Date(l.data_as_of).getTime() > 3 * 86_400_000) warnings.push('訂單資料已超過 3 天未更新');
  return {
    status: st, statusLabel: STATUS_LABEL[st],
    lastImport: l ? { id: l.id, finishedAt: l.finished_at?.toISOString() ?? null, dataAsOf: l.data_as_of?.toISOString() ?? null, sourceSystem: l.source_system, status: l.status } : null,
    openImportErrors: err.rows[0].n, warnings,
  };
}

const k = (key: string, value: number | null, extra: Record<string, unknown> = {}) => ({ ...KPI_DEFS[key], value, ...extra });

async function salesAgg(db: Queryable, scopeSql: string, scopeParams: unknown[], from: string, to: string, extraWhere = '', extraParams: unknown[] = []): Promise<SalesAggRow[]> {
  const n = scopeParams.length;
  const r = await db.query(
    `SELECT o.status, count(*)::int AS n, coalesce(sum(o.gross_amount),0)::bigint AS gross, coalesce(sum(o.refund_amount),0)::bigint AS refund,
       count(*) FILTER (WHERE o.refund_amount > 0)::int AS refunded_n
     FROM orders o JOIN campaigns c ON c.id=o.campaign_id
     WHERE (${scopeSql}) AND o.ordered_at >= $${n + 1} AND o.ordered_at < $${n + 2} ${extraWhere}
     GROUP BY o.status`, [...scopeParams, from, to, ...extraParams]);
  return r.rows.map((x) => ({ status: x.status, n: x.n, gross: Number(x.gross), refund: Number(x.refund), refundedN: x.refunded_n }));
}

/** 檔期的參與團主（不含已婉拒）：主要團主排前面。供儀表板清單標出「是哪位團主」 */
const CAMPAIGN_HOSTS_JSON = `(SELECT coalesce(json_agg(json_build_object('hostId', h.id, 'name', h.display_name, 'role', ch.role, 'status', ch.status) ORDER BY (ch.role = 'PRIMARY') DESC, h.display_name), '[]'::json)
  FROM campaign_hosts ch JOIN hosts h ON h.id = ch.host_id
  WHERE ch.campaign_id = c.id AND ch.deleted_at IS NULL AND h.deleted_at IS NULL AND ch.status <> 'DECLINED')`;

// ===================== 管理者 Dashboard =====================
export async function getAdminDashboard(actor: Actor, periodYm?: string | null) {
  requirePerm(actor, 'dashboard.admin');
  const sc = campaignScope(actor, 1, 'c');
  if (sc.sql === 'FALSE') throw forbidden();
  const db = pool();
  const today = todayTaipei();
  const p = periodBounds(periodYm);
  const dq = await dataQuality(db, actor.orgId, sc.sql, sc.params);
  const hasOrders = dq.status !== 'NO_DATA';
  const showSales = can(actor, 'order.read');
  const showTargets = showSales && can(actor, 'campaign.sensitive.read');   // 檔期目標屬內部敏感資料

  const pipeline = (await db.query(`SELECT c.status, count(*)::int AS n FROM campaigns c WHERE (${sc.sql}) GROUP BY c.status`, sc.params)).rows;
  // 一檔在 30 天內既開團又結團時，兩個事件都要列出（各一列）
  const n0 = sc.params.length;
  const upcomingSelect = (event: 'OPEN' | 'CLOSE', col: 'open_date' | 'close_date') =>
    `SELECT c.id, c.title, c.status, c.open_date, c.close_date, c.vendor_id, v.name AS vendor_name, ${CAMPAIGN_HOSTS_JSON} AS hosts, '${event}' AS event, c.${col} AS event_date
     FROM campaigns c JOIN vendors v ON v.id = c.vendor_id
     WHERE (${sc.sql}) AND c.status NOT IN ('CLOSED','CANCELLED') AND c.${col} BETWEEN $${n0 + 1}::date AND $${n0 + 2}::date`;
  const upcoming = (await db.query(
    `SELECT * FROM (${upcomingSelect('OPEN', 'open_date')} UNION ALL ${upcomingSelect('CLOSE', 'close_date')}) e
     ORDER BY event_date, id, event DESC LIMIT 100`, [...sc.params, today, addDays(today, 30)])).rows;

  let sales = null;
  let unattributed: number | null = null;
  let attainmentVal: number | null = null;
  let targetTotal: number | null = null;
  let hostPerf: unknown[] = [];
  let byCampaign: unknown[] = [];
  if (showSales) {
    const totals = computeSalesFromAgg(await salesAgg(db, sc.sql, sc.params, p.from, p.to));
    const n = sc.params.length;
    const attributed = (await db.query(
      `SELECT coalesce(sum((o.gross_amount - o.refund_amount) * a.share_percent / 100.0),0) AS net
       FROM orders o JOIN campaigns c ON c.id=o.campaign_id JOIN attributions a ON a.order_id=o.id
       WHERE (${sc.sql}) AND o.status = ANY($${n + 1}::text[]) AND o.ordered_at >= $${n + 2} AND o.ordered_at < $${n + 3}`,
      [...sc.params, [...SALES_STATUSES], p.from, p.to])).rows[0].net;
    unattributed = hasOrders ? Math.round(totals.net - Number(attributed)) : null;
    sales = {
      gmv: k('gmv', hasOrders ? totals.gmv : null), refund: k('refund', hasOrders ? totals.refund : null), net: k('net', hasOrders ? totals.net : null),
      orders: k('orders', hasOrders ? totals.orders : null), aov: k('aov', hasOrders ? totals.aov : null), refundRate: k('refundRate', hasOrders ? totals.refundRate : null),
    };
    const tgt = !showTargets ? [] : (await db.query(
      `SELECT c.id, c.title, c.target_revenue,
         coalesce((SELECT sum(o.gross_amount - o.refund_amount) FROM orders o WHERE o.campaign_id=c.id AND o.status = ANY($${n + 3}::text[])),0)::bigint AS net_all
       FROM campaigns c WHERE (${sc.sql}) AND c.target_revenue IS NOT NULL AND c.target_revenue > 0 AND c.status <> 'CANCELLED'
         AND (c.close_date IS NULL OR c.close_date >= $${n + 1}::date) AND (c.open_date IS NULL OR c.open_date <= $${n + 2}::date)`,
      [...sc.params, p.startDate, p.endDate, [...SALES_STATUSES]])).rows;
    byCampaign = tgt.map((r) => ({ id: r.id, title: r.title, target: Number(r.target_revenue), net: Number(r.net_all), attainment: attainment(Number(r.net_all), Number(r.target_revenue)) }));
    targetTotal = tgt.length ? tgt.reduce((s, r) => s + Number(r.target_revenue), 0) : null;
    const netAll = tgt.reduce((s, r) => s + Number(r.net_all), 0);
    attainmentVal = hasOrders ? attainment(netAll, targetTotal) : null;

    hostPerf = (await db.query(
      `SELECT h.id AS host_id, h.display_name,
         count(DISTINCT o.campaign_id)::int AS campaigns,
         coalesce(sum(CASE WHEN o.status = ANY($${n + 3}::text[]) THEN (o.gross_amount - o.refund_amount) * a.share_percent / 100.0 END),0) AS net,
         coalesce(sum(CASE WHEN o.status IN ('PAID','PARTIAL_REFUND') THEN a.share_percent / 100.0 END),0) AS orders
       FROM attributions a JOIN orders o ON o.id=a.order_id JOIN campaigns c ON c.id=o.campaign_id JOIN hosts h ON h.id=a.host_id
       WHERE (${sc.sql}) AND o.ordered_at >= $${n + 1} AND o.ordered_at < $${n + 2}
       GROUP BY h.id, h.display_name ORDER BY net DESC LIMIT 50`,
      [...sc.params, p.from, p.to, [...SALES_STATUSES]])).rows.map((r) => ({
        hostId: r.host_id, name: r.display_name, campaigns: r.campaigns, net: Math.round(Number(r.net)), orders: Math.round(Number(r.orders)),
      }));
  }

  const taskRows = (await db.query(
    `SELECT count(*) FILTER (WHERE t.status IN ('TODO','IN_PROGRESS','BLOCKED','WAITING_APPROVAL'))::int AS open,
            count(*) FILTER (WHERE t.status IN ('TODO','IN_PROGRESS','BLOCKED','WAITING_APPROVAL') AND t.planned_end < $${sc.params.length + 1}::date)::int AS overdue,
            count(*) FILTER (WHERE t.status IN ('TODO','IN_PROGRESS','BLOCKED','WAITING_APPROVAL') AND t.planned_end = $${sc.params.length + 1}::date)::int AS due_today,
            count(*) FILTER (WHERE t.status IN ('TODO','IN_PROGRESS','BLOCKED','WAITING_APPROVAL') AND t.assignee_user_id IS NULL AND t.owner_role IN ('OPS_EDITOR','OPS_MANAGER'))::int AS unassigned,
            count(*) FILTER (WHERE t.status = 'BLOCKED')::int AS blocked,
            count(*) FILTER (WHERE t.status = 'WAITING_APPROVAL')::int AS waiting_approval
     FROM tasks t JOIN campaigns c ON c.id=t.campaign_id WHERE (${sc.sql}) AND c.status NOT IN ('CANCELLED','ON_HOLD','CLOSED')`, [...sc.params, today])).rows[0];
  const overdueList = (await db.query(
    `SELECT t.id, t.name, t.campaign_id, c.title AS campaign_title, t.owner_role, t.planned_end, u.name AS assignee_name,
       c.vendor_id, v.name AS vendor_name, ${CAMPAIGN_HOSTS_JSON} AS hosts,
       ($${sc.params.length + 1}::date - t.planned_end)::int AS days_late
     FROM tasks t JOIN campaigns c ON c.id=t.campaign_id JOIN vendors v ON v.id=c.vendor_id LEFT JOIN users u ON u.id=t.assignee_user_id
     WHERE (${sc.sql}) AND c.status NOT IN ('CANCELLED','ON_HOLD','CLOSED') AND t.status IN ('TODO','IN_PROGRESS','BLOCKED','WAITING_APPROVAL') AND t.planned_end < $${sc.params.length + 1}::date
     ORDER BY t.planned_end, t.id LIMIT 20`, [...sc.params, today])).rows;
  const exceptions = can(actor, 'exception.read')
    ? (await db.query(
        `SELECT e.severity, count(*)::int AS n FROM exceptions e LEFT JOIN campaigns c ON c.id=e.campaign_id
         WHERE e.organization_id=$1 AND e.status<>'RESOLVED' AND (e.campaign_id IS NULL OR (${sc.sql.replace(/\$1\b/, '$1')})) GROUP BY e.severity`, sc.params)).rows
    : [];
  const vendors = (await db.query(
    `SELECT v.id AS vendor_id, v.name, count(DISTINCT c.id)::int AS campaigns,
       count(DISTINCT c.id) FILTER (WHERE c.status IN ('RUNNING','SCHEDULED'))::int AS live,
       count(t.id) FILTER (WHERE t.status NOT IN ('SKIPPED','CANCELLED'))::int AS tasks_total,
       count(t.id) FILTER (WHERE t.status = 'DONE')::int AS tasks_done,
       count(t.id) FILTER (WHERE t.owner_role='VENDOR' AND t.status IN ('TODO','IN_PROGRESS','BLOCKED') AND t.planned_end < $${sc.params.length + 1}::date)::int AS vendor_overdue
     FROM campaigns c JOIN vendors v ON v.id=c.vendor_id LEFT JOIN tasks t ON t.campaign_id=c.id
     WHERE (${sc.sql}) AND c.status NOT IN ('CLOSED','CANCELLED') GROUP BY v.id, v.name ORDER BY campaigns DESC, v.name LIMIT 30`, [...sc.params, today])).rows;
  // 廠商合作進度（逐檔）：目前卡在哪個任務、是誰的、完成度、逾期數、哪些團主參與
  const vendorCampaigns = (await db.query(
    `SELECT c.id AS campaign_id, c.title, c.status, c.vendor_id, v.name AS vendor_name, c.open_date, c.close_date, ${CAMPAIGN_HOSTS_JSON} AS hosts,
       count(t.id) FILTER (WHERE t.status NOT IN ('SKIPPED','CANCELLED'))::int AS tasks_total,
       count(t.id) FILTER (WHERE t.status = 'DONE')::int AS tasks_done,
       count(t.id) FILTER (WHERE t.status IN ('TODO','IN_PROGRESS','BLOCKED','WAITING_APPROVAL') AND t.planned_end < $${sc.params.length + 1}::date)::int AS overdue,
       count(t.id) FILTER (WHERE t.owner_role = 'VENDOR' AND t.status IN ('TODO','IN_PROGRESS','BLOCKED') AND t.planned_end < $${sc.params.length + 1}::date)::int AS vendor_overdue,
       nt.name AS next_task_name, nt.planned_end AS next_task_due, nt.owner_role AS next_task_owner_role
     FROM campaigns c JOIN vendors v ON v.id = c.vendor_id LEFT JOIN tasks t ON t.campaign_id = c.id
     LEFT JOIN LATERAL (SELECT x.name, x.planned_end, x.owner_role FROM tasks x WHERE x.campaign_id = c.id AND x.status IN ('TODO','IN_PROGRESS','BLOCKED','WAITING_APPROVAL')
                        ORDER BY x.planned_end NULLS LAST, x.seq LIMIT 1) nt ON true
     WHERE (${sc.sql}) AND c.status NOT IN ('CLOSED','CANCELLED')
     GROUP BY c.id, v.id, v.name, nt.name, nt.planned_end, nt.owner_role
     ORDER BY overdue DESC, c.open_date NULLS LAST, c.id LIMIT 50`, [...sc.params, today])).rows;
  const communities = (await db.query(
    `SELECT platform, count(*)::int AS n FROM communities WHERE organization_id=$1 AND deleted_at IS NULL AND status='ACTIVE' GROUP BY platform ORDER BY platform`, [actor.orgId])).rows;
  const hostCounts = (await db.query(`SELECT status, count(*)::int AS n FROM hosts WHERE organization_id=$1 AND deleted_at IS NULL GROUP BY status`, [actor.orgId])).rows;
  const placementsNext = (await db.query(
    `SELECT count(*)::int AS n FROM campaign_placements p JOIN campaigns c ON c.id=p.campaign_id
     WHERE (${sc.sql}) AND p.deleted_at IS NULL AND p.status='PLANNED' AND p.scheduled_on BETWEEN $${sc.params.length + 1}::date AND $${sc.params.length + 2}::date`, [...sc.params, today, addDays(today, 7)])).rows[0].n;
  const pendingApprovals = (await db.query(
    `SELECT count(*)::int AS n FROM approvals a JOIN campaigns c ON c.id=a.campaign_id WHERE (${sc.sql}) AND a.status='PENDING'`, sc.params)).rows[0].n;

  return {
    generatedAt: new Date().toISOString(),
    period: { month: p.ym, from: p.startDate, to: p.endDate },
    dataQuality: dq,
    kpiDefinitions: KPI_DEFS,
    sales: showSales ? sales : null,
    targets: showTargets ? { total: targetTotal, attainment: k('attainment', attainmentVal), byCampaign } : null,
    unattributedNet: unattributed,
    pipeline: camelize(pipeline),
    upcoming: camelize(upcoming),
    hostPerformance: hostPerf,
    communities: { byPlatform: camelize(communities), plannedPlacementsNext7Days: placementsNext },
    hosts: camelize(hostCounts),
    tasks: camelize(taskRows),
    overdueTasks: camelize(overdueList),
    exceptions: camelize(exceptions),
    pendingApprovals,
    vendors: camelize(vendors),
    vendorCampaigns: camelize(vendorCampaigns),
  };
}

// ===================== 團主 Dashboard =====================
export async function getHostDashboard(actor: Actor, hostIdParam?: string | null, periodYm?: string | null) {
  let hostId: string;
  if (actor.role === 'HOST') {
    requirePerm(actor, 'dashboard.host');
    hostId = hostIdParam ?? actor.hostIds[0];
    if (!hostId || !actor.hostIds.includes(hostId)) throw forbidden('只能查看自己的團主資料');
  } else {
    // 內部人員以團主視角檢視（客服／驗證口徑一致用）：需有 dashboard.admin，且該團主在其可見檔期內
    requirePerm(actor, 'dashboard.admin');
    if (!hostIdParam) throw validation('請指定 hostId');
    hostId = hostIdParam;
  }
  const db = pool();
  const today = todayTaipei();
  const p = periodBounds(periodYm);
  const host = (await db.query('SELECT id, display_name FROM hosts WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [hostId, actor.orgId])).rows[0];
  if (!host) throw forbidden('找不到團主');

  // 共用範圍：此團主參與（未婉拒）的檔期，且在呼叫者可見範圍內
  const sc = campaignScope(actor.role === 'HOST' ? { ...actor, hostIds: [hostId] } : actor, 1, 'c');
  const base = `(${sc.sql}) AND EXISTS (SELECT 1 FROM campaign_hosts mh WHERE mh.campaign_id=c.id AND mh.host_id=$${sc.params.length + 1} AND mh.deleted_at IS NULL AND mh.status<>'DECLINED')`;
  const bp = [...sc.params, hostId];
  const n = bp.length;

  const campaigns = (await db.query(
    `SELECT c.id, c.title, c.status, c.open_date, c.close_date, ch.role, ch.status AS my_status, ch.target_revenue AS my_target,
       ch.commission_rule_id,
       coalesce((SELECT sum((o.gross_amount - o.refund_amount) * a.share_percent / 100.0) FROM orders o JOIN attributions a ON a.order_id=o.id AND a.host_id=ch.host_id
                 WHERE o.campaign_id=c.id AND o.status = ANY($${n + 1}::text[])),0) AS my_net,
       (SELECT count(*)::int FROM orders o JOIN attributions a ON a.order_id=o.id AND a.host_id=ch.host_id WHERE o.campaign_id=c.id) AS my_order_rows
     FROM campaigns c JOIN campaign_hosts ch ON ch.campaign_id=c.id AND ch.host_id=$${n} AND ch.deleted_at IS NULL
     WHERE ${base} AND c.status NOT IN ('CANCELLED','DRAFT') ORDER BY c.open_date NULLS LAST, c.id`, [...bp, [...SALES_STATUSES]])).rows;

  const rules = (await db.query(
    `SELECT id, scope_type, campaign_id, rate_percent, effective_from, effective_to FROM commission_rules
     WHERE organization_id=$1 AND host_id=$2 AND status='ACTIVE' ORDER BY effective_from DESC`, [actor.orgId, hostId])).rows;
  const pickRule = (c: { id: string; open_date: string | null; commission_rule_id: string | null }) => pickCommissionRule(rules, c, today);

  const myCampaigns = campaigns.map((c) => {
    const rule = pickRule(c);
    const net = Math.round(Number(c.my_net));
    return {
      id: c.id, title: c.title, status: c.status, openDate: c.open_date, closeDate: c.close_date, myRole: c.role, myStatus: c.my_status,
      myTarget: c.my_target == null ? null : Number(c.my_target), myNet: c.my_order_rows ? net : null,
      attainment: c.my_order_rows ? attainment(net, c.my_target == null ? null : Number(c.my_target)) : null,
      commissionRate: rule ? Number(rule.rate_percent) : null,
      estimatedCommission: c.my_order_rows && rule ? estimateCommission(net, Number(rule.rate_percent)) : null,
      commissionNote: rule ? `預估（費率規則 ${rule.id}，尚未結算）` : '尚未設定佣金費率，無法預估',
    };
  });

  // 歸因分攤比例：以 attributions 計算我的淨銷售（共同團主分攤），與管理端「團主績效」同公式
  const mine = (await db.query(
    `SELECT coalesce(sum((o.gross_amount - o.refund_amount) * a.share_percent / 100.0),0) AS net,
            coalesce(sum(o.gross_amount * a.share_percent / 100.0),0) AS gmv,
            coalesce(sum(CASE WHEN o.status IN ('PAID','PARTIAL_REFUND') THEN a.share_percent / 100.0 END),0) AS orders
     FROM orders o JOIN campaigns c ON c.id=o.campaign_id JOIN attributions a ON a.order_id=o.id AND a.host_id=$${n}
     WHERE ${base} AND o.status = ANY($${n + 1}::text[]) AND o.ordered_at >= $${n + 2} AND o.ordered_at < $${n + 3}`, [...bp, [...SALES_STATUSES], p.from, p.to])).rows[0];

  const tasks = (await db.query(
    `SELECT t.id, t.name, t.step_key, t.status, t.planned_start, t.planned_end, t.campaign_id, c.title AS campaign_title,
       (t.planned_end < $${n + 1}::date AND t.status IN ('TODO','IN_PROGRESS','BLOCKED')) AS overdue
     FROM tasks t JOIN campaigns c ON c.id=t.campaign_id WHERE ${base} AND t.owner_role='HOST' AND t.status IN ('TODO','IN_PROGRESS','BLOCKED','WAITING_APPROVAL')
     ORDER BY t.planned_end NULLS LAST LIMIT 50`, [...bp, today])).rows;
  const pendingInvites = (await db.query(
    `SELECT c.id, c.title, c.open_date FROM campaigns c JOIN campaign_hosts ch ON ch.campaign_id=c.id AND ch.host_id=$${n} AND ch.deleted_at IS NULL
     WHERE ${base} AND ch.status IN ('INVITED','NO_RESPONSE') ORDER BY c.open_date NULLS LAST`, bp)).rows;
  const calendar = (await db.query(
    `SELECT 'PLACEMENT' AS kind, p.scheduled_on AS date, p.placement_type AS label, c.id AS campaign_id, c.title AS campaign_title, cm.name AS community_name, p.status
     FROM campaign_placements p JOIN campaigns c ON c.id=p.campaign_id JOIN communities cm ON cm.id=p.community_id
     WHERE ${base} AND p.host_id=$${n} AND p.deleted_at IS NULL AND p.status<>'CANCELLED' AND p.scheduled_on BETWEEN $${n + 1}::date AND $${n + 2}::date
     UNION ALL
     SELECT 'OPEN', c.open_date, '開團', c.id, c.title, NULL, c.status FROM campaigns c WHERE ${base} AND c.open_date BETWEEN $${n + 1}::date AND $${n + 2}::date
     UNION ALL
     SELECT 'CLOSE', c.close_date, '結團', c.id, c.title, NULL, c.status FROM campaigns c WHERE ${base} AND c.close_date BETWEEN $${n + 1}::date AND $${n + 2}::date
     ORDER BY date`, [...bp, today, addDays(today, 60)])).rows;
  const prep = (await db.query(
    `SELECT t.campaign_id, c.title AS campaign_title, t.step_key, t.name, t.status, t.planned_end
     FROM tasks t JOIN campaigns c ON c.id=t.campaign_id WHERE ${base} AND t.step_key IN ('SAMPLE_SHIP','TRIAL_ARRIVAL','TRIAL_FEEDBACK','CREATIVE_ASSETS','LAUNCH_APPROVAL')
     ORDER BY c.id, t.seq`, bp)).rows;

  const dq = await dataQuality(db, actor.orgId, base, bp);
  const settlementStages = myCampaigns.map((c) => ({
    campaignId: c.id, title: c.title, status: c.status,
    stage: ['FULFILLING', 'PENDING_SETTLEMENT'].includes(c.status) ? '履約／結算準備中' : c.status === 'SETTLED' ? '已結算' : c.status === 'CLOSED' ? '已結案' : '尚未進入結算',
  }));
  const totalEst = myCampaigns.reduce((s, c) => s + (c.estimatedCommission ?? 0), 0);
  const anyEst = myCampaigns.some((c) => c.estimatedCommission != null);
  const warnings = [...dq.warnings];
  if (myCampaigns.some((c) => c.commissionRate == null)) warnings.push('部分檔期尚未設定佣金費率，預估佣金不含這些檔期');

  return {
    generatedAt: new Date().toISOString(),
    host: { id: host.id, name: host.display_name },
    period: { month: p.ym, from: p.startDate, to: p.endDate },
    dataQuality: { ...dq, warnings },
    kpiDefinitions: KPI_DEFS,
    performance: (() => {
      const hasMine = dq.status !== 'NO_DATA';
      return {
        gmv: k('gmv', hasMine ? Math.round(Number(mine.gmv)) : null), net: k('net', hasMine ? Math.round(Number(mine.net)) : null),
        orders: k('orders', hasMine ? Math.round(Number(mine.orders)) : null),
      };
    })(),
    myCampaigns,
    commission: { estimatedTotal: k('estCommission', anyEst ? totalEst : null), basis: '預估：歸因有效淨銷售額 × 佣金費率；正式分潤以 Phase 2 結算批次確認為準' },
    todos: camelize(tasks), pendingInvites: camelize(pendingInvites),
    calendar: camelize(calendar), trialAndAssets: camelize(prep), settlementProgress: settlementStages,
  };
}

export { query };
