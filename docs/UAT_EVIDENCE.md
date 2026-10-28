# UAT 證據

> 這是**開發者在隔離環境、用虛構 DEMO 資料**做的煙霧驗證，**不是業務驗收**。Owner／試點團隊的 UAT 尚未進行。
> 證據檔：`docs/uat/e2e-results.json`（逐項結果）、`docs/uat/screens/*.png`（畫面截圖）。重現：見下方「重現方式」。

## 驗證環境

本機 PostgreSQL 16、`next start`（production build）、DEMO 資料（`npm run db:seed:demo`，名稱皆以 `[DEMO]` 開頭、訂單 `data_origin=DEMO`、密碼為本機測試用）。

## 結果：49/49 通過（2026-10-28）

| 類別 | 驗證項目 | 結果 |
|---|---|:-:|
| 健康檢查 | `GET /api/health` 回報資料庫連線 up | ✅ |
| 認證 | 未登入進入受保護頁面 → 導向登入；錯誤密碼顯示模糊訊息；未登入呼叫 API → 401；登出後 session 失效 | ✅ ×4 |
| 管理者（營運主管） | `/dashboard` 顯示 DEMO 橫幅、資料品質、KPI 與口徑；17 個頁面（檔期、日曆、任務、核准、廠商、團主、社群、商品、匯入、例外、自動化、稽核、通知、5 個新增頁）皆 HTTP 200、無 console error | ✅ ×22 |
| 自動化頁 | 明示「預設全部停用」「測試 Adapter」「不會對任何真人發送」 | ✅ |
| 檔期 | 列表可找到 DEMO 檔期；詳情顯示狀態與廠商；任務分頁依八階段分組；**日期調整先預覽（15 個任務的前後值）**、預覽後才出現確認；**預覽不改動資料** | ✅ ×6 |
| 團主（demo-host1） | `/dashboard/host` 有我的檔期與「預估」佣金，**頁面不含其他團主名稱**；`/dashboard`、`/vendors`、`/users` 顯示無權限；檔期列表只有自己的 | ✅ ×7 |
| 廠商（demo-vendor） | 檔期列表可開；`/hosts`、`/imports` 顯示無權限 | ✅ ×3 |
| 手機（390px） | `/dashboard`、`/campaigns`、`/tasks` 無水平溢出（0px） | ✅ ×6 |

## 截圖（`docs/uat/screens/`）

| 檔案 | 內容 |
|---|---|
| `00-login.png` | 登入頁 |
| `01-admin-dashboard.png` | 管理者 Dashboard（DEMO 橫幅、資料截止時間、KPI、管線、逾期、團主績效） |
| `02-campaigns.png`、`03-calendar.png`、`04-tasks.png`、`05-approvals.png` | 檔期、排程日曆、任務、核准 |
| `06-vendors.png`、`07-imports.png`、`08-exceptions.png`、`09-automation.png` | 廠商、匯入、例外、自動化 |
| `10-campaign-detail.png`、`10b-campaign-tasks.png`、`11-reschedule-preview.png` | 檔期詳情、八階段任務、日期調整預覽 |
| `12-host-dashboard.png` | 團主 Dashboard |
| `13-vendor-campaigns.png` | 廠商視角的檔期列表 |
| `14-mobile-dashboard.png`、`15-mobile-campaigns.png` | 手機寬度 |

## 頁面路徑與角色

| 路徑 | 管理者／營運主管 | 營運小編 | 財務 | 團主 | 廠商 |
|---|:-:|:-:|:-:|:-:|:-:|
| `/dashboard` | ✅ | ✅（自己的檔期） | ✅ | ✕ | ✕ |
| `/dashboard/host` | 預覽（`?hostId=`） | 預覽 | 預覽 | ✅（自己） | ✕ |
| `/campaigns`、`/campaigns/[id]` | ✅ | ✅（自己的） | ✅（唯讀） | ✅（自己的，限制欄位） | ✅（自己廠商的，限制欄位） |
| `/calendar`、`/tasks`、`/approvals` | ✅ | ✅ | 部分 | 僅自己的任務 | 僅自己的任務 |
| `/vendors`、`/hosts`、`/communities`、`/products` | ✅ | ✅ | 唯讀 | 僅自己（團主／社群） | 僅自己（廠商／商品） |
| `/imports` | ✅ | ✅ | 唯讀 | ✕ | ✕ |
| `/exceptions` | ✅ | ✅（自己負責的） | 唯讀 | ✕ | ✕ |
| `/automation` | ✅ | ✕ | ✕ | ✕ | ✕ |
| `/audit` | ✅ | ✕ | ✅（僅財務相關） | ✕ | ✕ |
| `/users` | 僅系統管理者 | ✕ | ✕ | ✕ | ✕ |

（以測試與權限矩陣為準：`tests/rbac.test.ts`、`tests/unit/misc.test.ts`。）

## DEMO 帳號（只存在於本機 DEMO 資料庫，密碼由 `DEMO_PASSWORD` 決定，不在 repo 內）

`demo-admin`、`demo-manager`、`demo-editor`、`demo-finance`、`demo-host1`、`demo-host2`、`demo-vendor`（皆 `@example.invalid`）。

## 重現方式

```bash
npm ci && npm run db:migrate && npm run db:seed && DEMO_PASSWORD='<自訂>' npm run db:seed:demo
npm run build
E2E_PASSWORD='<同 DEMO_PASSWORD>' npm run e2e        # 自行啟動 next start（port 3100），結果寫入 docs/uat/
```

## 尚未驗證

Owner／團隊的實際操作驗收、跨瀏覽器、真實資料、結算與廠商入口（尚未實作）、檔期建立等寫入流程的完整手動旅程（寫入行為已由 API／整合測試覆蓋；前端寫入互動在開發階段由前端建置者以瀏覽器腳本手動驗證過 31/32 項，該腳本未納入 repo）。
