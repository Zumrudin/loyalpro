'use strict';

// Ручная отправка из «Чата» (routes/chat.js): адресация получателя и
// отложенная проверка судьбы доставки. Инцидент 2026-09-18 (tdlib 5245186003,
// номер скрыт): маршрут ответил ok, Chatpush через минуту поставил
// «Невозможно доставить» (status_id 5), и об этом не узнал никто — ни лог, ни
// админка. Повтор того же текста с reply_to последнего входящего дошёл.

jest.useFakeTimers();

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLogger }));
const mockDb = { oneOrNone: jest.fn(), any: jest.fn(async () => []), query: jest.fn(async () => ({ rows: [] })) };
jest.mock('./db', () => ({ db: mockDb, pool: {} }));

const { _internals } = require('./routes/chat');
const { resolveRecipient, scheduleDeliveryCheck, DELIVERY_STATUS_UNDELIVERABLE } = _internals;

beforeEach(() => {
  jest.clearAllMocks();
  jest.clearAllTimers();
});

describe('resolveRecipient', () => {
  test('входящее в том же канале → phone, chat_id и reply_to (id последнего входящего)', async () => {
    mockDb.oneOrNone.mockResolvedValueOnce({ phone: null, chat_id: '5245186003', reply_to: '48124395520' });
    const r = await resolveRecipient(1, '5245186003', 'tdlib');
    expect(r).toEqual({ phone: null, chat_id: '5245186003', reply_to: '48124395520' });
    expect(mockDb.oneOrNone).toHaveBeenCalledTimes(1);
  });

  test('в этом канале клиент не писал → фолбэк по номеру БЕЗ chat_id и БЕЗ reply_to', async () => {
    mockDb.oneOrNone
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ phone: '79001112233', chat_id: '385578542', reply_to: '111' });
    const r = await resolveRecipient(1, '79001112233', 'whatsapp');
    expect(r).toEqual({ phone: '79001112233', chat_id: null, reply_to: null });
  });

  test('входящих нет вовсе → null', async () => {
    mockDb.oneOrNone.mockResolvedValue(null);
    expect(await resolveRecipient(1, 'x', 'tdlib')).toBeNull();
  });
});

describe('scheduleDeliveryCheck', () => {
  test('статус «Невозможно доставить» → WARN с delivery id и ключом диалога', async () => {
    const get = jest.fn(async () => ({ id: 390862258, status: { description: 'Невозможно доставить', status_id: DELIVERY_STATUS_UNDELIVERABLE } }));
    scheduleDeliveryCheck(390862258, { key: '5245186003', channel: 'tdlib' }, { getDeliveryStatus: get, delayMs: 1000 });
    expect(get).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1000);
    expect(get).toHaveBeenCalledWith(390862258);
    const line = mockLogger.warn.mock.calls.map(c => String(c[0])).find(s => /390862258/.test(s));
    expect(line).toBeDefined();
    expect(line).toMatch(/5245186003/);
    expect(line).toMatch(/НЕ ДОСТАВЛЕНО/);
  });

  test('«Доставлено» → только INFO, без WARN', async () => {
    const get = jest.fn(async () => ({ status: { description: 'Доставлено', status_id: 2 } }));
    scheduleDeliveryCheck(1, { key: 'k', channel: 'tdlib' }, { getDeliveryStatus: get, delayMs: 1000 });
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.info.mock.calls.map(c => String(c[0])).some(s => /delivery=1\b/.test(s))).toBe(true);
  });

  test('Chatpush не ответил → WARN, исключение наружу не уходит', async () => {
    const get = jest.fn(async () => { throw new Error('timeout'); });
    scheduleDeliveryCheck(2, { key: 'k', channel: 'whatsapp' }, { getDeliveryStatus: get, delayMs: 1000 });
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockLogger.warn.mock.calls.map(c => String(c[0])).some(s => /delivery=2\b/.test(s) && /timeout/.test(s))).toBe(true);
  });
});
