import { describe, expect, it } from 'vitest';
import { addDays, diffDays, isIsoDate, monthRange, rangesOverlap } from '@/server/lib/dates';
import { normalizeName } from '@/server/lib/text';
import { parseCsv } from '@/server/lib/csv';
import { hashPassword, validatePasswordStrength, verifyPassword } from '@/server/lib/password';
import { GATE_APPROVER_ROLES, ROLES, ROLE_PERMISSIONS, roleCan, type Permission } from '@/server/lib/permissions';
import { CAMPAIGN_STATUSES, GATE_OUTCOME, GATE_REQUEST, TRANSITIONS, canCancel, findTransition } from '@/server/workflow/state';
import { parseCommissionText } from '@/server/modules/intake';
import { parseOrderedAt } from '@/server/modules/orders';
import { changedFields, redact } from '@/server/lib/audit';
import { rateLimit, resetRateLimits } from '@/server/lib/rate-limit';
import { campaignScope } from '@/server/lib/scope';
import { mkActor } from '../helpers';

describe('日期工具（台北日曆日，無時區位移）', () => {
  it('addDays 跨月／跨年／閏年', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDays('2026-12-25', '2026-12-20')).toBe(5);
  });
  it('isIsoDate 嚴格驗證', () => {
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-1-1')).toBe(false);
    expect(isIsoDate('2026-02-28')).toBe(true);
  });
  it('區間重疊含端點；缺日期不判斷', () => {
    expect(rangesOverlap('2026-01-01', '2026-01-10', '2026-01-10', '2026-01-20')).toBe(true);
    expect(rangesOverlap('2026-01-01', '2026-01-09', '2026-01-10', '2026-01-20')).toBe(false);
    expect(rangesOverlap(null, '2026-01-09', '2026-01-10', '2026-01-20')).toBe(false);
  });
  it('monthRange', () => { expect(monthRange('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' }); });
});

describe('名稱正規化（重複偵測）', () => {
  it('忽略空白、全形、大小寫與標點', () => {
    expect(normalizeName('  某某 品牌（旗艦店） ')).toBe(normalizeName('某某品牌旗艦店'));
    expect(normalizeName('ＡＢＣ Foods')).toBe(normalizeName('abc foods'));
  });
});

describe('CSV 解析', () => {
  it('引號、逗號、換行、跳脫雙引號、BOM、CRLF', () => {
    const rows = parseCsv('﻿a,b,c\r\n1,"x,y","line1\nline2"\r\n"q""q",,3\r\n');
    expect(rows).toEqual([['a', 'b', 'c'], ['1', 'x,y', 'line1\nline2'], ['q"q', '', '3']]);
  });
  it('引號未結束丟錯；空行略過', () => {
    expect(() => parseCsv('a,"b')).toThrow();
    expect(parseCsv('a,b\n\n1,2\n')).toHaveLength(2);
  });
});

describe('密碼', () => {
  it('雜湊可驗證、錯誤密碼不通過、每次鹽不同', () => {
    const h = hashPassword('Abcdefg-12345');
    expect(verifyPassword('Abcdefg-12345', h)).toBe(true);
    expect(verifyPassword('abcdefg-12345', h)).toBe(false);
    expect(hashPassword('Abcdefg-12345')).not.toBe(h);
    expect(verifyPassword('x', 'garbage')).toBe(false);
  });
  it('強度規則', () => {
    expect(validatePasswordStrength('short1')).toMatch(/10/);
    expect(validatePasswordStrength('onlyletterspassword')).toMatch(/數字/);
    expect(validatePasswordStrength('Valid-Password-1')).toBeNull();
  });
});

describe('權限矩陣（不可被默默放寬）', () => {
  const P = (r: (typeof ROLES)[number], p: Permission) => roleCan(r, p);
  it('團主與廠商不具備任何寫入、成本、佣金設定、稽核、使用者管理權限', () => {
    for (const r of ['HOST', 'VENDOR'] as const) {
      for (const p of ['vendor.write', 'host.write', 'community.write', 'product.write', 'product.cost.read', 'campaign.write', 'campaign.transition', 'campaign.sensitive.read',
        'commission.write', 'audit.read', 'user.manage', 'order.import', 'automation.manage', 'approval.request'] as Permission[]) expect(P(r, p), `${r} ${p}`).toBe(false);
    }
  });
  it('廠商沒有佣金與訂單權限；團主只有自己的佣金檢視', () => {
    expect(P('VENDOR', 'commission.read')).toBe(false);
    expect(P('VENDOR', 'order.read')).toBe(false);
    expect(P('HOST', 'order.read')).toBe(false);
    expect(P('HOST', 'commission.read')).toBe(true);
  });
  it('成本欄位只有管理者、營運主管、財務可讀；營運小編不行', () => {
    expect(ROLES.filter((r) => P(r, 'product.cost.read')).sort()).toEqual(['FINANCE', 'OPS_MANAGER', 'SYSTEM_ADMIN']);
  });
  it('佣金規則只有管理者與財務可寫；使用者管理只有管理者', () => {
    expect(ROLES.filter((r) => P(r, 'commission.write')).sort()).toEqual(['FINANCE', 'SYSTEM_ADMIN']);
    expect(ROLES.filter((r) => P(r, 'user.manage'))).toEqual(['SYSTEM_ADMIN']);
  });
  it('每個角色都有定義且關卡核准者皆為有效角色', () => {
    for (const r of ROLES) expect(ROLE_PERMISSIONS[r]).toBeDefined();
    for (const roles of Object.values(GATE_APPROVER_ROLES)) for (const r of roles) expect(ROLES).toContain(r);
    expect(GATE_APPROVER_ROLES.G4).not.toContain('OPS_EDITOR');
  });
});

describe('檔期狀態機', () => {
  it('每個狀態都有定義；終態沒有轉出', () => {
    for (const s of CAMPAIGN_STATUSES) expect(TRANSITIONS[s]).toBeDefined();
    expect(TRANSITIONS.CLOSED).toEqual([]);
    expect(TRANSITIONS.CANCELLED).toEqual([]);
  });
  it('跳步被拒：DRAFT 不能直接到 RUNNING；PENDING_G2 不能手動到 SCHEDULED（必須走核准）', () => {
    expect(findTransition('DRAFT', 'RUNNING')).toBeUndefined();
    expect(findTransition('PENDING_G2', 'SCHEDULED')?.kind).toBe('GATE');
    expect(findTransition('PREPARING', 'PENDING_G2')?.kind).toBe('GATE');
  });
  it('關卡定義一致：每個關卡的申請／核准結果都能對應到合法轉移', () => {
    for (const g of Object.keys(GATE_REQUEST)) {
      const req = GATE_REQUEST[g]; const out = GATE_OUTCOME[g];
      const from = req.to ?? req.from;
      expect(findTransition(from, out.approved)?.gate, `${g} approve`).toBe(g);
      if (out.rejected) expect(findTransition(from, out.rejected)?.gate, `${g} reject`).toBe(g);
      if (req.to) expect(findTransition(req.from, req.to)?.gate).toBe(g);
    }
  });
  it('進入履約之後不可取消', () => {
    expect(canCancel('RUNNING')).toBe(true);
    expect(canCancel('ON_HOLD')).toBe(true);
    for (const s of ['FULFILLING', 'PENDING_SETTLEMENT', 'SETTLED', 'CLOSED', 'CANCELLED'] as const) expect(canCancel(s)).toBe(false);
  });
});

describe('輸入解析', () => {
  it('分潤％：20 / 20% / 0.2 都視為 20%；剛好 1 或無法辨識交人工', () => {
    expect(parseCommissionText('20')).toEqual({ percent: 20, ambiguous: false });
    expect(parseCommissionText('20%')).toEqual({ percent: 20, ambiguous: false });
    expect(parseCommissionText('0.2')).toEqual({ percent: 20, ambiguous: false });
    expect(parseCommissionText('1').ambiguous).toBe(true);
    expect(parseCommissionText('待討論').ambiguous).toBe(true);
    expect(parseCommissionText('150%').ambiguous).toBe(true);
    expect(parseCommissionText(undefined)).toEqual({ percent: null, ambiguous: false });
  });
  it('下單時間：台北時間字串與含時區 ISO；格式錯誤回 null', () => {
    expect(parseOrderedAt('2026-11-03 10:30')?.toISOString()).toBe('2026-11-03T02:30:00.000Z');
    expect(parseOrderedAt('2026-11-03T10:30:00+08:00')?.toISOString()).toBe('2026-11-03T02:30:00.000Z');
    expect(parseOrderedAt('2026/11/03')).toBeNull();
    expect(parseOrderedAt('2026-11-03T10:30:00')).toBeNull(); // 無時區的 T 格式不接受，避免歧義
  });
});

describe('稽核工具', () => {
  it('密碼雜湊一律遮蔽；只記錄有變動的欄位', () => {
    expect(redact({ password_hash: 'x', a: 1 })).toEqual({ password_hash: '[REDACTED]', a: 1 });
    const d = changedFields({ a: 1, b: 2, version: 1 }, { a: 1, b: 3, version: 2 });
    expect(d).toEqual({ before: { b: 2 }, after: { b: 3 } });
    expect(changedFields({ a: 1 }, { a: 1 })).toBeNull();
  });
});

describe('限流', () => {
  it('視窗內超過上限被拒，視窗過後恢復', () => {
    resetRateLimits();
    expect(rateLimit('k', 2, 1000, 0)).toBe(true);
    expect(rateLimit('k', 2, 1000, 10)).toBe(true);
    expect(rateLimit('k', 2, 1000, 20)).toBe(false);
    expect(rateLimit('k', 2, 1000, 1500)).toBe(true);
  });
});

describe('資料範圍 SQL', () => {
  it('沒有團主／廠商綁定的外部帳號看不到任何檔期', () => {
    expect(campaignScope(mkActor('ORG-1', 'U', 'HOST'), 1).sql).toBe('FALSE');
    expect(campaignScope(mkActor('ORG-1', 'U', 'VENDOR'), 1).sql).toBe('FALSE');
  });
  it('內部角色一律帶組織條件', () => {
    for (const r of ['SYSTEM_ADMIN', 'OPS_MANAGER', 'OPS_EDITOR', 'FINANCE'] as const) expect(campaignScope(mkActor('ORG-1', 'U', r), 1).sql).toContain('organization_id');
  });
});

describe('自動化預設冪等鍵的粒度', () => {
  it('進件／事件／通知以分鐘；狀態推進以小時；每日類以台北日期（同粒度內相同、跨粒度不同）', async () => {
    const { defaultKey } = await import('@/server/modules/automation');
    const t1 = new Date('2026-11-02T03:00:10Z'), t2 = new Date('2026-11-02T03:00:50Z'), t3 = new Date('2026-11-02T03:01:05Z'), t4 = new Date('2026-11-02T04:05:00Z');
    expect(defaultKey('vendor_intake', t1)).toBe(defaultKey('vendor_intake', t2));
    expect(defaultKey('vendor_intake', t1)).not.toBe(defaultKey('vendor_intake', t3));   // 新進件不用等到明天
    expect(defaultKey('campaign_status_progress', t1)).toBe(defaultKey('campaign_status_progress', t3));
    expect(defaultKey('campaign_status_progress', t1)).not.toBe(defaultKey('campaign_status_progress', t4));
    expect(defaultKey('daily_summary', t1)).toBe(defaultKey('daily_summary', t4));
    expect(defaultKey('daily_summary', new Date('2026-11-02T15:59:00Z'))).not.toBe(defaultKey('daily_summary', new Date('2026-11-02T16:01:00Z'))); // 台北已跨日
  });
});

describe('CSRF：Origin 比對', () => {
  it('Origin 等於 Host 或 X-Forwarded-Host（反向代理／通道）才放行；其他來源拒絕；無 Origin（腳本）放行', async () => {
    const { sameOrigin } = await import('@/server/api/router');
    const r = (h: Record<string, string>) => new Request('http://x/api', { method: 'POST', headers: h });
    expect(sameOrigin(r({ origin: 'https://a.example', host: 'a.example' }))).toBe(true);
    expect(sameOrigin(r({ origin: 'https://a.example', host: 'localhost:3000', 'x-forwarded-host': 'a.example' }))).toBe(true);
    expect(sameOrigin(r({ origin: 'https://a.example', host: 'a.example', 'x-forwarded-host': 'proxy.internal' }))).toBe(true);
    expect(sameOrigin(r({ origin: 'https://a.example', host: 'localhost:3000', 'x-forwarded-host': 'b.example, a.example' }))).toBe(true);
    expect(sameOrigin(r({ origin: 'https://evil.example', host: 'a.example' }))).toBe(false);
    expect(sameOrigin(r({ origin: 'https://evil.example', host: 'a.example', 'x-forwarded-host': 'b.example' }))).toBe(false);
    expect(sameOrigin(r({ origin: 'not a url', host: 'a.example' }))).toBe(false);
    expect(sameOrigin(r({ host: 'a.example' }))).toBe(true);
  });
});
