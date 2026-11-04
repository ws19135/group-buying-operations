import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { createTrial } from '@/server/modules/trials';
import { getTrialKpis, getTrialKpiSummary } from '@/server/modules/trial-kpis';
import { addReach, assignVerifier, listReach, reachHistory, verifierCandidates, verifyReach, voidReach } from '@/server/modules/trial-reach';
import { createFeasibility, recordActuals } from '@/server/modules/feasibility';
import { importOrders } from '@/server/modules/orders';
import { createCommissionRule } from '@/server/modules/commission';
import { campaignHostCommission } from '@/server/lib/commission-calc';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkCampaign, mkHost, mkProduct, mkVendor, type World } from './helpers';
import type { Actor } from '@/server/lib/permissions';

/** Owner 決策 K-1／K-2／K-3 的整合驗證（真實資料庫）：觸及資料三種分開、CVR 只用有效導購訪客、實際貢獻利潤只用已確認條款、KPI 與實際值回寫共用定義 */
const HEADER = 'source_order_id,campaign_id,ordered_at,status,quantity,unit_price,sku_code,buyer_ref,host_id,community_id,refund_amount';
let w: World, other: World;
let vendorId: string, hostA: string, hostB: string, hostUser: Actor;
let hostC: Client, edC: Client;
let n = 0;
const kpi = (r: Awaited<ReturnType<typeof getTrialKpis>>, key: string) => r.items.find((x) => x.key === key)!;
const NOW = () => dayOffset(0);
const V = (over: Record<string, unknown> = {}) => ({ metric: 'QUALIFIED_VISITORS', value: 300, sourceKind: 'SHORT_LINK_UNIQUE_VISITORS', sourceText: '[DEMO] 導購短連結後台', periodStart: dayOffset(-10), periodEnd: dayOffset(10), credibility: 'HIGH', evidenceRef: '[DEMO] 短連結報表 R-001', dedupeMethod: 'SHORT_LINK_UNIQUE_CLIENTS', ...over });
/** 營運人員填寫後，由另一位有權限的主管查核（K-4：填寫者自選可信度不算已驗證） */
const addVerified = async (t: string, over: Record<string, unknown> = {}) => {
  const r = await addReach(w.editor, t, V(over) as never);
  await verifyReach(w.manager, r.id, { decision: 'VERIFIED', note: '[DEMO] 已對照後台報表與去重方式' });
  return r;
};

// 合作條款（虛構）：公司服務費 10%（有效淨銷售額）、團主分潤 5% 由公司付、運費與平台費由品牌負擔、退款退貨處理每筆 20 元由公司負擔
const TERMS = {
  cashFlowMode: 'BRAND_COLLECTS', commissionBasis: 'NSV', brandFeePct: 10, serviceFeeFixed: 0, hostCommissionPct: 5, hostPaidBy: 'COMPANY',
  shippingPerOrder: 60, shippingBorneBy: 'BRAND', platformFeePct: 3, platformFeeBorneBy: 'BRAND', otherVariablePerOrder: 0, otherCostBorneBy: 'COMPANY',
  fixedCost: 0, fixedCostBorneBy: 'COMPANY', returnCostPerRefundOrder: 20, returnCostBorneBy: 'COMPANY',
};
const src = (kind: string, keys = Object.keys(TERMS)) => Object.fromEntries(keys.map((k) => [k, { kind }]));

beforeAll(async () => {
  w = await makeWorld(); other = await makeWorld();
  vendorId = (await mkVendor(w, '[DEMO] K 廠商')).id;
  hostA = (await mkHost(w, '[DEMO] K 團主甲')).id; hostB = (await mkHost(w, '[DEMO] K 團主乙')).id;
  hostUser = await addUser(w.orgId, 'HOST', { hostIds: [hostA] });
  [hostC, edC] = await Promise.all([Client.forActor(hostUser), Client.forActor(w.editor)]);
});

async function scenario(opts: { orders?: boolean; hostBToo?: boolean } = {}) {
  const p = await mkProduct(w, vendorId, { name: `[DEMO] K 商品 ${++n}`, skus: [{ skuCode: `D${n}`, name: 'a', listPrice: 1000, groupPrice: 800, costPrice: 500 }] });
  const camp = (await mkCampaign(w, vendorId, { products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: opts.hostBToo === false ? [{ hostId: hostA }] : [{ hostId: hostA }, { hostId: hostB }], sampleReadyDate: dayOffset(-30), openDate: dayOffset(-10), closeDate: dayOffset(10) })).id;
  await query(`UPDATE campaigns SET status='RUNNING' WHERE id=$1`, [camp]);
  const t = (await createTrial(w.manager, p.id, { level: 'HOST_FIT', trialType: 'MINI_GROUP', hostId: hostA, campaignId: camp })).id;
  if (opts.orders !== false) {
    // 團主甲：4 PAID、2 PARTIAL_REFUND（各退 100）、1 REFUNDED（退 800）、1 CANCELLED；團主乙的訂單不計入
    const rows = [HEADER];
    for (let i = 1; i <= 4; i++) rows.push(`DK-A${i}-${n},${camp},${dayOffset(-5)} 10:00,PAID,1,800,D${n},ba${i},${hostA},,`);
    for (let i = 5; i <= 6; i++) rows.push(`DK-A${i}-${n},${camp},${dayOffset(-5)} 10:00,PARTIAL_REFUND,1,800,D${n},ba${i},${hostA},,100`);
    rows.push(`DK-A7-${n},${camp},${dayOffset(-5)} 11:00,REFUNDED,1,800,D${n},ba7,${hostA},,800`);
    rows.push(`DK-A8-${n},${camp},${dayOffset(-5)} 11:00,CANCELLED,1,800,D${n},ba8,${hostA},,`);
    for (let i = 1; i <= 3; i++) rows.push(`DK-B${i}-${n},${camp},${dayOffset(-5)} 12:00,PAID,1,800,D${n},bb${i},${hostB},,`);
    await importOrders({ ...w.admin, source: 'TEST' }, { sourceSystem: 'T', origin: 'DEMO', fileName: `dk${n}.csv`, csv: rows.join('\n') });
  }
  return { p, camp, t };
}

describe('K-2：觸及與導購資料（人工填寫、三種分開）', () => {
  it('營運人員可填；每筆記錄來源、期間、填寫人、填寫日期、可信度；三種資料各自獨立', async () => {
    const { t } = await scenario();
    const a = await addReach(w.editor, t, V({ metric: 'POTENTIAL_REACH', value: 120, sourceKind: 'LINE_GROUP_MEMBERS', sourceText: '[DEMO] LINE 群組成員數（團主截圖）', credibility: 'MEDIUM', dedupeMethod: null, evidenceRef: null }) as never);
    await addReach(w.editor, t, V({ metric: 'ACTUAL_REACH', value: 80, sourceKind: 'PLATFORM_POST_REACH', sourceText: '[DEMO] 社群貼文後台', dedupeMethod: null, evidenceRef: null }) as never);
    await addReach(w.editor, t, V() as never);
    const list = (await listReach(w.manager, t)).records;
    expect(list.map((r) => r.metric).sort()).toEqual(['ACTUAL_REACH', 'POTENTIAL_REACH', 'QUALIFIED_VISITORS']);
    const pot = list.find((r) => r.id === a.id)!;
    expect(pot).toMatchObject({ value: 120, sourceKind: 'LINE_GROUP_MEMBERS', credibility: 'MEDIUM', createdBy: w.editor.userId, filledOn: NOW(), periodStart: dayOffset(-10), periodEnd: dayOffset(10), deleted: false });
    expect(pot.sourceText).toContain('LINE 群組成員數');
    expect((await query(`SELECT 1 FROM audit_logs WHERE organization_id=$1 AND action='selection.trial.reach.add' AND entity_id=$2`, [w.orgId, a.id])).length).toBe(1);
  });

  it('驗證：來源種類要與資料種類相符（群組人數、貼文觸及不能標成有效導購訪客）、期間順序、不得含電話、來源說明必填', async () => {
    const { t } = await scenario({ orders: false });
    await expect(addReach(w.editor, t, V({ sourceKind: 'LINE_GROUP_MEMBERS' }) as never)).rejects.toThrow(/不能使用來源/);
    await expect(addReach(w.editor, t, V({ sourceKind: 'PLATFORM_POST_REACH' }) as never)).rejects.toThrow(/不能使用來源/);
    await expect(addReach(w.editor, t, V({ metric: 'POTENTIAL_REACH', sourceKind: 'SHORT_LINK_UNIQUE_VISITORS' }) as never)).rejects.toThrow(/不能使用來源/);
    await expect(addReach(w.editor, t, V({ periodStart: dayOffset(5), periodEnd: dayOffset(1) }) as never)).rejects.toThrow(/結束日/);
    await expect(addReach(w.editor, t, V({ sourceText: '請打 0912345678 問我' }) as never)).rejects.toThrow(/電話/);
    await expect(addReach(w.editor, t, V({ sourceText: '' }) as never)).rejects.toThrow();
    await expect(addReach(w.editor, t, V({ value: -1 }) as never)).rejects.toThrow();
    await expect(addReach(w.editor, t, V({ credibility: 'MAYBE' }) as never)).rejects.toThrow();
  });

  it('權限與隔離：團主不能看或寫；其他組織看不到；財務可看不可寫', async () => {
    const { t } = await scenario({ orders: false });
    expect((await hostC.call('GET', `/trials/${t}/reach`)).status).toBe(403);
    expect((await hostC.call('POST', `/trials/${t}/reach`, V())).status).toBe(403);
    expect((await (await Client.forActor(other.manager)).call('GET', `/trials/${t}/reach`)).status).toBe(404);
    await expect(addReach(other.manager, t, V() as never)).rejects.toThrow();
    await expect(addReach(w.finance, t, V() as never)).rejects.toThrow(/權限/);
    expect((await edC.call('POST', `/trials/${t}/reach`, V())).status).toBe(201);
  });

  it('建立後不能改、不能真的刪：資料庫擋 UPDATE 內容與 DELETE；只能軟刪除並留原因', async () => {
    const { t } = await scenario({ orders: false });
    const r = await addReach(w.editor, t, V() as never);
    await expect(query(`UPDATE trial_reach_records SET value=999 WHERE id=$1`, [r.id])).rejects.toThrow(/不可修改/);
    await expect(query(`DELETE FROM trial_reach_records WHERE id=$1`, [r.id])).rejects.toThrow();
    await expect(voidReach(w.editor, r.id, { reason: '' })).rejects.toThrow();
    await voidReach(w.editor, r.id, { reason: '[DEMO] 數字填錯，重新填寫' });
    const row = (await listReach(w.manager, t)).records.find((x) => x.id === r.id)!;
    expect(row).toMatchObject({ deleted: true, deleteReason: '[DEMO] 數字填錯，重新填寫' });
    await expect(voidReach(w.editor, r.id, { reason: '再刪一次' })).rejects.toThrow();   // 已刪除
    expect((await query(`SELECT 1 FROM audit_logs WHERE organization_id=$1 AND action='selection.trial.reach.remove' AND entity_id=$2`, [w.orgId, r.id])).length).toBe(1);
  });

  it('CVR＝有效成交訂單 ÷ 有效導購訪客：沒有導購訪客就資料不足；只有群組人數時另列「群組成員訂單比」，不算 CVR、不當實際觸及', async () => {
    const { t } = await scenario();
    expect(kpi(await getTrialKpis(w.manager, t), 'conversionRate')).toMatchObject({ status: 'INSUFFICIENT', value: null });
    await addReach(w.editor, t, V({ metric: 'POTENTIAL_REACH', value: 120, sourceKind: 'LINE_GROUP_MEMBERS', sourceText: '[DEMO] 群組成員數', dedupeMethod: null, evidenceRef: null }) as never);
    const g = kpi(await getTrialKpis(w.manager, t), 'conversionRate');
    expect(g).toMatchObject({ status: 'INSUFFICIENT', value: null });
    const part = g.parts!.find((x) => x.key === 'groupMemberOrderRatio')!;
    expect(part.value).toBe(5);                                       // 6 張有效訂單 ÷ 120
    expect(part.label).toContain('不是 CVR');
    expect(g.facts!.join('')).toContain('潛在觸及人數：120 人');
    expect(g.facts!.join('')).not.toContain('實際觸及人數');           // 群組人數不會被當成實際觸及
    await addReach(w.editor, t, V({ metric: 'ACTUAL_REACH', value: 90, sourceKind: 'PLATFORM_POST_REACH', sourceText: '[DEMO] 貼文後台', dedupeMethod: null, evidenceRef: null }) as never);
    expect(kpi(await getTrialKpis(w.manager, t), 'conversionRate').status).toBe('INSUFFICIENT');   // 實際觸及也不是導購訪客
    await addVerified(t, { value: 300 });
    const cvr = kpi(await getTrialKpis(w.manager, t), 'conversionRate');
    expect(cvr).toMatchObject({ status: 'OK', value: 2, sampleSize: 300 });                       // 6 ÷ 300
    expect(cvr.parts!.find((x) => x.key === 'groupMemberOrderRatio')!.value).toBe(5);              // 兩者並存、各是各的
  });

  it('可信度低、統計期間與檔期沒有重疊：不採用；刪除後不再計入；有更新的資料時採用較新的一筆', async () => {
    const { t } = await scenario();
    const low = await addReach(w.editor, t, V({ credibility: 'LOW' }) as never);
    expect(kpi(await getTrialKpis(w.manager, t), 'conversionRate').reason).toContain('可信度為低');
    await voidReach(w.editor, low.id, { reason: '[DEMO] 改用平台數據' });
    await addVerified(t, { periodStart: dayOffset(-60), periodEnd: dayOffset(-50) });
    expect(kpi(await getTrialKpis(w.manager, t), 'conversionRate').reason).toContain('沒有重疊');
    await addVerified(t, { value: 200 });                                           // 統計期間較晚的一筆勝出
    expect(kpi(await getTrialKpis(w.manager, t), 'conversionRate')).toMatchObject({ status: 'OK', value: 3 });   // 6 ÷ 200
    await addVerified(t, { value: 4 });                                              // 訪客少於訂單：資料不合理
    expect(kpi(await getTrialKpis(w.manager, t), 'conversionRate').reason).toContain('資料不合理');
  });
});

describe('K-4：有效導購訪客的可驗證性（佐證、去重方式、第二人查核、規則版本）', () => {
  it('高／中可信度需附來源佐證；去重方式必填；人工去重要說明；低可信度可不附佐證', async () => {
    const { t } = await scenario({ orders: false });
    await expect(addReach(w.editor, t, V({ evidenceRef: null }) as never)).rejects.toThrow(/來源佐證/);
    await expect(addReach(w.editor, t, V({ credibility: 'MEDIUM', evidenceRef: '' }) as never)).rejects.toThrow(/來源佐證/);
    await expect(addReach(w.editor, t, V({ dedupeMethod: null }) as never)).rejects.toThrow(/如何去重/);
    await expect(addReach(w.editor, t, V({ dedupeMethod: 'MANUAL_DEDUP' }) as never)).rejects.toThrow(/去重方法/);
    await expect(addReach(w.editor, t, V({ metric: 'ACTUAL_REACH', sourceKind: 'PLATFORM_POST_REACH', dedupeMethod: 'UNKNOWN' }) as never)).rejects.toThrow(/只適用於「有效導購訪客」/);
    await expect(addReach(w.editor, t, V({ evidenceRef: '請打 0912345678' }) as never)).rejects.toThrow(/電話/);
    expect((await addReach(w.editor, t, V({ credibility: 'LOW', evidenceRef: null, dedupeMethod: 'UNKNOWN' }) as never)).id).toBeTruthy();
    const ok = await addReach(w.editor, t, V({ dedupeMethod: 'MANUAL_DEDUP', dedupeNote: '[DEMO] 依下單帳號與短連結紀錄比對後去除重複' }) as never);
    const row = (await listReach(w.manager, t)).records.find((x) => x.id === ok.id)!;
    expect(row).toMatchObject({ evidenceRef: '[DEMO] 短連結報表 R-001', dedupeMethod: 'MANUAL_DEDUP', verificationStatus: 'UNVERIFIED', rulesVersion: 'reach-rules/2026-11-05.1' });
  });

  it('填寫者自選「高」但沒有查核：CVR 維持資料不足（不算已驗證）；第二人查核後才採用', async () => {
    const { t } = await scenario();
    const r = await addReach(w.editor, t, V({ value: 300 }) as never);
    const before = kpi(await getTrialKpis(w.manager, t), 'conversionRate');
    expect(before).toMatchObject({ status: 'INSUFFICIENT', value: null });
    expect(before.reason).toContain('尚未經第二位');
    await verifyReach(w.manager, r.id, { decision: 'VERIFIED', note: '[DEMO] 已對照報表 R-001，去重方式為短連結不重複用戶端' });
    expect(kpi(await getTrialKpis(w.manager, t), 'conversionRate')).toMatchObject({ status: 'OK', value: 2 });
    const row = (await listReach(w.manager, t)).records.find((x) => x.id === r.id)!;
    expect(row).toMatchObject({ verificationStatus: 'VERIFIED', verifiedBy: w.manager.userId, verifyRulesVersion: 'reach-rules/2026-11-05.1' });
    expect((await query(`SELECT 1 FROM audit_logs WHERE organization_id=$1 AND action='selection.trial.reach.verify' AND entity_id=$2`, [w.orgId, r.id])).length).toBe(1);
  });

  it('來源不能證明不重複（沒去重、不知道、點擊數）：即使已查核也不用，CVR 資料不足', async () => {
    const { t } = await scenario();
    const r = await addReach(w.editor, t, V({ dedupeMethod: 'NOT_DEDUPED', sourceKind: 'PLATFORM_ANALYTICS' }) as never);
    await verifyReach(w.manager, r.id, { decision: 'VERIFIED', note: '[DEMO] 數字與報表一致' });
    const k = kpi(await getTrialKpis(w.manager, t), 'conversionRate');
    expect(k.status).toBe('INSUFFICIENT');
    expect(k.reason).toContain('不能證明訪客不重複');
  });

  it('團主自行回報不能證明不重複；查核退回不採用', async () => {
    const { t } = await scenario();
    const a = await addReach(w.editor, t, V({ sourceKind: 'HOST_SELF_REPORT' }) as never);
    await verifyReach(w.manager, a.id, { decision: 'VERIFIED', note: '[DEMO] 數字合理' });
    expect(kpi(await getTrialKpis(w.manager, t), 'conversionRate').reason).toContain('團主自行回報');
    const b = await addReach(w.editor, t, V({ periodEnd: dayOffset(11), value: 250 }) as never);   // 統計期間較晚，會被採用為最新一筆
    await verifyReach(w.manager, b.id, { decision: 'REJECTED', note: '[DEMO] 報表連結打不開，無法查核' });
    expect(kpi(await getTrialKpis(w.manager, t), 'conversionRate').reason).toContain('查核退回');
  });

  it('填寫者不能查核自己填的資料（服務層與資料庫都擋）；只能查核一次；沒有權限的人不能查核；非有效導購訪客不需查核', async () => {
    const { t } = await scenario({ orders: false });
    const mine = await addReach(w.manager, t, V() as never);   // 主管自己填
    await expect(verifyReach(w.manager, mine.id, { decision: 'VERIFIED', note: '[DEMO] 自己查自己' })).rejects.toThrow(/不能查核自己/);
    await expect(query(`UPDATE trial_reach_records SET verification_status='VERIFIED', verified_by=created_by, verified_at=now(), verify_note='x', verify_rules_version='v' WHERE id=$1`, [mine.id])).rejects.toThrow(/不能查核自己/);
    await expect(verifyReach(w.editor, mine.id, { decision: 'VERIFIED', note: '[DEMO] 小編沒有查核權限' })).rejects.toThrow(/權限/);
    const r = await addReach(w.editor, t, V() as never);
    await verifyReach(w.manager, r.id, { decision: 'VERIFIED', note: '[DEMO] 第一次' });
    await expect(verifyReach(w.manager, r.id, { decision: 'REJECTED', note: '[DEMO] 想改' })).rejects.toThrow(/已經查核過/);
    await expect(query(`UPDATE trial_reach_records SET verification_status='UNVERIFIED', verified_by=NULL, verified_at=NULL, verify_note=NULL, verify_rules_version=NULL WHERE id=$1`, [r.id])).rejects.toThrow(/不可再變更查核結果/);
    const pot = await addReach(w.editor, t, V({ metric: 'POTENTIAL_REACH', sourceKind: 'LINE_GROUP_MEMBERS', dedupeMethod: null, evidenceRef: null }) as never);
    await expect(verifyReach(w.manager, pot.id, { decision: 'VERIFIED', note: '[DEMO] 不需要' })).rejects.toThrow(/只有「有效導購訪客」/);
    await expect(query(`UPDATE trial_reach_records SET evidence_ref='改佐證' WHERE id=$1`, [r.id])).rejects.toThrow(/不可修改/);
    expect((await hostC.call('POST', `/reach-records/${r.id}/verify`, { decision: 'VERIFIED', note: '團主不行' })).status).toBe(403);
  });

  it('舊資料（K-2 時期、沒有佐證與去重方式）相容：去重方式視為未知、未查核，不會被當成可用', async () => {
    const { t } = await scenario();
    // 模擬舊紀錄：直接以 SQL 寫入（欄位維持預設值）
    await query(`INSERT INTO trial_reach_records (id, organization_id, trial_id, metric, value, source_kind, source_text, period_start, period_end, credibility, filled_on, created_by, dedupe_method)
                 VALUES ('RCH-LEGACY-1',$1,$2,'QUALIFIED_VISITORS',300,'SHORT_LINK_UNIQUE_VISITORS','[DEMO] 舊資料',$3,$4,'HIGH',$5,$6,'UNKNOWN')`, [w.orgId, t, dayOffset(-10), dayOffset(10), dayOffset(0), w.editor.userId]);
    const k = kpi(await getTrialKpis(w.manager, t), 'conversionRate');
    expect(k.status).toBe('INSUFFICIENT');
    expect((await listReach(w.manager, t)).records.find((x) => x.id === 'RCH-LEGACY-1')).toMatchObject({ rulesVersion: 'reach-rules/legacy', verificationStatus: 'UNVERIFIED', dedupeMethod: 'UNKNOWN' });
  });
});

describe('K-4a：單一主管時的查核（不建立自行核准捷徑）', () => {
  it('只有一位有查核權限的人：填寫者無法自行查核；資料維持待查核；CVR 資料不足；沒有候選人時不會自動通過', async () => {
    const w2 = await makeWorld();
    const hostX = (await mkHost(w2, '[DEMO] K4a 團主')).id;
    const vX = (await mkVendor(w2, '[DEMO] K4a 廠商')).id;
    const pX = await mkProduct(w2, vX, { name: '[DEMO] K4a 商品', skus: [{ skuCode: `KA${++n}`, name: 'a', groupPrice: 800, costPrice: 500 }] });
    const campX = (await mkCampaign(w2, vX, { products: [{ productId: pX.id, skuId: pX.skuIds[0] }], hosts: [{ hostId: hostX }], sampleReadyDate: dayOffset(-30), openDate: dayOffset(-10), closeDate: dayOffset(10) })).id;
    await query(`UPDATE campaigns SET status='RUNNING' WHERE id=$1`, [campX]);
    const t = (await createTrial(w2.manager, pX.id, { level: 'HOST_FIT', trialType: 'MINI_GROUP', hostId: hostX, campaignId: campX })).id;
    // 只留主管一位具查核權限：管理者與其他人停用
    await query(`UPDATE users SET status='DISABLED' WHERE organization_id=$1 AND id <> $2 AND role_key IN ('SYSTEM_ADMIN','OPS_MANAGER')`, [w2.orgId, (w2.manager.userId as string)]);
    const r = await addReach(w2.manager, t, V() as never);
    await expect(verifyReach(w2.manager, r.id, { decision: 'VERIFIED', note: '[DEMO] 單一主管自己查自己' })).rejects.toThrow(/不能查核自己/)
    // 服務層要自己擋（403，不是靠資料庫最後一道防線才失敗）
    await expect(verifyReach(w2.manager, r.id, { decision: 'VERIFIED', note: '[DEMO] 單一主管自己查自己' })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(query(`UPDATE trial_reach_records SET verification_status='VERIFIED', verified_by=created_by, verified_at=now(), verify_note='x', verify_rules_version='v' WHERE id=$1`, [r.id])).rejects.toThrow(/不能查核自己/);
    expect(await verifierCandidates(w2.orgId, (w2.manager.userId as string))).toEqual([]);                                         // 沒有第二位有權限的人
    await expect(assignVerifier(w2.manager, r.id, { userId: (w2.manager.userId as string) })).rejects.toThrow(/不能指派填寫者/);      // 不能指派自己
    await expect(assignVerifier(w2.manager, r.id, { userId: (w2.editor.userId as string) })).rejects.toThrow(/具有查核權限/);         // 沒有權限的人不能被指派（不會因人力不足降低門檻）
    const k = (await getTrialKpis(w2.manager, t)).items.find((x) => x.key === 'conversionRate')!;
    expect(k).toMatchObject({ status: 'INSUFFICIENT', value: null });
    expect(k.reason).toContain('待查核'); expect(k.reason).toContain('尚未指派查核者');
    expect((await listReach(w2.manager, t)).records.find((x) => x.id === r.id)).toMatchObject({ verificationStatus: 'UNVERIFIED', verifiedBy: null });
  });

  it('有權主管指派另一位有權限的人：只有被指派者可以查核；沒有權限者不能指派；可改派；查核後不可再改；查核後 CVR 才採用', async () => {
    const { t } = await scenario();
    const r = await addReach(w.editor, t, V({ value: 300 }) as never);
    await expect(assignVerifier(w.editor, r.id, { userId: (w.admin.userId as string) })).rejects.toThrow(/權限/);                    // 小編不能指派
    await expect(assignVerifier(w.manager, r.id, { userId: (w.finance.userId as string) })).rejects.toThrow(/具有查核權限/);           // 財務沒有 product.review
    await expect(assignVerifier(w.manager, r.id, { userId: (w.editor.userId as string) })).rejects.toThrow(/不能指派填寫者/);            // 填寫者本身也不行
    await assignVerifier(w.manager, r.id, { userId: (w.admin.userId as string), note: '[DEMO] 請管理者獨立查核' });
    let row = (await listReach(w.manager, t)).records.find((x) => x.id === r.id)!;
    expect(row).toMatchObject({ assignedVerifierId: (w.admin.userId as string), assignedBy: (w.manager.userId as string), assignmentNote: '[DEMO] 請管理者獨立查核', verificationStatus: 'UNVERIFIED' });
    const k1 = (await getTrialKpis(w.manager, t)).items.find((x) => x.key === 'conversionRate')!;
    expect(k1.status).toBe('INSUFFICIENT'); expect(k1.reason).toContain('已指派');          // 已指派但尚未查核：仍是資料不足
    await expect(verifyReach(w.manager, r.id, { decision: 'VERIFIED', note: '[DEMO] 沒被指派的主管想查核' })).rejects.toThrow(/已指派給另一位查核者/);
    await expect(query(`UPDATE trial_reach_records SET verification_status='VERIFIED', verified_by=$2, verified_at=now(), verify_note='x', verify_rules_version='v' WHERE id=$1`, [r.id, (w.manager.userId as string)])).rejects.toThrow(/只有被指派者/);
    await verifyReach(w.admin, r.id, { decision: 'VERIFIED', note: '[DEMO] 管理者已對照報表' });
    expect(kpi(await getTrialKpis(w.manager, t), 'conversionRate')).toMatchObject({ status: 'OK', value: 2 });
    await expect(assignVerifier(w.manager, r.id, { userId: (w.admin.userId as string) })).rejects.toThrow(/已經查核過/);
    row = (await listReach(w.manager, t)).records.find((x) => x.id === r.id)!;
    expect(row).toMatchObject({ verificationStatus: 'VERIFIED', verifiedBy: (w.admin.userId as string) });
  });

  it('候選人名單：不含填寫者、只含有查核權限的啟用中人員；改派在查核前可行', async () => {
    const { t } = await scenario();
    const r = await addReach(w.manager, t, V() as never);
    const c = await verifierCandidates(w.orgId, (w.manager.userId as string));
    expect(c.map((x) => x.id)).toContain((w.admin.userId as string));
    expect(c.map((x) => x.id)).not.toContain((w.manager.userId as string));
    expect(c.map((x) => x.id)).not.toContain((w.editor.userId as string));
    expect(c.map((x) => x.id)).not.toContain((w.finance.userId as string));
    await assignVerifier(w.admin, r.id, { userId: (w.admin.userId as string), note: '[DEMO] 管理者自己接手查核（填寫者是主管）' });   // 指派者可以就是被指派者，只要不是填寫者
    await assignVerifier(w.admin, r.id, { userId: (w.admin.userId as string) });
    expect((await listReach(w.manager, t)).records.find((x) => x.id === r.id)!.assignedVerifierId).toBe((w.admin.userId as string));
  });

  it('完整紀錄：填寫、指派、查核退回、補件、再查核通過；補件只能針對被退回且同種類的紀錄，且一筆只能補件一次', async () => {
    const { t } = await scenario();
    const a = await addReach(w.editor, t, V({ value: 250 }) as never);
    await assignVerifier(w.manager, a.id, { userId: (w.admin.userId as string) });
    await expect(addReach(w.editor, t, V({ resubmitsId: a.id }) as never)).rejects.toThrow(/只有「查核退回」/);          // 還沒被退回，不能補件
    await verifyReach(w.admin, a.id, { decision: 'REJECTED', note: '[DEMO] 報表連結打不開，請補件' });
    const other = await addReach(w.editor, t, V({ metric: 'POTENTIAL_REACH', sourceKind: 'LINE_GROUP_MEMBERS', dedupeMethod: null, evidenceRef: null }) as never);
    await expect(addReach(w.editor, t, V({ resubmitsId: other.id }) as never)).rejects.toThrow();                          // 不是退回的紀錄
    await expect(addReach(w.editor, t, V({ resubmitsId: a.id, metric: 'ACTUAL_REACH', sourceKind: 'PLATFORM_POST_REACH', dedupeMethod: null, evidenceRef: null }) as never)).rejects.toThrow(/同一種資料/);
    const b = await addReach(w.editor, t, V({ value: 260, resubmitsId: a.id, evidenceRef: '[DEMO] 新的報表連結 R-002' }) as never);   // 補件
    await expect(addReach(w.editor, t, V({ resubmitsId: a.id }) as never)).rejects.toThrow();                              // 一筆只能補件一次
    await assignVerifier(w.manager, b.id, { userId: (w.admin.userId as string) });
    await verifyReach(w.admin, b.id, { decision: 'VERIFIED', note: '[DEMO] 新報表已核對' });
    const recs = (await listReach(w.manager, t)).records;
    expect(recs.find((x) => x.id === b.id)).toMatchObject({ resubmitsId: a.id, verificationStatus: 'VERIFIED' });
    expect(recs.find((x) => x.id === a.id)).toMatchObject({ verificationStatus: 'REJECTED' });                              // 被退回的紀錄保留
    const h = (await reachHistory(w.manager, t)).filter((e) => e.recordId === a.id || e.recordId === b.id).map((e) => `${e.recordId === a.id ? 'A' : 'B'}:${e.label}`);
    expect(h).toEqual(['A:填寫', 'A:指派查核者', 'A:查核退回', 'B:補件（重新填寫）', 'B:指派查核者', 'B:查核通過']);
    expect(kpi(await getTrialKpis(w.manager, t), 'conversionRate')).toMatchObject({ status: 'OK' });                       // 以最新且已查核的補件為準（A 的統計期間與 B 相同；B 較晚填寫）
  });

  it('團主與其他組織不能指派或查看候選與紀錄', async () => {
    const { t } = await scenario();
    const r = await addReach(w.editor, t, V() as never);
    const hc = await Client.forActor(hostUser);
    expect((await hc.call('POST', `/reach-records/${r.id}/assign-verifier`, { userId: (w.admin.userId as string) })).status).toBe(403);
    expect((await hc.call('GET', `/trials/${t}/reach-history`)).status).toBe(403);
    expect((await (await Client.forActor(other.manager)).call('POST', `/reach-records/${r.id}/assign-verifier`, { userId: (w.admin.userId as string) })).status).toBe(404);
  });
});

describe('K-3：實際每單貢獻利潤（已確認條款才算；與實際值回寫共用定義）', () => {
  const fz = async (camp: string, p: string, t: string, inputs: Record<string, unknown>, kind = 'CONTRACT') =>
    (await createFeasibility(w.manager, p, { campaignId: camp, trialId: t, inputs, sources: src(kind, Object.keys(inputs)) } as never)).id;

  it('條款來自合約且完整：公司貢獻利潤＝公司收入 − 公司付的團主分潤 − 公司負擔的成本；每單＝÷有效訂單；收款方與負擔方取自條款', async () => {
    const { p, camp, t } = await scenario({ hostBToo: false });
    await fz(camp, p.id, t, TERMS);
    const k = kpi(await getTrialKpis(w.manager, t), 'contributionPerOrder');
    // 計入銷售 7 張：GMV 5600、退款 1000、有效淨銷售額 4600；有效訂單 6；有退款 3 張
    // 公司收入 460；團主分潤 230（公司付）；退款退貨處理 20×3=60（公司負擔）；運費與平台費由品牌負擔 → 460−230−60=170；每單 round(170/6)=28
    expect(k).toMatchObject({ status: 'OK', value: 28 });
    expect(k.parts![0].value).toBe(170);
    expect(k.formula).toContain('不寫死');
  });

  it('負擔方不寫死：把運費改由公司負擔，結果跟著變', async () => {
    const { p, camp, t } = await scenario({ hostBToo: false });
    await fz(camp, p.id, t, { ...TERMS, shippingBorneBy: 'COMPANY' });
    expect(kpi(await getTrialKpis(w.manager, t), 'contributionPerOrder').parts![0].value).toBe(170 - 60 * 6);   // 運費 60×6 張有效訂單
  });

  it('條款來源不是合約／正式商務條件（廠商報價、人工估計…）：資料不足，不顯示暫估；改成「正式商務條件（已確認）」就算', async () => {
    const { p, camp, t } = await scenario({ hostBToo: false });
    await fz(camp, p.id, t, TERMS, 'VENDOR_QUOTE');
    const k = kpi(await getTrialKpis(w.manager, t), 'contributionPerOrder');
    expect(k).toMatchObject({ status: 'INSUFFICIENT', value: null });
    expect(k.reason).toContain('還不是合約或正式商務條件');
    await fz(camp, p.id, t, { hostCommissionPct: 5 }, 'FORMAL_TERMS');   // 新版本只更新一項；其餘沿用上一版的來源
    expect(kpi(await getTrialKpis(w.manager, t), 'contributionPerOrder').status).toBe('INSUFFICIENT');   // 其他條款仍是廠商報價
    const all = await fz(camp, p.id, t, TERMS, 'FORMAL_TERMS');
    expect(all).toBeTruthy();
    expect(kpi(await getTrialKpis(w.manager, t), 'contributionPerOrder')).toMatchObject({ status: 'OK', value: 28 });
  });

  it('未知成本不當 0：沒填退款退貨處理成本、其他變動成本或收款方，就是資料不足並列出缺什麼', async () => {
    const { p, camp, t } = await scenario({ hostBToo: false });
    const { returnCostPerRefundOrder: _a, returnCostBorneBy: _b, ...noReturn } = TERMS;
    await fz(camp, p.id, t, noReturn);
    const k = kpi(await getTrialKpis(w.manager, t), 'contributionPerOrder');
    expect(k.status).toBe('INSUFFICIENT');
    expect(k.reason).toContain('退款／退貨處理成本');
    expect(k.value).toBeNull();
  });

  it('沒有訂單、沒有可行性條款、檔期有多個商品：資料不足；單一團主但檔期有其他團主且有固定費用：無法分攤', async () => {
    const a = await scenario({ orders: false, hostBToo: false });
    await fz(a.camp, a.p.id, a.t, TERMS);
    expect(kpi(await getTrialKpis(w.manager, a.t), 'contributionPerOrder').reason).toContain('沒有有效訂單');
    const b = await scenario({ hostBToo: false });
    expect(kpi(await getTrialKpis(w.manager, b.t), 'contributionPerOrder').reason).toContain('還沒有填商業可行性的合作條款');
    const c = await scenario();   // 檔期有團主乙
    await fz(c.camp, c.p.id, c.t, { ...TERMS, fixedCost: 5000 });
    expect(kpi(await getTrialKpis(w.manager, c.t), 'contributionPerOrder').reason).toContain('固定費用無法分攤');
    // 檔期有兩個商品：訂單無法歸屬到單一商品的成本
    const pa = await mkProduct(w, vendorId, { name: '[DEMO] K 多商品甲', skus: [{ skuCode: `MA${++n}`, name: 'a', groupPrice: 800, costPrice: 500 }] });
    const pb = await mkProduct(w, vendorId, { name: '[DEMO] K 多商品乙', skus: [{ skuCode: `MB${n}`, name: 'b', groupPrice: 500, costPrice: 100 }] });
    const camp2 = (await mkCampaign(w, vendorId, { products: [{ productId: pa.id, skuId: pa.skuIds[0] }, { productId: pb.id, skuId: pb.skuIds[0] }], hosts: [{ hostId: hostA }], sampleReadyDate: dayOffset(-30), openDate: dayOffset(-10), closeDate: dayOffset(10) })).id;
    await query(`UPDATE campaigns SET status='RUNNING' WHERE id=$1`, [camp2]);
    const t2 = (await createTrial(w.manager, pa.id, { level: 'HOST_FIT', trialType: 'MINI_GROUP', hostId: hostA, campaignId: camp2 })).id;
    await importOrders({ ...w.admin, source: 'TEST' }, { sourceSystem: 'T', origin: 'DEMO', fileName: `mp${n}.csv`, csv: [HEADER, `MP-1-${n},${camp2},${dayOffset(-5)} 10:00,PAID,1,800,MA${n},bm1,${hostA},,`].join('\n') });
    await fz(camp2, pa.id, t2, TERMS);
    expect(kpi(await getTrialKpis(w.manager, t2), 'contributionPerOrder').reason).toContain('多個商品');
  });

  it('一致性提醒（只讀）：可行性條款的團主分潤比例與財務分潤規則不同時提示；結算用的分潤計算完全不受影響', async () => {
    const { p, camp, t } = await scenario({ hostBToo: false });
    await fz(camp, p.id, t, TERMS);   // 條款：團主分潤 5%
    const noRule = (await getTrialKpis(w.manager, t)).notices.join();
    expect(noRule).toContain('沒有這位團主在此檔期的費率');
    await createCommissionRule(w.finance, { scopeType: 'CAMPAIGN_HOST', hostId: hostA, campaignId: camp, ratePercent: 8, effectiveFrom: dayOffset(-365) });
    const diff = (await getTrialKpis(w.manager, t)).notices.join();
    expect(diff).toContain('（5%）與財務分潤規則（8%）不一致');
    // 沒有成本權限者看不到這行（含費率）
    expect((await getTrialKpis(w.editor, t)).notices.join()).not.toContain('財務分潤規則');
    // 結算（campaignHostCommission）仍用財務分潤規則 8%：淨銷售 4600 × 8%，與 KPI／可行性條款的 5% 無關
    const calc = (await campaignHostCommission(await import('@/server/lib/db').then((m) => m.pool()), w.orgId, camp)).find((x) => x.hostId === hostA)!;
    expect(calc.netSales).toBe(4600);
    expect(calc.commissionAuto).toBe(368);
    await createCommissionRule(w.finance, { scopeType: 'CAMPAIGN_HOST', hostId: hostA, campaignId: camp, ratePercent: 5, effectiveFrom: dayOffset(-365) });
    expect((await getTrialKpis(w.manager, t)).notices.join()).not.toContain('不一致');
  });

  it('沒有成本權限的營運人員：每單貢獻利潤只看到「需權限」，回應不含條款欄位或金額', async () => {
    const { p, camp, t } = await scenario({ hostBToo: false });
    await fz(camp, p.id, t, TERMS);
    const ed = kpi(await getTrialKpis(w.editor, t), 'contributionPerOrder');
    expect(ed).toMatchObject({ status: 'RESTRICTED', value: null });
    const raw = JSON.stringify((await edC.call('GET', `/trials/${t}/kpis`)).json);
    expect(raw).not.toContain('"value":28');
    expect(raw).not.toContain('170');
    expect(raw).not.toContain('退款／退貨處理成本');
  });

  it('KPI 與商業可行性「實際值回寫」共用同一定義：每單貢獻利潤、有效訂單、退款訂單數、GMV 完全一致；既有欄位維持原義', async () => {
    const { p, camp, t } = await scenario({ hostBToo: false });
    // 回寫要掛在「指定團主」的情境上：只算該團主歸因的訂單（與 KPI 同範圍）
    const sc = (await createFeasibility(w.manager, p.id, { campaignId: camp, hostId: hostA, trialId: t, inputs: TERMS, sources: src('CONTRACT') } as never)).id;
    const a = (await recordActuals(w.manager, sc)).actuals as Record<string, unknown> & { contribution: { status: string; perOrder: number | null; total: number | null } };
    const k = kpi(await getTrialKpis(w.manager, t), 'contributionPerOrder');
    expect(a.contribution).toMatchObject({ status: 'OK', perOrder: 28, total: 170 });
    expect(a.contribution.perOrder).toBe(k.value);
    expect(a.validOrders).toBe(kpi(await getTrialKpis(w.manager, t), 'validOrders').value);
    expect(a.netAov).toBe(kpi(await getTrialKpis(w.manager, t), 'aov').value);
    // 既有欄位維持原義：orders＝計入銷售的訂單（含全額退款）、aov＝GMV÷計入銷售訂單、refundRatePct＝退款金額÷GMV
    expect(a).toMatchObject({ orders: 7, gmv: 5600, refund: 1000, nsv: 4600, aov: 800, refundRatePct: 17.86, refundedOrders: 3, cancelledOrders: 1 });
    // 稽核不留金額；沒有成本權限的人看不到
    const log = (await query<{ after_data: unknown }>(`SELECT after_data FROM audit_logs WHERE organization_id=$1 AND action='selection.feasibility.actuals' AND entity_id=$2`, [w.orgId, sc]))[0];
    expect(JSON.stringify(log.after_data)).not.toContain('170');
    const edView = (await edC.call('GET', `/feasibility/${sc}`)).json.data;
    expect(edView.actuals.contribution).toEqual({ restricted: true });
    expect(edView.actuals.orders).toBe(7);
  });

  it('條款未確認時，實際值回寫的貢獻利潤也是資料不足（兩處同一規則）', async () => {
    const { p, camp, t } = await scenario({ hostBToo: false });
    const sc = (await createFeasibility(w.manager, p.id, { campaignId: camp, hostId: hostA, trialId: t, inputs: TERMS, sources: src('MANUAL_ESTIMATE') } as never)).id;
    const a = (await recordActuals(w.manager, sc)).actuals as { contribution: { status: string; perOrder: number | null; reasons: string[] } };
    expect(a.contribution).toMatchObject({ status: 'INSUFFICIENT', perOrder: null });
    expect(a.contribution.reasons.join()).toContain('還不是合約或正式商務條件');
  });
});

describe('K-1：累積彙整（只整理、不設門檻、不判定）', () => {
  it('列出小規模測試團的各指標、樣本數、商品類別與團主類型；進度為「已有有效訂單的測試團數 ÷ 5」；沒有任何門檻或判定字眼', async () => {
    const s0 = await getTrialKpiSummary(w.manager);
    const { t } = await scenario();
    const s = await getTrialKpiSummary(w.manager);
    expect(s.required).toBe(5);
    expect(s.total).toBe(s0.total + 1);
    expect(s.counted).toBe(s0.counted + 1);
    const row = s.rows.find((r) => r.trialId === t)!;
    expect(row).toMatchObject({ hasData: true, hostName: '[DEMO] K 團主甲' });
    expect(row.productName).toContain('[DEMO] K 商品');
    expect(row.items).toHaveLength(8);
    expect(row.items.find((x) => x.key === 'validOrders')).toMatchObject({ status: 'OK', value: 6, lowSample: true });
    expect(row.notices.join()).toContain('資料不足');
    const text = JSON.stringify(s);
    expect(text).not.toMatch(/建議放大|建議擴大|已達標|未達標|通過門檻/);
    expect(s.note).toContain('不判定是否值得放大銷售');
    expect(s.ready).toBe(s.counted >= 5);
  });

  it('趨勢＝與前一檔比較的差（不代表好壞）；沒有成本權限者的每單貢獻利潤顯示需權限；範圍外與其他組織看不到', async () => {
    await scenario(); await scenario();
    const s = await getTrialKpiSummary(w.manager);
    const withTrend = s.rows.flatMap((r) => r.items).filter((x) => x.trend);
    expect(withTrend.length).toBeGreaterThan(0);
    for (const x of withTrend) expect(typeof x.trend!.delta).toBe('number');
    const sEd = await getTrialKpiSummary(w.editor);
    expect(sEd.rows.every((r) => r.items.find((x) => x.key === 'contributionPerOrder')!.status !== 'OK')).toBe(true);
    expect((await hostC.call('GET', '/trial-kpis/summary')).status).toBe(403);
    expect((await getTrialKpiSummary(other.manager)).total).toBe(0);
  });
});
