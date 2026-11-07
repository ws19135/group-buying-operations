import { z } from 'zod';
import { pool, query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { requirePerm } from '../lib/permissions';
import { conflict, forbidden, notFound, precondition, validation } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids, todayTaipei } from '../lib/ids';
import { camelize } from '../lib/case';
import {
  IMPORT_STAGING_MAX_DAYS, RETENTION_HOLD_MAX_DAYS, RETENTION_HOLD_REASONS, addDaysIso, evaluatePurge,
  type ApplicationStatus,
} from '../lib/collaboration-rules';
import { assertNoPii } from './selection';
import { isoDateOf, loadApp, logEvent, shipmentFacts } from './collaboration-shared';

/**
 * 個資保留與清除（D-40）。
 *
 * 清除機制：
 *  - 只清「收件資料」本體（姓名、電話、地址、郵遞區號、備註），申請單與寄送紀錄保留（沒有個資）。
 *  - 每次執行寫一筆 collaboration_purge_runs、逐筆結果寫 collaboration_purge_items（含失敗與略過原因）。
 *  - 單筆失敗不會讓整批回滾，也不會被吞掉：記為 FAILED，整體狀態為 PARTIAL。
 *  - 決策邏輯在 lib/collaboration-rules.ts 的 evaluatePurge（純函式、有單元測試）。
 *  - 本檔不排程任何東西：沒有 cron、沒有 worker。手動呼叫或由 scripts/collaboration-purge.ts 在隔離環境執行；
 *    正式環境排程需 Owner 另行授權（見 docs/phase2/SECURITY_REVIEW.md）。
 */

export interface PurgeOptions { dryRun?: boolean; today?: string; source?: 'MANUAL' | 'SCRIPT' }

interface Candidate {
  id: string; application_id: string; retention_until: string | null; deleted_at: Date | null;
  app_status: ApplicationStatus; base_on: string; hold_until: string | null;
}

const PURGE_SET = `recipient_name='［已清除］', recipient_phone='［已清除］', address_line='［已清除］',
  postal_code=NULL, delivery_note=NULL, purged_at=now()`;

async function loadCandidates(orgId: string): Promise<Candidate[]> {
  const r = await query<Candidate>(
    `SELECT r.id, r.application_id, r.retention_until, r.deleted_at, a.status AS app_status,
            to_char(coalesce(a.decided_at, a.created_at) AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') AS base_on,
            (SELECT max(h.hold_until)::text FROM collaboration_retention_holds h
              WHERE h.application_id = r.application_id AND h.released_at IS NULL) AS hold_until
       FROM collaboration_recipients r JOIN collaboration_applications a ON a.id = r.application_id
      WHERE r.organization_id=$1 AND r.purged_at IS NULL ORDER BY r.id`, [orgId]);
  return r.map((x) => ({ ...x, retention_until: isoDateOf(x.retention_until), hold_until: isoDateOf(x.hold_until) }));
}

/**
 * 執行（或試跑）清除。回傳本輪結果；完整逐筆結果見 collaboration_purge_items。
 * 非試跑只有管理者可執行；試跑需要 collaboration.retention.manage。
 */
export async function runRecipientPurge(actor: Actor, opts: PurgeOptions = {}) {
  requirePerm(actor, 'collaboration.retention.manage');
  const dryRun = !!opts.dryRun;
  if (!dryRun && actor.role !== 'SYSTEM_ADMIN') throw forbidden();
  const today = opts.today ?? todayTaipei();

  const runId = await withTx(async (tx) => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO collaboration_purge_runs (organization_id, trigger_source, dry_run, actor_user_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [actor.orgId, opts.source ?? 'MANUAL', dryRun, actor.userId]);
    return r.rows[0].id;
  });
  const counts = { candidates: 0, purged: 0, skippedHold: 0, skippedFulfilment: 0, forcedByCap: 0, failed: 0, stagingScrubbed: 0 };
  const item = (recipientId: string, appId: string, outcome: string, detail: string | null) =>
    pool().query(`INSERT INTO collaboration_purge_items (run_id, organization_id, recipient_id, application_id, outcome, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
      [runId, actor.orgId, recipientId, appId, outcome, detail]);

  try {
    for (const c of await loadCandidates(actor.orgId)) {
      // 已被新資料取代的舊收件資料（軟刪除但內容還在）：不論保留期，立即清除
      if (c.deleted_at) {
        counts.candidates++;
        if (dryRun) { await item(c.id, c.application_id, 'WOULD_PURGE', '已被新的收件資料取代的舊資料'); continue; }
        try {
          await withTx(async (tx) => {
            await tx.query(`UPDATE collaboration_recipients SET ${PURGE_SET}, purge_reason='已被新的收件資料取代', updated_by=$2 WHERE id=$1`, [c.id, actor.userId]);
            await audit(tx, actor, { action: 'collaboration.recipient.purge', entityType: 'collaboration_recipient', entityId: c.id, after: { applicationId: c.application_id, basis: 'SUPERSEDED' } });
          });
          counts.purged++;
          await item(c.id, c.application_id, 'PURGED', '已被新的收件資料取代的舊資料');
        } catch (e) { counts.failed++; await item(c.id, c.application_id, 'FAILED', `錯誤碼 ${(e as { code?: string }).code ?? 'UNKNOWN'}`); }
        continue;
      }
      const decision = evaluatePurge({
        retentionUntil: c.retention_until, baseOn: c.base_on, applicationStatus: c.app_status,
        shipments: await shipmentFacts(pool(), c.application_id), activeHoldUntil: c.hold_until,
      }, today);
      if (decision.action === 'NOT_DUE') continue;
      counts.candidates++;
      if (decision.action === 'SKIP_HOLD') { counts.skippedHold++; await item(c.id, c.application_id, 'SKIPPED_HOLD', decision.detail); continue; }
      if (decision.action === 'SKIP_FULFILMENT') { counts.skippedFulfilment++; await item(c.id, c.application_id, 'SKIPPED_FULFILMENT', decision.detail); continue; }
      if (dryRun) { await item(c.id, c.application_id, 'WOULD_PURGE', decision.detail); continue; }
      try {
        await withTx(async (tx) => {
          await tx.query(`UPDATE collaboration_recipients SET ${PURGE_SET}, purge_reason=$3, updated_by=$2 WHERE id=$1`,
            [c.id, actor.userId, decision.hardCap ? '超過硬性上限強制清除' : '超過保留期清除']);
          await logEvent(tx, actor, c.application_id, 'DATA', 'RECIPIENT_PURGED', { note: decision.detail, internal: true });
          await audit(tx, actor, {
            action: 'collaboration.recipient.purge', entityType: 'collaboration_recipient', entityId: c.id,
            after: { applicationId: c.application_id, basis: decision.hardCap ? 'HARD_CAP' : 'RETENTION_EXPIRED', runId },
          });
        });
        counts.purged++;
        if (decision.hardCap) counts.forcedByCap++;
        await item(c.id, c.application_id, decision.hardCap ? 'PURGED_HARD_CAP' : 'PURGED', decision.detail);
      } catch (e) {
        counts.failed++;
        await item(c.id, c.application_id, 'FAILED', `錯誤碼 ${(e as { code?: string }).code ?? 'UNKNOWN'}`);
      }
    }
    counts.stagingScrubbed = await scrubImportStaging(actor, dryRun);
  } catch (e) {
    await pool().query(`UPDATE collaboration_purge_runs SET status='FAILED', error_summary=$2, finished_at=now(), failed=$3 WHERE id=$1`,
      [runId, `執行中斷：${(e as { code?: string }).code ?? (e as Error).name}`, counts.failed]);
    throw e;
  }

  const status = counts.failed === 0 ? 'SUCCEEDED' : 'PARTIAL';
  await withTx(async (tx) => {
    await tx.query(
      `UPDATE collaboration_purge_runs SET status=$2, candidates=$3, purged=$4, skipped_hold=$5, skipped_fulfilment=$6, forced_by_cap=$7,
         failed=$8, staging_scrubbed=$9, finished_at=now() WHERE id=$1`,
      [runId, status, counts.candidates, counts.purged, counts.skippedHold, counts.skippedFulfilment, counts.forcedByCap, counts.failed, counts.stagingScrubbed]);
    await audit(tx, actor, {
      action: dryRun ? 'collaboration.recipient.purge_dry_run' : 'collaboration.recipient.purge_run',
      entityType: 'collaboration_purge_run', entityId: String(runId), after: { status, ...counts },
    });
  });
  return { runId: Number(runId), status, dryRun, ...counts };
}

/**
 * 匯入暫存列（collaboration_import_rows.raw）與匯入錯誤紀錄（import_errors.raw_row）會留著原始 CSV 列，
 * 其中包含收件人／電話／地址。已建立申請單、已跳過、或超過 30 天沒處理的暫存列一律清掉個資欄位。
 */
export async function scrubImportStaging(actor: Actor, dryRun: boolean): Promise<number> {
  const cond = `r.organization_id=$1 AND r.pii_scrubbed_at IS NULL
    AND (r.resolution IN ('IMPORTED','SKIPPED') OR r.created_at < now() - ($2::int * interval '1 day'))
    AND (r.raw ? 'recipientName' OR r.raw ? 'recipientPhone' OR r.raw ? 'addressLine')`;
  const days = IMPORT_STAGING_MAX_DAYS;
  if (dryRun) {
    const c = await query<{ n: number }>(`SELECT count(*)::int AS n FROM collaboration_import_rows r WHERE ${cond}`, [actor.orgId, days]);
    return Number(c[0]?.n ?? 0);
  }
  return withTx(async (tx) => {
    const r = await tx.query(
      `UPDATE collaboration_import_rows r SET raw = r.raw - 'recipientName' - 'recipientPhone' - 'addressLine', pii_scrubbed_at=now()
        WHERE ${cond}`, [actor.orgId, days]);
    // 已清過的暫存列對應的錯誤紀錄一併清除（錯誤紀錄寫入時已先去個資，這裡處理歷史資料）
    await tx.query(
      `UPDATE import_errors e SET raw_row = e.raw_row::jsonb - 'recipientName' - 'recipientPhone' - 'addressLine'
        WHERE e.organization_id=$1 AND e.batch_id IN (SELECT id FROM import_batches WHERE organization_id=$1 AND source_system LIKE 'COLLABORATION_%')
          AND (e.raw_row::jsonb ? 'recipientName' OR e.raw_row::jsonb ? 'recipientPhone' OR e.raw_row::jsonb ? 'addressLine')`, [actor.orgId]);
    return r.rowCount ?? 0;
  });
}

// ---------------------------------------------------------------- 保留例外（有依據、有期限、可解除）
export const holdSchema = z.object({
  reasonCode: z.enum(RETENTION_HOLD_REASONS),
  basis: z.string().trim().min(10, '請寫明依據（案號、法規或爭議說明，至少 10 個字）').max(500),
  holdUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式需為 YYYY-MM-DD'),
}).strict();

/** 設定保留例外：阻止清除，但不擴大任何人的讀取權限。最長 365 天，要延長必須重新申請並留下稽核 */
export async function placeRetentionHold(actor: Actor, appId: string, raw: z.input<typeof holdSchema>) {
  requirePerm(actor, 'collaboration.retention.manage');
  const input = holdSchema.parse(raw);
  assertNoPii({ 依據: input.basis });
  const today = todayTaipei();
  if (input.holdUntil <= today) throw validation('保留到期日必須晚於今天');
  if (input.holdUntil > addDaysIso(today, RETENTION_HOLD_MAX_DAYS)) throw validation(`保留例外最長 ${RETENTION_HOLD_MAX_DAYS} 天，不可無限期保留`);
  return withTx(async (tx) => {
    const app = await loadApp(tx, actor, appId, true);
    const rec = await tx.query('SELECT 1 FROM collaboration_recipients WHERE application_id=$1 AND deleted_at IS NULL AND purged_at IS NULL', [appId]);
    if (!rec.rowCount) throw precondition('這筆申請沒有尚未清除的收件資料，不需要保留例外');
    const id = await ids.collaborationHold(tx);
    await tx.query(
      `INSERT INTO collaboration_retention_holds (id, organization_id, application_id, reason_code, basis, placed_on, hold_until, placed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, actor.orgId, appId, input.reasonCode, input.basis, today, input.holdUntil, actor.userId]);
    await logEvent(tx, actor, appId, 'DATA', 'RETENTION_HOLD_PLACED', { note: `${input.reasonCode} 至 ${input.holdUntil}`, internal: true });
    await audit(tx, actor, {
      action: 'collaboration.retention.hold', entityType: 'collaboration_retention_hold', entityId: id, campaignId: app.campaign_id,
      after: { applicationId: appId, reasonCode: input.reasonCode, holdUntil: input.holdUntil, basis: input.basis },
    });
    return { id, applicationId: appId, holdUntil: input.holdUntil };
  });
}

export async function releaseRetentionHold(actor: Actor, holdId: string, reason: string) {
  requirePerm(actor, 'collaboration.retention.manage');
  if (!reason?.trim()) throw validation('請填寫解除原因');
  assertNoPii({ 解除原因: reason });
  return withTx(async (tx) => {
    const cur = await tx.query<{ application_id: string; released_at: Date | null }>(
      'SELECT application_id, released_at FROM collaboration_retention_holds WHERE id=$1 AND organization_id=$2 FOR UPDATE', [holdId, actor.orgId]);
    if (!cur.rowCount) throw notFound('保留例外');
    if (cur.rows[0].released_at) throw conflict('這筆保留例外已經解除');
    await loadApp(tx, actor, cur.rows[0].application_id);
    await tx.query('UPDATE collaboration_retention_holds SET released_at=now(), released_by=$2, release_reason=$3 WHERE id=$1', [holdId, actor.userId, reason]);
    await logEvent(tx, actor, cur.rows[0].application_id, 'DATA', 'RETENTION_HOLD_RELEASED', { note: reason, internal: true });
    await audit(tx, actor, { action: 'collaboration.retention.release', entityType: 'collaboration_retention_hold', entityId: holdId, reason });
    return { id: holdId, released: true };
  });
}

export async function listRetentionHolds(actor: Actor, appId: string) {
  requirePerm(actor, 'collaboration.retention.manage');
  await loadApp(pool(), actor, appId);
  const rows = await query(
    `SELECT h.id, h.reason_code, h.basis, h.placed_on, h.hold_until, h.released_at, h.release_reason, u.name AS placed_by_name,
            (h.released_at IS NULL AND h.hold_until >= current_date) AS active
       FROM collaboration_retention_holds h LEFT JOIN users u ON u.id=h.placed_by WHERE h.application_id=$1 ORDER BY h.created_at`, [appId]);
  return { items: camelize(rows) };
}

// ---------------------------------------------------------------- 監控
/**
 * 清除機制的健康狀態（營運主管／管理者）：有多少已到期、上一次執行結果、有沒有失敗、有沒有逾期積壓。
 * alerts 非空代表需要處理。這是「可監控」的最小實作：由人或外部監控定期讀取；本系統不自動發通知。
 */
export async function retentionStatus(actor: Actor) {
  requirePerm(actor, 'collaboration.retention.manage');
  const today = todayTaipei();
  const [due] = await query<{ due: number; overdue7: number; unpurged: number }>(
    `SELECT count(*) FILTER (WHERE retention_until < $2)::int AS due,
            count(*) FILTER (WHERE retention_until < $3)::int AS overdue7,
            count(*)::int AS unpurged
       FROM collaboration_recipients WHERE organization_id=$1 AND purged_at IS NULL AND deleted_at IS NULL`, [actor.orgId, today, addDaysIso(today, -7)]);
  const [holds] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM collaboration_retention_holds WHERE organization_id=$1 AND released_at IS NULL AND hold_until >= $2`, [actor.orgId, today]);
  const runs = await query<{ id: string; status: string; dry_run: boolean; purged: number; failed: number; finished_at: Date | null; started_at: Date }>(
    `SELECT id, status, dry_run, purged, failed, finished_at, started_at FROM collaboration_purge_runs
      WHERE organization_id=$1 AND dry_run=false ORDER BY id DESC LIMIT 1`, [actor.orgId]);
  const last = runs[0] ?? null;
  const alerts: string[] = [];
  if (Number(due?.due ?? 0) > 0 && !last) alerts.push('NEVER_RUN');
  if (last && (last.status === 'FAILED' || last.status === 'PARTIAL' || Number(last.failed) > 0)) alerts.push('LAST_RUN_FAILED');
  if (Number(due?.overdue7 ?? 0) > 0) alerts.push('OVERDUE_BACKLOG');
  return {
    unpurgedRecipients: Number(due?.unpurged ?? 0), dueRecipients: Number(due?.due ?? 0), overdueOver7Days: Number(due?.overdue7 ?? 0),
    activeHolds: Number(holds?.n ?? 0),
    lastRun: last ? { id: Number(last.id), status: last.status, purged: Number(last.purged), failed: Number(last.failed), startedAt: last.started_at, finishedAt: last.finished_at } : null,
    alerts,
    scheduler: { enabled: false, note: '本系統沒有排程；正式環境排程需 Owner 另行授權' },
  };
}

export async function listPurgeRuns(actor: Actor) {
  requirePerm(actor, 'collaboration.retention.manage');
  const rows = await query(
    `SELECT id, trigger_source, dry_run, status, candidates, purged, skipped_hold, skipped_fulfilment, forced_by_cap, failed, staging_scrubbed,
            error_summary, started_at, finished_at
       FROM collaboration_purge_runs WHERE organization_id=$1 ORDER BY id DESC LIMIT 50`, [actor.orgId]);
  return { items: camelize(rows) };
}

