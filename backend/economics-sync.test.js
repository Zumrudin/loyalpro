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

describe('syncTechCards', () => {
  test('постранично, каждая карта → upsertTechCard', async () => {
    ycGet.mockImplementation(async (s, p, params) => { expect(p).toBe('/technological_cards/668791/'); return params.page === 1 ? [{ id: 1, title: 'A', technological_card_items: [{ good_id: 5, amount: 1 }] }, { id: 'bad' }] : []; });
    store.upsertTechCard.mockResolvedValue(11);
    const r = await sync.syncTechCards(SALON, { sleep: noSleep });
    expect(r).toEqual({ pages: 2, cards: 1, skipped: 1 });
    expect(store.upsertTechCard).toHaveBeenCalledWith(1, { yc_card_id: 1, title: 'A', items: [{ good_id: 5, amount: 1, unit: null, price_at_sync: null, title: null }] });
  });
  test('кап страниц — не больше MAX_CARD_PAGES', async () => {
    ycGet.mockResolvedValue([{ id: 1, title: 'A', technological_card_items: [] }]);
    const r = await sync.syncTechCards(SALON, { sleep: noSleep });
    expect(r.pages).toBe(sync.MAX_CARD_PAGES);
    expect(mockLog.warn).toHaveBeenCalled();
  });
});

describe('learnTechCardLinks', () => {
  test('по вчерашним записям: record_consumables → привязка learned по services[].technological_cards[]', async () => {
    store.listRecordsToLearn.mockResolvedValue([{ record_id: 500, staff_yc_id: 7 }]);
    store.listTechCardIdsByYc.mockResolvedValue(new Map([['36069', 11]]));
    ycGet.mockResolvedValue([
      { service_id: 21558, record_id: 500, technological_cards: [{ id: 36069, title: 'X', technological_card_items: [] }], consumables: [] },
      { service_id: 21559, record_id: 500, technological_cards: [], consumables: [] },   // услуга без техкарты
    ]);
    const r = await sync.learnTechCardLinks(SALON, { now: new Date('2026-10-18T12:00:00+03:00'), sleep: noSleep });
    expect(store.listRecordsToLearn).toHaveBeenCalledWith(1, '2026-10-17', sync.MAX_LEARN_CALLS);
    expect(ycGet).toHaveBeenCalledWith(SALON, '/technological_cards/record_consumables/668791/500/');
    expect(store.upsertServiceTechCard).toHaveBeenCalledTimes(1);
    expect(store.upsertServiceTechCard).toHaveBeenCalledWith(1, { serviceYcId: 21558, staffYcId: 7, techCardId: 11, source: 'learned' });
    expect(r).toEqual({ records: 1, linked: 1, unknownCards: 0 });
  });
  test('карта не импортирована → unknownCards, привязки нет', async () => {
    store.listRecordsToLearn.mockResolvedValue([{ record_id: 500, staff_yc_id: 7 }]);
    store.listTechCardIdsByYc.mockResolvedValue(new Map());
    ycGet.mockResolvedValue([{ service_id: 1, technological_cards: [{ id: 999 }] }]);
    const r = await sync.learnTechCardLinks(SALON, { sleep: noSleep });
    expect(r.unknownCards).toBe(1);
    expect(store.upsertServiceTechCard).not.toHaveBeenCalled();
  });
  test('сбой одного record_consumables — WARN и дальше', async () => {
    store.listRecordsToLearn.mockResolvedValue([{ record_id: 500, staff_yc_id: 7 }, { record_id: 501, staff_yc_id: 7 }]);
    store.listTechCardIdsByYc.mockResolvedValue(new Map([['5', 11]]));
    ycGet.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }))
      .mockResolvedValueOnce([{ service_id: 3, technological_cards: [{ id: 5 }] }]);
    const r = await sync.learnTechCardLinks(SALON, { sleep: noSleep });
    expect(r).toEqual({ records: 2, linked: 1, unknownCards: 0 });
    expect(mockLog.warn).toHaveBeenCalled();
  });
});

describe('lookupTechCardForService', () => {
  test('по каждому исполнителю ≤ 4 вызова, найденная карта импортируется и привязывается lookup', async () => {
    store.upsertTechCard.mockResolvedValue(12);
    ycGet.mockImplementation(async (s, p) => (p.endsWith('/5/10/') ? { id: 77, title: 'C', technological_card_items: [] } : null));
    const r = await sync.lookupTechCardForService(SALON, 10, [5, 6], { sleep: noSleep });
    expect(ycGet).toHaveBeenCalledTimes(2);
    expect(ycGet).toHaveBeenCalledWith(SALON, '/technological_cards/default_for_staff_and_service/668791/5/10/');
    expect(store.upsertServiceTechCard).toHaveBeenCalledWith(1, { serviceYcId: 10, staffYcId: 5, techCardId: 12, source: 'lookup' });
    expect(r).toEqual({ checked: 2, found: [{ staffYcId: 5, techCardId: 12, title: 'C' }] });
  });
  test('кап исполнителей MAX_LOOKUP_STAFF', async () => {
    ycGet.mockResolvedValue(null);
    const r = await sync.lookupTechCardForService(SALON, 10, [1, 2, 3, 4, 5, 6], { sleep: noSleep });
    expect(ycGet).toHaveBeenCalledTimes(sync.MAX_LOOKUP_STAFF);
    expect(r).toEqual({ checked: sync.MAX_LOOKUP_STAFF, found: [] });
  });
});

describe('второе ревью п.4: общая занятость салона (ручной импорт техкарт ⟂ /sync ⟂ ночной)', () => {
  test('runExclusive при идущем runNightly — BUSY; после окончания — снова можно', async () => {
    let release; const gate = new Promise(r => { release = r; });
    ycGet.mockImplementation(async () => { await gate; return []; });
    store.refreshAllLastReceipts.mockResolvedValue(0);
    const nightly = sync.runNightly(SALON, { sleep: noSleep });
    expect(sync.isRunning(1)).toBe(true);
    await expect(sync.runExclusive(1, async () => 'x')).rejects.toMatchObject({ code: 'BUSY' });
    release(); await nightly;
    expect(sync.isRunning(1)).toBe(false);
    await expect(sync.runExclusive(1, async () => 'ok')).resolves.toBe('ok');
  });
  test('ручной импорт держит занятость: ночной в это время — BUSY; ошибка внутри снимает занятость', async () => {
    let release; const gate = new Promise(r => { release = r; });
    const manual = sync.runExclusive(1, () => gate);
    await expect(sync.runNightly(SALON, { sleep: noSleep })).rejects.toMatchObject({ code: 'BUSY' });
    release('done'); await expect(manual).resolves.toBe('done');
    await expect(sync.runExclusive(1, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(sync.isRunning(1)).toBe(false);
  });
});
