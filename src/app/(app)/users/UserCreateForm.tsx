'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { callApi } from '@/ui/api';
import { useToast } from '@/ui/Toast';

interface Opt { value: string; label: string }

export function UserCreateForm({ roles, hosts, vendors }: { roles: Opt[]; hosts: Opt[]; vendors: Opt[] }) {
  const router = useRouter();
  const toast = useToast();
  const [role, setRole] = useState('OPS_EDITOR');
  const [hostIds, setHostIds] = useState<string[]>([]);
  const [vendorIds, setVendorIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const fd = new FormData(e.currentTarget);
    const body: Record<string, unknown> = { email: String(fd.get('email')).trim(), name: String(fd.get('name')).trim(), role, password: String(fd.get('password')) };
    if (role === 'HOST') body.hostIds = hostIds;
    if (role === 'VENDOR') body.vendorIds = vendorIds;
    setBusy(true); setErr(null);
    const r = await callApi('/api/users', 'POST', body);
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? '建立失敗'); return; }
    toast('ok', '使用者已建立'); (e.target as HTMLFormElement).reset?.(); setHostIds([]); setVendorIds([]); router.refresh();
  }
  return (
    <form onSubmit={submit} data-testid="user-create-form">
      {err ? <div className="banner error" role="alert" data-testid="form-error">{err}</div> : null}
      <div className="form-grid">
        <label className="field"><span className="lbl">Email<span className="req"> *</span></span><input type="email" name="email" required data-testid="field-email" /></label>
        <label className="field"><span className="lbl">姓名<span className="req"> *</span></span><input name="name" required data-testid="field-name" /></label>
        <label className="field"><span className="lbl">角色<span className="req"> *</span></span><select value={role} onChange={(e) => setRole(e.target.value)} data-testid="field-role">{roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></label>
        <label className="field"><span className="lbl">初始密碼<span className="req"> *</span></span><input type="password" name="password" required minLength={10} autoComplete="new-password" data-testid="field-password" /><span className="help">至少 10 字元，需含英文字母與數字</span></label>
      </div>
      {role === 'HOST' ? <fieldset className="card"><legend>綁定團主（資料範圍）*</legend><div className="checks">{hosts.map((h) => <label key={h.value}><input type="checkbox" checked={hostIds.includes(h.value)} onChange={(e) => setHostIds((x) => e.target.checked ? [...x, h.value] : x.filter((y) => y !== h.value))} data-testid={`bind-host-${h.value}`} />{h.label}</label>)}</div></fieldset> : null}
      {role === 'VENDOR' ? <fieldset className="card"><legend>綁定廠商（資料範圍）*</legend><div className="checks">{vendors.map((h) => <label key={h.value}><input type="checkbox" checked={vendorIds.includes(h.value)} onChange={(e) => setVendorIds((x) => e.target.checked ? [...x, h.value] : x.filter((y) => y !== h.value))} data-testid={`bind-vendor-${h.value}`} />{h.label}</label>)}</div></fieldset> : null}
      <button className="btn primary" type="submit" disabled={busy} data-testid="user-create-submit">{busy ? '建立中…' : '建立使用者'}</button>
    </form>
  );
}
