# 線框圖（Wireframes）

> 低擬真、灰階，只表達**版面區塊、資料來源、互動與角色差異**，不代表最終視覺。
> 每張圖上的黑色圓圈編號，對應下方同編號的說明表。實際畫面見 [AS_BUILT_SCREENS.md](AS_BUILT_SCREENS.md)，全部路由見 [SCREEN_INVENTORY.md](SCREEN_INVENTORY.md)。
> 這些線框圖是**依已實作的畫面整理的現況線框**（先有系統、後補線框），用途是讓團隊與顧問討論調整方向；要改版時請先改線框、再改畫面。
> 全部資料皆為示意，不含任何真實資料。圖中「〔…〕」是會被實際資料取代的位置。

| 圖 | 畫面 | 階段 |
|---|---|---|
| [01-login](#01-login) | 登入 | P1 |
| [02-dashboard-admin](#02-dashboard-admin) | 管理者儀表板 | P1 |
| [03-campaigns](#03-campaigns) | 檔期清單 | P1 |
| [04-campaign-detail](#04-campaign-detail) | 檔期詳情（概覽／任務／核准） | P1 |
| [05-reschedule](#05-reschedule) | 日期重排預覽 | P1 |
| [06-approvals](#06-approvals) | 核准頁 | P1 |
| [07-tasks](#07-tasks) | 任務清單 | P1 |
| [08a-vendor-detail](#08a-vendor-detail) | 廠商詳情 | P1 |
| [08b-host-detail](#08b-host-detail) | 團主詳情 | P1 |
| [09-imports](#09-imports) | 訂單匯入 | P1 |
| [10-fulfillment-batch](#10-fulfillment-batch) | 履約批次詳情 | P2 |
| [11-aftersales-case](#11-aftersales-case) | 售後案件詳情與退款核准 | P2 |
| [12-settlement-detail](#12-settlement-detail) | 財務結算詳情 | P2 |
| [13-host-my-settlements](#13-host-my-settlements) | 團主「我的結算」 | P2 |
| [14-notifications](#14-notifications) | 通知中心 | P1 |
| [16-host-segments](#16-host-segments) | 團主詳情：客群分析 | P2（SOP 01） |
| [17-product-fit](#17-product-fit) | 商品頁：候選團主適配 | P2（SOP 01） |
| [18-fit-overview](#18-fit-overview) | 客群適配總覽 | P2（SOP 01） |
| [19-vendor-diligence](#19-vendor-diligence) | 廠商詳情：合作資格審查與調查詳情 | P2（SOP 02） |
| [20-product-selection](#20-product-selection) | 商品詳情：選品評估、商品試用、商業可行性 | P2（SOP 02／03） |
| [21-campaign-g1-summary](#21-campaign-g1-summary) | 檔期：選品與試用（G1 決策摘要） | P2（SOP 02／03） |
| [22-trial-detail](#22-trial-detail) | 試用詳情：四大面向檢核、結論與覆核 | P2（SOP 03） |

## 01-login
**登入**（P1）　現況畫面：`screens/anon-login.png`

![登入](./01-login.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | 登入卡片 | — | 未登入造訪任何受保護頁面都會導到此頁 | 全部角色共用 |
| 2 | Email 欄位 | users.email（不分大小寫） | 必填、email 格式驗證 | — |
| 3 | 密碼欄位 | users.password_hash（scrypt） | 必填；不顯示密碼；不提供「忘記密碼」（尚未實作，見 KNOWN_ISSUES K1） | — |
| 4 | 登入按鈕 | POST /api/auth/login | 成功 → 導向角色首頁（團主 /dashboard/host，其他 /dashboard）；處理中按鈕停用 | — |
| 5 | 錯誤橫幅 | API 錯誤訊息 | 帳密錯誤統一訊息（不洩漏帳號是否存在）；多次失敗鎖定；過多請求回 429 | — |

## 02-dashboard-admin
**管理者儀表板**（P1）　現況畫面：`screens/manager-dashboard.png`

![管理者儀表板](./02-dashboard-admin.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | 資料品質橫幅 | orders.data_origin 判斷 NO_DATA／DEMO／IMPORT／MIXED | 無資料時引導到「訂單匯入」；DEMO 時明示非真實 | 全部可看儀表板者 |
| 2 | KPI 卡（GMV、淨銷售、訂單數、AOV、退款率、目標達成率、預估佣金） | kpi.ts（單一口徑）；orders、campaigns.target_revenue、commission_rules | 每張卡顯示來源與公式；無數字顯示「—」而非 0 | 無 campaign.sensitive.read 者隱藏「目標達成率」；無業績權限者整區改顯示說明橫幅 |
| 3 | 檔期管線／未來 30 天 | campaigns、campaign_exposures | 點檔期連到檔期詳情 | — |
| 4 | 逾期任務 | tasks（due_date < 今天且未完成） | 點任務連到檔期；空狀態顯示「目前沒有逾期任務」 | — |
| 5 | 團主績效 | attributions × orders | 依歸因計算；無歸因訂單時顯示空狀態 | — |
| 6 | 廠商合作進度 | campaigns × tasks | 顯示任務完成度與廠商端逾期 | — |

## 03-campaigns
**檔期清單**（P1）　現況畫面：`screens/manager-campaigns.png`

![檔期清單](./03-campaigns.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | 建立檔期按鈕 | — | → /campaigns/new（需 campaign.write） | 營運主管、營運小編、系統管理者；團主與廠商不顯示 |
| 2 | 篩選列 | GET /api/campaigns?q&status&vendorId&hostId&from&to | 條件放在網址，可分享連結 | — |
| 3 | 檔期表格 | campaigns + 任務進度彙總 | 點名稱進詳情；逾期數大於 0 以警示色顯示 | 團主／廠商只看到自己範圍的檔期（後端資料範圍） |
| 4 | 分頁 | limit／offset（預設 50） | 上一頁／下一頁 | — |
| 5 | 空狀態 | — | 無資料時顯示說明，不顯示空表格 | — |

## 04-campaign-detail
**檔期詳情（概覽／任務／核准）**（P1）　現況畫面：`screens/manager-campaign-overview.png`

![檔期詳情（概覽／任務／核准）](./04-campaign-detail.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | 標題與狀態徽章 | GET /api/campaigns/:id | 顯示 14 種狀態之一（草稿…結案／取消／暫緩） | — |
| 2 | 動作按鈕列：調整日期、推進／退回、暫緩／恢復、取消 | POST /api/campaigns/:id/status、POST /api/campaigns/:id/reschedule | 推進只列出狀態機允許的下一步；退回需填原因；取消只有主管且無法恢復 | 僅 campaign.write／transition；團主與廠商整列不顯示 |
| 3 | 下一步提示 | NEXT_HINT（依狀態） | 告訴使用者目前該做什麼 | — |
| 4 | 相關作業連結 | — | 連到履約出貨（帶 campaignId）、售後、財務 | 僅內部角色顯示 |
| 5 | 分頁籤 | 網址 ?tab= | 概覽／任務／商品／團主與曝光／核准與關卡／異動紀錄 | 團主多一個「團主與曝光」；核准與異動紀錄只有內部角色 |
| 6 | 概覽區塊：基本資料、任務進度、未結例外、衝突提醒 | campaigns、tasks、exceptions、conflicts | 衝突為提醒，不阻擋 | 目標營收等敏感欄位僅 campaign.sensitive.read 看得到 |
| 7 | 任務分頁表格 | tasks | 指派、完成、標記阻擋、回填證據備註 | 團主／廠商只能操作自己角色的任務；越權回 404 |
| 8 | 核准分頁：核准紀錄＋申請按鈕 | approvals、gates.ts | 申請 G1–G5；狀態先進入「待…核准」 | 申請 approval.request；決定只在「核准」頁，由有權限者進行 |
| 9 | 系統檢查 | runGateChecks | BLOCK 必須通過才能核准；WARN 只提醒 | — |

## 05-reschedule
**日期重排預覽**（P1）　現況畫面：`screens/manager-campaign-reschedule.png`

![日期重排預覽](./05-reschedule.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | 四個日期欄位 | campaigns 現有日期 | 修改任一日期；空白＝不變 | 僅 campaign.write |
| 2 | 預覽影響按鈕 | POST /api/campaigns/:id/reschedule（不帶 confirm 即為預覽） | 只計算、不寫入；回傳 token | — |
| 3 | 影響預覽表 | schedule.ts（依 SOP 天數往前／往後推算） | 逐任務列出舊→新日期；手動鎖定的日期標示且不移動 | — |
| 4 | 警告橫幅 | previewReschedule | 列出衝突、被鎖定任務、日期落在過去的任務 | — |
| 5 | 變更原因 | — | 開團後調整日期必填（requiresReason）；進稽核紀錄 | — |
| 6 | 確認並套用 | POST /api/campaigns/:id/reschedule（confirm:true＋預覽 token＋Idempotency-Key） | 寫入新日期、連動任務、寫稽核；重複送出同一請求不會重複套用 | — |

## 06-approvals
**核准頁**（P1）　現況畫面：`screens/manager-approvals.png`

![核准頁](./06-approvals.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | 篩選 | GET /api/approvals | 依狀態、關卡篩選 | — |
| 2 | 核准清單 | approval_requests（gates.ts） | 每列＝一次申請；空狀態顯示「沒有核准申請」 | 看得到的範圍依 approval.read；營運小編只看自己提出的相關檔期 |
| 3 | 系統檢查表 | runGateChecks（BLOCK／WARN） | 核准時重新檢查，避免用舊結果放行 | — |
| 4 | 決定原因 | — | 退回、拒絕、高風險衝突放行需填原因；原因進稽核 | — |
| 5 | 核准／退回／拒絕按鈕 | POST /api/approvals/:id/decision | 只有該關卡的核准角色看得到：G1/G2 主管與管理者；G3 加財務；G4 財務與管理者；G5 主管與管理者 | 其他角色按鈕不顯示；直接呼叫 API 回 403 |

## 07-tasks
**任務清單**（P1）　現況畫面：`screens/manager-tasks.jpg`

![任務清單](./07-tasks.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | 篩選列 | GET /api/tasks | 依狀態／負責角色／檔期／逾期篩選 | — |
| 2 | 任務表 | tasks（來自檔期的 15 步流程） | 點任務進檔期詳情的任務分頁；逾期以警示色標示 | 團主／廠商只看到指派給自己角色或自己範圍檔期的任務 |
| 3 | 階段欄 | 八個階段（ADR-004，PROPOSED） | 按階段分組概念；階段定義待 Owner 確認 | — |
| 4 | 空狀態 | — | 顯示說明 | — |

## 08a-vendor-detail
**廠商詳情**（P1）　現況畫面：`screens/manager-vendor-detail.png`

![廠商詳情](./08a-vendor-detail.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | 標題＋狀態 | GET /api/vendors/:id | 啟用／停用／封存 | — |
| 2 | 編輯／封存 | PATCH /api/vendors/:id、POST …/archive | 封存＝軟刪除（資料保留）；編輯用樂觀鎖版本，衝突時提示重新整理 | 需 vendor.write；廠商本人只能看自己 |
| 3 | 基本資料 | vendors | 公司名、統編、類別、備註；缺漏欄位標示「待補資料」 | 內部備註僅內部角色可見 |
| 4 | 聯絡人 | vendor_contacts | 新增、設主要聯絡人、封存 | — |
| 5 | 商品 | products | 連到商品詳情；顯示審核狀態 | 成本欄位在商品頁，只有 product.cost.read 看得到 |
| 6 | 合作檔期 | campaigns | 點選進檔期詳情 | 廠商本人只看到自己的檔期；看不到別家廠商（404） |

## 08b-host-detail
**團主詳情**（P1）　現況畫面：`screens/manager-host-detail.png`

![團主詳情](./08b-host-detail.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | 標題＋狀態 | GET /api/hosts/:id | — | 團主本人只能開自己的詳情；其他團主回 404 |
| 2 | 編輯／封存 | PATCH /api/hosts/:id、POST …/archive | 封存＝軟刪除 | 需 host.write |
| 3 | 基本資料 | hosts | 顯示名稱、聯絡方式、合作條件（文字欄位） | 分潤比例不在此頁顯示 |
| 4 | 所屬社群 | host_communities、communities | 連結／解除社群 | 需 community.write |
| 5 | 可承接／不可承接 | host_availability | 衝突檢查會參考；移除只標記失效 | — |
| 6 | 歷史團購 | campaign_hosts | 顯示參與過的檔期與回覆狀態 | — |

## 09-imports
**訂單匯入**（P1）　現況畫面：`screens/manager-imports.png`

![訂單匯入](./09-imports.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | CSV 欄位說明 | orders.ts 的欄位定義 | 列出必填欄位（來源訂單編號、檔期、下單時間、金額、狀態…） | — |
| 2 | 匯入表單 | POST /api/imports | 整檔 checksum 去重：同一檔重複匯入會被擋；來源訂單編號去重；逐列驗證 | 需 order.import；財務僅能檢視批次 |
| 3 | 匯入批次 | import_batches | 顯示新增／更新／重複／錯誤列數與資料截至時間 | — |
| 4 | 錯誤列 | import_errors | 可標記已處理；空狀態「沒有錯誤列」 | — |

## 10-fulfillment-batch
**履約批次詳情**（P2）　現況畫面：`screens/manager-fulfillment-batch.png`

![履約批次詳情](./10-fulfillment-batch.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | 標題＋批次狀態 | GET /api/fulfillment/batches/:id | 批次狀態由出貨單彙總 | — |
| 2 | 批次資料 | fulfillment_batches | 檔期、類型、預計出貨日、內部備註 | 內部備註對團主／廠商不顯示（欄位投影） |
| 3 | 提醒區 | fulfillment 總覽 | 提醒不阻擋任何狀態轉換（不影響 G 閘門） | — |
| 4 | 出貨單表 | shipments | 新增出貨單、編輯、取消（軟取消） | 寫入需 fulfillment.write；財務、團主、廠商唯讀 |
| 5 | 出貨進程操作：已包裝／出貨／標記送達／簽收確認／標記異常 | POST /api/fulfillment/shipments/:id/status、/receipt | 只顯示目前狀態允許的下一步；簽收由內部人員代登 | 團主與廠商不能簽收（廠商入口未解凍） |
| 6 | 空狀態 | — | 提示新增出貨單 | — |
| 7 | 庫存 | inventory_movements（append-only） | 庫存異動在「履約出貨」的庫存分頁；更正以反向異動呈現，不改舊紀錄；庫存不隨出貨自動扣 | — |

## 11-aftersales-case
**售後案件詳情與退款核准**（P2）　現況畫面：`screens/manager-aftersales-case.png`

![售後案件詳情與退款核准](./11-aftersales-case.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | 標題＋案件狀態 | GET /api/aftersales/cases/:id | 開啟／處理中／等待廠商／已解決／已結案／已取消 | — |
| 2 | 案件資料 | service_cases | 內部備註、處理結果可編輯；提醒不填個資 | 團主／廠商唯讀摘要，看不到內部備註（欄位投影） |
| 3 | 處理紀錄 | case_events（append-only） | 新增備註；紀錄不可修改刪除 | — |
| 4 | 退款申請表 | refund_requests | 營運小編可申請；狀態：待核准／待完成／已完成／已退回 | 申請需 aftersales.write |
| 5 | 核准／退回 | POST /api/aftersales/refunds/:id/decision | 只有營運主管與系統管理者；核准者可否為申請者本人 → 待 Owner 決定 | 其他角色不顯示按鈕 |
| 6 | 完成退款 | POST /api/aftersales/refunds/:id/complete | 只有財務（refund.complete）與系統管理者；完成後鎖定 | 營運主管不能完成退款（權責分離） |
| 7 | 寫回訂單選項 | orders.refund_amount、orders.status | 預設關閉；開啟時同交易驗證不超過訂單金額、更新為部分退款／全額退款、寫稽核 | — |

## 12-settlement-detail
**財務結算詳情**（P2）　現況畫面：`screens/finance-settlement-draft.png`

![財務結算詳情](./12-settlement-detail.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | 標題＋狀態＋操作 | GET /api/settlements/:id；POST …/recalculate、/confirm、/void | 草稿可重新試算與確認；已確認鎖定，只能作廢後另開 | 確認需 settlement.confirm（財務、系統管理者）；營運主管僅檢視 |
| 2 | 固定警示橫幅 | FINANCE_NOTICE | 每個結算頁都顯示「試算，口徑待 Owner 確認；非正式付款依據」 | — |
| 3 | 條件式橫幅 | settlements.data_status、stale 判斷 | DEMO 資料提示；訂單或規則在試算後變動 → 標示過期，確認前必須重新試算 | — |
| 4 | 試算資訊 | settlements | 檔期、資料基準（DEMO／匯入、截至時間）、使用的規則版本、建立與確認時間、備註 | — |
| 5 | 合計 | settlement_items 彙總 | 檔期有效淨銷售、已歸因與未歸因金額、最終佣金合計、尚缺費率的團主、已關聯入帳筆數；佣金＝歸因淨銷售 × 生效中的版本化費率（沿用既有口徑，未新增公式） | — |
| 6 | 團主項目表 | settlement_items、commission_rules | 無適用費率的團主不猜金額，顯示空值 | 團主只在「我的結算」看到自己已確認的那一列 |
| 7 | 覆寫與調整 | POST /api/settlement-items/:id/override、/api/settlements/:id/adjustments | 覆寫金額與調整都必填原因；確認後不可再改 | 需 finance.write |
| 8 | 調整項紀錄 | settlement_adjustments（資料庫禁止修改刪除） | 只增不改；顯示操作者與原因 | — |

## 13-host-my-settlements
**團主「我的結算」**（P2）　現況畫面：`screens/host-finance-mine.png`

![團主「我的結算」](./13-host-my-settlements.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | 固定警示 | FINANCE_NOTICE | 與財務頁相同 | — |
| 2 | 結算表 | GET /api/settlements/mine（settlement_items，僅 CONFIRMED） | 只含自己的列：淨銷售、費率、試算佣金 | 僅 HOST 角色顯示導覽項「我的結算」 |
| 3 | 空狀態 | — | 尚無已確認結算時說明 | — |
| 4 | 資料界線 | settlements.ts 欄位投影 | 測試鎖住：看不到其他團主、調整原因、草稿 | 廠商完全無財務權限 |

## 14-notifications
**通知中心**（P1）　現況畫面：`screens/host-notifications.png`

![通知中心](./14-notifications.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | 標題與未讀數 | GET /api/notifications | 明示：僅站內通知，系統不會對外發送 | 每位使用者只看到自己的通知 |
| 2 | 通知列 | notifications（佇列＋TestAdapter） | 點通知依類型導向檔期、核准、任務、匯入或自動化頁；未讀有徽章 | — |
| 3 | 標示已讀 | POST /api/notifications/:id/read | 單筆標示；已讀不再顯示按鈕 | — |
| 4 | 空狀態 | — | — | — |

## 16-host-segments
**團主詳情：客群分析**（SOP 01）　現況畫面：`screens/manager-host-segments.png`　對應需求：FR-SEG-01～07（SRS §4.16）

> 這張是**建置前線框**（先畫線框、再實作）；與實際畫面的差異見 [AS_BUILT_SCREENS.md](AS_BUILT_SCREENS.md) 的「客群分析與商品適配」。

![團主詳情：客群分析](./16-host-segments.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | 區塊標題＋完整度徽章（未建立／待補資料／完整） | GET /api/hosts/:id/segments | 完整度由缺漏欄位計算；缺資料不影響團主其他功能 | 需 segment.read（管理者、主管、小編）；團主、廠商、財務看不到此區 |
| 2 | ＋ 新增客群 | POST /api/hosts/:id/segments（一併建立客群、偏好、觀察來源） | 欄位留空＝未知；每個偏好可切換事實／估計；名稱重複回報既有 ID | 需 segment.write |
| 3 | 連結既有客群 | POST /api/hosts/:id/segments（segmentId） | 同一客群可被多位團主共用；各客群占比合計不可超過 100% | 需 segment.write |
| 4 | 基本資料列：合作對象類型、一句話描述、占比合計 | hosts.partner_type、hosts.audience_note、partner_segment_links | 舊的「客群描述」欄保留；類型未填顯示「未知」 | 類型在編輯表單修改（host.write） |
| 5 | 客群卡片（名稱、整體依據、占比、主要社群、連結依據） | customer_segments、partner_segment_links | 一團主可有多張卡；連結的社群必須是該團主目前所屬社群 | — |
| 6 | 編輯客群 | PATCH /api/segments/:id（含四類偏好陣列、樂觀鎖） | 會影響所有連結此客群的團主；移除的偏好只是軟刪除；變更有稽核前後值 | 需 segment.write |
| 7 | 調整占比 | PATCH /api/segment-links/:id | 占比、依據、社群、備註 | 需 segment.write |
| 8 | 結束連結 | POST /api/segment-links/:id/end | 只寫 ended_at，不刪列；客群與歷史評估保留 | 需 segment.write |
| 9 | 輪廓與偏好列（年齡層、家庭型態、消費週期、價格帶、需求動機、購買阻力、偏好品類、活躍通路） | segment_preferences（kind＝MOTIVE／BARRIER／CATEGORY／CHANNEL） | 實線＝事實、虛線＝估計、斜體「未知」＝尚未填寫（不是「沒有」） | — |
| 10 | 觀察來源＋新增觀察來源 | segment_evidence | 標「事實」必須填來源；不得含手機或 Email；移除＝軟刪除 | 需 segment.write |

## 17-product-fit
**商品頁：候選團主適配**（SOP 01）　現況畫面：`screens/manager-product-fit.jpg`；檔期頁版本 `screens/manager-campaign-fit.png`　對應需求：FR-FIT-01～10

![商品頁：候選團主適配](./17-product-fit.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | 產生候選團主評估 | POST /api/products/:id/fit | 預設評估所有「合作中」團主（上限 200）；輸入與設定沒變就不新增版本；不發任何通知、不改商品狀態 | 需 fit.assess（管理者、主管、小編） |
| 2 | 候選團主欄 | product_fit_assessments × hosts | 建議合作排最前、硬性條件未過排最後；尚無客群分析者標示 | 需 fit.read；團主、廠商、財務無入口 |
| 3 | 總分／建議 | scoring：需求30／品類20／價格15／歷史績效20／供應履約15（建議值，待確認） | 只用已知維度重新正規化；「資料不足」「硬性條件未過」的分數灰字並註明僅供參考 | — |
| 4 | 信心／資料完整度／資料已更新 | confidence、completeness、stale 旗標 | 完整度＝已知權重比例；客群、商品、價格資料晚於評估時間更新就標「建議重評」 | — |
| 5 | 硬性檢查（合規、商品品質） | 商品審核狀態、合規備註、廠商狀態 | 未通過＝BLOCKED，不被總分抵銷；未知＝最高只能「需人工評估」 | — |
| 6 | 人工覆核（結果、覆核人、時間、意見）＋覆核／重新覆核按鈕 | POST /api/fit/:id/review | 同意採用／不採用／需補資料；後兩者必填原因；只記錄意見，不改任何檔期狀態；已被新版取代的評估不能覆核 | 需 fit.review（管理者、主管）；小編可看不可覆核 |
| 7 | 理由展開 | dimensions、hard_checks、reasons、config_snapshot | 每維度顯示分數或「未知，未計分」、依據（事實／估計）、理由與命中項目；顯示評分設定版本 | — |
| 8 | 展開內容（維度、硬性檢查、評估時間、結案成效） | 同上；outcome（結案回寫） | 結案後可回寫實際歸因淨銷售、訂單數、目標達成率（POST /api/campaigns/:id/fit/outcome） | 檔期層級資料依檔期資料範圍（小編只看自己負責的檔期） |
| 9 | 覆核對話框 | 同 6 | 顯示系統建議；明示覆核不會改變檔期狀態或 G1–G5 | — |

## 18-fit-overview
**客群適配總覽**（SOP 01）　現況畫面：`screens/manager-fit-overview.png`、手機版 `screens/manager-mobile-fit.png`　對應需求：FR-FIT-01、FR-FIT-07、FR-FIT-12

![客群適配總覽](./18-fit-overview.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | 評分設定橫幅（版本、「建議值，待 Owner 確認」、權重與門檻） | GET /api/fit/config | 未經 Owner 確認前一律標示待確認；調整連結只給有權限者 | 調整需 fit.config（管理者、主管） |
| 2 | 分頁：待覆核／已覆核／全部最新評估／評分設定 | GET /api/fit?review=… | 評分設定存新版本、寫稽核；舊評估保留當時的設定快照 | — |
| 3 | 評估清單（團主／商品、總分／建議、信心、硬性檢查、覆核、理由） | 同 17 | 同商品頁的表格元件 | — |
| 4 | 覆核入口 | POST /api/fit/:id/review | 同 17 的 6 | 需 fit.review |
| 5 | 尚未建立客群分析的團主 | GET /api/fit/overview | 引導到團主頁建立客群分析（流程：新團主建檔 → 客群分析） | — |

## 19-vendor-diligence
**廠商詳情：合作資格審查與調查詳情**（SOP 02 首次合作 12 類問題）　現況畫面：`../uat/screens/27-vendor-diligence.png`、`../uat/screens/28-diligence.png`　對應需求：FR-SEL-*（編號待 SRS 定稿）

> 線框上半是廠商詳情新增的「合作資格審查」區塊，下半是調查詳情頁 `/diligence/[id]`。尚未與實際畫面逐項比對的差異見 [AS_BUILT_SCREENS.md](AS_BUILT_SCREENS.md) 的「選品與試用」。

![廠商詳情：合作資格審查與調查詳情](./19-vendor-diligence.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | 區塊標題與說明（核准後有效天數、不阻擋 G1） | GET /api/vendors/:id/diligence | 有效天數來自選品設定（建議值 365 天，待 Owner 確認）；到期或證據過期自動標示失效，不改資料 | 需 selection.read；團主、廠商看不到此區 |
| 2 | ＋ 新增調查 | POST /api/vendors/:id/diligence | 合約版本必填；可限定商品、選受規範品類；同廠商＋同商品＋同合約版本不可重複；建立後自動產生 12 項（待補件）並導向詳情 | 需 selection.write（管理者、主管、小編） |
| 3 | 調查清單（合約版本、範圍、狀態、進度、有效期） | vendor_dd_records | 範圍＝整個廠商或單一商品；已核准但失效顯示「已失效」；合約改版另開一份、舊的保留 | 財務唯讀 |
| 4 | 狀態徽章（草稿／審查中／已核准／已退回） | status | 草稿與已退回可編輯；審查中與已核准唯讀 | — |
| 5 | 動作列：送審／核准／退回／撤銷核准 | POST /api/diligence/:id/submit、/review | 送審需 12 項皆已確認或不適用、無風險、無過期證據、無未結法務；核准有效期不得超過上限；退回與撤銷必填原因 | 送審 selection.write；核准／退回／撤銷需 product.review（管理者、主管） |
| 6 | 說明橫幅（只標示不判斷合法）與核准有效性橫幅 | validity、reviewed_at | 轉售價格限制、食品、保健、醫材、化妝品、兒童用品只標「需法務或合規審查」 | — |
| 7 | 調查資料卡（合約版本、合約編號、受規範品類、填報、審核） | PATCH /api/diligence/:id | 改受規範品類會重新標示第 1 類法務狀態；合約版本建立後不可改 | 需 selection.write，且狀態為草稿／已退回 |
| 8 | 準備度卡（可送審／不可送審與原因、各狀態計數） | readiness | 原因逐項列出：待補件、有風險、證據過期、法務未結、已確認但無有效證據 | — |
| 9 | 12 類問題卡片（可展開）：狀態、法務標示、責任方、負責人、證據數 | vendor_dd_items | 有風險或法務待審預設展開；條款是結構化欄位（責任方、期限、金額、比例）並驗證；不適用必填原因、有風險必填說明 | 填寫需 selection.write |
| 10 | 展開卡片：狀態、責任方、負責人、條款欄位、證據清單 | PATCH /api/diligence-items/:id | 必附證據的類別（1、7、8、9、10、11）標「已確認」前需一筆未過期證據；負責人須為啟用中的內部使用者；樂觀鎖 | — |
| 11 | 第 10 類（分潤）對無權限者隱藏 | maskTerms、evidence 遮罩 | 條款、狀態、備註、證據標題與連結都不回傳；無權限者只能指派負責人與責任方，且不能新增證據 | 完整內容需 product.cost.read（主管、財務、管理者） |
| 12 | 證據清單與＋證據連結 | POST /api/evidence、/:id/remove | 只存 http／https 連結與有效期；備註不得含電話或 Email；移除＝軟刪除；核准後鎖定 | 需 selection.write |
| 13 | 法務／合規審查標示按鈕 | POST /api/diligence-items/:id/legal | 標示需審任何填報者可做；確認無虞需先附有效的「法務意見」證據；封鎖＝不得合作；自動觸發條件仍成立時不可直接解除 | 確認無虞／封鎖／解除需 product.review |

## 20-product-selection
**商品詳情：選品評估、商品試用、商業可行性**（SOP 02／03）　現況畫面：`../uat/screens/29-product-selection.png`、`../uat/screens/32-feasibility.png`　對應需求：FR-SEL-*（編號待 SRS 定稿）

![商品詳情：選品評估、商品試用、商業可行性](./20-product-selection.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | 開始評估／重新評估（新版本） | POST /api/products/:id/evaluations | 同商品同時只有一份草稿；重新評估＝新版本，舊版標示被取代 | 需 selection.write |
| 2 | 說明與設定狀態（權重、門檻、「建議值，待 Owner 確認」） | GET /api/selection/config | 六項 1–5 分加權；未評分＝未知不當 0 分；合規獨立；分數不自動核准商品或 G1 | 調整設定需 selection.config（管理者、主管） |
| 3 | 客群適配參考（SOP 01，唯讀） | product_fit_assessments | 只顯示各建議等級的團主數與最高分，不複製、不重算 | 需 fit.read |
| 4 | 現行評估：總分、建議等級、合規、信心、完整度 | product_evaluations | 建議等級依序判斷：合規未過→合規未過；完整度不足→資料不足；≥80 且合規通過且品質與供應有證據→建議進入商務審查；≥65→補測／補件；其他→暫緩 | — |
| 5 | 六項分數表（分數、理由、有效證據數；未評顯示「未知」）與缺證據橫幅 | scores、evidence_gaps | 品質與供應評了分卻沒有未過期證據→降為補測／補件；過期證據不算 | — |
| 6 | 覆核列與覆核按鈕 | POST /api/evaluations/:id/review | 同意採用／不採用／需補資料；後兩者必填原因；只記錄意見，不改商品審核狀態、不核准 G1；舊版不能覆核 | 需 product.review（管理者、主管） |
| 7 | 評估草稿編輯（六項分數、理由、引用證據、合規查核）與證據連結 | PATCH /api/evaluations/:id、POST …/submit | 儲存草稿顯示即時試算；送出後內容不可改（資料庫觸發器）；理由必填、不得含電話或 Email | 需 selection.write |
| 8 | ＋ 新增試用 | POST /api/products/:id/trials | 層級（資格／團主適配）、類型（內部／指定團主／小規模測試團）；進行中的相同組合不可重複；團主適配自動沿用仍有效的商品資格 | 需 selection.write |
| 9 | 商品資格狀態列 | qualificationFor | 通過且覆核接受、未過期、商品指紋（名稱、類別、規格編號、合規備註）未變才可沿用；失效會顯示原因 | — |
| 10 | 試用清單（檢核進度、結論、覆核、回收） | product_trials | 檔期層級的試用依檔期資料範圍（小編只看自己負責的檔期） | 財務唯讀 |
| 11 | 說明：一商品可多次試用；任務仍在任務頁 | — | 試用不新增任務狀態機，不自動完成寄樣／到貨／回饋／G1 任務 | — |
| 12 | ＋ 新增試算 | POST /api/products/:id/feasibility | 每次儲存是新版本，在上一版基礎上套用本次欄位；每個填入的數字都要選假設來源 | 需 selection.write；敏感欄位需 product.cost.read |
| 13 | 說明與商品主檔參考價 | referenceFor | 參考價僅供填寫參考，不自動帶入；成本範圍只給有成本檢視權限者 | 無權限者顯示「成本：無權限查看」 |
| 14 | 版本清單：GMV、NSV、品牌利潤、公司營業收入分開呈現 | feasibility_scenarios | GMV 與代收款不是公司收入；缺少的輸入顯示「未知」不當 0；口徑待 Owner 確認 | 無權限者利潤與收入欄顯示「無權限」，GMV／NSV 可見 |
| 15 | 無權限提示 | maskResults | 敏感結果在後端以 null 回傳並標 restricted | — |
| 16 | 新增試算對話框（四組輸入＋假設來源） | FeasibilityForm | 規模與價格、成本、服務費與分潤、成本負擔方（金額大於 0 的項目必選負擔方）；沒填＝未知 | 後三組敏感，無權限者看不到也不能填，上一版的值原樣沿用 |

## 21-campaign-g1-summary
**檔期：選品與試用（G1 決策摘要）**（SOP 02／03）　現況畫面：`../uat/screens/30-campaign-selection.png`　對應需求：FR-SEL-*（編號待 SRS 定稿）

> 這一頁是**唯讀摘要**，`gateImpact` 恆為 `NONE`：不是 G1 的檢查項，不改變 G1 的檢查清單（deps_done、has_confirmed_host、has_products、vendor_info、vendor_ok）、申請與核准結果，不新增核准列、任務或通知。

![檔期：選品與試用（G1 決策摘要）](./21-campaign-g1-summary.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | 說明橫幅（不是 G1 檢查項） | — | 明示不阻擋、不放行、不自動核准 | 分頁需 selection.read 且為內部角色 |
| 2 | 總燈號與計數 | GET /api/campaigns/:id/g1-summary | 🔴 有阻礙性風險（合規未過、法務封鎖、試用不通過、關鍵證據過期、被退回）／🟡 有缺口／🟢 無已知缺口；附評分設定狀態 | 檔期須在資料範圍內，越權 404 |
| 3 | 商品區塊標題與燈號 | decision-summary | 每個商品一塊；商品連結、廠商連結 | — |
| 4 | 選品評估摘要 | 現行評估 | 總分、建議、合規、完整度、覆核；無評估顯示「尚無已送出的評估」 | — |
| 5 | 廠商合作資格審查摘要 | 商品專屬優先、否則廠商層級 | 合約版本、狀態、有效至／已失效原因、待補件／風險／過期證據／法務未結 | — |
| 6 | 試用摘要 | qualificationFor、本檔試用 | 商品資格是否仍有效；本檔每組（層級×類型×團主）只看最新一次 | — |
| 7 | 商業可行性摘要 | latestFeasibility | 本檔情境優先、否則商品層級；GMV／NSV 可見，利潤與收入需成本檢視權限，無權限者風險訊息也不洩漏利潤正負 | 需 product.cost.read 才見利潤 |
| 8 | 風險與缺口清單（阻礙／缺口、面向、說明） | buildRisks | 規則在純函式，有單元測試；客群適配（SOP 01）統計以唯讀併入 | 客群適配需 fit.read |
| 9 | 本檔試用清單 | GET /api/campaigns/:id/trials | 連到試用詳情；檢核進度、結論、回收 | — |
| 10 | 相關任務現況（唯讀） | tasks | 寄樣、到貨、回饋、G1 任務的狀態只讀，處理仍在任務頁 | — |
| 11 | 「核准與關卡」分頁的 G1 提示列 | 同摘要 | 一行燈號與計數＋連結；不影響申請與核准 | 需 selection.read |

## 22-trial-detail
**試用詳情：四大面向檢核、結論與覆核**（SOP 03）　現況畫面：`../uat/screens/31-trial.png`　對應需求：FR-SEL-*（編號待 SRS 定稿）

![試用詳情：四大面向檢核、結論與覆核](./22-trial-detail.svg)

| # | 元件 | 資料來源 | 互動與規則 | 角色差異 |
|---|---|---|---|---|
| 1 | 標題、狀態與動作列（取消試用、覆核接受／不接受） | GET /api/trials/:id | 狀態只有進行中／已結論／已取消，不是任務狀態機；取消必填原因 | 取消需 selection.write；覆核需 product.review |
| 2 | 說明橫幅（任務仍在任務頁） | — | 試用只存資料：日期、物流、回收、檢核、結論、覆核 | — |
| 3 | 沿用商品資格橫幅 | qualification_trial_id | 沿用時只需補客戶、內容、商業三面向；結論時若資格已失效會被擋 | — |
| 4 | 試用資料卡與編輯 | PATCH /api/trials/:id | 日期先後順序驗證；物流與回收可在結論後補寫；已取消不可改 | 需 selection.write；檔期層級依檔期範圍（越權 404） |
| 5 | 結論卡：系統建議、最終建議、說明、覆寫原因、有效期限 | POST /api/trials/:id/conclude | 全通過→通過；有疑慮或重大缺陷→有條件通過；有未測→需重測；不通過或嚴重缺陷→不通過；最終建議不得比系統建議樂觀，除非 product.review 填覆寫原因 | 覆寫欄位僅審核權限可見 |
| 6 | 最終建議與結論說明表單 | 同 5 | 通過／有條件通過記錄有效期限（預設 180 天）與商品指紋；結論後內容不可改（資料庫觸發器） | — |
| 7 | 四大面向檢核表（結果、客觀證據、缺陷、說明） | PATCH /api/trial-checks/:id | 「通過」必填客觀證據；有缺陷必填說明；不通過需缺陷或風險說明；結論或取消後鎖定 | 「預估毛利」的文字可能含成本，無成本檢視權限者看不到也不能填 |
| 8 | 試用整體證據連結 | POST /api/evidence | 只存連結與有效期；結論後鎖定 | 需 selection.write |
| 9 | 本檔相關任務（唯讀） | tasks | 不自動完成任務；任務的證據欄位可貼這一頁的連結 | — |
| 10 | 異動歷史 | audit_logs | 建立、更新檢核、結論、覆核；敏感檢核項的文字在稽核中以「[敏感]」取代 | — |
| 11 | 檢核項單列儲存 | 同 7 | 每列獨立儲存，樂觀鎖衝突提示重新整理 | — |

## 設計共通規則

- 狀態一律用「徽章＋文字」，不只靠顏色。
- 每個列表頁都有空狀態說明；有篩選條件的頁面，條件放在網址上可分享。
- 危險操作（取消檔期、作廢、封存）用紅色外框按鈕並要求確認或填原因。
- 敏感欄位（成本、目標營收、內部備註、他人結算）由**後端**決定是否回傳，畫面不是唯一防線。
- 所有寫入都留稽核紀錄；沒有真正的刪除，只有封存、取消或作廢。
- 結算相關頁面固定顯示「試算，口徑待 Owner 確認；非正式付款依據」。
- 客群分析與適配：空值一律顯示「未知」（不是「無」或 0 分）；每個偏好與維度標示事實／估計；評分權重標示「建議值，待 Owner 確認」；適配評估只供查閱與人工覆核，不影響 G1–G5。
- 選品與試用：分數與評估只是決策建議，不自動核准商品或 G1；G1 決策摘要 `gateImpact` 恆為 NONE；缺資料顯示「未知」；成本、分潤與利潤由後端依 `product.cost.read` 決定是否回傳；證據只存連結與有效期，不存檔案本體；評分權重與有效天數標示「建議值，待 Owner 確認」。
