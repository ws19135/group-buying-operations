'use client';
import { ApiForm } from '../ApiForm';
import { ActionButton } from '../ActionButton';
import { Modal } from '../Modal';
import { Badge, StatusBadge } from '../components';
import { EVID_KIND, EVID_STATE } from '../labels';

export interface EvidenceV { id: string; kind: string; title?: string; url?: string; sourceLabel?: string | null; validUntil: string | null; note?: string | null; state: string; restricted?: boolean }

/**
 * 證據連結清單：只存連結與有效期，不存檔案本體（檔案請放公司核准的雲端空間，不要放進 GitHub）。
 * 沒有權限的角色只看到種類與有效狀態（restricted）。
 */
export function EvidenceBox({ subjectType, subjectId, items, canEdit, testid = 'evidence-box', hint }: { subjectType: string; subjectId: string; items: EvidenceV[]; canEdit: boolean; testid?: string; hint?: string }) {
  return (
    <div data-testid={testid}>
      {items.length === 0 ? <div className="small muted">尚無證據連結{hint ? `（${hint}）` : ''}</div> : (
        <ul className="list-plain">
          {items.map((e) => (
            <li key={e.id} data-testid={`evidence-${e.id}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
              <span>
                <Badge>{EVID_KIND[e.kind] ?? e.kind}</Badge>{' '}
                {e.restricted ? <span className="muted">（敏感資料，內容已隱藏）</span> : <a href={e.url} target="_blank" rel="noreferrer noopener">{e.title}</a>}{' '}
                <StatusBadge map={EVID_STATE} value={e.state} />{e.validUntil ? <span className="small muted"> 有效至 {e.validUntil}</span> : null}
                {e.sourceLabel ? <span className="small muted"> ・{e.sourceLabel}</span> : null}
                {e.note ? <div className="small muted">{e.note}</div> : null}
              </span>
              {canEdit && !e.restricted ? <ActionButton endpoint={`/api/evidence/${e.id}/remove`} label="移除" small variant="danger" confirm="確定移除這筆證據連結？（只會標記為已移除，稽核仍保留）" testid={`btn-remove-evidence-${e.id}`} /> : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <Modal label="＋ 證據連結" title="新增證據連結" size="btn sm" testid={`btn-add-evidence-${subjectId}`}>
          <p className="small muted">只存連結（http／https）與有效期。請勿貼電話、Email、帳號密碼；檔案本體請放在公司核准的雲端空間。</p>
          <ApiForm endpoint="/api/evidence" submitLabel="新增" extra={{ subjectType, subjectId }} testid={`evidence-form-${subjectId}`} fields={[
            { name: 'kind', label: '種類', type: 'select', required: true, defaultValue: 'OTHER', options: Object.entries(EVID_KIND).map(([value, label]) => ({ value, label })) },
            { name: 'title', label: '標題', required: true }, { name: 'url', label: '連結', type: 'url', required: true, placeholder: 'https://' },
            { name: 'sourceLabel', label: '來源說明' }, { name: 'validFrom', label: '有效起日', type: 'date', half: true }, { name: 'validUntil', label: '有效期限（到期日）', type: 'date', half: true },
            { name: 'note', label: '備註', type: 'textarea' }]} />
        </Modal>
      ) : null}
    </div>
  );
}
