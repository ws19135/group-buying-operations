import '@/server/api/routes';
import { dispatch } from '@/server/api/router';
import type { Actor } from '@/server/lib/permissions';
import { PW, emailOf } from './helpers';

export interface ApiResult<T = any> { status: number; json: any; data: T; error?: { code: string; message: string; requestId: string }; headers: Headers } // eslint-disable-line @typescript-eslint/no-explicit-any

export class Client {
  cookie = '';
  constructor(public email?: string, public password: string = PW) {}

  static async forActor(actor: Actor): Promise<Client> {
    const c = new Client(emailOf(actor));
    const r = await c.call('POST', '/auth/login', { email: c.email, password: PW });
    if (r.status !== 200) throw new Error(`登入失敗 ${r.status} ${JSON.stringify(r.json)}`);
    return c;
  }

  async call<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResult<T>> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const [p, qs] = path.split('?');
    const url = `http://localhost:3000/api${p}${qs ? `?${qs}` : ''}`;
    const h: Record<string, string> = { ...headers };
    if (body !== undefined) h['content-type'] = h['content-type'] ?? 'application/json';
    if (this.cookie) h['cookie'] = this.cookie;
    const req = new Request(url, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const res = await dispatch(req, p.split('/').filter(Boolean));
    const set = res.headers.get('set-cookie');
    if (set) { const m = /^([^=]+)=([^;]*)/.exec(set); if (m) this.cookie = m[2] ? `${m[1]}=${m[2]}` : ''; }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return { status: res.status, json, data: json?.data, error: json?.error, headers: res.headers };
  }
}
