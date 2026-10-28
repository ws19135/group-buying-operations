import { KpiCard } from '@/ui/components';
import { money, num } from '@/ui/format';

export interface AftersalesOverviewV {
  asOf: string;
  totals: { active: number; overdue: number; highPriority: number; resolved: number; closed: number; cancelled: number };
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  byCampaign: { campaignId: string; title: string; active: number; total: number }[];
  refunds: Record<'REQUESTED' | 'APPROVED' | 'REJECTED' | 'COMPLETED', { count: number; amount: number }> | null;
}

/** 售後總覽卡片（可直接嵌進其他頁面，例如儀表板）。資料來自 getAftersalesOverview，沒有資料時顯示 0 而不是假數字 */
export function AftersalesOverviewCards({ o }: { o: AftersalesOverviewV }) {
  return (
    <div className="grid cols-6" style={{ marginBottom: 16 }} data-testid="aftersales-overview">
      <KpiCard id="as-active" label="處理中案件" value={num(o.totals.active)} note={`已解決待結案 ${num(o.totals.resolved)}`} />
      <KpiCard id="as-overdue" label="逾期案件" value={num(o.totals.overdue)} note="到期日已過、尚未解決" tag={o.totals.overdue > 0 ? <span className="badge tone-danger">需處理</span> : undefined} />
      <KpiCard id="as-high" label="高優先案件" value={num(o.totals.highPriority)} note="處理中且優先級為高" />
      {o.refunds ? <>
        <KpiCard id="as-refund-requested" label="待核准退款" value={num(o.refunds.REQUESTED.count)} note={`合計 ${money(o.refunds.REQUESTED.amount)}`} />
        <KpiCard id="as-refund-approved" label="待完成退款" value={num(o.refunds.APPROVED.count)} note={`合計 ${money(o.refunds.APPROVED.amount)}（等財務完成）`} />
      </> : null}
    </div>
  );
}
