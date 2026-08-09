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
