'use strict';
jest.mock('./db', () => ({ db: { query: jest.fn() } }));
const config = require('./config');
const L = require('./services/bonus-ledger');

const orig = config.BONUS_LEDGER_PRIMARY;
afterEach(() => { config.BONUS_LEDGER_PRIMARY = orig; });
const fake = (rows = []) => { const calls = []; const q = jest.fn(async (sql, params) => { calls.push({ sql, params }); return { rows, rowCount: rows.length }; }); return { q, calls }; };

describe('flag off', () => {
  beforeEach(() => { config.BONUS_LEDGER_PRIMARY = false; });
  test('recompute/ensureOpening/bumpCardReading do nothing', async () => {
    const { q } = fake([{ id: 1 }]);
    expect(await L.recompute([1, 2], { q })).toBe(0);
    expect(await L.ensureOpening(1, { q })).toBeNull();
    expect(await L.bumpCardReading(1, 50, { q })).toBe(0);
    expect(q).not.toHaveBeenCalled();
  });
  test('setCardReading: legacy single UPDATE of both columns', async () => {
    const { q, calls } = fake([{ id: 5, bonus_balance: 10 }]);
    const r = await L.setCardReading(5, 10.5, { q });
    expect(r).toEqual({ id: 5, bonus_balance: 10 });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/bonus_balance=\$1::numeric/);
    expect(calls[0].sql).toMatch(/yclients_card_balance=\$1::numeric/);
    expect(calls[0].params).toEqual([10.5, 5]);
  });
  test('cardBase = bonus_balance', () => {
    expect(L.cardBase({ bonus_balance: '120', yclients_card_balance: '999' })).toBe(120);
    expect(L.cardBase(null)).toBe(0);
  });
});

describe('flag on', () => {
  beforeEach(() => { config.BONUS_LEDGER_PRIMARY = true; });
  test('recompute dedups, filters ids, passes statuses', async () => {
    const { q, calls } = fake([{ id: 1 }, { id: 2 }]);
    expect(await L.recompute(['1', 1, 2, 0, -3, 'x', 1.5, null], { q })).toBe(2);
    expect(calls[0].params).toEqual([[1, 2], ['queued', 'sending', 'confirmed']]);
    expect(await L.recompute([], { q })).toBe(0);
    expect(q).toHaveBeenCalledTimes(1);
  });
  test('RECOMPUTE_SQL only touches clients with an opening row', () => {
    expect(L.RECOMPUTE_SQL).toMatch(/EXISTS \(SELECT 1 FROM finance_operations o WHERE[^)]*o\.kind='bonus_opening'\)/);
    expect(L.RECOMPUTE_SQL).toMatch(/c\.id = ANY\(\$1::int\[\]\)/);
  });
  test('setCardReading writes only the card reading, then opening and recompute', async () => {
    const { q, calls } = fake([{ id: 7 }]);
    await L.setCardReading(7, 300, { q });
    const sqls = calls.map(c => c.sql);
    const upd = sqls.findIndex(s => /^UPDATE clients SET yclients_card_balance/.test(s));
    expect(upd).toBeGreaterThanOrEqual(0);
    expect(sqls[upd]).not.toMatch(/bonus_balance=\$1/);
    expect(sqls.some(s => /bonus_opening/.test(s) && /INSERT INTO finance_operations/.test(s))).toBe(true);
    expect(sqls.some(s => /^UPDATE clients c SET bonus_balance/.test(s))).toBe(true);
    expect(sqls[sqls.length - 1]).toMatch(/^SELECT \* FROM clients/);
  });
  test('openingFirst: opening INSERT before the card UPDATE', async () => {
    const { q, calls } = fake([{ id: 7 }]);
    await L.setCardReading(7, 300, { q, openingFirst: true });
    const sqls = calls.map(c => c.sql);
    const ins = sqls.findIndex(s => /INSERT INTO finance_operations/.test(s));
    const upd = sqls.findIndex(s => /^UPDATE clients SET yclients_card_balance/.test(s));
    expect(ins).toBeGreaterThanOrEqual(0);
    expect(ins).toBeLessThan(upd);
  });
  test('bumpCardReading rounds to kopecks and skips 0', async () => {
    const { q, calls } = fake([{}]);
    await L.bumpCardReading(3, 10.456, { q });
    expect(calls[0].params).toEqual([10.46, 3]);
    expect(await L.bumpCardReading(3, 0, { q })).toBe(0);
    expect(await L.bumpCardReading(3, 0.001, { q })).toBe(0);
    expect(await L.bumpCardReading(0, 5, { q })).toBe(0);
    expect(q).toHaveBeenCalledTimes(1);
  });
  test('cardBase uses card reading, falls back to bonus_balance', () => {
    expect(L.cardBase({ bonus_balance: 120, yclients_card_balance: '80.5' })).toBe(80.5);
    expect(L.cardBase({ bonus_balance: 120, yclients_card_balance: null })).toBe(120);
  });
});

describe('openingPlan', () => {
  test('math and counters (independent of flag)', async () => {
    const { q } = fake([
      { id: 1, card: '1000', done: '300', unsent: '0', current: 1000 },
      { id: 2, card: '100', done: '250', unsent: '-50', current: 100 },
      { id: 3, card: '0', done: '0', unsent: '0', current: 0 },
    ]);
    const p = await L.openingPlan(1, { q });
    expect(p.plan.map(x => x.opening)).toEqual([700, -150, 0]);
    expect(p.plan.map(x => x.balanceAfter)).toEqual([1000, 50, 0]);
    expect(p).toMatchObject({ clients: 3, withHistory: 2, negativeOpening: 1, withUnsent: 1, balanceChanges: 1, sumCard: 1100, sumOpening: 550 });
  });
});

describe('discrepancies', () => {
  test('maps rows and clamps limit', async () => {
    const { q, calls } = fake([{ client_id: 4, name: 'А', phone: '+7', yclients_client_id: '99', ours: '90', card: '100', unsent: '-10', confirmed: '100', diff: '0' },
      { client_id: 5, name: 'Б', phone: null, yclients_client_id: null, ours: null, card: null, unsent: null, confirmed: '30.5', diff: '30.5' }]);
    const rows = await L.discrepancies(2, { limit: 5000, q });
    expect(calls[0].params).toEqual([2, 1000]);
    expect(rows[0]).toEqual({ clientId: 4, name: 'А', phone: '+7', yclientsClientId: 99, ours: 90, unsent: -10, confirmed: 100, card: 100, diff: 0 });
    expect(rows[1]).toMatchObject({ clientId: 5, yclientsClientId: null, ours: 0, card: null, diff: 30.5 });
    await L.discrepancies(2, { limit: -4, q });
    expect(calls[1].params[1]).toBe(1);
    await L.discrepancies(2, { q });
    expect(calls[2].params[1]).toBe(200);
  });
});
