import { z } from 'zod';
import type { Tx } from '../lib/db';
import { pool, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, requirePerm } from '../lib/permissions';
import { forbidden, notFound, precondition, validation } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids } from '../lib/ids';
import { isIsoDate } from '../lib/dates';
import { isHttpUrl } from '../lib/text';
import { EVIDENCE_KINDS, evidenceHostAllowed } from '../lib/dd-catalog';
import { assertCampaignVisible, assertNoPii, loadSelectionConfig, mapDbError } from './selection';

/**
 * 證據連結（SOP 02／03）。只存連結與中繼資料（標題、種類、有效期、備註），不存檔案本體。
 * 掛在盡職調查項目、評估、試用、試用檢核、可行性之上；對應的父層鎖定後（核准、送出、結論）就不能再增減證據。
 */
export const SUBJECT_TYPES = ['DD_ITEM', 'EVALUATION', 'TRIAL', 'TRIAL_CHECK', 'FEASIBILITY'] as const;
type SubjectType = (typeof SUBJECT_TYPES)[number];

const optDate = z.string().refine(isIsoDate, '日期格式需為 YYYY-MM-DD').nullable().optional().or(z.literal('').transform(() => null));
export const evidenceSchema = z.object({
  subjectType: z.enum(SUBJECT_TYPES),
  subjectId: z.string().min(1).max(40),
  kind: z.enum(EVIDENCE_KINDS),
  title: z.string().trim().min(1, '請填寫標題').max(200),
  url: z.string().trim().max(2000).optional(),
  assetId: z.string().max(40).optional(),
  sourceLabel: z.string().trim().max(120).nullable().optional(),
  validFrom: optDate,
  validUntil: optDate,
  note: z.string().trim().max(500).nullable().optional(),
}).strict();

interface Subject { vendorId: string | null; productId: string | null; campaignId: string | null; editable: boolean; lockedReason: string; sensitive: boolean }

async function resolveSubject(tx: Tx, actor: Actor, type: SubjectType, id: string): Promise<Subject> {
  const org = actor.orgId;
  switch (type) {
    case 'DD_ITEM': {
      const r = await tx.query(`SELECT r.vendor_id, r.product_id, r.status, i.category_key FROM vendor_dd_items i JOIN vendor_dd_records r ON r.id=i.record_id
                                WHERE i.id=$1 AND i.organization_id=$2 AND r.deleted_at IS NULL`, [id, org]);
      if (!r.rowCount) throw notFound('調查項目');
      const x = r.rows[0] as Record<string, string | null>;
      return { vendorId: x.vendor_id, productId: x.product_id, campaignId: null, editable: ['DRAFT', 'IN_REVIEW', 'REJECTED'].includes(x.status as string), lockedReason: '這份調查已核准，不能再增減證據；請建立新合約版本的調查', sensitive: x.category_key === 'COMMISSION_TERMS' };
    }
    case 'EVALUATION': {
      const r = await tx.query(`SELECT e.product_id, e.status, p.vendor_id FROM product_evaluations e JOIN products p ON p.id=e.product_id WHERE e.id=$1 AND e.organization_id=$2`, [id, org]);
      if (!r.rowCount) throw notFound('選品評估');
      const x = r.rows[0] as Record<string, string>;
      return { vendorId: x.vendor_id, productId: x.product_id, campaignId: null, editable: x.status === 'DRAFT', lockedReason: '評估已送出，不能再增減證據；請建立新版本', sensitive: false };
    }
    case 'TRIAL':
    case 'TRIAL_CHECK': {
      const r = type === 'TRIAL'
        ? await tx.query(`SELECT t.product_id, t.vendor_id, t.campaign_id, t.status, NULL::text AS item_key FROM product_trials t WHERE t.id=$1 AND t.organization_id=$2`, [id, org])
        : await tx.query(`SELECT t.product_id, t.vendor_id, t.campaign_id, t.status, k.item_key FROM trial_checks k JOIN product_trials t ON t.id=k.trial_id WHERE k.id=$1 AND k.organization_id=$2`, [id, org]);
      if (!r.rowCount) throw notFound(type === 'TRIAL' ? '試用' : '試用檢核項');
      const x = r.rows[0] as Record<string, string | null>;
      if (x.campaign_id) await assertCampaignVisible(actor, x.campaign_id);
      return { vendorId: x.vendor_id, productId: x.product_id, campaignId: x.campaign_id, editable: x.status === 'OPEN', lockedReason: `試用已${x.status === 'CONCLUDED' ? '結論' : '取消'}，不能再增減證據；請建立新的試用`, sensitive: x.item_key === 'margin' };
    }
    case 'FEASIBILITY': {
      const r = await tx.query(`SELECT f.product_id, f.campaign_id, p.vendor_id FROM feasibility_scenarios f JOIN products p ON p.id=f.product_id WHERE f.id=$1 AND f.organization_id=$2`, [id, org]);
      if (!r.rowCount) throw notFound('可行性情境');
      const x = r.rows[0] as Record<string, string | null>;
      if (x.campaign_id) await assertCampaignVisible(actor, x.campaign_id);
      return { vendorId: x.vendor_id, productId: x.product_id, campaignId: x.campaign_id, editable: true, lockedReason: '', sensitive: true };
    }
  }
}

function checkUrl(url: string, hosts: string[]): void {
  if (!isHttpUrl(url)) throw validation('證據連結只接受 http:// 或 https://');
  const u = new URL(url);
  if (u.username || u.password) throw validation('連結不可內含帳號或密碼');
  if (!evidenceHostAllowed(url, hosts)) throw validation(`連結網域不在核准清單內（${hosts.join('、')}）`);
}

export async function createEvidence(actor: Actor, raw: z.input<typeof evidenceSchema>) {
  requirePerm(actor, 'selection.write');
  const input = evidenceSchema.parse(raw);
  assertNoPii({ 標題: input.title, 來源說明: input.sourceLabel, 備註: input.note });
  if (input.validFrom && input.validUntil && input.validUntil < input.validFrom) throw validation('有效期限不可早於起始日');
  const cfg = await loadSelectionConfig(pool(), actor.orgId);
  return withTx(async (tx) => {
    const sub = await resolveSubject(tx, actor, input.subjectType, input.subjectId);
    if (sub.sensitive && !can(actor, 'product.cost.read')) throw forbidden('這類證據（分潤、成本、報價）需有成本檢視權限才能新增');
    if (!sub.editable) throw precondition(sub.lockedReason);
    let url = input.url;
    let assetId: string | null = null;
    if (input.assetId) {
      const a = await tx.query<{ url: string; product_id: string }>(`SELECT url, product_id FROM product_assets WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL`, [input.assetId, actor.orgId]);
      if (!a.rowCount) throw notFound('商品素材');
      if (sub.productId && a.rows[0].product_id !== sub.productId) throw validation('引用的素材不屬於這個商品');
      assetId = input.assetId;
      url = url || a.rows[0].url;
    }
    if (!url) throw validation('請填寫證據連結，或引用既有商品素材');
    checkUrl(url, cfg.evidenceHosts);
    const id = await ids.evidence(tx);
    await tx.query(
      `INSERT INTO evidence_items (id, organization_id, subject_type, subject_id, vendor_id, product_id, kind, title, url, source_label, valid_from, valid_until, note, asset_id, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
      [id, actor.orgId, input.subjectType, input.subjectId, sub.vendorId, sub.productId, input.kind, input.title, url, input.sourceLabel ?? null, input.validFrom ?? null, input.validUntil ?? null, input.note ?? null, assetId, actor.userId]);
    await audit(tx, actor, { action: 'selection.evidence.add', entityType: 'evidence', entityId: id, campaignId: sub.campaignId,
      after: { subjectType: input.subjectType, subjectId: input.subjectId, kind: input.kind, title: sub.sensitive ? '[敏感]' : input.title, validUntil: input.validUntil ?? null } });
    return { id };
  }).catch((e) => mapDbError(e));
}

/** 軟刪除：只把 deleted_at 設起來；父層鎖定後不可移除 */
export async function removeEvidence(actor: Actor, id: string) {
  requirePerm(actor, 'selection.write');
  return withTx(async (tx) => {
    const cur = await tx.query(`SELECT * FROM evidence_items WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [id, actor.orgId]);
    if (!cur.rowCount || cur.rows[0].deleted_at) throw notFound('證據');
    const e = cur.rows[0] as Record<string, string | null>;
    const sub = await resolveSubject(tx, actor, e.subject_type as SubjectType, e.subject_id as string);
    if (sub.sensitive && !can(actor, 'product.cost.read')) throw forbidden('這類證據需有成本檢視權限才能移除');
    if (!sub.editable) throw precondition(sub.lockedReason);
    await tx.query(`UPDATE evidence_items SET deleted_at=now(), updated_by=$2 WHERE id=$1`, [id, actor.userId]);
    await audit(tx, actor, { action: 'selection.evidence.remove', entityType: 'evidence', entityId: id, campaignId: sub.campaignId, before: { subjectType: e.subject_type, subjectId: e.subject_id, title: sub.sensitive ? '[敏感]' : e.title } });
    return { id, removed: true };
  });
}

/** 沒有敏感權限的角色看到的證據：只留種類與有效狀態，隱去標題、連結、備註 */
export function maskEvidenceList(list: unknown[], canSee: boolean): unknown[] {
  if (canSee) return list;
  return (list as { id: string; kind: string; validUntil: string | null; state: string }[]).map((e) => ({ id: e.id, kind: e.kind, validUntil: e.validUntil, state: e.state, restricted: true }));
}

