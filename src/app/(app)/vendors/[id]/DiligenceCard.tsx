import Link from 'next/link';
import type { Actor } from '@/server/lib/permissions';
import { can } from '@/server/lib/permissions';
import { listVendorDiligence } from '@/server/modules/diligence';
import { ApiForm } from '@/ui/ApiForm';
import { Modal } from '@/ui/Modal';
import { Badge, Card, EmptyState, StatusBadge, Table } from '@/ui/components';
import { DD_RECORD_STATUS, REGULATED } from '@/ui/labels';
import { fmtDateTime } from '@/ui/format';
import { DdProgress, type DdReadinessV } from '@/ui/selection/DdProgress';
import { as } from '@/ui/types';

interface Rec {
  id: string; contractVersion: string; productName: string | null; productId: string | null; status: string; validUntil: string | null; regulatedCategory: string | null; preparedByName: string | null; updatedAt: string;
  readiness: DdReadinessV & { reasons: string[] }; validity: { valid: boolean; reasons: string[] }; supersededAt: string | null;
}

/** 廠商詳情：合作資格審查（標準作業流程 SOP 02 首次合作十二問）。核准結果只供查閱，不阻擋也不放行 G1（選品核准） */
export async function DiligenceCard({ actor, vendorId, products }: { actor: Actor; vendorId: string; products: { id: string; name: string }[] }) {
  const d = as<{ items: Rec[]; config: { ddValidDays: number; status: string } }>(await listVendorDiligence(actor, vendorId));
  const write = can(actor, 'selection.write');
  return (
    <Card title="合作資格審查（首次合作 12 類問題）" flush testid="vendor-diligence" actions={write ? <Modal label="＋ 新增調查" title="新增合作資格審查" size="btn sm" variant="primary" testid="btn-dd-new">
      <p className="small muted">一份調查＝某廠商（可限定某商品）在某<strong>合約版本</strong>下的 12 類問題。合約條款改版時請用新的合約版本另開一份，舊的保留。</p>
      <ApiForm endpoint={`/api/vendors/${vendorId}/diligence`} submitLabel="建立" idempotent redirectTo="/diligence/{id}" testid="dd-new-form" fields={[
        { name: 'contractVersion', label: '合約版本', required: true, placeholder: '例：2026-v1' },
        { name: 'copyFromId', label: '沿用先前的調查（帶入條款、責任方與負責人；項目回到待補件，需重新確認，不複製證據）', type: 'select', options: d.items.map((r) => ({ value: r.id, label: `${r.contractVersion}（${r.productId ? r.productName : '整個廠商'}）` })) }, { name: 'contractRef', label: '合約編號／文件位置（文字）' },
        { name: 'productId', label: '限定商品（不選＝整個廠商）', type: 'select', options: products.map((p) => ({ value: p.id, label: p.name })) },
        { name: 'regulatedCategory', label: '受規範品類（食品、保健、醫材、化妝品、兒童用品…；選了會標示需法務／合規審查）', type: 'select', options: Object.entries(REGULATED).map(([value, label]) => ({ value, label })) },
        { name: 'note', label: '備註', type: 'textarea' }]} />
    </Modal> : undefined}>
      <p className="small muted" style={{ padding: '10px 16px 0' }}>核准後有效 {d.config.ddValidDays} 天（{d.config.status}），到期或證據過期會自動標示失效。這份調查<strong>不會</strong>阻擋或放行 G1（選品核准），只在 G1（選品核准）決策摘要中顯示。</p>
      {d.items.length === 0 ? <EmptyState title="尚無合作資格審查" hint={write ? '首次合作前，請建立一份並逐項確認。' : undefined} /> : (
        <Table head={['合約版本', '範圍', '狀態', '進度', '有效期', '更新']} testid="dd-table">{d.items.map((r) => (
          <tr key={r.id} data-testid={`dd-row-${r.id}`}>
            <td><Link href={`/diligence/${r.id}`}><strong>{r.contractVersion}</strong></Link><div className="small muted">{r.id}</div></td>
            <td>{r.productId ? <Link href={`/products/${r.productId}`}>{r.productName}</Link> : '整個廠商'}{r.regulatedCategory ? <div><Badge tone="warn">{REGULATED[r.regulatedCategory]}</Badge></div> : null}</td>
            <td><StatusBadge map={DD_RECORD_STATUS} value={r.status} />{r.status === 'APPROVED' && !r.validity.valid ? <div><Badge tone="danger">已失效</Badge></div> : null}</td>
            <td className="small"><DdProgress readiness={r.readiness} compact testid={`dd-progress-${r.id}`} /><div className="muted">待補 {r.readiness.counts.PENDING_DOCS ?? 0}{r.readiness.risks ? `・風險 ${r.readiness.risks}` : ''}{r.readiness.expired ? `・過期證據 ${r.readiness.expired}` : ''}{r.readiness.docExpired?.length ? '・授權已過期' : ''}{r.supersededAt ? '・已被新版取代' : ''}</div></td>
            <td className="small">{r.validUntil ?? '—'}</td><td className="small">{fmtDateTime(r.updatedAt)}</td>
          </tr>))}</Table>
      )}
    </Card>
  );
}
