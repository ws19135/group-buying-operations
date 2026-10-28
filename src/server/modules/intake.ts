import { z } from 'zod';
import type { Tx } from '../lib/db';
import { pool, query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { requirePerm, systemActor } from '../lib/permissions';
import { audit } from '../lib/audit';
import { ids } from '../lib/ids';
import { normalizeName } from '../lib/text';
import { camelize } from '../lib/case';
import { isIsoDate } from '../lib/dates';
import { insertVendor } from './vendors';
import { queueNotification } from './notifications';
import { loadActiveTemplate } from '../workflow/templates';
import { generateTasks } from './tasks';

const optText = (max = 1000) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));

/** 對應 groupbuy-flow-sop「廠商開團資料表」的欄位 */
export const intakePayloadSchema = z.object({
  vendorName: z.string().trim().min(1).max(120),
  companyName: optText(160),
  taxId: z.string().trim().regex(/^\d{8}$/).optional().or(z.literal('').transform(() => undefined)),
  contactName: z.string().trim().min(1).max(80),
  contactInfo: z.string().trim().min(1).max(200),
  website: optText(300),
  itemName: z.string().trim().min(1).max(160),
  itemUrl: optText(500),
  sellingPoints: optText(3000),
  listPrice: z.number().int().min(0).optional(),
  groupPrice: z.number().int().min(0).optional(),
  commissionText: optText(40),
  sampleReadyDate: z.string().refine(isIsoDate).optional(),
  needsRecovery: z.boolean().optional(),
  recoveryNote: optText(1000),
  expectedWindow: optText(200),
  closeRule: optText(1000),
  terms: optText(2000),
  note: optText(2000),
});

/**
 * 分潤／合作 % 文字 → 百分比數字。SOP 的踩雷：廠商有人填 20、20%、0.2。
 * 規則：含 % 或 >1 視為百分比；0<x<1 視為小數（×100）；剛好 1 有歧義，回傳 ambiguous 交人工確認。
 */
export function parseCommissionText(t: string | undefined): { percent: number | null; ambiguous: boolean } {
  if (!t) return { percent: null, ambiguous: false };
  const m = /^(\d+(?:\.\d+)?)\s*(%|％)?$/.exec(t.trim());
  if (!m) return { percent: null, ambiguous: true };
  const v = Number(m[1]);
  if (m[2]) return v <= 100 ? { percent: v, ambiguous: false } : { percent: null, ambiguous: true };
  if (v > 1 && v <= 100) return { percent: v, ambiguous: false };
  if (v > 0 && v < 1) return { percent: Math.round(v * 10000) / 100, ambiguous: false };
  return { percent: null, ambiguous: true };
}

export async function receiveVendorIntake(actor: Actor, externalSubmissionId: string, rawPayload: unknown) {
  requirePerm(actor, 'intake.write');
  const payload = intakePayloadSchema.parse(rawPayload);
  const ext = z.string().trim().min(1).max(120).parse(externalSubmissionId);
  return withTx(async (tx) => {
    const ex = await tx.query('SELECT id, status FROM vendor_intake_submissions WHERE organization_id=$1 AND external_submission_id=$2', [actor.orgId, ext]);
    if (ex.rowCount) return { id: ex.rows[0].id as string, status: ex.rows[0].status as string, replayed: true };
    const id = await ids.intake(tx);
    await tx.query(`INSERT INTO vendor_intake_submissions (id, organization_id, external_submission_id, payload, received_by) VALUES ($1,$2,$3,$4,$5)`,
      [id, actor.orgId, ext, JSON.stringify(payload), actor.userId]);
    await audit(tx, actor, { action: 'intake.receive', entityType: 'intake', entityId: id, after: { vendorName: payload.vendorName, itemName: payload.itemName } });
    return { id, status: 'NEW', replayed: false };
  });
}

export interface IntakeProcessResult { processed: number; created: number; matched: number; needsReview: number }

/** 處理待處理進件：配對／建立廠商與商品，建立草稿檔期（不碰佣金與合作條件，只記在備註供人工確認） */
export async function processIntake(orgId: string, limit = 50): Promise<IntakeProcessResult> {
  const sys = systemActor(orgId, 'WORKER', 'job:vendor_intake');
  const rows = await query(`SELECT * FROM vendor_intake_submissions WHERE organization_id=$1 AND status='NEW' ORDER BY received_at LIMIT $2`, [orgId, limit]);
  const out: IntakeProcessResult = { processed: 0, created: 0, matched: 0, needsReview: 0 };
  const managers = await query<{ id: string }>(`SELECT id FROM users WHERE organization_id=$1 AND role_key IN ('SYSTEM_ADMIN','OPS_MANAGER') AND status='ACTIVE' AND deleted_at IS NULL`, [orgId]);

  for (const row of rows) {
    const p = intakePayloadSchema.parse(row.payload);
    try {
      const result = await withTx(async (tx) => {
        const lock = await tx.query(`SELECT status FROM vendor_intake_submissions WHERE id=$1 FOR UPDATE`, [row.id]);
        if (lock.rows[0].status !== 'NEW') return null; // 另一個 worker 已處理
        const notes: string[] = [];
        const comm = parseCommissionText(p.commissionText);
        if (p.commissionText) notes.push(`廠商填寫的分潤／合作％：「${p.commissionText}」${comm.ambiguous ? '（無法判斷，需人工確認）' : `（解析為 ${comm.percent}%，尚未寫入佣金規則）`}`);

        let vendorId: string;
        let vendorStatus = 'ACTIVE';
        let created = false;
        const found = await tx.query(
          `SELECT id, status FROM vendors WHERE organization_id=$1 AND deleted_at IS NULL AND (normalized_name=$2 OR ($3::text IS NOT NULL AND tax_id=$3)) LIMIT 1`,
          [orgId, normalizeName(p.vendorName), p.taxId ?? null]);
        if (found.rowCount) { vendorId = found.rows[0].id; vendorStatus = found.rows[0].status; }
        else {
          vendorId = await insertVendor(tx, sys, {
            name: p.vendorName, companyName: p.companyName, taxId: p.taxId, website: p.website, status: 'CONTACTED',
            cooperationNote: p.terms, contacts: [{ name: p.contactName, email: p.contactInfo.includes('@') ? p.contactInfo : undefined, phone: /^[\d\-+() ]{6,}$/.test(p.contactInfo) ? p.contactInfo : undefined, lineId: !p.contactInfo.includes('@') && !/^[\d\-+() ]{6,}$/.test(p.contactInfo) ? p.contactInfo : undefined, isPrimary: true }],
          });
          created = true;
        }
        if (['BLACKLISTED', 'PAUSED'].includes(vendorStatus)) {
          await tx.query(`UPDATE vendor_intake_submissions SET status='NEEDS_REVIEW', vendor_id=$2, note=$3, processed_at=now() WHERE id=$1`, [row.id, vendorId, `廠商狀態為 ${vendorStatus}，需人工確認是否接受進件`]);
          await audit(tx, sys, { action: 'intake.needs_review', entityType: 'intake', entityId: row.id, after: { vendorId, reason: vendorStatus } });
          return { kind: 'review' as const, vendorId, campaignId: null as string | null };
        }
        notes.push(`進件編號 ${row.id}`);
        if (p.expectedWindow) notes.push(`預計可開團時期：${p.expectedWindow}`);
        if (p.closeRule) notes.push(`結單日期計算：${p.closeRule}`);
        if (p.terms) notes.push(`合作但書：${p.terms}`);
        if (p.recoveryNote) notes.push(`回收方式：${p.recoveryNote}`);
        if (p.note) notes.push(`備註：${p.note}`);

        // 商品（同廠商同名則沿用；不覆寫既有商品資料）
        let productId: string;
        const pr = await tx.query(`SELECT id FROM products WHERE organization_id=$1 AND vendor_id=$2 AND normalized_name=$3 AND deleted_at IS NULL`, [orgId, vendorId, normalizeName(p.itemName)]);
        if (pr.rowCount) productId = pr.rows[0].id;
        else {
          // createProduct 自帶交易，這裡直接內嵌寫入以維持單一交易
          productId = await ids.product(tx);
          await tx.query(
            `INSERT INTO products (id, organization_id, vendor_id, name, normalized_name, listing_url, selling_points, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL)`,
            [productId, orgId, vendorId, p.itemName, normalizeName(p.itemName), p.itemUrl ?? null, p.sellingPoints ?? null]);
          const skuId = await ids.sku(tx);
          await tx.query(`INSERT INTO skus (id, organization_id, product_id, sku_code, name, list_price, group_price) VALUES ($1,$2,$3,'DEFAULT',$4,$5,$6)`,
            [skuId, orgId, productId, p.itemName, p.listPrice ?? null, p.groupPrice ?? null]);
          await audit(tx, sys, { action: 'product.create', entityType: 'product', entityId: productId, after: { name: p.itemName, vendorId, via: row.id } });
        }

        // 草稿檔期：自然鍵相同（同廠商、同名、無開團日）時沿用既有
        const title = `${p.itemName}（廠商進件）`;
        const dupe = await tx.query(`SELECT id FROM campaigns WHERE organization_id=$1 AND vendor_id=$2 AND normalized_title=$3 AND open_date IS NULL AND status<>'CANCELLED' AND deleted_at IS NULL`, [orgId, vendorId, normalizeName(title)]);
        let campaignId: string;
        if (dupe.rowCount) campaignId = dupe.rows[0].id;
        else {
          const cr = await insertDraftCampaign(tx, sys, { vendorId, title, productId, sampleReadyDate: p.sampleReadyDate, needsRecovery: p.needsRecovery, notes: notes.join('\n') });
          campaignId = cr;
        }
        const needsReview = comm.ambiguous;
        await tx.query(`UPDATE vendor_intake_submissions SET status=$2, vendor_id=$3, campaign_id=$4, note=$5, processed_at=now() WHERE id=$1`,
          [row.id, needsReview ? 'NEEDS_REVIEW' : created ? 'CREATED' : 'MATCHED', vendorId, campaignId, notes.join('；')]);
        await audit(tx, sys, { action: 'intake.process', entityType: 'intake', entityId: row.id, campaignId, after: { vendorId, productId, campaignId, created, needsReview } });
        return { kind: needsReview ? ('review' as const) : created ? ('created' as const) : ('matched' as const), vendorId, campaignId };
      });
      if (!result) continue;
      out.processed++;
      if (result.kind === 'created') out.created++; else if (result.kind === 'matched') out.matched++; else out.needsReview++;
      for (const m of managers) {
        await queueNotification(pool(), orgId, {
          recipientUserId: m.id, subject: result.kind === 'review' ? '廠商進件需人工確認' : '收到新的廠商進件',
          body: `${p.vendorName}／${p.itemName}（${row.id}）${result.campaignId ? `，已建立草稿檔期 ${result.campaignId}` : ''}`,
          entityType: 'intake', entityId: row.id, dedupeKey: `intake:${row.id}:${m.id}`,
        });
      }
    } catch (e) {
      await query(`UPDATE vendor_intake_submissions SET status='NEEDS_REVIEW', note=$2, processed_at=now() WHERE id=$1 AND status='NEW'`, [row.id, `自動處理失敗：${(e as Error).message}`.slice(0, 500)]);
      out.processed++; out.needsReview++;
    }
  }
  return out;
}


async function insertDraftCampaign(tx: Tx, sys: Actor, a: { vendorId: string; title: string; productId: string; sampleReadyDate?: string; needsRecovery?: boolean; notes: string }): Promise<string> {
  const tpl = await loadActiveTemplate(tx, sys.orgId);
  const id = await ids.campaign(tx);
  await tx.query(
    `INSERT INTO campaigns (id, organization_id, title, normalized_title, vendor_id, sample_ready_date, needs_sample_recovery, internal_note,
       workflow_template_id, workflow_template_version, workflow_params) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, sys.orgId, a.title, normalizeName(a.title), a.vendorId, a.sampleReadyDate ?? null, a.needsRecovery ?? false, a.notes, tpl.id, tpl.version, JSON.stringify(tpl.params)]);
  const cp = await ids.campaignProduct(tx);
  await tx.query(`INSERT INTO campaign_products (id, organization_id, campaign_id, product_id) VALUES ($1,$2,$3,$4)`, [cp, sys.orgId, id, a.productId]);
  await generateTasks(tx, sys, id);
  await audit(tx, sys, { action: 'campaign.create', entityType: 'campaign', entityId: id, campaignId: id, after: { title: a.title, via: 'intake', status: 'DRAFT' } });
  return id;
}

export async function listIntake(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'intake.write');
  const st = q.get('status');
  const rows = await query(
    `SELECT id, external_submission_id, status, vendor_id, campaign_id, note, received_at, processed_at, payload->>'vendorName' AS vendor_name, payload->>'itemName' AS item_name
     FROM vendor_intake_submissions WHERE organization_id=$1 ${st ? 'AND status=$2' : ''} ORDER BY received_at DESC LIMIT 200`, st ? [actor.orgId, st] : [actor.orgId]);
  return camelize(rows);
}

