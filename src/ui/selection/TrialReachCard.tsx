import { Badge, Card } from '../components';
import { ApiForm } from '../ApiForm';
import { ActionButton } from '../ActionButton';
import { Modal } from '../Modal';
import { fmtDateTime } from '../format';
import {
  ALLOWED_SOURCES, CREDIBILITY_LABEL, DEDUPE_LABEL, REACH_METRICS, REACH_METRIC_HELP, REACH_METRIC_LABEL, REACH_RULES_VERSION, REACH_SOURCE_LABEL, VERIFICATION_LABEL, DEDUPE_METHODS, type ReachRecord, type ReachMetric, type ReachSourceKind,
} from '@/server/lib/trial-reach';

/**
 * 觸及與導購資料（人工填寫，Owner 決策 K-2）：潛在觸及人數、實際觸及人數、有效導購訪客三種資料各自獨立。
 * 每筆記錄來源、統計期間、填寫人、填寫日期與資料可信度；建立後不可改，要更正就「刪除」後重填（保留紀錄與原因）。
 * 只有「有效導購訪客」會用來算導購轉換率（CVR）；群組人數只用來另外顯示「群組成員訂單比」。
 */
export interface ReachEventV { id: number; recordId: string; label: string; actorName: string | null; actorRole: string | null; occurredAt: string; detail: string | null }
export function TrialReachCard({ trialId, records, canWrite, canVerify, userId, history = [], candidates = {} }: { trialId: string; records: ReachRecord[]; canWrite: boolean; canVerify: boolean; userId: string; history?: ReachEventV[]; candidates?: Record<string, { id: string; name: string; role: string }[]> }) {
  const replaced = new Set(records.filter((r) => r.resubmitsId && !r.deleted).map((r) => r.resubmitsId as string));
  const rejectedOpen = records.filter((r) => r.verificationStatus === 'REJECTED' && !r.deleted && !replaced.has(r.id));
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
          { name: 'evidenceRef', label: '來源佐證或可查核的來源識別（有效導購訪客：可信度高／中必填；報表編號、後台連結、檔名…；不要寫電話或 Email）', type: 'text' },
          { name: 'dedupeMethod', label: '訪客如何去重（只用於「有效導購訪客」，該種資料必填；沒有去重或不知道也要如實選；其他種類請留空）', type: 'select', defaultValue: null, options: DEDUPE_METHODS.map((value) => ({ value, label: DEDUPE_LABEL[value] })), help: '來源不能證明「不重複」時，導購轉換率維持「資料不足」' },
          { name: 'dedupeNote', label: '人工去重的方法說明（選「人工去重」時必填）', type: 'text' },
          ...(rejectedOpen.length ? [{ name: 'resubmitsId', label: '補件自（被查核退回的紀錄；一筆只能補件一次；選填）', type: 'select' as const, defaultValue: null, options: rejectedOpen.map((r) => ({ value: r.id, label: `${r.id}（${REACH_METRIC_LABEL[r.metric]} ${r.value} 人，退回原因：${r.verifyNote ?? ''}）` })), help: '補件＝重新填寫一筆新的資料並保留與被退回紀錄的關聯；種類必須相同' }] : []),
          { name: 'note', label: '備註（選填）', type: 'textarea' }]} />
      </Modal>) : undefined}>
      <p className="small muted" data-testid="reach-rules">有效導購訪客要能當導購轉換率的分母，必須：可信度不是低、有來源佐證、去重方式能證明不重複、並經<strong>另一位有權限的人查核</strong>（填寫者自選「高」或「中」不算已驗證）。規則版本：{REACH_RULES_VERSION}。</p>
      <p className="small muted">三種資料各自獨立：<strong>潛在觸及</strong>（例如 LINE 群組成員數）不是實際看到訊息的人；<strong>實際觸及</strong>是平台提供的貼文觸及；只有有可信來源的<strong>有效導購訪客</strong>可以當導購轉換率的分母。沒有可靠的導購訪客數時，轉換率維持「資料不足」。</p>
      {active.length === 0 ? <p className="muted" data-testid="reach-empty">尚未填寫。</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>資料</th><th>人數</th><th>來源</th><th>統計期間</th><th>填寫人／日期</th><th>可信度與查核</th>{canWrite || canVerify ? <th /> : null}</tr></thead>
          <tbody>{active.map((r) => (
            <tr key={r.id} data-testid={`reach-${r.id}`}>
              <td><strong>{REACH_METRIC_LABEL[r.metric as ReachMetric]}</strong></td>
              <td><strong>{r.value}</strong></td>
              <td className="small">{REACH_SOURCE_LABEL[r.sourceKind]}<div className="muted">{r.sourceText}</div>{r.note ? <div className="muted">備註：{r.note}</div> : null}
                {r.evidenceRef ? <div className="muted">佐證：{r.evidenceRef}</div> : null}
                {r.metric === 'QUALIFIED_VISITORS' ? <div className="muted">去重：{r.dedupeMethod ? DEDUPE_LABEL[r.dedupeMethod] : '未記錄'}{r.dedupeNote ? `（${r.dedupeNote}）` : ''}</div> : null}</td>
              <td className="small">{r.periodStart} ～ {r.periodEnd}</td>
              <td className="small">{r.createdByName ?? r.createdBy}<div className="muted">{r.filledOn}</div></td>
              <td><Badge tone={r.credibility === 'LOW' ? 'warn' : 'info'}>{CREDIBILITY_LABEL[r.credibility].split('（')[0]}</Badge>
                {r.metric === 'QUALIFIED_VISITORS' ? <div className="small" data-testid={`reach-verify-status-${r.id}`}><Badge tone={r.verificationStatus === 'VERIFIED' ? 'ok' : r.verificationStatus === 'REJECTED' ? 'danger' : 'warn'}>{VERIFICATION_LABEL[r.verificationStatus]}</Badge>
                  {r.verifiedBy ? <div className="muted">{r.verifiedByName ?? r.verifiedBy}・{fmtDateTime(r.verifiedAt)}・{r.verifyNote}</div> : null}
                  <div className="muted">規則 {r.rulesVersion}</div></div> : null}</td>
              {canWrite || canVerify ? <td>
                {canVerify && r.metric === 'QUALIFIED_VISITORS' && r.verificationStatus === 'UNVERIFIED' ? (
                  <div className="small" data-testid={`reach-assign-${r.id}`}>
                    {r.assignedVerifierId ? <div>待 <strong>{r.assignedVerifierName ?? r.assignedVerifierId}</strong> 查核（{r.assignmentNote ?? '已指派'}）</div> : <div className="unknown">尚未指派查核者（待查核）</div>}
                    {(candidates[r.id] ?? []).length === 0 ? <div className="muted" data-testid={`reach-no-verifier-${r.id}`}>目前沒有其他具查核權限的人員：資料維持「待查核」，導購轉換率維持資料不足，<strong>不會自動通過</strong>。</div> : (
                      <Modal label={r.assignedVerifierId ? '改派查核者' : '指派查核者'} title="指派另一位有權限的人員查核" size="btn sm" testid={`btn-reach-assign-${r.id}`}>
                        <p className="small muted">被指派者不能是填寫者，且必須具有查核權限；指派後只有被指派者可以查核。</p>
                        <ApiForm endpoint={`/api/reach-records/${r.id}/assign-verifier`} submitLabel="指派" testid={`reach-assign-form-${r.id}`} successMessage="已指派查核者" fields={[
                          { name: 'userId', label: '查核者', type: 'select', required: true, defaultValue: r.assignedVerifierId ?? (candidates[r.id] ?? [])[0]?.id, options: (candidates[r.id] ?? []).map((c) => ({ value: c.id, label: `${c.name}（${c.role}）` })) },
                          { name: 'note', label: '指派說明（選填，不要寫電話或 Email）', type: 'text' }]} />
                      </Modal>)}
                  </div>) : null}
                {canVerify && r.metric === 'QUALIFIED_VISITORS' && r.verificationStatus === 'UNVERIFIED' && r.createdBy !== userId && (!r.assignedVerifierId || r.assignedVerifierId === userId) ? (
                  <div className="btn-row">
                    <ActionButton endpoint={`/api/reach-records/${r.id}/verify`} body={{ decision: 'VERIFIED' }} label="查核通過" small variant="primary" reasonLabel="查核說明（查了什麼、憑什麼認定來源可靠且訪客不重複）" reasonKey="note" testid={`btn-reach-verify-${r.id}`} successMessage="已標為查核通過" />
                    <ActionButton endpoint={`/api/reach-records/${r.id}/verify`} body={{ decision: 'REJECTED' }} label="退回" small variant="danger" reasonLabel="退回原因" reasonKey="note" testid={`btn-reach-reject-${r.id}`} successMessage="已退回" />
                  </div>) : canVerify && r.metric === 'QUALIFIED_VISITORS' && r.verificationStatus === 'UNVERIFIED' ? <span className="small muted">{r.createdBy === userId ? '填寫者不能查核自己的資料；需由另一位有權限的人查核' : '已指派給另一位查核者'}</span> : null}
                {canWrite ? <ActionButton endpoint={`/api/reach-records/${r.id}/void`} label="刪除" small variant="danger" reasonLabel="刪除原因（保留紀錄；要更正請刪除後重新填寫）" testid={`btn-reach-void-${r.id}`} successMessage="已刪除（保留紀錄）" /> : null}</td> : null}
            </tr>))}</tbody>
        </table></div>)}
      {history.length ? (
        <details data-testid="reach-history"><summary className="small">完整紀錄：填寫、指派、查核、退回、補件（{history.length}）</summary>
          <ul className="small muted">{history.map((e) => <li key={e.id}>{fmtDateTime(e.occurredAt)}・{e.recordId}・<strong>{e.label}</strong>・{e.actorName ?? '—'}（{e.actorRole ?? '—'}）{e.detail ? `・${e.detail}` : ''}</li>)}</ul></details>) : null}
      {removed.length ? (
        <details><summary className="small" data-testid="reach-removed-summary">已刪除的紀錄（{removed.length}，只保留不計入）</summary>
          <ul className="small muted">{removed.map((r) => <li key={r.id}>{REACH_METRIC_LABEL[r.metric as ReachMetric]} {r.value} 人（{r.periodStart}～{r.periodEnd}）・刪除原因：{r.deleteReason}・{fmtDateTime(r.deletedAt)}</li>)}</ul></details>) : null}
    </Card>
  );
}
