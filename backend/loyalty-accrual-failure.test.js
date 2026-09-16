'use strict';
// Инцидент 2026-09-16: реальный POST в YClients (ycAccrueCard) падал, но код
// молча ловил исключение и всё равно коммитил локальный bonus_balance/транзакцию,
// как будто начисление прошло. Локальная БД разошлась с реальной картой клиента,
// а дальше рассинхрон породил фантомное «списание» при следующей оплате, которое
// отказало клиенту в кэшбэке за СЛЕДУЮЩИЙ визит тоже. Фикс: при падении реального
// вызова — не трогать bonus_balance/loyalty_card_transactions, оставить
// finances_log в отклонённом состоянии.

jest.mock('./db', () => ({
  db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn() },
  pool: { connect: jest.fn() },
}));
jest.mock('./services/yclients', () => ({
  ycGet: jest.fn(), ycPost: jest.fn(), ycGetClientCards: jest.fn(), ycAccrueCard: jest.fn(),
}));
jest.mock('./logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { db } = require('./db');
const { ycAccrueCard } = require('./services/yclients');
const { processRecordEvent } = require('./services/loyalty');

const SALON = { id: 1, yclients_company_id: '668791', yclients_card_type_id: 59301 };
const SETTINGS = {
  levels: [{ key: 'bronze', cashback: 5, minSpent: 0 }],
  service_cashback: {},
  bonuses_enabled: true,
};
const CLIENT_ROW = {
  id: 1633, yclients_card_id: 'card1', bonus_balance: 50, total_spent: 1000, name: 'Тест',
};
const RECORD_ROW = { id: 55 };

function makePayload() {
  return {
    status: 'update',
    data: {
      id: 999, date: '2026-09-16 14:00:00', paid_full: 1, attendance: 1,
      client: { id: 180259799 },
      services: [{ id: 1, cost: 100, cost_to_pay: 100, discount: 0 }],
    },
  };
}

function wireDb() {
  db.oneOrNone.mockImplementation((sql) => {
    if (sql.includes('FROM clients')) return Promise.resolve(CLIENT_ROW);
    if (sql.includes('FROM records WHERE')) return Promise.resolve(RECORD_ROW);
    if (sql.includes('loyalty_card_transactions')) return Promise.resolve(null);
    return Promise.resolve(null);
  });
  db.query.mockImplementation((sql) => {
    if (sql.includes('INSERT INTO finances_log')) return Promise.resolve({ rowCount: 1 });
    return Promise.resolve({ rowCount: 1, rows: [] });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  wireDb();
});

test('ycAccrueCard падает → bonus_balance и loyalty_card_transactions НЕ трогаем, finances_log отклонён', async () => {
  ycAccrueCard.mockRejectedValue(new Error('YClients 500'));

  await processRecordEvent(makePayload(), SALON, SETTINGS);

  expect(ycAccrueCard).toHaveBeenCalledWith(SALON, 'card1', 5, expect.any(String));

  const queryCalls = db.query.mock.calls.map(c => c[0]);
  expect(queryCalls.some(sql => sql.includes('bonus_balance=bonus_balance+'))).toBe(false);
  expect(queryCalls.some(sql => sql.includes('INSERT INTO loyalty_card_transactions'))).toBe(false);
  expect(queryCalls.some(sql => sql.includes('UPDATE records SET bonus_processed=TRUE'))).toBe(false);

  const denial = db.query.mock.calls.find(c =>
    c[0].includes('UPDATE finances_log') && c[0].includes('cashback_amount=0'));
  expect(denial).toBeTruthy();
  expect(denial[0]).toMatch(/processed=TRUE/);
  expect(denial[1]).toEqual([999]);
});

test('ycAccrueCard успешен → начисление коммитится как раньше (happy path не сломан)', async () => {
  ycAccrueCard.mockResolvedValue({ id: 1 });

  await processRecordEvent(makePayload(), SALON, SETTINGS);

  expect(ycAccrueCard).toHaveBeenCalledWith(SALON, 'card1', 5, expect.any(String));

  const queryCalls = db.query.mock.calls.map(c => c[0]);
  expect(queryCalls.some(sql => sql.includes('bonus_balance=bonus_balance+'))).toBe(true);
  expect(queryCalls.some(sql => sql.includes('INSERT INTO loyalty_card_transactions'))).toBe(true);

  const finLog = db.query.mock.calls.find(c =>
    c[0].includes('UPDATE finances_log') && c[0].includes('cashback_amount=$1'));
  expect(finLog[1]).toEqual([5, 5, 100, 999]);
});
