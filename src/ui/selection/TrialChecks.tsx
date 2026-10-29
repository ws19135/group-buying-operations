'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { callApi } from '../api';
import { useToast } from '../Toast';
import { StatusBadge } from '../components';
import { CHECK_RESULT, DEFECT, DIMENSION } from '../labels';
import { EvidenceBox, type EvidenceV } from './EvidenceBox';

export interface CheckV {
  id: string; dimension: string; itemKey: string; itemLabel: string; result: string; evidenceText: string | null; defectSeverity: string; defectNote: string | null; riskNote: string | null;
  verifiedByName: string | null; verifiedAt: string | null; version: number; restricted?: boolean; evidence: EvidenceV[];
}

function Row({ c, editable, canCost }: { c: CheckV; editable: boolean; canCost: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [result, setResult] = useState(c.result);
  const [ev, setEv] = useState(c.evidenceText ?? '');
  const [sev, setSev] = useState(c.defectSeverity);
  const [dn, setDn] = useState(c.defectNote ?? '');
  const [rn, setRn] = useState(c.riskNote ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const textLocked = c.itemKey === 'margin' && !canCost;

  async function save() {
    if (busy) return;
    setBusy(true); setErr(null);
    const body: Record<string, unknown> = { version: c.version, result, defectSeverity: sev };
    if (!textLocked) Object.assign(body, { evidenceText: ev || null, defectNote: dn || null, riskNote: rn || null });
    const r = await callApi(`/api/trial-checks/${c.id}`, 'PATCH', body);
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? '儲存失敗'); return; }
    toast('ok', `「${c.itemLabel}」已儲存`); router.refresh();
  }
  const k = c.itemKey;
  return (
    <tr data-testid={`check-row-${k}`}>
      <td><strong>{c.itemLabel}</strong>{c.verifiedByName ? <div className="small muted">{c.verifiedByName} {c.verifiedAt ? c.verifiedAt.slice(0, 10) : ''}</div> : null}</td>
      {editable ? (
        <>
          <td><select value={result} onChange={(e) => setResult(e.target.value)} data-testid={`check-result-${k}`}>{Object.entries(CHECK_RESULT).map(([v, l]) => <option key={v} value={v}>{l.label}</option>)}</select></td>
          <td>{textLocked ? <span className="small muted">（含成本資訊，需成本檢視權限）</span> : <input value={ev} onChange={(e) => setEv(e.target.value)} placeholder="客觀證據（通過時必填）" style={{ width: '100%' }} maxLength={1000} data-testid={`check-evidence-${k}`} />}</td>
          <td><select value={sev} onChange={(e) => setSev(e.target.value)} data-testid={`check-sev-${k}`}>{Object.entries(DEFECT).map(([v, l]) => <option key={v} value={v}>{l.label}</option>)}</select></td>
          <td>{textLocked ? null : <><input value={dn} onChange={(e) => setDn(e.target.value)} placeholder="缺陷說明" style={{ width: '100%' }} maxLength={1000} data-testid={`check-defect-${k}`} /><input value={rn} onChange={(e) => setRn(e.target.value)} placeholder="風險說明" style={{ width: '100%', marginTop: 4 }} maxLength={1000} data-testid={`check-risk-${k}`} /></>}</td>
          <td><button type="button" className="btn sm primary" disabled={busy} onClick={save} data-testid={`check-save-${k}`}>儲存</button>{err ? <div className="small" style={{ color: 'var(--danger)' }} role="alert">{err}</div> : null}</td>
        </>
      ) : (
        <>
          <td><StatusBadge map={CHECK_RESULT} value={c.result} /></td>
          <td>{c.restricted ? <span className="small muted">（敏感，已隱藏）</span> : c.evidenceText ?? '—'}</td>
          <td><StatusBadge map={DEFECT} value={c.defectSeverity} /></td>
          <td className="small">{c.restricted ? null : [c.defectNote, c.riskNote].filter(Boolean).join('／') || '—'}</td>
          <td />
        </>
      )}
    </tr>
  );
}

/** 四大面向檢核：結果、客觀證據、缺陷嚴重度與說明。「通過」必填客觀證據；任何不通過或嚴重缺陷會讓系統建議「不通過」。 */
export function TrialChecks({ checks, editable, canCost, trialId }: { checks: CheckV[]; editable: boolean; canCost: boolean; trialId: string }) {
  const dims = ['PRODUCT', 'CUSTOMER', 'CONTENT', 'BUSINESS'].filter((d) => checks.some((c) => c.dimension === d));
  return (
    <div data-testid="trial-checks">
      {dims.map((d) => (
        <div key={d} style={{ marginBottom: 14 }} data-testid={`dim-${d}`}>
          <h3 style={{ margin: '8px 0' }}>{DIMENSION[d]}</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>檢核項</th><th>結果</th><th>客觀證據</th><th>缺陷</th><th>說明</th><th /></tr></thead>
            <tbody>{checks.filter((c) => c.dimension === d).map((c) => <Row key={`${c.id}-${c.version}`} c={c} editable={editable} canCost={canCost} />)}</tbody>
          </table></div>
        </div>
      ))}
      <h3>試用整體證據連結（照片、影片、回饋截圖…）</h3>
      <p className="small muted">每個檢核項的證據連結請在下方展開；試用整體的連結在試用頁最下方。</p>
      <details><summary>各檢核項的證據連結</summary>
        {checks.map((c) => (<div key={c.id} style={{ margin: '6px 0' }}><strong className="small">{DIMENSION[c.dimension]}・{c.itemLabel}</strong>
          <EvidenceBox subjectType="TRIAL_CHECK" subjectId={c.id} items={c.evidence} canEdit={editable && !(c.itemKey === 'margin' && !canCost)} testid={`check-evidence-box-${c.itemKey}`} /></div>))}
      </details>
      <span hidden data-trial={trialId} />
    </div>
  );
}
