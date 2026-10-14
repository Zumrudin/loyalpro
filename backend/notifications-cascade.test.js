'use strict';
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn() } }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
const { db } = require('./db');
const { buildCascade, recipientFor, CASCADE_CHANNELS } = require('./services/notifications/cascade');
const { lastConversation } = require('./services/notifications/rules');

describe('buildCascade', () => {
  test('порядок из настроек, без дублей и неизвестных каналов', () => {
    expect(buildCascade(['tdlib', 'whatsapp', 'tdlib', 'sms', 'max'])).toEqual(['tdlib', 'whatsapp', 'max']);
  });
  test('мессенджер последней переписки встаёт первым', () => {
    expect(buildCascade(['tdlib', 'whatsapp', 'max'], { preferLast: true, lastChannel: 'max' })).toEqual(['max', 'tdlib', 'whatsapp']);
  });
  test('флаг выключен — последняя переписка не влияет', () => {
    expect(buildCascade(['tdlib', 'whatsapp'], { preferLast: false, lastChannel: 'whatsapp' })).toEqual(['tdlib', 'whatsapp']);
  });
  test('мессенджер последней переписки выключен в настройках — не добавляется', () => {
    expect(buildCascade(['tdlib', 'whatsapp'], { preferLast: true, lastChannel: 'max' })).toEqual(['tdlib', 'whatsapp']);
  });
  test('пустые/битые настройки → пустой каскад', () => {
    expect(buildCascade(null)).toEqual([]);
    expect(buildCascade('tdlib')).toEqual([]);
  });
  test('поддерживаемые каналы — ровно три мессенджера шлюза', () => {
    expect(CASCADE_CHANNELS).toEqual(['tdlib', 'whatsapp', 'max']);
  });
});

describe('recipientFor', () => {
  test('WhatsApp — только по номеру', () => {
    expect(recipientFor('whatsapp', '79200255591', {})).toEqual({ dispatchRouting: ['whatsapp'], phone: '79200255591' });
    expect(recipientFor('whatsapp', null, { whatsapp: 'x' })).toBeNull();
  });
  test('Telegram — id собеседника главнее номера (скрытый номер)', () => {
    expect(recipientFor('tdlib', '79200255591', { tdlib: '385578542' })).toEqual({ dispatchRouting: ['tdlib'], tdlib_user_id: '385578542' });
    expect(recipientFor('tdlib', '79200255591', {})).toEqual({ dispatchRouting: ['tdlib'], phone: '79200255591' });
  });
  test('MAX — номер и id собеседника вместе', () => {
    expect(recipientFor('max', '79200255591', { max: '62232990' })).toEqual({ dispatchRouting: ['max'], phone: '79200255591', max_user_id: '62232990' });
    expect(recipientFor('max', '79200255591', {})).toEqual({ dispatchRouting: ['max'], phone: '79200255591' });
  });
  test('номер нормализуется к 7XXXXXXXXXX, мусор — нет адресата', () => {
    expect(recipientFor('whatsapp', '+7 (920) 025-55-91', {})).toEqual({ dispatchRouting: ['whatsapp'], phone: '79200255591' });
    expect(recipientFor('whatsapp', '12345', {})).toBeNull();
    expect(recipientFor('tdlib', '', {})).toBeNull();
  });
  test('неизвестный канал → null', () => {
    expect(recipientFor('sms', '79200255591', {})).toBeNull();
  });
});

// ── lastConversation (rules.js): запросы к chatpush_messages, БД замокана ──
// Валидность самого SQL и план (индекс idx_chatpush_messages_dialog) проверены живым
// EXPLAIN на дев-БД — моки её не проверяют.
describe('lastConversation', () => {
  const FORMS = ['79200255591', '+79200255591', '89200255591', '9200255591'];
  beforeEach(() => {
    jest.clearAllMocks();
    db.any.mockResolvedValue([]);
    db.oneOrNone.mockResolvedValue(null);
  });

  test('мусорный номер → пусто и ни одного запроса к БД', async () => {
    for (const bad of [null, undefined, '', '12345', 'abc', '+998 90 123 45 67']) {
      expect(await lastConversation(1, bad)).toEqual({ lastChannel: null, chats: {} });
    }
    expect(db.any).not.toHaveBeenCalled();
    expect(db.oneOrNone).not.toHaveBeenCalled();
  });

  test('оба запроса ищут по ВСЕМ формам номера и скоупятся по салону', async () => {
    await lastConversation(7, '+7 (920) 025-55-91');
    expect(db.any).toHaveBeenCalledTimes(1);
    expect(db.oneOrNone).toHaveBeenCalledTimes(1);
    for (const [sql, params] of [db.any.mock.calls[0], db.oneOrNone.mock.calls[0]]) {
      expect(sql).toMatch(/salon_id\s*=\s*\$1/);
      expect(sql).toMatch(/phone\s*=\s*ANY\(\$2\)/);
      expect(params).toEqual([7, FORMS]);
    }
  });

  test('номер в любой записи даёт те же формы (8…, 10 цифр)', async () => {
    await lastConversation(1, '89200255591');
    await lastConversation(1, '9200255591');
    expect(db.any.mock.calls[0][1]).toEqual([1, FORMS]);
    expect(db.any.mock.calls[1][1]).toEqual([1, FORMS]);
  });

  test('chats — id личных чатов Telegram/MAX по каналам', async () => {
    db.any.mockResolvedValue([{ channel: 'max', chat_id: '62232990' }, { channel: 'tdlib', chat_id: '385578542' }]);
    const r = await lastConversation(1, '79200255591');
    expect(r.chats).toEqual({ tdlib: '385578542', max: '62232990' });
  });

  test('SQL уже отсекает группы (до DISTINCT ON), только tdlib/max, только непустой chat_id', async () => {
    await lastConversation(1, '79200255591');
    const sql = db.any.mock.calls[0][0];
    expect(sql).toMatch(/DISTINCT ON \(channel\)/);
    expect(sql).toMatch(/channel IN \('tdlib','max'\)/);
    expect(sql).toMatch(/chat_id NOT LIKE '-%'/);
    expect(sql).toMatch(/chat_id NOT LIKE 'g:%'/);
    expect(sql).toMatch(/COALESCE\(chat_id,''\) <> ''/);
  });

  test('группы не попадают в chats и после SQL: общий признак group-chat.isGroupChatId — последнее слово', async () => {
    db.any.mockResolvedValue([
      { channel: 'tdlib', chat_id: '-1003759304044' },   // супергруппа Telegram
      { channel: 'max', chat_id: 'g:-5' },               // ключ диалога админки
    ]);
    expect((await lastConversation(1, '79200255591')).chats).toEqual({});
    db.any.mockResolvedValue([{ channel: 'tdlib', chat_id: '120363025@g.us' }, { channel: 'max', chat_id: '77@broadcast' }]);
    expect((await lastConversation(1, '79200255591')).chats).toEqual({});
  });

  test('lastChannel — канал последнего ВХОДЯЩЕГО, telegram_bot приводится к telegram', async () => {
    db.oneOrNone.mockResolvedValue({ channel: 'max' });
    expect((await lastConversation(1, '79200255591')).lastChannel).toBe('max');
    db.oneOrNone.mockResolvedValue({ channel: 'telegram_bot' });
    expect((await lastConversation(1, '79200255591')).lastChannel).toBe('telegram');
    db.oneOrNone.mockResolvedValue(null);
    expect((await lastConversation(1, '79200255591')).lastChannel).toBeNull();
    const sql = db.oneOrNone.mock.calls[0][0];
    expect(sql).toMatch(/direction\s*=\s*'incoming'/);
    expect(sql).toMatch(/ORDER BY msg_ts DESC NULLS LAST\s+LIMIT 1/);
  });
});
