import { withActor, sp1, type SP } from '@/server/ui/session';
import { requirePerm } from '@/server/lib/permissions';
import { listAssignableUsers } from '@/server/ui/lookups';
import { Banner, Card, PageHeader } from '@/ui/components';
import { ApiForm } from '@/ui/ApiForm';
import { aftersalesCampaignOptions } from '../lookups';
import { PII_HINT, priorityOptions, typeOptions } from '../labels';

export const dynamic = 'force-dynamic';

export default withActor(async (actor, props: { searchParams: SP }) => {
  requirePerm(actor, 'aftersales.write');
  const q = await sp1(props.searchParams);
  const [campaigns, users] = await Promise.all([aftersalesCampaignOptions(actor), listAssignableUsers(actor)]);
  return (
    <>
      <PageHeader title="新增售後案件" />
      <Banner kind="warn" testid="pii-hint">{PII_HINT}</Banner>
      <Card>
        <ApiForm endpoint="/api/aftersales/cases" idempotent redirectTo="/aftersales/{id}" submitLabel="建立案件" testid="case-create-form" successMessage="案件已建立" fields={[
          { name: 'campaignId', label: '檔期', type: 'select', required: true, defaultValue: q.campaignId ?? '', options: campaigns },
          { name: 'caseType', label: '類型', type: 'select', required: true, defaultValue: 'COMPLAINT', options: typeOptions },
          { name: 'title', label: '標題', required: true, placeholder: '例如：收到商品外盒破損' },
          { name: 'priority', label: '優先級', type: 'select', required: true, defaultValue: 'MEDIUM', options: priorityOptions },
          { name: 'orderId', label: '關聯訂單（選填）', placeholder: 'ORD-000001', defaultValue: q.orderId, help: '填入後會帶入該訂單的買家代號，並可申請退款' },
          { name: 'buyerRef', label: '買家代號（選填）', placeholder: '去識別化代號，例如 b-001' },
          { name: 'assigneeUserId', label: '負責人', type: 'select', options: users },
          { name: 'dueDate', label: '到期日', type: 'date' },
          { name: 'description', label: '問題描述', type: 'textarea' },
          { name: 'internalNote', label: '內部備註（團主、廠商看不到）', type: 'textarea' },
        ]} />
      </Card>
    </>
  );
});
