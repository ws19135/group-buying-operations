import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { DD_CATEGORIES } from '@/server/lib/dd-catalog';
import { addDays } from '@/server/lib/dates';
import { todayTaipei } from '@/server/lib/ids';
import { setCampaignHostStatus } from '@/server/modules/campaigns';
import { decideApproval, gateCheck, requestApproval, transitionCampaign } from '@/server/modules/gates';
import { setProductReview } from '@/server/modules/products';
import { setTaskStatus } from '@/server/modules/tasks';
import { createEvaluation, reviewEvaluation, submitEvaluation, updateEvaluation } from '@/server/modules/selection';
import { createDiligence, getDiligence, reviewDiligence, setLegalStatus, submitDiligence, updateDiligence, updateDiligenceItem } from '@/server/modules/diligence';
import { createEvidence } from '@/server/modules/evidence';
import { concludeTrial, createTrial, getTrial, reviewTrial, updateTrialCheck } from '@/server/modules/trials';
import { createFeasibility } from '@/server/modules/feasibility';
import { g1Summary } from '@/server/modules/decision-summary';
import type { Actor } from '@/server/lib/permissions';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkCampaign, mkHost, mkProduct, mkVendor, type World } from './helpers';

let w: World;
let vendorId: string, hostId: string;
let ed: Client, ed2: Client, hostC: Client, vendC: Client, fin: Client;
const today = todayTaipei();
let n = 0;
const strip = (cs: { key: string; level: string; ok: boolean; detail?: string }[]) => cs.map((c) => ({ key: c.key, level: c.level, ok: c.ok, detail: c.detail }));
const src = (keys: string[]): Record<string, { kind: 'VENDOR_QUOTE' }> => Object.fromEntries(keys.map((k) => [k, { kind: 'VENDOR_QUOTE' as const }]));

type Summary = Awaited<ReturnType<typeof g1Summary>>;
type PS = Summary['products'][number];

async function mkCamp(by: Actor = w.editor, productIds: { id: string; skuIds: string[] }[] = []) {
  const camp = await mkCampaign(w, vendorId, { sampleReadyDate: dayOffset(1), openDate: dayOffset(20), closeDate: dayOffset(30), products: productIds.map((p) => ({ productId: p.id, skuId: p.skuIds[0] })), hosts: [{ hostId }] }, by);
  return camp.id;
}
async function prepareG1(id: string) {
  await transitionCampaign(w.editor, id, 'EVALUATING');
  await setCampaignHostStatus(w.editor, id, hostId, 'CONFIRMED');
  for (const k of ['SAMPLE_SHIP', 'TRIAL_ARRIVAL', 'TRIAL_FEEDBACK']) {
    const t = (await query<{ id: string }>('SELECT id FROM tasks WHERE campaign_id=$1 AND step_key=$2', [id, k]))[0].id;
    await setTaskStatus(w.editor, t, { to: 'DONE' });
  }
}
const counts = async (campaignId: string) => ({
  approvals: (await query<{ n: number }>('SELECT count(*)::int AS n FROM approvals WHERE campaign_id=$1', [campaignId]))[0].n,
  notifications: (await query<{ n: number }>('SELECT count(*)::int AS n FROM notifications WHERE organization_id=$1', [w.orgId]))[0].n,
  tasks: (await query<{ n: number }>('SELECT count(*)::int AS n FROM tasks WHERE campaign_id=$1', [campaignId]))[0].n,
  status: (await query<{ status: string }>('SELECT status FROM campaigns WHERE id=$1', [campaignId]))[0].status,
});

// ---- 把一個商品整備到「全綠」所需的各項資料 ----
async function goodEvaluation(productId: string, compliance: { status: string; note?: string } = { status: 'PASS' }) {
  const { id } = await createEvaluation(w.editor, productId);
  const e1 = await createEvidence(w.editor, { subjectType: 'EVALUATION', subjectId: id, kind: 'TEST_REPORT', title: '[DEMO] 報告', url: 'https://docs.example.invalid/r' });
  const e2 = await createEvidence(w.editor, { subjectType: 'EVALUATION', subjectId: id, kind: 'QUOTE', title: '[DEMO] 供貨', url: 'https://docs.example.invalid/s' });
  const sc = (v: number, ev?: string[]) => ({ score: v, reason: '[DEMO] 理由', ...(ev ? { evidenceIds: ev } : {}) });
  await updateEvaluation(w.editor, id, { scores: { need: sc(4), quality: sc(4, [e1.id]), profit: sc(4), supply: sc(4, [e2.id]), content: sc(4), repeat: sc(4) }, compliance: compliance as never });
  await submitEvaluation(w.editor, id);
  await reviewEvaluation(w.manager, id, { decision: 'ACCEPTED' });
  return id;
}
async function goodDiligence(productId: string | null) {
  const { id } = await createDiligence(w.editor, vendorId, { contractVersion: `g1-${++n}`, ...(productId ? { productId } : {}) });
  for (const c of DD_CATEGORIES) {
    const it = ((await getDiligence(w.manager, id)).items as unknown as { id: string; categoryKey: string }[]).find((i) => i.categoryKey === c.key) as { id: string };
    if (c.evidenceRequired) {
      await createEvidence(w.manager, { subjectType: 'DD_ITEM', subjectId: it.id, kind: 'CERTIFICATE', title: '[DEMO] 文件', url: 'https://docs.example.invalid/dd', validUntil: addDays(today, 200) });
      await updateDiligenceItem(w.manager, it.id, { status: 'CONFIRMED' });
    } else await updateDiligenceItem(w.manager, it.id, { status: 'NOT_APPLICABLE', naReason: '[DEMO] 無' });
  }
  await submitDiligence(w.editor, id); await reviewDiligence(w.manager, id, { decision: 'APPROVED' });
  return id;
}
async function trial(productId: string, conclusion: 'PASS' | 'FAIL', opts: { campaignId?: string; level?: 'QUALIFICATION' | 'HOST_FIT'; accept?: boolean } = {}) {
  const level = opts.level ?? 'QUALIFICATION';
  const { id } = await createTrial(w.manager, productId, level === 'QUALIFICATION'
    ? { level, trialType: 'INTERNAL', ...(opts.campaignId ? { campaignId: opts.campaignId } : {}) }
    : { level, trialType: 'DESIGNATED_HOST', hostId, campaignId: opts.campaignId, reuseQualification: false });
  for (const c of (await getTrial(w.manager, id)).checks as unknown as { id: string; itemKey: string }[]) {
    await updateTrialCheck(w.manager, c.id, conclusion === 'PASS' || c.itemKey !== 'quality'
      ? { result: 'PASS', evidenceText: '[DEMO] 紀錄' } : { result: 'FAIL', defectSeverity: 'CRITICAL', defectNote: '[DEMO] 漏液', riskNote: '[DEMO] 安全疑慮' });
  }
  await concludeTrial(w.manager, id, { conclusion, note: '[DEMO] 結論' });
  if (opts.accept !== false) await reviewTrial(w.manager, id, { decision: 'ACCEPTED' });
  return id;
}
const goodFeasibility = (productId: string, campaignId: string, over: Record<string, unknown> = {}) => {
  const inputs = { expectedOrders: 100, unitPrice: 1000, refundRatePct: 10, unitCost: 500, shippingPerOrder: 60, platformFeePct: 3, otherVariablePerOrder: 0, fixedCost: 2000, brandFeePct: 10, serviceFeeFixed: 0, hostCommissionPct: 5,
    commissionBasis: 'NSV', hostPaidBy: 'COMPANY', cashFlowMode: 'BRAND_COLLECTS', shippingBorneBy: 'BRAND', platformFeeBorneBy: 'BRAND', otherCostBorneBy: 'COMPANY', fixedCostBorneBy: 'COMPANY', ...over };
  return createFeasibility(w.manager, productId, { campaignId, inputs: inputs as never, sources: src(Object.keys(inputs)) as never });
};

beforeAll(async () => {
  w = await makeWorld();
  vendorId = (await mkVendor(w, '[DEMO] G1 廠商', { category: '家電' })).id;
  hostId = (await mkHost(w, '[DEMO] G1 團主')).id;
  const hu = await addUser(w.orgId, 'HOST', { hostIds: [hostId] }); const vu = await addUser(w.orgId, 'VENDOR', { vendorIds: [vendorId] });
  [ed, ed2, hostC, vendC, fin] = await Promise.all([Client.forActor(w.editor), Client.forActor(w.editor2), Client.forActor(hu), Client.forActor(vu), Client.forActor(w.finance)]);
});

describe('G1–G5 與商品審核語意不變（回歸）：評估、調查、試用、可行性都不改關卡檢查、核准或狀態', () => {
  it('同一檔期：建立並覆核全部資料前後，G1 檢查完全相同；沒有新增核准、通知、任務；檔期狀態不變', async () => {
    const p = await mkProduct(w, vendorId, { approve: true });
    const id = await mkCamp(w.editor, [p]);
    await prepareG1(id);
    const before = strip(await gateCheck(w.editor, id, 'G1'));
    const c0 = await counts(id);

    await goodEvaluation(p.id);
    await goodDiligence(p.id);
    await trial(p.id, 'FAIL', { campaignId: id });                 // 即使試用不通過
    await goodFeasibility(p.id, id, { unitCost: 99999 });          // 即使試算虧損
    const s = await g1Summary(w.manager, id);
    expect(s.light).toBe('RED');                                    // 摘要顯示紅燈…

    expect(strip(await gateCheck(w.editor, id, 'G1'))).toEqual(before);   // …但 G1 檢查項一個字都沒變
    const c1 = await counts(id);
    expect(c1).toEqual(c0);
  });
  it('G1 檢查項清單沒有新增任何選品／試用相關項目', async () => {
    const id = await mkCamp(w.editor, [await mkProduct(w, vendorId, { approve: true })]);
    expect((await gateCheck(w.editor, id, 'G1')).map((c) => c.key).sort()).toEqual(['deps_done', 'has_confirmed_host', 'has_products', 'vendor_info', 'vendor_ok']);
  });
  it('就算摘要是紅燈（合規未過、試用不通過），G1 仍可申請並由主管核准；摘要與分數從不自動核准', async () => {
    const p = await mkProduct(w, vendorId, { approve: true });
    const id = await mkCamp(w.editor, [p]);
    await prepareG1(id);
    await goodEvaluation(p.id, { status: 'FAIL', note: '[DEMO] 標示不符' });
    await trial(p.id, 'FAIL', { campaignId: id });
    expect((await g1Summary(w.manager, id)).light).toBe('RED');
    expect((await counts(id)).status).toBe('EVALUATING');                    // 看摘要不會自動申請或核准
    const g1 = await requestApproval(w.editor, id, 'G1', '[DEMO] 申請');
    expect((await counts(id)).status).toBe('PENDING_G1');
    await expect(decideApproval(w.editor, g1.id, 'APPROVED')).rejects.toThrow(/不能決定/);   // 營運小編仍不能核准
    await decideApproval(w.manager, g1.id, 'APPROVED', '[DEMO] 主管決定');
    expect((await counts(id)).status).toBe('PREPARING');
  });
  it('商品審核流程不變：DRAFT→PENDING_REVIEW→APPROVED／REJECTED 與權限照舊，評估退回不影響商品狀態', async () => {
    const p = await mkProduct(w, vendorId);
    const stat = async () => (await query<{ review_status: string }>('SELECT review_status FROM products WHERE id=$1', [p.id]))[0].review_status;
    expect(await stat()).toBe('DRAFT');
    const ev = await goodEvaluation(p.id);
    await reviewEvaluation(w.manager, ev, { decision: 'REJECTED', note: '[DEMO] 不採用' }).catch(() => undefined);   // 已覆核過一次 → 可再覆核
    expect(await stat()).toBe('DRAFT');
    await setProductReview(w.editor, p.id, 'PENDING_REVIEW');
    await expect(setProductReview(w.editor, p.id, 'APPROVED')).rejects.toThrow(/沒有權限/);
    await setProductReview(w.manager, p.id, 'APPROVED');
    expect(await stat()).toBe('APPROVED');
    const p2 = await mkProduct(w, vendorId);
    await setProductReview(w.editor, p2.id, 'PENDING_REVIEW');
    await expect(setProductReview(w.manager, p2.id, 'REJECTED')).rejects.toThrow(/原因/);
    await setProductReview(w.manager, p2.id, 'REJECTED', '[DEMO] 退回');
  });
  it('唯讀摘要不寫入任何資料（呼叫前後各表列數相同）', async () => {
    const p = await mkProduct(w, vendorId, { approve: true });
    const id = await mkCamp(w.editor, [p]);
    const tables = ['audit_logs', 'evidence_items', 'product_evaluations', 'product_trials', 'vendor_dd_records', 'feasibility_scenarios', 'approvals', 'notifications', 'tasks'];
    const snap = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, (await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE organization_id=$1`, [w.orgId]))[0].n])));
    const a = await snap();
    await g1Summary(w.manager, id); await g1Summary(w.editor, id);
    expect(await snap()).toEqual(a);
  });
});

describe('G1 統一決策摘要', () => {
  it('gateImpact 恆為 NONE，並附說明；沒有商品的檔期是黃燈', async () => {
    const id = await mkCamp(w.editor, []);
    const s = await g1Summary(w.manager, id);
    expect(s).toMatchObject({ gateImpact: 'NONE', light: 'YELLOW', products: [] });
    expect(s.note).toContain('不是 G1 的檢查項');
  });
  it('什麼都沒做：每個面向都是缺口（黃燈），沒有阻礙', async () => {
    const p = await mkProduct(w, vendorId, { approve: true });
    const s = await g1Summary(w.manager, await mkCamp(w.editor, [p]));
    const ps = s.products[0];
    expect(ps.light).toBe('YELLOW');
    expect(ps.risks.every((r) => r.level === 'GAP')).toBe(true);
    expect(new Set(ps.risks.map((r) => r.area))).toEqual(new Set(['EVALUATION', 'DILIGENCE', 'TRIAL', 'FEASIBILITY']));
    expect(ps).toMatchObject({ evaluation: null, diligence: null, qualification: null, trials: [], feasibility: null });
  });
  it('全部齊備 → 綠燈：評估、調查、資格、可行性資料都彙整在一頁，附分數、建議、有效期', async () => {
    const p = await mkProduct(w, vendorId, { approve: true });
    const id = await mkCamp(w.editor, [p]);
    const ev = await goodEvaluation(p.id);
    const dd = await goodDiligence(p.id);
    const q = await trial(p.id, 'PASS');
    await goodFeasibility(p.id, id);
    const ps = (await g1Summary(w.manager, id)).products[0] as PS;
    expect(ps.risks).toEqual([]);
    expect(ps.light).toBe('GREEN');
    expect(ps.evaluation).toMatchObject({ id: ev, totalScore: 80, recommendation: 'PROCEED', reviewDecision: 'ACCEPTED', compliance: { status: 'PASS' } });
    expect(ps.diligence).toMatchObject({ id: dd, status: 'APPROVED', scope: 'PRODUCT', validity: { valid: true } });
    expect(ps.qualification).toMatchObject({ trialId: q, valid: true, conclusion: 'PASS' });
    expect(ps.feasibility).toMatchObject({ scope: 'CAMPAIGN', results: { companyRevenue: 9000, brandProfit: 22000 } });
  });
  it('廠商層級的調查也算（商品沒有專屬調查時），商品專屬的優先', async () => {
    const p1 = await mkProduct(w, vendorId, { approve: true }), p2 = await mkProduct(w, vendorId, { approve: true });
    const ddVendor = await goodDiligence(null);
    const id = await mkCamp(w.editor, [p1, p2]);
    const dd2 = await goodDiligence(p2.id);
    const s = await g1Summary(w.manager, id);
    const byId = Object.fromEntries(s.products.map((x) => [x.productId, x]));
    expect(byId[p1.id].diligence).toMatchObject({ scope: 'VENDOR' });
    expect(byId[p2.id].diligence).toMatchObject({ id: dd2, scope: 'PRODUCT' });
    expect(ddVendor).toBeTruthy();
  });
  it('阻礙性風險（紅燈）：合規未過、調查被退回、法務封鎖、試用不通過、核准後證據過期、商品被退回', async () => {
    const mk = async () => { const p = await mkProduct(w, vendorId, { approve: true }); const id = await mkCamp(w.editor, [p]); return { p, id }; };
    const red = async (id: string) => (await g1Summary(w.manager, id)).products[0];
    { const { p, id } = await mk(); await goodEvaluation(p.id, { status: 'FAIL', note: '[DEMO] 不合格' }); const r = await red(id); expect(r.light).toBe('RED'); expect(r.risks.some((x) => x.level === 'BLOCKING' && x.message.includes('合規'))).toBe(true); }
    { const { p, id } = await mk(); const d = await goodDiligence(p.id); await reviewDiligence(w.manager, d, { decision: 'REJECTED', note: '[DEMO] 撤銷' }); expect((await red(id)).risks.some((x) => x.level === 'BLOCKING' && x.area === 'DILIGENCE')).toBe(true); }
    { const { p, id } = await mk(); const d = await createDiligence(w.editor, vendorId, { contractVersion: `g1-${++n}`, productId: p.id }); await updateDiligence(w.editor, d.id, { regulatedCategory: 'MEDICAL_DEVICE' });
      const it1 = ((await getDiligence(w.manager, d.id)).items as unknown as { id: string; categoryKey: string }[]).find((i) => i.categoryKey === 'SOURCE_LICENSE_QA') as { id: string };
      await setLegalStatus(w.manager, it1.id, { action: 'BLOCK', note: '[DEMO] 不合規' }); expect((await red(id)).risks.map((x) => x.message)).toContain('有項目被法務封鎖，不得合作'); }
    { const { p, id } = await mk(); await trial(p.id, 'FAIL'); expect((await red(id)).risks.map((x) => x.message)).toContain('商品資格試用不通過'); }
    { const { p, id } = await mk(); const d = await goodDiligence(p.id);
      await query(`UPDATE evidence_items SET valid_until=$2 WHERE organization_id=$1 AND subject_type='DD_ITEM' AND subject_id IN (SELECT id FROM vendor_dd_items WHERE record_id=$3)`, [w.orgId, addDays(today, -1), d]);
      const r = await red(id); expect(r.light).toBe('RED'); expect(r.risks.some((x) => x.level === 'BLOCKING' && x.message.includes('已失效'))).toBe(true); }
    { const p = await mkProduct(w, vendorId); const id = await mkCamp(w.editor, [p]); await setProductReview(w.editor, p.id, 'PENDING_REVIEW'); await setProductReview(w.manager, p.id, 'REJECTED', '[DEMO] 退回'); expect((await red(id)).risks.map((x) => x.message)).toContain('商品審核被退回'); }
  });
  it('試用只看最新一次：失敗後重測通過，紅燈解除', async () => {
    const p = await mkProduct(w, vendorId, { approve: true });
    const id = await mkCamp(w.editor, [p]);
    await trial(p.id, 'FAIL', { campaignId: id, level: 'HOST_FIT' });
    expect((await g1Summary(w.manager, id)).products[0].risks.some((r) => r.message === '本檔試用不通過')).toBe(true);
    await trial(p.id, 'PASS', { campaignId: id, level: 'HOST_FIT' });
    expect((await g1Summary(w.manager, id)).products[0].risks.some((r) => r.message === '本檔試用不通過')).toBe(false);
  });
  it('商品資料改變使資格失效 → 摘要提示（缺口），不是靜默沿用', async () => {
    const p = await mkProduct(w, vendorId, { approve: true });
    const id = await mkCamp(w.editor, [p]);
    await trial(p.id, 'PASS');
    expect((await g1Summary(w.manager, id)).products[0].qualification).toMatchObject({ valid: true });
    await query(`UPDATE products SET compliance_note='[DEMO] 改了' WHERE id=$1`, [p.id]);
    const ps = (await g1Summary(w.manager, id)).products[0];
    expect(ps.qualification).toMatchObject({ valid: false });
    expect(ps.risks.some((r) => r.message.includes('商品資格已失效'))).toBe(true);
  });
  it('敏感資料：營運小編的摘要沒有成本、利潤，也不會從風險訊息洩漏利潤正負；主管看得到', async () => {
    const p = await mkProduct(w, vendorId, { approve: true });
    const id = await mkCamp(w.editor, [p]);
    await goodFeasibility(p.id, id, { unitCost: 48731 });           // 虧損情境
    const asMgr = (await g1Summary(w.manager, id)).products[0];
    expect(asMgr.risks.map((r) => r.message)).toContain('試算的品牌利潤為負');
    const asEd = await g1Summary(w.editor, id);
    expect(asEd.canSeeMoney).toBe(false);
    expect(asEd.products[0].risks.map((r) => r.message).join()).not.toContain('為負');
    expect(asEd.products[0].feasibility).toMatchObject({ restricted: true, results: { brandProfit: null, companyRevenue: null, gmv: 100000 } });
    const raw = JSON.stringify((await ed.call('GET', `/campaigns/${id}/g1-summary`)).json);
    expect(raw).not.toContain('48731');
    expect(raw).not.toContain('4873100');
    expect((await fin.call('GET', `/campaigns/${id}/g1-summary`)).data.canSeeMoney).toBe(true);
  });
  it('檔期資料範圍：別的小編負責的檔期 404；團主與廠商 403；財務可讀', async () => {
    const id = await mkCamp(w.editor, [await mkProduct(w, vendorId, { approve: true })]);
    expect((await ed2.call('GET', `/campaigns/${id}/g1-summary`)).status).toBe(404);
    expect((await ed.call('GET', `/campaigns/${id}/g1-summary`)).status).toBe(200);
    expect((await hostC.call('GET', `/campaigns/${id}/g1-summary`)).status).toBe(403);
    expect((await vendC.call('GET', `/campaigns/${id}/g1-summary`)).status).toBe(403);
    expect((await fin.call('GET', `/campaigns/${id}/g1-summary`)).status).toBe(200);
    expect((await ed.call('GET', `/campaigns/CMP-000000-0000/g1-summary`)).status).toBe(404);
  });
  it('SOP 01 客群適配統計以唯讀方式併入（有權限者）', async () => {
    const p = await mkProduct(w, vendorId, { approve: true });
    const id = await mkCamp(w.editor, [p]);
    const s = (await g1Summary(w.manager, id)).products[0];
    expect(s.fit).toEqual({});
    expect((await g1Summary(w.finance, id)).products[0].fit).toBeNull();   // 財務沒有 fit.read → 不顯示
  });
});
