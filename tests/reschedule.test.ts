import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { applyCampaignReschedule, previewCampaignReschedule } from '@/server/modules/campaigns';
import { setTaskStatus, updateTask } from '@/server/modules/tasks';
import { publishTemplateVersion, loadActiveTemplate } from '@/server/workflow/templates';
import { pool } from '@/server/lib/db';
import { dayOffset, makeWorld, mkCampaign, mkVendor, type World } from './helpers';

let w: World;
beforeAll(async () => { w = await makeWorld(); });

const tasks = async (cid: string) => Object.fromEntries((await query(`SELECT step_key, planned_start, planned_end, status, date_locked, schedule_issue FROM tasks WHERE campaign_id=$1`, [cid])).map((t) => [t.step_key, t]));

describe('日期變更：先預覽，確認才套用', () => {
  it('預覽不會改任何資料；套用必須帶預覽代碼，且代碼與目前狀態一致', async () => {
    const v = await mkVendor(w);
    const c = await mkCampaign(w, v.id, { sampleReadyDate: dayOffset(5), openDate: dayOffset(40), closeDate: dayOffset(50) });
    const before = await tasks(c.id);
    const pv = await previewCampaignReschedule(w.editor, c.id, { sampleReadyDate: dayOffset(9) });
    expect(pv.affectedCount).toBeGreaterThan(3);
    expect(pv.rows.find((r) => r.stepKey === 'SAMPLE_SHIP')).toMatchObject({ effect: 'changed', before: { start: dayOffset(5) }, after: { start: dayOffset(9) } });
    expect(await tasks(c.id)).toEqual(before);                                   // 預覽沒有副作用
    expect((await query(`SELECT sample_ready_date FROM campaigns WHERE id=$1`, [c.id]))[0].sample_ready_date).toBe(dayOffset(5));

    await expect(applyCampaignReschedule(w.editor, c.id, { sampleReadyDate: dayOffset(9) }, '')).rejects.toThrow(/預覽/);
    await expect(applyCampaignReschedule(w.editor, c.id, { sampleReadyDate: dayOffset(9) }, 'wrong-token')).rejects.toThrow(/重新預覽/);
    // 預覽後有人改了任務 → 代碼失效，必須重新預覽
    const t = await query<{ id: string }>(`SELECT id FROM tasks WHERE campaign_id=$1 AND step_key='SAMPLE_SHIP'`, [c.id]);
    await setTaskStatus(w.editor, t[0].id, { to: 'IN_PROGRESS' });
    await updateTask(w.editor, t[0].id, { plannedStart: dayOffset(6), plannedEnd: dayOffset(12), reason: '廠商說晚一天' });
    await expect(applyCampaignReschedule(w.editor, c.id, { sampleReadyDate: dayOffset(9) }, pv.token)).rejects.toThrow(/重新預覽/);
  });

  it('套用後：只更新未鎖定、未完成的任務；任務日期與預覽一致；稽核留有前後值', async () => {
    const v = await mkVendor(w);
    const c = await mkCampaign(w, v.id, { sampleReadyDate: dayOffset(5), openDate: dayOffset(40), closeDate: dayOffset(50) });
    // 人工鎖定「試用品到貨」的日期（需原因），之後排程連動不得覆寫
    const arrival = (await query<{ id: string }>(`SELECT id FROM tasks WHERE campaign_id=$1 AND step_key='TRIAL_ARRIVAL'`, [c.id]))[0].id;
    await expect(updateTask(w.editor, arrival, { plannedStart: dayOffset(13), plannedEnd: dayOffset(30) })).rejects.toThrow(/原因/);
    await updateTask(w.editor, arrival, { plannedStart: dayOffset(13), plannedEnd: dayOffset(30), reason: '案主出國，已與團主敲定' });
    const shipId = (await query<{ id: string }>(`SELECT id FROM tasks WHERE campaign_id=$1 AND step_key='SAMPLE_SHIP'`, [c.id]))[0].id;
    await setTaskStatus(w.editor, shipId, { to: 'DONE' });                          // 已完成的任務也不可被重排

    const change = { sampleReadyDate: dayOffset(8) };
    const pv = await previewCampaignReschedule(w.editor, c.id, change);
    const eff = Object.fromEntries(pv.rows.map((r) => [r.stepKey, r.effect]));
    expect(eff.SAMPLE_SHIP).toBe('done_untouched');
    expect(eff.TRIAL_ARRIVAL).toBe('unchanged');       // 前置已完成，不受影響
    const r = await applyCampaignReschedule(w.editor, c.id, change, pv.token);
    // 先前手動鎖定「試用品到貨」後，下游（試用回饋、G1、圖文）本來就該接在鎖定日期之後：這次重排一併連動
    expect(eff.TRIAL_FEEDBACK).toBe('changed');
    expect(r.updatedTasks).toBe(3);
    const t = await tasks(c.id);
    expect(t.TRIAL_FEEDBACK.planned_start).toBe(dayOffset(31));
    expect(t.TRIAL_ARRIVAL.planned_start).toBe(dayOffset(13));
    expect(t.TRIAL_ARRIVAL.date_locked).toBe(true);
    const aud = await query(`SELECT before_data, after_data, reason FROM audit_logs WHERE campaign_id=$1 AND action='campaign.reschedule'`, [c.id]);
    expect(aud[0].before_data.sampleReadyDate).toBe(dayOffset(5));
    expect(aud[0].after_data.sampleReadyDate).toBe(dayOffset(8));
  });

  it('延後開團日：開團錨點任務一併連動，已套用的新日期與預覽完全相同', async () => {
    const v = await mkVendor(w);
    const c = await mkCampaign(w, v.id, { sampleReadyDate: dayOffset(5), openDate: dayOffset(40), closeDate: dayOffset(50) });
    const change = { openDate: dayOffset(43), closeDate: dayOffset(53) };
    const pv = await previewCampaignReschedule(w.editor, c.id, change);
    await applyCampaignReschedule(w.editor, c.id, change, pv.token);
    const t = await tasks(c.id);
    for (const row of pv.rows) {
      expect(t[row.stepKey].planned_start, row.stepKey).toBe(row.after.start);
      expect(t[row.stepKey].planned_end, row.stepKey).toBe(row.after.end);
    }
    expect(t.LAUNCH.planned_start).toBe(dayOffset(43));
    expect(t.CLOSING_REMINDER.planned_start).toBe(dayOffset(52));
    expect(t.VENDOR_SETTLE.planned_start).toBe(dayOffset(54));
  });

  it('條件任務：加入 Live Talk 日期與回收需求後任務自動出現；移除後略過', async () => {
    const v = await mkVendor(w);
    const c = await mkCampaign(w, v.id);
    expect((await tasks(c.id)).LIVE_TALK.status).toBe('SKIPPED');
    const ch = { liveTalkDate: dayOffset(45), needsSampleRecovery: true };
    const pv = await previewCampaignReschedule(w.editor, c.id, ch);
    await applyCampaignReschedule(w.editor, c.id, ch, pv.token);
    let t = await tasks(c.id);
    expect(t.LIVE_TALK).toMatchObject({ status: 'TODO', planned_start: dayOffset(45) });
    expect(t.SAMPLE_RECOVERY.status).toBe('TODO');
    const off = { liveTalkDate: null, needsSampleRecovery: false };
    const pv2 = await previewCampaignReschedule(w.editor, c.id, off);
    await applyCampaignReschedule(w.editor, c.id, off, pv2.token);
    t = await tasks(c.id);
    expect(t.LIVE_TALK.status).toBe('SKIPPED'); expect(t.SAMPLE_RECOVERY.status).toBe('SKIPPED');
  });

  it('日期驗證：開團晚於結團、可寄出日不早於開團日、Live Talk 超出區間都被擋', async () => {
    const v = await mkVendor(w);
    const c = await mkCampaign(w, v.id);
    await expect(previewCampaignReschedule(w.editor, c.id, { openDate: dayOffset(60) })).rejects.toThrow(/開團日不可晚於結團日/);
    await expect(previewCampaignReschedule(w.editor, c.id, { sampleReadyDate: dayOffset(41) })).rejects.toThrow(/可寄出日必須早於開團日/);
    await expect(previewCampaignReschedule(w.editor, c.id, { liveTalkDate: dayOffset(60) })).rejects.toThrow(/Live Talk/);
    await expect(previewCampaignReschedule(w.editor, c.id, { openDate: '2026-02-30' })).rejects.toThrow();
    await expect(previewCampaignReschedule(w.editor, c.id, { params: { ship_days: 0 } })).rejects.toThrow();
    await expect(previewCampaignReschedule(w.editor, c.id, { params: { not_a_param: 3 } })).rejects.toThrow(/未知/);
  });
});

describe('已排程／進行中的檔期：不得未經核准就改日期', () => {
  it('已排程：必須填原因，且只有營運主管／管理者可以；進行中不可改開團日', async () => {
    const v = await mkVendor(w);
    const c = await mkCampaign(w, v.id, { sampleReadyDate: dayOffset(-30), openDate: dayOffset(10), closeDate: dayOffset(20) });
    await query(`UPDATE campaigns SET status='SCHEDULED' WHERE id=$1`, [c.id]);
    const ch = { closeDate: dayOffset(25) };
    const pv = await previewCampaignReschedule(w.editor, c.id, ch);
    expect(pv.requiresReason).toBe(true);
    await expect(applyCampaignReschedule(w.editor, c.id, ch, pv.token)).rejects.toThrow(/原因/);
    await expect(applyCampaignReschedule(w.editor, c.id, { ...ch, reason: '廠商要求延長' }, (await previewCampaignReschedule(w.editor, c.id, { ...ch, reason: '廠商要求延長' })).token)).rejects.toThrow(/只有營運主管/);
    const pv2 = await previewCampaignReschedule(w.manager, c.id, { ...ch, reason: '廠商要求延長' });
    await applyCampaignReschedule(w.manager, c.id, { ...ch, reason: '廠商要求延長' }, pv2.token);
    expect((await query(`SELECT close_date FROM campaigns WHERE id=$1`, [c.id]))[0].close_date).toBe(dayOffset(25));
    // 核准後調整日期 → 留下例外供追蹤
    expect((await query(`SELECT count(*)::int AS n FROM exceptions WHERE campaign_id=$1 AND type='SCHEDULE_CHANGED_AFTER_APPROVAL'`, [c.id]))[0].n).toBe(1);

    await query(`UPDATE campaigns SET status='RUNNING' WHERE id=$1`, [c.id]);
    await expect(previewCampaignReschedule(w.manager, c.id, { openDate: dayOffset(11) })).rejects.toThrow(/不可更改開團日/);
  });

  it('已取消／已結案的檔期不可調整日期', async () => {
    const v = await mkVendor(w);
    const c = await mkCampaign(w, v.id);
    await query(`UPDATE campaigns SET status='CANCELLED' WHERE id=$1`, [c.id]);
    await expect(previewCampaignReschedule(w.manager, c.id, { closeDate: dayOffset(60) })).rejects.toThrow(/不可調整/);
  });
});

describe('修改預設天數不會默默覆寫既有檔期', () => {
  it('發佈新版模板後，既有檔期仍使用建立當下的參數與日期；新檔期才使用新參數；要套用需逐檔預覽確認', async () => {
    const w2 = await makeWorld();
    const v = await mkVendor(w2);
    const oldC = await mkCampaign(w2, v.id, { sampleReadyDate: dayOffset(5) });
    const oldTasks = await tasks(oldC.id);
    const pub = await publishTemplateVersion(pool(), w2.admin, 'GROUPBUY_STANDARD', { trial_days: 30 });
    expect(pub.version).toBe(2);
    const active = await loadActiveTemplate(pool(), w2.orgId);
    expect(active.params.trial_days).toBe(30);
    expect(await tasks(oldC.id)).toEqual(oldTasks);                                // 既有檔期完全不動
    expect((await query(`SELECT workflow_template_version, workflow_params FROM campaigns WHERE id=$1`, [oldC.id]))[0]).toMatchObject({ workflow_template_version: 1, workflow_params: { trial_days: 14 } });
    const newC = await mkCampaign(w2, v.id, { sampleReadyDate: dayOffset(5) });
    const nt = await tasks(newC.id);
    expect(nt.TRIAL_ARRIVAL.planned_end).toBe(dayOffset(12 + 29));                 // 新檔期使用 30 天
    expect(oldTasks.TRIAL_ARRIVAL.planned_end).toBe(dayOffset(12 + 13));
    // 舊檔期要採用新天數：逐檔預覽 → 確認
    const pv = await previewCampaignReschedule(w2.editor, oldC.id, { params: { trial_days: 30 } });
    expect(pv.rows.find((r) => r.stepKey === 'TRIAL_ARRIVAL')?.effect).toBe('changed');
    await applyCampaignReschedule(w2.editor, oldC.id, { params: { trial_days: 30 } }, pv.token);
    expect((await tasks(oldC.id)).TRIAL_ARRIVAL.planned_end).toBe(dayOffset(12 + 29));
    // 參數不合法被擋
    await expect(publishTemplateVersion(pool(), w2.admin, 'GROUPBUY_STANDARD', { trial_days: -1 })).rejects.toThrow();
    await expect(publishTemplateVersion(pool(), w2.admin, 'GROUPBUY_STANDARD', { bogus: 3 })).rejects.toThrow(/未知/);
  });
});
