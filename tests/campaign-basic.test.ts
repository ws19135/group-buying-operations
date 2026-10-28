import { describe, expect, it, beforeAll } from 'vitest';
import { query } from '@/server/lib/db';
import { getCampaign } from '@/server/modules/campaigns';
import { makeWorld, mkCampaign, mkVendor, mkProduct, mkHost, dayOffset, type World } from './helpers';

let w: World;
beforeAll(async () => { w = await makeWorld(); });

describe('檔期建立與任務產生', () => {
  it('建立檔期會依模板產生 15 個任務，選擇性任務為 SKIPPED', async () => {
    const v = await mkVendor(w);
    const p = await mkProduct(w, v.id);
    const h = await mkHost(w);
    const r = await mkCampaign(w, v.id, { products: [{ productId: p.id, skuId: p.skuIds[0] }], hosts: [{ hostId: h.id }] });
    expect(r.tasksCreated).toBe(15);
    const c = await getCampaign(w.editor, r.id);
    expect(c.tasks).toHaveLength(15);
    const byKey = Object.fromEntries((c.tasks as unknown as { stepKey: string; status: string; plannedStart: string; plannedEnd: string }[]).map((t) => [t.stepKey, t]));
    expect(byKey.SAMPLE_SHIP.plannedStart).toBe(dayOffset(5));
    expect(byKey.SAMPLE_SHIP.plannedEnd).toBe(dayOffset(11)); // 7 天，含頭尾
    expect(byKey.TRIAL_ARRIVAL.plannedStart).toBe(dayOffset(12));
    expect(byKey.LIVE_TALK.status).toBe('SKIPPED');
    expect(byKey.SAMPLE_RECOVERY.status).toBe('SKIPPED');
    const deps = await query('SELECT count(*)::int AS n FROM task_dependencies td JOIN tasks t ON t.id=td.task_id WHERE t.campaign_id=$1', [r.id]);
    expect(deps[0].n).toBeGreaterThan(8);
  });
});
