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

test('wa-mapper: тело разбирается backend chatpush.parseMessageEvent как whatsapp incoming с номером и chat_id', () => {
  const wa = require('../lib/wa-mapper');
  const msg = { key: { remoteJid: '46810865385627@lid', fromMe: false, id: '3EB0', senderPn: '79001112233@s.whatsapp.net' }, pushName: 'Иван', messageTimestamp: 1700000000, message: { conversation: 'Привет' } };
  const body = wa.buildWebhookBody({ accountId: 9, ownPhone: '79250177778', msg, peerPhone: '79001112233', deliveryId: null, fileUrl: null });
  const parsed = chatpush.parseMessageEvent(body);
  assert.equal(parsed.channel, 'whatsapp');
  assert.equal(parsed.direction, 'incoming');
  assert.equal(parsed.customerId, 9);
  assert.equal(parsed.phone, '79001112233');
  assert.equal(parsed.chatId, '79001112233@c.us');
  assert.equal(parsed.messageId, 'false_46810865385627@lid_3EB0');
  assert.equal(parsed.text, 'Привет');
  assert.equal(parsed.deliveryId, null);
  const out = wa.buildWebhookBody({ accountId: 9, ownPhone: '79250177778', msg: { ...msg, key: { remoteJid: '79001112233@s.whatsapp.net', fromMe: true, id: 'X' } }, peerPhone: '79001112233', deliveryId: 'g12', fileUrl: null });
  const po = chatpush.parseMessageEvent(out);
  assert.equal(po.direction, 'outgoing');
  assert.equal(po.phone, '79001112233');
  assert.equal(po.deliveryId, 'g12');
});

test('max-mapper: тело разбирается backend chatpush.parseMessageEvent как max incoming/outgoing с номером и chat_id', () => {
  const mx = require('../lib/max-mapper');
  const OWNER = 10001, PEER = 11478793;
  const base = { accountId: 9, ownPhone: '79250177778', ownerId: OWNER, chatId: OWNER ^ PEER, chat: { type: 'DIALOG', participants: { [OWNER]: 1, [PEER]: 1 } }, fileUrl: null };
  const inc = chatpush.parseMessageEvent(mx.buildWebhookBody({ ...base, message: { id: '117418041090250363', sender: PEER, time: 1791657121000, type: 'USER', text: 'Привет', link: { type: 'REPLY', message: { id: '117418041090250300' } } }, peer: { id: PEER, phone: '79164942855', name: 'Mary' }, deliveryId: null }));
  assert.equal(inc.channel, 'max'); assert.equal(inc.direction, 'incoming'); assert.equal(inc.customerId, 9);
  assert.equal(inc.messageId, '117418041090250363'); assert.equal(inc.replyToMessageId, '117418041090250300');
  assert.equal(inc.phone, '79164942855'); assert.equal(inc.chatId, String(PEER)); assert.equal(inc.chatType, 'person');
  assert.equal(inc.senderName, 'Mary'); assert.equal(inc.text, 'Привет'); assert.equal(inc.timestamp, 1791657121); assert.equal(inc.deliveryId, null);
  const out = chatpush.parseMessageEvent(mx.buildWebhookBody({ ...base, message: { id: '2', sender: OWNER, time: 1791657121000, type: 'USER', text: 'ok' }, peer: { id: PEER, phone: '79164942855', name: 'Mary' }, deliveryId: 'g12' }));
  assert.equal(out.direction, 'outgoing'); assert.equal(out.phone, '79164942855'); assert.equal(out.deliveryId, 'g12'); assert.equal(out.chatId, String(PEER));
  const hidden = chatpush.parseMessageEvent(mx.buildWebhookBody({ ...base, message: { id: '3', sender: OWNER, time: 1, type: 'USER', text: 'ok' }, peer: { id: PEER, phone: null, name: null }, deliveryId: 'g1' }));
  assert.equal(hidden.phone, null);
  const media = chatpush.parseMessageEvent(mx.buildWebhookBody({ ...base, message: { id: '4', sender: PEER, time: 1, type: 'USER', text: 'см', attaches: [{ _type: 'PHOTO', baseUrl: 'u' }] }, peer: { id: PEER }, deliveryId: null, fileUrl: '/uploads/gateway/9/a.webp', content: { type: 'image', text: 'см', media: { kind: 'PHOTO', url: 'u', fileId: null, fileName: null, mimeType: 'image/webp', size: 0 } } }));
  assert.equal(media.fileUrl, '/uploads/gateway/9/a.webp'); assert.equal(media.mimeType, 'image/webp'); assert.equal(media.type, 'image'); assert.equal(media.text, 'см');
  const group = chatpush.parseMessageEvent(mx.buildWebhookBody({ ...base, chatId: -72962629261478, chat: { type: 'CHAT', title: 'Админы' }, message: { id: '5', sender: 555, time: 1, type: 'USER', text: 'x' }, peer: { id: 555, phone: '79001112233', name: 'Аня' }, deliveryId: null }));
  assert.equal(group.chatType, 'group'); assert.equal(group.chatId, '-72962629261478'); assert.equal(group.phone, '79001112233');
});
