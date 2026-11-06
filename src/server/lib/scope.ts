import type { Actor } from './permissions';
import { isInternal } from './permissions';

/**
 * 資料範圍：回傳「這位使用者可以看到哪些 campaigns」的 SQL 條件（別名 c）與參數。
 * 所有 Campaign 相關查詢都必須經過這裡，避免只靠前端隱藏。
 *
 * - SYSTEM_ADMIN / OPS_MANAGER / FINANCE：整個組織
 * - OPS_EDITOR：自己負責，或被指派任務的檔期（藍圖：營運 PM 只看自己負責的檔期）
 * - HOST：自己被邀請（未退出）的檔期
 * - VENDOR：自己廠商的檔期
 */
export function campaignScope(actor: Actor, startIndex: number, alias = 'c'): { sql: string; params: unknown[] } {
  const org = `${alias}.organization_id = $${startIndex}`;
  const live = `${alias}.deleted_at IS NULL`;
  const params: unknown[] = [actor.orgId];
  switch (actor.role) {
    case 'SYSTEM_ADMIN':
    case 'OPS_MANAGER':
    case 'FINANCE':
      return { sql: `${org} AND ${live}`, params };
    case 'OPS_EDITOR':
      params.push(actor.userId);
      return {
        sql: `${org} AND ${live} AND (${alias}.owner_user_id = $${startIndex + 1} OR EXISTS (
          SELECT 1 FROM tasks t WHERE t.campaign_id = ${alias}.id AND t.assignee_user_id = $${startIndex + 1}))`,
        params,
      };
    case 'HOST':
      if (!actor.hostIds.length) return { sql: 'FALSE', params: [] };
      params.push(actor.hostIds);
      return {
        sql: `${org} AND ${live} AND EXISTS (SELECT 1 FROM campaign_hosts ch WHERE ch.campaign_id = ${alias}.id
          AND ch.host_id = ANY($${startIndex + 1}::text[]) AND ch.deleted_at IS NULL AND ch.status <> 'DECLINED')`,
        params,
      };
    case 'VENDOR':
      if (!actor.vendorIds.length) return { sql: 'FALSE', params: [] };
      params.push(actor.vendorIds);
      return { sql: `${org} AND ${live} AND ${alias}.vendor_id = ANY($${startIndex + 1}::text[])`, params };
    default:
      return { sql: 'FALSE', params: [] };
  }
}

/**
 * 資料範圍：合作申請（COLLABORATION_APPLICATIONS）。別名預設 a。
 * 所有合作申請查詢都必須經過這裡，不可只靠前端隱藏按鈕。
 *
 * - SYSTEM_ADMIN / OPS_MANAGER / OPS_EDITOR：整個組織
 *   （與 campaignScope 刻意不同：合作申請是共用工作佇列，營運小編要能追蹤寄送、協調廠商與團主；
 *    需核准權限的決策另由 collaboration.review 限制，收件個資另由 collaboration.pii.read 限制）
 * - HOST：只有自己的申請
 * - VENDOR：只有自己廠商的申請
 * - FINANCE：看不到（第一階段不開放樣品申請管理權限）
 */
export function collaborationScope(actor: Actor, startIndex: number, alias = 'a'): { sql: string; params: unknown[] } {
  const org = `${alias}.organization_id = $${startIndex}`;
  const live = `${alias}.deleted_at IS NULL`;
  const params: unknown[] = [actor.orgId];
  switch (actor.role) {
    case 'SYSTEM_ADMIN':
    case 'OPS_MANAGER':
    case 'OPS_EDITOR':
      return { sql: `${org} AND ${live}`, params };
    case 'HOST':
      if (!actor.hostIds.length) return { sql: 'FALSE', params: [] };
      params.push(actor.hostIds);
      return { sql: `${org} AND ${live} AND ${alias}.host_id = ANY($${startIndex + 1}::text[])`, params };
    case 'VENDOR':
      if (!actor.vendorIds.length) return { sql: 'FALSE', params: [] };
      params.push(actor.vendorIds);
      return { sql: `${org} AND ${live} AND ${alias}.vendor_id = ANY($${startIndex + 1}::text[])`, params };
    default:
      return { sql: 'FALSE', params: [] };
  }
}

export const sees = {
  /** 是否看得到內部欄位（目標、內部備註、全部團主） */
  campaignInternals: (a: Actor) => isInternal(a),
};
