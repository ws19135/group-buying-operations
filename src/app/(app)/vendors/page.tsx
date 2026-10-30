import Link from 'next/link';
import { withActor, sp1, toQuery, type SP } from '@/server/ui/session';
import { listVendors } from '@/server/modules/vendors';
import { can } from '@/server/lib/permissions';
import { Badge, Card, EmptyState, Filters, PageHeader, Pagination, StatusBadge, Table } from '@/ui/components';
import { VENDOR_STATUS } from '@/ui/labels';
import { as, type Paged } from '@/ui/types';

export const dynamic = 'force-dynamic';

interface Row { id: string; name: string; companyName: string | null; taxId: string | null; category: string | null; status: string; campaignCount: number; productCount: number; primaryContact: { name: string; email: string | null; phone: string | null; line_id: string | null } | null; missingFields: string[] }

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const res = as<Paged<Row>>(await listVendors(actor, toQuery(q)));
  const base = Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'page'));
  return (
    <>
      <PageHeader title="廠商" sub="廠商主檔、聯絡人與合作狀態" actions={can(actor, 'vendor.write') ? <Link className="btn primary" href="/vendors/new" data-testid="btn-create-vendor">＋ 新增廠商</Link> : null} />
      <Filters>
        <label>關鍵字<input name="q" defaultValue={q.q} placeholder="名稱、公司或編號（ID）" data-testid="filter-q" /></label>
        <label>合作狀態<select name="status" defaultValue={q.status ?? ''}><option value="">全部</option>{Object.entries(VENDOR_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
        <label>類別<input name="category" defaultValue={q.category} /></label>
        <label><input type="checkbox" name="missing" value="1" defaultChecked={q.missing === '1'} data-testid="filter-missing" /> 只看資料待補</label>
      </Filters>
      <Card flush testid="vendor-list">
        {res.items.length === 0 ? <EmptyState title="沒有符合條件的廠商" /> : (
          <Table head={['廠商', '狀態', '類別', '主要聯絡人', '商品／檔期', '待補資料']}>
            {res.items.map((v) => (
              <tr key={v.id} data-testid={`vendor-row-${v.id}`}>
                <td><Link href={`/vendors/${v.id}`}><strong>{v.name}</strong></Link><div className="small muted">{v.id}{v.companyName ? `・${v.companyName}` : ''}</div></td>
                <td><StatusBadge map={VENDOR_STATUS} value={v.status} /></td><td>{v.category ?? '—'}</td>
                <td>{v.primaryContact ? <>{v.primaryContact.name}<div className="small muted">{v.primaryContact.email ?? v.primaryContact.phone ?? v.primaryContact.line_id ?? ''}</div></> : <span className="muted">—</span>}</td>
                <td>{v.productCount} 商品／{v.campaignCount} 檔</td>
                <td>{v.missingFields.length ? <Badge tone="warn">{v.missingFields.length} 項待補</Badge> : <Badge tone="ok">完整</Badge>}</td>
              </tr>
            ))}
          </Table>
        )}
        <Pagination total={res.total} limit={res.limit} offset={res.offset} base={base} />
      </Card>
    </>
  );
});
