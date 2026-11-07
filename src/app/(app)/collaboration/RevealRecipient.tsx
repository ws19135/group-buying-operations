'use client';
import { useState } from 'react';
import { callApi } from '@/ui/api';

interface Recipient {
  recipientName: string; recipientPhone: string; postalCode: string | null;
  addressLine: string | null; deliveryNote: string | null; confirmedAt: string | null; retentionUntil: string | null;
}

/**
 * 收件個資要按一下才取得。
 * 這不是前端藏資料——詳情頁的 API 本來就不回傳收件內容，
 * 必須走專用端點，後端每一次成功讀取都會寫一筆稽核。
 */
export function RevealRecipient({ applicationId }: { applicationId: string }) {
  const [data, setData] = useState<Recipient | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    if (busy) return;
    setBusy(true); setErr(null);
    const r = await callApi<Recipient>(`/api/collaboration/applications/${applicationId}/recipient`);
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? '無法讀取收件資料'); return; }
    setData(r.data ?? null);
  }

  if (data) {
    return (
      <div data-testid="recipient-revealed">
        <dl className="kv">
          <dt>收件人</dt><dd data-testid="recipient-name">{data.recipientName}</dd>
          <dt>聯繫電話</dt><dd data-testid="recipient-phone">{data.recipientPhone}</dd>
          <dt>地址</dt><dd data-testid="recipient-address">{data.postalCode ? `${data.postalCode} ` : ''}{data.addressLine ?? '—'}</dd>
          <dt>到貨備註</dt><dd>{data.deliveryNote ?? '—'}</dd>
          <dt>團主確認時間</dt><dd>{data.confirmedAt ? new Date(data.confirmedAt).toLocaleString('zh-TW') : '尚未確認'}</dd>
          <dt>保留至</dt><dd>{data.retentionUntil ?? '—'}</dd>
        </dl>
        <p className="small muted">本次讀取已記入稽核。請只在寄送所需的範圍內使用，不要另存副本。</p>
        <button type="button" className="btn sm" onClick={() => setData(null)} data-testid="btn-hide-recipient">收起</button>
      </div>
    );
  }
  return (
    <div>
      <button type="button" className="btn sm" onClick={load} disabled={busy} data-testid="btn-reveal-recipient">
        {busy ? '讀取中…' : '顯示收件資訊（會留下稽核紀錄）'}
      </button>
      {err ? <p className="small" role="alert" data-testid="recipient-error">{err}</p> : null}
    </div>
  );
}
