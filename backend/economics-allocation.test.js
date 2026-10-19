'use strict';
const A = require('./services/economics/allocation');

describe('splitByWeights', () => {
  test('делит пропорционально, сумма сходится до копейки (остаток — последней)', () => {
    expect(A.splitByWeights(100, [1, 1, 1])).toEqual([33.33, 33.33, 33.34]);
    expect(A.splitByWeights(1000, [22500, 5000])).toEqual([818.18, 181.82]);
  });
  test('нулевые веса → поровну; пусто → []', () => {
    expect(A.splitByWeights(10, [0, 0])).toEqual([5, 5]);
    expect(A.splitByWeights(10, [])).toEqual([]);
  });
});

describe('splitMinutes', () => {
  test('seance_length (сек) делится по длительностям услуг из каталога', () => {
    expect(A.splitMinutes(3600, [2700, 900])).toEqual([45, 15]);
  });
  test('нет длительностей → поровну; одна услуга → всё ей', () => {
    expect(A.splitMinutes(3600, [null, null])).toEqual([30, 30]);
    expect(A.splitMinutes(3600, [0])).toEqual([60]);
  });
});

describe('monthShares', () => {
  test('доли дней месяцев в периоде', () => {
    expect(A.monthShares('2026-09-16', '2026-10-15')).toEqual([
      { month: '2026-09', days: 15, share: 0.5 },
      { month: '2026-10', days: 15, share: 15 / 31 },
    ]);
    expect(A.monthShares('2026-02-01', '2026-02-28')).toEqual([{ month: '2026-02', days: 28, share: 1 }]);
  });
});

describe('periodFixedCosts', () => {
  const rows = [
    { id: 1, category: 'rent', amount_month: 300000, month_from: '2026-01-01', month_to: null },
    { id: 2, category: 'admin', amount_month: 120000, month_from: '2026-10-01', month_to: '2026-10-01' },
    { id: 3, category: 'rent', amount_month: 999, month_from: '2027-01-01', month_to: null },
  ];
  test('Σ по месяцам amount × доля дней; строки вне своих месяцев не считаются', () => {
    const r = A.periodFixedCosts(rows, '2026-09-16', '2026-10-15');
    expect(r.total).toBeCloseTo(300000 * 0.5 + 300000 * 15 / 31 + 120000 * 15 / 31, 2);
    expect(r.byCategory.rent).toBeCloseTo(300000 * (0.5 + 15 / 31), 2);
    expect(r.byCategory.admin).toBeCloseTo(120000 * 15 / 31, 2);
  });
  test('пусто → 0', () => { expect(A.periodFixedCosts([], '2026-09-01', '2026-09-30').total).toBe(0); });
});

describe('equipment', () => {
  const eq = { purchase_price: 5050000, residual_pct: 10, useful_life_months: 60, maintenance_monthly: 20000, purchase_date: '2025-01-15', is_active: true };
  test('equipmentMonthly: амортизация + ТО', () => {
    expect(A.equipmentMonthly(eq)).toEqual({ depreciation: 75750, maintenance: 20000, total: 95750 });
  });
  test('equipmentPeriodCost: по долям месяцев; до покупки — 0; после срока службы — только ТО', () => {
    expect(A.equipmentPeriodCost(eq, '2026-09-01', '2026-09-30')).toBe(95750);
    expect(A.equipmentPeriodCost(eq, '2024-12-01', '2024-12-31')).toBe(0);
    expect(A.equipmentPeriodCost(eq, '2030-02-01', '2030-02-28')).toBe(20000);
    expect(A.equipmentPeriodCost({ ...eq, is_active: false }, '2026-09-01', '2026-09-30')).toBe(0);
  });
});

describe('rate/allocate', () => {
  const rows = [{ minutes: 60, service_yc_id: 1 }, { minutes: 30, service_yc_id: 2 }, { minutes: 30, service_yc_id: 1 }];
  test('minutes: ставка за минуту; visits: поровну', () => {
    expect(A.rate('minutes', 1200, rows)).toBe(10);
    expect(A.rate('visits', 1200, rows)).toBe(400);
    expect(A.rate('minutes', 1200, [])).toBe(0);
  });
  test('allocate: по драйверу, с фильтром услуг (аппарат)', () => {
    expect(A.allocate(rows, 'minutes', 1200)).toEqual([600, 300, 300]);
    expect(A.allocate(rows, 'visits', 1200)).toEqual([400, 400, 400]);
    expect(A.allocate(rows, 'minutes', 900, new Set([1]))).toEqual([600, 0, 300]);
    expect(A.allocate(rows, 'visits', 900, new Set([2]))).toEqual([0, 900, 0]);
  });
});
