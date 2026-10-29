/**
 * 三大商業模式的財務與分潤模型【原型，離線驗證用】
 *
 * 狀態：PROPOSED（待 Owner 確認）。這份程式「沒有」接進系統：不讀資料庫、不被任何頁面或 API 呼叫、
 * 不在 npm test 內。目的只有一個：把文件裡的公式變成可以重複執行的算例，證明
 *   1) 各種合作方式（固定費／純分潤／階梯／保底抵佣／保底加佣／混合）算得出一致、可手算核對的金額；
 *   2) 取消、部分退款、跨期退款與更正後，累計金額等於「用最終淨銷售額重算」的金額；
 *   3) 每一筆金額都能拆回組成項目與來源訂單；
 *   4) 品牌 GMV 與代收代付金額不會被當成公司營業收入。
 * 執行：npm run verify:biz-model
 */

export type OrderStatus = 'PAID' | 'PENDING' | 'CANCELLED' | 'REFUNDED' | 'PARTIAL_REFUND';
/** 與 src/server/lib/kpi.ts 的 SALES_STATUSES 相同：PENDING、CANCELLED 不計入任何銷售指標 */
export const SALES_STATUSES: OrderStatus[] = ['PAID', 'PARTIAL_REFUND', 'REFUNDED'];

export interface OrderRow { id: string; status: OrderStatus; gross: number; refund: number; hostId?: string; sharePercent?: number }
/** 退款事件：現行 orders 只有累計 refund_amount，沒有「退款發生日」，所以這是新增資料需求（見資料差異分析 G-02） */
export interface RefundEvent { orderId: string; amount: number; eventDate: string }

export type BasisKind = 'NSV' | 'GMV';
export interface Tier { /** 區間上限（含）；null＝無上限 */ upTo: number | null; ratePercent: number }
export type Component =
  | { type: 'FIXED'; amount: number }
  | { type: 'RATE'; basis: BasisKind; ratePercent: number }
  /** MARGINAL＝累進（每一級只對落在該級的金額抽成）；CLIFF＝全額累進（達到哪一級，全部金額都用該級費率） */
  | { type: 'TIERED'; basis: BasisKind; mode: 'MARGINAL' | 'CLIFF'; tiers: Tier[] }
  /**
   * 保底抵佣 OFFSET：總額 = max(保底, 其他項目合計)，分潤用來「抵」保底，不會疊加。
   * 保底加佣 ADD：總額 = 保底 + 超過 threshold 的部分另外抽成（保底不可被抵銷）。
   */
  | { type: 'FLOOR'; mode: 'OFFSET' | 'ADD'; amount: number; threshold?: number };

export interface FeeRule { id: string; version: number; components: Component[] }

export interface BasisValues { gmv: number; refund: number; nsv: number; salesOrders: number }
export interface Line { type: Component['type'] | 'FLOOR_TOPUP'; amount: number; detail: string }
export interface FeeResult { total: number; lines: Line[]; basis: BasisValues; ruleId: string; ruleVersion: number }

/** 四捨五入到整數元（正數 half-up；負數對稱）。進位規則待 Owner 確認（決策 B-12） */
export const roundHalfUp = (n: number): number => Math.sign(n) * Math.floor(Math.abs(n) + 0.5);
/** 以千分位費率做整數運算，避免浮點誤差（費率最多 3 位小數，同 commission_rules.rate_percent numeric(6,3)） */
export const pctOf = (amount: number, ratePercent: number): number => roundHalfUp((amount * Math.round(ratePercent * 1000)) / 100_000);

/** 取消與未付款不計；退款只算「截至 asOf 已發生」的事件（asOf 為空＝全部）。有退款事件時以事件為準，否則用訂單上的累計退款額 */
export function basisValues(orders: OrderRow[], events: RefundEvent[] = [], asOf?: string): BasisValues {
  const byOrder = new Map<string, number>();
  for (const e of events) if (!asOf || e.eventDate <= asOf) byOrder.set(e.orderId, (byOrder.get(e.orderId) ?? 0) + e.amount);
  let gmv = 0, refund = 0, n = 0;
  for (const o of orders) {
    if (!SALES_STATUSES.includes(o.status)) continue;
    const share = (o.sharePercent ?? 100) / 100;
    const r = events.length ? (byOrder.get(o.id) ?? 0) : o.refund;
    if (r > o.gross) throw new Error(`訂單 ${o.id} 退款大於訂單金額`);
    gmv += o.gross * share; refund += r * share; n++;
  }
  gmv = roundHalfUp(gmv); refund = roundHalfUp(refund);
  return { gmv, refund, nsv: gmv - refund, salesOrders: n };
}

function tiered(basisAmount: number, c: Extract<Component, { type: 'TIERED' }>): { amount: number; detail: string } {
  let lower = 0, sum = 0;
  const parts: string[] = [];
  if (c.mode === 'CLIFF') {
    const t = c.tiers.find((x) => x.upTo == null || basisAmount <= x.upTo) ?? c.tiers[c.tiers.length - 1];
    const a = pctOf(basisAmount, t.ratePercent);
    return { amount: a, detail: `全額累進：${basisAmount} × ${t.ratePercent}% = ${a}` };
  }
  for (const t of c.tiers) {
    const upper = t.upTo ?? Infinity;
    const slice = Math.max(0, Math.min(basisAmount, upper) - lower);
    if (slice > 0) { const a = pctOf(slice, t.ratePercent); sum += a; parts.push(`${slice}×${t.ratePercent}%=${a}`); }
    lower = upper;
    if (basisAmount <= upper) break;
  }
  return { amount: sum, detail: `累進：${parts.join(' + ')}` };
}

/** 依合約規則計算費用／分潤。每一行都有組成與算式，可逐項核對；行加總必等於總額 */
export function computeFee(rule: FeeRule, b: BasisValues): FeeResult {
  const floor = rule.components.find((c): c is Extract<Component, { type: 'FLOOR' }> => c.type === 'FLOOR');
  const lines: Line[] = [];
  for (const c of rule.components) {
    if (c.type === 'FLOOR') continue;
    const raw = c.type === 'FIXED' ? 0 : c.basis === 'NSV' ? b.nsv : b.gmv;
    const base = floor?.mode === 'ADD' && c.type !== 'FIXED' ? Math.max(0, raw - (floor.threshold ?? 0)) : raw;
    if (c.type === 'FIXED') lines.push({ type: 'FIXED', amount: c.amount, detail: `固定費 ${c.amount}` });
    else if (c.type === 'RATE') { const a = pctOf(base, c.ratePercent); lines.push({ type: 'RATE', amount: a, detail: `${c.basis} ${base} × ${c.ratePercent}% = ${a}` }); }
    else { const t = tiered(base, c); lines.push({ type: 'TIERED', amount: t.amount, detail: `${c.basis} ${base} ${t.detail}` }); }
  }
  if (floor?.mode === 'ADD') lines.push({ type: 'FLOOR', amount: floor.amount, detail: `保底加佣：保底 ${floor.amount}（不可被抵銷）；超過門檻 ${floor.threshold ?? 0} 的部分另計` });
  const variable = lines.reduce((a, l) => a + l.amount, 0);
  if (floor?.mode === 'OFFSET') {
    lines.push({ type: 'FLOOR', amount: 0, detail: `保底抵佣：保底 ${floor.amount}，其他項目合計 ${variable}` });
    if (variable < floor.amount) lines.push({ type: 'FLOOR_TOPUP', amount: floor.amount - variable, detail: `補足至保底 ${floor.amount}` });
  }
  const total = lines.reduce((a, l) => a + l.amount, 0);
  return { total, lines, basis: b, ruleId: rule.id, ruleVersion: rule.version };
}

/** 更正（跨期退款、取消後補正）：用「最終基礎」重算，減去已確認的累計金額，差額就是本期更正。更正前後累計恆等於一次算完 */
export function correction(rule: FeeRule, finalBasis: BasisValues, alreadySettled: number): { delta: number; recomputed: FeeResult } {
  const recomputed = computeFee(rule, finalBasis);
  return { delta: recomputed.total - alreadySettled, recomputed };
}

/** 把一筆總額依比例分給多位團主，使用最大餘數法，保證加總 = 總額（避免四捨五入產生一兩元差異） */
export function allocate(total: number, shares: { id: string; percent: number }[]): Record<string, number> {
  const sum = shares.reduce((a, s) => a + s.percent, 0);
  if (Math.abs(sum - 100) > 1e-9) throw new Error(`分攤比例合計需為 100（目前 ${sum}）`);
  const raw = shares.map((s) => ({ id: s.id, exact: (total * s.percent) / 100 }));
  const out: Record<string, number> = Object.fromEntries(raw.map((r) => [r.id, Math.floor(r.exact)]));
  let left = total - Object.values(out).reduce((a, v) => a + v, 0);
  for (const r of [...raw].sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)))) { if (left <= 0) break; out[r.id]++; left--; }
  return out;
}

export interface Economics {
  brandGmv: number; nsv: number;
  /** 公司營業收入（代理人：只認服務費／分潤，不含代收貨款） */
  companyRevenue: number;
  hostCommissionCost: number; variableCosts: number;
  contribution: number; takeRatePct: number | null; contributionMarginPct: number | null;
}

/**
 * 公司經濟：品牌 GMV、淨銷售額、公司營業收入、貢獻利潤是四個不同的數字。
 *   公司營業收入 = 向品牌收取的服務費／分潤（代理人淨額法）
 *   貢獻利潤     = 公司營業收入 − 公司負擔的團主分潤 − 直接變動成本（運費、行銷、樣品、金流費…）
 * hostPaidBy = 'BRAND' 時，團主分潤由品牌直接支付，不是公司成本。
 */
export function companyEconomics(p: { basis: BasisValues; brandFee: number; hostCommission: number; hostPaidBy: 'COMPANY' | 'BRAND'; variableCosts: number }): Economics {
  const hostCost = p.hostPaidBy === 'COMPANY' ? p.hostCommission : 0;
  const contribution = p.brandFee - hostCost - p.variableCosts;
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10_000) / 100 : null);
  return { brandGmv: p.basis.gmv, nsv: p.basis.nsv, companyRevenue: p.brandFee, hostCommissionCost: hostCost, variableCosts: p.variableCosts, contribution,
    takeRatePct: pct(p.brandFee, p.basis.nsv), contributionMarginPct: pct(contribution, p.brandFee) };
}

/** 代營運居中（公司代收代付）時的現金帳：代收款是負債，不是收入；收款 = 應付品牌 + 公司留存服務費 */
export function escrowBalances(p: { cashCollected: number; refundsPaidOut: number; brandFee: number }): { netCash: number; remitToBrand: number; retainedFee: number; check: boolean } {
  const netCash = p.cashCollected - p.refundsPaidOut;
  const remitToBrand = netCash - p.brandFee;
  return { netCash, remitToBrand, retainedFee: p.brandFee, check: remitToBrand + p.brandFee === netCash };
}
