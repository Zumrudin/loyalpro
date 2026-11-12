'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret', JOURNAL_LOCAL_FIRST: true }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
jest.mock('./db', () => ({ db: { oneOrNone: jest.fn(), any: jest.fn(), query: jest.fn() }, pool: { connect: jest.fn() } }));
jest.mock('./services/service-catalog', () => ({ forJournal: jest.fn(), resolve: jest.fn(), journalService: jest.fn() }));
jest.mock('./services/journal/yclients', () => ({ list: jest.fn(), records: jest.fn(), getRecord: jest.fn(), write: jest.fn() }));
jest.mock('./services/journal/reference-cache', () => ({ getReference: jest.fn(), getSchedule: jest.fn() }));
jest.mock('./services/journal/mirror', () => ({ freshness: jest.fn() }));
const config = require('./config');
const { db } = require('./db');
const yc = require('./services/journal/yclients');
const reference = require('./services/journal/reference-cache');
const mirror = require('./services/journal/mirror');
const localCatalog = require('./services/service-catalog');
const service = require('./services/journal');
const sources = require('./services/journal/sources');
const m = require('./services/journal/model');

const salon = { id: 3, yclients_company_id: 30 };
const DATE = '2030-04-01';
const staff = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
const services = [{ id: 7, title: 'Тест', duration: 3600, resources: [], staff: [{ id: 1 }, { id: 2 }] }];
const schedule = id => [{ date: DATE, is_working: 1, slots: id === 1 ? [{ from: '09:00', to: '12:00' }] : [{ from: '10:00', to: '13:00' }] }];
const record = { id: 8, staff_id: 1, datetime: '2030-04-01T10:00:00+03:00', seance_length: 3600, services: [{ id: 7, title: 'Тест', cost: 500 }], client: { name: 'Тест' }, attendance: 0, comment: 'R' };
let outbox, mirrored;

beforeEach(() => {
  jest.clearAllMocks();
  config.JOURNAL_LOCAL_FIRST = true;
  outbox = []; mirrored = [record];
  localCatalog.forJournal.mockResolvedValue({ categories: [], services: [] });
  mirror.freshness.mockResolvedValue({ mirrorOkAt: '2030-04-01T08:00:00.000Z' });
  db.oneOrNone.mockImplementation(async (sql, args) => {
    if (sql.includes('FROM salons')) return salon;
    if (sql.includes('FROM records')) { const r = mirrored.find(x => x.id === Number(args[1])); return r ? { raw_payload: r } : null; }
    if (sql.includes('FROM journal_outbox')) return outbox.find(x => x.id === args[1]) || null;
    return null;
  });
  db.any.mockImplementation(async sql => {
    if (sql.includes('FROM records')) return mirrored.map(r => ({ raw_payload: r }));
    if (sql.includes('FROM journal_outbox')) return outbox;
    return [];
  });
  reference.getReference.mockImplementation(async (_, kind) => ({ staff, services, resources: [], accounts: [] }[kind]));
  reference.getSchedule.mockImplementation(async (_, id) => (id === 1 ? schedule(1) : null));
  yc.list.mockImplementation(async (_, path) => {
    if (path.startsWith('/staff/')) return staff;
    if (path.startsWith('/company/')) return services;
    if (path.startsWith('/resources/')) return [];
    const s = path.match(/^\/schedule\/30\/(\d+)\//);
    if (s) return schedule(Number(s[1]));
    return [];
  });
  yc.records.mockResolvedValue([record]);
  yc.getRecord.mockResolvedValue(record);
});

test('local day reads mirror and cache, one live schedule call for an uncached staff/day', async () => {
  const result = await service.day(3, DATE);
  expect(result.source).toBe('local');
  expect(result.freshness).toEqual({ mirrorOkAt: '2030-04-01T08:00:00.000Z' });
  expect(yc.records).not.toHaveBeenCalled();
  expect(yc.list.mock.calls.some(([, p]) => p.startsWith('/staff/'))).toBe(false);
  expect(yc.list.mock.calls).toEqual([[salon, '/schedule/30/2/2030-04-01/2030-04-01']]);
  expect(result.staff.map(s => [s.id, s.working])).toEqual([[1, true], [2, true]]);
  expect(result.records.map(r => r.id)).toEqual([8]);
  const recSql = db.any.mock.calls.find(([sql]) => sql.includes('FROM records'));
  expect(recSql[1]).toEqual([3, '2030-03-31', '2030-04-02']);
  expect(recSql[0]).toContain("status<>'deleted'");
});
test('local day overlays a queued create with a negative id and sync status', async () => {
  outbox = [{ id: 41, status: 'queued', yclients_record_id: null, updated_at: new Date().toISOString(), overlay: { kind: 'create', date: DATE, time: '11:00', duration: 30, staffId: 2, services: [{ id: 7, title: 'Тест', cost: 500 }], client: { name: 'Новый', phone: '79000000000' } } }];
  const result = await service.day(3, DATE);
  const added = result.records.find(r => r.id === -41);
  expect(added).toMatchObject({ staffId: 2, time: '11:00', duration: 30, clientName: 'Новый' });
  expect(added.sync).toMatchObject({ outboxId: 41, status: 'queued' });
  expect(result.records.find(r => r.id === 8).sync).toBeNull();
});
test('slots are identical via local and live sources for the same data', async () => {
  const draft = { date: DATE, staffId: 1, serviceIds: [7] };
  const local = await service.slots(3, draft);
  expect(yc.records).not.toHaveBeenCalled();
  config.JOURNAL_LOCAL_FIRST = false;
  const live = await service.slots(3, draft);
  expect(yc.records).toHaveBeenCalled();
  expect(local.slots.length).toBeGreaterThan(0);
  expect(local.slots).toEqual(live.slots);
  expect(local.duration).toBe(live.duration);
});
test('slots for an existing record read it from the mirror when local', async () => {
  const res = await service.slots(3, { date: DATE, staffId: 1, recordId: 8 });
  expect(yc.getRecord).not.toHaveBeenCalled();
  expect(res.slots).toContain('10:00');
});
test('queued overlay occupies time in local slots', async () => {
  outbox = [{ id: 42, status: 'queued', yclients_record_id: null, updated_at: new Date().toISOString(), overlay: { kind: 'create', date: DATE, time: '09:00', duration: 60, staffId: 1, services: [], client: { name: 'X' } } }];
  const before = (await service.slots(3, { date: DATE, staffId: 1, serviceIds: [7] })).slots;
  expect(before).toEqual(['11:00']);
  outbox = [{ ...outbox[0], overlay: { ...outbox[0].overlay, time: '11:00' } }];
  const res = await service.slots(3, { date: DATE, staffId: 1, serviceIds: [7] });
  expect(res.slots).toEqual(['09:00']);
});
test('cold cache falls back to live YClients', async () => {
  reference.getReference.mockResolvedValue(null);
  const result = await service.day(3, DATE);
  expect(result.source).toBe('live');
  expect(yc.records).toHaveBeenCalledWith(salon, '2030-03-31', '2030-04-02');
  expect(yc.list.mock.calls.some(([, p]) => p.startsWith('/staff/'))).toBe(true);
  expect(db.any.mock.calls.some(([sql]) => sql.includes('FROM records'))).toBe(false);
});
test('local reference miss throws cache_cold 503', async () => {
  reference.getReference.mockResolvedValue(null);
  await expect(sources.local(salon).resources()).rejects.toMatchObject({ status: 503, code: 'cache_cold' });
});
test('prepare (write path) checks availability against live YClients even with a warm cache', async () => {
  const draft = { action: 'create', date: DATE, time: '11:00', staffId: 1, serviceIds: [7], clientName: 'Synthetic', clientPhone: '70000000000', comment: '' };
  const body = await service.prepare(salon, draft);
  expect(body).toMatchObject({ staff_id: 1, datetime: '2030-04-01T11:00:00+03:00', seance_length: 3600 });
  expect(yc.records).toHaveBeenCalled();
  expect(yc.list.mock.calls.some(([, p]) => p.startsWith('/company/'))).toBe(true);
  expect(reference.getReference).not.toHaveBeenCalled();
  expect(db.any.mock.calls.some(([sql]) => sql.includes('FROM records'))).toBe(false);
});
test('detail of a negative id renders the queued outbox package of this salon', async () => {
  outbox = [{ id: 41, status: 'failed', error_text: 'Занято', yclients_record_id: null, updated_at: new Date().toISOString(), overlay: { kind: 'create', date: DATE, time: '11:00', duration: 30, staffId: 2, services: [], client: { name: 'Новый' }, comment: 'К' } }];
  const d = await service.detail(3, -41);
  expect(d).toMatchObject({ id: -41, comment: 'К', sync: { status: 'failed', errorText: 'Занято' } });
  expect(db.oneOrNone).toHaveBeenCalledWith(expect.stringContaining('journal_outbox WHERE salon_id=$1 AND id=$2'), [3, 41]);
  await expect(service.detail(3, -99)).rejects.toMatchObject({ status: 404 });
});
test('detail of a queue id already created in YClients returns the real record (10.11.2026)', async () => {
  outbox = [{ id: 45, status: 'done', yclients_record_id: '8', updated_at: new Date().toISOString(),
    overlay: { kind: 'create', date: DATE, time: '10:00', duration: 60, staffId: 1, services: [{ id: 225, title: 'Тест', cost: 500 }], client: { name: 'Тест' } } }];
  const viaQueue = await service.detail(3, -45);
  const real = await service.detail(3, 8);
  expect(viaQueue.id).toBe(8);
  expect(viaQueue.services[0].id).toBe(7);
  expect(viaQueue.editVersion).toBe(real.editVersion);
  expect(viaQueue.sync).toBeNull();
});
test('detail of a mirrored record applies its open patches; missing falls back to live', async () => {
  outbox = [{ id: 43, status: 'queued', yclients_record_id: '8', updated_at: new Date().toISOString(), overlay: { kind: 'patch', patch: { cancel: true } } }];
  const d = await service.detail(3, 8);
  expect(yc.getRecord).not.toHaveBeenCalled();
  expect(d).toMatchObject({ id: 8, attendance: -1, comment: 'R', sync: { outboxId: 43 } });
  mirrored = [];
  await service.detail(3, 8);
  expect(yc.getRecord).toHaveBeenCalledWith(salon, 8);
});
test('detail: payment state comes from our ledger and queue, not only the lagging mirror (10.11.2026)', async () => {
  let ledger = [];
  const base = db.any.getMockImplementation();
  db.any.mockImplementation(async (sql, args) => sql.includes('journal_financial_transactions') ? ledger : base(sql, args));
  // Nothing paid anywhere.
  expect(await service.detail(3, 8)).toMatchObject({ paid: false, paymentSync: false });
  // Payment queued, not yet sent: shown as paid-in-transit (edits stay blocked).
  outbox = [{ id: 44, status: 'running', yclients_record_id: '8', released_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    steps: [{ kind: 'pay', state: 'pending' }], overlay: { kind: 'patch', patch: {} } }];
  expect(await service.detail(3, 8)).toMatchObject({ paid: true, paymentSync: true });
  // Package done, YClients webhook not arrived yet: the confirmed ledger row is the truth.
  outbox = [];
  ledger = [{ action: 'payment', method: 'account', external_ids: [5], state: 'confirmed' }];
  expect(await service.detail(3, 8)).toMatchObject({ paid: true, paymentSync: false });
  // Removed again: not paid.
  ledger.push({ action: 'remove', method: 'account', external_ids: [5], target_transaction_id: 5, state: 'confirmed' });
  expect(await service.detail(3, 8)).toMatchObject({ paid: false });
});
test('route ids: negative accepted, zero and junk rejected', () => {
  expect(m.nonZeroId('-41')).toBe(-41);
  expect(m.nonZeroId('8')).toBe(8);
  for (const v of ['0', 'nope', '1.5', '', '-']) expect(() => m.nonZeroId(v)).toThrow();
});
test('local labels with a cold cache are an empty list (review T2)', async () => {
  reference.getReference.mockResolvedValue(null);
  await expect(sources.local(salon).labels()).resolves.toEqual([]);
});
test('detail: «не уведомлять» — from the create step of a queued record, from prefs of a mirrored one (12.11.2026)', async () => {
  outbox = [{ id: 41, status: 'queued', yclients_record_id: null, updated_at: new Date().toISOString(),
    steps: [{ kind: 'create', params: { notifyClient: false } }],
    overlay: { kind: 'create', date: DATE, time: '11:00', duration: 30, staffId: 2, services: [], client: { name: 'Новый' } } }];
  expect((await service.detail(3, -41)).notifyClient).toBe(false);
  outbox = [{ ...outbox[0], steps: [{ kind: 'create', params: {} }] }];
  expect((await service.detail(3, -41)).notifyClient).toBe(true);
  outbox = [];
  expect((await service.detail(3, 8)).notifyClient).toBe(true);
  const base = db.oneOrNone.getMockImplementation();
  db.oneOrNone.mockImplementation(async (sql, p) => /journal_record_prefs/.test(sql) ? { notify_client: false } : base(sql, p));
  expect((await service.detail(3, 8)).notifyClient).toBe(false);
});
