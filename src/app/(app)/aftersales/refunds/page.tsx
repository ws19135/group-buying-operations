import Link from 'next/link';
import { withActor, sp1, toQuery, type SP } from '@/server/ui/session';
import { listRefunds } from '@/server/modules/aftersales';
import { can } from '@/server/lib/permissions';
import { Card, EmptyState, Filters, PageHeader, Pagination, StatusBadge, Table } from '@/ui/components';
import { fmtDateTime, money } from '@/ui/format';
import { as, type Paged } from '@/ui/types';
import { REFUND_STATUS } from '../labels';
import { RefundActions } from '../RefundActions';

export const dynamic = 'force-dynamic';
interface R { id: string; caseId: string; caseTitle: string; campaignTitle: string; orderId: string | null; amount: number; reason: string; status: string; requestedByName: string | null; decisionNote: string | null; writebackApplied: boolean; createdAt: string }

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const sel = q.status ?? 'PENDING';
  const query = sel === 'PENDING' ? { ...q, pending: '1' } : sel === 'ALL' ? { ...q, status: '' } : q;
  const res = as<Paged<R>>(await listRefunds(actor, toQuery(Object.fromEntries(Object.entries(query).filter(([, v]) => v !== '')))));
  const base = Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'page'));
  return (
    <>
      <PageHeader title="退款申請" sub="由營運主管核准，核准後由財務在實際退款完成後標記完成" actions={<Link className="btn" href="/aftersales">回售後案件</Link>} />
      <Filters>
        <label>狀態<select name="status" defaultValue={sel} data-testid="filter-status"><option value="PENDING">待處理（待核准＋待完成）</option><option value="ALL">全部</option>{Object.entries(REFUND_STATUS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}</select></label>
      </Filters>
      <Card flush testid="refund-list">
        {res.items.length === 0 ? <EmptyState title="沒有符合條件的退款申請" /> : (
          <Table head={['申請', '案件', '金額', '原因', '狀態', '']}>
            {res.items.map((r) => (
              <tr key={r.id} data-testid={`refund-row-${r.id}`}>
                <td>{r.id}<div className="small muted">{r.requestedByName ?? ''} {fmtDateTime(r.createdAt)}</div></td>
                <td><Link href={`/aftersales/${r.caseId}`}>{r.caseTitle}</Link><div className="small muted">{r.campaignTitle}</div></td>
                <td>{money(r.amount)}{r.orderId ? <div className="small muted">{r.orderId}</div> : null}</td>
                <td>{r.reason}{r.decisionNote ? <div className="small muted">決定：{r.decisionNote}</div> : null}</td>
                <td><StatusBadge map={REFUND_STATUS} value={r.status} />{r.writebackApplied ? <div className="small muted">已寫回訂單</div> : null}</td>
                <td><RefundActions id={r.id} status={r.status} hasOrder={!!r.orderId} canApprove={can(actor, 'refund.approve')} canComplete={can(actor, 'refund.complete')} /></td>
              </tr>
            ))}
          </Table>
        )}
        <Pagination total={res.total} limit={res.limit} offset={res.offset} base={base} />
      </Card>
    </>
  );
});
