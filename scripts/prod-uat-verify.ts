/**
 * Live UAT 第 20 項：重新部署後資料不遺失。讀取 prod-uat.ts 寫出的快照，以管理者登入後逐項確認資料仍在。
 * 用法：BASE_URL=... UAT_ADMIN_EMAIL=... UAT_ADMIN_PASSWORD=<目前密碼> UAT_SNAPSHOT_FILE=uat-snapshot-xxx.json npx tsx scripts/prod-uat-verify.ts
 */
import fs from 'node:fs';
const BASE = (process.env.BASE_URL ?? '').replace(/\/$/, '');
async function main() {
  const snap = JSON.parse(fs.readFileSync(process.env.UAT_SNAPSHOT_FILE ?? '', 'utf8'));
  let cookie = '';
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${BASE}/api${p}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), origin: BASE }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) { const m = /^([^=]+)=([^;]*)/.exec(set); if (m) cookie = `${m[1]}=${m[2]}`; }
    const j = await res.json().catch(() => null); return { status: res.status, data: j?.data };
  };
  const l = await call('POST', '/auth/login', { email: process.env.UAT_ADMIN_EMAIL, password: process.env.UAT_ADMIN_PASSWORD });
  if (l.status !== 200) throw new Error('管理者登入失敗');
  const health = await call('GET', '/health');
  const v = await call('GET', `/vendors/${snap.vendorId}`); const c = await call('GET', `/campaigns/${snap.campaignId}`); const t = await call('GET', `/trials/${snap.trialId}`);
  const o = await call('GET', `/orders?campaignId=${snap.campaignId}`);
  const ok = v.status === 200 && c.status === 200 && t.status === 200 && (o.data?.items?.length ?? 0) === snap.orders;
  console.log(`${ok ? '✅' : '❌'} 重新部署後資料仍在：廠商 ${v.status}／檔期 ${c.status}／試用 ${t.status}／訂單 ${o.data?.items?.length}（期望 ${snap.orders}）；目前版本 ${health.data?.version}／commit ${String(health.data?.commit ?? '無').slice(0, 7)}`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e.message); process.exit(2); });
