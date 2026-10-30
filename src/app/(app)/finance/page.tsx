import Link from 'next/link';
import { withActor, sp1, toQuery, type SP } from '@/server/ui/session';
import { financeOverview, listExpenses, listInvoices, listPayments } from '@/server/modules/finance';
import { listSettlements } from '@/server/modules/settlements';
import { can } from '@/server/lib/permissions';
import { ActionButton } from '@/ui/ActionButton';
import { ApiForm } from '@/ui/ApiForm';
import { Modal } from '@/ui/Modal';
import { Banner, Card, EmptyState, KpiCard, PageHeader, Pagination, StatusBadge, Table, Tabs } from '@/ui/components';
import { CAMPAIGN_STATUS } from '@/ui/labels';
import { fmtDate, fmtDateTime, money } from '@/ui/format';
import { as, type Paged } from '@/ui/types';
import { COUNTERPARTY, DATA_STATUS, DIRECTION, EXPENSE_CATEGORY, EXPENSE_STATUS, FINANCE_NOTICE, INVOICE_STATUS, MATCH_STATUS, PAY_STATUS, SETTLEMENT_STATUS, toOptions } from './labels';
import { counterpartyOptions, financeCampaignOptions } from './lookups';

export const dynamic = 'force-dynamic';

interface OvRow { id: string; title: string; status: string; netSales: number; estimatedCommission: number; hostsWithoutRate: number; paidIn: number; paidOut: number; expenses: number; invoiced: number; unmatchedPayments: number; settlementId: string | null; settlementStatus: string | null }
interface Ov { campaigns: OvRow[]; totals: { netSales: number; estimatedCommission: number; paidIn: number; paidOut: number; expenses: number; unmatchedPayments: number; unmatchedWithoutCampaign: number } }
interface SetRow { id: string; status: string; campaignId: string; campaignTitle: string; dataStatus: string | null; dataAsOf: string | null; createdAt: string; confirmedAt: string | null; itemCount: number; netSalesTotal: number }
interface PayRow { id: string; direction: string; counterpartyType: string; counterpartyId: string | null; counterpartyName: string | null; amount: number; paidOn: string; referenceNo: string | null; note: string | null; campaignId: string | null; campaignTitle: string | null; settlementItemId: string | null; matchStatus: string; status: string }
interface InvRow { id: string; invoiceNo: string; invoiceDate: string; amount: number; titleText: string | null; taxIdText: string | null; campaignId: string | null; campaignTitle: string | null; note: string | null; status: string; version: number }
interface ExpRow { id: string; category: string; amount: number; incurredOn: string; campaignId: string | null; campaignTitle: string | null; note: string | null; status: string }

const TABS = [{ key: 'overview', label: '財務總覽' }, { key: 'settlements', label: '結算試算' }, { key: 'payments', label: '入帳／付款' }, { key: 'invoices', label: '發票紀錄' }, { key: 'expenses', label: '費用' }];

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const tab = TABS.some((t) => t.key === q.tab) ? q.tab : 'overview';
  const w = can(actor, 'finance.write');
  const base = Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'page'));
  const qq = toQuery(Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'tab')));
  const [campaigns, parties] = w ? await Promise.all([financeCampaignOptions(actor), counterpartyOptions(actor)]) : [[], []];

  let body: React.ReactNode = null;
  if (tab === 'overview') {
    const ov = as<Ov>(await financeOverview(actor));
    body = (
      <>
        <div className="grid cols-4">
          <KpiCard id="net" label="淨銷售額（有訂單的檔期合計）" value={money(ov.totals.netSales)} />
          <KpiCard id="comm" label="試算佣金合計" value={money(ov.totals.estimatedCommission)} note="尚未設費率的團主不計入" />
          <KpiCard id="in" label="已入帳（收入）" value={money(ov.totals.paidIn)} />
          <KpiCard id="out" label="已付款（支出）" value={money(ov.totals.paidOut)} />
          <KpiCard id="exp" label="費用合計" value={money(ov.totals.expenses)} />
          <KpiCard id="unm" label="未核對入帳／付款" value={String(ov.totals.unmatchedPayments)} note={ov.totals.unmatchedWithoutCampaign ? `其中 ${ov.totals.unmatchedWithoutCampaign} 筆尚未關聯檔期` : undefined} />
        </div>
        <Card title="各檔期" flush testid="finance-overview">
          {ov.campaigns.length === 0 ? <EmptyState title="還沒有可顯示的檔期" hint="需有訂單、入帳、費用或結算紀錄的檔期才會出現在這裡" /> : (
            <Table head={['檔期', '淨銷售額', '試算佣金', '已入帳', '已付款', '費用', '已開立發票', '未核對', '結算']}>
              {ov.campaigns.map((c) => (
                <tr key={c.id} data-testid={`ov-row-${c.id}`}>
                  <td><Link href={`/campaigns/${c.id}`}>{c.title}</Link><div className="small"><StatusBadge map={CAMPAIGN_STATUS} value={c.status} /></div></td>
                  <td>{money(c.netSales)}</td><td>{money(c.estimatedCommission)}{c.hostsWithoutRate ? <div className="small muted">{c.hostsWithoutRate} 位團主無費率</div> : null}</td>
                  <td>{money(c.paidIn)}</td><td>{money(c.paidOut)}</td><td>{money(c.expenses)}</td><td>{money(c.invoiced)}</td><td>{c.unmatchedPayments || '—'}</td>
                  <td>{c.settlementId ? <><Link href={`/finance/settlements/${c.settlementId}`}>{c.settlementId}</Link> <StatusBadge map={SETTLEMENT_STATUS} value={c.settlementStatus} /></> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </>
    );
  } else if (tab === 'settlements') {
    const r = as<Paged<SetRow>>(await listSettlements(actor, qq));
    body = (
      <>
        {w ? (
          <Card title="開立結算試算" testid="settlement-create">
            <p className="small muted">每個檔期同時只能有一份草稿或已確認的結算。金額沿用團主 Dashboard 的預估佣金口徑（歸因淨銷售 × 版本化費率），不新增任何公式。</p>
            <ApiForm endpoint="/api/settlements" submitLabel="開立試算" idempotent testid="settlement-create-form" redirectTo="/finance/settlements/{id}" fields={[
              { name: 'campaignId', label: '檔期', type: 'select', required: true, options: campaigns }, { name: 'note', label: '備註', type: 'textarea' }]} />
          </Card>) : null}
        <Card title="結算清單" flush testid="settlement-list">
          {r.items.length === 0 ? <EmptyState title="尚無結算" /> : (
            <Table head={['結算', '檔期', '狀態', '淨銷售額', '資料基準', '建立', '確認']}>
              {r.items.map((s) => (
                <tr key={s.id} data-testid={`settlement-row-${s.id}`}>
                  <td><Link href={`/finance/settlements/${s.id}`}>{s.id}</Link></td><td>{s.campaignTitle}<div className="small muted">{s.itemCount} 位團主</div></td>
                  <td><StatusBadge map={SETTLEMENT_STATUS} value={s.status} /></td><td>{money(s.netSalesTotal)}</td>
                  <td className="small">{s.dataStatus ? DATA_STATUS[s.dataStatus] ?? s.dataStatus : '—'}<div className="muted">截至 {fmtDateTime(s.dataAsOf)}</div></td>
                  <td className="small">{fmtDateTime(s.createdAt)}</td><td className="small">{fmtDateTime(s.confirmedAt)}</td>
                </tr>))}
            </Table>)}
          <Pagination total={r.total} limit={r.limit} offset={r.offset} base={base} />
        </Card>
      </>
    );
  } else if (tab === 'payments') {
    const r = as<Paged<PayRow>>(await listPayments(actor, qq));
    body = (
      <>
        <Banner kind="warn" testid="payment-note">這裡只做「入帳／付款確認紀錄」，不連接銀行。參考號與備註請勿填寫真實銀行帳號，需要時使用佔位字。</Banner>
        {w ? (
          <Card title="新增入帳／付款紀錄" testid="payment-create">
            <ApiForm endpoint="/api/payments" submitLabel="新增紀錄" idempotent testid="payment-create-form" fields={[
              { name: 'direction', label: '方向', type: 'select', required: true, options: toOptions(DIRECTION), half: true },
              { name: 'counterpartyType', label: '對象類型', type: 'select', required: true, options: toOptions(COUNTERPARTY), half: true },
              { name: 'counterpartyId', label: '對象（廠商／團主；平台免選）', type: 'select', options: parties, half: true },
              { name: 'amount', label: '金額（新台幣，整數）', type: 'number', required: true, min: 1, half: true },
              { name: 'paidOn', label: '日期', type: 'date', required: true, half: true }, { name: 'referenceNo', label: '參考號（佔位字即可）', half: true },
              { name: 'campaignId', label: '關聯檔期（選填）', type: 'select', options: campaigns, half: true }, { name: 'note', label: '備註', half: true }]} />
          </Card>) : null}
        <Card title="入帳／付款紀錄" flush testid="payment-list">
          {r.items.length === 0 ? <EmptyState title="尚無紀錄" /> : (
            <Table head={['編號', '方向／對象', '金額', '日期', '關聯', '核對', '']}>
              {r.items.map((p) => (
                <tr key={p.id} data-testid={`payment-row-${p.id}`}>
                  <td>{p.id}<div className="small muted">{p.referenceNo}</div></td>
                  <td>{DIRECTION[p.direction]}<div className="small">{COUNTERPARTY[p.counterpartyType]}{p.counterpartyName ? `：${p.counterpartyName}` : ''}</div></td>
                  <td>{money(p.amount)}</td><td>{fmtDate(p.paidOn)}</td>
                  <td className="small">{p.campaignTitle ?? '—'}{p.settlementItemId ? <div className="muted">{p.settlementItemId}</div> : null}</td>
                  <td><StatusBadge map={MATCH_STATUS} value={p.matchStatus} /> {p.status === 'VOID' ? <StatusBadge map={PAY_STATUS} value="VOID" /> : null}</td>
                  <td>{w && p.status === 'ACTIVE' ? (
                    <div className="btn-row">
                      {p.matchStatus === 'UNMATCHED' ? (
                        <>
                          <Modal label="核對" title={`核對 ${p.id}`} size="btn sm" testid={`btn-match-${p.id}`}>
                            <p className="small muted">核對前需關聯到檔期或結算項目；核對後金額與關聯鎖定。</p>
                            <ApiForm endpoint={`/api/payments/${p.id}/match`} submitLabel="確認核對" fields={[
                              { name: 'campaignId', label: '檔期', type: 'select', options: campaigns, defaultValue: p.campaignId }, { name: 'settlementItemId', label: '結算項目編號（選填，例如 SIT-000001）', defaultValue: p.settlementItemId }]} />
                          </Modal>
                          <ActionButton endpoint={`/api/payments/${p.id}/void`} label="作廢" small variant="danger" reasonLabel="作廢原因" testid={`btn-void-pay-${p.id}`} />
                        </>
                      ) : <ActionButton endpoint={`/api/payments/${p.id}/unmatch`} label="取消核對" small reasonLabel="取消原因" testid={`btn-unmatch-${p.id}`} />}
                    </div>) : null}</td>
                </tr>))}
            </Table>)}
          <Pagination total={r.total} limit={r.limit} offset={r.offset} base={base} />
        </Card>
      </>
    );
  } else if (tab === 'invoices') {
    const r = as<Paged<InvRow>>(await listInvoices(actor, qq));
    body = (
      <>
        <Banner kind="warn" testid="invoice-note">這裡只做發票「紀錄」，不連接電子發票服務。抬頭與統編請使用佔位字（例如 &lt;佔位抬頭&gt;），不要放真實資料。</Banner>
        {w ? (
          <Card title="新增發票紀錄" testid="invoice-create">
            <ApiForm endpoint="/api/invoices" submitLabel="新增（草稿）" idempotent testid="invoice-create-form" fields={[
              { name: 'invoiceNo', label: '發票號碼（或佔位字）', required: true, half: true }, { name: 'invoiceDate', label: '日期', type: 'date', required: true, half: true },
              { name: 'amount', label: '金額（新台幣，整數）', type: 'number', required: true, min: 0, half: true }, { name: 'campaignId', label: '關聯檔期（選填）', type: 'select', options: campaigns, half: true },
              { name: 'titleText', label: '抬頭（佔位）', half: true }, { name: 'taxIdText', label: '統編（佔位）', half: true }, { name: 'note', label: '備註', half: true }]} />
          </Card>) : null}
        <Card title="發票紀錄" flush testid="invoice-list">
          {r.items.length === 0 ? <EmptyState title="尚無發票紀錄" /> : (
            <Table head={['編號', '發票號碼', '日期', '金額', '檔期', '狀態', '']}>
              {r.items.map((i) => (
                <tr key={i.id} data-testid={`invoice-row-${i.id}`}>
                  <td>{i.id}</td><td>{i.invoiceNo}<div className="small muted">{[i.titleText, i.taxIdText].filter(Boolean).join('・')}</div></td><td>{fmtDate(i.invoiceDate)}</td><td>{money(i.amount)}</td>
                  <td className="small">{i.campaignTitle ?? '—'}</td><td><StatusBadge map={INVOICE_STATUS} value={i.status} /></td>
                  <td>{w && i.status !== 'VOID' ? (
                    <div className="btn-row">
                      {i.status === 'DRAFT' ? <ActionButton endpoint={`/api/invoices/${i.id}/issue`} label="標記已開立" small confirm="標記後金額與號碼就不能再修改，只能作廢。" testid={`btn-issue-${i.id}`} /> : null}
                      <ActionButton endpoint={`/api/invoices/${i.id}/void`} label="作廢" small variant="danger" reasonLabel="作廢原因" testid={`btn-void-inv-${i.id}`} />
                    </div>) : null}</td>
                </tr>))}
            </Table>)}
          <Pagination total={r.total} limit={r.limit} offset={r.offset} base={base} />
        </Card>
      </>
    );
  } else {
    const r = as<Paged<ExpRow>>(await listExpenses(actor, qq));
    body = (
      <>
        <Banner kind="nodata" testid="expense-note">費用只做記錄與彙總，不會進入佣金或結算公式。</Banner>
        {w ? (
          <Card title="新增費用" testid="expense-create">
            <ApiForm endpoint="/api/expenses" submitLabel="新增費用" idempotent testid="expense-create-form" fields={[
              { name: 'category', label: '類別', type: 'select', required: true, options: toOptions(EXPENSE_CATEGORY), half: true }, { name: 'amount', label: '金額（新台幣，整數）', type: 'number', required: true, min: 1, half: true },
              { name: 'incurredOn', label: '發生日期', type: 'date', required: true, half: true }, { name: 'campaignId', label: '關聯檔期（選填）', type: 'select', options: campaigns, half: true }, { name: 'note', label: '備註', half: true }]} />
          </Card>) : null}
        <Card title="費用紀錄" flush testid="expense-list">
          {r.items.length === 0 ? <EmptyState title="尚無費用" /> : (
            <Table head={['編號', '類別', '金額', '日期', '檔期', '備註', '狀態', '']}>
              {r.items.map((e) => (
                <tr key={e.id} data-testid={`expense-row-${e.id}`}>
                  <td>{e.id}</td><td>{EXPENSE_CATEGORY[e.category]}</td><td>{money(e.amount)}</td><td>{fmtDate(e.incurredOn)}</td><td className="small">{e.campaignTitle ?? '—'}</td><td className="small">{e.note}</td>
                  <td><StatusBadge map={EXPENSE_STATUS} value={e.status} /></td>
                  <td>{w && e.status === 'RECORDED' ? <ActionButton endpoint={`/api/expenses/${e.id}/void`} label="作廢" small variant="danger" reasonLabel="作廢原因" testid={`btn-void-exp-${e.id}`} /> : null}</td>
                </tr>))}
            </Table>)}
          <Pagination total={r.total} limit={r.limit} offset={r.offset} base={base} />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="財務結算" sub="入帳確認、費用、發票紀錄與結算試算；全部是紀錄，不連接任何金流、銀行或電子發票" testid="finance-header" />
      <Banner kind="warn" testid="finance-notice"><strong>{FINANCE_NOTICE}</strong></Banner>
      <Tabs tabs={TABS} current={tab} base="/finance" />
      {body}
    </>
  );
});
