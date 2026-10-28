import { addDays } from '../lib/dates';
import { validation } from '../lib/errors';

/** 模板步驟的起算規則 */
export type StartRule =
  | { type: 'campaign_field'; field: CampaignDateField; offset: number }
  | { type: 'after'; dep: string; offset: number }
  | { type: 'after_all'; deps: string[]; offset: number };

/** 持續天數：參數、固定值 */
export type DurationRule = { type: 'param'; key: string; default: number } | { type: 'fixed'; days: number };

export type CampaignDateField = 'open_date' | 'close_date' | 'sample_ready_date' | 'live_talk_date';
export type ConditionKey = 'needs_sample_recovery' | 'has_live_talk';

export interface StepDef {
  stepKey: string;
  seq: number;
  name: string;
  phase: number;
  ownerRole: string;
  kind: 'TASK' | 'GATE' | 'MILESTONE';
  gateKey: string | null;
  startRule: StartRule;
  duration: DurationRule;
  dependsOn: string[];
  optional: boolean;
  conditionKey: ConditionKey | null;
  description?: string;
}

export interface CampaignInputs {
  open_date: string | null;
  close_date: string | null;
  sample_ready_date: string | null;
  live_talk_date: string | null;
  needs_sample_recovery: boolean;
}

export type Params = Record<string, number>;

export interface PlannedStep {
  stepKey: string;
  applicable: boolean;
  plannedStart: string | null;
  plannedEnd: string | null;
  /** 無法計算或有衝突時的原因（會顯示在任務上） */
  issue: string | null;
}

export interface FixedDates { start: string | null; end: string | null }

export function conditionHolds(key: ConditionKey | null, c: CampaignInputs): boolean {
  if (!key) return true;
  if (key === 'needs_sample_recovery') return c.needs_sample_recovery;
  if (key === 'has_live_talk') return !!c.live_talk_date;
  return true;
}

export function durationDays(rule: DurationRule, params: Params): number {
  const n = rule.type === 'fixed' ? rule.days : (params[rule.key] ?? rule.default);
  if (!Number.isInteger(n) || n < 1 || n > 365) throw validation(`天數參數不正確：${rule.type === 'param' ? rule.key : 'fixed'}=${n}（需為 1–365 的整數）`);
  return n;
}

/** 依 seq 排序並驗證相依關係無循環、無未知步驟 */
export function validateTemplate(steps: StepDef[]): StepDef[] {
  const byKey = new Map(steps.map((s) => [s.stepKey, s]));
  if (byKey.size !== steps.length) throw validation('模板內有重複的 step_key');
  for (const s of steps) {
    for (const d of s.dependsOn) if (!byKey.has(d)) throw validation(`步驟 ${s.stepKey} 相依於不存在的步驟 ${d}`);
    const ruleDeps = s.startRule.type === 'after' ? [s.startRule.dep] : s.startRule.type === 'after_all' ? s.startRule.deps : [];
    for (const d of ruleDeps) if (!s.dependsOn.includes(d)) throw validation(`步驟 ${s.stepKey} 的起算規則使用 ${d}，但 dependsOn 未列出`);
  }
  // 拓撲排序（Kahn），同時偵測循環
  const indeg = new Map(steps.map((s) => [s.stepKey, s.dependsOn.length]));
  const out = new Map<string, string[]>();
  for (const s of steps) for (const d of s.dependsOn) out.set(d, [...(out.get(d) ?? []), s.stepKey]);
  const queue = steps.filter((s) => s.dependsOn.length === 0).sort((a, b) => a.seq - b.seq).map((s) => s.stepKey);
  const order: string[] = [];
  while (queue.length) {
    const k = queue.shift() as string;
    order.push(k);
    for (const n of (out.get(k) ?? []).sort()) {
      indeg.set(n, (indeg.get(n) ?? 0) - 1);
      if (indeg.get(n) === 0) queue.push(n);
    }
  }
  if (order.length !== steps.length) throw validation('模板的相依關係有循環');
  return order.map((k) => byKey.get(k) as StepDef);
}

/**
 * 計算整個檔期的預定日期（純函式，無資料庫）。
 * - fixed：已完成或人工鎖定的任務，沿用其既有日期（自動重排不得覆寫）
 * - 條件不成立的步驟不排程（applicable=false），相依它的步驟會「穿透」到它的前置步驟
 * - 結束日 = 開始日 + 天數 − 1（含頭尾）；下一步 = 前一步結束 + offset（SOP 為 +1）
 */
export function computeSchedule(
  steps: StepDef[],
  campaign: CampaignInputs,
  params: Params,
  fixed: Map<string, FixedDates> = new Map(),
): Map<string, PlannedStep> {
  const ordered = validateTemplate(steps);
  const defs = new Map(steps.map((s) => [s.stepKey, s]));
  const plan = new Map<string, PlannedStep>();

  const effectiveEnd = (key: string): string | null => {
    const p = plan.get(key);
    if (p?.applicable) return p.plannedEnd;
    const d = defs.get(key);
    if (!d) return null;
    const ends = d.dependsOn.map(effectiveEnd).filter((x): x is string => !!x).sort();
    return ends.length ? ends[ends.length - 1] : null;
  };

  for (const s of ordered) {
    const applicable = conditionHolds(s.conditionKey, campaign);
    const fx = fixed.get(s.stepKey);
    if (!applicable && !fx) {
      plan.set(s.stepKey, { stepKey: s.stepKey, applicable: false, plannedStart: null, plannedEnd: null, issue: null });
      continue;
    }
    if (fx && (fx.start || fx.end)) {
      plan.set(s.stepKey, { stepKey: s.stepKey, applicable: true, plannedStart: fx.start, plannedEnd: fx.end, issue: null });
      continue;
    }
    let start: string | null = null;
    let issue: string | null = null;
    const r = s.startRule;
    if (r.type === 'campaign_field') {
      const base = campaign[r.field];
      if (!base) issue = `缺少${FIELD_LABEL[r.field]}，無法排程`;
      else start = addDays(base, r.offset);
    } else {
      const deps = r.type === 'after' ? [r.dep] : r.deps;
      const ends = deps.map(effectiveEnd);
      if (ends.some((e) => !e)) issue = '前置步驟尚無日期，無法排程';
      else start = addDays((ends as string[]).sort().pop() as string, r.offset);
    }
    let end: string | null = null;
    if (start) end = addDays(start, durationDays(s.duration, params) - 1);

    // 排程衝突：以固定日期（開團／結團）為錨點的步驟，若前置步驟的結束日不早於本步驟開始日
    if (start && r.type === 'campaign_field' && s.dependsOn.length) {
      const depEnds = s.dependsOn.map(effectiveEnd).filter((x): x is string => !!x).sort();
      const latest = depEnds.length ? depEnds[depEnds.length - 1] : null;
      if (latest && latest >= start) issue = `前置步驟預計 ${latest} 才結束，晚於本步驟開始日 ${start}`;
    }
    plan.set(s.stepKey, { stepKey: s.stepKey, applicable: true, plannedStart: start, plannedEnd: end, issue });
  }
  return plan;
}

const FIELD_LABEL: Record<CampaignDateField, string> = {
  open_date: '開團日',
  close_date: '結團日',
  sample_ready_date: '試用品可寄出日',
  live_talk_date: 'Live Talk 日期',
};

export interface RescheduleRow {
  stepKey: string;
  name: string;
  status: string;
  locked: boolean;
  before: { start: string | null; end: string | null };
  after: { start: string | null; end: string | null };
  /** unchanged | changed | blocked_by_lock | done_untouched | newly_applicable | no_longer_applicable */
  effect: 'unchanged' | 'changed' | 'blocked_by_lock' | 'done_untouched' | 'newly_applicable' | 'no_longer_applicable';
  issue: string | null;
}

export interface ExistingTask {
  stepKey: string;
  name: string;
  status: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  dateLocked: boolean;
}

const FROZEN = new Set(['DONE', 'CANCELLED']);

/**
 * 日期變更影響預覽：比較「目前任務」與「套用新日期／參數後的計畫」。
 * 已完成與人工鎖定的任務不會被改動（鎖定且本會被改動者標為 blocked_by_lock，由使用者決定是否先解鎖）。
 */
export function previewReschedule(
  steps: StepDef[],
  tasks: ExistingTask[],
  next: CampaignInputs,
  params: Params,
): RescheduleRow[] {
  const byKey = new Map(tasks.map((t) => [t.stepKey, t]));
  const fixed = new Map<string, FixedDates>();
  for (const t of tasks) {
    if (FROZEN.has(t.status) || t.dateLocked) fixed.set(t.stepKey, { start: t.plannedStart, end: t.plannedEnd });
  }
  const unlockedPlan = computeSchedule(steps, next, params, fixed);
  // 「若不鎖定」的計畫，用來判斷被鎖定的任務是否原本會被更動
  const freePlan = computeSchedule(steps, next, params, new Map([...fixed].filter(([k]) => FROZEN.has(byKey.get(k)?.status ?? ''))));
  const rows: RescheduleRow[] = [];
  for (const s of [...steps].sort((a, b) => a.seq - b.seq)) {
    const t = byKey.get(s.stepKey);
    const p = unlockedPlan.get(s.stepKey);
    if (!t || !p) continue;
    const before = { start: t.plannedStart, end: t.plannedEnd };
    const after = { start: p.plannedStart, end: p.plannedEnd };
    let effect: RescheduleRow['effect'] = 'unchanged';
    if (FROZEN.has(t.status)) effect = 'done_untouched';
    else if (t.status === 'SKIPPED' && p.applicable) effect = 'newly_applicable';
    else if (t.status !== 'SKIPPED' && !p.applicable) effect = 'no_longer_applicable';
    else if (t.dateLocked) {
      const f = freePlan.get(s.stepKey);
      effect = f && (f.plannedStart !== t.plannedStart || f.plannedEnd !== t.plannedEnd) ? 'blocked_by_lock' : 'unchanged';
    } else if (before.start !== after.start || before.end !== after.end) effect = 'changed';
    rows.push({ stepKey: s.stepKey, name: t.name, status: t.status, locked: t.dateLocked, before, after, effect, issue: p.issue });
  }
  return rows;
}
