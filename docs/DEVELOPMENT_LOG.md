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
