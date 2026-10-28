import { z } from 'zod';
import type { Tx } from '../lib/db';
import { pool, query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { requirePerm } from '../lib/permissions';
import { forbidden, notFound, precondition, validation } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids } from '../lib/ids';
import { camelize } from '../lib/case';
import { idempotent } from '../lib/idempotency';
import { campaignScope } from '../lib/scope';
import { isIsoDate } from '../lib/dates';
import { applyClears, likePattern, listPaged, pageParams, patchEntity } from '../lib/repo';
import { campaignHostCommission } from '../lib/commission-calc';
import { SALES_STATUSES } from '../lib/kpi';
import { SETTLEMENT_NOTICE } from './settlements';

/**
 * 財務紀錄（Phase 2）：入帳／付款確認、發票、費用。
 * 全部只是「紀錄」——不接銀行、金流、電子發票；參考號與抬頭／統編欄位請使用佔位字，不要放真實帳號。
 */
const MAX_AMOUNT = 1_000_000_000_000;
const date = z.string().refine(isIsoDate, '日期格式需為 YYYY-MM-DD');
const money = z.number().int('金額需為整數').min(1, '金額必須大於 0').max(MAX_AMOUNT);
const text = (n: number) => z.string().trim().max(n).optional().transform((v) => (v ? v : undefined));

type Db = Tx | ReturnType<typeof pool>;

async function campaignOk(db: Db, actor: Actor, campaignId: string) {
  const sc = campaignScope(actor, 1, 'c');
  if (sc.sql === 'FALSE') throw forbidden();
  const r = await db.query(`SELECT c.id FROM campaigns c WHERE (${sc.sql}) AND c.id=$${sc.params.length + 1}`, [...sc.params, campaignId]);
  if (!r.rowCount) throw notFound('檔期');
}

/** 驗證結算項目屬於本組織、所在結算未作廢；回傳其檔期 */
async function itemCampaign(db: Db, actor: Actor, itemId: string): Promise<string> {
  const r = await db.query<{ campaign_id: string; status: string }>(
    `SELECT i.campaign_id, s.status FROM settlement_items i JOIN settlements s ON s.id=i.settlement_id WHERE i.id=$1 AND i.organization_id=$2`, [itemId, actor.orgId]);
  if (!r.rows[0]) throw notFound('結算項目');
  if (r.rows[0].status === 'VOID') throw precondition('此結算項目所屬的結算已作廢，不能關聯');
  await campaignOk(db, actor, r.rows[0].campaign_id);
  return r.rows[0].campaign_id;
}

// ===================== 入帳／付款確認紀錄 =====================
export const paymentSchema = z.object({
  direction: z.enum(['IN', 'OUT']),
  counterpartyType: z.enum(['VENDOR', 'HOST', 'PLATFORM']),
  counterpartyId: text(40),
  amount: money,
  paidOn: date,
  referenceNo: text(100),
  note: text(500),
  campaignId: text(40),
  settlementItemId: text(40),
});

async function checkCounterparty(db: Db, actor: Actor, type: string, id: string | undefined | null) {
  if (type === 'PLATFORM') { if (id) throw validation('對象為平台時不可指定對象編號'); return; }
  if (!id) throw validation('請指定對象編號（廠商或團主）');
  const t = type === 'VENDOR' ? 'vendors' : 'hosts';
  const r = await db.query(`SELECT 1 FROM ${t} WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL`, [id, actor.orgId]);
  if (!r.rowCount) throw notFound(type === 'VENDOR' ? '廠商' : '團主');
}

export async function createPayment(actor: Actor, raw: z.input<typeof paymentSchema>, idemKey?: string | null) {
  requirePerm(actor, 'finance.write');
  const p = paymentSchema.parse(raw);
  return withTx(async (tx) => {
    const { result, replayed } = await idempotent(tx, actor, 'payment.create', idemKey, async () => {
      await checkCounterparty(tx, actor, p.counterpartyType, p.counterpartyId);
      let campaignId = p.campaignId ?? null;
      if (p.settlementItemId) {
        const ic = await itemCampaign(tx, actor, p.settlementItemId);
        if (campaignId && campaignId !== ic) throw validation('結算項目所屬檔期與指定的檔期不一致');
        campaignId = ic;
      } else if (campaignId) await campaignOk(tx, actor, campaignId);
      const id = await ids.payment(tx);
      await tx.query(
        `INSERT INTO payments (id, organization_id, direction, counterparty_type, counterparty_id, amount, paid_on, reference_no, note, campaign_id, settlement_item_id, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
        [id, actor.orgId, p.direction, p.counterpartyType, p.counterpartyId ?? null, p.amount, p.paidOn, p.referenceNo ?? null, p.note ?? null, campaignId, p.settlementItemId ?? null, actor.userId]);
      await audit(tx, actor, { action: 'payment.create', entityType: 'payment', entityId: id, campaignId, after: { direction: p.direction, counterpartyType: p.counterpartyType, amount: p.amount, paidOn: p.paidOn } });
      return { id };
    }, p);
    return { ...result, replayed };
  });
}

export async function listPayments(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'finance.read');
  const params: unknown[] = [actor.orgId];
  const where = ['p.organization_id=$1'];
  const add = (col: string, v: string | null) => { if (v) { params.push(v); where.push(`${col}=$${params.length}`); } };
  add('p.direction', q.get('direction')); add('p.match_status', q.get('matchStatus')); add('p.campaign_id', q.get('campaignId'));
  add('p.status', q.get('status') ?? 'ACTIVE');
  const s = q.get('q'); if (s) { params.push(likePattern(s)); where.push(`(p.reference_no ILIKE $${params.length} OR p.note ILIKE $${params.length} OR p.id ILIKE $${params.length})`); }
  const base = `SELECT p.*, c.title AS campaign_title,
      CASE p.counterparty_type WHEN 'VENDOR' THEN (SELECT name FROM vendors v WHERE v.id=p.counterparty_id) WHEN 'HOST' THEN (SELECT display_name FROM hosts h WHERE h.id=p.counterparty_id) ELSE '平台' END AS counterparty_name
    FROM payments p LEFT JOIN campaigns c ON c.id=p.campaign_id WHERE ${where.join(' AND ')}`;
  return camelize(await listPaged(base, params, 'p.paid_on DESC, p.id DESC', pageParams(q)));
}

const paymentPatchSchema = z.object({
  amount: money.optional(), paidOn: date.optional(), referenceNo: z.string().trim().max(100).nullable().optional(), note: z.string().trim().max(500).nullable().optional(),
  campaignId: z.string().trim().max(40).nullable().optional(), settlementItemId: z.string().trim().max(40).nullable().optional(), version: z.number().int().optional(),
});

async function getPaymentForUpdate(tx: Tx, actor: Actor, id: string) {
  const r = await tx.query(`SELECT * FROM payments WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [id, actor.orgId]);
  if (!r.rows[0]) throw notFound('入帳紀錄');
  return r.rows[0] as Record<string, unknown> & { status: string; match_status: string; campaign_id: string | null; settlement_item_id: string | null; version: number };
}

export async function updatePayment(actor: Actor, id: string, raw: unknown) {
  requirePerm(actor, 'finance.write');
  const p = applyClears(paymentPatchSchema.parse(raw), raw, ['referenceNo', 'note', 'campaignId', 'settlementItemId']);
  return withTx(async (tx) => {
    const cur = await getPaymentForUpdate(tx, actor, id);
    if (cur.status !== 'ACTIVE') throw precondition('已作廢的入帳紀錄不可修改');
    if (cur.match_status === 'MATCHED') throw precondition('已核對的入帳不可修改，請先取消核對');
    const patch: Record<string, unknown> = { ...p };
    delete patch.version;
    if (p.settlementItemId) {
      const ic = await itemCampaign(tx, actor, p.settlementItemId);
      const wanted = p.campaignId === undefined ? cur.campaign_id : p.campaignId;
      if (wanted && wanted !== ic) throw validation('結算項目所屬檔期與指定的檔期不一致');
      patch.campaignId = ic;
    } else if (p.campaignId) await campaignOk(tx, actor, p.campaignId);
    const r = await patchEntity(tx, actor, { table: 'payments', entityType: 'payment', id, patch, allowed: ['amount', 'paidOn', 'referenceNo', 'note', 'campaignId', 'settlementItemId'], expectedVersion: p.version, campaignId: (row) => (row.campaign_id as string | null) });
    return { id, changed: r.changed };
  });
}

/** 核對：必須已關聯到檔期或結算項目，核對後鎖定（不可改金額與關聯） */
export async function matchPayment(actor: Actor, id: string, raw: { campaignId?: string; settlementItemId?: string } = {}) {
  requirePerm(actor, 'finance.write');
  const b = z.object({ campaignId: text(40), settlementItemId: text(40) }).parse(raw ?? {});
  return withTx(async (tx) => {
    const cur = await getPaymentForUpdate(tx, actor, id);
    if (cur.status !== 'ACTIVE') throw precondition('已作廢的入帳紀錄不能核對');
    if (cur.match_status === 'MATCHED') throw precondition('此筆已核對');
    let campaignId = b.campaignId ?? cur.campaign_id;
    const itemId = b.settlementItemId ?? cur.settlement_item_id;
    if (itemId) {
      const ic = await itemCampaign(tx, actor, itemId);
      if (campaignId && campaignId !== ic) throw validation('結算項目所屬檔期與指定的檔期不一致');
      campaignId = ic;
    } else if (campaignId) await campaignOk(tx, actor, campaignId);
    if (!campaignId && !itemId) throw precondition('核對前必須先關聯到檔期或結算項目');
    await tx.query(`UPDATE payments SET match_status='MATCHED', matched_at=now(), matched_by=$2, campaign_id=$3, settlement_item_id=$4, updated_by=$2 WHERE id=$1`, [id, actor.userId, campaignId, itemId ?? null]);
    await audit(tx, actor, { action: 'payment.match', entityType: 'payment', entityId: id, campaignId, before: { matchStatus: 'UNMATCHED' }, after: { matchStatus: 'MATCHED', campaignId, settlementItemId: itemId ?? null } });
    return { id, matchStatus: 'MATCHED' as const };
  });
}

export async function unmatchPayment(actor: Actor, id: string, reason: string) {
  requirePerm(actor, 'finance.write');
  const why = z.string().trim().min(1, '取消核對必須填寫原因').max(500).parse(reason ?? '');
  return withTx(async (tx) => {
    const cur = await getPaymentForUpdate(tx, actor, id);
    if (cur.match_status !== 'MATCHED') throw precondition('此筆尚未核對');
    await tx.query(`UPDATE payments SET match_status='UNMATCHED', matched_at=NULL, matched_by=NULL, updated_by=$2 WHERE id=$1`, [id, actor.userId]);
    await audit(tx, actor, { action: 'payment.unmatch', entityType: 'payment', entityId: id, campaignId: cur.campaign_id, before: { matchStatus: 'MATCHED' }, after: { matchStatus: 'UNMATCHED' }, reason: why });
    return { id, matchStatus: 'UNMATCHED' as const };
  });
}

export async function voidPayment(actor: Actor, id: string, reason: string) {
  requirePerm(actor, 'finance.write');
  const why = z.string().trim().min(1, '作廢必須填寫原因').max(500).parse(reason ?? '');
  return withTx(async (tx) => {
    const cur = await getPaymentForUpdate(tx, actor, id);
    if (cur.status === 'VOID') throw precondition('此筆已作廢');
    if (cur.match_status === 'MATCHED') throw precondition('已核對的入帳不可作廢，請先取消核對');
    await tx.query(`UPDATE payments SET status='VOID', void_reason=$2, updated_by=$3 WHERE id=$1`, [id, why, actor.userId]);
    await audit(tx, actor, { action: 'payment.void', entityType: 'payment', entityId: id, campaignId: cur.campaign_id, before: { status: 'ACTIVE' }, after: { status: 'VOID' }, reason: why });
    return { id, status: 'VOID' as const };
  });
}

// ===================== 發票紀錄 =====================
export const invoiceSchema = z.object({
  invoiceNo: z.string().trim().min(1, '請填發票號碼（或佔位字）').max(40),
  invoiceDate: date,
  amount: z.number().int('金額需為整數').min(0).max(MAX_AMOUNT),
  titleText: text(100), taxIdText: text(20), campaignId: text(40), note: text(500),
});

export async function createInvoice(actor: Actor, raw: z.input<typeof invoiceSchema>, idemKey?: string | null) {
  requirePerm(actor, 'finance.write');
  const p = invoiceSchema.parse(raw);
  return withTx(async (tx) => {
    const { result, replayed } = await idempotent(tx, actor, 'invoice.create', idemKey, async () => {
      if (p.campaignId) await campaignOk(tx, actor, p.campaignId);
      const dup = await tx.query(`SELECT id FROM invoices WHERE organization_id=$1 AND invoice_no=$2 AND status<>'VOID'`, [actor.orgId, p.invoiceNo]);
      if (dup.rowCount) throw validation(`發票號碼 ${p.invoiceNo} 已存在於 ${dup.rows[0].id}（作廢後才能重複使用）`);
      const id = await ids.invoice(tx);
      await tx.query(
        `INSERT INTO invoices (id, organization_id, invoice_no, invoice_date, amount, title_text, tax_id_text, campaign_id, note, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
        [id, actor.orgId, p.invoiceNo, p.invoiceDate, p.amount, p.titleText ?? null, p.taxIdText ?? null, p.campaignId ?? null, p.note ?? null, actor.userId]);
      await audit(tx, actor, { action: 'invoice.create', entityType: 'invoice', entityId: id, campaignId: p.campaignId ?? null, after: { invoiceNo: p.invoiceNo, amount: p.amount, status: 'DRAFT' } });
      return { id };
    }, p);
    return { ...result, replayed };
  });
}

const invoicePatchSchema = z.object({
  invoiceNo: z.string().trim().min(1).max(40).optional(), invoiceDate: date.optional(), amount: z.number().int().min(0).max(MAX_AMOUNT).optional(),
  titleText: z.string().trim().max(100).nullable().optional(), taxIdText: z.string().trim().max(20).nullable().optional(),
  campaignId: z.string().trim().max(40).nullable().optional(), note: z.string().trim().max(500).nullable().optional(), version: z.number().int().optional(),
});

async function getInvoiceForUpdate(tx: Tx, actor: Actor, id: string) {
  const r = await tx.query(`SELECT * FROM invoices WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [id, actor.orgId]);
  if (!r.rows[0]) throw notFound('發票紀錄');
  return r.rows[0] as Record<string, unknown> & { status: string; campaign_id: string | null; invoice_no: string };
}

export async function updateInvoice(actor: Actor, id: string, raw: unknown) {
  requirePerm(actor, 'finance.write');
  const p = applyClears(invoicePatchSchema.parse(raw), raw, ['titleText', 'taxIdText', 'campaignId', 'note']);
  return withTx(async (tx) => {
    const cur = await getInvoiceForUpdate(tx, actor, id);
    if (cur.status !== 'DRAFT') throw precondition('只有草稿狀態的發票紀錄可以修改；已開立的只能作廢');
    if (p.campaignId) await campaignOk(tx, actor, p.campaignId);
    if (p.invoiceNo && p.invoiceNo !== cur.invoice_no) {
      const dup = await tx.query(`SELECT id FROM invoices WHERE organization_id=$1 AND invoice_no=$2 AND status<>'VOID' AND id<>$3`, [actor.orgId, p.invoiceNo, id]);
      if (dup.rowCount) throw validation(`發票號碼 ${p.invoiceNo} 已存在於 ${dup.rows[0].id}`);
    }
    const { version, ...patch } = p;
    const r = await patchEntity(tx, actor, { table: 'invoices', entityType: 'invoice', id, patch, allowed: ['invoiceNo', 'invoiceDate', 'amount', 'titleText', 'taxIdText', 'campaignId', 'note'], expectedVersion: version, campaignId: (row) => (row.campaign_id as string | null) });
    return { id, changed: r.changed };
  });
}

export async function issueInvoice(actor: Actor, id: string) {
  requirePerm(actor, 'finance.write');
  return withTx(async (tx) => {
    const cur = await getInvoiceForUpdate(tx, actor, id);
    if (cur.status !== 'DRAFT') throw precondition('只有草稿可以標記為已開立');
    await tx.query(`UPDATE invoices SET status='ISSUED', issued_at=now(), updated_by=$2 WHERE id=$1`, [id, actor.userId]);
    await audit(tx, actor, { action: 'invoice.issue', entityType: 'invoice', entityId: id, campaignId: cur.campaign_id, before: { status: 'DRAFT' }, after: { status: 'ISSUED' } });
    return { id, status: 'ISSUED' as const };
  });
}

export async function voidInvoice(actor: Actor, id: string, reason: string) {
  requirePerm(actor, 'finance.write');
  const why = z.string().trim().min(1, '作廢必須填寫原因').max(500).parse(reason ?? '');
  return withTx(async (tx) => {
    const cur = await getInvoiceForUpdate(tx, actor, id);
    if (cur.status === 'VOID') throw precondition('此發票紀錄已作廢');
    await tx.query(`UPDATE invoices SET status='VOID', voided_at=now(), void_reason=$2, updated_by=$3 WHERE id=$1`, [id, why, actor.userId]);
    await audit(tx, actor, { action: 'invoice.void', entityType: 'invoice', entityId: id, campaignId: cur.campaign_id, before: { status: cur.status }, after: { status: 'VOID' }, reason: why });
    return { id, status: 'VOID' as const };
  });
}

export async function listInvoices(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'finance.read');
  const params: unknown[] = [actor.orgId];
  const where = ['i.organization_id=$1'];
  const st = q.get('status'); if (st) { params.push(st); where.push(`i.status=$${params.length}`); }
  const cid = q.get('campaignId'); if (cid) { params.push(cid); where.push(`i.campaign_id=$${params.length}`); }
  const s = q.get('q'); if (s) { params.push(likePattern(s)); where.push(`(i.invoice_no ILIKE $${params.length} OR i.note ILIKE $${params.length} OR i.id ILIKE $${params.length})`); }
  const base = `SELECT i.*, c.title AS campaign_title FROM invoices i LEFT JOIN campaigns c ON c.id=i.campaign_id WHERE ${where.join(' AND ')}`;
  return camelize(await listPaged(base, params, 'i.invoice_date DESC, i.id DESC', pageParams(q)));
}

// ===================== 費用紀錄 =====================
export const EXPENSE_CATEGORIES = ['SHIPPING', 'MARKETING', 'SAMPLE', 'PLATFORM_FEE', 'OTHER'] as const;
export const expenseSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES), amount: money, incurredOn: date, campaignId: text(40), note: text(500),
});

export async function createExpense(actor: Actor, raw: z.input<typeof expenseSchema>, idemKey?: string | null) {
  requirePerm(actor, 'finance.write');
  const p = expenseSchema.parse(raw);
  return withTx(async (tx) => {
    const { result, replayed } = await idempotent(tx, actor, 'expense.create', idemKey, async () => {
      if (p.campaignId) await campaignOk(tx, actor, p.campaignId);
      const id = await ids.expense(tx);
      await tx.query(`INSERT INTO expenses (id, organization_id, campaign_id, category, amount, incurred_on, note, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
        [id, actor.orgId, p.campaignId ?? null, p.category, p.amount, p.incurredOn, p.note ?? null, actor.userId]);
      await audit(tx, actor, { action: 'expense.create', entityType: 'expense', entityId: id, campaignId: p.campaignId ?? null, after: { category: p.category, amount: p.amount, incurredOn: p.incurredOn } });
      return { id };
    }, p);
    return { ...result, replayed };
  });
}

const expensePatchSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES).optional(), amount: money.optional(), incurredOn: date.optional(),
  campaignId: z.string().trim().max(40).nullable().optional(), note: z.string().trim().max(500).nullable().optional(), version: z.number().int().optional(),
});

export async function updateExpense(actor: Actor, id: string, raw: unknown) {
  requirePerm(actor, 'finance.write');
  const p = applyClears(expensePatchSchema.parse(raw), raw, ['campaignId', 'note']);
  return withTx(async (tx) => {
    const r0 = await tx.query(`SELECT status FROM expenses WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [id, actor.orgId]);
    if (!r0.rows[0]) throw notFound('費用紀錄');
    if (r0.rows[0].status !== 'RECORDED') throw precondition('已作廢的費用紀錄不可修改');
    if (p.campaignId) await campaignOk(tx, actor, p.campaignId);
    const { version, ...patch } = p;
    const r = await patchEntity(tx, actor, { table: 'expenses', entityType: 'expense', id, patch, allowed: ['category', 'amount', 'incurredOn', 'campaignId', 'note'], expectedVersion: version, campaignId: (row) => (row.campaign_id as string | null) });
    return { id, changed: r.changed };
  });
}

export async function voidExpense(actor: Actor, id: string, reason: string) {
  requirePerm(actor, 'finance.write');
  const why = z.string().trim().min(1, '作廢必須填寫原因').max(500).parse(reason ?? '');
  return withTx(async (tx) => {
    const r0 = await tx.query(`SELECT status, campaign_id FROM expenses WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [id, actor.orgId]);
    if (!r0.rows[0]) throw notFound('費用紀錄');
    if (r0.rows[0].status === 'VOID') throw precondition('此費用紀錄已作廢');
    await tx.query(`UPDATE expenses SET status='VOID', void_reason=$2, updated_by=$3 WHERE id=$1`, [id, why, actor.userId]);
    await audit(tx, actor, { action: 'expense.void', entityType: 'expense', entityId: id, campaignId: r0.rows[0].campaign_id, before: { status: 'RECORDED' }, after: { status: 'VOID' }, reason: why });
    return { id, status: 'VOID' as const };
  });
}

export async function listExpenses(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'finance.read');
  const params: unknown[] = [actor.orgId];
  const where = ['e.organization_id=$1'];
  const add = (col: string, v: string | null) => { if (v) { params.push(v); where.push(`${col}=$${params.length}`); } };
  add('e.campaign_id', q.get('campaignId')); add('e.category', q.get('category')); add('e.status', q.get('status') ?? 'RECORDED');
  const base = `SELECT e.*, c.title AS campaign_title FROM expenses e LEFT JOIN campaigns c ON c.id=e.campaign_id WHERE ${where.join(' AND ')}`;
  return camelize(await listPaged(base, params, 'e.incurred_on DESC, e.id DESC', pageParams(q)));
}

// ===================== 財務總覽 =====================
export async function financeOverview(actor: Actor) {
  requirePerm(actor, 'finance.read');
  const sc = campaignScope(actor, 1, 'c');
  if (sc.sql === 'FALSE') throw forbidden();
  const rows = await query<{
    id: string; title: string; status: string; net_sales: number; paid_in: number; paid_out: number; expenses: number; invoiced: number;
    unmatched: number; settlement_id: string | null; settlement_status: string | null;
  }>(
    `SELECT c.id, c.title, c.status,
       coalesce((SELECT sum(o.gross_amount - o.refund_amount) FROM orders o WHERE o.campaign_id=c.id AND o.status = ANY($${sc.params.length + 1}::text[])),0) AS net_sales,
       coalesce((SELECT sum(p.amount) FROM payments p WHERE p.campaign_id=c.id AND p.status='ACTIVE' AND p.direction='IN'),0) AS paid_in,
       coalesce((SELECT sum(p.amount) FROM payments p WHERE p.campaign_id=c.id AND p.status='ACTIVE' AND p.direction='OUT'),0) AS paid_out,
       coalesce((SELECT sum(e.amount) FROM expenses e WHERE e.campaign_id=c.id AND e.status='RECORDED'),0) AS expenses,
       coalesce((SELECT sum(i.amount) FROM invoices i WHERE i.campaign_id=c.id AND i.status='ISSUED'),0) AS invoiced,
       (SELECT count(*)::int FROM payments p WHERE p.campaign_id=c.id AND p.status='ACTIVE' AND p.match_status='UNMATCHED') AS unmatched,
       (SELECT s.id FROM settlements s WHERE s.campaign_id=c.id AND s.status IN ('DRAFT','CONFIRMED') LIMIT 1) AS settlement_id,
       (SELECT s.status FROM settlements s WHERE s.campaign_id=c.id AND s.status IN ('DRAFT','CONFIRMED') LIMIT 1) AS settlement_status
     FROM campaigns c WHERE (${sc.sql}) AND c.status NOT IN ('DRAFT','CANCELLED')
       AND (EXISTS (SELECT 1 FROM orders o WHERE o.campaign_id=c.id) OR EXISTS (SELECT 1 FROM payments p WHERE p.campaign_id=c.id) OR EXISTS (SELECT 1 FROM expenses e WHERE e.campaign_id=c.id)
            OR EXISTS (SELECT 1 FROM settlements s WHERE s.campaign_id=c.id) OR EXISTS (SELECT 1 FROM invoices i WHERE i.campaign_id=c.id))
     ORDER BY c.open_date DESC NULLS LAST, c.id DESC LIMIT 100`, [...sc.params, [...SALES_STATUSES]]);
  const campaigns = [];
  for (const r of rows) {
    const calc = await campaignHostCommission(pool(), actor.orgId, r.id);
    const known = calc.filter((c) => c.commissionAuto != null);
    campaigns.push({
      id: r.id, title: r.title, status: r.status, netSales: Number(r.net_sales),
      estimatedCommission: known.reduce((s, c) => s + (c.commissionAuto ?? 0), 0), hostsWithoutRate: calc.length - known.length,
      paidIn: Number(r.paid_in), paidOut: Number(r.paid_out), expenses: Number(r.expenses), invoiced: Number(r.invoiced),
      unmatchedPayments: r.unmatched, settlementId: r.settlement_id, settlementStatus: r.settlement_status,
    });
  }
  const unlinked = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM payments WHERE organization_id=$1 AND status='ACTIVE' AND match_status='UNMATCHED' AND campaign_id IS NULL`, [actor.orgId]))[0].n;
  return {
    notice: SETTLEMENT_NOTICE,
    campaigns,
    totals: {
      netSales: campaigns.reduce((s, c) => s + c.netSales, 0), estimatedCommission: campaigns.reduce((s, c) => s + c.estimatedCommission, 0),
      paidIn: campaigns.reduce((s, c) => s + c.paidIn, 0), paidOut: campaigns.reduce((s, c) => s + c.paidOut, 0), expenses: campaigns.reduce((s, c) => s + c.expenses, 0),
      unmatchedPayments: campaigns.reduce((s, c) => s + c.unmatchedPayments, 0) + unlinked, unmatchedWithoutCampaign: unlinked,
    },
  };
}
