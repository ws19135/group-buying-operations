import { z } from 'zod';
import type { Tx } from '../lib/db';
import { query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, requirePerm } from '../lib/permissions';
import { AppError, forbidden, notFound, validation } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids } from '../lib/ids';
import { normalizeName, nonEmpty } from '../lib/text';
import { camelize } from '../lib/case';
import { likePattern, listPaged, pageParams, patchEntity } from '../lib/repo';
import { idempotent } from '../lib/idempotency';
import { campaignScope } from '../lib/scope';

const optText = (max = 500) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));
const money = z.number().int().min(0).max(1_000_000_000);

export const skuSchema = z.object({
  skuCode: z.string().trim().min(1, '請輸入規格編號').max(60),
  name: z.string().trim().min(1, '請輸入規格名稱').max(120),
  listPrice: money.optional(),
  groupPrice: money.optional(),
  costPrice: money.optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});
export const productCreateSchema = z.object({
  vendorId: z.string().min(1, '請選擇廠商'),
  name: z.string().trim().min(1, '請輸入商品名稱').max(160),
  category: optText(60),
  description: optText(3000),
  listingUrl: optText(500),
  sellingPoints: optText(3000),
  complianceNote: optText(2000),
  skus: z.array(skuSchema).max(50).optional(),
});
export const productUpdateSchema = productCreateSchema.omit({ vendorId: true, skus: true }).partial().extend({ version: z.number().int().optional() });
const PRODUCT_FIELDS = ['name', 'category', 'description', 'listingUrl', 'sellingPoints', 'complianceNote'] as const;

function validateSkuPrices(s: { listPrice?: number; groupPrice?: number }) {
  if (s.listPrice != null && s.groupPrice != null && s.groupPrice > s.listPrice) throw validation('團購價不可高於原價');
}

async function insertSku(tx: Tx, actor: Actor, productId: string, s: z.output<typeof skuSchema>) {
  validateSkuPrices(s);
  const dupe = await tx.query('SELECT 1 FROM skus WHERE product_id=$1 AND lower(sku_code)=lower($2) AND deleted_at IS NULL', [productId, s.skuCode]);
  if (dupe.rowCount) throw new AppError('CONFLICT', `規格編號 ${s.skuCode} 已存在於此商品`);
  const id = await ids.sku(tx);
  await tx.query(
    `INSERT INTO skus (id, organization_id, product_id, sku_code, name, list_price, group_price, cost_price, status, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
    [id, actor.orgId, productId, s.skuCode, s.name, s.listPrice ?? null, s.groupPrice ?? null, s.costPrice ?? null, s.status ?? 'ACTIVE', actor.userId]);
  await audit(tx, actor, { action: 'sku.create', entityType: 'sku', entityId: id, after: { productId, skuCode: s.skuCode, name: s.name } });
  return id;
}

export async function createProduct(actor: Actor, raw: z.input<typeof productCreateSchema>, idemKey?: string | null) {
  requirePerm(actor, 'product.write');
  const input = productCreateSchema.parse(raw);
  if (input.skus?.some((s) => s.costPrice != null) && !can(actor, 'product.cost.read')) throw forbidden('沒有填寫成本的權限');
  return withTx(async (tx) => {
    const { result, replayed } = await idempotent(tx, actor, 'product.create', idemKey, async () => {
      const v = await tx.query('SELECT 1 FROM vendors WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [input.vendorId, actor.orgId]);
      if (!v.rowCount) throw notFound('廠商');
      const dupe = await tx.query('SELECT id FROM products WHERE organization_id=$1 AND vendor_id=$2 AND normalized_name=$3 AND deleted_at IS NULL', [actor.orgId, input.vendorId, normalizeName(input.name)]);
      if (dupe.rowCount) throw new AppError('CONFLICT', `此廠商已有同名商品：${dupe.rows[0].id}`, { existingId: dupe.rows[0].id });
      const id = await ids.product(tx);
      await tx.query(
        `INSERT INTO products (id, organization_id, vendor_id, name, normalized_name, category, description, listing_url, selling_points, compliance_note, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
        [id, actor.orgId, input.vendorId, input.name, normalizeName(input.name), input.category ?? null, input.description ?? null,
          input.listingUrl ?? null, input.sellingPoints ?? null, input.complianceNote ?? null, actor.userId]);
      const skuIds: string[] = [];
      for (const s of input.skus ?? []) skuIds.push(await insertSku(tx, actor, id, s));
      await audit(tx, actor, { action: 'product.create', entityType: 'product', entityId: id, after: { name: input.name, vendorId: input.vendorId, skuCount: skuIds.length } });
      return { id, skuIds };
    }, input);
    return { ...result, replayed };
  });
}

/** 商品可見範圍：內部角色＝全組織；廠商＝自己的商品；團主＝自己可見檔期內的商品 */
function productScope(actor: Actor, alias = 'p'): { sql: string; params: unknown[] } {
  if (can(actor, 'vendor.read')) return { sql: `${alias}.organization_id=$1 AND ${alias}.deleted_at IS NULL`, params: [actor.orgId] };
  if (actor.role === 'VENDOR') {
    if (!actor.vendorIds.length) return { sql: 'FALSE', params: [] };
    return { sql: `${alias}.organization_id=$1 AND ${alias}.deleted_at IS NULL AND ${alias}.vendor_id = ANY($2::text[])`, params: [actor.orgId, actor.vendorIds] };
  }
  const sc = campaignScope(actor, 1, 'cc');
  if (sc.sql === 'FALSE') return { sql: 'FALSE', params: [] };
  return {
    sql: `${alias}.organization_id=$1 AND ${alias}.deleted_at IS NULL AND EXISTS (
      SELECT 1 FROM campaign_products cp JOIN campaigns cc ON cc.id=cp.campaign_id
      WHERE cp.product_id=${alias}.id AND cp.deleted_at IS NULL AND (${sc.sql}))`,
    params: sc.params,
  };
}

export async function listProducts(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'product.read');
  const sc = productScope(actor);
  const params = [...sc.params];
  const where = [sc.sql];
  const text = nonEmpty(q.get('q'));
  if (text) { params.push(likePattern(text)); where.push(`(p.name ILIKE $${params.length} OR p.id ILIKE $${params.length})`); }
  const vendorId = nonEmpty(q.get('vendorId'));
  if (vendorId) { params.push(vendorId); where.push(`p.vendor_id=$${params.length}`); }
  const rs = nonEmpty(q.get('reviewStatus'));
  if (rs) { params.push(rs); where.push(`p.review_status=$${params.length}`); }
  const res = await listPaged<Record<string, unknown>>(
    `SELECT p.id, p.name, p.vendor_id, v.name AS vendor_name, p.category, p.review_status, p.updated_at, p.version,
       (SELECT count(*)::int FROM skus s WHERE s.product_id=p.id AND s.deleted_at IS NULL) AS sku_count
     FROM products p JOIN vendors v ON v.id=p.vendor_id WHERE ${where.join(' AND ')}`, params, 'p.id DESC', pageParams(q));
  res.items = camelize(res.items);
  return res;
}

export async function getProduct(actor: Actor, id: string) {
  requirePerm(actor, 'product.read');
  const sc = productScope(actor);
  const rows = await query(`SELECT p.*, v.name AS vendor_name FROM products p JOIN vendors v ON v.id=p.vendor_id WHERE p.id=$${sc.params.length + 1} AND ${sc.sql}`, [...sc.params, id]);
  if (!rows.length) throw notFound('商品');
  const showCost = can(actor, 'product.cost.read');
  const skus = (await query('SELECT * FROM skus WHERE product_id=$1 AND deleted_at IS NULL ORDER BY id', [id])).map((s) => {
    if (!showCost) delete (s as Record<string, unknown>)['cost_price'];
    return s;
  });
  const assets = await query('SELECT * FROM product_assets WHERE product_id=$1 AND deleted_at IS NULL ORDER BY id', [id]);
  const out = camelize<Record<string, unknown>>(rows[0]);
  return { ...out, skus: camelize(skus), assets: camelize(assets) };
}

export async function updateProduct(actor: Actor, id: string, raw: z.input<typeof productUpdateSchema>) {
  requirePerm(actor, 'product.write');
  const input = productUpdateSchema.parse(raw);
  return withTx(async (tx) => {
    if (input.name) {
      const cur = await tx.query('SELECT vendor_id FROM products WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [id, actor.orgId]);
      if (!cur.rowCount) throw notFound('商品');
      const dupe = await tx.query('SELECT id FROM products WHERE organization_id=$1 AND vendor_id=$2 AND normalized_name=$3 AND deleted_at IS NULL AND id<>$4', [actor.orgId, cur.rows[0].vendor_id, normalizeName(input.name), id]);
      if (dupe.rowCount) throw new AppError('CONFLICT', `此廠商已有同名商品：${dupe.rows[0].id}`, { existingId: dupe.rows[0].id });
    }
    const { after } = await patchEntity(tx, actor, {
      table: 'products', entityType: 'product', id, patch: input as Record<string, unknown>, allowed: PRODUCT_FIELDS,
      expectedVersion: input.version, derived: (m) => ({ normalized_name: normalizeName(String(m['name'])) }),
    });
    return { id, version: after['version'] };
  });
}

export async function addSku(actor: Actor, productId: string, raw: z.input<typeof skuSchema>) {
  requirePerm(actor, 'product.write');
  const input = skuSchema.parse(raw);
  if (input.costPrice != null && !can(actor, 'product.cost.read')) throw forbidden('沒有填寫成本的權限');
  return withTx(async (tx) => {
    const p = await tx.query('SELECT 1 FROM products WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [productId, actor.orgId]);
    if (!p.rowCount) throw notFound('商品');
    return { id: await insertSku(tx, actor, productId, input) };
  });
}

export const skuUpdateSchema = skuSchema.omit({ skuCode: true }).partial().extend({ version: z.number().int().optional() });
export async function updateSku(actor: Actor, id: string, raw: z.input<typeof skuUpdateSchema>) {
  requirePerm(actor, 'product.write');
  const input = skuUpdateSchema.parse(raw);
  if (input.costPrice !== undefined && !can(actor, 'product.cost.read')) throw forbidden('沒有修改成本的權限');
  validateSkuPrices(input);
  return withTx(async (tx) => {
    const { after } = await patchEntity(tx, actor, {
      table: 'skus', entityType: 'sku', id, patch: input as Record<string, unknown>,
      allowed: ['name', 'listPrice', 'groupPrice', 'costPrice', 'status'], expectedVersion: input.version,
    });
    return { id, version: after['version'] };
  });
}

export const REVIEW_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['PENDING_REVIEW'],
  PENDING_REVIEW: ['APPROVED', 'REJECTED', 'DRAFT'],
  REJECTED: ['DRAFT', 'PENDING_REVIEW'],
  APPROVED: ['DRAFT'],
};

export async function setProductReview(actor: Actor, id: string, to: string, note?: string) {
  const toStatus = z.enum(['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED']).parse(to);
  // 送審：寫入權限；核准／退回：審核權限
  requirePerm(actor, toStatus === 'APPROVED' || toStatus === 'REJECTED' ? 'product.review' : 'product.write');
  return withTx(async (tx) => {
    const cur = await tx.query('SELECT review_status FROM products WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL FOR UPDATE', [id, actor.orgId]);
    if (!cur.rowCount) throw notFound('商品');
    const from = cur.rows[0].review_status as string;
    if (!REVIEW_TRANSITIONS[from]?.includes(toStatus)) throw new AppError('PRECONDITION_FAILED', `商品審核狀態不可由 ${from} 變更為 ${toStatus}`);
    if (toStatus === 'REJECTED' && !note?.trim()) throw validation('退回需填寫原因');
    if (toStatus === 'PENDING_REVIEW') {
      const sku = await tx.query(`SELECT count(*)::int AS n FROM skus WHERE product_id=$1 AND deleted_at IS NULL AND status='ACTIVE'`, [id]);
      if (sku.rows[0].n === 0) throw new AppError('PRECONDITION_FAILED', '送審前至少需要一個啟用中的規格（SKU）');
    }
    const decided = toStatus === 'APPROVED' || toStatus === 'REJECTED';
    await tx.query('UPDATE products SET review_status=$2, review_note=$3, reviewed_by=$4, reviewed_at=$5, updated_by=$6 WHERE id=$1',
      [id, toStatus, note ?? null, decided ? actor.userId : null, decided ? new Date() : null, actor.userId]);
    await audit(tx, actor, { action: 'product.review', entityType: 'product', entityId: id, before: { reviewStatus: from }, after: { reviewStatus: toStatus }, reason: note ?? null });
    return { id, reviewStatus: toStatus };
  });
}

export const assetSchema = z.object({
  kind: z.enum(['IMAGE', 'DOCUMENT', 'CERTIFICATE', 'LINK', 'OTHER']),
  title: z.string().trim().min(1).max(160),
  url: z.string().trim().url('連結格式不正確').max(500),
});
export async function addAsset(actor: Actor, productId: string, raw: z.input<typeof assetSchema>) {
  requirePerm(actor, 'product.write');
  const input = assetSchema.parse(raw);
  if (!/^https?:\/\//i.test(input.url)) throw validation('素材連結只接受 http(s)');
  return withTx(async (tx) => {
    const p = await tx.query('SELECT 1 FROM products WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [productId, actor.orgId]);
    if (!p.rowCount) throw notFound('商品');
    const id = await ids.asset(tx);
    await tx.query('INSERT INTO product_assets (id, organization_id, product_id, kind, title, url, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)',
      [id, actor.orgId, productId, input.kind, input.title, input.url, actor.userId]);
    await audit(tx, actor, { action: 'product_asset.create', entityType: 'product_asset', entityId: id, after: { productId, ...input } });
    return { id };
  });
}
