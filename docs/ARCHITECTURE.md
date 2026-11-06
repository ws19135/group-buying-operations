# 系統架構

> 決策理由見 [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md)。資料表與關聯見 [generated/DATA_DICTIONARY.md](generated/DATA_DICTIONARY.md)、[generated/ERD.md](generated/ERD.md)。

## 1. 邏輯架構（模組化單體）

```
瀏覽器（管理端／團主端；繁體中文）
   │  HTTPS（內部網路或受保護的反向代理；不做匿名公開）
   ▼
Next.js 15（App Router）
 ├─ src/app/(app)/**         伺服器元件：直接呼叫服務層；互動用 client component → /api
 ├─ src/app/api/[...path]    單一 API 入口 → src/server/api/router.ts（CSRF、JSON、錯誤統一、requestId）
 │                              └─ routes.ts（路由表，每個端點呼叫一個服務函式）
 └─ src/server/              ★ 與框架無關的服務層（本系統的核心）
     ├─ lib/        config、db（pg Pool、交易）、ids、dates、permissions、scope（資料範圍）、audit、idempotency、kpi、csv、password、repo、
     │              collaboration-rules（合作申請的純規則：狀態機、樣品進度推導、個資保留政策）
     ├─ modules/    auth、vendors、hosts(含社群)、products、campaigns、conflicts、tasks、gates(核准/狀態)、orders(匯入)、commission、
     │              dashboard、automation、notifications、intake、audit-read、org、
     │              fulfillment、aftersales、settlements／finance（Phase 2）、
     │              collaboration、collaboration-import（合作申請與樣品管理）
     └─ workflow/   schedule（排程引擎，純函式）、state（狀態機，純資料）、templates、template-default
   │
   ▼
PostgreSQL 16（76 張表；觸發器：禁止 DELETE、稽核不可改、updated_at/version 自動維護）
   ▲
Worker（scripts/worker.ts）— 預設關閉；讀 events（outbox）、跑 8 個自動化工作、派送通知（僅測試 Adapter）
```

- 每個服務函式的簽名是 `fn(actor, input)`：**授權、資料範圍、驗證、交易、稽核都在服務層**，API 與頁面都只是呼叫它，所以沒有「前端隱藏、後端沒擋」的路徑。
- 領域事件採 Transactional Outbox：與業務資料同一交易寫入 `events`，由 worker 處理（建立任務、通知）；處理本身冪等。

## 2. 核心不變條件（測試鎖住）

| 不變條件 | 實作 | 測試 |
|---|---|---|
| 沒有實體刪除 | 觸發器＋API 無 DELETE | `database.test.ts` |
| 稽核不可竄改 | 觸發器 | `database.test.ts` |
| 外部角色看不到他人資料／內部欄位 | `campaignScope` + 欄位投影 | `rbac.test.ts` |
| 跨組織完全隔離 | `organization_id` 條件 | `rbac.test.ts` |
| 狀態只能依轉移表變動；Gate 不能繞過 | `state.ts` + `gates.ts` | `lifecycle.test.ts` |
| 排程不覆寫已完成／鎖定任務；變更需預覽確認 | `schedule.ts` + `campaigns.ts` | `unit/schedule`、`reschedule.test.ts` |
| 重複送出／重複匯入／重複執行不產生重複資料 | 冪等鍵、唯一索引、checksum | `scenarios`、`orders-dashboard`、`automation` |
| 沒有訂單就沒有業績數字；DEMO 明確標示 | `kpi.ts`、`dashboard.ts` | `orders-dashboard.test.ts` |
| 自動化預設停用、可停用、有紀錄、失敗可重試 | `automation.ts` | `automation.test.ts` |
| 合作申請不碰 G1～G5、庫存、訂單、財務、任務引擎 | `collaboration.ts`（`gateImpact: 'NONE'`；不寫 `approvals`） | `collaboration.test.ts`（固定各表筆數不變） |
| 收件個資不出現在詳情與匯出；逐次讀取寫稽核；保留期自動重算 | `collaboration_recipients` ＋ `collaboration-rules.ts` | `collaboration-rbac.test.ts`（哨兵字串掃描） |

## 3. 目錄

```
migrations/            28 支 SQL（001 基礎 … 009 履約、010 售後、011 財務 … 027 費用更正、028 合作申請與樣品管理）；不可修改已套用的檔案
scripts/               migrate、seed、seed-demo、reset-db、worker、gen-docs、e2e-smoke
src/app/               Next.js 頁面與 API 入口
src/server/            服務層（見上）
src/ui/                共用 UI 元件
tests/                 單元＋整合＋RBAC＋情境（真實 PostgreSQL）
docs/                  規格、決策、矩陣、報告；docs/generated 為自動產生
```

## 4. 安全基線（已做／未做）

| 項目 | 狀態 |
|---|---|
| 密碼 scrypt、session 只存雜湊、HttpOnly+SameSite cookie、production 加 Secure | ✅ |
| 登入限流＋帳號鎖定＋模糊錯誤訊息 | ✅（限流為單機記憶體） |
| 寫入類請求檢查 Origin／Content-Type（CSRF 防護） | ✅ |
| 後端授權＋資料範圍、欄位投影 | ✅ |
| 錯誤回應不洩漏內部細節（只給 requestId） | ✅ |
| 機密不進 repo（`.env.example` 只有範例值；`.env*` 被忽略） | ✅ |
| 回應標頭：X-Frame-Options DENY、nosniff、no-store | ✅ |
| SSO／OAuth、MFA | ❌ 未做（需 Owner 決定） |
| 密碼重設／首次登入強制改密碼 | ❌ 未做（欄位已預留 `must_change_password`） |
| 資料庫 Row-Level Security、靜態加密、備份還原演練 | ❌ 未做（見 DEPLOYMENT.md） |
| 速率限制的共用儲存（多實例） | ❌ 未做 |

## 5. 合作申請與樣品管理（COLLABORATION_APPLICATIONS，2026-11-06 新增）

> 設計、權限矩陣與 UAT 紀錄：[phase2/INFLUENCER_SAMPLE_APPLICATION.md](phase2/INFLUENCER_SAMPLE_APPLICATION.md)。程式：`src/server/modules/collaboration.ts`、`collaboration-import.ts`，純規則 `src/server/lib/collaboration-rules.ts`，資料表 `migrations/028_collaboration_applications.sql`。入口：內部「合作管理 → 網紅合作申請」、廠商「廠商工作台 → 網紅申請與樣品寄送」、團主「團主工作台 → 我的樣品申請」。

| 資料表 | ID 前綴 | 存什麼 |
|---|---|---|
| `collaboration_applications` | `CLB-` | 申請主檔：團主、廠商、來源、申請狀態（9 種）、合作狀態（7 種）、檔期與試用的選填關聯 |
| `collaboration_application_items` | `CLI-` | 申請的商品／規格明細與廠商供樣狀態 |
| `collaboration_recipients` | `CRP-` | 收件人姓名／電話／地址（個資：獨立表、獨立權限、有保留期） |
| `collaboration_shipments` | `CSP-` | 每一次寄送（首次／補寄）與各自的物流狀態 |
| `collaboration_launch_details` | `CLD-` | 開團意願、預計／確認開團日、「後台設定 Mail」（只記聯絡信箱與設定狀態） |
| `collaboration_events` | 無業務 ID（append-only） | 六個維度的事件時間軸 |
| `collaboration_import_rows` | `CIR-` | 表單一／表單二匯入的逐列暫存與人工確認結果 |

ID 一律 6 位補零（`src/server/lib/ids.ts`）；匯入批次沿用既有 `import_batches` 與 `IMP-YYYYMMDD-0001` 編號。權限新增 11 項（`collaboration.*`，全系統合計 63 項），其中 `collaboration.self` 管「只看自己」、`collaboration.pii.read` 管收件個資，財務角色刻意一項都沒有。

刻意不做的部分（都有測試固定筆數不變）：不寫入 `approvals`／不影響 G1～G5、不扣庫存、不產生財務或結算紀錄、不建平行任務引擎（`tasks.campaign_id` 為 NOT NULL）、不自動寄任何通知、不自動建立團主主檔。**尚未部署，廠商入口在完成對外存取安全驗證前不得開放到正式／公開環境。**

> 結帳：SAD §13 的 #1／#16／#20 曾註記本文的資料表數量與模組清單落後於程式（「尚未涵蓋 65 張表與新模組」）。2026-11-06 已對齊 76 張表、28 支 migration，並補上 `collaboration`／`collaboration-import` 與上表 7 張表；該落差在本文結清，資料表欄位的完整定義仍以 `npm run docs:gen` 產出的 [generated/DATA_DICTIONARY.md](generated/DATA_DICTIONARY.md)、[generated/ERD.md](generated/ERD.md) 為準。
