import { redirect } from 'next/navigation';
import { requireActor } from '@/server/ui/session';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const a = await requireActor();
  if (a.role === 'HOST') redirect('/dashboard/host');
  if (a.role === 'VENDOR') redirect('/campaigns');
  redirect('/dashboard');
}
