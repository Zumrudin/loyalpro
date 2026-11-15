'use strict';
jest.mock('./db', () => ({ pool: { connect: jest.fn() } }));
jest.mock('./services/stock/store', () => ({
  invalidateBalances: jest.fn(), insertDocument: jest.fn(), cancelDocument: jest.fn(), softDeleteDocumentMovements: jest.fn(),
}));
jest.mock('./services/stock/ledger', () => ({ postDocument: jest.fn() }));
const { pool } = require('./db');
const store = require('./services/stock/store');
const ledger = require('./services/stock/ledger');
const svc = require('./services/stock/appointment-goods');

describe('appointment goods codes', () => {
  let q, release;
  beforeEach(() => {
    release = jest.fn();
    q = jest.fn(async (sql, args) => {
      if (/SELECT \* FROM appointment_goods_codes/.test(sql)) return { rows: [] };
      if (/SELECT \* FROM yclients_goods_catalog/.test(sql)) {
        return { rows: args[0] === 1 && args[1] === 9 ? [{ id: 9, stock_active: true, loyalty_certificate_type_id: 77 }] : [] };
      }
      if (/INSERT INTO appointment_goods_codes/.test(sql)) return { rows: [{ id: args[0], code: args[6], kind: args[5], good_row_id: args[4], status: 'reserved' }] };
      return { rows: [] };
    });
    pool.connect.mockResolvedValue({ query: q, release });
  });
  test('reservation derives type from tenant catalog and persists a normalized globally unique code', async () => {
    const out = await svc.reserveCode(1, 4, 9, '10000000-0000-4000-8000-000000000001');
    expect(out).toMatchObject({ kind: 'certificate', goodRowId: 9, status: 'reserved' });
    const insert = q.mock.calls.find(([sql]) => /INSERT INTO appointment_goods_codes/.test(sql));
    expect(insert[0]).toMatch(/ON CONFLICT\(normalized_code\) DO NOTHING/);
    expect(insert[1][7]).toBe(svc.normalizeCode(insert[1][6]));
    expect(q.mock.calls[0][0]).toBe('BEGIN');
    expect(q.mock.calls.at(-1)[0]).toBe('COMMIT');
  });
  test('foreign or ordinary good fails without creating a reservation', async () => {
    await expect(svc.reserveCode(2, 4, 9, '20000000-0000-4000-8000-000000000002'))
      .rejects.toMatchObject({ status: 400, code: 'validation' });
    expect(q.mock.calls.some(([sql]) => /INSERT INTO appointment_goods_codes/.test(sql))).toBe(false);
    expect(q.mock.calls.at(-1)[0]).toBe('ROLLBACK');
  });
  test('catalog classification rejects ambiguous loyalty type', () => {
    expect(svc.kindOf({ loyalty_certificate_type_id: 1 })).toBe('certificate');
    expect(svc.kindOf({ loyalty_abonement_type_id: 2 })).toBe('abonement');
    const ddl = require('fs').readFileSync(require('path').join(__dirname, 'migrations.js'), 'utf8');
    expect(ddl).toMatch(/UNIQUE\(normalized_code\)/);
    expect(ddl).toMatch(/appointment_goods_sets_local_uq[\s\S]*\(salon_id, local_outbox_id\)/);
    expect(ddl).toMatch(/appointment_goods_sets_yc_uq[\s\S]*\(salon_id, yclients_record_id\)/);
  });
});

describe('appointment goods save', () => {
  const requestId = '30000000-0000-4000-8000-000000000003';
  let q, release, replay, storageRows;
  const payload = { version: 0, requestId, clientId: 7, lines: [
    { lineId: '40000000-0000-4000-8000-000000000004', goodRowId: 10, storageId: 2, qty: 1, unitType: 1, price: 100, total: 100 },
    { lineId: '50000000-0000-4000-8000-000000000005', goodRowId: 11, storageId: 3, qty: 2, unitType: 1, price: 50, total: 100 },
  ] };
  beforeEach(() => {
    jest.clearAllMocks(); replay = null;
    release = jest.fn(); storageRows = [{ id: 2, is_active: true, for_sale: true }, { id: 3, is_active: true, for_sale: true }];
    let nextDoc = 20;
    store.insertDocument.mockImplementation(async (_q, salonId, d) => ({ id: nextDoc++, salon_id: salonId, ...d }));
    q = jest.fn(async (sql) => {
      if (/FROM clients WHERE salon_id=\$1 AND id=\$2/.test(sql)) return { rows: [{ id: 7, yclients_client_id: 70 }] };
      if (/FROM records/.test(sql)) return { rows: [{ client_id: 7, yclients_client_id: 70, status: 'confirmed' }] };
      if (/FROM journal_outbox/.test(sql)) return { rows: [] };
      if (/FROM appointment_goods_requests/.test(sql)) return { rows: replay ? [replay] : [] };
      if (/FROM appointment_goods_sets/.test(sql)) return { rows: replay ? [{ id: 5, salon_id: 1, client_id: 7, yclients_record_id: 90, version: 1 }] : [] };
      if (/INSERT INTO appointment_goods_sets/.test(sql)) return { rows: [{ id: 5, salon_id: 1, client_id: 7, yclients_record_id: 90, version: 0 }] };
      if (/SELECT d.id FROM stock_documents/.test(sql)) return { rows: [] };
      if (/FROM yclients_goods_catalog\s+WHERE/.test(sql)) return { rows: [
        { id: 10, stock_active: true, unit_equals: 1 }, { id: 11, stock_active: true, unit_equals: 1 },
      ] };
      if (/FROM stock_storages/.test(sql)) return { rows: storageRows };
      if (/SELECT NOW\(\) AS now/.test(sql)) return { rows: [{ now: new Date('2026-11-15T12:00:00Z') }] };
      if (/UPDATE appointment_goods_sets/.test(sql)) return { rows: [{ id: 5, salon_id: 1, client_id: 7, yclients_record_id: 90, version: 1 }] };
      return { rows: [] };
    });
    pool.connect.mockResolvedValue({ query: q, release });
  });
  test('one explicit save posts one atomic document per storage and replay does not repost stock', async () => {
    const first = await svc.save(1, 4, 90, payload);
    expect(first.version).toBe(1);
    expect(store.insertDocument).toHaveBeenCalledTimes(2);
    expect(ledger.postDocument).toHaveBeenCalledTimes(2);
    expect(new Set(store.insertDocument.mock.calls.map(c => c[2].storageId))).toEqual(new Set([2, 3]));
    expect(q.mock.calls[0][0]).toBe('BEGIN'); expect(q.mock.calls.at(-1)[0]).toBe('COMMIT');
    replay = { set_id: 5, request_hash: svc.requestHash(4, payload), version: 1 };
    await svc.save(1, 4, 90, payload);
    expect(store.insertDocument).toHaveBeenCalledTimes(2);
    expect(ledger.postDocument).toHaveBeenCalledTimes(2);
  });
  test('foreign/non-sale storage rejects the whole transaction before any movement', async () => {
    storageRows = [{ id: 2, is_active: true, for_sale: true }];
    await expect(svc.save(1, 4, 90, payload)).rejects.toMatchObject({ status: 400, code: 'validation' });
    expect(store.insertDocument).not.toHaveBeenCalled();
    expect(ledger.postDocument).not.toHaveBeenCalled();
    expect(q.mock.calls.at(-1)[0]).toBe('ROLLBACK');
  });
  test('changed idempotency key payload conflicts without a second ledger write', async () => {
    replay = { set_id: 5, request_hash: 'different', version: 1 };
    await expect(svc.save(1, 4, 90, payload)).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
    expect(store.insertDocument).not.toHaveBeenCalled();
    expect(q.mock.calls.at(-1)[0]).toBe('ROLLBACK');
  });
});

describe('appointment goods route boundary', () => {
  test('all inline routes sit behind owner/admin middleware and use server salon/user claims', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'routes/stock.js'), 'utf8');
    expect(src.indexOf("router.use(auth, requireRole('owner', 'admin'))"))
      .toBeLessThan(src.indexOf("router.get('/records/:recordId/goods'"));
    expect(src).toMatch(/appointmentGoods\.get\(req\.user\.salonId/);
    expect(src).toMatch(/appointmentGoods\.save\(req\.user\.salonId, req\.user\.userId/);
    expect(src).toMatch(/appointmentGoods\.reserveCode\(req\.user\.salonId, req\.user\.userId/);
  });
});
