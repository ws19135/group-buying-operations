import { z } from 'zod';
import type { Tx } from '../lib/db';
import { pool, query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, requirePerm } from '../lib/permissions';
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
import { assertNoPii } from './selection';
import { attributionShape, bearerStatusOf, claimHint, claimProblems, costScopeProblems, evidenceUrlProblem, maskExpenseAttribution, paymentProblems } from '../lib/expense-attribution';

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
    // 已關聯結算項目、且這次沒有更換／解除項目時，檔期必須維持等於該項目所屬檔期（不可單獨改掉或清空檔期）
    if (p.settlementItemId === undefined && cur.settlement_item_id && p.campaignId !== undefined) {
      const kept = await tx.query<{ campaign_id: string }>('SELECT campaign_id FROM settlement_items WHERE id=$1 AND organization_id=$2', [cur.settlement_item_id, actor.orgId]);
      if (kept.rows[0] && kept.rows[0].campaign_id !== p.campaignId) throw validation('此入帳已關聯結算項目，檔期必須與該結算項目所屬檔期一致；要更換檔期請先解除或更換結算項目關聯');
    }
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
  // K-8a 費用歸屬（全部選填）：承擔方、實際付款方、對應團主／商品、合約與商務條件來源、付款狀態與憑證、應收／應付（預設未判斷、未確認）
  ...attributionShape,
});

const ATTR_FIELDS = ['bearerParty', 'payerParty', 'hostId', 'productId', 'termsSourceKind', 'termsRef', 'paymentStatus', 'paidOn', 'paidAmount', 'evidenceUrl', 'claimDirection', 'claimParty', 'claimNote', 'costScope'] as const;
const hasAttribution = (p: Record<string, unknown>) => ATTR_FIELDS.some((k) => p[k] !== undefined && p[k] !== null);

/** 歸屬欄位的共同驗證：權限、個資、憑證連結、付款與應收應付一致性、對應團主與商品需屬於該檔期 */
async function validateAttribution(db: Db, actor: Actor, p: Record<string, unknown>, ctx: { amount: number; campaignId: string | null; merged?: Record<string, unknown> }) {
  const full = ctx.merged ?? p;   // 付款與應收應付的一致性要用「更新後的完整狀態」檢查（建立時就是輸入本身）
  if (hasAttribution(p) && !can(actor, 'product.cost.read')) throw forbidden('費用歸屬（承擔方、付款方、應收應付、憑證）屬敏感商務資料，需有成本檢視權限才能填寫');
  assertNoPii({ 條款編號: p.termsRef as string | undefined, 應收應付備註: p.claimNote as string | undefined });
  const bad = evidenceUrlProblem(p.evidenceUrl as string | undefined);
  if (bad) throw validation(bad);
  const pay = paymentProblems({ paymentStatus: full.paymentStatus as string | undefined, paidOn: full.paidOn as string | null | undefined, paidAmount: full.paidAmount == null ? null : Number(full.paidAmount), amount: ctx.amount });
  const cl = claimProblems({ claimDirection: full.claimDirection as string | undefined, claimParty: full.claimParty as string | null | undefined });
  const sc = costScopeProblems({ costScope: full.costScope as string | null | undefined, productId: full.productId as string | null | undefined, hostId: full.hostId as string | null | undefined });
  if (pay.length || cl.length || sc.length) throw validation([...pay, ...cl, ...sc].join('；'));
  if (p.hostId) {
    const h = await db.query(`SELECT 1 FROM hosts WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL`, [p.hostId, actor.orgId]);
    if (!h.rowCount) throw notFound('團主');
    if (ctx.campaignId) {
      const ch = await db.query(`SELECT 1 FROM campaign_hosts WHERE campaign_id=$1 AND host_id=$2 AND deleted_at IS NULL AND status <> 'DECLINED'`, [ctx.campaignId, p.hostId]);
      if (!ch.rowCount) throw validation('這位團主不在此檔期內（或已婉拒）');
    }
  }
  if (p.productId) {
    const pr = await db.query(`SELECT 1 FROM products WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL`, [p.productId, actor.orgId]);
    if (!pr.rowCount) throw notFound('商品');
    if (ctx.campaignId) {
      const cp = await db.query(`SELECT 1 FROM campaign_products WHERE campaign_id=$1 AND product_id=$2 AND deleted_at IS NULL`, [ctx.campaignId, p.productId]);
      if (!cp.rowCount) throw validation('這個商品不在此檔期內');
    }
  }
}

export async function createExpense(actor: Actor, raw: z.input<typeof expenseSchema>, idemKey?: string | null) {
  requirePerm(actor, 'finance.write');
  const p = expenseSchema.parse(raw);
  return withTx(async (tx) => {
    const { result, replayed } = await idempotent(tx, actor, 'expense.create', idemKey, async () => {
      if (p.campaignId) await campaignOk(tx, actor, p.campaignId);
      await validateAttribution(tx, actor, p as Record<string, unknown>, { amount: p.amount, campaignId: p.campaignId ?? null });
      const id = await ids.expense(tx);
      await tx.query(
        `INSERT INTO expenses (id, organization_id, campaign_id, category, amount, incurred_on, note, created_by, updated_by,
           bearer_party, payer_party, host_id, product_id, terms_source_kind, terms_ref, payment_status, paid_on, paid_amount, evidence_url, claim_direction, claim_party, claim_note, cost_scope)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [id, actor.orgId, p.campaignId ?? null, p.category, p.amount, p.incurredOn, p.note ?? null, actor.userId,
          p.bearerParty ?? null, p.payerParty ?? null, p.hostId ?? null, p.productId ?? null, p.termsSourceKind ?? null, p.termsRef ?? null, p.paymentStatus ?? 'UNRECORDED', p.paidOn ?? null, p.paidAmount ?? null,
          p.evidenceUrl || null, p.claimDirection ?? 'UNDETERMINED', p.claimParty ?? null, p.claimNote ?? null, p.costScope ?? null]);
      await audit(tx, actor, { action: 'expense.create', entityType: 'expense', entityId: id, campaignId: p.campaignId ?? null,
        after: { category: p.category, amount: p.amount, incurredOn: p.incurredOn, attributed: hasAttribution(p as Record<string, unknown>), bearerParty: p.bearerParty ?? null, payerParty: p.payerParty ?? null, paymentStatus: p.paymentStatus ?? 'UNRECORDED', bearerStatus: bearerStatusOf(p.bearerParty ?? null), costScope: p.costScope ?? null, evidenceLink: !!p.evidenceUrl } });
      return { id };
    }, p);
    return { ...result, replayed };
  });
}

// ---- K-8a：事後補齊或調整費用歸屬（只動歸屬欄位；金額、類別、日期仍走既有的更新）----
export const expenseAttributionPatchSchema = z.object(attributionShape).strict();
export async function updateExpenseAttribution(actor: Actor, id: string, raw: unknown) {
  requirePerm(actor, 'finance.write');
  if (!can(actor, 'product.cost.read')) throw forbidden('費用歸屬屬敏感商務資料，需有成本檢視權限才能修改');
  const parsed = expenseAttributionPatchSchema.parse(raw);
  const body = raw as Record<string, unknown>;
  // 明確傳 null 才是清除；沒傳＝不變
  const p: Record<string, unknown> = {};
  for (const k of ATTR_FIELDS) if (k in body) p[k] = (parsed as Record<string, unknown>)[k] ?? null;
  return withTx(async (tx) => {
    const cur = await tx.query(`SELECT * FROM expenses WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [id, actor.orgId]);
    const e = cur.rows[0] as Record<string, unknown> | undefined;
    if (!e) throw notFound('費用紀錄');
    if (e.status !== 'RECORDED') throw precondition('已作廢的費用紀錄不可修改');
    if (e.campaign_id) await campaignOk(tx, actor, e.campaign_id as string);
    const col: Record<string, string> = { bearerParty: 'bearer_party', payerParty: 'payer_party', hostId: 'host_id', productId: 'product_id', termsSourceKind: 'terms_source_kind', termsRef: 'terms_ref', paymentStatus: 'payment_status', paidOn: 'paid_on', paidAmount: 'paid_amount', evidenceUrl: 'evidence_url', costScope: 'cost_scope', claimDirection: 'claim_direction', claimParty: 'claim_party', claimNote: 'claim_note' };
    const next: Record<string, unknown> = {};
    for (const k of ATTR_FIELDS) next[k] = k in p ? p[k] : e[col[k]] instanceof Date ? (e[col[k]] as Date).toISOString().slice(0, 10) : e[col[k]] ?? null;
    if (next.paymentStatus == null) next.paymentStatus = 'UNRECORDED';
    if (next.claimDirection == null) next.claimDirection = 'UNDETERMINED';
    if (next.paidAmount != null) next.paidAmount = Number(next.paidAmount);
    await validateAttribution(tx, actor, p, { amount: Number(e.amount), campaignId: (e.campaign_id as string | null) ?? null, merged: next });
    const sets: string[] = []; const vals: unknown[] = [id];
    for (const k of Object.keys(p)) { vals.push(k === 'evidenceUrl' ? (p[k] || null) : p[k]); sets.push(`${col[k]}=$${vals.length}`); }
    // 已確認的應收應付，只要方向或對象被改動就退回「未確認」，必須重新確認（不能靜默變更）
    // F-02：確認所依據的重要欄位（承擔方、實際付款方、對應團主／商品、應收應付方向與對象）任何一個被改動，都退回未確認重新確認；付款狀態、憑證連結、條款來源、備註不影響
    const claimChanged = (['bearerParty', 'payerParty', 'hostId', 'productId', 'claimDirection', 'claimParty'] as const).some((k) => k in p && (p[k] ?? null) !== (e[col[k]] ?? null));
    if (e.claim_status === 'CONFIRMED' && claimChanged) sets.push(`claim_status='UNCONFIRMED'`, `claim_confirmed_by=NULL`, `claim_confirmed_at=NULL`);
    if (!sets.length) return { id, changed: false };
    vals.push(actor.userId); sets.push(`updated_by=$${vals.length}`);
    await tx.query(`UPDATE expenses SET ${sets.join(', ')} WHERE id=$1`, vals);
    await audit(tx, actor, { action: 'expense.attribution.update', entityType: 'expense', entityId: id, campaignId: (e.campaign_id as string | null) ?? null,
      before: { bearerParty: e.bearer_party ?? null, bearerStatus: bearerStatusOf((e.bearer_party as string | null) ?? null), payerParty: e.payer_party ?? null, termsSourceKind: e.terms_source_kind ?? null, termsRef: e.terms_ref ?? null, costScope: e.cost_scope ?? null, paymentStatus: e.payment_status, claimDirection: e.claim_direction, claimStatus: e.claim_status },
      after: { bearerParty: next.bearerParty, bearerStatus: bearerStatusOf(next.bearerParty as string | null), payerParty: next.payerParty, termsSourceKind: next.termsSourceKind, termsRef: next.termsRef, costScope: next.costScope, paymentStatus: next.paymentStatus, claimDirection: next.claimDirection, evidenceLinkChanged: 'evidenceUrl' in p, reconfirmRequired: e.claim_status === 'CONFIRMED' && claimChanged } });
    return { id, changed: true };
  });
}

/**
 * 費用的修正歷史（D-4）：原始費用紀錄不被覆蓋（只改歸屬欄位，並留稽核）；這裡唯讀列出該筆費用的所有稽核事件（誰、何時、前後內容）。
 * 稽核不記付款憑證連結內容與金額以外的敏感細節；需要財務讀取與成本檢視權限。
 */
export async function expenseHistory(actor: Actor, id: string) {
  requirePerm(actor, 'finance.read');
  if (!can(actor, 'product.cost.read')) throw forbidden('費用歸屬與修正歷史屬敏感商務資料，需有成本檢視權限');
  const ex = (await query<{ campaign_id: string | null }>(`SELECT campaign_id FROM expenses WHERE id=$1 AND organization_id=$2`, [id, actor.orgId]))[0];
  if (!ex) throw notFound('費用紀錄');
  if (ex.campaign_id) await campaignOk(pool(), actor, ex.campaign_id);
  const rows = await query<Record<string, unknown>>(
    `SELECT a.id, a.occurred_at, a.action, a.actor_user_id, u.name AS actor_name, a.before_data, a.after_data, a.reason FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id
     WHERE a.organization_id=$1 AND a.entity_type='expense' AND a.entity_id=$2 ORDER BY a.id`, [actor.orgId, id]);
  return { id, events: camelize(rows), note: '原始費用不被覆蓋；每次歸屬調整都保留修改前後內容（承擔方、付款方、依據、付款狀態…）' };
}

export const claimConfirmSchema = z.object({ note: z.string().trim().max(300).optional() }).strict();
/** 財務確認應收／應付：只是確認「紀錄」，**不產生付款、撥款、扣款、發票或任何付款指示** */
export async function confirmExpenseClaim(actor: Actor, id: string, raw: unknown) {
  requirePerm(actor, 'finance.write');
  if (!can(actor, 'product.cost.read')) throw forbidden('費用歸屬屬敏感商務資料，需有成本檢視權限才能確認');
  const input = claimConfirmSchema.parse(raw ?? {});
  assertNoPii({ 確認說明: input.note });
  return withTx(async (tx) => {
    const cur = await tx.query(`SELECT * FROM expenses WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [id, actor.orgId]);
    const e = cur.rows[0] as Record<string, unknown> | undefined;
    if (!e) throw notFound('費用紀錄');
    if (e.status !== 'RECORDED') throw precondition('已作廢的費用紀錄不可確認');
    if (e.campaign_id) await campaignOk(tx, actor, e.campaign_id as string);
    if (e.claim_status === 'CONFIRMED') throw precondition('已經確認過；要更正請先調整應收／應付內容（會退回未確認）再重新確認');
    if (e.claim_direction !== 'RECEIVABLE' && e.claim_direction !== 'PAYABLE') throw validation('請先在費用歸屬指定「公司應收」或「公司應付」與對象，才能確認');
    if (!e.claim_party) throw validation('請先指定應收方／應付方');
    await tx.query(`UPDATE expenses SET claim_status='CONFIRMED', claim_confirmed_by=$2, claim_confirmed_at=now(), claim_note=COALESCE($3, claim_note), updated_by=$2 WHERE id=$1`, [id, actor.userId, input.note ?? null]);
    await audit(tx, actor, { action: 'expense.claim.confirm', entityType: 'expense', entityId: id, campaignId: (e.campaign_id as string | null) ?? null, before: { claimStatus: 'UNCONFIRMED' }, after: { claimStatus: 'CONFIRMED', claimDirection: e.claim_direction, claimParty: e.claim_party, paymentInstruction: false } });
    return { id, claimStatus: 'CONFIRMED' as const, paymentInstruction: false as const };
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
    const r0 = await tx.query(`SELECT * FROM expenses WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [id, actor.orgId]);
    const e = r0.rows[0] as Record<string, unknown> | undefined;
    if (!e) throw notFound('費用紀錄');
    if (e.status !== 'RECORDED') throw precondition('已作廢的費用紀錄不可修改');
    if (p.campaignId) await campaignOk(tx, actor, p.campaignId);
    const newAmount = p.amount ?? Number(e.amount);
    const amountChanged = p.amount !== undefined && p.amount !== Number(e.amount);
    const campaignChanged = p.campaignId !== undefined && (p.campaignId ?? null) !== ((e.campaign_id as string | null) ?? null);
    // F-03：改金額要與付款狀態一致（已付款不可直接改金額；部分付款的已付金額需仍小於新金額）——用清楚的驗證訊息，不讓資料庫錯誤外洩
    if (amountChanged) {
      if (e.payment_status === 'PAID') throw validation('這筆費用已標為「已付款」，不能直接改金額；請先把付款狀態改為「部分付款」或更正付款資料');
      const pay = paymentProblems({ paymentStatus: e.payment_status as string, paidOn: (e.paid_on as string | null) ?? null, paidAmount: e.paid_amount == null ? null : Number(e.paid_amount), amount: newAmount });
      if (pay.length) throw validation(`新的金額與付款資料不一致：${pay.join('；')}`);
    }
    // F-05：改檔期時，原有的對應團主／商品必須也屬於新檔期（不留下跨檔期的不一致關聯）
    if (campaignChanged && p.campaignId) {
      if (e.host_id && !(await tx.query(`SELECT 1 FROM campaign_hosts WHERE campaign_id=$1 AND host_id=$2 AND deleted_at IS NULL AND status <> 'DECLINED'`, [p.campaignId, e.host_id])).rowCount) throw validation('對應的團主不在新的檔期內（或已婉拒）；請先調整費用歸屬的對應團主');
      if (e.product_id && !(await tx.query(`SELECT 1 FROM campaign_products WHERE campaign_id=$1 AND product_id=$2 AND deleted_at IS NULL`, [p.campaignId, e.product_id])).rowCount) throw validation('對應的商品不在新的檔期內；請先調整費用歸屬的對應商品');
    }
    if (campaignChanged && !p.campaignId && (e.host_id || e.product_id)) throw validation('移除檔期前，請先清除費用歸屬的對應團主與商品');
    const willReconfirm = e.claim_status === 'CONFIRMED' && (amountChanged || campaignChanged);   // F-02：金額或檔期被改，已確認的應收應付退回未確認（資料庫觸發器同樣保護）
    const { version, ...patch } = p;
    const r = await patchEntity(tx, actor, { table: 'expenses', entityType: 'expense', id, patch, allowed: ['category', 'amount', 'incurredOn', 'campaignId', 'note'], expectedVersion: version, campaignId: (row) => (row.campaign_id as string | null) });
    if (willReconfirm && r.changed) {
      await tx.query(`UPDATE expenses SET claim_status='UNCONFIRMED', claim_confirmed_by=NULL, claim_confirmed_at=NULL WHERE id=$1`, [id]);
      await audit(tx, actor, { action: 'expense.claim.reconfirm_required', entityType: 'expense', entityId: id, campaignId: (e.campaign_id as string | null) ?? null, before: { claimStatus: 'CONFIRMED' }, after: { claimStatus: 'UNCONFIRMED', reason: amountChanged ? '金額被修改' : '檔期被修改' } });
    }
    return { id, changed: r.changed, reconfirmRequired: willReconfirm && r.changed };
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
  // D-3 待補清單（唯讀篩選）：承擔方或實際付款方尚未確認；只有成本檢視權限者可用
  const pendingOnly = q.get('attributionPending') === '1' && can(actor, 'product.cost.read');
  if (pendingOnly) where.push('(e.bearer_party IS NULL OR e.payer_party IS NULL)');
  const base = `SELECT e.*, c.title AS campaign_title, h.display_name AS host_name, p.name AS product_name FROM expenses e LEFT JOIN campaigns c ON c.id=e.campaign_id LEFT JOIN hosts h ON h.id=e.host_id LEFT JOIN products p ON p.id=e.product_id WHERE ${where.join(' AND ')}`;
  const res = camelize<{ items: Record<string, unknown>[] } & Record<string, unknown>>(await listPaged(base, params, 'e.incurred_on DESC, e.id DESC', pageParams(q)));
  const canAttr = can(actor, 'product.cost.read');
  // 沒有成本檢視權限者看不到歸屬欄位；有權限者另附「系統提示」（只是可能的往來款，未確認、非付款指示）
  res.items = res.items.map((x) => maskExpenseAttribution({ ...x, ...(canAttr ? { bearerStatus: bearerStatusOf(x.bearerParty as string | null), payerStatus: x.payerParty ? 'CONFIRMED' : 'PENDING', claimHint: claimHint(x.bearerParty as string | null, x.payerParty as string | null) } : {}) }, canAttr));
  // D-3：待補清單摘要（此篩選範圍內，承擔方或實際付款方尚未確認的筆數；不批次回填、不變更歷史紀錄）
  if (canAttr) {
    const sc = await query<{ bearer: number; payer: number; either: number }>(
      `SELECT count(*) FILTER (WHERE e.bearer_party IS NULL)::int AS bearer, count(*) FILTER (WHERE e.payer_party IS NULL)::int AS payer, count(*) FILTER (WHERE e.bearer_party IS NULL OR e.payer_party IS NULL)::int AS either FROM expenses e WHERE ${where.filter((w) => !w.startsWith('(e.bearer_party IS NULL OR')).join(' AND ')}`, params);
    (res as Record<string, unknown>).pendingAttribution = { bearerPending: sc[0].bearer, payerPending: sc[0].payer, either: sc[0].either, note: '承擔方與實際付款方由財務確認；新發生的費用請在結算前確認；既有歷史資料只列入待補清單，未取得另案授權不批次回填或變更歷史紀錄' };
  }
  return res;
}

// ===================== 財務總覽 =====================
export async function financeOverview(actor: Actor) {
  requirePerm(actor, 'finance.read');
  const sc = campaignScope(actor, 1, 'c');
  if (sc.sql === 'FALSE') throw forbidden();
  const rows = await query<{
    id: string; title: string; status: string; net_sales: number; paid_in: number; paid_out: number; expenses: number; exp_company: number; exp_pending: number; exp_other: number; invoiced: number;
    unmatched: number; settlement_id: string | null; settlement_status: string | null;
  }>(
    `SELECT c.id, c.title, c.status,
       coalesce((SELECT sum(o.gross_amount - o.refund_amount) FROM orders o WHERE o.campaign_id=c.id AND o.status = ANY($${sc.params.length + 1}::text[])),0) AS net_sales,
       coalesce((SELECT sum(p.amount) FROM payments p WHERE p.campaign_id=c.id AND p.status='ACTIVE' AND p.direction='IN'),0) AS paid_in,
       coalesce((SELECT sum(p.amount) FROM payments p WHERE p.campaign_id=c.id AND p.status='ACTIVE' AND p.direction='OUT'),0) AS paid_out,
       coalesce((SELECT sum(e.amount) FROM expenses e WHERE e.campaign_id=c.id AND e.status='RECORDED'),0) AS expenses,
       coalesce((SELECT sum(e.amount) FROM expenses e WHERE e.campaign_id=c.id AND e.status='RECORDED' AND e.bearer_party='COMPANY'),0) AS exp_company,
       coalesce((SELECT sum(e.amount) FROM expenses e WHERE e.campaign_id=c.id AND e.status='RECORDED' AND e.bearer_party IS NULL),0) AS exp_pending,
       coalesce((SELECT sum(e.amount) FROM expenses e WHERE e.campaign_id=c.id AND e.status='RECORDED' AND e.bearer_party IN ('BRAND','HOST')),0) AS exp_other,
       coalesce((SELECT sum(i.amount) FROM invoices i WHERE i.campaign_id=c.id AND i.status='ISSUED'),0) AS invoiced,
       (SELECT count(*)::int FROM payments p WHERE p.campaign_id=c.id AND p.status='ACTIVE' AND p.match_status='UNMATCHED') AS unmatched,
       (SELECT s.id FROM settlements s WHERE s.campaign_id=c.id AND s.status IN ('DRAFT','CONFIRMED') LIMIT 1) AS settlement_id,
       (SELECT s.status FROM settlements s WHERE s.campaign_id=c.id AND s.status IN ('DRAFT','CONFIRMED') LIMIT 1) AS settlement_status
     FROM campaigns c WHERE (${sc.sql}) AND c.status NOT IN ('DRAFT','CANCELLED')
       AND (EXISTS (SELECT 1 FROM orders o WHERE o.campaign_id=c.id) OR EXISTS (SELECT 1 FROM payments p WHERE p.campaign_id=c.id) OR EXISTS (SELECT 1 FROM expenses e WHERE e.campaign_id=c.id)
            OR EXISTS (SELECT 1 FROM settlements s WHERE s.campaign_id=c.id) OR EXISTS (SELECT 1 FROM invoices i WHERE i.campaign_id=c.id))
     ORDER BY c.open_date DESC NULLS LAST, c.id DESC LIMIT 100`, [...sc.params, [...SALES_STATUSES]]);
  const campaigns: (Record<string, unknown> & { id: string; netSales: number; estimatedCommission: number; paidIn: number; paidOut: number; expenses: number; unmatchedPayments: number; expensesCompanyConfirmed?: number; expensesPendingBearer?: number; expensesNotCompany?: number })[] = [];
  for (const r of rows) {
    const calc = await campaignHostCommission(pool(), actor.orgId, r.id);
    const known = calc.filter((c) => c.commissionAuto != null);
    campaigns.push({
      id: r.id, title: r.title, status: r.status, netSales: Number(r.net_sales),
      estimatedCommission: known.reduce((s, c) => s + (c.commissionAuto ?? 0), 0), hostsWithoutRate: calc.length - known.length,
      paidIn: Number(r.paid_in), paidOut: Number(r.paid_out), expenses: Number(r.expenses),
      // F-01：費用口徑（只給有成本檢視權限者）：expenses＝全部已登錄（不含作廢）＝已確認公司承擔＋承擔方待確認＋品牌或團主承擔；待確認不是公司正式成本
      ...(can(actor, 'product.cost.read') ? { expensesCompanyConfirmed: Number(r.exp_company), expensesPendingBearer: Number(r.exp_pending), expensesNotCompany: Number(r.exp_other) } : {}),
      invoiced: Number(r.invoiced),
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
      ...(can(actor, 'product.cost.read') ? { expensesCompanyConfirmed: campaigns.reduce((s, c) => s + (c.expensesCompanyConfirmed ?? 0), 0), expensesPendingBearer: campaigns.reduce((s, c) => s + (c.expensesPendingBearer ?? 0), 0), expensesNotCompany: campaigns.reduce((s, c) => s + (c.expensesNotCompany ?? 0), 0) } : {}),
      unmatchedPayments: campaigns.reduce((s, c) => s + c.unmatchedPayments, 0) + unlinked, unmatchedWithoutCampaign: unlinked,
    },
  };
}
