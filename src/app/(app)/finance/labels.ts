import type { Lab, Tone } from '@/ui/labels';

const m = (o: Record<string, [string, Tone]>): Record<string, Lab> => Object.fromEntries(Object.entries(o).map(([k, [label, tone]]) => [k, { label, tone }]));

export const FINANCE_NOTICE = '試算，口徑待 Owner 確認；非正式付款依據';
export const SETTLEMENT_STATUS = m({ DRAFT: ['試算草稿', 'info'], CONFIRMED: ['已確認', 'ok'], VOID: ['已作廢', 'neutral'] });
export const MATCH_STATUS = m({ UNMATCHED: ['未核對', 'warn'], MATCHED: ['已核對', 'ok'] });
export const PAY_STATUS = m({ ACTIVE: ['有效', 'ok'], VOID: ['已作廢', 'neutral'] });
export const INVOICE_STATUS = m({ DRAFT: ['草稿', 'info'], ISSUED: ['已開立', 'ok'], VOID: ['已作廢', 'neutral'] });
export const EXPENSE_STATUS = m({ RECORDED: ['已記錄', 'ok'], VOID: ['已作廢', 'neutral'] });
export const DIRECTION: Record<string, string> = { IN: '收入（入帳）', OUT: '支出（付款）' };
export const COUNTERPARTY: Record<string, string> = { VENDOR: '廠商', HOST: '團主', PLATFORM: '平台' };
export const EXPENSE_CATEGORY: Record<string, string> = { SHIPPING: '運費', MARKETING: '行銷', SAMPLE: '樣品', PLATFORM_FEE: '平台費用', OTHER: '其他' };
export const DATA_STATUS: Record<string, string> = { NO_DATA: '無訂單資料', DEMO: 'DEMO 示範資料', IMPORT: 'CSV 匯入', MIXED: 'DEMO 與匯入混合' };
export const toOptions = (o: Record<string, string>) => Object.entries(o).map(([value, label]) => ({ value, label }));
