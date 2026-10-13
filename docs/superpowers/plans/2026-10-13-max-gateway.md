# MAX через свой шлюз — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Подключить MAX клиники к нашему шлюзу `gateway/` (веб-сессия MAX по QR, как web.max.ru) так, чтобы бэкенд и админка работали с ним ровно как с Telegram/WhatsApp: приём входящих в форме `max_incoming_msg`, отправка текста и файлов, переключение канала с Chatpush и откат.

**Architecture:** Свой тонкий клиент веб-протокола MAX (JSON поверх WebSocket, 14 опкодов) в трёх модулях: `lib/max/transport.js` (кадры, корреляция, PING, push), чистый `lib/max-mapper.js` (сообщение → тело вебхука Chatpush-формы) и `lib/max-client.js` с интерфейсом `WhatsappClient`. Реестр выбирает класс по `channel='max'`, сервер пробрасывает `max_user_id`, бэкенд/админка получают кнопку «Подключить MAX напрямую» с QR и резервным входом по номеру.

**Tech Stack:** Node 20+ (`ws` 8.x — уже в `node_modules` шлюза транзитивно, фиксируем явно), `qrcode`, `axios`; тесты `node --test` (шлюз, фронт), `jest` (бэкенд). Спека: `docs/superpowers/specs/2026-10-13-max-gateway-design.md`. Исследование: `docs/2026-10-13-max-gateway-feasibility.md`.

---

## Кто какую задачу делает (экономия токенов)

| Задача | Исполнитель |
|---|---|
| 0 зависимости и конфиг, 9 документация | 🟡 Haiku |
| 1 транспорт, 2 маппер, 3 сессия+медиа, 7 реестр/сервер/репо, 8 бэкенд-роут, 10 фронт | 🟢 Sonnet |
| 4–6 клиент (авторизация / входящие / отправка) | 🔵 Opus |
| 11 спайк и живая проверка, 12 выкат | 🟣 Fable + владелец (сканирует QR) |

## Контекст для исполнителя (прочитать целиком до первой задачи)

- Шлюз живёт в `gateway/` (отдельный `package.json`, тесты `node --test` из `gateway/`). Клиенты каналов: `gateway/lib/telegram-client.js` (TDLib), `gateway/lib/whatsapp-client.js` (Baileys) — у них ОДИН интерфейс: `start()`, `authStep(step)`, `status()`, `sendText({...})`, `sendFile({...})`, `logout()`, `close()`, поля `id`, `authState`, `closed`, статический `dirsFor(config, id)`. `gateway/lib/registry.js` выбирает класс по `account.channel`. `gateway/server.js` — Chatpush-совместимый HTTP-API (`/api/v1/delivery`, `/api/v1/send_file`, `/internal/accounts/:id/*`). Доставки — `gateway/lib/deliveries.js` (`g<n>`, статусы 1/2/5, `provider_message_id`). Контакты — `gateway/lib/accounts-repo.js` (`gateway_contacts`: `account_id, phone, user_id BIGINT`). Медиа — `gateway/lib/media.js` (`MAX_MEDIA_BYTES`, `EXT_BY_MIME`, `publicFileName`). Вебхук в бэкенд — `gateway/lib/webhook-sender.js` (`sendSafe`).
- Образец для стиля, инъекции зависимостей и тестов — `gateway/lib/whatsapp-client.js` и `gateway/test/whatsapp-client.test.js`: все внешние зависимости (сокет, БД, вебхук, конфиг, `now`, `sleep`) передаются через `deps` и подменяются в тестах; шапка файла объясняет ЗАЧЕМ.
- Бэкенд разбирает плоскую форму MAX в `backend/services/chatpush.js` (`envelope()` → `parseMessageEvent()`): `payload.{direction, chat_id, chat_type, sender_phone_number, recipient_phone_number, sender_name, delivery_id, customer_id, timestamp, message:{id, type, text, reply_to_message_id, file_data:{download_url, mime_type, caption}}}`. Телефон клиента: у `incoming` — `sender_phone_number`, у `outgoing` — `recipient_phone_number`; наш номер — на другой стороне. Группа — `chat_type:'group'` и отрицательный `chat_id`.
- Протокол MAX — таблица §2.1 спеки. Кадр `{ver:11, cmd, seq, opcode, payload}`; `cmd` 0 запрос/push, 1 ответ, 3 ошибка. Все опкоды — в `gateway/lib/max/protocol.js` (Task 0). Живой факт 13.10.2026: `HELLO` и `QR_START` с дев-бокса работают (QR-ссылка вида `https://max.ru/:auth/<trackId>`, TTL 120 с, опрос раз в 5 с).
- Коммиты — в ветку `feat/messenger-gateway`, с подписью `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Тесты шлюза: `cd /root/loyalpro/gateway && node --test`; бэкенд: `cd /root/loyalpro/backend && npx jest messaging-accounts-routes`; фронт: `cd /root/loyalpro/frontend/js/pages && node --test messaging-accounts.test.js`.

## Структура файлов

| Файл | Ответственность |
|---|---|
| `gateway/lib/max/protocol.js` (новый) | Константы: опкоды, версия кадра, URL, user-agent веб-клиента, `isTokenRevoked` |
| `gateway/lib/max/transport.js` (новый) | `MaxTransport`: WebSocket, кадры, корреляция `opcode:seq`, таймаут, PING, push/ack, `MaxServerError` |
| `gateway/lib/max/session.js` (новый) | Файл сессии `session.json` (deviceId, loginToken, ownerId, phone, displayName), атомарная запись |
| `gateway/lib/max/media.js` (новый) | HTTP медиа: скачивание по URL с капом, загрузка фото (multipart) и файла (raw + content-range) |
| `gateway/lib/max-mapper.js` (новый) | Чистые функции: XOR id, собеседник, группа, контент, тело вебхука `max_incoming_msg` |
| `gateway/lib/max-client.js` (новый) | `MaxClient`: авторизация (QR/номер), LOGIN, реконнект, push → вебхук, отправка, статусы доставок |
| `gateway/lib/registry.js`, `gateway/lib/accounts-repo.js`, `gateway/server.js`, `gateway/config.js`, `gateway/package.json` | Канал `max` в реестре и репозитории, `max_user_id` в API, env `MAX_*`, зависимость `ws` |
| `gateway/scripts/max-spike.js` (новый) | Живая проверка с тестовым номером: QR, сырые push-кадры, одна отправка |
| `backend/routes/messaging-accounts.js` | `GATEWAY_CHANNELS.max`, `POST /api/messaging/accounts/max` |
| `frontend/js/pages/messaging-accounts.js`, `frontend/index.html` | Кнопка «Подключить MAX напрямую», подписи QR-шага и резервный вход по номеру, бамп `?v=` |
| `CLAUDE.md` | Пункт про MAX в разделе «Свой шлюз мессенджеров» |
| Тесты | `gateway/test/max-transport.test.js`, `max-mapper.test.js`, `max-client.test.js`, правки `mapper-contract.test.js`, `registry.test.js`, `server.test.js`, `accounts-repo.test.js`; `backend/messaging-accounts-routes.test.js`; `frontend/js/pages/messaging-accounts.test.js` |

---

## Часть A. Подготовка

### Task 0: Зависимость `ws`, конфиг, константы протокола — 🟡 Haiku

**Files:**
- Modify: `gateway/package.json` (dependencies)
- Modify: `gateway/config.js`
- Create: `gateway/lib/max/protocol.js`
- Test: `gateway/test/max-protocol.test.js`

- [ ] **Step 1: Зафиксировать `ws` явно и завести env**

В `gateway/package.json` в `dependencies` добавить строку (алфавитный порядок, после `tdl`):

```json
    "ws": "^8.18.0"
```

Run: `cd /root/loyalpro/gateway && npm install --no-audit --no-fund 2>&1 | tail -2 && node -e "console.log(require('ws/package.json').version)"`
Expected: версия `8.x`, `package-lock.json` обновлён, `node_modules` без новых нативных модулей.

В `gateway/config.js` перед закрывающей `};` добавить:

```js
  // MAX (веб-протокол). appVersion веб-клиента — единственный «фингерпринт», который
  // сервер может объявить устаревшим; меняется env без правки кода.
  MAX_WS_URL: process.env.MAX_WS_URL || 'wss://ws-api.oneme.ru/websocket',
  MAX_WEB_APP_VERSION: process.env.MAX_WEB_APP_VERSION || '26.5.5',
  MAX_REQUEST_TIMEOUT_MS: parseInt(process.env.MAX_REQUEST_TIMEOUT_MS || '20000', 10),
```

- [ ] **Step 2: Написать падающий тест констант**

`gateway/test/max-protocol.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../lib/max/protocol');

test('опкоды веб-протокола MAX (сверены с max-account-api/PyMax)', () => {
  assert.equal(p.PROTOCOL_VERSION, 11);
  assert.deepEqual(p.CMD, { REQUEST: 0, RESPONSE: 1, ERROR: 3 });
  assert.equal(p.Op.HELLO, 6); assert.equal(p.Op.LOGIN, 19); assert.equal(p.Op.MSG_SEND, 64);
  assert.equal(p.Op.NOTIF_MESSAGE, 128); assert.equal(p.Op.QR_START, 288); assert.equal(p.Op.QR_LOGIN, 291);
  assert.equal(p.Op.AUTH_CHECK_PASSWORD, 115); assert.equal(p.Op.CONTACT_INFO_BY_PHONE, 46);
});

test('webUserAgent: WEB-профиль с переданной версией, дефолт 26.5.5', () => {
  const ua = p.webUserAgent('27.1.0');
  assert.equal(ua.deviceType, 'WEB'); assert.equal(ua.appVersion, '27.1.0'); assert.equal(ua.timezone, 'Europe/Moscow');
  assert.equal(p.webUserAgent().appVersion, '26.5.5');
  assert.match(p.HEADER_USER_AGENT, /Chrome/);
});

test('isTokenRevoked: FAIL_LOGIN_TOKEN / FAIL_LOGOUT_ALL в code или serverMessage', () => {
  assert.equal(p.isTokenRevoked({ code: 'FAIL_LOGIN_TOKEN' }), true);
  assert.equal(p.isTokenRevoked({ code: 'x', serverMessage: 'FAIL_LOGOUT_ALL' }), true);
  assert.equal(p.isTokenRevoked({ code: 'timeout' }), false);
  assert.equal(p.isTokenRevoked(null), false);
});
```

Run: `cd /root/loyalpro/gateway && node --test test/max-protocol.test.js`
Expected: FAIL — `Cannot find module '../lib/max/protocol'`.

- [ ] **Step 3: Написать модуль**

`gateway/lib/max/protocol.js`:

```js
'use strict';
// Константы веб-протокола MAX (то, чем говорит web.max.ru). Источники: типы
// max-account-api и payloads PyMax (оба MIT, реверс декомпилированного клиента),
// живая проверка HELLO/QR_START с дев-бокса 13.10.2026. Спека
// docs/superpowers/specs/2026-10-13-max-gateway-design.md, §2.1.
const PROTOCOL_VERSION = 11;
const CMD = { REQUEST: 0, RESPONSE: 1, ERROR: 3 };
const Op = {
  PING: 1, HELLO: 6, AUTH_REQUEST: 17, AUTH: 18, LOGIN: 19, LOGOUT: 20,
  CONTACT_INFO: 32, CONTACT_INFO_BY_PHONE: 46, CHAT_INFO: 48, MSG_SEND: 64,
  PHOTO_UPLOAD: 80, FILE_UPLOAD: 87, FILE_DOWNLOAD: 88, AUTH_CHECK_PASSWORD: 115,
  NOTIF_MESSAGE: 128, NOTIF_CHAT: 135, NOTIF_ATTACH: 136, NOTIF_PROFILE: 159,
  QR_START: 288, QR_POLL: 289, QR_LOGIN: 291,
};
const DEFAULT_WS_URL = 'wss://ws-api.oneme.ru/websocket';
const WEB_ORIGIN = 'https://web.max.ru';
const HEADER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const DEFAULT_APP_VERSION = '26.5.5';
// LOGIN отвечает этим, когда токен отозван (разлогин с телефона / «завершить все
// сеансы») — PyMax app._is_invalid_login_token_error.
const TOKEN_REVOKED = ['FAIL_LOGIN_TOKEN', 'FAIL_LOGOUT_ALL'];

// Профиль ПРОВЕРЕННЫЙ живьём 13.10.2026 (HELLO принят): менять только вместе с
// живой проверкой — сервер сверяет связку deviceType/appVersion.
function webUserAgent(appVersion) {
  return {
    deviceType: 'WEB', locale: 'ru', deviceLocale: 'ru', osVersion: 'macOS', deviceName: 'Chrome',
    headerUserAgent: HEADER_USER_AGENT, appVersion: appVersion || DEFAULT_APP_VERSION,
    screen: '720x1280 1.0x', timezone: 'Europe/Moscow',
  };
}

function isTokenRevoked(e) {
  if (!e) return false;
  return TOKEN_REVOKED.includes(String(e.code || '')) || TOKEN_REVOKED.includes(String(e.serverMessage || ''));
}

module.exports = { PROTOCOL_VERSION, CMD, Op, DEFAULT_WS_URL, WEB_ORIGIN, HEADER_USER_AGENT, DEFAULT_APP_VERSION, TOKEN_REVOKED, webUserAgent, isTokenRevoked };
```

- [ ] **Step 4: Прогнать тест**

Run: `cd /root/loyalpro/gateway && node --test test/max-protocol.test.js`
Expected: PASS (3 теста).

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add gateway/package.json gateway/package-lock.json gateway/config.js gateway/lib/max/protocol.js gateway/test/max-protocol.test.js && git commit -m "feat(gateway): MAX — константы веб-протокола, env MAX_*, явная зависимость ws

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Часть B. Шлюз

### Task 1: Транспорт `lib/max/transport.js` — 🟢 Sonnet

**Files:**
- Create: `gateway/lib/max/transport.js`
- Test: `gateway/test/max-transport.test.js`

- [ ] **Step 1: Написать падающие тесты**

`gateway/test/max-transport.test.js`:

```js
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
  reply(frame) { this.emit('message', Buffer.from(JSON.stringify({ ver: 11, ...frame }))); }
}
const mk = (o = {}) => new MaxTransport({ url: 'wss://x/websocket', WebSocket: FakeWs, pingIntervalMs: 0, requestTimeoutMs: 50, ...o });

test('connect: заголовки UA/Origin; request шлёт кадр ver 11 cmd 0 с растущим seq и резолвит payload ответа', async () => {
  const t = mk();
  await t.connect();
  assert.equal(FakeWs.last.opts.headers.Origin, 'https://web.max.ru');
  assert.match(FakeWs.last.opts.headers['User-Agent'], /Chrome/);
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
  await assert.rejects(p, (e) => e.code === 'transport_closed');
  assert.deepEqual(closes, [1006]);
  assert.equal(t.isOpen, false);
  await assert.rejects(t.request(1), (e) => e.code === 'transport_closed');
  const t2 = mk(); await t2.connect();
  t2.on('close', () => closes.push('own'));
  t2.close();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(closes, [1006]);
  assert.equal(FakeWs.last.closed, true);
});

test('PING раз в pingIntervalMs с interactive:false; битый кадр → error, не падение', async () => {
  const t = mk({ pingIntervalMs: 5 }); await t.connect();
  const errs = []; t.on('error', (e) => errs.push(e.message));
  await new Promise(r => setTimeout(r, 20));
  const ping = FakeWs.last.sent.find(f => f.opcode === 1);
  assert.deepEqual(ping.payload, { interactive: false });
  FakeWs.last.emit('message', Buffer.from('{not json'));
  assert.equal(errs.length, 1);
  t.close();
});

test('connect: ошибка до open → reject', async () => {
  class BadWs extends EventEmitter { constructor() { super(); setImmediate(() => this.emit('error', new Error('ECONNREFUSED'))); } send() {} close() {} }
  await assert.rejects(new MaxTransport({ url: 'wss://x', WebSocket: BadWs, pingIntervalMs: 0 }).connect(), /ECONNREFUSED/);
});
```

Run: `cd /root/loyalpro/gateway && node --test test/max-transport.test.js`
Expected: FAIL — `Cannot find module '../lib/max/transport'`.

- [ ] **Step 2: Написать транспорт**

`gateway/lib/max/transport.js`:

```js
'use strict';
// ============================================================
// MaxTransport — WebSocket веб-протокола MAX: JSON-кадры {ver, cmd, seq, opcode, payload}.
// cmd 0 — наш запрос (и push сервера), 1 — ответ, 3 — ошибка (payload.error/message).
// Ответ сопоставляется запросу по паре opcode:seq; push (cmd 0 от сервера)
// отдаётся событием 'push', квитируется ack() — cmd 1 с тем же opcode/seq.
// Реконнектом транспорт НЕ занимается: после переподключения нужны новый HELLO и
// LOGIN, это знает клиент. PING (op 1) раз в pingIntervalMs с interactive:false —
// ДОПУЩЕНИЕ спеки §3.1: так веб-клиент обозначает неактивную вкладку.
// Класс WebSocket инжектится (тесты без сети).
// ============================================================
const { EventEmitter } = require('events');
const { PROTOCOL_VERSION, CMD, Op, DEFAULT_WS_URL, WEB_ORIGIN, HEADER_USER_AGENT } = require('./protocol');

class MaxServerError extends Error {
  constructor(opcode, payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const code = p.error ? String(p.error) : 'unknown';
    super(`MAX op ${opcode}: ${code}${p.message ? ' — ' + p.message : ''}`);
    this.name = 'MaxServerError';
    this.opcode = opcode;
    this.code = code;
    this.serverMessage = p.message ? String(p.message) : null;
    this.payload = p;
  }
}

function closedError(opcode) {
  return Object.assign(new Error('соединение с MAX закрыто'), { code: 'transport_closed', opcode });
}

class MaxTransport extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.url = opts.url || DEFAULT_WS_URL;
    this.headers = opts.headers || { 'User-Agent': HEADER_USER_AGENT, Origin: WEB_ORIGIN };
    this.requestTimeoutMs = opts.requestTimeoutMs || 20000;
    this.pingIntervalMs = opts.pingIntervalMs === undefined ? 30000 : opts.pingIntervalMs;
    this.pingInteractive = !!opts.pingInteractive;
    this.WebSocket = opts.WebSocket || require('ws');
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();      // 'opcode:seq' → {resolve, reject, timer, opcode}
    this.pingTimer = null;
    this.isOpen = false;
    this.closedByUs = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocket(this.url, { headers: this.headers });
      this.ws = ws;
      const onOpen = () => { ws.off('error', onErr); this.isOpen = true; this.startPing(); this.emit('open'); resolve(); };
      const onErr = (e) => { ws.off('open', onOpen); reject(e); };
      ws.once('open', onOpen);
      ws.once('error', onErr);
      ws.on('message', (data) => this.onMessage(data));
      ws.on('close', (code, reason) => this.onClose(code, reason));
      ws.on('error', (e) => { if (this.isOpen) this.emit('error', e); });
    });
  }

  request(opcode, payload) {
    if (!this.ws || !this.isOpen) return Promise.reject(closedError(opcode));
    const seq = this.seq++;
    const frame = { ver: PROTOCOL_VERSION, cmd: CMD.REQUEST, seq, opcode };
    if (payload !== undefined) frame.payload = payload;   // GET_QR идёт без payload — как web.max.ru
    return new Promise((resolve, reject) => {
      const key = `${opcode}:${seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(Object.assign(new Error(`MAX op ${opcode}: нет ответа ${this.requestTimeoutMs} мс`), { code: 'timeout', opcode }));
      }, this.requestTimeoutMs);
      this.pending.set(key, { resolve, reject, timer, opcode });
      this.ws.send(JSON.stringify(frame), (err) => {
        if (err) { clearTimeout(timer); this.pending.delete(key); reject(err); }
      });
    });
  }

  ack(frame, payload) {
    const f = { cmd: CMD.RESPONSE, seq: frame.seq, opcode: frame.opcode };
    if (payload !== undefined) f.payload = payload;
    this.sendRaw(f);
  }

  sendRaw(frame) {
    if (!this.ws || !this.isOpen) return;
    try { this.ws.send(JSON.stringify({ ver: PROTOCOL_VERSION, ...frame }), () => {}); }
    catch (e) { this.emit('error', e); }
  }

  onMessage(data) {
    let frame;
    try { frame = JSON.parse(String(data)); }
    catch (e) { this.emit('error', new Error(`битый кадр MAX: ${e.message}`)); return; }
    if (!frame || typeof frame !== 'object') return;
    this.emit('raw', frame);
    if (frame.cmd === CMD.RESPONSE || frame.cmd === CMD.ERROR) {
      const key = `${frame.opcode}:${frame.seq}`;
      const p = this.pending.get(key);
      if (!p) return;                              // ответ после таймаута
      clearTimeout(p.timer);
      this.pending.delete(key);
      if (frame.cmd === CMD.ERROR) p.reject(new MaxServerError(frame.opcode, frame.payload));
      else p.resolve(frame.payload);
      return;
    }
    this.emit('push', frame);
  }

  rejectPending() {
    for (const [key, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(closedError(p.opcode));
      this.pending.delete(key);
    }
  }

  onClose(code, reason) {
    const wasOpen = this.isOpen;
    this.isOpen = false;
    this.stopPing();
    this.rejectPending();
    if (this.closedByUs || !wasOpen) return;
    this.emit('close', code, String(reason || ''));
  }

  close() {
    this.closedByUs = true;
    this.stopPing();
    this.isOpen = false;
    this.rejectPending();
    const ws = this.ws;
    this.ws = null;
    try { if (ws) ws.close(); } catch (_) { /* уже закрыт */ }
  }

  startPing() {
    this.stopPing();
    if (!this.pingIntervalMs) return;
    this.pingTimer = setInterval(() => {
      this.request(Op.PING, { interactive: this.pingInteractive }).catch(e => this.emit('error', e));
    }, this.pingIntervalMs);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  stopPing() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }
}

module.exports = { MaxTransport, MaxServerError };
```

- [ ] **Step 3: Прогнать тесты**

Run: `cd /root/loyalpro/gateway && node --test test/max-transport.test.js`
Expected: PASS (7 тестов).

- [ ] **Step 4: Коммит**

```bash
cd /root/loyalpro && git add gateway/lib/max/transport.js gateway/test/max-transport.test.js && git commit -m "feat(gateway): MAX — транспорт веб-протокола (JSON поверх WebSocket, корреляция, PING, push/ack)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Чистый маппер `lib/max-mapper.js` — 🟢 Sonnet

**Files:**
- Create: `gateway/lib/max-mapper.js`
- Test: `gateway/test/max-mapper.test.js`
- Modify: `gateway/test/mapper-contract.test.js` (добавить контракт для MAX)

- [ ] **Step 1: Написать падающие тесты**

`gateway/test/max-mapper.test.js`:

```js
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
```

Добавить в `gateway/test/mapper-contract.test.js` (в конец файла):

```js
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
```

Run: `cd /root/loyalpro/gateway && node --test test/max-mapper.test.js test/mapper-contract.test.js`
Expected: FAIL — `Cannot find module '../lib/max-mapper'`.

- [ ] **Step 2: Написать маппер**

`gateway/lib/max-mapper.js`:

```js
'use strict';
// ============================================================
// max-mapper — чистые функции без сети/БД: сообщение веб-протокола MAX → тело
// вебхука в ПЛОСКОЙ форме max_incoming_msg Chatpush (её разбирает
// backend/services/chatpush.js envelope(): телефон клиента у incoming —
// sender_phone_number, у outgoing — recipient_phone_number; группа — chat_type
// 'group' и отрицательный chat_id). chat_id личного диалога = id СОБЕСЕДНИКА — так
// делал Chatpush, и диалоги без номера в нашей БД ключуются именно им.
// id личного диалога в MAX = XOR id двух участников (PyMax UserService.get_chat_id);
// XOR через BigInt — побитовые операции Number режут id до 32 бит.
// Типы сообщений как у Chatpush для MAX: text | image | document | audio | video |
// sticker | contact (бэкенд: isMedia = тип без 'text').
// ============================================================
const path = require('path');
const { normalizePhone } = require('./mapper');
const { EXT_BY_MIME } = require('./media');

const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime]));
MIME_BY_EXT['.jpeg'] = 'image/jpeg';

function xorId(a, b) { return Number(BigInt(a) ^ BigInt(b)); }

// Собеседник личного диалога: второй участник снимка чата, иначе XOR.
function peerIdOf({ chatId, chat, ownerId }) {
  const me = Number(ownerId);
  const parts = chat && chat.participants && typeof chat.participants === 'object'
    ? Object.keys(chat.participants).map(Number).filter(n => Number.isFinite(n) && n !== me)
    : [];
  if (parts.length === 1) return parts[0];
  return xorId(chatId, me);
}

function isGroupChat({ chatId, chat }) {
  if (chat && chat.type) return chat.type !== 'DIALOG';
  return Number(chatId) < 0;
}
function isChannel(chat) { return !!(chat && chat.type === 'CHANNEL'); }

function mimeOfName(name) { return MIME_BY_EXT[path.extname(String(name || '')).toLowerCase()] || 'application/octet-stream'; }

// → {type, text, media:{kind, url, fileId, fileName, mimeType, size}|null} | null (не форвардим).
function contentOf(message) {
  const m = message && typeof message === 'object' ? message : null;
  if (!m) return null;
  if (m.type && m.type !== 'USER') return null;      // SYSTEM/CONTROL — служебное
  if (m.status) return null;                         // EDITED/REMOVED — ре-броадкаст, не новое сообщение
  const text = typeof m.text === 'string' ? m.text : '';
  const attaches = Array.isArray(m.attaches) ? m.attaches.filter(a => a && typeof a === 'object') : [];
  const kinds = attaches.map(a => String(a._type || '').toUpperCase());
  if (kinds.includes('CONTROL') || kinds.includes('CALL')) return null;
  const pick = (k) => attaches[kinds.indexOf(k)];
  const media = (kind, extra) => ({ kind, url: null, fileId: null, fileName: null, mimeType: 'application/octet-stream', size: 0, ...extra });
  if (kinds.includes('PHOTO')) {
    const a = pick('PHOTO');
    return { type: 'image', text, media: media('PHOTO', { url: a.baseUrl || null, mimeType: 'image/jpeg' }) };
  }
  if (kinds.includes('FILE')) {
    const a = pick('FILE');
    return { type: 'document', text, media: media('FILE', { fileId: a.fileId != null ? a.fileId : null, fileName: a.name || null, mimeType: mimeOfName(a.name), size: Number(a.size) || 0 }) };
  }
  if (kinds.includes('AUDIO')) {
    const a = pick('AUDIO');
    return { type: 'audio', text, media: a.url ? media('AUDIO', { url: a.url, mimeType: 'audio/ogg' }) : null };
  }
  if (kinds.includes('VIDEO')) return { type: 'video', text, media: null };
  if (kinds.includes('STICKER')) return { type: 'sticker', text, media: null };
  if (kinds.includes('CONTACT')) return { type: 'contact', text, media: null };
  if (!text.trim()) return null;                      // SHARE/пусто без текста — нечего показывать
  return { type: 'text', text, media: null };
}

// message.time — миллисекунды (у Chatpush timestamp был в секундах).
function tsSeconds(time) {
  const n = Number(time);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n > 1e12 ? n / 1000 : n);
}

function replyIdOf(message) {
  const link = message && message.link;
  if (!link || link.type !== 'REPLY') return null;
  const id = (link.message && link.message.id) || link.messageId;
  return id != null && id !== '' ? String(id) : null;
}

/**
 * Тело вебхука. peer — собеседник личного диалога ИЛИ отправитель в группе
 * ({id, phone, name}); для исходящего в группу — null. content — уже разобранный
 * contentOf (если медиа скачано, mimeType там фактический), иначе разбирается здесь.
 */
function buildWebhookBody({ accountId, ownPhone, ownerId, chatId, chat, message, peer, deliveryId, fileUrl, content: given }) {
  const content = given || contentOf(message) || { type: 'unsupported', text: '', media: null };
  const group = isGroupChat({ chatId, chat });
  const outgoing = Number(message.sender) === Number(ownerId);
  const p = peer && typeof peer === 'object' ? peer : {};
  const peerPhone = p.phone ? normalizePhone(String(p.phone)) : null;
  const peerName = p.name ? String(p.name) : null;
  const msg = { id: String(message.id), type: content.type, text: content.text, timestamp: tsSeconds(message.time), reply_to_message_id: replyIdOf(message) };
  if (content.media && fileUrl) msg.file_data = { download_url: fileUrl, mime_type: content.media.mimeType, file_name: content.media.fileName, caption: content.text };
  const chatIdOut = group ? String(chatId) : String(p.id != null ? p.id : xorId(chatId, ownerId));
  const chatName = group ? ((chat && chat.title) || null) : peerName;
  return {
    type: 'max_incoming_msg',
    payload: {
      provider: 'gateway',
      customer_id: accountId,
      instance_id: accountId,
      direction: outgoing ? 'outgoing' : 'incoming',
      chat_id: chatIdOut,
      chat_type: group ? 'group' : 'person',
      chat_name: chatName,
      sender_id: outgoing ? String(ownerId) : String(message.sender),
      sender_name: outgoing ? null : peerName,
      sender_phone_number: outgoing ? (ownPhone || null) : peerPhone,
      recipient_id: outgoing ? chatIdOut : String(ownerId),
      recipient_name: outgoing ? chatName : null,
      recipient_phone_number: outgoing ? (group ? null : peerPhone) : (ownPhone || null),
      delivery_id: deliveryId || null,
      timestamp: msg.timestamp,
      message: msg,
    },
  };
}

module.exports = { xorId, peerIdOf, isGroupChat, isChannel, mimeOfName, contentOf, tsSeconds, replyIdOf, buildWebhookBody, MIME_BY_EXT };
```

- [ ] **Step 3: Прогнать тесты**

Run: `cd /root/loyalpro/gateway && node --test test/max-mapper.test.js test/mapper-contract.test.js`
Expected: PASS (10 + 6 тестов).

- [ ] **Step 4: Коммит**

```bash
cd /root/loyalpro && git add gateway/lib/max-mapper.js gateway/test/max-mapper.test.js gateway/test/mapper-contract.test.js && git commit -m "feat(gateway): MAX — чистый маппер сообщений в плоскую форму max_incoming_msg + контракт с парсером бэкенда

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Сессия и HTTP-медиа `lib/max/session.js`, `lib/max/media.js` — 🟢 Sonnet

**Files:**
- Create: `gateway/lib/max/session.js`, `gateway/lib/max/media.js`
- Test: `gateway/test/max-session.test.js`, `gateway/test/max-media.test.js`

- [ ] **Step 1: Написать падающие тесты**

`gateway/test/max-session.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const s = require('../lib/max/session');

test('load: нет файла → свежий deviceId (uuid), save атомарно, повторный load отдаёт то же', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-max-s-')) + '/max';
  const fresh = s.load(dir);
  assert.match(fresh.deviceId, /^[0-9a-f-]{36}$/);
  assert.equal(fresh.loginToken, undefined);
  s.save(dir, { ...fresh, loginToken: 'T', ownerId: 10001, phone: '79200255591', displayName: 'Тест' });
  assert.deepEqual(fs.readdirSync(dir), ['session.json']);       // tmp-файла не осталось
  assert.deepEqual(s.load(dir), { deviceId: fresh.deviceId, loginToken: 'T', ownerId: 10001, phone: '79200255591', displayName: 'Тест' });
  assert.equal(s.hasToken(dir), true);
  s.remove(dir);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(s.hasToken(dir), false);
});

test('load: битый JSON или без deviceId → свежая сессия', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-max-s-'));
  fs.writeFileSync(path.join(dir, 'session.json'), '{bad');
  assert.match(s.load(dir).deviceId, /^[0-9a-f-]{36}$/);
  fs.writeFileSync(path.join(dir, 'session.json'), '{"loginToken":"T"}');
  assert.equal(s.load(dir).loginToken, undefined);
});
```

`gateway/test/max-media.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const media = require('../lib/max/media');

test('download: GET с Origin/UA, кап по maxContentLength, MIME из заголовка; не-200 и пустое тело → ошибка', async () => {
  const calls = [];
  const http = async (o) => { calls.push(o); return { status: 200, data: Buffer.from('WEBP'), headers: { 'content-type': 'image/webp; charset=binary' } }; };
  const r = await media.download('https://i/1', { http, maxBytes: 100, timeoutMs: 5 });
  assert.equal(r.buf.toString(), 'WEBP'); assert.equal(r.mimeType, 'image/webp');
  assert.equal(calls[0].method, 'get'); assert.equal(calls[0].maxContentLength, 100); assert.equal(calls[0].timeout, 5);
  assert.equal(calls[0].headers.Origin, 'https://web.max.ru'); assert.equal(calls[0].responseType, 'arraybuffer');
  await assert.rejects(media.download('u', { http: async () => ({ status: 404, data: Buffer.alloc(0), headers: {} }), maxBytes: 100, timeoutMs: 5 }), /HTTP 404/);
  await assert.rejects(media.download('u', { http: async () => ({ status: 200, data: Buffer.alloc(0), headers: {} }), maxBytes: 100, timeoutMs: 5 }), /пустой/);
  await assert.rejects(media.download('u', { http: async () => ({ status: 200, data: Buffer.alloc(101), headers: {} }), maxBytes: 100, timeoutMs: 5 }), /больше лимита/);
});

test('uploadPhoto: multipart поле file → токен первого фото; без токена → ошибка', async () => {
  const calls = [];
  const http = async (o) => { calls.push(o); return { status: 200, data: { photos: { 123: { token: 'PT' } } } }; };
  assert.equal(await media.uploadPhoto('https://iu/upload', Buffer.from('JPG'), 'a.jpg', 'image/jpeg', { http }), 'PT');
  assert.equal(calls[0].method, 'post'); assert.ok(calls[0].data instanceof FormData);
  const file = calls[0].data.get('file'); assert.equal(file.name, 'a.jpg'); assert.equal(file.type, 'image/jpeg');
  await assert.rejects(media.uploadPhoto('u', Buffer.from('x'), 'a.jpg', 'image/jpeg', { http: async () => ({ status: 200, data: { photos: {} } }) }), /нет токена/);
  await assert.rejects(media.uploadPhoto('u', Buffer.from('x'), 'a.jpg', 'image/jpeg', { http: async () => ({ status: 500, data: '' }) }), /HTTP 500/);
});

test('uploadFile: сырые байты, content-disposition (кириллица percent-encoded), content-range 0-(n-1)/n', async () => {
  const calls = [];
  const http = async (o) => { calls.push(o); return { status: 200, data: '' }; };
  await media.uploadFile('https://fu/upload', Buffer.from('12345'), 'Прайс.pdf', { http });
  const h = calls[0].headers;
  assert.equal(h['content-range'], '0-4/5');
  assert.equal(h['content-disposition'], 'attachment; filename=' + encodeURIComponent('Прайс.pdf'));
  assert.equal(h['content-type'], 'application/octet-stream');
  assert.equal(media.contentDisposition('a.pdf'), 'attachment; filename=a.pdf');
  await assert.rejects(media.uploadFile('u', Buffer.from('x'), 'a', { http: async () => ({ status: 413, data: '' }) }), /HTTP 413/);
});
```

Run: `cd /root/loyalpro/gateway && node --test test/max-session.test.js test/max-media.test.js`
Expected: FAIL — модулей нет.

- [ ] **Step 2: Написать модули**

`gateway/lib/max/session.js`:

```js
'use strict';
// Сессия веб-клиента MAX — один JSON в data/acc-<id>/max/session.json:
// {deviceId, loginToken, ownerId, phone, displayName}. deviceId создаётся один
// раз и живёт с токеном (токен привязан к нему — PyMax/max-account-api).
// Запись атомарная (tmp + rename): шлюз может упасть посреди записи при рестарте.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'session.json';

function load(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    if (j && typeof j === 'object' && typeof j.deviceId === 'string' && j.deviceId) return j;
  } catch (_) { /* нет файла или битый — свежая сессия */ }
  return { deviceId: crypto.randomUUID() };
}

function save(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${FILE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, path.join(dir, FILE));
}

function remove(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

function hasToken(dir) { return !!load(dir).loginToken; }

module.exports = { load, save, remove, hasToken, FILE };
```

`gateway/lib/max/media.js`:

```js
'use strict';
// HTTP-часть медиа MAX (сами URL выдают опкоды 80/87/88 по WebSocket):
//  • скачивание по подписанному URL (фото baseUrl, файл — url из FILE_DOWNLOAD);
//  • фото — multipart POST поле `file` на iu.oneme.ru/uploadImage → {photos:{id:{token}}};
//  • файл — сырые байты POST на fu.oneme.ru с content-disposition и content-range
//    (формат с проверенного трафика max-account-api media.ts; кириллица в имени —
//    percent-encoded, сервер декодирует).
// http — axios-подобная функция (инжектится в тестах).
const { WEB_ORIGIN, HEADER_USER_AGENT } = require('./protocol');

const BASE_HEADERS = { Origin: WEB_ORIGIN, Referer: WEB_ORIGIN + '/', 'User-Agent': HEADER_USER_AGENT };

async function download(url, { http, maxBytes, timeoutMs }) {
  const res = await http({ method: 'get', url, responseType: 'arraybuffer', timeout: timeoutMs, maxContentLength: maxBytes, maxBodyLength: maxBytes, headers: BASE_HEADERS, validateStatus: null });
  if (res.status !== 200) throw new Error(`скачивание: HTTP ${res.status}`);
  const buf = Buffer.from(res.data || '');
  if (!buf.length) throw new Error('пустой файл');
  if (buf.length > maxBytes) throw new Error(`файл ${buf.length} байт больше лимита ${maxBytes}`);
  const ct = res.headers && (res.headers['content-type'] || res.headers['Content-Type']);
  const mimeType = String(ct || '').split(';')[0].trim() || null;
  return { buf, mimeType };
}

async function uploadPhoto(url, buf, fileName, mimeType, { http }) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mimeType || 'application/octet-stream' }), fileName || 'photo.jpg');
  const res = await http({ method: 'post', url, data: form, headers: BASE_HEADERS, timeout: 60000, maxBodyLength: Infinity, validateStatus: null });
  if (res.status !== 200) throw new Error(`загрузка фото: HTTP ${res.status}`);
  const photos = (res.data && res.data.photos) || {};
  const first = Object.values(photos)[0];
  if (!first || !first.token) throw new Error('загрузка фото: в ответе нет токена');
  return String(first.token);
}

function contentDisposition(fileName) {
  const n = String(fileName || 'file');
  const ascii = /^[\x20-\x7e]*$/.test(n);
  return `attachment; filename=${ascii ? n : encodeURIComponent(n)}`;
}

async function uploadFile(url, buf, fileName, { http }) {
  const res = await http({
    method: 'post', url, data: buf, timeout: 120000, maxBodyLength: Infinity, validateStatus: null,
    headers: { ...BASE_HEADERS, 'content-disposition': contentDisposition(fileName), 'content-range': `0-${buf.length - 1}/${buf.length}`, 'content-type': 'application/octet-stream' },
  });
  if (res.status !== 200) throw new Error(`загрузка файла: HTTP ${res.status}`);
}

module.exports = { download, uploadPhoto, uploadFile, contentDisposition, BASE_HEADERS };
```

- [ ] **Step 3: Прогнать тесты**

Run: `cd /root/loyalpro/gateway && node --test test/max-session.test.js test/max-media.test.js`
Expected: PASS (2 + 3 теста).

- [ ] **Step 4: Коммит**

```bash
cd /root/loyalpro && git add gateway/lib/max/session.js gateway/lib/max/media.js gateway/test/max-session.test.js gateway/test/max-media.test.js && git commit -m "feat(gateway): MAX — файл сессии и HTTP-медиа (скачивание, загрузка фото/файла)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Клиент `lib/max-client.js` — жизненный цикл и авторизация — 🔵 Opus

**Files:**
- Create: `gateway/lib/max-client.js`
- Test: `gateway/test/max-client.test.js`

Клиент пишется в три задачи над ОДНИМ файлом: Task 4 — каркас, сессия, HELLO/QR/номер/LOGIN, реконнект, разлогин; Task 5 — входящие (`onMessage`, `emitMessage`, `resolveContact`, `downloadToPublic`); Task 6 — отправка. В Task 4 `onPush` уже делегирует push 128 в `this.onMessage` — метод появится в Task 5, тесты Task 4 сообщений не шлют.

- [ ] **Step 1: Написать падающие тесты каркаса и авторизации**

`gateway/test/max-client.test.js`:

```js
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
```

Run: `cd /root/loyalpro/gateway && node --test test/max-client.test.js`
Expected: FAIL — `Cannot find module '../lib/max-client'`.

- [ ] **Step 2: Написать каркас клиента**

`gateway/lib/max-client.js`:

```js
'use strict';
// ============================================================
// MaxClient — одна веб-сессия MAX (как вкладка web.max.ru) = один аккаунт
// (строка messenger_accounts, channel='max'). Интерфейс тот же, что у
// TelegramClient и WhatsappClient (server.js и registry.js зовут их одинаково).
// Протокол — lib/max/transport.js + lib/max/protocol.js; референсы max-account-api
// (типы) и PyMax (payloads); спека docs/superpowers/specs/2026-10-13-max-gateway-design.md.
// Авторизация: QR (QR_START → опрос QR_POLL → QR_LOGIN [→ 115 пароль 2FA] → LOGIN) —
// основной путь, QR живёт 120 с, раунды до MAX_QR_ROUNDS; номер + SMS
// (AUTH_REQUEST → AUTH [→ 115] → LOGIN) — по PyMax на веб-транспорте, живьём не
// проверен (спека §3.2). Сессия — data/acc-<id>/max/session.json (deviceId +
// loginToken), переживает рестарт: HELLO + LOGIN по токену.
// LOGIN отверг токен (FAIL_LOGIN_TOKEN/FAIL_LOGOUT_ALL — разлогин с телефона) —
// logged_out без реконнекта, сессия удалена. Любой другой обрыв — реконнект
// 2 с → 60 с: новый транспорт, HELLO, LOGIN; в wait_qr — новый QR-раунд (trackId
// привязан к соединению). Пока соединения нет, отправка — 422 ДО создания доставки.
// Входящие — push NOTIF_MESSAGE (квитируем), своё сообщение с телефона
// (sender === ownerId) — эхо без delivery_id → бэкенд ставит паузу «ответил
// оператор», как в Telegram. Эхо СВОЕЙ отправки синтезируем из ответа MSG_SEND;
// push с тем же id пропускаем (ownSends). Собеседник личного диалога — второй
// участник снимка чата, иначе chatId XOR ownerId (PyMax); расхождение логируем раз.
// Зависимости инжектятся (deps) — тесты без сети и БД.
// ============================================================
const fs = require('fs');
const path = require('path');
const mapper = require('./max-mapper');
const { normalizePhone } = require('./mapper');
const { MAX_MEDIA_BYTES, publicFileName } = require('./media');
const { Op, webUserAgent, isTokenRevoked, DEFAULT_WS_URL } = require('./max/protocol');
const { createLogger } = require('../logger');

const MAX_MESSAGE_AGE_S = 6 * 60 * 60;
const RECONNECT_MS = [2000, 5000, 10000, 30000, 60000];
const MAX_QR_ROUNDS = 5;
const QR_ABANDONED_ERROR = 'QR не отсканирован — подключение остановлено, запустите заново';
const QR_POLL_MIN_MS = 2000;
const OWN_SEND_TTL_MS = 30 * 60 * 1000;
const FILE_READY_TIMEOUT_MS = 60 * 1000;
const ATTACH_RETRY_MS = 2000;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 90 * 1000;
const LOGIN_CHATS_COUNT = 200;
const CONTACTS_CACHE_MAX = 20000;

function defaultDeps() {
  return {
    Transport: require('./max/transport').MaxTransport,
    session: require('./max/session'),
    media: require('./max/media'),
    http: (opts) => require('axios')(opts),
    qrToDataUrl: (s) => require('qrcode').toDataURL(s, { margin: 1, width: 320 }),
    repo: require('./accounts-repo'),
    deliveries: require('./deliveries'),
    webhook: require('./webhook-sender'),
    config: require('../config'),
    now: () => Date.now(),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  };
}

function httpError(message, status) { return Object.assign(new Error(message), { status }); }

class MaxClient {
  constructor(account, deps = {}) {
    this.d = { ...defaultDeps(), ...deps };
    this.account = account;
    this.id = account.id;
    this.log = createLogger(`MAX#${account.id}`);
    this.authState = 'starting';
    this.lastAuthError = null;
    this.ownerId = null;
    this.ownPhone = normalizePhone(account.phone);
    this.displayName = null;
    this.qr = null;
    this.codeLength = null;
    this.passwordHint = null;
    this.transport = null;
    this.connected = false;
    this.closed = false;
    this.reconnects = 0;
    this.reconnecting = false;
    this.sess = null;
    this.qrRounds = 0;
    this.qrTrack = null;             // {trackId, expiresAt, pollMs} текущего QR-раунда
    this.sms = null;                 // {token, phone} после AUTH_REQUEST
    this.passwordTrackId = null;     // trackId вызова пароля 2FA
    this.chats = new Map();          // chatId → снимок чата (type, title, participants)
    this.contacts = new Map();       // userId → {id, phone, name}
    this.ownSends = new Map();       // message.id → {deliveryId, ts}
    this.chatQueues = new Map();
    this.fileWaiters = new Map();    // fileId → resolve() ожидания NOTIF_ATTACH
    this.cidPrev = 0;
    this.diag = { xor: 0, hello: 0 };
  }

  static dirsFor(config, id) {
    const base = path.join(config.DATA_DIR, `acc-${id}`);
    return { max: path.join(base, 'max'), base };
  }
  dirs() { return MaxClient.dirsFor(this.d.config, this.id); }

  async start() {
    fs.mkdirSync(this.dirs().max, { recursive: true });
    await this.d.repo.setAuth(this.id, 'starting');
    this.sess = this.d.session.load(this.dirs().max);
    await this.connect();
    this.log.info('клиент запущен');
  }

  // ── Соединение ───────────────────────────────────────────────
  async connect() {
    if (this.closed) return;
    const t = new this.d.Transport({ url: this.d.config.MAX_WS_URL || DEFAULT_WS_URL, requestTimeoutMs: this.d.config.MAX_REQUEST_TIMEOUT_MS });
    const old = this.transport;
    this.transport = t;
    if (old) { old.removeAllListeners(); try { old.close(); } catch (_) { /* уже закрыт */ } }
    t.on('push', (f) => { if (this.transport === t) this.onPush(f).catch(e => this.log.error(`push op ${f && f.opcode}: ${e.message}`)); });
    t.on('close', (code, reason) => { if (this.transport === t) this.onClose(code, reason).catch(e => this.log.error(`close: ${e.message}`)); });
    t.on('error', (e) => this.log.warn(`транспорт: ${e.message}`));
    await t.connect();
    if (this.closed) { t.close(); return; }
    await this.hello(t);
    if (this.sess.loginToken) await this.login();
    else await this.beginQr();
  }

  async hello(t) {
    const r = await t.request(Op.HELLO, { userAgent: webUserAgent(this.d.config.MAX_WEB_APP_VERSION), deviceId: this.sess.deviceId });
    const h = r || {};
    if (this.diag.hello++ === 0) this.log.info(`HELLO: location=${h.location} phone-auth=${h['phone-auth-enabled']}`);
    if (h['app-update-type']) this.log.warn(`MAX просит обновить клиент (app-update-type=${h['app-update-type']}) — проверьте MAX_WEB_APP_VERSION`);
    return h;
  }

  async onClose(code, reason) {
    this.connected = false;
    if (this.closed) return;
    this.log.warn(`соединение закрыто (code=${code || '?'}${reason ? ' ' + reason : ''})`);
    this.qr = null; this.qrTrack = null;          // trackId живёт в рамках соединения
    await this.reconnect();
  }

  // Бэкофф 2 с → 60 с; один цикл на клиент (close во время connect не плодит второй).
  async reconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      while (!this.closed) {
        const wait = RECONNECT_MS[Math.min(this.reconnects++, RECONNECT_MS.length - 1)];
        await this.d.sleep(wait);
        if (this.closed) return;
        try { await this.connect(); return; }
        catch (e) { this.log.error(`реконнект не удался: ${e.message}`); }
      }
    } finally { this.reconnecting = false; }
  }

  // ── Состояние ────────────────────────────────────────────────
  async setState(state, { error = null, phone, displayName } = {}) {
    this.authState = state;
    this.lastAuthError = error;
    await this.d.repo.setAuth(this.id, state, { error, phone, displayName });
  }

  // stop:true — терминальная ошибка (клиент закрыт, новый «Подключить» пересоздаст);
  // stop:false — ошибка шага, состояние не меняется.
  async fail(message, { stop }) {
    this.log.error(message);
    if (stop) {
      this.closed = true; this.qr = null; this.qrTrack = null;
      if (this.transport) { try { this.transport.close(); } catch (_) { /* уже закрыт */ } }
      await this.setState('error', { error: message });
    } else {
      this.lastAuthError = message;
      await this.d.repo.setAuth(this.id, this.authState, { error: message });
    }
  }

  saveSession() {
    try { this.d.session.save(this.dirs().max, this.sess); }
    catch (e) { this.log.error(`сессия не сохранена: ${e.message}`); }
  }

  // ── QR ───────────────────────────────────────────────────────
  async beginQr() {
    if (this.closed || !this.transport) return;
    if (++this.qrRounds > MAX_QR_ROUNDS) { await this.fail(QR_ABANDONED_ERROR, { stop: true }); return; }
    let r;
    try { r = await this.transport.request(Op.QR_START); }
    catch (e) { this.log.warn(`QR_START: ${e.message}`); return; }     // обрыв → onClose → реконнект → новый раунд
    if (!r || !r.trackId || !r.qrLink) { await this.fail('QR_START: ответ без trackId/qrLink', { stop: false }); return; }
    const track = {
      trackId: r.trackId,
      expiresAt: Number(r.expiresAt) || (this.d.now() + (Number(r.ttl) || 120000)),
      pollMs: Math.max(QR_POLL_MIN_MS, Number(r.pollingInterval) || 5000),
    };
    this.qrTrack = track;
    this.qr = await this.d.qrToDataUrl(r.qrLink).catch(e => { this.log.warn(`qr: ${e.message}`); return null; });
    await this.setState('wait_qr', { error: null });
    this.log.info(`QR-раунд ${this.qrRounds}/${MAX_QR_ROUNDS}: ждём сканирования`);
    this.pollQr(track).catch(e => this.log.error(`опрос QR: ${e.message}`));
  }

  async pollQr(track) {
    while (!this.closed && this.qrTrack === track && this.authState === 'wait_qr') {
      await this.d.sleep(track.pollMs);
      if (this.closed || this.qrTrack !== track || this.authState !== 'wait_qr' || !this.transport) return;
      if (this.d.now() >= track.expiresAt) {
        this.qrTrack = null; this.qr = null;
        await this.beginQr();
        return;
      }
      let p;
      try { p = await this.transport.request(Op.QR_POLL, { trackId: track.trackId }); }
      catch (e) { this.log.warn(`QR_POLL: ${e.message}`); continue; }
      if (p && p.status && p.status.loginAvailable) {
        if (this.qrTrack !== track) return;
        this.qrTrack = null;
        try {
          const res = await this.transport.request(Op.QR_LOGIN, { trackId: track.trackId });
          await this.handleTokenResponse(res);
        } catch (e) {
          await this.fail(`вход по QR: ${e.message}`, { stop: false });
          await this.beginQr();
        }
        return;
      }
    }
  }

  // Ответ QR_LOGIN / AUTH / 115: токен → LOGIN; passwordChallenge → wait_password.
  async handleTokenResponse(res) {
    const token = res && res.tokenAttrs && res.tokenAttrs.LOGIN && res.tokenAttrs.LOGIN.token;
    if (token) {
      this.sess.loginToken = String(token);
      this.saveSession();
      this.sms = null; this.passwordTrackId = null; this.passwordHint = null; this.qr = null; this.qrTrack = null;
      await this.login();
      return;
    }
    const ch = res && res.passwordChallenge;
    if (ch && ch.trackId) {
      this.passwordTrackId = String(ch.trackId);
      this.passwordHint = ch.hint ? String(ch.hint) : null;
      this.qr = null; this.qrTrack = null;
      await this.setState('wait_password', { error: null });
      return;
    }
    throw new Error('ответ MAX без токена входа');
  }

  // ── Вход по номеру (веб-транспорт, по PyMax) ─────────────────
  async authStep(step) {
    const s = step || {};
    try {
      if (s.phone !== undefined && s.phone !== null && s.phone !== '') {
        if (this.authState !== 'wait_qr' || !this.transport) return this.stepError(`номер принимается только в состоянии wait_qr (сейчас ${this.authState})`);
        const p = normalizePhone(s.phone);
        if (!p) return this.stepError('некорректный номер');
        const r = await this.transport.request(Op.AUTH_REQUEST, { phone: '+' + p, type: 'START_AUTH' });
        if (!r || !r.token) throw new Error('MAX не вернул токен запроса кода');
        this.sms = { token: String(r.token), phone: p };
        this.codeLength = Number(r.codeLength) || null;
        this.qrTrack = null; this.qr = null;        // опрос QR останавливается
        await this.setState('wait_code', { error: null, phone: p });
        return this.stepOk({ codeLength: this.codeLength });
      }
      if (s.code) {
        if (this.authState !== 'wait_code' || !this.sms || !this.transport) return this.stepError(`код принимается только в состоянии wait_code (сейчас ${this.authState})`);
        const r = await this.transport.request(Op.AUTH, { token: this.sms.token, verifyCode: String(s.code), authTokenType: 'CHECK_CODE' });
        await this.handleTokenResponse(r);
        return this.stepOk();
      }
      if (s.password) {
        if (this.authState !== 'wait_password' || !this.passwordTrackId || !this.transport) return this.stepError(`пароль принимается только в состоянии wait_password (сейчас ${this.authState})`);
        const r = await this.transport.request(Op.AUTH_CHECK_PASSWORD, { trackId: this.passwordTrackId, password: String(s.password) });
        if (r && r.error) throw new Error(String(r.error));
        await this.handleTokenResponse(r);
        return this.stepOk();
      }
      return this.stepError('нужен phone, code или password');
    } catch (e) {
      const msg = e.message || String(e);
      this.lastAuthError = msg;
      try { await this.d.repo.setAuth(this.id, this.authState, { error: msg }); } catch (_) { /* best-effort */ }
      return { authState: this.authState, error: msg };
    }
  }
  stepOk(extra = {}) { return { authState: this.authState, error: null, qr: this.authState === 'wait_qr' ? this.qr : null, ...extra }; }
  stepError(msg) { return { authState: this.authState, error: msg }; }

  // ── LOGIN ────────────────────────────────────────────────────
  async login() {
    const t = this.transport;
    let r;
    try {
      r = await t.request(Op.LOGIN, { token: this.sess.loginToken, chatsCount: LOGIN_CHATS_COUNT, interactive: true, chatsSync: 0, contactsSync: 0, presenceSync: -1, draftsSync: 0 });
    } catch (e) {
      if (isTokenRevoked(e)) { await this.onLoggedOut(`сессия MAX отозвана (${e.code})`); return; }
      throw e;
    }
    if (this.closed || this.transport !== t) return;
    const contact = (r && r.profile && r.profile.contact) || {};
    if (contact.id !== undefined && contact.id !== null) this.ownerId = Number(contact.id);
    const phone = contact.phone !== undefined && contact.phone !== null ? normalizePhone(String(contact.phone)) : null;
    if (phone) this.ownPhone = phone;
    const name = Array.isArray(contact.names) && contact.names[0] && contact.names[0].name;
    if (name) this.displayName = String(name);
    if (r && r.token && r.token !== this.sess.loginToken) this.sess.loginToken = String(r.token);   // ротация
    Object.assign(this.sess, { ownerId: this.ownerId, phone: this.ownPhone, displayName: this.displayName });
    this.saveSession();
    for (const c of (r && r.chats) || []) if (c && c.id !== undefined && c.id !== null) this.chats.set(Number(c.id), c);
    for (const c of (r && r.contacts) || []) this.rememberContactInfo(c);
    this.connected = true;
    this.qr = null; this.qrTrack = null; this.reconnects = 0; this.qrRounds = 0;
    await this.setState('ready', { error: null, phone: this.ownPhone, displayName: this.displayName });
    this.log.info(`готов: ${this.ownPhone || '?'} (${this.displayName || '?'}, id ${this.ownerId})`);
    try {
      const n = await this.d.deliveries.failStale(this.id);
      if (n) this.log.warn(`закрыто ${n} доставок, зависших с прошлого запуска`);
    } catch (e) { this.log.warn(`failStale: ${e.message}`); }
  }

  async onLoggedOut(reason) {
    this.closed = true; this.connected = false;
    if (this.transport) { try { this.transport.close(); } catch (_) { /* уже закрыт */ } }
    this.d.session.remove(this.dirs().max);
    this.qr = null; this.qrTrack = null; this.authState = 'logged_out';
    await this.d.repo.setAuth(this.id, 'logged_out', { error: reason });
    this.log.warn(reason);
  }

  // Контакт из LOGIN/CONTACT_INFO/NOTIF_PROFILE → кэш и gateway_contacts (номер виден
  // не всегда — приватность; свой номер не пишем).
  rememberContactInfo(c) {
    if (!c || c.id === undefined || c.id === null) return null;
    const id = Number(c.id);
    const phone = c.phone !== undefined && c.phone !== null && c.phone !== '' ? normalizePhone(String(c.phone)) : null;
    const n0 = Array.isArray(c.names) && c.names[0] ? c.names[0] : null;
    const name = n0 ? (String(n0.name || [n0.firstName, n0.lastName].filter(Boolean).join(' ')).trim() || null) : null;
    const prev = this.contacts.get(id) || {};
    const info = { id, phone: phone || prev.phone || null, name: name || prev.name || null };
    if (!this.contacts.has(id) && this.contacts.size >= CONTACTS_CACHE_MAX) this.contacts.delete(this.contacts.keys().next().value);
    this.contacts.set(id, info);
    if (phone && phone !== prev.phone && id !== this.ownerId) {
      this.d.repo.rememberContact(this.id, phone, String(id)).catch(e => this.log.warn(`rememberContact: ${e.message}`));
    }
    return info;
  }

  // ── Push-события ─────────────────────────────────────────────
  async onPush(frame) {
    if (!frame || this.closed) return;
    const p = frame.payload || {};
    switch (frame.opcode) {
      case Op.NOTIF_MESSAGE: {
        if (this.transport) this.transport.ack(frame, { chatId: p.chatId, messageId: p.message && p.message.id });
        if (!p.message || p.chatId === undefined || p.chatId === null) return;
        const chatId = Number(p.chatId);
        await this.enqueueChat(chatId, () => this.onMessage(chatId, p.message));
        return;
      }
      case Op.NOTIF_CHAT:
        if (p.chat && p.chat.id !== undefined && p.chat.id !== null) this.chats.set(Number(p.chat.id), p.chat);
        return;
      case Op.NOTIF_ATTACH: {
        const w = this.fileWaiters.get(String(p.fileId));
        if (w) w();
        return;
      }
      case Op.NOTIF_PROFILE: {
        const c = p.profile && p.profile.contact;
        if (c) this.rememberContactInfo(c);
        return;
      }
      default:
        return;
    }
  }

  status() {
    return {
      authState: this.authState, phone: this.ownPhone, displayName: this.displayName, error: this.lastAuthError,
      qr: this.authState === 'wait_qr' ? this.qr : null, pairingCode: null,
      codeLength: this.authState === 'wait_code' ? this.codeLength : null,
      passwordHint: this.authState === 'wait_password' ? this.passwordHint : null,
    };
  }

  enqueueChat(chatId, fn) {
    const prev = this.chatQueues.get(chatId) || Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.chatQueues.set(chatId, tail);
    tail.then(() => { if (this.chatQueues.get(chatId) === tail) this.chatQueues.delete(chatId); });
    return next;
  }

  pruneOwnSends() {
    const cutoff = this.d.now() - OWN_SEND_TTL_MS;
    for (const [id, v] of this.ownSends) if (v.ts < cutoff) this.ownSends.delete(id);
  }

  // ── Завершение ───────────────────────────────────────────────
  async logout() {
    this.closed = true;
    try { if (this.transport && this.connected) await this.transport.request(Op.LOGOUT); }
    catch (e) { this.log.warn(`LOGOUT: ${e.message}`); }
    await this.close();
    this.d.session.remove(this.dirs().max);
    this.authState = 'logged_out'; this.qr = null;
    await this.d.repo.setAuth(this.id, 'logged_out');
  }

  async close() {
    this.closed = true;
    this.connected = false;
    this.qrTrack = null;
    const t = this.transport;
    this.transport = null;
    if (t) { t.removeAllListeners(); try { t.close(); } catch (_) { /* уже закрыт */ } }
    for (const w of this.fileWaiters.values()) w();
    this.ownSends.clear();
  }
}

module.exports = { MaxClient, MAX_MESSAGE_AGE_S, RECONNECT_MS, MAX_QR_ROUNDS, QR_ABANDONED_ERROR, FILE_READY_TIMEOUT_MS, ATTACH_RETRY_MS, MEDIA_DOWNLOAD_TIMEOUT_MS, LOGIN_CHATS_COUNT };
```

- [ ] **Step 3: Прогнать тесты**

Run: `cd /root/loyalpro/gateway && node --test test/max-client.test.js`
Expected: PASS (10 тестов). Если тест «QR истёк» зацикливается — проверить, что `pollQr` выходит, когда `qrTrack` сменился, и что `beginQr` инкрементирует `qrRounds` ДО запроса.

- [ ] **Step 4: Коммит**

```bash
cd /root/loyalpro && git add gateway/lib/max-client.js gateway/test/max-client.test.js && git commit -m "feat(gateway): MAX — клиент: сессия, HELLO/QR/номер/LOGIN, реконнект, разлогин

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Клиент — входящие, контакты, медиа — 🔵 Opus

**Files:**
- Modify: `gateway/lib/max-client.js` (добавить методы после `onPush`)
- Test: `gateway/test/max-client.test.js` (дописать в конец)

- [ ] **Step 1: Дописать падающие тесты входящих**

В конец `gateway/test/max-client.test.js`:

```js
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
```

Run: `cd /root/loyalpro/gateway && node --test test/max-client.test.js`
Expected: FAIL — `this.onMessage is not a function`.

- [ ] **Step 2: Добавить методы входящих**

В `gateway/lib/max-client.js` после метода `onPush` (перед `status()`) вставить:

```js
  // ── Входящие ─────────────────────────────────────────────────
  async onMessage(chatId, message) {
    if (!this.connected || this.ownerId === null || !message) return;
    const id = String(message.id);
    this.pruneOwnSends();
    if (this.ownSends.has(id)) return;                     // наша отправка — эхо уже синтезировано
    if (chatId === 0) return;                              // «Избранное» (чат с собой)
    const chat = this.chats.get(chatId) || null;
    if (mapper.isChannel(chat)) return;                    // каналы не форвардим (как рассылки WhatsApp)
    if (!mapper.contentOf(message)) return;                // служебное / правка / пусто
    const ts = mapper.tsSeconds(message.time);
    if (ts && Math.floor(this.d.now() / 1000) - ts > MAX_MESSAGE_AGE_S) return;
    await this.emitMessage(chatId, message, null);
  }

  // Общий путь входящих и синтезированного эха своей отправки.
  async emitMessage(chatId, message, deliveryId) {
    const chat = this.chats.get(chatId) || null;
    const group = mapper.isGroupChat({ chatId, chat });
    const outgoing = Number(message.sender) === this.ownerId;
    let peerId = null;
    if (group) {
      peerId = outgoing ? null : Number(message.sender);
    } else {
      peerId = mapper.peerIdOf({ chatId, chat, ownerId: this.ownerId });
      if (chat && chat.participants && this.diag.xor++ === 0) {
        const x = mapper.xorId(chatId, this.ownerId);
        this.log.info(`диалог ${chatId}: участник ${peerId}, XOR даёт ${x} — ${x === peerId ? 'совпадает' : 'НЕ совпадает'}`);
      }
      if (peerId === this.ownerId) return;                 // чат с собой
    }
    const peer = peerId !== null ? await this.resolveContact(peerId) : null;
    const content = mapper.contentOf(message) || { type: 'unsupported', text: '', media: null };
    let fileUrl = null;
    if (content.media && !group) {
      try {
        const dl = await this.downloadToPublic(chatId, message, content.media);
        fileUrl = dl.fileUrl;
        if (dl.mimeType) content.media.mimeType = dl.mimeType;
      } catch (e) { this.log.warn(`медиа ${chatId}:${message.id} не скачано (${e.message})`); }
    }
    const body = mapper.buildWebhookBody({ accountId: this.id, ownPhone: this.ownPhone, ownerId: this.ownerId, chatId, chat, message, peer, deliveryId, fileUrl, content });
    await this.d.webhook.sendSafe(body);
  }

  // Кэш → CONTACT_INFO (один раз на id) → gateway_contacts (номер, когда MAX его скрыл).
  async resolveContact(userId) {
    const id = Number(userId);
    const hit = this.contacts.get(id);
    if (hit && hit.phone) return hit;
    let info = hit || null;
    if (!info && this.transport && this.connected) {
      try {
        const r = await this.transport.request(Op.CONTACT_INFO, { contactIds: [id] });
        const c = r && Array.isArray(r.contacts) ? r.contacts.find(x => x && Number(x.id) === id) : null;
        if (c) info = this.rememberContactInfo(c);
      } catch (e) { this.log.warn(`CONTACT_INFO(${id}): ${e.message}`); }
    }
    if (!info) info = { id, phone: null, name: null };
    if (!info.phone) {
      try {
        const p = await this.d.repo.phoneByUserId(this.id, String(id));
        if (p) info = { ...info, phone: p };
      } catch (e) { this.log.warn(`phoneByUserId(${id}): ${e.message}`); }
    }
    this.contacts.set(id, info);
    return info;
  }

  // Фото — по baseUrl; файл — временный URL через FILE_DOWNLOAD. Кап по заявленному
  // размеру (ранний отказ) и по факту (media.download); расширение — только из
  // белого списка по MIME (публичный каталог отдаётся статикой в origin админки).
  async downloadToPublic(chatId, message, media) {
    const max = this.d.maxMediaBytes || MAX_MEDIA_BYTES;
    if (media.size && media.size > max) throw new Error(`файл ${media.size} байт больше лимита ${max}`);
    let url = media.url;
    if (!url && media.kind === 'FILE' && media.fileId !== null && media.fileId !== undefined) {
      const r = await this.transport.request(Op.FILE_DOWNLOAD, { fileId: media.fileId, chatId, messageId: String(message.id) });
      url = r && r.url;
    }
    if (!url) throw new Error('нет ссылки на файл');
    const { buf, mimeType: headerMime } = await this.d.media.download(url, { http: this.d.http, maxBytes: max, timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS });
    const declared = media.mimeType && media.mimeType !== 'application/octet-stream' ? media.mimeType : null;
    const mimeType = (media.kind === 'FILE' && declared) ? declared : (headerMime || declared || media.mimeType);
    const dir = path.join(this.d.config.PUBLIC_FILES_DIR, String(this.id));
    fs.mkdirSync(dir, { recursive: true });
    const name = publicFileName(mimeType, this.d.now());
    fs.writeFileSync(path.join(dir, name), buf);
    return { fileUrl: `${this.d.config.PUBLIC_FILES_URL}/${this.id}/${name}`, mimeType };
  }
```

- [ ] **Step 3: Прогнать тесты**

Run: `cd /root/loyalpro/gateway && node --test test/max-client.test.js`
Expected: PASS (18 тестов).

- [ ] **Step 4: Коммит**

```bash
cd /root/loyalpro && git add gateway/lib/max-client.js gateway/test/max-client.test.js && git commit -m "feat(gateway): MAX — входящие: push → вебхук max_incoming_msg, контакты, медиа в публичный каталог

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Клиент — отправка текста и файлов, эхо, статусы — 🔵 Opus

**Files:**
- Modify: `gateway/lib/max-client.js` (добавить методы перед `logout()`)
- Test: `gateway/test/max-client.test.js` (дописать в конец)

- [ ] **Step 1: Дописать падающие тесты отправки**

В конец `gateway/test/max-client.test.js`:

```js
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
```

Run: `cd /root/loyalpro/gateway && node --test test/max-client.test.js`
Expected: FAIL — `this.client.sendText is not a function`.

- [ ] **Step 2: Добавить методы отправки**

В `gateway/lib/max-client.js` перед методом `logout()` вставить:

```js
  // ── Отправка ─────────────────────────────────────────────────
  requireReady() {
    if (this.authState !== 'ready') throw httpError(`аккаунт не авторизован (${this.authState})`, 422);
    if (!this.connected || !this.transport || !this.transport.isOpen) throw httpError('нет соединения с MAX (переподключение)', 422);
  }

  // Клиентский id сообщения — миллисекунды, монотонно (PyMax _next_cid).
  nextCid() {
    const now = this.d.now();
    this.cidPrev = Math.max(now, this.cidPrev + 1);
    return this.cidPrev;
  }

  // → {chatId, peerId, phone}. max_user_id главнее номера: это id диалога из нашей
  // БД (положительный — собеседник, отрицательный — группа как есть). По номеру:
  // кэш контактов → gateway_contacts → CONTACT_INFO_BY_PHONE. Ничего не отправлено →
  // 422, чтобы transport ушёл на следующий канал каскада.
  async resolveChat({ maxUserId, phone }) {
    const p = normalizePhone(phone);
    if (maxUserId !== undefined && maxUserId !== null && String(maxUserId) !== '') {
      const n = Number(maxUserId);
      if (!Number.isInteger(n) || n === 0) throw httpError(`некорректный max_user_id ${maxUserId}`, 422);
      if (n < 0) return { chatId: n, peerId: null, phone: p };
      return { chatId: mapper.xorId(this.ownerId, n), peerId: n, phone: p };
    }
    if (!p) throw httpError('нет получателя: ни max_user_id, ни phone', 422);
    let userId = null;
    for (const c of this.contacts.values()) if (c.phone === p) { userId = c.id; break; }
    if (!userId) {
      try { userId = await this.d.repo.contactUserId(this.id, p); }
      catch (e) { this.log.warn(`contactUserId(${p}): ${e.message}`); }
    }
    if (!userId) {
      try {
        const r = await this.transport.request(Op.CONTACT_INFO_BY_PHONE, { phone: '+' + p });
        const c = r && r.contact;
        if (c && c.id !== undefined && c.id !== null) {
          userId = Number(c.id);
          this.rememberContactInfo({ ...c, phone: c.phone || p });
        }
      } catch (e) {
        throw httpError(`номер ${p} не найден в MAX (${e.code || e.message})`, 422);
      }
    }
    if (!userId) throw httpError(`номер ${p} не найден в MAX`, 422);
    return { chatId: mapper.xorId(this.ownerId, Number(userId)), peerId: Number(userId), phone: p };
  }

  async sendText({ text, phone, maxUserId, replyToMessageId }) {
    this.requireReady();
    const { chatId, phone: p } = await this.resolveChat({ maxUserId, phone });
    const deliveryId = await this.d.deliveries.create({ accountId: this.id, chatId, phone: p, kind: 'text', text });
    const message = { text: String(text), cid: this.nextCid(), elements: [], attaches: [] };
    // reply только на id MAX (строка цифр); составной id Telegram-эпохи или
    // числовой id Chatpush-эпохи другого канала просто игнорируется.
    if (replyToMessageId && /^\d{1,30}$/.test(String(replyToMessageId))) message.link = { type: 'REPLY', messageId: String(replyToMessageId) };
    await this.invokeSend(chatId, message, deliveryId);
    return deliveryId;
  }

  // Временный файл read + rm сразу (как WhatsApp): ЧИТАЕМ ДО создания доставки.
  // Фото (type=image с image/* MIME) — PHOTO_UPLOAD + multipart; остальное —
  // FILE_UPLOAD + сырой POST + ожидание NOTIF_ATTACH.
  async sendFile({ filePath, fileName, caption, type, phone, maxUserId, mimeType }) {
    this.requireReady();
    let buf;
    try { buf = fs.readFileSync(filePath); }
    catch (e) { throw httpError(`файл не прочитан: ${e.message}`, 422); }
    finally {
      try { fs.rmSync(filePath, { force: true }); } catch (_) { /* подберёт страховочный таймер server.js */ }
      fs.rmdir(path.dirname(filePath), () => {});
    }
    const { chatId, phone: p } = await this.resolveChat({ maxUserId, phone });
    const mime = mimeType || mapper.mimeOfName(fileName);
    let attaches;
    if (type === 'image' && /^image\//.test(mime)) {
      const r = await this.transport.request(Op.PHOTO_UPLOAD, { count: 1 }).catch(e => { throw httpError(`MAX PHOTO_UPLOAD: ${e.message}`, 422); });
      if (!r || !r.url) throw httpError('MAX PHOTO_UPLOAD: нет URL загрузки', 422);
      const token = await this.d.media.uploadPhoto(r.url, buf, fileName, mime, { http: this.d.http }).catch(e => { throw httpError(`MAX: ${e.message}`, 422); });
      attaches = [{ _type: 'PHOTO', photoToken: token }];
    } else {
      const r = await this.transport.request(Op.FILE_UPLOAD, { count: 1 }).catch(e => { throw httpError(`MAX FILE_UPLOAD: ${e.message}`, 422); });
      const info = r && Array.isArray(r.info) && r.info[0];
      if (!info || !info.url) throw httpError('MAX FILE_UPLOAD: нет слота загрузки', 422);
      const ready = this.waitFileReady(info.fileId);
      try { await this.d.media.uploadFile(info.url, buf, fileName || 'file', { http: this.d.http }); }
      catch (e) { this.cancelFileWait(info.fileId); throw httpError(`MAX: ${e.message}`, 422); }
      await ready;
      attaches = [{ _type: 'FILE', fileId: info.fileId }];
    }
    const deliveryId = await this.d.deliveries.create({ accountId: this.id, chatId, phone: p, kind: 'file', text: caption || fileName });
    await this.invokeSend(chatId, { text: caption || '', cid: this.nextCid(), elements: [], attaches }, deliveryId);
    return deliveryId;
  }

  // Готовность файла — push NOTIF_ATTACH {fileId}. Не пришёл за FILE_READY_TIMEOUT_MS —
  // шлём всё равно: MSG_SEND ответит attachment.not.ready, invokeSend повторит.
  waitFileReady(fileId) {
    const key = String(fileId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.fileWaiters.delete(key);
        this.log.warn(`файл ${key}: NOTIF_ATTACH не пришёл за ${(this.d.fileReadyTimeoutMs || FILE_READY_TIMEOUT_MS) / 1000} с — отправляем без подтверждения`);
        resolve();
      }, this.d.fileReadyTimeoutMs || FILE_READY_TIMEOUT_MS);
      // Без unref: ожидание — часть активной отправки, оно обязано пережить тихий
      // цикл событий (иначе промис повис бы навсегда).
      this.fileWaiters.set(key, () => { clearTimeout(timer); this.fileWaiters.delete(key); resolve(); });
    });
  }
  cancelFileWait(fileId) { const w = this.fileWaiters.get(String(fileId)); if (w) w(); }

  async invokeSend(chatId, message, deliveryId) {
    let res;
    for (let attempt = 0; ; attempt++) {
      try { res = await this.transport.request(Op.MSG_SEND, { chatId, message, notify: true }); break; }
      catch (e) {
        if (e.code === 'attachment.not.ready' && attempt === 0) { await this.d.sleep(ATTACH_RETRY_MS); continue; }
        try { await this.d.deliveries.setStatus(deliveryId, this.d.deliveries.STATUS.FAILED, { error: e.message }); }
        catch (e2) { this.log.error(`delivery g${deliveryId}: статус FAILED не записан (${e2.message})`); }
        // Таймаут/обрыв — исход неизвестен (503: transport НЕ уйдёт на другой канал);
        // отказ сервера — ничего не ушло (422/429).
        const unknown = e.code === 'timeout' || e.code === 'transport_closed';
        const rate = /rate|limit|too\.?many|flood/i.test(String(e.code || e.message));
        throw httpError(`MAX: ${e.message}`, unknown ? 503 : (rate ? 429 : 422));
      }
    }
    const sent = (res && res.message) || {};
    const msgId = sent.id !== undefined && sent.id !== null ? String(sent.id) : null;
    if (msgId) {
      this.pruneOwnSends();
      this.ownSends.set(msgId, { deliveryId, ts: this.d.now() });
      try { await this.d.deliveries.setProviderMessageId(deliveryId, msgId); }
      catch (e) { this.log.warn(`delivery g${deliveryId}: provider_message_id не записан (${e.message})`); }
    }
    try { await this.d.deliveries.setStatusIf(deliveryId, this.d.deliveries.STATUS.ACCEPTED[0], this.d.deliveries.STATUS.SENT); }
    catch (e) { this.log.warn(`delivery g${deliveryId}: статус SENT не записан (${e.message})`); }
    // Эхо своей отправки — из ответа сервера, не ждём push (он может и не прийти).
    const echo = { ...sent, id: msgId || `g${deliveryId}`, sender: this.ownerId, time: sent.time || this.d.now(), type: 'USER', text: sent.text !== undefined ? sent.text : message.text, attaches: sent.attaches || message.attaches };
    this.enqueueChat(chatId, () => this.emitMessage(chatId, echo, `g${deliveryId}`)).catch(e => this.log.warn(`эхо g${deliveryId}: ${e.message}`));
  }
```

- [ ] **Step 3: Прогнать тесты**

Run: `cd /root/loyalpro/gateway && node --test test/max-client.test.js`
Expected: PASS (25 тестов).

- [ ] **Step 4: Коммит**

```bash
cd /root/loyalpro && git add gateway/lib/max-client.js gateway/test/max-client.test.js && git commit -m "feat(gateway): MAX — отправка текста/фото/файлов, поиск по номеру, эхо и статусы доставок

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Реестр, репозиторий, сервер — канал `max` — 🟢 Sonnet

**Files:**
- Modify: `gateway/lib/registry.js`
- Modify: `gateway/lib/accounts-repo.js`
- Modify: `gateway/server.js` (маршруты `/api/v1/delivery`, `/api/v1/send_file`, комментарий в `/status`)
- Test: `gateway/test/registry.test.js`, `gateway/test/accounts-repo.test.js`, `gateway/test/server.test.js`

- [ ] **Step 1: Падающие тесты**

В `gateway/test/registry.test.js` после `stub('whatsapp-client', …)` добавить фейк MAX и заменить тест `clientClassFor`:

```js
class FakeMax extends FakeClient {}
FakeMax.dirsFor = (cfg, id) => ({ base: path.join(cfg.DATA_DIR, `acc-${id}`), max: path.join(cfg.DATA_DIR, `acc-${id}`, 'max') });
stub('max-client', { MaxClient: FakeMax });
```

(вставить ДО строки `const registry = require('../lib/registry');`), а тест заменить на:

```js
test('clientClassFor: tdlib → Telegram, whatsapp → WhatsApp, max → MAX, прочее → 422', () => {
  assert.equal(registry.clientClassFor({ channel: 'tdlib' }), FakeClient);
  assert.equal(registry.clientClassFor({ channel: 'whatsapp' }), FakeWa);
  assert.equal(registry.clientClassFor({ channel: 'max' }), FakeMax);
  assert.throws(() => registry.clientClassFor({ channel: 'max_bot' }), e => e.status === 422);
});
```

В `gateway/test/accounts-repo.test.js` заменить тест `listActive` и добавить `phoneByUserId`:

```js
test('listActive: все три канала шлюза, статусы active|pending', async () => {
  await repo.listActive();
  assert.match(calls.at(-1)[0], /channel IN \('tdlib','whatsapp','max'\)/);
  assert.match(calls.at(-1)[0], /status IN \('active','pending'\)/);
});
test('phoneByUserId — тот же запрос, что phoneByLid (user_id = id пользователя MAX)', async () => {
  assert.equal(await repo.phoneByUserId(9, '11478793'), '79001112233');
  assert.match(calls.at(-1)[0], /FROM gateway_contacts WHERE account_id=\$1 AND user_id=\$2/);
  assert.deepEqual(calls.at(-1)[1], [9, '11478793']);
});
```

(Фейк `db.oneOrNone` в этом тесте уже отдаёт `{ phone: '79001112233' }` на запрос `phoneByLid` — проверить в начале файла и при необходимости расширить условие на тот же SQL.)

В `gateway/test/server.test.js` в конец:

```js
test('POST /api/v1/delivery и send_file: max_user_id прокидывается в клиент как maxUserId', async () => {
  const calls = [];
  const app = createApp(deps({ tg: { sendText: async (a) => { calls.push(a); return 12; } }, account: { id: 7, channel: 'max' } }));
  const r = await call(app, 'POST', '/api/v1/delivery?text=hi&phone=79001112233&max_user_id=11478793&dispatch_routing[]=max', { headers: { authorization: 'Bearer TOK' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.delivery.channel, 'max');
  assert.equal(calls[0].maxUserId, '11478793'); assert.equal(calls[0].phone, '79001112233');
  const fcalls = [];
  const fapp = createApp(fileDeps(fcalls));
  const fr = await call(fapp, 'POST', '/api/v1/send_file?file_name=a.pdf&phone=1&max_user_id=5&type=document', { headers: { authorization: 'Bearer TOK' }, multipart: { file: { name: 'a.pdf', data: Buffer.from('%PDF') } } });
  assert.equal(fr.status, 200);
  assert.equal(fcalls[0].maxUserId, '5');
});
```

Перед написанием сверить с тем, как в этом файле устроены `deps()` (принимает ли `account`) и `call()` с multipart (см. существующий тест `POST /api/v1/send_file: multipart file …` — повторить его способ отправки файла; если `deps()` не принимает `account`, расширить фабрику: `byToken` должна отдавать `{ id: 7, channel: 'max', ... }`).

Run: `cd /root/loyalpro/gateway && node --test test/registry.test.js test/accounts-repo.test.js test/server.test.js`
Expected: FAIL в трёх местах (`max` → 422, `listActive` без `'max'`, `maxUserId` undefined).

- [ ] **Step 2: Правки**

`gateway/lib/registry.js`:

```js
const { MaxClient } = require('./max-client');
```
(после `require('./whatsapp-client')`), в `clientClassFor`:

```js
  if (account.channel === 'max') return MaxClient;
```
(после ветки `whatsapp`), в `logout()` вместо двух каталогов — три:

```js
    const tgDirs = TelegramClient.dirsFor(config, id);
    const waDirs = WhatsappClient.dirsFor(config, id);
    const maxDirs = MaxClient.dirsFor(config, id);
    if (fs.existsSync(tgDirs.db) || fs.existsSync(waDirs.wa) || fs.existsSync(maxDirs.max)) {
```
и обновить комментарий над `logout` (`db / wa / max`).

`gateway/lib/accounts-repo.js`: в `listActive` → `channel IN ('tdlib','whatsapp','max')`; в конце файла:

```js
// MAX: user_id = id пользователя MAX (тот же столбец, что LID у WhatsApp).
const phoneByUserId = phoneByLid;

module.exports = { get, listActive, byToken, setAuth, contactUserId, rememberContact, rememberContacts, phoneByLid, phoneByUserId, CONTACTS_BATCH };
```

`gateway/server.js`: в `/api/v1/delivery`:

```js
      const id = await req.tg.sendText({ text, phone: q(req, 'phone'), tdlibUserId: q(req, 'tdlib_user_id'), maxUserId: q(req, 'max_user_id'), replyToMessageId: q(req, 'reply_to_message_id') });
      logger.info(`#${req.account.id} delivery g${id} → ${q(req, 'phone') || q(req, 'tdlib_user_id') || q(req, 'max_user_id')}: ${text.slice(0, 60)}`);
```
в `/api/v1/send_file`:

```js
      const id = await req.tg.sendFile({ filePath: tmp, fileName, caption: q(req, 'caption') || '', type: q(req, 'type') || 'document', phone: q(req, 'phone'), tdlibUserId: q(req, 'tdlib_user_id'), maxUserId: q(req, 'max_user_id'), mimeType: req.file.mimetype });
```
Комментарий в `/internal/accounts/:id/status` заменить на `// qr — у WhatsApp и MAX, pairingCode — только у WhatsApp; Telegram получает null.` Шапку `server.js` и `package.json` `description` дополнить словами «MAX через веб-протокол».

- [ ] **Step 3: Прогнать все тесты шлюза**

Run: `cd /root/loyalpro/gateway && node --test`
Expected: PASS (все файлы, в том числе новые `max-*`).

- [ ] **Step 4: Коммит**

```bash
cd /root/loyalpro && git add gateway/lib/registry.js gateway/lib/accounts-repo.js gateway/server.js gateway/package.json gateway/test/registry.test.js gateway/test/accounts-repo.test.js gateway/test/server.test.js && git commit -m "feat(gateway): канал max в реестре и репозитории, max_user_id в API отправки

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Часть C. Бэкенд и админка

### Task 8: Бэкенд — создание MAX-аккаунта шлюза — 🟢 Sonnet

**Files:**
- Modify: `backend/routes/messaging-accounts.js`
- Test: `backend/messaging-accounts-routes.test.js`

- [ ] **Step 1: Падающий тест**

В `backend/messaging-accounts-routes.test.js` в `describe('createGatewayAccount(whatsapp)')` добавить и поправить тест неизвестного канала:

```js
  test('channel=max: pending-строка с display_name «MAX (свой шлюз)», лок gateway-account:1:max', async () => {
    calls.length = 0;
    const r = await createGatewayAccount(1, 'max');
    expect(r).toEqual({ id: 46, authState: 'starting', status: 'pending' });
    expect(calls[2][0]).toMatch(/'gateway', 'max', 'pending', 'starting', 'MAX \(свой шлюз\)'/);
    expect(calls[0][1]).toEqual(['gateway-account:1:max']);
  });
  test('неизвестный канал → ошибка 400 без запросов', async () => {
    await expect(createGatewayAccount(1, 'max_bot')).rejects.toMatchObject({ status: 400 });
  });
```

(в существующем тесте `неизвестный канал` заменить `'max'` на `'max_bot'`; `46` — подставить тот id, который возвращает мок INSERT в этом файле, см. соседний тест для whatsapp — повторить его подготовку моков `db`/`gw.start`.) И в тесте HTTP-ручек:

```js
  test('POST /accounts/max заводит gateway-аккаунт канала max', async () => {
    const res = mockRes();
    db.withTransaction.mockImplementationOnce(async (fn) => fn(fakeClient([{ rows: [] }, { rows: [] }, { rows: [{ id: 47 }] }, { rows: [] }])));
    await route('post', '/accounts/max')({ body: {}, user: { salonId: 1 } }, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 47, status: 'pending' }));
  });
```

(имена помощников `mockRes`, `route`, `fakeClient` — взять те, что уже используются в этом файле для `POST /accounts/whatsapp`.)

Run: `cd /root/loyalpro/backend && npx jest messaging-accounts-routes`
Expected: FAIL — `канал max через шлюз не подключается`, маршрута `/accounts/max` нет.

- [ ] **Step 2: Правки**

В `backend/routes/messaging-accounts.js`:

```js
const GATEWAY_CHANNELS = { tdlib: 'Telegram (свой шлюз)', whatsapp: 'WhatsApp (свой шлюз)', max: 'MAX (свой шлюз)' };
```
и после `router.post('/accounts/whatsapp', …)`:

```js
router.post('/accounts/max', adminOnly, async (req, res) => {
  if (!config.MESSAGING_GATEWAY.url) return res.status(503).json({ error: 'шлюз мессенджеров не настроен (MESSAGING_GATEWAY_URL)' });
  try { res.json(await createGatewayAccount(req.user.salonId, 'max')); }
  catch (e) { logger.error(`create max: ${e.message}`); res.status(e.status || 500).json({ error: e.message }); }
});
```
Комментарий над `createGatewayAccount` («Telegram или WhatsApp») дополнить MAX.

- [ ] **Step 3: Прогнать**

Run: `cd /root/loyalpro/backend && npx jest messaging-accounts-routes`
Expected: PASS.

- [ ] **Step 4: Коммит**

```bash
cd /root/loyalpro && git add backend/routes/messaging-accounts.js backend/messaging-accounts-routes.test.js && git commit -m "feat(messaging): POST /api/messaging/accounts/max — MAX через свой шлюз

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Фронт — кнопка «Подключить MAX напрямую», QR-шаг с резервным входом по номеру — 🟢 Sonnet

**Files:**
- Modify: `frontend/js/pages/messaging-accounts.js`
- Modify: `frontend/index.html` (разметка `#stg-messengers`, `?v=` скрипта)
- Test: `frontend/js/pages/messaging-accounts.test.js`

- [ ] **Step 1: Падающие тесты**

В `frontend/js/pages/messaging-accounts.test.js` в конец:

```js
test('msgAccRestartPlan: MAX — как WhatsApp (повторный start без logout)', () => {
  assert.deepEqual({ ...ctx.msgAccRestartPlan('max', 'pending') }, { show: true, logout: false });
  assert.deepEqual({ ...ctx.msgAccRestartPlan('max', 'active') }, { show: true, logout: false });
});
test('msgAccGatewayPath / msgAccConnectLabel: канал → путь ручки и подпись', () => {
  assert.equal(ctx.msgAccGatewayPath('tdlib'), 'telegram');
  assert.equal(ctx.msgAccGatewayPath('whatsapp'), 'whatsapp');
  assert.equal(ctx.msgAccGatewayPath('max'), 'max');
  assert.equal(ctx.msgAccConnectLabel('max'), 'MAX');
  assert.equal(ctx.msgAccConnectLabel('tdlib'), 'Telegram');
});
test('msgAccQrHint: подсказка QR зависит от канала', () => {
  assert.match(ctx.msgAccQrHint('max'), /Устройства/);
  assert.match(ctx.msgAccQrHint('whatsapp'), /Связанные устройства/);
});
test('MSG_ACC_CONNECT_BUTTONS: три кнопки — tdlib, whatsapp, max', () => {
  assert.deepEqual(vm.runInContext('MSG_ACC_CONNECT_BUTTONS', ctx).map(b => b[1]), ['tdlib', 'whatsapp', 'max']);
});
```

Run: `cd /root/loyalpro/frontend/js/pages && node --test messaging-accounts.test.js`
Expected: FAIL — функций нет.

- [ ] **Step 2: Правки JS**

В `frontend/js/pages/messaging-accounts.js`:

1. Шапку (комментарий) дополнить: «…подключение Telegram, WhatsApp и MAX через свой шлюз (телефон → код → пароль; QR)».
2. После `MSG_ACC_AUTH` добавить:

```js
// Кнопки «Подключить … напрямую»: [id кнопки, канал, подпись].
const MSG_ACC_CONNECT_BUTTONS = [['msg-acc-connect-tg', 'tdlib', 'Telegram'], ['msg-acc-connect-wa', 'whatsapp', 'WhatsApp'], ['msg-acc-connect-max', 'max', 'MAX']];
function msgAccConnectLabel(channel) { return (MSG_ACC_CONNECT_BUTTONS.find(b => b[1] === channel) || [])[2] || channel; }
// Путь ручки POST /api/messaging/accounts/<path>.
function msgAccGatewayPath(channel) { return channel === 'tdlib' ? 'telegram' : channel; }
// Подпись над QR: где взять сканер в приложении.
function msgAccQrHint(channel) {
  if (channel === 'max') return 'Откройте MAX на телефоне клиники → Профиль → Устройства → Подключить устройство и отсканируйте QR:';
  return 'Откройте WhatsApp на телефоне клиники → Связанные устройства → Привязка устройства и отсканируйте QR:';
}
```
3. `msgAccRestartPlan`: первая строка → `if (channel === 'whatsapp' || channel === 'max') return { show: true, logout: false };` (комментарий: «WhatsApp и MAX — просто повторный start»).
4. В `loadMessagingAccounts` цикл по кнопкам заменить на `for (const [btnId, channel, label] of MSG_ACC_CONNECT_BUTTONS) {`.
5. `msgAccConnect`/`msgAccStart`:

```js
async function msgAccConnect(channel) {
  const label = msgAccConnectLabel(channel);
  if (!confirm(`Подключить ${label} салона к своему шлюзу? Канал переключится с Chatpush, когда вход будет подтверждён. Продолжить?`)) return;
  await msgAccStart(channel);
}
async function msgAccStart(channel) {
  try {
    const r = await api('POST', `/api/messaging/accounts/${msgAccGatewayPath(channel)}`);
```
(остальное тело без изменений) и добавить `function msgAccConnectMax() { return msgAccConnect('max'); }` рядом с `msgAccConnectWhatsapp`.
6. В `msgAccRenderStep` внутри `if (extra && step === 'qr') {` первой строкой:

```js
    const hint = document.getElementById('msg-acc-qr-hint');
    if (hint) hint.textContent = msgAccQrHint(_msgAccChannel);
    const waOnly = document.getElementById('msg-acc-qr-wa-only');
    if (waOnly) waOnly.style.display = _msgAccChannel === 'whatsapp' ? '' : 'none';
    const maxOnly = document.getElementById('msg-acc-qr-max-only');
    if (maxOnly) maxOnly.style.display = _msgAccChannel === 'max' ? '' : 'none';
```
7. В `msgAccSendStep` — `const bodyKey = (field === 'wa-phone' || field === 'max-phone') ? 'phone' : field;`.

- [ ] **Step 3: Правки разметки `frontend/index.html`**

В блоке `#stg-messengers`: текст абзаца → «Telegram, WhatsApp и MAX можно подключить напрямую (свой шлюз), остальные каналы пока идут через Chatpush.»; после кнопки WhatsApp:

```html
          <button class="btn btn-pri" id="msg-acc-connect-max" onclick="msgAccConnectMax()">Подключить MAX напрямую</button>
```
Шаг `data-step="qr"` переписать так:

```html
            <div data-step="qr">
              <p id="msg-acc-qr-hint">Откройте приложение на телефоне клиники и отсканируйте QR:</p>
              <img id="msg-acc-qr-img" alt="QR для привязки устройства" style="display:none;width:240px;height:240px;border:1px solid #ddd;border-radius:8px">
              <p id="msg-acc-qr-wait" style="opacity:.8">Обновляю QR… (идёт переподключение, до минуты)</p>
              <div id="msg-acc-qr-wa-only">
                <p style="opacity:.8;margin-top:10px">Нет возможности сканировать? Введите номер WhatsApp клиники — получите код, его вводят на телефоне в «Привязка по номеру телефона».</p>
                <input id="msg-acc-wa-phone" autocomplete="tel" placeholder="+7 900 000-00-00" style="max-width:280px">
                <button class="btn btn-sec" onclick="msgAccSendStep('wa-phone')">Получить код привязки</button>
                <p id="msg-acc-pairing-code" style="font-size:18px;font-weight:600;letter-spacing:2px"></p>
              </div>
              <div id="msg-acc-qr-max-only" style="display:none">
                <p style="opacity:.8;margin-top:10px">Если QR недоступен: введите номер MAX клиники — придёт SMS с кодом, затем при необходимости пароль. (Вход по номеру в MAX живьём не проверялся — предпочтителен QR.)</p>
                <input id="msg-acc-max-phone" autocomplete="tel" placeholder="+7 900 000-00-00" style="max-width:280px">
                <button class="btn btn-sec" onclick="msgAccSendStep('max-phone')">Отправить код из SMS</button>
              </div>
            </div>
```
Подписи шагов `code`/`password` сделать нейтральными: «Код подтверждения (придёт в приложение или SMS)», «Пароль двухэтапной проверки». Бамп версии скрипта: `js/pages/messaging-accounts.js?v=2026-10-13`.

- [ ] **Step 4: Прогнать тесты и визуально проверить**

Run: `cd /root/loyalpro/frontend/js/pages && node --test messaging-accounts.test.js`
Expected: PASS.

Через MCP Playwright: открыть дев-админку → Настройки → Мессенджеры. Expected: три кнопки подключения, кнопка MAX активна при настроенном шлюзе; клик (после Task 7 и перезапуска `loyalpro-gateway`) показывает мастер с QR-картинкой и подписью про «Профиль → Устройства». QR НЕ сканировать (тестовый номер — Task 11).

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add frontend/js/pages/messaging-accounts.js frontend/js/pages/messaging-accounts.test.js frontend/index.html && git commit -m "feat(ui): Настройки → Мессенджеры — «Подключить MAX напрямую» (QR + резервный вход по номеру)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Документация — 🟡 Haiku

**Files:**
- Modify: `CLAUDE.md` (раздел «Свой шлюз мессенджеров (gateway/)», после пункта про WhatsApp)

- [ ] **Step 1: Добавить пункт**

```markdown
- **MAX через шлюз (с 2026-10):** `gateway/lib/max-client.js` — СВОЙ клиент веб-протокола MAX (то, чем говорит web.max.ru): JSON-кадры `{ver:11, cmd, seq, opcode, payload}` поверх `wss://ws-api.oneme.ru/websocket` (`lib/max/transport.js`, опкоды в `lib/max/protocol.js`), библиотек нет — референсы `max-account-api` (типы) и `MaxApiTeam/PyMax` (payloads), при изменении протокола сверяться с ними. Бинарный msgpack+LZ4 — только мобильный путь, нам не нужен. Авторизация: QR (`QR_START` → опрос `QR_POLL` → `QR_LOGIN` [→ op 115 пароль 2FA] → `LOGIN`), QR живёт 120 с, после 5 раундов без входа — `error`; вход по номеру (`AUTH_REQUEST`/`AUTH`) — по PyMax, живьём не проверен. Сессия `data/acc-<id>/max/session.json` (`deviceId` + `loginToken`; токен ротируется в ответе LOGIN); `FAIL_LOGIN_TOKEN`/`FAIL_LOGOUT_ALL` = разлогин с телефона → `logged_out` без реконнекта. Вебхук — ПЛОСКАЯ форма `max_incoming_msg` (как у Chatpush): `chat_id` личного диалога = id СОБЕСЕДНИКА (= `chatId XOR ownerId`, PyMax), группы — отрицательный id чата. Своё сообщение с телефона = push с `sender === ownerId` → эхо без `delivery_id` → пауза «ответил оператор». Эхо своей отправки синтезируется из ответа `MSG_SEND` (push того же id пропускается). Отправка по номеру — `CONTACT_INFO_BY_PHONE`, номера нет/закрыт приватностью → 422 (каскад идёт дальше); `max_user_id` главнее номера. Фото входящие — `baseUrl` (на деле `image/webp`), файлы — `FILE_DOWNLOAD`; исходящие фото — `PHOTO_UPLOAD` + multipart, файлы — `FILE_UPLOAD` + сырой POST + ожидание `NOTIF_ATTACH` (не пришёл за 60 с — шлём, `attachment.not.ready` повторяется один раз). Env: `MAX_WS_URL`, `MAX_WEB_APP_VERSION` (сервер может объявить версию устаревшей — менять без правки кода), `MAX_REQUEST_TIMEOUT_MS`. Дев-бокс в Финляндии: HELLO/QR работают без RU-IP (проверено 13.10.2026). Спека `docs/superpowers/specs/2026-10-13-max-gateway-design.md`, план `docs/superpowers/plans/2026-10-13-max-gateway.md`, исследование `docs/2026-10-13-max-gateway-feasibility.md`.
```

- [ ] **Step 2: Коммит**

```bash
cd /root/loyalpro && git add CLAUDE.md && git commit -m "docs: MAX через свой шлюз — заметки для CLAUDE.md

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Часть D. Живая проверка и выкат

### Task 11: Спайк и сквозная проверка на деве — 🟣 Fable (+ владелец сканирует QR с тестового номера)

**Files:**
- Create: `gateway/scripts/max-spike.js`

Цель — увидеть на реальном трафике то, чего юнит-тесты знать не могут (спека §6): форму push 128 для СВОИХ сообщений с телефона, формулу XOR (лог «диалог …: участник …, XOR даёт … — совпадает»), видимость номера собеседника, заголовки загрузки файлов, квитирование. Аккаунт — тестовый номер владельца +79200255591 (как у Telegram/WhatsApp), НЕ номер клиники.

- [ ] **Step 1: Написать спайк**

```js
'use strict';
// Разовая живая проверка веб-протокола MAX через НАШ клиент: QR в файл, сырые
// push-кадры в лог, по флагу — одна отправка. Ничего не пишет в БД (repo/deliveries
// подменены), вебхук печатает в консоль.
//   node scripts/max-spike.js [--to 79250177778] [--text 'spike'] [--file /path/a.jpg]
// Сессия — data/spike-max (удалить после спайка).
const path = require('path');
const fs = require('fs');
const { MaxClient } = require('../lib/max-client');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const dataDir = path.join(__dirname, '../data/spike-max');
const config = { ...require('../config'), DATA_DIR: dataDir, PUBLIC_FILES_DIR: path.join(dataDir, 'pub'), PUBLIC_FILES_URL: '/spike' };
const deps = {
  config,
  repo: { setAuth: async (id, st, x) => log('setAuth', st, JSON.stringify(x || {})), rememberContact: async (...a) => log('rememberContact', a.slice(1)), contactUserId: async () => null, phoneByUserId: async () => null },
  deliveries: { STATUS: { ACCEPTED: [1, 'Принято'], SENT: [2, 'Отправлено'], FAILED: [5, 'Невозможно доставить'] }, create: async (r) => { log('delivery create', JSON.stringify(r)); return 1; }, setStatus: async (...a) => log('delivery status', JSON.stringify(a)), setStatusIf: async (...a) => { log('delivery statusIf', JSON.stringify(a)); return true; }, setProviderMessageId: async (...a) => log('delivery pmid', JSON.stringify(a)), failStale: async () => 0 },
  webhook: { sendSafe: async (b) => log('WEBHOOK', JSON.stringify(b)) },
};
const client = new MaxClient({ id: 0, channel: 'max', phone: null }, deps);
(async () => {
  await client.start();
  // Сырые кадры — через транспорт клиента (после connect).
  const attach = () => { const t = client.transport; if (t && !t._spike) { t._spike = true; t.on('raw', (f) => { if (f.cmd === 0 || f.opcode === 128 || f.opcode === 135 || f.opcode === 136) log('RAW', JSON.stringify(f).slice(0, 1500)); }); } };
  const timer = setInterval(async () => {
    attach();
    const st = client.status();
    if (st.qr && !fs.existsSync('/tmp/max-spike-qr.png')) { fs.writeFileSync('/tmp/max-spike-qr.png', Buffer.from(st.qr.split(',')[1], 'base64')); log('QR → /tmp/max-spike-qr.png (показать владельцу: MAX → Профиль → Устройства → Подключить устройство)'); }
    if (st.authState === 'ready' && !timer.sent) {
      timer.sent = true;
      log('READY', JSON.stringify(st), 'ownerId=', client.ownerId, 'chats=', client.chats.size, 'contacts=', client.contacts.size);
      const to = arg('--to');
      if (to) {
        try { log('sendText →', await client.sendText({ text: arg('--text') || 'spike ' + Date.now(), phone: to })); } catch (e) { log('sendText ERR', e.status, e.message); }
        const file = arg('--file');
        if (file) { const tmp = path.join(dataDir, 'tmp-' + path.basename(file)); fs.copyFileSync(file, tmp); try { log('sendFile →', await client.sendFile({ filePath: tmp, fileName: path.basename(file), caption: 'spike file', type: /\.(jpe?g|png|webp)$/i.test(file) ? 'image' : 'document', phone: to })); } catch (e) { log('sendFile ERR', e.status, e.message); } }
      }
    }
    if (st.authState === 'error' || st.authState === 'logged_out') { log('STOP', st.authState, st.error); process.exit(0); }
  }, 2000);
  process.on('SIGINT', async () => { await client.close(); process.exit(0); });
})().catch(e => { log('FATAL', e.message); process.exit(1); });
```

- [ ] **Step 2: Прогнать с владельцем**

Run: `cd /root/loyalpro/gateway && node scripts/max-spike.js --to 79250177778` → переслать `/tmp/max-spike-qr.png` владельцу, он сканирует с +79200255591 (MAX → Профиль → Устройства → Подключить устройство). Затем с номера клиники 79250177778 написать текст и прислать фото и файл; с +79200255591 (телефон) набрать ответ руками; второй прогон с `--file /tmp/a.jpg`.

Записать в `docs/2026-10-XX-gateway-max-live-test.md` дословные строки лога: `HELLO`, строку «диалог …: участник …, XOR даёт …», `RAW` push 128 входящего и СВОЕГО с телефона (есть ли `sender === ownerId`, формат `attaches`), есть ли `phone` в `contacts` LOGIN и в ответе `CONTACT_INFO`, `WEBHOOK` входящего фото (`mime_type`), результат `sendText`/`sendFile` (ответ `MSG_SEND`, пришёл ли `NOTIF_ATTACH`), пришёл ли push на нашу же отправку.

- [ ] **Step 3: Сверить с планом**

Если XOR «НЕ совпадает» — `peerIdOf` остаётся на участниках, а для чатов вне снимка добавить запрос `CHAT_INFO {chatIds:[chatId]}` (op 48 → `{chats}`) в `emitMessage` перед XOR. Если номера собеседников не видны ни в LOGIN, ни в CONTACT_INFO — диалоги живут по `chat_id`, как Telegram со скрытым номером (ожидаемо, спека §3.3). Если свои сообщения с телефона push'ем НЕ приходят — пауза «ответил оператор» для MAX не работает: зафиксировать в спеке §6 и памяти. Если `NOTIF_ATTACH` не приходит — таймаут 60 с замедляет файлы: снизить `FILE_READY_TIMEOUT_MS` до 10 с.

- [ ] **Step 4: Сквозная проверка через админку**

На деве: `pm2 restart loyalpro-gateway && PORT=3001 pm2 restart loyalpro` → Настройки → Мессенджеры → «Подключить MAX напрямую» → владелец сканирует QR с +79200255591 → строка `ready`, канал `max` переключился на шлюз (`messenger_accounts`). Отправить из «Чата» текст и файл на 79250177778 (через transport → `/api/v1/delivery` шлюза), получить входящее с 79250177778, ответить с телефона +79200255591 руками → в `chatpush_messages` `authored_by='operator'` и пауза Милы (`agent_dialogs`). `pm2 restart loyalpro-gateway` → аккаунт снова `ready` без QR. Результаты — в тот же `docs/2026-10-XX-gateway-max-live-test.md`.

- [ ] **Step 5: Убрать сессию спайка и закоммитить**

```bash
cd /root/loyalpro && rm -rf gateway/data/spike-max && git add gateway/scripts/max-spike.js docs/2026-10-*-gateway-max-live-test.md && git commit -m "chore(gateway): спайк MAX — живая проверка протокола нашим клиентом + отчёт

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 12: Выкат на прод — 🟣 Fable, по шагам руками, с владельцем

- [ ] **Step 1:** `git log origin/main..feat/messenger-gateway` — только коммиты MAX поверх прода `ab8fa5f`; fast-forward `main`, `git push origin main`.
- [ ] **Step 2:** На проде (`ssh root@217.114.0.254`, `/root/loyalpro_new`): `git pull --ff-only`; зависимости шлюза — репетицией в соседнем каталоге и атомарным `mv` (как 13.10: `npm ci --omit=dev` рядом, проверить `require('ws')`, `require('@whiskeysockets/baileys')`, затем `mv`); `pm2 restart loyalpro` (миграций нет, но порядок тот же), затем `pm2 restart loyalpro-gateway`; `pm2 logs loyalpro-gateway --lines 50` — Telegram #8 и WhatsApp #9 снова `ready`.
- [ ] **Step 3:** Владелец в прод-админке: «Подключить MAX напрямую» → сканирует QR с ТЕЛЕФОНА КЛИНИКИ (+79250177778, MAX → Профиль → Устройства → Подключить устройство). Канал переключится на `ready`; проверить входящее и ответ из «Чата».
- [ ] **Step 4:** Выйти из MAX в кабинете Chatpush (сессия `max_session`), иначе две сессии и лишние сырые события. Откат — Настройки → Мессенджеры → «Сделать активным» у строки Chatpush `max` (перед этим снова войти в MAX в Chatpush).
- [ ] **Step 5:** Сутки наблюдать `pm2 logs loyalpro-gateway`, `agent_reply_deliveries`, число MAX-сообщений в `chatpush_messages` (норма 15–45/день); обновить память и `CLAUDE.md` фактами живого прогона.

## Что СОЗНАТЕЛЬНО не входит

- Видео и стикеры без файла; реакции, правки, удаления, звонки, опросы — не форвардятся (спека §6).
- Статусы «доставлено/прочитано» в `gateway_deliveries` (только 2/5).
- Добавление номера в контакты MAX при отправке (только поиск `CONTACT_INFO_BY_PHONE`).
- Мобильный бинарный протокол и фингерпринт устройства (SMS через Android-путь) — только веб-транспорт.
- Автоуведомления YClients (идут через Chatpush) — отдельный модуль уведомлений.

## Self-review

- Спека §2.1 (опкоды, кадр, HELLO/QR/SMS/LOGIN, отзыв токена, PING, push, чат, XOR, контакты, отправка, фото/файл, разлогин) → Tasks 0, 1, 4, 5, 6. §2.2 (свой клиент, `ws`, env `MAX_WEB_APP_VERSION`, лог HELLO) → Tasks 0, 1, 4. §3.1 транспорт → Task 1. §3.2 сессия/состояния/QR-раунды/номер/LOGIN/реконнект/logout → Tasks 3, 4. §3.3 входящие/фильтры/личка-группа/направление/контакты/медиа/очередь → Tasks 2, 5. §3.4 отправка/статусы/файлы/`attachment.not.ready` → Task 6. §3.5 бэкенд/сервер/фронт → Tasks 7, 8, 9. §4 данные (без миграций) → Task 7 (`phoneByUserId` поверх существующей таблицы). §5 переключение/откат → Task 12. §6 ограничения → «Что сознательно не входит» + Task 11 Step 3. §7 проверка → тесты в каждой задаче, контракт в Task 2, спайк и e2e в Task 11.
- Имена сверены между задачами: `MaxTransport` (`request/ack/close/isOpen`, события `push/close/error/raw`), `MaxServerError.code/serverMessage`, `session.load/save/remove/hasToken`, `media.download/uploadPhoto/uploadFile` и их сигнатуры, `mapper.xorId/peerIdOf/isGroupChat/isChannel/contentOf/tsSeconds/mimeOfName/buildWebhookBody`, `MaxClient` методы `start/connect/hello/beginQr/pollQr/handleTokenResponse/authStep/login/onLoggedOut/rememberContactInfo/onPush/onMessage/emitMessage/resolveContact/downloadToPublic/requireReady/nextCid/resolveChat/sendText/sendFile/waitFileReady/cancelFileWait/invokeSend/logout/close/status`, deps `Transport/session/media/http/qrToDataUrl/repo(setAuth, rememberContact, contactUserId, phoneByUserId)/deliveries/webhook/config/now/sleep/fileReadyTimeoutMs/maxMediaBytes`, `repo.phoneByUserId` (Task 7) используется в Task 5, `maxUserId` (Task 7) — в Task 6.
- Заглушек нет; каждый шаг с кодом содержит код; команды с ожидаемым результатом.
