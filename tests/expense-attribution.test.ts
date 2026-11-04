import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { pool, query } from '@/server/lib/db';
import { confirmExpenseClaim, createExpense, expenseHistory, listExpenses, updateExpenseAttribution, voidExpense } from '@/server/modules/finance';
import { createFeasibility } from '@/server/modules/feasibility';
import { getFeeAttributionReport } from '@/server/modules/finance-comparison';
import { campaignHostCommission } from '@/server/lib/commission-calc';
import { Client } from './api-helper';
import { addUser, dayOffset, makeWorld, mkCampaign, mkHost, mkProduct, mkVendor, type World } from './helpers';
import type { Actor } from '@/server/lib/permissions';

/** Owner 決策 K-8a：補齊費用歸屬欄位（承擔方≠實際付款方、應收應付確認、對應、來源、付款狀態、憑證、稽核、權限）。不授權：自動應付款、撥款、扣款、改發票、改結算公式、回填歷史 */
let w: World, other: World;
let hostA: string, hostB: string, hostUser: Actor, vendorUser: Actor;
let camp: string, prod: string;
let n = 0;
const TABLES = ['payments', 'invoices', 'settlements', 'settlement_items', 'settlement_adjustments', 'commission_rules', 'orders', 'attributions'];
const counts = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, Number((await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE organization_id=$1`, [w.orgId]))[0].n)])));
const exp = (over: Record<string, unknown> = {}) => ({ category: 'SHIPPING', amount: 700, incurredOn: dayOffset(-3), campaignId: camp, ...over });
const list = async (actor: Actor) => (await listExpenses(actor, new URLSearchParams({ campaignId: camp }))) as { items: Record<string, unknown>[] };

beforeAll(async () => {
  w = await makeWorld(); other = await makeWorld();
  const v = (await mkVendor(w, '[DEMO] E 廠商')).id;
  hostA = (await mkHost(w, '[DEMO] E 團主甲')).id; hostB = (await mkHost(w, '[DEMO] E 團主乙（不在檔期）')).id;
  hostUser = await addUser(w.orgId, 'HOST', { hostIds: [hostA] });
  vendorUser = await addUser(w.orgId, 'VENDOR', { vendorIds: [v] });
  const p = await mkProduct(w, v, { name: `[DEMO] E 商品 ${++n}`, skus: [{ skuCode: `E${n}`, name: 'a', groupPrice: 800, costPrice: 500 }] });
  const pOther = await mkProduct(w, v, { name: `[DEMO] E 另一商品 ${++n}`, skus: [{ skuCode: `E${n}`, name: 'b', groupPrice: 500, costPrice: 100 }] });
  prod = p.id;
  camp = (await mkCampaign(w, v, { products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: [{ hostId: hostA }], sampleReadyDate: dayOffset(-30), openDate: dayOffset(-10), closeDate: dayOffset(10) })).id;
  (globalThis as Record<string, unknown>).__pOther = pOther.id;
});

describe('K-8a：費用承擔方與實際付款方分別記錄', () => {
  it('承擔方（品牌）與實際付款方（公司）可以不同；其餘歸屬欄位一併記錄；舊的未歸屬紀錄相容', async () => {
    const legacy = await createExpense(w.finance, exp({ category: 'OTHER', amount: 50 }) as never);
    const r = await createExpense(w.finance, exp({
      bearerParty: 'BRAND', payerParty: 'COMPANY', hostId: hostA, productId: prod, termsSourceKind: 'CONTRACT', termsRef: 'C-2026-01',
      paymentStatus: 'PAID', paidOn: dayOffset(-2), evidenceUrl: 'https://docs.example.invalid/receipt/1',
    }) as never);
    const items = (await list(w.finance)).items;
    const row = items.find((x) => x.id === r.id)!;
    expect(row).toMatchObject({ bearerParty: 'BRAND', payerParty: 'COMPANY', hostId: hostA, productId: prod, termsSourceKind: 'CONTRACT', termsRef: 'C-2026-01', paymentStatus: 'PAID', evidenceUrl: 'https://docs.example.invalid/receipt/1', claimDirection: 'UNDETERMINED', claimStatus: 'UNCONFIRMED' });
    expect((row.claimHint as { kind: string }).kind).toBe('RECEIVABLE');                         // 提示：公司可能向品牌有應收
    expect(row.claimDirection).toBe('UNDETERMINED');                                              // 但不會自動寫入應收應付
    const old = items.find((x) => x.id === legacy.id)!;
    expect(old).toMatchObject({ bearerParty: null, payerParty: null, paymentStatus: 'UNRECORDED', claimDirection: 'UNDETERMINED', claimStatus: 'UNCONFIRMED' });   // 舊資料相容：不假設未付、不假設沒有往來
    expect((old.claimHint as { kind: string }).kind).toBe('UNKNOWN');
    const a = await query(`SELECT created_by, updated_by FROM expenses WHERE id=$1`, [r.id]);
    expect(a[0]).toMatchObject({ created_by: w.finance.userId, updated_by: w.finance.userId });   // 建立人、修改人
  });

  it('稽核紀錄：建立與調整都有，且不含付款憑證連結等細節', async () => {
    const r = await createExpense(w.finance, exp({ bearerParty: 'COMPANY', payerParty: 'HOST', evidenceUrl: 'https://docs.example.invalid/receipt/audit' }) as never);
    await updateExpenseAttribution(w.finance, r.id, { paymentStatus: 'UNPAID' });
    const logs = await query<{ action: string; before_data: unknown; after_data: unknown }>(`SELECT action, before_data, after_data FROM audit_logs WHERE organization_id=$1 AND entity_id=$2 ORDER BY id`, [w.orgId, r.id]);
    expect(logs.map((x) => x.action)).toEqual(['expense.create', 'expense.attribution.update']);
    expect(JSON.stringify(logs)).not.toContain('receipt/audit');
    expect(logs[1].after_data).toMatchObject({ paymentStatus: 'UNPAID', bearerParty: 'COMPANY', payerParty: 'HOST' });
  });

  it('驗證：付款狀態與日期／金額一致、憑證連結只收 https 且不含帳密、應收應付要有對象、團主與商品需屬於該檔期、備註不得含電話', async () => {
    await expect(createExpense(w.finance, exp({ paymentStatus: 'PAID' }) as never)).rejects.toThrow(/付款日期/);
    await expect(createExpense(w.finance, exp({ paymentStatus: 'PARTIALLY_PAID', paidOn: dayOffset(-1), paidAmount: 700 }) as never)).rejects.toThrow(/小於費用金額/);
    await expect(createExpense(w.finance, exp({ evidenceUrl: 'javascript:alert(1)' }) as never)).rejects.toThrow(/https/);
    await expect(createExpense(w.finance, exp({ evidenceUrl: 'http://docs.example.invalid/x' }) as never)).rejects.toThrow(/只接受 https/);
    await expect(createExpense(w.finance, exp({ evidenceUrl: 'https://127.0.0.1/x' }) as never)).rejects.toThrow(/IP/);
    await expect(createExpense(w.finance, exp({ evidenceUrl: 'https://u:p@docs.example.invalid/x' }) as never)).rejects.toThrow(/帳號或密碼/);
    await expect(createExpense(w.finance, exp({ claimDirection: 'RECEIVABLE' }) as never)).rejects.toThrow(/指定對象/);
    await expect(createExpense(w.finance, exp({ hostId: hostB }) as never)).rejects.toThrow(/不在此檔期/);
    await expect(createExpense(w.finance, exp({ productId: (globalThis as Record<string, unknown>).__pOther }) as never)).rejects.toThrow(/不在此檔期/);
    await expect(createExpense(w.finance, exp({ claimNote: '請打 0912345678' }) as never)).rejects.toThrow(/電話/);
    // 資料庫層的保證
    const r = await createExpense(w.finance, exp() as never);
    await expect(query(`UPDATE expenses SET payment_status='PAID' WHERE id=$1`, [r.id])).rejects.toThrow();
    await expect(query(`UPDATE expenses SET claim_status='CONFIRMED' WHERE id=$1`, [r.id])).rejects.toThrow();
    await expect(query(`UPDATE expenses SET payer_party='NOBODY' WHERE id=$1`, [r.id])).rejects.toThrow();
  });

  it('作廢的費用不能調整；不實體刪除', async () => {
    const r = await createExpense(w.finance, exp({ bearerParty: 'BRAND' }) as never);
    await voidExpense(w.finance, r.id, '[DEMO] 重複登錄');
    await expect(updateExpenseAttribution(w.finance, r.id, { payerParty: 'COMPANY' })).rejects.toThrow(/已作廢/);
    await expect(query(`DELETE FROM expenses WHERE id=$1`, [r.id])).rejects.toThrow();
  });
});

describe('K-8a：未確認的應收應付不得成為正式付款指示', () => {
  it('應收應付預設「未判斷、未確認」；標成應收也只是紀錄；確認後仍不產生任何付款、撥款、扣款、發票或結算變動', async () => {
    const before = await counts();
    const commissionBefore = await campaignHostCommission(pool(), w.orgId, camp);
    const r = await createExpense(w.finance, exp({ bearerParty: 'BRAND', payerParty: 'COMPANY' }) as never);
    await expect(confirmExpenseClaim(w.finance, r.id, {})).rejects.toThrow(/指定「公司應收」或「公司應付」/);                 // 還沒判斷就不能確認
    await updateExpenseAttribution(w.finance, r.id, { claimDirection: 'RECEIVABLE', claimParty: 'BRAND', claimNote: '[DEMO] 公司先墊付運費，向品牌請款' });
    let row = (await list(w.finance)).items.find((x) => x.id === r.id)!;
    expect(row).toMatchObject({ claimDirection: 'RECEIVABLE', claimParty: 'BRAND', claimStatus: 'UNCONFIRMED' });
    const out = await confirmExpenseClaim(w.finance, r.id, { note: '[DEMO] 財務已核對' });
    expect(out).toMatchObject({ claimStatus: 'CONFIRMED', paymentInstruction: false });
    row = (await list(w.finance)).items.find((x) => x.id === r.id)!;
    expect(row).toMatchObject({ claimStatus: 'CONFIRMED', claimConfirmedBy: w.finance.userId });
    expect(await counts()).toEqual(before);                                                                              // 沒有任何入帳／付款、發票、結算、佣金規則、訂單變動
    expect(await campaignHostCommission(pool(), w.orgId, camp)).toEqual(commissionBefore);                             // 結算佣金計算結果不變
    await expect(confirmExpenseClaim(w.finance, r.id, {})).rejects.toThrow(/已經確認過/);
    expect((await query(`SELECT 1 FROM audit_logs WHERE organization_id=$1 AND action='expense.claim.confirm' AND entity_id=$2`, [w.orgId, r.id])).length).toBe(1);
  });

  it('已確認的應收應付，只要方向或對象被改動就退回未確認，必須重新確認（不能靜默變更）', async () => {
    const r = await createExpense(w.finance, exp({ bearerParty: 'COMPANY', payerParty: 'HOST', claimDirection: 'PAYABLE', claimParty: 'HOST' }) as never);
    await confirmExpenseClaim(w.finance, r.id, {});
    await updateExpenseAttribution(w.finance, r.id, { paymentStatus: 'UNPAID' });                                          // 改別的欄位：仍是已確認
    expect((await list(w.finance)).items.find((x) => x.id === r.id)!.claimStatus).toBe('CONFIRMED');
    await updateExpenseAttribution(w.finance, r.id, { claimParty: 'BRAND' });                                              // 改對象：退回未確認
    const row = (await list(w.finance)).items.find((x) => x.id === r.id)!;
    expect(row).toMatchObject({ claimStatus: 'UNCONFIRMED', claimParty: 'BRAND', claimConfirmedBy: null });
  });

  it('程式碼裡沒有任何路徑從費用的應收應付產生付款：只有財務的「入帳／付款」手動紀錄會寫入 payments', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = `${d}/${f.name}`; if (f.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f.name)) files.push(p); } };
    walk('src');
    const writers = files.filter((f) => /INSERT INTO payments/i.test(readFileSync(f, 'utf8')));
    expect(writers).toEqual(['src/server/modules/finance.ts']);                                                           // 只有既有的手動入帳／付款紀錄
    const fin = readFileSync('src/server/modules/finance.ts', 'utf8');
    const confirmFn = fin.slice(fin.indexOf('export async function confirmExpenseClaim'), fin.indexOf('const expensePatchSchema'));
    expect(confirmFn).not.toMatch(/payments|invoices|settlement/i);
  });
});

describe('K-8a：權限（未授權角色無法看到或修改敏感費用歸屬）', () => {
  it('小編、團主、廠商、其他組織：不能讀取或寫入費用與歸屬（HTTP 403／404）', async () => {
    const r = await createExpense(w.finance, exp({ bearerParty: 'BRAND', payerParty: 'COMPANY' }) as never);
    for (const [name, actor] of [['小編', w.editor], ['團主', hostUser], ['廠商', vendorUser]] as [string, Actor][]) {
      const c = await Client.forActor(actor);
      expect((await c.call('GET', '/expenses')).status, `${name} 讀取`).toBe(403);
      expect((await c.call('POST', '/expenses', exp({ bearerParty: 'BRAND' }))).status, `${name} 建立`).toBe(403);
      expect((await c.call('PATCH', `/expenses/${r.id}/attribution`, { payerParty: 'HOST' })).status, `${name} 調整`).toBe(403);
      expect((await c.call('POST', `/expenses/${r.id}/claim/confirm`, {})).status, `${name} 確認`).toBe(403);
    }
    const oc = await Client.forActor(other.finance);
    expect((await oc.call('PATCH', `/expenses/${r.id}/attribution`, { payerParty: 'HOST' })).status).toBe(404);
    expect((await oc.call('POST', `/expenses/${r.id}/claim/confirm`, {})).status).toBe(404);
    expect((await listExpenses(other.finance, new URLSearchParams({ campaignId: camp })) as { items: unknown[] }).items).toHaveLength(0);
  });

  it('有讀取權限但沒有財務寫入權限（營運主管）：看得到歸屬、不能新增或調整；歸屬資料沒有被改動', async () => {
    const r = await createExpense(w.finance, exp({ bearerParty: 'BRAND', payerParty: 'COMPANY' }) as never);
    const seen = (await list(w.manager)).items.find((x) => x.id === r.id)!;
    expect(seen.bearerParty).toBe('BRAND');
    await expect(createExpense(w.manager, exp({ bearerParty: 'BRAND' }) as never)).rejects.toThrow();
    await expect(updateExpenseAttribution(w.manager, r.id, { payerParty: 'HOST' })).rejects.toThrow();
    await expect(confirmExpenseClaim(w.manager, r.id, {})).rejects.toThrow();
    expect((await query(`SELECT payer_party FROM expenses WHERE id=$1`, [r.id]))[0].payer_party).toBe('COMPANY');
  });

  it('費用歸屬的遮罩：沒有成本檢視權限時，回應不含承擔方、付款方、應收應付、憑證等欄位（由純函式與 API 回應雙重驗證）', async () => {
    const r = await createExpense(w.finance, exp({ bearerParty: 'BRAND', payerParty: 'COMPANY', evidenceUrl: 'https://docs.example.invalid/receipt/mask' }) as never);
    const fin = await Client.forActor(w.finance);
    const body = JSON.stringify((await fin.call('GET', `/expenses?campaignId=${camp}`)).json);
    expect(body).toContain(r.id); expect(body).toContain('receipt/mask');                                                   // 有權限者看得到
    const { maskExpenseAttribution } = await import('@/server/lib/expense-attribution');
    const masked = JSON.stringify(((await list(w.finance)).items).map((x) => maskExpenseAttribution(x, false)));
    expect(masked).not.toContain('receipt/mask'); expect(masked).not.toContain('bearerParty'); expect(masked).not.toContain('claimDirection');
  });
});

describe('K-8a：費用歸屬對照報告使用新欄位；既有結算與發票不受影響', () => {
  it('報告列出支出的承擔方與付款方、與試算條款不一致之處與可能的應收；未確認不是付款指示；報告唯讀', async () => {
    const TERMS = { cashFlowMode: 'BRAND_COLLECTS', commissionBasis: 'NSV', brandFeePct: 10, serviceFeeFixed: 0, hostCommissionPct: 5, hostPaidBy: 'COMPANY', shippingPerOrder: 60, shippingBorneBy: 'BRAND', platformFeePct: 3, platformFeeBorneBy: 'BRAND', otherVariablePerOrder: 0, otherCostBorneBy: 'COMPANY', fixedCost: 0, fixedCostBorneBy: 'COMPANY', returnCostPerRefundOrder: 20, returnCostBorneBy: 'COMPANY' };
    await createFeasibility(w.manager, prod, { campaignId: camp, inputs: TERMS, sources: Object.fromEntries(Object.keys(TERMS).map((k) => [k, { kind: 'CONTRACT' }])) } as never);
    const before = await counts();
    const rep = (await getFeeAttributionReport(w.finance, { campaignId: camp })).reports.find((x) => x.productId === prod)!;
    const ship = rep.rows.find((x) => x.item === 'shipping')!;
    expect(ship.formal.records.withBearerAndPayer).toBeGreaterThan(0);
    expect(ship.formal.records.payerDiffersFromBearer).toBeGreaterThan(0);
    expect(['RECEIVABLE', 'UNKNOWN']).toContain(ship.obligation.kind);
    expect(ship.reasons.join()).toContain('不是付款指示');
    expect(ship.alignment).toBe('NOT_ALIGNED');                                                                          // 結算仍未處理運費：KPI 與正式結算尚未一致
    expect(await counts()).toEqual(before);
  });
});

describe('D-3／D-4／D-6／D-8：待補清單、承擔方待確認、共同費用標記、憑證連結', () => {
  it('D-3 待補清單：承擔方或實際付款方未確認的費用可篩選列出（唯讀）；列表附待補摘要；不批次回填、不改任何歷史紀錄；小編看不到', async () => {
    const a = await createExpense(w.finance, exp({ category: 'MARKETING' }) as never);               // 都沒填
    const b = await createExpense(w.finance, exp({ category: 'SAMPLE', bearerParty: 'COMPANY' }) as never);   // 只缺付款方
    const c = await createExpense(w.finance, exp({ category: 'OTHER', bearerParty: 'BRAND', payerParty: 'COMPANY' }) as never);
    const before = await query(`SELECT id, bearer_party, payer_party, updated_at FROM expenses WHERE organization_id=$1 ORDER BY id`, [w.orgId]);
    const todo = (await listExpenses(w.finance, new URLSearchParams({ campaignId: camp, attributionPending: '1' }))) as { items: { id: string; bearerStatus: string; payerStatus: string }[]; pendingAttribution: { bearerPending: number; payerPending: number; either: number; note: string } };
    const ids = todo.items.map((x) => x.id);
    expect(ids).toContain(a.id); expect(ids).toContain(b.id); expect(ids).not.toContain(c.id);
    expect(todo.items.find((x) => x.id === a.id)).toMatchObject({ bearerStatus: 'PENDING', payerStatus: 'PENDING' });
    expect(todo.items.find((x) => x.id === b.id)).toMatchObject({ bearerStatus: 'COMPANY', payerStatus: 'PENDING' });
    expect(todo.pendingAttribution.either).toBeGreaterThanOrEqual(2); expect(todo.pendingAttribution.note).toContain('不批次回填');
    expect(await query(`SELECT id, bearer_party, payer_party, updated_at FROM expenses WHERE organization_id=$1 ORDER BY id`, [w.orgId])).toEqual(before);   // 列清單沒有改任何資料
    const edTodo = (await listExpenses(w.manager, new URLSearchParams({ campaignId: camp }))) as { pendingAttribution?: unknown };
    expect(edTodo.pendingAttribution).toBeDefined();                                      // 營運主管有成本檢視權限，可看
    const ec = await Client.forActor(w.editor);
    expect((await ec.call('GET', `/expenses?campaignId=${camp}&attributionPending=1`)).status).toBe(403);
  });
  it('D-4 承擔方待確認：列表標示 PENDING；財務補承擔方後變為已確認；修正歷史（前後內容）唯讀可查；沒有成本權限者不可查', async () => {
    const e = await createExpense(w.finance, exp({ category: 'SHIPPING', amount: 910 }) as never);
    await updateExpenseAttribution(w.finance, e.id, { bearerParty: 'COMPANY', termsSourceKind: 'FORMAL_TERMS', termsRef: 'FT-D4-1' } as never);
    await updateExpenseAttribution(w.finance, e.id, { bearerParty: 'BRAND', termsSourceKind: 'CONTRACT', termsRef: 'C-D4-9' } as never);
    const h = await expenseHistory(w.finance, e.id) as { events: { action: string; beforeData: Record<string, unknown> | null; afterData: Record<string, unknown> | null }[] };
    expect(h.events.map((x) => x.action)).toEqual(['expense.create', 'expense.attribution.update', 'expense.attribution.update']);
    expect(h.events[0].afterData).toMatchObject({ bearerStatus: 'PENDING', bearerParty: null });                           // 原始紀錄：承擔方未知
    expect(h.events[1].beforeData).toMatchObject({ bearerParty: null }); expect(h.events[1].afterData).toMatchObject({ bearerParty: 'COMPANY', bearerStatus: 'COMPANY', termsSourceKind: 'FORMAL_TERMS' });
    expect(h.events[2].beforeData).toMatchObject({ bearerParty: 'COMPANY', termsRef: 'FT-D4-1' }); expect(h.events[2].afterData).toMatchObject({ bearerParty: 'BRAND', termsRef: 'C-D4-9' });
    expect((await query(`SELECT amount, category FROM expenses WHERE id=$1`, [e.id]))[0]).toMatchObject({ amount: 910, category: 'SHIPPING' });   // 原始費用沒被覆蓋
    expect((await (await Client.forActor(w.editor)).call('GET', `/expenses/${e.id}/history`)).status).toBe(403);
    expect((await (await Client.forActor(other.finance)).call('GET', `/expenses/${e.id}/history`)).status).toBe(404);
    await expect(expenseHistory(w.manager, e.id)).resolves.toBeTruthy();                // 營運主管可讀（唯讀）
  });
  it('D-6 共同費用標記：標為共同費用時不可同時指定商品／團主；直接歸屬需有商品；資料庫也擋；舊資料不需標記', async () => {
    await expect(createExpense(w.finance, exp({ costScope: 'SHARED', productId: prod }) as never)).rejects.toThrow(/不可指定對應商品或團主/);
    await expect(createExpense(w.finance, exp({ costScope: 'DIRECT_PRODUCT' }) as never)).rejects.toThrow(/需指定對應商品/);
    await expect(createExpense(w.finance, exp({ costScope: 'HOST_SPECIFIC' }) as never)).rejects.toThrow(/需指定對應團主/);
    const ok = await createExpense(w.finance, exp({ costScope: 'SHARED', bearerParty: 'COMPANY' }) as never);
    const direct = await createExpense(w.finance, exp({ costScope: 'DIRECT_PRODUCT', productId: prod, bearerParty: 'BRAND' }) as never);
    expect((await query(`SELECT cost_scope FROM expenses WHERE id=$1`, [ok.id]))[0].cost_scope).toBe('SHARED');
    await expect(query(`UPDATE expenses SET product_id=$2 WHERE id=$1`, [ok.id, prod])).rejects.toThrow();      // 已標共同卻被指定商品：資料庫擋
    await expect(updateExpenseAttribution(w.finance, direct.id, { costScope: 'SHARED' } as never)).rejects.toThrow(/不可指定對應商品或團主/);
    expect((await query(`SELECT count(*)::int AS n FROM expenses WHERE organization_id=$1 AND cost_scope IS NULL`, [w.orgId]))[0].n).toBeGreaterThan(0);   // 舊資料沒有被回填
  });
  it('D-8 憑證連結：只存連結（不新增檔案儲存）；稽核只記「連結是否變更」不記內容；沒有成本權限者看不到；不主動存取連結', async () => {
    const url = 'https://docs.example.invalid/receipt/d8-secret-token-123';
    const e = await createExpense(w.finance, exp({ bearerParty: 'COMPANY', payerParty: 'COMPANY', evidenceUrl: url }) as never);
    await updateExpenseAttribution(w.finance, e.id, { evidenceUrl: 'https://docs.example.invalid/receipt/d8-v2-token-456' } as never);
    const audits = JSON.stringify(await query(`SELECT before_data, after_data FROM audit_logs WHERE organization_id=$1 AND entity_id=$2`, [w.orgId, e.id]));
    expect(audits).not.toContain('d8-secret-token'); expect(audits).not.toContain('d8-v2-token');
    expect(audits).toContain('evidenceLinkChanged');
    const mgr = ((await listExpenses(w.manager, new URLSearchParams({ campaignId: camp }))) as { items: Record<string, unknown>[] }).items.find((x) => x.id === e.id)!;
    expect(mgr.evidenceUrl).toBe('https://docs.example.invalid/receipt/d8-v2-token-456');
    const masked = ((await listExpenses(w.finance, new URLSearchParams({ campaignId: camp }))) as { items: Record<string, unknown>[] }).items.find((x) => x.id === e.id)!;
    expect(masked.evidenceUrl).toBeDefined();                                          // 財務有權限
    const { maskExpenseAttribution } = await import('@/server/lib/expense-attribution');
    expect(maskExpenseAttribution({ ...masked }, false)).not.toHaveProperty('evidenceUrl');
    expect(readdirSync('src/server').join()).not.toMatch(/storage|upload/i);            // 沒有新增檔案儲存服務
  });
});
