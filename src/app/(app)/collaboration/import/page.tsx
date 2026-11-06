import Link from 'next/link';
import { withActor, sp1, toQuery, type SP } from '@/server/ui/session';
import { can, isInternal } from '@/server/lib/permissions';
import { forbidden } from '@/server/lib/errors';
import { hostOptions, vendorOptions } from '@/server/ui/options';
import { listImportBatches, listImportRows } from '@/server/modules/collaboration-import';
import { ActionButton } from '@/ui/ActionButton';
import { Badge, Banner, Card, EmptyState, PageHeader, Pagination, StatusBadge, Table } from '@/ui/components';
import { Modal } from '@/ui/Modal';
import { fmtDateTime } from '@/ui/format';
import { as, type Paged } from '@/ui/types';
import { collaborationProductOptions } from '../options';
import { IMPORT_RESOLUTION } from '../labels';
import { PreviewImportForm, ResolveRowForm } from './ImportForms';

export const dynamic = 'force-dynamic';

interface BatchRow {
  id: string; sourceSystem: string; fileName: string | null; status: string;
  totalRows: number; insertedRows: number; updatedRows: number; duplicateRows: number; errorRows: number;
  startedAt: string | null; finishedAt: string | null;
}
interface ImportRow {
  id: string; batchId: string; rowNo: number; formKind: string;
  hostNameRaw: string | null; productNameRaw: string | null;
  resolvedHostId: string | null; resolvedVendorId: string; resolvedProductId: string | null; resolvedSkuId: string | null;
  resolvedHostName: string | null; resolvedProductName: string | null;
  resolution: string; issues: { code: string; message: string; blocking: boolean }[] | null;
  applicationId: string | null; resolveNote: string | null;
}

const KIND_LABEL: Record<string, string> = { FORM1_LAUNCH: '表單一（開團／補寄）', FORM2_SAMPLE: '表單二（樣品申請）' };

export default withActor(async (actor, props: { searchParams: SP }) => {
  if (!isInternal(actor) || !can(actor, 'collaboration.read')) throw forbidden();
  const q = await sp1(props.searchParams);
  const canImport = can(actor, 'collaboration.create') && can(actor, 'collaboration.update');

  const batches = as<Paged<BatchRow>>(await listImportBatches(actor, toQuery({})));
  const batch = q.batch ?? '';
  const rows = batch
    ? as<Paged<ImportRow>>(await listImportRows(actor, toQuery({ batchId: batch, limit: '100', ...(q.resolution ? { resolution: q.resolution } : {}), ...(q.page ? { page: q.page } : {}) })))
    : null;
  const [vendors, hosts, products] = await Promise.all([
    vendorOptions(actor),
    batch ? hostOptions(actor) : Promise.resolve([]),
    batch ? collaborationProductOptions(actor.orgId, null) : Promise.resolve([]),
  ]);
  const pending = rows ? rows.items.filter((r) => r.resolution === 'NEEDS_REVIEW').length : 0;

  return (
    <>
      <PageHeader title="匯入廠商現有表單"
        sub="把廠商手上的表單一／表單二接進系統。分三步：上傳預覽 → 逐列確認主檔對應 → 建立申請單。"
        actions={<Link className="btn sm" href="/collaboration">回合作申請列表</Link>} />

      <Banner kind="warn">
        同名不代表同一人：對應不到唯一主檔的列會列成「待確認」，系統不會自動猜著合併。
        同一份檔案不能重複匯入；同一列即使重跑也只會建立一張申請單。缺日期、缺意願的列照原樣留白，不會補假資料。
      </Banner>

      {canImport ? (
        <Card title="第一步：上傳並預覽" testid="collab-import-card">
          <PreviewImportForm vendors={vendors} />
        </Card>
      ) : null}

      <Card title="欄位對應說明" testid="collab-import-help">
        <Table head={['表單', '會讀到的欄位', '匯入後落在哪裡']}>
          <tr>
            <td>表單一</td>
            <td className="small">團購主、檔期、是否已補寄、開團連結、是否投廣、後台設定 Mail</td>
            <td className="small">申請單＋開團合作資訊。「是否已補寄」只當成參考，實際以寄送紀錄推導；有開團連結但沒有正式檔期時只留連結，不會自動建檔期。</td>
          </tr>
          <tr>
            <td>表單二</td>
            <td className="small">網紅名稱、收件人、聯繫電話、地址、申請樣品、配送日期、開團意願、開團日期、備註、開團連結、後台連結</td>
            <td className="small">申請單＋樣品明細＋收件資訊（視為個資，有保留期）＋寄送紀錄（只在有實際日期時建立）＋開團合作資訊。</td>
          </tr>
        </Table>
      </Card>

      <Card title="匯入批次" flush testid="collab-import-batches">
        {batches.items.length === 0 ? <EmptyState title="還沒有匯入紀錄" hint={canImport ? '用上方「上傳並預覽」開始' : undefined} /> : (
          <Table head={['批次', '表單', '狀態', '列數', '已建立', '重複', '待確認', '時間', '']}>
            {batches.items.map((b) => (
              <tr key={b.id} data-testid={`collab-batch-row-${b.id}`}>
                <td><strong>{b.id}</strong><div className="small muted">{b.fileName ?? '（貼上內容）'}</div></td>
                <td className="small">{KIND_LABEL[b.sourceSystem.replace('COLLABORATION_', '')] ?? b.sourceSystem}</td>
                <td className="small">{b.status}</td>
                <td>{b.totalRows}</td>
                <td>{b.updatedRows}</td>
                <td>{b.duplicateRows}</td>
                <td>{b.errorRows ? <Badge tone="warn">{b.errorRows}</Badge> : 0}</td>
                <td className="small">{fmtDateTime(b.finishedAt ?? b.startedAt)}</td>
                <td><Link className="btn sm" href={`/collaboration/import?batch=${b.id}`} data-testid={`btn-batch-${b.id}`}>看資料列</Link></td>
              </tr>
            ))}
          </Table>
        )}
        <Pagination total={batches.total} limit={batches.limit} offset={batches.offset} base={{}} />
      </Card>

      {rows ? (
        <Card flush testid="collab-import-rows"
          title={`第二步：批次 ${batch} 的資料列（待確認 ${pending}）`}
          actions={<div className="btn-row">
            <Link className="btn sm" href={`/collaboration/import?batch=${batch}&resolution=NEEDS_REVIEW`} data-testid="btn-only-pending">只看待確認</Link>
            <Link className="btn sm" href={`/collaboration/import?batch=${batch}`} data-testid="btn-all-rows">看全部</Link>
            {canImport ? (
              <ActionButton endpoint={`/api/collaboration/imports/${batch}/commit`} label="第三步：建立申請單" small variant="primary"
                confirm={pending ? `還有 ${pending} 列待確認，這些列不會被建立。要先建立已確認的部分嗎？` : '把已確認的資料列建立成合作申請單？'}
                successMessage="已建立申請單" testid="btn-commit-import" />
            ) : null}
          </div>}>
          {rows.items.length === 0 ? <EmptyState title="這個條件下沒有資料列" /> : (
            <Table head={['行', '原始團主名稱', '原始商品名稱', '對應結果', '狀態', '問題', '']}>
              {rows.items.map((r) => (
                <tr key={r.id} data-testid={`import-row-${r.id}`}>
                  <td>{r.rowNo}</td>
                  <td>{r.hostNameRaw ?? '—'}</td>
                  <td className="small">{r.productNameRaw ?? '—'}</td>
                  <td className="small">
                    團主：{r.resolvedHostName ?? <em>未對應</em>}
                    <div>商品：{r.resolvedProductName ?? <em>未對應</em>}{r.resolvedSkuId ? '（含規格）' : ''}</div>
                  </td>
                  <td>
                    <StatusBadge map={IMPORT_RESOLUTION} value={r.resolution} />
                    {r.applicationId ? <div className="small"><Link href={`/collaboration/${r.applicationId}`}>{r.applicationId}</Link></div> : null}
                  </td>
                  <td className="small">
                    {(r.issues ?? []).length === 0 ? '—' : (
                      <ul className="list-plain">
                        {(r.issues ?? []).map((x, i) => <li key={i}>{x.blocking ? <Badge tone="danger">需處理</Badge> : <Badge tone="warn">提醒</Badge>} {x.message}</li>)}
                      </ul>
                    )}
                    {r.resolveNote ? <div className="muted">處理說明：{r.resolveNote}</div> : null}
                  </td>
                  <td>
                    {canImport && r.resolution !== 'IMPORTED' ? (
                      <Modal label="修正對應" title={`第 ${r.rowNo} 列：修正主檔對應`} size="btn sm" testid={`btn-resolve-${r.id}`}>
                        {(close) => (
                          <ResolveRowForm rowId={r.id} hosts={hosts} products={products} vendorId={r.resolvedVendorId}
                            needProduct={r.formKind === 'FORM2_SAMPLE'} close={close} />
                        )}
                      </Modal>
                    ) : null}
                  </td>
                </tr>
              ))}
            </Table>
          )}
          <Pagination total={rows.total} limit={rows.limit} offset={rows.offset} base={{ batch, ...(q.resolution ? { resolution: q.resolution } : {}) }} />
        </Card>
      ) : null}
    </>
  );
});
