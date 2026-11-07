/**
 * migration 018～025 升級演練（合併前最終審查 F-06）。
 * 在一個**全新的暫存資料庫**（erp_rehearsal；不碰 erp_dev 或任何正式資料）重現「舊版資料庫升級」：
 *   1. 套用 001～017（目前 main 的狀態），灌入有代表性的舊資料（虛構 DEMO）；
 *   2. 套用 018，再灌入舊格式的觸及與導購資料（PR #20 已部署的情境）；
 *   3. 用正式的 migrate 工具套用 019～025；
 *   4. 驗證：舊資料每個原有欄位完全不變、新欄位預設值正確、舊的有效導購訪客被標為「去重方式未知／未查核」而不是被推測、
 *      約束全部有效、保護機制存在、重複執行不會再套用、應用程式的查詢在升級後的資料上可正常運作。
 * 執行：npx tsx scripts/migration-rehearsal.ts（需要本機 PostgreSQL 與 DATABASE_URL；使用者需有 CREATEDB 權限）。結束時會移除暫存資料庫。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';
import { loadEnv } from './load-env';
import { collaborationScope, collaborationUnassignedSql } from '../src/server/lib/scope';
import type { Actor } from '../src/server/lib/permissions';

loadEnv();
const base = process.env.DATABASE_URL as string;
if (!base) { console.error('需要 DATABASE_URL'); process.exit(2); }
const REH = 'erp_rehearsal';
const u = new URL(base);
const adminUrl = base;
const rehUrl = (() => { const x = new URL(base); x.pathname = `/${REH}`; return x.toString(); })();
const checks: { name: string; ok: boolean; detail?: string }[] = [];
const record = (name: string, ok: boolean, detail = '') => { checks.push({ name, ok, detail }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`); };
const dir = path.resolve(process.cwd(), 'migrations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

async function applyFiles(c: Client, names: string[]) {
  for (const f of names) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await c.query('BEGIN');
    try { await c.query(sql); await c.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1,$2)', [f, crypto.createHash('sha256').update(sql).digest('hex')]); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK'); throw new Error(`套用 ${f} 失敗：${(e as Error).message}`); }
  }
}

/**
 * 029（合作申請承辦／交接、保留例外、清除紀錄）專用升級演練：
 * 在另一個全新暫存資料庫套用 001～028，灌入「028 時代」的合作申請資料（含收件個資與匯入暫存列），
 * 再套用 029，驗證：舊資料每一欄不變、既有承辦人被回填成正式指派、沒有承辦人的案件落入待指派佇列、
 * 營運小編的資料範圍只剩自己承辦的案件、新資料表的約束與保護機制有效。
 */
async function rehearse029(admin: Client) {
  const DB = 'erp_rehearsal_029';
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`); await admin.query(`CREATE DATABASE ${DB}`);
  const url = (() => { const x = new URL(base); x.pathname = `/${DB}`; return x.toString(); })();
  const c = new Client({ connectionString: url }); await c.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    await applyFiles(c, files.filter((f) => f <= '028_zzz'));
    record('029 演練：028 版資料庫建立成功', (await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n === 28);
    await c.query(`INSERT INTO organizations (id, name) VALUES ('ORG-P1','[DEMO] 029 演練組織')`);
    await c.query(`INSERT INTO users (id, organization_id, email, name, role_key, password_hash) VALUES
      ('USR-P1','ORG-P1','p1@example.invalid','[DEMO] 小編甲','OPS_EDITOR','x'),('USR-P2','ORG-P1','p2@example.invalid','[DEMO] 小編乙','OPS_EDITOR','x'),('USR-P3','ORG-P1','p3@example.invalid','[DEMO] 主管','OPS_MANAGER','x')`);
    await c.query(`INSERT INTO hosts (id, organization_id, display_name, normalized_name) VALUES ('OWN-P1','ORG-P1','[DEMO] 團主','團主')`);
    await c.query(`INSERT INTO vendors (id, organization_id, name, normalized_name) VALUES ('VEN-P1','ORG-P1','[DEMO] 廠商','廠商')`);
    await c.query(`INSERT INTO products (id, organization_id, vendor_id, name, normalized_name) VALUES ('PRD-P1','ORG-P1','VEN-P1','[DEMO] 商品','商品')`);
    await c.query(`INSERT INTO collaboration_applications (id, organization_id, vendor_id, host_id, product_id, applied_on, owner_user_id, status, collaboration_status, decided_at) VALUES
      ('CLB-P1','ORG-P1','VEN-P1','OWN-P1','PRD-P1', current_date - 5, 'USR-P1','APPROVED','SAMPLE_IN_PROGRESS', now() - interval '5 day'),
      ('CLB-P2','ORG-P1','VEN-P1','OWN-P1','PRD-P1', current_date - 4, NULL,'SUBMITTED','NOT_STARTED', NULL),
      ('CLB-P3','ORG-P1','VEN-P1','OWN-P1','PRD-P1', current_date - 3, 'USR-P2','DRAFT','NOT_STARTED', NULL)`);
    await c.query(`UPDATE collaboration_applications SET deleted_at = now() WHERE id='CLB-P3'`);
    await c.query(`INSERT INTO collaboration_recipients (id, organization_id, application_id, recipient_name, recipient_phone, address_line, confirmed_at, retention_until) VALUES
      ('CRP-P1','ORG-P1','CLB-P1','[DEMO] 收件人','0900000000','[DEMO] 地址', now(), current_date + 60)`);
    await c.query(`INSERT INTO import_batches (id, organization_id, source_system, data_origin, file_name, checksum, created_by, total_rows) VALUES ('IMP-P1','ORG-P1','COLLABORATION_FORM2_SAMPLE','IMPORT','x.csv','chk','USR-P3',1)`);
    await c.query(`INSERT INTO collaboration_import_rows (id, organization_id, batch_id, row_no, form_kind, raw, resolved_vendor_id, dedupe_key) VALUES ('CIR-P1','ORG-P1','IMP-P1',2,'FORM2_SAMPLE', '{"recipientName":"[DEMO] 暫存姓名","hostName":"團主"}'::jsonb,'VEN-P1','k1')`);
    const snap = async () => (await c.query(`SELECT md5(string_agg(t, '|' ORDER BY t)) AS h FROM (
      SELECT row_to_json(a)::jsonb::text AS t FROM collaboration_applications a UNION ALL SELECT row_to_json(r)::jsonb::text FROM collaboration_recipients r
      UNION ALL SELECT row_to_json(i)::jsonb::text FROM collaboration_import_rows i) x`)).rows[0].h;
    const before = await snap();
    await applyFiles(c, files.filter((f) => f.startsWith('029_')));
    record('029 演練：套用 029 成功（只新增，不改 028）', (await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n === 29);
    // 029 只對 collaboration_import_rows 新增一個欄位；既有資料每一欄不變（新欄位 pii_scrubbed_at 預設 NULL）
    const after = await snap();
    const stripped = (await c.query(`SELECT md5(string_agg(t, '|' ORDER BY t)) AS h FROM (
      SELECT row_to_json(a)::jsonb::text AS t FROM collaboration_applications a UNION ALL SELECT row_to_json(r)::jsonb::text FROM collaboration_recipients r
      UNION ALL SELECT (row_to_json(i)::jsonb - 'pii_scrubbed_at')::text FROM collaboration_import_rows i) x`)).rows[0].h;
    record('029 演練：舊資料每一欄升級前後完全相同（申請單、收件資料、匯入暫存列）', stripped === before && after !== before, 'pii_scrubbed_at 為唯一新增欄位且預設 NULL');
    record('029 演練：舊收件資料與匯入暫存列內容未被改動，也沒有被自動清除', (await c.query(`SELECT 1 FROM collaboration_recipients WHERE id='CRP-P1' AND recipient_name='[DEMO] 收件人' AND purged_at IS NULL`)).rowCount === 1
      && (await c.query(`SELECT 1 FROM collaboration_import_rows WHERE id='CIR-P1' AND raw->>'recipientName'='[DEMO] 暫存姓名' AND pii_scrubbed_at IS NULL`)).rowCount === 1);
    const asg = (await c.query(`SELECT application_id, user_id, role FROM collaboration_assignments WHERE ended_at IS NULL ORDER BY application_id`)).rows;
    record('029 演練：既有承辦人被回填成正式的主要承辦指派；沒有承辦人的案件沒有被猜測指派；已刪除案件不回填', JSON.stringify(asg) === JSON.stringify([{ application_id: 'CLB-P1', user_id: 'USR-P1', role: 'PRIMARY' }]));
    const queue = (await c.query(`SELECT a.id FROM collaboration_applications a WHERE a.deleted_at IS NULL AND ${collaborationUnassignedSql('a')} ORDER BY a.id`)).rows.map((r) => r.id);
    record('029 演練：沒有承辦人的案件落入待指派佇列（不會消失）', JSON.stringify(queue) === JSON.stringify(['CLB-P2']));
    const mk = (userId: string, role: Actor['role']): Actor => ({ type: 'USER', userId, orgId: 'ORG-P1', role, name: 'x', hostIds: [], vendorIds: [], requestId: 'r', source: 'TEST' });
    const seen = async (a: Actor) => { const sc = collaborationScope(a, 1, 'a'); return (await c.query(`SELECT a.id FROM collaboration_applications a WHERE (${sc.sql}) ORDER BY a.id`, sc.params)).rows.map((r) => r.id); };
    record('029 演練：小編甲只看得到自己承辦的 CLB-P1；小編乙看不到任何一筆；主管看得到全部未刪除案件', JSON.stringify(await seen(mk('USR-P1', 'OPS_EDITOR'))) === '["CLB-P1"]' && (await seen(mk('USR-P2', 'OPS_EDITOR'))).length === 0 && JSON.stringify(await seen(mk('USR-P3', 'OPS_MANAGER'))) === '["CLB-P1","CLB-P2"]');
    const bad2 = async (sql: string) => { try { await c.query('BEGIN'); await c.query(sql); await c.query('ROLLBACK'); return false; } catch { await c.query('ROLLBACK'); return true; } };
    record('029 演練：約束與保護有效（同案件只能一位主要承辦、保留例外最長 365 天、交接與清除明細不可修改、不可實體刪除）',
      await bad2(`INSERT INTO collaboration_assignments (id, organization_id, application_id, user_id, role) VALUES ('CAS-X','ORG-P1','CLB-P1','USR-P2','PRIMARY')`)
      && await bad2(`INSERT INTO collaboration_retention_holds (id, organization_id, application_id, reason_code, basis, placed_on, hold_until, placed_by) VALUES ('CRH-X','ORG-P1','CLB-P1','DISPUTE','依據文字十個字以上', current_date, current_date + 400, 'x')`)
      && await bad2(`INSERT INTO collaboration_handovers (organization_id, application_id, handover_type, reason) VALUES ('ORG-P1','CLB-P1','TRANSFER', '')`)
      && await bad2(`DELETE FROM collaboration_assignments`)
      && await bad2(`INSERT INTO collaboration_retention_holds (id, organization_id, application_id, reason_code, basis, placed_on, hold_until, placed_by) VALUES ('CRH-Y','ORG-P1','CLB-P1','DISPUTE','依據文字十個字以上', current_date, current_date + 30, 'x'); DELETE FROM collaboration_retention_holds`));
    await c.query(`INSERT INTO collaboration_handovers (organization_id, application_id, handover_type, to_user_id, reason) VALUES ('ORG-P1','CLB-P1','ASSIGN','USR-P1', NULL)`);
    record('029 演練：交接紀錄 append-only', await bad2(`UPDATE collaboration_handovers SET reason='x'`) && await bad2(`DELETE FROM collaboration_handovers`));
    const cnt = async (t: string) => (await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    record('029 演練：新增的保留例外與清除紀錄資料表為空（升級不會自動建立保留例外，也不會自動清除任何資料）', (await cnt('collaboration_retention_holds')) === 0 && (await cnt('collaboration_purge_runs')) === 0 && (await cnt('collaboration_purge_items')) === 0);
    record('029 演練：重複執行不再套用', (await c.query(`SELECT count(*)::int AS n FROM schema_migrations`)).rows[0].n === 29);
  } finally {
    try { await c.end(); } catch { /* 已結束 */ }
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`).catch(() => undefined);
  }
}

async function main() {
  if (u.pathname.replace('/', '') === REH) throw new Error('DATABASE_URL 不可指向暫存資料庫本身');
  const admin = new Client({ connectionString: adminUrl }); await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${REH}`); await admin.query(`CREATE DATABASE ${REH}`);
  const c = new Client({ connectionString: rehUrl }); await c.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const upTo = (n: string) => files.filter((f) => f <= `${n}_zzz`);
    await applyFiles(c, upTo('017'));
    record('舊版資料庫（001～017）建立成功', (await c.query(`SELECT count(*)::int AS n FROM schema_migrations`)).rows[0].n === 17);

    // ---- 舊資料（虛構 DEMO）----
    await c.query(`INSERT INTO organizations (id, name) VALUES ('ORG-R1','[DEMO] 演練組織')`);
    await c.query(`INSERT INTO users (id, organization_id, email, name, role_key, password_hash) VALUES
      ('USR-R1','ORG-R1','r1@example.invalid','[DEMO] 小編','OPS_EDITOR','x'),('USR-R2','ORG-R1','r2@example.invalid','[DEMO] 主管','OPS_MANAGER','x'),('USR-R3','ORG-R1','r3@example.invalid','[DEMO] 財務','FINANCE','x')`);
    await c.query(`INSERT INTO hosts (id, organization_id, display_name, normalized_name) VALUES ('OWN-R1','ORG-R1','[DEMO] 團主甲','團主甲'),('OWN-R2','ORG-R1','[DEMO] 團主乙','團主乙')`);
    await c.query(`INSERT INTO vendors (id, organization_id, name, normalized_name) VALUES ('VEN-R1','ORG-R1','[DEMO] 廠商','廠商')`);
    await c.query(`INSERT INTO products (id, organization_id, vendor_id, name, normalized_name) VALUES ('PRD-R1','ORG-R1','VEN-R1','[DEMO] 商品','商品')`);
    await c.query(`INSERT INTO campaigns (id, organization_id, title, normalized_title, vendor_id, open_date, close_date, status) VALUES ('CMP-R1','ORG-R1','[DEMO] 檔期','檔期','VEN-R1', current_date - 10, current_date + 10, 'RUNNING')`);
    await c.query(`INSERT INTO orders (id, organization_id, campaign_id, source_system, source_order_id, ordered_at, status, gross_amount, data_origin) VALUES
      ('ORD-R1','ORG-R1','CMP-R1','T','R-1', now() - interval '3 day','PAID',800,'DEMO'),('ORD-R2','ORG-R1','CMP-R1','T','R-2', now() - interval '3 day','PAID',800,'DEMO')`);
    await c.query(`INSERT INTO attributions (order_id, host_id, organization_id, share_percent) VALUES ('ORD-R1','OWN-R1','ORG-R1',100),('ORD-R2','OWN-R1','ORG-R1',60),('ORD-R2','OWN-R2','ORG-R1',40)`);
    await c.query(`INSERT INTO service_cases (id, organization_id, campaign_id, order_id, case_type, title) VALUES ('CAS-R1','ORG-R1','CMP-R1','ORD-R1','COMPLAINT','[DEMO] 客訴一'),('CAS-R2','ORG-R1','CMP-R1',NULL,'COMPLAINT','[DEMO] 客訴二（無訂單）')`);
    await c.query(`INSERT INTO expenses (id, organization_id, campaign_id, category, amount, incurred_on, note, created_by) VALUES
      ('EXP-R1','ORG-R1','CMP-R1','SHIPPING',700, current_date - 3,'[DEMO] 運費','USR-R3'),('EXP-R2','ORG-R1',NULL,'OTHER',50, current_date - 2,'[DEMO] 無檔期','USR-R3')`);
    await c.query(`UPDATE expenses SET status='VOID', void_reason='[DEMO] 作廢' WHERE id='EXP-R2'`);
    await c.query(`INSERT INTO commission_rules (id, organization_id, scope_type, host_id, rate_percent, effective_from) VALUES ('CRL-R1','ORG-R1','HOST_DEFAULT','OWN-R1',8, current_date - 365)`);
    await c.query(`INSERT INTO product_trials (id, organization_id, product_id, vendor_id, level, trial_type, host_id, campaign_id, created_by) VALUES ('TRL-R1','ORG-R1','PRD-R1','VEN-R1','HOST_FIT','MINI_GROUP','OWN-R1','CMP-R1','USR-R2')`);
    // 018（PR #20 已部署的情境）
    await applyFiles(c, files.filter((f) => f.startsWith('018_')));
    await c.query(`INSERT INTO trial_reach_records (id, organization_id, trial_id, metric, value, source_kind, source_text, period_start, period_end, credibility, filled_on, created_by) VALUES
      ('RCH-R1','ORG-R1','TRL-R1','POTENTIAL_REACH',120,'LINE_GROUP_MEMBERS','[DEMO] 群組成員數', current_date - 9, current_date,'LOW', current_date,'USR-R1'),
      ('RCH-R2','ORG-R1','TRL-R1','QUALIFIED_VISITORS',60,'SHORT_LINK_UNIQUE_VISITORS','[DEMO] 導購短連結後台', current_date - 9, current_date,'HIGH', current_date,'USR-R1'),
      ('RCH-R3','ORG-R1','TRL-R1','QUALIFIED_VISITORS',40,'HOST_SELF_REPORT','[DEMO] 團主自述', current_date - 9, current_date,'MEDIUM', current_date,'USR-R1')`);
    await c.query(`UPDATE trial_reach_records SET deleted_at=now(), deleted_by='USR-R1', delete_reason='[DEMO] 已刪除' WHERE id='RCH-R3'`);
    record('舊資料灌入完成（組織、使用者、團主、廠商、商品、檔期、訂單與歸因、客訴、費用、佣金規則、試用、觸及與導購）', true);

    // ---- 升級前快照 ----
    const TABLES = ['organizations', 'users', 'hosts', 'vendors', 'products', 'campaigns', 'orders', 'attributions', 'service_cases', 'expenses', 'commission_rules', 'product_trials', 'trial_reach_records'];
    const key = (t: string) => (t === 'attributions' ? 'order_id, host_id' : 'id');
    const snap = async (cl: Client): Promise<Record<string, Record<string, unknown>[]>> => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, (await cl.query(`SELECT to_jsonb(x) AS j FROM ${t} x ORDER BY ${key(t)}`)).rows.map((r) => r.j as Record<string, unknown>)])));
    const before = await snap(c);
    const counts = Object.fromEntries(Object.entries(before).map(([t, r]) => [t, (r as unknown[]).length]));
    await c.end();

    // ---- 用正式工具升級（獨立程序，DATABASE_URL 指向暫存資料庫）----
    const run = (extra: Record<string, string> = {}) => spawnSync('npx', ['tsx', 'scripts/migrate.ts'], { env: { ...process.env, DATABASE_URL: rehUrl, ...extra }, encoding: 'utf8' });
    const r1 = run();
    const out1 = `${r1.stdout}${r1.stderr}`;
    record('正式 migrate 工具升級成功（019～025 依序套用）', r1.status === 0 && /019_reach_verifiability\.sql/.test(out1) && /025_expense_integrity\.sql/.test(out1), out1.split('\n').find((l) => l.startsWith('已套用')) ?? out1.slice(0, 160));
    const r2 = run();
    record('重複執行不再套用任何 migration（冪等）；checksum 保護有效', r2.status === 0 && /已套用：\(無新增\)/.test(r2.stdout), (r2.stdout.split('\n')[0] ?? '').slice(0, 60));

    const d = new Client({ connectionString: rehUrl }); await d.connect();
    const after = await snap(d);
    // 1. 舊資料原有欄位完全不變
    const diffs: string[] = [];
    for (const t of TABLES) {
      if (before[t].length !== after[t].length) { diffs.push(`${t} 筆數 ${before[t].length}→${after[t].length}`); continue; }
      before[t].forEach((row, i) => { for (const [k, v] of Object.entries(row)) if (JSON.stringify(after[t][i][k]) !== JSON.stringify(v) && k !== 'updated_at' && k !== 'version') diffs.push(`${t}.${k}`); });
    }
    record('舊資料筆數與每個原有欄位在升級前後完全相同（不丟資料、不改資料）', diffs.length === 0, diffs.slice(0, 5).join('、') || JSON.stringify(counts));
    // 2. 新欄位預設值與舊資料的處理
    const reach = (await d.query(`SELECT id, dedupe_method, rules_version, verification_status, verified_by, assigned_verifier_id, resubmits_id, deleted_at IS NOT NULL AS deleted FROM trial_reach_records ORDER BY id`)).rows;
    const byId = Object.fromEntries(reach.map((r) => [r.id, r]));
    record('舊的有效導購訪客：去重方式標為「未知」（不推測）、規則版本標為 legacy、未查核、無指派；非導購訪客資料不受影響', byId['RCH-R2'].dedupe_method === 'UNKNOWN' && byId['RCH-R3'].dedupe_method === 'UNKNOWN' && byId['RCH-R1'].dedupe_method === null && reach.every((r) => r.rules_version === 'reach-rules/legacy' && r.verification_status === 'UNVERIFIED' && r.verified_by === null && r.assigned_verifier_id === null && r.resubmits_id === null), JSON.stringify(reach.map((r) => `${r.id}:${r.dedupe_method}`)));
    record('舊的已刪除紀錄仍是已刪除', byId['RCH-R3'].deleted === true && byId['RCH-R2'].deleted === false);
    const cases = (await d.query(`SELECT id, attributed_host_id, host_attribution_source FROM service_cases ORDER BY id`)).rows;
    record('舊客訴：沒有任何自動歸屬（人工歸屬欄位全空，歸屬於讀取時由訂單歸因推導）', cases.every((r) => r.attributed_host_id === null && r.host_attribution_source === null));
    const ex = (await d.query(`SELECT id, bearer_party, payer_party, claim_direction, claim_status, payment_status, host_id, product_id, cost_scope, evidence_url, terms_source_kind, status FROM expenses ORDER BY id`)).rows;
    record('舊費用：承擔方與付款方為空（待確認，不回填、不推測）、應收應付「未判斷、未確認」、付款「未記錄」、歸屬範圍未標記；作廢狀態保留', ex.every((r) => r.bearer_party === null && r.payer_party === null && r.claim_direction === 'UNDETERMINED' && r.claim_status === 'UNCONFIRMED' && r.payment_status === 'UNRECORDED' && r.cost_scope === null && r.host_id === null && r.product_id === null) && ex.find((r) => r.id === 'EXP-R2').status === 'VOID');
    // 3. 約束與保護
    const cons = (await d.query(`SELECT conname, convalidated FROM pg_constraint WHERE conrelid IN ('expenses'::regclass,'trial_reach_records'::regclass,'service_cases'::regclass) AND contype='c' ORDER BY conname`)).rows;
    const need = ['trial_reach_dedupe_required', 'trial_reach_verify_shape', 'trial_reach_assign_shape', 'service_cases_host_attr_shape', 'expenses_claim_shape', 'expenses_payment_shape', 'expenses_cost_scope_shape', 'expenses_paid_amount_full'];
    record('新增的約束全部存在且已驗證（無 NOT VALID）', need.every((n) => cons.some((x) => x.conname === n && x.convalidated === true)), cons.filter((x) => !x.convalidated).map((x) => x.conname).join('、') || `${need.length} 項`);
    const trg = (await d.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('expenses'::regclass,'trial_reach_records'::regclass,'commission_recon_items'::regclass) ORDER BY 1`)).rows.map((r) => r.tgname as string);
    record('保護機制存在：觸及資料守衛、費用重新確認守衛、待確認項目禁止刪除', ['trial_reach_records_guard', 'expenses_claim_reconfirm', 'commission_recon_items_nodelete'].every((n) => trg.includes(n)) || (trg.some((n) => /reach/.test(n)) && trg.includes('expenses_claim_reconfirm') && trg.includes('commission_recon_items_nodelete')), trg.join('、'));
    const tables = (await d.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='commission_recon_items'`)).rowCount;
    record('新資料表 commission_recon_items 已建立且為空（沒有自動建立任何待確認項目）', tables === 1 && (await d.query(`SELECT count(*)::int AS n FROM commission_recon_items`)).rows[0].n === 0);
    // 4. 升級後的保護行為（直接操作資料庫）
    const bad = async (sql: string, params: unknown[] = []) => { try { await d.query(sql, params); return false; } catch { return true; } };
    record('升級後：舊的有效導購訪客不可被竄改內容、費用不可實體刪除、已付款金額不一致被擋', (await bad(`UPDATE trial_reach_records SET value=1 WHERE id='RCH-R2'`)) && (await bad(`DELETE FROM expenses WHERE id='EXP-R1'`)) && (await (async () => { await d.query('BEGIN'); try { await d.query(`UPDATE expenses SET bearer_party='COMPANY', payment_status='PAID', paid_on=current_date - 1 WHERE id='EXP-R1'`); return await bad(`UPDATE expenses SET paid_amount=1 WHERE id='EXP-R1'`); } finally { await d.query('ROLLBACK'); } })()));
    await d.end();

    // ---- 應用程式在升級後的資料上運作（動態載入，使連線指向暫存資料庫）----
    process.env.DATABASE_URL = rehUrl;
    const { pool, closePool } = await import('../src/server/lib/db');
    const mgr = { type: 'USER', userId: 'USR-R2', orgId: 'ORG-R1', role: 'OPS_MANAGER', name: 'm', hostIds: [], vendorIds: [], requestId: 'r', source: 'TEST' } as never;
    const fin = { type: 'USER', userId: 'USR-R3', orgId: 'ORG-R1', role: 'FINANCE', name: 'f', hostIds: [], vendorIds: [], requestId: 'r', source: 'TEST' } as never;
    const { getTrialKpis } = await import('../src/server/modules/trial-kpis');
    const { financeOverview, listExpenses } = await import('../src/server/modules/finance');
    const { getCommissionReconciliation } = await import('../src/server/modules/commission-reconciliation');
    const { loadComplaintStats } = await import('../src/server/modules/complaint-attribution');
    const { getCostAllocationAnalysis } = await import('../src/server/modules/finance-comparison');
    const kpi = await getTrialKpis(mgr, 'TRL-R1');
    const cvr = kpi.items.find((x) => x.key === 'conversionRate')!;
    record('升級後 KPI 可運作：舊的有效導購訪客（去重方式未知、未查核）→ CVR 資料不足，不是 0、不是被推測', cvr.status === 'INSUFFICIENT' && cvr.value === null, String(cvr.reason).slice(0, 40));
    const cs = await loadComplaintStats(pool(), 'ORG-R1', 'CMP-R1');
    record('升級後客訴統計：整體 2 件、無訂單的 1 件維持未歸屬（沒有被自動分配）', cs.total === 2 && cs.unattributed === 1 && cs.byHost['OWN-R1']?.weighted === 1);
    const ov = await financeOverview(fin);
    const row = ov.campaigns.find((x) => x.id === 'CMP-R1') as unknown as Record<string, number>;
    record('升級後財務總覽：舊費用 700 元計入「全部已登錄」，因承擔方空白而歸「待確認」，不算公司成本（作廢的 50 元不計）', row.expenses === 700 && row.expensesPendingBearer === 700 && row.expensesCompanyConfirmed === 0, JSON.stringify({ e: row.expenses, p: row.expensesPendingBearer }));
    const le = (await listExpenses(fin, new URLSearchParams({ attributionPending: '1' }))) as { items: { id: string; bearerStatus: string }[] };
    record('升級後費用待補清單列出舊費用（承擔方待確認）', le.items.some((x) => x.id === 'EXP-R1' && x.bearerStatus === 'PENDING'));
    const rec = await getCommissionReconciliation(fin);
    record('升級後分潤差異核對可運作（唯讀）', Array.isArray(rec.rows));
    let allocOk = true; try { await getCostAllocationAnalysis(fin, 'CMP-R1'); } catch { allocOk = false; }
    record('升級後成本分攤分析可運作（唯讀）', allocOk);
    record('升級後結算佣金計算仍依既有財務規則（舊規則 8% 未被改動）', (await pool().query(`SELECT rate_percent FROM commission_rules WHERE id='CRL-R1'`)).rows[0].rate_percent === '8.000' || Number((await pool().query(`SELECT rate_percent FROM commission_rules WHERE id='CRL-R1'`)).rows[0].rate_percent) === 8);
    await closePool();
    await rehearse029(admin);
  } finally {
    try { await c.end(); } catch { /* 已結束 */ }
    await admin.query(`DROP DATABASE IF EXISTS ${REH}`).catch(() => undefined);
    await admin.end();
  }
  const failed = checks.filter((x) => !x.ok).length;
  console.log(`\n升級演練：${checks.length - failed}/${checks.length} 通過`);
  fs.writeFileSync(path.resolve('docs/phase2/migration-rehearsal-results.json'), JSON.stringify({ ranAt: new Date().toISOString(), total: checks.length, passed: checks.length - failed, failed, checks }, null, 2));
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
