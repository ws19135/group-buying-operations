import Link from 'next/link';
import { auditCodeLabel, glossAuditJson } from '@/ui/audit-labels';
import { withActor, type Params } from '@/server/ui/session';
import { can } from '@/server/lib/permissions';
import { getSegment } from '@/server/modules/segments';
import { ActionButton } from '@/ui/ActionButton';
import { ApiForm } from '@/ui/ApiForm';
import { Modal } from '@/ui/Modal';
import { SegmentEditor } from '@/ui/SegmentEditor';
import { ProfileRows, Unknown } from '@/ui/SegmentProfile';
import { Badge, Card, EmptyState, PageHeader, StatusBadge, Table } from '@/ui/components';
import { BASIS } from '@/ui/labels';
import { fmtDateTime } from '@/ui/format';
import { BASIS_LABEL, EVIDENCE_KIND_LABEL } from '@/server/lib/segment-vocab';
import { as, type EvidenceV, type SegmentV } from '@/ui/types';

export const dynamic = 'force-dynamic';
interface S extends SegmentV {
  hosts: { linkId: string; hostId: string; hostName: string; sharePercent: number | null; basis: string }[];
  history: { id: number; occurredAt: string; actorName: string | null; actorRole: string | null; action: string; beforeData: unknown; afterData: unknown; reason: string | null }[];
}
const j = (v: unknown) => glossAuditJson(v);

export default withActor(async (actor, props: { params: Params }) => {
  const { id } = await props.params;
  const s = as<S>(await getSegment(actor, id));
  const w = can(actor, 'segment.write');
  return (
    <>
      <PageHeader title={<>{s.name} <StatusBadge map={BASIS} value={s.basis} /></>} sub={<>{s.id}&emsp;連結 {s.hosts.length} 位團主&emsp;版本 {s.version}</>} testid="segment-header"
        actions={w ? (
          <div className="btn-row">
            <Modal label="編輯客群" title={`編輯客群：${s.name}`} testid="btn-edit-segment">
              <SegmentEditor mode="segment-edit" segmentId={s.id} version={s.version} idPrefix="edit" initial={{ name: s.name, description: s.description, ageBand: s.ageBand, familyType: s.familyType, cycle: s.cycle, priceMin: s.priceMin, priceMax: s.priceMax, basis: s.basis, motives: s.motives, barriers: s.barriers, categories: s.categories, channels: s.channels }} />
            </Modal>
            <ActionButton endpoint={`/api/segments/${s.id}/archive`} label="封存客群" variant="danger" reasonLabel="封存原因" confirm="仍有團主連結時無法封存；封存是軟刪除，資料保留供稽核。" redirectTo="/segments" testid="btn-archive-segment" />
          </div>
        ) : undefined} />
      <div className="grid cols-2">
        <Card title="客群輪廓" testid="segment-profile">
          <dl className="kv"><ProfileRows s={s} /><dt>說明</dt><dd>{s.description ?? <Unknown />}</dd></dl>
        </Card>
        <Card title="連結的團主" flush testid="segment-hosts">
          {s.hosts.length === 0 ? <EmptyState title="尚無團主連結" hint="到團主頁的「客群分析」連結。" /> : (
            <Table head={['團主', '占比', '依據']}>{s.hosts.map((h) => <tr key={h.linkId}><td><Link href={`/hosts/${h.hostId}`}>{h.hostName}</Link></td><td>{h.sharePercent != null ? `${h.sharePercent}%` : <Unknown />}</td><td>{BASIS_LABEL[h.basis] ?? h.basis}</td></tr>)}</Table>
          )}
        </Card>
      </div>
      <Card title="研究證據" testid="segment-evidence" actions={w ? <Modal label="＋ 新增證據" title="新增研究證據" size="btn sm" testid="btn-add-segment-evidence">
        <ApiForm endpoint={`/api/segments/${s.id}/evidence`} submitLabel="新增" fields={[
          { name: 'kind', label: '種類', type: 'select', required: true, defaultValue: 'OBSERVATION', options: Object.entries(EVIDENCE_KIND_LABEL).map(([value, label]) => ({ value, label })) },
          { name: 'basis', label: '依據', type: 'select', required: true, defaultValue: 'ESTIMATE', help: '標「事實」必須填來源', options: Object.entries(BASIS_LABEL).map(([value, label]) => ({ value, label })) },
          { name: 'summary', label: '摘要（請勿填個人資料）', type: 'textarea', required: true },
          { name: 'sourceLabel', label: '來源說明' }, { name: 'sourceUrl', label: '來源連結', type: 'url' }, { name: 'observedOn', label: '觀察日期', type: 'date' }]} />
      </Modal> : undefined}>
        {s.evidence.length === 0 ? <p className="muted">尚無證據（顯示為「未知」）。</p> : s.evidence.map((e: EvidenceV) => (
          <div key={e.id} className="evi"><Badge tone="neutral">{EVIDENCE_KIND_LABEL[e.kind] ?? e.kind}</Badge> <StatusBadge map={BASIS} value={e.basis} /> {e.summary}
            <div className="small muted">{[e.sourceLabel, e.observedOn, e.hostName ? `針對 ${e.hostName}` : null].filter(Boolean).join('・')}{e.sourceUrl ? <> ・ <a href={e.sourceUrl} target="_blank" rel="noreferrer noopener">來源連結</a></> : null}</div></div>
        ))}
      </Card>
      <Card title="版本與變更紀錄" flush testid="segment-history">
        {s.history.length === 0 ? <EmptyState title="沒有紀錄" /> : (
          <Table head={['時間', '操作者', '動作', '前後值']}>
            {s.history.map((a) => <tr key={a.id}><td className="nowrap small">{fmtDateTime(a.occurredAt)}</td><td className="small">{a.actorName ?? '—'}</td><td className="small">{auditCodeLabel(a.action)}</td>
              <td>{a.beforeData ? <pre className="diff">前：{j(a.beforeData)}</pre> : null}{a.afterData ? <pre className="diff">後：{j(a.afterData)}</pre> : null}</td></tr>)}
          </Table>
        )}
      </Card>
    </>
  );
});
