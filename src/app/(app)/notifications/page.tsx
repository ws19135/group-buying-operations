import Link from 'next/link';
import { withActor, sp1, toQuery, type SP } from '@/server/ui/session';
import { listMyNotifications } from '@/server/modules/notifications';
import { ActionButton } from '@/ui/ActionButton';
import { Badge, Card, EmptyState, PageHeader } from '@/ui/components';
import { fmtDateTime } from '@/ui/format';
import { as } from '@/ui/types';

export const dynamic = 'force-dynamic';
interface N { id: string; subject: string; body: string; entityType: string | null; entityId: string | null; status: string; createdAt: string; readAt: string | null }

function href(n: N): string | null {
  if (n.entityType === 'campaign' && n.entityId) return `/campaigns/${n.entityId}`;
  if (n.entityType === 'approval') return '/approvals';
  if (n.entityType === 'task') return '/tasks';
  if (n.entityType === 'import_batch') return '/imports';
  if (n.entityType === 'intake') return '/automation';
  return null;
}

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const r = as<{ items: N[]; unread: number }>(await listMyNotifications(actor, toQuery(q)));
  return (
    <>
      <PageHeader title="通知" sub={`未讀 ${r.unread} 則（僅站內通知；系統目前不會對外發送 Email／LINE）`} actions={<Link className="btn sm" href={q.unread ? '/notifications' : '/notifications?unread=1'}>{q.unread ? '看全部' : '只看未讀'}</Link>} />
      <Card testid="notification-list">
        {r.items.length === 0 ? <EmptyState title="沒有通知" /> : (
          <ul className="list-plain">{r.items.map((n) => (
            <li key={n.id} data-testid={`notification-${n.id}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
              <div>{!n.readAt ? <Badge tone="info">未讀</Badge> : null} <strong>{n.subject}</strong><div className="small">{n.body}</div><div className="small muted">{fmtDateTime(n.createdAt)}{href(n) ? <> ・<Link href={href(n) as string}>前往</Link></> : null}</div></div>
              {!n.readAt ? <ActionButton endpoint={`/api/notifications/${n.id}/read`} label="標示已讀" small testid={`btn-read-${n.id}`} /> : null}
            </li>))}</ul>
        )}
      </Card>
    </>
  );
});
