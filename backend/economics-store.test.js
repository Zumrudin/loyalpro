'use strict';
jest.mock('./db', () => ({ db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn(), any: jest.fn() }, pool: {} }));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));
const { db } = require('./db');
const store = require('./services/economics/store');

const ROW = {
  yclients_txn_id: 10, document_id: 20, type_id: 3, type_title: 'Приход товара', good_id: 7, good_title: 'Шприц',
  storage_id: 1, unit_title: 'уп.', operation_unit_type: 1, amount: 3, cost_per_unit: 4060, cost: 12180, discount: 0,
  record_id: null, service_id: null, service_title: null, master_id: null, supplier_title: null,
  create_date: '2026-10-18T12:10:00.000Z', last_change_date: null, raw: { id: 10 },
};

beforeEach(() => { jest.clearAllMocks(); db.query.mockResolvedValue({ rows: [], rowCount: 1 }); db.any.mockResolvedValue([]); db.oneOrNone.mockResolvedValue(null); });

describe('upsertGoodsTransaction', () => {
  test('create/update: INSERT … ON CONFLICT, deleted_at NULL, source из опций', async () => {
    await store.upsertGoodsTransaction(1, ROW, { status: 'update', source: 'webhook' });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO goods_transactions/);
    expect(sql).toMatch(/ON CONFLICT \(salon_id, yclients_txn_id\) DO UPDATE/);
    expect(params[0]).toBe(1);
    expect(params[1]).toBe(10);
    expect(params[params.length - 2]).toBe('webhook');
    expect(params[params.length - 1]).toBeNull();      // deleted_at
  });
  test('delete: deleted_at = NOW() (строка не удаляется)', async () => {
    await store.upsertGoodsTransaction(1, ROW, { status: 'delete', source: 'webhook' });
    const [sql] = db.query.mock.calls[0];
    expect(sql).toMatch(/deleted_at\s*=\s*COALESCE\(\$\d+::timestamptz, NOW\(\)\)/);
  });
});

describe('refreshLastReceipt', () => {
  test('последнее поступление ≤ сегодня → цена за единицу списания с учётом unit_equals', async () => {
    db.oneOrNone
      .mockResolvedValueOnce({ unit_equals: '10' })                                             // каталог
      .mockResolvedValueOnce({ create_date: '2026-10-18T12:10:00.000Z', amount: '3', cost: '12180', operation_unit_type: 1 }); // приход
    await store.refreshLastReceipt(1, 7);
    const upd = db.query.mock.calls.find(c => /UPDATE yclients_goods_catalog/.test(c[0]));
    expect(upd[1]).toEqual([1, 7, 406, '2026-10-18T12:10:00.000Z']); // 12180/3/10
  });
  test('приходов нет → цена и дата сбрасываются в NULL', async () => {
    db.oneOrNone.mockResolvedValueOnce({ unit_equals: null }).mockResolvedValueOnce(null);
    await store.refreshLastReceipt(1, 7);
    const upd = db.query.mock.calls.find(c => /UPDATE yclients_goods_catalog/.test(c[0]));
    expect(upd[1]).toEqual([1, 7, null, null]);
  });
});
