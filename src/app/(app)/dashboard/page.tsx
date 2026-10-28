import Link from 'next/link';
import { withActor, sp1, type SP } from '@/server/ui/session';
import { getAdminDashboard } from '@/server/modules/dashboard';
import { Banner, Badge, Card, EmptyState, KpiCard, PageHeader, StatusBadge, Table } from '@/ui/components';
import { CAMPAIGN_STATUS, SEVERITY, ownerRoleLabel, PLATFORM } from '@/ui/labels';
import { fmtDateTime, money, num, pct } from '@/ui/format';
import { STATUS_LABEL, type CampaignStatus } from '@/server/workflow/state';
import { as, type AdminDash, type CampaignHostRef } from '@/ui/types';

/** 檔期的參與團主：點名字進團主頁；未回覆的標示出來 */
function HostNames({ hosts }: { hosts: CampaignHostRef[] }) {
  if (!hosts.length) return <span className="muted">尚未邀請團主</span>;
  return <>{hosts.map((h, i) => (
    <span key={h.hostId}>{i ? '、' : ''}<Link href={`/hosts/${h.hostId}`}>{h.name}</Link>{h.status === 'CONFIRMED' ? '' : <span className="small muted">（{h.status === 'INVITED' ? '待回覆' : h.status === 'NO_RESPONSE' ? '未回覆' : h.status}）</span>}</span>
  ))}</>;
}

export const dynamic = 'force-dynamic';

const shiftMonth = (ym: string, d: number) => { const [y, m] = ym.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + d, 1)); return t.toISOString().slice(0, 7); };

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const d = as<AdminDash>(await getAdminDashboard(actor, q.month));
  const dq = d.dataQuality;
  const s = d.sales;
  const kpi = (id: string, label: string, fmt: (v: number | null) => string, k: { value: number | null; source?: string; formula?: string } | undefined, note?: string) =>
    <KpiCard key={id} id={id} label={label} value={fmt(k?.value ?? null)} note={note} source={k?.source} formula={k?.formula} />;
  const unattr = d.unattributedNet;
  const pipelineMap = new Map(d.pipeline.map((p) => [p.status, p.n]));
  const maxPipe = Math.max(1, ...pipelineMap.values());

  return (
    <>
      <PageHeader title="營運總覽" sub={`統計期間 ${d.period.from} ～ ${d.period.to}  資料產生時間 ${fmtDateTime(d.generatedAt)}`} testid="dashboard-admin"
        actions={<div className="btn-row"><Link className="btn sm" href={`?month=${shiftMonth(d.period.month, -1)}`} data-testid="month-prev">← 上月</Link><span data-testid="month-current"><strong>{d.period.month}</strong></span><Link className="btn sm" href={`?month=${shiftMonth(d.period.month, 1)}`} data-testid="month-next">下月 →</Link></div>} />

      {dq.status === 'DEMO' || dq.status === 'MIXED' ? <Banner kind="demo" testid="demo-banner">⚠️ {dq.status === 'MIXED' ? 'DEMO 示範資料：' : ''}{dq.statusLabel}</Banner> : null}
      {dq.status === 'NO_DATA' ? <Banner kind="nodata" testid="nodata-banner">{dq.statusLabel}。業績指標在接上訂單來源（至「訂單匯入」匯入 CSV）之前不會顯示數字。</Banner> : null}
      {dq.status === 'IMPORT' ? <Banner kind="ok" testid="import-banner">{dq.statusLabel}</Banner> : null}
      <div className="card" data-testid="data-quality" style={{ padding: '10px 14px' }}>
        <span className="small muted">最後匯入：</span> {dq.lastImport ? <><Link href="/imports">{dq.lastImport.id}</Link>（{dq.lastImport.sourceSystem}，{dq.lastImport.status}）完成於 {fmtDateTime(dq.lastImport.finishedAt)}，<strong>資料截至 {fmtDateTime(dq.lastImport.dataAsOf)}</strong></> : <span>尚無匯入紀錄</span>}
        {dq.openImportErrors > 0 ? <> ｜ <Badge tone="danger">{dq.openImportErrors} 筆匯入錯誤待處理</Badge></> : null}
        {dq.warnings.length ? <ul style={{ margin: '6px 0 0 18px', padding: 0 }} data-testid="dq-warnings">{dq.warnings.map((w: string) => <li key={w}>{w}</li>)}</ul> : null}
      </div>

      {s ? (
        <div className="grid cols-6" style={{ marginBottom: 16 }} data-testid="kpi-grid">
          {kpi('gmv', 'GMV', money, s.gmv)}
          {kpi('net', '有效淨銷售額', money, s.net, unattr != null && unattr !== 0 ? `未歸因團主：${money(unattr)}` : undefined)}
          {kpi('orders', '有效訂單數', num, s.orders)}
          {kpi('aov', 'AOV', money, s.aov)}
          {kpi('refundRate', '退款率', (v) => pct(v), s.refundRate)}
          {d.targets ? kpi('attainment', '目標達成率', (v) => pct(v), d.targets.attainment, d.targets.total == null ? '尚未設定檔期目標' : `目標合計 ${money(d.targets.total)}`) : null}
        </div>
      ) : <Banner kind="nodata">你的角色沒有檢視業績的權限，業績指標已隱藏。</Banner>}

      <div className="grid cols-4" style={{ marginBottom: 16 }} data-testid="todo-grid">
        <Link href="/tasks?overdue=1" className="kpi" data-testid="todo-overdue"><div className="label">逾期任務</div><div className="value" style={{ color: d.tasks.overdue ? 'var(--danger)' : undefined }}>{d.tasks.overdue}</div></Link>
        <Link href="/tasks?open=1" className="kpi" data-testid="todo-open"><div className="label">未完成任務／今日到期 {d.tasks.dueToday}</div><div className="value">{d.tasks.open}</div></Link>
        <Link href="/approvals?status=PENDING" className="kpi" data-testid="todo-approvals"><div className="label">待核准</div><div className="value">{d.pendingApprovals}</div></Link>
        <Link href="/exceptions" className="kpi" data-testid="todo-exceptions"><div className="label">未結例外</div><div className="value">{d.exceptions.reduce((a, x) => a + x.n, 0)}</div><div className="note">{d.exceptions.map((x) => `${SEVERITY[x.severity]?.label ?? x.severity} ${x.n}`).join('  ') || '無'}</div></Link>
      </div>

      <div className="grid cols-2">
        <Card title="檔期管線" testid="pipeline">
          {pipelineMap.size === 0 ? <EmptyState title="尚無檔期" /> : (Object.keys(STATUS_LABEL) as CampaignStatus[]).filter((k) => pipelineMap.has(k)).map((k) => (
            <div className="bar-row" key={k}><Link href={`/campaigns?status=${k}`}>{STATUS_LABEL[k]}</Link><div className="bar"><span style={{ width: `${((pipelineMap.get(k) ?? 0) / maxPipe) * 100}%` }} /></div><span className="mono right">{pipelineMap.get(k)}</span></div>
          ))}
          <p className="small muted">未指派的營運任務：{d.tasks.unassigned}&emsp;已封鎖：{d.tasks.blocked}&emsp;等待核准：{d.tasks.waitingApproval}</p>
        </Card>
        <Card title="未來 30 天開團／結團" testid="upcoming" flush>
          {d.upcoming.length === 0 ? <EmptyState title="未來 30 天沒有開團或結團" /> : (
            <Table head={['日期', '事件', '檔期', '團主', '廠商', '狀態']}>
              {d.upcoming.map((u) => (
                <tr key={`${u.id}${u.event}`} data-testid={`upcoming-${u.id}`}><td className="nowrap">{u.eventDate}</td><td>{u.event === 'OPEN' ? '開團' : '結團'}</td><td><Link href={`/campaigns/${u.id}`}>{u.title}</Link></td><td data-testid={`upcoming-hosts-${u.id}`}><HostNames hosts={u.hosts} /></td><td><Link href={`/vendors/${u.vendorId}`}>{u.vendorName}</Link></td><td><StatusBadge map={CAMPAIGN_STATUS} value={u.status} /></td></tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      <Card title="逾期任務" testid="overdue-list" flush>
        {d.overdueTasks.length === 0 ? <EmptyState title="目前沒有逾期任務 🎉" /> : (
          <Table head={['任務', '檔期', '團主', '廠商', '卡在誰', '負責人', '預定完成', '逾期']}>
            {d.overdueTasks.map((t) => (
              <tr key={t.id} data-testid={`overdue-${t.id}`}><td><Link href={`/campaigns/${t.campaignId}?tab=tasks`}>{t.name}</Link></td><td>{t.campaignTitle}</td><td data-testid={`overdue-hosts-${t.id}`}><HostNames hosts={t.hosts} /></td><td><Link href={`/vendors/${t.vendorId}`}>{t.vendorName}</Link></td><td>{ownerRoleLabel(t.ownerRole)}</td><td>{t.assigneeName ?? <span className="muted">未指派</span>}</td><td>{t.plannedEnd}</td><td><Badge tone="danger">{t.daysLate} 天</Badge></td></tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="廠商合作進度（逐檔）" testid="vendor-progress" flush>
        {d.vendorCampaigns.length === 0 ? <EmptyState title="目前沒有進行中的廠商檔期" /> : (
          <Table head={['廠商', '檔期', '狀態', '團主', '完成度', '下一個任務', '逾期']}>
            {d.vendorCampaigns.map((v) => (
              <tr key={v.campaignId} data-testid={`vendorprog-${v.campaignId}`}>
                <td><Link href={`/vendors/${v.vendorId}`}>{v.vendorName}</Link></td>
                <td><Link href={`/campaigns/${v.campaignId}`}>{v.title}</Link></td>
                <td><StatusBadge map={CAMPAIGN_STATUS} value={v.status} /></td>
                <td><HostNames hosts={v.hosts} /></td>
                <td className="nowrap">{v.tasksDone}/{v.tasksTotal}（{v.tasksTotal ? Math.round((v.tasksDone / v.tasksTotal) * 100) : 0}%）</td>
                <td>{v.nextTaskName ? <>{v.nextTaskName}<span className="small muted">&emsp;{v.nextTaskOwnerRole ? ownerRoleLabel(v.nextTaskOwnerRole) : ''}&emsp;{v.nextTaskDue ?? '未定'}</span></> : <span className="muted">全部完成</span>}</td>
                <td>{v.overdue ? <Badge tone="danger">{v.overdue}{v.vendorOverdue ? `（廠商 ${v.vendorOverdue}）` : ''}</Badge> : '—'}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <div>
        <Card title="團主績效（本期，依歸因）" testid="host-performance" flush>
          {!s ? <EmptyState title="無檢視權限" /> : d.hostPerformance.length === 0 ? <EmptyState title="本期沒有歸因到團主的訂單" hint={dq.status === 'NO_DATA' ? '待串接訂單資料' : undefined} /> : (
            <Table head={['團主', '檔數', '訂單', '有效淨銷售額']}>
              {(d.hostPerformance as { hostId: string; name: string; campaigns: number; net: number; orders: number }[]).map((h) => (
                <tr key={h.hostId} data-testid={`hostperf-${h.hostId}`}><td><Link href={`/hosts/${h.hostId}`}>{h.name}</Link></td><td>{h.campaigns}</td><td>{h.orders}</td><td className="num">{money(h.net)}</td></tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      <Card title="團主與社群概況" testid="community-overview">
        <div className="grid cols-3">
          <div><h3>團主</h3>{d.hosts.length ? (d.hosts as { status: string; n: number }[]).map((h) => <div key={h.status}>{h.status === 'ACTIVE' ? '合作中' : h.status === 'PAUSED' ? '暫停' : '已結束'}：{h.n}</div>) : <span className="muted">尚無團主</span>}</div>
          <div><h3>啟用中社群（依平台）</h3>{d.communities.byPlatform.length ? (d.communities.byPlatform as { platform: string; n: number }[]).map((p) => <div key={p.platform}>{PLATFORM[p.platform] ?? p.platform}：{p.n}</div>) : <span className="muted">尚無社群</span>}</div>
          <div><h3>未來 7 天曝光安排</h3><div className="value" style={{ fontSize: 24, fontWeight: 700 }}>{d.communities.plannedPlacementsNext7Days}</div><Link href="/calendar">看排程日曆</Link></div>
        </div>
      </Card>
    </>
  );
});
