import { closePool, query } from '../src/server/lib/db';
import { migrate } from '../src/server/lib/migrate';
import { appEnv } from '../src/server/lib/config';
import { addDays } from '../src/server/lib/dates';
import { todayTaipei } from '../src/server/lib/ids';
import type { Actor, RoleKey } from '../src/server/lib/permissions';
import { addCaseNote, completeRefund, createCase, decideRefund, requestRefund, setCaseStatus } from '../src/server/modules/aftersales';
import { loadEnv } from './load-env';

/**
 * 售後 DEMO 種子：在既有的 [DEMO] 檔期與 DEMO 訂單上建立虛構的售後案件與退款申請。
 * 必須先執行 db:seed:demo。冪等：已有 [DEMO] 售後案件就略過。拒絕在 production 執行（除非明確允許公開示範環境）。
 */
async function main() {
  loadEnv();
  if (appEnv() === 'production' && process.env.ALLOW_DEMO_IN_PRODUCTION !== 'yes') {
    throw new Error('拒絕在 production 建立 DEMO 資料。只有「公開示範環境」才可設定 ALLOW_DEMO_IN_PRODUCTION=yes');
  }
  await migrate();
  const actorOf = async (key: string, role: RoleKey): Promise<Actor> => {
    const [u] = await query<{ id: string; organization_id: string }>(`SELECT id, organization_id FROM users WHERE lower(email)=$1 AND deleted_at IS NULL`, [`demo-${key}@example.invalid`]);
    if (!u) throw new Error(`找不到 demo-${key}，請先執行 npm run db:seed:demo`);
    return { type: 'USER', userId: u.id, orgId: u.organization_id, role, name: `demo-${key}`, hostIds: [], vendorIds: [], requestId: 'demo-aftersales', source: 'SEED' };
  };
  const manager = await actorOf('manager', 'OPS_MANAGER');
  const editor = await actorOf('editor', 'OPS_EDITOR');
  const finance = await actorOf('finance', 'FINANCE');
  const today = todayTaipei();
  const d = (n: number) => addDays(today, n);

  const had = await query(`SELECT 1 FROM service_cases WHERE organization_id=$1 AND title LIKE '[DEMO]%' LIMIT 1`, [manager.orgId]);
  if (had.length) { console.log('售後 DEMO 資料已存在（略過）。'); return; }
  const camp = async (title: string) => {
    const [c] = await query<{ id: string }>(`SELECT id FROM campaigns WHERE organization_id=$1 AND title=$2 AND deleted_at IS NULL`, [manager.orgId, title]);
    if (!c) throw new Error(`找不到檔期「${title}」，請先執行 npm run db:seed:demo`);
    return c.id;
  };
  const c1 = await camp('[DEMO] 夏日防曬噴霧團購');
  const c4 = await camp('[DEMO] 香氛蠟燭秋季團');
  const orders = async (cid: string, n: number) => query<{ id: string; gross_amount: number }>(
    `SELECT id, gross_amount FROM orders WHERE campaign_id=$1 AND data_origin='DEMO' AND status='PAID' ORDER BY id LIMIT $2`, [cid, n]);
  const o1 = await orders(c1, 3); const o4 = await orders(c4, 3);
  if (o1.length < 3 || o4.length < 3) throw new Error('DEMO 訂單不足，請先執行 npm run db:seed:demo');
  const half = (g: number) => Math.max(1, Math.floor(g / 2));

  // 1) 逾期的客訴（處理中），有一則對外可見的備註
  const k1 = (await createCase(editor, { campaignId: c1, orderId: o1[0].id, caseType: 'COMPLAINT', priority: 'HIGH', title: '[DEMO] 收到商品外盒破損', description: '[DEMO] 買家反映外盒壓壞，內容物完整', dueDate: d(-1), assigneeUserId: editor.userId as string, internalNote: '[DEMO] 內部：先確認物流是否有賠償' })).id;
  await setCaseStatus(editor, k1, { to: 'IN_PROGRESS' });
  await addCaseNote(editor, k1, { note: '[DEMO] 已安排補寄新品，預計 3 天內到貨', public: true });
  // 2) 退款申請待核准
  const k2 = (await createCase(editor, { campaignId: c1, orderId: o1[1].id, caseType: 'REFUND', priority: 'MEDIUM', title: '[DEMO] 想退貨：用不習慣', dueDate: d(2), assigneeUserId: editor.userId as string })).id;
  await setCaseStatus(editor, k2, { to: 'IN_PROGRESS' });
  await requestRefund(editor, k2, { amount: half(o1[1].gross_amount), reason: '[DEMO] 買家要求部分退款，已與團主確認' });
  // 3) 新進件的換貨
  await createCase(editor, { campaignId: c1, orderId: o1[2].id, caseType: 'EXCHANGE', priority: 'LOW', title: '[DEMO] 規格選錯，想換 120ml', dueDate: d(3) });
  // 4) 退款已核准、等財務完成（案件等待廠商）
  const k4 = (await createCase(manager, { campaignId: c4, orderId: o4[0].id, caseType: 'REFUND', priority: 'HIGH', title: '[DEMO] 蠟燭有裂痕，要求退款', dueDate: d(1), assigneeUserId: manager.userId as string })).id;
  await setCaseStatus(manager, k4, { to: 'WAITING_VENDOR', note: '[DEMO] 已通知廠商確認瑕疵' });
  const r4 = await requestRefund(editor, k4, { amount: o4[0].gross_amount, reason: '[DEMO] 商品瑕疵，全額退款' });
  await decideRefund(manager, r4.id, { decision: 'APPROVED', note: '[DEMO] 瑕疵屬實' });
  // 5) 退款已完成並寫回訂單 → 案件結案
  const k5 = (await createCase(editor, { campaignId: c4, orderId: o4[1].id, caseType: 'REFUND', priority: 'MEDIUM', title: '[DEMO] 重複下單，退回一筆' })).id;
  await setCaseStatus(editor, k5, { to: 'IN_PROGRESS' });
  const r5 = await requestRefund(editor, k5, { amount: half(o4[1].gross_amount), reason: '[DEMO] 重複下單' });
  await decideRefund(manager, r5.id, { decision: 'APPROVED' });
  await completeRefund(finance, r5.id, { writeback: true, note: '[DEMO] 已退刷，並寫回訂單' });
  await setCaseStatus(editor, k5, { to: 'RESOLVED', resolution: '[DEMO] 已退回重複訂單的款項' });
  await setCaseStatus(manager, k5, { to: 'CLOSED' });
  // 6) 退款被退回 → 已解決
  const k6 = (await createCase(editor, { campaignId: c4, orderId: o4[2].id, caseType: 'REFUND', priority: 'LOW', title: '[DEMO] 超過鑑賞期的退貨要求' })).id;
  const r6 = await requestRefund(editor, k6, { amount: o4[2].gross_amount, reason: '[DEMO] 買家要求退貨' });
  await decideRefund(manager, r6.id, { decision: 'REJECTED', note: '[DEMO] 已超過 7 天鑑賞期' });
  await setCaseStatus(editor, k6, { to: 'RESOLVED', resolution: '[DEMO] 已向買家說明退貨規定' });
  // 7) 取消的重複案件
  const k7 = (await createCase(editor, { campaignId: c1, caseType: 'OTHER', priority: 'LOW', title: '[DEMO] 團主詢問結算時間（重複開案）' })).id;
  await setCaseStatus(editor, k7, { to: 'CANCELLED', note: '[DEMO] 與另一案件重複' });
  console.log('售後 DEMO 資料已建立：7 件案件、4 筆退款申請（待核准 1／待完成 1／已完成 1／已退回 1）。');
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(closePool);
