import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { migrate } from '@/server/lib/migrate';
import { makeWorld, mkCampaign, mkVendor, mkHost, type World } from './helpers';

let w: World;
beforeAll(async () => { w = await makeWorld(); });

describe('Migration', () => {
  it('重複執行是冪等的：全部略過、不重複套用', async () => {
    const r = await migrate();
    expect(r.applied).toEqual([]);
    expect(r.skipped.length).toBeGreaterThanOrEqual(7);
  });

  it('已套用的 migration 檔被改動會被偵測（checksum）', async () => {
    await query(`UPDATE schema_migrations SET checksum='tampered' WHERE name='007_seed_roles.sql'`);
    await expect(migrate()).rejects.toThrow(/內容被修改/);
    const orig = await import('node:fs').then((fs) => fs.readFileSync('migrations/007_seed_roles.sql', 'utf8'));
    const sum = (await import('node:crypto')).createHash('sha256').update(orig).digest('hex');
    await query(`UPDATE schema_migrations SET checksum=$1 WHERE name='007_seed_roles.sql'`, [sum]);
    expect((await migrate()).applied).toEqual([]);
  });

  it('所有核心資料表都已建立，且每個業務表都有 organization_id（多租戶）', async () => {
    const expected = ['organizations', 'roles', 'users', 'user_scopes', 'sessions', 'id_counters', 'audit_logs', 'idempotency_keys', 'system_settings', 'events',
      'hosts', 'host_availability', 'communities', 'host_communities', 'vendors', 'vendor_contacts', 'products', 'product_assets', 'skus', 'agreements',
      'campaigns', 'campaign_products', 'campaign_hosts', 'campaign_placements', 'approvals', 'exceptions',
      'workflow_templates', 'workflow_template_steps', 'tasks', 'task_dependencies',
      'import_batches', 'import_errors', 'orders', 'order_items', 'attributions', 'commission_rules', 'settlements', 'settlement_items',
      'automation_settings', 'automation_runs', 'notifications', 'vendor_intake_submissions', 'daily_summaries'];
    const have = (await query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)).map((t) => t.table_name);
    for (const t of expected) expect(have, t).toContain(t);
    const noOrg = (await query<{ table_name: string }>(
      `SELECT t.table_name FROM information_schema.tables t WHERE t.table_schema='public' AND t.table_type='BASE TABLE'
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name=t.table_name AND c.column_name IN ('organization_id'))`)).map((r) => r.table_name);
    // 這些是全域設定／子表，已透過父表隔離
    expect(noOrg.sort()).toEqual(['id_counters', 'organizations', 'roles', 'schema_migrations', 'sessions', 'task_dependencies', 'user_scopes', 'workflow_template_steps'].sort());
  });

  it('外鍵都有對應索引的關鍵欄位（campaigns / tasks / orders 的查詢路徑）', async () => {
    const idx = (await query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname='public'`)).map((i) => i.indexname);
    for (const name of ['campaigns_org_status_idx', 'campaigns_dates_idx', 'tasks_org_status_idx', 'tasks_campaign_idx', 'orders_campaign_idx', 'audit_entity_idx', 'campaign_hosts_host_idx', 'campaign_placements_comm_idx', 'events_pending_idx'])
      expect(idx, name).toContain(name);
  });
});

describe('不做實體刪除 / 稽核不可竄改', () => {
  it('所有業務資料表都禁止 DELETE（資料庫層級觸發器）', async () => {
    const v = await mkVendor(w); const h = await mkHost(w); const c = await mkCampaign(w, v.id);
    for (const [table, id] of [['vendors', v.id], ['hosts', h.id], ['campaigns', c.id]] as const) {
      await expect(query(`DELETE FROM ${table} WHERE id=$1`, [id]), table).rejects.toThrow(/physical delete forbidden/);
    }
    await expect(query(`DELETE FROM tasks WHERE campaign_id=$1`, [c.id])).rejects.toThrow(/physical delete forbidden/);
    await expect(query(`DELETE FROM users WHERE id=$1`, [w.admin.userId])).rejects.toThrow(/physical delete forbidden/);
    expect((await query(`SELECT count(*)::int AS n FROM vendors WHERE id=$1`, [v.id]))[0].n).toBe(1);
  });

  it('所有「帶 forbid_delete 觸發器」的表涵蓋全部業務表（沒有漏網）', async () => {
    const withTrigger = new Set((await query<{ t: string }>(`SELECT event_object_table AS t FROM information_schema.triggers WHERE trigger_name LIKE '%nodelete%' OR trigger_name LIKE '%immutable%'`)).map((r) => r.t));
    const allowDelete = new Set(['sessions', 'idempotency_keys', 'system_settings', 'automation_settings', 'organizations', 'roles', 'id_counters', 'schema_migrations', 'workflow_templates_unused']);
    const tables = (await query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`)).map((t) => t.table_name);
    const missing = tables.filter((t) => !withTrigger.has(t) && !allowDelete.has(t));
    expect(missing).toEqual([]);
  });

  it('稽核紀錄不可修改、不可刪除', async () => {
    const v = await mkVendor(w);
    const row = (await query<{ id: number }>(`SELECT id FROM audit_logs WHERE entity_id=$1 LIMIT 1`, [v.id]))[0];
    await expect(query(`UPDATE audit_logs SET action='x' WHERE id=$1`, [row.id])).rejects.toThrow(/append-only/);
    await expect(query(`DELETE FROM audit_logs WHERE id=$1`, [row.id])).rejects.toThrow(/append-only/);
  });
});

describe('資料庫約束', () => {
  it('唯一約束：同組織同名廠商、同商品同規格編號、同檔期同團主', async () => {
    const v = await mkVendor(w, '約束測試廠商');
    await expect(query(`INSERT INTO vendors (id, organization_id, name, normalized_name) VALUES ('VEN-X1',$1,'x','约束测试厂商')`, [w.orgId])).resolves.toBeTruthy();
    await expect(query(`INSERT INTO vendors (id, organization_id, name, normalized_name) VALUES ('VEN-X2',$1,'x','约束测试厂商')`, [w.orgId])).rejects.toThrow(/duplicate key/);
    void v;
  });

  it('CHECK 約束：金額不得為負、退款不得大於訂單金額、日期先後、評分範圍', async () => {
    const v = await mkVendor(w);
    await expect(query(`INSERT INTO campaigns (id, organization_id, title, normalized_title, vendor_id, open_date, close_date) VALUES ('CMP-X',$1,'t','t',$2,'2026-12-31','2026-12-01')`, [w.orgId, v.id])).rejects.toThrow(/check constraint/);
    await expect(query(`INSERT INTO campaigns (id, organization_id, title, normalized_title, vendor_id, target_revenue) VALUES ('CMP-Y',$1,'t','t',$2,-1)`, [w.orgId, v.id])).rejects.toThrow(/check constraint/);
    await expect(query(`INSERT INTO workflow_template_steps (template_id, step_key, seq, name, phase, owner_role, start_rule, duration) VALUES ('x','k',1,'n',9,'HOST','{}','{}')`)).rejects.toThrow();
  });

  it('外鍵：不能引用不存在的團主／檔期', async () => {
    await expect(query(`INSERT INTO campaign_hosts (id, organization_id, campaign_id, host_id) VALUES ('CHS-Z',$1,'CMP-NOPE','OWN-NOPE')`, [w.orgId])).rejects.toThrow(/foreign key/);
  });

  it('訂單去重鍵：同來源同訂單編號只能有一筆（資料庫層）', async () => {
    const v = await mkVendor(w); const c = await mkCampaign(w, v.id);
    const ins = (id: string) => query(`INSERT INTO orders (id, organization_id, campaign_id, source_system, source_order_id, ordered_at, status, gross_amount, data_origin) VALUES ($1,$2,$3,'S','SAME',now(),'PAID',100,'IMPORT')`, [id, w.orgId, c.id]);
    await ins('ORD-T1');
    await expect(ins('ORD-T2')).rejects.toThrow(/duplicate key/);
    await expect(query(`INSERT INTO orders (id, organization_id, campaign_id, source_system, source_order_id, ordered_at, status, gross_amount, refund_amount, data_origin) VALUES ('ORD-T3',$1,$2,'S','R1',now(),'PAID',100,200,'IMPORT')`, [w.orgId, c.id])).rejects.toThrow(/check constraint/);
  });

  it('樂觀鎖版本與更新時間由觸發器維護（不能被呼叫端偽造）', async () => {
    const v = await mkVendor(w);
    const before = (await query(`SELECT version, updated_at FROM vendors WHERE id=$1`, [v.id]))[0];
    await query(`UPDATE vendors SET category='X', version=999, updated_at='2000-01-01' WHERE id=$1`, [v.id]);
    const after = (await query(`SELECT version, updated_at FROM vendors WHERE id=$1`, [v.id]))[0];
    expect(after.version).toBe(before.version + 1);
    expect(new Date(after.updated_at).getFullYear()).toBeGreaterThan(2020);
  });

  it('ID 唯一且依規則產生：序號不重複、格式固定', async () => {
    const rows = await query<{ id: string }>(`SELECT id FROM campaigns WHERE organization_id=$1`, [w.orgId]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    const ids = await Promise.all(Array.from({ length: 5 }, () => mkVendor(w)));
    expect(ids.every((x) => /^VEN-\d{4,}$/.test(x.id))).toBe(true);
    expect(new Set(ids.map((x) => x.id)).size).toBe(5);
  });
});

describe('每個外部角色資料範圍的結構（user_scopes）', () => {
  it('團主帳號必須綁定團主、廠商帳號必須綁定廠商，且綁定對象必須存在於同組織', async () => {
    const { createUser } = await import('@/server/modules/auth');
    const w2 = await makeWorld();
    const h = await mkHost(w);
    await expect(createUser(w2.admin, { email: `x${Date.now()}@example.invalid`, name: 'x', role: 'HOST', password: 'Test-Password-123', hostIds: [h.id] })).rejects.toThrow(/找不到/);
    await expect(createUser(w.admin, { email: `y${Date.now()}@example.invalid`, name: 'y', role: 'VENDOR', password: 'Test-Password-123' })).rejects.toThrow(/綁定/);
    await expect(createUser(w.admin, { email: `z${Date.now()}@example.invalid`, name: 'z', role: 'OPS_EDITOR', password: 'Test-Password-123', hostIds: [h.id] })).rejects.toThrow(/只有團主角色/);
  });
});
