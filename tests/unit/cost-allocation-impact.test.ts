import { describe, expect, it } from 'vitest';
import { compareAllocations, type ProductBasis, type SharedCost } from '@/server/lib/cost-allocation-proposal';
import { analyzeCostImpact, classifyExpense, type ExpenseForAllocation } from '@/server/lib/cost-allocation-impact';

const A: ProductBasis = { productId: 'A', name: '高單價少量', nsv: 8_000, quantity: 10, orderLines: 10, productCost: 4_000 };
const B: ProductBasis = { productId: 'B', name: '低單價大量', nsv: 2_000, quantity: 40, orderLines: 30, productCost: 1_200 };
const period = { openDate: '2026-10-01', closeDate: '2026-10-31' };
const e = (o: Partial<ExpenseForAllocation> & { id: string }): ExpenseForAllocation => ({ category: 'SHIPPING', amount: 1_000, incurredOn: '2026-10-15', bearerParty: 'COMPANY', productId: null, hostId: null, ...o });
const run = (expenses: ExpenseForAllocation[], extra: { rateDirect?: string[]; costs?: SharedCost[]; period?: typeof period } = {}) => {
  const shared = expenses.filter((x) => !x.productId && !x.hostId && (x.bearerParty == null || x.bearerParty === 'COMPANY'));
  const byCat: Record<string, number> = {};
  for (const x of shared) byCat[x.category] = (byCat[x.category] ?? 0) + x.amount;
  const costs = extra.costs ?? Object.entries(byCat).map(([key, amount]) => ({ key, label: key, amount }));
  const comparison = compareAllocations([A, B], costs);
  return analyzeCostImpact({ products: [A, B], expenses, period: extra.period ?? period, comparison, rateDirectCategories: extra.rateDirect });
};
const profit = (r: ReturnType<typeof run>, m: string, id: string) => r.impact.find((i) => i.method === m)!.products.find((p) => p.productId === id)!.productProfit;

describe('K-7a 費用分類：直接歸屬商品／檔期共同／特定團主', () => {
  it('依對應商品、對應團主分類；兩者都有時算在商品；不推測', () => {
    expect(classifyExpense(e({ id: '1', productId: 'A' })).cls).toBe('DIRECT_PRODUCT');
    expect(classifyExpense(e({ id: '2', hostId: 'H1' })).cls).toBe('HOST_SPECIFIC');
    expect(classifyExpense(e({ id: '3' })).cls).toBe('CAMPAIGN_SHARED');
    expect(classifyExpense(e({ id: '4', productId: 'A', hostId: 'H1' })).cls).toBe('DIRECT_PRODUCT');
  });
  it('承擔方：公司或未記錄才算公司成本；品牌／團主承擔的不計入公司利潤也不分攤', () => {
    expect(classifyExpense(e({ id: '1', bearerParty: 'BRAND' })).countsAsCompanyCost).toBe(false);
    expect(classifyExpense(e({ id: '2', bearerParty: 'HOST' })).countsAsCompanyCost).toBe(false);
    expect(classifyExpense(e({ id: '3', bearerParty: null }))).toMatchObject({ countsAsCompanyCost: true, bearerUnknown: true });
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
    const costs: SharedCost[] = [{ key: 'PLATFORM_FEE', label: '平台費', amount: 500, direct: { kind: 'RATE_ON_NSV', ratePct: 3 } }, { key: 'OTHER', label: '其他', amount: 80 }];  // 費率合計 300 < 500
    const r = run([e({ id: '1', category: 'PLATFORM_FEE', amount: 500 }), e({ id: '2', hostId: 'H1', amount: 200 }), e({ id: '3', productId: 'ZZZ', amount: 70 }), e({ id: '4', bearerParty: null, amount: 80, category: 'OTHER' }), e({ id: '5', bearerParty: 'BRAND', amount: 60 })], { costs });
    const un = r.risks.filter((k) => k.code === 'UNALLOCATED').map((k) => k.message).join('\n');
    expect(un).toContain('「可直接歸屬者直接算，其餘依有效淨銷售額」仍有 200 元共同費用沒有分到任何商品'); expect(un).toContain('特定團主費用 200 元'); expect(un).toContain('指定的商品不在此檔期'); expect(un).toContain('尚未記錄承擔方'); expect(un).toContain('由品牌或團主承擔');
    // 指定商品不在檔期的費用仍計入公司成本一次（不猜歸屬、不消失）
    expect(r.companyCostTotal).toBe(500 + 200 + 70 + 80);
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
