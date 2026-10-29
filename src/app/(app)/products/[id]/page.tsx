import Link from 'next/link';
import { withActor, type Params } from '@/server/ui/session';
import { getProduct } from '@/server/modules/products';
import { can } from '@/server/lib/permissions';
import { ActionButton } from '@/ui/ActionButton';
import { ApiForm } from '@/ui/ApiForm';
import { Modal } from '@/ui/Modal';
import { Badge, Card, EmptyState, PageHeader, StatusBadge, Table } from '@/ui/components';
import { ASSET_KIND, REVIEW_STATUS } from '@/ui/labels';
import { money } from '@/ui/format';
import { listProductFit } from '@/server/modules/fit';
import { FitTable } from '@/ui/FitTable';
import { as, type FitItemV } from '@/ui/types';
import { EvaluationCard, FeasibilityCard, TrialCard } from './SelectionCards';

export const dynamic = 'force-dynamic';
interface P {
  id: string; vendorId: string; vendorName: string; name: string; category: string | null; description: string | null; listingUrl: string | null; sellingPoints: string | null; complianceNote: string | null; reviewStatus: string; reviewNote: string | null; version: number;
  skus: { id: string; skuCode: string; name: string; listPrice: number | null; groupPrice: number | null; costPrice?: number | null; status: string; version: number }[];
  assets: { id: string; kind: string; title: string; url: string; status: string }[];
}

export default withActor(async (actor, props: { params: Params }) => {
  const { id } = await props.params;
  const p = as<P>(await getProduct(actor, id));
  const w = can(actor, 'product.write');
  const showCost = can(actor, 'product.cost.read');
  const reviewer = can(actor, 'product.review');
  const fitData = can(actor, 'fit.read') ? as<{ config: { version: number; approved: boolean }; items: FitItemV[] }>(await listProductFit(actor, p.id)) : null;
  const rs = p.reviewStatus;
  const ep = `/api/products/${p.id}/review`;
  return (
    <>
      <PageHeader title={<>{p.name} <StatusBadge map={REVIEW_STATUS} value={rs} testid="review-status" /></>} sub={<>{p.id}&emsp;廠商：<Link href={`/vendors/${p.vendorId}`}>{p.vendorName}</Link></>} testid="product-header"
        actions={<div className="btn-row" data-testid="review-actions">
          {w && (rs === 'DRAFT' || rs === 'REJECTED') ? <ActionButton endpoint={ep} body={{ to: 'PENDING_REVIEW' }} label="送審" variant="primary" testid="btn-submit-review" /> : null}
          {reviewer && rs === 'PENDING_REVIEW' ? <ActionButton endpoint={ep} body={{ to: 'APPROVED' }} label="核准" variant="primary" testid="btn-approve-product" /> : null}
          {reviewer && rs === 'PENDING_REVIEW' ? <ActionButton endpoint={ep} body={{ to: 'REJECTED' }} label="退回" variant="danger" reasonLabel="退回原因" reasonKey="note" testid="btn-reject-product" /> : null}
          {w && ['PENDING_REVIEW', 'APPROVED', 'REJECTED'].includes(rs) ? <ActionButton endpoint={ep} body={{ to: 'DRAFT' }} label="改回草稿" testid="btn-to-draft" /> : null}
        </div>} />
      {p.reviewNote ? <div className="banner warn">審核備註：{p.reviewNote}</div> : null}
      <div className="grid cols-2">
        <Card title="商品資料" testid="product-info">
          {w ? <ApiForm endpoint={`/api/products/${p.id}`} method="PATCH" extra={{ version: p.version }} submitLabel="儲存" testid="product-edit-form" fields={[
            { name: 'name', label: '商品名稱', defaultValue: p.name, required: true }, { name: 'category', label: '類別', defaultValue: p.category }, { name: 'listingUrl', label: '品項介紹連結', type: 'url', defaultValue: p.listingUrl },
            { name: 'description', label: '說明', type: 'textarea', defaultValue: p.description }, { name: 'sellingPoints', label: '賣點', type: 'textarea', defaultValue: p.sellingPoints }, { name: 'complianceNote', label: '檢驗／認證／法規備註', type: 'textarea', defaultValue: p.complianceNote }]} />
            : <dl className="kv"><dt>類別</dt><dd>{p.category ?? '—'}</dd><dt>賣點</dt><dd>{p.sellingPoints ?? '—'}</dd><dt>連結</dt><dd>{p.listingUrl ?? '—'}</dd></dl>}
        </Card>
        <Card title="素材與文件連結" testid="product-assets" actions={w ? <Modal label="＋ 新增素材" title="新增素材連結" size="btn sm" testid="btn-add-asset">
          <ApiForm endpoint={`/api/products/${p.id}/assets`} submitLabel="新增" fields={[{ name: 'kind', label: '類型', type: 'select', required: true, options: Object.entries(ASSET_KIND).map(([value, label]) => ({ value, label })) }, { name: 'title', label: '標題', required: true }, { name: 'url', label: '連結（http/https）', type: 'url', required: true }]} />
        </Modal> : undefined}>
          {p.assets.length === 0 ? <EmptyState title="尚無素材" /> : <ul className="list-plain">{p.assets.map((a) => <li key={a.id}><Badge>{ASSET_KIND[a.kind] ?? a.kind}</Badge> <a href={a.url} target="_blank" rel="noreferrer noopener">{a.title}</a></li>)}</ul>}
        </Card>
      </div>
      <Card title="規格（SKU）" flush testid="product-skus" actions={w ? <Modal label="＋ 新增規格" title="新增規格" size="btn sm" variant="primary" testid="btn-add-sku">
        <ApiForm endpoint={`/api/products/${p.id}/skus`} submitLabel="新增" testid="sku-form" fields={[{ name: 'skuCode', label: '規格編號', required: true }, { name: 'name', label: '規格名稱', required: true }, { name: 'listPrice', label: '原價', type: 'number', min: 0 }, { name: 'groupPrice', label: '團購價', type: 'number', min: 0 }, ...(showCost ? [{ name: 'costPrice', label: '成本（敏感）', type: 'number' as const, min: 0 }] : [])]} />
      </Modal> : undefined}>
        {p.skus.length === 0 ? <EmptyState title="尚無規格" hint="送審前至少需要一個啟用中的規格" /> : (
          <Table head={['編號', '名稱', '原價', '團購價', ...(showCost ? ['成本'] : []), '狀態', '']} testid="sku-table">
            {p.skus.map((s) => (
              <tr key={s.id} data-testid={`sku-row-${s.id}`}><td>{s.skuCode}</td><td>{s.name}</td><td className="num">{money(s.listPrice)}</td><td className="num">{money(s.groupPrice)}</td>
                {showCost ? <td className="num" data-testid={`sku-cost-${s.id}`}>{money(s.costPrice ?? null)}</td> : null}
                <td>{s.status === 'ACTIVE' ? <Badge tone="ok">啟用</Badge> : <Badge>停用</Badge>}</td>
                <td>{w ? <Modal label="編輯" title={`編輯規格 ${s.skuCode}`} size="btn sm" testid={`btn-edit-sku-${s.id}`}>
                  <ApiForm endpoint={`/api/skus/${s.id}`} method="PATCH" extra={{ version: s.version }} submitLabel="儲存" fields={[
                    { name: 'name', label: '名稱', defaultValue: s.name, required: true }, { name: 'listPrice', label: '原價', type: 'number', defaultValue: s.listPrice }, { name: 'groupPrice', label: '團購價', type: 'number', defaultValue: s.groupPrice },
                    ...(showCost ? [{ name: 'costPrice', label: '成本', type: 'number' as const, defaultValue: s.costPrice }] : []),
                    { name: 'status', label: '狀態', type: 'select', required: true, defaultValue: s.status, options: [{ value: 'ACTIVE', label: '啟用' }, { value: 'INACTIVE', label: '停用' }] }]} />
                </Modal> : null}</td></tr>
            ))}
          </Table>
        )}
      </Card>
      {can(actor, 'selection.read') ? <EvaluationCard actor={actor} productId={p.id} /> : null}
      {can(actor, 'selection.read') ? <TrialCard actor={actor} productId={p.id} /> : null}
      {can(actor, 'selection.read') ? <FeasibilityCard actor={actor} productId={p.id} /> : null}
      {fitData ? (
        <Card title="候選團主適配" flush testid="product-fit" actions={can(actor, 'fit.assess') ? <ActionButton endpoint={`/api/products/${p.id}/fit`} label="產生候選團主評估" variant="primary" small testid="btn-assess-product" successMessage="已更新候選團主評估" /> : undefined}>
          <p className="small muted" style={{ padding: '10px 16px 0' }}>依各團主的客群分析、歷史績效與廠商供應履約評分。缺資料的維度會標示「未知」並降低信心，不會當成 0 分；合規與商品品質是硬性檢查，不被總分抵銷。評分權重為{fitData.config.approved ? '已確認' : '「建議值，待 Owner 確認」'}（v{fitData.config.version}）。</p>
          {fitData.items.length === 0 ? <EmptyState title="尚未評估" hint="按「產生候選團主評估」，系統會對所有合作中的團主評分並排名。團主若尚未建立客群分析，會顯示「資料不足」。" /> : <FitTable items={fitData.items} canReview={can(actor, 'fit.review')} show="host" />}
        </Card>
      ) : null}
    </>
  );
});
