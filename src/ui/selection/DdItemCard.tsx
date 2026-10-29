'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { callApi } from '../api';
import { useToast } from '../Toast';
import { ActionButton } from '../ActionButton';
import { Badge, Kv, StatusBadge } from '../components';
import { DD_STATUS, LEGAL_STATUS, PARTY } from '../labels';
import { EvidenceBox, type EvidenceV } from './EvidenceBox';
import type { UiField } from '@/server/lib/dd-catalog';

export interface DdItemV {
  id: string; categoryKey: string; no: number; label: string; question: string; evidenceRequired: boolean; status: string; responsibleParty: string; ownerUserId: string | null; ownerName: string | null;
  terms: Record<string, unknown>; restricted: boolean; note: string | null; naReason: string | null; riskNote: string | null;
  legalStatus: string; legalReason: string | null; legalNote: string | null; legalClearedByName: string | null; evidence: EvidenceV[]; version: number;
}

const val = (v: unknown) => (v == null ? '' : typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));

/** 12 類問題之一：結構化條款（責任方、期限、金額、比例）、負責人、狀態、證據與法務審查標示 */
export function DdItemCard({ item, fields, editable, canWrite, canReview, canSensitive, owners }: {
  item: DdItemV; fields: UiField[]; editable: boolean; canWrite: boolean; canReview: boolean; canSensitive: boolean; owners: { value: string; label: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const sensitiveLocked = item.restricted && !canSensitive;
  const [terms, setTerms] = useState<Record<string, string>>(Object.fromEntries(fields.map((f) => [f.name, val(item.terms[f.name])])));
  const [status, setStatus] = useState(item.status);
  const [party, setParty] = useState(item.responsibleParty);
  const [owner, setOwner] = useState(item.ownerUserId ?? '');
  const [note, setNote] = useState(item.note ?? '');
  const [na, setNa] = useState(item.naReason ?? '');
  const [risk, setRisk] = useState(item.riskNote ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    const body: Record<string, unknown> = { version: item.version, responsibleParty: party, ownerUserId: owner || null };
    if (!sensitiveLocked) {
      const t: Record<string, unknown> = {};
      for (const f of fields) {
        const raw = terms[f.name];
        if (raw === '' || raw == null) continue;
        t[f.name] = f.type === 'number' ? Number(raw) : f.type === 'bool' ? raw === 'true' : raw;
      }
      Object.assign(body, { terms: t, status, note: note || null, naReason: status === 'NOT_APPLICABLE' ? na : null, riskNote: status === 'AT_RISK' ? risk : null });
    }
    const r = await callApi(`/api/diligence-items/${item.id}`, 'PATCH', body);
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? '儲存失敗'); return; }
    toast('ok', `「${item.label}」已儲存`); router.refresh();
  }

  return (
    <details className="card" style={{ padding: 12, marginBottom: 8 }} data-testid={`dd-item-${item.categoryKey}`} open={item.status === 'AT_RISK' || item.legalStatus === 'REQUIRED' || item.legalStatus === 'BLOCKED'}>
      <summary style={{ cursor: 'pointer' }}>
        <strong>{item.no}. {item.label}</strong>{' '}
        <StatusBadge map={DD_STATUS} value={item.status} testid={`dd-status-${item.categoryKey}`} />{' '}
        {item.legalStatus !== 'NOT_REQUIRED' ? <StatusBadge map={LEGAL_STATUS} value={item.legalStatus} testid={`dd-legal-${item.categoryKey}`} /> : null}{' '}
        <span className="small muted">責任方 {PARTY[item.responsibleParty]?.label ?? item.responsibleParty}・負責人 {item.ownerName ?? '未指派'}・證據 {item.evidence.length}{item.evidenceRequired ? '（必附）' : ''}</span>
      </summary>
      <p className="small muted">{item.question}</p>
      {item.legalStatus !== 'NOT_REQUIRED' ? <div className={`banner ${item.legalStatus === 'CLEARED' ? 'ok' : 'warn'}`}>
        <strong>{LEGAL_STATUS[item.legalStatus]?.label}</strong>{item.legalReason ? `：${item.legalReason}` : ''}{item.legalNote ? `（${item.legalNote}${item.legalClearedByName ? `・${item.legalClearedByName}` : ''}）` : ''}
        <div className="small">系統只管理「有沒有被審、誰審的」，不判斷是否合法。</div></div> : null}
      {sensitiveLocked ? <div className="banner nodata">分潤條款屬敏感資料，需有成本檢視權限才能查看與填寫；您可以指派負責人與責任方。</div> : null}
      {err ? <div className="banner error" role="alert" data-testid="form-error">{err}</div> : null}
      {editable && canWrite ? (
        <form onSubmit={save} data-testid={`dd-form-${item.categoryKey}`}>
          <div className="form-grid">
            {!sensitiveLocked ? <label className="field"><span className="lbl">狀態</span>
              <select value={status} onChange={(e) => setStatus(e.target.value)} data-testid={`dd-f-status-${item.categoryKey}`}>{Object.entries(DD_STATUS).map(([v, l]) => <option key={v} value={v}>{l.label}</option>)}</select></label> : null}
            <label className="field"><span className="lbl">責任方</span>
              <select value={party} onChange={(e) => setParty(e.target.value)} data-testid={`dd-f-party-${item.categoryKey}`}>{Object.entries(PARTY).map(([v, l]) => <option key={v} value={v}>{l.label}</option>)}</select></label>
            <label className="field"><span className="lbl">負責人</span>
              <select value={owner} onChange={(e) => setOwner(e.target.value)} data-testid={`dd-f-owner-${item.categoryKey}`}><option value="">（未指派）</option>{owners.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
            {!sensitiveLocked ? fields.map((f) => (
              <label key={f.name} className="field"><span className="lbl">{f.label}</span>
                {f.type === 'select' ? <select value={terms[f.name]} onChange={(e) => setTerms({ ...terms, [f.name]: e.target.value })} data-testid={`dd-t-${item.categoryKey}-${f.name}`}><option value="">（未填）</option>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                  : f.type === 'bool' ? <select value={terms[f.name]} onChange={(e) => setTerms({ ...terms, [f.name]: e.target.value })} data-testid={`dd-t-${item.categoryKey}-${f.name}`}><option value="">（未填）</option><option value="true">是</option><option value="false">否</option></select>
                  : <input type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} step={f.type === 'number' ? 'any' : undefined} value={terms[f.name]} onChange={(e) => setTerms({ ...terms, [f.name]: e.target.value })} data-testid={`dd-t-${item.categoryKey}-${f.name}`} />}
              </label>)) : null}
            {!sensitiveLocked && status === 'NOT_APPLICABLE' ? <label className="field" style={{ gridColumn: '1 / -1' }}><span className="lbl">不適用的原因（必填）</span><input value={na} onChange={(e) => setNa(e.target.value)} data-testid={`dd-f-na-${item.categoryKey}`} /></label> : null}
            {!sensitiveLocked && status === 'AT_RISK' ? <label className="field" style={{ gridColumn: '1 / -1' }}><span className="lbl">風險說明（必填）</span><input value={risk} onChange={(e) => setRisk(e.target.value)} data-testid={`dd-f-risk-${item.categoryKey}`} /></label> : null}
            {!sensitiveLocked ? <label className="field" style={{ gridColumn: '1 / -1' }}><span className="lbl">備註（請勿貼電話、Email 或合約全文）</span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></label> : null}
          </div>
          <div className="btn-row"><button type="submit" className="btn primary" disabled={busy} data-testid={`dd-save-${item.categoryKey}`}>{busy ? '處理中…' : '儲存這一項'}</button></div>
        </form>
      ) : (
        <Kv rows={[
          ...fields.map((f): [string, React.ReactNode] => [f.label, item.terms[f.name] == null ? '—' : typeof item.terms[f.name] === 'boolean' ? (item.terms[f.name] ? '是' : '否') : String(item.terms[f.name])]),
          ...(item.note ? [['備註', item.note] as [string, React.ReactNode]] : []), ...(item.naReason ? [['不適用原因', item.naReason] as [string, React.ReactNode]] : []), ...(item.riskNote ? [['風險', item.riskNote] as [string, React.ReactNode]] : []),
        ]} />
      )}
      <h4 style={{ margin: '10px 0 4px' }}>證據</h4>
      <EvidenceBox subjectType="DD_ITEM" subjectId={item.id} items={item.evidence} canEdit={canWrite && editable} testid={`dd-evidence-${item.categoryKey}`} hint={item.evidenceRequired ? '標為已確認前必附一筆有效證據' : undefined} />
      {canWrite && !sensitiveLocked ? (
        <div className="btn-row" style={{ marginTop: 8 }}>
          {item.legalStatus === 'NOT_REQUIRED' ? <ActionButton endpoint={`/api/diligence-items/${item.id}/legal`} body={{ action: 'REQUIRE' }} label="標示需法務／合規審查" small reasonLabel="需審查的範圍或原因" reasonKey="note" testid={`btn-legal-require-${item.categoryKey}`} /> : null}
          {canReview && item.legalStatus !== 'CLEARED' && item.legalStatus !== 'NOT_REQUIRED' ? <ActionButton endpoint={`/api/diligence-items/${item.id}/legal`} body={{ action: 'CLEAR' }} label="確認無虞" small variant="primary" reasonLabel="確認依據（需先附有效的法務意見證據）" reasonKey="note" testid={`btn-legal-clear-${item.categoryKey}`} /> : null}
          {canReview && item.legalStatus !== 'BLOCKED' && item.legalStatus !== 'NOT_REQUIRED' ? <ActionButton endpoint={`/api/diligence-items/${item.id}/legal`} body={{ action: 'BLOCK' }} label="法務封鎖（不得合作）" small variant="danger" reasonLabel="封鎖原因" reasonKey="note" testid={`btn-legal-block-${item.categoryKey}`} /> : null}
          {canReview && item.legalStatus !== 'NOT_REQUIRED' ? <ActionButton endpoint={`/api/diligence-items/${item.id}/legal`} body={{ action: 'RELEASE' }} label="解除標示" small reasonLabel="解除原因" reasonKey="note" testid={`btn-legal-release-${item.categoryKey}`} /> : null}
        </div>
      ) : null}
      {!editable ? <div className="small muted" style={{ marginTop: 6 }}><Badge>唯讀</Badge> 調查已送審或核准；要修改請先退回，或建立新合約版本。</div> : null}
    </details>
  );
}
