import Link from 'next/link';
import { withActor, sp1, toQuery, type SP } from '@/server/ui/session';
import { can } from '@/server/lib/permissions';
import { forbidden } from '@/server/lib/errors';
import { listApplications, overview } from '@/server/modules/collaboration';
import { Badge, Banner, Card, EmptyState, KpiCard, PageHeader, Pagination, StatusBadge, Table } from '@/ui/components';
import { fmtDate } from '@/ui/format';
import { as, type Paged } from '@/ui/types';
import type { AppRowV } from '../page';
import { APP_STATUS, BUCKET, COLLAB_STATUS, INTENT, SAMPLE_PROGRESS, VENDOR_BUCKET_ORDER } from '../labels';

export const dynamic = 'force-dynamic';

/** 分桶 → 列表查詢參數（讓每個桶點進去就是已篩好的清單） */
const BUCKET_QUERY: Record<string, Record<string, string>> = {
  PENDING_VENDOR_REVIEW: { status: 'VENDOR_REVIEW' },
  TO_SHIP: { status: 'APPROVED', shipment: 'TO_SHIP' },
  SHIPPED: { status: 'APPROVED', shipment: 'SHIPPED' },
  RESEND_PENDING: { shipment: 'RESEND_PENDING' },
  AWAITING_HOST_INTENT: { shipment: 'DELIVERED', intent: 'PENDING' },
  TO_LINK_CAMPAIGN: { collaborationStatus: 'COLLABORATION_CONFIRMED' },
  CAMPAIGN_LINKED: { collaborationStatus: 'CAMPAIGN_LINKED' },
};

export default withActor(async (actor, props: { searchParams: SP }) => {
  if (!can(actor, 'collaboration.self') && !can(actor, 'collaboration.read')) throw forbidden();
  const q = await sp1(props.searchParams);
  const bucket = BUCKET_QUERY[q.bucket ?? ''] ? (q.bucket as string) : '';
  const listQuery = { ...(bucket ? BUCKET_QUERY[bucket] : {}), limit: '50', ...(q.page ? { page: q.page } : {}) };
  const res = as<Paged<AppRowV>>(await listApplications(actor, toQuery(listQuery)));
  const ov = await overview(actor);
  const count = (k: string) => ov.buckets.find((b) => b.bucket === k)?.count ?? 0;

  return (
    <>
      <PageHeader title="網紅申請與樣品寄送"
        sub="你負責的樣品申請：確認供樣、安排寄送與補寄、追蹤團主回覆與正式開團。收件人姓名、電話與地址只在寄送所需的期間提供，而且每次讀取都會留下紀錄。"
        actions={<div className="btn-row">
          {can(actor, 'collaboration.create') ? <Link className="btn primary" href="/collaboration/new" data-testid="btn-new-application">＋ 代團主建立申請</Link> : null}
          {can(actor, 'collaboration.export') ? <a className="btn sm" href="/api/collaboration/applications/export?form=form2" data-testid="btn-export">匯出（收件個資會遮罩）</a> : null}
        </div>} />

      <Banner kind="warn">確認供樣只影響這裡的樣品流程，不等於公司的 G1～G5 核准，也不會自動建立檔期。</Banner>

      <div className="grid cols-4" data-testid="vendor-buckets">
        {VENDOR_BUCKET_ORDER.map((k) => (
          <KpiCard key={k} id={`vendor-bucket-${k}`} label={BUCKET[k].label} value={String(count(k))} note={BUCKET[k].hint}
            href={`/collaboration/vendor?bucket=${k}`} />
        ))}
      </div>

      <Card flush testid="vendor-list"
        title={bucket ? `${BUCKET[bucket].label}（${res.total}）` : `全部申請（${res.total}）`}
        actions={bucket ? <Link className="btn sm" href="/collaboration/vendor" data-testid="btn-clear-bucket">看全部</Link> : undefined}>
        {res.items.length === 0 ? <EmptyState title="這個分類目前沒有案件" /> : (
          <Table head={['申請單', '團主', '商品', '申請狀態', '樣品進度', '開團意願／日期', '']} testid="vendor-table">
            {res.items.map((r) => (
              <tr key={r.id} data-testid={`vendor-row-${r.id}`}>
                <td><Link href={`/collaboration/${r.id}`}><strong>{r.id}</strong></Link><div className="small muted">{fmtDate(r.appliedOn)}</div></td>
                <td>{r.hostName}</td>
                <td className="small">{r.productName ?? '—'}{r.itemCount > 1 ? ` 等 ${r.itemCount} 項` : ''}</td>
                <td><StatusBadge map={APP_STATUS} value={r.status} /><div className="small"><StatusBadge map={COLLAB_STATUS} value={r.collaborationStatus} /></div></td>
                <td>
                  <StatusBadge map={SAMPLE_PROGRESS} value={r.sample.progress} />
                  {r.sample.resent ? <> <Badge tone="info">已補寄</Badge></> : null}
                  {r.sample.lastShipDate ? <div className="small muted">最後寄出 {fmtDate(r.sample.lastShipDate)}</div> : null}
                </td>
                <td>
                  <StatusBadge map={INTENT} value={r.intent ?? 'PENDING'} />
                  <div className="small muted">預計 {fmtDate(r.plannedOpenDate)}／已確認 {fmtDate(r.confirmedOpenDate)}</div>
                </td>
                <td><Link className="btn sm" href={`/collaboration/${r.id}`}>處理</Link></td>
              </tr>
            ))}
          </Table>
        )}
        <Pagination total={res.total} limit={res.limit} offset={res.offset} base={bucket ? { bucket } : {}} />
      </Card>
    </>
  );
});
