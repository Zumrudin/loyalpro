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
// Перехват ответов на уведомления клиники тянет YClients/транспорт/историю — в этом сьюте нужна только
// проводка вебхука; сам модуль покрыт notifications-replies.test.js.
jest.mock('./services/notifications/replies', () => ({ handleIncoming: jest.fn() }));
jest.mock('./logger', () => {
  const log = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: () => log, __log: log };
});

const { db } = require('./db');
const accounts = require('./services/messaging/accounts');
const dispatcher = require('./services/agent/dispatcher');
const notifyReplies = require('./services/notifications/replies');
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
  // mockReset: реализация из теста (handled:true / reject) не должна пережить его.
  notifyReplies.handleIncoming.mockReset();
  notifyReplies.handleIncoming.mockResolvedValue({ handled: false });
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

const waEcho = (deliveryId, id) => ({ type: 'whatsapp_incoming_msg', payload: { customer_id: 9, provider: 'gateway', delivery_id: deliveryId,
  new_message: { direction: 'outgoing', chat_id: '79001112233@c.us', chat_phone: '79001112233', sender_phone_number: '79250177778', recipient_phone_number: '79001112233',
    message: { id, type: 'text', text: 'hi', timestamp: 1 } } } });
const dupFor = key => async (sql, p) => (/external_message_id=\$2/.test(sql) && p[1] === key ? { 1: 1 } : null);

test('/gateway whatsapp: эхо своей отправки с delivery_id g12 дедупится по строке api:g12, событие залогировано', async () => {
  accounts.resolveSalon.mockResolvedValue(3);
  accounts.credentialsFor.mockResolvedValue({ id: 9, provider: 'gateway' });
  db.oneOrNone.mockImplementation(dupFor('api:g12'));
  await handle({ baseUrl: '/gateway', query: { key: 'gwsecret' }, body: waEcho('g12', 'true_79001112233@s.whatsapp.net_OUT1') }, fakeRes());
  expect(eventInserts()).toHaveLength(1);
  expect(messageInserts()).toHaveLength(0);
  expect(log.debug).toHaveBeenCalledWith(expect.stringMatching(/skip echo of own whatsapp send \(delivery g12\)/));
});

test('/chatpush whatsapp: числовой delivery_id и устаревший _d…THISISBOT по-прежнему дедупятся', async () => {
  accounts.resolveSalon.mockResolvedValue(3);
  db.oneOrNone.mockImplementation(dupFor('api:399368073'));
  await handle({ baseUrl: '/chatpush', query: { key: 'cpsecret' }, body: waEcho(399368073, 'true_x_OUT') }, fakeRes());
  expect(messageInserts()).toHaveLength(0);
  const legacy = waEcho(null, 'true_46810865385627@lid_d399368073THISISBOT');
  await handle({ baseUrl: '/chatpush', query: { key: 'cpsecret' }, body: legacy }, fakeRes());
  expect(messageInserts()).toHaveLength(0);
});

test('/gateway whatsapp: эхо раньше персиста кладётся под api:<delivery_id> (общий ключ с persistWhatsappOutgoing)', async () => {
  accounts.resolveSalon.mockResolvedValue(3);
  accounts.credentialsFor.mockResolvedValue({ id: 9, provider: 'gateway' });
  await handle({ baseUrl: '/gateway', query: { key: 'gwsecret' }, body: waEcho('g12', 'true_79001112233@s.whatsapp.net_OUT1') }, fakeRes());
  expect(messageInserts()).toHaveLength(1);
  expect(messageInserts()[0][1][5]).toBe('api:g12');
});

test('/gateway whatsapp: входящее и эхо без delivery_id сохраняют собственный id сообщения', async () => {
  accounts.resolveSalon.mockResolvedValue(3);
  accounts.credentialsFor.mockResolvedValue({ id: 9, provider: 'gateway' });
  await handle({ baseUrl: '/gateway', query: { key: 'gwsecret' }, body: waEcho(null, 'true_x_APP1') }, fakeRes());
  expect(messageInserts()[0][1][5]).toBe('true_x_APP1');
});

// ── Ответы на уведомления клиники («Подтверждаю» после напоминания, «5» после опроса) ──
// handleIncoming стоит ПОСЛЕ сохранения входящего и ДО постановки Милы в очередь: иначе на одну
// цифру ответили бы дважды — модуль и Мила. Сам модуль в режимах off/shadow возвращает
// {handled:false} (notifications-replies.test.js), здесь проверяется только проводка.
describe('перехват ответов на уведомления клиники', () => {
  const outgoingBody = customerId => ({
    type: 'tdlib_incoming_msg',
    payload: {
      customer_id: customerId, direction: 'outgoing', chat_id: '5', chat_type: 'person',
      sender_phone_number: '79250177778', recipient_phone_number: '79001112233', delivery_id: 4,
      message: { id: '5:2', type: 'formattedText', text: 'Напоминаем о записи', timestamp: 2 },
    },
  });
  const viaGateway = (body = flatBody(9)) => handle({ baseUrl: '/gateway', query: { key: 'gwsecret' }, body }, fakeRes());
  const insertOrder = () => db.query.mock.invocationCallOrder[db.query.mock.calls.findIndex(c => /INSERT INTO chatpush_messages/.test(c[0]))];

  beforeEach(() => accounts.resolveSalon.mockResolvedValue(3));

  test('перехвачено (handled:true) → Мила в очередь не ставится, сообщение при этом сохранено', async () => {
    notifyReplies.handleIncoming.mockResolvedValue({ handled: true, kind: 'rating', rating: 5 });
    await viaGateway();
    expect(notifyReplies.handleIncoming).toHaveBeenCalledTimes(1);
    expect(notifyReplies.handleIncoming).toHaveBeenCalledWith(3, expect.objectContaining({
      direction: 'incoming', channel: 'tdlib', phone: '79001112233', chatId: '5', text: 'x' }));
    expect(messageInserts()).toHaveLength(1);
    expect(dispatcher.enqueue).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/notify reply: rating 5.*Мила не вызывается/));
  });

  test('повтор ответа (kind=duplicate) тоже не уходит Миле', async () => {
    notifyReplies.handleIncoming.mockResolvedValue({ handled: true, kind: 'duplicate' });
    await viaGateway();
    expect(dispatcher.enqueue).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/notify reply: duplicate/));
  });

  test('не перехвачено (handled:false: режим off/shadow, не наш ответ) → Мила ставится как раньше', async () => {
    await viaGateway();
    expect(notifyReplies.handleIncoming).toHaveBeenCalledTimes(1);
    expect(dispatcher.enqueue).toHaveBeenCalledWith(3, '79001112233', expect.objectContaining({ channel: 'tdlib', text: 'x' }));
  });

  test('порядок: сообщение сохранено → перехват → Мила', async () => {
    await viaGateway();
    const call = notifyReplies.handleIncoming.mock.invocationCallOrder[0];
    expect(call).toBeGreaterThan(insertOrder());
    expect(call).toBeLessThan(dispatcher.enqueue.mock.invocationCallOrder[0]);
  });

  test('сбой перехвата не мешает Миле и не помечает событие ошибкой', async () => {
    notifyReplies.handleIncoming.mockRejectedValue(new Error('boom'));
    await viaGateway();
    expect(dispatcher.enqueue).toHaveBeenCalledWith(3, '79001112233', expect.any(Object));
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/notify reply.*boom/));
    expect(db.query.mock.calls.some(c => /UPDATE chatpush_events SET error/.test(c[0]))).toBe(false);
  });

  test('повтор вебхука (сообщение уже сохранено) → перехват не вызывается, ответ не обработать дважды', async () => {
    db.query.mockImplementation(async sql => (/INSERT INTO chatpush_messages/.test(sql)
      ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [] }));
    await viaGateway();
    expect(notifyReplies.handleIncoming).not.toHaveBeenCalled();
    expect(dispatcher.enqueue).not.toHaveBeenCalled();
  });

  test('исходящее эхо не перехватывается', async () => {
    await viaGateway(outgoingBody(9));
    expect(messageInserts()).toHaveLength(1);
    expect(notifyReplies.handleIncoming).not.toHaveBeenCalled();
  });

  test('перехват не зависит от глобального флага агента: Мила выключена, а ответ на уведомление обработан', async () => {
    const config = require('./config');
    config.CHATPUSH.agentEnabled = false;
    try {
      notifyReplies.handleIncoming.mockResolvedValue({ handled: true, kind: 'confirmed' });
      await viaGateway();
      expect(notifyReplies.handleIncoming).toHaveBeenCalledTimes(1);
      expect(dispatcher.enqueue).not.toHaveBeenCalled();
    } finally { config.CHATPUSH.agentEnabled = true; }
  });

  test('/chatpush: тот же роутер — тот же перехват, салон из реестра', async () => {
    accounts.resolveSalon.mockResolvedValue(1);
    notifyReplies.handleIncoming.mockResolvedValue({ handled: true, kind: 'confirmed' });
    await handle({ baseUrl: '/chatpush', query: { key: 'cpsecret' }, body: flatBody(46594) }, fakeRes());
    expect(notifyReplies.handleIncoming).toHaveBeenCalledWith(1, expect.objectContaining({ phone: '79001112233' }));
    expect(dispatcher.enqueue).not.toHaveBeenCalled();
  });

  test('неизвестный аккаунт (салона нет) → перехвата нет', async () => {
    accounts.resolveSalon.mockResolvedValue(null);
    await viaGateway();
    expect(notifyReplies.handleIncoming).not.toHaveBeenCalled();
  });

  test('канал салона обслуживает другой провайдер (копия сообщения от прежнего) → перехвата нет, иначе ответили бы дважды', async () => {
    accounts.resolveSalon.mockResolvedValue(1);
    accounts.credentialsFor.mockResolvedValue({ id: 42, provider: 'gateway', channel: 'tdlib' });
    await handle({ baseUrl: '/chatpush', query: { key: 'cpsecret' }, body: flatBody(46594) }, fakeRes());
    expect(notifyReplies.handleIncoming).not.toHaveBeenCalled();
    expect(dispatcher.enqueue).not.toHaveBeenCalled();
  });
});
