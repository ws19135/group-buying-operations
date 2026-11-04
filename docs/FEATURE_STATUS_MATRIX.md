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
| 25 | `GET /api/health`（含資料庫連線檢查） | IMPLEMENTED_NEW | E2E／手動 | 已新增 `/api/ready`（migration 就緒）與版本／commit；仍無外部告警（見第 55 列） |
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
| 37 | SSO／MFA、密碼重設 | NOT_STARTED | — | 需 Owner 決定（OWNER_DECISION_REQUIRED）；初次啟用強制變更密碼已完成（第 56 列） |
| 38 | 備份還原演練、監控告警、RLS、Production 部署 | PARTIAL | 備份／還原演練腳本與本機演練完成（第 57 列）；部署設定完成（第 55 列） | **尚未部署**；監控告警／RLS 未做；缺主機與網域（BLOCKED，Owner） |
| 39 | SOP 01 客群分析：客群輪廓、需求／阻力／品類／通路偏好、團主多客群與占比、研究證據、團主合作對象類型 | IMPLEMENTED_NEW | `tests/segments.test.ts`（23）；`docs/phase2/SEGMENT_FIT.md`；E2E 團主客群分析 | 事實／估計用人工標示；未知＝空值；證據不得含個資；沒有外部資料來源或問卷匯入 |
| 40 | 商品 × 團主適配評估：五維度可解釋評分（權重可設定）、未知不當 0 分、完整度與信心、合規／品質硬性檢查、評估版本與設定快照、人工覆核 | IMPLEMENTED_NEW | `tests/unit/fit-score.test.ts`（32）、`tests/fit.test.ts`（27）；三種突變驗證皆轉紅 | 權重與門檻為**建議值，待 Owner 確認**（D-18）；需求維度是關鍵字比對（一律標估計）；歷史績效樣本少時為未知 |
| 41 | 流程串接：新團主→客群分析提示、新商品→候選團主、檔期草稿→適配評估、G1 查閱評估、結案→成效回寫 | IMPLEMENTED_NEW | `tests/fit.test.ts`（G1 檢查項／核准結果／通知數不變）；E2E | **不改 G1–G5 語意、不自動核准、不發通知**；G1 是否納入檢查（D-19）與回寫是否排程（D-20）待決 |
| 42 | 客群適配總覽與評分設定頁、客群清單與詳情（含變更紀錄） | IMPLEMENTED_NEW | E2E（`scripts/e2e-smoke.ts` SOP 01 區塊 37 項） | 團主、廠商、財務沒有入口 |
| 43 | SOP 02 商品選品評估：六項 1–5 分加權（25/25/20/15/10/5，可設定、版本化）、每項理由與證據、安全合規獨立必要查核、完整度與信心、人工覆核；不含客群適配（唯讀引用 SOP 01） | IMPLEMENTED_NEW | `tests/unit/selection-score.test.ts`（14）、`tests/selection.test.ts`（27）；突變驗證 5 種皆轉紅（含評估送出後可改、連結 scheme 不檢查） | 權重／門檻為**建議值，待 Owner 確認**（D-25）；分數只是建議，不核准商品或 G1 |
| 44 | 廠商首次合作資格審查（12 類）：結構化條款、責任方、負責人、合約版本、證據與有效期、法務／合規審查標示、送審／核准／撤銷 | IMPLEMENTED_NEW | `tests/unit/dd-catalog.test.ts`（13）、`tests/diligence.test.ts`（30）；突變驗證 5 種皆轉紅（過期證據仍有效、分潤條款外洩／可寫、審查中可編輯、核准不檢查準備度） | 只標示「需法務或合規審查」，**不判斷合法**（D-29）；核准有效 365 天（D-27）；第 10 類分潤條款沿用 `product.cost.read`；不阻擋也不放行 G1（D-26） |
| 45 | SOP 03 商品試用：商品資格／團主與檔期適配兩層級、內部／指定團主／小規模測試團、四大面向 18 項檢核、客觀證據、缺陷、系統建議結論、覆寫、覆核、資格沿用與失效、試用品回收紀錄 | IMPLEMENTED_NEW | `tests/unit/trial-catalog.test.ts`（12）、`tests/trials.test.ts`（31）；突變驗證 5 種皆轉紅（可樂觀結論、指紋失效、過期、允許重複進行中、檔期範圍） | **不新增任務狀態機**，任務現況唯讀顯示；資格有效 180 天＋商品指紋（D-27、D-28）；回收逾期只記錄（D-34） |
| 46 | 商業可行性試算：GMV／有效淨銷售額／品牌利潤／公司營業收入分開、缺資料不捏造、每個輸入註明假設來源、版本化、小規模測試團實際回寫 | IMPLEMENTED_NEW | `tests/unit/feasibility-calc.test.ts`（21）、`tests/feasibility.test.ts`（18）；突變驗證 4 種皆轉紅（GMV 當收入、缺退款率當 0、成本外洩／可寫） | 口徑沿用 biz-model 04 的提案，**待 Owner 確認**（D-31）；只支援單一費率＋固定費；成本與利潤沿用 `product.cost.read` |
| 47 | G1 統一決策摘要（唯讀）：評估、資格審查、試用、可行性、客群適配、風險燈號；`gateImpact=NONE` | IMPLEMENTED_NEW | `tests/unit/decision-risk.test.ts`（6）、`tests/selection-g1.test.ts`（15）；突變驗證 3 種皆轉紅（不分阻礙、洩漏利潤正負、改動 G1 檢查項）；E2E | **不改 G1 檢查項與核准結果**；是否納入阻擋待決（D-26） |
| 48 | 畫面：`/selection`（總覽與設定）、廠商「合作資格審查」與 `/diligence/[id]`、商品三張卡片、`/trials/[id]`、`/feasibility/[id]`、檔期「選品與試用」分頁與 G1 提示 | IMPLEMENTED_NEW | E2E（`scripts/e2e-smoke.ts` SOP 02／03 區塊） | 團主、廠商沒有入口；營運小編看不到分潤與成本 |

| 49 | K-4／K-4a 有效導購訪客可驗證性與獨立查核：去重方式、佐證、規則版本化；填寫者≠查核者（服務層＋資料庫）；單一主管維持待查核；指派另一位既有有權限帳號（D-1：不建立使用者、不擴張權限）；補件鏈與事件時間軸 | IMPLEMENTED_NEW | `trial-kpi-decisions`、`unit/trial-reach-rules`；E2E；突變驗證 | 需第二位既有具 `product.review` 的帳號，否則 CVR 資料不足 |
| 50 | K-5／K-5a／D-2 客訴團主歸屬：訂單歸因優先、人工指定記來源、未歸屬保留；共同歸因僅在**可靠比例**下加權，否則待人工確認（不平均分配）；整體每件一次；團主層級客訴率在有待確認件時資料不足 | IMPLEMENTED_NEW | `unit/complaint-attribution`、`complaint-attribution`、`unit/trial-kpi`；突變驗證 | 客訴率只供營運參考，不作懲罰依據 |
| 51 | K-6／K-6a／D-5／D-7 分潤口徑差異核對、待人工確認項目、KPI 與結算口徑差異提醒、規則版本對照（唯讀＋手動同步） | IMPLEMENTED_NEW | `finance-comparison`、`commission-recon-items`、`unit/kpi-settlement-reminder`；E2E | 不改正式財務規則／結算；無排程；階段 4、5 未啟動 |
| 52 | K-7／K-7a～e／D-6 多商品成本分類、利潤影響、風險、保守情境（唯讀；不核准任何正式分攤） | IMPLEMENTED_NEW（唯讀） | `unit/cost-allocation-impact`、`cost-allocation-impact` | 多商品每單貢獻利潤維持資料不足；正式方法待 Owner |
| 53 | K-8／K-8a／D-3／D-4／D-8 費用歸屬欄位：承擔方≠實際付款方、**承擔方未知＝待確認（不算公司成本）**、應收應付（未確認非付款指示）、對應、條款來源、付款狀態、https 憑證連結、修正歷史、待補清單 | IMPLEMENTED_NEW | `expense-attribution`、`unit/expense-attribution`；突變驗證 | 不自動應付款／撥款／扣款／改發票；歷史資料不回填；不存檔案、不串外部系統 |
| 54 | F-01～F-06 合併前最終審查：財務總覽費用口徑（全部／已確認公司承擔／待確認／品牌或團主）、已確認應收應付變更後重新確認（服務層＋資料庫守衛）、付款與金額日期一致性、改檔期關聯驗證、KPI 與費用台帳口徑說明、migration 018～025 升級演練 | IMPLEMENTED_NEW | `tests/expense-integrity.test.ts`（14）、`scripts/migration-rehearsal.ts`（20/20）；突變驗證 12 種皆紅 | KPI 不納入台帳實際費用（Owner 裁決 O-1）；演練使用虛構資料 |

| 55 | 正式環境部署套件：Dockerfile（非 root）、compose（資料庫僅內部網路、Caddy 自動 HTTPS）、`.env.production.example`、docker-build CI、手動核准的 Deploy production 工作流程（需 CI 綠燈）、`/api/health`／`/api/ready` | IMPLEMENTED_NEW / TESTED（本機 production 模式） | `tests/prod-readiness.test.ts`；本機 `next start`＋空資料庫實跑；工作流程 YAML 驗證 | **DEPLOYED／LIVE_VERIFIED 皆否**：映像未在本機建置（映像庫無法連線，改由 GitHub 工作流程建置驗證）；缺主機、網域、部署金鑰 |
| 56 | 初次啟用安全：`prod:bootstrap`（僅空系統、拒絕 DEMO／弱密碼／範例信箱、不印密碼）、後端強制變更密碼（其他 API 一律 403）、密碼規則 | IMPLEMENTED_NEW / TESTED | `tests/prod-readiness.test.ts`（8）；Live UAT 第 2 項 | 無 MFA／SSO／自助重設（Owner 決定） |
| 57 | 備份與還原：`backup.sh`（校驗碼、可讀性驗證、保留期限）、`restore-drill.sh`（還原到暫存資料庫並逐表比對） | IMPLEMENTED_NEW / TESTED（本機） | 演練：27 筆 migration、各表筆數一致 | cron 排程與異地備份未設定（Owner） |
| 58 | O-2 已付款費用受控更正：`POST /expenses/:id/correct-paid`、不可變更正紀錄（`expense_corrections`）、稽核、重新確認、歷史顯示、不產生付款指示 | IMPLEMENTED_NEW / TESTED | `tests/prod-readiness.test.ts`；`expense-integrity` | 不碰結算；需 `finance.write`＋`product.cost.read` |
| 59 | O-1 KPI 口徑標示：每單貢獻利潤公式說明「依合約條款推算，非會計核對淨利」；未改公式、未納入台帳 | IMPLEMENTED_NEW / TESTED | `tests/trial-kpis.test.ts` | KPI 與台帳並列顯示屬後續 Owner 決定 |

## 上線驗收矩陣（A～F，2026-11-04）

> 狀態定義：IMPLEMENTED 已實作｜TESTED 自動化測試（含真實 PostgreSQL）與本機 E2E 通過｜DEPLOYED 已部署到正式／預備主機｜LIVE_VERIFIED 在該主機（HTTPS）以 Live UAT 驗證｜BLOCKED 缺外部資源｜OWNER_DECISION_REQUIRED 待 Owner 決定。
> **目前沒有任何項目是 DEPLOYED 或 LIVE_VERIFIED**（沒有主機）；「本機 production 模式空資料庫 Live UAT 21/21」是預備驗證，不等於上線驗證。

| 區 | 模組 | IMPLEMENTED | TESTED | DEPLOYED | LIVE_VERIFIED | 備註 |
|---|---|:-:|:-:|:-:|:-:|---|
| A | 基礎管理：登入／6 角色 RBAC／使用者／稽核／軟刪除／廠商／團主／社群／商品 | ✅ | ✅ | — | — | 初次啟用強制改密碼（本輪）；無 MFA／SSO（OWNER_DECISION_REQUIRED） |
| B | 團購營運：檔期／狀態機 G1–G5／工作流程／日期連動／訂單匯入／Dashboard | ✅ | ✅ | — | — | 無電商 API／Webhook（BLOCKED，缺平台與憑證） |
| C | 選品與試用 SOP01–03：客群、選品評估、資格審查、試用、可行性、G1 摘要 | ✅ | ✅ | — | — | 權重／門檻為建議值（D-18、D-25，OWNER_DECISION_REQUIRED）；多商品自動成本分攤「依政策未啟用」（D-6） |
| D | 八項 KPI：不設門檻（K-1）；有效導購訪客需來源／去重／獨立查核；成本未知或未歸屬→利潤「資料不足」 | ✅ | ✅ | — | — | 每單貢獻利潤為合約條款推算，已明確標示非會計淨利（O-1） |
| E | 訂單履約：庫存、出貨、簽收、退款、客訴、售後 | ✅ | ✅ | — | — | 不接物流 API；不處理真實金流退款；廠商入口未解凍（NOT_STARTED） |
| F | 財務與分潤：入帳、對帳、發票紀錄、費用歸屬、結算試算、O-2 更正 | ✅（僅紀錄＋試算） | ✅ | — | — | 結算流程未改動；不自動付款；預付款允許（O-3：付款日早於費用日不是錯誤） |
| — | 正式環境：容器、HTTPS、備份、回滾、部署流程 | ✅ | ✅（本機） | ❌ | ❌ | BLOCKED：主機、網域、部署金鑰（見 `HANDOFF.md`） |
| — | 真實通知（LINE／Email）、金流、Google 同步 | ❌ | — | — | — | 依政策未啟用；BLOCKED 或需 Owner 授權 |
