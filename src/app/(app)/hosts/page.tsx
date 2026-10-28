import Link from 'next/link';
import { withActor, sp1, toQuery, type SP } from '@/server/ui/session';
import { listHosts } from '@/server/modules/hosts';
import { can } from '@/server/lib/permissions';
import { Card, EmptyState, Filters, PageHeader, Pagination, StatusBadge, Table } from '@/ui/components';
import { HOST_STATUS } from '@/ui/labels';
import { as, type Paged } from '@/ui/types';

export const dynamic = 'force-dynamic';
interface Row { id: string; displayName: string; status: string; contactEmail: string | null; lineId: string | null; communityCount: number; campaignCount: number }

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const res = as<Paged<Row>>(await listHosts(actor, toQuery(q)));
  const base = Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'page'));
  return (
    <>
      <PageHeader title="團主" sub="團主資料、所屬社群、可承接檔期與歷史團購" actions={can(actor, 'host.write') ? <Link className="btn primary" href="/hosts/new" data-testid="btn-create-host">＋ 新增團主</Link> : null} />
      <Filters>
        <label>關鍵字<input name="q" defaultValue={q.q} data-testid="filter-q" /></label>
        <label>狀態<select name="status" defaultValue={q.status ?? ''}><option value="">全部</option>{Object.entries(HOST_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
      </Filters>
      <Card flush testid="host-list">
        {res.items.length === 0 ? <EmptyState title="沒有團主" /> : (
          <Table head={['團主', '狀態', '聯絡方式', '社群數', '參與檔期']}>
            {res.items.map((h) => <tr key={h.id} data-testid={`host-row-${h.id}`}><td><Link href={`/hosts/${h.id}`}><strong>{h.displayName}</strong></Link><div className="small muted">{h.id}</div></td><td><StatusBadge map={HOST_STATUS} value={h.status} /></td><td className="small">{h.contactEmail ?? ''} {h.lineId ?? ''}</td><td>{h.communityCount}</td><td>{h.campaignCount}</td></tr>)}
          </Table>
        )}
        <Pagination total={res.total} limit={res.limit} offset={res.offset} base={base} />
      </Card>
    </>
  );
});
