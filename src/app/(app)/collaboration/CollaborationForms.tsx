'use client';
import { useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { callApi } from '@/ui/api';

interface Opt { value: string; label: string }
/** 商品選項：value = productId|skuId（skuId 可空），並帶 vendorId 以便依廠商過濾 */
export interface ProductOpt extends Opt { vendorId: string }

function Msg({ text }: { text: string | null }) {
  return text ? <div className="banner error" role="alert" data-testid="form-error">{text}</div> : null;
}

/**
 * 新增合作申請。
 * 一次可以申請多個商品／多個規格（同商品不同規格算同一個商品的不同 SKU，不是兩個商品）。
 */
export function CreateApplicationForm({ vendors, hosts, products, fixedHostId, fixedVendorId }: {
  vendors: Opt[]; hosts: Opt[]; products: ProductOpt[]; fixedHostId?: string; fixedVendorId?: string;
}) {
  const router = useRouter();
  const [vendorId, setVendorId] = useState(fixedVendorId ?? vendors[0]?.value ?? '');
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idem = useMemo(() => crypto.randomUUID(), []);
  const forVendor = products.filter((p) => p.vendorId === vendorId);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const fd = new FormData(e.currentTarget);
    const items = Object.entries(picked).filter(([, qty]) => qty > 0).map(([k, qty]) => {
      const [productId, skuId] = k.split('|');
      return { productId, ...(skuId ? { skuId } : {}), requestedQty: qty };
    });
    if (!items.length) { setErr('請至少選擇一項申請樣品並填數量'); return; }
    const body: Record<string, unknown> = {
      vendorId, hostId: fixedHostId ?? String(fd.get('hostId') ?? ''), items,
    };
    for (const k of ['appliedOn', 'note']) { const v = String(fd.get(k) ?? '').trim(); if (v) body[k] = v; }
    setBusy(true); setErr(null);
    const r = await callApi<{ id: string }>('/api/collaboration/applications', 'POST', body, idem);
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? '建立失敗'); return; }
    router.push(`/collaboration/${r.data?.id ?? ''}`);
  }

  return (
    <form onSubmit={submit} data-testid="create-application-form">
      <Msg text={err} />
      {fixedVendorId ? <input type="hidden" name="vendorId" value={fixedVendorId} /> : (
        <label className="field"><span className="lbl">廠商<span className="req"> *</span></span>
          <select name="vendorId" required value={vendorId} onChange={(e) => { setVendorId(e.target.value); setPicked({}); }} data-testid="field-vendorId">
            <option value="">請選擇</option>{vendors.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select></label>
      )}
      {fixedHostId ? null : (
        <label className="field"><span className="lbl">團主<span className="req"> *</span></span>
          <select name="hostId" required data-testid="field-hostId">
            <option value="">請選擇</option>{hosts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select></label>
      )}
      <label className="field"><span className="lbl">申請日期</span><input type="date" name="appliedOn" data-testid="field-appliedOn" /></label>

      <fieldset data-testid="field-items">
        <legend>申請樣品（可多選，填數量即代表要申請）</legend>
        {!vendorId ? <p className="small muted">請先選擇廠商。</p>
          : forVendor.length === 0 ? <p className="small muted">這家廠商還沒有商品，請先到「商品」建立。</p>
            : forVendor.map((p) => (
              <label className="field half" key={p.value}>
                <span className="lbl">{p.label}</span>
                <input type="number" min={0} max={9999} placeholder="0" data-testid={`field-qty-${p.value}`}
                  value={picked[p.value] ?? ''} onChange={(e) => {
                    const n = Number(e.target.value);
                    setPicked((prev) => ({ ...prev, [p.value]: Number.isFinite(n) ? n : 0 }));
                  }} />
              </label>
            ))}
      </fieldset>

      <label className="field"><span className="lbl">備註</span>
        <textarea name="note" rows={3} data-testid="field-note" placeholder="例如：想試小包裝、預計十一月開團" /></label>
      <p className="small muted">送出後還要經過內部審核與廠商確認供樣，才會進入寄樣。收件資訊在申請建立後單獨填寫。</p>
      <button className="btn primary" type="submit" disabled={busy} data-testid="create-application-submit">
        {busy ? '建立中…' : '建立申請'}
      </button>
    </form>
  );
}

/** 新增申請樣品明細：value = productId|skuId */
export function AddItemForm({ applicationId, options }: { applicationId: string; options: Opt[] }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form data-testid="add-item-form" onSubmit={async (e) => {
      e.preventDefault();
      if (busy) return;
      const fd = new FormData(e.currentTarget);
      const [productId, skuId] = String(fd.get('pick') ?? '').split('|');
      const qty = Number(String(fd.get('requestedQty') ?? '1'));
      const reason = String(fd.get('requestReason') ?? '').trim();
      setBusy(true); setErr(null);
      const r = await callApi(`/api/collaboration/applications/${applicationId}/items`, 'POST',
        { productId, ...(skuId ? { skuId } : {}), requestedQty: qty || 1, ...(reason ? { requestReason: reason } : {}) },
        crypto.randomUUID());
      setBusy(false);
      if (!r.ok) { setErr(r.error?.message ?? '新增失敗'); return; }
      router.refresh();
    }}>
      <Msg text={err} />
      <label className="field"><span className="lbl">商品／規格<span className="req"> *</span></span>
        <select name="pick" required data-testid="field-pick"><option value="">請選擇</option>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
      <label className="field half"><span className="lbl">申請數量</span><input type="number" min={1} defaultValue={1} name="requestedQty" data-testid="field-requestedQty" /></label>
      <label className="field"><span className="lbl">申請原因</span><textarea name="requestReason" rows={2} data-testid="field-requestReason" /></label>
      <button className="btn primary" type="submit" disabled={busy} data-testid="add-item-submit">{busy ? '新增中…' : '新增'}</button>
    </form>
  );
}

/** 逐項填寫核准數量的廠商供樣確認（整批送出，避免逐列往返） */
export function VendorReviewForm({ applicationId, items }: {
  applicationId: string;
  items: { id: string; label: string; requestedQty: number; approvedQty: number | null; vendorNote: string | null }[];
}) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form data-testid="vendor-review-form" onSubmit={async (e) => {
      e.preventDefault();
      if (busy) return;
      const fd = new FormData(e.currentTarget);
      const body = {
        decision: String(fd.get('decision') ?? 'SUPPLY'),
        note: String(fd.get('note') ?? '').trim() || undefined,
        items: items.map((i) => ({
          itemId: i.id,
          approvedQty: Number(String(fd.get(`qty-${i.id}`) ?? i.requestedQty)),
          vendorNote: String(fd.get(`note-${i.id}`) ?? '').trim() || undefined,
        })),
      };
      setBusy(true); setErr(null);
      const r = await callApi(`/api/collaboration/applications/${applicationId}/vendor-review`, 'POST', body);
      setBusy(false);
      if (!r.ok) { setErr(r.error?.message ?? '送出失敗'); return; }
      router.refresh();
    }}>
      <Msg text={err} />
      {items.map((i) => (
        <div key={i.id}>
          <label className="field half"><span className="lbl">{i.label}（申請 {i.requestedQty}）</span>
            <input type="number" min={0} max={i.requestedQty} name={`qty-${i.id}`} defaultValue={i.approvedQty ?? i.requestedQty} data-testid={`field-qty-${i.id}`} /></label>
          <label className="field"><span className="lbl">備註</span>
            <input name={`note-${i.id}`} defaultValue={i.vendorNote ?? ''} data-testid={`field-vendornote-${i.id}`} /></label>
        </div>
      ))}
      <label className="field"><span className="lbl">整筆決定</span>
        <select name="decision" defaultValue="SUPPLY" data-testid="field-decision">
          <option value="SUPPLY">依上面的數量供樣</option>
          <option value="DECLINE">整筆無法供應</option>
        </select></label>
      <label className="field"><span className="lbl">說明</span><textarea name="note" rows={2} data-testid="field-review-note" /></label>
      <p className="small muted">核准數量不可大於申請數量。確認供樣只影響本模組，不會觸發公司的 G1～G5 核准。</p>
      <button className="btn primary" type="submit" disabled={busy} data-testid="vendor-review-submit">{busy ? '送出中…' : '送出'}</button>
    </form>
  );
}
