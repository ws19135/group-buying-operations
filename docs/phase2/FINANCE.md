# Phase 2 財務：結算試算、入帳確認、發票紀錄、費用

> **試算，口徑待 Owner 確認；非正式付款依據。** 本模組所有金額都只是「紀錄」或「試算」：不連接任何金流、銀行、電子發票服務；沒有真實帳號、統編、發票。
> 對應 `FEATURE_STATUS_MATRIX` #31（入帳確認、發票、費用）與 #32（結算：試算／覆寫／確認／調整）。migration：`011_finance.sql`。

## 1. 金額口徑（沒有新公式）

結算試算**只重用** Phase 1 的預估佣金口徑，單一定義在 `src/server/lib/commission-calc.ts`（團主 Dashboard 與結算共用）：

```
歸因淨銷售 = Σ (gross_amount − refund_amount) × share_percent / 100     （訂單狀態 PAID／PARTIAL_REFUND／REFUNDED）
自動試算佣金 = round(歸因淨銷售 × 生效中的佣金費率)
費率選取：檔期團主綁定的規則 → 該檔期專屬規則 → 團主預設規則（以開團日為基準日、需在生效區間內）
```

- 沒有適用費率：有銷售時 `commission_auto = null`（不猜）；淨銷售為 0 時 `commission_auto = 0`（0 × 任何費率都是 0，不是新增公式）。
- 費用 `expenses` 與入帳／付款 `payments` **不進**佣金公式（測試 `費用不進佣金公式` 驗證）。
- 「試算與既有預估佣金一致」由測試對照團主 Dashboard 的 `myNet`／`estimatedCommission`／`commissionRate` 驗證。
- 財務總覽的「試算佣金」只加總自動試算值（不含覆寫與調整）；結算頁的「最終佣金」才含覆寫與調整。

人工調整**只有兩種**，且系統不會自動產生任何一種：
1. **覆寫** `commission_override`：取代自動試算值；必填原因、不可為負、可清除（稽核留前後值）。
2. **調整項** `settlement_adjustments`：金額可正可負（不可為 0）、原因必填、只增不改不刪（資料庫觸發器強制）。

`最終佣金 = (覆寫 ?? 自動試算) + 該團主調整合計`；基準為 null（沒費率也沒覆寫）時最終為 null，且**不能確認**。

## 2. 結算狀態與鎖定

| 動作 | 條件 | 權限 |
|---|---|---|
| 開立試算（`POST /settlements`） | 檔期已開賣（RUNNING 以後）、該檔期沒有草稿或已確認的結算；支援 Idempotency-Key | `finance.write` |
| 重新試算 | 只限 DRAFT；保留覆寫與調整 | `finance.write` |
| 覆寫／新增調整項 | 只限 DRAFT | `finance.write` |
| 確認（DRAFT→CONFIRMED） | 見下 | `settlement.confirm`（FINANCE／SYSTEM_ADMIN，比照 G4 核准者） |
| 作廢 | DRAFT 用 `finance.write`；CONFIRMED 需 `settlement.confirm`；必填原因；有「已核對」入帳關聯時擋下 | 同左 |

確認時的檢查（任一不過就不確認）：有團主項目；**試算沒有過期**（重新以最新訂單／規則算一次，與草稿存的值逐項比對，不同 → 412 `STALE_CALCULATION`，請先重新試算）；每位團主都有可用金額（費率或覆寫）。確認時寫入 `rule_version_note`（每位團主採用的規則 ID／版本／費率快照）、`data_as_of`（資料截至時間）與 `data_status`（NO_DATA／DEMO／IMPORT／MIXED）。

鎖定是**資料庫層**強制（`settlements_guard`、`settlement_children_guard`、`settlement_adjustments_immutable` 觸發器）：確認後項目與調整項不能新增／修改；CONFIRMED 只能轉 VOID；VOID 是終態；確認欄位（`confirmed_*`、規則快照、資料基準）不可改。要修正只能作廢後重開（同檔期的唯一索引 `settlements_campaign_live_uq` 只擋 DRAFT／CONFIRMED，所以作廢後可重開）。
不改變檔期狀態機：結算確認不會自動推進 G4／檔期狀態（G4 仍是人工確認）。

## 3. 資料表（`011_finance.sql`）

- `settlements`（ALTER）：+`campaign_id`、`data_as_of`、`data_status`、`voided_at/by`、`void_reason`、`updated_at`。
- `settlement_items`（ALTER）：+`rate_percent`、`rule_id`、`rule_version`、`updated_at/by`；唯一 `(settlement_id, host_id)`；覆寫值必須有原因（CHECK）。
- `settlement_adjustments`（新）：append-only。
- `payments`（新）：方向 IN／OUT、對象 VENDOR／HOST／PLATFORM、金額 > 0、日期、參考號（佔位字，**請勿填銀行帳號**）、可關聯檔期或結算項目、`match_status` UNMATCHED／MATCHED、`status` ACTIVE／VOID。MATCHED 必須已關聯（CHECK）；不可實體刪除。
- `invoices`（新）：號碼、日期、金額、抬頭／統編（佔位文字欄位）、狀態 DRAFT／ISSUED／VOID；同組織同號碼只能有一張未作廢（唯一索引）；只能作廢不能刪。
- `expenses`（新）：類別 SHIPPING／MARKETING／SAMPLE／PLATFORM_FEE／OTHER、金額 > 0、可關聯檔期、RECORDED／VOID。

所有新表都有 `forbid_delete`（軟刪除＝作廢，作廢必填原因）；所有寫入都寫 `audit_logs`（含檔期、操作者、原因、前後值）。

## 4. 權限

新增 `finance.read`、`finance.write`、`settlement.confirm`（`src/server/lib/permissions.ts`）：

| 角色 | finance.read | finance.write | settlement.confirm |
|---|---|---|---|
| SYSTEM_ADMIN | ✅ | ✅ | ✅ |
| FINANCE | ✅ | ✅ | ✅ |
| OPS_MANAGER | ✅（唯讀） | ❌ | ❌ |
| OPS_EDITOR／VENDOR | ❌ | ❌ | ❌ |
| HOST | ❌ | ❌ | ❌；僅有 `commission.read`，只能用 `GET /settlements/mine` |

- 沒有權限的角色呼叫財務端點一律 403（測試逐端點驗證）；找不到／不在資料範圍的資源回 404。
- `GET /settlements/mine`（只限 HOST）：只回**自己**、**已確認**的結算項：檔期、確認日、淨銷售、費率、最終佣金（含調整合計）。不含其他團主、覆寫／調整原因、費用、入帳、發票；草稿不顯示。
- 資料範圍沿用 `campaignScope()`。

## 5. API（均需登入；寫入需 Origin 檢查與 JSON）

| 方法 路徑 | 說明 |
|---|---|
| `GET /finance/overview` | 各檔期：淨銷售、試算佣金（+幾位團主無費率）、已入帳／已付款、費用、已開立發票金額、未核對筆數、結算狀態；合計含「未關聯檔期的未核對筆數」。不改既有 `dashboard.ts` 輸出 |
| `GET/POST /settlements`、`GET /settlements/:id`、`GET /settlements/mine` | 清單（status／campaignId 篩選）、開立、詳情（含 `stale`、合計、未歸因淨銷售、調整項）、團主摘要 |
| `POST /settlements/:id/recalculate｜adjustments｜confirm｜void` | 重新試算、新增調整項 `{itemId, amount, reason}`、確認 `{note?}`、作廢 `{reason}` |
| `POST /settlement-items/:id/override` | `{amount, reason}` 覆寫；`{amount: null}` 清除 |
| `GET/POST /payments`、`PATCH /payments/:id`、`POST /payments/:id/match｜unmatch｜void` | 入帳／付款；`match` 需已關聯檔期或結算項目（可同時帶 `campaignId`／`settlementItemId`）；`unmatch`、`void` 必填原因；已核對不可修改／作廢 |
| `GET/POST /invoices`、`PATCH /invoices/:id`、`POST /invoices/:id/issue｜void` | 草稿可改；開立後只能作廢 |
| `GET/POST /expenses`、`PATCH /expenses/:id`、`POST /expenses/:id/void` | 費用紀錄 |

建立類端點（結算、入帳、發票、費用）支援 `Idempotency-Key`（相同 key 不同內容 → 422）；更新支援 `version` 樂觀鎖（409）。

## 6. 介面（繁中）

- `/finance`：分頁「財務總覽／結算試算／入帳／發票／費用」；`/finance/settlements/[id]`：結算詳情（覆寫、調整、重新試算、確認、作廢）；`/finance/mine`：團主的「我的結算」。導覽「財務結算」需 `finance.read`；「我的結算」只給團主。
- **每個財務頁面最上方固定顯示：「試算，口徑待 Owner 確認；非正式付款依據」**；DEMO 資料的結算另顯示 DEMO 標示；試算過期會顯示紅色提示。
- 入帳／發票頁固定提醒：只做紀錄、不接銀行／電子發票、勿填真實帳號與統編。

## 7. 驗證證據

| 項目 | 結果 |
|---|---|
| `tests/finance.test.ts` | 22 個測試通過（真實 Postgres；試算與團主 Dashboard 一致、無費率不猜、覆寫／調整規則、確認權限／過期偵測／鎖定（含繞過服務層直接改資料庫）、作廢重開、團主視角範圍、財務 API 403 逐端點、入帳核對流程、發票狀態、費用與總覽彙總、稽核涵蓋所有寫入動作、Idempotency） |
| 既有回歸 | `orders-dashboard`、`rbac`、`database`、`lifecycle`、`unit/*` 共 133 個測試（含 finance）通過；`dashboard.ts` 只把本地 `pickRule` 換成共用函式 `pickCommissionRule`，輸出不變 |
| 以錯誤版本驗證測試會變紅 | 逐一破壞後重跑 finance 測試，皆變紅：拿掉過期檢查（1 失敗）、營運主管可寫財務（5）、淨銷售不分訂單狀態（10）、團主看得到草稿（1）、已核對可作廢（2）、拿掉鎖定觸發器（1）；之後已還原並重跑全綠 |
| UI 實跑 | 以 Playwright 在本機（開發伺服器、`erp_fin` 資料庫）走完：開立試算→新增調整→確認→鎖定→入帳新增並核對→發票開立→費用→總覽；團主／廠商／營運主管視角檢查，19 項斷言全部 PASS、無頁面 JS 錯誤。結果 `docs/phase2/finance-ui-results.json`，截圖 `docs/phase2/screens/finance-*.png` |
| 寫入後讀回 | 測試皆在寫入後以 SQL 讀回核對（狀態、金額、操作者、稽核前後值、規則快照） |
| DEMO 種子 | `npx tsx scripts/seed-demo-finance.ts`（需先 `db:seed:demo`）：建立 1 份草稿＋1 份已確認結算、入帳／付款（含 1 筆已核對）、費用 4 筆、發票 2 筆（全部虛構、佔位字）；重跑會略過；實跑讀回確認 |

## 8. 與規格的落差、限制、需 Owner 決定

- **口徑待 Owner 確認**：目前只有「單一費率 × 歸因淨銷售」；階梯、扣項（運費、平台費、退款扣回時點）、付款方式、分潤比例與順序都**沒有實作**，一律走覆寫或調整項。要新增任何公式需 Owner 定義（CLAUDE.md：碰金額公式先問）。
- 結算以「檔期」為單位；跨檔期／跨月批次結算、結算批次對團主的付款單、扣款抵銷尚未做。
- 結算確認**不會自動推進檔期 G4／狀態**，也不會自動建立付款；需人工另外操作（未改 `gates.ts`）。
- 結算試算以「目前訂單」為基準（不分期間）；`period_start/end` 只是記錄用，不過濾訂單。
- 入帳「核對」是人工標記；沒有銀行對帳單匯入、自動比對、金額容差。每筆入帳最多關聯一個檔期和一個結算項目（一筆入帳不能分攤到多個結算項目）。
- 發票只存文字欄位，沒有稅額、品項、折讓單，也沒有發票號碼格式驗證。
- 團主只看得到「已確認」的結算（草稿不給看）；若 Owner 想讓團主看到草稿試算，需另外決定。
- 大量檔期時 `financeOverview` 逐檔期計算試算佣金（最多 100 檔期），未做快取。
- 未實作：結算匯出（CSV／PDF）、通知團主、核准流程（雙人覆核）。需要時請 Owner 決定。
