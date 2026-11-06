import Link from 'next/link';
import { withActor, sp1, type SP } from '@/server/ui/session';
import { can, isInternal } from '@/server/lib/permissions';
import { forbidden } from '@/server/lib/errors';
import { hostOptions, vendorOptions } from '@/server/ui/options';
import { Banner, Card, PageHeader } from '@/ui/components';
import { CreateApplicationForm } from '../CollaborationForms';
import { collaborationProductOptions } from '../options';

export const dynamic = 'force-dynamic';

export default withActor(async (actor, props: { searchParams: SP }) => {
  if (!can(actor, 'collaboration.create')) throw forbidden();
  const q = await sp1(props.searchParams);
  const internal = isInternal(actor);
  const isHost = actor.role === 'HOST';
  const isVendor = actor.role === 'VENDOR';

  const vendors = isVendor
    ? (await vendorOptions(actor)).filter((o) => actor.vendorIds.includes(o.value))
    : internal ? await vendorOptions(actor) : [];
  const hosts = internal ? await hostOptions(actor) : isVendor ? await hostOptions(actor).catch(() => []) : [];
  const products = await collaborationProductOptions(actor.orgId, isVendor ? actor.vendorIds : null);

  const fixedHostId = isHost ? actor.hostIds[0] : (q.hostId || undefined);
  const fixedVendorId = isVendor && actor.vendorIds.length === 1 ? actor.vendorIds[0] : (q.vendorId || undefined);

  return (
    <>
      <PageHeader title="新增合作申請"
        sub={<><Link href={isHost ? '/collaboration/mine' : isVendor ? '/collaboration/vendor' : '/collaboration'}>返回列表</Link></>} />
      {isHost ? (
        <Banner kind="nodata">填好之後會送給營運審核，確認可供樣才會寄出。收件人姓名、電話與地址在申請建立後另外填寫，只會提供給需要寄送的廠商，而且有保留期限。</Banner>
      ) : null}
      {isVendor ? <Banner kind="nodata">你可以代團主建立申請，但只能選自己的商品。收件資訊仍由團主或營運填寫。</Banner> : null}
      <Card title="申請內容" testid="create-card">
        <CreateApplicationForm vendors={vendors} hosts={hosts} products={products}
          fixedHostId={fixedHostId} fixedVendorId={fixedVendorId} />
      </Card>
    </>
  );
});
