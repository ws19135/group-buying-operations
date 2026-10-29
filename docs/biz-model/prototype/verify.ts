import assert from 'node:assert/strict';
import { allocate, basisValues, companyEconomics, computeFee, correction, escrowBalances, type FeeRule, type OrderRow, type RefundEvent } from './settlement-model';

const results: { id: string; title: string; expect: string; actual: string }[] = [];
let n = 0;
function check(title: string, expect: unknown, actual: unknown, fn: () => void) {
  n++;
  fn();
  results.push({ id: `V${String(n).padStart(2, '0')}`, title, expect: String(expect), actual: String(actual) });
}
const rule = (id: string, components: FeeRule['components']): FeeRule => ({ id, version: 1, components });
const B = (nsv: number, gmv = nsv): ReturnType<typeof basisValues> => ({ gmv, refund: gmv - nsv, nsv, salesOrders: 1 });

// ---- 合作方式 ----
{
  const r = computeFee(rule('R-RATE', [{ type: 'RATE', basis: 'NSV', ratePercent: 10 }]), B(100_000));
  check('純分潤 10%：淨銷售 100,000', 10_000, r.total, () => assert.equal(r.total, 10_000));
}
{
  const r = computeFee(rule('R-FIX', [{ type: 'FIXED', amount: 20_000 }]), B(5_000));
  check('固定費：不論業績都是 20,000', 20_000, r.total, () => assert.equal(r.total, 20_000));
}
const tiers = [{ upTo: 100_000, ratePercent: 5 }, { upTo: 300_000, ratePercent: 8 }, { upTo: null, ratePercent: 10 }];
{
  const m = computeFee(rule('R-TM', [{ type: 'TIERED', basis: 'NSV', mode: 'MARGINAL', tiers }]), B(250_000));
  check('階梯（累進）：250,000＝100,000×5% + 150,000×8%', 17_000, m.total, () => assert.equal(m.total, 17_000));
  const c = computeFee(rule('R-TC', [{ type: 'TIERED', basis: 'NSV', mode: 'CLIFF', tiers }]), B(250_000));
  check('階梯（全額累進）：250,000 落在第二級，全額 × 8%', 20_000, c.total, () => assert.equal(c.total, 20_000));
  const m2 = computeFee(rule('R-TM', [{ type: 'TIERED', basis: 'NSV', mode: 'MARGINAL', tiers }]), B(350_000));
  check('階梯（累進）跨三級：350,000＝5,000 + 16,000 + 5,000', 26_000, m2.total, () => assert.equal(m2.total, 26_000));
  const edge = computeFee(rule('R-TM', [{ type: 'TIERED', basis: 'NSV', mode: 'MARGINAL', tiers }]), B(100_000));
  check('階梯邊界：剛好 100,000 只算第一級', 5_000, edge.total, () => assert.equal(edge.total, 5_000));
}
{
  const off = rule('R-FO', [{ type: 'RATE', basis: 'NSV', ratePercent: 10 }, { type: 'FLOOR', mode: 'OFFSET', amount: 10_000 }]);
  const lo = computeFee(off, B(60_000));
  check('保底抵佣：分潤 6,000 < 保底 10,000 → 付 10,000（補 4,000）', 10_000, lo.total, () => { assert.equal(lo.total, 10_000); assert.equal(lo.lines.find((l) => l.type === 'FLOOR_TOPUP')?.amount, 4_000); });
  const hi = computeFee(off, B(150_000));
  check('保底抵佣：分潤 15,000 > 保底 → 付 15,000（不再另加保底）', 15_000, hi.total, () => assert.equal(hi.total, 15_000));
}
{
  const off = rule('R-FO', [{ type: 'RATE', basis: 'NSV', ratePercent: 10 }, { type: 'FLOOR', mode: 'OFFSET', amount: 10_000 }]);
  const add = rule('R-FA', [{ type: 'RATE', basis: 'NSV', ratePercent: 10 }, { type: 'FLOOR', mode: 'ADD', amount: 10_000, threshold: 50_000 }]);
  const lo = computeFee(add, B(40_000));
  check('保底加佣（門檻 50,000）：未達門檻 → 只付保底 10,000', 10_000, lo.total, () => assert.equal(lo.total, 10_000));
  const hi = computeFee(add, B(150_000));
  check('保底加佣：超過門檻的 100,000 × 10% = 10,000，加保底 10,000 → 20,000', 20_000, hi.total, () => assert.equal(hi.total, 20_000));
  const o = computeFee(off, B(150_000));
  check('同樣淨銷售 150,000：保底抵佣只付 15,000，保底加佣付 20,000，兩者不同', '15000 vs 20000', `${o.total} vs ${hi.total}`, () => { assert.equal(o.total, 15_000); assert.notEqual(o.total, hi.total); });
  const same = rule('R-FA2', [{ type: 'RATE', basis: 'NSV', ratePercent: 10 }, { type: 'FLOOR', mode: 'ADD', amount: 10_000, threshold: 100_000 }]);
  check('性質：加佣門檻 = 保底 ÷ 費率（100,000）時，兩者在任何業績下金額相同，所以合約必須寫清楚門檻', 'equal', `${computeFee(same, B(250_000)).total}=${computeFee(off, B(250_000)).total}`, () => { for (const v of [0, 60_000, 100_000, 250_000]) assert.equal(computeFee(same, B(v)).total, computeFee(off, B(v)).total); });
}
{
  const h = computeFee(rule('R-HY', [{ type: 'FIXED', amount: 5_000 }, { type: 'RATE', basis: 'NSV', ratePercent: 3 }]), B(100_000));
  check('混合（固定費 + 分潤 3%）：5,000 + 3,000', 8_000, h.total, () => assert.equal(h.total, 8_000));
  const g = computeFee(rule('R-GMV', [{ type: 'RATE', basis: 'GMV', ratePercent: 2 }]), B(90_000, 100_000));
  check('分潤基礎可選 GMV：100,000 × 2%（與 NSV 基礎的 1,800 不同）', 2_000, g.total, () => assert.equal(g.total, 2_000));
}

// ---- 取消、部分退款 ----
const orders: OrderRow[] = [
  { id: 'O1', status: 'PAID', gross: 100_000, refund: 0 },
  { id: 'O2', status: 'PARTIAL_REFUND', gross: 80_000, refund: 20_000 },
  { id: 'O3', status: 'REFUNDED', gross: 50_000, refund: 50_000 },
  { id: 'O4', status: 'CANCELLED', gross: 70_000, refund: 0 },
  { id: 'O5', status: 'PENDING', gross: 60_000, refund: 0 },
  { id: 'O6', status: 'PAID', gross: 120_000, refund: 0 },
];
{
  const b = basisValues(orders);
  check('取消與未付款不計；部分退款只扣退款額：GMV 350,000、退款 70,000、淨銷售 280,000', '350000/70000/280000', `${b.gmv}/${b.refund}/${b.nsv}`, () => { assert.equal(b.gmv, 350_000); assert.equal(b.refund, 70_000); assert.equal(b.nsv, 280_000); });
  check('計入銷售的訂單數 4（O4 取消、O5 未付款不計）', 4, b.salesOrders, () => assert.equal(b.salesOrders, 4));
  assert.throws(() => basisValues([{ id: 'X', status: 'PAID', gross: 10, refund: 11 }]));
}

// ---- 跨期退款與更正 ----
{
  const r = rule('R-TM', [{ type: 'TIERED', basis: 'NSV', mode: 'MARGINAL', tiers }]);
  const all: OrderRow[] = [{ id: 'A', status: 'PAID', gross: 150_000, refund: 0 }, { id: 'B', status: 'PAID', gross: 100_000, refund: 0 }];
  const events: RefundEvent[] = [{ orderId: 'B', amount: 60_000, eventDate: '2026-12-10' }];
  const p1 = computeFee(r, basisValues(all, events, '2026-11-30'));
  check('第 1 期（11 月結算）：淨銷售 250,000 → 分潤 17,000，確認鎖定', 17_000, p1.total, () => assert.equal(p1.total, 17_000));
  const c = correction(r, basisValues(all, events, '2026-12-31'), p1.total);
  check('第 2 期：12/10 發生跨期退款 60,000 → 重算最終淨銷售 190,000 = 12,200，更正 −4,800', -4_800, c.delta, () => { assert.equal(c.recomputed.total, 12_200); assert.equal(c.delta, -4_800); });
  check('更正後累計 = 一次用最終淨銷售算完（17,000 + (−4,800) = 12,200）', 12_200, p1.total + c.delta, () => assert.equal(p1.total + c.delta, computeFee(r, basisValues(all, events)).total));
  const c2 = correction(r, basisValues(all, events, '2026-12-31'), p1.total + c.delta);
  check('更正可重複執行（冪等）：已更正過再算，差額 0', 0, c2.delta, () => assert.equal(c2.delta, 0));
  const fl = rule('R-FO', [{ type: 'RATE', basis: 'NSV', ratePercent: 10 }, { type: 'FLOOR', mode: 'OFFSET', amount: 10_000 }]);
  const low: OrderRow[] = [{ id: 'L1', status: 'PAID', gross: 150_000, refund: 0 }];
  const lowEv: RefundEvent[] = [{ orderId: 'L1', amount: 70_000, eventDate: '2026-12-10' }];
  const f1 = computeFee(fl, basisValues(low, lowEv, '2026-11-30'));
  const f2 = correction(fl, basisValues(low, lowEv, '2026-12-31'), f1.total);
  check('保底抵佣遇跨期退款：15,000 → 淨銷售降到 80,000（分潤 8,000 < 保底）→ 應付 10,000，更正只有 −5,000，不是 −7,000', -5_000, f2.delta, () => { assert.equal(f1.total, 15_000); assert.equal(f2.recomputed.total, 10_000); assert.equal(f2.delta, -5_000); });
}

// ---- 分攤與四捨五入 ----
{
  const a = allocate(10_001, [{ id: 'H1', percent: 33.3 }, { id: 'H2', percent: 33.3 }, { id: 'H3', percent: 33.4 }]);
  const sum = Object.values(a).reduce((x, y) => x + y, 0);
  check('多團主分攤用最大餘數法：加總必等於總額 10,001', 10_001, sum, () => assert.equal(sum, 10_001));
  assert.throws(() => allocate(100, [{ id: 'H1', percent: 60 }, { id: 'H2', percent: 30 }]));
}

// ---- 可追溯 ----
{
  const r = computeFee(rule('R-HY', [{ type: 'FIXED', amount: 5_000 }, { type: 'TIERED', basis: 'NSV', mode: 'MARGINAL', tiers }]), basisValues(orders));
  const lineSum = r.lines.reduce((a, l) => a + l.amount, 0);
  check('每筆金額可拆成組成行，行加總 = 總額；並帶規則版本', `${r.total}`, `${lineSum}（規則 ${r.ruleId} v${r.ruleVersion}）`, () => { assert.equal(lineSum, r.total); assert.ok(r.lines.every((l) => l.detail.length > 0)); });
  const srcNet = orders.filter((o) => ['PAID', 'PARTIAL_REFUND', 'REFUNDED'].includes(o.status)).reduce((a, o) => a + o.gross - o.refund, 0);
  check('來源訂單加總 = 計算基礎（淨銷售額）：可從結算額逐層回溯到訂單', srcNet, r.basis.nsv, () => assert.equal(srcNet, r.basis.nsv));
}

// ---- 公司收入 ≠ GMV ----
{
  const basis = basisValues([{ id: 'S1', status: 'PAID', gross: 300_000, refund: 30_000 }]);
  const brandFee = computeFee(rule('B-FEE', [{ type: 'RATE', basis: 'NSV', ratePercent: 15 }]), basis).total;
  const hostComm = computeFee(rule('H-COM', [{ type: 'RATE', basis: 'NSV', ratePercent: 8 }]), basis).total;
  const e = companyEconomics({ basis, brandFee, hostCommission: hostComm, hostPaidBy: 'COMPANY', variableCosts: 5_000 });
  check('GMV 300,000／退款 30,000／淨銷售 270,000；公司營業收入只有服務費 40,500（15%），不是 GMV', 40_500, e.companyRevenue, () => { assert.equal(e.brandGmv, 300_000); assert.equal(e.nsv, 270_000); assert.equal(e.companyRevenue, 40_500); assert.notEqual(e.companyRevenue, e.brandGmv); });
  check('貢獻利潤 = 40,500 − 團主分潤 21,600 − 變動成本 5,000 = 13,900；抽成率 15%、貢獻利潤率 34.32%', 13_900, e.contribution, () => { assert.equal(e.contribution, 13_900); assert.equal(e.takeRatePct, 15); assert.equal(e.contributionMarginPct, 34.32); });
  const brandPays = companyEconomics({ basis, brandFee, hostCommission: hostComm, hostPaidBy: 'BRAND', variableCosts: 5_000 });
  check('團主分潤若由品牌直接支付，不是公司成本：貢獻利潤 = 40,500 − 5,000 = 35,500', 35_500, brandPays.contribution, () => assert.equal(brandPays.contribution, 35_500));
  const esc = escrowBalances({ cashCollected: 300_000, refundsPaidOut: 30_000, brandFee });
  check('代營運居中：代收 300,000 − 退款 30,000，應付品牌 229,500、公司留存 40,500；代收款是負債不是收入', 229_500, esc.remitToBrand, () => { assert.equal(esc.remitToBrand, 229_500); assert.ok(esc.check); });
}

console.info('| # | 驗證項目 | 預期 | 實際 | 結果 |\n|---|---|---|---|---|');
for (const r of results) console.info(`| ${r.id} | ${r.title} | ${r.expect} | ${r.actual} | ✅ |`);
console.info(`\n全部 ${results.length} 項通過`);
