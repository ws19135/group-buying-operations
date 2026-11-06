import type { Lab, Tone } from '@/ui/labels';

const m = (o: Record<string, [string, Tone]>): Record<string, Lab> =>
  Object.fromEntries(Object.entries(o).map(([k, [label, tone]]) => [k, { label, tone }]));

export const APP_STATUS = m({
  DRAFT: ['草稿', 'neutral'],
  SUBMITTED: ['已送出', 'info'],
  INTERNAL_REVIEW: ['內部審核中', 'info'],
  VENDOR_REVIEW: ['廠商確認中', 'primary'],
  APPROVED: ['已核准供樣', 'ok'],
  REJECTED: ['已退回', 'danger'],
  CANCELLED: ['已取消', 'neutral'],
  ON_HOLD: ['暫緩', 'warn'],
  CLOSED: ['已結案', 'neutral'],
});

export const COLLAB_STATUS = m({
  NOT_STARTED: ['未開始', 'neutral'],
  SAMPLE_IN_PROGRESS: ['樣品進行中', 'info'],
  TRIAL_IN_PROGRESS: ['團主試用中', 'info'],
  AWAITING_INTENT: ['待確認合作', 'warn'],
  COLLABORATION_CONFIRMED: ['已確認合作', 'ok'],
  CAMPAIGN_LINKED: ['已關聯檔期', 'primary'],
  DECLINED: ['不合作', 'neutral'],
});

export const SAMPLE_PROGRESS = m({
  NOT_REQUESTED: ['尚未安排', 'neutral'],
  PREPARING: ['待寄出', 'warn'],
  SHIPPED: ['已寄出', 'primary'],
  DELIVERED: ['已確認收件', 'ok'],
  RESEND_PENDING: ['補寄待寄出', 'warn'],
  RESENT: ['已補寄', 'primary'],
  RETURNED: ['退回', 'danger'],
});

export const SHIP_STATUS = m({
  PENDING: ['待寄出', 'warn'],
  SHIPPED: ['已寄出', 'primary'],
  DELIVERED: ['已送達', 'ok'],
  RETURNED: ['退回', 'danger'],
  CANCELLED: ['已取消', 'neutral'],
});

export const INTENT = m({
  PENDING: ['待回覆', 'warn'],
  WILLING: ['願意開團', 'ok'],
  UNDECIDED: ['再考慮', 'info'],
  UNWILLING: ['不開團', 'neutral'],
});

export const SUPPLY = m({
  PENDING: ['待廠商確認', 'warn'],
  AVAILABLE: ['可供應', 'ok'],
  PARTIAL: ['部分供應', 'info'],
  UNAVAILABLE: ['無法供應', 'danger'],
});

export const ADS_INTENT = m({ PENDING: ['待確認', 'warn'], YES: ['要投廣', 'ok'], NO: ['不投廣', 'neutral'] });
export const ADS_CONFIRM = m({ PENDING: ['待廠商確認', 'warn'], CONFIRMED: ['廠商已確認', 'ok'], DECLINED: ['廠商不提供', 'neutral'] });
export const BACKEND_SETUP = m({
  NOT_REQUIRED: ['不需要', 'neutral'], PENDING: ['待廠商處理', 'warn'],
  REQUESTED: ['已請廠商設定', 'info'], DONE: ['已完成', 'ok'],
});

export const SOURCE: Record<string, string> = {
  OPS: '營運建立', HOST_FORM: '團主填寫', VENDOR_FORM: '廠商代填', IMPORT: '歷史表單匯入',
};
export const SHIPMENT_TYPE: Record<string, string> = { INITIAL: '首次寄送', RESEND: '補寄' };
export const SHIPPED_BY: Record<string, string> = { VENDOR: '廠商寄出', OPS: '營運寄出' };

/** 廠商工作台的七個分桶（與後端 overview 的 bucket 一致） */
export const BUCKET: Record<string, { label: string; hint: string }> = {
  PENDING_INTERNAL_REVIEW: { label: '待內部審核', hint: '營運還沒決定要不要轉給廠商' },
  PENDING_VENDOR_REVIEW: { label: '待審核樣品', hint: '等廠商確認可供應的樣品與數量' },
  TO_SHIP: { label: '待寄出', hint: '已核准供樣，還沒有任何寄送紀錄' },
  SHIPPED: { label: '已寄出', hint: '等團主確認收件' },
  RESEND_PENDING: { label: '待補寄', hint: '已建立補寄紀錄但還沒寄出' },
  AWAITING_HOST_INTENT: { label: '團主待回覆', hint: '樣品已送達，等團主回覆開團意願' },
  TO_LINK_CAMPAIGN: { label: '確認開團', hint: '已確認合作，等營運關聯正式檔期' },
  CAMPAIGN_LINKED: { label: '已建立檔期', hint: '已關聯正式檔期' },
  ON_HOLD: { label: '暫緩', hint: '刻意掛起' },
  CLOSED: { label: '已結束', hint: '退回、取消、結案或不合作' },
  OTHER: { label: '其他', hint: '草稿等尚未進入流程的申請' },
};

/** 廠商工作台的顯示順序（依 Owner 指令的七個分桶，再補上下游兩個） */
export const VENDOR_BUCKET_ORDER = [
  'PENDING_VENDOR_REVIEW', 'TO_SHIP', 'SHIPPED', 'RESEND_PENDING',
  'AWAITING_HOST_INTENT', 'TO_LINK_CAMPAIGN', 'CAMPAIGN_LINKED',
];

export const IMPORT_RESOLUTION = m({
  NEEDS_REVIEW: ['待確認', 'warn'], RESOLVED: ['已對應', 'ok'],
  SKIPPED: ['已跳過', 'neutral'], IMPORTED: ['已建立申請', 'primary'], FAILED: ['失敗', 'danger'],
});

export const opts = (map: Record<string, Lab>) => Object.entries(map).map(([value, v]) => ({ value, label: v.label }));
export const optsOf = (map: Record<string, string>) => Object.entries(map).map(([value, label]) => ({ value, label }));
