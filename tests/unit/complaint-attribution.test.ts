import { describe, expect, it } from 'vitest';
import { hostLevelCount, resolveCaseAttribution, summarizeComplaints } from '@/server/lib/complaint-attribution';

const c = (caseId: string, o: { manual?: string | null; order?: string | null; hosts?: string[] } = {}) =>
  resolveCaseAttribution({ caseId, manualHostId: o.manual ?? null, orderId: o.order ?? null, orderHostIds: o.hosts ?? [] });

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
    expect(s.byHost.A).toEqual({ exclusive: 1, shared: 1, manual: 0 });
    expect(s.byHost.B).toEqual({ exclusive: 1, shared: 1, manual: 1 });
    expect(hostLevelCount(s, 'A')).toBe(2); expect(hostLevelCount(s, 'B')).toBe(2); expect(hostLevelCount(s, 'C')).toBe(0);
  });
  it('沒有任何案件：全為 0', () => {
    expect(summarizeComplaints([])).toEqual({ total: 0, unattributed: 0, sharedCases: 0, byHost: {} });
  });
});
