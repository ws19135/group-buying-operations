import Link from 'next/link';
import { withActor, sp1, toQuery, type SP } from '@/server/ui/session';
import { listCampaigns } from '@/server/modules/campaigns';
import { can } from '@/server/lib/permissions';
import { vendorOptions, hostOptions } from '@/server/ui/options';
import { Badge, EmptyState, Filters, PageHeader, Pagination, ProgressBar, StatusBadge, Table, Card } from '@/ui/components';
import { CAMPAIGN_STATUS, HOST_PART } from '@/ui/labels';
import { as, type Paged } from '@/ui/types';
import { STATUS_LABEL } from '@/server/workflow/state';

export const dynamic = 'force-dynamic';

interface Row { id: string; title: string; status: string; vendorId: string; vendorName: string; openDate: string | null; closeDate: string | null; ownerName: string | null; hosts: { hostId: string; name: string; status: string }[]; taskTotal: number; taskDone: number; overdueCount: number }

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const [res, vendors, hosts] = await Promise.all([
    listCampaigns(actor, toQuery(q)).then((r) => as<Paged<Row>>(r)), vendorOptions(actor), hostOptions(actor),
  ]);
  const base = Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'page'));
  return (
    <>
      <PageHeader title="檔期" sub="每一檔團購一個主檔；狀態、任務與核准都在這裡追蹤" actions={can(actor, 'campaign.write') ? <Link className="btn primary" href="/campaigns/new" data-testid="btn-create-campaign">＋ 建立檔期</Link> : null} />
      <Filters>
        <label>關鍵字<input name="q" defaultValue={q.q} placeholder="名稱或編號（ID）" data-testid="filter-q" /></label>
        <label>狀態<select name="status" defaultValue={q.status ?? ''} data-testid="filter-status"><option value="">全部</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        {vendors.length > 1 ? <label>廠商<select name="vendorId" defaultValue={q.vendorId ?? ''}><option value="">全部</option>{vendors.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}</select></label> : null}
        {hosts.length ? <label>團主<select name="hostId" defaultValue={q.hostId ?? ''}><option value="">全部</option>{hosts.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}</select></label> : null}
        <label>期間起<input type="date" name="from" defaultValue={q.from} /></label>
        <label>期間迄<input type="date" name="to" defaultValue={q.to} /></label>
        <label><input type="checkbox" name="active" value="1" defaultChecked={q.active === '1'} /> 只看未結案</label>
        {can(actor, 'campaign.write') ? <label><input type="checkbox" name="mine" value="1" defaultChecked={q.mine === '1'} /> 我負責的</label> : null}
      </Filters>
      <Card flush testid="campaign-list">
        {res.items.length === 0 ? <EmptyState title="沒有符合條件的檔期" hint={can(actor, 'campaign.write') ? <Link href="/campaigns/new">建立第一檔團購</Link> : undefined} /> : (
          <Table head={['檔期', '狀態', '廠商', '期間', '負責人', '團主', '任務進度', '逾期']} testid="campaigns-table">
            {res.items.map((c) => (
              <tr key={c.id} data-testid={`campaign-row-${c.id}`}>
                <td><Link href={`/campaigns/${c.id}`} data-testid={`campaign-link-${c.id}`}><strong>{c.title}</strong></Link><div className="small muted">{c.id}</div></td>
                <td><StatusBadge map={CAMPAIGN_STATUS} value={c.status} /></td>
                <td>{c.vendorName}</td>
                <td className="nowrap">{c.openDate ?? '未定'} ～ {c.closeDate ?? '未定'}</td>
                <td>{c.ownerName ?? <span className="muted">—</span>}</td>
                <td>{c.hosts.length ? c.hosts.map((h) => <div key={h.hostId} className="small">{h.name} <StatusBadge map={HOST_PART} value={h.status} /></div>) : <span className="muted">—</span>}</td>
                <td style={{ minWidth: 120 }}><ProgressBar value={c.taskDone} total={c.taskTotal} danger={c.overdueCount > 0} /></td>
                <td>{c.overdueCount ? <Badge tone="danger">{c.overdueCount}</Badge> : '—'}</td>
              </tr>
            ))}
          </Table>
        )}
        <Pagination total={res.total} limit={res.limit} offset={res.offset} base={base} />
      </Card>
    </>
  );
});
