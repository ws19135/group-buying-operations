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
import { likePattern, listPaged, pageParams, patchEntity, type ListResult } from '../lib/repo';
import { idempotent } from '../lib/idempotency';

export const VENDOR_STATUS = ['PROSPECT', 'CONTACTED', 'ACTIVE', 'PAUSED', 'BLACKLISTED'] as const;

const taxId = z.string().trim().regex(/^\d{8}$/, '統一編號需為 8 碼數字').optional().or(z.literal('').transform(() => undefined));
const optText = (max = 500) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));

export const contactSchema = z.object({
  name: z.string().trim().min(1, '請輸入聯絡人姓名').max(80),
  title: optText(80),
  email: z.string().trim().email('Email 格式不正確').optional().or(z.literal('').transform(() => undefined)),
  phone: optText(40),
  lineId: optText(80),
  isPrimary: z.boolean().optional(),
});

export const vendorCreateSchema = z.object({
  name: z.string().trim().min(1, '請輸入廠商／品牌名稱').max(120),
  companyName: optText(160),
  taxId,
  category: optText(60),
  website: optText(300),
  status: z.enum(VENDOR_STATUS).optional(),
  cooperationNote: optText(2000),
  internalNote: optText(2000),
  contacts: z.array(contactSchema).max(20).optional(),
});

export const vendorUpdateSchema = vendorCreateSchema.omit({ contacts: true }).partial().extend({ version: z.number().int().optional() });

const VENDOR_FIELDS = ['name', 'companyName', 'taxId', 'category', 'website', 'status', 'cooperationNote', 'internalNote'] as const;

/** 判斷「待補資料」：ACTIVE 廠商必須齊全，其他狀態僅提示 */
export function computeVendorMissing(v: { company_name?: string | null; tax_id?: string | null; category?: string | null }, contacts: { email?: string | null; phone?: string | null; line_id?: string | null; is_primary?: boolean }[]): string[] {
  const miss: string[] = [];
  if (!v.company_name) miss.push('公司全名（開立發票用）');
  if (!v.tax_id) miss.push('統一編號');
  if (!v.category) miss.push('類別');
  const primary = contacts.find((c) => c.is_primary) ?? contacts[0];
  if (!primary) miss.push('主要聯絡人');
  else if (!primary.email && !primary.phone && !primary.line_id) miss.push('聯絡方式（Email／電話／LINE）');
  return miss;
}

async function findDuplicate(db: Tx, orgId: string, name: string, taxIdVal: string | undefined, excludeId?: string) {
  const r = await db.query(
    `SELECT id, name, tax_id FROM vendors WHERE organization_id=$1 AND deleted_at IS NULL
       AND (normalized_name=$2 OR ($3::text IS NOT NULL AND tax_id=$3)) AND ($4::text IS NULL OR id<>$4) LIMIT 1`,
    [orgId, normalizeName(name), taxId ?? null, excludeId ?? null]);
  return r.rows[0] as { id: string; name: string; tax_id: string | null } | undefined;
}

export async function insertVendor(tx: Tx, actor: Actor, input: z.output<typeof vendorCreateSchema>) {
  const dupe = await findDuplicate(tx, actor.orgId, input.name, input.taxId);
  if (dupe) throw new AppError('CONFLICT', `已有相同廠商：${dupe.id}（${dupe.name}）`, { existingId: dupe.id });
  const id = await ids.vendor(tx);
  await tx.query(
    `INSERT INTO vendors (id, organization_id, name, normalized_name, company_name, tax_id, category, website, status,
       cooperation_note, internal_note, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
    [id, actor.orgId, input.name, normalizeName(input.name), input.companyName ?? null, input.taxId ?? null, input.category ?? null,
      input.website ?? null, input.status ?? 'PROSPECT', input.cooperationNote ?? null, input.internalNote ?? null, actor.userId]);
  const contacts = input.contacts ?? [];
  if (contacts.length && !contacts.some((c) => c.isPrimary)) contacts[0].isPrimary = true;
  for (const c of contacts) await insertContact(tx, actor, id, c);
  await audit(tx, actor, { action: 'vendor.create', entityType: 'vendor', entityId: id, after: { name: input.name, status: input.status ?? 'PROSPECT' } });
  return id;
}

async function insertContact(tx: Tx, actor: Actor, vendorId: string, c: z.output<typeof contactSchema>) {
  const id = await ids.vendorContact(tx);
  if (c.isPrimary) await tx.query('UPDATE vendor_contacts SET is_primary=false WHERE vendor_id=$1 AND is_primary AND deleted_at IS NULL', [vendorId]);
  await tx.query(
    `INSERT INTO vendor_contacts (id, organization_id, vendor_id, name, title, email, phone, line_id, is_primary, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
    [id, actor.orgId, vendorId, c.name, c.title ?? null, c.email ?? null, c.phone ?? null, c.lineId ?? null, !!c.isPrimary, actor.userId]);
  await audit(tx, actor, { action: 'vendor_contact.create', entityType: 'vendor_contact', entityId: id, after: { vendorId, name: c.name, isPrimary: !!c.isPrimary } });
  return id;
}

export async function createVendor(actor: Actor, raw: z.input<typeof vendorCreateSchema>, idemKey?: string | null) {
  requirePerm(actor, 'vendor.write');
  const input = vendorCreateSchema.parse(raw);
  return withTx(async (tx) => {
    const { result, replayed } = await idempotent(tx, actor, 'vendor.create', idemKey, async () => ({ id: await insertVendor(tx, actor, input) }), input);
    return { ...result, replayed };
  });
}

function assertVendorAccess(actor: Actor, vendorId: string) {
  if (can(actor, 'vendor.read')) return;
  if (can(actor, 'vendor.self') && actor.vendorIds.includes(vendorId)) return;
  throw forbidden();
}

export async function listVendors(actor: Actor, q: URLSearchParams): Promise<ListResult<Record<string, unknown>>> {
  if (!can(actor, 'vendor.read') && !can(actor, 'vendor.self')) throw forbidden();
  const params: unknown[] = [actor.orgId];
  const where = ['v.organization_id=$1', 'v.deleted_at IS NULL'];
  if (!can(actor, 'vendor.read')) {
    params.push(actor.vendorIds);
    where.push(`v.id = ANY($${params.length}::text[])`);
  }
  const text = nonEmpty(q.get('q'));
  if (text) { params.push(likePattern(text)); where.push(`(v.name ILIKE $${params.length} OR v.company_name ILIKE $${params.length} OR v.id ILIKE $${params.length})`); }
  const status = nonEmpty(q.get('status'));
  if (status) { params.push(status); where.push(`v.status=$${params.length}`); }
  const category = nonEmpty(q.get('category'));
  if (category) { params.push(category); where.push(`v.category=$${params.length}`); }
  const res = await listPaged<Record<string, unknown>>(
    `SELECT v.id, v.name, v.company_name, v.tax_id, v.category, v.status, v.website, v.updated_at, v.version,
       (SELECT count(*)::int FROM campaigns c WHERE c.vendor_id=v.id AND c.deleted_at IS NULL) AS campaign_count,
       (SELECT count(*)::int FROM products p WHERE p.vendor_id=v.id AND p.deleted_at IS NULL) AS product_count,
       (SELECT row_to_json(pc) FROM (SELECT name, email, phone, line_id FROM vendor_contacts vc WHERE vc.vendor_id=v.id AND vc.deleted_at IS NULL ORDER BY is_primary DESC, id LIMIT 1) pc) AS primary_contact
     FROM vendors v WHERE ${where.join(' AND ')}`, params, 'v.id DESC', pageParams(q));
  res.items = res.items.map((v) => {
    const row = v as { company_name: string | null; tax_id: string | null; category: string | null; primary_contact: { email: string | null; phone: string | null; line_id: string | null; name: string } | null };
    const missing = computeVendorMissing(row, row.primary_contact ? [{ ...row.primary_contact, is_primary: true }] : []);
    return { ...camelize<Record<string, unknown>>(v), missingFields: missing };
  });
  const miss = nonEmpty(q.get('missing'));
  if (miss === '1') res.items = res.items.filter((v) => (v.missingFields as string[]).length > 0);
  return res;
}

export async function getVendor(actor: Actor, id: string) {
  assertVendorAccess(actor, id);
  const rows = await query('SELECT * FROM vendors WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [id, actor.orgId]);
  if (!rows.length) throw notFound('廠商');
  const v = rows[0] as Record<string, unknown>;
  const contacts = await query('SELECT * FROM vendor_contacts WHERE vendor_id=$1 AND deleted_at IS NULL ORDER BY is_primary DESC, id', [id]);
  const internal = can(actor, 'vendor.read');
  const products = await query(
    `SELECT id, name, category, review_status FROM products WHERE vendor_id=$1 AND organization_id=$2 AND deleted_at IS NULL ORDER BY id`, [id, actor.orgId]);
  const campaigns = internal
    ? await query(`SELECT id, title, status, open_date, close_date FROM campaigns WHERE vendor_id=$1 AND organization_id=$2 AND deleted_at IS NULL ORDER BY open_date DESC NULLS LAST, id DESC LIMIT 50`, [id, actor.orgId])
    : await query(`SELECT id, title, status, open_date, close_date FROM campaigns WHERE vendor_id=$1 AND organization_id=$2 AND deleted_at IS NULL AND status NOT IN ('DRAFT','CANCELLED') ORDER BY open_date DESC NULLS LAST LIMIT 50`, [id, actor.orgId]);
  const missing = computeVendorMissing(v as { company_name: string | null; tax_id: string | null; category: string | null }, contacts as { email?: string | null; phone?: string | null; line_id?: string | null; is_primary?: boolean }[]);
  const anomalies: string[] = [];
  if (v.status === 'ACTIVE' && missing.length) anomalies.push(`合作中但資料不齊：${missing.join('、')}`);
  if ((v.status === 'PAUSED' || v.status === 'BLACKLISTED') && (campaigns as { status: string }[]).some((c) => ['RUNNING', 'SCHEDULED', 'PREPARING'].includes(c.status))) anomalies.push('廠商已暫停／列黑名單，但仍有進行中或籌備中的檔期');
  const out = camelize<Record<string, unknown>>(v);
  if (!internal) delete out.internalNote;
  return {
    ...out,
    contacts: camelize(contacts),
    products: camelize(products),
    campaigns: camelize(campaigns),
    missingFields: missing,
    anomalies: internal ? anomalies : [],
  };
}

export async function updateVendor(actor: Actor, id: string, raw: z.input<typeof vendorUpdateSchema>) {
  requirePerm(actor, 'vendor.write');
  const input = vendorUpdateSchema.parse(raw);
  return withTx(async (tx) => {
    if (input.name || input.taxId) {
      const cur = await tx.query('SELECT name, tax_id FROM vendors WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [id, actor.orgId]);
      if (!cur.rowCount) throw notFound('廠商');
      const dupe = await findDuplicate(tx, actor.orgId, input.name ?? cur.rows[0].name, input.taxId ?? undefined, id);
      if (dupe) throw new AppError('CONFLICT', `已有相同廠商：${dupe.id}（${dupe.name}）`, { existingId: dupe.id });
    }
    const { after } = await patchEntity(tx, actor, {
      table: 'vendors', entityType: 'vendor', id, patch: input as Record<string, unknown>, allowed: VENDOR_FIELDS,
      expectedVersion: input.version,
      derived: (m) => ({ normalized_name: normalizeName(String(m['name'])) }),
    });
    return { id, version: after['version'] };
  });
}

export async function archiveVendor(actor: Actor, id: string, reason: string) {
  requirePerm(actor, 'vendor.write');
  if (!reason?.trim()) throw validation('請填寫停用原因');
  return withTx(async (tx) => {
    const open = await tx.query(
      `SELECT count(*)::int AS n FROM campaigns WHERE vendor_id=$1 AND organization_id=$2 AND deleted_at IS NULL
         AND status NOT IN ('CLOSED','CANCELLED','SETTLED')`, [id, actor.orgId]);
    if (open.rows[0].n > 0) throw new AppError('PRECONDITION_FAILED', `此廠商仍有 ${open.rows[0].n} 檔未結案的團購，無法封存`);
    const cur = await tx.query('SELECT * FROM vendors WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL FOR UPDATE', [id, actor.orgId]);
    if (!cur.rowCount) throw notFound('廠商');
    await tx.query('UPDATE vendors SET deleted_at=now(), updated_by=$2 WHERE id=$1', [id, actor.userId]);
    await audit(tx, actor, { action: 'vendor.archive', entityType: 'vendor', entityId: id, before: { name: cur.rows[0].name, status: cur.rows[0].status }, reason });
    return { id };
  });
}

export async function addVendorContact(actor: Actor, vendorId: string, raw: z.input<typeof contactSchema>) {
  requirePerm(actor, 'vendor.write');
  const input = contactSchema.parse(raw);
  return withTx(async (tx) => {
    const v = await tx.query('SELECT 1 FROM vendors WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [vendorId, actor.orgId]);
    if (!v.rowCount) throw notFound('廠商');
    return { id: await insertContact(tx, actor, vendorId, input) };
  });
}

export async function archiveVendorContact(actor: Actor, contactId: string) {
  requirePerm(actor, 'vendor.write');
  return withTx(async (tx) => {
    const c = await tx.query('SELECT * FROM vendor_contacts WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL FOR UPDATE', [contactId, actor.orgId]);
    if (!c.rowCount) throw notFound('聯絡人');
    await tx.query('UPDATE vendor_contacts SET deleted_at=now(), is_primary=false, updated_by=$2 WHERE id=$1', [contactId, actor.userId]);
    await audit(tx, actor, { action: 'vendor_contact.archive', entityType: 'vendor_contact', entityId: contactId, before: { name: c.rows[0].name, vendorId: c.rows[0].vendor_id } });
    return { id: contactId };
  });
}
