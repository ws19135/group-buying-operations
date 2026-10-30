import { closePool, query } from '../src/server/lib/db';
import { migrate } from '../src/server/lib/migrate';
import { appEnv } from '../src/server/lib/config';
import { todayTaipei } from '../src/server/lib/ids';
import { addDays } from '../src/server/lib/dates';
import type { Actor, RoleKey } from '../src/server/lib/permissions';
import { createProduct } from '../src/server/modules/products';
import { createCampaign } from '../src/server/modules/campaigns';
import { importOrders } from '../src/server/modules/orders';
import { loadEnv } from './load-env';

/**
 * 商品目錄 DEMO 種子：讓每家 [DEMO] 廠商（含「新進件品牌」）都有數個團購商品與近期訂單，
 * 好在儀表板「跨團主業績比較」示範「先選廠商 → 再選團購商品」。必須先執行 db:seed:demo。
 * 冪等：已有 [DEMO] 護手霜就略過。拒絕在 production 執行（除非明確允許公開示範環境）。全部是虛構的名稱、價格與訂單。
 */
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

interface Sku { code: string; name: string; list: number; group: number; cost: number }
interface Plan { vendor: string; title: string; products: { name: string; skus: Sku[] }[]; hosts: string[] }

const PLANS: Plan[] = [
  { vendor: '[DEMO] 晴空保養', title: '[DEMO] 秋冬保養組合團', hosts: ['[DEMO] 小雅媽咪', '[DEMO] 阿凱生活'], products: [
    { name: '[DEMO] 舒緩護手霜', skus: [{ code: 'HAND-1', name: '50g', list: 380, group: 290, cost: 120 }] },
    { name: '[DEMO] 溫和潔顏慕斯', skus: [{ code: 'FOAM-1', name: '150ml', list: 520, group: 390, cost: 160 }, { code: 'FOAM-2', name: '補充包', list: 420, group: 320, cost: 130 }] }] },
  { vendor: '[DEMO] 暖食堂', title: '[DEMO] 暖食堂秋季伴手禮團', hosts: ['[DEMO] 阿凱生活', '[DEMO] 米粒日常'], products: [
    { name: '[DEMO] 蔥油拌醬', skus: [{ code: 'SAU-1', name: '單罐', list: 220, group: 180, cost: 80 }] },
    { name: '[DEMO] 手工牛軋糖', skus: [{ code: 'NOU-1', name: '小包', list: 260, group: 210, cost: 90 }, { code: 'NOU-2', name: '禮盒', list: 520, group: 430, cost: 180 }] }] },
  { vendor: '[DEMO] 森活家居', title: '[DEMO] 居家收納選物團', hosts: ['[DEMO] 小雅媽咪', '[DEMO] 米粒日常'], products: [
    { name: '[DEMO] 竹纖維毛巾組', skus: [{ code: 'TWL-1', name: '三入', list: 480, group: 360, cost: 150 }] },
    { name: '[DEMO] 木質收納盒', skus: [{ code: 'BOX-1', name: '小', list: 350, group: 270, cost: 110 }, { code: 'BOX-2', name: '大', list: 690, group: 520, cost: 230 }] }] },
  { vendor: '[DEMO] 新進件品牌', title: '[DEMO] 新品牌首發試賣團', hosts: ['[DEMO] 米粒日常', '[DEMO] 阿凱生活'], products: [
    { name: '[DEMO] 有機燕麥脆片', skus: [{ code: 'OAT-1', name: '300g', list: 320, group: 250, cost: 100 }] },
    { name: '[DEMO] 冷萃咖啡包', skus: [{ code: 'CFE-1', name: '10入', list: 450, group: 360, cost: 150 }] }] },
];

async function main() {
  loadEnv();
  if (appEnv() === 'production' && process.env.ALLOW_DEMO_IN_PRODUCTION !== 'yes') {
    throw new Error('拒絕在 production 建立 DEMO 資料。只有「公開示範環境」才可設定 ALLOW_DEMO_IN_PRODUCTION=yes');
  }
  await migrate();
  const actorOf = async (key: string, role: RoleKey): Promise<Actor> => {
    const [u] = await query<{ id: string; organization_id: string }>(`SELECT id, organization_id FROM users WHERE lower(email)=$1 AND deleted_at IS NULL`, [`demo-${key}@example.invalid`]);
    if (!u) throw new Error(`找不到 demo-${key}，請先執行 npm run db:seed:demo`);
    return { type: 'USER', userId: u.id, orgId: u.organization_id, role, name: `demo-${key}`, hostIds: [], vendorIds: [], requestId: 'demo-catalog', source: 'SEED' };
  };
  const manager = await actorOf('manager', 'OPS_MANAGER');
  const admin = await actorOf('admin', 'SYSTEM_ADMIN');
  const orgId = manager.orgId;
  if ((await query(`SELECT 1 FROM products WHERE organization_id=$1 AND name='[DEMO] 舒緩護手霜' LIMIT 1`, [orgId])).length) { console.log('商品目錄 DEMO 資料已存在（略過）。'); return; }
  const one = async (sql: string, p: unknown[], what: string) => {
    const [r] = await query<{ id: string }>(sql, p);
    if (!r) throw new Error(`找不到${what}，請先執行 npm run db:seed:demo`);
    return r.id;
  };
  const t = todayTaipei();
  const d = (n: number) => addDays(t, n);
  const rand = rng(20261030);
  const rows: string[] = ['source_order_id,campaign_id,ordered_at,status,quantity,unit_price,sku_code,buyer_ref,host_id,community_id,refund_amount'];
  let n = 0;
  let products = 0;
  for (const plan of PLANS) {
    const vendorId = await one(`SELECT id FROM vendors WHERE organization_id=$1 AND name=$2 AND deleted_at IS NULL`, [orgId, plan.vendor], `廠商 ${plan.vendor}`);
    const hostIds: string[] = [];
    for (const h of plan.hosts) hostIds.push(await one(`SELECT id FROM hosts WHERE organization_id=$1 AND display_name=$2 AND deleted_at IS NULL`, [orgId, h], `團主 ${h}`));
    const made: { id: string; skuIds: string[]; skus: Sku[] }[] = [];
    for (const p of plan.products) {
      const r = await createProduct(manager, { vendorId, name: p.name, skus: p.skus.map((s) => ({ skuCode: s.code, name: s.name, listPrice: s.list, groupPrice: s.group, costPrice: s.cost })) });
      made.push({ id: r.id, skuIds: r.skuIds, skus: p.skus });
      products++;
    }
    await query(`UPDATE products SET review_status='APPROVED', reviewed_by=$2, reviewed_at=now() WHERE id = ANY($1::text[])`, [made.map((m) => m.id), manager.userId]);
    const c = await createCampaign(manager, { title: plan.title, vendorId, ownerUserId: manager.userId as string, sampleReadyDate: d(-30), openDate: d(-9), closeDate: d(10), targetRevenue: 100000,
      products: made.flatMap((m) => m.skuIds.map((s) => ({ productId: m.id, skuId: s }))), hosts: hostIds.map((h) => ({ hostId: h, targetRevenue: 50000 })) });
    await query(`UPDATE campaign_hosts SET status='CONFIRMED', responded_at=now() WHERE campaign_id=$1`, [c.id]);
    await query(`UPDATE campaigns SET status='RUNNING' WHERE id=$1`, [c.id]);
    for (const gate of ['G1', 'G2']) {
      await query(`INSERT INTO approvals (id, organization_id, campaign_id, gate_key, status, requested_by, decided_by, decided_at, decision_note)
        VALUES ('APR-D'||substr(md5(random()::text),1,8), $1,$2,$3,'APPROVED',$4,$4,now(),'[DEMO] 示範核准')`, [orgId, c.id, gate, manager.userId]);
    }
    // 訂單：近 9 天，兩位團主分攤；每個商品都有訂單（才看得到商品篩選的差異）
    const allSkus = made.flatMap((m) => m.skus);
    for (let i = 0; i < 36; i++) {
      n++;
      const day = d(-Math.floor(rand() * 10));
      const nowHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
      const maxH = day === t ? Math.max(1, nowHour) : 22;
      const hh = String(Math.min(maxH - 1, 8 + Math.floor(rand() * 14))).padStart(2, '0'), mm = String(Math.floor(rand() * 60)).padStart(2, '0');
      const r = rand();
      const status = r < 0.85 ? 'PAID' : r < 0.92 ? 'PARTIAL_REFUND' : r < 0.96 ? 'CANCELLED' : 'PENDING';
      const host = hostIds[Math.floor(rand() * hostIds.length)];
      const lines = 1 + Math.floor(rand() * 2);
      const picked: { s: Sku; q: number }[] = [];
      // 前幾筆輪流指定商品，確保每個商品至少有訂單
      for (let k = 0; k < lines; k++) picked.push({ s: k === 0 && i < allSkus.length ? allSkus[i] : allSkus[Math.floor(rand() * allSkus.length)], q: 1 + Math.floor(rand() * 3) });
      const gross = picked.reduce((a, l) => a + l.s.group * l.q, 0);
      const refund = status === 'PARTIAL_REFUND' ? Math.max(1, Math.floor(gross / 3)) : 0;
      picked.forEach((l, k) => rows.push(`DEMO-C${String(n).padStart(5, '0')},${c.id},${day} ${hh}:${mm},${status},${l.q},${l.s.group},${l.s.code},demo-buyer-c${n},${host},,${k === 0 && refund ? refund : ''}`));
    }
  }
  const imp = await importOrders({ ...admin, source: 'SEED' }, { sourceSystem: 'DEMO_GENERATOR', origin: 'DEMO', fileName: 'demo-catalog-orders.csv', csv: rows.join('\n') });
  console.log(`商品目錄 DEMO 資料已建立：${PLANS.length} 檔團購、${products} 個商品、${imp.insertedOrders} 張訂單（data_origin=DEMO）。`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(closePool);
