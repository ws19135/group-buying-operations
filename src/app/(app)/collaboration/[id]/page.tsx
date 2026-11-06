import Link from 'next/link';
import { withActor, type Params } from '@/server/ui/session';
import { query } from '@/server/lib/db';
import { can, isInternal } from '@/server/lib/permissions';
import { getApplication } from '@/server/modules/collaboration';
import { campaignScope } from '@/server/lib/scope';
import { productSkuOptions } from '@/server/ui/options';
import { ActionButton } from '@/ui/ActionButton';
import { ApiForm } from '@/ui/ApiForm';
import { Modal } from '@/ui/Modal';
import { Badge, Banner, Card, EmptyState, Kv, PageHeader, StatusBadge, Table, dashIfNull } from '@/ui/components';
import { fmtDate, fmtDateTime } from '@/ui/format';
import { as } from '@/ui/types';
import { RevealRecipient } from '../RevealRecipient';
import { AssignmentBlock } from '../AssignmentBlock';
import { AddItemForm, VendorReviewForm } from '../CollaborationForms';
import {
  ADS_CONFIRM, ADS_INTENT, APP_STATUS, BACKEND_SETUP, COLLAB_STATUS, INTENT, SAMPLE_PROGRESS,
  SHIPMENT_TYPE, SHIPPED_BY, SHIP_STATUS, SOURCE, SUPPLY, opts, optsOf,
} from '../labels';

export const dynamic = 'force-dynamic';

interface ItemV {
  id: string; productId: string; skuId: string | null; requestedQty: number; approvedQty: number | null;
  supplyStatus: string; requestReason: string | null; vendorNote: string | null; version: number;
  productName: string; skuCode: string | null; skuName: string | null;
}
interface ShipV {
  id: string; shipmentType: string; shippedByParty: string; shipDate: string | null; carrier: string | null; trackingNo: string | null;
  quantity: number | null; status: string; receiptConfirmedAt: string | null; receiptNote: string | null;
  fulfillmentShipmentId: string | null; cancelReason: string | null; note?: string | null; version: number;
}
interface LaunchV {
  id: string; intent: string; intentRespondedOn: string | null; intentNote: string | null;
  plannedOpenDate: string | null; confirmedOpenDate: string | null; launchUrl: string | null;
  vendorPortalUrl?: string | null; backendSetupEmail?: string | null; backendSetupStatus: string;
  backendSetupNote?: string | null; adsIntent: string; adsConfirmStatus: string; adsNote: string | null;
  collaborationNote: string | null; version: number;
}
interface EventV {
  id: number; dimension: string; eventType: string; fromStatus: string | null; toStatus: string | null;
  note: string | null; actorRole: string | null; createdAt: string;
}
interface DetailV {
  id: string; vendorId: string; hostId: string; productId: string | null; source: string; appliedOn: string;
  status: string; collaborationStatus: string; campaignId: string | null; campaignTitle: string | null;
  trialId?: string | null; note: string | null; internalNote?: string | null; statusReason?: string | null;
  holdReason?: string | null; ownerUserId?: string | null; ownerName?: string | null; version: number;
  hostName: string; vendorName: string; productName: string | null;
  items: ItemV[]; shipments: ShipV[]; launch: LaunchV | null; events: EventV[];
  sample: { progress: string; resent: boolean; resendPending: boolean; resendCount: number; lastShipDate: string | null };
  sampleBucket: string;
  recipient: { present: boolean; confirmed: boolean; purged: boolean; retentionUntil: string | null };
  nextActions: string[];
  assignees?: { userId: string; role: 'PRIMARY' | 'CO_OWNER'; name: string; status: string }[];
}

const DIMENSION: Record<string, string> = {
  APPLICATION: '申請', COLLABORATION: '合作', SAMPLE: '樣品', INTENT: '開團意願', CAMPAIGN: '檔期', DATA: '資料',
};

export default withActor(async (actor, props: { params: Params }) => {
  const { id } = await props.params;
  const d = as<DetailV>(await getApplication(actor, id));
  const internal = isInternal(actor);
  const isHost = actor.role === 'HOST';
  const isVendor = actor.role === 'VENDOR';
  const terminal = ['REJECTED', 'CANCELLED', 'CLOSED'].includes(d.status);
  const canUpdate = can(actor, 'collaboration.update') && !terminal;
  const canReview = can(actor, 'collaboration.review') && !terminal;
  const canVendorReview = can(actor, 'collaboration.vendor.review') && !terminal;
  const canShip = can(actor, 'collaboration.shipping.write') && !terminal;
  const canIntent = can(actor, 'collaboration.intent.write') && !terminal;
  const canLink = can(actor, 'collaboration.campaign.link') && !terminal;
  const canSeeRecipient = can(actor, 'collaboration.pii.read') || isHost || isVendor;

  const skuOpts = canUpdate ? await productSkuOptions(actor, d.vendorId).catch(() => []) : [];
  const campaignOpts = canLink && d.collaborationStatus === 'COLLABORATION_CONFIRMED'
    ? await confirmedCampaignOptions(actor, d.vendorId) : [];

  return (
    <>
      <PageHeader
        title={<>{d.id} <StatusBadge map={APP_STATUS} value={d.status} testid="app-status" /> <StatusBadge map={COLLAB_STATUS} value={d.collaborationStatus} testid="collab-status" /></>}
        sub={<><Link href="/collaboration">網紅合作申請</Link> › <Link href={`/hosts/${d.hostId}`}>{d.hostName}</Link> × <Link href={`/vendors/${d.vendorId}`}>{d.vendorName}</Link> · {SOURCE[d.source] ?? d.source}</>}
        actions={<div className="btn-row">
          {canReview && ['SUBMITTED', 'INTERNAL_REVIEW', 'VENDOR_REVIEW', 'ON_HOLD'].includes(d.status) ? (
            <Modal label="內部審核" title="內部審核" variant="primary" size="btn sm" testid="btn-internal-review">
              <ApiForm endpoint={`/api/collaboration/applications/${d.id}/internal-review`} submitLabel="送出決定" testid="form-internal-review"
                fields={[
                  { name: 'decision', label: '決定', type: 'select', required: true, defaultValue: 'TO_VENDOR', options: [
                    { value: 'TO_VENDOR', label: '轉給廠商確認供樣' },
                    { value: 'APPROVE', label: '直接核准（不需廠商確認）' },
                    { value: 'REJECT', label: '退回' },
                  ] },
                  { name: 'note', label: '說明', type: 'textarea', help: '退回時必填' },
                ]} />
            </Modal>
          ) : null}
          {canUpdate && d.status === 'DRAFT' ? (
            <ActionButton endpoint={`/api/collaboration/applications/${d.id}/submit`} label="送出申請" variant="primary" small testid="btn-submit" successMessage="已送出" />
          ) : null}
          {canUpdate && !['ON_HOLD'].includes(d.status) ? (
            <ActionButton endpoint={`/api/collaboration/applications/${d.id}/hold`} label="暫緩" small reasonLabel="暫緩原因" testid="btn-hold" />
          ) : null}
          {canUpdate && d.status === 'ON_HOLD' ? (
            <Modal label="恢復處理" title="恢復處理" size="btn sm" testid="btn-resume">
              <ApiForm endpoint={`/api/collaboration/applications/${d.id}/resume`} submitLabel="恢復" testid="form-resume"
                fields={[{ name: 'to', label: '恢復到', type: 'select', required: true, defaultValue: 'APPROVED', options: opts(APP_STATUS).filter((o) => ['SUBMITTED', 'INTERNAL_REVIEW', 'VENDOR_REVIEW', 'APPROVED'].includes(o.value)) }]} />
            </Modal>
          ) : null}
          {canUpdate || (!internal && ['DRAFT', 'SUBMITTED'].includes(d.status)) ? (
            <ActionButton endpoint={`/api/collaboration/applications/${d.id}/cancel`} label="取消申請" variant="danger" small reasonLabel="取消原因" confirm="取消後不可再修改。" testid="btn-cancel" />
          ) : null}
        </div>} />

      {terminal ? <Banner kind="warn" testid="terminal-banner">此申請已{APP_STATUS[d.status]?.label}，資料唯讀。{d.statusReason ? `原因：${d.statusReason}` : ''}</Banner> : null}
      {d.status === 'ON_HOLD' ? <Banner kind="warn" testid="hold-banner">暫緩中：{d.holdReason}</Banner> : null}
      {d.nextActions.length ? <Banner kind="nodata" testid="next-actions">待辦：{d.nextActions.join('；')}</Banner> : null}

      {/* ── 區塊一：申請基本資料 ───────────────────────────── */}
      <Card title="申請資料" testid="block-basic" actions={canUpdate ? (
        <Modal label="編輯" title="編輯申請資料" size="btn sm" testid="btn-edit-basic">
          <ApiForm endpoint={`/api/collaboration/applications/${d.id}`} method="PATCH" submitLabel="儲存" testid="form-edit-basic" extra={{ version: d.version }}
            fields={[
              { name: 'appliedOn', label: '申請日期', type: 'date', defaultValue: d.appliedOn },
              { name: 'note', label: '備註（團主與廠商看得到）', type: 'textarea', defaultValue: d.note ?? '' },
              { name: 'internalNote', label: '內部備註', type: 'textarea', defaultValue: d.internalNote ?? '', help: '團主與廠商看不到' },
            ]} />
        </Modal>
      ) : undefined}>
        <Kv rows={[
          ['申請日期', fmtDate(d.appliedOn)],
          ['建立來源', SOURCE[d.source] ?? d.source],
          ['團主', <Link key="h" href={`/hosts/${d.hostId}`}>{d.hostName}</Link>],
          ['廠商', <Link key="v" href={`/vendors/${d.vendorId}`}>{d.vendorName}</Link>],
          ['代表商品', d.productId ? <Link key="p" href={`/products/${d.productId}`}>{d.productName}</Link> : '—'],
          ...(internal ? [['主要承辦人', dashIfNull(d.ownerName)] as [string, string]] : []),
          ['備註', dashIfNull(d.note)],
          ...(internal ? [['內部備註', dashIfNull(d.internalNote)] as [string, string]] : []),
          ['關聯檔期', d.campaignId ? <Link key="c" href={`/campaigns/${d.campaignId}`}>{d.campaignTitle ?? d.campaignId}</Link> : '尚未關聯'],
          ['SOP 03 試用紀錄', d.trialId ? <Link key="t" href={`/trials/${d.trialId}`}>{d.trialId}</Link> : '未關聯'],
        ]} />
        <p className="small muted">樣品申請不等於已完成 SOP 03 的正式試用資格評估；關聯只是引用，不會改變試用結論。</p>
      </Card>

      {internal ? <AssignmentBlock actor={actor} applicationId={d.id} assignees={d.assignees ?? []} terminal={terminal} /> : null}

      {/* ── 區塊二：申請樣品明細 ───────────────────────────── */}
      <Card flush title="申請樣品明細" testid="block-items" actions={canUpdate && ['DRAFT', 'SUBMITTED'].includes(d.status) ? (
        <Modal label="＋ 新增樣品" title="新增申請樣品" size="btn sm" testid="btn-add-item">
          <AddItemForm applicationId={d.id} options={skuOpts} />
        </Modal>
      ) : undefined}>
        {d.items.length === 0 ? <EmptyState title="還沒有申請樣品明細" /> : (
          <Table head={['商品／規格', '申請數量', '核准數量', '供應狀態', '申請原因／廠商備註', '']} testid="items-table">
            {d.items.map((i) => (
              <tr key={i.id} data-testid={`item-row-${i.id}`}>
                <td><strong>{i.productName}</strong>{i.skuId ? <div className="small muted">{i.skuName}（{i.skuCode}）</div> : <div className="small muted">未指定規格</div>}</td>
                <td>{i.requestedQty}</td>
                <td data-testid={`item-approved-${i.id}`}>{i.approvedQty ?? '—'}</td>
                <td><StatusBadge map={SUPPLY} value={i.supplyStatus} /></td>
                <td className="small">{dashIfNull(i.requestReason)}{i.vendorNote ? <div className="muted">廠商：{i.vendorNote}</div> : null}</td>
                <td>{canUpdate && ['DRAFT', 'SUBMITTED'].includes(d.status) ? (
                  <ActionButton endpoint={`/api/collaboration/items/${i.id}/remove`} label="移除" small variant="danger" reasonLabel="移除原因" reasonRequired={false} testid={`btn-remove-item-${i.id}`} />
                ) : null}</td>
              </tr>
            ))}
          </Table>
        )}
        {canVendorReview && ['SUBMITTED', 'INTERNAL_REVIEW', 'VENDOR_REVIEW'].includes(d.status) && d.items.length ? (
          <div className="pad">
            <Modal label="確認供樣" title="確認可供應的樣品與數量" variant="primary" size="btn sm" testid="btn-vendor-review">
              <VendorReviewForm applicationId={d.id} items={d.items.map((i) => ({
                id: i.id, label: `${i.productName}${i.skuId ? ` ／ ${i.skuName}` : ''}`,
                requestedQty: i.requestedQty, approvedQty: i.approvedQty, vendorNote: i.vendorNote,
              }))} />
            </Modal>
          </div>
        ) : null}
      </Card>

      {/* ── 區塊三：收件資訊（個資） ────────────────────────── */}
      <Card title="收件資訊" testid="block-recipient" actions={(can(actor, 'collaboration.pii.read') && canUpdate) || isHost ? (
        <Modal label={d.recipient.present ? '更新收件資訊' : '填寫收件資訊'} title="收件資訊" size="btn sm" testid="btn-edit-recipient">
          <ApiForm endpoint={`/api/collaboration/applications/${d.id}/recipient`} method="PATCH" submitLabel="儲存" testid="form-recipient"
            fields={[
              { name: 'recipientName', label: '收件人', required: true },
              { name: 'recipientPhone', label: '聯繫電話', required: true },
              { name: 'postalCode', label: '郵遞區號', half: true },
              { name: 'addressLine', label: '收件地址', required: true },
              { name: 'deliveryNote', label: '到貨備註' },
              { name: 'confirm', label: '這份收件資料現在可用（確認後才會提供給廠商寄送）', type: 'checkbox', defaultValue: true },
            ]} />
          <p className="small muted">這裡填的地址只屬於這一筆申請，不會覆寫團主主檔。更新會保留舊版歷史。</p>
        </Modal>
      ) : undefined}>
        {!d.recipient.present ? <EmptyState title="還沒有收件資訊" hint="團主或營運填寫後，廠商才能取得寄送所需的資料" /> : (
          <>
            <Kv rows={[
              ['確認狀態', d.recipient.confirmed ? <Badge key="c" tone="ok">團主已確認</Badge> : <Badge key="c" tone="warn">尚未確認</Badge>],
              ['保留至', d.recipient.purged ? '已依保留政策清除' : dashIfNull(d.recipient.retentionUntil)],
            ]} />
            {canSeeRecipient && !d.recipient.purged ? <RevealRecipient applicationId={d.id} /> : (
              <p className="small muted">你沒有讀取收件個資的權限。</p>
            )}
          </>
        )}
      </Card>

      {/* ── 區塊四：樣品寄送紀錄 ───────────────────────────── */}
      <Card flush title={<>樣品寄送紀錄 <StatusBadge map={SAMPLE_PROGRESS} value={d.sample.progress} testid="sample-progress" />{d.sample.resent ? <> <Badge tone="info" testid="badge-resent">已補寄 {d.sample.resendCount} 次</Badge></> : null}</>}
        testid="block-shipments" actions={canShip && ['VENDOR_REVIEW', 'APPROVED'].includes(d.status) ? (
          <Modal label="＋ 新增寄送紀錄" title="新增寄送紀錄" size="btn sm" testid="btn-add-shipment">
            <ApiForm endpoint={`/api/collaboration/applications/${d.id}/shipments`} submitLabel="建立" idempotent testid="form-add-shipment"
              fields={[
                { name: 'shipmentType', label: '類型', type: 'select', required: true, defaultValue: d.shipments.some((s) => s.shipmentType === 'INITIAL' && s.status !== 'CANCELLED') ? 'RESEND' : 'INITIAL', options: optsOf(SHIPMENT_TYPE) },
                { name: 'shippedByParty', label: '由誰寄出', type: 'select', defaultValue: isVendor ? 'VENDOR' : 'OPS', options: optsOf(SHIPPED_BY) },
                { name: 'shipDate', label: '寄出日期', type: 'date', help: '留空＝還沒寄出；填上日期即視為已寄出' },
                { name: 'carrier', label: '物流商', half: true },
                { name: 'trackingNo', label: '物流單號', half: true },
                { name: 'quantity', label: '件數', type: 'number', min: 1 },
                { name: 'note', label: '備註' },
              ]} />
          </Modal>
        ) : undefined}>
        {d.shipments.length === 0 ? <EmptyState title="還沒有寄送紀錄" hint={canShip ? '核准供樣後即可建立首次寄送' : undefined} /> : (
          <Table head={['類型', '寄送方', '寄出日', '物流', '件數', '狀態', '收件確認', '']} testid="shipments-table">
            {d.shipments.map((s) => (
              <tr key={s.id} data-testid={`shipment-row-${s.id}`}>
                <td>{SHIPMENT_TYPE[s.shipmentType] ?? s.shipmentType}<div className="small muted">{s.id}</div></td>
                <td className="small">{SHIPPED_BY[s.shippedByParty] ?? s.shippedByParty}</td>
                <td className="nowrap">{fmtDate(s.shipDate)}</td>
                <td className="small">{dashIfNull(s.carrier)}{s.trackingNo ? <div className="muted">{s.trackingNo}</div> : null}</td>
                <td>{s.quantity ?? '—'}</td>
                <td><StatusBadge map={SHIP_STATUS} value={s.status} testid={`shipment-status-${s.id}`} />{s.cancelReason ? <div className="small muted">{s.cancelReason}</div> : null}</td>
                <td className="small">{s.receiptConfirmedAt ? <>{fmtDateTime(s.receiptConfirmedAt)}{s.receiptNote ? <div className="muted">{s.receiptNote}</div> : null}</> : '—'}</td>
                <td><div className="btn-row">
                  {canShip && ['PENDING', 'SHIPPED'].includes(s.status) ? (
                    <Modal label="編輯" title="編輯寄送紀錄" size="btn sm" testid={`btn-edit-shipment-${s.id}`}>
                      <ApiForm endpoint={`/api/collaboration/shipments/${s.id}`} method="PATCH" submitLabel="儲存" testid={`form-edit-shipment-${s.id}`} extra={{ version: s.version }}
                        fields={[
                          { name: 'shipDate', label: '寄出日期', type: 'date', defaultValue: s.shipDate ?? '', help: '填上日期即視為已寄出' },
                          { name: 'carrier', label: '物流商', defaultValue: s.carrier ?? '', half: true },
                          { name: 'trackingNo', label: '物流單號', defaultValue: s.trackingNo ?? '', half: true },
                          { name: 'quantity', label: '件數', type: 'number', defaultValue: s.quantity ?? undefined, min: 1 },
                          { name: 'note', label: '備註', defaultValue: s.note ?? '' },
                        ]} />
                    </Modal>
                  ) : null}
                  {(isHost || canShip) && !isVendor && s.status === 'SHIPPED' ? (
                    <Modal label="確認收件" title="確認收件" variant="primary" size="btn sm" testid={`btn-receipt-${s.id}`}>
                      <ApiForm endpoint={`/api/collaboration/shipments/${s.id}/receipt`} submitLabel="確認" testid={`form-receipt-${s.id}`}
                        fields={[
                          { name: 'receivedOn', label: '收到日期', type: 'date', required: true },
                          { name: 'receiptNote', label: '備註' },
                        ]} />
                    </Modal>
                  ) : null}
                  {canShip && ['PENDING', 'SHIPPED'].includes(s.status) ? (
                    <ActionButton endpoint={`/api/collaboration/shipments/${s.id}/cancel`} label="取消" small variant="danger" reasonLabel="取消原因" testid={`btn-cancel-shipment-${s.id}`} />
                  ) : null}
                </div></td>
              </tr>
            ))}
          </Table>
        )}
        <p className="small muted pad">「是否已補寄」由這張表推導：必須真的有一列「補寄」並填上寄出日期才算。物流資訊為人工登錄，不連接任何物流商系統。</p>
      </Card>

      {/* ── 區塊五：開團合作資訊 ───────────────────────────── */}
      <Card title="開團合作資訊" testid="block-launch" actions={<div className="btn-row">
        {canIntent && !isVendor ? (
          <Modal label={isHost ? '回覆開團意願' : '更新開團資訊'} title="開團合作資訊" variant="primary" size="btn sm" testid="btn-edit-launch">
            <ApiForm endpoint={`/api/collaboration/applications/${d.id}/launch`} method="PATCH" submitLabel="儲存" testid="form-launch"
              fields={[
                { name: 'intent', label: '開團意願', type: 'select', defaultValue: d.launch?.intent ?? 'PENDING', options: opts(INTENT) },
                { name: 'intentNote', label: '意願說明', type: 'textarea', defaultValue: d.launch?.intentNote ?? '' },
                { name: 'plannedOpenDate', label: '預計開團日', type: 'date', defaultValue: d.launch?.plannedOpenDate ?? '', help: '樣品還沒寄出也可以先填' },
                ...(internal ? [{ name: 'confirmedOpenDate', label: '已確認開團日', type: 'date' as const, defaultValue: d.launch?.confirmedOpenDate ?? '' }] : []),
                { name: 'launchUrl', label: '開團連結', type: 'url', defaultValue: d.launch?.launchUrl ?? '' },
                // 投廣與合作備註只有內部可以寫（後端 HOST_LAUNCH_FIELDS 只放行意願與開團日期），
                // 所以這裡也不能把欄位顯示給團主，否則送出會被後端擋成無權限。
                ...(internal ? [
                  { name: 'adsIntent', label: '是否投廣', type: 'select' as const, defaultValue: d.launch?.adsIntent ?? 'PENDING', options: opts(ADS_INTENT) },
                  { name: 'adsNote', label: '投廣說明', defaultValue: d.launch?.adsNote ?? '' },
                  { name: 'collaborationNote', label: '合作備註', type: 'textarea' as const, defaultValue: d.launch?.collaborationNote ?? '' },
                ] : []),
              ]} />
          </Modal>
        ) : null}
        {canVendorReview ? (
          <Modal label="回填後台設定" title="廠商後台與投廣確認" size="btn sm" testid="btn-vendor-launch">
            <ApiForm endpoint={`/api/collaboration/applications/${d.id}/vendor-launch`} method="PATCH" submitLabel="儲存" testid="form-vendor-launch"
              fields={[
                { name: 'vendorPortalUrl', label: '廠商後台連結', type: 'url', defaultValue: d.launch?.vendorPortalUrl ?? '' },
                { name: 'backendSetupEmail', label: '後台設定 Mail（設定聯絡信箱）', type: 'email', defaultValue: d.launch?.backendSetupEmail ?? '', help: '只是記錄聯絡信箱，系統不會自動寄信' },
                { name: 'backendSetupStatus', label: '後台設定狀態', type: 'select', defaultValue: d.launch?.backendSetupStatus ?? 'NOT_REQUIRED', options: opts(BACKEND_SETUP) },
                { name: 'backendSetupNote', label: '後台設定備註', type: 'textarea', defaultValue: d.launch?.backendSetupNote ?? '' },
                { name: 'adsConfirmStatus', label: '投廣確認', type: 'select', defaultValue: d.launch?.adsConfirmStatus ?? 'PENDING', options: opts(ADS_CONFIRM) },
              ]} />
          </Modal>
        ) : null}
        {canReview && d.status === 'APPROVED' && d.launch?.intent === 'WILLING' && d.collaborationStatus !== 'COLLABORATION_CONFIRMED' && d.collaborationStatus !== 'CAMPAIGN_LINKED' ? (
          <Modal label="確認正式合作" title="確認正式合作" variant="primary" size="btn sm" testid="btn-confirm-collab">
            <ApiForm endpoint={`/api/collaboration/applications/${d.id}/confirm-collaboration`} submitLabel="確認" testid="form-confirm-collab"
              fields={[
                { name: 'confirmedOpenDate', label: '已確認開團日', type: 'date', defaultValue: d.launch?.plannedOpenDate ?? '' },
                { name: 'note', label: '說明', type: 'textarea' },
              ]} />
          </Modal>
        ) : null}
        {canUpdate && !['DECLINED'].includes(d.collaborationStatus) ? (
          <ActionButton endpoint={`/api/collaboration/applications/${d.id}/decline-collaboration`} label="不合作" small reasonLabel="原因" testid="btn-decline-collab" />
        ) : null}
      </div>}>
        <Kv rows={[
          ['開團意願', <StatusBadge key="i" map={INTENT} value={d.launch?.intent ?? 'PENDING'} testid="launch-intent" />],
          ['意願回覆日', fmtDate(d.launch?.intentRespondedOn)],
          ['意願說明', dashIfNull(d.launch?.intentNote)],
          ['預計開團日', fmtDate(d.launch?.plannedOpenDate)],
          ['已確認開團日', <strong key="c" data-testid="confirmed-open-date">{fmtDate(d.launch?.confirmedOpenDate)}</strong>],
          ['開團連結', d.launch?.launchUrl ? <a key="u" href={d.launch.launchUrl} target="_blank" rel="noreferrer noopener">{d.launch.launchUrl}</a> : '—'],
          ['是否投廣', <StatusBadge key="a" map={ADS_INTENT} value={d.launch?.adsIntent ?? 'PENDING'} />],
          ['投廣確認', <StatusBadge key="ac" map={ADS_CONFIRM} value={d.launch?.adsConfirmStatus ?? 'PENDING'} />],
          ...(isHost ? [] : [
            ['廠商後台連結', d.launch?.vendorPortalUrl ? <a key="vp" href={d.launch.vendorPortalUrl} target="_blank" rel="noreferrer noopener">{d.launch.vendorPortalUrl}</a> : '—'] as [string, React.ReactNode],
            ['後台設定 Mail', dashIfNull(d.launch?.backendSetupEmail)] as [string, React.ReactNode],
            ['後台設定狀態', <StatusBadge key="bs" map={BACKEND_SETUP} value={d.launch?.backendSetupStatus ?? 'NOT_REQUIRED'} />] as [string, React.ReactNode],
          ]),
          ...(internal ? [['合作備註', dashIfNull(d.launch?.collaborationNote)] as [string, React.ReactNode]] : []),
        ]} />
        {canLink ? (
          <div className="btn-row">
            {d.campaignId ? (
              <ActionButton endpoint={`/api/collaboration/applications/${d.id}/unlink-campaign`} label="解除檔期關聯" small reasonLabel="原因" testid="btn-unlink-campaign" />
            ) : campaignOpts.length ? (
              <Modal label="關聯正式檔期" title="關聯既有檔期" variant="primary" size="btn sm" testid="btn-link-campaign">
                <ApiForm endpoint={`/api/collaboration/applications/${d.id}/link-campaign`} submitLabel="關聯" testid="form-link-campaign"
                  fields={[{ name: 'campaignId', label: '檔期', type: 'select', required: true, options: campaignOpts }]} />
                <p className="small muted">只建立關聯：不會建立新檔期、不會改變檔期狀態，也不會通過或略過 G1～G5 的任何核准。</p>
              </Modal>
            ) : d.collaborationStatus === 'COLLABORATION_CONFIRMED' ? <p className="small muted">這家廠商目前沒有可關聯的檔期，請先在「檔期」建立。</p> : null}
          </div>
        ) : null}
        {isHost ? null : <p className="small muted">「後台設定 Mail」是記錄聯絡信箱與設定狀態，系統不會自動寄送任何通知。</p>}
      </Card>

      {/* ── 區塊六：處理歷程 ───────────────────────────────── */}
      <Card flush title="處理歷程" testid="block-events">
        {d.events.length === 0 ? <EmptyState title="還沒有歷程" /> : (
          <Table head={['時間', '維度', '事件', '變更', '說明', '操作者']} testid="events-table">
            {d.events.map((e) => (
              <tr key={e.id} data-testid={`event-row-${e.id}`}>
                <td className="small nowrap">{fmtDateTime(e.createdAt)}</td>
                <td className="small">{DIMENSION[e.dimension] ?? e.dimension}</td>
                <td className="small">{e.eventType}</td>
                <td className="small">{e.fromStatus || e.toStatus ? `${e.fromStatus ?? '—'} → ${e.toStatus ?? '—'}` : '—'}</td>
                <td className="small">{dashIfNull(e.note)}</td>
                <td className="small muted">{dashIfNull(e.actorRole)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
});

/** 可關聯的檔期：同一廠商、未取消／未結案，且在使用者的檔期資料範圍內 */
async function confirmedCampaignOptions(actor: Parameters<typeof campaignScope>[0], vendorId: string) {
  const sc = campaignScope(actor, 2, 'c');
  if (sc.sql === 'FALSE') return [];
  const rows = await query<{ id: string; title: string; status: string }>(
    `SELECT c.id, c.title, c.status FROM campaigns c
      WHERE c.vendor_id=$1 AND (${sc.sql}) AND c.status NOT IN ('CANCELLED','CLOSED')
      ORDER BY c.created_at DESC LIMIT 100`, [vendorId, ...sc.params]);
  return rows.map((r) => ({ value: r.id, label: `${r.title}（${r.id}）` }));
}
