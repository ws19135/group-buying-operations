import { closePool, query } from '../src/server/lib/db';
import { migrate } from '../src/server/lib/migrate';
import { appEnv } from '../src/server/lib/config';
import type { Actor, RoleKey } from '../src/server/lib/permissions';
import { addDays } from '../src/server/lib/dates';
import { todayTaipei } from '../src/server/lib/ids';
import { createEvaluation, reviewEvaluation, submitEvaluation, updateEvaluation } from '../src/server/modules/selection';
import { createSupplement } from '../src/server/modules/selection-v2';
import { createEvidence } from '../src/server/modules/evidence';
import { loadEnv } from './load-env';

/**
 * 選品評估 V2 DEMO 種子（子條件評分）。必須先執行 db:seed:demo 與 db:seed:demo:selection。
 * 冪等：已有 V2 評估就略過。拒絕在 production 執行（除非明確允許公開示範環境）。全部虛構；證據連結是保留網域 docs.example.invalid。
 * 清爽防曬噴霧：已送出的 V2 評估，系統帶入歷史訂單等資料、人工確認其餘條件；廠商調查未核准 → 硬性條件未知，最多只能補件；主管覆核「需補資料」並提出補件要求。
 * 保濕面膜：進行中的 V2 草稿，系統帶入廠商調查、試用、可行性；沒有資料的項目顯示「未知」與原因（未知不當 0 分）。
 */
async function main() {
  loadEnv();
  if (appEnv() === 'production' && process.env.ALLOW_DEMO_IN_PRODUCTION !== 'yes') {
    throw new Error('拒絕在 production 建立 DEMO 資料。只有「公開示範環境」才可設定 ALLOW_DEMO_IN_PRODUCTION=yes');
  }
  await migrate();
  const actorOf = async (key: string, role: RoleKey): Promise<Actor> => {
    const [u] = await query<{ id: string; organization_id: string }>(`SELECT id, organization_id FROM users WHERE lower(email)=$1 AND deleted_at IS NULL`, [`demo-${key}@example.invalid`]);
    if (!u) throw new Error(`找不到 demo-${key}，請先執行 npm run db:seed:demo`);
    return { type: 'USER', userId: u.id, orgId: u.organization_id, role, name: `demo-${key}`, hostIds: [], vendorIds: [], requestId: 'demo-selection-v2', source: 'SEED' };
  };
  const manager = await actorOf('manager', 'OPS_MANAGER');
  const editor = await actorOf('editor', 'OPS_EDITOR');
  const orgId = manager.orgId;
  if ((await query(`SELECT 1 FROM product_evaluations WHERE organization_id=$1 AND rubric_version=2 LIMIT 1`, [orgId])).length) { console.log('選品 V2 DEMO 資料已存在（略過）。'); return; }
  const prod = async (name: string) => {
    const [r] = await query<{ id: string }>(`SELECT id FROM products WHERE organization_id=$1 AND name=$2 AND deleted_at IS NULL`, [orgId, name]);
    if (!r) throw new Error(`找不到商品 ${name}，請先執行 npm run db:seed:demo`);
    return r.id;
  };
  const pMask = await prod('[DEMO] 保濕面膜');
  const pSun = await prod('[DEMO] 清爽防曬噴霧');
  const today = todayTaipei();
  const ev = (as: Actor, evalId: string, kind: string, title: string) =>
    createEvidence(as, { subjectType: 'EVALUATION', subjectId: evalId, kind, title: `[DEMO] ${title}`, url: `https://docs.example.invalid/demo/${encodeURIComponent(title)}`, sourceLabel: '[DEMO] 虛構文件', validUntil: addDays(today, 240) } as never);

  // ---- 1. 清爽防曬噴霧：已送出（含覆核與補件要求）。歷史訂單由系統帶入；廠商層級尚無核准的調查 → 「硬性條件未確認」，高分也最多只能補件 ----
  const e1 = (await createEvaluation(editor, pSun)).id;
  const cert = await ev(editor, e1, 'CERTIFICATE', '防曬產品登錄文件');
  const demand = await ev(editor, e1, 'OTHER', '社群詢問彙整');
  const claim = await ev(editor, e1, 'TEST_REPORT', '宣稱佐證報告');
  await updateEvaluation(editor, e1, {
    commerceModel: 'MOM_GROUP',
    conditions: {
      NEED_SEGMENT_MATCH: { value: true }, NEED_PRICE_ACCEPTABLE: { value: true }, NEED_DEMAND_PROOF: { value: true, evidenceIds: [demand.id] },
      QUAL_CERTS: { value: true, evidenceIds: [cert.id] }, CON_USP_CLEAR: { value: true }, CON_CLAIM_VERIFIED: { value: true, evidenceIds: [claim.id] }, REP_CONSUMABLE: { value: 'SEMI' },
    } as never,
    compliance: { status: 'PASS', note: '[DEMO] 標示與廣告用語已逐項核對（虛構）' },
  });
  await submitEvaluation(editor, e1);
  await reviewEvaluation(manager, e1, { decision: 'NEEDS_MORE', note: '[DEMO] 廠商調查尚未核准，請補件後重新評估' });
  await createSupplement(manager, e1, { conditionId: 'NEED_DEMAND_PROOF', note: '[DEMO] 請補社群詢問的原始連結與日期' });

  // ---- 2. 保濕面膜：進行中的 V2 草稿。廠商調查（已核准）、試用、可行性由系統帶入；適配與歷史訂單沒有資料 → 未知並說明原因 ----
  const e2 = (await createEvaluation(editor, pMask)).id;
  await updateEvaluation(editor, e2, {
    commerceModel: 'AGENCY',
    conditions: { NEED_SEGMENT_MATCH: { value: true }, REP_CONSUMABLE: { value: 'CONSUMABLE' } } as never,
    compliance: { status: 'UNKNOWN' },
  });
  console.log('選品 V2 DEMO 資料已建立：已送出 1 份（含補件要求）、草稿 1 份。');
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(closePool);
