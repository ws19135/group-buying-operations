import Link from 'next/link';
import { withActor, type Params } from '@/server/ui/session';
import { getSettlement } from '@/server/modules/settlements';
import { can } from '@/server/lib/permissions';
import { ActionButton } from '@/ui/ActionButton';
import { ApiForm } from '@/ui/ApiForm';
import { Modal } from '@/ui/Modal';
import { Banner, Card, EmptyState, Kv, PageHeader, StatusBadge, Table } from '@/ui/components';
import { fmtDateTime, money } from '@/ui/format';
import { as } from '@/ui/types';
import { DATA_STATUS, FINANCE_NOTICE, SETTLEMENT_STATUS } from '../../labels';

export const dynamic = 'force-dynamic';

interface Detail {
  notice: string; stale: boolean;
  settlement: { id: string; status: string; campaignId: string; campaignTitle: string; campaignStatus: string; ruleVersionNote: string | null; note: string | null; dataAsOf: string | null; dataStatus: string | null; createdAt: string; confirmedAt: string | null; voidedAt: string | null; voidReason: string | null };
  items: { id: string; hostId: string; hostName: string; netSales: number | null; ratePercent: number | null; ruleId: string | null; ruleVersion: number | null; commissionAuto: number | null; commissionOverride: number | null; overrideReason: string | null; adjustmentTotal: number; commissionFinal: number | null }[];
  adjustments: { id: string; itemId: string; amount: number; reason: string; createdAt: string; createdByName: string | null }[];
  totals: { netSales: number; commissionFinal: number; itemsWithoutAmount: number; campaignNetSales: number; unattributedNetSales: number; linkedPayments: number };
}

export default withActor(async (actor, props: { params: Params }) => {
  const { id } = await props.params;
  const d = as<Detail>(await getSettlement(actor, id));
  const s = d.settlement;
  const w = can(actor, 'finance.write');
  const c = can(actor, 'settlement.confirm');
  const draft = s.status === 'DRAFT';
  const nameOf = (itemId: string) => d.items.find((i) => i.id === itemId)?.hostName ?? itemId;
  return (
    <>
      <PageHeader title={<>結算試算 {s.id} <StatusBadge map={SETTLEMENT_STATUS} value={s.status} /></>} testid="settlement-header"
        sub={<><Link href={`/campaigns/${s.campaignId}`}>{s.campaignTitle}</Link>・<Link href="/finance?tab=settlements">回結算清單</Link></>}
        actions={<div className="btn-row">
          {draft && w ? <ActionButton endpoint={`/api/settlements/${s.id}/recalculate`} label="重新試算" testid="btn-recalc" successMessage="已重新試算" /> : null}
          {draft && c ? <ActionButton endpoint={`/api/settlements/${s.id}/confirm`} label="確認結算" variant="primary" reasonLabel="確認備註（選填）" reasonKey="note" reasonRequired={false} confirm="確認後項目、覆寫與調整都會鎖定，只能作廢後重開。" testid="btn-confirm" successMessage="結算已確認" /> : null}
          {s.status !== 'VOID' && (draft ? w : c) ? <ActionButton endpoint={`/api/settlements/${s.id}/void`} label="作廢" variant="danger" reasonLabel="作廢原因" testid="btn-void-settlement" /> : null}
        </div>} />
      <Banner kind="warn" testid="settlement-notice"><strong>{FINANCE_NOTICE}</strong></Banner>
      {d.stale ? <Banner kind="error" testid="settlement-stale">訂單資料或佣金規則在試算後有變動，數字已過期。請按「重新試算」後再確認。</Banner> : null}
      {s.status === 'VOID' ? <Banner kind="nodata" testid="settlement-void">已作廢：{s.voidReason}（{fmtDateTime(s.voidedAt)}）</Banner> : null}
      {s.dataStatus === 'DEMO' || s.dataStatus === 'MIXED' ? <Banner kind="demo" testid="settlement-demo">此結算依據的是 DEMO 示範訂單資料，不是真實營運數字。</Banner> : null}

      <div className="grid cols-2">
        <Card title="試算資訊" testid="settlement-info">
          <Kv rows={[
            ['檔期', `${s.campaignTitle}（${s.campaignId}）`], ['資料基準', `${s.dataStatus ? DATA_STATUS[s.dataStatus] ?? s.dataStatus : '—'}，截至 ${fmtDateTime(s.dataAsOf)}`],
            ['使用的規則版本', <span className="small" key="r">{s.ruleVersionNote ?? '—'}</span>], ['建立', fmtDateTime(s.createdAt)], ['確認', fmtDateTime(s.confirmedAt)], ['備註', s.note]]} />
        </Card>
        <Card title="合計" testid="settlement-totals">
          <Kv rows={[
            ['檔期有效淨銷售額', money(d.totals.campaignNetSales)], ['已歸因給團主', money(d.totals.netSales)], ['未歸因（不計佣金）', money(d.totals.unattributedNetSales)],
            ['最終佣金合計（試算）', <strong key="f">{money(d.totals.commissionFinal)}</strong>],
            ['尚缺金額的團主', d.totals.itemsWithoutAmount ? <span key="m" className="badge tone-danger">{d.totals.itemsWithoutAmount} 位（需設定費率或覆寫）</span> : '無'], ['已關聯入帳／付款', `${d.totals.linkedPayments} 筆`]]} />
        </Card>
      </div>

      <Card title="團主項目" flush testid="settlement-items">
        {d.items.length === 0 ? <EmptyState title="沒有團主項目" /> : (
          <Table head={['團主', '歸因淨銷售額', '費率（規則）', '自動試算', '覆寫', '調整合計', '最終佣金（試算）', '']}>
            {d.items.map((i) => (
              <tr key={i.id} data-testid={`item-row-${i.hostId}`}>
                <td><strong>{i.hostName}</strong><div className="small muted">{i.hostId}・{i.id}</div></td>
                <td>{money(i.netSales)}</td>
                <td>{i.ratePercent == null ? <span className="muted">無適用規則</span> : `${i.ratePercent}%`}<div className="small muted">{i.ruleId ? `${i.ruleId} v${i.ruleVersion ?? '?'}` : ''}</div></td>
                <td>{money(i.commissionAuto)}</td>
                <td>{i.commissionOverride == null ? '—' : <>{money(i.commissionOverride)}<div className="small muted">原因：{i.overrideReason}</div></>}</td>
                <td>{i.adjustmentTotal ? money(i.adjustmentTotal) : '—'}</td>
                <td><strong data-testid={`item-final-${i.hostId}`}>{money(i.commissionFinal)}</strong></td>
                <td>{draft && w ? (
                  <div className="btn-row">
                    <Modal label="覆寫" title={`覆寫 ${i.hostName} 的佣金`} size="btn sm" testid={`btn-override-${i.hostId}`}>
                      <p className="small muted">覆寫會取代自動試算值，必須填寫原因（寫入稽核）。需要加減請改用「調整」。</p>
                      <ApiForm endpoint={`/api/settlement-items/${i.id}/override`} submitLabel="儲存覆寫" fields={[
                        { name: 'amount', label: '覆寫金額（新台幣，整數，不可為負）', type: 'number', required: true, min: 0, defaultValue: i.commissionOverride }, { name: 'reason', label: '原因', type: 'textarea', required: true }]} />
                    </Modal>
                    {i.commissionOverride != null ? <ActionButton endpoint={`/api/settlement-items/${i.id}/override`} body={{ amount: null }} label="清除覆寫" small testid={`btn-clear-override-${i.hostId}`} /> : null}
                    <Modal label="調整" title={`新增調整項：${i.hostName}`} size="btn sm" testid={`btn-adjust-${i.hostId}`}>
                      <p className="small muted">調整項只能新增、不能修改或刪除；金額可為負數（扣減），原因必填。</p>
                      <ApiForm endpoint={`/api/settlements/${s.id}/adjustments`} extra={{ itemId: i.id }} submitLabel="新增調整" fields={[
                        { name: 'amount', label: '調整金額（新台幣，整數，可為負）', type: 'number', required: true }, { name: 'reason', label: '原因', type: 'textarea', required: true }]} />
                    </Modal>
                  </div>) : null}</td>
              </tr>))}
          </Table>)}
      </Card>

      <Card title="調整項紀錄（只增不改）" flush testid="settlement-adjustments">
        {d.adjustments.length === 0 ? <EmptyState title="沒有調整項" /> : (
          <Table head={['時間', '團主', '金額', '原因', '操作者']}>
            {d.adjustments.map((a) => <tr key={a.id}><td className="small">{fmtDateTime(a.createdAt)}</td><td>{nameOf(a.itemId)}</td><td>{money(a.amount)}</td><td>{a.reason}</td><td className="small">{a.createdByName ?? '—'}</td></tr>)}
          </Table>)}
      </Card>
    </>
  );
});
