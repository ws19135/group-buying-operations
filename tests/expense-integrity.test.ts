import { beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '@/server/lib/db';
import { confirmExpenseClaim, createExpense, financeOverview, listExpenses, updateExpense, updateExpenseAttribution, voidExpense } from '@/server/modules/finance';
import { createTrial } from '@/server/modules/trials';
import { getTrialKpis } from '@/server/modules/trial-kpis';
import { createFeasibility } from '@/server/modules/feasibility';
import { importOrders } from '@/server/modules/orders';
import { campaignHostCommission } from '@/server/lib/commission-calc';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkCampaign, mkHost, mkProduct, mkVendor, type World } from './helpers';
import type { Actor } from '@/server/lib/permissions';

/** 合併前最終審查 F-01～F-05：財務總覽費用口徑、應收應付重新確認、付款一致性、KPI 與費用台帳不重複不漏算、跨組織／跨檔期關聯與後端權限 */
const HEADER = 'source_order_id,campaign_id,ordered_at,status,quantity,unit_price,sku_code,buyer_ref,host_id,community_id,refund_amount';
let w: World, other: World;
let v: string, hostA: string, hostB: string, hostOther: string, prodA: string, prodB: string, prodOther: string;
let camp: string, camp2: string, campOther: string;
let hostUser: Actor, vendorUser: Actor;
let n = 0;
const exp = (o: Record<string, unknown> = {}) => ({ category: 'SHIPPING', amount: 1000, incurredOn: dayOffset(-3), campaignId: camp, ...o });
const row = async (id: string) => (await query(`SELECT * FROM expenses WHERE id=$1`, [id]))[0] as Record<string, unknown>;

beforeAll(async () => {
  w = await makeWorld(); other = await makeWorld();
  v = (await mkVendor(w, '[DEMO] F 廠商')).id;
  hostA = (await mkHost(w, '[DEMO] F 團主甲')).id; hostB = (await mkHost(w, '[DEMO] F 團主乙（只在第二檔）')).id;
  hostUser = await addUser(w.orgId, 'HOST', { hostIds: [hostA] }); vendorUser = await addUser(w.orgId, 'VENDOR', { vendorIds: [v] });
  const pa = await mkProduct(w, v, { name: `[DEMO] F 商品甲 ${++n}`, skus: [{ skuCode: `F${n}`, name: 'a', groupPrice: 800, costPrice: 500 }] });
  const pb = await mkProduct(w, v, { name: `[DEMO] F 商品乙（只在第二檔） ${++n}`, skus: [{ skuCode: `F${n}`, name: 'b', groupPrice: 500, costPrice: 100 }] });
  prodA = pa.id; prodB = pb.id;
  camp = (await mkCampaign(w, v, { products: [{ productId: pa.id, skuId: pa.skuIds[0] }], hosts: [{ hostId: hostA }], sampleReadyDate: dayOffset(-30), openDate: dayOffset(-10), closeDate: dayOffset(10) })).id;
  camp2 = (await mkCampaign(w, v, { products: [{ productId: pb.id, skuId: pb.skuIds[0] }], hosts: [{ hostId: hostB }], sampleReadyDate: dayOffset(-30), openDate: dayOffset(-9), closeDate: dayOffset(11) })).id;
  await query(`UPDATE campaigns SET status='RUNNING' WHERE id IN ($1,$2)`, [camp, camp2]);
  const vo = (await mkVendor(other, '[DEMO] F 他組織廠商')).id;
  hostOther = (await mkHost(other, '[DEMO] F 他組織團主')).id;
  const po = await mkProduct(other, vo, { name: `[DEMO] F 他組織商品 ${++n}`, skus: [{ skuCode: `FO${n}`, name: 'o', groupPrice: 100, costPrice: 10 }] });
  prodOther = po.id;
  campOther = (await mkCampaign(other, vo, { products: [{ productId: po.id, skuId: po.skuIds[0] }], hosts: [{ hostId: hostOther }], sampleReadyDate: dayOffset(-30), openDate: dayOffset(-10), closeDate: dayOffset(10) })).id;
});

describe('F-01：財務總覽區分「全部登錄費用」「已確認公司承擔」「承擔方待確認」「品牌或團主承擔」', () => {
  it('同一檔期有四種費用：總覽的總額維持（全部已登錄），並另列三個口徑；三個口徑加總等於全部；承擔方待確認不算公司成本', async () => {
    const e = await createExpense(w.finance, exp({ campaignId: camp, amount: 1000, bearerParty: 'COMPANY' }) as never);
    await createExpense(w.finance, exp({ campaignId: camp, amount: 400, bearerParty: 'BRAND' }) as never);
    await createExpense(w.finance, exp({ campaignId: camp, amount: 250, bearerParty: 'HOST' }) as never);
    await createExpense(w.finance, exp({ campaignId: camp, amount: 90 }) as never);                  // 承擔方未知
    const voided = await createExpense(w.finance, exp({ campaignId: camp, amount: 5000, bearerParty: 'COMPANY' }) as never);
    await voidExpense(w.finance, voided.id, '[DEMO] 作廢不計');
    const ov = await financeOverview(w.finance);
    const c = ov.campaigns.find((x) => x.id === camp)! as unknown as Record<string, number>;
    expect(c.expenses).toBe(1000 + 400 + 250 + 90);                  // 既有欄位維持：全部已登錄（不含作廢）
    expect(c.expensesCompanyConfirmed).toBe(1000);
    expect(c.expensesPendingBearer).toBe(90);
    expect(c.expensesNotCompany).toBe(650);
    expect(c.expensesCompanyConfirmed + c.expensesPendingBearer + c.expensesNotCompany).toBe(c.expenses);
    const t = ov.totals as unknown as Record<string, number>;
    expect(t.expensesCompanyConfirmed).toBeGreaterThanOrEqual(1000); expect(t.expensesPendingBearer).toBeGreaterThanOrEqual(90);
    expect(t.expensesCompanyConfirmed + t.expensesPendingBearer + t.expensesNotCompany).toBe(t.expenses);
    expect(ov.notice).toBeTruthy();
    // 補承擔方後口徑移動、全部總額不變
    const before = c.expenses;
    const pend = (await query<{ id: string }>(`SELECT id FROM expenses WHERE campaign_id=$1 AND bearer_party IS NULL AND status='RECORDED'`, [camp]))[0].id;
    await updateExpenseAttribution(w.finance, pend, { bearerParty: 'COMPANY', termsSourceKind: 'CONTRACT', termsRef: 'C-F01' });
    const c2 = (await financeOverview(w.finance)).campaigns.find((x) => x.id === camp)! as unknown as Record<string, number>;
    expect(c2.expenses).toBe(before); expect(c2.expensesCompanyConfirmed).toBe(1090); expect(c2.expensesPendingBearer).toBe(0);
    expect(e.id).toBeTruthy();
  });
  it('總覽只是顯示：不改任何資料；沒有成本檢視權限者（營運主管有、小編沒有 finance 權限）不會多拿到歸屬資訊', async () => {
    const before = await query(`SELECT id, bearer_party, updated_at FROM expenses WHERE organization_id=$1 ORDER BY id`, [w.orgId]);
    await financeOverview(w.finance);
    expect(await query(`SELECT id, bearer_party, updated_at FROM expenses WHERE organization_id=$1 ORDER BY id`, [w.orgId])).toEqual(before);
    expect((await (await Client.forActor(w.editor)).call('GET', '/finance/overview')).status).toBe(403);
  });
});

describe('F-02：重要欄位變更後，已確認的應收／應付必須重新確認', () => {
  const confirmed = async (o: Record<string, unknown> = {}) => {
    const r = await createExpense(w.finance, exp({ bearerParty: 'COMPANY', payerParty: 'HOST', claimDirection: 'PAYABLE', claimParty: 'HOST', hostId: hostA, productId: prodA, ...o }) as never);
    await confirmExpenseClaim(w.finance, r.id, { note: '[DEMO] 已核對' });
    expect((await row(r.id)).claim_status).toBe('CONFIRMED');
    return r.id;
  };
  const expectReset = async (id: string) => {
    const x = await row(id);
    expect(x.claim_status).toBe('UNCONFIRMED'); expect(x.claim_confirmed_by).toBeNull(); expect(x.claim_confirmed_at).toBeNull();
  };
  it('金額、承擔方、實際付款方、對應團主／商品、檔期被改：一律退回未確認（不能靜默變更）', async () => {
    const a = await confirmed(); const ra = await updateExpense(w.finance, a, { amount: 1234 }) as { reconfirmRequired: boolean }; await expectReset(a);
    expect(ra.reconfirmRequired).toBe(true);
    expect((await query(`SELECT action FROM audit_logs WHERE organization_id=$1 AND entity_id=$2 AND action='expense.claim.reconfirm_required'`, [w.orgId, a])).length).toBe(1);   // 服務層留下「需要重新確認」的稽核（不只靠資料庫守衛）
    const b = await confirmed(); await updateExpenseAttribution(w.finance, b, { bearerParty: 'BRAND' }); await expectReset(b);
    const ab = (await query<{ after_data: { reconfirmRequired?: boolean } }>(`SELECT after_data FROM audit_logs WHERE organization_id=$1 AND entity_id=$2 AND action='expense.attribution.update'`, [w.orgId, b]))[0];
    expect(ab.after_data.reconfirmRequired).toBe(true);                   // 服務層明確標示需要重新確認（不只靠資料庫守衛）
    const c = await confirmed(); await updateExpenseAttribution(w.finance, c, { payerParty: 'BRAND' }); await expectReset(c);
    const d = await confirmed(); await updateExpenseAttribution(w.finance, d, { hostId: null, productId: null }); await expectReset(d);
    const e = await confirmed({ hostId: null, productId: null }); await updateExpense(w.finance, e, { campaignId: camp2 }); await expectReset(e);
  });
  it('不影響確認的欄位（付款狀態、備註、憑證連結）變更：維持已確認；確認後仍不產生付款、撥款、扣款或發票', async () => {
    const id = await confirmed();
    const tables = ['payments', 'invoices', 'settlements', 'settlement_items'];
    const cnt = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, Number((await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE organization_id=$1`, [w.orgId]))[0].n)])));
    const before = await cnt();
    await updateExpenseAttribution(w.finance, id, { paymentStatus: 'UNPAID', evidenceUrl: 'https://docs.example.invalid/f02/receipt' });
    await updateExpense(w.finance, id, { note: '[DEMO] 只改備註' });
    expect((await row(id)).claim_status).toBe('CONFIRMED');
    expect(await cnt()).toEqual(before);
  });
  it('資料庫也擋（不靠服務層）：直接改已確認費用的金額／承擔方，確認狀態自動退回', async () => {
    const id = await confirmed();
    await query(`UPDATE expenses SET amount = amount + 1 WHERE id=$1`, [id]);
    await expectReset(id);
    const id2 = await confirmed(); await query(`UPDATE expenses SET payer_party='COMPANY' WHERE id=$1`, [id2]); await expectReset(id2);
    const id3 = await confirmed(); await query(`UPDATE expenses SET note='[DEMO] 備註不影響' WHERE id=$1`, [id3]); expect((await row(id3)).claim_status).toBe('CONFIRMED');
  });
});

describe('F-03：已付款／部分付款與金額、日期的一致性', () => {
  it('已付款：已付金額不可與費用金額不同；付款日期不可是未來；部分付款：已付金額需大於 0 且小於費用金額', async () => {
    await expect(createExpense(w.finance, exp({ bearerParty: 'COMPANY', paymentStatus: 'PAID', paidOn: dayOffset(-1), paidAmount: 500 }) as never)).rejects.toThrow(/已付款.*等於費用金額|已付金額/);
    await expect(createExpense(w.finance, exp({ bearerParty: 'COMPANY', paymentStatus: 'PAID', paidOn: dayOffset(3) }) as never)).rejects.toThrow(/未來/);
    await expect(createExpense(w.finance, exp({ bearerParty: 'COMPANY', paymentStatus: 'PARTIALLY_PAID', paidOn: dayOffset(1), paidAmount: 300 }) as never)).rejects.toThrow(/未來/);
    const ok = await createExpense(w.finance, exp({ bearerParty: 'COMPANY', paymentStatus: 'PAID', paidOn: dayOffset(-1), paidAmount: 1000 }) as never);
    const ok2 = await createExpense(w.finance, exp({ bearerParty: 'COMPANY', paymentStatus: 'PAID', paidOn: dayOffset(-1) }) as never);
    expect(ok.id && ok2.id).toBeTruthy();
  });
  it('改費用金額時與付款狀態一致：已付款的費用改金額、部分付款的已付金額 ≥ 新金額，都用清楚的驗證訊息擋下（不是資料庫錯誤）', async () => {
    const paid = await createExpense(w.finance, exp({ bearerParty: 'COMPANY', paymentStatus: 'PAID', paidOn: dayOffset(-1), paidAmount: 1000 }) as never);
    await expect(updateExpense(w.finance, paid.id, { amount: 800 })).rejects.toMatchObject({ code: 'VALIDATION' });
    const part = await createExpense(w.finance, exp({ bearerParty: 'COMPANY', paymentStatus: 'PARTIALLY_PAID', paidOn: dayOffset(-1), paidAmount: 600 }) as never);
    await expect(updateExpense(w.finance, part.id, { amount: 500 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await updateExpense(w.finance, part.id, { amount: 900 });                                 // 仍大於已付金額：可以
    expect((await row(part.id)).amount).toBe(900);
    const paidNoAmt = await createExpense(w.finance, exp({ bearerParty: 'COMPANY', paymentStatus: 'PAID', paidOn: dayOffset(-1) }) as never);   // 已付款、已付金額留空（視為全額）
    await expect(updateExpense(w.finance, paidNoAmt.id, { amount: 800 })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await row(paidNoAmt.id)).amount).toBe(1000);
    const unpaid = await createExpense(w.finance, exp({ bearerParty: 'COMPANY', paymentStatus: 'UNPAID' }) as never);
    await updateExpense(w.finance, unpaid.id, { amount: 1 });                                 // 未付款改金額不受限制
  });
  it('資料庫層：已付款的已付金額必須等於費用金額（或空白）；部分付款維持小於', async () => {
    const r = await createExpense(w.finance, exp({ bearerParty: 'COMPANY', paymentStatus: 'PAID', paidOn: dayOffset(-1) }) as never);
    await expect(query(`UPDATE expenses SET paid_amount = amount - 1 WHERE id=$1`, [r.id])).rejects.toThrow();
    await expect(query(`UPDATE expenses SET paid_amount = amount WHERE id=$1`, [r.id])).resolves.toBeDefined();
  });
});

describe('F-04：KPI 貢獻利潤與費用台帳不重複計算、不漏算（口徑說明）', () => {
  const TERMS = { cashFlowMode: 'BRAND_COLLECTS', commissionBasis: 'NSV', brandFeePct: 10, serviceFeeFixed: 0, hostCommissionPct: 5, hostPaidBy: 'COMPANY', shippingPerOrder: 60, shippingBorneBy: 'COMPANY', platformFeePct: 3, platformFeeBorneBy: 'BRAND', otherVariablePerOrder: 0, otherCostBorneBy: 'COMPANY', fixedCost: 0, fixedCostBorneBy: 'COMPANY', returnCostPerRefundOrder: 20, returnCostBorneBy: 'COMPANY' };
  async function trialWithOrders() {
    const vv = (await mkVendor(w, `[DEMO] F4 廠商 ${++n}`)).id;
    const p = await mkProduct(w, vv, { name: `[DEMO] F4 商品 ${n}`, skus: [{ skuCode: `G${n}`, name: 'a', groupPrice: 800, costPrice: 500 }] });
    const cp = (await mkCampaign(w, vv, { products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: [{ hostId: hostA }], sampleReadyDate: dayOffset(-30), openDate: dayOffset(-10), closeDate: dayOffset(10) })).id;
    await query(`UPDATE campaigns SET status='RUNNING' WHERE id=$1`, [cp]);
    const rows = [HEADER]; for (let i = 1; i <= 5; i++) rows.push(`F4-${n}-${i},${cp},${dayOffset(-5)} 10:00,PAID,1,800,G${n},bf${i},${hostA},,`);
    await importOrders({ ...w.admin, source: 'TEST' }, { sourceSystem: 'T', origin: 'DEMO', fileName: `f4-${n}.csv`, csv: rows.join('\n') });
    await createFeasibility(w.manager, p.id, { campaignId: cp, inputs: TERMS, sources: Object.fromEntries(Object.keys(TERMS).map((k) => [k, { kind: 'CONTRACT' }])) } as never);
    const t = (await createTrial(w.manager, p.id, { level: 'HOST_FIT', trialType: 'MINI_GROUP', hostId: hostA, campaignId: cp })).id;
    return { cp, t };
  }
  const kpi = async (t: string) => (await getTrialKpis(w.manager, t)).items.find((x) => x.key === 'contributionPerOrder')!;
  it('KPI 貢獻利潤只取自已確認的合約條款推算：費用台帳（已確認公司承擔／品牌承擔）新增或作廢都不改變數字，因此不會與台帳重複計算；金額不變且不是 0', async () => {
    const { cp, t } = await trialWithOrders();
    const base = await kpi(t);
    expect(base.status).toBe('OK'); expect(base.value).not.toBe(0);
    const e1 = await createExpense(w.finance, exp({ campaignId: cp, amount: 777, bearerParty: 'COMPANY', payerParty: 'COMPANY' }) as never);
    await createExpense(w.finance, exp({ campaignId: cp, amount: 333, bearerParty: 'BRAND' }) as never);
    const after = await kpi(t);
    expect(after.value).toBe(base.value);                                    // 沒有把台帳再加一次
    await voidExpense(w.finance, e1.id, '[DEMO] 作廢');
    expect((await kpi(t)).value).toBe(base.value);
  });
  it('漏算提醒：台帳有「已確認公司承擔」的實際費用、但 KPI 依條款推算而未納入時，有成本檢視權限者在風險提示看到說明與差額；沒有權限者看不到；說明這是口徑差異、不改任何數字', async () => {
    const { cp, t } = await trialWithOrders();
    expect((await getTrialKpis(w.manager, t)).notices.join('\n')).not.toContain('費用台帳');
    await createExpense(w.finance, exp({ campaignId: cp, amount: 777, bearerParty: 'COMPANY' }) as never);
    await createExpense(w.finance, exp({ campaignId: cp, amount: 100, bearerParty: 'BRAND' }) as never);        // 品牌承擔：不算
    const note = (await getTrialKpis(w.manager, t)).notices.find((x) => x.includes('費用台帳'))!;
    expect(note).toContain('1 筆'); expect(note).toContain('777'); expect(note).not.toContain('877'); expect(note).toContain('未納入'); expect(note).toContain('不是重複計算');
    expect((await getTrialKpis(w.editor, t)).notices.join('\n')).not.toContain('費用台帳');
  });
});

describe('F-05：跨組織、跨檔期的資料關聯與後端權限', () => {
  it('跨組織：用他組織的檔期、團主、商品建立或調整費用 → 404；改檔期到他組織 → 404；他組織的費用讀不到、不能改、不能看歷史', async () => {
    await expect(createExpense(w.finance, exp({ campaignId: campOther }) as never)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(createExpense(w.finance, exp({ hostId: hostOther }) as never)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(createExpense(w.finance, exp({ productId: prodOther }) as never)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const mine = await createExpense(w.finance, exp({ bearerParty: 'COMPANY' }) as never);
    await expect(updateExpense(w.finance, mine.id, { campaignId: campOther })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(updateExpenseAttribution(w.finance, mine.id, { hostId: hostOther })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const theirs = await createExpense(other.finance, { category: 'OTHER', amount: 10, incurredOn: dayOffset(-1), campaignId: campOther } as never);
    await expect(updateExpense(w.finance, theirs.id, { amount: 11 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(updateExpenseAttribution(w.finance, theirs.id, { bearerParty: 'BRAND' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(confirmExpenseClaim(w.finance, theirs.id, {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(voidExpense(w.finance, theirs.id, '[DEMO] 跨組織作廢')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(((await listExpenses(w.finance, new URLSearchParams({ campaignId: campOther }))) as { items: unknown[] }).items).toHaveLength(0);
    expect((await row(theirs.id)).amount).toBe(10);                                          // 他組織資料沒被動到
  });
  it('跨檔期：對應團主／商品必須屬於該費用的檔期；改檔期時，原有的對應團主／商品若不在新檔期就擋下（不留下不一致的關聯）', async () => {
    await expect(createExpense(w.finance, exp({ campaignId: camp, hostId: hostB }) as never)).rejects.toThrow(/不在此檔期/);
    await expect(createExpense(w.finance, exp({ campaignId: camp, productId: prodB }) as never)).rejects.toThrow(/不在此檔期/);
    const r = await createExpense(w.finance, exp({ campaignId: camp, hostId: hostA, productId: prodA, bearerParty: 'COMPANY' }) as never);
    await expect(updateExpense(w.finance, r.id, { campaignId: camp2 })).rejects.toThrow(/不在此檔期|對應/);
    expect((await row(r.id)).campaign_id).toBe(camp);                                        // 沒被改
    await updateExpenseAttribution(w.finance, r.id, { hostId: null, productId: null });
    await updateExpense(w.finance, r.id, { campaignId: camp2 });                             // 清掉對應後可以改檔期
    expect((await row(r.id)).campaign_id).toBe(camp2);
    // 資料庫層：不存在於任何檔期的對應也不能直接寫成跨組織的團主（外鍵＋服務層）
    await expect(query(`UPDATE expenses SET host_id='OWN-NOPE' WHERE id=$1`, [r.id])).rejects.toThrow();
  });
  it('跨檔期（只有團主、或只有商品）：各自都會被擋，不依賴另一個檢查', async () => {
    const onlyHost = await createExpense(w.finance, exp({ campaignId: camp, hostId: hostA, bearerParty: 'COMPANY' }) as never);
    await expect(updateExpense(w.finance, onlyHost.id, { campaignId: camp2 })).rejects.toThrow(/對應的團主不在新的檔期/);
    const onlyProd = await createExpense(w.finance, exp({ campaignId: camp, productId: prodA, bearerParty: 'COMPANY' }) as never);
    await expect(updateExpense(w.finance, onlyProd.id, { campaignId: camp2 })).rejects.toThrow(/對應的商品不在新的檔期/);
    expect((await row(onlyHost.id)).campaign_id).toBe(camp); expect((await row(onlyProd.id)).campaign_id).toBe(camp);
  });
  it('後端權限（API）：小編／團主／廠商 403；營運主管只讀；他組織財務 404；歷史與待補清單同樣', async () => {
    const mine = await createExpense(w.finance, exp({ bearerParty: 'COMPANY' }) as never);
    for (const actor of [w.editor, hostUser, vendorUser]) {
      const c = await Client.forActor(actor);
      for (const [m, p, b] of [['GET', '/expenses', undefined], ['GET', `/expenses/${mine.id}/history`, undefined], ['PATCH', `/expenses/${mine.id}`, { amount: 5 }], ['PATCH', `/expenses/${mine.id}/attribution`, { bearerParty: 'BRAND' }], ['POST', `/expenses/${mine.id}/claim/confirm`, {}], ['POST', `/expenses/${mine.id}/void`, { reason: 'x' }], ['GET', '/finance/overview', undefined]] as const) {
        expect((await c.call(m, p, b)).status, `${actor.role} ${m} ${p}`).toBe(403);
      }
    }
    const mc = await Client.forActor(w.manager);
    expect((await mc.call('PATCH', `/expenses/${mine.id}`, { amount: 5 })).status).toBe(403);               // 營運主管沒有財務寫入
    expect((await mc.call('GET', `/expenses/${mine.id}/history`)).status).toBe(200);
    const oc = await Client.forActor(other.finance);
    for (const [m, p, b] of [['PATCH', `/expenses/${mine.id}`, { amount: 5 }], ['PATCH', `/expenses/${mine.id}/attribution`, { bearerParty: 'BRAND' }], ['POST', `/expenses/${mine.id}/claim/confirm`, {}], ['POST', `/expenses/${mine.id}/void`, { reason: 'x' }], ['GET', `/expenses/${mine.id}/history`, undefined]] as const) {
      expect((await oc.call(m, p, b)).status, `他組織 ${m} ${p}`).toBe(404);
    }
    expect((await row(mine.id)).amount).toBe(1000);
    // 結算與佣金不受這些費用操作影響
    expect(await campaignHostCommission(pool(), w.orgId, camp)).toBeDefined();
  });
});
