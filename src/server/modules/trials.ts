import { z } from 'zod';
import type { Queryable, Tx } from '../lib/db';
import { pool, query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, requirePerm } from '../lib/permissions';
import { conflict, forbidden, notFound, precondition, validation } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids, todayTaipei } from '../lib/ids';
import { camelize } from '../lib/case';
import { addDays, isIsoDate, maxDate } from '../lib/dates';
import { idempotent } from '../lib/idempotency';
import { campaignScope } from '../lib/scope';
import {
  CHECK_CATALOG, CHECK_RESULTS, CONCLUSIONS, RECOVERY_STATUSES, SEVERITIES, TRIAL_LEVELS, TRIAL_TYPES, checkProblems, checksForLevel, isMoreOptimistic, productFingerprint,
  qualificationValidity, suggestConclusion, type Conclusion, type TrialLevel,
} from '../lib/trial-catalog';
import { assertCampaignVisible, assertNoPii, campaignVisible, evidenceFor, loadProductBasic, loadSelectionConfig, mapDbError } from './selection';
import { maskEvidenceList } from './evidence';

/**
 * SOP 03 商品試用。兩個層級（商品資格／團主與檔期適配）、三種類型（內部／指定團主／小規模測試團）。
 * 試用紀錄只存「資料」：日期、物流、回收、四面向檢核、結論與覆核；狀態只有 OPEN／CONCLUDED／CANCELLED。
 * 寄樣、到貨、回饋、G1 等任務仍由既有任務模組管理，這裡只唯讀顯示其現況。設計見 docs/phase2/PRODUCT_SELECTION_TRIAL.md §5。
 */
const optDate = z.string().refine(isIsoDate, '日期格式需為 YYYY-MM-DD').nullable().optional().or(z.literal('').transform(() => null));
const txt = (n: number) => z.string().trim().max(n).nullable().optional().or(z.literal('').transform(() => null));

const logistics = {
  testerUserId: z.string().max(40).nullable().optional(),
  testerNote: txt(300),
  sampleBatchId: z.string().max(40).nullable().optional(),
  shipDate: optDate, arrivalDate: optDate, startDate: optDate, feedbackDate: optDate, closedDate: optDate,
  carrier: txt(80), trackingNo: txt(80),
  recoveryRequired: z.boolean().optional(),
  recoveryStatus: z.enum(RECOVERY_STATUSES).optional(),
  recoveryDate: optDate,
  recoveryNote: txt(300),
};

export const trialCreateSchema = z.object({
  level: z.enum(TRIAL_LEVELS),
  trialType: z.enum(TRIAL_TYPES),
  skuId: z.string().max(40).nullable().optional(),
  hostId: z.string().max(40).nullable().optional(),
  campaignId: z.string().max(40).nullable().optional(),
  reuseQualification: z.boolean().optional(),
  ...logistics,
}).strict();

export const trialPatchSchema = z.object({ ...logistics, version: z.number().int().optional() }).strict();

const DATE_FIELDS = [['shipDate', '寄樣日'], ['arrivalDate', '到貨日'], ['startDate', '開始試用日'], ['feedbackDate', '回饋日'], ['closedDate', '結案日']] as const;
function checkDateOrder(d: Record<string, string | null | undefined>): void {
  let prev: { label: string; v: string } | null = null;
  for (const [k, label] of DATE_FIELDS) {
    const v = d[k];
    if (!v) continue;
    if (prev && v < prev.v) throw validation(`「${label}」不可早於「${prev.label}」`);
    prev = { label, v };
  }
}

// ---------------- 商品指紋與資格有效性 ----------------
export async function currentFingerprint(db: Queryable, orgId: string, productId: string): Promise<string> {
  const p = await loadProductBasic(db, orgId, productId);
  const skus = await db.query<{ sku_code: string }>(`SELECT sku_code FROM skus WHERE product_id=$1 AND deleted_at IS NULL`, [productId]);
  return productFingerprint({ name: p.name, category: p.category, complianceNote: p.complianceNote, skuCodes: skus.rows.map((s) => s.sku_code) });
}

interface TrialRow { id: string; product_id: string; vendor_id: string; level: string; trial_type: string; status: string; campaign_id: string | null; host_id: string | null; sku_id: string | null;
  conclusion: string | null; suggested_conclusion: string | null; review_decision: string | null; valid_until: string | null; basis_fingerprint: string | null; qualification_trial_id: string | null;
  feedback_date: string | null; version: number; concluded_by: string | null; [k: string]: unknown }

/** 該商品最近一次「商品資格」試用及其目前是否仍有效（沿用）。最近一次若不通過，就以它為準 */
export async function qualificationFor(db: Queryable, orgId: string, productId: string) {
  const r = await db.query(`SELECT * FROM product_trials WHERE organization_id=$1 AND product_id=$2 AND level='QUALIFICATION' AND status='CONCLUDED' ORDER BY concluded_at DESC, id DESC LIMIT 1`, [orgId, productId]);
  if (!r.rowCount) return null;
  const t = r.rows[0] as TrialRow;
  const fp = await currentFingerprint(db, orgId, productId);
  const validity = qualificationValidity({ status: t.status, conclusion: t.conclusion, reviewDecision: t.review_decision, validUntil: t.valid_until, basisFingerprint: t.basis_fingerprint }, fp, todayTaipei());
  return { trialId: t.id, conclusion: t.conclusion, validUntil: t.valid_until, reviewDecision: t.review_decision, valid: validity.valid, reasons: validity.reasons };
}

// ---------------- 建立 ----------------
export async function createTrial(actor: Actor, productId: string, raw: z.input<typeof trialCreateSchema>, idemKey?: string | null) {
  requirePerm(actor, 'selection.write');
  const input = trialCreateSchema.parse(raw);
  assertNoPii({ 試用人備註: input.testerNote, 追蹤碼: input.trackingNo, 回收備註: input.recoveryNote });
  if (input.level === 'HOST_FIT' && input.trialType === 'INTERNAL') throw validation('團主／檔期適配試用不能是「內部試用」；請選指定團主或小規模測試團');
  if (input.trialType === 'DESIGNATED_HOST' && !input.hostId) throw validation('指定團主試用需選擇團主');
  if (input.trialType === 'MINI_GROUP' && !input.campaignId) throw validation('小規模測試團需選擇檔期');
  checkDateOrder(input as never);
  const product = await loadProductBasic(pool(), actor.orgId, productId);
  if (input.campaignId) {
    await assertCampaignVisible(actor, input.campaignId);
    const inCamp = await query('SELECT 1 FROM campaign_products WHERE campaign_id=$1 AND product_id=$2 AND deleted_at IS NULL', [input.campaignId, productId]);
    if (!inCamp.length) throw validation('此商品不在指定的檔期內');
  }
  if (input.skuId) {
    const s = await query('SELECT 1 FROM skus WHERE id=$1 AND product_id=$2 AND organization_id=$3 AND deleted_at IS NULL', [input.skuId, productId, actor.orgId]);
    if (!s.length) throw validation('規格不屬於這個商品');
  }
  if (input.hostId) {
    const h = await query('SELECT 1 FROM hosts WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [input.hostId, actor.orgId]);
    if (!h.length) throw notFound('團主');
  }
  if (input.testerUserId) {
    const u = await query(`SELECT 1 FROM users WHERE id=$1 AND organization_id=$2 AND status='ACTIVE' AND deleted_at IS NULL AND role_key IN ('SYSTEM_ADMIN','OPS_MANAGER','OPS_EDITOR','FINANCE')`, [input.testerUserId, actor.orgId]);
    if (!u.length) throw validation('試用人必須是啟用中的內部使用者（團主請用「團主」欄位）');
  }
  if (input.sampleBatchId) {
    const b = await query<{ campaign_id: string; kind: string }>('SELECT campaign_id, kind FROM fulfillment_batches WHERE id=$1 AND organization_id=$2', [input.sampleBatchId, actor.orgId]);
    if (!b.length || !(await campaignVisible(actor, b[0].campaign_id))) throw notFound('寄樣批次');
    if (b[0].kind !== 'SAMPLE') throw validation('只能關聯「寄樣」批次');
  }
  try {
    const { result } = await withTx((tx) => idempotent(tx, actor, 'trial.create', idemKey, async () => {
      let qualificationId: string | null = null;
      if (input.level === 'HOST_FIT' && input.reuseQualification !== false) {
        const q = await qualificationFor(tx, actor.orgId, productId);
        if (q?.valid) qualificationId = q.trialId;
      }
      const id = await ids.trial(tx);
      const recReq = input.recoveryRequired === true;
      await tx.query(
        `INSERT INTO product_trials (id, organization_id, product_id, sku_id, vendor_id, level, trial_type, host_id, campaign_id, tester_user_id, tester_note, qualification_trial_id, sample_batch_id,
           ship_date, arrival_date, start_date, feedback_date, closed_date, carrier, tracking_no, recovery_required, recovery_status, recovery_date, recovery_note, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$25)`,
        [id, actor.orgId, productId, input.skuId ?? null, product.vendorId, input.level, input.trialType, input.hostId ?? null, input.campaignId ?? null, input.testerUserId ?? null, input.testerNote ?? null,
          qualificationId, input.sampleBatchId ?? null, input.shipDate ?? null, input.arrivalDate ?? null, input.startDate ?? null, input.feedbackDate ?? null, input.closedDate ?? null,
          input.carrier ?? null, input.trackingNo ?? null, recReq, recReq ? (input.recoveryStatus && input.recoveryStatus !== 'NOT_REQUIRED' ? input.recoveryStatus : 'PENDING') : 'NOT_REQUIRED',
          input.recoveryDate ?? null, input.recoveryNote ?? null, actor.userId]);
      for (const c of checksForLevel(input.level as TrialLevel, !!qualificationId)) {
        await tx.query(`INSERT INTO trial_checks (id, organization_id, trial_id, dimension, item_key, item_label, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
          [await ids.trialCheck(tx), actor.orgId, id, c.dimension, c.key, c.label, actor.userId]);
      }
      await audit(tx, actor, { action: 'selection.trial.create', entityType: 'product_trial', entityId: id, campaignId: input.campaignId ?? null,
        after: { productId, level: input.level, trialType: input.trialType, hostId: input.hostId ?? null, campaignId: input.campaignId ?? null, skuId: input.skuId ?? null, qualificationTrialId: qualificationId } });
      return { id, qualificationTrialId: qualificationId };
    }, { productId, ...input }));
    return result;
  } catch (e) { return mapDbError(e, '同一商品、規格、團主、檔期與類型已有進行中的試用；請先結論或取消，再開新的一次'); }
}

// ---------------- 讀取 ----------------
const SELECT_TRIAL = `SELECT t.*, p.name AS product_name, v.name AS vendor_name, h.display_name AS host_name, c.title AS campaign_title, s.name AS sku_name,
    tu.name AS tester_name, cu.name AS concluded_by_name, ru.name AS reviewed_by_name,
    (SELECT count(*)::int FROM trial_checks k WHERE k.trial_id=t.id) AS check_total,
    (SELECT count(*)::int FROM trial_checks k WHERE k.trial_id=t.id AND k.result <> 'NOT_TESTED') AS check_tested
  FROM product_trials t JOIN products p ON p.id=t.product_id JOIN vendors v ON v.id=t.vendor_id LEFT JOIN hosts h ON h.id=t.host_id LEFT JOIN campaigns c ON c.id=t.campaign_id
  LEFT JOIN skus s ON s.id=t.sku_id LEFT JOIN users tu ON tu.id=t.tester_user_id LEFT JOIN users cu ON cu.id=t.concluded_by LEFT JOIN users ru ON ru.id=t.reviewed_by`;

function trialScopeSql(actor: Actor, startIdx: number) {
  const sc = campaignScope(actor, startIdx, 'c');
  const sql = sc.sql === 'FALSE' ? 't.campaign_id IS NULL' : `(t.campaign_id IS NULL OR EXISTS (SELECT 1 FROM campaigns c WHERE c.id=t.campaign_id AND (${sc.sql})))`;
  return { sql, params: sc.params };
}

export async function listProductTrials(actor: Actor, productId: string) {
  requirePerm(actor, 'selection.read');
  const p = await loadProductBasic(pool(), actor.orgId, productId);
  const sc = trialScopeSql(actor, 3);
  const rows = await query(`${SELECT_TRIAL} WHERE t.organization_id=$1 AND t.product_id=$2 AND ${sc.sql} ORDER BY t.created_at DESC, t.id DESC`, [actor.orgId, productId, ...sc.params]);
  const cfg = await loadSelectionConfig(pool(), actor.orgId);
  return {
    productId, productName: p.name, items: camelize(rows), qualification: await qualificationFor(pool(), actor.orgId, productId),
    config: { trialValidDays: cfg.trialValidDays }, canReview: can(actor, 'product.review'),
  };
}

const TASK_KEYS = ['SAMPLE_SHIP', 'TRIAL_ARRIVAL', 'TRIAL_FEEDBACK', 'LAUNCH_APPROVAL'];
async function linkedTasks(db: Queryable, orgId: string, campaignId: string) {
  const r = await db.query(`SELECT id, step_key, name, status, planned_end, completed_at, evidence_url FROM tasks WHERE organization_id=$1 AND campaign_id=$2 AND step_key = ANY($3::text[]) ORDER BY phase, seq`, [orgId, campaignId, TASK_KEYS]);
  return camelize(r.rows);
}

/** 試用內容的存取：挑戰檔期範圍（越權＝404） */
async function loadTrialForActor(actor: Actor, id: string): Promise<TrialRow & Record<string, unknown>> {
  const rows = await query(`${SELECT_TRIAL} WHERE t.id=$1 AND t.organization_id=$2`, [id, actor.orgId]);
  if (!rows.length) throw notFound('試用');
  const t = rows[0] as TrialRow & Record<string, unknown>;
  if (t.campaign_id && !(await campaignVisible(actor, t.campaign_id))) throw notFound('試用');
  return t;
}

function projectCheck(c: Record<string, unknown>, canCost: boolean): Record<string, unknown> {
  // 預估毛利這一項的文字可能含成本，沒有成本檢視權限者只看到結果
  if (c.itemKey === 'margin' && !canCost) return { ...c, evidenceText: null, defectNote: null, riskNote: null, restricted: true };
  return c;
}

export async function getTrial(actor: Actor, id: string) {
  requirePerm(actor, 'selection.read');
  const t = await loadTrialForActor(actor, id);
  const canCost = can(actor, 'product.cost.read');
  const cfg = await loadSelectionConfig(pool(), actor.orgId);
  const today = todayTaipei();
  const checks = camelize<Record<string, unknown>[]>((await query(`SELECT k.*, u.name AS verified_by_name FROM trial_checks k LEFT JOIN users u ON u.id=k.verified_by WHERE k.trial_id=$1 ORDER BY k.created_at, k.id`, [id])));
  const order = new Map(CHECK_CATALOG.map((c, i) => [c.key, i]));
  checks.sort((a, b) => (order.get(a.itemKey as string) ?? 99) - (order.get(b.itemKey as string) ?? 99));
  const evT = await evidenceFor(pool(), actor.orgId, 'TRIAL', [id], today, cfg.expiringSoonDays);
  const evC = await evidenceFor(pool(), actor.orgId, 'TRIAL_CHECK', checks.map((c) => c.id as string), today, cfg.expiringSoonDays);
  const projected = checks.map((c) => ({ ...projectCheck(c, canCost), evidence: maskEvidenceList(evC.get(c.id as string) ?? [], c.itemKey !== 'margin' || canCost) }));
  const suggestion = suggestConclusion(checks.map((c) => ({ dimension: c.dimension as string, result: c.result as string, defectSeverity: c.defectSeverity as string })));
  const q = t.level === 'QUALIFICATION' || t.qualification_trial_id ? await qualificationFor(pool(), actor.orgId, t.product_id) : null;
  const linkedQ = t.qualification_trial_id ? await query(`SELECT id, conclusion, valid_until, concluded_at FROM product_trials WHERE id=$1`, [t.qualification_trial_id]) : [];
  const hist = await query(
    `SELECT a.id, a.occurred_at, a.action, a.entity_type, a.entity_id, a.actor_role, u.name AS actor_name, a.before_data, a.after_data, a.reason FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id
     WHERE a.organization_id=$1 AND ((a.entity_type='product_trial' AND a.entity_id=$2) OR (a.entity_type='trial_check' AND a.entity_id = ANY($3::text[]))) ORDER BY a.id DESC LIMIT 60`,
    [actor.orgId, id, checks.map((c) => c.id as string)]);
  return {
    ...camelize<Record<string, unknown>>(t), checks: projected, evidence: maskEvidenceList(evT.get(id) ?? [], true),
    suggestion, qualification: q, linkedQualification: camelize(linkedQ[0] ?? null),
    tasks: t.campaign_id ? await linkedTasks(pool(), actor.orgId, t.campaign_id) : [],
    history: camelize(hist), config: { trialValidDays: cfg.trialValidDays },
    permissions: { write: can(actor, 'selection.write'), review: can(actor, 'product.review'), cost: canCost },
  };
}

// ---------------- 更新 ----------------
async function lockTrial(tx: Tx, actor: Actor, id: string): Promise<TrialRow> {
  const r = await tx.query(`SELECT * FROM product_trials WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [id, actor.orgId]);
  if (!r.rowCount) throw notFound('試用');
  const t = r.rows[0] as TrialRow;
  if (t.campaign_id) {
    const sc = campaignScope(actor, 2, 'c');
    if (sc.sql === 'FALSE') throw notFound('試用');
    const ok = await tx.query(`SELECT 1 FROM campaigns c WHERE c.id=$1 AND (${sc.sql})`, [t.campaign_id, ...sc.params]);
    if (!ok.rowCount) throw notFound('試用');
  }
  return t;
}

/** 物流與回收可在結論後補寫（例如試用品回收）；已取消不可改 */
export async function updateTrial(actor: Actor, id: string, raw: z.input<typeof trialPatchSchema>) {
  requirePerm(actor, 'selection.write');
  const input = trialPatchSchema.parse(raw);
  assertNoPii({ 試用人備註: input.testerNote, 追蹤碼: input.trackingNo, 回收備註: input.recoveryNote });
  await withTx(async (tx) => {
    const t = await lockTrial(tx, actor, id);
    if (t.status === 'CANCELLED') throw precondition('已取消的試用不能修改');
    if (input.version != null && input.version !== t.version) throw conflict('資料已被其他人更新，請重新整理後再試', { currentVersion: t.version });
    const merged: Record<string, unknown> = {};
    const sets: Record<string, unknown> = {};
    const map: Record<string, string> = { testerUserId: 'tester_user_id', testerNote: 'tester_note', sampleBatchId: 'sample_batch_id', shipDate: 'ship_date', arrivalDate: 'arrival_date', startDate: 'start_date', feedbackDate: 'feedback_date',
      closedDate: 'closed_date', carrier: 'carrier', trackingNo: 'tracking_no', recoveryRequired: 'recovery_required', recoveryStatus: 'recovery_status', recoveryDate: 'recovery_date', recoveryNote: 'recovery_note' };
    for (const [k, col] of Object.entries(map)) {
      const v = (input as Record<string, unknown>)[k];
      if (v !== undefined) sets[col] = v;
    }
    for (const [k] of DATE_FIELDS) merged[k] = (input as Record<string, unknown>)[k] !== undefined ? (input as Record<string, unknown>)[k] : t[map[k]];
    checkDateOrder(merged as never);
    if (input.testerUserId) {
      const u = await tx.query(`SELECT 1 FROM users WHERE id=$1 AND organization_id=$2 AND status='ACTIVE' AND deleted_at IS NULL AND role_key IN ('SYSTEM_ADMIN','OPS_MANAGER','OPS_EDITOR','FINANCE')`, [input.testerUserId, actor.orgId]);
      if (!u.rowCount) throw validation('試用人必須是啟用中的內部使用者');
    }
    if (input.sampleBatchId) {
      const b = await tx.query<{ campaign_id: string; kind: string }>('SELECT campaign_id, kind FROM fulfillment_batches WHERE id=$1 AND organization_id=$2', [input.sampleBatchId, actor.orgId]);
      if (!b.rowCount || !(await campaignVisible(actor, b.rows[0].campaign_id))) throw notFound('寄樣批次');
      if (b.rows[0].kind !== 'SAMPLE') throw validation('只能關聯「寄樣」批次');
    }
    // 回收欄位一致性
    const req = (sets.recovery_required ?? t.recovery_required) as boolean;
    let rs = (sets.recovery_status ?? t.recovery_status) as string;
    if (!req) rs = 'NOT_REQUIRED';
    else if (rs === 'NOT_REQUIRED') rs = 'PENDING';
    if (req !== t.recovery_required || rs !== t.recovery_status) { sets.recovery_required = req; sets.recovery_status = rs; }
    if (rs === 'RECOVERED' && !((sets.recovery_date ?? t.recovery_date) as string | null)) throw validation('標示「已回收」時，請填寫回收日期');
    const cols = Object.keys(sets).filter((c) => JSON.stringify(sets[c] ?? null) !== JSON.stringify(t[c] ?? null));
    if (!cols.length) return;
    await tx.query(`UPDATE product_trials SET ${cols.map((c, i) => `${c}=$${i + 3}`).join(', ')}, updated_by=$${cols.length + 3} WHERE id=$1 AND organization_id=$2`, [id, actor.orgId, ...cols.map((c) => sets[c]), actor.userId]);
    await audit(tx, actor, { action: 'selection.trial.update', entityType: 'product_trial', entityId: id, campaignId: t.campaign_id,
      before: Object.fromEntries(cols.map((c) => [c, t[c] ?? null])), after: Object.fromEntries(cols.map((c) => [c, sets[c] ?? null])) });
  }).catch((e) => mapDbError(e));
  return getTrial(actor, id);
}

export const checkPatchSchema = z.object({
  result: z.enum(CHECK_RESULTS).optional(),
  evidenceText: z.string().trim().max(1000).nullable().optional().or(z.literal('').transform(() => null)),
  defectSeverity: z.enum(SEVERITIES).optional(),
  defectNote: z.string().trim().max(1000).nullable().optional().or(z.literal('').transform(() => null)),
  riskNote: z.string().trim().max(1000).nullable().optional().or(z.literal('').transform(() => null)),
  version: z.number().int().optional(),
}).strict();

export async function updateTrialCheck(actor: Actor, checkId: string, raw: z.input<typeof checkPatchSchema>) {
  requirePerm(actor, 'selection.write');
  const input = checkPatchSchema.parse(raw);
  assertNoPii({ 客觀證據: input.evidenceText, 缺陷說明: input.defectNote, 風險說明: input.riskNote });
  const trialId = await withTx(async (tx) => {
    const cur = await tx.query(`SELECT * FROM trial_checks WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [checkId, actor.orgId]);
    if (!cur.rowCount) throw notFound('檢核項');
    const k = cur.rows[0] as Record<string, unknown>;
    const t = await lockTrial(tx, actor, k.trial_id as string);
    if (t.status !== 'OPEN') throw precondition(`試用已${t.status === 'CONCLUDED' ? '結論' : '取消'}，檢核項不能修改；請建立新的試用`);
    if (input.version != null && input.version !== k.version) throw conflict('資料已被其他人更新，請重新整理後再試', { currentVersion: k.version });
    const sensitive = k.item_key === 'margin';
    if (sensitive && !can(actor, 'product.cost.read') && (input.evidenceText !== undefined || input.defectNote !== undefined || input.riskNote !== undefined))
      throw forbidden('「預估毛利」的說明可能含成本，需有成本檢視權限才能填寫');
    const next = {
      result: input.result ?? (k.result as string), evidenceText: input.evidenceText !== undefined ? input.evidenceText : (k.evidence_text as string | null),
      defectSeverity: input.defectSeverity ?? (k.defect_severity as string), defectNote: input.defectNote !== undefined ? input.defectNote : (k.defect_note as string | null),
      riskNote: input.riskNote !== undefined ? input.riskNote : (k.risk_note as string | null),
    };
    const problems = checkProblems(next);
    if (problems.length) throw validation(problems.join('；'), { problems });
    const tested = next.result !== 'NOT_TESTED';
    await tx.query(
      `UPDATE trial_checks SET result=$2, evidence_text=$3, defect_severity=$4, defect_note=$5, risk_note=$6, verified_by=$7, verified_at=CASE WHEN $8 THEN now() ELSE NULL END, updated_by=$9 WHERE id=$1`,
      [checkId, next.result, next.evidenceText?.trim() || null, next.defectSeverity, next.defectNote?.trim() || null, next.riskNote?.trim() || null, tested ? actor.userId : null, tested, actor.userId]);
    const snap = (o: Record<string, unknown>) => sensitive ? { itemKey: k.item_key, result: o.result, defectSeverity: o.defectSeverity ?? o.defect_severity, text: '[敏感]' }
      : { itemKey: k.item_key, result: o.result, evidenceText: o.evidenceText ?? o.evidence_text, defectSeverity: o.defectSeverity ?? o.defect_severity, defectNote: o.defectNote ?? o.defect_note, riskNote: o.riskNote ?? o.risk_note };
    await audit(tx, actor, { action: 'selection.trial.check', entityType: 'trial_check', entityId: checkId, campaignId: t.campaign_id, before: snap(k), after: snap(next) });
    return k.trial_id as string;
  }).catch((e) => mapDbError(e));
  return { id: checkId, trialId };
}

// ---------------- 結論、覆核、取消 ----------------
export const concludeSchema = z.object({
  conclusion: z.enum(CONCLUSIONS),
  note: z.string().trim().min(1, '請填寫結論說明').max(1000),
  overrideReason: z.string().trim().max(500).optional().or(z.literal('').transform(() => undefined)),
  validUntil: z.string().refine(isIsoDate, '日期格式需為 YYYY-MM-DD').optional(),
  version: z.number().int().optional(),
}).strict();

export async function concludeTrial(actor: Actor, id: string, raw: z.input<typeof concludeSchema>) {
  requirePerm(actor, 'selection.write');
  const input = concludeSchema.parse(raw);
  assertNoPii({ 結論說明: input.note, 覆寫原因: input.overrideReason });
  return withTx(async (tx) => {
    const t = await lockTrial(tx, actor, id);
    if (t.status !== 'OPEN') throw precondition('這個試用已結論或取消');
    if (input.version != null && input.version !== t.version) throw conflict('資料已被其他人更新，請重新整理後再試', { currentVersion: t.version });
    const checks = await tx.query<{ dimension: string; result: string; defect_severity: string }>(`SELECT dimension, result, defect_severity FROM trial_checks WHERE trial_id=$1`, [id]);
    const sug = suggestConclusion(checks.rows.map((c) => ({ dimension: c.dimension, result: c.result, defectSeverity: c.defect_severity })));
    const final = input.conclusion as Conclusion;
    if (isMoreOptimistic(final, sug.conclusion)) {
      if (!can(actor, 'product.review')) throw forbidden(`最終建議比系統建議（${sug.conclusion}）更樂觀，需由具審核權限者填寫覆寫原因`);
      if (!input.overrideReason) throw validation(`最終建議比系統建議（${sug.conclusion}：${sug.reasons.join('、')}）更樂觀，請填寫覆寫原因`);
    }
    if (t.qualification_trial_id) {
      const q = await qualificationFor(tx, actor.orgId, t.product_id);
      if (!q || q.trialId !== t.qualification_trial_id || !q.valid) throw precondition(`沿用的商品資格已失效（${q?.reasons.join('；') ?? '找不到資格試用'}）：請先重做商品資格試用，或取消這次試用重新建立`);
    }
    const cfg = await loadSelectionConfig(tx, actor.orgId);
    const today = todayTaipei();
    let validUntil: string | null = null;
    if (final === 'PASS' || final === 'CONDITIONAL') {
      const max = addDays(today, cfg.trialValidDays);
      validUntil = input.validUntil ?? max;
      if (validUntil > max) throw validation(`有效期限不可超過 ${max}（${cfg.trialValidDays} 天）`);
      if (validUntil < today) throw validation('有效期限不可早於今天');
    }
    const fp = await currentFingerprint(tx, actor.orgId, t.product_id);
    const closed = (t.closed_date as string | null) ?? maxDate(today, t.feedback_date as string | null, t.start_date as string | null, t.arrival_date as string | null, t.ship_date as string | null);
    await tx.query(
      `UPDATE product_trials SET status='CONCLUDED', conclusion=$2, suggested_conclusion=$3, conclusion_note=$4, override_reason=$5, concluded_by=$6, concluded_at=now(), valid_until=$7, basis_fingerprint=$8,
         closed_date=$9, updated_by=$6 WHERE id=$1`,
      [id, final, sug.conclusion, input.note, input.overrideReason ?? null, actor.userId, validUntil, fp, closed]);
    await audit(tx, actor, { action: 'selection.trial.conclude', entityType: 'product_trial', entityId: id, campaignId: t.campaign_id,
      before: { status: 'OPEN' }, after: { status: 'CONCLUDED', conclusion: final, suggested: sug.conclusion, overridden: final !== sug.conclusion && isMoreOptimistic(final, sug.conclusion), validUntil, level: t.level }, reason: input.overrideReason ?? null });
    return { id, conclusion: final, suggested: sug.conclusion, suggestedReasons: sug.reasons, validUntil };
  }).catch((e) => mapDbError(e));
}

export const trialReviewSchema = z.object({ decision: z.enum(['ACCEPTED', 'REJECTED']), note: z.string().trim().max(1000).optional().or(z.literal('').transform(() => undefined)) });

export async function reviewTrial(actor: Actor, id: string, raw: z.input<typeof trialReviewSchema>) {
  requirePerm(actor, 'product.review');
  requirePerm(actor, 'selection.read');
  const input = trialReviewSchema.parse(raw);
  if (input.decision === 'REJECTED' && !input.note) throw validation('不接受時，請填寫原因');
  assertNoPii({ 覆核意見: input.note });
  return withTx(async (tx) => {
    const t = await lockTrial(tx, actor, id);
    if (t.status !== 'CONCLUDED') throw precondition('尚未結論的試用不能覆核');
    await tx.query(`UPDATE product_trials SET review_decision=$2, review_note=$3, reviewed_by=$4, reviewed_at=now(), updated_by=$4 WHERE id=$1`, [id, input.decision, input.note ?? null, actor.userId]);
    await audit(tx, actor, { action: 'selection.trial.review', entityType: 'product_trial', entityId: id, campaignId: t.campaign_id,
      before: { reviewDecision: t.review_decision ?? null }, after: { reviewDecision: input.decision, reviewNote: input.note ?? null, conclusion: t.conclusion } });
    return { id, reviewDecision: input.decision };
  }).catch((e) => mapDbError(e));
}

export async function cancelTrial(actor: Actor, id: string, reason: string) {
  requirePerm(actor, 'selection.write');
  const why = (reason ?? '').trim();
  if (!why) throw validation('請填寫取消原因');
  assertNoPii({ 取消原因: why });
  return withTx(async (tx) => {
    const t = await lockTrial(tx, actor, id);
    if (t.status !== 'OPEN') throw precondition('只有進行中的試用可以取消');
    await tx.query(`UPDATE product_trials SET status='CANCELLED', cancel_reason=$2, updated_by=$3 WHERE id=$1`, [id, why, actor.userId]);
    await audit(tx, actor, { action: 'selection.trial.cancel', entityType: 'product_trial', entityId: id, campaignId: t.campaign_id, before: { status: 'OPEN' }, after: { status: 'CANCELLED' }, reason: why });
    return { id, status: 'CANCELLED' };
  });
}

// ---------------- 檔期 ----------------
export async function campaignTrials(actor: Actor, campaignId: string) {
  requirePerm(actor, 'selection.read');
  const camp = await assertCampaignVisible(actor, campaignId);
  const rows = await query(`${SELECT_TRIAL} WHERE t.organization_id=$1 AND t.campaign_id=$2 ORDER BY t.created_at DESC, t.id DESC`, [actor.orgId, campaignId]);
  const items = camelize<(Record<string, unknown> & { productId: string; status: string; conclusion: string | null })[]>(rows);
  return {
    campaignId, campaignTitle: camp.title as string, items, tasks: await linkedTasks(pool(), actor.orgId, campaignId),
    summary: { total: items.length, open: items.filter((i) => i.status === 'OPEN').length, concluded: items.filter((i) => i.status === 'CONCLUDED').length, failed: items.filter((i) => i.conclusion === 'FAIL').length },
  };
}
