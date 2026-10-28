import { withActor } from '@/server/ui/session';
import { can, requirePerm } from '@/server/lib/permissions';
import { vendorOptions } from '@/server/ui/options';
import { Card, PageHeader } from '@/ui/components';
import { ProductCreateForm } from './ProductCreateForm';

export const dynamic = 'force-dynamic';

export default withActor(async (actor) => {
  requirePerm(actor, 'product.write');
  return (
    <>
      <PageHeader title="新增商品" sub="可同時建立第一個規格；更多規格建立後再到商品頁新增" />
      <Card><ProductCreateForm vendors={await vendorOptions(actor)} canCost={can(actor, 'product.cost.read')} /></Card>
    </>
  );
});
