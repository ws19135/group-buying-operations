'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { callApi } from './api';
import { useToast } from './Toast';

interface Cfg {
  version: number; approved: boolean;
  weights: { need: number; category: number; price: number; history: number; supply: number };
  thresholds: { recommend: number; review: number; minCompleteness: number; highConfidence: number; mediumConfidence: number };
  minHistoryCampaigns: number; minShipments: number;
}
const DIMS: [keyof Cfg['weights'], string][] = [['need', '需求'], ['category', '品類'], ['price', '價格'], ['history', '歷史績效'], ['supply', '供應履約']];

/** 評分設定：權重合計必須 100；儲存會產生新版本，舊評估保留當時的設定快照 */
export function FitConfigForm({ cfg }: { cfg: Cfg }) {
  const router = useRouter();
  const toast = useToast();
  const [w, setW] = useState({ ...cfg.weights });
  const [t, setT] = useState({ ...cfg.thresholds });
  const [minH, setMinH] = useState(cfg.minHistoryCampaigns);
  const [minS, setMinS] = useState(cfg.minShipments);
  const [approved, setApproved] = useState(cfg.approved);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sum = DIMS.reduce((a, [k]) => a + (Number(w[k]) || 0), 0);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    const r = await callApi('/api/fit/config', 'PUT', { weights: w, thresholds: t, minHistoryCampaigns: minH, minShipments: minS, approved, version: cfg.version });
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? '儲存失敗'); return; }
    toast('ok', '評分設定已儲存（新版本）');
    router.refresh();
  }
  const num = (v: string) => (v === '' ? 0 : Number(v));
  return (
    <form onSubmit={save} data-testid="fit-config-form">
      {err ? <div className="banner error" role="alert" data-testid="form-error">{err}</div> : null}
      <div className="form-grid">
        {DIMS.map(([k, l]) => (
          <label key={k} className="field"><span className="lbl">{l}權重（%）</span>
            <input type="number" min={0} max={100} step={1} value={w[k]} onChange={(e) => setW({ ...w, [k]: num(e.target.value) })} data-testid={`cfg-w-${k}`} /></label>
        ))}
        <div className="field"><span className="lbl">合計</span><strong data-testid="cfg-sum" style={{ color: sum === 100 ? 'var(--ok)' : 'var(--danger)' }}>{sum}%{sum === 100 ? '' : '（必須是 100）'}</strong></div>
        <label className="field"><span className="lbl">「建議合作」門檻（總分）</span><input type="number" min={0} max={100} value={t.recommend} onChange={(e) => setT({ ...t, recommend: num(e.target.value) })} data-testid="cfg-t-recommend" /></label>
        <label className="field"><span className="lbl">「需人工評估」門檻（總分）</span><input type="number" min={0} max={100} value={t.review} onChange={(e) => setT({ ...t, review: num(e.target.value) })} data-testid="cfg-t-review" /></label>
        <label className="field"><span className="lbl">最低資料完整度（低於此值＝資料不足）</span><input type="number" min={0.05} max={1} step={0.05} value={t.minCompleteness} onChange={(e) => setT({ ...t, minCompleteness: num(e.target.value) })} /></label>
        <label className="field"><span className="lbl">歷史績效至少需要幾檔已結單檔期</span><input type="number" min={1} value={minH} onChange={(e) => setMinH(num(e.target.value))} /></label>
        <label className="field"><span className="lbl">供應履約至少需要幾筆出貨單</span><input type="number" min={1} value={minS} onChange={(e) => setMinS(num(e.target.value))} /></label>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} data-testid="cfg-approved" /> Owner 已確認採用此設定（未勾選＝建議值，待確認）
      </label>
      <div className="btn-row"><button type="submit" className="btn primary" disabled={busy || sum !== 100} data-testid="cfg-submit">{busy ? '處理中…' : '儲存新版本'}</button></div>
    </form>
  );
}
