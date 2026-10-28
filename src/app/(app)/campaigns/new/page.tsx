import { withActor } from '@/server/ui/session';
import { requirePerm, can } from '@/server/lib/permissions';
import { vendorOptions, hostOptions } from '@/server/ui/options';
import { PageHeader, Card } from '@/ui/components';
import { CampaignCreateForm } from './CampaignCreateForm';

export const dynamic = 'force-dynamic';

export default withActor(async (actor) => {
  requirePerm(actor, 'campaign.write');
  const [vendors, hosts] = await Promise.all([vendorOptions(actor), hostOptions(actor)]);
  return (
    <>
      <PageHeader title="建立檔期" sub="建立後會依標準流程模板自動產生任務與排程" />
      <Card><CampaignCreateForm vendors={vendors} hosts={hosts} canSetTarget={can(actor, 'campaign.sensitive.read')} /></Card>
    </>
  );
});
