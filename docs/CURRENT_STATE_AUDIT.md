# 現況盤點（CURRENT_STATE_AUDIT）

> 盤點日期：2026-10-28｜盤點人：AI 建造者（Claude Code）｜範圍：開工前的三個儲存庫＋本機環境
> 狀態標記：`VERIFIED_EXISTING`（開工前就存在且已讀過／驗證）｜`IMPLEMENTED_NEW`（本次新建且有測試證據）｜`PROPOSED`（只有設計／建議）｜`BLOCKED`（缺外部資源，無法在本環境完成）｜`NOT_STARTED`

## 1. 結論（先講重點）

1. **主儲存庫 `group-buying-operations` 開工前只有文件（3 份 ERP 文件＋研究報告＋2 個 Mermaid），完全沒有程式碼、資料庫定義、測試、CI、部署設定。** 因此本次是從零建置，不是在既有程式上增修。
2. 規格的完整度**足以建 Phase 1 的資料模型、狀態機、Gate、權限矩陣與 KPI 口徑**，但有 7 項「開發前必須拍板」仍未由 Owner 裁決（藍圖 §9.4），且路線圖 P0（需求凍結）狀態為「待開始」、SRS 尚未經 Owner 確認。依指示繼續建置，所有因此做出的設計決策都記在 [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md)，一律視為 `PROPOSED`，待 Owner 確認。
3. **找不到「ERP 八階段生命週期」的定義**（藍圖是 12 階段流程＋13 種檔期狀態＋5 個 Gate）。已自行提出 8 階段映射（ADR-004），待確認。
4. 兩個參考儲存庫已讀過，可複用的是**商業規則與踩雷經驗**（不是程式碼）。重要的不可複用／要避免的事項見 [REUSE_GAP_MATRIX.md](REUSE_GAP_MATRIX.md)。
5. 環境：本機沒有 Docker，已用 apt 安裝 PostgreSQL 16 並建立開發／測試資料庫；沒有任何外部帳號、憑證、真實訂單來源，這些一律標 `BLOCKED`。

## 2. 主儲存庫（開工前）

| 路徑 | 內容 | 狀態 |
|---|---|---|
| `README.md` | 文件導覽、變更邊界 | VERIFIED_EXISTING |
| `docs/ERP_MASTER_BLUEPRINT.md` | 第 1–9 章：願景、角色、資料模型、12 階段流程、狀態機、5 個 Gate、Dashboard、自動化、KPI、技術架構、導入策略 | VERIFIED_EXISTING（v0.1 規劃基準） |
| `docs/IMPLEMENTATION_ROADMAP.md` | P0–P7，皆「待開始」；明寫「完成 P0 後才開始程式實作」 | VERIFIED_EXISTING |
| `docs/DEVELOPMENT_LOG.md` | 2026-10-28 文件組建立紀錄；註明原對話第一則長篇回覆無法載入，1–9 章是「交叉還原」非逐字 | VERIFIED_EXISTING |
| `docs/2026-taiwan-group-buying-complete-research.md` | 市場、12 階段 SOP、Gate、KPI、法規研究 | VERIFIED_EXISTING（本次僅作背景，法規內容未逐條驗證） |
| `diagrams/*.mmd` | 端到端流程、資料關聯 | VERIFIED_EXISTING |
| 程式碼／資料庫／測試／CI／部署 | — | **不存在** |

## 3. 規格完整性檢查（對照任務要求的 7 項）

| 要求 | 規格現況 | 判斷 | 本次處理 |
|---|---|---|---|
| 明確角色權限 | §2.2 八個角色、§2.4 首版權限矩陣（僅 7 個動作），§2.3 原則；「團主可否看成本／淨利」等為待決策 | 部分 | 補成 6 角色＋34 個權限＋資料範圍規則（ADR-005），權限矩陣有測試鎖住（`tests/unit/misc.test.ts`） |
| 資料模型與唯一 ID | §3.1 實體清單、§3.2 ER 圖、§3.3 ID 格式建議；**欄位級資料字典未寫**（§3.5 要求先寫 5 個核心字典） | 部分 | 建 43 張表；資料字典由實際資料庫自動產生（[generated/DATA_DICTIONARY.md](generated/DATA_DICTIONARY.md)） |
| 團購生命週期與狀態機 | §4.2 十三種狀態＋進入條件＋下一步；§4.3 五個 Gate；**允許的轉移表未寫** | 部分 | 依狀態與 Gate 推導轉移表（ADR-008）；加上「暫緩」共 14 種狀態 |
| Dashboard 指標定義 | §5.2/5.3 元件清單、§7.1 KPI 公式；**期間、取消／退款是否計入、歸因口徑未寫** | 部分 | 定義口徑（ADR-010）並寫成單一程式來源 + 測試 |
| 工作流程與任務規則 | §4.4 任務引擎原則；SOP 11 步在 `groupbuy-flow-sop` | 足夠 | 轉成可配置模板（15 步），見 [WORKFLOW_MAPPING.md](WORKFLOW_MAPPING.md) |
| 訂單和業績資料來源規範 | §6.3 介面（CSV/API/Webhook）、§6.4 欄位原則、§5.5「即時」定義；**實際來源平台與欄位未定**（待決策 #3） | 不足 | 做 CSV 匯入（含去重、錯誤佇列）；API/Webhook = `BLOCKED` |
| MVP 驗收條件 | §9.2 MVP 範圍、§9.3 八個驗收情境、路線圖 Exit Criteria | 足夠 | 逐項對應到測試（[REQUIREMENTS_TRACEABILITY_MATRIX.md](REQUIREMENTS_TRACEABILITY_MATRIX.md)） |

### 3.1 規格歧義與矛盾（已做的決定都在 ADR）

| # | 歧義／缺漏 | 我的處理 |
|---|---|---|
| A1 | 「八階段」沒有定義 | ADR-004：提出 8 階段映射 |
| A2 | 路線圖要求先完成 P0；使用者指示直接做 Phase 1 MVP | 照使用者指示做；所有假設標 PROPOSED；不碰正式資料 |
| A3 | 角色「營運 PM」（藍圖）vs「營運小編」（本次任務） | ADR-005：合併為 `OPS_EDITOR`（營運小編／PM），只看自己負責的檔期 |
| A4 | 藍圖 12 階段 vs 13 種狀態 vs 招財兔 11 種狀態 | 用藍圖 13 種＋暫緩；招財兔狀態僅留在對照表（不匯入） |
| A5 | SOP 的 11 步與 G1–G5 的關係 | ADR-004：SOP 11 步保留，G1/G2/G3/G5 做成關卡任務（共 15 步） |
| A6 | KPI「本期」的定義、歸因口徑、PENDING 是否計入 | ADR-010 |
| A7 | 佣金／分潤：藍圖提到 Commission/Settlement，但公式屬「各群組不同」 | ADR-013：只做「預估佣金」（單一費率 × 歸因淨銷售），結算只建 Schema；**不套用招財兔分潤公式** |
| A8 | 廠商入口：藍圖列為 P4，且招財兔的 P4.3 公開入口被凍結 | 不做（NOT_STARTED）；不開放匿名存取 |

## 4. 參考儲存庫 `zhaocai-groupbuy-system`（招財兔，既有系統）

- 技術：Google Sheets（資料庫）＋ Apps Script（後端）＋ HtmlService；Web App v7，TEST 模式，存取限 Owner 本人。
- 已有（`VERIFIED_EXISTING`）：開團登記、廠商反查、更新、日曆、通知、發票清冊、銀行對帳（已建未啟用）、新廠商建檔（D1）、費用明細（D2）。
- 未完成（`NOT_STARTED`）：D3 分潤結算、D4 安全路由、D5 確認入帳頁面、D6 對帳回歸。
- **本次不修改、不遷移、不連線**；只讀其文件。細節與缺口見先前的顧問文件（該儲存庫 `docs/CONSULTANT_BRIEF.md`）。
- 本次從它**沿用的概念**：單一事實來源、ID 規則、軟刪除、雙 Log → 稽核表、TEST/LIVE 隔離、人工核准才寫入金額相關資料、狀態機、勾選制批次結算（僅 Schema）。

## 5. 參考儲存庫 `groupbuy-flow-sop`（團購代營運 SOP）

- 內容：Google 表單＋兩份試算表的 11 步流程、天數參數（寄送 7／試用 14／回饋 3／回收 7／圖文 7／結算 14／請款 14）、建置腳本（Python）、收件 Apps Script、10 項踩雷紀錄。
- 本次沿用：11 步任務與日期規則、條件式任務（回收／Live Talk）、逐檔覆寫日期（做成「人工鎖定」）、案主只看自己的資料（做成團主資料範圍）、自動收件（做成進件 + 去重）、待處理佇列（做成匯入錯誤佇列與例外）。
- 本次明確避開的踩雷：用品項名稱當唯一鍵（改用不可變 ID）、用列位置當索引、重建時清掉人工欄位（排程重算不覆寫已鎖定／已完成任務）、百分比欄位 20 → 2000%（`parseCommissionText`）。

## 6. 開發環境盤點

| 項目 | 結果 |
|---|---|
| Node／npm | v22.22.0／10.9.4 |
| PostgreSQL | 無；以 `apt-get install postgresql` 安裝 16.x，建立 `erp_dev`、`erp_test`（本機帳號，非機密） |
| Docker | 二進位存在但無 daemon → 不使用；以本機 PostgreSQL 代替 |
| 瀏覽器 | Chromium＋Playwright 1.63 預先安裝（供 E2E 煙霧測試） |
| 外部服務（LINE／Email／電商 API／Google Workspace／銀行） | 無憑證、無授權 → 全部 `BLOCKED`，以測試 Adapter／CSV 取代 |
| 真實資料 | 無；全程使用測試資料與明確標示的 DEMO 虛構資料 |

## 7. 功能狀態總表（開工前 → 完成後）

完整逐項狀態請看 [FEATURE_STATUS_MATRIX.md](FEATURE_STATUS_MATRIX.md)；需求追溯請看 [REQUIREMENTS_TRACEABILITY_MATRIX.md](REQUIREMENTS_TRACEABILITY_MATRIX.md)。
