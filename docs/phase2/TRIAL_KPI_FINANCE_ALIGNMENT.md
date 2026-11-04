# KPI、商業可行性實際值回寫、Dashboard、分潤結算：口徑差異分析與相容性調整

> 對應 Owner 決策 K-3：「KPI 與商業可行性實際值回寫應採相同的經核准財務口徑，共用計算定義；但不得為了統一 KPI 而直接修改既有分潤結算規則。請先分析兩者差異，確定不影響正式結算後，再進行相容性調整。」
> 結論：**先分析、再調整；分潤結算（`lib/commission-calc.ts`、`modules/settlements.ts`、`modules/finance.ts`）與 Dashboard 的 `lib/kpi.ts` 沒有任何程式變動**，只調整 KPI 與「實際值回寫」這兩個顯示用、不入帳的計算。

## 1. 調整前：四個地方各自怎麼算

| 項目 | Dashboard（`lib/kpi.ts`） | 小規模測試團 KPI（PR #19 版） | 商業可行性實際值回寫（`recordActuals`） | 分潤結算（`lib/commission-calc.ts`） |
|---|---|---|---|---|
| 計入銷售的訂單 | PAID／PARTIAL_REFUND／REFUNDED | 同 | 同（訂單數、GMV、退款） | 同（淨銷售額） |
| 有效訂單 | PAID／PARTIAL_REFUND | 同 | **沒有**（`orders` 是計入銷售，含全額退款） | 不用 |
| GMV／退款 | 計入銷售的訂單 | **只算有效訂單**（差異 ①） | 計入銷售的訂單 | 不用毛額，直接算 (毛額 − 退款) × 歸因比例 |
| 客單價 | 淨銷售額 ÷ 有效訂單 | (有效訂單毛額 − 退款) ÷ 有效訂單 | **GMV ÷ 計入銷售訂單**（毛額、含全額退款；差異 ②） | 不用 |
| 退貨比例 | 有退款的訂單 ÷ 計入銷售訂單（件數） | 同 | **退款金額 ÷ GMV（金額）**（差異 ③） | 不用 |
| 利潤 | 無 | 實際值一律資料不足 | **不回寫利潤** | 佣金＝歸因淨銷售額 × 財務「分潤規則」費率 |
| 團主分潤比例來源 | — | — | — | `commission_rules`（財務維護、版本化） |

## 2. 差異與處置

| # | 差異 | 影響 | 處置 |
|---|---|---|---|
| ① | KPI 的 GMV／退款只算有效訂單，與 Dashboard、回寫（計入銷售）不同 | 有「全額退款但退款額小於毛額」的資料時，有效淨銷售額會不一致 | **調整 KPI**：改用計入銷售訂單的 GMV − 退款（與 Dashboard 一致）。一般資料（全額退款的退款額＝毛額）結果不變，既有測試維持通過 |
| ② ③ | 回寫的 `orders`、`aov`、`refundRatePct` 與 KPI 的有效訂單、有效客單價、退貨比例件數口徑不同 | 同一檔期兩個畫面的數字名稱相近但意義不同 | **不改既有欄位**（舊畫面與舊資料不受影響，欄位維持原義）；**新增**欄位 `validOrders`、`refundedOrders`、`cancelledOrders`、`netAov`，與 KPI 同一定義；畫面分別標示「計入銷售的訂單」「有效訂單」「客單價（GMV ÷ 計入銷售訂單）」「有效平均客單價（與 KPI 同一定義）」 |
| ④ | 回寫沒有利潤；KPI 沒有實際利潤 | Owner 要求兩者共用同一個經核准口徑 | **新增** `lib/actual-profit.ts`：與可行性試算共用 `calcFeasibility`（新增「實際值模式」，用實際 GMV、退款、有效訂單與退款訂單數取代預估）；KPI 與回寫都呼叫它，結果必然一致（整合測試驗證） |
| ⑤ | 團主分潤比例有兩個來源：可行性條款 `hostCommissionPct`（每個合作案的合約條件）與財務 `commission_rules`（結算用） | 兩者不同時，KPI 的每單貢獻利潤與結算的佣金會用不同費率 | **不統一、不改結算**；KPI 卡的風險提示列出「不一致」或「結算規則不存在」（只讀、只給有成本檢視權限者）。哪個為準請 Owner 決定（K-6） |
| ⑥ | 費用負擔方：可行性條款有，結算沒有 | 結算只算團主佣金，不處理運費、平台費、退款退貨費用 | 不處理（結算範圍不在本次）；KPI 依條款計算並標示來源 |

## 3. 共用定義放在哪

| 檔案 | 內容 | 使用者 |
|---|---|---|
| `lib/actual-sales.ts` | `loadActualSales`／`foldActualSales`：計入銷售、有效訂單、有退款訂單、取消、GMV、退款、有效淨銷售額、有效客單價、金額退款率（有團主時依歸因比例分攤） | KPI（`modules/trial-kpis.ts`）、實際值回寫（`modules/feasibility.ts`） |
| `lib/feasibility-calc.ts` | `calcFeasibility(inputs, { actual, requireReturnCost })`：預設行為與舊試算完全相同；實際值模式用實際數字 | 試算、`lib/actual-profit.ts` |
| `lib/actual-profit.ts` | `computeActualContribution`：條款是否已確認、是否完整、可否歸屬；資料不足的原因 | KPI、實際值回寫 |
| `modules/actual-contribution.ts` | 取檔期商品數與其他團主數（判斷可否歸屬） | KPI、實際值回寫 |

## 4. 確認不影響正式結算的證據

1. **沒有改動結算相關程式**：`lib/commission-calc.ts`、`lib/kpi.ts`、`modules/settlements.ts`、`modules/finance.ts`、`modules/commission.ts` 在本次變更的 diff 中沒有任何修改（可用 `git diff --stat` 核對）。
2. **結算測試維持通過**：`tests/finance.test.ts`、`tests/orders-dashboard.test.ts` 與 `tests/unit/kpi.test.ts` 全數通過。
3. **新增對照測試**：`tests/trial-kpi-decisions.test.ts` 在同一筆資料上先後呼叫 `campaignHostCommission`，驗證結算仍用財務分潤規則（淨銷售額 4,600 × 8% ＝ 368），與 KPI／可行性條款的 5% 無關；調整可行性條款不會改變結算結果。
4. **回寫既有欄位維持原義**：測試固定驗證 `orders`＝7（含全額退款）、`gmv`＝5600、`refund`＝1000、`nsv`＝4600、`aov`＝800、`refundRatePct`＝17.86，與調整前相同。
5. **舊的可行性試算結果不變**：未填「退款／退貨處理成本」的舊情境，試算的公司貢獻利潤照舊算得出來（`tests/unit/actual-profit.test.ts`）；既有 `tests/unit/feasibility-calc.test.ts`（21 項）全數通過。
6. **稽核不留金額**：回寫的稽核紀錄只記貢獻利潤的狀態，不記金額；沒有成本檢視權限者看不到實際貢獻利潤。

## 5. 仍待 Owner 決定

| 編號 | 問題 |
|---|---|
| K-6 | 可行性條款的團主分潤比例與財務分潤規則不同時，以哪個為準？建議以合約為準，並把兩者對齊（對齊會動到財務模組，需 Owner 同意才處理） |
| K-8 | 是否要讓分潤結算也處理「運費、平台費、退款退貨費用」的負擔方（目前結算只算團主佣金）？這是結算範圍的改變，不在本次 |

## 補充（2026-11-05，K-4a～K-8a）

- KPI 與結算分潤不一致時，KPI 卡顯示「口徑差異提醒」（K-6a），僅供有成本檢視權限者；KPI 不覆蓋結算。
- 費用的承擔方與實際付款方現在分開記錄（K-8a）；KPI 試算的負擔方仍來自可行性條款，與財務記錄的差異由 `/finance/reconciliation?tab=fees` 對照。
- 多商品檔期的每單貢獻利潤仍是「資料不足」（K-7a～e 只提供唯讀試算）。
