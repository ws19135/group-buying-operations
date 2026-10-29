import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FIT_CONFIG, bucketCaseRate, bucketExceptionRate, bucketRatio, configProblems, hardChecks, inputHash, scoreFit,
  type FitConfig, type FitInput, type FitProduct, type FitSegment, type HistoryInput, type SupplyInput,
} from '@/server/lib/fit-score';
import { aliasesOf, normText } from '@/server/lib/segment-vocab';

const NO_HISTORY: HistoryInput = { scope: 'NONE', hostCampaigns: 0, hostAvgNet: null, hostRefundRate: null, benchRows: 0, benchAvgNet: null, benchRefundRate: null };
const NO_SUPPLY: SupplyInput = { shipments: 0, exceptions: 0, orders: 0, cases: 0 };
const GOOD_HISTORY: HistoryInput = { scope: 'SAME_CATEGORY', hostCampaigns: 3, hostAvgNet: 130_000, hostRefundRate: 0.02, benchRows: 10, benchAvgNet: 100_000, benchRefundRate: 0.03 };
const GOOD_SUPPLY: SupplyInput = { shipments: 100, exceptions: 1, orders: 500, cases: 2 };

const product = (over: Partial<FitProduct> = {}): FitProduct => ({
  id: 'PRD-1', name: '[DEMO] 家庭除菌洗衣精', category: '家庭清潔',
  sellingPoints: '省時一次洗淨，SGS 檢驗安心，七天退換', description: null, complianceNote: 'SGS 報告 DEMO-001',
  reviewStatus: 'APPROVED', vendorStatus: 'ACTIVE', skuPrices: [400, 600], ...over,
});
// 範例輪廓：育兒家庭 30–44 歲，每月，LINE；動機＝省時間＋品質安心；阻力＝陌生品牌＋怕踩雷；偏好品類＝家庭清潔＋親子用品
const seg = (over: Partial<FitSegment> = {}): FitSegment => ({
  id: 'SEG-1', name: '育兒家庭 30–44 歲', basis: 'ESTIMATE', linkBasis: 'ESTIMATE', sharePercent: null, priceMin: null, priceMax: null,
  prefs: [
    { kind: 'MOTIVE', value: '省時間', basis: 'ESTIMATE' }, { kind: 'MOTIVE', value: '品質安心', basis: 'ESTIMATE' },
    { kind: 'BARRIER', value: '陌生品牌', basis: 'ESTIMATE' }, { kind: 'BARRIER', value: '怕踩雷', basis: 'ESTIMATE' },
    { kind: 'CATEGORY', value: '家庭清潔', basis: 'ESTIMATE' }, { kind: 'CATEGORY', value: '親子用品', basis: 'ESTIMATE' },
    { kind: 'CHANNEL', value: 'LINE', basis: 'ESTIMATE' },
  ], ...over,
});
const input = (over: Partial<FitInput> = {}): FitInput => ({ segments: [seg()], product: product(), history: NO_HISTORY, supply: NO_SUPPLY, ...over });
const dim = (r: ReturnType<typeof scoreFit>, k: string) => r.dimensions.find((d) => d.key === k)!;

describe('未知資料不當 0 分', () => {
  it('只有兩個維度有資料：總分用已知權重重新正規化，完整度＝已知權重比例', () => {
    const r = scoreFit(input());
    expect(dim(r, 'category').score).toBe(5);
    expect(dim(r, 'need').score).toBe(5);
    expect(dim(r, 'price').known).toBe(false);
    expect(dim(r, 'history').known).toBe(false);
    expect(dim(r, 'supply').known).toBe(false);
    expect(r.completeness).toBe(0.5);          // need 30 + category 20 = 50
    expect(r.totalScore).toBe(100);            // 兩個已知維度都是滿分；若把未知當 0 分會得到 50
  });
  it('未知維度的 score 是 null，不是 0；理由寫明缺什麼', () => {
    const r = scoreFit(input());
    for (const k of ['price', 'history', 'supply']) {
      expect(dim(r, k).score).toBeNull();
      expect(dim(r, k).basis).toBeNull();
    }
    expect(r.reasons.some((x) => x.startsWith('缺資料：價格'))).toBe(true);
    expect(r.reasons.some((x) => x.startsWith('缺資料：歷史績效'))).toBe(true);
  });
  it('完全沒有客群資料：需求／品類／價格皆未知，只剩歷史與供應', () => {
    const r = scoreFit(input({ segments: [], history: GOOD_HISTORY, supply: GOOD_SUPPLY }));
    expect(dim(r, 'need').known).toBe(false);
    expect(dim(r, 'category').known).toBe(false);
    expect(r.completeness).toBe(0.35);
    expect(r.confidence).toBe('INSUFFICIENT');
    expect(r.recommendation).toBe('INSUFFICIENT_DATA');
  });
  it('所有維度都未知：沒有總分（null），建議＝資料不足', () => {
    const r = scoreFit(input({ segments: [], product: product({ skuPrices: [] }) }));
    expect(r.totalScore).toBeNull();
    expect(r.completeness).toBe(0);
    expect(r.recommendation).toBe('INSUFFICIENT_DATA');
  });
});

describe('完整度與信心', () => {
  it('完整度 0.85 且估計占比 ≤ 50% → HIGH；需求一律是估計，所以估計占比高就不是 HIGH', () => {
    // 價格帶未提供 → 完整度 0.85；需求(30, 估計) + 品類(20, 估計) 占已知 50/85 > 0.5 → MEDIUM
    const r = scoreFit(input({ history: GOOD_HISTORY, supply: GOOD_SUPPLY }));
    expect(r.completeness).toBe(0.85);
    expect(dim(r, 'need').basis).toBe('ESTIMATE');
    expect(r.estimateShare).toBeCloseTo(50 / 85, 3);
    expect(r.confidence).toBe('MEDIUM');
    // 客群與偏好全標事實，並補上價格帶 → 品類／價格為事實；需求仍為估計(30/100)
    const fact = seg({ basis: 'FACT', linkBasis: 'FACT', priceMin: 300, priceMax: 700, prefs: seg().prefs.map((p) => ({ ...p, basis: 'FACT' as const })) });
    const r2 = scoreFit(input({ segments: [fact], history: GOOD_HISTORY, supply: GOOD_SUPPLY }));
    expect(r2.completeness).toBe(1);
    expect(r2.estimateShare).toBeCloseTo(0.3, 3);
    expect(r2.confidence).toBe('HIGH');
  });
  it('完整度剛好等於最低門檻 → LOW；低於 → INSUFFICIENT', () => {
    expect(scoreFit(input()).confidence).toBe('LOW');                      // 0.5
    expect(scoreFit(input({ segments: [seg({ prefs: seg().prefs.filter((p) => p.kind !== 'CATEGORY') })] })).confidence).toBe('INSUFFICIENT');   // 只剩需求 0.3
  });
});

describe('硬性檢查：合規與品質不被總分抵銷', () => {
  const strong = { history: GOOD_HISTORY, supply: GOOD_SUPPLY };
  it('商品審核被退回 → BLOCKED，即使其他維度全是高分', () => {
    const r = scoreFit(input({ ...strong, product: product({ reviewStatus: 'REJECTED' }) }));
    expect(r.totalScore).toBeGreaterThanOrEqual(80);
    expect(r.hardChecks.find((c) => c.key === 'QUALITY')!.result).toBe('FAIL');
    expect(r.recommendation).toBe('BLOCKED');
    expect(r.reasons.some((x) => x.includes('硬性條件未過'))).toBe(true);
  });
  it('廠商黑名單或暫停 → 合規 FAIL → BLOCKED', () => {
    for (const vendorStatus of ['BLACKLISTED', 'PAUSED']) {
      const r = scoreFit(input({ ...strong, product: product({ vendorStatus }) }));
      expect(r.hardChecks.find((c) => c.key === 'COMPLIANCE')!.result).toBe('FAIL');
      expect(r.recommendation).toBe('BLOCKED');
    }
  });
  it('硬性檢查 UNKNOWN（沒有合規備註／尚未審核）：高分也只能是「需人工評估」', () => {
    const noNote = scoreFit(input({ ...strong, product: product({ complianceNote: null }) }));
    expect(noNote.totalScore).toBeGreaterThanOrEqual(80);
    expect(noNote.hardChecks.find((c) => c.key === 'COMPLIANCE')!.result).toBe('UNKNOWN');
    expect(noNote.recommendation).toBe('REVIEW');
    const draft = scoreFit(input({ ...strong, product: product({ reviewStatus: 'PENDING_REVIEW' }) }));
    expect(draft.hardChecks.find((c) => c.key === 'QUALITY')!.result).toBe('UNKNOWN');
    expect(draft.recommendation).toBe('REVIEW');
  });
  it('硬性檢查全過、分數高、信心不是低 → RECOMMEND', () => {
    const r = scoreFit(input({ ...strong, segments: [seg({ priceMin: 300, priceMax: 700 })] }));
    expect(r.hardChecks.every((c) => c.result === 'PASS')).toBe(true);
    expect(r.recommendation).toBe('RECOMMEND');
  });
  it('分數達建議門檻但信心為 LOW → 降為 REVIEW', () => {
    const r = scoreFit(input());   // 完整度 0.5 → LOW，總分 100
    expect(r.totalScore).toBe(100);
    expect(r.confidence).toBe('LOW');
    expect(r.recommendation).toBe('REVIEW');
  });
  it('hardChecks() 單獨可用', () => {
    expect(hardChecks(product()).map((c) => c.result)).toEqual(['PASS', 'PASS']);
  });
});

describe('品類', () => {
  const cat = (p: Partial<FitProduct>, prefs = seg().prefs) => dim(scoreFit(input({ product: product(p), segments: [seg({ prefs })] })), 'category');
  it('類別直接相符＝5；僅以別名或商品名稱命中＝4；有偏好但沒對應＝1', () => {
    expect(cat({}).score).toBe(5);
    expect(cat({ category: '日用品', name: '強效除菌清潔液' }).score).toBe(4);
    expect(cat({ category: '3C 配件', name: '藍牙耳機' }).score).toBe(1);
  });
  it('商品沒有類別且名稱未命中 → 未知（不是 1 分）；客群沒填偏好品類 → 未知', () => {
    expect(cat({ category: null, name: '神祕商品' }).known).toBe(false);
    expect(cat({}, seg().prefs.filter((p) => p.kind !== 'CATEGORY')).known).toBe(false);
  });
  it('正規化：全形半形、大小寫不影響比對', () => {
    expect(normText(' ３Ｃ ')).toBe('3c');
    expect(aliasesOf('CATEGORY', '3C')).toContain('耳機');
    expect(cat({ category: '3c', name: 'x' }, [{ kind: 'CATEGORY', value: '３Ｃ', basis: 'FACT' }]).score).toBe(5);
  });
});

describe('需求', () => {
  it('動機與阻力涵蓋率換算成 1–5 分', () => {
    // 賣點：省時、SGS 檢驗(→品質安心 & 陌生品牌/怕踩雷)、七天退換(→怕踩雷)：4/4 命中
    expect(dim(scoreFit(input()), 'need').score).toBe(5);
    const half = dim(scoreFit(input({ product: product({ sellingPoints: '快速方便', complianceNote: 'x' }) })), 'need');   // 只命中「省時間」1/4
    expect(half.score).toBe(3);
    const none = dim(scoreFit(input({ product: product({ sellingPoints: '顏色漂亮', complianceNote: 'x', name: '商品' }) })), 'need');
    expect(none.score).toBe(1);
  });
  it('商品賣點與說明都空 → 未知；客群沒有動機也沒有阻力 → 未知', () => {
    expect(dim(scoreFit(input({ product: product({ sellingPoints: null, description: null, complianceNote: null }) })), 'need').known).toBe(false);
    expect(dim(scoreFit(input({ segments: [seg({ prefs: seg().prefs.filter((p) => p.kind === 'CATEGORY') })] })), 'need').known).toBe(false);
  });
  it('需求永遠標為估計（關鍵字比對）；理由列出未回應的項目', () => {
    const d = dim(scoreFit(input({ segments: [seg({ basis: 'FACT', linkBasis: 'FACT', prefs: seg().prefs.map((p) => ({ ...p, basis: 'FACT' as const })) })], product: product({ sellingPoints: '快速', complianceNote: 'x' }) })), 'need');
    expect(d.basis).toBe('ESTIMATE');
    expect(d.reason).toContain('未回應動機：品質安心');
    expect(d.reason).toContain('未化解阻力');
  });
});

describe('價格', () => {
  const price = (lo: number | null, hi: number | null, prices = [400, 600]) =>
    dim(scoreFit(input({ segments: [seg({ priceMin: lo, priceMax: hi })], product: product({ skuPrices: prices }) })), 'price');
  it('價格帶內＝5；超出 20% 內＝3；更遠＝1；開放區間', () => {
    expect(price(300, 700).score).toBe(5);        // 均價 500
    expect(price(300, 450).score).toBe(3);        // 上限 450×1.2=540 ≥ 500
    expect(price(100, 300).score).toBe(1);
    expect(price(400, null).score).toBe(5);
    expect(price(null, 300).score).toBe(1);
  });
  it('沒有價格帶或商品沒有團購價 → 未知', () => {
    expect(price(null, null).known).toBe(false);
    expect(price(300, 700, []).known).toBe(false);
  });
});

describe('多客群', () => {
  const a = seg({ id: 'SEG-A', name: 'A', sharePercent: 75, prefs: [{ kind: 'CATEGORY', value: '家庭清潔', basis: 'FACT' }], basis: 'FACT', linkBasis: 'FACT' });
  const b = seg({ id: 'SEG-B', name: 'B', sharePercent: 25, prefs: [{ kind: 'CATEGORY', value: '3C', basis: 'FACT' }], basis: 'FACT', linkBasis: 'FACT' });
  it('依占比加權平均：5×0.75 + 1×0.25 = 4', () => {
    expect(dim(scoreFit(input({ segments: [a, b] })), 'category').score).toBe(4);
  });
  it('有客群沒填占比 → 平均', () => {
    expect(dim(scoreFit(input({ segments: [{ ...a, sharePercent: null }, b] })), 'category').score).toBe(3);
  });
  it('未知的客群不拉低分數', () => {
    const empty = seg({ id: 'SEG-C', name: 'C', sharePercent: 50, prefs: [] });
    expect(dim(scoreFit(input({ segments: [a, empty] })), 'category').score).toBe(5);
  });
  it('依據：任一已知客群為估計，維度就是估計；全是事實才是事實', () => {
    expect(dim(scoreFit(input({ segments: [a, b] })), 'category').basis).toBe('FACT');
    expect(dim(scoreFit(input({ segments: [a, { ...b, linkBasis: 'ESTIMATE' }] })), 'category').basis).toBe('ESTIMATE');
  });
});

describe('歷史績效與供應履約', () => {
  it('切點：相對比 1.2/0.9/0.6/0.3；例外率 2/5/10/20%；案件率 1/3/6/10', () => {
    expect([bucketRatio(1.2), bucketRatio(1.19), bucketRatio(0.9), bucketRatio(0.6), bucketRatio(0.3), bucketRatio(0.29)]).toEqual([5, 4, 4, 3, 2, 1]);
    expect([bucketExceptionRate(0.02), bucketExceptionRate(0.05), bucketExceptionRate(0.1), bucketExceptionRate(0.2), bucketExceptionRate(0.21)]).toEqual([5, 4, 3, 2, 1]);
    expect([bucketCaseRate(1), bucketCaseRate(3), bucketCaseRate(6), bucketCaseRate(10), bucketCaseRate(11)]).toEqual([5, 4, 3, 2, 1]);
  });
  it('同類別歷史＝事實；跨品類退而求其次＝估計；檔期不足＝未知', () => {
    const same = dim(scoreFit(input({ history: GOOD_HISTORY })), 'history');
    expect(same.score).toBe(5);
    expect(same.basis).toBe('FACT');
    const all = dim(scoreFit(input({ history: { ...GOOD_HISTORY, scope: 'ALL' } })), 'history');
    expect(all.basis).toBe('ESTIMATE');
    expect(all.reason).toContain('跨品類');
    expect(dim(scoreFit(input({ history: NO_HISTORY })), 'history').known).toBe(false);
  });
  it('退款率比全體高 10 個百分點以上扣 1 分（最低 1）；基準不足 → 未知', () => {
    expect(dim(scoreFit(input({ history: { ...GOOD_HISTORY, hostRefundRate: 0.2 } })), 'history').score).toBe(4);
    expect(dim(scoreFit(input({ history: { ...GOOD_HISTORY, hostAvgNet: 10_000, hostRefundRate: 0.5 } })), 'history').score).toBe(1);
    expect(dim(scoreFit(input({ history: { ...GOOD_HISTORY, benchRows: 2 } })), 'history').known).toBe(false);
    expect(dim(scoreFit(input({ history: { ...GOOD_HISTORY, benchAvgNet: 0 } })), 'history').known).toBe(false);
  });
  it('供應履約：取例外率與案件率較低者；出貨單太少 → 未知', () => {
    expect(dim(scoreFit(input({ supply: { shipments: 100, exceptions: 1, orders: 500, cases: 2 } })), 'supply').score).toBe(5);
    expect(dim(scoreFit(input({ supply: { shipments: 100, exceptions: 1, orders: 100, cases: 8 } })), 'supply').score).toBe(2);   // 案件率 8 → 2
    expect(dim(scoreFit(input({ supply: { shipments: 100, exceptions: 30, orders: 500, cases: 0 } })), 'supply').score).toBe(1);   // 例外率 30% → 1
    const s = dim(scoreFit(input({ supply: { shipments: 2, exceptions: 0, orders: 10, cases: 0 } })), 'supply');
    expect(s.known).toBe(false);
    expect(s.reason).toContain('至少 3 筆');
  });
});

describe('權重可設定', () => {
  const cfg = (w: Partial<FitConfig['weights']>): FitConfig => ({ ...DEFAULT_FIT_CONFIG, weights: { ...DEFAULT_FIT_CONFIG.weights, ...w } });
  it('改權重會改變總分；合計不是 100 或有負數會被擋', () => {
    // 需求 5 分、價格 3 分（略超出）
    const i = input({ segments: [seg({ priceMin: 100, priceMax: 450 })] });
    const base = scoreFit(i, DEFAULT_FIT_CONFIG);
    const heavyPrice = scoreFit(i, cfg({ need: 10, price: 35 }));
    expect(base.totalScore).not.toBe(heavyPrice.totalScore);
    expect(heavyPrice.totalScore!).toBeLessThan(base.totalScore!);
    expect(configProblems(cfg({ need: 10 }))).toEqual(expect.arrayContaining([expect.stringContaining('合計必須是 100')]));
    expect(configProblems(cfg({ need: -5, price: 50 })).join()).toContain('需求');
    expect(configProblems(DEFAULT_FIT_CONFIG)).toEqual([]);
    expect(configProblems({ ...DEFAULT_FIT_CONFIG, thresholds: { ...DEFAULT_FIT_CONFIG.thresholds, review: 90, recommend: 80 } }).join()).toContain('門檻');
  });
  it('權重為 0 的維度不計入完整度與總分', () => {
    const r = scoreFit(input(), cfg({ need: 50, category: 50, price: 0, history: 0, supply: 0 }));
    expect(r.completeness).toBe(1);
    expect(r.totalScore).toBe(100);
  });
});

describe('輸入雜湊', () => {
  it('客群、偏好順序不影響雜湊；輸入或設定改變就不同', () => {
    const a = input({ segments: [seg({ id: 'S1' }), seg({ id: 'S2', name: 'x' })] });
    const b = input({ segments: [seg({ id: 'S2', name: 'x', prefs: [...seg().prefs].reverse() }), seg({ id: 'S1' })] });
    expect(inputHash(a, DEFAULT_FIT_CONFIG)).toBe(inputHash(b, DEFAULT_FIT_CONFIG));
    expect(inputHash(a, DEFAULT_FIT_CONFIG)).not.toBe(inputHash(input({ segments: a.segments, product: product({ sellingPoints: '別的賣點' }) }), DEFAULT_FIT_CONFIG));
    expect(inputHash(a, DEFAULT_FIT_CONFIG)).not.toBe(inputHash(a, { ...DEFAULT_FIT_CONFIG, weights: { ...DEFAULT_FIT_CONFIG.weights, need: 25, price: 20 } }));
  });
});

describe('Owner 範例輪廓（團媽，育兒家庭 30–44 歲，每月，LINE）', () => {
  it('價格帶未提供 → 價格＝未知；品類與需求命中；完整度 85%（有歷史與供應時）', () => {
    const r = scoreFit(input({ history: GOOD_HISTORY, supply: GOOD_SUPPLY }));
    expect(dim(r, 'price').known).toBe(false);
    expect(dim(r, 'category').score).toBe(5);
    expect(dim(r, 'need').score).toBe(5);
    expect(r.completeness).toBe(0.85);
    expect(r.confidence).toBe('MEDIUM');       // 需求與品類都是估計，所以不會是高信心
    expect(r.totalScore).toBe(100);
    expect(r.recommendation).toBe('RECOMMEND'); // 硬性檢查全過、信心不低；仍須人工覆核才算數
  });
});
