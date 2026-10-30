import { CAMPAIGN_STATUS, TASK_STATUS, VENDOR_STATUS, HOST_STATUS, REVIEW_STATUS, APPROVAL_STATUS, HOST_PART, PLACEMENT_STATUS, roleLabel } from '@/ui/labels';

/**
 * 稽核紀錄的中文對照：保留原本的英文代碼，在旁邊括號補上中文（例如「campaign.reschedule（檔期・改期）」）。
 * 對照表沒收錄的代碼就原樣顯示，不會漏出資料；代碼本身絕不改動（稽核紀錄是證據）。
 */
const SEG: Record<string, string> = {
  // 對象
  approval: '核准', automation: '自動化', automation_job: '自動化工作', campaign: '檔期', campaign_host: '檔期團主', campaign_product: '檔期商品', commission_rule: '分潤規則',
  community: '社群', evidence: '證據', exception: '異常', expense: '費用', feasibility: '可行性試算', feasibility_scenario: '可行性情境', fit: '客群適配', fit_assessment: '適配評估',
  fit_config: '適配設定', fulfillment_batch: '履約批次', host: '團主', host_availability: '團主檔期可用性', host_community: '團主與社群', import: '訂單匯入', import_batch: '匯入批次',
  import_error: '匯入錯誤', intake: '廠商進件', inventory: '庫存', inventory_movement: '庫存異動', invoice: '發票', order: '訂單', organization: '組織', partner_segment_link: '合作對象與客群',
  payment: '入帳', placement: '社群曝光', product: '商品', product_asset: '商品素材', product_evaluation: '選品評估', product_trial: '資格試用', refund: '退款', refund_request: '退款申請',
  segment: '客群', segment_link: '客群連結', selection: '選品', selection_config: '選品設定', service_case: '客服案件', settlement: '結算', settlement_adjustment: '結算調整',
  settlement_item: '結算明細', shipment: '出貨單', sku: '規格（SKU）', task: '任務', trial: '試用', trial_check: '試用檢查項', user: '使用者', vendor: '廠商', vendor_contact: '廠商聯絡人',
  vendor_dd_item: '合作資格審查項目', vendor_dd_record: '合作資格審查', workflow_template: '流程模板', dd: '合作資格審查', evaluation: '選品評估', item: '項目', config: '設定',
  // 動作
  add: '新增', remove: '移除', create: '建立', update: '更新', archive: '封存', cancel: '取消', respond: '回覆', reschedule: '改期', request: '申請', approve: '核准', reject: '退回',
  review: '覆核', submit: '送出', conclude: '下結論', check: '檢查', actuals: '實績', status: '狀態變更', note: '備註', reopen: '重新開啟', link: '建立連結', unlink: '解除連結',
  end: '結束', refund_writeback: '退款回寫', update_from_import: '匯入更新', complete: '完成', resolve: '處理', process: '處理', receive: '收件', needs_review: '需人工確認',
  adjust: '調整', correct: '更正', issue: '開立', void: '作廢', match: '配對', unmatch: '取消配對', receipt: '簽收', recalculate: '重新試算', confirm: '確認', adjustment: '調整',
  generate: '產生', set_status: '設定狀態', publish: '發佈新版', run_manual: '手動執行', run: '執行', enable: '啟用', disable: '停用', outcome: '成效回報', assess: '評估',
  preferences: '偏好', evidence_add: '新增證據', acknowledged: '已認領', resolved: '已結案', open: '未處理', transition: '狀態轉換', hold: '暫停', resume: '恢復', BLOCK: '封鎖',
  CLEAR: '解除', RELEASE: '放行', REQUIRE: '要求',
};
const seg = (s: string) => SEG[s] ?? s;

/** `campaign.reschedule` → 「campaign.reschedule（檔期・改期）」；`task` → 「task（任務）」 */
export function auditCodeLabel(code: string | null | undefined): string {
  if (!code) return '—';
  const whole = SEG[code];
  if (whole) return `${code}（${whole}）`;
  const parts = code.split('.');
  if (!parts.some((p) => SEG[p])) return code;
  return `${code}（${parts.map(seg).join('・')}）`;
}

/** 操作來源：WEB＝網頁操作、API＝介面呼叫、WORKER＝背景工作、SEED＝示範資料種子 */
const SOURCE: Record<string, string> = { WEB: '網頁操作', API: '介面呼叫', WORKER: '背景工作', SEED: '示範資料種子', SYSTEM: '系統' };
export const auditSourceLabel = (s: string | null | undefined) => (s ? `${s}（${SOURCE[s] ?? s}）` : '');
export const auditRoleLabel = (r: string | null | undefined) => (r ? `${r}（${roleLabel(r)}）` : '');

// 前後值裡常見的欄位名稱。只加註解，不改資料。
const KEY: Record<string, string> = {
  status: '狀態', title: '標題', name: '名稱', note: '備註', reason: '原因', kind: '類型', category: '分類', result: '結果', terms: '條款', label: '標籤', text: '內容', role: '角色',
  amount: '金額', quantity: '數量', delta: '增減', level: '等級', priority: '優先度', version: '版本', platform: '平台', carrier: '物流商', direction: '方向', basis: '依據', cycle: '週期',
  enabled: '啟用', public: '公開', created: '新建', items: '項目', tasks: '任務', scores: '分數', counts: '筆數', errors: '錯誤數', duplicates: '重複數', inserted: '新增筆數', updated: '更新筆數',
  riskNote: '風險說明', itemKey: '項目代碼', defectSeverity: '缺失嚴重度', evidenceText: '證據說明', responsibleParty: '負責方', legalStatus: '法務狀態', naReason: '不適用原因',
  defectNote: '缺失說明', ownerUserId: '負責人', productId: '商品', hostId: '團主', skuId: '規格（SKU）', vendorId: '廠商', skuCode: 'SKU 代碼', campaignId: '檔期', batchId: '批次',
  orderId: '訂單', totalScore: '總分', recommendation: '建議', targetRevenue: '目標營收', validUntil: '有效期限', completeness: '資料完整度', confidence: '信心', subjectType: '對象類型',
  subjectId: '對象', configVersion: '設定版本', templateVersion: '模板版本', versionNo: '版本號', plannedDate: '預計日期', openDate: '開團日', closeDate: '結團日', balanceAfter: '異動後庫存',
  reviewDecision: '覆核決定', reasonCode: '原因代碼', trackingNo: '物流單號', compliance: '安全與合規', caseType: '案件類型', assigneeUserId: '承辦人', reviewNote: '覆核備註',
  displayName: '顯示名稱', communityId: '社群', plannedShipDate: '預計出貨日', scheduledOn: '排定日', placementType: '曝光類型', sharePercent: '歸屬比例（%）', incurredOn: '發生日',
  ageBand: '年齡帶', familyType: '家庭型態', preferences: '偏好', segmentId: '客群', caseId: '案件', counterpartyType: '對象類型', contractVersion: '合約版本', paidOn: '入帳日',
  trialType: '試用類型', conclusion: '結論', dataAsOf: '資料截至', dataStatus: '資料狀態', invoiceNo: '發票號碼', ratePercent: '費率（%）', effectiveFrom: '生效日', scopeType: '範圍類型',
  settlementId: '結算', vendorName: '廠商名稱', itemName: '品項名稱', matchStatus: '配對狀態', refund_amount: '退款金額', needsReview: '需人工確認', changedKeys: '變更欄位',
};
const STATUS_VALUE: Record<string, string> = {};
for (const map of [CAMPAIGN_STATUS, TASK_STATUS, VENDOR_STATUS, HOST_STATUS, REVIEW_STATUS, APPROVAL_STATUS, HOST_PART, PLACEMENT_STATUS]) {
  for (const [k, v] of Object.entries(map)) STATUS_VALUE[k] ??= v.label;
}
/** 把前後值（JSON）轉成一行文字：欄位名稱後補中文、狀態值後補中文；英文欄位名與原值都保留。 */
export function glossAuditJson(v: unknown): string {
  if (v == null) return '';
  const walk = (x: unknown): string => {
    if (Array.isArray(x)) return `[${x.map(walk).join(',')}]`;
    if (x && typeof x === 'object') {
      return `{${Object.entries(x as Record<string, unknown>).map(([k, val]) => {
        const zhVal = k === 'status' && typeof val === 'string' ? STATUS_VALUE[val] : undefined;
        return `${JSON.stringify(k)}${KEY[k] ? `（${KEY[k]}）` : ''}:${walk(val)}${zhVal ? `（${zhVal}）` : ''}`;
      }).join(',')}}`;
    }
    return JSON.stringify(x);
  };
  return walk(v);
}
