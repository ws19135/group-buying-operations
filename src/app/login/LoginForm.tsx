'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { callApi } from '@/ui/api';

export function LoginForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const fd = new FormData(e.currentTarget);
    setBusy(true); setErr(null);
    const r = await callApi('/api/auth/login', 'POST', { email: String(fd.get('email') ?? ''), password: String(fd.get('password') ?? '') });
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? '登入失敗'); return; }
    router.push('/'); router.refresh();
  }
  return (
    <form onSubmit={submit} data-testid="login-form">
      {err ? <div className="banner error" role="alert" data-testid="login-error">{err}</div> : null}
      <label className="field"><span className="lbl">Email</span><input type="email" name="email" required autoComplete="username" data-testid="login-email" /></label>
      <label className="field"><span className="lbl">密碼</span><input type="password" name="password" required autoComplete="current-password" data-testid="login-password" /></label>
      <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center' }} data-testid="login-submit">{busy ? '登入中…' : '登入'}</button>
    </form>
  );
}
