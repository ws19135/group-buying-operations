import type { Queryable } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can } from '../lib/permissions';
import { camelize } from '../lib/case';
import { pickCommissionRule, type CommissionRuleRow } from '../lib/commission-calc';
import { SALES_STATUSES, estimateCommission } from '../lib/kpi';

/** 檔期的參與團主（不含已婉拒）：主要團主排前面。供儀表板清單標出「是哪位團主」 */
export const CAMPAIGN_HOSTS_JSON = `(SELECT coalesce(json_agg(json_build_object('hostId', h.id, 'name', h.display_name, 'role', ch.role, 'status', ch.status) ORDER BY (ch.role = 'PRIMARY') DESC, h.display_name), '[]'::json)
  FROM campaign_hosts ch JOIN hosts h ON h.id = ch.host_id
  WHERE ch.campaign_id = c.id AND ch.deleted_at IS NULL AND h.deleted_at IS NULL AND ch.status <> 'DECLINED')`;

export interface ExtraCtx {
  db: Queryable;
  actor: Actor;
  sc: { sql: string; params: unknown[] };
  today: string;
  p: { from: string; to: string; startDate: string; endDate: string };
  showSales: boolean;
}

const LIVE_STATUSES = ['SCHEDULED', 'RUNNING', 'PENDING_CLOSE_CHECK', 'FULFILLING', 'PENDING_SETTLEMENT'];
const LAUNCHED_STATUSES = ['RUNNING', 'PENDING_CLOSE_CHECK', 'FULFILLING', 'PENDING_SETTLEMENT', 'SETTLED', 'CLOSED'];
/** 結單之後理應已有訂單資料的狀態 */
const SHOULD_HAVE_ORDERS = ['PENDING_CLOSE_CHECK', 'FULFILLING', 'PENDING_SETTLEMENT', 'SETTLED'];

interface HostRef { hostId: string; name: string; role: string; status: string }
const hostNames = (hosts: HostRef[]) => (hosts.length ? hosts.map((h) => h.name).join('、') : '尚未邀請團主');

/** 進行中檔期（已排程到待結算）與參與團主數 */
async function overview({ db, sc }: ExtraCtx) {
  const r = (await db.query(
    `SELECT count(DISTINCT c.id)::int AS campaigns, count(DISTINCT ch.host_id)::int AS hosts
     FROM campaigns c LEFT JOIN campaign_hosts ch ON ch.campaign_id = c.id AND ch.deleted_at IS NULL AND ch.status <> 'DECLINED'
     WHERE (${sc.sql}) AND c.status = ANY($${sc.params.length + 1}::text[])`, [...sc.params, LIVE_STATUSES])).rows[0];
  return { liveCampaigns: r.campaigns as number, liveHosts: r.hosts as number, statuses: LIVE_STATUSES };
}

/** 佣金與收款：預估佣金（重用既有口徑）、已確認佣金（已確認結算）、已收款金額（入帳紀錄，方向 IN） */
async function financeKpis(ctx: ExtraCtx) {
  const { db, actor, sc, today, p } = ctx;
  const out: {
    estimatedCommission: { value: number | null; unrated: number } | null;
    confirmedCommission: { value: number; items: number } | null;
    received: { value: number; count: number } | null;
  } = { estimatedCommission: null, confirmedCommission: null, received: null };
  const n = sc.params.length;

  if (ctx.showSales && can(actor, 'commission.read')) {
    const rows = (await db.query(
      `SELECT a.host_id, o.campaign_id, c.open_date, ch.commission_rule_id,
              coalesce(sum((o.gross_amount - o.refund_amount) * a.share_percent / 100.0),0) AS net
       FROM attributions a JOIN orders o ON o.id = a.order_id JOIN campaigns c ON c.id = o.campaign_id
       LEFT JOIN campaign_hosts ch ON ch.campaign_id = c.id AND ch.host_id = a.host_id AND ch.deleted_at IS NULL
       WHERE (${sc.sql}) AND o.status = ANY($${n + 1}::text[]) AND o.ordered_at >= $${n + 2} AND o.ordered_at < $${n + 3}
       GROUP BY a.host_id, o.campaign_id, c.open_date, ch.commission_rule_id`,
      [...sc.params, [...SALES_STATUSES], p.from, p.to])).rows;
    const rules = (await db.query(
      `SELECT host_id, id, scope_type, campaign_id, rate_percent, effective_from, effective_to, rule_version FROM commission_rules
       WHERE organization_id = $1 AND status = 'ACTIVE' ORDER BY effective_from DESC`, [actor.orgId])).rows;
    const byHost = new Map<string, CommissionRuleRow[]>();
    for (const r of rules) { const list = byHost.get(r.host_id) ?? []; list.push(r as unknown as CommissionRuleRow); byHost.set(r.host_id, list); }
    let total = 0, unrated = 0, any = false;
    for (const r of rows) {
      const rule = pickCommissionRule(byHost.get(r.host_id) ?? [], { id: r.campaign_id, open_date: r.open_date, commission_rule_id: r.commission_rule_id }, today);
      const est = estimateCommission(Number(r.net), rule ? Number(rule.rate_percent) : null);
      if (est == null) { if (Number(r.net) > 0) unrated += 1; continue; }
      total += est; any = true;
    }
    out.estimatedCommission = { value: rows.length && any ? total : null, unrated };
  }

  if (can(actor, 'finance.read')) {
    const conf = (await db.query(
      `SELECT coalesce(sum(coalesce(si.commission_override, si.commission_auto)),0)::bigint AS amt, count(*)::int AS n
       FROM settlement_items si JOIN settlements s ON s.id = si.settlement_id JOIN campaigns c ON c.id = si.campaign_id
       WHERE (${sc.sql}) AND s.status = 'CONFIRMED' AND s.confirmed_at >= $${n + 1} AND s.confirmed_at < $${n + 2}`,
      [...sc.params, p.from, p.to])).rows[0];
    out.confirmedCommission = { value: Number(conf.amt), items: conf.n };
    const rec = (await db.query(
      `SELECT coalesce(sum(amount),0)::bigint AS amt, count(*)::int AS n FROM payments
       WHERE organization_id = $1 AND direction = 'IN' AND status = 'ACTIVE' AND paid_on BETWEEN $2::date AND $3::date`,
      [actor.orgId, p.startDate, p.endDate])).rows[0];
    out.received = { value: Number(rec.amt), count: rec.n };
  }
  return out;
}

/** 社群業績排行、每檔團購產值、資料來源與同步（只有能看業績的人才有） */
async function salesBreakdowns({ db, sc, p }: ExtraCtx) {
  const n = sc.params.length;
  const args = [...sc.params, [...SALES_STATUSES], p.from, p.to];
  const range = `o.status = ANY($${n + 1}::text[]) AND o.ordered_at >= $${n + 2} AND o.ordered_at < $${n + 3}`;
  const communities = (await db.query(
    `SELECT cm.id AS community_id, cm.name, cm.platform, count(DISTINCT o.id)::int AS orders,
            coalesce(sum((o.gross_amount - o.refund_amount) * a.share_percent / 100.0),0) AS net
     FROM attributions a JOIN orders o ON o.id = a.order_id JOIN campaigns c ON c.id = o.campaign_id JOIN communities cm ON cm.id = a.community_id
     WHERE (${sc.sql}) AND ${range} GROUP BY cm.id, cm.name, cm.platform ORDER BY net DESC, cm.name LIMIT 8`, args)).rows
    .map((r) => ({ communityId: r.community_id, name: r.name, platform: r.platform, orders: r.orders as number, net: Math.round(Number(r.net)) }));
  const perCampaign = (await db.query(
    `SELECT c.id, c.title, c.status, count(*)::int AS orders, coalesce(sum(o.gross_amount - o.refund_amount),0)::bigint AS net
     FROM orders o JOIN campaigns c ON c.id = o.campaign_id WHERE (${sc.sql}) AND ${range} GROUP BY c.id, c.title, c.status ORDER BY net DESC, c.id LIMIT 8`, args)).rows
    .map((r) => ({ id: r.id, title: r.title, status: r.status, orders: r.orders as number, net: Number(r.net) }));
  const campaignCount = (await db.query(
    `SELECT count(DISTINCT o.campaign_id)::int AS n FROM orders o JOIN campaigns c ON c.id = o.campaign_id WHERE (${sc.sql}) AND ${range}`, args)).rows[0].n as number;
  const totalNet = perCampaign.length ? (await db.query(
    `SELECT coalesce(sum(o.gross_amount - o.refund_amount),0)::bigint AS net FROM orders o JOIN campaigns c ON c.id = o.campaign_id WHERE (${sc.sql}) AND ${range}`, args)).rows[0].net : 0;
  const sources = (await db.query(
    `SELECT o.source_system, o.data_origin, count(*)::int AS orders, max(b.finished_at) AS last_sync, max(o.ordered_at) AS last_order_at
     FROM orders o JOIN campaigns c ON c.id = o.campaign_id LEFT JOIN import_batches b ON b.id = o.import_batch_id
     WHERE (${sc.sql}) GROUP BY o.source_system, o.data_origin ORDER BY orders DESC`, sc.params)).rows;
  return {
    communityRank: communities,
    campaignOutput: { campaigns: campaignCount, average: campaignCount ? Math.round(Number(totalNet) / campaignCount) : null, top: perCampaign },
    dataSources: camelize(sources),
  };
}

/** 廠商合作成功率（暫定口徑）：已開團檔期 ÷（已開團 ＋ 已取消）；評估中、籌備中的不計入分母 */
async function vendorSuccess({ db, sc }: ExtraCtx) {
  const n = sc.params.length;
  const rows = (await db.query(
    `SELECT v.id AS vendor_id, v.name,
            count(*) FILTER (WHERE c.status = ANY($${n + 1}::text[]))::int AS launched,
            count(*) FILTER (WHERE c.status = 'CANCELLED')::int AS cancelled
     FROM campaigns c JOIN vendors v ON v.id = c.vendor_id WHERE (${sc.sql})
     GROUP BY v.id, v.name HAVING count(*) FILTER (WHERE c.status = ANY($${n + 1}::text[]) OR c.status = 'CANCELLED') > 0
     ORDER BY launched DESC, v.name LIMIT 10`, [...sc.params, LAUNCHED_STATUSES])).rows;
  const by = rows.map((r) => ({ vendorId: r.vendor_id, name: r.name, launched: r.launched as number, cancelled: r.cancelled as number, rate: Math.round((r.launched / (r.launched + r.cancelled)) * 1000) / 10 }));
  const launched = by.reduce((s, r) => s + r.launched, 0), cancelled = by.reduce((s, r) => s + r.cancelled, 0);
  return { overall: launched + cancelled ? { launched, cancelled, rate: Math.round((launched / (launched + cancelled)) * 1000) / 10 } : null, byVendor: by };
}

/** 檔期準時開團率：已開團檔期中，實際轉為「進行中」的日期（台北）不晚於預定開團日。沒有轉換紀錄的檔期（例如直接匯入資料）不計 */
async function onTimeLaunch({ db, sc }: ExtraCtx) {
  const r = (await db.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE x.launched_on <= x.open_date)::int AS on_time FROM (
       SELECT c.id, c.open_date, (min(e.occurred_at) AT TIME ZONE 'Asia/Taipei')::date AS launched_on
       FROM campaigns c JOIN events e ON e.organization_id = c.organization_id AND e.type = 'campaign.status_changed' AND e.entity_id = c.id AND e.payload->>'to' = 'RUNNING'
       WHERE (${sc.sql}) AND c.open_date IS NOT NULL GROUP BY c.id, c.open_date) x`, sc.params)).rows[0];
  return { total: r.total as number, onTime: r.on_time as number, rate: r.total ? Math.round((r.on_time / r.total) * 1000) / 10 : null };
}

/** 商品復開績效：出現在 2 檔以上（不含已取消）的商品，與累計有效淨銷售額（依品項金額按訂單退款比例折算） */
async function productRepeat({ db, sc, showSales }: ExtraCtx) {
  const n = sc.params.length;
  const prods = (await db.query(
    `SELECT p.id AS product_id, p.name, count(DISTINCT cp.campaign_id)::int AS campaigns
     FROM campaign_products cp JOIN campaigns c ON c.id = cp.campaign_id JOIN products p ON p.id = cp.product_id
     WHERE (${sc.sql}) AND cp.deleted_at IS NULL AND c.status <> 'CANCELLED'
     GROUP BY p.id, p.name HAVING count(DISTINCT cp.campaign_id) >= 2 ORDER BY campaigns DESC, p.name LIMIT 8`, sc.params)).rows;
  const net = new Map<string, number>();
  if (showSales && prods.length) {
    const r = (await db.query(
      `SELECT s.product_id, coalesce(sum(oi.line_amount * (o.gross_amount - o.refund_amount)::numeric / NULLIF(o.gross_amount, 0)),0) AS net
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN campaigns c ON c.id = o.campaign_id JOIN skus s ON s.id = oi.sku_id
       WHERE (${sc.sql}) AND o.status = ANY($${n + 1}::text[]) AND s.product_id = ANY($${n + 2}::text[]) GROUP BY s.product_id`,
      [...sc.params, [...SALES_STATUSES], prods.map((x) => x.product_id)])).rows;
    for (const x of r) net.set(x.product_id, Math.round(Number(x.net)));
  }
  return prods.map((x) => {
    const total = showSales ? (net.get(x.product_id) ?? 0) : null;
    return { productId: x.product_id, name: x.name, campaigns: x.campaigns as number, net: total, avgPerCampaign: total == null ? null : Math.round(total / x.campaigns) };
  });
}

export interface AttentionItem {
  kind: 'OVERDUE' | 'WAITING_HOST' | 'EXCEPTION' | 'NO_ORDER_DATA' | 'PENDING_APPROVAL';
  chip: string;
  tone: 'danger' | 'warn' | 'info';
  title: string;
  detail: string;
  urgency: number;
  href: string;
}

/** 營運異常與待辦：把逾期任務、團主未回覆、未結例外、結單後缺訂單資料、待核准彙成一張依緊急程度排序的清單 */
async function attention(ctx: ExtraCtx): Promise<AttentionItem[]> {
  const { db, actor, sc, today } = ctx;
  const n = sc.params.length;
  const items: AttentionItem[] = [];

  const overdue = (await db.query(
    `SELECT t.id, t.name, t.campaign_id, c.title, v.name AS vendor_name, t.planned_end, t.owner_role, ${CAMPAIGN_HOSTS_JSON} AS hosts, ($${n + 1}::date - t.planned_end)::int AS days_late
     FROM tasks t JOIN campaigns c ON c.id = t.campaign_id JOIN vendors v ON v.id = c.vendor_id
     WHERE (${sc.sql}) AND c.status NOT IN ('CANCELLED','ON_HOLD','CLOSED') AND t.status IN ('TODO','IN_PROGRESS','BLOCKED','WAITING_APPROVAL') AND t.planned_end < $${n + 1}::date
     ORDER BY t.planned_end LIMIT 15`, [...sc.params, today])).rows;
  for (const t of overdue) {
    items.push({ kind: 'OVERDUE', chip: '逾期', tone: 'danger', title: `${t.vendor_name}｜${t.name}逾期`,
      detail: `${t.title}（團主：${hostNames(t.hosts)}）預定 ${t.planned_end}，已逾期 ${t.days_late} 天`, urgency: 100 + Math.min(t.days_late, 60), href: `/campaigns/${t.campaign_id}?tab=tasks` });
  }

  const waiting = (await db.query(
    `SELECT c.id AS campaign_id, c.title, v.name AS vendor_name, h.display_name AS host_name, ch.status, ($${n + 1}::date - (ch.invited_at AT TIME ZONE 'Asia/Taipei')::date)::int AS days
     FROM campaign_hosts ch JOIN campaigns c ON c.id = ch.campaign_id JOIN vendors v ON v.id = c.vendor_id JOIN hosts h ON h.id = ch.host_id
     WHERE (${sc.sql}) AND ch.deleted_at IS NULL AND ch.status IN ('INVITED','NO_RESPONSE') AND c.status IN ('DRAFT','EVALUATING','PENDING_G1','PREPARING','PENDING_G2','SCHEDULED')
     ORDER BY ch.invited_at LIMIT 15`, [...sc.params, today])).rows;
  for (const w of waiting) {
    items.push({ kind: 'WAITING_HOST', chip: '待回覆', tone: 'warn', title: `${w.vendor_name}｜待確認團主回覆`,
      detail: `${w.host_name}尚未回覆「${w.title}」的邀請（已 ${Math.max(w.days, 0)} 天），無法排定檔期`, urgency: 60 + Math.min(Math.max(w.days, 0), 30), href: `/campaigns/${w.campaign_id}?tab=hosts` });
  }

  if (can(actor, 'exception.read')) {
    const ex = (await db.query(
      `SELECT e.id, e.title, e.detail, e.severity, e.campaign_id, v.name AS vendor_name
       FROM exceptions e LEFT JOIN campaigns c ON c.id = e.campaign_id LEFT JOIN vendors v ON v.id = c.vendor_id
       WHERE e.organization_id = $1 AND e.status <> 'RESOLVED' AND e.type NOT IN ('TASK_OVERDUE', 'HOST_NO_RESPONSE')   -- 這兩類已分別以「逾期」「待回覆」列出，不重複
         AND (e.campaign_id IS NULL OR (${sc.sql.replace(/\$1\b/, '$1')}))
       ORDER BY e.detected_at DESC LIMIT 15`, sc.params)).rows;
    for (const e of ex) {
      const base = e.severity === 'HIGH' ? 90 : e.severity === 'MEDIUM' ? 50 : 20;
      items.push({ kind: 'EXCEPTION', chip: '異常', tone: e.severity === 'HIGH' ? 'danger' : 'warn', title: `${e.vendor_name ?? '系統'}｜${e.title}`,
        detail: e.detail ?? '', urgency: base, href: '/exceptions' });
    }
  }

  const noOrders = (await db.query(
    `SELECT c.id AS campaign_id, c.title, v.name AS vendor_name FROM campaigns c JOIN vendors v ON v.id = c.vendor_id
     WHERE (${sc.sql}) AND c.status = ANY($${n + 1}::text[]) AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.campaign_id = c.id) LIMIT 15`,
    [...sc.params, SHOULD_HAVE_ORDERS])).rows;
  for (const x of noOrders) {
    items.push({ kind: 'NO_ORDER_DATA', chip: '資料缺漏', tone: 'danger', title: `${x.vendor_name}｜結團後尚無訂單資料`,
      detail: `${x.title}：請匯入訂單，否則無法結算與計算業績`, urgency: 80, href: '/imports' });
  }

  const pend = (await db.query(
    `SELECT a.id, a.gate_key, c.id AS campaign_id, c.title, v.name AS vendor_name, ($${n + 1}::date - (a.requested_at AT TIME ZONE 'Asia/Taipei')::date)::int AS days
     FROM approvals a JOIN campaigns c ON c.id = a.campaign_id JOIN vendors v ON v.id = c.vendor_id
     WHERE (${sc.sql}) AND a.status = 'PENDING' ORDER BY a.requested_at LIMIT 15`, [...sc.params, today])).rows;
  for (const a of pend) {
    items.push({ kind: 'PENDING_APPROVAL', chip: '待審核', tone: 'info', title: `${a.vendor_name}｜待核准 ${a.gate_key}`,
      detail: `${a.title} 已等待 ${Math.max(a.days, 0)} 天`, urgency: 70 + Math.min(Math.max(a.days, 0), 20), href: `/campaigns/${a.campaign_id}?tab=approvals` });
  }

  // 每一類最多 5 筆：避免大量逾期任務把其他類型（待回覆、異常、缺資料）全部擠掉
  const perKind = new Map<string, number>();
  const picked = items.sort((x, y) => y.urgency - x.urgency).filter((a) => { const c = (perKind.get(a.kind) ?? 0) + 1; perKind.set(a.kind, c); return c <= 5; });
  return picked.slice(0, 12);
}

export async function adminExtras(ctx: ExtraCtx) {
  const [ov, fin, vs, ot, pr, att] = await Promise.all([overview(ctx), financeKpis(ctx), vendorSuccess(ctx), onTimeLaunch(ctx), productRepeat(ctx), attention(ctx)]);
  const sales = ctx.showSales ? await salesBreakdowns(ctx) : null;
  return {
    overview: ov,
    finance: fin,
    communityRank: sales?.communityRank ?? null,
    campaignOutput: sales?.campaignOutput ?? null,
    dataSources: sales?.dataSources ?? null,
    vendorSuccess: vs,
    onTimeLaunch: ot,
    productRepeat: pr,
    attention: att,
  };
}
