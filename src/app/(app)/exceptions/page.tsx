import Link from 'next/link';
import { withActor, sp1, toQuery, type SP } from '@/server/ui/session';
import { listExceptions } from '@/server/modules/automation';
import { can } from '@/server/lib/permissions';
import { ActionButton } from '@/ui/ActionButton';
import { Card, EmptyState, Filters, PageHeader, StatusBadge, Table } from '@/ui/components';
import { EXC_STATUS, SEVERITY } from '@/ui/labels';
import { fmtDateTime } from '@/ui/format';
import { as } from '@/ui/types';

export const dynamic = 'force-dynamic';
interface E { id: string; type: string; severity: string; title: string; detail: string | null; status: string; campaignId: string | null; campaignTitle: string | null; detectedAt: string; resolutionNote: string | null }

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const rows = as<E[]>(await listExceptions(actor, toQuery(q)));
  const manage = can(actor, 'exception.manage');
  return (
    <>
      <PageHeader title="例外" sub="延誤、逾期、衝突、團主未回覆…都是一級資料，需有人認領並結案" />
      <Filters>
        <label>狀態<select name="status" defaultValue={q.status ?? 'OPEN'} data-testid="filter-status"><option value="OPEN">未結（預設）</option><option value="ACKNOWLEDGED">已認領</option><option value="RESOLVED">已結案</option><option value="ALL">全部</option></select></label>
        <label>嚴重度<select name="severity" defaultValue={q.severity ?? ''} data-testid="filter-severity"><option value="">全部</option>{Object.entries(SEVERITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
      </Filters>
      <Card flush testid="exception-list">
        {rows.length === 0 ? <EmptyState title="沒有符合條件的例外 🎉" /> : (
          <Table head={['嚴重度', '例外', '檔期', '偵測時間', '狀態', '']}>
            {rows.map((e) => (
              <tr key={e.id} data-testid={`exception-row-${e.id}`}><td><StatusBadge map={SEVERITY} value={e.severity} /></td><td><strong>{e.title}</strong><div className="small muted">{e.detail}</div><div className="small muted">{e.type}</div></td>
                <td>{e.campaignId ? <Link href={`/campaigns/${e.campaignId}`}>{e.campaignTitle}</Link> : '—'}</td><td className="small">{fmtDateTime(e.detectedAt)}</td><td><StatusBadge map={EXC_STATUS} value={e.status} />{e.resolutionNote ? <div className="small muted">{e.resolutionNote}</div> : null}</td>
                <td>{manage && e.status !== 'RESOLVED' ? <div className="btn-row">
                  {e.status === 'OPEN' ? <ActionButton endpoint={`/api/exceptions/${e.id}/status`} body={{ status: 'ACKNOWLEDGED' }} label="認領" small reasonLabel="處理說明" reasonKey="note" testid={`btn-ack-${e.id}`} /> : null}
                  <ActionButton endpoint={`/api/exceptions/${e.id}/status`} body={{ status: 'RESOLVED' }} label="結案" small variant="primary" reasonLabel="結案說明" reasonKey="note" testid={`btn-resolve-${e.id}`} />
                </div> : null}</td></tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
});
