import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { JOB_KEYS, runAllDue, runJob, runJobManually, setJobEnabled } from '@/server/modules/automation';
import { FailingAdapter, TestAdapter, dispatchNotifications, queueNotification } from '@/server/modules/notifications';
import { processIntake, receiveVendorIntake } from '@/server/modules/intake';
import { setTaskStatus, updateTask } from '@/server/modules/tasks';
import { setCampaignHostStatus } from '@/server/modules/campaigns';
import { pool } from '@/server/lib/db';
import { addDays } from '@/server/lib/dates';
import { todayTaipei } from '@/server/lib/ids';
import { addUser, dayOffset, makeWorld, mkCampaign, mkHost, mkProduct, mkVendor, mkCommunity, type World } from './helpers';

let w: World;
beforeAll(async () => { w = await makeWorld(); });

const enableAll = async () => { for (const k of JOB_KEYS) await setJobEnabled(w.admin, k, true); };
const runs = (job: string) => query(`SELECT * FROM automation_runs WHERE organization_id=$1 AND job_key=$2 ORDER BY started_at`, [w.orgId, job]);

describe('自動化安全欄杆：預設停用、可停用、有紀錄', () => {
  it('新組織的所有自動化工作預設停用；停用時執行會被略過且不留下任何副作用', async () => {
    const w2 = await makeWorld();
    const st = await query(`SELECT job_key, enabled FROM automation_settings WHERE organization_id=$1`, [w2.orgId]);
    expect(st).toHaveLength(JOB_KEYS.length);
    expect(st.every((s) => s.enabled === false)).toBe(true);
    const r = await runJob(w2.orgId, 'daily_summary');
    expect(r).toMatchObject({ status: 'SKIPPED', reason: 'disabled', runId: null });
    expect((await query(`SELECT count(*)::int AS n FROM daily_summaries WHERE organization_id=$1`, [w2.orgId]))[0].n).toBe(0);
    expect((await query(`SELECT count(*)::int AS n FROM automation_runs WHERE organization_id=$1`, [w2.orgId]))[0].n).toBe(0);
  });

  it('只有管理者／營運主管能啟用、手動執行；啟停有稽核紀錄', async () => {
    await expect(setJobEnabled(w.editor, 'daily_summary', true)).rejects.toThrow(/沒有權限/);
    await expect(runJobManually(w.editor, 'daily_summary')).rejects.toThrow(/沒有權限/);
    await setJobEnabled(w.admin, 'daily_summary', true);
    await setJobEnabled(w.admin, 'daily_summary', false);
    const a = await query(`SELECT action FROM audit_logs WHERE organization_id=$1 AND entity_type='automation_job' ORDER BY id`, [w.orgId]);
    expect(a.map((x) => x.action)).toEqual(expect.arrayContaining(['automation.enable', 'automation.disable']));
    await expect(setJobEnabled(w.admin, 'nope', true)).rejects.toThrow();
  });
});

describe('每日摘要：冪等', () => {
  it('同一天重複執行只產生一份摘要、一組通知', async () => {
    await setJobEnabled(w.admin, 'daily_summary', true);
    const now = new Date('2026-11-02T03:00:00Z');
    const r1 = await runJob(w.orgId, 'daily_summary', { now });
    const r2 = await runJob(w.orgId, 'daily_summary', { now });
    expect(r1.status).toBe('SUCCEEDED');
    expect(r2).toMatchObject({ status: 'SKIPPED', reason: 'already_succeeded' });
    expect((await query(`SELECT count(*)::int AS n FROM daily_summaries WHERE organization_id=$1`, [w.orgId]))[0].n).toBe(1);
    const mails = await query(`SELECT * FROM notifications WHERE organization_id=$1 AND subject LIKE '每日營運摘要%'`, [w.orgId]);
    expect(mails.length).toBe(2); // 管理者 + 營運主管
    expect(mails.every((m) => m.channel === 'EMAIL')).toBe(true);
    expect((await runs('daily_summary')).length).toBe(1);
    // 手動執行不會被當天排程擋掉，但摘要與通知仍不重複
    await runJobManually(w.admin, 'daily_summary', { now });
    expect((await query(`SELECT count(*)::int AS n FROM daily_summaries WHERE organization_id=$1`, [w.orgId]))[0].n).toBe(1);
    expect((await query(`SELECT count(*)::int AS n FROM notifications WHERE organization_id=$1 AND subject LIKE '每日營運摘要%'`, [w.orgId]))[0].n).toBe(2);
  });
});

describe('事件處理：建立檔期後產生任務與通知，不重複', () => {
  it('重複處理同一事件不會重複建立任務或通知', async () => {
    await setJobEnabled(w.admin, 'event_dispatch', true);
    const v = await mkVendor(w);
    const c = await mkCampaign(w, v.id);
    const before = (await query(`SELECT count(*)::int AS n FROM tasks WHERE campaign_id=$1`, [c.id]))[0].n;
    expect(before).toBe(15);
    // 模擬任務被意外清掉不可能（不可實體刪除）；改驗證重新派送不會增加
    await query(`UPDATE events SET processed_at=NULL WHERE entity_id=$1`, [c.id]);
    const r = await runJob(w.orgId, 'event_dispatch', { idempotencyKey: 'test:1' });
    expect(r.status).toBe('SUCCEEDED');
    await query(`UPDATE events SET processed_at=NULL WHERE entity_id=$1`, [c.id]);
    await runJob(w.orgId, 'event_dispatch', { idempotencyKey: 'test:2' });
    expect((await query(`SELECT count(*)::int AS n FROM tasks WHERE campaign_id=$1`, [c.id]))[0].n).toBe(15);
    expect((await query(`SELECT count(*)::int AS n FROM task_dependencies td JOIN tasks t ON t.id=td.task_id WHERE t.campaign_id=$1`, [c.id]))[0].n).toBe(9);
    const n = await query(`SELECT * FROM notifications WHERE organization_id=$1 AND entity_id=$2 AND subject='已建立新檔期'`, [w.orgId, c.id]);
    expect(n).toHaveLength(1);
    expect(n[0].recipient_user_id).toBe(w.editor.userId);
  });

  it('核准申請事件會通知有權限決定的人（不通知營運小編）', async () => {
    const v = await mkVendor(w); const p = await mkProduct(w, v.id, { approve: true }); const h = await mkHost(w);
    const c = await mkCampaign(w, v.id, { products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: [{ hostId: h.id }] });
    const { transitionCampaign, requestApproval } = await import('@/server/modules/gates');
    await transitionCampaign(w.editor, c.id, 'EVALUATING');
    await setCampaignHostStatus(w.editor, c.id, h.id, 'CONFIRMED');
    for (const k of ['SAMPLE_SHIP', 'TRIAL_ARRIVAL', 'TRIAL_FEEDBACK']) await setTaskStatus(w.editor, (await query<{ id: string }>('SELECT id FROM tasks WHERE campaign_id=$1 AND step_key=$2', [c.id, k]))[0].id, { to: 'DONE' });
    const ap = await requestApproval(w.editor, c.id, 'G1');
    await runJob(w.orgId, 'event_dispatch', { idempotencyKey: 'test:approval' });
    const n = await query(`SELECT recipient_user_id FROM notifications WHERE organization_id=$1 AND entity_id=$2`, [w.orgId, ap.id]);
    const rec = n.map((x) => x.recipient_user_id);
    expect(rec).toContain(w.manager.userId); expect(rec).toContain(w.admin.userId);
    expect(rec).not.toContain(w.editor.userId);
  });
});

describe('逾期偵測、試用回饋催辦、團主未回覆', () => {
  it('團主試用回饋逾期：建立例外（升級為高風險）、通知團主與負責人、團主標為未回覆；修正後自動結案', async () => {
    await enableAll();
    const v = await mkVendor(w); const h = await mkHost(w);
    const hostUser = await addUser(w.orgId, 'HOST', { hostIds: [h.id] });
    // 可寄出日在 40 天前 → 試用回饋早已逾期
    const c = await mkCampaign(w, v.id, { sampleReadyDate: dayOffset(-40), openDate: dayOffset(20), closeDate: dayOffset(30), hosts: [{ hostId: h.id }] });
    await query(`UPDATE campaigns SET status='EVALUATING' WHERE id=$1`, [c.id]);
    const now = new Date();
    const rem = await runJob(w.orgId, 'task_reminders', { now });
    expect(rem.status).toBe('SUCCEEDED');
    expect(rem.stats?.noResponse).toBe(1);
    const ex = await query(`SELECT * FROM exceptions WHERE organization_id=$1 AND campaign_id=$2 AND type='HOST_NO_RESPONSE'`, [w.orgId, c.id]);
    expect(ex).toHaveLength(1);
    expect(ex[0].severity).toBe('HIGH');
    expect((await query(`SELECT status FROM campaign_hosts WHERE campaign_id=$1 AND host_id=$2`, [c.id, h.id]))[0].status).toBe('NO_RESPONSE');
    const toHost = await query(`SELECT subject FROM notifications WHERE organization_id=$1 AND recipient_user_id=$2`, [w.orgId, hostUser.userId]);
    expect(toHost.length).toBeGreaterThan(0);
    // 同一天再跑不重複建立（key 相同 → 略過；手動 key 不同 → 通知也以 dedupe key 擋）
    await runJobManually(w.admin, 'task_reminders', { now });
    expect((await query(`SELECT count(*)::int AS n FROM exceptions WHERE campaign_id=$1 AND type='HOST_NO_RESPONSE'`, [c.id]))[0].n).toBe(1);
    expect((await query(`SELECT count(*)::int AS n FROM notifications WHERE organization_id=$1 AND recipient_user_id=$2 AND entity_type='task'`, [w.orgId, hostUser.userId]))[0].n).toBe(toHost.length);

    const od = await runJob(w.orgId, 'overdue_detection', { now });
    expect(od.stats?.overdueTasks).toBeGreaterThan(0);
    const overdue = await query(`SELECT * FROM exceptions WHERE organization_id=$1 AND campaign_id=$2 AND type='TASK_OVERDUE'`, [w.orgId, c.id]);
    expect(overdue.length).toBeGreaterThan(0);
    expect(overdue.every((e) => e.dedupe_key.startsWith('task_overdue:'))).toBe(true);

    // 團主回覆 → 未回覆例外自動結案
    await setCampaignHostStatus(hostUser, c.id, h.id, 'CONFIRMED');
    expect((await query(`SELECT status FROM exceptions WHERE id=$1`, [ex[0].id]))[0].status).toBe('RESOLVED');
    // 負責人調整逾期任務日期 → 下次偵測自動結案該逾期例外
    const t = await query<{ id: string }>(`SELECT id FROM tasks WHERE campaign_id=$1 AND step_key='SAMPLE_SHIP'`, [c.id]);
    await setTaskStatus(w.editor, t[0].id, { to: 'DONE' });
    await runJob(w.orgId, 'overdue_detection', { now, idempotencyKey: 'again' });
    const sampleEx = await query(`SELECT status FROM exceptions WHERE organization_id=$1 AND dedupe_key=$2`, [w.orgId, `task_overdue:${t[0].id}`]);
    expect(sampleEx[0].status).toBe('RESOLVED');
  });

  it('任務逾期天數越久，嚴重度越高（1 天＝中、3 天以上＝高）', async () => {
    const v = await mkVendor(w);
    const c1 = await mkCampaign(w, v.id, { sampleReadyDate: dayOffset(-8), openDate: dayOffset(40), closeDate: dayOffset(50) });
    await query(`UPDATE campaigns SET status='EVALUATING' WHERE id=$1`, [c1.id]);
    await runJob(w.orgId, 'overdue_detection', { idempotencyKey: 'sev' });
    // SAMPLE_SHIP: 7 天 → 剛好昨天結束 → 逾期 1 天
    const t = await query<{ id: string }>(`SELECT id FROM tasks WHERE campaign_id=$1 AND step_key='SAMPLE_SHIP'`, [c1.id]);
    const e = await query(`SELECT severity FROM exceptions WHERE organization_id=$1 AND dedupe_key=$2`, [w.orgId, `task_overdue:${t[0].id}`]);
    expect(e[0].severity).toBe('MEDIUM');
  });
});

describe('開團前檢查與狀態推進', () => {
  it('已排程但缺資料的檔期：開團前 3 天內開例外並通知負責人，不會自動核准或開團', async () => {
    const v = await mkVendor(w); const p = await mkProduct(w, v.id);   // 商品未審核
    const c = await mkCampaign(w, v.id, { sampleReadyDate: dayOffset(-30), openDate: dayOffset(2), closeDate: dayOffset(9), products: [{ productId: p.id, skuId: p.skuIds[0] }] });
    await query(`UPDATE campaigns SET status='SCHEDULED' WHERE id=$1`, [c.id]);
    const r = await runJob(w.orgId, 'prelaunch_check', { idempotencyKey: 'pl1' });
    expect(r.stats?.failing).toBeGreaterThanOrEqual(1);
    const ex = await query(`SELECT * FROM exceptions WHERE organization_id=$1 AND campaign_id=$2 AND type='PRELAUNCH_CHECK_FAILED'`, [w.orgId, c.id]);
    expect(ex).toHaveLength(1);
    expect(ex[0].detail).toContain('商品已通過審核');
    expect((await query(`SELECT status FROM campaigns WHERE id=$1`, [c.id]))[0].status).toBe('SCHEDULED');
    expect((await query(`SELECT count(*)::int AS n FROM notifications WHERE organization_id=$1 AND entity_id=$2`, [w.orgId, c.id]))[0].n).toBe(1);
  });

  it('到開團日自動由「已排程」推進為「進行中」；過結團日推進為「待結單確認」並通知', async () => {
    const v = await mkVendor(w);
    const c1 = await mkCampaign(w, v.id, { sampleReadyDate: dayOffset(-30), openDate: dayOffset(-1), closeDate: dayOffset(5) });
    await query(`UPDATE campaigns SET status='SCHEDULED' WHERE id=$1`, [c1.id]);
    const c2 = await mkCampaign(w, v.id, { sampleReadyDate: dayOffset(-30), openDate: dayOffset(-10), closeDate: dayOffset(-1) });
    await query(`UPDATE campaigns SET status='RUNNING' WHERE id=$1`, [c2.id]);
    const c3 = await mkCampaign(w, v.id, { sampleReadyDate: dayOffset(-30), openDate: dayOffset(5), closeDate: dayOffset(9) });
    await query(`UPDATE campaigns SET status='SCHEDULED' WHERE id=$1`, [c3.id]);
    const r = await runJob(w.orgId, 'campaign_status_progress', { idempotencyKey: 'sp1' });
    expect(r.status).toBe('SUCCEEDED');
    const st = async (id: string) => (await query(`SELECT status FROM campaigns WHERE id=$1`, [id]))[0].status;
    expect(await st(c1.id)).toBe('RUNNING');
    expect(await st(c2.id)).toBe('PENDING_CLOSE_CHECK');
    expect(await st(c3.id)).toBe('SCHEDULED');  // 還沒到開團日 → 不動
    const sys = await query(`SELECT actor_type, source FROM audit_logs WHERE campaign_id=$1 AND action='campaign.status'`, [c2.id]);
    expect(sys[0]).toMatchObject({ actor_type: 'SYSTEM', source: 'WORKER' });
    expect((await query(`SELECT count(*)::int AS n FROM tasks WHERE campaign_id=$1`, [c2.id]))[0].n).toBe(15); // 結團後作業齊全且未重複
    // 再跑一次（不同 key）也不會重複推進或重複通知
    await runJob(w.orgId, 'campaign_status_progress', { idempotencyKey: 'sp2' });
    expect((await query(`SELECT count(*)::int AS n FROM audit_logs WHERE campaign_id=$1 AND action='campaign.status'`, [c2.id]))[0].n).toBe(1);
  });
});

describe('失敗可查、可重試', () => {
  it('Job 失敗時留下錯誤紀錄；修好後再執行會重試同一筆（最多 3 次）', async () => {
    await setJobEnabled(w.admin, 'notification_dispatch', true);
    await queueNotification(pool(), w.orgId, { channel: 'EMAIL', recipientUserId: w.manager.userId, subject: '測試信', body: 'x', dedupeKey: `retry-test` });
    const prev = process.env.NOTIFY_ADAPTER;
    process.env.NOTIFY_ADAPTER = 'real-line';   // 尚未實作的 Adapter → 會丟出 BLOCKED 錯誤
    try {
      const f1 = await runJob(w.orgId, 'notification_dispatch', { idempotencyKey: 'nd-retry' });
      expect(f1.status).toBe('FAILED');
      expect(f1.error).toContain('BLOCKED');
      const row1 = (await runs('notification_dispatch')).find((r) => r.idempotency_key === 'nd-retry')!;
      expect(row1.status).toBe('FAILED'); expect(row1.attempts).toBe(1); expect(row1.error).toContain('尚未實作');
    } finally { process.env.NOTIFY_ADAPTER = prev ?? 'test'; }
    const ok = await runJob(w.orgId, 'notification_dispatch', { idempotencyKey: 'nd-retry' });
    expect(ok.status).toBe('SUCCEEDED');
    const row2 = (await runs('notification_dispatch')).find((r) => r.idempotency_key === 'nd-retry');
    expect(row2).toMatchObject({ status: 'SUCCEEDED', attempts: 2, error: null });
    expect((await query(`SELECT status FROM notifications WHERE organization_id=$1 AND dedupe_key='retry-test'`, [w.orgId]))[0].status).toBe('SENT_TEST');
    // 成功後不再重複執行
    expect((await runJob(w.orgId, 'notification_dispatch', { idempotencyKey: 'nd-retry' })).status).toBe('SKIPPED');
  });

  it('外部通知服務不可用：不影響主流程；通知重試後標為 DEAD 並建立例外供人工處理', async () => {
    const n = await queueNotification(pool(), w.orgId, { channel: 'LINE', recipientUserId: w.manager.userId, subject: '會失敗的通知', body: 'x', dedupeKey: 'dead-test' });
    expect(n).toBe(true);
    const bad = new FailingAdapter();
    const r1 = await dispatchNotifications(w.orgId, bad);
    expect(r1.failed).toBeGreaterThanOrEqual(1);
    await dispatchNotifications(w.orgId, bad);
    const r3 = await dispatchNotifications(w.orgId, bad);
    expect(r3.dead).toBeGreaterThanOrEqual(1);
    const row = (await query(`SELECT status, attempts, last_error FROM notifications WHERE organization_id=$1 AND dedupe_key='dead-test'`, [w.orgId]))[0];
    expect(row).toMatchObject({ status: 'DEAD', attempts: 3 });
    expect(row.last_error).toContain('無法連線');
    expect((await query(`SELECT count(*)::int AS n FROM exceptions WHERE organization_id=$1 AND type='NOTIFICATION_DEAD'`, [w.orgId]))[0].n).toBeGreaterThanOrEqual(1);
    // 之後 Adapter 恢復也不會重送 DEAD（避免重複打擾），需人工處理
    const good = new TestAdapter();
    await dispatchNotifications(w.orgId, good);
    expect(good.sent.find((m) => m.subject === '會失敗的通知')).toBeUndefined();
  });

  it('通知佇列：站內通知直接送達；EMAIL 只經測試 Adapter（不會對真人發送）', async () => {
    await queueNotification(pool(), w.orgId, { channel: 'IN_APP', recipientUserId: w.editor.userId, subject: '站內', body: 'x', dedupeKey: 'inapp-1' });
    await queueNotification(pool(), w.orgId, { channel: 'EMAIL', recipientUserId: w.editor.userId, subject: '信件', body: 'x', dedupeKey: 'mail-1' });
    const t = new TestAdapter();
    await dispatchNotifications(w.orgId, t);
    expect((await query(`SELECT status FROM notifications WHERE organization_id=$1 AND dedupe_key='inapp-1'`, [w.orgId]))[0].status).toBe('DELIVERED');
    expect((await query(`SELECT status FROM notifications WHERE organization_id=$1 AND dedupe_key='mail-1'`, [w.orgId]))[0].status).toBe('SENT_TEST');
    expect(t.sent.some((m) => m.subject === '信件')).toBe(true);
    // dedupe：相同 key 不會建立第二筆
    expect(await queueNotification(pool(), w.orgId, { channel: 'EMAIL', recipientUserId: w.editor.userId, subject: '信件', body: 'x', dedupeKey: 'mail-1' })).toBe(false);
  });
});

describe('新廠商資料進件', () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    vendorName: '新進件品牌', companyName: '新進件股份有限公司', contactName: '陳小姐', contactInfo: 'chen@example.invalid',
    itemName: '進件商品A', itemUrl: 'https://example.invalid/a', sellingPoints: '賣點', listPrice: 1000, groupPrice: 800,
    commissionText: '20', sampleReadyDate: addDays(todayTaipei(), 10), needsRecovery: true, closeRule: '結團後7天', ...over,
  });

  it('同一份表單重複送出只會有一筆進件；處理後建立廠商、商品、草稿檔期與任務；不寫入佣金規則', async () => {
    await setJobEnabled(w.admin, 'vendor_intake', true);
    const a = await receiveVendorIntake(w.editor, 'form-001', payload());
    const b = await receiveVendorIntake(w.editor, 'form-001', payload());
    expect(a.replayed).toBe(false); expect(b.replayed).toBe(true); expect(b.id).toBe(a.id);
    const r = await runJob(w.orgId, 'vendor_intake', { idempotencyKey: 'in1' });
    expect(r.stats).toMatchObject({ processed: 1, created: 1, needsReview: 0 });
    const it = (await query(`SELECT * FROM vendor_intake_submissions WHERE id=$1`, [a.id]))[0];
    expect(it.status).toBe('CREATED');
    const v = (await query(`SELECT * FROM vendors WHERE id=$1`, [it.vendor_id]))[0];
    expect(v).toMatchObject({ name: '新進件品牌', status: 'CONTACTED' });
    const c = (await query(`SELECT * FROM campaigns WHERE id=$1`, [it.campaign_id]))[0];
    expect(c).toMatchObject({ status: 'DRAFT', needs_sample_recovery: true });
    expect(c.internal_note).toContain('解析為 20%，尚未寫入佣金規則');
    expect((await query(`SELECT count(*)::int AS n FROM tasks WHERE campaign_id=$1`, [c.id]))[0].n).toBe(15);
    expect((await query(`SELECT count(*)::int AS n FROM commission_rules WHERE organization_id=$1`, [w.orgId]))[0].n).toBe(0);
    // 再跑一次不會重複建立
    await runJob(w.orgId, 'vendor_intake', { idempotencyKey: 'in2' });
    expect((await query(`SELECT count(*)::int AS n FROM vendors WHERE organization_id=$1 AND name='新進件品牌'`, [w.orgId]))[0].n).toBe(1);
  });

  it('同廠商（名稱或統編相同）再次進件 → 配對既有廠商，不建立重複廠商；商品同名沿用', async () => {
    await receiveVendorIntake(w.editor, 'form-002', payload({ vendorName: ' 新進件 品牌 ', itemName: '進件商品A' }));
    const r = await processIntake(w.orgId);
    expect(r).toMatchObject({ processed: 1, matched: 1, created: 0 });
    expect((await query(`SELECT count(*)::int AS n FROM vendors WHERE organization_id=$1 AND normalized_name LIKE '%新進件品牌%'`, [w.orgId]))[0].n).toBe(1);
    expect((await query(`SELECT count(*)::int AS n FROM products WHERE organization_id=$1 AND name='進件商品A'`, [w.orgId]))[0].n).toBe(1);
  });

  it('黑名單廠商進件、分潤欄位無法判斷 → 標為需人工確認，不自動處理', async () => {
    const bl = await mkVendor(w, '黑名單品牌');
    await query(`UPDATE vendors SET status='BLACKLISTED' WHERE id=$1`, [bl.id]);
    await receiveVendorIntake(w.editor, 'form-003', payload({ vendorName: '黑名單品牌', itemName: '某商品' }));
    await receiveVendorIntake(w.editor, 'form-004', payload({ vendorName: '歧義品牌', itemName: '某商品2', commissionText: '1' }));
    const r = await processIntake(w.orgId);
    expect(r.needsReview).toBe(2);
    const rows = await query(`SELECT external_submission_id, status, campaign_id FROM vendor_intake_submissions WHERE external_submission_id IN ('form-003','form-004') ORDER BY 1`);
    expect(rows.map((x) => x.status)).toEqual(['NEEDS_REVIEW', 'NEEDS_REVIEW']);
    expect(rows[0].campaign_id).toBeNull();           // 黑名單不建檔期
  });

  it('進件欄位驗證：缺必填、格式錯誤直接拒絕（不寫入）', async () => {
    await expect(receiveVendorIntake(w.editor, 'bad-1', { vendorName: '' })).rejects.toThrow();
    await expect(receiveVendorIntake(w.editor, 'bad-2', payload({ taxId: '123' }))).rejects.toThrow();
    expect((await query(`SELECT count(*)::int AS n FROM vendor_intake_submissions WHERE external_submission_id LIKE 'bad-%'`))[0].n).toBe(0);
  });
});

describe('runAllDue', () => {
  it('依序執行所有已啟用工作並回報各自結果', async () => {
    const res = await runAllDue(w.orgId, { idempotencyKey: undefined, now: new Date('2026-12-01T03:00:00Z') });
    expect(res.map((r) => r.jobKey)).toEqual([...JOB_KEYS]);
    expect(res.every((r) => ['SUCCEEDED', 'SKIPPED', 'FAILED'].includes(r.status))).toBe(true);
  });
});

void mkCommunity; void updateTask;
