import Link from 'next/link';
import { Card } from '@/ui/components';
import { PLACEMENT_TYPE, WEEKDAY, ownerRoleLabel } from '@/ui/labels';
import type { HostDash } from '@/ui/types';

/** 步驟的圖示與短名稱（畫面上只放圖示＋兩三個字；完整名稱、說明與負責人放在滑鼠停留的提示）。沒收錄的步驟（自訂模板）用通用圖示與原名稱。 */
const STEP_VIEW: Record<string, { icon: string; short: string }> = {
  SAMPLE_SHIP: { icon: '📦', short: '寄樣' }, TRIAL_ARRIVAL: { icon: '🧴', short: '試用' }, TRIAL_FEEDBACK: { icon: '💬', short: '回饋' },
  LAUNCH_APPROVAL: { icon: '✅', short: '審核' }, SAMPLE_RECOVERY: { icon: '↩️', short: '回收' }, CREATIVE_ASSETS: { icon: '🎨', short: '素材' },
  PRELAUNCH_CHECK: { icon: '🔎', short: '檢查' }, LAUNCH: { icon: '🚀', short: '開團' }, LIVE_TALK: { icon: '🎙️', short: 'Live Talk' },
  TOPIC_PROMO: { icon: '📣', short: '話題' }, CLOSING_REMINDER: { icon: '⏰', short: '催單' },
};
const stepView = (key: string, name: string) => STEP_VIEW[key] ?? { icon: '▫️', short: name };

const KIND = {
  OPEN: { icon: '🚀', label: '開團' }, CLOSE: { icon: '🏁', label: '結團' }, PLACEMENT: { icon: '📣', label: '曝光' }, TASK: { icon: '📝', label: '要我做' },
} as const;

const dayMs = 86_400_000;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);
/** 「今天／明天／後天／N 天後」；日期是台北時區的曆日，所以兩邊都用 UTC 午夜相減 */
export function relDay(date: string, today: string): string {
  const diff = Math.round((utc(date) - utc(today)) / dayMs);
  return diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '後天' : `${diff} 天後`;
}
const shortDate = (date: string) => `${date.slice(5).replace('-', '/')}（${WEEKDAY[new Date(utc(date)).getUTCDay()]}）`;
const shortTitle = (t: string) => t.replace(/^\[DEMO\]\s*/, '');

/**
 * 團主總覽最上面的兩個區塊：① 團購 SOP（標準作業流程）② 接下來兩週的進程。
 * 目的是「提醒」：圖示＋少量文字，只列團主要做的事與重要日期；細節留在下方的待辦與行事曆。
 * 只讀取 getHostDashboard 已算好的資料。
 */
export function HostTop({ d }: { d: Pick<HostDash, 'sop' | 'upcoming'> }) {
  const { sop, upcoming } = d;
  const byDate = new Map<string, typeof upcoming.items>();
  for (const i of upcoming.items) byDate.set(i.date, [...(byDate.get(i.date) ?? []), i]);
  const count = (k: keyof typeof KIND) => upcoming.items.filter((i) => i.kind === k).length;
  const nothing = upcoming.items.length === 0 && upcoming.overdue.length === 0;
  return (
    <div className="grid cols-2" style={{ marginBottom: 16 }} data-testid="host-top">
      <Card title="團購 SOP（標準作業流程）" testid="host-sop">
        <div className="sop-flow" data-testid="host-sop-steps">
          {sop.steps.map((s) => {
            const v = stepView(s.stepKey, s.name);
            return (
              <div key={s.stepKey} className={`sop-node${s.mine ? ' mine' : ''}`} data-testid={`sop-step-${s.stepKey}`} title={`${s.name}（${ownerRoleLabel(s.ownerRole)}負責）${s.description ? `：${s.description}` : ''}`}>
                <div className="ic" aria-hidden="true">{v.icon}</div>
                <div className="nm">{v.short}</div>
                {s.mine ? <div className="tag" data-testid={`sop-mine-${s.stepKey}`}>我來</div> : null}
              </div>
            );
          })}
        </div>
        <p className="small muted" style={{ margin: '6px 0 0' }}>有光圈、標「我來」的是需要你動作的步驟，其他由廠商或營運處理。</p>
        {sop.progress.length ? (
          <div data-testid="host-sop-progress" style={{ marginTop: 10 }}>
            {sop.progress.map((p) => {
              const cur = p.current ? stepView(p.current.stepKey, p.current.name) : null;
              const pct = p.total ? Math.round((p.done / p.total) * 100) : 100;
              return (
                <div key={p.campaignId} className="sop-prog" data-testid={`sop-progress-${p.campaignId}`}>
                  <Link href={`/campaigns/${p.campaignId}`} className="ttl">{shortTitle(p.title)}</Link>
                  <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${shortTitle(p.title)} 完成 ${p.done}/${p.total} 步`}><span style={{ width: `${pct}%` }} /></div>
                  <span className="small muted nowrap">{cur ? `${cur.icon} ${cur.short}` : '✔ 完成'}</span>
                </div>
              );
            })}
          </div>
        ) : null}
      </Card>

      <Card title={`接下來兩週的進程（${upcoming.from.slice(5)} ～ ${upcoming.to.slice(5)}）`} testid="host-next14">
        <div className="next-count" data-testid="host-next14-counts">
          {(['TASK', 'PLACEMENT', 'OPEN', 'CLOSE'] as const).map((k) => (
            <div key={k} className={`nc${count(k) ? ' on' : ''}${k === 'TASK' && count(k) ? ' hot' : ''}`} data-testid={`next14-count-${k}`}>
              <span className="ic" aria-hidden="true">{KIND[k].icon}</span><strong>{count(k)}</strong><span className="small">{KIND[k].label}</span>
            </div>
          ))}
        </div>
        {upcoming.overdue.length ? (
          <div className="next-overdue" data-testid="host-next14-overdue">
            <strong>⚠️ 已逾期 {upcoming.overdue.length} 項，請盡快處理</strong>
            <div>{upcoming.overdue.map((o, idx) => (
              <Link key={`${o.campaignId}${o.name}${idx}`} href={`/campaigns/${o.campaignId}`} className="pill" title={`${o.campaignTitle}・預定 ${o.plannedEnd}`}>{o.name}</Link>
            ))}</div>
          </div>
        ) : null}
        {nothing ? <p className="next-empty" data-testid="host-next14-empty">✨ 這兩週沒有需要你處理的事</p> : (
          <div data-testid="host-next14-list">
            {[...byDate.entries()].map(([date, items]) => (
              <div key={date} className="next-row" data-testid={`next14-${date}`}>
                <div className="dt"><strong>{shortDate(date)}</strong><span className="small muted">{relDay(date, upcoming.from)}</span></div>
                <div className="ev">{items.map((i, idx) => {
                  const text = i.kind === 'PLACEMENT' ? (PLACEMENT_TYPE[i.label] ?? i.label) : i.kind === 'TASK' ? stepView(i.stepKey ?? '', i.label).short : i.label;
                  return (
                    <Link key={idx} href={`/campaigns/${i.campaignId}`} className={`pill ${i.kind === 'TASK' ? 'hot' : ''}`} title={`${i.label}・${i.campaignTitle}${i.communityName ? `・${i.communityName}` : ''}`}>
                      <span aria-hidden="true">{KIND[i.kind].icon}</span> {text} <span className="muted small">{shortTitle(i.campaignTitle)}</span>
                    </Link>
                  );
                })}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
