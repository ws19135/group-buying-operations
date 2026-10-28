import Link from 'next/link';
import { withActor, type Params } from '@/server/ui/session';
import { query } from '@/server/lib/db';
import { can, isInternal } from '@/server/lib/permissions';
import { SHIPMENT_TRANSITIONS, getBatch } from '@/server/modules/fulfillment';
import { ActionButton } from '@/ui/ActionButton';
import { ApiForm } from '@/ui/ApiForm';
import { Modal } from '@/ui/Modal';
import { Badge, Banner, Card, EmptyState, Kv, PageHeader, StatusBadge, Table } from '@/ui/components';
import { CAMPAIGN_STATUS } from '@/ui/labels';
import { fmtDate, fmtDateTime, num } from '@/ui/format';
import { as } from '@/ui/types';
import { BATCH_KIND, SHIPMENT_STATUS } from '../labels';

export const dynamic = 'force-dynamic';

interface Shipment {
  id: string; skuId: string | null; skuCode: string | null; skuName: string | null; productName: string | null; quantity: number; carrier: string | null; trackingNo: string | null;
  status: string; plannedDate: string | null; shippedDate: string | null; deliveredDate: string | null; exceptionReason: string | null; cancelReason: string | null;
  receiptConfirmedAt: string | null; receiptSigner: string | null; receiptNote: string | null; note?: string | null; version: number;
}
interface Batch {
  id: string; campaignId: string; campaignTitle: string; campaignStatus: string; kind: string; label: string; status: string; plannedShipDate: string | null; note?: string | null;
  cancelReason: string | null; shipmentCount: number; deliveredCount: number; confirmedCount: number; totalQuantity: number; version: number; shipments: Shipment[];
}

export default withActor(async (actor, props: { params: Params }) => {
  const { id } = await props.params;
  const b = as<Batch>(await getBatch(actor, id));
  const internal = isInternal(actor);
  const writable = can(actor, 'fulfillment.write') && !['CANCELLED', 'CLOSED', 'ON_HOLD'].includes(b.campaignStatus) && b.status !== 'CANCELLED';
  const skuOpts = writable
    ? (await query<{ id: string; name: string; code: string; pname: string }>(
      `SELECT k.id, k.name, k.sku_code AS code, p.name AS pname FROM campaign_products cp JOIN skus k ON k.id=cp.sku_id JOIN products p ON p.id=k.product_id
       WHERE cp.campaign_id=$1 AND cp.organization_id=$2 AND cp.deleted_at IS NULL ORDER BY p.name, k.sku_code`, [b.campaignId, actor.orgId])).map((r) => ({ value: r.id, label: `${r.pname} ／ ${r.name}（${r.code}）` }))
    : [];
  return (
    <>
      <PageHeader title={<>{b.label} <StatusBadge map={SHIPMENT_STATUS} value={b.status} testid="batch-status" /></>}
        sub={<><Link href="/fulfillment">履約與出貨</Link> › <Link href={`/fulfillment?campaignId=${b.campaignId}`}>{b.campaignTitle}</Link> · {b.id}</>}
        actions={writable ? <ActionButton endpoint={`/api/fulfillment/batches/${b.id}/cancel`} label="取消批次" variant="danger" reasonLabel="取消原因" confirm="會一併取消批次內尚未送達的出貨單；已有送達的出貨單時無法整批取消。" testid="btn-cancel-batch" /> : undefined} />
      {['CANCELLED', 'CLOSED', 'ON_HOLD'].includes(b.campaignStatus) ? <Banner kind="warn">檔期目前為「{CAMPAIGN_STATUS[b.campaignStatus]?.label ?? b.campaignStatus}」，履約資料唯讀。</Banner> : null}
      {b.status === 'CANCELLED' ? <Banner kind="warn" testid="batch-cancelled">此批次已取消：{b.cancelReason}</Banner> : null}
      <Card title="批次資料" testid="batch-info">
        <Kv rows={[
          ['檔期', <Link key="c" href={`/campaigns/${b.campaignId}`}>{b.campaignTitle}</Link>],
          ['檔期狀態', <StatusBadge key="cs" map={CAMPAIGN_STATUS} value={b.campaignStatus} />],
          ['類型', BATCH_KIND[b.kind] ?? b.kind],
          ['預計出貨日', fmtDate(b.plannedShipDate)],
          ['出貨單／數量', `${b.shipmentCount} 張／${num(b.totalQuantity)} 件`],
          ['送達／已簽收確認', `${b.deliveredCount} ／ ${b.confirmedCount}`],
          ...(internal ? [['內部備註', b.note || '—'] as [string, string]] : []),
        ]} />
        <p className="small muted">批次狀態由出貨單自動彙總：有異常顯示異常；全部送達才是「已送達」。</p>
      </Card>
      <Card flush title="出貨單" testid="shipments" actions={writable ? (
        <Modal label="＋ 新增出貨單" title="新增出貨單" variant="primary" size="btn sm" testid="btn-add-shipment">
          <ApiForm endpoint={`/api/fulfillment/batches/${b.id}/shipments`} submitLabel="新增" idempotent testid="form-add-shipment"
            fields={[
              { name: 'skuId', label: '規格（選填）', type: 'select', options: skuOpts, help: '只能選此檔期內的商品規格' },
              { name: 'quantity', label: '數量', type: 'number', required: true, min: 1 },
              { name: 'carrier', label: '物流商', placeholder: '黑貓／新竹／自送…', half: true },
              { name: 'trackingNo', label: '追蹤碼', half: true, help: '填追蹤碼需同時填物流商；同一物流商不可重複' },
              { name: 'plannedDate', label: '預計出貨日', type: 'date' },
              { name: 'note', label: '內部備註', type: 'textarea' },
            ]} />
        </Modal>
      ) : undefined}>
        {b.shipments.length === 0 ? <EmptyState title="這個批次還沒有出貨單" /> : (
          <Table head={['出貨單', '品項', '物流', '日期', '狀態', '簽收', '']} testid="shipments-table">
            {b.shipments.map((s) => {
              const can2 = (to: string) => writable && (SHIPMENT_TRANSITIONS as Record<string, string[]>)[s.status]?.includes(to);
              const ep = `/api/fulfillment/shipments/${s.id}`;
              return (
                <tr key={s.id} data-testid={`shipment-row-${s.id}`}>
                  <td><strong>{s.id}</strong>{internal && s.note ? <div className="small muted">{s.note}</div> : null}</td>
                  <td>{s.productName ? <>{s.productName}<div className="small muted">{s.skuName}（{s.skuCode}）</div></> : <span className="muted">未指定規格</span>} × {num(s.quantity)}</td>
                  <td>{s.carrier ?? <span className="muted">—</span>}<div className="small muted">{s.trackingNo ?? ''}</div></td>
                  <td className="small">預計 {fmtDate(s.plannedDate)}<br />出貨 {fmtDate(s.shippedDate)}<br />送達 {fmtDate(s.deliveredDate)}</td>
                  <td><StatusBadge map={SHIPMENT_STATUS} value={s.status} testid={`ship-status-${s.id}`} />
                    {s.status === 'EXCEPTION' ? <div className="small" style={{ color: 'var(--danger)' }}>{s.exceptionReason}</div> : null}
                    {s.status === 'CANCELLED' ? <div className="small muted">{s.cancelReason}</div> : null}</td>
                  <td className="small">{s.receiptConfirmedAt ? <span data-testid={`receipt-${s.id}`}><Badge tone="ok">已簽收</Badge><div>{s.receiptSigner}</div><div className="muted">{fmtDateTime(s.receiptConfirmedAt)}</div>{s.receiptNote ? <div className="muted">{s.receiptNote}</div> : null}</span> : s.status === 'DELIVERED' ? <Badge tone="warn">待簽收確認</Badge> : '—'}</td>
                  <td>{writable ? (
                    <div className="btn-row">
                      {can2('PACKED') ? <ActionButton endpoint={`${ep}/status`} body={{ to: 'PACKED' }} label="已包裝" small testid={`btn-pack-${s.id}`} /> : null}
                      {can2('SHIPPED') ? (
                        <Modal label="出貨" title={`出貨：${s.id}`} size="btn sm" variant="primary" testid={`btn-ship-${s.id}`}>
                          <ApiForm endpoint={`${ep}/status`} submitLabel="確認出貨" extra={{ to: 'SHIPPED' }} testid={`form-ship-${s.id}`}
                            fields={[
                              { name: 'carrier', label: '物流商', required: !s.carrier, defaultValue: s.carrier, placeholder: '自行配送請填「自送」' },
                              { name: 'trackingNo', label: '追蹤碼', defaultValue: s.trackingNo },
                              { name: 'date', label: '出貨日（預設今天）', type: 'date' },
                            ]} />
                        </Modal>
                      ) : null}
                      {can2('DELIVERED') ? (
                        <Modal label="標記送達" title={`標記送達：${s.id}`} size="btn sm" variant="primary" testid={`btn-deliver-${s.id}`}>
                          <ApiForm endpoint={`${ep}/status`} submitLabel="確認送達" extra={{ to: 'DELIVERED' }} testid={`form-deliver-${s.id}`}
                            fields={[{ name: 'date', label: '送達日（預設今天）', type: 'date', help: '不可是未來日期，也不可早於出貨日' }]} />
                        </Modal>
                      ) : null}
                      {s.status === 'DELIVERED' && !s.receiptConfirmedAt ? (
                        <Modal label="簽收確認" title={`簽收確認：${s.id}`} size="btn sm" variant="primary" testid={`btn-receipt-${s.id}`}>
                          <ApiForm endpoint={`${ep}/receipt`} submitLabel="確認簽收" testid={`form-receipt-${s.id}`}
                            fields={[{ name: 'signer', label: '簽收人', required: true }, { name: 'note', label: '備註', type: 'textarea', placeholder: '例如：管理室代收' }]} />
                        </Modal>
                      ) : null}
                      {can2('EXCEPTION') ? <ActionButton endpoint={`${ep}/status`} body={{ to: 'EXCEPTION' }} label="標記異常" small reasonLabel="異常原因" testid={`btn-exception-${s.id}`} /> : null}
                      {!['DELIVERED', 'CANCELLED'].includes(s.status) ? (
                        <Modal label="編輯" title={`編輯：${s.id}`} size="btn sm" testid={`btn-edit-${s.id}`}>
                          <ApiForm endpoint={ep} method="PATCH" submitLabel="儲存" extra={{ version: s.version }} testid={`form-edit-${s.id}`}
                            fields={[
                              { name: 'quantity', label: '數量', type: 'number', defaultValue: s.quantity, min: 1, help: '已出貨後不可改數量' },
                              { name: 'carrier', label: '物流商', defaultValue: s.carrier, half: true },
                              { name: 'trackingNo', label: '追蹤碼', defaultValue: s.trackingNo, half: true },
                              { name: 'plannedDate', label: '預計出貨日', type: 'date', defaultValue: s.plannedDate },
                              { name: 'note', label: '內部備註', type: 'textarea', defaultValue: s.note },
                            ]} />
                        </Modal>
                      ) : null}
                      {can2('CANCELLED') ? <ActionButton endpoint={`${ep}/status`} body={{ to: 'CANCELLED' }} label="取消" small variant="danger" reasonLabel="取消原因" testid={`btn-cancel-${s.id}`} /> : null}
                    </div>
                  ) : null}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </>
  );
});
