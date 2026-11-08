'use strict';

jest.mock('./db', () => ({ db: { any: jest.fn() } }));
const { db } = require('./db');
const products = require('./services/agent/tools/search-retail-products');
const offers = require('./services/agent/tools/search-abonement-offers');
const registry = require('./services/agent/tools');
const { buildSystemPrompt } = require('./services/agent/system-prompt');

beforeEach(() => db.any.mockReset());

test('товары: запрос tenant-scoped, наружу выходит статус, но не количество', async () => {
  db.any.mockResolvedValue([{ yclients_good_id: '7', title: 'HELО4', category_title: 'Уход',
    retail_price: '4200.00', stock: [{ storage_id: 1, amount: 1 }],
    agent_low_stock_threshold: '2', stock_is_fresh: true, updated_at: '2026-11-05T10:00:00Z' }]);
  const out = await products.run(42, { query: 'HELO' });
  expect(db.any.mock.calls[0][1][0]).toBe(42);
  expect(db.any.mock.calls[0][0]).toMatch(/salon_id=\$1/);
  expect(out.products[0]).toMatchObject({ id: 7, price: 4200, availability: 'low_stock' });
  expect(out.products[0]).not.toHaveProperty('stock');
});

test('товары: устаревший снимок не выдаётся за актуальное наличие', async () => {
  db.any.mockResolvedValue([{ yclients_good_id: '8', title: 'Крем', retail_price: '3000',
    stock: [{ amount: 20 }], stock_is_fresh: false, updated_at: '2026-11-01T10:00:00Z' }]);
  const out = await products.run(42, { query: 'крем' });
  expect(out.products[0].availability).toBe('unknown');
});

test.each([
  [[], 'out_of_stock'],
  [[{ amount: 3 }], 'in_stock'],
])('товары: наличие %#', (stock, expected) => {
  expect(products.availability(stock, 1)).toBe(expected);
});

test('абонементы: действующая скидка рассчитывается кодом', async () => {
  db.any.mockResolvedValue([{ id: '3', title: 'RSL 6 процедур', procedures_count: 6,
    price: '29000.00', promo_label: 'День рождения', promo_percent: '10',
    promo_starts_on: '2026-11-01', promo_ends_on: '2026-11-30' }]);
  const out = await offers.run(9, { query: 'RSL' }, { now: '2026-11-05T12:00:00Z' });
  expect(db.any.mock.calls[0][1][0]).toBe(9);
  expect(out.offers[0]).toMatchObject({ base_price: 29000, final_price: 26100,
    promo: { percent: 10 } });
});

test('абонементы: просроченная акция не применяется', () => {
  expect(offers.priceFor({ price: 29000, promo_percent: 10, promo_ends_on: '2026-10-31' }, '2026-11-05'))
    .toEqual({ base_price: 29000, final_price: 29000 });
});

test('реестр и промпт содержат оба commerce-инструмента и запрет доверять скидке пациента', () => {
  expect(registry.schemas.map(x => x.name)).toEqual(expect.arrayContaining([
    'search_retail_products', 'search_abonement_offers',
  ]));
  const prompt = buildSystemPrompt({});
  expect(prompt).toContain('search_retail_products');
  expect(prompt).toContain('search_abonement_offers');
  expect(prompt).toMatch(/скидку из слов пациента сама не применяй/i);
});
