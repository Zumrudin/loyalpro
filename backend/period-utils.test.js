'use strict';
// Общий разбор периода (utils/period.js): дашборд (routes/api.js) и «Экономика»
// (routes/economics.js). Значения обоих наборов + безопасность на мусоре.
const { resolvePeriod, PeriodError } = require('./utils/period');

// 2026-10-19 12:00 мск (09:00 UTC), понедельник.
const NOW = new Date('2026-10-19T09:00:00Z');
const rp = (q) => resolvePeriod(q, { now: NOW });

describe('resolvePeriod — значения дашборда (поведение не меняется)', () => {
  test('from/to, перестановка', () => {
    expect(rp({ from: '2026-10-01', to: '2026-10-10' })).toEqual({ from: '2026-10-01', to: '2026-10-10' });
    expect(rp({ from: '2026-10-10', to: '2026-10-01' })).toEqual({ from: '2026-10-01', to: '2026-10-10' });
  });
  test('today / day / week / month', () => {
    expect(rp({ period: 'today' })).toEqual({ from: '2026-10-19', to: '2026-10-19' });
    expect(rp({ period: 'day' })).toEqual({ from: '2026-10-19', to: '2026-10-19' });
    expect(rp({ period: 'week' })).toEqual({ from: '2026-10-19', to: '2026-10-19' });
    expect(resolvePeriod({ period: 'week' }, { now: new Date('2026-10-18T09:00:00Z') })).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(rp({ period: 'month' })).toEqual({ from: '2026-10-01', to: '2026-10-19' });
  });
  test('N дней назад, по умолчанию 30, мусор → 30, ≤0 → 1', () => {
    expect(rp({ period: '7' })).toEqual({ from: '2026-10-13', to: '2026-10-19' });
    expect(rp({})).toEqual({ from: '2026-09-20', to: '2026-10-19' });
    expect(rp({ period: 'abc' })).toEqual({ from: '2026-09-20', to: '2026-10-19' });
    expect(rp({ period: '-5' })).toEqual({ from: '2026-10-19', to: '2026-10-19' });
    expect(rp({ period: '0' })).toEqual({ from: '2026-10-19', to: '2026-10-19' }); // как у дашборда: max(1, 0)
  });
  test('московская дата «сегодня» около полуночи', () => {
    expect(resolvePeriod({ period: 'today' }, { now: new Date('2026-10-18T22:30:00Z') })).toEqual({ from: '2026-10-19', to: '2026-10-19' });
  });
});

describe('resolvePeriod — значения «Экономики»', () => {
  test('quarter', () => {
    expect(rp({ period: 'quarter' })).toEqual({ from: '2026-10-01', to: '2026-10-19' });
    expect(resolvePeriod({ period: 'quarter' }, { now: new Date('2026-05-05T09:00:00Z') })).toEqual({ from: '2026-04-01', to: '2026-05-05' });
  });
  test('некалендарная дата не принимается — разбор идёт по period', () => {
    expect(rp({ from: '2026-02-30', to: '2026-03-01', period: 'today' })).toEqual({ from: '2026-10-19', to: '2026-10-19' });
  });
});

describe('resolvePeriod — безопасность', () => {
  test('огромный period → PeriodError, а не RangeError', () => {
    for (const p of ['99999999999999999', '1e400', String(Number.MAX_SAFE_INTEGER)]) {
      let err; try { rp({ period: p }); } catch (e) { err = e; }
      if (p === '1e400') { expect(err).toBeUndefined(); continue; } // parseInt('1e400') = 1
      expect(err).toBeInstanceOf(PeriodError);
      expect(err.code).toBe('BAD_PERIOD');
    }
  });
  test('нестроковые значения не роняют', () => {
    expect(() => rp({ period: ['7', '8'] })).not.toThrow();
    expect(() => rp({ from: ['2026-01-01'], to: {} })).not.toThrow();
    expect(() => rp(undefined)).not.toThrow();
  });
});
