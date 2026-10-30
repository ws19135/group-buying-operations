import Link from 'next/link';
import { withActor, sp1, toQuery, type SP } from '@/server/ui/session';
import { listApprovals } from '@/server/modules/gates';
import { GATE_APPROVER_ROLES } from '@/server/lib/permissions';
import { Card, EmptyState, Filters, PageHeader, StatusBadge, Table } from '@/ui/components';
import { ApiForm } from '@/ui/ApiForm';
import { Modal } from '@/ui/Modal';
import { APPROVAL_STATUS, CAMPAIGN_STATUS, roleLabel, gateLabel } from '@/ui/labels';
import { fmtDateTime } from '@/ui/format';
import { as } from '@/ui/types';

export const dynamic = 'force-dynamic';

interface Row { id: string; campaignId: string; campaignTitle: string; campaignStatus: string; gateKey: string; status: string; requestedByName: string | null; requestedAt: string; requestNote: string | null; decidedByName: string | null; decidedAt: string | null; decisionNote: string | null }

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const rows = as<Row[]>(await listApprovals(actor, toQuery(q)));
  return (
    <>
      <PageHeader title="核准" sub="G1（選品核准）、G2（開團核准）、G3（結單確認）、G4（結算確認）、G5（結案核准）" />
      <Filters>
        <label>狀態<select name="status" defaultValue={q.status ?? ''} data-testid="filter-status"><option value="">全部</option>{Object.entries(APPROVAL_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
      </Filters>
      <Card flush testid="approval-list">
        {rows.length === 0 ? <EmptyState title="沒有核准申請" /> : (
          <Table head={['關卡', '檔期', '狀態', '申請', '決定', '']}>
            {rows.map((a) => (
              <tr key={a.id} data-testid={`approval-row-${a.id}`}>
                <td><strong>{gateLabel(a.gateKey)}</strong></td><td><Link href={`/campaigns/${a.campaignId}?tab=approvals`}>{a.campaignTitle}</Link><div><StatusBadge map={CAMPAIGN_STATUS} value={a.campaignStatus} /></div></td>
                <td><StatusBadge map={APPROVAL_STATUS} value={a.status} /></td>
                <td className="small">{a.requestedByName ?? '—'}<div className="muted">{fmtDateTime(a.requestedAt)}</div>{a.requestNote}</td>
                <td className="small">{a.decidedByName ?? '—'}<div className="muted">{a.decidedAt ? fmtDateTime(a.decidedAt) : ''}</div>{a.decisionNote}</td>
                <td>{a.status === 'PENDING' && GATE_APPROVER_ROLES[a.gateKey]?.includes(actor.role) ? (
                  <Modal label="決定" title={`${gateLabel(a.gateKey)} 核准決定`} variant="primary" size="btn sm" testid={`btn-decide-${a.id}`}>
                    <p className="small muted">可決定的角色：{GATE_APPROVER_ROLES[a.gateKey].map(roleLabel).join('、')}</p>
                    <ApiForm endpoint={`/api/approvals/${a.id}/decision`} submitLabel="送出決定" fields={[
                      { name: 'decision', label: '決定', type: 'select', required: true, options: [{ value: 'APPROVED', label: '核准' }, { value: 'REJECTED', label: '退回' }] },
                      { name: 'note', label: '說明（退回必填）', type: 'textarea' }, { name: 'acknowledge', label: '風險確認原因（有高風險衝突仍要核准時必填）', type: 'textarea' }]} />
                  </Modal>) : null}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
});
