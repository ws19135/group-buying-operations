import { STATUS_LABEL, type CampaignStatus } from '@/server/workflow/state';
import { ROLE_LABEL, type RoleKey } from '@/server/lib/permissions';

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'primary';
export interface Lab { label: string; tone: Tone }

const m = (o: Record<string, [string, Tone]>): Record<string, Lab> => Object.fromEntries(Object.entries(o).map(([k, [label, tone]]) => [k, { label, tone }]));

export const CAMPAIGN_STATUS: Record<string, Lab> = Object.fromEntries(
  (Object.keys(STATUS_LABEL) as CampaignStatus[]).map((k) => {
    const tone: Tone = k === 'RUNNING' ? 'ok' : k === 'CANCELLED' ? 'danger' : k === 'ON_HOLD' ? 'warn' : k.startsWith('PENDING') ? 'info' : k === 'CLOSED' || k === 'SETTLED' ? 'neutral' : k === 'SCHEDULED' ? 'primary' : 'neutral';
    return [k, { label: STATUS_LABEL[k], tone }];
  }),
);
export const TASK_STATUS = m({ TODO: ['待辦', 'neutral'], IN_PROGRESS: ['進行中', 'info'], BLOCKED: ['已封鎖', 'danger'], WAITING_APPROVAL: ['待核准', 'warn'], DONE: ['已完成', 'ok'], SKIPPED: ['已略過', 'neutral'], CANCELLED: ['已取消', 'neutral'] });
export const VENDOR_STATUS = m({ PROSPECT: ['待開發', 'neutral'], CONTACTED: ['洽談中', 'info'], ACTIVE: ['合作中', 'ok'], PAUSED: ['暫停', 'warn'], BLACKLISTED: ['黑名單', 'danger'] });
export const HOST_STATUS = m({ ACTIVE: ['合作中', 'ok'], PAUSED: ['暫停', 'warn'], ENDED: ['已結束', 'neutral'] });
export const REVIEW_STATUS = m({ DRAFT: ['草稿', 'neutral'], PENDING_REVIEW: ['待審核', 'warn'], APPROVED: ['已通過', 'ok'], REJECTED: ['已退回', 'danger'] });
export const SEVERITY = m({ HIGH: ['高', 'danger'], MEDIUM: ['中', 'warn'], LOW: ['低', 'neutral'] });
export const EXC_STATUS = m({ OPEN: ['未處理', 'danger'], ACKNOWLEDGED: ['已認領', 'warn'], RESOLVED: ['已結案', 'ok'] });
export const APPROVAL_STATUS = m({ PENDING: ['待決定', 'warn'], APPROVED: ['已核准', 'ok'], REJECTED: ['已退回', 'danger'], CANCELLED: ['已取消', 'neutral'] });
export const HOST_PART = m({ INVITED: ['已邀請', 'info'], CONFIRMED: ['已確認', 'ok'], DECLINED: ['已婉拒', 'danger'], NO_RESPONSE: ['未回覆', 'warn'] });
export const PLACEMENT_STATUS = m({ PLANNED: ['已排定', 'info'], DONE: ['已完成', 'ok'], MISSED: ['未執行', 'danger'], CANCELLED: ['已取消', 'neutral'] });
export const IMPORT_STATUS = m({ PROCESSING: ['處理中', 'info'], COMPLETED: ['完成', 'ok'], PARTIAL: ['部分成功', 'warn'], FAILED: ['失敗', 'danger'] });
export const RUN_STATUS = m({ RUNNING: ['執行中', 'info'], SUCCEEDED: ['成功', 'ok'], FAILED: ['失敗', 'danger'], SKIPPED: ['略過', 'neutral'] });
export const INTAKE_STATUS = m({ NEW: ['新進件', 'info'], CREATED: ['已建檔', 'ok'], MATCHED: ['已配對', 'ok'], NEEDS_REVIEW: ['需人工確認', 'warn'], REJECTED: ['已拒絕', 'danger'] });
export const ERR_STATUS = m({ OPEN: ['待處理', 'danger'], RESOLVED: ['已處理', 'ok'], IGNORED: ['已忽略', 'neutral'] });
export const USER_STATUS = m({ ACTIVE: ['啟用', 'ok'], DISABLED: ['停用', 'neutral'] });

export const RECOMMENDATION = m({ RECOMMEND: ['建議合作', 'ok'], REVIEW: ['需人工評估', 'warn'], NOT_RECOMMENDED: ['不建議', 'danger'], BLOCKED: ['硬性條件未過', 'danger'], INSUFFICIENT_DATA: ['資料不足', 'neutral'] });
export const CONFIDENCE = m({ HIGH: ['信心高', 'ok'], MEDIUM: ['信心中', 'info'], LOW: ['信心低', 'warn'], INSUFFICIENT: ['信心不足', 'neutral'] });
export const BASIS = m({ FACT: ['事實', 'ok'], ESTIMATE: ['估計', 'warn'] });
export const REVIEW_DECISION = m({ ACCEPTED: ['同意採用', 'ok'], REJECTED: ['不採用', 'danger'], NEEDS_DATA: ['需補資料', 'warn'] });
export const HARD_RESULT = m({ PASS: ['通過', 'ok'], FAIL: ['未通過', 'danger'], UNKNOWN: ['未知', 'neutral'] });
export const PROFILE_STATUS = m({ NOT_STARTED: ['未建立', 'neutral'], PARTIAL: ['待補資料', 'warn'], COMPLETE: ['完整', 'ok'] });

export const PLATFORM: Record<string, string> = { LINE: 'LINE', FACEBOOK: 'Facebook', INSTAGRAM: 'Instagram', THREADS: 'Threads', YOUTUBE: 'YouTube', OTHER: '其他' };
export const PLACEMENT_TYPE: Record<string, string> = { LAUNCH: '開團公告', POST: '貼文', STORY: '限動', LIVE_TALK: 'Live Talk', TOPIC: '話題', REMINDER: '催單' };
export const ASSET_KIND: Record<string, string> = { IMAGE: '圖片', DOCUMENT: '文件', CERTIFICATE: '證書／報告', LINK: '連結', OTHER: '其他' };
export const AVAIL_KIND: Record<string, string> = { AVAILABLE: '可承接', BLOCKED: '不可承接' };
export const EFFECT: Record<string, Lab> = m({ unchanged: ['不變', 'neutral'], changed: ['日期變動', 'info'], blocked_by_lock: ['已鎖定（不會更動）', 'warn'], done_untouched: ['已完成（不更動）', 'neutral'], newly_applicable: ['改為適用', 'ok'], no_longer_applicable: ['不再適用', 'neutral'] });
export const ROLE_OPTIONS = (Object.keys(ROLE_LABEL) as RoleKey[]).map((k) => ({ value: k, label: ROLE_LABEL[k] }));
export const roleLabel = (r: string): string => ROLE_LABEL[r as RoleKey] ?? r;
export const ownerRoleLabel = (r: string): string => roleLabel(r);
export const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
export const lab = (map: Record<string, Lab>, k: string | null | undefined): Lab => (k ? map[k] ?? { label: k, tone: 'neutral' } : { label: '—', tone: 'neutral' });

export const STATUS_LABEL_MAP: Record<string, string> = STATUS_LABEL;
