# 環境矩陣（Environment Matrix）

| 變數 | 開發／測試 | 預備（staging） | 正式（production） | 說明 |
|---|---|---|---|---|
| `APP_ENV` | development／test | production | production | production 會加 Secure cookie、拒絕 DEMO 種子與資料庫重設 |
| `DATABASE_URL` | 本機資料庫 | 預備專用資料庫 | 正式專用資料庫（compose 內部網路） | 不可指向他環境；`db:reset` 在 production 被拒絕 |
| `ORG_NAME` | — | 第一次建置用 | 第一次建置用 | 組織名稱 |
| `ADMIN_EMAIL` | 範例 | 測試信箱 | **真實公司信箱**（不可用 example 網域） | 只用於 `prod:bootstrap` 第一次建立管理者 |
| `ADMIN_INITIAL_PASSWORD` | 開發用 | 隨機（密鑰管理） | 隨機（密鑰管理）；**第一次登入強制變更；建置完成後從環境移除** | ≥12 字元、含英文字母與數字；不可是已公開的測試密碼 |
| `ALLOW_DEMO_IN_PRODUCTION` | — | **不設定** | **絕對不可設定** | 示範環境專用；`prod:bootstrap` 偵測到會拒絕 |
| `DEMO_PASSWORD` | 開發用 | 不設定 | 不設定 | 只給 DEMO 種子 |
| `NOTIFY_ADAPTER` | test | test | test | 目前只支援 test（不會對任何真人發送） |
| `AUTOMATION_ENABLED` | off | off | **off**（啟用需 Owner 核准） | worker 總開關 |
| `APP_VERSION`／`BUILD_SHA` | — | 映像建置時注入 | 映像建置時注入 | `/api/health` 回報 |
| `POSTGRES_USER`／`POSTGRES_PASSWORD`／`POSTGRES_DB` | — | compose 用 | compose 用（長且隨機） | 只在 `.env.production` |
| `ERP_DOMAIN` | — | 預備網域 | 正式網域 | Caddy 自動 HTTPS |
| `APP_IMAGE` | — | 映像 tag | 映像 tag（commit SHA） | 回滾時改成舊 tag |

GitHub Environment「production」：Required reviewers（Owner）＋Secrets：`DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`、`DEPLOY_PATH`；Variable：`ERP_URL`。任何密鑰都**不得**出現在程式、文件或 log。
