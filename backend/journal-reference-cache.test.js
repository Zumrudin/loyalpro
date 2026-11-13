'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'x' }));
jest.mock('./db', () => ({ db: { query: jest.fn(), any: jest.fn(), oneOrNone: jest.fn() }, pool: {} }));
jest.mock('./services/journal/yclients', () => ({ list: jest.fn() }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

const { db } = require('./db');
const yc = require('./services/journal/yclients');
const rc = require('./services/journal/reference-cache');
const salon = { id: 1, yclients_company_id: 77 };

beforeEach(() => { jest.resetAllMocks(); db.query.mockResolvedValue({ rows: [] }); });

describe('refreshReference', () => {
  test('writes 5 kinds; failure of one does not stop others', async () => {
    yc.list.mockImplementation(async (s, path) => {
      if (path === '/resources/77') throw new Error('boom');
      return [{ id: 1 }];
    });
    const r = await rc.refreshReference(salon);
    expect(yc.list.mock.calls.map(c => c[1])).toEqual(['/staff/77', '/company/77/services/', '/resources/77', '/accounts/77', '/labels/77']);
    expect(r).toEqual({ ok: ['staff', 'services', 'accounts', 'labels'], failed: ['resources'] });
    const kinds = db.query.mock.calls.map(c => c[1][1]);
    expect(kinds).toEqual(['staff', 'services', 'accounts', 'labels']);
    expect(db.query.mock.calls[0][1][2]).toBe(JSON.stringify([{ id: 1 }]));
  });
});

describe('refreshSchedules', () => {
  test('skips administrators and fired; normalizes is_working', async () => {
    db.oneOrNone.mockResolvedValue({ payload: [
      { id: 1, name: 'A' }, { id: 2, name: 'B' },
      { id: 3, position: { title: 'Администратор' } }, { id: 4, fired: true },
    ] });
    yc.list.mockResolvedValue([
      { date: '2026-11-20', is_working: '1', slots: [{ from: '10:00', to: '20:00' }] },
      { date: '2026-11-21T00:00', is_working: 0, slots: null },
    ]);
    const r = await rc.refreshSchedules(salon, '2026-11-20', '2026-11-21');
    expect(yc.list).toHaveBeenCalledTimes(2);
    expect(yc.list.mock.calls[0][1]).toBe('/schedule/77/1/2026-11-20/2026-11-21');
    const ups = db.query.mock.calls;
    expect(ups).toHaveLength(4);
    expect(ups[0][1]).toEqual(expect.arrayContaining([true, '2026-11-20']));
    expect(ups[1][1]).toEqual(expect.arrayContaining([false, '2026-11-21', '[]']));
    expect(r).toEqual({ staff: 2, days: 4, failed: 0 });
  });
  test('no cached staff', async () => {
    db.oneOrNone.mockResolvedValue(null);
    expect(await rc.refreshSchedules(salon, 'a', 'b')).toEqual({ staff: 0 });
    expect(yc.list).not.toHaveBeenCalled();
  });
});

describe('getSchedule', () => {
  test('null without row', async () => {
    db.oneOrNone.mockResolvedValue(null);
    expect(await rc.getSchedule(1, 5, '2026-11-20')).toBeNull();
  });
  test('maps row', async () => {
    const slots = [{ from: '10:00', to: '22:00' }];
    db.oneOrNone.mockResolvedValue({ date: '2026-11-20', is_working: true, slots });
    expect(await rc.getSchedule(1, 5, '2026-11-20')).toEqual([{ date: '2026-11-20', is_working: 1, slots }]);
  });
});

describe('learnBonusPercent', () => {
  const sale = (applicable, balance, total) => ({
    state: { items: [{ cost_to_pay_total: total }] },
    payment_methods: [{ slug: 'loyalty_card', applicable_amount: applicable, loyalty_card: { balance } }],
  });
  test('writes percent', async () => {
    await rc.learnBonusPercent(1, sale(3000, 5000, 30000));
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][1]).toEqual([1, 'bonus_rule', JSON.stringify({ percent: 10 })]);
  });
  test('limited by balance -> no write', async () => {
    await rc.learnBonusPercent(1, sale(5000, 5000, 30000));
    expect(db.query).not.toHaveBeenCalled();
  });
  test('zero total -> no write', async () => {
    await rc.learnBonusPercent(1, sale(3000, 5000, 0));
    expect(db.query).not.toHaveBeenCalled();
  });
  test('never throws', async () => {
    db.query.mockRejectedValue(new Error('x'));
    await expect(rc.learnBonusPercent(1, sale(3000, 5000, 30000))).resolves.toBeUndefined();
  });
});
describe('getBonusPercent', () => {
  test('value / null', async () => {
    db.oneOrNone.mockResolvedValueOnce({ payload: { percent: 10 } });
    expect(await rc.getBonusPercent(1)).toBe(10);
    db.oneOrNone.mockResolvedValueOnce(null);
    expect(await rc.getBonusPercent(1)).toBeNull();
  });
});
