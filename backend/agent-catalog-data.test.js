'use strict';

jest.mock('./services/service-catalog', () => ({ list: jest.fn() }));
jest.mock('./services/agent-settings', () => ({ loadServiceFilter: jest.fn() }));
const serviceCatalog = require('./services/service-catalog');
const settings = require('./services/agent-settings');
const { adaptCatalog, loadCatalogServices, loadCategoryTitles } = require('./services/agent/catalog-data');

const filter = (over = {}) => ({
  mode: 'all', denyServices: new Set(), allowServices: new Set(), denyPairs: new Set(), ...over,
});
const fixture = (over = {}) => ({
  categories: [
    { id: 1, parent_id: null, title: 'Косметология', yclients_id: 100 },
    { id: 2, parent_id: 1, title: 'Инъекции', yclients_id: null },
  ],
  staffMembers: [
    { id: 10, yclients_staff_id: 501, name: 'Анна', is_active: true },
    { id: 11, yclients_staff_id: 502, name: 'Пери', is_active: true },
    { id: 12, yclients_staff_id: 503, name: 'Неактивный', is_active: false },
  ],
  services: [{
    id: 7, yclients_id: 77, linked: true, title: 'Процедура', category_id: 2,
    active: true, assignmentsUnresolved: false, duration: 60, price_min: 1000, price_max: 2000,
    staff: [
      { id: 501, seance_length: 1800, price: { min: 0, max: 0 } },
      { id: 502, seance_length: 5400, price: { min: null, max: null } },
      { id: 503, seance_length: 3600, price: { min: 500, max: 500 } },
    ],
  }],
  ...over,
});

describe('canonical Mila catalog adapter', () => {
  test('preserves external IDs and local path; inherits prices and exposes personal duration', () => {
    expect(adaptCatalog(fixture(), filter())).toEqual([{
      local_id: 7, yc_id: 77, title: 'Процедура', duration_min: 60,
      price_min: 0, price_max: 2000, category_id: 2,
      category_path: ['Косметология', 'Инъекции'],
      staff: [
        { yc_id: 501, name: 'Анна', price_min: 0, price_max: 0, duration_min: 30 },
        { yc_id: 502, name: 'Пери', price_min: 1000, price_max: 2000, duration_min: 90 },
      ],
    }]);
  });

  test('applies service visibility, pair deny, active staff and unresolved-assignment guards', () => {
    const data = fixture({ services: [
      ...fixture().services,
      { ...fixture().services[0], id: 8, yclients_id: 78, assignmentsUnresolved: true },
      { ...fixture().services[0], id: 9, yclients_id: null, linked: false },
    ] });
    const out = adaptCatalog(data, filter({ denyPairs: new Set(['77:501']) }));
    expect(out).toHaveLength(1);
    expect(out[0].staff.map(s => s.yc_id)).toEqual([502]);
  });

  test('inactive service cannot be resurrected by an old allow rule', () => {
    const data = fixture({ services: [{ ...fixture().services[0], active: false }] });
    expect(adaptCatalog(data, filter({ allowServices: new Set(['77']) }))).toEqual([]);
  });

  test('invalid performer duration removes the pair and an unknown price does not fabricate aggregate', () => {
    const base = fixture().services[0];
    const data = fixture({ services: [{ ...base, price_min: null, price_max: null, staff: [
      { id: 501, seance_length: 0, price: { min: 500, max: 500 } },
      { id: 502, seance_length: 3600, price: { min: null, max: null } },
    ] }] });
    const out = adaptCatalog(data, filter());
    expect(out[0].staff).toEqual([{ yc_id: 502, name: 'Пери', price_min: null, price_max: null, duration_min: 60 }]);
    expect(out[0]).toEqual(expect.objectContaining({ price_min: null, price_max: null }));
  });

  test('local catalog is the loader source and category IDs are canonical local IDs', async () => {
    serviceCatalog.list.mockResolvedValue(fixture());
    settings.loadServiceFilter.mockResolvedValue(filter());
    const services = await loadCatalogServices(4);
    const categories = await loadCategoryTitles(4);
    expect(serviceCatalog.list).toHaveBeenCalledWith(4);
    expect(services[0].title).toBe('Процедура');
    expect(categories).toEqual([
      { id: 1, title: 'Косметология', external_id: 100 },
      { id: 2, title: 'Инъекции', external_id: null },
    ]);
  });

  test('catalog read failure is surfaced instead of returning stale legacy data', async () => {
    serviceCatalog.list.mockRejectedValueOnce(new Error('catalog unavailable'));
    settings.loadServiceFilter.mockResolvedValue(filter());
    await expect(loadCatalogServices(4)).rejects.toThrow('catalog unavailable');
  });

  test('visibility-rule failure is fail-closed', async () => {
    serviceCatalog.list.mockResolvedValue(fixture());
    settings.loadServiceFilter.mockRejectedValue(new Error('filter unavailable'));
    await expect(loadCatalogServices(4)).rejects.toThrow('filter unavailable');
  });
});
