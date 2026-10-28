import type { Lab, Tone } from '@/ui/labels';

const m = (o: Record<string, [string, Tone]>): Record<string, Lab> => Object.fromEntries(Object.entries(o).map(([k, [label, tone]]) => [k, { label, tone }]));

export const CASE_STATUS = m({ OPEN: ['新案件', 'danger'], IN_PROGRESS: ['處理中', 'info'], WAITING_VENDOR: ['等待廠商', 'warn'], RESOLVED: ['已解決', 'ok'], CLOSED: ['已結案', 'neutral'], CANCELLED: ['已取消', 'neutral'] });
export const CASE_TYPE: Record<string, string> = { REFUND: '退款', COMPLAINT: '客訴', EXCHANGE: '換貨', OTHER: '其他' };
export const PRIORITY = m({ HIGH: ['高', 'danger'], MEDIUM: ['中', 'warn'], LOW: ['低', 'neutral'] });
export const REFUND_STATUS = m({ REQUESTED: ['待核准', 'warn'], APPROVED: ['已核准（待完成）', 'info'], REJECTED: ['已退回', 'danger'], COMPLETED: ['已完成', 'ok'] });
export const EVENT_TYPE: Record<string, string> = {
  CREATED: '建立案件', STATUS: '狀態變更', NOTE: '備註', ASSIGN: '變更負責人', UPDATE: '更新內容',
  REFUND_REQUESTED: '申請退款', REFUND_APPROVED: '退款核准', REFUND_REJECTED: '退款退回', REFUND_COMPLETED: '退款完成',
};
export const typeOptions = Object.entries(CASE_TYPE).map(([value, label]) => ({ value, label }));
export const priorityOptions = Object.entries(PRIORITY).map(([value, l]) => ({ value, label: l.label }));

export const PII_HINT = '請勿填寫買家的姓名、電話、地址或 Email；買家只用去識別化代號（例如訂單上的 buyer_ref）。系統會擋下明顯的電話與 Email。';
