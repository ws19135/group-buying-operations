import { Banner } from '../components';
import { money } from '../format';

type R = Record<string, unknown> & { missing?: Record<string, string[]>; notes?: string[]; restricted?: boolean };
const n = (v: unknown) => (typeof v === 'number' ? v : null);
const Unknown = ({ why }: { why?: string[] }) => <span className="unknown" title={why?.length ? `缺少：${why.join('、')}` : undefined}>未知{why?.length ? `（缺 ${why.join('、')}）` : ''}</span>;

/** 試算結果。GMV、有效淨銷售額、品牌利潤、公司營業收入是四個不同的數字，分開呈現；缺資料顯示「未知」，不顯示成 0。 */
export function FeasibilityResults({ results, testid = 'fz-results' }: { results: R; testid?: string }) {
  const miss = results.missing ?? {};
  const row = (key: string, label: string, note?: string): [string, React.ReactNode] => [label, n(results[key]) == null ? (results.restricted && !['gmv', 'refund', 'nsv'].includes(key) ? <span className="muted">無權限查看</span> : <Unknown why={miss[key]} />) : <span data-testid={`${testid}-${key}`}>{money(n(results[key]))}{note ? <span className="small muted"> {note}</span> : null}</span>];
  const rows: [string, React.ReactNode][] = [
    row('gmv', 'GMV（成交總額）', '＝ 訂單 × 團購價；不是公司收入'), row('refund', '預估退款'), row('nsv', 'NSV（有效淨銷售額）'),
    row('productCost', '商品成本'), row('companyRevenue', '公司營業收入（品牌端服務費）'), row('hostCommission', '團主分潤'),
    row('companyContribution', '公司貢獻利潤'), row('brandProfit', '品牌利潤'), row('hostIncome', '團主收入'),
  ];
  if (n(results.takeRatePct) != null) rows.push(['公司抽成率（營業收入 ÷ NSV 有效淨銷售額）', `${results.takeRatePct}%`]);
  if (n(results.brandMarginPct) != null) rows.push(['品牌利潤率', `${results.brandMarginPct}%`]);
  if (n(results.escrowRemitToBrand) != null) rows.push(['應付品牌貨款（代收款，是負債）', money(n(results.escrowRemitToBrand))]);
  return (
    <div data-testid={testid}>
      {results.restricted ? <Banner kind="nodata">成本、費用、分潤與利潤屬敏感資料，您沒有成本檢視權限；GMV（成交總額）、退款與 NSV（有效淨銷售額）可查看。</Banner> : null}
      <dl className="kv">{rows.flatMap(([k, v]) => [<dt key={`k${k}`}>{k}</dt>, <dd key={`v${k}`}>{v}</dd>])}</dl>
      {(results.notes ?? []).length ? <ul className="small muted">{(results.notes ?? []).map((x) => <li key={x}>{x}</li>)}</ul> : null}
    </div>
  );
}
