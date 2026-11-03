import Link from 'next/link';
import { withActor, sp1, type SP } from '@/server/ui/session';
import { selectionOverview } from '@/server/modules/selection';
import { Badge, Banner, Card, EmptyState, PageHeader, StatusBadge, Table, Tabs } from '@/ui/components';
import { SelectionConfigForm } from '@/ui/selection/SelectionConfigForm';
import { SelectionV2ConfigForm } from '@/ui/selection/SelectionV2ConfigForm';
import { getV2Config } from '@/server/modules/selection-v2';
import type { CondDefV } from '@/ui/selection/V2ResultView';
import { CONCLUSION, EVID_KIND, EVID_STATE, SEL_DIM, SEL_REC, TRIAL_LEVEL, TRIAL_TYPE } from '@/ui/labels';
import { fmtDateTime } from '@/ui/format';
import { as } from '@/ui/types';

export const dynamic = 'force-dynamic';

interface Overview {
  config: { version: number; approved: boolean; status: string; weights: Record<string, number>; thresholds: { proceed: number; supplement: number; minCompleteness: number; highConfidence: number; mediumConfidence: number }; ddValidDays: number; trialValidDays: number; expiringSoonDays: number; evidenceHosts: string[] };
  pendingEvaluations: { id: string; productId: string; productName: string; versionNo: number; totalScore: number | null; recommendation: string; submittedAt: string }[];
  ddInReview: { id: string; vendorId: string; vendorName: string; productId: string | null; contractVersion: string; submittedAt: string }[];
  trialsToReview: { id: string; productId: string; productName: string; level: string; trialType: string; conclusion: string | null; concludedAt: string; campaignId: string | null }[];
  recoveryPending: number;
  expiringEvidence: { id: string; subjectType: string; subjectId: string; kind: string; title: string; validUntil: string; state: string; vendorId: string | null; productId: string | null }[];
  canReview: boolean; canConfig: boolean;
}

export default withActor(async (actor, props: { searchParams: SP }) => {
  const q = await sp1(props.searchParams);
  const tab = q.tab ?? 'todo';
  const o = as<Overview>(await selectionOverview(actor));
  const c = o.config;
  return (
    <>
      <PageHeader title="選品與試用" sub="標準作業流程（SOP）02 商品選品與廠商開發・03 商品試用與商業可行性，供 G1 選品核准查閱" testid="selection-header" />
      <Banner kind={c.approved ? 'ok' : 'warn'} testid="selection-config-banner">
        選品評分設定 v{c.version}：<strong>{c.status}</strong>。權重 {Object.entries(c.weights).map(([k, v]) => `${SEL_DIM[k]} ${v}%`).join('、')}；
        ≥ {c.thresholds.proceed} 分建議進入商務審查、≥ {c.thresholds.supplement} 分補測／補件；合作資格審查有效 {c.ddValidDays} 天、商品資格試用有效 {c.trialValidDays} 天。
        分數與評估只是決策建議，<strong>不會</strong>自動核准商品或 G1（選品核准）。
      </Banner>
      <Tabs tabs={[{ key: 'todo', label: '待辦與提醒' }, { key: 'config', label: '評分與有效期設定（V1）' }, { key: 'config2', label: '選品 V2 設定' }]} current={tab} base="/selection" />
      {tab === 'config2' ? await (async () => {
        const v = await getV2Config(actor);
        const cat = v.conditions as unknown as CondDefV[];
        return (
          <Card title="選品評分 V2 設定" testid="selection-v2-config">
            <Banner kind={v.approved ? 'ok' : 'warn'} testid="v2-config-banner">設定 v{v.version}：<strong>{v.status}</strong>・V2 {v.enabled ? '啟用中' : '已停用（新評估改建 V1）'}。權重、門檻與子條件全部是提案，<strong>未經 Owner 核准不是公司正式制度</strong>；分數只是決策建議，不會自動核准商品或 G1（選品核准）。</Banner>
            {o.canConfig ? <SelectionV2ConfigForm cfg={{ version: v.version, approved: v.approved, enabled: v.enabled, dimWeights: v.dimWeights, condWeights: v.condWeights, thresholds: v.thresholds, modelThresholds: v.modelThresholds, proceed: v.proceed, supplement: v.supplement, minCompleteness: v.minCompleteness, mediumConfidence: v.mediumConfidence, highConfidence: v.highConfidence, mediumEvidence: v.mediumEvidence, highEvidence: v.highEvidence, naShareMax: v.naShareMax, minSample: v.minSample }} /> : <p className="muted">只有系統管理者與營運主管可以調整設定；下方是目前的子條件目錄（唯讀）。</p>}
            <h4>子條件目錄（{cat.length} 個，唯讀；完整規格見 docs/phase2/SELECTION_V2.md）</h4>
            <div className="table-wrap"><table data-testid="v2-catalog">
              <thead><tr><th>維度</th><th>子條件</th><th>來源</th><th>證據</th><th>維度內權重</th><th>標記</th></tr></thead>
              <tbody>{cat.map((c) => (
                <tr key={c.id} data-testid={`v2-cat-${c.id}`}><td className="small">{SEL_DIM[c.dim]}</td><td><strong>{c.label}</strong><div className="small muted">{c.id}・{c.basis}</div></td>
                  <td className="small">{c.source === 'AUTO' ? '系統自動' : c.source === 'MANUAL' ? '人工' : '自動優先、可手填'}</td>
                  <td className="small">{c.evidence === 'REQUIRED' ? '必要' : c.evidence === 'RECOMMENDED' ? '建議' : '—'}</td>
                  <td className="small">{(v.condWeights as Record<string, number>)[c.id] ?? c.weight}</td>
                  <td className="small">{c.hard ? '硬性　' : ''}{c.sensitive ? '敏感（成本權限）　' : ''}{c.naRule ? '可不適用（有條件）' : ''}</td></tr>))}</tbody>
            </table></div>
          </Card>
        );
      })() : tab === 'config' ? (
        <Card title="評分與有效期設定" testid="selection-config">
          <p className="small muted">這些數字是<strong>建議值，待 Owner 確認</strong>，不是正式核准規則。儲存會產生新版本並寫入稽核；已送出的評估保留當時的設定快照，不會被追溯修改。安全與合規是獨立的必要查核，不受權重影響。</p>
          {o.canConfig ? <SelectionConfigForm cfg={c} /> : <p className="muted">只有系統管理者與營運主管可以調整設定。</p>}
        </Card>
      ) : (
        <>
          <div className="grid cols-2">
            <Card title={`待覆核的選品評估（${o.pendingEvaluations.length}）`} flush testid="pending-evaluations">
              {o.pendingEvaluations.length === 0 ? <EmptyState title="沒有待覆核的評估" /> : (
                <Table head={['商品', '分數／建議', '送出']}>{o.pendingEvaluations.map((e) => (
                  <tr key={e.id}><td><Link href={`/products/${e.productId}`}>{e.productName}</Link><div className="small muted">v{e.versionNo}</div></td>
                    <td><strong>{e.totalScore ?? '—'}</strong> <StatusBadge map={SEL_REC} value={e.recommendation} /></td><td className="small">{fmtDateTime(e.submittedAt)}</td></tr>))}</Table>)}
            </Card>
            <Card title={`審查中的廠商合作資格審查（${o.ddInReview.length}）`} flush testid="pending-dd">
              {o.ddInReview.length === 0 ? <EmptyState title="沒有審查中的調查" /> : (
                <Table head={['廠商', '合約版本', '送審']}>{o.ddInReview.map((d) => (
                  <tr key={d.id}><td><Link href={`/diligence/${d.id}`}>{d.vendorName}</Link></td><td>{d.contractVersion}</td><td className="small">{fmtDateTime(d.submittedAt)}</td></tr>))}</Table>)}
            </Card>
          </div>
          <Card title={`待覆核的試用結論（${o.trialsToReview.length}）`} flush testid="pending-trials">
            {o.trialsToReview.length === 0 ? <EmptyState title="沒有待覆核的試用" /> : (
              <Table head={['商品', '層級／類型', '結論', '結論時間']}>{o.trialsToReview.map((t) => (
                <tr key={t.id}><td><Link href={`/trials/${t.id}`}>{t.productName}</Link></td><td>{TRIAL_LEVEL[t.level]}・{TRIAL_TYPE[t.trialType]}</td><td><StatusBadge map={CONCLUSION} value={t.conclusion} /></td><td className="small">{fmtDateTime(t.concludedAt)}</td></tr>))}</Table>)}
          </Card>
          <Card title={`即將到期或已過期的證據（${o.expiringEvidence.length}）`} flush testid="expiring-evidence">
            {o.expiringEvidence.length === 0 ? <EmptyState title="沒有即將到期的證據" hint={`${c.expiringSoonDays} 天內到期的證據會列在這裡`} /> : (
              <Table head={['證據', '種類', '到期日', '狀態', '']}>{o.expiringEvidence.map((e) => (
                <tr key={e.id}><td>{e.title}</td><td>{EVID_KIND[e.kind]}</td><td>{e.validUntil}</td><td><StatusBadge map={EVID_STATE} value={e.state} /></td>
                  <td>{e.subjectType === 'DD_ITEM' && e.vendorId ? <Link href={`/vendors/${e.vendorId}`}>廠商</Link> : e.productId ? <Link href={`/products/${e.productId}`}>商品</Link> : null}</td></tr>))}</Table>)}
          </Card>
          <p className="small muted">試用品待回收：<Badge tone={o.recoveryPending ? 'warn' : 'neutral'}>{o.recoveryPending}</Badge> 筆（逾期處理與責任待 Owner 決定，目前只記錄）。</p>
        </>
      )}
    </>
  );
});
