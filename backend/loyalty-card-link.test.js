'use strict';
// Инцидент 2026-09-25 (79166274373, clients.id=3777): бот выдал карту лояльности в
// YClients за 8 минут до оплаты, но наш clients.yclients_card_id остался пустым —
// связку писал только runSync (падает с 26.06) и ручная кнопка. Начисление смотрело
// в наш кэш и ставило ТЕРМИНАЛЬНЫЙ отказ «has no loyalty card». Событий о картах
// YClients не шлёт вовсе (проверено по 23k вебхуков), поэтому единственный надёжный
// момент узнать о карте — само начисление.
//
// Вторая половина: у свежепривязанной карты в нашей БД нет истории списаний ПО
// ПОСТРОЕНИЮ (платёжные вебхуки finances_operation приходят на ~60 мс РАНЬШЕ
// record update paid_full=1 и при пустой связке выходят по «no client or card»),
// поэтому оплату бонусами на кассе надо спросить у YClients напрямую:
// /visit/details → loyalty_transactions[].is_loyalty_withdraw.

jest.mock('./db', () => ({
  db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn() },
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
const { ycGet, ycGetClientCards, ycGetClientCardsStrict, ycAccrueCard } = require('./services/yclients');
const { processRecordEvent } = require('./services/loyalty');

const SALON = { id: 1, yclients_company_id: '668791', yclients_card_type_id: 59301 };
const SETTINGS = {
  levels: [{ key: 'bronze', cashback: 5, minSpent: 0 }],
  service_cashback: {},
  bonuses_enabled: true,
};
// Карты в нашей БД нет — ровно состояние клиента, только что зарегистрированного ботом.
const CLIENT_NO_CARD = {
  id: 3777, yclients_client_id: 352092609, yclients_card_id: null,
  bonus_balance: 0, total_spent: 0, name: 'Анжелика',
};
const CLIENT_LINKED = { ...CLIENT_NO_CARD, yclients_card_id: 152063337, bonus_balance: 500 };
const RECORD_ROW = { id: 55 };
const YC_CARD = { id: 152063337, number: '00012', balance: 500, paid_amount: 0, type: { id: 59301 } };

function makePayload() {
  return {
    status: 'update',
    data: {
      id: 1931663073, visit_id: 1684923324, date: '2026-09-04 14:00:00', paid_full: 1, attendance: 1,
      client: { id: 352092609 },
      services: [{ id: 1, cost: 65500, cost_to_pay: 65500, discount: 0 }],
    },
  };
}

function wireDb() {
  db.oneOrNone.mockImplementation((sql) => {
    if (sql.includes('FROM clients')) return Promise.resolve(CLIENT_NO_CARD);
    if (sql.includes('FROM records WHERE')) return Promise.resolve(RECORD_ROW);
    return Promise.resolve(null);
  });
  db.one.mockImplementation((sql) => {
    if (sql.includes('UPDATE clients SET') && sql.includes('yclients_card_id=')) return Promise.resolve(CLIENT_LINKED);
    return Promise.resolve(null);
  });
  db.query.mockImplementation((sql) => {
    if (sql.includes('INSERT INTO finances_log')) return Promise.resolve({ rowCount: 1 });
    return Promise.resolve({ rowCount: 1, rows: [] });
  });
}

const sqlCalls = () => db.query.mock.calls.map(c => c[0]);
const denial = () => db.query.mock.calls.find(c =>
  c[0].includes('UPDATE finances_log') && c[0].includes('cashback_amount=0'));

beforeEach(() => {
  jest.clearAllMocks();
  wireDb();
  ycAccrueCard.mockResolvedValue({ id: 1 });
  ycGetClientCards.mockResolvedValue([]);
});

test('карта есть в YClients, но не в нашей БД → привязывается и кэшбэк начисляется на неё', async () => {
  ycGetClientCardsStrict.mockResolvedValue([YC_CARD]);
  ycGet.mockResolvedValue({ loyalty_transactions: [], payment_transactions: [] });

  await processRecordEvent(makePayload(), SALON, SETTINGS);

  const link = db.one.mock.calls.find(c => c[0].includes('yclients_card_id='));
  expect(link).toBeTruthy();
  expect(link[1]).toEqual(expect.arrayContaining([152063337, '00012', 3777]));

  expect(ycAccrueCard).toHaveBeenCalledWith(SALON, 152063337, 3275, expect.any(String));
  expect(sqlCalls().some(sql => sql.includes('bonus_balance=bonus_balance+'))).toBe(true);
  expect(denial()).toBeUndefined();
});

test('свежепривязанная карта: визит оплачен бонусами по visit/details → отказ, начисления нет', async () => {
  ycGetClientCardsStrict.mockResolvedValue([YC_CARD]);
  ycGet.mockImplementation((salon, endpoint) => {
    if (endpoint.startsWith('/visit/details/')) {
      return Promise.resolve({ loyalty_transactions: [{ is_loyalty_withdraw: true, amount: 250, type_id: 3 }] });
    }
    return Promise.resolve({});
  });

  await processRecordEvent(makePayload(), SALON, SETTINGS);

  expect(ycGet).toHaveBeenCalledWith(SALON, '/visit/details/668791/1931663073/1684923324');
  expect(ycAccrueCard).not.toHaveBeenCalled();
  expect(denial()).toBeTruthy();
  expect(denial()[0]).toMatch(/processed=TRUE/);
  // Связка при этом остаётся: следующий визит пойдёт по обычному пути.
  expect(db.one.mock.calls.some(c => c[0].includes('yclients_card_id='))).toBe(true);
});

test('карты типа салона в YClients нет → терминальный отказ как раньше', async () => {
  ycGetClientCardsStrict.mockResolvedValue([{ id: 1, type: { id: 777 } }]);

  await processRecordEvent(makePayload(), SALON, SETTINGS);

  expect(db.one.mock.calls.some(c => c[0].includes('yclients_card_id='))).toBe(false);
  expect(ycAccrueCard).not.toHaveBeenCalled();
  expect(denial()).toBeTruthy();
  expect(denial()[0]).toMatch(/processed=TRUE/);
});

test('YClients не ответил про карты → отказ НЕ терминальный: заявка освобождена, ошибка наружу', async () => {
  ycGetClientCardsStrict.mockRejectedValue(new Error('Превышен лимит запросов'));

  await expect(processRecordEvent(makePayload(), SALON, SETTINGS)).rejects.toThrow('Превышен лимит запросов');

  expect(denial()).toBeUndefined();
  expect(ycAccrueCard).not.toHaveBeenCalled();
  const released = db.query.mock.calls.find(c =>
    c[0].includes('DELETE FROM finances_log') && c[0].includes('cashback_amount=-1'));
  expect(released).toBeTruthy();
  expect(released[1]).toEqual([1931663073]);
});

test('карта уже привязана → в YClients за картами и visit/details не ходим', async () => {
  db.oneOrNone.mockImplementation((sql) => {
    if (sql.includes('FROM clients')) return Promise.resolve(CLIENT_LINKED);
    if (sql.includes('FROM records WHERE')) return Promise.resolve(RECORD_ROW);
    return Promise.resolve(null);
  });

  await processRecordEvent(makePayload(), SALON, SETTINGS);

  expect(ycGetClientCardsStrict).not.toHaveBeenCalled();
  expect(ycGet).not.toHaveBeenCalled();
  expect(ycAccrueCard).toHaveBeenCalledWith(SALON, 152063337, 3275, expect.any(String));
});
