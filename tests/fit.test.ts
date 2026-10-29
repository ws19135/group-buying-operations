import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { createProduct } from '@/server/modules/products';
import { importOrders } from '@/server/modules/orders';
import { setCampaignHostStatus } from '@/server/modules/campaigns';
import { decideApproval, gateCheck, requestApproval, transitionCampaign } from '@/server/modules/gates';
import { setTaskStatus } from '@/server/modules/tasks';
import { assessCampaign, assessProduct } from '@/server/modules/fit';
import type { Actor } from '@/server/lib/permissions';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkCampaign, mkHost, mkVendor, type World } from './helpers';

const HEADER = 'source_order_id,campaign_id,ordered_at,status,quantity,unit_price,sku_code,buyer_ref,host_id,community_id,refund_amount';
const TEXT = '省時一次洗淨，SGS 檢驗安心，七天退換';

let w: World;
let mgr: Client, ed: Client, fin: Client, hostC: Client, vendorC: Client;
let vendorId: string, pA: string, skuA: string;
let hA: string, hB: string, hC: string;
let c1: string;
let seq = 0;

async function mkProd(over: Record<string, unknown> = {}, approve = true) {
  const r = await createProduct(w.manager, {
    vendorId, name: `[DEMO] 商品${++seq}${Math.random().toString(36).slice(2, 6)}`, category: '家庭清潔', sellingPoints: TEXT, complianceNote: 'SGS 報告 DEMO-001',
    skus: [{ skuCode: 'A', name: '規格A', listPrice: 800, groupPrice: 400 }, { skuCode: 'B', name: '規格B', listPrice: 1000, groupPrice: 600 }], ...over,
  } as never);
  if (approve) await query(`UPDATE products SET review_status='APPROVED' WHERE id=$1`, [r.id]);
  return { id: r.id, skuIds: r.skuIds as string[] };
}

/** 已結單的歷史檔期，並匯入歸因訂單（淨銷售＝單價 × 1） */
async function histCampaign(net: Record<string, number>) {
  const hostIds = Object.keys(net);
  const c = await mkCampaign(w, vendorId, { products: [{ productId: pA, skuId: skuA }], hosts: hostIds.map((hostId) => ({ hostId })), sampleReadyDate: dayOffset(-60), openDate: dayOffset(-30), closeDate: dayOffset(-20) }, w.manager);
  await query(`UPDATE campaigns SET status='RUNNING' WHERE id=$1`, [c.id]);
  const rows = hostIds.map((h, i) => `H${c.id}-${i},${c.id},${dayOffset(-25)} 09:00,PAID,1,${net[h]},A,b${i},${h},,`);
  const r = await importOrders(w.manager, { sourceSystem: 'DEMO_SHOP', fileName: 'hist.csv', csv: [HEADER, ...rows].join('\n') });
  expect(r).toMatchObject({ errorRows: 0 });
  await query(`UPDATE campaigns SET status='CLOSED' WHERE id=$1`, [c.id]);
  return c.id;
}

async function mkShipments(n: number, exceptions = 0) {
  const batch = `FBT-T${Math.random().toString(36).slice(2, 8)}`;
  await query(`INSERT INTO fulfillment_batches (id, organization_id, campaign_id, kind, label) VALUES ($1,$2,$3,'ORDER','DEMO 批次')`, [batch, w.orgId, c1]);
  for (let i = 0; i < n; i++) {
    const st = i < exceptions ? 'EXCEPTION' : 'DELIVERED';
    await query(`INSERT INTO shipments (id, organization_id, campaign_id, batch_id, quantity, status, exception_reason) VALUES ($1,$2,$3,$4,1,$5,$6)`,
      [`SHP-T${Math.random().toString(36).slice(2, 8)}`, w.orgId, c1, batch, st, st === 'EXCEPTION' ? '破損' : null]);
  }
}

beforeAll(async () => {
  w = await makeWorld();
  vendorId = (await mkVendor(w)).id;
  const p = await mkProd();
  pA = p.id; skuA = p.skuIds[0];
  hA = (await mkHost(w, '[DEMO] 小雅媽咪')).id;
  hB = (await mkHost(w, '[DEMO] 阿凱生活')).id;
  hC = (await mkHost(w, '[DEMO] 米粒日常')).id;
  hostC = await Client.forActor(await addUser(w.orgId, 'HOST', { hostIds: [hA] }));
  vendorC = await Client.forActor(await addUser(w.orgId, 'VENDOR', { vendorIds: [vendorId] }));
  [mgr, ed, fin] = await Promise.all([Client.forActor(w.manager), Client.forActor(w.editor), Client.forActor(w.finance)]);

  // hA：Owner 範例輪廓（價格帶未提供）；hB：品類與動機都對不上；hC：沒有客群分析
  await ed.call('POST', `/hosts/${hA}/segments`, {
    segment: { name: '育兒家庭 30–44 歲', ageBand: '30_44', familyType: 'PARENTING', cycle: 'MONTHLY', motives: ['省時間', '品質安心'], barriers: ['陌生品牌', '怕踩雷'], categories: ['家庭清潔', '親子用品'], channels: ['LINE'] },
    basis: 'ESTIMATE', evidence: [{ kind: 'OBSERVATION', summary: '客群經常討論育兒、清潔效率、家庭日常補貨。' }],
  });
  await ed.call('POST', `/hosts/${hB}/segments`, { segment: { name: '3C 嚐鮮族', ageBand: '25_29', categories: ['3C'], motives: ['嚐鮮新奇'] } });

  c1 = await histCampaign({ [hA]: 100_000, [hB]: 20_000 });
  await histCampaign({ [hA]: 100_000, [hB]: 20_000 });
  await mkShipments(5, 0);
});

interface FitRowT {
  id: string; hostId: string; stale: boolean; totalScore: number | null; recommendation: string; confidence: string; completeness: number; campaignId: string | null;
  dimensions: { key: string; score: number | null; known: boolean }[]; hardChecks: { key: string; result: string }[]; reasons: string[];
}
const dims = (item: Pick<FitRowT, 'dimensions'>) => Object.fromEntries(item.dimensions.map((d) => [d.key, d]));
const byHost = (items: FitRowT[], id: string) => items.find((i) => i.hostId === id)!;

describe('評分設定：可配置、有版本、預設是「待確認」', () => {
  it('尚未儲存時回傳內建建議值（待 Owner 確認）；合計不是 100 → 422', async () => {
    const c = await ed.call('GET', '/fit/config');
    expect(c.status).toBe(200);
    expect(c.data).toMatchObject({ approved: false, persisted: false, version: 1, weights: { need: 30, category: 20, price: 15, history: 20, supply: 15 } });
    expect(c.data.status).toContain('待 Owner 確認');
    const bad = await mgr.call('PUT', '/fit/config', { weights: { need: 30, category: 20, price: 15, history: 20, supply: 20 } });
    expect(bad.status).toBe(422);
    expect(bad.error?.message).toContain('合計必須是 100');
    expect((await mgr.call('PUT', '/fit/config', { weights: { need: 30, category: 20, price: 15, history: 20, supply: 15 }, thresholds: { recommend: 60, review: 70, minCompleteness: 0.5, highConfidence: 0.85, mediumConfidence: 0.6 } })).status).toBe(422);
  });
  it('只有 fit.config（管理者／營運主管）能改；營運小編可讀不可改；其他角色不可讀', async () => {
    const body = { weights: { need: 30, category: 20, price: 15, history: 20, supply: 15 } };
    expect((await ed.call('PUT', '/fit/config', body)).status).toBe(403);
    for (const c of [hostC, vendorC, fin]) expect((await c.call('GET', '/fit/config')).status).toBe(403);
  });
});

describe('商品 → 候選團主：評估與排名', () => {
  let items: FitRowT[];
  it('三位團主各自得到評估；資料不足的不是 0 分，而是未知', async () => {
    const r = await ed.call('POST', `/products/${pA}/fit`, {});
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ assessed: 3, unchanged: 0 });
    const list = await ed.call('GET', `/products/${pA}/fit`);
    items = list.data.items;
    expect(items).toHaveLength(3);
    // 排名：建議合作 > 不建議 > 資料不足
    expect(items.map((i) => i.recommendation)).toEqual(['RECOMMEND', 'NOT_RECOMMENDED', 'INSUFFICIENT_DATA']);
    expect(items.map((i) => i.hostId)).toEqual([hA, hB, hC]);

    const a = byHost(items, hA);
    const da = dims(a);
    expect(da.price.known).toBe(false);          // 範例輪廓沒有價格帶 → 未知，不是 0
    expect(da.price.score).toBeNull();
    expect(da.category.score).toBe(5);
    expect(da.need.score).toBe(5);
    expect(da.history.score).toBe(5);            // 同類別 2 檔、平均淨銷售 100k vs 全體 60k
    expect(da.supply.score).toBe(5);
    expect(a.completeness).toBe(0.85);
    expect(a.totalScore).toBe(100);
    expect(a.confidence).toBe('MEDIUM');         // 需求與品類是估計
    expect(a.hardChecks.map((c) => c.result)).toEqual(['PASS', 'PASS']);

    const b = byHost(items, hB);
    expect(dims(b).category.score).toBe(1);
    expect(dims(b).history.score).toBe(2);
    expect(b.totalScore).toBeCloseTo(38.8, 1);

    const c = byHost(items, hC);
    expect(dims(c).need.known).toBe(false);
    expect(dims(c).history.known).toBe(false);
    expect(c.completeness).toBe(0.15);
    expect(c.confidence).toBe('INSUFFICIENT');
    expect(c.reasons.some((x) => x.includes('缺資料：需求'))).toBe(true);
  });
  it('每筆評估保留版本、來源與設定快照；寫入資料庫可讀回', async () => {
    const row = (await query(`SELECT * FROM product_fit_assessments WHERE product_id=$1 AND host_id=$2 AND superseded_at IS NULL`, [pA, hA]))[0];
    expect(row.config_version).toBe(1);
    expect(row.config_snapshot).toMatchObject({ approved: false, weights: { need: 30, category: 20, price: 15, history: 20, supply: 15 }, lexiconVersion: 'v1' });
    expect(row.sources.segments).toHaveLength(1);
    expect(row.sources.segments[0]).toMatchObject({ name: '育兒家庭 30–44 歲', basis: 'ESTIMATE' });
    expect(row.sources.history).toMatchObject({ scope: 'SAME_CATEGORY', hostCampaigns: 2 });
    expect(row.assessed_by).toBe(w.editor.userId);
    expect(row.input_hash).toMatch(/^[0-9a-f]{64}$/);
    const au = await query(`SELECT action FROM audit_logs WHERE entity_id=$1`, [row.id]);
    expect(au.map((a) => a.action)).toContain('fit.assess');
  });
  it('輸入完全相同再評估一次：不新增列（unchanged）', async () => {
    const before = (await query('SELECT count(*)::int AS n FROM product_fit_assessments WHERE product_id=$1', [pA]))[0].n;
    const r = await ed.call('POST', `/products/${pA}/fit`, {});
    expect(r.data).toMatchObject({ assessed: 0, unchanged: 3 });
    expect((await query('SELECT count(*)::int AS n FROM product_fit_assessments WHERE product_id=$1', [pA]))[0].n).toBe(before);
  });
  it('可指定團主清單；不存在的團主 404；只評估指定者', async () => {
    const p = await mkProd();
    const r = await ed.call('POST', `/products/${p.id}/fit`, { hostIds: [hA] });
    expect(r.data.results).toHaveLength(1);
    expect((await ed.call('POST', `/products/${p.id}/fit`, { hostIds: ['OWN-999999'] })).status).toBe(404);
    expect((await ed.call('POST', '/products/PRD-999999/fit', {})).status).toBe(404);
  });
});

describe('輸入或設定改變：產生新版本，舊版保留且不可改', () => {
  it('商品賣點改變 → 新版本；舊版標記被取代；現行版唯一', async () => {
    const p = await mkProd();
    await ed.call('POST', `/products/${p.id}/fit`, { hostIds: [hA] });
    const first = (await query(`SELECT id, total_score FROM product_fit_assessments WHERE product_id=$1 AND host_id=$2 AND superseded_at IS NULL`, [p.id, hA]))[0];
    await mgr.call('PATCH', `/products/${p.id}`, { sellingPoints: '顏色漂亮' });
    const r = await ed.call('POST', `/products/${p.id}/fit`, { hostIds: [hA] });
    expect(r.data.assessed).toBe(1);
    const rows = await query(`SELECT id, superseded_at, superseded_by, total_score FROM product_fit_assessments WHERE product_id=$1 AND host_id=$2 ORDER BY id`, [p.id, hA]);
    expect(rows).toHaveLength(2);
    expect(rows.filter((x) => !x.superseded_at)).toHaveLength(1);
    const old = rows.find((x) => x.id === first.id)!;
    expect(old.superseded_at).not.toBeNull();
    expect(old.superseded_by).toBe(rows.find((x) => !x.superseded_at)!.id);
    expect(Number(rows.find((x) => !x.superseded_at)!.total_score)).toBeLessThan(Number(first.total_score));
    const detail = await ed.call('GET', `/fit/${old.id}`);
    expect(detail.data.versions).toHaveLength(2);
  });
  it('資料庫層：評分內容寫入後不可改；已取代者不可還原；不可實體刪除', async () => {
    const row = (await query(`SELECT id FROM product_fit_assessments WHERE product_id=$1 AND host_id=$2 AND superseded_at IS NULL`, [pA, hA]))[0];
    await expect(query('UPDATE product_fit_assessments SET total_score=1 WHERE id=$1', [row.id])).rejects.toThrow(/不可修改/);
    await expect(query(`UPDATE product_fit_assessments SET reasons='[]'::jsonb WHERE id=$1`, [row.id])).rejects.toThrow(/不可修改/);
    await expect(query('DELETE FROM product_fit_assessments WHERE id=$1', [row.id])).rejects.toThrow(/soft delete|forbidden/i);
    const old = (await query(`SELECT id FROM product_fit_assessments WHERE superseded_at IS NOT NULL AND organization_id=$1 LIMIT 1`, [w.orgId]))[0];
    await expect(query('UPDATE product_fit_assessments SET superseded_at=NULL WHERE id=$1', [old.id])).rejects.toThrow(/不可再變更/);
  });
  it('客群資料更新後，既有評估被標示「資料已更新」（stale）', async () => {
    const before = (await ed.call('GET', `/products/${pA}/fit`)).data.items;
    expect(byHost(before, hA).stale).toBe(false);
    const segId = (await query<{ segment_id: string }>(`SELECT segment_id FROM partner_segment_links WHERE host_id=$1 AND ended_at IS NULL`, [hA]))[0].segment_id;
    await ed.call('PATCH', `/segments/${segId}`, { priceMin: 300, priceMax: 700 });
    const after = (await ed.call('GET', `/products/${pA}/fit`)).data.items;
    expect(byHost(after, hA).stale).toBe(true);
    // 重新評估：價格維度由未知變成已知（價格帶內＝5），完整度提高
    const r = await ed.call('POST', `/products/${pA}/fit`, { hostIds: [hA] });
    expect(r.data.assessed).toBe(1);
    const fresh = byHost((await ed.call('GET', `/products/${pA}/fit`)).data.items, hA);
    expect(dims(fresh).price.score).toBe(5);
    expect(fresh.completeness).toBe(1);
    expect(fresh.stale).toBe(false);
  });
  it('改評分設定：新評估用新權重與新版本；舊評估的設定快照不變', async () => {
    const oldRow = (await query(`SELECT id, config_snapshot, total_score FROM product_fit_assessments WHERE product_id=$1 AND host_id=$2 AND superseded_at IS NULL`, [pA, hB]))[0];
    const put = await mgr.call('PUT', '/fit/config', { weights: { need: 10, category: 10, price: 10, history: 35, supply: 35 }, approved: true });
    expect(put.status).toBe(200);
    expect(put.data).toMatchObject({ version: 2, approved: true });
    expect((await ed.call('GET', '/fit/config')).data).toMatchObject({ version: 2, persisted: true, approved: true });
    await ed.call('POST', `/products/${pA}/fit`, { hostIds: [hB] });
    const rows = await query(`SELECT id, config_version, config_snapshot, total_score, superseded_at FROM product_fit_assessments WHERE product_id=$1 AND host_id=$2 ORDER BY id`, [pA, hB]);
    const old = rows.find((x) => x.id === oldRow.id)!;
    const cur = rows.find((x) => !x.superseded_at)!;
    expect(old.config_snapshot.weights.need).toBe(30);   // 舊評估仍記著當時的權重
    expect(old.config_version).toBe(1);
    expect(cur.config_version).toBe(2);
    expect(cur.config_snapshot.weights).toMatchObject({ need: 10, history: 35 });
    expect(Number(cur.total_score)).not.toBe(Number(old.total_score));
    const au = await query(`SELECT before_data, after_data FROM audit_logs WHERE organization_id=$1 AND action='fit.config.update'`, [w.orgId]);
    expect(au).toHaveLength(1);
    expect(au[0].before_data.version).toBe(1);
    expect(au[0].after_data.version).toBe(2);
    // 還原成原權重，避免影響後面的測試
    expect((await mgr.call('PUT', '/fit/config', { weights: { need: 30, category: 20, price: 15, history: 20, supply: 15 }, approved: false, version: 2 })).data.version).toBe(3);
    expect((await mgr.call('PUT', '/fit/config', { weights: { need: 30, category: 20, price: 15, history: 20, supply: 15 }, version: 2 })).status).toBe(409);   // 版本已前進
  });
});

describe('硬性檢查：合規與品質不被高分抵銷', () => {
  it('商品審核被退回 → BLOCKED（分數仍高）；沒有合規備註 → 最多「需人工評估」', async () => {
    const rej = await mkProd({}, false);
    await query(`UPDATE products SET review_status='REJECTED' WHERE id=$1`, [rej.id]);
    await ed.call('POST', `/products/${rej.id}/fit`, { hostIds: [hA] });
    const a = byHost((await ed.call('GET', `/products/${rej.id}/fit`)).data.items, hA);
    expect(a.totalScore!).toBeGreaterThanOrEqual(80);
    expect(a.recommendation).toBe('BLOCKED');
    expect(a.hardChecks.find((c) => c.key === 'QUALITY')?.result).toBe('FAIL');

    const noNote = await mkProd({ complianceNote: undefined });
    await ed.call('POST', `/products/${noNote.id}/fit`, { hostIds: [hA] });
    const b = byHost((await ed.call('GET', `/products/${noNote.id}/fit`)).data.items, hA);
    expect(b.totalScore!).toBeGreaterThanOrEqual(80);
    expect(b.hardChecks.find((c) => c.key === 'COMPLIANCE')?.result).toBe('UNKNOWN');
    expect(b.recommendation).toBe('REVIEW');
  });
  it('廠商被列為黑名單 → 合規 FAIL → BLOCKED', async () => {
    const v2 = await mkVendor(w);
    const p = (await createProduct(w.manager, { vendorId: v2.id, name: '[DEMO] 黑名單商品', category: '家庭清潔', sellingPoints: TEXT, complianceNote: 'x', skus: [{ skuCode: 'A', name: 'A', groupPrice: 500 }] } as never));
    await query(`UPDATE products SET review_status='APPROVED' WHERE id=$1`, [p.id]);
    await query(`UPDATE vendors SET status='BLACKLISTED' WHERE id=$1`, [v2.id]);
    await ed.call('POST', `/products/${p.id}/fit`, { hostIds: [hA] });
    const a = byHost((await ed.call('GET', `/products/${p.id}/fit`)).data.items, hA);
    expect(a.recommendation).toBe('BLOCKED');
    expect(a.hardChecks.find((c) => c.key === 'COMPLIANCE')?.result).toBe('FAIL');
  });
});

describe('人工覆核', () => {
  let fitId: string;
  beforeAll(async () => {
    fitId = (await query<{ id: string }>(`SELECT id FROM product_fit_assessments WHERE product_id=$1 AND host_id=$2 AND superseded_at IS NULL`, [pA, hA]))[0].id;
  });
  it('只有 fit.review（主管／管理者）能覆核；營運小編 403', async () => {
    expect((await ed.call('POST', `/fit/${fitId}/review`, { decision: 'ACCEPTED' })).status).toBe(403);
    for (const c of [hostC, vendorC, fin]) expect((await c.call('POST', `/fit/${fitId}/review`, { decision: 'ACCEPTED' })).status).toBe(403);
  });
  it('不採用／需補資料必須填原因；覆核寫入並留稽核（前後值）', async () => {
    expect((await mgr.call('POST', `/fit/${fitId}/review`, { decision: 'REJECTED' })).status).toBe(422);
    expect((await mgr.call('POST', `/fit/${fitId}/review`, { decision: 'NEEDS_DATA', note: '' })).status).toBe(422);
    expect((await mgr.call('POST', `/fit/${fitId}/review`, { decision: 'REJECTED', note: '聯絡 0912-345-678' })).status).toBe(422);
    expect((await mgr.call('POST', `/fit/${fitId}/review`, { decision: 'NEEDS_DATA', note: '需要補價格帶' })).status).toBe(200);
    expect((await mgr.call('POST', `/fit/${fitId}/review`, { decision: 'ACCEPTED' })).status).toBe(200);
    const d = (await mgr.call('GET', `/fit/${fitId}`)).data;
    expect(d).toMatchObject({ reviewDecision: 'ACCEPTED', reviewedByName: 'OPS_MANAGER-測試' });
    const au = await query(`SELECT before_data, after_data FROM audit_logs WHERE entity_id=$1 AND action='fit.review' ORDER BY id`, [fitId]);
    expect(au).toHaveLength(2);
    expect(au[1].before_data).toMatchObject({ reviewDecision: 'NEEDS_DATA', reviewNote: '需要補價格帶' });
    expect(au[1].after_data).toMatchObject({ reviewDecision: 'ACCEPTED' });
  });
  it('已被新版取代的評估不能覆核（409），要覆核最新版', async () => {
    const p = await mkProd();
    await ed.call('POST', `/products/${p.id}/fit`, { hostIds: [hA] });
    const old = (await query<{ id: string }>(`SELECT id FROM product_fit_assessments WHERE product_id=$1 AND superseded_at IS NULL`, [p.id]))[0].id;
    await mgr.call('PATCH', `/products/${p.id}`, { sellingPoints: '全新賣點：快速' });
    await ed.call('POST', `/products/${p.id}/fit`, { hostIds: [hA] });
    const r = await mgr.call('POST', `/fit/${old}/review`, { decision: 'ACCEPTED' });
    expect(r.status).toBe(409);
    expect(r.error?.message).toContain('新版本');
  });
  it('資料庫層：REJECTED 沒有原因、覆核沒有覆核人，都過不了 CHECK', async () => {
    const fresh = (await query<{ id: string }>(`SELECT id FROM product_fit_assessments WHERE product_id=$1 AND host_id=$2 AND superseded_at IS NULL`, [pA, hB]))[0].id;
    await expect(query(`UPDATE product_fit_assessments SET review_decision='REJECTED', reviewed_by='u', reviewed_at=now() WHERE id=$1`, [fresh])).rejects.toThrow(/check constraint/i);
    await expect(query(`UPDATE product_fit_assessments SET review_decision='ACCEPTED' WHERE id=$1`, [fresh])).rejects.toThrow(/check constraint/i);
  });
  it('總覽：待覆核清單與尚無客群分析的團主', async () => {
    const o = (await mgr.call('GET', '/fit/overview')).data;
    expect(o.pendingReview.length).toBeGreaterThan(0);
    expect(o.pendingReview.every((x: { reviewDecision: string | null }) => x.reviewDecision === null)).toBe(true);
    expect(o.hostsWithoutSegments.map((h: { id: string }) => h.id)).toContain(hC);
    expect(o.hostsWithoutSegments.map((h: { id: string }) => h.id)).not.toContain(hA);
    const done = (await mgr.call('GET', '/fit?review=done')).data.items;
    expect(done.some((x: { id: string }) => x.id === fitId)).toBe(true);
    expect((await mgr.call('GET', `/fit?hostId=${hB}&recommendation=NOT_RECOMMENDED`)).data.items.every((x: { hostId: string }) => x.hostId === hB)).toBe(true);
  });
});

describe('檔期適配與結案成效回寫', () => {
  let ownCampaign: string;     // 營運小編自己負責的檔期
  let othersCampaign: string;  // 營運主管負責（小編看不到）

  it('檔期草稿：商品 × 已邀請團主逐一評估；沒有商品或團主 → 412', async () => {
    const empty = await mkCampaign(w, vendorId, {}, w.editor);
    const noProd = await ed.call('POST', `/campaigns/${empty.id}/fit`);
    expect(noProd.status).toBe(412);
    const camp = await mkCampaign(w, vendorId, { products: [{ productId: pA, skuId: skuA }], hosts: [{ hostId: hA }, { hostId: hB }] }, w.editor);
    ownCampaign = camp.id;
    const r = await ed.call('POST', `/campaigns/${ownCampaign}/fit`);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ assessed: 2, unchanged: 0 });
    const list = await ed.call('GET', `/campaigns/${ownCampaign}/fit`);
    expect(list.data.summary).toMatchObject({ total: 2, pendingReview: 2, blocked: 0 });
    expect(list.data.items.map((i: { hostId: string }) => i.hostId).sort()).toEqual([hA, hB].sort());
    // 檔期脈絡的評估與商品層級的評估是兩條獨立的現行版本
    expect((await query('SELECT count(*)::int AS n FROM product_fit_assessments WHERE campaign_id=$1 AND superseded_at IS NULL', [ownCampaign]))[0].n).toBe(2);
    const prod = (await ed.call('GET', `/products/${pA}/fit`)).data.items;
    expect(prod.every((i: { campaignId: string | null }) => i.campaignId === null)).toBe(true);
  });
  it('婉拒的團主不評估；團主回覆後重評', async () => {
    const camp = await mkCampaign(w, vendorId, { products: [{ productId: pA, skuId: skuA }], hosts: [{ hostId: hA }, { hostId: hB }] }, w.editor);
    await setCampaignHostStatus(w.editor, camp.id, hB, 'DECLINED', '行程已滿');
    const r = await ed.call('POST', `/campaigns/${camp.id}/fit`);
    expect(r.data.results.map((x: { hostId: string }) => x.hostId)).toEqual([hA]);
  });
  it('資料範圍：小編只能看自己負責的檔期；他人的檔期 404（評估、列表、回寫都一樣）', async () => {
    othersCampaign = (await mkCampaign(w, vendorId, { products: [{ productId: pA, skuId: skuA }], hosts: [{ hostId: hA }] }, w.manager)).id;
    expect((await mgr.call('POST', `/campaigns/${othersCampaign}/fit`)).status).toBe(200);
    expect((await ed.call('GET', `/campaigns/${othersCampaign}/fit`)).status).toBe(404);
    expect((await ed.call('POST', `/campaigns/${othersCampaign}/fit`)).status).toBe(404);
    expect((await ed.call('POST', `/campaigns/${othersCampaign}/fit/outcome`)).status).toBe(404);
    expect((await ed.call('POST', `/products/${pA}/fit`, { campaignId: othersCampaign, hostIds: [hA] })).status).toBe(404);
    const othersFit = (await query<{ id: string }>(`SELECT id FROM product_fit_assessments WHERE campaign_id=$1 AND superseded_at IS NULL`, [othersCampaign]))[0].id;
    expect((await ed.call('GET', `/fit/${othersFit}`)).status).toBe(404);
    expect((await ed.call('GET', '/fit')).data.items.some((x: { campaignId: string | null }) => x.campaignId === othersCampaign)).toBe(false);
    expect((await mgr.call('GET', '/fit')).data.items.some((x: { campaignId: string | null }) => x.campaignId === othersCampaign)).toBe(true);
    expect((await mgr.call('POST', `/fit/${othersFit}/review`, { decision: 'ACCEPTED' })).status).toBe(200);
  });
  it('未結案不能回寫（412）；結案後回寫實際成效，重複回寫不變（冪等）', async () => {
    expect((await ed.call('POST', `/campaigns/${ownCampaign}/fit/outcome`)).status).toBe(412);
    // 歷史檔期 c1（已 CLOSED，hA 淨銷售 100k、hB 20k）先做檔期層級評估，再回寫
    await query(`UPDATE campaign_hosts SET target_revenue=120000 WHERE campaign_id=$1 AND host_id=$2`, [c1, hA]);
    expect((await mgr.call('POST', `/campaigns/${c1}/fit/outcome`)).status).toBe(412);   // 已結案但還沒有檔期層級的評估
    await mgr.call('POST', `/campaigns/${c1}/fit`);
    const r1 = await mgr.call('POST', `/campaigns/${c1}/fit/outcome`);
    expect(r1.status).toBe(200);
    expect(r1.data).toMatchObject({ updated: 2, unchanged: 0 });
    const rows = await query(`SELECT host_id, outcome, outcome_at FROM product_fit_assessments WHERE campaign_id=$1 AND superseded_at IS NULL ORDER BY host_id`, [c1]);
    const oa = rows.find((x) => x.host_id === hA)!.outcome;
    expect(oa).toMatchObject({ hostNetSales: 100_000, hostOrders: 1, hostRefundRate: 0, targetRevenue: 120_000, campaignStatus: 'CLOSED' });
    expect(oa.targetAttainment).toBeCloseTo(0.833, 3);
    expect(oa.predictedRecommendation).toBeTruthy();
    expect(rows.find((x) => x.host_id === hB)!.outcome).toMatchObject({ hostNetSales: 20_000, targetRevenue: null, targetAttainment: null });
    const r2 = await mgr.call('POST', `/campaigns/${c1}/fit/outcome`);
    expect(r2.data).toMatchObject({ updated: 0, unchanged: 2 });
    const au = await query(`SELECT 1 FROM audit_logs WHERE campaign_id=$1 AND action='fit.outcome'`, [c1]);
    expect(au).toHaveLength(2);
  });
  it('回寫不影響評分：歷史績效維度本來就直接讀訂單，回寫後評估內容不變', async () => {
    const row = (await query(`SELECT total_score, dimensions FROM product_fit_assessments WHERE campaign_id=$1 AND host_id=$2`, [c1, hA]))[0];
    const again = await assessCampaign(w.manager, c1);
    expect(again.unchanged).toBe(2);
    const row2 = (await query(`SELECT total_score, dimensions FROM product_fit_assessments WHERE campaign_id=$1 AND host_id=$2`, [c1, hA]))[0];
    expect(row2).toEqual(row);
  });
});

describe('G1–G5 語意不變：適配評估與覆核都不會改變關卡檢查、核准或檔期狀態', () => {
  const taskId = async (cid: string, key: string) => (await query<{ id: string }>('SELECT id FROM tasks WHERE campaign_id=$1 AND step_key=$2', [cid, key]))[0].id;
  const done = async (actor: Actor, cid: string, key: string) => setTaskStatus(actor, await taskId(cid, key), { to: 'DONE' });
  const strip = (cs: { key: string; level: string; ok: boolean; detail?: string }[]) => cs.map((c) => ({ key: c.key, level: c.level, ok: c.ok, detail: c.detail }));

  it('同一檔期：評估＋覆核「不採用」前後，G1 檢查完全相同；G1 仍可申請與核准', async () => {
    const camp = await mkCampaign(w, vendorId, { sampleReadyDate: dayOffset(1), openDate: dayOffset(20), closeDate: dayOffset(30), products: [{ productId: pA, skuId: skuA }], hosts: [{ hostId: hA }] }, w.editor);
    const id = camp.id;
    await transitionCampaign(w.editor, id, 'EVALUATING');
    await setCampaignHostStatus(w.editor, id, hA, 'CONFIRMED');
    for (const k of ['SAMPLE_SHIP', 'TRIAL_ARRIVAL', 'TRIAL_FEEDBACK']) await done(w.editor, id, k);

    const before = strip(await gateCheck(w.editor, id, 'G1'));
    const notifBefore = (await query('SELECT count(*)::int AS n FROM notifications WHERE organization_id=$1', [w.orgId]))[0].n;
    const approvalsBefore = (await query('SELECT count(*)::int AS n FROM approvals WHERE campaign_id=$1', [id]))[0].n;

    await assessCampaign(w.editor, id);
    const fitId = (await query<{ id: string }>(`SELECT id FROM product_fit_assessments WHERE campaign_id=$1 AND superseded_at IS NULL`, [id]))[0].id;
    expect((await mgr.call('POST', `/fit/${fitId}/review`, { decision: 'REJECTED', note: '客群不適合' })).status).toBe(200);

    expect(strip(await gateCheck(w.editor, id, 'G1'))).toEqual(before);
    expect((await query('SELECT status FROM campaigns WHERE id=$1', [id]))[0].status).toBe('EVALUATING');   // 覆核不改檔期狀態
    expect((await query('SELECT count(*)::int AS n FROM approvals WHERE campaign_id=$1', [id]))[0].n).toBe(approvalsBefore);
    expect((await query('SELECT count(*)::int AS n FROM notifications WHERE organization_id=$1', [w.orgId]))[0].n).toBe(notifBefore);   // 不發任何通知

    // 即使適配評估被覆核「不採用」，G1 照舊由有權限的核准者決定（本功能不擋、也不代為核准）
    const g1 = await requestApproval(w.editor, id, 'G1', '試用回饋良好');
    expect((await query('SELECT status FROM campaigns WHERE id=$1', [id]))[0].status).toBe('PENDING_G1');
    await expect(decideApproval(w.editor, g1.id, 'APPROVED')).rejects.toThrow(/不能決定/);
    await decideApproval(w.manager, g1.id, 'APPROVED', 'OK');
    expect((await query('SELECT status FROM campaigns WHERE id=$1', [id]))[0].status).toBe('PREPARING');
  });
  it('G1 檢查項清單沒有新增任何與適配相關的項目', async () => {
    const camp = await mkCampaign(w, vendorId, { products: [{ productId: pA, skuId: skuA }], hosts: [{ hostId: hA }] }, w.editor);
    const keys = (await gateCheck(w.editor, camp.id, 'G1')).map((c) => c.key).sort();
    expect(keys).toEqual(['deps_done', 'has_confirmed_host', 'has_products', 'vendor_info', 'vendor_ok']);
  });
});

describe('權限', () => {
  it('團主、廠商、財務：商品／檔期／總覽的適配資料全部 403', async () => {
    for (const c of [hostC, vendorC, fin]) {
      for (const [m, p] of [['GET', `/products/${pA}/fit`], ['POST', `/products/${pA}/fit`], ['GET', `/campaigns/${c1}/fit`], ['POST', `/campaigns/${c1}/fit`], ['POST', `/campaigns/${c1}/fit/outcome`], ['GET', '/fit'], ['GET', '/fit/overview'], ['GET', '/fit/FIT-000001']] as const) {
        expect((await c.call(m, p, m === 'POST' ? {} : undefined)).status, `${m} ${p}`).toBe(403);
      }
    }
  });
  it('直接呼叫服務層同樣擋下（不是只擋 API）', async () => {
    await expect(assessProduct(await addUser(w.orgId, 'FINANCE'), pA)).rejects.toThrow(/沒有權限/);
  });
  it('他組織的商品與評估讀不到', async () => {
    const w2 = await makeWorld();
    const other = await Client.forActor(w2.manager);
    expect((await other.call('GET', `/products/${pA}/fit`)).status).toBe(404);
    expect((await other.call('POST', `/products/${pA}/fit`, {})).status).toBe(404);
    const any = (await query<{ id: string }>('SELECT id FROM product_fit_assessments WHERE organization_id=$1 LIMIT 1', [w.orgId]))[0].id;
    expect((await other.call('GET', `/fit/${any}`)).status).toBe(404);
    expect((await other.call('POST', `/fit/${any}/review`, { decision: 'ACCEPTED' })).status).toBe(404);
  });
});
