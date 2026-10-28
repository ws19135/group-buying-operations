# 工作流程映射：SOP 11 步 → ERP 八階段（15 個任務）

> 來源：`groupbuy-flow-sop` 的 11 步＋藍圖 G1–G5。程式：`src/server/workflow/template-default.ts`（資料來源）、`schedule.ts`（排程引擎）。
> 模板存在資料庫（`workflow_templates` / `workflow_template_steps`），可版本化；本檔描述預設模板 `GROUPBUY_STANDARD` v1。

## 對照表

| ERP 階段 | 任務（step_key） | 負責角色 | 起算規則 | 天數 | 對應 SOP 步驟 / Gate |
|---|---|---|---|---|---|
| 1 籌備與寄樣 | 廠商寄樣（`SAMPLE_SHIP`） | 廠商 | 試用品可寄出日 | 7（`ship_days`） | SOP 1 |
| 2 試用與回饋 | 試用品到貨與試用（`TRIAL_ARRIVAL`） | 團主 | 寄樣結束＋1 | 14（`trial_days`） | SOP 2 |
| 2 試用與回饋 | 團主試用回饋・確認是否開團（`TRIAL_FEEDBACK`） | 團主 | 試用結束＋1 | 3（`feedback_days`） | SOP 3（生死關） |
| 3 開團審核 | 開團審核（`LAUNCH_APPROVAL`） | 營運主管 | 回饋結束＋1 | 1 | 藍圖 **G1** 選品核准 |
| 3 開團審核 | 試用品回收（`SAMPLE_RECOVERY`）*選擇性* | 廠商 | 回饋結束＋1 | 7（`recovery_days`） | SOP 4；只有「需回收」才適用 |
| 4 素材與賣場準備 | 圖文素材準備（`CREATIVE_ASSETS`） | 營運小編 | G1 結束＋1 | 7（`design_days`） | SOP 5（原為「第 3 步結束＋1」，改接在 G1 之後，避免未核准就開始做圖） |
| 4 素材與賣場準備 | 開團前檢查（`PRELAUNCH_CHECK`） | 營運主管 | 開團日−1 | 1 | 藍圖 **G2** 開團核准（新增） |
| 5 開團與曝光 | 正式開團・群組內曝光（`LAUNCH`） | 營運小編 | 開團日 | 1 | SOP 6 |
| 5 開團與曝光 | Live Talk（`LIVE_TALK`）*選擇性* | 團主 | Live Talk 日期 | 1 | SOP 7；有填日期才出現 |
| 5 開團與曝光 | 社群話題曝光（`TOPIC_PROMO`） | 營運小編 | 開團日＋2 | 1 | SOP 8 |
| 6 銷售與催單 | 結團前催單（`CLOSING_REMINDER`） | 營運小編 | 結團日−1 | 1 | SOP 9 |
| 7 結單與請款 | 結單核對（`CLOSE_CONFIRM`） | 營運主管 | 結團日＋1 | 1 | 藍圖 **G3** 結單確認（新增） |
| 7 結單與請款 | 廠商後台報表結算（`VENDOR_SETTLE`） | 營運小編 | 結團日＋1 | 14（`settle_days`） | SOP 10 |
| 7 結單與請款 | 開發票請款（`INVOICE_REQUEST`） | 營運小編 | 結算結束＋1 | 14（`invoice_days`） | SOP 11 |
| 8 復盤與結案 | 復盤與結案（`CLOSURE_REVIEW`） | 營運主管 | 請款結束＋1 | 1 | 藍圖 **G5** 結案核准（新增） |

> G4（結算確認）在 Phase 1 **沒有任務**：結算屬 Phase 2；檔期狀態「待結算 → 已結算」仍可由財務／管理者經 G4 核准（檢查項含「結算試算尚未實作」警告）。

## 規則

- **結束日＝開始日＋天數−1（含頭尾）**；下一步＝前一步結束日＋1。
- **選擇性任務**：條件不成立時任務建為 `SKIPPED`（保留紀錄）；之後條件成立（例如補上 Live Talk 日期），經「日期變更影響預覽」確認後自動變為 `TODO`。
- **關卡任務**（`kind=GATE`）：只能由核准流程完成，不能直接改狀態（API 會拒絕）。申請核准時任務變 `WAITING_APPROVAL`，核准後 `DONE`，退回後回 `TODO`。
- **相依**：任務不可在前置任務完成前開始／完成；營運主管／管理者可填原因強制。
- **逾期**：未完成且 `planned_end` 早於今天（台北）。自動化 `overdue_detection` 會建立例外（逾期 ≥3 天為高風險）。
- **排程衝突**：以開團／結團日為錨點的步驟，若前置步驟預計完成日不早於其開始日，任務會帶 `schedule_issue`（例如圖文來不及在開團前檢查之前完成）。
- **缺錨點日期**：不亂排，任務日期為空並標示原因（例如「缺少試用品可寄出日，無法排程」）。
- **人工調整單一任務日期**：必須填原因，任務被「鎖定」；之後的連動重排不會覆寫它，預覽會標示 `blocked_by_lock`。
- **修改預設天數**：發佈新版模板；既有檔期保留建立時的模板版本與天數快照，要採用新天數需逐檔預覽並確認。

## 日期變更影響預覽（`POST /api/campaigns/:id/reschedule`）

1. 不帶 `confirm`：回傳每個任務的前後日期與影響類型（`changed` / `unchanged` / `blocked_by_lock` / `done_untouched` / `newly_applicable` / `no_longer_applicable`）、衝突清單、是否需要原因、預覽代碼。**不寫入任何資料**。
2. 帶 `confirm=true` 與預覽代碼：重新計算，代碼不符（預覽後有人改動）則拒絕；已排程以後的檔期必須填原因且限管理者／營運主管；進行中不可改開團日。
3. 套用後寫稽核（前後值、原因、被鎖定而未動的任務）並發出 `campaign.dates_changed` 事件，由 worker 通知負責人。
