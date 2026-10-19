'use strict';
// Роутер тянет store → db, report → yclients, логгер, middleware/auth: всё мокаем.
jest.mock('./db', () => ({ db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn(), any: jest.fn() }, pool: {} }));
jest.mock('./services/yclients', () => ({ ycGet: jest.fn(), ycGetServiceMeta: jest.fn(), ycGetServiceCatalog: jest.fn() }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
jest.mock('./middleware/auth', () => ({
  // user подставляет тест через req.__user (JWT здесь не проверяем — это дело middleware/auth)
  auth: (req, res, next) => { req.user = req.__user; next(); },
  requireRole: (...roles) => (req, res, next) => (roles.includes(req.user && req.user.role) ? next() : res.status(403).json({ error: 'Нет доступа' })),
}));
jest.mock('./services/economics/store', () => ({
  listPayRules: jest.fn(), insertPayRule: jest.fn(), updatePayRule: jest.fn(), deletePayRule: jest.fn(),
  getSettings: jest.fn(), saveSettings: jest.fn(), listAccounts: jest.fn(), setPriceOverride: jest.fn(),
  insertManualCard: jest.fn(), updateManualCard: jest.fn(), deleteManualCard: jest.fn(), techCardExists: jest.fn(),
  upsertServiceTechCard: jest.fn(), clearServiceTechCard: jest.fn(), listGoods: jest.fn(), listReceipts: jest.fn(), listTechCards: jest.fn(),
  listFixedCosts: jest.fn(), insertFixedCost: jest.fn(), updateFixedCost: jest.fn(), deleteFixedCost: jest.fn(), copyFixedCosts: jest.fn(),
  listEquipment: jest.fn(), insertEquipment: jest.fn(), updateEquipment: jest.fn(), deleteEquipment: jest.fn(),
  listDictionaryStaff: jest.fn(), listRecentServices: jest.fn(),
}));
jest.mock('./services/economics/report', () => ({ buildReport: jest.fn(), serviceDetail: jest.fn(), coverage: jest.fn(), invalidate: jest.fn() }));
jest.mock('./services/economics/sync', () => ({ isRunning: jest.fn(() => false), runNightly: jest.fn(), syncTechCards: jest.fn(), lookupTechCardForService: jest.fn(),
  runExclusive: jest.fn(async (sid, fn) => fn()) }));

const store = require('./services/economics/store');
const report = require('./services/economics/report');
const sync = require('./services/economics/sync');
const router = require('./routes/economics');
const { parsePayRule, parseSettings, parsePriceBody, parseManualCard, parsePeriodDays, parseFixedCost, parseEquipment, parseMonth } = router;

// Прогон запроса через настоящий router без HTTP.
function call(method, url, { user = { role: 'owner', salonId: 1, userId: 9 }, body, query } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
    };
    const req = { method, url, headers: {}, body, query: query || {}, __user: user };
    router.handle(req, res, () => resolve({ status: 404, body: null }));
  });
}

describe('parsePayRule', () => {
  const ok = { staffYcId: 5, serviceYcId: null, categoryYcId: null, percent: 30, base: 'gross', fixedPerVisit: 0, validFrom: '2026-01-01', validTo: null, note: '' };
  test('валидное тело', () => {
    expect(parsePayRule(ok).value).toEqual({ staff_yc_id: 5, service_yc_id: null, category_yc_id: null, percent: 30, base: 'gross', fixed_per_visit: 0, valid_from: '2026-01-01', valid_to: null, note: '' });
  });
  test('процент 0–100, база из списка, фикс ≥ 0, даты календарные, from ≤ to', () => {
    expect(parsePayRule({ ...ok, percent: 101 }).error).toMatch(/0–100/);
    expect(parsePayRule({ ...ok, percent: 'abc' }).error).toMatch(/0–100/);
    expect(parsePayRule({ ...ok, base: 'net' }).error).toMatch(/база/i);
    expect(parsePayRule({ ...ok, fixedPerVisit: -1 }).error).toMatch(/фикс/i);
    expect(parsePayRule({ ...ok, validFrom: '2026-02-30' }).error).toMatch(/дат/i);
    expect(parsePayRule({ ...ok, validFrom: '2026-05-01', validTo: '2026-04-01' }).error).toMatch(/период/i);
    expect(parsePayRule({ ...ok, serviceYcId: 10, categoryYcId: 100 }).error).toMatch(/услуг.*категори|категори.*услуг/i);
    expect(parsePayRule({ ...ok, staffYcId: 'x' }).error).toMatch(/целы/i);
    expect(parsePayRule({ ...ok, staffYcId: 1.5 }).error).toMatch(/целы/i);
  });
});

describe('parseSettings', () => {
  test('множитель 1–3, драйвер из списка, УСН 0–50, эквайринг {касса: 0–10}', () => {
    const r = parseSettings({ payrollMultiplier: 1.494, payBaseIncludesBonuses: true, allocationDriver: 'visits', usnRate: 15, acquiring: { 'Расчетный счет': 1.5, 'Основная касса': 0 } });
    expect(r.value).toEqual({ payroll_multiplier: 1.494, pay_base_includes_bonuses: true, allocation_driver: 'visits', usn_rate: 15, acquiring: { 'Расчетный счет': 1.5, 'Основная касса': 0 } });
    expect(parseSettings({ payrollMultiplier: 0.5, allocationDriver: 'minutes' }).error).toBeTruthy();
    expect(parseSettings({ payrollMultiplier: 1.3, allocationDriver: 'revenue' }).error).toBeTruthy();
    expect(parseSettings({ payrollMultiplier: 1.3, allocationDriver: 'minutes', usnRate: 15, acquiring: { X: 11 } }).error).toBeTruthy();
    expect(parseSettings({ payrollMultiplier: 1.3, allocationDriver: 'minutes', usnRate: 15, acquiring: [] }).error).toBeTruthy();
    expect(parseSettings({ payrollMultiplier: 1.3, allocationDriver: 'minutes', usnRate: 60 }).error).toBeTruthy();
    expect(parseSettings({ payrollMultiplier: 1.3, allocationDriver: 'minutes', usnRate: null }).error).toBeTruthy();
  });
});

describe('parsePriceBody / parseManualCard / parsePeriodDays', () => {
  test('цена: число > 0 или null (снять)', () => {
    expect(parsePriceBody({ unitPrice: '12.5' }).value).toBe(12.5);
    expect(parsePriceBody({ unitPrice: null }).value).toBeNull();
    expect(parsePriceBody({ unitPrice: -1 }).error).toBeTruthy();
    expect(parsePriceBody({}).error).toBeTruthy();
  });
  test('ручная норма: название и ≥1 позиция с целым good_id и amount > 0', () => {
    expect(parseManualCard({ title: 'Норма', items: [{ goodId: 7, amount: 2, unit: 'мл' }] }).value).toEqual({ title: 'Норма', items: [{ good_id: 7, amount: 2, unit: 'мл', price_at_sync: null, title: null }] });
    expect(parseManualCard({ title: '', items: [] }).error).toBeTruthy();
    expect(parseManualCard({ title: 'X', items: [{ goodId: 'a', amount: 1 }] }).error).toBeTruthy();
    expect(parseManualCard({ title: 'X', items: [{ goodId: 1, amount: 0 }] }).error).toBeTruthy();
  });
  test('период ≤ 731 дня', () => {
    expect(parsePeriodDays('2026-01-01', '2026-01-31')).toBe(31);
    expect(parsePeriodDays('2024-01-01', '2026-12-31')).toBeGreaterThan(731);
  });
});

describe('роутер без HTTP', () => {
  beforeEach(() => { jest.clearAllMocks(); sync.isRunning.mockReturnValue(false); });

  test('не-owner (admin) получает 403 на любой ручке, store не вызывается', async () => {
    const r = await call('GET', '/pay-rules', { user: { role: 'admin', salonId: 1 } });
    expect(r.status).toBe(403);
    expect(store.listPayRules).not.toHaveBeenCalled();
  });

  test('owner: список правил идёт со salonId из токена', async () => {
    store.listPayRules.mockResolvedValue([{ id: 1 }]);
    const r = await call('GET', '/pay-rules');
    expect(r.status).toBe(200);
    expect(store.listPayRules).toHaveBeenCalledWith(1);
  });

  test('PUT /settings с мусором — 400, ничего не пишется и кэш не сбрасывается', async () => {
    const r = await call('PUT', '/settings', { body: { payrollMultiplier: 9, allocationDriver: 'minutes' } });
    expect(r.status).toBe(400);
    expect(store.saveSettings).not.toHaveBeenCalled();
    expect(report.invalidate).not.toHaveBeenCalled();
  });

  test('PUT /settings валидный — пишет и сбрасывает кэш отчёта', async () => {
    store.saveSettings.mockResolvedValue();
    const r = await call('PUT', '/settings', { body: { payrollMultiplier: 1.3, allocationDriver: 'minutes' } });
    expect(r.status).toBe(200);
    expect(store.saveSettings).toHaveBeenCalledWith(1, expect.objectContaining({ payroll_multiplier: 1.3 }));
    expect(report.invalidate).toHaveBeenCalledWith(1);
  });

  test('POST /pay-rules создаёт и сбрасывает кэш; удаление чужого id — 404 без сброса', async () => {
    store.insertPayRule.mockResolvedValue(7);
    const body = { staffYcId: 5, percent: 30, base: 'gross' };
    const r = await call('POST', '/pay-rules', { body });
    expect(r).toEqual({ status: 200, body: { id: 7 } });
    expect(report.invalidate).toHaveBeenCalledWith(1);
    report.invalidate.mockClear();
    store.deletePayRule.mockResolvedValue(false);
    const d = await call('DELETE', '/pay-rules/99');
    expect(d.status).toBe(404);
    expect(store.deletePayRule).toHaveBeenCalledWith(1, 99);
    expect(report.invalidate).not.toHaveBeenCalled();
  });

  test('нечисловой :id не попадает в обработчик (404)', async () => {
    const r = await call('DELETE', '/pay-rules/abc');
    expect(r.status).toBe(404);
    expect(store.deletePayRule).not.toHaveBeenCalled();
  });

  test('/services: период больше 731 дня — 400, отчёт не строится', async () => {
    const r = await call('GET', '/services', { query: { from: '2024-01-01', to: '2026-12-31' } });
    expect(r.status).toBe(400);
    expect(report.buildReport).not.toHaveBeenCalled();
  });

  test('привязка техкарты: чужая/несуществующая карта — 400; manual-источник при успехе', async () => {
    store.techCardExists.mockResolvedValue(false);
    expect((await call('PUT', '/services/10/tech-card', { body: { techCardId: 5 } })).status).toBe(400);
    store.techCardExists.mockResolvedValue(true);
    const r = await call('PUT', '/services/10/tech-card', { body: { techCardId: 5, staffYcId: 3 } });
    expect(r.status).toBe(200);
    expect(store.upsertServiceTechCard).toHaveBeenCalledWith(1, { serviceYcId: 10, staffYcId: 3, techCardId: 5, source: 'manual' });
    expect(report.invalidate).toHaveBeenCalledWith(1);
  });

  test('PUT /goods/:id/price: невалидная цена — 400; null снимает', async () => {
    expect((await call('PUT', '/goods/7/price', { body: { unitPrice: -5 } })).status).toBe(400);
    const r = await call('PUT', '/goods/7/price', { body: { unitPrice: null } });
    expect(r.status).toBe(200);
    expect(store.setPriceOverride).toHaveBeenCalledWith(1, 7, null, undefined, 9);
  });

  test('POST /sync: идёт другой прогон — 409', async () => {
    sync.isRunning.mockReturnValue(true);
    expect((await call('POST', '/sync')).status).toBe(409);
    expect(sync.runNightly).not.toHaveBeenCalled();
  });
});

describe('parseFixedCost', () => {
  test('категория из списка, сумма ≥ 0, месяцы YYYY-MM → первое число', () => {
    expect(parseFixedCost({ category: 'rent', title: 'Аренда', amountMonth: 300000, monthFrom: '2026-01', monthTo: null }).value)
      .toEqual({ category: 'rent', title: 'Аренда', amount_month: 300000, month_from: '2026-01-01', month_to: null, note: '' });
    expect(parseFixedCost({ category: 'x', amountMonth: 1, monthFrom: '2026-01' }).error).toMatch(/категори/i);
    expect(parseFixedCost({ category: 'rent', amountMonth: -1, monthFrom: '2026-01' }).error).toMatch(/сумм/i);
    expect(parseFixedCost({ category: 'rent', amountMonth: '', monthFrom: '2026-01' }).error).toMatch(/сумм/i);
    expect(parseFixedCost({ category: 'rent', amountMonth: 1, monthFrom: '2026-13' }).error).toMatch(/месяц/i);
    expect(parseFixedCost({ category: 'rent', amountMonth: 1, monthFrom: '2026-05', monthTo: '2026-04' }).error).toMatch(/период/i);
  });
});
describe('parseEquipment', () => {
  test('название, цена ≥ 0, срок 1–240, остаточная 0–100, ТО ≥ 0, service_ids — целые', () => {
    expect(parseEquipment({ name: 'Lumecca', purchasePrice: 5050000, purchaseDate: '2025-01-15', usefulLifeMonths: 60, residualPct: 10, maintenanceMonthly: 20000, serviceIds: [1, '2'], isActive: true }).value)
      .toEqual({ name: 'Lumecca', purchase_price: 5050000, purchase_date: '2025-01-15', useful_life_months: 60, residual_pct: 10, maintenance_monthly: 20000, service_ids: [1, 2], is_active: true, note: '' });
    expect(parseEquipment({ name: '', purchasePrice: 1 }).error).toBeTruthy();
    expect(parseEquipment({ name: 'X', purchasePrice: 1, usefulLifeMonths: 0 }).error).toBeTruthy();
    expect(parseEquipment({ name: 'X', purchasePrice: 1, serviceIds: ['a'] }).error).toBeTruthy();
    expect(parseEquipment({ name: 'X', purchasePrice: 1, purchaseDate: '2025-02-30' }).error).toBeTruthy();
    expect(parseEquipment({ name: 'X', purchasePrice: '' }).error).toBeTruthy();
  });
});
test('parseMonth', () => { expect(parseMonth('2026-09')).toBe('2026-09-01'); expect(parseMonth('2026-9')).toBeNull(); });

describe('fixed-costs / equipment ручки', () => {
  beforeEach(() => jest.clearAllMocks());
  const fc = { category: 'rent', amountMonth: 100, monthFrom: '2026-01' };
  test('не владелец — 403', async () => {
    expect((await call('GET', '/fixed-costs', { user: { role: 'admin', salonId: 1 } })).status).toBe(403);
    expect((await call('GET', '/equipment', { user: { role: 'admin', salonId: 1 } })).status).toBe(403);
  });
  test('POST fixed-costs: 400 на мусор, 200 + invalidate', async () => {
    expect((await call('POST', '/fixed-costs', { body: { category: 'zzz' } })).status).toBe(400);
    store.insertFixedCost.mockResolvedValue(7);
    const r = await call('POST', '/fixed-costs', { body: fc });
    expect(r.body).toEqual({ id: 7 });
    expect(store.insertFixedCost.mock.calls[0][0]).toBe(1);
    expect(report.invalidate).toHaveBeenCalledWith(1);
  });
  test('PUT/DELETE: 404 если нет строки; нецифровой id не матчится', async () => {
    store.updateFixedCost.mockResolvedValue(false);
    expect((await call('PUT', '/fixed-costs/5', { body: fc })).status).toBe(404);
    store.deleteFixedCost.mockResolvedValue(true);
    expect((await call('DELETE', '/fixed-costs/5')).status).toBe(200);
    expect((await call('DELETE', '/fixed-costs/abc')).status).toBe(404);
    expect(store.deleteFixedCost).toHaveBeenCalledWith(1, 5);
  });
  test('POST /fixed-costs/copy: статический путь, from/to обязательны', async () => {
    expect((await call('POST', '/fixed-costs/copy', { query: { from: '2026-09' } })).status).toBe(400);
    store.copyFixedCosts.mockResolvedValue(3);
    const r = await call('POST', '/fixed-costs/copy', { query: { from: '2026-09', to: '2026-10' } });
    expect(r.body).toEqual({ copied: 3 });
    expect(store.copyFixedCosts).toHaveBeenCalledWith(1, '2026-09-01', '2026-10-01');
  });
  test('GET /equipment: добавляет monthly; /equipment/seed — до :id', async () => {
    store.listEquipment.mockResolvedValue([{ id: 1, purchase_price: 6000, residual_pct: 0, useful_life_months: 60, maintenance_monthly: 10 }]);
    const r = await call('GET', '/equipment');
    expect(r.body.rows[0].monthly).toEqual({ depreciation: 100, maintenance: 10, total: 110 });
    const s = await call('GET', '/equipment/seed');
    expect(s.body.seed.length).toBe(10);
  });
  test('POST equipment: 400 / 200', async () => {
    expect((await call('POST', '/equipment', { body: { name: '' } })).status).toBe(400);
    store.insertEquipment.mockResolvedValue(2);
    expect((await call('POST', '/equipment', { body: { name: 'A', purchasePrice: 10 } })).body).toEqual({ id: 2 });
  });
});

describe('второе ревью', () => {
  const { db } = require('./db');
  const yc = require('./services/yclients');
  beforeEach(() => { jest.clearAllMocks(); sync.isRunning.mockReturnValue(false); db.oneOrNone.mockResolvedValue({ id: 1, yclients_company_id: '1' }); });

  test('п.1: огромный period — 400 на /services, /services/:id, /coverage (без падения процесса)', async () => {
    for (const url of ['/services', '/services/10', '/coverage']) {
      const r = await call('GET', url, { query: { period: '99999999999999999' } });
      expect(r.status).toBe(400);
    }
    expect(report.buildReport).not.toHaveBeenCalled();
    expect(report.serviceDetail).not.toHaveBeenCalled();
    expect(report.coverage).not.toHaveBeenCalled();
  });
  test('п.10: экономика принимает period=day (значение дашборда)', async () => {
    report.buildReport.mockResolvedValue({ byService: [], byServiceStaff: [], summary: {}, settings: {} });
    const r = await call('GET', '/services', { query: { period: 'day' } });
    expect(r.status).toBe(200);
    expect(r.body.from).toBe(r.body.to);
  });
  test('п.2: копирование месяца в самого себя — 400, store не зовётся', async () => {
    const r = await call('POST', '/fixed-costs/copy', { query: { from: '2026-10', to: '2026-10' } });
    expect(r.status).toBe(400);
    expect(store.copyFixedCosts).not.toHaveBeenCalled();
  });
  test('п.4: импорт техкарт идёт под общей занятостью салона; занято — 409', async () => {
    sync.syncTechCards.mockResolvedValue({ cards: 3 });
    const ok = await call('POST', '/tech-cards/sync');
    expect(ok.status).toBe(200);
    expect(sync.runExclusive).toHaveBeenCalledWith(1, expect.any(Function));
    sync.runExclusive.mockRejectedValueOnce(Object.assign(new Error('синк уже идёт'), { code: 'BUSY' }));
    const busy = await call('POST', '/tech-cards/sync');
    expect(busy.status).toBe(409);
  });
  test('п.6: отвязка — явный DELETE, снимает только ручную; ответ говорит, было ли что снимать', async () => {
    store.clearServiceTechCard.mockResolvedValueOnce(1);
    const r = await call('DELETE', '/services/10/tech-card', { query: { staffYcId: '3' } });
    expect(r).toEqual({ status: 200, body: { ok: true, removed: 1 } });
    expect(store.clearServiceTechCard).toHaveBeenCalledWith(1, 10, 3);
    expect(report.invalidate).toHaveBeenCalledWith(1);
    store.clearServiceTechCard.mockResolvedValueOnce(0);
    report.invalidate.mockClear();
    const n = await call('DELETE', '/services/10/tech-card');
    expect(n.body).toEqual({ ok: true, removed: 0 });
    expect(store.clearServiceTechCard).toHaveBeenLastCalledWith(1, 10, null);
    expect(report.invalidate).not.toHaveBeenCalled();
  });
  test('п.6: PUT без techCardId больше ничего не удаляет — 400', async () => {
    const r = await call('PUT', '/services/10/tech-card', { body: { techCardId: null } });
    expect(r.status).toBe(400);
    expect(store.clearServiceTechCard).not.toHaveBeenCalled();
  });
  test('п.7/9: /dictionaries — management-каталог + staff салона + услуги из записей; сбой YClients → degraded', async () => {
    yc.ycGetServiceMeta.mockResolvedValue({ titleByService: new Map([['10', 'Чистка'], ['11', 'Пилинг']]), categoryByService: new Map([['10', 100], ['11', 101]]) });
    yc.ycGetServiceCatalog.mockResolvedValue({ priced: [], categories: [{ id: 100, title: 'Косметология' }] });
    store.listDictionaryStaff.mockResolvedValue([{ id: 5, name: 'Юлия', is_active: true }]);
    store.listRecentServices.mockResolvedValue([{ id: 12, title: 'Старая услуга', category_id: null }, { id: 10, title: 'дубль', category_id: 100 }]);
    const r = await call('GET', '/dictionaries');
    expect(r.status).toBe(200);
    expect(r.body.degraded).toBe(false);
    expect(store.listDictionaryStaff).toHaveBeenCalledWith(1);
    expect(store.listRecentServices).toHaveBeenCalledWith(1);
    expect(r.body.services.map(s => s.id)).toEqual(expect.arrayContaining([10, 11, 12]));
    expect(r.body.services.find(s => s.id === 10).title).toBe('Чистка');
    expect(r.body.categories.map(c => c.id).sort()).toEqual([100, 101]);
    expect(r.body.staff).toEqual([{ id: 5, name: 'Юлия', is_active: true }]);

    yc.ycGetServiceMeta.mockResolvedValue({ titleByService: new Map(), categoryByService: new Map() });
    yc.ycGetServiceCatalog.mockResolvedValue({ priced: [], categories: [] });
    const d = await call('GET', '/dictionaries');
    expect(d.status).toBe(200);
    expect(d.body.degraded).toBe(true);
    expect(d.body.services.map(s => s.id).sort()).toEqual([10, 12]); // из записей — остаются
  });
});

test('второе ревью: невозможная дата в правиле оплаты — 400, а не RangeError', () => {
  expect(parsePayRule({ staffYcId: 5, percent: 30, base: 'gross', validFrom: '9999-99-99' }).error).toMatch(/дат/i);
  expect(parseEquipment({ name: 'A', purchasePrice: 1, purchaseDate: '2026-13-45' }).error).toMatch(/дат/i);
});
