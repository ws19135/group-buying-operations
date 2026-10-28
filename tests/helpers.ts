import { randomUUID } from 'node:crypto';
import { query, withTx } from '@/server/lib/db';
import type { Actor, RoleKey } from '@/server/lib/permissions';
import { createInitialUser, createOrganization } from '@/server/modules/org';
import { createVendor } from '@/server/modules/vendors';
import { createProduct } from '@/server/modules/products';
import { createHost, createCommunity } from '@/server/modules/hosts';
import { createCampaign } from '@/server/modules/campaigns';
import { addDays } from '@/server/lib/dates';
import { todayTaipei } from '@/server/lib/ids';

export interface World {
  orgId: string;
  sys: Actor;
  admin: Actor;
  manager: Actor;
  editor: Actor;
  editor2: Actor;
  finance: Actor;
}

export const PW = 'Test-Password-123';

export function mkActor(orgId: string, userId: string, role: RoleKey, extra: Partial<Actor> = {}): Actor {
  return { type: 'USER', userId, orgId, role, name: role, hostIds: [], vendorIds: [], requestId: randomUUID(), source: 'TEST', ...extra };
}

export async function addUser(orgId: string, role: RoleKey, opts: { hostIds?: string[]; vendorIds?: string[]; email?: string } = {}): Promise<Actor> {
  const email = opts.email ?? `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@example.invalid`;
  const id = await withTx((tx) => createInitialUser(tx, orgId, { email, name: `${role}-測試`, role, password: PW, hostIds: opts.hostIds, vendorIds: opts.vendorIds }));
  return mkActor(orgId, id, role, { hostIds: opts.hostIds ?? [], vendorIds: opts.vendorIds ?? [] });
}

/** 每個測試檔建立自己的組織，彼此資料隔離，可平行執行 */
export async function makeWorld(): Promise<World> {
  const { orgId, systemActor } = await createOrganization(`測試組織-${randomUUID().slice(0, 6)}`, 'TEST');
  return {
    orgId, sys: systemActor,
    admin: await addUser(orgId, 'SYSTEM_ADMIN'),
    manager: await addUser(orgId, 'OPS_MANAGER'),
    editor: await addUser(orgId, 'OPS_EDITOR'),
    editor2: await addUser(orgId, 'OPS_EDITOR'),
    finance: await addUser(orgId, 'FINANCE'),
  };
}

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${randomUUID().slice(0, 4)}`;

export async function mkVendor(w: World, name = `廠商${uniq()}`, extra: Record<string, unknown> = {}) {
  const r = await createVendor(w.manager, { name, status: 'ACTIVE', companyName: `${name}股份有限公司`, category: '食品', contacts: [{ name: '王小明', email: 'v@example.invalid', isPrimary: true }], ...extra });
  return { id: r.id, name };
}

export async function mkProduct(w: World, vendorId: string, opts: { name?: string; skus?: { skuCode: string; name: string; listPrice?: number; groupPrice?: number; costPrice?: number }[]; approve?: boolean } = {}) {
  const r = await createProduct(w.manager, {
    vendorId, name: opts.name ?? `商品${uniq()}`,
    skus: opts.skus ?? [{ skuCode: 'A', name: '規格A', listPrice: 1000, groupPrice: 800, costPrice: 500 }],
  });
  if (opts.approve) await query(`UPDATE products SET review_status='APPROVED' WHERE id=$1`, [r.id]);
  return { id: r.id, skuIds: r.skuIds };
}

export async function mkHost(w: World, name = `團主${uniq()}`) {
  const r = await createHost(w.manager, { displayName: name });
  return { id: r.id, name };
}

export async function mkCommunity(w: World, hostIds: string[], name = `社群${uniq()}`) {
  const r = await createCommunity(w.manager, { platform: 'LINE', name }, hostIds);
  return { id: r.id, name };
}

export async function mkCampaign(w: World, vendorId: string, over: Record<string, unknown> = {}) {
  const today = todayTaipei();
  const r = await createCampaign(w.editor, {
    title: `檔期${uniq()}`, vendorId,
    sampleReadyDate: addDays(today, 5), openDate: addDays(today, 40), closeDate: addDays(today, 50),
    ...over,
  } as never);
  return r;
}

export const dayOffset = (n: number) => addDays(todayTaipei(), n);
