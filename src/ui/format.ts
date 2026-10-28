export const money = (v: number | null | undefined): string => (v == null ? '—' : `NT$ ${Math.round(v).toLocaleString('en-US')}`);
export const num = (v: number | null | undefined): string => (v == null ? '—' : Math.round(v).toLocaleString('en-US'));
export const pct = (v: number | null | undefined, digits = 1): string => (v == null ? '—' : `${(v * 100).toFixed(digits)}%`);

export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return '—';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = typeof v === 'string' ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return String(v);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function fmtDateTime(v: string | Date | null | undefined): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return String(v);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
}

/** 將含 Date 的資料轉成可傳給 client component 的純 JSON */
export function plain<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

export function qs(base: Record<string, string | undefined>, over: Record<string, string | undefined> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...over })) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}
