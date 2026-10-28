import { describe, expect, it } from 'vitest';
import { attainment, computeSales, computeSalesFromAgg, dataStatus, estimateCommission, type OrderLike, type SalesAggRow } from '@/server/lib/kpi';

const o = (status: string, gross: number, refund = 0): OrderLike => ({ status, grossAmount: gross, refundAmount: refund });

describe('KPI 口徑', () => {
  const orders = [o('PAID', 1000), o('PAID', 500), o('PARTIAL_REFUND', 800, 300), o('REFUNDED', 400, 400), o('PENDING', 999), o('CANCELLED', 777)];

  it('GMV 只含 PAID／PARTIAL_REFUND／REFUNDED；PENDING 與 CANCELLED 不計', () => {
    const s = computeSales(orders);
    expect(s.gmv).toBe(1000 + 500 + 800 + 400);
    expect(s.refund).toBe(300 + 400);
    expect(s.net).toBe(2700 - 700);
  });

  it('有效訂單數不含全額退款；AOV＝淨銷售 ÷ 有效訂單', () => {
    const s = computeSales(orders);
    expect(s.orders).toBe(3);
    expect(s.aov).toBe(Math.round(2000 / 3));
  });

  it('退款率＝有退款訂單 ÷ 計入銷售訂單', () => {
    const s = computeSales(orders);
    expect(s.salesOrders).toBe(4);
    expect(s.refundedOrders).toBe(2);
    expect(s.refundRate).toBe(0.5);
  });

  it('沒有資料時不回傳 0%：AOV／退款率為 null', () => {
    const s = computeSales([]);
    expect(s.aov).toBeNull();
    expect(s.refundRate).toBeNull();
    expect(computeSales([o('PENDING', 100)]).aov).toBeNull();
  });

  it('資料庫彙總版（computeSalesFromAgg）與逐筆版同口徑', () => {
    const agg: SalesAggRow[] = [
      { status: 'PAID', n: 2, gross: 1500, refund: 0, refundedN: 0 },
      { status: 'PARTIAL_REFUND', n: 1, gross: 800, refund: 300, refundedN: 1 },
      { status: 'REFUNDED', n: 1, gross: 400, refund: 400, refundedN: 1 },
      { status: 'PENDING', n: 1, gross: 999, refund: 0, refundedN: 0 },
      { status: 'CANCELLED', n: 1, gross: 777, refund: 0, refundedN: 0 },
    ];
    expect(computeSalesFromAgg(agg)).toEqual(computeSales(orders));
  });

  it('達成率：目標為空或 0 時回傳 null，不假裝 0%', () => {
    expect(attainment(500, 1000)).toBe(0.5);
    expect(attainment(500, null)).toBeNull();
    expect(attainment(500, 0)).toBeNull();
    expect(attainment(1500, 1000)).toBe(1.5);
  });

  it('預估佣金：沒有費率不猜；有費率四捨五入到整數元', () => {
    expect(estimateCommission(1000, null)).toBeNull();
    expect(estimateCommission(1000, 12.5)).toBe(125);
    expect(estimateCommission(999, 10)).toBe(100);
    expect(estimateCommission(0, 10)).toBe(0);
  });

  it('資料狀態：無資料／DEMO／匯入／混合', () => {
    expect(dataStatus([])).toBe('NO_DATA');
    expect(dataStatus(['DEMO', 'DEMO'])).toBe('DEMO');
    expect(dataStatus(['IMPORT'])).toBe('IMPORT');
    expect(dataStatus(['IMPORT', 'DEMO'])).toBe('MIXED');
  });
});
