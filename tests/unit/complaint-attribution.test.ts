import { describe, expect, it } from 'vitest';
import { hostLevelCount, resolveCaseAttribution, summarizeComplaints } from '@/server/lib/complaint-attribution';

const c = (caseId: string, o: { manual?: string | null; order?: string | null; hosts?: string[]; shares?: Record<string, number> } = {}) =>
  resolveCaseAttribution({ caseId, manualHostId: o.manual ?? null, orderId: o.order ?? null, orderHostIds: o.hosts ?? [], orderShares: o.shares });

describe('K-5 客訴團主歸屬規則（純函式）', () => {
  it('優先由訂單歸因：單一團主＝單一歸屬；兩位以上＝共同歸因（不分配、不拆分件數）', () => {
    expect(c('1', { order: 'O1', hosts: ['A'] })).toMatchObject({ kind: 'ORDER_SINGLE', hostIds: ['A'] });
    expect(c('2', { order: 'O1', hosts: ['B', 'A'] })).toMatchObject({ kind: 'ORDER_SHARED', hostIds: ['A', 'B'] });
    expect(c('3', { order: 'O1', hosts: ['A', 'A'] })).toMatchObject({ kind: 'ORDER_SINGLE', hostIds: ['A'] });   // 同一團主重複歸因列只算一位
  });
  it('訂單歸因優先於人工指定：即使資料裡有人工指定，只要訂單有歸因就以訂單歸因為準', () => {
    expect(c('4', { manual: 'Z', order: 'O1', hosts: ['A'] })).toMatchObject({ kind: 'ORDER_SINGLE', hostIds: ['A'] });
    expect(c('5', { manual: 'Z', order: 'O1', hosts: ['A', 'B'] }).kind).toBe('ORDER_SHARED');
  });
  it('沒有訂單、或訂單沒有歸因：沒有人工指定＝未歸屬（不任意分配）；有人工指定＝人工指定', () => {
    expect(c('6')).toMatchObject({ kind: 'UNATTRIBUTED', hostIds: [] });
    expect(c('7', { order: 'O1', hosts: [] })).toMatchObject({ kind: 'UNATTRIBUTED', hostIds: [] });
    expect(c('8', { manual: 'A' })).toMatchObject({ kind: 'MANUAL', hostIds: ['A'] });
    expect(c('9', { manual: 'A', order: 'O1', hosts: [] })).toMatchObject({ kind: 'MANUAL', hostIds: ['A'] });
  });
  it('統計：公司整體每件只算一次；共同歸因在每位相關團主各出現一次、整體另列；未歸屬不計入任何團主', () => {
    const s = summarizeComplaints([c('1', { order: 'O1', hosts: ['A'] }), c('2', { order: 'O2', hosts: ['A', 'B'] }), c('3', { manual: 'B' }), c('4'), c('5')]);
    expect(s).toMatchObject({ total: 5, unattributed: 2, sharedCases: 1 });
    expect(s.byHost.A).toMatchObject({ exclusive: 1, shared: 1, manual: 0, relatedCases: 2 });
    expect(s.byHost.B).toMatchObject({ exclusive: 1, shared: 1, manual: 1, relatedCases: 2 });
    expect(hostLevelCount(s, 'A')).toBe(2); expect(hostLevelCount(s, 'B')).toBe(2); expect(hostLevelCount(s, 'C')).toBe(0);
  });
  it('沒有任何案件：全為 0', () => {
    expect(summarizeComplaints([])).toEqual({ total: 0, unattributed: 0, sharedCases: 0, byHost: {} });
  });
});

describe('K-5a 加權客訴數：按有效歸因比例分攤，公司整體一致', () => {
  it('共同歸因依訂單歸因比例分攤，每件合計 1；單一歸屬與人工指定＝1；未歸屬不分配', () => {
    expect(c('1', { order: 'O', hosts: ['A', 'B'], shares: { A: 60, B: 40 } }).weights).toEqual({ A: 0.6, B: 0.4 });
    expect(c('2', { order: 'O', hosts: ['A', 'B', 'C'] }).weights.A).toBeCloseTo(1 / 3, 9);               // 沒有比例時平均
    expect(c('3', { order: 'O', hosts: ['A'], shares: { A: 60 } }).weights).toEqual({ A: 1 });              // 單一團主（另 40% 沒歸因）不放大也不拆給別人
    expect(c('4', { manual: 'A' }).weights).toEqual({ A: 1 });
    expect(c('5').weights).toEqual({});
    const w = c('6', { order: 'O', hosts: ['A', 'B', 'C'], shares: { A: 50, B: 30, C: 20 } }).weights;
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });
  it('一致性：各團主加權客訴數合計 ＋ 未歸屬 ＝ 公司整體件數；絕不把各團主的完整件數加總當成整體', () => {
    const list = [
      c('1', { order: 'O1', hosts: ['A'] }), c('2', { order: 'O2', hosts: ['A', 'B'], shares: { A: 70, B: 30 } }), c('3', { order: 'O3', hosts: ['A', 'B', 'C'], shares: { A: 50, B: 25, C: 25 } }),
      c('4', { manual: 'C' }), c('5'), c('6', { order: 'O9', hosts: [] }),
    ];
    const s = summarizeComplaints(list);
    const sumWeighted = Object.values(s.byHost).reduce((a, h) => a + h.weighted, 0);
    expect(s.total).toBe(6);
    expect(sumWeighted + s.unattributed).toBeCloseTo(s.total, 9);
    expect(s.byHost.A.weighted).toBeCloseTo(1 + 0.7 + 0.5, 9);
    expect(s.byHost.B.weighted).toBeCloseTo(0.3 + 0.25, 9);
    // 完整關聯件數（不可加總）比整體大：A 涉及 3 件、B 涉及 2 件、C 涉及 2 件
    const sumRelated = Object.values(s.byHost).reduce((a, h) => a + h.relatedCases, 0);
    expect(sumRelated).toBeGreaterThan(s.total - s.unattributed);
    expect(s.byHost.A.relatedCases).toBe(3);
  });
});

