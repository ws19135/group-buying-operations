import { query } from '@/server/lib/db';
import type { ProductOpt } from './CollaborationForms';

/**
 * 可申請的商品／規格（value = `productId|skuId`，附 vendorId 供前端依廠商過濾）。
 * 刻意不用 productSkuOptions：那支只收單一廠商，這裡的建立與匯入畫面要一次拿到多家。
 */
export async function collaborationProductOptions(orgId: string, vendorIds: string[] | null): Promise<ProductOpt[]> {
  const params: unknown[] = [orgId];
  let filter = '';
  if (vendorIds) {
    if (!vendorIds.length) return [];
    params.push(vendorIds);
    filter = ` AND p.vendor_id = ANY($${params.length}::text[])`;
  }
  const rows = await query<{ pid: string; pname: string; vid: string; sid: string | null; sname: string | null; code: string | null }>(
    `SELECT p.id AS pid, p.name AS pname, p.vendor_id AS vid, s.id AS sid, s.name AS sname, s.sku_code AS code
       FROM products p
       LEFT JOIN skus s ON s.product_id = p.id AND s.deleted_at IS NULL AND s.status='ACTIVE'
      WHERE p.organization_id=$1 AND p.deleted_at IS NULL${filter}
      ORDER BY p.name, s.sku_code LIMIT 500`, params);
  return rows.map((r) => ({
    value: `${r.pid}|${r.sid ?? ''}`,
    label: `${r.pname}${r.sid ? ` ／ ${r.sname}（${r.code}）` : '（整個商品）'}`,
    vendorId: r.vid,
  }));
}
