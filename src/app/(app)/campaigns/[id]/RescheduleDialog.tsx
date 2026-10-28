'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { callApi } from '@/ui/api';
import { useToast } from '@/ui/Toast';
import { EFFECT, lab } from '@/ui/labels';

interface Props { campaignId: string; current: { openDate: string | null; closeDate: string | null; sampleReadyDate: string | null; liveTalkDate: string | null; needsSampleRecovery: boolean }; params: Record<string, number> }
interface Row { stepKey: string; name: string; status: string; locked: boolean; before: { start: string | null; end: string | null }; after: { start: string | null; end: string | null }; effect: string; issue: string | null }
interface Preview { token: string; changes: Record<string, { before: unknown; after: unknown }>; requiresReason: boolean; rows: Row[]; affectedCount: number; blockedByLock: string[]; conflicts: { type: string; severity: string; message: string }[] }

const PARAM_LABEL: Record<string, string> = { ship_days: '寄送天數', trial_days: '試用天數', feedback_days: '回饋天數', recovery_days: '回收天數', design_days: '圖文製作天數', settle_days: '結團後結算天數', invoice_days: '結算後請款天數' };

export function RescheduleDialog({ campaignId, current, params }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [changes, setChanges] = useState<Record<string, unknown> | null>(null);
  const [reason, setReason] = useState('');

  function collect(form: HTMLFormElement): Record<string, unknown> {
    const fd = new FormData(form);
    const out: Record<string, unknown> = {};
    for (const [k, cur] of [['openDate', current.openDate], ['closeDate', current.closeDate], ['sampleReadyDate', current.sampleReadyDate], ['liveTalkDate', current.liveTalkDate]] as const) {
      const v = String(fd.get(k) ?? '').trim();
      if ((v || null) !== cur) out[k] = v || null;
    }
    const rec = fd.get('needsSampleRecovery') === 'on';
    if (rec !== current.needsSampleRecovery) out.needsSampleRecovery = rec;
    const p: Record<string, number> = {};
    for (const k of Object.keys(params)) { const n = Number(fd.get(`p_${k}`)); if (Number.isInteger(n) && n !== params[k]) p[k] = n; }
    if (Object.keys(p).length) out.params = p;
    return out;
  }

  async function doPreview(form: HTMLFormElement) {
    const ch = collect(form);
    if (!Object.keys(ch).length) { setErr('沒有任何變更'); return; }
    setBusy(true); setErr(null);
    const r = await callApi<Preview>(`/api/campaigns/${campaignId}/reschedule`, 'POST', { changes: ch });
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? '預覽失敗'); return; }
    setPreview(r.data as Preview); setChanges(ch);
  }

  async function doConfirm() {
    if (!preview || !changes || busy) return;
    if (preview.requiresReason && !reason.trim()) { setErr('此狀態下調整日期需填寫原因'); return; }
    setBusy(true); setErr(null);
    const r = await callApi(`/api/campaigns/${campaignId}/reschedule`, 'POST', { confirm: true, token: preview.token, changes: { ...changes, ...(reason.trim() ? { reason: reason.trim() } : {}) } });
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? '套用失敗'); return; }
    toast('ok', '日期已調整，任務排程已更新');
    setPreview(null); setChanges(null); setReason('');
    ref.current?.close(); router.refresh();
  }

  return (
    <>
      <button type="button" className="btn" onClick={() => ref.current?.showModal()} data-testid="btn-reschedule">調整日期</button>
      <dialog ref={ref} data-testid="reschedule-dialog" style={{ width: 'min(960px, 96vw)' }}>
        <div className="dlg-head"><strong>調整檔期日期與天數（先預覽影響，再確認）</strong><button type="button" className="btn sm" onClick={() => ref.current?.close()} aria-label="關閉">✕</button></div>
        <div className="dlg-body">
          {err ? <div className="banner error" role="alert" data-testid="reschedule-error">{err}</div> : null}
          {!preview ? (
            <form onSubmit={(e) => { e.preventDefault(); doPreview(e.currentTarget); }} data-testid="reschedule-form">
              <div className="form-grid">
                <label className="field"><span className="lbl">試用品可寄出日</span><input type="date" name="sampleReadyDate" defaultValue={current.sampleReadyDate ?? ''} data-testid="rs-sampleReadyDate" /></label>
                <label className="field"><span className="lbl">開團日</span><input type="date" name="openDate" defaultValue={current.openDate ?? ''} data-testid="rs-openDate" /></label>
                <label className="field"><span className="lbl">結團日</span><input type="date" name="closeDate" defaultValue={current.closeDate ?? ''} data-testid="rs-closeDate" /></label>
                <label className="field"><span className="lbl">Live Talk 日期</span><input type="date" name="liveTalkDate" defaultValue={current.liveTalkDate ?? ''} data-testid="rs-liveTalkDate" /></label>
                <label className="field"><span style={{ display: 'flex', gap: 8 }}><input type="checkbox" name="needsSampleRecovery" defaultChecked={current.needsSampleRecovery} /><span className="lbl" style={{ margin: 0 }}>需要回收試用品</span></span></label>
              </div>
              <h3>流程天數（只影響這一檔）</h3>
              <div className="form-grid">{Object.keys(params).map((k) => <label className="field" key={k}><span className="lbl">{PARAM_LABEL[k] ?? k}</span><input type="number" min={1} max={365} name={`p_${k}`} defaultValue={params[k]} /></label>)}</div>
              <div className="btn-row"><button type="submit" className="btn primary" disabled={busy} data-testid="btn-preview">{busy ? '計算中…' : '預覽影響'}</button></div>
            </form>
          ) : (
            <div data-testid="reschedule-preview">
              <p><strong>影響 {preview.affectedCount} 項任務。</strong>以下為預覽，尚未套用。</p>
              <ul>{Object.entries(preview.changes).map(([k, v]) => <li key={k}>{k}：{String(v.before ?? '空')} → <strong>{String(v.after ?? '空')}</strong></li>)}</ul>
              {preview.conflicts.length ? <div className="banner warn" data-testid="preview-conflicts"><strong>新日期的檔期衝突提醒：</strong><ul>{preview.conflicts.map((c) => <li key={c.message}>[{c.severity}] {c.message}</li>)}</ul></div> : null}
              {preview.blockedByLock.length ? <div className="banner warn">下列任務日期已被人工鎖定，不會被更動：{preview.blockedByLock.join('、')}</div> : null}
              <div className="table-wrap"><table><thead><tr><th>任務</th><th>目前</th><th>調整後</th><th>影響</th></tr></thead><tbody>
                {preview.rows.map((r) => (
                  <tr key={r.stepKey} data-testid={`preview-row-${r.stepKey}`}><td>{r.name}{r.locked ? ' 🔒' : ''}{r.issue ? <div className="small" style={{ color: 'var(--danger)' }}>{r.issue}</div> : null}</td>
                    <td className="nowrap">{r.before.start ?? '—'} ～ {r.before.end ?? '—'}</td><td className="nowrap">{r.after.start ?? '—'} ～ {r.after.end ?? '—'}</td>
                    <td><span className={`badge tone-${lab(EFFECT, r.effect).tone}`}>{lab(EFFECT, r.effect).label}</span></td></tr>
                ))}
              </tbody></table></div>
              <label className="field" style={{ marginTop: 12 }}><span className="lbl">調整原因{preview.requiresReason ? <span className="req"> *（已排程或進行中的檔期必填，且需營運主管權限）</span> : '（選填）'}</span><textarea value={reason} onChange={(e) => setReason(e.target.value)} data-testid="rs-reason" /></label>
              <div className="btn-row"><button type="button" className="btn" onClick={() => setPreview(null)} disabled={busy}>← 回上一步修改</button><button type="button" className="btn primary" onClick={doConfirm} disabled={busy} data-testid="btn-confirm-reschedule">{busy ? '套用中…' : '確認套用'}</button></div>
            </div>
          )}
        </div>
      </dialog>
    </>
  );
}
