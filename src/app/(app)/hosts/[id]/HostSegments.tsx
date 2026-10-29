import Link from 'next/link';
import type { Actor } from '@/server/lib/permissions';
import { can } from '@/server/lib/permissions';
import { getHostSegments, listSegments } from '@/server/modules/segments';
import { ActionButton } from '@/ui/ActionButton';
import { ApiForm } from '@/ui/ApiForm';
import { Modal } from '@/ui/Modal';
import { SegmentEditor } from '@/ui/SegmentEditor';
import { ProfileRows, Unknown } from '@/ui/SegmentProfile';
import { Badge, Banner, Card, StatusBadge } from '@/ui/components';
import { BASIS, PROFILE_STATUS } from '@/ui/labels';
import { as, type EvidenceV, type HostSegmentsV, type Paged } from '@/ui/types';
import { BASIS_LABEL, EVIDENCE_KIND_LABEL, PARTNER_TYPE_LABEL } from '@/server/lib/segment-vocab';

/** 團主詳情的「客群分析」區：基本輪廓、需求動機、購買阻力、偏好品類、消費週期、活躍通路、觀察來源（每項標示事實／估計／未知） */
export async function HostSegments({ actor, hostId, communities }: { actor: Actor; hostId: string; communities: { id: string; name: string }[] }) {
  const d = as<HostSegmentsV>(await getHostSegments(actor, hostId));
  const w = can(actor, 'segment.write');
  const linked = new Set(d.links.map((l) => l.segment.id));
  const all = as<Paged<{ id: string; name: string }>>(await listSegments(actor, new URLSearchParams('limit=200')));
  const linkable = all.items.filter((s) => !linked.has(s.id));
  const commOpts = communities.map((c) => ({ value: c.id, label: c.name }));

  return (
    <Card title={<>客群分析 <StatusBadge map={PROFILE_STATUS} value={d.status} testid="segment-status" /></>} testid="host-segments"
      actions={w ? (
        <div className="btn-row">
          <Modal label="＋ 新增客群" title="新增客群分析並連結此團主" size="btn sm" variant="primary" testid="btn-add-segment">
            <SegmentEditor mode="host-new" hostId={hostId} communityOptions={commOpts} idPrefix="new" />
          </Modal>
          {linkable.length ? (
            <Modal label="連結既有客群" title="連結既有客群" size="btn sm" testid="btn-link-segment">
              <ApiForm endpoint={`/api/hosts/${hostId}/segments`} idempotent submitLabel="連結" testid="link-segment-form" fields={[
                { name: 'segmentId', label: '客群', type: 'select', required: true, options: linkable.map((s) => ({ value: s.id, label: `${s.name}（${s.id}）` })) },
                { name: 'sharePercent', label: '占團主受眾比例（%，可留空）', type: 'number', min: 0, max: 100 },
                { name: 'basis', label: '連結依據', type: 'select', defaultValue: 'ESTIMATE', required: true, options: Object.entries(BASIS_LABEL).map(([value, label]) => ({ value, label })) },
                ...(commOpts.length ? [{ name: 'communityId', label: '主要所在社群（選填）', type: 'select' as const, options: commOpts }] : []),
              ]} />
            </Modal>
          ) : null}
        </div>
      ) : undefined}>
      <dl className="kv" data-testid="host-segment-basics">
        <dt>合作對象類型</dt><dd data-testid="host-partner-type">{d.partnerType ? PARTNER_TYPE_LABEL[d.partnerType] ?? d.partnerType : <Unknown />}</dd>
        <dt>一句話描述</dt><dd>{d.audienceNote ?? <Unknown />}</dd>
        {d.shareSum != null ? <><dt>客群占比合計</dt><dd>{d.shareSum}%{d.shareSum < 100 ? <span className="small muted">（其餘 {Math.round((100 - d.shareSum) * 100) / 100}% 未分配）</span> : null}</dd></> : null}
      </dl>
      {d.status === 'NOT_STARTED' ? (
        <Banner kind="nodata" testid="segment-empty">尚未建立客群分析。先記下這位團主的受眾是誰、要什麼、卡在哪、在哪個通路活躍；沒有把握的欄位留空即可（顯示為「未知」，不會被當成 0 分）。</Banner>
      ) : d.missing.length ? (
        <Banner kind="warn" testid="segment-missing">待補資料：{d.missing.join('、')}。缺資料時適配評估會標示「缺乏證據」並降低信心，不會視為不適配。</Banner>
      ) : null}
      {d.links.map(({ link, segment: s, missing }) => (
        <div key={link.id} className="seg-card" data-testid={`segment-card-${s.id}`}>
          <div className="seg-head">
            <div>
              <h3><Link href={`/segments/${s.id}`}>{s.name}</Link> <StatusBadge map={BASIS} value={s.basis} /> {link.sharePercent != null ? <Badge tone="info">占 {link.sharePercent}%</Badge> : <span className="small muted">占比未知</span>}</h3>
              <div className="small muted">{s.id}{link.communityName ? ` ・ 主要社群：${link.communityName}` : ''}{link.basis === 'FACT' ? ' ・ 連結依據：事實' : ' ・ 連結依據：估計'}</div>
            </div>
            {w ? (
              <div className="btn-row">
                <Modal label="編輯客群" title={`編輯客群：${s.name}`} size="btn sm" testid={`btn-edit-segment-${s.id}`}>
                  <SegmentEditor mode="segment-edit" segmentId={s.id} version={s.version} idPrefix={`e${s.id}`} initial={{
                    name: s.name, description: s.description, ageBand: s.ageBand, familyType: s.familyType, cycle: s.cycle, priceMin: s.priceMin, priceMax: s.priceMax, basis: s.basis,
                    motives: s.motives, barriers: s.barriers, categories: s.categories, channels: s.channels,
                  }} />
                </Modal>
                <Modal label="調整占比" title="調整此團主與客群的關係" size="btn sm" testid={`btn-edit-link-${link.id}`}>
                  <ApiForm endpoint={`/api/segment-links/${link.id}`} method="PATCH" extra={{ version: link.version }} submitLabel="儲存" fields={[
                    { name: 'sharePercent', label: '占團主受眾比例（%）', type: 'number', min: 0, max: 100, defaultValue: link.sharePercent },
                    { name: 'basis', label: '連結依據', type: 'select', required: true, defaultValue: link.basis, options: Object.entries(BASIS_LABEL).map(([value, label]) => ({ value, label })) },
                    ...(commOpts.length ? [{ name: 'communityId', label: '主要所在社群', type: 'select' as const, defaultValue: link.communityId, options: commOpts }] : []),
                    { name: 'note', label: '備註', type: 'textarea', defaultValue: link.note },
                  ]} />
                </Modal>
                <ActionButton endpoint={`/api/segment-links/${link.id}/end`} label="結束連結" small variant="danger" confirm="結束後此客群不再用於這位團主的適配評估（客群本身與歷史評估仍保留）。" testid={`btn-end-link-${link.id}`} />
              </div>
            ) : null}
          </div>
          <dl className="kv">
            <ProfileRows s={s} />
            <dt>觀察來源</dt>
            <dd data-testid={`seg-evidence-${s.id}`}>
              {s.evidence.length === 0 ? <Unknown /> : s.evidence.map((e: EvidenceV) => (
                <div key={e.id} className="evi">
                  <Badge tone="neutral">{EVIDENCE_KIND_LABEL[e.kind] ?? e.kind}</Badge> <StatusBadge map={BASIS} value={e.basis} /> {e.summary}
                  <div className="small muted">{[e.sourceLabel, e.sourceUrl ? <a key="u" href={e.sourceUrl} target="_blank" rel="noreferrer noopener">來源連結</a> : null, e.observedOn, e.hostName ? `針對 ${e.hostName}` : null].filter(Boolean).map((x, i) => <span key={i}>{i ? '・' : ''}{x}</span>)}
                    {w ? <> <ActionButton endpoint={`/api/segment-evidence/${e.id}/remove`} label="移除" small confirm="移除後證據不再顯示（資料保留供稽核）。" testid={`btn-remove-evidence-${e.id}`} /></> : null}</div>
                </div>
              ))}
              {w ? (
                <div style={{ marginTop: 6 }}>
                  <Modal label="＋ 新增觀察來源" title="新增研究證據" size="btn sm" testid={`btn-add-evidence-${s.id}`}>
                    <ApiForm endpoint={`/api/segments/${s.id}/evidence`} extra={{ hostId }} submitLabel="新增" testid={`evidence-form-${s.id}`} fields={[
                      { name: 'kind', label: '種類', type: 'select', required: true, defaultValue: 'OBSERVATION', options: Object.entries(EVIDENCE_KIND_LABEL).map(([value, label]) => ({ value, label })) },
                      { name: 'basis', label: '依據', type: 'select', required: true, defaultValue: 'ESTIMATE', help: '標「事實」必須填來源', options: Object.entries(BASIS_LABEL).map(([value, label]) => ({ value, label })) },
                      { name: 'summary', label: '摘要（請勿填個人資料）', type: 'textarea', required: true },
                      { name: 'sourceLabel', label: '來源說明' }, { name: 'sourceUrl', label: '來源連結', type: 'url' }, { name: 'observedOn', label: '觀察日期', type: 'date' },
                    ]} />
                  </Modal>
                </div>
              ) : null}
            </dd>
          </dl>
          {missing.length ? <p className="small muted">此客群待補：{missing.join('、')}</p> : null}
        </div>
      ))}
    </Card>
  );
}
