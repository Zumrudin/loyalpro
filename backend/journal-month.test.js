'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret' }));
jest.mock('./db', () => ({ db: { any: jest.fn() } }));
const { db } = require('./db');
const month = require('./services/journal/month');
beforeEach(() => jest.clearAllMocks());
test('monthRange validates YYYY-MM and knows the month length', () => {
  expect(month.monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29', days: 29 });
  expect(month.monthRange('2026-11')).toEqual({ from: '2026-11-01', to: '2026-11-30', days: 30 });
  for (const bad of ['2026-13', '2026-1', '26-11', undefined, '2026-11-01']) expect(() => month.monthRange(bad)).toThrow();
});
test('density: 0 without records, by share of workingStaff × 8, 3 when nobody works', () => {
  expect(month.density(0, 4)).toBe(0);
  expect(month.density(5, 4)).toBe(1);
  expect(month.density(12, 4)).toBe(2);
  expect(month.density(25, 4)).toBe(3);
  expect(month.density(2, 0)).toBe(3);
});
test('monthDays fills every day of the month', () => {
  const days = month.monthDays('2026-11', [{ date: '2026-11-02', n: 12 }], [{ date: '2026-11-02', n: 4 }, { date: '2026-11-03', n: 2 }]);
  expect(days).toHaveLength(30);
  expect(days[1]).toEqual({ date: '2026-11-02', records: 12, workingStaff: 4, density: 2 });
  expect(days[2]).toEqual({ date: '2026-11-03', records: 0, workingStaff: 2, density: 0 });
});
test('month reads the mirror and schedules of THIS salon only, without deleted records', async () => {
  db.any.mockResolvedValueOnce([{ date: '2026-11-02', n: 3 }]).mockResolvedValueOnce([{ date: '2026-11-02', n: 1 }]);
  const out = await month.month(7, '2026-11');
  expect(out.month).toBe('2026-11');
  expect(out.days[1]).toMatchObject({ records: 3, workingStaff: 1, density: 2 });
  const [recSql, recArgs] = db.any.mock.calls[0];
  expect(recSql).toMatch(/FROM records/); expect(recSql).toMatch(/salon_id=\$1/); expect(recSql).toMatch(/'deleted'/);
  expect(recArgs).toEqual([7, '2026-11-01', '2026-11-30']);
  const [staffSql, staffArgs] = db.any.mock.calls[1];
  expect(staffSql).toMatch(/FROM journal_staff_schedule/); expect(staffSql).toMatch(/is_working/);
  expect(staffArgs).toEqual([7, '2026-11-01', '2026-11-30']);
});
