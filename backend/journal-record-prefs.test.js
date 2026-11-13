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
test('apiIdFor is the bare package id: YClients keeps only a number (live run 13.11.2026)', () => {
  expect(prefs.apiIdFor(15)).toBe('15');
  expect(prefs.API_ID.test('15')).toBe(true);
  expect(prefs.API_ID.test('lp-outbox-15')).toBe(false);
});
describe('optOutForEvent', () => {
  test('row wins', async () => {
    db.oneOrNone.mockResolvedValueOnce({ notify_client: false });
    expect(await prefs.optOutForEvent(3, 500, '15')).toBe(true);
    expect(db.oneOrNone).toHaveBeenCalledTimes(1);
    db.oneOrNone.mockResolvedValueOnce({ notify_client: true });
    expect(await prefs.optOutForEvent(3, 500, '15')).toBe(false);
  });
  test('no row: numeric api_id → package of THIS salon with a create step → its flag', async () => {
    db.oneOrNone.mockResolvedValueOnce(null).mockResolvedValueOnce({ yclients_record_id: null, steps: [{ kind: 'create', params: { notifyClient: false } }] });
    expect(await prefs.optOutForEvent(3, 500, '15')).toBe(true);
    expect(db.oneOrNone.mock.calls[1][1]).toEqual([3, 15]);
    // a cancelled (incl. locally cancelled) package never claims a record by its number
    expect(db.oneOrNone.mock.calls[1][0]).toMatch(/status NOT IN \('cancelled'\)/);
    db.oneOrNone.mockResolvedValueOnce(null).mockResolvedValueOnce({ yclients_record_id: '500', steps: [{ kind: 'create', params: { notifyClient: false } }] });
    expect(await prefs.optOutForEvent(3, 500, '15')).toBe(true);
    db.oneOrNone.mockResolvedValueOnce(null).mockResolvedValueOnce({ yclients_record_id: null, steps: [{ kind: 'create', params: {} }] });
    expect(await prefs.optOutForEvent(3, 500, '15')).toBe(false);
  });
  test('a foreign numeric api_id (package created another record / has no create) → false', async () => {
    db.oneOrNone.mockResolvedValueOnce(null).mockResolvedValueOnce({ yclients_record_id: '777', steps: [{ kind: 'create', params: { notifyClient: false } }] });
    expect(await prefs.optOutForEvent(3, 500, '15')).toBe(false);
    db.oneOrNone.mockResolvedValueOnce(null).mockResolvedValueOnce({ yclients_record_id: null, steps: [{ kind: 'edit', params: { notifyClient: false } }] });
    expect(await prefs.optOutForEvent(3, 500, '15')).toBe(false);
  });
  test('missing, zero or non-numeric api_id never reads the outbox', async () => {
    for (const apiId of ['', null, '0', '000', 'site-15', 'lp-outbox-15', '1;DROP', '1234567890123456']) {
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
