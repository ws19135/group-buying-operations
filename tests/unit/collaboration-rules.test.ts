import { describe, expect, it } from 'vitest';
import {
  APPLICATION_PATCH_FIELDS, HOST_LAUNCH_FIELDS, LAUNCH_FIELDS, MASKED, RECIPIENT_DENY_MESSAGE,
  VENDOR_LAUNCH_FIELDS, addDaysIso, allUnavailable, canTransitionApplication, canTransitionCollaboration,
  canTransitionShipment, computeRetentionUntil, importDedupeKey, mapHeaders, parseIntent, parseLooseDate,
  parseYesNo, shipmentBucket, summarizeShipments, supplyStatusFor, toCsv, toForm1Row, toForm2Row,
  vendorMaySeeRecipient, vendorReviewComplete, type ExportRow, type ShipmentFact,
} from '@/server/lib/collaboration-rules';

/**
 * 合作申請的純規則（不碰資料庫）。
 * 這一檔專門鎖住「不能用布林欄位代替證據」「判讀不出來就留待確認」這兩條設計紅線。
 */

const fact = (shipmentType: 'INITIAL' | 'RESEND', status: ShipmentFact['status'], shipDate: string | null = null): ShipmentFact =>
  ({ shipmentType, status, shipDate });

describe('樣品寄送進度：由紀錄推導，不是打勾', () => {
  it('沒有任何紀錄＝還沒要求寄樣，是否已補寄為否', () => {
    const s = summarizeShipments([]);
    expect(s.progress).toBe('NOT_REQUESTED');
    expect(s.resent).toBe(false);
    expect(shipmentBucket(s)).toBe('NONE');
  });

  it('有紀錄但還沒填寄出日＝待寄出', () => {
    const s = summarizeShipments([fact('INITIAL', 'PENDING')]);
    expect(s.progress).toBe('PREPARING');
    expect(shipmentBucket(s)).toBe('TO_SHIP');
  });

  it('只建立補寄紀錄但還沒寄出，「是否已補寄」必須還是否', () => {
    const s = summarizeShipments([fact('INITIAL', 'SHIPPED', '2026-10-01'), fact('RESEND', 'PENDING')]);
    expect(s.resent).toBe(false);          // ← 沒有寄出事實就不算補寄過
    expect(s.resendPending).toBe(true);
    expect(s.progress).toBe('RESEND_PENDING');
    expect(shipmentBucket(s)).toBe('RESEND_PENDING');
  });

  it('補寄真的寄出之後才算已補寄，並取最後一次寄出日', () => {
    const s = summarizeShipments([fact('INITIAL', 'SHIPPED', '2026-10-01'), fact('RESEND', 'SHIPPED', '2026-10-09')]);
    expect(s.resent).toBe(true);
    expect(s.resendCount).toBe(1);
    expect(s.lastShipDate).toBe('2026-10-09');
    expect(s.progress).toBe('RESENT');
  });

  it('取消的寄送紀錄不算數（不會讓已取消的補寄看起來像已補寄）', () => {
    const s = summarizeShipments([fact('INITIAL', 'SHIPPED', '2026-10-01'), fact('RESEND', 'CANCELLED', '2026-10-05')]);
    expect(s.resent).toBe(false);
    expect(s.resendCount).toBe(0);
    expect(s.activeCount).toBe(1);
  });

  it('確認收件之後是已送達', () => {
    const s = summarizeShipments([fact('INITIAL', 'DELIVERED', '2026-10-01')]);
    expect(s.progress).toBe('DELIVERED');
    expect(s.deliveredCount).toBe(1);
    expect(shipmentBucket(s)).toBe('DELIVERED');
  });

  it('退回', () => {
    expect(summarizeShipments([fact('INITIAL', 'RETURNED', '2026-10-01')]).progress).toBe('RETURNED');
  });
});

describe('四個維度各自獨立的狀態轉換', () => {
  it('申請狀態不可跳過審核直接核准', () => {
    expect(canTransitionApplication('DRAFT', 'SUBMITTED')).toBe(true);
    expect(canTransitionApplication('DRAFT', 'APPROVED')).toBe(false);
    expect(canTransitionApplication('REJECTED', 'APPROVED')).toBe(false);
    expect(canTransitionApplication('CANCELLED', 'SUBMITTED')).toBe(false);
  });

  it('合作狀態是另一條線：還沒確認合作不能直接變成已關聯檔期', () => {
    expect(canTransitionCollaboration('AWAITING_INTENT', 'COLLABORATION_CONFIRMED')).toBe(true);
    expect(canTransitionCollaboration('SAMPLE_IN_PROGRESS', 'CAMPAIGN_LINKED')).toBe(false);
    expect(canTransitionCollaboration('DECLINED', 'CAMPAIGN_LINKED')).toBe(false);
  });

  it('物流狀態：已送達之後不能再改回待寄出或取消', () => {
    expect(canTransitionShipment('PENDING', 'SHIPPED')).toBe(true);
    expect(canTransitionShipment('DELIVERED', 'PENDING')).toBe(false);
    expect(canTransitionShipment('DELIVERED', 'CANCELLED')).toBe(false);
  });
});

describe('供應狀態由數量決定，不能自由填', () => {
  it.each([
    [5, null, 'PENDING'],
    [5, 0, 'UNAVAILABLE'],
    [5, 3, 'PARTIAL'],
    [5, 5, 'AVAILABLE'],
  ] as const)('申請 %s 核准 %s → %s', (req, app, expected) => {
    expect(supplyStatusFor(req, app)).toBe(expected);
  });

  it('全部明細審完才算廠商審核完成；全部不供應＝沒東西可寄', () => {
    expect(vendorReviewComplete([{ requestedQty: 1, approvedQty: 1, supplyStatus: 'AVAILABLE' }, { requestedQty: 1, approvedQty: null, supplyStatus: 'PENDING' }])).toBe(false);
    expect(vendorReviewComplete([{ requestedQty: 1, approvedQty: 1, supplyStatus: 'AVAILABLE' }])).toBe(true);
    expect(allUnavailable([{ requestedQty: 1, approvedQty: 0, supplyStatus: 'UNAVAILABLE' }])).toBe(true);
    expect(allUnavailable([])).toBe(false);
  });
});

describe('欄位層級權限白名單', () => {
  it('廠商改不到申請主檔任何欄位；團主只能改備註', () => {
    expect([...APPLICATION_PATCH_FIELDS.VENDOR]).toEqual([]);
    expect([...APPLICATION_PATCH_FIELDS.HOST]).toEqual(['note']);
  });

  it('廠商的開團欄位與團主／營運的完全不重疊（廠商改不到意願與開團日期）', () => {
    const overlap = (VENDOR_LAUNCH_FIELDS as readonly string[]).filter((f) => (LAUNCH_FIELDS as readonly string[]).includes(f));
    expect(overlap).toEqual([]);
    expect((HOST_LAUNCH_FIELDS as readonly string[]).includes('confirmedOpenDate')).toBe(false);
    expect((HOST_LAUNCH_FIELDS as readonly string[]).every((f) => (LAUNCH_FIELDS as readonly string[]).includes(f))).toBe(true);
  });
});

describe('收件個資：廠商只在履約必需期間看得到', () => {
  const base = { applicationStatus: 'APPROVED' as const, confirmedAt: '2026-10-01', purgedAt: null, retentionUntil: '2026-12-30', fulfilmentOpen: true, baseOn: '2026-10-01' };

  it('五個條件都成立才給看', () => {
    expect(vendorMaySeeRecipient(base, '2026-10-05')).toEqual({ allowed: true });
  });

  it.each([
    [{ ...base, applicationStatus: 'VENDOR_REVIEW' as const }, 'NOT_APPROVED'],
    [{ ...base, confirmedAt: null }, 'NOT_CONFIRMED'],
    [{ ...base, purgedAt: '2026-11-01' }, 'PURGED'],
    [{ ...base, fulfilmentOpen: false, retentionUntil: '2026-10-01' }, 'RETENTION_EXPIRED'],
    [{ ...base, fulfilmentOpen: false }, 'FULFILMENT_CLOSED'],
    [{ ...base, fulfilmentOpen: undefined }, 'FULFILMENT_CLOSED'],          // 沒給履約事實＝預設拒絕（fail-closed）
    [{ ...base, baseOn: '2026-01-01' }, 'RETENTION_EXPIRED'],              // 超過硬性上限：即使履約還沒結束也一律拒絕
    [{ ...base, applicationStatus: 'ON_HOLD' as const }, 'NOT_APPROVED'],   // 暫緩中不給
    [{ ...base, applicationStatus: 'CLOSED' as const }, 'NOT_APPROVED'],    // 結案不給
  ])('缺一不可：%#', (input, reason) => {
    const r = vendorMaySeeRecipient(input, '2026-10-05');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe(reason);
    expect(RECIPIENT_DENY_MESSAGE[r.reason!]).toBeTruthy();
  });

  it('保留期（90 天）已過但履約還沒結束（補寄待寄）時，廠商仍拿得到地址，直到硬性上限', () => {
    expect(vendorMaySeeRecipient({ ...base, retentionUntil: '2026-10-01' }, '2026-10-05')).toEqual({ allowed: true });
  });

  it('保留期：預設核准後 90 天；全部送達後縮短為最後寄出日 +30 天', () => {
    const notDelivered = summarizeShipments([fact('INITIAL', 'SHIPPED', '2026-10-01')]);
    expect(computeRetentionUntil('2026-10-01', notDelivered, '2026-10-02')).toBe(addDaysIso('2026-10-01', 90));
    const delivered = summarizeShipments([fact('INITIAL', 'DELIVERED', '2026-10-01')]);
    expect(computeRetentionUntil('2026-10-01', delivered, '2026-10-02')).toBe('2026-10-31');
  });
});

describe('匯入：判讀不出來就回 null，列為待確認而不是猜', () => {
  it('是否類欄位', () => {
    expect(parseYesNo('是')).toBe(true);
    expect(parseYesNo('已補寄')).toBe(true);
    expect(parseYesNo('否')).toBe(false);
    expect(parseYesNo('大概吧')).toBe(null);
    expect(parseYesNo('')).toBe(null);
  });

  it('開團意願', () => {
    expect(parseIntent('願意開團')).toBe('WILLING');
    expect(parseIntent('再考慮')).toBe('UNDECIDED');
    expect(parseIntent('不開')).toBe('UNWILLING');
    expect(parseIntent('？？')).toBe(null);
  });

  it('日期：只接受可明確判讀的格式', () => {
    expect(parseLooseDate('2026/10/5')).toBe('2026-10-05');
    expect(parseLooseDate('2026-10-05')).toBe('2026-10-05');
    expect(parseLooseDate('20261005')).toBe('2026-10-05');
    expect(parseLooseDate('10月初')).toBe(null);
    expect(parseLooseDate('下週')).toBe(null);
  });

  it('標題列對應：允許全半形與空白差異，認不出來的欄位列進 unknown', () => {
    const r = mapHeaders(['團購主', '檔期', '後台設定 Mail', '神秘欄位'], 'FORM1_LAUNCH');
    expect(Object.values(r.map)).toContain('hostName');
    expect(Object.values(r.map)).toContain('backendSetupEmail');
    expect(r.unknown).toEqual(['神秘欄位']);
  });

  it('冪等鍵只看來源列欄位：人工修正主檔對應之後，鍵不可改變', () => {
    const a = importDedupeKey('FORM2_SAMPLE', { vendor: 'VND-1', host: '小花 ', product: 'A商品', on: '2026-10-01' });
    const b = importDedupeKey('FORM2_SAMPLE', { vendor: 'VND-1', host: '小花', product: 'A商品', on: '2026-10-01' });
    expect(a).toBe(b);
    const other = importDedupeKey('FORM2_SAMPLE', { vendor: 'VND-1', host: '小明', product: 'A商品', on: '2026-10-01' });
    expect(other).not.toBe(a);
  });
});

describe('匯出：沒有權限的人拿不到收件個資', () => {
  const row: ExportRow = {
    id: 'CLB-000001', hostName: '小花', campaignLabel: '十月團', resent: true, resendDate: '2026-10-09',
    launchUrl: 'https://example.invalid/open', adsIntent: 'YES', backendSetupEmail: 'shop@example.invalid',
    backendSetupStatus: 'DONE', recipientName: '王小花', recipientPhone: '0912345678', addressLine: '台北市某路 1 號',
    productSummary: 'A商品 ×1', shipDate: '2026-10-01', intent: 'WILLING', openDate: '2026-11-01',
    note: '備註', vendorPortalUrl: 'https://example.invalid/admin',
  };

  it('有權限：表單二帶出真實收件資料', () => {
    const r = toForm2Row(row, true);
    expect(r).toContain('王小花');
    expect(r).toContain('0912345678');
    expect(r).toContain('台北市某路 1 號');
  });

  it('沒有權限：收件人／電話／地址一律遮罩，且不得出現原始值', () => {
    const r = toForm2Row(row, false);
    expect(r.filter((c) => c === MASKED).length).toBe(3);
    const joined = r.join('|');
    for (const leak of ['王小花', '0912345678', '台北市某路 1 號']) expect(joined).not.toContain(leak);
  });

  it('表單一不含任何收件個資欄位', () => {
    const joined = toForm1Row(row).join('|');
    for (const leak of ['王小花', '0912345678', '台北市某路 1 號']) expect(joined).not.toContain(leak);
  });

  it('CSV 逸出：含逗號、引號與換行的欄位要被正確包起來', () => {
    const csv = toCsv([['a', 'b'], ['有,逗號', '有"引號"']]);
    expect(csv.split('\n')[1]).toBe('"有,逗號","有""引號"""');
  });
});
