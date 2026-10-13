'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/wa-mapper');

test('phoneOfJid: pn-jid → цифры, lid/группа → null', () => {
  assert.equal(m.phoneOfJid('79001112233@s.whatsapp.net'), '79001112233');
  assert.equal(m.phoneOfJid('79001112233:12@s.whatsapp.net'), '79001112233');   // device suffix
  assert.equal(m.phoneOfJid('79001112233@c.us'), '79001112233');
  assert.equal(m.phoneOfJid('46810865385627@lid'), null);
  assert.equal(m.phoneOfJid('120363@g.us'), null);
  assert.equal(m.phoneOfJid(null), null);
});

test('lidOfJid: числовая часть @lid', () => {
  assert.equal(m.lidOfJid('46810865385627@lid'), '46810865385627');
  assert.equal(m.lidOfJid('79001112233@s.whatsapp.net'), null);
});

test('peerPhone: remoteJid pn → senderPn → кэш → null', () => {
  const key = (o) => ({ remoteJid: '46810865385627@lid', fromMe: false, id: 'A1', ...o });
  assert.equal(m.peerPhone(key({ remoteJid: '79001112233@s.whatsapp.net' }), () => null), '79001112233');
  assert.equal(m.peerPhone(key({ senderPn: '79001112233@s.whatsapp.net' }), () => null), '79001112233');
  assert.equal(m.peerPhone(key({}), (lid) => (lid === '46810865385627' ? '79005556677' : null)), '79005556677');
  assert.equal(m.peerPhone(key({}), () => null), null);
  // группа: номер участника
  assert.equal(m.peerPhone({ remoteJid: '1@g.us', participant: '79001112233@s.whatsapp.net' }, () => null), '79001112233');
  assert.equal(m.peerPhone({ remoteJid: '1@g.us', participant: '5@lid', participantPn: '79001112233@s.whatsapp.net' }, () => null), '79001112233');
});

test('chatIdOf: личный с номером → @c.us, без номера → @lid, группа как есть', () => {
  assert.equal(m.chatIdOf('46810865385627@lid', '79001112233'), '79001112233@c.us');
  assert.equal(m.chatIdOf('46810865385627@lid', null), '46810865385627@lid');
  assert.equal(m.chatIdOf('79001112233@s.whatsapp.net', '79001112233'), '79001112233@c.us');
  assert.equal(m.chatIdOf('120363@g.us', '79001112233'), '120363@g.us');
});

test('compositeId / parseCompositeId', () => {
  assert.equal(m.compositeId({ remoteJid: '1@lid', fromMe: true, id: '3EB0' }), 'true_1@lid_3EB0');
  assert.deepEqual(m.parseCompositeId('false_79001112233@s.whatsapp.net_ABC'), { fromMe: false, remoteJid: '79001112233@s.whatsapp.net', id: 'ABC' });
  assert.equal(m.parseCompositeId('5:17'), null);
});

test('contentOf: текст, медиа, служебное', () => {
  assert.deepEqual(m.contentOf({ conversation: 'hi' }), { type: 'text', text: 'hi', media: null });
  assert.deepEqual(m.contentOf({ extendedTextMessage: { text: 'hey' } }), { type: 'text', text: 'hey', media: null });
  assert.deepEqual(m.contentOf({ imageMessage: { caption: 'c', mimetype: 'image/jpeg', fileLength: 10 } }), { type: 'image', text: 'c', media: { contentType: 'imageMessage', mimeType: 'image/jpeg', fileName: null, size: 10 } });
  assert.deepEqual(m.contentOf({ documentMessage: { fileName: 'a.pdf', mimetype: 'application/pdf', caption: '' } }), { type: 'document', text: '', media: { contentType: 'documentMessage', mimeType: 'application/pdf', fileName: 'a.pdf', size: 0 } });
  assert.equal(m.contentOf({ audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } }).type, 'voice');
  assert.equal(m.contentOf({ audioMessage: { ptt: false, mimetype: 'audio/mpeg' } }).type, 'audio');
  assert.equal(m.contentOf({ videoMessage: { mimetype: 'video/mp4' } }).type, 'video');
  assert.equal(m.contentOf({ stickerMessage: {} }).type, 'sticker');
  assert.equal(m.contentOf({ contactMessage: {} }).type, 'contact');
  assert.equal(m.contentOf({ protocolMessage: {} }), null);
  assert.equal(m.contentOf({ reactionMessage: {} }), null);
  assert.equal(m.contentOf(null), null);
  // обёртки
  assert.deepEqual(m.contentOf({ ephemeralMessage: { message: { conversation: 'e' } } }), { type: 'text', text: 'e', media: null });
  assert.deepEqual(m.contentOf({ viewOnceMessageV2: { message: { conversation: 'v' } } }), { type: 'text', text: 'v', media: null });
});

test('tsOf: число, Long, строка', () => {
  assert.equal(m.tsOf(1700000000), 1700000000);
  assert.equal(m.tsOf({ toNumber: () => 1700000001 }), 1700000001);
  assert.equal(m.tsOf('1700000002'), 1700000002);
  assert.equal(m.tsOf(undefined), null);
});

test('isSkippedJid: статусы, рассылки, каналы', () => {
  assert.equal(m.isSkippedJid('status@broadcast'), true);
  assert.equal(m.isSkippedJid('123@broadcast'), true);
  assert.equal(m.isSkippedJid('123@newsletter'), true);
  assert.equal(m.isSkippedJid('79001112233@s.whatsapp.net'), false);
  assert.equal(m.isSkippedJid('1@g.us'), false);
});

test('buildWebhookBody: входящее из LID-чата, номер из senderPn', () => {
  const msg = { key: { remoteJid: '46810865385627@lid', fromMe: false, id: '3EB0', senderPn: '79001112233@s.whatsapp.net' }, pushName: 'Иван', messageTimestamp: 1700000000, message: { conversation: 'Привет' } };
  const body = m.buildWebhookBody({ accountId: 9, ownPhone: '79250177778', msg, peerPhone: '79001112233', deliveryId: null, fileUrl: null });
  assert.equal(body.type, 'whatsapp_incoming_msg');
  assert.equal(body.payload.provider, 'gateway');
  assert.equal(body.payload.customer_id, 9);
  assert.equal(body.payload.delivery_id, null);
  const nm = body.payload.new_message;
  assert.equal(nm.direction, 'incoming');
  assert.equal(nm.chat_id, '79001112233@c.us');
  assert.equal(nm.chat_phone, '79001112233');
  assert.equal(nm.sender_phone_number, '79001112233');
  assert.equal(nm.recipient_phone_number, '79250177778');
  assert.equal(nm.pushname, 'Иван');
  assert.deepEqual(nm.message, { id: 'false_46810865385627@lid_3EB0', type: 'text', text: 'Привет', timestamp: 1700000000, reply_to_message_id: null });
});

test('buildWebhookBody: исходящее с delivery_id, номера по сторонам, медиа с file_data', () => {
  const msg = { key: { remoteJid: '79001112233@s.whatsapp.net', fromMe: true, id: 'X1' }, messageTimestamp: 1700000005, message: { imageMessage: { caption: 'фото', mimetype: 'image/jpeg' } } };
  const body = m.buildWebhookBody({ accountId: 9, ownPhone: '79250177778', msg, peerPhone: '79001112233', deliveryId: 'g12', fileUrl: '/uploads/gateway/9/a.jpg' });
  const nm = body.payload.new_message;
  assert.equal(body.payload.delivery_id, 'g12');
  assert.equal(nm.direction, 'outgoing');
  assert.equal(nm.sender_phone_number, '79250177778');
  assert.equal(nm.recipient_phone_number, '79001112233');
  assert.equal(nm.pushname, null);
  assert.equal(nm.message.type, 'image');
  assert.deepEqual(nm.message.file_data, { download_url: '/uploads/gateway/9/a.jpg', mime_type: 'image/jpeg', caption: 'фото' });
});

test('buildWebhookBody: группа — chat_type group, номер участника в sender, recipient null у исходящего', () => {
  const msg = { key: { remoteJid: '120363@g.us', fromMe: false, id: 'G1', participant: '79001112233@s.whatsapp.net' }, messageTimestamp: 1, message: { conversation: 'в группе' } };
  const nm = m.buildWebhookBody({ accountId: 9, ownPhone: '79250177778', msg, peerPhone: '79001112233', deliveryId: null, fileUrl: null }).payload.new_message;
  assert.equal(nm.chat_id, '120363@g.us');
  assert.equal(nm.chat_type, 'group');
  assert.equal(nm.sender_phone_number, '79001112233');
  const out = m.buildWebhookBody({ accountId: 9, ownPhone: '79250177778', msg: { ...msg, key: { ...msg.key, fromMe: true } }, peerPhone: null, deliveryId: null, fileUrl: null }).payload.new_message;
  assert.equal(out.recipient_phone_number, null);
});

test('deliveryStatus — форма Chatpush', () => {
  assert.deepEqual(m.deliveryStatus({ id: 3, status_id: 2, description: 'Отправлено', error: null }), { id: 'g3', status: { status_id: 2, description: 'Отправлено' }, error: null });
});

// Живой прогон 12.10.2026: декодированный proto держит поля на ПРОТОТИПЕ со
// значением null — `conversation !== undefined` давал пустой «текст» любому сообщению.
function protoLike(own) {
  const P = { conversation: null, imageMessage: null, extendedTextMessage: null, protocolMessage: null, messageContextInfo: null };
  return Object.assign(Object.create(P), own);
}

test('contentOf: декодированный proto (поля-null на прототипе) — фото не становится пустым текстом', () => {
  const r = m.contentOf(protoLike({ imageMessage: { mimetype: 'image/jpeg', caption: '', fileLength: { toNumber: () => 1234 } }, messageContextInfo: {} }));
  assert.equal(r.type, 'image');
  assert.equal(r.media.size, 1234);
  assert.equal(m.contentOf(protoLike({ conversation: 'привет' })).text, 'привет');
});

test('contentOf: пустой/пробельный текст без медиа и служебное proto → null', () => {
  assert.equal(m.contentOf(protoLike({ protocolMessage: { type: 3 }, messageContextInfo: {} })), null);
  assert.equal(m.contentOf({ conversation: '', messageContextInfo: { deviceListMetadata: {} } }), null);
  assert.equal(m.contentOf({ conversation: '   ' }), null);
  assert.equal(m.contentOf({ extendedTextMessage: {} }), null);
  assert.equal(m.contentOf({ extendedTextMessage: { text: ' \n' } }), null);
  assert.equal(m.contentOf({ imageMessage: { mimetype: 'image/jpeg' } }).type, 'image');   // медиа без подписи — остаётся
});
