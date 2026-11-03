import { Badge, Card } from '../components';
import { ApiForm } from '../ApiForm';
import { Modal } from '../Modal';
import { money } from '../format';

export interface KpiPartV { key: string; label: string; value: number | null; unit: string; reason: string | null; sampleSize: number }
export interface KpiItemV {
  key: string; no: number; label: string; status: 'OK' | 'INSUFFICIENT' | 'RESTRICTED'; value: number | string | null; unit: string; parts?: KpiPartV[]; formula: string; source: string; periodNote: string;
  completeness: number; sampleSize: number; lowSample: boolean; reason: string | null; reference?: { label: string; value: number | null; sensitive: boolean }; facts?: string[];
}
export interface TrialKpisV {
  trialId: string; hostId: string | null; campaignId: string | null; scopeNote: string; period: { from: string | null; to: string | null }; dataAsOf: string | null;
  items: KpiItemV[]; okCount: number; total: number; insufficient: string[]; notices: string[]; hostIntentNote: string | null; thresholds: { applied: boolean; note: string };
}
const INTENT: Record<string, string> = { WILLING: '願意再次合作', UNDECIDED: '尚未決定', UNWILLING: '不願意再次合作' };

const fmt = (v: number | string | null, unit: string) => (v == null ? '資料不足' : typeof v === 'string' ? (INTENT[v] ?? v) : unit === 'TWD' ? money(v) : `${v}${unit && unit !== '筆' ? unit : ''}${unit === '筆' ? ' 筆' : ''}`);

/**
 * 小規模測試團的成效 KPI（8 項）：每項顯示數值或「資料不足」、公式、資料來源、計算期間與資料完整度。
 * 沒有可靠資料來源就是資料不足（不是 0）；不套用任何通過／不通過門檻（Owner 決策 K-1：累積至少 5 檔測試團後再審查）；
 * 導購轉換率只用「有效導購訪客」；每單貢獻利潤只用已確認的合作條款，未確認或不全就是資料不足。
 */
export function TrialKpiCard({ kpi, canWrite, hostIntent }: { kpi: TrialKpisV; canWrite: boolean; hostIntent: string | null }) {
  return (
    <Card title="成效 KPI（小規模測試團）" testid="trial-kpis" actions={canWrite && kpi.hostId ? (
      <Modal label="記錄團主再次合作意願" title="團主再次合作意願" size="btn sm" testid="btn-host-intent">
        <p className="small muted">試用結束後，由營運人員記錄這位團主是否願意再次合作（人工記錄，不是系統推算）。</p>
        <ApiForm endpoint={`/api/trials/${kpi.trialId}`} method="PATCH" submitLabel="儲存" testid="host-intent-form" fields={[
          { name: 'hostIntent', label: '再次合作意願', type: 'select', required: true, defaultValue: hostIntent ?? 'UNDECIDED', options: Object.entries(INTENT).map(([value, label]) => ({ value, label })) },
          { name: 'hostIntentNote', label: '備註（不要寫電話或 Email）', type: 'textarea' }]} />
      </Modal>) : undefined}>
      <p className="small muted" data-testid="kpi-scope">{kpi.scopeNote}。計算期間：{kpi.period.from ?? '—'} ～ {kpi.period.to ?? '—'}；資料截至 {kpi.dataAsOf ?? '尚無匯入紀錄'}。<strong>{kpi.thresholds.note}</strong>。</p>
      <p data-testid="kpi-summary"><Badge tone={kpi.okCount === kpi.total ? 'ok' : 'warn'}>{kpi.okCount}／{kpi.total} 項有資料</Badge>{kpi.insufficient.length ? <span className="small muted"> ・資料不足：{kpi.insufficient.join('、')}</span> : null}</p>
      {kpi.notices.length ? (
        <div className="banner warn" data-testid="kpi-notices"><strong>風險提示（只陳述事實與資料品質，不是通過／不通過的判定）：</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{kpi.notices.map((n) => <li key={n}>{n}</li>)}</ul></div>) : null}
      <div className="table-wrap"><table>
        <thead><tr><th>#</th><th>指標</th><th>數值</th><th>資料完整度</th><th>公式與資料來源</th></tr></thead>
        <tbody>{kpi.items.map((k) => (
          <tr key={k.key} data-testid={`kpi-${k.key}`}>
            <td>{k.no}</td>
            <td><strong>{k.label}</strong></td>
            <td data-testid={`kpi-value-${k.key}`}>
              {k.status === 'INSUFFICIENT' ? <Badge tone="warn">資料不足</Badge> : k.status === 'RESTRICTED' ? <Badge>需成本檢視權限</Badge> : <strong>{fmt(k.value, k.unit)}</strong>}
              {k.lowSample ? <span className="small muted"> ・樣本偏小</span> : null}
              {k.parts ? <div className="small">{k.parts.map((p) => <div key={p.key}>{p.label}：{p.value == null ? <span className="unknown">資料不足</span> : `${p.value}${p.unit}`}</div>)}</div> : null}
              {k.reference ? <div className="small muted">{k.reference.label}：{k.reference.value == null ? '（沒有成本權限或沒有試算）' : money(k.reference.value)}</div> : null}
              {k.facts ? <ul className="small muted" style={{ margin: '4px 0 0', paddingLeft: 16 }} data-testid={`kpi-facts-${k.key}`}>{k.facts.map((f) => <li key={f}>{f}</li>)}</ul> : null}
            </td>
            <td className="small">{Math.round(k.completeness * 100)}%{k.sampleSize ? `（樣本 ${k.sampleSize}）` : ''}</td>
            <td className="small"><div>{k.formula}</div><div className="muted">來源：{k.source}；期間：{k.periodNote}</div>{k.reason ? <div className={k.status === 'INSUFFICIENT' ? 'unknown' : 'muted'}>{k.reason}</div> : null}</td>
          </tr>))}</tbody>
      </table></div>
    </Card>
  );
}
