import Link from 'next/link';
import { Badge, Card, EmptyState, StatusBadge } from '@/ui/components';
import { PLACEMENT_TYPE, TASK_STATUS, WEEKDAY, ownerRoleLabel } from '@/ui/labels';
import type { HostDash } from '@/ui/types';

const dayMs = 86_400_000;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);
/** 「今天／明天／後天／N 天後」＋星期；日期是台北時區的曆日，所以兩邊都用 UTC 午夜相減 */
export function relDay(date: string, today: string): string {
  const diff = Math.round((utc(date) - utc(today)) / dayMs);
  const rel = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '後天' : `${diff} 天後`;
  return `${date.slice(5)}（${WEEKDAY[new Date(utc(date)).getUTCDay()]}）${rel}`;
}

const KIND_TONE = { OPEN: 'ok', CLOSE: 'warn', PLACEMENT: 'info', TASK: 'neutral' } as const;
const KIND_LABEL = { OPEN: '開團', CLOSE: '結團', PLACEMENT: '曝光', TASK: '作業' } as const;

/**
 * 團主總覽最上面的兩個區塊：① 團購 SOP（標準作業流程）② 接下來兩週的進程。
 * 只讀取 getHostDashboard 已算好的資料；SOP 只列到「結團前催單」（共 11 步），結算以後屬內部作業。
 */
export function HostTop({ d }: { d: Pick<HostDash, 'sop' | 'upcoming'> }) {
  const { sop, upcoming } = d;
  const byDate = new Map<string, typeof upcoming.items>();
  for (const i of upcoming.items) byDate.set(i.date, [...(byDate.get(i.date) ?? []), i]);
  return (
    <div className="grid cols-2" style={{ marginBottom: 16 }} data-testid="host-top">
      <Card title="團購 SOP（標準作業流程）" testid="host-sop">
        <p className="small muted" style={{ marginTop: 0 }}>從寄樣到結團前的 11 個步驟；<Badge tone="primary">我負責</Badge> 是需要你動作的步驟，其餘由廠商或營運團隊處理。</p>
        {sop.steps.length === 0 ? <EmptyState title="尚未設定 SOP 流程" /> : (
          <ol className="list-plain" style={{ paddingLeft: 0 }} data-testid="host-sop-steps">
            {sop.steps.map((s, idx) => (
              <li key={s.stepKey} data-testid={`sop-step-${s.stepKey}`} title={s.description ?? undefined} style={s.mine ? { fontWeight: 600 } : undefined}>
                <span className="muted small" style={{ display: 'inline-block', width: 26 }}>{idx + 1}.</span>
                {s.name}{s.optional ? <span className="muted small">（視情況）</span> : null}{' '}
                {s.mine ? <Badge tone="primary">我負責</Badge> : <span className="muted small">{ownerRoleLabel(s.ownerRole)}</span>}
              </li>
            ))}
          </ol>
        )}
        {sop.progress.length ? (
          <div data-testid="host-sop-progress" style={{ marginTop: 10 }}>
            <strong className="small">我的檔期進行到哪</strong>
            <ul className="list-plain">
              {sop.progress.map((p) => (
                <li key={p.campaignId} data-testid={`sop-progress-${p.campaignId}`}>
                  <Link href={`/campaigns/${p.campaignId}`}>{p.title}</Link>
                  <span className="small muted"> ・已完成 {p.done}/{p.total} 步</span>
                  <div className="small">{p.current ? <>目前：{p.current.name}（{ownerRoleLabel(p.current.ownerRole)}負責{p.current.plannedEnd ? `，預定 ${p.current.plannedEnd}` : ''}）</> : '這個檔期的 SOP 步驟都已完成'}</div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>

      <Card title={`接下來兩週的進程（${upcoming.from.slice(5)} ～ ${upcoming.to.slice(5)}）`} testid="host-next14">
        {upcoming.overdue.length ? (
          <div data-testid="host-next14-overdue" style={{ marginBottom: 8 }}>
            <Badge tone="danger">已逾期，請盡快處理</Badge>
            <ul className="list-plain">
              {upcoming.overdue.map((o, idx) => (
                <li key={`${o.campaignId}${o.name}${idx}`}>{o.name}・<Link href={`/campaigns/${o.campaignId}`}>{o.campaignTitle}</Link> <span className="small muted">預定 {o.plannedEnd}</span></li>
              ))}
            </ul>
          </div>
        ) : null}
        {byDate.size === 0 ? <EmptyState title="接下來兩週沒有排定的事項" hint="有新的開團、曝光或作業排進來時，會顯示在這裡。" /> : (
          <div data-testid="host-next14-list">
            {[...byDate.entries()].map(([date, items]) => (
              <div key={date} data-testid={`next14-${date}`} style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                <strong className="small">{relDay(date, upcoming.from)}</strong>
                <div>{items.map((i, idx) => (
                  <div key={idx} style={i.mine ? undefined : { opacity: 0.85 }}>
                    <Badge tone={KIND_TONE[i.kind]}>{KIND_LABEL[i.kind]}</Badge>{' '}
                    {i.kind === 'PLACEMENT' ? (PLACEMENT_TYPE[i.label] ?? i.label) : i.label}{i.kind === 'TASK' ? (i.mine ? <> <Badge tone="primary">我負責</Badge></> : <span className="muted small">（{ownerRoleLabel(i.ownerRole ?? '')}負責）</span>) : null}
                    {i.kind === 'TASK' && i.status && i.status !== 'TODO' ? <> <StatusBadge map={TASK_STATUS} value={i.status} /></> : null}
                    {' ・'}<Link href={`/campaigns/${i.campaignId}`}>{i.campaignTitle}</Link>{i.communityName ? <span className="muted small"> ・{i.communityName}</span> : null}
                  </div>
                ))}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
