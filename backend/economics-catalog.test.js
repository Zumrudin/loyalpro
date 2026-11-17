'use strict';
jest.mock('./db', () => ({ db: { any: jest.fn() } }));
const { db } = require('./db');
const { loadCatalog } = require('./services/economics/catalog');
beforeEach(() => jest.clearAllMocks());
test('settings titles/duration/category map to external accounting IDs, never local IDs', async () => {
  db.any.mockResolvedValue([
    { id: 10, economics_yc_id: '900', linked_yclients_id: '800', title: 'Edited locally', duration: 45, external_category_id: '700', category_title: 'Local category name', active: true },
    { id: 900, linked_yclients_id: '801', title: 'Other service', duration: 30, external_category_id: null, active: false },
    { id: 801, title: 'Internal service', duration: 20, active: true },
  ]);
  const result = await loadCatalog(12);
  expect(db.any).toHaveBeenCalledWith(expect.stringContaining('WHERE c.salon_id=$1'), [12]);
  const sql = db.any.mock.calls[0][0];
  expect(sql).toContain('g.salon_id=c.salon_id');
  expect(sql).toContain('g.yclients_company_id::text=s.yclients_company_id::text');
  expect(sql).toContain('c.yclients_company_id IS NULL OR c.yclients_company_id::text=s.yclients_company_id::text');
  expect([...result.meta.titleByService]).toEqual([['900', 'Edited locally'], ['801', 'Other service']]);
  expect(result.meta.durationByService.get('900')).toBe(2700);
  expect(result.meta.categoryByService.get('801')).toBeNull();
  expect(result.catalog.categories).toEqual([{ id: 700, title: 'Local category name' }]);
  expect(result.unlinkedServices).toEqual([{ local_id: 801, title: 'Internal service', active: true }]);
});
test('duplicate accounting mapping fails explicitly rather than arbitrary payroll category', async () => {
  db.any.mockResolvedValue([{ id: 1, economics_yc_id: 88 }, { id: 2, linked_yclients_id: 88 }]);
  await expect(loadCatalog(1)).rejects.toThrow('Несколько услуг');
});
test('empty local catalog remains empty without loading upstream fallback', async () => {
  db.any.mockResolvedValue([]);
  const result = await loadCatalog(2);
  expect(result.meta.titleByService.size).toBe(0);
  expect(result.unlinkedServices).toEqual([]);
});
