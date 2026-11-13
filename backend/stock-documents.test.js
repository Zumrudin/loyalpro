'use strict';
jest.mock('./services/stock/store');
jest.mock('./services/stock/ledger', () => ({ postDocument: jest.fn() }));
jest.mock('./services/yclients', () => ({ ycGet: jest.fn() }));
jest.mock('./db', () => ({ pool: { connect: jest.fn() }, db: {} }));
const store = require('./services/stock/store');
const ledger = require('./services/stock/ledger');
const { pool } = require('./db');
const { ycGet } = require('./services/yclients');
const model = require('./services/stock/model');
const docs = require('./services/stock/documents');
const now = new Date('2026-11-13T12:00:00Z');
const query = jest.fn(), release = jest.fn();
const body = () => ({ kind: 'receipt', storageId: 1, docDate: now, lines: [{ goodRowId: 10, qty: 2, unitType: 1, costPerUnit: 1.23 }] });
beforeEach(() => {
  jest.resetAllMocks();
  query.mockResolvedValue({ rows: [{ now }] });
  pool.connect.mockResolvedValue({ query, release });
  store.listStorages.mockResolvedValue([{ id: 1, is_active: true, for_service: true, for_sale: false }, { id: 2, is_active: false }]);
  store.listGoods.mockResolvedValue([{ id: 10, stock_active: true, unit_equals: 5, category_path: [{ id: 7 }], local_category: 'test' }]);
  store.storageById.mockResolvedValue({ id: 1, is_active: true, yclients_storage_id: 100 });
  store.goodById.mockResolvedValue({ id: 10, unit_equals: 5, yclients_good_id: 20 });
  store.insertDocument.mockResolvedValue({ id: 30 });
  store.documentById.mockResolvedValue({ id: 30, kind: 'inventory', origin: 'loyalpro', status: 'draft', storage_id: 1 });
  store.listMovementsByDocument.mockResolvedValue([]);
  store.listInventoryLines.mockResolvedValue([{ good_row_id: 10, expected_base: 1, counted: 3, counted_unit_type: 1, counted_base: 15, unit_equals: 5 }]);
  store.balances.mockResolvedValue([{ good_row_id: 10, storage_id: 1, qty_base: '2' }]);
});
test('create validates context, posts normalized lines and commits once', async () => {
  const result = await docs.create(1, 9, body());
  expect(result.id).toBe(30); expect(result.lines).toBeDefined();
  expect(store.insertDocument).toHaveBeenCalledWith(expect.any(Function), 1, expect.objectContaining({ kind: 'receipt', status: 'posted', origin: 'loyalpro', totalCost: 2.46, createdBy: 9 }));
  expect(ledger.postDocument).toHaveBeenCalledWith(expect.any(Function), 1, expect.objectContaining({ id: 30 }), [expect.objectContaining({ qtyBase: 10, cost: 2.46 })]);
  expect(query.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(1);
  expect(store.invalidateBalances).toHaveBeenCalledWith(1); expect(release).toHaveBeenCalled();
});
test.each([{ storageId: 2 }, { kind: 'sale' }, { lines: [{ goodRowId: 999, qty: 1, unitType: 1 }] }])('invalid document rejected: %j', async patch => {
  await expect(docs.create(1, 9, { ...body(), ...patch })).rejects.toMatchObject({ status: 400, code: 'validation', errors: expect.any(Array) });
  expect(store.insertDocument).not.toHaveBeenCalled();
});
test('rollback on ledger failure, always release', async () => {
  ledger.postDocument.mockRejectedValue(new Error('test'));
  await expect(docs.create(1, 9, body())).rejects.toThrow('test');
  expect(query).toHaveBeenCalledWith('ROLLBACK'); expect(query).not.toHaveBeenCalledWith('COMMIT'); expect(release).toHaveBeenCalled();
});
test.each([['yclients', 'posted', 'mirror'], ['loyalpro', 'cancelled', 'already_cancelled']])('cancel guards %s %s', async (origin, status, code) => {
  store.documentById.mockResolvedValue({ id: 30, kind: 'receipt', origin, status });
  await expect(docs.cancel(1, 9, 30, 'ошибка')).rejects.toMatchObject({ status: 409, code });
  expect(store.softDeleteDocumentMovements).not.toHaveBeenCalled();
});
test.each(['', ' ', null, 'x'.repeat(501)])('cancel requires reason', async reason => {
  await expect(docs.cancel(1, 9, 30, reason)).rejects.toMatchObject({ status: 400 });
});
test('cancel preserves rows with soft deletion in transaction', async () => {
  store.documentById.mockResolvedValue({ id: 30, kind: 'receipt', origin: 'loyalpro', status: 'posted' });
  await docs.cancel(1, 9, 30, 'ошибка');
  expect(store.cancelDocument).toHaveBeenCalledWith(expect.any(Function), 1, 30, 'ошибка');
  expect(store.softDeleteDocumentMovements).toHaveBeenCalledWith(expect.any(Function), 1, 30);
  expect(query).toHaveBeenCalledWith('COMMIT');
});
test.each([{ categoryPathPrefix: 7 }, { localCategory: 'test' }])('inventory creation filters category %j', async filter => {
  store.balances.mockResolvedValue([{ good_row_id: 10, qty_base: '2' }, { good_row_id: 11, qty_base: '9' }]);
  await docs.inventoryCreate(1, 9, { storageId: 1, ...filter });
  expect(store.insertDocument).toHaveBeenCalledWith(expect.any(Function), 1, expect.objectContaining({ kind: 'inventory', status: 'draft' }));
  expect(store.insertInventoryLines).toHaveBeenCalledWith(expect.any(Function), 1, 30, [expect.objectContaining({ goodRowId: 10, expectedBase: 2, storageId: 1 })]);
});
test('inventory count uses unit conversion', async () => {
  await docs.inventorySetLines(1, 30, [{ goodRowId: 10, counted: 3, countedUnitType: 1 }]);
  expect(store.updateInventoryLine).toHaveBeenCalledWith(expect.any(Function), 1, 30, expect.objectContaining({ goodRowId: 10, countedBase: 15, diffBase: 14 }));
});
test('foreign inventory line rejected before writes', async () => {
  await expect(docs.inventorySetLines(1, 30, [{ goodRowId: 99, counted: 1, countedUnitType: 1 }])).rejects.toMatchObject({ status: 400 });
  expect(store.updateInventoryLine).not.toHaveBeenCalled();
});
test.each(['posted', 'cancelled'])('inventory must be draft (%s)', async status => {
  store.documentById.mockResolvedValue({ kind: 'inventory', status });
  await expect(docs.inventorySetLines(1, 30, [])).rejects.toMatchObject({ status: 409 });
  await expect(docs.inventoryPost(1, 9, 30)).rejects.toMatchObject({ status: 409 });
});
test('inventory post refreshes balance and skips uncounted and zero differences', async () => {
  store.listInventoryLines.mockResolvedValue([
    { good_row_id: 10, counted: 3, counted_base: 3, counted_unit_type: 2 },
    { good_row_id: 11, counted: null, counted_base: null },
    { good_row_id: 12, counted: 0, counted_base: 0, counted_unit_type: 2 }]);
  await docs.inventoryPost(1, 9, 30);
  expect(store.balances).toHaveBeenCalledWith(1, expect.objectContaining({ storageId: 1 }), expect.any(Function));
  expect(store.insertMovement).toHaveBeenCalledTimes(1);
  expect(store.insertMovement).toHaveBeenCalledWith(expect.any(Function), 1, expect.objectContaining({ source: 'inventory', qtyBase: 1, occurredAt: now }));
  expect(store.postInventory).toHaveBeenCalled();
});
test('opening rejects local good without network', async () => {
  store.goodById.mockResolvedValue({ id: 10, yclients_good_id: null });
  await expect(docs.openingReset({ id: 1 }, 9, { goodRowId: 10, storageId: 1, note: 'test' })).rejects.toMatchObject({ status: 409, code: 'local_good' });
  expect(ycGet).not.toHaveBeenCalled();
});
test('opening does one GET; informational movement cannot double count snapshot', async () => {
  ycGet.mockResolvedValue({ id: 20, unit_equals: 5, actual_amounts: [{ storage_id: 100, amount: 3 }] });
  await docs.openingReset({ id: 1, yclients_company_id: 77 }, 9, { goodRowId: 10, storageId: 1, note: 'test' });
  expect(ycGet).toHaveBeenCalledTimes(1); expect(ycGet).toHaveBeenCalledWith(expect.any(Object), '/goods/77/20');
  const opening = store.insertOpening.mock.calls[0][2];
  const movement = store.insertMovement.mock.calls[0][2];
  expect(opening).toMatchObject({ qtyBase: 15, ycQtyBase: 15, note: 'test', createdBy: 9 });
  expect(movement).toMatchObject({ source: 'opening', qtyBase: 15, occurredAt: opening.takenAt });
  expect(model.balanceCountsRow({ ...movement, recordedAt: new Date(now.getTime() + 1000) }, { takenAt: opening.takenAt })).toBe(false);
  expect(jest.requireActual('./services/stock/store').BALANCES_SQL).toContain("mv.source IN ('webhook','loyalpro','inventory')");
});

test('missing document is 404 (db.one may return null)', async () => {
  store.documentById.mockResolvedValue(null);
  await expect(docs.cancel(2, 9, 30, 'test')).rejects.toMatchObject({ status: 404 });
  expect(store.documentById).toHaveBeenCalledWith(2, 30, expect.any(Function));
});
test.each([-1, null, '', 'NaN'])('invalid count %s cannot silently become zero', async counted => {
  await expect(docs.inventorySetLines(1, 30, [{ goodRowId: 10, counted, countedUnitType: 1 }])).rejects.toMatchObject({ status: 400 });
});
test('supplier must belong to the same salon', async () => {
  store.listSuppliers.mockResolvedValue([]);
  await expect(docs.create(1, 9, { ...body(), supplierId: 55 })).rejects.toMatchObject({ status: 400 });
  expect(store.listSuppliers).toHaveBeenCalledWith(1);
});
test('external errors are sanitized and no opening is written', async () => {
  ycGet.mockRejectedValue(new Error('upstream-private-error'));
  await expect(docs.openingReset({ id: 1, yclients_company_id: 77 }, 9, { goodRowId: 10, storageId: 1, note: 'test' })).rejects.toMatchObject({ message: 'unavailable', status: 502 });
  expect(store.insertOpening).not.toHaveBeenCalled();
});

describe('store SQL', () => {
  const actual = jest.requireActual('./services/stock/store');
  test('cancellation scopes both updates and never changes recorded_at or deletes rows', async () => {
    await actual.cancelDocument(query, 2, 30, 'test');
    await actual.softDeleteDocumentMovements(query, 2, 30);
    const sql = query.mock.calls.map(c => c[0]).join('\n');
    expect(sql).toContain('cancelled_at = NOW()'); expect(sql).toContain('deleted_at = NOW()');
    expect(sql).not.toMatch(/DELETE FROM|recorded_at\s*=/);
    for (const [statement, params] of query.mock.calls) {
      expect(statement).toContain('salon_id = $1'); expect(params.slice(0, 2)).toEqual([2, 30]);
    }
  });
  test('transactional balances bypass cached loader', async () => {
    query.mockResolvedValue({ rows: [{ good_row_id: 10, storage_id: 1, qty_base: '9' }] });
    expect(await actual.balances(2, { storageId: 1 }, query)).toHaveLength(1);
    expect(query).toHaveBeenCalledWith(actual.BALANCES_SQL, [2]);
  });
  test('mutating document reads lock tenant-scoped row', async () => {
    await actual.documentById(2, 30, query);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE salon_id = $1 AND id = $2 FOR UPDATE'), [2, 30]);
  });
});

describe('HTTP routes', () => {
  let server, base, jwt;
  beforeAll(async () => {
    const express = require('express');
    jwt = require('jsonwebtoken');
    const app = express(); app.use(express.json()); app.use('/api/stock', require('./routes/stock'));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}/api/stock`;
  });
  afterAll(() => new Promise(resolve => server.close(resolve)));
  const request = async (path, role = 'admin', method = 'GET', body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (role) headers.Authorization = `Bearer ${jwt.sign({ salonId: 1, userId: 9, role }, require('./config').JWT_SECRET)}`;
    const r = await fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  test('auth and owner-only reset enforced', async () => {
    expect((await request('/balances', null)).status).toBe(401);
    expect((await request('/balances', 'specialist')).status).toBe(403);
    expect((await request('/openings/reset', 'admin', 'POST', {})).status).toBe(403);
    expect(ycGet).not.toHaveBeenCalled();
  });
  test('invalid ids rejected', async () => {
    for (const path of ['/documents/1.5', '/inventories/0', '/balances?storage=-1']) expect((await request(path)).status).toBe(400);
  });
  test('balance flags only accept 1, category matches nested id', async () => {
    expect((await request('/balances?only_negative=true')).body).toHaveLength(1);
    expect((await request('/balances?only_negative=1')).body).toHaveLength(0);
    expect((await request('/balances?category=7')).body[0]).toMatchObject({ unit_equals: 5, category_path: [{ id: 7 }] });
    expect((await request('/balances?category=8')).body).toHaveLength(0);
  });
  test('validation errors preserve status and details', async () => {
    expect(await request('/documents', 'admin', 'POST', {})).toMatchObject({ status: 400, body: { code: 'validation', errors: expect.any(Array) } });
  });
  test('unexpected errors map to unavailable', async () => {
    store.listGoods.mockRejectedValue(new Error('test-error'));
    expect(await request('/balances')).toEqual({ status: 502, body: { error: 'unavailable' } });
  });
});

test.each(['opening', 'sale'])('generic cancellation cannot partially undo %s', async kind => {
  store.documentById.mockResolvedValue({ id: 30, kind, origin: 'loyalpro', status: 'posted' });
  await expect(docs.cancel(1, 9, 30, 'test')).rejects.toMatchObject({ status: 409, code: 'kind' });
  expect(store.cancelDocument).not.toHaveBeenCalled();
  expect(store.softDeleteDocumentMovements).not.toHaveBeenCalled();
});
