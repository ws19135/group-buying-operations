import { dispatch } from '@/server/api/router';
import '@/server/api/routes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ path: string[] }> };
const h = async (req: Request, ctx: Ctx) => dispatch(req, (await ctx.params).path);

export const GET = h;
export const POST = h;
export const PATCH = h;
export const DELETE = h;
export const PUT = h;
