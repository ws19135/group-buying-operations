import { withActor, sp1, toQuery, type SP } from '@/server/ui/session';
import { listAudit } from '@/server/modules/audit-read';
import { Card, EmptyState, Filters, PageHeader, Table } from '@/ui/components';
import { roleLabel } from '@/ui/labels';
import { fmtDateTime } from '@/ui/format';
import { as, type AuditV } from '@/ui/types';

export const dynamic = 'force-dynamic';

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const rows = as<AuditV[]>(await listAudit(actor, toQuery(q)));
  const j = (v: unknown) => (v == null ? '' : JSON.stringify(v));
  return (
    <>
      <PageHeader title="稽核紀錄" sub="所有變更都留痕（誰、何時、對什麼、前後值）；稽核紀錄不可修改或刪除" />
      <Filters>
        <label>對象類型<input name="entityType" defaultValue={q.entityType} placeholder="campaign、task…" data-testid="filter-entityType" /></label>
        <label>對象編號（ID）<input name="entityId" defaultValue={q.entityId} /></label>
        <label>檔期編號（ID）<input name="campaignId" defaultValue={q.campaignId} /></label>
        <label>動作<input name="action" defaultValue={q.action} placeholder="campaign.reschedule" /></label>
      </Filters>
      <Card flush testid="audit-list">
        {rows.length === 0 ? <EmptyState title="沒有符合條件的紀錄" /> : (
          <Table head={['時間', '操作者', '動作', '對象', '前後值', '原因／來源']}>
            {rows.map((a) => (
              <tr key={a.id} data-testid={`audit-row-${a.id}`}><td className="nowrap small">{fmtDateTime(a.occurredAt)}</td><td className="small">{a.actorName ?? (a.actorType === 'SYSTEM' ? '系統' : '—')}<div className="muted">{a.actorRole ? roleLabel(a.actorRole) : ''}</div></td>
                <td className="small">{a.action}</td><td className="small">{a.entityType}<div className="muted">{a.entityId}</div></td>
                <td>{a.beforeData ? <pre className="diff">前：{j(a.beforeData).slice(0, 400)}</pre> : null}{a.afterData ? <pre className="diff">後：{j(a.afterData).slice(0, 400)}</pre> : null}</td><td className="small">{a.reason}<div className="muted">{a.source}</div></td></tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
});
