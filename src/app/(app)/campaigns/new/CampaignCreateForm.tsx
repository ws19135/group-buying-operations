'use client';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { callApi } from '@/ui/api';
import { useToast } from '@/ui/Toast';

interface Opt { value: string; label: string }
interface ProductOpt { id: string; name: string; skus: { id: string; label: string }[] }

export function CampaignCreateForm({ vendors, hosts, canSetTarget }: { vendors: Opt[]; hosts: Opt[]; canSetTarget: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const idem = useMemo(() => crypto.randomUUID(), []);
  const [vendorId, setVendorId] = useState('');
  const [products, setProducts] = useState<ProductOpt[]>([]);
  const [picked, setPicked] = useState<Record<string, string>>({}); // key productId|skuId -> campaignPrice
  const [hostPicked, setHostPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string[]>([]);

  useEffect(() => {
    setPicked({});
    if (!vendorId) { setProducts([]); return; }
    let live = true;
    (async () => {
      const r = await callApi<{ items: { id: string; name: string }[] }>(`/api/products?vendorId=${vendorId}&limit=200`);
      if (!live || !r.ok) return;
      const out: ProductOpt[] = [];
      for (const p of r.data?.items ?? []) {
        const d = await callApi<{ skus: { id: string; skuCode: string; name: string; groupPrice: number | null }[] }>(`/api/products/${p.id}`);
        out.push({ id: p.id, name: p.name, skus: (d.data?.skus ?? []).map((s) => ({ id: s.id, label: `${s.name}（${s.skuCode}${s.groupPrice != null ? `，團購價 ${s.groupPrice}` : ''}）` })) });
      }
      if (live) setProducts(out);
    })();
    return () => { live = false; };
  }, [vendorId]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const fd = new FormData(e.currentTarget);
    const s = (k: string) => String(fd.get(k) ?? '').trim();
    const body: Record<string, unknown> = { title: s('title'), vendorId };
    for (const k of ['openDate', 'closeDate', 'sampleReadyDate', 'liveTalkDate', 'description', 'internalNote']) if (s(k)) body[k] = s(k);
    body.needsSampleRecovery = fd.get('needsSampleRecovery') === 'on';
    if (canSetTarget && s('targetRevenue')) body.targetRevenue = Number(s('targetRevenue'));
    body.products = Object.entries(picked).map(([k, price]) => { const [productId, skuId] = k.split('|'); return { productId, ...(skuId ? { skuId } : {}), ...(price ? { campaignPrice: Number(price) } : {}) }; });
    body.hosts = hostPicked.map((hostId) => ({ hostId }));
    setBusy(true); setErr(null); setWarn([]);
    const r = await callApi<{ id: string; tasksCreated: number; conflicts: { message: string; severity: string }[] }>('/api/campaigns', 'POST', body, idem);
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? '建立失敗'); return; }
    const conflicts = r.data?.conflicts ?? [];
    toast('ok', `已建立檔期 ${r.data?.id}，產生 ${r.data?.tasksCreated} 項任務${conflicts.length ? `；有 ${conflicts.length} 項衝突提醒` : ''}`);
    if (conflicts.length) { setWarn(conflicts.map((c) => `[${c.severity}] ${c.message}`)); setTimeout(() => router.push(`/campaigns/${r.data?.id}`), 2500); } else router.push(`/campaigns/${r.data?.id}`);
  }

  return (
    <form onSubmit={submit} data-testid="campaign-create-form">
      {err ? <div className="banner error" role="alert" data-testid="form-error">{err}<button type="button" className="close" onClick={() => setErr(null)} aria-label="關閉">✕</button></div> : null}
      {warn.length ? <div className="banner warn" data-testid="conflict-warning"><strong>已建立，但有檔期衝突提醒：</strong><ul>{warn.map((w) => <li key={w}>{w}</li>)}</ul></div> : null}
      <div className="form-grid">
        <label className="field"><span className="lbl">檔期名稱<span className="req"> *</span></span><input name="title" required data-testid="field-title" placeholder="例：夏日防曬噴霧 團購" /></label>
        <label className="field"><span className="lbl">廠商<span className="req"> *</span></span>
          <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} required data-testid="field-vendorId"><option value="">請選擇</option>{vendors.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}</select></label>
        <label className="field"><span className="lbl">試用品可寄出日</span><input type="date" name="sampleReadyDate" data-testid="field-sampleReadyDate" /><span className="help">整條試用流程的排程起點；必須早於開團日</span></label>
        <label className="field"><span className="lbl">開團日</span><input type="date" name="openDate" data-testid="field-openDate" /></label>
        <label className="field"><span className="lbl">結團日</span><input type="date" name="closeDate" data-testid="field-closeDate" /></label>
        <label className="field"><span className="lbl">Live Talk 日期（選填）</span><input type="date" name="liveTalkDate" data-testid="field-liveTalkDate" /><span className="help">有填才會產生 Live Talk 任務</span></label>
        {canSetTarget ? <label className="field"><span className="lbl">檔期業績目標（TWD）</span><input type="number" min={0} name="targetRevenue" data-testid="field-targetRevenue" /></label> : null}
        <label className="field"><span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" name="needsSampleRecovery" data-testid="field-needsSampleRecovery" /><span className="lbl" style={{ margin: 0 }}>需要回收試用品</span></span></label>
        <label className="field" style={{ gridColumn: '1 / -1' }}><span className="lbl">說明</span><textarea name="description" /></label>
      </div>

      <h2>商品與規格</h2>
      {!vendorId ? <p className="muted">請先選擇廠商，再挑選要上架的商品與規格。</p> : products.length === 0 ? <p className="muted" data-testid="no-products">此廠商尚無商品，可先建立檔期，之後再到檔期加入商品。</p> : (
        <div className="table-wrap"><table data-testid="product-picker"><thead><tr><th></th><th>商品／規格</th><th>檔期價（選填）</th></tr></thead><tbody>
          {products.flatMap((p) => (p.skus.length ? p.skus.map((s) => ({ key: `${p.id}|${s.id}`, label: `${p.name} ／ ${s.label}` })) : [{ key: `${p.id}|`, label: `${p.name}（無規格）` }])).map((o) => (
            <tr key={o.key}><td><input type="checkbox" checked={o.key in picked} onChange={(e) => setPicked((x) => { const n = { ...x }; if (e.target.checked) n[o.key] = ''; else delete n[o.key]; return n; })} data-testid={`pick-${o.key}`} /></td><td>{o.label}</td>
              <td><input type="number" min={0} disabled={!(o.key in picked)} value={picked[o.key] ?? ''} onChange={(e) => setPicked((x) => ({ ...x, [o.key]: e.target.value }))} style={{ maxWidth: 140 }} /></td></tr>
          ))}
        </tbody></table></div>
      )}

      <h2 style={{ marginTop: 16 }}>邀請團主</h2>
      {hosts.length === 0 ? <p className="muted">尚無團主可選。</p> : <div className="checks" data-testid="host-picker">{hosts.map((h) => (
        <label key={h.value}><input type="checkbox" checked={hostPicked.includes(h.value)} onChange={(e) => setHostPicked((x) => e.target.checked ? [...x, h.value] : x.filter((y) => y !== h.value))} data-testid={`pick-host-${h.value}`} />{h.label}</label>
      ))}</div>}

      <div className="btn-row" style={{ marginTop: 18 }}><button type="submit" className="btn primary" disabled={busy} data-testid="campaign-create-submit">{busy ? '建立中…' : '建立檔期'}</button></div>
    </form>
  );
}
