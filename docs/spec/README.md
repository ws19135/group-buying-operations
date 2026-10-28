# 規格文件索引（docs/spec）

> **文件狀態**：這一組文件是對「已實作系統」的**逆向整理**——先有程式，再回頭寫規格，並逐項與程式、migration、測試核對。**不是事前設計**。
> 因此它回答的是「系統現在實際怎麼運作」，而不是「當初希望它怎麼做」。兩者有落差的地方，一律寫在各文件最後的「核對未決／落差」章節，由 Owner 決定要改程式還是改規格。
> 範圍：Phase 1 MVP ＋ Phase 2 切片（履約、售後、財務試算），全部為 DEMO／隔離環境驗證，**未上線、無真實資料**。金額口徑一律標「待 Owner 確認」。

## 1. 文件一覽

| 文件 | 回答的問題 | 位置 | 狀態 |
|---|---|---|---|
| SRS 需求規格 | 系統要做什麼、為誰做、做到什麼程度算完成 | [`docs/spec/SRS.md`](SRS.md) | 由另一份工作同步撰寫；**以檔案是否存在為準** |
| **SAD 系統架構** | 系統由哪些部分組成、怎麼部署、怎麼保護、為何這樣選 | [`docs/spec/SAD.md`](SAD.md) | ✅ 本次完成 |
| **SDD 詳細設計** | 每個模組的資料表、API、狀態機、演算法、權限、測試 | [`docs/spec/SDD.md`](SDD.md) | ✅ 本次完成 |
| Wireframe 線框圖 | 每個畫面長什麼樣、誰看得到什麼 | [`docs/wireframes/`](../wireframes/) | 由另一份工作同步撰寫；**以資料夾是否存在為準** |
| Roadmap 路線圖 | 接下來依什麼順序做 | [`docs/IMPLEMENTATION_ROADMAP.md`](../IMPLEMENTATION_ROADMAP.md) | 既有（P0–P7；P4／P5 已部分完成） |
| ADR 架構決策 | 規格有歧義時為何這樣決定（全部 `PROPOSED`） | [`docs/ARCHITECTURE_DECISIONS.md`](../ARCHITECTURE_DECISIONS.md) | 既有（ADR-001～019） |
| 測試報告 | 測了什麼、結果如何 | [`docs/TEST_REPORT.md`](../TEST_REPORT.md)、[`docs/UAT_EVIDENCE.md`](../UAT_EVIDENCE.md) | 既有 |
| 功能完成矩陣 | 每個功能做到哪、限制是什麼 | [`docs/FEATURE_STATUS_MATRIX.md`](../FEATURE_STATUS_MATRIX.md) | 既有 |
| 已知問題 | 已知的限制與技術債 | [`docs/KNOWN_ISSUES.md`](../KNOWN_ISSUES.md) | 既有 |
| 自動產生的結構文件 | 資料表／關聯／端點清單 | [`docs/generated/`](../generated/) | 由 `npm run docs:gen` 從資料庫與路由表產生 |

## 2. 建議閱讀順序

1. 要看全貌與取捨：本索引 → SAD §1～§4。
2. 要看安全與資料如何被保護：SAD §7、§8 → SDD §1（權限矩陣）。
3. 要看某個功能怎麼做、能不能改：SDD 對應模組章節 → 該模組的測試檔。
4. 要看有哪些地方「文件說的」與「程式做的」不一致：SAD §13、SDD §20（核對未決）。
5. 要看資料表欄位的完整定義：[`docs/generated/DATA_DICTIONARY.md`](../generated/DATA_DICTIONARY.md)（不重貼）；端點完整清單：[`docs/generated/API_ENDPOINTS.md`](../generated/API_ENDPOINTS.md)（不重貼）。

## 3. 約定

- **事實以程式為準**：文件與程式不一致時，以程式（`src/`、`migrations/`）為準；本組文件若寫錯，請視為文件錯誤。
- **核對標記**：✅ 已對照程式或 migration 確認；❓ 無法確認或程式與其他文件互相矛盾，列於「核對未決」。
- **金額與口徑**：結算、佣金、KPI 的公式都只寫「程式現在怎麼算」，並標「待 Owner 確認」，不代表業務已核准。
- **BLOCKED**：需要外部資源（憑證、平台、Owner 授權）才能做的項目，在圖與表中以 `BLOCKED`／「未接」標示，不畫成已完成。
- **圖**：全部使用 Mermaid（` ```mermaid `）。這組文件的圖已用 mermaid 11.4.1 在 headless Chromium 做過解析與渲染檢查（結果見各文件結尾的「文件自檢」）；實際在你的閱讀工具上是否正確顯示，取決於該工具支援的 Mermaid 版本。
- **機密**：文件中沒有任何 Sheet ID、帳號、密碼、金鑰或真實廠商／訂單資料；示範資料全部為虛構（名稱帶 `[DEMO]`）。

## 4. 文件基準版本與進行中的變更

- **基準**：本組文件撰寫時對應 HEAD `3be9a94`（14 個測試檔、245 項測試、11 支 migration）；**整合後**的程式為 16 個測試檔、305 項測試、12 支 migration（含獨立安全審查的修正，見 [docs/phase2/SECURITY_REVIEW.md](../phase2/SECURITY_REVIEW.md)）。下列「已於整合時修正」的項目，文件內的落差敘述保留原文並以 ✅ 標註。
- **撰寫時未納入、整合時已併入**：撰寫期間，同一工作目錄中另有**尚未提交**、由同時進行的「安全強化」任務所做的變更（例如 `migrations/012_security_hardening.sql`、`router.ts`、`idempotency.ts`、`audit-read.ts`、`orders.ts`、`config.ts` 等，以及新增的 `tests/security-*.test.ts`）。這些變更**不在本文敘述範圍內**。
- **會影響本文的項目**：從 `git diff` 看得到，下列「核對未決」項目正在被處理，合併後請重新核對並更新本文：SAD §13／SDD §20 的 #7（`SESSION_SECRET` 未使用：`sessionSecret()` 已被移除）、#10（財務稽核可見實體：`FINANCE_ENTITIES` 已擴充）、#12（冪等鍵不含使用者：雜湊已納入送出者）、#16（匯入未套用檔期範圍：已套用）；另有 K6（`idempotency_keys` 清理：新增每日清理）、`settlement_children_guard` 修補（migration 012）、請求輸入防呆（NUL 字元、壞的網址編碼、分頁參數）。
- ✅ 整合時另外修正：G4 檢查訊息已改為「結算試算與確認（需人工確認）」（SRS G-01／SAD §13 #2／SDD §20 #2）；庫存異動編號改用 `STK-` 前綴，012 之前的紀錄沿用 `INV-`（SRS G-06／SAD §13 #9／SDD §20 #9）；`SESSION_SECRET` 已移除（SRS G-09／NFR-SEC-09／SAD §8、§13／SDD §20 #7 的前半）；`ARCHITECTURE.md` 與 `docs/phase2/FULFILLMENT.md` 已更新。
- 仍有效（需 Owner 決定）：結算確認不自動推進 G4（G-02）、流程模板天數無編輯入口（G-03）、申請人≠核准人無設定入口（G-04）、登入 IP 取 `X-Forwarded-For`、團主可見欄位範圍等。

## 5. 與程式的對應速查

| 想找 | 看哪裡 |
|---|---|
| 權限定義 | `src/server/lib/permissions.ts`（SDD §1 的矩陣由此產生） |
| 資料範圍（誰看得到哪些檔期） | `src/server/lib/scope.ts` |
| API 路由表 | `src/server/api/routes.ts`；請求管線 `src/server/api/router.ts` |
| 狀態機 | `src/server/workflow/state.ts`；關卡 `src/server/modules/gates.ts` |
| 排程引擎 | `src/server/workflow/schedule.ts`（純函式）；預設模板 `template-default.ts` |
| KPI／佣金口徑 | `src/server/lib/kpi.ts`、`src/server/lib/commission-calc.ts` |
| 資料表 | `migrations/001`～`011`；自動產生的 `docs/generated/DATA_DICTIONARY.md` |
| 測試 | `tests/`（14 個檔案、245 項；真實 PostgreSQL） |
