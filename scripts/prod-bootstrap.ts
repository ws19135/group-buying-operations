/**
 * 正式環境初次建置（可重複執行、冪等）。**只建立空的正式系統**：schema、組織、預設流程模板、一位初次啟用的系統管理者。
 * 不建立任何 DEMO 或虛構資料；若資料庫已有 DEMO 資料，拒絕執行（避免把示範資料混進正式環境）。
 *
 * 必要環境變數（來自密鑰管理，**不得提交到 GitHub、不得寫進文件**）：
 *   APP_ENV=production、DATABASE_URL、ORG_NAME、ADMIN_EMAIL、ADMIN_INITIAL_PASSWORD（只在第一次建立管理者時需要）
 * 初次啟用：管理者帳號會被標記 must_change_password——第一次登入必須先設定自己的新密碼才能使用其他功能（後端 API 同樣擋）。
 * 密碼不會被印出或寫入 log。
 *
 * 用法：npm run prod:bootstrap          （建置或補齊）
 *   正式建置前會先詢問是否已依 docs/OWNER_SETUP_CHECKLIST.md 設置（互動輸入 yes；非互動需 BOOTSTRAP_CONFIRM=yes）。
 *       npm run prod:bootstrap -- --check   （唯讀檢查：是否已完成建置、有無 DEMO 資料；不寫入任何資料）
 */
import { closePool, query, withTx } from '../src/server/lib/db';
import { migrate } from '../src/server/lib/migrate';
import { appEnv } from '../src/server/lib/config';
import { createInitialUser, createOrganization, firstOrganization } from '../src/server/modules/org';
import { validateNewPassword } from '../src/server/modules/auth';
import { createInterface } from 'node:readline/promises';
import { loadEnv } from './load-env';

const checkOnly = process.argv.includes('--check');

async function demoRows(): Promise<number> {
  const q = async (sql: string) => Number((await query<{ n: number }>(sql))[0].n);
  const n = await q(`SELECT count(*)::int AS n FROM orders WHERE data_origin='DEMO'`)
    + await q(`SELECT count(*)::int AS n FROM vendors WHERE name LIKE '[DEMO]%'`)
    + await q(`SELECT count(*)::int AS n FROM hosts WHERE display_name LIKE '[DEMO]%'`)
    + await q(`SELECT count(*)::int AS n FROM products WHERE name LIKE '[DEMO]%'`)
    + await q(`SELECT count(*)::int AS n FROM users WHERE email LIKE 'demo-%@example.invalid'`);
  return n;
}

/** 正式建置前先詢問：是否已依 docs/OWNER_SETUP_CHECKLIST.md 設置。互動環境要輸入 yes；非互動（CI／腳本）必須明確給 BOOTSTRAP_CONFIRM=yes。
 *  任何其他回答都停止，並且在詢問之前不會對資料庫做任何寫入。 */
async function confirmChecklist() {
  if (process.env.BOOTSTRAP_CONFIRM === 'yes') return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('正式建置前需要確認已依 docs/OWNER_SETUP_CHECKLIST.md 設置。非互動環境請明確設定 BOOTSTRAP_CONFIRM=yes（表示你已確認）；否則請在終端機互動執行。');
  }
  console.log('\n即將在這個資料庫做「正式環境初次建置」（建立 schema、組織、一位初次啟用的系統管理者；不匯入任何資料）。');
  console.log('請先確認已依 docs/OWNER_SETUP_CHECKLIST.md 完成：');
  console.log('  1) 主機與防火牆（只開 22／80／443）   2) Docker 與部署帳號   3) 網域 DNS 已指向本主機');
  console.log('  4) 部署用 SSH 金鑰   5) GitHub Environments 與 Secrets   6) 主機已登入 ghcr.io');
  console.log('  7) .env.production（權限 600、密碼為隨機值、ADMIN_EMAIL 為真實公司信箱）');
  console.log('  8) 這是全新的空資料庫（不是現有營運資料庫）；staging 已通過 Live UAT 與備份還原演練\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question('以上都已照步驟設置完成嗎？輸入 yes 繼續，其他任何輸入都會停止：')).trim();
  rl.close();
  if (ans !== 'yes') throw new Error('已停止：尚未確認依清單設置。請先完成 docs/OWNER_SETUP_CHECKLIST.md，再重新執行。');
}

async function main() {
  loadEnv();
  if (appEnv() !== 'production') throw new Error('prod:bootstrap 只能在 APP_ENV=production 執行');
  if (process.env.ALLOW_DEMO_IN_PRODUCTION) throw new Error('正式環境不可設定 ALLOW_DEMO_IN_PRODUCTION（那是示範環境專用）');
  if ((process.env.AUTOMATION_ENABLED ?? 'off').toLowerCase() === 'on') console.warn('警告：AUTOMATION_ENABLED=on。正式環境啟用自動化前，需 Owner 逐項核准（見 DEPLOYMENT_RUNBOOK）。');

  if (checkOnly) {
    const org = await firstOrganization().catch(() => null);
    const admins = org ? Number((await query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE role_key='SYSTEM_ADMIN' AND status='ACTIVE' AND deleted_at IS NULL`))[0].n) : 0;
    const demo = org ? await demoRows() : 0;
    const mig = Number((await query<{ n: number }>(`SELECT count(*)::int AS n FROM schema_migrations`).catch(() => [{ n: 0 }]))[0].n);
    console.log(JSON.stringify({ organization: !!org, activeSystemAdmins: admins, demoRows: demo, migrationsApplied: mig }));
    if (!org || admins < 1) { console.error('尚未完成初次建置'); process.exitCode = 1; }
    if (demo > 0) { console.error('資料庫含 DEMO 資料，不可作為正式資料庫'); process.exitCode = 1; }
    return;
  }

  await confirmChecklist(); // 先詢問，再寫入（之前只有讀取／環境檢查）
  await migrate();
  if ((await demoRows()) > 0) throw new Error('這個資料庫含 DEMO／虛構資料，拒絕作為正式資料庫。請改用全新的空資料庫。');

  let org = await firstOrganization();
  if (!org) {
    const name = (process.env.ORG_NAME ?? '').trim();
    if (!name) throw new Error('第一次建置需要 ORG_NAME（公司或團購部門名稱）');
    const r = await createOrganization(name);
    org = { id: r.orgId, name };
    console.log(`已建立組織 ${org.id}`);
  } else console.log(`組織已存在：${org.id}（略過）`);

  const admins = Number((await query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE role_key='SYSTEM_ADMIN' AND deleted_at IS NULL`))[0].n);
  if (admins > 0) { console.log('已有系統管理者（略過；本程式不會新增、重設或變更任何既有帳號）'); return; }
  const email = (process.env.ADMIN_EMAIL ?? '').trim();
  const pw = process.env.ADMIN_INITIAL_PASSWORD ?? '';
  if (!email || !pw) throw new Error('第一次建置需要 ADMIN_EMAIL 與 ADMIN_INITIAL_PASSWORD（由密鑰管理提供；登入後會被強制變更）');
  if (/@example\.(invalid|com|org)$/i.test(email)) throw new Error('ADMIN_EMAIL 不可使用範例網域，請使用真實的公司信箱');
  const bad = validateNewPassword(pw, email);
  if (bad) throw new Error(`ADMIN_INITIAL_PASSWORD 不符合規則：${bad}`);
  const id = await withTx(async (tx) => {
    const uid = await createInitialUser(tx, (org as { id: string }).id, { email, name: process.env.ADMIN_NAME || '系統管理者', role: 'SYSTEM_ADMIN', password: pw });
    await tx.query('UPDATE users SET must_change_password=true WHERE id=$1', [uid]);
    return uid;
  });
  console.log(`已建立初次啟用的系統管理者 ${id}（${email}）；第一次登入必須先變更密碼。`);
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(closePool);
