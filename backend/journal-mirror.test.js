'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'x' }));
jest.mock('./db', () => ({ db: { query: jest.fn(), any: jest.fn(), oneOrNone: jest.fn() }, pool: {} }));
jest.mock('./services/journal/yclients', () => ({ records: jest.fn(), getRecord: jest.fn() }));
jest.mock('./services/loyalty', () => ({ upsertRecordFromYc: jest.fn() }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

const { db } = require('./db');
const yc = require('./services/journal/yclients');
const loyalty = require('./services/loyalty');
const mirror = require('./services/journal/mirror');
const salon = { id: 1 };

beforeEach(() => {
  jest.resetAllMocks();
  db.query.mockResolvedValue({ rows: [] });
  db.any.mockResolvedValue([]);
  db.oneOrNone.mockResolvedValue(null);
});

test('new record upserted with client id lookup', async () => {
  yc.records.mockResolvedValue([{ id: 5, client: { id: 9 } }]);
  db.oneOrNone.mockResolvedValue({ id: 42 });
  const r = await mirror.syncWindow(salon, '2026-11-09', '2026-11-12');
  expect(loyalty.upsertRecordFromYc).toHaveBeenCalledWith(1, { id: 5, client: { id: 9 } }, 42, 'journal_mirror');
  expect(r).toMatchObject({ upserted: 1, deleted: 0, moved: 0 });
  expect(db.query.mock.calls.pop()[0]).toMatch(/last_ok_at=NOW\(\)/);
});

test('missing + deleted in YClients', async () => {
  yc.records.mockResolvedValue([]);
  db.any.mockResolvedValue([{ yclients_record_id: '7', raw_payload: {} }]);
  yc.getRecord.mockResolvedValue({ id: 7, deleted: true });
  const r = await mirror.syncWindow(salon, 'a', 'b');
  expect(yc.getRecord).toHaveBeenCalledWith(salon, 7);
  expect(loyalty.upsertRecordFromYc).toHaveBeenCalledWith(1, { id: 7, deleted: true }, null, 'journal_mirror');
  expect(r).toMatchObject({ upserted: 0, deleted: 1, moved: 0 });
});

test('missing but alive -> moved', async () => {
  yc.records.mockResolvedValue([]);
  db.any.mockResolvedValue([{ yclients_record_id: 7, raw_payload: {} }]);
  yc.getRecord.mockResolvedValue({ id: 7, date: '2026-12-01 10:00:00' });
  const r = await mirror.syncWindow(salon, 'a', 'b');
  expect(r).toMatchObject({ upserted: 0, deleted: 0, moved: 1 });
});

test('404 -> upsert raw_payload with deleted', async () => {
  yc.records.mockResolvedValue([]);
  db.any.mockResolvedValue([{ yclients_record_id: 7, raw_payload: { id: 7, x: 1 } }]);
  yc.getRecord.mockRejectedValue(Object.assign(new Error('nf'), { status: 404 }));
  const r = await mirror.syncWindow(salon, 'a', 'b');
  expect(loyalty.upsertRecordFromYc).toHaveBeenCalledWith(1, { id: 7, x: 1, deleted: true }, null, 'journal_mirror');
  expect(r.deleted).toBe(1);
});

test('5xx on getRecord -> untouched', async () => {
  yc.records.mockResolvedValue([]);
  db.any.mockResolvedValue([{ yclients_record_id: 7, raw_payload: {} }]);
  yc.getRecord.mockRejectedValue(Object.assign(new Error('x'), { status: 502 }));
  const r = await mirror.syncWindow(salon, 'a', 'b');
  expect(loyalty.upsertRecordFromYc).not.toHaveBeenCalled();
  expect(r).toMatchObject({ upserted: 0, deleted: 0, moved: 0 });
});

test('records throws -> error state and rethrow', async () => {
  const err = new Error('down');
  yc.records.mockRejectedValue(err);
  await expect(mirror.syncWindow(salon, 'a', 'b')).rejects.toBe(err);
  expect(db.query.mock.calls[0][1]).toEqual([1, 'records_unavailable']);
});

test('windowFor', () => {
  expect(mirror.windowFor('near', new Date('2026-11-10T09:00:00Z'))).toEqual({ from: '2026-11-09', to: '2026-11-24' });
  expect(mirror.windowFor('far', new Date('2026-11-10T09:00:00Z')).to).toBe('2027-03-10');
});

test('freshness', async () => {
  db.oneOrNone.mockResolvedValueOnce({ last_ok_at: new Date('2026-11-10T00:00:00Z') });
  expect(await mirror.freshness(1)).toEqual({ mirrorOkAt: '2026-11-10T00:00:00.000Z' });
  db.oneOrNone.mockResolvedValueOnce(null);
  expect(await mirror.freshness(1)).toEqual({ mirrorOkAt: null });
});

test('a stored version as new or newer than the page is never overwritten', async () => {
  yc.records.mockResolvedValue([
    { id: 5, last_change_date: '2026-11-08T21:34:38+0300' },
    { id: 6, last_change_date: '2026-11-08T21:40:00+0300' },
    { id: 8, last_change_date: '2026-11-08T21:40:00+0300' },
  ]);
  db.any.mockImplementation(async sql => sql.includes('ANY($2::bigint[])') ? [
    { id: '5', changed: '2026-11-08T21:35:00+0300' }, // webhook already newer
    { id: '6', changed: '2026-11-08T21:30:00+0300' }, // ours is older
  ] : []);
  const r = await mirror.syncWindow(salon, 'a', 'b');
  expect(loyalty.upsertRecordFromYc.mock.calls.map(c => c[1].id)).toEqual([6, 8]);
  expect(r).toMatchObject({ upserted: 2, unchanged: 1 });
});
