/**
 * 客訴（客服案件）的團主歸屬規則（Owner 決策 K-5；純函式，沒有資料庫相依）。
 *   1. 優先由既有訂單歸因取得團主：案件有關聯訂單、且該訂單有歸因（attributions）。
 *        只有一位團主 → 單一歸屬（ORDER_SINGLE）；兩位以上 → 共同歸因（ORDER_SHARED，不分配、不拆分件數）。
 *   2. 沒有訂單、或訂單沒有歸因：保留「未歸屬」（UNATTRIBUTED）；只有此時才允許人工指定團主（MANUAL，需說明）。
 *   3. 不任意分配：無法辨識就是未歸屬。
 * 統計：公司整體客訴件數＝案件數（每件只算一次，不因多位團主歸因而重複計算）；團主層級＝歸屬該團主（單一歸屬＋人工）＋與其他團主共同歸因的件數，
 *       共同歸因的件數會在每位相關團主的層級各出現一次，但整體只算一次，並且另行標示。
 * 客訴率只供營運觀察，不作為團主懲罰、停權或任何自動處置的依據（沒有任何程式讀取它來做決定）。
 */
export type HostAttributionKind = 'ORDER_SINGLE' | 'ORDER_SHARED' | 'MANUAL' | 'UNATTRIBUTED';
export const ATTRIBUTION_LABEL: Record<HostAttributionKind, string> = {
  ORDER_SINGLE: '訂單歸因（單一團主）', ORDER_SHARED: '訂單歸因（多位團主共同歸因）', MANUAL: '人工指定', UNATTRIBUTED: '未歸屬',
};
export interface CaseAttribInput { caseId: string; manualHostId: string | null; orderId: string | null; orderHostIds: string[] }
export interface CaseAttribution { caseId: string; kind: HostAttributionKind; hostIds: string[] }

export function resolveCaseAttribution(c: CaseAttribInput): CaseAttribution {
  const hosts = Array.from(new Set(c.orderHostIds));
  if (c.orderId && hosts.length === 1) return { caseId: c.caseId, kind: 'ORDER_SINGLE', hostIds: hosts };
  if (c.orderId && hosts.length > 1) return { caseId: c.caseId, kind: 'ORDER_SHARED', hostIds: hosts.sort() };
  if (c.manualHostId) return { caseId: c.caseId, kind: 'MANUAL', hostIds: [c.manualHostId] };
  return { caseId: c.caseId, kind: 'UNATTRIBUTED', hostIds: [] };
}

export interface ComplaintStats {
  /** 公司整體（檔期）客訴件數：每件只算一次 */
  total: number;
  /** 無法歸屬任何團主的件數（保留未歸屬，不分配） */
  unattributed: number;
  /** 共同歸因（多位團主）的件數：整體只算一次 */
  sharedCases: number;
  byHost: Record<string, { exclusive: number; shared: number; manual: number }>;
}

export function summarizeComplaints(list: CaseAttribution[]): ComplaintStats {
  const byHost: ComplaintStats['byHost'] = {};
  let unattributed = 0, sharedCases = 0;
  for (const a of list) {
    if (a.kind === 'UNATTRIBUTED') { unattributed++; continue; }
    if (a.kind === 'ORDER_SHARED') sharedCases++;
    for (const h of a.hostIds) {
      const x = (byHost[h] ??= { exclusive: 0, shared: 0, manual: 0 });
      if (a.kind === 'ORDER_SHARED') x.shared++;
      else { x.exclusive++; if (a.kind === 'MANUAL') x.manual++; }
    }
  }
  return { total: list.length, unattributed, sharedCases, byHost };
}

/** 某位團主的層級件數（單一歸屬＋人工＋共同歸因）；沒有任何歸屬為 0 */
export const hostLevelCount = (s: ComplaintStats, hostId: string): number => { const x = s.byHost[hostId]; return x ? x.exclusive + x.shared : 0; };
