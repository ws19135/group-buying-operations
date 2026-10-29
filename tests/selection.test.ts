import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { createEvaluation, getSelectionConfig, listProductEvaluations, putSelectionConfig, reviewEvaluation, submitEvaluation, updateEvaluation } from '@/server/modules/selection';
import { createEvidence, removeEvidence } from '@/server/modules/evidence';
import type { Actor } from '@/server/lib/permissions';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkProduct, mkVendor, type World } from './helpers';

let w: World;
let vendorId: string;
let host: Actor, vendorUser: Actor, other: World;
let ed: Client, mgr: Client, fin: Client, hostC: Client, vendC: Client;

const score = (n: number, evidenceIds?: string[]) => ({ score: n, reason: `理由 ${n}`, ...(evidenceIds ? { evidenceIds } : {}) });
const allScores = (n: number) => ({ need: score(n), quality: score(n), profit: score(n), supply: score(n), content: score(n), repeat: score(n) });
const newProduct = async () => (await mkProduct(w, vendorId, { name: `[DEMO] 選品商品 ${Math.random().toString(36).slice(2, 7)}` })).id;

/** 建立一份草稿並填滿 n 分；quality 與 supply 各附一筆證據 */
async function draft(productId: string, n = 4, compliance: { status: string; note?: string } = { status: 'PASS' }, withEvidence = true) {
  const { id } = await createEvaluation(w.editor, productId);
  let q: string[] | undefined, s: string[] | undefined;
  if (withEvidence) {
    const e1 = await createEvidence(w.editor, { subjectType: 'EVALUATION', subjectId: id, kind: 'TEST_REPORT', title: '[DEMO] 檢驗報告', url: 'https://docs.example.invalid/demo-report' });
    const e2 = await createEvidence(w.editor, { subjectType: 'EVALUATION', subjectId: id, kind: 'QUOTE', title: '[DEMO] 供貨紀錄', url: 'https://docs.example.invalid/demo-supply' });
    q = [e1.id]; s = [e2.id];
  }
  await updateEvaluation(w.editor, id, { scores: { ...allScores(n), quality: score(n, q), supply: score(n, s) }, compliance: compliance as never });
  return id;
}

beforeAll(async () => {
  w = await makeWorld();
  other = await makeWorld();
  vendorId = (await mkVendor(w)).id;
  host = await addUser(w.orgId, 'HOST', { hostIds: [] });
  vendorUser = await addUser(w.orgId, 'VENDOR', { vendorIds: [vendorId] });
  [ed, mgr, fin, hostC, vendC] = await Promise.all([Client.forActor(w.editor), Client.forActor(w.manager), Client.forActor(w.finance), Client.forActor(host), Client.forActor(vendorUser)]);
});

describe('選品設定：版本、驗證、權限', () => {
  it('預設是「建議值，待 Owner 確認」，版本 1、權重 25/25/20/15/10/5', async () => {
    const c = await getSelectionConfig(w.editor);
    expect(c).toMatchObject({ version: 1, approved: false, persisted: false, status: '建議值，待 Owner 確認' });
    expect(c.weights).toEqual({ need: 25, quality: 25, profit: 20, supply: 15, content: 10, repeat: 5 });
  });
  it('營運小編不能改設定（403）；團主與廠商連讀取也不行', async () => {
    expect((await ed.call('PUT', '/selection/config', { weights: { need: 25, quality: 25, profit: 20, supply: 15, content: 10, repeat: 5 } })).status).toBe(403);
    expect((await hostC.call('GET', '/selection/config')).status).toBe(403);
    expect((await vendC.call('GET', '/selection/config')).status).toBe(403);
    expect((await fin.call('GET', '/selection/config')).status).toBe(200);
  });
  it('權重合計不是 100、門檻順序錯誤 → 422；儲存即新版本並寫稽核', async () => {
    expect((await mgr.call('PUT', '/selection/config', { weights: { need: 30, quality: 25, profit: 20, supply: 15, content: 10, repeat: 5 } })).status).toBe(422);
    expect((await mgr.call('PUT', '/selection/config', { weights: { need: 25, quality: 25, profit: 20, supply: 15, content: 10, repeat: 5 }, thresholds: { proceed: 50, supplement: 70, minCompleteness: 0.5, highConfidence: 0.85, mediumConfidence: 0.6 } })).status).toBe(422);
    const ok = await mgr.call('PUT', '/selection/config', { weights: { need: 30, quality: 25, profit: 15, supply: 15, content: 10, repeat: 5 }, approved: false });
    expect(ok.status).toBe(200);
    expect(ok.data.version).toBe(2);
    const a = await query(`SELECT action, after_data FROM audit_logs WHERE organization_id=$1 AND action='selection.config.update'`, [w.orgId]);
    expect(a).toHaveLength(1);
    // 還原成預設權重，避免影響後面的評分斷言
    const back = await mgr.call('PUT', '/selection/config', { weights: { need: 25, quality: 25, profit: 20, supply: 15, content: 10, repeat: 5 }, version: 2 });
    expect(back.data.version).toBe(3);
  });
  it('版本衝突 → 409', async () => {
    const r = await mgr.call('PUT', '/selection/config', { weights: { need: 25, quality: 25, profit: 20, supply: 15, content: 10, repeat: 5 }, version: 1 });
    expect(r.status).toBe(409);
  });
  it('證據網域白名單格式錯誤被拒', async () => {
    const r = await mgr.call('PUT', '/selection/config', { weights: { need: 25, quality: 25, profit: 20, supply: 15, content: 10, repeat: 5 }, evidenceHosts: ['javascript:alert(1)'] });
    expect(r.status).toBe(422);
  });
});

describe('選品評估：流程、版本、不可改', () => {
  it('建立草稿 → 同商品第二份草稿被擋（409）', async () => {
    const p = await newProduct();
    await createEvaluation(w.editor, p);
    await expect(createEvaluation(w.editor, p)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('分數 4 全項＋合規通過＋品質與供應附證據 → 80 分、PROCEED；寫入後讀回一致', async () => {
    const p = await newProduct();
    const id = await draft(p, 4);
    const r = await submitEvaluation(w.editor, id);
    expect(r).toMatchObject({ totalScore: 80, recommendation: 'PROCEED', confidence: 'HIGH', completeness: 1 });
    const back = await listProductEvaluations(w.editor, p);
    expect(back.current).toMatchObject({ id, status: 'SUBMITTED', totalScore: 80, recommendation: 'PROCEED', versionNo: 1, evaluatorName: expect.any(String) });
    expect((back.current as { configSnapshot: { weights: unknown } }).configSnapshot.weights).toEqual({ need: 25, quality: 25, profit: 20, supply: 15, content: 10, repeat: 5 });
    expect(back.draft).toBeNull();
  });
  it('缺證據：品質／供應沒附證據 → 降為 SUPPLEMENT 並列出缺口', async () => {
    const p = await newProduct();
    const id = await draft(p, 5, { status: 'PASS' }, false);
    const r = await submitEvaluation(w.editor, id);
    expect(r.totalScore).toBe(100);
    expect(r.recommendation).toBe('SUPPLEMENT');
    expect(r.evidenceGaps).toEqual(['quality', 'supply']);
  });
  it('過期證據不算證據：附的證據已過期 → 同樣降為 SUPPLEMENT', async () => {
    const p = await newProduct();
    const { id } = await createEvaluation(w.editor, p);
    const e1 = await createEvidence(w.editor, { subjectType: 'EVALUATION', subjectId: id, kind: 'TEST_REPORT', title: '[DEMO] 過期報告', url: 'https://docs.example.invalid/a', validUntil: dayOffset(-1) });
    const e2 = await createEvidence(w.editor, { subjectType: 'EVALUATION', subjectId: id, kind: 'QUOTE', title: '[DEMO] 有效', url: 'https://docs.example.invalid/b', validUntil: dayOffset(90) });
    await updateEvaluation(w.editor, id, { scores: { ...allScores(5), quality: score(5, [e1.id]), supply: score(5, [e2.id]) }, compliance: { status: 'PASS' } });
    expect((await submitEvaluation(w.editor, id)).evidenceGaps).toEqual(['quality']);
  });
  it('合規未通過：100 分也是 BLOCKED；需法務審查：最多 SUPPLEMENT', async () => {
    const p1 = await newProduct(), p2 = await newProduct();
    const a = await draft(p1, 5, { status: 'FAIL', note: '標示不符' });
    expect(await submitEvaluation(w.editor, a)).toMatchObject({ totalScore: 100, recommendation: 'BLOCKED' });
    const b = await draft(p2, 5, { status: 'NEEDS_LEGAL', note: '食品標示需法務確認' });
    expect((await submitEvaluation(w.editor, b)).recommendation).toBe('SUPPLEMENT');
  });
  it('缺資料不當 0 分：只評兩項 → 完整度 0.3、資料不足', async () => {
    const p = await newProduct();
    const { id } = await createEvaluation(w.editor, p);
    await updateEvaluation(w.editor, id, { scores: { need: score(5), repeat: score(5) }, compliance: { status: 'PASS' } });
    expect(await submitEvaluation(w.editor, id)).toMatchObject({ completeness: 0.3, recommendation: 'INSUFFICIENT_DATA', confidence: 'INSUFFICIENT' });
  });
  it('送出檢查：已評分卻沒理由、沒有任何評分、合規 FAIL 沒說明 → 422', async () => {
    const p = await newProduct();
    const { id } = await createEvaluation(w.editor, p);
    await expect(submitEvaluation(w.editor, id)).rejects.toMatchObject({ code: 'VALIDATION' });
    await updateEvaluation(w.editor, id, { scores: { need: { score: 4, reason: '' } }, compliance: { status: 'PASS' } });
    await expect(submitEvaluation(w.editor, id)).rejects.toThrow(/理由/);
    await updateEvaluation(w.editor, id, { scores: { need: score(4) }, compliance: { status: 'FAIL' } });
    await expect(submitEvaluation(w.editor, id)).rejects.toThrow(/原因/);
  });
  it('分數超出 1–5 或非整數、理由含電話／Email → 422', async () => {
    const p = await newProduct();
    const { id } = await createEvaluation(w.editor, p);
    await expect(updateEvaluation(w.editor, id, { scores: { need: { score: 6, reason: 'x' } } })).rejects.toBeTruthy();
    await expect(updateEvaluation(w.editor, id, { scores: { need: { score: 3.5, reason: 'x' } } })).rejects.toBeTruthy();
    await expect(updateEvaluation(w.editor, id, { scores: { need: { score: 3, reason: '請聯絡 0912-345-678' } } })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateEvaluation(w.editor, id, { compliance: { status: 'PASS', note: 'a@b.com' } })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  it('引用別人的證據被拒', async () => {
    const p1 = await newProduct(), p2 = await newProduct();
    const a = await createEvaluation(w.editor, p1), b = await createEvaluation(w.editor, p2);
    const e = await createEvidence(w.editor, { subjectType: 'EVALUATION', subjectId: b.id, kind: 'OTHER', title: '[DEMO] x', url: 'https://docs.example.invalid/x' });
    await expect(updateEvaluation(w.editor, a.id, { scores: { quality: score(4, [e.id]) } })).rejects.toThrow(/不屬於這份評估/);
  });
  it('送出後內容不可改：服務層 412，資料庫觸發器也擋（直接下 SQL）', async () => {
    const p = await newProduct();
    const id = await draft(p, 4);
    await submitEvaluation(w.editor, id);
    await expect(updateEvaluation(w.editor, id, { scores: { need: score(1) } })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(submitEvaluation(w.editor, id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(query(`UPDATE product_evaluations SET total_score=99 WHERE id=$1`, [id])).rejects.toThrow(/不可修改/);
    await expect(query(`UPDATE product_evaluations SET scores='{}'::jsonb WHERE id=$1`, [id])).rejects.toThrow(/不可修改/);
    await expect(query(`DELETE FROM product_evaluations WHERE id=$1`, [id])).rejects.toThrow();
  });
  it('重新評估＝新版本，舊版標記被取代，歷史保留', async () => {
    const p = await newProduct();
    const v1 = await draft(p, 4); await submitEvaluation(w.editor, v1);
    const v2 = await draft(p, 3); const r2 = await submitEvaluation(w.editor, v2);
    expect(r2.supersedes).toEqual([v1]);
    const list = await listProductEvaluations(w.editor, p);
    expect(list.versions.map((v) => [(v as { versionNo: number }).versionNo, (v as { current: boolean }).current])).toEqual([[2, true], [1, false]]);
    expect((list.current as { id: string }).id).toBe(v2);
  });
});

describe('選品評估覆核：只記錄意見，不改商品審核狀態、不核准 G1', () => {
  it('營運小編不能覆核（403）；主管可以；不接受需原因；舊版不能覆核', async () => {
    const p = await newProduct();
    const id = await draft(p, 4); await submitEvaluation(w.editor, id);
    const before = (await query<{ review_status: string }>(`SELECT review_status FROM products WHERE id=$1`, [p]))[0].review_status;
    await expect(reviewEvaluation(w.editor, id, { decision: 'ACCEPTED' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(reviewEvaluation(w.manager, id, { decision: 'REJECTED' })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await reviewEvaluation(w.manager, id, { decision: 'NEEDS_MORE', note: '補 SGS 報告' })).toMatchObject({ reviewDecision: 'NEEDS_MORE' });
    expect((await query<{ review_status: string }>(`SELECT review_status FROM products WHERE id=$1`, [p]))[0].review_status).toBe(before);
    const v2 = await draft(p, 4); await submitEvaluation(w.editor, v2);
    await expect(reviewEvaluation(w.manager, id, { decision: 'ACCEPTED' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await reviewEvaluation(w.manager, v2, { decision: 'ACCEPTED' });
    expect((await query<{ review_status: string }>(`SELECT review_status FROM products WHERE id=$1`, [p]))[0].review_status).toBe(before);
  });
  it('草稿不能覆核', async () => {
    const p = await newProduct();
    const { id } = await createEvaluation(w.editor, p);
    await expect(reviewEvaluation(w.manager, id, { decision: 'ACCEPTED' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

describe('證據連結：只存連結，安全檢查，軟刪除', () => {
  it('只接受 http(s)；javascript:、data:、ftp: 與內嵌帳密被拒', async () => {
    const p = await newProduct();
    const { id } = await createEvaluation(w.editor, p);
    const mk = (url: string) => createEvidence(w.editor, { subjectType: 'EVALUATION', subjectId: id, kind: 'OTHER', title: '[DEMO] x', url });
    for (const url of ['javascript:alert(1)', 'data:text/html;base64,AAAA', 'ftp://x.example/a', 'file:///etc/passwd', 'https://user:pw@docs.example.invalid/a']) await expect(mk(url)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(mk('https://docs.example.invalid/ok')).resolves.toHaveProperty('id');
  });
  it('標題、備註含電話或 Email 被拒；有效期限早於起始日被拒', async () => {
    const p = await newProduct();
    const { id } = await createEvaluation(w.editor, p);
    const base = { subjectType: 'EVALUATION' as const, subjectId: id, kind: 'OTHER' as const, url: 'https://docs.example.invalid/ok' };
    await expect(createEvidence(w.editor, { ...base, title: '聯絡 0912345678' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createEvidence(w.editor, { ...base, title: 'x', note: 'a@b.co' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createEvidence(w.editor, { ...base, title: 'x', validFrom: '2026-05-01', validUntil: '2026-04-01' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  it('網域白名單：設定後只接受名單內網域', async () => {
    const p = await newProduct();
    const { id } = await createEvaluation(w.editor, p);
    const cfg = await getSelectionConfig(w.manager);
    await putSelectionConfig(w.manager, { weights: cfg.weights, evidenceHosts: ['drive.corp.invalid'], version: cfg.version });
    try {
      await expect(createEvidence(w.editor, { subjectType: 'EVALUATION', subjectId: id, kind: 'OTHER', title: 'x', url: 'https://docs.example.invalid/a' })).rejects.toThrow(/核准清單/);
      await expect(createEvidence(w.editor, { subjectType: 'EVALUATION', subjectId: id, kind: 'OTHER', title: 'x', url: 'https://files.drive.corp.invalid/a' })).resolves.toHaveProperty('id');
    } finally {
      const c2 = await getSelectionConfig(w.manager);
      await putSelectionConfig(w.manager, { weights: c2.weights, evidenceHosts: [], version: c2.version });
    }
  });
  it('引用商品素材：沿用既有連結、不複製；別的商品的素材被拒', async () => {
    const p1 = await newProduct(), p2 = await newProduct();
    const a1 = await query<{ id: string }>(`INSERT INTO product_assets (id, organization_id, product_id, kind, title, url) VALUES ($1,$2,$3,'DOCUMENT','[DEMO] 檢驗','https://docs.example.invalid/asset') RETURNING id`, [`AST-T${Math.random().toString(36).slice(2, 8)}`, w.orgId, p1]);
    const { id } = await createEvaluation(w.editor, p1);
    const e = await createEvidence(w.editor, { subjectType: 'EVALUATION', subjectId: id, kind: 'CERTIFICATE', title: '[DEMO] 引用素材', assetId: a1[0].id });
    expect((await query<{ url: string; asset_id: string }>(`SELECT url, asset_id FROM evidence_items WHERE id=$1`, [e.id]))[0]).toEqual({ url: 'https://docs.example.invalid/asset', asset_id: a1[0].id });
    const { id: id2 } = await createEvaluation(w.editor, p2);
    await expect(createEvidence(w.editor, { subjectType: 'EVALUATION', subjectId: id2, kind: 'CERTIFICATE', title: 'x', assetId: a1[0].id })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  it('移除＝軟刪除（資料列還在）；評估送出後不能再增減證據', async () => {
    const p = await newProduct();
    const { id } = await createEvaluation(w.editor, p);
    const e = await createEvidence(w.editor, { subjectType: 'EVALUATION', subjectId: id, kind: 'OTHER', title: 'x', url: 'https://docs.example.invalid/a' });
    await removeEvidence(w.editor, e.id);
    expect((await query(`SELECT deleted_at FROM evidence_items WHERE id=$1`, [e.id]))[0].deleted_at).not.toBeNull();
    await expect(removeEvidence(w.editor, e.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await updateEvaluation(w.editor, id, { scores: { need: score(4) }, compliance: { status: 'PASS' } });
    await submitEvaluation(w.editor, id);
    await expect(createEvidence(w.editor, { subjectType: 'EVALUATION', subjectId: id, kind: 'OTHER', title: 'y', url: 'https://docs.example.invalid/b' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(query(`DELETE FROM evidence_items WHERE id=$1`, [e.id])).rejects.toThrow();
  });
});

describe('權限與資料隔離', () => {
  it('團主與廠商沒有任何選品入口（403）；財務只能讀', async () => {
    const p = await newProduct();
    for (const c of [hostC, vendC]) {
      expect((await c.call('GET', `/products/${p}/evaluations`)).status).toBe(403);
      expect((await c.call('POST', `/products/${p}/evaluations`)).status).toBe(403);
      expect((await c.call('GET', '/selection/overview')).status).toBe(403);
    }
    expect((await fin.call('GET', `/products/${p}/evaluations`)).status).toBe(200);
    expect((await fin.call('POST', `/products/${p}/evaluations`)).status).toBe(403);
    expect((await ed.call('POST', '/evidence', { subjectType: 'EVALUATION', subjectId: 'SEL-X', kind: 'OTHER', title: 'x', url: 'https://a.example.invalid' })).status).toBe(404);
  });
  it('跨組織：別家的商品與評估一律 404', async () => {
    const op = (await mkProduct(other, (await mkVendor(other)).id)).id;
    const oe = await createEvaluation(other.editor, op);
    expect((await ed.call('GET', `/products/${op}/evaluations`)).status).toBe(404);
    expect((await ed.call('GET', `/evaluations/${oe.id}`)).status).toBe(404);
    expect((await ed.call('PATCH', `/evaluations/${oe.id}`, { scores: { need: score(4) } })).status).toBe(404);
    expect((await mgr.call('POST', `/evaluations/${oe.id}/review`, { decision: 'ACCEPTED' })).status).toBe(404);
    expect((await ed.call('POST', '/evidence', { subjectType: 'EVALUATION', subjectId: oe.id, kind: 'OTHER', title: 'x', url: 'https://a.example.invalid' })).status).toBe(404);
  });
  it('總覽：待覆核清單只含本組織；小編可看不可設定', async () => {
    const p = await newProduct();
    const id = await draft(p, 4); await submitEvaluation(w.editor, id);
    const r = await ed.call('GET', '/selection/overview');
    expect(r.status).toBe(200);
    expect(r.data.pendingEvaluations.map((x: { id: string }) => x.id)).toContain(id);
    expect(r.data).toMatchObject({ canReview: false, canConfig: false });
  });
  it('評估不寫入 SOP 01 的適配資料（唯讀引用）', async () => {
    const p = await newProduct();
    const before = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM product_fit_assessments WHERE organization_id=$1`, [w.orgId]))[0].n;
    const id = await draft(p, 4); await submitEvaluation(w.editor, id);
    await listProductEvaluations(w.editor, p);
    expect((await query<{ n: number }>(`SELECT count(*)::int AS n FROM product_fit_assessments WHERE organization_id=$1`, [w.orgId]))[0].n).toBe(before);
  });
});
