'use strict';
const m = require('./services/stock/model');

describe('единицы', () => {
  test('toBase: ед. продажи × unit_equals, знак по виду', () => {
    expect(m.toBase({ kind: 'receipt', qty: 2, unitType: 1, unitEquals: 500 })).toBe(1000);
    expect(m.toBase({ kind: 'writeoff', qty: 2, unitType: 1, unitEquals: 500 })).toBe(-1000);
    expect(m.toBase({ kind: 'sale', qty: 1, unitType: 1, unitEquals: 1 })).toBe(-1);
  });
  test('toBase: ед. списания — через writeoffQty (готча ед. продажи при типе 2)', () => {
    expect(m.toBase({ kind: 'consumable', qty: 0.1667, unitType: 2, unitEquals: 120, costPerUnit: 16.35, cost: 327 })).toBeCloseTo(-20, 1);
    expect(m.toBase({ kind: 'consumable', qty: 5, unitType: 2, unitEquals: 500, costPerUnit: 8.5, cost: 42.5 })).toBe(-5);
  });
  test('toBaseInfo без unit_equals при типе 1 — qty как есть и флаг', () => {
    expect(m.toBaseInfo({ kind: 'receipt', qty: 3, unitType: 1, unitEquals: null })).toEqual({ qtyBase: 3, unitUnknown: true });
  });
  test('fromBase раскладывает на ед. продажи и остаток', () => {
    expect(m.fromBase(1150, 500)).toEqual({ saleUnits: 2, remainderBase: 150 });
    expect(m.fromBase(-4059, 500)).toEqual({ saleUnits: -9, remainderBase: 441 });
    expect(m.fromBase(7, null)).toEqual({ saleUnits: 7, remainderBase: 0 });
  });
});

describe('validateDocument', () => {
  const ctx = { storages: [{ id: 1, forService: true, forSale: false }, { id: 2, forService: false, forSale: true }], goods: new Map([[10, { stockActive: true, unitEquals: 1 }]]) };
  test('приход: ок, cost со скидкой', () => {
    const r = m.validateDocument({ kind: 'receipt', storageId: 1, docDate: '2026-11-13T10:00:00+03:00', lines: [{ goodRowId: 10, qty: 2, unitType: 1, costPerUnit: 100, discount: 10 }] }, ctx);
    expect(r.ok).toBe(true); expect(r.normalized.lines[0].cost).toBe(180); expect(r.normalized.totalCost).toBe(180);
  });
  test('перемещение на тот же склад — ошибка', () => {
    const r = m.validateDocument({ kind: 'move', storageId: 1, toStorageId: 1, docDate: '2026-11-13', lines: [{ goodRowId: 10, qty: 1, unitType: 1 }] }, ctx);
    expect(r.ok).toBe(false); expect(r.errors[0]).toMatch(/разные склады/);
  });
  test('пустые строки, qty ≤ 0, неизвестный товар, скидка вне 0–100', () => {
    expect(m.validateDocument({ kind: 'writeoff', storageId: 1, docDate: '2026-11-13', lines: [] }, ctx).ok).toBe(false);
    expect(m.validateDocument({ kind: 'writeoff', storageId: 1, docDate: '2026-11-13', lines: [{ goodRowId: 10, qty: 0, unitType: 1 }] }, ctx).ok).toBe(false);
    expect(m.validateDocument({ kind: 'writeoff', storageId: 1, docDate: '2026-11-13', lines: [{ goodRowId: 99, qty: 1, unitType: 1 }] }, ctx).ok).toBe(false);
    expect(m.validateDocument({ kind: 'sale', storageId: 2, docDate: '2026-11-13', clientId: 5, lines: [{ goodRowId: 10, qty: 1, unitType: 1, costPerUnit: 100, discount: 120 }] }, ctx).ok).toBe(false);
  });
  test('склад не того назначения — предупреждение, не ошибка', () => {
    const r = m.validateDocument({ kind: 'sale', storageId: 1, docDate: '2026-11-13', clientId: 5, lines: [{ goodRowId: 10, qty: 1, unitType: 1, costPerUnit: 100, discount: 0 }] }, ctx);
    expect(r.ok).toBe(true); expect(r.warnings[0]).toMatch(/не для продаж/);
  });
  test('продажа с нулевым итогом без gift — ошибка', () => {
    expect(m.validateDocument({ kind: 'sale', storageId: 2, docDate: '2026-11-13', clientId: 5, lines: [{ goodRowId: 10, qty: 1, unitType: 1, costPerUnit: 0, discount: 0 }] }, ctx).ok).toBe(false);
    expect(m.validateDocument({ kind: 'sale', storageId: 2, docDate: '2026-11-13', clientId: 5, gift: true, lines: [{ goodRowId: 10, qty: 1, unitType: 1, costPerUnit: 0, discount: 0 }] }, ctx).ok).toBe(true);
  });
});

describe('validateSalePayments', () => {
  test('сумма оплат = итогу, только cash|card', () => {
    expect(m.validateSalePayments([{ method: 'card', amount: 700 }, { method: 'cash', amount: 300 }], 1000)).toEqual({ ok: true, errors: [] });
    expect(m.validateSalePayments([{ method: 'card', amount: 700 }], 1000).errors[0]).toMatch(/не совпадает/);
    expect(m.validateSalePayments([{ method: 'bonus', amount: 600 }], 600).ok).toBe(false); // бонусы только на услуги (решение владельца 13.11)
    expect(m.validateSalePayments([{ method: 'crypto', amount: 10 }], 10).ok).toBe(false);
  });
  test('подарок — оплат нет', () => expect(m.validateSalePayments([], 0, { gift: true }).ok).toBe(true));
});

describe('дельта расходников и инвентаризация', () => {
  test('consumableDelta — только ненулевые строки, в знаке движения', () => {
    expect(m.consumableDelta([{ goodRowId: 1, qtyBase: 3 }, { goodRowId: 2, qtyBase: 1 }], [{ goodRowId: 1, qtyBase: -2 }, { goodRowId: 3, qtyBase: -1 }]))
      .toEqual([{ goodRowId: 1, qtyBase: -1 }, { goodRowId: 2, qtyBase: -1 }, { goodRowId: 3, qtyBase: 1 }]);
  });
  test('inventoryDiff: подсчёт в ед. продажи → базовые', () => {
    expect(m.inventoryDiff({ expectedBase: 1000, counted: 3, countedUnitType: 1, unitEquals: 500 })).toEqual({ countedBase: 1500, diffBase: 500 });
    expect(m.inventoryDiff({ expectedBase: 1000, counted: 900, countedUnitType: 2, unitEquals: 500 })).toEqual({ countedBase: 900, diffBase: -100 });
  });
});

describe('правило счёта остатка (§6.3)', () => {
  const opening = { takenAt: new Date('2026-11-14T00:00:00Z') };
  test('зеркальная строка, впервые увиденная после снимка (вебхук/сверка) — считается', () => {
    expect(m.balanceCountsRow({ occurredAt: '2026-11-15T00:00:00Z', recordedAt: '2026-11-15T00:00:00Z', source: 'reconcile' }, opening)).toBe(true);
    expect(m.balanceCountsRow({ occurredAt: '2026-11-01T00:00:00Z', recordedAt: '2026-11-15T00:00:00Z', source: 'webhook' }, opening)).toBe(true);
  });
  test('зеркальная строка, лежавшая у нас до снимка (в т.ч. с будущей датой визита) — нет: она уже в показании YClients', () =>
    expect(m.balanceCountsRow({ occurredAt: '2026-12-01T00:00:00Z', recordedAt: '2026-11-10T00:00:00Z', source: 'backfill' }, opening)).toBe(false));
  test('догон старых строк после снимка — нет', () => expect(m.balanceCountsRow({ occurredAt: '2026-11-01T00:00:00Z', recordedAt: '2026-11-15T00:00:00Z', source: 'backfill' }, opening)).toBe(false));
  test('локальные движения считаются всегда, даже если старше снимка (их нет в YClients)', () => {
    expect(m.balanceCountsRow({ occurredAt: '2026-11-01T00:00:00Z', recordedAt: '2026-11-01T00:00:00Z', source: 'loyalpro' }, opening)).toBe(true);
    expect(m.balanceCountsRow({ occurredAt: '2026-11-01T00:00:00Z', recordedAt: '2026-11-01T00:00:00Z', source: 'inventory' }, opening)).toBe(true);
  });
  test('строка opening при снимке не считается', () => expect(m.balanceCountsRow({ occurredAt: '2026-11-14T00:00:00Z', recordedAt: '2026-11-14T00:00:00Z', source: 'opening' }, opening)).toBe(false));
  test('без входящего остатка — всё считается', () => expect(m.balanceCountsRow({ occurredAt: '2026-11-01T00:00:00Z', recordedAt: '2026-11-01T00:00:00Z', source: 'backfill' }, null)).toBe(true));
});
