'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { callApi } from '../api';
import { useToast } from '../Toast';
import { SEL_DIM } from '../labels';

interface Cfg {
  version: number; approved: boolean;
  weights: Record<string, number>;
  thresholds: { proceed: number; supplement: number; minCompleteness: number; highConfidence: number; mediumConfidence: number };
  ddValidDays: number; trialValidDays: number; expiringSoonDays: number; evidenceHosts: string[];
}
const KEYS = ['need', 'quality', 'profit', 'supply', 'content', 'repeat'];

/** 選品評分設定：權重合計必須 100；儲存即新版本，舊評估保留當時的設定快照 */
export function SelectionConfigForm({ cfg }: { cfg: Cfg }) {
  const router = useRouter();
  const toast = useToast();
  const [w, setW] = useState({ ...cfg.weights });
  const [t, setT] = useState({ ...cfg.thresholds });
  const [dd, setDd] = useState(cfg.ddValidDays);
  const [tr, setTr] = useState(cfg.trialValidDays);
  const [soon, setSoon] = useState(cfg.expiringSoonDays);
  const [hosts, setHosts] = useState(cfg.evidenceHosts.join('\n'));
  const [approved, setApproved] = useState(cfg.approved);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sum = KEYS.reduce((a, k) => a + (Number(w[k]) || 0), 0);
  const num = (v: string) => (v === '' ? 0 : Number(v));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    const r = await callApi('/api/selection/config', 'PUT', {
      weights: w, thresholds: t, ddValidDays: dd, trialValidDays: tr, expiringSoonDays: soon, approved, version: cfg.version,
      evidenceHosts: hosts.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean),
    });
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? '儲存失敗'); return; }
    toast('ok', '選品設定已儲存（新版本）');
    router.refresh();
  }
  return (
    <form onSubmit={save} data-testid="selection-config-form">
      {err ? <div className="banner error" role="alert" data-testid="form-error">{err}</div> : null}
      <div className="form-grid">
        {KEYS.map((k) => (
          <label key={k} className="field"><span className="lbl">{SEL_DIM[k]}權重（%）</span>
            <input type="number" min={0} max={100} step={1} value={w[k]} onChange={(e) => setW({ ...w, [k]: num(e.target.value) })} data-testid={`sel-w-${k}`} /></label>
        ))}
        <div className="field"><span className="lbl">合計</span><strong data-testid="sel-sum" style={{ color: sum === 100 ? 'var(--ok)' : 'var(--danger)' }}>{sum}%{sum === 100 ? '' : '（必須是 100）'}</strong></div>
        <label className="field"><span className="lbl">「建議進入商務審查」門檻（總分）</span><input type="number" min={0} max={100} value={t.proceed} onChange={(e) => setT({ ...t, proceed: num(e.target.value) })} data-testid="sel-t-proceed" /></label>
        <label className="field"><span className="lbl">「補測／補件」門檻（總分）</span><input type="number" min={0} max={100} value={t.supplement} onChange={(e) => setT({ ...t, supplement: num(e.target.value) })} data-testid="sel-t-supplement" /></label>
        <label className="field"><span className="lbl">最低資料完整度（低於此值＝資料不足）</span><input type="number" min={0.05} max={1} step={0.05} value={t.minCompleteness} onChange={(e) => setT({ ...t, minCompleteness: num(e.target.value) })} /></label>
        <label className="field"><span className="lbl">合作資格審查核准後的有效天數</span><input type="number" min={1} max={3650} value={dd} onChange={(e) => setDd(num(e.target.value))} data-testid="sel-dd-days" /></label>
        <label className="field"><span className="lbl">商品資格試用結論的有效天數</span><input type="number" min={1} max={3650} value={tr} onChange={(e) => setTr(num(e.target.value))} data-testid="sel-trial-days" /></label>
        <label className="field"><span className="lbl">證據「即將到期」提醒天數</span><input type="number" min={1} max={3650} value={soon} onChange={(e) => setSoon(num(e.target.value))} /></label>
        <label className="field" style={{ gridColumn: '1 / -1' }}><span className="lbl">證據連結網域白名單（每行一個；空白＝不限制）</span>
          <textarea value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="drive.company.example" data-testid="sel-hosts" /></label>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} data-testid="sel-approved" /> Owner 已確認採用此設定（未勾選＝建議值，待確認）
      </label>
      <div className="btn-row"><button type="submit" className="btn primary" disabled={busy || sum !== 100} data-testid="sel-submit">{busy ? '處理中…' : '儲存新版本'}</button></div>
    </form>
  );
}
