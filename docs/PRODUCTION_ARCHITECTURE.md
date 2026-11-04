# 正式環境架構（Production Architecture）

> 範圍：把 SDH 團購 ERP 從 GitHub 上的程式，變成公司團購部門每天能登入使用的正式系統。
> **誠實狀態（2026-11-04）**：程式、容器映像、部署流程、備份與還原、驗收腳本都已準備並在「本機 production 模式＋空資料庫」驗證；**正式主機、網域、正式資料庫目前尚未建立**（沒有可用的主機帳號、網域與部署金鑰，見 `HANDOFF.md` 的 Owner 清單）。GitHub Pages 只是**唯讀靜態示範快照**，不是可操作的 ERP。

## 1. 盤點結論（依 repository 實際內容）

| 項目 | 實際情況 |
|---|---|
| 前端 | Next.js 15（App Router，伺服器端渲染＋少量 client 元件）；需要 Node 伺服器持續運行（不是純靜態網站） |
| 後端 API | 同一個 Next.js 程序內的 `/api/*`（`src/server/api` 自製路由、RBAC、稽核）；沒有獨立後端服務 |
| 資料庫 | PostgreSQL 16；`pg` 連線池；migration 共 27 支（forward-only，checksum 保護） |
| 背景工作／排程／Webhook | 有 `scripts/worker.ts`，但預設關閉（`AUTOMATION_ENABLED=off`），通知只有測試 Adapter；**沒有 Webhook**；正式環境維持關閉，啟用需 Owner 逐項核准 |
| 身分驗證 | 帳號密碼＋伺服器端 session（cookie：HttpOnly、SameSite=Lax、production 加 Secure）；登入限流與帳號鎖定；**初次啟用強制變更密碼**；尚無 SSO／MFA／密碼自助重設 |
| 權限 | 6 個角色的 RBAC、後端資料範圍（組織、團主、廠商）、成本欄位遮罩（`product.cost.read`）、稽核紀錄不可竄改 |
| 檔案儲存 | **不需要**：憑證與證據只存連結（D-8）；不新增檔案儲存服務 |
| GitHub Pages | `pages.yml`：把 DEMO 示範環境擷取成唯讀靜態快照；**不可當正式 ERP** |
| 既有部署設定 | `render.yaml` 只用於公開**示範**環境（DEMO 資料、免費方案）；沒有正式主機、網域、資料庫或部署憑證 |

## 2. 目標架構（單機容器化，可搬到任何能跑 Docker 的主機）

```
使用者瀏覽器 ──HTTPS──▶ Caddy（自動憑證、HSTS、gzip）
                           │ （內部網路）
                           ▼
                      app 容器（Next.js，非 root，port 3000，/api/health、/api/ready）
                           │ （內部網路，不對外）
                           ▼
                      PostgreSQL 16（資料卷；不開放任何對外埠）
```

- 設定檔：`Dockerfile`、`docker-compose.prod.yml`、`deploy/Caddyfile`、`.env.production.example`。
- 密鑰：只放在主機的 `.env.production`（權限 600）或平台 Secret；**不進 GitHub、不進映像、不進前端 bundle**（沒有任何 `NEXT_PUBLIC_*`）。
- 資料庫只在 compose 內部網路，沒有 `ports`；備份檔與資料卷由主機層保護。
- 版本追蹤：映像以 commit SHA 為 tag；`/api/health` 回報 `version` 與 `commit`；部署流程留下 Deploy Log artifact。

## 3. 為什麼這樣選（部署方案比較；價格以各家官方報價為準，本文不列數字）

| 方案 | 優點 | 缺點／注意 | 判斷 |
|---|---|---|---|
| **自有／租用 VPS＋Docker Compose（建議）** | 費用固定、資料庫持久性與備份自己掌握、可選台灣／東京／新加坡機房、與本專案容器設定一致 | 需要有人維運主機（更新、備份排程、監控） | ✅ 預設建議 |
| Render（Web＋Postgres） | 設定簡單，已有 `render.yaml` 經驗 | 免費方案會休眠、免費資料庫有使用期限，**正式環境必須付費方案**；機房在新加坡等區域 | 可行，需 Owner 核准付費 |
| Fly.io／Railway | 部署快 | 資料庫持久性與備份要額外設計；付費方案 | 次選 |
| AWS／GCP（台灣區） | 台灣機房、託管資料庫與自動備份 | 設定與維運成本高 | 若公司已有雲端帳號與人員才建議 |

台灣使用者存取：優先選台灣或東京機房（延遲低）；DNS 指向主機後由 Caddy 自動簽發憑證。

## 4. 正式環境與預備（staging）環境隔離

| | 預備環境（staging） | 正式環境（production） |
|---|---|---|
| 用途 | Live UAT、升級演練、教育訓練 | 真實營運 |
| 資料庫 | 獨立資料庫（可隨時重建）；可含 UAT 標示資料 | 獨立資料庫；**不得有 DEMO／UAT／虛構資料**（`prod:bootstrap` 與 `prod:check` 會檢查） |
| 網域與密鑰 | 各自獨立 | 各自獨立 |
| 映像 | 與正式相同的映像（同一個 commit） | 同左 |
| 破壞性測試 | 允許（重建資料庫） | **禁止** |

## 5. 資料流與信任邊界
使用者 → Caddy（TLS 終止）→ app（驗證 session、RBAC、資料範圍、稽核）→ PostgreSQL。app 對外沒有任何主動連線（沒有金流、沒有真實通知、沒有第三方 API），因此沒有對外資料外洩路徑；唯一的出口是使用者瀏覽器的回應，並受權限與遮罩控制。

## 6. 尚未具備、需要 Owner 提供的前置條件
主機（或雲端帳號）、網域與 DNS、環境密鑰、GitHub `production` Environment 的核准人與部署 Secrets、正式管理者信箱。清單見 `HANDOFF.md` §1。
