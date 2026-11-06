'use client';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { callApi } from '@/ui/api';
import { useToast } from '@/ui/Toast';
import type { Opt } from '@/server/ui/options';
import type { ProductOpt } from '../CollaborationForms';

interface PreviewIssue { code: string; message: string; blocking: boolean }
interface PreviewResult {
  batchId: string; totalRows: number; staged: number; duplicates: number; needsReview: number;
  unknownColumns: string[];
  rows: { rowNo: number; hostNameRaw: string | null; productNameRaw: string | null; issues: PreviewIssue[]; resolution: string }[];
}

/**
 * 第一步：上傳廠商現有的表單一／表單二。
 * 只做預覽與驗證，主檔對應不明確的列會列成「待確認」，系統不會自己猜著合併。
 */
export function PreviewImportForm({ vendors }: { vendors: Opt[] }) {
  const router = useRouter();
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<PreviewResult | null>(null);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    setCsv(await f.text());
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const fd = new FormData(e.currentTarget);
    setBusy(true); setErr(null); setRes(null);
    const r = await callApi<PreviewResult>('/api/collaboration/imports/preview', 'POST', {
      kind: String(fd.get('kind') ?? ''),
      vendorId: String(fd.get('vendorId') ?? ''),
      csv,
      ...(fileName ? { fileName } : {}),
    });
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? '預覽失敗'); return; }
    const data = r.data as PreviewResult;
    setRes(data);
    toast(data.needsReview ? 'info' : 'ok', `已暫存 ${data.staged} 列，其中 ${data.needsReview} 列待確認`);
    router.push(`/collaboration/import?batch=${data.batchId}`);
  }

  return (
    <form onSubmit={submit} data-testid="collab-import-form">
      {err ? <div className="banner error" role="alert" data-testid="collab-import-error">{err}</div> : null}
      {res ? (
        <div className={`banner ${res.needsReview ? 'warn' : 'ok'}`} data-testid="collab-import-result">
          批次 {res.batchId}：共 {res.totalRows} 列，暫存 {res.staged} 列，重複略過 {res.duplicates} 列，待確認 {res.needsReview} 列。
          {res.unknownColumns.length ? <> 未對應的欄位：{res.unknownColumns.join('、')}（不會匯入）。</> : null}
        </div>
      ) : null}
      <div className="form-grid">
        <label className="field">
          <span className="lbl">表單格式<span className="req"> *</span></span>
          <select name="kind" required defaultValue="FORM2_SAMPLE" data-testid="field-kind">
            <option value="FORM2_SAMPLE">表單二：網紅名稱／收件人／電話／地址／申請樣品／配送日期／開團意願…</option>
            <option value="FORM1_LAUNCH">表單一：團購主／檔期／是否已補寄／開團連結／是否投廣／後台設定 Mail</option>
          </select>
          <span className="help">依標題列自動對應欄位；對不到的欄位會列出來，不會亂塞</span>
        </label>
        <label className="field">
          <span className="lbl">這份檔案屬於哪一家廠商<span className="req"> *</span></span>
          <select name="vendorId" required defaultValue="" data-testid="field-vendorId">
            <option value="">請選擇</option>
            {vendors.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
          </select>
          <span className="help">商品對應只會在這家廠商的商品裡找</span>
        </label>
      </div>
      <label className="field"><span className="lbl">選擇 CSV（逗號分隔檔）檔案</span><input type="file" accept=".csv,text/csv" onChange={onFile} data-testid="field-file" /></label>
      <label className="field">
        <span className="lbl">或直接貼上內容<span className="req"> *</span></span>
        <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={8} required style={{ fontFamily: 'monospace' }} data-testid="field-csv" />
        <span className="help">第一列必須是標題列。檔案內含收件人電話與地址時，請確認你有權限處理這些個資</span>
      </label>
      <button className="btn primary" type="submit" disabled={busy || !csv.trim()} data-testid="collab-import-submit">{busy ? '驗證中…' : '上傳並預覽'}</button>
    </form>
  );
}

/**
 * 第二步：逐列修正主檔對應。
 * 名字相同但不是同一人的風險由人判斷，所以這裡只提供選單，不提供「自動比對」。
 */
export function ResolveRowForm({ rowId, hosts, products, vendorId, needProduct, close }: {
  rowId: string; hosts: Opt[]; products: ProductOpt[]; vendorId: string; needProduct: boolean; close: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mine = products.filter((p) => p.vendorId === vendorId);

  async function send(body: Record<string, unknown>, okMsg: string) {
    setBusy(true); setErr(null);
    const r = await callApi(`/api/collaboration/import-rows/${rowId}`, 'PATCH', body);
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? '儲存失敗'); return; }
    toast('ok', okMsg);
    close();
    router.refresh();
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const fd = new FormData(e.currentTarget);
    const hostId = String(fd.get('hostId') ?? '').trim();
    const combo = String(fd.get('product') ?? '').trim();
    const [productId, skuId] = combo ? combo.split('|') : ['', ''];
    const note = String(fd.get('note') ?? '').trim();
    await send({
      ...(hostId ? { hostId } : {}),
      ...(productId ? { productId } : {}),
      ...(skuId ? { skuId } : {}),
      ...(note ? { note } : {}),
    }, '已更新對應');
  }

  return (
    <>
      {err ? <div className="banner error" role="alert" data-testid="resolve-error">{err}</div> : null}
      <form onSubmit={submit} data-testid={`resolve-form-${rowId}`}>
        <div className="form-grid">
          <label className="field">
            <span className="lbl">對應到哪一位團主</span>
            <select name="hostId" defaultValue="" data-testid="field-hostId">
              <option value="">（未選）</option>
              {hosts.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
            </select>
            <span className="help">同名不一定同人，請確認後再選；找不到就先建立團主主檔</span>
          </label>
          <label className="field">
            <span className="lbl">對應到哪一個商品／規格{needProduct ? <span className="req"> *</span> : null}</span>
            <select name="product" required={needProduct} defaultValue="" data-testid="field-product">
              <option value="">（未選）</option>
              {mine.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
            <span className="help">規格是同一個商品底下的選項，不是另一個商品</span>
          </label>
        </div>
        <label className="field"><span className="lbl">處理說明</span><textarea name="note" rows={2} data-testid="field-note" /></label>
        <div className="btn-row">
          <button type="submit" className="btn primary" disabled={busy} data-testid={`resolve-submit-${rowId}`}>{busy ? '處理中…' : '儲存對應'}</button>
          <button type="button" className="btn" disabled={busy} data-testid={`resolve-skip-${rowId}`}
            onClick={() => send({ skip: true, note: '營運判斷這一列不匯入' }, '已跳過這一列')}>跳過這一列</button>
        </div>
      </form>
    </>
  );
}
