# 公開示範環境（Demo）部署說明

> **用途**：讓同事用瀏覽器直接點開看、討論下一步。**只放虛構的 `[DEMO]` 資料**；Owner 已明確授權可對外公開這個示範環境（2026-10-28）。
> **不是正式環境**：沒有 SSO／MFA、沒有備份還原演練、沒有監控。**請勿輸入任何真實廠商、團主、訂單或個資。**
> 正式環境的前置條件仍見 [DEPLOYMENT.md](DEPLOYMENT.md) 第 7 節。

## 它做了什麼

`render.yaml`（Render Blueprint）會建立一個 Node 網站＋一個 PostgreSQL。每次啟動前自動執行 `npm run bootstrap:demo`：建表 → 建組織與預設流程模板與管理者 → 灌入虛構 DEMO 資料。三步都是**冪等**的（已存在就略過），重啟不會重複建資料。

示範環境的安全設定：
- 需登入才看得到任何內容；未登入呼叫 API 一律 401（已用 production 模式驗證）。
- 密碼**不在 repo**：只在 Render 建立服務時輸入（`sync:false`），程式不會印出或回傳。
- cookie 在 production 帶 `Secure`＋`HttpOnly`；登入有限流與帳號鎖定。
- 自動化全部停用、通知只走測試 Adapter，**不會對任何真人發送**。
- 在 production 建 DEMO 資料需要明確設定 `ALLOW_DEMO_IN_PRODUCTION=yes`；沒設會拒絕（已驗證）。

## 步驟（約 15 分鐘，要用你的帳號操作）

1. 到 https://render.com 用 GitHub 登入，授權它讀取 `ws19135/group-buying-operations`（私人 repo 也可以）。
2. **New → Blueprint** → 選這個 repo、分支 `feat/erp-mvp-phase1`（合併後改選 `main`）。Render 會讀到 `render.yaml`。
3. 畫面會要你填三個值（只存在 Render，不會進 GitHub）：
   - `ADMIN_EMAIL`：你的管理者信箱
   - `ADMIN_INITIAL_PASSWORD`：管理者密碼（至少 10 字元，含英文字母與數字）
   - `DEMO_PASSWORD`：示範帳號共用密碼（同上規則）。**這組會給同事**，所以不要跟你的真實密碼相同。
4. 按 Apply，等建置與部署完成（第一次約 5–10 分鐘）。網址類似 `https://group-buying-erp-demo.onrender.com`。
5. 開 `網址/api/health`，看到 `"db":"up"` 就代表正常。

## 給同事的資訊

| 想看什麼 | 帳號 | 密碼 |
|---|---|---|
| 管理者 Dashboard、檔期、任務、核准 | `demo-manager@example.invalid` | `DEMO_PASSWORD` |
| 營運小編視角（只看自己負責的檔期） | `demo-editor@example.invalid` | 同上 |
| 財務視角 | `demo-finance@example.invalid` | 同上 |
| 團主視角（只看自己的檔期與預估佣金） | `demo-host1@example.invalid`（`demo-host2` 也可） | 同上 |
| 廠商視角 | `demo-vendor@example.invalid` | 同上 |

建議先看：`/dashboard`（有 DEMO 橫幅）→ `/campaigns`（開一檔看八階段任務與「調整日期」預覽）→ 用團主帳號登入比較看到的內容差異。

## 已知的限制

- **免費方案會休眠**：閒置約 15 分鐘後下次開啟要等 30–60 秒喚醒。免費資料庫有使用期限（Render 目前為 30 天），到期要升級或重建；以 Render 官方方案說明為準。
- 同事操作會改動示範資料（可以建檔期、改日期、核准）。想還原成乾淨的示範資料：在 Render 刪除資料庫再重新部署（會重新灌 DEMO 資料）。
- 網址任何人都打得開登入頁；只有知道密碼的人進得去。**密碼請私下傳給同事，不要貼在公開地方**。
- 示範環境與正式環境不要共用資料庫或密碼。

## 下線

Render 後台刪除 `group-buying-erp-demo` 網站與 `erp-demo-db` 資料庫即可，GitHub 上的程式不受影響。

## 其他部署選項

任何能跑 Node 22＋PostgreSQL 16 的地方都可以（Fly.io、Railway、自己的主機、Vercel＋Neon 等）。設定的環境變數與 `render.yaml` 相同：`APP_ENV=production`、`ALLOW_DEMO_IN_PRODUCTION=yes`、`DATABASE_URL`、`SESSION_SECRET`（至少 32 字元的隨機值）、`ADMIN_EMAIL`、`ADMIN_INITIAL_PASSWORD`、`DEMO_PASSWORD`；啟動指令 `npm run bootstrap:demo && npm start`。
