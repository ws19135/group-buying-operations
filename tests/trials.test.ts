import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { CHECK_CATALOG } from '@/server/lib/trial-catalog';
import { cancelTrial, campaignTrials, concludeTrial, createTrial, getTrial, listProductTrials, qualificationFor, reviewTrial, updateTrial, updateTrialCheck } from '@/server/modules/trials';
import { updateProduct } from '@/server/modules/products';
import { putSelectionConfig, getSelectionConfig } from '@/server/modules/selection';
import { createEvidence } from '@/server/modules/evidence';
import { todayTaipei } from '@/server/lib/ids';
import { addDays } from '@/server/lib/dates';
import type { Actor } from '@/server/lib/permissions';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkCampaign, mkHost, mkProduct, mkVendor, type World } from './helpers';

let w: World, other: World;
let vendorId: string, hostId: string;
let ed: Client, ed2: Client, hostC: Client, vendC: Client, fin: Client;
const today = todayTaipei();
let n = 0;

const newProduct = async (over: Record<string, unknown> = {}) => (await mkProduct(w, vendorId, { name: `[DEMO] 試用商品 ${++n}${Math.random().toString(36).slice(2, 5)}`, ...over }));

type Check = { id: string; itemKey: string; dimension: string; result: string };
const checks = async (trialId: string, as: Actor = w.manager) => (await getTrial(as, trialId)).checks as unknown as Check[];

/** 把所有檢核項填成通過（客觀證據必填）；可指定哪些項目改成其他結果 */
async function fillChecks(trialId: string, overrides: Record<string, Record<string, unknown>> = {}, as: Actor = w.manager) {
  for (const c of await checks(trialId, as)) {
    const o = overrides[c.itemKey] ?? { result: 'PASS', evidenceText: `[DEMO] ${c.itemKey} 實測紀錄` };
    await updateTrialCheck(as, c.id, o as never);
  }
}
async function passedQualification(productId: string, as: Actor = w.manager) {
  const { id } = await createTrial(as, productId, { level: 'QUALIFICATION', trialType: 'INTERNAL' });
  await fillChecks(id, {}, as);
  await concludeTrial(as, id, { conclusion: 'PASS', note: '[DEMO] 全數通過' });
  await reviewTrial(w.manager, id, { decision: 'ACCEPTED' });
  return id;
}

beforeAll(async () => {
  w = await makeWorld(); other = await makeWorld();
  vendorId = (await mkVendor(w, '[DEMO] 試用廠商', { category: '家電' })).id;
  hostId = (await mkHost(w, '[DEMO] 試用團主')).id;
  const hostUser = await addUser(w.orgId, 'HOST', { hostIds: [hostId] });
  const vendUser = await addUser(w.orgId, 'VENDOR', { vendorIds: [vendorId] });
  [ed, ed2, hostC, vendC, fin] = await Promise.all([Client.forActor(w.editor), Client.forActor(w.editor2), Client.forActor(hostUser), Client.forActor(vendUser), Client.forActor(w.finance)]);
});

describe('試用：建立、類型、重複、日期', () => {
  it('資格驗證建立後自動產生四面向 18 個檢核項（全部未測）', async () => {
    const p = await newProduct();
    const { id } = await createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL', testerUserId: w.editor.userId, shipDate: dayOffset(-10), arrivalDate: dayOffset(-8), startDate: dayOffset(-7), carrier: '[DEMO] 物流', trackingNo: 'DEMO123' });
    const t = await getTrial(w.editor, id);
    expect(t).toMatchObject({ status: 'OPEN', level: 'QUALIFICATION', trialType: 'INTERNAL', vendorId, testerName: expect.any(String), carrier: '[DEMO] 物流', trackingNo: 'DEMO123' });
    expect((t.checks as Check[])).toHaveLength(CHECK_CATALOG.length);
    expect(new Set((t.checks as Check[]).map((c) => c.dimension))).toEqual(new Set(['PRODUCT', 'CUSTOMER', 'CONTENT', 'BUSINESS']));
    expect((t.checks as Check[]).every((c) => c.result === 'NOT_TESTED')).toBe(true);
    expect(t.suggestion).toMatchObject({ conclusion: 'RETEST' });
  });
  it('同一商品可以有多次試用；進行中的相同組合不能重複（409），已結論／取消後可再開', async () => {
    const p = await newProduct();
    const a = await createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' });
    await expect(createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'DESIGNATED_HOST', hostId });          // 不同類型 OK
    await cancelTrial(w.editor, a.id, '[DEMO] 樣品延遲');
    const b = await createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' });               // 取消後可再開
    expect(b.id).not.toBe(a.id);
    expect((await listProductTrials(w.editor, p.id)).items).toHaveLength(3);
  });
  it('資料庫層也擋重複進行中（直接下 SQL）', async () => {
    const p = await newProduct();
    const a = await createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' });
    await expect(query(`INSERT INTO product_trials (id, organization_id, product_id, vendor_id, level, trial_type) SELECT 'TRL-DUP1', organization_id, product_id, vendor_id, level, trial_type FROM product_trials WHERE id=$1`, [a.id])).rejects.toThrow(/duplicate|unique/i);
  });
  it('類型規則：團主適配不可為內部試用；指定團主要選團主；小規模測試團要選檔期', async () => {
    const p = await newProduct();
    await expect(createTrial(w.editor, p.id, { level: 'HOST_FIT', trialType: 'INTERNAL' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'DESIGNATED_HOST' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createTrial(w.editor, p.id, { level: 'HOST_FIT', trialType: 'MINI_GROUP' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  it('日期先後：到貨不得早於寄樣、開始不得早於到貨…（建立與更新都檢查）', async () => {
    const p = await newProduct();
    await expect(createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL', shipDate: dayOffset(-1), arrivalDate: dayOffset(-3) })).rejects.toThrow(/到貨日/);
    const { id } = await createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL', shipDate: dayOffset(-5), arrivalDate: dayOffset(-3) });
    await expect(updateTrial(w.editor, id, { startDate: dayOffset(-4) })).rejects.toThrow(/開始試用日/);
    await updateTrial(w.editor, id, { startDate: dayOffset(-2), feedbackDate: dayOffset(-1) });
    await expect(query(`UPDATE product_trials SET closed_date=$2 WHERE id=$1`, [id, dayOffset(-10)])).rejects.toThrow();   // DB CHECK
  });
  it('規格、團主、試用人、寄樣批次的驗證', async () => {
    const p = await newProduct(), p2 = await newProduct();
    await expect(createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL', skuId: p2.skuIds[0] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'DESIGNATED_HOST', hostId: 'OWN-9999' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL', testerUserId: 'USR-9999' })).rejects.toMatchObject({ code: 'VALIDATION' });
    const sku = await createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL', skuId: p.skuIds[0] });
    expect((await getTrial(w.editor, sku.id)).skuId).toBe(p.skuIds[0]);
  });
  it('備註含電話被拒；冪等鍵重送回同一筆', async () => {
    const p = await newProduct();
    await expect(createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL', testerNote: '0912-345-678' })).rejects.toMatchObject({ code: 'VALIDATION' });
    const a = await createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' }, 'idem-trial-1');
    const b = await createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' }, 'idem-trial-1');
    expect(b.id).toBe(a.id);
  });
});

describe('試用：試用品回收', () => {
  it('需回收 → 待回收；標已回收需日期；不需回收則重設；結論後仍可補寫回收', async () => {
    const p = await newProduct();
    const { id } = await createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL', recoveryRequired: true });
    expect(await getTrial(w.editor, id)).toMatchObject({ recoveryRequired: true, recoveryStatus: 'PENDING' });
    await expect(updateTrial(w.editor, id, { recoveryStatus: 'RECOVERED' })).rejects.toThrow(/回收日期/);
    await fillChecks(id); await concludeTrial(w.manager, id, { conclusion: 'PASS', note: '[DEMO] ok' });
    await updateTrial(w.editor, id, { recoveryStatus: 'RECOVERED', recoveryDate: today, recoveryNote: '[DEMO] 已退回廠商' });
    expect(await getTrial(w.editor, id)).toMatchObject({ status: 'CONCLUDED', recoveryStatus: 'RECOVERED', recoveryDate: today });
    await updateTrial(w.editor, id, { recoveryRequired: false });
    expect(await getTrial(w.editor, id)).toMatchObject({ recoveryRequired: false, recoveryStatus: 'NOT_REQUIRED' });
  });
  it('結論後不可改的欄位（結論本身）被資料庫觸發器擋住', async () => {
    const p = await newProduct();
    const { id } = await createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' });
    await fillChecks(id); await concludeTrial(w.manager, id, { conclusion: 'PASS', note: '[DEMO] ok' });
    await expect(query(`UPDATE product_trials SET conclusion='FAIL' WHERE id=$1`, [id])).rejects.toThrow(/不可修改/);
    await expect(query(`UPDATE product_trials SET valid_until=$2 WHERE id=$1`, [id, addDays(today, 999)])).rejects.toThrow(/不可修改/);
    await expect(query(`DELETE FROM product_trials WHERE id=$1`, [id])).rejects.toThrow();
  });
});

describe('試用：四面向檢核與客觀證據', () => {
  it('通過需客觀證據；缺陷要說明；不通過需缺陷或風險說明', async () => {
    const p = await newProduct();
    const { id } = await createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' });
    const c = (await checks(id)).find((x) => x.itemKey === 'quality') as Check;
    await expect(updateTrialCheck(w.editor, c.id, { result: 'PASS' })).rejects.toThrow(/客觀證據/);
    await expect(updateTrialCheck(w.editor, c.id, { result: 'CONCERN', defectSeverity: 'MINOR' })).rejects.toThrow(/缺陷/);
    await expect(updateTrialCheck(w.editor, c.id, { result: 'FAIL' })).rejects.toThrow(/缺陷或風險/);
    await updateTrialCheck(w.editor, c.id, { result: 'PASS', evidenceText: '[DEMO] 3 件抽檢全數合格' });
    const back = (await checks(id)).find((x) => x.itemKey === 'quality') as Check & { verifiedBy: string; evidenceText: string };
    expect(back).toMatchObject({ result: 'PASS', evidenceText: '[DEMO] 3 件抽檢全數合格', verifiedBy: w.editor.userId });
    await expect(query(`UPDATE trial_checks SET result='PASS', evidence_text=NULL WHERE id=$1`, [c.id])).rejects.toThrow();   // DB CHECK
  });
  it('客觀證據含電話被拒；檢核項可附證據連結', async () => {
    const p = await newProduct();
    const { id } = await createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' });
    const c = (await checks(id)).find((x) => x.itemKey === 'packaging') as Check;
    await expect(updateTrialCheck(w.editor, c.id, { result: 'PASS', evidenceText: '買家 0912345678 說很好' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await createEvidence(w.editor, { subjectType: 'TRIAL_CHECK', subjectId: c.id, kind: 'PHOTO', title: '[DEMO] 開箱照', url: 'https://docs.example.invalid/photo' });
    const t = await getTrial(w.editor, id);
    expect(((t.checks as unknown as { itemKey: string; evidence: unknown[] }[]).find((x) => x.itemKey === 'packaging'))?.evidence).toHaveLength(1);
  });
  it('結論或取消後，檢核項與證據都鎖定（服務層與資料庫）', async () => {
    const p = await newProduct();
    const { id } = await createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' });
    const c = (await checks(id))[0];
    await cancelTrial(w.editor, id, '[DEMO] 取消');
    await expect(updateTrialCheck(w.editor, c.id, { result: 'CONCERN', defectSeverity: 'MINOR', defectNote: 'x' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(query(`UPDATE trial_checks SET result='FAIL', risk_note='x' WHERE id=$1`, [c.id])).rejects.toThrow(/不可新增或修改/);
    await expect(createEvidence(w.editor, { subjectType: 'TRIAL_CHECK', subjectId: c.id, kind: 'OTHER', title: 'x', url: 'https://docs.example.invalid/x' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
  it('預估毛利這一項的說明可能含成本：小編不能填、也看不到；結果欄位仍可見', async () => {
    const p = await newProduct();
    const { id } = await createTrial(w.manager, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' });
    const m = (await checks(id)).find((x) => x.itemKey === 'margin') as Check;
    await expect(updateTrialCheck(w.editor, m.id, { result: 'PASS', evidenceText: '毛利 35%' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await updateTrialCheck(w.editor, m.id, { result: 'CONCERN', defectSeverity: 'NONE' }).catch(() => undefined);   // 只改結果、無文字 → 允許
    await updateTrialCheck(w.manager, m.id, { result: 'PASS', evidenceText: '[DEMO] 試算毛利 35%，成本 120' });
    const asEditor = (await checks(id, w.editor)).find((x) => x.itemKey === 'margin') as Check & { evidenceText: string | null; restricted: boolean };
    expect(asEditor).toMatchObject({ result: 'PASS', evidenceText: null, restricted: true });
    expect(JSON.stringify((await ed.call('GET', `/trials/${id}`)).json)).not.toContain('成本 120');
    expect(JSON.stringify((await getTrial(w.finance, id)).checks)).toContain('成本 120');   // 財務有成本檢視權限
    const audit = JSON.stringify(await query(`SELECT before_data, after_data FROM audit_logs WHERE entity_id=$1`, [m.id]));
    expect(audit).not.toContain('成本 120');
  });
});

describe('試用結論：系統建議、覆寫、有效期、覆核', () => {
  it('系統建議：全通過 PASS；有疑慮 CONDITIONAL；未測 RETEST；不通過／嚴重缺陷 FAIL', async () => {
    const p = await newProduct();
    const { id } = await createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' });
    expect((await getTrial(w.editor, id)).suggestion).toMatchObject({ conclusion: 'RETEST' });
    await fillChecks(id);
    expect((await getTrial(w.editor, id)).suggestion).toMatchObject({ conclusion: 'PASS' });
    const c = (await checks(id))[0];
    await updateTrialCheck(w.editor, c.id, { result: 'CONCERN', evidenceText: null, defectSeverity: 'MINOR', defectNote: '[DEMO] 外盒小凹' });
    expect((await getTrial(w.editor, id)).suggestion).toMatchObject({ conclusion: 'CONDITIONAL' });
    await updateTrialCheck(w.editor, c.id, { result: 'FAIL', defectSeverity: 'CRITICAL', defectNote: '[DEMO] 漏液' });
    expect((await getTrial(w.editor, id)).suggestion).toMatchObject({ conclusion: 'FAIL' });
  });
  it('最終建議不得比系統建議更樂觀：小編被擋（403）；主管需填覆寫原因；保守的不需要', async () => {
    const p = await newProduct();
    const { id } = await createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' });
    await fillChecks(id, { quality: { result: 'FAIL', defectSeverity: 'MAJOR', defectNote: '[DEMO] 瑕疵', riskNote: '[DEMO] 風險' } });
    await expect(concludeTrial(w.editor, id, { conclusion: 'PASS', note: '[DEMO] 我覺得可以' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(concludeTrial(w.manager, id, { conclusion: 'PASS', note: '[DEMO] 主管判斷' })).rejects.toThrow(/覆寫原因/);
    const r = await concludeTrial(w.manager, id, { conclusion: 'CONDITIONAL', note: '[DEMO] 條件通過', overrideReason: '[DEMO] 廠商已承諾換貨並附新檢驗' });
    expect(r).toMatchObject({ conclusion: 'CONDITIONAL', suggested: 'FAIL' });
    const t = await getTrial(w.manager, id);
    expect(t).toMatchObject({ status: 'CONCLUDED', conclusion: 'CONDITIONAL', suggestedConclusion: 'FAIL', overrideReason: '[DEMO] 廠商已承諾換貨並附新檢驗', concludedByName: expect.any(String) });
    const p2 = await newProduct();
    const b = await createTrial(w.editor, p2.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' });
    await fillChecks(b.id);
    expect(await concludeTrial(w.editor, b.id, { conclusion: 'CONDITIONAL', note: '[DEMO] 保守一點' })).toMatchObject({ conclusion: 'CONDITIONAL' });   // 比建議保守 → 小編也可以
  });
  it('結論說明必填；通過的有效期預設 180 天、不得超過；結論後不可再結論', async () => {
    const p = await newProduct();
    const { id } = await createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' });
    await fillChecks(id);
    await expect(concludeTrial(w.editor, id, { conclusion: 'PASS', note: '' })).rejects.toBeTruthy();
    await expect(concludeTrial(w.editor, id, { conclusion: 'PASS', note: 'x', validUntil: addDays(today, 181) })).rejects.toThrow(/不可超過/);
    const r = await concludeTrial(w.editor, id, { conclusion: 'PASS', note: '[DEMO] ok' });
    expect(r.validUntil).toBe(addDays(today, 180));
    await expect(concludeTrial(w.editor, id, { conclusion: 'PASS', note: 'again' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const f = await createTrial(w.editor, (await newProduct()).id, { level: 'QUALIFICATION', trialType: 'INTERNAL' });
    await fillChecks(f.id, { quality: { result: 'FAIL', riskNote: '[DEMO] 不合格' } });
    expect((await concludeTrial(w.editor, f.id, { conclusion: 'FAIL', note: '[DEMO] 不通過' })).validUntil).toBeNull();   // 不通過沒有有效期
  });
  it('覆核：小編不能；不接受需原因；未結論不能覆核；只記錄意見、不改商品審核狀態', async () => {
    const p = await newProduct();
    const { id } = await createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' });
    await expect(reviewTrial(w.manager, id, { decision: 'ACCEPTED' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await fillChecks(id); await concludeTrial(w.editor, id, { conclusion: 'PASS', note: '[DEMO] ok' });
    const st = (await query<{ review_status: string }>(`SELECT review_status FROM products WHERE id=$1`, [p.id]))[0].review_status;
    await expect(reviewTrial(w.editor, id, { decision: 'ACCEPTED' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(reviewTrial(w.manager, id, { decision: 'REJECTED' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await reviewTrial(w.manager, id, { decision: 'ACCEPTED' });
    expect((await query<{ review_status: string }>(`SELECT review_status FROM products WHERE id=$1`, [p.id]))[0].review_status).toBe(st);
  });
});

describe('商品資格的沿用與失效', () => {
  it('資格試用通過且被接受 → 團主適配試用自動沿用，只補客戶、內容、商業三面向（12 項）', async () => {
    const p = await newProduct();
    const q = await passedQualification(p.id);
    const r = await createTrial(w.editor, p.id, { level: 'HOST_FIT', trialType: 'DESIGNATED_HOST', hostId });
    expect(r.qualificationTrialId).toBe(q);
    const t = await getTrial(w.editor, r.id);
    expect((t.checks as Check[])).toHaveLength(12);
    expect((t.checks as Check[]).some((c) => c.dimension === 'PRODUCT')).toBe(false);
    expect(t.linkedQualification).toMatchObject({ id: q });
  });
  it('不要沿用（reuseQualification=false）→ 全部四面向都要做', async () => {
    const p = await newProduct();
    await passedQualification(p.id);
    const r = await createTrial(w.editor, p.id, { level: 'HOST_FIT', trialType: 'DESIGNATED_HOST', hostId, reuseQualification: false });
    expect(r.qualificationTrialId).toBeNull();
    expect((await getTrial(w.editor, r.id)).checks as unknown[]).toHaveLength(18);
  });
  it('資格尚未覆核、結論不通過、或沒有資格 → 不沿用', async () => {
    const p1 = await newProduct(), p2 = await newProduct(), p3 = await newProduct();
    const a = await createTrial(w.editor, p1.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' });
    await fillChecks(a.id); await concludeTrial(w.editor, a.id, { conclusion: 'PASS', note: 'x' });       // 未覆核
    expect((await qualificationFor(await import('@/server/lib/db').then((m) => m.pool()), w.orgId, p1.id))).toMatchObject({ valid: false, reasons: ['尚未覆核'] });
    const b = await createTrial(w.editor, p2.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' });
    await fillChecks(b.id, { quality: { result: 'FAIL', riskNote: 'x' } }); await concludeTrial(w.editor, b.id, { conclusion: 'FAIL', note: 'x' }); await reviewTrial(w.manager, b.id, { decision: 'ACCEPTED' });
    for (const p of [p1, p2, p3]) expect((await createTrial(w.editor, p.id, { level: 'HOST_FIT', trialType: 'DESIGNATED_HOST', hostId })).qualificationTrialId).toBeNull();
  });
  it('商品資料改變（名稱、類別、合規備註、規格）→ 資格自動失效並說明原因；價格改變不影響', async () => {
    const p = await newProduct();
    const q = await passedQualification(p.id);
    const pool = (await import('@/server/lib/db')).pool();
    expect((await qualificationFor(pool, w.orgId, p.id))).toMatchObject({ trialId: q, valid: true });
    await query(`UPDATE skus SET group_price=group_price+1 WHERE product_id=$1`, [p.id]);
    expect((await qualificationFor(pool, w.orgId, p.id))?.valid).toBe(true);
    await updateProduct(w.manager, p.id, { complianceNote: '[DEMO] 新的檢驗報告' } as never);
    const after = await qualificationFor(pool, w.orgId, p.id);
    expect(after?.valid).toBe(false);
    expect(after?.reasons.join()).toContain('已變更');
    expect((await createTrial(w.editor, p.id, { level: 'HOST_FIT', trialType: 'DESIGNATED_HOST', hostId })).qualificationTrialId).toBeNull();
  });
  it('資格過期 → 失效（用 SQL 模擬時間經過）', async () => {
    const p = await newProduct();
    await passedQualification(p.id);
    await query(`ALTER TABLE product_trials DISABLE TRIGGER product_trials_guard`);
    try { await query(`UPDATE product_trials SET valid_until=$2 WHERE product_id=$1 AND level='QUALIFICATION'`, [p.id, addDays(today, -1)]); } finally { await query(`ALTER TABLE product_trials ENABLE TRIGGER product_trials_guard`); }
    const q = await qualificationFor((await import('@/server/lib/db')).pool(), w.orgId, p.id);
    expect(q?.valid).toBe(false);
    expect(q?.reasons[0]).toContain('過期');
  });
  it('沿用中的資格在結論前已失效 → 不能結論（要先重做資格）', async () => {
    const p = await newProduct();
    await passedQualification(p.id);
    const r = await createTrial(w.editor, p.id, { level: 'HOST_FIT', trialType: 'DESIGNATED_HOST', hostId });
    await fillChecks(r.id);
    await updateProduct(w.manager, p.id, { name: '[DEMO] 改名後的商品' } as never);
    await expect(concludeTrial(w.editor, r.id, { conclusion: 'PASS', note: 'x' })).rejects.toThrow(/已失效/);
  });
  it('使用設定的有效天數（不是寫死 180）', async () => {
    const cfg = await getSelectionConfig(w.manager);
    await putSelectionConfig(w.manager, { weights: cfg.weights, trialValidDays: 30, version: cfg.version });
    try {
      const p = await newProduct();
      const { id } = await createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' });
      await fillChecks(id);
      expect((await concludeTrial(w.editor, id, { conclusion: 'PASS', note: 'x' })).validUntil).toBe(addDays(today, 30));
    } finally {
      const c2 = await getSelectionConfig(w.manager);
      await putSelectionConfig(w.manager, { weights: c2.weights, trialValidDays: 180, version: c2.version });
    }
  });
});

describe('小規模測試團、檔期範圍、任務唯讀', () => {
  let campA: string, campB: string, p: { id: string; skuIds: string[] };
  beforeAll(async () => {
    p = await newProduct();
    const base = { sampleReadyDate: dayOffset(1), openDate: dayOffset(20), closeDate: dayOffset(30) };
    campA = (await mkCampaign(w, vendorId, { ...base, products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: [{ hostId }] }, w.editor)).id;       // 小編 1 負責
    campB = (await mkCampaign(w, vendorId, { ...base, products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: [{ hostId }] }, w.editor2)).id;      // 小編 2 負責
  });
  it('小規模測試團：商品要在該檔期內；越權的檔期 404', async () => {
    const other = await newProduct();
    await expect(createTrial(w.editor, other.id, { level: 'HOST_FIT', trialType: 'MINI_GROUP', campaignId: campA })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createTrial(w.editor, p.id, { level: 'HOST_FIT', trialType: 'MINI_GROUP', campaignId: campB })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const t = await createTrial(w.editor, p.id, { level: 'HOST_FIT', trialType: 'MINI_GROUP', campaignId: campA, hostId });
    expect((await getTrial(w.editor, t.id)).campaignId).toBe(campA);
  });
  it('檔期層級的試用只有該檔的負責人看得到；別的小編拿到 404，列表也不含', async () => {
    const t = await createTrial(w.manager, p.id, { level: 'HOST_FIT', trialType: 'MINI_GROUP', campaignId: campB });
    expect((await ed.call('GET', `/trials/${t.id}`)).status).toBe(404);
    expect((await ed2.call('GET', `/trials/${t.id}`)).status).toBe(200);
    expect((await ed.call('PATCH', `/trials/${t.id}`, { testerNote: 'x' })).status).toBe(404);
    expect((await ed.call('POST', `/trials/${t.id}/cancel`, { reason: 'x' })).status).toBe(404);
    expect((await ed.call('GET', `/campaigns/${campB}/trials`)).status).toBe(404);
    const list1 = (await listProductTrials(w.editor, p.id)).items as unknown as { id: string }[];
    expect(list1.map((i) => i.id)).not.toContain(t.id);
    const list2 = (await listProductTrials(w.editor2, p.id)).items as unknown as { id: string }[];
    expect(list2.map((i) => i.id)).toContain(t.id);
  });
  it('檔期試用頁唯讀顯示既有任務（寄樣／到貨／回饋／G1）；試用不新增任務、不改任務狀態', async () => {
    const tasksBefore = await query(`SELECT id, status FROM tasks WHERE campaign_id=$1 ORDER BY id`, [campA]);
    await createTrial(w.editor, p.id, { level: 'HOST_FIT', trialType: 'DESIGNATED_HOST', hostId: (await mkHost(w, '[DEMO] 另一位團主')).id, campaignId: campA });
    const r = await campaignTrials(w.editor, campA);
    expect(r.tasks.map((t) => (t as unknown as { stepKey: string }).stepKey)).toEqual(expect.arrayContaining(['SAMPLE_SHIP', 'TRIAL_ARRIVAL', 'TRIAL_FEEDBACK', 'LAUNCH_APPROVAL']));
    expect(await query(`SELECT id, status FROM tasks WHERE campaign_id=$1 ORDER BY id`, [campA])).toEqual(tasksBefore);
    expect(r.summary.total).toBeGreaterThan(0);
  });
  it('寄樣批次：只能關聯「寄樣」批次且在可見檔期內', async () => {
    const mkBatch = async (campaignId: string, kind: string) => {
      const id = `FBT-T${Math.random().toString(36).slice(2, 8)}`;
      await query(`INSERT INTO fulfillment_batches (id, organization_id, campaign_id, kind, label) VALUES ($1,$2,$3,$4,'[DEMO]')`, [id, w.orgId, campaignId, kind]);
      return id;
    };
    const p3 = await newProduct();
    await expect(createTrial(w.editor, p3.id, { level: 'QUALIFICATION', trialType: 'INTERNAL', sampleBatchId: await mkBatch(campA, 'ORDER') })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createTrial(w.editor, p3.id, { level: 'QUALIFICATION', trialType: 'INTERNAL', sampleBatchId: await mkBatch(campB, 'SAMPLE') })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const ok = await createTrial(w.editor, p3.id, { level: 'QUALIFICATION', trialType: 'INTERNAL', sampleBatchId: await mkBatch(campA, 'SAMPLE') });
    expect(ok.id).toBeTruthy();
  });
});

describe('試用：權限與跨組織', () => {
  it('團主與廠商沒有任何試用入口（403）；財務可讀不可寫', async () => {
    const p = await newProduct();
    const t = await createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' });
    for (const c of [hostC, vendC]) {
      expect((await c.call('GET', `/products/${p.id}/trials`)).status).toBe(403);
      expect((await c.call('GET', `/trials/${t.id}`)).status).toBe(403);
      expect((await c.call('POST', `/products/${p.id}/trials`, { level: 'QUALIFICATION', trialType: 'INTERNAL' })).status).toBe(403);
      expect((await c.call('PATCH', `/trial-checks/TCK-000001`, { result: 'PASS' })).status).toBe(403);
    }
    expect((await fin.call('GET', `/trials/${t.id}`)).status).toBe(200);
    expect((await fin.call('POST', `/trials/${t.id}/cancel`, { reason: 'x' })).status).toBe(403);
  });
  it('跨組織一律 404', async () => {
    const op = await mkProduct(other, (await mkVendor(other)).id);
    const ot = await createTrial(other.editor, op.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' });
    expect((await ed.call('GET', `/products/${op.id}/trials`)).status).toBe(404);
    expect((await ed.call('POST', `/products/${op.id}/trials`, { level: 'QUALIFICATION', trialType: 'INTERNAL' })).status).toBe(404);
    expect((await ed.call('GET', `/trials/${ot.id}`)).status).toBe(404);
    expect((await ed.call('POST', `/trials/${ot.id}/conclude`, { conclusion: 'FAIL', note: 'x' })).status).toBe(404);
    const oc = (await query<{ id: string }>(`SELECT id FROM trial_checks WHERE trial_id=$1 LIMIT 1`, [ot.id]))[0].id;
    expect((await ed.call('PATCH', `/trial-checks/${oc}`, { result: 'CONCERN', defectSeverity: 'MINOR', defectNote: 'x' })).status).toBe(404);
  });
  it('稽核：建立、檢核、結論、覆核都有紀錄', async () => {
    const p = await newProduct();
    const { id } = await createTrial(w.editor, p.id, { level: 'QUALIFICATION', trialType: 'INTERNAL' });
    await fillChecks(id); await concludeTrial(w.editor, id, { conclusion: 'PASS', note: 'x' }); await reviewTrial(w.manager, id, { decision: 'ACCEPTED' });
    const acts = new Set((await query<{ action: string }>(`SELECT DISTINCT action FROM audit_logs WHERE organization_id=$1 AND (entity_id=$2 OR entity_id IN (SELECT id FROM trial_checks WHERE trial_id=$2))`, [w.orgId, id])).map((a) => a.action));
    expect([...acts].sort()).toEqual(['selection.trial.check', 'selection.trial.conclude', 'selection.trial.create', 'selection.trial.review']);
    expect((await getTrial(w.editor, id)).history as unknown[]).not.toHaveLength(0);
  });
});
