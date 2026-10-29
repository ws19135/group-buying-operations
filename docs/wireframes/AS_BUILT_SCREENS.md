# 現況畫面截圖集（As-built Screens）

> 由 Playwright 對**隔離的示範資料庫**（全是虛構 DEMO 資料）逐角色實際操作後截圖，視窗 1280×800、整頁截圖；每張小於 400 KB（過大者改存 JPEG）。
> 帳號只用 `demo-*@example.invalid`，密碼不寫入任何檔案。「x-」開頭是**刻意造訪沒有權限的頁面**，用來確認後端與畫面的擋法。
> 截圖中左側導覽在整頁截圖時會被截到視窗高度，這是截圖方式造成，不是畫面缺陷。
> 線框圖見 [WIREFRAMES.md](WIREFRAMES.md)；全部路由見 [SCREEN_INVENTORY.md](SCREEN_INVENTORY.md)。

## 未登入

| 畫面 | 路徑 | 截圖 | 結果 |
|---|---|---|---|
| 登入 | `/login` | [anon-login.png](screens/anon-login.png) | 200 |
| 登入失敗 | `/login`（密碼錯誤） | [anon-login-error.png](screens/anon-login-error.png) | 顯示錯誤橫幅 |

## 營運主管（demo-manager）

| 畫面 | 路徑 | 截圖 | 結果 |
|---|---|---|---|
| 營運總覽 | `/dashboard` | [manager-dashboard.png](screens/manager-dashboard.png) | 200　營運總覽 |
| 檔期清單 | `/campaigns` | [manager-campaigns.png](screens/manager-campaigns.png) | 200　檔期 |
| 檔期詳情（概覽） | `/campaigns/CMP-202610-0001` | [manager-campaign-overview.png](screens/manager-campaign-overview.png) | 200　[DEMO] 夏日防曬噴霧團購 進行中 |
| 檔期詳情（任務） | `/campaigns/CMP-202610-0001?tab=tasks` | [manager-campaign-tasks.png](screens/manager-campaign-tasks.png) | 200　[DEMO] 夏日防曬噴霧團購 進行中 |
| 檔期詳情（核准與關卡） | `/campaigns/CMP-202610-0004?tab=approvals` | [manager-campaign-approvals.png](screens/manager-campaign-approvals.png) | 200　[DEMO] 香氛蠟燭秋季團 待結單確認 |
| 調整日期預覽對話框 | `/campaigns/CMP-202610-0001` | [manager-campaign-reschedule.png](screens/manager-campaign-reschedule.png) | 200　[DEMO] 夏日防曬噴霧團購 進行中 |
| 核准 | `/approvals` | [manager-approvals.png](screens/manager-approvals.png) | 200　核准 |
| 任務清單 | `/tasks` | [manager-tasks.jpg](screens/manager-tasks.jpg) | 200　任務 |
| 廠商清單 | `/vendors` | [manager-vendors.png](screens/manager-vendors.png) | 200　廠商 |
| 廠商詳情 | `/vendors/VEN-0001` | [manager-vendor-detail.png](screens/manager-vendor-detail.png) | 200　[DEMO] 晴空保養 合作中 |
| 團主清單 | `/hosts` | [manager-hosts.png](screens/manager-hosts.png) | 200　團主 |
| 團主詳情 | `/hosts/OWN-0001` | [manager-host-detail.png](screens/manager-host-detail.png) | 200　[DEMO] 小雅媽咪 合作中 |
| 商品清單 | `/products` | [manager-products.png](screens/manager-products.png) | 200　商品 |
| 商品詳情 | `/products/PRD-000001` | [manager-product-detail.png](screens/manager-product-detail.png) | 200　[DEMO] 清爽防曬噴霧 已通過 |
| 社群清單 | `/communities` | [manager-communities.png](screens/manager-communities.png) | 200　社群 |
| 訂單匯入 | `/imports` | [manager-imports.png](screens/manager-imports.png) | 200　訂單匯入 |
| 履約與出貨 | `/fulfillment` | [manager-fulfillment-list.png](screens/manager-fulfillment-list.png) | 200　履約與出貨 |
| 出貨批次詳情 | `/fulfillment/FBT-000001` | [manager-fulfillment-batch.png](screens/manager-fulfillment-batch.png) | 200　[DEMO] 第一批出貨 已出貨 |
| 售後案件清單 | `/aftersales` | [manager-aftersales.png](screens/manager-aftersales.png) | 200　售後 |
| 售後案件詳情 | `/aftersales/CAS-000001` | [manager-aftersales-case.png](screens/manager-aftersales-case.png) | 200　[DEMO] 收到商品外盒破損 處理中 |
| 退款申請 | `/aftersales/refunds` | [manager-aftersales-refunds.png](screens/manager-aftersales-refunds.png) | 200　退款申請 |
| 財務結算 | `/finance` | [manager-finance.png](screens/manager-finance.png) | 200　財務結算 |
| 結算試算詳情（草稿） | `/finance/settlements/SET-20261028-0001` | [manager-settlement-draft.png](screens/manager-settlement-draft.png) | 200　結算試算 SET-20261028-0001 試 |
| 結算試算詳情（已確認） | `/finance/settlements/SET-20261028-0002` | [manager-settlement-confirmed.png](screens/manager-settlement-confirmed.png) | 200　結算試算 SET-20261028-0002 已 |
| 通知 | `/notifications` | [manager-notifications.png](screens/manager-notifications.png) | 200　通知 |
| 排程日曆 | `/calendar` | [manager-calendar.png](screens/manager-calendar.png) | 200　排程日曆 |
| 例外 | `/exceptions` | [manager-exceptions.png](screens/manager-exceptions.png) | 200　例外 |
| 自動化中心 | `/automation` | [manager-automation.png](screens/manager-automation.png) | 200　自動化中心 |
| 稽核紀錄 | `/audit` | [manager-audit.jpg](screens/manager-audit.jpg) | 200　稽核紀錄 |
| 〔越權〕使用者管理 | `/users` | [manager-x-users.png](screens/manager-x-users.png) | 「你沒有權限檢視此頁」（HTTP 200） |

## 營運小編（demo-editor）

| 畫面 | 路徑 | 截圖 | 結果 |
|---|---|---|---|
| 營運總覽 | `/dashboard` | [editor-dashboard.png](screens/editor-dashboard.png) | 200　營運總覽 |
| 檔期清單 | `/campaigns` | [editor-campaigns.png](screens/editor-campaigns.png) | 200　檔期 |
| 檔期詳情（概覽） | `/campaigns/CMP-202610-0001` | [editor-campaign-overview.png](screens/editor-campaign-overview.png) | 200　[DEMO] 夏日防曬噴霧團購 進行中 |
| 任務清單 | `/tasks` | [editor-tasks.jpg](screens/editor-tasks.jpg) | 200　任務 |
| 廠商清單 | `/vendors` | [editor-vendors.png](screens/editor-vendors.png) | 200　廠商 |
| 履約與出貨 | `/fulfillment` | [editor-fulfillment-list.png](screens/editor-fulfillment-list.png) | 200　履約與出貨 |
| 售後案件詳情 | `/aftersales/CAS-000001` | [editor-aftersales-case.png](screens/editor-aftersales-case.png) | 200　[DEMO] 收到商品外盒破損 處理中 |
| 訂單匯入 | `/imports` | [editor-imports.png](screens/editor-imports.png) | 200　訂單匯入 |
| 退款申請 | `/aftersales/refunds` | [editor-aftersales-refunds.png](screens/editor-aftersales-refunds.png) | 200　退款申請 |
| 〔越權〕財務結算 | `/finance` | [editor-x-finance.png](screens/editor-x-finance.png) | 「你沒有權限檢視此頁」（HTTP 200） |
| 〔越權〕稽核紀錄 | `/audit` | [editor-x-audit.png](screens/editor-x-audit.png) | 「你沒有權限檢視此頁」（HTTP 200） |
| 〔越權〕自動化中心 | `/automation` | [editor-x-automation.png](screens/editor-x-automation.png) | 「你沒有權限檢視此頁」（HTTP 200） |
| 〔越權〕使用者管理 | `/users` | [editor-x-users.png](screens/editor-x-users.png) | 「你沒有權限檢視此頁」（HTTP 200） |
| 〔越權〕結算詳情 | `/finance/settlements/SET-20261028-0002` | [editor-x-settlement.png](screens/editor-x-settlement.png) | 「你沒有權限檢視此頁」（HTTP 200） |

## 財務（demo-finance）

| 畫面 | 路徑 | 截圖 | 結果 |
|---|---|---|---|
| 營運總覽 | `/dashboard` | [finance-dashboard.png](screens/finance-dashboard.png) | 200　營運總覽 |
| 檔期詳情（概覽） | `/campaigns/CMP-202610-0001` | [finance-campaign-overview.png](screens/finance-campaign-overview.png) | 200　[DEMO] 夏日防曬噴霧團購 進行中 |
| 財務結算 | `/finance` | [finance-finance.png](screens/finance-finance.png) | 200　財務結算 |
| 結算試算詳情（草稿） | `/finance/settlements/SET-20261028-0001` | [finance-settlement-draft.png](screens/finance-settlement-draft.png) | 200　結算試算 SET-20261028-0001 試 |
| 結算試算詳情（已確認） | `/finance/settlements/SET-20261028-0002` | [finance-settlement-confirmed.png](screens/finance-settlement-confirmed.png) | 200　結算試算 SET-20261028-0002 已 |
| 退款申請 | `/aftersales/refunds` | [finance-aftersales-refunds.png](screens/finance-aftersales-refunds.png) | 200　退款申請 |
| 售後案件詳情 | `/aftersales/CAS-000001` | [finance-aftersales-case.png](screens/finance-aftersales-case.png) | 200　[DEMO] 收到商品外盒破損 處理中 |
| 訂單匯入 | `/imports` | [finance-imports.png](screens/finance-imports.png) | 200　訂單匯入 |
| 稽核紀錄 | `/audit` | [finance-audit.png](screens/finance-audit.png) | 200　稽核紀錄 |
| 履約與出貨 | `/fulfillment` | [finance-fulfillment-list.png](screens/finance-fulfillment-list.png) | 200　履約與出貨 |
| 商品詳情 | `/products/PRD-000001` | [finance-product-detail.png](screens/finance-product-detail.png) | 200　[DEMO] 清爽防曬噴霧 已通過 |
| 〔越權〕我的結算 | `/finance/mine` | [finance-x-finance-mine.png](screens/finance-x-finance-mine.png) | 「你沒有權限檢視此頁」（HTTP 200） |
| 〔越權〕使用者管理 | `/users` | [finance-x-users.png](screens/finance-x-users.png) | 「你沒有權限檢視此頁」（HTTP 200） |
| 〔越權〕自動化中心 | `/automation` | [finance-x-automation.png](screens/finance-x-automation.png) | 「你沒有權限檢視此頁」（HTTP 200） |
| 〔越權〕建立檔期 | `/campaigns/new` | [finance-x-new-campaign.png](screens/finance-x-new-campaign.png) | 「你沒有權限檢視此頁」（HTTP 200） |

## 團主（demo-host1）

| 畫面 | 路徑 | 截圖 | 結果 |
|---|---|---|---|
| 團主總覽 | `/dashboard/host` | [host-dashboard-host.png](screens/host-dashboard-host.png) | 200　我的團購總覽 — [DEMO] 小雅媽咪 |
| 檔期清單 | `/campaigns` | [host-campaigns.png](screens/host-campaigns.png) | 200　檔期 |
| 檔期詳情（概覽） | `/campaigns/CMP-202610-0001` | [host-campaign-overview.png](screens/host-campaign-overview.png) | 200　[DEMO] 夏日防曬噴霧團購 進行中 |
| 檔期詳情（團主與曝光） | `/campaigns/CMP-202610-0001?tab=hosts` | [host-campaign-hosts.png](screens/host-campaign-hosts.png) | 200　[DEMO] 夏日防曬噴霧團購 進行中 |
| 任務清單 | `/tasks` | [host-tasks.png](screens/host-tasks.png) | 200　任務 |
| 我的結算 | `/finance/mine` | [host-finance-mine.png](screens/host-finance-mine.png) | 200　我的結算 |
| 通知 | `/notifications` | [host-notifications.png](screens/host-notifications.png) | 200　通知 |
| 團主詳情 | `/hosts/OWN-0001` | [host-host-detail.png](screens/host-host-detail.png) | 200　[DEMO] 小雅媽咪 合作中 |
| 履約與出貨 | `/fulfillment` | [host-fulfillment-list.png](screens/host-fulfillment-list.png) | 200　履約與出貨 |
| 售後案件清單 | `/aftersales` | [host-aftersales.png](screens/host-aftersales.png) | 200　售後 |
| 〔越權〕營運總覽 | `/dashboard` | [host-x-dashboard.png](screens/host-x-dashboard.png) | 「你沒有權限檢視此頁」（HTTP 200） |
| 〔越權〕財務結算 | `/finance` | [host-x-finance.png](screens/host-x-finance.png) | 「你沒有權限檢視此頁」（HTTP 200） |
| 〔越權〕稽核紀錄 | `/audit` | [host-x-audit.png](screens/host-x-audit.png) | 「你沒有權限檢視此頁」（HTTP 200） |
| 〔越權〕廠商清單 | `/vendors` | [host-x-vendors.png](screens/host-x-vendors.png) | 「你沒有權限檢視此頁」（HTTP 200） |
| 〔越權〕使用者管理 | `/users` | [host-x-users.png](screens/host-x-users.png) | 「你沒有權限檢視此頁」（HTTP 200） |
| 〔越權〕訂單匯入 | `/imports` | [host-x-imports.png](screens/host-x-imports.png) | 「你沒有權限檢視此頁」（HTTP 200） |
| 〔越權〕結算詳情 | `/finance/settlements/SET-20261028-0002` | [host-x-settlement.png](screens/host-x-settlement.png) | 「你沒有權限檢視此頁」（HTTP 200） |
| 〔越權〕其他團主詳情 OWN-0002 | `/hosts/OWN-0002` | [host-x-host-other-1.png](screens/host-x-host-other-1.png) | 「你沒有權限檢視此頁」（HTTP 200） |
| 〔越權〕其他團主詳情 OWN-0003 | `/hosts/OWN-0003` | [host-x-host-other-2.png](screens/host-x-host-other-2.png) | 「你沒有權限檢視此頁」（HTTP 200） |

## 廠商（demo-vendor）

| 畫面 | 路徑 | 截圖 | 結果 |
|---|---|---|---|
| 檔期清單 | `/campaigns` | [vendor-campaigns.png](screens/vendor-campaigns.png) | 200　檔期 |
| 檔期詳情（概覽） | `/campaigns/CMP-202610-0001` | [vendor-campaign-overview.png](screens/vendor-campaign-overview.png) | 200　[DEMO] 夏日防曬噴霧團購 進行中 |
| 任務清單 | `/tasks` | [vendor-tasks.png](screens/vendor-tasks.png) | 200　任務 |
| 廠商詳情 | `/vendors/VEN-0001` | [vendor-vendor-detail.png](screens/vendor-vendor-detail.png) | 200　[DEMO] 晴空保養 合作中 |
| 商品清單 | `/products` | [vendor-products.png](screens/vendor-products.png) | 200　商品 |
| 履約與出貨 | `/fulfillment` | [vendor-fulfillment-list.png](screens/vendor-fulfillment-list.png) | 200　履約與出貨 |
| 〔越權〕營運總覽 | `/dashboard` | [vendor-x-dashboard.png](screens/vendor-x-dashboard.png) | 「你沒有權限檢視此頁」（HTTP 200） |
| 〔越權〕財務結算 | `/finance` | [vendor-x-finance.png](screens/vendor-x-finance.png) | 「你沒有權限檢視此頁」（HTTP 200） |
| 〔越權〕團主清單 | `/hosts` | [vendor-x-hosts.png](screens/vendor-x-hosts.png) | 「你沒有權限檢視此頁」（HTTP 200） |
| 〔越權〕稽核紀錄 | `/audit` | [vendor-x-audit.png](screens/vendor-x-audit.png) | 「你沒有權限檢視此頁」（HTTP 200） |
| 〔越權〕訂單匯入 | `/imports` | [vendor-x-imports.png](screens/vendor-x-imports.png) | 「你沒有權限檢視此頁」（HTTP 200） |
| 〔越權〕售後案件清單 | `/aftersales` | [vendor-x-aftersales.png](screens/vendor-x-aftersales.png) | 可進入（見發現） |
| 〔越權〕其他廠商詳情 VEN-0002 | `/vendors/VEN-0002` | [vendor-x-vendor-other.png](screens/vendor-x-vendor-other.png) | 「你沒有權限檢視此頁」（HTTP 200） |
| 〔越權〕團主詳情 | `/hosts/OWN-0001` | [vendor-x-host-detail.png](screens/vendor-x-host-detail.png) | 「你沒有權限檢視此頁」（HTTP 200） |

## 客群分析與商品適配（SOP 01，營運主管）

> 這一組由 `scripts/e2e-smoke.ts`（Playwright，1440×900；手機版 390 寬）對示範資料庫截圖，資料為虛構 DEMO（含 `seed-demo-segments.ts` 建立的客群與評估）。建置前線框見 [16](WIREFRAMES.md#16-host-segments)、[17](WIREFRAMES.md#17-product-fit)、[18](WIREFRAMES.md#18-fit-overview)。

| 畫面 | 路徑 | 截圖 | 結果 |
|---|---|---|---|
| 團主詳情：客群分析 | `/hosts/OWN-0001` | [manager-host-segments.png](screens/manager-host-segments.png) | 200　顯示輪廓、動機、阻力、品類、週期、通路、觀察來源；價格帶未填顯示「未知」 |
| 商品頁：候選團主適配 | `/products/PRD-000006` | [manager-product-fit.jpg](screens/manager-product-fit.jpg) | 200　排名、總分、信心、完整度、硬性檢查、覆核；展開可看各維度 |
| 檔期：客群適配分頁 | `/campaigns/CMP-202610-0003?tab=fit` | [manager-campaign-fit.png](screens/manager-campaign-fit.png) | 200　說明不影響核准；單筆資料不足評估 |
| 客群適配總覽 | `/fit` | [manager-fit-overview.png](screens/manager-fit-overview.png) | 200　建議值待確認橫幅、待覆核清單 |
| 客群清單 | `/segments` | [manager-segments.png](screens/manager-segments.png) | 200 |
| 手機版總覽 | `/fit`（390 寬） | [manager-mobile-fit.png](screens/manager-mobile-fit.png) | 200　頁面無水平溢出（E2E 檢查）；評估表在容器內橫向捲動，「人工覆核」「理由」欄需向右捲才看得到 |

### 建置前線框 vs. 實際畫面的差異

| # | 項目 | 線框 | 實際 | 說明 |
|---|---|---|---|---|
| D1 | 客群卡片的「完整度」 | 區塊標題旁徽章（未建立／待補資料／完整） | 相同；另在每張客群卡底部列出「此客群待補：…」 | 實作時補上以客群為單位的缺漏提示 |
| D2 | 偏好的事實／估計標示 | 實線／虛線外框＋小字 | 實線／虛線外框＋小字「事實／估計」；編輯時點小字即可切換 | 與線框一致 |
| D3 | 評估表欄位 | 理由欄只有「▶ 各維度與理由」 | 相同；展開後另顯示評估時間、人員、評分設定版本與（結案後）成效 | 為保留證據鏈而補充 |
| D4 | 「資料不足」「硬性條件未過」列 | 分數灰字＋註明僅供參考 | 相同 | 與線框一致 |
| D5 | 檔期頁 | 線框 17 只畫商品頁 | 檔期頁新增「客群適配」分頁（表格同商品頁，另有「回寫結案成效」按鈕）；G1 核准區有一行唯讀提示 | 對應「檔期草稿→適配評估」「G1 選品核准→查閱」「結案→回寫成效」的流程串接 |
| D6 | 客群清單／詳情 | 線框未畫 | 新增 `/segments`、`/segments/[id]`（輪廓、連結團主、證據、版本與變更紀錄） | 共用客群需要獨立入口；尚無獨立線框 |
| D7 | 總覽的「已覆核」「全部」分頁 | 線框只畫待覆核並以文字說明 | 三個分頁＋評分設定表單（權重合計即時顯示、非 100 無法儲存） | — |
| D8 | 導覽 | 側欄「客群適配」（營運）與「客群」（主檔） | 相同；團主、廠商、財務沒有這兩項 | E2E 驗證 |

> 觀察：手機版評估表的「人工覆核」與「理由」欄在視窗外（可橫向捲動，非溢出）；`23`、`25` 截圖列表中的「[E2E] 新團主…」是 E2E 腳本每次執行建立的測試團主，不是 DEMO 種子資料；商品頁整頁截圖較大，故以 JPEG 儲存；全頁截圖中側欄與頂列會被截斷，屬截圖方式造成。

## 選品與試用（SOP 02／03，營運主管與小編）

> 這一組由 `scripts/e2e-smoke.ts`（Playwright，1440×900；手機版 390 寬）對示範資料庫截圖，資料為虛構 DEMO（含 `seed-demo-selection.ts` 建立的評估、合作資格審查、試用與可行性；證據連結為保留網域 `docs.example.invalid`）。截圖存放在 `docs/uat/screens/`（E2E 每次重跑會更新）。建置前線框見 [19](WIREFRAMES.md#19-vendor-diligence)、[20](WIREFRAMES.md#20-product-selection)、[21](WIREFRAMES.md#21-campaign-g1-summary)、[22](WIREFRAMES.md#22-trial-detail)。

| 畫面 | 路徑 | 截圖 | 結果 |
|---|---|---|---|
| 選品與試用總覽 | `/selection` | [26-selection.png](../uat/screens/26-selection.png) | 待 E2E 確認　建議值待確認橫幅、待覆核評估、審查中調查、待覆核試用、即將到期證據 |
| 廠商詳情：合作資格審查 | `/vendors/VEN-…` | [27-vendor-diligence.png](../uat/screens/27-vendor-diligence.png) | 待 E2E 確認　調查清單（合約版本、範圍、狀態、進度、有效期） |
| 合作資格審查詳情 | `/diligence/VDD-…` | [28-diligence.png](../uat/screens/28-diligence.png) | 待 E2E 確認　已核准、有效期、12 類卡片、法務標示 |
| 商品詳情：選品評估／試用／可行性 | `/products/PRD-…` | [29-product-selection.png](../uat/screens/29-product-selection.png) | 待 E2E 確認　80 分、建議進入商務審查、合規通過、已覆核；商品資格仍有效 |
| 檔期：選品與試用 | `/campaigns/CMP-…?tab=selection` | [30-campaign-selection.png](../uat/screens/30-campaign-selection.png) | 待 E2E 確認　決策摘要（燈號、風險）、本檔試用、相關任務 |
| 試用詳情 | `/trials/TRL-…` | [31-trial.png](../uat/screens/31-trial.png) | 待 E2E 確認　系統建議、四大面向檢核表 |
| 可行性詳情 | `/feasibility/FSB-…` | [32-feasibility.png](../uat/screens/32-feasibility.png) | 待 E2E 確認　試算結果、輸入與假設來源、版本 |
| 手機版總覽 | `/selection`（390 寬） | [33-mobile-selection.png](../uat/screens/33-mobile-selection.png) | 待 E2E 確認　無水平溢出（E2E 檢查） |

> 「待 E2E 確認」＝撰寫此表時 E2E 尚在重跑；實際通過數與逐項結果以 `docs/uat/e2e-results.json` 為準，不在此重複。

### 建置前線框 vs. 實際畫面的差異

| # | 項目 | 線框 | 實際 | 說明 |
|---|---|---|---|---|
| E1 | 客群適配參考 | 評估卡內一行唯讀文字 | 相同（需 fit.read 才顯示；財務不顯示） | 與線框一致 |
| E2 | 入口 | 線框只畫廠商、商品、檔期、試用頁 | 另新增 `/selection` 總覽與 `/feasibility/[id]` 可行性詳情（線框未畫） | 待辦與到期提醒、版本與實際回寫需要獨立頁 |
| E3 | 第 10 類（分潤）對無權限者 | 線框標註隱藏 | 條款、狀態、備註不回傳；證據只顯示種類與有效狀態；只能指派負責人與責任方 | 後端依 `product.cost.read` 決定，不靠畫面隱藏 |
| E4 | 導覽 | 側欄新增「選品與試用」（營運） | 相同；團主、廠商沒有此項，直接輸入網址顯示無權限 | E2E 驗證 |
| E5 | 試用清單 | 商品頁卡片內列表 | 相同；另在檔期「選品與試用」分頁列出本檔試用與相關任務（唯讀） | 對應「G1 選品核准→查閱」的流程串接 |

## 範圍探測（不截圖）

團主（demo-host1）與廠商（demo-vendor）分別依序開啟 5 檔期的詳情：

| 角色 | CMP-0001 | CMP-0002 | CMP-0003 | CMP-0004 | CMP-0005 |
|---|---|---|---|---|---|
| 團主（demo-host1） | 200 | 404 | 404 | 200 | 404 |
| 廠商（demo-vendor） | 200 | 404 | 200 | 404 | 404 |

> 200＝看得到；404＝在資料範圍外（後端回 404，不洩漏是否存在）。

## 發現（只列觀察，未修改程式）

| # | 嚴重度 | 發現 | 證據 | 建議 |
|---|:-:|---|---|---|
| W1 | 🟡 | **沒有權限的頁面 HTTP 狀態碼是 200**（畫面顯示「你沒有權限檢視此頁」）。瀏覽器看起來正常，但監控、日誌與自動化測試無法用狀態碼分辨「被擋」和「成功」 | editor／finance／host／vendor 的 `x-*` 畫面，log 全部 200 | 無權限頁回 403；或至少在日誌標記 |
| W2 | 🟢 | **找不到頁面是 Next.js 預設英文 404**（「404 This page could not be found.」），不是繁中，也沒有回首頁按鈕；團主／廠商看自己範圍外的檔期會看到這個 | `host-probe`／`vendor-probe` 5 檔期探測；manager 開不存在的網址 | 補繁中 `not-found.tsx`（含回首頁） |
| W3 | 🟢 | **同一種「不該看」有兩種畫面**：範圍外的檔期是 404；範圍外的團主／廠商詳情是「你沒有權限檢視此頁」（200）。另外，團主開**不存在**的 `OWN-9999` 與開別人的 `OWN-0002` 畫面相同，所以沒有洩漏資料是否存在 ✅，但體驗不一致 | `host-x-host-other-*`、`vendor-x-vendor-other`；`host /hosts/OWN-9999` | 統一成同一種（建議都用繁中 404） |
| W4 | 🟢 | 「你沒有權限檢視此頁」下面的說明寫「沒有權限執行此操作」，措辭偏向「操作」而不是「檢視」 | 任一 `x-*` 截圖 | 文案改為「你的角色無法檢視此頁，如需使用請聯絡管理者」 |
| W5 | 🟢 | **空狀態沒有被這次截圖覆蓋**：示範資料很完整，所以多數列表都有資料；空狀態文案（如「沒有符合條件的檔期」）只在程式碼裡確認存在，沒有畫面證據 | — | 之後用空資料庫補一組空狀態截圖 |
| W6 | ✅ | 敏感字詞檢查：團主與廠商的所有頁面（含商品詳情、檔期、履約、售後、結算）**都沒有出現「成本」「毛利」「目標營收」「內部備註」**；成本只在主管與財務的商品詳情出現；小編的商品詳情沒有成本 | 各頁面文字比對（見 log） | — |
| W7 | ✅ | 權限邊界符合預期：小編不能進財務／稽核／自動化／使用者；財務不能進使用者／自動化／建立檔期／我的結算；團主不能進總覽／財務／稽核／廠商／使用者／匯入；廠商不能進總覽／財務／團主／稽核／匯入 | 各 `x-*` 截圖 | — |
| W8 | ⚠️ | 廠商可以進入「售後」頁（有總覽數字與案件）。這符合目前權限設計（`aftersales.read` 唯讀、依範圍），但需確認「廠商是否應看到售後案件」是 Owner 想要的 | `vendor-x-aftersales.png` | 列入週二待決事項 |
| W9 | 🟢 | 頁面 JS 錯誤：只有範圍外檔期 404 時瀏覽器主控台出現「Failed to load resource（404）」，屬預期；其他頁面沒有 JS 錯誤 | log `jsErrors` | — |
