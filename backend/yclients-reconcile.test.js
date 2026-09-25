'use strict';
// Ночная сверка с YClients вместо полного runSync каждые 3 часа (спека
// docs/superpowers/specs/2026-09-25-yclients-sync-replacement-design.md).
// Записи за 2 дня по changed_after → активные клиенты → карточка/карта/баланс →
// last_visit_at и record_id транзакций → строка sync_logs. Кэшбэк отсюда НЕ
// начисляется: деньги — только вебхук-путь; потерянный вебхук даёт WARN.

jest.mock('./db', () => ({
  db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn(), any: jest.fn(), many: jest.fn() },
  pool: {},
}));
jest.mock('./services/yclients', () => ({
  ycGet: jest.fn(), ycPost: jest.fn(), ycGetClientCards: jest.fn(),
  ycGetClientCardsStrict: jest.fn(), ycAccrueCard: jest.fn(),
}));
jest.mock('./services/loyalty', () => ({
  getLoyaltySettings: jest.fn(), getLevel: jest.fn(() => ({ key: 'bronze' })),
  upsertRecordFromYc: jest.fn(), refreshLastVisitAt: jest.fn(), linkCardTransactionsToRecords: jest.fn(),
  linkClientCard: jest.fn(), processCompletedRecord: jest.fn(), getRecordCost: jest.fn(r => r.cost || 0),
}));
jest.mock('./services/client-upsert', () => ({ upsertClientFromYc: jest.fn() }));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));
const { warn } = mockLog;

const { db } = require('./db');
const { ycGet, ycGetClientCards } = require('./services/yclients');
const loyalty = require('./services/loyalty');
const { upsertClientFromYc } = require('./services/client-upsert');
const rec = require('./services/yclients-reconcile');

const SALON = { id: 1, yclients_company_id: '668791', yclients_card_type_id: 59301 };
const SETTINGS = { levels: [{ key: 'bronze', minSpent: 0, cashback: 5 }], bonuses_enabled: true };
const R = (id, clientId, extra = {}) => ({
  id, date: '2026-09-24 17:00:00', attendance: 1, paid_full: 1, cost: 6500,
  services: [{ id: 1, cost: 6500 }], client: { id: clientId }, ...extra,
});
const YC_CLIENT = (id) => ({ id, name: 'Тест', phone: '+79200000000', spent: 100, visits: 1 });
const noSleep = async () => {};

function wire({ records = [], finLog = {}, clients = {} } = {}) {
  // /records постранично: первая страница = records, дальше пусто
  ycGet.mockImplementation(async (salon, path, params) => {
    if (path.startsWith('/records/')) return params.page === 1 ? records : [];
    if (path.startsWith('/client/')) return YC_CLIENT(Number(path.split('/').pop()));
    throw new Error('unexpected ' + path);
  });
  db.oneOrNone.mockImplementation(async (sql, params) => {
    if (sql.includes('FROM finances_log')) return finLog[params[0]] || null;
    if (sql.includes('FROM clients WHERE salon_id=$1 AND yclients_client_id=$2')) return clients[params[1]] || null;
    return null;
  });
  db.one.mockResolvedValue({ id: 900 });                 // sync_logs INSERT
  db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  db.any.mockResolvedValue([]);
  loyalty.getLoyaltySettings.mockResolvedValue(SETTINGS);
  loyalty.upsertRecordFromYc.mockImplementation(async (sid, ycr, cid) => ({ id: ycr.id, status: 'arrived', inserted: !cid, prev: null }));
  upsertClientFromYc.mockImplementation(async (sid, yc) => ({ id: 3000 + yc.id, yclients_client_id: yc.id, yclients_card_id: clients[yc.id]?.yclients_card_id ?? null, total_spent: 100 }));
  loyalty.linkClientCard.mockResolvedValue({ id: 1 });
  ycGetClientCards.mockResolvedValue([{ id: 777, type: { id: 59301 }, balance: 450 }]);
}

beforeEach(() => { jest.clearAllMocks(); });

test('changedAfterDate — дата по Москве минус N дней', () => {
  expect(rec.changedAfterDate(new Date('2026-09-25T22:30:00Z'), 2)).toBe('2026-09-24'); // 26.09 01:30 мск − 2
  expect(rec.changedAfterDate(new Date('2026-09-25T10:00:00Z'), 2)).toBe('2026-09-23');
  expect(rec.RECONCILE_DAYS).toBe(2);
});

test('записи за окно → upsertRecordFromYc с source=reconcile, клиенты без дублей, карта и баланс, хвостовые SQL, sync_logs success', async () => {
  wire({
    records: [R(11, 501), R(12, 501), R(13, 502)],
    finLog: { 11: { id: 1 }, 12: { id: 2 }, 13: { id: 3 } },
    clients: { 501: { id: 3501, yclients_card_id: null }, 502: { id: 3502, yclients_card_id: 777 } },
  });
  const res = await rec.reconcileDaily(SALON, { sleep: noSleep });

  expect(loyalty.upsertRecordFromYc).toHaveBeenCalledTimes(3);
  expect(loyalty.upsertRecordFromYc).toHaveBeenCalledWith(1, R(11, 501), 3501, 'reconcile');
  // клиенты — по одному вызову на каждого, не на каждую запись
  const clientCalls = ycGet.mock.calls.filter(c => c[1].startsWith('/client/'));
  expect(clientCalls.map(c => c[1]).sort()).toEqual(['/client/668791/501', '/client/668791/502']);
  expect(upsertClientFromYc).toHaveBeenCalledTimes(2);
  // 501 без карты → linkClientCard; 502 с картой → баланс из ycGetClientCards
  expect(loyalty.linkClientCard).toHaveBeenCalledTimes(1);
  expect(loyalty.linkClientCard.mock.calls[0][1]).toMatchObject({ yclients_client_id: 501 });
  expect(ycGetClientCards).toHaveBeenCalledTimes(1);
  const bal = db.query.mock.calls.find(c => /yclients_card_balance=\$1/.test(c[0]));
  expect(bal).toBeTruthy();
  expect(bal[1]).toEqual([450, 3502]);
  // хвост
  expect(loyalty.refreshLastVisitAt).toHaveBeenCalledWith(1);
  expect(loyalty.linkCardTransactionsToRecords).toHaveBeenCalledTimes(2);
  // кэшбэк не начисляется
  expect(loyalty.processCompletedRecord).not.toHaveBeenCalled();
  // sync_logs
  expect(db.one.mock.calls[0][0]).toMatch(/INSERT INTO sync_logs/);
  expect(db.one.mock.calls[0][1]).toEqual([1, 'daily', 'running', null]);
  const done = db.query.mock.calls.find(c => /UPDATE sync_logs SET status='success'/.test(c[0]));
  expect(done[1]).toEqual([2, 3, 0, 0, 900]);
  expect(res).toMatchObject({ ok: true, records: 3, clients: 2, lost: [], clientErrors: 0 });
  expect(warn).not.toHaveBeenCalled();
});

test('оплаченный состоявшийся визит без строки finances_log → WARN «вебхук потерян», без начисления', async () => {
  wire({ records: [R(21, 501), R(22, 501, { attendance: 0, paid_full: 0 }), R(23, 501, { deleted: true })],
         finLog: {}, clients: { 501: { id: 3501, yclients_card_id: 777 } } });
  const res = await rec.reconcileDaily(SALON, { sleep: noSleep });
  expect(res.lost).toEqual([21]);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/записи 21/));
  expect(loyalty.processCompletedRecord).not.toHaveBeenCalled();
});

test('ошибка по одному клиенту не роняет прогон и не мешает остальным', async () => {
  wire({ records: [R(31, 501), R(32, 502)], finLog: { 31: {}, 32: {} }, clients: {} });
  ycGet.mockImplementation(async (salon, path, params) => {
    if (path.startsWith('/records/')) return params.page === 1 ? [R(31, 501), R(32, 502)] : [];
    if (path === '/client/668791/501') throw new Error('Превышен лимит запросов');
    if (path.startsWith('/client/')) return YC_CLIENT(502);
    throw new Error('unexpected');
  });
  const res = await rec.reconcileDaily(SALON, { sleep: noSleep });
  expect(res).toMatchObject({ ok: true, clients: 1, clientErrors: 1 });
  expect(upsertClientFromYc).toHaveBeenCalledTimes(1);
  expect(db.query.mock.calls.some(c => /UPDATE sync_logs SET status='success'/.test(c[0]))).toBe(true);
});

test('страница /records на лимите повторяется через 60 с, вторая страница читается', async () => {
  jest.useFakeTimers();
  wire({ finLog: { 41: {}, 42: {} }, clients: { 501: { id: 3501, yclients_card_id: 777 } } });
  const page1 = Array.from({ length: 200 }, (_, i) => R(1000 + i, 501));
  let calls = 0;
  ycGet.mockImplementation(async (salon, path, params) => {
    if (path.startsWith('/records/')) {
      calls++;
      if (calls === 1) throw new Error('Превышен лимит запросов, попробуйте повторить запрос через 0 секунд.');
      return params.page === 1 ? page1 : params.page === 2 ? [R(41, 501)] : [];
    }
    if (path.startsWith('/client/')) return YC_CLIENT(501);
    throw new Error('unexpected');
  });
  const p = rec.reconcileDaily(SALON, { sleep: noSleep });
  await jest.advanceTimersByTimeAsync(61_000);
  const res = await p;
  jest.useRealTimers();
  expect(res.records).toBe(201);
  expect(calls).toBe(3);
});

test('фатальный сбой (records не прочитались) → sync_logs error и исключение наружу', async () => {
  wire();
  ycGet.mockRejectedValue(new Error('ECONNRESET'));
  await expect(rec.reconcileDaily(SALON, { sleep: noSleep })).rejects.toThrow('ECONNRESET');
  const err = db.query.mock.calls.find(c => /UPDATE sync_logs SET status='error'/.test(c[0]));
  expect(err[1]).toEqual(['ECONNRESET', 900]);
});

test('warnIfRepeatedFailures — WARN только при трёх подряд error у daily', async () => {
  db.any.mockResolvedValueOnce([{ status: 'error' }, { status: 'error' }, { status: 'error' }]);
  expect(await rec.warnIfRepeatedFailures(1)).toBe(true);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/3 подряд/));
  warn.mockClear();
  db.any.mockResolvedValueOnce([{ status: 'error' }, { status: 'success' }, { status: 'error' }]);
  expect(await rec.warnIfRepeatedFailures(1)).toBe(false);
  expect(warn).not.toHaveBeenCalled();
});

test('closeStaleSyncRuns — зависшие running закрываются как error', async () => {
  db.query.mockResolvedValueOnce({ rowCount: 27 });
  expect(await rec.closeStaleSyncRuns()).toBe(27);
  const [sql] = db.query.mock.calls[0];
  expect(sql).toMatch(/UPDATE sync_logs SET status='error'/);
  expect(sql).toMatch(/WHERE status='running'/);
});
