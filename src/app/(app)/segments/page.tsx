import Link from 'next/link';
import { withActor, sp1, toQuery, type SP } from '@/server/ui/session';
import { can } from '@/server/lib/permissions';
import { listSegments } from '@/server/modules/segments';
import { Card, EmptyState, Filters, PageHeader, Pagination, StatusBadge, Table } from '@/ui/components';
import { Modal } from '@/ui/Modal';
import { SegmentEditor } from '@/ui/SegmentEditor';
import { BASIS } from '@/ui/labels';
import { AGE_BAND_LABEL, CYCLE_LABEL, FAMILY_TYPE_LABEL } from '@/server/lib/segment-vocab';
import { as, type Paged } from '@/ui/types';

export const dynamic = 'force-dynamic';
interface Row { id: string; name: string; ageBand: string | null; familyType: string | null; cycle: string | null; basis: 'FACT' | 'ESTIMATE'; linkedHosts: number; evidenceCount: number }
const unknown = <span className="unknown">未知</span>;

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const res = as<Paged<Row>>(await listSegments(actor, toQuery(q)));
  const base = Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'page'));
  return (
    <>
      <PageHeader title="客群" sub="受眾輪廓（不是合作對象）：誰、要什麼、卡在哪、在哪個通路；一個客群可被多位團主共用"
        actions={can(actor, 'segment.write') ? <Modal label="＋ 新增客群" title="新增客群" variant="primary" testid="btn-create-segment"><SegmentEditor mode="segment-new" idPrefix="newseg" /></Modal> : null} />
      <Filters>
        <label>關鍵字<input name="q" defaultValue={q.q} data-testid="filter-q" /></label>
        <label>年齡層<select name="ageBand" defaultValue={q.ageBand ?? ''}><option value="">全部</option>{Object.entries(AGE_BAND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>家庭型態<select name="familyType" defaultValue={q.familyType ?? ''}><option value="">全部</option>{Object.entries(FAMILY_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      </Filters>
      <Card flush testid="segment-list">
        {res.items.length === 0 ? <EmptyState title="還沒有客群" hint="到團主頁的「客群分析」建立，或在這裡新增後再連結團主。" /> : (
          <Table head={['客群', '年齡層', '家庭型態', '消費週期', '依據', '連結團主', '證據']}>
            {res.items.map((s) => (
              <tr key={s.id} data-testid={`segment-row-${s.id}`}><td><Link href={`/segments/${s.id}`}><strong>{s.name}</strong></Link><div className="small muted">{s.id}</div></td>
                <td>{s.ageBand ? AGE_BAND_LABEL[s.ageBand] : unknown}</td><td>{s.familyType ? FAMILY_TYPE_LABEL[s.familyType] : unknown}</td><td>{s.cycle ? CYCLE_LABEL[s.cycle] : unknown}</td>
                <td><StatusBadge map={BASIS} value={s.basis} /></td><td>{s.linkedHosts}</td><td>{s.evidenceCount}</td></tr>
            ))}
          </Table>
        )}
        <Pagination total={res.total} limit={res.limit} offset={res.offset} base={base} />
      </Card>
    </>
  );
});
