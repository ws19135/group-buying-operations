'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { callApi } from './api';
import { useToast } from './Toast';
import { Modal } from './Modal';

interface Props {
  endpoint: string; method?: 'POST' | 'PATCH'; body?: Record<string, unknown>; label: string;
  variant?: 'primary' | 'danger' | ''; small?: boolean; confirm?: string; testid?: string;
  /** 需要使用者填寫原因／說明時設定；內容會以 reasonKey 帶入 body */
  reasonLabel?: string; reasonKey?: string; reasonRequired?: boolean; successMessage?: string; redirectTo?: string;
}

export function ActionButton({ endpoint, method = 'POST', body, label, variant = '', small, confirm, testid, reasonLabel, reasonKey = 'reason', reasonRequired = true, successMessage, redirectTo }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const size = small ? 'btn sm' : 'btn';

  async function run(reason?: string, close?: () => void) {
    if (busy) return;
    if (confirm && !reasonLabel && !window.confirm(confirm)) return;
    setBusy(true); setErr(null);
    const r = await callApi(endpoint, method, { ...(body ?? {}), ...(reason !== undefined ? { [reasonKey]: reason } : {}) });
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? '操作失敗'); toast('error', r.error?.message ?? '操作失敗'); return; }
    toast('ok', successMessage ?? '操作完成');
    close?.();
    if (redirectTo) router.push(redirectTo); else router.refresh();
  }

  if (!reasonLabel) {
    return <button type="button" className={`${size} ${variant}`.trim()} disabled={busy} onClick={() => run()} data-testid={testid}>{busy ? '處理中…' : label}</button>;
  }
  return (
    <Modal label={label} title={label} variant={variant} size={small ? 'btn sm' : 'btn'} testid={testid}>
      {(close) => (
        <form onSubmit={(e) => { e.preventDefault(); const v = String(new FormData(e.currentTarget).get('reason') ?? '').trim(); if (reasonRequired && !v) { setErr(`請填寫${reasonLabel}`); return; } run(v, close); }}>
          {confirm ? <p>{confirm}</p> : null}
          {err ? <div className="banner error" role="alert">{err}</div> : null}
          <label className="field"><span className="lbl">{reasonLabel}{reasonRequired ? <span className="req"> *</span> : null}</span><textarea name="reason" data-testid="field-reason" /></label>
          <div className="btn-row"><button type="submit" className={`btn ${variant || 'primary'}`} disabled={busy} data-testid={testid ? `${testid}-submit` : 'btn-submit'}>{busy ? '處理中…' : '確認'}</button></div>
        </form>
      )}
    </Modal>
  );
}
