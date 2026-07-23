'use strict';
const { hasAnyPrice } = require('./services/yclients');

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
