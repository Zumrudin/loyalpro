'use strict';
// Обработчик POST /webhook: провайдер из точки монтирования, салон из реестра.
jest.mock('./config', () => ({
  CHATPUSH: { webhookSecret: 'cpsecret', agentEnabled: true, salonId: 1, customerId: 46594 },
  MESSAGING_GATEWAY: { webhookSecret: 'gwsecret' },
}));
jest.mock('./db', () => ({ db: { query: jest.fn(), one: jest.fn(), oneOrNone: jest.fn(), any: jest.fn() } }));
jest.mock('./services/messaging/accounts', () => ({ resolveSalon: jest.fn(), credentialsFor: jest.fn() }));
jest.mock('./services/agent/dispatcher', () => ({ enqueue: jest.fn() }));
jest.mock('./services/chat-events', () => ({ emit: jest.fn(), emitFollowupStatus: jest.fn() }));
jest.mock('./services/outgoing-authorship', () => ({ classify: jest.fn().mockResolvedValue(null) }));
jest.mock('./services/chat-persist', () => ({ adoptPhoneForChat: jest.fn().mockResolvedValue(0) }));
jest.mock('./services/agent/followup-queue', () => ({ close: jest.fn().mockResolvedValue(false) }));
jest.mock('./services/agent/dialog-state', () => ({ pauseForOperator: jest.fn().mockResolvedValue() }));
jest.mock('./logger', () => {
  const log = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: () => log, __log: log };
});

const { db } = require('./db');
const accounts = require('./services/messaging/accounts');
const dispatcher = require('./services/agent/dispatcher');
const { __log: log } = require('./logger');
const router = require('./routes/chatpush-webhook');
const handle = router.stack.find(l => l.route && l.route.path === '/webhook').route.stack[0].handle;

const fakeRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
const flatBody = customerId => ({
  type: 'tdlib_incoming_msg',
  payload: {
    customer_id: customerId, direction: 'incoming', chat_id: '5', chat_type: 'person',
    sender_phone_number: '79001112233',
    message: { id: '5:1', type: 'formattedText', text: 'x', timestamp: 1 },
  },
});
const eventInserts = () => db.one.mock.calls.filter(c => /INSERT INTO chatpush_events/.test(c[0]));
const messageInserts = () => db.query.mock.calls.filter(c => /INSERT INTO chatpush_messages/.test(c[0]));

beforeEach(() => {
  jest.clearAllMocks();
  accounts.credentialsFor.mockResolvedValue(null);
  db.one.mockResolvedValue({ id: 101 });
  db.oneOrNone.mockResolvedValue(null);
  db.query.mockImplementation(async sql => (/INSERT INTO chatpush_messages/.test(sql)
    ? { rowCount: 1, rows: [{ id: 555 }] } : { rowCount: 1, rows: [] }));
});

test('/gateway: салон резолвится strict ДО ответа, provider и салон уходят в INSERT, агент ставится', async () => {
  accounts.resolveSalon.mockResolvedValue(3);
  const res = fakeRes();
  await handle({ baseUrl: '/gateway', query: { key: 'gwsecret' }, body: flatBody(9) }, res);

  expect(accounts.resolveSalon).toHaveBeenCalledWith('gateway', 9, { strict: true });
  expect(accounts.resolveSalon.mock.invocationCallOrder[0]).toBeLessThan(res.json.mock.invocationCallOrder[0]);
  expect(res.json).toHaveBeenCalledWith({ ok: true });

  const ev = eventInserts();
  expect(ev).toHaveLength(1);
  expect(ev[0][1][0]).toBe(3);
  expect(ev[0][1]).toContain('gateway');

  const mi = messageInserts();
  expect(mi).toHaveLength(1);
  expect(mi[0][1][0]).toBe(3);
  expect(mi[0][1]).toContain('gateway');

  expect(dispatcher.enqueue).toHaveBeenCalledWith(3, '79001112233', expect.any(Object));
});

test('/gateway: сбой БД при резолве → 503, событие не пишется', async () => {
  accounts.resolveSalon.mockRejectedValue(new Error('db down'));
  const res = fakeRes();
  await handle({ baseUrl: '/gateway', query: { key: 'gwsecret' }, body: flatBody(9) }, res);

  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.json).toHaveBeenCalledWith({ error: 'retry' });
  expect(eventInserts()).toHaveLength(0);
  expect(messageInserts()).toHaveLength(0);
  expect(dispatcher.enqueue).not.toHaveBeenCalled();
});

test('/gateway: неизвестный аккаунт → 200, событие сохранено, сообщения и агента нет, WARN', async () => {
  accounts.resolveSalon.mockResolvedValue(null);
  const res = fakeRes();
  await handle({ baseUrl: '/gateway', query: { key: 'gwsecret' }, body: flatBody(9) }, res);

  expect(res.json).toHaveBeenCalledWith({ ok: true });
  expect(res.status).not.toHaveBeenCalled();
  expect(eventInserts()).toHaveLength(1);
  expect(messageInserts()).toHaveLength(0);
  expect(dispatcher.enqueue).not.toHaveBeenCalled();
  expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/unknown account: gateway\/9/));
  expect(db.query).toHaveBeenCalledWith(expect.stringMatching(/SET processed=TRUE/), [101]);
});

test('/chatpush: сначала ответ, потом резолв салона (без strict), provider=chatpush', async () => {
  accounts.resolveSalon.mockResolvedValue(1);
  const res = fakeRes();
  await handle({ baseUrl: '/chatpush', query: { key: 'cpsecret' }, body: flatBody(46594) }, res);

  expect(res.json).toHaveBeenCalledWith({ ok: true });
  expect(accounts.resolveSalon).toHaveBeenCalledWith('chatpush', 46594);
  expect(res.json.mock.invocationCallOrder[0]).toBeLessThan(accounts.resolveSalon.mock.invocationCallOrder[0]);
  expect(eventInserts()[0][1]).toContain('chatpush');
  expect(messageInserts()[0][1]).toContain('chatpush');
  expect(messageInserts()[0][1][0]).toBe(1);
});

describe('канал салона обслуживает другой провайдер (переключение tdlib)', () => {
  test('/chatpush tdlib-сообщение, а канал на шлюзе → событие сохранено, сообщение не разбираем', async () => {
    accounts.resolveSalon.mockResolvedValue(1);
    accounts.credentialsFor.mockResolvedValue({ id: 42, provider: 'gateway', channel: 'tdlib' });
    await handle({ baseUrl: '/chatpush', query: { key: 'cpsecret' }, body: flatBody(46594) }, fakeRes());
    expect(accounts.credentialsFor).toHaveBeenCalledWith(1, 'tdlib');
    expect(eventInserts()).toHaveLength(1);
    expect(messageInserts()).toHaveLength(0);
    expect(dispatcher.enqueue).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledWith(expect.stringMatching(/SET processed=TRUE/), [101]);
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/skip chatpush tdlib message: канал салона 1 обслуживает gateway \(аккаунт #42\)/));
  });

  test('/gateway сообщение, а канал на Chatpush → пропуск', async () => {
    accounts.resolveSalon.mockResolvedValue(3);
    accounts.credentialsFor.mockResolvedValue({ id: 5, provider: 'chatpush', channel: 'tdlib' });
    await handle({ baseUrl: '/gateway', query: { key: 'gwsecret' }, body: flatBody(9) }, fakeRes());
    expect(eventInserts()).toHaveLength(1);
    expect(messageInserts()).toHaveLength(0);
    expect(dispatcher.enqueue).not.toHaveBeenCalled();
  });

  test('тот же провайдер → обычная обработка', async () => {
    accounts.resolveSalon.mockResolvedValue(3);
    accounts.credentialsFor.mockResolvedValue({ id: 9, provider: 'gateway', channel: 'tdlib' });
    await handle({ baseUrl: '/gateway', query: { key: 'gwsecret' }, body: flatBody(9) }, fakeRes());
    expect(messageInserts()).toHaveLength(1);
    expect(dispatcher.enqueue).toHaveBeenCalled();
  });

  test('сбой credentialsFor → обычная обработка (fail-open)', async () => {
    accounts.resolveSalon.mockResolvedValue(3);
    accounts.credentialsFor.mockRejectedValue(new Error('db down'));
    await handle({ baseUrl: '/gateway', query: { key: 'gwsecret' }, body: flatBody(9) }, fakeRes());
    expect(messageInserts()).toHaveLength(1);
  });
});

test('/gateway: исходящее эхо → classify получает provider=gateway (шаблоны автоуведомлений, 2026-10-12)', async () => {
  const authorship = require('./services/outgoing-authorship');
  accounts.resolveSalon.mockResolvedValue(1);
  const res = fakeRes();
  const body = {
    type: 'tdlib_incoming_msg',
    payload: {
      customer_id: 9, direction: 'outgoing', chat_id: '5', chat_type: 'person',
      sender_phone_number: '79250177778', recipient_phone_number: '79001112233', delivery_id: null,
      message: { id: '5:2', type: 'formattedText', text: 'Рекомендации после процедуры', timestamp: 2 },
    },
  };
  await handle({ baseUrl: '/gateway', query: { key: 'gwsecret' }, body }, res);
  expect(authorship.classify).toHaveBeenCalledTimes(1);
  const [salonId, text, opts] = authorship.classify.mock.calls[0];
  expect(salonId).toBe(1);
  expect(text).toBe('Рекомендации после процедуры');
  expect(opts).toEqual({ viaApi: false, provider: 'gateway' });
});
