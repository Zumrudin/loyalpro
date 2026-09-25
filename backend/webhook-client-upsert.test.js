'use strict';
// client-вебхук YClients приходит на каждый оплаченный визит и несёт spent/visits/
// раздельное ФИО. До 25.09.2026 маршрут писал из него только ФИО/телефон/почту/ДР,
// а траты/визиты обновлял ТОЛЬКО runSync (сломан с 26.06) — total_spent у
// клиента с 55 визитами отставал на 81 000 ₽. Теперь ветка `client` зовёт общий
// upsertClientFromYc (services/client-upsert.js).

jest.mock('./db', () => ({ db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn(), any: jest.fn() }, pool: {} }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
jest.mock('./services/loyalty', () => ({
  getLoyaltySettings: jest.fn(), processRecordEvent: jest.fn(), processFinancesOperation: jest.fn(),
}));
jest.mock('./services/notifications', () => ({ handleRecordCreated: jest.fn() }));
jest.mock('./services/care/enroll', () => ({ handleRecordEvent: jest.fn() }));
jest.mock('./services/reminders/enroll', () => ({ handleRecordEvent: jest.fn(), handleAttribution: jest.fn() }));
jest.mock('./services/client-upsert', () => ({ upsertClientFromYc: jest.fn() }));

const { db } = require('./db');
const { getLoyaltySettings } = require('./services/loyalty');
const { upsertClientFromYc } = require('./services/client-upsert');
const router = require('./routes/webhook');

const SALON = { id: 1, yclients_company_id: '668791', yclients_webhook_secret: null, is_active: true };
const SETTINGS = { levels: [{ key: 'bronze', minSpent: 0, cashback: 5 }] };
const CLIENT = { id: 352092609, name: 'Андрюшова Елена Валерьевна', phone: '+79160000000', spent: 1373824, visits: 55 };

function handler() {
  const layer = router.stack.find(l => l.route && l.route.path === '/webhook.v2/:companyId');
  return layer.route.stack[0].handle;
}

async function post(payload) {
  const req = { params: { companyId: '668791' }, query: {}, body: payload };
  const res = { json: jest.fn(), status: jest.fn(() => res) };
  await handler()(req, res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.oneOrNone.mockResolvedValue(SALON);
  db.one.mockResolvedValue({ id: 1 });      // webhook_logs
  db.query.mockResolvedValue({ rows: [] });
  getLoyaltySettings.mockResolvedValue(SETTINGS);
  upsertClientFromYc.mockResolvedValue({ id: 3777 });
});

test('client-вебхук → upsertClientFromYc(salon.id, data, settings) — не свой INSERT', async () => {
  const res = await post({ resource: 'client', status: 'update', data: CLIENT });
  expect(res.json).toHaveBeenCalledWith({ ok: true });
  expect(upsertClientFromYc).toHaveBeenCalledTimes(1);
  expect(upsertClientFromYc).toHaveBeenCalledWith(1, CLIENT, SETTINGS);
  const inserts = db.query.mock.calls.filter(c => /INSERT INTO clients/.test(c[0]));
  expect(inserts).toHaveLength(0);
});

test('client-вебхук без data — хелпер не зовётся', async () => {
  await post({ resource: 'client', status: 'update' });
  expect(upsertClientFromYc).not.toHaveBeenCalled();
});

test('сбой upsert не теряется: пишется error_message в webhook_logs', async () => {
  upsertClientFromYc.mockRejectedValue(new Error('db down'));
  await post({ resource: 'client', status: 'update', data: CLIENT });
  const errUpd = db.query.mock.calls.find(c => /SET error_message/.test(c[0]));
  expect(errUpd).toBeTruthy();
  expect(errUpd[1][0]).toBe('db down');
});
