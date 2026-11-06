import { closePool, query } from '../src/server/lib/db';
import { migrate } from '../src/server/lib/migrate';
import { appEnv } from '../src/server/lib/config';
import type { Actor, RoleKey } from '../src/server/lib/permissions';
import { todayTaipei } from '../src/server/lib/ids';
import { addDays } from '../src/server/lib/dates';
import * as collab from '../src/server/modules/collaboration';
import { loadEnv } from './load-env';

/**
 * 合作申請與樣品管理（COLLABORATION_APPLICATIONS）DEMO 種子。必須先執行 db:seed:demo。
 * 冪等：已有合作申請就略過。拒絕在 production 執行（除非明確允許公開示範環境）。
 *
 * 全部虛構。收件人姓名／電話／地址用的是保留測試值（0200000000 開頭的電話、example.invalid 網域、
 * 虛構街名），**不得**換成任何真實個資——這支腳本只用來跑示範環境。
 *
 * 蓋到的情境：
 *   A 完整流程：建立 → 廠商確認供樣 → 寄出 → 團主確認收件 → 回覆願意 → 確認合作 → 關聯正式檔期
 *   B 分兩批寄：首次只寄一部分，之後補寄（「是否已補寄」由紀錄推導，不是打勾）
 *   C 團主試用後暫不開團：意願「未決定」，案件停在待回覆
 *   D 廠商部分供樣：申請三項、只供兩項（第三項 UNAVAILABLE）
 *   E 寄樣前就先談好預計開團日：planned 有值、confirmed 還沒有
 *   F 團主自己申請（HOST_FORM 來源，尚未審核）
 */
async function main() {
  loadEnv();
  if (appEnv() === 'production' && process.env.ALLOW_DEMO_IN_PRODUCTION !== 'yes') {
    throw new Error('拒絕在 production 建立 DEMO 資料。只有「公開示範環境」才可設定 ALLOW_DEMO_IN_PRODUCTION=yes');
  }
  await migrate();

  const actorOf = async (key: string, role: RoleKey): Promise<Actor> => {
    const [u] = await query<{ id: string; organization_id: string }>(
      `SELECT id, organization_id FROM users WHERE lower(email)=$1 AND deleted_at IS NULL`, [`demo-${key}@example.invalid`]);
    if (!u) throw new Error(`找不到 demo-${key}，請先執行 npm run db:seed:demo`);
    const scopes = await query<{ scope_type: string; scope_id: string }>(
      `SELECT scope_type, scope_id FROM user_scopes WHERE user_id=$1 AND revoked_at IS NULL`, [u.id]);
    const hostIds = scopes.filter((r) => r.scope_type === 'HOST').map((r) => r.scope_id);
    const vendorIds = scopes.filter((r) => r.scope_type === 'VENDOR').map((r) => r.scope_id);
    return { type: 'USER', userId: u.id, orgId: u.organization_id, role, name: `demo-${key}`, hostIds, vendorIds, requestId: 'demo-collaboration', source: 'SEED' };
  };

  const manager = await actorOf('manager', 'OPS_MANAGER');
  const editor = await actorOf('editor', 'OPS_EDITOR');
  const vendorUser = await actorOf('vendor', 'VENDOR');
  const host1 = await actorOf('host1', 'HOST');
  const orgId = manager.orgId;

  if ((await query(`SELECT 1 FROM collaboration_applications WHERE organization_id=$1 LIMIT 1`, [orgId])).length) {
    console.log('合作申請 DEMO 資料已存在（略過）。');
    return;
  }

  const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[], what: string): Promise<T> => {
    const [r] = await query<T>(sql, params);
    if (!r) throw new Error(`找不到 ${what}，請先執行 npm run db:seed:demo`);
    return r;
  };
  const vendor = (name: string) => one<{ id: string }>(`SELECT id FROM vendors WHERE organization_id=$1 AND name=$2 AND deleted_at IS NULL`, [orgId, name], `廠商 ${name}`);
  const host = (name: string) => one<{ id: string }>(`SELECT id FROM hosts WHERE organization_id=$1 AND display_name=$2 AND deleted_at IS NULL`, [orgId, name], `團主 ${name}`);
  const product = (name: string) => one<{ id: string }>(`SELECT id FROM products WHERE organization_id=$1 AND name=$2 AND deleted_at IS NULL`, [orgId, name], `商品 ${name}`);
  const sku = async (productId: string, code: string) =>
    (await one<{ id: string }>(`SELECT id FROM skus WHERE product_id=$1 AND sku_code=$2 AND deleted_at IS NULL`, [productId, code], `規格 ${code}`)).id;
  const itemsOf = (appId: string) => query<{ id: string; product_id: string; sku_id: string | null }>(
    `SELECT id, product_id, sku_id FROM collaboration_application_items WHERE application_id=$1 AND deleted_at IS NULL ORDER BY id`, [appId]);

  const v1 = (await vendor('[DEMO] 晴空保養')).id;
  const v2 = (await vendor('[DEMO] 暖食堂')).id;
  const h1 = (await host('[DEMO] 小雅媽咪')).id;
  const h2 = (await host('[DEMO] 阿凱生活')).id;
  const h3 = (await host('[DEMO] 米粒日常')).id;
  const pSun = (await product('[DEMO] 清爽防曬噴霧')).id;
  const pMask = (await product('[DEMO] 保濕面膜')).id;
  const pCookie = (await product('[DEMO] 手作餅乾禮盒')).id;
  const sunSku = await sku(pSun, 'SUN-50');
  const maskSku = await sku(pMask, 'MASK-5');
  const today = todayTaipei();
  const d = (n: number) => addDays(today, n);

  // 收件資料一律用保留測試值（勿換成真實個資）
  const recipient = (name: string, phone: string, address: string) => ({
    recipientName: `[DEMO] ${name}`, recipientPhone: phone, postalCode: '10001',
    addressLine: `[DEMO] 台北市虛構區示範路 ${address}`, deliveryNote: '[DEMO] 平日白天可收', confirm: true,
  });

  // ---- A 完整流程：一路走到關聯正式檔期 ----
  const a = (await collab.createApplication(editor, {
    vendorId: v1, hostId: h1, source: 'OPS', appliedOn: d(-30), ownerUserId: editor.userId,
    note: '[DEMO] 小雅媽咪想試防曬噴霧，親子客群適合',
    items: [{ productId: pSun, skuId: sunSku, requestedQty: 2, requestReason: '[DEMO] 自己與孩子各一瓶' }],
  })).id;
  await collab.putRecipient(editor, a, recipient('小雅媽咪', '0200000001', '1 號 3 樓'));
  await collab.submitApplication(editor, a);
  await collab.internalReview(manager, a, { decision: 'TO_VENDOR', note: '[DEMO] 客群相符，請廠商確認供樣' });
  const aItems = await itemsOf(a);
  await collab.vendorReview(vendorUser, a, { decision: 'SUPPLY', items: [{ itemId: aItems[0].id, approvedQty: 2, vendorNote: '[DEMO] 可供兩瓶' }], note: '[DEMO] 本週出貨' });
  const aShip = (await collab.addShipment(vendorUser, a, {
    shipmentType: 'INITIAL', shippedByParty: 'VENDOR', shipDate: d(-24), carrier: '[DEMO] 示範物流', trackingNo: 'DEMO-CLB-0001', quantity: 2,
  })).id;
  await collab.confirmReceipt(host1, aShip, { receivedOn: d(-22), receiptNote: '[DEMO] 已收到，質地清爽' });
  await collab.putLaunch(host1, a, { intent: 'WILLING', intentRespondedOn: d(-20), plannedOpenDate: d(-10), intentNote: '[DEMO] 願意開團，想排在月初' });
  await collab.confirmCollaboration(manager, a, { confirmedOpenDate: d(-3), note: '[DEMO] 與團主確認檔期' });
  const [camp] = await query<{ id: string }>(`SELECT id FROM campaigns WHERE organization_id=$1 AND title=$2 AND deleted_at IS NULL`, [orgId, '[DEMO] 夏日防曬噴霧團購']);
  if (camp) await collab.linkCampaign(manager, a, camp.id);
  await collab.putLaunch(manager, a, { launchUrl: 'https://shop.example.invalid/demo/sunspray', adsIntent: 'YES', adsNote: '[DEMO] 投廣由廠商負擔' });
  await collab.putVendorLaunch(vendorUser, a, {
    vendorPortalUrl: 'https://portal.example.invalid/demo/vendor/sunspray',
    backendSetupEmail: 'demo-backend@example.invalid', backendSetupStatus: 'DONE',
    backendSetupNote: '[DEMO] 後台帳號已開，連結只給有權限的人看', adsConfirmStatus: 'CONFIRMED',
  });

  // ---- B 分兩批寄：首次 1 入，之後補寄 1 入 ----
  const b = (await collab.createApplication(editor, {
    vendorId: v1, hostId: h3, source: 'OPS', appliedOn: d(-21),
    items: [{ productId: pMask, skuId: maskSku, requestedQty: 2 }],
  })).id;
  await collab.putRecipient(editor, b, recipient('米粒', '0200000003', '33 號'));
  await collab.submitApplication(editor, b);
  await collab.internalReview(manager, b, { decision: 'TO_VENDOR', note: '[DEMO] 轉廠商確認供樣' });
  const bItems = await itemsOf(b);
  await collab.vendorReview(vendorUser, b, { decision: 'SUPPLY', items: [{ itemId: bItems[0].id, approvedQty: 2 }] });
  const bShip1 = (await collab.addShipment(vendorUser, b, { shipmentType: 'INITIAL', shipDate: d(-16), carrier: '[DEMO] 示範物流', trackingNo: 'DEMO-CLB-0002', quantity: 1, note: '[DEMO] 先寄一盒，另一盒缺貨' })).id;
  await collab.confirmReceipt(editor, bShip1, { receivedOn: d(-14), receiptNote: '[DEMO] 團主回報已收到第一盒' });
  await collab.addShipment(vendorUser, b, { shipmentType: 'RESEND', shipDate: d(-6), carrier: '[DEMO] 示範物流', trackingNo: 'DEMO-CLB-0003', quantity: 1, note: '[DEMO] 補寄第二盒' });
  await collab.putLaunch(editor, b, { intent: 'WILLING', intentRespondedOn: d(-4), plannedOpenDate: d(20), intentNote: '[DEMO] 想等補寄那盒拍完照再開' });

  // ---- C 試用後暫不開團：意願未決定 ----
  const c = (await collab.createApplication(editor, {
    vendorId: v2, hostId: h2, source: 'OPS', appliedOn: d(-18),
    items: [{ productId: pCookie, requestedQty: 1, requestReason: '[DEMO] 想先試口味' }],
  })).id;
  await collab.putRecipient(editor, c, recipient('阿凱', '0200000002', '7 號 2 樓'));
  await collab.submitApplication(editor, c);
  await collab.internalReview(manager, c, { decision: 'TO_VENDOR', note: '[DEMO] 轉廠商確認供樣' });
  const cItems = await itemsOf(c);
  await collab.vendorReview(manager, c, { decision: 'SUPPLY', items: [{ itemId: cItems[0].id, approvedQty: 1 }], note: '[DEMO] 由營運代廠商確認' });
  const cShip = (await collab.addShipment(editor, c, { shipmentType: 'INITIAL', shippedByParty: 'OPS', shipDate: d(-12), trackingNo: 'DEMO-CLB-0004', quantity: 1 })).id;
  await collab.confirmReceipt(editor, cShip, { receivedOn: d(-10), receiptNote: '[DEMO] 團主回報已收到' });
  await collab.putLaunch(editor, c, { intent: 'UNDECIDED', intentRespondedOn: d(-8), intentNote: '[DEMO] 口味喜歡，但這季檔期滿了，想下一季再談' });

  // ---- D 廠商部分供樣：申請三項、只供兩項 ----
  const dApp = (await collab.createApplication(editor, {
    vendorId: v1, hostId: h2, source: 'OPS', appliedOn: d(-9),
    items: [
      { productId: pSun, skuId: sunSku, requestedQty: 2 },
      { productId: pMask, skuId: maskSku, requestedQty: 3 },
    ],
  })).id;
  await collab.addItem(editor, dApp, { productId: pSun, requestedQty: 1, requestReason: '[DEMO] 想多要一瓶送抽獎' });
  await collab.submitApplication(editor, dApp);
  await collab.internalReview(manager, dApp, { decision: 'TO_VENDOR', note: '[DEMO] 轉廠商確認供樣' });
  const dItems = await itemsOf(dApp);
  await collab.vendorReview(vendorUser, dApp, {
    decision: 'SUPPLY',
    items: [
      { itemId: dItems[0].id, approvedQty: 2 },
      { itemId: dItems[1].id, approvedQty: 1, vendorNote: '[DEMO] 面膜庫存只剩一盒' },
      { itemId: dItems[2].id, approvedQty: 0, vendorNote: '[DEMO] 抽獎用樣品本季不提供' },
    ],
    note: '[DEMO] 部分供樣',
  });

  // ---- E 寄樣前就先談好預計開團日 ----
  const e = (await collab.createApplication(editor, {
    vendorId: v2, hostId: h1, source: 'VENDOR_FORM', appliedOn: d(-5),
    items: [{ productId: pCookie, requestedQty: 1 }],
  })).id;
  await collab.submitApplication(editor, e);
  await collab.internalReview(manager, e, { decision: 'TO_VENDOR', note: '[DEMO] 轉廠商確認供樣' });
  const eItems = await itemsOf(e);
  await collab.vendorReview(manager, e, { items: [{ itemId: eItems[0].id, approvedQty: 1 }], decision: 'SUPPLY' });
  await collab.putLaunch(editor, e, { intent: 'WILLING', intentRespondedOn: d(-4), plannedOpenDate: d(35), intentNote: '[DEMO] 先排進檔期表，樣品之後再寄' });

  // ---- F 團主自己申請，還沒審核 ----
  const f = (await collab.createApplication(host1, {
    vendorId: v1, hostId: h1, source: 'HOST_FORM', appliedOn: today,
    items: [{ productId: pMask, skuId: maskSku, requestedQty: 1, requestReason: '[DEMO] 想做開箱比較' }],
    note: '[DEMO] 團主自己從手機填的申請',
  })).id;
  await collab.putRecipient(host1, f, recipient('小雅媽咪', '0200000001', '1 號 3 樓'));
  await collab.submitApplication(host1, f);

  const total = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM collaboration_applications WHERE organization_id=$1`, [orgId]))[0].n;
  const ships = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM collaboration_shipments WHERE organization_id=$1`, [orgId]))[0].n;
  console.log(`合作申請 DEMO 建立完成：申請單 ${total} 筆、寄送紀錄 ${ships} 筆（含補寄）。`);
}

main().then(() => closePool()).catch(async (e) => { console.error(e); await closePool(); process.exit(1); });
