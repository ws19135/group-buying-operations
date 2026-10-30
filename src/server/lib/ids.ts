import type { Queryable } from './db';
import { ORG_TZ } from './config';

/** 台北時間的 YYYY-MM-DD */
export function todayTaipei(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: ORG_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

async function next(db: Queryable, key: string, period: string): Promise<number> {
  const r = await db.query<{ n: number }>(
    `INSERT INTO id_counters (key, period, n) VALUES ($1, $2, 1)
     ON CONFLICT (key, period) DO UPDATE SET n = id_counters.n + 1
     RETURNING n`,
    [key, period],
  );
  return Number(r.rows[0].n);
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');

export const ids = {
  org: async (db: Queryable) => `ORG-${pad(await next(db, 'ORG', ''), 4)}`,
  user: async (db: Queryable) => `USR-${pad(await next(db, 'USR', ''), 4)}`,
  host: async (db: Queryable) => `OWN-${pad(await next(db, 'OWN', ''), 4)}`,
  community: async (db: Queryable) => `GRP-${pad(await next(db, 'GRP', ''), 4)}`,
  vendor: async (db: Queryable) => `VEN-${pad(await next(db, 'VEN', ''), 4)}`,
  vendorContact: async (db: Queryable) => `VCT-${pad(await next(db, 'VCT', ''), 6)}`,
  product: async (db: Queryable) => `PRD-${pad(await next(db, 'PRD', ''), 6)}`,
  sku: async (db: Queryable) => `SKU-${pad(await next(db, 'SKU', ''), 6)}`,
  asset: async (db: Queryable) => `AST-${pad(await next(db, 'AST', ''), 6)}`,
  availability: async (db: Queryable) => `AVL-${pad(await next(db, 'AVL', ''), 6)}`,
  agreement: async (db: Queryable) => `AGR-${pad(await next(db, 'AGR', ''), 4)}`,
  campaign: async (db: Queryable, now: Date = new Date()) => {
    const ym = todayTaipei(now).slice(0, 7).replace('-', '');
    return `CMP-${ym}-${pad(await next(db, 'CMP', ym), 4)}`;
  },
  campaignProduct: async (db: Queryable) => `CPR-${pad(await next(db, 'CPR', ''), 6)}`,
  campaignHost: async (db: Queryable) => `CHS-${pad(await next(db, 'CHS', ''), 6)}`,
  placement: async (db: Queryable) => `PLC-${pad(await next(db, 'PLC', ''), 6)}`,
  approval: async (db: Queryable) => `APR-${pad(await next(db, 'APR', ''), 6)}`,
  exception: async (db: Queryable) => `EXC-${pad(await next(db, 'EXC', ''), 6)}`,
  template: async (db: Queryable) => `WFT-${pad(await next(db, 'WFT', ''), 4)}`,
  task: async (db: Queryable, now: Date = new Date()) => {
    const d = todayTaipei(now).replace(/-/g, '');
    return `TSK-${d}-${pad(await next(db, 'TSK', d), 4)}`;
  },
  order: async (db: Queryable) => `ORD-${pad(await next(db, 'ORD', ''), 6)}`,
  orderItem: async (db: Queryable) => `OIT-${pad(await next(db, 'OIT', ''), 6)}`,
  importBatch: async (db: Queryable, now: Date = new Date()) => {
    const d = todayTaipei(now).replace(/-/g, '');
    return `IMP-${d}-${pad(await next(db, 'IMP', d), 4)}`;
  },
  commissionRule: async (db: Queryable) => `CMR-${pad(await next(db, 'CMR', ''), 4)}`,
  serviceCase: async (db: Queryable) => `CAS-${pad(await next(db, 'CAS', ''), 6)}`,
  refundRequest: async (db: Queryable) => `RFD-${pad(await next(db, 'RFD', ''), 6)}`,
  settlementItem: async (db: Queryable) => `SIT-${pad(await next(db, 'SIT', ''), 6)}`,
  settlementAdjustment: async (db: Queryable) => `ADJ-${pad(await next(db, 'ADJ', ''), 6)}`,
  payment: async (db: Queryable) => `PAY-${pad(await next(db, 'PAY', ''), 6)}`,
  invoice: async (db: Queryable) => `INV-${pad(await next(db, 'INV', ''), 6)}`,
  expense: async (db: Queryable) => `EXP-${pad(await next(db, 'EXP', ''), 6)}`,
  settlement: async (db: Queryable, now: Date = new Date()) => {
    const d = todayTaipei(now).replace(/-/g, '');
    return `SET-${d}-${pad(await next(db, 'SET', d), 4)}`;
  },
  run: async (db: Queryable, now: Date = new Date()) => {
    const d = todayTaipei(now).replace(/-/g, '');
    return `RUN-${d}-${pad(await next(db, 'RUN', d), 4)}`;
  },
  notification: async (db: Queryable, now: Date = new Date()) => {
    const d = todayTaipei(now).replace(/-/g, '');
    return `NTF-${d}-${pad(await next(db, 'NTF', d), 6)}`;
  },
  fulfillmentBatch: async (db: Queryable) => `FBT-${pad(await next(db, 'FBT', ''), 6)}`,
  shipment: async (db: Queryable) => `SHP-${pad(await next(db, 'SHP', ''), 6)}`,
  inventoryMovement: async (db: Queryable) => `STK-${pad(await next(db, 'STK', ''), 6)}`,
  intake: async (db: Queryable) => `INT-${pad(await next(db, 'INT', ''), 6)}`,
  segment: async (db: Queryable) => `SEG-${pad(await next(db, 'SEG', ''), 4)}`,
  segmentPreference: async (db: Queryable) => `SPF-${pad(await next(db, 'SPF', ''), 6)}`,
  segmentLink: async (db: Queryable) => `LNK-${pad(await next(db, 'LNK', ''), 6)}`,
  segmentEvidence: async (db: Queryable) => `EVD-${pad(await next(db, 'EVD', ''), 6)}`,
  evidence: async (db: Queryable) => `EVI-${pad(await next(db, 'EVI', ''), 6)}`,
  ddRecord: async (db: Queryable) => `VDD-${pad(await next(db, 'VDD', ''), 6)}`,
  ddItem: async (db: Queryable) => `VDI-${pad(await next(db, 'VDI', ''), 6)}`,
  evaluation: async (db: Queryable) => `SEL-${pad(await next(db, 'SEL', ''), 6)}`,
  trial: async (db: Queryable) => `TRL-${pad(await next(db, 'TRL', ''), 6)}`,
  trialCheck: async (db: Queryable) => `TCK-${pad(await next(db, 'TCK', ''), 6)}`,
  feasibility: async (db: Queryable) => `FSB-${pad(await next(db, 'FSB', ''), 6)}`,
  fitAssessment: async (db: Queryable) => `FIT-${pad(await next(db, 'FIT', ''), 6)}`,
};
