# 畫面清單（Screen Inventory）

> 依據 `src/app/**` 實際路由整理（37 個頁面路由＋SOP 01 新增 3 個＝40 個，`/api/[...path]` 為 API；表中 #38–#40 為 SOP 01 新增；`/orders` 等較早新增的路由若未列入，以 `src/app/**` 為準）。
> 角色縮寫：**管理者**＝SYSTEM_ADMIN、**主管**＝OPS_MANAGER、**小編**＝OPS_EDITOR、**財務**＝FINANCE、**團主**＝HOST、**廠商**＝VENDOR。
> 「可進入」以後端權限為準（`src/server/lib/permissions.ts`）；沒有權限的角色看不到導覽項，直接輸入網址會顯示「你沒有權限檢視此頁」。
> 「功能」欄是功能名稱，與 SRS 的 FR 編號對照由 SRS 文件負責。
> 階段：P1＝Phase 1 MVP；P2＝Phase 2 切片（履約、售後、財務、SOP 01 客群分析與商品適配，均為 DEMO，口徑待確認）。

## 1. 全站共用

| 項目 | 說明 |
|---|---|
| 版型 | 左側導覽（依權限動態顯示，分「營運／主檔／財務／資料與監控／系統」）＋頂列（通知鈴＋未讀數、使用者名稱與角色徽章、登出） |
| 保護 | `(app)/layout.tsx` 呼叫 `requireActor()`：未登入導到 `/login`；每頁再依權限檢查 |
| 無權限 | 顯示「你沒有權限檢視此頁」＋「回到首頁」（HTTP 狀態碼為 200，見 AS_BUILT_SCREENS 的發現） |
| 找不到／越權 | 團主／廠商存取範圍外資料回 404 語意（不洩漏資料是否存在） |
| 資料品質 | 數字頁會顯示 DEMO／無資料／匯入中的橫幅 |

## 2. 路由總表

| # | 路由 | 用途 | 可進入 | 主要區塊 | 主要 API | 主要操作 | 空狀態／錯誤／無權限 | 功能 | 階段 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `/login` | 登入 | 未登入者 | 帳密表單、錯誤橫幅 | `POST /api/auth/login` | 登入 | 錯誤訊息（帳密錯誤／鎖定／過多請求） | 身分驗證 | P1 |
| 2 | `/` | 首頁導向 | 已登入 | — | — | 依角色轉到 `/dashboard`、`/dashboard/host` 或 `/campaigns` | — | 導覽 | P1 |
| 3 | `/dashboard` | 營運總覽 | 管理者、主管、小編、財務 | 資料品質橫幅、KPI 卡、檔期管線、未來 30 天、逾期任務、團主績效、廠商進度 | `GET /api/dashboard/admin`（頁面直接呼叫同一服務層）；KPI 來自 `kpi.ts` | 點項目進檔期 | 各區塊有空狀態；無業績權限顯示說明橫幅；目標達成率僅敏感權限可見 | 管理者儀表板 | P1 |
| 4 | `/dashboard/host` | 團主總覽 | 團主 | 待回覆邀請、待辦、我的檔期、60 天行事曆、結算進度、試用品／素材狀態 | `GET /api/dashboard/host`；`POST /api/campaigns/:id/hosts/:hostId/respond` | 接受／婉拒邀請 | 各區塊空狀態 | 團主儀表板 | P1 |
| 5 | `/campaigns` | 檔期清單 | 全部角色（依範圍） | 篩選列、檔期表、分頁 | `GET /api/campaigns` | 篩選、建立檔期 | 「沒有符合條件的檔期」 | 檔期管理 | P1 |
| 6 | `/campaigns/new` | 建立檔期 | 管理者、主管、小編 | 建立表單（廠商、商品、日期、目標） | `POST /api/campaigns` | 建立（草稿） | 表單驗證錯誤；目標欄位僅敏感權限顯示 | 檔期管理 | P1 |
| 7 | `/campaigns/[id]` | 檔期詳情 | 全部角色（依範圍） | 動作列、下一步提示、分頁：概覽／任務／商品／團主與曝光／核准與關卡（G1 區有唯讀的適配評估提示）／**客群適配（SOP 01）**／異動紀錄 | `GET/PATCH /api/campaigns/:id`；`POST …/status`；`POST …/reschedule`（預覽與確認共用，`confirm:true` 才寫入）；`…/products`；`…/hosts`；`…/placements`；`…/gates/:gate/request`；`POST /api/tasks/:id/status` | 狀態推進／退回／暫緩／取消、調整日期、加商品、邀請團主、排曝光、完成任務、申請核准 | 各分頁空狀態；越權 404 | 檔期、流程、狀態機、衝突 | P1 |
| 8 | `/calendar` | 排程日曆 | 全部角色（依範圍） | 檔期時間軸、曝光安排（未來 90 天） | （頁面直接呼叫 `loadCalendar`，無獨立 API） | 檢視、點進檔期 | 「未來 90 天沒有…」 | 排程 | P1 |
| 9 | `/tasks` | 任務清單 | 全部角色（依範圍） | 篩選列、任務表、分頁 | `GET /api/tasks` | 篩選、點進檔期 | 「沒有符合條件的任務」 | 任務管理 | P1 |
| 10 | `/approvals` | 核准 | 管理者、主管、小編、財務 | 篩選、申請表、系統檢查、決定表單 | `GET /api/approvals`；`POST /api/approvals/:id/decision` | 核准／退回／拒絕（依關卡角色） | 「沒有核准申請」；非核准角色無按鈕 | G1–G5 核准關卡 | P1 |
| 11 | `/vendors` | 廠商清單 | 管理者、主管、小編、財務、廠商（僅自己） | 篩選、表格 | `GET /api/vendors` | 新增、進詳情 | 「沒有符合條件的廠商」 | 廠商主檔 | P1 |
| 12 | `/vendors/new` | 新增廠商 | 管理者、主管、小編 | 表單 | `POST /api/vendors` | 建立 | 驗證錯誤；統編重複提示 | 廠商主檔 | P1 |
| 13 | `/vendors/[id]` | 廠商詳情 | 同上 | 基本資料、聯絡人、商品、合作檔期 | `GET/PATCH /api/vendors/:id`；`…/contacts`；`…/archive` | 編輯、新增聯絡人、封存 | 各區塊空狀態；別家廠商 404 | 廠商主檔 | P1 |
| 14 | `/hosts` | 團主清單 | 管理者、主管、小編、財務（唯讀）、團主（自己） | 篩選、表格 | `GET /api/hosts` | 新增、進詳情 | 「沒有團主」 | 團主主檔 | P1 |
| 15 | `/hosts/new` | 新增團主 | 管理者、主管、小編 | 表單 | `POST /api/hosts` | 建立 | 驗證錯誤 | 團主主檔 | P1 |
| 16 | `/hosts/[id]` | 團主詳情 | 同上 | 基本資料（含合作對象類型）、所屬社群、可承接／不可承接、**客群分析（SOP 01，需 segment.read）**、歷史團購 | `GET/PATCH /api/hosts/:id`；`…/communities`；`…/availability`；`…/archive`；`GET/POST /api/hosts/:id/segments`；`PATCH /api/segment-links/:id`；`POST …/end` | 編輯、連結社群、設定可承接、封存 | 空狀態；他人 404 | 團主主檔、承接條件 | P1 |
| 17 | `/communities` | 社群清單 | 管理者、主管、小編、財務、團主 | 表格 | `GET /api/communities` | 新增、進詳情 | 「沒有社群」 | 社群主檔 | P1 |
| 18 | `/communities/new` | 新增社群 | 管理者、主管、小編 | 表單 | `POST /api/communities` | 建立 | 驗證錯誤 | 社群主檔 | P1 |
| 19 | `/communities/[id]` | 社群詳情 | 同上 | 團主與管理者、社群資料、開團安排與曝光紀錄 | `GET/PATCH /api/communities/:id` | 編輯 | 空狀態 | 社群主檔 | P1 |
| 20 | `/products` | 商品清單 | 全部角色（廠商只看自己） | 篩選、表格 | `GET /api/products` | 新增、進詳情 | 「沒有商品」 | 商品主檔 | P1 |
| 21 | `/products/new` | 新增商品 | 管理者、主管、小編 | 表單（成本欄位僅有成本權限者顯示） | `POST /api/products` | 建立 | 驗證錯誤 | 商品主檔 | P1 |
| 22 | `/products/[id]` | 商品詳情 | 同上 | 商品資料、素材與文件連結、規格（SKU）、**候選團主適配（SOP 01，需 fit.read）** | `GET/PATCH /api/products/:id`；`POST …/assets`、`…/skus`、`…/review`；`PATCH /api/skus/:id` | 編輯、加素材連結（限 http/https）、加規格、送審／核准 | 「尚無素材」「尚無規格」；成本僅 product.cost.read | 商品、SKU、審核 | P1 |
| 23 | `/imports` | 訂單匯入 | 管理者、主管、小編、財務（唯讀） | 欄位說明、匯入表單、匯入批次、錯誤列 | `POST /api/imports`；`GET /api/imports`；`GET /api/imports/:id/errors`；`POST /api/import-errors/:id/resolve` | 匯入 CSV、標記錯誤已處理 | 「尚無匯入紀錄」「沒有錯誤列」；重複檔案被擋 | 訂單匯入 | P1 |
| 24 | `/exceptions` | 例外 | 管理者、主管、小編、財務（唯讀） | 篩選、例外表 | `GET /api/exceptions`；`POST /api/exceptions/:id/status` | 認領、結案 | 「沒有符合條件的例外」 | 例外管理 | P1 |
| 25 | `/automation` | 自動化中心 | 管理者、主管 | 八個工作（啟停、立即執行）、執行紀錄 | `GET /api/automation/jobs`、`/api/automation/runs`；`POST /api/automation/jobs/:key` | 啟用／停用、執行 | 「尚無執行紀錄」；預設全部停用 | 自動化 | P1 |
| 26 | `/notifications` | 通知 | 全部角色（自己的） | 通知列表 | `GET /api/notifications`；`POST …/:id/read` | 標示已讀 | 「沒有通知」 | 站內通知 | P1 |
| 27 | `/audit` | 稽核紀錄 | 管理者、主管、財務 | 篩選、紀錄表（前後值） | `GET /api/audit` | 篩選、檢視 | 「沒有符合條件的紀錄」 | 稽核 | P1 |
| 28 | `/users` | 使用者管理 | 管理者 | 使用者表、新增表單 | `GET/POST /api/users`；`POST /api/users/:id/status` | 新增、停用／啟用 | 「沒有使用者」 | 使用者與角色 | P1 |
| 29 | `/fulfillment` | 履約與出貨 | 全部角色（團主／廠商唯讀、依範圍） | 分頁：出貨批次／庫存；規格庫存、異動 | `GET /api/fulfillment/batches`；`GET /api/inventory/stock`、`/api/inventory/movements`；`POST /api/inventory/movements`、`…/:id/correct` | 新增批次、庫存調整與更正 | 「還沒有出貨批次」「沒有符合的規格」 | 履約、庫存 | P2 |
| 30 | `/fulfillment/[id]` | 出貨批次詳情 | 同上 | 批次資料、提醒、出貨單表 | `GET/PATCH /api/fulfillment/batches/:id`；`POST …/shipments`；`POST /api/fulfillment/shipments/:id/status`、`…/receipt`；`PATCH …/shipments/:id`；`POST …/batches/:id/cancel` | 新增出貨單、已包裝／出貨／送達／簽收／異常、取消批次 | 「這個批次還沒有出貨單」 | 履約、簽收 | P2 |
| 31 | `/aftersales` | 售後案件清單 | 全部角色（團主／廠商唯讀摘要） | 總覽卡片、篩選、案件表 | `GET /api/aftersales/cases`；`GET /api/aftersales/overview` | 篩選、新增案件 | 「沒有符合條件的案件」 | 售後案件 | P2 |
| 32 | `/aftersales/new` | 新增售後案件 | 管理者、主管、小編 | 表單（提醒不填個資） | `POST /api/aftersales/cases` | 建立 | 驗證錯誤 | 售後案件 | P2 |
| 33 | `/aftersales/[id]` | 案件詳情 | 同上 | 案件資料、處理紀錄、退款申請 | `GET/PATCH /api/aftersales/cases/:id`；`POST …/notes`、`…/refunds`、`…/status` | 改狀態、新增備註、申請退款 | 「尚無處理紀錄」「尚無退款申請」；內部備註僅內部角色 | 售後、退款 | P2 |
| 34 | `/aftersales/refunds` | 退款申請清單 | 管理者、主管、小編、財務（團主／廠商唯讀） | 篩選、退款表 | `GET /api/aftersales/refunds`；`POST …/:id/decision`；`…/:id/complete` | 核准／退回（主管）、完成退款（財務，可選寫回訂單） | 「沒有符合條件的退款申請」 | 退款核准 | P2 |
| 35 | `/finance` | 財務結算 | 管理者、主管（唯讀）、財務 | 分頁：各檔期／結算／入帳付款／發票／費用；開立試算 | `GET /api/finance/overview`、`/api/settlements`、`/api/payments`、`/api/invoices`、`/api/expenses`；`POST /api/settlements`；入帳／發票／費用的新增與作廢（不刪除） | 開立結算試算、新增入帳／發票／費用、核對入帳 | 各分頁「尚無…」 | 財務、入帳、發票、費用 | P2 |
| 36 | `/finance/settlements/[id]` | 結算試算詳情 | 同上 | 警示橫幅、試算資訊、合計、團主項目、調整項紀錄 | `GET /api/settlements/:id`；`…/recalculate`；`…/confirm`；`…/void`；`…/adjustments`；`/api/settlement-items/:id/override` | 重新試算、確認、作廢、覆寫、調整 | 「沒有團主項目」「沒有調整項」；確認僅財務／管理者 | 結算試算 | P2 |
| 37 | `/finance/mine` | 我的結算 | 團主 | 固定警示、已確認結算表 | `GET /api/settlements/mine` | 檢視 | 「目前沒有已確認的結算」 | 團主結算檢視 | P2 |
| 38 | `/segments` | 客群清單 | 管理者、主管、小編（segment.read） | 篩選（關鍵字、年齡層、家庭型態）、客群表（依據、連結團主數、證據數）、新增客群 | `GET/POST /api/segments` | 新增、進詳情 | 「還沒有客群」；團主／廠商／財務 403 語意（顯示無權限） | 客群分析（FR-SEG-01） | P2 |
| 39 | `/segments/[id]` | 客群詳情 | 同上 | 客群輪廓、連結的團主、研究證據、版本與變更紀錄 | `GET/PATCH /api/segments/:id`；`POST …/archive`、`…/evidence`；`POST /api/segment-evidence/:id/remove` | 編輯（含偏好）、新增／移除證據、封存（軟刪除；仍有團主連結時不可封存） | 「尚無團主連結」「尚無證據（顯示為未知）」；他組織 404 | 客群、證據、版本（FR-SEG-01～05） | P2 |
| 40 | `/fit` | 客群適配總覽 | 管理者、主管、小編（fit.read；覆核需 fit.review；設定需 fit.config） | 評分設定橫幅、分頁（待覆核／已覆核／全部／評分設定）、評估表、尚未建立客群分析的團主 | `GET /api/fit`、`/api/fit/overview`、`/api/fit/config`；`PUT /api/fit/config`；`POST /api/fit/:id/review` | 覆核、調整評分設定、前往建立客群分析 | 「沒有待覆核的評估」；檔期層級評估依檔期資料範圍 | 商品適配、覆核（FR-FIT-01～08） | P2 |

## 3. 角色 × 導覽項

| 導覽項 | 管理者 | 主管 | 小編 | 財務 | 團主 | 廠商 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| 總覽 | ✓ | ✓ | ✓ | ✓ | ✓（團主版） | — |
| 檔期／排程日曆／任務 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 核准 | ✓ | ✓ | ✓ | ✓ | — | — |
| 售後／履約出貨 | ✓ | ✓ | ✓ | ✓（唯讀＋完成退款） | ✓（唯讀） | ✓（唯讀） |
| 廠商 | ✓ | ✓ | ✓ | ✓（唯讀） | — | ✓（自己） |
| 團主 | ✓ | ✓ | ✓ | ✓（唯讀） | ✓（自己；看不到客群分析） | — |
| 社群 | ✓ | ✓ | ✓ | ✓（唯讀） | ✓（唯讀） | — |
| 商品 | ✓ | ✓ | ✓ | ✓ | ✓（唯讀） | ✓（自己） |
| 客群（SOP 01） | ✓ | ✓ | ✓ | — | — | — |
| 客群適配（SOP 01） | ✓ | ✓（可覆核、改設定） | ✓（可評估，不可覆核） | — | — | — |
| 財務結算 | ✓ | ✓（唯讀） | — | ✓ | — | — |
| 我的結算 | — | — | — | — | ✓ | — |
| 訂單匯入／例外 | ✓ | ✓ | ✓ | ✓（唯讀） | — | — |
| 自動化 | ✓ | ✓ | — | — | — | — |
| 稽核 | ✓ | ✓ | — | ✓ | — | — |
| 使用者 | ✓ | — | — | — | — | — |

## 4. 尚未有畫面的功能（規格內但未實作）

| 功能 | 原因 |
|---|---|
| 廠商入口（廠商自助填寫／回填） | 涉及對外存取，Owner 尚未解凍 |
| 公開進件表單 | 同上；目前只有內部登入者可送進件 |
| 密碼重設、SSO／MFA | 尚未決定身分機制（KNOWN_ISSUES K1） |
| 訂單明細頁、趨勢圖 | 未列入 Phase 1／2 範圍 |
| 通知偏好設定、真實 LINE／Email | 缺憑證與授權 |
