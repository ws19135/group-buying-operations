# 合作申請與樣品管理（COLLABORATION_APPLICATIONS）

> **2026-11-06 第二輪**：Owner 已對 PR #26 裁示 D-37～D-44 並要求最後一輪安全與權限加固。**本文件第五、七、九、十一節描述的是第一輪設計（小編為全組織範圍、廠商匯出遮罩、第 11 項權限待確認等）；凡與第十二節衝突者，以第十二節為準。**

> 狀態：`IMPLEMENTED_NEW`（只在本機／隔離環境驗證；**沒有部署到正式環境、沒有碰任何真實資料、沒有對外開放廠商入口、不發送任何真實通知**）。
> 需求依據：Owner 指令「網紅合作申請與樣品寄送管理」十四節，來源是廠商現行的兩張 Excel／Sheets 表單。
> 本文件是這個模組的單一完整規格；跨模組的部分以 `docs/spec/SRS.md`、`SAD.md`、`SDD.md` 為準。

---

## 一、業務流程

這個模組要接的是「網紅／團主先拿樣品試用，試用後再決定要不要開團」這條路，**不是**既有的「已經決定開團，然後走檔期」那條路。所以它必須能在「還沒有檔期」的狀態下運作。

```
   營運／團主／廠商             廠商                營運              團主             營運            廠商＋營運
        建立申請  ──送審──▶  確認供樣  ──寄出──▶  （代寄）  ──收件──▶ 回覆意願 ──▶ 確認合作 ──▶ 回填連結與後台
          │                    │                                   │               │                   │
          │                    │                                   │               ▼                   │
          │                    │                                   │        關聯既有正式檔期            │
          │                    │                                   │        （不新建、不碰 G1～G5）      │
          ▼                    ▼                                   ▼               ▼                   ▼
     ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
     │  三方各自從自己的工作台追蹤同一筆案件（同一份資料、不同授權視角，沒有第二份副本）              │
     │   營運：合作管理 → 網紅合作申請     廠商：廠商工作台 → 網紅申請與樣品寄送     團主：我的樣品申請 │
     └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

重點刻意設計：

| 設計 | 原因 |
|---|---|
| 樣品申請**不是**檔期 | 試用完可能不開團。強迫先建檔期會汙染檔期資料與 G1～G5 核准紀錄 |
| 樣品申請**不扣庫存、不產生任何財務或結算紀錄** | 樣品不是銷售。已用測試固定住（`inventory_movements`／`settlements`／`settlement_items`／`payments` 筆數前後不變） |
| 廠商「確認供樣」**不等於** G1～G5 任何核准 | 兩件事的審核人與責任不同；`approvals` 表完全不被本模組寫入（已用測試固定） |
| 「是否已補寄」是**推導值**，不是打勾欄位 | 來源表單的勾選常與事實不符。本系統只認「真的有一列補寄紀錄並填了寄出日期」 |
| 收件資訊獨立一張表、獨立端點、獨立稽核 | 它是個資，和案件其他欄位的授權範圍不同 |

---

## 二、欄位定義（對照廠商現行兩張表單）

### 表單一（開團與補寄追蹤）

| 來源欄位 | 落在哪裡 | 說明 |
|---|---|---|
| 團購主 | `collaboration_applications.host_id` | 對應既有團主主檔，**不另建團主名單** |
| 檔期 | `collaboration_applications.campaign_id` | 只在已確認合作後關聯既有檔期；沒有對應檔期就留空 |
| 是否已補寄（品牌若寄出請改日期） | 由 `collaboration_shipments` 推導 | 匯入時只當參考值，判讀不了就標 `RESENT_UNREADABLE` |
| 開團連結 | `collaboration_launch_details.launch_url` | |
| 是否投廣 | `collaboration_launch_details.ads_intent`／`ads_confirm_status` | 意願（誰想投）與廠商確認（誰出錢）分開兩欄 |
| 後台設定 Mail | `collaboration_launch_details.backend_setup_email` ＋ `backend_setup_status` | **只記錄聯絡信箱與處理狀態，系統絕不自動寄信** |

### 表單二（樣品申請）

| 來源欄位 | 落在哪裡 | 說明 |
|---|---|---|
| 網紅名稱 | `host_id`（經人工對應） | 同名不代表同人，對應不到唯一主檔就列「待確認」 |
| 收件人／聯繫電話／地址 | `collaboration_recipients`（個資表） | 見第七節；**不覆寫團主主檔**（`hosts` 全表無任何地址欄位） |
| 申請樣品 | `collaboration_application_items`（可多商品、多規格） | 規格是同一商品底下的選項，不是另一個商品 |
| 配送日期（寄出後回填） | `collaboration_shipments.ship_date` | 一筆申請可有多列寄送紀錄（首次＋補寄） |
| 開團意願 | `collaboration_launch_details.intent` | `PENDING／WILLING／UNDECIDED／UNWILLING` |
| 開團日期 | `planned_open_date`（預計）與 `confirmed_open_date`（已確認）**兩欄** | 來源表單只有一欄，但這兩件事必須分得開 |
| 備註 | `collaboration_applications.note`（對外）／`internal_note`（內部） | |
| 開團連結 | `launch_url` | |
| 後台連結 | `vendor_portal_url` | 可能含商業敏感資訊，團主看不到 |

---

## 三、資料模型（`migrations/028_collaboration_applications.sql`，7 張表）

```
collaboration_applications (CLB-)  ── 一筆合作申請＝一個團主 × 一家廠商 × 一次申請
   │   vendor_id→vendors   host_id→hosts   product_id→products(代表商品)
   │   campaign_id→campaigns(確認合作後才可填，DB CHECK 擋)   trial_id→product_trials(只引用)
   ├─< collaboration_application_items (CLI-)   申請樣品明細：product_id＋sku_id、申請/核准數量、供應狀態
   ├─1 collaboration_recipients (CRP-)          收件資訊（個資）：含 retention_until／purged_at
   ├─< collaboration_shipments (CSP-)           寄送紀錄：INITIAL／RESEND，可選關聯既有 shipments(履約出貨)
   ├─1 collaboration_launch_details (CLD-)      開團合作資訊：意願、日期、連結、投廣、後台設定
   └─< collaboration_events (append-only)       處理歷程：dimension ∈ APPLICATION/COLLABORATION/SAMPLE/INTENT/CAMPAIGN/DATA

collaboration_import_rows (CIR-)  ── 匯入暫存：raw jsonb ＋ 對應結果 ＋ issues ＋ dedupe_key
```

全部沿用既有基礎設施：`organization_id` 多租戶、`deleted_at` 軟刪除＋`forbid_delete()`、`version` 樂觀鎖＋`touch_row()`、`audit_logs`、`events`（交易式 outbox）、`idempotency`、`id_counters`。`collaboration_events` 與 `audit_logs` 一樣是 append-only（`forbid_modify()`）。

關鍵資料庫層約束（不是只靠應用層檢查）：

| 約束 | 擋住什麼 |
|---|---|
| `collab_app_campaign_requires_confirm` | 還沒確認合作就塞 `campaign_id`（直接下 `UPDATE` 也會被擋，已用測試驗證） |
| `collab_app_hold_reason` | 暫緩沒寫原因 |
| `collab_item_approved_le_requested` / `_partial_needs_qty` / `_unavailable_zero` | 核准數量大於申請數量、供應狀態與數量不一致 |
| `collab_item_uq` | 同一申請重複送出長出重複明細 |
| `collab_ship_shipped_needs_date` / `_cancel_reason` / `_delivered_confirm` | 標已寄出卻沒寄出日、取消沒原因、標送達卻沒簽收 |
| `collab_ship_tracking_uq` | 同一組織重複的物流單號 |
| `collab_launch_intent_date` | 回覆了意願卻沒有回覆日期 |
| `collab_launch_ads_confirm` | 團主還沒表達投廣意願就先確認投廣 |

---

## 四、狀態機（四個維度，刻意不串成一條長鏈）

Owner 指令第五節明確要求：樣品狀態、物流狀態、開團意願、檔期狀態是**不同維度**。所以本模組不做單一狀態欄位。

```
① 申請狀態 application.status
   DRAFT ──▶ SUBMITTED ──▶ INTERNAL_REVIEW ──▶ VENDOR_REVIEW ──▶ APPROVED ──▶ CLOSED
                  └──────────────┴───────────────┬──────────────┘
                                                 ├──▶ REJECTED（終態）
                                                 ├──▶ CANCELLED（終態）
                                                 └──▶ ON_HOLD ──▶（回任一進行中狀態）

② 合作狀態 application.collaboration_status
   NOT_STARTED ──▶ SAMPLE_IN_PROGRESS ──▶ TRIAL_IN_PROGRESS ──▶ AWAITING_INTENT
                                                                   ├──▶ COLLABORATION_CONFIRMED ──▶ CAMPAIGN_LINKED
                                                                   └──▶ DECLINED

③ 物流狀態（每一列 collaboration_shipments 各走一次，互不干擾）
   PENDING ──▶ SHIPPED ──▶ DELIVERED
                  │           └──▶ RETURNED
                  └──▶ CANCELLED

④ 開團意願（collaboration_launch_details.intent）
   PENDING ⇄ WILLING / UNDECIDED / UNWILLING

   樣品進度：不存欄位。由 summarizeShipments() 從 ③ 的所有紀錄推導
             NOT_REQUESTED / PREPARING / SHIPPED / DELIVERED / RESEND_PENDING / RESENT / RETURNED
```

必須支援的平行情境（全部有測試）：

| 情境 | 系統怎麼表現 |
|---|---|
| 廠商分兩批寄 | 兩列寄送紀錄；補寄只有「真的填了寄出日期」才算已補寄；取消的補寄不算 |
| 團主試用後暫不決定 | 意願＝`UNDECIDED`，合作狀態停在 `AWAITING_INTENT`，不會被推進確認合作 |
| 樣品還沒寄就先談好預計開團日 | `planned_open_date` 可先填，`confirmed_open_date` 仍為空 |
| 一個檔期含多筆申請（多位團主同團） | 多筆申請關聯同一 `campaign_id`，不會重複建檔期 |
| 一個人代表多家廠商 | 以 `user_scopes` 的多個 VENDOR 範圍處理，只看得到自己代理的廠商 |

---

## 五、權限矩陣（全部在後端強制，不是前端藏按鈕）

沿用既有六種角色，**沒有第七種角色**。

| 權限 | SYSTEM_ADMIN | OPS_MANAGER | OPS_EDITOR | FINANCE | HOST | VENDOR |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| `collaboration.read` | ✅ | ✅ | ✅ | — | — | — |
| `collaboration.create` | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| `collaboration.update` | ✅ | ✅ | ✅ | — | — | — |
| `collaboration.review`（需核准權限的決策） | ✅ | ✅ | **—** | — | — | — |
| `collaboration.self`（只看自己的） | ✅ | — | — | — | ✅ | ✅ |
| `collaboration.vendor.review`（確認供樣） | ✅ | ✅ | ✅ | — | — | ✅ |
| `collaboration.shipping.write` | ✅ | ✅ | ✅ | — | — | ✅ |
| `collaboration.intent.write` | ✅ | ✅ | ✅ | — | ✅ | — |
| `collaboration.campaign.link` | ✅ | ✅ | ✅ | — | — | — |
| `collaboration.export` | ✅ | ✅ | ✅ | — | — | ✅（個資遮罩） |
| `collaboration.pii.read`（讀收件個資） | ✅ | ✅ | ✅ | **—** | — | — |

說明：

- **OPS_EDITOR 刻意沒有 `collaboration.review`**：需要核准權限的決策留給主管（Owner 指令第六節）。小編可以建立、編輯、代廠商確認供樣、代寄、關聯檔期，但不能做內部核准決策。
- **FINANCE 第一階段完全不開放**（11 項權限全無），尤其不會因為是財務就取得收件人電話與地址。FINANCE 呼叫列表會得到 403，不是空清單。
- **`collaboration.pii.read` 是第 11 項權限，超出指令列出的 10 項**，理由見第十一節 Owner 待確認事項。
- **欄位層級白名單**：團主只能寫意願與開團日期（`HOST_LAUNCH_FIELDS`）；廠商只能寫後台設定相關欄位（`VENDOR_LAUNCH_FIELDS`）；兩組不重疊，送出範圍外的欄位一律 403。
- **資料範圍**：團主只看自己（`host_id`）、廠商只看自己（`vendor_id`）、跨組織一律 404。讀別人的 id 與讀不存在的 id 回應完全相同（不洩漏存在性）。

---

## 六、三種視角

### 營運視角（`/collaboration`、`合作管理 → 網紅合作申請`）

- 分桶 KPI（待審核樣品／待寄出／待補寄／團主待回覆…）直接點進篩好的清單。
- 篩選：月份、廠商、團主、商品、申請狀態、合作狀態、寄送進度、開團意願、是否投廣、後台設定狀態、承辦人、**預計開團日區間**與**已確認開團日區間（分開兩組）**；搜尋與排序、分頁。
- 匯出表單一／表單二格式的 CSV（授權範圍內）。
- 收件個資**不在列表上**，要看必須進到案件裡按一下，而且每次讀取都寫稽核。
- 詳情頁六個區塊：申請資料／申請樣品明細／收件資訊／樣品寄送紀錄／開團合作資訊／處理歷程。

### 廠商視角（`/collaboration/vendor`、`廠商工作台 → 網紅申請與樣品寄送`）

七個分桶（依指令第七節 D）：待審核樣品、待寄出、已寄出、待補寄、團主待回覆、確認開團、已建立檔期。

頁面明講：「確認供樣只影響這裡的樣品流程，不等於公司的 G1～G5 核准，也不會自動建立檔期。」

廠商能做：逐項確認供樣數量、建立與編輯寄送紀錄（含補寄）、回填廠商後台連結與後台設定狀態、匯出（收件個資遮罩）。
廠商**不能**做：代替團主簽收、寫收件資料、寫開團意願、改申請主檔、讀稽核紀錄、看別家廠商的任何資料。

> ⛔ **廠商入口尚未對外開放。** 可以開發與測試，但在完成對外存取安全驗證前不得開放到正式／公開環境。

### 團主視角（`/collaboration/mine`、`團主工作台 → 我的樣品申請`）

手機可用（卡片式版面，實測 390px 寬無水平溢出）。可以申請樣品、確認／更新收件資訊、確認收件、回覆開團意願與預計開團日。看不到廠商後台連結、後台設定 Mail／狀態、內部備註、別的團主的任何資料。

建立申請時從團主主檔帶入基本資料，但**收件資訊必須重新確認**（地址會變，而且主檔本來就沒有地址欄位）。

---

## 七、個資與資安要求

| 要求 | 實作 |
|---|---|
| 收件人姓名、電話、地址視為個資 | 獨立資料表 `collaboration_recipients`，不混在申請主檔 |
| 只開放給授權角色 | 內部需 `collaboration.pii.read`；團主只能看自己的；廠商受四重條件限制 |
| 不覆寫團主主檔 | `hosts` 全表沒有任何地址欄位（已用測試固定）；改地址＝軟刪除舊列、新建一列，保留歷史 |
| 只在履約所需期間提供給廠商 | 廠商要同時滿足：① 未被清除 ② 申請已核准 ③ 團主已確認可用 ④ 未過保留期；任一不符就拒絕並記錄 |
| 讀取稽核 | 詳情 API **完全不回傳**收件內容；必須走 `GET /api/collaboration/applications/:id/recipient`，每次成功讀取寫一筆 `collaboration.recipient.read`，被拒絕則寫 `RECIPIENT_READ_DENIED` 事件 |
| 保留政策 | 核准日起算 90 天；一旦樣品送達，改以**最後寄送日**起算 30 天，取較早者。核准、送達、新增寄送（含補寄）、修改寄出日時都會重算 |
| 到期清除 | `POST /api/collaboration/recipients/purge-expired`（僅 SYSTEM_ADMIN）把值覆寫成「［已清除］」，不是只做軟刪除 |
| 匯出遮罩 | 沒有 `collaboration.pii.read` 的人匯出時，收件人／電話／地址三格一律是 `［無權限］`（欄位still在，內容不給）。廠商刻意有 `export` 但沒有 `pii.read`，所以這條路徑真的會被走到、也真的被測到 |
| 備註欄防呆 | 意願備註、投廣備註、廠商備註、收件備註都過 `assertNoPii()`，避免把個資塞進自由欄位 |
| 不自動寄信 | 「後台設定 Mail」只是記錄聯絡信箱；本模組不產生任何通知（已用測試固定 `notifications` 筆數不變） |

哨兵測試：測試用固定字串（`SENTINEL-收件人-ABC`、`0900111222`、`SENTINEL-地址-…`）灌進資料，再掃描每一條不該出現個資的 API 回應與 CSV；出現即失敗。

---

## 八、與既有 ERP 的關係

| 既有能力 | 怎麼處理 | 為什麼 |
|---|---|---|
| 團主主檔 `hosts` | **重用** `host_id`，團主詳情頁新增「網紅合作申請與樣品」區塊 | 不建第二份團主名單 |
| 廠商 `vendors`／商品 `products`／規格 `skus` | **重用**；廠商頁新增統計區塊、商品頁新增樣品申請歷史 | 不建第二份廠商或商品主檔 |
| 履約出貨 `fulfillment_batches` + `shipments` | **不能重用**（`campaign_id` NOT NULL，沒開團就寄不了樣）。有檔期時以 `fulfillment_shipment_id` 選填關聯回去 | |
| SOP 03 商品試用 `product_trials` | **只以 `trial_id` 選填引用**，不混為同一狀態機；一般樣品申請**不等於**已完成 SOP 03 的正式試用資格評估，也不會改試用結論／覆核／有效期 | 指令第二節紅線第 7 條 |
| 任務 `tasks` | **不能重用**（`campaign_id` NOT NULL，且只由流程模板批次產生，沒有通用 createTask）。改以衍生的工作佇列（分桶）呈現，**不另建平行任務引擎**（已用測試固定 `tasks` 筆數不變） | 指令第八節 |
| 檔期 `campaigns` | 只在合作確認後**關聯既有檔期**；不新建檔期、不改檔期狀態、不重複建檔期 | |
| G1～G5 `approvals` + `modules/gates.ts` | **完全不碰**。`linkCampaign` 回傳與稽核都明寫 `gateImpact: 'NONE'` | 指令第二節紅線第 3 條 |
| 庫存、訂單、財務、佣金結算 | **完全不碰**（已用測試固定四張表筆數前後不變） | 指令第二節紅線第 5 條 |
| `audit_logs`／`events`／`idempotency`／多租戶／軟刪除／樂觀鎖 | **全部重用** | |

---

## 九、匯入與匯出格式

### 匯入（三步，`/collaboration/import`，僅內部營運）

```
① 上傳預覽  ─▶ 依標題列自動對應欄位；每一列產生 collaboration_import_rows
                阻斷性問題 → 標 NEEDS_REVIEW 並寫入 import_errors
② 逐列確認  ─▶ 人工指定團主／商品／規格，或跳過該列（系統不替人猜）
③ 建立申請  ─▶ 只處理 RESOLVED 的列；NEEDS_REVIEW 與 SKIPPED 一律略過
```

| 指令列出的狀況 | 怎麼處理 |
|---|---|
| 同一團主不同名稱 | 以正規化名稱找唯一相符；多個候選 → `HOST_AMBIGUOUS`（阻斷，等人工指定） |
| 同一廠商多筆申請 | 正常，各自一筆申請單 |
| 團主名稱沒有對應 Host ID | `HOST_NOT_FOUND`（阻斷）；**不自動建立團主主檔** |
| 同一商品不同規格 | `sku_id` 分列；對應不到 → `SKU_UNRESOLVED` |
| 缺配送日期 | `SHIP_DATE_UNREADABLE`（非阻斷）；**不建立寄送紀錄**，不補假日期 |
| 缺開團意願 | `INTENT_UNREADABLE`（非阻斷）；維持「待回覆」 |
| 有開團日期但沒有正式檔期 | `CAMPAIGN_NOT_LINKED`（非阻斷）；只留預計日期，不自動建檔期 |
| 有開團連結但找不到對應 Campaign | 同上，只留連結 |
| 收件資訊不完整 | `RECIPIENT_INCOMPLETE`（非阻斷）；**不建立收件資料** |

防重複：`import_batches.checksum`（同一檔案不能匯第二次，回 409）＋ `collaboration_import_rows.dedupe_key`（唯一索引）＋ 建立前再查一次 `collaboration_applications.dedupe_key`。冪等鍵只取來源列欄位，所以事後人工修正對應不會改變鍵值。

### 匯出

兩種格式都支援（`?form=form1` / `?form=form2`），欄位順序與來源表單一致，含 UTF-8 BOM 以便 Excel 直接開。沒有 `collaboration.pii.read` 的人拿到的收件人／電話／地址是 `［無權限］`。

---

## 十、UAT 測試案例與實際結果

指令第十節列的 20 項全部有自動化測試覆蓋：

| # | 案例 | 覆蓋位置 |
|---|---|---|
| 1 | 營運建立申請 | `tests/collaboration.test.ts` 完整流程 |
| 2 | 團主自己建立（HOST_FORM） | 三種建立來源 |
| 3 | 廠商代團主建立（VENDOR_FORM） | 三種建立來源 |
| 4 | 一個人代表多家廠商 | 三種建立來源 |
| 5 | 一筆申請多個 SKU | 三種建立來源 |
| 6 | 首次寄送＋補寄 | 樣品寄送群組 |
| 7 | 廠商部分供樣 | 單元測試 `supplyStatusFor` ＋ 整合測試 |
| 8 | 寄樣前先確認預計開團日 | 平行情境群組 |
| 9 | 團主回覆不開團 | 平行情境群組 |
| 10 | 意願待回覆 | 平行情境群組 |
| 11 | 轉為正式檔期關聯 | 檔期關聯群組 |
| 12 | 一檔期多筆申請 | 檔期關聯群組 |
| 13 | 重複建立／重複匯入防護 | 冪等鍵＋唯一索引測試 |
| 14 | 團主讀不到別的團主 | `tests/collaboration-rbac.test.ts` 資料範圍 |
| 15 | 廠商讀不到別家廠商 | 資料範圍 |
| 16 | 未授權 API／CSV 不洩個資 | 收件個資＋匯出遮罩群組（哨兵字串） |
| 17 | 廠商不能核准 G1～G5 | G1～G5 不受影響群組 |
| 18 | 未授權不能改寄送紀錄 | 越權寫入群組 |
| 19 | 稽核完整 | 稽核與事件 append-only 群組 |
| 20 | 既有選品／試用／物流／結算回歸 | 既有 60 個測試檔全綠 ＋ 無副作用測試 |

實跑結果（2026-11-06，本機 PostgreSQL 16）：

| 檢查 | 指令 | 結果 |
|---|---|---|
| 型別 | `npm run typecheck` | ✅ exit 0 |
| Lint | `npm run lint` | ✅ 無任何告警 |
| 單元＋整合測試 | `npm run test` | ✅ **60 檔 / 1039 項全過**（本模組新增 32＋26＋44＝102 項） |
| 建置 | `npm run build` | ✅ exit 0，6 條 `/collaboration*` 路由都進得去 |
| Migration 升級演練 | `npm run db:rehearsal` | ✅ **20/20**；028 套在舊版（001～017）資料庫上，舊資料筆數與每個欄位前後完全相同 |
| 瀏覽器煙霧測試 | `npm run e2e` | ✅ **170/170**（含本模組 17 項） |
| 瀏覽器全流程 | `npm run e2e:flow` | ✅ **71/71**；§13 完整流程只用畫面跑完，三種角色各自登入自己的工作台 |
| DEMO 種子 | `npm run db:seed:demo:collaboration` | ✅ 6 筆申請、4 筆寄送紀錄（含補寄），冪等、拒絕 production |

截圖：`docs/uat/screens/40~45-collaboration-*.png`（煙霧測試）、`flow-19~22-collaboration-*.png`（全流程）。

---

## 十一、Owner 待確認事項（第一輪的假設；Owner 已於 2026-11-06 裁示，結果見第十二節）

| # | 事項 | 現在怎麼做 | 要 Owner 決定什麼 |
|---|---|---|---|
| 1 | 第 11 項權限 `collaboration.pii.read` | 指令列了 10 項權限，我多加這一項把「讀收件個資」和「讀案件」分開 | 接受這個拆法，或改回由 `collaboration.read` 一併涵蓋 |
| 2 | 廠商有 `collaboration.export` | 廠商可匯出，但收件個資一律遮罩 | 要不要乾脆不給廠商匯出 |
| 3 | OPS_EDITOR 的資料範圍是全組織 | 與 `campaignScope` 不同（那支會限制到承辦檔期） | 小編是否該只看自己承辦的申請 |
| 4 | 保留期 90 天／30 天 | 核准起算 90 天、送達起算 30 天，取較早者 | 這兩個數字是否符合公司政策 |
| 5 | 「後台設定 Mail」的解讀 | 解讀為「設定聯絡信箱＋設定狀態」兩個欄位，不自動寄信 | 原意是否如此 |
| 6 | 任務無法重用 | `tasks.campaign_id` NOT NULL 且只由流程模板產生，所以改用衍生分桶 | 是否要另開需求讓 tasks 支援無檔期任務 |
| 7 | **repo 目前是 public** | `ws19135/group-buying-operations` `isPrivate: false`，description「團購報告」 | 這個模組會存真實收件個資。**放正式資料前必須先把 repo 轉成 private** |
| 8 | 廠商入口對外開放 | 已開發、已測試，但未對外開放 | 完成對外存取安全驗證後才可開放 |


---

## 十二、Owner 決策 D-37～D-44 與第二輪加固（2026-11-06）

> 第二輪**不重新開發**已完成的合作申請功能，只依 Owner 決策調整權限、個資與入口安全。migration 029；**不改已套用的 028**。全部只用 DEMO／虛構資料，未部署、未碰正式資料。

### 12.1 決策與落地

| 決策 | Owner 裁示 | 落地 |
|---|---|---|
| D-37 個資權限 | 保留獨立 `collaboration.pii.read`；一般案件讀取不含收件人姓名、電話、完整地址；團主只看自己的；廠商經「受控的履約例外」；所有個資存取留稽核 | 廠商只在**履約視窗**內可讀地址（核准、團主已確認、未清除、未超過 180 天硬性上限、且還有待寄出的寄送或補寄）；寄出、暫緩、結案後關閉；稽核記錄用途 |
| D-38 廠商匯出 | 可匯出自己範圍的申請紀錄，不含電話與完整地址；不得由其他途徑取得 | 廠商表單二**沒有**收件人／電話／地址欄位；19 條讀取端點哨兵掃描；搜尋不是旁路 |
| D-39 小編範圍 | 只看自己承辦或被正式指派的申請；主管看全部；要有交接、共同承辦、待指派佇列 | `collaboration_assignments／handovers`；`collaborationScope` 改版；待指派佇列、認領、指派、交接、釋出、共同承辦、整批交接；承辦人停用自動回佇列 |
| D-40 保留與清除 | 90 天／送達後 30 天取較早；檢視衝突；例外需依據與期限；要有機制、紀錄、監控；未授權不得開排程；評估備份 | 衝突 C1～C8、`evaluatePurge`、保留例外、180 天硬性上限、執行與失敗紀錄、監控頁、`collab:purge`；**沒有排程**；備份評估見 SECURITY_REVIEW §7.4 |
| D-41 後台設定 Mail | 兩個欄位；不自動寄信、不建立通知 | 維持，測試固定 |
| D-42 無檔期任務 | 不改 `tasks` 的 Campaign 綁定 | 維持，測試固定 |
| D-43 Repo 安全 | 建議轉 Private；先評估影響；出報告；不得假設 Private＝安全；可見性需授權 | `REPO_SECURITY_REPORT.md`；**未更改可見性** |
| D-44 廠商入口 | 先完成安全 Gate 才可開放 | Gate 技術檢查通過；**仍未對外開放**（SECURITY_REVIEW §7.5） |

### 12.2 承辦與交接（D-39）

- **誰看得到什麼**：管理者、主管＝全部；小編＝自己承辦（主要）或被指派共同承辦；團主、廠商不變；財務不變（零）。
- **待指派佇列**：沒有「有效主要承辦人」的案件（未指派，或主要承辦人已停用）。主管看完整案件並可指派；小編只看**非個資摘要**並可自行認領（認領前讀不到內容與收件資料）。畫面：`/collaboration` 上方的「待指派佇列」卡片；案件詳情的「承辦與交接」區塊（指派／交接、加入共同承辦、釋出、交接紀錄）。
- **預設**：小編建立或匯入的案件自己承辦；主管建立未指定、團主或廠商自助建立的進佇列。
- **交接規則**：已有承辦人時交接必須填原因；承辦人只能經交接端點變更；每次異動寫 append-only 交接紀錄、案件事件與稽核；不產生通知。

### 12.3 個資保留與清除（D-40）

| 項目 | 規則 |
|---|---|
| 暫定政策 | 核准日起 90 天；送達後依最後寄送日起 30 天；取較早者（常數在 `lib/collaboration-rules.ts`） |
| 履約未結束 | 到期也**延後**清除：尚未寄出首次樣品、補寄待寄出、已寄出但未確認收件、退回未決定、申請暫緩 |
| 硬性上限 | 核准後 **180 天**一律強制清除（除非有保留例外）；廠商讀取也在上限後拒絕，不依賴排程 |
| 保留例外 | 事由（爭議／法定保存義務／退回退款處理／Owner 核准）＋依據（≥10 字、不可含個資）＋到期日（**最長 365 天**，資料庫 CHECK）；到期自動失效、可提前解除；建立與解除寫稽核；只阻止清除，不擴大讀取權限 |
| 紀錄與失敗 | 每次執行一筆 run、逐筆結果（`PURGED／PURGED_HARD_CAP／SKIPPED_HOLD／SKIPPED_FULFILMENT／FAILED／WOULD_PURGE`）；單筆失敗不回滾整批 |
| 監控 | `/collaboration/retention`：已到期、逾期超過 7 天、上次結果、生效中的例外；警示 `NEVER_RUN／LAST_RUN_FAILED／OVERDUE_BACKLOG`（本系統不自動發通知） |
| 排程 | **沒有**。人工、API 或 `npm run collab:purge`（預設試跑）；`APP_ENV=production` 預設拒絕，需 Owner 書面授權 |
| 其他清除 | 被取代的舊地址立即清空；匯入暫存列與匯入錯誤紀錄的個資在建立申請單／跳過後立即清、逾 30 天清 |
| 備份 | 評估與建議見 SECURITY_REVIEW §7.4；還原後必須先執行清除再開放（`BACKUP_RESTORE_RUNBOOK.md`） |

### 12.4 待 Owner 確認（延續 KNOWN_ISSUES W-41～W-48）

1. **放真實個資前**必須決定清除如何運作：授權正式排程，或建立人工清除 SOP（W-42）。
2. 備份保存期與異地備份（W-41）。
3. 90／30／180 天與「寄出即關閉廠商讀取」是否符合公司政策；被拒絕／取消申請的保留（W-44、W-45）。
4. Repo 轉 Private 與個人信箱曝光（W-33、W-46）。
5. 廠商入口開放前：MFA 評估、帳號開通／撤銷程序、第三方滲透測試、真實主機驗證（W-35、W-43、W-47）。
