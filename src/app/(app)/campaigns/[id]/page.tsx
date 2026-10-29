import Link from 'next/link';
import { withActor, sp1, type SP, type Params } from '@/server/ui/session';
import { getCampaign } from '@/server/modules/campaigns';
import { gateCheck } from '@/server/modules/gates';
import { listCampaignAudit } from '@/server/modules/audit-read';
import { can, GATE_APPROVER_ROLES, isInternal } from '@/server/lib/permissions';
import { GATE_REQUEST } from '@/server/workflow/state';
import { PHASES } from '@/server/workflow/template-default';
import { hostOptions, hostCommunityOptions, productSkuOptions } from '@/server/ui/options';
import { listAssignableUsers } from '@/server/ui/lookups';
import { ActionButton } from '@/ui/ActionButton';
import { ApiForm } from '@/ui/ApiForm';
import { Modal } from '@/ui/Modal';
import { Badge, Banner, Card, EmptyState, Kv, PageHeader, StatusBadge, Table, Tabs } from '@/ui/components';
import { APPROVAL_STATUS, CAMPAIGN_STATUS, HOST_PART, PLACEMENT_STATUS, PLACEMENT_TYPE, PLATFORM, REVIEW_STATUS, SEVERITY, STATUS_LABEL_MAP, TASK_STATUS, ownerRoleLabel, roleLabel } from '@/ui/labels';
import { fmtDateTime, money } from '@/ui/format';
import { as, type AuditV, type CampaignV, type CheckItemV } from '@/ui/types';
import { TaskActions } from './TaskActions';
import { RescheduleDialog } from './RescheduleDialog';
import { FitG1Note, FitTab } from './FitTab';
import { AddPlacementForm, AddProductForm } from './CampaignForms';

export const dynamic = 'force-dynamic';

const NEXT_HINT: Record<string, string> = {
  DRAFT: '補齊廠商、商品、日期與責任人後，進入「評估中」。',
  EVALUATING: '完成試用回饋後，申請 G1 選品核准。',
  PENDING_G1: '等待營運主管決定 G1 選品核准。',
  PREPARING: '完成圖文素材、商品審核、曝光安排後，申請 G2 開團核准。',
  PENDING_G2: '等待營運主管決定 G2 開團核准。',
  SCHEDULED: '到開團日會自動（或由主管手動）推進為「進行中」。',
  RUNNING: '監控銷售與催單；過結團日後推進為「待結單確認」。',
  PENDING_CLOSE_CHECK: '核對訂單後，申請 G3 結單確認。',
  FULFILLING: '完成出貨與請款後，推進為「待結算」。',
  PENDING_SETTLEMENT: '結算確認（G4）；佣金試算屬 Phase 2，目前以人工確認。',
  SETTLED: '申請 G5 結案核准。',
  CLOSED: '已結案，僅供檢視。', CANCELLED: '已取消，僅供檢視。', ON_HOLD: '暫緩中；恢復後回到暫緩前的狀態。',
};

export default withActor(async (actor, props: { params: Params; searchParams: SP }) => {
  const { id } = await props.params;
  const q = await sp1(props.searchParams);
  const tab = q.tab ?? 'overview';
  const c = as<CampaignV>(await getCampaign(actor, id));
  const internal = isInternal(actor);
  const canWrite = can(actor, 'campaign.write');
  const canTransition = can(actor, 'campaign.transition');
  const editableProducts = ['DRAFT', 'EVALUATING', 'PREPARING'].includes(c.status);
  const terminal = ['CLOSED', 'CANCELLED'].includes(c.status);
  const tabs = [
    { key: 'overview', label: '概覽' }, { key: 'tasks', label: `任務（${c.tasks.length}）` }, { key: 'products', label: '商品' },
    ...(internal || actor.role === 'HOST' ? [{ key: 'hosts', label: '團主與曝光' }] : []),
    ...(internal ? [{ key: 'approvals', label: '核准與關卡' }] : []),
    ...(internal && can(actor, 'fit.read') ? [{ key: 'fit', label: '客群適配' }] : []),
    ...(internal ? [{ key: 'audit', label: '異動紀錄' }] : []),
  ];
  const isManager = ['SYSTEM_ADMIN', 'OPS_MANAGER'].includes(actor.role);

  return (
    <>
      <PageHeader testid="campaign-header"
        title={<>{c.title} <StatusBadge map={CAMPAIGN_STATUS} value={c.status} testid="campaign-status" /></>}
        sub={<>{c.id}&emsp;廠商：<Link href={`/vendors/${c.vendorId}`}>{c.vendor.name}</Link>&emsp;期間：{c.openDate ?? '未定'} ～ {c.closeDate ?? '未定'}</>}
        actions={internal ? (
          <div className="btn-row">
            {canWrite && !terminal && c.status !== 'ON_HOLD' ? <RescheduleDialog campaignId={c.id} current={{ openDate: c.openDate, closeDate: c.closeDate, sampleReadyDate: c.sampleReadyDate, liveTalkDate: c.liveTalkDate, needsSampleRecovery: c.needsSampleRecovery }} params={c.workflowParams ?? {}} /> : null}
            {canTransition ? c.allowedTransitions.map((t) => (
              <ActionButton key={t.to} endpoint={`/api/campaigns/${c.id}/status`} body={{ action: 'transition', to: t.to }} label={`${t.backward ? '退回' : '推進'}：${STATUS_LABEL_MAP[t.to] ?? t.to}`} variant={t.backward ? '' : 'primary'}
                reasonLabel={t.backward ? '退回原因' : undefined} testid={`btn-transition-${t.to}`} />
            )) : null}
            {canTransition && c.status === 'ON_HOLD' ? <ActionButton endpoint={`/api/campaigns/${c.id}/status`} body={{ action: 'resume' }} label="恢復" variant="primary" reasonLabel="恢復原因" testid="btn-resume" /> : null}
            {canTransition && !terminal && c.status !== 'ON_HOLD' && !['SETTLED'].includes(c.status) ? <ActionButton endpoint={`/api/campaigns/${c.id}/status`} body={{ action: 'hold' }} label="暫緩" reasonLabel="暫緩原因" testid="btn-hold" /> : null}
            {canTransition && isManager && !terminal && !['FULFILLING', 'PENDING_SETTLEMENT', 'SETTLED'].includes(c.status) ? <ActionButton endpoint={`/api/campaigns/${c.id}/status`} body={{ action: 'cancel' }} label="取消檔期" variant="danger" reasonLabel="取消原因" confirm="取消後所有未完成任務、待核准申請與已排定曝光都會一併取消，且無法恢復。" testid="btn-cancel" /> : null}
          </div>
        ) : undefined} />
      <Banner kind={c.status === 'CANCELLED' ? 'error' : 'ok'} testid="next-step"><strong>下一步：</strong>{NEXT_HINT[c.status] ?? ''}{c.statusReason ? `（原因：${c.statusReason}）` : ''}</Banner>
      {internal ? (
        <p className="muted" data-testid="campaign-related-links">相關作業：<Link href={`/fulfillment?campaignId=${c.id}`}>履約出貨</Link>｜<Link href="/aftersales">售後案件</Link>｜<Link href="/finance">財務結算</Link></p>
      ) : null}
      <Tabs tabs={tabs} current={tab} base={`/campaigns/${id}`} />

      {tab === 'overview' ? (
        <div className="grid cols-2" data-testid="tab-overview">
          <Card title="基本資料">
            <Kv rows={[
              ['檔期編號', c.id], ['狀態', <StatusBadge key="s" map={CAMPAIGN_STATUS} value={c.status} />], ['說明', c.description],
              ['試用品可寄出日', c.sampleReadyDate], ['開團日', c.openDate], ['結團日', c.closeDate], ['Live Talk 日', c.liveTalkDate],
              ['回收試用品', c.needsSampleRecovery ? '是' : '否'],
              ...(internal ? [['流程模板版本', c.workflowTemplateVersion != null ? `v${c.workflowTemplateVersion}` : '—'] as [string, string]] : []),
              ...(c.targetRevenue !== undefined ? [['檔期目標（內部）', money(c.targetRevenue)] as [string, string]] : []),
              ...(internal ? [['內部備註', c.internalNote ?? '—'] as [string, string]] : []),
              ['建立時間', fmtDateTime(c.createdAt)], ['最後更新', fmtDateTime(c.updatedAt)],
            ]} />
          </Card>
          <div>
            {internal ? (
              <Card title="檔期衝突提醒" testid="conflicts">
                {c.conflicts && c.conflicts.length ? <ul className="list-plain">{c.conflicts.map((x) => <li key={x.message}><StatusBadge map={SEVERITY} value={x.severity} /> {x.message}{x.otherCampaignId ? <> <Link href={`/campaigns/${x.otherCampaignId}`}>查看</Link></> : null}</li>)}</ul> : <p className="muted">沒有偵測到衝突（需已設定開團／結團日）。</p>}
              </Card>
            ) : null}
            {internal ? (
              <Card title="未結例外" testid="exceptions">
                {c.exceptions && c.exceptions.length ? <ul className="list-plain">{c.exceptions.map((x) => <li key={x.id}><StatusBadge map={SEVERITY} value={x.severity} /> <strong>{x.title}</strong><div className="small muted">{x.detail}</div></li>)}</ul> : <p className="muted">沒有未結的例外。</p>}
              </Card>
            ) : null}
            <Card title="任務進度">
              <p>{c.tasks.filter((t) => t.status === 'DONE').length} / {c.tasks.filter((t) => !['SKIPPED', 'CANCELLED'].includes(t.status)).length} 已完成&emsp;<Badge tone={c.tasks.some((t) => t.overdue) ? 'danger' : 'ok'}>{c.tasks.filter((t) => t.overdue).length} 項逾期</Badge></p>
            </Card>
          </div>
        </div>
      ) : null}

      {tab === 'tasks' ? await TasksTab({ c, actor, internal }) : null}

      {tab === 'products' ? await ProductsTab({ c, actor, editable: editableProducts && canWrite }) : null}

      {tab === 'hosts' ? await HostsTab({ c, actor, internal, canWrite }) : null}

      {tab === 'approvals' && internal ? await ApprovalsTab({ c, actor }) : null}

      {tab === 'fit' && internal && can(actor, 'fit.read') ? await FitTab({ campaignId: id, actor }) : null}

      {tab === 'audit' && internal ? await AuditTab({ id, actor }) : null}
    </>
  );
});

type A = Parameters<typeof getCampaign>[0];

async function TasksTab({ c, actor, internal }: { c: CampaignV; actor: A; internal: boolean }) {
  const users = can(actor, 'task.write') ? await listAssignableUsers(actor) : [];
  const phases = [...new Set(c.tasks.map((t) => t.phase))].sort((a, b) => a - b);
  return (
    <div data-testid="tab-tasks">
      {c.tasks.length === 0 ? <EmptyState title="沒有任務" /> : phases.map((ph) => (
        <div className="phase" key={ph} data-testid={`phase-${ph}`}>
          <h3>階段 {ph}：{PHASES[ph]}</h3>
          <Table head={['任務', '負責角色／人', '預定期間', '狀態', '操作']}>
            {c.tasks.filter((t) => t.phase === ph).map((t) => {
              const canAct = can(actor, 'task.complete') && (can(actor, 'task.write') || actor.role === t.ownerRole);
              return (
                <tr key={t.id} data-testid={`task-row-${t.id}`}>
                  <td><strong>{t.name}</strong>{t.optional ? <span className="small muted"> （選擇性）</span> : null}
                    {t.scheduleIssue ? <div className="small" style={{ color: 'var(--danger)' }} data-testid={`task-issue-${t.id}`}>⚠ {t.scheduleIssue}</div> : null}
                    {t.blockerReason ? <div className="small" style={{ color: 'var(--danger)' }}>封鎖：{t.blockerReason}</div> : null}
                    {t.skipReason && t.status === 'SKIPPED' ? <div className="small muted">{t.skipReason}</div> : null}
                    {t.dateLocked ? <div className="small muted">🔒 日期已人工鎖定{t.dateLockReason ? `：${t.dateLockReason}` : ''}</div> : null}</td>
                  <td>{ownerRoleLabel(t.ownerRole)}<div className="small muted">{t.assigneeName ?? '未指派'}</div></td>
                  <td className="nowrap">{t.plannedStart ?? '—'} ～ {t.plannedEnd ?? '—'}</td>
                  <td>{t.overdue ? <Badge tone="danger" testid={`task-overdue-${t.id}`}>已逾期</Badge> : null} <StatusBadge map={TASK_STATUS} value={t.status} /></td>
                  <td>{t.status === 'SKIPPED' || t.status === 'CANCELLED' ? <span className="muted small">—</span> : (
                    <TaskActions id={t.id} status={t.status} kind={t.kind} optional={t.optional} dateLocked={t.dateLocked} plannedStart={t.plannedStart} plannedEnd={t.plannedEnd}
                      assigneeUserId={t.assigneeUserId} canAct={canAct && !['CANCELLED', 'ON_HOLD'].includes(c.status)} canWrite={internal && can(actor, 'task.write') && !['CANCELLED', 'ON_HOLD', 'CLOSED'].includes(c.status)} users={users} />
                  )}</td>
                </tr>
              );
            })}
          </Table>
        </div>
      ))}
    </div>
  );
}

async function ProductsTab({ c, actor, editable }: { c: CampaignV; actor: A; editable: boolean }) {
  const opts = editable ? await productSkuOptions(actor, c.vendorId) : [];
  return (
    <Card title="檔期商品" testid="tab-products" flush actions={editable ? <Modal label="＋ 加入商品" title="加入商品／規格" variant="primary" size="btn sm" testid="btn-add-product"><AddProductForm campaignId={c.id} options={opts} /></Modal> : undefined}>
      {c.products.length === 0 ? <EmptyState title="尚未加入商品" hint={editable ? '至商品管理建立商品與規格後，在此加入' : undefined} /> : (
        <Table head={['商品', '規格', '原價', '團購價', '檔期價', '限量', '審核', '']}>
          {c.products.map((p) => (
            <tr key={p.id} data-testid={`cproduct-${p.id}`}><td><Link href={`/products/${p.productId}`}>{p.productName}</Link></td><td>{p.skuName ? `${p.skuName}（${p.skuCode}）` : '—'}</td>
              <td className="num">{money(p.listPrice)}</td><td className="num">{money(p.groupPrice)}</td><td className="num">{money(p.campaignPrice)}</td><td className="num">{p.limitQty ?? '—'}</td>
              <td><StatusBadge map={REVIEW_STATUS} value={p.reviewStatus} /></td>
              <td>{editable ? <ActionButton endpoint={`/api/campaigns/${c.id}/products/${p.id}/remove`} label="移除" small variant="danger" confirm="確定從檔期移除此商品？" testid={`btn-remove-product-${p.id}`} /> : null}</td></tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

async function HostsTab({ c, actor, internal, canWrite }: { c: CampaignV; actor: A; internal: boolean; canWrite: boolean }) {
  const editableHosts = ['DRAFT', 'EVALUATING', 'PREPARING', 'PENDING_G1', 'PENDING_G2', 'SCHEDULED'].includes(c.status) && canWrite;
  const placeable = [...['DRAFT', 'EVALUATING', 'PREPARING', 'PENDING_G1', 'PENDING_G2', 'SCHEDULED', 'RUNNING']].includes(c.status) && canWrite;
  const hostOpts = editableHosts ? (await hostOptions(actor)).filter((h) => !c.hosts.some((x) => x.hostId === h.value)) : [];
  const hcOpts = placeable ? await hostCommunityOptions(actor, c.hosts.filter((h) => h.status !== 'DECLINED').map((h) => h.hostId)) : [];
  return (
    <div data-testid="tab-hosts">
      <Card title="參與團主" flush actions={editableHosts ? <Modal label="＋ 邀請團主" title="邀請團主加入檔期" variant="primary" size="btn sm" testid="btn-add-host">
        <ApiForm endpoint={`/api/campaigns/${c.id}/hosts`} submitLabel="邀請" testid="add-host-form" fields={[{ name: 'hostId', label: '團主', type: 'select', required: true, options: hostOpts }, { name: 'role', label: '角色', type: 'select', options: [{ value: 'PRIMARY', label: '主要團主' }, { value: 'CO', label: '共同團主' }] }, ...(can(actor, 'campaign.sensitive.read') ? [{ name: 'targetRevenue', label: '該團主目標（TWD）', type: 'number' as const }] : [])]} />
      </Modal> : undefined}>
        {c.hosts.length === 0 ? <EmptyState title="尚未邀請團主" /> : (
          <Table head={['團主', '角色', '回覆狀態', '回覆時間', ...(internal ? ['目標', '操作'] : [])]}>
            {c.hosts.map((h) => (
              <tr key={h.id} data-testid={`chost-${h.hostId}`}><td>{internal ? <Link href={`/hosts/${h.hostId}`}>{h.displayName}</Link> : h.displayName}</td><td>{h.role === 'PRIMARY' ? '主要' : '共同'}</td>
                <td><StatusBadge map={HOST_PART} value={h.status} />{h.note ? <div className="small muted">{h.note}</div> : null}</td><td>{fmtDateTime(h.respondedAt)}</td>
                {internal ? <><td className="num">{h.targetRevenue !== undefined ? money(h.targetRevenue ?? null) : '—'}</td>
                  <td>{editableHosts ? <div className="btn-row">
                    {h.status !== 'CONFIRMED' ? <ActionButton endpoint={`/api/campaigns/${c.id}/hosts/${h.hostId}/respond`} body={{ status: 'CONFIRMED' }} label="登記已確認" small testid={`btn-host-confirm-${h.hostId}`} /> : null}
                    {h.status !== 'DECLINED' ? <ActionButton endpoint={`/api/campaigns/${c.id}/hosts/${h.hostId}/respond`} body={{ status: 'DECLINED' }} label="登記婉拒" small reasonLabel="婉拒原因" reasonKey="note" testid={`btn-host-decline-${h.hostId}`} /> : null}
                    <ActionButton endpoint={`/api/campaigns/${c.id}/hosts/${h.hostId}/remove`} label="移除" small variant="danger" reasonLabel="移除原因" testid={`btn-host-remove-${h.hostId}`} />
                  </div> : null}</td></> : null}
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="曝光安排" flush actions={placeable ? <Modal label="＋ 新增曝光" title="新增曝光安排" variant="primary" size="btn sm" testid="btn-add-placement"><AddPlacementForm campaignId={c.id} options={hcOpts} minDate={c.openDate} maxDate={c.closeDate} /></Modal> : undefined}>
        {c.placements.length === 0 ? <EmptyState title="尚未排定曝光" hint="需要先邀請團主，並在團主頁連結其社群" /> : (
          <Table head={['日期', '團主', '社群', '形式', '狀態', '內容／備註', ...(canWrite ? ['操作'] : [])]}>
            {c.placements.map((p) => (
              <tr key={p.id} data-testid={`placement-${p.id}`}><td className="nowrap">{p.scheduledOn}{p.scheduledTime ? ` ${p.scheduledTime.slice(0, 5)}` : ''}</td><td>{p.hostName}</td><td>{p.communityName} <span className="small muted">{PLATFORM[p.platform] ?? p.platform}</span></td>
                <td>{PLACEMENT_TYPE[p.placementType] ?? p.placementType}</td><td><StatusBadge map={PLACEMENT_STATUS} value={p.status} /></td><td className="small">{p.contentRef ?? ''} {p.note ?? ''}</td>
                {canWrite ? <td>{p.status === 'PLANNED' ? <div className="btn-row">
                  <ActionButton endpoint={`/api/campaigns/${c.id}/placements/${p.id}/status`} body={{ status: 'DONE' }} label="已執行" small testid={`btn-placement-done-${p.id}`} />
                  <ActionButton endpoint={`/api/campaigns/${c.id}/placements/${p.id}/status`} body={{ status: 'CANCELLED' }} label="取消" small variant="danger" reasonLabel="取消原因" reasonKey="note" testid={`btn-placement-cancel-${p.id}`} />
                </div> : null}</td> : null}
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

async function ApprovalsTab({ c, actor }: { c: CampaignV; actor: A }) {
  const gates = Object.entries(GATE_REQUEST).filter(([, v]) => v.from === c.status || v.to === c.status).map(([g]) => g);
  const checksByGate: Record<string, CheckItemV[]> = {};
  for (const g of gates) checksByGate[g] = as<CheckItemV[]>(await gateCheck(actor, c.id, g));
  const pending = (c.approvals ?? []).filter((a) => a.status === 'PENDING');
  return (
    <div data-testid="tab-approvals">
      {gates.includes('G1') && can(actor, 'fit.read') ? await FitG1Note({ campaignId: c.id, actor }) : null}
      {gates.length === 0 && pending.length === 0 ? <Banner kind="nodata">目前狀態（{STATUS_LABEL_MAP[c.status] ?? c.status}）沒有可申請的關卡。</Banner> : null}
      {gates.map((g) => {
        const checks = checksByGate[g];
        const hasPending = pending.some((p) => p.gateKey === g);
        const blockFail = checks.filter((x) => x.level === 'BLOCK' && !x.ok && !x.ackable);
        return (
          <Card key={g} title={`關卡 ${g} 檢查清單`} testid={`gate-${g}`}>
            <ul className="list-plain" data-testid={`gate-checks-${g}`}>
              {checks.map((k) => (
                <li key={k.key} data-testid={`check-${g}-${k.key}`}>{k.ok ? '✅' : k.level === 'BLOCK' ? '⛔' : '⚠️'} <strong>{k.label}</strong>{' '}
                  <Badge tone={k.level === 'BLOCK' ? 'danger' : 'warn'}>{k.level === 'BLOCK' ? '必要' : '提醒'}</Badge>{k.ackable && !k.ok ? <> <Badge tone="info">可填原因後放行</Badge></> : null}
                  {k.detail ? <div className="small muted">{k.detail}</div> : null}</li>
              ))}
            </ul>
            {GATE_REQUEST[g].from === c.status && can(actor, 'approval.request') && !hasPending ? (
              blockFail.length ? <p className="small" style={{ color: 'var(--danger)' }}>尚有 {blockFail.length} 項必要檢查未通過，無法申請。</p>
                : <ActionButton endpoint={`/api/campaigns/${c.id}/gates/${g}/request`} label={`申請 ${g} 核准`} variant="primary" testid={`btn-request-${g}`} successMessage={`已送出 ${g} 核准申請`} />
            ) : null}
          </Card>
        );
      })}
      <Card title="核准紀錄" flush testid="approval-history">
        {(c.approvals ?? []).length === 0 ? <EmptyState title="尚無核准申請" /> : (
          <Table head={['關卡', '狀態', '申請', '決定', '備註', '']}>
            {(c.approvals ?? []).map((a) => (
              <tr key={a.id} data-testid={`approval-${a.id}`}><td><strong>{a.gateKey}</strong></td><td><StatusBadge map={APPROVAL_STATUS} value={a.status} /></td><td className="small">{fmtDateTime(a.requestedAt)}<div>{a.requestNote}</div></td>
                <td className="small">{a.decidedAt ? fmtDateTime(a.decidedAt) : '—'}</td><td className="small">{a.decisionNote}</td>
                <td>{a.status === 'PENDING' && GATE_APPROVER_ROLES[a.gateKey]?.includes(actor.role) ? (
                  <Modal label="決定" title={`${a.gateKey} 核准決定`} variant="primary" size="btn sm" testid={`btn-decide-${a.id}`}>
                    <p className="small muted">通過時系統會重新檢查；若有「可填原因放行」的高風險項目，請在風險確認欄填寫原因。允許決定的角色：{GATE_APPROVER_ROLES[a.gateKey].map(roleLabel).join('、')}</p>
                    <ApiForm endpoint={`/api/approvals/${a.id}/decision`} submitLabel="送出決定" testid={`decide-form-${a.id}`} fields={[
                      { name: 'decision', label: '決定', type: 'select', required: true, options: [{ value: 'APPROVED', label: '核准' }, { value: 'REJECTED', label: '退回' }] },
                      { name: 'note', label: '說明（退回必填）', type: 'textarea' }, { name: 'acknowledge', label: '風險確認原因（有高風險衝突仍要核准時必填）', type: 'textarea' }]} />
                  </Modal>) : null}</td></tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

async function AuditTab({ id, actor }: { id: string; actor: A }) {
  const rows = as<AuditV[]>(await listCampaignAudit(actor, id));
  const j = (v: unknown) => (v == null ? '' : JSON.stringify(v));
  return (
    <Card title="異動紀錄（誰、何時、改了什麼）" flush testid="tab-audit">
      {rows.length === 0 ? <EmptyState title="沒有紀錄" /> : (
        <Table head={['時間', '操作者', '動作', '對象', '前後值', '原因']}>
          {rows.map((a) => (
            <tr key={a.id}><td className="nowrap small">{fmtDateTime(a.occurredAt)}</td><td className="small">{a.actorName ?? (a.actorType === 'SYSTEM' ? '系統' : '—')}<div className="muted">{a.actorRole ? roleLabel(a.actorRole) : ''}</div></td>
              <td className="small">{a.action}</td><td className="small">{a.entityType}<div className="muted">{a.entityId}</div></td>
              <td>{a.beforeData ? <pre className="diff">前：{j(a.beforeData)}</pre> : null}{a.afterData ? <pre className="diff">後：{j(a.afterData)}</pre> : null}</td><td className="small">{a.reason}</td></tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

