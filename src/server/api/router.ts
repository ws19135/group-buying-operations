import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';
import { SESSION_COOKIE } from '../lib/config';
import { actorFromToken, parseCookie } from '../modules/auth';
import type { Actor } from '../lib/permissions';

export interface Ctx {
  req: Request;
  actor: Actor;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  idemKey: string | null;
  requestId: string;
}

export interface PublicCtx extends Omit<Ctx, 'actor'> { actor: Actor | null }

/** 請求內容上限（訂單 CSV 上限 2 MB，其餘請求遠小於此） */
const MAX_BODY_BYTES = 4_000_000;

export type Handled = { status?: number; data: unknown; headers?: Record<string, string> };
export type Handler = (ctx: Ctx) => Promise<unknown | Handled>;
export type PublicHandler = (ctx: PublicCtx) => Promise<unknown | Handled>;

export interface RouteDef { method: string; path: string; handler: Handler | PublicHandler; public?: boolean }

const compiled = new Map<string, { re: RegExp; keys: string[]; def: RouteDef }[]>();

function compile(defs: RouteDef[]) {
  compiled.clear();
  for (const def of defs) {
    const keys: string[] = [];
    const re = new RegExp('^' + def.path.replace(/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    const arr = compiled.get(def.method) ?? [];
    arr.push({ re, keys, def });
    compiled.set(def.method, arr);
  }
}

export function isHandled(x: unknown): x is Handled {
  return !!x && typeof x === 'object' && 'data' in x && ('status' in x || 'headers' in x) && Object.keys(x).every((k) => ['status', 'data', 'headers'].includes(k));
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

function pgToApp(e: unknown): AppError | null {
  const code = (e as { code?: string })?.code;
  if (!code || typeof code !== 'string') return null;
  if (code === '23505') return new AppError('CONFLICT', '資料重複：相同的資料已存在');
  if (code === '23503') return new AppError('VALIDATION', '關聯的資料不存在或仍被使用中');
  // 22021／22P05：字串含 NUL 或無法轉碼；2201W／2201X：LIMIT／OFFSET 為負值——都是使用者輸入造成的，不是伺服器錯誤
  if (code === '23514' || code === '22P02' || code === '22007' || code === '22003' || code === '22021' || code === '22P05' || code === '2201W' || code === '2201X') return new AppError('VALIDATION', '欄位內容不符合規則');
  if (code === '23001') return new AppError('FORBIDDEN', '此資料不可實體刪除');
  if (code === '40001' || code === '40P01') return new AppError('CONFLICT', '系統忙碌，請稍後重試');
  return null;
}

export function toErrorResponse(e: unknown, requestId: string): Response {
  if (e instanceof ZodError) {
    const issues = e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return json(422, { error: { code: 'VALIDATION', message: issues.map((i) => (i.path ? `${i.path}：${i.message}` : i.message)).join('；'), details: issues, requestId } });
  }
  if (e instanceof AppError) return json(e.status, { error: { code: e.code, message: e.message, details: e.details, requestId } });
  const mapped = pgToApp(e);
  if (mapped) return json(mapped.status, { error: { code: mapped.code, message: mapped.message, requestId } });
  // 不把內部錯誤細節回傳給前端；完整錯誤只寫伺服器日誌
  console.error(`[api] ${requestId} unhandled`, e);
  return json(500, { error: { code: 'INTERNAL', message: '系統發生錯誤，請稍後再試；若持續發生請提供追蹤碼給管理者', requestId } });
}

/** 寫入請求的 Origin 必須等於這個請求自己的 Host（或反向代理帶來的 X-Forwarded-Host）；兩者任一相符即可，攻擊者無法控制瀏覽器送出的這兩個標頭 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true; // 非瀏覽器客戶端（腳本／測試）不會帶 Origin
  const hosts = [req.headers.get('host'), ...(req.headers.get('x-forwarded-host') ?? '').split(',')].map((h) => (h ?? '').trim()).filter(Boolean);
  try { return hosts.includes(new URL(origin).host); } catch { return false; }
}

export function setRoutes(defs: RouteDef[]) { compile(defs); }

export async function dispatch(req: Request, pathSegments: string[]): Promise<Response> {
  const requestId = randomUUID();
  const method = req.method.toUpperCase();
  try {
    const url = new URL(req.url);
    let path: string;
    try { path = '/' + pathSegments.map(encodeURIComponent).join('/').replace(/%40/g, '@'); } catch { return json(400, { error: { code: 'VALIDATION', message: '網址格式錯誤', requestId } }); }
    const candidates = compiled.get(method) ?? [];
    let hit: { params: Record<string, string>; def: RouteDef } | null = null;
    for (const c of candidates) {
      const m = c.re.exec(path);
      if (m) {
        try { hit = { params: Object.fromEntries(c.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])), def: c.def }; } catch { return json(400, { error: { code: 'VALIDATION', message: '網址格式錯誤', requestId } }); }
        break;
      }
    }
    if (!hit) {
      const otherMethod = [...compiled.entries()].some(([m2, arr]) => m2 !== method && arr.some((c) => c.re.test(path)));
      return json(otherMethod ? 405 : 404, { error: { code: 'NOT_FOUND', message: otherMethod ? '不支援的請求方法' : '找不到此 API（應用程式介面）', requestId } });
    }
    // NUL 字元無法存進 PostgreSQL 文字欄位；在入口就擋下，避免各個查詢各自出現 5xx
    for (const [k, v] of url.searchParams) if (k.includes('\u0000') || v.includes('\u0000')) return json(422, { error: { code: 'VALIDATION', message: '查詢參數含不允許的字元', requestId } });
    if (Object.values(hit.params).some((v) => v.includes('\u0000'))) return json(404, { error: { code: 'NOT_FOUND', message: '找不到此資料', requestId } });
    let body: unknown = undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      if (!sameOrigin(req)) return json(403, { error: { code: 'FORBIDDEN', message: '跨來源請求被拒絕', requestId } });
      const ct = req.headers.get('content-type') ?? '';
      const declared = Number(req.headers.get('content-length') ?? 0);
      if (declared > MAX_BODY_BYTES) return json(413, { error: { code: 'VALIDATION', message: '請求內容過大', requestId } });
      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) return json(413, { error: { code: 'VALIDATION', message: '請求內容過大', requestId } });
      if (text.includes('\u0000') || /\\u0000/i.test(text)) return json(422, { error: { code: 'VALIDATION', message: '內容含不允許的字元', requestId } });
      if (text) {
        if (!ct.includes('application/json')) return json(415, { error: { code: 'VALIDATION', message: '請求內容必須是 application/json', requestId } });
        try { body = JSON.parse(text); } catch { return json(400, { error: { code: 'VALIDATION', message: 'JSON 格式錯誤', requestId } }); }
      }
    }
    const token = parseCookie(req.headers.get('cookie'), SESSION_COOKIE);
    const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null;
    const actor = await actorFromToken(token, { requestId, ip, source: 'API' });
    if (!hit.def.public && !actor) return json(401, { error: { code: 'UNAUTHENTICATED', message: '請先登入', requestId } });
    const ctx = { req, actor, params: hit.params, query: url.searchParams, body, idemKey: req.headers.get('idempotency-key'), requestId } as Ctx;
    const out = await (hit.def.handler as (c: Ctx) => Promise<unknown>)(ctx);
    if (isHandled(out)) return json(out.status ?? 200, { data: out.data }, out.headers);
    return json(200, { data: out });
  } catch (e) {
    return toErrorResponse(e, requestId);
  }
}
