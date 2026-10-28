import Link from 'next/link';
import { withActor, sp1, type SP } from '@/server/ui/session';
import { getHostDashboard } from '@/server/modules/dashboard';
import { Banner, Badge, Card, EmptyState, KpiCard, PageHeader, StatusBadge, Table } from '@/ui/components';
import { ActionButton } from '@/ui/ActionButton';
import { CAMPAIGN_STATUS, HOST_PART, PLACEMENT_TYPE, TASK_STATUS } from '@/ui/labels';
import { fmtDateTime, money, num, pct } from '@/ui/format';
import { as, type HostDash } from '@/ui/types';

export const dynamic = 'force-dynamic';

const shiftMonth = (ym: string, d: number) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + d, 1)).toISOString().slice(0, 7); };

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const d = as<HostDash>(await getHostDashboard(actor, q.hostId, q.month));
  const dq = d.dataQuality;
  const preview = actor.role !== 'HOST';
  const hostQ = q.hostId ? `&hostId=${q.hostId}` : '';
  const grouped = new Map<string, HostDash['calendar']>();
  for (const c of d.calendar) grouped.set(c.date, [...(grouped.get(c.date) ?? []), c]);

  return (
    <>
      <PageHeader title={`我的團購總覽 — ${d.host.name}`} sub={`統計期間 ${d.period.from} ～ ${d.period.to}  資料產生時間 ${fmtDateTime(d.generatedAt)}`} testid="dashboard-host"
        actions={<div className="btn-row"><Link className="btn sm" href={`?month=${shiftMonth(d.period.month, -1)}${hostQ}`}>← 上月</Link><strong>{d.period.month}</strong><Link className="btn sm" href={`?month=${shiftMonth(d.period.month, 1)}${hostQ}`}>下月 →</Link></div>} />
      {preview ? <Banner kind="warn" testid="preview-banner">👁 正在以團主視角預覽（{d.host.name}）。此畫面與該團主本人看到的內容相同。</Banner> : null}
      {dq.status === 'DEMO' || dq.status === 'MIXED' ? <Banner kind="demo" testid="demo-banner">⚠️ {dq.status === 'MIXED' ? 'DEMO 示範資料：' : ''}{dq.statusLabel}</Banner> : null}
      {dq.status === 'NO_DATA' ? <Banner kind="nodata" testid="nodata-banner">{dq.statusLabel}。業績與預估佣金將在訂單資料接上後顯示。</Banner> : null}
      <div className="card" data-testid="data-quality" style={{ padding: '10px 14px' }}>
        <span className="small muted">資料更新：</span> {dq.lastImport ? <>最後同步 {fmtDateTime(dq.lastImport.finishedAt)}，<strong>資料截至 {fmtDateTime(dq.lastImport.dataAsOf)}</strong></> : '尚無同步紀錄'}
        {dq.warnings.length ? <ul style={{ margin: '6px 0 0 18px', padding: 0 }} data-testid="dq-warnings">{dq.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
      </div>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <KpiCard id="gmv" label="本期 GMV（歸因給我）" value={money(d.performance.gmv.value)} source={d.performance.gmv.source} formula={d.performance.gmv.formula} />
        <KpiCard id="net" label="本期有效淨銷售額" value={money(d.performance.net.value)} source={d.performance.net.source} formula={d.performance.net.formula} />
        <KpiCard id="orders" label="本期有效訂單數" value={num(d.performance.orders.value)} source={d.performance.orders.source} formula={d.performance.orders.formula} />
        <KpiCard id="estCommission" label="預估佣金（預估，非正式結算）" value={money(d.commission.estimatedTotal.value)} note={d.commission.basis} source={d.commission.estimatedTotal.source} formula={d.commission.estimatedTotal.formula} tag={<Badge tone="warn">預估</Badge>} />
      </div>

      {d.pendingInvites.length ? (
        <Card title="待我回覆的邀請" testid="pending-invites">
          <ul className="list-plain">
            {d.pendingInvites.map((p) => (
              <li key={p.id} data-testid={`invite-${p.id}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span><Link href={`/campaigns/${p.id}`}>{p.title}</Link> <span className="muted small">開團 {p.openDate ?? '未定'}</span></span>
                {!preview ? <span className="btn-row">
                  <ActionButton endpoint={`/api/campaigns/${p.id}/hosts/${d.host.id}/respond`} body={{ status: 'CONFIRMED' }} label="確認參與" variant="primary" small testid={`btn-confirm-${p.id}`} successMessage="已確認參與" />
                  <ActionButton endpoint={`/api/campaigns/${p.id}/hosts/${d.host.id}/respond`} body={{ status: 'DECLINED' }} label="婉拒" variant="danger" small reasonLabel="婉拒原因" reasonKey="note" testid={`btn-decline-${p.id}`} successMessage="已婉拒" />
                </span> : <Badge tone="info">預覽模式不可回覆</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="我的檔期" testid="my-campaigns" flush>
        {d.myCampaigns.length === 0 ? <EmptyState title="目前沒有被邀請或進行中的檔期" /> : (
          <Table head={['檔期', '狀態', '期間', '我的角色', '我的目標', '我的淨銷售', '達成率', '預估佣金（預估）']}>
            {d.myCampaigns.map((c) => (
              <tr key={c.id} data-testid={`mycampaign-${c.id}`}>
                <td><Link href={`/campaigns/${c.id}`}>{c.title}</Link></td>
                <td><StatusBadge map={CAMPAIGN_STATUS} value={c.status} /> <StatusBadge map={HOST_PART} value={c.myStatus} /></td>
                <td className="nowrap">{c.openDate ?? '—'} ～ {c.closeDate ?? '—'}</td>
                <td>{c.myRole === 'PRIMARY' ? '主要團主' : '共同團主'}</td>
                <td className="num">{money(c.myTarget)}</td>
                <td className="num">{money(c.myNet)}</td>
                <td className="num">{pct(c.attainment)}</td>
                <td className="num" title={c.commissionNote}>{c.estimatedCommission == null ? <span className="muted small">{c.commissionRate == null ? '未設定費率' : '—'}</span> : <>{money(c.estimatedCommission)} <span className="small muted">({c.commissionRate}%)</span></>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <div className="grid cols-2">
        <Card title="我的待辦事項" testid="my-todos" flush>
          {d.todos.length === 0 ? <EmptyState title="目前沒有待辦" /> : (
            <Table head={['任務', '檔期', '預定完成', '狀態']}>
              {d.todos.map((t) => (
                <tr key={t.id} data-testid={`todo-${t.id}`}><td><Link href={`/tasks?campaignId=${t.campaignId}`}>{t.name}</Link></td><td>{t.campaignTitle}</td><td className="nowrap">{t.plannedEnd ?? '—'}</td><td>{t.overdue ? <Badge tone="danger">已逾期</Badge> : <StatusBadge map={TASK_STATUS} value={t.status} />}</td></tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title="試用品與素材確認狀態" testid="trial-assets" flush>
          {d.trialAndAssets.length === 0 ? <EmptyState title="沒有相關項目" /> : (
            <Table head={['檔期', '項目', '預定', '狀態']}>
              {d.trialAndAssets.map((t) => (
                <tr key={`${t.campaignId}${t.stepKey}`}><td>{t.campaignTitle}</td><td>{t.name}</td><td className="nowrap">{t.plannedEnd ?? '—'}</td><td><StatusBadge map={TASK_STATUS} value={t.status} /></td></tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      <Card title="未來 60 天行事曆" testid="my-calendar">
        {grouped.size === 0 ? <EmptyState title="未來 60 天沒有排定的曝光、開團或結團" /> : [...grouped.entries()].map(([date, items]) => (
          <div key={date} style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <strong>{date}</strong>
            <div>{items.map((i, idx) => (
              <div key={idx}><Badge tone={i.kind === 'OPEN' ? 'ok' : i.kind === 'CLOSE' ? 'warn' : 'info'}>{i.kind === 'PLACEMENT' ? (PLACEMENT_TYPE[i.label] ?? i.label) : i.label}</Badge>{' '}
                <Link href={`/campaigns/${i.campaignId}`}>{i.campaignTitle}</Link>{i.communityName ? <span className="muted small"> ・{i.communityName}</span> : null}</div>
            ))}</div>
          </div>
        ))}
      </Card>

      <Card title="結算進度" testid="settlement-progress">
        <p className="small muted">※ 正式佣金結算屬 Phase 2，目前只顯示各檔期所處階段；上方「預估佣金」僅為預估，不代表已確認金額。</p>
        {d.settlementProgress.length === 0 ? <EmptyState title="沒有檔期" /> : (
          <ul className="list-plain">{d.settlementProgress.map((s) => <li key={s.campaignId}><Link href={`/campaigns/${s.campaignId}`}>{s.title}</Link>&emsp;<StatusBadge map={CAMPAIGN_STATUS} value={s.status} />&emsp;{s.stage}</li>)}</ul>
        )}
      </Card>
    </>
  );
});
