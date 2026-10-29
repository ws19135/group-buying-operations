# 功能完成矩陣

> 狀態：`IMPLEMENTED_NEW` 已實作並有自動化測試｜`VERIFIED_EXISTING` 開工前已存在（僅文件）｜`PROPOSED` 只有設計｜`BLOCKED` 缺外部資源｜`NOT_STARTED` 未開始。
> **「已實作」不等於「已上線」**：全部只在本機／隔離環境驗證，沒有部署、沒有真實資料、沒有真實通知。

| # | 功能 | 狀態 | 證據 | 限制 |
|---|---|---|---|---|
| 1 | 本機可重現環境、`.env.example`、migration（12 支）、seed、DEMO seed | IMPLEMENTED_NEW | `DEPLOYMENT.md`；`database.test.ts`；seed 實跑 | 需自行安裝 PostgreSQL |
| 2 | 登入／登出／session／鎖定／限流／停用即失效 | IMPLEMENTED_NEW | `rbac.test.ts` | 無 SSO／MFA／密碼重設 |
| 3 | 6 角色 RBAC＋後端資料範圍＋欄位投影 | IMPLEMENTED_NEW | `rbac.test.ts`（21）、`unit/misc` | 無客服／稽核唯讀角色 |
| 4 | 稽核紀錄（不可竄改，含前後值）、軟刪除（資料庫層強制） | IMPLEMENTED_NEW | `database.test.ts`、`lifecycle.test.ts` | 無稽核匯出 |
| 5 | 廠商：CRUD／聯絡人／待補資料／異常／封存 | IMPLEMENTED_NEW | `scenarios.test.ts` | 合約（`agreements`）僅 Schema |
| 6 | 團主：CRUD／社群關聯／可承接檔期／歷史 | IMPLEMENTED_NEW | `scenarios.test.ts` | 「合作條件」為文字欄位，無結構化 |
| 7 | 社群：多平台 CRUD／團主關聯／曝光紀錄 | IMPLEMENTED_NEW | `scenarios.test.ts` | |
| 8 | 商品／SKU／素材連結／審核流程／成本權限 | IMPLEMENTED_NEW | `scenarios.test.ts`、`rbac.test.ts` | 素材只存連結，無檔案上傳 |
| 9 | 檔期：建立／編輯／多商品多 SKU／多團主／負責人／目標 | IMPLEMENTED_NEW | `lifecycle`、`scenarios`、`campaign-basic` | |
| 10 | 曝光安排（團主＋社群＋日期＋形式） | IMPLEMENTED_NEW | `scenarios.test.ts` | |
| 11 | 檔期衝突提醒（同商品／同社群／團主不可承接／團主同時多檔） | IMPLEMENTED_NEW | `scenarios.test.ts` | 同時進行上限固定為 2，尚不可設定 |
| 12 | 狀態機（14 狀態）＋G1–G5 核准＋取消／暫緩 | IMPLEMENTED_NEW | `lifecycle.test.ts`、`unit/misc` | 履約／結算內容屬 Phase 2；G4 僅人工確認 |
| 13 | 工作流程模板（15 任務、版本化）＋自動排程 | IMPLEMENTED_NEW | `unit/schedule`、`campaign-basic` | 只能調整天數參數版本；無步驟編輯器 |
| 14 | 日期變更影響預覽→確認→連動；人工鎖定；排程衝突 | IMPLEMENTED_NEW | `reschedule.test.ts`、`unit/schedule` | 手動鎖定單一任務日期後，下游要再走一次重排才會連動 |
| 15 | 任務：指派／狀態／相依／逾期／證據備註 | IMPLEMENTED_NEW | `lifecycle`、`rbac` | HOST 任務一檔一個（多團主時任一位可完成），未拆成每位團主一份 |
| 16 | 訂單 CSV 匯入（去重／更新／錯誤佇列／checksum） | IMPLEMENTED_NEW | `orders-dashboard.test.ts` | 無 API／Webhook；無訂單明細頁 |
| 17 | 管理者 Dashboard | IMPLEMENTED_NEW | `orders-dashboard.test.ts`；E2E | 無趨勢圖；大量資料未做快照／快取 |
| 18 | 團主 Dashboard（含預估佣金） | IMPLEMENTED_NEW | `orders-dashboard.test.ts`、`rbac.test.ts`；E2E | 預估≠結算 |
| 19 | 佣金規則（版本化）／預估佣金 | IMPLEMENTED_NEW | `orders-dashboard.test.ts`、`rbac.test.ts` | 單一費率×歸因淨銷售；無階梯／扣項 |
| 20 | 自動化 8 個工作（冪等／可停用／可重試／有紀錄） | IMPLEMENTED_NEW | `automation.test.ts` | 預設全部停用 |
| 21 | 廠商進件（去重、配對、草稿檔期） | IMPLEMENTED_NEW | `automation.test.ts` | 只有內部登入者可送進件（沒有公開表單） |
| 22 | 例外管理（開立、去重、認領、結案） | IMPLEMENTED_NEW | `automation.test.ts` | |
| 23 | 通知佇列＋測試 Adapter＋站內通知 | IMPLEMENTED_NEW | `automation.test.ts` | 真實 LINE／Email＝BLOCKED |
| 24 | 繁中管理介面（淺色、桌面為主、手機基本可用） | IMPLEMENTED_NEW | E2E（見 UAT_EVIDENCE） | 未做無障礙審查；僅繁中 |
| 25 | `GET /api/health`（含資料庫連線檢查） | IMPLEMENTED_NEW | E2E／手動 | 無詳細就緒探針、無告警 |
| 26 | CI（typecheck／lint／test／build） | IMPLEMENTED_NEW | `.github/workflows/ci.yml`（以 PR 上的執行結果為準） | 不含 E2E |
| 27 | 資料字典／ERD／API 清單（自動產生） | IMPLEMENTED_NEW | `docs/generated` | 業務欄位定義＝PROPOSED |
| 28 | 履約、庫存、出貨、簽收 | IMPLEMENTED_NEW | `tests/fulfillment.test.ts`（29）；`docs/phase2/FULFILLMENT.md` | 不接物流 API；庫存不隨出貨自動扣；團主／廠商不能自行簽收（廠商入口未解凍） |
| 29 | 退款、客訴、售後案件 | IMPLEMENTED_NEW | `tests/aftersales.test.ts`（31）；`scripts/e2e-aftersales.ts`（52/52）；`docs/phase2/AFTERSALES.md` | 不處理真實金流退款；退款寫回訂單預設關閉；逾期案件未接例外自動化 |
| 30 | 廠商入口（專屬連結／回填） | NOT_STARTED | — | 涉及對外存取，需 Owner 解凍 |
| 31 | 入帳確認、銀行對帳、發票、費用 | IMPLEMENTED_NEW（僅紀錄） | `tests/finance.test.ts`（22）；`docs/phase2/FINANCE.md` | 只做紀錄與人工核對；不接銀行、電子發票、金流 |
| 32 | 結算（試算／覆寫／確認／調整批次） | IMPLEMENTED_NEW（試算，口徑待確認） | `tests/finance.test.ts`；`docs/phase2/FINANCE.md` | 只重用既有佣金口徑；階梯／扣項／運費／平台費／退款扣回時點未做；確認不會自動推進 G4 |
| 33 | 歷史資料遷移與雙軌對帳 | NOT_STARTED | — | 待決策 #5、#6 |
| 34 | Google Sheets／Apps Script 相容層、Google 日曆同步 | PROPOSED / BLOCKED | — | 需 Google 授權；目前 CSV＋應用內行事曆 |
| 35 | 電商訂單 API／Webhook | BLOCKED | — | 缺平台與憑證 |
| 36 | 真實 LINE／Email 通知 | BLOCKED | — | 缺憑證與 Owner 授權 |
| 37 | SSO／MFA、密碼重設 | NOT_STARTED | — | 需 Owner 決定 |
| 38 | 備份還原演練、監控告警、RLS、Production 部署 | NOT_STARTED | — | 需 Owner 授權 |
| 39 | SOP 01 客群分析：客群輪廓、需求／阻力／品類／通路偏好、團主多客群與占比、研究證據、團主合作對象類型 | IMPLEMENTED_NEW | `tests/segments.test.ts`（23）；`docs/phase2/SEGMENT_FIT.md`；E2E 團主客群分析 | 事實／估計用人工標示；未知＝空值；證據不得含個資；沒有外部資料來源或問卷匯入 |
| 40 | 商品 × 團主適配評估：五維度可解釋評分（權重可設定）、未知不當 0 分、完整度與信心、合規／品質硬性檢查、評估版本與設定快照、人工覆核 | IMPLEMENTED_NEW | `tests/unit/fit-score.test.ts`（32）、`tests/fit.test.ts`（27）；三種突變驗證皆轉紅 | 權重與門檻為**建議值，待 Owner 確認**（D-18）；需求維度是關鍵字比對（一律標估計）；歷史績效樣本少時為未知 |
| 41 | 流程串接：新團主→客群分析提示、新商品→候選團主、檔期草稿→適配評估、G1 查閱評估、結案→成效回寫 | IMPLEMENTED_NEW | `tests/fit.test.ts`（G1 檢查項／核准結果／通知數不變）；E2E | **不改 G1–G5 語意、不自動核准、不發通知**；G1 是否納入檢查（D-19）與回寫是否排程（D-20）待決 |
| 42 | 客群適配總覽與評分設定頁、客群清單與詳情（含變更紀錄） | IMPLEMENTED_NEW | E2E（`scripts/e2e-smoke.ts` SOP 01 區塊 37 項） | 團主、廠商、財務沒有入口 |
