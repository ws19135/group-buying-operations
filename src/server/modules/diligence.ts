import { z } from 'zod';
import type { Queryable, Tx } from '../lib/db';
import { pool, query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, requirePerm } from '../lib/permissions';
import { conflict, forbidden, notFound, precondition, validation } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids, todayTaipei } from '../lib/ids';
import { camelize } from '../lib/case';
import { addDays } from '../lib/dates';
import { idempotent } from '../lib/idempotency';
import {
  DD_CATEGORIES, DD_STATUSES, REGULATED_CATEGORIES, RESPONSIBLE_PARTIES, ddCategory, ddReadiness, legalTriggers, maskTerms, parseTerms, suspectRegulated,
  type DdItemLite, type EvidenceLite,
} from '../lib/dd-catalog';
import { assertNoPii, evidenceFor, loadSelectionConfig, mapDbError } from './selection';
import { maskEvidenceList } from './evidence';

/**
 * 廠商首次合作盡職調查（SOP 02，12 類）。一份調查＝某廠商（可限定某商品）在某合約版本下的 12 類問題。
 * 結構化條款、責任方、負責人、證據與有效期；系統只標示「需法務或合規審查」，不判斷合法。
 * 核准結果不阻擋、也不放行 G1，只在廠商頁與 G1 摘要顯示。設計見 docs/phase2/PRODUCT_SELECTION_TRIAL.md §4。
 */
const EDITABLE = ['DRAFT', 'REJECTED'];
const LEGAL_EDITABLE = ['DRAFT', 'IN_REVIEW', 'REJECTED'];

async function loadVendor(db: Queryable, orgId: string, vendorId: string) {
  const r = await db.query<{ id: string; name: string; category: string | null }>(`SELECT id, name, category FROM vendors WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL`, [vendorId, orgId]);
  if (!r.rowCount) throw notFound('廠商');
  return r.rows[0];
}

export const ddCreateSchema = z.object({
  productId: z.string().max(40).nullable().optional(),
  contractVersion: z.string().trim().min(1, '請填寫合約版本').max(60),
  contractRef: z.string().trim().max(200).nullable().optional(),
  regulatedCategory: z.enum(REGULATED_CATEGORIES).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
}).strict();

/** 依資料決定第 1、11 類是否要標「需法務／合規審查」 */
function triggersFor(rec: { regulatedCategory: string | null }, texts: (string | null | undefined)[]) {
  const suspected = suspectRegulated(...texts);
  return (key: string, terms: Record<string, unknown>) => legalTriggers({ categoryKey: key, terms, regulatedCategory: rec.regulatedCategory, suspected });
}

export async function createDiligence(actor: Actor, vendorId: string, raw: z.input<typeof ddCreateSchema>, idemKey?: string | null) {
  requirePerm(actor, 'selection.write');
  const input = ddCreateSchema.parse(raw);
  assertNoPii({ 合約編號: input.contractRef, 備註: input.note });
  const vendor = await loadVendor(pool(), actor.orgId, vendorId);
  let product: { name: string; category: string | null; compliance_note: string | null } | null = null;
  if (input.productId) {
    const p = await query<{ name: string; category: string | null; compliance_note: string | null; vendor_id: string }>(`SELECT name, category, compliance_note, vendor_id FROM products WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL`, [input.productId, actor.orgId]);
    if (!p.length) throw notFound('商品');
    if (p[0].vendor_id !== vendorId) throw validation('這個商品不屬於此廠商');
    product = p[0];
  }
  try {
    const { result } = await withTx((tx) => idempotent(tx, actor, 'dd.create', idemKey, async () => {
      const id = await ids.ddRecord(tx);
      await tx.query(
        `INSERT INTO vendor_dd_records (id, organization_id, vendor_id, product_id, contract_version, contract_ref, regulated_category, prepared_by, note, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$8)`,
        [id, actor.orgId, vendorId, input.productId ?? null, input.contractVersion, input.contractRef ?? null, input.regulatedCategory ?? null, actor.userId, input.note ?? null]);
      const trig = triggersFor({ regulatedCategory: input.regulatedCategory ?? null }, [vendor.category, product?.name, product?.category, product?.compliance_note]);
      for (const c of DD_CATEGORIES) {
        const t = trig(c.key, {});
        await tx.query(
          `INSERT INTO vendor_dd_items (id, organization_id, record_id, category_key, legal_status, legal_reason, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
          [await ids.ddItem(tx), actor.orgId, id, c.key, t.required ? 'REQUIRED' : 'NOT_REQUIRED', t.required ? t.reasons.join('；') : null, actor.userId]);
      }
      await audit(tx, actor, { action: 'selection.dd.create', entityType: 'vendor_dd_record', entityId: id, after: { vendorId, productId: input.productId ?? null, contractVersion: input.contractVersion, regulatedCategory: input.regulatedCategory ?? null } });
      return { id };
    }, { vendorId, ...input }));
    return result;
  } catch (e) { return mapDbError(e, '這個廠商（與商品）在此合約版本已有一份調查，請直接編輯，或使用新的合約版本'); }
}

interface RecRow { id: string; vendor_id: string; product_id: string | null; contract_version: string; status: string; valid_until: string | null; regulated_category: string | null; version: number; [k: string]: unknown }

async function loadItems(db: Queryable, orgId: string, recordIds: string[], actor: Actor, today: string, soon: number) {
  if (!recordIds.length) return new Map<string, Record<string, unknown>[]>();
  const rows = await db.query(
    `SELECT i.*, u.name AS owner_name, cu.name AS legal_cleared_by_name FROM vendor_dd_items i LEFT JOIN users u ON u.id=i.owner_user_id LEFT JOIN users cu ON cu.id=i.legal_cleared_by
     WHERE i.organization_id=$1 AND i.record_id = ANY($2::text[])`, [orgId, recordIds]);
  const itemIds = rows.rows.map((r) => r.id as string);
  const ev = await evidenceFor(db, orgId, 'DD_ITEM', itemIds, today, soon);
  const canSee = can(actor, 'product.cost.read');
  const byRec = new Map<string, Record<string, unknown>[]>();
  for (const r of rows.rows as Record<string, unknown>[]) {
    const key = r.category_key as string;
    const cat = ddCategory(key);
    const sensitiveItem = !!cat?.sensitive.length;
    const m = maskTerms(key, (r.terms ?? {}) as Record<string, unknown>, canSee);
    const evidence = maskEvidenceList(ev.get(r.id as string) ?? [], !sensitiveItem || canSee);
    const item: Record<string, unknown> = { ...camelize<Record<string, unknown>>(r), terms: m.terms, restricted: m.restricted, evidence, label: cat?.label, no: cat?.no, question: cat?.question, evidenceRequired: cat?.evidenceRequired };
    if (m.restricted) { item.note = null; item.riskNote = (r.risk_note as string | null) ? '（敏感類別，內容已隱藏）' : null; }
    const list = byRec.get(r.record_id as string) ?? [];
    list.push(item);
    byRec.set(r.record_id as string, list);
  }
  for (const list of byRec.values()) list.sort((a, b) => (a.no as number) - (b.no as number));
  return byRec;
}

/** 以未遮罩的原始證據算準備度（遮罩只影響顯示，不影響判斷） */
async function readinessOf(db: Queryable, orgId: string, recordId: string, today: string, soon: number) {
  const items = await db.query<{ id: string; category_key: string; status: string; legal_status: string }>(`SELECT id, category_key, status, legal_status FROM vendor_dd_items WHERE record_id=$1`, [recordId]);
  const ev = await db.query<{ id: string; subject_id: string; valid_until: string | null }>(
    `SELECT id, subject_id, valid_until FROM evidence_items WHERE organization_id=$1 AND subject_type='DD_ITEM' AND deleted_at IS NULL AND subject_id = ANY($2::text[])`, [orgId, items.rows.map((i) => i.id)]);
  const lite: DdItemLite[] = items.rows.map((i) => ({
    key: i.category_key, status: i.status, legalStatus: i.legal_status,
    evidence: ev.rows.filter((e) => e.subject_id === i.id).map((e): EvidenceLite => ({ id: e.id, validUntil: e.valid_until })),
  }));
  return ddReadiness(lite, today, soon);
}

/** 核准後的有效性：到期、或核准後證據過期，都視為失效（不改資料，只在顯示與摘要標示） */
export function approvalValidity(rec: { status: string; validUntil: string | null }, readiness: { expired: number }, today: string): { valid: boolean; reasons: string[] } {
  if (rec.status !== 'APPROVED') return { valid: false, reasons: ['尚未核准'] };
  const reasons: string[] = [];
  if (rec.validUntil && rec.validUntil < today) reasons.push(`核准已於 ${rec.validUntil} 到期`);
  if (readiness.expired) reasons.push(`${readiness.expired} 筆證據已過期`);
  return { valid: reasons.length === 0, reasons };
}

const SELECT_REC = `SELECT r.*, v.name AS vendor_name, p.name AS product_name, pu.name AS prepared_by_name, ru.name AS reviewed_by_name
  FROM vendor_dd_records r JOIN vendors v ON v.id=r.vendor_id LEFT JOIN products p ON p.id=r.product_id LEFT JOIN users pu ON pu.id=r.prepared_by LEFT JOIN users ru ON ru.id=r.reviewed_by`;

async function presentRecords(db: Queryable, actor: Actor, rows: RecRow[], withItems: boolean) {
  const cfg = await loadSelectionConfig(db, actor.orgId);
  const today = todayTaipei();
  const items = withItems ? await loadItems(db, actor.orgId, rows.map((r) => r.id), actor, today, cfg.expiringSoonDays) : new Map();
  const out = [];
  for (const r of rows) {
    const readiness = await readinessOf(db, actor.orgId, r.id, today, cfg.expiringSoonDays);
    const rec = camelize<Record<string, unknown> & { status: string; validUntil: string | null }>(r);
    out.push({ ...rec, readiness, validity: approvalValidity(rec, readiness, today), items: withItems ? (items.get(r.id) ?? []) : undefined,
      editable: EDITABLE.includes(r.status) });
  }
  return out;
}

export async function listVendorDiligence(actor: Actor, vendorId: string) {
  requirePerm(actor, 'selection.read');
  const v = await loadVendor(pool(), actor.orgId, vendorId);
  const rows = await query(`${SELECT_REC} WHERE r.organization_id=$1 AND r.vendor_id=$2 AND r.deleted_at IS NULL ORDER BY r.created_at DESC, r.id DESC`, [actor.orgId, vendorId]);
  const items = await presentRecords(pool(), actor, rows as RecRow[], false);
  const cfg = await loadSelectionConfig(pool(), actor.orgId);
  return { vendorId, vendorName: v.name, items, config: { ddValidDays: cfg.ddValidDays, status: cfg.approved ? '已確認採用' : '建議值，待 Owner 確認' } };
}

export async function getDiligence(actor: Actor, id: string) {
  requirePerm(actor, 'selection.read');
  const rows = await query(`${SELECT_REC} WHERE r.id=$1 AND r.organization_id=$2 AND r.deleted_at IS NULL`, [id, actor.orgId]);
  if (!rows.length) throw notFound('盡職調查');
  const [rec] = await presentRecords(pool(), actor, rows as RecRow[], true);
  return { ...rec, categories: DD_CATEGORIES.map((c) => ({ key: c.key, no: c.no, label: c.label, question: c.question, evidenceRequired: c.evidenceRequired, sensitive: c.sensitive, fields: Object.keys(c.terms.shape) })), canSeeSensitive: can(actor, 'product.cost.read') };
}

export const ddPatchSchema = z.object({
  contractRef: z.string().trim().max(200).nullable().optional(),
  regulatedCategory: z.enum(REGULATED_CATEGORIES).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  version: z.number().int().optional(),
}).strict();

async function lockRecord(tx: Tx, actor: Actor, id: string): Promise<RecRow> {
  const r = await tx.query(`SELECT * FROM vendor_dd_records WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL FOR UPDATE`, [id, actor.orgId]);
  if (!r.rowCount) throw notFound('盡職調查');
  return r.rows[0] as RecRow;
}

export async function updateDiligence(actor: Actor, id: string, raw: z.input<typeof ddPatchSchema>) {
  requirePerm(actor, 'selection.write');
  const input = ddPatchSchema.parse(raw);
  assertNoPii({ 合約編號: input.contractRef, 備註: input.note });
  await withTx(async (tx) => {
    const rec = await lockRecord(tx, actor, id);
    if (!EDITABLE.includes(rec.status)) throw precondition('調查已送審或核准，不能直接修改；請退回後再編輯，或建立新合約版本');
    if (input.version != null && input.version !== rec.version) throw conflict('資料已被其他人更新，請重新整理後再試', { currentVersion: rec.version });
    const sets: Record<string, unknown> = {};
    if (input.contractRef !== undefined) sets.contract_ref = input.contractRef;
    if (input.regulatedCategory !== undefined) sets.regulated_category = input.regulatedCategory;
    if (input.note !== undefined) sets.note = input.note;
    const cols = Object.keys(sets);
    if (!cols.length) return;
    await tx.query(`UPDATE vendor_dd_records SET ${cols.map((c, i) => `${c}=$${i + 3}`).join(', ')}, updated_by=$${cols.length + 3} WHERE id=$1 AND organization_id=$2`, [id, actor.orgId, ...cols.map((c) => sets[c]), actor.userId]);
    // 受規範品類改變 → 重新評估第 1 類的法務標示（只在尚未人工處理時自動標示）
    if (input.regulatedCategory !== undefined) await refreshLegalFlags(tx, actor, rec, input.regulatedCategory ?? null);
    await audit(tx, actor, { action: 'selection.dd.update', entityType: 'vendor_dd_record', entityId: id, before: { contractRef: rec.contract_ref, regulatedCategory: rec.regulated_category, note: rec.note }, after: input as Record<string, unknown> });
  }).catch((e) => mapDbError(e));
  return getDiligence(actor, id);
}

async function refreshLegalFlags(tx: Tx, actor: Actor, rec: RecRow, regulated: string | null): Promise<void> {
  const ctx = await tx.query<{ vname: string | null; vcat: string | null; pname: string | null; pcat: string | null; pnote: string | null }>(
    `SELECT v.name AS vname, v.category AS vcat, p.name AS pname, p.category AS pcat, p.compliance_note AS pnote FROM vendors v LEFT JOIN products p ON p.id=$2 WHERE v.id=$1`, [rec.vendor_id, rec.product_id]);
  const c = ctx.rows[0];
  const items = await tx.query<{ id: string; category_key: string; terms: Record<string, unknown>; legal_status: string }>(`SELECT id, category_key, terms, legal_status FROM vendor_dd_items WHERE record_id=$1`, [rec.id]);
  const trig = triggersFor({ regulatedCategory: regulated }, [c?.vcat, c?.pname, c?.pcat, c?.pnote]);
  for (const it of items.rows) {
    const t = trig(it.category_key, it.terms ?? {});
    if (t.required && it.legal_status === 'NOT_REQUIRED') {
      await tx.query(`UPDATE vendor_dd_items SET legal_status='REQUIRED', legal_reason=$2, updated_by=$3 WHERE id=$1`, [it.id, t.reasons.join('；'), actor.userId]);
    }
  }
}

// ---------------- 項目 ----------------
export const ddItemPatchSchema = z.object({
  status: z.enum(DD_STATUSES).optional(),
  responsibleParty: z.enum(RESPONSIBLE_PARTIES).optional(),
  ownerUserId: z.string().max(40).nullable().optional(),
  terms: z.record(z.unknown()).optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  naReason: z.string().trim().max(500).nullable().optional(),
  riskNote: z.string().trim().max(500).nullable().optional(),
  version: z.number().int().optional(),
}).strict();

export async function updateDiligenceItem(actor: Actor, itemId: string, raw: z.input<typeof ddItemPatchSchema>) {
  requirePerm(actor, 'selection.write');
  const input = ddItemPatchSchema.parse(raw);
  assertNoPii({ 備註: input.note, 不適用原因: input.naReason, 風險說明: input.riskNote });
  const canSensitive = can(actor, 'product.cost.read');
  const recordId = await withTx(async (tx) => {
    const cur = await tx.query(`SELECT * FROM vendor_dd_items WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [itemId, actor.orgId]);
    if (!cur.rowCount) throw notFound('調查項目');
    const item = cur.rows[0] as Record<string, unknown>;
    const rec = await lockRecord(tx, actor, item.record_id as string);
    if (!EDITABLE.includes(rec.status)) throw precondition('調查已送審或核准，不能修改項目');
    if (input.version != null && input.version !== item.version) throw conflict('資料已被其他人更新，請重新整理後再試', { currentVersion: item.version });
    const key = item.category_key as string;
    const cat = ddCategory(key) as NonNullable<ReturnType<typeof ddCategory>>;
    // 敏感類別（分潤條款）：沒有成本檢視權限者只能指派負責人／責任方，不能讀寫條款、狀態與備註
    if (cat.sensitive.length && !canSensitive) {
      const touched = ['status', 'terms', 'note', 'naReason', 'riskNote'].filter((k) => (input as Record<string, unknown>)[k] !== undefined);
      if (touched.length) throw forbidden('分潤條款屬敏感資料，需有成本檢視權限才能填寫；你只能指派負責人與責任方');
    }
    const sets: Record<string, unknown> = {};
    if (input.responsibleParty !== undefined) sets.responsible_party = input.responsibleParty;
    if (input.ownerUserId !== undefined) {
      if (input.ownerUserId) {
        const u = await tx.query(`SELECT 1 FROM users WHERE id=$1 AND organization_id=$2 AND status='ACTIVE' AND role_key IN ('SYSTEM_ADMIN','OPS_MANAGER','OPS_EDITOR','FINANCE')`, [input.ownerUserId, actor.orgId]);
        if (!u.rowCount) throw validation('負責人必須是啟用中的內部使用者');
      }
      sets.owner_user_id = input.ownerUserId;
    }
    if (input.terms !== undefined) {
      const parsed = parseTerms(key, input.terms);
      sets.terms = JSON.stringify(parsed);
      assertNoPii(Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string').map(([k, v]) => [`條款 ${k}`, v as string])));
    }
    if (input.note !== undefined) sets.note = input.note;
    const nextStatus = (input.status ?? item.status) as string;
    if (input.status !== undefined) sets.status = input.status;
    if (input.naReason !== undefined) sets.na_reason = input.naReason;
    if (input.riskNote !== undefined) sets.risk_note = input.riskNote;
    if (nextStatus === 'NOT_APPLICABLE' && !((sets.na_reason ?? item.na_reason) as string | null)?.trim()) throw validation('標示「不適用」時，請說明原因');
    if (nextStatus === 'AT_RISK' && !((sets.risk_note ?? item.risk_note) as string | null)?.trim()) throw validation('標示「有風險」時，請說明風險');
    if (nextStatus === 'CONFIRMED' && (input.status !== undefined && item.status !== 'CONFIRMED')) {
      if (cat.evidenceRequired) {
        const today = todayTaipei();
        const ev = await tx.query<{ valid_until: string | null }>(`SELECT valid_until FROM evidence_items WHERE organization_id=$1 AND subject_type='DD_ITEM' AND subject_id=$2 AND deleted_at IS NULL`, [actor.orgId, itemId]);
        if (!ev.rows.some((e) => !e.valid_until || e.valid_until >= today)) throw validation(`「${cat.label}」標為已確認前，需至少附一筆有效（未過期）的證據連結`);
      }
      sets.confirmed_by = actor.userId;
      sets.confirmed_at = new Date().toISOString();
    }
    if (nextStatus !== 'CONFIRMED' && input.status !== undefined) { sets.confirmed_by = null; sets.confirmed_at = null; }
    // 條款改變 → 重算法務標示（例如勾選轉售價格限制）
    if (sets.terms) {
      const ctx = await tx.query<{ vcat: string | null; pname: string | null; pcat: string | null; pnote: string | null }>(
        `SELECT v.category AS vcat, p.name AS pname, p.category AS pcat, p.compliance_note AS pnote FROM vendors v LEFT JOIN products p ON p.id=$2 WHERE v.id=$1`, [rec.vendor_id, rec.product_id]);
      const t = triggersFor({ regulatedCategory: rec.regulated_category }, [ctx.rows[0]?.vcat, ctx.rows[0]?.pname, ctx.rows[0]?.pcat, ctx.rows[0]?.pnote])(key, JSON.parse(sets.terms as string));
      if (t.required && item.legal_status === 'NOT_REQUIRED') { sets.legal_status = 'REQUIRED'; sets.legal_reason = t.reasons.join('；'); }
    }
    const cols = Object.keys(sets);
    if (!cols.length) return rec.id;
    const upd = await tx.query(`UPDATE vendor_dd_items SET ${cols.map((c, i) => `${c}=$${i + 3}`).join(', ')}, updated_by=$${cols.length + 3} WHERE id=$1 AND organization_id=$2 RETURNING *`, [itemId, actor.orgId, ...cols.map((c) => sets[c]), actor.userId]);
    const after = upd.rows[0] as Record<string, unknown>;
    const sensitiveItem = cat.sensitive.length > 0;
    const snap = (o: Record<string, unknown>) => ({ status: o.status, responsibleParty: o.responsible_party, ownerUserId: o.owner_user_id, legalStatus: o.legal_status, ...(sensitiveItem ? {} : { terms: o.terms, note: o.note, naReason: o.na_reason, riskNote: o.risk_note }) });
    await audit(tx, actor, { action: 'selection.dd.item.update', entityType: 'vendor_dd_item', entityId: itemId, before: { category: key, ...snap(item) }, after: { category: key, ...snap(after) } });
    return rec.id;
  }).catch((e) => mapDbError(e));
  return { id: itemId, recordId };
}

// ---------------- 法務／合規審查標示 ----------------
export const ddLegalSchema = z.object({
  action: z.enum(['REQUIRE', 'CLEAR', 'BLOCK', 'RELEASE']),
  note: z.string().trim().max(1000).optional().or(z.literal('').transform(() => undefined)),
}).strict();

/** 標示需審（任何填報者）；確認無虞／封鎖／解除（product.review）。系統不判斷合法性，只記錄「有沒有被審、誰審的」 */
export async function setLegalStatus(actor: Actor, itemId: string, raw: z.input<typeof ddLegalSchema>) {
  requirePerm(actor, 'selection.write');
  const input = ddLegalSchema.parse(raw);
  assertNoPii({ 說明: input.note });
  if (input.action !== 'REQUIRE') requirePerm(actor, 'product.review');
  if (!input.note) throw validation('請填寫說明（審查範圍、依據或結論）');
  return withTx(async (tx) => {
    const cur = await tx.query(`SELECT * FROM vendor_dd_items WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [itemId, actor.orgId]);
    if (!cur.rowCount) throw notFound('調查項目');
    const item = cur.rows[0] as Record<string, unknown>;
    const rec = await lockRecord(tx, actor, item.record_id as string);
    if (!LEGAL_EDITABLE.includes(rec.status)) throw precondition('調查已核准，不能變更法務狀態；請先撤銷核准');
    const cat = ddCategory(item.category_key as string);
    if (cat?.sensitive.length && !can(actor, 'product.cost.read')) throw forbidden('分潤條款屬敏感資料，需有成本檢視權限');
    const today = todayTaipei();
    let status = item.legal_status as string;
    const sets: Record<string, unknown> = { legal_note: input.note };
    if (input.action === 'REQUIRE') { status = 'REQUIRED'; sets.legal_reason = input.note; }
    else if (input.action === 'BLOCK') { status = 'BLOCKED'; }
    else if (input.action === 'CLEAR') {
      const ev = await tx.query<{ valid_until: string | null }>(`SELECT valid_until FROM evidence_items WHERE organization_id=$1 AND subject_type='DD_ITEM' AND subject_id=$2 AND kind='LEGAL_OPINION' AND deleted_at IS NULL`, [actor.orgId, itemId]);
      if (!ev.rows.some((e) => !e.valid_until || e.valid_until >= today)) throw validation('確認無虞前，需先附上一筆有效的「法務意見」類證據');
      status = 'CLEARED'; sets.legal_cleared_by = actor.userId; sets.legal_cleared_at = new Date().toISOString();
    } else {
      // RELEASE：自動觸發條件仍成立時不可解除，必須走 CLEAR
      const ctx = await tx.query<{ vcat: string | null; pname: string | null; pcat: string | null; pnote: string | null }>(
        `SELECT v.category AS vcat, p.name AS pname, p.category AS pcat, p.compliance_note AS pnote FROM vendors v LEFT JOIN products p ON p.id=$2 WHERE v.id=$1`, [rec.vendor_id, rec.product_id]);
      const t = triggersFor({ regulatedCategory: rec.regulated_category }, [ctx.rows[0]?.vcat, ctx.rows[0]?.pname, ctx.rows[0]?.pcat, ctx.rows[0]?.pnote])(item.category_key as string, (item.terms ?? {}) as Record<string, unknown>);
      if (t.required) throw precondition(`系統判斷仍需審查（${t.reasons.join('；')}）：請改用「確認無虞」並附法務意見`);
      status = 'NOT_REQUIRED';
    }
    if (status !== 'CLEARED') { sets.legal_cleared_by = null; sets.legal_cleared_at = null; }
    sets.legal_status = status;
    const cols = Object.keys(sets);
    await tx.query(`UPDATE vendor_dd_items SET ${cols.map((c, i) => `${c}=$${i + 3}`).join(', ')}, updated_by=$${cols.length + 3} WHERE id=$1 AND organization_id=$2`, [itemId, actor.orgId, ...cols.map((c) => sets[c]), actor.userId]);
    await audit(tx, actor, { action: `selection.dd.legal.${input.action.toLowerCase()}`, entityType: 'vendor_dd_item', entityId: itemId, before: { legalStatus: item.legal_status }, after: { legalStatus: status, note: cat?.sensitive.length ? '[敏感]' : input.note } });
    return { id: itemId, legalStatus: status };
  }).catch((e) => mapDbError(e));
}

// ---------------- 送審與審核 ----------------
export async function submitDiligence(actor: Actor, id: string) {
  requirePerm(actor, 'selection.write');
  return withTx(async (tx) => {
    const rec = await lockRecord(tx, actor, id);
    if (!EDITABLE.includes(rec.status)) throw precondition('這份調查已送審或核准');
    const cfg = await loadSelectionConfig(tx, actor.orgId);
    const readiness = await readinessOf(tx, actor.orgId, id, todayTaipei(), cfg.expiringSoonDays);
    if (!readiness.ready) throw validation(`尚不能送審：${readiness.reasons.join('；')}`, { readiness });
    await tx.query(`UPDATE vendor_dd_records SET status='IN_REVIEW', submitted_at=now(), prepared_by=$2, updated_by=$2 WHERE id=$1`, [id, actor.userId]);
    await audit(tx, actor, { action: 'selection.dd.submit', entityType: 'vendor_dd_record', entityId: id, before: { status: rec.status }, after: { status: 'IN_REVIEW', counts: readiness.counts } });
    return { id, status: 'IN_REVIEW' };
  });
}

export const ddReviewSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  note: z.string().trim().max(1000).optional().or(z.literal('').transform(() => undefined)),
  validUntil: z.string().refine(isIsoDateLike, '日期格式需為 YYYY-MM-DD').optional(),
}).strict();
function isIsoDateLike(s: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(s); }

/** 核准／退回（含撤銷已核准）。只記錄調查結果與有效期；不阻擋、也不放行 G1 */
export async function reviewDiligence(actor: Actor, id: string, raw: z.input<typeof ddReviewSchema>) {
  requirePerm(actor, 'product.review');
  requirePerm(actor, 'selection.read');
  const input = ddReviewSchema.parse(raw);
  assertNoPii({ 意見: input.note });
  if (input.decision === 'REJECTED' && !input.note) throw validation('退回或撤銷時，請填寫原因');
  return withTx(async (tx) => {
    const rec = await lockRecord(tx, actor, id);
    const today = todayTaipei();
    if (input.decision === 'APPROVED') {
      if (rec.status !== 'IN_REVIEW') throw precondition('只有「審查中」的調查可以核准');
      const cfg = await loadSelectionConfig(tx, actor.orgId);
      const readiness = await readinessOf(tx, actor.orgId, id, today, cfg.expiringSoonDays);
      if (!readiness.ready) throw validation(`不能核准：${readiness.reasons.join('；')}`, { readiness });
      const max = addDays(today, cfg.ddValidDays);
      const validUntil = input.validUntil ?? max;
      if (validUntil > max) throw validation(`有效期限不可超過 ${max}（${cfg.ddValidDays} 天）`);
      if (validUntil < today) throw validation('有效期限不可早於今天');
      await tx.query(`UPDATE vendor_dd_records SET status='APPROVED', reviewed_by=$2, reviewed_at=now(), review_note=$3, valid_until=$4, updated_by=$2 WHERE id=$1`, [id, actor.userId, input.note ?? null, validUntil]);
      await audit(tx, actor, { action: 'selection.dd.approve', entityType: 'vendor_dd_record', entityId: id, before: { status: rec.status }, after: { status: 'APPROVED', validUntil, contractVersion: rec.contract_version } });
      return { id, status: 'APPROVED', validUntil };
    }
    if (!['IN_REVIEW', 'APPROVED'].includes(rec.status)) throw precondition('只有「審查中」或「已核准」的調查可以退回／撤銷');
    await tx.query(`UPDATE vendor_dd_records SET status='REJECTED', reviewed_by=$2, reviewed_at=now(), review_note=$3, valid_until=NULL, updated_by=$2 WHERE id=$1`, [id, actor.userId, input.note]);
    await audit(tx, actor, { action: rec.status === 'APPROVED' ? 'selection.dd.revoke' : 'selection.dd.reject', entityType: 'vendor_dd_record', entityId: id, before: { status: rec.status, validUntil: rec.valid_until }, after: { status: 'REJECTED', note: input.note } });
    return { id, status: 'REJECTED' };
  }).catch((e) => mapDbError(e));
}

/** 供 G1 摘要唯讀使用：某廠商（與商品）最合適的調查——先找該商品專屬的，再找廠商通用的；各取最新 */
export async function bestDiligence(actor: Actor, vendorId: string, productId: string | null): Promise<DdSummaryView | null> {
  const rows = await query(
    `${SELECT_REC} WHERE r.organization_id=$1 AND r.vendor_id=$2 AND r.deleted_at IS NULL AND (r.product_id IS NULL OR r.product_id=$3)
     ORDER BY (r.product_id IS NOT NULL) DESC, (r.status='APPROVED') DESC, r.created_at DESC LIMIT 1`, [actor.orgId, vendorId, productId]);
  if (!rows.length) return null;
  const [rec] = await presentRecords(pool(), actor, rows as RecRow[], false);
  const items = await query<{ category_key: string; status: string; legal_status: string }>(`SELECT category_key, status, legal_status FROM vendor_dd_items WHERE record_id=$1`, [(rows[0] as RecRow).id]);
  return { ...rec, itemStates: items.map((i) => ({ key: i.category_key, status: i.status, legalStatus: i.legal_status })) } as unknown as DdSummaryView;
}

export interface DdSummaryView {
  id: string; vendorId: string; productId: string | null; contractVersion: string; status: string; validUntil: string | null;
  readiness: ReturnType<typeof ddReadiness>; validity: { valid: boolean; reasons: string[] }; itemStates: { key: string; status: string; legalStatus: string }[];
}
