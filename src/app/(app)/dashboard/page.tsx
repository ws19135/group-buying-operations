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
  const d = as<AdminDash>(await getAdminDashboard(actor, q.month, q.range));
  const dq = d.dataQuality;
  const s = d.sales;
  const ordersHref = `/orders?from=${d.period.from}&to=${d.period.to}`;
  const kpi = (id: string, label: string, fmt: (v: number | null) => string, k: { value: number | null; source?: string; formula?: string } | undefined, note?: string, href?: string) =>
    <KpiCard key={id} id={id} label={label} value={fmt(k?.value ?? null)} note={note} source={k?.source} formula={k?.formula} href={href} />;
  const unattr = d.unattributedNet;
  const pipelineMap = new Map(d.pipeline.map((p) => [p.status, p.n]));
  const maxPipe = Math.max(1, ...pipelineMap.values());

  return (
    <>
      <PageHeader title="營運總覽" sub={`統計期間 ${d.period.from} ～ ${d.period.to}  資料產生時間 ${fmtDateTime(d.generatedAt)}`} testid="dashboard-admin"
        actions={<div className="btn-row" data-testid="period-switch">
          <Link className={`btn sm${d.period.mode === 'week' ? ' primary' : ''}`} href="?range=week" data-testid="period-week">本週</Link>
          <Link className={`btn sm${d.period.mode === 'month' ? ' primary' : ''}`} href={`?month=${d.period.mode === 'month' ? d.period.month : new Date().toISOString().slice(0, 7)}`} data-testid="period-month">本月</Link>
          {d.period.mode === 'month' ? <><Link className="btn sm" href={`?month=${shiftMonth(d.period.month, -1)}`} data-testid="month-prev">← 上月</Link><span data-testid="month-current"><strong>{d.period.month}</strong></span><Link className="btn sm" href={`?month=${shiftMonth(d.period.month, 1)}`} data-testid="month-next">下月 →</Link></> : <span data-testid="week-current"><strong>本週</strong></span>}
        </div>} />

      {dq.status === 'DEMO' || dq.status === 'MIXED' ? <Banner kind="demo" testid="demo-banner">⚠️ {dq.status === 'MIXED' ? 'DEMO 示範資料：' : ''}{dq.statusLabel}</Banner> : null}
      {dq.status === 'NO_DATA' ? <Banner kind="nodata" testid="nodata-banner">{dq.statusLabel}。業績指標在接上訂單來源（至「訂單匯入」匯入 CSV（逗號分隔檔））之前不會顯示數字。</Banner> : null}
      {dq.status === 'IMPORT' ? <Banner kind="ok" testid="import-banner">{dq.statusLabel}</Banner> : null}
      <div className="card" data-testid="data-quality" style={{ padding: '10px 14px' }}>
        <span className="small muted">最後匯入：</span> {dq.lastImport ? <><Link href="/imports">{dq.lastImport.id}</Link>（{dq.lastImport.sourceSystem}，{dq.lastImport.status}）完成於 {fmtDateTime(dq.lastImport.finishedAt)}，<strong>資料截至 {fmtDateTime(dq.lastImport.dataAsOf)}</strong></> : <span>尚無匯入紀錄</span>}
        {dq.openImportErrors > 0 ? <> ｜ <Badge tone="danger">{dq.openImportErrors} 筆匯入錯誤待處理</Badge></> : null}
        {dq.warnings.length ? <ul style={{ margin: '6px 0 0 18px', padding: 0 }} data-testid="dq-warnings">{dq.warnings.map((w: string) => <li key={w}>{w}</li>)}</ul> : null}
      </div>

      {s ? (
        <div className="grid cols-6" style={{ marginBottom: 16 }} data-testid="kpi-grid">
          {kpi('gmv', 'GMV（成交總額）', money, s.gmv, undefined, ordersHref)}
          {kpi('net', '有效淨銷售額', money, s.net, unattr != null && unattr !== 0 ? `未歸因團主：${money(unattr)}` : undefined, ordersHref)}
          {kpi('orders', '有效訂單數', num, s.orders, undefined, `${ordersHref}&status=PAID`)}
          {kpi('aov', 'AOV（客單價）', money, s.aov)}
          {kpi('refundRate', '退款率', (v) => pct(v), s.refundRate, undefined, `${ordersHref}&refunded=1`)}
          {d.targets ? kpi('attainment', '目標達成率', (v) => pct(v), d.targets.attainment, d.targets.total == null ? '尚未設定檔期目標' : `目標合計 ${money(d.targets.total)}`) : null}
        </div>
      ) : <Banner kind="nodata">你的角色沒有檢視業績的權限，業績指標已隱藏。</Banner>}

      <div className="grid cols-4" style={{ marginBottom: 6 }} data-testid="finance-grid">
        <KpiCard id="live-campaigns" label="進行中檔期" value={num(d.overview.liveCampaigns)} note={`跨 ${d.overview.liveHosts} 位團主（已排程到待結算）`} href="/campaigns" />
        {d.finance.estimatedCommission ? <KpiCard id="est-commission" label="預估佣金" value={money(d.finance.estimatedCommission.value)}
          note={d.finance.estimatedCommission.unrated ? `預估，非結算；${d.finance.estimatedCommission.unrated} 筆尚未設定費率` : '預估，尚待結算確認'}
          source={d.kpiDefinitions?.estCommission?.source} formula={d.kpiDefinitions?.estCommission?.formula} href="/finance" /> : null}
        {d.finance.confirmedCommission ? <KpiCard id="confirmed-commission" label="已確認佣金" value={money(d.finance.confirmedCommission.value)}
          note={`本期已確認結算 ${d.finance.confirmedCommission.items} 項（結算試算，口徑待確認）`}
          source="settlement_items（結算狀態為已確認）" formula="Σ（覆寫佣金，沒有覆寫則用試算佣金），確認時間落在本期" href="/finance?tab=settlements" /> : null}
        {d.finance.received ? <KpiCard id="received" label="已收款金額" value={money(d.finance.received.value)}
          note={`本期入帳 ${d.finance.received.count} 筆（人工入帳紀錄）`}
          source="payments（方向＝入帳、狀態有效）" formula="Σ amount，入帳日落在本期；不含已作廢" href="/finance?tab=payments" /> : null}
      </div>
      <p className="small muted" style={{ margin: '0 0 16px' }} data-testid="finance-note">GMV（成交總額）、預估佣金、已確認佣金、已收款金額是<strong>不同的指標</strong>，請勿混稱為「業績」。</p>

      <div className="grid cols-4" style={{ marginBottom: 16 }} data-testid="todo-grid">
        <Link href="/tasks?overdue=1" className="kpi" data-testid="todo-overdue"><div className="label">逾期任務</div><div className="value" style={{ color: d.tasks.overdue ? 'var(--danger)' : undefined }}>{d.tasks.overdue}</div></Link>
        <Link href="/tasks?open=1" className="kpi" data-testid="todo-open"><div className="label">未完成任務／今日到期 {d.tasks.dueToday}</div><div className="value">{d.tasks.open}</div></Link>
        <Link href="/approvals?status=PENDING" className="kpi" data-testid="todo-approvals"><div className="label">待核准</div><div className="value">{d.pendingApprovals}</div></Link>
        <Link href="/exceptions" className="kpi" data-testid="todo-exceptions"><div className="label">未結例外</div><div className="value">{d.exceptions.reduce((a, x) => a + x.n, 0)}</div><div className="note">{d.exceptions.map((x) => `${SEVERITY[x.severity]?.label ?? x.severity} ${x.n}`).join('  ') || '無'}</div></Link>
      </div>

      <div className="grid cols-2">
        <Card title="跨團主業績比較" testid="host-chart-card">
          {!s ? <EmptyState title="無檢視權限" /> : d.hostPerformance.length === 0 ? <EmptyState title="本期沒有歸因到團主的訂單" hint={dq.status === 'NO_DATA' ? '待串接訂單資料' : undefined} /> : (() => {
            const max = Math.max(1, ...d.hostPerformance.map((h) => h.net));
            return (
              <div className="vbars" data-testid="host-chart">
                {d.hostPerformance.slice(0, 8).map((h) => (
                  <Link key={h.hostId} href={`/hosts/${h.hostId}`} className="vbar" title={`${h.name}：${money(h.net)}（${h.orders} 筆）`} data-testid={`hostbar-${h.hostId}`}>
                    <span className="vbar-val">{money(h.net)}</span>
                    <span className="vbar-track"><span className="vbar-fill" style={{ height: `${Math.max(2, (h.net / max) * 100)}%` }} /></span>
                    <span className="vbar-label">{h.name}</span>
                  </Link>
                ))}
              </div>
            );
          })()}
          <p className="small muted">有效淨銷售額（依歸因分攤）；點長條進入團主頁。</p>
        </Card>
        <Card title="營運異常與待辦（依緊急程度排序）" testid="attention" flush>
          {d.attention.length === 0 ? <EmptyState title="目前沒有需要處理的異常 🎉" /> : (
            <ul className="attention-list">
              {d.attention.map((a, i) => (
                <li key={`${a.kind}-${i}`} data-testid={`attention-${a.kind}`}>
                  <div><Link href={a.href}><strong>{a.title}</strong></Link><div className="small muted">{a.detail}</div></div>
                  <Badge tone={a.tone}>{a.chip}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
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
                <tr key={`${u.id}${u.event}`} data-testid={`upcoming-${u.id}`}><td className="nowrap">{u.eventDate}</td><td className="nowrap">{u.event === 'OPEN' ? '開團' : '結團'}</td><td><Link href={`/campaigns/${u.id}`}>{u.title}</Link></td><td data-testid={`upcoming-hosts-${u.id}`}><HostNames hosts={u.hosts} /></td><td><Link href={`/vendors/${u.vendorId}`}>{u.vendorName}</Link></td><td><StatusBadge map={CAMPAIGN_STATUS} value={u.status} /></td></tr>
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

      <div className="grid cols-2">
        <Card title="社群業績排行（本期）" testid="community-rank" flush>
          {!s ? <EmptyState title="無檢視權限" /> : !d.communityRank || d.communityRank.length === 0 ? <EmptyState title="本期沒有歸因到社群的訂單" hint="訂單需帶社群編號才會歸因" /> : (
            <Table head={['社群', '平台', '訂單', '有效淨銷售額']}>
              {d.communityRank.map((c) => (
                <tr key={c.communityId} data-testid={`commrank-${c.communityId}`}><td><Link href={`/communities/${c.communityId}`}>{c.name}</Link></td><td>{PLATFORM[c.platform] ?? c.platform}</td><td>{c.orders}</td><td className="num">{money(c.net)}</td></tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="每檔團購產值（本期）" testid="campaign-output" flush>
          {!s ? <EmptyState title="無檢視權限" /> : !d.campaignOutput || d.campaignOutput.top.length === 0 ? <EmptyState title="本期沒有訂單" /> : (
            <>
              <p className="small muted" style={{ padding: '6px 16px 0' }} data-testid="campaign-output-avg">有訂單的檔期 {d.campaignOutput.campaigns} 檔，平均每檔有效淨銷售額 <strong>{money(d.campaignOutput.average)}</strong></p>
              <Table head={['檔期', '狀態', '訂單', '有效淨銷售額']}>
                {d.campaignOutput.top.map((c) => (
                  <tr key={c.id}><td><Link href={`/campaigns/${c.id}`}>{c.title}</Link></td><td><StatusBadge map={CAMPAIGN_STATUS} value={c.status} /></td><td>{c.orders}</td><td className="num">{money(c.net)}</td></tr>
                ))}
              </Table>
            </>
          )}
        </Card>
      </div>

      <div className="grid cols-2">
        <Card title="廠商合作成功率（暫定口徑）" testid="vendor-success" flush>
          {d.vendorSuccess.byVendor.length === 0 ? <EmptyState title="尚無已開團或已取消的檔期" /> : (
            <>
              <p className="small muted" style={{ padding: '6px 16px 0' }}>成功率＝已開團檔期 ÷（已開團＋已取消）；評估中、籌備中的檔期不計。{d.vendorSuccess.overall ? <>整體 <strong data-testid="vendor-success-overall">{d.vendorSuccess.overall.rate}%</strong>（{d.vendorSuccess.overall.launched}／{d.vendorSuccess.overall.launched + d.vendorSuccess.overall.cancelled}）</> : null}</p>
              <Table head={['廠商', '已開團', '已取消', '成功率']}>
                {d.vendorSuccess.byVendor.map((v) => (
                  <tr key={v.vendorId}><td><Link href={`/vendors/${v.vendorId}`}>{v.name}</Link></td><td>{v.launched}</td><td>{v.cancelled || '—'}</td><td>{v.rate}%</td></tr>
                ))}
              </Table>
            </>
          )}
        </Card>
        <Card title="檔期準時開團率（暫定口徑）" testid="ontime-launch">
          {d.onTimeLaunch.rate == null ? <EmptyState title="資料不足" hint="需要系統內「進行中」的轉換紀錄；直接匯入或人工調整的檔期不計入" /> : (
            <>
              <div className="value" style={{ fontSize: 28, fontWeight: 700 }} data-testid="ontime-rate">{d.onTimeLaunch.rate}%</div>
              <p className="small muted">{d.onTimeLaunch.onTime}／{d.onTimeLaunch.total} 檔在預定開團日（含）之前轉為進行中。</p>
            </>
          )}
        </Card>
      </div>

      <div className="grid cols-2">
        <Card title="商品復開績效（累計）" testid="product-repeat" flush>
          {d.productRepeat.length === 0 ? <EmptyState title="目前沒有出現在 2 檔以上的商品" /> : (
            <Table head={['商品', '檔數', '累計有效淨銷售額', '平均每檔']}>
              {d.productRepeat.map((p) => (
                <tr key={p.productId}><td><Link href={`/products/${p.productId}`}>{p.name}</Link></td><td>{p.campaigns}</td><td className="num">{money(p.net)}</td><td className="num">{money(p.avgPerCampaign)}</td></tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="資料來源與同步" testid="data-sources" flush>
          {!d.dataSources || d.dataSources.length === 0 ? <EmptyState title="尚無訂單資料" hint="待串接訂單來源" /> : (
            <Table head={['來源', '性質', '訂單數', '最後同步', '最近訂單']}>
              {d.dataSources.map((x) => (
                <tr key={`${x.sourceSystem}-${x.dataOrigin}`}><td>{x.sourceSystem}</td><td>{x.dataOrigin === 'DEMO' ? 'DEMO 示範' : x.dataOrigin === 'MANUAL' ? '廠商回報／人工確認' : '匯入檔'}</td><td>{x.orders}</td><td className="nowrap">{x.lastSync ? fmtDateTime(x.lastSync) : '—'}</td><td className="nowrap">{x.lastOrderAt ? fmtDateTime(x.lastOrderAt) : '—'}</td></tr>
              ))}
            </Table>
          )}
          <p className="small muted" style={{ padding: '0 16px 10px' }}>匯入後才更新；沒有訂單明細的合作標示「廠商回報／人工確認」，不裝成即時資料。</p>
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
