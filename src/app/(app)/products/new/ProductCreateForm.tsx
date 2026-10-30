'use client';
import { useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { callApi } from '@/ui/api';
import { useToast } from '@/ui/Toast';

export function ProductCreateForm({ vendors, canCost }: { vendors: { value: string; label: string }[]; canCost: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const idem = useMemo(() => crypto.randomUUID(), []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const fd = new FormData(e.currentTarget);
    const s = (k: string) => String(fd.get(k) ?? '').trim();
    const body: Record<string, unknown> = { vendorId: s('vendorId'), name: s('name') };
    for (const k of ['category', 'listingUrl', 'description', 'sellingPoints', 'complianceNote']) if (s(k)) body[k] = s(k);
    if (s('skuCode')) {
      const sku: Record<string, unknown> = { skuCode: s('skuCode'), name: s('skuName') || s('name') };
      for (const k of ['listPrice', 'groupPrice', ...(canCost ? ['costPrice'] : [])]) if (s(k)) sku[k] = Number(s(k));
      body.skus = [sku];
    }
    setBusy(true); setErr(null);
    const r = await callApi<{ id: string }>('/api/products', 'POST', body, idem);
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? '建立失敗'); return; }
    toast('ok', '商品已建立'); router.push(`/products/${r.data?.id}`);
  }
  return (
    <form onSubmit={submit} data-testid="product-create-form">
      {err ? <div className="banner error" role="alert" data-testid="form-error">{err}</div> : null}
      <div className="form-grid">
        <label className="field"><span className="lbl">廠商<span className="req"> *</span></span><select name="vendorId" required data-testid="field-vendorId"><option value="">請選擇</option>{vendors.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}</select></label>
        <label className="field"><span className="lbl">商品名稱<span className="req"> *</span></span><input name="name" required data-testid="field-name" /></label>
        <label className="field"><span className="lbl">類別</span><input name="category" /></label>
        <label className="field"><span className="lbl">品項介紹連結</span><input type="url" name="listingUrl" /></label>
        <label className="field" style={{ gridColumn: '1 / -1' }}><span className="lbl">賣點</span><textarea name="sellingPoints" /></label>
        <label className="field" style={{ gridColumn: '1 / -1' }}><span className="lbl">檢驗報告／認證／法規備註</span><textarea name="complianceNote" /></label>
      </div>
      <h2>第一個規格（選填）</h2>
      <div className="form-grid">
        <label className="field"><span className="lbl">規格編號</span><input name="skuCode" data-testid="field-skuCode" /></label>
        <label className="field"><span className="lbl">規格名稱</span><input name="skuName" /></label>
        <label className="field"><span className="lbl">原價（新台幣）</span><input type="number" min={0} name="listPrice" data-testid="field-listPrice" /></label>
        <label className="field"><span className="lbl">團購價（新台幣）</span><input type="number" min={0} name="groupPrice" data-testid="field-groupPrice" /></label>
        {canCost ? <label className="field"><span className="lbl">成本（新台幣，敏感）</span><input type="number" min={0} name="costPrice" /></label> : null}
      </div>
      <button className="btn primary" type="submit" disabled={busy} data-testid="product-create-submit">{busy ? '建立中…' : '建立商品'}</button>
    </form>
  );
}
