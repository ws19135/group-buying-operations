import Link from 'next/link';
import type { Actor } from '@/server/lib/permissions';
import { g1Summary } from '@/server/modules/decision-summary';
import { campaignTrials } from '@/server/modules/trials';
import { Banner, Card, EmptyState, StatusBadge, Table } from '@/ui/components';
import { CONCLUSION, RECOVERY, TASK_STATUS, TRIAL_LEVEL, TRIAL_STATUS, TRIAL_TYPE } from '@/ui/labels';
import { SummaryNote, SummaryView } from '@/ui/selection/SummaryView';
import { as } from '@/ui/types';

interface CT {
  items: { id: string; productId: string; productName: string; level: string; trialType: string; status: string; hostName: string | null; conclusion: string | null; recoveryStatus: string; checkTested: number; checkTotal: number }[];
  tasks: { id: string; stepKey: string; name: string; status: string; plannedEnd: string | null }[];
  summary: { total: number; open: number; concluded: number; failed: number };
}

/** 檔期的「選品與試用」分頁：G1 統一決策摘要（唯讀）＋本檔試用清單與相關任務現況。不改變 G1 的檢查項與核准結果。 */
export async function SelectionTab({ campaignId, actor }: { campaignId: string; actor: Actor }) {
  const s = await g1Summary(actor, campaignId);
  const t = as<CT>(await campaignTrials(actor, campaignId));
  return (
    <div data-testid="tab-selection">
      <Banner kind="nodata">這一頁把「商品評估、廠商合作資格審查、試用、商業可行性、客群適配」彙整成 G1 選品核准的決策摘要，附風險與證據。<strong>它不是 G1 的檢查項，不會阻擋或放行任何關卡，也不會自動核准</strong>；是否核准仍由核准者依既有 G1 流程決定。</Banner>
      <SummaryView s={s} />
      <Card title={`本檔試用（${t.summary.total}）`} flush testid="campaign-trials">
        {t.items.length === 0 ? <EmptyState title="本檔尚無試用紀錄" hint={<>到商品頁的「商品試用」新增（指定團主試用或小規模測試團）。寄樣、到貨、回饋任務在下方現況或<Link href={`/campaigns/${campaignId}?tab=tasks`}>任務</Link>處理。</>} /> : (
          <Table head={['試用', '商品', '層級／類型', '團主', '檢核', '結論', '回收']}>{t.items.map((x) => (
            <tr key={x.id}><td><Link href={`/trials/${x.id}`}>{x.id}</Link><div><StatusBadge map={TRIAL_STATUS} value={x.status} /></div></td><td><Link href={`/products/${x.productId}`}>{x.productName}</Link></td>
              <td>{TRIAL_LEVEL[x.level]}<div className="small muted">{TRIAL_TYPE[x.trialType]}</div></td><td>{x.hostName ?? '—'}</td><td>{x.checkTested}/{x.checkTotal}</td>
              <td>{x.conclusion ? <StatusBadge map={CONCLUSION} value={x.conclusion} /> : '—'}</td><td><StatusBadge map={RECOVERY} value={x.recoveryStatus} /></td></tr>))}</Table>
        )}
      </Card>
      <Card title="相關任務現況（唯讀）" flush testid="campaign-trial-tasks">
        <Table head={['步驟', '狀態', '預定完成']}>{t.tasks.map((k) => <tr key={k.id}><td><Link href={`/campaigns/${campaignId}?tab=tasks`}>{k.name}</Link></td><td><StatusBadge map={TASK_STATUS} value={k.status} /></td><td>{k.plannedEnd ?? '—'}</td></tr>)}</Table>
      </Card>
    </div>
  );
}

/** G1 核准區的簡短提示 */
export async function SelectionG1Note({ campaignId, actor }: { campaignId: string; actor: Actor }) {
  const s = await g1Summary(actor, campaignId);
  return <SummaryNote s={s} campaignId={campaignId} />;
}
