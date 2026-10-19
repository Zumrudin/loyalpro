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
