import Link from 'next/link';
import { withActor, sp1, toQuery, type SP } from '@/server/ui/session';
import { can, isInternal, type Actor } from '@/server/lib/permissions';
import { listApplications, overview } from '@/server/modules/collaboration';
import { listUnassigned } from '@/server/modules/collaboration-assignment';
import { ActionButton } from '@/ui/ActionButton';
import { hostOptions, vendorOptions } from '@/server/ui/options';
import { listAssignableUsers } from '@/server/ui/lookups';
import { Badge, Banner, Card, EmptyState, Filters, KpiCard, PageHeader, Pagination, StatusBadge, Table } from '@/ui/components';
import { fmtDate } from '@/ui/format';
import { as, type Paged } from '@/ui/types';
import { ADS_INTENT, APP_STATUS, BACKEND_SETUP, BUCKET, COLLAB_STATUS, COLLAB_STATUS as CS, INTENT, SAMPLE_PROGRESS, SOURCE } from './labels';

export const dynamic = 'force-dynamic';

export interface AppRowV {
  id: string; vendorId: string; hostId: string; productId: string | null; source: string; appliedOn: string;
  status: string; collaborationStatus: string; campaignId: string | null; note: string | null;
  hostName: string; vendorName: string; productName: string | null; campaignTitle: string | null; ownerName: string | null;
  intent: string | null; plannedOpenDate: string | null; confirmedOpenDate: string | null; launchUrl: string | null;
  adsIntent: string | null; backendSetupStatus: string | null;
  itemCount: number; recipientConfirmed: boolean;
  sample: { progress: string; resent: boolean; resendPending: boolean; lastShipDate: string | null };
  sampleBucket: string;
}

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const internal = isInternal(actor);
  const res = as<Paged<AppRowV>>(await listApplications(actor, toQuery({ ...q, limit: q.limit ?? '50' })));
  const ov = await overview(actor);
  const queue = internal && (ov.unassigned ?? 0) > 0
    ? as<{ items: { id: string; hostName: string; vendorName: string; productName: string | null; status: string; daysWaiting: number; formerOwnerName: string | null }[] }>(await listUnassigned(actor, toQuery({ limit: '10' }))).items
    : [];
  const base = Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'page'));
  const [vendors, hosts, owners] = await Promise.all([
    internal ? vendorOptions(actor) : Promise.resolve([]),
    internal ? hostOptions(actor) : Promise.resolve([]),
    internal ? listAssignableUsers(actor).catch(() => []) : Promise.resolve([]),
  ]);

  return (
    <>
      <PageHeader
        title="網紅合作申請"
        sub="同一筆案件、不同授權視角：營運在這裡追蹤樣品申請、寄送、團主開團意願與正式檔期。樣品申請不扣庫存、不產生結算，也不會自動變成檔期。"
        actions={<div className="btn-row">
          {can(actor, 'collaboration.create') ? <Link className="btn primary" href="/collaboration/new" data-testid="btn-new-application">＋ 新增合作申請</Link> : null}
          {can(actor, 'collaboration.export') ? (
            <>
              <a className="btn sm" href={`/api/collaboration/applications/export?${new URLSearchParams({ ...base, form: 'form2' }).toString()}`} data-testid="btn-export-form2">匯出表單二</a>
              <a className="btn sm" href={`/api/collaboration/applications/export?${new URLSearchParams({ ...base, form: 'form1' }).toString()}`} data-testid="btn-export-form1">匯出表單一</a>
            </>
          ) : null}
          {internal && can(actor, 'collaboration.create') ? <Link className="btn sm" href="/collaboration/import" data-testid="btn-import">匯入歷史表單</Link> : null}
        </div>}
      />

      <div className="grid cols-4" data-testid="collab-buckets">
        {['PENDING_VENDOR_REVIEW', 'TO_SHIP', 'RESEND_PENDING', 'AWAITING_HOST_INTENT'].map((k) => (
          <KpiCard key={k} id={`collab-${k}`} label={BUCKET[k].label} note={BUCKET[k].hint}
            value={String(ov.buckets.find((b) => b.bucket === k)?.count ?? 0)} />
        ))}
      </div>

      {internal && (ov.unassigned ?? 0) > 0 ? (
        <Card title={`待指派佇列（${ov.unassigned}）`} flush testid="unassigned-queue">
          <Banner kind="warn">這些申請目前沒有有效的主要承辦人，只有營運主管看得到完整內容。營運小編可在這裡認領，認領後才能開啟案件與處理收件資料。</Banner>
          <Table head={['申請單', '團主', '廠商／商品', '狀態', '等待天數', '']} testid="unassigned-table">
            {queue.map((q2) => (
              <tr key={q2.id} data-testid={`unassigned-row-${q2.id}`}>
                <td><strong>{q2.id}</strong>{q2.formerOwnerName ? <div className="small muted">原承辦：{q2.formerOwnerName}（已停用）</div> : null}</td>
                <td>{q2.hostName}</td>
                <td>{q2.vendorName}<div className="small muted">{q2.productName ?? '—'}</div></td>
                <td><StatusBadge map={APP_STATUS} value={q2.status} /></td>
                <td>{q2.daysWaiting}</td>
                <td>{can(actor, 'collaboration.assign') ? <Link className="btn sm" href={`/collaboration/${q2.id}`} data-testid={`btn-open-unassigned-${q2.id}`}>指派</Link>
                  : <ActionButton endpoint={`/api/collaboration/applications/${q2.id}/claim`} label="認領" small variant="primary" testid={`btn-claim-${q2.id}`} successMessage="已認領" />}</td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : null}

      <Filters>
        <label>月份<input name="month" defaultValue={q.month} placeholder="2026-11" data-testid="filter-month" /></label>
        {internal ? <label>廠商<select name="vendorId" defaultValue={q.vendorId ?? ''} data-testid="filter-vendor"><option value="">全部</option>{vendors.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label> : null}
        {internal ? <label>團主<select name="hostId" defaultValue={q.hostId ?? ''} data-testid="filter-host"><option value="">全部</option>{hosts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label> : null}
        <label>申請狀態<select name="status" defaultValue={q.status ?? ''} data-testid="filter-status"><option value="">全部</option>{Object.entries(APP_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
        <label>合作狀態<select name="collaborationStatus" defaultValue={q.collaborationStatus ?? ''} data-testid="filter-collab-status"><option value="">全部</option>{Object.entries(CS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
        <label>寄送進度<select name="shipment" defaultValue={q.shipment ?? ''} data-testid="filter-shipment">
          <option value="">全部</option>
          <option value="TO_SHIP">待寄出</option><option value="SHIPPED">已寄出</option>
          <option value="RESEND_PENDING">待補寄</option><option value="RESENT">已補寄</option><option value="DELIVERED">已確認收件</option>
        </select></label>
        <label>開團意願<select name="intent" defaultValue={q.intent ?? ''} data-testid="filter-intent"><option value="">全部</option>{Object.entries(INTENT).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
        <label>投廣<select name="adsIntent" defaultValue={q.adsIntent ?? ''} data-testid="filter-ads"><option value="">全部</option>{Object.entries(ADS_INTENT).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
        <label>後台設定<select name="backendSetupStatus" defaultValue={q.backendSetupStatus ?? ''} data-testid="filter-backend"><option value="">全部</option>{Object.entries(BACKEND_SETUP).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
        {internal ? <label>主要承辦人<select name="ownerUserId" defaultValue={q.ownerUserId ?? ''} data-testid="filter-owner"><option value="">全部</option>{owners.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label> : null}
        <label>預計開團日（起）<input type="date" name="plannedFrom" defaultValue={q.plannedFrom} data-testid="filter-planned-from" /></label>
        <label>預計開團日（迄）<input type="date" name="plannedTo" defaultValue={q.plannedTo} data-testid="filter-planned-to" /></label>
        <label>已確認開團日（起）<input type="date" name="confirmedFrom" defaultValue={q.confirmedFrom} data-testid="filter-confirmed-from" /></label>
        <label>已確認開團日（迄）<input type="date" name="confirmedTo" defaultValue={q.confirmedTo} data-testid="filter-confirmed-to" /></label>
        <label>搜尋<input name="q" defaultValue={q.q} placeholder="申請單號／團主／廠商／商品" data-testid="filter-q" /></label>
        <label>排序<select name="sort" defaultValue={q.sort ?? ''} data-testid="filter-sort">
          <option value="">申請日期</option><option value="plannedOpenDate">預計開團日</option>
          <option value="confirmedOpenDate">已確認開團日</option><option value="host">團主</option>
          <option value="vendor">廠商</option><option value="updatedAt">最近更新</option>
        </select></label>
      </Filters>

      <Banner kind="nodata">「是否已補寄」是從寄送紀錄推導出來的，不是打勾欄位——只有真的建立了補寄紀錄並填上寄出日期才會顯示已補寄。收件人姓名、電話與地址不在這張表上，要看必須進到案件裡，而且每次讀取都會留下稽核紀錄。</Banner>

      <Card flush testid="collab-list" title={`合作申請（${res.total}）`}>
        {res.items.length === 0 ? <EmptyState title="還沒有合作申請" hint={can(actor, 'collaboration.create') ? '用右上角「新增合作申請」建立第一筆' : undefined} /> : (
          <Table head={['申請單', '團主', '廠商／商品', '申請狀態', '合作狀態', '樣品進度', '開團意願', '預計／已確認開團', '']} testid="collab-table">
            {res.items.map((r) => <Row key={r.id} r={r} actor={actor} />)}
          </Table>
        )}
        <Pagination total={res.total} limit={res.limit} offset={res.offset} base={base} />
      </Card>
    </>
  );
});

function Row({ r, actor }: { r: AppRowV; actor: Actor }) {
  return (
    <tr data-testid={`collab-row-${r.id}`}>
      <td>
        <Link href={`/collaboration/${r.id}`} data-testid={`collab-link-${r.id}`}><strong>{r.id}</strong></Link>
        <div className="small muted">{fmtDate(r.appliedOn)} · {SOURCE[r.source] ?? r.source}</div>
      </td>
      <td>
        <Link href={`/hosts/${r.hostId}`}>{r.hostName}</Link>
        {r.recipientConfirmed ? <div className="small muted">收件資料已確認</div> : <div className="small muted">收件資料未確認</div>}
      </td>
      <td>
        <Link href={`/vendors/${r.vendorId}`}>{r.vendorName}</Link>
        <div className="small muted">{r.productName ?? '—'}{r.itemCount > 1 ? ` 等 ${r.itemCount} 項` : ''}</div>
      </td>
      <td><StatusBadge map={APP_STATUS} value={r.status} testid={`collab-status-${r.id}`} /></td>
      <td>
        <StatusBadge map={COLLAB_STATUS} value={r.collaborationStatus} />
        {r.campaignId ? <div className="small muted"><Link href={`/campaigns/${r.campaignId}`}>{r.campaignTitle ?? r.campaignId}</Link></div> : null}
      </td>
      <td>
        <StatusBadge map={SAMPLE_PROGRESS} value={r.sample.progress} testid={`collab-sample-${r.id}`} />
        {r.sample.resent ? <> <Badge tone="info">已補寄</Badge></> : null}
        {r.sample.lastShipDate ? <div className="small muted">最後寄出 {fmtDate(r.sample.lastShipDate)}</div> : null}
      </td>
      <td>
        <StatusBadge map={INTENT} value={r.intent ?? 'PENDING'} />
        {r.adsIntent && r.adsIntent !== 'PENDING' ? <div className="small muted">{ADS_INTENT[r.adsIntent]?.label}</div> : null}
      </td>
      <td className="nowrap">
        <div className="small">預計 {fmtDate(r.plannedOpenDate)}</div>
        <div className="small"><strong>已確認 {fmtDate(r.confirmedOpenDate)}</strong></div>
      </td>
      <td><Link className="btn sm" href={`/collaboration/${r.id}`}>{can(actor, 'collaboration.update') ? '處理' : '查看'}</Link></td>
    </tr>
  );
}
