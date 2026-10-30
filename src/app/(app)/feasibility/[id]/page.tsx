import Link from 'next/link';
import { withActor, type Params } from '@/server/ui/session';
import { can } from '@/server/lib/permissions';
import { getFeasibility } from '@/server/modules/feasibility';
import { NON_SENSITIVE_INPUT_KEYS, SENSITIVE_INPUT_KEYS } from '@/server/lib/feasibility-calc';
import { ActionButton } from '@/ui/ActionButton';
import { Modal } from '@/ui/Modal';
import { Badge, Banner, Card, EmptyState, Kv, PageHeader, Table } from '@/ui/components';
import { SOURCE_KIND } from '@/ui/labels';
import { fmtDateTime, money, num } from '@/ui/format';
import { EvidenceBox } from '@/ui/selection/EvidenceBox';
import { FeasibilityForm } from '@/ui/selection/FeasibilityForm';
import { FeasibilityResults } from '@/ui/selection/FeasibilityResults';
import { as } from '@/ui/types';

export const dynamic = 'force-dynamic';

interface F {
  id: string; productId: string; campaignId: string | null; campaignTitle: string | null; hostId: string | null; hostName: string | null; trialId: string | null; versionNo: number; label: string | null;
  inputs: Record<string, unknown>; sources: Record<string, { kind: string; note?: string | null }>; results: Record<string, unknown>; actuals: Record<string, unknown> | null; actualsAt: string | null;
  restricted: boolean; createdAt: string; createdByName: string | null; evidence: never[]; versions: { id: string; versionNo: number; label: string | null; createdAt: string }[]; inputLabels: Record<string, string>;
}
interface Actuals { scope: string; orders: number; gmv: number; refund: number; nsv: number; aov: number | null; refundRatePct: number | null; complaints: number; refundCases: number; exchangeCases: number; shipments: number; shipmentExceptions: number; shipmentExceptionRatePct: number | null;
  variance: { orders: { predicted: number; actual: number; diff: number; diffPct: number | null } | null; gmv: { predicted: number; actual: number; diff: number; diffPct: number | null } | null; refundRatePct: { predicted: number; actual: number; diff: number } | null }; note: string; campaignStatus: string }

export default withActor(async (actor, props: { params: Params }) => {
  const { id } = await props.params;
  const f = as<F>(await getFeasibility(actor, id));
  const write = can(actor, 'selection.write');
  const canCost = can(actor, 'product.cost.read');
  const editableKeys = canCost ? [...NON_SENSITIVE_INPUT_KEYS, ...SENSITIVE_INPUT_KEYS] : [...NON_SENSITIVE_INPUT_KEYS];
  const a = f.actuals as Actuals | null;
  const rows = Object.entries(f.inputs).filter(([, v]) => v != null);
  return (
    <>
      <PageHeader title={<>商業可行性試算 v{f.versionNo}{f.label ? `・${f.label}` : ''}</>} testid="fz-header"
        sub={<><Link href={`/products/${f.productId}`}>回商品頁</Link>{f.campaignId ? <>・檔期 <Link href={`/campaigns/${f.campaignId}?tab=selection`}>{f.campaignTitle}</Link></> : '・商品層級'}{f.hostName ? `・團主 ${f.hostName}` : ''}・{f.createdByName} {fmtDateTime(f.createdAt)}</>}
        actions={write && f.campaignId ? <ActionButton endpoint={`/api/feasibility/${f.id}/actuals`} label={a ? '重新回寫小團實際' : '回寫小規模測試團實際'} variant="primary" testid="btn-fz-actuals" successMessage="已回寫實際" confirm="從這檔的訂單、售後案件與出貨單讀取實際值並與預測並列（不回寫利潤）。可重複執行，以最新為準。" /> : undefined} />
      <Banner kind="nodata">試算口徑沿用 <code>docs/biz-model/04</code> 的提案，<strong>待 Owner 確認</strong>；只支援單一費率＋固定費。GMV、有效淨銷售額、品牌利潤、公司營業收入是四個不同的數字。缺少的輸入顯示為「未知」，不會被當成 0。</Banner>
      <div className="grid cols-2">
        <Card title="試算結果" testid="fz-results-card"><FeasibilityResults results={f.results as never} /></Card>
        <Card title="輸入與假設來源" flush testid="fz-inputs">
          {f.restricted ? <p className="small muted" style={{ padding: '10px 16px 0' }}>成本、費用、分潤與付款安排屬敏感資料，您沒有成本檢視權限，這些輸入不顯示。</p> : null}
          {rows.length === 0 ? <EmptyState title="沒有可顯示的輸入" /> : (
            <Table head={['輸入', '值', '假設來源']}>{rows.map(([k, v]) => (
              <tr key={k}><td>{f.inputLabels[k] ?? k}</td><td className="num">{typeof v === 'number' ? num(v) : String(v)}</td><td className="small">{f.sources[k] ? SOURCE_KIND[f.sources[k].kind] ?? f.sources[k].kind : <span className="unknown">未註明</span>}</td></tr>))}</Table>)}
        </Card>
      </div>
      <Card title="小規模測試團：實際 vs 預測" testid="fz-actuals">
        {!a ? <p className="muted">{f.campaignId ? '尚未回寫。測試團結單後按上方「回寫小規模測試團實際」。' : '此情境沒有關聯檔期，無法回寫實際。'}</p> : (
          <>
            <p className="small muted">回寫時間 {fmtDateTime(f.actualsAt)}・範圍：{a.scope === 'HOST' ? '指定團主歸因' : '整個檔期'}・檔期狀態 {a.campaignStatus}</p>
            <Kv rows={[
              ['實際有效訂單', a.variance.orders ? `${a.orders}（預測 ${a.variance.orders.predicted}，差 ${a.variance.orders.diff}${a.variance.orders.diffPct == null ? '' : `／${a.variance.orders.diffPct}%`}）` : String(a.orders)],
              ['實際 GMV', a.variance.gmv ? `${money(a.gmv)}（預測 ${money(a.variance.gmv.predicted)}，差 ${money(a.variance.gmv.diff)}）` : money(a.gmv)],
              ['退款 / 淨銷售額', `${money(a.refund)} / ${money(a.nsv)}`], ['客單價', money(a.aov)],
              ['退款率', a.refundRatePct == null ? '—' : `${a.refundRatePct}%${a.variance.refundRatePct ? `（預測 ${a.variance.refundRatePct.predicted}%）` : ''}`],
              ['客訴／退款／換貨件數', `${a.complaints}／${a.refundCases}／${a.exchangeCases}`], ['出貨例外', `${a.shipmentExceptions}／${a.shipments}${a.shipmentExceptionRatePct == null ? '' : `（${a.shipmentExceptionRatePct}%）`}`],
            ]} />
            <p className="small muted">{a.note}</p>
          </>
        )}
      </Card>
      <Card title="證據連結（報價、合約…）" testid="fz-evidence"><EvidenceBox subjectType="FEASIBILITY" subjectId={f.id} items={f.evidence} canEdit={write && canCost} testid="fz-evidence-box" hint={canCost ? undefined : '報價屬敏感資料，需成本檢視權限'} /></Card>
      <Card title="版本" flush testid="fz-versions" actions={write ? <Modal label="以此為基礎，儲存新版本" title="新版本（在這一版的基礎上套用修改）" size="btn sm" variant="primary" testid="btn-fz-new">
        <FeasibilityForm productId={f.productId} campaignId={f.campaignId} hostId={f.hostId} trialId={f.trialId} current={f.inputs} editableKeys={editableKeys} sources={f.sources} />
      </Modal> : undefined}>
        <Table head={['版本', '標籤', '建立']}>{f.versions.map((v) => <tr key={v.id}><td>{v.id === f.id ? <Badge tone="primary">v{v.versionNo}（此版）</Badge> : <Link href={`/feasibility/${v.id}`}>v{v.versionNo}</Link>}</td><td>{v.label ?? '—'}</td><td className="small">{fmtDateTime(v.createdAt)}</td></tr>)}</Table>
      </Card>
    </>
  );
});
