import { can, isInternal, type Actor } from '@/server/lib/permissions';
import { listAssignableUsers } from '@/server/ui/lookups';
import { listHandovers } from '@/server/modules/collaboration-assignment';
import { listRetentionHolds } from '@/server/modules/collaboration-retention';
import { ActionButton } from '@/ui/ActionButton';
import { ApiForm } from '@/ui/ApiForm';
import { Modal } from '@/ui/Modal';
import { Badge, Card, EmptyState, Table } from '@/ui/components';
import { fmtDateTime } from '@/ui/format';
import { as } from '@/ui/types';

interface Assignee { userId: string; role: 'PRIMARY' | 'CO_OWNER'; name: string; status: string }
interface Handover { id: number; handoverType: string; reason: string | null; createdAt: string; fromUserName: string | null; toUserName: string | null; actorName: string | null }
interface Hold { id: string; reasonCode: string; basis: string; holdUntil: string; releasedAt: string | null; active: boolean; placedByName: string | null }

const HANDOVER_LABEL: Record<string, string> = {
  ASSIGN: '指派', CLAIM: '認領', TRANSFER: '交接', RELEASE: '釋出到待指派佇列', ADD_CO_OWNER: '加入共同承辦', REMOVE_CO_OWNER: '移除共同承辦', BULK_REASSIGN: '整批交接',
};
const HOLD_REASON: Record<string, string> = { DISPUTE: '爭議案件', LEGAL_OBLIGATION: '法定保存義務', RETURN_OR_REFUND: '退回／退款處理', OWNER_APPROVED: 'Owner 核准的例外' };

/** 承辦人、交接紀錄與個資保留例外（僅內部）。承辦人只能經這裡的指派／交接／認領／釋出變更，不能直接改欄位（D-39） */
export async function AssignmentBlock({ actor, applicationId, assignees, terminal }: { actor: Actor; applicationId: string; assignees: Assignee[]; terminal: boolean }) {
  if (!isInternal(actor)) return null;
  const canAssign = can(actor, 'collaboration.assign');
  const canRetention = can(actor, 'collaboration.retention.manage');
  const primary = assignees.find((a) => a.role === 'PRIMARY' && a.status === 'ACTIVE');
  const mineIsPrimary = !!primary && primary.userId === actor.userId;
  const people = canAssign || mineIsPrimary ? await listAssignableUsers(actor).catch(() => []) : [];
  const handovers = as<{ items: Handover[] }>(await listHandovers(actor, applicationId).catch(() => ({ items: [] }))).items;
  const holds = canRetention ? as<{ items: Hold[] }>(await listRetentionHolds(actor, applicationId).catch(() => ({ items: [] }))).items : [];

  return (
    <Card title="承辦與交接" testid="block-assignment" actions={!terminal ? (
      <div className="btn-row">
        {canAssign ? (
          <Modal label={primary ? '交接' : '指派承辦人'} title={primary ? '交接承辦人' : '指派承辦人'} size="btn sm" testid="btn-assign">
            <ApiForm endpoint={`/api/collaboration/applications/${applicationId}/assign`} submitLabel="確認" testid="form-assign"
              fields={[
                { name: 'userId', label: '承辦人', type: 'select', required: true, options: [{ value: '', label: '請選擇' }, ...people] },
                { name: 'reason', label: primary ? '交接原因（必填）' : '說明', type: 'textarea', required: !!primary },
              ]} />
          </Modal>
        ) : null}
        {!primary && can(actor, 'collaboration.update') && !canAssign ? (
          <ActionButton endpoint={`/api/collaboration/applications/${applicationId}/claim`} label="認領這筆申請" small variant="primary" testid="btn-claim" successMessage="已認領" />
        ) : null}
        {primary && (canAssign || mineIsPrimary) ? (
          <Modal label="加入共同承辦" title="加入共同承辦" size="btn sm" testid="btn-add-coowner">
            <ApiForm endpoint={`/api/collaboration/applications/${applicationId}/co-owners`} submitLabel="加入" testid="form-add-coowner"
              fields={[{ name: 'userId', label: '共同承辦人', type: 'select', required: true, options: [{ value: '', label: '請選擇' }, ...people] }]} />
          </Modal>
        ) : null}
        {primary && (canAssign || mineIsPrimary) ? (
          <ActionButton endpoint={`/api/collaboration/applications/${applicationId}/release`} label="釋出到待指派佇列" small reasonLabel="釋出原因" testid="btn-release" />
        ) : null}
      </div>
    ) : undefined}>
      {assignees.length === 0 ? <EmptyState title="目前沒有承辦人" hint="這筆申請在「待指派佇列」，營運主管可指派，營運小編可自行認領" /> : (
        <Table head={['承辦', '身分', '狀態', '']} testid="assignee-table">
          {assignees.map((a) => (
            <tr key={a.userId} data-testid={`assignee-${a.userId}`}>
              <td>{a.name}</td>
              <td><Badge tone={a.role === 'PRIMARY' ? 'info' : undefined}>{a.role === 'PRIMARY' ? '主要承辦' : '共同承辦'}</Badge></td>
              <td className="small">{a.status === 'ACTIVE' ? '啟用中' : '已停用（案件已回到待指派佇列）'}</td>
              <td>{a.role === 'CO_OWNER' && !terminal && (canAssign || mineIsPrimary) ? (
                <ActionButton endpoint={`/api/collaboration/applications/${applicationId}/co-owners/${a.userId}/remove`} label="移除" small variant="danger" reasonLabel="移除原因" reasonRequired={false} testid={`btn-remove-coowner-${a.userId}`} />
              ) : null}</td>
            </tr>
          ))}
        </Table>
      )}
      {handovers.length ? (
        <div className="pad" data-testid="handover-history">
          <div className="small muted">交接紀錄（不可修改）</div>
          <ul className="small">
            {handovers.map((h) => (
              <li key={h.id}>{fmtDateTime(h.createdAt)} · {HANDOVER_LABEL[h.handoverType] ?? h.handoverType}
                {h.fromUserName ? ` ${h.fromUserName}` : ''}{h.toUserName ? ` → ${h.toUserName}` : ''}{h.reason ? `（${h.reason}）` : ''}{h.actorName ? ` ／ 操作：${h.actorName}` : ''}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {canRetention ? (
        <div className="pad" data-testid="retention-holds">
          <div className="small muted">個資保留例外（有依據、有期限，最長 365 天；只阻止清除，不擴大任何人的讀取權限）</div>
          {holds.length ? (
            <ul className="small">
              {holds.map((h) => (
                <li key={h.id}>{HOLD_REASON[h.reasonCode] ?? h.reasonCode} · 至 {h.holdUntil} · {h.basis}{h.releasedAt ? '（已解除）' : h.active ? '（生效中）' : '（已到期）'}
                  {h.active && !h.releasedAt ? <> <ActionButton endpoint={`/api/collaboration/retention-holds/${h.id}/release`} label="解除" small reasonLabel="解除原因" testid={`btn-release-hold-${h.id}`} /></> : null}</li>
              ))}
            </ul>
          ) : null}
          <Modal label="設定保留例外" title="設定個資保留例外" size="btn sm" testid="btn-place-hold">
            <ApiForm endpoint={`/api/collaboration/applications/${applicationId}/retention-holds`} submitLabel="設定" testid="form-place-hold"
              fields={[
                { name: 'reasonCode', label: '事由', type: 'select', required: true, options: Object.entries(HOLD_REASON).map(([value, label]) => ({ value, label })) },
                { name: 'basis', label: '依據（案號、法規或爭議說明；不可填個資）', type: 'textarea', required: true },
                { name: 'holdUntil', label: '保留到期日（最長 365 天）', type: 'date', required: true },
              ]} />
          </Modal>

        </div>
      ) : null}
    </Card>
  );
}
