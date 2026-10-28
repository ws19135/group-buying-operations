import { closePool, query } from '../src/server/lib/db';
import { migrate } from '../src/server/lib/migrate';
import { appEnv } from '../src/server/lib/config';
import { addDays } from '../src/server/lib/dates';
import { todayTaipei } from '../src/server/lib/ids';
import type { Actor } from '../src/server/lib/permissions';
import { addAdjustment, confirmSettlement, createSettlement, getSettlement } from '../src/server/modules/settlements';
import { createExpense, createInvoice, createPayment, issueInvoice, matchPayment } from '../src/server/modules/finance';
import { loadEnv } from './load-env';

/**
 * 財務 DEMO 種子：在既有的 [DEMO] 檔期上建立虛構的結算試算、入帳／付款紀錄、發票紀錄與費用。
 * 必須先執行 db:seed:demo。冪等：已有 DEMO 入帳紀錄就略過。拒絕在 production 執行（除非明確允許公開示範環境）。
 * 全部是紀錄：不連接任何金流、銀行或電子發票；參考號、抬頭、統編都是佔位字。
 */
async function main() {
  loadEnv();
  if (appEnv() === 'production' && process.env.ALLOW_DEMO_IN_PRODUCTION !== 'yes') {
    throw new Error('拒絕在 production 建立 DEMO 資料。只有「公開示範環境」才可設定 ALLOW_DEMO_IN_PRODUCTION=yes');
  }
  await migrate();
  const [u] = await query<{ id: string; organization_id: string }>(`SELECT id, organization_id FROM users WHERE lower(email)='demo-finance@example.invalid' AND deleted_at IS NULL`);
  if (!u) throw new Error('找不到 demo-finance，請先執行 npm run db:seed:demo');
  const finance: Actor = { type: 'USER', userId: u.id, orgId: u.organization_id, role: 'FINANCE', name: 'demo-finance', hostIds: [], vendorIds: [], requestId: 'demo-finance', source: 'SEED' };
  const had = await query(`SELECT 1 FROM payments WHERE organization_id=$1 AND reference_no LIKE 'DEMO-%' LIMIT 1`, [finance.orgId]);
  if (had.length) { console.log('財務 DEMO 資料已存在（略過）。'); return; }

  const today = todayTaipei();
  const settleable = ['RUNNING', 'PENDING_CLOSE_CHECK', 'FULFILLING', 'PENDING_SETTLEMENT', 'SETTLED', 'CLOSED'];
  const camps = await query<{ id: string; title: string; status: string }>(
    `SELECT c.id, c.title, c.status FROM campaigns c WHERE c.organization_id=$1 AND c.title LIKE '[DEMO]%' AND c.deleted_at IS NULL AND c.status = ANY($2::text[])
       AND EXISTS (SELECT 1 FROM orders o WHERE o.campaign_id=c.id) ORDER BY c.created_at`, [finance.orgId, settleable]);
  let n = 0;
  for (const c of camps) {
    n++;
    const s = await createSettlement(finance, { campaignId: c.id, note: '[DEMO] 虛構的結算試算' });
    const d = await getSettlement(finance, s.id);
    const first = d.items.find((i) => i.commissionAuto != null);
    // 第一檔維持草稿並加一筆調整；其餘盡量確認（需所有團主都有金額）
    if (n === 1 && first) await addAdjustment(finance, s.id, { itemId: first.id, amount: -200, reason: '[DEMO] 運費分攤（虛構）' });
    else if (!d.items.some((i) => i.commissionAuto == null)) {
      await confirmSettlement(finance, s.id, { note: '[DEMO] 已確認（虛構）' });
      if (first && first.commissionAuto) {
        const p = await createPayment(finance, { direction: 'OUT', counterpartyType: 'HOST', counterpartyId: first.hostId, amount: first.commissionAuto, paidOn: addDays(today, -1), referenceNo: `DEMO-PAY-OUT-${c.id.slice(-4)}`, note: '[DEMO] 佣金付款（虛構）', settlementItemId: first.id });
        await matchPayment(finance, p.id);
      }
    }
    await createPayment(finance, { direction: 'IN', counterpartyType: 'PLATFORM', amount: 30000 + n * 1000, paidOn: addDays(today, -2), referenceNo: `DEMO-PAY-IN-${c.id.slice(-4)}`, note: '[DEMO] 平台撥款（虛構）', campaignId: c.id });
    await createExpense(finance, { category: 'SHIPPING', amount: 450 + n * 50, incurredOn: addDays(today, -3), campaignId: c.id, note: '[DEMO] 樣品運費（虛構）' });
    await createExpense(finance, { category: 'MARKETING', amount: 1200, incurredOn: addDays(today, -2), campaignId: c.id, note: '[DEMO] 行銷素材（虛構）' });
    const inv = await createInvoice(finance, { invoiceNo: `DEMO-INV-${c.id.slice(-4)}`, invoiceDate: addDays(today, -1), amount: 12000 + n * 500, titleText: '<佔位抬頭>', taxIdText: '<佔位統編>', campaignId: c.id, note: '[DEMO] 發票紀錄（虛構，非真實發票）' });
    if (n % 2 === 1) await issueInvoice(finance, inv.id);
  }
  console.log(`已建立財務 DEMO 資料：${camps.length} 個檔期的結算試算、入帳／付款、費用與發票紀錄（全部虛構）。`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => closePool());
