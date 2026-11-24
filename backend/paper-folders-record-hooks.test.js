'use strict';
jest.mock('./db', () => ({
  db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn(), any: jest.fn() },
  pool: { connect: jest.fn() },
}));
jest.mock('./services/yclients', () => ({ ycGet: jest.fn(), ycPost: jest.fn() }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
jest.mock('./services/paper-folders', () => ({
  safely: jest.fn(async fn => { try { return await fn(); } catch (_) { return undefined; } }),
  reconcileRecord: jest.fn(), reconcile: jest.fn(),
}));
const { db } = require('./db');
const folders = require('./services/paper-folders');
const loyalty = require('./services/loyalty');
const REC = { id: 800, date: '2030-04-01 10:00:00', attendance: 0, paid_full: 0, client: { id: 81 } };
beforeEach(() => {
  jest.clearAllMocks();
  db.oneOrNone.mockResolvedValue(null);
  db.one.mockResolvedValue({ id: 90 });
  db.query.mockResolvedValue({ rows: [] });
  folders.reconcileRecord.mockResolvedValue(undefined);
});
test('shared mirror INSERT reconciles only after persistence with server salon', async () => {
  await loyalty.upsertRecordFromYc(7, REC, 40, 'journal');
  expect(folders.reconcileRecord).toHaveBeenCalledWith(7, 90);
  expect(db.one.mock.invocationCallOrder[0]).toBeLessThan(folders.reconcileRecord.mock.invocationCallOrder[0]);
});
test('client replacement reconciles the new record and previous client', async () => {
  db.oneOrNone.mockResolvedValue({ id: 90, client_id: 39 });
  await loyalty.upsertRecordFromYc(7, REC, 40, 'journal');
  expect(folders.reconcileRecord).toHaveBeenCalledWith(7, 90);
  expect(folders.reconcile).toHaveBeenCalledWith(7, 39, { removed: true });
});
test('folder failure preserves successful record save', async () => {
  folders.reconcileRecord.mockRejectedValueOnce(new Error('synthetic folder failure'));
  await expect(loyalty.upsertRecordFromYc(7, REC, 40, 'journal')).resolves.toMatchObject({ id: 90, inserted: true });
});
test('unpaid webhook reconciles before the bonus early return', async () => {
  db.oneOrNone.mockImplementation(async sql => sql.includes('FROM clients') ? { id: 40 } : null);
  await loyalty.processRecordEvent({ status: 'create', data: REC }, { id: 7 }, {});
  expect(folders.reconcileRecord).toHaveBeenCalledWith(7, 90);
});
test('deleted record wins over stale status_id and attendance', () => {
  expect(loyalty.getRecordStatus({ deleted: true, status_id: 4, attendance: 1 })).toBe('deleted');
});
