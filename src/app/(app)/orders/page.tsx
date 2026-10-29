import Link from 'next/link';
import { query } from '@/server/lib/db';
import { withActor, sp1, type SP } from '@/server/ui/session';
import { campaignScope } from '@/server/lib/scope';
import { listOrders } from '@/server/modules/orders';
import { Badge, Banner, EmptyState, Filters, PageHeader, Pagination, Table } from '@/ui/components';
import { fmtDateTime, money } from '@/ui/format';
import { as, type Paged } from '@/ui/types';

export const dynamic = 'force-dynamic';

interface OrderRow {
  id: string; campaignId: string; campaignTitle: string; sourceSystem: string; sourceOrderId: string; orderedAt: string; status: string;
  grossAmount: number; refundAmount: number; dataOrigin: string; importBatchId: string | null; hostNames: string | null;
}

const ORDER_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'info' }> = {
  PAID: { label: '已付款', tone: 'ok' }, PENDING: { label: '待付款', tone: 'warn' }, CANCELLED: { label: '已取消', tone: 'neutral' },
  REFUNDED: { label: '已退款', tone: 'danger' }, PARTIAL_REFUND: { label: '部分退款', tone: 'warn' },
};
const ORIGIN: Record<string, string> = { DEMO: 'DEMO 示範', IMPORT: '匯入檔', MANUAL: '廠商回報／人工確認' };

/** 訂單明細：儀表板各項業績指標「點進去看明細」的落點；只讀，資料範圍與欄位都由服務層控制 */
export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const params = new URLSearchParams(Object.entries(q).filter(([, v]) => typeof v === 'string' && v) as [string, string][]);
  const res = as<Paged<OrderRow>>(await listOrders(actor, params));
  const sc = campaignScope(actor, 1, 'c');
  const campaigns = sc.sql === 'FALSE' ? [] : await query<{ id: string; title: string }>(`SELECT c.id, c.title FROM campaigns c WHERE (${sc.sql}) ORDER BY c.created_at DESC LIMIT 200`, sc.params);
  const base: Record<string, string> = {};
  for (const k of ['campaignId', 'status', 'from', 'to', 'hostId', 'refunded']) if (q[k]) base[k] = q[k]!;
  const gross = res.items.reduce((a, o) => a + o.grossAmount, 0);

  return (
    <>
      <PageHeader title="訂單明細" sub="儀表板業績指標的明細；金額為下單當時的訂單金額，退款另列" testid="orders-page" />
      <Banner kind="ok">這裡只顯示你的資料範圍內的訂單，不含購買人個資（只有去識別化代號）。</Banner>
      <Filters>
        <label>檔期<select name="campaignId" defaultValue={q.campaignId ?? ''} data-testid="filter-campaign"><option value="">全部</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>
        <label>狀態<select name="status" defaultValue={q.status ?? ''} data-testid="filter-status"><option value="">全部</option>{Object.entries(ORDER_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
        <label>下單起<input type="date" name="from" defaultValue={q.from} /></label>
        <label>下單迄<input type="date" name="to" defaultValue={q.to} /></label>
        <label><input type="checkbox" name="refunded" value="1" defaultChecked={q.refunded === '1'} /> 只看有退款</label>
      </Filters>
      {res.items.length === 0 ? <EmptyState title="沒有符合條件的訂單" hint="可至「訂單匯入」匯入 CSV" /> : (
        <>
          <p className="small muted" data-testid="orders-summary">共 {res.total} 筆；本頁 {res.items.length} 筆，訂單金額合計 {money(gross)}</p>
          <Table head={['下單時間', '檔期', '團主', '來源', '訂單編號', '狀態', '金額', '退款', '資料性質']} testid="orders-table">
            {res.items.map((o) => (
              <tr key={o.id} data-testid={`order-${o.id}`}>
                <td className="nowrap">{fmtDateTime(o.orderedAt)}</td>
                <td><Link href={`/campaigns/${o.campaignId}`}>{o.campaignTitle}</Link></td>
                <td>{o.hostNames ?? <span className="muted">未歸因</span>}</td>
                <td>{o.sourceSystem}</td>
                <td className="mono">{o.sourceOrderId}</td>
                <td><Badge tone={ORDER_STATUS[o.status]?.tone ?? 'neutral'}>{ORDER_STATUS[o.status]?.label ?? o.status}</Badge></td>
                <td className="num">{money(o.grossAmount)}</td>
                <td className="num">{o.refundAmount ? money(o.refundAmount) : '—'}</td>
                <td>{ORIGIN[o.dataOrigin] ?? o.dataOrigin}</td>
              </tr>
            ))}
          </Table>
          <Pagination total={res.total} limit={res.limit} offset={res.offset} base={base} />
        </>
      )}
    </>
  );
});
