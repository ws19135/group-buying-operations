import Link from 'next/link';
import { withActor, type Params } from '@/server/ui/session';
import { can } from '@/server/lib/permissions';
import { getTrial } from '@/server/modules/trials';
import { listAssignableUsers } from '@/server/ui/lookups';
import { ActionButton } from '@/ui/ActionButton';
import { ApiForm } from '@/ui/ApiForm';
import { Modal } from '@/ui/Modal';
import { Badge, Banner, Card, EmptyState, Kv, PageHeader, StatusBadge, Table } from '@/ui/components';
import { CONCLUSION, EVAL_REVIEW, RECOVERY, TASK_STATUS, TRIAL_LEVEL, TRIAL_STATUS, TRIAL_TYPE } from '@/ui/labels';
import { fmtDateTime, plain } from '@/ui/format';
import { EvidenceBox } from '@/ui/selection/EvidenceBox';
import { TrialChecks } from '@/ui/selection/TrialChecks';
import { as } from '@/ui/types';
import type { TrialView } from '@/server/modules/trials';

export const dynamic = 'force-dynamic';
const ACTION_LABEL: Record<string, string> = { 'selection.trial.create': '建立試用', 'selection.trial.update': '更新物流／日期／回收', 'selection.trial.check': '更新檢核項', 'selection.trial.conclude': '下結論', 'selection.trial.review': '覆核', 'selection.trial.cancel': '取消' };

export default withActor(async (actor, props: { params: Params }) => {
  const { id } = await props.params;
  const t = as<TrialView>(await getTrial(actor, id));
  const write = can(actor, 'selection.write');
  const reviewer = can(actor, 'product.review');
  const open = t.status === 'OPEN';
  const owners = write ? await listAssignableUsers(actor).catch(() => []) : [];
  const ep = `/api/trials/${t.id}`;
  const sug = t.suggestion;
  return (
    <>
      <PageHeader title={<>{TRIAL_LEVEL[t.level]}・{TRIAL_TYPE[t.trialType]} <StatusBadge map={TRIAL_STATUS} value={t.status} testid="trial-status" />{t.conclusion ? <> <StatusBadge map={CONCLUSION} value={t.conclusion} testid="trial-conclusion" /></> : null}</>} testid="trial-header"
        sub={<><Link href={`/products/${t.productId}`}>{t.productName}</Link>・{t.id}{t.campaignId ? <>・檔期 <Link href={`/campaigns/${t.campaignId}?tab=selection`}>{t.campaignTitle}</Link></> : null}</>}
        actions={<div className="btn-row">
          {write && open ? <ActionButton endpoint={`${ep}/cancel`} label="取消試用" variant="danger" reasonLabel="取消原因" testid="btn-trial-cancel" /> : null}
          {reviewer && t.status === 'CONCLUDED' ? <ActionButton endpoint={`${ep}/review`} body={{ decision: 'ACCEPTED' }} label="覆核：接受" variant="primary" reasonLabel="覆核意見（選填）" reasonKey="note" reasonRequired={false} testid="btn-trial-accept" /> : null}
          {reviewer && t.status === 'CONCLUDED' ? <ActionButton endpoint={`${ep}/review`} body={{ decision: 'REJECTED' }} label="覆核：不接受" variant="danger" reasonLabel="不接受的原因" reasonKey="note" testid="btn-trial-reject" /> : null}
        </div>} />
      <Banner kind="nodata">試用紀錄只存「資料」：日期、物流、回收、四面向檢核、結論與覆核。<strong>寄樣、到貨、回饋與 G1 等任務仍在任務頁處理</strong>，這裡不會自動完成任務；任務的證據欄位可貼這一頁的連結。</Banner>
      {t.status === 'CANCELLED' ? <Banner kind="warn">已取消：{t.cancelReason}</Banner> : null}
      {t.qualification && t.level === 'QUALIFICATION' ? <Banner kind={t.qualification.valid ? 'ok' : 'warn'} testid="trial-qual-banner">此商品最近一次資格試用：{t.qualification.conclusion ? CONCLUSION[t.qualification.conclusion]?.label : '—'}・{t.qualification.valid ? `仍有效，至 ${t.qualification.validUntil}（團主適配試用可沿用）` : `不可沿用：${t.qualification.reasons.join('；')}`}</Banner> : null}
      {t.linkedQualification ? <Banner kind="ok" testid="trial-reuse">已沿用商品資格試用 <Link href={`/trials/${t.linkedQualification.id}`}>{t.linkedQualification.id}</Link>（{CONCLUSION[t.linkedQualification.conclusion]?.label}，有效至 {t.linkedQualification.validUntil}）：本次只需補客戶、內容、商業三個面向。</Banner> : null}
      <div className="grid cols-2">
        <Card title="試用資料" testid="trial-info" actions={write && t.status !== 'CANCELLED' ? <Modal label="編輯物流／日期／回收" title="編輯" size="btn sm" testid="btn-trial-edit">
          <ApiForm endpoint={ep} method="PATCH" extra={{ version: t.version }} submitLabel="儲存" testid="trial-edit-form" fields={[
            { name: 'testerUserId', label: '試用人（內部）', type: 'select', defaultValue: t.testerUserId, options: owners },
            { name: 'testerNote', label: '試用人備註', defaultValue: t.testerNote },
            { name: 'shipDate', label: '寄樣日', type: 'date', defaultValue: t.shipDate, half: true }, { name: 'arrivalDate', label: '到貨日', type: 'date', defaultValue: t.arrivalDate, half: true },
            { name: 'startDate', label: '開始試用日', type: 'date', defaultValue: t.startDate, half: true }, { name: 'feedbackDate', label: '回饋日', type: 'date', defaultValue: t.feedbackDate, half: true },
            { name: 'closedDate', label: '結案日', type: 'date', defaultValue: t.closedDate, half: true },
            { name: 'carrier', label: '物流商', defaultValue: t.carrier, half: true }, { name: 'trackingNo', label: '追蹤碼', defaultValue: t.trackingNo, half: true },
            { name: 'recoveryRequired', label: '試用品需回收', type: 'checkbox', defaultValue: t.recoveryRequired },
            { name: 'recoveryStatus', label: '回收狀態', type: 'select', defaultValue: t.recoveryStatus, options: Object.entries(RECOVERY).map(([value, l]) => ({ value, label: l.label })) },
            { name: 'recoveryDate', label: '回收日期', type: 'date', defaultValue: t.recoveryDate }, { name: 'recoveryNote', label: '回收備註', defaultValue: t.recoveryNote }]} />
        </Modal> : undefined}>
          <Kv rows={[
            ['商品', <Link key="p" href={`/products/${t.productId}`}>{t.productName}</Link>], ['規格', t.skuName], ['廠商', <Link key="v" href={`/vendors/${t.vendorId}`}>{t.vendorName}</Link>],
            ['團主', t.hostId ? <Link key="h" href={`/hosts/${t.hostId}`}>{t.hostName}</Link> : '—'], ['檔期', t.campaignId ? <Link key="c" href={`/campaigns/${t.campaignId}`}>{t.campaignTitle}</Link> : '—'],
            ['試用人', t.testerName], ['寄樣日', t.shipDate], ['到貨日', t.arrivalDate], ['開始試用', t.startDate], ['回饋日', t.feedbackDate], ['結案日', t.closedDate],
            ['物流', [t.carrier, t.trackingNo].filter(Boolean).join('・') || '—'], ['試用品回收', <StatusBadge key="r" map={RECOVERY} value={t.recoveryStatus} />],
          ]} />
        </Card>
        <Card title="結論" testid="trial-conclusion-card">
          <p className="small" data-testid="trial-suggestion">系統建議：<StatusBadge map={CONCLUSION} value={sug.conclusion} />&emsp;{sug.reasons.join('、')}</p>
          {t.status === 'CONCLUDED' ? (
            <>
              <Kv rows={[['最終建議', <StatusBadge key="c" map={CONCLUSION} value={t.conclusion} />], ['說明', t.conclusionNote], ['覆寫原因', t.overrideReason], ['下結論', `${t.concludedByName ?? ''} ${fmtDateTime(t.concludedAt)}`],
                ['有效期限', t.validUntil ?? '—（不通過／需重測沒有有效期）'], ['覆核', t.reviewDecision ? <span key="d"><StatusBadge map={EVAL_REVIEW} value={t.reviewDecision} /> {t.reviewedByName} {t.reviewNote}</span> : <Badge>待覆核</Badge>]]} />
            </>
          ) : open && write ? (
            <>
              <p className="small muted">最終建議不得比系統建議更樂觀；若要更樂觀，需由具審核權限者填寫覆寫原因。通過／有條件通過會記錄有效期限（預設 {t.config.trialValidDays} 天）與商品指紋，商品資料變更後資格自動失效。</p>
              <ApiForm endpoint={`${ep}/conclude`} submitLabel="下結論" testid="trial-conclude-form" fields={[
                { name: 'conclusion', label: '最終建議', type: 'select', required: true, defaultValue: sug.conclusion, options: Object.entries(CONCLUSION).map(([value, l]) => ({ value, label: l.label })) },
                { name: 'note', label: '結論說明', type: 'textarea', required: true },
                ...(reviewer ? [{ name: 'overrideReason', label: '覆寫原因（比系統建議樂觀時必填）', type: 'textarea' as const }] : []),
                { name: 'validUntil', label: '有效期限（選填，不得超過上限）', type: 'date' }]} />
            </>
          ) : <p className="muted">{open ? '只有營運人員可以下結論。' : '—'}</p>}
        </Card>
      </div>
      <Card title="四大面向檢核" testid="trial-checks-card">
        <TrialChecks trialId={t.id} editable={write && open} canCost={t.permissions.cost} checks={plain(t.checks) as never} />
      </Card>
      <Card title="試用整體證據連結" testid="trial-evidence">
        <EvidenceBox subjectType="TRIAL" subjectId={t.id} items={t.evidence as never} canEdit={write && open} testid="trial-evidence-box" />
      </Card>
      {t.campaignId ? (
        <Card title="本檔相關任務（唯讀；請到任務頁處理）" flush testid="trial-tasks">
          {t.tasks.length === 0 ? <EmptyState title="沒有相關任務" /> : (
            <Table head={['步驟', '狀態', '預定完成', '證據連結']}>{t.tasks.map((k) => <tr key={k.id}><td><Link href={`/campaigns/${t.campaignId}?tab=tasks`}>{k.name}</Link></td><td><StatusBadge map={TASK_STATUS} value={k.status} /></td><td>{k.plannedEnd ?? '—'}</td><td>{k.evidenceUrl ? <a href={k.evidenceUrl} target="_blank" rel="noreferrer noopener">連結</a> : '—'}</td></tr>)}</Table>)}
        </Card>
      ) : null}
      <Card title="異動歷史" flush testid="trial-history">
        {t.history.length === 0 ? <EmptyState title="尚無紀錄" /> : (
          <Table head={['時間', '人員', '動作', '內容']}>{t.history.map((h) => (
            <tr key={String(h.id)}><td className="small nowrap">{fmtDateTime(h.occurredAt as string)}</td><td className="small">{String(h.actorName ?? '')}</td><td className="small">{ACTION_LABEL[String(h.action)] ?? String(h.action)}</td>
              <td className="small muted">{h.afterData ? JSON.stringify(h.afterData).slice(0, 160) : ''}</td></tr>))}</Table>)}
      </Card>
    </>
  );
});
