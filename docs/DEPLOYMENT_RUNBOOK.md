# 正式環境部署手冊（Deployment Runbook）

> 前置條件（Owner 提供）：主機、網域（DNS 已指向主機）、`.env.production`、GitHub `production` Environment 設定。尚未具備前，以下步驟**未執行**。

## A. 第一次建置（空的正式資料庫）
1. 主機安裝 Docker 與 Compose；建立部署目錄，放入 `docker-compose.prod.yml`、`deploy/Caddyfile`、`.env.production`（權限 600，內容依 `.env.production.example`，由密鑰管理填入）。
2. **先在預備環境**用同一個映像完成一次完整流程與 Live UAT（`PRODUCTION_UAT.md`）。
3. 啟動資料庫：`docker compose --env-file .env.production -f docker-compose.prod.yml up -d db`
4. 初次建置：`docker compose --env-file .env.production -f docker-compose.prod.yml run --rm app npm run prod:bootstrap`
   - 只建立 schema、組織、一位初次啟用的系統管理者；拒絕 DEMO 資料、示範旗標、範例信箱、弱密碼；密碼不印出。
5. 啟動全部：`... up -d`；檢查 `https://<網域>/api/ready`（migration 全部套用）與 `/api/health`（版本、commit）。
6. 管理者登入 → **被強制變更密碼** → 建立真實使用者（`/users`）；建置完成後把 `ADMIN_INITIAL_PASSWORD` 從 `.env.production` 移除。
7. `npm run prod:check`（容器內）確認：有管理者、`demoRows=0`。
8. 設定每日備份（`BACKUP_RESTORE_RUNBOOK.md`）並做第一次還原演練。

## B. 日常版本更新
1. PR 合併後 CI 綠燈（`main`）。
2. GitHub Actions → **Deploy production** → 選 ref（預設 main）→ Owner 核准（Environment 必要審核）。
   - 流程會檢查該 commit 的 CI 全綠才繼續；建置並推送映像（tag＝commit SHA）；SSH 到主機 `pull` 並重啟 `app`、`proxy`；部署後檢查 `/api/ready`；留下 Deploy Log。
3. 啟動時應用程式不自動套 migration；新版若含 migration：部署前**先備份**，再在主機執行 `run --rm app npm run db:migrate`（migration 皆向前相容、只新增、單一交易）。`/api/ready` 在 migration 未套用時回 409，部署流程會等待而不接流量。
4. 驗收：`/api/health` 的 `commit` 等於本次 commit；登入、重要頁面抽查。

## C. 不可做的事
不啟用 `AUTOMATION_ENABLED`、不設定 `ALLOW_DEMO_IN_PRODUCTION`、不在正式環境跑 E2E 或 Live UAT（UAT 只在預備環境）、不使用 `db:reset`（production 會拒絕）、不直接改資料庫。

## D. 監控與告警（最小可行）
- 外部健康監控（例如任何 uptime 監控服務）每 1～5 分鐘檢查 `https://<網域>/api/health` 與 `/api/ready`，失敗時通知負責人。
- 容器日誌：`docker compose logs -f app proxy`（Caddy 為 JSON 格式）；應用程式錯誤回應含 `requestId`，可與稽核與日誌對照。
- 磁碟與備份：監控資料卷與備份目錄使用量；備份檔缺漏（超過 26 小時沒有新檔）要告警。
- 目前**沒有**集中式錯誤追蹤服務（需要時另行選型，屬 Owner 決定）。
