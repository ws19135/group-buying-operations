import { randomUUID } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { SESSION_COOKIE } from '@/server/lib/config';
import { AppError } from '@/server/lib/errors';
import type { Actor } from '@/server/lib/permissions';
import { actorFromToken } from '@/server/modules/auth';

export async function getActor(): Promise<Actor | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const h = await headers();
  const ip = (h.get('x-forwarded-for') ?? '').split(',')[0].trim() || null;
  return actorFromToken(token, { requestId: randomUUID(), ip, source: 'WEB' });
}

export async function requireActor(): Promise<Actor> {
  const a = await getActor();
  if (!a) redirect('/login');
  return a;
}

function Forbidden({ message }: { message: string }) {
  return (
    <div className="card" data-testid="forbidden">
      <h2>你沒有權限檢視此頁</h2>
      <p className="muted">{message}</p>
      <a className="btn" href="/">回到首頁</a>
    </div>
  );
}

/** 包住頁面：未登入導向登入、權限不足顯示友善訊息、找不到資料顯示 404 */
export function withActor<P>(fn: (actor: Actor, props: P) => Promise<ReactNode>) {
  return async function Page(props: P): Promise<ReactNode> {
    const actor = await requireActor();
    try {
      return await fn(actor, props);
    } catch (e) {
      if (e instanceof AppError) {
        if (e.code === 'FORBIDDEN') return <Forbidden message={e.message} />;
        if (e.code === 'NOT_FOUND') notFound();
        if (e.code === 'UNAUTHENTICATED') redirect('/login');
      }
      throw e;
    }
  };
}

export type SP = Promise<Record<string, string | string[] | undefined>>;
export type Params<T extends string = 'id'> = Promise<Record<T, string>>;

export async function sp1(sp: SP): Promise<Record<string, string>> {
  const raw = await sp;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v !== '') out[k] = v;
  else if (Array.isArray(v) && v[0]) out[k] = v[0];
  return out;
}

export const toQuery = (o: Record<string, string>): URLSearchParams => new URLSearchParams(o);
