'use strict';
// WhatsappClient без Baileys: фейковый сокет с ev-эмиттером. Проверяем автомат
// соединения, QR/код привязки, фильтры входящих, эхо своей отправки с
// delivery_id и дедуп append-апсерта, статусы, отправку по номеру.
// Поведение фейка сверено с исходником Baileys 6.7.24 (node_modules):
// onWhatsApp ОТФИЛЬТРОВЫВАЕТ номера без WhatsApp (exists:false не приходит),
// сообщения из офлайн-очереди приходят upsert'ом type:'append'.
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { WhatsappClient, MAX_MESSAGE_AGE_S, MAX_QR_ROUNDS, MEDIA_UPLOAD_TIMEOUT_MS, MEDIA_DOWNLOAD_DEADLINE_MS } = require('../lib/whatsapp-client');

function fakeSock(over = {}) {
  const ev = new EventEmitter();
  const calls = [];
  return {
    ev, calls,
    ws: new EventEmitter(),             // сырые узлы протокола ('CB:message'), как sock.ws у Baileys
    user: { id: '79250177778:12@s.whatsapp.net', name: 'Клиника' },
    authState: { creds: { registered: false } },
    async sendMessage(jid, content) { calls.push(['sendMessage', jid, content]); return { key: { remoteJid: jid, fromMe: true, id: 'OUT1' }, message: content.text !== undefined ? { conversation: content.text } : { imageMessage: { caption: content.caption || '', mimetype: 'image/jpeg' } }, messageTimestamp: 1700000100 }; },
    // Как Baileys: list.filter(a => !!a.contact) — номера без WhatsApp в ответе просто нет.
    async onWhatsApp(p) { calls.push(['onWhatsApp', p]); return p === '70000000000' ? [] : [{ jid: `${p}@s.whatsapp.net`, exists: true }]; },
    async requestPairingCode(p) { calls.push(['requestPairingCode', p]); return 'ABCDEFGH'; },
    async logout() { calls.push(['logout']); },
    end() { calls.push(['end']); },
    ...over,
  };
}

function setup(over = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-wa-'));
  const sock = fakeSock(over.sock);
  const repoCalls = []; const delCalls = []; const hooks = [];
  const deps = {
    createSocket: async () => ({ sock, saveCreds: async () => {} }),
    qrToDataUrl: async (s) => `data:image/png;base64,${Buffer.from(s).toString('base64')}`,
    downloadMedia: async () => Buffer.from('JPEGDATA'),
    config: { DATA_DIR: tmp, PUBLIC_FILES_DIR: path.join(tmp, 'pub'), PUBLIC_FILES_URL: '/uploads/gateway' },
    repo: {
      setAuth: async (...a) => { repoCalls.push(['setAuth', ...a]); },
      phoneByLid: async () => over.lidPhone || null,
      rememberContact: async (...a) => { repoCalls.push(['rememberContact', ...a]); },
      rememberContacts: async (...a) => { repoCalls.push(['rememberContacts', ...a]); },
    },
    deliveries: {
      STATUS: { ACCEPTED: [1, 'Принято'], SENT: [2, 'Отправлено'], FAILED: [5, 'Невозможно доставить'] },
      create: async (row) => { delCalls.push(['create', row]); return 12; },
      setStatus: async (...a) => { delCalls.push(['setStatus', ...a]); },
      setStatusIf: async (...a) => { delCalls.push(['setStatusIf', ...a]); return true; },
      setProviderMessageId: async (...a) => { delCalls.push(['setProviderMessageId', ...a]); },
      findByProviderMessageId: async () => null,
      failStale: async () => 0,
    },
    webhook: { sendSafe: async (b) => { hooks.push(b); } },
    now: () => 1_700_000_000_000,
    sleep: async () => {},
    appStatePatchNames: ['critical_block', 'critical_unblock_low'],
    ...(over.deps || {}),
  };
  const wa = new WhatsappClient({ id: 42, phone: null }, deps);
  return { wa, sock, repoCalls, delCalls, hooks, tmp };
}
const tick = () => new Promise(r => setImmediate(r));
const ticks = async (n = 4) => { for (let i = 0; i < n; i++) await tick(); };
async function open(wa, sock) { await wa.start(); sock.ev.emit('connection.update', { connection: 'open' }); await ticks(2); }

test('start: каталог сессии создан, auth_state=starting', async () => {
  const { wa, repoCalls, tmp } = setup();
  await wa.start();
  assert.ok(fs.existsSync(path.join(tmp, 'acc-42', 'wa')));
  assert.deepEqual(repoCalls[0], ['setAuth', 42, 'starting']);
});

test('qr → wait_qr с data-URL в status(); open → ready со своим номером и именем', async () => {
  const { wa, sock, repoCalls } = setup();
  await wa.start();
  sock.ev.emit('connection.update', { qr: 'QRPAYLOAD' });
  await ticks(2);
  assert.equal(wa.authState, 'wait_qr');
  assert.match(wa.status().qr, /^data:image\/png;base64,/);
  assert.ok(repoCalls.some(c => c[2] === 'wait_qr'));
  sock.ev.emit('connection.update', { connection: 'open' });
  await ticks(2);
  assert.equal(wa.authState, 'ready');
  assert.equal(wa.status().phone, '79250177778');
  assert.equal(wa.status().displayName, 'Клиника');
  assert.equal(wa.status().qr, null);
  assert.deepEqual(repoCalls.at(-1), ['setAuth', 42, 'ready', { error: null, phone: '79250177778', displayName: 'Клиника' }]);
});

test('authStep({phone}) в wait_qr → код привязки; code/password → ошибка «не применимо»', async () => {
  const { wa, sock } = setup();
  await wa.start();
  sock.ev.emit('connection.update', { qr: 'Q' }); await tick();
  assert.deepEqual(await wa.authStep({ phone: '8 920 025-55-91' }), { authState: 'wait_qr', pairingCode: 'ABCDEFGH', error: null });
  assert.deepEqual(sock.calls.find(c => c[0] === 'requestPairingCode'), ['requestPairingCode', '79200255591']);
  assert.equal(wa.status().pairingCode, 'ABCDEFGH');
  assert.equal((await wa.authStep({ code: '123' })).error, 'не применимо к WhatsApp');
  assert.equal((await wa.authStep({ password: 'x' })).error, 'не применимо к WhatsApp');
});

test('close loggedOut → logged_out, каталог удалён, реконнекта нет; close иначе → реконнект', async () => {
  let created = 0;
  const { wa, sock, repoCalls, tmp } = setup();
  wa.d.createSocket = async () => { created++; return { sock, saveCreds: async () => {} }; };
  await wa.start();
  sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await ticks(3);
  assert.equal(created, 2);
  sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await ticks(3);
  assert.equal(wa.authState, 'logged_out');
  assert.equal(created, 2);
  assert.ok(!fs.existsSync(path.join(tmp, 'acc-42', 'wa')));
  assert.ok(repoCalls.some(c => c[2] === 'logged_out'));
});

test('close connectionReplaced (440) / forbidden (403) → error без реконнекта, сессия на месте', async () => {
  for (const code of [440, 403]) {
    let created = 0;
    const { wa, sock, repoCalls, tmp } = setup();
    wa.d.createSocket = async () => { created++; return { sock, saveCreds: async () => {} }; };
    await open(wa, sock);
    sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: code } } } });
    await ticks(3);
    assert.equal(created, 1, `code ${code}`);
    assert.equal(wa.authState, 'error');
    assert.ok(wa.status().error);
    assert.ok(fs.existsSync(path.join(tmp, 'acc-42', 'wa')));
    assert.equal(repoCalls.at(-1)[2], 'error');
  }
});

test('реконнект: createSocket упал — пробуем снова, а не застреваем', async () => {
  let created = 0;
  const { wa, sock } = setup();
  wa.d.createSocket = async () => { created++; if (created === 2) throw new Error('EACCES'); return { sock, saveCreds: async () => {} }; };
  await wa.start();
  sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  await ticks(6);
  assert.equal(created, 3);
});

test('соединение потеряно (не разлогин) → отправка 422 до создания доставки', async () => {
  const { wa, sock, delCalls } = setup();
  wa.d.sleep = () => new Promise(() => {});   // реконнект «висит»
  await open(wa, sock);
  sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  await ticks(2);
  assert.equal(wa.authState, 'ready');
  await assert.rejects(() => wa.sendText({ text: 'x', phone: '79001112233' }), e => e.status === 422 && /соединения/.test(e.message));
  assert.equal(delCalls.length, 0);
});

test('входящее notify из LID-чата: вебхук с номером из senderPn, LID запомнен в кэше', async () => {
  const { wa, sock, hooks, repoCalls } = setup();
  await open(wa, sock);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '46810865385627@lid', fromMe: false, id: 'IN1', senderPn: '79001112233@s.whatsapp.net', senderLid: '46810865385627@lid' }, pushName: 'Иван', messageTimestamp: 1_700_000_000, message: { conversation: 'Привет' } }] });
  await ticks(3);
  assert.equal(hooks.length, 1);
  const nm = hooks[0].payload.new_message;
  assert.equal(nm.direction, 'incoming');
  assert.equal(nm.chat_phone, '79001112233');
  assert.equal(nm.chat_id, '79001112233@c.us');
  assert.equal(hooks[0].payload.customer_id, 42);
  assert.deepEqual(repoCalls.find(c => c[0] === 'rememberContact'), ['rememberContact', 42, '79001112233', '46810865385627']);
});

test('входящее из LID-чата без senderPn: номер из кэша LID; нет кэша → chat_id <lid>@lid, без номера', async () => {
  const a = setup({ lidPhone: '79005556677' });
  await open(a.wa, a.sock);
  a.sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '111@lid', fromMe: false, id: 'L1' }, messageTimestamp: 1_700_000_000, message: { conversation: 'a' } }] });
  await ticks(3);
  assert.equal(a.hooks[0].payload.new_message.chat_phone, '79005556677');
  const b = setup();
  await open(b.wa, b.sock);
  b.sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '111@lid', fromMe: false, id: 'L2' }, messageTimestamp: 1_700_000_000, message: { conversation: 'a' } }] });
  await ticks(3);
  assert.equal(b.hooks[0].payload.new_message.chat_phone, null);
  assert.equal(b.hooks[0].payload.new_message.chat_id, '111@lid');
});

test('chats.phoneNumberShare → номер запомнен за LID', async () => {
  const { wa, sock, repoCalls } = setup();
  await open(wa, sock);
  sock.ev.emit('chats.phoneNumberShare', { lid: '555@lid', jid: '79001112233@s.whatsapp.net' });
  await ticks(2);
  assert.deepEqual(repoCalls.find(c => c[0] === 'rememberContact'), ['rememberContact', 42, '79001112233', '555']);
});

test('фильтры: старше 6 ч, status@broadcast, рассылка, служебное — в бэкенд не идут', async () => {
  const { wa, sock, hooks } = setup();
  await open(wa, sock);
  const base = (o) => ({ key: { remoteJid: '79001112233@s.whatsapp.net', fromMe: false, id: 'F' + Math.random() }, messageTimestamp: 1_700_000_000, message: { conversation: 'x' }, ...o });
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [base({ messageTimestamp: 1_700_000_000 - MAX_MESSAGE_AGE_S - 1 })] });
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [base({ key: { remoteJid: 'status@broadcast', fromMe: false, id: 'S' } })] });
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [base({ key: { remoteJid: '123@broadcast', fromMe: false, id: 'B' } })] });
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [base({ message: { protocolMessage: {} } })] });
  sock.ev.emit('messages.upsert', { type: 'append', messages: [base({ message: undefined, messageStubType: 20 })] });
  await ticks(3);
  assert.equal(hooks.length, 0);
});

test('офлайн-очередь: входящее type=append (пришло, пока шлюз лежал) → в бэкенд', async () => {
  const { wa, sock, hooks } = setup();
  await open(wa, sock);
  sock.ev.emit('messages.upsert', { type: 'append', messages: [{ key: { remoteJid: '79001112233@s.whatsapp.net', fromMe: false, id: 'OFF1' }, messageTimestamp: 1_700_000_000 - 600, message: { conversation: 'пока вы спали' } }] });
  await ticks(3);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].payload.new_message.direction, 'incoming');
});

test('входящее фото в личке → файл в публичном каталоге с расширением по MIME, file_data в вебхуке', async () => {
  const { wa, sock, hooks, tmp } = setup();
  await open(wa, sock);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '79001112233@s.whatsapp.net', fromMe: false, id: 'P1' }, messageTimestamp: 1_700_000_000, message: { imageMessage: { caption: 'фото', mimetype: 'image/jpeg', fileLength: 8 } } }] });
  await ticks(3);
  const fd = hooks[0].payload.new_message.message.file_data;
  assert.match(fd.download_url, /^\/uploads\/gateway\/42\/\d+_[0-9a-f]{16}\.jpg$/);
  assert.ok(fs.existsSync(path.join(tmp, 'pub', '42', path.basename(fd.download_url))));
  assert.equal(fd.mime_type, 'image/jpeg');
});

test('sendText: onWhatsApp → sendMessage в <phone>@s.whatsapp.net, доставка g12 «Отправлено», эхо с delivery_id, append того же id пропущен', async () => {
  const { wa, sock, hooks, delCalls } = setup();
  await open(wa, sock);
  const id = await wa.sendText({ text: 'Здравствуйте', phone: '+7 (900) 111-22-33' });
  assert.equal(id, 12);
  assert.deepEqual(sock.calls.filter(c => c[0] !== 'onWhatsApp').at(-1), ['sendMessage', '79001112233@s.whatsapp.net', { text: 'Здравствуйте' }]);
  await ticks(2);
  assert.deepEqual(delCalls.find(c => c[0] === 'setProviderMessageId'), ['setProviderMessageId', 12, 'OUT1']);
  // Baileys не шлёт messages.update со SERVER_ACK для лички (только DELIVERY_ACK
  // по квитанции устройства) — «Отправлено» ставим по успешному sendMessage.
  assert.deepEqual(delCalls.find(c => c[0] === 'setStatusIf'), ['setStatusIf', 12, 1, [2, 'Отправлено']]);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].payload.delivery_id, 'g12');
  assert.equal(hooks[0].payload.new_message.direction, 'outgoing');
  assert.equal(hooks[0].payload.new_message.recipient_phone_number, '79001112233');
  sock.ev.emit('messages.upsert', { type: 'append', messages: [{ key: { remoteJid: '79001112233@s.whatsapp.net', fromMe: true, id: 'OUT1' }, messageTimestamp: 1_700_000_100, message: { conversation: 'Здравствуйте' } }] });
  await ticks(2);
  assert.equal(hooks.length, 1);
  // Квитанция доставки на устройство — статус уже «Отправлено», лишней записи нет.
  const before = delCalls.length;
  sock.ev.emit('messages.update', [{ key: { remoteJid: '79001112233@s.whatsapp.net', fromMe: true, id: 'OUT1' }, update: { status: 3 } }]);
  await ticks(2);
  assert.equal(delCalls.length, before);
  // Отказ сервера (bad ack, status ERROR=0) → «Невозможно доставить».
  sock.ev.emit('messages.update', [{ key: { remoteJid: '79001112233@s.whatsapp.net', fromMe: true, id: 'OUT1' }, update: { status: 0, messageStubParameters: ['479'] } }]);
  await ticks(2);
  assert.deepEqual(delCalls.at(-1), ['setStatus', 12, [5, 'Невозможно доставить'], { error: 'WhatsApp отклонил сообщение (479)' }]);
});

test('append своей отправки, пришедший ДО того, как sendMessage вернулся, тоже не эхо оператора', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const { wa, sock, hooks } = setup();
  sock.sendMessage = async (jid, content) => {
    sock.ev.emit('messages.upsert', { type: 'append', messages: [{ key: { remoteJid: jid, fromMe: true, id: 'OUT9' }, messageTimestamp: 1_700_000_000, message: { conversation: content.text } }] });
    await gate;
    return { key: { remoteJid: jid, fromMe: true, id: 'OUT9' }, message: { conversation: content.text }, messageTimestamp: 1_700_000_000 };
  };
  await open(wa, sock);
  const p = wa.sendText({ text: 'Hi', phone: '79001112233' });
  await ticks(3);
  assert.equal(hooks.length, 0);
  release();
  await p; await ticks(3);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].payload.delivery_id, 'g12');
});

test('sendText: номер не в WhatsApp → 422; аккаунт не ready → 422; ошибка onWhatsApp → шлём всё равно', async () => {
  const { wa, sock } = setup();
  await assert.rejects(() => wa.sendText({ text: 'x', phone: '79001112233' }), e => e.status === 422);
  await open(wa, sock);
  await assert.rejects(() => wa.sendText({ text: 'x', phone: '70000000000' }), e => e.status === 422 && /не в WhatsApp/.test(e.message));
  sock.onWhatsApp = async () => { throw new Error('usync timeout'); };
  assert.equal(await wa.sendText({ text: 'x', phone: '79005550000' }), 12);
  await assert.rejects(() => wa.sendText({ text: 'x', tdlibUserId: '123' }), e => e.status === 422);
});

test('sendText: подтверждённый номер кэшируется — onWhatsApp один раз', async () => {
  const { wa, sock } = setup();
  await open(wa, sock);
  await wa.sendText({ text: 'a', phone: '79001112233' });
  await wa.sendText({ text: 'b', phone: '79001112233' });
  assert.equal(sock.calls.filter(c => c[0] === 'onWhatsApp').length, 1);
});

test('sendText: sendMessage бросил → доставка FAILED, ошибка 422 наружу', async () => {
  const { wa, sock, delCalls } = setup({ sock: { sendMessage: async () => { throw new Error('not-authorized'); } } });
  await open(wa, sock);
  await assert.rejects(() => wa.sendText({ text: 'x', phone: '79001112233' }), e => e.status === 422);
  assert.deepEqual(delCalls.at(-1), ['setStatus', 12, [5, 'Невозможно доставить'], { error: 'not-authorized' }]);
});

test('исходящее, набранное на телефоне (fromMe notify без доставки) → эхо без delivery_id', async () => {
  const { wa, sock, hooks } = setup();
  await open(wa, sock);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '79001112233@s.whatsapp.net', fromMe: true, id: 'HAND1' }, messageTimestamp: 1_700_000_000, message: { conversation: 'Ответ руками' } }] });
  await ticks(3);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].payload.delivery_id, null);
  assert.equal(hooks[0].payload.new_message.direction, 'outgoing');
});

test('исходящее руками в LID-чате: senderPn (это НАШ номер) клиентом не считается', async () => {
  const { wa, sock, hooks, repoCalls } = setup();
  await open(wa, sock);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '777@lid', fromMe: true, id: 'HAND2', senderPn: '79250177778@s.whatsapp.net', senderLid: '999@lid' }, messageTimestamp: 1_700_000_000, message: { conversation: 'ответ' } }] });
  await ticks(3);
  const nm = hooks[0].payload.new_message;
  assert.equal(nm.recipient_phone_number, null);
  assert.equal(nm.chat_id, '777@lid');
  assert.ok(!repoCalls.some(c => c[0] === 'rememberContact'));
});

test('sendFile: image → {image, caption}, документ → {document, mimetype по расширению, fileName}; временный файл удалён', async () => {
  const { wa, sock, tmp } = setup();
  await open(wa, sock);
  const f = path.join(tmp, 'pic.jpg'); fs.writeFileSync(f, 'IMG');
  await wa.sendFile({ filePath: f, fileName: 'pic.jpg', caption: 'подпись', type: 'image', phone: '79001112233' });
  const c = sock.calls.filter(x => x[0] === 'sendMessage').at(-1)[2];
  assert.ok(Buffer.isBuffer(c.image)); assert.equal(c.caption, 'подпись'); assert.equal(c.mimetype, 'image/jpeg');
  await ticks(2);
  assert.ok(!fs.existsSync(f));
  const d = path.join(tmp, 'doc.pdf'); fs.writeFileSync(d, 'PDF');
  await wa.sendFile({ filePath: d, fileName: 'doc.pdf', caption: '', type: 'document', phone: '79001112233' });
  const c2 = sock.calls.filter(x => x[0] === 'sendMessage').at(-1)[2];
  assert.ok(Buffer.isBuffer(c2.document)); assert.equal(c2.mimetype, 'application/pdf'); assert.equal(c2.fileName, 'doc.pdf');
});

test('sendFile: файл не читается → 422 и доставка не создаётся', async () => {
  const { wa, sock, tmp, delCalls } = setup();
  await open(wa, sock);
  await assert.rejects(() => wa.sendFile({ filePath: path.join(tmp, 'nope.jpg'), fileName: 'nope.jpg', type: 'image', phone: '79001112233' }), e => e.status === 422);
  assert.equal(delCalls.length, 0);
});

test('logout: sock.logout, каталог удалён, logged_out', async () => {
  const { wa, sock, repoCalls, tmp } = setup();
  await open(wa, sock);
  await wa.logout();
  assert.ok(sock.calls.some(c => c[0] === 'logout'));
  assert.ok(!fs.existsSync(path.join(tmp, 'acc-42', 'wa')));
  assert.deepEqual(repoCalls.at(-1), ['setAuth', 42, 'logged_out']);
});

test('close: сокет закрыт, close-событие после него реконнект не запускает', async () => {
  let created = 0;
  const { wa, sock } = setup();
  wa.d.createSocket = async () => { created++; return { sock, saveCreds: async () => {} }; };
  await open(wa, sock);
  await wa.close();
  assert.ok(sock.calls.some(c => c[0] === 'end'));
  sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: undefined } });
  await ticks(3);
  assert.equal(created, 1);
});

// ── Ревью 724cfa6 ───────────────────────────────────────────────

test('ревью #1: close() во время создания сокета при реконнекте — сокет гасится, open не оживляет клиент', async () => {
  let release; let n = 0;
  const { wa, sock, repoCalls } = setup();
  const sock2 = fakeSock();
  wa.d.createSocket = async () => { n++; if (n === 1) return { sock, saveCreds: async () => {} }; await new Promise(r => { release = r; }); return { sock: sock2, saveCreds: async () => {} }; };
  await open(wa, sock);
  sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  await ticks(3);
  await wa.close();
  release(); await ticks(3);
  assert.ok(sock2.calls.some(c => c[0] === 'end'));
  assert.equal(sock2.ev.listenerCount('connection.update'), 0);
  const before = repoCalls.length;
  wa.onConnection({ connection: 'open' }); await ticks(2);
  assert.equal(repoCalls.length, before);
});

test('ревью #3: sendMessage получает mediaUploadTimeoutMs; зависшая отправка в ДРУГОЙ чат не держит эхо оператора', async () => {
  const opts = [];
  const { wa, sock, hooks } = setup();
  sock.sendMessage = async (jid, content, o) => { opts.push(o); return new Promise(() => {}); };   // зависла
  await open(wa, sock);
  wa.sendText({ text: 'x', phone: '79001112233' }).catch(() => {});
  await ticks(3);
  assert.equal(opts[0].mediaUploadTimeoutMs, MEDIA_UPLOAD_TIMEOUT_MS);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '79005556677@s.whatsapp.net', fromMe: true, id: 'H' }, messageTimestamp: 1_700_000_000, message: { conversation: 'руками' } }] });
  await ticks(4);
  assert.equal(hooks.length, 1);
});

test('ревью #3: зависшая отправка в ТОТ ЖЕ чат держит fromMe не дольше 30 с', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { wa, sock, hooks } = setup();
  sock.sendMessage = async () => new Promise(() => {});
  await wa.start(); sock.ev.emit('connection.update', { connection: 'open' });
  await ticks(2);
  wa.sendText({ text: 'x', phone: '79001112233' }).catch(() => {});
  await ticks(3);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '79001112233@s.whatsapp.net', fromMe: true, id: 'H' }, messageTimestamp: 1_700_000_000, message: { conversation: 'руками' } }] });
  await ticks(4);
  assert.equal(hooks.length, 0);
  t.mock.timers.tick(30_000);
  await ticks(4);
  assert.equal(hooks.length, 1);
});

test('ревью #5: сообщение, сброшенное после close-события (реконнект), не теряется', async () => {
  const { wa, sock, hooks } = setup();
  wa.d.sleep = () => new Promise(() => {});
  await open(wa, sock);
  sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
  await ticks(2);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '79001112233@s.whatsapp.net', fromMe: false, id: 'LATE' }, messageTimestamp: 1_700_000_000, message: { conversation: 'поздно' } }] });
  await ticks(3);
  assert.equal(hooks.length, 1);
});

test('ревью #6: QR/код сбрасываются на реконнекте; после MAX_QR_ROUNDS раундов без входа — error, реконнектов нет', async () => {
  let created = 0;
  const { wa, sock, repoCalls } = setup();
  wa.d.createSocket = async () => { created++; return { sock, saveCreds: async () => {} }; };
  await wa.start();
  for (let i = 0; i < MAX_QR_ROUNDS; i++) {
    sock.ev.emit('connection.update', { qr: 'Q' + i }); await ticks(2);
    if (i === 0) { await wa.authStep({ phone: '79200255591' }); assert.equal(wa.status().pairingCode, 'ABCDEFGH'); }
    sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { message: 'QR refs attempts ended', output: { statusCode: 408 } } } });
    await ticks(3);
    if (i < MAX_QR_ROUNDS - 1) { assert.equal(wa.qr, null); assert.equal(wa.pairingCode, null); }
  }
  assert.equal(wa.authState, 'error');
  assert.match(wa.status().error, /QR/);
  assert.equal(created, MAX_QR_ROUNDS);   // старт + (MAX-1) реконнектов, после последнего — нет
  assert.equal(repoCalls.at(-1)[2], 'error');
  assert.equal(wa.closed, true);          // registry.start пересоздаст клиент
});

test('ревью #7: отправка в канонический jid из onWhatsApp, jid кэшируется', async () => {
  const { wa, sock, hooks } = setup();
  sock.onWhatsApp = async (p) => { sock.calls.push(['onWhatsApp', p]); return [{ jid: '79001112299:0@s.whatsapp.net', exists: true }]; };
  await open(wa, sock);
  await wa.sendText({ text: 'a', phone: '79001112233' });
  await wa.sendText({ text: 'b', phone: '79001112233' });
  const sends = sock.calls.filter(c => c[0] === 'sendMessage');
  assert.deepEqual(sends.map(c => c[1]), ['79001112299@s.whatsapp.net', '79001112299@s.whatsapp.net']);
  assert.equal(sock.calls.filter(c => c[0] === 'onWhatsApp').length, 1);
  await ticks(3);
  assert.equal(hooks[0].payload.new_message.recipient_phone_number, '79001112299');
});

test('ревью #8: сообщения в чат с самим собой (свой номер / свой LID) не форвардятся', async () => {
  const { wa, sock, hooks } = setup();
  sock.user.lid = '999:3@lid';
  await open(wa, sock);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [
    { key: { remoteJid: '79250177778@s.whatsapp.net', fromMe: true, id: 'S1' }, messageTimestamp: 1_700_000_000, message: { conversation: 'заметка' } },
    { key: { remoteJid: '999@lid', fromMe: true, id: 'S2' }, messageTimestamp: 1_700_000_000, message: { conversation: 'заметка' } },
  ] });
  await ticks(4);
  assert.equal(hooks.length, 0);
});

test('ревью #9: медиа качается потоком, лимит по факту байтов (fileLength врёт) → файл не сохранён', async () => {
  const { wa, sock, hooks, tmp } = setup();
  wa.d.maxMediaBytes = 10;
  let destroyed = false;
  wa.d.downloadMedia = async () => { const s = Readable.from([Buffer.alloc(6), Buffer.alloc(6), Buffer.alloc(6)]); s.on('close', () => { destroyed = true; }); return s; };
  await open(wa, sock);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '79001112233@s.whatsapp.net', fromMe: false, id: 'BIG' }, messageTimestamp: 1_700_000_000, message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 5 } } }] });
  await ticks(6);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].payload.new_message.message.file_data, undefined);
  assert.ok(!fs.existsSync(path.join(tmp, 'pub', '42')) || fs.readdirSync(path.join(tmp, 'pub', '42')).length === 0);
  assert.ok(destroyed);
  wa.d.downloadMedia = async () => Readable.from([Buffer.from('ab'), Buffer.from('cd')]);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '79001112233@s.whatsapp.net', fromMe: false, id: 'OK' }, messageTimestamp: 1_700_000_000, message: { imageMessage: { mimetype: 'image/jpeg' } } }] });
  await ticks(6);
  const fd = hooks[1].payload.new_message.message.file_data;
  assert.equal(fs.readFileSync(path.join(tmp, 'pub', '42', path.basename(fd.download_url)), 'utf8'), 'abcd');
});

// ── Ре-ревью 8765a2c ────────────────────────────────────────────

const qrExhausted = { connection: 'close', lastDisconnect: { error: { message: 'QR refs attempts ended', output: { statusCode: 408 } } } };

test('ре-ревью #1: удачный вход на последнем раунде QR (isNewLogin → 515 → open) не обрывается в error', async () => {
  let created = 0;
  const { wa, sock } = setup();
  wa.d.createSocket = async () => { created++; return { sock, saveCreds: async () => {} }; };
  await wa.start();
  for (let i = 0; i < MAX_QR_ROUNDS - 1; i++) {
    sock.ev.emit('connection.update', { qr: 'Q' + i }); await ticks(2);
    sock.ev.emit('connection.update', qrExhausted); await ticks(3);
  }
  sock.ev.emit('connection.update', { qr: 'LAST' }); await ticks(2);
  sock.ev.emit('connection.update', { isNewLogin: true, qr: undefined }); await ticks(2);
  sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { message: 'Stream Errored (restart required)', output: { statusCode: 515 } } } });
  await ticks(3);
  assert.notEqual(wa.authState, 'error');
  assert.equal(created, MAX_QR_ROUNDS + 1);
  sock.ev.emit('connection.update', { connection: 'open' }); await ticks(2);
  assert.equal(wa.authState, 'ready');
});

test('ре-ревью #1: 515 и обрывы сети (408 «Connection was lost») в wait_qr раундами не считаются', async () => {
  const { wa, sock } = setup();
  await wa.start();
  sock.ev.emit('connection.update', { qr: 'Q' }); await ticks(2);
  for (let i = 0; i < MAX_QR_ROUNDS + 2; i++) {
    sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { message: 'Connection was lost', output: { statusCode: 408 } } } });
    await ticks(3);
    sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
    await ticks(3);
  }
  assert.equal(wa.authState, 'wait_qr');
  assert.equal(wa.closed, false);
});

test('ре-ревью #2: зависшее скачивание медиа обрывается по дедлайну, сообщение уходит без файла, очередь чата живёт', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { wa, sock, hooks } = setup();
  let signal = null; let opts = null;
  wa.d.downloadMedia = async (m, s, o) => { opts = o; signal = o.signal; return new Readable({ read() {} }); };   // ни байта
  await wa.start(); sock.ev.emit('connection.update', { connection: 'open' }); await ticks(2);
  const jid = '79001112233@s.whatsapp.net';
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [
    { key: { remoteJid: jid, fromMe: false, id: 'M1' }, messageTimestamp: 1_700_000_000, message: { imageMessage: { mimetype: 'image/jpeg' } } },
    { key: { remoteJid: jid, fromMe: false, id: 'M2' }, messageTimestamp: 1_700_000_000, message: { conversation: 'после фото' } },
  ] });
  await ticks(6);
  assert.equal(hooks.length, 0);
  assert.ok(opts.timeout > 0);
  t.mock.timers.tick(MEDIA_DOWNLOAD_DEADLINE_MS);
  await ticks(8);
  assert.equal(signal.aborted, true);
  assert.equal(hooks.length, 2);
  assert.equal(hooks[0].payload.new_message.message.file_data, undefined);
  assert.equal(hooks[1].payload.new_message.message.text, 'после фото');
});

test('ре-ревью #2: ответ не пришёл вовсе (промис downloadMedia висит) — тоже дедлайн', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { wa, sock, hooks } = setup();
  wa.d.downloadMedia = () => new Promise(() => {});
  await wa.start(); sock.ev.emit('connection.update', { connection: 'open' }); await ticks(2);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '79001112233@s.whatsapp.net', fromMe: false, id: 'M' }, messageTimestamp: 1_700_000_000, message: { imageMessage: { mimetype: 'image/jpeg' } } }] });
  await ticks(4);
  t.mock.timers.tick(MEDIA_DOWNLOAD_DEADLINE_MS);
  await ticks(6);
  assert.equal(hooks.length, 1);
});

test('ре-ревью #2: превышение лимита отменяет HTTP (signal.aborted), удачное скачивание — без отмены и без висящего таймера', async () => {
  const { wa, sock, hooks } = setup();
  wa.d.maxMediaBytes = 10;
  const signals = [];
  wa.d.downloadMedia = async (m, s, o) => { signals.push(o.signal); return Readable.from(m.key.id === 'BIG' ? [Buffer.alloc(6), Buffer.alloc(6)] : [Buffer.from('ok')]); };
  await open(wa, sock);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '79001112233@s.whatsapp.net', fromMe: false, id: 'BIG' }, messageTimestamp: 1_700_000_000, message: { imageMessage: { mimetype: 'image/jpeg' } } }] });
  await ticks(6);
  assert.equal(signals[0].aborted, true);
  assert.equal(hooks[0].payload.new_message.message.file_data, undefined);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '79001112233@s.whatsapp.net', fromMe: false, id: 'SMALL' }, messageTimestamp: 1_700_000_000, message: { imageMessage: { mimetype: 'image/jpeg' } } }] });
  await ticks(6);
  assert.ok(hooks[1].payload.new_message.message.file_data);
});

// ── Живой прогон 12.10.2026: чат с самим собой по нашему LID ───────

test('личность: lid появился в creds ПОСЛЕ open (sock.user без lid) — чат с собой по LID всё равно не форвардится', async () => {
  const { wa, sock, hooks } = setup();
  sock.user = { id: '79200255591:47@s.whatsapp.net' };            // на open ни lid, ни имени
  await open(wa, sock);
  sock.user.lid = '117162547122258:47@lid';                        // Object.assign(creds, update) внутри Baileys
  sock.ev.emit('messages.upsert', { type: 'append', messages: [{ key: { remoteJid: '117162547122258@lid', fromMe: true, id: 'SELF1' }, messageTimestamp: 1_700_000_000, message: { conversation: 'заметка' } }] });
  await ticks(4);
  assert.equal(hooks.length, 0);
});

test('личность: creds.update с me → lid/имя обновлены, имя «.» сохранено в БД; пустое имя и «~» — null', async () => {
  const { wa, sock, repoCalls, hooks } = setup();
  sock.user = { id: '79200255591:47@s.whatsapp.net', name: '~' };
  await open(wa, sock);
  assert.equal(wa.status().displayName, null);
  sock.ev.emit('creds.update', { me: { id: '79200255591:47@s.whatsapp.net', lid: '117162547122258:47@lid', name: '.' } });
  await ticks(3);
  assert.equal(wa.status().displayName, '.');
  assert.equal(wa.ownLid, '117162547122258');
  assert.deepEqual(repoCalls.at(-1), ['setAuth', 42, 'ready', { error: null, phone: '79200255591', displayName: '.' }]);
  const n = repoCalls.length;
  sock.ev.emit('creds.update', { me: { id: '79200255591:47@s.whatsapp.net', lid: '117162547122258:47@lid', name: '.' } });
  await ticks(3);
  assert.equal(repoCalls.length, n);                               // ничего не поменялось — БД не трогаем
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '117162547122258@lid', fromMe: true, id: 'S' }, messageTimestamp: 1_700_000_000, message: { conversation: 'x' } }] });
  await ticks(4);
  assert.equal(hooks.length, 0);
});

test('пустой текст без медиа (в т.ч. служебное после привязки) в бэкенд не идёт; медиа без подписи — идёт', async () => {
  const { wa, sock, hooks } = setup();
  await open(wa, sock);
  const jid = '79001112233@s.whatsapp.net';
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [
    { key: { remoteJid: jid, fromMe: true, id: 'E1' }, messageTimestamp: 1_700_000_000, message: { conversation: '', messageContextInfo: {} } },
    { key: { remoteJid: jid, fromMe: false, id: 'E2' }, messageTimestamp: 1_700_000_000, message: { extendedTextMessage: { text: '  ' } } },
    { key: { remoteJid: jid, fromMe: false, id: 'P' }, messageTimestamp: 1_700_000_000, message: { imageMessage: { mimetype: 'image/jpeg' } } },
  ] });
  await ticks(6);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].payload.new_message.message.type, 'image');
});

// ── Номер собеседника по LID ЗАРАНЕЕ (13.10.2026, прод): администратор написал с
// телефона клиники пациенту, который после привязки ещё не писал, — эхо ушло
// в бэкенд как '<lid>@lid' без номера, и в «Чате» появился безымянный диалог.
// Номер WhatsApp отдаёт связанным устройствам: в контактах (app-state,
// contactAction.lidJid) и в сыром пакете своего сообщения (атрибут *_pn).

test('LID: contacts.upsert — пары номер↔LID запоминаются пачкой; без lid, свой номер — пропуск', async () => {
  const { wa, sock, repoCalls } = setup();
  await open(wa, sock);
  sock.ev.emit('contacts.upsert', [
    { id: '79001112233@s.whatsapp.net', lid: '111@lid', name: 'Анна' },
    { id: '222@lid', jid: '79004445566@s.whatsapp.net' },
    { id: '79007778899@s.whatsapp.net', name: 'без LID' },
    { id: '79250177778@s.whatsapp.net', lid: '999@lid' },             // свой номер клиентом не бывает
  ]);
  await ticks(3);
  const calls = repoCalls.filter(c => c[0] === 'rememberContacts');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['rememberContacts', 42, [{ phone: '79001112233', userId: '111' }, { phone: '79004445566', userId: '222' }]]);
});

test('LID: contacts.update с lid тоже учит; повтор уже известной пары БД не трогает', async () => {
  const { wa, sock, repoCalls } = setup();
  await open(wa, sock);
  sock.ev.emit('contacts.update', [{ id: '79001112233@s.whatsapp.net', lid: '111@lid' }]);
  await ticks(3);
  sock.ev.emit('contacts.update', [{ id: '79001112233@s.whatsapp.net', lid: '111@lid' }]);
  await ticks(3);
  assert.equal(repoCalls.filter(c => c[0] === 'rememberContacts').length, 1);
});

test('LID: номер из контактов используется для своего сообщения с телефона — эхо с номером, а не <lid>@lid', async () => {
  const { wa, sock, hooks } = setup();                              // phoneByLid в БД пусто
  await open(wa, sock);
  sock.ev.emit('contacts.upsert', [{ id: '79001112233@s.whatsapp.net', lid: '777@lid' }]);
  await ticks(3);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '777@lid', fromMe: true, id: 'HAND4', senderPn: '79250177778@s.whatsapp.net' }, messageTimestamp: 1_700_000_000, message: { conversation: 'Вы записаны' } }] });
  await ticks(4);
  const nm = hooks[0].payload.new_message;
  assert.equal(nm.direction, 'outgoing');
  assert.equal(nm.chat_id, '79001112233@c.us');
  assert.equal(nm.recipient_phone_number, '79001112233');
});

test('LID: сырой пакет своего сообщения с другого устройства (recipient=<lid>, peer_recipient_pn / recipient_pn) → номер известен до разбора сообщения', async () => {
  const { wa, sock, hooks, repoCalls } = setup();
  await open(wa, sock);
  sock.ws.emit('CB:message', { tag: 'message', attrs: { id: 'HAND5', from: '79250177778@s.whatsapp.net', recipient: '777@lid', type: 'text', peer_recipient_pn: '79001112233@s.whatsapp.net' } });
  sock.ws.emit('CB:message', { tag: 'message', attrs: { id: 'HAND6', from: '79250177778@s.whatsapp.net', recipient: '888@lid', type: 'text', recipient_pn: '79004445566@s.whatsapp.net' } });
  // Сразу следом (без ожидания записи в БД) — разобранное сообщение
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '777@lid', fromMe: true, id: 'HAND5' }, messageTimestamp: 1_700_000_000, message: { conversation: 'Добрый день' } }] });
  await ticks(4);
  assert.equal(hooks[0].payload.new_message.chat_id, '79001112233@c.us');
  const saved = repoCalls.filter(c => c[0] === 'rememberContacts').flatMap(c => c[2]);
  assert.deepEqual(saved, [{ phone: '79001112233', userId: '777' }, { phone: '79004445566', userId: '888' }]);
});

test('LID: сырой пакет без номера получателя, входящий пакет, группа — ничего не учим; эхо остаётся <lid>@lid', async () => {
  const { wa, sock, hooks, repoCalls } = setup();
  await open(wa, sock);
  sock.ws.emit('CB:message', { tag: 'message', attrs: { id: 'X1', from: '79250177778@s.whatsapp.net', recipient: '777@lid', type: 'text' } });
  sock.ws.emit('CB:message', { tag: 'message', attrs: { id: 'X2', from: '777@lid', sender_pn: '79001112233@s.whatsapp.net', type: 'text' } });
  sock.ws.emit('CB:message', { tag: 'message', attrs: { id: 'X3', from: '120363@g.us', participant: '777@lid', participant_pn: '79001112233@s.whatsapp.net' } });
  sock.ws.emit('CB:message', { tag: 'message', attrs: { id: 'X4', from: '79250177778@s.whatsapp.net', recipient: '777@lid', peer_recipient_pn: '79250177778@s.whatsapp.net' } }); // свой номер
  sock.ws.emit('CB:message', null);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '777@lid', fromMe: true, id: 'X1' }, messageTimestamp: 1_700_000_000, message: { conversation: 'a' } }] });
  await ticks(4);
  assert.equal(hooks[0].payload.new_message.chat_id, '777@lid');
  assert.ok(!repoCalls.some(c => c[0] === 'rememberContacts'));
});

test('LID: слушатель сырых пакетов снимается вместе с сокетом (реконнект не удваивает обработку)', async () => {
  const { wa, sock } = setup();
  await open(wa, sock);
  assert.equal(sock.ws.listenerCount('CB:message'), 1);
  wa.detach();
  assert.equal(sock.ws.listenerCount('CB:message'), 0);
});

function appStateSock({ creds, resync, contactsVersion = 7 } = {}) {
  const c = { me: { id: '79250177778:12@s.whatsapp.net', lid: '279666862632979:12@lid' }, ...creds };
  const resyncCalls = []; let flushes = 0;
  return {
    resyncCalls, get flushes() { return flushes; },
    sockOver: {
      authState: { creds: c, keys: { get: async (type, ids) => (type === 'app-state-sync-version' && contactsVersion ? { critical_unblock_low: { version: contactsVersion } } : {}) } },
      async resyncAppState(names, initial) { resyncCalls.push([names, initial]); if (resync) await resync(); },
    },
    attachFlush(sock) { sock.ev.flush = () => { flushes++; return true; }; },
    creds: c,
  };
}

test('app-state: ни разу не синхронизирован (accountSyncCounter=0), ключи есть → resyncAppState(все коллекции, initial) один раз, flush, счётчик сохранён', async () => {
  const st = appStateSock({ creds: { myAppStateKeyId: 'AAAA', accountSyncCounter: 0 } });
  let saved = 0;
  const { wa, sock } = setup({ sock: st.sockOver });
  st.attachFlush(sock);
  wa.d.createSocket = async () => ({ sock, saveCreds: async () => { saved++; } });
  await open(wa, sock);
  await ticks(6);
  assert.deepEqual(st.resyncCalls, [[['critical_block', 'critical_unblock_low'], true]]);
  assert.equal(st.flushes, 1);                                      // буфер событий Baileys не остаётся включённым
  assert.equal(st.creds.accountSyncCounter, 1);
  assert.ok(saved >= 1);
  sock.ev.emit('connection.update', { connection: 'open' });       // повторный open того же сокета
  await ticks(6);
  assert.equal(st.resyncCalls.length, 1);
});

test('app-state: уже синхронизирован или нет ключей от телефона → не зовём', async () => {
  for (const creds of [{ myAppStateKeyId: 'AAAA', accountSyncCounter: 1 }, { accountSyncCounter: 0 }]) {
    const st = appStateSock({ creds });
    const { wa, sock } = setup({ sock: st.sockOver });
    await open(wa, sock);
    await ticks(6);
    assert.equal(st.resyncCalls.length, 0, JSON.stringify(creds));
  }
});

test('app-state: resyncAppState бросил → без падения, счётчик не тронут (повтор при следующем подключении), flush всё равно', async () => {
  const st = appStateSock({ creds: { myAppStateKeyId: 'AAAA' }, resync: async () => { throw new Error('timed out'); } });
  const { wa, sock } = setup({ sock: st.sockOver });
  st.attachFlush(sock);
  await open(wa, sock);
  await ticks(6);
  assert.equal(st.resyncCalls.length, 1);
  assert.equal(st.creds.accountSyncCounter, undefined);
  assert.equal(st.flushes, 1);
  assert.equal(wa.authState, 'ready');
});

test('app-state: сокет закрылся, пока ждали задержку → не зовём', async () => {
  let release;
  const st = appStateSock({ creds: { myAppStateKeyId: 'AAAA' } });
  const { wa, sock } = setup({ sock: st.sockOver, deps: { sleep: () => new Promise(r => { release = r; }) } });
  await open(wa, sock);
  await wa.close();
  release();
  await ticks(6);
  assert.equal(st.resyncCalls.length, 0);
});

test('LID: другой номер для уже известного LID не перезаписывает прежний (чужой номер хуже безымянного диалога)', async () => {
  const { wa, sock, hooks, repoCalls } = setup();
  await open(wa, sock);
  sock.ev.emit('contacts.upsert', [{ id: '79001112233@s.whatsapp.net', lid: '777@lid' }]);
  await ticks(3);
  sock.ws.emit('CB:message', { tag: 'message', attrs: { id: 'C1', from: '79250177778@s.whatsapp.net', recipient: '777@lid', peer_recipient_pn: '79009990000@s.whatsapp.net' } });
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '777@lid', fromMe: true, id: 'C1' }, messageTimestamp: 1_700_000_000, message: { conversation: 'a' } }] });
  await ticks(4);
  assert.equal(hooks[0].payload.new_message.chat_id, '79001112233@c.us');
  assert.equal(repoCalls.filter(c => c[0] === 'rememberContacts').length, 1);
});

test('app-state: resyncAppState прошёл, но коллекция контактов не получила версию (Baileys глотает сбой расшифровки) → счётчик не ставим, повтор при следующем подключении', async () => {
  const st = appStateSock({ creds: { myAppStateKeyId: 'AAAA' }, contactsVersion: 0 });
  const { wa, sock } = setup({ sock: st.sockOver });
  st.attachFlush(sock);
  await open(wa, sock);
  await ticks(6);
  assert.equal(st.resyncCalls.length, 1);
  assert.equal(st.creds.accountSyncCounter, undefined);
  assert.equal(st.flushes, 1);
});
