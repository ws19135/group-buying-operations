import { z } from 'zod';
import type { Queryable } from '../lib/db';
import { pool, query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, requirePerm } from '../lib/permissions';
import { forbidden, notFound, precondition, validation } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids, todayTaipei } from '../lib/ids';
import { camelize } from '../lib/case';
import { campaignScope } from '../lib/scope';
import { SALES_STATUSES } from '../lib/kpi';
import {
  INPUT_LABEL, NON_SENSITIVE_INPUT_KEYS, SENSITIVE_INPUT_KEYS, SOURCE_KINDS, calcFeasibility, feasibilityInputSchema, maskInputs, maskResults, touchesSensitiveInputs,
  type FeasibilityInputs,
} from '../lib/feasibility-calc';
import { assertCampaignVisible, assertNoPii, campaignVisible, evidenceFor, loadProductBasic, loadSelectionConfig, mapDbError } from './selection';
import { maskEvidenceList } from './evidence';

/**
 * SOP 03 商業可行性試算。純計算在 lib/feasibility-calc.ts；這裡負責版本、假設來源、敏感欄位權限、小規模測試團實際回寫。
 * 口徑沿用 docs/biz-model/04（待 Owner 確認）：GMV、有效淨銷售額、品牌利潤、公司營業收入是四個不同的數字；缺少的輸入就是「未知」，不捏造。
 */
const sourceEntry = z.object({ kind: z.enum(SOURCE_KINDS), note: z.string().trim().max(200).nullable().optional() }).strict();
export const feasibilityCreateSchema = z.object({
  campaignId: z.string().max(40).nullable().optional(),
  hostId: z.string().max(40).nullable().optional(),
  trialId: z.string().max(40).nullable().optional(),
  label: z.string().trim().max(100).nullable().optional(),
  inputs: feasibilityInputSchema,
  sources: z.record(sourceEntry).optional(),
}).strict();

const isSensitiveKey = (k: string) => (SENSITIVE_INPUT_KEYS as readonly string[]).includes(k);

function maskSources(sources: Record<string, unknown>, canCost: boolean): Record<string, unknown> {
  if (canCost) return sources;
  return Object.fromEntries(Object.entries(sources).filter(([k]) => !isSensitiveKey(k)));
}

interface ScenarioRow { id: string; product_id: string; campaign_id: string | null; host_id: string | null; trial_id: string | null; version_no: number; label: string | null;
  inputs: Record<string, unknown>; sources: Record<string, { kind: string; note?: string | null }>; results: Record<string, unknown>; actuals: Record<string, unknown> | null; actuals_at: string | null; [k: string]: unknown }

export interface FeasibilityView extends Record<string, unknown> { id: string; versionNo: number; label: string | null; inputs: Record<string, unknown>; sources: Record<string, unknown>; results: Record<string, unknown>; restricted: boolean }
function present(r: ScenarioRow & Record<string, unknown>, canCost: boolean): FeasibilityView {
  const c = camelize<Record<string, unknown>>(r);
  return { ...c, id: r.id, versionNo: r.version_no, label: r.label, inputs: maskInputs(r.inputs, canCost), sources: maskSources(r.sources, canCost), results: maskResults(r.results, canCost), restricted: !canCost };
}

const SELECT_SC = `SELECT f.*, c.title AS campaign_title, h.display_name AS host_name, u.name AS created_by_name FROM feasibility_scenarios f
  LEFT JOIN campaigns c ON c.id=f.campaign_id LEFT JOIN hosts h ON h.id=f.host_id LEFT JOIN users u ON u.id=f.created_by`;

/** 商品主檔的價格與成本範圍，只當作填寫時的參考（不自動帶入）；成本需成本檢視權限 */
async function referenceFor(db: Queryable, orgId: string, productId: string, canCost: boolean) {
  const r = await db.query<{ gmin: number | null; gmax: number | null; cmin: number | null; cmax: number | null; n: number }>(
    `SELECT min(group_price) AS gmin, max(group_price) AS gmax, min(cost_price) AS cmin, max(cost_price) AS cmax, count(*)::int AS n FROM skus WHERE product_id=$1 AND organization_id=$2 AND deleted_at IS NULL AND status='ACTIVE'`, [productId, orgId]);
  const x = r.rows[0];
  return { skuCount: Number(x.n), groupPriceMin: x.gmin == null ? null : Number(x.gmin), groupPriceMax: x.gmax == null ? null : Number(x.gmax),
    costMin: canCost && x.cmin != null ? Number(x.cmin) : null, costMax: canCost && x.cmax != null ? Number(x.cmax) : null, note: '來自商品主檔，僅供填寫參考；請自行確認後再填入並註明假設來源' };
}

export async function listProductFeasibility(actor: Actor, productId: string) {
  requirePerm(actor, 'selection.read');
  const p = await loadProductBasic(pool(), actor.orgId, productId);
  const canCost = can(actor, 'product.cost.read');
  const sc = campaignScope(actor, 3, 'c2');
  const scope = sc.sql === 'FALSE' ? 'f.campaign_id IS NULL' : `(f.campaign_id IS NULL OR EXISTS (SELECT 1 FROM campaigns c2 WHERE c2.id=f.campaign_id AND (${sc.sql})))`;
  const rows = await query(`${SELECT_SC} WHERE f.organization_id=$1 AND f.product_id=$2 AND ${scope} ORDER BY f.created_at DESC, f.id DESC LIMIT 100`, [actor.orgId, productId, ...sc.params]);
  return {
    productId, productName: p.name, canSeeSensitive: canCost, items: (rows as ScenarioRow[]).map((r) => present(r as never, canCost)),
    reference: await referenceFor(pool(), actor.orgId, productId, canCost),
    inputLabels: INPUT_LABEL, sensitiveKeys: canCost ? [] : [...SENSITIVE_INPUT_KEYS], editableKeys: canCost ? [...NON_SENSITIVE_INPUT_KEYS, ...SENSITIVE_INPUT_KEYS] : [...NON_SENSITIVE_INPUT_KEYS],
    basisNote: '試算：口徑待 Owner 確認（docs/biz-model/04）。GMV 不等於公司收入；缺少的輸入顯示為「未知」，不會被當成 0。',
  };
}

export async function getFeasibility(actor: Actor, id: string) {
  requirePerm(actor, 'selection.read');
  const rows = await query(`${SELECT_SC} WHERE f.id=$1 AND f.organization_id=$2`, [id, actor.orgId]);
  if (!rows.length) throw notFound('可行性情境');
  const r = rows[0] as ScenarioRow;
  if (!(await campaignVisible(actor, r.campaign_id))) throw notFound('可行性情境');
  const canCost = can(actor, 'product.cost.read');
  const cfg = await loadSelectionConfig(pool(), actor.orgId);
  const ev = await evidenceFor(pool(), actor.orgId, 'FEASIBILITY', [id], todayTaipei(), cfg.expiringSoonDays);
  const versions = await query(
    `SELECT id, version_no, label, created_at FROM feasibility_scenarios WHERE product_id=$1 AND coalesce(campaign_id,'')=coalesce($2,'') AND coalesce(host_id,'')=coalesce($3,'') ORDER BY version_no DESC LIMIT 20`,
    [r.product_id, r.campaign_id, r.host_id]);
  return { ...present(r as never, canCost), evidence: maskEvidenceList(ev.get(id) ?? [], canCost), versions: camelize(versions), inputLabels: INPUT_LABEL };
}

export async function createFeasibility(actor: Actor, productId: string, raw: z.input<typeof feasibilityCreateSchema>) {
  requirePerm(actor, 'selection.write');
  const input = feasibilityCreateSchema.parse(raw);
  assertNoPii({ 標籤: input.label, ...Object.fromEntries(Object.entries(input.sources ?? {}).map(([k, v]) => [`來源說明 ${k}`, v.note])) });
  const canCost = can(actor, 'product.cost.read');
  const providedKeys = Object.keys(input.inputs);
  if (!canCost) {
    if (touchesSensitiveInputs(input.inputs) || providedKeys.some(isSensitiveKey) || Object.keys(input.sources ?? {}).some(isSensitiveKey))
      throw forbidden('成本、運費、平台費、分潤與付款安排屬敏感資料，需有成本檢視權限才能填寫');
  }
  for (const k of Object.keys(input.sources ?? {})) if (!(k in INPUT_LABEL)) throw validation(`未知的輸入項目「${k}」`);
  await loadProductBasic(pool(), actor.orgId, productId);
  if (input.campaignId) {
    await assertCampaignVisible(actor, input.campaignId);
    const inCamp = await query('SELECT 1 FROM campaign_products WHERE campaign_id=$1 AND product_id=$2 AND deleted_at IS NULL', [input.campaignId, productId]);
    if (!inCamp.length) throw validation('此商品不在指定的檔期內');
  }
  if (input.hostId) {
    const h = await query('SELECT 1 FROM hosts WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [input.hostId, actor.orgId]);
    if (!h.length) throw notFound('團主');
  }
  if (input.trialId) {
    const t = await query<{ campaign_id: string | null }>('SELECT campaign_id FROM product_trials WHERE id=$1 AND organization_id=$2 AND product_id=$3', [input.trialId, actor.orgId, productId]);
    if (!t.length || !(await campaignVisible(actor, t[0].campaign_id))) throw notFound('試用');
  }
  try {
    return await withTx(async (tx) => {
      const prev = await tx.query<ScenarioRow>(
        `SELECT inputs, sources, version_no FROM feasibility_scenarios WHERE product_id=$1 AND coalesce(campaign_id,'')=coalesce($2,'') AND coalesce(host_id,'')=coalesce($3,'') ORDER BY version_no DESC LIMIT 1 FOR UPDATE`,
        [productId, input.campaignId ?? null, input.hostId ?? null]);
      const base = prev.rows[0];
      // 新版本＝在上一版之上套用這次提供的欄位（沒提供的欄位沿用）；不能讀敏感欄位的人新增版本時，敏感欄位原樣沿用，不會被清掉
      const merged = { ...(base?.inputs ?? {}), ...input.inputs } as Record<string, unknown>;
      const sources = { ...(base?.sources ?? {}), ...(input.sources ?? {}) };
      for (const k of Object.keys(merged)) if (merged[k] == null) delete merged[k];
      const parsed = feasibilityInputSchema.parse(merged) as FeasibilityInputs;
      const noSource = Object.keys(merged).filter((k) => !sources[k]);
      if (noSource.length) throw validation(`以下輸入尚未註明假設來源：${noSource.map((k) => INPUT_LABEL[k] ?? k).join('、')}`, { missingSources: noSource });
      for (const k of Object.keys(sources)) if (!(k in merged)) delete sources[k];
      if (!Object.keys(merged).length) throw validation('請至少填寫一項輸入');
      const results = calcFeasibility(parsed);
      const id = await ids.feasibility(tx);
      const versionNo = (base ? Number(base.version_no) : 0) + 1;
      await tx.query(
        `INSERT INTO feasibility_scenarios (id, organization_id, product_id, campaign_id, host_id, trial_id, version_no, label, inputs, sources, results, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
        [id, actor.orgId, productId, input.campaignId ?? null, input.hostId ?? null, input.trialId ?? null, versionNo, input.label ?? null, JSON.stringify(merged), JSON.stringify(sources), JSON.stringify(results), actor.userId]);
      await audit(tx, actor, { action: 'selection.feasibility.create', entityType: 'feasibility_scenario', entityId: id, campaignId: input.campaignId ?? null,
        after: { productId, versionNo, campaignId: input.campaignId ?? null, hostId: input.hostId ?? null, changedKeys: providedKeys.filter((k) => !isSensitiveKey(k)), changedSensitiveCount: providedKeys.filter(isSensitiveKey).length, unknown: Object.keys(results.missing) } });
      return { id, versionNo, results: maskResults(results as never, canCost) };
    });
  } catch (e) { return mapDbError(e, '已有人同時儲存了新版本，請重新整理後再試'); }
}

// ---------------- 小規模測試團實際回寫 ----------------
export async function recordActuals(actor: Actor, id: string) {
  requirePerm(actor, 'selection.write');
  return withTx(async (tx) => {
    const cur = await tx.query(`SELECT * FROM feasibility_scenarios WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [id, actor.orgId]);
    if (!cur.rowCount) throw notFound('可行性情境');
    const f = cur.rows[0] as ScenarioRow;
    if (!f.campaign_id) throw precondition('這個情境沒有關聯檔期，沒有可回寫的實際資料');
    const camp = await assertCampaignVisible(actor, f.campaign_id);
    const sales = f.host_id
      ? await tx.query<{ orders: number; gmv: number; refund: number }>(
          `SELECT count(DISTINCT o.id)::int AS orders, coalesce(sum(o.gross_amount * a.share_percent / 100.0),0) AS gmv, coalesce(sum(o.refund_amount * a.share_percent / 100.0),0) AS refund
           FROM attributions a JOIN orders o ON o.id=a.order_id WHERE o.campaign_id=$1 AND a.organization_id=$2 AND a.host_id=$3 AND o.status = ANY($4::text[])`, [f.campaign_id, actor.orgId, f.host_id, [...SALES_STATUSES]])
      : await tx.query<{ orders: number; gmv: number; refund: number }>(
          `SELECT count(*)::int AS orders, coalesce(sum(gross_amount),0) AS gmv, coalesce(sum(refund_amount),0) AS refund FROM orders WHERE campaign_id=$1 AND organization_id=$2 AND status = ANY($3::text[])`, [f.campaign_id, actor.orgId, [...SALES_STATUSES]]);
    const cs = await tx.query<{ t: string; n: number }>(`SELECT case_type AS t, count(*)::int AS n FROM service_cases WHERE campaign_id=$1 AND organization_id=$2 AND status <> 'CANCELLED' GROUP BY case_type`, [f.campaign_id, actor.orgId]);
    const sh = await tx.query<{ n: number; ex: number }>(
      `SELECT count(*) FILTER (WHERE s.status <> 'CANCELLED')::int AS n, count(*) FILTER (WHERE s.status = 'EXCEPTION')::int AS ex FROM shipments s JOIN fulfillment_batches b ON b.id=s.batch_id
       WHERE s.campaign_id=$1 AND b.organization_id=$2 AND b.kind='ORDER'`, [f.campaign_id, actor.orgId]);
    const s = sales.rows[0];
    const orders = Number(s.orders), gmv = Math.round(Number(s.gmv)), refund = Math.round(Number(s.refund)), nsv = gmv - refund;
    const caseN = (t: string) => Number(cs.rows.find((x) => x.t === t)?.n ?? 0);
    const shipments = Number(sh.rows[0].n), exceptions = Number(sh.rows[0].ex);
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10_000) / 100 : null);
    const predicted = { expectedOrders: (f.inputs.expectedOrders as number | null) ?? null, gmv: (f.results.gmv as number | null) ?? null, refundRatePct: (f.inputs.refundRatePct as number | null) ?? null };
    const actualRefundRate = pct(refund, gmv);
    const diff = (a: number, p: number | null) => (p == null ? null : { predicted: p, actual: a, diff: a - p, diffPct: p > 0 ? Math.round(((a - p) / p) * 10_000) / 100 : null });
    const actuals = {
      scope: f.host_id ? 'HOST' : 'CAMPAIGN', campaignStatus: camp.status, orders, gmv, refund, nsv, aov: orders > 0 ? Math.round(gmv / orders) : null, refundRatePct: actualRefundRate,
      complaints: caseN('COMPLAINT'), refundCases: caseN('REFUND'), exchangeCases: caseN('EXCHANGE'), shipments, shipmentExceptions: exceptions, shipmentExceptionRatePct: pct(exceptions, shipments),
      variance: { orders: diff(orders, predicted.expectedOrders), gmv: diff(gmv, predicted.gmv), refundRatePct: predicted.refundRatePct == null || actualRefundRate == null ? null : { predicted: predicted.refundRatePct, actual: actualRefundRate, diff: Math.round((actualRefundRate - predicted.refundRatePct) * 100) / 100 } },
      note: '客訴件數與出貨例外是檔期層級（不分團主）；不回寫利潤，避免在成本資料不全時捏造結果',
    };
    await tx.query(`UPDATE feasibility_scenarios SET actuals=$2, actuals_at=now(), updated_by=$3 WHERE id=$1`, [id, JSON.stringify(actuals), actor.userId]);
    await audit(tx, actor, { action: 'selection.feasibility.actuals', entityType: 'feasibility_scenario', entityId: id, campaignId: f.campaign_id, before: f.actuals ? { actuals: f.actuals } : null, after: { actuals } });
    return { id, actuals };
  });
}

/** 供 G1 摘要唯讀：某商品在某檔期最新的情境（沒有檔期專屬的，退而求其次用商品層級的） */
export async function latestFeasibility(actor: Actor, productId: string, campaignId: string) {
  const rows = await query(
    `${SELECT_SC} WHERE f.organization_id=$1 AND f.product_id=$2 AND (f.campaign_id=$3 OR f.campaign_id IS NULL) ORDER BY (f.campaign_id IS NOT NULL) DESC, f.created_at DESC, f.id DESC LIMIT 1`, [actor.orgId, productId, campaignId]);
  if (!rows[0]) return null;
  return { view: present(rows[0] as never, can(actor, 'product.cost.read')), raw: rows[0] as ScenarioRow };
}
