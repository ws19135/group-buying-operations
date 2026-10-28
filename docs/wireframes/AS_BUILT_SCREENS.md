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
