import { closePool, query } from '../src/server/lib/db';
import { migrate } from '../src/server/lib/migrate';
import { appEnv } from '../src/server/lib/config';
import type { Actor, RoleKey } from '../src/server/lib/permissions';
import { updateHost } from '../src/server/modules/hosts';
import { createProduct } from '../src/server/modules/products';
import { linkHostSegment } from '../src/server/modules/segments';
import { assessCampaign, assessProduct, reviewFit } from '../src/server/modules/fit';
import { loadEnv } from './load-env';

/**
 * 客群分析 DEMO 種子（SOP 01）：為 [DEMO] 團主建立「虛構」的客群輪廓、證據，並產生適配評估。
 * 必須先執行 db:seed:demo。冪等：已有 [DEMO] 客群就略過。拒絕在 production 執行（除非明確允許公開示範環境）。
 * 所有內容都是虛構；觀察紀錄只描述群體，沒有任何個人資料。
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
    return { type: 'USER', userId: u.id, orgId: u.organization_id, role, name: `demo-${key}`, hostIds: [], vendorIds: [], requestId: 'demo-segments', source: 'SEED' };
  };
  const manager = await actorOf('manager', 'OPS_MANAGER');
  const editor = await actorOf('editor', 'OPS_EDITOR');
  const orgId = manager.orgId;
  const had = await query(`SELECT 1 FROM customer_segments WHERE organization_id=$1 AND name LIKE '[DEMO]%' LIMIT 1`, [orgId]);
  if (had.length) { console.log('客群 DEMO 資料已存在（略過）。'); return; }
  const one = async (sql: string, p: unknown[], what: string) => {
    const [r] = await query<{ id: string }>(sql, p);
    if (!r) throw new Error(`找不到${what}，請先執行 npm run db:seed:demo`);
    return r.id;
  };
  const h1 = await one(`SELECT id FROM hosts WHERE organization_id=$1 AND display_name='[DEMO] 小雅媽咪' AND deleted_at IS NULL`, [orgId], '團主 小雅媽咪');
  const h2 = await one(`SELECT id FROM hosts WHERE organization_id=$1 AND display_name='[DEMO] 阿凱生活' AND deleted_at IS NULL`, [orgId], '團主 阿凱生活');
  const comm1 = await one(`SELECT c.id FROM communities c WHERE c.organization_id=$1 AND c.name='[DEMO] 小雅媽咪好物群'`, [orgId], '社群 小雅媽咪好物群');
  const v3 = await one(`SELECT id FROM vendors WHERE organization_id=$1 AND name='[DEMO] 森活家居' AND deleted_at IS NULL`, [orgId], '廠商 森活家居');
  const c3 = await one(`SELECT id FROM campaigns WHERE organization_id=$1 AND title='[DEMO] 保濕面膜試用團' AND deleted_at IS NULL`, [orgId], '檔期 保濕面膜試用團');

  // 合作對象類型（米粒日常刻意不填，示範「未知」）
  await updateHost(manager, h1, { partnerType: 'GROUP_MOM' });
  await updateHost(manager, h2, { partnerType: 'COMMUNITY_OWNER' });

  // 小雅媽咪：Owner 範例輪廓（70%）＋ 第二個客群（30%）。價格帶未提供 → 價格維度為「未知」
  await linkHostSegment(editor, h1, {
    segment: { name: '[DEMO] 育兒家庭 30–44 歲', ageBand: '30_44', familyType: 'PARENTING', cycle: 'MONTHLY', basis: 'ESTIMATE',
      motives: ['省時間', '品質安心'], barriers: ['陌生品牌', '怕踩雷'], categories: ['家庭清潔', '親子用品'], channels: ['LINE'] },
    sharePercent: 70, basis: 'ESTIMATE', communityId: comm1,
    evidence: [{ kind: 'OBSERVATION', basis: 'ESTIMATE', summary: '[DEMO] 客群經常討論育兒、清潔效率、家庭日常補貨。', sourceLabel: '[DEMO] 社群留言整理（虛構）' }],
  });
  await linkHostSegment(editor, h1, {
    segment: { name: '[DEMO] 保養愛好者 25–29 歲', ageBand: '25_29', familyType: 'SINGLE', cycle: 'BIWEEKLY', basis: 'ESTIMATE',
      motives: ['價格划算', '嚐鮮新奇'], barriers: ['價格敏感'], categories: ['保養美妝'], channels: ['LINE', 'INSTAGRAM'] },
    sharePercent: 30, basis: 'ESTIMATE',
  });
  // 阿凱生活：3C 嚐鮮族，價格帶與部分證據為「事實」（有來源）
  await linkHostSegment(editor, h2, {
    segment: { name: '[DEMO] 3C 嚐鮮族', ageBand: '25_29', familyType: 'SINGLE', cycle: 'OCCASIONAL', priceMin: 500, priceMax: 3000, basis: 'FACT',
      motives: [{ value: '嚐鮮新奇', basis: 'FACT' }, '價格划算'], barriers: ['規格不合', '售後疑慮'], categories: [{ value: '3C', basis: 'FACT' }], channels: [{ value: 'LINE', basis: 'FACT' }] },
    sharePercent: 100, basis: 'FACT',
    evidence: [{ kind: 'PLATFORM_STAT', basis: 'FACT', summary: '[DEMO] 近三檔 3C 類訂單占比 80%。', sourceLabel: '[DEMO] 訂單資料彙整（虛構）' }],
  });
  // 米粒日常：刻意不建立客群分析 → 顯示「未建立」、評估為「資料不足」

  // 商品：家庭清潔（對得上小雅媽咪的第一個客群），已審核、有合規備註
  const pDish = await createProduct(manager, { vendorId: v3, name: '[DEMO] 家庭除菌洗衣精', category: '家庭清潔',
    sellingPoints: '[DEMO] 一次洗淨省時，SGS 檢驗安心，七天內不滿意可退換', description: '[DEMO] 虛構商品，濃縮配方，補充包可補貨',
    complianceNote: '[DEMO] 虛構檢驗報告編號 DEMO-0001', skus: [{ skuCode: 'LND-2L', name: '2L 補充包', listPrice: 420, groupPrice: 330, costPrice: 150 }, { skuCode: 'LND-4L', name: '4L 家庭號', listPrice: 760, groupPrice: 600, costPrice: 280 }] });
  await query(`UPDATE products SET review_status='APPROVED', reviewed_by=$2, reviewed_at=now() WHERE id=$1`, [pDish.id, manager.userId]);

  const r = await assessProduct(editor, pDish.id);
  const top = await query<{ id: string; host_id: string }>(`SELECT id, host_id FROM product_fit_assessments WHERE product_id=$1 AND host_id=$2 AND superseded_at IS NULL`, [pDish.id, h1]);
  if (top[0]) await reviewFit(manager, top[0].id, { decision: 'ACCEPTED', note: '[DEMO] 客群與品類相符；價格帶待補後再確認' });
  await assessCampaign(editor, c3);   // 保濕面膜試用團（評估中）：商品 × 已邀請團主
  console.log(`客群 DEMO 資料已建立：3 位團主中的 2 位有客群分析、3 個客群；商品適配評估 ${r.assessed} 筆（1 筆已覆核）；檔期適配 1 檔`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(closePool);
