'use strict';
// Проводка уведомлений в вебхуке YClients: handleRecordEvent зовётся на КАЖДОМ record-событии
// (create/update/delete), после начисления кэшбэка и до хуков «Заботы» и напоминаний, в своём
// catch. До Task 5 здесь стоял handleRecordCreated только на status=create — перенос, отмена и
// «пришёл» уведомлений не порождали.

jest.mock('./db', () => ({ db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn(), any: jest.fn() }, pool: {} }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
jest.mock('./services/loyalty', () => ({
  getLoyaltySettings: jest.fn(), processRecordEvent: jest.fn(async () => {}), processFinancesOperation: jest.fn(),
}));
jest.mock('./services/notifications', () => ({ handleRecordEvent: jest.fn(async () => {}) }));
jest.mock('./services/care/enroll', () => ({ handleRecordEvent: jest.fn(async () => {}) }));
jest.mock('./services/reminders/enroll', () => ({
  handleRecordEvent: jest.fn(async () => {}), handleAttribution: jest.fn(async () => {}),
}));
jest.mock('./services/client-upsert', () => ({ upsertClientFromYc: jest.fn() }));
jest.mock('./services/agent/followup-queue', () => ({ closeByPhone: jest.fn(async () => 0) }));

const { db } = require('./db');
const loyalty = require('./services/loyalty');
const notifications = require('./services/notifications');
const care = require('./services/care/enroll');
const reminders = require('./services/reminders/enroll');
const router = require('./routes/webhook');

const SALON = { id: 1, yclients_company_id: '668791', yclients_webhook_secret: null, is_active: true };

async function post(payload) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/webhook.v2/:companyId');
  const req = { params: { companyId: '668791' }, query: {}, body: payload };
  const res = { json: jest.fn(), status: jest.fn(() => res) };
  await layer.route.stack[0].handle(req, res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.oneOrNone.mockResolvedValue(SALON);
  db.one.mockResolvedValue({ id: 1 });
  db.query.mockResolvedValue({ rows: [] });
  loyalty.getLoyaltySettings.mockResolvedValue({});
});

const rec = (status, data = {}) => ({
  resource: 'record', status,
  data: { id: 5, attendance: 0, deleted: false, client: { id: 9, phone: '+7 (920) 025-55-91' }, ...data },
});

test.each([
  ['create', {}],
  ['update', { attendance: 1 }],
  ['update', { datetime: '2026-10-21T10:00:00+03:00' }],
  ['update', { attendance: -1 }],
  ['delete', { deleted: true }],
])('record status=%s %o → handleRecordEvent(salon, payload)', async (status, data) => {
  const payload = rec(status, data);
  await post(payload);
  expect(notifications.handleRecordEvent).toHaveBeenCalledTimes(1);
  expect(notifications.handleRecordEvent).toHaveBeenCalledWith(SALON, payload);
});

test('порядок: начисление → уведомления → «Забота» → напоминания', async () => {
  await post(rec('update', { attendance: 1 }));
  const order = (fn) => fn.mock.invocationCallOrder[0];
  expect(order(loyalty.processRecordEvent)).toBeLessThan(order(notifications.handleRecordEvent));
  expect(order(notifications.handleRecordEvent)).toBeLessThan(order(care.handleRecordEvent));
  expect(order(notifications.handleRecordEvent)).toBeLessThan(order(reminders.handleRecordEvent));
});

test('сбой уведомлений не ломает «Заботу», напоминания и отметку обработки вебхука', async () => {
  notifications.handleRecordEvent.mockRejectedValueOnce(new Error('boom'));
  await post(rec('create'));
  expect(care.handleRecordEvent).toHaveBeenCalledTimes(1);
  expect(reminders.handleRecordEvent).toHaveBeenCalledTimes(1);
  expect(reminders.handleAttribution).toHaveBeenCalledTimes(1);
  expect(db.query.mock.calls.filter((c) => /SET processed=TRUE/.test(c[0]))).toHaveLength(1);
  expect(db.query.mock.calls.some((c) => /SET error_message/.test(c[0]))).toBe(false);
});

test('не-record ресурсы уведомлений не порождают', async () => {
  await post({ resource: 'client', status: 'update', data: { id: 9 } });
  await post({ resource: 'finances_operation', status: 'create', data: { id: 3 } });
  expect(notifications.handleRecordEvent).not.toHaveBeenCalled();
});
