import { z } from 'zod';
import { query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, requirePerm } from '../lib/permissions';
import { AppError, forbidden, notFound, validation } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids } from '../lib/ids';
import { normalizeName, nonEmpty } from '../lib/text';
import { camelize } from '../lib/case';
import { isIsoDate } from '../lib/dates';
import { likePattern, listPaged, pageParams, patchEntity } from '../lib/repo';
import { idempotent } from '../lib/idempotency';

const optText = (max = 500) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));
export const HOST_STATUS = ['ACTIVE', 'PAUSED', 'ENDED'] as const;
export const PLATFORMS = ['LINE', 'FACEBOOK', 'INSTAGRAM', 'THREADS', 'YOUTUBE', 'OTHER'] as const;

export const hostCreateSchema = z.object({
  displayName: z.string().trim().min(1, '請輸入團主名稱').max(80),
  legalName: optText(120),
  contactEmail: z.string().trim().email('Email 格式不正確').optional().or(z.literal('').transform(() => undefined)),
  contactPhone: optText(40),
  lineId: optText(80),
  status: z.enum(HOST_STATUS).optional(),
  audienceNote: optText(1000),
  cooperationTerms: optText(2000),
  internalNote: optText(2000),
});
export const hostUpdateSchema = hostCreateSchema.partial().extend({ version: z.number().int().optional() });
const HOST_FIELDS = ['displayName', 'legalName', 'contactEmail', 'contactPhone', 'lineId', 'status', 'audienceNote', 'cooperationTerms', 'internalNote'] as const;

export async function createHost(actor: Actor, raw: z.input<typeof hostCreateSchema>, idemKey?: string | null) {
  requirePerm(actor, 'host.write');
  const input = hostCreateSchema.parse(raw);
  return withTx(async (tx) => {
    const { result, replayed } = await idempotent(tx, actor, 'host.create', idemKey, async () => {
      const dupe = await tx.query('SELECT id, display_name FROM hosts WHERE organization_id=$1 AND normalized_name=$2 AND deleted_at IS NULL', [actor.orgId, normalizeName(input.displayName)]);
      if (dupe.rowCount) throw new AppError('CONFLICT', `已有相同團主：${dupe.rows[0].id}（${dupe.rows[0].display_name}）`, { existingId: dupe.rows[0].id });
      const id = await ids.host(tx);
      await tx.query(
        `INSERT INTO hosts (id, organization_id, display_name, normalized_name, legal_name, contact_email, contact_phone, line_id, status,
           audience_note, cooperation_terms, internal_note, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
        [id, actor.orgId, input.displayName, normalizeName(input.displayName), input.legalName ?? null, input.contactEmail ?? null,
          input.contactPhone ?? null, input.lineId ?? null, input.status ?? 'ACTIVE', input.audienceNote ?? null,
          input.cooperationTerms ?? null, input.internalNote ?? null, actor.userId]);
      await audit(tx, actor, { action: 'host.create', entityType: 'host', entityId: id, after: { displayName: input.displayName } });
      return { id };
    });
    return { ...result, replayed };
  });
}

function assertHostAccess(actor: Actor, hostId: string) {
  if (can(actor, 'host.read')) return;
  if (can(actor, 'host.self') && actor.hostIds.includes(hostId)) return;
  throw forbidden();
}

export async function listHosts(actor: Actor, q: URLSearchParams) {
  if (!can(actor, 'host.read') && !can(actor, 'host.self')) throw forbidden();
  const params: unknown[] = [actor.orgId];
  const where = ['h.organization_id=$1', 'h.deleted_at IS NULL'];
  if (!can(actor, 'host.read')) { params.push(actor.hostIds); where.push(`h.id = ANY($${params.length}::text[])`); }
  const text = nonEmpty(q.get('q'));
  if (text) { params.push(likePattern(text)); where.push(`(h.display_name ILIKE $${params.length} OR h.id ILIKE $${params.length})`); }
  const status = nonEmpty(q.get('status'));
  if (status) { params.push(status); where.push(`h.status=$${params.length}`); }
  const res = await listPaged<Record<string, unknown>>(
    `SELECT h.id, h.display_name, h.status, h.contact_email, h.line_id, h.updated_at, h.version,
       (SELECT count(*)::int FROM host_communities hc WHERE hc.host_id=h.id AND hc.ended_at IS NULL) AS community_count,
       (SELECT count(*)::int FROM campaign_hosts ch WHERE ch.host_id=h.id AND ch.deleted_at IS NULL) AS campaign_count
     FROM hosts h WHERE ${where.join(' AND ')}`, params, 'h.id DESC', pageParams(q));
  res.items = camelize(res.items);
  return res;
}

export async function getHost(actor: Actor, id: string) {
  assertHostAccess(actor, id);
  const rows = await query('SELECT * FROM hosts WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [id, actor.orgId]);
  if (!rows.length) throw notFound('團主');
  const internal = can(actor, 'host.read');
  const communities = await query(
    `SELECT c.id, c.platform, c.name, c.status, hc.role FROM host_communities hc JOIN communities c ON c.id=hc.community_id
     WHERE hc.host_id=$1 AND hc.ended_at IS NULL AND c.deleted_at IS NULL ORDER BY c.id`, [id]);
  const availability = await query(
    `SELECT id, start_date, end_date, kind, note FROM host_availability WHERE host_id=$1 AND deleted_at IS NULL ORDER BY start_date`, [id]);
  const history = await query(
    `SELECT c.id, c.title, c.status, c.open_date, c.close_date, ch.status AS participation_status, ch.role
     FROM campaign_hosts ch JOIN campaigns c ON c.id=ch.campaign_id
     WHERE ch.host_id=$1 AND ch.deleted_at IS NULL AND c.deleted_at IS NULL ORDER BY c.open_date DESC NULLS LAST LIMIT 100`, [id]);
  const out = camelize<Record<string, unknown>>(rows[0]);
  if (!internal) delete out.internalNote;
  return { ...out, communities: camelize(communities), availability: camelize(availability), history: camelize(history) };
}

export async function updateHost(actor: Actor, id: string, raw: z.input<typeof hostUpdateSchema>) {
  requirePerm(actor, 'host.write');
  const input = hostUpdateSchema.parse(raw);
  return withTx(async (tx) => {
    if (input.displayName) {
      const dupe = await tx.query('SELECT id FROM hosts WHERE organization_id=$1 AND normalized_name=$2 AND deleted_at IS NULL AND id<>$3', [actor.orgId, normalizeName(input.displayName), id]);
      if (dupe.rowCount) throw new AppError('CONFLICT', `已有相同團主：${dupe.rows[0].id}`, { existingId: dupe.rows[0].id });
    }
    const { after } = await patchEntity(tx, actor, {
      table: 'hosts', entityType: 'host', id, patch: input as Record<string, unknown>, allowed: HOST_FIELDS,
      expectedVersion: input.version, derived: (m) => ({ normalized_name: normalizeName(String(m['display_name'])) }),
    });
    return { id, version: after['version'] };
  });
}

export async function archiveHost(actor: Actor, id: string, reason: string) {
  requirePerm(actor, 'host.write');
  if (!reason?.trim()) throw validation('請填寫封存原因');
  return withTx(async (tx) => {
    const open = await tx.query(
      `SELECT count(*)::int AS n FROM campaign_hosts ch JOIN campaigns c ON c.id=ch.campaign_id
       WHERE ch.host_id=$1 AND ch.deleted_at IS NULL AND c.deleted_at IS NULL AND ch.status<>'DECLINED'
         AND c.status NOT IN ('CLOSED','CANCELLED','SETTLED')`, [id]);
    if (open.rows[0].n > 0) throw new AppError('PRECONDITION_FAILED', `此團主仍參與 ${open.rows[0].n} 檔未結案的團購，無法封存`);
    const cur = await tx.query('SELECT * FROM hosts WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL FOR UPDATE', [id, actor.orgId]);
    if (!cur.rowCount) throw notFound('團主');
    await tx.query('UPDATE hosts SET deleted_at=now(), updated_by=$2 WHERE id=$1', [id, actor.userId]);
    await audit(tx, actor, { action: 'host.archive', entityType: 'host', entityId: id, before: { displayName: cur.rows[0].display_name }, reason });
    return { id };
  });
}

// ---- 可承接檔期 ----
export const availabilitySchema = z.object({
  startDate: z.string().refine(isIsoDate, '開始日期格式需為 YYYY-MM-DD'),
  endDate: z.string().refine(isIsoDate, '結束日期格式需為 YYYY-MM-DD'),
  kind: z.enum(['AVAILABLE', 'BLOCKED']),
  note: optText(300),
}).refine((v) => v.startDate <= v.endDate, { message: '開始日期不可晚於結束日期', path: ['endDate'] });

export async function addAvailability(actor: Actor, hostId: string, raw: z.input<typeof availabilitySchema>) {
  requirePerm(actor, 'host.write');
  const input = availabilitySchema.parse(raw);
  return withTx(async (tx) => {
    const h = await tx.query('SELECT 1 FROM hosts WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [hostId, actor.orgId]);
    if (!h.rowCount) throw notFound('團主');
    const id = await ids.availability(tx);
    await tx.query(`INSERT INTO host_availability (id, organization_id, host_id, start_date, end_date, kind, note, created_by, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`, [id, actor.orgId, hostId, input.startDate, input.endDate, input.kind, input.note ?? null, actor.userId]);
    await audit(tx, actor, { action: 'host_availability.create', entityType: 'host_availability', entityId: id, after: { hostId, ...input } });
    return { id };
  });
}

export async function removeAvailability(actor: Actor, id: string) {
  requirePerm(actor, 'host.write');
  return withTx(async (tx) => {
    const r = await tx.query('UPDATE host_availability SET deleted_at=now(), updated_by=$3 WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL RETURNING host_id, start_date, end_date, kind', [id, actor.orgId, actor.userId]);
    if (!r.rowCount) throw notFound('可承接檔期');
    await audit(tx, actor, { action: 'host_availability.remove', entityType: 'host_availability', entityId: id, before: r.rows[0] });
    return { id };
  });
}

// ---- 社群 ----
export const communityCreateSchema = z.object({
  platform: z.enum(PLATFORMS),
  name: z.string().trim().min(1, '請輸入社群名稱').max(120),
  url: optText(300),
  memberCount: z.number().int().min(0).optional(),
  status: z.enum(HOST_STATUS).optional(),
  note: optText(1000),
});
export const communityUpdateSchema = communityCreateSchema.partial().extend({ version: z.number().int().optional() });
const COMMUNITY_FIELDS = ['platform', 'name', 'url', 'memberCount', 'status', 'note'] as const;

export async function createCommunity(actor: Actor, raw: z.input<typeof communityCreateSchema>, hostIds: string[] = [], idemKey?: string | null) {
  requirePerm(actor, 'community.write');
  const input = communityCreateSchema.parse(raw);
  return withTx(async (tx) => {
    const { result, replayed } = await idempotent(tx, actor, 'community.create', idemKey, async () => {
      const dupe = await tx.query('SELECT id FROM communities WHERE organization_id=$1 AND platform=$2 AND normalized_name=$3 AND deleted_at IS NULL', [actor.orgId, input.platform, normalizeName(input.name)]);
      if (dupe.rowCount) throw new AppError('CONFLICT', `此平台已有同名社群：${dupe.rows[0].id}`, { existingId: dupe.rows[0].id });
      const id = await ids.community(tx);
      await tx.query(
        `INSERT INTO communities (id, organization_id, platform, name, normalized_name, url, member_count, status, note, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
        [id, actor.orgId, input.platform, input.name, normalizeName(input.name), input.url ?? null, input.memberCount ?? null, input.status ?? 'ACTIVE', input.note ?? null, actor.userId]);
      for (const hid of hostIds) await linkHostCommunityTx(tx, actor, hid, id, 'OWNER');
      await audit(tx, actor, { action: 'community.create', entityType: 'community', entityId: id, after: { name: input.name, platform: input.platform } });
      return { id };
    });
    return { ...result, replayed };
  });
}

async function linkHostCommunityTx(tx: import('../lib/db').Tx, actor: Actor, hostId: string, communityId: string, role: string) {
  const h = await tx.query('SELECT 1 FROM hosts WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [hostId, actor.orgId]);
  if (!h.rowCount) throw notFound(`團主 ${hostId}`);
  const c = await tx.query('SELECT 1 FROM communities WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [communityId, actor.orgId]);
  if (!c.rowCount) throw notFound(`社群 ${communityId}`);
  await tx.query(
    `INSERT INTO host_communities (organization_id, host_id, community_id, role, created_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (host_id, community_id) DO UPDATE SET ended_at=NULL, role=EXCLUDED.role`, [actor.orgId, hostId, communityId, role, actor.userId]);
  await audit(tx, actor, { action: 'host_community.link', entityType: 'community', entityId: communityId, after: { hostId, role } });
}

export async function linkHostCommunity(actor: Actor, hostId: string, communityId: string, role: 'OWNER' | 'ADMIN' | 'MEMBER' = 'OWNER') {
  requirePerm(actor, 'community.write');
  return withTx((tx) => linkHostCommunityTx(tx, actor, hostId, communityId, role)).then(() => ({ hostId, communityId }));
}

export async function unlinkHostCommunity(actor: Actor, hostId: string, communityId: string) {
  requirePerm(actor, 'community.write');
  return withTx(async (tx) => {
    const future = await tx.query(
      `SELECT count(*)::int AS n FROM campaign_placements p JOIN campaigns c ON c.id=p.campaign_id
       WHERE p.host_id=$1 AND p.community_id=$2 AND p.deleted_at IS NULL AND p.status='PLANNED'
         AND c.status NOT IN ('CLOSED','CANCELLED','SETTLED')`, [hostId, communityId]);
    if (future.rows[0].n > 0) throw new AppError('PRECONDITION_FAILED', `仍有 ${future.rows[0].n} 筆未完成的曝光安排使用此團主與社群，請先調整`);
    const r = await tx.query('UPDATE host_communities SET ended_at=now() WHERE host_id=$1 AND community_id=$2 AND organization_id=$3 AND ended_at IS NULL RETURNING role', [hostId, communityId, actor.orgId]);
    if (!r.rowCount) throw notFound('團主與社群的關聯');
    await audit(tx, actor, { action: 'host_community.unlink', entityType: 'community', entityId: communityId, before: { hostId } });
    return { hostId, communityId };
  });
}

export async function listCommunities(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'community.read');
  const params: unknown[] = [actor.orgId];
  const where = ['c.organization_id=$1', 'c.deleted_at IS NULL'];
  if (actor.role === 'HOST') {
    params.push(actor.hostIds);
    where.push(`EXISTS (SELECT 1 FROM host_communities hc WHERE hc.community_id=c.id AND hc.ended_at IS NULL AND hc.host_id = ANY($${params.length}::text[]))`);
  }
  const text = nonEmpty(q.get('q'));
  if (text) { params.push(likePattern(text)); where.push(`(c.name ILIKE $${params.length} OR c.id ILIKE $${params.length})`); }
  const platform = nonEmpty(q.get('platform'));
  if (platform) { params.push(platform); where.push(`c.platform=$${params.length}`); }
  const status = nonEmpty(q.get('status'));
  if (status) { params.push(status); where.push(`c.status=$${params.length}`); }
  const res = await listPaged<Record<string, unknown>>(
    `SELECT c.id, c.platform, c.name, c.url, c.member_count, c.status, c.updated_at, c.version,
       (SELECT coalesce(json_agg(json_build_object('id', h.id, 'name', h.display_name)), '[]'::json)
          FROM host_communities hc JOIN hosts h ON h.id=hc.host_id WHERE hc.community_id=c.id AND hc.ended_at IS NULL AND h.deleted_at IS NULL) AS hosts
     FROM communities c WHERE ${where.join(' AND ')}`, params, 'c.id DESC', pageParams(q));
  res.items = camelize(res.items);
  if (actor.role === 'HOST') for (const it of res.items) it.hosts = (it.hosts as { id: string }[]).filter((h) => actor.hostIds.includes(h.id));
  return res;
}

export async function getCommunity(actor: Actor, id: string) {
  requirePerm(actor, 'community.read');
  const rows = await query('SELECT * FROM communities WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [id, actor.orgId]);
  if (!rows.length) throw notFound('社群');
  const hosts = await query(
    `SELECT h.id, h.display_name, hc.role FROM host_communities hc JOIN hosts h ON h.id=hc.host_id
     WHERE hc.community_id=$1 AND hc.ended_at IS NULL AND h.deleted_at IS NULL ORDER BY h.id`, [id]);
  if (actor.role === 'HOST' && !hosts.some((h) => actor.hostIds.includes(String(h.id)))) throw forbidden();
  const placements = await query(
    `SELECT p.id, p.campaign_id, c.title, p.placement_type, p.scheduled_on, p.status, p.host_id
     FROM campaign_placements p JOIN campaigns c ON c.id=p.campaign_id
     WHERE p.community_id=$1 AND p.deleted_at IS NULL AND c.deleted_at IS NULL ${actor.role === 'HOST' ? 'AND p.host_id = ANY($2::text[])' : ''}
     ORDER BY p.scheduled_on DESC LIMIT 100`, actor.role === 'HOST' ? [id, actor.hostIds] : [id]);
  return {
    ...camelize<Record<string, unknown>>(rows[0]),
    hosts: camelize((hosts as { id: string }[]).filter((h) => actor.role !== 'HOST' || actor.hostIds.includes(h.id))),
    placements: camelize(placements),
  };
}

export async function updateCommunity(actor: Actor, id: string, raw: z.input<typeof communityUpdateSchema>) {
  requirePerm(actor, 'community.write');
  const input = communityUpdateSchema.parse(raw);
  return withTx(async (tx) => {
    if (input.name || input.platform) {
      const cur = await tx.query('SELECT name, platform FROM communities WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [id, actor.orgId]);
      if (!cur.rowCount) throw notFound('社群');
      const dupe = await tx.query('SELECT id FROM communities WHERE organization_id=$1 AND platform=$2 AND normalized_name=$3 AND deleted_at IS NULL AND id<>$4',
        [actor.orgId, input.platform ?? cur.rows[0].platform, normalizeName(input.name ?? cur.rows[0].name), id]);
      if (dupe.rowCount) throw new AppError('CONFLICT', `此平台已有同名社群：${dupe.rows[0].id}`, { existingId: dupe.rows[0].id });
    }
    const { after } = await patchEntity(tx, actor, {
      table: 'communities', entityType: 'community', id, patch: input as Record<string, unknown>, allowed: COMMUNITY_FIELDS,
      expectedVersion: input.version, derived: (m) => ({ normalized_name: normalizeName(String(m['name'])) }),
    });
    return { id, version: after['version'] };
  });
}
