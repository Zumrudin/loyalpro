'use strict';
const { aggregateRevenueByCategory, computeAvgCheck, prevMonthRanges } = require('./services/staff-dashboard');

describe('aggregateRevenueByCategory', () => {
  test('заполняет три категории + total', () => {
    const rows = [
      { category: 'services',    total: '50000' },
      { category: 'goods',       total: '5000'  },
      { category: 'abonement',   total: '10000' },
      { category: 'certificate', total: '999'   },   // игнорируется
    ];
    expect(aggregateRevenueByCategory(rows)).toEqual({
      services: 50000, goods: 5000, abonement: 10000, total: 65000,
    });
  });
  test('недостающая категория — 0', () => {
    expect(aggregateRevenueByCategory([{ category: 'services', total: '1000' }])).toEqual({
      services: 1000, goods: 0, abonement: 0, total: 1000,
    });
  });
  test('пусто / не массив', () => {
    expect(aggregateRevenueByCategory([])).toEqual({ services: 0, goods: 0, abonement: 0, total: 0 });
    expect(aggregateRevenueByCategory(null)).toEqual({ services: 0, goods: 0, abonement: 0, total: 0 });
  });
});

describe('computeAvgCheck', () => {
  test.each([
    [10, 5000, 500],
    [0, 1000, 0],     // деление на ноль
    [1, 0, 0],
  ])('count=%i sum=%i → %i', (c, s, exp) => {
    expect(computeAvgCheck(c, s)).toBe(exp);
  });
  test('округление до целого', () => {
    expect(computeAvgCheck(3, 1000)).toBe(333);
  });
});

describe('prevMonthRanges', () => {
  test('середина месяца → отрезок 1-е…то же число прошлого', () => {
    expect(prevMonthRanges('2026-06-11')).toEqual({
      monthFrom: '2026-05-01', monthTo: '2026-05-31',
      windowFrom: '2026-05-01', windowTo: '2026-05-11',
    });
  });
  test('31-е число, в прошлом месяце 28 дней → кламп к концу февраля', () => {
    expect(prevMonthRanges('2026-03-31')).toEqual({
      monthFrom: '2026-02-01', monthTo: '2026-02-28',
      windowFrom: '2026-02-01', windowTo: '2026-02-28',
    });
  });
  test('январь → прошлый месяц = декабрь прошлого года', () => {
    expect(prevMonthRanges('2026-01-05')).toEqual({
      monthFrom: '2025-12-01', monthTo: '2025-12-31',
      windowFrom: '2025-12-01', windowTo: '2025-12-05',
    });
  });
  test('1-е число → отрезок из одного дня', () => {
    expect(prevMonthRanges('2026-06-01')).toEqual({
      monthFrom: '2026-05-01', monthTo: '2026-05-31',
      windowFrom: '2026-05-01', windowTo: '2026-05-01',
    });
  });
});
