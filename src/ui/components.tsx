import type { ReactNode } from 'react';
import Link from 'next/link';
import { lab, type Lab, type Tone } from './labels';

export function Badge({ tone = 'neutral', children, testid }: { tone?: Tone; children: ReactNode; testid?: string }) {
  return <span className={`badge tone-${tone}`} data-testid={testid}>{children}</span>;
}

export function StatusBadge({ map, value, testid }: { map: Record<string, Lab>; value: string | null | undefined; testid?: string }) {
  const l = lab(map, value);
  return <Badge tone={l.tone} testid={testid}>{l.label}</Badge>;
}

export function PageHeader({ title, sub, actions, testid }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; testid?: string }) {
  return (
    <div className="page-header" data-testid={testid ?? 'page-header'}>
      <div className="titles"><h1>{title}</h1>{sub ? <div className="sub">{sub}</div> : null}</div>
      {actions ? <div className="actions">{actions}</div> : null}
    </div>
  );
}

export function Card({ title, children, flush, testid, actions }: { title?: ReactNode; children: ReactNode; flush?: boolean; testid?: string; actions?: ReactNode }) {
  return (
    <section className={`card${flush ? ' flush' : ''}`} data-testid={testid}>
      {title ? <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: flush ? '14px 16px 0' : 0 }}><h2>{title}</h2>{actions}</div> : null}
      {children}
    </section>
  );
}

export function EmptyState({ title = '目前沒有資料', hint, action }: { title?: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty" data-testid="empty-state"><div className="icon">📭</div><div><strong>{title}</strong></div>{hint ? <div className="small">{hint}</div> : null}{action ? <div style={{ marginTop: 10 }}>{action}</div> : null}</div>
  );
}

export function ErrorNotice({ message }: { message: string }) {
  return <div className="banner error" role="alert" data-testid="error-notice">{message}</div>;
}

export function Banner({ kind, children, testid }: { kind: 'demo' | 'nodata' | 'error' | 'ok' | 'warn'; children: ReactNode; testid?: string }) {
  return <div className={`banner ${kind}`} data-testid={testid}>{children}</div>;
}

export function ProgressBar({ value, total, danger }: { value: number; total: number; danger?: boolean }) {
  const p = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} title={`${value}/${total}`}>
      <div className={`progress${danger ? ' danger' : ''}`} style={{ flex: 1 }}><span style={{ width: `${p}%` }} /></div>
      <span className="small muted nowrap">{value}/{total}</span>
    </div>
  );
}

export function KpiCard({ id, label, value, note, source, formula, tag }: { id: string; label: string; value: string; note?: string; source?: string; formula?: string; tag?: ReactNode }) {
  return (
    <div className="kpi" data-testid={`kpi-${id}`}>
      <div className="label"><span>{label}</span>{tag}</div>
      <div className={`value${value === '—' ? ' null' : ''}`} data-testid={`kpi-${id}-value`}>{value}</div>
      {note ? <div className="note">{note}</div> : null}
      {formula ? <details><summary>口徑</summary><p>來源：{source}<br />{formula}</p></details> : null}
    </div>
  );
}

export function Pagination({ total, limit, offset, base }: { total: number; limit: number; offset: number; base: Record<string, string> }) {
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  const href = (p: number) => { const q = new URLSearchParams({ ...base, page: String(p) }); return `?${q.toString()}`; };
  return (
    <div className="pager" data-testid="pagination">
      <span className="muted">共 {total} 筆</span>
      {page > 1 ? <Link className="btn sm" href={href(page - 1)}>上一頁</Link> : null}
      <span>第 {page} / {pages} 頁</span>
      {page < pages ? <Link className="btn sm" href={href(page + 1)}>下一頁</Link> : null}
    </div>
  );
}

export function Tabs({ tabs, current, base }: { tabs: { key: string; label: string }[]; current: string; base: string }) {
  return (
    <nav className="tabs" data-testid="tabs">
      {tabs.map((t) => <Link key={t.key} href={`${base}?tab=${t.key}`} className={t.key === current ? 'active' : ''} data-testid={`tab-${t.key}`}>{t.label}</Link>)}
    </nav>
  );
}

export function Table({ head, children, testid, empty }: { head: ReactNode[]; children: ReactNode; testid?: string; empty?: ReactNode }) {
  return (
    <div className="table-wrap" data-testid={testid}>
      <table>
        <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
      {empty}
    </div>
  );
}

export function Filters({ children, action }: { children: ReactNode; action?: string }) {
  return <form method="get" action={action} className="filters" data-testid="filters">{children}<button className="btn" type="submit" data-testid="btn-filter">篩選</button></form>;
}

export function Kv({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="kv">{rows.flatMap(([k, v]) => [<dt key={`k${k}`}>{k}</dt>, <dd key={`v${k}`}>{v ?? '—'}</dd>])}</dl>;
}

export const dashIfNull = (v: string | null | undefined) => (v == null || v === '' ? '—' : v);
