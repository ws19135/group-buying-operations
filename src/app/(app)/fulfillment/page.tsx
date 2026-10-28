import Link from 'next/link';
import { query } from '@/server/lib/db';
import { withActor, sp1, toQuery, type SP } from '@/server/ui/session';
import { campaignScope } from '@/server/lib/scope';
import { can, isInternal } from '@/server/lib/permissions';
import { getCampaignFulfillment, listBatches, listMovements, listStock } from '@/server/modules/fulfillment';
import { ActionButton } from '@/ui/ActionButton';
import { ApiForm } from '@/ui/ApiForm';
import { Modal } from '@/ui/Modal';
import { Badge, Banner, Card, EmptyState, Filters, KpiCard, PageHeader, Pagination, StatusBadge, Table, Tabs } from '@/ui/components';
import { CAMPAIGN_STATUS } from '@/ui/labels';
import { fmtDate, fmtDateTime, num } from '@/ui/format';
import { as, type Paged } from '@/ui/types';
import { ADJUST_REASON_OPTIONS, BATCH_KIND, MOVE_REASON, SHIPMENT_STATUS } from './labels';

export const dynamic = 'force-dynamic';

interface BatchRow {
  id: string; campaignId: string; campaignTitle: string; campaignStatus: string; kind: string; label: string; status: string; plannedShipDate: string | null;
  shipmentCount: number; deliveredCount: number; exceptionCount: number; confirmedCount: number; totalQuantity: number;
}
interface StockRow { skuId: string; skuCode: string; skuName: string; productId: string; productName: string; balance: number; tracked: boolean; lastMovementAt: string | null }
interface MoveRow { id: string; skuId: string; skuCode: string; skuName: string; productName: string; campaignId: string | null; delta: number; reasonCode: string; reason: string; reversesId: string | null; createdAt: string; reversed: boolean }

async function campaignOptions(actor: Parameters<typeof campaignScope>[0], kindOrderOnly = false) {
  const sc = campaignScope(actor, 1, 'c');
  if (sc.sql === 'FALSE') return [];
  const rows = await query<{ id: string; title: string; status: string }>(
    `SELECT c.id, c.title, c.status FROM campaigns c WHERE (${sc.sql}) AND c.status NOT IN ('CANCELLED','CLOSED','ON_HOLD') ORDER BY c.created_at DESC LIMIT 200`, sc.params);
  return rows.filter((r) => !kindOrderOnly || ['SCHEDULED', 'RUNNING', 'PENDING_CLOSE_CHECK', 'FULFILLING', 'PENDING_SETTLEMENT', 'SETTLED'].includes(r.status))
    .map((r) => ({ value: r.id, label: `${r.title}（${r.id}）` }));
}

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const internal = isInternal(actor);
  const tab = internal && q.tab === 'stock' ? 'stock' : 'batches';
  const canWrite = can(actor, 'fulfillment.write');
  const tabs = internal ? [{ key: 'batches', label: '出貨批次' }, { key: 'stock', label: '庫存' }] : [];
  return (
    <>
      <PageHeader title="履約與出貨" sub="追蹤每個檔期的出貨批次、出貨單、簽收與庫存。物流資訊為人工登錄，不連接任何物流商系統。" />
      {tabs.length ? <Tabs tabs={tabs} current={tab} base="/fulfillment" /> : null}
      {tab === 'stock' ? await StockTab(actor, q, canWrite) : await BatchTab(actor, q, canWrite)}
    </>
  );
});

async function BatchTab(actor: Parameters<typeof campaignScope>[0], q: Record<string, string>, canWrite: boolean) {
  const res = as<Paged<BatchRow>>(await listBatches(actor, toQuery(q)));
  const summary = q.campaignId ? await getCampaignFulfillment(actor, q.campaignId).catch(() => null) : null;
  const base = Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'page'));
  const opts = canWrite ? await campaignOptions(actor) : [];
  return (
    <>
      {summary ? (
        <Card title={`檔期：${summary.campaignTitle as string}`} testid="campaign-summary" actions={<StatusBadge map={CAMPAIGN_STATUS} value={summary.campaignStatus as string} />}>
          <div className="grid cols-4">
            <KpiCard id="ful-batches" label="有效批次" value={num(summary.totals.batches)} />
            <KpiCard id="ful-shipments" label="出貨單" value={num(summary.totals.shipments)} note={`共 ${num(summary.totals.quantity)} 件`} />
            <KpiCard id="ful-delivered" label="已送達" value={num(summary.totals.delivered)} note={`已簽收確認 ${summary.totals.confirmed}`} />
            <KpiCard id="ful-exception" label="異常" value={num(summary.totals.exception)} />
          </div>
          {summary.warnings.length ? summary.warnings.map((w) => <Banner key={`${w.code}-${w.refId ?? ''}`} kind="warn" testid={`warn-${w.code}`}>{w.severity === 'WARN' ? '⚠️ ' : 'ℹ️ '}{w.message}</Banner>) : <p className="small muted">目前沒有履約提醒。</p>}
          <p className="small muted">提醒只是顯示，不會阻擋任何核准或狀態轉換。<Link href={`/campaigns/${summary.campaignId as string}`}>回到檔期</Link></p>
        </Card>
      ) : null}
      <Filters>
        <label>狀態<select name="status" defaultValue={q.status ?? ''} data-testid="filter-status"><option value="">全部</option>{Object.entries(SHIPMENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
        <label>類型<select name="kind" defaultValue={q.kind ?? ''} data-testid="filter-kind"><option value="">全部</option>{Object.entries(BATCH_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        {q.campaignId ? <input type="hidden" name="campaignId" value={q.campaignId} /> : null}
        <label><input type="checkbox" name="open" value="1" defaultChecked={q.open === '1'} /> 只看未完成</label>
      </Filters>
      <Card flush testid="batch-list" title="出貨批次" actions={canWrite ? (
        <Modal label="＋ 新增出貨批次" title="新增出貨批次" variant="primary" size="btn sm" testid="btn-create-batch">
          <ApiForm endpoint="/api/fulfillment/batches" method="POST" submitLabel="建立批次" testid="form-create-batch"
            fields={[
              { name: 'campaignId', label: '檔期', type: 'select', required: true, options: opts, defaultValue: q.campaignId ?? '', help: '訂單出貨最早從「已排程」的檔期開始；寄樣可在籌備期建立' },
              { name: 'kind', label: '類型', type: 'select', required: true, defaultValue: 'ORDER', options: Object.entries(BATCH_KIND).map(([value, label]) => ({ value, label })) },
              { name: 'label', label: '批次名稱', required: true, placeholder: '例如：第一批出貨' },
              { name: 'plannedShipDate', label: '預計出貨日', type: 'date' },
              { name: 'note', label: '內部備註', type: 'textarea', help: '團主與廠商看不到' },
            ]} />
        </Modal>
      ) : undefined}>
        {res.items.length === 0 ? <EmptyState title="還沒有出貨批次" hint={canWrite ? '用右上角「新增出貨批次」建立第一批' : undefined} /> : (
          <Table head={['批次', '檔期', '類型', '狀態', '出貨單', '送達／簽收', '預計出貨', '']} testid="batches-table">
            {res.items.map((b) => (
              <tr key={b.id} data-testid={`batch-row-${b.id}`}>
                <td><Link href={`/fulfillment/${b.id}`} data-testid={`batch-link-${b.id}`}><strong>{b.label}</strong></Link><div className="small muted">{b.id}</div></td>
                <td><Link href={`/fulfillment?campaignId=${b.campaignId}`}>{b.campaignTitle}</Link><div className="small muted">{b.campaignId}</div></td>
                <td>{BATCH_KIND[b.kind] ?? b.kind}</td>
                <td><StatusBadge map={SHIPMENT_STATUS} value={b.status} /></td>
                <td>{b.shipmentCount} 張／{num(b.totalQuantity)} 件{b.exceptionCount ? <> <Badge tone="danger">異常 {b.exceptionCount}</Badge></> : null}</td>
                <td>{b.deliveredCount} ／ {b.confirmedCount}</td>
                <td className="nowrap">{fmtDate(b.plannedShipDate)}</td>
                <td><Link className="btn sm" href={`/fulfillment/${b.id}`}>查看</Link></td>
              </tr>
            ))}
          </Table>
        )}
        <Pagination total={res.total} limit={res.limit} offset={res.offset} base={base} />
      </Card>
    </>
  );
}

async function StockTab(actor: Parameters<typeof campaignScope>[0], q: Record<string, string>, canWrite: boolean) {
  const qs = toQuery({ ...(q.campaignId ? { campaignId: q.campaignId } : {}), ...(q.tracked ? { tracked: q.tracked } : {}), ...(q.page ? { page: q.page } : {}) });
  const res = as<Paged<StockRow>>(await listStock(actor, qs));
  const moves = q.sku ? as<Paged<MoveRow>>(await listMovements(actor, toQuery({ skuId: q.sku, limit: '50' }))) : null;
  const base = Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'page'));
  return (
    <>
      <Banner kind="demo">庫存是「異動加總」：每筆異動只能新增、不能修改或刪除；填錯請用「更正」（會新增一筆相反的紀錄）。庫存不會自動隨出貨扣除。</Banner>
      <Filters>
        <input type="hidden" name="tab" value="stock" />
        <label>檔期編號<input name="campaignId" defaultValue={q.campaignId} placeholder="CMP-…" data-testid="filter-campaign" /></label>
        <label><input type="checkbox" name="tracked" value="1" defaultChecked={q.tracked === '1'} /> 只看已建立庫存</label>
      </Filters>
      <Card flush testid="stock-list" title="各規格目前庫存">
        {res.items.length === 0 ? <EmptyState title="沒有符合的規格" /> : (
          <Table head={['商品／規格', '目前庫存', '最近異動', '']} testid="stock-table">
            {res.items.map((s) => (
              <tr key={s.skuId} data-testid={`stock-row-${s.skuId}`}>
                <td><strong>{s.productName}</strong><div className="small muted">{s.skuName}（{s.skuCode}）· {s.skuId}</div></td>
                <td data-testid={`stock-balance-${s.skuId}`}>{s.tracked ? <strong>{num(s.balance)}</strong> : <span className="muted">未建立</span>}</td>
                <td className="small">{fmtDateTime(s.lastMovementAt)}</td>
                <td><div className="btn-row">
                  <Link className="btn sm" href={`?${new URLSearchParams({ ...base, tab: 'stock', sku: s.skuId }).toString()}`} data-testid={`btn-history-${s.skuId}`}>異動紀錄</Link>
                  {canWrite ? (
                    <Modal label="調整庫存" title={`調整庫存：${s.productName} ${s.skuName}`} size="btn sm" testid={`btn-adjust-${s.skuId}`}>
                      <ApiForm endpoint="/api/inventory/movements" submitLabel="送出" idempotent testid={`form-adjust-${s.skuId}`} extra={{ skuId: s.skuId }}
                        fields={[
                          { name: 'reasonCode', label: '原因類型', type: 'select', required: true, defaultValue: s.tracked ? 'RESTOCK' : 'INITIAL', options: ADJUST_REASON_OPTIONS },
                          { name: 'delta', label: '異動數量', type: 'number', required: true, help: '入庫填正數、損耗／盤虧填負數；庫存不可變成負數' },
                          { name: 'reason', label: '說明', type: 'textarea', required: true },
                        ]} />
                    </Modal>
                  ) : null}
                </div></td>
              </tr>
            ))}
          </Table>
        )}
        <Pagination total={res.total} limit={res.limit} offset={res.offset} base={base} />
      </Card>
      {moves ? (
        <Card flush testid="movement-list" title={`異動紀錄：${q.sku}`}>
          {moves.items.length === 0 ? <EmptyState title="這個規格還沒有異動" /> : (
            <Table head={['時間', '類型', '數量', '說明', '']}>
              {moves.items.map((m) => (
                <tr key={m.id} data-testid={`move-row-${m.id}`}>
                  <td className="small">{fmtDateTime(m.createdAt)}<div className="muted">{m.id}</div></td>
                  <td>{MOVE_REASON[m.reasonCode] ?? m.reasonCode}</td>
                  <td><strong style={{ color: m.delta < 0 ? 'var(--danger, #b42318)' : undefined }}>{m.delta > 0 ? `+${m.delta}` : m.delta}</strong></td>
                  <td>{m.reason}{m.reversesId ? <div className="small muted">更正 {m.reversesId}</div> : null}</td>
                  <td>{m.reversed ? <Badge tone="neutral">已被更正</Badge> : canWrite && m.reasonCode !== 'CORRECTION' ? (
                    <ActionButton endpoint={`/api/inventory/movements/${m.id}/correct`} label="更正" small reasonLabel="更正原因" confirm="會新增一筆相反數量的紀錄，原紀錄保留。" testid={`btn-correct-${m.id}`} />
                  ) : null}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      ) : null}
    </>
  );
}
