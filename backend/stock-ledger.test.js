'use strict';
jest.mock('./services/stock/store', () => ({
  goodByYcId: jest.fn(), ensureStorage: jest.fn(), clientIdByYc: jest.fn(),
  addIngestPending: jest.fn(), markMovementDeleted: jest.fn(), upsertMirrorDocument: jest.fn(),
  upsertMovement: jest.fn(), insertMovement: jest.fn(),
}));
jest.mock('./db', () => ({ db: { query: jest.fn(), any: jest.fn(), one: jest.fn(), oneOrNone: jest.fn() } }));
const store = require('./services/stock/store');
const ledger = require('./services/stock/ledger');
const model = require('./services/stock/model');
const actualStore = jest.requireActual('./services/stock/store');
const at = '2026-11-13T09:00:00Z';
const row = { yclients_txn_id: 101, document_id: 102, type_id: 2, good_id: 103,
  storage_id: 104, amount: 2, operation_unit_type: 2, cost_per_unit: 50, cost: 100,
  discount: 0, record_id: 105, service_id: 106, master_id: 107, create_date: at,
  raw: { storage: { title: 'Склад теста' }, client: { id: 108, name: 'PRIVATE_NAME', phone: 'PRIVATE_PHONE' } } };
beforeEach(() => {
  jest.clearAllMocks();
  store.goodByYcId.mockResolvedValue({ id: 1, unit_equals: 500 });
  store.ensureStorage.mockResolvedValue({ id: 2 });
  store.clientIdByYc.mockResolvedValue(3);
  store.upsertMirrorDocument.mockResolvedValue({ id: 4 });
});
test('зеркало: пересчёт, источник, ссылки и отсутствие PII во всех аргументах', async () => {
  await expect(ledger.ingestMirrored(7, row, { status: 'update', source: 'webhook' })).resolves.toEqual({ ingested: true });
  expect(store.goodByYcId).toHaveBeenCalledWith(7, 103);
  expect(store.clientIdByYc).toHaveBeenCalledWith(7, 108);
  expect(store.upsertMirrorDocument).toHaveBeenCalledWith(7, expect.objectContaining({ kind: 'consumable', ycDocumentId: 102, storageId: 2, docDate: at, recordId: 105, masterStaffYcId: 107, clientId: 3, ycClientId: 108 }));
  expect(store.upsertMovement).toHaveBeenCalledWith(7, expect.objectContaining({ documentId: 4, goodRowId: 1, storageId: 2, qtyBase: model.toBaseInfo({ kind: 'consumable', qty: 2, unitType: 2, unitEquals: 500, costPerUnit: 50, cost: 100 }).qtyBase, source: 'webhook', ycTxnId: 101, occurredAt: at, serviceYcId: 106 }));
  for (const fn of Object.values(store)) expect(JSON.stringify(fn.mock.calls)).not.toMatch(/PRIVATE_NAME|PRIVATE_PHONE/);
});
test('неизвестный товар откладывается, без движения', async () => {
  store.goodByYcId.mockResolvedValue(null);
  expect(await ledger.ingestMirrored(7, row, { status: 'update', source: 'backfill' })).toEqual({ pending: true });
  expect(store.addIngestPending).toHaveBeenCalledWith(7, expect.objectContaining({ yclients_txn_id: 101 }));
  expect(store.upsertMovement).not.toHaveBeenCalled();
  expect(JSON.stringify(store.addIngestPending.mock.calls)).not.toMatch(/PRIVATE_NAME|PRIVATE_PHONE/);
});
test('удаление не требует каталога и сохраняет дату', async () => {
  expect(await ledger.ingestMirrored(7, row, { status: 'delete', deletedAt: at })).toEqual({ deleted: true });
  expect(store.markMovementDeleted).toHaveBeenCalledWith(7, 101, at);
  expect(store.goodByYcId).not.toHaveBeenCalled();
});
test('неизвестный вид пропускается', async () => {
  expect(await ledger.ingestMirrored(7, { ...row, type_id: 99 }, {})).toEqual({ skipped: 'type' });
});
test.each([['receipt', 10], ['writeoff', -10], ['sale', -10]])('%s: нормализованное количество и дата документа', async (kind, qtyBase) => {
  const q = jest.fn();
  await ledger.postDocument(q, 7, { id: 4, kind, storageId: 2, docDate: at }, [{ goodRowId: 1, qty: 10, unitType: 2, qtyBase }]);
  expect(store.insertMovement).toHaveBeenCalledWith(q, 7, expect.objectContaining({ qtyBase, source: 'loyalpro', occurredAt: at }));
});
test('специалист строки сохраняется в движении и имеет приоритет над специалистом документа', async () => {
  const q = jest.fn();
  await ledger.postDocument(q, 7, { id: 4, kind: 'sale', storageId: 2, docDate: at, masterStaffYcId: 100 },
    [{ goodRowId: 1, qty: 1, unitType: 1, qtyBase: -1, masterStaffYcId: 200 }]);
  expect(store.insertMovement).toHaveBeenCalledWith(q, 7, expect.objectContaining({ masterStaffYcId: 200 }));
});
test('перемещение: две строки на каждую позицию', async () => {
  await ledger.postDocument(jest.fn(), 7, { id: 4, kind: 'move', storageId: 2, toStorageId: 3, docDate: at }, [{ goodRowId: 1, qtyBase: -10 }, { goodRowId: 5, qtyBase: -20 }]);
  expect(store.insertMovement.mock.calls.map(c => [c[2].storageId, c[2].qtyBase])).toEqual([[2, -10], [3, 10], [2, -20], [3, 20]]);
});
test('SQL остатков экспортирован и содержит правило снимка и статус документа', () => {
  for (const text of ['stock_openings', 'recorded_at', "('loyalpro','inventory')", "('webhook','reconcile')", "d.status = 'posted'"]) expect(actualStore.BALANCES_SQL).toContain(text);
});
test('снимок: единицы продажи, отрицательные остатки, неизвестный коэффициент', () => {
  expect(ledger.openingFromCatalog({ unit_equals: 500, stock: [{ storage_id: 12, amount: -8.118 }] })).toEqual([{ storageYcId: 12, qtyBase: -4059, ycQtyBase: -4059, unitUnknown: false }]);
  expect(ledger.openingFromCatalog({ unit_equals: null, stock: [{ storage_id: 12, amount: 3 }] })).toEqual([{ storageYcId: 12, qtyBase: 3, ycQtyBase: 3, unitUnknown: true }]);
  expect(ledger.openingFromCatalog({ stock: null })).toEqual([]);
});

const { db } = require('./db');
test('pending: SQL получает raw без client, исходный объект неизменён', async () => {
  await actualStore.addIngestPending(7, row);
  const [sql, params] = db.query.mock.calls[0];
  expect(sql).toContain('ON CONFLICT DO NOTHING');
  expect(params.slice(0, 3)).toEqual([7, 101, 103]);
  expect(JSON.parse(params[3])).toEqual({ storage: { title: 'Склад теста' } });
  expect(row.raw.client.name).toBe('PRIVATE_NAME');
});
test('апсерт движения не меняет recorded_at и source, обновляет связи', async () => {
  await actualStore.upsertMovement(7, { documentId: 4, goodRowId: 1, storageId: 2, qty: 2, unitType: 2, qtyBase: -2, source: 'backfill', occurredAt: at });
  const [sql, params] = db.oneOrNone.mock.calls[0];
  const update = sql.split('DO UPDATE SET')[1];
  expect(update).not.toMatch(/recorded_at\s*=|source\s*=/);
  for (const col of ['document_id', 'storage_id', 'record_id', 'service_yc_id', 'master_staff_yc_id']) expect(update).toContain(`${col} = EXCLUDED.${col}`);
  expect(update).toContain('deleted_at = NULL');
  expect(params[0]).toBe(7);
});
test('кэш общий по салону, фильтры независимы; инвалидация и TTL 30 секунд', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
  db.any.mockResolvedValue([{ good_row_id: '1', storage_id: '2' }, { good_row_id: '5', storage_id: '3' }]);
  actualStore.invalidateBalances(7);
  expect(await actualStore.balances(7, { goodRowIds: [1] })).toHaveLength(1);
  expect(await actualStore.balances('7', { storageId: 3 })).toEqual([{ good_row_id: '5', storage_id: '3' }]);
  expect(db.any).toHaveBeenCalledTimes(1);
  now.mockReturnValue(31001);
  await actualStore.balances(7);
  expect(db.any).toHaveBeenCalledTimes(2);
  await actualStore.markMovementDeleted(7, 101, at);
  await actualStore.balances(7);
  await actualStore.balances(8);
  expect(db.any).toHaveBeenCalledTimes(4);
  now.mockRestore();
});
test('хук экономики: флаг выключения и сбой не ломают запись', async () => {
  const config = require('./config');
  const old = config.STOCK_LEDGER;
  const spy = jest.spyOn(ledger, 'ingestMirrored').mockRejectedValue(new Error('Тестовый сбой'));
  try {
    config.STOCK_LEDGER = 'false';
    const economics = require('./services/economics/store');
    await expect(economics.upsertGoodsTransaction(7, row, { status: 'update', source: 'webhook' })).resolves.toEqual({ deleted: false });
    expect(spy).not.toHaveBeenCalled();
    config.STOCK_LEDGER = undefined;
    // Леджер получает ИТОГОВУЮ строку goods_transactions (после правил свежести/удаления), а не входящее событие.
    const stored = { ...row, deleted_at: at };
    db.oneOrNone.mockResolvedValueOnce(stored);
    await expect(economics.upsertGoodsTransaction(7, row, { status: 'delete', source: 'webhook', deletedAt: at })).resolves.toEqual({ deleted: true });
    expect(spy).toHaveBeenCalledWith(7, stored, { status: 'delete', source: 'webhook', deletedAt: at });
    // Событие update, но в БД строка уже удалена позже → леджер видит delete (защита от порядка).
    db.oneOrNone.mockResolvedValueOnce({ ...row, deleted_at: at });
    await economics.upsertGoodsTransaction(7, row, { status: 'update', source: 'reconcile' });
    expect(spy).toHaveBeenLastCalledWith(7, expect.objectContaining({ deleted_at: at }), { status: 'delete', source: 'reconcile', deletedAt: at });
  } finally { config.STOCK_LEDGER = old; spy.mockRestore(); }
});

test('сухая переливка: разбор всех статусов без вызова stock store', async () => {
  const argv = process.argv;
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    process.argv = ['node', 'stock-backfill-mirror.js', '--salon=7'];
    db.one.mockResolvedValue({ name: 'loyalpro_test' });
    db.any.mockReset();
    db.any.mockResolvedValueOnce([{ yclients_good_id: 103 }])
      .mockResolvedValueOnce([
        { ...row, id: 1 }, { ...row, id: 2, good_id: 999 },
        { ...row, id: 3, deleted_at: at }, { ...row, id: 4, type_id: 99 },
      ]).mockResolvedValueOnce([]);
    const { main, mirrorRow } = require('./scripts/stock-backfill-mirror');
    expect(mirrorRow({ ...row, id: 999 }).yclients_txn_id).toBe(101);
    expect(await main()).toEqual({ ingested: 1, pending: 1, deleted: 1, skipped: 1 });
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  } finally { process.argv = argv; log.mockRestore(); }
});
