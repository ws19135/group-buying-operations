# Phase 2：退款、客訴、售後案件（FEATURE_STATUS_MATRIX #29）

> 狀態：`IMPLEMENTED_NEW`（只在本機／隔離環境驗證；沒有部署、沒有真實資料、沒有真實通知、不處理真實金流）。
> 規格依據：FEATURE_STATUS_MATRIX #29「退款、客訴、售後案件」；本模組的細部規則是依範圍說明實作，**沒有更細的 SRS／SDD**，下方「與規格的落差」逐項列出需 Owner 確認的地方。

## 做了什麼

| 項目 | 內容 |
|---|---|
| 售後案件 `service_cases` | 類型 `REFUND／COMPLAINT／EXCHANGE／OTHER`；關聯檔期（必填）與訂單（選填）；優先級 `LOW／MEDIUM／HIGH`；負責人；到期日；描述；處理結果；內部備註 |
| 案件狀態 | `OPEN → IN_PROGRESS ⇄ WAITING_VENDOR → RESOLVED → CLOSED`；任何處理中狀態可 `CANCELLED`（軟刪除，需原因）；`RESOLVED → IN_PROGRESS` 為「重新開啟」（需原因）；`CLOSED／CANCELLED` 為終態 |
| 處理紀錄 `case_events` | 只能新增（資料庫觸發器擋 UPDATE／DELETE，比照 `audit_logs`）；備註可標為「對外可見」，團主／廠商只看得到這類紀錄 |
| 退款申請 `refund_requests` | `REQUESTED → APPROVED／REJECTED → COMPLETED`；金額（整數 TWD）、原因、核准者與原因、完成者與備註 |
| 寫回訂單 | 完成退款時**可選**把金額累加到 `orders.refund_amount` 並更新訂單狀態（`PARTIAL_REFUND`／`REFUNDED`）。參數 `writeback` **預設 false**，必須明確傳 `true` |
| 總覽 | `getAftersalesOverview(actor)`：處理中／逾期／高優先／已解決／已結案／已取消數量、依狀態／類型／檔期統計、退款各狀態件數與金額（僅內部角色）。**未修改** `dashboard.ts`；卡片元件 `src/app/(app)/aftersales/OverviewCards.tsx` 可嵌進任何頁面 |
| 介面（繁中） | `/aftersales`（總覽＋列表＋篩選）、`/aftersales/new`、`/aftersales/[id]`（資料／處理紀錄／退款申請與操作）、`/aftersales/refunds`（退款佇列）；側欄「售後」 |
| DEMO 資料 | `npm run db:seed:demo:aftersales`：7 件虛構案件、4 筆退款申請（待核准／待完成／已完成並寫回／已退回各一），冪等、拒絕 production |

## 資料表（`migrations/010_aftersales.sql`）

- `service_cases(id CAS-000001, organization_id, campaign_id, order_id?, case_type, status, priority, title, description, buyer_ref, assignee_user_id, due_date, resolution, internal_note, resolved_at, closed_at, cancelled_at, version …)`；`forbid_delete` 觸發器、`touch_row`。
- `case_events(id bigserial, case_id, event_type, from_status, to_status, note, is_internal, actor_user_id, actor_role, created_at)`；`case_events_immutable`（UPDATE／DELETE 皆拒絕）。
- `refund_requests(id RFD-000001, case_id, campaign_id, order_id?, amount > 0, reason, status, requested_by, decided_by/at/note, completed_by/at/note, writeback_applied …)`；`forbid_delete`；CHECK：已決定必有決定者、已完成必有完成者、`writeback_applied` 只在 `COMPLETED` 且有訂單時為真。
- 買家只存去識別化代號 `buyer_ref`，不存姓名／電話／地址。

## API（皆需登入；寫入類請求同樣受 CSRF Origin 檢查）

| 方法與路徑 | 權限 | 說明 |
|---|---|---|
| `GET /api/aftersales/overview` | `aftersales.read` | 總覽統計（團主／廠商只看範圍內、無退款金額） |
| `GET /api/aftersales/cases` | `aftersales.read` | 列表；篩選 `status`（`ACTIVE`＝處理中、或單一狀態）、`caseType`、`priority`、`campaignId`、`orderId`、`mine=1`、`overdue=1`、`q`；分頁 `page／limit` |
| `POST /api/aftersales/cases` | `aftersales.write` | 建案；支援 `Idempotency-Key` |
| `GET /api/aftersales/cases/:id` | `aftersales.read` | 詳情（內部：全欄位＋全部紀錄＋退款＋訂單；外部：摘要＋對外紀錄） |
| `PATCH /api/aftersales/cases/:id` | `aftersales.write` | 更新欄位；空字串＝清空；帶 `version` 做樂觀鎖（409） |
| `POST /api/aftersales/cases/:id/status` | `aftersales.write` | `{ to, note?, resolution?, version? }`；非法轉移 412 |
| `POST /api/aftersales/cases/:id/notes` | `aftersales.write` | `{ note, public? }` |
| `POST /api/aftersales/cases/:id/refunds` | `aftersales.write` | `{ amount, reason, orderId? }`；支援 `Idempotency-Key` |
| `GET /api/aftersales/refunds` | `aftersales.read`＋內部角色 | 退款申請列表（`status`、`pending=1`、`caseId`） |
| `POST /api/aftersales/refunds/:id/decision` | `refund.approve` | `{ decision: APPROVED｜REJECTED, note? }`；退回必填原因 |
| `POST /api/aftersales/refunds/:id/complete` | `refund.complete` | `{ writeback?: boolean（預設 false）, note? }` |

## 權限

新增四個權限：`aftersales.read`、`aftersales.write`、`refund.approve`，以及（為了讓「財務完成退款、主管不能完成」成立而多加的）`refund.complete`。

| 角色 | read | write（建案／處理／申請退款） | approve（核准退回） | complete（完成退款） |
|---|---|---|---|---|
| 系統管理者 | ✅ | ✅ | ✅ | ✅ |
| 營運主管 | ✅ | ✅ | ✅ | — |
| 營運小編 | ✅（自己負責的檔期） | ✅（同左） | — | — |
| 財務 | ✅ | — | — | ✅ |
| 團主／廠商 | ✅ 僅自己範圍的**摘要** | — | — | — |

- **資料範圍**一律走 `campaignScope`（與任務、訂單相同）；範圍外一律 404，不洩漏是否存在。
- **外部角色欄位投影**：只有 `id、campaignId、campaignTitle、caseType、status、priority、title、dueDate、resolution、createdAt、resolvedAt、closedAt、overdue`，以及「對外可見」的備註；**沒有**描述、買家代號、訂單、負責人、內部備註、退款資料、內部處理紀錄。退款佇列對外部角色回 403。
- 完成退款需要財務／管理者；營運主管不能完成（避免同一人核准又放款）。

## 業務規則（已實作並有測試）

1. 退款申請：案件需「處理中」；有訂單時訂單需為 `PAID／PARTIAL_REFUND`；金額 ≤ 訂單金額 − 已退金額 − 其他「申請中／已核准」的申請（訂單列鎖定，併發申請只會成功一筆）；無訂單的案件不檢查餘額。
2. 案件標記已解決／結案／取消前，不可有「待核准／已核准未完成」的退款（先處理退款）。
3. 完成退款 `writeback=true`：同一交易內鎖訂單、重驗 `累計 ≤ 訂單金額`、更新 `refund_amount` 與訂單狀態、寫 `order.refund_writeback` 稽核（前後值＋退款申請編號）；任何一步失敗整筆回滾。同一筆退款併發完成只會成功一次。
4. 所有寫入都有稽核（`service_case.*`、`refund.*`、`order.refund_writeback`）與處理紀錄。
5. 通知只排入通知佇列（站內通知，TestAdapter）：指派負責人、退款申請待核准（通知主管與管理者）、核准／退回結果通知申請者；不寄任何真實訊息。
6. 個資防呆：標題／描述／備註／原因／處理結果若含台灣手機號碼或 Email 會被擋下（盡力而為，不是完整的個資偵測）；介面有提醒文字。

## 驗證證據

- `tests/aftersales.test.ts`：31 項（真實 PostgreSQL，一檔一組織），涵蓋權限矩陣、建案驗證與冪等、資料範圍與外部欄位投影、狀態機與樂觀鎖、更新與清空欄位、不可實體刪除／紀錄不可改、退款金額邊界與併發、核准權限、寫回訂單（累計／狀態／稽核／漂移／回滾／併發）、案件與退款連動、列表篩選與總覽（與資料庫直接計算對帳）、HTTP 層完整流程。
- **變異測試**（把正確程式故意改壞，測試必須轉紅）：移除資料範圍、移除餘額檢查、寫回狀態一律部分退款、外部角色看完整列、完成退款不鎖列、核准改用寫入權限、`writeback` 預設改 true——7 種變異全部使測試失敗，還原後全綠。
- `scripts/e2e-aftersales.ts`：瀏覽器實測（Playwright）依角色走完整流程，結果在 `docs/phase2/aftersales-e2e.json`，截圖在 `docs/phase2/screens/aftersales-*.png`。

## 與規格的落差／需 Owner 確認

1. **沒有細部規格**：案件狀態、退款流程、權限分配是依範圍說明推導；請 Owner 確認 `WAITING_VENDOR` 是否需要、是否要「核准者不可是申請者本人」（目前沒有此限制，小團隊常見一人兼任）。
2. **多了 `refund.complete` 權限**（範圍說明只列三個權限），用來限制只有財務／管理者能完成退款。
3. **訂單 CSV 重新匯入**：訂單層欄位有變動時匯入會更新 `refund_amount`；若先寫回再匯入較舊的檔案，寫回的金額會被覆蓋。建議流程：退款已由匯入反映的就不要勾「寫回」。
4. 寫回訂單只改 `orders.refund_amount／status`，**不會**改品項明細，也不會自動重算已產生的佣金試算／結算（那是財務模組的範圍）。
5. 逾期案件目前只在畫面與總覽標示，**未**接到「例外」自動化（沒有改動 automation 模組）。
6. 退款金額上限 1 億、整數 TWD；不支援多幣別、不處理稅額。
7. 不處理真實金流退款；「完成」只代表人工確認已退款。

## 限制

- 沒有附件上傳（只有文字紀錄）；沒有 SLA 計時、沒有客戶端查詢入口（涉及對外存取，屬廠商／客戶入口，需 Owner 解凍）。
- 儀表板頁面未嵌入售後卡片（避免改動既有 dashboard 輸出）；`AftersalesOverviewCards` 與 `GET /api/aftersales/overview` 已備妥，要嵌入時由主 session 決定位置。
- 團主／廠商看到的案件摘要包含「處理結果」；撰寫處理結果時請勿放內部資訊（介面有提示）。
