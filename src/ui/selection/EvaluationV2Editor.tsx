'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { callApi } from '../api';
import { useToast } from '../Toast';
import { COMPLIANCE, SEL_DIM } from '../labels';
import type { EvidenceV } from './EvidenceBox';
import type { CondDefV, CondResultV } from './V2ResultView';

const COMMERCE: Record<string, string> = { AGENCY: '代營運', KOL_CPS: 'KOL／KOC', MOM_GROUP: '團媽／社群主' };
interface Entry { value: string; naReason: string; evidenceIds: string[] }
type StoredInput = Record<string, { value?: unknown; na?: boolean; naReason?: string | null; evidenceIds?: string[] }>;

/**
 * 選品評估 V2 草稿編輯：只列「需要人填」的子條件（系統自動取得的由系統帶入，不可手填）。
 * 答案：是／否／未知／不適用（需原因，且只有目錄允許的條件才能選）；要求證據的條件請勾選這份評估的有效證據。
 * 分數、完整度與建議由系統計算；分數只是建議，不會核准商品或 G1（選品核准）。
 */
export function EvaluationV2Editor({ evalId, version, input, commerceModel, compliance, evidence, catalog, results }: {
  evalId: string; version: number; input: StoredInput; commerceModel: string | null; compliance: { status?: string; note?: string | null }; evidence: EvidenceV[];
  catalog: CondDefV[]; results: CondResultV[];
}) {
  const router = useRouter();
  const toast = useToast();
  const resOf = (id: string) => results.find((r) => r.id === id);
  // 只有「人工」或「兩者皆可且系統沒有資料」的條件可以手填
  const editable = catalog.filter((c) => c.source === 'MANUAL' || (c.source === 'EITHER' && resOf(c.id)?.origin !== 'AUTO'));
  const init = (c: CondDefV): Entry => {
    const e = input?.[c.id];
    return { value: e?.na ? 'na' : e?.value == null ? '' : String(e.value), naReason: e?.naReason ?? '', evidenceIds: e?.evidenceIds ?? [] };
  };
  const [rows, setRows] = useState<Record<string, Entry>>(Object.fromEntries(editable.map((c) => [c.id, init(c)])));
  const [model, setModel] = useState(commerceModel ?? '');
  const [cs, setCs] = useState(compliance?.status ?? 'UNKNOWN');
  const [note, setNote] = useState(compliance?.note ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const upd = (id: string, patch: Partial<Entry>) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));

  const toPayload = (c: CondDefV, e: Entry) => {
    if (e.value === 'na') return { value: null, na: true, naReason: e.naReason || null, evidenceIds: e.evidenceIds };
    let v: boolean | number | string | null = null;
    if (e.value !== '') v = c.kind === 'BOOL' ? e.value === 'true' : c.kind === 'ENUM' ? e.value : Number(e.value);
    return { value: v, na: false, evidenceIds: e.evidenceIds };
  };

  async function save(then?: 'submit') {
    if (busy) return;
    setBusy(true); setErr(null);
    const body = {
      version, commerceModel: model || null,
      conditions: Object.fromEntries(editable.map((c) => [c.id, toPayload(c, rows[c.id])])),
      compliance: { status: cs, note: note || null },
    };
    const r = await callApi(`/api/evaluations/${evalId}`, 'PATCH', body);
    if (!r.ok) { setBusy(false); setErr(r.error?.message ?? '儲存失敗'); return; }
    if (then === 'submit') {
      const s = await callApi(`/api/evaluations/${evalId}/submit`, 'POST');
      setBusy(false);
      if (!s.ok) { setErr(s.error?.message ?? '送出失敗'); router.refresh(); return; }
      toast('ok', '評估已送出'); router.refresh(); return;
    }
    setBusy(false); toast('ok', '草稿已儲存'); router.refresh();
  }

  return (
    <div data-testid="evaluation-v2-editor">
      {err ? <div className="banner error" role="alert" data-testid="form-error">{err}</div> : null}
      <div className="form-grid">
        <label className="field"><span className="lbl">商業模式（決定利潤維度的判定門檻；沒選＝利潤相關條件為未知）</span>
          <select value={model} onChange={(e) => setModel(e.target.value)} data-testid="v2-model">
            <option value="">尚未選擇</option>{Object.entries(COMMERCE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="field"><span className="lbl">安全與合規查核（獨立必要查核，不併入總分）</span>
          <select value={cs} onChange={(e) => setCs(e.target.value)} data-testid="eval-compliance">{Object.entries(COMPLIANCE).map(([v, l]) => <option key={v} value={v}>{l.label}</option>)}</select></label>
        <label className="field"><span className="lbl">合規說明（未通過或需法務審查時必填）</span><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} data-testid="eval-compliance-note" /></label>
      </div>
      <h4>需要人工確認的子條件</h4>
      <p className="small muted">其他子條件由系統從適配評估、價格、可行性試算、廠商調查、試用與歷史訂單自動取得（見下方預覽）；系統沒有資料時會顯示原因，請依原因補資料。</p>
      <div className="table-wrap"><table>
        <thead><tr><th>維度</th><th>子條件</th><th>答案</th><th>引用的證據</th></tr></thead>
        <tbody>{editable.map((c) => {
          const e = rows[c.id];
          return (
            <tr key={c.id} data-testid={`v2-edit-${c.id}`}>
              <td className="small">{SEL_DIM[c.dim]}</td>
              <td title={c.desc}><strong>{c.label}</strong>{c.hard ? <span className="small"> ・硬性</span> : null}<div className="small muted">{c.desc}{c.evidence === 'REQUIRED' ? '・需附有效證據' : c.evidence === 'RECOMMENDED' ? '・建議附證據' : ''}</div></td>
              <td>
                <select value={e.value} onChange={(ev) => upd(c.id, { value: ev.target.value })} data-testid={`v2-input-${c.id}`}>
                  <option value="">未填（未知）</option>
                  {c.kind === 'BOOL' ? <><option value="true">是</option><option value="false">否</option></> : null}
                  {c.kind === 'ENUM' ? Object.entries(c.options ?? {}).map(([v, o]) => <option key={v} value={v}>{o.label}</option>) : null}
                  {c.naRule ? <option value="na">不適用</option> : null}
                </select>
                {c.kind === 'NUMBER' || c.kind === 'BAND' ? <input type="number" value={e.value === 'na' ? '' : e.value} onChange={(ev) => upd(c.id, { value: ev.target.value })} style={{ width: 90, marginLeft: 6 }} /> : null}
                {e.value === 'na' ? <input placeholder="不適用的原因（必填）" value={e.naReason} onChange={(ev) => upd(c.id, { naReason: ev.target.value })} maxLength={500} style={{ display: 'block', marginTop: 4, width: '100%' }} data-testid={`v2-na-${c.id}`} /> : null}
              </td>
              <td>{c.evidence === 'NONE' ? <span className="small muted">—</span> : evidence.length === 0 ? <span className="small muted">先在下方新增證據連結</span> : evidence.map((ev) => (
                <label key={ev.id} style={{ display: 'block', fontSize: 12 }}>
                  <input type="checkbox" checked={e.evidenceIds.includes(ev.id)} onChange={(x) => upd(c.id, { evidenceIds: x.target.checked ? [...e.evidenceIds, ev.id] : e.evidenceIds.filter((i) => i !== ev.id) })} data-testid={`v2-ev-${c.id}-${ev.id}`} /> {ev.title ?? ev.kind}
                </label>))}</td>
            </tr>
          );
        })}</tbody>
      </table></div>
      <div className="btn-row" style={{ marginTop: 10 }}>
        <button type="button" className="btn" disabled={busy} onClick={() => save()} data-testid="btn-eval-save">儲存草稿</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => save('submit')} data-testid="btn-eval-submit">儲存並送出</button>
      </div>
    </div>
  );
}
