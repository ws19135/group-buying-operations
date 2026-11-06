import crypto from 'node:crypto';
import { z } from 'zod';
import type { Queryable, Tx } from '../lib/db';
import { query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { isInternal, requirePerm } from '../lib/permissions';
import { conflict, notFound, precondition, validation } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids, todayTaipei } from '../lib/ids';
import { camelize } from '../lib/case';
import { normalizeName } from '../lib/text';
import { parseCsv } from '../lib/csv';
import { listPaged, pageParams } from '../lib/repo';
import {
  IMPORT_FORM_KINDS, RECIPIENT_RETENTION_DAYS_AFTER_APPROVAL, addDaysIso, importDedupeKey, mapHeaders, parseIntent, parseLooseDate, parseYesNo,
  type ImportFormKind,
} from '../lib/collaboration-rules';

/**
 * 匯入廠商現有的兩種表單（表單一＝開團追蹤、表單二＝網紅樣品申請）。
 *
 * 設計前提：**主檔對應模糊時一律列「待確認」，絕不自動猜、絕不把不同的人合併。**
 * 匯入分三步，中間可以停下來人工修正：
 *   1. preview  讀檔、對應欄位、解析主檔 → 寫 collaboration_import_rows（不建立任何申請單）
 *   2. resolve  人工指定正確的團主／廠商／商品，或跳過該列
 *   3. commit   只把 RESOLVED 的列建成合作申請（同一列重複匯入由 dedupe_key 擋下）
 */

const ISSUE_MESSAGE: Record<string, string> = {
  HOST_NOT_FOUND: '找不到對應的團主主檔，請指定或先建立團主（不會自動建立）',
  HOST_AMBIGUOUS: '有多位團主名稱相近，請人工指定是哪一位',
  PRODUCT_NOT_FOUND: '找不到對應的商品主檔，請指定商品',
  PRODUCT_AMBIGUOUS: '有多個商品名稱相近，請人工指定',
  PRODUCT_WRONG_VENDOR: '商品不屬於這次匯入指定的廠商',
  SKU_UNRESOLVED: '這個商品有多個規格，匯入後請補選規格（不影響建立申請）',
  MISSING_HOST_NAME: '這一列沒有團主／網紅名稱，無法對應',
  MISSING_PRODUCT_NAME: '這一列沒有申請樣品名稱',
  SHIP_DATE_UNREADABLE: '配送日期無法判讀，匯入後請補填',
  OPEN_DATE_UNREADABLE: '開團日期無法判讀，匯入後請補填',
  INTENT_UNREADABLE: '開團意願無法判讀，匯入後維持「待回覆」',
  RESENT_UNREADABLE: '「是否已補寄」無法判讀，匯入後以實際寄送紀錄為準',
  CAMPAIGN_NOT_LINKED: '有開團連結或開團日期，但沒有對應的正式檔期；只會留下連結與預計日期，不會自動建立檔期',
  RECIPIENT_INCOMPLETE: '收件資訊不完整（收件人／電話／地址缺一），匯入後不會建立收件資料',
};

type Issue = { code: keyof typeof ISSUE_MESSAGE | string; message: string; blocking: boolean };
const issue = (code: string, blocking: boolean): Issue => ({ code, message: ISSUE_MESSAGE[code] ?? code, blocking });

export const previewSchema = z.object({
  kind: z.enum(IMPORT_FORM_KINDS),
  vendorId: z.string().trim().min(1, '請指定這份檔案屬於哪一家廠商'),
  csv: z.string().min(1, '請提供檔案內容').max(2_000_000),
  fileName: z.string().trim().max(200).nullable().optional(),
}).strict();

interface ParsedRow {
  rowNo: number;
  raw: Record<string, string>;
  hostNameRaw: string | null;
  productNameRaw: string | null;
  resolvedHostId: string | null;
  resolvedProductId: string | null;
  resolvedSkuId: string | null;
  dedupeKey: string;
  issues: Issue[];
}

async function resolveHost(db: Queryable, orgId: string, name: string | null): Promise<{ id: string | null; issues: Issue[] }> {
  if (!name) return { id: null, issues: [issue('MISSING_HOST_NAME', true)] };
  const norm = normalizeName(name);
  if (!norm) return { id: null, issues: [issue('MISSING_HOST_NAME', true)] };
  const exact = await db.query<{ id: string }>(
    'SELECT id FROM hosts WHERE organization_id=$1 AND normalized_name=$2 AND deleted_at IS NULL', [orgId, norm]);
  if (exact.rowCount === 1) return { id: exact.rows[0].id, issues: [] };
  if ((exact.rowCount ?? 0) > 1) return { id: null, issues: [issue('HOST_AMBIGUOUS', true)] };
  // 同一人不同寫法：用「包含」再找一次，但找到多個就列待確認，絕不挑一個
  const like = await db.query<{ id: string }>(
    `SELECT id FROM hosts WHERE organization_id=$1 AND deleted_at IS NULL
       AND (normalized_name LIKE '%' || $2 || '%' OR $2 LIKE '%' || normalized_name || '%') LIMIT 5`, [orgId, norm]);
  if (like.rowCount === 1) return { id: like.rows[0].id, issues: [] };
  if ((like.rowCount ?? 0) > 1) return { id: null, issues: [issue('HOST_AMBIGUOUS', true)] };
  return { id: null, issues: [issue('HOST_NOT_FOUND', true)] };
}

async function resolveProduct(db: Queryable, orgId: string, vendorId: string, name: string | null):
  Promise<{ id: string | null; skuId: string | null; issues: Issue[] }> {
  if (!name) return { id: null, skuId: null, issues: [issue('MISSING_PRODUCT_NAME', true)] };
  const norm = normalizeName(name);
  if (!norm) return { id: null, skuId: null, issues: [issue('MISSING_PRODUCT_NAME', true)] };
  const exact = await db.query<{ id: string; vendor_id: string }>(
    'SELECT id, vendor_id FROM products WHERE organization_id=$1 AND normalized_name=$2 AND deleted_at IS NULL', [orgId, norm]);
  let hit: { id: string; vendor_id: string } | null = null;
  if (exact.rowCount === 1) hit = exact.rows[0];
  else if ((exact.rowCount ?? 0) > 1) return { id: null, skuId: null, issues: [issue('PRODUCT_AMBIGUOUS', true)] };
  else {
    const like = await db.query<{ id: string; vendor_id: string }>(
      `SELECT id, vendor_id FROM products WHERE organization_id=$1 AND vendor_id=$2 AND deleted_at IS NULL
         AND (normalized_name LIKE '%' || $3 || '%' OR $3 LIKE '%' || normalized_name || '%') LIMIT 5`, [orgId, vendorId, norm]);
    if (like.rowCount === 1) hit = like.rows[0];
    else if ((like.rowCount ?? 0) > 1) return { id: null, skuId: null, issues: [issue('PRODUCT_AMBIGUOUS', true)] };
    else return { id: null, skuId: null, issues: [issue('PRODUCT_NOT_FOUND', true)] };
  }
  if (hit.vendor_id !== vendorId) return { id: null, skuId: null, issues: [issue('PRODUCT_WRONG_VENDOR', true)] };
  // 同商品不同規格：只有剛好一個規格時才自動帶，多個規格留白並提示補選（不當成不同商品）
  const skus = await db.query<{ id: string }>(
    'SELECT id FROM skus WHERE organization_id=$1 AND product_id=$2 AND deleted_at IS NULL LIMIT 5', [orgId, hit.id]);
  if (skus.rowCount === 1) return { id: hit.id, skuId: skus.rows[0].id, issues: [] };
  if ((skus.rowCount ?? 0) > 1) return { id: hit.id, skuId: null, issues: [issue('SKU_UNRESOLVED', false)] };
  return { id: hit.id, skuId: null, issues: [] };
}

/** 第一步：讀檔、對應欄位、解析主檔。這一步不會建立任何申請單。 */
export async function previewImport(actor: Actor, raw: z.input<typeof previewSchema>) {
  requirePerm(actor, 'collaboration.create');
  requirePerm(actor, 'collaboration.update');
  if (!isInternal(actor)) throw precondition('只有內部營運人員可以匯入歷史表單');
  const input = previewSchema.parse(raw);

  const v = await query('SELECT 1 FROM vendors WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [input.vendorId, actor.orgId]);
  if (!v.length) throw notFound('廠商');

  let table: string[][];
  try { table = parseCsv(input.csv); } catch (e) { throw validation((e as Error).message); }
  if (table.length < 2) throw validation('檔案需要有標題列與至少一列資料');
  const { map, unknown } = mapHeaders(table[0], input.kind);
  if (!Object.keys(map).length) throw validation('標題列無法對應到任何已知欄位，請確認是表單一或表單二的格式');

  const checksum = crypto.createHash('sha256').update(`${input.kind}|${input.vendorId}|${input.csv}`).digest('hex');
  const parsed: ParsedRow[] = [];

  return withTx(async (tx) => {
    const dup = await tx.query<{ id: string }>('SELECT id FROM import_batches WHERE organization_id=$1 AND checksum=$2', [actor.orgId, checksum]);
    if (dup.rowCount) throw conflict(`這份檔案已經匯入過（批次 ${dup.rows[0].id}），請改用該批次或修改內容後再匯入`);
    const batchId = await ids.importBatch(tx);
    await tx.query(
      `INSERT INTO import_batches (id, organization_id, source_system, data_origin, file_name, checksum, created_by, total_rows)
       VALUES ($1,$2,$3,'IMPORT',$4,$5,$6,$7)`,
      [batchId, actor.orgId, `COLLABORATION_${input.kind}`, input.fileName ?? null, checksum, actor.userId, table.length - 1]);

    let duplicates = 0;
    for (let i = 1; i < table.length; i++) {
      const cells = table[i];
      if (!cells.some((c) => c.trim())) continue;
      const rec: Record<string, string> = {};
      for (const [idx, field] of Object.entries(map)) rec[field] = (cells[Number(idx)] ?? '').trim();
      const row = await buildRow(tx, actor, input.kind, input.vendorId, i + 1, rec);
      parsed.push(row);

      const blocking = row.issues.some((x) => x.blocking);
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO collaboration_import_rows (id, organization_id, batch_id, row_no, form_kind, raw,
           host_name_raw, vendor_name_raw, product_name_raw, resolved_host_id, resolved_vendor_id, resolved_product_id,
           resolved_sku_id, resolution, issues, dedupe_key, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
         ON CONFLICT (organization_id, dedupe_key) WHERE deleted_at IS NULL DO NOTHING RETURNING id`,
        [await ids.collaborationImportRow(tx), actor.orgId, batchId, row.rowNo, input.kind, JSON.stringify(row.raw),
          row.hostNameRaw, row.productNameRaw, row.resolvedHostId, input.vendorId, row.resolvedProductId,
          row.resolvedSkuId, blocking ? 'NEEDS_REVIEW' : 'RESOLVED', JSON.stringify(row.issues), row.dedupeKey, actor.userId]);
      if (!ins.rowCount) duplicates++;
    }

    const needsReview = parsed.filter((r) => r.issues.some((x) => x.blocking)).length;
    await tx.query(
      `UPDATE import_batches SET status=$2, inserted_rows=$3, duplicate_rows=$4, error_rows=$5, finished_at=now() WHERE id=$1`,
      [batchId, needsReview ? 'PARTIAL' : 'COMPLETED', parsed.length - duplicates, duplicates, needsReview]);
    for (const r of parsed) {
      for (const x of r.issues.filter((y) => y.blocking)) {
        await tx.query(
          `INSERT INTO import_errors (organization_id, batch_id, line_no, code, message, raw_row) VALUES ($1,$2,$3,$4,$5,$6)`,
          [actor.orgId, batchId, r.rowNo, x.code, x.message, JSON.stringify(r.raw)]);
      }
    }
    await audit(tx, actor, {
      action: 'collaboration.import.preview', entityType: 'import_batch', entityId: batchId,
      after: { kind: input.kind, vendorId: input.vendorId, rows: parsed.length, needsReview, duplicates, unknownColumns: unknown },
    });
    return {
      batchId, kind: input.kind, vendorId: input.vendorId,
      totalRows: table.length - 1, staged: parsed.length - duplicates, duplicates, needsReview,
      unknownColumns: unknown,
      rows: parsed.map((r) => ({
        rowNo: r.rowNo, hostNameRaw: r.hostNameRaw, productNameRaw: r.productNameRaw,
        resolvedHostId: r.resolvedHostId, resolvedProductId: r.resolvedProductId, resolvedSkuId: r.resolvedSkuId,
        issues: r.issues, resolution: r.issues.some((x) => x.blocking) ? 'NEEDS_REVIEW' : 'RESOLVED',
      })),
    };
  });
}

async function buildRow(tx: Tx, actor: Actor, kind: ImportFormKind, vendorId: string, rowNo: number, rec: Record<string, string>): Promise<ParsedRow> {
  const issues: Issue[] = [];
  const hostNameRaw = rec.hostName || null;
  const productNameRaw = rec.productName || null;

  const host = await resolveHost(tx, actor.orgId, hostNameRaw);
  issues.push(...host.issues);

  let productId: string | null = null;
  let skuId: string | null = null;
  if (kind === 'FORM2_SAMPLE') {
    const p = await resolveProduct(tx, actor.orgId, vendorId, productNameRaw);
    productId = p.id; skuId = p.skuId; issues.push(...p.issues);
    if (rec.shipDate && !parseLooseDate(rec.shipDate)) issues.push(issue('SHIP_DATE_UNREADABLE', false));
    if (rec.plannedOpenDate && !parseLooseDate(rec.plannedOpenDate)) issues.push(issue('OPEN_DATE_UNREADABLE', false));
    if (rec.intentRaw && !parseIntent(rec.intentRaw)) issues.push(issue('INTENT_UNREADABLE', false));
    const haveAny = [rec.recipientName, rec.recipientPhone, rec.addressLine].some((x) => x);
    const haveAll = [rec.recipientName, rec.recipientPhone, rec.addressLine].every((x) => x);
    if (haveAny && !haveAll) issues.push(issue('RECIPIENT_INCOMPLETE', false));
  } else {
    if (rec.resendDate && !parseLooseDate(rec.resendDate)) issues.push(issue('OPEN_DATE_UNREADABLE', false));
    if (rec.resentRaw && parseYesNo(rec.resentRaw) === null) issues.push(issue('RESENT_UNREADABLE', false));
  }
  // 有開團連結或檔期名稱，但找不到對應的正式檔期：只留連結，不自動建檔期
  if (rec.launchUrl || rec.campaignLabel) {
    const label = rec.campaignLabel ? normalizeName(rec.campaignLabel) : '';
    const c = label
      ? await tx.query('SELECT 1 FROM campaigns WHERE organization_id=$1 AND vendor_id=$2 AND lower(title) LIKE $3 AND deleted_at IS NULL LIMIT 1',
        [actor.orgId, vendorId, `%${rec.campaignLabel.trim().toLowerCase()}%`])
      : { rowCount: 0 };
    if (!c.rowCount) issues.push(issue('CAMPAIGN_NOT_LINKED', false));
  }
  return {
    rowNo, raw: rec, hostNameRaw, productNameRaw,
    resolvedHostId: host.id, resolvedProductId: productId, resolvedSkuId: skuId,
    dedupeKey: importDedupeKey(kind, {
      vendor: vendorId, host: hostNameRaw, product: productNameRaw,
      on: rec.shipDate || rec.plannedOpenDate || rec.resendDate || null,
    }),
    issues,
  };
}

export const resolveRowSchema = z.object({
  hostId: z.string().trim().max(40).nullable().optional(),
  productId: z.string().trim().max(40).nullable().optional(),
  skuId: z.string().trim().max(40).nullable().optional(),
  skip: z.boolean().optional(),
  note: z.string().trim().max(500).nullable().optional(),
}).strict();

/** 第二步：人工修正主檔對應，或跳過這一列。系統不會替使用者猜。 */
export async function resolveImportRow(actor: Actor, rowId: string, raw: z.input<typeof resolveRowSchema>) {
  requirePerm(actor, 'collaboration.update');
  if (!isInternal(actor)) throw precondition('只有內部營運人員可以處理匯入待確認項目');
  const input = resolveRowSchema.parse(raw);
  return withTx(async (tx) => {
    const cur = await tx.query<{ id: string; form_kind: ImportFormKind; resolved_vendor_id: string; resolved_host_id: string | null; resolved_product_id: string | null; resolution: string; application_id: string | null }>(
      `SELECT id, form_kind, resolved_vendor_id, resolved_host_id, resolved_product_id, resolution, application_id
         FROM collaboration_import_rows WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL FOR UPDATE`, [rowId, actor.orgId]);
    if (!cur.rowCount) throw notFound('匯入資料列');
    const row = cur.rows[0];
    if (row.resolution === 'IMPORTED') throw precondition('這一列已經建立申請單，不可再修改對應');

    if (input.skip) {
      await tx.query(`UPDATE collaboration_import_rows SET resolution='SKIPPED', resolve_note=$2, updated_by=$3 WHERE id=$1`, [rowId, input.note ?? null, actor.userId]);
      await audit(tx, actor, { action: 'collaboration.import.skip', entityType: 'collaboration_import_row', entityId: rowId, reason: input.note ?? null });
      return { id: rowId, resolution: 'SKIPPED' };
    }
    const hostId = input.hostId ?? row.resolved_host_id;
    const productId = input.productId ?? row.resolved_product_id;
    if (hostId) {
      const h = await tx.query('SELECT 1 FROM hosts WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [hostId, actor.orgId]);
      if (!h.rowCount) throw notFound('團主');
    }
    if (productId) {
      const p = await tx.query<{ vendor_id: string }>('SELECT vendor_id FROM products WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [productId, actor.orgId]);
      if (!p.rowCount) throw notFound('商品');
      if (p.rows[0].vendor_id !== row.resolved_vendor_id) throw validation('商品不屬於這次匯入的廠商');
    }
    if (input.skuId) {
      const s = await tx.query('SELECT 1 FROM skus WHERE id=$1 AND product_id=$2 AND organization_id=$3 AND deleted_at IS NULL', [input.skuId, productId, actor.orgId]);
      if (!s.rowCount) throw validation('規格不屬於這個商品');
    }
    const needHost = !hostId;
    const needProduct = row.form_kind === 'FORM2_SAMPLE' && !productId;
    const resolution = needHost || needProduct ? 'NEEDS_REVIEW' : 'RESOLVED';
    await tx.query(
      `UPDATE collaboration_import_rows SET resolved_host_id=$2, resolved_product_id=$3, resolved_sku_id=$4,
         resolution=$5, resolve_note=$6, resolved_at=now(), resolved_by=$7, updated_by=$7 WHERE id=$1`,
      [rowId, hostId, productId, input.skuId ?? null, resolution, input.note ?? null, actor.userId]);
    await audit(tx, actor, {
      action: 'collaboration.import.resolve', entityType: 'collaboration_import_row', entityId: rowId,
      before: { hostId: row.resolved_host_id, productId: row.resolved_product_id },
      after: { hostId, productId, skuId: input.skuId ?? null, resolution },
    });
    return { id: rowId, resolution };
  });
}

/**
 * 第三步：把已對應好的列建成合作申請。
 * 同一列只會建立一次（dedupe_key＋application_id 雙重保護）；NEEDS_REVIEW 與 SKIPPED 一律略過。
 */
export async function commitImport(actor: Actor, batchId: string) {
  requirePerm(actor, 'collaboration.create');
  requirePerm(actor, 'collaboration.update');
  if (!isInternal(actor)) throw precondition('只有內部營運人員可以匯入歷史表單');
  return withTx(async (tx) => {
    const b = await tx.query('SELECT 1 FROM import_batches WHERE id=$1 AND organization_id=$2', [batchId, actor.orgId]);
    if (!b.rowCount) throw notFound('匯入批次');
    const rows = await tx.query<{
      id: string; form_kind: ImportFormKind; raw: Record<string, string>; resolved_vendor_id: string;
      resolved_host_id: string; resolved_product_id: string | null; resolved_sku_id: string | null; dedupe_key: string;
    }>(`SELECT id, form_kind, raw, resolved_vendor_id, resolved_host_id, resolved_product_id, resolved_sku_id, dedupe_key
          FROM collaboration_import_rows
         WHERE batch_id=$1 AND organization_id=$2 AND resolution='RESOLVED' AND application_id IS NULL AND deleted_at IS NULL
         ORDER BY row_no FOR UPDATE`, [batchId, actor.orgId]);

    const created: string[] = [];
    let skipped = 0;
    for (const r of rows.rows) {
      if (!r.resolved_host_id) { skipped++; continue; }
      const existing = await tx.query<{ id: string }>(
        'SELECT id FROM collaboration_applications WHERE organization_id=$1 AND dedupe_key=$2 AND deleted_at IS NULL', [actor.orgId, r.dedupe_key]);
      if (existing.rowCount) {
        await tx.query(`UPDATE collaboration_import_rows SET resolution='IMPORTED', application_id=$2, updated_by=$3 WHERE id=$1`, [r.id, existing.rows[0].id, actor.userId]);
        skipped++;
        continue;
      }
      const appId = await applyRow(tx, actor, r);
      await tx.query(`UPDATE collaboration_import_rows SET resolution='IMPORTED', application_id=$2, updated_by=$3 WHERE id=$1`, [r.id, appId, actor.userId]);
      created.push(appId);
    }
    await tx.query('UPDATE import_batches SET updated_rows=$2 WHERE id=$1', [batchId, created.length]);
    await audit(tx, actor, {
      action: 'collaboration.import.commit', entityType: 'import_batch', entityId: batchId,
      after: { created: created.length, skipped, applicationIds: created.slice(0, 50) },
    });
    return { batchId, created: created.length, skipped, applicationIds: created };
  });
}

/** 建立一筆匯入來源的申請單：歷史資料直接落在對應的狀態，但個資與寄送紀錄都按真實證據建立 */
async function applyRow(tx: Tx, actor: Actor, r: {
  form_kind: ImportFormKind; raw: Record<string, string>; resolved_vendor_id: string;
  resolved_host_id: string; resolved_product_id: string | null; resolved_sku_id: string | null; dedupe_key: string;
}): Promise<string> {
  const rec = r.raw ?? {};
  const shipDate = parseLooseDate(rec.shipDate);
  const planned = parseLooseDate(rec.plannedOpenDate);
  const resendDate = parseLooseDate(rec.resendDate);
  const intent = parseIntent(rec.intentRaw) ?? 'PENDING';
  const resent = parseYesNo(rec.resentRaw);
  const ads = parseYesNo(rec.adsIntentRaw);
  const appliedOn = shipDate ?? planned ?? resendDate ?? todayTaipei();

  // 歷史資料已經是「廠商同意並寄出」之後的狀態，所以落在 APPROVED；沒有任何核准動作被偽造，
  // status_reason 明寫是匯入，稽核也留有批次來源。
  const appId = await ids.collaborationApplication(tx);
  await tx.query(
    `INSERT INTO collaboration_applications (id, organization_id, vendor_id, host_id, product_id, source, applied_on,
       status, collaboration_status, status_reason, note, dedupe_key, decided_at, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,'IMPORT',$6,'APPROVED',$7,'由歷史表單匯入',$8,$9,now(),$10,$10)`,
    [appId, actor.orgId, r.resolved_vendor_id, r.resolved_host_id, r.resolved_product_id, appliedOn,
      shipDate ? 'SAMPLE_IN_PROGRESS' : 'NOT_STARTED', rec.note || null, r.dedupe_key, actor.userId]);

  if (r.resolved_product_id) {
    await tx.query(
      `INSERT INTO collaboration_application_items (id, organization_id, application_id, product_id, sku_id, requested_qty,
         approved_qty, supply_status, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,1,1,'AVAILABLE',$6,$6)
       ON CONFLICT (application_id, product_id, coalesce(sku_id, '')) WHERE deleted_at IS NULL DO NOTHING`,
      [await ids.collaborationItem(tx), actor.orgId, appId, r.resolved_product_id, r.resolved_sku_id, actor.userId]);
  }

  // 收件資訊：三欄齊全才建立，並直接標記為已確認（來源表單就是團主自己填的）
  if (rec.recipientName && rec.recipientPhone && rec.addressLine) {
    const rid = await ids.collaborationRecipient(tx);
    await tx.query(
      `INSERT INTO collaboration_recipients (id, organization_id, application_id, recipient_name, recipient_phone,
         address_line, confirmed_at, confirmed_by, retention_until, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8,$7,$7)`,
      [rid, actor.orgId, appId, rec.recipientName, rec.recipientPhone, rec.addressLine, actor.userId,
        addDaysIso(appliedOn, RECIPIENT_RETENTION_DAYS_AFTER_APPROVAL)]);
    await tx.query(
      `INSERT INTO collaboration_events (organization_id, application_id, dimension, event_type, note, is_internal, actor_user_id, actor_role)
       VALUES ($1,$2,'DATA','RECIPIENT_IMPORTED','由歷史表單匯入',true,$3,$4)`, [actor.orgId, appId, actor.userId, actor.role]);
  }

  // 寄送紀錄：有寄出日就建首次寄送；表單一的「已補寄」有日期才建補寄列（沒有日期就不偽造寄送事實）
  if (shipDate) {
    await tx.query(
      `INSERT INTO collaboration_shipments (id, organization_id, application_id, shipment_type, shipped_by_party,
         ship_date, status, note, created_by, updated_by)
       VALUES ($1,$2,$3,'INITIAL','VENDOR',$4,'SHIPPED','由歷史表單匯入',$5,$5)`,
      [await ids.collaborationShipment(tx), actor.orgId, appId, shipDate, actor.userId]);
  }
  if (resent && resendDate) {
    if (!shipDate) {
      await tx.query(
        `INSERT INTO collaboration_shipments (id, organization_id, application_id, shipment_type, shipped_by_party,
           ship_date, status, note, created_by, updated_by)
         VALUES ($1,$2,$3,'INITIAL','VENDOR',$4,'SHIPPED','由歷史表單匯入（原始寄出日未知，以補寄日補登）',$5,$5)`,
        [await ids.collaborationShipment(tx), actor.orgId, appId, resendDate, actor.userId]);
    }
    await tx.query(
      `INSERT INTO collaboration_shipments (id, organization_id, application_id, shipment_type, shipped_by_party,
         ship_date, status, note, created_by, updated_by)
       VALUES ($1,$2,$3,'RESEND','VENDOR',$4,'SHIPPED','由歷史表單匯入',$5,$5)`,
      [await ids.collaborationShipment(tx), actor.orgId, appId, resendDate, actor.userId]);
  }

  // 開團合作資訊
  await tx.query(
    `INSERT INTO collaboration_launch_details (id, organization_id, application_id, intent, intent_responded_on,
       planned_open_date, launch_url, vendor_portal_url, backend_setup_email, backend_setup_status, ads_intent, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
    [await ids.collaborationLaunch(tx), actor.orgId, appId, intent,
      // 來源表單沒有「回覆日期」欄；有意願就以該列的日期補登，避免沒有依據的空值
      intent === 'PENDING' ? null : (planned ?? shipDate ?? appliedOn),
      planned, rec.launchUrl || null, rec.vendorPortalUrl || null, rec.backendSetupEmail || null,
      rec.backendSetupEmail ? 'DONE' : 'NOT_REQUIRED', ads === null ? 'PENDING' : ads ? 'YES' : 'NO', actor.userId]);

  await tx.query(
    `INSERT INTO collaboration_events (organization_id, application_id, dimension, event_type, to_status, note, is_internal, actor_user_id, actor_role)
     VALUES ($1,$2,'APPLICATION','IMPORTED','APPROVED','由歷史表單匯入',false,$3,$4)`, [actor.orgId, appId, actor.userId, actor.role]);
  await audit(tx, actor, {
    action: 'collaboration.application.import', entityType: 'collaboration_application', entityId: appId,
    after: { source: 'IMPORT', hostId: r.resolved_host_id, vendorId: r.resolved_vendor_id, formKind: r.form_kind },
  });
  return appId;
}

/** 待確認清單（匯入預覽之後，營運逐列修正時看的那張表） */
export async function listImportRows(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'collaboration.read');
  if (!isInternal(actor)) throw precondition('只有內部營運人員可以查看匯入資料列');
  const where = ['r.organization_id = $1', 'r.deleted_at IS NULL'];
  const params: unknown[] = [actor.orgId];
  const batchId = q.get('batchId');
  if (batchId) { params.push(batchId); where.push(`r.batch_id = $${params.length}`); }
  const resolution = q.get('resolution');
  if (resolution) { params.push(resolution); where.push(`r.resolution = $${params.length}`); }
  const res = await listPaged<Record<string, unknown>>(
    `SELECT r.id, r.batch_id, r.row_no, r.form_kind, r.host_name_raw, r.product_name_raw,
            r.resolved_host_id, r.resolved_vendor_id, r.resolved_product_id, r.resolved_sku_id,
            r.resolution, r.issues, r.application_id, r.resolve_note, r.created_at,
            h.display_name AS resolved_host_name, p.name AS resolved_product_name
       FROM collaboration_import_rows r
       LEFT JOIN hosts h ON h.id = r.resolved_host_id
       LEFT JOIN products p ON p.id = r.resolved_product_id
      WHERE ${where.join(' AND ')}`, params, 'r.row_no ASC, r.id ASC', pageParams(q));
  return { ...res, items: camelize(res.items) };
}

/** 匯入批次清單（只列本模組的批次） */
export async function listImportBatches(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'collaboration.read');
  if (!isInternal(actor)) throw precondition('只有內部營運人員可以查看匯入批次');
  const res = await listPaged<Record<string, unknown>>(
    `SELECT id, source_system, file_name, status, total_rows, inserted_rows, updated_rows, duplicate_rows, error_rows,
            started_at, finished_at
       FROM import_batches WHERE organization_id=$1 AND source_system LIKE 'COLLABORATION_%'`,
    [actor.orgId], 'started_at DESC', pageParams(q));
  return { ...res, items: camelize(res.items) };
}
