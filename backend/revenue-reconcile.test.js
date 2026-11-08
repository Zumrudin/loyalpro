'use strict';
// Сверка revenue_operations с YClients: удаляет зависшие операции и (с 28.10.2026)
// дотягивает потерянные. Разбор: записи 2056697734 / 2018785335 / 2066025014 (23.10) —
// YClients показывает оплаты 48 000 / 21 600 / 10 000 ₽, а вебхуки finances_operation
// до нас не дошли; прежняя сверка умела только удалять.

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./db', () => ({ db: { any: jest.fn(), query: jest.fn() } }));
jest.mock('./services/yclients', () => ({ ycGet: jest.fn() }));
jest.mock('./services/revenue', () => ({
  ...jest.requireActual('./services/revenue'),
  recordRevenueOperation: jest.fn(),
}));
jest.mock('./logger', () => ({ createLogger: () => mockLog }));

const { db } = require('./db');
const { ycGet } = require('./services/yclients');
const revenue = require('./services/revenue');
const { reconcileSalon } = require('./services/revenue-reconcile');

const SALON = { id: 1, yclients_company_id: 668791 };
const op = (id, amount, extra = {}) => ({
  id, amount, date: '2026-10-23T14:00:00+0400', record_id: 2056697734,
  expense: { id: 5, title: 'Оказание услуг' }, account: { title: 'Расчетный счет', is_cash: false },
  sold_item_type: 'service', sold_item_id: 9536663, ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  revenue.recordRevenueOperation.mockResolvedValue(true);
});

function setup({ ours = [], yc = [], existing = [] }) {
  db.any.mockImplementation(async (sql) => {
    if (/operation_date=\$2::date/.test(sql)) return ours;
    if (/yclients_operation_id = ANY/.test(sql)) return existing.map(id => ({ yclients_operation_id: String(id) }));
    return [];
  });
  ycGet.mockImplementation(async (_s, _p, q) => (q.page === 1 ? yc : []));
}

describe('reconcileSalon: потерянные операции', () => {
  test('операция есть в YClients, нет у нас → добавляется тем же recordRevenueOperation, source=reconcile', async () => {
    setup({ ours: [{ id: 1, yclients_operation_id: '100', category: 'services', amount: '16000' }], yc: [op(100, 16000), op(200, 48000)] });
    const r = await reconcileSalon(SALON, '2026-10-23', '2026-10-23', { apply: true, rateMs: 0 });
    expect(revenue.recordRevenueOperation).toHaveBeenCalledTimes(1);
    const [payload, salon, source] = revenue.recordRevenueOperation.mock.calls[0];
    expect(payload).toEqual({ status: 'create', data: op(200, 48000) });
    expect(salon).toBe(SALON);
    expect(source).toBe('reconcile');
    expect(r.missing).toHaveLength(1);
    expect(r.added).toBe(1);
    expect(r.stale).toHaveLength(0);
  });
  test('день, где у нас нет НИ ОДНОЙ операции, тоже сверяется (раньше пропускался)', async () => {
    setup({ ours: [], yc: [op(200, 48000)] });
    const r = await reconcileSalon(SALON, '2026-10-23', '2026-10-23', { apply: true, rateMs: 0 });
    expect(ycGet).toHaveBeenCalled();
    expect(r.added).toBe(1);
  });
  test('dry-run: потерянная видна, но не пишется', async () => {
    setup({ ours: [], yc: [op(200, 48000)] });
    const r = await reconcileSalon(SALON, '2026-10-23', '2026-10-23', { apply: false, rateMs: 0 });
    expect(r.missing).toHaveLength(1);
    expect(r.added).toBe(0);
    expect(revenue.recordRevenueOperation).not.toHaveBeenCalled();
  });
  test('не берётся: расход, возврат (amount ≤ 0), уже лежит у нас под другой датой', async () => {
    setup({
      ours: [],
      yc: [op(301, 5000, { expense: { title: 'Закупка материалов' } }), op(302, -500), op(303, 7000)],
      existing: [303],
    });
    const r = await reconcileSalon(SALON, '2026-10-23', '2026-10-23', { apply: true, rateMs: 0 });
    expect(r.missing).toHaveLength(0);
    expect(revenue.recordRevenueOperation).not.toHaveBeenCalled();
  });
  test('московская дата операции ≠ дню выгрузки YClients (пояс +04) → не добавляем, иначе спор с удалением', async () => {
    // 00:30 +04 24.10 = 23:30 мск 23.10: YClients кладёт её в 24.10, мы — в 23.10.
    setup({ ours: [], yc: [op(400, 3000, { date: '2026-10-24T00:30:00+0400' })] });
    const r = await reconcileSalon(SALON, '2026-10-24', '2026-10-24', { apply: true, rateMs: 0 });
    expect(r.missing).toHaveLength(0);
    expect(revenue.recordRevenueOperation).not.toHaveBeenCalled();
  });
  test('ON CONFLICT (вебхук успел раньше) — не считается добавленной', async () => {
    setup({ ours: [], yc: [op(200, 48000)] });
    revenue.recordRevenueOperation.mockResolvedValue(false);
    const r = await reconcileSalon(SALON, '2026-10-23', '2026-10-23', { apply: true, rateMs: 0 });
    expect(r.added).toBe(0);
  });
  test('сбой одной вставки — WARN и дальше, остальные дни сверяются', async () => {
    setup({ ours: [], yc: [op(200, 48000), op(201, 21600)] });
    revenue.recordRevenueOperation.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(true);
    const r = await reconcileSalon(SALON, '2026-10-23', '2026-10-23', { apply: true, rateMs: 0 });
    expect(r.added).toBe(1);
    expect(mockLog.warn).toHaveBeenCalled();
  });
});

describe('reconcileSalon: дату операции сменили в YClients', () => {
  // Дев 26–27.10: у нас op 1788261664 лежала 26.10, в YClients — 27.10. Прежняя сверка
  // удаляла её в 26.10 как зависшую, и операция пропадала насовсем.
  test('удаляется в старом дне и в ту же ночь возвращается под новой датой', async () => {
    let deletedNow = false;
    db.query.mockImplementation(async () => { deletedNow = true; return { rowCount: 1 }; });
    db.any.mockImplementation(async (sql, params) => {
      if (/operation_date=\$2::date/.test(sql)) return params[1] === '2026-10-26' ? [{ id: 9, yclients_operation_id: '500', category: 'certificate', amount: '25000' }] : [];
      if (/yclients_operation_id = ANY/.test(sql)) return deletedNow ? [] : [{ yclients_operation_id: '500' }];
      return [];
    });
    const moved = op(500, 25000, { date: '2026-10-27T12:00:00+0400', expense: { title: 'Продажа сертификатов' }, record_id: 0 });
    ycGet.mockImplementation(async (_s, _p, q) => (q.page === 1 && q.start_date === '2026-10-27' ? [moved] : []));
    const r = await reconcileSalon(SALON, '2026-10-26', '2026-10-27', { apply: true, rateMs: 0 });
    expect(r.deleted).toBe(1);
    expect(r.added).toBe(1);
    expect(r.missing[0]).toMatchObject({ day: '2026-10-27', moved: true });
    expect(revenue.recordRevenueOperation).toHaveBeenCalledWith({ status: 'create', data: moved }, SALON, 'reconcile');
  });
  test('dry-run показывает её и зависшей, и к добавлению — как будет после apply', async () => {
    db.any.mockImplementation(async (sql, params) => {
      if (/operation_date=\$2::date/.test(sql)) return params[1] === '2026-10-26' ? [{ id: 9, yclients_operation_id: '500', category: 'certificate', amount: '25000' }] : [];
      if (/yclients_operation_id = ANY/.test(sql)) return [{ yclients_operation_id: '500' }];
      return [];
    });
    const moved = op(500, 25000, { date: '2026-10-27T12:00:00+0400', expense: { title: 'Продажа сертификатов' } });
    ycGet.mockImplementation(async (_s, _p, q) => (q.page === 1 && q.start_date === '2026-10-27' ? [moved] : []));
    const r = await reconcileSalon(SALON, '2026-10-26', '2026-10-27', { apply: false, rateMs: 0 });
    expect(r.stale).toHaveLength(1);
    expect(r.missing).toHaveLength(1);
    expect(db.query).not.toHaveBeenCalled();
    expect(revenue.recordRevenueOperation).not.toHaveBeenCalled();
  });
});

describe('reconcileSalon: зависшие операции (прежнее поведение)', () => {
  test('у нас есть, в YClients нет → удаляется', async () => {
    setup({ ours: [{ id: 7, yclients_operation_id: '100', category: 'deposit', amount: '671' }], yc: [] });
    const r = await reconcileSalon(SALON, '2026-10-26', '2026-10-26', { apply: true, rateMs: 0 });
    expect(r.deleted).toBe(1);
    expect(db.query).toHaveBeenCalledWith(expect.stringMatching(/DELETE FROM revenue_operations WHERE id=\$1/), [7]);
  });
  test('YClients недоступен → день пропущен целиком: ни удалений, ни добавлений', async () => {
    db.any.mockResolvedValue([{ id: 7, yclients_operation_id: '100', category: 'services', amount: '1' }]);
    ycGet.mockRejectedValue(new Error('timeout'));
    const r = await reconcileSalon(SALON, '2026-10-26', '2026-10-26', { apply: true, rateMs: 0 });
    expect(r.deleted).toBe(0);
    expect(r.added).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });
});
