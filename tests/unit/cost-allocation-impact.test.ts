import { describe, expect, it } from 'vitest';
import { compareAllocations, type ProductBasis, type SharedCost } from '@/server/lib/cost-allocation-proposal';
import { analyzeCostImpact, classifyExpense, type ExpenseForAllocation } from '@/server/lib/cost-allocation-impact';

const A: ProductBasis = { productId: 'A', name: '高單價少量', nsv: 8_000, quantity: 10, orderLines: 10, productCost: 4_000 };
const B: ProductBasis = { productId: 'B', name: '低單價大量', nsv: 2_000, quantity: 40, orderLines: 30, productCost: 1_200 };
const period = { openDate: '2026-10-01', closeDate: '2026-10-31' };
const e = (o: Partial<ExpenseForAllocation> & { id: string }): ExpenseForAllocation => ({ category: 'SHIPPING', amount: 1_000, incurredOn: '2026-10-15', bearerParty: 'COMPANY', productId: null, hostId: null, ...o });
const poolOf = (expenses: ExpenseForAllocation[], include: (x: ExpenseForAllocation) => boolean): SharedCost[] => {
  const byCat: Record<string, number> = {};
  for (const x of expenses.filter((y) => !y.productId && !y.hostId && include(y))) byCat[x.category] = (byCat[x.category] ?? 0) + x.amount;
  return Object.entries(byCat).map(([key, amount]) => ({ key, label: key, amount }));
};
const run = (expenses: ExpenseForAllocation[], extra: { rateDirect?: string[]; costs?: SharedCost[]; period?: typeof period } = {}) => {
  // D-4：共同費用池只含「已確認由公司承擔」者；承擔方待確認的另放進保守情境的池
  const comparison = compareAllocations([A, B], extra.costs ?? poolOf(expenses, (x) => x.bearerParty === 'COMPANY'));
  const conservativeComparison = compareAllocations([A, B], poolOf(expenses, (x) => x.bearerParty === 'COMPANY' || x.bearerParty == null));
  return analyzeCostImpact({ products: [A, B], expenses, period: extra.period ?? period, comparison, conservativeComparison, rateDirectCategories: extra.rateDirect });
};
const profit = (r: ReturnType<typeof run>, m: string, id: string) => r.impact.find((i) => i.method === m)!.products.find((p) => p.productId === id)!.productProfit;

describe('K-7a 費用分類：直接歸屬商品／檔期共同／特定團主', () => {
  it('依對應商品、對應團主分類；兩者都有時算在商品；不推測', () => {
    expect(classifyExpense(e({ id: '1', productId: 'A' })).cls).toBe('DIRECT_PRODUCT');
    expect(classifyExpense(e({ id: '2', hostId: 'H1' })).cls).toBe('HOST_SPECIFIC');
    expect(classifyExpense(e({ id: '3' })).cls).toBe('CAMPAIGN_SHARED');
    expect(classifyExpense(e({ id: '4', productId: 'A', hostId: 'H1' })).cls).toBe('DIRECT_PRODUCT');
  });
  it('承擔方（D-4）：只有「公司已確認承擔」才是正式成本；品牌／團主承擔不計入；未知＝待確認，不是公司成本', () => {
    expect(classifyExpense(e({ id: '0', bearerParty: 'COMPANY' }))).toMatchObject({ bearerStatus: 'COMPANY', countsAsCompanyCost: true });
    expect(classifyExpense(e({ id: '1', bearerParty: 'BRAND' }))).toMatchObject({ bearerStatus: 'NOT_COMPANY', countsAsCompanyCost: false });
    expect(classifyExpense(e({ id: '2', bearerParty: 'HOST' }))).toMatchObject({ bearerStatus: 'NOT_COMPANY', countsAsCompanyCost: false });
    expect(classifyExpense(e({ id: '3', bearerParty: null }))).toMatchObject({ bearerStatus: 'PENDING', countsAsCompanyCost: false, bearerUnknown: true });
  });
  it('分類合計：三類金額與筆數正確，總和＝公司成本＋非公司成本', () => {
    const r = run([e({ id: '1', amount: 1_000 }), e({ id: '2', amount: 300, productId: 'A', category: 'SAMPLE' }), e({ id: '3', amount: 200, hostId: 'H1', category: 'MARKETING' }), e({ id: '4', amount: 90, bearerParty: 'BRAND' })]);
    const by = Object.fromEntries(r.classes.map((c) => [c.cls, c]));
    expect(by.CAMPAIGN_SHARED).toMatchObject({ count: 2, amount: 1_090 });     // 品牌承擔的那筆也分類為共同，但不計入公司
    expect(by.DIRECT_PRODUCT).toMatchObject({ count: 1, amount: 300 });
    expect(by.HOST_SPECIFIC).toMatchObject({ count: 1, amount: 200 });
    expect(r.sharedPoolTotal).toBe(1_000); expect(r.directTotal).toBe(300); expect(r.hostSpecificTotal).toBe(200); expect(r.excludedNotCompanyTotal).toBe(90);
    expect(r.companyCostTotal).toBe(1_500);
  });
});

describe('K-7b／c 各方法對公司利潤與商品利潤的影響', () => {
  it('公司利潤與方法無關；商品利潤隨方法改變；加總對得上（Σ商品利潤 − 團主費用 − 池差額＝公司利潤）', () => {
    const r = run([e({ id: '1', amount: 1_000 }), e({ id: '2', amount: 200, hostId: 'H1', category: 'MARKETING' }), e({ id: '3', amount: 300, productId: 'A', category: 'SAMPLE' })]);
    // 公司：(8000−4000)+(2000−1200)−(1000+200+300)＝3300
    for (const i of r.impact) expect(i).toMatchObject({ usable: true, companyProfit: 3_300, reconciles: true, poolGap: 0 });
    expect(r.companyProfitInvariant).toBe(true);
    // 依淨銷售額：A 800／B 200；A 另有直接 300：A＝8000−4000−300−800＝2900；B＝2000−1200−200＝600
    expect(profit(r, 'BY_NSV', 'A')).toBe(2_900); expect(profit(r, 'BY_NSV', 'B')).toBe(600);
    // 依數量：A 200／B 800：A＝8000−4000−300−200＝3500；B＝2000−1200−800＝0
    expect(profit(r, 'BY_QUANTITY', 'A')).toBe(3_500); expect(profit(r, 'BY_QUANTITY', 'B')).toBe(0);
    expect(r.productProfitSpread.A).toBe(600); expect(r.productProfitSpread.B).toBe(600);
  });
  it('商品缺成本：該商品利潤與公司利潤都是資料不足（null），不當 0', () => {
    const a2 = { ...A, productCost: null };
    const comparison = compareAllocations([a2, B], [{ key: 'SHIPPING', label: '運費', amount: 1_000 }]);
    const r = analyzeCostImpact({ products: [a2, B], expenses: [e({ id: '1' })], period, comparison });
    expect(r.impact[0].companyProfit).toBeNull(); expect(r.impact[0].products[0].productProfit).toBeNull(); expect(r.impact[0].reconciles).toBeNull();
    expect(r.companyProfitInvariant).toBeNull();
    expect(r.risks.some((x) => x.code === 'UNALLOCATED' && x.message.includes('缺SKU 成本'))).toBe(true);
  });
  it('缺分攤基礎的方法不可用：不產生數字、不影響其他方法', () => {
    const b2 = { ...B, quantity: null };
    const comparison = compareAllocations([A, b2], [{ key: 'SHIPPING', label: '運費', amount: 1_000 }]);
    const r = analyzeCostImpact({ products: [A, b2], expenses: [e({ id: '1' })], period, comparison });
    const q = r.impact.find((i) => i.method === 'BY_QUANTITY')!;
    expect(q).toMatchObject({ usable: false, poolGap: null, reconciles: null }); expect(q.products.every((p) => p.productProfit === null)).toBe(true);
    expect(r.impact.find((i) => i.method === 'BY_NSV')!.reconciles).toBe(true);
  });
});

describe('K-7d 風險：重複分攤、未分攤、跨期', () => {
  const codes = (r: ReturnType<typeof run>) => r.risks.map((x) => `${x.code}:${x.level}`);
  it('同類別同時有指定商品與共同費用 → 可能重複分攤', () => {
    const r = run([e({ id: '1', amount: 1_000 }), e({ id: '2', amount: 400, productId: 'A' })]);
    const x = r.risks.find((k) => k.code === 'DOUBLE_ALLOCATION')!;
    expect(x.level).toBe('REVIEW'); expect(x.expenseIds.sort()).toEqual(['1', '2']); expect(x.message).toContain('算兩次');
  });
  it('可直接歸屬（費率）的類別又有指定商品的同類費用 → 可能重複；直接歸屬算太多（負的池差額）→ 重複分攤', () => {
    const costs: SharedCost[] = [{ key: 'PLATFORM_FEE', label: '平台費', amount: 100, direct: { kind: 'RATE_ON_NSV', ratePct: 3 } }];   // 費率算出 300，記錄只有 100
    const r = run([e({ id: '1', category: 'PLATFORM_FEE', amount: 100 }), e({ id: '9', category: 'PLATFORM_FEE', amount: 50, productId: 'B' })], { costs, rateDirect: ['PLATFORM_FEE'] });
    expect(r.risks.filter((k) => k.code === 'DOUBLE_ALLOCATION').length).toBeGreaterThanOrEqual(2);
    expect(r.impact.find((i) => i.method === 'DIRECT_THEN_NSV')!.poolGap).toBe(-200);
  });
  it('直接歸屬算不滿（正的池差額）→ 未分攤；團主費用、指定商品不在檔期、承擔方未記錄、品牌承擔都有提示', () => {
    const costs: SharedCost[] = [{ key: 'PLATFORM_FEE', label: '平台費', amount: 500, direct: { kind: 'RATE_ON_NSV', ratePct: 3 } }];  // 費率合計 300 < 500
    const r = run([e({ id: '1', category: 'PLATFORM_FEE', amount: 500 }), e({ id: '2', hostId: 'H1', amount: 200 }), e({ id: '3', productId: 'ZZZ', amount: 70 }), e({ id: '4', bearerParty: null, amount: 80, category: 'OTHER' }), e({ id: '5', bearerParty: 'BRAND', amount: 60 })], { costs });
    const un = r.risks.filter((k) => k.code === 'UNALLOCATED').map((k) => k.message).join('\n');
    expect(un).toContain('「可直接歸屬者直接算，其餘依有效淨銷售額」仍有 200 元共同費用沒有分到任何商品'); expect(un).toContain('特定團主費用 200 元'); expect(un).toContain('指定的商品不在此檔期'); expect(un).toContain('承擔方待確認'); expect(un).toContain('由品牌或團主承擔');
    // 指定商品不在檔期的費用仍計入公司成本一次（不猜歸屬、不消失）
    expect(r.companyCostTotal).toBe(500 + 200 + 70);                  // 承擔方待確認的 80 不算公司正式成本
    expect(r.pendingBearer).toMatchObject({ count: 1, total: 80 });
  });
  it('跨期：發生日在檔期之外 → 提示但不排除；無日期 → 資料不足的提示', () => {
    const r = run([e({ id: '1', incurredOn: '2026-09-20' }), e({ id: '2', incurredOn: '2026-11-03' }), e({ id: '3', incurredOn: '2026-10-10' })]);
    const x = r.risks.find((k) => k.code === 'CROSS_PERIOD')!;
    expect(x).toMatchObject({ level: 'REVIEW', amount: 2_000 }); expect(x.expenseIds.sort()).toEqual(['1', '2']);
    expect(r.sharedPoolTotal).toBe(3_000);                      // 沒有自動排除
    const r2 = run([e({ id: '1' })], { period: { openDate: null, closeDate: null } as never });
    expect(r2.risks.find((k) => k.code === 'CROSS_PERIOD')).toMatchObject({ level: 'INFO' });
    expect(codes(run([e({ id: '1' })]))).not.toContain('CROSS_PERIOD:REVIEW');
  });
  it('純函式：不改輸入', () => {
    const ex = [e({ id: '1' }), e({ id: '2', productId: 'A' })];
    const before = JSON.stringify([A, B, ex]);
    run(ex);
    expect(JSON.stringify([A, B, ex])).toBe(before);
  });
});

describe('D-4：承擔方未知＝待確認；不算公司正式成本、不當 0；保守情境另列', () => {
  const pend = [e({ id: 'c1', amount: 1_000, bearerParty: 'COMPANY' }), e({ id: 'p1', amount: 400, bearerParty: null })];
  it('待確認的費用不在已確認公司成本內；已確認口徑的公司利潤與所有商品利潤為資料不足（共同費用待確認）', () => {
    const r = run(pend);
    expect(r.companyCostTotal).toBe(1_000); expect(r.sharedPoolTotal).toBe(1_000);
    expect(r.pendingBearer).toEqual({ count: 1, total: 400, expenseIds: ['p1'] });
    for (const i of r.impact) { expect(i.companyProfit).toBeNull(); expect(i.reconciles).toBeNull(); expect(i.products.every((p) => p.productProfit === null)).toBe(true); }
    expect(r.companyProfitInvariant).toBeNull();
    expect(Object.values(r.productProfitSpread).every((v) => v === null)).toBe(true);
    const risk = r.risks.find((k) => k.message.includes('承擔方待確認'))!;
    expect(risk).toMatchObject({ code: 'UNALLOCATED', level: 'REVIEW', amount: 400 }); expect(risk.message).toContain('不算公司正式成本'); expect(risk.message).toContain('資料不足');
  });
  it('保守情境：假設待確認全由公司承擔，另行計算；明確標示不是已確認成本、不得用於正式 KPI 或結算；與已確認口徑不混用', () => {
    const r = run(pend);
    const c = r.conservative!;
    expect(c.label).toContain('保守情境估計'); expect(c.note).toContain('不是已確認的公司成本'); expect(c.note).toContain('不得用於正式 KPI、結算');
    expect(c.companyCostTotal).toBe(1_400);                       // 1000 ＋ 400
    expect(c.companyProfit).toBe((8_000 - 4_000) + (2_000 - 1_200) - 1_400);   // 3400
    expect(c.impact.every((i) => i.companyProfit === 3_400 && i.reconciles === true)).toBe(true);
    expect(r.companyCostTotal).toBe(1_000);                       // 已確認口徑沒有被保守估計污染
  });
  it('待確認的費用指定了商品：只有該商品利潤資料不足，其他商品與已確認的共同分攤照常；待確認的特定團主費用只影響公司利潤', () => {
    const r = run([e({ id: 'c1', amount: 1_000, bearerParty: 'COMPANY' }), e({ id: 'p1', amount: 300, bearerParty: null, productId: 'A', category: 'SAMPLE' })]);
    const nsv = r.impact.find((i) => i.method === 'BY_NSV')!;
    expect(nsv.products.find((p) => p.productId === 'A')!.productProfit).toBeNull();
    expect(nsv.products.find((p) => p.productId === 'B')!.productProfit).toBe(2_000 - 1_200 - 200);
    expect(nsv.companyProfit).toBeNull();
    const h = run([e({ id: 'c1', amount: 1_000, bearerParty: 'COMPANY' }), e({ id: 'p2', amount: 200, bearerParty: null, hostId: 'H1', category: 'MARKETING' })]);
    const hn = h.impact.find((i) => i.method === 'BY_NSV')!;
    expect(hn.companyProfit).toBeNull(); expect(hn.products.every((p) => p.productProfit !== null)).toBe(true);
  });
  it('沒有待確認費用：沒有保守情境，已確認口徑的利潤照常計算', () => {
    const r = run([e({ id: 'c1', amount: 1_000, bearerParty: 'COMPANY' })]);
    expect(r.conservative).toBeNull(); expect(r.pendingBearer.count).toBe(0);
    expect(r.impact[0].companyProfit).toBe((8_000 - 4_000) + (2_000 - 1_200) - 1_000);   // 3800
  });
  it('承擔方依據不是正式合約或已確認條件時，只提示建議補依據（已依財務填寫處理）', () => {
    const r = run([e({ id: 'c1', amount: 1_000, bearerParty: 'COMPANY', bearerBasisKind: 'MANUAL_ESTIMATE' }), e({ id: 'c2', amount: 100, bearerParty: 'COMPANY', bearerBasisKind: 'CONTRACT' })]);
    const w = r.risks.find((k) => k.message.includes('承擔方依據不是正式合約'))!;
    expect(w.level).toBe('INFO'); expect(w.expenseIds).toEqual(['c1']);
  });
});

describe('D-6：共同費用另行標記；可直接歸屬者優先記錄明確歸屬；不啟用正式分攤', () => {
  it('沒有對應商品／團主、也沒有標記為共同費用：提示請財務標記（暫依共同費用處理，只供唯讀分析）；已標記共同、已指定商品者不提示', () => {
    const r = run([e({ id: 'u1', amount: 100, costScope: null }), e({ id: 'm1', amount: 200, costScope: 'SHARED' }), e({ id: 'd1', amount: 300, productId: 'A', costScope: 'DIRECT_PRODUCT' }), e({ id: 'd2', amount: 50, productId: 'B' })]);
    const x = r.risks.find((k) => k.message.includes('未標記為「檔期共同費用」'))!;
    expect(x).toMatchObject({ code: 'UNALLOCATED', level: 'REVIEW' }); expect(x.expenseIds).toEqual(['u1']);
    expect(x.message).toContain('不是正式分攤'); expect(x.message).toContain('可直接歸屬者優先記錄明確歸屬');
    expect(r.sharedPoolTotal).toBe(300);                                  // 未標記與已標記的共同費用都在分析池（唯讀）；直接歸屬的不在
  });
  it('全部已標記或已歸屬：沒有這個提示；分析永遠是「未生效」（不投入正式利潤）', () => {
    const r = run([e({ id: 'm1', amount: 200, costScope: 'SHARED' }), e({ id: 'd1', amount: 300, productId: 'A', costScope: 'DIRECT_PRODUCT' })]);
    expect(r.risks.some((k) => k.message.includes('未標記為「檔期共同費用」'))).toBe(false);
    expect(r.effective).toBe(false);
  });
});
