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

