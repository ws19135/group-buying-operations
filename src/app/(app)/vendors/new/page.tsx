import { withActor } from '@/server/ui/session';
import { requirePerm } from '@/server/lib/permissions';
import { Card, PageHeader } from '@/ui/components';
import { ApiForm } from '@/ui/ApiForm';
import { VENDOR_STATUS } from '@/ui/labels';

export const dynamic = 'force-dynamic';

export default withActor(async (actor) => {
  requirePerm(actor, 'vendor.write');
  return (
    <>
      <PageHeader title="新增廠商" sub="名稱或統編與既有廠商重複時會擋下並提示既有編號" />
      <Card>
        <ApiForm endpoint="/api/vendors" idempotent redirectTo="/vendors/{id}" submitLabel="建立廠商" testid="vendor-create-form" successMessage="廠商已建立" fields={[
          { name: 'name', label: '廠商／品牌名稱', required: true, help: '消費者認得的名字' },
          { name: 'companyName', label: '公司全名（開立發票用）' },
          { name: 'taxId', label: '統一編號', help: '8 碼數字' },
          { name: 'category', label: '類別' },
          { name: 'website', label: '官網', type: 'url' },
          { name: 'status', label: '合作狀態', type: 'select', defaultValue: 'PROSPECT', required: true, options: Object.entries(VENDOR_STATUS).map(([v, l]) => ({ value: v, label: l.label })) },
          { name: 'cooperationNote', label: '合作備註', type: 'textarea' },
          { name: 'internalNote', label: '內部備註（廠商看不到）', type: 'textarea' },
        ]} />
      </Card>
    </>
  );
});
