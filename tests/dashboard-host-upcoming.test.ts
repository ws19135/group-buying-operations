import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { getHostDashboard } from '@/server/modules/dashboard';
import { addPlacement } from '@/server/modules/campaigns';
import { addDays } from '@/server/lib/dates';
import { todayTaipei } from '@/server/lib/ids';
import { addUser, dayOffset, makeWorld, mkCampaign, mkCommunity, mkHost, mkProduct, mkVendor, type World } from './helpers';
import type { Actor } from '@/server/lib/permissions';
import type { HostDash } from '@/ui/types';

const today = todayTaipei();
const OPEN = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'WAITING_APPROVAL'];

let w: World;
let h1: string, h2: string, comm1: string;
let host1: Actor, host2: Actor;
let near: string, far: string, late: string;

const dash = async (as: Actor, hostId?: string) => (await getHostDashboard(as, hostId)) as unknown as HostDash;
const taskRows = (cid: string) => query<{ step_key: string; name: string; status: string; planned_end: string | null; owner_role: string; phase: number }>(
  `SELECT step_key, name, status, planned_end::text AS planned_end, owner_role, phase FROM tasks WHERE campaign_id=$1 ORDER BY seq`, [cid]);

beforeAll(async () => {
  w = await makeWorld();
  const v = await mkVendor(w);
  const p = await mkProduct(w, v.id, { approve: true });
  h1 = (await mkHost(w, '團主一')).id; h2 = (await mkHost(w, '團主二')).id;
  comm1 = (await mkCommunity(w, [h1])).id;
  const products = [{ productId: p.id, skuId: p.skuIds[0] }];
  // 近：兩週內有寄樣／試用／開團／結團
  near = (await mkCampaign(w, v.id, { products, hosts: [{ hostId: h1 }], sampleReadyDate: dayOffset(0), openDate: dayOffset(8), closeDate: dayOffset(13) }, w.manager)).id;
  // 遠：所有日期都在兩週之後
  far = (await mkCampaign(w, v.id, { products, hosts: [{ hostId: h1 }], sampleReadyDate: dayOffset(40), openDate: dayOffset(60), closeDate: dayOffset(70) }, w.manager)).id;
  // 已逾期：試用品早就該到了、團主還沒回饋
  late = (await mkCampaign(w, v.id, { products, hosts: [{ hostId: h1 }], sampleReadyDate: dayOffset(-40), openDate: dayOffset(14), closeDate: dayOffset(30) }, w.manager)).id;
  // 團主二只參加另一個檔期（資料隔離）
  await mkCampaign(w, v.id, { products, hosts: [{ hostId: h2 }], sampleReadyDate: dayOffset(1), openDate: dayOffset(9), closeDate: dayOffset(12) }, w.manager);
  await addPlacement(w.manager, near, { hostId: h1, communityId: comm1, placementType: 'LAUNCH', scheduledOn: dayOffset(9) });
  await addPlacement(w.manager, late, { hostId: h1, communityId: comm1, placementType: 'LAUNCH', scheduledOn: dayOffset(14) });   // 第 15 天：不在兩週內
  // 草稿檔期不會出現在團主總覽（和「我的檔期」一致），所以改成已排程
  await query(`UPDATE campaigns SET status='SCHEDULED' WHERE organization_id=$1`, [w.orgId]);
  host1 = await addUser(w.orgId, 'HOST', { hostIds: [h1] });
  host2 = await addUser(w.orgId, 'HOST', { hostIds: [h2] });
});

describe('團主總覽最上面：團購 SOP', () => {
  it('列出寄樣到結團前催單的 11 步，團主負責的步驟標記為「我負責」，內部結算步驟不列出', async () => {
    const d = await dash(host1);
    expect(d.sop.steps).toHaveLength(11);
    expect(d.sop.steps.map((s) => s.seq)).toEqual([...d.sop.steps.map((s) => s.seq)].sort((a, b) => a - b));
    const mine = d.sop.steps.filter((s) => s.mine).map((s) => s.stepKey);
    expect(mine.sort()).toEqual(['LIVE_TALK', 'TRIAL_ARRIVAL', 'TRIAL_FEEDBACK']);
    for (const s of d.sop.steps) expect(s.mine).toBe(s.ownerRole === 'HOST');
    const keys = d.sop.steps.map((s) => s.stepKey);
    for (const internal of ['CLOSE_CONFIRM', 'VENDOR_SETTLE', 'INVOICE_REQUEST', 'CLOSURE_REVIEW']) expect(keys).not.toContain(internal);
  });
  it('每個檔期顯示完成幾步與目前進行到哪一步；完成的步驟不再當作目前步驟', async () => {
    const before = (await dash(host1)).sop.progress.find((x) => x.campaignId === near);
    expect(before?.done).toBe(0);
    expect(before?.current?.stepKey).toBe('SAMPLE_SHIP');
    await query(`UPDATE tasks SET status='DONE', completed_at=now() WHERE campaign_id=$1 AND step_key='SAMPLE_SHIP'`, [near]);
    const after = (await dash(host1)).sop.progress.find((x) => x.campaignId === near);
    expect(after?.done).toBe(1);
    expect(after?.current?.stepKey).toBe('TRIAL_ARRIVAL');
    await query(`UPDATE tasks SET status='TODO', completed_at=NULL WHERE campaign_id=$1 AND step_key='SAMPLE_SHIP'`, [near]);
  });
});

describe('團主總覽最上面：接下來兩週的進程', () => {
  it('範圍是今天起連續 14 天（含第 14 天、不含第 15 天）', async () => {
    const u = (await dash(host1)).upcoming;
    expect(u.from).toBe(today);
    expect(u.to).toBe(addDays(today, 13));
    expect(u.days).toBe(14);
    for (const i of u.items) { expect(i.date >= today).toBe(true); expect(i.date <= u.to).toBe(true); }
    const dates = u.items.map((i) => i.date);
    expect(dates).toEqual([...dates].sort());
  });
  it('包含開團、結團、曝光與兩週內到期的 SOP 作業；兩週之外的不出現', async () => {
    const u = (await dash(host1)).upcoming;
    const ofNear = u.items.filter((i) => i.campaignId === near);
    expect(ofNear.some((i) => i.kind === 'OPEN' && i.date === dayOffset(8))).toBe(true);
    expect(ofNear.some((i) => i.kind === 'CLOSE' && i.date === dayOffset(13))).toBe(true);
    expect(ofNear.filter((i) => i.kind === 'PLACEMENT').map((i) => i.date)).toEqual([dayOffset(9)]);
    expect(u.items.some((i) => i.kind === 'PLACEMENT' && i.date === dayOffset(14))).toBe(false);
    // 作業：和資料庫裡的任務逐筆比對（未完成、預定完成日在視窗內）
    const expected = (await taskRows(near)).filter((t) => t.phase <= 6 && OPEN.includes(t.status) && t.planned_end && t.planned_end >= today && t.planned_end <= u.to)
      .map((t) => `${t.planned_end}|${t.name}`).sort();
    expect(expected.length).toBeGreaterThan(0);
    expect(ofNear.filter((i) => i.kind === 'TASK').map((i) => `${i.date}|${i.label}`).sort()).toEqual(expected);
    expect(u.items.some((i) => i.campaignId === far)).toBe(false);
  });
  it('作業會標明誰負責：團主負責的 mine=true，廠商或營運負責的 mine=false', async () => {
    const tasks = (await dash(host1)).upcoming.items.filter((i) => i.kind === 'TASK');
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) expect(t.mine).toBe(t.ownerRole === 'HOST');
    expect(tasks.some((t) => t.ownerRole !== 'HOST')).toBe(true);
  });
  it('已完成的作業不再出現', async () => {
    const before = (await dash(host1)).upcoming.items.filter((i) => i.campaignId === near && i.kind === 'TASK' && i.label === '廠商寄樣');
    expect(before).toHaveLength(1);
    await query(`UPDATE tasks SET status='DONE', completed_at=now() WHERE campaign_id=$1 AND step_key='SAMPLE_SHIP'`, [near]);
    const after = (await dash(host1)).upcoming.items.filter((i) => i.campaignId === near && i.kind === 'TASK' && i.label === '廠商寄樣');
    expect(after).toHaveLength(0);
    await query(`UPDATE tasks SET status='TODO', completed_at=NULL WHERE campaign_id=$1 AND step_key='SAMPLE_SHIP'`, [near]);
  });
  it('團主自己逾期未完成的作業另外列出；別人負責的逾期不算在團主頭上', async () => {
    const u = (await dash(host1)).upcoming;
    const rows = (await taskRows(late)).filter((t) => t.owner_role === 'HOST' && OPEN.includes(t.status) && t.planned_end && t.planned_end < today && t.phase <= 6);
    expect(rows.length).toBeGreaterThan(0);
    expect(u.overdue.filter((o) => o.campaignId === late).map((o) => o.name).sort()).toEqual(rows.map((r) => r.name).sort());
    const vendorOverdue = (await taskRows(late)).filter((t) => t.owner_role !== 'HOST' && t.planned_end && t.planned_end < today && OPEN.includes(t.status)).map((t) => t.name);
    for (const n of vendorOverdue) expect(u.overdue.map((o) => o.name)).not.toContain(n);
  });
  it('資料隔離：團主只看到自己參與的檔期；內部人員以團主視角看到的內容相同', async () => {
    const d2 = await dash(host2);
    expect(d2.upcoming.items.some((i) => i.campaignId === near || i.campaignId === late)).toBe(false);
    expect(d2.sop.progress.some((p) => p.campaignId === near)).toBe(false);
    expect(d2.upcoming.items.length).toBeGreaterThan(0);
    const asHost = await dash(host1);
    const asManager = await dash(w.manager, h1);
    expect(asManager.upcoming).toEqual(asHost.upcoming);
    expect(asManager.sop).toEqual(asHost.sop);
  });
  it('婉拒的檔期不再提醒', async () => {
    await query(`UPDATE campaign_hosts SET status='DECLINED' WHERE campaign_id=$1 AND host_id=$2`, [near, h1]);
    const u = (await dash(host1)).upcoming;
    expect(u.items.some((i) => i.campaignId === near)).toBe(false);
    await query(`UPDATE campaign_hosts SET status='INVITED' WHERE campaign_id=$1 AND host_id=$2`, [near, h1]);
  });
});
