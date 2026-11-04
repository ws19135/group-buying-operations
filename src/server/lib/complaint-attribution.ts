/**
 * 客訴（客服案件）的團主歸屬規則（Owner 決策 K-5；純函式，沒有資料庫相依）。
 *   1. 優先由既有訂單歸因取得團主：案件有關聯訂單、且該訂單有歸因（attributions）。
 *        只有一位團主 → 單一歸屬（ORDER_SINGLE）；兩位以上 → 共同歸因：
 *          · 有**可靠的歸因比例**（每位團主都有比例、合計 100%）→ ORDER_SHARED，依比例分攤；
 *          · 沒有可靠比例 → ORDER_SHARED_UNWEIGHTED：**不預設平均分配**，保留相關團主清單、歸因依據與待人工確認原因，不計入任何團主的加權件數（Owner 決策 D-2）。
 *   2. 沒有訂單、或訂單沒有歸因：保留「未歸屬」（UNATTRIBUTED）；只有此時才允許人工指定團主（MANUAL，需說明）。
 *   3. 不任意分配：無法辨識就是未歸屬。
 * 統計（Owner 決策 K-5a）：
 *   公司整體客訴件數＝案件數，**同一客訴案件只計算一次**；絕不把各團主的「完整件數」加總當成公司整體。
 *   團主層級＝**加權客訴數**：共同歸因且有可靠比例的案件，依訂單歸因比例（share_percent，合計 100%）把這一件分給各相關團主，每件合計剛好 1 件；
 *   單一歸屬／人工指定＝1 件全給該團主。因此「各團主加權客訴數合計 ＋ 未歸屬件數 ＋ 共同歸因待確認件數 ＝ 公司整體件數」（測試驗證）。
 *   沒有可靠比例的共同歸因件（sharedUnweighted）不分配給任何團主，也不被當成已知績效；相關團主仍保留在清單（relatedCases／pendingShared）。
 *   完整的關聯團主清單另行保留（relatedCases：涉及該團主的案件數，含共同歸因，**不可加總**），供查詢與個案處理。
 *   無法可靠歸因＝未歸屬，不任意分配、不計入任何團主。
 * 客訴率只供營運觀察，不作為團主懲罰、停權或任何自動處置的依據（沒有任何程式讀取它來做決定）。
 */
export type HostAttributionKind = 'ORDER_SINGLE' | 'ORDER_SHARED' | 'ORDER_SHARED_UNWEIGHTED' | 'MANUAL' | 'UNATTRIBUTED';
export const ATTRIBUTION_LABEL: Record<HostAttributionKind, string> = {
  ORDER_SINGLE: '訂單歸因（單一團主）', ORDER_SHARED: '訂單歸因（多位團主共同歸因，依比例）', ORDER_SHARED_UNWEIGHTED: '訂單歸因（多位團主共同歸因，沒有可靠比例，待人工確認）', MANUAL: '人工指定', UNATTRIBUTED: '未歸屬',
};
export interface CaseAttribInput { caseId: string; manualHostId: string | null; orderId: string | null; orderHostIds: string[]; /** 訂單歸因比例（hostId → share_percent）；沒有或不可靠（缺漏、非正數、合計不是 100%）時，共同歸因不分攤（D-2：不預設平均分配） */ orderShares?: Record<string, number> }
export interface CaseAttribution { caseId: string; kind: HostAttributionKind; hostIds: string[]; /** 各團主分到這一件客訴的權重（合計 1；未歸屬、沒有可靠比例的共同歸因為空） */ weights: Record<string, number>; /** 歸因依據（說明這個結果從哪裡來） */ basis: string; /** 待人工確認的原因；null＝不需要 */ reviewReason: string | null }

/** 歸因比例是否可靠：每位團主都有正的有限比例，且合計 100%（容許 0.01 的四捨五入誤差；與結算使用歸因比例的前提一致） */
export const SHARE_SUM_TOLERANCE = 0.01;
export function reliableWeights(hosts: string[], shares?: Record<string, number>): Record<string, number> | null {
  if (!shares) return null;
  const vals = hosts.map((h) => shares[h]);
  if (vals.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) return null;
  const sum = (vals as number[]).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > SHARE_SUM_TOLERANCE) return null;
  return Object.fromEntries(hosts.map((h, idx) => [h, (vals[idx] as number) / sum]));
}

export function resolveCaseAttribution(c: CaseAttribInput): CaseAttribution {
  const hosts = Array.from(new Set(c.orderHostIds));
  if (c.orderId && hosts.length === 1) return { caseId: c.caseId, kind: 'ORDER_SINGLE', hostIds: hosts, weights: { [hosts[0]]: 1 }, basis: '訂單歸因：此訂單只歸因給一位團主', reviewReason: null };
  if (c.orderId && hosts.length > 1) {
    const sorted = hosts.sort();
    const w = reliableWeights(sorted, c.orderShares);
    if (w) return { caseId: c.caseId, kind: 'ORDER_SHARED', hostIds: sorted, weights: w, basis: `訂單歸因比例：${sorted.map((h) => `${h} ${Math.round(w[h] * 10000) / 100}%`).join('、')}（合計 100%）`, reviewReason: null };
    return { caseId: c.caseId, kind: 'ORDER_SHARED_UNWEIGHTED', hostIds: sorted, weights: {}, basis: '訂單歸因給多位團主，但沒有可靠的歸因比例', reviewReason: '歸因比例缺漏或合計不是 100%：不預設平均分配，這一件不計入任何團主的加權客訴數；請依訂單歸因資料補齊可靠比例後再計入' };
  }
  if (c.manualHostId) return { caseId: c.caseId, kind: 'MANUAL', hostIds: [c.manualHostId], weights: { [c.manualHostId]: 1 }, basis: '人工指定（訂單沒有歸因，需說明原因並留稽核）', reviewReason: null };
  return { caseId: c.caseId, kind: 'UNATTRIBUTED', hostIds: [], weights: {}, basis: c.orderId ? '訂單沒有歸因' : '沒有關聯訂單', reviewReason: '無法由訂單歸因取得團主：保留未歸屬；可人工指定（需說明原因）' };
}

export interface ComplaintStats {
  /** 公司整體（檔期）客訴件數：每件只算一次 */
  total: number;
  /** 無法歸屬任何團主的件數（保留未歸屬，不分配） */
  unattributed: number;
  /** 共同歸因（多位團主，含有無可靠比例）的件數：整體只算一次 */
  sharedCases: number;
  /** 共同歸因但沒有可靠比例的件數（待人工確認；不分配給任何團主，不預設平均）。total ＝ Σ團主加權 ＋ unattributed ＋ sharedUnweighted */
  sharedUnweighted: number;
  byHost: Record<string, { exclusive: number; shared: number; manual: number; /** 加權客訴數（共同歸因依比例分攤；各團主合計＋未歸屬＝整體） */ weighted: number; /** 涉及該團主的完整案件數（含共同歸因；不可加總） */ relatedCases: number; /** 涉及此團主、但共同歸因沒有可靠比例而待人工確認的件數（未計入加權） */ pendingShared: number }>;
}

export function summarizeComplaints(list: CaseAttribution[]): ComplaintStats {
  const byHost: ComplaintStats['byHost'] = {};
  let unattributed = 0, sharedCases = 0, sharedUnweighted = 0;
  for (const a of list) {
    if (a.kind === 'UNATTRIBUTED') { unattributed++; continue; }
    if (a.kind === 'ORDER_SHARED' || a.kind === 'ORDER_SHARED_UNWEIGHTED') sharedCases++;
    if (a.kind === 'ORDER_SHARED_UNWEIGHTED') sharedUnweighted++;
    for (const h of a.hostIds) {
      const x = (byHost[h] ??= { exclusive: 0, shared: 0, manual: 0, weighted: 0, relatedCases: 0, pendingShared: 0 });
      x.weighted = Math.round((x.weighted + (a.weights[h] ?? 0)) * 1e9) / 1e9; x.relatedCases++;
      if (a.kind === 'ORDER_SHARED_UNWEIGHTED') { x.shared++; x.pendingShared++; }
      else if (a.kind === 'ORDER_SHARED') x.shared++;
      else { x.exclusive++; if (a.kind === 'MANUAL') x.manual++; }
    }
  }
  return { total: list.length, unattributed, sharedCases, sharedUnweighted, byHost };
}

/** 某位團主的層級件數（單一歸屬＋人工＋共同歸因）；沒有任何歸屬為 0 */
export const hostLevelCount = (s: ComplaintStats, hostId: string): number => { const x = s.byHost[hostId]; return x ? x.exclusive + x.shared : 0; };
