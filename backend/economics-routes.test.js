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
}));
jest.mock('./services/economics/report', () => ({ buildReport: jest.fn(), serviceDetail: jest.fn(), coverage: jest.fn(), invalidate: jest.fn() }));
jest.mock('./services/economics/sync', () => ({ isRunning: jest.fn(() => false), runNightly: jest.fn(), syncTechCards: jest.fn(), lookupTechCardForService: jest.fn() }));

const store = require('./services/economics/store');
const report = require('./services/economics/report');
const sync = require('./services/economics/sync');
const router = require('./routes/economics');
const { parsePayRule, parseSettings, parsePriceBody, parseManualCard, parsePeriodDays } = router;

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
