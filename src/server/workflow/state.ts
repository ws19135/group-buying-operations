export const CAMPAIGN_STATUSES = [
  'DRAFT', 'EVALUATING', 'PENDING_G1', 'PREPARING', 'PENDING_G2', 'SCHEDULED', 'RUNNING',
  'PENDING_CLOSE_CHECK', 'FULFILLING', 'PENDING_SETTLEMENT', 'SETTLED', 'CLOSED', 'CANCELLED', 'ON_HOLD',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const STATUS_LABEL: Record<CampaignStatus, string> = {
  DRAFT: '草稿', EVALUATING: '評估中', PENDING_G1: '待選品核准', PREPARING: '籌備中', PENDING_G2: '待開團核准',
  SCHEDULED: '已排程', RUNNING: '進行中', PENDING_CLOSE_CHECK: '待結單確認', FULFILLING: '履約中',
  PENDING_SETTLEMENT: '待結算', SETTLED: '已結算', CLOSED: '已結案', CANCELLED: '已取消', ON_HOLD: '暫緩',
};

export const TERMINAL: CampaignStatus[] = ['CLOSED', 'CANCELLED'];
/** 已開始對外銷售或之後：不可取消（需走退款／售後流程，屬 Phase 2） */
export const NO_CANCEL_AFTER: CampaignStatus[] = ['FULFILLING', 'PENDING_SETTLEMENT', 'SETTLED', 'CLOSED', 'CANCELLED'];

export type TransitionKind = 'MANUAL' | 'GATE' | 'AUTO';

export interface Transition {
  to: CampaignStatus;
  kind: TransitionKind;
  /** 倒退：需填原因 */
  backward?: boolean;
  /** GATE：由哪個關卡的核准／退回觸發 */
  gate?: string;
}

/**
 * 狀態機。GATE 類型的轉移只能透過核准流程發生，不能用「變更狀態」直接跳過。
 * 取消／暫緩另由 cancel／hold／resume 處理（見 canCancel）。
 */
export const TRANSITIONS: Record<CampaignStatus, Transition[]> = {
  DRAFT: [{ to: 'EVALUATING', kind: 'MANUAL' }],
  EVALUATING: [{ to: 'PENDING_G1', kind: 'GATE', gate: 'G1' }, { to: 'DRAFT', kind: 'MANUAL', backward: true }],
  PENDING_G1: [{ to: 'PREPARING', kind: 'GATE', gate: 'G1' }, { to: 'EVALUATING', kind: 'GATE', gate: 'G1', backward: true }],
  PREPARING: [{ to: 'PENDING_G2', kind: 'GATE', gate: 'G2' }, { to: 'EVALUATING', kind: 'MANUAL', backward: true }],
  PENDING_G2: [{ to: 'SCHEDULED', kind: 'GATE', gate: 'G2' }, { to: 'PREPARING', kind: 'GATE', gate: 'G2', backward: true }],
  SCHEDULED: [{ to: 'RUNNING', kind: 'MANUAL' }, { to: 'PREPARING', kind: 'MANUAL', backward: true }],
  RUNNING: [{ to: 'PENDING_CLOSE_CHECK', kind: 'MANUAL' }],
  PENDING_CLOSE_CHECK: [{ to: 'FULFILLING', kind: 'GATE', gate: 'G3' }, { to: 'RUNNING', kind: 'MANUAL', backward: true }],
  FULFILLING: [{ to: 'PENDING_SETTLEMENT', kind: 'MANUAL' }],
  PENDING_SETTLEMENT: [{ to: 'SETTLED', kind: 'GATE', gate: 'G4' }, { to: 'FULFILLING', kind: 'MANUAL', backward: true }],
  SETTLED: [{ to: 'CLOSED', kind: 'GATE', gate: 'G5' }, { to: 'PENDING_SETTLEMENT', kind: 'MANUAL', backward: true }],
  CLOSED: [],
  CANCELLED: [],
  ON_HOLD: [],
};

/** 發出關卡核准申請時，檔期應先進入的狀態（G3–G5 維持原狀態） */
export const GATE_REQUEST: Record<string, { from: CampaignStatus; to: CampaignStatus | null }> = {
  G1: { from: 'EVALUATING', to: 'PENDING_G1' },
  G2: { from: 'PREPARING', to: 'PENDING_G2' },
  G3: { from: 'PENDING_CLOSE_CHECK', to: null },
  G4: { from: 'PENDING_SETTLEMENT', to: null },
  G5: { from: 'SETTLED', to: null },
};

/** 核准通過／退回後的狀態 */
export const GATE_OUTCOME: Record<string, { approved: CampaignStatus; rejected: CampaignStatus | null }> = {
  G1: { approved: 'PREPARING', rejected: 'EVALUATING' },
  G2: { approved: 'SCHEDULED', rejected: 'PREPARING' },
  G3: { approved: 'FULFILLING', rejected: null },
  G4: { approved: 'SETTLED', rejected: null },
  G5: { approved: 'CLOSED', rejected: null },
};

export function findTransition(from: CampaignStatus, to: CampaignStatus): Transition | undefined {
  return TRANSITIONS[from].find((t) => t.to === to);
}

export function canCancel(status: CampaignStatus): boolean {
  return !NO_CANCEL_AFTER.includes(status);
}

export function canHold(status: CampaignStatus): boolean {
  return !['CLOSED', 'CANCELLED', 'ON_HOLD', 'SETTLED'].includes(status);
}
