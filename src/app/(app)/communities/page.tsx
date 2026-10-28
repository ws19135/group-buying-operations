import Link from 'next/link';
import { withActor, sp1, toQuery, type SP } from '@/server/ui/session';
import { listCommunities } from '@/server/modules/hosts';
import { can } from '@/server/lib/permissions';
import { Badge, Card, EmptyState, Filters, PageHeader, Pagination, StatusBadge, Table } from '@/ui/components';
import { HOST_STATUS, PLATFORM } from '@/ui/labels';
import { num } from '@/ui/format';
import { as, type Paged } from '@/ui/types';

export const dynamic = 'force-dynamic';
interface Row { id: string; platform: string; name: string; url: string | null; memberCount: number | null; status: string; hosts: { id: string; name: string }[] }

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const res = as<Paged<Row>>(await listCommunities(actor, toQuery(q)));
  const base = Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'page'));
  return (
    <>
      <PageHeader title="社群" sub="LINE／Facebook／Instagram 等社群與其團主" actions={can(actor, 'community.write') ? <Link className="btn primary" href="/communities/new" data-testid="btn-create-community">＋ 新增社群</Link> : null} />
      <Filters>
        <label>關鍵字<input name="q" defaultValue={q.q} data-testid="filter-q" /></label>
        <label>平台<select name="platform" defaultValue={q.platform ?? ''}><option value="">全部</option>{Object.entries(PLATFORM).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>狀態<select name="status" defaultValue={q.status ?? ''}><option value="">全部</option>{Object.entries(HOST_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
      </Filters>
      <Card flush testid="community-list">
        {res.items.length === 0 ? <EmptyState title="沒有社群" /> : (
          <Table head={['社群', '平台', '成員數', '團主', '狀態']}>
            {res.items.map((c) => <tr key={c.id} data-testid={`community-row-${c.id}`}><td><Link href={`/communities/${c.id}`}><strong>{c.name}</strong></Link><div className="small muted">{c.id}</div></td><td><Badge>{PLATFORM[c.platform] ?? c.platform}</Badge></td><td className="num">{num(c.memberCount)}</td><td>{c.hosts.map((h) => h.name).join('、') || '—'}</td><td><StatusBadge map={HOST_STATUS} value={c.status} /></td></tr>)}
          </Table>
        )}
        <Pagination total={res.total} limit={res.limit} offset={res.offset} base={base} />
      </Card>
    </>
  );
});
