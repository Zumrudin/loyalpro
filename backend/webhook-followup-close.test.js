'use strict';
// record create → ожидание ответа Милы гасится по номеру клиента
// (followup-queue.closeByPhone). Отмена/удаление/неявка ожидание не трогают.

jest.mock('./db', () => ({ db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn(), any: jest.fn() }, pool: {} }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
jest.mock('./services/loyalty', () => ({
  getLoyaltySettings: jest.fn(), processRecordEvent: jest.fn(), processFinancesOperation: jest.fn(),
}));
jest.mock('./services/notifications', () => ({ handleRecordCreated: jest.fn(async () => {}) }));
jest.mock('./services/care/enroll', () => ({ handleRecordEvent: jest.fn(async () => {}) }));
jest.mock('./services/reminders/enroll', () => ({
  handleRecordEvent: jest.fn(async () => {}), handleAttribution: jest.fn(async () => {}),
}));
jest.mock('./services/client-upsert', () => ({ upsertClientFromYc: jest.fn() }));
jest.mock('./services/agent/followup-queue', () => ({ closeByPhone: jest.fn(async () => 1) }));

const { db } = require('./db');
const followupQueue = require('./services/agent/followup-queue');
const router = require('./routes/webhook');

const SALON = { id: 1, yclients_company_id: '668791', yclients_webhook_secret: null, is_active: true };

async function post(payload) {
  const layer = router.stack.find(l => l.route && l.route.path === '/webhook.v2/:companyId');
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
});

const rec = (status, data = {}) => ({
  resource: 'record', status,
  data: { id: 5, attendance: 0, deleted: false, client: { id: 9, phone: '+7 (920) 025-55-91' }, ...data },
});

test('record create гасит ожидание по канонизированному номеру', async () => {
  await post(rec('create'));
  expect(followupQueue.closeByPhone).toHaveBeenCalledWith(1, '79200255591', 'booked_in_crm');
});

test.each([
  ['update', {}],
  ['delete', {}],
  ['create', { deleted: true }],
  ['create', { attendance: -1 }],
  ['create', { client: null }],
])('status=%s %o — не гасит', async (status, data) => {
  await post(rec(status, data));
  expect(followupQueue.closeByPhone).not.toHaveBeenCalled();
});

test('сбой гашения не роняет обработку вебхука', async () => {
  followupQueue.closeByPhone.mockRejectedValueOnce(new Error('boom'));
  await post(rec('create'));
  const done = db.query.mock.calls.filter(c => /SET processed=TRUE/.test(c[0]));
  expect(done).toHaveLength(1);
});
