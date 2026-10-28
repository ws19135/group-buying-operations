# group-buying-operations

團購營運研究與 ERP 規劃的主要文件空間。

本儲存庫保存《2026 台灣團購經營完整研究報告》，並以此為基礎規劃跨群組、跨團主、跨廠商的團購 ERP。內容涵蓋端到端 SOP、營運 Gate、排程、Dashboard、資料模型、自動化、財務與 KPI，以及分階段導入與驗收方式。

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
