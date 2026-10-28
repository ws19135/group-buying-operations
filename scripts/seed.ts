import crypto from 'node:crypto';
import { closePool, withTx } from '../src/server/lib/db';
import { migrate } from '../src/server/lib/migrate';
import { appEnv } from '../src/server/lib/config';
import { createInitialUser, createOrganization, firstOrganization } from '../src/server/modules/org';
import { loadEnv } from './load-env';

/** 基礎種子：組織、預設流程模板、初始系統管理者。不建立任何假的營運資料。 */
async function main() {
  loadEnv();
  await migrate();
  let org = await firstOrganization();
  if (!org) {
    const r = await createOrganization(process.env.ORG_NAME || '我的團購營運');
    org = { id: r.orgId, name: process.env.ORG_NAME || '我的團購營運' };
    console.log(`已建立組織 ${org.id}`);
  } else console.log(`組織已存在：${org.id}（略過）`);

  const email = process.env.ADMIN_EMAIL;
  if (!email) { console.log('未設定 ADMIN_EMAIL，略過建立管理者。'); return; }
  const exists = await withTx(async (tx) => (await tx.query('SELECT 1 FROM users WHERE lower(email)=lower($1) AND deleted_at IS NULL', [email])).rowCount);
  if (exists) { console.log('管理者帳號已存在（略過）'); return; }
  let pw = process.env.ADMIN_INITIAL_PASSWORD;
  let generated = false;
  if (!pw) {
    if (appEnv() === 'production') throw new Error('production 必須明確設定 ADMIN_INITIAL_PASSWORD');
    pw = `A1-${crypto.randomBytes(9).toString('base64url')}`;
    generated = true;
  }
  const id = await withTx((tx) => createInitialUser(tx, org.id, { email, name: process.env.ADMIN_NAME || '系統管理者', role: 'SYSTEM_ADMIN', password: pw as string }));
  console.log(`已建立管理者 ${id}（${email}）`);
  if (generated) console.log(`臨時密碼（只顯示這一次，請登入後立即記下或更換）：${pw}`);
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(closePool);
