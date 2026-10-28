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
     ├─ lib/        config、db（pg Pool、交易）、ids、dates、permissions、scope（資料範圍）、audit、idempotency、kpi、csv、password、repo
     ├─ modules/    auth、vendors、hosts(含社群)、products、campaigns、conflicts、tasks、gates(核准/狀態)、orders(匯入)、commission、
     │              dashboard、automation、notifications、intake、audit-read、org
     └─ workflow/   schedule（排程引擎，純函式）、state（狀態機，純資料）、templates、template-default
   │
   ▼
PostgreSQL 16（43 張表；觸發器：禁止 DELETE、稽核不可改、updated_at/version 自動維護）
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

## 3. 目錄

```
migrations/            8 支 SQL（001 基礎 … 008 冪等雜湊）；不可修改已套用的檔案
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
