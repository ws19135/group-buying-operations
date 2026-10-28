import crypto from 'node:crypto';
import { z } from 'zod';
import { query, withTx, type Tx } from '../lib/db';
import { SESSION_TTL_HOURS } from '../lib/config';
import { AppError, validation, notFound } from '../lib/errors';
import { hashPassword, validatePasswordStrength, verifyPassword } from '../lib/password';
import { isRole, type Actor, type RoleKey, requirePerm } from '../lib/permissions';
import { audit } from '../lib/audit';
import { ids } from '../lib/ids';

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

interface UserRow {
  id: string; organization_id: string; email: string; name: string; role_key: string;
  password_hash: string; status: string; failed_login_count: number; locked_until: Date | null;
}

async function loadScopes(userId: string, db: { query: Tx['query'] } | null = null): Promise<{ hostIds: string[]; vendorIds: string[] }> {
  const rows = db
    ? (await db.query('SELECT scope_type, scope_id FROM user_scopes WHERE user_id=$1 AND revoked_at IS NULL', [userId])).rows
    : await query<{ scope_type: string; scope_id: string }>('SELECT scope_type, scope_id FROM user_scopes WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
  const r = rows as { scope_type: string; scope_id: string }[];
  return {
    hostIds: r.filter((x) => x.scope_type === 'HOST').map((x) => x.scope_id),
    vendorIds: r.filter((x) => x.scope_type === 'VENDOR').map((x) => x.scope_id),
  };
}

export interface LoginResult { token: string; expiresAt: Date; actor: Actor }

/** 帳號密碼登入。錯誤訊息一律模糊，不洩漏帳號是否存在；連續失敗會暫時鎖定 */
export async function login(email: string, password: string, ctx: { ip?: string | null; userAgent?: string | null; requestId: string }): Promise<LoginResult> {
  const generic = new AppError('UNAUTHENTICATED', '帳號或密碼錯誤');
  const rows = await query<UserRow>(
    'SELECT * FROM users WHERE lower(email)=lower($1) AND deleted_at IS NULL', [email.trim()]);
  const u = rows[0];
  if (!u) {
    // 對不存在的帳號也做一次雜湊，降低以回應時間枚舉帳號的可能
    verifyPassword(password, hashPassword('dummy-password-1'));
    throw generic;
  }
  if (u.status !== 'ACTIVE') throw generic;
  if (u.locked_until && u.locked_until.getTime() > Date.now()) {
    throw new AppError('RATE_LIMITED', `登入失敗次數過多，請於 ${LOCK_MINUTES} 分鐘後再試`);
  }
  if (!verifyPassword(password, u.password_hash)) {
    await query(
      `UPDATE users SET failed_login_count = failed_login_count + 1,
         locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
       WHERE id=$1`, [u.id, MAX_FAILS, String(LOCK_MINUTES)]);
    throw generic;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600_000);
  await query('INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)',
    [sha256(token), u.id, expiresAt, ctx.ip ?? null, (ctx.userAgent ?? '').slice(0, 300)]);
  await query('UPDATE users SET failed_login_count=0, locked_until=NULL, last_login_at=now() WHERE id=$1', [u.id]);
  const scopes = await loadScopes(u.id);
  const actor: Actor = {
    type: 'USER', userId: u.id, orgId: u.organization_id, role: u.role_key as RoleKey, name: u.name,
    ...scopes, requestId: ctx.requestId, source: 'WEB', ip: ctx.ip ?? null,
  };
  await query(
    `INSERT INTO audit_logs (organization_id, actor_user_id, actor_role, action, entity_type, entity_id, request_id, source, ip)
     VALUES ($1,$2,$3,'user.login','user',$2,$4,'WEB',$5)`, [u.organization_id, u.id, u.role_key, ctx.requestId, ctx.ip ?? null]);
  return { token, expiresAt, actor };
}

export async function logout(token: string): Promise<void> {
  await query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL', [sha256(token)]);
}

/** 由 session token 取得 Actor；無效、過期、已撤銷、帳號停用一律回傳 null */
export async function actorFromToken(token: string | null | undefined, ctx: { requestId: string; ip?: string | null; source?: Actor['source'] }): Promise<Actor | null> {
  if (!token) return null;
  const rows = await query<UserRow & { expires_at: Date; revoked_at: Date | null }>(
    `SELECT u.*, s.expires_at, s.revoked_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash=$1`, [sha256(token)]);
  const r = rows[0];
  if (!r || r.revoked_at || r.expires_at.getTime() < Date.now() || r.status !== 'ACTIVE') return null;
  const scopes = await loadScopes(r.id);
  return {
    type: 'USER', userId: r.id, orgId: r.organization_id, role: r.role_key as RoleKey, name: r.name,
    ...scopes, requestId: ctx.requestId, source: ctx.source ?? 'WEB', ip: ctx.ip ?? null,
  };
}

export function parseCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// ---------------- 使用者管理（系統管理者） ----------------
export const createUserSchema = z.object({
  email: z.string().email('Email 格式不正確'),
  name: z.string().trim().min(1, '請輸入姓名').max(80),
  role: z.string().refine(isRole, '角色不正確'),
  password: z.string(),
  hostIds: z.array(z.string()).optional(),
  vendorIds: z.array(z.string()).optional(),
});

export async function createUser(actor: Actor, raw: z.input<typeof createUserSchema>) {
  requirePerm(actor, 'user.manage');
  const input = createUserSchema.parse(raw);
  const weak = validatePasswordStrength(input.password);
  if (weak) throw validation(weak);
  const role = input.role as RoleKey;
  if (role === 'HOST' && !(input.hostIds?.length)) throw validation('團主帳號必須綁定至少一位團主（hostIds）');
  if (role === 'VENDOR' && !(input.vendorIds?.length)) throw validation('廠商帳號必須綁定至少一家廠商（vendorIds）');
  if (role !== 'HOST' && input.hostIds?.length) throw validation('只有團主角色可以綁定團主資料範圍');
  if (role !== 'VENDOR' && input.vendorIds?.length) throw validation('只有廠商角色可以綁定廠商資料範圍');
  return withTx(async (tx) => {
    for (const hid of input.hostIds ?? []) {
      const h = await tx.query('SELECT 1 FROM hosts WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [hid, actor.orgId]);
      if (!h.rowCount) throw notFound(`團主 ${hid}`);
    }
    for (const vid of input.vendorIds ?? []) {
      const v = await tx.query('SELECT 1 FROM vendors WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', [vid, actor.orgId]);
      if (!v.rowCount) throw notFound(`廠商 ${vid}`);
    }
    const dupe = await tx.query('SELECT 1 FROM users WHERE lower(email)=lower($1) AND deleted_at IS NULL', [input.email]);
    if (dupe.rowCount) throw new AppError('CONFLICT', '此 Email 已有帳號');
    const id = await ids.user(tx);
    await tx.query(
      `INSERT INTO users (id, organization_id, email, name, role_key, password_hash, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [id, actor.orgId, input.email.trim(), input.name, role, hashPassword(input.password), actor.userId]);
    for (const hid of input.hostIds ?? []) await tx.query(`INSERT INTO user_scopes (user_id, scope_type, scope_id, created_by) VALUES ($1,'HOST',$2,$3)`, [id, hid, actor.userId]);
    for (const vid of input.vendorIds ?? []) await tx.query(`INSERT INTO user_scopes (user_id, scope_type, scope_id, created_by) VALUES ($1,'VENDOR',$2,$3)`, [id, vid, actor.userId]);
    await audit(tx, actor, { action: 'user.create', entityType: 'user', entityId: id, after: { email: input.email, name: input.name, role, hostIds: input.hostIds ?? [], vendorIds: input.vendorIds ?? [] } });
    return { id, email: input.email, name: input.name, role };
  });
}

export async function listUsers(actor: Actor) {
  requirePerm(actor, 'user.manage');
  return query(
    `SELECT u.id, u.email, u.name, u.role_key AS role, u.status, u.last_login_at,
       COALESCE((SELECT array_agg(scope_type || ':' || scope_id) FROM user_scopes s WHERE s.user_id=u.id AND s.revoked_at IS NULL), '{}') AS scopes
     FROM users u WHERE u.organization_id=$1 AND u.deleted_at IS NULL ORDER BY u.id`, [actor.orgId]);
}

export async function setUserStatus(actor: Actor, userId: string, status: 'ACTIVE' | 'DISABLED') {
  requirePerm(actor, 'user.manage');
  if (userId === actor.userId) throw validation('不能停用自己的帳號');
  return withTx(async (tx) => {
    const r = await tx.query('SELECT status FROM users WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL FOR UPDATE', [userId, actor.orgId]);
    if (!r.rowCount) throw notFound('使用者');
    const before = r.rows[0].status;
    await tx.query('UPDATE users SET status=$2, updated_by=$3 WHERE id=$1', [userId, status, actor.userId]);
    if (status === 'DISABLED') await tx.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
    await audit(tx, actor, { action: 'user.set_status', entityType: 'user', entityId: userId, before: { status: before }, after: { status } });
    return { id: userId, status };
  });
}
