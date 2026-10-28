# Phase 2：履約與出貨（FEATURE_STATUS_MATRIX #28）

> 狀態：IMPLEMENTED_NEW（本機隔離環境驗證）。沒有連任何物流商、沒有寄真實通知、沒有真實資料；DEMO 資料全部是虛構的。

## 範圍
每個檔期可建立**出貨批次**（寄樣 `SAMPLE`／訂單出貨 `ORDER`），批次底下有**出貨單**（物流商、追蹤碼、預計／實際日期、數量、異常原因）、**簽收確認**，以及獨立的**庫存異動**（append-only）。物流資訊一律人工登錄。

## 資料表（`migrations/009_fulfillment.sql`）
| 表 | 重點 |
|---|---|
| `fulfillment_batches` | `FBT-000001`；`kind`、`status`（PENDING／PACKED／SHIPPED／DELIVERED／EXCEPTION／CANCELLED）；`status` 由出貨單彙總，只有「取消」是人工動作；`cancel_reason` 必填（CHECK） |
| `shipments` | `SHP-000001`；`sku_id`（選填，需屬於該檔期商品）、`quantity>0`、`carrier`、`tracking_no`、`planned/shipped/delivered_date`、`exception_reason`、簽收欄位；CHECK：異常／取消必須有原因、簽收只能在 DELIVERED、送達日≥出貨日；唯一索引：同物流商＋追蹤碼（不分大小寫）在「未取消」的出貨單上不可重複 |
| `inventory_movements` | `STK-000001`（012 之前建立的紀錄沿用 `INV-` 前綴）；`delta≠0`；`reason_code`、`reason`（必填）、`reverses_id`（唯一：同一筆只能被更正一次）；**觸發器禁止 UPDATE／DELETE**；目前庫存＝`SUM(delta)` |

`fulfillment_batches`、`shipments` 有 `forbid_delete`（只能以狀態軟刪除），所有表皆有 `organization_id`。

## 狀態規則
- 出貨單：`PENDING → PACKED → SHIPPED → DELIVERED`；任一未終結狀態可 `EXCEPTION`（需原因）或 `CANCELLED`（需原因）；`EXCEPTION` 可回到 PACKED／SHIPPED／DELIVERED。`DELIVERED`、`CANCELLED` 是終點。
- 出貨前必須有物流商（自行配送填「自送」）；日期不可是未來；送達日不可早於出貨日。
- 批次彙總：有異常＝EXCEPTION；全部（未取消）送達＝DELIVERED；有任何出貨／送達＝SHIPPED；全部已包裝＝PACKED；否則 PENDING。取消批次會連動取消未送達的出貨單；已有送達的出貨單時不可整批取消。
- 檔期處於 CANCELLED／CLOSED／ON_HOLD 時履約資料唯讀。訂單出貨批次最早從 SCHEDULED 開始建立；寄樣不受此限（DRAFT 起即可）。
- 簽收確認：只能對「已送達」做；已確認再送一次不覆蓋（冪等）。簽收人為文字欄位（團主／廠商目前不能自己簽收，見「限制」）。
- 庫存：期初庫存只能設一次；入庫／退貨為正數、損耗為負數；庫存不可為負；更正＝新增反向異動（`CORRECTION`），更正紀錄不能再被更正。**庫存不會隨出貨自動扣除**（刻意不做，避免重複計算；要扣請手動登錄）。

## API（皆經 `router.ts`：CSRF／冪等／錯誤對應）
| 方法 路徑 | 權限 | 說明 |
|---|---|---|
| `GET /fulfillment/batches?campaignId&status&kind&open` | fulfillment.read | 批次列表（含出貨單數／送達／簽收彙總） |
| `POST /fulfillment/batches` ／ `POST /campaigns/:id/fulfillment/batches` | fulfillment.write | 建立批次（body：kind、label、plannedShipDate、note；支援 `Idempotency-Key`） |
| `GET /fulfillment/batches/:id` | read | 批次＋出貨單 |
| `PATCH /fulfillment/batches/:id` | write | 改名稱／預計日／備註（`version` 樂觀鎖；空字串清空） |
| `POST /fulfillment/batches/:id/cancel` | write | `{reason}` |
| `POST /fulfillment/batches/:id/shipments` | write | 新增出貨單（支援 `Idempotency-Key`） |
| `PATCH /fulfillment/shipments/:id` | write | 改數量／物流／追蹤碼／日期／備註 |
| `POST /fulfillment/shipments/:id/status` | write | `{to, reason?, date?, carrier?, trackingNo?}` |
| `POST /fulfillment/shipments/:id/receipt` | write | `{signer, note?}` |
| `GET /campaigns/:id/fulfillment` | read | 檔期履約總覽＋提醒（WARN／INFO） |
| `GET /inventory/stock`、`GET /inventory/movements` | read＋**內部角色** | 庫存與異動；團主／廠商 403 |
| `POST /inventory/movements`、`POST /inventory/movements/:id/correct` | write | 調整（支援 `Idempotency-Key`）／更正（`{reason}`） |

## 權限
| 角色 | 履約 | 庫存 |
|---|---|---|
| SYSTEM_ADMIN／OPS_MANAGER／OPS_EDITOR | 讀寫（小編只限自己負責的檔期，範圍外 404） | 讀寫 |
| FINANCE | 唯讀 | 唯讀 |
| HOST／VENDOR | 唯讀，限自己的檔期（範圍外 404）；看不到內部備註 | 不可（403） |

資料範圍一律經 `campaignScope`；團主／廠商不會看到 `note`、建立者等內部欄位。

## 提醒（只提醒，不擋關卡）
`getCampaignFulfillment().warnings`：`NO_BATCH`（履約中沒有批次）、`EXCEPTION`、`LATE_SHIP`（逾預計出貨日未出）、`UNDELIVERED`（已進結算仍有未送達）、`UNCONFIRMED_RECEIPT`（INFO）。**沒有修改任何 G 閘門、狀態機或排程核心**；出貨單異常會對檔期負責人排入站內通知（測試 Adapter，不寄信）。

## 介面
`/fulfillment`（批次列表、檔期總覽、庫存分頁）、`/fulfillment/[id]`（批次詳情與出貨單操作）。導覽新增「履約出貨」。截圖：`fulfillment-list.png`、`fulfillment-batch.png`、`fulfillment-stock.png`（本資料夾，DEMO 資料）。

## DEMO 資料
`npx tsx scripts/seed-demo-fulfillment.ts`（需先 `db:seed:demo`）：在 [DEMO] 檔期建立虛構批次／出貨單／簽收／異常／庫存；冪等；拒絕 production（除非 `ALLOW_DEMO_IN_PRODUCTION=yes`）。**尚未接進 `bootstrap-demo.ts`**，由主 session 決定。

## 驗證
- `tests/fulfillment.test.ts`：29 項（真實 Postgres、一檔一組織）。涵蓋：彙總純函式、完整出貨流程、重複追蹤碼、日期規則、異常通知去重、簽收冪等、樂觀鎖、取消連動、唯讀檔期、稽核前後值、不可實體刪除、庫存規則與更正、資料庫層 append-only、RBAC（小編範圍／財務唯讀／團主／廠商）、`Idempotency-Key`（含同 key 不同內容被拒）。
- 變異驗證：把資料範圍條件拿掉 → 12 項變紅；讓團主看得到備註 → 2 項變紅；停用批次彙總 → 4 項變紅。
- UI 以 Playwright 在隔離副本實跑：主管完成「已包裝→出貨→送達→簽收」並讀回狀態；庫存「更正」後餘額 295→300；團主／廠商看不到建立按鈕、庫存分頁與內部備註；無 console／page error。

## 與規格的落差與限制
1. 工作流程沒有獨立的「出貨」步驟（`SAMPLE_SHIP` 是寄樣），所以**沒有**做任務完成檢查；改以檔期總覽的提醒呈現。
2. 團主／廠商只能看，不能自己回報簽收（廠商入口屬 D4，未解凍）；簽收由內部人員代登。
3. 庫存不自動隨出貨扣除；沒有「預留」「安全庫存」概念。
4. 沒有訂單層級的出貨對應（出貨單不綁訂單）；沒有物流商 API／追蹤查詢；沒有出貨單匯入。
5. `DELIVERED` 後無法退回（更正請走售後流程，屬另一模組）。
6. 檔期詳情頁尚未加入「履約」分頁（避免與其他模組同時改共用頁）；目前入口是側欄「履約出貨」與 `/fulfillment?campaignId=…`。
