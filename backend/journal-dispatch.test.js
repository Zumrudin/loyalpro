'use strict';
jest.mock('./db', () => ({ db: { oneOrNone: jest.fn(), query: jest.fn(), any: jest.fn() }, pool: { connect: jest.fn() } }));
const { db } = require('./db');
const d = require('./services/journal/dispatch');

beforeEach(() => jest.clearAllMocks());

describe('period', () => {
  test('valid range', () => expect(d.period({ from: '2026-11-01', to: '2026-11-10' })).toEqual({ from: '2026-11-01', to: '2026-11-10' }));
  test('reversed / too long / garbage → 400', () => {
    expect(() => d.period({ from: '2026-11-10', to: '2026-11-01' })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => d.period({ from: '2025-01-01', to: '2026-11-01' })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => d.period({ from: 'x', to: '2026-11-01' })).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('release', () => {
  test('releases every waiting package of the hit records with one release id', async () => {
    db.any.mockImplementation(async (sql, args) => {
      if (sql === d.PERIOD_SQL) { expect(args).toEqual([3, '2026-11-10', '2026-11-10']); return [{ id: '5', grp: 'c5' }, { id: '9', grp: 'c5' }, { id: '12', grp: 'r42' }]; }
      if (sql === d.RELEASE_SQL) return args[2].map(id => ({ id }));
      return [];
    });
    const r = await d.release(3, { from: '2026-11-10', to: '2026-11-10' });
    expect(r).toMatchObject({ packages: 3, records: 2 });
    expect(r.releaseId).toMatch(/^[0-9a-f-]{36}$/);
    const call = db.any.mock.calls.find(c => c[0] === d.RELEASE_SQL);
    expect(call[1]).toEqual([3, r.releaseId, [5, 9, 12]]);
  });
  test('nothing waiting → no update', async () => {
    db.any.mockResolvedValue([]);
    expect(await d.release(3, { from: '2026-11-10', to: '2026-11-10' })).toMatchObject({ releaseId: null, packages: 0 });
    expect(db.any.mock.calls.some(c => c[0] === d.RELEASE_SQL)).toBe(false);
  });
  test('PERIOD_SQL releases whole record groups and only unreleased queued packages', () => {
    expect(d.PERIOD_SQL).toMatch(/status='queued' AND o\.released_at IS NULL/);
    expect(d.PERIOD_SQL).toMatch(/JOIN hit USING \(grp\)/);
    expect(d.RELEASE_SQL).toMatch(/released_at IS NULL/);
  });
});

describe('progress', () => {
  test('counts by status, finished when nothing queued/running', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    db.any.mockImplementation(async sql => /GROUP BY status/.test(sql) ? [{ status: 'done', n: 3 }, { status: 'failed', n: 1 }]
      : [{ id: 7, yclients_record_id: null, create_outbox_id: 5, error_text: 'Время уже занято', overlay: { kind: 'patch', patch: {} } }]);
    const r = await d.progress(3, id);
    expect(r).toMatchObject({ total: 4, done: 3, failed: 1, finished: true });
    expect(r.failures).toEqual([{ outboxId: 7, recordId: -5, date: null, clientName: '', errorText: 'Время уже занято' }]);
  });
  test('bad id → 400', async () => {
    await expect(d.progress(3, 'x')).rejects.toMatchObject({ status: 400 });
  });
});
