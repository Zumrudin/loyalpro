'use strict';
// Контракт: тело вебхука шлюза разбирается РЕАЛЬНЫМ парсером бэкенда.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/mapper');
// config бэкенда требует JWT_SECRET при загрузке; для чистого парсера значение не важно.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32);
const chatpush = require('../../backend/services/chatpush');

const priv = (id) => ({ type: { _: 'chatTypePrivate', user_id: id } });

test('контракт: входящее личное с reply, номер скрыт', () => {
  const body = m.buildWebhookBody({
    accountId: 42, ownPhone: '79250177778',
    message: { id: 10, chat_id: 5245186003, is_outgoing: false, date: 1700000000,
      reply_to: { _: 'messageReplyToMessage', chat_id: 5245186003, message_id: 9 }, content: { _: 'messageText', text: { text: 'Привет' } } },
    chat: priv(5245186003), peer: { id: 5245186003, phone_number: '', first_name: 'Дарья', last_name: '' },
    deliveryId: null, fileUrl: null,
  });
  const e = chatpush.parseMessageEvent(body);
  assert.equal(e.channel, 'tdlib');
  assert.equal(e.direction, 'incoming');
  assert.equal(e.customerId, 42);
  assert.equal(e.messageId, '5245186003:10');
  assert.equal(e.replyToMessageId, '5245186003:9');
  assert.equal(e.phone, null);
  assert.equal(e.chatType, 'person');
  assert.equal(e.chatId, '5245186003');
  assert.equal(e.text, 'Привет');
  assert.equal(e.deliveryId, null);
});

test('контракт: входящее с номером клиента', () => {
  const body = m.buildWebhookBody({
    accountId: 42, ownPhone: '79250177778',
    message: { id: 1, chat_id: 7, is_outgoing: false, date: 1, content: { _: 'messageText', text: { text: 'a' } } },
    chat: priv(7), peer: { id: 7, phone_number: '+7 900 111-22-33', first_name: 'И', last_name: '' }, deliveryId: null, fileUrl: null,
  });
  assert.equal(chatpush.parseMessageEvent(body).phone, '79001112233');
});

test('контракт: исходящее с delivery_id, phone — клиент, не мы', () => {
  const body = m.buildWebhookBody({
    accountId: 42, ownPhone: '79250177778',
    message: { id: 2, chat_id: 777, is_outgoing: true, date: 1, content: { _: 'messageText', text: { text: 'ok' } } },
    chat: priv(777), peer: { id: 777, phone_number: '79001112233', first_name: 'Иван', last_name: '' },
    deliveryId: 'g12', fileUrl: null,
  });
  const e = chatpush.parseMessageEvent(body);
  assert.equal(e.direction, 'outgoing');
  assert.equal(e.phone, '79001112233');
  assert.equal(e.deliveryId, 'g12');
  assert.equal(e.messageId, '777:2');
});

test('контракт: исходящее при скрытом номере → phone null (не номер клиники)', () => {
  const body = m.buildWebhookBody({
    accountId: 42, ownPhone: '79250177778',
    message: { id: 2, chat_id: 777, is_outgoing: true, date: 1, content: { _: 'messageText', text: { text: 'ok' } } },
    chat: priv(777), peer: { id: 777, phone_number: '', first_name: 'И', last_name: '' }, deliveryId: 'g1', fileUrl: null,
  });
  assert.equal(chatpush.parseMessageEvent(body).phone, null);
});

test('контракт: медиа → fileUrl и mimeType', () => {
  const body = m.buildWebhookBody({
    accountId: 42, ownPhone: '7925',
    message: { id: 4, chat_id: 5, is_outgoing: false, date: 1, content: { _: 'messagePhoto', caption: { text: 'см' }, photo: { sizes: [{ width: 10, photo: { id: 1 } }] } } },
    chat: priv(5), peer: { id: 5, phone_number: '', first_name: '', last_name: '' }, deliveryId: null, fileUrl: '/uploads/gateway/1/abc.jpg',
  });
  const e = chatpush.parseMessageEvent(body);
  assert.equal(e.fileUrl, '/uploads/gateway/1/abc.jpg');
  assert.equal(e.mimeType, 'image/jpeg');
  assert.equal(e.text, 'см');
  assert.equal(e.type, 'image');
});
