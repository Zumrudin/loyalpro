'use strict';
// MaxTransport без сети: фейковый WebSocket (EventEmitter) — кадры, корреляция
// opcode:seq, ошибки cmd:3, таймаут, push/ack, PING, закрытие.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { MaxTransport, MaxServerError } = require('../lib/max/transport');

class FakeWs extends EventEmitter {
  constructor(url, opts) { super(); this.url = url; this.opts = opts; this.sent = []; this.closed = false; FakeWs.last = this; setImmediate(() => this.emit('open')); }
  send(data, cb) { this.sent.push(JSON.parse(data)); if (cb) cb(); }
  close() { this.closed = true; setImmediate(() => this.emit('close', 1000, Buffer.from(''))); }
  terminate() { this.terminated = true; setImmediate(() => this.emit('close', 1006, Buffer.from(''))); }
  reply(frame) { this.emit('message', Buffer.from(JSON.stringify({ ver: 11, ...frame }))); }
}
const mk = (o = {}) => new MaxTransport({ url: 'wss://x/websocket', WebSocket: FakeWs, pingIntervalMs: 0, requestTimeoutMs: 50, ...o });

test('connect: заголовки UA/Origin; request шлёт кадр ver 11 cmd 0 с растущим seq и резолвит payload ответа', async () => {
  const t = mk();
  await t.connect();
  assert.equal(FakeWs.last.opts.headers.Origin, 'https://web.max.ru');
  assert.match(FakeWs.last.opts.headers['User-Agent'], /Chrome/);
  assert.equal(FakeWs.last.opts.handshakeTimeout, 15000, 'без таймаута рукопожатия зависший TCP-connect вешал бы start() навсегда');
  const p1 = t.request(6, { deviceId: 'd' });
  const p2 = t.request(288);
  assert.deepEqual(FakeWs.last.sent[0], { ver: 11, cmd: 0, seq: 0, opcode: 6, payload: { deviceId: 'd' } });
  assert.deepEqual(FakeWs.last.sent[1], { ver: 11, cmd: 0, seq: 1, opcode: 288 });   // без payload — как web.max.ru
  FakeWs.last.reply({ cmd: 1, seq: 1, opcode: 288, payload: { qrLink: 'L' } });
  FakeWs.last.reply({ cmd: 1, seq: 0, opcode: 6, payload: { location: 'FI' } });
  assert.deepEqual(await p2, { qrLink: 'L' });
  assert.deepEqual(await p1, { location: 'FI' });
  t.close();
});

test('cmd:3 → MaxServerError с code/serverMessage/opcode', async () => {
  const t = mk(); await t.connect();
  const p = t.request(19, { token: 'x' });
  FakeWs.last.reply({ cmd: 3, seq: 0, opcode: 19, payload: { error: 'FAIL_LOGIN_TOKEN', message: 'revoked' } });
  await assert.rejects(p, (e) => e instanceof MaxServerError && e.code === 'FAIL_LOGIN_TOKEN' && e.serverMessage === 'revoked' && e.opcode === 19);
  t.close();
});

test('таймаут запроса → ошибка code=timeout; ответ после таймаута игнорируется', async () => {
  const t = mk({ requestTimeoutMs: 10 }); await t.connect();
  await assert.rejects(t.request(1, {}), (e) => e.code === 'timeout' && e.opcode === 1);
  FakeWs.last.reply({ cmd: 1, seq: 0, opcode: 1, payload: {} });   // не бросает
  t.close();
});

test('push сервера (cmd 0) → событие push; ack шлёт cmd 1 с тем же opcode/seq и payload', async () => {
  const t = mk(); await t.connect();
  const got = [];
  t.on('push', (f) => got.push(f));
  FakeWs.last.reply({ cmd: 0, seq: 77, opcode: 128, payload: { chatId: 5, message: { id: '9' } } });
  assert.equal(got.length, 1); assert.equal(got[0].opcode, 128);
  t.ack(got[0], { chatId: 5, messageId: '9' });
  assert.deepEqual(FakeWs.last.sent.at(-1), { ver: 11, cmd: 1, seq: 77, opcode: 128, payload: { chatId: 5, messageId: '9' } });
  t.close();
});

test('закрытие сервером: висящие запросы отвергнуты (transport_closed), событие close; наше close() события не даёт', async () => {
  const t = mk(); await t.connect();
  const closes = [];
  t.on('close', (code) => closes.push(code));
  const p = t.request(19, {});
  FakeWs.last.emit('close', 1006, Buffer.from('gone'));
  await assert.rejects(p, (e) => e.code === 'transport_closed' && e.sent === true);   // кадр ушёл — исход неизвестен
  assert.deepEqual(closes, [1006]);
  assert.equal(t.isOpen, false);
  await assert.rejects(t.request(1), (e) => e.code === 'transport_closed' && e.sent === false);   // не отправляли вовсе
  const t2 = mk(); await t2.connect();
  t2.on('close', () => closes.push('own'));
  t2.close();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(closes, [1006]);
  assert.equal(FakeWs.last.closed, true);
});

test('PING раз в pingIntervalMs с interactive:true (как max-account-api и PyMax); битый кадр → error, не падение', async () => {
  const t = mk({ pingIntervalMs: 5 }); await t.connect();
  const errs = []; t.on('error', (e) => errs.push(e.message));
  await new Promise(r => setTimeout(r, 20));
  const ping = FakeWs.last.sent.find(f => f.opcode === 1);
  assert.deepEqual(ping.payload, { interactive: true });
  FakeWs.last.emit('message', Buffer.from('{not json'));
  assert.equal(errs.length, 1);
  t.close();
});

test('connect: ошибка до open → reject', async () => {
  class BadWs extends EventEmitter { constructor() { super(); setImmediate(() => this.emit('error', new Error('ECONNREFUSED'))); } send() {} close() {} }
  await assert.rejects(new MaxTransport({ url: 'wss://x', WebSocket: BadWs, pingIntervalMs: 0 }).connect(), /ECONNREFUSED/);
});

test('полуоткрытое соединение: PING без ответа maxPingFailures раз подряд → terminate → событие close (клиент переподключится)', async () => {
  const t = mk({ pingIntervalMs: 5, requestTimeoutMs: 3 }); await t.connect();
  const closes = []; const errs = [];
  t.on('close', (code) => closes.push(code));
  t.on('error', (e) => errs.push(e.message));
  try {
    await new Promise(r => setTimeout(r, 60));
    assert.equal(FakeWs.last.terminated, true);
    assert.deepEqual(closes, [1006]);
    assert.equal(t.isOpen, false);
    assert.ok(errs.some(m => /PING/.test(m)), 'причина разрыва в логе');
  } finally { t.close(); }
});

test('ответ на PING (в т.ч. ошибкой сервера) обнуляет счётчик — живое соединение не рвём', async () => {
  const t = mk({ pingIntervalMs: 5, requestTimeoutMs: 3, maxPingFailures: 2 }); await t.connect();
  t.on('error', () => {});
  // Отвечаем на каждый второй PING: подряд без ответа никогда не больше одного.
  let n = 0;
  const origSend = FakeWs.last.send.bind(FakeWs.last);
  const ws = FakeWs.last;
  ws.send = (data, cb) => { origSend(data, cb); const f = JSON.parse(data); if (f.opcode === 1 && (n++ % 2 === 0)) setImmediate(() => ws.reply({ cmd: 3, seq: f.seq, opcode: 1, payload: { error: 'x' } })); };
  try {
    await new Promise(r => setTimeout(r, 60));
    assert.notEqual(ws.terminated, true);
    assert.equal(t.isOpen, true);
  } finally { t.close(); }
});
