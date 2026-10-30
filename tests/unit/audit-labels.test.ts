import { describe, expect, it } from 'vitest';
import { auditCodeLabel, auditRoleLabel, auditSourceLabel, glossAuditJson } from '@/ui/audit-labels';

describe('稽核紀錄中文對照：英文代碼保留，旁邊補中文', () => {
  it('動作與對象：保留原代碼並補中文', () => {
    expect(auditCodeLabel('campaign.reschedule')).toBe('campaign.reschedule（檔期・改期）');
    expect(auditCodeLabel('selection.dd.item.update')).toBe('selection.dd.item.update（選品・合作資格審查・項目・更新）');
    expect(auditCodeLabel('task')).toBe('task（任務）');
    expect(auditCodeLabel('vendor_dd_record')).toBe('vendor_dd_record（合作資格審查）');
  });
  it('沒收錄的代碼原樣顯示，不亂猜；空值顯示「—」', () => {
    expect(auditCodeLabel('totally.unknown_code')).toBe('totally.unknown_code');
    expect(auditCodeLabel(null)).toBe('—');
  });
  it('角色與來源也是「代碼（中文）」', () => {
    expect(auditRoleLabel('OPS_MANAGER')).toMatch(/^OPS_MANAGER（.+）$/);
    expect(auditSourceLabel('WORKER')).toBe('WORKER（背景工作）');
    expect(auditRoleLabel(null)).toBe('');
  });
  it('前後值：欄位名與原值都保留，只在旁邊補中文；狀態值也補中文', () => {
    const out = glossAuditJson({ status: 'RUNNING', title: 'A', nested: { amount: 5, unknownKey: 1 }, list: [{ note: 'x' }] });
    expect(out).toContain('"status"（狀態）:"RUNNING"（進行中）');
    expect(out).toContain('"title"（標題）:"A"');
    expect(out).toContain('"amount"（金額）:5');
    expect(out).toContain('"unknownKey":1');
    expect(out).toContain('"note"（備註）:"x"');
    // 拿掉中文註解後，要能還原成原本的 JSON 內容（不改資料）
    const stripped = out.replace(/（[^）]*）/g, '');
    expect(JSON.parse(stripped)).toEqual({ status: 'RUNNING', title: 'A', nested: { amount: 5, unknownKey: 1 }, list: [{ note: 'x' }] });
  });
  it('null 或空值回傳空字串', () => {
    expect(glossAuditJson(null)).toBe('');
    expect(glossAuditJson(undefined)).toBe('');
  });
});
