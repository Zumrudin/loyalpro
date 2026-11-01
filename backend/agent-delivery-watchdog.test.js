'use strict';
// Сторож доставки реплик Милы: Chatpush отвечает success в момент постановки в
// очередь, и сообщение может не уйти вовсе (инцидент 2026-08-09, 79773115566 —
// ни message_status, ни эха за 4 часа). Проверяем ровно то поведение, о котором
// договорились: одна повторная отправка, потом перевод на администратора.

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLogger }));

const watchdog = require('./services/agent/delivery-watchdog');

const NOW = Date.UTC(2026, 7, 9, 0, 50, 0);
const cfg = { AGENT_DELIVERY_WATCHDOG: true, AGENT_DELIVERY_WATCHDOG_MIN: 5 };

function row(over = {}) {
  return {
    id: 1,
    salon_id: 1,
    dialog_key: '79773115566',
    channel: 'whatsapp',
    phone: '79773115566',
    chat_id: '79773115566@c.us',
    reply_to_message_id: 'm1',
    delivery_id: '376412700',
    text: 'Здравствуйте! Я Мила.',
    status: 'pending',
    retry_of: null,
    created_at: new Date(NOW - 10 * 60000).toISOString(),
    ...over,
  };
}

function store(over = {}) {
  return {
    insert: jest.fn(async () => 42),
    listPending: jest.fn(async () => []),
    isConfirmed: jest.fn(async () => false),
    hasRetry: jest.fn(async () => false),
    setStatus: jest.fn(async () => {}),
    repointChatRow: jest.fn(async () => {}),
    ...over,
  };
}

beforeEach(() => { for (const fn of Object.values(mockLogger)) fn.mockClear(); });

// ── decide: чистое правило ──────────────────────────────────
test('подтверждение пришло → строка закрывается, что бы ни было с возрастом', () => {
  expect(watchdog.decide(row(), { confirmed: true, thresholdMin: 5, nowMs: NOW })).toBe('confirm');
  expect(watchdog.decide(row({ retry_of: 1 }), { confirmed: true, thresholdMin: 5, nowMs: NOW })).toBe('confirm');
});

test('порог ещё не вышел → ждём', () => {
  const fresh = row({ created_at: new Date(NOW - 60000).toISOString() });
  expect(watchdog.decide(fresh, { confirmed: false, thresholdMin: 5, nowMs: NOW })).toBe('wait');
});

test('порог вышел, попытка первая → повтор', () => {
  expect(watchdog.decide(row(), { confirmed: false, thresholdMin: 5, nowMs: NOW })).toBe('retry');
});

test('не подтвердился САМ повтор → второй раз не шлём, зовём человека', () => {
  expect(watchdog.decide(row({ retry_of: 7 }), { confirmed: false, thresholdMin: 5, nowMs: NOW }))
    .toBe('escalate');
});

test('протухшая первая попытка не переотправляется, а уходит к человеку', () => {
  // Процесс мог лежать часами (pm2 restart, OOM): ответ на ночной вопрос,
  // ушедший днём, хуже молчания — но клиент-то остался без ответа.
  const old = row({ created_at: new Date(NOW - (watchdog.MAX_RETRY_AGE_MIN + 1) * 60000).toISOString() });
  expect(watchdog.decide(old, { confirmed: false, thresholdMin: 5, nowMs: NOW })).toBe('escalate');
});

test('битая дата не превращается в «пора повторять»', () => {
  const broken = row({ created_at: 'не дата' });
  expect(watchdog.decide(broken, { confirmed: false, thresholdMin: 5, nowMs: NOW })).toBe('wait');
});

// ── sweep: проход ───────────────────────────────────────────
test('рычаг AGENT_DELIVERY_WATCHDOG=false гасит проход целиком', async () => {
  const st = store({ listPending: jest.fn(async () => [row()]) });
  const r = await watchdog.sweep({ store: st, config: { AGENT_DELIVERY_WATCHDOG: false }, nowMs: NOW });
  expect(r.skipped).toBe('disabled');
  expect(st.listPending).not.toHaveBeenCalled();
});

test('подтверждённая строка закрывается без отправки', async () => {
  const st = store({ listPending: jest.fn(async () => [row()]), isConfirmed: jest.fn(async () => true) });
  const send = jest.fn();
  const r = await watchdog.sweep({ store: st, config: cfg, nowMs: NOW, send, escalate: jest.fn() });
  expect(send).not.toHaveBeenCalled();
  expect(st.setStatus).toHaveBeenCalledWith(1, 'confirmed');
  expect(r.confirmed).toBe(1);
});

test('неподтверждённая реплика уходит повтором, старая строка помечается retried', async () => {
  const st = store({ listPending: jest.fn(async () => [row()]) });
  const send = jest.fn(async () => ({ id: 999 }));
  const escalate = jest.fn();
  const r = await watchdog.sweep({ store: st, config: cfg, nowMs: NOW, send, escalate });
  expect(send).toHaveBeenCalledTimes(1);
  // Новая строка журнала обязана быть привязана к исходной: без retry_of повтор
  // сам считался бы «первой попыткой» и цикл переотправок стал бы бесконечным.
  expect(st.insert).toHaveBeenCalledWith(expect.objectContaining({
    deliveryId: 999, retryOf: 1, text: 'Здравствуйте! Я Мила.', dialogKey: '79773115566',
  }));
  expect(st.setStatus).toHaveBeenCalledWith(1, 'retried');
  expect(escalate).not.toHaveBeenCalled();
  expect(r.retried).toBe(1);
});

test('строка «Чата» перецепляется на новый delivery — иначе эхо повтора задвоит ответ', async () => {
  const st = store({ listPending: jest.fn(async () => [row()]) });
  await watchdog.sweep({ store: st, config: cfg, nowMs: NOW, send: async () => ({ id: 999 }), escalate: jest.fn() });
  expect(st.repointChatRow).toHaveBeenCalledWith(1, '376412700', 999);
});

test('в не-WhatsApp каналах строку «Чата» не трогаем (её кладёт эхо, а не мы)', async () => {
  const st = store({ listPending: jest.fn(async () => [row({ channel: 'tdlib' })]) });
  await watchdog.sweep({ store: st, config: cfg, nowMs: NOW, send: async () => ({ id: 999 }), escalate: jest.fn() });
  expect(st.repointChatRow).not.toHaveBeenCalled();
});

test('повтор тоже не подтвердился → перевод на администратора, третьей отправки нет', async () => {
  const st = store({ listPending: jest.fn(async () => [row({ id: 2, retry_of: 1 })]) });
  const send = jest.fn();
  const escalate = jest.fn(async () => ({ escalated: true }));
  const r = await watchdog.sweep({ store: st, config: cfg, nowMs: NOW, send, escalate });
  expect(send).not.toHaveBeenCalled();
  expect(escalate).toHaveBeenCalledWith(1, '79773115566', expect.stringContaining('376412700'));
  expect(st.setStatus).toHaveBeenCalledWith(2, 'failed');
  expect(r.escalated).toBe(1);
});

test('сбой повтора оставляет строку pending — её разберёт следующий тик', async () => {
  const st = store({ listPending: jest.fn(async () => [row()]) });
  const send = jest.fn(async () => { throw new Error('Chatpush 500'); });
  await watchdog.sweep({ store: st, config: cfg, nowMs: NOW, send, escalate: jest.fn() });
  expect(st.setStatus).not.toHaveBeenCalled();
  expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Chatpush 500'));
});

test('повтор, не принятый Chatpush (пустой delivery), не закрывает исходную строку', async () => {
  const st = store({ listPending: jest.fn(async () => [row()]) });
  await watchdog.sweep({ store: st, config: cfg, nowMs: NOW, send: async () => null, escalate: jest.fn() });
  expect(st.insert).not.toHaveBeenCalled();
  expect(st.setStatus).not.toHaveBeenCalled();
});

// ── record: запись отправки ─────────────────────────────────
test('record кладёт delivery_id, текст и адресацию реплики', async () => {
  const st = store();
  const meta = { phone: '79773115566', channel: 'whatsapp', messageId: 'm1', chatId: '79773115566@c.us' };
  const id = await watchdog.record(1, '79773115566', meta, 'текст', { id: 376412700 }, { store: st });
  expect(id).toBe(42);
  expect(st.insert).toHaveBeenCalledWith(expect.objectContaining({
    salonId: 1, dialogKey: '79773115566', channel: 'whatsapp',
    deliveryId: 376412700, replyToMessageId: 'm1', text: 'текст',
  }));
});

test('без delivery писать нечего (отправка застаблена в тестах и e2e)', async () => {
  const st = store();
  expect(await watchdog.record(1, 'k', {}, 'текст', undefined, { store: st })).toBeNull();
  expect(await watchdog.record(1, 'k', {}, 'текст', {}, { store: st })).toBeNull();
  expect(st.insert).not.toHaveBeenCalled();
});

test('сбой БД в журнале не бросает наружу — отправка важнее записи о ней', async () => {
  const st = store({ insert: jest.fn(async () => { throw new Error('db down'); }) });
  await expect(watchdog.record(1, 'k', {}, 'текст', { id: 1 }, { store: st })).resolves.toBeNull();
  expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
});

test('повтор уже ушёл прошлым тиком (пометка не легла) → второй раз не шлём', async () => {
  // Окно между удачной отправкой повтора и UPDATE исходной строки: сбой БД в нём
  // вернул бы строку следующим тиком как «первую попытку». Договорённость —
  // РОВНО один повтор, поэтому наличие строки-повтора важнее статуса исходной.
  const st = store({ listPending: jest.fn(async () => [row()]), hasRetry: jest.fn(async () => true) });
  const send = jest.fn();
  const r = await watchdog.sweep({ store: st, config: cfg, nowMs: NOW, send, escalate: jest.fn() });
  expect(send).not.toHaveBeenCalled();
  expect(st.setStatus).toHaveBeenCalledWith(1, 'retried');
  expect(r.retried).toBe(0);
});

// ── WhatsApp через свой шлюз (delivery_id g<n>, 01.11.2026) ─────────────
// Эхо шлюз синтезирует сам сразу после sendMessage — chatpush_events для него
// ничего не доказывает (31.10.2026: 79608575301, «Ожидание сообщения» у клиентки,
// а строка закрылась confirmed). Судим по квитанциям телефона получателя.
const gw = (statusId, error = null) => ({ id: 'g236', status: { status_id: statusId, description: '' }, error });

test('gatewayVerdict: квитанция → confirmed; «Отправлено» → sent; запрос повтора/5/1 → undelivered', () => {
  expect(watchdog.gatewayVerdict(gw(3))).toBe('confirmed');
  expect(watchdog.gatewayVerdict(gw(4))).toBe('confirmed');
  expect(watchdog.gatewayVerdict(gw(2))).toBe('sent');
  expect(watchdog.gatewayVerdict(gw(2, `${watchdog.GATEWAY_RETRY_MARK}: запрос повтора 1`))).toBe('undelivered');
  expect(watchdog.gatewayVerdict(gw(5, 'WhatsApp отклонил'))).toBe('undelivered');
  expect(watchdog.gatewayVerdict(gw(1))).toBe('undelivered');
  expect(watchdog.gatewayVerdict(null)).toBe('undelivered');
});

test('маркер повтора совпадает с тем, что пишет шлюз', () => {
  const gwDeliveries = require('../gateway/lib/deliveries');
  expect(gwDeliveries.RETRY_ERROR_PREFIX).toBe(watchdog.GATEWAY_RETRY_MARK);
});

test('isGatewayDelivery: только whatsapp с g<n>', () => {
  expect(watchdog.isGatewayDelivery(row({ delivery_id: 'g236' }))).toBe(true);
  expect(watchdog.isGatewayDelivery(row({ delivery_id: '376412700' }))).toBe(false);
  expect(watchdog.isGatewayDelivery(row({ channel: 'tdlib', delivery_id: 'g235' }))).toBe(false);
});

test('шлюз: эхо в chatpush_events НЕ подтверждает, подтверждает квитанция', async () => {
  const st = store({ listPending: jest.fn(async () => [row({ delivery_id: 'g236' })]), isConfirmed: jest.fn(async () => true) });
  const send = jest.fn(async () => ({ id: 'g250' }));
  const gatewayStatus = jest.fn(async () => gw(3));
  const res = await watchdog.sweep({ config: cfg, store: st, send, gatewayStatus, nowMs: NOW });
  expect(st.isConfirmed).not.toHaveBeenCalled();
  expect(st.setStatus).toHaveBeenCalledWith(1, 'confirmed');
  expect(send).not.toHaveBeenCalled();
  expect(res.confirmed).toBe(1);
});

test('шлюз: получатель запросил повтор и квитанции нет → один повтор (как недоставка)', async () => {
  const st = store({ listPending: jest.fn(async () => [row({ delivery_id: 'g236' })]) });
  const send = jest.fn(async () => ({ id: 'g250' }));
  const gatewayStatus = jest.fn(async () => gw(2, `${watchdog.GATEWAY_RETRY_MARK}: запрос повтора 2`));
  const res = await watchdog.sweep({ config: cfg, store: st, send, gatewayStatus, nowMs: NOW });
  expect(send).toHaveBeenCalledTimes(1);
  expect(st.insert).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'g250', retryOf: 1 }));
  expect(res.retried).toBe(1);
});

test('шлюз: голое «Отправлено» — не повторяем и не зовём человека; через час закрываем sent', async () => {
  const send = jest.fn(); const escalate = jest.fn();
  const gatewayStatus = jest.fn(async () => gw(2));
  const st1 = store({ listPending: jest.fn(async () => [row({ delivery_id: 'g236' })]) });   // 10 мин
  await watchdog.sweep({ config: cfg, store: st1, send, escalate, gatewayStatus, nowMs: NOW });
  expect(st1.setStatus).not.toHaveBeenCalled();
  const old = row({ delivery_id: 'g236', created_at: new Date(NOW - (watchdog.MAX_RETRY_AGE_MIN + 1) * 60000).toISOString() });
  const st2 = store({ listPending: jest.fn(async () => [old]) });
  const res = await watchdog.sweep({ config: cfg, store: st2, send, escalate, gatewayStatus, nowMs: NOW });
  expect(st2.setStatus).toHaveBeenCalledWith(1, 'sent');
  expect(send).not.toHaveBeenCalled();
  expect(escalate).not.toHaveBeenCalled();
  expect(res.sent).toBe(1);
  expect(mockLogger.warn).toHaveBeenCalled();
});

test('шлюз: статус не получен → строка остаётся pending, ничего не шлём', async () => {
  const st = store({ listPending: jest.fn(async () => [row({ delivery_id: 'g236' })]) });
  const send = jest.fn();
  const gatewayStatus = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
  await watchdog.sweep({ config: cfg, store: st, send, gatewayStatus, nowMs: NOW });
  expect(send).not.toHaveBeenCalled();
  expect(st.setStatus).not.toHaveBeenCalled();
});

test('Chatpush-строки (числовой delivery_id) — по-прежнему по chatpush_events', async () => {
  const st = store({ listPending: jest.fn(async () => [row()]), isConfirmed: jest.fn(async () => true) });
  const gatewayStatus = jest.fn();
  await watchdog.sweep({ config: cfg, store: st, gatewayStatus, nowMs: NOW });
  expect(gatewayStatus).not.toHaveBeenCalled();
  expect(st.setStatus).toHaveBeenCalledWith(1, 'confirmed');
});
