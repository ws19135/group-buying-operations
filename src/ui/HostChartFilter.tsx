'use client';
import { useRouter, useSearchParams } from 'next/navigation';

interface Props { vendors: { id: string; name: string }[]; products: { id: string; name: string; vendorId: string }[]; vendorId: string | null; productId: string | null }

/** 「跨團主業績比較」的篩選：先選廠商，再選該廠商的商品（商品預設「全部商品」）。換選項時保留月份／週別等其他查詢條件。 */
export function HostChartFilter({ vendors, products, vendorId, productId }: Props) {
  const router = useRouter();
  const sp = useSearchParams();
  function go(next: { vendor?: string | null; product?: string | null }) {
    const q = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(next)) { if (v) q.set(k, v); else q.delete(k); }
    router.push(`?${q.toString()}`);
  }
  const shown = vendorId ? products.filter((p) => p.vendorId === vendorId) : [];
  return (
    <div className="btn-row" data-testid="host-chart-filter" style={{ flexWrap: 'wrap', gap: 6 }}>
      <label className="small">廠商：
        <select value={vendorId ?? ''} onChange={(e) => go({ vendor: e.target.value || null, product: null })} data-testid="host-chart-vendor" aria-label="廠商">
          <option value="">全部廠商</option>
          {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </label>
      <label className="small">團購商品：
        <select value={productId ?? ''} onChange={(e) => go({ product: e.target.value || null })} disabled={!vendorId} data-testid="host-chart-product" aria-label="團購商品" title={vendorId ? undefined : '請先選擇廠商'}>
          <option value="">{vendorId ? '全部商品' : '（請先選廠商）'}</option>
          {shown.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
    </div>
  );
}
