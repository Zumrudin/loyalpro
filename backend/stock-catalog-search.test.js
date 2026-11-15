'use strict';

// Keep this store-level test isolated: it must never require a configured DB.
jest.mock('./db', () => ({
  db: { any: jest.fn(), query: jest.fn(), one: jest.fn(), oneOrNone: jest.fn() },
}));

const { db } = require('./db');
const { listGoods } = require('./services/stock/store');

beforeEach(() => {
  jest.clearAllMocks();
  db.any.mockResolvedValue([]);
});

test('catalog search stays tenant-scoped and matches title, article, or barcode with one bound filter', async () => {
  await listGoods(41, { search: 'AC-204', source: 'yclients', active: true });

  const [sql, params] = db.any.mock.calls[0];
  expect(params).toEqual([41, '%AC-204%', 'yclients', true]);
  expect(sql).toMatch(/WHERE salon_id = \$1/);
  expect(sql).toMatch(/\(title ILIKE \$2 OR article ILIKE \$2 OR barcode ILIKE \$2\)/);
  expect(sql).toContain('source = $3');
  expect(sql).toContain('stock_active = $4');
  expect(sql).toMatch(/\barticle\b/);
  expect(sql).toMatch(/\bcomment\b/);
});

test('catalog search escapes SQL wildcard characters without interpolating user input', async () => {
  const needle = "a%_\\' OR 1=1 --";
  await listGoods(9, { search: needle });

  const [sql, params] = db.any.mock.calls[0];
  expect(params).toEqual([9, "%a\\%\\_\\\\' OR 1=1 --%"]);
  expect(sql).not.toContain(needle);
  expect(sql).toMatch(/title ILIKE \$2 OR article ILIKE \$2 OR barcode ILIKE \$2/);
  expect(sql).toMatch(/ORDER BY title LIMIT 2000/);
});

test('unrecognised source and active values cannot widen a supplied salon query', async () => {
  await listGoods(77, { search: '', source: 'other-salon', active: 'true' });
  const [sql, params] = db.any.mock.calls[0];
  expect(params).toEqual([77]);
  expect(sql).toMatch(/WHERE salon_id = \$1 ORDER BY title LIMIT 2000/);
});
