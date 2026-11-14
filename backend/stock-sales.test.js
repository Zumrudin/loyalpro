'use strict';
jest.mock('./db', () => ({ pool: { connect: jest.fn() }, db: { query: jest.fn(), any: jest.fn(), oneOrNone: jest.fn() } }));
jest.mock('./services/stock/store');
jest.mock('./services/stock/ledger', () => ({ postDocument: jest.fn() }));
jest.mock('./services/yclients', () => ({ ycSearchClientIdByPhone: jest.fn() }));
jest.mock('./services/finance-ops', () => ({ recordStockSalePayment: jest.fn(), cancelByStockDocument: jest.fn() }));
const { pool, db } = require('./db');
const store = require('./services/stock/store');
const ledger = require('./services/stock/ledger');
const fin = require('./services/finance-ops');
const yc = require('./services/yclients');
const sales = require('./services/stock/sales');
const documents = require('./services/stock/documents');
const client = { id: 7, yclients_client_id: 70 };
const body = (extra = {}) => ({ clientId: 7, storageId: 2, docDate: '2026-11-13T22:00:00Z',
  lines: [{ goodRowId: 3, qty: 1, unitType: 1, costPerUnit: 1 }], payments: [{ method: 'card', amount: 1 }], ...extra });
let q, release;
beforeEach(() => {
  jest.resetAllMocks();
  q = jest.fn(async () => ({ rows: [client] })); release = jest.fn();
  pool.connect.mockResolvedValue({ query: q, release });
  // Клиент резолвится ДО транзакции через db.query (поиск в YClients не должен держать соединение пула).
  db.query.mockImplementation(async () => ({ rows: [client] }));
  store.listStorages.mockResolvedValue([{ id: 2, is_active: true, for_sale: true }]);
  store.listGoods.mockResolvedValue([{ id: 3, stock_active: true, unit_equals: 1 }]);
  store.insertDocument.mockImplementation(async (_, sid, d) => ({ id: 10, salon_id: sid, kind: d.kind, status: d.status, origin: 'loyalpro' }));
  fin.recordStockSalePayment.mockImplementation(async (_, p) => ({ method: p.method, amount: p.amount, status: 'confirmed' }));
  store.documentById.mockResolvedValue({ id: 10, kind: 'sale', origin: 'loyalpro', status: 'posted' });
  store.listMovementsByDocument.mockResolvedValue([]);
});
test('sale: document, ledger and split payments share transaction, no YClients', async () => {
  const d = await sales.create(1, 4, body({ payments: [{ method: 'cash', amount: .3 }, { method: 'card', amount: .7 }] }));
  expect(d).toMatchObject({ id: 10, status: 'posted', lines: [{ qtyBase: -1 }], payments: [{ amount: .3 }, { amount: .7 }] });
  const tx = store.insertDocument.mock.calls[0][0];
  expect(store.insertDocument).toHaveBeenCalledWith(tx, 1, expect.objectContaining({ kind: 'sale', clientId: 7, ycClientId: 70, totalCost: 1, status: 'posted' }));
  expect(ledger.postDocument.mock.calls[0][0]).toBe(tx);
  for (const [fn, p] of fin.recordStockSalePayment.mock.calls) {
    expect(fn).toBe(tx); expect(p).toMatchObject({ salonId: 1, stockDocumentId: 10, clientId: 7, ycClientId: 70, userId: 4 });
    expect(p.opId).toMatch(/^[a-f0-9-]{36}$/);
  }
  expect(q.mock.calls[0][0]).toBe('BEGIN'); expect(q.mock.calls.at(-1)[0]).toBe('COMMIT');
  expect(yc.ycSearchClientIdByPhone).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledTimes(1);
});
test.each(['bonus', 'other'])('rejects %s before transaction', async method => {
  await expect(sales.create(1, 4, body({ payments: [{ method, amount: 1 }] }))).rejects.toMatchObject({ status: 400 });
  expect(pool.connect).not.toHaveBeenCalled();
});
test('gift with zero total has no payments', async () => {
  const d = await sales.create(1, 4, body({ gift: true, payments: [], lines: [{ goodRowId: 3, qty: 1, unitType: 1, costPerUnit: 0 }] }));
  expect(d.payments).toEqual([]); expect(fin.recordStockSalePayment).not.toHaveBeenCalled();
});
test('payment failure rolls document and movements back', async () => {
  fin.recordStockSalePayment.mockRejectedValue(new Error('test failure'));
  await expect(sales.create(1, 4, body())).rejects.toThrow('test failure');
  expect(q.mock.calls.at(-1)[0]).toBe('ROLLBACK'); expect(release).toHaveBeenCalledTimes(1);
});
test('phone: exact forms by index first, tenant-scoped last ten digits as fallback', async () => {
  const exactMiss = jest.fn(async (sql) => ({ rows: /phone = ANY/.test(sql) ? [] : [client] }));
  await expect(sales.resolveClient(1, { phone: '8 (999) 000-00-01' }, exactMiss)).resolves.toEqual(client);
  expect(exactMiss.mock.calls[0]).toEqual([expect.stringMatching(/phone = ANY\(\$2::text\[\]\)/), [1, ['+79990000001', '79990000001', '89990000001', '9990000001']]]);
  expect(exactMiss).toHaveBeenCalledWith(expect.stringMatching(/RIGHT\(regexp_replace/), [1, '9990000001']);
  await expect(sales.resolveClient(1, { phone: '79990000001' }, q)).resolves.toEqual(client);
  expect(q).toHaveBeenCalledTimes(1); // точная форма нашлась — суффиксный запрос не нужен
  expect(yc.ycSearchClientIdByPhone).not.toHaveBeenCalled();
});
test('client lookup happens before the transaction (no pool connection held during YClients search)', async () => {
  await sales.create(1, 4, body());
  expect(db.query).toHaveBeenCalledWith(expect.stringMatching(/salon_id=\$1 AND id=\$2/), [1, 7]);
  expect(q.mock.calls[0][0]).toBe('BEGIN');
  expect(q.mock.calls.some(([sql]) => /FROM clients/.test(String(sql)))).toBe(false);
});
test('missing id never searches another salon or YClients', async () => {
  q.mockResolvedValue({ rows: [] });
  await expect(sales.resolveClient(1, { clientId: 99 }, q)).rejects.toMatchObject({ status: 404, code: 'client_not_found' });
  expect(q).toHaveBeenCalledWith(expect.stringMatching(/salon_id=\$1 AND id=\$2/), [1, 99]);
  expect(yc.ycSearchClientIdByPhone).not.toHaveBeenCalled();
});
test('cancel sale cancels finance in same transaction; opening stays forbidden', async () => {
  await documents.cancel(1, 4, 10, 'test');
  expect(fin.cancelByStockDocument).toHaveBeenCalledWith(store.cancelDocument.mock.calls[0][0], 1, 10);
  store.documentById.mockResolvedValue({ kind: 'opening', origin: 'loyalpro', status: 'posted' });
  await expect(documents.cancel(1, 4, 11, 'test')).rejects.toMatchObject({ status: 409 });
});
test('finance writer persists stock link and Moscow day, conflict never overwrites amount/kind', async () => {
  const real = jest.requireActual('./services/finance-ops');
  const sqlQ = jest.fn(async () => ({ rows: [{ id: 4, inserted: true }] }));
  await real.recordStockSalePayment(sqlQ, { salonId: 1, stockDocumentId: 10, opId: '00000000-0000-4000-8000-000000000001', method: 'card', amount: 1, clientId: 7, ycClientId: 70, occurredAt: '2026-11-13T22:00:00Z', userId: 4 });
  const [sql, args] = sqlQ.mock.calls[0];
  expect(sql).toMatch(/ON CONFLICT \(salon_id,\s*step_op_id\)/);
  expect(sql.split('DO UPDATE SET')[1]).not.toMatch(/(?:amount|kind|method)\s*=/);
  const cols = sql.match(/finance_operations\s*\(([^)]+)\)/)[1].split(',').map(x => x.trim());
  expect(Object.fromEntries(cols.map((c, i) => [c, args[i]]))).toMatchObject({ stock_document_id: 10, kind: 'goods_sale', method: 'card', amount: 1, status: 'confirmed', origin: 'loyalpro', op_date: '2026-11-14', title: 'Продажа товаров #10' });
  await real.cancelByStockDocument(sqlQ, 1, 10);
  expect(sqlQ.mock.calls.at(-1)).toEqual([expect.stringMatching(/status\s*=\s*'cancelled'.*WHERE salon_id\s*=\s*\$1 AND stock_document_id\s*=\s*\$2/s), [1, 10]]);
  expect(db.query).not.toHaveBeenCalled();
});
test('ambiguous phone and invalid inputs do not create documents', async () => {
  db.query.mockResolvedValue({ rows: [client, { id: 8 }] });
  await expect(sales.create(1, 4, body({ clientId: undefined, phone: '79990000001' }))).rejects.toMatchObject({ status: 409, code: 'ambiguous_client' });
  expect(store.insertDocument).not.toHaveBeenCalled();
  await expect(sales.create(1, 4, body({ payments: [{ method: 'cash', amount: .99 }] }))).rejects.toMatchObject({ status: 400 });
  await expect(sales.create(1, 4, body({ gift: true }))).rejects.toMatchObject({ status: 400 });
});
test('cancellation finance failure rolls back', async () => {
  fin.cancelByStockDocument.mockRejectedValue(new Error('test cancel failure'));
  await expect(documents.cancel(1, 4, 10, 'test')).rejects.toThrow('test cancel failure');
  expect(q.mock.calls.at(-1)[0]).toBe('ROLLBACK');
});
test('purchases query scopes joins and includes cancelled lines, both origins, limit 200', async () => {
  const real = jest.requireActual('./services/stock/store');
  db.any.mockResolvedValue([]);
  await real.listPurchasesByClient(2, 7);
  expect(db.any).toHaveBeenCalledWith(real.PURCHASES_SQL, [2, 7]);
  expect(real.PURCHASES_SQL).toMatch(/d.salon_id=\$1 AND d.kind='sale'/);
  expect(real.PURCHASES_SQL).toMatch(/f.salon_id=d.salon_id AND f.stock_document_id=d.id/);
  expect(real.PURCHASES_SQL).toMatch(/g.salon_id=m.salon_id/);
  expect(real.PURCHASES_SQL).not.toMatch(/deleted_at IS NULL|d.origin=/);
  expect(real.PURCHASES_SQL).toMatch(/ORDER BY d.doc_date DESC, d.id DESC LIMIT 200/);
});
test('finance writer rejects bonuses and sub-kopeck amounts without SQL', async () => {
  const real = jest.requireActual('./services/finance-ops');
  for (const p of [{ method: 'bonus', amount: 1 }, { method: 'card', amount: .001 }]) {
    await expect(real.recordStockSalePayment(q, p)).rejects.toMatchObject({ status: 400 });
  }
  expect(q).not.toHaveBeenCalled();
  expect(real.upsertSql('step_op_id', true)).toMatch(/finance_operations.status='cancelled' THEN 'cancelled'/);
});
describe('sale API', () => {
  let server, base;
  beforeAll(async () => {
    const express = require('express');
    const app = express(); app.use(express.json()); app.use('/api/stock', require('./routes/stock'));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}/api/stock`;
  });
  afterAll(() => new Promise(resolve => server.close(resolve)));
  async function request(path, role, payload) {
    const headers = { 'Content-Type': 'application/json' };
    if (role) headers.Authorization = 'Bearer ' + require('jsonwebtoken').sign({ salonId: 1, userId: 4, role }, require('./config').JWT_SECRET);
    const r = await fetch(base + path, { headers, method: payload ? 'POST' : 'GET', ...(payload ? { body: JSON.stringify(payload) } : {}) });
    return { status: r.status, data: await r.json() };
  }
  test('auth, roles, envelope and server-side tenant scope', async () => {
    expect((await request('/sales', null, body())).status).toBe(401);
    expect((await request('/sales', 'specialist', body())).status).toBe(403);
    expect((await request('/sales', 'admin', body({ salonId: 99 }))).data).toMatchObject({ document: { id: 10, salon_id: 1, status: 'posted' } });
    expect((await request('/sales', 'owner', body())).status).toBe(201);
    expect((await request('/sales', 'admin', body({ payments: [{ method: 'bonus', amount: 1 }] }))).status).toBe(400);
  });
  test('purchase list validates id and uses authenticated salon', async () => {
    store.listPurchasesByClient.mockResolvedValue([{ id: 10 }]);
    expect((await request('/clients/7/purchases', 'admin')).data).toEqual([{ id: 10 }]);
    expect(store.listPurchasesByClient).toHaveBeenCalledWith(1, 7);
    expect((await request('/clients/0/purchases', 'admin')).status).toBe(400);
    expect((await request('/clients/7/purchases', 'specialist')).status).toBe(403);
  });
});
describe('missing local client fallback', () => {
  const salon = { id: 1, yclients_company_id: 123 };
  beforeEach(() => {
    q.mockImplementation(async sql => ({ rows: /FROM salons/.test(sql) ? [salon] : /INSERT INTO clients/.test(sql) ? [client] : [] }));
  });
  test('one search then minimal canonical client insert, using supplied transaction', async () => {
    yc.ycSearchClientIdByPhone.mockResolvedValue(70);
    await expect(sales.resolveClient(1, { phone: '8 (999) 000-00-01' }, q)).resolves.toEqual(client);
    expect(yc.ycSearchClientIdByPhone).toHaveBeenCalledTimes(1);
    expect(yc.ycSearchClientIdByPhone).toHaveBeenCalledWith(salon, '79990000001');
    expect(q).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO clients/), [1, 70, '79990000001']);
    const sql = q.mock.calls.find(([s]) => /INSERT INTO clients/.test(s))[0];
    expect(sql).toMatch(/ON CONFLICT \(salon_id, yclients_client_id\)/);
    expect(sql).not.toMatch(/bonus|loyalty/);
    expect(db.query).not.toHaveBeenCalled();
  });
  test('not found returns client_not_found without insertion', async () => {
    yc.ycSearchClientIdByPhone.mockResolvedValue(null);
    await expect(sales.resolveClient(1, { phone: '79990000001' }, q)).rejects.toMatchObject({ status: 404, code: 'client_not_found' });
    expect(yc.ycSearchClientIdByPhone).toHaveBeenCalledTimes(1);
    expect(q.mock.calls.some(([s]) => /INSERT/.test(s))).toBe(false);
  });
  test('search failure is sanitized and never inserts a client', async () => {
    yc.ycSearchClientIdByPhone.mockRejectedValue(new Error('private upstream details'));
    await expect(sales.resolveClient(1, { phone: '79990000001' }, q)).rejects.toMatchObject({ status: 502, code: 'client_search_unavailable', message: 'Поиск клиента временно недоступен.' });
    expect(q.mock.calls.some(([s]) => /INSERT/.test(s))).toBe(false);
  });
  test('missing salon does not call YClients', async () => {
    q.mockResolvedValue({ rows: [] });
    await expect(sales.resolveClient(1, { phone: '79990000001' }, q)).rejects.toMatchObject({ status: 404 });
    expect(yc.ycSearchClientIdByPhone).not.toHaveBeenCalled();
  });
});
