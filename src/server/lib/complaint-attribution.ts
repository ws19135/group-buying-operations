/**
 * 客訴（客服案件）的團主歸屬規則（Owner 決策 K-5；純函式，沒有資料庫相依）。
 *   1. 優先由既有訂單歸因取得團主：案件有關聯訂單、且該訂單有歸因（attributions）。
 *        只有一位團主 → 單一歸屬（ORDER_SINGLE）；兩位以上 → 共同歸因（ORDER_SHARED，不分配、不拆分件數）。
 *   2. 沒有訂單、或訂單沒有歸因：保留「未歸屬」（UNATTRIBUTED）；只有此時才允許人工指定團主（MANUAL，需說明）。
 *   3. 不任意分配：無法辨識就是未歸屬。
 * 統計（Owner 決策 K-5a）：
 *   公司整體客訴件數＝案件數，**同一客訴案件只計算一次**；絕不把各團主的「完整件數」加總當成公司整體。
 *   團主層級＝**加權客訴數**：共同歸因的案件，依訂單歸因比例（share_percent，在有歸因的團主之間正規化）把這一件分給各相關團主，每件合計剛好 1 件；
 *   單一歸屬／人工指定＝1 件全給該團主。因此「各團主加權客訴數合計 ＋ 未歸屬件數 ＝ 公司整體件數」（測試驗證）。
 *   完整的關聯團主清單另行保留（relatedCases：涉及該團主的案件數，含共同歸因，**不可加總**），供查詢與個案處理。
 *   無法可靠歸因＝未歸屬，不任意分配、不計入任何團主。
 * 客訴率只供營運觀察，不作為團主懲罰、停權或任何自動處置的依據（沒有任何程式讀取它來做決定）。
 */
export type HostAttributionKind = 'ORDER_SINGLE' | 'ORDER_SHARED' | 'MANUAL' | 'UNATTRIBUTED';
export const ATTRIBUTION_LABEL: Record<HostAttributionKind, string> = {
  ORDER_SINGLE: '訂單歸因（單一團主）', ORDER_SHARED: '訂單歸因（多位團主共同歸因）', MANUAL: '人工指定', UNATTRIBUTED: '未歸屬',
};
export interface CaseAttribInput { caseId: string; manualHostId: string | null; orderId: string | null; orderHostIds: string[]; /** 訂單歸因比例（hostId → share_percent）；沒提供時，共同歸因平均分攤 */ orderShares?: Record<string, number> }
export interface CaseAttribution { caseId: string; kind: HostAttributionKind; hostIds: string[]; /** 各團主分到這一件客訴的權重（合計 1；未歸屬為空） */ weights: Record<string, number> }

function normalize(hosts: string[], shares?: Record<string, number>): Record<string, number> {
  const raw = hosts.map((h) => Math.max(0, shares?.[h] ?? 1));
  const sum = raw.reduce((a, b) => a + b, 0);
  if (sum <= 0) return Object.fromEntries(hosts.map((h) => [h, 1 / hosts.length]));
  return Object.fromEntries(hosts.map((h, idx) => [h, raw[idx] / sum]));
}

export function resolveCaseAttribution(c: CaseAttribInput): CaseAttribution {
  const hosts = Array.from(new Set(c.orderHostIds));
  if (c.orderId && hosts.length === 1) return { caseId: c.caseId, kind: 'ORDER_SINGLE', hostIds: hosts, weights: { [hosts[0]]: 1 } };
  if (c.orderId && hosts.length > 1) { const sorted = hosts.sort(); return { caseId: c.caseId, kind: 'ORDER_SHARED', hostIds: sorted, weights: normalize(sorted, c.orderShares) }; }
  if (c.manualHostId) return { caseId: c.caseId, kind: 'MANUAL', hostIds: [c.manualHostId], weights: { [c.manualHostId]: 1 } };
  return { caseId: c.caseId, kind: 'UNATTRIBUTED', hostIds: [], weights: {} };
}

export interface ComplaintStats {
  /** 公司整體（檔期）客訴件數：每件只算一次 */
  total: number;
  /** 無法歸屬任何團主的件數（保留未歸屬，不分配） */
  unattributed: number;
  /** 共同歸因（多位團主）的件數：整體只算一次 */
  sharedCases: number;
  byHost: Record<string, { exclusive: number; shared: number; manual: number; /** 加權客訴數（共同歸因依比例分攤；各團主合計＋未歸屬＝整體） */ weighted: number; /** 涉及該團主的完整案件數（含共同歸因；不可加總） */ relatedCases: number }>;
}

export function summarizeComplaints(list: CaseAttribution[]): ComplaintStats {
  const byHost: ComplaintStats['byHost'] = {};
  let unattributed = 0, sharedCases = 0;
  for (const a of list) {
    if (a.kind === 'UNATTRIBUTED') { unattributed++; continue; }
    if (a.kind === 'ORDER_SHARED') sharedCases++;
    for (const h of a.hostIds) {
      const x = (byHost[h] ??= { exclusive: 0, shared: 0, manual: 0, weighted: 0, relatedCases: 0 });
      x.weighted = Math.round((x.weighted + (a.weights[h] ?? 0)) * 1e9) / 1e9; x.relatedCases++;
      if (a.kind === 'ORDER_SHARED') x.shared++;
      else { x.exclusive++; if (a.kind === 'MANUAL') x.manual++; }
    }
  }
  return { total: list.length, unattributed, sharedCases, byHost };
}

/** 某位團主的層級件數（單一歸屬＋人工＋共同歸因）；沒有任何歸屬為 0 */
export const hostLevelCount = (s: ComplaintStats, hostId: string): number => { const x = s.byHost[hostId]; return x ? x.exclusive + x.shared : 0; };
