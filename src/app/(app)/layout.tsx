import type { ReactNode } from 'react';
import { requireActor } from '@/server/ui/session';
import { can, ROLE_LABEL, type Permission } from '@/server/lib/permissions';
import { listMyNotifications } from '@/server/modules/notifications';
import { Shell, type NavItem } from '@/ui/Shell';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const actor = await requireActor();
  const unread = (await listMyNotifications(actor, new URLSearchParams('unread=1'))).unread;
  const has = (p: Permission) => can(actor, p);
  const home = actor.role === 'HOST' ? '/dashboard/host' : '/dashboard';
  const items: (NavItem & { show: boolean })[] = [
    { href: home, label: '總覽', testid: 'nav-dashboard', group: '營運', show: has('dashboard.admin') || has('dashboard.host') },
    { href: '/campaigns', label: '檔期', testid: 'nav-campaigns', group: '營運', show: has('campaign.read') },
    { href: '/calendar', label: '排程日曆', testid: 'nav-calendar', group: '營運', show: has('campaign.read') },
    { href: '/tasks', label: '任務', testid: 'nav-tasks', group: '營運', show: has('task.read') },
    { href: '/approvals', label: '核准', testid: 'nav-approvals', group: '營運', show: has('approval.read') },
    { href: '/vendors', label: '廠商', testid: 'nav-vendors', group: '主檔', show: has('vendor.read') || has('vendor.self') },
    { href: '/hosts', label: '團主', testid: 'nav-hosts', group: '主檔', show: has('host.read') || has('host.self') },
    { href: '/communities', label: '社群', testid: 'nav-communities', group: '主檔', show: has('community.read') },
    { href: '/products', label: '商品', testid: 'nav-products', group: '主檔', show: has('product.read') },
    { href: '/imports', label: '訂單匯入', testid: 'nav-imports', group: '資料與監控', show: has('order.read') },
    { href: '/exceptions', label: '例外', testid: 'nav-exceptions', group: '資料與監控', show: has('exception.read') },
    { href: '/automation', label: '自動化', testid: 'nav-automation', group: '資料與監控', show: has('automation.manage') },
    { href: '/audit', label: '稽核', testid: 'nav-audit', group: '資料與監控', show: has('audit.read') },
    { href: '/users', label: '使用者', testid: 'nav-users', group: '系統', show: has('user.manage') },
  ];
  const nav: NavItem[] = items.filter((i) => i.show).map(({ show: _s, ...rest }) => rest);
  return <Shell nav={nav} userName={actor.name} roleLabel={ROLE_LABEL[actor.role]} unread={unread}>{children}</Shell>;
}
