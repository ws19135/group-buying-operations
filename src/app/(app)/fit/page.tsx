import Link from 'next/link';
import { withActor, sp1, type SP } from '@/server/ui/session';
import { can } from '@/server/lib/permissions';
import { fitOverview, listFit } from '@/server/modules/fit';
import { Banner, Card, EmptyState, PageHeader, Table, Tabs } from '@/ui/components';
import { FitConfigForm } from '@/ui/FitConfigForm';
import { FitTable } from '@/ui/FitTable';
import { PARTNER_TYPE_LABEL, DIM_LABEL } from '@/server/lib/segment-vocab';
import { as, type FitItemV } from '@/ui/types';

export const dynamic = 'force-dynamic';

interface Overview {
  hostsWithoutSegments: { id: string; displayName: string; partnerType: string | null }[];
  config: { version: number; approved: boolean; status: string; weights: { need: number; category: number; price: number; history: number; supply: number }; thresholds: { recommend: number; review: number; minCompleteness: number; highConfidence: number; mediumConfidence: number }; minHistoryCampaigns: number; minShipments: number };
}

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const tab = q.tab ?? 'pending';
  const o = as<Overview>(await fitOverview(actor));
  const items = tab === 'config' ? [] : as<{ items: FitItemV[] }>(await listFit(actor, new URLSearchParams(tab === 'done' ? 'review=done&limit=100' : tab === 'all' ? 'limit=100' : 'review=pending&limit=100'))).items;
  const canReview = can(actor, 'fit.review');
  return (
    <>
      <PageHeader title="客群適配" sub="SOP 01 市場定位：客群輪廓 × 商品 × 團主的適配評估，供 G1 選品核准查閱" testid="fit-header" />
      <Banner kind={o.config.approved ? 'ok' : 'warn'} testid="fit-config-banner">
        評分設定 v{o.config.version}：<strong>{o.config.status}</strong>。權重 {Object.entries(o.config.weights).map(([k, v]) => `${DIM_LABEL[k] ?? k} ${v}%`).join('、')}；
        建議合作 ≥ {o.config.thresholds.recommend} 分、需人工評估 ≥ {o.config.thresholds.review} 分。
        {can(actor, 'fit.config') ? <> <Link href="/fit?tab=config">調整設定</Link></> : null}
      </Banner>
      <Tabs tabs={[{ key: 'pending', label: '待覆核' }, { key: 'done', label: '已覆核' }, { key: 'all', label: '全部最新評估' }, { key: 'config', label: '評分設定' }]} current={tab} base="/fit" />
      {tab === 'config' ? (
        <Card title="評分設定" testid="fit-config">
          <p className="small muted">這些數字是<strong>建議值，待 Owner 確認</strong>，不是正式核准規則。儲存會產生新版本並寫入稽核；已完成的評估保留當時的設定，不會被追溯修改。合規與商品品質是硬性檢查，不受權重影響。</p>
          {can(actor, 'fit.config')
            ? <FitConfigForm cfg={o.config} />
            : <p className="muted">只有系統管理者與營運主管可以調整設定。</p>}
        </Card>
      ) : (
        <>
          <Card title={tab === 'done' ? '已覆核的評估' : tab === 'all' ? '全部最新評估' : '待覆核的評估'} flush testid="fit-list">
            {items.length === 0 ? <EmptyState title={tab === 'pending' ? '沒有待覆核的評估' : '沒有評估'} hint="到商品頁按「產生候選團主評估」，或到檔期的「客群適配」分頁產生。" /> : <FitTable items={items} canReview={canReview} show="both" />}
          </Card>
          <Card title="尚未建立客群分析的團主" flush testid="hosts-without-segments">
            {o.hostsWithoutSegments.length === 0 ? <EmptyState title="所有合作中的團主都已建立客群分析" /> : (
              <Table head={['團主', '合作對象類型', '']}>
                {o.hostsWithoutSegments.map((h) => <tr key={h.id}><td><Link href={`/hosts/${h.id}`}><strong>{h.displayName}</strong></Link><div className="small muted">{h.id}</div></td>
                  <td>{h.partnerType ? PARTNER_TYPE_LABEL[h.partnerType] : <span className="unknown">未知</span>}</td><td><Link className="btn sm" href={`/hosts/${h.id}`}>建立客群分析</Link></td></tr>)}
              </Table>
            )}
          </Card>
          <p className="small muted">評分的資料來源：客群分析（人工填寫，標示事實／估計）、訂單歸因（歷史績效）、出貨與售後案件（供應履約）、商品資料。<Link href="/segments">客群清單</Link>。預設只評估狀態為「合作中」的團主。</p>
        </>
      )}
    </>
  );
});
