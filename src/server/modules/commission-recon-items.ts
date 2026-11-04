import { createHash } from 'node:crypto';
import { z } from 'zod';
import { query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, requirePerm } from '../lib/permissions';
import { forbidden, notFound, precondition } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids } from '../lib/ids';
import { camelize } from '../lib/case';
import { campaignScope } from '../lib/scope';
import type { ReconRow } from '../lib/commission-reconciliation';
import { getCommissionReconciliation } from './commission-reconciliation';
import { assertNoPii, mapDbError } from './selection';

/**
 * 分潤口徑差異的「待人工確認項目」（Owner 決策 K-6a）。
 * 差異發生時建立項目，財務依既有規則版本與核准流程處理。這裡只寫入 commission_recon_items 與稽核：
 * **不覆蓋合約、可行性或財務規則的任何一方；不修改已確認結算、歷史佣金、實際付款、發票。** 讀取差異清單本身仍是唯讀；同步是明確的動作。
 */
export const RECON_ITEM_NOTE = '待人工確認項目只記錄差異與確認狀態：不會覆蓋合約、可行性或財務規則，也不會修改已確認結算、歷史佣金、實際付款或發票。財務應依既有規則版本與核准流程處理差異。';

function requireAccess(actor: Actor, write: boolean) {
  requirePerm(actor, write ? 'finance.write' : 'finance.read');
  if (!can(actor, 'product.cost.read')) throw forbidden('合約與分潤條件屬敏感資料，需有成本檢視權限');
}

/** 差異內容指紋：各欄位各來源的值與版本、核准狀態、待覆核原因（內容改變＝新的項目） */
export function reconFingerprint(r: ReconRow): string {
  const core = { reasons: r.reviewReasons, fields: r.fields.map((f) => ({ f: f.field, v: f.values.map((x) => [x.source, x.value, x.version, x.approved]) })) };
  return createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 16);
}

export async function syncCommissionReconItems(actor: Actor) {
  requireAccess(actor, true);
  const recon = await getCommissionReconciliation(actor);
  return withTx(async (tx) => {
    const active = (await tx.query(`SELECT * FROM commission_recon_items WHERE organization_id=$1 AND status IN ('OPEN','ACKNOWLEDGED') FOR UPDATE`, [actor.orgId])).rows as Record<string, string>[];
    const byKey = new Map(active.map((x) => [`${x.campaign_id}:${x.host_id}:${x.product_id}`, x]));
    const seen = new Set<string>();
    let created = 0, updated = 0, superseded = 0, resolved = 0;
    for (const r of recon.rows.filter((x) => x.needsManualReview)) {
      seen.add(r.key);
      const fp = reconFingerprint(r);
      const cur = byKey.get(r.key);
      if (cur && cur.fingerprint === fp) { await tx.query(`UPDATE commission_recon_items SET last_seen_at=now() WHERE id=$1`, [cur.id]); updated++; continue; }
      if (cur) {
        await tx.query(`UPDATE commission_recon_items SET status='SUPERSEDED', closed_at=now(), close_reason='差異內容已改變，建立新的待確認項目' WHERE id=$1`, [cur.id]);
        await audit(tx, actor, { action: 'finance.recon_item.supersede', entityType: 'commission_recon_item', entityId: cur.id, campaignId: r.campaignId, before: { status: cur.status }, after: { status: 'SUPERSEDED' } });
        superseded++;
      }
      const id = await ids.reconItem(tx);
      await tx.query(
        `INSERT INTO commission_recon_items (id, organization_id, campaign_id, host_id, product_id, fingerprint, review_reasons, snapshot, detected_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, actor.orgId, r.campaignId, r.hostId, r.productId, fp, JSON.stringify(r.reviewReasons), JSON.stringify({ fields: r.fields, impact: r.impact, verdict: r.verdict }), actor.userId]);
      await audit(tx, actor, { action: 'finance.recon_item.create', entityType: 'commission_recon_item', entityId: id, campaignId: r.campaignId, after: { hostId: r.hostId, productId: r.productId, reasonCount: r.reviewReasons.length, verdict: r.verdict } });
      created++;
    }
    // 差異已消失（資料已更新，例如合約補齊、規則對齊）：自動關閉；只是關閉「待確認項目」，不改任何來源資料
    for (const cur of active) {
      const key = `${cur.campaign_id}:${cur.host_id}:${cur.product_id}`;
      if (seen.has(key)) continue;
      await tx.query(`UPDATE commission_recon_items SET status='RESOLVED', closed_at=now(), close_reason='差異已消失（來源資料已更新）' WHERE id=$1`, [cur.id]);
      await audit(tx, actor, { action: 'finance.recon_item.resolve', entityType: 'commission_recon_item', entityId: cur.id, campaignId: cur.campaign_id, before: { status: cur.status }, after: { status: 'RESOLVED' } });
      resolved++;
    }
    return { created, updated, superseded, resolved, note: RECON_ITEM_NOTE };
  }).catch((e) => mapDbError(e, '同時有人在同步差異項目，請稍後再試'));
}

export async function listCommissionReconItems(actor: Actor, opts: { status?: string } = {}) {
  requireAccess(actor, false);
  const sc = campaignScope(actor, 2, 'c');
  if (sc.sql === 'FALSE') return { items: [], note: RECON_ITEM_NOTE };
  const rows = await query(
    `SELECT i.*, c.title AS campaign_title, h.display_name AS host_name, p.name AS product_name, u.name AS acknowledged_by_name FROM commission_recon_items i
     JOIN campaigns c ON c.id=i.campaign_id JOIN hosts h ON h.id=i.host_id JOIN products p ON p.id=i.product_id LEFT JOIN users u ON u.id=i.acknowledged_by
     WHERE i.organization_id=$1 AND (${sc.sql}) ${opts.status ? `AND i.status=$${sc.params.length + 2}` : `AND i.status IN ('OPEN','ACKNOWLEDGED')`} ORDER BY i.status, i.last_seen_at DESC, i.id DESC LIMIT 200`,
    [actor.orgId, ...sc.params, ...(opts.status ? [opts.status] : [])]);
  return { items: camelize(rows), note: RECON_ITEM_NOTE };
}

export const reconAckSchema = z.object({ note: z.string().trim().min(2, '請寫確認說明（財務將如何依既有流程處理）').max(500) }).strict();
/** 財務確認「已知悉、將依既有規則版本與核准流程處理」。只改變這個項目的狀態，不改任何財務資料 */
export async function acknowledgeReconItem(actor: Actor, id: string, raw: unknown) {
  requireAccess(actor, true);
  const input = reconAckSchema.parse(raw);
  assertNoPii({ 確認說明: input.note });
  return withTx(async (tx) => {
    const cur = await tx.query(`SELECT * FROM commission_recon_items WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [id, actor.orgId]);
    const it = cur.rows[0] as Record<string, string> | undefined;
    if (!it) throw notFound('待人工確認項目');
    const sc = campaignScope(actor, 1, 'c');
    if (sc.sql === 'FALSE' || !(await tx.query(`SELECT 1 FROM campaigns c WHERE c.id=$${sc.params.length + 1} AND (${sc.sql})`, [...sc.params, it.campaign_id])).rowCount) throw notFound('待人工確認項目');
    if (it.status !== 'OPEN') throw precondition('只有「待確認」的項目可以確認');
    await tx.query(`UPDATE commission_recon_items SET status='ACKNOWLEDGED', acknowledged_by=$2, acknowledged_at=now(), acknowledge_note=$3 WHERE id=$1`, [id, actor.userId, input.note]);
    await audit(tx, actor, { action: 'finance.recon_item.acknowledge', entityType: 'commission_recon_item', entityId: id, campaignId: it.campaign_id, before: { status: 'OPEN' }, after: { status: 'ACKNOWLEDGED', financeChanged: false } });
    return { id, status: 'ACKNOWLEDGED' as const, financeChanged: false as const };
  });
}
