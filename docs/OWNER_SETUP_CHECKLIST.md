# Owner 設定清單（依操作順序）

> 用途：把 SDH 團購 ERP 從「程式已就緒」變成「公司每天能登入使用」。
> **鐵則：任何密碼、金鑰、token 都只輸入在「主機」或「GitHub 的 Secrets 欄位」，不要貼到聊天、Issue、PR 或文件。** 驗證時只需要回報「通過／不通過」與非機密的畫面（例如網址、版本號）。
> 範例中的 `<…>` 是要你替換的值；`erp-staging.<公司網域>` 與 `erp.<公司網域>` 是建議的命名。
> 狀態：以下每一項目前都是 **未完成（需要 Owner）**；完成後 Claude 才能接手部署、UAT 與驗證。

## 先決定兩件事（決策，不是設定）
| 決策 | 建議 | 備註 |
|---|---|---|
| 主機形式 | **兩台 VPS（staging 一台、production 一台），Ubuntu 24.04 LTS，機房選台灣或東京** | 最低規格：2 vCPU／2～4 GB RAM／40 GB 磁碟。費用請以供應商官方報價為準，由你核准 |
| 能不能只用一台 | 可以（首次上線省錢作法）：同一台先當 staging 跑完驗收，`docker compose down -v` 清掉後，再用同一台建立 production | 缺點：驗收期間沒有獨立的預備環境；之後每次改版都沒有地方先試。**不建議長期這樣做** |

## 步驟（照順序）

### 1. 建立主機
- **在哪裡**：你選的 VPS 供應商後台。
- **輸入**：Ubuntu 24.04 LTS、機房（台灣／東京）、你的 SSH 公開金鑰（步驟 4 產生後再貼；也可先用供應商建議方式建立，之後再加）。
- **防火牆**（供應商後台的防火牆／安全群組）：只開 `22`（有固定 IP 就只允許你的 IP）、`80`、`443`；**不要開 5432 及其他任何埠**。
- **驗證**：你的電腦能 `ssh <使用者>@<主機IP>` 登入；從外部掃描只看得到 22／80／443。

### 2. 在每台主機安裝 Docker 並建立部署帳號與資料夾
- **在哪裡**：主機的終端機（SSH 登入後）。
- **做什麼**：依 Docker 官方文件安裝 Docker Engine 與 Compose 外掛（https://docs.docker.com/engine/install/ubuntu/）；建立非 root 帳號（例如 `deploy`）並加入 `docker` 群組；建立資料夾 `/opt/erp`（擁有者 `deploy`）。
- **驗證**：以 `deploy` 登入後 `docker compose version` 有版本、`docker run --rm hello-world` 成功、`ls -ld /opt/erp` 擁有者是 `deploy`。

### 3. 網域與 DNS
- **在哪裡**：你的網域註冊商或 DNS 服務。
- **輸入**：A 記錄 `erp-staging.<公司網域>` → staging 主機 IP；`erp.<公司網域>` → production 主機 IP（IPv6 有的話加 AAAA）。
- **注意**：若使用 Cloudflare 等代理服務，先設成「僅 DNS（不代理）」，等 HTTPS 憑證簽發成功後再決定。
- **驗證**：`dig +short erp-staging.<公司網域>` 回傳 staging IP；`dig +short erp.<公司網域>` 回傳 production IP。

### 4. 產生部署用 SSH 金鑰（每個環境各一把）
- **在哪裡**：你自己的電腦終端機。
- **做什麼**：`ssh-keygen -t ed25519 -f erp-deploy-staging -C erp-deploy-staging`（production 另產一把，檔名不同）。把 `.pub` 檔內容加到該主機 `deploy` 帳號的 `~/.ssh/authorized_keys`。**私密金鑰（沒有 .pub 的那個檔）只會放進步驟 5 的 GitHub Secret，貼完就從電腦刪除或妥善保管，絕不貼到聊天。**
- **建議**：主機關閉密碼登入（`PasswordAuthentication no`）。
- **驗證**：`ssh -i erp-deploy-staging deploy@<staging IP> 'echo ok'` 輸出 `ok`。

### 5. 設定 GitHub Environments（staging、production）
- **在哪裡**：https://github.com/ws19135/group-buying-operations → Settings → Environments → New environment。
- **做什麼**：
  1. 建立 `staging`（可不設審核人）與 `production`（**Required reviewers 設為你**；Deployment branches 限定 `main`）。
  2. 每個 Environment 各自新增 **Secrets**：`DEPLOY_HOST`（主機 IP 或網域）、`DEPLOY_USER`（`deploy`）、`DEPLOY_SSH_KEY`（步驟 4 的私密金鑰全文）、`DEPLOY_PATH`（`/opt/erp`）。
  3. 每個 Environment 各自新增 **Variable**：`ERP_URL`（`https://erp-staging.<公司網域>` 或 `https://erp.<公司網域>`）。
  4. 只在 **staging** 另外新增 Secrets：`UAT_ADMIN_EMAIL`、`UAT_ADMIN_PASSWORD`（步驟 7 的初次啟用密碼）、`UAT_ADMIN_NEW_PASSWORD`（你另外想好的、≥12 字元含英文字母與數字的新密碼；UAT 會用它完成「初次登入強制改密碼」）。**production 不要放任何 UAT 設定。**
  5. 建議：Settings → Branches 替 `main` 加 Branch protection，要求 `verify` 檢查通過。
- **驗證**：Environment 頁面看得到上述名稱（值會被隱藏）。

### 6. 讓主機能拉取映像（GitHub Container Registry）
- **在哪裡**：GitHub → 你的頭像 → Settings → Developer settings → Personal access tokens，建立只有 `read:packages` 權限的 token；然後在**主機終端機**輸入。
- **做什麼**：在每台主機以 `deploy` 登入後執行 `docker login ghcr.io -u <你的 GitHub 帳號>`，在提示 Password 時貼上 token（只貼在這裡）。
- **驗證**：輸出 `Login Succeeded`。（映像本身是私有的，這樣設定即可；不需要把映像公開。）

### 7. 在主機建立 `.env.production`（每台主機各一份，值不同）
- **在哪裡**：主機 `/opt/erp/.env.production`（`chmod 600`）。範本欄位見 repo 的 `.env.production.example`。
- **內容**：
  | 欄位 | 輸入 |
  |---|---|
  | `ERP_DOMAIN` | 該環境的網域（步驟 3） |
  | `POSTGRES_USER` / `POSTGRES_DB` | 例如 `erp_app`／`erp_staging` 或 `erp_prod` |
  | `POSTGRES_PASSWORD` | 在主機執行 `openssl rand -base64 36 | tr -d '\n='` 產生，貼進檔案（兩個環境不同） |
  | `ORG_NAME` | 公司或團購部門名稱 |
  | `ADMIN_EMAIL` | 你的**真實公司信箱**（不可用 example 網域） |
  | `ADMIN_INITIAL_PASSWORD` | 在主機執行 `openssl rand -base64 18 | tr -d '\n='` 產生；需含英文字母與數字（若沒有數字就重新產生）。staging 的這個值也要放進步驟 5 的 `UAT_ADMIN_PASSWORD` |
  不要設定 `ALLOW_DEMO_IN_PRODUCTION`、任何 DEMO 密碼或通知設定。
- **驗證**：`ls -l /opt/erp/.env.production` 顯示 `-rw-------`；`grep -ci example /opt/erp/.env.production` 只應出現在 `ERP_DOMAIN` 之外**沒有**範例值。

### 8. 部署 staging（由 Claude 或你觸發）
- **在哪裡**：GitHub → Actions → **Deploy (staging / production)** → Run workflow，`target=staging`。
- **預期**：第一次會在「確認已初次建置」停下並顯示「資料庫尚未初次建置」——這是設計：此時設定檔與資料庫已就位。
- **初次建置（在 staging 主機，你親自執行一次）**：
  ```bash
  cd /opt/erp
  APP_IMAGE=ghcr.io/ws19135/group-buying-operations:<該次 workflow 顯示的 commit SHA> \
    docker compose --env-file .env.production -f docker-compose.prod.yml run --rm app npm run prod:bootstrap
  ```
  會建立：資料表（27 支 migration）、組織、一位**初次啟用**的系統管理者。不會建立任何 DEMO 資料。
- 再執行一次 workflow（`target=staging`）。
- **驗證**：瀏覽器開 `https://erp-staging.<公司網域>/api/ready` 與 `/api/health`，`health` 的 `commit` 等於部署的 SHA；HTTP 會自動導向 HTTPS。

### 9. staging 驗收（Claude 執行，你只需簽核）
- **Live UAT**：Actions → **Live UAT (staging only)** → 輸入 `yes`（確認 staging 是全新空資料庫）。
- **備份與還原演練**（在 staging 主機）：
  ```bash
  cd /opt/erp && ./host-backup.sh && ./host-restore-drill.sh backups/<剛產生的 erp-….dump>
  ```
  預期最後一行 `✅ 還原演練通過`。
- **簽核**：Claude 回報 UAT 結果與演練結果；你確認後才進入步驟 10。

### 10. 部署 production
- **在哪裡**：Actions → Deploy → `target=production` → 你在 GitHub 核准（Required reviewers）。
- 同樣在第一次停下後，於 production 主機執行與步驟 8 相同的 `prod:bootstrap` 指令，再執行一次 workflow。
- **正式環境不跑寫入型 UAT、不匯入任何資料。** 驗證只有：`/api/ready`、`/api/health`、登入頁與 HTTPS／HSTS、管理者初次登入。

### 11. 正式管理者啟用
- **在哪裡**：`https://erp.<公司網域>/login`。
- **做什麼**：以 `ADMIN_EMAIL` 與初次啟用密碼登入 → 系統強制先設定你自己的新密碼（≥12 字元）→ 到「使用者」頁建立真實使用者與角色（誰能看分潤／成本由角色決定）。
- **收尾（在主機）**：編輯 `.env.production`，**刪除 `ADMIN_INITIAL_PASSWORD` 那一行**，執行 `docker compose --env-file .env.production -f docker-compose.prod.yml up -d app`。
- **驗證**：用舊的初次啟用密碼已無法登入；`prod:check`（`docker compose … run --rm app npm run prod:check`）顯示 `activeSystemAdmins>=1`、`demoRows:0`。

### 12. 每日備份與異地保存（production 主機）
- **在哪裡**：production 主機 `crontab -e`。
- **輸入**：`0 3 * * * /opt/erp/host-backup.sh >> /var/log/erp-backup.log 2>&1`（`/var/log/erp-backup.log` 需先建立並讓 `deploy` 可寫；或改寫到 `/opt/erp/backup.log`）。
- **異地保存**：你提供另一個帳號／機房的儲存空間（例如物件儲存或另一台主機），把 `/opt/erp/backups/` 定期同步過去並加密。**這是 Owner 的資源與政策決定。**
- **驗證**：隔天 `ls -l /opt/erp/backups/` 有新的 `erp-….dump` 與 `.sha256`；每月執行一次 `./host-restore-drill.sh`。

### 13. 外部健康監控
- **在哪裡**：任何 uptime 監控服務（你選擇）。
- **輸入**：每 1～5 分鐘檢查 `https://erp.<公司網域>/api/ready`（預期 HTTP 200）；失敗時通知你指定的人。
- **驗證**：在監控服務按「測試通知」收到訊息。

### 14. 之後每次改版
Actions → Deploy → 先 `staging`（Claude 跑 UAT）→ 再 `production`（你核准）。含 migration 的版本，部署腳本會**先自動備份**再套用 migration。回滾見 `ROLLBACK_PLAN.md`。

## 驗收完成的定義
- staging：HTTPS、UAT 全數通過、備份＋還原演練通過 → 這些項目才能標示 **LIVE_VERIFIED（staging）**。
- production：`/api/ready`、`/api/health`、管理者初次登入與改密碼、每日備份第一份產生並通過還原演練 → 才能標示 **DEPLOYED／LIVE_VERIFIED（production，僅限已驗證的項目）**。
- 在此之前，任何功能都**不得**標示為 DEPLOYED 或 LIVE_VERIFIED。
