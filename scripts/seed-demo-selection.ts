import { closePool, query } from '../src/server/lib/db';
import { migrate } from '../src/server/lib/migrate';
import { appEnv } from '../src/server/lib/config';
import type { Actor, RoleKey } from '../src/server/lib/permissions';
import { DD_CATEGORIES } from '../src/server/lib/dd-catalog';
import { addDays } from '../src/server/lib/dates';
import { todayTaipei } from '../src/server/lib/ids';
import { createEvaluation, reviewEvaluation, submitEvaluation, updateEvaluation } from '../src/server/modules/selection';
import { createEvidence } from '../src/server/modules/evidence';
import { createDiligence, getDiligence, reviewDiligence, setLegalStatus, submitDiligence, updateDiligenceItem } from '../src/server/modules/diligence';
import { concludeTrial, createTrial, getTrial, reviewTrial, updateTrialCheck } from '../src/server/modules/trials';
import { createFeasibility } from '../src/server/modules/feasibility';
import { loadEnv } from './load-env';

/**
 * 選品與試用 DEMO 種子（SOP 02／03）：為 [DEMO] 廠商與商品建立「虛構」的選品評估、合作資格審查、試用與可行性試算。
 * 必須先執行 db:seed:demo。冪等：已有 [DEMO] 證據就略過。拒絕在 production 執行（除非明確允許公開示範環境）。
 * 所有連結都是 docs.example.invalid（保留網域，不會連到任何真實網站）；沒有任何真實廠商資料、合約或檢驗報告。
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
    return { type: 'USER', userId: u.id, orgId: u.organization_id, role, name: `demo-${key}`, hostIds: [], vendorIds: [], requestId: 'demo-selection', source: 'SEED' };
  };
  const manager = await actorOf('manager', 'OPS_MANAGER');
  const editor = await actorOf('editor', 'OPS_EDITOR');
  const orgId = manager.orgId;
  if ((await query(`SELECT 1 FROM evidence_items WHERE organization_id=$1 AND title LIKE '[DEMO]%' LIMIT 1`, [orgId])).length) { console.log('選品與試用 DEMO 資料已存在（略過）。'); return; }
  const one = async (sql: string, p: unknown[], what: string) => {
    const [r] = await query<{ id: string }>(sql, p);
    if (!r) throw new Error(`找不到${what}，請先執行 npm run db:seed:demo`);
    return r.id;
  };
  const v1 = await one(`SELECT id FROM vendors WHERE organization_id=$1 AND name='[DEMO] 晴空保養' AND deleted_at IS NULL`, [orgId], '廠商 晴空保養');
  const v2 = await one(`SELECT id FROM vendors WHERE organization_id=$1 AND name='[DEMO] 暖食堂' AND deleted_at IS NULL`, [orgId], '廠商 暖食堂');
  const pMask = await one(`SELECT id FROM products WHERE organization_id=$1 AND name='[DEMO] 保濕面膜' AND deleted_at IS NULL`, [orgId], '商品 保濕面膜');
  const pCookie = await one(`SELECT id FROM products WHERE organization_id=$1 AND name='[DEMO] 手作餅乾禮盒' AND deleted_at IS NULL`, [orgId], '商品 手作餅乾禮盒');
  const pCandle = await one(`SELECT id FROM products WHERE organization_id=$1 AND name='[DEMO] 香氛蠟燭' AND deleted_at IS NULL`, [orgId], '商品 香氛蠟燭');
  const c3 = await one(`SELECT id FROM campaigns WHERE organization_id=$1 AND title='[DEMO] 保濕面膜試用團' AND deleted_at IS NULL`, [orgId], '檔期 保濕面膜試用團');
  const h1 = await one(`SELECT id FROM hosts WHERE organization_id=$1 AND display_name='[DEMO] 小雅媽咪' AND deleted_at IS NULL`, [orgId], '團主 小雅媽咪');
  const today = todayTaipei();
  const url = (p: string) => `https://docs.example.invalid/demo/${p}`;
  const ev = (as: Actor, subjectType: string, subjectId: string, kind: string, title: string, over: Record<string, unknown> = {}) =>
    createEvidence(as, { subjectType, subjectId, kind, title: `[DEMO] ${title}`, url: url(title.replace(/\s+/g, '-')), sourceLabel: '[DEMO] 虛構文件', ...over } as never);

  // ---- 1. 保濕面膜：選品評估（建議進入商務審查、已覆核）----
  const e1 = await createEvaluation(editor, pMask);
  const q1 = await ev(editor, 'EVALUATION', e1.id, 'TEST_REPORT', '保濕面膜檢驗報告', { validUntil: addDays(today, 300) });
  const s1 = await ev(editor, 'EVALUATION', e1.id, 'QUOTE', '晴空保養供貨與出貨紀錄', { validUntil: addDays(today, 200) });
  const sc = (score: number, reason: string, evidenceIds?: string[]) => ({ score, reason: `[DEMO] ${reason}`, ...(evidenceIds ? { evidenceIds } : {}) });
  await updateEvaluation(editor, e1.id, {
    scores: { need: sc(4, '與小雅媽咪的親子保養客群相符'), quality: sc(4, '檢驗報告齊全、成分單純', [q1.id]), profit: sc(4, '毛利與同類相當'), supply: sc(4, '近期出貨穩定', [s1.id]), content: sc(4, '可示範、素材完整'), repeat: sc(4, '耗材型，會回購') },
    compliance: { status: 'PASS', note: '[DEMO] 標示與廣告用語已逐項核對（虛構）' },
  });
  await submitEvaluation(editor, e1.id);
  await reviewEvaluation(manager, e1.id, { decision: 'ACCEPTED', note: '[DEMO] 同意進入商務審查' });

  // ---- 2. 手作餅乾禮盒：需法務審查，最多補測／補件 ----
  const e2 = await createEvaluation(editor, pCookie);
  await updateEvaluation(editor, e2.id, {
    scores: { need: sc(4, '節慶禮盒需求高'), quality: sc(3, '尚待提供完整檢驗'), profit: sc(5, '毛利高'), supply: sc(3, '產能旺季偏緊'), content: sc(5, '外觀吸睛') },
    compliance: { status: 'NEEDS_LEGAL', note: '[DEMO] 食品標示與保存期限需法務／合規確認' },
  });
  await submitEvaluation(editor, e2.id);

  // ---- 3. 香氛蠟燭：評估草稿（示範未知不當 0 分）----
  const e3 = await createEvaluation(editor, pCandle);
  await updateEvaluation(editor, e3.id, { scores: { need: sc(3, '客群重疊度普通'), profit: sc(4, '毛利尚可') }, compliance: { status: 'UNKNOWN' } });

  // ---- 4. 晴空保養：合作資格審查（已核准）----
  const d1 = await createDiligence(editor, v1, { contractVersion: '2026-DEMO-v1', contractRef: '[DEMO] 虛構合約 A-001', productId: pMask, regulatedCategory: 'COSMETIC', note: '[DEMO] 首次合作' });
  const items = async (id: string) => (await getDiligence(manager, id)).items as unknown as { id: string; categoryKey: string; legalStatus: string }[];
  for (const c of DD_CATEGORIES) {
    const it = (await items(d1.id)).find((i) => i.categoryKey === c.key) as { id: string };
    await updateDiligenceItem(manager, it.id, { responsibleParty: c.key === 'RETURNS_LIABILITY' ? 'BRAND' : c.key === 'PAYMENT_LIABILITY' ? 'SHARED' : 'COMPANY', ownerUserId: editor.userId });
    if (c.key === 'PAYMENT_LIABILITY') await updateDiligenceItem(manager, it.id, { terms: { collector: 'BRAND', invoicer: 'BRAND', afterSalesOwner: 'SHARED' } });
    if (c.key === 'RETURNS_LIABILITY') await updateDiligenceItem(manager, it.id, { terms: { returnWindowDays: 7, defectOwner: 'BRAND', damageOwner: 'BRAND', lostOwner: 'SHARED', reshipOwner: 'BRAND' } });
    if (c.key === 'COMMISSION_TERMS') await updateDiligenceItem(manager, it.id, { terms: { basis: 'NSV', ratePercent: 10, settlementCycleDays: 30 } });
    if (c.evidenceRequired) {
      await ev(manager, 'DD_ITEM', it.id, c.key === 'COMMISSION_TERMS' ? 'CONTRACT' : c.key === 'SOURCE_LICENSE_QA' ? 'CERTIFICATE' : 'LICENSE', `${c.label}`, { validUntil: addDays(today, c.key === 'SOURCE_LICENSE_QA' ? 120 : 330) });
      await updateDiligenceItem(manager, it.id, { status: 'CONFIRMED' });
    } else await updateDiligenceItem(manager, it.id, { status: 'CONFIRMED' });
  }
  for (const it of await items(d1.id)) {
    if (it.legalStatus === 'REQUIRED') {
      await ev(manager, 'DD_ITEM', it.id, 'LEGAL_OPINION', '化妝品標示法務意見', { validUntil: addDays(today, 330) });
      await setLegalStatus(manager, it.id, { action: 'CLEAR', note: '[DEMO] 虛構法務意見：標示與廣告用語已確認' });
    }
  }
  await submitDiligence(editor, d1.id);
  await reviewDiligence(manager, d1.id, { decision: 'APPROVED', note: '[DEMO] 通過首次合作審查' });

  // ---- 5. 暖食堂：合作資格審查（草稿：有風險、待補件、轉售價格限制 → 需法務審查）----
  const d2 = await createDiligence(editor, v2, { contractVersion: '2026-DEMO-v1', contractRef: '[DEMO] 虛構合約 B-001', productId: pCookie, regulatedCategory: 'FOOD' });
  const it2 = async (key: string) => (await items(d2.id)).find((i) => i.categoryKey === key) as { id: string };
  await updateDiligenceItem(editor, (await it2('MOQ')).id, { terms: { moqQty: 500, minPurchaseCommitment: 80000 }, status: 'AT_RISK', riskNote: '[DEMO] MOQ 偏高，首檔可能達不到' });
  await updateDiligenceItem(editor, (await it2('EXCLUSIVITY_RESALE')).id, { terms: { exclusive: false, resalePriceRestriction: true, assetTerms: '[DEMO] 素材需經品牌確認後使用' } });
  await updateDiligenceItem(editor, (await it2('PAYMENT_LIABILITY')).id, { terms: { collector: 'COMPANY', invoicer: 'BRAND', afterSalesOwner: 'BRAND' }, responsibleParty: 'SHARED', ownerUserId: editor.userId });

  // ---- 6. 試用：保濕面膜商品資格（通過、已覆核）、檔期內小規模測試團（進行中）、餅乾禮盒資格（不通過）----
  const fill = async (as: Actor, trialId: string, fail?: string) => {
    for (const c of (await getTrial(as, trialId)).checks) {
      await updateTrialCheck(as, c.id, c.itemKey === fail ? { result: 'FAIL', defectSeverity: 'MAJOR', defectNote: '[DEMO] 外盒壓損、內容物受潮', riskNote: '[DEMO] 運送過程防護不足' } : { result: 'PASS', evidenceText: `[DEMO] ${c.itemLabel}：實測符合（虛構紀錄）` });
    }
  };
  const t1 = await createTrial(manager, pMask, { level: 'QUALIFICATION', trialType: 'INTERNAL', testerUserId: editor.userId, shipDate: addDays(today, -20), arrivalDate: addDays(today, -18), startDate: addDays(today, -17), feedbackDate: addDays(today, -10), carrier: '[DEMO] 物流', trackingNo: 'DEMO0001' });
  await fill(manager, t1.id);
  await concludeTrial(manager, t1.id, { conclusion: 'PASS', note: '[DEMO] 四面向皆通過' });
  await reviewTrial(manager, t1.id, { decision: 'ACCEPTED', note: '[DEMO] 同意' });
  const t2 = await createTrial(editor, pMask, { level: 'HOST_FIT', trialType: 'MINI_GROUP', campaignId: c3, hostId: h1, recoveryRequired: true, shipDate: addDays(today, -3) });
  const checks2 = (await getTrial(editor, t2.id)).checks;
  for (const c of checks2.filter((x) => ['unboxing', 'ease_of_use', 'effect'].includes(x.itemKey))) await updateTrialCheck(editor, c.id, { result: 'PASS', evidenceText: `[DEMO] ${c.itemLabel}：團主回饋良好（虛構）` });
  const t3 = await createTrial(manager, pCookie, { level: 'QUALIFICATION', trialType: 'INTERNAL', testerUserId: editor.userId });
  await fill(manager, t3.id, 'packaging');
  await concludeTrial(manager, t3.id, { conclusion: 'FAIL', note: '[DEMO] 包裝防護不足，需改善後重測' });

  // ---- 7. 可行性：面膜（檔期，完整、為正）、餅乾禮盒（小編只填非敏感，其餘未知）----
  const S = (keys: string[], kind: string) => Object.fromEntries(keys.map((k) => [k, { kind, note: '[DEMO] 虛構假設' }]));
  const full = { expectedOrders: 120, unitPrice: 420, refundRatePct: 5, unitCost: 200, shippingPerOrder: 45, platformFeePct: 2, otherVariablePerOrder: 0, fixedCost: 0, brandFeePct: 12, serviceFeeFixed: 0, hostCommissionPct: 6, commissionBasis: 'NSV', hostPaidBy: 'COMPANY', cashFlowMode: 'BRAND_COLLECTS', shippingBorneBy: 'BRAND', platformFeeBorneBy: 'COMPANY', otherCostBorneBy: 'COMPANY', fixedCostBorneBy: 'COMPANY' };
  await createFeasibility(manager, pMask, { campaignId: c3, label: '[DEMO] 基準情境', inputs: full as never, sources: S(Object.keys(full), 'VENDOR_QUOTE') as never });
  await createFeasibility(editor, pCookie, { label: '[DEMO] 僅非敏感輸入', inputs: { expectedOrders: 200, unitPrice: 680, refundRatePct: 3 }, sources: S(['expectedOrders', 'unitPrice', 'refundRatePct'], 'MANUAL_ESTIMATE') as never });
  console.log('選品與試用 DEMO 資料已建立：評估 3 份（1 份已覆核、1 份需法務審查、1 份草稿）、合作資格審查 2 份（1 份已核准、1 份草稿含風險與法務標示）、試用 3 筆、可行性 2 筆');
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(closePool);
