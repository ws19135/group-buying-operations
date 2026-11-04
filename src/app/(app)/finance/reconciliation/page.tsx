import Link from 'next/link';
import { withActor, sp1, type SP } from '@/server/ui/session';
import { getCommissionReconciliation } from '@/server/modules/commission-reconciliation';
import { getCostAllocationAnalysis, getFeeAttributionReport } from '@/server/modules/finance-comparison';
import { can } from '@/server/lib/permissions';
import { Badge, Banner, Card, EmptyState, PageHeader, Tabs } from '@/ui/components';
import { money } from '@/ui/format';
import { as } from '@/ui/types';
import { RECON_VERDICT_LABEL, type ReconRow } from '@/server/lib/commission-reconciliation';
import { ALIGNMENT_LABEL, OBLIGATION_LABEL, type FeeReport } from '@/server/lib/fee-attribution';
import type { AllocationAnalysis } from '@/server/modules/finance-comparison';
import { listCommissionReconItems } from '@/server/modules/commission-recon-items';
import { ActionButton } from '@/ui/ActionButton';
import { fmtDateTime } from '@/ui/format';

export const dynamic = 'force-dynamic';

const TABS = [{ key: 'commission', label: '分潤口徑差異（合約／可行性／結算）' }, { key: 'fees', label: '費用歸屬對照' }, { key: 'allocation', label: '多商品成本分攤提案' }];
const tone = (v: string) => (v === 'CONSISTENT' || v === 'ALIGNED' ? 'ok' : v === 'DIFFERENT' || v === 'NOT_ALIGNED' ? 'warn' : 'info');

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const tab = TABS.some((t) => t.key === q.tab) ? q.tab : 'commission';
  if (!can(actor, 'finance.read') || !can(actor, 'product.cost.read')) {
    return <><PageHeader title="財務口徑核對" testid="recon-header" /><Banner kind="error">合約與分潤條件、費用負擔屬敏感資料，需有財務讀取與成本檢視權限。</Banner></>;
  }
  let body: React.ReactNode = null;
  if (tab === 'commission') {
    const r = as<{ rows: ReconRow[]; summary: { rows: number; different: number; insufficient: number; consistent: number; needsReview: number }; note: string }>(await getCommissionReconciliation(actor));
    const review = r.rows.filter((x) => x.needsManualReview);
    const items = as<{ items: { id: string; status: string; campaignId: string; campaignTitle: string; hostName: string; productName: string; reviewReasons: string[]; firstSeenAt: string; lastSeenAt: string; acknowledgeNote: string | null; acknowledgedByName: string | null; acknowledgedAt: string | null }[]; note: string }>(await listCommissionReconItems(actor));
    const canWrite = can(actor, 'finance.write');
    body = (
      <>
        <Banner kind="warn" testid="recon-note">{r.note}</Banner>
        <p data-testid="recon-summary"><Badge tone="info">{r.summary.rows} 組（檔期×團主×商品）</Badge>{' '}<Badge tone="ok">一致 {r.summary.consistent}</Badge>{' '}<Badge tone="warn">有差異 {r.summary.different}</Badge>{' '}<Badge>資料不足 {r.summary.insufficient}</Badge>{' '}<Badge tone="warn">待人工覆核 {r.summary.needsReview}</Badge></p>
        <Card title="待人工確認項目（已建立；財務依既有規則版本與核准流程處理）" testid="recon-items"
          actions={canWrite ? <ActionButton endpoint="/api/reconciliation/commission/sync" label="把目前的差異同步為待確認項目" small variant="primary" testid="btn-recon-sync" successMessage="已同步差異項目（沒有修改任何財務資料）" /> : undefined}>
          <p className="small muted" data-testid="recon-items-note">{items.note}</p>
          {items.items.length === 0 ? <EmptyState title="目前沒有待確認項目" hint="有差異時按右上角「同步」建立；差異消失時會自動關閉。" /> : (
            <ul>{items.items.map((it) => (
              <li key={it.id} data-testid={`recon-item-${it.id}`}><strong>{it.campaignTitle}</strong>・{it.hostName}・{it.productName}・<Badge tone={it.status === 'OPEN' ? 'warn' : 'info'}>{it.status === 'OPEN' ? '待確認' : '財務已知悉'}</Badge>
                <ul className="small">{it.reviewReasons.map((t) => <li key={t}>{t}</li>)}</ul>
                <div className="small muted">首次發現 {fmtDateTime(it.firstSeenAt)}・最近一次 {fmtDateTime(it.lastSeenAt)}{it.acknowledgedAt ? `・${it.acknowledgedByName ?? ''} ${fmtDateTime(it.acknowledgedAt)} 確認：${it.acknowledgeNote}` : ''}</div>
                {canWrite && it.status === 'OPEN' ? <ActionButton endpoint={`/api/reconciliation/commission/items/${it.id}/acknowledge`} label="財務已知悉，將依既有流程處理" small reasonLabel="確認說明（只改這個項目的狀態，不修改任何財務資料）" reasonKey="note" testid={`btn-recon-ack-${it.id}`} successMessage="已確認（沒有修改任何財務資料）" /> : null}
              </li>))}</ul>)}
        </Card>
        <Card title="待人工覆核清單（即時計算；只列出，不自動處理）" testid="recon-review">
          {review.length === 0 ? <EmptyState title="目前沒有待覆核項目" /> : (
            <ul>{review.map((x) => (
              <li key={x.key} data-testid={`recon-review-${x.key}`}><strong>{x.campaignTitle}</strong>・{x.hostName}・{x.productName}
                <ul className="small">{x.reviewReasons.map((t) => <li key={t}>{t}</li>)}</ul>
                {x.impact.estimatedGap != null ? <div className="small muted">影響範圍（估算）：比例最大差距 {x.impact.maxRateGapPct} 個百分點 × 歸因有效淨銷售額 {money(x.impact.attributedNetSales)} ≈ {money(x.impact.estimatedGap)}。{x.impact.note}</div> : null}
              </li>))}</ul>)}
        </Card>
        <Card title="逐項比較" flush testid="recon-table">
          <div className="table-wrap"><table>
            <thead><tr><th>檔期・團主・商品</th><th>項目</th><th>合約約定</th><th>商業可行性</th><th>財務結算規則</th><th>判定</th></tr></thead>
            <tbody>{r.rows.flatMap((x) => x.fields.map((f, idx) => (
              <tr key={`${x.key}-${f.field}`} data-testid={`recon-${x.key}-${f.field}`}>
                {idx === 0 ? <td rowSpan={x.fields.length}><Link href={`/campaigns/${x.campaignId}`}>{x.campaignTitle}</Link><div className="small muted">{x.hostName}・{x.productName}</div><Badge tone={tone(x.verdict)}>{RECON_VERDICT_LABEL[x.verdict]}</Badge></td> : null}
                <td>{f.label}</td>
                {(['CONTRACT', 'FEASIBILITY', 'FINANCE'] as const).map((src) => {
                  const v = f.values.find((x) => x.source === src);
                  return v ? <td key={src} className="small" data-testid={`recon-v-${src}`}><strong>{v.display}</strong><div className="muted">{v.version ?? ''}</div><div className={v.approved ? 'muted' : 'unknown'}>{v.approvalNote}</div></td> : <td key={src} className="small muted">（這個來源沒有這項）</td>;
                })}
                <td className="small"><Badge tone={tone(f.verdict)}>{RECON_VERDICT_LABEL[f.verdict]}</Badge>{f.differences.map((d) => <div key={d} className="muted">{d}</div>)}</td>
              </tr>)))}</tbody>
          </table></div>
        </Card>
      </>);
  } else if (tab === 'fees') {
    const r = as<{ reports: FeeReport[]; notAlignedSummary: Record<string, number>; note: string; integrationProposal: string }>(await getFeeAttributionReport(actor));
    body = (
      <>
        <Banner kind="warn" testid="fee-note">{r.note}</Banner>
        <p className="small" data-testid="fee-summary"><strong>KPI 與正式結算尚未一致的費用項目：</strong>{Object.keys(r.notAlignedSummary).length ? Object.entries(r.notAlignedSummary).map(([k, v]) => `${k}（${v} 組）`).join('、') : '沒有資料'}。未來整合方案見 <code>{r.integrationProposal}</code>。</p>
        {r.reports.length === 0 ? <EmptyState title="沒有可對照的檔期" hint="需要有檔期、商品與商業可行性條款。" /> : r.reports.map((rep) => (
          <Card key={`${rep.campaignId}-${rep.productId}`} title={`${rep.campaignTitle}・${rep.productName}`} flush testid={`fee-${rep.campaignId}-${rep.productId}`}>
            <p className="small muted" style={{ padding: '8px 16px 0' }}>條款版本：{rep.termsVersion ?? '沒有商業可行性條款'}。{rep.cashFlowNote}</p>
            <div className="table-wrap"><table>
              <thead><tr><th>費用</th><th>試算（KPI）負擔方與金額</th><th>財務已記錄支出</th><th>正式結算</th><th>是否一致</th><th>可能的應收／應付</th></tr></thead>
              <tbody>{rep.rows.map((x) => (
                <tr key={x.item} data-testid={`fee-row-${x.item}`}>
                  <td><strong>{x.label}</strong></td>
                  <td className="small">{x.kpi.bearerLabel}<div>{x.kpi.amount == null ? <span className="unknown">不估算／資料不足</span> : money(x.kpi.amount)}</div><div className="muted">{x.kpi.sourceKind ? `來源：${x.kpi.sourceKind}${x.kpi.confirmed ? '（已確認）' : '（暫估）'}` : ''}</div></td>
                  <td className="small">{x.formal.recordedExpense == null ? '無對應類別' : `${money(x.formal.recordedExpense)}（${x.formal.expenseCount} 筆）`}</td>
                  <td className="small">{x.formal.handledBySettlement ? '已處理' : '未處理'}</td>
                  <td className="small"><Badge tone={tone(x.alignment)}>{ALIGNMENT_LABEL[x.alignment]}</Badge>{x.reasons.map((t) => <div key={t} className="muted">{t}</div>)}</td>
                  <td className="small"><Badge tone="info">{OBLIGATION_LABEL[x.obligation.kind]}</Badge><div className="muted">{x.obligation.explanation}</div>{x.obligation.toConfirm.length ? <div className="muted">需確認：{x.obligation.toConfirm.join('、')}</div> : null}</td>
                </tr>))}</tbody>
            </table></div>
          </Card>))}
      </>);
  } else {
    const campaignId = q.campaignId;
    const a = campaignId ? as<AllocationAnalysis>(await getCostAllocationAnalysis(actor, campaignId)) : null;
    body = (
      <>
        <Banner kind="warn" testid="alloc-note">提案，未生效：Owner 核准前，多商品檔期的每單貢獻利潤維持「資料不足」；這裡的結果不會被 KPI、實際值回寫或結算使用。完整提案見 <code>docs/phase2/MULTI_PRODUCT_COST_ALLOCATION_PROPOSAL.md</code>。</Banner>
        <form method="get" className="btn-row" data-testid="alloc-form"><input type="hidden" name="tab" value="allocation" /><label className="field"><span className="lbl">檔期編號（例如 CMP-202611-0001）</span><input name="campaignId" defaultValue={campaignId ?? ''} data-testid="alloc-campaign" /></label><button className="btn" type="submit">分析</button></form>
        {!a ? <EmptyState title="輸入檔期編號後分析" /> : (
          <>
            <Card title={`${a.campaignTitle}：${a.multiProduct ? '多商品檔期' : '單一商品檔期（不需要分攤）'}`} testid="alloc-inventory">
              <p className="small">{a.kpiImpact}</p>
              <ul className="small">{a.inventory.map((x) => <li key={x.key}><Badge tone={x.status === 'AVAILABLE' ? 'ok' : x.status === 'PARTIAL' ? 'warn' : 'info'}>{x.status === 'AVAILABLE' ? '可用' : x.status === 'PARTIAL' ? '部分' : '缺'}</Badge> <strong>{x.label}</strong>：{x.detail}</li>)}</ul>
              <p className="small muted">假設（僅供提案比較）：{a.assumptions.join('；')}</p>
            </Card>
            {a.comparison ? (
              <Card title="四種候選方法的比較（以財務已記錄的共同費用試算）" flush testid="alloc-compare">
                <div className="table-wrap"><table>
                  <thead><tr><th>方法</th>{a.products.map((p) => <th key={p.productId}>{p.name}<div className="small muted">有效淨銷售額 {p.nsv == null ? '—' : money(p.nsv)}・數量 {p.quantity ?? '—'}</div></th>)}<th>取捨</th></tr></thead>
                  <tbody>{a.comparison.methods.map((m) => (
                    <tr key={m.method} data-testid={`alloc-m-${m.method}`}>
                      <td><strong>{m.label}</strong>{m.usable ? null : <div className="unknown">不可用：{m.problems.join('；')}</div>}</td>
                      {m.allocations.map((x) => <td key={x.productId}>{m.usable ? money(x.total) : '—'}</td>)}
                      <td className="small muted">{m.note}{m.unknownCosts.length ? `（金額未知、未分攤：${m.unknownCosts.join('、')}）` : ''}</td>
                    </tr>))}</tbody>
                </table></div>
                <p className="small muted" style={{ padding: '8px 16px' }}>{a.comparison.note}</p>
              </Card>) : null}
            {a.impact ? (
              <>
                <Card title="費用分類（依財務填的對應商品／團主；不推測）" testid="alloc-classes">
                  <ul className="small">{a.impact.classes.map((c) => <li key={c.cls} data-testid={`alloc-class-${c.cls}`}><strong>{c.label}</strong>：{c.count} 筆、{money(c.amount)} <span className="muted">{c.note}</span></li>)}</ul>
                  <p className="small muted">公司承擔的費用合計 {money(a.impact.companyCostTotal)}（共同 {money(a.impact.sharedPoolTotal)}・直接 {money(a.impact.directTotal)}・特定團主 {money(a.impact.hostSpecificTotal)}）；品牌或團主承擔、不計入公司的 {money(a.impact.excludedNotCompanyTotal)}。</p>
                </Card>
                <Card title="各方法對公司利潤與商品利潤的影響" flush testid="alloc-impact">
                  <div className="table-wrap"><table>
                    <thead><tr><th>方法</th>{a.products.map((p) => <th key={p.productId}>{p.name}<div className="small muted">商品利潤</div></th>)}<th>公司利潤</th><th>池差額</th></tr></thead>
                    <tbody>{a.impact.impact.map((i) => (
                      <tr key={i.method} data-testid={`alloc-impact-${i.method}`}>
                        <td><strong>{i.label}</strong></td>
                        {i.products.map((x) => <td key={x.productId}>{x.productProfit == null ? <span className="unknown">資料不足</span> : money(x.productProfit)}</td>)}
                        <td>{i.companyProfit == null ? <span className="unknown">資料不足</span> : money(i.companyProfit)}</td>
                        <td className="small">{i.poolGap == null ? '—' : i.poolGap === 0 ? '0' : i.poolGap > 0 ? `${i.poolGap}（未分攤）` : `${i.poolGap}（算太多）`}</td>
                      </tr>))}</tbody>
                  </table></div>
                  <p className="small muted" style={{ padding: '8px 16px' }}>{a.impact.companyProfitInvariant === true ? '公司利潤在各方法下相同，方法只改變商品之間的分法。' : ''}{a.impact.note}</p>
                </Card>
                <Card title="風險提示（重複分攤・未分攤・跨期）" testid="alloc-risks">
                  {a.impact.risks.length ? <ul className="small">{a.impact.risks.map((r, idx) => <li key={idx}><Badge tone={r.level === 'REVIEW' ? 'warn' : 'info'}>{{ DOUBLE_ALLOCATION: '重複分攤', UNALLOCATED: '未分攤', CROSS_PERIOD: '跨期' }[r.code]}</Badge> {r.message}</li>)}</ul> : <p className="small muted">目前沒有偵測到風險。</p>}
                </Card>
              </>) : null}
          </>)}
      </>);
  }
  return (
    <>
      <PageHeader title="財務口徑核對（唯讀）" sub="合約、商業可行性與財務結算的分潤口徑差異；費用歸屬對照；多商品成本分攤提案。只讀取與比較，不修改任何資料或結算" testid="recon-header" />
      <Tabs tabs={TABS} current={tab} base="/finance/reconciliation" />
      {body}
    </>
  );
});
