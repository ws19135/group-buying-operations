import type { Lab, Tone } from '@/ui/labels';

const m = (o: Record<string, [string, Tone]>): Record<string, Lab> => Object.fromEntries(Object.entries(o).map(([k, [label, tone]]) => [k, { label, tone }]));

export const SHIPMENT_STATUS = m({
  PENDING: ['待處理', 'neutral'], PACKED: ['已包裝', 'info'], SHIPPED: ['已出貨', 'primary'],
  DELIVERED: ['已送達', 'ok'], EXCEPTION: ['異常', 'danger'], CANCELLED: ['已取消', 'neutral'],
});
export const BATCH_KIND: Record<string, string> = { ORDER: '訂單出貨', SAMPLE: '寄樣' };
export const MOVE_REASON: Record<string, string> = {
  INITIAL: '期初庫存', RESTOCK: '補貨入庫', ADJUST: '盤點調整', DAMAGE: '損耗／報廢', RETURN: '退貨入庫', SHIPPED_OUT: '出貨扣庫', CORRECTION: '更正',
};
export const ADJUST_REASON_OPTIONS = ['INITIAL', 'RESTOCK', 'ADJUST', 'DAMAGE', 'RETURN'].map((k) => ({ value: k, label: MOVE_REASON[k] }));
