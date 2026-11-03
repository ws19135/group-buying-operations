import { Badge, StatusBadge } from '../components';
import { CONFIDENCE, SEL_DIM, SEL_REC } from '../labels';

/** 設定目錄裡給畫面用的子條件定義（getV2Config().conditions） */
export interface CondDefV {
  id: string; dim: string; label: string; desc: string; kind: 'BOOL' | 'NUMBER' | 'BAND' | 'ENUM'; source: 'AUTO' | 'MANUAL' | 'EITHER'; evidence: 'NONE' | 'RECOMMENDED' | 'REQUIRED';
  weight: number; hard: boolean; sensitive: boolean; naRule: string | null; unit: string | null; options: Record<string, { label: string; score: number }> | null; basis: string;
}
export interface CondResultV {
  id: string; dim: string; status: 'KNOWN' | 'UNKNOWN' | 'NA'; value: boolean | number | string | null; score: number | null; weight: number; origin: 'AUTO' | 'MANUAL' | null;
  reason: string | null; evidenceOk: boolean | null; masked?: boolean; auto?: { sourceLabel?: string; sourceRefs?: string[]; asOf?: string; sampleSize?: number | null };
}
export interface DimResultV { dim: string; weight: number; score: number | null; completeness: number; naShare: number; unknownIds: string[] }
export interface V2ResultV {
  totalScore: number | null; completeness: number; evidenceCompleteness: number; confidence: string; recommendation: string; dimensions: DimResultV[]; conditions: CondResultV[];
  evidenceGaps: string[]; hardFails: string[]; hardUnknowns: string[]; naExcessiveDims: string[]; problems: string[]; reasons: string[];
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
export function formatValue(c: CondDefV, r: CondResultV): string {
  if (r.masked) return '（成本相關，僅限有權限者查看）';
  if (r.status === 'NA') return '不適用';
  if (r.value == null) return '—';
  if (c.kind === 'BOOL') return r.value ? '是' : '否';
  if (c.kind === 'ENUM') return c.options?.[String(r.value)]?.label ?? String(r.value);
  return `${r.value}${c.unit ?? ''}`;
}

/**
 * 選品評估 V2 的結果呈現（草稿即時預覽與已送出快照共用）：總分、資料完整度、證據完整度、可信度、硬性檢查，
 * 以及六個維度下每個子條件的值、分數、資料來源與缺資料原因。沒有成本權限者，敏感子條件只顯示狀態。
 */
export function V2ResultView({ result, catalog, live }: { result: V2ResultV; catalog: CondDefV[]; live?: boolean }) {
  const def = (id: string) => catalog.find((c) => c.id === id);
  const label = (id: string) => def(id)?.label ?? id;
  const dims = ['need', 'quality', 'profit', 'supply', 'content', 'repeat'];
  return (
    <div data-testid="v2-result">
      <div className="v2-summary" data-testid="v2-summary">
        <div><span className="score-big" data-testid="v2-total">{result.totalScore ?? '—'}</span><span className="small muted"> 分{live ? '（即時預覽）' : ''}</span></div>
        <div><StatusBadge map={SEL_REC} value={result.recommendation} testid="v2-rec" /> <StatusBadge map={CONFIDENCE} value={result.confidence} /></div>
        <div className="small" data-testid="v2-completeness">資料完整度 <strong>{pct(result.completeness)}</strong>・證據完整度 <strong>{pct(result.evidenceCompleteness)}</strong></div>
      </div>
      {result.hardFails.length ? <div className="banner error" data-testid="v2-hard-fail">硬性條件未通過（阻擋）：{result.hardFails.map(label).join('、')}</div> : null}
      {result.hardUnknowns.length ? <div className="banner warn" data-testid="v2-hard-unknown">硬性條件尚未確認（最多只能補件）：{result.hardUnknowns.map(label).join('、')}</div> : null}
      {result.evidenceGaps.length ? <div className="banner warn" data-testid="v2-evidence-gaps">缺有效證據：{result.evidenceGaps.map(label).join('、')}</div> : null}
      {result.naExcessiveDims.length ? <div className="banner warn">不適用占比過高，需主管覆核：{result.naExcessiveDims.map((d) => SEL_DIM[d]).join('、')}</div> : null}
      {result.problems.length ? <div className="banner error" role="alert" data-testid="v2-problems">{result.problems.join('；')}</div> : null}
      <ul className="small muted" style={{ margin: '4px 0 8px', paddingLeft: 18 }}>{result.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      {dims.map((d) => {
        const dr = result.dimensions.find((x) => x.dim === d);
        const rows = result.conditions.filter((c) => c.dim === d);
        return (
          <section key={d} className="v2-dim" data-testid={`v2-dim-${d}`}>
            <h4>{SEL_DIM[d]} <span className="small muted">權重 {dr?.weight}%・維度分 {dr?.score ?? '—'}・完整度 {dr ? pct(dr.completeness) : '—'}</span></h4>
            <div className="table-wrap"><table>
              <thead><tr><th>子條件</th><th>狀態</th><th>值</th><th>分數</th><th>資料來源／原因</th><th>證據</th></tr></thead>
              <tbody>{rows.map((r) => {
                const c = def(r.id);
                if (!c) return null;
                return (
                  <tr key={r.id} data-testid={`v2-cond-${r.id}`}>
                    <td title={c.desc}><strong>{c.label}</strong> {c.hard ? <Badge tone="danger">硬性</Badge> : null}<div className="small muted">{c.desc}</div></td>
                    <td>{r.status === 'KNOWN' ? <Badge tone="ok">已知</Badge> : r.status === 'NA' ? <Badge tone="neutral">不適用</Badge> : <Badge tone="warn">未知</Badge>}{' '}
                      <span className="small muted">{r.origin === 'AUTO' ? '系統' : r.origin === 'MANUAL' ? '人工' : c.source === 'AUTO' ? '系統' : ''}</span></td>
                    <td data-testid={`v2-value-${r.id}`}>{formatValue(c, r)}</td>
                    <td>{r.score == null ? '—' : Math.round(r.score * 100)}</td>
                    <td className="small">{r.status === 'KNOWN' ? (r.masked ? '—' : r.auto?.sourceLabel ? `${r.auto.sourceLabel}${r.auto.sampleSize ? `（樣本 ${r.auto.sampleSize}）` : ''}${r.auto.sourceRefs?.length ? `・${r.auto.sourceRefs.slice(0, 2).join('、')}` : ''}` : '人工填寫') : <span className="unknown">{r.reason ?? '—'}</span>}
                      {r.status === 'NA' && r.reason ? <span>：{r.reason}</span> : null}</td>
                    <td className="small">{c.evidence === 'NONE' ? '—' : r.evidenceOk == null ? (c.evidence === 'REQUIRED' ? '必要' : '建議') : r.evidenceOk ? '已附' : <span className="unknown">缺</span>}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          </section>
        );
      })}
    </div>
  );
}
