/**
 * 多商品檔期成本分攤：候選方法與情境比較（Owner 決策 K-7；純函式；**提案，未生效**）。
 * 本階段不啟用自動成本分攤：多商品檔期無法可靠歸屬的每單貢獻利潤維持「資料不足」（lib/actual-profit 的 multiProduct 規則不變）。
 * 這裡只示範「如果採用某種分攤方法，各商品分到多少」，讓 Owner 比較不同方法的差異；不寫入任何資料、不產生任何正式生效的規則、不使用假設成本填補未知資料
 * （金額未知的費用就是未知，不會被分攤，也不會被當成 0）。
 *
 * 候選方法：
 *   BY_NSV            依各商品有效淨銷售額占比分攤共同費用（銷售貢獻越大、分到越多）
 *   BY_QUANTITY       依各商品出貨數量占比分攤
 *   BY_ORDER_LINES    依各商品出現在幾筆訂單的明細（訂單行數）占比分攤
 *   DIRECT_THEN_NSV   可直接歸屬到商品的費用（例如按 GMV 的平台費、按銷售額的服務費與分潤、以 SKU 計的商品成本）直接算在該商品；
 *                     其餘共同費用（固定費用、整筆運費…）再依有效淨銷售額分攤
 */
export const ALLOCATION_METHODS = ['BY_NSV', 'BY_QUANTITY', 'BY_ORDER_LINES', 'DIRECT_THEN_NSV'] as const;
export type AllocationMethod = (typeof ALLOCATION_METHODS)[number];
export const METHOD_LABEL: Record<AllocationMethod, string> = {
  BY_NSV: '依有效淨銷售額占比', BY_QUANTITY: '依數量占比', BY_ORDER_LINES: '依訂單明細行數占比', DIRECT_THEN_NSV: '可直接歸屬者直接算，其餘依有效淨銷售額',
};
export const METHOD_NOTE: Record<AllocationMethod, string> = {
  BY_NSV: '簡單、與收入連動；但低價高量商品分到的運費偏少',
  BY_QUANTITY: '與實際出貨量連動（運費、包材合理）；但高單價商品的平台費、分潤被低估',
  BY_ORDER_LINES: '只反映被買的次數，不反映數量或金額；適合以「每筆訂單」計價的費用',
  DIRECT_THEN_NSV: '最貼近實際：能直接歸屬的不分攤；需要每項費用標明「是否可直接歸屬」，資料要求最高',
};

export interface ProductBasis {
  productId: string; name: string;
  /** 該商品的有效淨銷售額（計入銷售訂單的明細金額）；null＝無法取得 */
  nsv: number | null;
  quantity: number | null;
  orderLines: number | null;
  /** 商品成本（SKU 成本 × 數量）；任一 SKU 缺成本就是 null（未知，不當 0） */
  productCost: number | null;
}
export interface SharedCost {
  key: string; label: string;
  /** 金額（元）；null＝未知，不分攤、不當 0 */
  amount: number | null;
  /** 這項費用能不能直接歸屬到商品：direct 以各商品的 NSV 乘費率，或以各商品數量乘單價 */
  direct?: { kind: 'RATE_ON_NSV'; ratePct: number } | { kind: 'PER_UNIT'; unitAmount: number };
}
export interface ProductAllocation { productId: string; name: string; total: number; byCost: Record<string, number | null> }
export interface MethodResult {
  method: AllocationMethod; label: string; note: string;
  /** 缺資料（分母或必要欄位為 null／0）：這個方法不能用，並說明原因 */
  usable: boolean; problems: string[];
  allocations: ProductAllocation[];
  /** 未知金額（未分攤）的費用 */
  unknownCosts: string[];
}
export interface AllocationComparison {
  effective: false; status: 'PROPOSAL_ONLY';
  methods: MethodResult[];
  /** 各商品在不同方法下分到的合計的最大差距（元）：差距越大，方法選擇越重要 */
  spreadByProduct: Record<string, number>;
  note: string;
}

const rnd = (n: number) => Math.round(n);

/** 依權重把 amount 分成整數元，餘數依最大餘額法補齊，確保加總等於原金額（避免四捨五入差一元） */
export function splitByWeights(amount: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / sum);
  const base = raw.map(Math.floor);
  let rest = amount - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, idx) => ({ idx, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.idx - b.idx);
  for (const o of order) { if (rest <= 0) break; base[o.idx] += 1; rest--; }
  return base;
}

export function compareAllocations(products: ProductBasis[], costs: SharedCost[]): AllocationComparison {
  const methods: MethodResult[] = ALLOCATION_METHODS.map((method) => {
    const problems: string[] = [];
    const weightOf = (p: ProductBasis): number | null => (method === 'BY_QUANTITY' ? p.quantity : method === 'BY_ORDER_LINES' ? p.orderLines : p.nsv);
    const weights = products.map(weightOf);
    const missingW = products.filter((_, idx) => weights[idx] == null).map((p) => p.name);
    if (products.length < 2) problems.push('不是多商品檔期');
    if (missingW.length) problems.push(`缺少分攤基礎（${method === 'BY_QUANTITY' ? '數量' : method === 'BY_ORDER_LINES' ? '訂單明細行數' : '有效淨銷售額'}）：${missingW.join('、')}`);
    else if ((weights as number[]).reduce((a, b) => a + b, 0) <= 0) problems.push('分攤基礎合計為 0');
    const usable = problems.length === 0;
    const unknownCosts = costs.filter((c) => c.amount == null).map((c) => c.label);
    const allocations: ProductAllocation[] = products.map((p) => ({ productId: p.productId, name: p.name, total: 0, byCost: {} }));
    if (usable) {
      const w = weights as number[];
      for (const c of costs) {
        if (c.amount == null) { for (const a of allocations) a.byCost[c.key] = null; continue; }
        if (method === 'DIRECT_THEN_NSV' && c.direct) {
          // 可直接歸屬：各商品依自己的銷售額／數量計算；直接計算的合計與總額的差額（四捨五入、費率不一致等）不另外分攤，保留在「未分攤差額」由人工確認
          allocations.forEach((a, idx) => {
            const p = products[idx];
            const v = c.direct!.kind === 'RATE_ON_NSV' ? (p.nsv == null ? null : rnd((p.nsv * c.direct!.ratePct) / 100)) : (p.quantity == null ? null : rnd(p.quantity * c.direct!.unitAmount));
            a.byCost[c.key] = v; if (v != null) a.total += v;
          });
          continue;
        }
        const parts = splitByWeights(c.amount, w);
        allocations.forEach((a, idx) => { a.byCost[c.key] = parts[idx]; a.total += parts[idx]; });
      }
    }
    return { method, label: METHOD_LABEL[method], note: METHOD_NOTE[method], usable, problems, allocations, unknownCosts };
  });
  const spreadByProduct: Record<string, number> = {};
  for (const p of products) {
    const totals = methods.filter((m) => m.usable).map((m) => m.allocations.find((a) => a.productId === p.productId)?.total ?? 0);
    spreadByProduct[p.productId] = totals.length >= 2 ? Math.max(...totals) - Math.min(...totals) : 0;
  }
  return {
    effective: false, status: 'PROPOSAL_ONLY', methods, spreadByProduct,
    note: '提案，未生效：Owner 核准前，多商品檔期的每單貢獻利潤維持「資料不足」；這裡的分攤結果不會寫入任何資料，也不會被 KPI、實際值回寫或結算使用。未知金額的費用不分攤、不當 0。',
  };
}
