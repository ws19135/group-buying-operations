import { describe, expect, it } from 'vitest';
import {
  FORM2_EXPORT_HEADERS, FORM2_VENDOR_EXPORT_HEADERS, IMPORT_PII_FIELDS, RECIPIENT_HARD_CAP_DAYS_AFTER_APPROVAL, addDaysIso,
  evaluatePurge, fulfilmentOpen, isSafeHttpUrl, looksLikeFormula, neutralizeCsvCell, scrubImportPii, toCsv, toForm2Row,
  type ExportRow, type PurgeFacts, type ShipmentFact,
} from '@/server/lib/collaboration-rules';

/**
 * D-37／D-38／D-40／D-44 的純規則：個資保留決策、履約視窗、CSV 公式注入、URL 安全、匯出欄位。
 * 這一檔專門鎖住「清除不能在履約沒結束時就發生」與「廠商匯出沒有個資欄位」。
 */
const f = (shipmentType: 'INITIAL' | 'RESEND', status: ShipmentFact['status'], shipDate: string | null = null): ShipmentFact => ({ shipmentType, status, shipDate });

describe('履約視窗 fulfilmentOpen：廠商只在還需要寄送時需要地址', () => {
  it('還沒有任何寄送紀錄＝需要', () => expect(fulfilmentOpen([])).toBe(true));
  it('首次寄送建好但還沒寄出＝需要', () => expect(fulfilmentOpen([f('INITIAL', 'PENDING')])).toBe(true));
  it('首次已寄出＝不再需要（不論是否已送達）', () => {
    expect(fulfilmentOpen([f('INITIAL', 'SHIPPED', '2026-10-01')])).toBe(false);
    expect(fulfilmentOpen([f('INITIAL', 'DELIVERED', '2026-10-01')])).toBe(false);
  });
  it('補寄待寄出＝重新需要', () => {
    expect(fulfilmentOpen([f('INITIAL', 'DELIVERED', '2026-10-01'), f('RESEND', 'PENDING')])).toBe(true);
  });
  it('已取消的寄送不算數；只剩已取消的首次寄送＝仍需要', () => {
    expect(fulfilmentOpen([f('INITIAL', 'CANCELLED')])).toBe(true);
  });
});

describe('清除決策 evaluatePurge（D-40 政策衝突與過早清除）', () => {
  const base: PurgeFacts = { retentionUntil: '2026-10-01', baseOn: '2026-07-03', applicationStatus: 'APPROVED', shipments: [f('INITIAL', 'DELIVERED', '2026-07-10')], activeHoldUntil: null };
  const today = '2026-10-05';

  it('履約已完成且過保留期 → 清除', () => {
    expect(evaluatePurge(base, today)).toMatchObject({ action: 'PURGE', hardCap: false });
  });
  it('還沒到保留期 → 不處理', () => {
    expect(evaluatePurge({ ...base, retentionUntil: '2026-12-01' }, today)).toEqual({ action: 'NOT_DUE' });
  });
  it('送達後 30 天已到期，但補寄還沒寄出 → 延後（不可在補寄進行中清除）', () => {
    const r = evaluatePurge({ ...base, shipments: [f('INITIAL', 'DELIVERED', '2026-07-10'), f('RESEND', 'PENDING')] }, today);
    expect(r.action).toBe('SKIP_FULFILMENT');
  });
  it('核准後 90 天已過，但首次樣品還沒寄出 → 延後', () => {
    expect(evaluatePurge({ ...base, shipments: [f('INITIAL', 'PENDING')] }, today).action).toBe('SKIP_FULFILMENT');
    expect(evaluatePurge({ ...base, shipments: [] }, today).action).toBe('SKIP_FULFILMENT');
  });
  it('已寄出但團主尚未確認收件 → 延後', () => {
    expect(evaluatePurge({ ...base, shipments: [f('INITIAL', 'SHIPPED', '2026-07-10')] }, today).action).toBe('SKIP_FULFILMENT');
  });
  it('樣品退回、尚未決定補寄 → 延後', () => {
    expect(evaluatePurge({ ...base, shipments: [f('INITIAL', 'RETURNED', '2026-07-10')] }, today).action).toBe('SKIP_FULFILMENT');
  });
  it('申請暫緩中 → 延後', () => {
    expect(evaluatePurge({ ...base, applicationStatus: 'ON_HOLD' }, today).action).toBe('SKIP_FULFILMENT');
  });
  it('有效的保留例外 → 不清除；例外到期後恢復清除（不會無限期保留）', () => {
    expect(evaluatePurge({ ...base, activeHoldUntil: '2026-10-05' }, today).action).toBe('SKIP_HOLD');
    expect(evaluatePurge({ ...base, activeHoldUntil: '2026-10-04' }, today).action).toBe('PURGE');
  });
  it('硬性上限：核准後超過 180 天，即使履約未結束也強制清除；保留例外仍優先', () => {
    const old = { ...base, baseOn: '2026-01-01', retentionUntil: '2026-04-01', shipments: [f('RESEND', 'PENDING'), f('INITIAL', 'DELIVERED', '2026-02-01')] };
    expect(evaluatePurge(old, today)).toMatchObject({ action: 'PURGE', hardCap: true });
    expect(evaluatePurge({ ...old, activeHoldUntil: '2026-12-31' }, today).action).toBe('SKIP_HOLD');
  });
  it('硬性上限天數固定為 180（改動需 Owner 決策）', () => {
    expect(RECIPIENT_HARD_CAP_DAYS_AFTER_APPROVAL).toBe(180);
    expect(addDaysIso('2026-01-01', 180)).toBe('2026-06-30');
  });
});

describe('CSV 公式注入（匯出端）', () => {
  it.each(['=1+1', '+SUM(A1)', '-2+3', '@SUM(A1)', '\t=1', '\r=1'])('開頭是危險字元 %j 一律補單引號', (v) => {
    expect(neutralizeCsvCell(v).startsWith("'")).toBe(true);
  });
  it('一般文字與中文不被改動', () => {
    for (const v of ['小雅媽咪', 'CLB-000001', '2026-10-01', '']) expect(neutralizeCsvCell(v)).toBe(v);
  });
  it('toCsv 的每個儲存格都經過防護（含標題列與被引號包起來的欄位）', () => {
    const csv = toCsv([['=cmd|calc', '+886912345678'], ['@x,y', 'ok']]);
    expect(csv).toBe("'=cmd|calc,'+886912345678\r\n\"'@x,y\",ok");
  });
});

describe('CSV 公式注入（匯入端偵測）與 URL 安全', () => {
  it.each(['=HYPERLINK("http://evil")', '@SUM(1)', '\t=1', '+cmd|x', '-cmd|x', ' =1+1'])('偵測為公式 %j', (v) => expect(looksLikeFormula(v)).toBe(true));
  it.each(['0912345678', '+886912345678', '+886 912 345 678', '-5', '小雅', '', null, 'a=b'])('不誤判一般內容 %j', (v) => expect(looksLikeFormula(v as string | null)).toBe(false));
  it.each(['https://example.invalid/a', 'http://example.invalid'])('安全網址 %s', (u) => expect(isSafeHttpUrl(u)).toBe(true));
  it.each(['javascript:alert(1)', 'data:text/html,<script>', 'ftp://example.invalid', 'https://user:pw@example.invalid/', 'not a url', `https://example.invalid/${'a'.repeat(500)}`])('不安全網址 %s', (u) => expect(isSafeHttpUrl(u)).toBe(false));
});

describe('匯入暫存去個資', () => {
  it('只替換收件人／電話／地址，其他欄位原樣保留', () => {
    const out = scrubImportPii({ hostName: '小雅', recipientName: '王大明', recipientPhone: '0912000111', addressLine: '某市某路 1 號', note: 'n' });
    expect(out).toEqual({ hostName: '小雅', recipientName: '［已清除］', recipientPhone: '［已清除］', addressLine: '［已清除］', note: 'n' });
    expect(JSON.stringify(out)).not.toMatch(/王大明|0912000111|某路/);
    expect([...IMPORT_PII_FIELDS]).toEqual(['recipientName', 'recipientPhone', 'addressLine']);
  });
});

describe('廠商匯出欄位（D-38）：個資欄位不存在，不是遮罩', () => {
  const row: ExportRow = {
    id: 'CLB-1', hostName: '小雅', campaignLabel: null, resent: false, resendDate: null, launchUrl: null, adsIntent: 'PENDING',
    backendSetupEmail: null, backendSetupStatus: 'NOT_REQUIRED', recipientName: 'SENTINEL-NAME', recipientPhone: '0900000000',
    addressLine: 'SENTINEL-ADDR', productSummary: '商品 ×1', shipDate: null, intent: 'PENDING', openDate: null, note: null, vendorPortalUrl: null,
  };
  it('OMIT 模式的標題與內容都沒有收件人、電話、地址', () => {
    for (const c of ['收件人', '聯繫電話', '地址']) expect(FORM2_VENDOR_EXPORT_HEADERS as readonly string[]).not.toContain(c);
    const cells = toForm2Row(row, 'OMIT');
    expect(cells.length).toBe(FORM2_VENDOR_EXPORT_HEADERS.length);
    expect(cells.join('|')).not.toMatch(/SENTINEL|0900000000|［無權限］/);
  });
  it('FULL 與 MASKED 維持原本欄位數；MASKED 不含原始值', () => {
    expect(toForm2Row(row, 'FULL').length).toBe(FORM2_EXPORT_HEADERS.length);
    expect(toForm2Row(row, 'MASKED').join('|')).not.toMatch(/SENTINEL|0900000000/);
    expect(toForm2Row(row, true).join('|')).toContain('SENTINEL-NAME');
  });
});
