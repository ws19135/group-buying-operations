import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { addCampaignHost, addPlacement, getCampaign, setCampaignHostStatus } from '@/server/modules/campaigns';
import { cancelCampaign, decideApproval, gateCheck, holdCampaign, requestApproval, resumeCampaign, transitionCampaign } from '@/server/modules/gates';
import { setTaskStatus } from '@/server/modules/tasks';
import { linkHostCommunity } from '@/server/modules/hosts';
import type { Actor } from '@/server/lib/permissions';
import { addUser, dayOffset, makeWorld, mkCampaign, mkCommunity, mkHost, mkProduct, mkVendor, type World } from './helpers';

let w: World;
beforeAll(async () => { w = await makeWorld(); });

async function status(id: string) { return (await query<{ status: string }>('SELECT status FROM campaigns WHERE id=$1', [id]))[0].status; }
async function taskId(cid: string, key: string) { return (await query<{ id: string }>('SELECT id FROM tasks WHERE campaign_id=$1 AND step_key=$2', [cid, key]))[0].id; }
async function done(actor: Actor, cid: string, key: string) { return setTaskStatus(actor, await taskId(cid, key), { to: 'DONE' }); }

async function fixture(opts: { open?: number; close?: number; sample?: number } = {}) {
  const v = await mkVendor(w);
  const p = await mkProduct(w, v.id, { approve: true });
  const h = await mkHost(w);
  const c = await mkCommunity(w, [h.id]);
  const r = await mkCampaign(w, v.id, {
    sampleReadyDate: dayOffset(opts.sample ?? 1), openDate: dayOffset(opts.open ?? 20), closeDate: dayOffset(opts.close ?? 30),
    products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: [{ hostId: h.id }],
  });
  return { id: r.id, v, p, h, c };
}

describe('完整生命週期：草稿 → 結案（含 G1–G5）', () => {
  it('每個關卡都必須先通過系統檢查，再由有權限的角色核准；每一步有稽核紀錄', async () => {
    const f = await fixture();
    const id = f.id;
    expect(await status(id)).toBe('DRAFT');

    // DRAFT → EVALUATING
    await transitionCampaign(w.editor, id, 'EVALUATING');

    // G1：還沒有團主確認、前置任務沒完成 → 申請被擋，並列出原因
    await expect(requestApproval(w.editor, id, 'G1')).rejects.toThrow(/關卡檢查未通過/);
    const chk = await gateCheck(w.editor, id, 'G1');
    expect(chk.find((x) => x.key === 'has_confirmed_host')?.ok).toBe(false);
    expect(chk.find((x) => x.key === 'deps_done')?.ok).toBe(false);

    await setCampaignHostStatus(w.editor, id, f.h.id, 'CONFIRMED');
    // 前置任務有順序：不能先完成後面的
    await expect(done(w.editor, id, 'TRIAL_FEEDBACK')).rejects.toThrow(/前置任務尚未完成/);
    for (const k of ['SAMPLE_SHIP', 'TRIAL_ARRIVAL', 'TRIAL_FEEDBACK']) await done(w.editor, id, k);

    const g1 = await requestApproval(w.editor, id, 'G1', '試用回饋良好');
    expect(await status(id)).toBe('PENDING_G1');
    // 營運小編不能核准 G1；營運主管可以
    await expect(decideApproval(w.editor, g1.id, 'APPROVED')).rejects.toThrow(/不能決定/);
    await decideApproval(w.manager, g1.id, 'APPROVED', 'OK');
    expect(await status(id)).toBe('PREPARING');
    expect((await query('SELECT status FROM tasks WHERE campaign_id=$1 AND step_key=$2', [id, 'LAUNCH_APPROVAL']))[0].status).toBe('DONE');

    // G2：缺曝光安排、素材未完成
    const g2chk = await gateCheck(w.manager, id, 'G2');
    expect(g2chk.find((x) => x.key === 'has_placement')?.ok).toBe(false);
    expect(g2chk.find((x) => x.key === 'deps_done')?.ok).toBe(false);
    await addPlacement(w.editor, id, { hostId: f.h.id, communityId: f.c.id, placementType: 'LAUNCH', scheduledOn: dayOffset(20) });
    await done(w.editor, id, 'CREATIVE_ASSETS');
    const g2 = await requestApproval(w.editor, id, 'G2');
    expect(await status(id)).toBe('PENDING_G2');
    await decideApproval(w.manager, g2.id, 'APPROVED');
    expect(await status(id)).toBe('SCHEDULED');

    // 手動開團：未到開團日被擋；營運主管填原因可強制
    await expect(transitionCampaign(w.editor, id, 'RUNNING')).rejects.toThrow(/尚未到開團日/);
    await expect(transitionCampaign(w.editor, id, 'RUNNING', { force: true, reason: '提前' })).rejects.toThrow(/尚未到開團日/); // 小編不能 force
    await transitionCampaign(w.manager, id, 'RUNNING', { force: true, reason: '客戶要求提前開團' });
    expect(await status(id)).toBe('RUNNING');
    await expect(transitionCampaign(w.editor, id, 'PENDING_CLOSE_CHECK')).rejects.toThrow(/尚未過結團日/);

    // 模擬時間經過：開團日／結團日都已過
    await query('UPDATE campaigns SET sample_ready_date=$2, open_date=$3, close_date=$4 WHERE id=$1', [id, dayOffset(-30), dayOffset(-10), dayOffset(-1)]);
    await transitionCampaign(w.editor, id, 'PENDING_CLOSE_CHECK');

    // G3：結單確認（營運主管或財務）；沒有訂單只是提醒
    const g3chk = await gateCheck(w.manager, id, 'G3');
    expect(g3chk.find((x) => x.key === 'past_close')?.ok).toBe(true);
    expect(g3chk.find((x) => x.key === 'orders_present')).toMatchObject({ level: 'WARN', ok: false });
    const g3 = await requestApproval(w.editor, id, 'G3');
    expect(await status(id)).toBe('PENDING_CLOSE_CHECK'); // G3 不改變狀態直到決定
    await decideApproval(w.finance, g3.id, 'APPROVED');
    expect(await status(id)).toBe('FULFILLING');

    await transitionCampaign(w.editor, id, 'PENDING_SETTLEMENT');
    // G4：請款作業未完成不能申請；財務才能核准（營運主管不行）
    await expect(requestApproval(w.editor, id, 'G4')).rejects.toThrow(/關卡檢查未通過/);
    for (const k of ['LAUNCH', 'TOPIC_PROMO', 'CLOSING_REMINDER', 'VENDOR_SETTLE', 'INVOICE_REQUEST']) await done(w.editor, id, k);
    const g4 = await requestApproval(w.editor, id, 'G4');
    await expect(decideApproval(w.manager, g4.id, 'APPROVED')).rejects.toThrow(/不能決定/);
    await decideApproval(w.finance, g4.id, 'APPROVED');
    expect(await status(id)).toBe('SETTLED');

    // G5：復盤結案
    const g5 = await requestApproval(w.manager, id, 'G5');
    await decideApproval(w.manager, g5.id, 'APPROVED');
    expect(await status(id)).toBe('CLOSED');

    // 稽核：每次狀態變更都有前後值
    const audits = await query(`SELECT action, before_data, after_data FROM audit_logs WHERE campaign_id=$1 AND action='campaign.status' ORDER BY id`, [id]);
    const path = audits.map((a) => a.after_data.status);
    expect(path).toEqual(['EVALUATING', 'PENDING_G1', 'PREPARING', 'PENDING_G2', 'SCHEDULED', 'RUNNING', 'PENDING_CLOSE_CHECK', 'FULFILLING', 'PENDING_SETTLEMENT', 'SETTLED', 'CLOSED']);
    expect(audits[1].before_data.status).toBe('EVALUATING');
    // 結案後不可再變更
    await expect(transitionCampaign(w.manager, id, 'RUNNING')).rejects.toThrow();
    await expect(cancelCampaign(w.manager, id, '誤按')).rejects.toThrow(/不可取消/);
  });
});

describe('狀態機防呆', () => {
  it('不能用「變更狀態」繞過關卡；倒退要原因；跳步被拒', async () => {
    const f = await fixture();
    await expect(transitionCampaign(w.manager, f.id, 'RUNNING')).rejects.toThrow(/不允許/);
    await expect(transitionCampaign(w.manager, f.id, 'CLOSED')).rejects.toThrow(/不允許/);
    await transitionCampaign(w.manager, f.id, 'EVALUATING');
    await expect(transitionCampaign(w.manager, f.id, 'PREPARING')).rejects.toThrow(/不允許/);          // 想繞過 G1
    await expect(transitionCampaign(w.manager, f.id, 'DRAFT')).rejects.toThrow(/原因/);                  // 倒退需原因
    await transitionCampaign(w.manager, f.id, 'DRAFT', { reason: '資料要重整' });
    expect(await status(f.id)).toBe('DRAFT');
  });

  it('沒有商品的檔期不能進入評估', async () => {
    const v = await mkVendor(w);
    const r = await mkCampaign(w, v.id);
    await expect(transitionCampaign(w.manager, r.id, 'EVALUATING')).rejects.toThrow(/至少需要一個商品/);
  });

  it('核准被退回：回到上一個狀態並保留原因；退回需填原因', async () => {
    const f = await fixture();
    await transitionCampaign(w.editor, f.id, 'EVALUATING');
    await setCampaignHostStatus(w.editor, f.id, f.h.id, 'CONFIRMED');
    for (const k of ['SAMPLE_SHIP', 'TRIAL_ARRIVAL', 'TRIAL_FEEDBACK']) await done(w.editor, f.id, k);
    const a = await requestApproval(w.editor, f.id, 'G1');
    await expect(decideApproval(w.manager, a.id, 'REJECTED')).rejects.toThrow(/原因/);
    await decideApproval(w.manager, a.id, 'REJECTED', '試用反應不佳，再評估');
    expect(await status(f.id)).toBe('EVALUATING');
    expect((await query('SELECT status_reason FROM campaigns WHERE id=$1', [f.id]))[0].status_reason).toContain('試用反應不佳');
    // 已決定的申請不能再次決定
    await expect(decideApproval(w.manager, a.id, 'APPROVED')).rejects.toThrow(/已是/);
    // 可重新申請
    const again = await requestApproval(w.editor, f.id, 'G1');
    expect(again.id).not.toBe(a.id);
    // 重複申請被擋
    await expect(requestApproval(w.editor, f.id, 'G1')).rejects.toThrow();
  });

  it('組織設定要求申請人≠核准人時，自己不能核准自己的申請', async () => {
    const f = await fixture();
    await query(`INSERT INTO system_settings (organization_id, key, value) VALUES ($1,'approval.require_distinct_actor','true') ON CONFLICT (organization_id,key) DO UPDATE SET value='true'`, [w.orgId]);
    try {
      await transitionCampaign(w.manager, f.id, 'EVALUATING');
      await setCampaignHostStatus(w.manager, f.id, f.h.id, 'CONFIRMED');
      for (const k of ['SAMPLE_SHIP', 'TRIAL_ARRIVAL', 'TRIAL_FEEDBACK']) await done(w.manager, f.id, k);
      const a = await requestApproval(w.manager, f.id, 'G1');
      await expect(decideApproval(w.manager, a.id, 'APPROVED')).rejects.toThrow(/不得為同一人/);
      const other = await addUser(w.orgId, 'OPS_MANAGER');
      await decideApproval(other, a.id, 'APPROVED');
      expect(await status(f.id)).toBe('PREPARING');
    } finally {
      await query(`DELETE FROM system_settings WHERE organization_id=$1 AND key='approval.require_distinct_actor'`, [w.orgId]).catch(() => undefined);
    }
  });
});

describe('取消與暫緩', () => {
  it('取消：任務、待核准、曝光安排一併取消，保留原狀態與原因；已取消不可恢復', async () => {
    const f = await fixture();
    await transitionCampaign(w.editor, f.id, 'EVALUATING');
    await setCampaignHostStatus(w.editor, f.id, f.h.id, 'CONFIRMED');
    await addPlacement(w.editor, f.id, { hostId: f.h.id, communityId: f.c.id, placementType: 'LAUNCH', scheduledOn: dayOffset(21) });
    await done(w.editor, f.id, 'SAMPLE_SHIP');
    await expect(cancelCampaign(w.editor, f.id, '不做了')).rejects.toThrow(/營運主管/);
    await expect(cancelCampaign(w.manager, f.id, '')).rejects.toThrow(/原因/);
    const r = await cancelCampaign(w.manager, f.id, '廠商無法供貨');
    expect(r.cancelledTasks).toBeGreaterThan(5);
    expect(await status(f.id)).toBe('CANCELLED');
    const tasks = await query(`SELECT status, count(*)::int AS n FROM tasks WHERE campaign_id=$1 GROUP BY status`, [f.id]);
    expect(tasks.find((t) => t.status === 'DONE')?.n).toBe(1);        // 已完成的保留
    expect(tasks.find((t) => t.status === 'TODO')).toBeUndefined();    // 其餘不再是待辦
    expect((await query(`SELECT status FROM campaign_placements WHERE campaign_id=$1`, [f.id]))[0].status).toBe('CANCELLED');
    expect((await query(`SELECT previous_status, status_reason FROM campaigns WHERE id=$1`, [f.id]))[0]).toMatchObject({ previous_status: 'EVALUATING', status_reason: '廠商無法供貨' });
    await expect(resumeCampaign(w.manager, f.id, '想恢復')).rejects.toThrow(/暫緩/);
    await expect(setTaskStatus(w.manager, await taskId(f.id, 'TRIAL_ARRIVAL'), { to: 'DONE' })).rejects.toThrow();
    // 取消後可用同名重新建立（自然鍵只擋未取消者）
    const again = await mkCampaign(w, f.v.id, { title: (await query('SELECT title FROM campaigns WHERE id=$1', [f.id]))[0].title, openDate: dayOffset(20), closeDate: dayOffset(30), sampleReadyDate: dayOffset(1) });
    expect(again.id).not.toBe(f.id);
  });

  it('暫緩可恢復到原狀態；暫緩期間不可變更任務', async () => {
    const f = await fixture();
    await transitionCampaign(w.editor, f.id, 'EVALUATING');
    await holdCampaign(w.manager, f.id, '等廠商確認庫存');
    expect(await status(f.id)).toBe('ON_HOLD');
    await expect(setTaskStatus(w.manager, await taskId(f.id, 'SAMPLE_SHIP'), { to: 'DONE' })).rejects.toThrow(/暫緩/);
    await resumeCampaign(w.manager, f.id, '庫存已確認');
    expect(await status(f.id)).toBe('EVALUATING');
  });
});

describe('團主回覆', () => {
  it('團主只能回覆自己的邀請；婉拒需原因；團主婉拒後看不到該檔期', async () => {
    const f = await fixture();
    const hostUser = await addUser(w.orgId, 'HOST', { hostIds: [f.h.id] });
    const otherHost = await mkHost(w);
    const otherUser = await addUser(w.orgId, 'HOST', { hostIds: [otherHost.id] });
    await expect(setCampaignHostStatus(otherUser, f.id, f.h.id, 'CONFIRMED')).rejects.toThrow();
    await expect(setCampaignHostStatus(hostUser, f.id, f.h.id, 'DECLINED')).rejects.toThrow(/原因/);
    await setCampaignHostStatus(hostUser, f.id, f.h.id, 'CONFIRMED');
    expect((await getCampaign(hostUser, f.id)).hosts).toHaveLength(1);
    await setCampaignHostStatus(hostUser, f.id, f.h.id, 'DECLINED', '檔期衝突');
    await expect(getCampaign(hostUser, f.id)).rejects.toThrow(/找不到/);
    // 婉拒後不能再安排曝光
    await expect(addPlacement(w.editor, f.id, { hostId: f.h.id, communityId: f.c.id, placementType: 'POST', scheduledOn: dayOffset(21) })).rejects.toThrow(/婉拒/);
  });
});

void addCampaignHost; void linkHostCommunity;
