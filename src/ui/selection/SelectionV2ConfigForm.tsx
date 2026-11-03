'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { callApi } from '../api';
import { useToast } from '../Toast';
import { SEL_DIM } from '../labels';

interface Cfg {
  version: number; approved: boolean; enabled: boolean; dimWeights: Record<string, number>;
  condWeights: Record<string, number>; thresholds: Record<string, unknown>; modelThresholds: Record<string, unknown>;
  proceed: number; supplement: number; minCompleteness: number; mediumConfidence: number; highConfidence: number; mediumEvidence: number; highEvidence: number; naShareMax: number;
  minSample: { orders: number; buyers: number };
}
const KEYS = ['need', 'quality', 'profit', 'supply', 'content', 'repeat'];

/**
 * 選品評分 V2 設定（最小必要版本）：維度權重、建議／補件門檻、完整度與證據門檻、不適用占比上限、歷史統計最小樣本、啟用與核准旗標。
 * 子條件權重與各商業模式的利潤門檻放在「進階」（JSON，伺服器端驗證）。儲存即新版本；已送出的評估保留當時的設定快照。
 * 沒勾「已確認採用」＝提案設定，不是正式制度。
 */
export function SelectionV2ConfigForm({ cfg }: { cfg: Cfg }) {
  const router = useRouter();
  const toast = useToast();
  const [w, setW] = useState({ ...cfg.dimWeights });
  const [n, setN] = useState({ proceed: cfg.proceed, supplement: cfg.supplement, minCompleteness: cfg.minCompleteness, mediumConfidence: cfg.mediumConfidence, highConfidence: cfg.highConfidence, mediumEvidence: cfg.mediumEvidence, highEvidence: cfg.highEvidence, naShareMax: cfg.naShareMax });
  const [ms, setMs] = useState({ ...cfg.minSample });
  const [enabled, setEnabled] = useState(cfg.enabled);
  const [approved, setApproved] = useState(cfg.approved);
  const [adv, setAdv] = useState(JSON.stringify({ condWeights: cfg.condWeights, thresholds: cfg.thresholds, modelThresholds: cfg.modelThresholds }, null, 2));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sum = KEYS.reduce((a, k) => a + (Number(w[k]) || 0), 0);
  const num = (v: string) => (v === '' ? 0 : Number(v));
  const field = (k: keyof typeof n, label: string, step = 1, max = 100) => (
    <label className="field" key={k}><span className="lbl">{label}</span>
      <input type="number" min={0} max={max} step={step} value={n[k]} onChange={(e) => setN({ ...n, [k]: num(e.target.value) })} data-testid={`v2-cfg-${k}`} /></label>
  );

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    let advObj: { condWeights?: Record<string, number>; thresholds?: Record<string, unknown>; modelThresholds?: Record<string, unknown> };
    try { advObj = JSON.parse(adv || '{}'); } catch { setErr('進階設定不是有效的 JSON'); return; }
    setBusy(true); setErr(null);
    const r = await callApi('/api/selection/config-v2', 'PUT', { dimWeights: w, ...n, minSample: ms, enabled, approved, version: cfg.version, ...advObj });
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? '儲存失敗'); return; }
    toast('ok', '選品 V2 設定已儲存（新版本）');
    router.refresh();
  }
  return (
    <form onSubmit={save} data-testid="selection-v2-config-form">
      {err ? <div className="banner error" role="alert" data-testid="form-error">{err}</div> : null}
      <h4>維度權重（合計必須是 100）</h4>
      <div className="form-grid">
        {KEYS.map((k) => (
          <label key={k} className="field"><span className="lbl">{SEL_DIM[k]}（%）</span>
            <input type="number" min={0} max={100} step={1} value={w[k]} onChange={(e) => setW({ ...w, [k]: num(e.target.value) })} data-testid={`v2-cfg-w-${k}`} /></label>
        ))}
        <div className="field"><span className="lbl">合計</span><strong data-testid="v2-cfg-sum" style={{ color: sum === 100 ? 'var(--ok)' : 'var(--danger)' }}>{sum}%{sum === 100 ? '' : '（必須是 100）'}</strong></div>
      </div>
      <h4>建議門檻與可信度</h4>
      <div className="form-grid">
        {field('proceed', '「建議進入商務審查」門檻（總分）')}
        {field('supplement', '「補測／補件」門檻（總分）')}
        {field('minCompleteness', '最低資料完整度（低於＝資料不足，0～1）', 0.05, 1)}
        {field('mediumConfidence', '中信心的資料完整度門檻（0～1）', 0.05, 1)}
        {field('highConfidence', '高信心的資料完整度門檻（0～1）', 0.05, 1)}
        {field('mediumEvidence', '中信心的證據完整度門檻（0～1）', 0.05, 1)}
        {field('highEvidence', '高信心的證據完整度門檻（0～1）', 0.05, 1)}
        {field('naShareMax', '不適用占維度權重的上限（0～1，超過需主管覆核）', 0.05, 1)}
        <label className="field"><span className="lbl">歷史訂單／出貨統計的最小樣本（筆）</span><input type="number" min={1} value={ms.orders} onChange={(e) => setMs({ ...ms, orders: num(e.target.value) })} data-testid="v2-cfg-ms-orders" /></label>
        <label className="field"><span className="lbl">回購率的最小買家數（位）</span><input type="number" min={1} value={ms.buyers} onChange={(e) => setMs({ ...ms, buyers: num(e.target.value) })} data-testid="v2-cfg-ms-buyers" /></label>
      </div>
      <details style={{ margin: '8px 0' }}><summary className="small">進階：子條件權重與各商業模式的利潤門檻（JSON，儲存時由伺服器驗證）</summary>
        <textarea value={adv} onChange={(e) => setAdv(e.target.value)} rows={8} style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }} data-testid="v2-cfg-advanced" />
        <p className="small muted">例：<code>{'{"condWeights":{"NEED_FIT_SCORE":35,"NEED_FIT_REVIEWED":10},"modelThresholds":{"PROF_CONTRIB_MARGIN":{"AGENCY":{"floor":12,"target":32}}}}'}</code>。同一維度內的子條件權重合計必須是 100。</p></details>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} data-testid="v2-cfg-enabled" /> 啟用 V2（取消勾選＝新評估改建 V1 舊制；既有 V2 評估仍可閱讀）
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} data-testid="v2-cfg-approved" /> Owner 已確認採用此設定（未勾選＝提案設定，待確認）
      </label>
      <div className="btn-row"><button type="submit" className="btn primary" disabled={busy || sum !== 100} data-testid="v2-cfg-submit">{busy ? '處理中…' : '儲存新版本'}</button></div>
    </form>
  );
}
