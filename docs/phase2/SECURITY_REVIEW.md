# 獨立安全與資料正確性審查（Phase 2 為主，涵蓋整個 API）

> 範圍：授權與資料範圍、存在性洩漏、輸入驗證、交易與併發、資料不變條件、前端欄位外洩、KNOWN_ISSUES 的 K4／K6。
> 方法：先寫會失敗的測試證明問題存在（紅），再修，再轉綠；每個修正都用「還原舊版程式後新測試必須變紅」驗證。
> 環境：本機 PostgreSQL 16、測試資料庫 `erp_rev_test`；沒有碰任何正式資料、沒有部署、沒有寄出任何通知。

## 1. 結論

- 全套測試 **16 檔 305 項通過**（審查前 14 檔 245 項；新增 60 項，其中 53 項在 `tests/security-phase2.test.ts`、7 項在 `tests/security-fuzz.test.ts`）。`tsc`、`eslint` 乾淨；全套執行期間伺服器端 `unhandled` 錯誤紀錄為 0（審查前模糊測試會刷出大量）。
- 授權面（IDOR、跨組織、外部角色欄位、權限矩陣）**第一次執行就全數通過**，沒有發現越權讀寫。
- 共發現 **17 項**問題（中 5、低 12，含 K4／K6）；**16 項已修**，1 項（R4 退款餘額）部分緩解；另有需要 Owner 決策的觀察項列在第 5 節。沒有發現「嚴重」或「高」等級的問題。

| 嚴重度 | 數量 | 已修 |
|---|:-:|:-:|
| 高／嚴重 | 0 | — |
| 中 | 5 | 4 修、1 部分緩解 |
| 低 | 12 | 12 |

## 2. 發現與修正

| # | 級 | 發現 | 重現（測試） | 修正 | 舊版變紅的證據 |
|---|:-:|---|---|---|---|
| R1 | 中 | 重複送出保護（`Idempotency-Key`）的雜湊沒有包含網址上的父層 id：同一把 key＋同樣內容＋不同檔期（或不同批次）建立批次／出貨單，會**回放另一個檔期的結果**，而且根本沒建立新資料；另外 key 也沒綁定送出者，另一位使用者用同一把 key 會取回別人的結果 | D 組 2 項、J「綁定送出者」 | `createBatch`／`addShipment` 的 payload 加入 `campaignId`／`batchId`；`idempotent()` 的雜湊納入 `actor.userId` | 還原 `fulfillment.ts` → D 組 2 項紅；還原雜湊行 → 「綁定送出者」紅 |
| R2 | 中 | **訂單匯入沒有套用檔期資料範圍**：營運小編可以把訂單匯入任何檔期（包含看不到的、非自己負責的），訂單會餵進佣金與結算 | J「訂單匯入套用檔期資料範圍」 | `importOrders` 每個檔期都經 `campaignScope`；範圍外與不存在的訊息相同（`UNKNOWN_CAMPAIGN`） | 還原 `orders.ts` → 紅 |
| R3 | 中 | 入帳（`payments`）已關聯結算項目後，可以只改 `campaignId`，讓入帳的檔期與結算項目所屬檔期不一致（或清空檔期只留項目） | F 組 | `updatePayment`：已關聯項目且未更換項目時，檔期必須等於該項目的檔期 | 還原 `finance.ts` → 紅 |
| R4 | 中 | 退款「已完成但未寫回訂單」的金額不會出現在 `orders.refund_amount`，申請新退款時被忽略，**同一張訂單可被重複全額退款** | I 組 | 可退餘額改取 `max(訂單已記錄退款, 本系統已完成退款合計)`；匯入反映後兩者重疊也不會重複計算 | 還原 `aftersales.ts` → 紅 |
| R5 | 中 | 確認結算（鎖定金額）時，「過期檢查」與提交之間若有訂單匯入或退款寫回，會得到與實際訂單對不上的已確認結算（TOCTOU） | M 組 2 項 | `confirmSettlement` 取得與匯入相同的 advisory lock，並對該檔期訂單列 `FOR SHARE`；提交後金額若已變動，過期檢查會擋下 | 還原 `settlements.ts` → 2 項紅 |
| R6 | 低 | 資料庫觸發器 `settlement_children_guard` 只看 `NEW.settlement_id`：繞過 API 直接改 SQL，可把「已確認結算」的項目搬到另一份草稿結算並改金額 | E 組「搬移繞過鎖定」 | migration `012_security_hardening.sql`：同時檢查 OLD 與 NEW，且禁止搬移 | 暫時移走 012 → 紅 |
| R7 | 低 | `Cookie` 的百分比編碼損壞（`%`、`%E0%A4%A`）→ `decodeURIComponent` 丟例外 → **每個請求 500** | J「壞的 cookie」、模糊測試 | `parseCookie` 捕捉例外，視為沒有 session（401） | 還原 `auth.ts` → 紅 |
| R8 | 低 | 查詢參數、路徑或 JSON 內含 NUL 字元（`%00`、`\u0000`）→ PostgreSQL 22021 → 500（影響約 13 個列表端點） | J「NUL 字元」、模糊測試 | 路由入口擋下（422／404）；另把 22021／22P05 對映為 422 作為保險 | 還原 `router.ts` → 紅 |
| R9 | 低 | `page=1e999` → `OFFSET Infinity` → 500（所有列表端點） | J「分頁」2 項 | `pageParams`：非有限值回預設、page 上限 1,000,000、取整 | 還原 `repo.ts` → 2 項紅 |
| R10 | 低 | `GET /audit?limit=-5` → 負的 `LIMIT` → 500 | J「列表 API」 | `limit` 下限 1、非數字回 100；並把 2201W／2201X 對映為 422 | 還原 `audit-read.ts` → 紅 |
| R11 | 低 | 匯入 CSV 中一列數量／單價異常大（如 `99999999999999999999`）→ 整批匯入因資料庫錯誤失敗，而不是只讓該列進錯誤佇列 | J「異常大的數量」 | 數量上限 1,000,000、單價上限 100,000,000，超過該列進 `import_errors`（`BAD_QUANTITY`／`BAD_PRICE`） | 還原 `orders.ts` → 紅 |
| R12 | 低 | 庫存頁 `sum(delta)::int` 在加總超過 21 億時溢位，整頁失敗 | J「int 範圍」 | 改 `::bigint` | 還原 → 紅 |
| R13 | 低 | 登入鎖定期滿後 `failed_login_count` 沒有重置：期滿後只要再輸錯一次，立刻再鎖 15 分鐘 | J「登入鎖定期滿」 | 鎖定期滿的第一次失敗重新計數為 1、解除鎖定欄位 | 還原 `auth.ts` → 紅 |
| R14 | 低 | 財務角色的稽核紀錄只看得到舊的 5 種實體，看不到 Phase 2 的入帳、發票、費用、結算項目、退款 | J「財務人員的稽核紀錄範圍」 | `FINANCE_ENTITIES` 補上這 6 種 | 還原 `audit-read.ts` → 紅 |
| R15 | 低 | 路由層對無法編碼的路徑片段（孤立代理字元）丟 `URIError` → 500（防禦性；Next 通常先正規化） | J「孤立的代理字元」 | `dispatch` 捕捉，回 400 | 還原 `router.ts` → 紅 |
| K4 | 低 | `SESSION_SECRET` 從未被任何程式使用（`sessionSecret()` 無呼叫者），文件卻說 production 必須設定 | grep 證實 | 移除 `sessionSecret()`、`.env.example`、`render.yaml`、CI、`vitest.config`、`e2e-smoke`、部署文件的相關說法；殘留的環境變數無影響 | — |
| K6 | 低 | `idempotency_keys` 永遠不清 | J「K6」 | `purgeExpiredIdempotencyKeys()`：只清**本組織**、**超過 30 天**者；由既有每日工作 `daily_summary` 呼叫（預設停用、需管理者啟用；`stats.idempotencyKeysPurged` 記錄筆數）。沒有新增觸發器、沒有新增第 9 個工作（避免全文件「8 個工作」不一致） | 拿掉呼叫 → 紅 |

> 註：K6 是技術性去重快取的實體刪除，不是業務資料，因此未走軟刪除；若 Owner 仍想完全禁止實體刪除，可改成標記過期（見第 5 節）。

## 3. 審查後確認「沒問題」的項目（第一次執行就通過）

| 面向 | 做法 | 結果 |
|---|---|---|
| 存在性洩漏（IDOR 預言機） | 30 條 Phase 2 端點＋13 條 Phase 1 端點 × 團主乙／廠商乙／非負責人小編／他組織管理者：「範圍外的真實 id」與「不存在的 id」的狀態碼與錯誤碼必須完全相同，且絕不能成功 | 全部一致 |
| 外部角色欄位 | 團主甲、廠商甲呼叫 16 個讀取端點：不得含批次／出貨單備註、案件描述與內部備註、內部處理紀錄、退款原因、覆寫與調整原因、入帳與費用備註、乙檔期的任何 id、成本與目標欄位 | 無洩漏 |
| 權限矩陣 | 團主／廠商對所有寫入端點 403；小編無任何財務權限；財務無履約與售後寫入；主管不能確認結算／完成退款；未登入一律 401 | 全數符合 |
| 資料不變條件 | `inventory_movements`、`case_events`、`settlement_adjustments`、`audit_logs` 直接用 SQL 嘗試 UPDATE／DELETE 皆被擋；9 張 Phase 2 業務表無法實體 DELETE | 全數被擋 |
| 稽核覆蓋 | 實際執行 36 個 Phase 2 寫入動作，每一個前後 `audit_logs` 都增加 | 全數有稽核 |
| 併發 | 同一退款並發完成（只寫回一次）、庫存並發扣減（不為負、成功筆數恰好）、同一追蹤碼並發新增（1 成功其餘 409）、同一庫存異動並發更正（只一次）、同一檔期並發建立結算（1 成功其餘 409）、同 key 並發 5 筆（只建立 1 筆） | 全部正確、無 500 |
| 輸入邊界 | 12 種壞的金額／數量（負數、小數、`1e21`、字串、陣列、物件、`2^53`…）、9 種壞日期、10 萬字元字串、不明欄位與 `status`／`organization_id` 覆寫（mass assignment）、特殊路徑、查詢注入字元 | 一律 4xx 或被忽略，沒有寫入 |
| 模糊測試 | 每條路由 × 6 個角色 × 假／真 id × 8 種壞 body × 7 種壞 query | 修正後 0 個 5xx |
| 前端 | 檢視履約、售後頁：外部角色的欄位在服務層就已投影；只有可寫的內部角色才會把備註帶進表單的預設值 | 無外洩 |

## 4. 新增的測試與 migration

- `tests/security-phase2.test.ts`（53 項）：A 存在性洩漏、A2 Phase 1 資源、B 欄位洩漏、C 權限矩陣、D 冪等綁定、E 資料庫不變條件、F 財務一致性、G 輸入邊界、H 併發、I 退款餘額、J 強化項目、L 稽核覆蓋、M 結算確認互斥。
- `tests/security-fuzz.test.ts`（7 項）：API 全面模糊測試。
- `migrations/012_security_hardening.sql`：取代 `settlement_children_guard()`（同時檢查 OLD／NEW，禁止搬移）。
- 修改的程式：`router.ts`、`auth.ts`、`audit-read.ts`、`repo.ts`、`idempotency.ts`、`config.ts`、`orders.ts`、`fulfillment.ts`、`aftersales.ts`、`finance.ts`、`settlements.ts`、`automation.ts`；設定與文件：`.env.example`、`render.yaml`、`ci.yml`、`vitest.config.ts`、`e2e-smoke.ts`、`DEPLOYMENT.md`、`DEMO_DEPLOYMENT.md`、`AUTOMATION.md`、`KNOWN_ISSUES.md`。

## 5. 未修正（需要 Owner 決策或屬部署／產品選擇）

| # | 級 | 項目 | 為什麼沒修 | 建議／選項 |
|---|:-:|---|---|---|
| O1 | 低 | **帳號列舉**：帳號被鎖定時回 429「登入失敗次數過多」，不存在的帳號永遠回 401 → 可用「連錯 5 次」探測帳號是否存在 | 要改成一律 401 會讓真正被鎖的人不知道原因，是產品取捨 | 選項 A 維持現狀（內部系統、帳號多半可猜）；選項 B 鎖定時也回 401 並顯示通用訊息＋寄通知 |
| O2 | 低 | 登入的 IP 限流取 `X-Forwarded-For` 第一個值，直接對外曝露時可被偽造而繞過 IP 限流（帳號限流 10 次／分鐘與資料庫鎖定仍有效） | 是否在可信任的反向代理之後，屬部署決策 | 部署時只信任固定代理的標頭；或改用連線來源 IP |
| O3 | 低 | 退款殘留風險：平台已有的退款（匯入）＋本系統「完成但未寫回」的退款，兩者合計仍可能超過訂單金額（`max()` 只是緩解）；寫回後若再匯入較舊 CSV 會覆蓋 `refund_amount` | 需要 Owner 決定「退款以誰為準」（D3 範圍的資料來源問題） | 建議：訂單來源接 API 後以平台為準，本系統只做申請與核准；或一律勾寫回 |
| O4 | 低 | 外部角色可見範圍：團主看得到自己在檔期的 `targetRevenue`、`campaign_hosts.note`、`campaign_products.note`；出貨單的異常／取消原因、簽收人與簽收備註；公開處理紀錄會顯示內部人員姓名與角色 | ADR 已列「團主可見資料」為待決策 | 請 Owner 逐欄確認；要收斂就加入 `project()`／`EXTERNAL_FIELDS` |
| O5 | 低 | 匯入批次與匯入錯誤列表（含 `raw_row`）是組織層級，非負責人的營運小編也看得到 | 屬資料可見範圍的產品決策 | 若要收斂，可依 `raw_row.campaign_id` 過濾 |
| O6 | 低 | 沒有 `Content-Security-Policy`、`Strict-Transport-Security` 標頭 | CSP 需要處理 Next 的內嵌 script（nonce）；HSTS 只在 HTTPS 部署才適用 | 上線前一併規劃 |
| O7 | 低 | 退款核准者可以是申請者本人（沿用售後模組報告的待決事項） | 小團隊常一人兼任 | 可用 `system_settings` 開關，仿照 G 關卡已有的「申請人與核准人不得同一人」 |
| O8 | 低 | `financeOverview` 對每個檔期各查一次佣金（最多 100 次查詢） | 效能而非安全；目前資料量無影響 | 之後改批次計算 |
| O9 | — | 既有 KNOWN_ISSUES K1（SSO／MFA）、K2（備份還原演練）、K3（限流單機記憶體）、K5、K7 與相依套件弱點（zod 3、next 15） | 需要 Owner 決策或主版本升級 | 見 KNOWN_ISSUES |
| O10 | — | 文件待同步（本輪不改，因其他人正在寫）：`docs/spec/SAD.md` 仍把 `SESSION_SECRET` 當作未使用的設定並引用 K4（現已移除）；各文件的權限／自動化說明不需改（自動化工作數仍為 8） | 避免與同時編輯的文件衝突 | 由整合者統一更新 |

## 6. 如何重現驗證

```bash
export TEST_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:5432/<名稱必須含 test 的資料庫>
export DATABASE_URL=$TEST_DATABASE_URL
npx vitest run tests/security-phase2.test.ts tests/security-fuzz.test.ts
```

「舊版變紅」的做法：把對應的原始碼檔還原成 `git show HEAD:<檔案>`（migration 則暫時移走 `012_...sql`），重跑上述測試，應看到「重現」欄所列的測試轉紅；還原後再轉綠。
