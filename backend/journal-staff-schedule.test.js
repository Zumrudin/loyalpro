'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic', JOURNAL_LOCAL_FIRST: true }));
jest.mock('./db', () => ({ db: { oneOrNone: jest.fn(), any: jest.fn(), query: jest.fn() }, pool: { connect: jest.fn() } }));
jest.mock('./services/journal/yclients', () => ({ list: jest.fn(), records: jest.fn(), getStaffSchedule: jest.fn(), setStaffSchedule: jest.fn() }));
jest.mock('./services/journal/sources', () => ({ forSalon: jest.fn(), openOutbox: jest.fn() }));
jest.mock('./services/journal/reference-cache', () => ({ storeSchedule: jest.fn() }));
jest.mock('./services/journal/sessions', () => ({ retry: jest.fn(), dismiss: jest.fn() }));
const { db, pool } = require('./db');
const yc = require('./services/journal/yclients');
const sources = require('./services/journal/sources');
const m = require('./services/journal/model');
const svc = require('./services/journal/staff-schedule');
const overlay = require('./services/journal/schedule-overlay');
const sessions = require('./services/journal/sessions');
const ref = require('./services/journal/reference-cache');
const date = '2030-04-01', staffId = 5, id = '12345678-1234-4123-8123-123456789012';
const slots = [{ from: '09:00', to: '18:00' }];
const day = [{ staff_id: staffId, date, slots, is_working: 1, busy_intervals: [] }];
const request = { sessionId: id, staffId, date, action: 'break', start: '12:00', end: '13:00' };
const target = [{ from: '09:00', to: '12:00' }, { from: '13:00', to: '18:00' }];
const draft = { operationId: id, staffId, date, slots: target, baseVersion: svc.versionOf({ staffId, date, slots }) };
let conn, src;
beforeEach(() => {
  jest.resetAllMocks();
  conn = { query: jest.fn(async sql => ({ rows: /pg_try_advisory_lock/.test(sql) ? [{ locked: true }] : [] })), release: jest.fn() };
  pool.connect.mockResolvedValue(conn);
  db.oneOrNone.mockImplementation(async sql => /FROM salons/.test(sql) ? { id: 3, yclients_company_id: 77 } : /INSERT INTO journal_outbox/.test(sql) ? { id: 21, status: 'queued' } : null);
  db.any.mockResolvedValue([]);
  src = { kind: 'local', staff: jest.fn(async () => [{ id: staffId }]), schedule: jest.fn(async () => day), records: jest.fn(async () => []) };
  sources.forSalon.mockResolvedValue(src); sources.openOutbox.mockResolvedValue([]);
  yc.list.mockResolvedValue([{ id: staffId }]); yc.records.mockResolvedValue([]);
  yc.getStaffSchedule.mockResolvedValue(day);
  yc.setStaffSchedule.mockImplementation(async () => { yc.getStaffSchedule.mockResolvedValue([{ ...day[0], slots: target }]); });
});
test.each([{ date: '2030-02-30' }, { start: '25:00' }, { end: '11:00' }, { staffId: -1 }, { sessionId: 'bad' }, { action: 'edit' }])('invalid input %j', patch => expect(() => svc.parse({ ...request, ...patch })).toThrow());
test('parse strips client tenant; break splits, add/remove target the whole day', () => {
  expect(svc.parse({ ...request, salonId: 99 })).toEqual(request);
  expect(svc.applyAction(request, day).slots).toEqual(target);
  expect(svc.applyAction({ ...request, action: 'remove' }, day).slots).toEqual([]);
  expect(svc.applyAction({ ...request, action: 'add' }, [{ date, is_working: 0, slots: [] }]).slots).toEqual([{ from: '12:00', to: '13:00' }]);
  expect(() => svc.applyAction({ ...request, start: '09:00' }, day)).toThrow();
  expect(() => svc.applyAction({ ...request, start: '11:30', end: '13:30' }, [{ ...day[0], slots: target }])).toThrow();
});
test('add accepts multiple breaks as one canonical full-day snapshot', () => {
  const add = svc.parse({
    ...request, action: 'add', start: '10:00', end: '22:00',
    breaks: [{ start: '17:00', end: '17:30' }, { start: '13:00', end: '14:00' }],
  });
  expect(add.breaks).toEqual([{ start: '13:00', end: '14:00' }, { start: '17:00', end: '17:30' }]);
  expect(svc.applyAction(add, [{ date, is_working: 0, slots: [] }]).slots).toEqual([
    { from: '10:00', to: '13:00' }, { from: '14:00', to: '17:00' }, { from: '17:30', to: '22:00' },
  ]);
  // Old callers that omit `breaks` retain the old parsed shape and one slot.
  const legacy = svc.parse({ ...request, action: 'add', start: '10:00', end: '22:00' });
  expect(legacy).not.toHaveProperty('breaks');
  expect(svc.applyAction(legacy, [{ date, is_working: 0, slots: [] }]).slots).toEqual([{ from: '10:00', to: '22:00' }]);
});
test.each([
  { breaks: {} },
  { breaks: [null] },
  { breaks: [{ start: '12:00', end: '12:00' }] },
  { breaks: [{ start: '09:30', end: '11:00' }] },
  { breaks: [{ start: '21:00', end: '22:00' }] },
  { breaks: [{ start: '12:00', end: '14:00' }, { start: '13:00', end: '15:00' }] },
  { breaks: Array.from({ length: 21 }, () => ({ start: '12:00', end: '12:05' })) },
])('add rejects invalid breaks %#', patch => {
  expect(() => svc.parse({ ...request, action: 'add', start: '10:00', end: '22:00', ...patch })).toThrow();
});
test('adjacent add breaks are valid and collapse without an artificial work gap', () => {
  const add = svc.parse({ ...request, action: 'add', start: '10:00', end: '22:00', breaks: [
    { start: '12:00', end: '13:00' }, { start: '13:00', end: '14:00' },
  ] });
  expect(svc.applyAction(add, [{ date, is_working: 0, slots: [] }]).slots).toEqual([
    { from: '10:00', to: '12:00' }, { from: '14:00', to: '22:00' },
  ]);
});
const record = (time, seconds = 3600) => ({ id: 7, staff_id: staffId, datetime: `${date}T${time}:00+03:00`, seance_length: seconds });
test('conflicts include technical breaks, adjacent intervals remain allowed', () => {
  expect(() => svc.assertNoConflicts([record('11:00')], staffId, date, slots, target)).not.toThrow();
  expect(() => svc.assertNoConflicts([{ ...record('11:00'), technical_break_duration: 300 }], staffId, date, slots, target)).toThrow();
  expect(() => svc.assertNoConflicts([record('12:00')], staffId, date, slots, target)).toThrow();
  expect(() => svc.assertNoConflicts([{ ...record('12:00'), staff_id: 99 }], staffId, date, slots, target)).not.toThrow();
  expect(() => svc.assertNoConflicts([], staffId, date, slots, target, [{ from: '12:00', to: '12:30' }])).toThrow();
});
test('cross-midnight record is checked in Moscow time', () => {
  const r = { ...record('00:00', 7200), datetime: '2030-03-31T23:30:00+03:00' };
  expect(() => svc.assertNoConflicts([r], staffId, date, [{ from: '00:00', to: '02:00' }], [])).toThrow();
});
test('local save is scoped, serialized, unreleased and has no external write', async () => {
  await expect(svc.enqueue(3, 4, request)).resolves.toMatchObject({ outboxId: 21, status: 'queued' });
  const call = db.oneOrNone.mock.calls.find(c => c[0].includes('INSERT INTO journal_outbox'));
  expect(call[1].slice(0, 3)).toEqual([3, id, 4]);
  expect(call[1][6]).toBe('5:2030-04-01'); expect(call[0]).not.toContain('released_at');
  expect(yc.setStaffSchedule).not.toHaveBeenCalled();
  expect(conn.query).toHaveBeenLastCalledWith('SELECT pg_advisory_unlock(17291, $1)', [3]);
});
test('duplicate save returns same result, changed body with same key is refused', async () => {
  db.oneOrNone.mockResolvedValue({ id: 21, status: 'queued', request_hash: m.fingerprint(request) });
  expect(await svc.enqueue(3, 4, request)).toMatchObject({ duplicate: true, outboxId: 21 });
  await expect(svc.enqueue(3, 4, { ...request, end: '14:00' })).rejects.toMatchObject({ code: 'session_used' });
  expect(sources.forSalon).not.toHaveBeenCalled();
});
test('break order is canonical for idempotent add replay', async () => {
  const first = svc.parse({ ...request, action: 'add', start: '10:00', end: '22:00', breaks: [
    { start: '17:00', end: '18:00' }, { start: '12:00', end: '13:00' },
  ] });
  const replay = svc.parse({ ...request, action: 'add', start: '10:00', end: '22:00', breaks: [
    { start: '12:00', end: '13:00' }, { start: '17:00', end: '18:00' },
  ] });
  db.oneOrNone.mockResolvedValue({ id: 21, status: 'queued', request_hash: m.fingerprint(first) });
  await expect(svc.enqueue(3, 4, replay)).resolves.toMatchObject({ duplicate: true, outboxId: 21 });
  expect(sources.forSalon).not.toHaveBeenCalled();
});
test('foreign employee and local appointment block enqueue', async () => {
  src.staff.mockResolvedValue([]);
  await expect(svc.enqueue(3, 4, request)).rejects.toMatchObject({ status: 404 });
  src.staff.mockResolvedValue([{ id: staffId }]); src.records.mockResolvedValue([record('12:00')]);
  await expect(svc.enqueue(3, 4, request)).rejects.toMatchObject({ code: 'schedule_conflict' });
});
test('appointments inside new add breaks are protected locally and before dispatch', async () => {
  const add = svc.parse({ ...request, action: 'add', start: '10:00', end: '22:00', breaks: [{ start: '13:00', end: '14:00' }] });
  const off = [{ staff_id: staffId, date, slots: [], is_working: 0, busy_intervals: [] }];
  src.schedule.mockResolvedValue(off);
  src.records.mockResolvedValue([record('13:15', 1800)]);
  await expect(svc.enqueue(3, 4, add)).rejects.toMatchObject({ code: 'schedule_conflict' });

  const addSlots = [{ from: '10:00', to: '13:00' }, { from: '14:00', to: '22:00' }];
  const addDraft = { operationId: id, staffId, date, slots: addSlots, baseVersion: svc.versionOf({ staffId, date, slots: [] }) };
  yc.getStaffSchedule.mockResolvedValue(off);
  yc.records.mockResolvedValue([record('13:15', 1800)]);
  await expect(svc.mutate(3, 4, addDraft)).rejects.toMatchObject({ code: 'schedule_conflict' });
  expect(yc.setStaffSchedule).not.toHaveBeenCalled();
});
test('contention and failed earlier schedule refuse a new save', async () => {
  conn.query.mockResolvedValueOnce({ rows: [{ locked: false }] });
  await expect(svc.enqueue(3, 4, request)).rejects.toMatchObject({ code: 'busy' });
  sources.openOutbox.mockResolvedValue([{ schedule_key: `5:${date}`, status: 'failed' }]);
  await expect(svc.enqueue(3, 4, request)).rejects.toMatchObject({ code: 'schedule_pending' });
});
test('dispatch verifies live version and persists pending before write and done after read-back', async () => {
  await expect(svc.mutate(3, 4, draft)).resolves.toEqual({ schedule: { staffId, date, slots: target } });
  const at = conn.query.mock.calls.findIndex(c => c[0].includes('INSERT INTO journal_operations'));
  expect(conn.query.mock.invocationCallOrder[at]).toBeLessThan(yc.setStaffSchedule.mock.invocationCallOrder[0]);
  expect(conn.query.mock.calls.some(c => c[0].includes("state='done'"))).toBe(true);
});
test('stale external version and busy activity prevent PUT', async () => {
  yc.getStaffSchedule.mockResolvedValue([{ ...day[0], slots: target }]);
  await expect(svc.mutate(3, 4, draft)).rejects.toMatchObject({ code: 'schedule_stale' });
  yc.getStaffSchedule.mockResolvedValue([{ ...day[0], busy_intervals: [{ from: '12:00', to: '12:30' }] }]);
  await expect(svc.mutate(3, 4, draft)).rejects.toMatchObject({ code: 'schedule_conflict' });
  expect(yc.setStaffSchedule).not.toHaveBeenCalled();
});
test('dispatch also protects locally queued new appointments', async () => {
  sources.openOutbox.mockResolvedValue([{ id: 22, status: 'queued', overlay: { kind: 'create', date, time: '12:00', staffId, duration: 30 } }]);
  await expect(svc.mutate(3, 4, draft)).rejects.toMatchObject({ code: 'schedule_conflict' });
  expect(yc.setStaffSchedule).not.toHaveBeenCalled();
});
test('pending deletion does not hide live appointment', async () => {
  yc.records.mockResolvedValue([record('12:00')]);
  sources.openOutbox.mockResolvedValue([{ id: 22, status: 'queued', yclients_record_id: 7, overlay: { kind: 'patch', patch: { deleted: true } } }]);
  await expect(svc.mutate(3, 4, draft)).rejects.toMatchObject({ code: 'schedule_conflict' });
});
test.each(['timeout', 'readback-403', 'mismatch'])('%s after PUT stays uncertain', async mode => {
  yc.setStaffSchedule.mockImplementation(async () => {
    if (mode === 'timeout') throw new Error('timeout');
    if (mode === 'readback-403') yc.getStaffSchedule.mockRejectedValue({ status: 403 });
  });
  await expect(svc.mutate(3, 4, draft)).rejects.toMatchObject({ code: 'uncertain' });
  expect(conn.query.mock.calls.some(c => c[0].includes("state='rejected'"))).toBe(false);
});
test('definite PUT refusal is rejected; existing pending never writes again', async () => {
  yc.setStaffSchedule.mockRejectedValue({ response: { status: 422 } });
  await expect(svc.mutate(3, 4, draft)).rejects.toMatchObject({ code: 'rejected' });
  yc.setStaffSchedule.mockClear();
  conn.query.mockImplementation(async sql => ({ rows: /pg_try/.test(sql) ? [{ locked: true }] : /SELECT request_hash/.test(sql) ? [{ request_hash: m.fingerprint(draft), state: 'pending' }] : [] }));
  await expect(svc.mutate(3, 4, draft)).rejects.toMatchObject({ code: 'uncertain' });
  expect(yc.setStaffSchedule).not.toHaveBeenCalled();
});
test('changes are tenant scoped and exclude payloads', async () => {
  db.any.mockResolvedValue([{ id: 21, status: 'failed', overlay: { staffId, date, secretField: 'do-not-return' } }]);
  expect(await svc.changes(3)).toEqual([expect.objectContaining({ outboxId: 21, staffId, date })]);
  expect(db.any.mock.calls[0][1]).toEqual([3]);
  expect(JSON.stringify(await svc.changes(3))).not.toContain('do-not-return');
});
test('dismiss requires review for uncertain result and refreshes cache before cancelling', async () => {
  const row = { status: 'failed', error_code: 'uncertain', steps: [{ state: 'uncertain', opId: id }], overlay: { staffId, date } };
  db.oneOrNone.mockImplementation(async sql => /FROM journal_outbox/.test(sql) ? row : /FROM salons/.test(sql) ? { id: 3, yclients_company_id: 77 } : { state: 'pending' });
  await expect(svc.recover(3, 21, 'dismiss')).rejects.toMatchObject({ code: 'uncertain' });
  expect(sessions.dismiss).not.toHaveBeenCalled();
  db.oneOrNone.mockImplementation(async sql => /FROM journal_outbox/.test(sql) ? row : /FROM salons/.test(sql) ? { id: 3, yclients_company_id: 77 } : { state: 'reviewed' });
  await svc.recover(3, 21, 'dismiss');
  expect(ref.storeSchedule).toHaveBeenCalledWith(3, { staffId, date, slots });
  expect(sessions.dismiss).toHaveBeenCalledWith(3, 21);
  expect(ref.storeSchedule.mock.invocationCallOrder[0]).toBeLessThan(sessions.dismiss.mock.invocationCallOrder[0]);
});
test('overlay preserves failed day removal and status across cache refresh', () => {
  const pending = [{ id: 21, schedule_key: `5:${date}`, status: 'failed', overlay: { kind: 'schedule', staffId, date, slots: [] } }];
  const result = overlay.applyOne(day, pending, staffId, date);
  expect(result[0].is_working).toBe(0);
  expect(m.staffSchedule(result, date)).toMatchObject({ working: false, scheduleSync: { status: 'failed', outboxId: 21 } });
  expect(overlay.applyOne(day, pending, 99, date)[0].slots).toEqual(slots);
});

test('confirmed replay returns result without touching external API', async () => {
  const result={schedule:{staffId,date,slots:target}};
  conn.query.mockImplementation(async sql=>({rows:/pg_try/.test(sql)?[{locked:true}]:/SELECT request_hash/.test(sql)?[{request_hash:m.fingerprint(draft),state:'done',result}]:[]}));
  expect(await svc.mutate(3,4,draft)).toEqual({...result,duplicate:true});
  expect(yc.getStaffSchedule).not.toHaveBeenCalled(); expect(yc.setStaffSchedule).not.toHaveBeenCalled();
});
