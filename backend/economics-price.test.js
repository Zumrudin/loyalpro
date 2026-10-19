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
  const receipts = [
    R('2026-02-01T10:00:00.000Z', 10, 1000),
    R('2026-05-01T10:00:00.000Z', 10, 1200),
    R('2026-09-01T10:00:00.000Z', 10, 1500),
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
    const rs = [R(new Date('2026-05-01T21:30:00.000Z'), 1, 100)];
    expect(unitPriceAsOf({ receipts: rs, date: '2026-05-01' }).source).toBe('none');
    expect(unitPriceAsOf({ receipts: rs, date: '2026-05-02' }).price).toBe(100);
  });
});

test('mskDay', () => {
  expect(mskDay('2026-05-01T21:30:00.000Z')).toBe('2026-05-02');
  expect(mskDay('2026-05-01')).toBe('2026-05-01');
  expect(mskDay(null)).toBeNull();
});
