'use client';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { callApi } from './api';
import { useToast } from './Toast';

export interface FieldDef {
  name: string; label: string;
  type?: 'text' | 'textarea' | 'select' | 'date' | 'number' | 'checkbox' | 'email' | 'password' | 'url' | 'time' | 'datetime-local';
  required?: boolean; options?: { value: string; label: string }[]; placeholder?: string; help?: string;
  defaultValue?: string | number | boolean | null; min?: number; max?: number; half?: boolean;
}

interface Props {
  fields: FieldDef[]; endpoint: string; method?: 'POST' | 'PATCH';
  submitLabel: string; extra?: Record<string, unknown>; idempotent?: boolean;
  /** 成功後導向；{id} 會以回應 data.id 取代 */
  redirectTo?: string; successMessage?: string; testid?: string; onDone?: () => void; variant?: 'primary' | 'danger';
}

export function ApiForm({ fields, endpoint, method = 'POST', submitLabel, extra, idempotent, redirectTo, successMessage, testid, onDone, variant = 'primary' }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const idem = useMemo(() => (idempotent ? crypto.randomUUID() : undefined), [idempotent]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const fd = new FormData(e.currentTarget);
    const body: Record<string, unknown> = { ...(extra ?? {}) };
    for (const f of fields) {
      if (f.type === 'checkbox') { body[f.name] = fd.get(f.name) === 'on'; continue; }
      const raw = String(fd.get(f.name) ?? '').trim();
      if (raw === '') continue;
      body[f.name] = f.type === 'number' ? Number(raw) : raw;
    }
    setBusy(true); setErr(null);
    const r = await callApi<{ id?: string }>(endpoint, method, body, idem);
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? '送出失敗'); return; }
    toast('ok', successMessage ?? '已儲存');
    onDone?.();
    formRef.current?.closest('dialog')?.close();
    if (redirectTo) router.push(redirectTo.replace('{id}', String((r.data as { id?: string })?.id ?? ''))); else router.refresh();
  }

  return (
    <form ref={formRef} onSubmit={submit} data-testid={testid}>
      {err ? <div className="banner error" role="alert" data-testid="form-error">{err} <button type="button" className="close" onClick={() => setErr(null)} aria-label="關閉">✕</button></div> : null}
      <div className="form-grid">
        {fields.map((f) => (
          <label key={f.name} className="field" style={f.type === 'textarea' || !f.half && fields.length < 3 ? { gridColumn: '1 / -1' } : undefined}>
            {f.type === 'checkbox' ? (
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" name={f.name} defaultChecked={!!f.defaultValue} data-testid={`field-${f.name}`} /><span className="lbl" style={{ margin: 0 }}>{f.label}</span></span>
            ) : (
              <>
                <span className="lbl">{f.label}{f.required ? <span className="req"> *</span> : null}</span>
                {f.type === 'textarea' ? <textarea name={f.name} required={f.required} placeholder={f.placeholder} defaultValue={String(f.defaultValue ?? '')} data-testid={`field-${f.name}`} />
                  : f.type === 'select' ? (
                    <select name={f.name} required={f.required} defaultValue={String(f.defaultValue ?? '')} data-testid={`field-${f.name}`}>
                      {!f.required || f.defaultValue == null ? <option value="">{f.required ? '請選擇' : '（未選）'}</option> : null}
                      {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : <input type={f.type ?? 'text'} name={f.name} required={f.required} placeholder={f.placeholder} defaultValue={f.defaultValue == null ? '' : String(f.defaultValue)} min={f.min} max={f.max} step={f.type === 'number' ? 'any' : undefined} data-testid={`field-${f.name}`} autoComplete={f.type === 'password' ? 'current-password' : undefined} />}
              </>
            )}
            {f.help ? <span className="help">{f.help}</span> : null}
          </label>
        ))}
      </div>
      <div className="btn-row"><button type="submit" className={`btn ${variant}`} disabled={busy} data-testid={testid ? `${testid}-submit` : 'btn-submit'}>{busy ? '處理中…' : submitLabel}</button></div>
    </form>
  );
}
