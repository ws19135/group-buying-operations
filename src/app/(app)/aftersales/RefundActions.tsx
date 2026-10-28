'use client';
import { ActionButton } from '@/ui/ActionButton';
import { ApiForm } from '@/ui/ApiForm';
import { Modal } from '@/ui/Modal';

/** 退款申請上的操作：核准／退回（需 refund.approve）、完成（需 refund.complete，可選擇是否寫回訂單） */
export function RefundActions({ id, status, hasOrder, canApprove, canComplete }: { id: string; status: string; hasOrder: boolean; canApprove: boolean; canComplete: boolean }) {
  if (status === 'REQUESTED' && canApprove) {
    return (
      <div className="btn-row">
        <ActionButton endpoint={`/api/aftersales/refunds/${id}/decision`} body={{ decision: 'APPROVED' }} label="核准" small variant="primary" confirm="確定核准這筆退款申請？" testid={`btn-approve-${id}`} />
        <ActionButton endpoint={`/api/aftersales/refunds/${id}/decision`} body={{ decision: 'REJECTED' }} label="退回" small variant="danger" reasonLabel="退回原因" reasonKey="note" testid={`btn-reject-${id}`} />
      </div>
    );
  }
  if (status === 'APPROVED' && canComplete) {
    return (
      <Modal label="標記完成" title="標記退款完成" size="btn sm" variant="primary" testid={`btn-complete-${id}`}>
        <p className="small muted">請在實際退款（匯款／刷退）完成後再標記。本系統不處理真實金流。</p>
        <ApiForm endpoint={`/api/aftersales/refunds/${id}/complete`} submitLabel="確認完成" testid={`complete-form-${id}`} successMessage="退款已標記完成" fields={[
          { name: 'writeback', label: hasOrder ? '同時把金額寫回訂單的退款金額，並更新訂單狀態（預設不勾；若退款已由訂單匯入反映，請不要勾，以免重複計入）' : '此申請沒有關聯訂單，無法寫回', type: 'checkbox' },
          { name: 'note', label: '完成備註（選填）', type: 'textarea' }]} />
      </Modal>
    );
  }
  return null;
}
