import Link from 'next/link';
import { withActor } from '@/server/ui/session';
import { mySettlementItems } from '@/server/modules/settlements';
import { Banner, Card, EmptyState, PageHeader, Table } from '@/ui/components';
import { fmtDate, money } from '@/ui/format';
import { as } from '@/ui/types';
import { FINANCE_NOTICE } from '../labels';

export const dynamic = 'force-dynamic';
interface Row { settlementId: string; campaignId: string; campaignTitle: string; confirmedAt: string; netSales: number | null; ratePercent: number | null; commission: number | null }

export default withActor(async (actor) => {
  const r = as<{ items: Row[] }>(await mySettlementItems(actor));
  return (
    <>
      <PageHeader title="我的結算" sub="只顯示你自己、且已確認的結算試算" />
      <Banner kind="warn" testid="finance-notice"><strong>{FINANCE_NOTICE}</strong></Banner>
      <Card flush testid="my-settlements">
        {r.items.length === 0 ? <EmptyState title="目前沒有已確認的結算" hint="結算確認前，請先看總覽頁的預估佣金" /> : (
          <Table head={['檔期', '確認日期', '我的淨銷售額', '費率', '試算佣金']}>
            {r.items.map((i) => (
              <tr key={`${i.settlementId}`} data-testid={`my-settlement-${i.settlementId}`}>
                <td><Link href={`/campaigns/${i.campaignId}`}>{i.campaignTitle}</Link></td><td>{fmtDate(i.confirmedAt)}</td><td>{money(i.netSales)}</td>
                <td>{i.ratePercent == null ? '—' : `${i.ratePercent}%`}</td><td><strong>{money(i.commission)}</strong></td>
              </tr>))}
          </Table>)}
      </Card>
    </>
  );
});
