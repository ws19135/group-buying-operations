'use client';
import { ActionButton } from '@/ui/ActionButton';
import { ApiForm } from '@/ui/ApiForm';
import { Modal } from '@/ui/Modal';

interface Props {
  id: string; status: string; kind: string; optional: boolean; dateLocked: boolean; plannedStart: string | null; plannedEnd: string | null; assigneeUserId: string | null;
  canAct: boolean; canWrite: boolean; users: { value: string; label: string }[];
}

export function TaskActions({ id, status, kind, optional, dateLocked, plannedStart, plannedEnd, assigneeUserId, canAct, canWrite, users }: Props) {
  if (kind === 'GATE') return <span className="small muted" data-testid={`task-gate-${id}`}>請由核准流程處理</span>;
  const ep = `/api/tasks/${id}/status`;
  const closed = ['SKIPPED', 'CANCELLED'].includes(status);
  return (
    <div className="btn-row">
      {canAct && status === 'TODO' ? <ActionButton endpoint={ep} body={{ to: 'IN_PROGRESS' }} label="開始" small testid={`task-start-${id}`} /> : null}
      {canAct && ['TODO', 'IN_PROGRESS'].includes(status) ? <ActionButton endpoint={ep} body={{ to: 'DONE' }} label="完成" variant="primary" small testid={`task-done-${id}`} successMessage="任務已完成" /> : null}
      {canAct && ['TODO', 'IN_PROGRESS'].includes(status) ? <ActionButton endpoint={ep} body={{ to: 'BLOCKED' }} label="封鎖" small reasonLabel="封鎖原因" testid={`task-block-${id}`} /> : null}
      {canAct && status === 'BLOCKED' ? <ActionButton endpoint={ep} body={{ to: 'IN_PROGRESS' }} label="解除封鎖" small testid={`task-unblock-${id}`} /> : null}
      {canAct && optional && status === 'TODO' ? <ActionButton endpoint={ep} body={{ to: 'SKIPPED' }} label="略過" small reasonLabel="略過原因" testid={`task-skip-${id}`} /> : null}
      {canWrite && status === 'DONE' ? <ActionButton endpoint={ep} body={{ to: 'IN_PROGRESS' }} label="重開" small reasonLabel="重開原因" testid={`task-reopen-${id}`} /> : null}
      {canWrite && !closed && status !== 'DONE' ? (
        <Modal label="調整" title="指派負責人／調整日期" size="btn sm" testid={`task-edit-${id}`}>
          <ApiForm endpoint={`/api/tasks/${id}`} method="PATCH" submitLabel="儲存" testid={`task-edit-form-${id}`}
            fields={[
              { name: 'assigneeUserId', label: '負責人', type: 'select', options: users, defaultValue: assigneeUserId ?? '' },
              { name: 'plannedStart', label: '預定開始日（人工調整後會鎖定，自動重排不會覆寫）', type: 'date', defaultValue: plannedStart },
              { name: 'plannedEnd', label: '預定完成日', type: 'date', defaultValue: plannedEnd },
              { name: 'reason', label: '調整日期的原因（調整日期時必填）', type: 'textarea' },
            ]} />
          {dateLocked ? <div style={{ marginTop: 10 }}><ActionButton endpoint={`/api/tasks/${id}`} method="PATCH" body={{ unlockDates: true }} label="解除日期鎖定" small reasonLabel="解除原因" testid={`task-unlock-${id}`} /></div> : null}
        </Modal>
      ) : null}
    </div>
  );
}
