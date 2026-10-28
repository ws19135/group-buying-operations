# 自動化與事件

> 程式：`src/server/modules/automation.ts`、`notifications.ts`、`intake.ts`；排程：`scripts/worker.ts`。測試：`tests/automation.test.ts`。

## 安全欄杆（全部有測試）

1. **預設全部停用**：新組織的 8 個工作 `enabled=false`；停用的工作執行時回傳 `SKIPPED(disabled)`，不留下任何副作用。
2. **雙重開關**：worker 需 `AUTOMATION_ENABLED=on`，且該工作在資料庫被啟用（管理頁面或 `POST /api/automation/jobs/:key {action:'enable'}`，需 `automation.manage`，寫稽核）。
3. **冪等**：`(工作, 冪等鍵)` 唯一；同一鍵成功過就 `SKIPPED(already_succeeded)`。每日類工作（摘要、提醒、逾期偵測、開團前檢查）的鍵是 `工作:台北日期`；狀態推進以小時為單位；事件、進件、通知派送以分鐘為單位。手動執行使用獨立的鍵，但工作內部仍以業務去重鍵（例外 `dedupe_key`、通知 `dedupe_key`、事件 `processed_at`）保證不重複建立。
4. **可重試**：失敗的 run 保留錯誤訊息；再次執行同一鍵會重試同一筆（`attempts+1`，上限 3 次）。
5. **有紀錄、可查詢**：`automation_runs`（狀態、嘗試次數、起訖時間、統計、錯誤）；`GET /api/automation/runs`。
6. **不碰財務與合作條件**：進件的分潤％只寫入備註；不寫佣金規則、不寫金額。
7. **不對真人發送**：通知經佇列＋Adapter；目前只有測試 Adapter（只記錄）。`NOTIFY_ADAPTER` 設成其他值會拋出 `BLOCKED` 錯誤（因為真實 LINE／Email 未實作、也沒有憑證）。

## 工作清單

| 工作 key | 做什麼 | 觸發 | 產出 |
|---|---|---|---|
| `event_dispatch` | 處理 outbox 事件：`campaign.created`（確保任務已建立＋通知負責人）、`campaign.dates_changed`（通知負責人與被指派者）、`approval.requested`（通知可核准的人）、`campaign.status_changed`、`import.completed`（有錯誤列時通知主管） | 每分鐘 | 任務（冪等）、站內通知 |
| `vendor_intake` | 處理廠商進件：以正規化名稱／統編配對或建立廠商與商品，建立**草稿檔期**＋任務；黑名單／暫停廠商或分潤％無法判斷 → `NEEDS_REVIEW` | 每分鐘 | 廠商、商品、檔期、通知 |
| `task_reminders` | 團主／廠商負責的任務到期前 1 天與逾期：站內通知（同一人同一任務每天一次）；**試用回饋逾期＝團主未回覆**：團主標為 `NO_RESPONSE`、開例外（逾期 ≥3 天為高風險） | 每日 | 通知、例外 |
| `overdue_detection` | 逾期任務開例外（`dedupe_key=task_overdue:<id>`）；日期調整或完成後自動結案例外 | 每日 | 例外 |
| `prelaunch_check` | 已排程且 3 天內開團的檔期重跑 G2 檢查，不通過 → 高風險例外＋通知負責人；通過 → 結案例外。**不會自動核准或開團** | 每日 | 例外、通知 |
| `campaign_status_progress` | 到開團日：已排程 → 進行中；過結團日：進行中 → 待結單確認（系統操作，稽核 `actor_type=SYSTEM`）；確保結團後任務齊全；通知負責人與主管申請 G3 | 每小時 | 狀態、通知 |
| `daily_summary` | 產生每日營運摘要（`daily_summaries`，每天一筆）並對管理者／營運主管排入 EMAIL 通知（僅測試 Adapter）；同一工作順手清除超過 30 天的 `idempotency_keys`（K6，技術性去重快取；結果在 `stats.idempotencyKeysPurged`） | 每日 | 摘要資料、通知、過期的去重快取 |
| `notification_dispatch` | 派送佇列：IN_APP 直接送達；EMAIL／LINE 交給 Adapter；失敗重試，3 次後 `DEAD` 並建立例外 | 每分鐘 | 通知狀態 |

## 例外（`exceptions`）

例外是一級資料：類型、嚴重度（LOW/MEDIUM/HIGH）、關聯檔期、負責人、`dedupe_key`（未結的同 key 不重複建立）。目前類型：`TASK_OVERDUE`、`HOST_NO_RESPONSE`、`PRELAUNCH_CHECK_FAILED`、`SCHEDULE_CHANGED_AFTER_APPROVAL`、`NOTIFICATION_DEAD`。可在 UI 認領或結案（需說明，寫稽核）。

## 事件（`events`）

`campaign.created`、`campaign.dates_changed`、`campaign.status_changed`、`approval.requested`、`task.completed`、`import.completed`。以 `dedupe_key` 防重複；處理失敗最多重試 5 次並記錄 `last_error`。

## 進件欄位（對應 SOP 的廠商表單）

廠商／品牌名稱、公司名稱、統編、聯絡人、聯絡方式、官網、品項名稱、品項連結、賣點、原價、團購價、分潤／合作％、試用品可寄出日、是否回收、回收方式、預計可開團時期、結單日期如何計算、合作但書、備註。以 `externalSubmissionId` 去重（重複送出回傳同一筆）。

## 啟用步驟（本機）

```bash
export AUTOMATION_ENABLED=on
npm run worker:once        # 先看一輪；所有工作預設停用，會顯示 SKIPPED(disabled)
# 在 /automation 頁面（或 API）逐一啟用工作後：
npm run worker             # 每 60 秒一輪
```

## 未完成／BLOCKED

- 真實 LINE／Email 發送：`BLOCKED`（無憑證、無 Owner 授權）。
- 以排程器（cron／系統服務）常駐 worker：部署事項，見 DEPLOYMENT.md。
