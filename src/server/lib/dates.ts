/** 日期一律用 'YYYY-MM-DD' 字串（台北日曆日），運算以 UTC 午夜進行，避免時區位移 */
const RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

export function maxDate(...ds: (string | null | undefined)[]): string | null {
  const xs = ds.filter((d): d is string => !!d).sort();
  return xs.length ? xs[xs.length - 1] : null;
}

/** 兩個區間（含端點）是否重疊；任一端為 null 視為不重疊（資料不足不做判斷） */
export function rangesOverlap(aStart: string | null, aEnd: string | null, bStart: string | null, bEnd: string | null): boolean {
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  return aStart <= bEnd && bStart <= aEnd;
}

export function monthRange(ym: string): { start: string; end: string } {
  const [y, m] = ym.split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const next = new Date(Date.UTC(y, m, 1));
  const end = addDays(next.toISOString().slice(0, 10), -1);
  return { start, end };
}
