import Link from 'next/link';
import { withActor, type Params } from '@/server/ui/session';
import { can } from '@/server/lib/permissions';
import { getDiligence } from '@/server/modules/diligence';
import { listAssignableUsers } from '@/server/ui/lookups';
import { DD_UI_FIELDS } from '@/server/lib/dd-catalog';
import { ActionButton } from '@/ui/ActionButton';
import { ApiForm } from '@/ui/ApiForm';
import { Modal } from '@/ui/Modal';
import { Banner, Card, Kv, PageHeader, StatusBadge } from '@/ui/components';
import { DD_RECORD_STATUS, REGULATED } from '@/ui/labels';
import { fmtDateTime, plain } from '@/ui/format';
import { DdItemCard, type DdItemV } from '@/ui/selection/DdItemCard';
import { as } from '@/ui/types';

export const dynamic = 'force-dynamic';

interface D {
  id: string; vendorId: string; vendorName: string; productId: string | null; productName: string | null; contractVersion: string; contractRef: string | null; regulatedCategory: string | null; status: string;
  note: string | null; preparedByName: string | null; submittedAt: string | null; reviewedByName: string | null; reviewedAt: string | null; reviewNote: string | null; validUntil: string | null; version: number; editable: boolean;
  readiness: { ready: boolean; reasons: string[]; counts: Record<string, number>; expired: number; expiring: number; legalPending: number; risks: number };
  validity: { valid: boolean; reasons: string[] };
  items: DdItemV[]; canSeeSensitive: boolean;
}

export default withActor(async (actor, props: { params: Params }) => {
  const { id } = await props.params;
  const d = as<D>(await getDiligence(actor, id));
  const write = can(actor, 'selection.write');
  const reviewer = can(actor, 'product.review');
  const owners = write ? await listAssignableUsers(actor).catch(() => []) : [];
  const ep = `/api/diligence/${d.id}`;
  return (
    <>
      <PageHeader title={<>廠商合作資格審查 <StatusBadge map={DD_RECORD_STATUS} value={d.status} testid="dd-status" /></>} testid="dd-header"
        sub={<><Link href={`/vendors/${d.vendorId}`}>{d.vendorName}</Link>・合約版本 <strong>{d.contractVersion}</strong>{d.productName ? <>・限定商品 <Link href={`/products/${d.productId}`}>{d.productName}</Link></> : '・整個廠商'}・{d.id}</>}
        actions={<div className="btn-row">
          {write && d.editable ? <ActionButton endpoint={`${ep}/submit`} label="送審" variant="primary" testid="btn-dd-submit" successMessage="已送審" /> : null}
          {reviewer && d.status === 'IN_REVIEW' ? <ActionButton endpoint={`${ep}/review`} body={{ decision: 'APPROVED' }} label="核准" variant="primary" reasonLabel="核准意見（選填）" reasonKey="note" reasonRequired={false} testid="btn-dd-approve" successMessage="已核准" /> : null}
          {reviewer && d.status === 'IN_REVIEW' ? <ActionButton endpoint={`${ep}/review`} body={{ decision: 'REJECTED' }} label="退回" variant="danger" reasonLabel="退回原因" reasonKey="note" testid="btn-dd-reject" /> : null}
          {reviewer && d.status === 'APPROVED' ? <ActionButton endpoint={`${ep}/review`} body={{ decision: 'REJECTED' }} label="撤銷核准" variant="danger" reasonLabel="撤銷原因" reasonKey="note" testid="btn-dd-revoke" /> : null}
        </div>} />
      <Banner kind="nodata">這份調查記錄「首次合作前要確認的 12 類問題」與證據。<strong>核准結果不會阻擋也不會放行 G1（選品核准）</strong>，只在廠商頁與 G1（選品核准）決策摘要顯示。涉及轉售價格限制、食品、保健、醫材、化妝品、兒童用品等，系統只標示「需法務或合規審查」，<strong>不判斷是否合法</strong>。證據只存連結，檔案請放公司核准的雲端空間。</Banner>
      {d.status === 'APPROVED' ? <Banner kind={d.validity.valid ? 'ok' : 'error'} testid="dd-validity">{d.validity.valid ? `核准有效至 ${d.validUntil}（${d.reviewedByName ?? ''} ${fmtDateTime(d.reviewedAt)}）` : `核准已失效：${d.validity.reasons.join('；')}`}</Banner> : null}
      {d.status === 'REJECTED' && d.reviewNote ? <Banner kind="warn">退回／撤銷原因：{d.reviewNote}</Banner> : null}
      <div className="grid cols-2">
        <Card title="調查資料" testid="dd-info" actions={write && d.editable ? <Modal label="編輯" title="編輯調查資料" size="btn sm" testid="btn-dd-edit">
          <ApiForm endpoint={ep} method="PATCH" extra={{ version: d.version }} submitLabel="儲存" fields={[
            { name: 'contractRef', label: '合約編號／文件位置（文字）', defaultValue: d.contractRef },
            { name: 'regulatedCategory', label: '受規範品類（選了會標示需法務／合規審查）', type: 'select', defaultValue: d.regulatedCategory, options: Object.entries(REGULATED).map(([value, label]) => ({ value, label })) },
            { name: 'note', label: '備註', type: 'textarea', defaultValue: d.note }]} />
        </Modal> : undefined}>
          <Kv rows={[['合約版本', d.contractVersion], ['合約編號', d.contractRef], ['受規範品類', d.regulatedCategory ? REGULATED[d.regulatedCategory] : '—'], ['填報', d.preparedByName], ['送審', fmtDateTime(d.submittedAt)], ['審核', d.reviewedByName ? `${d.reviewedByName} ${fmtDateTime(d.reviewedAt)}` : '—'], ['備註', d.note]]} />
        </Card>
        <Card title="準備度" testid="dd-readiness">
          <p data-testid="dd-ready">{d.readiness.ready ? '✅ 12 類都已確認或不適用，可以送審' : '⛔ 尚不能送審'}</p>
          <ul className="small">{d.readiness.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          <p className="small muted">已確認 {d.readiness.counts.CONFIRMED ?? 0}・不適用 {d.readiness.counts.NOT_APPLICABLE ?? 0}・待補件 {d.readiness.counts.PENDING_DOCS ?? 0}・有風險 {d.readiness.counts.AT_RISK ?? 0}・證據即將到期 {d.readiness.expiring}</p>
        </Card>
      </div>
      <h2>12 類問題</h2>
      <div data-testid="dd-items">
        {d.items.map((it) => (
          <DdItemCard key={`${it.id}-${it.version}`} item={plain(it)} fields={DD_UI_FIELDS[it.categoryKey] ?? []} editable={d.editable} canWrite={write} canReview={reviewer} canSensitive={d.canSeeSensitive} owners={owners} />
        ))}
      </div>
    </>
  );
});
