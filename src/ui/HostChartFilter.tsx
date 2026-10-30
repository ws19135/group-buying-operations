'use client';
import { useEffect, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

interface Props { vendors: { id: string; name: string }[]; products: { id: string; name: string; vendorId: string }[]; vendorId: string | null; productId: string | null }

/**
 * 「跨團主業績比較」的篩選：先選廠商，再選該廠商的商品（商品預設「全部商品」）。換選項時保留月份／週別等其他查詢條件。
 * 商品清單已隨頁面送到瀏覽器，所以選廠商的當下商品下拉就會更新（不必等伺服器重畫圖表）；圖表更新期間顯示「更新中…」。
 */
export function HostChartFilter({ vendors, products, vendorId, productId }: Props) {
  const router = useRouter();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [vendorSel, setVendorSel] = useState(vendorId ?? '');
  const [productSel, setProductSel] = useState(productId ?? '');
  // 伺服器回傳新的篩選結果（含網址直接帶入、上一頁／下一頁）時，以伺服器為準
  useEffect(() => { setVendorSel(vendorId ?? ''); setProductSel(productId ?? ''); }, [vendorId, productId]);

  /** 換選項後的網址（只改廠商／商品，保留月份等其他條件）。選項上的 data-nav 讓唯讀快照站（沒有 script）也能換頁 */
  function href(next: { vendor?: string | null; product?: string | null }) {
    const q = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(next)) { if (v) q.set(k, v); else q.delete(k); }
    return `?${q.toString()}`;
  }
  const go = (next: { vendor?: string | null; product?: string | null }) => startTransition(() => router.push(href(next)));
  const shown = vendorSel ? products.filter((p) => p.vendorId === vendorSel) : [];
  const noProducts = !!vendorSel && shown.length === 0;
  return (
    <div className="btn-row" data-testid="host-chart-filter" style={{ flexWrap: 'wrap', gap: 6 }} aria-busy={pending}>
      <label className="small">廠商：
        <select value={vendorSel} onChange={(e) => { setVendorSel(e.target.value); setProductSel(''); go({ vendor: e.target.value || null, product: null }); }} data-testid="host-chart-vendor" aria-label="廠商" data-nav-select>
          <option value="" data-nav={href({ vendor: null, product: null })}>全部廠商</option>
          {vendors.map((v) => <option key={v.id} value={v.id} data-nav={href({ vendor: v.id, product: null })}>{v.name}</option>)}
        </select>
      </label>
      <label className="small">團購商品：
        <select value={productSel} onChange={(e) => { setProductSel(e.target.value); go({ product: e.target.value || null }); }} disabled={!vendorSel} data-testid="host-chart-product" aria-label="團購商品" title={vendorSel ? undefined : '請先選擇廠商'} data-nav-select>
          <option value="" data-nav={href({ product: null })}>{!vendorSel ? '（請先選廠商）' : noProducts ? '（此廠商尚無團購商品）' : '全部商品'}</option>
          {shown.map((p) => <option key={p.id} value={p.id} data-nav={href({ product: p.id })}>{p.name}</option>)}
        </select>
      </label>
      {pending ? <span className="small muted" data-testid="host-chart-pending" role="status">圖表更新中…</span> : null}
    </div>
  );
}
