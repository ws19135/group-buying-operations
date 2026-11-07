import Link from 'next/link';
import type { Actor } from '@/server/lib/permissions';
import { can } from '@/server/lib/permissions';
import { hostApplications, productApplications, vendorSummary } from '@/server/modules/collaboration';
import { Badge, Card, EmptyState, KpiCard, StatusBadge, Table } from '@/ui/components';
import { fmtDate } from '@/ui/format';
import { as } from '@/ui/types';
import type { AppRowV } from './page';
import { APP_STATUS, COLLAB_STATUS, INTENT, SAMPLE_PROGRESS } from './labels';

/** 三個主檔頁共用的欄位，避免同一份資料在不同頁長得不一樣 */
function Rows({ items }: { items: AppRowV[] }) {
  return (
    <Table head={['申請單', '廠商／團主', '商品', '申請狀態', '樣品進度', '開團意願／日期']}>
      {items.map((r) => (
        <tr key={r.id} data-testid={`collab-mini-row-${r.id}`}>
          <td><Link href={`/collaboration/${r.id}`}><strong>{r.id}</strong></Link><div className="small muted">{fmtDate(r.appliedOn)}</div></td>
          <td className="small">{r.vendorName}<div className="muted">{r.hostName}</div></td>
          <td className="small">{r.productName ?? '—'}{r.itemCount > 1 ? ` 等 ${r.itemCount} 項` : ''}</td>
          <td><StatusBadge map={APP_STATUS} value={r.status} /><div className="small"><StatusBadge map={COLLAB_STATUS} value={r.collaborationStatus} /></div></td>
          <td><StatusBadge map={SAMPLE_PROGRESS} value={r.sample.progress} />{r.sample.resent ? <> <Badge tone="info">已補寄</Badge></> : null}</td>
          <td className="small"><StatusBadge map={INTENT} value={r.intent ?? 'PENDING'} />
            <div className="muted">預計 {fmtDate(r.plannedOpenDate)}／已確認 {fmtDate(r.confirmedOpenDate)}</div>
            {r.campaignId ? <div><Link href={`/campaigns/${r.campaignId}`}>{r.campaignTitle ?? r.campaignId}</Link></div> : null}</td>
        </tr>
      ))}
    </Table>
  );
}

/** 團主頁：這位團主的樣品申請（同一個 Host ID，不另建團主名單） */
export async function HostCollaborationCard({ actor, hostId }: { actor: Actor; hostId: string }) {
  const res = as<{ items: AppRowV[]; total: number }>(await hostApplications(actor, hostId));
  return (
    <Card title={`網紅合作申請與樣品（${res.total}）`} flush testid="host-collaboration"
      actions={can(actor, 'collaboration.create') ? <Link className="btn sm" href={`/collaboration/new?hostId=${hostId}`} data-testid="btn-new-collab-host">建立申請</Link> : undefined}>
      {res.items.length === 0 ? <EmptyState title="這位團主還沒有樣品申請" /> : <Rows items={res.items} />}
      <p className="small muted" style={{ padding: '0 16px 12px' }}>收件人姓名、電話與地址不會寫回團主主檔，只存在各自的申請單裡，而且有保留期限。</p>
    </Card>
  );
}

/** 廠商頁：網紅申請與樣品寄送的統計 */
export async function VendorCollaborationCard({ actor, vendorId }: { actor: Actor; vendorId: string }) {
  const s = as<{ hostCount: number; pendingReview: number; shippedSamples: number; confirmedCollaborations: number; awaitingIntent: number }>(await vendorSummary(actor, vendorId));
  return (
    <Card title="網紅申請與樣品寄送" testid="vendor-collaboration"
      actions={<Link className="btn sm" href={`/collaboration?vendorId=${vendorId}`} data-testid="btn-vendor-collab-list">看申請清單</Link>}>
      <div className="grid cols-5">
        <KpiCard id="collab-hosts" label="合作過的團主" value={String(s.hostCount)} />
        <KpiCard id="collab-pending" label="待審核" value={String(s.pendingReview)} />
        <KpiCard id="collab-shipped" label="已寄出樣品" value={String(s.shippedSamples)} note="含補寄" />
        <KpiCard id="collab-awaiting" label="團主待回覆" value={String(s.awaitingIntent)} />
        <KpiCard id="collab-confirmed" label="已確認合作" value={String(s.confirmedCollaborations)} note="不等於已建檔期" />
      </div>
    </Card>
  );
}

/** 商品頁：這個商品被申請樣品的歷史（規格是同一商品的選項，不是另一個商品） */
export async function ProductCollaborationCard({ actor, productId }: { actor: Actor; productId: string }) {
  const res = as<{ items: AppRowV[]; total: number }>(await productApplications(actor, productId));
  return (
    <Card title={`樣品申請歷史（${res.total}）`} flush testid="product-collaboration">
      {res.items.length === 0 ? <EmptyState title="這個商品還沒有樣品申請" /> : <Rows items={res.items} />}
    </Card>
  );
}
