import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import { makeWorld, type World } from './helpers';

let w: World;
beforeAll(async () => { w = await makeWorld(); });

describe('流程模板說明：英文縮寫保留、旁邊補中文', () => {
  it('新組織的預設模板：SOP 與 Phase 2 都有中文，且沒有未加註解的舊寫法', async () => {
    const [tpl] = await query<{ description: string }>(`SELECT description FROM workflow_templates WHERE organization_id=$1 AND key='GROUPBUY_STANDARD' AND version=1`, [w.orgId]);
    expect(tpl.description).toContain('G1–G5 Gate（核准關卡）');
    expect(tpl.description).toContain('groupbuy-flow-sop（團購標準作業流程）');
    const steps = await query<{ step_key: string; description: string | null }>(`SELECT s.step_key, s.description FROM workflow_template_steps s JOIN workflow_templates t ON t.id=s.template_id WHERE t.organization_id=$1`, [w.orgId]);
    expect(steps.length).toBeGreaterThanOrEqual(11);
    const text = steps.map((s) => s.description ?? '').join('\n');
    expect(text).toContain('SOP（標準作業流程）步驟 1');
    expect(text).toContain('SOP（標準作業流程）步驟 11');
    expect(text).not.toMatch(/SOP 步驟/);
    expect(text).toContain('第二階段（Phase 2）');
    expect(text).not.toMatch(/屬 Phase 2）/);
  });

  it('migration 015：把舊文字改成有中文的版本，可重跑；自訂說明裡的 SOP 也補中文，其餘文字不變', async () => {
    const OLD_TPL = '由 groupbuy-flow-sop 11 步作業與 G1–G5 Gate 轉換而成（ADR-004）';
    await query(`UPDATE workflow_templates SET description=$2 WHERE organization_id=$1 AND version=1`, [w.orgId, OLD_TPL]);
    await query(`UPDATE workflow_template_steps SET description='結算後開發票請款（SOP 步驟 11；實際入帳與分潤屬 Phase 2）' WHERE step_key='INVOICE_REQUEST' AND template_id IN (SELECT id FROM workflow_templates WHERE organization_id=$1)`, [w.orgId]);
    await query(`UPDATE workflow_template_steps SET description='自訂說明：SOP 步驟 X 其他字不變' WHERE step_key='SAMPLE_SHIP' AND template_id IN (SELECT id FROM workflow_templates WHERE organization_id=$1)`, [w.orgId]);
    const sql = fs.readFileSync(path.join(process.cwd(), 'migrations', '015_template_zh_gloss.sql'), 'utf8');
    await query(sql);
    await query(sql);   // 重跑不會重複加註解
    const [t] = await query<{ description: string }>(`SELECT description FROM workflow_templates WHERE organization_id=$1 AND version=1`, [w.orgId]);
    expect(t.description).toBe('由 groupbuy-flow-sop（團購標準作業流程）11 步作業與 G1–G5 Gate（核准關卡）轉換而成（ADR-004，架構決策紀錄）');
    const [inv] = await query<{ description: string }>(`SELECT s.description FROM workflow_template_steps s JOIN workflow_templates x ON x.id=s.template_id WHERE x.organization_id=$1 AND s.step_key='INVOICE_REQUEST'`, [w.orgId]);
    expect(inv.description).toBe('結算後開發票請款（SOP（標準作業流程）步驟 11；實際入帳與分潤屬第二階段（Phase 2））');
    const [c] = await query<{ description: string }>(`SELECT s.description FROM workflow_template_steps s JOIN workflow_templates x ON x.id=s.template_id WHERE x.organization_id=$1 AND s.step_key='SAMPLE_SHIP'`, [w.orgId]);
    expect(c.description).toBe('自訂說明：SOP（標準作業流程）步驟 X 其他字不變');
  });
});
