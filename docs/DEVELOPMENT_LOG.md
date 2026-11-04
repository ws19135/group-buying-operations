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

## 2026-11-03｜團主總覽最上方加「團購 SOP」與「接下來兩週的進程」（分支 `feat/host-sop-next2weeks`）

### 目標
Owner 要求：團主頁面最上面顯示 ① 團購的 SOP ② 接下來兩週的進程，提醒團主接下來的進度。

### 我的理解與取捨（請 Owner 確認）
- 「團主的頁面」＝團主登入看到的 `/dashboard/host`（內部人員以團主視角預覽時相同）。
- 「SOP」＝流程模板中寄樣→結團前催單的 11 步（phase 1–6），團主負責的步驟標「我負責」、其餘標廠商／營運；結算以後（結單核對、廠商結算、發票、結案）屬內部作業，**不給團主看**。每個檔期另顯示「完成幾步、目前進行到哪一步」。
- 「兩週」＝今天起連續 14 天（含第 14 天）；內容＝開團、結團、曝光、未完成的 SOP 作業（含廠商／營運負責的，標明誰負責，因為會影響團主的時程）；團主自己逾期的作業另列在最上面。已完成、已略過、已婉拒的檔期都不列入。

### 變更
`getHostDashboard` 新增 `sop`、`upcoming`（唯讀，不改任何資料）；`src/app/(app)/dashboard/host/HostTop.tsx`；`HostDash` 型別；SRS FR-DSH-13、SDD 端點說明。

### 證據
- `tests/dashboard-host-upcoming.test.ts` 9 項（11 步與「我負責」、完成後進度前進、14 天邊界、兩週外不出現、已完成不出現、逾期只算團主自己的、團主資料隔離、內部人員預覽一致、婉拒不提醒）。
- 突變驗證（規則 7）：視窗多一天、SOP 含內部結算、已完成也列入、作業全標我負責、逾期含別人負責、曝光不限兩週——6 種都讓測試變紅。
- 全套 vitest 34 檔 616 項通過；`tsc`、`eslint`、`next build` 乾淨；E2E 135/135（重設資料庫並灌入全部種子；新增 4 項：最上方兩區塊位置、11 步與「我負責」、日期範圍與「今天／明天」、曝光類型為中文）。看截圖發現曝光類型顯示英文代碼 `REMINDER`、示範檔期的步驟沒標完成造成假逾期，兩者已修；最後一次只調整種子（再多標 `TOPIC_PROMO` 完成），重設後以程式讀回確認（逾期 0、兩週 7 項），未重跑 E2E。
- 順手修正上一輪遺留的 E2E 競態：試用資格調查「存檔後讀回」只等 networkidle 就重新載入，偶發讀不回；改成等儲存請求回應。
- 發現並記錄：草稿（DRAFT）檔期本來就不會出現在團主總覽（與「我的檔期」一致），所以測試先把檔期設為已排程。

## 2026-11-03｜團主總覽最上方改為圖示化提醒（分支 `feat/host-top-icons`）

### 目標
Owner 看過上線版（快照站已是最新）後回饋：「要變成圖示化，重點是要提醒團主，不需要這麼詳細」。

### 變更
- SOP：11 步改成圖示流程（📦寄樣、🧴試用、💬回饋、✅審核…），畫面只放圖示與兩三個字，完整名稱／說明／負責人放在滑鼠停留提示；團主負責的步驟有光圈並標「我來」；各檔期改成進度條＋目前步驟圖示。
- 兩週進程：最上面是四個圖示計數（📝要我做、📣曝光、🚀開團、🏁結團）；逾期獨立紅色警示；下方只列重要日期，每項是一顆圖示膠囊；沒事時顯示「✨ 這兩週沒有需要你處理的事」。
- **取捨**：廠商、營運負責的作業**不再列在兩週清單**（這是減少干擾的主要來源；SRS FR-DSH-13 同步改寫）。如需要可再加回來。
- `upcoming.items` 的 TASK 只含團主負責的作業，並帶 `stepKey`（供前端選圖示）。

### 證據
- 全套 vitest 34 檔 616 項通過；`tsc`、`eslint`、`next build` 乾淨；E2E 136/136（重設資料庫並灌入全部種子；新增「圖示計數」檢查、SOP 改驗「我來」標記）。
- 突變驗證（規則 7）：列入非團主作業、視窗多一天、SOP 含內部結算、已完成也列入、逾期含別人負責、曝光不限兩週——6 種都讓測試變紅。
- 看過截圖（`docs/uat/screens/36-host-sop-next2weeks.png`）；最後一個 CSS 小調整（進度條右側欄位固定寬度）未重截圖。
- 限制：示範團主目前兩週內沒有「要我做」的作業，所以該計數為 0；日後有排進來才會變色提醒。

## 2026-11-03｜SOP 02 選品評分 V2（可驗證子條件）＋廠商 12 題驗收與修補（分支 `feat/sop02-v2-scoring`）

### 目標
Owner 要求：不重建 SOP 02／03；把 1～5 分主觀評分升級成「可驗證條件＋證據＋系統計算」，完整驗收廠商 12 題，改善 PM 操作；保留商品審核與 G1–G5 的核准權限與流程。

### 盤點（先於實作）
讀過 `selection-score.ts`、`dd-catalog.ts`、`selection.ts`、`diligence.ts`、`evidence.ts`、`decision-summary.ts`、migration 014、評估與調查 UI、既有測試。已完成：六維度評分、合規獨立檢查、版本與覆核、12 題目錄與證據、G1 唯讀摘要。部分完成／缺漏：評分全是主觀 1～5 分、沒有利用既有資料；12 題的缺陷與缺漏見 `docs/phase2/DD_12Q_ACCEPTANCE.md`（含一份獨立的唯讀盤點，我再逐項自行覆核後才採用：敏感文字外洩、授權期限不檢查、挑選順序錯誤三項都親自讀程式確認）。

### 變更
- 規格：`docs/phase2/SELECTION_V2.md`（30 個子條件、公式、來源、資料模型、UI、測試）、`SELECTION_V2_ROLLBACK.md`、`SELECTION_V2_OWNER_DECISIONS.md`、`DD_12Q_ACCEPTANCE.md`；SRS（FR-SEL-V2-01～09、FR-DD-09～11）、SAD、SDD、生成文件。
- 程式：`lib/selection-v2-{catalog,score}.ts`（純函式）、`modules/selection-v2.ts`（設定、自動取值、草稿、送出快照、補件要求）、`selection.ts` 以 `rubric_version` 分流（V1 原樣）、migration 016、12 題修補（`diligence.ts`、`dd-catalog.ts`、`evidence.ts`）、路由 +8。
- 畫面：V2 評估編輯／即時預覽／結果、補件面板、12 題進度條與缺件清單、調查版本表、撤回按鈕、沿用選項、G1 摘要的 12 題進度。
- 種子：`seed-demo-selection-v2.ts`（防曬噴霧已送出含補件要求、保濕面膜草稿）。

### 設計取捨
- **不新增任何金額公式**：利潤只讀 SOP 03 試算結果；三種商業模式只決定用哪組門檻；沒有試算＝未知，不以 SKU 成本推算。
- 新舊相容：V1 評估與草稿照舊；V2 仍填 V1 欄位，G1 摘要與列表不必改；`createEvaluation` 預設 V2，V1 以 `{rubric:1}` 建立（測試與舊種子改用此參數，證明相容）。
- 所有權重、門檻、樣本數、硬性條件、不適用規則都是**提案**（`approved=false`），Owner 核准清單集中在 `SELECTION_V2_OWNER_DECISIONS.md`。
- 職責分離、「已接受風險」狀態、調查涵蓋範圍、到期提醒涉及核准權限或通知，**沒有擅自改**。

### 證據
見 TEST_REPORT §8。

### 限制與未完成
- V2 設定沒有專用畫面（只有 API）。
- 12 題核准後鎖定只靠應用層（沒有 guard 觸發器）；合約版本建立後不能更正。
- 評估頁的現行評估區有兩處重複的總分顯示（卡片頭與 V2 結果），屬版面待整理。
- 歷史統計在 DEMO 資料中多半樣本不足而顯示「未知」，所以示範的總分偏向少數已知條件。

## 2026-11-03｜SOP 01～03 功能驗收與缺口補強（分支 `feat/sop01-03-acceptance`）

**目標**：不重建既有模組，逐項以程式、API、畫面、權限實際驗收 SOP 01／02 V2／03，補最小缺口，並用畫面走完一條全流程。

**變更**
- 新增：小規模測試團 8 項 KPI（`lib/trial-kpi.ts`、`modules/trial-kpis.ts`、`GET /api/trials/:id/kpis`、試用詳情的 KPI 卡）；團主再次合作意願欄位（migration 017，`product_trials.host_intent`／`host_intent_note`）；V2 設定畫面（`/selection?tab=config2`，`SelectionV2ConfigForm`）；全流程 UI 驗收 `scripts/e2e-flow.ts`。
- 修補：檔期異動紀錄對無 `fit.read`／`segment.read` 者的稽核外洩（`audit-read.ts`）；V2 結果對無 `fit.read` 者遮罩適配衍生子條件（`maskV2Result`）；試用結論表單預設值不跟著系統建議更新；商品頁覆核按鈕巢狀在 `<p>` 內造成 React hydration 錯誤 #418；商品表單補測試識別。
- 文件：`docs/phase2/SOP_01_03_ACCEPTANCE.md`（逐項矩陣）、`docs/phase2/TRIAL_KPI.md`（公式、來源、期間、完整度、Owner 決策）；SRS／SAD／SDD、API／資料字典（`npm run docs:gen`）、TEST_REPORT §9、KNOWN_ISSUES 已同步。

**驗證**：`npm test` 39 檔 701 項；E2E 煙霧 146/146；全流程 28/28；tsc、eslint 無錯誤。突變驗證：稽核外洩、V2 適配遮罩各用舊版程式跑新測試皆變紅；結論預設值與 hydration 缺陷在舊版建置上跑新腳本時變紅（見 TEST_REPORT §9）。

**與規格的差異**：新增 `host_intent` 欄位與 KPI 卡、V2 設定畫面（規格原本只有 API）；其餘不變。導購轉換率與實際每單貢獻利潤沒有可靠來源，**一律顯示資料不足**；沒有套用任何未經核准的門檻。

**風險與阻擋**：見 `SOP_01_03_ACCEPTANCE.md` §5、§6。**未動**可行性 `recordActuals` 口徑、分潤／財務、G1 檢查項。

**需要 Owner 決策**：K-1～K-5（KPI 門檻、觸及人數來源、實際利潤歸屬、樣本門檻、客訴是否細分團主）、D-1～D-4。

**下一步**：Owner 驗收畫面；確認 K-2 後補人工「觸及人數」欄位；累積測試團資料後再訂門檻。

## 2026-11-03｜Owner 決策 K-1～K-3 落地：觸及與導購資料、實際貢獻利潤、測試團 KPI 彙整（分支 `feat/trial-kpi-owner-decisions`）

**目標**：依 Owner 裁決實作 K-1（暫不設 KPI 門檻、累積 5 檔再審查）、K-2（人工填寫三種觸及資料，CVR 只用有效導購訪客）、K-3（沿用代理人口徑、承擔方依各檔合約、與實際值回寫共用定義、不改結算）。

**變更**
- K-2：migration 018 `trial_reach_records`；`lib/trial-reach.ts`、`modules/trial-reach.ts`、4 條 API；試用頁「觸及與導購資料」卡（新增／軟刪除）；KPI 的 CVR 改用有效導購訪客，另列「群組成員訂單比」。
- K-3：`lib/actual-sales.ts`、`lib/actual-profit.ts`、`modules/actual-contribution.ts`；`calcFeasibility` 新增實際值模式（預設行為不變）；可行性新增「退款／退貨處理成本」與負擔方、來源「正式商務條件（已確認）」；KPI 與 `recordActuals` 共用；`recordActuals` 既有欄位維持原義，新增與 KPI 同定義的欄位與貢獻利潤（稽核不留金額、無權限者看「需權限」）。先寫 `TRIAL_KPI_FINANCE_ALIGNMENT.md` 差異分析，確認分潤結算程式零變動。
- K-1：`/selection?tab=kpi` 測試團 KPI 彙整（進度 N／5、趨勢、風險提示、商品類別、團主類型）；風險提示只陳述事實。
- 文件：`TRIAL_KPI.md` 改寫、新增 `TRIAL_KPI_FINANCE_ALIGNMENT.md`；SRS（FR-TRIAL-KPI-01～07）、SAD、SDD §18B.10、KNOWN_ISSUES、TEST_REPORT §10、API／資料字典已同步。

**驗證**：`npm test` 41 檔 740 項；E2E 煙霧 146/146；全流程 34/34；tsc、eslint 無錯誤；10 種規則破壞的突變驗證皆使測試變紅。

**與規格的差異**：新增 1 張表與 2 個可行性輸入欄位；其餘不變。分潤結算、財務、發票、G1–G5 語意都沒有改動。

**風險與阻擋**：見 `TRIAL_KPI.md` §7（K-4～K-7）與 `TRIAL_KPI_FINANCE_ALIGNMENT.md` §5（K-6、K-8）。

**需要 Owner 再次裁決**：K-6（分潤比例以合約還是財務規則為準）、K-7（多商品檔期）、K-4、K-5、K-8。

**下一步**：開始用畫面累積小規模測試團資料；滿 5 檔後從彙整頁整理提交審查。

## 2026-11-04｜K-4～K-8 營運規則落地：導購訪客可驗證性、客訴團主歸屬、分潤口徑差異核對、成本分攤提案、費用歸屬對照（分支 `feat/k4-k8-rules`，基於 PR #20）

**目標**：依 Owner 裁決 K-4～K-8，在不動分潤結算與 G1–G5 的前提下完善營運規則；PR #20 未合併，本分支以其為基礎、PR 以 PR #20 分支為 base。

**PR #20 驗收**：CI 綠燈（head `045b3e4`）、草稿、無衝突；`git diff` 確認結算、財務、佣金、發票、閘門、`lib/kpi` 皆無變動；740 項測試／E2E 146／全流程 34 與 TEST_REPORT §10 一致。無阻擋性問題。

**變更**
- K-4：migration 019、`REACH_RULES` 版本化＋指紋測試、佐證／去重方式／第二人查核、`POST /api/reach-records/:id/verify`。
- K-5：migration 020、`lib/complaint-attribution.ts`、案件頁人工指定、KPI 客訴率分開呈現（同時修正 PR #20 的分子分母口徑混用）。
- K-6：`lib/commission-reconciliation.ts`＋唯讀 API／畫面；廠商審查第 10 題新增選填欄位。
- K-7：`lib/cost-allocation-proposal.ts`（4 種候選方法、情境比較）＋唯讀分析；提案文件；多商品維持資料不足。
- K-8：`lib/fee-attribution.ts`＋唯讀報告；整合方案文件。
- 文件：`TRIAL_KPI.md`（§3.1、§3.2、§5、§7）、`COMMISSION_RECONCILIATION.md`、`MULTI_PRODUCT_COST_ALLOCATION_PROPOSAL.md`、`FEE_ATTRIBUTION_REPORT.md`、`KPI_SETTLEMENT_INTEGRATION_PROPOSAL.md`；SRS（FR-TRIAL-KPI-08／09、FR-FIN-RECON-01～03）、SAD、SDD §18B.11、KNOWN_ISSUES（W-1～W-8）、TEST_REPORT §11、API／資料字典已同步。

**驗證**：見 TEST_REPORT §11。

**與規格的差異**：新增 migration 019／020（只新增欄位）、新增唯讀畫面與 API；結算演算法、財務、發票、G1–G5 完全不動。

**風險與阻擋**：見 KNOWN_ISSUES W-1～W-8。

**需要 Owner 再次裁決**：K-4a、K-5a、K-6a～d、K-7a～e、K-8a～d（各文件末段）。原指令 K-8 第 6 點被截斷（「提出未來如何整合結…」），本次依前後文理解為「提出未來如何整合結算的方案」。

**下一步**：Owner 驗收；建議先核准 K-8a（補齊欄位）與 K-6a（以合約為準的對齊流程）。

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

## 2026-11-05｜K-4a～K-8a 決策落地（分支 `feat/k4a-k8a-fee-attribution`，基於 PR #21 分支 `feat/k4-k8-rules`）

**目標**：實作 Owner 對 K-4a～K-8a 的決策；PR #20／#21 維持 Draft、不合併、不碰 main、不部署；本分支基於 PR #21 最新分支，Draft PR 的 base 為 `feat/k4-k8-rules`，不重做 PR #20／#21 已完成的功能。

**變更**
- K-4a：migration 021、指派查核者、補件鏈、事件時間軸、規則版本 `reach-rules/2026-11-05.1`（沒有自行核准捷徑）。
- K-5a：共同歸因客訴加權計數，Σ團主加權＋未歸屬＝公司總數；標示分攤依據與分母。
- K-8a：migration 022 擴充 `expenses`（承擔方≠實際付款方等）；費用報告改用實際記錄。K-8 第 6 點依 Owner 確認為「提出整合方案」，只寫路線圖、資料需求、風險分析與驗收計畫。
- K-6a：migration 023 待人工確認項目、KPI 口徑差異提醒。
- K-7a～e：費用分類、各方法對公司與商品利潤的影響、重複／未分攤／跨期風險（唯讀）。
- 文件：phase2 各文件、SRS（FR-TRIAL-KPI-10／11、FR-FIN-RECON-04／05、FR-FIN-EXP-01）、SAD、SDD §18B.12、KNOWN_ISSUES W-9～W-15、TEST_REPORT §12、資料字典／ERD／API 重新產生、`K4A_K8A_ACCEPTANCE.md`。

**驗證**：見 TEST_REPORT §12。
**與規格的差異**：新增 migration 021～023（只新增欄位／資料表）；結算演算法、佣金計算、發票、G1–G5 完全不動。
**開發中抓到的問題**：突變驗證發現「填寫者自查」只靠資料庫擋（服務層沒有被測試單獨驗證）→ 補上 403 斷言；指紋的 `fields` 部分與原因文字重疊（等價突變體，改以固定指紋突變驗證）。
**需要 Owner**：見 `docs/phase2/K4A_K8A_ACCEPTANCE.md` §5 的合併決策清單。
