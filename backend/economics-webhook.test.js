'use strict';
jest.mock('./db', () => ({ db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn(), any: jest.fn() }, pool: {} }));
jest.mock('./services/economics/sync', () => ({ runNightly: jest.fn(), isRunning: jest.fn() }));
jest.mock('./services/economics/report', () => ({ invalidate: jest.fn() }));
jest.mock('./services/economics/store', () => ({ upsertGoodsTransaction: jest.fn(), refreshLastReceipt: jest.fn() }));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));
const store = require('./services/economics/store');
const { handleGoodsEvent } = require('./services/economics');

const SALON = { id: 1 };
const base = (type_id, extra = {}) => ({
  resource: type_id === 3 ? 'goods_operations_receipt' : 'goods_operations_consumable', status: 'create',
  data: { id: 5, type_id, amount: type_id === 3 ? 2 : -1, cost: 100, good: { id: 9, title: 'G' }, record_id: 0, ...extra },
});

beforeEach(() => { jest.clearAllMocks(); store.upsertGoodsTransaction.mockResolvedValue({}); store.refreshLastReceipt.mockResolvedValue({}); });

test('списание: апсерт source=webhook, last receipt не трогаем', async () => {
  const r = await handleGoodsEvent(SALON, base(2));
  expect(r).toEqual({ handled: true, status: 'create' });
  expect(store.upsertGoodsTransaction).toHaveBeenCalledWith(1, expect.objectContaining({ yclients_txn_id: 5 }), { status: 'create', source: 'webhook' });
  expect(store.refreshLastReceipt).not.toHaveBeenCalled();
});
test('приход: после апсерта пересчитывается последняя закупка товара', async () => {
  await handleGoodsEvent(SALON, base(3));
  expect(store.refreshLastReceipt).toHaveBeenCalledWith(1, 9);
});
test('чужой ресурс → handled:false без обращений к БД', async () => {
  expect(await handleGoodsEvent(SALON, { resource: 'record', status: 'create', data: { id: 1 } })).toEqual({ handled: false });
  expect(store.upsertGoodsTransaction).not.toHaveBeenCalled();
});
test('сбой пересчёта закупки не роняет обработчик', async () => {
  store.refreshLastReceipt.mockRejectedValue(new Error('db down'));
  await expect(handleGoodsEvent(SALON, base(3))).resolves.toEqual({ handled: true, status: 'create' });
  expect(mockLog.warn).toHaveBeenCalled();
});

test('runNightlyAll: по активным салонам с токенами, сброс кэша отчёта, WARN после трёх провалов подряд', async () => {
  const { db } = require('./db'); const sync = require('./services/economics/sync'); const report = require('./services/economics/report');
  db.any.mockResolvedValue([{ id: 1, yclients_company_id: '668791' }]);
  sync.runNightly.mockResolvedValue({ ok: false, steps: {}, errors: { catalog: '429' } });
  const { runNightlyAll } = require('./services/economics');
  await runNightlyAll(); await runNightlyAll(); await runNightlyAll();
  expect(report.invalidate).toHaveBeenCalledWith(1);
  expect(mockLog.warn).toHaveBeenCalledWith(expect.stringMatching(/синк не проходит 3 ночи/));
});
