'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { callApi } from '../api';
import { useToast } from '../Toast';
import { COMPLIANCE, SEL_DIM } from '../labels';
import type { EvidenceV } from './EvidenceBox';

const KEYS = ['need', 'quality', 'profit', 'supply', 'content', 'repeat'];
interface Stored { score: number | null; reason: string | null; evidenceIds: string[] }

/**
 * 選品評估草稿編輯：六項 1–5 分（每項要有理由；不評＝未知，不會當 0 分）＋獨立的安全合規查核。
 * 品質與供應兩項需附有效證據，才可能得到「建議進入商務審查」。分數只是建議，不會核准商品或 G1。
 */
export function EvaluationEditor({ evalId, version, scores, compliance, evidence, weights }: {
  evalId: string; version: number; scores: Record<string, Stored>; compliance: { status?: string; note?: string | null }; evidence: EvidenceV[]; weights: Record<string, number>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [rows, setRows] = useState<Record<string, { score: string; reason: string; evidenceIds: string[] }>>(
    Object.fromEntries(KEYS.map((k) => [k, { score: scores?.[k]?.score != null ? String(scores[k].score) : '', reason: scores?.[k]?.reason ?? '', evidenceIds: scores?.[k]?.evidenceIds ?? [] }])));
  const [cs, setCs] = useState(compliance?.status ?? 'UNKNOWN');
  const [note, setNote] = useState(compliance?.note ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const upd = (k: string, patch: Partial<(typeof rows)[string]>) => setRows({ ...rows, [k]: { ...rows[k], ...patch } });

  async function save(then?: 'submit') {
    if (busy) return;
    setBusy(true); setErr(null);
    const body = {
      version,
      scores: Object.fromEntries(KEYS.map((k) => [k, { score: rows[k].score === '' ? null : Number(rows[k].score), reason: rows[k].reason || null, evidenceIds: rows[k].evidenceIds }])),
      compliance: { status: cs, note: note || null },
    };
    const r = await callApi(`/api/evaluations/${evalId}`, 'PATCH', body);
    if (!r.ok) { setBusy(false); setErr(r.error?.message ?? '儲存失敗'); return; }
    if (then === 'submit') {
      const s = await callApi<{ totalScore: number | null; recommendation: string }>(`/api/evaluations/${evalId}/submit`, 'POST');
      setBusy(false);
      if (!s.ok) { setErr(s.error?.message ?? '送出失敗'); router.refresh(); return; }
      toast('ok', '評估已送出'); router.refresh(); return;
    }
    setBusy(false);
    toast('ok', '草稿已儲存'); router.refresh();
  }

  return (
    <div data-testid="evaluation-editor">
      {err ? <div className="banner error" role="alert" data-testid="form-error">{err}</div> : null}
      <div className="table-wrap">
        <table>
          <thead><tr><th>項目（權重）</th><th>分數（1–5）</th><th>理由（必填）</th><th>引用的證據</th></tr></thead>
          <tbody>
            {KEYS.map((k) => (
              <tr key={k} data-testid={`eval-row-${k}`}>
                <td><strong>{SEL_DIM[k]}</strong><div className="small muted">權重 {weights[k]}%{k === 'quality' || k === 'supply' ? '・需附證據' : ''}</div></td>
                <td><select value={rows[k].score} onChange={(e) => upd(k, { score: e.target.value })} data-testid={`eval-score-${k}`}>
                  <option value="">未評（未知）</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select></td>
                <td><input value={rows[k].reason} onChange={(e) => upd(k, { reason: e.target.value })} maxLength={500} style={{ width: '100%' }} data-testid={`eval-reason-${k}`} /></td>
                <td>{evidence.length === 0 ? <span className="small muted">先在下方新增證據連結</span> : evidence.map((e) => (
                  <label key={e.id} style={{ display: 'block', fontSize: 12 }}>
                    <input type="checkbox" checked={rows[k].evidenceIds.includes(e.id)} onChange={(ev) => upd(k, { evidenceIds: ev.target.checked ? [...rows[k].evidenceIds, e.id] : rows[k].evidenceIds.filter((x) => x !== e.id) })} data-testid={`eval-ev-${k}-${e.id}`} /> {e.title ?? e.id}
                  </label>))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="form-grid" style={{ marginTop: 12 }}>
        <label className="field"><span className="lbl">安全與合規查核（獨立必要查核，不併入總分）</span>
          <select value={cs} onChange={(e) => setCs(e.target.value)} data-testid="eval-compliance">
            {Object.entries(COMPLIANCE).map(([v, l]) => <option key={v} value={v}>{l.label}</option>)}</select></label>
        <label className="field"><span className="lbl">合規說明（未通過或需法務審查時必填）</span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} data-testid="eval-compliance-note" /></label>
      </div>
      <p className="small muted">食品、保健食品、醫材、化妝品、兒童用品等受規範品類：系統只標示「需法務或合規審查」，不判斷是否合法。</p>
      <div className="btn-row">
        <button type="button" className="btn" disabled={busy} onClick={() => save()} data-testid="btn-eval-save">儲存草稿</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => save('submit')} data-testid="btn-eval-submit">儲存並送出</button>
      </div>
    </div>
  );
}
