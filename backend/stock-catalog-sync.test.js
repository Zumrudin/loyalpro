'use strict';
jest.mock('./services/stock/store', () => ({
  setGoodActiveByYcId: jest.fn(async () => {}),
  upsertStorage: jest.fn(), listUnits: jest.fn(async () => []),
}));
jest.mock('./services/economics/store', () => ({ upsertCatalogGood: jest.fn(async () => {}) }));
jest.mock('./db', () => ({ db: { query: jest.fn(), one: jest.fn(), oneOrNone: jest.fn(), any: jest.fn() } }));

const cs = require('./services/stock/catalog-sync');
const { parseCatalogGood } = require('./services/economics/sync');
const store = require('./services/stock/store');
const econStore = require('./services/economics/store');

describe('parseStorage', () => {
  it('разбирает склад YClients', () => {
    expect(cs.parseStorage({ id: 1334902, title: 'Расходники', for_service: 1, for_sale: 0, comment: 'к', weight: 2 }))
      .toEqual({ ycStorageId: 1334902, title: 'Расходники', forService: true, forSale: false, comment: 'к', weight: 2 });
  });
  it('без id — null', () => { expect(cs.parseStorage({ title: 'x' })).toBeNull(); });
});

describe('flattenCategoryTree', () => {
  const roots = [{ id: 1, title: 'Расходники', parent_category_id: 0 }];
  it('строит пути', () => {
    const kids = { 1: [{ id: 2, title: 'Препараты' }], 2: [{ id: 3, title: 'РЕВИ' }] };
    const r = cs.flattenCategoryTree(roots, kids);
    expect(r.find(x => x.id === 3).path).toEqual([{ id: 1, title: 'Расходники' }, { id: 2, title: 'Препараты' }, { id: 3, title: 'РЕВИ' }]);
    expect(r.find(x => x.id === 2).parentId).toBe(1);
    expect(r.find(x => x.id === 1).parentId).toBeNull();
  });
  it('глубина ≤ 4', () => {
    const kids = { 1: [{ id: 2, title: 'b' }], 2: [{ id: 3, title: 'c' }], 3: [{ id: 4, title: 'd' }], 4: [{ id: 5, title: 'e' }] };
    const r = cs.flattenCategoryTree(roots, kids);
    expect(Math.max(...r.map(x => x.path.length))).toBeLessThanOrEqual(4);
    expect(r.find(x => x.id === 5)).toBeUndefined();
  });
  it('цикл обрывается', () => {
    const kids = { 1: [{ id: 2, title: 'b' }], 2: [{ id: 1, title: 'a' }] };
    const r = cs.flattenCategoryTree(roots, kids);
    expect(r.map(x => x.id).sort()).toEqual([1, 2]);
  });
});

describe('parseCatalogGood — новые поля', () => {
  it('отдаёт поля склада', () => {
    const g = parseCatalogGood({ good_id: '77', title: 'T', cost: '1500.50', barcode: '123', unit_id: '5', service_unit_id: '6',
      critical_amount: '2', desired_amount: '10', comment: 'c', loyalty_abonement_type_id: '0', loyalty_certificate_type_id: '9',
      last_change_date: '2026-11-01T10:00:00+03:00', unit_equals: '300' });
    expect(g).toMatchObject({ good_id: 77, sale_price: 1500.5, barcode: '123', unit_id: 5, service_unit_id: 6, critical_amount: 2,
      desired_amount: 10, comment: 'c', loyalty_certificate_type_id: 9 });
    expect(g.loyalty_abonement_type_id).toBeNull();
    expect(g.yc_last_change_date).toBe('2026-11-01T10:00:00+03:00');
  });
  it('пустые → null', () => {
    const g = parseCatalogGood({ good_id: 1, title: 'T', cost: '', barcode: '', critical_amount: null });
    expect(g.sale_price).toBeNull(); expect(g.barcode).toBeNull(); expect(g.critical_amount).toBeNull();
    expect(g.comment).toBeNull(); expect(g.yc_last_change_date).toBeNull();
  });
});

describe('unitsFromRows', () => {
  it('уникальные единицы из транзакций и товаров', () => {
    const r = cs.unitsFromRows({
      txnUnits: [{ id: 5, title: 'Флакон', short_title: 'фл' }, { id: 5, title: 'Флакон', short_title: 'фл' }, null, {}],
      goods: [{ unit_id: 6, unit_short_title: 'шт' }, { service_unit_id: 7, service_unit_short_title: 'мл' }, { unit_id: 5, unit_short_title: 'фл' }],
    });
    expect(r.map(u => u.ycUnitId).sort()).toEqual([5, 6, 7]);
    expect(r.find(u => u.ycUnitId === 5)).toEqual({ ycUnitId: 5, title: 'Флакон', shortTitle: 'фл' });
    expect(r.find(u => u.ycUnitId === 6).title).toBe('шт');
  });
});

describe('parseLocalGoodBody', () => {
  const units = [{ id: 1, short_title: 'шт' }, { id: 2, short_title: 'мл' }];
  const ok = { title: 'Крем', unitId: 1, serviceUnitId: 2, unitEquals: 50, salePrice: 100, actualCost: 5, criticalAmount: 1, barcode: '1', note: 'n', localCategory: 'Кат' };
  it('валидное тело', () => {
    const r = cs.parseLocalGoodBody(ok, units);
    expect(r).toMatchObject({ title: 'Крем', unitId: 1, serviceUnitId: 2, unitEquals: 50, salePrice: 100, actualCost: 5 });
  });
  it('ошибки через StockError 400 с errors[]', () => {
    let e; try { cs.parseLocalGoodBody({ title: '', unitId: 99, unitEquals: 0, salePrice: -1, barcode: 'x'.repeat(65), note: 'x'.repeat(1001), localCategory: 'x'.repeat(201) }, units); } catch (x) { e = x; }
    expect(e.status).toBe(400); expect(e.errors.length).toBeGreaterThanOrEqual(6);
  });
  it('null допустим для необязательных', () => {
    const r = cs.parseLocalGoodBody({ ...ok, salePrice: null, actualCost: null, criticalAmount: null, serviceUnitId: null }, units);
    expect(r.salePrice).toBeNull(); expect(r.serviceUnitId).toBeNull();
  });
});

describe('handleGoodEvent', () => {
  beforeEach(() => jest.clearAllMocks());
  it('delete → stock_active=false, не удаление', async () => {
    await cs.handleGoodEvent({ id: 1 }, { resource: 'good', status: 'delete', data: { id: 77 } });
    expect(store.setGoodActiveByYcId).toHaveBeenCalledWith(1, 77, false);
    expect(econStore.upsertCatalogGood).not.toHaveBeenCalled();
  });
  it('update с полной карточкой → апсерт каталога', async () => {
    await cs.handleGoodEvent({ id: 1 }, { resource: 'good', status: 'update', data: { id: 77, title: 'X', cost: '10', unit_id: 216760 } });
    expect(econStore.upsertCatalogGood).toHaveBeenCalledWith(1, expect.objectContaining({ good_id: 77, sale_price: 10 }));
  });
  it('update с частичным payload (без title/unit_id) пропускается — иначе UPSERT обнулил бы поля', async () => {
    const r = await cs.handleGoodEvent({ id: 1 }, { resource: 'good', status: 'update', data: { id: 77, cost: '10' } });
    expect(r).toEqual({ handled: false, partial: true });
    expect(econStore.upsertCatalogGood).not.toHaveBeenCalled();
  });
  it('чужой ресурс игнорируется', async () => {
    const r = await cs.handleGoodEvent({ id: 1 }, { resource: 'record', data: { id: 1 } });
    expect(r.handled).toBe(false);
  });
});

describe('similarTitles', () => {
  it('нормализация как normTitle', () => {
    const r = cs.similarTitles('Крем (50 мл) ', [{ id: 1, title: 'крем' }, { id: 2, title: 'Мыло' }]);
    expect(r.map(x => x.id)).toEqual([1]);
  });
});
