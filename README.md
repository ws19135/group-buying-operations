# group-buying-operations

團購營運研究與 **團購 ERP** 的主要空間：規格文件（藍圖、路線圖、研究）＋ Phase 1 MVP 的實作與紀錄。

> **狀態（2026-10-28）**：Phase 1 MVP 已在分支 `feat/erp-mvp-phase1` 建置完成，可在本機／隔離環境操作。**尚未部署、未連任何正式資料或真實通知。** 完成度與證據見 [功能完成矩陣](docs/FEATURE_STATUS_MATRIX.md)、[測試報告](docs/TEST_REPORT.md)、[已知問題](docs/KNOWN_ISSUES.md)。

## 快速開始（本機）

```bash
npm ci
cp .env.example .env.local     # 編輯密碼與密鑰（不要提交）
npm run db:migrate && npm run db:seed
npm run db:seed:demo           # 選擇性：虛構的 [DEMO] 示範資料
npm run dev                    # http://localhost:3000
```

完整步驟、還原與環境變數：[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。驗證：`npm run typecheck && npm run lint && npm test && npm run build`。

## 技術與結構

Next.js 15 + TypeScript + PostgreSQL 16 模組化單體；服務層 `src/server`、頁面 `src/app`、migration `migrations/`。架構與決策：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/ARCHITECTURE_DECISIONS.md](docs/ARCHITECTURE_DECISIONS.md)。

## 實作文件

| 文件 | 用途 |
|---|---|
| [現況盤點](docs/CURRENT_STATE_AUDIT.md) | 開工前三個儲存庫的狀態、規格完整性檢查 |
| [複用與缺口矩陣](docs/REUSE_GAP_MATRIX.md) | 從招財兔／SOP 沿用了什麼、避開了什麼 |
| [需求追溯矩陣](docs/REQUIREMENTS_TRACEABILITY_MATRIX.md) | 需求 → 實作 → 測試 → 狀態 |
| [架構決策（ADR）](docs/ARCHITECTURE_DECISIONS.md) | 所有自行做的設計決定與待 Owner 裁決事項 |
| [工作流程映射](docs/WORKFLOW_MAPPING.md) | SOP 11 步 → 八階段 15 任務、排程規則 |
| [Dashboard 規格](docs/DASHBOARD_SPEC.md) | KPI 口徑、資料來源、DEMO／待串接規則 |
| [自動化](docs/AUTOMATION.md) | 8 個工作、安全欄杆、事件 |
| [API](docs/API.md)、[資料字典](docs/generated/DATA_DICTIONARY.md)、[ERD](docs/generated/ERD.md) | 介面與資料模型 |
| [公開示範環境部署](docs/DEMO_DEPLOYMENT.md) | 用 `render.yaml` 部署只含虛構資料的示範站，給同事瀏覽器直接看 |
| [測試報告](docs/TEST_REPORT.md)、[UAT 證據](docs/UAT_EVIDENCE.md)、[已知問題](docs/KNOWN_ISSUES.md) | 驗證結果與限制 |

## 開始閱讀

| 順序 | 文件 | 用途 |
| ---: | --- | --- |
| 1 | [團購 ERP 主藍圖](docs/ERP_MASTER_BLUEPRINT.md) | 第 1–9 章整體架構、角色、流程、Dashboard、資料與技術邊界 |
| 2 | [ERP 導入路線圖](docs/IMPLEMENTATION_ROADMAP.md) | P0–P7 階段、交付物、Exit Criteria 與 Owner 決策 |
| 3 | [ERP 開發紀錄](docs/DEVELOPMENT_LOG.md) | 已完成工作、來源限制、驗證證據與後續紀錄格式 |
| 4 | [2026 台灣團購經營完整研究報告](docs/2026-taiwan-group-buying-complete-research.md) | 市場、12 階段 SOP、Gate、KPI、法規與管理系統研究基礎 |

## 圖表原始碼

- [端到端團購流程 Mermaid 原始碼](diagrams/group-buying-end-to-end.mmd)
- [團購營運資料關聯 Mermaid 原始碼](diagrams/group-buying-data-flow.mmd)

## 使用方式

若要規劃或審核 ERP，從「團購 ERP 主藍圖」開始；若要理解市場與營運依據，再回到完整研究報告。GitHub 會原生顯示文件中的 Mermaid 圖；需要在其他工具重用流程圖時，可直接複製 `diagrams/` 內的 `.mmd` 原始碼。

## 變更邊界

- 文件中的「建議」與「待決策」不代表已實作或已上線。
- 正式程式、正式資料、退款、撥款、權限開放與 Production 部署需另行授權及驗收。
- 已核准的既有系統規格不得因主藍圖而被默默覆蓋；差異應先列出並由 Owner 決定。

## 版本基準

- 報告彙整日：2026-10-28
- 法規與官方來源核對日：2026-10-28
- 法規資訊僅供營運規劃；實際個案仍應由法務、會計或主管機關確認。
