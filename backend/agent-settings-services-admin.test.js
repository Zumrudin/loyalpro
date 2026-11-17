'use strict';

jest.mock('./db', () => ({ db: {
  oneOrNone: jest.fn(), any: jest.fn(), query: jest.fn(), one: jest.fn(),
} }));
jest.mock('./services/service-catalog', () => ({ list: jest.fn() }));
jest.mock('./services/yclients', () => ({
  ycGet: jest.fn(), ycGetServiceCatalog: jest.fn(), ycGetServiceMeta: jest.fn(),
}));

const { db } = require('./db');
const serviceCatalog = require('./services/service-catalog');
const yclients = require('./services/yclients');
const { getServicesForAdmin } = require('./services/agent-settings');

test('getServicesForAdmin builds canonical local tree and keeps external IDs only for visibility rules', async () => {
  db.oneOrNone.mockResolvedValue({ service_mode: 'all' });
  db.any.mockResolvedValue([
    { yc_service_id: 7001, yc_staff_id: null, rule_type: 'deny' },
    { yc_service_id: 7002, yc_staff_id: null, rule_type: 'allow' },
    { yc_service_id: 7003, yc_staff_id: 501, rule_type: 'deny' },
  ]);
  serviceCatalog.list.mockResolvedValue({
    categories: [
      { id: 10, parent_id: null, title: 'Косметология', yclients_id: 900 },
      { id: 11, parent_id: 10, title: 'Инъекции', yclients_id: null },
    ],
    staffMembers: [
      { id: 21, yclients_staff_id: 501, name: 'Анна', is_active: true },
      { id: 22, yclients_staff_id: 502, name: 'Архивный врач', is_active: false },
    ],
    services: [
      { id: 31, yclients_id: 7001, linked: true, title: 'Скрытая правилом', category_id: 11,
        active: true, price_min: 1000, price_max: 1000,
        assignments: [{ staffMemberId: 21 }, { staffMemberId: 22 }] },
      { id: 32, yclients_id: 7002, linked: true, title: 'Архивная услуга', category_id: 10,
        active: false, price_min: 2000, price_max: 2000, assignments: [{ staffMemberId: 21 }] },
      { id: 33, yclients_id: 7003, linked: true, title: 'Активная услуга', category_id: 11,
        active: true, price_min: 3000, price_max: 4000, assignments: [{ staffMemberId: 21 }] },
      { id: 34, yclients_id: 7004, linked: false, title: 'Не связана', category_id: 11,
        active: true, assignments: [{ staffMemberId: 21 }] },
    ],
  });

  const out = await getServicesForAdmin(4);

  expect(out).toEqual(expect.objectContaining({ serviceMode: 'all', source: 'service_catalog' }));
  expect(out.categories).toHaveLength(1);
  expect(out.categories[0]).toEqual(expect.objectContaining({ id: 10, title: 'Косметология' }));
  expect(out.categories[0].subcategories[0]).toEqual(expect.objectContaining({ id: 11, title: 'Инъекции' }));

  const rootService = out.categories[0].services[0];
  expect(rootService).toEqual(expect.objectContaining({ yc_id: 7002, category_id: 10, active: false, visible: false }));
  const nested = out.categories[0].subcategories[0].services;
  expect(nested.map(s => s.yc_id)).toEqual([7001, 7003]);
  expect(nested[0]).toEqual(expect.objectContaining({ yc_id: 7001, category_id: 11, visible: false }));
  expect(nested[0].staff).toEqual([{ yc_id: 501, name: 'Анна', hidden: false }]);
  expect(nested[1]).toEqual(expect.objectContaining({ yc_id: 7003, category_id: 11, visible: true }));
  expect(nested[1].staff).toEqual([{ yc_id: 501, name: 'Анна', hidden: true }]);

  expect(serviceCatalog.list).toHaveBeenCalledWith(4);
  expect(db.oneOrNone).toHaveBeenCalledWith(expect.stringContaining('agent_settings'), [4]);
  expect(db.any).toHaveBeenCalledWith(expect.stringContaining('agent_service_rules'), [4]);
  expect(yclients.ycGet).not.toHaveBeenCalled();
  expect(yclients.ycGetServiceCatalog).not.toHaveBeenCalled();
  expect(yclients.ycGetServiceMeta).not.toHaveBeenCalled();
});
