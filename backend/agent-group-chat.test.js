'use strict';
const { isGroupChatId, isGroupMessage } = require('./services/agent/group-chat');

describe('isGroupChatId', () => {
  test('tdlib/MAX группа — chat_id с «-»', () => {
    expect(isGroupChatId('-1003759304044')).toBe(true);   // живая супергруппа tdlib
    expect(isGroupChatId('-72962629261478')).toBe(true);  // живая группа MAX
  });
  test('ключ диалога админки g:…', () => {
    expect(isGroupChatId('g:-1003759304044')).toBe(true);
  });
  test('WhatsApp группа и рассылка', () => {
    expect(isGroupChatId('120363012345678901@g.us')).toBe(true);
    expect(isGroupChatId('status@broadcast')).toBe(true);
  });
  test('личные чаты — не группа', () => {
    expect(isGroupChatId('79161119766@c.us')).toBe(false);  // WhatsApp личка
    expect(isGroupChatId('497419949')).toBe(false);         // tdlib личка
    expect(isGroupChatId('79200255591')).toBe(false);
  });
  test('пусто/мусор → не группа (не блокируем личку зря)', () => {
    expect(isGroupChatId('')).toBe(false);
    expect(isGroupChatId(null)).toBe(false);
    expect(isGroupChatId(undefined)).toBe(false);
  });
});

describe('isGroupMessage', () => {
  test('явный chat_type от Chatpush — главный признак', () => {
    // Живой MAX-payload группы «Админы PERI CLINIC»: chat_type='group'.
    expect(isGroupMessage({ chatType: 'group', chatId: '-72962629261478' })).toBe(true);
    expect(isGroupMessage({ chat_type: 'GROUP', chatId: '12345' })).toBe(true);
    expect(isGroupMessage({ chatType: 'channel', chatId: '12345' })).toBe(true);
    expect(isGroupMessage({ chatType: 'person', chatId: '226740104' })).toBe(false);
  });
  test('chat_type не пришёл (WhatsApp) → разбор jid', () => {
    expect(isGroupMessage({ chatType: null, chatId: '120363012345678901@g.us' })).toBe(true);
    expect(isGroupMessage({ chatType: '', chatId: '79161119766@c.us' })).toBe(false);
  });
  test('сообщение из группы с номером УЧАСТНИКА всё равно групповое', () => {
    // Ровно этот случай уводил Милу в личку участника: ключ диалога = phone.
    expect(isGroupMessage({ chatId: '-1003759304044', phone: '79202577754' })).toBe(true);
  });
  test('snake_case из БД тоже понимается', () => {
    expect(isGroupMessage({ chat_id: '-1003759304044', phone: null })).toBe(true);
  });
  test('личная переписка → false', () => {
    expect(isGroupMessage({ chatId: '226740104', phone: '79161119766' })).toBe(false);
    expect(isGroupMessage({ chatId: null, phone: '79161119766' })).toBe(false);
  });
  test('null/undefined → false', () => {
    expect(isGroupMessage(null)).toBe(false);
    expect(isGroupMessage(undefined)).toBe(false);
  });
});
