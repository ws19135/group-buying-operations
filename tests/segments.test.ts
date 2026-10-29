import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '@/server/lib/db';
import type { Actor } from '@/server/lib/permissions';
import { Client } from './api-helper';
import { addUser, makeWorld, mkCommunity, mkHost, type World } from './helpers';

let w: World;
let mgr: Client, ed: Client, fin: Client, hostC: Client, vendorC: Client;
let hostId: string, otherHostId: string;
let hostUser: Actor;

beforeAll(async () => {
  w = await makeWorld();
  hostId = (await mkHost(w, '[DEMO] 小雅媽咪')).id;
  otherHostId = (await mkHost(w, '[DEMO] 阿凱生活')).id;
  hostUser = await addUser(w.orgId, 'HOST', { hostIds: [hostId] });
  const vendorUser = await addUser(w.orgId, 'VENDOR', { vendorIds: [] });
  [mgr, ed, fin, hostC, vendorC] = await Promise.all([Client.forActor(w.manager), Client.forActor(w.editor), Client.forActor(w.finance), Client.forActor(hostUser), Client.forActor(vendorUser)]);
});

/** Owner 提供的範例輪廓（虛構）：團媽、育兒家庭 30–44 歲、LINE、每月 */
const OWNER_EXAMPLE = {
  name: '育兒家庭 30–44 歲', ageBand: '30_44', familyType: 'PARENTING', cycle: 'MONTHLY',
  motives: ['省時間', '品質安心'], barriers: ['陌生品牌', '怕踩雷'], categories: ['家庭清潔', '親子用品'], channels: ['LINE'],
};

describe('Owner 範例：團媽的客群分析一次建立並讀回', () => {
  it('建立合作對象類型、客群、偏好與觀察紀錄 → 讀回每一項；資料庫列與稽核都在', async () => {
    const patch = await mgr.call('PATCH', `/hosts/${hostId}`, { partnerType: 'GROUP_MOM' });
    expect(patch.status).toBe(200);
    const r = await ed.call('POST', `/hosts/${hostId}/segments`, {
      segment: OWNER_EXAMPLE, sharePercent: 100, basis: 'ESTIMATE',
      evidence: [{ kind: 'OBSERVATION', summary: '客群經常討論育兒、清潔效率、家庭日常補貨。' }],
    });
    expect(r.status).toBe(201);
    const segId = r.data.segmentId as string;

    const got = await ed.call('GET', `/hosts/${hostId}/segments`);
    expect(got.status).toBe(200);
    expect(got.data.partnerType).toBe('GROUP_MOM');
    expect(got.data.status).toBe('COMPLETE');
    expect(got.data.missing).toEqual([]);
    const s = got.data.links[0].segment;
    expect(s).toMatchObject({ id: segId, name: '育兒家庭 30–44 歲', ageBand: '30_44', familyType: 'PARENTING', cycle: 'MONTHLY', basis: 'ESTIMATE' });
    expect(s.motives.map((x: { value: string }) => x.value)).toEqual(['省時間', '品質安心']);
    expect(s.barriers.map((x: { value: string }) => x.value)).toEqual(['陌生品牌', '怕踩雷']);
    expect(s.categories.map((x: { value: string }) => x.value)).toEqual(['家庭清潔', '親子用品']);
    expect(s.channels.map((x: { value: string }) => x.value)).toEqual(['LINE']);
    expect(s.evidence).toHaveLength(1);
    expect(s.evidence[0]).toMatchObject({ kind: 'OBSERVATION', basis: 'ESTIMATE', hostId });
    expect(got.data.links[0].link).toMatchObject({ sharePercent: 100, basis: 'ESTIMATE' });

    // 直接讀資料庫確認（不只靠 API 回應）
    const rows = await query<{ kind: string; value: string; basis: string }>('SELECT kind, value, basis FROM segment_preferences WHERE segment_id=$1 AND deleted_at IS NULL ORDER BY id', [segId]);
    expect(rows).toHaveLength(7);
    expect(rows.every((x) => x.basis === 'ESTIMATE')).toBe(true);
    const audits = await query<{ action: string }>(`SELECT action FROM audit_logs WHERE organization_id=$1 AND (entity_id=$2 OR (entity_type='partner_segment_link' AND after_data->>'segmentId'=$2)) ORDER BY id`, [w.orgId, segId]);
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['segment.create', 'segment_link.create', 'segment.evidence.add']));
  });
});

describe('未知與缺漏要如實呈現，不能假裝是「無」', () => {
  it('只建客群名稱：狀態為 PARTIAL，列出缺哪些資料（含觀察來源）', async () => {
    const h = (await mkHost(w, '[DEMO] 米粒日常')).id;
    await ed.call('POST', `/hosts/${h}/segments`, { segment: { name: '待補輪廓客群' } });
    const got = await ed.call('GET', `/hosts/${h}/segments`);
    expect(got.data.status).toBe('PARTIAL');
    expect(got.data.missing).toEqual(expect.arrayContaining(['合作對象類型', '年齡層', '家庭型態', '消費週期', '購買動機', '購買阻力', '偏好品類', '活躍通路', '觀察來源']));
    const s = got.data.links[0].segment;
    expect(s.ageBand).toBeNull();     // 空值＝未知
    expect(s.motives).toEqual([]);
  });
  it('尚未建立任何客群：NOT_STARTED', async () => {
    const got = await ed.call('GET', `/hosts/${otherHostId}/segments`);
    expect(got.data.status).toBe('NOT_STARTED');
    expect(got.data.links).toEqual([]);
  });
});

describe('一團主多客群、占比、多通路、複選需求', () => {
  it('第二個客群占 40%，其他已占 60% → 成功；再加 10% 超過 100% → 422', async () => {
    const h = (await mkHost(w, '[DEMO] 多客群團主')).id;
    const a = await ed.call('POST', `/hosts/${h}/segments`, { segment: { name: '客群A', categories: ['食品零食'], channels: ['LINE', 'FACEBOOK'] }, sharePercent: 60 });
    expect(a.status).toBe(201);
    const b = await ed.call('POST', `/hosts/${h}/segments`, { segment: { name: '客群B', categories: ['3C'], channels: ['INSTAGRAM'] }, sharePercent: 40 });
    expect(b.status).toBe(201);
    const c = await ed.call('POST', `/hosts/${h}/segments`, { segment: { name: '客群C' }, sharePercent: 10 });
    expect(c.status).toBe(422);
    expect(c.error?.message).toContain('100%');
    const got = await ed.call('GET', `/hosts/${h}/segments`);
    expect(got.data.links).toHaveLength(2);
    expect(got.data.shareSum).toBe(100);
    // 失敗的建立不應留下客群（同一交易回滾）
    expect((await query('SELECT 1 FROM customer_segments WHERE organization_id=$1 AND name=$2', [w.orgId, '客群C'])).length).toBe(0);
    // 同一客群可被多位團主連結
    const h2 = (await mkHost(w, '[DEMO] 共用客群團主')).id;
    const shared = await ed.call('POST', `/hosts/${h2}/segments`, { segmentId: a.data.segmentId, sharePercent: 20 });
    expect(shared.status).toBe(201);
    const seg = await ed.call('GET', `/segments/${a.data.segmentId}`);
    expect(seg.data.hosts.map((x: { hostId: string }) => x.hostId).sort()).toEqual([h, h2].sort());
  });
  it('活躍通路只接受平台代碼；複選與重複值被去重', async () => {
    const bad = await ed.call('POST', '/segments', { name: '通路錯誤', channels: ['WECHAT'] });
    expect(bad.status).toBe(422);
    const ok = await ed.call('POST', '/segments', { name: '去重客群', motives: ['省時間', ' 省時間 ', '省 時間'] });
    expect(ok.status).toBe(201);
    const got = await ed.call('GET', `/segments/${ok.data.id}`);
    expect(got.data.motives).toHaveLength(1);
  });
  it('社群必須是此團主目前所屬的社群', async () => {
    const h = (await mkHost(w, '[DEMO] 社群團主')).id;
    const own = await mkCommunity(w, [h]);
    const foreign = await mkCommunity(w, [otherHostId]);
    const bad = await ed.call('POST', `/hosts/${h}/segments`, { segment: { name: '社群客群X' }, communityId: foreign.id });
    expect(bad.status).toBe(422);
    const ok = await ed.call('POST', `/hosts/${h}/segments`, { segment: { name: '社群客群Y' }, communityId: own.id });
    expect(ok.status).toBe(201);
  });
});

describe('事實／估計與研究證據', () => {
  it('標為事實的證據必須有來源；有來源說明或連結就可以；沒來源請標估計', async () => {
    const seg = (await ed.call('POST', '/segments', { name: '證據客群' })).data.id as string;
    const noSrc = await ed.call('POST', `/segments/${seg}/evidence`, { kind: 'SURVEY', basis: 'FACT', summary: '問卷顯示 70% 偏好免運' });
    expect(noSrc.status).toBe(422);
    expect(noSrc.error?.message).toContain('來源');
    const labelled = await ed.call('POST', `/segments/${seg}/evidence`, { kind: 'SURVEY', basis: 'FACT', summary: '問卷顯示 70% 偏好免運', sourceLabel: '2026-10 LINE 社群問卷（n=120）' });
    expect(labelled.status).toBe(201);
    const withUrl = await ed.call('POST', `/segments/${seg}/evidence`, { kind: 'PLATFORM_STAT', basis: 'FACT', summary: '平台後台統計', sourceUrl: 'https://example.invalid/stat' });
    expect(withUrl.status).toBe(201);
    const guess = await ed.call('POST', `/segments/${seg}/evidence`, { kind: 'OBSERVATION', summary: '感覺偏好免運' });
    expect(guess.status).toBe(201);
    expect((await query<{ basis: string }>('SELECT basis FROM segment_evidence WHERE id=$1', [guess.data.id]))[0].basis).toBe('ESTIMATE');
    const js = await ed.call('POST', `/segments/${seg}/evidence`, { kind: 'OTHER', basis: 'ESTIMATE', summary: 'x', sourceUrl: 'javascript:alert(1)' });
    expect(js.status).toBe(422);
  });
  it('資料庫層：FACT 沒來源會被 CHECK 擋下（繞過 API 也一樣）', async () => {
    const seg = (await ed.call('POST', '/segments', { name: '資料庫約束客群' })).data.id as string;
    await expect(query(`INSERT INTO segment_evidence (id, organization_id, segment_id, kind, basis, summary) VALUES ('EVD-X1',$1,$2,'SURVEY','FACT','x')`, [w.orgId, seg])).rejects.toThrow(/segment_evidence_check|check constraint/i);
  });
  it('個資防護：證據、客群名稱、偏好項目不得含手機號碼或 Email', async () => {
    const seg = (await ed.call('POST', '/segments', { name: '個資客群' })).data.id as string;
    expect((await ed.call('POST', `/segments/${seg}/evidence`, { kind: 'INTERVIEW', summary: '王媽媽 0912-345-678 說想要…' })).status).toBe(422);
    expect((await ed.call('POST', `/segments/${seg}/evidence`, { kind: 'INTERVIEW', summary: '聯絡 mom@example.invalid' })).status).toBe(422);
    expect((await ed.call('POST', '/segments', { name: '客群 0912345678' })).status).toBe(422);
    expect((await ed.call('PATCH', `/segments/${seg}`, { motives: ['mom@example.invalid'] })).status).toBe(422);
  });
  it('偏好可引用證據；移除證據後引用被清掉（不指向已移除的來源）', async () => {
    const seg = (await ed.call('POST', '/segments', { name: '引用客群' })).data.id as string;
    const ev = (await ed.call('POST', `/segments/${seg}/evidence`, { kind: 'SURVEY', basis: 'FACT', summary: '問卷', sourceLabel: '問卷A' })).data.id as string;
    expect((await ed.call('PATCH', `/segments/${seg}`, { motives: [{ value: '價格划算', basis: 'FACT', evidenceId: ev }] })).status).toBe(200);
    let got = await ed.call('GET', `/segments/${seg}`);
    expect(got.data.motives[0]).toMatchObject({ value: '價格划算', basis: 'FACT', evidenceId: ev });
    expect((await ed.call('POST', `/segment-evidence/${ev}/remove`, {})).status).toBe(200);
    got = await ed.call('GET', `/segments/${seg}`);
    expect(got.data.motives[0].evidenceId).toBeNull();
    expect(got.data.evidence).toEqual([]);
    expect((await query('SELECT deleted_at FROM segment_evidence WHERE id=$1', [ev]))[0].deleted_at).not.toBeNull();   // 軟刪除：列還在
    const other = (await ed.call('POST', '/segments', { name: '另一個客群' })).data.id as string;
    expect((await ed.call('PATCH', `/segments/${other}`, { motives: [{ value: 'x', evidenceId: ev }] })).status).toBe(422);
  });
});

describe('更新、版本、稽核與軟刪除', () => {
  it('更新有前後值稽核；偏好增減同步；被移除的偏好只是軟刪除', async () => {
    const seg = (await ed.call('POST', '/segments', { name: '更新客群', ageBand: '25_29', categories: ['食品零食', '生鮮'] })).data.id as string;
    const before = (await ed.call('GET', `/segments/${seg}`)).data;
    const up = await ed.call('PATCH', `/segments/${seg}`, { ageBand: '30_44', categories: ['生鮮', '寵物'], version: before.version });
    expect(up.status).toBe(200);
    const after = (await ed.call('GET', `/segments/${seg}`)).data;
    expect(after.ageBand).toBe('30_44');
    expect(after.categories.map((c: { value: string }) => c.value).sort()).toEqual(['寵物', '生鮮']);
    expect(after.version).toBeGreaterThan(before.version);
    const hist = after.history as { action: string; beforeData: Record<string, unknown> | null; afterData: Record<string, unknown> | null }[];
    const upd = hist.find((h) => h.action === 'segment.update');
    expect(upd?.beforeData).toMatchObject({ ageBand: '25_29' });
    expect(upd?.afterData).toMatchObject({ ageBand: '30_44' });
    const pref = hist.find((h) => h.action === 'segment.preferences');
    expect(pref?.afterData).toMatchObject({ categories: { added: ['寵物'], removed: ['食品零食'] } });
    const removed = await query('SELECT deleted_at FROM segment_preferences WHERE segment_id=$1 AND value=$2', [seg, '食品零食']);
    expect(removed).toHaveLength(1);
    expect(removed[0].deleted_at).not.toBeNull();
  });
  it('只改偏好時，客群版本也會前進；舊版本號更新 → 409', async () => {
    const seg = (await ed.call('POST', '/segments', { name: '版本客群' })).data.id as string;
    const v1 = (await ed.call('GET', `/segments/${seg}`)).data.version as number;
    expect((await ed.call('PATCH', `/segments/${seg}`, { motives: ['送禮'], version: v1 })).status).toBe(200);
    const v2 = (await ed.call('GET', `/segments/${seg}`)).data.version as number;
    expect(v2).toBeGreaterThan(v1);
    const stale = await ed.call('PATCH', `/segments/${seg}`, { ageBand: 'U25', version: v1 });
    expect(stale.status).toBe(409);
  });
  it('可清空欄位（null 或空字串）；價格帶下限高於上限 → 422', async () => {
    const seg = (await ed.call('POST', '/segments', { name: '清空客群', ageBand: '45_59', priceMin: 100, priceMax: 500, description: '說明' })).data.id as string;
    expect((await ed.call('PATCH', `/segments/${seg}`, { ageBand: null, priceMax: null, description: '' })).status).toBe(200);
    const got = (await ed.call('GET', `/segments/${seg}`)).data;
    expect(got.ageBand).toBeNull();
    expect(got.priceMax).toBeNull();
    expect(got.priceMin).toBe(100);
    expect(got.description).toBeNull();
    expect((await ed.call('PATCH', `/segments/${seg}`, { priceMin: 900 })).status).toBe(200);   // 上限已清空，開放區間
    expect((await ed.call('PATCH', `/segments/${seg}`, { priceMax: 300 })).status).toBe(422);   // 900 > 300
    expect((await ed.call('POST', '/segments', { name: '價格錯誤', priceMin: 500, priceMax: 100 })).status).toBe(422);
  });
  it('重複名稱回報既有 ID（建立與改名皆然）；連結同一客群兩次 → 409', async () => {
    const a = (await ed.call('POST', '/segments', { name: '重複客群' })).data.id as string;
    const dup = await ed.call('POST', '/segments', { name: ' 重複 客群 ' });
    expect(dup.status).toBe(409);
    expect(dup.error?.message).toContain(a);
    const b = (await ed.call('POST', '/segments', { name: '另一客群甲' })).data.id as string;
    expect((await ed.call('PATCH', `/segments/${b}`, { name: '重複客群' })).status).toBe(409);
    const h = (await mkHost(w, '[DEMO] 連結兩次')).id;
    expect((await ed.call('POST', `/hosts/${h}/segments`, { segmentId: a })).status).toBe(201);
    expect((await ed.call('POST', `/hosts/${h}/segments`, { segmentId: a })).status).toBe(409);
  });
  it('封存是軟刪除：仍有連結 → 412；結束連結後可封存；資料列還在；之後可用同名重建', async () => {
    const h = (await mkHost(w, '[DEMO] 封存團主')).id;
    const link = await ed.call('POST', `/hosts/${h}/segments`, { segment: { name: '封存客群' } });
    const seg = link.data.segmentId as string;
    expect((await ed.call('POST', `/segments/${seg}/archive`, { reason: '測試' })).status).toBe(412);
    expect((await ed.call('POST', `/segment-links/${link.data.id}/end`, {})).status).toBe(200);
    expect((await ed.call('POST', `/segments/${seg}/archive`, { reason: '' })).status).toBe(422);
    expect((await ed.call('POST', `/segments/${seg}/archive`, { reason: '客群已合併' })).status).toBe(200);
    expect((await ed.call('GET', `/segments/${seg}`)).status).toBe(404);
    expect((await query('SELECT deleted_at FROM customer_segments WHERE id=$1', [seg]))[0].deleted_at).not.toBeNull();
    expect((await query('SELECT ended_at FROM partner_segment_links WHERE id=$1', [link.data.id]))[0].ended_at).not.toBeNull();
    expect((await ed.call('POST', '/segments', { name: '封存客群' })).status).toBe(201);
    await expect(query('DELETE FROM customer_segments WHERE id=$1', [seg])).rejects.toThrow(/forbidden|soft delete/i);
    await expect(query('DELETE FROM partner_segment_links WHERE id=$1', [link.data.id])).rejects.toThrow(/forbidden|soft delete/i);
  });
  it('調整連結占比與依據；占比總和仍受限；已結束的連結不可再改', async () => {
    const h = (await mkHost(w, '[DEMO] 調占比')).id;
    const a = await ed.call('POST', `/hosts/${h}/segments`, { segment: { name: '占比甲' }, sharePercent: 70 });
    const b = await ed.call('POST', `/hosts/${h}/segments`, { segment: { name: '占比乙' }, sharePercent: 20 });
    expect((await ed.call('PATCH', `/segment-links/${b.data.id}`, { sharePercent: 40 })).status).toBe(422);
    expect((await ed.call('PATCH', `/segment-links/${b.data.id}`, { sharePercent: 30, basis: 'FACT' })).status).toBe(200);
    expect((await ed.call('PATCH', `/segment-links/${a.data.id}`, { sharePercent: 0 })).status).toBe(422);
    expect((await ed.call('PATCH', `/segment-links/${a.data.id}`, { sharePercent: null })).status).toBe(200);
    await ed.call('POST', `/segment-links/${b.data.id}/end`, {});
    expect((await ed.call('PATCH', `/segment-links/${b.data.id}`, { sharePercent: 10 })).status).toBe(404);
  });
  it('重複送出：同一個 Idempotency-Key 回放同一筆連結，不會產生第二筆', async () => {
    const h = (await mkHost(w, '[DEMO] 冪等團主')).id;
    const key = { 'idempotency-key': `seg-${Date.now()}` };
    const body = { segment: { name: '冪等客群' }, sharePercent: 50 };
    const r1 = await ed.call('POST', `/hosts/${h}/segments`, body, key);
    const r2 = await ed.call('POST', `/hosts/${h}/segments`, body, key);
    expect(r1.status).toBe(201);
    expect(r2.data.id).toBe(r1.data.id);
    expect(r2.data.replayed).toBe(true);
    expect((await query('SELECT 1 FROM partner_segment_links WHERE host_id=$1', [h])).length).toBe(1);
  });
});

describe('團主「合作對象類型」', () => {
  it('只接受定義的類型；可清空；財務與團主看不到', async () => {
    expect((await mgr.call('PATCH', `/hosts/${otherHostId}`, { partnerType: 'ALIEN' })).status).toBe(422);
    expect((await mgr.call('PATCH', `/hosts/${otherHostId}`, { partnerType: 'COMMUNITY_OWNER' })).status).toBe(200);
    expect((await ed.call('GET', `/hosts/${otherHostId}`)).data.partnerType).toBe('COMMUNITY_OWNER');
    expect((await fin.call('GET', `/hosts/${otherHostId}`)).data.partnerType).toBeUndefined();
    expect((await mgr.call('PATCH', `/hosts/${otherHostId}`, { partnerType: '' })).status).toBe(200);
    expect((await ed.call('GET', `/hosts/${otherHostId}`)).data.partnerType).toBeNull();
  });
  it('團主清單：有 segment.read 的角色看到客群數；財務看不到這兩個欄位', async () => {
    const e = await ed.call('GET', '/hosts');
    const row = e.data.items.find((x: { id: string }) => x.id === hostId);
    expect(row.segmentCount).toBeGreaterThanOrEqual(1);
    expect(row.partnerType).toBe('GROUP_MOM');
    const f = await fin.call('GET', '/hosts');
    const frow = f.data.items.find((x: { id: string }) => x.id === hostId);
    expect(frow.segmentCount).toBeUndefined();
    expect(frow.partnerType).toBeUndefined();
  });
});

describe('權限與租戶隔離', () => {
  it('團主、廠商、財務沒有任何客群分析入口（403）', async () => {
    for (const c of [hostC, vendorC, fin]) {
      expect((await c.call('GET', '/segments')).status).toBe(403);
      expect((await c.call('GET', `/hosts/${hostId}/segments`)).status).toBe(403);
      expect((await c.call('POST', '/segments', { name: '不該成功' })).status).toBe(403);
    }
    expect((await hostC.call('POST', `/hosts/${hostId}/segments`, { segment: { name: '團主自填' } })).status).toBe(403);
  });
  it('營運小編可讀寫；營運主管可讀寫', async () => {
    expect((await ed.call('GET', '/segments')).status).toBe(200);
    expect((await mgr.call('POST', '/segments', { name: '主管建立的客群' })).status).toBe(201);
  });
  it('他組織的客群讀不到（404）；不存在的團主 404', async () => {
    const w2 = await makeWorld();
    const other = await Client.forActor(w2.manager);
    const mine = (await ed.call('POST', '/segments', { name: '租戶隔離客群' })).data.id as string;
    expect((await other.call('GET', `/segments/${mine}`)).status).toBe(404);
    expect((await other.call('PATCH', `/segments/${mine}`, { ageBand: 'U25' })).status).toBe(404);
    expect((await other.call('GET', '/segments')).data.items.some((s: { id: string }) => s.id === mine)).toBe(false);
    expect((await ed.call('GET', '/hosts/OWN-999999/segments')).status).toBe(404);
    expect((await ed.call('POST', '/hosts/OWN-999999/segments', { segment: { name: 'x' } })).status).toBe(404);
  });
  it('列表篩選與搜尋', async () => {
    const r = await ed.call('GET', '/segments?q=育兒&ageBand=30_44');
    expect(r.data.items.some((s: { name: string }) => s.name.includes('育兒'))).toBe(true);
    expect(r.data.items.every((s: { ageBand: string }) => s.ageBand === '30_44')).toBe(true);
  });
});
