import Link from 'next/link';
import type { Actor } from '@/server/lib/permissions';
import { can } from '@/server/lib/permissions';
import { listCampaignFit } from '@/server/modules/fit';
import { ActionButton } from '@/ui/ActionButton';
import { Banner, Card, EmptyState } from '@/ui/components';
import { FitTable } from '@/ui/FitTable';
import { as, type FitItemV } from '@/ui/types';

interface CampaignFit {
  campaignStatus: string; config: { version: number; approved: boolean };
  summary: { total: number; reviewed: number; pendingReview: number; blocked: number; stale: number };
  items: FitItemV[];
}

/** 檔期的「客群適配」分頁：商品 × 已邀請團主的適配評估。僅供核准者查閱與人工覆核，不影響 G1–G5 的規則與結果。 */
export async function FitTab({ campaignId, actor }: { campaignId: string; actor: Actor }) {
  const d = as<CampaignFit>(await listCampaignFit(actor, campaignId));
  const assess = can(actor, 'fit.assess');
  const closed = ['CLOSED', 'SETTLED'].includes(d.campaignStatus);
  const editable = !['CANCELLED'].includes(d.campaignStatus);
  return (
    <div data-testid="tab-fit">
      <Banner kind="nodata">客群適配評估是「決策支援」：讓核准者在 G1 選品核准時查閱這檔的團主與商品適不適配，以及資料夠不夠。它<strong>不會</strong>自動核准、不會擋下或放行任何關卡，也不會寄出任何通知。
        評分權重目前為{d.config.approved ? '已確認' : '「建議值，待 Owner 確認」'}（v{d.config.version}），可在 <Link href="/fit">客群適配總覽</Link> 查看。</Banner>
      <Card title="適配評估" flush testid="campaign-fit" actions={
        <div className="btn-row">
          {assess && editable ? <ActionButton endpoint={`/api/campaigns/${campaignId}/fit`} label="產生／更新適配評估" variant="primary" small testid="btn-assess-campaign" successMessage="已更新適配評估" /> : null}
          {assess && closed ? <ActionButton endpoint={`/api/campaigns/${campaignId}/fit/outcome`} label="回寫結案成效" small testid="btn-fit-outcome" successMessage="已回寫成效" confirm="把每位團主的實際歸因淨銷售、訂單數與目標達成率記錄到對應的評估上（可重複執行，內容相同不會重複寫入）。" /> : null}
        </div>}>
        {d.items.length === 0 ? <EmptyState title="尚未評估" hint={assess ? '按「產生／更新適配評估」，系統會對本檔每個商品與每位未婉拒的團主評分。' : '營運小編或主管產生評估後會顯示在這裡。'} /> : (
          <>
            <p className="small muted" style={{ padding: '10px 16px 0' }} data-testid="fit-summary">共 {d.summary.total} 筆；已覆核 {d.summary.reviewed}、待覆核 {d.summary.pendingReview}；硬性條件未過 {d.summary.blocked}；資料已更新待重評 {d.summary.stale}。</p>
            <FitTable items={d.items} canReview={can(actor, 'fit.review')} show="both" />
          </>
        )}
      </Card>
    </div>
  );
}

/** G1（選品核准）核准區的唯讀提示：讓核准者知道有沒有評估與覆核；不影響申請與核准 */
export async function FitG1Note({ campaignId, actor }: { campaignId: string; actor: Actor }) {
  const d = as<CampaignFit>(await listCampaignFit(actor, campaignId));
  const s = d.summary;
  return (
    <Banner kind={s.total === 0 || s.pendingReview > 0 || s.blocked > 0 ? 'warn' : 'ok'} testid="g1-fit-note">
      <strong>客群適配評估（查閱用，不影響核准）：</strong>
      {s.total === 0 ? '尚未評估。' : `共 ${s.total} 筆，已覆核 ${s.reviewed}、待覆核 ${s.pendingReview}${s.blocked ? `、硬性條件未過 ${s.blocked}` : ''}${s.stale ? `、資料已更新待重評 ${s.stale}` : ''}。`}{' '}
      <Link href={`/campaigns/${campaignId}?tab=fit`} data-testid="link-g1-fit">查看評估 →</Link>
    </Banner>
  );
}
