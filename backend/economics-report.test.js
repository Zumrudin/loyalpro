'use strict';
jest.mock('./services/economics/store', () => ({ loadPeriod: jest.fn() }));
jest.mock('./services/yclients', () => ({ ycGetServiceMeta: jest.fn(), ycGetServiceCatalog: jest.fn() }));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));
const store = require('./services/economics/store');
const yc = require('./services/yclients');
const report = require('./services/economics/report');

const SALON = { id: 1, yclients_company_id: '668791' };
function period() {
  return {
    from: '2026-09-01', to: '2026-09-30',
    records: [{ record_id: 1, visit_date: '2026-09-10', staff_yc_id: 5, staff_name: 'A', seance_length: 3600,
      services: [{ id: 10, title: 'S10', cost_to_pay: 1000, first_cost: 1000 }], bonus_redeemed: 0,
      consumables: [{ good_id: 7, service_id: 10, amount: -2, cost: 90 }], payments: [] }],
    cards: new Map([[3, { id: 3, title: 'C', items: [{ good_id: 8, amount: 1 }], source: 'yclients' }]]),
    links: [{ service_yc_id: 11, staff_yc_id: null, tech_card_id: 3, source: 'learned' }],
    receiptsByGood: new Map([[7, [{ create_date: '2026-09-01T10:00:00Z', amount: 2, cost: 100, operation_unit_type: 2 }]]]),
    catalogByGood: new Map([[7, { unit_equals: 1, unit_actual_cost: 45 }], [8, { unit_actual_cost: 12 }]]),
    overridesByGood: new Map(),
    payRules: [{ id: 1, staff_yc_id: null, service_yc_id: null, category_yc_id: null, percent: 10, base: 'gross', fixed_per_visit: 0, valid_from: null, valid_to: null }],
    settings: { payroll_multiplier: 1, pay_base_includes_bonuses: false, allocation_driver: 'minutes', usn_rate: 15, acquiring: {} },
    fixedCosts: [{ id: 1, category: 'rent', amount_month: 3000, month_from: '2026-01-01', month_to: null }],
    equipment: [], capacityMinutes: 600,
  };
}
beforeEach(() => {
  jest.clearAllMocks(); report.invalidate();
  store.loadPeriod.mockImplementation(async () => period());
  yc.ycGetServiceMeta.mockResolvedValue({ durationByService: new Map([['10', 3600]]) });
  yc.ycGetServiceCatalog.mockResolvedValue({ priced: [{ id: 10, title: 'S10 full', category_id: 100 }, { id: 11, title: 'S11', category_id: 100 }] });
});

test('buildReport: строки, услуги, услуга×сотрудник, сводка; цена по приходу; постоянные за месяц целиком', async () => {
  const r = await report.buildReport(SALON, '2026-09-01', '2026-09-30');
  expect(r.rows).toHaveLength(1);
  expect(r.rows[0].materials_fact).toBe(100);           // 2 × 50 (приход 100/2)
  expect(r.rows[0].doctor_cost).toBe(100);
  expect(r.rows[0].overhead).toBe(3000);
  expect(r.byService[0].key).toBe(10);
  expect(r.byServiceStaff[0].key).toBe('10|5');
  expect(r.summary.rate_minute_fact).toBe(50);
  expect(r.summary.rate_minute_capacity).toBe(5);
  expect(r.summary.coverage.services_without_tech_card).toBe(1);
});
test('кэш 60 с на ключ salon+from+to; invalidate сбрасывает', async () => {
  await report.buildReport(SALON, '2026-09-01', '2026-09-30');
  await report.buildReport(SALON, '2026-09-01', '2026-09-30');
  expect(store.loadPeriod).toHaveBeenCalledTimes(1);
  report.invalidate(1);
  await report.buildReport(SALON, '2026-09-01', '2026-09-30');
  expect(store.loadPeriod).toHaveBeenCalledTimes(2);
});
test('сбой каталога YClients не роняет отчёт (длительности/категории пустые)', async () => {
  yc.ycGetServiceMeta.mockRejectedValue(new Error('429')); yc.ycGetServiceCatalog.mockRejectedValue(new Error('429'));
  const r = await report.buildReport(SALON, '2026-09-01', '2026-09-30');
  expect(r.rows[0].minutes).toBe(60);
  expect(mockLog.warn).toHaveBeenCalled();
});
test('serviceDetail: статьи, по сотрудникам, визиты; неизвестная услуга → null', async () => {
  const d = await report.serviceDetail(SALON, 10, '2026-09-01', '2026-09-30');
  expect(d.service.label).toBe('S10');
  expect(d.byStaff[0].label).toBe('A');
  expect(d.visits[0].record_id).toBe(1);
  expect(await report.serviceDetail(SALON, 999, '2026-09-01', '2026-09-30')).toBeNull();
});
test('coverage: услуги периода с покрытием, техкартой и подсказками по названию', async () => {
  const c = await report.coverage(SALON, '2026-09-01', '2026-09-30');
  expect(c.services).toEqual([expect.objectContaining({ service_yc_id: 10, title: 'S10', visits: 1, consumables_share: 1, tech_card: null, suggestions: [] })]);
  expect(c.cards).toHaveLength(1);
});
test('бонусы: выручка = cost_to_pay; бонус показан как bonus_applied по разрыву до прайса, второй раз не вычитается', async () => {
  store.loadPeriod.mockImplementation(async () => {
    const p = period();
    p.records = [
      { ...p.records[0], record_id: 1, bonus_redeemed: 100, services: [{ id: 10, title: 'S10', cost: 1000, cost_to_pay: 1000, first_cost: 1000 }] },
      { ...p.records[0], record_id: 2, bonus_redeemed: 100, services: [{ id: 10, title: 'S10', cost: 1000, cost_to_pay: 900, first_cost: 1000 }] },
    ];
    return p;
  });
  const d = await report.serviceDetail(SALON, 10, '2026-09-01', '2026-09-30');
  const byId = Object.fromEntries(d.visits.map(v => [v.record_id, v]));
  expect(byId[1]).toEqual(expect.objectContaining({ price: 1000, first_cost: 1000, bonus_redeemed: 100, bonus_applied: 0, revenue: 1000 }));
  expect(byId[2]).toEqual(expect.objectContaining({ price: 900, first_cost: 1000, bonus_redeemed: 100, bonus_applied: 100, discount: 0, revenue: 900 }));
  expect(d.service.revenue).toBe(1900);
  expect(d.service.first_cost).toBe(2000);
});

test('ревью: категория «инд.» услуги (нет в priced) берётся из management-каталога → категорийное правило оплаты матчится', async () => {
  yc.ycGetServiceMeta.mockResolvedValue({ durationByService: new Map([['10', 3600]]), categoryByService: new Map([['10', 200]]) });
  yc.ycGetServiceCatalog.mockResolvedValue({ priced: [] });
  store.loadPeriod.mockImplementation(async () => {
    const p = period();
    p.payRules = [{ id: 7, staff_yc_id: null, service_yc_id: null, category_yc_id: 200, percent: 50, base: 'gross', fixed_per_visit: 0, valid_from: null, valid_to: null }];
    return p;
  });
  const r = await report.buildReport(SALON, '2026-09-01', '2026-09-30');
  expect(r.rows[0].category_yc_id).toBe(200);
  expect(r.rows[0].pay_rule_id).toBe(7);
  expect(r.rows[0].doctor_cost).toBe(500);
});
test('ревью: кэш отчёта ограничен (кап), протухшие вытесняются', async () => {
  for (let i = 0; i < report.CACHE_MAX + 10; i++) await report.buildReport(SALON, '2026-09-01', `2026-09-${String(10 + (i % 20)).padStart(2, '0')}-${i}`);
  expect(report._cacheSize()).toBeLessThanOrEqual(report.CACHE_MAX);
  const now = Date.now();
  const spy = jest.spyOn(Date, 'now').mockReturnValue(now + report.TTL_MS + 1);
  await report.buildReport(SALON, '2026-01-01', '2026-01-31');
  expect(report._cacheSize()).toBe(1);
  spy.mockRestore();
});

describe('второе ревью п.8: отчёт, посчитанный во время мутации, не попадает в кэш', () => {
  test('invalidate посреди buildReport — следующий вызов пересчитывает', async () => {
    let release; const gate = new Promise(r => { release = r; });
    store.loadPeriod.mockImplementationOnce(async () => { await gate; return period(); });
    const p = report.buildReport(SALON, '2026-09-01', '2026-09-30');
    report.invalidate(1);           // мутация пришла, пока отчёт считался
    release(); await p;
    await report.buildReport(SALON, '2026-09-01', '2026-09-30');
    expect(store.loadPeriod).toHaveBeenCalledTimes(2);
  });
  test('без мутации кэш работает как раньше', async () => {
    await report.buildReport(SALON, '2026-09-01', '2026-09-30');
    await report.buildReport(SALON, '2026-09-01', '2026-09-30');
    expect(store.loadPeriod).toHaveBeenCalledTimes(1);
  });
  test('invalidate() без салона тоже отменяет запись идущего расчёта', async () => {
    let release; const gate = new Promise(r => { release = r; });
    store.loadPeriod.mockImplementationOnce(async () => { await gate; return period(); });
    const p = report.buildReport(SALON, '2026-09-01', '2026-09-30');
    report.invalidate();
    release(); await p;
    await report.buildReport(SALON, '2026-09-01', '2026-09-30');
    expect(store.loadPeriod).toHaveBeenCalledTimes(2);
  });
});

describe('payrollCheck', () => {
  const sync = require('./services/economics/sync');
  afterEach(() => jest.restoreAllMocks());
  test('наша оплата по сотрудникам за месяц против salary YClients', async () => {
    jest.spyOn(sync, 'fetchStaffSalary').mockResolvedValue({ salary: 150, working_hours_count: 20 });
    const c = await report.payrollCheck(SALON, '2026-09');
    expect(c.month).toBe('2026-09');
    expect(c.rows).toEqual([expect.objectContaining({ staff_yc_id: 5, staff_name: 'A', our_pay: 100, yc_salary: 150, diff: -50, error: null })]);
    expect(sync.fetchStaffSalary).toHaveBeenCalledWith(SALON, 5, '2026-09-01', '2026-09-30');
  });
  test('YClients не ответил или не отдал salary → «нет данных» (null), а не 0 и не расхождение', async () => {
    jest.spyOn(sync, 'fetchStaffSalary').mockRejectedValue(new Error('429'));
    let c = await report.payrollCheck(SALON, '2026-09');
    expect(c.rows[0]).toEqual(expect.objectContaining({ our_pay: 100, yc_salary: null, diff: null, error: '429' }));
    sync.fetchStaffSalary.mockResolvedValue({ salary: null, working_hours_count: 0 });
    c = await report.payrollCheck(SALON, '2026-09');
    expect(c.rows[0]).toEqual(expect.objectContaining({ yc_salary: null, diff: null }));
  });
  test('фикс за визит берётся один раз на запись (строки calc), а не за каждую услугу', async () => {
    jest.spyOn(sync, 'fetchStaffSalary').mockResolvedValue({ salary: 0, working_hours_count: 0 });
    store.loadPeriod.mockImplementation(async () => {
      const p = period();
      p.records[0].services = [{ id: 10, title: 'S10', cost_to_pay: 1000, first_cost: 1000 }, { id: 11, title: 'S11', cost_to_pay: 1000, first_cost: 1000 }];
      p.payRules = [{ id: 1, staff_yc_id: null, service_yc_id: null, category_yc_id: null, percent: 0, base: 'gross', fixed_per_visit: 300, valid_from: null, valid_to: null }];
      return p;
    });
    const c = await report.payrollCheck(SALON, '2026-09');
    expect(c.rows[0].our_pay).toBe(300);
    expect(c.rows[0].yc_salary).toBe(0);   // честный 0 из YClients — это число, не «нет данных»
    expect(c.rows[0].diff).toBe(300);
  });
});

test('summary.warnings: предупреждения периода в сводке (визит без списаний при норме, товар без цены из списаний)', async () => {
  store.loadPeriod.mockImplementation(async () => {
    const p = period();
    p.records.push({ record_id: 2, visit_date: '2026-09-11', staff_yc_id: 5, staff_name: 'A', seance_length: 1800,
      services: [{ id: 11, title: 'S11', cost_to_pay: 500, first_cost: 500 }], bonus_redeemed: 0, consumables: [], payments: [] });
    p.records[0].consumables.push({ good_id: 99, service_id: 10, amount: -1, cost: 0 });
    p.records[1].visit_date = '2026-09-10';             // в тот же день у записи 1 списания есть
    return p;
  });
  const r = await report.buildReport(SALON, '2026-09-01', '2026-09-30');
  expect(r.summary.warnings).toEqual([
    { type: 'no_consumables', service_yc_id: 11, service_title: 'S11', count: 1, record_ids: [2], last_date: '2026-09-10' },
    { type: 'no_price', good_id: 99, good_title: 'товар 99', visits: 1 },
  ]);
});
