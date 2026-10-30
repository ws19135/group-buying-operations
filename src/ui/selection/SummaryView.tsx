import Link from 'next/link';
import type { g1Summary } from '@/server/modules/decision-summary';
import { Badge, Banner, Card, EmptyState, StatusBadge } from '../components';
import { COMPLIANCE, CONCLUSION, DD_RECORD_STATUS, EVAL_REVIEW, LIGHT, RISK_LEVEL, SEL_REC, TRIAL_LEVEL, TRIAL_STATUS, RECOMMENDATION } from '../labels';
import { money } from '../format';

type Summary = Awaited<ReturnType<typeof g1Summary>>;
type Prod = Summary['products'][number];

const AREA: Record<string, string> = { PRODUCT: '商品審核', EVALUATION: '選品評估', DILIGENCE: '合作資格審查', TRIAL: '試用', FEASIBILITY: '商業可行性' };
const icon = (l: string) => (l === 'RED' ? '🔴' : l === 'YELLOW' ? '🟡' : '🟢');

function ProductBlock({ p }: { p: Prod }) {
  const fz = p.feasibility;
  const res = (fz?.results ?? {}) as Record<string, number | null>;
  return (
    <Card testid={`g1s-product-${p.productId}`} title={<>{icon(p.light)} <Link href={`/products/${p.productId}`}>{p.productName}</Link> <StatusBadge map={LIGHT} value={p.light} /></>}>
      <p className="small muted">廠商：<Link href={`/vendors/${p.vendorId}`}>{p.vendorName}</Link>・商品審核：{p.reviewStatus}</p>
      <div className="grid cols-2">
        <div data-testid={`g1s-eval-${p.productId}`}>
          <h4>選品評估</h4>
          {p.evaluation ? (
            <div className="small">
              <strong style={{ fontSize: 20 }}>{p.evaluation.totalScore ?? '—'}</strong> 分 <StatusBadge map={SEL_REC} value={p.evaluation.recommendation} />{' '}
              <StatusBadge map={COMPLIANCE} value={p.evaluation.compliance?.status} />
              <div className="muted">v{p.evaluation.versionNo}・完整度 {p.evaluation.completeness == null ? '—' : Math.round(Number(p.evaluation.completeness) * 100)}%・{p.evaluation.evaluatedOn ?? ''}・{p.evaluation.evaluatorName ?? ''}</div>
              <div>覆核：{p.evaluation.reviewDecision ? <StatusBadge map={EVAL_REVIEW} value={p.evaluation.reviewDecision} /> : <Badge>待覆核</Badge>}</div>
            </div>) : <span className="unknown">尚無已送出的評估</span>}
        </div>
        <div data-testid={`g1s-dd-${p.productId}`}>
          <h4>廠商合作資格審查</h4>
          {p.diligence ? (
            <div className="small">
              <Link href={`/diligence/${p.diligence.id}`}>合約版本 {p.diligence.contractVersion}</Link>（{p.diligence.scope === 'PRODUCT' ? '此商品' : '整個廠商'}）{' '}
              <StatusBadge map={DD_RECORD_STATUS} value={p.diligence.status} />
              {p.diligence.status === 'APPROVED' ? <div className={p.diligence.validity.valid ? 'muted' : ''} style={p.diligence.validity.valid ? undefined : { color: 'var(--danger)' }}>
                {p.diligence.validity.valid ? `有效至 ${p.diligence.validUntil}` : `已失效：${p.diligence.validity.reasons.join('；')}`}</div> : null}
              <div className="muted">待補件 {p.diligence.readiness.counts.PENDING_DOCS ?? 0}・有風險 {p.diligence.readiness.risks}・過期證據 {p.diligence.readiness.expired}・法務未結 {p.diligence.readiness.legalPending}</div>
            </div>) : <span className="unknown">尚無合作資格審查</span>}
        </div>
        <div data-testid={`g1s-trial-${p.productId}`}>
          <h4>試用</h4>
          <div className="small">
            商品資格：{p.qualification ? <><StatusBadge map={CONCLUSION} value={p.qualification.conclusion} /> {p.qualification.valid ? <Badge tone="ok">仍有效（至 {p.qualification.validUntil}）</Badge> : <Badge tone="warn">已失效：{p.qualification.reasons.join('；')}</Badge>}</> : <span className="unknown">尚未做</span>}
            {p.trials.length ? <ul className="list-plain">{p.trials.map((t) => (
              <li key={t.id}><Link href={`/trials/${t.id}`}>{TRIAL_LEVEL[t.level]}</Link> <StatusBadge map={TRIAL_STATUS} value={t.status} /> {t.conclusion ? <StatusBadge map={CONCLUSION} value={t.conclusion} /> : null}</li>))}</ul> : <div className="muted">本檔尚無試用</div>}
          </div>
        </div>
        <div data-testid={`g1s-fz-${p.productId}`}>
          <h4>商業可行性（試算）</h4>
          {fz ? (
            <div className="small">
              <Link href={`/feasibility/${fz.id}`}>v{fz.versionNo}{fz.label ? `・${fz.label}` : ''}</Link>（{fz.scope === 'CAMPAIGN' ? '本檔' : '商品層級'}）{fz.hasActuals ? <Badge tone="info">已有小團實際</Badge> : null}
              <div>GMV（成交總額）{money(res.gmv)}・NSV（有效淨銷售額）{money(res.nsv)}</div>
              {fz.restricted ? <div className="muted">利潤與成本：無權限查看</div> : <div>品牌利潤 {res.brandProfit == null ? <span className="unknown">未知</span> : money(res.brandProfit)}・公司營業收入 {res.companyRevenue == null ? <span className="unknown">未知</span> : money(res.companyRevenue)}・公司貢獻 {res.companyContribution == null ? <span className="unknown">未知</span> : money(res.companyContribution)}</div>}
            </div>) : <span className="unknown">尚無試算</span>}
        </div>
      </div>
      {p.fit ? <p className="small muted" data-testid={`g1s-fit-${p.productId}`}>客群適配（標準作業流程 SOP 01，唯讀）：{Object.keys(p.fit).length ? Object.entries(p.fit as Record<string, { hosts: number; topScore: number | null }>).map(([k, v]) => `${RECOMMENDATION[k]?.label ?? k} ${v.hosts} 位`).join('、') : '本檔尚未評估'}</p> : null}
      <h4>風險與缺口</h4>
      {p.risks.length === 0 ? <div className="small" data-testid={`g1s-risks-${p.productId}`}>🟢 沒有已知缺口</div> : (
        <ul className="list-plain" data-testid={`g1s-risks-${p.productId}`}>{p.risks.map((r) => <li key={r.message}><StatusBadge map={RISK_LEVEL} value={r.level} /> <span className="small muted">{AREA[r.area]}</span>&emsp;{r.message}</li>)}</ul>
      )}
    </Card>
  );
}

/** G1（選品核准）統一決策摘要（唯讀）：評估、合作資格審查、試用、可行性、風險與證據一頁看完。不改變 G1（選品核准）的檢查項與核准結果。 */
export function SummaryView({ s }: { s: Summary }) {
  return (
    <div data-testid="g1-summary">
      <Banner kind={s.light === 'RED' ? 'error' : s.light === 'YELLOW' ? 'warn' : 'ok'} testid="g1s-banner">
        {icon(s.light)} <strong>{s.lightLabel}</strong>：{s.counts.products} 個商品，{s.counts.blocking} 項阻礙、{s.counts.gaps} 項缺口。{s.note}
        評分設定：{s.config.status}（v{s.config.version}）。
      </Banner>
      {s.products.length === 0 ? <EmptyState title="這檔還沒有商品" hint="加入商品後，這裡會彙整每個商品的評估、審查、試用與可行性。" /> : s.products.map((p) => <ProductBlock key={p.productId} p={p} />)}
    </div>
  );
}

/** G1（選品核准）核准區的簡短提示（連到完整摘要）；不影響申請與核准 */
export function SummaryNote({ s, campaignId }: { s: Summary; campaignId: string }) {
  return (
    <Banner kind={s.light === 'RED' ? 'error' : s.light === 'YELLOW' ? 'warn' : 'ok'} testid="g1-selection-note">
      <strong>選品與試用決策摘要（查閱用，不影響核准）：</strong>{icon(s.light)} {s.lightLabel}・{s.counts.blocking} 項阻礙、{s.counts.gaps} 項缺口。{' '}
      <Link href={`/campaigns/${campaignId}?tab=selection`} data-testid="link-g1-selection">查看完整摘要 →</Link>
    </Banner>
  );
}
