'use strict';
// MaxClient без сети и БД: фейковый транспорт с обработчиками по опкодам.
// Проверяем автомат авторизации (QR-раунды и лимит, номер → код → пароль),
// LOGIN (ротация и отзыв токена), реконнект, входящие/эхо/фильтры, отправку
// текста и файлов, статусы доставок, logout/close.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { MaxClient, MAX_QR_ROUNDS, QR_ABANDONED_ERROR, FILE_READY_TIMEOUT_MS } = require('../lib/max-client');

const OWNER = 10001, PEER = 11478793;
const DIALOG = OWNER ^ PEER;
const PROFILE = { profile: { contact: { id: OWNER, phone: 79200255591, names: [{ name: 'Тест', type: 'ONEME' }] } }, chats: [{ id: DIALOG, type: 'DIALOG', participants: { [OWNER]: 1, [PEER]: 1 } }], contacts: [{ id: PEER, phone: 79164942855, names: [{ name: 'Mary' }] }] };

function setup(over = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-max-'));
  const handlers = { 6: () => ({ location: 'FI', 'phone-auth-enabled': true }), 19: () => PROFILE, ...(over.handlers || {}) };
  const transports = [];
  let connectFails = 0;
  class FakeTransport extends EventEmitter {
    constructor(opts) { super(); this.opts = opts; this.calls = []; this.acks = []; this.isOpen = false; this.closedByUs = false; transports.push(this); }
    async connect() {
      if (over.connectError) throw new Error(over.connectError);
      if (connectFails < (over.connectFailures || 0)) { connectFails++; throw new Error('ECONNREFUSED'); }
      this.isOpen = true;
    }
    async request(opcode, payload) {
      this.calls.push([opcode, payload]);
      if (!this.isOpen) throw Object.assign(new Error('соединение с MAX закрыто'), { code: 'transport_closed', sent: false });
      const h = handlers[opcode];
      if (!h) return {};
      const r = await h(payload, this);
      if (r instanceof Error) throw r;
      return r;
    }
    ack(frame, payload) { this.acks.push([frame.opcode, frame.seq, payload]); }
    close() { this.closedByUs = true; this.isOpen = false; }
    serverClose(code = 1006) { this.isOpen = false; this.emit('close', code, ''); }
    push(opcode, payload) { this.emit('push', { ver: 11, cmd: 0, seq: 1, opcode, payload }); }
    ops() { return this.calls.map(c => c[0]); }
  }
  const sessions = { data: { deviceId: 'dev-1', ...(over.session || {}) }, saved: [], removed: 0 };
  const repoCalls = [], delCalls = [], hooks = [], mediaCalls = [];
  let clock = 1_700_000_000_000;
  const deps = {
    Transport: FakeTransport,
    session: { load: () => ({ ...sessions.data }), save: (dir, d) => { sessions.data = { ...d }; sessions.saved.push({ ...d }); }, remove: () => { sessions.removed++; sessions.data = { deviceId: 'dev-2' }; }, hasToken: () => !!sessions.data.loginToken },
    media: {
      download: async (url) => { mediaCalls.push(['download', url]); return { buf: Buffer.from('WEBP'), mimeType: 'image/webp' }; },
      uploadPhoto: async (url, buf, name) => { mediaCalls.push(['uploadPhoto', url, name, buf.length]); return 'PHOTOTOKEN'; },
      uploadFile: async (url, buf, name) => { mediaCalls.push(['uploadFile', url, name, buf.length]); },
    },
    http: async () => { throw new Error('http не должен вызываться напрямую'); },
    qrToDataUrl: async (s) => `data:image/png;base64,${Buffer.from(s).toString('base64')}`,
    config: { DATA_DIR: tmp, PUBLIC_FILES_DIR: path.join(tmp, 'pub'), PUBLIC_FILES_URL: '/uploads/gateway', MAX_WS_URL: 'wss://x', MAX_WEB_APP_VERSION: '26.5.5', MAX_REQUEST_TIMEOUT_MS: 100 },
    repo: {
      setAuth: async (...a) => { repoCalls.push(['setAuth', ...a]); },
      rememberContact: async (...a) => { repoCalls.push(['rememberContact', ...a]); },
      rememberContacts: async (...a) => { repoCalls.push(['rememberContacts', ...a]); },
      contactUserId: async (acc, phone) => (over.knownPhones || {})[phone] || null,
      phoneByUserId: async (acc, uid) => (over.knownIds || {})[String(uid)] || null,
    },
    deliveries: {
      STATUS: { ACCEPTED: [1, 'Принято'], SENT: [2, 'Отправлено'], FAILED: [5, 'Невозможно доставить'] },
      create: async (row) => { delCalls.push(['create', row]); return 12; },
      setStatus: async (...a) => { delCalls.push(['setStatus', ...a]); },
      setStatusIf: async (...a) => { delCalls.push(['setStatusIf', ...a]); return true; },
      setProviderMessageId: async (...a) => { delCalls.push(['setProviderMessageId', ...a]); },
      failStale: async () => 0,
    },
    webhook: { sendSafe: async (b) => { hooks.push(b); } },
    now: () => clock,
    // setImmediate, а не resolved-промис: циклы опроса QR/реконнекта иначе крутились бы
    // в микрозадачах и голодали бы tick() на setImmediate.
    sleep: () => new Promise(r => setImmediate(r)),
    fileReadyTimeoutMs: 20,
  };
  const client = new MaxClient({ id: 9, channel: 'max', phone: null }, deps);
  const tick = (n = 3) => new Promise(r => { let i = 0; const f = () => (++i >= n ? r() : setImmediate(f)); setImmediate(f); });
  return { client, deps, transports, sessions, repoCalls, delCalls, hooks, mediaCalls, handlers, tmp, tick, advance: (ms) => { clock += ms; }, last: () => transports[transports.length - 1] };
}

const lastAuth = (repoCalls) => repoCalls.filter(c => c[0] === 'setAuth').at(-1);

test('start без токена: HELLO с deviceId и WEB-профилем, QR_START → wait_qr с data-URL в status()', async () => {
  const s = setup({ handlers: { 288: () => ({ qrLink: 'https://max.ru/:auth/t1', trackId: 't1', ttl: 120000, pollingInterval: 5000, expiresAt: 1_700_000_120_000 }), 289: () => ({ status: {} }) } });
  await s.client.start();
  const t = s.last();
  assert.equal(t.opts.url, 'wss://x');
  assert.deepEqual(t.calls[0], [6, { userAgent: { deviceType: 'WEB', locale: 'ru', deviceLocale: 'ru', osVersion: 'macOS', deviceName: 'Chrome', headerUserAgent: t.calls[0][1].userAgent.headerUserAgent, appVersion: '26.5.5', screen: '720x1280 1.0x', timezone: 'Europe/Moscow' }, deviceId: 'dev-1' }]);
  assert.equal(t.calls[1][0], 288);
  assert.equal(s.client.authState, 'wait_qr');
  assert.match(s.client.status().qr, /^data:image\/png;base64,/);
  assert.equal(s.client.status().pairingCode, null);
  assert.deepEqual(lastAuth(s.repoCalls).slice(0, 3), ['setAuth', 9, 'wait_qr']);
  assert.ok(fs.existsSync(path.join(s.tmp, 'acc-9', 'max')));
  await s.client.close();
});

test('QR отсканирован: QR_POLL loginAvailable → QR_LOGIN → LOGIN → ready, токен и профиль в сессии, контакты из LOGIN в кэше', async () => {
  let polls = 0;
  const s = setup({ handlers: {
    288: () => ({ qrLink: 'L', trackId: 't1', ttl: 120000, pollingInterval: 5000, expiresAt: 1_700_000_120_000 }),
    289: () => ({ status: ++polls >= 2 ? { loginAvailable: true } : {} }),
    291: (p) => (p.trackId === 't1' ? { tokenAttrs: { LOGIN: { token: 'TOK' } } } : new Error('wrong track')),
  } });
  await s.client.start();
  await s.tick(20);
  assert.equal(s.client.authState, 'ready');
  const t = s.last();
  assert.deepEqual(t.calls.find(c => c[0] === 19)[1], { token: 'TOK', chatsCount: 40, interactive: true, chatsSync: 0, contactsSync: 0, presenceSync: -1, draftsSync: 0 });
  assert.equal(s.sessions.data.loginToken, 'TOK'); assert.equal(s.sessions.data.ownerId, OWNER); assert.equal(s.sessions.data.phone, '79200255591');
  assert.equal(s.client.ownerId, OWNER); assert.equal(s.client.ownPhone, '79200255591'); assert.equal(s.client.displayName, 'Тест');
  const ready = lastAuth(s.repoCalls);
  assert.deepEqual(ready.slice(0, 3), ['setAuth', 9, 'ready']); assert.equal(ready[3].phone, '79200255591'); assert.equal(ready[3].displayName, 'Тест');
  assert.equal(s.client.status().qr, null);
  assert.deepEqual(s.client.contacts.get(PEER), { id: PEER, phone: '79164942855', name: 'Mary' });
  assert.deepEqual(s.repoCalls.find(c => c[0] === 'rememberContacts'), ['rememberContacts', 9, [{ phone: '79164942855', userId: String(PEER) }]], 'контакты LOGIN — одной пачкой, а не запросом на каждый');
  assert.equal(s.repoCalls.some(c => c[0] === 'rememberContact'), false);
  await s.client.close();
});

test('QR истёк → новый QR_START; после MAX_QR_ROUNDS раундов без входа — error и клиент закрыт', async () => {
  let starts = 0;
  const s = setup({ handlers: {
    288: () => ({ qrLink: 'L' + (++starts), trackId: 't' + starts, ttl: 120000, pollingInterval: 5000, expiresAt: 1_700_000_000_000 + starts * 1000 }),
    289: () => ({ status: {} }),
  } });
  await s.client.start();
  s.advance(60_000);            // любой трек уже истёк → каждая проверка начинает новый раунд
  await s.tick(40);
  assert.equal(starts, MAX_QR_ROUNDS);
  assert.equal(s.client.authState, 'error');
  assert.equal(s.client.closed, true);
  assert.equal(s.client.status().qr, null);
  assert.deepEqual(lastAuth(s.repoCalls).slice(0, 3), ['setAuth', 9, 'error']);
  assert.equal(lastAuth(s.repoCalls)[3].error, QR_ABANDONED_ERROR);
  assert.equal(s.last().closedByUs, true);
});

test('вход по номеру: authStep({phone}) в wait_qr → AUTH_REQUEST, wait_code, codeLength; {code} → AUTH → passwordChallenge → wait_password; {password} → 115 → LOGIN → ready', async () => {
  const s = setup({ handlers: {
    288: () => ({ qrLink: 'L', trackId: 't1', ttl: 120000, pollingInterval: 5000, expiresAt: 1_700_000_120_000 }), 289: () => ({ status: {} }),
    17: (p) => (p.phone === '+79200255591' && p.type === 'START_AUTH' ? { token: 'SMS', codeLength: 5 } : new Error('bad')),
    18: (p) => (p.token === 'SMS' && p.verifyCode === '12345' && p.authTokenType === 'CHECK_CODE' ? { tokenAttrs: {}, passwordChallenge: { trackId: 'tr', hint: 'кот' } } : Object.assign(new Error('MAX op 18: verify.code.wrong'), { code: 'verify.code.wrong' })),
    115: (p) => (p.trackId === 'tr' && p.password === 'secret' ? { tokenAttrs: { LOGIN: { token: 'TOK2' } } } : { error: 'password.wrong' }),
  } });
  await s.client.start();
  const r1 = await s.client.authStep({ phone: '+7 (920) 025-55-91' });
  assert.deepEqual(r1, { authState: 'wait_code', error: null, qr: null, codeLength: 5 });
  assert.equal(s.client.status().codeLength, 5);
  assert.equal(s.client.status().qr, null);
  const bad = await s.client.authStep({ code: '00000' });
  assert.equal(bad.authState, 'wait_code'); assert.match(bad.error, /verify\.code\.wrong/);
  assert.equal(lastAuth(s.repoCalls)[3].error, bad.error);
  const r2 = await s.client.authStep({ code: '12345' });
  assert.equal(r2.authState, 'wait_password'); assert.equal(s.client.status().passwordHint, 'кот');
  const badPw = await s.client.authStep({ password: 'nope' });
  assert.equal(badPw.authState, 'wait_password'); assert.match(badPw.error, /password\.wrong/);
  const r3 = await s.client.authStep({ password: 'secret' });
  assert.equal(r3.authState, 'ready');
  assert.equal(s.sessions.data.loginToken, 'TOK2');
  assert.equal((await s.client.authStep({ phone: '79200255591' })).error.includes('wait_qr'), true);   // в ready номер не принимается
  assert.equal((await s.client.authStep({})).error, 'нужен phone, code или password');
  await s.client.close();
});

test('start с токеном: сразу LOGIN (без QR), ротация token сохранена, failStale вызван', async () => {
  let stale = 0;
  const s = setup({ session: { loginToken: 'OLD' }, handlers: { 19: (p) => (p.token === 'OLD' ? { ...PROFILE, token: 'NEW' } : new Error('x')) } });
  s.deps.deliveries.failStale = async () => { stale++; return 2; };
  await s.client.start();
  assert.equal(s.client.authState, 'ready');
  assert.deepEqual(s.last().ops(), [6, 19]);
  assert.equal(s.sessions.data.loginToken, 'NEW');
  assert.equal(stale, 1);
  await s.client.close();
});

test('LOGIN отверг токен (FAIL_LOGIN_TOKEN) → logged_out, сессия удалена, реконнекта нет', async () => {
  const s = setup({ session: { loginToken: 'OLD' }, handlers: { 19: () => Object.assign(new Error('MAX op 19: FAIL_LOGIN_TOKEN'), { code: 'FAIL_LOGIN_TOKEN' }) } });
  await s.client.start();
  assert.equal(s.client.authState, 'logged_out');
  assert.equal(s.client.closed, true);
  assert.equal(s.sessions.removed, 1);
  assert.equal(s.transports.length, 1);
  assert.deepEqual(lastAuth(s.repoCalls).slice(0, 3), ['setAuth', 9, 'logged_out']);
});

test('обрыв в ready → реконнект: новый транспорт, HELLO + LOGIN; обрыв в wait_qr → новый QR-раунд', async () => {
  const s = setup({ session: { loginToken: 'T' } });
  await s.client.start();
  s.last().serverClose(1006);
  await s.tick(10);
  assert.equal(s.transports.length, 2);
  assert.deepEqual(s.last().ops(), [6, 19]);
  assert.equal(s.client.authState, 'ready');
  await s.client.close();

  const q = setup({ handlers: { 288: () => ({ qrLink: 'L', trackId: 't1', ttl: 120000, pollingInterval: 5000, expiresAt: 1_700_000_120_000 }), 289: () => ({ status: {} }) } });
  await q.client.start();
  q.last().serverClose(1006);
  await q.tick(10);
  assert.equal(q.transports.length, 2);
  assert.deepEqual(q.last().ops().slice(0, 2), [6, 288]);
  assert.equal(q.client.authState, 'wait_qr');
  await q.client.close();
});

test('реконнект: connect упал — пробуем снова (бэкофф через sleep), не застреваем', async () => {
  const s = setup({ session: { loginToken: 'T' } });
  await s.client.start();
  let fails = 2;
  const origConnect = s.deps.Transport.prototype.connect;
  s.deps.Transport.prototype.connect = async function () { if (fails-- > 0) throw new Error('ECONNRESET'); return origConnect.call(this); };
  s.last().serverClose(1006);
  await s.tick(20);
  assert.equal(s.client.authState, 'ready');
  assert.equal(s.transports.length, 4);
  await s.client.close();
});

test('logout: LOGOUT, транспорт закрыт, сессия удалена, logged_out; close: close-событие после него реконнект не запускает', async () => {
  const s = setup({ session: { loginToken: 'T' } });
  await s.client.start();
  await s.client.logout();
  assert.ok(s.last().calls.some(c => c[0] === 20));
  assert.equal(s.last().closedByUs, true);
  assert.equal(s.sessions.removed, 1);
  assert.equal(s.client.authState, 'logged_out');
  assert.deepEqual(lastAuth(s.repoCalls).slice(0, 3), ['setAuth', 9, 'logged_out']);

  const c = setup({ session: { loginToken: 'T' } });
  await c.client.start();
  const t = c.last();
  await c.client.close();
  t.emit('close', 1006, '');
  await c.tick(5);
  assert.equal(c.transports.length, 1);
  assert.equal(c.client.closed, true);
});

test('dirsFor: data/acc-<id>/max и файл сессии', () => {
  assert.deepEqual(MaxClient.dirsFor({ DATA_DIR: '/d' }, 7), { max: '/d/acc-7/max', base: '/d/acc-7', session: '/d/acc-7/max/session.json' });
});

// ── Входящие (Task 5) ────────────────────────────────────────
const MSG = (over = {}) => ({ id: '117418041090250363', sender: PEER, time: 1_700_000_000_000, type: 'USER', text: 'Здравствуйте', attaches: [], ...over });
async function ready(over = {}) {
  const s = setup({ session: { loginToken: 'T' }, ...over });
  await s.client.start();
  assert.equal(s.client.authState, 'ready');
  return s;
}

test('входящее личное: push 128 квитирован, вебхук max_incoming_msg с chat_id = id собеседника, номером и именем из кэша LOGIN', async () => {
  const s = await ready();
  s.last().push(128, { chatId: DIALOG, message: MSG(), unread: 1, mark: 1 });
  await s.tick(10);
  assert.deepEqual(s.last().acks, [[128, 1, { chatId: DIALOG, messageId: '117418041090250363' }]]);
  assert.equal(s.hooks.length, 1);
  const p = s.hooks[0].payload;
  assert.equal(s.hooks[0].type, 'max_incoming_msg');
  assert.equal(p.direction, 'incoming'); assert.equal(p.chat_id, String(PEER)); assert.equal(p.chat_type, 'person');
  assert.equal(p.sender_phone_number, '79164942855'); assert.equal(p.sender_name, 'Mary'); assert.equal(p.recipient_phone_number, '79200255591');
  assert.equal(p.customer_id, 9); assert.equal(p.provider, 'gateway'); assert.equal(p.delivery_id, null);
  assert.equal(p.message.text, 'Здравствуйте'); assert.equal(p.message.type, 'text'); assert.equal(p.timestamp, 1_700_000_000);
  await s.client.close();
});

test('незнакомый собеседник (чата нет в снимке): peer из XOR, CONTACT_INFO один раз → имя/номер, контакт записан в gateway_contacts; номер скрыт → null, затем из БД', async () => {
  const OTHER = 777;
  let infos = 0;
  const s = await ready({ handlers: { 32: (p) => { infos++; return { contacts: p.contactIds[0] === OTHER ? [{ id: OTHER, phone: 79001112233, names: [{ firstName: 'Анна', lastName: 'П' }] }] : [{ id: p.contactIds[0] }] }; } }, knownIds: { 888: '79009998877' } });
  s.last().push(128, { chatId: OWNER ^ OTHER, message: MSG({ id: '1', sender: OTHER }) });
  s.last().push(128, { chatId: OWNER ^ OTHER, message: MSG({ id: '2', sender: OTHER }) });
  await s.tick(10);
  assert.equal(infos, 1);
  assert.equal(s.hooks.length, 2);
  assert.equal(s.hooks[0].payload.chat_id, '777'); assert.equal(s.hooks[0].payload.sender_phone_number, '79001112233'); assert.equal(s.hooks[0].payload.sender_name, 'Анна П');
  assert.ok(s.repoCalls.some(c => c[0] === 'rememberContact' && c[2] === '79001112233' && c[3] === '777'));
  s.last().push(128, { chatId: OWNER ^ 888, message: MSG({ id: '3', sender: 888 }) });
  await s.tick(10);
  assert.equal(s.hooks[2].payload.sender_phone_number, '79009998877');   // CONTACT_INFO без номера → gateway_contacts
  assert.equal(s.hooks[2].payload.chat_id, '888');
  await s.client.close();
});

test('фильтры: SYSTEM, правка (status), старше 6 ч, канал, «Избранное» (chatId 0), своя отправка (ownSends) — в бэкенд не идут', async () => {
  const s = await ready();
  s.client.chats.set(-5, { id: -5, type: 'CHANNEL', title: 'Канал' });
  s.client.ownSends.set('OWN1', { deliveryId: 1, ts: s.deps.now() });
  const t = s.last();
  t.push(128, { chatId: DIALOG, message: MSG({ id: 'a', type: 'SYSTEM' }) });
  t.push(128, { chatId: DIALOG, message: MSG({ id: 'b', status: 'EDITED' }) });
  t.push(128, { chatId: DIALOG, message: MSG({ id: 'c', time: 1_700_000_000_000 - 7 * 3600 * 1000 }) });
  t.push(128, { chatId: -5, message: MSG({ id: 'd', sender: 42 }) });
  t.push(128, { chatId: 0, message: MSG({ id: 'e', sender: OWNER }) });
  t.push(128, { chatId: DIALOG, message: MSG({ id: 'OWN1', sender: OWNER }) });
  t.push(128, { chatId: DIALOG, message: MSG({ id: 'f', text: '', attaches: [{ _type: 'CONTROL', event: 'new' }] }) });
  await s.tick(10);
  assert.equal(s.hooks.length, 0);
  assert.equal(t.acks.length, 7);         // квитируем всё, даже то, что не форвардим
  await s.client.close();
});

test('своё сообщение с телефона (sender === ownerId) → outgoing без delivery_id, номер клиента в recipient_phone_number', async () => {
  const s = await ready();
  s.last().push(128, { chatId: DIALOG, message: MSG({ id: 'o1', sender: OWNER, text: 'ответ админа' }) });
  await s.tick(10);
  const p = s.hooks[0].payload;
  assert.equal(p.direction, 'outgoing'); assert.equal(p.delivery_id, null);
  assert.equal(p.recipient_phone_number, '79164942855'); assert.equal(p.sender_phone_number, '79200255591'); assert.equal(p.chat_id, String(PEER));
  await s.client.close();
});

test('группа: chat_type group, chat_id = id чата, номер участника из кэша, медиа не качается; NOTIF_CHAT пополняет снимок', async () => {
  const s = await ready();
  s.last().push(135, { chat: { id: -72962629261478, type: 'CHAT', title: 'Админы', participants: { [OWNER]: 1, [PEER]: 1, 555: 1 } } });
  s.last().push(128, { chatId: -72962629261478, message: MSG({ id: 'g1', sender: PEER, text: 'в группу', attaches: [{ _type: 'PHOTO', baseUrl: 'https://i/g' }] }) });
  await s.tick(10);
  const p = s.hooks[0].payload;
  assert.equal(p.chat_type, 'group'); assert.equal(p.chat_id, '-72962629261478'); assert.equal(p.chat_name, 'Админы');
  assert.equal(p.sender_phone_number, '79164942855'); assert.equal(p.sender_name, 'Mary');
  assert.equal(p.message.type, 'image'); assert.equal(p.message.file_data, undefined);
  assert.equal(s.mediaCalls.length, 0);
  await s.client.close();
});

test('фото в личке: baseUrl скачан в публичный каталог с расширением по фактическому MIME, file_data в вебхуке; файл — FILE_DOWNLOAD → url', async () => {
  const s = await ready({ handlers: { 88: (p) => ({ url: `https://fd/${p.fileId}`, unsafe: false }) } });
  s.last().push(128, { chatId: DIALOG, message: MSG({ id: 'p1', text: 'см', attaches: [{ _type: 'PHOTO', baseUrl: 'https://i/1', photoId: 1 }] }) });
  await s.tick(10);
  const fd = s.hooks[0].payload.message.file_data;
  assert.match(fd.download_url, /^\/uploads\/gateway\/9\/\d+_[0-9a-f]{16}\.webp$/);
  assert.equal(fd.mime_type, 'image/webp'); assert.equal(fd.caption, 'см');
  assert.ok(fs.existsSync(path.join(s.tmp, 'pub', '9', path.basename(fd.download_url))));
  assert.deepEqual(s.mediaCalls[0], ['download', 'https://i/1']);
  s.deps.media.download = async (url) => { s.mediaCalls.push(['download', url]); return { buf: Buffer.from('%PDF'), mimeType: null }; };
  s.last().push(128, { chatId: DIALOG, message: MSG({ id: 'f1', text: '', attaches: [{ _type: 'FILE', fileId: 42, name: 'Прайс.pdf', size: 4 }] }) });
  await s.tick(10);
  assert.deepEqual(s.last().calls.find(c => c[0] === 88)[1], { fileId: 42, chatId: DIALOG, messageId: 'f1' });
  assert.deepEqual(s.mediaCalls[1], ['download', 'https://fd/42']);
  const fd2 = s.hooks[1].payload.message.file_data;
  assert.match(fd2.download_url, /\.pdf$/); assert.equal(fd2.mime_type, 'application/pdf'); assert.equal(fd2.file_name, 'Прайс.pdf');
  await s.client.close();
});

test('медиа не скачалось (ошибка/лимит) → сообщение уходит без file_data; заявленный размер больше кэпа — без запроса', async () => {
  const s = await ready();
  s.deps.media.download = async () => { throw new Error('HTTP 500'); };
  s.last().push(128, { chatId: DIALOG, message: MSG({ id: 'p2', attaches: [{ _type: 'PHOTO', baseUrl: 'https://i/2' }] }) });
  s.last().push(128, { chatId: DIALOG, message: MSG({ id: 'f2', attaches: [{ _type: 'FILE', fileId: 1, name: 'big.pdf', size: 50 * 1024 * 1024 }] }) });
  await s.tick(10);
  assert.equal(s.hooks.length, 2);
  assert.equal(s.hooks[0].payload.message.file_data, undefined); assert.equal(s.hooks[0].payload.message.type, 'image');
  assert.equal(s.hooks[1].payload.message.file_data, undefined);
  assert.equal(s.last().calls.some(c => c[0] === 88), false);
  await s.client.close();
});

test('пока LOGIN не прошёл (connected=false), push сообщений игнорируется', async () => {
  const s = setup({ handlers: { 288: () => ({ qrLink: 'L', trackId: 't', ttl: 1, pollingInterval: 5000, expiresAt: 1_700_000_120_000 }), 289: () => ({ status: {} }) } });
  await s.client.start();
  s.last().push(128, { chatId: DIALOG, message: MSG() });
  await s.tick(5);
  assert.equal(s.hooks.length, 0);
  await s.client.close();
});

// ── Отправка (Task 6) ────────────────────────────────────────
const SENT = (p) => ({ chatId: p.chatId, message: { id: '117418999', sender: OWNER, time: 1_700_000_050_000, type: 'USER', text: p.message.text, attaches: p.message.attaches || [] }, unread: 0, mark: 0 });

test('sendText по max_user_id: chatId = ownerId XOR id, кадр MSG_SEND, доставка g12 «Отправлено» с provider_message_id, эхо с delivery_id; push того же id пропущен', async () => {
  const s = await ready({ handlers: { 64: (p) => SENT(p) } });
  const id = await s.client.sendText({ text: 'Здравствуйте!', maxUserId: String(PEER), phone: '79164942855', replyToMessageId: '117418041090250363' });
  assert.equal(id, 12);
  const send = s.last().calls.find(c => c[0] === 64)[1];
  assert.equal(send.chatId, DIALOG); assert.equal(send.notify, true);
  assert.equal(send.message.text, 'Здравствуйте!'); assert.deepEqual(send.message.attaches, []); assert.deepEqual(send.message.elements, []);
  assert.equal(typeof send.message.cid, 'number'); assert.deepEqual(send.message.link, { type: 'REPLY', messageId: '117418041090250363' });
  assert.deepEqual(s.delCalls[0], ['create', { accountId: 9, chatId: DIALOG, phone: '79164942855', kind: 'text', text: 'Здравствуйте!' }]);
  assert.deepEqual(s.delCalls.find(c => c[0] === 'setProviderMessageId'), ['setProviderMessageId', 12, '117418999']);
  assert.deepEqual(s.delCalls.find(c => c[0] === 'setStatusIf').slice(0, 4), ['setStatusIf', 12, 1, [2, 'Отправлено']]);
  await s.tick(10);
  assert.equal(s.hooks.length, 1);
  const p = s.hooks[0].payload;
  assert.equal(p.direction, 'outgoing'); assert.equal(p.delivery_id, 'g12'); assert.equal(p.message.id, '117418999'); assert.equal(p.recipient_phone_number, '79164942855'); assert.equal(p.chat_id, String(PEER));
  s.last().push(128, { chatId: DIALOG, message: { id: '117418999', sender: OWNER, time: 1_700_000_050_000, type: 'USER', text: 'Здравствуйте!' } });
  await s.tick(10);
  assert.equal(s.hooks.length, 1);
  await s.client.close();
});

test('cid монотонный даже при одинаковом now; reply_to не числовой (составной id Telegram) → без link; отрицательный max_user_id → группа как есть', async () => {
  const s = await ready({ handlers: { 64: (p) => SENT(p) } });
  await s.client.sendText({ text: 'a', maxUserId: PEER, replyToMessageId: '5245186003:10' });
  await s.client.sendText({ text: 'b', maxUserId: '-72962629261478' });
  const sends = s.last().calls.filter(c => c[0] === 64).map(c => c[1]);
  assert.equal(sends[0].message.link, undefined);
  assert.ok(sends[1].message.cid > sends[0].message.cid);
  assert.equal(sends[1].chatId, -72962629261478);
  assert.equal(s.delCalls.filter(c => c[0] === 'create')[1][1].chatId, -72962629261478);
  await s.client.close();
});

test('sendText по номеру: кэш контактов → без поиска; gateway_contacts → без поиска; иначе CONTACT_INFO_BY_PHONE (+7…) и контакт запомнен; не найден → 422 без доставки', async () => {
  let lookups = 0;
  const s = await ready({ knownPhones: { 79009998877: 888 }, handlers: { 64: (p) => SENT(p), 46: (p) => { lookups++; return p.phone === '+79005556677' ? { contact: { id: 999, names: [{ name: 'Новый' }] } } : Object.assign(new Error('MAX op 46: contact.not.found'), { code: 'contact.not.found' }); } } });
  await s.client.sendText({ text: 'a', phone: '+7 (916) 494-28-55' });     // Mary из LOGIN.contacts
  await s.client.sendText({ text: 'b', phone: '79009998877' });            // из gateway_contacts
  assert.equal(lookups, 0);
  await s.client.sendText({ text: 'c', phone: '79005556677' });
  assert.equal(lookups, 1);
  const sends = s.last().calls.filter(c => c[0] === 64).map(c => c[1].chatId);
  assert.deepEqual(sends, [OWNER ^ PEER, OWNER ^ 888, OWNER ^ 999]);
  assert.ok(s.repoCalls.some(c => c[0] === 'rememberContact' && c[2] === '79005556677' && c[3] === '999'));
  const n = s.delCalls.length;
  await assert.rejects(s.client.sendText({ text: 'd', phone: '70000000000' }), (e) => e.status === 422 && /не найден в MAX/.test(e.message));
  assert.equal(s.delCalls.length, n);
  await assert.rejects(s.client.sendText({ text: 'd' }), (e) => e.status === 422);
  await s.client.close();
});

test('не ready / нет соединения → 422 до создания доставки; MSG_SEND отверг → FAILED + 422; таймаут → FAILED + 503; rate limit → 429', async () => {
  const s = await ready({ handlers: { 64: (p) => (p.message.text === 'limit' ? Object.assign(new Error('MAX op 64: too.many.requests'), { code: 'too.many.requests' }) : p.message.text === 'slow' ? Object.assign(new Error('MAX op 64: нет ответа'), { code: 'timeout' }) : Object.assign(new Error('MAX op 64: chat.denied'), { code: 'chat.denied' })) } });
  await assert.rejects(s.client.sendText({ text: 'x', maxUserId: PEER }), (e) => e.status === 422 && /chat\.denied/.test(e.message));
  assert.deepEqual(s.delCalls.find(c => c[0] === 'setStatus').slice(0, 3), ['setStatus', 12, [5, 'Невозможно доставить']]);
  await assert.rejects(s.client.sendText({ text: 'slow', maxUserId: PEER }), (e) => e.status === 503);
  await assert.rejects(s.client.sendText({ text: 'limit', maxUserId: PEER }), (e) => e.status === 429);
  s.last().isOpen = false; s.client.connected = false;
  const n = s.delCalls.length;
  await assert.rejects(s.client.sendText({ text: 'y', maxUserId: PEER }), (e) => e.status === 422 && /переподключение/.test(e.message));
  assert.equal(s.delCalls.length, n);
  await s.client.close();
  const q = setup({ handlers: { 288: () => ({ qrLink: 'L', trackId: 't', ttl: 1, pollingInterval: 5000, expiresAt: 1_700_000_120_000 }), 289: () => ({ status: {} }) } });
  await q.client.start();
  await assert.rejects(q.client.sendText({ text: 'z', maxUserId: PEER }), (e) => e.status === 422 && /не авторизован/.test(e.message));
  await q.client.close();
});

test('sendFile image: PHOTO_UPLOAD → uploadPhoto → attaches PHOTO с токеном, подпись в text; временный файл удалён', async () => {
  const s = await ready({ handlers: { 64: (p) => SENT(p), 80: () => ({ url: 'https://iu/upload?photoIds=1' }) } });
  const dir = fs.mkdtempSync(path.join(s.tmp, 'tmp-')); const f = path.join(dir, 'a.jpg'); fs.writeFileSync(f, 'JPG');
  const id = await s.client.sendFile({ filePath: f, fileName: 'a.jpg', caption: 'прайс', type: 'image', maxUserId: PEER, mimeType: 'image/jpeg' });
  assert.equal(id, 12);
  assert.equal(fs.existsSync(f), false);
  assert.deepEqual(s.mediaCalls[0], ['uploadPhoto', 'https://iu/upload?photoIds=1', 'a.jpg', 3]);
  const send = s.last().calls.find(c => c[0] === 64)[1];
  assert.deepEqual(send.message.attaches, [{ _type: 'PHOTO', photoToken: 'PHOTOTOKEN' }]); assert.equal(send.message.text, 'прайс');
  assert.deepEqual(s.delCalls[0][1], { accountId: 9, chatId: DIALOG, phone: null, kind: 'file', text: 'прайс' });
  await s.client.close();
});

test('sendFile документ: FILE_UPLOAD → uploadFile → ждёт NOTIF_ATTACH {fileId} → attaches FILE; без push — отправка после таймаута ожидания', async () => {
  const s = await ready({ handlers: { 64: (p) => SENT(p), 87: () => ({ info: [{ url: 'https://fu/upload', fileId: 42, token: 't' }] }) } });
  s.deps.media.uploadFile = async (url, buf, name) => { s.mediaCalls.push(['uploadFile', url, name, buf.length]); setImmediate(() => s.last().push(136, { fileId: 42 })); };
  const dir = fs.mkdtempSync(path.join(s.tmp, 'tmp-')); const f = path.join(dir, 'p.pdf'); fs.writeFileSync(f, '%PDF');
  await s.client.sendFile({ filePath: f, fileName: 'Прайс.pdf', caption: '', type: 'document', maxUserId: PEER });
  assert.deepEqual(s.mediaCalls[0], ['uploadFile', 'https://fu/upload', 'Прайс.pdf', 4]);
  assert.deepEqual(s.last().calls.find(c => c[0] === 64)[1].message.attaches, [{ _type: 'FILE', fileId: 42 }]);
  assert.equal(s.delCalls[0][1].text, 'Прайс.pdf');
  s.deps.media.uploadFile = async () => {};                       // push 136 не придёт — ждём fileReadyTimeoutMs (20 мс в тестах)
  const f2 = path.join(fs.mkdtempSync(path.join(s.tmp, 'tmp-')), 'q.pdf'); fs.writeFileSync(f2, '%PDF');   // первый каталог клиент уже удалил вместе с файлом
  const t0 = Date.now();
  await s.client.sendFile({ filePath: f2, fileName: 'q.pdf', type: 'document', maxUserId: PEER });
  assert.ok(Date.now() - t0 >= 15);
  assert.equal(s.last().calls.filter(c => c[0] === 64).length, 2);
  await s.client.close();
});

test('attachment.not.ready → пауза и один повтор MSG_SEND; файл не читается → 422 без доставки и без загрузки', async () => {
  let tries = 0;
  const s = await ready({ handlers: { 64: (p) => (++tries === 1 ? Object.assign(new Error('MAX op 64: attachment.not.ready'), { code: 'attachment.not.ready' }) : SENT(p)), 80: () => ({ url: 'u' }) } });
  const dir = fs.mkdtempSync(path.join(s.tmp, 'tmp-')); const f = path.join(dir, 'a.png'); fs.writeFileSync(f, 'PNG');
  await s.client.sendFile({ filePath: f, fileName: 'a.png', type: 'image', maxUserId: PEER, mimeType: 'image/png' });
  assert.equal(tries, 2);
  assert.deepEqual(s.delCalls.find(c => c[0] === 'setStatusIf').slice(0, 4), ['setStatusIf', 12, 1, [2, 'Отправлено']]);
  const n = s.delCalls.length;
  await assert.rejects(s.client.sendFile({ filePath: path.join(dir, 'nope.pdf'), fileName: 'nope.pdf', type: 'document', maxUserId: PEER }), (e) => e.status === 422 && /не прочитан/.test(e.message));
  assert.equal(s.delCalls.length, n);
  assert.equal(s.mediaCalls.length, 1);
  await s.client.close();
});

// ── Правки самопроверки (14.10.2026) ─────────────────────────
test('start: сервер MAX недоступен при первом подключении → start() не бросает, реконнект в фоне входит по токену', async () => {
  const s = setup({ session: { loginToken: 'T' }, connectFailures: 2 });
  await s.client.start();
  await s.tick(20);
  assert.equal(s.client.authState, 'ready');
  assert.equal(s.transports.length, 3);
  await s.client.close();
});

test('QR_START отвергнут сервером (не обрыв) → error, клиент закрыт — «Запустить заново» начнёт с начала', async () => {
  const s = setup({ handlers: { 288: () => Object.assign(new Error('MAX op 288: too.many.requests'), { code: 'too.many.requests' }) } });
  await s.client.start();
  assert.equal(s.client.authState, 'error');
  assert.equal(s.client.closed, true);
  assert.match(lastAuth(s.repoCalls)[3].error, /too\.many\.requests/);
});

test('LOGIN после выдачи токена упал (таймаут) → не новый QR, а реконнект и вход по сохранённому токену', async () => {
  let logins = 0, qrStarts = 0;
  const s = setup({ handlers: {
    288: () => { qrStarts++; return { qrLink: 'L', trackId: 't1', ttl: 120000, pollingInterval: 5000, expiresAt: 1_700_000_120_000 }; },
    289: () => ({ status: { loginAvailable: true } }),
    291: () => ({ tokenAttrs: { LOGIN: { token: 'TOK' } } }),
    19: () => (++logins === 1 ? Object.assign(new Error('MAX op 19: нет ответа'), { code: 'timeout' }) : PROFILE),
  } });
  await s.client.start();
  await s.tick(30);
  assert.equal(s.client.authState, 'ready');
  assert.equal(qrStarts, 1);
  assert.equal(logins, 2);
  assert.equal(s.sessions.data.loginToken, 'TOK');
  assert.equal(s.transports.length, 2);
  await s.client.close();
});

test('своё push, пришедшее ДО ответа MSG_SEND, не становится эхом оператора: эхо одно — синтезированное, с delivery_id', async () => {
  const s = await ready({ handlers: { 64: (p, t) => {
    // Сервер разослал сообщение всем сессиям раньше, чем ответил на MSG_SEND.
    t.push(128, { chatId: p.chatId, message: { id: '117418999', sender: OWNER, time: 1_700_000_050_000, type: 'USER', text: p.message.text } });
    return new Promise(r => setImmediate(() => r(SENT(p))));
  } } });
  await s.client.sendText({ text: 'Ответ Милы', maxUserId: PEER });
  await s.tick(10);
  assert.equal(s.hooks.length, 1);
  assert.equal(s.hooks[0].payload.delivery_id, 'g12');
  assert.equal(s.client.inflight.size, 0);
  await s.client.close();
});

test('max_user_id + номер диалога: номер контакта расходится → шлём по номеру; совпадает или скрыт приватностью → по id', async () => {
  let lookups = 0;
  const s = await ready({ handlers: {
    64: (p) => SENT(p),
    32: (p) => ({ contacts: [p.contactIds[0] === 777 ? { id: 777, phone: 79001112233, names: [{ name: 'Чужой' }] } : { id: p.contactIds[0], names: [{ name: 'Скрытый' }] }] }),
    46: (p) => { lookups++; return p.phone === '+79005556677' ? { contact: { id: 999 } } : Object.assign(new Error('MAX op 46: not.found'), { code: 'not.found' }); },
  } });
  await s.client.sendText({ text: 'a', maxUserId: 777, phone: '79005556677' });
  assert.equal(lookups, 1);
  await s.client.sendText({ text: 'b', maxUserId: PEER, phone: '79164942855' });
  await s.client.sendText({ text: 'c', maxUserId: 555, phone: '79001110000' });
  assert.equal(lookups, 1);
  assert.deepEqual(s.last().calls.filter(c => c[0] === 64).map(c => c[1].chatId), [OWNER ^ 999, OWNER ^ PEER, OWNER ^ 555]);
  await s.client.close();
});

test('MSG_SEND: transport_closed до отправки кадра (sent:false) → 422; после отправки (sent:true) → 503', async () => {
  const s = await ready({ handlers: { 64: (p) => Object.assign(new Error('соединение с MAX закрыто'), { code: 'transport_closed', sent: p.message.text === 'after' }) } });
  await assert.rejects(s.client.sendText({ text: 'before', maxUserId: PEER }), (e) => e.status === 422);
  await assert.rejects(s.client.sendText({ text: 'after', maxUserId: PEER }), (e) => e.status === 503);
  await s.client.close();
});

test('sendFile: клиент закрыт во время загрузки файла → 422 без доставки', async () => {
  const s = await ready({ handlers: { 87: () => ({ info: [{ url: 'https://fu/upload', fileId: 42, token: 't' }] }) } });
  s.deps.media.uploadFile = async () => { await s.client.close(); };
  const dir = fs.mkdtempSync(path.join(s.tmp, 'tmp-')); const f = path.join(dir, 'p.pdf'); fs.writeFileSync(f, '%PDF');
  await assert.rejects(s.client.sendFile({ filePath: f, fileName: 'p.pdf', type: 'document', maxUserId: PEER }), (e) => e.status === 422);
  assert.equal(s.delCalls.filter(c => c[0] === 'create').length, 0);
});

test('фото: CDN отдал application/octet-stream → MIME по сигнатуре JPEG → .jpg в публичном каталоге', async () => {
  const s = await ready();
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
  s.deps.media.download = async () => ({ buf: jpeg, mimeType: 'application/octet-stream' });
  s.last().push(128, { chatId: DIALOG, message: MSG({ id: 'p9', attaches: [{ _type: 'PHOTO', baseUrl: 'https://i/9' }] }) });
  await s.tick(10);
  const fd = s.hooks[0].payload.message.file_data;
  assert.match(fd.download_url, /\.jpg$/); assert.equal(fd.mime_type, 'image/jpeg');
  await s.client.close();
});
