import { z } from 'zod';
import type { Tx } from '../lib/db';
import { query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { requirePerm } from '../lib/permissions';
import { AppError, notFound, precondition, validation } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids } from '../lib/ids';
import { camelize } from '../lib/case';
import { isIsoDate } from '../lib/dates';
import { isHttpUrl, nonEmpty, normalizeName } from '../lib/text';
import { likePattern, listPaged, pageParams, patchEntity } from '../lib/repo';
import { idempotent } from '../lib/idempotency';
import { AGE_BANDS, BASES, CHANNELS, CYCLES, EVIDENCE_KINDS, FAMILY_TYPES, type Basis, type PrefKind } from '../lib/segment-vocab';
import { containsPii } from './aftersales';

/**
 * 客群分析（SOP 01）：客群輪廓、需求與偏好、團主↔客群、研究證據。設計見 docs/phase2/SEGMENT_FIT.md。
 * 空值＝未知（不是「無」）；事實／估計用 basis 區分；FACT 證據必須有來源。
 */
const optText = (max: number) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));
/** 可清空的文字：空字串與 null 都代表清空；undefined＝不更動 */
const clearableText = (max: number) => z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(max).nullable().optional());
/** 空字串與 null 都視為「清空」；undefined＝不更動 */
const nullableEnum = <T extends readonly [string, ...string[]]>(vals: T) =>
  z.preprocess((v) => (v === '' ? null : v), z.enum(vals).nullable().optional());
const nullableMoney = z.preprocess((v) => (v === '' ? null : v), z.number().int('價格需為整數').min(0, '價格不可為負').max(10_000_000).nullable().optional());
const basisField = z.enum(BASES);

const prefItem = z.union([
  z.string().trim().min(1).max(30),
  z.object({ value: z.string().trim().min(1).max(30), basis: basisField.optional(), evidenceId: z.string().max(40).nullable().optional() }),
]);
const prefArray = z.array(prefItem).max(12, '每一類最多 12 項');

export const segmentCreateSchema = z.object({
  name: z.string().trim().min(1, '請輸入客群名稱').max(80),
  description: clearableText(1000),
  ageBand: nullableEnum(AGE_BANDS),
  familyType: nullableEnum(FAMILY_TYPES),
  cycle: nullableEnum(CYCLES),
  priceMin: nullableMoney,
  priceMax: nullableMoney,
  basis: basisField.optional(),
  motives: prefArray.optional(),
  barriers: prefArray.optional(),
  categories: prefArray.optional(),
  channels: prefArray.optional(),
});
export const segmentUpdateSchema = segmentCreateSchema.partial().extend({ version: z.number().int().optional() });
const SEGMENT_FIELDS = ['name', 'description', 'ageBand', 'familyType', 'cycle', 'priceMin', 'priceMax', 'basis'] as const;
const ARRAY_KEYS: Record<string, PrefKind> = { motives: 'MOTIVE', barriers: 'BARRIER', categories: 'CATEGORY', channels: 'CHANNEL' };

export const evidenceSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  basis: basisField.optional(),
  summary: z.string().trim().min(1, '請填寫證據摘要').max(1000),
  sourceLabel: optText(200),
  sourceUrl: optText(300),
  observedOn: z.string().refine(isIsoDate, '日期格式需為 YYYY-MM-DD').optional().or(z.literal('').transform(() => undefined)),
  hostId: optText(40),
});

export const linkSchema = z.object({
  sharePercent: z.preprocess((v) => (v === '' ? null : v), z.number().gt(0, '占比需大於 0').max(100, '占比不可超過 100').nullable().optional()),
  basis: basisField.optional(),
  communityId: z.preprocess((v) => (v === '' ? null : v), z.string().max(40).nullable().optional()),
  note: clearableText(500),
});
export const hostSegmentSchema = linkSchema.extend({
  segmentId: optText(40),
  segment: segmentCreateSchema.optional(),
  evidence: z.array(evidenceSchema).max(10).optional(),
});
export const linkUpdateSchema = linkSchema.partial().extend({ version: z.number().int().optional() });

function noPii(fields: Record<string, string | null | undefined>) {
  for (const [label, v] of Object.entries(fields)) {
    if (containsPii(v)) throw validation(`「${label}」請勿填寫電話或 Email；客群分析只記錄群體特徵，不記錄個人資料`);
  }
}

interface PrefDesired { value: string; basis: Basis; evidenceId: string | null }
function toDesired(kind: PrefKind, items: z.infer<typeof prefArray>, defaultBasis: Basis): PrefDesired[] {
  const out: PrefDesired[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const o = typeof it === 'string' ? { value: it, basis: undefined, evidenceId: undefined } : it;
    let value = o.value.trim();
    if (kind === 'CHANNEL') {
      value = value.toUpperCase();
      if (!(CHANNELS as readonly string[]).includes(value)) throw validation(`活躍通路只接受：${CHANNELS.join('、')}（收到「${o.value}」）`);
    }
    noPii({ '偏好項目': value });
    const key = normalizeName(value);
    if (!key) throw validation('偏好項目不可為空白');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value, basis: o.basis ?? defaultBasis, evidenceId: o.evidenceId ?? null });
  }
  return out;
}

type PrefDiff = { added: string[]; removed: string[]; updated: string[] };

async function syncPreferences(tx: Tx, actor: Actor, segmentId: string, kind: PrefKind, desired: PrefDesired[]): Promise<PrefDiff> {
  const cur = (await tx.query(`SELECT id, value, normalized_value, basis, evidence_id FROM segment_preferences WHERE segment_id=$1 AND kind=$2 AND deleted_at IS NULL`, [segmentId, kind])).rows as
    { id: string; value: string; normalized_value: string; basis: string; evidence_id: string | null }[];
  const diff: PrefDiff = { added: [], removed: [], updated: [] };
  const wanted = new Map(desired.map((d) => [normalizeName(d.value), d]));
  for (const d of desired) {
    if (d.evidenceId) {
      const ev = await tx.query('SELECT 1 FROM segment_evidence WHERE id=$1 AND segment_id=$2 AND organization_id=$3 AND deleted_at IS NULL', [d.evidenceId, segmentId, actor.orgId]);
      if (!ev.rowCount) throw validation(`找不到證據 ${d.evidenceId}（需屬於同一個客群）`);
    }
  }
  for (const row of cur) {
    const w = wanted.get(row.normalized_value);
    if (!w) {
      await tx.query('UPDATE segment_preferences SET deleted_at=now(), updated_by=$2 WHERE id=$1', [row.id, actor.userId]);
      diff.removed.push(row.value);
    } else if (w.basis !== row.basis || (w.evidenceId ?? null) !== (row.evidence_id ?? null) || w.value !== row.value) {
      await tx.query('UPDATE segment_preferences SET basis=$2, evidence_id=$3, value=$4, updated_by=$5 WHERE id=$1', [row.id, w.basis, w.evidenceId, w.value, actor.userId]);
      diff.updated.push(w.value);
    }
  }
  const have = new Set(cur.map((r) => r.normalized_value));
  for (const d of desired) {
    if (have.has(normalizeName(d.value))) continue;
    const id = await ids.segmentPreference(tx);
    await tx.query(
      `INSERT INTO segment_preferences (id, organization_id, segment_id, kind, value, normalized_value, basis, evidence_id, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [id, actor.orgId, segmentId, kind, d.value, normalizeName(d.value), d.basis, d.evidenceId, actor.userId]);
    diff.added.push(d.value);
  }
  return diff;
}

type PrefArrays = { motives?: z.infer<typeof prefArray>; barriers?: z.infer<typeof prefArray>; categories?: z.infer<typeof prefArray>; channels?: z.infer<typeof prefArray> };
async function applyPrefArrays(tx: Tx, actor: Actor, segmentId: string, input: PrefArrays, defaultBasis: Basis) {
  const changes: Record<string, PrefDiff> = {};
  for (const [key, kind] of Object.entries(ARRAY_KEYS)) {
    const arr = input[key as keyof PrefArrays];
    if (arr === undefined) continue;
    const d = await syncPreferences(tx, actor, segmentId, kind, toDesired(kind, arr, defaultBasis));
    if (d.added.length || d.removed.length || d.updated.length) changes[key] = d;
  }
  return changes;
}

function assertPriceRange(min: number | null | undefined, max: number | null | undefined) {
  if (min != null && max != null && min > max) throw validation('價格帶下限不可高於上限');
}

// ---------------- 客群 CRUD ----------------
async function createSegmentTx(tx: Tx, actor: Actor, input: z.infer<typeof segmentCreateSchema>): Promise<{ id: string }> {
  noPii({ '客群名稱': input.name, '客群說明': input.description });
  assertPriceRange(input.priceMin, input.priceMax);
  const dupe = await tx.query('SELECT id, name FROM customer_segments WHERE organization_id=$1 AND normalized_name=$2 AND deleted_at IS NULL', [actor.orgId, normalizeName(input.name)]);
  if (dupe.rowCount) throw new AppError('CONFLICT', `已有相同客群：${dupe.rows[0].id}（${dupe.rows[0].name}），可直接連結`, { existingId: dupe.rows[0].id });
  const id = await ids.segment(tx);
  const basis = input.basis ?? 'ESTIMATE';
  await tx.query(
    `INSERT INTO customer_segments (id, organization_id, name, normalized_name, description, age_band, family_type, cycle, price_min, price_max, basis, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
    [id, actor.orgId, input.name, normalizeName(input.name), input.description ?? null, input.ageBand ?? null, input.familyType ?? null, input.cycle ?? null,
      input.priceMin ?? null, input.priceMax ?? null, basis, actor.userId]);
  const prefs = await applyPrefArrays(tx, actor, id, input, basis);
  await audit(tx, actor, { action: 'segment.create', entityType: 'segment', entityId: id, after: { name: input.name, ageBand: input.ageBand ?? null, familyType: input.familyType ?? null, cycle: input.cycle ?? null, preferences: prefs } });
  return { id };
}

export async function createSegment(actor: Actor, raw: z.input<typeof segmentCreateSchema>, idemKey?: string | null) {
  requirePerm(actor, 'segment.write');
  const input = segmentCreateSchema.parse(raw);
  return withTx(async (tx) => {
    const { result, replayed } = await idempotent(tx, actor, 'segment.create', idemKey, () => createSegmentTx(tx, actor, input), input);
    return { ...result, replayed };
  });
}

export async function listSegments(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'segment.read');
  const params: unknown[] = [actor.orgId];
  const where = ['s.organization_id=$1', 's.deleted_at IS NULL'];
  const text = nonEmpty(q.get('q'));
  if (text) { params.push(likePattern(text)); where.push(`(s.name ILIKE $${params.length} OR s.id ILIKE $${params.length})`); }
  for (const [qk, col] of [['ageBand', 's.age_band'], ['familyType', 's.family_type'], ['cycle', 's.cycle']] as const) {
    const v = nonEmpty(q.get(qk));
    if (v) { params.push(v); where.push(`${col}=$${params.length}`); }
  }
  const res = await listPaged<Record<string, unknown>>(
    `SELECT s.id, s.name, s.age_band, s.family_type, s.cycle, s.basis, s.updated_at, s.version,
       (SELECT count(*)::int FROM partner_segment_links l WHERE l.segment_id=s.id AND l.ended_at IS NULL) AS linked_hosts,
       (SELECT count(*)::int FROM segment_evidence e WHERE e.segment_id=s.id AND e.deleted_at IS NULL) AS evidence_count
     FROM customer_segments s WHERE ${where.join(' AND ')}`, params, 's.id DESC', pageParams(q));
  res.items = camelize(res.items);
  return res;
}

async function loadSegmentBundle(orgId: string, id: string) {
  const rows = await query('SELECT * FROM customer_segments WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [id, orgId]);
  if (!rows.length) throw notFound('客群');
  const prefs = camelize<{ id: string; kind: PrefKind; value: string; basis: Basis; evidenceId: string | null }[]>(
    await query('SELECT id, kind, value, basis, evidence_id FROM segment_preferences WHERE segment_id=$1 AND deleted_at IS NULL ORDER BY id', [id]));
  const evidence = camelize(await query(
    `SELECT e.id, e.kind, e.basis, e.summary, e.source_label, e.source_url, e.observed_on, e.host_id, h.display_name AS host_name, e.created_at
     FROM segment_evidence e LEFT JOIN hosts h ON h.id=e.host_id WHERE e.segment_id=$1 AND e.deleted_at IS NULL ORDER BY e.id DESC`, [id]));
  return { row: camelize<Record<string, unknown>>(rows[0]), prefs, evidence };
}

const group = (prefs: { kind: PrefKind; value: string; basis: Basis; id: string; evidenceId: string | null }[], kind: PrefKind) =>
  prefs.filter((p) => p.kind === kind).map((p) => ({ id: p.id, value: p.value, basis: p.basis, evidenceId: p.evidenceId }));

export async function getSegment(actor: Actor, id: string) {
  requirePerm(actor, 'segment.read');
  const { row, prefs, evidence } = await loadSegmentBundle(actor.orgId, id);
  const hosts = camelize(await query(
    `SELECT l.id AS link_id, l.host_id, h.display_name AS host_name, l.share_percent, l.basis, l.community_id FROM partner_segment_links l
     JOIN hosts h ON h.id=l.host_id WHERE l.segment_id=$1 AND l.ended_at IS NULL AND h.deleted_at IS NULL ORDER BY l.id`, [id]));
  const history = camelize(await query(
    `SELECT a.id, a.occurred_at, u.name AS actor_name, a.actor_role, a.action, a.before_data, a.after_data, a.reason
     FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id WHERE a.organization_id=$1 AND a.entity_type='segment' AND a.entity_id=$2 ORDER BY a.id DESC LIMIT 50`, [actor.orgId, id]));
  return {
    ...row,
    motives: group(prefs, 'MOTIVE'), barriers: group(prefs, 'BARRIER'), categories: group(prefs, 'CATEGORY'), channels: group(prefs, 'CHANNEL'),
    evidence, hosts, history,
  };
}

export async function updateSegment(actor: Actor, id: string, raw: z.input<typeof segmentUpdateSchema>) {
  requirePerm(actor, 'segment.write');
  const input = segmentUpdateSchema.parse(raw);
  noPii({ '客群名稱': input.name, '客群說明': input.description });
  return withTx(async (tx) => {
    const cur = await tx.query('SELECT * FROM customer_segments WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL FOR UPDATE', [id, actor.orgId]);
    if (!cur.rowCount) throw notFound('客群');
    const c = cur.rows[0];
    if (input.version != null && c.version !== input.version) throw new AppError('CONFLICT', '資料已被其他人更新，請重新整理後再試', { currentVersion: c.version });
    assertPriceRange(input.priceMin !== undefined ? input.priceMin : c.price_min, input.priceMax !== undefined ? input.priceMax : c.price_max);
    if (input.name) {
      const dupe = await tx.query('SELECT id FROM customer_segments WHERE organization_id=$1 AND normalized_name=$2 AND deleted_at IS NULL AND id<>$3', [actor.orgId, normalizeName(input.name), id]);
      if (dupe.rowCount) throw new AppError('CONFLICT', `已有相同客群：${dupe.rows[0].id}`, { existingId: dupe.rows[0].id });
    }
    const defaultBasis = (input.basis ?? c.basis) as Basis;
    const { changed } = await patchEntity(tx, actor, {
      table: 'customer_segments', entityType: 'segment', id, patch: input as Record<string, unknown>,
      allowed: SEGMENT_FIELDS, derived: (m) => ({ normalized_name: normalizeName(String(m['name'])) }),
    });
    const prefChanges = await applyPrefArrays(tx, actor, id, input, defaultBasis);
    if (Object.keys(prefChanges).length) {
      await audit(tx, actor, { action: 'segment.preferences', entityType: 'segment', entityId: id, after: prefChanges });
      if (!changed) await tx.query('UPDATE customer_segments SET updated_by=$2 WHERE id=$1', [id, actor.userId]);   // 偏好有變動時，讓客群的版本與更新時間跟著前進
    }
    const v = await tx.query('SELECT version FROM customer_segments WHERE id=$1', [id]);
    return { id, version: v.rows[0].version as number };
  });
}

export async function archiveSegment(actor: Actor, id: string, reason: string) {
  requirePerm(actor, 'segment.write');
  if (!reason?.trim()) throw validation('請填寫封存原因');
  return withTx(async (tx) => {
    const cur = await tx.query('SELECT * FROM customer_segments WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL FOR UPDATE', [id, actor.orgId]);
    if (!cur.rowCount) throw notFound('客群');
    const used = await tx.query('SELECT count(*)::int AS n FROM partner_segment_links WHERE segment_id=$1 AND ended_at IS NULL', [id]);
    if (used.rows[0].n > 0) throw precondition(`仍有 ${used.rows[0].n} 位團主連結此客群，請先結束連結`);
    await tx.query('UPDATE customer_segments SET deleted_at=now(), updated_by=$2 WHERE id=$1', [id, actor.userId]);
    await audit(tx, actor, { action: 'segment.archive', entityType: 'segment', entityId: id, before: { name: cur.rows[0].name }, reason });
    return { id };
  });
}

// ---------------- 研究證據 ----------------
async function addEvidenceTx(tx: Tx, actor: Actor, segmentId: string, input: z.infer<typeof evidenceSchema>, defaultHostId?: string): Promise<{ id: string }> {
  noPii({ '證據摘要': input.summary, '來源說明': input.sourceLabel });
  const basis = input.basis ?? 'ESTIMATE';
  if (input.sourceUrl && !isHttpUrl(input.sourceUrl)) throw validation('來源連結需為 http:// 或 https:// 開頭的網址');
  if (basis === 'FACT' && !input.sourceLabel && !input.sourceUrl) throw validation('標示為「事實」的證據必須填寫來源（來源說明或來源連結）；沒有來源請標為「估計」');
  const seg = await tx.query('SELECT 1 FROM customer_segments WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [segmentId, actor.orgId]);
  if (!seg.rowCount) throw notFound('客群');
  const hostId = input.hostId ?? defaultHostId ?? null;
  if (hostId) {
    const h = await tx.query('SELECT 1 FROM hosts WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [hostId, actor.orgId]);
    if (!h.rowCount) throw notFound(`團主 ${hostId}`);
  }
  const id = await ids.segmentEvidence(tx);
  await tx.query(
    `INSERT INTO segment_evidence (id, organization_id, segment_id, host_id, kind, basis, summary, source_label, source_url, observed_on, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
    [id, actor.orgId, segmentId, hostId, input.kind, basis, input.summary, input.sourceLabel ?? null, input.sourceUrl ?? null, input.observedOn ?? null, actor.userId]);
  await audit(tx, actor, { action: 'segment.evidence.add', entityType: 'segment', entityId: segmentId, after: { evidenceId: id, kind: input.kind, basis, hostId } });
  return { id };
}

export async function addEvidence(actor: Actor, segmentId: string, raw: z.input<typeof evidenceSchema>) {
  requirePerm(actor, 'segment.write');
  const input = evidenceSchema.parse(raw);
  return withTx((tx) => addEvidenceTx(tx, actor, segmentId, input));
}

export async function removeEvidence(actor: Actor, id: string) {
  requirePerm(actor, 'segment.write');
  return withTx(async (tx) => {
    const r = await tx.query('UPDATE segment_evidence SET deleted_at=now(), updated_by=$3 WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL RETURNING segment_id, kind, basis', [id, actor.orgId, actor.userId]);
    if (!r.rowCount) throw notFound('證據');
    // 不留下指向已移除證據的引用
    await tx.query('UPDATE segment_preferences SET evidence_id=NULL, updated_by=$2 WHERE evidence_id=$1 AND deleted_at IS NULL', [id, actor.userId]);
    await audit(tx, actor, { action: 'segment.evidence.remove', entityType: 'segment', entityId: r.rows[0].segment_id as string, before: { evidenceId: id, kind: r.rows[0].kind, basis: r.rows[0].basis } });
    return { id };
  });
}

// ---------------- 團主 ↔ 客群 ----------------
const REQUIRED_PROFILE: { key: string; label: string; test: (s: SegmentView) => boolean }[] = [
  { key: 'ageBand', label: '年齡層', test: (s) => !!s.ageBand },
  { key: 'familyType', label: '家庭型態', test: (s) => !!s.familyType },
  { key: 'cycle', label: '消費週期', test: (s) => !!s.cycle },
  { key: 'motives', label: '購買動機', test: (s) => s.motives.length > 0 },
  { key: 'barriers', label: '購買阻力', test: (s) => s.barriers.length > 0 },
  { key: 'categories', label: '偏好品類', test: (s) => s.categories.length > 0 },
  { key: 'channels', label: '活躍通路', test: (s) => s.channels.length > 0 },
  { key: 'evidence', label: '觀察來源', test: (s) => s.evidence.length > 0 },
];

interface SegmentView {
  id: string; name: string; ageBand: string | null; familyType: string | null; cycle: string | null; priceMin: number | null; priceMax: number | null; basis: Basis;
  motives: { id: string; value: string; basis: Basis; evidenceId: string | null }[]; barriers: { id: string; value: string; basis: Basis; evidenceId: string | null }[];
  categories: { id: string; value: string; basis: Basis; evidenceId: string | null }[]; channels: { id: string; value: string; basis: Basis; evidenceId: string | null }[];
  evidence: Record<string, unknown>[];
}

/** 團主的客群分析彙整：partnerType、每個進行中連結（含客群輪廓、偏好、證據）、缺哪些資料 */
export async function getHostSegments(actor: Actor, hostId: string) {
  requirePerm(actor, 'segment.read');
  const h = await query('SELECT id, display_name, partner_type, audience_note FROM hosts WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [hostId, actor.orgId]);
  if (!h.length) throw notFound('團主');
  const links = camelize<{ id: string; segmentId: string; communityId: string | null; communityName: string | null; sharePercent: number | null; basis: Basis; note: string | null; version: number }[]>(await query(
    `SELECT l.id, l.segment_id, l.community_id, c.name AS community_name, l.share_percent, l.basis, l.note, l.version
     FROM partner_segment_links l LEFT JOIN communities c ON c.id=l.community_id WHERE l.host_id=$1 AND l.organization_id=$2 AND l.ended_at IS NULL ORDER BY l.id`, [hostId, actor.orgId]));
  const items = [];
  const gaps = new Set<string>();
  for (const l of links) {
    const { row, prefs, evidence } = await loadSegmentBundle(actor.orgId, l.segmentId);
    const view = { ...row, motives: group(prefs, 'MOTIVE'), barriers: group(prefs, 'BARRIER'), categories: group(prefs, 'CATEGORY'), channels: group(prefs, 'CHANNEL'), evidence } as unknown as SegmentView;
    const missing = REQUIRED_PROFILE.filter((r) => !r.test(view)).map((r) => r.label);
    for (const m of missing) gaps.add(m);
    items.push({ link: l, segment: view, missing });
  }
  const hostRow = camelize<{ id: string; displayName: string; partnerType: string | null; audienceNote: string | null }>(h[0]);
  const shareSum = links.reduce((a, l) => a + (l.sharePercent ?? 0), 0);
  const missing = [...(hostRow.partnerType ? [] : ['合作對象類型']), ...(links.length ? [...gaps] : [])];
  return {
    hostId, hostName: hostRow.displayName, partnerType: hostRow.partnerType, audienceNote: hostRow.audienceNote,
    status: links.length === 0 ? 'NOT_STARTED' : missing.length ? 'PARTIAL' : 'COMPLETE',
    shareSum: links.some((l) => l.sharePercent != null) ? Math.round(shareSum * 100) / 100 : null,
    missing, links: items,
  };
}

async function assertLinkable(tx: Tx, actor: Actor, hostId: string, input: z.infer<typeof linkSchema>, excludeLinkId?: string) {
  if (input.communityId) {
    const ok = await tx.query(`SELECT 1 FROM host_communities WHERE host_id=$1 AND community_id=$2 AND ended_at IS NULL AND organization_id=$3`, [hostId, input.communityId, actor.orgId]);
    if (!ok.rowCount) throw validation('指定的社群不是此團主目前所屬的社群，請先在「所屬社群」連結');
  }
  if (input.sharePercent != null) {
    const sum = await tx.query<{ s: number }>(`SELECT coalesce(sum(share_percent),0) AS s FROM partner_segment_links WHERE host_id=$1 AND ended_at IS NULL AND ($2::text IS NULL OR id<>$2)`, [hostId, excludeLinkId ?? null]);
    const others = Number(sum.rows[0].s);
    if (others + input.sharePercent > 100.0001) throw validation(`各客群占比合計不可超過 100%（其他客群已占 ${others}%）`);
  }
  noPii({ '連結備註': input.note });
}

export async function linkHostSegment(actor: Actor, hostId: string, raw: z.input<typeof hostSegmentSchema>, idemKey?: string | null) {
  requirePerm(actor, 'segment.write');
  const input = hostSegmentSchema.parse(raw);
  if (!input.segmentId && !input.segment) throw validation('請選擇既有客群，或填寫要新建的客群');
  if (input.segmentId && input.segment) throw validation('只能擇一：連結既有客群，或新建客群');
  return withTx(async (tx) => {
    const { result, replayed } = await idempotent(tx, actor, 'segment.link', idemKey, async () => {
      const h = await tx.query('SELECT 1 FROM hosts WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL FOR SHARE', [hostId, actor.orgId]);
      if (!h.rowCount) throw notFound('團主');
      await assertLinkable(tx, actor, hostId, input);
      let segmentId = input.segmentId ?? '';
      let created = false;
      if (input.segment) { segmentId = (await createSegmentTx(tx, actor, input.segment)).id; created = true; }
      else {
        const s = await tx.query('SELECT 1 FROM customer_segments WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [segmentId, actor.orgId]);
        if (!s.rowCount) throw notFound('客群');
        const dup = await tx.query('SELECT id FROM partner_segment_links WHERE host_id=$1 AND segment_id=$2 AND ended_at IS NULL', [hostId, segmentId]);
        if (dup.rowCount) throw new AppError('CONFLICT', `此團主已連結這個客群：${dup.rows[0].id}`, { existingId: dup.rows[0].id });
      }
      const id = await ids.segmentLink(tx);
      await tx.query(
        `INSERT INTO partner_segment_links (id, organization_id, host_id, segment_id, community_id, share_percent, basis, note, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
        [id, actor.orgId, hostId, segmentId, input.communityId ?? null, input.sharePercent ?? null, input.basis ?? 'ESTIMATE', input.note ?? null, actor.userId]);
      await audit(tx, actor, { action: 'segment_link.create', entityType: 'partner_segment_link', entityId: id, after: { hostId, segmentId, sharePercent: input.sharePercent ?? null, basis: input.basis ?? 'ESTIMATE', createdSegment: created } });
      const evidenceIds: string[] = [];
      for (const e of input.evidence ?? []) evidenceIds.push((await addEvidenceTx(tx, actor, segmentId, e, hostId)).id);
      return { id, segmentId, evidenceIds };
    }, { hostId, input });
    return { ...result, replayed };
  });
}

export async function updateSegmentLink(actor: Actor, id: string, raw: z.input<typeof linkUpdateSchema>) {
  requirePerm(actor, 'segment.write');
  const input = linkUpdateSchema.parse(raw);
  return withTx(async (tx) => {
    const cur = await tx.query('SELECT host_id, ended_at FROM partner_segment_links WHERE id=$1 AND organization_id=$2 FOR UPDATE', [id, actor.orgId]);
    if (!cur.rowCount || cur.rows[0].ended_at) throw notFound('客群連結');
    await assertLinkable(tx, actor, cur.rows[0].host_id as string, input, id);
    const { after } = await patchEntity(tx, actor, {
      table: 'partner_segment_links', entityType: 'partner_segment_link', id, patch: input as Record<string, unknown>,
      allowed: ['sharePercent', 'basis', 'communityId', 'note'], expectedVersion: input.version,
    });
    return { id, version: after['version'] };
  });
}

export async function endSegmentLink(actor: Actor, id: string, reason?: string) {
  requirePerm(actor, 'segment.write');
  return withTx(async (tx) => {
    const r = await tx.query('UPDATE partner_segment_links SET ended_at=now(), updated_by=$3 WHERE id=$1 AND organization_id=$2 AND ended_at IS NULL RETURNING host_id, segment_id', [id, actor.orgId, actor.userId]);
    if (!r.rowCount) throw notFound('客群連結');
    await audit(tx, actor, { action: 'segment_link.end', entityType: 'partner_segment_link', entityId: id, before: { hostId: r.rows[0].host_id, segmentId: r.rows[0].segment_id }, reason: reason ?? null });
    return { id };
  });
}
