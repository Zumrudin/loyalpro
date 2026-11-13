'use strict';
// Хвост runSync вынесен в функции, потому что теперь их зовут ДВА потребителя:
// ручной полный синк и ночная сверка (services/yclients-reconcile.js). Второй
// экземпляр SQL молча разъехался бы с первым. Плюс ретрай страницы /records:
// YClients режет лимит на 11–15-й странице через ~13 с, а сообщение «через 0
// секунд» врёт — лимит минутный, ждать надо ≥60 с (47 падений на проде подряд).

jest.mock('./db', () => ({
  db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn(), any: jest.fn(), many: jest.fn() },
  pool: { connect: jest.fn() },
}));
jest.mock('./services/yclients', () => ({
  ycGet: jest.fn(), ycPost: jest.fn(), ycGetClientCards: jest.fn(),
  ycGetClientCardsStrict: jest.fn(), ycAccrueCard: jest.fn(),
}));
jest.mock('./logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { db } = require('./db');
const { ycGet, ycPost } = require('./services/yclients');
const loyalty = require('./services/loyalty');
const { upsertRecordFromYc, refreshLastVisitAt, linkCardTransactionsToRecords, runSync,
        RECORDS_LIMIT_WAIT_MS } = loyalty;

const YCR = {
  id: 1988724006, date: '2026-09-24 17:00:00', attendance: 1, paid_full: 1, cost: 6500,
  services: [{ id: 1, cost: 6500, cost_to_pay: 6500 }], staff: { id: 7, name: 'Юлия' },
  client: { id: 352092609 }, goods_transactions: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('upsertRecordFromYc', () => {
  test('записи нет → INSERT с source и статусом, возвращает {id, inserted:true}', async () => {
    db.oneOrNone.mockResolvedValue(null);
    db.one.mockResolvedValue({ id: 55 });
    const r = await upsertRecordFromYc(1, YCR, 3777, 'reconcile');
    expect(r).toEqual({ id: 55, inserted: true, status: 'arrived', prev: null });
    const [sql, params] = db.one.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO records/);
    expect(params[0]).toBe(1);            // salon_id
    expect(params[1]).toBe(1988724006);   // yclients_record_id
    expect(params[2]).toBe(3777);         // client_id
    expect(params).toContain('reconcile');
    expect(params).toContain('arrived');
  });

  test('запись есть → UPDATE по id, возвращает прежнюю строку в prev', async () => {
    db.oneOrNone.mockResolvedValue({ id: 55, status: 'confirmed', bonus_processed: false });
    const r = await upsertRecordFromYc(1, YCR, 3777, 'sync');
    expect(r).toEqual({ id: 55, inserted: false, status: 'arrived', prev: { id: 55, status: 'confirmed', bonus_processed: false } });
    const upd = db.query.mock.calls.find(c => /UPDATE records SET status/.test(c[0]));
    expect(upd).toBeTruthy();
    expect(upd[1]).toContain(55);
    expect(upd[1]).toContain(3777);
    expect(db.one).not.toHaveBeenCalled();
  });

  test('клиент неизвестен → client_id NULL, а yclients_client_id из записи', async () => {
    db.oneOrNone.mockResolvedValue(null);
    db.one.mockResolvedValue({ id: 56 });
    await upsertRecordFromYc(1, YCR, null, 'sync');
    const [, params] = db.one.mock.calls[0];
    expect(params[2]).toBeNull();
    expect(params[3]).toBe(352092609);
  });
});

describe('technical_break_duration: вебхуки YClients его не несут (13.11.2026)', () => {
  const stored = (v) => db.oneOrNone.mockResolvedValue({ id: 55, status: 'confirmed', bonus_processed: false, prev_break: v });
  const savedPayload = () => JSON.parse(db.query.mock.calls.find(c => /UPDATE records SET status/.test(c[0]))[1][1]);
  test('payload без поля поверх строки с 600 → в БД остаётся 600', async () => {
    stored(600);
    const r = await upsertRecordFromYc(1, YCR, null, 'webhook');
    expect(savedPayload().technical_break_duration).toBe(600);
    expect(r.prev).toEqual({ id: 55, status: 'confirmed', bonus_processed: false });
  });
  test('payload с null поверх 600 → 600', async () => {
    stored(600);
    await upsertRecordFromYc(1, { ...YCR, technical_break_duration: null }, null, 'webhook');
    expect(savedPayload().technical_break_duration).toBe(600);
  });
  test('явное значение побеждает: 0 поверх 600 → 0', async () => {
    stored(600);
    await upsertRecordFromYc(1, { ...YCR, technical_break_duration: 0 }, null, 'journal');
    expect(savedPayload().technical_break_duration).toBe(0);
  });
  test('у сохранённой строки поля нет → payload как есть, без ключа', async () => {
    stored(null);
    await upsertRecordFromYc(1, YCR, null, 'webhook');
    expect(savedPayload()).not.toHaveProperty('technical_break_duration');
  });
  test('новая строка без поля → INSERT без перерыва (null)', async () => {
    db.oneOrNone.mockResolvedValue(null);
    db.one.mockResolvedValue({ id: 56 });
    await upsertRecordFromYc(1, YCR, null, 'webhook');
    const payload = JSON.parse(db.one.mock.calls[0][1][11]);
    expect(payload.technical_break_duration ?? null).toBeNull();
  });
  test('keepTechnicalBreak — чистая функция, входной объект не мутирует', () => {
    const inc = { id: 1 };
    expect(loyalty.keepTechnicalBreak(inc, 600)).toEqual({ id: 1, technical_break_duration: 600 });
    expect(inc).toEqual({ id: 1 });
    expect(loyalty.keepTechnicalBreak({ id: 1, technical_break_duration: 300 }, 600).technical_break_duration).toBe(300);
    expect(loyalty.keepTechnicalBreak({ id: 1 }, null)).toEqual({ id: 1 });
    expect(loyalty.keepTechnicalBreak({ id: 1 }, '600').technical_break_duration).toBe(600);
  });
});

describe('связь записи с клиентом при UPDATE (ревью 13.11.2026)', () => {
  const upd = () => db.query.mock.calls.find(c => /UPDATE records SET status/.test(c[0]));
  const stored = { id: 55, status: 'confirmed', bonus_processed: false, client_id: 10, prev_break: null };
  test('смена клиента: yclients_client_id из payload, client_id — переданный вызывающим', async () => {
    db.oneOrNone.mockResolvedValueOnce(stored);
    await upsertRecordFromYc(1, YCR, 3777, 'journal');
    const [sql, params] = upd();
    expect(sql).toMatch(/yclients_client_id=COALESCE\(\$\d+, yclients_client_id\)/);
    expect(params).toContain(352092609);
    expect(params).toContain(3777);
  });
  test('вызывающий клиента не знает → резолв по yclients_client_id', async () => {
    db.oneOrNone.mockImplementation(async (sql) => /FROM records/.test(sql) ? stored
      : /yclients_client_id=\$2/.test(sql) ? { id: 4242 } : null);
    await upsertRecordFromYc(1, YCR, null, 'webhook');
    expect(upd()[1]).toContain(4242);
  });
  test('по yclients_client_id не нашли → по телефону (ровно один клиент)', async () => {
    db.oneOrNone.mockImplementation(async (sql) => /FROM records/.test(sql) ? stored : null);
    db.any.mockImplementation(async (sql, p) => /FROM clients/.test(sql) && p[1] === '9200255591' ? [{ id: 777 }] : []);
    await upsertRecordFromYc(1, { ...YCR, client: { id: 352092609, phone: '+7 (920) 025-55-91' } }, null, 'webhook');
    expect(upd()[1]).toContain(777);
  });
  test('по телефону двое или никого → client_id не затирается (NULL в COALESCE)', async () => {
    db.oneOrNone.mockImplementation(async (sql) => /FROM records/.test(sql) ? stored : null);
    db.any.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    await upsertRecordFromYc(1, { ...YCR, client: { id: 352092609, phone: '79200255591' } }, null, 'webhook');
    const [sql, params] = upd();
    expect(sql).toMatch(/client_id=COALESCE\(\$8, client_id\)/);
    expect(params[7]).toBeNull();
  });
});

describe('хвостовые SQL', () => {
  test('refreshLastVisitAt — один UPDATE clients … FROM records по salon_id', async () => {
    await refreshLastVisitAt(1);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE clients c\s+SET last_visit_at/);
    expect(sql).toMatch(/FROM\s+records/);
    expect(params).toEqual([1]);
  });

  test('linkCardTransactionsToRecords — привязка record_id по client_id', async () => {
    await linkCardTransactionsToRecords(3777);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE loyalty_card_transactions lct/);
    expect(sql).toMatch(/record_id\s+IS NULL/);
    expect(params).toEqual([3777]);
  });
});

describe('runSync: страница /records на лимите', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    db.one.mockResolvedValue({ id: 900 });          // sync_logs INSERT
    db.oneOrNone.mockResolvedValue({ levels: [{ key: 'bronze', minSpent: 0, cashback: 5 }] });
    ycPost.mockResolvedValue([]);                    // Step 2: клиентов нет
  });
  afterEach(() => jest.useRealTimers());

  test('«Превышен лимит» → ждём RECORDS_LIMIT_WAIT_MS (60 с) и повторяем ту же страницу', async () => {
    ycGet
      .mockRejectedValueOnce(new Error('Превышен лимит запросов, попробуйте повторить запрос через 0 секунд.'))
      .mockResolvedValueOnce([]);
    const salon = { id: 1, yclients_company_id: '668791' };
    const p = runSync(salon, 'manual', 1);
    await jest.advanceTimersByTimeAsync(RECORDS_LIMIT_WAIT_MS - 1000);
    expect(ycGet).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5000);
    const res = await p;
    expect(res.ok).toBe(true);
    expect(ycGet).toHaveBeenCalledTimes(2);
    expect(ycGet.mock.calls[1][2].page).toBe(1);
    expect(RECORDS_LIMIT_WAIT_MS).toBeGreaterThanOrEqual(60_000);
  });

  test('сетевая ошибка → прежняя короткая пауза (3 с), не минута', async () => {
    ycGet.mockRejectedValueOnce(new Error('socket hang up')).mockResolvedValueOnce([]);
    const p = runSync({ id: 1, yclients_company_id: '668791' }, 'manual', 1);
    await jest.advanceTimersByTimeAsync(3500);
    expect(ycGet).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(5000);
    await p;
  });
});
