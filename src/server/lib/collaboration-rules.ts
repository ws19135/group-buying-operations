/**
 * 合作申請與樣品管理（COLLABORATION_APPLICATIONS）的純規則。
 * 這個檔案沒有資料庫相依，全部是可單獨測試的純函式：狀態轉換表、樣品進度推導、
 * 欄位層級權限、收件個資可見性與保留政策、匯入冪等鍵、兩種表單的匯出欄位對應。
 *
 * 設計說明見 docs/phase2/INFLUENCER_SAMPLE_APPLICATION.md。
 */

// ---------------------------------------------------------------- 列舉（與 migration 028 的 CHECK 對齊）
export const APPLICATION_STATUSES = [
  'DRAFT', 'SUBMITTED', 'INTERNAL_REVIEW', 'VENDOR_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED', 'ON_HOLD', 'CLOSED',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const COLLABORATION_STATUSES = [
  'NOT_STARTED', 'SAMPLE_IN_PROGRESS', 'TRIAL_IN_PROGRESS', 'AWAITING_INTENT', 'COLLABORATION_CONFIRMED', 'CAMPAIGN_LINKED', 'DECLINED',
] as const;
export type CollaborationStatus = (typeof COLLABORATION_STATUSES)[number];

export const APPLICATION_SOURCES = ['OPS', 'HOST_FORM', 'VENDOR_FORM', 'IMPORT'] as const;
export const SUPPLY_STATUSES = ['PENDING', 'AVAILABLE', 'PARTIAL', 'UNAVAILABLE'] as const;
export const SHIPMENT_TYPES = ['INITIAL', 'RESEND'] as const;
export const SHIPPED_BY_PARTIES = ['VENDOR', 'OPS'] as const;
export const COLLAB_SHIPMENT_STATUSES = ['PENDING', 'SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED'] as const;
export type CollabShipmentStatus = (typeof COLLAB_SHIPMENT_STATUSES)[number];
export const LAUNCH_INTENTS = ['PENDING', 'WILLING', 'UNDECIDED', 'UNWILLING'] as const;
export const BACKEND_SETUP_STATUSES = ['NOT_REQUIRED', 'PENDING', 'REQUESTED', 'DONE'] as const;
export const ADS_INTENTS = ['PENDING', 'YES', 'NO'] as const;
export const ADS_CONFIRM_STATUSES = ['PENDING', 'CONFIRMED', 'DECLINED'] as const;
export const IMPORT_FORM_KINDS = ['FORM1_LAUNCH', 'FORM2_SAMPLE'] as const;
export type ImportFormKind = (typeof IMPORT_FORM_KINDS)[number];
export const IMPORT_RESOLUTIONS = ['NEEDS_REVIEW', 'RESOLVED', 'SKIPPED', 'IMPORTED', 'FAILED'] as const;

/** 事件維度：四個維度各自記錄，避免塞成一條超長狀態鏈 */
export const EVENT_DIMENSIONS = ['APPLICATION', 'COLLABORATION', 'SAMPLE', 'INTENT', 'CAMPAIGN', 'DATA'] as const;
export type EventDimension = (typeof EVENT_DIMENSIONS)[number];

// ---------------------------------------------------------------- 申請狀態機
/**
 * 申請主狀態只負責「現在誰在等誰」。物流進度、開團意願、合作確認各走自己的維度，
 * 所以這張表刻意很短，也允許從 APPROVED 回到 ON_HOLD 再回來。
 */
export const APPLICATION_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['INTERNAL_REVIEW', 'ON_HOLD', 'REJECTED', 'CANCELLED'],
  INTERNAL_REVIEW: ['VENDOR_REVIEW', 'APPROVED', 'ON_HOLD', 'REJECTED', 'CANCELLED'],
  VENDOR_REVIEW: ['APPROVED', 'INTERNAL_REVIEW', 'ON_HOLD', 'REJECTED', 'CANCELLED'],
  APPROVED: ['ON_HOLD', 'CLOSED', 'CANCELLED'],
  ON_HOLD: ['SUBMITTED', 'INTERNAL_REVIEW', 'VENDOR_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED'],
  REJECTED: [],
  CANCELLED: [],
  CLOSED: [],
};

export function canTransitionApplication(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return APPLICATION_TRANSITIONS[from].includes(to);
}

/** 已結束的申請不可再被編輯（除了唯讀查閱與補稽核） */
export const TERMINAL_APPLICATION_STATUSES: ApplicationStatus[] = ['REJECTED', 'CANCELLED', 'CLOSED'];
export const isTerminalApplication = (s: ApplicationStatus) => TERMINAL_APPLICATION_STATUSES.includes(s);

/** 樣品可以開始寄送的申請狀態（廠商核准供樣後） */
export const SHIPPABLE_APPLICATION_STATUSES: ApplicationStatus[] = ['VENDOR_REVIEW', 'APPROVED'];

// ---------------------------------------------------------------- 合作狀態機（第二個維度）
export const COLLABORATION_TRANSITIONS: Record<CollaborationStatus, CollaborationStatus[]> = {
  NOT_STARTED: ['SAMPLE_IN_PROGRESS', 'TRIAL_IN_PROGRESS', 'AWAITING_INTENT', 'COLLABORATION_CONFIRMED', 'DECLINED'],
  SAMPLE_IN_PROGRESS: ['TRIAL_IN_PROGRESS', 'AWAITING_INTENT', 'COLLABORATION_CONFIRMED', 'DECLINED'],
  TRIAL_IN_PROGRESS: ['AWAITING_INTENT', 'COLLABORATION_CONFIRMED', 'DECLINED'],
  AWAITING_INTENT: ['TRIAL_IN_PROGRESS', 'COLLABORATION_CONFIRMED', 'DECLINED'],
  COLLABORATION_CONFIRMED: ['CAMPAIGN_LINKED', 'AWAITING_INTENT', 'DECLINED'],
  CAMPAIGN_LINKED: ['COLLABORATION_CONFIRMED'],
  DECLINED: ['AWAITING_INTENT'],
};

export function canTransitionCollaboration(from: CollaborationStatus, to: CollaborationStatus): boolean {
  return from === to || COLLABORATION_TRANSITIONS[from].includes(to);
}

/** 物流出貨單的狀態轉換（每一次寄送自己走，不影響其他次） */
export const COLLAB_SHIPMENT_TRANSITIONS: Record<CollabShipmentStatus, CollabShipmentStatus[]> = {
  PENDING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED', 'RETURNED', 'CANCELLED'],
  DELIVERED: ['RETURNED'],
  RETURNED: [],
  CANCELLED: [],
};

export function canTransitionShipment(from: CollabShipmentStatus, to: CollabShipmentStatus): boolean {
  return COLLAB_SHIPMENT_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------- 樣品進度（由紀錄推導，不存布林欄位）
export interface ShipmentFact {
  shipmentType: 'INITIAL' | 'RESEND';
  status: CollabShipmentStatus;
  shipDate?: string | null;
}

export type SampleProgress =
  | 'NOT_REQUESTED'      // 還沒有任何寄送紀錄
  | 'PREPARING'          // 有紀錄但都還沒寄出
  | 'SHIPPED'            // 首次已寄出、還沒收到
  | 'DELIVERED'          // 已確認收件
  | 'RESEND_PENDING'     // 已建立補寄紀錄但還沒寄出
  | 'RESENT'             // 補寄已寄出
  | 'RETURNED';          // 退回

export interface SampleSummary {
  progress: SampleProgress;
  /** 「是否已補寄」：從補寄紀錄推導，有證據才算（表單一的欄位） */
  resent: boolean;
  resendCount: number;
  resendPending: boolean;
  shippedCount: number;
  deliveredCount: number;
  activeCount: number;
  lastShipDate: string | null;
}

/**
 * 表單一的「是否已補寄（品牌若寄出請改日期）」在 ERP 裡不是一個可以隨手打勾的布林欄位，
 * 而是由寄送紀錄推導：必須真的有一列 shipment_type='RESEND' 且已寄出，才算補寄過。
 */
export function summarizeShipments(rows: ShipmentFact[]): SampleSummary {
  const active = rows.filter((r) => r.status !== 'CANCELLED');
  const resends = active.filter((r) => r.shipmentType === 'RESEND');
  const shipped = active.filter((r) => r.status === 'SHIPPED' || r.status === 'DELIVERED' || r.status === 'RETURNED');
  const delivered = active.filter((r) => r.status === 'DELIVERED');
  const returned = active.filter((r) => r.status === 'RETURNED');
  const resentShipped = resends.filter((r) => r.status !== 'PENDING');
  const dates = active.map((r) => r.shipDate).filter((d): d is string => !!d).sort();

  let progress: SampleProgress;
  if (!active.length) progress = 'NOT_REQUESTED';
  else if (!shipped.length) progress = 'PREPARING';
  else if (resends.some((r) => r.status === 'PENDING')) progress = 'RESEND_PENDING';
  else if (resentShipped.length && !delivered.length) progress = 'RESENT';
  else if (delivered.length) progress = 'DELIVERED';
  else if (returned.length === shipped.length) progress = 'RETURNED';
  else progress = 'SHIPPED';

  return {
    progress,
    resent: resentShipped.length > 0,
    resendCount: resends.length,
    resendPending: resends.some((r) => r.status === 'PENDING'),
    shippedCount: shipped.length,
    deliveredCount: delivered.length,
    activeCount: active.length,
    lastShipDate: dates.length ? dates[dates.length - 1] : null,
  };
}

/** 廠商工作台的分桶：第一次寄送還沒出貨、補寄待出貨等等，都由上面的推導結果決定 */
export function shipmentBucket(s: SampleSummary): 'TO_SHIP' | 'RESEND_PENDING' | 'SHIPPED' | 'DELIVERED' | 'NONE' {
  if (s.resendPending) return 'RESEND_PENDING';
  if (s.progress === 'NOT_REQUESTED') return 'NONE';
  if (s.progress === 'PREPARING') return 'TO_SHIP';
  if (s.progress === 'DELIVERED') return 'DELIVERED';
  return 'SHIPPED';
}

// ---------------------------------------------------------------- 供應狀態
/** 廠商填了核准數量後，供應狀態不是自由選的：數量決定它，避免「部分供應但數量等於申請量」這種矛盾 */
export function supplyStatusFor(requestedQty: number, approvedQty: number | null | undefined): (typeof SUPPLY_STATUSES)[number] {
  if (approvedQty == null) return 'PENDING';
  if (approvedQty <= 0) return 'UNAVAILABLE';
  if (approvedQty >= requestedQty) return 'AVAILABLE';
  return 'PARTIAL';
}

export interface ItemFact { requestedQty: number; approvedQty: number | null; supplyStatus: string }

/** 廠商是否已把每一項明細都審過（PENDING 代表還沒審） */
export function vendorReviewComplete(items: ItemFact[]): boolean {
  return items.length > 0 && items.every((i) => i.supplyStatus !== 'PENDING');
}

/** 全部不供應＝這筆申請沒有東西可寄 */
export function allUnavailable(items: ItemFact[]): boolean {
  return items.length > 0 && items.every((i) => i.supplyStatus === 'UNAVAILABLE');
}

// ---------------------------------------------------------------- 欄位層級權限
/**
 * 各角色可以改申請主檔的哪些欄位。欄位層級保護必須在後端做，不能只靠前端隱藏。
 * HOST 只能動自己案件的備註（收件資料、意願另有專用端點）；VENDOR 不能動任何主檔欄位。
 */
export const APPLICATION_PATCH_FIELDS = {
  INTERNAL: ['productId', 'appliedOn', 'note', 'internalNote'] as const,   // 承辦人不在這裡：只能經指派／交接端點變更（D-39）
  HOST: ['note'] as const,
  VENDOR: [] as const,
};

/** 廠商可以回填的開團合作欄位（後台連結、後台設定、投廣）—— 與團主／營運的欄位分開 */
export const VENDOR_LAUNCH_FIELDS = [
  'vendorPortalUrl', 'backendSetupEmail', 'backendSetupStatus', 'backendSetupNote', 'adsConfirmStatus',
] as const;

/** 團主與營運可以填的開團合作欄位 */
export const LAUNCH_FIELDS = [
  'intent', 'intentRespondedOn', 'intentNote', 'plannedOpenDate', 'confirmedOpenDate', 'launchUrl', 'adsIntent', 'adsNote', 'collaborationNote',
] as const;

/** 團主只能動其中這幾個（開團意願、建議開團日期、自己案件的開團連結） */
export const HOST_LAUNCH_FIELDS = ['intent', 'intentRespondedOn', 'intentNote', 'plannedOpenDate', 'launchUrl'] as const;

// ---------------------------------------------------------------- 收件個資：可見性與保留政策
export interface RecipientVisibilityInput {
  applicationStatus: ApplicationStatus;
  confirmedAt: string | Date | null;
  purgedAt: string | Date | null;
  retentionUntil: string | null;
  /** 履約是否仍需要地址（見 fulfilmentOpen）；未提供視為不需要（fail-closed） */
  fulfilmentOpen?: boolean;
  /** 核准日（沒有則用建立日），用來判斷硬性上限；未提供則不檢查上限 */
  baseOn?: string | null;
}

export type RecipientDenyReason = 'PURGED' | 'RETENTION_EXPIRED' | 'NOT_CONFIRMED' | 'NOT_APPROVED' | 'FULFILMENT_CLOSED';

/**
 * 履約是否仍需要收件地址（D-37「受控的履約例外」、D-44「仍在履約期限內」）：
 *  - 還沒有任何有效寄送紀錄、或有尚未寄出（PENDING）的寄送／補寄 → 廠商還要寄，需要地址
 *  - 已寄出但尚未送達、已送達、已退回但沒有待寄的補寄 → 廠商手上不需要地址了（要補寄時會先建立補寄紀錄，這時又會重新開啟）
 * 這是從寄送紀錄推導的事實，不是旗標；廠商的地址存取窗口因此會隨履約進度自動關閉。
 */
export function fulfilmentOpen(rows: ShipmentFact[]): boolean {
  const active = rows.filter((r) => r.status !== 'CANCELLED');
  if (!active.some((r) => r.shipmentType === 'INITIAL')) return true;
  return active.some((r) => r.status === 'PENDING');
}

/**
 * 廠商看得到收件個資的條件（「只在履約所必需的期間內提供給廠商」）：
 * 申請處於已核准（暫緩、結案、退回一律不給）、收件資料已由團主確認、未被清除、未超過硬性上限，
 * 而且履約仍需要這份地址（fulfilmentOpen）。
 * 保留期（核准後 90 天）已過但履約還沒結束（例如補寄還沒寄出）時，廠商仍可取得地址直到硬性上限——
 * 否則清除政策會讓廠商在履約中途「沒有地址可寄」。
 * 內部角色另由 collaboration.pii.read 控管，不走這個函式。
 */
export function vendorMaySeeRecipient(input: RecipientVisibilityInput, today: string): { allowed: boolean; reason?: RecipientDenyReason } {
  if (input.purgedAt) return { allowed: false, reason: 'PURGED' };
  if (input.applicationStatus !== 'APPROVED') return { allowed: false, reason: 'NOT_APPROVED' };
  if (!input.confirmedAt) return { allowed: false, reason: 'NOT_CONFIRMED' };
  // 硬性上限不依賴清除排程有沒有跑：超過就一律拒絕
  if (input.baseOn && addDaysIso(input.baseOn, RECIPIENT_HARD_CAP_DAYS_AFTER_APPROVAL) < today) return { allowed: false, reason: 'RETENTION_EXPIRED' };
  if (!input.fulfilmentOpen) {
    // 履約已不需要地址：保留期已過就說「已過期」，否則說「寄送已完成」
    if (input.retentionUntil && input.retentionUntil < today) return { allowed: false, reason: 'RETENTION_EXPIRED' };
    return { allowed: false, reason: 'FULFILMENT_CLOSED' };
  }
  return { allowed: true };
}

export const RECIPIENT_DENY_MESSAGE: Record<RecipientDenyReason, string> = {
  PURGED: '收件資料已依保留政策清除',
  RETENTION_EXPIRED: '收件資料已超過提供給廠商的保留期',
  NOT_CONFIRMED: '收件資料尚未由團主確認',
  NOT_APPROVED: '申請尚未核准（或已暫緩、結案），不提供收件資料',
  FULFILMENT_CLOSED: '這筆申請的寄送已完成或已寄出，履約不再需要收件資料',
};

/** 收件個資的預設保留期：核准後 90 天；一旦全部送達，改為最後一次寄送日 + 30 天（取較早者） */
export const RECIPIENT_RETENTION_DAYS_AFTER_APPROVAL = 90;
export const RECIPIENT_RETENTION_DAYS_AFTER_DELIVERY = 30;

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`addDaysIso 收到無法認讀的日期：${iso}`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function computeRetentionUntil(approvedOn: string | null, summary: SampleSummary, today: string): string | null {
  const base = approvedOn ?? today;
  const byApproval = addDaysIso(base, RECIPIENT_RETENTION_DAYS_AFTER_APPROVAL);
  if (summary.progress === 'DELIVERED' && summary.lastShipDate) {
    const byDelivery = addDaysIso(summary.lastShipDate, RECIPIENT_RETENTION_DAYS_AFTER_DELIVERY);
    return byDelivery < byApproval ? byDelivery : byApproval;
  }
  return byApproval;
}

/**
 * 個資保留政策的「硬性上限」：不論履約是否還沒結束，核准後超過這個天數一律清除（除非有有效的保留例外）。
 * 沒有上限的「履約未結束就延後清除」會變成無限期保留，所以必須有一個明確的終點。
 */
export const RECIPIENT_HARD_CAP_DAYS_AFTER_APPROVAL = 180;
/** 保留例外的最長天數（與資料庫 CHECK 一致）；要延長必須重新申請並留下稽核 */
export const RETENTION_HOLD_MAX_DAYS = 365;
/** 匯入暫存列（含原始個資）最長保留天數 */
export const IMPORT_STAGING_MAX_DAYS = 30;

export const RETENTION_HOLD_REASONS = ['DISPUTE', 'LEGAL_OBLIGATION', 'RETURN_OR_REFUND', 'OWNER_APPROVED'] as const;
export type RetentionHoldReason = (typeof RETENTION_HOLD_REASONS)[number];

export type PurgeDecision =
  | { action: 'NOT_DUE' }
  | { action: 'SKIP_HOLD'; detail: string }
  | { action: 'SKIP_FULFILMENT'; detail: string }
  | { action: 'PURGE'; hardCap: boolean; detail: string };

export interface PurgeFacts {
  retentionUntil: string | null;
  /** 申請核准日（沒有核准日的案件用建立日） */
  baseOn: string;
  applicationStatus: ApplicationStatus;
  shipments: ShipmentFact[];
  /** 有效（未解除、未過期）的保留例外到期日；沒有則 null */
  activeHoldUntil: string | null;
}

/**
 * 清除決策（D-40）。先回答「政策有沒有計算衝突、會不會在履約沒結束時就清掉」：
 *  1. 有效的保留例外 → 不清除（有期限，到期自動失效）。
 *  2. 超過硬性上限（核准後 180 天）→ 強制清除，不再因履約未結束而延後。
 *  3. 還沒到保留期 → 不處理。
 *  4. 到期了，但履約尚未結束（有待寄／待送達／補寄進行中／退回後未補寄，或申請暫緩中）→ 延後，等下一輪。
 *  5. 其餘 → 清除。
 */
export function evaluatePurge(f: PurgeFacts, today: string): PurgeDecision {
  if (f.activeHoldUntil && f.activeHoldUntil >= today) return { action: 'SKIP_HOLD', detail: `保留例外至 ${f.activeHoldUntil}` };
  const hardCapOn = addDaysIso(f.baseOn, RECIPIENT_HARD_CAP_DAYS_AFTER_APPROVAL);
  if (hardCapOn < today) return { action: 'PURGE', hardCap: true, detail: `超過硬性上限 ${hardCapOn}` };
  if (!f.retentionUntil || f.retentionUntil >= today) return { action: 'NOT_DUE' };
  const sum = summarizeShipments(f.shipments);
  const unfinished =
    f.applicationStatus === 'ON_HOLD' ? '申請暫緩中'
      : sum.resendPending ? '補寄尚未寄出'
        : (sum.progress === 'NOT_REQUESTED' || sum.progress === 'PREPARING') && ['APPROVED', 'VENDOR_REVIEW', 'INTERNAL_REVIEW', 'SUBMITTED'].includes(f.applicationStatus) ? '尚未寄出首次樣品'
          : sum.progress === 'SHIPPED' || sum.progress === 'RESENT' ? '已寄出但團主尚未確認收件'
            : sum.progress === 'RETURNED' ? '樣品退回，尚未決定是否補寄'
              : null;
  if (unfinished) return { action: 'SKIP_FULFILMENT', detail: unfinished };
  return { action: 'PURGE', hardCap: false, detail: '超過保留期' };
}

// ---------------------------------------------------------------- 匯入
/**
 * 匯入冪等鍵：同一來源的同一列重複匯入只會建立一次。
 * 刻意只用「表單類型＋廠商名＋團主名＋商品名＋日期」這些來源列自己就有的欄位，
 * 不含任何系統解析結果，否則人工修正對應之後鍵會變、就失去去重作用。
 */
export function importDedupeKey(kind: ImportFormKind, parts: { vendor?: string | null; host?: string | null; product?: string | null; on?: string | null }): string {
  const norm = (s: string | null | undefined) => (s ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '');
  return [kind, norm(parts.vendor), norm(parts.host), norm(parts.product), norm(parts.on)].join('|');
}

/** 表單一（開團追蹤）與表單二（樣品申請）的來源欄位 → ERP 欄位對應 */
export const FORM1_COLUMNS: Record<string, string> = {
  團購主: 'hostName',
  檔期: 'campaignLabel',
  是否已補寄: 'resentRaw',
  補寄日期: 'resendDate',
  開團連結: 'launchUrl',
  是否投廣: 'adsIntentRaw',
  後台設定Mail: 'backendSetupEmail',
};

export const FORM2_COLUMNS: Record<string, string> = {
  網紅名稱: 'hostName',
  收件人: 'recipientName',
  聯繫電話: 'recipientPhone',
  地址: 'addressLine',
  申請樣品: 'productName',
  配送日期: 'shipDate',
  開團意願: 'intentRaw',
  開團日期: 'plannedOpenDate',
  備註: 'note',
  開團連結: 'launchUrl',
  後台連結: 'vendorPortalUrl',
};

/** 來源欄位名的正規化：允許全半形、空白與冒號差異（例「後台設定 Mail」） */
export function normalizeHeader(h: string): string {
  return h.normalize('NFKC').replace(/[\s:：_-]+/g, '').toLowerCase();
}

export function mapHeaders(headers: string[], kind: ImportFormKind): { map: Record<number, string>; unknown: string[] } {
  const table = kind === 'FORM1_LAUNCH' ? FORM1_COLUMNS : FORM2_COLUMNS;
  const byNorm = new Map(Object.entries(table).map(([k, v]) => [normalizeHeader(k), v]));
  const map: Record<number, string> = {};
  const unknown: string[] = [];
  headers.forEach((h, i) => {
    const hit = byNorm.get(normalizeHeader(h));
    if (hit) map[i] = hit;
    else if (h.trim()) unknown.push(h.trim());
  });
  return { map, unknown };
}

/** 「是否」類欄位的解析：來源是人手填的，可能是 是／否／Y／N／已寄出／空白 */
export function parseYesNo(v: string | null | undefined): boolean | null {
  const s = (v ?? '').normalize('NFKC').trim().toLowerCase();
  if (!s) return null;
  if (['是', 'y', 'yes', 'true', '1', 'v', '已寄出', '已補寄', '有'].includes(s)) return true;
  if (['否', 'n', 'no', 'false', '0', '未寄出', '尚未', '無', '不'].includes(s)) return false;
  return null;
}

/** 開團意願欄位的解析。無法判讀時回 null（列為待確認，不猜） */
export function parseIntent(v: string | null | undefined): (typeof LAUNCH_INTENTS)[number] | null {
  const s = (v ?? '').normalize('NFKC').trim();
  if (!s) return null;
  if (/願意|要開|確定開|yes|willing/i.test(s)) return 'WILLING';
  if (/考慮|再看|待定|未定|undecided|觀察/i.test(s)) return 'UNDECIDED';
  if (/不開|不願|拒絕|no|unwilling/i.test(s)) return 'UNWILLING';
  return null;
}

/** 日期欄位的解析：只接受能明確判讀的格式，判讀不出來就回 null 並列為待確認 */
export function parseLooseDate(v: string | null | undefined): string | null {
  const s = (v ?? '').normalize('NFKC').trim();
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

// ---------------------------------------------------------------- 匯出（兩種表單格式，依角色遮罩個資）
export const FORM1_EXPORT_HEADERS = ['團購主', '檔期', '是否已補寄', '補寄日期', '開團連結', '是否投廣', '後台設定 Mail', '後台設定狀態', '申請單'] as const;
/** 廠商匯出（D-38）：欄位直接不存在，不是遮罩——廠商不能從匯出檔取得收件人、電話、地址 */
export const FORM2_VENDOR_EXPORT_HEADERS = ['網紅名稱', '申請樣品', '配送日期', '開團意願', '開團日期', '備註', '開團連結', '後台連結', '申請單'] as const;
export const FORM2_EXPORT_HEADERS = ['網紅名稱', '收件人', '聯繫電話', '地址', '申請樣品', '配送日期', '開團意願', '開團日期', '備註', '開團連結', '後台連結', '申請單'] as const;

export const MASKED = '［無權限］';

export interface ExportRow {
  id: string;
  hostName: string;
  campaignLabel: string | null;
  resent: boolean;
  resendDate: string | null;
  launchUrl: string | null;
  adsIntent: string;
  backendSetupEmail: string | null;
  backendSetupStatus: string;
  recipientName: string | null;
  recipientPhone: string | null;
  addressLine: string | null;
  productSummary: string;
  shipDate: string | null;
  intent: string;
  openDate: string | null;
  note: string | null;
  vendorPortalUrl: string | null;
}

const YN = (b: boolean) => (b ? '是' : '否');
const ADS_LABEL: Record<string, string> = { PENDING: '未確認', YES: '是', NO: '否' };
const INTENT_LABEL: Record<string, string> = { PENDING: '未回覆', WILLING: '願意', UNDECIDED: '考慮中', UNWILLING: '不開團' };
const BACKEND_LABEL: Record<string, string> = { NOT_REQUIRED: '不需要', PENDING: '待處理', REQUESTED: '已請廠商設定', DONE: '已完成' };

/**
 * 匯出列。`pii` 為 false 時，收件人、電話、地址一律輸出遮罩字，
 * 不讓沒有權限的人把個資匯出成檔案帶走。
 */
export function toForm1Row(r: ExportRow): string[] {
  return [r.hostName, r.campaignLabel ?? '', YN(r.resent), r.resendDate ?? '', r.launchUrl ?? '',
    ADS_LABEL[r.adsIntent] ?? r.adsIntent, r.backendSetupEmail ?? '', BACKEND_LABEL[r.backendSetupStatus] ?? r.backendSetupStatus, r.id];
}

export type ExportPiiMode = 'FULL' | 'MASKED' | 'OMIT';

export function toForm2Row(r: ExportRow, mode: boolean | ExportPiiMode): string[] {
  const m: ExportPiiMode = mode === true ? 'FULL' : mode === false ? 'MASKED' : mode;
  if (m === 'OMIT') {
    return [r.hostName, r.productSummary, r.shipDate ?? '', INTENT_LABEL[r.intent] ?? r.intent, r.openDate ?? '', r.note ?? '',
      r.launchUrl ?? '', r.vendorPortalUrl ?? '', r.id];
  }
  const pii = m === 'FULL';
  const p = (v: string | null) => (pii ? (v ?? '') : (v ? MASKED : ''));
  return [r.hostName, p(r.recipientName), p(r.recipientPhone), p(r.addressLine), r.productSummary,
    r.shipDate ?? '', INTENT_LABEL[r.intent] ?? r.intent, r.openDate ?? '', r.note ?? '', r.launchUrl ?? '', r.vendorPortalUrl ?? '', r.id];
}

/**
 * CSV 公式注入防護（匯出端）：儲存格開頭是 = + - @ 或 Tab／CR 時，試算表會把它當公式執行。
 * 一律在前面補單引號，讓它被當成純文字（OWASP 建議做法）。
 */
export function neutralizeCsvCell(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/** 匯入端的公式偵測：開頭是 = @ Tab CR，或 + - 後面接的不是數字（電話 +886… 與負數不算） */
export function looksLikeFormula(v: string | null | undefined): boolean {
  const raw = (v ?? '').normalize('NFKC');
  if (/^[\t\r]/.test(raw)) return true;      // 開頭是 Tab／CR 本身就是注入手法
  const s = raw.trimStart();
  if (!s) return false;
  if (/^[=@]/.test(s)) return true;
  return /^[+-]/.test(s) && !/^[+-][\s]*[0-9(]/.test(s);
}

/** URL 安全：只允許 http／https，不允許內嵌帳密（user:pass@host），長度上限 500 */
export function isSafeHttpUrl(s: string): boolean {
  if (s.length > 500) return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** 匯入暫存列中屬於個資的欄位（表單二的收件人、電話、地址） */
export const IMPORT_PII_FIELDS = ['recipientName', 'recipientPhone', 'addressLine'] as const;

/** 去除暫存資料中的個資欄位（寫進錯誤紀錄、建立申請單後清掉暫存列時使用） */
export function scrubImportPii<T extends Record<string, string>>(raw: T): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = (IMPORT_PII_FIELDS as readonly string[]).includes(k) ? '［已清除］' : v;
  return out;
}

/** CSV 序列化（RFC 4180；Excel 開啟中文需要 BOM，由呼叫端加）。每個儲存格都經過公式注入防護 */
export function toCsv(rows: (readonly string[])[]): string {
  const cell = (raw: string) => {
    const v = neutralizeCsvCell(raw);
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  return rows.map((r) => r.map((c) => cell(c ?? '')).join(',')).join('\r\n');
}
