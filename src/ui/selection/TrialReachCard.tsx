import { Badge, Card } from '../components';
import { ApiForm } from '../ApiForm';
import { ActionButton } from '../ActionButton';
import { Modal } from '../Modal';
import { fmtDateTime } from '../format';
import {
  ALLOWED_SOURCES, CREDIBILITY_LABEL, REACH_METRICS, REACH_METRIC_HELP, REACH_METRIC_LABEL, REACH_SOURCE_LABEL, type ReachRecord, type ReachMetric, type ReachSourceKind,
} from '@/server/lib/trial-reach';

/**
 * 觸及與導購資料（人工填寫，Owner 決策 K-2）：潛在觸及人數、實際觸及人數、有效導購訪客三種資料各自獨立。
 * 每筆記錄來源、統計期間、填寫人、填寫日期與資料可信度；建立後不可改，要更正就「刪除」後重填（保留紀錄與原因）。
 * 只有「有效導購訪客」會用來算導購轉換率（CVR）；群組人數只用來另外顯示「群組成員訂單比」。
 */
export function TrialReachCard({ trialId, records, canWrite }: { trialId: string; records: ReachRecord[]; canWrite: boolean }) {
  const active = records.filter((r) => !r.deleted);
  const removed = records.filter((r) => r.deleted);
  const allSources = Array.from(new Set(REACH_METRICS.flatMap((m) => ALLOWED_SOURCES[m])));
  return (
    <Card title="觸及與導購資料（人工填寫）" testid="trial-reach" actions={canWrite ? (
      <Modal label="新增資料" title="新增觸及與導購資料" size="btn sm" testid="btn-reach-add">
        <ul className="small muted" style={{ paddingLeft: 18 }}>{REACH_METRICS.map((m) => <li key={m}><strong>{REACH_METRIC_LABEL[m]}</strong>：{REACH_METRIC_HELP[m]}</li>)}</ul>
        <ApiForm endpoint={`/api/trials/${trialId}/reach`} submitLabel="儲存" testid="reach-form" fields={[
          { name: 'metric', label: '資料種類', type: 'select', required: true, defaultValue: 'QUALIFIED_VISITORS', options: REACH_METRICS.map((value) => ({ value, label: REACH_METRIC_LABEL[value] })) },
          { name: 'value', label: '人數', type: 'number', required: true, min: 0 },
          { name: 'sourceKind', label: '來源種類', type: 'select', required: true, defaultValue: 'SHORT_LINK_UNIQUE_VISITORS', options: allSources.map((value) => ({ value, label: REACH_SOURCE_LABEL[value as ReachSourceKind] })),
            help: `潛在觸及：${ALLOWED_SOURCES.POTENTIAL_REACH.map((k) => REACH_SOURCE_LABEL[k]).join('、')}；實際觸及：${ALLOWED_SOURCES.ACTUAL_REACH.map((k) => REACH_SOURCE_LABEL[k]).join('、')}；有效導購訪客：${ALLOWED_SOURCES.QUALIFIED_VISITORS.map((k) => REACH_SOURCE_LABEL[k]).join('、')}（群組人數與貼文觸及不能當有效導購訪客）` },
          { name: 'sourceText', label: '來源說明（哪個後台、哪份報表、誰提供；不要寫電話或 Email）', type: 'text', required: true },
          { name: 'periodStart', label: '統計期間：開始', type: 'date', required: true },
          { name: 'periodEnd', label: '統計期間：結束', type: 'date', required: true },
          { name: 'credibility', label: '資料可信度', type: 'select', required: true, defaultValue: 'MEDIUM', options: Object.entries(CREDIBILITY_LABEL).map(([value, label]) => ({ value, label })), help: '可信度為「低」的有效導購訪客不會用來算導購轉換率' },
          { name: 'note', label: '備註（選填）', type: 'textarea' }]} />
      </Modal>) : undefined}>
      <p className="small muted">三種資料各自獨立：<strong>潛在觸及</strong>（例如 LINE 群組成員數）不是實際看到訊息的人；<strong>實際觸及</strong>是平台提供的貼文觸及；只有有可信來源的<strong>有效導購訪客</strong>可以當導購轉換率的分母。沒有可靠的導購訪客數時，轉換率維持「資料不足」。</p>
      {active.length === 0 ? <p className="muted" data-testid="reach-empty">尚未填寫。</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>資料</th><th>人數</th><th>來源</th><th>統計期間</th><th>填寫人／日期</th><th>可信度</th>{canWrite ? <th /> : null}</tr></thead>
          <tbody>{active.map((r) => (
            <tr key={r.id} data-testid={`reach-${r.id}`}>
              <td><strong>{REACH_METRIC_LABEL[r.metric as ReachMetric]}</strong></td>
              <td><strong>{r.value}</strong></td>
              <td className="small">{REACH_SOURCE_LABEL[r.sourceKind]}<div className="muted">{r.sourceText}</div>{r.note ? <div className="muted">備註：{r.note}</div> : null}</td>
              <td className="small">{r.periodStart} ～ {r.periodEnd}</td>
              <td className="small">{r.createdByName ?? r.createdBy}<div className="muted">{r.filledOn}</div></td>
              <td><Badge tone={r.credibility === 'LOW' ? 'warn' : 'info'}>{CREDIBILITY_LABEL[r.credibility].split('（')[0]}</Badge></td>
              {canWrite ? <td><ActionButton endpoint={`/api/reach-records/${r.id}/void`} label="刪除" small variant="danger" reasonLabel="刪除原因（保留紀錄；要更正請刪除後重新填寫）" testid={`btn-reach-void-${r.id}`} successMessage="已刪除（保留紀錄）" /></td> : null}
            </tr>))}</tbody>
        </table></div>)}
      {removed.length ? (
        <details><summary className="small" data-testid="reach-removed-summary">已刪除的紀錄（{removed.length}，只保留不計入）</summary>
          <ul className="small muted">{removed.map((r) => <li key={r.id}>{REACH_METRIC_LABEL[r.metric as ReachMetric]} {r.value} 人（{r.periodStart}～{r.periodEnd}）・刪除原因：{r.deleteReason}・{fmtDateTime(r.deletedAt)}</li>)}</ul></details>) : null}
    </Card>
  );
}
