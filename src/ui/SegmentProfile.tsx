import type { ReactNode } from 'react';
import { BASIS_LABEL, AGE_BAND_LABEL, CHANNEL_LABEL, CYCLE_LABEL, FAMILY_TYPE_LABEL } from '@/server/lib/segment-vocab';
import { money } from './format';
import type { PrefV, SegmentV } from './types';

/** 客群輪廓的共用呈現：空值一律顯示「未知」（不是「無」），每個偏好標示事實／估計 */
export const Unknown = () => <span className="unknown">未知</span>;

export const Chips = ({ items, label = (v: string) => v, testid }: { items: PrefV[]; label?: (v: string) => string; testid: string }) =>
  items.length === 0 ? <Unknown /> : <span data-testid={testid}>{items.map((p) => <span key={p.id} className={`chip ${p.basis === 'FACT' ? 'fact' : 'est'}`}>{label(p.value)}<span className="b">{BASIS_LABEL[p.basis]}</span></span>)}</span>;

export const priceBand = (min: number | null, max: number | null): ReactNode =>
  (min == null && max == null ? <Unknown /> : `${min == null ? '不限' : money(min)} ～ ${max == null ? '不限' : money(max)}`);

export function ProfileRows({ s }: { s: SegmentV }) {
  return (
    <>
      <dt>基本輪廓</dt><dd>年齡層：{s.ageBand ? AGE_BAND_LABEL[s.ageBand] : <Unknown />}&emsp;家庭型態：{s.familyType ? FAMILY_TYPE_LABEL[s.familyType] : <Unknown />}</dd>
      <dt>消費週期</dt><dd data-testid={`seg-cycle-${s.id}`}>{s.cycle ? CYCLE_LABEL[s.cycle] : <Unknown />}</dd>
      <dt>價格帶</dt><dd>{priceBand(s.priceMin, s.priceMax)}</dd>
      <dt>需求動機</dt><dd><Chips items={s.motives} testid={`seg-motives-${s.id}`} /></dd>
      <dt>購買阻力</dt><dd><Chips items={s.barriers} testid={`seg-barriers-${s.id}`} /></dd>
      <dt>偏好品類</dt><dd><Chips items={s.categories} testid={`seg-categories-${s.id}`} /></dd>
      <dt>活躍通路</dt><dd><Chips items={s.channels} label={(v) => CHANNEL_LABEL[v] ?? v} testid={`seg-channels-${s.id}`} /></dd>
    </>
  );
}
