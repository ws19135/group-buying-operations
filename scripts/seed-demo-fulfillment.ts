import { closePool, query } from '../src/server/lib/db';
import { migrate } from '../src/server/lib/migrate';
import { appEnv } from '../src/server/lib/config';
import { addDays } from '../src/server/lib/dates';
import { todayTaipei } from '../src/server/lib/ids';
import type { Actor } from '../src/server/lib/permissions';
import { addShipment, adjustStock, confirmReceipt, createBatch, setShipmentStatus } from '../src/server/modules/fulfillment';
import { loadEnv } from './load-env';

/**
 * 履約 DEMO 種子：在既有的 [DEMO] 檔期上建立虛構的出貨批次、出貨單與庫存。
 * 必須先執行 db:seed:demo。冪等：已有 [DEMO] 批次的檔期會略過。拒絕在 production 執行（除非明確允許公開示範環境）。
 */
async function main() {
  loadEnv();
  if (appEnv() === 'production' && process.env.ALLOW_DEMO_IN_PRODUCTION !== 'yes') {
    throw new Error('拒絕在 production 建立 DEMO 資料。只有「公開示範環境」才可設定 ALLOW_DEMO_IN_PRODUCTION=yes');
  }
  await migrate();
  const [mgr] = await query<{ id: string; organization_id: string }>(`SELECT id, organization_id FROM users WHERE lower(email)='demo-manager@example.invalid' AND deleted_at IS NULL`);
  if (!mgr) throw new Error('找不到 demo-manager，請先執行 npm run db:seed:demo');
  const manager: Actor = { type: 'USER', userId: mgr.id, orgId: mgr.organization_id, role: 'OPS_MANAGER', name: 'demo-manager', hostIds: [], vendorIds: [], requestId: 'demo-fulfillment', source: 'SEED' };
  const today = todayTaipei();
  const d = (n: number) => addDays(today, n);

  const camps = await query<{ id: string; title: string; status: string }>(
    `SELECT id, title, status FROM campaigns WHERE organization_id=$1 AND title LIKE '[DEMO]%' AND deleted_at IS NULL AND status NOT IN ('CANCELLED','CLOSED','ON_HOLD') ORDER BY created_at`, [manager.orgId]);
  const orderOk = ['SCHEDULED', 'RUNNING', 'PENDING_CLOSE_CHECK', 'FULFILLING', 'PENDING_SETTLEMENT', 'SETTLED'];
  let made = 0;
  for (const c of camps) {
    const had = await query(`SELECT 1 FROM fulfillment_batches WHERE campaign_id=$1 AND label LIKE '[DEMO]%' LIMIT 1`, [c.id]);
    if (had.length) continue;
    const skus = await query<{ sku_id: string }>(`SELECT sku_id FROM campaign_products WHERE campaign_id=$1 AND sku_id IS NOT NULL AND deleted_at IS NULL ORDER BY id`, [c.id]);
    const sku = skus[0]?.sku_id;
    const track = (n: string) => `DEMO-${c.id.slice(-4)}-${n}`;

    if (orderOk.includes(c.status)) {
      const b1 = await createBatch(manager, c.id, { kind: 'ORDER', label: '[DEMO] 第一批出貨', plannedShipDate: d(-4), note: '[DEMO] 內部備註：優先出貨' });
      const a = await addShipment(manager, b1.id, { skuId: sku, quantity: 60, carrier: '黑貓', trackingNo: track('A1'), plannedDate: d(-4) });
      const b = await addShipment(manager, b1.id, { skuId: sku, quantity: 40, carrier: '新竹物流', trackingNo: track('A2'), plannedDate: d(-3) });
      const e = await addShipment(manager, b1.id, { skuId: sku, quantity: 25, plannedDate: d(2) });
      for (const s of [a.id, b.id]) { await setShipmentStatus(manager, s, { to: 'PACKED' }); await setShipmentStatus(manager, s, { to: 'SHIPPED', date: d(-3) }); }
      await setShipmentStatus(manager, a.id, { to: 'DELIVERED', date: d(-1) });
      await confirmReceipt(manager, a.id, { signer: '[DEMO] 團主代收', note: '管理室代收' });
      if (c.status === 'FULFILLING' || c.status === 'PENDING_SETTLEMENT') {
        await setShipmentStatus(manager, b.id, { to: 'EXCEPTION', reason: '[DEMO] 物流回報包裹破損，待補寄' });
      }
      void e;
      if (['FULFILLING', 'PENDING_SETTLEMENT', 'SETTLED'].includes(c.status)) {
        const b2 = await createBatch(manager, c.id, { kind: 'ORDER', label: '[DEMO] 第二批補寄', plannedShipDate: d(-1) });
        const f = await addShipment(manager, b2.id, { skuId: sku, quantity: 40, carrier: '黑貓', trackingNo: track('B1') });
        await setShipmentStatus(manager, f.id, { to: 'PACKED' });
      }
      made++;
    } else {
      const b = await createBatch(manager, c.id, { kind: 'SAMPLE', label: '[DEMO] 寄樣給團主', plannedShipDate: d(-2) });
      const s = await addShipment(manager, b.id, { skuId: sku, quantity: 2, carrier: '黑貓', trackingNo: track('S1') });
      await setShipmentStatus(manager, s.id, { to: 'PACKED' });
      await setShipmentStatus(manager, s.id, { to: 'SHIPPED', date: d(-2) });
      await setShipmentStatus(manager, s.id, { to: 'DELIVERED', date: d(-1) });
      made++;
    }
    // 庫存：每個檔期的第一個規格建立期初庫存，並登錄一筆損耗
    if (sku) {
      const any = await query(`SELECT 1 FROM inventory_movements WHERE sku_id=$1 LIMIT 1`, [sku]);
      if (!any.length) {
        await adjustStock(manager, { skuId: sku, campaignId: c.id, delta: 300, reasonCode: 'INITIAL', reason: '[DEMO] 期初盤點' });
        await adjustStock(manager, { skuId: sku, campaignId: c.id, delta: -5, reasonCode: 'DAMAGE', reason: '[DEMO] 運送破損' });
      }
    }
  }
  console.log(`履約 DEMO 資料完成：${made} 檔期新增出貨批次（略過 ${camps.length - made} 檔）。`);
  await closePool();
}

main().catch(async (e) => { console.error(e); await closePool(); process.exit(1); });
