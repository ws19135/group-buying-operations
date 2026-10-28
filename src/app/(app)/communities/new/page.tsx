import { withActor } from '@/server/ui/session';
import { requirePerm } from '@/server/lib/permissions';
import { Card, PageHeader } from '@/ui/components';
import { PLATFORM } from '@/ui/labels';
import { hostOptions } from '@/server/ui/options';
import { CommunityCreate } from './CommunityCreate';

export const dynamic = 'force-dynamic';

export default withActor(async (actor) => {
  requirePerm(actor, 'community.write');
  const hosts = await hostOptions(actor);
  return (
    <>
      <PageHeader title="新增社群" />
      <Card><CommunityCreate hosts={hosts} platforms={Object.entries(PLATFORM).map(([value, label]) => ({ value, label }))} /></Card>
    </>
  );
});
