'use strict';
jest.mock('./db', () => ({ db: { oneOrNone: jest.fn(), query: jest.fn() } }));
jest.mock('./logger', () => { const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }; return { createLogger: () => log, __log: log }; });
const { db } = require('./db');
const { __log: log } = require('./logger');
const prefs = require('./services/journal/record-prefs');
beforeEach(() => { jest.clearAllMocks(); db.query.mockResolvedValue({ rowCount: 1 }); });
test('write upserts the flag with the package id, scoped by salon', async () => {
  await prefs.write(3, 500, false, 11);
  const [sql, args] = db.query.mock.calls[0];
  expect(sql).toMatch(/INSERT INTO journal_record_prefs/);
  expect(sql).toMatch(/ON CONFLICT \(salon_id,yclients_record_id\) DO UPDATE/);
  expect(args).toEqual([3, 500, false, 11]);
});
test('apiIdFor builds lp-outbox-<id>', () => expect(prefs.apiIdFor(15)).toBe('lp-outbox-15'));
describe('optOutForEvent', () => {
  test('row wins', async () => {
    db.oneOrNone.mockResolvedValueOnce({ notify_client: false });
    expect(await prefs.optOutForEvent(3, 500, 'lp-outbox-15')).toBe(true);
    expect(db.oneOrNone).toHaveBeenCalledTimes(1);
    db.oneOrNone.mockResolvedValueOnce({ notify_client: true });
    expect(await prefs.optOutForEvent(3, 500, 'lp-outbox-15')).toBe(false);
  });
  test('no row: api_id → package of THIS salon → create step flag', async () => {
    db.oneOrNone.mockResolvedValueOnce(null).mockResolvedValueOnce({ steps: [{ kind: 'create', params: { notifyClient: false } }] });
    expect(await prefs.optOutForEvent(3, 500, 'lp-outbox-15')).toBe(true);
    expect(db.oneOrNone.mock.calls[1][1]).toEqual([3, 15]);
    db.oneOrNone.mockResolvedValueOnce(null).mockResolvedValueOnce({ steps: [{ kind: 'create', params: {} }] });
    expect(await prefs.optOutForEvent(3, 500, 'lp-outbox-15')).toBe(false);
  });
  test('foreign or missing api_id never reads the outbox', async () => {
    for (const apiId of ['', null, 'site-15', 'lp-outbox-', 'lp-outbox-1;DROP']) {
      db.oneOrNone.mockReset(); db.oneOrNone.mockResolvedValueOnce(null);
      expect(await prefs.optOutForEvent(3, 500, apiId)).toBe(false);
      expect(db.oneOrNone).toHaveBeenCalledTimes(1);
    }
  });
  test('a DB failure means «notify as before»', async () => {
    db.oneOrNone.mockRejectedValueOnce(new Error('boom'));
    expect(await prefs.optOutForEvent(3, 500, null)).toBe(false);
    expect(log.warn).toHaveBeenCalled();
  });
});
