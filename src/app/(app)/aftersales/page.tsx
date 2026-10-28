import Link from 'next/link';
import { withActor, sp1, toQuery, type SP } from '@/server/ui/session';
import { getAftersalesOverview, listCases } from '@/server/modules/aftersales';
import { can, isInternal } from '@/server/lib/permissions';
import { Badge, Card, EmptyState, Filters, PageHeader, Pagination, StatusBadge, Table } from '@/ui/components';
import { fmtDate } from '@/ui/format';
import { as, type Paged } from '@/ui/types';
import { CASE_STATUS, CASE_TYPE, PRIORITY } from './labels';
import { AftersalesOverviewCards, type AftersalesOverviewV } from './OverviewCards';

export const dynamic = 'force-dynamic';

interface C { id: string; campaignId: string; campaignTitle: string; caseType: string; status: string; priority: string; title: string; assigneeName?: string | null; dueDate: string | null; overdue: boolean; openRefunds?: number; createdAt: string }

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const [overview, list] = await Promise.all([getAftersalesOverview(actor), listCases(actor, toQuery({ status: 'ACTIVE', ...q }))]);
  const o = as<AftersalesOverviewV>(overview);
  const cases = as<Paged<C>>(list);
  const internal = isInternal(actor);
  const base = Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'page'));
  return (
    <>
      <PageHeader title="售後" sub="退款、客訴、換貨案件與退款申請。買家只用去識別化代號，不收姓名、電話、地址"
        actions={<div className="btn-row">
          {internal ? <Link className="btn" href="/aftersales/refunds" data-testid="btn-refund-queue">退款申請</Link> : null}
          {can(actor, 'aftersales.write') ? <Link className="btn primary" href="/aftersales/new" data-testid="btn-new-case">＋ 新增案件</Link> : null}
        </div>} />
      <AftersalesOverviewCards o={o} />
      <Filters>
        <label>狀態<select name="status" defaultValue={q.status ?? 'ACTIVE'} data-testid="filter-status"><option value="ACTIVE">處理中（預設）</option><option value="ALL">全部</option>{Object.entries(CASE_STATUS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}</select></label>
        <label>類型<select name="caseType" defaultValue={q.caseType ?? ''} data-testid="filter-type"><option value="">全部</option>{Object.entries(CASE_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>優先級<select name="priority" defaultValue={q.priority ?? ''} data-testid="filter-priority"><option value="">全部</option>{Object.entries(PRIORITY).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}</select></label>
        <label>搜尋<input name="q" defaultValue={q.q ?? ''} placeholder="標題或案件編號" data-testid="filter-q" /></label>
        {internal ? <label><span>只看我負責的</span><select name="mine" defaultValue={q.mine ?? ''} data-testid="filter-mine"><option value="">否</option><option value="1">是</option></select></label> : null}
        <label><span>只看逾期</span><select name="overdue" defaultValue={q.overdue ?? ''} data-testid="filter-overdue"><option value="">否</option><option value="1">是</option></select></label>
      </Filters>
      <Card flush testid="case-list">
        {cases.items.length === 0 ? <EmptyState title="沒有符合條件的案件" hint={can(actor, 'aftersales.write') ? '可以按右上角「新增案件」建立第一筆' : undefined} /> : (
          <Table head={['案件', '類型', '優先級', '狀態', '檔期', ...(internal ? ['負責人'] : []), '到期日', ...(internal ? ['退款'] : [])]}>
            {cases.items.map((c) => (
              <tr key={c.id} data-testid={`case-row-${c.id}`}>
                <td><Link href={`/aftersales/${c.id}`}><strong>{c.title}</strong></Link><div className="small muted">{c.id}</div></td>
                <td>{CASE_TYPE[c.caseType] ?? c.caseType}</td>
                <td><StatusBadge map={PRIORITY} value={c.priority} /></td>
                <td><StatusBadge map={CASE_STATUS} value={c.status} /></td>
                <td><Link href={`/campaigns/${c.campaignId}`}>{c.campaignTitle}</Link></td>
                {internal ? <td>{c.assigneeName ?? '—'}</td> : null}
                <td>{fmtDate(c.dueDate) || '—'} {c.overdue ? <Badge tone="danger">逾期</Badge> : null}</td>
                {internal ? <td>{c.openRefunds ? <Badge tone="warn">{c.openRefunds} 筆未完成</Badge> : '—'}</td> : null}
              </tr>
            ))}
          </Table>
        )}
        <Pagination total={cases.total} limit={cases.limit} offset={cases.offset} base={base} />
      </Card>
    </>
  );
});
