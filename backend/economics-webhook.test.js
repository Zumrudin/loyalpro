'use strict';
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
