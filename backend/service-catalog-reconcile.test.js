'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic' }));
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn() }, pool: { connect: jest.fn() } }));
jest.mock('./services/journal/yclients', () => ({ list: jest.fn() }));
const { db, pool } = require('./db');
const yc = require('./services/journal/yclients');
const catalog = require('./services/service-catalog');
const reconcile = require('./services/service-catalog-reconcile');
const RUN = '11111111-1111-4111-8111-111111111111';
function fixture() {
  return {
    state: { companyId: '30', services: [{ id: 2, version: 1, yclients_id: 7, yclients_company_id: 30, active: true, price_min: '100', price_max: '100', duration: 30, assignments_initialized: false, staff: [{ id: 70 }] }], staff: [{ id: 4, yclients_staff_id: 70, is_active: true }], assignments: [] },
    source: { services: [{ id: 7, duration: 1800, price_min: 100, price_max: 100, staff: [{ id: 70, price: { min: 100, max: 100 }, seance_length: 1800 }] }], staff: [{ id: 70, fired: false }] },
  };
}
let c, state, source, run;
beforeEach(() => {
  jest.restoreAllMocks(); jest.clearAllMocks();
  ({ state, source } = fixture());
  run = { id: RUN, company_id: '30', status: 'preview', snapshot: reconcile.buildSnapshot(state, source) };
  c = { release: jest.fn(), query: jest.fn(async sql => {
    if (sql.includes('FROM service_catalog_sync_runs')) return { rows: [run] };
    if (sql.includes('FROM salons')) return { rows: [{ id: 3, yclients_company_id: 30 }] };
    if (sql.includes('FROM service_catalog WHERE')) return { rows: state.services };
    if (sql.includes('FROM staff_members')) return { rows: state.staff };
    if (sql.includes('FROM service_staff_assignments')) return { rows: state.assignments };
    if (sql.startsWith('UPDATE service_catalog SET')) return { rows: [{ id: 2 }] };
    return { rows: [] };
  }) };
  pool.connect.mockResolvedValue(c);
  db.oneOrNone.mockResolvedValue({ id: 3, yclients_company_id: 30 });
  yc.list.mockImplementation(async (_salon, path) => path.includes('/services/') ? source.services : source.staff);
});
test('preview retains explicit base-equal overrides, free price and seconds-to-minutes', () => {
  let snapshot = reconcile.buildSnapshot(state, source);
  expect(snapshot.canApply).toBe(true);
  expect(snapshot.targets[0].target.assignments).toEqual([{ staffMemberId: 4, priceMin: 100, priceMax: 100, duration: 30 }]);
  source.services[0].staff[0].price = { min: 0, max: 0 };
  source.services[0].staff[0].seance_length = 2700;
  snapshot = reconcile.buildSnapshot(state, source);
  expect(snapshot.targets[0].target.assignments[0]).toMatchObject({ priceMin: 0, priceMax: 0, duration: 45 });
  expect(snapshot.targets[0].before).toMatchObject({ priceMin: 100, assignmentsInitialized: false, staff: [{ id: 70 }] });
});
test('missing overrides inherit independently and an explicit empty assignment list stays empty', () => {
  source.services[0].staff = [{ id: 70, price: { min: 120, max: 140 } }];
  expect(reconcile.buildSnapshot(state, source).targets[0].target.assignments[0]).toMatchObject({ priceMin: 120, priceMax: 140, duration: null });
  source.services[0].staff = [];
  expect(reconcile.buildSnapshot(state, source).targets[0].target.assignments).toEqual([]);
});
test.each([
  s => { delete s.services[0].staff; },
  s => { s.services.push(s.services[0]); },
  s => { s.services[0].company_id = 999; },
])('incomplete source identity fails closed', mutate => {
  mutate(source); expect(() => reconcile.buildSnapshot(state, source)).toThrow('неполный');
});
test.each([
  s => { s.services[0].staff.push({ ...s.services[0].staff[0] }); },
  s => { s.services[0].duration = 1799; },
  s => { s.services[0].staff[0].seance_length = 0; },
  s => { s.services[0].price_min = ''; },
  s => { s.services[0].staff[0].price = { min: 100, max: 50 }; },
])('invalid parameters quarantine the whole service, never a partial assignment target', mutate => {
  mutate(source);
  const snapshot = reconcile.buildSnapshot(state, source);
  expect(snapshot.targets).toEqual([]);
  expect(snapshot.canApply).toBe(false);
  expect(snapshot.exceptions).toContainEqual(expect.objectContaining({ code: 'invalid_service_parameters' }));
});
test('unknown, inactive or foreign staff never become a silent removal', () => {
  state.staff = []; // Only this salon is loaded: a foreign local ID cannot match.
  let snapshot = reconcile.buildSnapshot(state, source);
  expect(snapshot.canApply).toBe(false);
  expect(snapshot.exceptions).toContainEqual(expect.objectContaining({ code: 'unknown_staff', blocking: true }));
  state.staff = [{ id: 4, yclients_staff_id: 70, is_active: false }];
  snapshot = reconcile.buildSnapshot(state, source);
  expect(snapshot.canApply).toBe(true);
  expect(snapshot.exceptions[0].code).toBe('inactive_staff_removed');
  expect(snapshot.targets[0]).toMatchObject({ removedInactiveAssignments: 1, target: { assignments: [] } });
  expect(snapshot.removedInactiveAssignments).toBe(1);
  expect(snapshot.skippedServices).toBe(0);
});
test('missing services and missing imports are blocking, archived services are explicitly reported', () => {
  source.services[0].id = 8;
  let snapshot = reconcile.buildSnapshot(state, source);
  expect(snapshot.exceptions.map(e => e.code)).toEqual(['service_not_imported', 'service_missing_from_source']);
  expect(snapshot.canApply).toBe(false);
  source.services[0].id = 7; source.services[0].archive = true;
  snapshot = reconcile.buildSnapshot(state, source);
  expect(snapshot.exceptions[0]).toMatchObject({ code: 'inactive_service', blocking: false });
  expect(snapshot.targets).toEqual([]);
});
test('fingerprint covers company, versions, staff activation and assignments', () => {
  const original = reconcile.fingerprint(state);
  for (const mutate of [s => { s.companyId = '31'; }, s => { s.services[0].version++; }, s => { s.staff[0].is_active = false; }, s => { s.assignments.push({ service_id: 2, staff_member_id: 4, duration: 60 }); }]) {
    const copy = JSON.parse(JSON.stringify(state)); mutate(copy);
    expect(reconcile.fingerprint(copy)).not.toBe(original);
  }
});
test('preview fetches fresh data and stores immutable before/target without changing catalog', async () => {
  const result = await reconcile.preview(3);
  expect(result.canApply).toBe(true);
  expect(yc.list).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }), '/company/30/services/');
  const insert = c.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO service_catalog_sync_runs'));
  expect(insert[1][1]).toBe(3);
  expect(JSON.parse(insert[1][3]).targets[0]).toHaveProperty('before');
  expect(c.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
  expect(c.query).toHaveBeenCalledWith('COMMIT');
});
test('upstream empty, failure and duplicate identities never save a preview', async () => {
  yc.list.mockResolvedValue([]);
  await expect(reconcile.preview(3)).rejects.toThrow('неполный');
  yc.list.mockRejectedValue(new Error('private upstream error'));
  await expect(reconcile.preview(3)).rejects.toThrow('неполный');
  yc.list.mockResolvedValue([{ id: 1 }, { id: 1 }]);
  await expect(reconcile.preview(3)).rejects.toThrow('неполный');
  expect(pool.connect).not.toHaveBeenCalled();
});
test('apply is tenant locked and scoped, uses saved target and is idempotent', async () => {
  const replace = jest.spyOn(catalog, 'replaceAssignments').mockResolvedValue(undefined);
  await expect(reconcile.apply(3, RUN)).resolves.toMatchObject({ updatedServices: 1, alreadyApplied: false });
  expect(c.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(17292,$1)', [3]);
  expect(replace).toHaveBeenCalledWith(c, 3, 2, run.snapshot.targets[0].target.assignments, { source: 'yclients' });
  expect(c.query).toHaveBeenCalledWith(expect.stringContaining('AND version=$6'), [3, 2, 100, 100, 30, 1]);
  expect(yc.list).not.toHaveBeenCalled();
  run.status = 'applied'; replace.mockClear();
  await expect(reconcile.apply(3, RUN)).resolves.toMatchObject({ alreadyApplied: true, updatedServices: 0 });
  expect(replace).not.toHaveBeenCalled();
});
test('foreign run is not visible and stale local state or exceptions cannot apply', async () => {
  run.snapshot.canApply = false;
  await expect(reconcile.apply(3, RUN)).rejects.toThrow('исключения');
  run.snapshot.canApply = true; state.services[0].version++;
  await expect(reconcile.apply(3, RUN)).rejects.toThrow('изменились');
  run = undefined;
  c.query.mockResolvedValue({ rows: [] });
  await expect(reconcile.apply(4, RUN)).rejects.toThrow('не найдена');
  expect(c.query).toHaveBeenCalledWith(expect.stringContaining('WHERE salon_id=$1 AND id=$2 FOR UPDATE'), [4, RUN]);
});
test('mid-apply assignment failure rolls back, never marks run applied', async () => {
  jest.spyOn(catalog, 'replaceAssignments').mockRejectedValue(new Error('assignment constraint'));
  await expect(reconcile.apply(3, RUN)).rejects.toThrow('assignment constraint');
  expect(c.query).toHaveBeenCalledWith('ROLLBACK');
  expect(c.query).not.toHaveBeenCalledWith('COMMIT');
  expect(c.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE service_catalog_sync_runs'))).toBe(false);
  expect(c.release).toHaveBeenCalled();
});

test('legitimate all-zero source duration is quarantined without changing that service', () => {
  source.services.push({ id: 8, duration: 0, price_min: 100, price_max: 100, staff: [{ id: 70, seance_length: 0 }] });
  state.services.push({ ...state.services[0], id: 3, yclients_id: 8 });
  const snapshot = reconcile.buildSnapshot(state, source);
  expect(snapshot.canApply).toBe(true);
  expect(snapshot.targets.map(t => t.serviceId)).toEqual([2]);
  expect(snapshot.exceptions).toContainEqual({ code: 'zero_duration_service', serviceId: 3, yclientsId: 8, blocking: false });
});

test('fixed-price upstream zero/null maximum normalizes without losing explicit price', () => {
  source.services[0].price_max = 0;
  source.services[0].staff[0].price = { min: 120, max: null };
  const target = reconcile.buildSnapshot(state, source).targets[0].target;
  expect(target).toMatchObject({ priceMin: 100, priceMax: 100 });
  expect(target.assignments[0]).toMatchObject({ priceMin: 120, priceMax: 120 });
});
test('full non-paginated management catalog larger than 200 is read exactly once', async () => {
  source.services = Array.from({ length: 272 }, (_, i) => ({ id: i + 1 }));
  const result = await reconcile.fetchSource({ id: 3, yclients_company_id: 30 });
  expect(result.services).toHaveLength(272);
  expect(yc.list).toHaveBeenCalledTimes(2);
});
test('preview expires after thirty minutes, applied run remains idempotent', async () => {
  run.snapshot.capturedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  await expect(reconcile.apply(3, RUN)).rejects.toThrow('устарела');
  expect(c.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
  run.status = 'applied';
  await expect(reconcile.apply(3, RUN)).resolves.toMatchObject({ alreadyApplied: true });
});
