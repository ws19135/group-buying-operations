import crypto from 'node:crypto';
import { z } from 'zod';
import type { Tx } from '../lib/db';
import { query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { requirePerm } from '../lib/permissions';
import { AppError, validation } from '../lib/errors';
import { audit, emitEvent } from '../lib/audit';
import { ids } from '../lib/ids';
import { camelize } from '../lib/case';
import { parseCsv } from '../lib/csv';
import { listPaged, pageParams } from '../lib/repo';
import { nonEmpty } from '../lib/text';
import { isIsoDate } from '../lib/dates';
import { campaignScope } from '../lib/scope';

export const ORDER_STATUSES = ['PAID', 'PENDING', 'CANCELLED', 'REFUNDED', 'PARTIAL_REFUND'] as const;
const REQUIRED_COLUMNS = ['source_order_id', 'campaign_id', 'ordered_at', 'status', 'quantity', 'unit_price'] as const;
const KNOWN_COLUMNS = [...REQUIRED_COLUMNS, 'sku_code', 'buyer_ref', 'host_id', 'community_id', 'refund_amount'];
const MAX_ROWS = 20000;
const MAX_BYTES = 2_000_000;
/** 單列數量與單價上限：避免乘積超出 bigint／JS 安全整數，讓整批匯入因一個異常值而整批失敗 */
const MAX_QTY = 1_000_000;
const MAX_UNIT_PRICE = 100_000_000;

export const importSchema = z.object({
  sourceSystem: z.string().trim().min(1).max(60),
  fileName: z.string().trim().max(200).optional(),
  csv: z.string().min(1, 'CSV 內容不可為空'),
  dataAsOf: z.string().datetime({ offset: true }).optional(),
  origin: z.enum(['IMPORT', 'DEMO']).default('IMPORT'),
});

interface RowErr { line: number; code: string; message: string; raw?: Record<string, string> }
interface OrderLine { line: number; raw: Record<string, string>; sku: string; qty: number; unit: number }

/** 台北時間 'YYYY-MM-DD HH:mm[:ss]'（空白分隔）或含時區的 ISO 字串 → Date。無時區的 'T' 格式有歧義，一律拒絕 */
export function parseOrderedAt(s: string): Date | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(t)) {
    const d = new Date(`${t.replace(' ', 'T')}${t.length === 16 ? ':00' : ''}+08:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(t)) {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

const toInt = (s: string | undefined): number | null => {
  if (s == null || s.trim() === '') return null;
  return /^-?\d+$/.test(s.trim()) ? Number(s.trim()) : NaN;
};

/**
 * 訂單 CSV 匯入（每列＝一個訂單品項；同 source_order_id 的列合併成一張訂單）。
 * - 同一份檔案（內容 sha256 相同）只能匯入一次
 * - 不同檔案重疊的訂單以 (來源系統, 來源訂單編號) 去重：內容相同＝略過；訂單層欄位有變動＝更新並留稽核
 * - 有問題的列進錯誤佇列（import_errors），不會默默消失，也不會擋住其他正確的列
 */
export async function importOrders(actor: Actor, raw: z.input<typeof importSchema>) {
  requirePerm(actor, 'order.import');
  const input = importSchema.parse(raw);
  if (input.origin === 'DEMO' && actor.source !== 'SEED' && actor.source !== 'TEST') throw validation('DEMO 資料只能由種子程式建立');
  if (Buffer.byteLength(input.csv, 'utf8') > MAX_BYTES) throw validation(`檔案過大（上限 ${MAX_BYTES / 1_000_000} MB）`);
  const checksum = crypto.createHash('sha256').update(input.csv).digest('hex');

  let table: string[][];
  try { table = parseCsv(input.csv); } catch (e) { throw validation((e as Error).message); }
  if (table.length < 2) throw validation('CSV 至少需要標題列與一筆資料');
  if (table.length - 1 > MAX_ROWS) throw validation(`資料列過多（上限 ${MAX_ROWS} 列）`);
  const header = table[0].map((h) => h.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) throw validation(`缺少必要欄位：${missing.join('、')}`);
  const unknown = header.filter((h) => !KNOWN_COLUMNS.includes(h));
  if (unknown.length) throw validation(`未知欄位：${unknown.join('、')}`);

  return withTx(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`import:${actor.orgId}`]);
    const dup = await tx.query('SELECT id FROM import_batches WHERE organization_id=$1 AND checksum=$2', [actor.orgId, checksum]);
    if (dup.rowCount) throw new AppError('CONFLICT', `此檔案內容已匯入過（批次 ${dup.rows[0].id}）`, { existingBatchId: dup.rows[0].id });

    const batchId = await ids.importBatch(tx);
    await tx.query(
      `INSERT INTO import_batches (id, organization_id, source_system, data_origin, file_name, checksum, created_by, total_rows)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [batchId, actor.orgId, input.sourceSystem, input.origin, input.fileName ?? null, checksum, actor.userId, table.length - 1]);

    const errors: RowErr[] = [];
    const groups = new Map<string, OrderLine[]>();
    const orderOrder: string[] = [];
    for (let i = 1; i < table.length; i++) {
      const line = i + 1;
      const rec: Record<string, string> = {};
      header.forEach((h, idx) => { rec[h] = (table[i][idx] ?? '').trim(); });
      const sid = rec['source_order_id'];
      if (!sid) { errors.push({ line, code: 'MISSING_ORDER_ID', message: '缺少來源訂單編號', raw: rec }); continue; }
      const qty = toInt(rec['quantity']); const unit = toInt(rec['unit_price']);
      if (qty == null || Number.isNaN(qty) || qty <= 0 || qty > MAX_QTY) { errors.push({ line, code: 'BAD_QUANTITY', message: `數量需為 1～${MAX_QTY.toLocaleString('en-US')} 的整數`, raw: rec }); continue; }
      if (unit == null || Number.isNaN(unit) || unit < 0 || unit > MAX_UNIT_PRICE) { errors.push({ line, code: 'BAD_PRICE', message: `單價需為 0～${MAX_UNIT_PRICE.toLocaleString('en-US')} 的整數`, raw: rec }); continue; }
      if (!groups.has(sid)) { groups.set(sid, []); orderOrder.push(sid); }
      (groups.get(sid) as OrderLine[]).push({ line, raw: rec, sku: rec['sku_code'] ?? '', qty, unit });
    }

    let inserted = 0, updated = 0, duplicates = 0, maxOrderedAt: Date | null = null;
    const campaignCache = new Map<string, { status: string } | null>();
    for (const sid of orderOrder) {
      const lines = groups.get(sid) as OrderLine[];
      const first = lines[0];
      const fail = (code: string, message: string) => { for (const l of lines) errors.push({ line: l.line, code, message, raw: l.raw }); };

      const cid = first.raw['campaign_id'];
      if (lines.some((l) => l.raw['campaign_id'] !== cid)) { fail('INCONSISTENT_ORDER', '同一訂單的各列 campaign_id 不一致'); continue; }
      if (!campaignCache.has(cid)) {
        // 與其他讀寫一樣套用檔期資料範圍：營運小編只能匯入自己負責（或被指派任務）的檔期；範圍外與不存在的訊息相同
        const sc = campaignScope(actor, 2, 'c');
        const c = sc.sql === 'FALSE' ? null : await tx.query(`SELECT c.status FROM campaigns c WHERE c.id=$1 AND (${sc.sql})`, [cid, ...sc.params]);
        campaignCache.set(cid, c?.rows[0] ?? null);
      }
      const camp = campaignCache.get(cid);
      if (!camp) { fail('UNKNOWN_CAMPAIGN', `找不到檔期 ${cid}`); continue; }
      if (camp.status === 'CANCELLED') { fail('CAMPAIGN_CANCELLED', `檔期 ${cid} 已取消，不接受新訂單`); continue; }
      const at = parseOrderedAt(first.raw['ordered_at']);
      if (!at) { fail('BAD_ORDERED_AT', '下單時間格式需為 YYYY-MM-DD HH:mm（台北時間）或含時區的 ISO 8601'); continue; }
      if (at.getTime() > Date.now() + 86_400_000) { fail('FUTURE_ORDER', '下單時間在未來'); continue; }
      const status = first.raw['status'].toUpperCase();
      if (!(ORDER_STATUSES as readonly string[]).includes(status)) { fail('BAD_STATUS', `訂單狀態不正確：${first.raw['status']}`); continue; }
      if (lines.some((l) => l.raw['status'].toUpperCase() !== status)) { fail('INCONSISTENT_ORDER', '同一訂單的各列狀態不一致'); continue; }

      const gross = lines.reduce((s, l) => s + l.qty * l.unit, 0);
      const refundRaw = toInt(first.raw['refund_amount']);
      const refund = refundRaw == null ? (status === 'REFUNDED' ? gross : 0) : refundRaw;
      if (Number.isNaN(refund) || refund < 0) { fail('BAD_REFUND', '退款金額需為非負整數'); continue; }
      if (refund > gross) { fail('REFUND_EXCEEDS_GROSS', '退款金額大於訂單金額'); continue; }
      if (status === 'PARTIAL_REFUND' && !(refund > 0 && refund < gross)) { fail('BAD_REFUND', '部分退款的金額需介於 0 與訂單金額之間'); continue; }
      if (status === 'REFUNDED' && refund !== gross) { fail('BAD_REFUND', '全額退款的退款金額需等於訂單金額'); continue; }
      if (['PAID', 'PENDING', 'CANCELLED'].includes(status) && refund !== 0) { fail('BAD_REFUND', `狀態 ${status} 不應有退款金額`); continue; }

      const hostId = first.raw['host_id'] || null;
      const commId = first.raw['community_id'] || null;
      if (hostId) {
        const h = await tx.query('SELECT 1 FROM campaign_hosts WHERE campaign_id=$1 AND host_id=$2 AND deleted_at IS NULL', [cid, hostId]);
        if (!h.rowCount) { fail('HOST_NOT_IN_CAMPAIGN', `團主 ${hostId} 不在檔期 ${cid} 內，無法歸因`); continue; }
      }
      if (commId) {
        const k = await tx.query('SELECT 1 FROM communities WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [commId, actor.orgId]);
        if (!k.rowCount) { fail('UNKNOWN_COMMUNITY', `找不到社群 ${commId}`); continue; }
      }
      // SKU 解析：必須是該檔期內的規格
      const resolved: { skuId: string | null; skuRaw: string }[] = [];
      let skuBad: string | null = null;
      for (const l of lines) {
        if (!l.sku) { resolved.push({ skuId: null, skuRaw: '' }); continue; }
        const s = await tx.query(
          `SELECT s.id FROM campaign_products cp JOIN skus s ON s.id=cp.sku_id
           WHERE cp.campaign_id=$1 AND cp.deleted_at IS NULL AND lower(s.sku_code)=lower($2) AND s.deleted_at IS NULL LIMIT 1`, [cid, l.sku]);
        if (!s.rowCount) { skuBad = l.sku; break; }
        resolved.push({ skuId: s.rows[0].id, skuRaw: l.sku });
      }
      if (skuBad) { fail('UNKNOWN_SKU', `規格 ${skuBad} 不在檔期 ${cid} 的商品內`); continue; }

      const ex = await tx.query('SELECT * FROM orders WHERE organization_id=$1 AND source_system=$2 AND source_order_id=$3 FOR UPDATE', [actor.orgId, input.sourceSystem, sid]);
      if (ex.rowCount) {
        const o = ex.rows[0];
        if (o.campaign_id !== cid) { fail('CAMPAIGN_CHANGED', `訂單已存在於檔期 ${o.campaign_id}，不可改掛到 ${cid}`); continue; }
        const itemsAgg = await tx.query('SELECT sum(line_amount)::bigint AS s, count(*)::int AS n FROM order_items WHERE order_id=$1', [o.id]);
        if (Number(itemsAgg.rows[0].s) !== gross || itemsAgg.rows[0].n !== lines.length) { fail('ITEMS_CHANGED', '既有訂單的品項內容與本次檔案不同，請人工處理'); continue; }
        if (o.status === status && Number(o.refund_amount) === refund) { duplicates++; continue; }
        await tx.query('UPDATE orders SET status=$2, refund_amount=$3, import_batch_id=$4 WHERE id=$1', [o.id, status, refund, batchId]);
        await audit(tx, actor, { action: 'order.update_from_import', entityType: 'order', entityId: o.id, campaignId: cid,
          before: { status: o.status, refundAmount: Number(o.refund_amount) }, after: { status, refundAmount: refund, batchId } });
        updated++;
        continue;
      }
      const oid = await ids.order(tx);
      await tx.query(
        `INSERT INTO orders (id, organization_id, campaign_id, source_system, source_order_id, ordered_at, status, gross_amount, refund_amount, buyer_ref, data_origin, import_batch_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [oid, actor.orgId, cid, input.sourceSystem, sid, at, status, gross, refund, first.raw['buyer_ref'] || null, input.origin, batchId]);
      for (let k = 0; k < lines.length; k++) {
        await tx.query(
          `INSERT INTO order_items (id, organization_id, order_id, sku_id, sku_code_raw, quantity, unit_price, line_amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [await ids.orderItem(tx), actor.orgId, oid, resolved[k].skuId, resolved[k].skuRaw || null, lines[k].qty, lines[k].unit, lines[k].qty * lines[k].unit]);
      }
      if (hostId) await tx.query(`INSERT INTO attributions (order_id, host_id, community_id, organization_id, share_percent, method) VALUES ($1,$2,$3,$4,100,'IMPORT')`, [oid, hostId, commId, actor.orgId]);
      if (!maxOrderedAt || at > maxOrderedAt) maxOrderedAt = at;
      inserted++;
    }

    for (const e of errors) {
      await tx.query('INSERT INTO import_errors (organization_id, batch_id, line_no, code, message, raw_row) VALUES ($1,$2,$3,$4,$5,$6)',
        [actor.orgId, batchId, e.line, e.code, e.message, e.raw ? JSON.stringify(e.raw) : null]);
    }
    const total = table.length - 1;
    const okRows = total - errors.length;
    const status = errors.length === 0 ? 'COMPLETED' : okRows === 0 ? 'FAILED' : 'PARTIAL';
    const asOf = input.dataAsOf ? new Date(input.dataAsOf) : maxOrderedAt;
    await tx.query(
      `UPDATE import_batches SET status=$2, inserted_rows=$3, updated_rows=$4, duplicate_rows=$5, error_rows=$6, data_as_of=$7, finished_at=now() WHERE id=$1`,
      [batchId, status, inserted, updated, duplicates, errors.length, asOf]);
    await audit(tx, actor, { action: 'import.complete', entityType: 'import_batch', entityId: batchId, after: { status, inserted, updated, duplicates, errors: errors.length } });
    await emitEvent(tx, actor, 'import.completed', 'import_batch', batchId, { status, inserted, updated, errors: errors.length }, `import.completed:${batchId}`);
    return { batchId, status, totalRows: total, insertedOrders: inserted, updatedOrders: updated, duplicateOrders: duplicates, errorRows: errors.length, dataAsOf: asOf };
  });
}

export async function listImportBatches(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'order.read');
  return listPaged<Record<string, unknown>>(
    `SELECT id, source_system, data_origin, file_name, status, total_rows, inserted_rows, updated_rows, duplicate_rows, error_rows, data_as_of, started_at, finished_at
     FROM import_batches WHERE organization_id=$1`, [actor.orgId], 'started_at DESC', pageParams(q)).then((r) => ({ ...r, items: camelize(r.items) }));
}

export async function listImportErrors(actor: Actor, batchId: string) {
  requirePerm(actor, 'order.read');
  const rows = await query(`SELECT id, line_no, code, message, raw_row, status FROM import_errors WHERE organization_id=$1 AND batch_id=$2 ORDER BY line_no LIMIT 500`, [actor.orgId, batchId]);
  return camelize(rows);
}

export async function resolveImportError(actor: Actor, errorId: number, status: 'RESOLVED' | 'IGNORED', note: string) {
  requirePerm(actor, 'order.import');
  if (!note?.trim()) throw validation('請填寫處理說明');
  return withTx(async (tx: Tx) => {
    const r = await tx.query(`UPDATE import_errors SET status=$3, resolved_at=now(), resolved_by=$4 WHERE id=$1 AND organization_id=$2 AND status='OPEN' RETURNING batch_id, line_no, code`, [errorId, actor.orgId, status, actor.userId]);
    if (!r.rowCount) throw new AppError('NOT_FOUND', '找不到待處理的錯誤列');
    await audit(tx, actor, { action: 'import_error.resolve', entityType: 'import_error', entityId: String(errorId), after: { status, ...r.rows[0] }, reason: note });
    return { id: errorId, status };
  });
}

export async function listOrders(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'order.read');
  const sc = campaignScope(actor, 1, 'c');
  if (sc.sql === 'FALSE') return { items: [], total: 0, limit: 50, offset: 0 };
  const params: unknown[] = [...sc.params];
  const where = [`(${sc.sql})`];
  const cid = nonEmpty(q.get('campaignId')); if (cid) { params.push(cid); where.push(`o.campaign_id=$${params.length}`); }
  const st = nonEmpty(q.get('status')); if (st) { params.push(st); where.push(`o.status=$${params.length}`); }
  // 下單日期區間（台北時間，含起訖日）；供儀表板 KPI 點進明細使用
  const from = nonEmpty(q.get('from')); if (from) { if (!isIsoDate(from)) throw validation('from 日期格式需為 YYYY-MM-DD'); params.push(from); where.push(`o.ordered_at >= ($${params.length}::date::text || ' 00:00:00+08')::timestamptz`); }
  const to = nonEmpty(q.get('to')); if (to) { if (!isIsoDate(to)) throw validation('to 日期格式需為 YYYY-MM-DD'); params.push(to); where.push(`o.ordered_at < (($${params.length}::date + 1)::text || ' 00:00:00+08')::timestamptz`); }
  const hid = nonEmpty(q.get('hostId')); if (hid) { params.push(hid); where.push(`EXISTS (SELECT 1 FROM attributions a WHERE a.order_id=o.id AND a.host_id=$${params.length})`); }
  if (q.get('refunded') === '1') where.push('o.refund_amount > 0');
  const res = await listPaged<Record<string, unknown>>(
    `SELECT o.id, o.campaign_id, c.title AS campaign_title, o.source_system, o.source_order_id, o.ordered_at, o.status, o.gross_amount, o.refund_amount, o.data_origin, o.import_batch_id,
       (SELECT string_agg(h.display_name, '、' ORDER BY h.display_name) FROM attributions a JOIN hosts h ON h.id=a.host_id WHERE a.order_id=o.id) AS host_names
     FROM orders o JOIN campaigns c ON c.id=o.campaign_id WHERE ${where.join(' AND ')}`, params, 'o.ordered_at DESC', pageParams(q));
  return { ...res, items: camelize(res.items) };
}
