import Link from 'next/link';
import type { Actor } from '@/server/lib/permissions';
import { can } from '@/server/lib/permissions';
import { query } from '@/server/lib/db';
import { campaignScope } from '@/server/lib/scope';
import { NON_SENSITIVE_INPUT_KEYS, SENSITIVE_INPUT_KEYS } from '@/server/lib/feasibility-calc';
import { listProductEvaluations, type EvaluationView } from '@/server/modules/selection';
import { listProductTrials } from '@/server/modules/trials';
import { listProductFeasibility, type FeasibilityView } from '@/server/modules/feasibility';
import { hostOptions } from '@/server/ui/options';
import { ActionButton } from '@/ui/ActionButton';
import { ApiForm } from '@/ui/ApiForm';
import { Modal } from '@/ui/Modal';
import { Badge, Banner, Card, EmptyState, StatusBadge, Table } from '@/ui/components';
import { COMPLIANCE, CONCLUSION, CONFIDENCE, EVAL_REVIEW, RECOVERY, SEL_DIM, SEL_REC, TRIAL_LEVEL, TRIAL_STATUS, TRIAL_TYPE, RECOMMENDATION } from '@/ui/labels';
import { fmtDateTime, money } from '@/ui/format';
import { EvaluationEditor } from '@/ui/selection/EvaluationEditor';
import { EvidenceBox, type EvidenceV } from '@/ui/selection/EvidenceBox';
import { FeasibilityForm } from '@/ui/selection/FeasibilityForm';
import { as } from '@/ui/types';

const KEYS = ['need', 'quality', 'profit', 'supply', 'content', 'repeat'];
interface EvalList {
  productCategory: string | null; config: { version: number; approved: boolean; status: string; weights: Record<string, number>; thresholds: { proceed: number; supplement: number } };
  draft: EvaluationView | null; current: EvaluationView | null; versions: EvaluationView[]; fitReference: { byRecommendation: Record<string, { hosts: number; topScore: number | null }>; note: string } | null;
}

/** 商品詳情：通用選品評估（標準作業流程 SOP 02）。分數只是決策建議，不會自動核准商品或 G1；不含客群適配（那是 標準作業流程 SOP 01，這裡只唯讀引用）。 */
export async function EvaluationCard({ actor, productId }: { actor: Actor; productId: string }) {
  const d = as<EvalList>(await listProductEvaluations(actor, productId));
  const write = can(actor, 'selection.write');
  const reviewer = can(actor, 'product.review');
  const cur = d.current;
  const dr = d.draft;
  return (
    <Card title="選品評估（標準作業流程 SOP 02）" flush testid="product-evaluation" actions={write && !dr ? <ActionButton endpoint={`/api/products/${productId}/evaluations`} label={cur ? '重新評估（新版本）' : '開始評估'} variant="primary" small testid="btn-eval-new" successMessage="已建立評估草稿" /> : undefined}>
      <div style={{ padding: '10px 16px 0' }}>
        <p className="small muted">六項 1–5 分加權（{KEYS.map((k) => `${SEL_DIM[k]} ${d.config.weights[k]}%`).join('、')}）；≥ {d.config.thresholds.proceed} 分建議進入商務審查、≥ {d.config.thresholds.supplement} 分補測／補件。權重為{d.config.approved ? '已確認' : '「建議值，待 Owner 確認」'}（v{d.config.version}）。
          未評分的項目是「未知」，不會當 0 分；<strong>安全與合規是獨立的必要查核</strong>，不會被總分抵銷；<strong>分數不會自動核准商品或 G1（選品核准）</strong>。</p>
        {d.fitReference ? <p className="small muted" data-testid="eval-fit-ref">客群需求符合度的參考（標準作業流程 SOP 01 客群適配，唯讀）：{Object.keys(d.fitReference.byRecommendation).length ? Object.entries(d.fitReference.byRecommendation).map(([k, v]) => `${RECOMMENDATION[k]?.label ?? k} ${v.hosts} 位${v.topScore != null ? `（最高 ${v.topScore}）` : ''}`).join('、') : '尚無適配評估'}。請自行判斷後填寫分數與理由。</p> : null}
      </div>
      {dr ? (
        <div style={{ padding: '0 16px 16px' }} data-testid="eval-draft">
          <h3>草稿 v{dr.versionNo}</h3>
          {dr.preview ? <p className="small" data-testid="eval-preview">即時試算（用目前設定）：{dr.preview.totalScore ?? '—'} 分・完整度 {Math.round(dr.preview.completeness * 100)}%・<StatusBadge map={SEL_REC} value={dr.preview.recommendation} />；{dr.preview.reasons.join('；')}</p> : null}
          <EvaluationEditor evalId={dr.id} version={dr.version} scores={dr.scores as never} compliance={dr.compliance} evidence={dr.evidence as EvidenceV[]} weights={d.config.weights} />
          <h4>這份評估的證據連結（品質與供應需附有效證據）</h4>
          <EvidenceBox subjectType="EVALUATION" subjectId={dr.id} items={dr.evidence as EvidenceV[]} canEdit={write} testid="eval-evidence-box" />
        </div>
      ) : null}
      {cur ? (
        <div style={{ padding: '0 16px 16px' }} data-testid="eval-current">
          <h3>現行評估 v{cur.versionNo}</h3>
          <p>
            <span className="score-big" data-testid="eval-total">{cur.totalScore ?? '—'}</span>{' '}
            <StatusBadge map={SEL_REC} value={cur.recommendation} testid="eval-rec" />{' '}<StatusBadge map={COMPLIANCE} value={cur.compliance?.status} testid="eval-compliance-badge" />{' '}
            <StatusBadge map={CONFIDENCE} value={cur.confidence} /> <span className="small muted">完整度 {cur.completeness == null ? '—' : Math.round(Number(cur.completeness) * 100)}%・{cur.evaluatedOn}・{cur.evaluatorName}・設定 v{cur.configVersion}</span>
          </p>
          {cur.compliance?.note ? <p className="small">合規說明：{cur.compliance.note}</p> : null}
          {(cur.evidenceGaps ?? []).length ? <Banner kind="warn">缺證據：{(cur.evidenceGaps ?? []).map((k) => SEL_DIM[k]).join('、')}（品質與供應評分需附有效證據，才可能建議進入商務審查）</Banner> : null}
          <Table head={['項目', '分數', '理由', '證據']} testid="eval-scores">{KEYS.map((k) => {
            const s = cur.scores?.[k] as { score: number | null; reason: string | null; evidenceCount?: number } | undefined;
            return <tr key={k}><td>{SEL_DIM[k]}</td><td>{s?.score ?? <span className="unknown">未評（未知）</span>}</td><td className="small">{s?.reason ?? '—'}</td><td className="small">{s?.score != null ? `${s.evidenceCount ?? 0} 筆有效` : '—'}</td></tr>;
          })}</Table>
          <p data-testid="eval-review-line">覆核：{cur.reviewDecision ? <><StatusBadge map={EVAL_REVIEW} value={cur.reviewDecision} /> <span className="small muted">{cur.reviewedByName} {cur.reviewNote}</span></> : <Badge>待覆核</Badge>}
            {reviewer ? <> <Modal label={cur.reviewDecision ? '重新覆核' : '覆核'} title="覆核選品評估" size="btn sm" testid="btn-eval-review">
              <p className="small muted">系統建議：{SEL_REC[cur.recommendation ?? '']?.label}。覆核只記錄你的判斷，<strong>不會</strong>改變商品審核狀態，也不會核准 G1（選品核准）。</p>
              <ApiForm endpoint={`/api/evaluations/${cur.id}/review`} submitLabel="送出覆核" testid="eval-review-form" fields={[
                { name: 'decision', label: '覆核結果', type: 'select', required: true, defaultValue: cur.reviewDecision ?? 'ACCEPTED', options: Object.entries(EVAL_REVIEW).map(([value, l]) => ({ value, label: l.label })) },
                { name: 'note', label: '意見（不採用或需補資料時必填）', type: 'textarea' }]} /></Modal></> : null}</p>
          <details><summary className="small">這份評估的證據連結（{cur.evidence.length}）</summary><EvidenceBox subjectType="EVALUATION" subjectId={cur.id} items={cur.evidence as EvidenceV[]} canEdit={false} testid="eval-evidence-readonly" /></details>
        </div>
      ) : !dr ? <EmptyState title="尚無已送出的評估" hint={write ? '按「開始評估」，為六項打分並填寫理由與證據。' : undefined} /> : null}
      {d.versions.filter((v) => v.status === 'SUBMITTED').length > 1 ? (
        <Table head={['版本', '分數', '建議', '評估日', '覆核', '狀態']} testid="eval-history">{d.versions.filter((v) => v.status === 'SUBMITTED').map((v) => (
          <tr key={v.id}><td>v{v.versionNo}</td><td>{v.totalScore ?? '—'}</td><td><StatusBadge map={SEL_REC} value={v.recommendation} /></td><td>{v.evaluatedOn}</td><td>{v.reviewDecision ? <StatusBadge map={EVAL_REVIEW} value={v.reviewDecision} /> : '—'}</td><td>{v.current ? <Badge tone="ok">現行</Badge> : <Badge>已被取代</Badge>}</td></tr>))}</Table>
      ) : null}
    </Card>
  );
}

interface TrialRowV { id: string; level: string; trialType: string; status: string; hostName: string | null; campaignTitle: string | null; conclusion: string | null; reviewDecision: string | null; validUntil: string | null; recoveryStatus: string; checkTested: number; checkTotal: number; createdAt: string }

async function productCampaigns(actor: Actor, productId: string) {
  const sc = campaignScope(actor, 3, 'c');
  if (sc.sql === 'FALSE') return [];
  const rows = await query<{ id: string; title: string }>(`SELECT DISTINCT c.id, c.title FROM campaigns c JOIN campaign_products cp ON cp.campaign_id=c.id AND cp.deleted_at IS NULL WHERE cp.organization_id=$1 AND cp.product_id=$2 AND (${sc.sql}) AND c.status NOT IN ('CANCELLED') ORDER BY c.id DESC LIMIT 50`, [actor.orgId, productId, ...sc.params]);
  return rows.map((r) => ({ value: r.id, label: `${r.title}（${r.id}）` }));
}

/** 商品詳情：試用（標準作業流程 SOP 03）。商品資格驗證與團主／檔期適配試用；同一商品可有多次試用，進行中的相同組合不可重複 */
export async function TrialCard({ actor, productId }: { actor: Actor; productId: string }) {
  const d = as<{ items: TrialRowV[]; qualification: { trialId: string; conclusion: string | null; validUntil: string | null; valid: boolean; reasons: string[] } | null; config: { trialValidDays: number } }>(await listProductTrials(actor, productId));
  const write = can(actor, 'selection.write');
  const hosts = write ? await hostOptions(actor) : [];
  const camps = write ? await productCampaigns(actor, productId) : [];
  const q = d.qualification;
  return (
    <Card title="商品試用（標準作業流程 SOP 03）" flush testid="product-trials" actions={write ? <Modal label="＋ 新增試用" title="新增試用" size="btn sm" variant="primary" testid="btn-trial-new">
      <p className="small muted">商品資格驗證：這個商品本身能不能賣。團主／檔期適配試用：這位團主、這個檔期適不適合；若商品資格仍有效會自動沿用，只補客戶、內容、商業三個面向。寄樣與回饋任務仍在任務頁處理。</p>
      <ApiForm endpoint={`/api/products/${productId}/trials`} submitLabel="建立" idempotent redirectTo="/trials/{id}" testid="trial-new-form" fields={[
        { name: 'level', label: '層級', type: 'select', required: true, defaultValue: 'QUALIFICATION', options: Object.entries(TRIAL_LEVEL).map(([value, label]) => ({ value, label })) },
        { name: 'trialType', label: '類型', type: 'select', required: true, defaultValue: 'INTERNAL', options: Object.entries(TRIAL_TYPE).map(([value, label]) => ({ value, label })), help: '團主／檔期適配試用不能是內部試用；指定團主要選團主；小規模測試團要選檔期' },
        { name: 'hostId', label: '團主（指定團主試用必填）', type: 'select', options: hosts }, { name: 'campaignId', label: '檔期（小規模測試團必填）', type: 'select', options: camps },
        { name: 'shipDate', label: '寄樣日', type: 'date', half: true }, { name: 'carrier', label: '物流商', half: true }, { name: 'recoveryRequired', label: '試用品需回收', type: 'checkbox' }]} />
    </Modal> : undefined}>
      <div style={{ padding: '10px 16px' }}>
        <p data-testid="trial-qualification">商品資格：{q ? <><StatusBadge map={CONCLUSION} value={q.conclusion} /> {q.valid ? <Badge tone="ok">仍有效，至 {q.validUntil}（可沿用）</Badge> : <Badge tone="warn">不可沿用：{q.reasons.join('；')}</Badge>}</> : <span className="unknown">尚未做資格驗證</span>}
          <span className="small muted">&emsp;（通過且覆核接受後有效 {d.config.trialValidDays} 天；商品名稱、類別、規格或合規備註變更會自動失效）</span></p>
      </div>
      {d.items.length === 0 ? <EmptyState title="尚無試用" hint={write ? '按「新增試用」建立商品資格驗證或團主適配試用。' : undefined} /> : (
        <Table head={['試用', '層級／類型', '團主／檔期', '檢核進度', '結論', '覆核', '回收']} testid="trial-table">{d.items.map((t) => (
          <tr key={t.id} data-testid={`trial-row-${t.id}`}>
            <td><Link href={`/trials/${t.id}`}>{t.id}</Link><div><StatusBadge map={TRIAL_STATUS} value={t.status} /></div></td>
            <td>{TRIAL_LEVEL[t.level]}<div className="small muted">{TRIAL_TYPE[t.trialType]}</div></td>
            <td className="small">{t.hostName ?? '—'}<div className="muted">{t.campaignTitle ?? ''}</div></td>
            <td>{t.checkTested}/{t.checkTotal}</td>
            <td>{t.conclusion ? <StatusBadge map={CONCLUSION} value={t.conclusion} /> : '—'}{t.validUntil ? <div className="small muted">至 {t.validUntil}</div> : null}</td>
            <td>{t.reviewDecision ? <StatusBadge map={EVAL_REVIEW} value={t.reviewDecision} /> : t.status === 'CONCLUDED' ? <Badge>待覆核</Badge> : '—'}</td>
            <td><StatusBadge map={RECOVERY} value={t.recoveryStatus} /></td>
          </tr>))}</Table>
      )}
    </Card>
  );
}

/** 商品詳情：商業可行性試算。成本與分潤是敏感資料，沿用成本檢視權限 */
export async function FeasibilityCard({ actor, productId }: { actor: Actor; productId: string }) {
  const d = as<{ items: FeasibilityView[]; canSeeSensitive: boolean; reference: { skuCount: number; groupPriceMin: number | null; groupPriceMax: number | null; costMin: number | null; costMax: number | null; note: string }; basisNote: string }>(await listProductFeasibility(actor, productId));
  const write = can(actor, 'selection.write');
  const camps = write ? await productCampaigns(actor, productId) : [];
  const editableKeys = d.canSeeSensitive ? [...NON_SENSITIVE_INPUT_KEYS, ...SENSITIVE_INPUT_KEYS] : [...NON_SENSITIVE_INPUT_KEYS];
  const latest = d.items.find((i) => !i.campaignId && !i.hostId) ?? null;
  const r = d.reference;
  return (
    <Card title="商業可行性（標準作業流程 SOP 03）" flush testid="product-feasibility" actions={write ? <Modal label="＋ 新增試算" title="商業可行性試算" size="btn sm" variant="primary" testid="btn-fz-open">
      <p className="small muted">{d.basisNote}</p>
      <FeasibilityForm productId={productId} current={(latest?.inputs ?? {}) as Record<string, unknown>} editableKeys={editableKeys} sources={(latest?.sources ?? {}) as Record<string, { kind: string }>} campaignOptions={camps} />
    </Modal> : undefined}>
      <div style={{ padding: '10px 16px' }}>
        <p className="small muted">{d.basisNote}</p>
        <p className="small muted" data-testid="fz-reference">商品主檔參考：團購價 {money(r.groupPriceMin)}{r.groupPriceMax !== r.groupPriceMin ? ` ～ ${money(r.groupPriceMax)}` : ''}{d.canSeeSensitive ? `・成本 ${money(r.costMin)}${r.costMax !== r.costMin ? ` ～ ${money(r.costMax)}` : ''}` : '・成本：無權限查看'}（{r.note}）</p>
        {!d.canSeeSensitive ? <Banner kind="nodata">成本、費用、分潤與利潤屬敏感資料，您沒有成本檢視權限；可填寫預估訂單、團購價與退款率。</Banner> : null}
      </div>
      {d.items.length === 0 ? <EmptyState title="尚無試算" hint={write ? '按「新增試算」。每個數字都要註明假設來源；沒填的項目會顯示「未知」。' : undefined} /> : (
        <Table head={['版本', '範圍', 'GMV（成交總額）', 'NSV（有效淨銷售額）', '品牌利潤', '公司營業收入', '實際回寫']} testid="fz-table">{d.items.map((f) => {
          const res = f.results as Record<string, number | null>;
          const v = (x: number | null | undefined, restricted = false) => (x == null ? (restricted ? <span className="muted">無權限</span> : <span className="unknown">未知</span>) : money(x));
          return (
            <tr key={f.id} data-testid={`fz-row-${f.id}`}>
              <td><Link href={`/feasibility/${f.id}`}>v{f.versionNo}{f.label ? `・${f.label}` : ''}</Link><div className="small muted">{fmtDateTime(f.createdAt as string)}</div></td>
              <td className="small">{f.campaignId ? '檔期' : '商品'}{f.hostId ? '・團主' : ''}</td>
              <td className="num">{v(res.gmv)}</td><td className="num">{v(res.nsv)}</td>
              <td className="num">{v(res.brandProfit, f.restricted)}</td><td className="num">{v(res.companyRevenue, f.restricted)}</td>
              <td>{f.actuals ? <Badge tone="info">已回寫</Badge> : '—'}</td>
            </tr>);
        })}</Table>
      )}
    </Card>
  );
}
