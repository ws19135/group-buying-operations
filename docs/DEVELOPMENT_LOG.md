# 團購 ERP 開發紀錄

> 本檔只記錄已發生且有證據的工作。規劃中的功能不標示為完成。

## 2026-10-28｜建立 ERP 主藍圖文件組

### 目標

把團購 ERP 規劃整理成可供後續需求確認、實作拆解與審核的文件，同時保留現有研究報告與既有系統規格的邊界。

### 已檢查來源

- `group-buying-operations`
  - `README.md`
  - `docs/2026-taiwan-group-buying-complete-research.md`
  - `diagrams/` 既有 Mermaid 流程圖
- `zhaocai-groupbuy-system`
  - `CLAUDE.md`、`README.md`
  - `docs/ROADMAP.md`、`docs/DATA_MODEL.md`
  - `docs/spec/00_流程地圖.md`
  - `docs/spec/01_SRS.md`、`02_SAD.md`、`03_SDD.md`
- `groupbuy-flow-sop`
  - `README.md`
  - 開始前確認、表單／分頁用途與實際踩雷紀錄
- 對話「團購 ERP 架構規劃」的可讀需求訊息

### 來源限制

原對話的第一則長篇 ERP 回覆在 ChatGPT 介面顯示「無法載入這則回覆」，回讀 API 也只提供內容參照標記，無法取得逐字原文。因此本次不是宣稱逐字搬運，而是依原始使用者需求與三個儲存庫的實際文件交叉還原 1–9 章；此限制已在 PR 與本紀錄揭露。

### 本次變更

| 檔案 | 內容 |
| --- | --- |
| `docs/ERP_MASTER_BLUEPRINT.md` | 1–9 章主藍圖：願景、角色、資料模型、流程、Dashboard、自動化、KPI、技術架構與導入策略 |
| `docs/IMPLEMENTATION_ROADMAP.md` | P0–P7 分階段交付、Exit Criteria、Owner 決策與第一個垂直切片 |
| `docs/DEVELOPMENT_LOG.md` | 來源、限制、變更、驗證與後續紀錄方式 |
| `README.md` | 新增 ERP 文件導航並保留既有研究與 Mermaid 連結 |

### 保留的既有決策

- 既有正式系統與資料不在本次變更範圍。
- 金額、退款、撥款、入帳與 Production 寫入保留人工核准。
- 單一事實來源、軟刪除／調整紀錄、Audit Log、TEST／LIVE 隔離與 `Asia/Taipei` 時區原則。
- 招財兔已核准規格不被主藍圖默默改寫；跨群組設計以「建議／待決策」標示。
- 取消用商品名稱、試算表列位置或公式範圍作為正式唯一鍵。

### 明確未做

- 未修改任何正式程式、Apps Script、Google Sheet、觸發器或部署。
- 未搬動、匯入或清理正式廠商、訂單、個資與財務資料。
- 未決定最終技術棧、雲端環境、登入方式或上線日期。
- 未將任何規劃中模組標記為已實作。

### 文件驗證

交付前執行：

- 確認四份指定文件存在。
- `git diff --check` 檢查空白與 patch 格式。
- 檢查 README 與文件內的相對連結可對應到儲存庫檔案。
- 檢查變更清單僅包含 Markdown 文件。
- 推送後比對遠端分支與 Pull Request 的變更檔案。

### 下一步

1. Owner 審核主藍圖第 9.4 節的七項待決策。
2. 選定試點群組與一檔已結案案例。
3. 依 P0 產出正式 SRS、資料字典與 KPI 口徑。
4. 完成 P0 Exit Criteria 後才估工期與開始程式實作。

---

## 2026-10-28｜Phase 1 MVP 建置（分支 `feat/erp-mvp-phase1`）

### 目標
在不碰正式資料、不部署、不對外發送的前提下，依藍圖與路線圖建置可在本機／隔離環境操作的團購 ERP Phase 1 MVP，並把現況盤點、決策、追溯與驗證證據都記在本儲存庫。

### 已檢查來源
- 本儲存庫：README、藍圖、路線圖、開發紀錄、研究報告、Mermaid（開工前**沒有任何程式碼**）。
- `zhaocai-groupbuy-system`：CLAUDE.md、README、ROADMAP、DATA_MODEL、PLATFORM_LESSONS、SRS／SAD／SDD、舊版 Apps Script 原始碼（本機版）。
- `groupbuy-flow-sop`：README、前置確認、踩雷、表單說明、`build_nx.py` 設定參數、收件 Apps Script。
- 環境：Node 22、無 Docker → 安裝 PostgreSQL 16；Chromium＋Playwright 預裝。

### 變更（模組）
| 區塊 | 內容 |
|---|---|
| 資料庫 | 8 支 migration、43 張表；觸發器：禁止實體刪除、稽核不可改、版本／更新時間自動維護；角色資料 |
| 服務層 `src/server` | 認證、RBAC＋資料範圍、稽核、冪等、廠商／團主／社群／商品、檔期（多 SKU／多團主／曝光）、衝突偵測、工作流程引擎（模板版本化、排程、預覽重排、鎖定）、狀態機與 G1–G5、任務、訂單 CSV 匯入、佣金規則、Dashboard、自動化（8 個工作）、通知佇列、進件 |
| API | 單一路由表 79 個端點；統一錯誤、CSRF、冪等鍵、樂觀鎖 |
| 前端 `src/app`、`src/ui` | 36 個頁面（繁中、淺色、手機可用）；由前端建置者分身代理完成 |
| 腳本 | migrate／seed／seed-demo／reset-db／worker／gen-docs／e2e-smoke |
| CI | `.github/workflows/ci.yml` |
| 文件 | 現況盤點、複用矩陣、需求追溯、ADR（19 項）、工作流程映射、Dashboard 規格、自動化、API、架構、部署、測試報告、UAT 證據、功能矩陣、已知問題；資料字典／ERD／API 清單自動產生 |

### 已完成與證據
`npm run typecheck`、`npm run lint`、`npm test`（11 檔 162 項）、`npm run build`、`npm run e2e`（49/49）皆退出碼 0；詳見 [TEST_REPORT.md](TEST_REPORT.md)、[UAT_EVIDENCE.md](UAT_EVIDENCE.md)。完成度逐項見 [FEATURE_STATUS_MATRIX.md](FEATURE_STATUS_MATRIX.md)。

### 與規格的差異
- 路線圖要求 P0 完成後才開始程式實作；依使用者明確指示直接建置 Phase 1，所有因規格缺漏而做的決定記為 PROPOSED（ADR）。
- 找不到「八階段」定義 → ADR-004。藍圖的「營運 PM」與任務的「營運小編」合併為一個角色。
- SOP 的「圖文素材」原本接在「試用回饋」之後；改接在「開團審核（G1）」之後，避免未核准就製作。
- 新增 G2／G3／G5 關卡任務（共 15 步）。不套用招財兔分潤公式。

### 測試／驗證
見 TEST_REPORT。開發中由測試與文件審閱抓到並修正 6 類缺陷（G4 檢查缺漏、404/403 洩漏任務存在、鎖定任務預覽誤判、自動化冪等鍵粒度、Dashboard 目標欄位外洩、連結 scheme／清空欄位等）。

### 風險與阻擋
- BLOCKED：真實 LINE／Email、電商 API／Webhook、Google Workspace、真實資料、Production。
- 安全缺口：SSO／MFA、密碼重設、備份還原演練、RLS（見 KNOWN_ISSUES K1–K7）。
- 相依套件弱點：zod 3（high）、next 15 經 postcss（high）需主版本升級；vitest（僅開發）。

### 需要 Owner 決策
見 [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md) 末段「仍待 Owner 裁決的事項」（試點群組、團主可見資料、訂單來源、金流模式、KPI／結算口徑、與 Sheets 過渡關係、技術棧與登入方式、八階段定義）。

### 下一步（建議 Phase 2）
1. Owner 審閱 ADR 與 KPI 口徑；選定試點群組與一檔已結案案例，做手工對帳。
2. 訂單來源：決定平台後做 API／Webhook 或排程匯入；結單快照。
3. 履約與售後（庫存、出貨、退款、客訴）。
4. 財務：入帳、費用、佣金試算與批次結算（覆寫雙欄、調整批次）。
5. 身分與營運：SSO／MFA、備份還原演練、監控告警、升級 zod 4／next 16。

---

## 2026-10-28｜Phase 2 切片：履約、售後、財務（分支 `feat/erp-mvp-phase1`）

### 目標
在 2026-11-03 內部討論前，補上 Phase 2 中**不需要外部資源、也不需要 Owner 先定義金額公式**的部分，供示範使用。

### 變更
- 履約與出貨（migration 009）：出貨批次／出貨單／簽收／庫存異動（append-only）。文件：`docs/phase2/FULFILLMENT.md`。
- 退款、客訴、售後案件（migration 010）：案件、處理紀錄（append-only）、退款申請與核准／完成、可選寫回訂單（預設關）。文件：`docs/phase2/AFTERSALES.md`。
- 財務（migration 011）：結算試算／覆寫／調整項／確認鎖定、入帳紀錄、費用、發票紀錄。文件：`docs/phase2/FINANCE.md`。
- 新增 9 項權限（共 43）；導覽新增「履約出貨」「售後」「財務結算」「我的結算」；檔期頁加相關作業連結。
- `bootstrap:demo` 串接三支 DEMO 種子（皆冪等）。
- 佣金口徑抽成共用函式 `commission-calc.ts`，團主 Dashboard 與結算試算共用，輸出不變。

### 證據
- `npm test`：14 檔 245 項通過（含新增 82 項）；typecheck、lint、build 皆乾淨。
- `npm run e2e`：49/49；售後另有 `e2e:aftersales` 52/52；財務 UI 19 項斷言（`docs/phase2/finance-ui-results.json`）。
- 各模組以「故意改壞」驗證測試會轉紅（履約 3 種、售後 7 種、財務 6 種）。
- 從零資料庫跑 `bootstrap:demo` 兩次（第二次全數略過）。

### 與規格的差異／待 Owner 決策
- 結算口徑、階梯與扣項、G4 是否自動串接、退款核准者可否為申請者本人、`WAITING_VENDOR` 是否保留、新增 `refund.complete` 權限是否保留。
- 仍為 BLOCKED／未開工：電商訂單 API、真實 LINE／Email、廠商入口、歷史資料遷移與雙軌對帳、SSO／MFA、Production 與備份演練。

## 2026-10-28｜規格補齊與獨立安全審查（分支 `feat/erp-spec-and-hardening`）

### 目標
補上先前缺少的 SRS／SAD／SDD／線框圖（逆向整理並與程式核對），並對全系統（重點 Phase 2）做獨立安全與權限審查。

### 變更
- `docs/spec/`：SRS（FR 142、UC 18、NFR 28）、SAD（8 圖）、SDD（14 圖、17 模組）、索引；`docs/wireframes/`：畫面清單（37 路由）、15 張線框 SVG、94 張現況截圖。
- 安全審查（`docs/phase2/SECURITY_REVIEW.md`）：17 項（中 5、低 12），16 項已修；migration 012；新增 60 項測試；K4（移除 `SESSION_SECRET`）、K6（冪等鍵清理，預設停用）。
- 整合時修正：G4 檢查訊息、庫存異動編號前綴改 `STK-`、README 首頁加入架構圖、狀態機圖、文件地圖。

### 證據
`tsc`、`eslint` 乾淨；`vitest` 16 檔 305 項；`next build` 成功；從零資料庫 `bootstrap:demo` 後 E2E 49/49；文件 222 個相對連結無壞連結；26 張 Mermaid 圖以 mermaid 11.4.1 解析通過；15 張 SVG 以 xmllint 驗證。

### 未解與待 Owner 決策
見 SRS 第 9 節（D-01～D-17）、第 11 節（落差 G-01～G-09、測試缺口 T-01～T-10）與安全審查第 5 節。

## 2026-10-28｜總覽清單標出團主與廠商（分支 `feat/dashboard-people`）

### 目標
討論前的使用回饋：「未來 30 天開團／結團」、逾期任務、廠商合作進度只看到檔期，無法即時知道是哪位團主、哪家廠商的問題。

### 變更
- `src/server/modules/dashboard.ts`：未來 30 天、逾期任務加入團主與廠商；新增逐檔的廠商合作進度（`vendorCampaigns`）；一檔 30 天內既開團又結團時兩個事件都列出（原本只列開團）。
- `src/app/(app)/dashboard/page.tsx`：對應欄位與連結；`src/app/globals.css`：窄螢幕格線改 `minmax(0,1fr)`，修正表格變寬造成的手機版水平溢出。
- 測試 +5（`tests/orders-dashboard.test.ts`），舊版程式跑會紅 4 項。

### 證據
`tsc`、`eslint` 乾淨；`vitest` 16 檔 310 項；E2E 49/49（過程中抓到手機版溢出 78px，修正後轉綠）；DEMO 資料實際畫面核對。

### 限制
任務為一檔一份，多團主檔期無法指出是哪一位；是否拆成每位團主一份待決。

## 2026-10-29｜Owner 確認技術棧、示範網址方案討論

- **Owner 決定**：公司有 IT 或預算維運主機，長期會放真實資料 → 維持 Next.js＋PostgreSQL，不改用 Apps Script 重寫（ADR-001 已確認）。
- **工作協議**：影響技術棧、部署方式、公開範圍或需要使用者自行維運的決定，先說明代價並取得同意再動工。
- **示範網址**：週二前沿用「Mac＋暫時通道」；固定網址可選 GitHub Pages 唯讀快照（已合併，需 Owner 設定並決定倉庫是否公開）或 Render 雲端主機（`render.yaml` 已備）。待 Owner 決定。

## 2026-10-29｜營運主管總覽對照建置前介面示意並補齊（分支 `feat/dashboard-wireframe-gap`）

### 目標
Owner 提供建置前的 Dashboard 介面示意（含 KPI 清單與資料更新原則），要求逐項對照營運主管總覽並補上落差。

### 變更
- `dashboard-extra.ts`（新）：進行中檔期、預估佣金／已確認佣金／已收款金額、社群業績排行、每檔團購產值、廠商合作成功率、檔期準時開團率、商品復開績效、營運異常與待辦、資料來源與同步。
- 本週／本月切換；跨團主業績長條圖；KPI「看明細 →」與新的「訂單明細」頁（`/orders`，訂單 API 增加日期、團主、退款篩選）。
- 對照表與口徑見 [DASHBOARD_SPEC.md](DASHBOARD_SPEC.md) 最後一節。

### 證據
`tsc`、`eslint` 乾淨；`vitest` 17 檔 323 項；E2E 49/49；DEMO 資料實際畫面核對；新測試改壞後會變紅（移除每類上限、預估佣金改成猜費率各一次）。

### 待 Owner 決定
廠商合作成功率、檔期準時開團率、商品復開績效三項為暫定口徑；API／Webhook 事件同步未做（缺平台與憑證）。

## 2026-10-29｜SOP 01 市場定位與客群分析、商品適配、G1 決策支援（分支 `feat/sop01-segment-fit`）

### 目標
建立團主客群輪廓、商品適配與 G1 選品決策支援；不改 G1–G5 語意、不自動核准、不碰正式資料、不寄通知。

### 盤點結論
既有只有 `hosts.audience_note` 自由文字與 `communities`；沒有結構化客群資料，故新增 5 張表（不複製既有表）並在 `hosts` 加 1 個可空欄位 `partner_type`。評分設定沿用 `system_settings`，變更紀錄沿用 `audit_logs` 與 `version`，不另建表。

### 變更
migration 013；`segments.ts`、`fit.ts`、`lib/fit-score.ts`、`lib/segment-vocab.ts`；6 個權限；22 條路由；團主／商品／檔期頁面板、`/fit`、`/segments`；`seed-demo-segments.ts`；SRS／SAD／SDD／線框圖／矩陣更新。完整設計見 [phase2/SEGMENT_FIT.md](phase2/SEGMENT_FIT.md)。

### 證據
- 基準線（開工前）：17 檔 323 項全綠。
- 之後：20 檔 405 項全綠（新增 unit 32、segments 23、fit 27；既有 API 模糊測試自動涵蓋新路由，無 5xx）；`tsc`、`eslint` 乾淨；`next build` 成功；E2E 86/86（連跑 3 次）。
- 突變驗證：把「未知」改成 0 分、讓硬性 FAIL 可被抵銷、讓相同輸入也新增版本，對應測試全部轉紅，還原後全綠。
- G1 回歸：評估與覆核「不採用」前後，G1 檢查項、申請與核准結果完全相同，不新增核准列、不發通知。

### 與規格的差異
見 SEGMENT_FIT.md §3.2（S-1～S-5）。

### 待 Owner 決定
D-18～D-24：權重與門檻、是否納入 G1 檢查、回寫是否排進自動化、價格帶定義、別名表維護、供應履約切點、事實的認定標準。

### 限制
需求維度是關鍵字比對（一律標估計）；評估的「資料已更新」判斷不含訂單與出貨的變動；沒有 AI 或外部資料來源；DEMO 資料全為虛構。

## 2026-10-29｜SOP 02 商品選品與廠商開發、SOP 03 商品試用與商業可行性（分支 `feat/sop02-03-selection-trial`）

### 目標
把 SOP 02／03 整合進既有 ERP，保留架構、頁面風格、資料範圍與 G1–G5；分數與評估只是決策建議，不自動核准；不碰正式資料、不寄通知、不部署。

### 盤點結論
讀過程式與 migration（`products.ts` 審核流程、`vendors.ts`、`tasks.ts`、`fulfillment.ts`、`gates.ts`、SOP 01 的 `fit.ts`、`permissions.ts`、`system_settings`）。可沿用：廠商／商品／SKU／素材、任務（寄樣、到貨、回饋、G1）、寄樣批次、稽核／版本／軟刪除／冪等、`product.cost.read`。`agreements` 只有 Schema、沒有程式使用，不動（以文字合約版本記錄，D-36）。需新增 7 張表；不修改既有表。

### 變更
migration 014（7 張表、5 個觸發器守衛、部分唯一索引）；5 個純函式庫（`selection-score`、`dd-catalog`、`trial-catalog`、`feasibility-calc`、`decision-risk`）；6 個服務模組（`selection`、`evidence`、`diligence`、`trials`、`feasibility`、`decision-summary`）；3 個新權限（52）；33 條路由；畫面：`/selection`、`/diligence/[id]`、`/trials/[id]`、`/feasibility/[id]`、廠商／商品／檔期整合；DEMO 種子 `seed-demo-selection.ts`；SRS／SAD／SDD、線框圖、矩陣、設計文件 `docs/phase2/PRODUCT_SELECTION_TRIAL.md`。

### 證據
- 基準線（開工前）：20 檔 405 項全綠。之後：**30 檔 592 項全綠**（新增 unit 66、整合 121；既有 API 模糊測試自動涵蓋新路由，無 5xx）；`tsc`、`eslint` 乾淨；`next build` 成功；E2E 全數通過（見 TEST_REPORT §6）。
- 突變驗證（規則 7）：22 種刻意弄壞的版本——未知當 0 分、合規可被總分抵銷、PROCEED 不看證據、評估送出後可改、連結 scheme 不檢查、過期證據仍算有效、分潤條款外洩或可寫、審查中可編輯、核准不檢查準備度、GMV 當公司收入、缺退款率當 0%、成本與利潤外洩、小編可寫成本、結論可比建議樂觀、商品改了資格仍有效、資格過期仍有效、允許重複進行中試用、檔期範圍不擋試用、摘要不分阻礙、摘要洩漏利潤正負、摘要改動 G1 檢查項——對應測試全部轉紅，還原後全綠。
- G1 回歸：建立並覆核全部資料前後，G1 檢查項、申請與核准結果、核准列數、通知數、任務數、檔期狀態完全相同；商品審核流程與權限不變；摘要為唯讀（呼叫前後各表列數相同）。
- 開發中由測試／E2E 抓到的缺陷：① 畫面把 `Date` 傳進客戶端元件導致試用詳情 500（`.slice` 不是函式），改傳純 JSON（`plain()`）；② E2E 腳本結束時只殺掉 `npx`、留下 `next-server`，下一次會測到舊版本，已改為行程群組結束並在啟動前檢查埠是否被佔用。

### 與規格的差異
見 PRODUCT_SELECTION_TRIAL.md §12（S-1～S-5）。

### 待 Owner 決定
D-25～D-36：權重與門檻、是否納入 G1 檢查、有效期、是否強制資格試用、受規範品類與審查窗口、敏感欄位可見範圍、可行性口徑、附件存放與網域白名單、商品送審是否必須有評估、回收逾期處理、必附證據類別、協議 CRUD。

### 限制
關鍵字式受規範品類提醒會漏判誤判；可行性只支援單一費率；證據只存連結且不偵測失效；商品指紋不含價格；DEMO 資料全為虛構。

## 2026-10-30｜稽核頁與流程模板說明補中文、跨團主業績比較示範商品（分支 `feat/audit-template-zh`）

### 目標
Owner 要求：稽核頁（原話「集合页」，判斷為語音辨識誤寫，指稽核紀錄頁）與流程模板說明也補中文，且**英文縮寫保留、中文放旁邊**（例如「GMV（成交總額）」）；「跨團主業績比較」選了廠商卻沒看到團購商品，要有示範商品可展示。

### 變更
- `src/ui/audit-labels.ts`：稽核動作／對象／角色／來源改為「代碼（中文）」（例如 `campaign.reschedule（檔期・改期）`、`WORKER（背景工作）`）；前後值 JSON 的欄位名與狀態值後面補中文，**原文不改**（拿掉中文註解後可還原成原 JSON，有測試）。套用在 `/audit`、檔期「異動紀錄」分頁、客群「版本與變更紀錄」。對照表沒收錄的代碼原樣顯示。
- 流程模板：預設模板說明改為「SOP（標準作業流程）步驟 N」「第二階段（Phase 2）」「groupbuy-flow-sop（團購標準作業流程）」「G1–G5 Gate（核准關卡）」；既有資料庫用 `migrations/015_template_zh_gloss.sql` 更新說明文字（只改 description，可重跑；步驟代碼、名稱、天數、相依都不動）。「Live Talk」規格沒有明確中文定義，**未自行翻譯**。
- `scripts/seed-demo-catalog.ts`（`npm run db:seed:demo:catalog`，已接進 `bootstrap:demo`）：4 家 [DEMO] 廠商（含「新進件品牌」）各新增 2 個商品與 1 檔進行中團購，共 8 商品、144 張虛構訂單；冪等、拒絕 production。
- `src/ui/HostChartFilter.tsx`：選廠商的當下，商品下拉就先更新（清單本來就在瀏覽器裡），並顯示「圖表更新中…」；廠商沒有商品時顯示「（此廠商尚無團購商品）」，不再誤導成「請先選廠商」。
- 唯讀快照站（沒有 script）：篩選下拉的選項帶 `data-nav`，快照爬蟲把每個廠商／商品組合都擷取成頁面，並附一小段只做換頁的 script。

### 原因判斷
Owner 的截圖是「廠商欄已選、商品下拉仍停用且寫著『請先選廠商』、圖表仍是『全部廠商』」。這個狀態與「選了廠商但伺服器還沒重畫完」完全一致（商品清單原本要等重畫後才更新）；另一個可能是看到了唯讀快照站（沒有 script，下拉本來就不會換頁）。兩種情況都已處理；若 Owner 看的是別的環境，請告知網址類型。

### 證據
- 重建資料庫後依序跑全部種子，讀回：晴空保養 4 個商品、暖食堂 3、森活家居 3、新進件品牌 3，且每個新商品各自篩選時都有團主長條。
- 全套 vitest 33 檔 607 項通過（新增 `tests/unit/audit-labels.test.ts` 5 項、`tests/template-zh-gloss.test.ts` 2 項，含 migration 重跑）；`tsc`、`eslint` 乾淨。
- 突變驗證（規則 7）：模板改回舊寫法、動作代碼不補中文、改動欄位名稱，三種弄壞的版本都讓新測試變紅。
- E2E 新增：新進件品牌選了就有 ≥3 個商品、選廠商當下商品下拉立刻更新、稽核頁有「代碼（中文）」。第一次跑有 1 項紅（測試在舊網址仍含 `vendor=` 時就去讀選項，屬測試競態），修正等待條件後重跑，結果見 TEST_REPORT。
- 快照站實際產生：825 頁；4 個廠商篩選頁與各商品頁都在，選項 `data-snap` 指向已擷取的檔案，已選項目帶 `selected`。

### 與規格的差異／限制
- 稽核頁的中文對照表是人工整理（107 個動作代碼的片段）；日後新增動作代碼若沒補，會原樣顯示英文，不會壞。
- 前後值只補常見欄位；其他欄位維持英文。

## 後續紀錄格式

每次變更新增一節，至少包含：

```text
日期／主題
目標
變更檔案或模組
已完成與證據
與規格的差異
測試／驗證
風險與阻擋
需要 Owner 決策
下一步
```

禁止只寫「已完成」「應該正常」或沒有輸出的測試宣告。
