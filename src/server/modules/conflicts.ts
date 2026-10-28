import type { Queryable } from '../lib/db';

export interface Conflict {
  type: 'SAME_PRODUCT_OVERLAP' | 'COMMUNITY_OVERLAP' | 'HOST_OVERLAP' | 'HOST_BLOCKED' | 'HOST_NOT_AVAILABLE_WINDOW';
  severity: 'HIGH' | 'MEDIUM';
  message: string;
  otherCampaignId?: string;
  otherTitle?: string;
}

const ACTIVE_STATUSES = `('DRAFT','EVALUATING','PENDING_G1','PREPARING','PENDING_G2','SCHEDULED','RUNNING','PENDING_CLOSE_CHECK')`;
/** 一位團主同時進行的檔期超過這個數量才提醒（可日後改成設定） */
const HOST_CONCURRENT_LIMIT = 2;

/**
 * 檔期衝突偵測（只提醒，不寫入）。
 * - 同商品、日期重疊：HIGH（同一商品重複開團，需確認是否刻意）
 * - 同社群、日期重疊（兩邊都有曝光安排）：HIGH
 * - 團主在「不可承接」區間內：HIGH
 * - 團主同時進行檔期超過上限：MEDIUM
 * 日期缺漏時不做判斷（資料不足不亂報）。
 */
export async function detectConflicts(db: Queryable, orgId: string, campaignId: string): Promise<Conflict[]> {
  const cr = await db.query<{ open_date: string | null; close_date: string | null }>(
    'SELECT open_date, close_date FROM campaigns WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [campaignId, orgId]);
  const c = cr.rows[0];
  if (!c || !c.open_date || !c.close_date) return [];
  const out: Conflict[] = [];
  const overlap = `o.open_date <= $3::date AND o.close_date >= $2::date AND o.open_date IS NOT NULL AND o.close_date IS NOT NULL`;

  const sameProduct = await db.query<{ id: string; title: string; pname: string }>(
    `SELECT DISTINCT o.id, o.title, p.name AS pname
     FROM campaign_products mine
     JOIN campaign_products theirs ON theirs.product_id = mine.product_id AND theirs.campaign_id <> mine.campaign_id AND theirs.deleted_at IS NULL
     JOIN campaigns o ON o.id = theirs.campaign_id AND o.deleted_at IS NULL AND o.status IN ${ACTIVE_STATUSES} AND o.organization_id=$4
     JOIN products p ON p.id = mine.product_id
     WHERE mine.campaign_id=$1 AND mine.deleted_at IS NULL AND ${overlap}`,
    [campaignId, c.open_date, c.close_date, orgId]);
  for (const r of sameProduct.rows) out.push({ type: 'SAME_PRODUCT_OVERLAP', severity: 'HIGH', otherCampaignId: r.id, otherTitle: r.title,
    message: `商品「${r.pname}」與檔期 ${r.id}（${r.title}）日期重疊` });

  const sameComm = await db.query<{ id: string; title: string; cname: string }>(
    `SELECT DISTINCT o.id, o.title, cm.name AS cname
     FROM campaign_placements mine
     JOIN campaign_placements theirs ON theirs.community_id = mine.community_id AND theirs.campaign_id <> mine.campaign_id
       AND theirs.deleted_at IS NULL AND theirs.status <> 'CANCELLED'
     JOIN campaigns o ON o.id = theirs.campaign_id AND o.deleted_at IS NULL AND o.status IN ${ACTIVE_STATUSES} AND o.organization_id=$4
     JOIN communities cm ON cm.id = mine.community_id
     WHERE mine.campaign_id=$1 AND mine.deleted_at IS NULL AND mine.status <> 'CANCELLED' AND ${overlap}`,
    [campaignId, c.open_date, c.close_date, orgId]);
  for (const r of sameComm.rows) out.push({ type: 'COMMUNITY_OVERLAP', severity: 'HIGH', otherCampaignId: r.id, otherTitle: r.title,
    message: `社群「${r.cname}」同期還有檔期 ${r.id}（${r.title}）` });

  const blocked = await db.query<{ host: string; start_date: string; end_date: string }>(
    `SELECT h.display_name AS host, a.start_date, a.end_date
     FROM campaign_hosts ch JOIN hosts h ON h.id = ch.host_id
     JOIN host_availability a ON a.host_id = ch.host_id AND a.deleted_at IS NULL AND a.kind='BLOCKED'
       AND a.start_date <= $3::date AND a.end_date >= $2::date
     WHERE ch.campaign_id=$1 AND ch.deleted_at IS NULL AND ch.status <> 'DECLINED'`,
    [campaignId, c.open_date, c.close_date]);
  for (const r of blocked.rows) out.push({ type: 'HOST_BLOCKED', severity: 'HIGH',
    message: `團主「${r.host}」在 ${r.start_date}～${r.end_date} 標示為不可承接` });

  const busy = await db.query<{ host: string; n: number }>(
    `SELECT h.display_name AS host, count(DISTINCT o.id)::int AS n
     FROM campaign_hosts mine JOIN hosts h ON h.id = mine.host_id
     JOIN campaign_hosts theirs ON theirs.host_id = mine.host_id AND theirs.campaign_id <> mine.campaign_id AND theirs.deleted_at IS NULL AND theirs.status <> 'DECLINED'
     JOIN campaigns o ON o.id = theirs.campaign_id AND o.deleted_at IS NULL AND o.status IN ${ACTIVE_STATUSES} AND o.organization_id=$4
     WHERE mine.campaign_id=$1 AND mine.deleted_at IS NULL AND mine.status <> 'DECLINED' AND ${overlap}
     GROUP BY h.display_name HAVING count(DISTINCT o.id) >= $5`,
    [campaignId, c.open_date, c.close_date, orgId, HOST_CONCURRENT_LIMIT]);
  for (const r of busy.rows) out.push({ type: 'HOST_OVERLAP', severity: 'MEDIUM',
    message: `團主「${r.host}」同期還有 ${r.n} 檔進行中／籌備中的團購` });
  return out;
}
