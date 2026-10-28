import Link from 'next/link';
import { withActor, sp1, toQuery, type SP } from '@/server/ui/session';
import { listTasks } from '@/server/modules/tasks';
import { Badge, Card, EmptyState, Filters, PageHeader, Pagination, StatusBadge, Table } from '@/ui/components';
import { TASK_STATUS, ownerRoleLabel, ROLE_OPTIONS } from '@/ui/labels';
import { as, type Paged } from '@/ui/types';

export const dynamic = 'force-dynamic';

interface Row { id: string; campaignId: string; campaignTitle: string; name: string; phase: number; ownerRole: string; assigneeName: string | null; kind: string; status: string; plannedStart: string | null; plannedEnd: string | null; overdue: boolean; dateLocked: boolean; scheduleIssue: string | null }

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const res = as<Paged<Row>>(await listTasks(actor, toQuery(q)));
  const base = Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'page'));
  return (
    <>
      <PageHeader title="任務" sub="跨檔期的任務清單；點任務名稱前往檔期處理" />
      <Filters>
        <label>狀態<select name="status" defaultValue={q.status ?? ''} data-testid="filter-status"><option value="">全部</option>{Object.entries(TASK_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
        <label>負責角色<select name="ownerRole" defaultValue={q.ownerRole ?? ''}><option value="">全部</option>{ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></label>
        <label><input type="checkbox" name="mine" value="1" defaultChecked={q.mine === '1'} /> 指派給我</label>
        <label><input type="checkbox" name="open" value="1" defaultChecked={q.open === '1'} data-testid="filter-open" /> 只看未完成</label>
        <label><input type="checkbox" name="overdue" value="1" defaultChecked={q.overdue === '1'} data-testid="filter-overdue" /> 只看逾期</label>
        {q.campaignId ? <input type="hidden" name="campaignId" value={q.campaignId} /> : null}
      </Filters>
      <Card flush testid="task-list">
        {res.items.length === 0 ? <EmptyState title="沒有符合條件的任務" /> : (
          <Table head={['任務', '檔期', '階段', '負責角色／人', '預定期間', '狀態']}>
            {res.items.map((t) => (
              <tr key={t.id} data-testid={`task-row-${t.id}`}>
                <td><Link href={`/campaigns/${t.campaignId}?tab=tasks`}><strong>{t.name}</strong></Link>{t.kind === 'GATE' ? <> <Badge tone="info">關卡</Badge></> : null}{t.dateLocked ? ' 🔒' : ''}{t.scheduleIssue ? <div className="small" style={{ color: 'var(--danger)' }}>⚠ {t.scheduleIssue}</div> : null}</td>
                <td>{t.campaignTitle}</td><td>{t.phase}</td><td>{ownerRoleLabel(t.ownerRole)}<div className="small muted">{t.assigneeName ?? '未指派'}</div></td>
                <td className="nowrap">{t.plannedStart ?? '—'} ～ {t.plannedEnd ?? '—'}</td>
                <td>{t.overdue ? <Badge tone="danger">已逾期</Badge> : null} <StatusBadge map={TASK_STATUS} value={t.status} /></td>
              </tr>
            ))}
          </Table>
        )}
        <Pagination total={res.total} limit={res.limit} offset={res.offset} base={base} />
      </Card>
    </>
  );
});
