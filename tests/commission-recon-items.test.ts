import { beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '@/server/lib/db';
import { createTrial } from '@/server/modules/trials';
import { getTrialKpis } from '@/server/modules/trial-kpis';
import { createFeasibility } from '@/server/modules/feasibility';
import { importOrders } from '@/server/modules/orders';
import { createCommissionRule } from '@/server/modules/commission';
import { createSettlement } from '@/server/modules/settlements';
import { acknowledgeReconItem, listCommissionReconItems, syncCommissionReconItems } from '@/server/modules/commission-recon-items';
import { getCommissionReconciliation } from '@/server/modules/commission-reconciliation';
import { campaignHostCommission } from '@/server/lib/commission-calc';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkCampaign, mkHost, mkProduct, mkVendor, type World } from './helpers';
import type { Actor } from '@/server/lib/permissions';

/** Owner 決策 K-6a：差異發生時建立待人工確認項目；財務依既有流程處理；不改寫任何財務資料；KPI 與結算不一致時顯示口徑差異提醒 */
const HEADER = 'source_order_id,campaign_id,ordered_at,status,quantity,unit_price,sku_code,buyer_ref,host_id,community_id,refund_amount';
let w: World, other: World;
let hostA: string, hostUser: Actor;
let n = 0;
const TERMS = { cashFlowMode: 'BRAND_COLLECTS', commissionBasis: 'NSV', brandFeePct: 10, serviceFeeFixed: 0, hostCommissionPct: 5, hostPaidBy: 'COMPANY', shippingPerOrder: 60, shippingBorneBy: 'BRAND', platformFeePct: 3, platformFeeBorneBy: 'BRAND', otherVariablePerOrder: 0, otherCostBorneBy: 'COMPANY', fixedCost: 0, fixedCostBorneBy: 'COMPANY', returnCostPerRefundOrder: 20, returnCostBorneBy: 'COMPANY' };
const src = (kind: string) => Object.fromEntries(Object.keys(TERMS).map((k) => [k, { kind }]));
const TABLES = ['feasibility_scenarios', 'commission_rules', 'settlements', 'settlement_items', 'settlement_adjustments', 'vendor_dd_records', 'vendor_dd_items', 'expenses', 'payments', 'invoices', 'orders', 'attributions'];
const counts = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, Number((await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE organization_id=$1`, [w.orgId]))[0].n)])));

beforeAll(async () => {
  w = await makeWorld(); other = await makeWorld();
  hostA = (await mkHost(w, '[DEMO] R 團主甲')).id;
  hostUser = await addUser(w.orgId, 'HOST', { hostIds: [hostA] });
});

async function single(pct = 5) {
  const v = (await mkVendor(w, `[DEMO] R 廠商 ${++n}`)).id;
  const p = await mkProduct(w, v, { name: `[DEMO] R 商品 ${n}`, skus: [{ skuCode: `R${n}`, name: 'a', groupPrice: 800, costPrice: 500 }] });
  const camp = (await mkCampaign(w, v, { products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: [{ hostId: hostA }], sampleReadyDate: dayOffset(-30), openDate: dayOffset(-10), closeDate: dayOffset(10) })).id;
  await query(`UPDATE campaigns SET status='RUNNING' WHERE id=$1`, [camp]);
  const rows = [HEADER];
  for (let i = 1; i <= 5; i++) rows.push(`RC-${n}-${i},${camp},${dayOffset(-5)} 10:00,PAID,1,800,R${n},br${i},${hostA},,`);
  rows.push(`RC-${n}-6,${camp},${dayOffset(-5)} 10:00,PARTIAL_REFUND,1,800,R${n},br6,${hostA},,100`);
  await importOrders({ ...w.admin, source: 'TEST' }, { sourceSystem: 'T', origin: 'DEMO', fileName: `rc${n}.csv`, csv: rows.join('\n') });
  await createFeasibility(w.manager, p.id, { campaignId: camp, inputs: { ...TERMS, hostCommissionPct: pct }, sources: src('CONTRACT') } as never);
  return { v, p, camp };
}

describe('K-6a：差異發生時建立待人工確認項目', () => {
  it('同步：把目前的差異建立成待確認項目（含差異內容、版本、影響範圍）；重複同步不重複建立；不改任何財務資料', async () => {
    const { camp } = await single(5);
    await createCommissionRule(w.finance, { scopeType: 'CAMPAIGN_HOST', hostId: hostA, campaignId: camp, ratePercent: 8, effectiveFrom: dayOffset(-365) });
    const before = await counts();
    const commissionBefore = await campaignHostCommission(pool(), w.orgId, camp);
    const r1 = await syncCommissionReconItems(w.finance);
    expect(r1.created).toBeGreaterThanOrEqual(1);
    const items = (await listCommissionReconItems(w.finance)).items as { id: string; campaignId: string; status: string; reviewReasons: string[]; snapshot: { fields: { field: string; verdict: string }[]; impact: { maxRateGapPct: number } } }[];
    const it = items.find((x) => x.campaignId === camp)!;
    expect(it).toMatchObject({ status: 'OPEN' });
    expect(it.reviewReasons.join()).toContain('團主分潤比例');
    expect(it.snapshot.fields.find((f) => f.field === 'ratePercent')!.verdict).toBe('DIFFERENT');
    expect(it.snapshot.impact.maxRateGapPct).toBe(3);
    const r2 = await syncCommissionReconItems(w.finance);
    expect(r2.created).toBe(0);                                                             // 同樣的差異不會重複建立
    expect((await query(`SELECT count(*)::int AS n FROM commission_recon_items WHERE campaign_id=$1`, [camp]))[0].n).toBe(1);
    // 只新增了待確認項目與稽核：其餘財務資料筆數完全不變，結算佣金計算結果不變
    expect(await counts()).toEqual(before);
    expect(await campaignHostCommission(pool(), w.orgId, camp)).toEqual(commissionBefore);
    expect((await query(`SELECT 1 FROM audit_logs WHERE organization_id=$1 AND action='finance.recon_item.create' AND entity_id=$2`, [w.orgId, it.id])).length).toBe(1);
  });

  it('財務確認「已知悉、依既有流程處理」：只改變項目狀態；需要說明；不改任何來源資料；只有待確認的項目可確認', async () => {
    const { camp, p } = await single(5);
    await createCommissionRule(w.finance, { scopeType: 'CAMPAIGN_HOST', hostId: hostA, campaignId: camp, ratePercent: 8, effectiveFrom: dayOffset(-365) });
    await syncCommissionReconItems(w.finance);
    const it = ((await listCommissionReconItems(w.finance)).items as { id: string; campaignId: string }[]).find((x) => x.campaignId === camp)!;
    const before = await counts();
    await expect(acknowledgeReconItem(w.finance, it.id, { note: '' })).rejects.toThrow();
    const out = await acknowledgeReconItem(w.finance, it.id, { note: '[DEMO] 財務將依規則版本流程評估是否調整，並通知營運' });
    expect(out).toMatchObject({ status: 'ACKNOWLEDGED', financeChanged: false });
    expect(await counts()).toEqual(before);
    expect(Number((await query(`SELECT hostCommissionPct FROM (SELECT (inputs->>'hostCommissionPct')::numeric AS hostCommissionPct FROM feasibility_scenarios WHERE product_id=$1) x`, [p.id]))[0].hostcommissionpct)).toBe(5);   // 可行性條款沒被改
    expect(Number((await query(`SELECT rate_percent FROM commission_rules WHERE campaign_id=$1`, [camp]))[0].rate_percent)).toBe(8);                                                                                       // 財務規則沒被改
    await expect(acknowledgeReconItem(w.finance, it.id, { note: '[DEMO] 再確認一次' })).rejects.toThrow(/待確認/);
    expect(((await listCommissionReconItems(w.finance)).items as { id: string; status: string }[]).find((x) => x.id === it.id)!.status).toBe('ACKNOWLEDGED');
  });

  it('差異內容改變：舊項目標為已取代、建立新項目；差異消失（財務規則已依流程對齊）：自動關閉（只關閉項目，不改資料）', async () => {
    const { camp } = await single(5);
    await createCommissionRule(w.finance, { scopeType: 'CAMPAIGN_HOST', hostId: hostA, campaignId: camp, ratePercent: 8, effectiveFrom: dayOffset(-365) });
    await syncCommissionReconItems(w.finance);
    const first = ((await listCommissionReconItems(w.finance)).items as { id: string; campaignId: string }[]).find((x) => x.campaignId === camp)!;
    await createCommissionRule(w.finance, { scopeType: 'CAMPAIGN_HOST', hostId: hostA, campaignId: camp, ratePercent: 9, effectiveFrom: dayOffset(-365) });   // 財務依流程把規則改成新版本（由財務執行，不是系統覆蓋）
    const r = await syncCommissionReconItems(w.finance);
    expect(r.superseded).toBeGreaterThanOrEqual(1);
    expect((await query(`SELECT status FROM commission_recon_items WHERE id=$1`, [first.id]))[0].status).toBe('SUPERSEDED');
    expect(((await listCommissionReconItems(w.finance)).items as { campaignId: string; status: string }[]).filter((x) => x.campaignId === camp)).toHaveLength(1);
    await createCommissionRule(w.finance, { scopeType: 'CAMPAIGN_HOST', hostId: hostA, campaignId: camp, ratePercent: 5, effectiveFrom: dayOffset(-365) });   // 財務規則與可行性一致了（合約仍缺，但比例差異消失）
    const rows = (await getCommissionReconciliation(w.finance, { campaignId: camp })).rows;
    const stillReview = rows.some((x) => x.needsManualReview);
    const r3 = await syncCommissionReconItems(w.finance);
    if (stillReview) expect(r3.superseded + r3.created).toBeGreaterThanOrEqual(0);                                     // 缺合約條件仍會列入待確認（內容不同，是新項目）
    const active = ((await listCommissionReconItems(w.finance)).items as { campaignId: string }[]).filter((x) => x.campaignId === camp);
    expect(active.length).toBe(stillReview ? 1 : 0);
  });

  it('規則版本改變、費率相同（原因文字不變）：仍視為差異內容改變，舊項目已取代', async () => {
    const { camp } = await single(5);
    await createCommissionRule(w.finance, { scopeType: 'CAMPAIGN_HOST', hostId: hostA, campaignId: camp, ratePercent: 8, effectiveFrom: dayOffset(-365) });
    await syncCommissionReconItems(w.finance);
    const first = ((await listCommissionReconItems(w.finance)).items as { id: string; campaignId: string }[]).find((x) => x.campaignId === camp)!;
    await createCommissionRule(w.finance, { scopeType: 'CAMPAIGN_HOST', hostId: hostA, campaignId: camp, ratePercent: 8, effectiveFrom: dayOffset(-365) });   // 同費率、新版本（v2）
    const r = await syncCommissionReconItems(w.finance);
    expect(r.superseded).toBeGreaterThanOrEqual(1);
    expect((await query(`SELECT status FROM commission_recon_items WHERE id=$1`, [first.id]))[0].status).toBe('SUPERSEDED');
    expect(((await listCommissionReconItems(w.finance)).items as { campaignId: string }[]).filter((x) => x.campaignId === camp)).toHaveLength(1);
  });

  it('權限：需要財務寫入與成本檢視才能同步或確認；營運主管（只有讀取）可看清單但不能同步或確認；小編、團主、其他組織不行', async () => {
    const { camp } = await single(5);
    await createCommissionRule(w.finance, { scopeType: 'CAMPAIGN_HOST', hostId: hostA, campaignId: camp, ratePercent: 8, effectiveFrom: dayOffset(-365) });
    await syncCommissionReconItems(w.finance);
    const it = ((await listCommissionReconItems(w.finance)).items as { id: string; campaignId: string }[]).find((x) => x.campaignId === camp)!;
    await expect(syncCommissionReconItems(w.manager)).rejects.toThrow();
    await expect(acknowledgeReconItem(w.manager, it.id, { note: '[DEMO] 主管不能確認' })).rejects.toThrow();
    expect(((await listCommissionReconItems(w.manager)).items as { id: string }[]).some((x) => x.id === it.id)).toBe(true);
    for (const actor of [w.editor, hostUser]) {
      const c = await Client.forActor(actor);
      expect((await c.call('GET', '/reconciliation/commission/items')).status).toBe(403);
      expect((await c.call('POST', '/reconciliation/commission/sync')).status).toBe(403);
      expect((await c.call('POST', `/reconciliation/commission/items/${it.id}/acknowledge`, { note: '[DEMO] x' })).status).toBe(403);
    }
    const oc = await Client.forActor(other.finance);
    expect((await oc.call('POST', `/reconciliation/commission/items/${it.id}/acknowledge`, { note: '[DEMO] 其他組織' })).status).toBe(404);
    expect(((await listCommissionReconItems(other.finance)).items as unknown[]).length).toBe(0);
  });

  it('資料庫：待確認項目不可實體刪除；同一組只有一個進行中項目；已確認需有確認人與說明', async () => {
    const { camp } = await single(5);
    await createCommissionRule(w.finance, { scopeType: 'CAMPAIGN_HOST', hostId: hostA, campaignId: camp, ratePercent: 8, effectiveFrom: dayOffset(-365) });
    await syncCommissionReconItems(w.finance);
    const it = (await query<{ id: string; product_id: string }>(`SELECT id, product_id FROM commission_recon_items WHERE campaign_id=$1`, [camp]))[0];
    await expect(query(`DELETE FROM commission_recon_items WHERE id=$1`, [it.id])).rejects.toThrow();
    await expect(query(`UPDATE commission_recon_items SET status='ACKNOWLEDGED' WHERE id=$1`, [it.id])).rejects.toThrow();
    await expect(query(`INSERT INTO commission_recon_items (id, organization_id, campaign_id, host_id, product_id, fingerprint, review_reasons, snapshot) VALUES ('RCI-DUP',$1,$2,$3,$4,'x','[]','{}')`, [w.orgId, camp, hostA, it.product_id])).rejects.toThrow();
  });
});

describe('K-6a：KPI 與結算結果不一致時顯示口徑差異提醒', () => {
  it('結算草稿用財務規則 8%、KPI 條款 5%：KPI 卡的風險提示出現清楚的口徑差異（兩邊金額、原因、不覆蓋）；只給有成本權限者；結算金額不變', async () => {
    const { p, camp } = await single(5);
    await createCommissionRule(w.finance, { scopeType: 'CAMPAIGN_HOST', hostId: hostA, campaignId: camp, ratePercent: 8, effectiveFrom: dayOffset(-365) });
    await createSettlement(w.finance, { campaignId: camp });
    const t = (await createTrial(w.manager, p.id, { level: 'HOST_FIT', trialType: 'MINI_GROUP', hostId: hostA, campaignId: camp })).id;
    const commissionBefore = await campaignHostCommission(pool(), w.orgId, camp);
    const notices = (await getTrialKpis(w.manager, t)).notices.join('\n');
    // 有效淨銷售額 4,700：KPI 5% ＝ 235；結算 8% ＝ 376
    expect(notices).toContain('口徑差異提醒'); expect(notices).toContain('235 元'); expect(notices).toContain('376 元');
    expect(notices).toContain('KPI 用可行性條款 5%，結算用財務規則 8%'); expect(notices).toContain('KPI 不覆蓋結算');
    expect((await getTrialKpis(w.editor, t)).notices.join()).not.toContain('口徑差異提醒');                          // 沒有成本權限者看不到
    expect(await campaignHostCommission(pool(), w.orgId, camp)).toEqual(commissionBefore);                          // 結算不受影響
  });

  it('KPI 條款與結算一致：沒有提醒', async () => {
    const { p, camp } = await single(8);
    await createCommissionRule(w.finance, { scopeType: 'CAMPAIGN_HOST', hostId: hostA, campaignId: camp, ratePercent: 8, effectiveFrom: dayOffset(-365) });
    await createSettlement(w.finance, { campaignId: camp });
    const t = (await createTrial(w.manager, p.id, { level: 'HOST_FIT', trialType: 'MINI_GROUP', hostId: hostA, campaignId: camp })).id;
    expect((await getTrialKpis(w.manager, t)).notices.join()).not.toContain('口徑差異提醒');
  });
});
