# 測試報告

> 執行日期：2026-10-28｜環境：Linux、Node v22.22.0、PostgreSQL 16.15（本機）、Chromium（Playwright 1.63 預裝）
> 本報告只記錄**實際執行過**的指令、退出碼與輸出摘要；沒有執行的項目明確寫「未執行」。分支：`feat/erp-mvp-phase1`。

## 1. 指令與結果

| 檢查 | 指令 | 退出碼 | 結果 |
|---|---|:-:|---|
| Typecheck | `npm run typecheck`（`tsc --noEmit`） | 0 | 無錯誤 |
| Lint | `npm run lint`（`eslint .`） | 0 | 0 error、0 warning |
| 單元＋整合＋API＋RBAC＋情境＋Migration | `npm test`（`vitest run`） | 0 | **14 個檔案、245 項測試全部通過**（約 12 秒；含 Phase 2 新增履約 29、售後 31、財務 22，另有 CSRF 比對測試） |
| Build | `npm run build`（`next build`） | 0 | 成功，36 個頁面路由＋1 個 API 入口 |
| E2E 煙霧測試 | `E2E_PASSWORD=… npm run e2e` | 0 | **49/49 通過**（`docs/uat/e2e-results.json`） |
| DEMO 種子 | `npm run db:seed:demo` | 0 | 4 檔團購、110 張虛構訂單 |
| 文件產生 | `npm run docs:gen` | 0 | 43 張表、79 個外鍵、79 個端點 |
| Worker 安全預設 | `npm run worker:once`（`AUTOMATION_ENABLED` 未設為 on） | 0 | 不執行任何自動化並說明原因 |
| 相依套件弱點 | `npm audit --omit=dev` | 1（有弱點） | 3 項（1 moderate、2 high），見 KNOWN_ISSUES T3 |
| CI（GitHub Actions） | `.github/workflows/ci.yml`（typecheck／lint／test／build） | — | **success**（提交 `bcd944d`，push 與 PR 各一次：[run 40657504352](https://github.com/ws19135/group-buying-operations/actions/runs/40657504352)、[run 40657524435](https://github.com/ws19135/group-buying-operations/actions/runs/40657524435)）；CI 不含 E2E |

## 2. 自動化測試明細（`npm test`）

| 測試檔 | 項數 | 涵蓋 |
|---|:-:|---|
| `tests/unit/schedule.test.ts` | 15 | 預設模板（15 步、八階段）、SOP 日期鏈、錨點日期、選擇性任務、缺錨點不亂排、排程衝突、天數參數、穿透、循環／缺相依偵測、日期變更影響預覽（已完成／鎖定／條件改變／參數變更） |
| `tests/unit/kpi.test.ts` | 8 | GMV／淨銷售／有效訂單／AOV／退款率口徑、無資料為 null、資料庫彙總版等價、達成率、預估佣金、資料狀態 |
| `tests/unit/misc.test.ts` | 25 | 日期工具、名稱正規化、CSV 解析、密碼、**權限矩陣鎖定**、狀態機一致性、分潤％與下單時間解析、稽核遮蔽、限流、資料範圍 SQL、冪等鍵粒度 |
| `tests/database.test.ts` | 14 | Migration 冪等與 checksum、43 張表與多租戶欄位、索引、**禁止實體刪除（全部業務表）**、稽核不可改、唯一／CHECK／外鍵約束、版本由觸發器維護、ID 規則 |
| `tests/campaign-basic.test.ts` | 1 | 建立檔期自動產生 15 任務與日期 |
| `tests/lifecycle.test.ts` | 8 | **草稿→結案完整走過 G1–G5**、關卡檢查與核准角色、狀態機防呆、退回、申請人≠核准人設定、取消／暫緩、團主回覆 |
| `tests/reschedule.test.ts` | 8 | 預覽不寫入、套用需代碼、預覽後變動則失效、鎖定／已完成不被覆寫、條件任務、日期驗證、已排程需原因與權限、**修改預設天數不覆寫既有檔期** |
| `tests/rbac.test.ts` | 21 | 未登入 401、登入／鎖定／停用／過期、CSRF、**團主資料隔離**（含跨團主讀取）、**廠商資料隔離**、成本／目標／內部備註不外洩、角色分權、跨組織隔離 |
| `tests/orders-dashboard.test.ts` | 19 | 無資料→待串接、CSV 匯入（去重／更新／錯誤佇列／checksum／檔案層錯誤／取消檔期）、**KPI 與手算一致**、管理端與團主端同口徑、預估佣金與規則版本、DEMO 標示、資料延遲與錯誤警告、敏感欄位不經 Dashboard 外洩 |
| `tests/automation.test.ts` | 17 | 預設停用、啟停與稽核、每日摘要冪等、事件處理冪等、逾期／未回覆／催辦、開團前檢查、狀態推進、**失敗→重試**、**外部通知失敗→DEAD→例外**、進件去重／配對／人工確認 |
| `tests/scenarios.test.ts` | 26 | 同商品重複開團、多 SKU、多團主、同團主多社群、日期衝突、**重複送出（含並發 8 請求、並發建立同名）**、冪等鍵內容不符、取消／封存、API 錯誤格式、樂觀鎖、驗證、連結 scheme、413、清空欄位／取消指派 |

> 任務要求的情境對照：同一商品重複開團✅｜一檔多 SKU✅｜一檔多團主✅｜同團主多社群✅｜日期衝突✅｜團主未回覆✅（`automation`）｜團購取消✅（`lifecycle`）｜重複表單送出✅｜權限越界✅（`rbac`）｜訂單缺漏與資料延遲✅（`orders-dashboard`）｜外部整合不可用✅（`automation`）。

## 3. 測試方法的說明（為什麼可信、哪裡不是）

- 整合測試使用**真實 PostgreSQL**（不是 mock）；每次 `npm test` 先重建測試資料庫（資料庫名稱必須含 `test`，否則拒絕執行）。每個測試檔建立獨立的組織，因此跨組織隔離同時被持續驗證。
- API 測試透過與正式相同的 `dispatch()` 路由與真實登入（cookie），不是直接呼叫服務。
- **測試在開發中抓到的真實缺陷**（已修正並留有回歸測試）：
  1. G4 關卡缺少「請款已完成」的硬性檢查（`lifecycle.test.ts` 失敗而發現）。
  2. 外部角色對「看不到的任務」寫入時回 403、讀取回 404，會洩漏任務是否存在（`rbac.test.ts`）。
  3. 日期預覽把「鎖定任務與自然排程不同」誤判為「這次變更會動到它」（`reschedule.test.ts`）。
  4. 自動化的預設冪等鍵若為「每日」，新進件要等到隔天才處理（改為分鐘／小時粒度，`unit/misc.test.ts`）。
  5. 管理者 Dashboard 的目標欄位對沒有 `campaign.sensitive.read` 的營運小編外洩（撰寫規格文件時發現，補上 `orders-dashboard.test.ts`）。
  6. 連結欄位未限制 scheme（可存入 `javascript:`）；空字串無法清空欄位；團主社群角色與取消指派被忽略（前端驗證時發現）。
- **限制**（誠實揭露）：沒有做「突變測試」（刻意弄壞程式看測試是否變紅），所以測試強度是以情境涵蓋與上述抓到缺陷的紀錄作為間接證據；沒有負載測試；E2E 只覆蓋煙霧層級（頁面可開、權限導向、日期預覽、手機寬度、登出），不是完整的使用者旅程；沒有跨瀏覽器；KPI 口徑（ADR-010）尚未經 Owner／財務確認，測試只證明「程式符合所寫的口徑」。

## 4. 未執行／無法執行

| 項目 | 原因 |
|---|---|
| 真實外部整合（LINE／Email／電商 API／Google） | 無憑證與授權（BLOCKED） |
| 與真實歷史結案數字的手工對帳 | 沒有真實資料 |
| 備份還原演練、負載／壓力、SAST | 未執行 |
