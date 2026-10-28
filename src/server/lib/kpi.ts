/**
 * KPI 口徑（單一定義，Dashboard SQL 與測試共用）。見 docs/DASHBOARD_SPEC.md。
 *
 * 計入銷售的訂單狀態：PAID、PARTIAL_REFUND、REFUNDED（PENDING 未付款、CANCELLED 已取消不計）
 *   GMV            = Σ 計入訂單的 gross_amount
 *   退款           = Σ 計入訂單的 refund_amount
 *   有效淨銷售額    = GMV − 退款
 *   有效訂單數      = 狀態為 PAID 或 PARTIAL_REFUND 的訂單數（全額退款不算有效訂單）
 *   AOV            = 有效淨銷售額 ÷ 有效訂單數（無有效訂單時為 null）
 *   退款率         = 有退款的訂單數 ÷ 計入銷售的訂單數
 *   達成率         = 有效淨銷售額 ÷ 目標（目標為空或 0 時為 null，不顯示 0%）
 */
export const SALES_STATUSES = ['PAID', 'PARTIAL_REFUND', 'REFUNDED'] as const;
export const EFFECTIVE_ORDER_STATUSES = ['PAID', 'PARTIAL_REFUND'] as const;

export interface OrderLike { status: string; grossAmount: number; refundAmount: number }

export interface SalesTotals {
  gmv: number;
  refund: number;
  net: number;
  orders: number;
  salesOrders: number;
  refundedOrders: number;
  aov: number | null;
  refundRate: number | null;
}

export function computeSales(orders: OrderLike[]): SalesTotals {
  let gmv = 0, refund = 0, effective = 0, sales = 0, refunded = 0;
  for (const o of orders) {
    if (!(SALES_STATUSES as readonly string[]).includes(o.status)) continue;
    sales++;
    gmv += o.grossAmount;
    refund += o.refundAmount;
    if (o.refundAmount > 0) refunded++;
    if ((EFFECTIVE_ORDER_STATUSES as readonly string[]).includes(o.status)) effective++;
  }
  const net = gmv - refund;
  return {
    gmv, refund, net, orders: effective, salesOrders: sales, refundedOrders: refunded,
    aov: effective > 0 ? Math.round(net / effective) : null,
    refundRate: sales > 0 ? refunded / sales : null,
  };
}

export function attainment(net: number, target: number | null | undefined): number | null {
  if (!target || target <= 0) return null;
  return net / target;
}

/** 預估佣金 = 歸因淨銷售額 × 費率（四捨五入到整數元）。沒有費率規則時回傳 null，不猜 */
export function estimateCommission(netAttributed: number, ratePercent: number | null | undefined): number | null {
  if (ratePercent == null) return null;
  return Math.round((netAttributed * ratePercent) / 100);
}

export type DataStatus = 'NO_DATA' | 'DEMO' | 'IMPORT' | 'MIXED';
export function dataStatus(origins: string[]): DataStatus {
  const set = new Set(origins);
  if (set.size === 0) return 'NO_DATA';
  if (set.size === 1) return set.has('DEMO') ? 'DEMO' : 'IMPORT';
  return 'MIXED';
}

export interface SalesAggRow { status: string; n: number; gross: number; refund: number; refundedN: number }

/** 與 computeSales 同口徑，但輸入是資料庫依狀態彙總後的列（大量訂單時不必逐筆載入） */
export function computeSalesFromAgg(rows: SalesAggRow[]): SalesTotals {
  let gmv = 0, refund = 0, effective = 0, sales = 0, refunded = 0;
  for (const r of rows) {
    if (!(SALES_STATUSES as readonly string[]).includes(r.status)) continue;
    sales += r.n; gmv += r.gross; refund += r.refund; refunded += r.refundedN;
    if ((EFFECTIVE_ORDER_STATUSES as readonly string[]).includes(r.status)) effective += r.n;
  }
  const net = gmv - refund;
  return {
    gmv, refund, net, orders: effective, salesOrders: sales, refundedOrders: refunded,
    aov: effective > 0 ? Math.round(net / effective) : null,
    refundRate: sales > 0 ? refunded / sales : null,
  };
}

export interface KpiDef { key: string; label: string; unit: 'TWD' | 'count' | 'percent'; source: string; formula: string }

export const KPI_DEFS: Record<string, KpiDef> = {
  gmv: { key: 'gmv', label: 'GMV', unit: 'TWD', source: 'orders（狀態 PAID／PARTIAL_REFUND／REFUNDED）', formula: 'Σ gross_amount（下單時間落在本期）' },
  refund: { key: 'refund', label: '退款金額', unit: 'TWD', source: 'orders', formula: 'Σ refund_amount（同 GMV 的訂單範圍）' },
  net: { key: 'net', label: '有效淨銷售額', unit: 'TWD', source: 'orders', formula: 'GMV − 退款金額' },
  orders: { key: 'orders', label: '有效訂單數', unit: 'count', source: 'orders', formula: '狀態為 PAID 或 PARTIAL_REFUND 的訂單數' },
  aov: { key: 'aov', label: 'AOV 客單價', unit: 'TWD', source: '衍生', formula: '有效淨銷售額 ÷ 有效訂單數' },
  refundRate: { key: 'refundRate', label: '退款率', unit: 'percent', source: '衍生', formula: '有退款的訂單數 ÷ 計入銷售的訂單數' },
  attainment: { key: 'attainment', label: '目標達成率', unit: 'percent', source: 'orders ÷ campaigns.target_revenue', formula: '與本期重疊且設有目標的檔期：累計有效淨銷售額 ÷ 目標合計' },
  estCommission: { key: 'estCommission', label: '預估佣金', unit: 'TWD', source: 'commission_rules × 歸因淨銷售額', formula: '歸因有效淨銷售額 × 佣金費率（預估，非正式結算）' },
};
