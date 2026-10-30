import type { StepDef } from './schedule';

/**
 * 預設模板 GROUPBUY_STANDARD v1
 * 來源：groupbuy-flow-sop 的 11 步作業 + 藍圖 G1–G5 Gate，依 ADR-004 映射成 ERP 八階段。
 * 天數預設值取自 SOP 的「設定」分頁：寄送 7、試用 14、回饋 3、回收 7、圖文 7、結算 14、請款 14。
 */
export const DEFAULT_TEMPLATE_KEY = 'GROUPBUY_STANDARD';

export const DEFAULT_PARAMS = {
  ship_days: 7,
  trial_days: 14,
  feedback_days: 3,
  recovery_days: 7,
  design_days: 7,
  settle_days: 14,
  invoice_days: 14,
};

export const PHASES: Record<number, string> = {
  1: '籌備與寄樣',
  2: '試用與回饋',
  3: '開團審核',
  4: '素材與賣場準備',
  5: '開團與曝光',
  6: '銷售與催單',
  7: '結單與請款',
  8: '復盤與結案',
};

export const DEFAULT_STEPS: StepDef[] = [
  { stepKey: 'SAMPLE_SHIP', seq: 1, name: '廠商寄樣', phase: 1, ownerRole: 'VENDOR', kind: 'TASK', gateKey: null,
    startRule: { type: 'campaign_field', field: 'sample_ready_date', offset: 0 }, duration: { type: 'param', key: 'ship_days', default: 7 },
    dependsOn: [], optional: false, conditionKey: null, description: '廠商於試用品可寄出日起寄出公關品（SOP（標準作業流程）步驟 1）' },
  { stepKey: 'TRIAL_ARRIVAL', seq: 2, name: '試用品到貨與試用', phase: 2, ownerRole: 'HOST', kind: 'TASK', gateKey: null,
    startRule: { type: 'after', dep: 'SAMPLE_SHIP', offset: 1 }, duration: { type: 'param', key: 'trial_days', default: 14 },
    dependsOn: ['SAMPLE_SHIP'], optional: false, conditionKey: null, description: '團主收到試用品並試用（SOP（標準作業流程）步驟 2）' },
  { stepKey: 'TRIAL_FEEDBACK', seq: 3, name: '團主試用回饋・確認是否開團', phase: 2, ownerRole: 'HOST', kind: 'TASK', gateKey: null,
    startRule: { type: 'after', dep: 'TRIAL_ARRIVAL', offset: 1 }, duration: { type: 'param', key: 'feedback_days', default: 3 },
    dependsOn: ['TRIAL_ARRIVAL'], optional: false, conditionKey: null, description: '整條流程的生死關：團主未回覆會讓後續全部停住（SOP（標準作業流程）步驟 3）' },
  { stepKey: 'LAUNCH_APPROVAL', seq: 4, name: '開團審核（G1 選品核准）', phase: 3, ownerRole: 'OPS_MANAGER', kind: 'GATE', gateKey: 'G1',
    startRule: { type: 'after', dep: 'TRIAL_FEEDBACK', offset: 1 }, duration: { type: 'fixed', days: 1 },
    dependsOn: ['TRIAL_FEEDBACK'], optional: false, conditionKey: null, description: '依試用回饋決定是否開團' },
  { stepKey: 'SAMPLE_RECOVERY', seq: 5, name: '試用品回收', phase: 3, ownerRole: 'VENDOR', kind: 'TASK', gateKey: null,
    startRule: { type: 'after', dep: 'TRIAL_FEEDBACK', offset: 1 }, duration: { type: 'param', key: 'recovery_days', default: 7 },
    dependsOn: ['TRIAL_FEEDBACK'], optional: true, conditionKey: 'needs_sample_recovery', description: '只有需要回收試用品的廠商才會出現（SOP（標準作業流程）步驟 4）' },
  { stepKey: 'CREATIVE_ASSETS', seq: 6, name: '圖文素材準備', phase: 4, ownerRole: 'OPS_EDITOR', kind: 'TASK', gateKey: null,
    startRule: { type: 'after', dep: 'LAUNCH_APPROVAL', offset: 1 }, duration: { type: 'param', key: 'design_days', default: 7 },
    dependsOn: ['LAUNCH_APPROVAL'], optional: false, conditionKey: null, description: '確認開團後準備團購圖文與賣場素材（SOP（標準作業流程）步驟 5）' },
  { stepKey: 'PRELAUNCH_CHECK', seq: 7, name: '開團前檢查（G2 開團核准）', phase: 4, ownerRole: 'OPS_MANAGER', kind: 'GATE', gateKey: 'G2',
    startRule: { type: 'campaign_field', field: 'open_date', offset: -1 }, duration: { type: 'fixed', days: 1 },
    dependsOn: ['CREATIVE_ASSETS'], optional: false, conditionKey: null, description: '合約、價格、素材、連結與曝光安排檢查' },
  { stepKey: 'LAUNCH', seq: 8, name: '正式開團・群組內曝光', phase: 5, ownerRole: 'OPS_EDITOR', kind: 'TASK', gateKey: null,
    startRule: { type: 'campaign_field', field: 'open_date', offset: 0 }, duration: { type: 'fixed', days: 1 },
    dependsOn: ['PRELAUNCH_CHECK'], optional: false, conditionKey: null, description: '於開團日在群組內公告（SOP（標準作業流程）步驟 6）' },
  { stepKey: 'LIVE_TALK', seq: 9, name: 'Live Talk（選擇性）', phase: 5, ownerRole: 'HOST', kind: 'TASK', gateKey: null,
    startRule: { type: 'campaign_field', field: 'live_talk_date', offset: 0 }, duration: { type: 'fixed', days: 1 },
    dependsOn: [], optional: true, conditionKey: 'has_live_talk', description: '有排 Live Talk 日期才會出現（SOP（標準作業流程）步驟 7）' },
  { stepKey: 'TOPIC_PROMO', seq: 10, name: '社群話題曝光', phase: 5, ownerRole: 'OPS_EDITOR', kind: 'TASK', gateKey: null,
    startRule: { type: 'campaign_field', field: 'open_date', offset: 2 }, duration: { type: 'fixed', days: 1 },
    dependsOn: [], optional: false, conditionKey: null, description: '開團後 2 天開話題聊商品（SOP（標準作業流程）步驟 8）' },
  { stepKey: 'CLOSING_REMINDER', seq: 11, name: '結團前催單', phase: 6, ownerRole: 'OPS_EDITOR', kind: 'TASK', gateKey: null,
    startRule: { type: 'campaign_field', field: 'close_date', offset: -1 }, duration: { type: 'fixed', days: 1 },
    dependsOn: [], optional: false, conditionKey: null, description: '結團前一天催單（SOP（標準作業流程）步驟 9）' },
  { stepKey: 'CLOSE_CONFIRM', seq: 12, name: '結單核對（G3 結單確認）', phase: 7, ownerRole: 'OPS_MANAGER', kind: 'GATE', gateKey: 'G3',
    startRule: { type: 'campaign_field', field: 'close_date', offset: 1 }, duration: { type: 'fixed', days: 1 },
    dependsOn: [], optional: false, conditionKey: null, description: '核對有效訂單、付款與取消，確認後才進入履約' },
  { stepKey: 'VENDOR_SETTLE', seq: 13, name: '廠商後台報表結算', phase: 7, ownerRole: 'OPS_EDITOR', kind: 'TASK', gateKey: null,
    startRule: { type: 'campaign_field', field: 'close_date', offset: 1 }, duration: { type: 'param', key: 'settle_days', default: 14 },
    dependsOn: [], optional: false, conditionKey: null, description: '結團後向廠商取得後台報表並結算（SOP（標準作業流程）步驟 10）' },
  { stepKey: 'INVOICE_REQUEST', seq: 14, name: '開發票請款', phase: 7, ownerRole: 'OPS_EDITOR', kind: 'TASK', gateKey: null,
    startRule: { type: 'after', dep: 'VENDOR_SETTLE', offset: 1 }, duration: { type: 'param', key: 'invoice_days', default: 14 },
    dependsOn: ['VENDOR_SETTLE'], optional: false, conditionKey: null, description: '結算後開發票請款（SOP（標準作業流程）步驟 11；實際入帳與分潤屬第二階段（Phase 2））' },
  { stepKey: 'CLOSURE_REVIEW', seq: 15, name: '復盤與結案（G5 結案核准）', phase: 8, ownerRole: 'OPS_MANAGER', kind: 'GATE', gateKey: 'G5',
    startRule: { type: 'after', dep: 'INVOICE_REQUEST', offset: 1 }, duration: { type: 'fixed', days: 1 },
    dependsOn: ['INVOICE_REQUEST'], optional: false, conditionKey: null, description: '確認無未結客訴與款項後結案' },
];
