'use strict';
const { aggregateRevenueByCategory, computeAvgCheck } = require('./services/staff-dashboard');

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
