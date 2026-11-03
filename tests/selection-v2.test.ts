import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { createEvaluation, getEvaluation, listProductEvaluations, reviewEvaluation, submitEvaluation, updateEvaluation } from '@/server/modules/selection';
import { createSupplement, getV2Config, listSupplements, putV2Config, resolveSupplement } from '@/server/modules/selection-v2';
import { createEvidence } from '@/server/modules/evidence';
import { createFeasibility } from '@/server/modules/feasibility';
import { createDiligence, getDiligence, updateDiligenceItem } from '@/server/modules/diligence';
import { importOrders } from '@/server/modules/orders';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkCampaign, mkHost, mkProduct, mkVendor, type World } from './helpers';
import type { Actor } from '@/server/lib/permissions';

const HEADER = 'source_order_id,campaign_id,ordered_at,status,quantity,unit_price,sku_code,buyer_ref,host_id,community_id,refund_amount';
// 用不易與其他數字混淆的成本值，檢查「沒有成本權限的人拿到的回應裡不能出現」
const COST = 41357;   // 成本價：整份回應（含毛利率以外的任何欄位）不得出現這個數字
let w: World, other: World;
let vendorId: string, hostId: string, hostUser: Actor;
let ed: Client, mgr: Client, hostC: Client;
let n = 0;
const newProduct = async (skus?: { skuCode: string; name: string; listPrice?: number; groupPrice?: number; costPrice?: number }[]) =>
  mkProduct(w, vendorId, { name: `[DEMO] V2 商品 ${++n}${Math.random().toString(36).slice(2, 5)}`, skus });
const cond = (v: Record<string, unknown>) => v as never;

beforeAll(async () => {
  w = await makeWorld(); other = await makeWorld();
  vendorId = (await mkVendor(w, '[DEMO] V2 廠商', { category: '文具' })).id;
  hostId = (await mkHost(w, '[DEMO] V2 團主')).id;
  hostUser = await addUser(w.orgId, 'HOST', { hostIds: [hostId] });
  [ed, mgr, hostC] = await Promise.all([Client.forActor(w.editor), Client.forActor(w.manager), Client.forActor(hostUser)]);
});

describe('V2：建立與相容', () => {
  it('預設建立 V2 草稿；明確指定 rubric:1 才是舊制；同一商品同時只能有一份草稿', async () => {
    const p = await newProduct();
    const a = await createEvaluation(w.editor, p.id);
    expect(a.rubric).toBe(2);
    const list = await listProductEvaluations(w.editor, p.id);
    expect(list.draft).toMatchObject({ rubricVersion: 2 });
    expect(list.configV2).toMatchObject({ approved: false, enabled: true, version: 1 });
    await expect(createEvaluation(w.editor, p.id)).rejects.toThrow();
    const p2 = await newProduct();
    expect((await createEvaluation(w.editor, p2.id, { rubric: 1 })).rubric).toBe(1);
  });
  it('舊制（V1）評估照舊運作且不受 V2 影響：1～5 分、總分、建議；V2 欄位為空', async () => {
    const p = await newProduct();
    const { id } = await createEvaluation(w.editor, p.id, { rubric: 1 });
    await updateEvaluation(w.editor, id, { scores: { need: { score: 4, reason: '理由' } }, compliance: { status: 'PASS' } });
    const r = await submitEvaluation(w.editor, id);
    expect(r.totalScore).toBe(80);
    const v = await getEvaluation(w.editor, id);
    expect(v).toMatchObject({ rubricVersion: 1, v2: null, status: 'SUBMITTED' });
    const row = (await query(`SELECT rubric_version, v2_input, v2_result, commerce_model FROM product_evaluations WHERE id=$1`, [id]))[0];
    expect(row).toEqual({ rubric_version: null, v2_input: null, v2_result: null, commerce_model: null });
  });
  it('V1 與 V2 的欄位不可混用（422）', async () => {
    const p = await newProduct(); const q = await newProduct();
    const v2 = (await createEvaluation(w.editor, p.id)).id;
    const v1 = (await createEvaluation(w.editor, q.id, { rubric: 1 })).id;
    await expect(updateEvaluation(w.editor, v2, { scores: { need: { score: 3, reason: 'x' } } })).rejects.toThrow(/子條件/);
    await expect(updateEvaluation(w.editor, v1, { conditions: cond({ NEED_SEGMENT_MATCH: { value: true } }) })).rejects.toThrow(/V1/);
  });
});

describe('V2：自動取值與「不捏造」', () => {
  it('什麼資料都沒有：自動條件全是未知並說明原因，總分為空，建議是資料不足', async () => {
    const p = await newProduct([{ skuCode: 'X1', name: 'x' }]);   // 沒有價格與成本
    const { id } = await createEvaluation(w.editor, p.id);
    const v = await getEvaluation(w.editor, id);
    const c = (cid: string) => v.v2!.result.conditions.find((x) => x.id === cid)!;
    expect(c('NEED_FIT_SCORE')).toMatchObject({ status: 'UNKNOWN', origin: 'AUTO' });
    expect(c('NEED_FIT_SCORE').reason).toContain('尚無');
    expect(c('PROF_CONTRIB_MARGIN').status).toBe('UNKNOWN');
    expect(c('SUP_DD_APPROVED').reason).toContain('尚無廠商合作資格審查');
    expect(c('QUAL_REFUND_RATE').reason).toContain('沒有歷史訂單');
    expect(v.v2!.result.totalScore).toBeNull();
    expect(v.v2!.result.recommendation).toBe('INSUFFICIENT_DATA');
  });
  it('SKU 價格：折扣深度與毛利率只用資料庫裡的價格計算；缺成本時毛利率未知', async () => {
    const p = await newProduct([{ skuCode: 'S1', name: 'a', listPrice: 1000, groupPrice: 800, costPrice: 500 }, { skuCode: 'S2', name: 'b', listPrice: 2000, groupPrice: 1600, costPrice: 1200 }]);
    const { id } = await createEvaluation(w.manager, p.id);
    await updateEvaluation(w.manager, id, { commerceModel: 'AGENCY' });
    const c = (await getEvaluation(w.manager, id)).v2!.result.conditions;
    expect(c.find((x) => x.id === 'PROF_DISCOUNT_DEPTH')!.value).toBe(20);        // 兩個 SKU 都是 20%
    expect(c.find((x) => x.id === 'PROF_GROSS_MARGIN')!.value).toBe(25);          // min((800-500)/800=37.5, (1600-1200)/1600=25)
    const noCost = await newProduct([{ skuCode: 'N1', name: 'a', listPrice: 1000, groupPrice: 800 }]);
    const e2 = (await createEvaluation(w.manager, noCost.id)).id;
    await updateEvaluation(w.manager, e2, { commerceModel: 'AGENCY' });
    expect((await getEvaluation(w.manager, e2)).v2!.result.conditions.find((x) => x.id === 'PROF_GROSS_MARGIN')).toMatchObject({ status: 'UNKNOWN' });
  });
  it('可行性試算：貢獻利潤率等直接讀取試算結果；要先選商業模式才有門檻可判定', async () => {
    const p = await newProduct([{ skuCode: 'F1', name: 'a', listPrice: 1000, groupPrice: 800, costPrice: COST }]);
    const FULL = { expectedOrders: 100, unitPrice: 1000, refundRatePct: 10, unitCost: 700, shippingPerOrder: 60, platformFeePct: 3, otherVariablePerOrder: 0, fixedCost: 2000, brandFeePct: 10, serviceFeeFixed: 0, hostCommissionPct: 5, commissionBasis: 'NSV', hostPaidBy: 'COMPANY', cashFlowMode: 'BRAND_COLLECTS', shippingBorneBy: 'BRAND', platformFeeBorneBy: 'BRAND', otherCostBorneBy: 'COMPANY', fixedCostBorneBy: 'COMPANY' };
    const fz = await createFeasibility(w.manager, p.id, { inputs: FULL, sources: Object.fromEntries(Object.keys(FULL).map((k) => [k, { kind: 'VENDOR_QUOTE' }])) } as never);
    const raw = (await query<{ results: Record<string, number>; id: string }>(`SELECT id, results FROM feasibility_scenarios WHERE id=$1`, [fz.id]))[0];
    const { id } = await createEvaluation(w.manager, p.id);
    let c = (await getEvaluation(w.manager, id)).v2!.result.conditions;
    expect(raw.results.contributionMarginPct).not.toBeNull();
    expect(c.find((x) => x.id === 'PROF_CONTRIB_MARGIN')!.status).toBe('UNKNOWN');   // 還沒選商業模式，不套用任何預設門檻
    expect(c.find((x) => x.id === 'PROF_SCENARIO_BASIS')).toMatchObject({ status: 'KNOWN', value: 'QUOTED' });
    expect(c.find((x) => x.id === 'PROF_CONTRIB_POSITIVE')).toMatchObject({ status: 'KNOWN', value: true });
    await updateEvaluation(w.manager, id, { commerceModel: 'KOL_CPS' });
    c = (await getEvaluation(w.manager, id)).v2!.result.conditions;
    expect(c.find((x) => x.id === 'PROF_CONTRIB_MARGIN')).toMatchObject({ status: 'KNOWN', value: raw.results.contributionMarginPct });
    await updateEvaluation(w.manager, id, { commerceModel: null });
    c = (await getEvaluation(w.manager, id)).v2!.result.conditions;
    expect(c.find((x) => x.id === 'PROF_CONTRIB_MARGIN')).toMatchObject({ status: 'UNKNOWN' });
    expect(c.find((x) => x.id === 'PROF_CONTRIB_MARGIN')!.reason).toContain('商業模式');
  });
  it('歷史訂單：退款率與回購率；樣本數不足時未知，調低最小樣本後才採用', async () => {
    const p = await newProduct([{ skuCode: 'H1', name: 'a', listPrice: 1000, groupPrice: 800, costPrice: 500 }]);
    const c1 = (await mkCampaign(w, vendorId, { products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: [{ hostId }], sampleReadyDate: dayOffset(-30), openDate: dayOffset(-10), closeDate: dayOffset(10) }, w.manager)).id;
    const c2 = (await mkCampaign(w, vendorId, { products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: [{ hostId }], sampleReadyDate: dayOffset(-30), openDate: dayOffset(-9), closeDate: dayOffset(11) }, w.manager)).id;
    await query(`UPDATE campaigns SET status='RUNNING' WHERE id = ANY($1::text[])`, [[c1, c2]]);
    const rows = [HEADER];
    // 10 張訂單：2 張退款；買家 b1、b2 在兩個檔期都買
    for (let i = 1; i <= 8; i++) rows.push(`V2-${i},${i <= 4 ? c1 : c2},${dayOffset(-5)} 10:00,PAID,1,800,H1,b${i <= 4 ? i : i - 4},${hostId},,`);
    rows.push(`V2-9,${c1},${dayOffset(-5)} 11:00,REFUNDED,1,800,H1,b9,${hostId},,800`, `V2-10,${c2},${dayOffset(-5)} 11:00,PARTIAL_REFUND,1,800,H1,b10,${hostId},,100`);
    const imp = await importOrders({ ...w.admin, source: 'TEST' }, { sourceSystem: 'T', origin: 'DEMO', fileName: 'v2.csv', csv: rows.join('\n') });
    expect(imp.insertedOrders).toBe(10);
    const { id } = await createEvaluation(w.manager, p.id);
    let c = (await getEvaluation(w.manager, id)).v2!.result.conditions;
    expect(c.find((x) => x.id === 'QUAL_REFUND_RATE')).toMatchObject({ status: 'UNKNOWN' });
    expect(c.find((x) => x.id === 'QUAL_REFUND_RATE')!.reason).toContain('樣本數不足（10 < 30）');
    await putV2Config(w.admin, { minSample: { orders: 5, buyers: 5 }, approved: false });
    c = (await getEvaluation(w.manager, id)).v2!.result.conditions;
    expect(c.find((x) => x.id === 'QUAL_REFUND_RATE')).toMatchObject({ status: 'KNOWN', value: 20 });          // 2/10
    expect(c.find((x) => x.id === 'REP_REPEAT_RATE')).toMatchObject({ status: 'KNOWN', value: 66.7 });         // 6 位買家中 b1~b4 回購（4 位）
    await putV2Config(w.admin, { minSample: { orders: 30, buyers: 30 }, approved: false });
  });
  it('商品專屬的廠商調查只適用該商品；廠商層級的調查適用該廠商所有商品', async () => {
    const dv = await mkVendor(w, '[DEMO] V2 調查範圍廠商');
    const pA = await mkProduct(w, dv.id, { name: '[DEMO] V2 範圍商品甲' });
    const pB = await mkProduct(w, dv.id, { name: '[DEMO] V2 範圍商品乙' });
    await createDiligence(w.manager, dv.id, { contractVersion: 'v-scope-A', productId: pA.id } as never);
    const eA = (await createEvaluation(w.editor, pA.id)).id; const eB = (await createEvaluation(w.editor, pB.id)).id;
    const get = async (id: string) => (await getEvaluation(w.editor, id)).v2!.result.conditions.find((x) => x.id === 'SUP_DD_COMPLETE')!;
    expect(await get(eA)).toMatchObject({ status: 'KNOWN' });
    expect(await get(eB)).toMatchObject({ status: 'UNKNOWN' });            // 乙沒有專屬調查，也沒有廠商層級調查
    await createDiligence(w.manager, dv.id, { contractVersion: 'v-scope-vendor' } as never);
    expect(await get(eB)).toMatchObject({ status: 'KNOWN' });              // 廠商層級的調查補上後，乙也適用
  });
  it('API 回應不帶原始 V2 明細（v2Result／v2Input），G1 摘要也不含利潤數值', async () => {
    const p = await newProduct([{ skuCode: 'Q1', name: 'a', listPrice: 100000, groupPrice: 80000, costPrice: COST }]);
    const { id } = await createEvaluation(w.editor, p.id);
    await updateEvaluation(w.editor, id, { conditions: cond({ NEED_SEGMENT_MATCH: { value: true } }), compliance: { status: 'PASS' } });
    await submitEvaluation(w.editor, id);
    for (const c of [ed, mgr]) {
      const r = await c.call('GET', `/evaluations/${id}`);
      expect(Object.keys(r.data)).not.toContain('v2Result'); expect(Object.keys(r.data)).not.toContain('v2Input');
      const list = await c.call('GET', `/products/${p.id}/evaluations`);
      expect(JSON.stringify(list.json)).not.toContain('v2Result');
    }
    const camp = (await mkCampaign(w, vendorId, { products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: [{ hostId }] })).id;
    const sum = await ed.call('GET', `/campaigns/${camp}/g1-summary`);
    expect(sum.status).toBe(200);
    expect(JSON.stringify(sum.json)).not.toContain(String(COST));
    expect(JSON.stringify(sum.json)).not.toContain('v2Result');
    expect(sum.data.gateImpact).toBe('NONE');
  });
  it('廠商調查：草稿不算核准（未知，最多補件）；調查資料不含分潤與排他條款', async () => {
    const p = await newProduct();
    await createDiligence(w.manager, vendorId, { contractVersion: 'v-demo-1' } as never);
    const { id } = await createEvaluation(w.manager, p.id);
    const c = (await getEvaluation(w.manager, id)).v2!.result.conditions;
    expect(c.find((x) => x.id === 'SUP_DD_APPROVED')).toMatchObject({ status: 'UNKNOWN' });
    expect(c.find((x) => x.id === 'SUP_DD_APPROVED')!.reason).toContain('尚未核准');
    expect(c.find((x) => x.id === 'SUP_DD_COMPLETE')).toMatchObject({ status: 'KNOWN', value: 0 });
  });
});

describe('V2：人工輸入規則', () => {
  it('自動條件不可手填；EITHER 條件在系統已有資料時不可手填；格式錯誤被擋', async () => {
    const p = await newProduct([{ skuCode: 'M1', name: 'a', listPrice: 1000, groupPrice: 800, costPrice: 500 }]);
    const { id } = await createEvaluation(w.editor, p.id);
    await expect(updateEvaluation(w.editor, id, { conditions: cond({ NEED_FIT_SCORE: { value: 100 } }) })).rejects.toThrow(/自動取得/);
    await expect(updateEvaluation(w.editor, id, { conditions: cond({ NEED_DEMAND_PROOF: { value: 'YES' } }) })).rejects.toThrow(/是或否/);
    await expect(updateEvaluation(w.editor, id, { conditions: cond({ NOPE: { value: true } }) })).rejects.toThrow(/未知/);
    await expect(updateEvaluation(w.editor, id, { conditions: cond({ NEED_DEMAND_PROOF: { na: true, naReason: '不想評' } }) })).rejects.toThrow(/不允許選不適用/);
    await expect(updateEvaluation(w.editor, id, { conditions: cond({ QUAL_CERTS: { na: true } }) })).rejects.toThrow(/原因/);
    await expect(updateEvaluation(w.editor, id, { conditions: cond({ QUAL_CERTS: { na: true, naReason: '電話 0912-345-678' } }) })).rejects.toThrow(/電話/);
  });
  it('EITHER 條件：系統已有可信資料時不可手填（廠商調查第 9 題有試用品政策 → 「可提供試用品」由系統取得）', async () => {
    const dv = await mkVendor(w, '[DEMO] V2 試用廠商');
    const prod = await mkProduct(w, dv.id, { name: '[DEMO] V2 試用商品' });
    const rec = await createDiligence(w.manager, dv.id, { contractVersion: 'v-sample-1' } as never);
    const item = ((await getDiligence(w.manager, rec.id)).items as unknown as { id: string; categoryKey: string }[]).find((i) => i.categoryKey === 'SAMPLE_MEDIA_LICENSE')!;
    await updateDiligenceItem(w.manager, item.id, { terms: { samplePolicy: '提供 2 份試用品' } } as never);
    const { id } = await createEvaluation(w.editor, prod.id);
    const c = (await getEvaluation(w.editor, id)).v2!.result.conditions.find((x) => x.id === 'CON_SAMPLE_READY')!;
    expect(c).toMatchObject({ status: 'KNOWN', origin: 'AUTO', value: true });
    await expect(updateEvaluation(w.editor, id, { conditions: cond({ CON_SAMPLE_READY: { value: false } }) })).rejects.toThrow(/系統已有可信資料/);
    // 沒有自動值時可以手填：另一個沒有調查、沒有試用的商品
    const bare = await mkVendor(w, '[DEMO] V2 無調查廠商');
    const p2 = await mkProduct(w, bare.id, { name: '[DEMO] V2 無調查商品' });
    const e2 = (await createEvaluation(w.editor, p2.id)).id;
    await updateEvaluation(w.editor, e2, { conditions: cond({ CON_SAMPLE_READY: { value: false } }) });
    expect((await getEvaluation(w.editor, e2)).v2!.result.conditions.find((x) => x.id === 'CON_SAMPLE_READY')).toMatchObject({ origin: 'MANUAL', value: false });
  });
  it('證據只能引用這份評估自己的證據；證據過期不算有效', async () => {
    const p = await newProduct(); const q = await newProduct();
    const a = (await createEvaluation(w.editor, p.id)).id; const b = (await createEvaluation(w.editor, q.id)).id;
    const evB = await createEvidence(w.editor, { subjectType: 'EVALUATION', subjectId: b, kind: 'OTHER', title: '[DEMO] 他人證據', url: 'https://docs.example.invalid/x' });
    await expect(updateEvaluation(w.editor, a, { conditions: cond({ NEED_DEMAND_PROOF: { value: true, evidenceIds: [evB.id] } }) })).rejects.toThrow(/不屬於這份評估/);
    const ok = await createEvidence(w.editor, { subjectType: 'EVALUATION', subjectId: a, kind: 'OTHER', title: '[DEMO] 需求佐證', url: 'https://docs.example.invalid/ok', validUntil: dayOffset(30) });
    await updateEvaluation(w.editor, a, { conditions: cond({ NEED_DEMAND_PROOF: { value: true, evidenceIds: [ok.id] } }) });
    let r = (await getEvaluation(w.editor, a)).v2!.result;
    expect(r.conditions.find((x) => x.id === 'NEED_DEMAND_PROOF')).toMatchObject({ status: 'KNOWN', evidenceOk: true });
    expect(r.evidenceGaps).not.toContain('NEED_DEMAND_PROOF');
    await query(`UPDATE evidence_items SET valid_until=$2 WHERE id=$1`, [ok.id, dayOffset(-1)]);
    r = (await getEvaluation(w.editor, a)).v2!.result;
    expect(r.evidenceGaps).toContain('NEED_DEMAND_PROOF');
  });
  it('不適用的把關：有受規範品類跡象的商品不可對認證條件選不適用（送出時被擋）', async () => {
    const reg = await mkProduct(w, vendorId, { name: '[DEMO] 益生菌保健食品' });
    const { id } = await createEvaluation(w.editor, reg.id);
    await updateEvaluation(w.editor, id, { conditions: cond({ QUAL_CERTS: { na: true, naReason: '應該不用' }, NEED_SEGMENT_MATCH: { value: true } }), compliance: { status: 'PASS' } });
    await expect(submitEvaluation(w.editor, id)).rejects.toThrow(/受規範品類跡象/);
    const plain = await newProduct();
    const e2 = (await createEvaluation(w.editor, plain.id)).id;
    await updateEvaluation(w.editor, e2, { conditions: cond({ QUAL_CERTS: { na: true, naReason: '一般文具，無受規範認證' }, NEED_SEGMENT_MATCH: { value: true } }), compliance: { status: 'PASS' } });
    expect((await submitEvaluation(w.editor, e2)).totalScore).not.toBeNull();
  });
});

describe('V2：送出、版本快照、不可篡改', () => {
  it('送出會保存規則版本與每個子條件的結果；之後改設定也不會改寫已送出的評估；DB 觸發器擋下竄改', async () => {
    const p = await newProduct([{ skuCode: 'T1', name: 'a', listPrice: 1000, groupPrice: 800, costPrice: 500 }]);
    const { id } = await createEvaluation(w.editor, p.id);
    await updateEvaluation(w.editor, id, { conditions: cond({ NEED_SEGMENT_MATCH: { value: true }, CON_USP_CLEAR: { value: true }, REP_CONSUMABLE: { value: 'CONSUMABLE' } }), compliance: { status: 'PASS' } });
    const r = await submitEvaluation(w.editor, id);
    const before = await getEvaluation(w.manager, id);
    const v0 = (await getV2Config(w.manager)).version;
    expect(before).toMatchObject({ status: 'SUBMITTED', configVersion: v0, rubricVersion: 2 });
    expect((before.configSnapshot as unknown as { rubric: number }).rubric).toBe(2);
    expect(before.v2!.live).toBe(false);
    // 改設定（版本 +1、改權重與門檻）
    await putV2Config(w.admin, { proceed: 95, supplement: 90, dimWeights: { need: 40, quality: 20, profit: 20, supply: 10, content: 5, repeat: 5 }, approved: false });
    const after = await getEvaluation(w.manager, id);
    expect(after.totalScore).toBe(before.totalScore); expect(after.recommendation).toBe(before.recommendation); expect(after.configVersion).toBe(v0);
    expect(after.v2!.result).toEqual(before.v2!.result);
    expect(r.totalScore).toBe(before.totalScore);
    await putV2Config(w.admin, { proceed: 80, supplement: 65, dimWeights: { need: 25, quality: 25, profit: 20, supply: 15, content: 10, repeat: 5 }, approved: false });
    // 竄改
    await expect(query(`UPDATE product_evaluations SET v2_result='{}'::jsonb WHERE id=$1`, [id])).rejects.toThrow(/不可修改/);
    await expect(query(`UPDATE product_evaluations SET v2_input='{}'::jsonb WHERE id=$1`, [id])).rejects.toThrow(/不可修改/);
    await expect(query(`UPDATE product_evaluations SET commerce_model='AGENCY' WHERE id=$1`, [id])).rejects.toThrow(/不可修改/);
    await expect(query(`UPDATE product_evaluations SET rubric_version=NULL WHERE id=$1`, [id])).rejects.toThrow(/不可修改/);
    await expect(updateEvaluation(w.editor, id, { conditions: cond({ NEED_SEGMENT_MATCH: { value: false } }) })).rejects.toThrow(/已送出/);
    // 新版取代舊版，舊版內容不動
    const next = (await createEvaluation(w.editor, p.id)).id;
    await updateEvaluation(w.editor, next, { conditions: cond({ NEED_SEGMENT_MATCH: { value: false } }), compliance: { status: 'PASS' } });
    await submitEvaluation(w.editor, next);
    const old = await getEvaluation(w.manager, id);
    expect(old.supersededAt).not.toBeNull(); expect(old.totalScore).toBe(before.totalScore);
  });
  it('送出前檢查：沒有任何已知項目、合規未說明原因都不能送出', async () => {
    const bare = await mkVendor(w, '[DEMO] V2 無資料廠商');   // 沒有廠商調查、沒有出貨紀錄
    const noPrice = await mkProduct(w, bare.id, { name: '[DEMO] V2 無價格商品', skus: [{ skuCode: 'Z1', name: 'z' }] });   // 沒有價格：自動條件全是未知
    const { id } = await createEvaluation(w.editor, noPrice.id);
    await expect(submitEvaluation(w.editor, id)).rejects.toThrow(/至少要有一項已知/);
    await updateEvaluation(w.editor, id, { conditions: cond({ NEED_SEGMENT_MATCH: { value: true } }), compliance: { status: 'FAIL' } });
    await expect(submitEvaluation(w.editor, id)).rejects.toThrow(/合規查核未通過時/);
  });
  it('高分不代表通過：合規「未查核」最多只能補件；硬性條件「否」一律阻擋', async () => {
    const p = await newProduct();
    const { id } = await createEvaluation(w.editor, p.id);
    await updateEvaluation(w.editor, id, { conditions: cond({ QUAL_CERTS: { value: false }, NEED_SEGMENT_MATCH: { value: true } }), compliance: { status: 'PASS' } });
    const r = await submitEvaluation(w.editor, id);
    expect(r.recommendation).toBe('BLOCKED');
  });
});

describe('V2：敏感資訊與權限', () => {
  it('營運小編（沒有成本權限）：利潤維度的數值、分數與來源都看不到，整份回應不含成本數字；主管看得到', async () => {
    const p = await newProduct([{ skuCode: 'P1', name: 'a', listPrice: 100000, groupPrice: 80000, costPrice: COST }]);
    const { id } = await createEvaluation(w.editor, p.id);
    await updateEvaluation(w.editor, id, { commerceModel: 'AGENCY' });
    const edRes = await ed.call('GET', `/evaluations/${id}`);
    expect(edRes.status).toBe(200);
    const edText = JSON.stringify(edRes.json);
    expect(edText).not.toContain(String(COST));
    const gm = edRes.data.v2.result.conditions.find((x: { id: string }) => x.id === 'PROF_GROSS_MARGIN');
    expect(gm).toMatchObject({ value: null, score: null, masked: true });
    expect(edRes.data.v2.canSeeSensitive).toBe(false);
    const mgrRes = await mgr.call('GET', `/evaluations/${id}`);
    expect(mgrRes.data.v2.result.conditions.find((x: { id: string }) => x.id === 'PROF_GROSS_MARGIN').value).toBe(48.3);   // (80000-41357)/80000
  });
  it('稽核紀錄不含成本數值', async () => {
    const rows = await query<{ b: string }>(`SELECT coalesce(before_data::text,'')||coalesce(after_data::text,'') AS b FROM audit_logs WHERE organization_id=$1 AND action LIKE 'selection.evaluation.%'`, [w.orgId]);
    for (const r of rows) expect(r.b).not.toContain(String(COST));
  });
  it('團主與廠商完全不能存取；其他組織看不到；設定只有 selection.config 能改（營運小編 403）', async () => {
    const p = await newProduct();
    const { id } = await createEvaluation(w.editor, p.id);
    expect((await hostC.call('GET', `/evaluations/${id}`)).status).toBe(403);
    expect((await hostC.call('GET', '/selection/config-v2')).status).toBe(403);
    expect((await ed.call('PUT', '/selection/config-v2', { proceed: 70 })).status).toBe(403);
    expect((await ed.call('GET', '/selection/config-v2')).status).toBe(200);
    const o = await Client.forActor(other.manager);
    expect((await o.call('GET', `/evaluations/${id}`)).status).toBe(404);
  });
  it('設定：預設是提案（approved=false）；權重不合 100、門檻方向錯誤 422；版本衝突 409；儲存即新版本並寫稽核', async () => {
    const c = await getV2Config(w.editor);
    expect(c).toMatchObject({ approved: false, status: '提案設定，待 Owner 核准' });
    expect(c.conditions).toHaveLength(30);
    const bad1 = await mgr.call('PUT', '/selection/config-v2', { dimWeights: { need: 30, quality: 25, profit: 20, supply: 15, content: 10, repeat: 5 } });
    expect(bad1.status).toBe(422);
    const bad2 = await mgr.call('PUT', '/selection/config-v2', { thresholds: { NEED_FIT_SCORE: { floor: 90, target: 50 } } });
    expect(bad2.status).toBe(422);
    const cur = await getV2Config(w.manager);
    const ok = await mgr.call('PUT', '/selection/config-v2', { naShareMax: 0.2, version: cur.version });
    expect(ok.status).toBe(200); expect(ok.data.version).toBe(cur.version + 1); expect(ok.data.approved).toBe(false);
    expect((await mgr.call('PUT', '/selection/config-v2', { naShareMax: 0.3, version: cur.version })).status).toBe(409);
    await mgr.call('PUT', '/selection/config-v2', { naShareMax: 0.3 });
    const a = await query(`SELECT 1 FROM audit_logs WHERE organization_id=$1 AND action='selection.config.update' AND entity_id='selection.scoring.v2'`, [w.orgId]);
    expect(a.length).toBeGreaterThan(0);
  });
});

describe('V2：覆核與補件要求；G1 不受影響', () => {
  it('主管可針對子條件提出補件要求；小編不能；V1 與草稿不能；處理後狀態改變', async () => {
    const p = await newProduct();
    const { id } = await createEvaluation(w.editor, p.id);
    await updateEvaluation(w.editor, id, { conditions: cond({ NEED_SEGMENT_MATCH: { value: true } }), compliance: { status: 'PASS' } });
    await expect(createSupplement(w.manager, id, { note: '先送出才能提' })).rejects.toThrow(/尚未送出/);
    await submitEvaluation(w.editor, id);
    await expect(createSupplement(w.editor, id, { conditionId: 'NEED_DEMAND_PROOF', note: '請補佐證' })).rejects.toThrow();
    await expect(createSupplement(w.manager, id, { conditionId: 'NOPE', note: 'x' })).rejects.toThrow(/未知/);
    const s = await createSupplement(w.manager, id, { conditionId: 'NEED_DEMAND_PROOF', note: '請補社群詢問的截圖連結' });
    expect((await listSupplements(w.editor, id))[0]).toMatchObject({ status: 'OPEN', conditionLabel: '有需求佐證' });
    await reviewEvaluation(w.manager, id, { decision: 'NEEDS_MORE', note: '請補件' });
    const done = await resolveSupplement(w.editor, s.id, { status: 'DONE', note: '已補' });
    expect(done.status).toBe('DONE');
    await expect(resolveSupplement(w.editor, s.id, { status: 'DONE' })).rejects.toThrow(/已處理/);
    const v1 = (await createEvaluation(w.editor, (await newProduct()).id, { rubric: 1 })).id;
    await expect(createSupplement(w.manager, v1, { note: 'x' })).rejects.toThrow(/V2/);
  });
  it('評估與覆核都不改商品審核狀態、不核准 G1：商品審核狀態與核准列數前後相同', async () => {
    const p = await newProduct();
    const before = { st: (await query(`SELECT review_status FROM products WHERE id=$1`, [p.id]))[0], ap: (await query(`SELECT count(*)::int n FROM approvals WHERE organization_id=$1`, [w.orgId]))[0].n };
    const { id } = await createEvaluation(w.editor, p.id);
    await updateEvaluation(w.editor, id, { conditions: cond({ NEED_SEGMENT_MATCH: { value: true }, CON_USP_CLEAR: { value: true } }), compliance: { status: 'PASS' } });
    await submitEvaluation(w.editor, id);
    await reviewEvaluation(w.manager, id, { decision: 'ACCEPTED' });
    const after = { st: (await query(`SELECT review_status FROM products WHERE id=$1`, [p.id]))[0], ap: (await query(`SELECT count(*)::int n FROM approvals WHERE organization_id=$1`, [w.orgId]))[0].n };
    expect(after).toEqual(before);
  });
});

describe('V2：適配資料的權限（SOP 01 客群適配只給有 fit.read 的角色）', () => {
  it('沒有 fit.read 的財務：來自客群適配的子條件只看到狀態；有 fit.read 的主管照常', async () => {
    const p = await newProduct();
    const { id } = await createEvaluation(w.editor, p.id);
    const fin = await Client.forActor(w.finance);
    const asFin = (await fin.call('GET', `/evaluations/${id}`)).data.v2.result.conditions;
    for (const cid of ['NEED_FIT_SCORE', 'NEED_FIT_REVIEWED']) expect(asFin.find((x: { id: string }) => x.id === cid)).toMatchObject({ masked: true, value: null, score: null });
    const asMgr = (await mgr.call('GET', `/evaluations/${id}`)).data.v2.result.conditions;
    expect(asMgr.find((x: { id: string }) => x.id === 'NEED_FIT_SCORE').masked).toBeUndefined();
    // 非適配條件不受影響
    expect(asFin.find((x: { id: string }) => x.id === 'REP_CONSUMABLE').masked).toBeUndefined();
  });
});
