'use strict';
// adoptPhoneForChat — склейка переписки, у которой номер клиента стал известен
// посреди диалога (инцидент 2026-08-10). Драйвер БД замокан: проверяем РЕШЕНИЕ
// (звать ли UPDATE и с какими параметрами), а не сам SQL.
jest.mock('./db', () => ({ db: { query: jest.fn(), oneOrNone: jest.fn() } }));
const { db } = require('./db');
const { adoptPhoneForChat } = require('./services/chat-persist');

beforeEach(() => { db.query.mockReset(); db.query.mockResolvedValue({ rowCount: 3 }); });

describe('adoptPhoneForChat', () => {
  test('личный чат: номер дописывается прежним строкам без номера', async () => {
    await expect(adoptPhoneForChat(1, '374647823', '79191091250')).resolves.toBe(3);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE chatpush_messages/);
    expect(sql).toMatch(/phone IS NULL OR phone = ''/);
    expect(params).toEqual([1, '374647823', '79191091250']);
  });

  test('группа: номер участника чужой строке не принадлежит — не трогаем', async () => {
    await expect(adoptPhoneForChat(1, '-72962629261478', '79250177778')).resolves.toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('группа WhatsApp (jid @g.us) тоже не трогается', async () => {
    await expect(adoptPhoneForChat(1, '79991234567-1500000000@g.us', '79191091250')).resolves.toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('без салона, чата или номера ничего не делаем', async () => {
    await expect(adoptPhoneForChat(null, '374647823', '79191091250')).resolves.toBe(0);
    await expect(adoptPhoneForChat(1, '', '79191091250')).resolves.toBe(0);
    await expect(adoptPhoneForChat(1, '374647823', '  ')).resolves.toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });
});

test('успешный персист исходящего подтверждает pending, ошибка БД сохраняет резерв', async () => {
  const pending = require('./services/agent/pending-replies');
  const { persistWhatsappOutgoing } = require('./services/chat-persist');
  const { dialogKey } = require('./services/chat');
  const key = dialogKey({ chat_id: 'synthetic-persist' });
  const text = 'Подобрать время?';
  pending._reset();
  pending.remember(1, key, text);
  db.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1 }] });
  await persistWhatsappOutgoing(1, { delivery: { id: 'synthetic' }, chatId: 'synthetic-persist', text, msgType: 'text' });
  expect(pending.peek(1, key)).toEqual([]);
  pending.remember(1, key, text);
  db.query.mockRejectedValueOnce(new Error('synthetic database failure'));
  await expect(persistWhatsappOutgoing(1, { delivery: { id: 'synthetic-2' }, chatId: 'synthetic-persist', text, msgType: 'text' })).rejects.toThrow();
  expect(pending.peek(1, key)).toHaveLength(1);
  pending._reset();
});
