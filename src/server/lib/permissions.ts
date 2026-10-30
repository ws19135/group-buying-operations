import { forbidden } from './errors';

export const ROLES = ['SYSTEM_ADMIN', 'OPS_MANAGER', 'OPS_EDITOR', 'HOST', 'VENDOR', 'FINANCE'] as const;
export type RoleKey = (typeof ROLES)[number];

export const ROLE_LABEL: Record<RoleKey, string> = {
  SYSTEM_ADMIN: '系統管理者',
  OPS_MANAGER: '營運主管',
  OPS_EDITOR: '營運小編',
  HOST: '團主',
  VENDOR: '廠商',
  FINANCE: '財務',
};

export const INTERNAL_ROLES: RoleKey[] = ['SYSTEM_ADMIN', 'OPS_MANAGER', 'OPS_EDITOR', 'FINANCE'];

export type Permission =
  | 'user.manage'
  | 'audit.read'
  | 'vendor.read' | 'vendor.write' | 'vendor.self'
  | 'host.read' | 'host.write' | 'host.self'
  | 'community.read' | 'community.write'
  | 'product.read' | 'product.write' | 'product.cost.read' | 'product.review'
  | 'campaign.read' | 'campaign.write' | 'campaign.transition' | 'campaign.sensitive.read'
  | 'task.read' | 'task.write' | 'task.complete'
  | 'approval.request' | 'approval.read'
  | 'order.read' | 'order.import'
  | 'commission.read' | 'commission.write'
  | 'dashboard.admin' | 'dashboard.host'
  | 'automation.manage' | 'automation.run'
  | 'exception.read' | 'exception.manage'
  | 'aftersales.read' | 'aftersales.write' | 'refund.approve' | 'refund.complete'
  | 'finance.read' | 'finance.write' | 'settlement.confirm'
  | 'fulfillment.read' | 'fulfillment.write'
  | 'intake.write'
  | 'segment.read' | 'segment.write'
  | 'fit.read' | 'fit.assess' | 'fit.review' | 'fit.config'
  | 'selection.read' | 'selection.write' | 'selection.config';

const ALL: Permission[] = [
  'user.manage', 'audit.read',
  'vendor.read', 'vendor.write', 'vendor.self',
  'host.read', 'host.write', 'host.self',
  'community.read', 'community.write',
  'product.read', 'product.write', 'product.cost.read', 'product.review',
  'campaign.read', 'campaign.write', 'campaign.transition', 'campaign.sensitive.read',
  'task.read', 'task.write', 'task.complete',
  'approval.request', 'approval.read',
  'order.read', 'order.import',
  'commission.read', 'commission.write',
  'dashboard.admin', 'dashboard.host',
  'automation.manage', 'automation.run',
  'exception.read', 'exception.manage',
  'aftersales.read', 'aftersales.write', 'refund.approve', 'refund.complete',
  'finance.read', 'finance.write', 'settlement.confirm',
  'fulfillment.read', 'fulfillment.write',
  'intake.write',
  'segment.read', 'segment.write',
  'fit.read', 'fit.assess', 'fit.review', 'fit.config',
  'selection.read', 'selection.write', 'selection.config',
];

/**
 * 角色 → 權限。注意：這只是「能不能做這類動作」；「能碰哪些資料列」另由 scope.ts 的資料範圍決定。
 * 最小權限：廠商與團主不具備 *.write（除自己的任務回填）、成本、佣金設定、稽核。
 */
export const ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  SYSTEM_ADMIN: ALL,
  OPS_MANAGER: ALL.filter((p) => !['user.manage', 'commission.write', 'host.self', 'vendor.self', 'refund.complete', 'finance.write', 'settlement.confirm'].includes(p)) as Permission[],
  OPS_EDITOR: [
    'vendor.read', 'vendor.write', 'host.read', 'host.write', 'community.read', 'community.write',
    'product.read', 'product.write', 'campaign.read', 'campaign.write', 'campaign.transition',
    'task.read', 'task.write', 'task.complete', 'approval.request', 'approval.read',
    'dashboard.admin', 'exception.read', 'exception.manage', 'intake.write', 'order.read', 'order.import',
    'fulfillment.read', 'fulfillment.write',
    'aftersales.read', 'aftersales.write',
    'segment.read', 'segment.write', 'fit.read', 'fit.assess',
    'selection.read', 'selection.write',
  ],
  FINANCE: [
    'vendor.read', 'host.read', 'community.read', 'product.read', 'product.cost.read',
    'campaign.read', 'campaign.sensitive.read', 'task.read', 'task.complete', 'approval.read',
    'order.read', 'commission.read', 'commission.write', 'dashboard.admin', 'audit.read',
    'fulfillment.read',
    'exception.read', 'aftersales.read', 'refund.complete',
    'finance.read', 'finance.write', 'settlement.confirm',
    'selection.read',
  ],
  HOST: ['host.self', 'community.read', 'product.read', 'campaign.read', 'task.read', 'task.complete', 'dashboard.host', 'commission.read', 'fulfillment.read', 'aftersales.read'],
  VENDOR: ['vendor.self', 'product.read', 'campaign.read', 'task.read', 'task.complete', 'fulfillment.read', 'aftersales.read'],
};

export function isRole(v: string): v is RoleKey {
  return (ROLES as readonly string[]).includes(v);
}

export function roleCan(role: RoleKey, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(perm);
}

/** 核准關卡：誰可以決定 */
export const GATE_APPROVER_ROLES: Record<string, RoleKey[]> = {
  G1: ['SYSTEM_ADMIN', 'OPS_MANAGER'],
  G2: ['SYSTEM_ADMIN', 'OPS_MANAGER'],
  G3: ['SYSTEM_ADMIN', 'OPS_MANAGER', 'FINANCE'],
  G4: ['SYSTEM_ADMIN', 'FINANCE'],
  G5: ['SYSTEM_ADMIN', 'OPS_MANAGER'],
};

export interface Actor {
  type: 'USER' | 'SYSTEM';
  userId: string | null;
  orgId: string;
  role: RoleKey;
  name: string;
  hostIds: string[];
  vendorIds: string[];
  requestId: string;
  source: 'WEB' | 'API' | 'WORKER' | 'SEED' | 'IMPORT' | 'TEST';
  ip?: string | null;
}

export function can(actor: Actor, perm: Permission): boolean {
  return roleCan(actor.role, perm);
}

export function requirePerm(actor: Actor, perm: Permission): void {
  if (!can(actor, perm)) throw forbidden();
}

export const isInternal = (actor: Actor) => INTERNAL_ROLES.includes(actor.role);

export function systemActor(orgId: string, source: Actor['source'] = 'WORKER', requestId = 'system'): Actor {
  return { type: 'SYSTEM', userId: null, orgId, role: 'SYSTEM_ADMIN', name: 'system', hostIds: [], vendorIds: [], requestId, source };
}
