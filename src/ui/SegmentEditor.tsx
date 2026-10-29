'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { callApi } from './api';
import { useToast } from './Toast';
import {
  AGE_BAND_LABEL, BASIS_LABEL, CHANNELS, CHANNEL_LABEL, CYCLE_LABEL, EVIDENCE_KIND_LABEL, FAMILY_TYPE_LABEL,
  SUGGEST_BARRIERS, SUGGEST_CATEGORIES, SUGGEST_MOTIVES, type Basis,
} from '@/server/lib/segment-vocab';

type Pref = { value: string; basis: Basis };
type Groups = { motives: Pref[]; barriers: Pref[]; categories: Pref[]; channels: Pref[] };

export interface SegmentInitial {
  name?: string; description?: string | null; ageBand?: string | null; familyType?: string | null; cycle?: string | null; priceMin?: number | null; priceMax?: number | null; basis?: Basis;
  motives?: Pref[]; barriers?: Pref[]; categories?: Pref[]; channels?: Pref[];
}
interface Props {
  /** host-new：為團主建立新客群並連結；segment-edit：修改既有客群（會影響所有連結它的團主） */
  mode: 'host-new' | 'segment-edit' | 'segment-new';
  hostId?: string; segmentId?: string; version?: number; initial?: SegmentInitial;
  communityOptions?: { value: string; label: string }[];
  idPrefix?: string;
}

const opts = (m: Record<string, string>) => Object.entries(m).map(([value, label]) => ({ value, label }));

function ChipGroup({ id, label, hint, kind, items, setItems, suggestions }: { id: string; label: string; hint?: string; kind: string; items: Pref[]; setItems: (x: Pref[]) => void; suggestions?: string[] }) {
  const [draft, setDraft] = useState('');
  const add = (v: string) => {
    const value = v.trim();
    if (!value || items.some((i) => i.value === value)) return;
    setItems([...items, { value, basis: 'ESTIMATE' }]);
    setDraft('');
  };
  return (
    <div className="chip-editor" data-testid={`seg-group-${kind}`}>
      <span className="lbl" style={{ fontWeight: 600, fontSize: 13 }}>{label}</span> {hint ? <span className="small muted">{hint}</span> : null}
      <div>
        {items.length === 0 ? <span className="unknown small">未知（尚未填寫）</span> : null}
        {items.map((it) => (
          <span key={it.value} className={`chip ${it.basis === 'FACT' ? 'fact' : 'est'}`} data-testid={`seg-chip-${kind}-${it.value}`}>
            {it.value}
            <button type="button" title="點一下切換「事實／估計」" className="b" onClick={() => setItems(items.map((x) => (x.value === it.value ? { ...x, basis: x.basis === 'FACT' ? 'ESTIMATE' : 'FACT' } : x)))}>{BASIS_LABEL[it.basis]}</button>
            <button type="button" aria-label={`移除 ${it.value}`} onClick={() => setItems(items.filter((x) => x.value !== it.value))}>✕</button>
          </span>
        ))}
      </div>
      <div className="adders">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(draft); } }} placeholder="輸入後按 Enter" maxLength={30} data-testid={`seg-add-${kind}`} id={`${id}-${kind}`} />
        <button type="button" className="btn sm" onClick={() => add(draft)} data-testid={`seg-add-${kind}-btn`}>加入</button>
        {(suggestions ?? []).filter((s) => !items.some((i) => i.value === s)).map((s) => <button key={s} type="button" className="btn sm sugg" onClick={() => add(s)} data-testid={`seg-suggest-${kind}-${s}`}>＋{s}</button>)}
      </div>
    </div>
  );
}

export function SegmentEditor({ mode, hostId, segmentId, version, initial, communityOptions, idPrefix = 'seg' }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [ageBand, setAgeBand] = useState(initial?.ageBand ?? '');
  const [familyType, setFamilyType] = useState(initial?.familyType ?? '');
  const [cycle, setCycle] = useState(initial?.cycle ?? '');
  const [priceMin, setPriceMin] = useState(initial?.priceMin != null ? String(initial.priceMin) : '');
  const [priceMax, setPriceMax] = useState(initial?.priceMax != null ? String(initial.priceMax) : '');
  const [basis, setBasis] = useState<Basis>(initial?.basis ?? 'ESTIMATE');
  const [g, setG] = useState<Groups>({ motives: initial?.motives ?? [], barriers: initial?.barriers ?? [], categories: initial?.categories ?? [], channels: initial?.channels ?? [] });
  // 連結（host-new）
  const [share, setShare] = useState('');
  const [community, setCommunity] = useState('');
  const [linkBasis, setLinkBasis] = useState<Basis>('ESTIMATE');
  // 觀察證據（host-new，選填）
  const [evKind, setEvKind] = useState('OBSERVATION');
  const [evBasis, setEvBasis] = useState<Basis>('ESTIMATE');
  const [evSummary, setEvSummary] = useState('');
  const [evSource, setEvSource] = useState('');
  const [evUrl, setEvUrl] = useState('');

  const set = (k: keyof Groups) => (x: Pref[]) => setG((p) => ({ ...p, [k]: x }));
  const suggestedName = [familyType && FAMILY_TYPE_LABEL[familyType], ageBand && AGE_BAND_LABEL[ageBand]].filter(Boolean).join(' ');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const finalName = name.trim() || suggestedName;
    if (!finalName) { setErr('請輸入客群名稱（或先選年齡層／家庭型態讓系統帶入）'); return; }
    const money = (v: string) => (v.trim() === '' ? null : Number(v));
    const segment = {
      name: finalName, description: description.trim() === '' ? (mode === 'segment-edit' ? null : undefined) : description.trim(),
      ageBand: ageBand || null, familyType: familyType || null, cycle: cycle || null, priceMin: money(priceMin), priceMax: money(priceMax), basis,
      motives: g.motives, barriers: g.barriers, categories: g.categories, channels: g.channels,
    };
    setBusy(true); setErr(null);
    let r;
    if (mode === 'segment-edit') r = await callApi(`/api/segments/${segmentId}`, 'PATCH', { ...segment, version });
    else if (mode === 'segment-new') r = await callApi('/api/segments', 'POST', segment, crypto.randomUUID());
    else {
      const evidence = evSummary.trim() ? [{ kind: evKind, basis: evBasis, summary: evSummary.trim(), sourceLabel: evSource.trim() || undefined, sourceUrl: evUrl.trim() || undefined }] : undefined;
      r = await callApi(`/api/hosts/${hostId}/segments`, 'POST', {
        segment, sharePercent: share.trim() === '' ? null : Number(share), basis: linkBasis, communityId: community || null, evidence,
      }, crypto.randomUUID());
    }
    setBusy(false);
    if (!r.ok) { setErr(r.error?.message ?? '送出失敗'); return; }
    toast('ok', mode === 'segment-edit' ? '客群已更新' : mode === 'segment-new' ? '客群已建立' : '客群分析已建立');
    (e.target as HTMLElement).closest('dialog')?.close();
    router.refresh();
  }

  const sel = (id: string, value: string, set_: (v: string) => void, map: Record<string, string>, ph = '未知') => (
    <select id={`${idPrefix}-${id}`} value={value} onChange={(e) => set_(e.target.value)} data-testid={`seg-${id}`}>
      <option value="">（{ph}）</option>{opts(map).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );

  return (
    <form onSubmit={submit} data-testid={`${idPrefix}-form`}>
      {err ? <div className="banner error" role="alert" data-testid="form-error">{err}</div> : null}
      {mode === 'segment-edit' ? <div className="banner warn small">修改會影響所有連結此客群的團主。留空的欄位＝「未知」，不是「沒有」。</div>
        : <p className="small muted">不確定的欄位請留空（顯示為「未知」）；每個選項可點「估計／事實」切換——有出處才標「事實」。</p>}
      <div className="form-grid">
        <label className="field"><span className="lbl">客群名稱<span className="req"> *</span></span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={suggestedName || '例如：育兒家庭 30–44 歲'} maxLength={80} data-testid="seg-name" /></label>
        <label className="field"><span className="lbl">整體依據</span>
          <select value={basis} onChange={(e) => setBasis(e.target.value as Basis)} data-testid="seg-basis">{opts(BASIS_LABEL).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
        <label className="field"><span className="lbl">主要年齡層</span>{sel('ageBand', ageBand, setAgeBand, AGE_BAND_LABEL)}</label>
        <label className="field"><span className="lbl">家庭型態</span>{sel('familyType', familyType, setFamilyType, FAMILY_TYPE_LABEL)}</label>
        <label className="field"><span className="lbl">消費週期</span>{sel('cycle', cycle, setCycle, CYCLE_LABEL)}</label>
        <label className="field"><span className="lbl">單品團購價可接受區間（NT$）</span>
          <span style={{ display: 'flex', gap: 6 }}>
            <input type="number" min={0} value={priceMin} onChange={(e) => setPriceMin(e.target.value)} placeholder="下限" data-testid="seg-priceMin" />
            <input type="number" min={0} value={priceMax} onChange={(e) => setPriceMax(e.target.value)} placeholder="上限" data-testid="seg-priceMax" /></span></label>
      </div>
      <ChipGroup id={idPrefix} kind="MOTIVE" label="購買動機" hint="為什麼買" items={g.motives} setItems={set('motives')} suggestions={SUGGEST_MOTIVES} />
      <ChipGroup id={idPrefix} kind="BARRIER" label="購買阻力" hint="什麼讓他們猶豫" items={g.barriers} setItems={set('barriers')} suggestions={SUGGEST_BARRIERS} />
      <ChipGroup id={idPrefix} kind="CATEGORY" label="偏好品類" items={g.categories} setItems={set('categories')} suggestions={SUGGEST_CATEGORIES} />
      <div className="chip-editor" data-testid="seg-group-CHANNEL">
        <span className="lbl" style={{ fontWeight: 600, fontSize: 13 }}>活躍通路</span> <span className="small muted">可複選</span>
        <div>
          {CHANNELS.map((c) => {
            const cur = g.channels.find((x) => x.value === c);
            return (
              <label key={c} style={{ marginRight: 12, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                <input type="checkbox" checked={!!cur} onChange={(e) => set('channels')(e.target.checked ? [...g.channels, { value: c, basis: 'ESTIMATE' }] : g.channels.filter((x) => x.value !== c))} data-testid={`seg-channel-${c}`} />
                {CHANNEL_LABEL[c]}
                {cur ? <button type="button" className="chip b" style={{ padding: '0 6px' }} onClick={() => set('channels')(g.channels.map((x) => (x.value === c ? { ...x, basis: x.basis === 'FACT' ? 'ESTIMATE' : 'FACT' } : x)))}>{BASIS_LABEL[cur.basis]}</button> : null}
              </label>
            );
          })}
          {g.channels.length === 0 ? <span className="unknown small">未知（尚未勾選）</span> : null}
        </div>
      </div>
      <label className="field"><span className="lbl">說明（群體特徵，請勿填個人資料）</span><textarea value={description ?? ''} onChange={(e) => setDescription(e.target.value)} maxLength={1000} data-testid="seg-description" /></label>

      {mode === 'host-new' ? (
        <>
          <h3 style={{ marginTop: 14 }}>與此團主的關係</h3>
          <div className="form-grid">
            <label className="field"><span className="lbl">占團主受眾比例（%，不確定可留空）</span><input type="number" min={0} max={100} step="any" value={share} onChange={(e) => setShare(e.target.value)} data-testid="seg-share" /></label>
            <label className="field"><span className="lbl">連結依據</span>
              <select value={linkBasis} onChange={(e) => setLinkBasis(e.target.value as Basis)} data-testid="seg-linkBasis">{opts(BASIS_LABEL).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
            {communityOptions ? (
              <label className="field"><span className="lbl">主要所在社群（選填）</span>
                <select value={community} onChange={(e) => setCommunity(e.target.value)} data-testid="seg-community"><option value="">（未指定）</option>{communityOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
            ) : null}
          </div>
          <h3 style={{ marginTop: 14 }}>觀察來源（選填，之後也能補）</h3>
          <div className="form-grid">
            <label className="field"><span className="lbl">種類</span><select value={evKind} onChange={(e) => setEvKind(e.target.value)} data-testid="seg-evKind">{opts(EVIDENCE_KIND_LABEL).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
            <label className="field"><span className="lbl">依據</span><select value={evBasis} onChange={(e) => setEvBasis(e.target.value as Basis)} data-testid="seg-evBasis">{opts(BASIS_LABEL).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
          </div>
          <label className="field"><span className="lbl">觀察紀錄／證據摘要</span><textarea value={evSummary} onChange={(e) => setEvSummary(e.target.value)} maxLength={1000} placeholder="例如：客群經常討論育兒、清潔效率、家庭日常補貨。" data-testid="seg-evSummary" /></label>
          <div className="form-grid">
            <label className="field"><span className="lbl">來源說明（標「事實」時必填來源）</span><input value={evSource} onChange={(e) => setEvSource(e.target.value)} maxLength={200} data-testid="seg-evSource" /></label>
            <label className="field"><span className="lbl">來源連結</span><input type="url" value={evUrl} onChange={(e) => setEvUrl(e.target.value)} placeholder="https://" data-testid="seg-evUrl" /></label>
          </div>
        </>
      ) : null}
      <div className="btn-row"><button type="submit" className="btn primary" disabled={busy} data-testid="seg-submit">{busy ? '處理中…' : mode === 'segment-edit' ? '儲存客群' : mode === 'segment-new' ? '建立客群' : '建立並連結'}</button></div>
    </form>
  );
}
