import { withActor } from '@/server/ui/session';
import { requirePerm } from '@/server/lib/permissions';
import { Card, PageHeader } from '@/ui/components';
import { ApiForm } from '@/ui/ApiForm';
import { HOST_STATUS } from '@/ui/labels';

export const dynamic = 'force-dynamic';

export default withActor(async (actor) => {
  requirePerm(actor, 'host.write');
  return (
    <>
      <PageHeader title="新增團主" />
      <Card>
        <ApiForm endpoint="/api/hosts" idempotent redirectTo="/hosts/{id}" submitLabel="建立團主" testid="host-create-form" successMessage="團主已建立" fields={[
          { name: 'displayName', label: '團主名稱', required: true }, { name: 'legalName', label: '法定名稱／公司' },
          { name: 'contactEmail', label: 'Email', type: 'email' }, { name: 'contactPhone', label: '電話' }, { name: 'lineId', label: 'LINE ID' },
          { name: 'status', label: '狀態', type: 'select', required: true, defaultValue: 'ACTIVE', options: Object.entries(HOST_STATUS).map(([k, l]) => ({ value: k, label: l.label })) },
          { name: 'audienceNote', label: '客群描述', type: 'textarea' }, { name: 'cooperationTerms', label: '合作條件', type: 'textarea' }, { name: 'internalNote', label: '內部備註（團主看不到）', type: 'textarea' },
        ]} />
      </Card>
    </>
  );
});
