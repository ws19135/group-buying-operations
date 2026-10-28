import Link from 'next/link';
import { withActor, sp1, toQuery, type SP } from '@/server/ui/session';
import { listImportBatches, listImportErrors } from '@/server/modules/orders';
import { can } from '@/server/lib/permissions';
import { ActionButton } from '@/ui/ActionButton';
import { Badge, Card, EmptyState, PageHeader, Pagination, StatusBadge, Table } from '@/ui/components';
import { ERR_STATUS, IMPORT_STATUS } from '@/ui/labels';
import { fmtDateTime } from '@/ui/format';
import { as, type Paged } from '@/ui/types';
import { ImportForm } from './ImportForm';

export const dynamic = 'force-dynamic';
interface B { id: string; sourceSystem: string; dataOrigin: string; fileName: string | null; status: string; totalRows: number; insertedRows: number; updatedRows: number; duplicateRows: number; errorRows: number; dataAsOf: string | null; finishedAt: string | null }
interface E { id: number; lineNo: number; code: string; message: string; rawRow: unknown; status: string }

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const batches = as<Paged<B>>(await listImportBatches(actor, toQuery(q)));
  const errors = q.batch ? as<E[]>(await listImportErrors(actor, q.batch)) : [];
  const canImport = can(actor, 'order.import');
  const base = Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'page'));
  return (
    <>
      <PageHeader title="訂單匯入" sub="以 CSV 匯入訂單；同一檔案不能重複匯入，重疊訂單依「來源系統＋來源訂單編號」去重；有問題的列會進錯誤佇列" />
      {canImport ? <Card title="匯入 CSV"><ImportForm /></Card> : null}
      <Card title="CSV 欄位說明" testid="csv-help">
        <p className="small">每一列是一個訂單品項；相同 <code>source_order_id</code> 的列會合併成一張訂單。第一列必須是欄位名稱。</p>
        <Table head={['欄位', '必填', '說明']}>
          <tr><td><code>source_order_id</code></td><td>是</td><td>來源平台的訂單編號（去重鍵）</td></tr>
          <tr><td><code>campaign_id</code></td><td>是</td><td>本系統檔期編號，例如 CMP-202610-0001（已取消的檔期不接受）</td></tr>
          <tr><td><code>ordered_at</code></td><td>是</td><td><code>YYYY-MM-DD HH:mm</code>（台北時間）或含時區的 ISO 8601，不可是未來時間</td></tr>
          <tr><td><code>status</code></td><td>是</td><td><code>PAID</code>／<code>PENDING</code>／<code>CANCELLED</code>／<code>REFUNDED</code>／<code>PARTIAL_REFUND</code></td></tr>
          <tr><td><code>quantity</code>、<code>unit_price</code></td><td>是</td><td>正整數數量、非負整數單價（TWD）</td></tr>
          <tr><td><code>sku_code</code></td><td>否</td><td>需為該檔期內的規格編號</td></tr>
          <tr><td><code>refund_amount</code></td><td>否</td><td>全額退款可省略；部分退款需介於 0 與訂單金額之間</td></tr>
          <tr><td><code>host_id</code>、<code>community_id</code></td><td>否</td><td>歸因團主／社群（團主需在該檔期內）</td></tr>
          <tr><td><code>buyer_ref</code></td><td>否</td><td>去識別化的購買人代號（請勿放姓名、電話、地址）</td></tr>
        </Table>
      </Card>
      <Card title="匯入批次" flush testid="import-batches">
        {batches.items.length === 0 ? <EmptyState title="尚無匯入紀錄" /> : (
          <Table head={['批次', '來源', '狀態', '列數', '新增', '更新', '重複', '錯誤', '資料截至', '']}>
            {batches.items.map((b) => (
              <tr key={b.id} data-testid={`batch-row-${b.id}`}><td>{b.id}{b.dataOrigin === 'DEMO' ? <> <Badge tone="warn">DEMO</Badge></> : null}<div className="small muted">{b.fileName}</div></td><td>{b.sourceSystem}</td><td><StatusBadge map={IMPORT_STATUS} value={b.status} /></td>
                <td>{b.totalRows}</td><td>{b.insertedRows}</td><td>{b.updatedRows}</td><td>{b.duplicateRows}</td><td>{b.errorRows ? <Badge tone="danger">{b.errorRows}</Badge> : 0}</td><td className="small">{fmtDateTime(b.dataAsOf)}</td>
                <td>{b.errorRows ? <Link className="btn sm" href={`?batch=${b.id}`} data-testid={`btn-errors-${b.id}`}>看錯誤列</Link> : null}</td></tr>
            ))}
          </Table>
        )}
        <Pagination total={batches.total} limit={batches.limit} offset={batches.offset} base={base} />
      </Card>
      {q.batch ? (
        <Card title={`批次 ${q.batch} 的錯誤列`} flush testid="import-errors">
          {errors.length === 0 ? <EmptyState title="沒有錯誤列" /> : (
            <Table head={['行', '代碼', '說明', '原始資料', '狀態', '']}>
              {errors.map((e) => (
                <tr key={e.id} data-testid={`err-row-${e.id}`}><td>{e.lineNo}</td><td><code>{e.code}</code></td><td>{e.message}</td><td><pre className="diff">{JSON.stringify(e.rawRow)}</pre></td><td><StatusBadge map={ERR_STATUS} value={e.status} /></td>
                  <td>{e.status === 'OPEN' && canImport ? <div className="btn-row"><ActionButton endpoint={`/api/import-errors/${e.id}/resolve`} body={{ status: 'RESOLVED' }} label="已處理" small reasonLabel="處理說明" reasonKey="note" testid={`btn-resolve-${e.id}`} /><ActionButton endpoint={`/api/import-errors/${e.id}/resolve`} body={{ status: 'IGNORED' }} label="忽略" small reasonLabel="忽略原因" reasonKey="note" testid={`btn-ignore-${e.id}`} /></div> : null}</td></tr>
              ))}
            </Table>
          )}
        </Card>
      ) : null}
    </>
  );
});
