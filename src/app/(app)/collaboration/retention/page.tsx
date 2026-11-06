import { withActor } from '@/server/ui/session';
import { can } from '@/server/lib/permissions';
import { forbidden } from '@/server/lib/errors';
import { listPurgeRuns, retentionStatus } from '@/server/modules/collaboration-retention';
import { ActionButton } from '@/ui/ActionButton';
import { Badge, Banner, Card, EmptyState, KpiCard, PageHeader, Table } from '@/ui/components';
import { fmtDateTime } from '@/ui/format';
import { as } from '@/ui/types';

export const dynamic = 'force-dynamic';

interface RunV {
  id: string; triggerSource: string; dryRun: boolean; status: string; candidates: number; purged: number; skippedHold: number;
  skippedFulfilment: number; forcedByCap: number; failed: number; stagingScrubbed: number; errorSummary: string | null; startedAt: string; finishedAt: string | null;
}
const ALERT: Record<string, string> = {
  NEVER_RUN: '已有到期的收件資料，但清除作業從未執行過',
  LAST_RUN_FAILED: '最近一次清除有失敗的項目，請查看執行紀錄',
  OVERDUE_BACKLOG: '有收件資料逾期超過 7 天仍未清除',
};

/** 個資保留與清除狀態（營運主管、管理者）。沒有排程：清除由人工或隔離環境腳本觸發，正式排程需 Owner 另行授權 */
export default withActor(async (actor) => {
  if (!can(actor, 'collaboration.retention.manage')) throw forbidden();
  const st = await retentionStatus(actor);
  const runs = as<{ items: RunV[] }>(await listPurgeRuns(actor)).items;
  return (
    <>
      <PageHeader title="個資保留與清除" sub="收件人姓名、電話與地址的保留期限、清除執行紀錄與健康狀態。政策：核准日起 90 天、送達後依最後寄送日起 30 天，取較早者；履約未結束會延後，硬性上限為核准後 180 天。"
        actions={<div className="btn-row">
          <ActionButton endpoint="/api/collaboration/recipients/purge-expired" body={{ dryRun: true }} label="試跑（不改資料）" small testid="btn-purge-dry-run" successMessage="試跑完成，結果見下方執行紀錄" />
          {actor.role === 'SYSTEM_ADMIN' ? (
            <ActionButton endpoint="/api/collaboration/recipients/purge-expired" body={{}} label="執行清除" small variant="danger" confirm="會永久清空已到期的收件人、電話與地址，無法復原。" testid="btn-purge-run" successMessage="清除完成" />
          ) : null}
        </div>} />
      {st.alerts.length ? <Banner kind="warn" testid="retention-alerts">{st.alerts.map((a) => ALERT[a] ?? a).join('；')}</Banner> : <Banner kind="nodata" testid="retention-ok">目前沒有待處理的警示。</Banner>}
      <Banner kind="nodata">本系統沒有排程：清除只會在人工按下按鈕或由隔離環境腳本執行時發生。正式環境的自動排程需要 Owner 另行授權後才能啟用。</Banner>
      <div className="grid cols-4" data-testid="retention-kpis">
        <KpiCard id="ret-unpurged" label="尚未清除的收件資料" value={String(st.unpurgedRecipients)} />
        <KpiCard id="ret-due" label="已到期" value={String(st.dueRecipients)} note="含履約未結束而延後的" />
        <KpiCard id="ret-overdue" label="逾期超過 7 天" value={String(st.overdueOver7Days)} />
        <KpiCard id="ret-holds" label="生效中的保留例外" value={String(st.activeHolds)} />
      </div>
      <Card flush title="清除執行紀錄" testid="purge-runs">
        {runs.length === 0 ? <EmptyState title="還沒有執行紀錄" /> : (
          <Table head={['時間', '類型', '結果', '候選', '已清除', '例外保留', '履約延後', '上限強制', '失敗', '匯入暫存清理']}>
            {runs.map((r) => (
              <tr key={r.id} data-testid={`purge-run-${r.id}`}>
                <td className="small">{fmtDateTime(r.startedAt)}</td>
                <td>{r.dryRun ? <Badge>試跑</Badge> : <Badge tone="info">正式</Badge>}</td>
                <td><Badge tone={r.status === 'SUCCEEDED' ? 'ok' : r.status === 'RUNNING' ? 'neutral' : 'danger'}>{r.status}</Badge>{r.errorSummary ? <div className="small muted">{r.errorSummary}</div> : null}</td>
                <td>{r.candidates}</td><td>{r.purged}</td><td>{r.skippedHold}</td><td>{r.skippedFulfilment}</td><td>{r.forcedByCap}</td><td>{r.failed}</td><td>{r.stagingScrubbed}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
});
