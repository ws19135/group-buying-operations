import { z } from 'zod';
import type { Queryable, Tx } from '../lib/db';
import { pool, query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { can, GATE_APPROVER_ROLES, requirePerm } from '../lib/permissions';
import { AppError, forbidden, notFound, validation } from '../lib/errors';
import { audit, emitEvent } from '../lib/audit';
import { ids, todayTaipei } from '../lib/ids';
import { camelize } from '../lib/case';
import { campaignScope } from '../lib/scope';
import { detectConflicts } from './conflicts';
import { computeVendorMissing } from './vendors';
import { canCancel, canHold, findTransition, GATE_OUTCOME, GATE_REQUEST, type CampaignStatus } from '../workflow/state';

export interface CheckItem { key: string; label: string; level: 'BLOCK' | 'WARN'; ok: boolean; detail?: string; ackable?: boolean }

const item = (key: string, label: string, level: CheckItem['level'], ok: boolean, detail?: string, ackable = false): CheckItem => ({ key, label, level, ok, detail, ackable });

/** 關卡的系統檢查（不寫入資料）。BLOCK 未通過就不能申請／核准；WARN 只提醒 */
export async function runGateChecks(db: Queryable, orgId: string, campaignId: string, gate: string): Promise<CheckItem[]> {
  const cr = await db.query('SELECT * FROM campaigns WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [campaignId, orgId]);
  const c = cr.rows[0];
  if (!c) throw notFound('檔期');
  const today = todayTaipei();
  const out: CheckItem[] = [];

  const hosts = (await db.query('SELECT status FROM campaign_hosts WHERE campaign_id=$1 AND deleted_at IS NULL', [campaignId])).rows as { status: string }[];
  const products = (await db.query(
    `SELECT cp.id, p.name, p.review_status, cp.campaign_price, s.group_price, s.status AS sku_status
     FROM campaign_products cp JOIN products p ON p.id=cp.product_id LEFT JOIN skus s ON s.id=cp.sku_id
     WHERE cp.campaign_id=$1 AND cp.deleted_at IS NULL`, [campaignId])).rows as Record<string, unknown>[];
  const gateTask = (await db.query('SELECT id FROM tasks WHERE campaign_id=$1 AND gate_key=$2', [campaignId, gate])).rows[0] as { id: string } | undefined;
  const pendingDeps = gateTask
    ? (await db.query(`SELECT d.name FROM task_dependencies td JOIN tasks d ON d.id=td.depends_on_task_id WHERE td.task_id=$1 AND d.status NOT IN ('DONE','SKIPPED')`, [gateTask.id])).rows.map((r) => String(r.name))
    : [];
  out.push(item('deps_done', '前置任務已完成', 'BLOCK', pendingDeps.length === 0, pendingDeps.length ? `尚未完成：${pendingDeps.join('、')}` : undefined));

  if (gate === 'G1') {
    const v = (await db.query('SELECT * FROM vendors WHERE id=$1', [c.vendor_id])).rows[0];
    out.push(item('vendor_ok', '廠商狀態可合作', 'BLOCK', !!v && !['PAUSED', 'BLACKLISTED'].includes(v.status), v ? `廠商狀態：${v.status}` : '找不到廠商'));
    out.push(item('has_products', '至少一個商品且規格啟用中', 'BLOCK', products.length > 0 && products.every((p) => p.sku_status !== 'INACTIVE')));
    out.push(item('has_confirmed_host', '至少一位團主已確認開團', 'BLOCK', hosts.some((h) => h.status === 'CONFIRMED'),
      hosts.length ? `團主狀態：${hosts.map((h) => h.status).join('、')}` : '尚未邀請任何團主'));
    const contacts = (await db.query('SELECT email, phone, line_id, is_primary FROM vendor_contacts WHERE vendor_id=$1 AND deleted_at IS NULL', [c.vendor_id])).rows;
    const miss = v ? computeVendorMissing(v, contacts) : [];
    out.push(item('vendor_info', '廠商資料完整', 'WARN', miss.length === 0, miss.length ? `待補：${miss.join('、')}` : undefined));
  }
  if (gate === 'G2') {
    out.push(item('dates_set', '已設定開團日與結團日', 'BLOCK', !!c.open_date && !!c.close_date));
    out.push(item('open_not_past', '開團日不早於今天', 'BLOCK', !c.open_date || c.open_date >= today, c.open_date ? `開團日 ${c.open_date}` : undefined));
    out.push(item('products_approved', '所有商品已通過審核', 'BLOCK', products.length > 0 && products.every((p) => p.review_status === 'APPROVED'),
      products.filter((p) => p.review_status !== 'APPROVED').map((p) => String(p.name)).join('、') || undefined));
    out.push(item('prices_set', '每個商品都有團購價', 'BLOCK', products.length > 0 && products.every((p) => p.campaign_price != null || p.group_price != null)));
    out.push(item('has_confirmed_host', '至少一位團主已確認', 'BLOCK', hosts.some((h) => h.status === 'CONFIRMED')));
    const pl = await db.query(`SELECT count(*)::int AS n FROM campaign_placements WHERE campaign_id=$1 AND deleted_at IS NULL AND status='PLANNED'`, [campaignId]);
    out.push(item('has_placement', '已排定曝光安排', 'BLOCK', pl.rows[0].n > 0));
    const conflicts = await detectConflicts(db, orgId, campaignId);
    const high = conflicts.filter((x) => x.severity === 'HIGH');
    out.push(item('no_high_conflicts', '沒有高風險檔期衝突', 'BLOCK', high.length === 0, high.map((x) => x.message).join('；') || undefined, true));
    const med = conflicts.filter((x) => x.severity === 'MEDIUM');
    out.push(item('no_medium_conflicts', '沒有中度檔期衝突', 'WARN', med.length === 0, med.map((x) => x.message).join('；') || undefined));
  }
  if (gate === 'G3') {
    out.push(item('past_close', '已過結團日', 'BLOCK', !!c.close_date && today > c.close_date, c.close_date ? `結團日 ${c.close_date}` : '未設定結團日'));
    const o = await db.query(`SELECT count(*)::int AS n, max(ordered_at) AS last FROM orders WHERE campaign_id=$1`, [campaignId]);
    out.push(item('orders_present', '已有訂單資料', 'WARN', o.rows[0].n > 0, o.rows[0].n ? `共 ${o.rows[0].n} 筆` : '尚未匯入任何訂單，請確認是否資料延遲'));
    const imp = await db.query(`SELECT max(data_as_of) AS d FROM import_batches WHERE organization_id=$1 AND status IN ('COMPLETED','PARTIAL')`, [orgId]);
    const fresh = imp.rows[0].d && c.close_date && String(imp.rows[0].d.toISOString().slice(0, 10)) >= c.close_date;
    out.push(item('orders_fresh', '訂單資料截至結團日之後', 'WARN', !!fresh, imp.rows[0].d ? `最近資料截至 ${imp.rows[0].d.toISOString()}` : '尚無匯入紀錄'));
  }
  if (gate === 'G4') {
    const inv = await db.query(`SELECT status FROM tasks WHERE campaign_id=$1 AND step_key='INVOICE_REQUEST'`, [campaignId]);
    const invOk = !inv.rows[0] || ['DONE', 'SKIPPED'].includes(inv.rows[0].status);
    out.push(item('invoice_done', '請款作業（開發票請款）已完成', 'BLOCK', invOk, invOk ? undefined : `目前狀態：${inv.rows[0].status}`));
    out.push(item('settlement_module', '結算試算與確認（需人工確認）', 'WARN', false, '請至「財務結算」確認此檔期的結算試算已確認；系統目前不會自動串接 G4，口徑待 Owner 確認'));
  }
  if (gate === 'G5') {
    const ex = await db.query(`SELECT count(*)::int AS n FROM exceptions WHERE campaign_id=$1 AND status<>'RESOLVED' AND severity='HIGH'`, [campaignId]);
    out.push(item('no_open_high_exceptions', '沒有未結的高風險例外', 'BLOCK', ex.rows[0].n === 0, ex.rows[0].n ? `${ex.rows[0].n} 筆未結` : undefined));
    const open = await db.query(`SELECT count(*)::int AS n FROM tasks WHERE campaign_id=$1 AND status NOT IN ('DONE','SKIPPED','CANCELLED') AND gate_key IS DISTINCT FROM 'G5'`, [campaignId]);
    out.push(item('no_open_tasks', '沒有未完成任務', 'BLOCK', open.rows[0].n === 0, open.rows[0].n ? `${open.rows[0].n} 項未完成` : undefined));
  }
  return out;
}

export const gateCheck = async (actor: Actor, campaignId: string, gate: string) => {
  requirePerm(actor, 'approval.read');
  await assertVisible(actor, campaignId);
  if (!GATE_REQUEST[gate]) throw validation('未知的關卡');
  return runGateChecks(pool(), actor.orgId, campaignId, gate);
};

async function assertVisible(actor: Actor, campaignId: string) {
  const sc = campaignScope(actor, 2, 'c');
  if (sc.sql === 'FALSE') throw notFound('檔期');
  const r = await query('SELECT 1 FROM campaigns c WHERE c.id=$1 AND (' + sc.sql + ')', [campaignId, ...sc.params]);
  if (!r.length) throw notFound('檔期');
}

async function lockCampaign(tx: Tx, actor: Actor, id: string) {
  const sc = campaignScope(actor, 2, 'c');
  if (sc.sql === 'FALSE') throw notFound('檔期');
  const r = await tx.query(`SELECT c.* FROM campaigns c WHERE c.id=$1 AND (${sc.sql}) FOR UPDATE OF c`, [id, ...sc.params]);
  if (!r.rowCount) throw notFound('檔期');
  return r.rows[0] as Record<string, unknown>;
}

async function setStatus(tx: Tx, actor: Actor, c: Record<string, unknown>, to: CampaignStatus, reason: string | null, action: string, extra: Record<string, unknown> = {}) {
  const from = c['status'] as string;
  await tx.query('UPDATE campaigns SET status=$2, status_reason=$3, updated_by=$4 WHERE id=$1', [c['id'], to, reason, actor.userId]);
  await audit(tx, actor, { action, entityType: 'campaign', entityId: c['id'] as string, campaignId: c['id'] as string, before: { status: from }, after: { status: to, ...extra }, reason });
  await emitEvent(tx, actor, 'campaign.status_changed', 'campaign', c['id'] as string, { from, to }, `campaign.status_changed:${c['id']}:${from}:${to}:${Date.now()}`);
}

// ---------------- 申請核准 ----------------
export async function requestApproval(actor: Actor, campaignId: string, gate: string, note?: string) {
  requirePerm(actor, 'approval.request');
  if (!GATE_REQUEST[gate]) throw validation('未知的關卡');
  return withTx(async (tx) => {
    const c = await lockCampaign(tx, actor, campaignId);
    const spec = GATE_REQUEST[gate];
    if (c['status'] !== spec.from) throw new AppError('PRECONDITION_FAILED', `${gate} 只能在「${spec.from}」狀態申請，目前為 ${c['status']}`);
    const pending = await tx.query(`SELECT id FROM approvals WHERE campaign_id=$1 AND gate_key=$2 AND status='PENDING'`, [campaignId, gate]);
    if (pending.rowCount) throw new AppError('CONFLICT', `已有待處理的 ${gate} 申請：${pending.rows[0].id}`, { existingId: pending.rows[0].id });
    const checks = await runGateChecks(tx, actor.orgId, campaignId, gate);
    const failed = checks.filter((x) => x.level === 'BLOCK' && !x.ok && !x.ackable);
    if (failed.length) throw new AppError('PRECONDITION_FAILED', `關卡檢查未通過：${failed.map((f) => f.label).join('、')}`, { checks });
    const id = await ids.approval(tx);
    await tx.query(
      `INSERT INTO approvals (id, organization_id, campaign_id, gate_key, requested_by, request_note, check_snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, actor.orgId, campaignId, gate, actor.userId, note ?? null, JSON.stringify(checks)]);
    await tx.query(`UPDATE tasks SET status='WAITING_APPROVAL', updated_by=$3 WHERE campaign_id=$1 AND gate_key=$2 AND status IN ('TODO','IN_PROGRESS','BLOCKED')`, [campaignId, gate, actor.userId]);
    if (spec.to) await setStatus(tx, actor, c, spec.to, null, 'campaign.status', { approvalId: id });
    await audit(tx, actor, { action: 'approval.request', entityType: 'approval', entityId: id, campaignId, after: { gate, note: note ?? null } });
    await emitEvent(tx, actor, 'approval.requested', 'approval', id, { campaignId, gate }, `approval.requested:${id}`);
    return { id, gate, checks };
  });
}

// ---------------- 核准／退回 ----------------
export async function decideApproval(actor: Actor, approvalId: string, decision: 'APPROVED' | 'REJECTED', note?: string, acknowledge?: string) {
  const dec = z.enum(['APPROVED', 'REJECTED']).parse(decision);
  return withTx(async (tx) => {
    const ar = await tx.query('SELECT * FROM approvals WHERE id=$1 AND organization_id=$2 FOR UPDATE', [approvalId, actor.orgId]);
    const a = ar.rows[0];
    if (!a) throw notFound('核准申請');
    if (!GATE_APPROVER_ROLES[a.gate_key]?.includes(actor.role)) throw forbidden(`你的角色不能決定 ${a.gate_key} 關卡`);
    if (a.status !== 'PENDING') throw new AppError('PRECONDITION_FAILED', `此申請已是 ${a.status}`);
    const distinct = await tx.query(`SELECT value FROM system_settings WHERE organization_id=$1 AND key='approval.require_distinct_actor'`, [actor.orgId]);
    if (distinct.rows[0]?.value === true && a.requested_by && a.requested_by === actor.userId) throw forbidden('此組織設定要求申請人與核准人不得為同一人');
    if (dec === 'REJECTED' && !note?.trim()) throw validation('退回需填寫原因');
    const c = await lockCampaign(tx, actor, a.campaign_id);
    const outcome = GATE_OUTCOME[a.gate_key];
    const spec = GATE_REQUEST[a.gate_key];
    if (c['status'] !== (spec.to ?? spec.from)) throw new AppError('PRECONDITION_FAILED', `檔期狀態已變動為 ${c['status']}，請重新申請`);

    if (dec === 'APPROVED') {
      const checks = await runGateChecks(tx, actor.orgId, a.campaign_id, a.gate_key);
      const failed = checks.filter((x) => x.level === 'BLOCK' && !x.ok);
      const unackable = failed.filter((x) => !x.ackable);
      if (unackable.length) throw new AppError('PRECONDITION_FAILED', `關卡檢查未通過：${unackable.map((f) => f.label).join('、')}`, { checks });
      if (failed.length && !acknowledge?.trim()) throw new AppError('PRECONDITION_FAILED', `需填寫風險確認原因才能核准：${failed.map((f) => f.label).join('、')}`, { checks, needsAcknowledge: true });
      await tx.query(`UPDATE approvals SET status='APPROVED', decided_by=$2, decided_at=now(), decision_note=$3, check_snapshot=$4 WHERE id=$1`,
        [approvalId, actor.userId, [note, acknowledge ? `風險確認：${acknowledge}` : ''].filter(Boolean).join('；') || null, JSON.stringify(checks)]);
      await tx.query(`UPDATE tasks SET status='DONE', completed_at=now(), completed_by=$3, updated_by=$3 WHERE campaign_id=$1 AND gate_key=$2 AND status IN ('TODO','IN_PROGRESS','BLOCKED','WAITING_APPROVAL')`, [a.campaign_id, a.gate_key, actor.userId]);
      await setStatus(tx, actor, c, outcome.approved, null, 'campaign.status', { approvalId, gate: a.gate_key });
    } else {
      await tx.query(`UPDATE approvals SET status='REJECTED', decided_by=$2, decided_at=now(), decision_note=$3 WHERE id=$1`, [approvalId, actor.userId, note ?? null]);
      await tx.query(`UPDATE tasks SET status='TODO', blocker_reason=NULL, updated_by=$3 WHERE campaign_id=$1 AND gate_key=$2 AND status='WAITING_APPROVAL'`, [a.campaign_id, a.gate_key, actor.userId]);
      if (outcome.rejected) await setStatus(tx, actor, c, outcome.rejected, note ?? null, 'campaign.status', { approvalId, gate: a.gate_key, rejected: true });
    }
    await audit(tx, actor, { action: `approval.${dec === 'APPROVED' ? 'approve' : 'reject'}`, entityType: 'approval', entityId: approvalId, campaignId: a.campaign_id,
      before: { status: 'PENDING' }, after: { status: dec, gate: a.gate_key }, reason: note ?? acknowledge ?? null });
    return { id: approvalId, status: dec, campaignStatus: dec === 'APPROVED' ? outcome.approved : (outcome.rejected ?? c['status']) };
  });
}

export async function listApprovals(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'approval.read');
  const sc = campaignScope(actor, 1, 'c');
  if (sc.sql === 'FALSE') return [];
  const params = [...sc.params];
  const where = [`(${sc.sql})`];
  const st = q.get('status'); if (st) { params.push(st); where.push(`a.status=$${params.length}`); }
  const cid = q.get('campaignId'); if (cid) { params.push(cid); where.push(`a.campaign_id=$${params.length}`); }
  const rows = await query(
    `SELECT a.*, c.title AS campaign_title, c.status AS campaign_status, ru.name AS requested_by_name, du.name AS decided_by_name
     FROM approvals a JOIN campaigns c ON c.id=a.campaign_id LEFT JOIN users ru ON ru.id=a.requested_by LEFT JOIN users du ON du.id=a.decided_by
     WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT 200`, params);
  return camelize(rows);
}

// ---------------- 一般狀態變更（非關卡） ----------------
export async function transitionCampaign(actor: Actor, campaignId: string, to: CampaignStatus, opts: { reason?: string; force?: boolean } = {}) {
  requirePerm(actor, 'campaign.transition');
  return withTx(async (tx) => {
    const c = await lockCampaign(tx, actor, campaignId);
    const from = c['status'] as CampaignStatus;
    const t = findTransition(from, to);
    if (!t) throw new AppError('PRECONDITION_FAILED', `不允許由 ${from} 直接變更為 ${to}`);
    if (t.kind === 'GATE') throw new AppError('PRECONDITION_FAILED', `${from} → ${to} 必須經過 ${t.gate} 核准流程，不能直接變更狀態`);
    if (t.backward && !opts.reason?.trim()) throw validation('倒退狀態需填寫原因');
    const today = todayTaipei();
    const force = !!opts.force && !!opts.reason?.trim() && ['SYSTEM_ADMIN', 'OPS_MANAGER'].includes(actor.role);
    if (from === 'DRAFT' && to === 'EVALUATING') {
      const n = await tx.query('SELECT count(*)::int AS n FROM campaign_products WHERE campaign_id=$1 AND deleted_at IS NULL', [campaignId]);
      if (n.rows[0].n === 0) throw new AppError('PRECONDITION_FAILED', '進入評估前至少需要一個商品');
    }
    if (from === 'SCHEDULED' && to === 'RUNNING' && !force && (!c['open_date'] || today < (c['open_date'] as string))) {
      throw new AppError('PRECONDITION_FAILED', `尚未到開團日（${c['open_date'] ?? '未設定'}）；提前開團需營運主管填寫原因並強制執行`);
    }
    if (from === 'RUNNING' && to === 'PENDING_CLOSE_CHECK' && !force && (!c['close_date'] || today <= (c['close_date'] as string))) {
      throw new AppError('PRECONDITION_FAILED', `尚未過結團日（${c['close_date'] ?? '未設定'}）`);
    }
    if (t.backward) await tx.query(`UPDATE approvals SET status='CANCELLED', decision_note='狀態倒退，申請自動取消' WHERE campaign_id=$1 AND status='PENDING'`, [campaignId]);
    await setStatus(tx, actor, c, to, opts.reason ?? null, 'campaign.status', { backward: !!t.backward, forced: force });
    return { id: campaignId, status: to };
  });
}

export async function cancelCampaign(actor: Actor, campaignId: string, reason: string) {
  requirePerm(actor, 'campaign.transition');
  if (!['SYSTEM_ADMIN', 'OPS_MANAGER'].includes(actor.role)) throw forbidden('只有營運主管／管理者可以取消檔期');
  if (!reason?.trim()) throw validation('取消需填寫原因');
  return withTx(async (tx) => {
    const c = await lockCampaign(tx, actor, campaignId);
    const from = c['status'] as CampaignStatus;
    if (!canCancel(from)) throw new AppError('PRECONDITION_FAILED', `狀態 ${from} 之後不可取消（已進入履約／結算，請走售後或調整流程）`);
    await tx.query('UPDATE campaigns SET previous_status=$2 WHERE id=$1', [campaignId, from]);
    const t = await tx.query(`UPDATE tasks SET status='CANCELLED', updated_by=$2 WHERE campaign_id=$1 AND status NOT IN ('DONE','SKIPPED','CANCELLED')`, [campaignId, actor.userId]);
    const a = await tx.query(`UPDATE approvals SET status='CANCELLED', decision_note='檔期取消' WHERE campaign_id=$1 AND status='PENDING'`, [campaignId]);
    const p = await tx.query(`UPDATE campaign_placements SET status='CANCELLED', updated_by=$2 WHERE campaign_id=$1 AND status='PLANNED' AND deleted_at IS NULL`, [campaignId, actor.userId]);
    const e = await tx.query(`UPDATE exceptions SET status='RESOLVED', resolved_at=now(), resolution_note='檔期取消' WHERE campaign_id=$1 AND status<>'RESOLVED'`, [campaignId]);
    await setStatus(tx, actor, c, 'CANCELLED', reason, 'campaign.cancel', { cancelledTasks: t.rowCount, cancelledApprovals: a.rowCount, cancelledPlacements: p.rowCount, resolvedExceptions: e.rowCount });
    return { id: campaignId, status: 'CANCELLED', cancelledTasks: t.rowCount };
  });
}

export async function holdCampaign(actor: Actor, campaignId: string, reason: string) {
  requirePerm(actor, 'campaign.transition');
  if (!reason?.trim()) throw validation('暫緩需填寫原因');
  return withTx(async (tx) => {
    const c = await lockCampaign(tx, actor, campaignId);
    const from = c['status'] as CampaignStatus;
    if (!canHold(from)) throw new AppError('PRECONDITION_FAILED', `狀態 ${from} 不可暫緩`);
    await tx.query('UPDATE campaigns SET previous_status=$2 WHERE id=$1', [campaignId, from]);
    await setStatus(tx, actor, c, 'ON_HOLD', reason, 'campaign.hold');
    return { id: campaignId, status: 'ON_HOLD' };
  });
}

export async function resumeCampaign(actor: Actor, campaignId: string, reason: string) {
  requirePerm(actor, 'campaign.transition');
  if (!reason?.trim()) throw validation('恢復需填寫原因');
  return withTx(async (tx) => {
    const c = await lockCampaign(tx, actor, campaignId);
    if (c['status'] !== 'ON_HOLD' || !c['previous_status']) throw new AppError('PRECONDITION_FAILED', '只有暫緩中的檔期可以恢復');
    await setStatus(tx, actor, c, c['previous_status'] as CampaignStatus, reason, 'campaign.resume');
    return { id: campaignId, status: c['previous_status'] };
  });
}

export { can };
