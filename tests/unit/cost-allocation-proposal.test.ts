import { describe, expect, it } from 'vitest';
import { ALLOCATION_METHODS, compareAllocations, splitByWeights, type ProductBasis, type SharedCost } from '@/server/lib/cost-allocation-proposal';

const A: ProductBasis = { productId: 'A', name: '高單價少量', nsv: 8_000, quantity: 10, orderLines: 10, productCost: 4_000 };       // 單價 800
const B: ProductBasis = { productId: 'B', name: '低單價大量', nsv: 2_000, quantity: 40, orderLines: 30, productCost: 1_200 };      // 單價 50
const total = (r: ReturnType<typeof compareAllocations>, m: string, id: string) => r.methods.find((x) => x.method === m)!.allocations.find((a) => a.productId === id)!.total;

describe('K-7 多商品成本分攤提案（純函式；提案，未生效）', () => {
  it('splitByWeights：整數元、加總永遠等於原金額（最大餘額法），不會差一元', () => {
    expect(splitByWeights(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(splitByWeights(10, [3, 3, 4]).reduce((a, b) => a + b, 0)).toBe(10);
    expect(splitByWeights(0, [1, 2])).toEqual([0, 0]);
    expect(splitByWeights(50, [0, 0])).toEqual([0, 0]);
  });

  it('情境一：運費 1,000 元（共同費用）依不同方法分攤，結果差很多——方法選擇很重要', () => {
    const r = compareAllocations([A, B], [{ key: 'SHIPPING', label: '運費', amount: 1_000 }]);
    expect(total(r, 'BY_NSV', 'A')).toBe(800); expect(total(r, 'BY_NSV', 'B')).toBe(200);
    expect(total(r, 'BY_QUANTITY', 'A')).toBe(200); expect(total(r, 'BY_QUANTITY', 'B')).toBe(800);
    expect(total(r, 'BY_ORDER_LINES', 'A')).toBe(250); expect(total(r, 'BY_ORDER_LINES', 'B')).toBe(750);
    expect(r.spreadByProduct.A).toBe(600);          // 200 ~ 800
    expect(r.spreadByProduct.B).toBe(600);
  });

  it('情境二：平台費依 GMV 3%（可直接歸屬）＋固定費用 600（共同）：「可直接歸屬者直接算」避免高單價商品被少算', () => {
    const costs: SharedCost[] = [{ key: 'PLATFORM_FEE', label: '平台費', amount: 300, direct: { kind: 'RATE_ON_NSV', ratePct: 3 } }, { key: 'FIXED', label: '固定費用', amount: 600 }];
    const r = compareAllocations([A, B], costs);
    const byQty = (id: string) => total(r, 'BY_QUANTITY', id);
    const dir = (id: string) => total(r, 'DIRECT_THEN_NSV', id);
    expect(byQty('A')).toBe(Math.round(900 * 10 / 50)); expect(byQty('B')).toBe(900 - byQty('A'));
    expect(dir('A')).toBe(240 + 480);               // 平台費 8,000×3%＝240；固定費用 600×80%＝480
    expect(dir('B')).toBe(60 + 120);                // 2,000×3%＝60；600×20%＝120
    expect(dir('A') + dir('B')).toBe(900);          // 合計等於總費用
  });

  it('金額未知的費用不分攤、不當 0，並列在 unknownCosts', () => {
    const r = compareAllocations([A, B], [{ key: 'SHIPPING', label: '運費', amount: 1_000 }, { key: 'RETURN', label: '退貨處理', amount: null }]);
    for (const m of r.methods) { expect(m.unknownCosts).toEqual(['退貨處理']); expect(m.allocations[0].byCost.RETURN).toBeNull(); }
    expect(total(r, 'BY_NSV', 'A') + total(r, 'BY_NSV', 'B')).toBe(1_000);
  });

  it('缺分攤基礎（某商品沒有數量、沒有銷售額）：該方法不能用並說明原因，其餘方法照常；不用假設值補', () => {
    const r = compareAllocations([A, { ...B, quantity: null }], [{ key: 'SHIPPING', label: '運費', amount: 1_000 }]);
    const q = r.methods.find((m) => m.method === 'BY_QUANTITY')!;
    expect(q.usable).toBe(false); expect(q.problems.join()).toContain('缺少分攤基礎（數量）：低單價大量');
    expect(r.methods.find((m) => m.method === 'BY_NSV')!.usable).toBe(true);
    const none = compareAllocations([{ ...A, nsv: null }, { ...B, nsv: null }], [{ key: 'S', label: '運費', amount: 10 }]);
    expect(none.methods.find((m) => m.method === 'BY_NSV')!.usable).toBe(false);
  });

  it('單一商品不是多商品檔期：所有方法都不可用（不需要分攤）', () => {
    const r = compareAllocations([A], [{ key: 'S', label: '運費', amount: 10 }]);
    expect(r.methods.every((m) => !m.usable && m.problems.includes('不是多商品檔期'))).toBe(true);
  });

  it('結果明確標示為提案、未生效；包含 4 種候選方法與各自的取捨說明', () => {
    const r = compareAllocations([A, B], [{ key: 'S', label: '運費', amount: 100 }]);
    expect(r).toMatchObject({ effective: false, status: 'PROPOSAL_ONLY' });
    expect(r.methods.map((m) => m.method)).toEqual([...ALLOCATION_METHODS]);
    expect(r.methods.every((m) => m.note.length > 5 && m.label.length > 3)).toBe(true);
    expect(r.note).toContain('提案，未生效');
    expect(r.note).toContain('資料不足');
  });

  it('三個商品：加總一致、順序穩定（最大餘額法）', () => {
    const C: ProductBasis = { productId: 'C', name: '中間', nsv: 1_000, quantity: 20, orderLines: 15, productCost: null };
    const r = compareAllocations([A, B, C], [{ key: 'S', label: '運費', amount: 1_001 }]);
    for (const m of r.methods.filter((x) => x.usable)) expect(m.allocations.reduce((a, x) => a + x.total, 0)).toBe(1_001);
  });
});
