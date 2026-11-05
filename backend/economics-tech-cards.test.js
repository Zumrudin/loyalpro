'use strict';
const { parseYcCard, normCost, suggestLinks, pickTechCard, SOURCE_RANK } = require('./services/economics/tech-cards');

describe('parseYcCard', () => {
  test('карта YClients → {yc_card_id, title, items}', () => {
    expect(parseYcCard({ id: '36069', title: 'Revi Silk 2 ml', technological_card_items: [
      { id: 1, good_id: 6858783, amount: '2', unit: 'мл', price: '1000', title: 'Revi' },
      { id: 2, good_id: 'bad', amount: 1 },
    ] })).toEqual({ yc_card_id: 36069, title: 'Revi Silk 2 ml', items: [{ good_id: 6858783, amount: 2, unit: 'мл', price_at_sync: 1000, title: 'Revi' }] });
    expect(parseYcCard({ id: 0 })).toBeNull();
    expect(parseYcCard(null)).toBeNull();
  });
  test('реальная форма 19.10.2026: название и единица — во вложенном good', () => {
    expect(parseYcCard({ id: 400343, title: 'Revi Silk 2 ml', technological_card_items: [
      { id: 2627378, technological_card_id: 400343, storage_id: 1334902, good_id: 20999356, amount: 1, price: 6075,
        good: { id: 20999356, title: 'РЕВИ Силк 1.2% стерильный 2 ml', unit: 'шт.', is_chain: false } },
    ] }).items).toEqual([{ good_id: 20999356, amount: 1, unit: 'шт.', price_at_sync: 6075, title: 'РЕВИ Силк 1.2% стерильный 2 ml' }]);
  });
});

describe('normCost', () => {
  const card = { items: [{ good_id: 1, amount: 2 }, { good_id: 2, amount: 0.5 }, { good_id: 3, amount: 1 }] };
  const priceFn = (goodId) => ({ 1: { price: 100, source: 'receipt' }, 2: { price: 40, source: 'catalog' }, 3: { price: 0, source: 'none' } })[goodId];
  test('Σ amount × price, товары без цены — в noPrice', () => {
    expect(normCost(card, priceFn, '2026-09-01')).toEqual({ cost: 220, noPrice: [3], items: 3 });
  });
  test('нет карты/пустая → null', () => {
    expect(normCost(null, priceFn, '2026-09-01')).toBeNull();
    expect(normCost({ items: [] }, priceFn, '2026-09-01')).toBeNull();
  });
});

describe('pickTechCard', () => {
  const links = [
    { service_yc_id: 10, staff_yc_id: null, source: 'learned', tech_card_id: 1 },
    { service_yc_id: 10, staff_yc_id: 5, source: 'learned', tech_card_id: 2 },
    { service_yc_id: 10, staff_yc_id: null, source: 'manual', tech_card_id: 3 },
    { service_yc_id: 11, staff_yc_id: 5, source: 'lookup', tech_card_id: 4 },
  ];
  test('manual главнее любого; иначе сотрудник-специфичная главнее общей', () => {
    expect(pickTechCard(links, 10, 5).tech_card_id).toBe(3);
    expect(pickTechCard(links.filter(l => l.source !== 'manual'), 10, 5).tech_card_id).toBe(2);
    expect(pickTechCard(links.filter(l => l.source !== 'manual'), 10, 6).tech_card_id).toBe(1);
    expect(pickTechCard(links, 11, 6)).toBeNull();      // привязка только к сотруднику 5
    expect(pickTechCard(links, 99, 5)).toBeNull();
  });
  test('lookup (YClients) главнее learned даже против сотрудник-специфичной learned', () => {
    const l = [
      { service_yc_id: 10, staff_yc_id: 5, source: 'learned', tech_card_id: 1 },
      { service_yc_id: 10, staff_yc_id: null, source: 'lookup', tech_card_id: 2 },
    ];
    expect(pickTechCard(l, 10, 5).tech_card_id).toBe(2);
    expect(SOURCE_RANK.manual).toBeLessThan(SOURCE_RANK.lookup);
    expect(SOURCE_RANK.lookup).toBeLessThan(SOURCE_RANK.learned);
  });
});

describe('suggestLinks', () => {
  test('совпадение по нормализованному названию, без подтверждения не применяется', () => {
    const cards = [{ id: 1, title: 'Revi Silk 2 ml' }, { id: 2, title: 'Чистка лица' }];
    const services = [{ id: 10, title: 'Revi Silk 2 ml (45 минут)' }, { id: 11, title: 'Массаж' }];
    expect(suggestLinks(cards, services)).toEqual([{ service_yc_id: 10, tech_card_id: 1, title: 'Revi Silk 2 ml' }]);
  });
});
