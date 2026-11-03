import { DD_STATUS } from '../labels';
import { Badge } from '../components';

export interface DdItemProgressV {
  key: string; no: number; label: string; status: string; legalStatus: string; missingEvidence: boolean; evidenceExpired: number; evidenceExpiring: number; docDate: string | null; docState: 'EXPIRED' | 'EXPIRING' | null;
}
export interface DdReadinessV {
  ready: boolean; reasons: string[]; counts: Record<string, number>; expired: number; expiring: number; legalPending: number; risks: number;
  docExpired?: string[]; docExpiring?: string[]; progress?: { done: number; total: number }; perItem?: DdItemProgressV[];
}

const TONE: Record<string, string> = { CONFIRMED: 'var(--ok)', NOT_APPLICABLE: 'var(--muted)', PENDING_DOCS: 'var(--warn)', AT_RISK: 'var(--danger)' };

/**
 * 12 題完成進度（廠商頁、調查頁、G1 決策摘要共用）：進度條、12 格狀態，以及「缺件／缺證據／有風險／到期文件」清單。
 * compact＝只顯示進度條與數字（廠商頁表格用）。只用狀態與日期，不含任何敏感條款內容。
 */
export function DdProgress({ readiness, compact, testid = 'dd-progress' }: { readiness: DdReadinessV; compact?: boolean; testid?: string }) {
  const prog = readiness.progress ?? { done: (readiness.counts.CONFIRMED ?? 0) + (readiness.counts.NOT_APPLICABLE ?? 0), total: 12 };
  const pct = Math.round((prog.done / prog.total) * 100);
  const bar = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`12 題完成 ${prog.done}/${prog.total}`} style={{ width: compact ? 70 : 140, height: 8, borderRadius: 6, background: 'var(--neutral-bg)', overflow: 'hidden', display: 'inline-block' }}>
        <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: 'var(--primary)' }} /></span>
      <strong data-testid={`${testid}-count`}>{prog.done}/{prog.total}</strong>
    </span>
  );
  if (compact || !readiness.perItem) return <span data-testid={testid}>{bar}</span>;
  const per = readiness.perItem;
  const pending = per.filter((i) => i.status === 'PENDING_DOCS');
  const noEv = per.filter((i) => i.missingEvidence);
  const risk = per.filter((i) => i.status === 'AT_RISK');
  const docs = per.filter((i) => i.docState || i.evidenceExpired || i.evidenceExpiring);
  const names = (xs: DdItemProgressV[]) => xs.map((i) => `${i.no}. ${i.label}`).join('、');
  return (
    <div data-testid={testid}>
      <div style={{ marginBottom: 6 }}>12 題完成進度 {bar}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 3, margin: '4px 0 8px' }} aria-label="12 題各題狀態">
        {per.map((i) => <span key={i.key} title={`${i.no}. ${i.label}：${DD_STATUS[i.status]?.label ?? i.status}`} data-testid={`${testid}-cell-${i.no}`} style={{ textAlign: 'center', fontSize: 11, padding: '2px 0', borderRadius: 4, color: '#fff', background: TONE[i.status] ?? 'var(--muted)' }}>{i.no}</span>)}
      </div>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }} data-testid={`${testid}-lists`}>
        {pending.length ? <li data-testid={`${testid}-pending`}><Badge tone="warn">待補件 {pending.length}</Badge> {names(pending)}</li> : null}
        {noEv.length ? <li data-testid={`${testid}-noev`}><Badge tone="warn">缺有效證據 {noEv.length}</Badge> {names(noEv)}</li> : null}
        {risk.length ? <li data-testid={`${testid}-risk`}><Badge tone="danger">有風險 {risk.length}</Badge> {names(risk)}</li> : null}
        {docs.length ? <li data-testid={`${testid}-docs`}><Badge tone={docs.some((i) => i.docState === 'EXPIRED' || i.evidenceExpired) ? 'danger' : 'warn'}>到期文件</Badge> {docs.map((i) => `${i.no}. ${i.label}${i.docState === 'EXPIRED' ? `：授權已過期（${i.docDate}）` : i.docState === 'EXPIRING' ? `：授權即將到期（${i.docDate}）` : ''}${i.evidenceExpired ? `：${i.evidenceExpired} 筆證據已過期` : ''}${i.evidenceExpiring ? `：${i.evidenceExpiring} 筆證據即將到期` : ''}`).join('；')}</li> : null}
        {!pending.length && !noEv.length && !risk.length && !docs.length ? <li>沒有缺件、風險或到期文件</li> : null}
      </ul>
    </div>
  );
}
