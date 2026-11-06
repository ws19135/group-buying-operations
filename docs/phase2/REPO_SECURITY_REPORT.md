# Repository 安全清查報告（D-43）

> 日期：2026-11-06　範圍：`ws19135/group-buying-operations`（目前 **Public**，`isPrivate: false`，description「團購報告」）
> 作法：以本 session 實際對 Git 歷史與檔案執行的檢查為準；**沒有更改 repo 的任何管理設定**（可見性、Pages、Actions、協作者、Secrets 均未動）。
> 結論先講：**本次清查沒有發現已曝光的真實密鑰，也沒有發現真實客戶個資**；但有 3 項需要 Owner 知悉的曝光面（見 §2），而且「轉 Private」不等於資料安全（見 §4）。

## 1. 七項檢查結果

| # | 檢查項 | 方法（本 session 實際執行） | 結果 |
|---|---|---|---|
| ① | Git 歷史與 commit 是否有密鑰 | 對全部分支、100 個 commit 的所有差異內容掃描：AWS Access Key、GitHub PAT（`ghp_`／`github_pat_`）、OpenAI／Slack／Google API Key、私鑰區塊（`-----BEGIN … PRIVATE KEY-----`）、`PASSWORD／SECRET／TOKEN／API_KEY = "…"` 賦值；另列出歷史中曾被追蹤過的檔名（`.env*`、`*.pem`、`*.key`、`*.dump`、`*.bak`、`credentials`） | ✅ **無命中**。歷史中只出現 `.env.example`（只有範例值）與備份腳本／手冊（檔名含 backup，不含資料）。`.gitignore` 排除 `.env`、`.env.*`（保留 `.env.example`）、`*.log`。文件與程式中的密碼字串都是開發／CI 用的範例（`erp_dev_pw`、`erp_ci_pw`、`Test-Password-123`），資料庫只綁 `127.0.0.1` 的測試容器。⚠️ 掃描為樣式比對，不是商用工具（如 gitleaks）；建議 Owner 在 GitHub 啟用 Secret scanning 與 Push protection 作第二道（見 §3） |
| ② | 是否包含真實個資 | 全 repo（HEAD 與歷史）掃描電話、非 `example.*` 的 Email、`docs/`、`scripts/`、`tests/`、`src/` | ✅ 沒有客戶、團主、網紅、廠商的真實姓名／電話／地址。DEMO 與測試只用 `example.invalid`、保留測試號碼（`0200000001`、`0900…`）與 `[DEMO]`／`[E2E]` 前綴。⚠️ 有 **3 項非客戶但屬曝光面**，見 §2 |
| ③ | 資料庫與備份是否對外可存取 | 檢查 `docker-compose.prod.yml`、`Dockerfile`、`deploy/*.sh`、`scripts/backup.sh`、CI workflow | ✅ repo 內**沒有**任何資料庫傾印、備份檔或真實連線字串。正式資料庫在 compose 內部網路，未對外開埠；備份腳本把檔案寫到主機本機目錄（權限 600）。⚠️ **實際主機尚未建立**（W-23），所以「主機上的備份目錄與資料庫是否對外」**無法由 repo 驗證**，屬部署後的檢查項（`docs/OWNER_SETUP_CHECKLIST.md`） |
| ④ | 測試截圖是否含個資 | `docs/uat/screens/`（64 張）、`docs/phase2/screens/`（17 張）：先確認**產生方式**——全部由 `scripts/e2e-*.ts` 以 DEMO 帳號登入、對 `bootstrap-demo` 灌入的虛構資料擷取；再把 `docs/uat/screens/` 64 張製成縮圖拼貼，逐張目視（4 張拼貼） | ✅ 畫面可見的姓名、團主、廠商、商品、訂單皆為 `[DEMO]`／`[E2E]` 前綴的虛構資料；收件資料區塊只顯示「確認狀態」，**沒有任何一張截圖顯示收件人電話或地址**（個資預設不顯示，要按一下才讀取，E2E 不對該畫面截圖）。⚠️ 限制：拼貼縮圖看得清版面與名稱，**看不清小字級的每一個數字**；因此以「產生方式只接 DEMO 資料」作為主要依據，目視作為輔助。`docs/wireframes/screens/`（100 張）是靜態線框稿，不是系統截圖 |
| ⑤ | Log 與稽核是否洩漏敏感內容 | 自動化測試：灌入哨兵個資後掃描 `audit_logs`（`before_data／after_data／reason`）與 `collaboration_events.note`；檢查匯入錯誤紀錄 | ✅ 稽核與事件歷程**不含**收件人、電話、地址內容（只記誰讀、何時、用途）。❌→✅ **發現並修正**：匯入錯誤紀錄 `import_errors.raw_row` 與匯入暫存列 `collaboration_import_rows.raw` 原本會**永久保存**整列 CSV（含收件人、電話、地址）——現已在寫入時去個資、建立申請單／跳過後立即清除、逾 30 天未處理者由清除作業清掉（見 SECURITY_REVIEW §7 SF-1）。伺服器 log：`console.error` 只印例外物件與追蹤碼，不印請求內容 |
| ⑥ | GitHub Actions artifact 是否含敏感資料 | 檢視 `.github/workflows/*.yml` 所有 `upload-artifact` | ✅ 只有兩個：`deploy-log-*`（commit、actor、時間，**無密鑰**）與 `uat-result-staging`（`prod-uat.ts` 結果 JSON，保留 7 天；腳本把隨機產生的密碼放在記憶體、不寫入結果檔）。CI 本身沒有上傳任何 artifact。Pages 工作流程只發布 DEMO 快照（密碼每次隨機、不寫檔） |
| ⑦ | API 是否有跨組織與跨廠商越權 | 自動化測試（打真實 API）：跨組織、跨廠商、跨團主、小編承辦範圍、IDOR（真實 id 與不存在 id 回應一致）、全路由模糊測試 | ✅ 全數通過。**發現並修正 1 項真實漏洞**：`GET /vendors/:id/collaboration-summary` 的「已寄出樣品數」子查詢沒有組織與範圍條件，另一個組織的管理者（或同組織無承辦權限的人）可以讀到別組織廠商的統計數字（見 SECURITY_REVIEW §7 SF-3；突變驗證時還原舊版可重現） |

## 2. 需要 Owner 知悉的曝光面（非密鑰、非客戶個資）

| # | 內容 | 位置 | 風險 | 建議 |
|---|---|---|---|---|
| E1 | **Owner 個人識別**：26 個 commit 的作者信箱是個人 Gmail（`ws19135@gmail.com`），另有 1 個 commit 帶本機主機名稱與姓名（`wenrongliang@rong-macair.local`） | Git 歷史（公開 repo 任何人可見） | 個人信箱可被爬取（垃圾信、社交工程）；本機名稱洩漏姓名與裝置 | 轉 Private；若要長期公開，之後改用 GitHub 提供的 `…@users.noreply.github.com` 作者信箱（已有 3 個 commit 這樣做）。**改寫歷史會改變所有 commit hash 且影響 PR／CI，不建議由 AI 自行執行** |
| E2 | **疑似真實公司網域**：測試檔曾使用 `owner@sdh-company.tw`、`someone-else@sdh-company.tw` 當「正式環境啟動演練」的管理者信箱（因為正式環境啟動腳本拒絕 `example.*` 網域） | 歷史中 2 個 commit；**HEAD 已改成保留的 `.test` 網域**（`owner@company-ci.test`），`tests/prod-readiness.test.ts` 9 項仍通過 | 洩漏公司網域與慣用信箱格式 | 已在 HEAD 修正；歷史中仍可見。若該網域確為公司真實網域，列入 E1 的處置一併考慮 |
| E3 | 專案／映像名稱 `sdh-erp`（Docker 映像、CI） | `Dockerfile`、`docker-compose.prod.yml`、workflow | 低：暗示組織縮寫 | 知悉即可 |

**未發現**：API Key、Token、私鑰、資料庫密碼（正式）、客戶資料。**沒有需要撤銷或輪替的已曝光密鑰**，所以未啟動撤銷程序。若日後發現任何密鑰曾進過歷史：**立即在發行方撤銷並重發**，再處理 repo——只刪檔案或改寫歷史**不能**讓已複製過的密鑰失效。

## 3. 轉為 Private 之前的影響評估（只評估，未執行）

| 項目 | 現況（由 repo 檔案確認） | 轉 Private 的影響 | Owner 要做的事 |
|---|---|---|---|
| GitHub Pages | `pages.yml` 只在 `vars.ENABLE_PAGES=='true'` 或手動時發布 **DEMO 唯讀快照**；是否曾啟用**無法由 repo 得知** | **私有 repo 的 Pages 需要付費方案（Pro／Team／Enterprise Cloud）**；方案不符時 Pages 會被取消發布，既有分享網址失效。Pages 網站預設仍是公開網址（除非 Enterprise Cloud 開啟私有 Pages） | 先到 Settings → Pages 確認是否有在使用、方案是否支援；若只是 DEMO 示範，轉 Private 後改用 `docs/DEMO_DEPLOYMENT.md` 的自架示範 |
| Actions | 5 個 workflow：`ci`、`docker-build`、`pages`、`deploy-production`、`uat-staging`；私有 repo 的 Actions 分鐘數與 Packages 儲存依方案計費；映像推到 `ghcr.io` | 免費方案有每月分鐘數上限，超過會停跑 CI；Packages 預設可見度跟 repo | 確認方案額度；確認 `ghcr.io` 映像的可見度（Packages 設定）；`deploy-production` 的 Environment 與 Required reviewers 要在 Settings → Environments 建立 |
| 外部協作者與 Fork | 無法由 repo 得知；公開 repo 的 **Fork 會留在原處**，轉 Private 時公開 Fork 會**分離成獨立的公開 repo**（含轉換當下的全部歷史） | Fork 不會因為你轉 Private 而消失；已被 Clone 的副本也無法收回 | Settings → Collaborators 檢視誰有權限；Insights → Forks 檢視有無 Fork；**假設歷史已被他人取得**，所以密鑰與個資仍要以「已曝光」看待（本次清查沒有發現） |
| 既有連結 | README、文件、PR 連結都是 `github.com/ws19135/group-buying-operations/…` | 未登入或沒權限的人打開會是 404；`raw.githubusercontent.com` 連結失效 | 通知仍需要存取的人，並把他們加為協作者 |
| 第三方整合 | 無法由 repo 得知（GitHub Apps、Webhooks、Codespaces） | 轉私有後第三方 App 的存取權限需重新確認 | Settings → Integrations 檢視 |
| 流量與搜尋 | 公開期間可能已被搜尋引擎或爬蟲收錄 | 轉 Private 後新內容不再公開，已被快取或複製的內容無法收回 | 視為歷史已公開 |

## 4. 轉 Private 之後仍然必須做的事（不要假設 Private＝安全）

1. **Private 只減少「被陌生人看到」，不改變 repo 內容**：任何有讀取權限的人（協作者、Fork 權限、Actions 日誌檢視者）仍看得到全部檔案與歷史。真實資料**不應該放進 repo**（目前也沒有）。
2. **真實個資只存在資料庫**，且資料庫與備份要有自己的存取控管與加密（見 SECURITY_REVIEW §7「備份中的個資」）。
3. **啟用 GitHub 的 Secret scanning 與 Push protection**（私有 repo 需要 GitHub Advanced Security 方案；公開 repo 免費提供），並把 `deploy-production` 綁定的 Secrets 放在 Environment 層級。
4. **分支保護**：要求 PR＋CI 全綠才可合併 `main`；`deploy-production` 設定 Required reviewers。
5. **最小權限**：協作者只給需要的角色；移除不再參與的人；Actions 預設權限設為唯讀（workflow 已用 `permissions:` 明示）。
6. **定期輪替**：部署用 SSH 金鑰、資料庫密碼、`ADMIN_INITIAL_PASSWORD` 在 Owner 交接或人員異動時輪替。

## 5. Owner 操作步驟（本 session **沒有**執行任何一步）

> 需要 repo 管理員權限。**請在執行 3 之前先完成 1、2**。

1. **盤點**：Settings → Pages（有無啟用）、Collaborators and teams、Integrations（Apps／Webhooks）、Insights → Forks、Settings → Secrets and variables（確認只有部署所需項目）。
2. **確認方案**：私有 repo 的 Actions 分鐘數、Packages 儲存、Pages 是否可用（見 §3）。若要保留公開示範網站，改用自架（`docs/DEMO_DEPLOYMENT.md`）。
3. **轉為 Private**：Settings → General → Danger Zone → **Change repository visibility** → Make private（GitHub 會要求輸入 repo 名稱確認）。
4. **轉換後立刻檢查**：
   - Settings → Code security：啟用 Secret scanning、Push protection、Dependabot alerts；
   - Settings → Branches：對 `main` 設定保護規則（需要 PR、需要 CI 通過）；
   - Settings → Environments：建立 `staging` 與 `production`，`production` 設 Required reviewers；
   - Packages：把 `ghcr.io/ws19135/…` 映像設為 private；
   - 從無痕視窗開 repo 網址，確認是 404。
5. **（選擇性）個人識別**：決定是否改寫歷史移除 E1／E2（不建議；轉 Private 已大幅降低風險）。
6. **通知**：告知需要存取的人，並加為協作者。

## 6. 本 session 對 repo 實際做的與沒做的

- ✅ 做了：唯讀掃描與報告；把測試檔的疑似真實網域換成保留 `.test` 網域（HEAD）。
- ⛔ 沒做：更改可見性、啟用／停用 Pages 或 Actions、增刪協作者、改 Secrets、改寫歷史、輪替任何金鑰（因為沒有已曝光的金鑰）。
