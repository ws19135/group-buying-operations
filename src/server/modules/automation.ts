import { pool, query, withTx } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { requirePerm, systemActor, ROLE_LABEL, type RoleKey } from '../lib/permissions';
import { AppError, validation } from '../lib/errors';
import { audit } from '../lib/audit';
import { ids, todayTaipei } from '../lib/ids';
import { camelize } from '../lib/case';
import { addDays } from '../lib/dates';
import { dispatchNotifications, getAdapter, queueNotification, type NotifyAdapter } from './notifications';
import { processIntake } from './intake';
import { generateTasks } from './tasks';
import { runGateChecks, transitionCampaign } from './gates';
import { purgeExpiredIdempotencyKeys } from '../lib/idempotency';

export const JOB_KEYS = ['event_dispatch', 'vendor_intake', 'task_reminders', 'overdue_detection', 'prelaunch_check', 'campaign_status_progress', 'daily_summary', 'notification_dispatch'] as const;
export type JobKey = (typeof JOB_KEYS)[number];

export const JOB_LABEL: Record<JobKey, string> = {
  event_dispatch: '事件處理（建立任務、通知）',
  vendor_intake: '新廠商資料進件',
  task_reminders: '試用回饋與任務催辦',
  overdue_detection: '逾期異常偵測',
  prelaunch_check: '開團前檢查',
  campaign_status_progress: '開團／結團狀態推進與結團後作業',
  daily_summary: '每日營運摘要',
  notification_dispatch: '通知派送',
};

const MAX_ATTEMPTS = 3;
/** 超過這個天數仍未回覆才升級為高風險 */
const HIGH_AFTER_LATE_DAYS = 3;

export interface RunOptions { now?: Date; trigger?: 'MANUAL' | 'SCHEDULED' | 'EVENT'; idempotencyKey?: string; adapter?: NotifyAdapter }
export interface RunResult { runId: string | null; jobKey: JobKey; status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED'; reason?: string; stats?: Record<string, unknown>; error?: string }

export async function ensureAutomationSettings(orgId: string): Promise<void> {
  for (const k of JOB_KEYS) await query(`INSERT INTO automation_settings (organization_id, job_key, enabled) VALUES ($1,$2,false) ON CONFLICT DO NOTHING`, [orgId, k]);
}

export async function setJobEnabled(actor: Actor, jobKey: string, enabled: boolean) {
  requirePerm(actor, 'automation.manage');
  if (!(JOB_KEYS as readonly string[]).includes(jobKey)) throw validation('未知的自動化工作');
  return withTx(async (tx) => {
    await tx.query(`INSERT INTO automation_settings (organization_id, job_key, enabled, updated_by) VALUES ($1,$2,$3,$4)
      ON CONFLICT (organization_id, job_key) DO UPDATE SET enabled=$3, updated_by=$4, updated_at=now()`, [actor.orgId, jobKey, enabled, actor.userId]);
    await audit(tx, actor, { action: enabled ? 'automation.enable' : 'automation.disable', entityType: 'automation_job', entityId: jobKey, after: { enabled } });
    return { jobKey, enabled };
  });
}

export async function listJobs(actor: Actor) {
  requirePerm(actor, 'automation.manage');
  await ensureAutomationSettings(actor.orgId);
  const settings = await query(`SELECT job_key, enabled, updated_at FROM automation_settings WHERE organization_id=$1`, [actor.orgId]);
  const last = await query(`SELECT DISTINCT ON (job_key) job_key, status, started_at, finished_at, error, stats FROM automation_runs WHERE organization_id=$1 ORDER BY job_key, started_at DESC`, [actor.orgId]);
  return JOB_KEYS.map((k) => {
    const s = settings.find((x) => x.job_key === k);
    const l = last.find((x) => x.job_key === k);
    return { jobKey: k, label: JOB_LABEL[k], enabled: !!s?.enabled, lastRun: l ? camelize(l) : null };
  });
}

export async function listRuns(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'automation.manage');
  const status = q.get('status'); const job = q.get('jobKey');
  const params: unknown[] = [actor.orgId]; const where = ['organization_id=$1'];
  if (status) { params.push(status); where.push(`status=$${params.length}`); }
  if (job) { params.push(job); where.push(`job_key=$${params.length}`); }
  return camelize(await query(`SELECT * FROM automation_runs WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT 200`, params));
}

export function defaultKey(job: JobKey, now: Date): string {
  const d = todayTaipei(now);
  // 頻率只決定「預設冪等鍵的粒度」；每個工作本身也都有業務去重，所以重複觸發不會產生重複資料
  if (job === 'daily_summary' || job === 'task_reminders' || job === 'overdue_detection' || job === 'prelaunch_check') return `${job}:${d}`;
  if (job === 'campaign_status_progress') return `${job}:${now.toISOString().slice(0, 13)}`;   // 每小時
  return `${job}:${now.toISOString().slice(0, 16)}`;                                             // 每分鐘（事件、進件、通知）
}

/**
 * 執行一個自動化工作。
 * - 冪等：同一個 idempotency key 成功過就直接 SKIPPED，不重複建立任何東西
 * - 可重試：失敗的 run 在 attempts < 3 時，再次執行會重試同一筆 run
 * - 可停用：未啟用的工作一律 SKIPPED（reason=disabled），手動執行也一樣
 * - 有紀錄：每次執行都寫入 automation_runs（含統計與錯誤訊息）
 */
export async function runJob(orgId: string, jobKey: JobKey, opts: RunOptions = {}): Promise<RunResult> {
  if (!(JOB_KEYS as readonly string[]).includes(jobKey)) throw validation('未知的自動化工作');
  const now = opts.now ?? new Date();
  await ensureAutomationSettings(orgId);
  const st = await query<{ enabled: boolean }>(`SELECT enabled FROM automation_settings WHERE organization_id=$1 AND job_key=$2`, [orgId, jobKey]);
  if (!st[0]?.enabled) return { runId: null, jobKey, status: 'SKIPPED', reason: 'disabled' };

  const key = opts.idempotencyKey ?? defaultKey(jobKey, now);
  const trigger = opts.trigger ?? 'SCHEDULED';
  const runId = await ids.run(pool(), now);
  const ins = await query(
    `INSERT INTO automation_runs (id, organization_id, job_key, idempotency_key, trigger, status) VALUES ($1,$2,$3,$4,$5,'RUNNING') ON CONFLICT DO NOTHING RETURNING id`,
    [runId, orgId, jobKey, key, trigger]);
  let id = runId;
  if (!ins.length) {
    const ex = (await query(`SELECT id, status, attempts FROM automation_runs WHERE organization_id=$1 AND job_key=$2 AND idempotency_key=$3`, [orgId, jobKey, key]))[0];
    if (ex.status === 'SUCCEEDED' || ex.status === 'RUNNING') return { runId: ex.id, jobKey, status: 'SKIPPED', reason: ex.status === 'RUNNING' ? 'already_running' : 'already_succeeded' };
    if (ex.attempts >= MAX_ATTEMPTS) return { runId: ex.id, jobKey, status: 'SKIPPED', reason: 'max_attempts_reached' };
    const claimed = await query(`UPDATE automation_runs SET status='RUNNING', attempts=attempts+1, started_at=now(), finished_at=NULL, error=NULL WHERE id=$1 AND status='FAILED' RETURNING id`, [ex.id]);
    if (!claimed.length) return { runId: ex.id, jobKey, status: 'SKIPPED', reason: 'claimed_by_other' };
    id = ex.id;
  }
  try {
    const stats = await HANDLERS[jobKey](orgId, now, opts);
    await query(`UPDATE automation_runs SET status='SUCCEEDED', finished_at=now(), stats=$2 WHERE id=$1`, [id, JSON.stringify(stats)]);
    return { runId: id, jobKey, status: 'SUCCEEDED', stats };
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 500);
    await query(`UPDATE automation_runs SET status='FAILED', finished_at=now(), error=$2 WHERE id=$1`, [id, msg]);
    return { runId: id, jobKey, status: 'FAILED', error: msg };
  }
}

export async function runJobManually(actor: Actor, jobKey: string, opts: { adapter?: NotifyAdapter; now?: Date } = {}): Promise<RunResult> {
  requirePerm(actor, 'automation.run');
  if (!(JOB_KEYS as readonly string[]).includes(jobKey)) throw validation('未知的自動化工作');
  const now = opts.now ?? new Date();
  // 手動執行使用獨立的 key，不會被當天的排程 run 吃掉
  const res = await runJob(actor.orgId, jobKey as JobKey, { ...opts, now, trigger: 'MANUAL', idempotencyKey: `${jobKey}:manual:${now.toISOString()}:${actor.userId}` });
  await audit(pool(), actor, { action: 'automation.run_manual', entityType: 'automation_job', entityId: jobKey, after: { status: res.status, reason: res.reason ?? null, runId: res.runId } });
  return res;
}

/** 依序執行所有已啟用的工作（供 worker 使用） */
export async function runAllDue(orgId: string, opts: RunOptions = {}): Promise<RunResult[]> {
  const out: RunResult[] = [];
  for (const k of JOB_KEYS) out.push(await runJob(orgId, k, opts));
  return out;
}

// ====================== 各工作的實作 ======================
type Handler = (orgId: string, now: Date, opts: RunOptions) => Promise<Record<string, unknown>>;

async function managersOf(orgId: string): Promise<string[]> {
  return (await query<{ id: string }>(`SELECT id FROM users WHERE organization_id=$1 AND role_key IN ('SYSTEM_ADMIN','OPS_MANAGER') AND status='ACTIVE' AND deleted_at IS NULL`, [orgId])).map((r) => r.id);
}

async function hostUsers(hostId: string): Promise<string[]> {
  return (await query<{ user_id: string }>(
    `SELECT s.user_id FROM user_scopes s JOIN users u ON u.id=s.user_id WHERE s.scope_type='HOST' AND s.scope_id=$1 AND s.revoked_at IS NULL AND u.status='ACTIVE'`, [hostId])).map((r) => r.user_id);
}

async function openException(orgId: string, e: { type: string; severity: 'LOW' | 'MEDIUM' | 'HIGH'; entityType: string; entityId: string; campaignId?: string | null; title: string; detail?: string; ownerUserId?: string | null; dedupeKey: string }): Promise<boolean> {
  const r = await query(
    `INSERT INTO exceptions (id, organization_id, type, severity, entity_type, entity_id, campaign_id, title, detail, owner_user_id, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,
    [await ids.exception(pool()), orgId, e.type, e.severity, e.entityType, e.entityId, e.campaignId ?? null, e.title, e.detail ?? null, e.ownerUserId ?? null, e.dedupeKey]);
  if (!r.length && e.severity === 'HIGH') {
    // 已存在：若嚴重度升高則升級
    await query(`UPDATE exceptions SET severity='HIGH', version=version+1 WHERE organization_id=$1 AND dedupe_key=$2 AND status<>'RESOLVED' AND severity<>'HIGH'`, [orgId, e.dedupeKey]);
  }
  return !!r.length;
}

const HANDLERS: Record<JobKey, Handler> = {
  // ---- 事件處理 ----
  async event_dispatch(orgId) {
    const sys = systemActor(orgId, 'WORKER', 'job:event_dispatch');
    const events = await query(`SELECT * FROM events WHERE organization_id=$1 AND processed_at IS NULL AND attempts < 5 ORDER BY id LIMIT 200`, [orgId]);
    let handled = 0, failed = 0, tasksCreated = 0;
    for (const ev of events) {
      try {
        await withTx(async (tx) => {
          const locked = await tx.query(`SELECT processed_at FROM events WHERE id=$1 FOR UPDATE SKIP LOCKED`, [ev.id]);
          if (!locked.rowCount || locked.rows[0].processed_at) return;
          const p = ev.payload as Record<string, unknown>;
          if (ev.type === 'campaign.created') {
            const g = await generateTasks(tx, sys, ev.entity_id);   // 冪等：已建立過不會重複
            tasksCreated += g.created;
            const c = (await tx.query('SELECT owner_user_id, title FROM campaigns WHERE id=$1', [ev.entity_id])).rows[0];
            if (c?.owner_user_id) await queueNotification(tx, orgId, { recipientUserId: c.owner_user_id, subject: '已建立新檔期', body: `${c.title}（${ev.entity_id}）已依標準流程產生任務`, entityType: 'campaign', entityId: ev.entity_id, dedupeKey: `ev:${ev.id}` });
          } else if (ev.type === 'campaign.dates_changed') {
            const rows = await tx.query(`SELECT DISTINCT assignee_user_id AS u FROM tasks WHERE campaign_id=$1 AND assignee_user_id IS NOT NULL AND status NOT IN ('DONE','SKIPPED','CANCELLED')
              UNION SELECT owner_user_id FROM campaigns WHERE id=$1 AND owner_user_id IS NOT NULL`, [ev.entity_id]);
            for (const r of rows.rows) await queueNotification(tx, orgId, { recipientUserId: r.u, subject: '檔期日期已調整', body: `檔期 ${ev.entity_id} 的日期變更，請查看任務最新排程（${(p['changes'] as string[] | undefined)?.join('、') ?? ''}）`, entityType: 'campaign', entityId: ev.entity_id, dedupeKey: `ev:${ev.id}:${r.u}` });
          } else if (ev.type === 'approval.requested') {
            const gate = String(p['gate']);
            const roles = gate === 'G4' ? ['SYSTEM_ADMIN', 'FINANCE'] : gate === 'G3' ? ['SYSTEM_ADMIN', 'OPS_MANAGER', 'FINANCE'] : ['SYSTEM_ADMIN', 'OPS_MANAGER'];
            const us = await tx.query(`SELECT id FROM users WHERE organization_id=$1 AND role_key = ANY($2::text[]) AND status='ACTIVE' AND deleted_at IS NULL`, [orgId, roles]);
            for (const u of us.rows) await queueNotification(tx, orgId, { recipientUserId: u.id, subject: `${gate} 待核准`, body: `檔期 ${p['campaignId']} 申請 ${gate} 核准`, entityType: 'approval', entityId: ev.entity_id, dedupeKey: `ev:${ev.id}:${u.id}` });
          } else if (ev.type === 'campaign.status_changed') {
            const c = (await tx.query('SELECT owner_user_id, title FROM campaigns WHERE id=$1', [ev.entity_id])).rows[0];
            if (c?.owner_user_id) await queueNotification(tx, orgId, { recipientUserId: c.owner_user_id, subject: '檔期狀態變更', body: `${c.title}：${p['from']} → ${p['to']}`, entityType: 'campaign', entityId: ev.entity_id, dedupeKey: `ev:${ev.id}` });
          } else if (ev.type === 'import.completed' && Number(p['errors']) > 0) {
            for (const m of await managersOf(orgId)) await queueNotification(tx, orgId, { recipientUserId: m, subject: '訂單匯入有錯誤列', body: `批次 ${ev.entity_id} 有 ${p['errors']} 筆錯誤待處理`, entityType: 'import_batch', entityId: ev.entity_id, dedupeKey: `ev:${ev.id}:${m}` });
          }
          await tx.query(`UPDATE events SET processed_at=now(), attempts=attempts+1 WHERE id=$1`, [ev.id]);
          handled++;
        });
      } catch (e) {
        failed++;
        await query(`UPDATE events SET attempts=attempts+1, last_error=$2 WHERE id=$1`, [ev.id, String((e as Error).message).slice(0, 300)]);
      }
    }
    return { handled, failed, tasksCreated };
  },

  // ---- 新廠商進件 ----
  async vendor_intake(orgId) {
    return { ...(await processIntake(orgId)) };
  },

  // ---- 試用回饋與任務催辦 ----
  async task_reminders(orgId, now) {
    const today = todayTaipei(now);
    const soon = addDays(today, 1);
    const rows = await query(
      `SELECT t.id, t.name, t.step_key, t.owner_role, t.planned_end, t.campaign_id, c.title, c.owner_user_id
       FROM tasks t JOIN campaigns c ON c.id=t.campaign_id
       WHERE t.organization_id=$1 AND c.deleted_at IS NULL AND c.status NOT IN ('CANCELLED','ON_HOLD','CLOSED','DRAFT')
         AND t.status IN ('TODO','IN_PROGRESS','BLOCKED') AND t.kind='TASK' AND t.owner_role IN ('HOST','VENDOR') AND t.planned_end <= $2::date`, [orgId, soon]);
    let reminders = 0, noResponse = 0;
    for (const t of rows) {
      const late = Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${t.planned_end}T00:00:00Z`)) / 86_400_000));
      const subject = late > 0 ? `任務已逾期 ${late} 天：${t.name}` : `任務即將到期：${t.name}`;
      const recipients = new Set<string>();
      if (t.owner_user_id) recipients.add(t.owner_user_id);
      if (t.owner_role === 'HOST') {
        const hs = await query<{ host_id: string }>(`SELECT host_id FROM campaign_hosts WHERE campaign_id=$1 AND deleted_at IS NULL AND status<>'DECLINED'`, [t.campaign_id]);
        for (const h of hs) for (const u of await hostUsers(h.host_id)) recipients.add(u);
      }
      for (const u of recipients) if (await queueNotification(pool(), orgId, { recipientUserId: u, subject, body: `${t.title}（${t.campaign_id}），預計完成日 ${t.planned_end}`, entityType: 'task', entityId: t.id, dedupeKey: `reminder:${t.id}:${today}:${u}` })) reminders++;

      // 團主未回覆：試用回饋逾期，仍未確認／婉拒的團主標為 NO_RESPONSE 並開例外
      if (t.step_key === 'TRIAL_FEEDBACK' && late > 0) {
        const hs = await query(`SELECT ch.id, ch.host_id, h.display_name FROM campaign_hosts ch JOIN hosts h ON h.id=ch.host_id WHERE ch.campaign_id=$1 AND ch.deleted_at IS NULL AND ch.status IN ('INVITED','NO_RESPONSE')`, [t.campaign_id]);
        for (const h of hs) {
          await query(`UPDATE campaign_hosts SET status='NO_RESPONSE' WHERE id=$1 AND status='INVITED'`, [h.id]);
          const created = await openException(orgId, { type: 'HOST_NO_RESPONSE', severity: late >= HIGH_AFTER_LATE_DAYS ? 'HIGH' : 'MEDIUM', entityType: 'campaign_host', entityId: h.id, campaignId: t.campaign_id,
            title: `團主未回覆試用結果：${h.display_name}`, detail: `「${t.name}」已逾期 ${late} 天，整條排程可能停住`, ownerUserId: t.owner_user_id, dedupeKey: `host_no_response:${t.campaign_id}:${h.host_id}` });
          if (created) noResponse++;
        }
      }
    }
    return { candidates: rows.length, reminders, noResponse };
  },

  // ---- 逾期異常偵測 ----
  async overdue_detection(orgId, now) {
    const today = todayTaipei(now);
    const rows = await query(
      `SELECT t.id, t.name, t.campaign_id, t.planned_end, t.owner_role, c.title, c.owner_user_id
       FROM tasks t JOIN campaigns c ON c.id=t.campaign_id
       WHERE t.organization_id=$1 AND c.deleted_at IS NULL AND c.status NOT IN ('CANCELLED','ON_HOLD','CLOSED')
         AND t.status IN ('TODO','IN_PROGRESS','BLOCKED','WAITING_APPROVAL') AND t.planned_end < $2::date`, [orgId, today]);
    let opened = 0;
    for (const t of rows) {
      const late = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${t.planned_end}T00:00:00Z`)) / 86_400_000);
      const created = await openException(orgId, { type: 'TASK_OVERDUE', severity: late >= HIGH_AFTER_LATE_DAYS ? 'HIGH' : 'MEDIUM', entityType: 'task', entityId: t.id, campaignId: t.campaign_id,
        title: `任務逾期：${t.name}`, detail: `${t.title}（${t.campaign_id}）預計 ${t.planned_end} 完成，已逾期 ${late} 天；負責角色 ${ROLE_LABEL[t.owner_role as RoleKey] ?? t.owner_role}`, ownerUserId: t.owner_user_id, dedupeKey: `task_overdue:${t.id}` });
      if (created) opened++;
      await query(`UPDATE tasks SET overdue_flagged_at=COALESCE(overdue_flagged_at, now()) WHERE id=$1`, [t.id]);
    }
    // 日期被調整後不再逾期的，自動結案
    const resolved = await query(
      `UPDATE exceptions e SET status='RESOLVED', resolved_at=now(), resolution_note='任務已不再逾期', version=version+1
       WHERE e.organization_id=$1 AND e.type='TASK_OVERDUE' AND e.status<>'RESOLVED'
         AND EXISTS (SELECT 1 FROM tasks t WHERE t.id=e.entity_id AND (t.status IN ('DONE','SKIPPED','CANCELLED') OR t.planned_end >= $2::date)) RETURNING e.id`, [orgId, today]);
    return { overdueTasks: rows.length, opened, resolved: resolved.length };
  },

  // ---- 開團前檢查 ----
  async prelaunch_check(orgId, now) {
    const today = todayTaipei(now);
    const camps = await query(
      `SELECT id, title, open_date, owner_user_id FROM campaigns WHERE organization_id=$1 AND deleted_at IS NULL AND status='SCHEDULED'
         AND open_date BETWEEN $2::date AND $3::date`, [orgId, today, addDays(today, 3)]);
    let failing = 0, passing = 0;
    for (const c of camps) {
      const checks = await runGateChecks(pool(), orgId, c.id, 'G2');
      const bad = checks.filter((x) => x.level === 'BLOCK' && !x.ok);
      const key = `prelaunch:${c.id}`;
      if (bad.length) {
        failing++;
        const created = await openException(orgId, { type: 'PRELAUNCH_CHECK_FAILED', severity: 'HIGH', entityType: 'campaign', entityId: c.id, campaignId: c.id,
          title: `開團前檢查未通過：${c.title}`, detail: bad.map((b) => `${b.label}${b.detail ? `（${b.detail}）` : ''}`).join('；'), ownerUserId: c.owner_user_id, dedupeKey: key });
        if (created && c.owner_user_id) await queueNotification(pool(), orgId, { recipientUserId: c.owner_user_id, subject: `開團前檢查未通過：${c.title}`, body: `${c.open_date} 開團，未通過項目：${bad.map((b) => b.label).join('、')}`, entityType: 'campaign', entityId: c.id, dedupeKey: `${key}:${today}` });
      } else {
        passing++;
        await query(`UPDATE exceptions SET status='RESOLVED', resolved_at=now(), resolution_note='檢查已通過' WHERE organization_id=$1 AND dedupe_key=$2 AND status<>'RESOLVED'`, [orgId, key]);
      }
    }
    return { checked: camps.length, failing, passing };
  },

  // ---- 開團／結團狀態推進、結團後作業 ----
  async campaign_status_progress(orgId, now) {
    const today = todayTaipei(now);
    const sys = systemActor(orgId, 'WORKER', 'job:campaign_status_progress');
    let started = 0, closed = 0, followups = 0, errors = 0;
    const toStart = await query(`SELECT id FROM campaigns WHERE organization_id=$1 AND deleted_at IS NULL AND status='SCHEDULED' AND open_date <= $2::date`, [orgId, today]);
    for (const c of toStart) {
      try { await transitionCampaign(sys, c.id, 'RUNNING', { reason: '到達開團日，系統自動推進' }); started++; } catch { errors++; }
    }
    const toClose = await query(`SELECT id, title, owner_user_id FROM campaigns WHERE organization_id=$1 AND deleted_at IS NULL AND status='RUNNING' AND close_date < $2::date`, [orgId, today]);
    for (const c of toClose) {
      try {
        await transitionCampaign(sys, c.id, 'PENDING_CLOSE_CHECK', { reason: '已過結團日，系統自動推進' });
        closed++;
        await withTx(async (tx) => { await generateTasks(tx, sys, c.id); });   // 確保結團後作業都在（冪等）
        for (const u of [c.owner_user_id, ...(await managersOf(orgId))].filter(Boolean) as string[]) {
          if (await queueNotification(pool(), orgId, { recipientUserId: u, subject: `已結團，請進行結單確認：${c.title}`, body: `檔期 ${c.id} 已過結團日，請核對訂單並申請 G3 結單確認`, entityType: 'campaign', entityId: c.id, dedupeKey: `closed:${c.id}:${u}` })) followups++;
        }
      } catch { errors++; }
    }
    return { started, closed, followups, errors };
  },

  // ---- 每日營運摘要資料 ----
  async daily_summary(orgId, now) {
    const today = todayTaipei(now);
    const q1 = async (sql: string, p: unknown[] = [orgId]) => (await query<{ n: number }>(sql, p))[0].n;
    const metrics = {
      date: today,
      runningCampaigns: await q1(`SELECT count(*)::int AS n FROM campaigns WHERE organization_id=$1 AND deleted_at IS NULL AND status='RUNNING'`),
      scheduledCampaigns: await q1(`SELECT count(*)::int AS n FROM campaigns WHERE organization_id=$1 AND deleted_at IS NULL AND status='SCHEDULED'`),
      opensNext7Days: await q1(`SELECT count(*)::int AS n FROM campaigns WHERE organization_id=$1 AND deleted_at IS NULL AND status NOT IN ('CANCELLED','CLOSED') AND open_date BETWEEN $2::date AND $3::date`, [orgId, today, addDays(today, 7)]),
      closesNext7Days: await q1(`SELECT count(*)::int AS n FROM campaigns WHERE organization_id=$1 AND deleted_at IS NULL AND status NOT IN ('CANCELLED','CLOSED') AND close_date BETWEEN $2::date AND $3::date`, [orgId, today, addDays(today, 7)]),
      openTasks: await q1(`SELECT count(*)::int AS n FROM tasks t JOIN campaigns c ON c.id=t.campaign_id WHERE t.organization_id=$1 AND c.status NOT IN ('CANCELLED','ON_HOLD','CLOSED') AND t.status IN ('TODO','IN_PROGRESS','BLOCKED','WAITING_APPROVAL')`),
      overdueTasks: await q1(`SELECT count(*)::int AS n FROM tasks t JOIN campaigns c ON c.id=t.campaign_id WHERE t.organization_id=$1 AND c.status NOT IN ('CANCELLED','ON_HOLD','CLOSED') AND t.status IN ('TODO','IN_PROGRESS','BLOCKED','WAITING_APPROVAL') AND t.planned_end < $2::date`, [orgId, today]),
      pendingApprovals: await q1(`SELECT count(*)::int AS n FROM approvals WHERE organization_id=$1 AND status='PENDING'`),
      openExceptions: await q1(`SELECT count(*)::int AS n FROM exceptions WHERE organization_id=$1 AND status<>'RESOLVED'`),
      openImportErrors: await q1(`SELECT count(*)::int AS n FROM import_errors WHERE organization_id=$1 AND status='OPEN'`),
    };
    const ins = await query(`INSERT INTO daily_summaries (organization_id, summary_date, metrics) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING summary_date`, [orgId, today, JSON.stringify(metrics)]);
    let queued = 0;
    if (ins.length) {
      const text = `進行中 ${metrics.runningCampaigns}／已排程 ${metrics.scheduledCampaigns}／未來7天開團 ${metrics.opensNext7Days}、結團 ${metrics.closesNext7Days}／逾期任務 ${metrics.overdueTasks}／待核准 ${metrics.pendingApprovals}／未結例外 ${metrics.openExceptions}`;
      for (const m of await managersOf(orgId)) if (await queueNotification(pool(), orgId, { channel: 'EMAIL', recipientUserId: m, subject: `每日營運摘要 ${today}`, body: text, dedupeKey: `daily:${today}:${m}` })) queued++;
    }
    // 順手清除過期的重複送出保護紀錄（K6）；與摘要同一個每日工作，同樣預設停用
    const idempotencyKeysPurged = await purgeExpiredIdempotencyKeys(orgId, now);
    return { ...metrics, created: ins.length > 0, queuedEmails: queued, idempotencyKeysPurged };
  },

  // ---- 通知派送 ----
  async notification_dispatch(orgId, _now, opts) {
    const r = await dispatchNotifications(orgId, opts.adapter ?? getAdapter());
    return { ...r };
  },
};

export async function listExceptions(actor: Actor, q: URLSearchParams) {
  requirePerm(actor, 'exception.read');
  const status = q.get('status') ?? 'OPEN';
  const params: unknown[] = [actor.orgId]; const where = ['e.organization_id=$1'];
  if (status === 'OPEN') where.push(`e.status<>'RESOLVED'`); else if (status !== 'ALL') { params.push(status); where.push(`e.status=$${params.length}`); }
  const sev = q.get('severity'); if (sev) { params.push(sev); where.push(`e.severity=$${params.length}`); }
  // 資料範圍：編輯者只看自己負責檔期的例外
  if (actor.role === 'OPS_EDITOR') { params.push(actor.userId); where.push(`(e.campaign_id IS NULL OR EXISTS (SELECT 1 FROM campaigns c WHERE c.id=e.campaign_id AND (c.owner_user_id=$${params.length})))`); }
  return camelize(await query(
    `SELECT e.*, c.title AS campaign_title FROM exceptions e LEFT JOIN campaigns c ON c.id=e.campaign_id WHERE ${where.join(' AND ')}
     ORDER BY CASE e.severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, e.detected_at DESC LIMIT 200`, params));
}

export async function setExceptionStatus(actor: Actor, id: string, status: 'ACKNOWLEDGED' | 'RESOLVED', note: string) {
  requirePerm(actor, 'exception.manage');
  if (!note?.trim()) throw validation('請填寫處理說明');
  return withTx(async (tx) => {
    const r = await tx.query(`UPDATE exceptions SET status=$3, resolved_at=CASE WHEN $3='RESOLVED' THEN now() END, resolved_by=CASE WHEN $3='RESOLVED' THEN $4 END, resolution_note=$5
      WHERE id=$1 AND organization_id=$2 AND status<>'RESOLVED' RETURNING campaign_id`, [id, actor.orgId, status, actor.userId, note]);
    if (!r.rowCount) throw new AppError('NOT_FOUND', '找不到未結的例外');
    await audit(tx, actor, { action: `exception.${status.toLowerCase()}`, entityType: 'exception', entityId: id, campaignId: r.rows[0].campaign_id, after: { status }, reason: note });
    return { id, status };
  });
}
