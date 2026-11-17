'use strict';
jest.mock('./services/service-catalog', () => ({ list: jest.fn(), journalService: jest.fn(row => row) }));
jest.mock('./services/yclients', () => ({ ycGet: jest.fn() }));
const catalog = require('./services/service-catalog');
const policy = require('./services/service-catalog-policy');
const { ycGet } = require('./services/yclients');
const row = overrides => ({ id: 70, yclients_id: 7, linked: true, assignments_initialized: true,
  title: 'Synthetic service', active: true, duration: 30, priceMin: 500, priceMax: 500,
  staffIds: [55], staffDetails: [{ id: 55, duration: 45, priceMin: 0, priceMax: 0 }], ...overrides });
beforeEach(() => { jest.clearAllMocks(); catalog.list.mockResolvedValue({ services: [row()] }); });
test('read through is tenant scoped and ignores legacy and disconnected identities', async () => {
  catalog.list.mockResolvedValue({ services: [row(), row({ yclients_id: 8, linked: false }), row({ yclients_id: 9, assignments_initialized: false })] });
  const result = await policy.load(42);
  expect(catalog.list).toHaveBeenCalledWith(42);
  expect([...result.keys()]).toEqual(['7']);
  catalog.list.mockResolvedValue({ services: [row({ staffIds: [], staffDetails: [] })] });
  expect(() => policy.pair(result, 7, 55)).not.toThrow();
  const fresh = await policy.load(42);
  expect(() => policy.pair(fresh, 7, 55)).toThrow(/назначена/);
});
test('overlay preserves external IDs and visible pair intersection, free prices and staff durations', async () => {
  const result = policy.overlay([{ yc_id: 7, staff: [{ yc_id: 55, name: 'Synthetic', price_min: 500 }, { yc_id: 56 }], category_path: ['A'] }], await policy.load(1));
  expect(result[0]).toMatchObject({ yc_id: 7, price_min: 0, price_max: 0, duration_min: 30, category_path: ['A'], staff: [{ yc_id: 55, price_min: 0, duration_min: 45 }] });
  expect(policy.overlay([], await policy.load(1))).toEqual([]);
  expect(policy.overlay([{ yc_id: 7, staff: [] }], await policy.load(1))).toEqual([]);
});
test('inactive managed services cannot bypass a missing catalog or be offered', async () => {
  catalog.list.mockResolvedValue({ services: [row({ active: false })] });
  const managed = await policy.load(1);
  expect(() => policy.pair(managed, 7, 55)).toThrow();
  expect(policy.overlay([{ yc_id: 7, staff: [{ yc_id: 55 }] }], managed)).toEqual([]);
  expect(policy.pair(managed, 99, 55)).toBeNull();
});
test('fresh upstream pair validation fails closed and skips uninitialized services', async () => {
  const managed = await policy.load(1), salon = { id: 1, yclients_company_id: 100 };
  ycGet.mockResolvedValue([{ id: 7 }]);
  await policy.verifyExternal(salon, 55, [7], managed);
  expect(ycGet).toHaveBeenCalledWith(salon, '/services/100', { staff_id: 55 });
  ycGet.mockResolvedValue([]);
  await expect(policy.verifyExternal(salon, 55, [7], managed)).rejects.toThrow(/не подтверждено/);
  ycGet.mockRejectedValue(new Error('synthetic failure'));
  await expect(policy.verifyExternal(salon, 55, [7], managed)).rejects.toThrow(/Не удалось/);
  ycGet.mockClear();
  await policy.verifyExternal(salon, 55, [99], managed);
  expect(ycGet).not.toHaveBeenCalled();
});

test('assignment rejection remains an actionable journal 409', async () => {
 const {JournalError}=require('./services/journal/model');
 const managed=await policy.load(1);
 let error;
 try { policy.pair(managed,7,99); } catch(e) { error=e; }
 expect(error).toBeInstanceOf(JournalError);
 expect(error).toMatchObject({status:409,code:'service_assignment'});
});
