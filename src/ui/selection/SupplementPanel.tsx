'use client';
import { ActionButton } from '../ActionButton';
import { ApiForm } from '../ApiForm';
import { Badge } from '../components';
import type { CondDefV } from './V2ResultView';

export interface SupplementV { id: string; conditionId: string | null; conditionLabel: string; note: string; status: string; requestedByName: string | null; requestedAt: string; resolveNote?: string | null }
const ST: Record<string, { label: string; tone: 'warn' | 'ok' | 'neutral' }> = { OPEN: { label: '待補', tone: 'warn' }, DONE: { label: '已補', tone: 'ok' }, CANCELLED: { label: '已取消', tone: 'neutral' } };

/** 主管對評估的補件要求（針對個別子條件）。要求不會改變分數；補件後由填報人標為已處理，或請主管取消。 */
export function SupplementPanel({ evalId, items, catalog, canRequest, canResolve }: { evalId: string; items: SupplementV[]; catalog: CondDefV[]; canRequest: boolean; canResolve: boolean }) {
  return (
    <div data-testid="supplement-panel">
      <h4>補件要求{items.filter((i) => i.status === 'OPEN').length ? ` （${items.filter((i) => i.status === 'OPEN').length} 項待補）` : ''}</h4>
      {items.length === 0 ? <p className="small muted">目前沒有補件要求。</p> : (
        <ul className="list-plain">{items.map((s) => (
          <li key={s.id} data-testid={`supplement-${s.id}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
            <span><Badge tone={ST[s.status]?.tone ?? 'neutral'}>{ST[s.status]?.label ?? s.status}</Badge> <strong>{s.conditionLabel}</strong>：{s.note} <span className="small muted">（{s.requestedByName ?? '主管'}）</span></span>
            {s.status === 'OPEN' && canResolve ? <ActionButton endpoint={`/api/supplement-requests/${s.id}/resolve`} body={{ status: 'DONE' }} label="標為已補" small testid={`btn-supplement-done-${s.id}`} successMessage="已標為已補" /> : null}
          </li>))}</ul>
      )}
      {canRequest ? (
        <details><summary className="small" data-testid="btn-supplement-new">＋ 提出補件要求</summary>
          <ApiForm endpoint={`/api/evaluations/${evalId}/supplements`} submitLabel="送出要求" testid="supplement-form" fields={[
            { name: 'conditionId', label: '針對哪個子條件（可不選＝整體）', type: 'select', options: [{ value: '', label: '整體' }, ...catalog.map((c) => ({ value: c.id, label: c.label }))] },
            { name: 'note', label: '要補什麼（必填）', type: 'textarea', required: true }]} />
        </details>
      ) : null}
    </div>
  );
}
