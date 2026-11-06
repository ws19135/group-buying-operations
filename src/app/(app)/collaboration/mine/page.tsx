import Link from 'next/link';
import { withActor, sp1, toQuery, type SP } from '@/server/ui/session';
import { can } from '@/server/lib/permissions';
import { forbidden } from '@/server/lib/errors';
import { listApplications } from '@/server/modules/collaboration';
import { Badge, Banner, Card, EmptyState, PageHeader, Pagination, StatusBadge } from '@/ui/components';
import { fmtDate } from '@/ui/format';
import { as, type Paged } from '@/ui/types';
import type { AppRowV } from '../page';
import { APP_STATUS, COLLAB_STATUS, INTENT, SAMPLE_PROGRESS } from '../labels';

export const dynamic = 'force-dynamic';

/**
 * 團主工作台 → 我的樣品申請。
 * 手機上也要能用，所以不用表格，改成一張一張的卡片（窄螢幕不會橫向捲動）。
 */
export default withActor(async (actor, props: { searchParams: SP }) => {
  if (!can(actor, 'collaboration.self') && !can(actor, 'collaboration.read')) throw forbidden();
  const q = await sp1(props.searchParams);
  const res = as<Paged<AppRowV>>(await listApplications(actor, toQuery({ limit: '20', ...(q.page ? { page: q.page } : {}) })));

  return (
    <>
      <PageHeader title="我的樣品申請"
        sub="你申請過的樣品、寄送進度，以及要回覆的開團意願。"
        actions={can(actor, 'collaboration.create') ? <Link className="btn primary" href="/collaboration/new" data-testid="btn-new-application">＋ 申請樣品</Link> : undefined} />
      <Banner kind="nodata">收件人姓名、電話與地址只會提供給需要寄送的廠商，而且過了保留期就會清除。你隨時可以在案件裡更新。</Banner>

      {res.items.length === 0 ? <EmptyState title="還沒有樣品申請" hint={can(actor, 'collaboration.create') ? '用右上角「申請樣品」開始' : undefined} /> : (
        <div data-testid="mine-list">
          {res.items.map((r) => (
            <Card key={r.id} testid={`mine-card-${r.id}`}
              title={<Link href={`/collaboration/${r.id}`}>{r.productName ?? r.id}</Link>}
              actions={<StatusBadge map={APP_STATUS} value={r.status} />}>
              <p className="small muted">{r.vendorName} · 申請於 {fmtDate(r.appliedOn)} · {r.id}</p>
              <dl className="kv">
                <dt>合作狀態</dt><dd><StatusBadge map={COLLAB_STATUS} value={r.collaborationStatus} /></dd>
                <dt>樣品進度</dt>
                <dd>
                  <StatusBadge map={SAMPLE_PROGRESS} value={r.sample.progress} />
                  {r.sample.resent ? <> <Badge tone="info">已補寄</Badge></> : null}
                  {r.sample.lastShipDate ? <div className="small muted">最後寄出 {fmtDate(r.sample.lastShipDate)}</div> : null}
                </dd>
                <dt>收件資料</dt><dd>{r.recipientConfirmed ? '已確認' : <strong>尚未確認，請補填</strong>}</dd>
                <dt>開團意願</dt><dd><StatusBadge map={INTENT} value={r.intent ?? 'PENDING'} /></dd>
                <dt>預計開團日</dt><dd>{fmtDate(r.plannedOpenDate)}</dd>
                <dt>已確認開團日</dt><dd>{fmtDate(r.confirmedOpenDate)}</dd>
              </dl>
              <Link className="btn sm" href={`/collaboration/${r.id}`} data-testid={`mine-open-${r.id}`}>查看與回覆</Link>
            </Card>
          ))}
        </div>
      )}
      <Pagination total={res.total} limit={res.limit} offset={res.offset} base={{}} />
    </>
  );
});
