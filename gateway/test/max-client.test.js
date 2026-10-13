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
  class FakeTransport extends EventEmitter {
    constructor(opts) { super(); this.opts = opts; this.calls = []; this.acks = []; this.isOpen = false; this.closedByUs = false; transports.push(this); }
    async connect() { if (over.connectError) throw new Error(over.connectError); this.isOpen = true; }
    async request(opcode, payload) {
      this.calls.push([opcode, payload]);
      if (!this.isOpen) throw Object.assign(new Error('соединение с MAX закрыто'), { code: 'transport_closed' });
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
  assert.deepEqual(t.calls.find(c => c[0] === 19)[1], { token: 'TOK', chatsCount: 200, interactive: true, chatsSync: 0, contactsSync: 0, presenceSync: -1, draftsSync: 0 });
  assert.equal(s.sessions.data.loginToken, 'TOK'); assert.equal(s.sessions.data.ownerId, OWNER); assert.equal(s.sessions.data.phone, '79200255591');
  assert.equal(s.client.ownerId, OWNER); assert.equal(s.client.ownPhone, '79200255591'); assert.equal(s.client.displayName, 'Тест');
  const ready = lastAuth(s.repoCalls);
  assert.deepEqual(ready.slice(0, 3), ['setAuth', 9, 'ready']); assert.equal(ready[3].phone, '79200255591'); assert.equal(ready[3].displayName, 'Тест');
  assert.equal(s.client.status().qr, null);
  assert.deepEqual(s.client.contacts.get(PEER), { id: PEER, phone: '79164942855', name: 'Mary' });
  assert.ok(s.repoCalls.some(c => c[0] === 'rememberContact' && c[2] === '79164942855' && c[3] === String(PEER)));
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

test('dirsFor: data/acc-<id>/max', () => {
  assert.deepEqual(MaxClient.dirsFor({ DATA_DIR: '/d' }, 7), { max: '/d/acc-7/max', base: '/d/acc-7' });
});
