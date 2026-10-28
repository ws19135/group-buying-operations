import { withActor, sp1, toQuery, type SP } from '@/server/ui/session';
import { listJobs, listRuns } from '@/server/modules/automation';
import { ActionButton } from '@/ui/ActionButton';
import { Banner, Badge, Card, EmptyState, PageHeader, StatusBadge, Table } from '@/ui/components';
import { RUN_STATUS } from '@/ui/labels';
import { fmtDateTime } from '@/ui/format';
import { as } from '@/ui/types';

export const dynamic = 'force-dynamic';
interface J { jobKey: string; label: string; enabled: boolean; lastRun: { status: string; startedAt: string; finishedAt: string | null; error: string | null; stats: unknown } | null }
interface R { id: string; jobKey: string; idempotencyKey: string; trigger: string; status: string; attempts: number; startedAt: string; finishedAt: string | null; error: string | null; stats: unknown }

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const jobs = as<J[]>(await listJobs(actor));
  const runs = as<R[]>(await listRuns(actor, toQuery(q)));
  return (
    <>
      <PageHeader title="自動化中心" sub="每個工作都是冪等、可重試、可停用，並留下執行紀錄" />
      <Banner kind="warn" testid="automation-notice"><strong>預設全部停用。</strong>目前通知僅走「測試 Adapter」：只寫入資料庫，<strong>不會對任何真人發送 Email／LINE</strong>；站內通知只有系統內可見。此處不會安裝任何排程觸發器，實際排程需由 Worker 執行（見部署文件）。</Banner>
      <Card flush testid="job-list">
        <Table head={['工作', '啟用', '最近一次執行', '統計', '操作']}>
          {jobs.map((j) => (
            <tr key={j.jobKey} data-testid={`job-${j.jobKey}`}>
              <td><strong>{j.label}</strong><div className="small muted">{j.jobKey}</div></td>
              <td>{j.enabled ? <Badge tone="ok" testid={`job-enabled-${j.jobKey}`}>已啟用</Badge> : <Badge tone="neutral" testid={`job-enabled-${j.jobKey}`}>已停用</Badge>}</td>
              <td>{j.lastRun ? <><StatusBadge map={RUN_STATUS} value={j.lastRun.status} /><div className="small muted">{fmtDateTime(j.lastRun.startedAt)}</div>{j.lastRun.error ? <div className="small" style={{ color: 'var(--danger)' }}>{j.lastRun.error}</div> : null}</> : <span className="muted">尚未執行</span>}</td>
              <td className="small"><code>{j.lastRun ? JSON.stringify(j.lastRun.stats) : ''}</code></td>
              <td><div className="btn-row">
                <ActionButton endpoint={`/api/automation/jobs/${j.jobKey}`} body={{ action: j.enabled ? 'disable' : 'enable' }} label={j.enabled ? '停用' : '啟用'} small testid={`btn-toggle-${j.jobKey}`} successMessage={j.enabled ? '已停用' : '已啟用'} />
                <ActionButton endpoint={`/api/automation/jobs/${j.jobKey}`} body={{ action: 'run' }} label="立即執行一次" small variant="primary" testid={`btn-run-${j.jobKey}`} successMessage="已觸發執行（結果見下方紀錄；未啟用的工作會被略過）" />
              </div></td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="執行紀錄" flush testid="run-list">
        {runs.length === 0 ? <EmptyState title="尚無執行紀錄" /> : (
          <Table head={['編號', '工作', '觸發', '狀態', '次數', '開始', '結束', '統計／錯誤']}>
            {runs.map((r) => (
              <tr key={r.id} data-testid={`run-row-${r.id}`}><td className="small">{r.id}</td><td>{r.jobKey}</td><td>{r.trigger}</td><td><StatusBadge map={RUN_STATUS} value={r.status} /></td><td>{r.attempts}</td><td className="small">{fmtDateTime(r.startedAt)}</td><td className="small">{fmtDateTime(r.finishedAt)}</td>
                <td className="small">{r.error ? <span style={{ color: 'var(--danger)' }}>{r.error}</span> : <code>{JSON.stringify(r.stats)}</code>}</td></tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
});
