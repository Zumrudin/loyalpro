'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const m = require('../lib/max-mapper');

test('xorId: BigInt-безопасный XOR; peerIdOf — второй участник, иначе XOR', () => {
  assert.equal(m.xorId(11478793, 10001), 11478793 ^ 10001);
  assert.equal(m.xorId(9007199254740993n, 1n), 9007199254740992);        // за пределами 2^53 Number-XOR врал бы
  assert.equal(m.peerIdOf({ chatId: 11478793 ^ 10001, chat: { participants: { 10001: 1, 11478793: 1 } }, ownerId: 10001 }), 11478793);
  assert.equal(m.peerIdOf({ chatId: 11478793 ^ 10001, chat: null, ownerId: 10001 }), 11478793);
  assert.equal(m.peerIdOf({ chatId: 5, chat: { participants: { 10001: 1 } }, ownerId: 10001 }), 5 ^ 10001);   // в снимке только я → XOR
});

test('isGroupChat / isChannel: по типу чата, без снимка — по знаку id', () => {
  assert.equal(m.isGroupChat({ chatId: 7, chat: { type: 'DIALOG' } }), false);
  assert.equal(m.isGroupChat({ chatId: -72962629261478, chat: { type: 'CHAT' } }), true);
  assert.equal(m.isGroupChat({ chatId: -72962629261478, chat: null }), true);
  assert.equal(m.isGroupChat({ chatId: 7, chat: null }), false);
  assert.equal(m.isChannel({ type: 'CHANNEL' }), true);
  assert.equal(m.isChannel({ type: 'CHAT' }), false);
});

test('contentOf: текст, фото (baseUrl), файл (fileId/имя/размер/MIME по имени), голос, видео/стикер без файла', () => {
  assert.deepEqual(m.contentOf({ type: 'USER', text: 'Привет', attaches: [] }), { type: 'text', text: 'Привет', media: null });
  const photo = m.contentOf({ type: 'USER', text: 'см', attaches: [{ _type: 'PHOTO', baseUrl: 'https://i/1', width: 1, height: 1, photoId: 1, photoToken: 't' }] });
  assert.equal(photo.type, 'image'); assert.equal(photo.text, 'см'); assert.deepEqual(photo.media, { kind: 'PHOTO', url: 'https://i/1', fileId: null, fileName: null, mimeType: 'image/jpeg', size: 0 });
  const file = m.contentOf({ type: 'USER', text: '', attaches: [{ _type: 'FILE', fileId: 42, name: 'Прайс.PDF', size: 1234, token: 'x' }] });
  assert.equal(file.type, 'document'); assert.deepEqual(file.media, { kind: 'FILE', url: null, fileId: 42, fileName: 'Прайс.PDF', mimeType: 'application/pdf', size: 1234 });
  const voice = m.contentOf({ type: 'USER', attaches: [{ _type: 'AUDIO', url: 'https://a/1', duration: 3000 }] });
  assert.equal(voice.type, 'audio'); assert.equal(voice.media.url, 'https://a/1'); assert.equal(voice.media.mimeType, 'audio/ogg');
  assert.deepEqual(m.contentOf({ type: 'USER', attaches: [{ _type: 'VIDEO', token: 'v' }] }), { type: 'video', text: '', media: null });
  assert.deepEqual(m.contentOf({ type: 'USER', attaches: [{ _type: 'STICKER', url: 'https://s/1' }] }), { type: 'sticker', text: '', media: null });
  assert.deepEqual(m.contentOf({ type: 'USER', text: 'ссылка', attaches: [{ _type: 'SHARE', url: 'https://x' }] }), { type: 'text', text: 'ссылка', media: null });
});

test('contentOf: служебное, правка/удаление, CONTROL/CALL, пустой текст → null', () => {
  assert.equal(m.contentOf({ type: 'SYSTEM', text: 'x' }), null);
  assert.equal(m.contentOf({ type: 'CONTROL', attaches: [{ _type: 'CONTROL', event: 'new' }] }), null);
  assert.equal(m.contentOf({ type: 'USER', text: 'правка', status: 'EDITED' }), null);
  assert.equal(m.contentOf({ type: 'USER', text: '', status: 'REMOVED' }), null);
  assert.equal(m.contentOf({ type: 'USER', text: '', attaches: [{ _type: 'CALL', hangupType: 'MISSED' }] }), null);
  assert.equal(m.contentOf({ type: 'USER', text: '   ', attaches: [] }), null);
  assert.equal(m.contentOf(null), null);
});

test('tsSeconds: мс → с, с → с, мусор → null', () => {
  assert.equal(m.tsSeconds(1791657121000), 1791657121);
  assert.equal(m.tsSeconds(1791657121), 1791657121);
  assert.equal(m.tsSeconds(undefined), null);
});

const OWNER = 10001, PEER = 11478793;
const dialog = { chatId: OWNER ^ PEER, chat: { id: OWNER ^ PEER, type: 'DIALOG', participants: { [OWNER]: 1, [PEER]: 1 } } };

test('buildWebhookBody: входящее личное — плоская форма Chatpush, номер в sender_phone_number, chat_id = id собеседника', () => {
  const body = m.buildWebhookBody({ accountId: 9, ownPhone: '79250177778', ownerId: OWNER, ...dialog,
    message: { id: '117418041090250363', sender: PEER, time: 1791657121000, type: 'USER', text: 'Здравствуйте', attaches: [] },
    peer: { id: PEER, phone: '+79164942855', name: 'Mary' }, deliveryId: null, fileUrl: null });
  assert.equal(body.type, 'max_incoming_msg');
  const p = body.payload;
  assert.equal(p.provider, 'gateway'); assert.equal(p.customer_id, 9); assert.equal(p.direction, 'incoming');
  assert.equal(p.chat_id, String(PEER)); assert.equal(p.chat_type, 'person'); assert.equal(p.chat_name, 'Mary');
  assert.equal(p.sender_id, String(PEER)); assert.equal(p.sender_name, 'Mary'); assert.equal(p.sender_phone_number, '79164942855');
  assert.equal(p.recipient_id, String(OWNER)); assert.equal(p.recipient_phone_number, '79250177778');
  assert.equal(p.delivery_id, null); assert.equal(p.timestamp, 1791657121);
  assert.deepEqual(p.message, { id: '117418041090250363', type: 'text', text: 'Здравствуйте', timestamp: 1791657121, reply_to_message_id: null });
});

test('buildWebhookBody: исходящее (своё с телефона или наша отправка) — номер клиента в recipient_phone_number, delivery_id', () => {
  const body = m.buildWebhookBody({ accountId: 9, ownPhone: '79250177778', ownerId: OWNER, ...dialog,
    message: { id: '2', sender: OWNER, time: 1791657121000, type: 'USER', text: 'ok', link: { type: 'REPLY', message: { id: '1' } } },
    peer: { id: PEER, phone: '79164942855', name: 'Mary' }, deliveryId: 'g12', fileUrl: null });
  const p = body.payload;
  assert.equal(p.direction, 'outgoing'); assert.equal(p.chat_id, String(PEER));
  assert.equal(p.sender_id, String(OWNER)); assert.equal(p.sender_phone_number, '79250177778'); assert.equal(p.sender_name, null);
  assert.equal(p.recipient_id, String(PEER)); assert.equal(p.recipient_name, 'Mary'); assert.equal(p.recipient_phone_number, '79164942855');
  assert.equal(p.delivery_id, 'g12'); assert.equal(p.message.reply_to_message_id, '1');
});

test('buildWebhookBody: номер скрыт → null (не номер клиники); без снимка чата chat_id из XOR', () => {
  const body = m.buildWebhookBody({ accountId: 9, ownPhone: '79250177778', ownerId: OWNER, chatId: OWNER ^ PEER, chat: null,
    message: { id: '3', sender: PEER, time: 1, type: 'USER', text: 'x' }, peer: { id: PEER, phone: null, name: null }, deliveryId: null, fileUrl: null });
  assert.equal(body.payload.sender_phone_number, null); assert.equal(body.payload.chat_id, String(PEER));
  const noPeer = m.buildWebhookBody({ accountId: 9, ownPhone: '7', ownerId: OWNER, chatId: OWNER ^ PEER, chat: null,
    message: { id: '3', sender: PEER, time: 1, type: 'USER', text: 'x' }, peer: null, deliveryId: null, fileUrl: null });
  assert.equal(noPeer.payload.chat_id, String(PEER));
});

test('buildWebhookBody: группа — chat_id = id чата, chat_type group, имя группы, номер участника; исходящее в группу без recipient', () => {
  const g = { chatId: -72962629261478, chat: { id: -72962629261478, type: 'CHAT', title: 'Админы PERI CLINIC✨', participants: {} } };
  const inc = m.buildWebhookBody({ accountId: 9, ownPhone: '79250177778', ownerId: OWNER, ...g,
    message: { id: '5', sender: 555, time: 1, type: 'USER', text: 'в группу' }, peer: { id: 555, phone: '79001112233', name: 'Аня' }, deliveryId: null, fileUrl: null });
  assert.equal(inc.payload.chat_id, '-72962629261478'); assert.equal(inc.payload.chat_type, 'group'); assert.equal(inc.payload.chat_name, 'Админы PERI CLINIC✨');
  assert.equal(inc.payload.sender_phone_number, '79001112233'); assert.equal(inc.payload.sender_name, 'Аня');
  const out = m.buildWebhookBody({ accountId: 9, ownPhone: '79250177778', ownerId: OWNER, ...g,
    message: { id: '6', sender: OWNER, time: 1, type: 'USER', text: 'ответ' }, peer: null, deliveryId: null, fileUrl: null });
  assert.equal(out.payload.direction, 'outgoing'); assert.equal(out.payload.recipient_id, '-72962629261478'); assert.equal(out.payload.recipient_phone_number, null); assert.equal(out.payload.recipient_name, 'Админы PERI CLINIC✨');
});

test('buildWebhookBody: медиа с fileUrl → file_data (download_url, mime_type, file_name, caption)', () => {
  const body = m.buildWebhookBody({ accountId: 9, ownPhone: '7', ownerId: OWNER, ...dialog,
    message: { id: '7', sender: PEER, time: 1, type: 'USER', text: 'подпись', attaches: [{ _type: 'FILE', fileId: 1, name: 'a.pdf', size: 10 }] },
    peer: { id: PEER, phone: null, name: null }, deliveryId: null, fileUrl: '/uploads/gateway/9/x.pdf' });
  assert.equal(body.payload.message.type, 'document');
  assert.deepEqual(body.payload.message.file_data, { download_url: '/uploads/gateway/9/x.pdf', mime_type: 'application/pdf', file_name: 'a.pdf', caption: 'подпись' });
  const noFile = m.buildWebhookBody({ accountId: 9, ownPhone: '7', ownerId: OWNER, ...dialog,
    message: { id: '8', sender: PEER, time: 1, type: 'USER', text: '', attaches: [{ _type: 'PHOTO', baseUrl: 'u' }] }, peer: { id: PEER }, deliveryId: null, fileUrl: null });
  assert.equal(noFile.payload.message.file_data, undefined); assert.equal(noFile.payload.message.type, 'image');
});

test('mimeOfName: по расширению из белого списка, иначе octet-stream', () => {
  assert.equal(m.mimeOfName('Фото.JPG'), 'image/jpeg');
  assert.equal(m.mimeOfName('x.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(m.mimeOfName('x.exe'), 'application/octet-stream');
  assert.equal(m.mimeOfName(null), 'application/octet-stream');
});
