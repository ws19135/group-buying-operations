# 唯讀快照站（GitHub Pages）

> 用途：給主管、同事一個**固定網址**、**不需要任何人開電腦**、**更新後重新整理就看得到**的「看得到介面」版本。
> 它是從示範環境擷取的**唯讀靜態快照**，不是可操作的系統：不能登入、不能新增或修改，所有資料皆為虛構（`[DEMO]`）。要實際操作，請用示範環境（Mac＋通道，或雲端主機，見 [DEMO_DEPLOYMENT.md](DEMO_DEPLOYMENT.md)）。

## 它長什麼樣子
- 首頁選角色（營運主管、營運小編、財務、團主、廠商）；每個角色一套頁面，各約 30～120 頁，頁內連結可以點（總覽、檔期、任務、核准、履約、售後、財務…）。
- 每頁頂端有「唯讀快照」橫幅；按鈕與表單在快照中不會動作。
- 團主與廠商視角可以直接看出他們**看不到**成本與他人資料。

## 怎麼產生
```bash
npm run build && npm run bootstrap:demo && npm start          # 先有一個跑著的示範站（含 DEMO 資料）
BASE_URL=http://127.0.0.1:3000 SNAPSHOT_PASSWORD=<DEMO_PASSWORD> npm run snapshot   # 輸出到 site/
```
`scripts/build-snapshot.ts` 用 Playwright 逐角色登入並爬過所有站內連結，移除所有 script、把連結改寫成快照內的檔案、複製靜態資源。月份切換（`?month=`）不擷取；每個角色頁數上限預設 200（`SNAPSHOT_MAX_PAGES`）。

## 自動發布（GitHub Actions）
`.github/workflows/pages.yml`：在 CI 內起一個一次性的示範站（密碼每次隨機產生，不寫入任何檔案）→ 產生快照 → 發布到 GitHub Pages。

**第一次要你在 GitHub 網頁做 2 件事**（我沒有權限代做）：
1. Repo → **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。
2. Repo → **Settings → Secrets and variables → Actions → Variables → New repository variable**：名稱 `ENABLE_PAGES`，值 `true`。
   之後每次合併到 `main` 就會自動重新發布；也可以到 **Actions → Snapshot site → Run workflow** 手動執行。

網址通常是 `https://<帳號>.github.io/<repo 名稱>/`。

## 公開前請先決定
- **GitHub Pages 是公開網址**（任何人知道網址就能看，沒有登入）。內容只有虛構 DEMO 資料，但畫面會呈現系統的功能與流程。
- Pages 是否能用在**私人倉庫**取決於 GitHub 方案（免費帳號通常只有公開倉庫可用），請以 GitHub 現行方案說明為準。若要用免費方案，倉庫必須改成公開，**倉庫裡的程式與文件（含主藍圖、研究報告、需求規格）也會公開**。請先確認這些內容可以公開。
- 已確認：倉庫內沒有密碼、金鑰、真實帳號或真實資料（`.env*` 被忽略，種子資料皆為虛構，示範帳號為 `example.invalid`）。

## 限制
- 只讀：看不到「操作後的結果」（例如新增檔期後畫面怎麼變）。
- 快照是「擷取當下」的畫面；示範資料有「資料產生時間」，會是快照產生時間。
- 少數連結沒有擷取（例如超過頁數上限或月份切換），點了不會動。
- Actions 流程我在本機以相同步驟跑過（build → bootstrap → start → snapshot，輸出 400 頁，用瀏覽器點過連結、沒有 404、沒有 console 錯誤），但 **GitHub Actions 上的第一次實際執行尚未驗證**。
