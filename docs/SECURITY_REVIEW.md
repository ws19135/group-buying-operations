# 正式環境安全審查（2026-11-04）

> 既有的 `docs/phase2/SECURITY_REVIEW.md` 是 SOP 02／03 階段的審查；本文件是上線前的整體審查。

## 已驗證的控制

| 控制 | 證據 |
|---|---|
| 未登入不得存取（不匿名開放） | Live UAT 1.1；`security-fuzz`、`rbac` 測試 |
| RBAC（6 角色）、後端資料範圍、跨組織 404 | 全套測試（RBAC、跨組織、`expense-integrity`、`commission-recon-items`…）；Live UAT 第 18 項 |
| 成本與分潤欄位遮罩（`product.cost.read`） | 費用歸屬遮罩測試；小編 KPI 不含貢獻利潤；Live UAT 第 17、18 項 |
| 初次啟用強制變更密碼（後端擋，不只前端導頁） | `prod-readiness` 測試；Live UAT 第 2 項 |
| 密碼規則、不使用已公開測試密碼、不印出密碼、稽核不含密碼 | `prod-readiness` 測試；`prod:bootstrap` 測試 |
| 登入限流、帳號鎖定、cookie（HttpOnly、SameSite、production Secure）、同源檢查、安全標頭（X-Frame-Options、nosniff、Referrer-Policy、no-store）、HSTS（Caddy） | `rbac`／`security-*` 測試；`next.config.mjs`；`Caddyfile` |
| 稽核不可竄改（資料庫觸發器）、軟刪除（禁止實體刪除） | `database` 測試 |
| 資料庫不對外；密鑰不在前端 bundle（無 `NEXT_PUBLIC_*`）；映像不含密鑰；容器非 root | `docker-compose.prod.yml`、`Dockerfile`、docker-build CI 檢查 |
| 不把 DEMO／虛構資料放進正式資料庫 | `prod:bootstrap` 與 `prod:check` 檢查（測試） |
| 沒有未經授權的付款、通知、財務改寫、結算自動化、新排程或觸發器 | 程式碼掃描測試（只有手動付款紀錄寫 `payments`）；`AUTOMATION_ENABLED=off`；同步為手動 |

## 依賴弱點（`npm audit --omit=dev`，3 項）——已評估，暫不升級（均需大版本升級）

| 套件 | 嚴重度 | 內容 | 評估 | 處置 |
|---|---|---|---|---|
| `zod` 3.x | 高 | 驗證超大受限集合時可能耗盡記憶體 | 請求內容上限 4 MB（`MAX_BODY_BYTES`）、多數陣列有 `.max()`；公開端點（登入、健康）本文極小；其餘端點需已登入 | 修正需升到 zod 4（破壞性變更，影響全部驗證）；排入下一版並做完整回歸 |
| `postcss`（經 `next`） | 高 | CSS 字串化 XSS、`sourceMappingURL` 任意檔案讀取 | 只存在於**建置期** CSS 處理，輸入是本專案自己的 CSS；正式環境執行期不處理使用者 CSS | 修正需升到 next 16（大版本）；排入下一版 |
| `next` | 中 | 經由 postcss | 同上 | 同上 |

## 已知缺口與建議（需要 Owner 決定或後續版本）
1. **沒有 SSO／MFA**：目前是帳號密碼＋強制變更；建議上線後優先評估 MFA。
2. **沒有密碼自助重設**：忘記密碼需系統管理者重設（`/users`）；管理者本人忘記密碼需資料庫層維運程序（Owner 決定是否要寫入手冊）。
3. 登入限流為**程序內記憶體**：單一實例有效；多實例需共用儲存（本設計為單機）。
4. 沒有集中式錯誤追蹤與告警服務；僅 health／ready 與容器日誌（`DEPLOYMENT_RUNBOOK.md` D）。
5. 備份排程需在主機設定（cron）；異地備份與加密需 Owner 提供儲存空間。
6. 個資盤點與保留政策（廠商／團主聯絡資料）尚未正式化。
