import type { Queryable } from '../lib/db';
import type { Actor } from '../lib/permissions';
import { ids } from '../lib/ids';
import { audit } from '../lib/audit';
import { notFound, validation } from '../lib/errors';
import { DEFAULT_PARAMS, DEFAULT_STEPS, DEFAULT_TEMPLATE_KEY } from './template-default';
import { validateTemplate, type Params, type StepDef } from './schedule';

export interface LoadedTemplate {
  id: string;
  key: string;
  version: number;
  name: string;
  params: Params;
  steps: StepDef[];
}

/** 把預設模板寫入資料庫（已存在則不動）。回傳模板 ID */
export async function ensureDefaultTemplate(db: Queryable, actor: Actor): Promise<string> {
  const ex = await db.query<{ id: string }>(
    'SELECT id FROM workflow_templates WHERE organization_id=$1 AND key=$2 AND version=1', [actor.orgId, DEFAULT_TEMPLATE_KEY]);
  if (ex.rows[0]) return ex.rows[0].id;
  validateTemplate(DEFAULT_STEPS);
  const id = await ids.template(db);
  await db.query(
    `INSERT INTO workflow_templates (id, organization_id, key, version, name, description, params, created_by)
     VALUES ($1,$2,$3,1,'標準團購流程','由 groupbuy-flow-sop（團購標準作業流程）11 步作業與 G1–G5 Gate（核准關卡）轉換而成（ADR-004，架構決策紀錄）',$4,$5)`,
    [id, actor.orgId, DEFAULT_TEMPLATE_KEY, JSON.stringify(DEFAULT_PARAMS), actor.userId]);
  await insertSteps(db, id, DEFAULT_STEPS);
  await audit(db, actor, { action: 'workflow_template.create', entityType: 'workflow_template', entityId: id, after: { key: DEFAULT_TEMPLATE_KEY, version: 1 } });
  return id;
}

async function insertSteps(db: Queryable, templateId: string, steps: StepDef[]) {
  for (const s of steps) {
    await db.query(
      `INSERT INTO workflow_template_steps (template_id, step_key, seq, name, phase, owner_role, kind, gate_key, start_rule, duration, depends_on, optional, condition_key, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [templateId, s.stepKey, s.seq, s.name, s.phase, s.ownerRole, s.kind, s.gateKey, JSON.stringify(s.startRule), JSON.stringify(s.duration),
        s.dependsOn, s.optional, s.conditionKey, s.description ?? null]);
  }
}

function rowToStep(r: Record<string, unknown>): StepDef {
  return {
    stepKey: r.step_key as string, seq: r.seq as number, name: r.name as string, phase: r.phase as number,
    ownerRole: r.owner_role as string, kind: r.kind as StepDef['kind'], gateKey: (r.gate_key as string | null) ?? null,
    startRule: r.start_rule as StepDef['startRule'], duration: r.duration as StepDef['duration'],
    dependsOn: r.depends_on as string[], optional: r.optional as boolean, conditionKey: (r.condition_key as StepDef['conditionKey']) ?? null,
    description: (r.description as string | null) ?? undefined,
  };
}

export async function loadTemplate(db: Queryable, orgId: string, templateId: string): Promise<LoadedTemplate> {
  const t = await db.query('SELECT * FROM workflow_templates WHERE id=$1 AND organization_id=$2', [templateId, orgId]);
  if (!t.rowCount) throw notFound('流程模板');
  const s = await db.query('SELECT * FROM workflow_template_steps WHERE template_id=$1 ORDER BY seq', [templateId]);
  return { id: t.rows[0].id, key: t.rows[0].key, version: t.rows[0].version, name: t.rows[0].name, params: t.rows[0].params, steps: s.rows.map(rowToStep) };
}

export async function loadActiveTemplate(db: Queryable, orgId: string, key = DEFAULT_TEMPLATE_KEY): Promise<LoadedTemplate> {
  const t = await db.query<{ id: string }>(
    `SELECT id FROM workflow_templates WHERE organization_id=$1 AND key=$2 AND status='ACTIVE' ORDER BY version DESC LIMIT 1`, [orgId, key]);
  if (!t.rows[0]) throw notFound('啟用中的流程模板');
  return loadTemplate(db, orgId, t.rows[0].id);
}

/**
 * 發佈新版本模板（只改天數參數）。舊版本標為 ARCHIVED，但已建立的檔期仍使用建立當下的參數快照，
 * 不會被默默改寫；要套用新參數須逐檔走「日期變更影響預覽」並確認。
 */
export async function publishTemplateVersion(db: Queryable, actor: Actor, key: string, paramsPatch: Params): Promise<{ id: string; version: number }> {
  const cur = await loadActiveTemplate(db, actor.orgId, key);
  const merged: Params = { ...cur.params };
  for (const [k, v] of Object.entries(paramsPatch)) {
    if (!(k in cur.params)) throw validation(`未知的參數：${k}`);
    if (!Number.isInteger(v) || v < 1 || v > 365) throw validation(`參數 ${k} 需為 1–365 的整數`);
    merged[k] = v;
  }
  const id = await ids.template(db);
  const version = cur.version + 1;
  await db.query(`UPDATE workflow_templates SET status='ARCHIVED' WHERE id=$1`, [cur.id]);
  await db.query(
    `INSERT INTO workflow_templates (id, organization_id, key, version, name, description, params, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, actor.orgId, key, version, cur.name, `由 v${cur.version} 調整參數而來`, JSON.stringify(merged), actor.userId]);
  await insertSteps(db, id, cur.steps);
  await audit(db, actor, { action: 'workflow_template.publish', entityType: 'workflow_template', entityId: id,
    before: { version: cur.version, params: cur.params }, after: { version, params: merged } });
  return { id, version };
}
