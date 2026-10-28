import Link from 'next/link';
import { withActor, type Params } from '@/server/ui/session';
import { getHost } from '@/server/modules/hosts';
import { can } from '@/server/lib/permissions';
import { communityOptions } from '@/server/ui/options';
import { ActionButton } from '@/ui/ActionButton';
import { ApiForm } from '@/ui/ApiForm';
import { Modal } from '@/ui/Modal';
import { Badge, Card, EmptyState, PageHeader, StatusBadge, Table } from '@/ui/components';
import { AVAIL_KIND, CAMPAIGN_STATUS, HOST_PART, HOST_STATUS, PLATFORM } from '@/ui/labels';
import { as } from '@/ui/types';

export const dynamic = 'force-dynamic';

interface H {
  id: string; displayName: string; legalName: string | null; contactEmail: string | null; contactPhone: string | null; lineId: string | null; status: string; audienceNote: string | null; cooperationTerms: string | null; internalNote?: string | null; version: number;
  communities: { id: string; platform: string; name: string; status: string; role: string }[];
  availability: { id: string; startDate: string; endDate: string; kind: string; note: string | null }[];
  history: { id: string; title: string; status: string; openDate: string | null; closeDate: string | null; participationStatus: string; role: string }[];
}

export default withActor(async (actor, props: { params: Params }) => {
  const { id } = await props.params;
  const h = as<H>(await getHost(actor, id));
  const w = can(actor, 'host.write');
  const cw = can(actor, 'community.write');
  const allComm = cw ? (await communityOptions(actor)).filter((o) => !h.communities.some((c) => c.id === o.value.split('|')[0])) : [];
  return (
    <>
      <PageHeader title={<>{h.displayName} <StatusBadge map={HOST_STATUS} value={h.status} /></>} sub={h.id} testid="host-header"
        actions={w ? <div className="btn-row"><Link className="btn" href={`/dashboard/host?hostId=${h.id}`} data-testid="btn-host-preview">以團主視角預覽</Link><ActionButton endpoint={`/api/hosts/${h.id}/archive`} label="封存團主" variant="danger" reasonLabel="封存原因" confirm="仍參與未結案檔期時無法封存。" redirectTo="/hosts" testid="btn-archive-host" /></div> : undefined} />
      <div className="grid cols-2">
        <Card title="基本資料" testid="host-info">
          {w ? <ApiForm endpoint={`/api/hosts/${h.id}`} method="PATCH" extra={{ version: h.version }} submitLabel="儲存" testid="host-edit-form" fields={[
            { name: 'displayName', label: '團主名稱', defaultValue: h.displayName, required: true }, { name: 'legalName', label: '法定名稱', defaultValue: h.legalName },
            { name: 'contactEmail', label: 'Email', type: 'email', defaultValue: h.contactEmail }, { name: 'contactPhone', label: '電話', defaultValue: h.contactPhone }, { name: 'lineId', label: 'LINE ID', defaultValue: h.lineId },
            { name: 'status', label: '狀態', type: 'select', required: true, defaultValue: h.status, options: Object.entries(HOST_STATUS).map(([k, l]) => ({ value: k, label: l.label })) },
            { name: 'audienceNote', label: '客群描述', type: 'textarea', defaultValue: h.audienceNote }, { name: 'cooperationTerms', label: '合作條件', type: 'textarea', defaultValue: h.cooperationTerms }, { name: 'internalNote', label: '內部備註', type: 'textarea', defaultValue: h.internalNote }]} />
            : <dl className="kv"><dt>Email</dt><dd>{h.contactEmail ?? '—'}</dd><dt>LINE</dt><dd>{h.lineId ?? '—'}</dd><dt>合作條件</dt><dd>{h.cooperationTerms ?? '—'}</dd></dl>}
        </Card>
        <div>
          <Card title="所屬社群" testid="host-communities" actions={cw ? <Modal label="＋ 連結社群" title="連結社群" size="btn sm" testid="btn-link-community">
            <ApiForm endpoint={`/api/hosts/${h.id}/communities`} submitLabel="連結" fields={[{ name: 'communityId', label: '社群', type: 'select', required: true, options: allComm.map((o) => ({ value: o.value, label: o.label })) }, { name: 'role', label: '身分', type: 'select', options: [{ value: 'OWNER', label: '擁有者' }, { value: 'ADMIN', label: '管理者' }, { value: 'MEMBER', label: '成員' }] }]} />
          </Modal> : undefined}>
            {h.communities.length === 0 ? <EmptyState title="尚未連結社群" /> : <ul className="list-plain">{h.communities.map((c) => (
              <li key={c.id} data-testid={`hcomm-${c.id}`} style={{ display: 'flex', justifyContent: 'space-between' }}><span><Link href={`/communities/${c.id}`}>{c.name}</Link> <Badge>{PLATFORM[c.platform] ?? c.platform}</Badge> <span className="small muted">{c.role}</span></span>
                {cw ? <ActionButton endpoint={`/api/hosts/${h.id}/communities/${c.id}/unlink`} label="解除" small variant="danger" confirm="確定解除與此社群的關聯？" testid={`btn-unlink-${c.id}`} /> : null}</li>))}</ul>}
          </Card>
          <Card title="可承接／不可承接檔期" testid="host-availability" actions={w ? <Modal label="＋ 新增區間" title="新增可承接／不可承接區間" size="btn sm" testid="btn-add-availability">
            <ApiForm endpoint={`/api/hosts/${h.id}/availability`} submitLabel="新增" testid="availability-form" fields={[{ name: 'kind', label: '類型', type: 'select', required: true, options: [{ value: 'AVAILABLE', label: '可承接' }, { value: 'BLOCKED', label: '不可承接' }] }, { name: 'startDate', label: '開始日', type: 'date', required: true }, { name: 'endDate', label: '結束日', type: 'date', required: true }, { name: 'note', label: '備註' }]} />
          </Modal> : undefined}>
            {h.availability.length === 0 ? <EmptyState title="尚未設定" hint="不可承接的區間會在建立檔期時提示衝突" /> : <ul className="list-plain">{h.availability.map((a) => (
              <li key={a.id} data-testid={`avail-${a.id}`} style={{ display: 'flex', justifyContent: 'space-between' }}><span><Badge tone={a.kind === 'BLOCKED' ? 'danger' : 'ok'}>{AVAIL_KIND[a.kind]}</Badge> {a.startDate} ～ {a.endDate} <span className="small muted">{a.note}</span></span>
                {w ? <ActionButton endpoint={`/api/availability/${a.id}/remove`} label="移除" small /> : null}</li>))}</ul>}
          </Card>
        </div>
      </div>
      <Card title="歷史團購" flush testid="host-history">
        {h.history.length === 0 ? <EmptyState title="尚無參與的檔期" /> : (
          <Table head={['檔期', '狀態', '期間', '我的角色', '參與狀態']}>{h.history.map((c) => <tr key={c.id}><td><Link href={`/campaigns/${c.id}`}>{c.title}</Link></td><td><StatusBadge map={CAMPAIGN_STATUS} value={c.status} /></td><td>{c.openDate ?? '—'} ～ {c.closeDate ?? '—'}</td><td>{c.role === 'PRIMARY' ? '主要' : '共同'}</td><td><StatusBadge map={HOST_PART} value={c.participationStatus} /></td></tr>)}</Table>
        )}
      </Card>
    </>
  );
});
