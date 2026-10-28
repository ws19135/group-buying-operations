import Link from 'next/link';
import { withActor, sp1, toQuery, type SP } from '@/server/ui/session';
import { listProducts } from '@/server/modules/products';
import { can } from '@/server/lib/permissions';
import { vendorOptions } from '@/server/ui/options';
import { Card, EmptyState, Filters, PageHeader, Pagination, StatusBadge, Table } from '@/ui/components';
import { REVIEW_STATUS } from '@/ui/labels';
import { as, type Paged } from '@/ui/types';

export const dynamic = 'force-dynamic';
interface Row { id: string; name: string; vendorId: string; vendorName: string; category: string | null; reviewStatus: string; skuCount: number }

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const [res, vendors] = await Promise.all([listProducts(actor, toQuery(q)).then((r) => as<Paged<Row>>(r)), vendorOptions(actor)]);
  const base = Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'page'));
  return (
    <>
      <PageHeader title="商品" sub="商品、規格（SKU）、素材與審核" actions={can(actor, 'product.write') ? <Link className="btn primary" href="/products/new" data-testid="btn-create-product">＋ 新增商品</Link> : null} />
      <Filters>
        <label>關鍵字<input name="q" defaultValue={q.q} data-testid="filter-q" /></label>
        {vendors.length > 1 ? <label>廠商<select name="vendorId" defaultValue={q.vendorId ?? ''}><option value="">全部</option>{vendors.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}</select></label> : null}
        <label>審核<select name="reviewStatus" defaultValue={q.reviewStatus ?? ''}><option value="">全部</option>{Object.entries(REVIEW_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
      </Filters>
      <Card flush testid="product-list">
        {res.items.length === 0 ? <EmptyState title="沒有商品" /> : (
          <Table head={['商品', '廠商', '類別', '規格數', '審核']}>
            {res.items.map((p) => <tr key={p.id} data-testid={`product-row-${p.id}`}><td><Link href={`/products/${p.id}`}><strong>{p.name}</strong></Link><div className="small muted">{p.id}</div></td><td>{p.vendorName}</td><td>{p.category ?? '—'}</td><td>{p.skuCount}</td><td><StatusBadge map={REVIEW_STATUS} value={p.reviewStatus} /></td></tr>)}
          </Table>
        )}
        <Pagination total={res.total} limit={res.limit} offset={res.offset} base={base} />
      </Card>
    </>
  );
});
