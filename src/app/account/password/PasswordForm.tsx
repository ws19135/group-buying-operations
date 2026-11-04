'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { callApi } from '@/ui/api';

export function PasswordForm({ forced }: { forced: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const fd = new FormData(e.currentTarget);
    const next = String(fd.get('newPassword') ?? '');
    if (next !== String(fd.get('confirm') ?? '')) { setErr('兩次輸入的新密碼不一致'); return; }
    setBusy(true); setErr(null);
    const r = await callApi('/api/auth/change-password', 'POST', { currentPassword: String(fd.get('currentPassword') ?? ''), newPassword: next });
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? '變更失敗'); return; }
    router.push('/'); router.refresh();
  }
  return (
    <form onSubmit={submit} data-testid="password-form">
      {err ? <div className="banner error" role="alert" data-testid="password-error">{err}</div> : null}
      <label className="field"><span className="lbl">目前密碼{forced ? '（管理者提供的初始密碼）' : ''}</span><input type="password" name="currentPassword" required autoComplete="current-password" data-testid="pw-current" /></label>
      <label className="field"><span className="lbl">新密碼（至少 12 字元，含英文字母與數字）</span><input type="password" name="newPassword" required minLength={12} autoComplete="new-password" data-testid="pw-new" /></label>
      <label className="field"><span className="lbl">再輸入一次新密碼</span><input type="password" name="confirm" required minLength={12} autoComplete="new-password" data-testid="pw-confirm" /></label>
      <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center' }} data-testid="pw-submit">{busy ? '儲存中…' : '儲存新密碼'}</button>
    </form>
  );
}
