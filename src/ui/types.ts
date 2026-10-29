/** 各服務函式回傳（經 camelize 後為 unknown）的前端檢視型別 */
export interface Kpi { value: number | null; source?: string; formula?: string; label?: string }
export interface DataQualityV { status: 'NO_DATA' | 'DEMO' | 'IMPORT' | 'MIXED'; statusLabel: string; lastImport: { id: string; finishedAt: string | null; dataAsOf: string | null; sourceSystem: string; status: string } | null; openImportErrors: number; warnings: string[] }
export interface CampaignHostRef { hostId: string; name: string; role: string; status: string }
export interface AdminDash {
  generatedAt: string; period: { month: string; mode: 'month' | 'week'; from: string; to: string }; dataQuality: DataQualityV;
  sales: { gmv: Kpi; refund: Kpi; net: Kpi; orders: Kpi; aov: Kpi; refundRate: Kpi } | null;
  targets: { total: number | null; attainment: Kpi; byCampaign: { id: string; title: string; target: number; net: number; attainment: number | null }[] } | null;
  unattributedNet: number | null;
  pipeline: { status: string; n: number }[];
  upcoming: { id: string; title: string; status: string; event: string; eventDate: string; vendorId: string; vendorName: string; hosts: CampaignHostRef[] }[];
  hostPerformance: { hostId: string; name: string; campaigns: number; net: number; orders: number }[];
  communities: { byPlatform: { platform: string; n: number }[]; plannedPlacementsNext7Days: number };
  hosts: { status: string; n: number }[];
  tasks: { open: number; overdue: number; dueToday: number; unassigned: number; blocked: number; waitingApproval: number };
  overdueTasks: { id: string; name: string; campaignId: string; campaignTitle: string; ownerRole: string; assigneeName: string | null; plannedEnd: string; daysLate: number; vendorId: string; vendorName: string; hosts: CampaignHostRef[] }[];
  exceptions: { severity: string; n: number }[];
  pendingApprovals: number;
  vendors: { vendorId: string; name: string; campaigns: number; live: number; tasksTotal: number; tasksDone: number; vendorOverdue: number }[];
  vendorCampaigns: { campaignId: string; title: string; status: string; vendorId: string; vendorName: string; openDate: string | null; closeDate: string | null; hosts: CampaignHostRef[];
    tasksTotal: number; tasksDone: number; overdue: number; vendorOverdue: number; nextTaskName: string | null; nextTaskDue: string | null; nextTaskOwnerRole: string | null }[];
  kpiDefinitions?: Record<string, { source?: string; formula?: string }>;
  overview: { liveCampaigns: number; liveHosts: number; statuses: string[] };
  finance: { estimatedCommission: { value: number | null; unrated: number } | null; confirmedCommission: { value: number; items: number } | null; received: { value: number; count: number } | null };
  communityRank: { communityId: string; name: string; platform: string; orders: number; net: number }[] | null;
  campaignOutput: { campaigns: number; average: number | null; top: { id: string; title: string; status: string; orders: number; net: number }[] } | null;
  dataSources: { sourceSystem: string; dataOrigin: string; orders: number; lastSync: string | null; lastOrderAt: string | null }[] | null;
  vendorSuccess: { overall: { launched: number; cancelled: number; rate: number } | null; byVendor: { vendorId: string; name: string; launched: number; cancelled: number; rate: number }[] };
  onTimeLaunch: { total: number; onTime: number; rate: number | null };
  productRepeat: { productId: string; name: string; campaigns: number; net: number | null; avgPerCampaign: number | null }[];
  attention: { kind: string; chip: string; tone: 'danger' | 'warn' | 'info'; title: string; detail: string; urgency: number; href: string }[];
}
export interface HostDash {
  generatedAt: string; host: { id: string; name: string }; period: { month: string; from: string; to: string }; dataQuality: DataQualityV;
  performance: { gmv: Kpi; net: Kpi; orders: Kpi };
  myCampaigns: { id: string; title: string; status: string; openDate: string | null; closeDate: string | null; myRole: string; myStatus: string; myTarget: number | null; myNet: number | null; attainment: number | null; commissionRate: number | null; estimatedCommission: number | null; commissionNote: string }[];
  commission: { estimatedTotal: Kpi; basis: string };
  todos: { id: string; name: string; stepKey: string; status: string; plannedStart: string | null; plannedEnd: string | null; campaignId: string; campaignTitle: string; overdue: boolean }[];
  pendingInvites: { id: string; title: string; openDate: string | null }[];
  calendar: { kind: string; date: string; label: string; campaignId: string; campaignTitle: string; communityName: string | null; status: string }[];
  trialAndAssets: { campaignId: string; campaignTitle: string; stepKey: string; name: string; status: string; plannedEnd: string | null }[];
  settlementProgress: { campaignId: string; title: string; status: string; stage: string }[];
}
export interface Paged<T> { items: T[]; total: number; limit: number; offset: number }
export const as = <T,>(x: unknown): T => x as T;

export interface TaskV {
  id: string; stepKey: string; name: string; phase: number; seq: number; ownerRole: string; assigneeUserId: string | null; assigneeName: string | null;
  kind: 'TASK' | 'GATE' | 'MILESTONE'; gateKey: string | null; status: string; plannedStart: string | null; plannedEnd: string | null; completedAt: string | null;
  dateLocked: boolean; dateLockReason: string | null; optional: boolean; skipReason: string | null; blockerReason: string | null; scheduleIssue: string | null; version: number; overdue: boolean;
}
export interface CampaignV {
  id: string; title: string; status: string; statusReason?: string | null; previousStatus?: string | null; vendorId: string; ownerUserId: string | null; campaignType: string; description: string | null;
  openDate: string | null; closeDate: string | null; sampleReadyDate: string | null; needsSampleRecovery: boolean; liveTalkDate: string | null; targetRevenue?: number | null; internalNote?: string | null;
  workflowTemplateVersion: number | null; workflowParams?: Record<string, number>; version: number; createdAt: string; updatedAt: string;
  vendor: { id: string; name: string; status: string };
  products: { id: string; productId: string; productName: string; reviewStatus: string; skuId: string | null; skuCode: string | null; skuName: string | null; listPrice: number | null; groupPrice: number | null; campaignPrice: number | null; limitQty: number | null; note: string | null }[];
  hosts: { id: string; hostId: string; displayName: string; role: string; status: string; respondedAt: string | null; note: string | null; targetRevenue?: number | null }[];
  placements: { id: string; hostId: string; hostName: string; communityId: string; communityName: string; platform: string; placementType: string; scheduledOn: string; scheduledTime: string | null; status: string; contentRef: string | null; note: string | null }[];
  tasks: TaskV[];
  allowedTransitions: { to: string; backward: boolean }[];
  approvals?: { id: string; gateKey: string; status: string; requestedBy: string | null; requestedAt: string; requestNote: string | null; decidedBy: string | null; decidedAt: string | null; decisionNote: string | null }[];
  conflicts?: { type: string; severity: string; message: string; otherCampaignId?: string }[];
  exceptions?: { id: string; type: string; severity: string; title: string; detail: string | null; status: string; detectedAt: string }[];
}
export interface CheckItemV { key: string; label: string; level: 'BLOCK' | 'WARN'; ok: boolean; detail?: string; ackable?: boolean }
export interface AuditV { id: number; occurredAt: string; actorName: string | null; actorRole: string | null; actorType: string; action: string; entityType: string; entityId: string; campaignId?: string | null; beforeData: unknown; afterData: unknown; reason: string | null; source: string }
