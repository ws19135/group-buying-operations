import Link from 'next/link';
import { ApiForm } from './ApiForm';
import { Modal } from './Modal';
import { Badge, StatusBadge, Table } from './components';
import { BASIS, CONFIDENCE, HARD_RESULT, RECOMMENDATION, REVIEW_DECISION } from './labels';
import { fmtDateTime, money } from './format';
import type { FitItemV } from './types';
import { DIM_LABEL, HARD_CHECK_LABEL } from '@/server/lib/segment-vocab';

/** 商品 × 團主適配評估表（商品頁、檔期頁、總覽共用）。分數旁一律標示資料完整度、信心與依據；未知維度不顯示成 0 分。 */
export function FitTable({ items, canReview, show = 'host', testid = 'fit-table' }: { items: FitItemV[]; canReview: boolean; show?: 'host' | 'product' | 'both'; testid?: string }) {
  const head = [show === 'product' ? '商品' : show === 'both' ? '團主／商品' : '候選團主', '總分／建議', '信心／完整度', '硬性檢查', '人工覆核', '理由'];
  return (
    <Table head={head} testid={testid}>
      {items.map((it) => {
        const ref = it.recommendation === 'INSUFFICIENT_DATA' || it.recommendation === 'BLOCKED';
        const outcome = it.outcome as { hostNetSales?: number; targetAttainment?: number | null; hostOrders?: number } | null;
        return (
          <tr key={it.id} data-testid={`fit-row-${it.id}`}>
            <td>
              {show !== 'product' ? <Link href={`/hosts/${it.hostId}`}><strong>{it.hostName}</strong></Link> : null}
              {show === 'both' ? <br /> : null}
              {show !== 'host' ? <Link href={`/products/${it.productId}`}>{show === 'both' ? it.productName : <strong>{it.productName}</strong>}</Link> : null}
              <div className="small muted">{it.hostId}{it.segmentCount === 0 ? ' · 尚無客群分析' : ''}</div>
            </td>
            <td>
              <div className={`score-big${ref ? ' ref' : ''}`} data-testid={`fit-score-${it.id}`}>{it.totalScore == null ? '—' : it.totalScore.toFixed(1)}</div>
              <StatusBadge map={RECOMMENDATION} value={it.recommendation} testid={`fit-rec-${it.id}`} />
              {ref && it.totalScore != null ? <div className="small muted">{it.recommendation === 'BLOCKED' ? '硬性條件未過，分數僅供參考' : '資料不足，分數僅供參考'}</div> : null}
            </td>
            <td>
              <StatusBadge map={CONFIDENCE} value={it.confidence} />
              <div className="small muted" data-testid={`fit-completeness-${it.id}`}>資料完整度 {Math.round(it.completeness * 100)}%</div>
              {it.stale ? <div><Badge tone="warn">資料已更新，建議重評</Badge></div> : null}
            </td>
            <td>{it.hardChecks.map((c) => <div key={c.key} className="small" title={c.reason}>{HARD_CHECK_LABEL[c.key] ?? c.key}：<StatusBadge map={HARD_RESULT} value={c.result} /></div>)}</td>
            <td data-testid={`fit-review-${it.id}`}>
              {it.reviewDecision ? (
                <>
                  <StatusBadge map={REVIEW_DECISION} value={it.reviewDecision} />
                  <div className="small muted">{it.reviewedByName ?? ''} {fmtDateTime(it.reviewedAt)}</div>
                  {it.reviewNote ? <div className="small">{it.reviewNote}</div> : null}
                </>
              ) : <Badge tone="neutral">待覆核</Badge>}
              {canReview ? (
                <div style={{ marginTop: 4 }}>
                  <Modal label={it.reviewDecision ? '重新覆核' : '覆核'} title={`覆核：${it.hostName} × ${it.productName}`} size="btn sm" testid={`btn-fit-review-${it.id}`}>
                    <p className="small muted">系統建議：{RECOMMENDATION[it.recommendation]?.label}（總分 {it.totalScore ?? '—'}、完整度 {Math.round(it.completeness * 100)}%）。覆核只記錄你的判斷，不會改變任何檔期狀態或核准。</p>
                    <ApiForm endpoint={`/api/fit/${it.id}/review`} submitLabel="送出覆核" testid={`fit-review-form-${it.id}`} fields={[
                      { name: 'decision', label: '覆核結果', type: 'select', required: true, defaultValue: it.reviewDecision ?? 'ACCEPTED', options: Object.entries(REVIEW_DECISION).map(([value, l]) => ({ value, label: l.label })) },
                      { name: 'note', label: '意見（不採用或需補資料時必填）', type: 'textarea', defaultValue: it.reviewNote },
                    ]} />
                  </Modal>
                </div>
              ) : null}
            </td>
            <td>
              <details className="fit-detail">
                <summary data-testid={`fit-detail-${it.id}`}>各維度與理由</summary>
                <ul className="fit-dims">
                  {it.dimensions.map((d) => (
                    <li key={d.key}><strong>{DIM_LABEL[d.key] ?? d.key}</strong>（權重 {d.weight}%）：{d.known
                      ? <>{d.score?.toFixed(1)} / 5 {d.basis ? <StatusBadge map={BASIS} value={d.basis} /> : null}</>
                      : <span className="unknown">未知，未計分</span>}
                      <div className="small muted">{d.reason}</div></li>
                  ))}
                </ul>
                <ul className="list-plain small">{it.hardChecks.filter((c) => c.result !== 'PASS').map((c) => <li key={c.key}>⚠️ {HARD_CHECK_LABEL[c.key]}：{c.reason}</li>)}</ul>
                <div className="small muted">評估於 {fmtDateTime(it.assessedAt)}{it.assessedByName ? `（${it.assessedByName}）` : ''}・評分設定 v{it.configVersion}</div>
                {outcome ? <div className="small" data-testid={`fit-outcome-${it.id}`}>結案成效：歸因淨銷售 {money(outcome.hostNetSales ?? null)}、{outcome.hostOrders ?? 0} 筆訂單{outcome.targetAttainment != null ? `、目標達成 ${(outcome.targetAttainment * 100).toFixed(0)}%` : ''}</div> : null}
              </details>
            </td>
          </tr>
        );
      })}
    </Table>
  );
}
