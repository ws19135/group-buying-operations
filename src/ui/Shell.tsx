'use client';
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { callApi } from './api';
import { ToastProvider } from './Toast';

export interface NavItem { href: string; label: string; testid: string; group?: string }

export function Shell({ nav, userName, roleLabel, unread, children }: { nav: NavItem[]; userName: string; roleLabel: string; unread: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  const router = useRouter();
  const active = (href: string) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));
  // 最長前綴優先，避免 /dashboard 與 /dashboard/host 同時高亮
  const best = [...nav].filter((n) => active(n.href)).sort((a, b) => b.href.length - a.href.length)[0]?.href;
  let lastGroup = '';

  async function logout() {
    await callApi('/api/auth/logout', 'POST');
    router.push('/login'); router.refresh();
  }

  return (
    <ToastProvider>
      <div className="shell">
        <aside className={`sidebar${open ? ' open' : ''}`} data-testid="sidebar">
          <Link className="brand" href="/">🛒 團購 ERP</Link>
          <nav aria-label="主選單">
            {nav.map((n) => {
              const head = n.group && n.group !== lastGroup ? <div className="nav-group" key={`g-${n.group}`}>{n.group}</div> : null;
              lastGroup = n.group ?? lastGroup;
              return [head, <Link key={n.href} href={n.href} className={n.href === best ? 'active' : ''} data-testid={n.testid} onClick={() => setOpen(false)}>{n.label}</Link>];
            })}
          </nav>
        </aside>
        <div className="main">
          <header className="topbar">
            <button type="button" className="btn sm menu-toggle" onClick={() => setOpen(!open)} data-testid="menu-toggle" aria-label="選單">☰ 選單</button>
            <span className="spacer" />
            <Link href="/notifications" className="bell" data-testid="nav-bell" aria-label="通知">🔔{unread > 0 ? <span className="count" data-testid="bell-count">{unread}</span> : null}</Link>
            <span data-testid="user-name"><strong>{userName}</strong> <span className="badge tone-primary" data-testid="user-role">{roleLabel}</span></span>
            <button type="button" className="btn sm" onClick={logout} data-testid="btn-logout">登出</button>
          </header>
          <main className="content">{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}
