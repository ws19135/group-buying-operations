import Link from 'next/link';
import { Badge, Banner, EmptyState } from '../components';
import { money } from '../format';
import { PARTNER_TYPE_LABEL } from '@/server/lib/segment-vocab';

export interface SummaryItemV { key: string; no: number; label: string; status: 'OK' | 'INSUFFICIENT' | 'RESTRICTED'; value: number | string | null; unit: string; sampleSize: number; completeness: number; lowSample: boolean; reason: string | null; trend: { previous: number; delta: number; previousTrialId: string } | null }
export interface SummaryRowV {
  trialId: string; trialStatus: string; productId: string; productName: string; category: string | null; hostId: string | null; hostName: string | null; partnerType: string | null;
  campaignId: string; campaignTitle: string; period: { from: string | null; to: string | null }; hasData: boolean; okCount: number; total: number; notices: string[]; items: SummaryItemV[];
}
export interface TrialKpiSummaryV { required: number; counted: number; total: number; ready: boolean; rows: SummaryRowV[]; note: string }
const INTENT: Record<string, string> = { WILLING: '願意', UNDECIDED: '未決定', UNWILLING: '不願意' };

function cell(k: SummaryItemV) {
  if (k.status === 'RESTRICTED') return <span className="muted">需成本權限</span>;
  if (k.status === 'INSUFFICIENT') return <span className="unknown" title={k.reason ?? undefined}>資料不足</span>;
  const v = typeof k.value === 'string' ? (INTENT[k.value] ?? k.value) : k.unit === 'TWD' ? money(k.value as number) : k.unit === '筆' ? `${k.value}` : `${k.value}${k.unit}`;
  return (
    <span>{v}
      {k.lowSample ? <span className="small muted">（樣本偏小）</span> : null}
      {k.completeness < 1 ? <span className="small muted">（完整度 {Math.round(k.completeness * 100)}%）</span> : null}
      {k.trend ? <div className="small muted">較上一檔 {k.trend.delta > 0 ? '+' : ''}{k.trend.delta}</div> : null}
    </span>);
}

/**
 * 小規模測試團 KPI 累積彙整（Owner 決策 K-1）：累積至少 N 檔後，整理各指標的實際表現、樣本數、商品類別與團主類型，提交 Owner 審查。
 * 這裡只整理與顯示；不設任何門檻、不判定是否值得放大銷售；「較上一檔」只是數值的差，不代表好壞。
 */
export function TrialKpiSummaryView({ s }: { s: TrialKpiSummaryV }) {
  return (
    <div data-testid="kpi-summary-view">
      <Banner kind={s.ready ? 'ok' : 'warn'} testid="kpi-sum-progress">
        已累積 <strong>{s.counted}</strong>／{s.required} 檔「已有有效訂單」的小規模測試團（共 {s.total} 檔）。
        {s.ready ? '已達累積檔數，可以整理提交 Owner 審查，再決定是否制定門檻。' : `還差 ${s.required - s.counted} 檔，才提交 Owner 審查。`}
      </Banner>
      <p className="small muted" data-testid="kpi-sum-note">{s.note}</p>
      {s.rows.length === 0 ? <EmptyState title="還沒有小規模測試團" hint="在商品頁建立「小規模測試團」類型的試用並關聯檔期後，這裡會彙整各檔的 KPI。" /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>測試團</th><th>商品類別</th><th>團主／類型</th>{s.rows[0].items.map((k) => <th key={k.key}>{k.label}</th>)}<th>風險提示（事實，不是判定）</th></tr></thead>
          <tbody>{s.rows.map((r) => (
            <tr key={r.trialId} data-testid={`kpi-sum-${r.trialId}`}>
              <td><Link href={`/trials/${r.trialId}`}>{r.productName}</Link><div className="small muted">{r.campaignTitle}</div>{r.hasData ? null : <Badge tone="warn">尚無有效訂單</Badge>}</td>
              <td className="small">{r.category ?? <span className="unknown">未填</span>}</td>
              <td className="small">{r.hostName ?? '—'}<div className="muted">{r.partnerType ? PARTNER_TYPE_LABEL[r.partnerType] ?? r.partnerType : <span className="unknown">類型未知</span>}</div></td>
              {r.items.map((k) => <td key={k.key} className="small" data-testid={`kpi-sum-${r.trialId}-${k.key}`}>{cell(k)}{k.sampleSize ? <div className="muted">樣本 {k.sampleSize}</div> : null}</td>)}
              <td className="small">{r.notices.length ? <ul style={{ margin: 0, paddingLeft: 14 }}>{r.notices.map((n) => <li key={n}>{n}</li>)}</ul> : '—'}</td>
            </tr>))}</tbody>
        </table></div>)}
    </div>
  );
}
