'use strict';
const { unitPriceAsOf, receiptUnitPrice, mskDay } = require('./services/economics/price');

const R = (date, amount, cost, out = 1) => ({ create_date: date, amount, cost, operation_unit_type: out });

describe('receiptUnitPrice', () => {
  test('приход в единице продажи делится на unit_equals; скидка уже в cost', () => {
    expect(receiptUnitPrice(R('2026-03-21', 10, 110485), 1)).toBe(11048.5);
    expect(receiptUnitPrice(R('2026-03-21', 3, 12180), 10)).toBe(406);
  });
  test('приход в единице списания (operation_unit_type 2) не делится', () => {
    expect(receiptUnitPrice(R('2026-03-21', 100, 50, 2), 10)).toBe(0.5);
  });
  test('нулевое количество/битая цена → null', () => {
    expect(receiptUnitPrice(R('2026-03-21', 0, 100), 1)).toBeNull();
    expect(receiptUnitPrice(R('2026-03-21', 1, 'x'), 1)).toBeNull();
    expect(receiptUnitPrice(null, 1)).toBeNull();
  });
});

describe('unitPriceAsOf', () => {
  // В единице списания (2): цена за единицу не зависит от unit_equals каталога.
  const receipts = [
    R('2026-02-01T10:00:00.000Z', 10, 1000, 2),
    R('2026-05-01T10:00:00.000Z', 10, 1200, 2),
    R('2026-09-01T10:00:00.000Z', 10, 1500, 2),
  ];
  test('берётся последнее поступление с датой ≤ визита', () => {
    expect(unitPriceAsOf({ receipts, date: '2026-06-15' })).toEqual({ price: 120, source: 'receipt', at: '2026-05-01T10:00:00.000Z' });
    expect(unitPriceAsOf({ receipts, date: '2026-10-01' }).price).toBe(150);
    expect(unitPriceAsOf({ receipts, date: '2026-05-01' }).price).toBe(120);
  });
  test('поступлений до даты нет → ручная цена → unit_actual_cost → 0 с no_price', () => {
    expect(unitPriceAsOf({ receipts, date: '2026-01-01', override: { unit_price: '77' }, catalogRow: { unit_actual_cost: 50 } }))
      .toEqual({ price: 77, source: 'override' });
    expect(unitPriceAsOf({ receipts: [], date: '2026-01-01', catalogRow: { unit_actual_cost: '50' } }))
      .toEqual({ price: 50, source: 'catalog' });
    expect(unitPriceAsOf({ receipts: [], date: '2026-01-01' })).toEqual({ price: 0, source: 'none' });
  });
  test('приход с нулевой ценой пропускается, unit_equals каталога применяется', () => {
    const rs = [R('2026-01-01', 5, 0), R('2025-12-01', 2, 200)];
    expect(unitPriceAsOf({ receipts: rs, date: '2026-02-01', catalogRow: { unit_equals: 10 } }).price).toBe(10);
  });
  test('даты сравниваются по московскому дню (Date-объекты из pg)', () => {
    const rs = [R(new Date('2026-05-01T21:30:00.000Z'), 1, 100, 2)];
    expect(unitPriceAsOf({ receipts: rs, date: '2026-05-01' }).source).toBe('none');
    expect(unitPriceAsOf({ receipts: rs, date: '2026-05-02' }).price).toBe(100);
  });
});

test('mskDay', () => {
  expect(mskDay('2026-05-01T21:30:00.000Z')).toBe('2026-05-02');
  expect(mskDay('2026-05-01')).toBe('2026-05-01');
  expect(mskDay(null)).toBeNull();
});

describe('ревью: приход в единицах продажи без unit_equals', () => {
  test('operation_unit_type 1 и unit_equals нет/0 → null (цена флакона ≠ цена мл)', () => {
    expect(receiptUnitPrice(R('2026-03-21', 1, 26000, 1), null)).toBeNull();
    expect(receiptUnitPrice(R('2026-03-21', 1, 26000, 1), 0)).toBeNull();
    expect(receiptUnitPrice(R('2026-03-21', 1, 26000, 1), undefined)).toBeNull();
  });
  test('unitPriceAsOf проваливается к ручной цене / себестоимости каталога', () => {
    const rs = [R('2026-03-21', 1, 26000, 1)];
    expect(unitPriceAsOf({ receipts: rs, date: '2026-04-01', override: { unit_price: 2600 } })).toEqual({ price: 2600, source: 'override' });
    expect(unitPriceAsOf({ receipts: rs, date: '2026-04-01', catalogRow: { unit_equals: null, unit_actual_cost: 2500 } })).toEqual({ price: 2500, source: 'catalog' });
  });
});

// Количество списания (дев, сентябрь 2026): часть списаний YClients хранит amount в
// ЕДИНИЦАХ ПРОДАЖИ, хотя operation_unit_type=2, а cost_per_unit — цена единицы списания.
describe('writeoffQty', () => {
  const { writeoffQty } = require('./services/economics/price');
  test('ватные диски: 0.1667 упаковки × 120 = 20 шт (20 × 16.35 = 327)', () => {
    expect(writeoffQty({ amount: -0.1667, cost_per_unit: 16.35, cost: 327 }, 120)).toBeCloseTo(20, 1);
  });
  test('одноразовая простынь: 0.01 рулона × 100 = 1 шт', () => {
    expect(writeoffQty({ amount: -0.01, cost_per_unit: 6.79, cost: 6.79 }, 100)).toBeCloseTo(1, 6);
  });
  test('гель для УЗИ 5 кг: 0.012 × 5000 = 60 мл', () => {
    expect(writeoffQty({ amount: -0.012, cost_per_unit: 0.15, cost: 9.07 }, 5000)).toBeCloseTo(60, 6);
  });
  test('нормальная строка (уже в единицах списания) не трогается', () => {
    expect(writeoffQty({ amount: -1, cost_per_unit: 6.79, cost: 6.79 }, 100)).toBe(1);
  });
  test('нет unit_equals / cost / cost_per_unit — как есть', () => {
    expect(writeoffQty({ amount: -0.01, cost_per_unit: 6.79, cost: 6.79 }, null)).toBe(0.01);
    expect(writeoffQty({ amount: -0.01, cost_per_unit: 6.79, cost: 6.79 }, 1)).toBe(0.01);
    expect(writeoffQty({ amount: -0.01, cost: 6.79 }, 100)).toBe(0.01);
    expect(writeoffQty({ amount: -0.01, cost_per_unit: 6.79, cost: 0 }, 100)).toBe(0.01);
  });
  test('ни одна гипотеза не сходится с cost — как есть', () => {
    expect(writeoffQty({ amount: -0.5, cost_per_unit: 10, cost: 77 }, 100)).toBe(0.5);
  });
  test('пустой/битый amount → 0', () => {
    expect(writeoffQty({ amount: null }, 100)).toBe(0);
    expect(writeoffQty(null, 100)).toBe(0);
  });
});
