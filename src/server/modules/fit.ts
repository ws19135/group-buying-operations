import { z } from 'zod';
import type { Queryable, Tx } from '../lib/db';
import { pool, query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { requirePerm } from '../lib/permissions';
import { AppError, notFound, precondition, validation } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids } from '../lib/ids';
import { camelize } from '../lib/case';
import { nonEmpty } from '../lib/text';
import { campaignScope } from '../lib/scope';
import { SALES_STATUSES } from '../lib/kpi';
import { DEFAULT_FIT_CONFIG, configProblems, inputHash, scoreFit, stableStringify, type FitConfig, type FitInput, type FitProduct, type FitSegment, type HistoryInput, type SupplyInput } from '../lib/fit-score';
import { LEXICON_VERSION, REVIEW_DECISIONS, normText, type Basis, type PrefKind } from '../lib/segment-vocab';
import { containsPii } from './aftersales';

/**
 * 商品 × 團主適配評估服務（SOP 01）。評分規則在 lib/fit-score.ts（純函式）；這裡負責取資料、保存版本、覆核、成效回寫。
 * 不修改任何檔期狀態、不發通知、不碰 G1–G5：評估只是給核准者查閱的決策支援。設計見 docs/phase2/SEGMENT_FIT.md。
 */
const FINISHED_STATUSES = ['PENDING_CLOSE_CHECK', 'FULFILLING', 'PENDING_SETTLEMENT', 'SETTLED', 'CLOSED'];
const MAX_HOSTS_PER_RUN = 200;
const CONFIG_KEY = 'fit.scoring';

// ---------------- 評分設定（system_settings） ----------------
export const fitConfigSchema = z.object({
  weights: z.object({ need: z.number(), category: z.number(), price: z.number(), history: z.number(), supply: z.number() }),
  thresholds: z.object({ recommend: z.number(), review: z.number(), minCompleteness: z.number(), highConfidence: z.number(), mediumConfidence: z.number() }).optional(),
  minHistoryCampaigns: z.number().optional(),
  minShipments: z.number().optional(),
  approved: z.boolean().optional(),
  version: z.number().int().optional(),
});

export async function loadFitConfig(db: Queryable, orgId: string): Promise<FitConfig & { persisted: boolean }> {
  const r = await db.query<{ value: Partial<FitConfig> }>('SELECT value FROM system_settings WHERE organization_id=$1 AND key=$2', [orgId, CONFIG_KEY]);
  const v = r.rows[0]?.value;
  if (!v) return { ...DEFAULT_FIT_CONFIG, persisted: false };
  const merged: FitConfig = {
    ...DEFAULT_FIT_CONFIG, ...v,
    weights: { ...DEFAULT_FIT_CONFIG.weights, ...(v.weights ?? {}) },
    thresholds: { ...DEFAULT_FIT_CONFIG.thresholds, ...(v.thresholds ?? {}) },
    lexiconVersion: LEXICON_VERSION,
  };
  return { ...merged, persisted: true };
}

export async function getFitConfig(actor: Actor) {
  requirePerm(actor, 'fit.read');
  const c = await loadFitConfig(pool(), actor.orgId);
  return { ...c, status: c.approved ? '已確認採用' : '建議值，待 Owner 確認' };
}

export async function putFitConfig(actor: Actor, raw: z.input<typeof fitConfigSchema>) {
  requirePerm(actor, 'fit.config');
  const input = fitConfigSchema.parse(raw);
  return withTx(async (tx) => {
    const prev = await loadFitConfig(tx, actor.orgId);
    if (input.version != null && input.version !== prev.version) throw new AppError('CONFLICT', '評分設定已被其他人更新，請重新整理後再試', { currentVersion: prev.version });
    const next: FitConfig = {
      version: prev.version + 1,   // 內建建議值是版本 1，第一次儲存＝版本 2，確保「用建議值評估」與「用已儲存設定評估」可區分
      approved: input.approved ?? false,
      weights: input.weights,
      thresholds: input.thresholds ?? prev.thresholds,
      minHistoryCampaigns: input.minHistoryCampaigns ?? prev.minHistoryCampaigns,
      minShipments: input.minShipments ?? prev.minShipments,
      lexiconVersion: LEXICON_VERSION,
    };
    const problems = configProblems(next);
    if (problems.length) throw validation(problems.join('；'), { problems });
    await tx.query(
      `INSERT INTO system_settings (organization_id, key, value, updated_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (organization_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`,
      [actor.orgId, CONFIG_KEY, JSON.stringify(next), actor.userId]);
    await audit(tx, actor, { action: 'fit.config.update', entityType: 'fit_config', entityId: CONFIG_KEY,
      before: { version: prev.version, approved: prev.approved, weights: prev.weights, thresholds: prev.thresholds },
      after: { version: next.version, approved: next.approved, weights: next.weights, thresholds: next.thresholds } });
    return { ...next, status: next.approved ? '已確認採用' : '建議值，待 Owner 確認' };
  });
}

// ---------------- 取資料 ----------------
interface HistRow { host_id: string; campaign_id: string; net: number; gross: number; refund: number }
interface FitCtx {
  orgId: string;
  cfg: FitConfig;
  history: HistRow[];
  campaignCats: Map<string, Set<string>>;
  supply: Map<string, SupplyInput>;
  excludeCampaignId: string | null;
}

async function buildCtx(db: Queryable, orgId: string, cfg: FitConfig, excludeCampaignId: string | null): Promise<FitCtx> {
  const hist = await db.query<HistRow>(
    `SELECT a.host_id, o.campaign_id,
       coalesce(sum((o.gross_amount - o.refund_amount) * a.share_percent / 100.0),0) AS net,
       coalesce(sum(o.gross_amount * a.share_percent / 100.0),0) AS gross,
       coalesce(sum(o.refund_amount * a.share_percent / 100.0),0) AS refund
     FROM attributions a JOIN orders o ON o.id=a.order_id JOIN campaigns c ON c.id=o.campaign_id
     WHERE a.organization_id=$1 AND c.deleted_at IS NULL AND c.status = ANY($2::text[]) AND o.status = ANY($3::text[])
       AND ($4::text IS NULL OR c.id <> $4)
     GROUP BY a.host_id, o.campaign_id`, [orgId, FINISHED_STATUSES, [...SALES_STATUSES], excludeCampaignId]);
  const cats = await db.query<{ campaign_id: string; category: string }>(
    `SELECT DISTINCT cp.campaign_id, p.category FROM campaign_products cp JOIN products p ON p.id=cp.product_id
     WHERE cp.organization_id=$1 AND cp.deleted_at IS NULL AND p.category IS NOT NULL`, [orgId]);
  const campaignCats = new Map<string, Set<string>>();
  for (const c of cats.rows) {
    const set = campaignCats.get(c.campaign_id) ?? new Set<string>();
    set.add(normText(c.category));
    campaignCats.set(c.campaign_id, set);
  }
  return { orgId, cfg, history: hist.rows, campaignCats, supply: new Map(), excludeCampaignId };
}

function historyFor(ctx: FitCtx, hostId: string, productCategory: string | null): HistoryInput {
  const min = ctx.cfg.minHistoryCampaigns;
  const cat = normText(productCategory);
  const inCat = (r: HistRow) => !!cat && !!ctx.campaignCats.get(r.campaign_id)?.has(cat);
  const hostAll = ctx.history.filter((r) => r.host_id === hostId);
  const hostSame = hostAll.filter(inCat);
  const mk = (scope: HistoryInput['scope'], hostRows: HistRow[], bench: HistRow[]): HistoryInput => {
    const sum = (rows: HistRow[], k: 'net' | 'gross' | 'refund') => rows.reduce((a, r) => a + Number(r[k]), 0);
    const rate = (rows: HistRow[]) => (sum(rows, 'gross') > 0 ? sum(rows, 'refund') / sum(rows, 'gross') : null);
    return {
      scope, hostCampaigns: hostRows.length,
      hostAvgNet: hostRows.length ? sum(hostRows, 'net') / hostRows.length : null, hostRefundRate: rate(hostRows),
      benchRows: bench.length, benchAvgNet: bench.length ? sum(bench, 'net') / bench.length : null, benchRefundRate: rate(bench),
    };
  };
  if (hostSame.length >= min) return mk('SAME_CATEGORY', hostSame, ctx.history.filter(inCat));
  if (hostAll.length >= min) return mk('ALL', hostAll, ctx.history);
  return { scope: 'NONE', hostCampaigns: hostAll.length, hostAvgNet: null, hostRefundRate: null, benchRows: 0, benchAvgNet: null, benchRefundRate: null };
}

async function supplyFor(db: Queryable, ctx: FitCtx, vendorId: string): Promise<SupplyInput> {
  const hit = ctx.supply.get(vendorId);
  if (hit) return hit;
  const sh = await db.query<{ n: number; ex: number }>(
    `SELECT count(*) FILTER (WHERE s.status <> 'CANCELLED')::int AS n, count(*) FILTER (WHERE s.status = 'EXCEPTION')::int AS ex
     FROM shipments s JOIN fulfillment_batches b ON b.id=s.batch_id JOIN campaigns c ON c.id=s.campaign_id
     WHERE c.organization_id=$1 AND c.vendor_id=$2 AND b.kind='ORDER'`, [ctx.orgId, vendorId]);
  const od = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM orders o JOIN campaigns c ON c.id=o.campaign_id WHERE c.organization_id=$1 AND c.vendor_id=$2 AND o.status = ANY($3::text[])`,
    [ctx.orgId, vendorId, [...SALES_STATUSES]]);
  const cs = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM service_cases sc JOIN campaigns c ON c.id=sc.campaign_id
     WHERE c.organization_id=$1 AND c.vendor_id=$2 AND sc.status <> 'CANCELLED' AND sc.case_type IN ('REFUND','COMPLAINT','EXCHANGE')`, [ctx.orgId, vendorId]);
  const out = { shipments: Number(sh.rows[0].n), exceptions: Number(sh.rows[0].ex), orders: Number(od.rows[0].n), cases: Number(cs.rows[0].n) };
  ctx.supply.set(vendorId, out);
  return out;
}

async function loadProduct(db: Queryable, orgId: string, productId: string): Promise<FitProduct & { vendorId: string }> {
  const r = await db.query(
    `SELECT p.id, p.name, p.category, p.selling_points, p.description, p.compliance_note, p.review_status, p.vendor_id, v.status AS vendor_status
     FROM products p JOIN vendors v ON v.id=p.vendor_id WHERE p.id=$1 AND p.organization_id=$2 AND p.deleted_at IS NULL`, [productId, orgId]);
  if (!r.rowCount) throw notFound('商品');
  const p = r.rows[0] as Record<string, string | null>;
  const prices = await db.query<{ group_price: number }>(`SELECT group_price FROM skus WHERE product_id=$1 AND deleted_at IS NULL AND status='ACTIVE' AND group_price IS NOT NULL`, [productId]);
  return {
    id: p.id as string, name: p.name as string, category: p.category, sellingPoints: p.selling_points, description: p.description, complianceNote: p.compliance_note,
    reviewStatus: p.review_status as string, vendorStatus: p.vendor_status, vendorId: p.vendor_id as string,
    skuPrices: prices.rows.map((x) => Number(x.group_price)),
  };
}

async function loadHostSegments(db: Queryable, orgId: string, hostId: string): Promise<(FitSegment & { linkId: string })[]> {
  const links = await db.query(
    `SELECT l.id AS link_id, l.share_percent, l.basis AS link_basis, s.id, s.name, s.basis, s.price_min, s.price_max
     FROM partner_segment_links l JOIN customer_segments s ON s.id=l.segment_id
     WHERE l.host_id=$1 AND l.organization_id=$2 AND l.ended_at IS NULL AND s.deleted_at IS NULL ORDER BY l.id`, [hostId, orgId]);
  const out: (FitSegment & { linkId: string })[] = [];
  for (const l of links.rows as Record<string, unknown>[]) {
    const prefs = await db.query(`SELECT kind, value, basis FROM segment_preferences WHERE segment_id=$1 AND deleted_at IS NULL ORDER BY id`, [l.id]);
    out.push({
      linkId: l.link_id as string, id: l.id as string, name: l.name as string, basis: l.basis as Basis, linkBasis: l.link_basis as Basis,
      sharePercent: l.share_percent == null ? null : Number(l.share_percent),
      priceMin: l.price_min == null ? null : Number(l.price_min), priceMax: l.price_max == null ? null : Number(l.price_max),
      prefs: (prefs.rows as { kind: PrefKind; value: string; basis: Basis }[]).map((p) => ({ kind: p.kind, value: p.value, basis: p.basis })),
    });
  }
  return out;
}

// ---------------- 產生評估 ----------------
export interface AssessOutcome { id: string; hostId: string; productId: string; unchanged: boolean; recommendation: string; totalScore: number | null; previousId: string | null }

async function assessOne(tx: Tx, actor: Actor, ctx: FitCtx, product: FitProduct & { vendorId: string }, hostId: string, campaignId: string | null): Promise<AssessOutcome> {
  const segs = await loadHostSegments(tx, ctx.orgId, hostId);
  const input: FitInput = {
    segments: segs.map(({ linkId: _l, ...s }) => s),
    product: { id: product.id, name: product.name, category: product.category, sellingPoints: product.sellingPoints, description: product.description, complianceNote: product.complianceNote, reviewStatus: product.reviewStatus, vendorStatus: product.vendorStatus, skuPrices: product.skuPrices },
    history: historyFor(ctx, hostId, product.category),
    supply: await supplyFor(tx, ctx, product.vendorId),
  };
  const hash = inputHash(input, ctx.cfg);
  const cur = await tx.query(`SELECT id, input_hash FROM product_fit_assessments WHERE product_id=$1 AND host_id=$2 AND coalesce(campaign_id,'')=coalesce($3,'') AND superseded_at IS NULL FOR UPDATE`, [product.id, hostId, campaignId]);
  const prev = cur.rows[0] as { id: string; input_hash: string } | undefined;
  if (prev && prev.input_hash === hash) {
    const same = await tx.query('SELECT recommendation, total_score FROM product_fit_assessments WHERE id=$1', [prev.id]);
    return { id: prev.id, hostId, productId: product.id, unchanged: true, recommendation: same.rows[0].recommendation as string, totalScore: same.rows[0].total_score == null ? null : Number(same.rows[0].total_score), previousId: prev.id };
  }
  const res = scoreFit(input, ctx.cfg);
  const id = await ids.fitAssessment(tx);
  if (prev) await tx.query('UPDATE product_fit_assessments SET superseded_at=now(), superseded_by=$2 WHERE id=$1', [prev.id, id]);
  const sources = {
    segments: segs.map((s) => ({ id: s.id, name: s.name, linkId: s.linkId, basis: s.basis, linkBasis: s.linkBasis, sharePercent: s.sharePercent })),
    history: { scope: input.history.scope, hostCampaigns: input.history.hostCampaigns, benchRows: input.history.benchRows },
    supply: input.supply,
    product: { category: product.category, reviewStatus: product.reviewStatus, vendorStatus: product.vendorStatus, skuCount: product.skuPrices.length },
    lexiconVersion: ctx.cfg.lexiconVersion,
  };
  await tx.query(
    `INSERT INTO product_fit_assessments (id, organization_id, product_id, host_id, campaign_id, config_version, config_snapshot, input_hash, total_score, completeness, confidence,
       recommendation, dimensions, hard_checks, reasons, sources, assessed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [id, ctx.orgId, product.id, hostId, campaignId, ctx.cfg.version, JSON.stringify({ version: ctx.cfg.version, approved: ctx.cfg.approved, weights: ctx.cfg.weights, thresholds: ctx.cfg.thresholds, minHistoryCampaigns: ctx.cfg.minHistoryCampaigns, minShipments: ctx.cfg.minShipments, lexiconVersion: ctx.cfg.lexiconVersion }),
      hash, res.totalScore, res.completeness, res.confidence, res.recommendation, JSON.stringify(res.dimensions), JSON.stringify(res.hardChecks), JSON.stringify(res.reasons), JSON.stringify(sources), actor.userId]);
  await audit(tx, actor, {
    action: 'fit.assess', entityType: 'fit_assessment', entityId: id, campaignId,
    after: { productId: product.id, hostId, totalScore: res.totalScore, recommendation: res.recommendation, confidence: res.confidence, completeness: res.completeness, supersedes: prev?.id ?? null, configVersion: ctx.cfg.version },
  });
  return { id, hostId, productId: product.id, unchanged: false, recommendation: res.recommendation, totalScore: res.totalScore, previousId: prev?.id ?? null };
}

async function assertCampaignVisible(actor: Actor, campaignId: string): Promise<Record<string, unknown>> {
  const sc = campaignScope(actor, 2, 'c');
  if (sc.sql === 'FALSE') throw notFound('檔期');
  const r = await query('SELECT c.id, c.title, c.status, c.vendor_id FROM campaigns c WHERE c.id=$1 AND (' + sc.sql + ')', [campaignId, ...sc.params]);
  if (!r.length) throw notFound('檔期');
  return r[0];
}

export const assessRequestSchema = z.object({ hostIds: z.array(z.string().max(40)).max(MAX_HOSTS_PER_RUN).optional(), campaignId: z.string().max(40).optional() });

/** 對一個商品評估候選團主；未指定團主時評估所有合作中的團主（上限 200） */
export async function assessProduct(actor: Actor, productId: string, raw: z.input<typeof assessRequestSchema> = {}) {
  requirePerm(actor, 'fit.assess');
  const input = assessRequestSchema.parse(raw ?? {});
  if (input.campaignId) {
    await assertCampaignVisible(actor, input.campaignId);
    const inCamp = await query('SELECT 1 FROM campaign_products WHERE campaign_id=$1 AND product_id=$2 AND deleted_at IS NULL', [input.campaignId, productId]);
    if (!inCamp.length) throw validation('此商品不在指定的檔期內');
  }
  const cfg = await loadFitConfig(pool(), actor.orgId);
  const product = await loadProduct(pool(), actor.orgId, productId);
  let hostIds = input.hostIds;
  if (hostIds?.length) {
    const ok = await query<{ id: string }>(`SELECT id FROM hosts WHERE organization_id=$1 AND deleted_at IS NULL AND id = ANY($2::text[])`, [actor.orgId, hostIds]);
    const found = new Set(ok.map((r) => r.id));
    const missing = hostIds.filter((h) => !found.has(h));
    if (missing.length) throw notFound(`團主 ${missing.join('、')}`);
  } else {
    hostIds = (await query<{ id: string }>(`SELECT id FROM hosts WHERE organization_id=$1 AND deleted_at IS NULL AND status='ACTIVE' ORDER BY id LIMIT ${MAX_HOSTS_PER_RUN}`, [actor.orgId])).map((r) => r.id);
  }
  if (!hostIds.length) throw precondition('目前沒有可評估的團主');
  const ctx = await buildCtx(pool(), actor.orgId, cfg, input.campaignId ?? null);
  const results = await withTx(async (tx) => {
    const out: AssessOutcome[] = [];
    for (const h of hostIds as string[]) out.push(await assessOne(tx, actor, ctx, product, h, input.campaignId ?? null));
    return out;
  });
  return { productId, campaignId: input.campaignId ?? null, configVersion: cfg.version, assessed: results.filter((r) => !r.unchanged).length, unchanged: results.filter((r) => r.unchanged).length, results };
}

/** 對檔期內的每個商品 × 每位未婉拒的團主評估（檔期草稿／評估中使用） */
export async function assessCampaign(actor: Actor, campaignId: string) {
  requirePerm(actor, 'fit.assess');
  await assertCampaignVisible(actor, campaignId);
  const products = (await query<{ product_id: string }>(`SELECT DISTINCT product_id FROM campaign_products WHERE campaign_id=$1 AND deleted_at IS NULL ORDER BY product_id`, [campaignId])).map((r) => r.product_id);
  const hostIds = (await query<{ host_id: string }>(`SELECT host_id FROM campaign_hosts WHERE campaign_id=$1 AND deleted_at IS NULL AND status <> 'DECLINED' ORDER BY host_id`, [campaignId])).map((r) => r.host_id);
  if (!products.length) throw precondition('此檔期還沒有商品，無法評估適配');
  if (!hostIds.length) throw precondition('此檔期還沒有邀請團主，無法評估適配');
  const cfg = await loadFitConfig(pool(), actor.orgId);
  const ctx = await buildCtx(pool(), actor.orgId, cfg, campaignId);
  const loaded: Awaited<ReturnType<typeof loadProduct>>[] = [];
  for (const pid of products) loaded.push(await loadProduct(pool(), actor.orgId, pid));
  const results = await withTx(async (tx) => {
    const out: AssessOutcome[] = [];
    for (const p of loaded) for (const h of hostIds) out.push(await assessOne(tx, actor, ctx, p, h, campaignId));
    return out;
  });
  return { campaignId, configVersion: cfg.version, assessed: results.filter((r) => !r.unchanged).length, unchanged: results.filter((r) => r.unchanged).length, results };
}

// ---------------- 查詢 ----------------
const STALE_SQL = `(p.updated_at > a.assessed_at OR v.updated_at > a.assessed_at
  OR EXISTS (SELECT 1 FROM skus k WHERE k.product_id=a.product_id AND k.updated_at > a.assessed_at)
  OR EXISTS (SELECT 1 FROM partner_segment_links l JOIN customer_segments s ON s.id=l.segment_id
       WHERE l.host_id=a.host_id AND (l.updated_at > a.assessed_at OR s.updated_at > a.assessed_at
         OR EXISTS (SELECT 1 FROM segment_preferences sp WHERE sp.segment_id=s.id AND sp.updated_at > a.assessed_at))))`;

const SELECT_FIT = `SELECT a.id, a.product_id, p.name AS product_name, p.category AS product_category, a.host_id, h.display_name AS host_name, a.campaign_id,
    a.config_version, a.total_score, a.completeness, a.confidence, a.recommendation, a.dimensions, a.hard_checks, a.reasons, a.sources,
    a.assessed_at, u.name AS assessed_by_name, a.review_decision, a.review_note, a.reviewed_at, ru.name AS reviewed_by_name, a.superseded_at, a.outcome, a.outcome_at,
    ${STALE_SQL} AS stale,
    (SELECT count(*)::int FROM partner_segment_links l WHERE l.host_id=a.host_id AND l.ended_at IS NULL) AS segment_count
  FROM product_fit_assessments a JOIN products p ON p.id=a.product_id JOIN vendors v ON v.id=p.vendor_id JOIN hosts h ON h.id=a.host_id
  LEFT JOIN users u ON u.id=a.assessed_by LEFT JOIN users ru ON ru.id=a.reviewed_by`;

const REC_RANK: Record<string, number> = { RECOMMEND: 0, REVIEW: 1, NOT_RECOMMENDED: 2, INSUFFICIENT_DATA: 3, BLOCKED: 4 };
function rank<T extends { recommendation: string; totalScore: number | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => (REC_RANK[a.recommendation] ?? 9) - (REC_RANK[b.recommendation] ?? 9) || (b.totalScore ?? -1) - (a.totalScore ?? -1));
}

/** 商品頁：該商品目前（未被取代）的候選團主評估，建議合作者在前 */
export async function listProductFit(actor: Actor, productId: string) {
  requirePerm(actor, 'fit.read');
  const p = await query('SELECT id, name FROM products WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [productId, actor.orgId]);
  if (!p.length) throw notFound('商品');
  const rows = await query(
    `${SELECT_FIT} WHERE a.organization_id=$1 AND a.product_id=$2 AND a.superseded_at IS NULL AND a.campaign_id IS NULL`, [actor.orgId, productId]);
  const cfg = await loadFitConfig(pool(), actor.orgId);
  return { productId, productName: (p[0] as { name: string }).name, config: { version: cfg.version, approved: cfg.approved }, items: rank(camelize<FitRow[]>(rows)) };
}

/** 檔期頁：該檔期脈絡下的評估（商品 × 團主） */
export async function listCampaignFit(actor: Actor, campaignId: string) {
  requirePerm(actor, 'fit.read');
  const camp = await assertCampaignVisible(actor, campaignId);
  const rows = await query(`${SELECT_FIT} WHERE a.organization_id=$1 AND a.campaign_id=$2 AND a.superseded_at IS NULL`, [actor.orgId, campaignId]);
  const cfg = await loadFitConfig(pool(), actor.orgId);
  const items = camelize<FitRow[]>(rows);
  const reviewed = items.filter((i) => i.reviewDecision).length;
  return {
    campaignId, campaignTitle: camp.title as string, campaignStatus: camp.status as string, config: { version: cfg.version, approved: cfg.approved },
    summary: { total: items.length, reviewed, pendingReview: items.length - reviewed, blocked: items.filter((i) => i.recommendation === 'BLOCKED').length, stale: items.filter((i) => i.stale).length },
    items: rank(items),
  };
}

interface FitRow {
  id: string; productId: string; productName: string; hostId: string; hostName: string; campaignId: string | null; totalScore: number | null; recommendation: string;
  reviewDecision: string | null; stale: boolean; [k: string]: unknown;
}

export async function getFit(actor: Actor, id: string) {
  requirePerm(actor, 'fit.read');
  const rows = await query(`${SELECT_FIT} WHERE a.id=$1 AND a.organization_id=$2`, [id, actor.orgId]);
  if (!rows.length) throw notFound('適配評估');
  const row = camelize<FitRow & { campaignId: string | null }>(rows[0]);
  if (row.campaignId) await assertCampaignVisible(actor, row.campaignId);
  const snap = await query('SELECT config_snapshot FROM product_fit_assessments WHERE id=$1', [id]);
  const history = camelize(await query(
    `SELECT a.id, a.assessed_at, a.total_score, a.recommendation, a.review_decision, a.superseded_at FROM product_fit_assessments a
     WHERE a.organization_id=$1 AND a.product_id=$2 AND a.host_id=$3 AND coalesce(a.campaign_id,'')=coalesce($4,'') ORDER BY a.assessed_at DESC, a.id DESC LIMIT 20`,
    [actor.orgId, row.productId, row.hostId, row.campaignId]));
  return { ...row, configSnapshot: (snap[0] as { config_snapshot: unknown }).config_snapshot, versions: history };
}

/** 總覽：待覆核、已覆核、依建議／商品／團主／檔期篩選。檔期層級的資料沿用檔期資料範圍 */
export async function listFit(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'fit.read');
  const sc = campaignScope(actor, 2, 'c');
  const params: unknown[] = [actor.orgId, ...sc.params];
  const where = [`a.organization_id=$1`, `a.superseded_at IS NULL`,
    sc.sql === 'FALSE' ? 'a.campaign_id IS NULL' : `(a.campaign_id IS NULL OR EXISTS (SELECT 1 FROM campaigns c WHERE c.id=a.campaign_id AND (${sc.sql})))`];
  const add = (col: string, v: string | null) => { if (v) { params.push(v); where.push(`${col}=$${params.length}`); } };
  add('a.recommendation', nonEmpty(q.get('recommendation')));
  add('a.product_id', nonEmpty(q.get('productId')));
  add('a.host_id', nonEmpty(q.get('hostId')));
  add('a.campaign_id', nonEmpty(q.get('campaignId')));
  const review = nonEmpty(q.get('review'));
  if (review === 'pending') where.push('a.review_decision IS NULL');
  else if (review === 'done') where.push('a.review_decision IS NOT NULL');
  const rawLimit = Number(q.get('limit') ?? 100);
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(Math.trunc(rawLimit), 300) : 100;
  const rows = await query(`${SELECT_FIT} WHERE ${where.join(' AND ')} ORDER BY a.assessed_at DESC, a.id DESC LIMIT ${limit}`, params);
  return { items: camelize<FitRow[]>(rows) };
}

/** 客群適配總覽頁：待覆核、尚未建立客群分析的團主、目前評分設定 */
export async function fitOverview(actor: Actor) {
  requirePerm(actor, 'fit.read');
  const [pending, noSeg, cfg] = await Promise.all([
    listFit(actor, new URLSearchParams('review=pending&limit=30')),
    query(`SELECT h.id, h.display_name, h.partner_type FROM hosts h WHERE h.organization_id=$1 AND h.deleted_at IS NULL AND h.status='ACTIVE'
             AND NOT EXISTS (SELECT 1 FROM partner_segment_links l WHERE l.host_id=h.id AND l.ended_at IS NULL) ORDER BY h.id LIMIT 50`, [actor.orgId]),
    loadFitConfig(pool(), actor.orgId),
  ]);
  return { pendingReview: pending.items, hostsWithoutSegments: camelize(noSeg), config: { ...cfg, status: cfg.approved ? '已確認採用' : '建議值，待 Owner 確認' } };
}

// ---------------- 人工覆核 ----------------
export const reviewSchema = z.object({ decision: z.enum(REVIEW_DECISIONS), note: z.string().trim().max(1000).optional().or(z.literal('').transform(() => undefined)) });

/** 覆核只記錄人的意見：不改評分、不改任何檔期狀態、不觸發核准 */
export async function reviewFit(actor: Actor, id: string, raw: z.input<typeof reviewSchema>) {
  requirePerm(actor, 'fit.review');
  const input = reviewSchema.parse(raw);
  if (input.decision !== 'ACCEPTED' && !input.note) throw validation('不採用或需補資料時，請填寫原因');
  if (containsPii(input.note)) throw validation('覆核意見請勿填寫電話或 Email');
  return withTx(async (tx) => {
    const cur = await tx.query('SELECT * FROM product_fit_assessments WHERE id=$1 AND organization_id=$2 FOR UPDATE', [id, actor.orgId]);
    if (!cur.rowCount) throw notFound('適配評估');
    const row = cur.rows[0];
    if (row.campaign_id) await assertCampaignVisible(actor, row.campaign_id as string);
    if (row.superseded_at) throw new AppError('CONFLICT', '這筆評估已被新版本取代，請覆核最新的評估', { supersededBy: row.superseded_by });
    await tx.query('UPDATE product_fit_assessments SET review_decision=$2, review_note=$3, reviewed_by=$4, reviewed_at=now() WHERE id=$1', [id, input.decision, input.note ?? null, actor.userId]);
    await audit(tx, actor, {
      action: 'fit.review', entityType: 'fit_assessment', entityId: id, campaignId: (row.campaign_id as string | null) ?? null,
      before: { reviewDecision: row.review_decision ?? null, reviewNote: row.review_note ?? null },
      after: { reviewDecision: input.decision, reviewNote: input.note ?? null, recommendation: row.recommendation, totalScore: row.total_score },
    });
    return { id, reviewDecision: input.decision };
  });
}

// ---------------- 結案成效回寫 ----------------
const OUTCOME_STATUSES = ['CLOSED', 'SETTLED'];

/** 檔期結案後，把每位團主的實際成效寫回該檔期的評估（事後對照用；不改評分、不改歷史績效口徑） */
export async function recordCampaignOutcome(actor: Actor, campaignId: string) {
  requirePerm(actor, 'fit.assess');
  const camp = await assertCampaignVisible(actor, campaignId);
  if (!OUTCOME_STATUSES.includes(camp.status as string)) throw precondition(`檔期結案（${OUTCOME_STATUSES.join('／')}）後才能回寫成效，目前狀態為 ${camp.status}`);
  return withTx(async (tx) => {
    const fits = await tx.query(`SELECT id, host_id, product_id, total_score, recommendation, outcome FROM product_fit_assessments WHERE organization_id=$1 AND campaign_id=$2 AND superseded_at IS NULL FOR UPDATE`, [actor.orgId, campaignId]);
    if (!fits.rowCount) throw precondition('這個檔期沒有適配評估，沒有可回寫的對象');
    const sales = await tx.query<{ host_id: string; net: number; gross: number; refund: number; orders: number }>(
      `SELECT a.host_id,
         coalesce(sum((o.gross_amount - o.refund_amount) * a.share_percent / 100.0),0) AS net,
         coalesce(sum(o.gross_amount * a.share_percent / 100.0),0) AS gross,
         coalesce(sum(o.refund_amount * a.share_percent / 100.0),0) AS refund,
         count(DISTINCT o.id)::int AS orders
       FROM attributions a JOIN orders o ON o.id=a.order_id WHERE o.campaign_id=$1 AND a.organization_id=$2 AND o.status = ANY($3::text[]) GROUP BY a.host_id`,
      [campaignId, actor.orgId, [...SALES_STATUSES]]);
    const byHost = new Map(sales.rows.map((r) => [r.host_id, r]));
    const targets = await tx.query<{ host_id: string; target_revenue: number | null }>(`SELECT host_id, target_revenue FROM campaign_hosts WHERE campaign_id=$1 AND deleted_at IS NULL`, [campaignId]);
    const target = new Map(targets.rows.map((r) => [r.host_id, r.target_revenue == null ? null : Number(r.target_revenue)]));
    let updated = 0, unchanged = 0;
    for (const f of fits.rows as { id: string; host_id: string; product_id: string; total_score: number | null; recommendation: string; outcome: Record<string, unknown> | null }[]) {
      const s = byHost.get(f.host_id);
      const net = s ? Math.round(Number(s.net)) : 0;
      const tgt = target.get(f.host_id) ?? null;
      const outcome = {
        campaignStatus: camp.status, hostNetSales: net, hostOrders: s ? Number(s.orders) : 0,
        hostRefundRate: s && Number(s.gross) > 0 ? Math.round((Number(s.refund) / Number(s.gross)) * 1000) / 1000 : null,
        targetRevenue: tgt, targetAttainment: tgt && tgt > 0 ? Math.round((net / tgt) * 1000) / 1000 : null,
        predictedScore: f.total_score == null ? null : Number(f.total_score), predictedRecommendation: f.recommendation,
        note: s ? '歸因淨銷售額與訂單數來自訂單歸因（含全部商品，非單一商品）' : '此團主在這個檔期沒有歸因訂單',
      };
      if (f.outcome && stableStringify(f.outcome) === stableStringify(outcome)) { unchanged++; continue; }
      await tx.query('UPDATE product_fit_assessments SET outcome=$2, outcome_at=now() WHERE id=$1', [f.id, JSON.stringify(outcome)]);
      await audit(tx, actor, { action: 'fit.outcome', entityType: 'fit_assessment', entityId: f.id, campaignId, before: f.outcome ? { outcome: f.outcome } : null, after: { outcome } });
      updated++;
    }
    return { campaignId, updated, unchanged, assessments: fits.rowCount };
  });
}
