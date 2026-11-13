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

describe('storeLive / markDeleted — worker puts the live record after its own step (13.11.2026)', () => {
  const live = { id: 8, client: { id: 9 }, technical_break_duration: 600, last_change_date: '2026-11-13T10:00:05+0300' };
  test('upserts the live record (webhooks lack technical_break_duration) with source journal', async () => {
    db.oneOrNone.mockImplementation(async sql => /FROM clients/.test(sql) ? { id: 42 } : { changed: '2026-11-13T10:00:05+0300' });
    expect(await mirror.storeLive(salon, live)).toBe(true);
    expect(loyalty.upsertRecordFromYc).toHaveBeenCalledWith(1, live, 42, 'journal');
  });
  test('never overwrites a strictly newer stored version', async () => {
    db.oneOrNone.mockImplementation(async sql => /FROM clients/.test(sql) ? { id: 42 } : { changed: '2026-11-13T10:00:06+0300' });
    expect(await mirror.storeLive(salon, live)).toBe(false);
    expect(loyalty.upsertRecordFromYc).not.toHaveBeenCalled();
  });
  test('no id → nothing', async () => {
    expect(await mirror.storeLive(salon, null)).toBe(false);
    expect(loyalty.upsertRecordFromYc).not.toHaveBeenCalled();
  });
  test('markDeleted marks the stored row deleted like the window sync does', async () => {
    db.oneOrNone.mockResolvedValue({ raw_payload: { id: 8, comment: 'x' } });
    expect(await mirror.markDeleted(salon, 8)).toBe(true);
    expect(loyalty.upsertRecordFromYc).toHaveBeenCalledWith(1, { id: 8, comment: 'x', deleted: true }, null, 'journal');
    loyalty.upsertRecordFromYc.mockClear();
    db.oneOrNone.mockResolvedValue({ raw_payload: { id: 8, deleted: true } });
    expect(await mirror.markDeleted(salon, 8)).toBe(false);
    db.oneOrNone.mockResolvedValue(null);
    expect(await mirror.markDeleted(salon, 8)).toBe(false);
    expect(loyalty.upsertRecordFromYc).not.toHaveBeenCalled();
  });
});

describe('syncWindow: равный last_change_date, но другой перерыв (ревью 13.11.2026)', () => {
  const LCD = '2026-11-13T10:00:05+0300';
  test('перерыв в REST отличается от сохранённого → строка перезаписывается', async () => {
    yc.records.mockResolvedValue([{ id: 5, last_change_date: LCD, technical_break_duration: 600 }]);
    db.any.mockImplementation(async sql => /AS changed/.test(sql) ? [{ id: '5', changed: LCD, brk: null }] : []);
    const r = await mirror.syncWindow(salon, 'a', 'b');
    expect(loyalty.upsertRecordFromYc).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ upserted: 1, unchanged: 0 });
  });
  test('перерыв убран в YClients (0 при сохранённых 600) → перезапись', async () => {
    yc.records.mockResolvedValue([{ id: 5, last_change_date: LCD, technical_break_duration: 0 }]);
    db.any.mockImplementation(async sql => /AS changed/.test(sql) ? [{ id: '5', changed: LCD, brk: '600' }] : []);
    expect((await mirror.syncWindow(salon, 'a', 'b')).upserted).toBe(1);
  });
  test('перерыв тот же → unchanged, как раньше', async () => {
    yc.records.mockResolvedValue([{ id: 5, last_change_date: LCD, technical_break_duration: 600 }]);
    db.any.mockImplementation(async sql => /AS changed/.test(sql) ? [{ id: '5', changed: LCD, brk: '600' }] : []);
    const r = await mirror.syncWindow(salon, 'a', 'b');
    expect(loyalty.upsertRecordFromYc).not.toHaveBeenCalled();
    expect(r.unchanged).toBe(1);
  });
  test('сохранённая версия новее → не трогаем, даже если перерыв другой', async () => {
    yc.records.mockResolvedValue([{ id: 5, last_change_date: LCD, technical_break_duration: 600 }]);
    db.any.mockImplementation(async sql => /AS changed/.test(sql) ? [{ id: '5', changed: '2026-11-13T10:00:06+0300', brk: null }] : []);
    expect((await mirror.syncWindow(salon, 'a', 'b')).unchanged).toBe(1);
  });
});
