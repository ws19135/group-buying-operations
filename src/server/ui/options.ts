import { query } from '@/server/lib/db';
import type { Actor } from '@/server/lib/permissions';
import { can } from '@/server/lib/permissions';

export interface Opt { value: string; label: string }

export async function vendorOptions(actor: Actor): Promise<Opt[]> {
  if (!can(actor, 'vendor.read') && !can(actor, 'vendor.self')) return [];
  const rows = can(actor, 'vendor.read')
    ? await query<{ id: string; name: string }>(`SELECT id, name FROM vendors WHERE organization_id=$1 AND deleted_at IS NULL ORDER BY name LIMIT 500`, [actor.orgId])
    : await query<{ id: string; name: string }>(`SELECT id, name FROM vendors WHERE organization_id=$1 AND deleted_at IS NULL AND id = ANY($2::text[]) ORDER BY name`, [actor.orgId, actor.vendorIds]);
  return rows.map((r) => ({ value: r.id, label: `${r.name}（${r.id}）` }));
}

export async function hostOptions(actor: Actor): Promise<Opt[]> {
  if (!can(actor, 'host.read')) return [];
  const rows = await query<{ id: string; display_name: string; status: string }>(`SELECT id, display_name, status FROM hosts WHERE organization_id=$1 AND deleted_at IS NULL AND status<>'ENDED' ORDER BY display_name LIMIT 500`, [actor.orgId]);
  return rows.map((r) => ({ value: r.id, label: `${r.display_name}（${r.id}）` }));
}

export async function communityOptions(actor: Actor): Promise<Opt[]> {
  if (!can(actor, 'community.read')) return [];
  const rows = await query<{ id: string; name: string; platform: string }>(`SELECT id, name, platform FROM communities WHERE organization_id=$1 AND deleted_at IS NULL AND status<>'ENDED' ORDER BY name LIMIT 500`, [actor.orgId]);
  return rows.map((r) => ({ value: r.id, label: `${r.name}（${r.platform}）` }));
}

/** 某廠商的商品／規格選項（value = productId|skuId） */
export async function productSkuOptions(actor: Actor, vendorId: string): Promise<Opt[]> {
  const rows = await query<{ pid: string; pname: string; sid: string | null; sname: string | null; code: string | null }>(
    `SELECT p.id AS pid, p.name AS pname, s.id AS sid, s.name AS sname, s.sku_code AS code FROM products p
     LEFT JOIN skus s ON s.product_id=p.id AND s.deleted_at IS NULL AND s.status='ACTIVE'
     WHERE p.organization_id=$1 AND p.vendor_id=$2 AND p.deleted_at IS NULL ORDER BY p.name, s.sku_code LIMIT 300`, [actor.orgId, vendorId]);
  return rows.map((r) => ({ value: `${r.pid}|${r.sid ?? ''}`, label: `${r.pname}${r.sid ? ` ／ ${r.sname}（${r.code}）` : '（整個商品）'}` }));
}

/** 檔期內各團主已連結的社群（value = hostId|communityId） */
export async function hostCommunityOptions(actor: Actor, hostIds: string[]): Promise<Opt[]> {
  if (!hostIds.length) return [];
  const rows = await query<{ hid: string; hname: string; cid: string; cname: string; platform: string }>(
    `SELECT h.id AS hid, h.display_name AS hname, c.id AS cid, c.name AS cname, c.platform FROM host_communities hc
     JOIN hosts h ON h.id=hc.host_id JOIN communities c ON c.id=hc.community_id
     WHERE hc.organization_id=$1 AND hc.ended_at IS NULL AND c.deleted_at IS NULL AND hc.host_id = ANY($2::text[]) ORDER BY h.display_name, c.name`, [actor.orgId, hostIds]);
  return rows.map((r) => ({ value: `${r.hid}|${r.cid}`, label: `${r.hname} ／ ${r.cname}（${r.platform}）` }));
}
