'use strict';
jest.mock('./db', () => ({ db: { any: jest.fn() }, pool: {} }));
const { enrichOperations } = require('./services/stock/operation-values');

test('values preserve movement order and null/zero distinction, one bounded tenant query', async () => {
  const query = jest.fn().mockResolvedValue([
    { id: '2', balance_after: '0.0000', cost_basis: '0.00', cost_basis_source: 'stored' },
    { id: '1', balance_after: null, cost_basis: null },
  ]);
  const rows = await enrichOperations(7, [{ id: 1 }, { id: 2 }], query);
  expect(rows).toEqual([
    { id: 1, balance_after: null, cost_basis: null, cost_basis_source: null },
    { id: 2, balance_after: '0.0000', cost_basis: '0.00', cost_basis_source: 'stored' },
  ]);
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0][1]).toEqual([7, [1, 2]]);
});

test('empty page performs no calculation query', async () => {
  const query = jest.fn();
  expect(await enrichOperations(7, [], query)).toEqual([]);
  expect(query).not.toHaveBeenCalled();
});
