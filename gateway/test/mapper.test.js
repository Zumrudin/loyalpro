'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/mapper');

test('normalizePhone: +7/8/10 цифр → 7XXXXXXXXXX, мусор → null', () => {
  assert.equal(m.normalizePhone('+7 (900) 111-22-33'), '79001112233');
  assert.equal(m.normalizePhone('89001112233'), '79001112233');
  assert.equal(m.normalizePhone('9001112233'), '79001112233');
  assert.equal(m.normalizePhone(''), null);
  assert.equal(m.normalizePhone(null), null);
});

test('composite id: собрать и разобрать', () => {
  assert.equal(m.compositeId(123, 456), '123:456');
  assert.deepEqual(m.parseCompositeId('123:456'), { chatId: 123, messageId: 456 });
  assert.deepEqual(m.parseCompositeId('-100123:7'), { chatId: -100123, messageId: 7 });
  assert.equal(m.parseCompositeId('abc'), null);
  assert.equal(m.parseCompositeId('398818547'), null);   // id Chatpush-эпохи — не наш формат, игнорируем
  assert.equal(m.parseCompositeId(null), null);
});

test('contentOf: текст', () => {
  assert.deepEqual(m.contentOf({ _: 'messageText', text: { _: 'formattedText', text: 'Привет' } }),
    { type: 'formattedText', text: 'Привет', file: null });
});

test('contentOf: фото → самый большой размер, подпись', () => {
  const c = m.contentOf({ _: 'messagePhoto', caption: { text: 'подпись' },
    photo: { sizes: [{ type: 's', width: 100, photo: { id: 1 } }, { type: 'y', width: 800, photo: { id: 2 } }] } });
  assert.equal(c.type, 'image'); assert.equal(c.text, 'подпись');
  assert.deepEqual(c.file, { id: 2, mimeType: 'image/jpeg', fileName: null });
});

test('contentOf: документ и голосовое', () => {
  const d = m.contentOf({ _: 'messageDocument', caption: { text: '' }, document: { file_name: 'a.pdf', mime_type: 'application/pdf', document: { id: 5 } } });
  assert.deepEqual(d, { type: 'document', text: '', file: { id: 5, mimeType: 'application/pdf', fileName: 'a.pdf' } });
  const v = m.contentOf({ _: 'messageVoiceNote', voice_note: { mime_type: 'audio/ogg', voice: { id: 6 } } });
  assert.equal(v.type, 'voice'); assert.equal(v.file.id, 6);
});

test('contentOf: прочее → unsupported без файла', () => {
  assert.deepEqual(m.contentOf({ _: 'messageSticker' }), { type: 'unsupported', text: '', file: null });
});

test('buildWebhookBody: входящее личное', () => {
  const body = m.buildWebhookBody({
    accountId: 42, ownPhone: '79250177778',
    message: { id: 1048576, chat_id: 5245186003, is_outgoing: false, date: 1700000000, reply_to: null, content: { _: 'messageText', text: { text: 'Здравствуйте' } } },
    chat: { type: { _: 'chatTypePrivate', user_id: 5245186003 } },
    peer: { id: 5245186003, phone_number: '', first_name: 'Дарья', last_name: '' },
    deliveryId: null, fileUrl: null,
  });
  assert.equal(body.type, 'tdlib_incoming_msg');
  assert.equal(body.payload.provider, 'gateway');
  assert.equal(body.payload.customer_id, 42);
  assert.equal(body.payload.direction, 'incoming');
  assert.equal(body.payload.chat_id, '5245186003');
  assert.equal(body.payload.chat_type, 'person');
  assert.equal(body.payload.sender_phone_number, null);          // номер скрыт
  assert.equal(body.payload.recipient_phone_number, '79250177778');
  assert.equal(body.payload.sender_name, 'Дарья');
  assert.equal(body.payload.delivery_id, null);
  assert.equal(body.payload.timestamp, 1700000000);
  assert.deepEqual(body.payload.message, { id: '5245186003:1048576', type: 'formattedText', text: 'Здравствуйте', timestamp: 1700000000, reply_to_message_id: null });
});

test('buildWebhookBody: исходящее с delivery_id, номер собеседника в recipient, reply_to составной', () => {
  const body = m.buildWebhookBody({
    accountId: 42, ownPhone: '79250177778',
    message: { id: 2, chat_id: 777, is_outgoing: true, date: 1, reply_to: { _: 'messageReplyToMessage', chat_id: 777, message_id: 1 }, content: { _: 'messageText', text: { text: 'ok' } } },
    chat: { type: { _: 'chatTypePrivate', user_id: 777 } },
    peer: { id: 777, phone_number: '79001112233', first_name: 'Иван', last_name: 'Петров' },
    deliveryId: 'g12', fileUrl: null,
  });
  assert.equal(body.payload.direction, 'outgoing');
  assert.equal(body.payload.sender_phone_number, '79250177778');
  assert.equal(body.payload.recipient_phone_number, '79001112233');
  assert.equal(body.payload.recipient_username, 'Иван Петров');
  assert.equal(body.payload.delivery_id, 'g12');
  assert.equal(body.payload.message.reply_to_message_id, '777:1');
});

test('buildWebhookBody: группа → chat_type group, номер участника в sender', () => {
  const body = m.buildWebhookBody({
    accountId: 1, ownPhone: '7',
    message: { id: 3, chat_id: -100555, is_outgoing: false, date: 1, content: { _: 'messageText', text: { text: 'x' } }, sender_id: { _: 'messageSenderUser', user_id: 9 } },
    chat: { type: { _: 'chatTypeSupergroup', supergroup_id: 555 } },
    peer: { id: 9, phone_number: '79001112233', first_name: 'Участник', last_name: '' },
    deliveryId: null, fileUrl: null,
  });
  assert.equal(body.payload.chat_type, 'group');
  assert.equal(body.payload.chat_id, '-100555');
  assert.equal(body.payload.sender_phone_number, '79001112233');
});

test('buildWebhookBody: медиа → file_data', () => {
  const body = m.buildWebhookBody({
    accountId: 1, ownPhone: '7',
    message: { id: 4, chat_id: 5, is_outgoing: false, date: 1, content: { _: 'messagePhoto', caption: { text: 'см' }, photo: { sizes: [{ width: 10, photo: { id: 1 } }] } } },
    chat: { type: { _: 'chatTypePrivate', user_id: 5 } }, peer: { id: 5, phone_number: '', first_name: '', last_name: '' },
    deliveryId: null, fileUrl: '/uploads/gateway/1/abc.jpg',
  });
  assert.equal(body.payload.message.type, 'image');
  assert.deepEqual(body.payload.message.file_data, { download_url: '/uploads/gateway/1/abc.jpg', mime_type: 'image/jpeg', caption: 'см' });
});

test('buildWebhookBody: медиа без скачанного файла → без file_data, текст = подпись', () => {
  const body = m.buildWebhookBody({
    accountId: 1, ownPhone: '7',
    message: { id: 4, chat_id: 5, is_outgoing: false, date: 1, content: { _: 'messagePhoto', caption: { text: 'см' }, photo: { sizes: [{ width: 10, photo: { id: 1 } }] } } },
    chat: { type: { _: 'chatTypePrivate', user_id: 5 } }, peer: { id: 5, phone_number: '', first_name: '', last_name: '' },
    deliveryId: null, fileUrl: null,
  });
  assert.equal(body.payload.message.type, 'image');
  assert.equal(body.payload.message.file_data, undefined);
  assert.equal(body.payload.message.text, 'см');
});

test('deliveryStatus: маппинг в форму Chatpush', () => {
  assert.deepEqual(m.deliveryStatus({ id: 12, status_id: 6, description: 'Принято', error: null }),
    { id: 'g12', status: { status_id: 6, description: 'Принято' }, error: null });
});
