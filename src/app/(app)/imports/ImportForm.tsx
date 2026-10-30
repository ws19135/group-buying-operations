'use client';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { callApi } from '@/ui/api';
import { useToast } from '@/ui/Toast';

interface Result { batchId: string; status: string; totalRows: number; insertedOrders: number; updatedOrders: number; duplicateOrders: number; errorRows: number }

export function ImportForm() {
  const router = useRouter();
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<Result | null>(null);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name); setCsv(await f.text());
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const fd = new FormData(e.currentTarget);
    const asOf = String(fd.get('dataAsOf') ?? '').trim();
    const body: Record<string, unknown> = { sourceSystem: String(fd.get('sourceSystem') ?? '').trim(), csv, ...(fileName ? { fileName } : {}) };
    if (asOf) body.dataAsOf = new Date(asOf).toISOString();
    setBusy(true); setErr(null); setRes(null);
    const r = await callApi<Result>('/api/imports', 'POST', body);
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? '匯入失敗'); return; }
    setRes(r.data as Result);
    toast(r.data?.errorRows ? 'info' : 'ok', `匯入完成：新增 ${r.data?.insertedOrders}、更新 ${r.data?.updatedOrders}、重複略過 ${r.data?.duplicateOrders}、錯誤 ${r.data?.errorRows}`);
    router.refresh();
  }
  return (
    <form onSubmit={submit} data-testid="import-form">
      {err ? <div className="banner error" role="alert" data-testid="import-error">{err}</div> : null}
      {res ? <div className={`banner ${res.errorRows ? 'warn' : 'ok'}`} data-testid="import-result">批次 {res.batchId}：{res.status}。總列數 {res.totalRows}，新增訂單 {res.insertedOrders}，更新 {res.updatedOrders}，重複略過 {res.duplicateOrders}，錯誤列 {res.errorRows}。</div> : null}
      <div className="form-grid">
        <label className="field"><span className="lbl">來源系統名稱<span className="req"> *</span></span><input name="sourceSystem" required defaultValue="CSV_UPLOAD" data-testid="field-sourceSystem" /><span className="help">與「來源訂單編號」一起作為去重鍵</span></label>
        <label className="field"><span className="lbl">資料截至時間（選填）</span><input type="datetime-local" name="dataAsOf" data-testid="field-dataAsOf" /><span className="help">未填則取檔案中最新的下單時間</span></label>
      </div>
      <label className="field"><span className="lbl">選擇 CSV（逗號分隔檔）檔案</span><input type="file" accept=".csv,text/csv" onChange={onFile} data-testid="field-file" /></label>
      <label className="field"><span className="lbl">或直接貼上 CSV（逗號分隔檔）內容<span className="req"> *</span></span><textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={8} required style={{ fontFamily: 'monospace' }} data-testid="field-csv" /></label>
      <button className="btn primary" type="submit" disabled={busy || !csv.trim()} data-testid="import-submit">{busy ? '匯入中…' : '匯入'}</button>
    </form>
  );
}
