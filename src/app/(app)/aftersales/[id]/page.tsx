import Link from 'next/link';
import { withActor, type Params } from '@/server/ui/session';
import { CASE_TRANSITIONS, getCase, type CaseStatus } from '@/server/modules/aftersales';
import { can, isInternal } from '@/server/lib/permissions';
import { listAssignableUsers } from '@/server/ui/lookups';
import { ActionButton } from '@/ui/ActionButton';
import { ApiForm } from '@/ui/ApiForm';
import { Modal } from '@/ui/Modal';
import { Badge, Banner, Card, EmptyState, Kv, PageHeader, StatusBadge, Table } from '@/ui/components';
import { fmtDate, fmtDateTime, money } from '@/ui/format';
import { as } from '@/ui/types';
import { CASE_STATUS, CASE_TYPE, EVENT_TYPE, PII_HINT, PRIORITY, REFUND_STATUS, priorityOptions } from '../labels';
import { RefundActions } from '../RefundActions';

export const dynamic = 'force-dynamic';

interface Ev { id: number; eventType: string; fromStatus: string | null; toStatus: string | null; note: string | null; isInternal: boolean; actorRole: string | null; actorName: string | null; createdAt: string }
export interface RefundV { id: string; amount: number; reason: string; status: string; orderId: string | null; decisionNote: string | null; requestedByName?: string | null; decidedByName?: string | null; writebackApplied: boolean; completedAt: string | null; createdAt: string; completionNote?: string | null }
interface D {
  id: string; campaignId: string; campaignTitle: string; caseType: string; status: string; priority: string; title: string; dueDate: string | null; resolution: string | null; createdAt: string; resolvedAt: string | null; overdue: boolean; version?: number;
  description?: string | null; buyerRef?: string | null; orderId?: string | null; assigneeUserId?: string | null; assigneeName?: string | null; internalNote?: string | null;
  events: Ev[]; refunds?: RefundV[];
  order?: { id: string; sourceSystem: string; sourceOrderId: string; status: string; grossAmount: number; refundAmount: number } | null;
}

const TRANSITION_LABEL: Record<string, string> = { IN_PROGRESS: '開始處理', WAITING_VENDOR: '等待廠商回覆', CLOSED: '結案' };

export default withActor(async (actor, props: { params: Params }) => {
  const { id } = await props.params;
  const c = as<D>(await getCase(actor, id));
  const internal = isInternal(actor);
  const write = can(actor, 'aftersales.write');
  const active = ['OPEN', 'IN_PROGRESS', 'WAITING_VENDOR'].includes(c.status);
  const editable = write && (active || c.status === 'RESOLVED');
  const users = editable ? await listAssignableUsers(actor) : [];
  const next = CASE_TRANSITIONS[c.status as CaseStatus] ?? [];
  const refunds = c.refunds ?? [];
  const pendingRefund = refunds.some((r) => r.status === 'REQUESTED' || r.status === 'APPROVED');
  return (
    <>
      <PageHeader title={<>{c.title} <StatusBadge map={CASE_STATUS} value={c.status} testid="case-status" /></>}
        sub={<>{c.id} ・ {CASE_TYPE[c.caseType] ?? c.caseType} ・ <Link href={`/campaigns/${c.campaignId}`}>{c.campaignTitle}</Link></>} testid="case-header"
        actions={write && next.length ? <div className="btn-row" data-testid="case-actions">
          {next.filter((t) => TRANSITION_LABEL[t] && !(t === 'IN_PROGRESS' && c.status === 'RESOLVED')).map((t) => <ActionButton key={t} endpoint={`/api/aftersales/cases/${c.id}/status`} body={{ to: t, version: c.version }} label={TRANSITION_LABEL[t]} variant={t === 'CLOSED' ? 'primary' : ''} testid={`btn-to-${t}`} />)}
          {next.includes('RESOLVED') ? <Modal label="標記已解決" title="標記已解決" variant="primary" testid="btn-to-RESOLVED">
            <ApiForm endpoint={`/api/aftersales/cases/${c.id}/status`} extra={{ to: 'RESOLVED', version: c.version }} submitLabel="確認已解決" testid="resolve-form" successMessage="案件已標記為已解決" fields={[
              { name: 'resolution', label: '處理結果', type: 'textarea', required: true, defaultValue: c.resolution, help: '會顯示給團主／廠商看，請勿放內部資訊' }, { name: 'note', label: '內部說明（選填）', type: 'textarea' }]} />
          </Modal> : null}
          {c.status === 'RESOLVED' ? <ActionButton endpoint={`/api/aftersales/cases/${c.id}/status`} body={{ to: 'IN_PROGRESS', version: c.version }} label="重新開啟" reasonLabel="重新開啟原因" reasonKey="note" testid="btn-reopen" /> : null}
          {next.includes('CANCELLED') ? <ActionButton endpoint={`/api/aftersales/cases/${c.id}/status`} body={{ to: 'CANCELLED', version: c.version }} label="取消案件" variant="danger" reasonLabel="取消原因" reasonKey="note" testid="btn-to-CANCELLED" /> : null}
        </div> : undefined} />
      {c.overdue ? <Banner kind="error" testid="overdue-banner">此案件已逾期（到期日 {fmtDate(c.dueDate)}），請盡快處理或調整到期日。</Banner> : null}
      {pendingRefund ? <Banner kind="warn" testid="pending-refund-banner">還有未完成的退款申請；完成前無法將案件標記為已解決、結案或取消。</Banner> : null}
      <div className="grid cols-2">
        <Card title="案件資料" testid="case-info">
          {editable ? (
            <ApiForm endpoint={`/api/aftersales/cases/${c.id}`} method="PATCH" extra={{ version: c.version }} submitLabel="儲存" testid="case-edit-form" fields={[
              { name: 'title', label: '標題', required: true, defaultValue: c.title },
              { name: 'priority', label: '優先級', type: 'select', required: true, defaultValue: c.priority, options: priorityOptions },
              { name: 'assigneeUserId', label: '負責人', type: 'select', defaultValue: c.assigneeUserId, options: users },
              { name: 'dueDate', label: '到期日', type: 'date', defaultValue: c.dueDate },
              { name: 'buyerRef', label: '買家代號', defaultValue: c.buyerRef },
              { name: 'description', label: '問題描述', type: 'textarea', defaultValue: c.description },
              { name: 'internalNote', label: '內部備註（團主、廠商看不到）', type: 'textarea', defaultValue: c.internalNote },
              { name: 'resolution', label: '處理結果', type: 'textarea', defaultValue: c.resolution },
            ]} />
          ) : (
            <Kv rows={[
              ['優先級', <StatusBadge key="p" map={PRIORITY} value={c.priority} />], ['到期日', c.dueDate ? fmtDate(c.dueDate) : '—'],
              ...(internal ? [['負責人', c.assigneeName ?? '—'], ['買家代號', c.buyerRef ?? '—'], ['問題描述', c.description ?? '—'], ['內部備註', c.internalNote ?? '—']] as [string, string][] : []),
              ['處理結果', c.resolution ?? '—'], ['建立時間', fmtDateTime(c.createdAt)], ['解決時間', c.resolvedAt ? fmtDateTime(c.resolvedAt) : '—'],
            ]} />
          )}
          {internal && c.order ? <p className="small muted" data-testid="case-order">關聯訂單：{c.order.id}（{c.order.sourceSystem} {c.order.sourceOrderId}）・金額 {money(c.order.grossAmount)}・已退 {money(c.order.refundAmount)}・{c.order.status}</p> : null}
        </Card>
        <Card title="處理紀錄" testid="case-events" actions={write && !['CLOSED', 'CANCELLED'].includes(c.status) ? <Modal label="＋ 新增備註" title="新增備註" size="btn sm" testid="btn-add-note">
          <p className="small muted">{PII_HINT}</p>
          <ApiForm endpoint={`/api/aftersales/cases/${c.id}/notes`} submitLabel="新增" testid="note-form" successMessage="已新增備註" fields={[
            { name: 'note', label: '內容', type: 'textarea', required: true }, { name: 'public', label: '讓團主／廠商也看得到（預設只有內部看得到）', type: 'checkbox' }]} />
        </Modal> : undefined}>
          {c.events.length === 0 ? <EmptyState title="尚無處理紀錄" /> : (
            <ul className="list-plain">{[...c.events].reverse().map((e) => (
              <li key={e.id} data-testid={`event-${e.id}`}>
                <strong>{EVENT_TYPE[e.eventType] ?? e.eventType}</strong>
                {e.fromStatus || e.toStatus ? <> <span className="small">{e.fromStatus ? `${CASE_STATUS[e.fromStatus]?.label ?? e.fromStatus} → ` : ''}{CASE_STATUS[e.toStatus ?? '']?.label ?? e.toStatus}</span></> : null}
                {internal && !e.isInternal ? <> <Badge tone="info">對外可見</Badge></> : null}
                {e.note ? <div>{e.note}</div> : null}
                <div className="small muted">{fmtDateTime(e.createdAt)}{e.actorName ? ` ・ ${e.actorName}` : ''}</div>
              </li>))}</ul>
          )}
        </Card>
      </div>
      {internal ? (
        <Card title="退款申請" flush testid="case-refunds" actions={write && active ? <Modal label="＋ 申請退款" title="申請退款" size="btn sm" testid="btn-request-refund">
          <p className="small muted">金額不可超過訂單的可退餘額。核准後由財務完成；完成時才可選擇是否把金額寫回訂單。</p>
          <ApiForm endpoint={`/api/aftersales/cases/${c.id}/refunds`} idempotent submitLabel="送出申請" testid="refund-form" successMessage="退款申請已送出" fields={[
            { name: 'amount', label: '退款金額（新台幣，整數）', type: 'number', required: true, min: 1 },
            { name: 'reason', label: '退款原因', type: 'textarea', required: true },
            ...(c.orderId ? [] : [{ name: 'orderId', label: '關聯訂單（選填）', placeholder: 'ORD-000001' }]),
          ]} />
        </Modal> : undefined}>
          {refunds.length === 0 ? <EmptyState title="尚無退款申請" /> : (
            <Table head={['申請', '金額', '原因', '狀態', '決定／完成', '']}>
              {refunds.map((r) => (
                <tr key={r.id} data-testid={`refund-row-${r.id}`}>
                  <td>{r.id}<div className="small muted">{r.requestedByName ?? ''} {fmtDateTime(r.createdAt)}</div></td>
                  <td>{money(r.amount)}{r.orderId ? <div className="small muted">{r.orderId}</div> : null}</td>
                  <td>{r.reason}</td>
                  <td><StatusBadge map={REFUND_STATUS} value={r.status} />{r.writebackApplied ? <div className="small"><Badge tone="info">已寫回訂單</Badge></div> : null}</td>
                  <td className="small">{r.decisionNote ? <div>{r.decisionNote}</div> : null}{r.decidedByName ? <div className="muted">{r.decidedByName}</div> : null}{r.completedAt ? <div className="muted">完成 {fmtDateTime(r.completedAt)}</div> : null}</td>
                  <td><RefundActions id={r.id} status={r.status} hasOrder={!!r.orderId} canApprove={can(actor, 'refund.approve')} canComplete={can(actor, 'refund.complete')} /></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      ) : null}
    </>
  );
});
