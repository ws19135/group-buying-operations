import crypto from 'node:crypto';
import { closePool, query, withTx } from '../src/server/lib/db';
import { migrate } from '../src/server/lib/migrate';
import { appEnv } from '../src/server/lib/config';
import { todayTaipei } from '../src/server/lib/ids';
import { addDays } from '../src/server/lib/dates';
import { createInitialUser, createOrganization, firstOrganization } from '../src/server/modules/org';
import type { Actor } from '../src/server/lib/permissions';
import { createVendor } from '../src/server/modules/vendors';
import { createProduct } from '../src/server/modules/products';
import { createHost, createCommunity } from '../src/server/modules/hosts';
import { createCampaign, addPlacement } from '../src/server/modules/campaigns';
import { importOrders } from '../src/server/modules/orders';
import { createCommissionRule } from '../src/server/modules/commission';
import { receiveVendorIntake } from '../src/server/modules/intake';
import { JOB_KEYS, runJob, setJobEnabled } from '../src/server/modules/automation';
import { loadEnv } from './load-env';

/**
 * DEMO 種子：建立「虛構」的示範資料，所有名稱都以 [DEMO] 開頭，訂單 data_origin=DEMO。
 * 絕對不是真實營運數據；Dashboard 會明確標示 DEMO。拒絕在 production 執行。
 */
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function main() {
  loadEnv();
  if (appEnv() === 'production') throw new Error('拒絕在 production 建立 DEMO 資料');
  await migrate();
  let org = await firstOrganization();
  if (!org) { const r = await createOrganization('[DEMO] 示範營運公司'); org = { id: r.orgId, name: '[DEMO] 示範營運公司' }; }
  const orgId = org.id;
  const already = await query(`SELECT 1 FROM vendors WHERE organization_id=$1 AND name LIKE '[DEMO]%' LIMIT 1`, [orgId]);
  if (already.length) { console.log('DEMO 資料已存在（略過）。要重來請先 npm run db:reset。'); return; }

  let pw = process.env.DEMO_PASSWORD;
  const generated = !pw;
  if (!pw) pw = `Demo-${crypto.randomBytes(6).toString('base64url')}1`;
  const users: Record<string, { id: string; email: string }> = {};
  const mkUser = async (key: string, role: string, name: string, scopes: { hostIds?: string[]; vendorIds?: string[] } = {}) => {
    const email = `demo-${key}@example.invalid`;
    const ex = await query<{ id: string }>(`SELECT id FROM users WHERE lower(email)=lower($1)`, [email]);
    const id = ex[0]?.id ?? (await withTx((tx) => createInitialUser(tx, orgId, { email, name, role, password: pw as string, ...scopes })));
    users[key] = { id, email };
    return id;
  };
  const mk = (id: string, role: Actor['role']): Actor => ({ type: 'USER', userId: id, orgId, role, name: role, hostIds: [], vendorIds: [], requestId: `demo-${role}`, source: 'SEED' });
  const adminId = await mkUser('admin', 'SYSTEM_ADMIN', '[DEMO] 管理者');
  const managerId = await mkUser('manager', 'OPS_MANAGER', '[DEMO] 營運主管');
  const editorId = await mkUser('editor', 'OPS_EDITOR', '[DEMO] 營運小編');
  const financeId = await mkUser('finance', 'FINANCE', '[DEMO] 財務');
  const admin = mk(adminId, 'SYSTEM_ADMIN'), manager = mk(managerId, 'OPS_MANAGER'), editor = mk(editorId, 'OPS_EDITOR'), finance = mk(financeId, 'FINANCE');

  // 廠商
  const v1 = (await createVendor(manager, { name: '[DEMO] 晴空保養', companyName: '[DEMO] 晴空保養股份有限公司', taxId: '99990001', category: '保養', status: 'ACTIVE', contacts: [{ name: '[DEMO] 林小姐', email: 'demo-vendor1@example.invalid', isPrimary: true }] })).id;
  const v2 = (await createVendor(manager, { name: '[DEMO] 暖食堂', companyName: '[DEMO] 暖食堂有限公司', taxId: '99990002', category: '食品', status: 'ACTIVE', contacts: [{ name: '[DEMO] 陳先生', phone: '0200000000', isPrimary: true }] })).id;
  const v3 = (await createVendor(manager, { name: '[DEMO] 森活家居', category: '居家', status: 'ACTIVE' })).id;   // 故意資料不齊
  await mkUser('vendor', 'VENDOR', '[DEMO] 晴空保養窗口', { vendorIds: [v1] });
  // 商品
  const pSun = await createProduct(manager, { vendorId: v1, name: '[DEMO] 清爽防曬噴霧', category: '保養', skus: [
    { skuCode: 'SUN-50', name: '50ml', listPrice: 480, groupPrice: 360, costPrice: 180 }, { skuCode: 'SUN-120', name: '120ml', listPrice: 880, groupPrice: 650, costPrice: 330 }] });
  const pMask = await createProduct(manager, { vendorId: v1, name: '[DEMO] 保濕面膜', skus: [{ skuCode: 'MASK-5', name: '5入', listPrice: 600, groupPrice: 420, costPrice: 200 }] });
  const pCookie = await createProduct(manager, { vendorId: v2, name: '[DEMO] 手作餅乾禮盒', skus: [
    { skuCode: 'CK-S', name: '小盒', listPrice: 450, groupPrice: 380, costPrice: 190 }, { skuCode: 'CK-L', name: '大盒', listPrice: 850, groupPrice: 720, costPrice: 360 }] });
  const pCandle = await createProduct(manager, { vendorId: v3, name: '[DEMO] 香氛蠟燭', skus: [{ skuCode: 'CND-1', name: '單入', listPrice: 700, groupPrice: 560, costPrice: 250 }] });
  await query(`UPDATE products SET review_status='APPROVED', reviewed_by=$2, reviewed_at=now() WHERE id = ANY($1::text[])`, [[pSun.id, pCookie.id, pCandle.id], managerId]);
  // 團主與社群
  const h1 = (await createHost(manager, { displayName: '[DEMO] 小雅媽咪', audienceNote: '親子、保養', cooperationTerms: '[DEMO] 虛構條件' })).id;
  const h2 = (await createHost(manager, { displayName: '[DEMO] 阿凱生活', audienceNote: '男性、3C' })).id;
  const h3 = (await createHost(manager, { displayName: '[DEMO] 米粒日常', audienceNote: '美食、居家' })).id;
  const c1a = (await createCommunity(manager, { platform: 'LINE', name: '[DEMO] 小雅媽咪好物群', memberCount: 480 }, [h1])).id;
  const c1b = (await createCommunity(manager, { platform: 'FACEBOOK', name: '[DEMO] 小雅媽咪粉專社團', memberCount: 1500 }, [h1])).id;
  const c2a = (await createCommunity(manager, { platform: 'LINE', name: '[DEMO] 阿凱生活圈', memberCount: 320 }, [h2])).id;
  const c3a = (await createCommunity(manager, { platform: 'INSTAGRAM', name: '[DEMO] 米粒日常 IG', memberCount: 2100 }, [h3])).id;
  const u1 = await mkUser('host1', 'HOST', '[DEMO] 小雅媽咪', { hostIds: [h1] });
  const u2 = await mkUser('host2', 'HOST', '[DEMO] 阿凱生活', { hostIds: [h2] });
  void u1; void u2;

  const t = todayTaipei();
  const d = (n: number) => addDays(t, n);
  const doneSteps = async (cid: string, keys: string[]) => query(`UPDATE tasks SET status='DONE', completed_at=now() WHERE campaign_id=$1 AND step_key = ANY($2::text[])`, [cid, keys]);
  const setStatus = (cid: string, s: string) => query(`UPDATE campaigns SET status=$2 WHERE id=$1`, [cid, s]);
  const approve = async (cid: string, gate: string) => query(`INSERT INTO approvals (id, organization_id, campaign_id, gate_key, status, requested_by, decided_by, decided_at, decision_note)
    VALUES ('APR-D'||substr(md5(random()::text),1,8), $1,$2,$3,'APPROVED',$4,$5,now(),'[DEMO] 示範核准')`, [orgId, cid, gate, editorId, managerId]);

  // C1 進行中（有訂單）
  const c1 = await createCampaign(manager, { title: '[DEMO] 夏日防曬噴霧團購', vendorId: v1, ownerUserId: editorId, sampleReadyDate: d(-40), openDate: d(-3), closeDate: d(7), targetRevenue: 300000,
    products: pSun.skuIds.map((s) => ({ productId: pSun.id, skuId: s })), hosts: [{ hostId: h1, targetRevenue: 150000 }, { hostId: h2, targetRevenue: 80000 }] });
  await query(`UPDATE campaign_hosts SET status='CONFIRMED', responded_at=now() WHERE campaign_id=$1`, [c1.id]);
  await setStatus(c1.id, 'RUNNING'); await approve(c1.id, 'G1'); await approve(c1.id, 'G2');
  await doneSteps(c1.id, ['SAMPLE_SHIP', 'TRIAL_ARRIVAL', 'TRIAL_FEEDBACK', 'LAUNCH_APPROVAL', 'CREATIVE_ASSETS', 'PRELAUNCH_CHECK', 'LAUNCH', 'TOPIC_PROMO']);
  for (const [h, c] of [[h1, c1a], [h1, c1b], [h2, c2a]] as const) await addPlacement(manager, c1.id, { hostId: h, communityId: c, placementType: 'LAUNCH', scheduledOn: d(-3) });
  await addPlacement(manager, c1.id, { hostId: h1, communityId: c1a, placementType: 'REMINDER', scheduledOn: d(6) });
  // C2 已排程
  const c2 = await createCampaign(manager, { title: '[DEMO] 手作餅乾禮盒團', vendorId: v2, ownerUserId: editorId, sampleReadyDate: d(-30), openDate: d(5), closeDate: d(15), targetRevenue: 120000,
    products: pCookie.skuIds.map((s) => ({ productId: pCookie.id, skuId: s })), hosts: [{ hostId: h3, targetRevenue: 120000 }] });
  await query(`UPDATE campaign_hosts SET status='CONFIRMED', responded_at=now() WHERE campaign_id=$1`, [c2.id]);
  await setStatus(c2.id, 'SCHEDULED'); await approve(c2.id, 'G1'); await approve(c2.id, 'G2');
  await doneSteps(c2.id, ['SAMPLE_SHIP', 'TRIAL_ARRIVAL', 'TRIAL_FEEDBACK', 'LAUNCH_APPROVAL', 'CREATIVE_ASSETS', 'PRELAUNCH_CHECK']);
  await addPlacement(manager, c2.id, { hostId: h3, communityId: c3a, placementType: 'LAUNCH', scheduledOn: d(5) });
  // C3 評估中，試用回饋逾期（團主未回覆）
  const c3 = await createCampaign(manager, { title: '[DEMO] 保濕面膜試用團', vendorId: v1, ownerUserId: editorId, sampleReadyDate: d(-26), openDate: d(30), closeDate: d(40), needsSampleRecovery: true,
    products: [{ productId: pMask.id, skuId: pMask.skuIds[0] }], hosts: [{ hostId: h2 }] });
  await setStatus(c3.id, 'EVALUATING'); await doneSteps(c3.id, ['SAMPLE_SHIP']);
  // C4 已結團待確認（有退款）
  const c4 = await createCampaign(manager, { title: '[DEMO] 香氛蠟燭秋季團', vendorId: v3, ownerUserId: editorId, sampleReadyDate: d(-50), openDate: d(-14), closeDate: d(-2), targetRevenue: 60000,
    products: [{ productId: pCandle.id, skuId: pCandle.skuIds[0] }], hosts: [{ hostId: h1, targetRevenue: 60000 }] });
  await query(`UPDATE campaign_hosts SET status='CONFIRMED', responded_at=now() WHERE campaign_id=$1`, [c4.id]);
  await setStatus(c4.id, 'PENDING_CLOSE_CHECK'); await approve(c4.id, 'G1'); await approve(c4.id, 'G2');
  await doneSteps(c4.id, ['SAMPLE_SHIP', 'TRIAL_ARRIVAL', 'TRIAL_FEEDBACK', 'LAUNCH_APPROVAL', 'CREATIVE_ASSETS', 'PRELAUNCH_CHECK', 'LAUNCH', 'TOPIC_PROMO', 'CLOSING_REMINDER']);

  // 佣金規則（H3 故意不設定，示範「尚未設定費率」）
  await createCommissionRule(finance, { scopeType: 'HOST_DEFAULT', hostId: h1, ratePercent: 12, effectiveFrom: d(-365), note: '[DEMO] 虛構費率' });
  await createCommissionRule(finance, { scopeType: 'HOST_DEFAULT', hostId: h2, ratePercent: 10, effectiveFrom: d(-365), note: '[DEMO] 虛構費率' });

  // 訂單（固定亂數種子，可重現）
  const rand = rng(20261028);
  const rows: string[] = ['source_order_id,campaign_id,ordered_at,status,quantity,unit_price,sku_code,buyer_ref,host_id,community_id,refund_amount'];
  let n = 0;
  const gen = (cid: string, skus: { code: string; price: number }[], hostsComm: [string, string | ''][], startOffset: number, endOffset: number, count: number) => {
    for (let i = 0; i < count; i++) {
      n++;
      const day = d(startOffset + Math.floor(rand() * (endOffset - startOffset + 1)));
      // 今天的訂單不可晚於現在（避免「資料截至」落在未來）
      const nowHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
      const maxH = day === t ? Math.max(1, nowHour) : 22;
      const hh = String(Math.min(maxH - 1, 8 + Math.floor(rand() * 14))).padStart(2, '0'), mm = String(Math.floor(rand() * 60)).padStart(2, '0');
      const r = rand();
      const status = r < 0.82 ? 'PAID' : r < 0.88 ? 'PARTIAL_REFUND' : r < 0.91 ? 'REFUNDED' : r < 0.96 ? 'CANCELLED' : 'PENDING';
      const lines = 1 + Math.floor(rand() * 2);
      const [host, comm] = hostsComm[Math.floor(rand() * hostsComm.length)];
      let gross = 0; const ls: { s: { code: string; price: number }; q: number }[] = [];
      for (let k = 0; k < lines; k++) { const s = skus[Math.floor(rand() * skus.length)]; const q = 1 + Math.floor(rand() * 3); ls.push({ s, q }); gross += s.price * q; }
      const refund = status === 'REFUNDED' ? gross : status === 'PARTIAL_REFUND' ? Math.max(1, Math.floor(gross / 3)) : 0;
      ls.forEach((l, k) => rows.push(`DEMO-${String(n).padStart(5, '0')},${cid},${day} ${hh}:${mm},${status},${l.q},${l.s.price},${l.s.code},demo-buyer-${n},${host},${comm},${k === 0 && refund ? refund : ''}`));
    }
  };
  gen(c1.id, [{ code: 'SUN-50', price: 360 }, { code: 'SUN-120', price: 650 }], [[h1, c1a], [h1, c1b], [h2, c2a]], -3, 0, 70);
  gen(c4.id, [{ code: 'CND-1', price: 560 }], [[h1, '']], -14, -2, 40);
  const imp = await importOrders({ ...admin, source: 'SEED' }, { sourceSystem: 'DEMO_GENERATOR', origin: 'DEMO', fileName: 'demo-orders.csv', csv: rows.join('\n') });

  // 進件示範
  await receiveVendorIntake(editor, 'demo-form-001', { vendorName: '[DEMO] 新進件品牌', companyName: '[DEMO] 新進件股份有限公司', contactName: '[DEMO] 張小姐', contactInfo: 'demo-intake@example.invalid',
    itemName: '[DEMO] 進件示範商品', listPrice: 500, groupPrice: 390, commissionText: '20%', sampleReadyDate: d(10), needsRecovery: false, closeRule: '結團後 7 天內結單' });

  // 跑一次自動化（測試 Adapter，不對真人發送），然後恢復為停用
  for (const k of JOB_KEYS) await setJobEnabled(admin, k, true);
  for (const k of ['vendor_intake', 'event_dispatch', 'task_reminders', 'overdue_detection', 'prelaunch_check', 'daily_summary', 'notification_dispatch'] as const) await runJob(orgId, k, { trigger: 'MANUAL', idempotencyKey: `demo-seed:${k}` });
  for (const k of JOB_KEYS) await setJobEnabled(admin, k, false);

  console.log(`DEMO 資料已建立：4 檔團購、${imp.insertedOrders} 張訂單（data_origin=DEMO）、3 位團主、3 家廠商`);
  console.log('示範帳號（Email → 角色）：');
  for (const [k, u] of Object.entries(users)) console.log(`  ${u.email}  (${k})`);
  console.log(generated ? `示範密碼（隨機產生，只顯示一次）：${pw}` : '示範密碼：使用 DEMO_PASSWORD');
  console.log('自動化工作已恢復為「停用」；通知僅走測試 Adapter。');
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(closePool);
