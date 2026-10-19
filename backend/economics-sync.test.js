'use strict';
jest.mock('./db', () => ({ db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn(), any: jest.fn() }, pool: {} }));
jest.mock('./services/yclients', () => ({ ycGet: jest.fn() }));
jest.mock('./services/economics/store', () => ({
  upsertGoodsTransaction: jest.fn(), refreshLastReceipt: jest.fn(), refreshAllLastReceipts: jest.fn(),
  upsertCatalogGood: jest.fn(), upsertTechCard: jest.fn(), upsertServiceTechCard: jest.fn(),
  listTechCardIdsByYc: jest.fn(), listRecordsToLearn: jest.fn(),
}));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));
const { ycGet } = require('./services/yclients');
const store = require('./services/economics/store');
const sync = require('./services/economics/sync');

const SALON = { id: 1, yclients_company_id: '668791' };
const noSleep = async () => {};
beforeEach(() => { jest.clearAllMocks(); Object.values(store).forEach(f => f.mockResolvedValue && f.mockResolvedValue(undefined)); });

describe('syncGoodsCatalog', () => {
  test('постранично до пустой страницы, числа из строк, остатки в stock', async () => {
    ycGet.mockImplementation(async (s, path, params) => {
      expect(path).toBe('/goods/668791');
      expect(params.count).toBe(100);
      if (params.page === 1) return [{ good_id: '123', title: 'Шампунь', unit_short_title: 'шт', service_unit_short_title: 'гр',
        unit_equals: '10', actual_cost: '1050', unit_actual_cost: '105', actual_amounts: [{ storage_id: '987', amount: '1000000' }] }];
      if (params.page === 2) return [{ good_id: 124, title: 'Б', unit_equals: '', actual_cost: null }];
      return [];
    });
    const r = await sync.syncGoodsCatalog(SALON, { sleep: noSleep });
    expect(r).toEqual({ pages: 3, goods: 2 });
    expect(store.upsertCatalogGood).toHaveBeenCalledWith(1, {
      good_id: 123, title: 'Шампунь', unit: 'шт', service_unit: 'гр', unit_equals: 10,
      actual_cost: 1050, unit_actual_cost: 105, stock: [{ storage_id: 987, amount: 1000000 }],
    });
    expect(store.upsertCatalogGood).toHaveBeenCalledWith(1, expect.objectContaining({ good_id: 124, unit_equals: null, actual_cost: null, stock: [] }));
  });
  test('кап страниц — не больше MAX_GOODS_PAGES', async () => {
    ycGet.mockResolvedValue([{ good_id: 1, title: 'x' }]);
    const r = await sync.syncGoodsCatalog(SALON, { sleep: noSleep });
    expect(r.pages).toBe(sync.MAX_GOODS_PAGES);
    expect(mockLog.warn).toHaveBeenCalled();
  });
});

describe('reconcileGoodsTransactions', () => {
  test('changed_after за 2 дня, постранично, апсерт source=reconcile, приходы пересчитывают закупку', async () => {
    const rows = [
      { id: 1, type_id: 2, amount: '-1', cost: '5', good: { id: 9, title: 'G' }, record_id: 77, create_date: '2026-10-17T10:00:00+0400' },
      { id: 2, type_id: 3, amount: '3', cost: '12180', good: { id: 9, title: 'G' }, record_id: 0, create_date: '2026-10-17T11:00:00+0400' },
    ];
    ycGet.mockImplementation(async (s, path, params) => {
      expect(path).toBe('/storages/transactions/668791');
      expect(params.changed_after).toBe('2026-10-16T00:00:00'); // голую дату YClients игнорирует
      return params.page === 1 ? rows : [];
    });
    const r = await sync.reconcileGoodsTransactions(SALON, { now: new Date('2026-10-18T12:00:00+03:00'), sleep: noSleep });
    expect(r).toEqual({ pages: 2, upserted: 2, skipped: 0, receipts: 1 });
    expect(store.upsertGoodsTransaction).toHaveBeenCalledWith(1, expect.objectContaining({ yclients_txn_id: 1, record_id: 77 }), { status: 'update', source: 'reconcile' });
    expect(store.refreshLastReceipt).toHaveBeenCalledWith(1, 9);
    expect(store.refreshLastReceipt).toHaveBeenCalledTimes(1);
  });
  test('битая строка пропускается и считается в skipped', async () => {
    ycGet.mockImplementation(async (s, p, params) => (params.page === 1 ? [{ id: 'x' }, { id: 3, amount: '1', type_id: 2 }] : []));
    const r = await sync.reconcileGoodsTransactions(SALON, { sleep: noSleep });
    expect(r.upserted).toBe(1);
    expect(r.skipped).toBe(1);
  });
  test('сбой апсерта одной строки не роняет сверку', async () => {
    ycGet.mockImplementation(async (s, p, params) => (params.page === 1 ? [{ id: 3, amount: '1', type_id: 2 }, { id: 4, amount: '1', type_id: 2 }] : []));
    store.upsertGoodsTransaction.mockRejectedValueOnce(new Error('db'));
    const r = await sync.reconcileGoodsTransactions(SALON, { sleep: noSleep });
    expect(r.upserted).toBe(1);
    expect(r.skipped).toBe(1);
  });
});

describe('monthRanges / mskDate', () => {
  test('границы месяцев, високосный февраль, один день', () => {
    expect(sync.monthRanges('2024-01-31', '2024-03-01')).toEqual([
      ['2024-01-31', '2024-01-31'], ['2024-02-01', '2024-02-29'], ['2024-03-01', '2024-03-01'],
    ]);
    expect(sync.monthRanges('2026-10-05', '2026-10-05')).toEqual([['2026-10-05', '2026-10-05']]);
  });
  test('mskDate — московская дата (23:30 UTC = следующий день)', () => {
    expect(sync.mskDate(new Date('2026-10-17T21:30:00Z'))).toBe('2026-10-18');
    expect(sync.mskDate(new Date('2026-10-18T12:00:00+03:00'), -2)).toBe('2026-10-16');
  });
});

describe('backfillGoodsTransactions', () => {
  test('помесячно start_date/end_date, source=backfill, идёт до текущего месяца', async () => {
    const seen = [];
    ycGet.mockImplementation(async (s, p, params) => { seen.push({ ...params }); return params.page === 1 ? [{ id: 100 + seen.length, amount: '1', type_id: 2, create_date: params.start_date + 'T10:00:00+0400' }] : []; });
    const r = await sync.backfillGoodsTransactions(SALON, { from: '2026-08-15', to: '2026-10-05', sleep: noSleep });
    expect(seen.filter(p => p.page === 1).map(p => [p.start_date, p.end_date])).toEqual([
      ['2026-08-15', '2026-08-31'], ['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-05'],
    ]);
    expect(r.months).toBe(3);
    expect(r.upserted).toBe(3);
    expect(store.upsertGoodsTransaction).toHaveBeenCalledWith(1, expect.anything(), { status: 'update', source: 'backfill' });
    expect(store.refreshAllLastReceipts).toHaveBeenCalledWith(1);
  });
  test('битые from/to — исключение до запросов', async () => {
    await expect(sync.backfillGoodsTransactions(SALON, { from: '2026-10-05', to: '2026-10-01', sleep: noSleep })).rejects.toThrow();
    await expect(sync.backfillGoodsTransactions(SALON, { from: 'x', sleep: noSleep })).rejects.toThrow();
    expect(ycGet).not.toHaveBeenCalled();
  });
});

describe('backfillGoodsTransactions dryRun', () => {
  test('читает и считает, но в БД не пишет', async () => {
    ycGet.mockImplementation(async (s, p, params) => (params.page === 1 ? [{ id: 7, amount: '1', type_id: 3, good: { id: 9 } }] : []));
    const r = await sync.backfillGoodsTransactions(SALON, { from: '2026-09-01', to: '2026-09-30', sleep: noSleep, dryRun: true });
    expect(r).toEqual({ months: 1, upserted: 1, skipped: 0 });
    expect(store.upsertGoodsTransaction).not.toHaveBeenCalled();
    expect(store.refreshAllLastReceipts).not.toHaveBeenCalled();
  });
});
