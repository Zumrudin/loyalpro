'use strict';
jest.mock('./services/stock/catalog-sync', () => ({ syncStorages: jest.fn(), syncCategories: jest.fn() }));
jest.mock('./services/stock/store', () => ({
  pendingMirrorRows: jest.fn(),
  removeIngestPending: jest.fn(),
  pendingCount: jest.fn(),
  goodByYcId: jest.fn(),
  ensureStorage: jest.fn(),
  upsertMirrorDocument: jest.fn(),
  upsertMovement: jest.fn(),
  markMovementDeleted: jest.fn(),
}));
const catalog = require('./services/stock/catalog-sync'),
  store = require('./services/stock/store'),
  ledger = require('./services/stock/ledger'),
  stock = require('./services/stock');
beforeEach(() => {
  jest.clearAllMocks();
  store.pendingMirrorRows.mockResolvedValue([]);
  store.pendingCount.mockResolvedValue(0);
  catalog.syncStorages.mockResolvedValue({ count: 2 });
  catalog.syncCategories.mockResolvedValue({ skipped: 'throttled' });
});
test('nightly continues after catalog failure and reports errors', async () => {
  catalog.syncStorages.mockRejectedValue(new Error('synthetic'));
  const r = await stock.nightly({ id: 7 });
  expect(catalog.syncCategories).toHaveBeenCalled();
  expect(store.pendingMirrorRows).toHaveBeenCalledWith(7);
  expect(r.errors.storages).toBeDefined();
});
test('drain uses authoritative mirror and removes only successful pending rows', async () => {
  store.pendingMirrorRows.mockResolvedValue([
    { yclients_txn_id: 9, deleted_at: '2026-11-14', source: 'webhook' },
    {
      yclients_txn_id: 10,
      type_id: 3,
      good_id: 4,
      storage_id: 5,
      source: 'backfill',
      amount: 2,
      operation_unit_type: 1,
    },
  ]);
  store.goodByYcId.mockResolvedValue({ id: 4, unit_equals: 1 });
  store.ensureStorage.mockResolvedValue({ id: 5 });
  store.upsertMirrorDocument.mockResolvedValue({ id: 6 });
  await ledger.drainIngestPending(7);
  expect(store.markMovementDeleted).toHaveBeenCalledWith(7, 9, '2026-11-14');
  expect(store.upsertMovement).toHaveBeenCalledWith(7, expect.objectContaining({ source: 'backfill' }));
  expect(store.removeIngestPending.mock.calls).toEqual([
    [7, 9],
    [7, 10],
  ]);
});
