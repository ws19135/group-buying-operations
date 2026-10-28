import Link from 'next/link';
import { withActor, type Params } from '@/server/ui/session';
import { getCommunity } from '@/server/modules/hosts';
import { can } from '@/server/lib/permissions';
import { ApiForm } from '@/ui/ApiForm';
import { Badge, Card, EmptyState, PageHeader, StatusBadge, Table } from '@/ui/components';
import { HOST_STATUS, PLACEMENT_STATUS, PLACEMENT_TYPE, PLATFORM } from '@/ui/labels';
import { as } from '@/ui/types';

export const dynamic = 'force-dynamic';
interface C {
  id: string; platform: string; name: string; url: string | null; memberCount: number | null; status: string; note: string | null; version: number;
  hosts: { id: string; displayName: string; role: string }[];
  placements: { id: string; campaignId: string; title: string; placementType: string; scheduledOn: string; status: string }[];
}

export default withActor(async (actor, props: { params: Params }) => {
  const { id } = await props.params;
  const c = as<C>(await getCommunity(actor, id));
  const w = can(actor, 'community.write');
  return (
    <>
      <PageHeader title={<>{c.name} <Badge>{PLATFORM[c.platform] ?? c.platform}</Badge> <StatusBadge map={HOST_STATUS} value={c.status} /></>} sub={c.id} testid="community-header" />
      <div className="grid cols-2">
        <Card title="社群資料" testid="community-info">
          {w ? <ApiForm endpoint={`/api/communities/${c.id}`} method="PATCH" extra={{ version: c.version }} submitLabel="儲存" testid="community-edit-form" fields={[
            { name: 'name', label: '社群名稱', defaultValue: c.name, required: true }, { name: 'platform', label: '平台', type: 'select', required: true, defaultValue: c.platform, options: Object.entries(PLATFORM).map(([value, label]) => ({ value, label })) },
            { name: 'url', label: '連結', type: 'url', defaultValue: c.url }, { name: 'memberCount', label: '成員數', type: 'number', defaultValue: c.memberCount },
            { name: 'status', label: '狀態', type: 'select', required: true, defaultValue: c.status, options: Object.entries(HOST_STATUS).map(([k, l]) => ({ value: k, label: l.label })) }, { name: 'note', label: '備註', type: 'textarea', defaultValue: c.note }]} />
            : <dl className="kv"><dt>連結</dt><dd>{c.url ?? '—'}</dd><dt>成員數</dt><dd>{c.memberCount ?? '—'}</dd></dl>}
        </Card>
        <Card title="團主與管理者" testid="community-hosts">
          {c.hosts.length === 0 ? <EmptyState title="尚無團主" /> : <ul className="list-plain">{c.hosts.map((h) => <li key={h.id}><Link href={`/hosts/${h.id}`}>{h.displayName}</Link> <span className="small muted">{h.role}</span></li>)}</ul>}
        </Card>
      </div>
      <Card title="開團安排與曝光紀錄" flush testid="community-placements">
        {c.placements.length === 0 ? <EmptyState title="尚無曝光安排" /> : (
          <Table head={['日期', '檔期', '形式', '狀態']}>{c.placements.map((p) => <tr key={p.id}><td>{p.scheduledOn}</td><td><Link href={`/campaigns/${p.campaignId}`}>{p.title}</Link></td><td>{PLACEMENT_TYPE[p.placementType] ?? p.placementType}</td><td><StatusBadge map={PLACEMENT_STATUS} value={p.status} /></td></tr>)}</Table>
        )}
      </Card>
    </>
  );
});
