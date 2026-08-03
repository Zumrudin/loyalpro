'use strict';
const { hasAnyPrice, staffPricesFromServices } = require('./services/yclients');

describe('hasAnyPrice — услуга имеет цену (для фильтра каталога)', () => {
  test('стартовая цена «от X»: price_min>0, price_max=0 → true (раньше терялась)', () => {
    expect(hasAnyPrice({ price_min: 5000, price_max: 0 })).toBe(true);
  });
  test('обычный диапазон: price_max>0 → true', () => {
    expect(hasAnyPrice({ price_min: 0, price_max: 3000 })).toBe(true);
  });
  test('фикс. цена: price_min==price_max>0 → true', () => {
    expect(hasAnyPrice({ price_min: 1430, price_max: 1430 })).toBe(true);
  });
  test('нет цены нигде: min=max=0 → false (мусор отсекается)', () => {
    expect(hasAnyPrice({ price_min: 0, price_max: 0 })).toBe(false);
  });
  test('нечисловые/отсутствующие поля → false', () => {
    expect(hasAnyPrice({})).toBe(false);
    expect(hasAnyPrice({ price_min: null, price_max: undefined })).toBe(false);
  });
});

// Персональные цены мастеров живут ТОЛЬКО в management-ответе
// /company/{cid}/services/ (поле staff[].price). Booking-эндпоинт
// /services/{cid}?staff_id= отдаёт базовую цену услуги ВСЕМ мастерам —
// именно поэтому Мила называла 19 000 ₽ за «5в1» у главного врача Пери,
// хотя у неё эта услуга стоит 23 000 ₽ (инцидент 2026-08-01).
describe('staffPricesFromServices — персональные цены мастеров из management-каталога', () => {
  test('услуга→мастер→цена: в карту попадают только реальные переопределения', () => {
    const m = staffPricesFromServices([
      {
        id: 15394018, price_min: 19000, price_max: 19000,
        staff: [
          { id: 1910274, price: { min: 23000, max: 23000 } },   // главный врач — своя цена
          { id: 5708379, price: null },                          // обычный врач — по базовой
        ],
      },
    ]);
    expect(m.get('15394018').get('1910274')).toEqual({ price_min: 23000, price_max: 23000 });
    expect(m.get('15394018').has('5708379')).toBe(false);
  });
  test('price.max не заполнен → верхняя граница равна цене мастера, а не базе услуги', () => {
    // Иначе цена мастера смешивалась бы с чужой базовой: «20000-18000».
    const m = staffPricesFromServices([
      { id: 7, price_min: 18000, price_max: 0, staff: [{ id: 55, price: { min: 20000, max: null } }] },
    ]);
    expect(m.get('7').get('55')).toEqual({ price_min: 20000, price_max: 20000 });
  });
  test('нулевая/битая персональная цена игнорируется — останется базовая цена услуги', () => {
    const m = staffPricesFromServices([
      { id: 7, staff: [{ id: 55, price: { min: 0, max: 0 } }, { id: 56, price: {} }, { id: 57 }] },
    ]);
    expect(m.has('7')).toBe(false);
  });
  test('не массив / услуга без мастеров → пустая карта, без падения', () => {
    expect(staffPricesFromServices(null).size).toBe(0);
    expect(staffPricesFromServices([{ id: 7 }]).size).toBe(0);
  });
});
