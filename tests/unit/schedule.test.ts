import { describe, expect, it } from 'vitest';
import { computeSchedule, durationDays, previewReschedule, validateTemplate, type CampaignInputs, type ExistingTask, type StepDef } from '@/server/workflow/schedule';
import { DEFAULT_PARAMS, DEFAULT_STEPS, PHASES } from '@/server/workflow/template-default';

const base: CampaignInputs = { open_date: '2026-12-20', close_date: '2026-12-30', sample_ready_date: '2026-11-01', live_talk_date: null, needs_sample_recovery: false };

describe('預設流程模板', () => {
  it('通過驗證：無循環、相依存在、15 步、涵蓋八個階段', () => {
    const ordered = validateTemplate(DEFAULT_STEPS);
    expect(ordered).toHaveLength(15);
    expect(new Set(DEFAULT_STEPS.map((s) => s.phase))).toEqual(new Set(Object.keys(PHASES).map(Number)));
  });

  it('SOP 日期鏈：寄樣 7 天 → 試用 14 天 → 回饋 3 天 → G1 → 圖文 7 天（下一步＝前一步結束+1）', () => {
    const p = computeSchedule(DEFAULT_STEPS, base, DEFAULT_PARAMS);
    const at = (k: string) => [p.get(k)?.plannedStart, p.get(k)?.plannedEnd];
    expect(at('SAMPLE_SHIP')).toEqual(['2026-11-01', '2026-11-07']);
    expect(at('TRIAL_ARRIVAL')).toEqual(['2026-11-08', '2026-11-21']);
    expect(at('TRIAL_FEEDBACK')).toEqual(['2026-11-22', '2026-11-24']);
    expect(at('LAUNCH_APPROVAL')).toEqual(['2026-11-25', '2026-11-25']);
    expect(at('CREATIVE_ASSETS')).toEqual(['2026-11-26', '2026-12-02']);
  });

  it('以開團／結團日為錨點的步驟：開團前檢查、開團、話題、催單、結單、結算、請款', () => {
    const p = computeSchedule(DEFAULT_STEPS, base, DEFAULT_PARAMS);
    expect(p.get('PRELAUNCH_CHECK')?.plannedStart).toBe('2026-12-19');
    expect(p.get('LAUNCH')?.plannedStart).toBe('2026-12-20');
    expect(p.get('TOPIC_PROMO')?.plannedStart).toBe('2026-12-22');         // 開團日 +2（SOP 步驟 8）
    expect(p.get('CLOSING_REMINDER')?.plannedStart).toBe('2026-12-29');    // 結團日 −1（SOP 步驟 9）
    expect(p.get('VENDOR_SETTLE')?.plannedStart).toBe('2026-12-31'); // 結團日 +1
    expect(p.get('VENDOR_SETTLE')?.plannedEnd).toBe('2027-01-13');         // 14 天
    expect(p.get('INVOICE_REQUEST')?.plannedStart).toBe('2027-01-14');     // 上一步結束 +1
  });

  it('選擇性步驟：沒有 Live Talk 日期、不需回收 → 不排程；設定後出現', () => {
    const p1 = computeSchedule(DEFAULT_STEPS, base, DEFAULT_PARAMS);
    expect(p1.get('LIVE_TALK')?.applicable).toBe(false);
    expect(p1.get('SAMPLE_RECOVERY')?.applicable).toBe(false);
    const p2 = computeSchedule(DEFAULT_STEPS, { ...base, live_talk_date: '2026-12-25', needs_sample_recovery: true }, DEFAULT_PARAMS);
    expect(p2.get('LIVE_TALK')?.plannedStart).toBe('2026-12-25');
    expect(p2.get('SAMPLE_RECOVERY')?.plannedStart).toBe('2026-11-25');
    expect(p2.get('SAMPLE_RECOVERY')?.plannedEnd).toBe('2026-12-01');
  });

  it('缺少錨點日期時不亂排：標示原因而非給預設日期', () => {
    const p = computeSchedule(DEFAULT_STEPS, { ...base, sample_ready_date: null }, DEFAULT_PARAMS);
    expect(p.get('SAMPLE_SHIP')?.plannedStart).toBeNull();
    expect(p.get('SAMPLE_SHIP')?.issue).toContain('試用品可寄出日');
    expect(p.get('TRIAL_ARRIVAL')?.plannedStart).toBeNull();
    expect(p.get('LAUNCH')?.plannedStart).toBe('2026-12-20');
  });

  it('排程衝突檢查：圖文準備來不及在開團前檢查之前完成', () => {
    const late = computeSchedule(DEFAULT_STEPS, { ...base, sample_ready_date: '2026-12-01' }, DEFAULT_PARAMS);
    expect(late.get('PRELAUNCH_CHECK')?.issue).toMatch(/晚於本步驟開始日/);
  });

  it('天數參數：更動只影響自身與後續；非法值被擋', () => {
    const p = computeSchedule(DEFAULT_STEPS, base, { ...DEFAULT_PARAMS, ship_days: 10 });
    expect(p.get('SAMPLE_SHIP')?.plannedEnd).toBe('2026-11-10');
    expect(p.get('TRIAL_ARRIVAL')?.plannedStart).toBe('2026-11-11');
    expect(() => durationDays({ type: 'param', key: 'x', default: 1 }, { x: 0 })).toThrow();
    expect(() => durationDays({ type: 'param', key: 'x', default: 1 }, { x: 1.5 })).toThrow();
    expect(() => durationDays({ type: 'param', key: 'x', default: 1 }, { x: 400 })).toThrow();
  });

  it('相依到被略過的步驟時「穿透」到更前面的步驟', () => {
    const steps: StepDef[] = [
      { stepKey: 'A', seq: 1, name: 'A', phase: 1, ownerRole: 'OPS_EDITOR', kind: 'TASK', gateKey: null, startRule: { type: 'campaign_field', field: 'sample_ready_date', offset: 0 }, duration: { type: 'fixed', days: 2 }, dependsOn: [], optional: false, conditionKey: null },
      { stepKey: 'B', seq: 2, name: 'B', phase: 1, ownerRole: 'OPS_EDITOR', kind: 'TASK', gateKey: null, startRule: { type: 'after', dep: 'A', offset: 1 }, duration: { type: 'fixed', days: 2 }, dependsOn: ['A'], optional: true, conditionKey: 'has_live_talk' },
      { stepKey: 'C', seq: 3, name: 'C', phase: 1, ownerRole: 'OPS_EDITOR', kind: 'TASK', gateKey: null, startRule: { type: 'after', dep: 'B', offset: 1 }, duration: { type: 'fixed', days: 1 }, dependsOn: ['B'], optional: false, conditionKey: null },
    ];
    const p = computeSchedule(steps, base, {});
    expect(p.get('B')?.applicable).toBe(false);
    expect(p.get('C')?.plannedStart).toBe('2026-11-03'); // A 兩天 11/01–11/02，B 略過 → C 接在 A 結束後 +1
  });
});

describe('模板驗證', () => {
  const mk = (k: string, deps: string[]): StepDef => ({ stepKey: k, seq: 1, name: k, phase: 1, ownerRole: 'OPS_EDITOR', kind: 'TASK', gateKey: null,
    startRule: deps.length ? { type: 'after', dep: deps[0], offset: 1 } : { type: 'campaign_field', field: 'open_date', offset: 0 }, duration: { type: 'fixed', days: 1 }, dependsOn: deps, optional: false, conditionKey: null });
  it('偵測循環相依', () => { expect(() => validateTemplate([mk('A', ['B']), mk('B', ['A'])])).toThrow(/循環/); });
  it('偵測不存在的相依與重複 key', () => {
    expect(() => validateTemplate([mk('A', ['Z'])])).toThrow(/不存在/);
    expect(() => validateTemplate([mk('A', []), mk('A', [])])).toThrow(/重複/);
  });
});

describe('日期變更影響預覽', () => {
  const tasksFrom = (plan: ReturnType<typeof computeSchedule>, patch: Record<string, Partial<ExistingTask>> = {}): ExistingTask[] =>
    DEFAULT_STEPS.map((s) => {
      const p = plan.get(s.stepKey)!;
      return { stepKey: s.stepKey, name: s.name, status: p.applicable ? 'TODO' : 'SKIPPED', plannedStart: p.plannedStart, plannedEnd: p.plannedEnd, dateLocked: false, ...(patch[s.stepKey] ?? {}) };
    });
  const plan0 = computeSchedule(DEFAULT_STEPS, base, DEFAULT_PARAMS);

  it('延後可寄出日：後續任務連動、開團錨點任務不動', () => {
    const rows = previewReschedule(DEFAULT_STEPS, tasksFrom(plan0), { ...base, sample_ready_date: '2026-11-03' }, DEFAULT_PARAMS);
    const eff = Object.fromEntries(rows.map((r) => [r.stepKey, r.effect]));
    expect(eff.SAMPLE_SHIP).toBe('changed');
    expect(eff.TRIAL_ARRIVAL).toBe('changed');
    expect(eff.LAUNCH).toBe('unchanged');
    expect(rows.find((r) => r.stepKey === 'SAMPLE_SHIP')?.after.start).toBe('2026-11-03');
  });

  it('已完成的任務不會被改動，且其後續任務以完成者的既有日期為準', () => {
    const tasks = tasksFrom(plan0, { SAMPLE_SHIP: { status: 'DONE' } });
    const rows = previewReschedule(DEFAULT_STEPS, tasks, { ...base, sample_ready_date: '2026-11-03' }, DEFAULT_PARAMS);
    const r = Object.fromEntries(rows.map((x) => [x.stepKey, x]));
    expect(r.SAMPLE_SHIP.effect).toBe('done_untouched');
    expect(r.SAMPLE_SHIP.after.start).toBe('2026-11-01');
    expect(r.TRIAL_ARRIVAL.effect).toBe('unchanged'); // 前置已完成，排程不再受可寄出日影響
  });

  it('被人工鎖定的任務：預覽標示 blocked_by_lock，維持原日期，下游以鎖定日期為準', () => {
    const tasks = tasksFrom(plan0, { TRIAL_ARRIVAL: { dateLocked: true } });
    const rows = previewReschedule(DEFAULT_STEPS, tasks, { ...base, sample_ready_date: '2026-11-03' }, DEFAULT_PARAMS);
    const r = Object.fromEntries(rows.map((x) => [x.stepKey, x]));
    expect(r.SAMPLE_SHIP.effect).toBe('changed');
    expect(r.TRIAL_ARRIVAL.effect).toBe('blocked_by_lock');
    expect(r.TRIAL_ARRIVAL.after.start).toBe('2026-11-08');
    expect(r.TRIAL_FEEDBACK.effect).toBe('unchanged');
  });

  it('條件改變：設定 Live Talk 日期 → LIVE_TALK 變成適用；取消回收 → SAMPLE_RECOVERY 不再適用', () => {
    const rows = previewReschedule(DEFAULT_STEPS, tasksFrom(plan0), { ...base, live_talk_date: '2026-12-24' }, DEFAULT_PARAMS);
    expect(rows.find((r) => r.stepKey === 'LIVE_TALK')?.effect).toBe('newly_applicable');
    const withRec = computeSchedule(DEFAULT_STEPS, { ...base, needs_sample_recovery: true }, DEFAULT_PARAMS);
    const rows2 = previewReschedule(DEFAULT_STEPS, tasksFrom(withRec), base, DEFAULT_PARAMS);
    expect(rows2.find((r) => r.stepKey === 'SAMPLE_RECOVERY')?.effect).toBe('no_longer_applicable');
  });

  it('預設天數參數變更只在預覽中呈現，不會自動套用到既有任務', () => {
    const rows = previewReschedule(DEFAULT_STEPS, tasksFrom(plan0), base, { ...DEFAULT_PARAMS, trial_days: 21 });
    expect(rows.find((r) => r.stepKey === 'TRIAL_ARRIVAL')?.effect).toBe('changed');
    // 但原任務資料（plan0）本身未被修改
    expect(plan0.get('TRIAL_ARRIVAL')?.plannedEnd).toBe('2026-11-21');
  });
});
