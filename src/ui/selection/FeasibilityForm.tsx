'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { callApi } from '../api';
import { useToast } from '../Toast';
import { SOURCE_KIND } from '../labels';

interface FieldSpec { key: string; label: string; kind: 'int' | 'pct' | 'select'; options?: { value: string; label: string }[]; help?: string }
const PARTY_OPTS = [{ value: 'BRAND', label: '品牌' }, { value: 'COMPANY', label: '公司' }, { value: 'HOST', label: '團主' }];
const GROUPS: { title: string; fields: FieldSpec[] }[] = [
  { title: '規模與價格', fields: [
    { key: 'expectedOrders', label: '預估訂單數', kind: 'int' }, { key: 'unitPrice', label: '團購價（元）', kind: 'int' }, { key: 'refundRatePct', label: '退款率（%）', kind: 'pct' },
    { key: 'cashFlowMode', label: '收款模式', kind: 'select', options: [{ value: 'BRAND_COLLECTS', label: '品牌自收' }, { value: 'HOST_COLLECTS', label: '團主代收' }, { value: 'COMPANY_ESCROW', label: '公司代收（居中）' }] }] },
  { title: '成本（敏感）', fields: [
    { key: 'unitCost', label: '單位商品成本', kind: 'int' }, { key: 'shippingPerOrder', label: '運費／單', kind: 'int' }, { key: 'platformFeePct', label: '平台費比例（% of GMV）', kind: 'pct' },
    { key: 'platformFeePerOrder', label: '平台費／單', kind: 'int' }, { key: 'otherVariablePerOrder', label: '其他變動成本／單（無請填 0）', kind: 'int' }, { key: 'fixedCost', label: '固定費用（無請填 0）', kind: 'int' }] },
  { title: '服務費與分潤（敏感；口徑待 Owner 確認）', fields: [
    { key: 'brandFeePct', label: '品牌端服務費比例（%）', kind: 'pct', help: '公司營業收入＝比例 × 分潤基礎 ＋ 固定費；沒有請填 0' }, { key: 'serviceFeeFixed', label: '品牌端服務費固定額', kind: 'int' },
    { key: 'hostCommissionPct', label: '團主分潤比例（%）', kind: 'pct' },
    { key: 'commissionBasis', label: '分潤基礎', kind: 'select', options: [{ value: 'NSV', label: '有效淨銷售額 NSV' }, { value: 'GMV', label: 'GMV' }] },
    { key: 'hostPaidBy', label: '團主分潤付款方', kind: 'select', options: [{ value: 'COMPANY', label: '公司' }, { value: 'BRAND', label: '品牌' }] }] },
  { title: '成本負擔方（金額大於 0 的項目必選；敏感）', fields: [
    { key: 'shippingBorneBy', label: '運費由誰負擔', kind: 'select', options: PARTY_OPTS }, { key: 'platformFeeBorneBy', label: '平台費由誰負擔', kind: 'select', options: PARTY_OPTS },
    { key: 'otherCostBorneBy', label: '其他變動成本由誰負擔', kind: 'select', options: PARTY_OPTS }, { key: 'fixedCostBorneBy', label: '固定費用由誰負擔', kind: 'select', options: PARTY_OPTS }] },
];

/**
 * 商業可行性試算輸入。每填一個數字都要註明「假設來源」；沒填＝未知（不會當 0）。
 * 儲存會產生新版本，在上一版的基礎上套用這次填的欄位（沒填的欄位沿用）。沒有成本檢視權限的角色看不到、也不能填敏感欄位。
 */
export function FeasibilityForm({ productId, campaignId, hostId, trialId, current, editableKeys, sources, campaignOptions }: {
  productId: string; campaignId?: string | null; hostId?: string | null; trialId?: string | null;
  current: Record<string, unknown>; editableKeys: string[]; sources: Record<string, { kind: string }>;
  /** 商品層級新增時可選擇關聯的檔期（沿用另一個情境的輸入時請用該情境頁的「儲存新版本」） */
  campaignOptions?: { value: string; label: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(GROUPS.flatMap((g) => g.fields).map((f) => [f.key, current[f.key] == null ? '' : String(current[f.key])])));
  const [src, setSrc] = useState<Record<string, string>>(Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.kind])));
  const [label, setLabel] = useState('');
  const [camp, setCamp] = useState(campaignId ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const inputs: Record<string, unknown> = {}; const sources: Record<string, { kind: string }> = {};
    for (const g of GROUPS) for (const f of g.fields) {
      if (!editableKeys.includes(f.key)) continue;
      const raw = vals[f.key];
      if (raw === '' || raw == null) continue;
      inputs[f.key] = f.kind === 'select' ? raw : Number(raw);
      sources[f.key] = { kind: src[f.key] || 'MANUAL_ESTIMATE' };
    }
    if (!Object.keys(inputs).length) { setErr('請至少填寫一項'); return; }
    setBusy(true); setErr(null);
    const r = await callApi(`/api/products/${productId}/feasibility`, 'POST', { campaignId: camp || undefined, hostId: hostId || undefined, trialId: trialId || undefined, label: label || undefined, inputs, sources });
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? '儲存失敗'); return; }
    toast('ok', '已儲存為新版本'); router.refresh();
  }
  return (
    <form onSubmit={save} data-testid="feasibility-form">
      {err ? <div className="banner error" role="alert" data-testid="form-error">{err}</div> : null}
      {campaignOptions ? <label className="field"><span className="lbl">關聯檔期（選填；關聯後可回寫小規模測試團實際）</span>
        <select value={camp} onChange={(e) => setCamp(e.target.value)} data-testid="fz-campaign"><option value="">（商品層級，不關聯檔期）</option>{campaignOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label> : null}
      <label className="field"><span className="lbl">版本標籤（選填，例：保守情境）</span><input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} data-testid="fz-label" /></label>
      {GROUPS.map((g) => {
        const fields = g.fields.filter((f) => editableKeys.includes(f.key));
        if (!fields.length) return <p key={g.title} className="small muted">「{g.title}」屬敏感資料，您沒有成本檢視權限，無法查看或填寫（上一版已有的內容會原樣保留）。</p>;
        return (
          <fieldset key={g.title} style={{ border: '1px solid var(--border)', borderRadius: 6, margin: '8px 0', padding: 10 }}>
            <legend>{g.title}</legend>
            <div className="form-grid">
              {fields.map((f) => (
                <div key={f.key} className="field">
                  <span className="lbl">{f.label}</span>
                  {f.kind === 'select'
                    ? <select value={vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} data-testid={`fz-${f.key}`}><option value="">（未填＝未知）</option>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                    : <input type="number" min={0} max={f.kind === 'pct' ? 100 : undefined} step={f.kind === 'pct' ? 'any' : 1} value={vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} data-testid={`fz-${f.key}`} />}
                  <select value={src[f.key] ?? 'MANUAL_ESTIMATE'} onChange={(e) => setSrc({ ...src, [f.key]: e.target.value })} aria-label={`${f.label}的假設來源`} style={{ marginTop: 4, fontSize: 12 }} data-testid={`fz-src-${f.key}`}>
                    {Object.entries(SOURCE_KIND).map(([v, l]) => <option key={v} value={v}>來源：{l}</option>)}</select>
                  {f.help ? <span className="help">{f.help}</span> : null}
                </div>))}
            </div>
          </fieldset>);
      })}
      <div className="btn-row"><button type="submit" className="btn primary" disabled={busy} data-testid="fz-submit">{busy ? '處理中…' : '試算並儲存為新版本'}</button></div>
    </form>
  );
}
