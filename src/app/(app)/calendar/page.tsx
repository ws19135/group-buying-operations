import Link from 'next/link';
import { withActor } from '@/server/ui/session';
import { loadCalendar } from '@/server/ui/calendar';
import { addDays, diffDays } from '@/server/lib/dates';
import { Badge, Card, EmptyState, PageHeader, StatusBadge, Table } from '@/ui/components';
import { PLACEMENT_STATUS, PLACEMENT_TYPE, WEEKDAY } from '@/ui/labels';

export const dynamic = 'force-dynamic';

const COLOR: Record<string, string> = { RUNNING: '#15803d', SCHEDULED: '#0f766e', PREPARING: '#1d4ed8', PENDING_G2: '#6d28d9', PENDING_G1: '#6d28d9', EVALUATING: '#64748b', DRAFT: '#94a3b8', PENDING_CLOSE_CHECK: '#a15c07', FULFILLING: '#a15c07', ON_HOLD: '#a15c07' };
const WEEKS = 13;

export default withActor(async (actor) => {
  const cal = await loadCalendar(actor, WEEKS * 7);
  // 以「週」為欄：從今天所在週的週日開始
  const startDow = new Date(`${cal.from}T00:00:00Z`).getUTCDay();
  const gridStart = addDays(cal.from, -startDow);
  const weekStarts = Array.from({ length: WEEKS }, (_, i) => addDays(gridStart, i * 7));
  const col = (d: string) => Math.min(WEEKS - 1, Math.max(0, Math.floor(diffDays(d, gridStart) / 7)));
  return (
    <>
      <PageHeader title="排程日曆" sub={`未來 90 天（${cal.from} ～ ${cal.to}），每一欄為一週（週日起）`} />
      <Card title="檔期時間軸" testid="calendar-timeline" flush>
        {cal.campaigns.length === 0 ? <EmptyState title="未來 90 天沒有已排日期的檔期" /> : (
          <div className="timeline" style={{ padding: 12, overflowX: 'auto' }}>
            <div className="tl-head"><div>檔期</div>{weekStarts.map((w) => <div key={w} title={w}>{w.slice(5)}</div>)}</div>
            {cal.campaigns.map((c) => {
              const a = col(c.openDate ?? cal.from), b = col(c.closeDate ?? cal.to);
              return (
                <div className="tl-row" key={c.id} data-testid={`cal-row-${c.id}`}>
                  <div className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><Link href={`/campaigns/${c.id}`}>{c.title}</Link></div>
                  {Array.from({ length: WEEKS }, (_, i) => i < a || i > b ? <div className="tl-cell" key={i} /> : i === a ? (
                    <div key={i} style={{ gridColumn: `span ${b - a + 1}` }}>
                      <div className="tl-bar" style={{ background: COLOR[c.status] ?? '#64748b' }} title={`${c.openDate} ～ ${c.closeDate}`}>
                        {c.openDate?.slice(5)}～{c.closeDate?.slice(5)}{c.highConflicts ? ' ⚠衝突' : c.conflicts ? ' ⚠' : ''}
                      </div>
                    </div>
                  ) : null)}
                </div>
              );
            })}
          </div>
        )}
        <div style={{ padding: '0 16px 12px' }} className="small muted">圖例：<Badge tone="ok">進行中</Badge> <Badge tone="primary">已排程</Badge> <Badge tone="info">籌備／待核准</Badge> ⚠ = 與其他檔期／團主安排有衝突提醒</div>
        {cal.campaigns.some((c) => c.conflicts > 0) ? (
          <div style={{ padding: '0 16px 12px' }} data-testid="calendar-conflicts">有衝突提醒的檔期：{cal.campaigns.filter((c) => c.conflicts > 0).map((c) => <Link key={c.id} href={`/campaigns/${c.id}?tab=overview`} style={{ marginRight: 8 }}>{c.title}（{c.highConflicts ? '高風險' : '中度'}）</Link>)}</div>
        ) : null}
      </Card>
      <Card title="曝光安排" flush testid="calendar-placements">
        {cal.placements.length === 0 ? <EmptyState title="未來 90 天沒有排定的曝光安排" /> : (
          <Table head={['日期', '週', '檔期', '團主', '社群', '形式', '狀態']}>
            {cal.placements.map((p) => (
              <tr key={p.id} data-testid={`cal-placement-${p.id}`}><td className="nowrap">{p.on}</td><td>{WEEKDAY[new Date(`${p.on}T00:00:00Z`).getUTCDay()]}</td><td><Link href={`/campaigns/${p.campaignId}`}>{p.campaignTitle}</Link></td><td>{p.hostName}</td><td>{p.communityName}</td><td>{PLACEMENT_TYPE[p.type] ?? p.type}</td><td><StatusBadge map={PLACEMENT_STATUS} value={p.status} /></td></tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
});
