import { z } from 'zod';
import type { Tx } from '../lib/db';
import { pool, query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { requirePerm } from '../lib/permissions';
import { forbidden, notFound, precondition, validation, conflict } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids } from '../lib/ids';
import { camelize } from '../lib/case';
import { idempotent } from '../lib/idempotency';
import { campaignScope } from '../lib/scope';
import { campaignHostCommission, type HostCommissionCalc } from '../lib/commission-calc';
import { dataStatus } from '../lib/kpi';
import { listPaged, pageParams } from '../lib/repo';
import { isIsoDate } from '../lib/dates';

/**
 * 結算試算（Phase 2）。以檔期為單位；金額只重用 Phase 1 的預估佣金口徑（lib/commission-calc.ts），
 * 沒有任何新費率或扣項公式。人工調整只能走「覆寫（必填原因）」與「調整項（append-only、必填原因）」。
 * 所有結果都是「試算，口徑待 Owner 確認；非正式付款依據」。
 */
export const SETTLEMENT_NOTICE = '試算，口徑待 Owner 確認；非正式付款依據';

/** 可以開結算試算的檔期狀態（已開賣之後；草稿／籌備中／取消／暫緩沒有可試算的訂單） */
const SETTLEABLE = ['RUNNING', 'PENDING_CLOSE_CHECK', 'FULFILLING', 'PENDING_SETTLEMENT', 'SETTLED', 'CLOSED'];

const createSchema = z.object({
  campaignId: z.string().trim().min(1),
  note: z.string().trim().max(500).optional(),
  periodStart: z.string().refine(isIsoDate, '日期格式需為 YYYY-MM-DD').optional(),
  periodEnd: z.string().refine(isIsoDate, '日期格式需為 YYYY-MM-DD').optional(),
});

const MAX_AMOUNT = 1_000_000_000_000;
const amountInt = z.number().int('金額需為整數').min(-MAX_AMOUNT).max(MAX_AMOUNT);

interface ItemRow {
  id: string; settlement_id: string; campaign_id: string; host_id: string; host_name: string;
  net_sales: number | null; commission_auto: number | null; commission_override: number | null; override_reason: string | null;
  rate_percent: number | null; rule_id: string | null; rule_version: number | null;
}

async function campaignInScope(db: Tx | ReturnType<typeof pool>, actor: Actor, campaignId: string) {
  const sc = campaignScope(actor, 1, 'c');
  if (sc.sql === 'FALSE') throw forbidden();
  const r = await db.query(`SELECT c.id, c.title, c.status FROM campaigns c WHERE (${sc.sql}) AND c.id=$${sc.params.length + 1}`, [...sc.params, campaignId]);
  if (!r.rows[0]) throw notFound('檔期');
  return r.rows[0] as { id: string; title: string; status: string };
}

async function dataBasis(db: Tx, orgId: string, campaignId: string): Promise<{ dataAsOf: string | null; dataStatus: string }> {
  const o = await db.query<{ origins: string[] | null; last_order: Date | null }>(
    `SELECT array_agg(DISTINCT data_origin) AS origins, max(ordered_at) AS last_order FROM orders WHERE organization_id=$1 AND campaign_id=$2`, [orgId, campaignId]);
  const b = await db.query<{ asof: Date | null }>(
    `SELECT max(b.data_as_of) AS asof FROM import_batches b WHERE b.organization_id=$1 AND b.id IN (SELECT DISTINCT import_batch_id FROM orders WHERE organization_id=$1 AND campaign_id=$2 AND import_batch_id IS NOT NULL)`, [orgId, campaignId]);
  const asOf = b.rows[0]?.asof ?? o.rows[0]?.last_order ?? null;
  return { dataAsOf: asOf ? new Date(asOf).toISOString() : null, dataStatus: dataStatus(o.rows[0]?.origins ?? []) };
}

/** 試算所用規則版本的快照文字，寫進 settlements.rule_version_note */
export function ruleVersionNote(calc: HostCommissionCalc[]): string {
  if (!calc.length) return '無團主';
  return calc.map((c) => `${c.hostId}：${c.ruleId ? `${c.ruleId} v${c.ruleVersion ?? '?'}（${c.ratePercent}%）` : '無適用規則'}`).join('；');
}

function itemSig(i: { net_sales: number | null; commission_auto: number | null; rule_id: string | null }) {
  return `${i.net_sales ?? 'n'}|${i.commission_auto ?? 'n'}|${i.rule_id ?? 'n'}`;
}
function calcSig(c: HostCommissionCalc) {
  return `${c.netSales}|${c.commissionAuto ?? 'n'}|${c.ruleId ?? 'n'}`;
}

async function insertItem(tx: Tx, actor: Actor, settlementId: string, campaignId: string, c: HostCommissionCalc) {
  const id = await ids.settlementItem(tx);
  await tx.query(
    `INSERT INTO settlement_items (id, organization_id, settlement_id, campaign_id, host_id, net_sales, commission_auto, rate_percent, rule_id, rule_version, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, actor.orgId, settlementId, campaignId, c.hostId, c.netSales, c.commissionAuto, c.ratePercent, c.ruleId, c.ruleVersion, actor.userId]);
  return id;
}

export async function createSettlement(actor: Actor, raw: z.input<typeof createSchema>, idemKey?: string | null) {
  requirePerm(actor, 'finance.write');
  const input = createSchema.parse(raw);
  if (input.periodStart && input.periodEnd && input.periodEnd < input.periodStart) throw validation('期間結束日不可早於開始日');
  const camp = await campaignInScope(pool(), actor, input.campaignId);
  if (!SETTLEABLE.includes(camp.status)) throw precondition(`檔期狀態為「${camp.status}」，尚未進入可試算的階段（需已開賣）`);
  return withTx(async (tx) => {
    const { result, replayed } = await idempotent(tx, actor, 'settlement.create', idemKey, async () => {
      const live = await tx.query(`SELECT id, status FROM settlements WHERE organization_id=$1 AND campaign_id=$2 AND status IN ('DRAFT','CONFIRMED')`, [actor.orgId, input.campaignId]);
      if (live.rowCount) throw conflict(`此檔期已有${live.rows[0].status === 'DRAFT' ? '草稿' : '已確認'}的結算 ${live.rows[0].id}；如需重開請先作廢`);
      const calc = await campaignHostCommission(tx, actor.orgId, input.campaignId);
      const basis = await dataBasis(tx, actor.orgId, input.campaignId);
      const id = await ids.settlement(tx);
      await tx.query(
        `INSERT INTO settlements (id, organization_id, status, campaign_id, period_start, period_end, rule_version_note, note, data_as_of, data_status, created_by)
         VALUES ($1,$2,'DRAFT',$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, actor.orgId, input.campaignId, input.periodStart ?? null, input.periodEnd ?? null, ruleVersionNote(calc), input.note ?? null, basis.dataAsOf, basis.dataStatus, actor.userId]);
      for (const c of calc) await insertItem(tx, actor, id, input.campaignId, c);
      await audit(tx, actor, { action: 'settlement.create', entityType: 'settlement', entityId: id, campaignId: input.campaignId, after: { status: 'DRAFT', items: calc.length, dataStatus: basis.dataStatus, dataAsOf: basis.dataAsOf } });
      return { id };
    }, input);
    return { ...result, replayed };
  });
}

/** 重新試算（只限草稿）：用最新訂單與規則重算淨銷售與試算佣金；覆寫與調整項保留不動 */
export async function recalculateSettlement(actor: Actor, id: string) {
  requirePerm(actor, 'finance.write');
  return withTx(async (tx) => {
    const s = await lockSettlement(tx, actor, id);
    if (s.status !== 'DRAFT') throw precondition('只有草稿可以重新試算');
    const calc = await campaignHostCommission(tx, actor.orgId, s.campaign_id);
    const basis = await dataBasis(tx, actor.orgId, s.campaign_id);
    const cur = (await tx.query<ItemRow>(`SELECT * FROM settlement_items WHERE settlement_id=$1`, [id])).rows;
    let changed = 0;
    for (const c of calc) {
      const it = cur.find((x) => x.host_id === c.hostId);
      if (!it) { await insertItem(tx, actor, id, s.campaign_id, c); changed++; continue; }
      if (itemSig(it) !== calcSig(c)) {
        await tx.query(`UPDATE settlement_items SET net_sales=$2, commission_auto=$3, rate_percent=$4, rule_id=$5, rule_version=$6, updated_at=now(), updated_by=$7 WHERE id=$1`,
          [it.id, c.netSales, c.commissionAuto, c.ratePercent, c.ruleId, c.ruleVersion, actor.userId]);
        changed++;
      }
    }
    for (const it of cur) {
      if (calc.some((c) => c.hostId === it.host_id)) continue;
      if ((it.net_sales ?? 0) !== 0 || (it.commission_auto ?? 0) !== 0) {
        await tx.query(`UPDATE settlement_items SET net_sales=0, commission_auto=0, rate_percent=NULL, rule_id=NULL, rule_version=NULL, updated_at=now(), updated_by=$2 WHERE id=$1`, [it.id, actor.userId]);
        changed++;
      }
    }
    await tx.query(`UPDATE settlements SET rule_version_note=$2, data_as_of=$3, data_status=$4 WHERE id=$1`, [id, ruleVersionNote(calc), basis.dataAsOf, basis.dataStatus]);
    await audit(tx, actor, { action: 'settlement.recalculate', entityType: 'settlement', entityId: id, campaignId: s.campaign_id, after: { changedItems: changed, dataStatus: basis.dataStatus, dataAsOf: basis.dataAsOf } });
    return { id, changedItems: changed };
  });
}

interface LockedSettlement { id: string; campaign_id: string; status: string; version: number }
async function lockSettlement(tx: Tx, actor: Actor, id: string): Promise<LockedSettlement> {
  const r = await tx.query<LockedSettlement>(`SELECT id, campaign_id, status, version FROM settlements WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [id, actor.orgId]);
  if (!r.rows[0]) throw notFound('結算');
  const sc = campaignScope(actor, 1, 'c');
  if (sc.sql === 'FALSE') throw forbidden();
  const ok = await tx.query(`SELECT 1 FROM campaigns c WHERE (${sc.sql}) AND c.id=$${sc.params.length + 1}`, [...sc.params, r.rows[0].campaign_id]);
  if (!ok.rowCount) throw notFound('結算');
  return r.rows[0];
}

export async function setItemOverride(actor: Actor, itemId: string, raw: { amount: number | null; reason?: string }) {
  requirePerm(actor, 'finance.write');
  const b = z.object({ amount: amountInt.min(0, '覆寫金額不可為負數（需要增減請用調整項）').nullable(), reason: z.string().trim().max(500).optional() }).parse(raw);
  if (b.amount != null && !b.reason) throw validation('覆寫佣金必須填寫原因');
  return withTx(async (tx) => {
    const it = (await tx.query<ItemRow & { settlement_id: string }>(`SELECT * FROM settlement_items WHERE id=$1 AND organization_id=$2`, [itemId, actor.orgId])).rows[0];
    if (!it) throw notFound('結算項目');
    const s = await lockSettlement(tx, actor, it.settlement_id);
    if (s.status !== 'DRAFT') throw precondition('結算已確認或作廢，項目已鎖定，不可覆寫');
    await tx.query(`UPDATE settlement_items SET commission_override=$2, override_reason=$3, updated_at=now(), updated_by=$4 WHERE id=$1`,
      [itemId, b.amount, b.amount == null ? null : b.reason, actor.userId]);
    await audit(tx, actor, {
      action: b.amount == null ? 'settlement_item.override_clear' : 'settlement_item.override', entityType: 'settlement_item', entityId: itemId, campaignId: s.campaign_id,
      before: { commissionOverride: it.commission_override, overrideReason: it.override_reason }, after: { commissionOverride: b.amount, overrideReason: b.reason ?? null }, reason: b.reason ?? null,
    });
    return { id: itemId, commissionOverride: b.amount };
  });
}

export async function addAdjustment(actor: Actor, settlementId: string, raw: { itemId: string; amount: number; reason: string }) {
  requirePerm(actor, 'finance.write');
  const b = z.object({ itemId: z.string().min(1), amount: amountInt.refine((n) => n !== 0, '調整金額不可為 0'), reason: z.string().trim().min(1, '調整必須填寫原因').max(500) }).parse(raw);
  return withTx(async (tx) => {
    const s = await lockSettlement(tx, actor, settlementId);
    if (s.status !== 'DRAFT') throw precondition('結算已確認或作廢，不可再新增調整項');
    const it = await tx.query(`SELECT id FROM settlement_items WHERE id=$1 AND settlement_id=$2`, [b.itemId, settlementId]);
    if (!it.rowCount) throw notFound('結算項目');
    const id = await ids.settlementAdjustment(tx);
    await tx.query(`INSERT INTO settlement_adjustments (id, organization_id, settlement_id, item_id, amount, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, actor.orgId, settlementId, b.itemId, b.amount, b.reason, actor.userId]);
    await audit(tx, actor, { action: 'settlement.adjustment', entityType: 'settlement_adjustment', entityId: id, campaignId: s.campaign_id, after: { settlementId, itemId: b.itemId, amount: b.amount }, reason: b.reason });
    return { id };
  });
}

function baseOf(i: { commission_override: number | null; commission_auto: number | null }): number | null {
  return i.commission_override ?? i.commission_auto;
}

export async function confirmSettlement(actor: Actor, id: string, raw: { note?: string } = {}) {
  requirePerm(actor, 'settlement.confirm');
  const b = z.object({ note: z.string().trim().max(500).optional() }).parse(raw ?? {});
  return withTx(async (tx) => {
    const s = await lockSettlement(tx, actor, id);
    if (s.status !== 'DRAFT') throw precondition('只有草稿可以確認');
    const items = (await tx.query<ItemRow>(`SELECT i.*, h.display_name AS host_name FROM settlement_items i JOIN hosts h ON h.id=i.host_id WHERE i.settlement_id=$1 ORDER BY i.host_id`, [id])).rows;
    if (!items.length) throw precondition('此結算沒有任何團主項目，無法確認');
    const calc = await campaignHostCommission(tx, actor.orgId, s.campaign_id);
    const stale = calc.length !== items.length || calc.some((c) => { const it = items.find((x) => x.host_id === c.hostId); return !it || itemSig(it) !== calcSig(c); });
    if (stale) throw precondition('訂單資料或佣金規則在試算後有變動，請先「重新試算」再確認', { code: 'STALE_CALCULATION' });
    const missing = items.filter((i) => baseOf(i) == null);
    if (missing.length) throw precondition(`尚有團主沒有可用的佣金金額（未設定費率且未覆寫）：${missing.map((m) => m.host_name).join('、')}`, { hostIds: missing.map((m) => m.host_id) });
    const basis = await dataBasis(tx, actor.orgId, s.campaign_id);
    const note = ruleVersionNote(calc);
    await tx.query(`UPDATE settlements SET status='CONFIRMED', confirmed_at=now(), confirmed_by=$2, rule_version_note=$3, data_as_of=$4, data_status=$5, note=COALESCE($6, note) WHERE id=$1`,
      [id, actor.userId, note, basis.dataAsOf, basis.dataStatus, b.note ?? null]);
    await audit(tx, actor, { action: 'settlement.confirm', entityType: 'settlement', entityId: id, campaignId: s.campaign_id, before: { status: 'DRAFT' }, after: { status: 'CONFIRMED', ruleVersionNote: note, dataAsOf: basis.dataAsOf, dataStatus: basis.dataStatus }, reason: b.note ?? null });
    return { id, status: 'CONFIRMED' as const, dataAsOf: basis.dataAsOf, ruleVersionNote: note };
  });
}

export async function voidSettlement(actor: Actor, id: string, reason: string) {
  const why = z.string().trim().min(1, '作廢必須填寫原因').max(500).parse(reason ?? '');
  requirePerm(actor, 'finance.write');
  return withTx(async (tx) => {
    const s = await lockSettlement(tx, actor, id);
    if (s.status === 'VOID') throw precondition('此結算已作廢');
    if (s.status === 'CONFIRMED') requirePerm(actor, 'settlement.confirm');
    const linked = await tx.query(
      `SELECT count(*)::int AS n FROM payments p JOIN settlement_items i ON i.id=p.settlement_item_id WHERE i.settlement_id=$1 AND p.status='ACTIVE' AND p.match_status='MATCHED'`, [id]);
    if (linked.rows[0].n > 0) throw precondition(`有 ${linked.rows[0].n} 筆已核對的入帳關聯到此結算，請先取消核對再作廢`);
    await tx.query(`UPDATE settlements SET status='VOID', voided_at=now(), voided_by=$2, void_reason=$3 WHERE id=$1`, [id, actor.userId, why]);
    await audit(tx, actor, { action: 'settlement.void', entityType: 'settlement', entityId: id, campaignId: s.campaign_id, before: { status: s.status }, after: { status: 'VOID' }, reason: why });
    return { id, status: 'VOID' as const };
  });
}

export async function listSettlements(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'finance.read');
  const sc = campaignScope(actor, 1, 'c');
  if (sc.sql === 'FALSE') throw forbidden();
  const params = [...sc.params];
  const where = [`(${sc.sql})`, `s.organization_id=$1`];
  const st = q.get('status'); if (st) { params.push(st); where.push(`s.status=$${params.length}`); }
  const cid = q.get('campaignId'); if (cid) { params.push(cid); where.push(`s.campaign_id=$${params.length}`); }
  const base = `SELECT s.id, s.status, s.campaign_id, c.title AS campaign_title, s.data_status, s.data_as_of, s.created_at, s.confirmed_at,
      (SELECT count(*)::int FROM settlement_items i WHERE i.settlement_id=s.id) AS item_count,
      (SELECT coalesce(sum(i.net_sales),0) FROM settlement_items i WHERE i.settlement_id=s.id) AS net_sales_total
    FROM settlements s JOIN campaigns c ON c.id=s.campaign_id WHERE ${where.join(' AND ')}`;
  const r = await listPaged(base, params, 's.created_at DESC, s.id DESC', pageParams(q));
  return { ...camelize<Record<string, unknown>>(r), notice: SETTLEMENT_NOTICE };
}

export interface ItemView {
  id: string; hostId: string; hostName: string; netSales: number | null; ratePercent: number | null; ruleId: string | null; ruleVersion: number | null;
  commissionAuto: number | null; commissionOverride: number | null; overrideReason: string | null; adjustmentTotal: number; commissionBase: number | null; commissionFinal: number | null;
}

export async function getSettlement(actor: Actor, id: string) {
  requirePerm(actor, 'finance.read');
  const sc = campaignScope(actor, 1, 'c');
  if (sc.sql === 'FALSE') throw forbidden();
  const sRow = (await query(
    `SELECT s.*, c.title AS campaign_title, c.status AS campaign_status FROM settlements s JOIN campaigns c ON c.id=s.campaign_id
     WHERE (${sc.sql}) AND s.id=$${sc.params.length + 1}`, [...sc.params, id]))[0];
  if (!sRow) throw notFound('結算');
  const items = await query<ItemRow>(`SELECT i.*, h.display_name AS host_name FROM settlement_items i JOIN hosts h ON h.id=i.host_id WHERE i.settlement_id=$1 ORDER BY i.host_id`, [id]);
  const adjustments = await query<{ id: string; item_id: string; amount: number; reason: string; created_at: Date; created_by: string | null }>(
    `SELECT a.id, a.item_id, a.amount, a.reason, a.created_at, a.created_by, u.name AS created_by_name FROM settlement_adjustments a LEFT JOIN users u ON u.id=a.created_by WHERE a.settlement_id=$1 ORDER BY a.created_at, a.id`, [id]);
  const itemViews: ItemView[] = items.map((i) => {
    const adj = adjustments.filter((a) => a.item_id === i.id).reduce((s, a) => s + Number(a.amount), 0);
    const base = baseOf(i);
    return {
      id: i.id, hostId: i.host_id, hostName: i.host_name, netSales: i.net_sales, ratePercent: i.rate_percent, ruleId: i.rule_id, ruleVersion: i.rule_version,
      commissionAuto: i.commission_auto, commissionOverride: i.commission_override, overrideReason: i.override_reason, adjustmentTotal: adj,
      commissionBase: base, commissionFinal: base == null ? null : base + adj,
    };
  });
  // 草稿：偵測資料是否在試算後變動
  let stale = false;
  if (sRow.status === 'DRAFT') {
    const calc = await campaignHostCommission(pool(), actor.orgId, sRow.campaign_id);
    stale = calc.length !== items.length || calc.some((c) => { const it = items.find((x) => x.host_id === c.hostId); return !it || itemSig(it) !== calcSig(c); });
  }
  const totals = await query<{ net_all: number; net_attr: number }>(
    `SELECT coalesce((SELECT sum(o.gross_amount - o.refund_amount) FROM orders o WHERE o.organization_id=$1 AND o.campaign_id=$2 AND o.status IN ('PAID','PARTIAL_REFUND','REFUNDED')),0) AS net_all,
            coalesce((SELECT sum((o.gross_amount - o.refund_amount) * a.share_percent / 100.0) FROM orders o JOIN attributions a ON a.order_id=o.id WHERE o.organization_id=$1 AND o.campaign_id=$2 AND o.status IN ('PAID','PARTIAL_REFUND','REFUNDED')),0) AS net_attr`,
    [actor.orgId, sRow.campaign_id]);
  const finals = itemViews.filter((i) => i.commissionFinal != null);
  const linkedPayments = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM payments p JOIN settlement_items i ON i.id=p.settlement_item_id WHERE i.settlement_id=$1 AND p.status='ACTIVE'`, [id]);
  const { organization_id: _o, ...settlement } = sRow as Record<string, unknown>;
  return {
    notice: SETTLEMENT_NOTICE,
    settlement: camelize<Record<string, unknown>>(settlement),
    items: itemViews,
    adjustments: camelize<Record<string, unknown>[]>(adjustments),
    stale,
    totals: {
      netSales: itemViews.reduce((s, i) => s + (i.netSales ?? 0), 0),
      commissionFinal: finals.reduce((s, i) => s + (i.commissionFinal ?? 0), 0),
      itemsWithoutAmount: itemViews.length - finals.length,
      campaignNetSales: Number(totals[0].net_all),
      unattributedNetSales: Math.round(Number(totals[0].net_all) - Number(totals[0].net_attr)),
      linkedPayments: linkedPayments[0].n,
    },
  };
}

/** 團主只能看自己、且已確認的結算項摘要：不含其他團主、調整原因、覆寫原因、費用、入帳、發票 */
export async function mySettlementItems(actor: Actor) {
  requirePerm(actor, 'commission.read');
  if (actor.role !== 'HOST' || !actor.hostIds.length) throw forbidden();
  const rows = await query<{ settlement_id: string; campaign_id: string; campaign_title: string; confirmed_at: Date; net_sales: number | null; rate_percent: number | null; base: number | null; adj: number }>(
    `SELECT s.id AS settlement_id, s.campaign_id, c.title AS campaign_title, s.confirmed_at, i.net_sales, i.rate_percent,
       COALESCE(i.commission_override, i.commission_auto) AS base,
       coalesce((SELECT sum(a.amount) FROM settlement_adjustments a WHERE a.item_id=i.id),0) AS adj
     FROM settlement_items i JOIN settlements s ON s.id=i.settlement_id JOIN campaigns c ON c.id=s.campaign_id
     WHERE i.organization_id=$1 AND i.host_id = ANY($2::text[]) AND s.status='CONFIRMED' ORDER BY s.confirmed_at DESC, s.id`, [actor.orgId, actor.hostIds]);
  return {
    notice: SETTLEMENT_NOTICE,
    items: rows.map((r) => ({
      settlementId: r.settlement_id, campaignId: r.campaign_id, campaignTitle: r.campaign_title, confirmedAt: r.confirmed_at,
      netSales: r.net_sales, ratePercent: r.rate_percent, commission: r.base == null ? null : Number(r.base) + Number(r.adj),
    })),
  };
}
