import Link from 'next/link';
import { withActor, type Params } from '@/server/ui/session';
import { getVendor } from '@/server/modules/vendors';
import { can } from '@/server/lib/permissions';
import { ActionButton } from '@/ui/ActionButton';
import { ApiForm } from '@/ui/ApiForm';
import { Modal } from '@/ui/Modal';
import { Badge, Banner, Card, EmptyState, PageHeader, StatusBadge, Table } from '@/ui/components';
import { CAMPAIGN_STATUS, REVIEW_STATUS, VENDOR_STATUS } from '@/ui/labels';
import { as } from '@/ui/types';

export const dynamic = 'force-dynamic';

interface V {
  id: string; name: string; companyName: string | null; taxId: string | null; category: string | null; website: string | null; status: string; cooperationNote: string | null; internalNote?: string | null; version: number;
  contacts: { id: string; name: string; title: string | null; email: string | null; phone: string | null; lineId: string | null; isPrimary: boolean }[];
  products: { id: string; name: string; category: string | null; reviewStatus: string }[];
  campaigns: { id: string; title: string; status: string; openDate: string | null; closeDate: string | null }[];
  missingFields: string[]; anomalies: string[];
}

export default withActor(async (actor, props: { params: Params }) => {
  const { id } = await props.params;
  const v = as<V>(await getVendor(actor, id));
  const w = can(actor, 'vendor.write');
  return (
    <>
      <PageHeader title={<>{v.name} <StatusBadge map={VENDOR_STATUS} value={v.status} /></>} sub={`${v.id}${v.companyName ? `・${v.companyName}` : ''}`} testid="vendor-header"
        actions={w ? <ActionButton endpoint={`/api/vendors/${v.id}/archive`} label="封存廠商" variant="danger" reasonLabel="封存原因" confirm="封存後不再出現於清單；仍有未結案檔期時無法封存。" testid="btn-archive-vendor" redirectTo="/vendors" /> : undefined} />
      {v.anomalies.length ? <Banner kind="warn" testid="vendor-anomalies"><strong>異常：</strong><ul>{v.anomalies.map((a) => <li key={a}>{a}</li>)}</ul></Banner> : null}
      {v.missingFields.length ? <Banner kind="nodata" testid="vendor-missing">待補資料：{v.missingFields.join('、')}</Banner> : null}
      <div className="grid cols-2">
        <Card title="基本資料" testid="vendor-info">
          {w ? <ApiForm endpoint={`/api/vendors/${v.id}`} method="PATCH" extra={{ version: v.version }} submitLabel="儲存" testid="vendor-edit-form" fields={[
            { name: 'name', label: '廠商／品牌名稱', defaultValue: v.name, required: true }, { name: 'companyName', label: '公司全名', defaultValue: v.companyName },
            { name: 'taxId', label: '統一編號', defaultValue: v.taxId }, { name: 'category', label: '類別', defaultValue: v.category },
            { name: 'website', label: '官網', defaultValue: v.website, type: 'url' },
            { name: 'status', label: '合作狀態', type: 'select', required: true, defaultValue: v.status, options: Object.entries(VENDOR_STATUS).map(([k, l]) => ({ value: k, label: l.label })) },
            { name: 'cooperationNote', label: '合作備註', type: 'textarea', defaultValue: v.cooperationNote }, { name: 'internalNote', label: '內部備註', type: 'textarea', defaultValue: v.internalNote }]} />
            : <dl className="kv"><dt>統編</dt><dd>{v.taxId ?? '—'}</dd><dt>類別</dt><dd>{v.category ?? '—'}</dd><dt>官網</dt><dd>{v.website ?? '—'}</dd></dl>}
        </Card>
        <Card title="聯絡人" testid="vendor-contacts" actions={w ? <Modal label="＋ 新增聯絡人" title="新增聯絡人" size="btn sm" testid="btn-add-contact">
          <ApiForm endpoint={`/api/vendors/${v.id}/contacts`} submitLabel="新增" fields={[{ name: 'name', label: '姓名', required: true }, { name: 'title', label: '職稱' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: '電話' }, { name: 'lineId', label: 'LINE ID' }, { name: 'isPrimary', label: '設為主要聯絡人', type: 'checkbox' }]} />
        </Modal> : undefined}>
          {v.contacts.length === 0 ? <EmptyState title="尚無聯絡人" /> : (
            <ul className="list-plain">{v.contacts.map((c) => (
              <li key={c.id} data-testid={`contact-${c.id}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span><strong>{c.name}</strong> {c.isPrimary ? <Badge tone="primary">主要</Badge> : null}<div className="small muted">{[c.title, c.email, c.phone, c.lineId].filter(Boolean).join('・')}</div></span>
                {w ? <ActionButton endpoint={`/api/vendor-contacts/${c.id}/archive`} label="移除" small variant="danger" confirm="確定移除此聯絡人？" /> : null}
              </li>))}</ul>
          )}
        </Card>
      </div>
      <Card title="商品" flush testid="vendor-products">
        {v.products.length === 0 ? <EmptyState title="尚無商品" hint={can(actor, 'product.write') ? <Link href="/products/new">建立商品</Link> : undefined} /> : (
          <Table head={['商品', '類別', '審核']}>{v.products.map((p) => <tr key={p.id}><td><Link href={`/products/${p.id}`}>{p.name}</Link></td><td>{p.category ?? '—'}</td><td><StatusBadge map={REVIEW_STATUS} value={p.reviewStatus} /></td></tr>)}</Table>
        )}
      </Card>
      <Card title="合作檔期" flush testid="vendor-campaigns">
        {v.campaigns.length === 0 ? <EmptyState title="尚無檔期" /> : (
          <Table head={['檔期', '狀態', '期間']}>{v.campaigns.map((c) => <tr key={c.id}><td><Link href={`/campaigns/${c.id}`}>{c.title}</Link></td><td><StatusBadge map={CAMPAIGN_STATUS} value={c.status} /></td><td>{c.openDate ?? '—'} ～ {c.closeDate ?? '—'}</td></tr>)}</Table>
        )}
      </Card>
    </>
  );
});
