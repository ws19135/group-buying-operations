import type { Tx } from '../lib/db';
import { query, withTx } from '../lib/db';
import { ids } from '../lib/ids';
import { hashPassword, validatePasswordStrength } from '../lib/password';
import { validation } from '../lib/errors';
import { audit } from '../lib/audit';
import { systemActor, type Actor } from '../lib/permissions';
import { ensureDefaultTemplate } from '../workflow/templates';
import { ensureAutomationSettings } from './automation';

/** 建立組織並完成基礎設定（預設流程模板、自動化開關預設全部停用） */
export async function createOrganization(name: string, source: Actor['source'] = 'SEED'): Promise<{ orgId: string; systemActor: Actor }> {
  if (!name.trim()) throw validation('請輸入組織名稱');
  return withTx(async (tx) => {
    const orgId = await ids.org(tx);
    await tx.query('INSERT INTO organizations (id, name) VALUES ($1,$2)', [orgId, name.trim()]);
    const sys = systemActor(orgId, source, 'bootstrap');
    await ensureDefaultTemplate(tx, sys);
    await audit(tx, sys, { action: 'organization.create', entityType: 'organization', entityId: orgId, after: { name } });
    return { orgId, systemActor: sys };
  }).then(async (r) => { await ensureAutomationSettings(r.orgId); return r; });
}

export async function createInitialUser(tx: Tx, orgId: string, u: { email: string; name: string; role: string; password: string; hostIds?: string[]; vendorIds?: string[] }): Promise<string> {
  const weak = validatePasswordStrength(u.password);
  if (weak) throw validation(weak);
  const id = await ids.user(tx);
  await tx.query('INSERT INTO users (id, organization_id, email, name, role_key, password_hash) VALUES ($1,$2,$3,$4,$5,$6)', [id, orgId, u.email, u.name, u.role, hashPassword(u.password)]);
  for (const h of u.hostIds ?? []) await tx.query(`INSERT INTO user_scopes (user_id, scope_type, scope_id) VALUES ($1,'HOST',$2)`, [id, h]);
  for (const v of u.vendorIds ?? []) await tx.query(`INSERT INTO user_scopes (user_id, scope_type, scope_id) VALUES ($1,'VENDOR',$2)`, [id, v]);
  return id;
}

export async function firstOrganization(): Promise<{ id: string; name: string } | null> {
  const r = await query<{ id: string; name: string }>('SELECT id, name FROM organizations ORDER BY id LIMIT 1');
  return r[0] ?? null;
}
