# WhatsApp через свой шлюз (Baileys) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Подключить WhatsApp клиники к нашему шлюзу `gateway/` (как уже сделано с Telegram), чтобы входящие и исходящие WhatsApp шли напрямую через аккаунт салона, а Chatpush по этому каналу можно было отключить.

**Architecture:** Тот же процесс `gateway/` и тот же Chatpush-совместимый контракт. Новый класс `lib/whatsapp-client.js` (Baileys 6.7.24, сессия в `data/acc-<id>/wa`) с интерфейсом `TelegramClient`; `registry.js` выбирает класс по `messenger_accounts.channel`. Вебхук в бэкенд — вложенная WhatsApp-форма Chatpush (`whatsapp_incoming_msg` + `new_message`), которую `chatpush.envelope()` уже разбирает. Авторизация — QR (data-URL) или код привязки по номеру. Спека: `docs/superpowers/specs/2026-10-12-whatsapp-gateway-design.md`.

**Tech Stack:** Node 20/22, `@whiskeysockets/baileys@6.7.24` (точная версия), `qrcode`, `pino`, Express, PostgreSQL. Тесты: gateway и фронт — `node --test`, бэкенд — `npx jest <имя>`.

---

## Кто какую задачу делает (экономия токенов)

| Метка | Модель | Для чего |
|---|---|---|
| 🟡 **Haiku 4.5** | `model: haiku` | механика по точной инструкции: зависимости, колонка миграции, бамп `?v=`, документация |
| 🟢 **Sonnet 5.5** | `model: sonnet` | чистые модули и роуты с готовой спецификацией и тестами в плане |
| 🔵 **Opus 5.5** | `model: opus` | сложная интеграционная логика (клиент WhatsApp) и ревью этапов |
| 🟣 **Fable 5.1** | ведущая сессия | спайк на живом аккаунте, разбор расхождений с планом, живой e2e, выкат |

Порядок: Task 1 (🟣 спайк) **должен пройти до Task 5** — его результат либо подтверждает поля Baileys, на которые опирается план, либо меняет Task 4/5. Tasks 2–4 от спайка не зависят и идут параллельно с ним. После Tasks 2–6 — ревью 🔵 Opus (шлюз), после Tasks 7–8 — ревью 🔵 Opus (бэкенд/фронт). Исполнитель каждой задачи получает: эту шапку, раздел «Контекст», свою задачу целиком. Запуск субагента: `Agent({ subagent_type: 'general-purpose', model: '<из таблицы>', prompt })`.

---

## Контекст для исполнителя (прочитать целиком до первой задачи)

**Что уже есть.** Шлюз `gateway/` держит TDLib-сессии (`lib/telegram-client.js`) и говорит с бэкендом на контракте Chatpush: отправка `POST /api/v1/delivery?text&phone&dispatch_routing[]` с `Authorization: Bearer <messenger_accounts.token>` → `{meta:{status:'success'}, delivery:{id:'g12', channel, status:{status_id:1, description:'Принято'}}}`; файлы `POST /api/v1/send_file` (multipart `file`, query `file_name, caption, type, phone, dispatch_routing[]`); судьба `GET /api/v1/delivery/:id` (`status_id` 1/2/5). Внутренний API (`X-Gateway-Secret`): `POST /internal/accounts/:id/start`, `/auth` body `{phone}|{code}|{password}`, `GET /status`, `POST /logout`. События в бэкенд — `POST BACKEND_WEBHOOK_URL` (`/gateway/webhook?key=…`), повторы в `lib/webhook-sender.js`. Доставки — `lib/deliveries.js` (таблица `gateway_deliveries`, id наружу `g<n>`). Реестр — `lib/registry.js` (аккаунт → живой клиент, `startAllActive`). Строки аккаунтов — `lib/accounts-repo.js` (`messenger_accounts`, `gateway_contacts`). Сервер — `server.js` (`createApp(deps)` для тестов).

**Форма вебхука WhatsApp у Chatpush (живое событие из `chatpush_events` #25829)** — её разбирает `backend/services/chatpush.js envelope()` (ветка `payload.new_message`), `customer_id` берётся из `payload`:
```json
{"type":"whatsapp_incoming_msg","payload":{"customer_id":46594,"delivery_id":399368073,
 "new_message":{"chat_id":"79164340999@c.us","direction":"outgoing","chat_phone":"79164340999",
   "pushname":"PERI CLINIC","sender_name":null,
   "sender_phone_number":"79250177778","recipient_phone_number":"79164340999",
   "message":{"id":"true_46810865385627@lid_d399368073THISISBOT","text":"…","type":"text","timestamp":1791734126,"reply_to_message_id":null}}}}
```
У входящего `direction:'incoming'`, `sender_phone_number` = номер клиента, `recipient_phone_number` = наш. Медиа — `message.file_data:{download_url, mime_type, caption}`, `message.type` `image|document|voice|video|…`.

**Бэкенд про WhatsApp уже знает:** свои исходящие он персистит при отправке (`services/chat-persist.persistWhatsappOutgoing`, `external_message_id = 'api:<delivery_id>'`) и дедупит эхо в `routes/chatpush-webhook.js`; сторож доставки (`services/agent/delivery-watchdog.js`) считает доставку подтверждённой, если в `chatpush_events` есть событие с `payload->'payload'->>'delivery_id'`; группы — jid `@g.us` (`services/agent/group-chat.js`); получатель WhatsApp — только `phone` (`services/chat.recipientParams`).

**Baileys 6.7.24 — факты, проверенные на деве установкой в `/tmp/wa-spike`:** `const baileys = require('@whiskeysockets/baileys')`; `baileys.default === baileys.makeWASocket`; экспорты `useMultiFileAuthState, DisconnectReason ({loggedOut:401, restartRequired:515,…}), downloadMediaMessage, fetchLatestBaileysVersion, jidNormalizedUser, isJidGroup, isJidBroadcast, isJidStatusBroadcast, isJidNewsletter, isLidUser, getContentType, Browsers, WAMessageStatus ({ERROR:0,PENDING:1,SERVER_ACK:2,DELIVERY_ACK:3,READ:4,PLAYED:5})`. У входящего `msg.key = {remoteJid, fromMe, id, senderLid, senderPn, participant, participantPn, participantLid}` (`Utils/decode-wa-message.js`), `msg.pushName`, `msg.messageTimestamp` (число или Long с `.toNumber()`), `msg.message.<contentType>`. Свои отправки библиотека дублирует в `messages.upsert` с `type:'append'`. Событие `chats.phoneNumberShare {lid, jid}` приходит, когда собеседник раскрыл номер. `sock.requestPairingCode(phone)` → строка кода; `sock.onWhatsApp(phone)` → `[{jid, exists}]`; `sock.user.id` — свой jid вида `7925…:12@s.whatsapp.net`.

**Правила проекта (CLAUDE.md), которые нельзя нарушать:** миграции только `IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS`, никогда деструктивно; `db.one` НЕ бросает на пустой выборке; правка JS фронта — с бампом `?v=` в `frontend/index.html`; коммит на задачу, сообщение по-русски, в конце `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; рестарт бэкенда на деве `PORT=3001 pm2 restart loyalpro`, шлюза — `pm2 restart loyalpro-gateway`; SQL-проверки через MCP `mcp__postgres__query`.

**Расширение контракта шлюза этим планом:**
- `auth_state` получает значение `wait_qr` (WhatsApp). `GET /internal/accounts/:id/status` для WhatsApp отдаёт `{authState, phone, displayName, error, qr:<data-URL|null>, pairingCode:<string|null>}`.
- `POST /internal/accounts/:id/auth` body `{phone}` у WhatsApp = запрос кода привязки → `{authState:'wait_qr', pairingCode:'ABCDEFGH', error:null}`; `{code}`/`{password}` → `{authState, error:'не применимо к WhatsApp'}`.
- Ответ `accepted()` публичного API несёт `channel` строки аккаунта (`'whatsapp'`), а не константу `'tdlib'`.
- Тело вебхука WhatsApp — вложенная форма выше плюс `payload.provider:'gateway'`, `payload.customer_id = messenger_accounts.id`, `payload.delivery_id = 'g<n>' | null`.

---

## Структура файлов

**Шлюз (create):**
- `gateway/lib/media.js` — `EXT_BY_MIME`, `safeExt`, `MAX_MEDIA_BYTES`, `publicFileName` (вынос из `telegram-client.js`).
- `gateway/lib/wa-mapper.js` — чистые функции: jid ↔ телефон, `chatIdOf`, составной id, `contentOf`, `buildWebhookBody`. Тест `gateway/test/wa-mapper.test.js`.
- `gateway/lib/whatsapp-client.js` — класс `WhatsappClient` (Baileys), интерфейс как у `TelegramClient`. Тест `gateway/test/whatsapp-client.test.js`.
- `gateway/scripts/whatsapp-spike.js` — разовая живая проверка библиотеки.
- `backend/scripts/gateway-whatsapp-e2e.js` — живая сквозная проверка.

**Шлюз (modify):**
- `gateway/package.json` — зависимости.
- `gateway/lib/telegram-client.js` — медиа-хелперы через `./media`.
- `gateway/lib/deliveries.js` — `setProviderMessageId`, `findByProviderMessageId`.
- `gateway/lib/accounts-repo.js` — `listActive` оба канала, `phoneByLid`.
- `gateway/lib/registry.js` — класс по `account.channel`.
- `gateway/server.js` — `channel` в `accepted()`, `qr`/`pairingCode` в `/status`.

**Бэкенд (modify):**
- `backend/migrations.js` — колонка `gateway_deliveries.provider_message_id`, индексы.
- `backend/routes/messaging-accounts.js` — `createGatewayAccount(salonId, channel)`, `POST /accounts/whatsapp`.
- `backend/routes/chatpush-webhook.js` — дедуп эха WhatsApp по `msg.deliveryId`.

**Фронт (modify):**
- `frontend/js/pages/messaging-accounts.js`, `frontend/js/pages/messaging-accounts.test.js`, `frontend/index.html`.

**Документация:** `CLAUDE.md` (раздел про шлюз), `docs/2026-10-XX-gateway-whatsapp-live-test.md` (отчёт прогона).

---

## Часть A. Подготовка

### Task 0: Зависимости и схема — 🟡 Haiku

**Files:**
- Modify: `gateway/package.json`
- Modify: `backend/migrations.js` (после блока `gateway_contacts`, ≈ строка 1545)

- [ ] **Step 1: Добавить зависимости шлюза**

В `gateway/package.json` в `dependencies` добавить три строки (версия Baileys ТОЧНАЯ, без `^`):

```json
    "@whiskeysockets/baileys": "6.7.24",
    "pino": "^9.6.0",
    "qrcode": "^1.5.4",
```

и в `description` заменить «(Telegram через TDLib)» на «(Telegram через TDLib, WhatsApp через Baileys)».

- [ ] **Step 2: Установить**

Run: `cd /root/loyalpro/gateway && npm install 2>&1 | tail -3 && node -e "const b=require('@whiskeysockets/baileys'); console.log(typeof b.makeWASocket, typeof require('qrcode').toDataURL)"`
Expected: `function function`, без `ERR`.

- [ ] **Step 3: Миграция**

В `backend/migrations.js` сразу ПОСЛЕ `CREATE TABLE IF NOT EXISTS gateway_contacts (...)` (и его `.catch`) вставить:

```js
  // WhatsApp-шлюз (2026-10-12): id сообщения у Baileys строковый (key.id) —
  // связка «наша отправка → доставка» после рестарта, как tdlib_temp_id у TDLib.
  await client.query(`ALTER TABLE gateway_deliveries ADD COLUMN IF NOT EXISTS provider_message_id VARCHAR(64)`).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS gateway_deliveries_provider_msg_idx
      ON gateway_deliveries (account_id, provider_message_id) WHERE provider_message_id IS NOT NULL
  `).catch(() => {});
  // Обратный поиск LID → телефон (WhatsApp): user_id хранит числовую часть LID.
  await client.query(`
    CREATE INDEX IF NOT EXISTS gateway_contacts_user_idx ON gateway_contacts (account_id, user_id)
  `).catch(() => {});
```

- [ ] **Step 4: Прогнать миграцию на деве**

Run: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro && sleep 6 && pm2 logs loyalpro --lines 40 --nostream | grep -i "migrat" | tail -3`
Затем MCP `mcp__postgres__query`: `SELECT column_name FROM information_schema.columns WHERE table_name='gateway_deliveries' AND column_name='provider_message_id'` → одна строка.

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add gateway/package.json gateway/package-lock.json backend/migrations.js && git commit -m "chore(gateway): зависимости Baileys/qrcode/pino и колонка provider_message_id под WhatsApp

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 1: Спайк Baileys на живом аккаунте — 🟣 Fable (+ владелец сканирует QR)

**Files:**
- Create: `gateway/scripts/whatsapp-spike.js`

Цель — ДО написания клиента увидеть на реальном трафике: (1) форму `key` у входящего из LID-чата (`senderPn` заполнен?), (2) приходит ли `append`-апсерт своей отправки и с каким `key.id`, (3) `messages.update` со `status` для своей отправки, (4) `connection.update` после первого входа (ожидается close с 515 и реконнект), (5) `downloadMediaMessage` на входящем фото, (6) `onWhatsApp` для своего номера и для несуществующего, (7) работает ли `requestPairingCode`. Аккаунт — тестовый номер владельца (+79200255591, как в прогоне Telegram), НЕ номер клиники.

- [ ] **Step 1: Написать спайк**

```js
'use strict';
// Разовая живая проверка Baileys 6.7.24: QR/код привязки, форма входящих
// (LID → senderPn), эхо своих отправок, статусы, медиа, onWhatsApp.
//   node scripts/whatsapp-spike.js [--pair 79200255591] [--to 79250177778]
// Сессия — в data/spike-wa (удалить после спайка). НИЧЕГО не пишет в БД.
const path = require('path');
const fs = require('fs');
const baileys = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, Browsers, getContentType } = baileys;

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const dir = path.join(__dirname, '../data/spike-wa');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

(async () => {
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  let version; try { ({ version } = await fetchLatestBaileysVersion()); } catch (e) { log('fetchLatestBaileysVersion:', e.message); }
  const sock = makeWASocket({ auth: state, version, logger: pino({ level: 'silent' }), browser: Browsers.ubuntu('Chrome'), markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false });
  sock.ev.on('creds.update', saveCreds);
  let pairRequested = false;
  sock.ev.on('connection.update', async (u) => {
    const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
    log('connection.update', JSON.stringify({ connection: u.connection, code, hasQr: !!u.qr }));
    if (u.qr) {
      fs.writeFileSync('/tmp/wa-spike-qr.png', Buffer.from((await qrcode.toDataURL(u.qr)).split(',')[1], 'base64'));
      log('QR → /tmp/wa-spike-qr.png (scp и показать владельцу)');
      const pair = arg('--pair');
      if (pair && !pairRequested && !state.creds.registered) { pairRequested = true; log('pairing code:', await sock.requestPairingCode(pair)); }
    }
    if (u.connection === 'open') {
      log('OPEN user=', JSON.stringify(sock.user));
      const to = arg('--to');
      log('onWhatsApp(self)=', JSON.stringify(await sock.onWhatsApp(sock.user.id.split(':')[0].split('@')[0])));
      log('onWhatsApp(70000000000)=', JSON.stringify(await sock.onWhatsApp('70000000000')));
      if (to) {
        const sent = await sock.sendMessage(`${to}@s.whatsapp.net`, { text: 'spike ' + Date.now() });
        log('sent key=', JSON.stringify(sent.key), 'status=', sent.status);
      }
    }
    if (u.connection === 'close' && code === DisconnectReason.loggedOut) { log('LOGGED OUT'); process.exit(0); }
  });
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const m of messages) {
      const ct = getContentType(m.message || {});
      log('upsert', type, JSON.stringify({ key: m.key, pushName: m.pushName, ts: String(m.messageTimestamp), ct, text: m.message && (m.message.conversation || (m.message.extendedTextMessage || {}).text) }));
      if (type === 'notify' && !m.key.fromMe && /image|document|audio|video/.test(ct || '')) {
        const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }), reupload: sock.updateMediaMessage });
        log('media bytes=', buf.length, 'mimetype=', m.message[ct].mimetype);
      }
    }
  });
  sock.ev.on('messages.update', (ups) => log('messages.update', JSON.stringify(ups)));
  sock.ev.on('chats.phoneNumberShare', (e) => log('phoneNumberShare', JSON.stringify(e)));
})();
```

- [ ] **Step 2: Прогнать с владельцем**

Run: `cd /root/loyalpro/gateway && node scripts/whatsapp-spike.js --to 79250177778` → переслать `/tmp/wa-spike-qr.png` владельцу, он сканирует с +79200255591 («Связанные устройства»). Затем с номера клиники 79250177778 написать текст и прислать фото; с +79200255591 (телефон) набрать ответ руками. Второй прогон — `--pair 79200255591` на свежем каталоге (`rm -rf data/spike-wa`) для проверки кода привязки.

Записать в `docs/2026-10-XX-gateway-whatsapp-live-test.md` (раздел «Спайк») дословные строки лога: форму `key` входящего (есть ли `senderPn` и `remoteJid` вида `@lid`), `upsert append` своей отправки, `messages.update` статусы, код закрытия после первого входа, медиа.

- [ ] **Step 3: Сверить с планом**

Если `senderPn` у LID-входящих ПУСТ — Task 4 получает дополнительный источник телефона (`chats.phoneNumberShare` + кэш) как ЕДИНСТВЕННЫЙ, и это надо пометить в спеке §3. Если `append`-апсерт своей отправки НЕ приходит — ничего не меняется (эхо синтезируется). Если `messages.update` со статусом ≥2 не приходит — в Task 5 `SENT` ставится сразу после успешного `sendMessage` (см. комментарий в коде `onSendAck`).

- [ ] **Step 4: Убрать сессию спайка и закоммитить скрипт**

```bash
cd /root/loyalpro && rm -rf gateway/data/spike-wa && git add gateway/scripts/whatsapp-spike.js && git commit -m "chore(gateway): спайк Baileys — живая проверка формы событий WhatsApp

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Часть B. Шлюз

### Task 2: Общий модуль медиа `lib/media.js` — 🟢 Sonnet

**Files:**
- Create: `gateway/lib/media.js`
- Modify: `gateway/lib/telegram-client.js:36-60` (определения `MAX_MEDIA_BYTES`, `EXT_BY_MIME`, `safeExt`)
- Test: `gateway/test/media.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { safeExt, publicFileName, EXT_BY_MIME, MAX_MEDIA_BYTES } = require('../lib/media');
const tg = require('../lib/telegram-client');

test('safeExt: только белый список по MIME, неизвестное → .bin', () => {
  assert.equal(safeExt('image/jpeg'), '.jpg');
  assert.equal(safeExt('IMAGE/PNG; charset=x'), '.png');
  assert.equal(safeExt('text/html'), '.bin');
  assert.equal(safeExt(undefined), '.bin');
});
test('publicFileName: <ts>_<16hex><ext>', () => {
  assert.match(publicFileName('audio/ogg', 1700000000000), /^1700000000000_[0-9a-f]{16}\.ogg$/);
});
test('telegram-client реэкспортирует те же объекты', () => {
  assert.equal(tg.safeExt, safeExt);
  assert.equal(tg.EXT_BY_MIME, EXT_BY_MIME);
  assert.equal(tg.MAX_MEDIA_BYTES, MAX_MEDIA_BYTES);
});
```

- [ ] **Step 2: Запустить — падает** `cd /root/loyalpro/gateway && node --test test/media.test.js` → `Cannot find module '../lib/media'`.

- [ ] **Step 3: Создать `gateway/lib/media.js`**

```js
'use strict';
// Общее для всех клиентов шлюза: расширение файла — ТОЛЬКО из белого списка
// по MIME (имя задаёт собеседник, а каталог отдаётся статикой в origin админки —
// .html/.svg были бы stored XSS), кап размера, имя в публичном каталоге.
const crypto = require('crypto');

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'application/pdf': '.pdf',
  'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a',
  'video/mp4': '.mp4', 'video/quicktime': '.mov',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/plain': '.txt',
};

function safeExt(mimeType) {
  return EXT_BY_MIME[String(mimeType || '').toLowerCase().split(';')[0].trim()] || '.bin';
}

function publicFileName(mimeType, now = Date.now()) {
  return `${now}_${crypto.randomBytes(8).toString('hex')}${safeExt(mimeType)}`;
}

module.exports = { MAX_MEDIA_BYTES, EXT_BY_MIME, safeExt, publicFileName };
```

- [ ] **Step 4: Переключить `telegram-client.js` на общий модуль**

Удалить из `telegram-client.js` строки `const MAX_MEDIA_BYTES = 20 * 1024 * 1024;`, весь блок `const EXT_BY_MIME = {…};` и функцию `safeExt`, а на их место поставить:

```js
const { MAX_MEDIA_BYTES, EXT_BY_MIME, safeExt, publicFileName } = require('./media');
```

В `downloadToPublic` строку ``const name = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${safeExt(file.mimeType)}`;`` заменить на `const name = publicFileName(file.mimeType);`. Экспорт в конце файла оставить (`safeExt, EXT_BY_MIME, MAX_MEDIA_BYTES` по-прежнему экспортируются — `server.js` их импортирует оттуда).

- [ ] **Step 5: Все тесты шлюза зелёные** `node --test` → `fail 0` (было 77 тестов, станет 80).

- [ ] **Step 6: Коммит**

```bash
cd /root/loyalpro && git add gateway/lib/media.js gateway/lib/telegram-client.js gateway/test/media.test.js && git commit -m "refactor(gateway): медиа-хелперы в общий lib/media.js

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 3: Чистый маппер `lib/wa-mapper.js` — 🟢 Sonnet

**Files:**
- Create: `gateway/lib/wa-mapper.js`
- Test: `gateway/test/wa-mapper.test.js`

- [ ] **Step 1: Тест**

```js
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
```

- [ ] **Step 2: Запустить — падает** `node --test test/wa-mapper.test.js`.

- [ ] **Step 3: Реализация `gateway/lib/wa-mapper.js`**

```js
'use strict';
// ============================================================
// WA-mapper — чистые функции без Baileys/БД/HTTP: сообщение Baileys → тело
// вебхука во ВЛОЖЕННОЙ WhatsApp-форме Chatpush (её разбирает
// backend/services/chatpush.js envelope(), ветка payload.new_message), jid ↔
// телефон, составные id, типы контента, статусы доставки.
// Телефон собеседника — цепочкой: remoteJid вида @s.whatsapp.net → key.senderPn
// (личка в LID-чате) / key.participantPn (группа) → кэш LID→телефон
// (gateway_contacts) → null (диалог живёт по chat_id '<lid>@lid').
// ============================================================
const { normalizePhone } = require('./mapper');

const PN_RE = /^(\d+)(?::\d+)?@(?:s\.whatsapp\.net|c\.us)$/;
const LID_RE = /^(\d+)(?::\d+)?@lid$/;

function phoneOfJid(jid) {
  const mm = PN_RE.exec(String(jid || ''));
  return mm ? normalizePhone(mm[1]) : null;
}
function lidOfJid(jid) {
  const mm = LID_RE.exec(String(jid || ''));
  return mm ? mm[1] : null;
}
function isGroupJid(jid) { return /@g\.us$/.test(String(jid || '')); }
function isSkippedJid(jid) { return /@(broadcast|newsletter)$/.test(String(jid || '')); }

// lookup(lid) → телефон из кэша или null (синхронно: вызывающий заранее читает БД).
function peerPhone(key, lookup) {
  const k = key || {};
  if (isGroupJid(k.remoteJid)) {
    return phoneOfJid(k.participantPn) || phoneOfJid(k.participant) || lookup(lidOfJid(k.participant)) || null;
  }
  return phoneOfJid(k.remoteJid) || phoneOfJid(k.senderPn) || lookup(lidOfJid(k.remoteJid)) || null;
}

// chat_id как у Chatpush: личный с известным номером — '<phone>@c.us'
// (backend/services/agent/group-chat.js считает такой личным), группа — jid как
// есть, личный без номера — '<lid>@lid'.
function chatIdOf(remoteJid, phone) {
  if (isGroupJid(remoteJid)) return String(remoteJid);
  if (phone) return `${phone}@c.us`;
  return String(remoteJid || '');
}

// key.id у WhatsApp уникален только вместе с чатом → наружу составной id в духе
// Chatpush ('true_<lid>_<id>'). Пробелов и '_' в jid/id нет: '_' — разделитель.
function compositeId(key) { return `${key.fromMe ? 'true' : 'false'}_${key.remoteJid}_${key.id}`; }
function parseCompositeId(s) {
  const mm = /^(true|false)_([^_\s]+)_([A-Za-z0-9-]+)$/.exec(String(s || ''));
  return mm ? { fromMe: mm[1] === 'true', remoteJid: mm[2], id: mm[3] } : null;
}

const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'editedMessage'];
const SKIP = new Set(['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'pollUpdateMessage', 'keepInChatMessage']);

function unwrap(message) {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    const w = WRAPPERS.find(k => m[k] && m[k].message);
    if (!w) break;
    m = m[w].message;
  }
  return m;
}

// → {type, text, media:{contentType, mimeType, fileName, size}|null} | null (служебное/пусто).
function contentOf(message) {
  const m = unwrap(message);
  if (!m || typeof m !== 'object') return null;
  const keys = Object.keys(m).filter(k => !SKIP.has(k));
  if (m.conversation !== undefined) return { type: 'text', text: String(m.conversation || ''), media: null };
  if (m.extendedTextMessage) return { type: 'text', text: String(m.extendedTextMessage.text || ''), media: null };
  const ct = keys.find(k => /Message$/.test(k) && m[k] && typeof m[k] === 'object');
  if (!ct) return null;
  const c = m[ct];
  const mediaOf = (mime, fileName) => ({ contentType: ct, mimeType: String(mime || '').split(';')[0].trim() || 'application/octet-stream', fileName: fileName || null, size: Number(c.fileLength || 0) });
  switch (ct) {
    case 'imageMessage':    return { type: 'image', text: String(c.caption || ''), media: mediaOf(c.mimetype || 'image/jpeg') };
    case 'documentMessage': return { type: 'document', text: String(c.caption || ''), media: mediaOf(c.mimetype, c.fileName) };
    case 'audioMessage':    return { type: c.ptt ? 'voice' : 'audio', text: '', media: mediaOf(c.mimetype || 'audio/ogg') };
    case 'videoMessage':    return { type: 'video', text: String(c.caption || ''), media: mediaOf(c.mimetype || 'video/mp4') };
    case 'stickerMessage':  return { type: 'sticker', text: '', media: null };
    default:                return { type: ct.replace(/Message$/, '').toLowerCase(), text: '', media: null };
  }
}

function tsOf(ts) {
  if (ts === undefined || ts === null) return null;
  if (typeof ts === 'object' && typeof ts.toNumber === 'function') return ts.toNumber();
  const n = Number(ts);
  return Number.isFinite(n) ? n : null;
}

/**
 * Тело вебхука во вложенной форме. Номера строго по стороне клиента, как ждёт
 * envelope(): у incoming клиент в sender_phone_number, у outgoing — в
 * recipient_phone_number; наш номер — на второй стороне. У исходящего в
 * группе единственного получателя нет → recipient null.
 */
function buildWebhookBody({ accountId, ownPhone, msg, peerPhone: phone, deliveryId, fileUrl }) {
  const key = msg.key || {};
  const outgoing = !!key.fromMe;
  const group = isGroupJid(key.remoteJid);
  const content = contentOf(msg.message) || { type: 'unsupported', text: '', media: null };
  const message = {
    id: compositeId(key),
    type: content.type,
    text: content.text,
    timestamp: tsOf(msg.messageTimestamp),
    reply_to_message_id: null,
  };
  if (content.media && fileUrl) message.file_data = { download_url: fileUrl, mime_type: content.media.mimeType, caption: content.text };
  return {
    type: 'whatsapp_incoming_msg',
    payload: {
      provider: 'gateway',
      customer_id: accountId,
      instance_id: accountId,
      delivery_id: deliveryId || null,
      new_message: {
        direction: outgoing ? 'outgoing' : 'incoming',
        chat_id: chatIdOf(key.remoteJid, group ? null : phone),
        chat_type: group ? 'group' : 'person',
        chat_phone: group ? null : (phone || null),
        sender_phone_number: outgoing ? (ownPhone || null) : (phone || null),
        recipient_phone_number: outgoing ? (group ? null : (phone || null)) : (ownPhone || null),
        pushname: outgoing ? null : (msg.pushName || null),
        sender_name: outgoing ? null : (msg.pushName || null),
        message,
      },
    },
  };
}

function deliveryStatus(row) {
  return { id: `g${row.id}`, status: { status_id: Number(row.status_id), description: row.description }, error: row.error || null };
}

module.exports = { phoneOfJid, lidOfJid, isGroupJid, isSkippedJid, peerPhone, chatIdOf, compositeId, parseCompositeId, contentOf, tsOf, buildWebhookBody, deliveryStatus };
```

- [ ] **Step 4: Тест зелёный** `node --test test/wa-mapper.test.js` → `fail 0`.

- [ ] **Step 5: Контрактный тест с парсером бэкенда** — добавить в `gateway/test/mapper-contract.test.js` (в конец файла, тем же способом, каким файл грузит `backend/services/chatpush.js`):

```js
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
```
(`chatpush` в этом файле уже объявлен — посмотреть первые строки файла и использовать ту же переменную.)

- [ ] **Step 6: Коммит**

```bash
cd /root/loyalpro && git add gateway/lib/wa-mapper.js gateway/test/wa-mapper.test.js gateway/test/mapper-contract.test.js && git commit -m "feat(gateway): чистый маппер WhatsApp — jid/телефон, составной id, тело вебхука в форме Chatpush

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 4: Доставки и репозиторий под WhatsApp — 🟢 Sonnet

**Files:**
- Modify: `gateway/lib/deliveries.js`
- Modify: `gateway/lib/accounts-repo.js`
- Test: `gateway/test/deliveries.test.js`, `gateway/test/accounts-repo.test.js` (create)

- [ ] **Step 1: Тесты**

В `gateway/test/deliveries.test.js` добавить (используя уже существующий в файле фейковый `db`, который записывает `calls`):

```js
test('setProviderMessageId / findByProviderMessageId: связка по строковому id Baileys', async () => {
  const calls = [];
  const db = { query: async (sql, p) => { calls.push([sql, p]); return { rowCount: 1 }; }, oneOrNone: async (sql, p) => { calls.push([sql, p]); return { id: 7 }; } };
  const d = makeDeliveries(db);
  await d.setProviderMessageId(7, '3EB0ABC');
  assert.match(calls[0][0], /SET provider_message_id=\$2/);
  assert.deepEqual(calls[0][1], [7, '3EB0ABC']);
  assert.equal(await d.findByProviderMessageId(9, '3EB0ABC'), 7);
  assert.match(calls[1][0], /provider_message_id=\$2/);
  assert.equal(calls[1][1][0], 9);
});
```

Создать `gateway/test/accounts-repo.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
// accounts-repo тянет ../db (пул Postgres) — подменяем через кэш require.
const dbPath = require.resolve('../db');
const calls = [];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { db: {
  oneOrNone: async (sql, p) => { calls.push([sql, p]); return sql.includes('gateway_contacts') ? { phone: '79001112233' } : null; },
  any: async (sql, p) => { calls.push([sql, p]); return []; },
  query: async (sql, p) => { calls.push([sql, p]); },
} } };
const repo = require('../lib/accounts-repo');

test('listActive: оба канала шлюза, статусы active|pending', async () => {
  await repo.listActive();
  assert.match(calls.at(-1)[0], /channel IN \('tdlib','whatsapp'\)/);
  assert.match(calls.at(-1)[0], /status IN \('active','pending'\)/);
});
test('phoneByLid: ищет в gateway_contacts по account_id и user_id', async () => {
  assert.equal(await repo.phoneByLid(9, '46810865385627'), '79001112233');
  assert.match(calls.at(-1)[0], /FROM gateway_contacts WHERE account_id=\$1 AND user_id=\$2/);
  assert.deepEqual(calls.at(-1)[1], [9, '46810865385627']);
});
test('phoneByLid: пустой lid → null без запроса', async () => {
  const n = calls.length;
  assert.equal(await repo.phoneByLid(9, null), null);
  assert.equal(calls.length, n);
});
```

- [ ] **Step 2: Запустить — падают** `node --test test/deliveries.test.js test/accounts-repo.test.js`.

- [ ] **Step 3: Реализация**

В `gateway/lib/deliveries.js` внутри `makeDeliveries` после `findByTempId` добавить:

```js
  // WhatsApp: id сообщения строковый (key.id) — та же роль, что у tdlib_temp_id.
  async function setProviderMessageId(id, providerMessageId) {
    await db.query(`UPDATE gateway_deliveries SET provider_message_id=$2, updated_at=NOW() WHERE id=$1`, [id, providerMessageId]);
  }
  async function findByProviderMessageId(accountId, providerMessageId) {
    const r = await db.oneOrNone(
      `SELECT id FROM gateway_deliveries
        WHERE account_id=$1 AND provider_message_id=$2
          AND (status_id=$3 OR (status_id=$4 AND error=$5))
        ORDER BY id DESC LIMIT 1`,
      [accountId, providerMessageId, STATUS.ACCEPTED[0], STATUS.FAILED[0], STALE_REASON]);
    return r ? Number(r.id) : null;
  }
```
добавить их в `return { … }` и в `module.exports` (две строки-обёртки по образцу `setTempId`/`findByTempId`).

В `gateway/lib/accounts-repo.js`:

```js
async function listActive() {
  return db.any(`SELECT * FROM messenger_accounts WHERE provider='gateway' AND channel IN ('tdlib','whatsapp') AND status IN ('active','pending') ORDER BY id`);
}

// WhatsApp: LID → телефон (user_id хранит числовую часть LID, см. миграцию).
async function phoneByLid(accountId, lid) {
  if (!lid) return null;
  const r = await db.oneOrNone(`SELECT phone FROM gateway_contacts WHERE account_id=$1 AND user_id=$2`, [accountId, lid]);
  return r ? r.phone : null;
}
```
и `phoneByLid` в `module.exports`.

- [ ] **Step 4: Все тесты шлюза зелёные** `node --test` → `fail 0`.

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add gateway/lib/deliveries.js gateway/lib/accounts-repo.js gateway/test/deliveries.test.js gateway/test/accounts-repo.test.js && git commit -m "feat(gateway): доставки по строковому id сообщения и поиск телефона по LID

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 5: Клиент WhatsApp `lib/whatsapp-client.js` — 🔵 Opus (после Task 1)

**Files:**
- Create: `gateway/lib/whatsapp-client.js`
- Test: `gateway/test/whatsapp-client.test.js`

Интерфейс ОБЯЗАН совпадать с `TelegramClient` там, где его зовут `server.js`/`registry.js`: конструктор `(account, deps)`, `start()`, `authStep(step)`, `status()`, `sendText({text, phone})`, `sendFile({filePath, fileName, caption, type, phone})`, `logout()`, `close()`, поля `id`, `authState`, статический `dirsFor(config, id)`. Зависимости инжектятся через `deps` ради тестов без сети.

- [ ] **Step 1: Тест**

```js
'use strict';
// WhatsappClient без Baileys: фейковый сокет с ev-эмиттером. Проверяем автомат
// соединения, QR/код привязки, фильтры входящих, эхо своей отправки с
// delivery_id и дедуп append-апсерта, статусы, отправку по номеру.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { WhatsappClient, MAX_MESSAGE_AGE_S } = require('../lib/whatsapp-client');

function fakeSock(over = {}) {
  const ev = new EventEmitter();
  const calls = [];
  return {
    ev, calls,
    user: { id: '79250177778:12@s.whatsapp.net', name: 'Клиника' },
    authState: { creds: { registered: false } },
    async sendMessage(jid, content) { calls.push(['sendMessage', jid, content]); return { key: { remoteJid: jid, fromMe: true, id: 'OUT1' }, message: content.text !== undefined ? { conversation: content.text } : { imageMessage: { caption: content.caption || '', mimetype: 'image/jpeg' } }, messageTimestamp: 1700000100 }; },
    async onWhatsApp(p) { calls.push(['onWhatsApp', p]); return [{ jid: `${p}@s.whatsapp.net`, exists: p !== '70000000000' }]; },
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
    },
    deliveries: {
      STATUS: { ACCEPTED: [1, 'Принято'], SENT: [2, 'Отправлено'], FAILED: [5, 'Невозможно доставить'] },
      create: async (row) => { delCalls.push(['create', row]); return 12; },
      setStatus: async (...a) => { delCalls.push(['setStatus', ...a]); },
      setProviderMessageId: async (...a) => { delCalls.push(['setProviderMessageId', ...a]); },
      findByProviderMessageId: async () => null,
      failStale: async () => 0,
    },
    webhook: { sendSafe: async (b) => { hooks.push(b); } },
    now: () => 1_700_000_000_000,
    sleep: async () => {},
  };
  const wa = new WhatsappClient({ id: 42, phone: null }, deps);
  return { wa, sock, repoCalls, delCalls, hooks, tmp };
}
const tick = () => new Promise(r => setImmediate(r));
async function open(wa, sock) { await wa.start(); sock.ev.emit('connection.update', { connection: 'open' }); await tick(); await tick(); }

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
  await tick(); await tick();
  assert.equal(wa.authState, 'wait_qr');
  assert.match(wa.status().qr, /^data:image\/png;base64,/);
  assert.ok(repoCalls.some(c => c[2] === 'wait_qr'));
  sock.ev.emit('connection.update', { connection: 'open' });
  await tick(); await tick();
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
});

test('close loggedOut → logged_out, каталог удалён, реконнекта нет; close иначе → реконнект', async () => {
  let created = 0;
  const { wa, sock, repoCalls, tmp } = setup();
  wa.d.createSocket = async () => { created++; return { sock, saveCreds: async () => {} }; };
  await wa.start();
  sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await tick(); await tick(); await tick();
  assert.equal(created, 2);
  sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await tick(); await tick(); await tick();
  assert.equal(wa.authState, 'logged_out');
  assert.equal(created, 2);
  assert.ok(!fs.existsSync(path.join(tmp, 'acc-42', 'wa')));
  assert.ok(repoCalls.some(c => c[2] === 'logged_out'));
});

test('входящее notify из LID-чата: вебхук с номером из senderPn, LID запомнен в кэше', async () => {
  const { wa, sock, hooks, repoCalls } = setup();
  await open(wa, sock);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '46810865385627@lid', fromMe: false, id: 'IN1', senderPn: '79001112233@s.whatsapp.net', senderLid: '46810865385627@lid' }, pushName: 'Иван', messageTimestamp: 1_700_000_000, message: { conversation: 'Привет' } }] });
  await tick(); await tick(); await tick();
  assert.equal(hooks.length, 1);
  const nm = hooks[0].payload.new_message;
  assert.equal(nm.direction, 'incoming');
  assert.equal(nm.chat_phone, '79001112233');
  assert.equal(nm.chat_id, '79001112233@c.us');
  assert.equal(hooks[0].payload.customer_id, 42);
  assert.deepEqual(repoCalls.find(c => c[0] === 'rememberContact'), ['rememberContact', 42, '79001112233', '46810865385627']);
});

test('фильтры: не notify, старше 6 ч, status@broadcast, служебное — в бэкенд не идут', async () => {
  const { wa, sock, hooks } = setup();
  await open(wa, sock);
  const base = (o) => ({ key: { remoteJid: '79001112233@s.whatsapp.net', fromMe: false, id: 'F' + Math.random() }, messageTimestamp: 1_700_000_000, message: { conversation: 'x' }, ...o });
  sock.ev.emit('messages.upsert', { type: 'append', messages: [base({})] });
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [base({ messageTimestamp: 1_700_000_000 - MAX_MESSAGE_AGE_S - 1 })] });
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [base({ key: { remoteJid: 'status@broadcast', fromMe: false, id: 'S' } })] });
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [base({ message: { protocolMessage: {} } })] });
  await tick(); await tick(); await tick();
  assert.equal(hooks.length, 0);
});

test('входящее фото в личке → файл в публичном каталоге с расширением по MIME, file_data в вебхуке', async () => {
  const { wa, sock, hooks, tmp } = setup();
  await open(wa, sock);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '79001112233@s.whatsapp.net', fromMe: false, id: 'P1' }, messageTimestamp: 1_700_000_000, message: { imageMessage: { caption: 'фото', mimetype: 'image/jpeg', fileLength: 8 } } }] });
  await tick(); await tick(); await tick();
  const fd = hooks[0].payload.new_message.message.file_data;
  assert.match(fd.download_url, /^\/uploads\/gateway\/42\/\d+_[0-9a-f]{16}\.jpg$/);
  assert.ok(fs.existsSync(path.join(tmp, 'pub', '42', path.basename(fd.download_url))));
  assert.equal(fd.mime_type, 'image/jpeg');
});

test('sendText: onWhatsApp → sendMessage в <phone>@s.whatsapp.net, доставка g12, эхо с delivery_id, append того же id пропущен, SERVER_ACK → Отправлено', async () => {
  const { wa, sock, hooks, delCalls } = setup();
  await open(wa, sock);
  const id = await wa.sendText({ text: 'Здравствуйте', phone: '+7 (900) 111-22-33' });
  assert.equal(id, 12);
  assert.deepEqual(sock.calls.filter(c => c[0] !== 'onWhatsApp').at(-1), ['sendMessage', '79001112233@s.whatsapp.net', { text: 'Здравствуйте' }]);
  await tick(); await tick();
  assert.deepEqual(delCalls.find(c => c[0] === 'setProviderMessageId'), ['setProviderMessageId', 12, 'OUT1']);
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].payload.delivery_id, 'g12');
  assert.equal(hooks[0].payload.new_message.direction, 'outgoing');
  assert.equal(hooks[0].payload.new_message.recipient_phone_number, '79001112233');
  sock.ev.emit('messages.upsert', { type: 'append', messages: [{ key: { remoteJid: '79001112233@s.whatsapp.net', fromMe: true, id: 'OUT1' }, messageTimestamp: 1_700_000_100, message: { conversation: 'Здравствуйте' } }] });
  await tick(); await tick();
  assert.equal(hooks.length, 1);
  sock.ev.emit('messages.update', [{ key: { remoteJid: '79001112233@s.whatsapp.net', fromMe: true, id: 'OUT1' }, update: { status: 2 } }]);
  await tick(); await tick();
  assert.deepEqual(delCalls.at(-1), ['setStatus', 12, [2, 'Отправлено'], { providerMessageId: 'OUT1' }]);
});

test('sendText: номер не в WhatsApp → 422; аккаунт не ready → 422; ошибка onWhatsApp → шлём всё равно', async () => {
  const { wa, sock } = setup();
  await assert.rejects(() => wa.sendText({ text: 'x', phone: '79001112233' }), e => e.status === 422);
  await open(wa, sock);
  await assert.rejects(() => wa.sendText({ text: 'x', phone: '70000000000' }), e => e.status === 422 && /не в WhatsApp/.test(e.message));
  sock.onWhatsApp = async () => { throw new Error('usync timeout'); };
  assert.equal(await wa.sendText({ text: 'x', phone: '79001112233' }), 12);
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
  await tick(); await tick(); await tick();
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].payload.delivery_id, null);
  assert.equal(hooks[0].payload.new_message.direction, 'outgoing');
});

test('sendFile: image → {image, caption}, документ → {document, mimetype, fileName}; временный файл удалён', async () => {
  const { wa, sock, tmp } = setup();
  await open(wa, sock);
  const f = path.join(tmp, 'pic.jpg'); fs.writeFileSync(f, 'IMG');
  await wa.sendFile({ filePath: f, fileName: 'pic.jpg', caption: 'подпись', type: 'image', phone: '79001112233', mimeType: 'image/jpeg' });
  const c = sock.calls.filter(x => x[0] === 'sendMessage').at(-1)[2];
  assert.ok(Buffer.isBuffer(c.image)); assert.equal(c.caption, 'подпись');
  assert.ok(!fs.existsSync(f));
  const d = path.join(tmp, 'doc.pdf'); fs.writeFileSync(d, 'PDF');
  await wa.sendFile({ filePath: d, fileName: 'doc.pdf', caption: '', type: 'document', phone: '79001112233', mimeType: 'application/pdf' });
  const c2 = sock.calls.filter(x => x[0] === 'sendMessage').at(-1)[2];
  assert.ok(Buffer.isBuffer(c2.document)); assert.equal(c2.mimetype, 'application/pdf'); assert.equal(c2.fileName, 'doc.pdf');
});

test('logout: sock.logout, каталог удалён, logged_out', async () => {
  const { wa, sock, repoCalls, tmp } = setup();
  await open(wa, sock);
  await wa.logout();
  assert.ok(sock.calls.some(c => c[0] === 'logout'));
  assert.ok(!fs.existsSync(path.join(tmp, 'acc-42', 'wa')));
  assert.deepEqual(repoCalls.at(-1), ['setAuth', 42, 'logged_out']);
});
```

- [ ] **Step 2: Запустить — падает** `node --test test/whatsapp-client.test.js`.

- [ ] **Step 3: Реализация `gateway/lib/whatsapp-client.js`**

```js
'use strict';
// ============================================================
// WhatsappClient — один сокет Baileys = один аккаунт (строка messenger_accounts,
// channel='whatsapp'). Интерфейс тот же, что у TelegramClient (server.js и
// registry.js зовут оба одинаково).
// Авторизация: QR (data-URL в status().qr, Baileys обновляет его сам) или код
// привязки по номеру (authStep({phone}) → requestPairingCode). Сессия —
// useMultiFileAuthState в data/acc-<id>/wa, переживает рестарт.
// Соединение: close с loggedOut (401) — разлогин, каталог удаляем, не
// переподключаемся; любая другая причина — реконнект с бэкоффом 2 с → 60 с
// (515 restartRequired после первого входа — штатно).
// Входящие: только messages.upsert type='notify'; свои отправки Baileys
// дублирует type='append' — пропускаем по key.id из pendingSends, а эхо
// синтезируем САМИ из результата sendMessage (не зависим от библиотеки).
// fromMe notify БЕЗ нашей доставки = администратор набрал на телефоне → эхо
// без delivery_id → бэкенд ставит паузу «ответил оператор».
// Телефон собеседника — wa-mapper.peerPhone (remoteJid → senderPn → кэш LID).
// Статусы: messages.update status>=SERVER_ACK → «Отправлено»; sendMessage
// бросил → «Невозможно доставить». Старше MAX_MESSAGE_AGE_S, статусы-истории,
// рассылки, каналы, группы без медиа — как у Telegram.
// Зависимости инжектятся (deps) — тесты без Baileys.
// ============================================================
const fs = require('fs');
const path = require('path');
const mapper = require('./wa-mapper');
const { normalizePhone } = require('./mapper');
const { MAX_MEDIA_BYTES, publicFileName } = require('./media');
const { createLogger } = require('../logger');

const MAX_MESSAGE_AGE_S = 6 * 60 * 60;
const EXISTS_TTL_MS = 24 * 60 * 60 * 1000;
const RECONNECT_MS = [2000, 5000, 10000, 30000, 60000];
const SERVER_ACK = 2;

let baileysMod = null;
function baileys() { if (!baileysMod) baileysMod = require('@whiskeysockets/baileys'); return baileysMod; }

async function defaultCreateSocket(authDir) {
  const b = baileys();
  const pino = require('pino');
  const { state, saveCreds } = await b.useMultiFileAuthState(authDir);
  let version;
  try { ({ version } = await b.fetchLatestBaileysVersion()); } catch (_) { /* версия из пакета */ }
  const sock = b.makeWASocket({
    auth: state, version,
    logger: pino({ level: 'silent' }),
    browser: b.Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    generateHighQualityLinkPreview: false,
  });
  return { sock, saveCreds };
}

function defaultDownloadMedia(msg) {
  const b = baileys();
  const pino = require('pino');
  return b.downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
}

function defaultDeps() {
  return {
    createSocket: defaultCreateSocket,
    qrToDataUrl: (s) => require('qrcode').toDataURL(s, { margin: 1, width: 320 }),
    downloadMedia: defaultDownloadMedia,
    repo: require('./accounts-repo'),
    deliveries: require('./deliveries'),
    webhook: require('./webhook-sender'),
    config: require('../config'),
    now: () => Date.now(),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  };
}

function httpError(message, status) { return Object.assign(new Error(message), { status }); }
function disconnectCode(u) {
  const e = u && u.lastDisconnect && u.lastDisconnect.error;
  return e && e.output && e.output.statusCode;
}

class WhatsappClient {
  constructor(account, deps = {}) {
    this.d = { ...defaultDeps(), ...deps };
    this.account = account;
    this.id = account.id;
    this.log = createLogger(`WA#${account.id}`);
    this.authState = 'starting';
    this.lastAuthError = null;
    this.ownPhone = normalizePhone(account.phone);
    this.displayName = null;
    this.qr = null;
    this.pairingCode = null;
    this.sock = null;
    this.saveCreds = null;
    this.closed = false;
    this.reconnects = 0;
    this.pendingSends = new Map();   // key.id → delivery id
    this.existsCache = new Map();    // phone → ts (onWhatsApp exists=true)
    this.chatQueues = new Map();
  }

  static dirsFor(config, id) {
    const base = path.join(config.DATA_DIR, `acc-${id}`);
    return { wa: path.join(base, 'wa'), base };
  }
  dirs() { return WhatsappClient.dirsFor(this.d.config, this.id); }

  async start() {
    const dirs = this.dirs();
    fs.mkdirSync(dirs.wa, { recursive: true });
    await this.d.repo.setAuth(this.id, 'starting');
    await this.connect();
    this.log.info('клиент запущен');
  }

  async connect() {
    if (this.closed) return;
    const { sock, saveCreds } = await this.d.createSocket(this.dirs().wa);
    this.sock = sock; this.saveCreds = saveCreds;
    const guard = (fn) => (...a) => fn.apply(this, a).catch(e => this.log.error(`${fn.name}: ${e.message}`));
    sock.ev.on('creds.update', () => { Promise.resolve(saveCreds()).catch(e => this.log.error(`saveCreds: ${e.message}`)); });
    sock.ev.on('connection.update', guard(this.onConnection));
    sock.ev.on('messages.upsert', guard(this.onUpsert));
    sock.ev.on('messages.update', guard(this.onUpdates));
    sock.ev.on('chats.phoneNumberShare', guard(this.onPhoneShare));
  }

  async onConnection(u) {
    if (u.qr) {
      this.qr = await this.d.qrToDataUrl(u.qr).catch(e => { this.log.warn(`qr: ${e.message}`); return null; });
      if (this.authState !== 'wait_qr') { this.authState = 'wait_qr'; await this.d.repo.setAuth(this.id, 'wait_qr', { error: null }); }
      return;
    }
    if (u.connection === 'open') {
      const me = this.sock.user || {};
      this.ownPhone = mapper.phoneOfJid(me.id) || this.ownPhone;
      this.displayName = me.name || null;
      this.qr = null; this.pairingCode = null; this.reconnects = 0;
      await this.d.repo.setAuth(this.id, 'ready', { error: null, phone: this.ownPhone, displayName: this.displayName });
      this.authState = 'ready';   // отправки разрешаем только после записи состояния в БД
      this.lastAuthError = null;
      this.log.info(`готов: ${this.ownPhone || '?'} (${this.displayName || '?'})`);
      try {
        const n = await this.d.deliveries.failStale(this.id);
        if (n) this.log.warn(`закрыто ${n} доставок, зависших с прошлого запуска`);
      } catch (e) { this.log.warn(`failStale: ${e.message}`); }
      return;
    }
    if (u.connection === 'close') {
      const code = disconnectCode(u);
      const { DisconnectReason } = this.d.disconnectReason ? { DisconnectReason: this.d.disconnectReason } : { DisconnectReason: { loggedOut: 401 } };
      this.log.warn(`соединение закрыто (code=${code || '?'})`);
      if (code === DisconnectReason.loggedOut) {
        this.authState = 'logged_out'; this.qr = null; this.pairingCode = null;
        fs.rmSync(this.dirs().wa, { recursive: true, force: true });
        await this.d.repo.setAuth(this.id, 'logged_out', { error: 'сессия завершена на телефоне' });
        return;
      }
      if (this.closed) return;
      const wait = RECONNECT_MS[Math.min(this.reconnects++, RECONNECT_MS.length - 1)];
      await this.d.sleep(wait);
      await this.connect();
    }
  }

  async onPhoneShare({ lid, jid }) {
    const phone = mapper.phoneOfJid(jid); const l = mapper.lidOfJid(lid);
    if (phone && l) await this.d.repo.rememberContact(this.id, phone, l);
  }

  // Шаг из админки: для WhatsApp это только запрос кода привязки по номеру.
  async authStep(step) {
    const s = step || {};
    if (!s.phone) return { authState: this.authState, error: 'не применимо к WhatsApp' };
    if (this.authState !== 'wait_qr') return { authState: this.authState, error: `код привязки доступен только в состоянии wait_qr (сейчас ${this.authState})` };
    const p = normalizePhone(s.phone) || String(s.phone).replace(/\D/g, '');
    try {
      this.pairingCode = await this.sock.requestPairingCode(p);
      this.lastAuthError = null;
      await this.d.repo.setAuth(this.id, this.authState, { error: null, phone: p });
      return { authState: this.authState, pairingCode: this.pairingCode, error: null };
    } catch (e) {
      this.lastAuthError = e.message;
      await this.d.repo.setAuth(this.id, this.authState, { error: e.message });
      return { authState: this.authState, error: e.message };
    }
  }

  status() {
    return { authState: this.authState, phone: this.ownPhone, displayName: this.displayName, error: this.lastAuthError,
      qr: this.authState === 'wait_qr' ? this.qr : null, pairingCode: this.authState === 'wait_qr' ? this.pairingCode : null };
  }

  enqueueChat(chatId, fn) {
    const prev = this.chatQueues.get(chatId) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.chatQueues.set(chatId, next.catch(() => {}));
    return next;
  }

  // ── Входящие/эхо ─────────────────────────────────────────────
  async onUpsert({ messages, type }) {
    if (this.authState !== 'ready') return;
    for (const msg of messages || []) {
      const key = msg.key || {};
      if (this.pendingSends.has(key.id)) continue;                  // наша отправка: эхо уже синтезировано
      if (type !== 'notify') continue;                              // история/чужие устройства
      if (mapper.isSkippedJid(key.remoteJid)) continue;
      const ts = mapper.tsOf(msg.messageTimestamp);
      if (ts && this.d.now() / 1000 - ts > MAX_MESSAGE_AGE_S) { this.log.warn(`пропущено ${key.remoteJid}:${key.id} старше ${MAX_MESSAGE_AGE_S / 3600} ч`); continue; }
      if (!mapper.contentOf(msg.message)) continue;                 // служебное
      await this.enqueueChat(key.remoteJid, () => this.emitMessage(msg, null));
    }
  }

  async resolvePeerPhone(key) {
    const cached = {};
    const lid = mapper.lidOfJid(mapper.isGroupJid(key.remoteJid) ? key.participant : key.remoteJid);
    if (lid) { try { cached[lid] = await this.d.repo.phoneByLid(this.id, lid); } catch (e) { this.log.warn(`phoneByLid ${lid}: ${e.message}`); } }
    const phone = mapper.peerPhone(key, (l) => (l && cached[l]) || null);
    // Увидели LID и номер вместе — запоминаем для следующих сообщений без senderPn.
    const seenLid = mapper.lidOfJid(key.senderLid) || mapper.lidOfJid(key.participantLid) || lid;
    if (phone && seenLid && !cached[seenLid]) {
      await this.d.repo.rememberContact(this.id, phone, seenLid).catch(e => this.log.warn(`rememberContact: ${e.message}`));
    }
    return phone;
  }

  async emitMessage(msg, deliveryId) {
    const key = msg.key || {};
    const group = mapper.isGroupJid(key.remoteJid);
    const phone = key.fromMe && !group ? (mapper.phoneOfJid(key.remoteJid) || await this.resolvePeerPhone(key)) : await this.resolvePeerPhone(key);
    const content = mapper.contentOf(msg.message);
    let fileUrl = null;
    if (content && content.media && !group) {
      try { fileUrl = await this.downloadToPublic(msg, content.media); }
      catch (e) { this.log.warn(`медиа ${key.remoteJid}:${key.id} не скачано (${e.message})`); }
    }
    const body = mapper.buildWebhookBody({ accountId: this.id, ownPhone: this.ownPhone, msg, peerPhone: phone, deliveryId, fileUrl });
    await this.d.webhook.sendSafe(body);
  }

  async downloadToPublic(msg, media) {
    if (media.size && media.size > MAX_MEDIA_BYTES) throw new Error(`файл ${media.size} байт больше лимита ${MAX_MEDIA_BYTES}`);
    const buf = await this.d.downloadMedia(msg);
    if (!buf || !buf.length) throw new Error('пустой файл');
    if (buf.length > MAX_MEDIA_BYTES) throw new Error(`файл ${buf.length} байт больше лимита ${MAX_MEDIA_BYTES}`);
    const dir = path.join(this.d.config.PUBLIC_FILES_DIR, String(this.id));
    fs.mkdirSync(dir, { recursive: true });
    const name = publicFileName(media.mimeType, this.d.now());
    fs.writeFileSync(path.join(dir, name), buf);
    return `${this.d.config.PUBLIC_FILES_URL}/${this.id}/${name}`;
  }

  async onUpdates(updates) {
    for (const u of updates || []) {
      const key = (u && u.key) || {}; const st = u && u.update && u.update.status;
      if (!key.fromMe || typeof st !== 'number' || st < SERVER_ACK) continue;
      let deliveryId = this.pendingSends.get(key.id);
      if (!deliveryId) {
        try { deliveryId = await this.d.deliveries.findByProviderMessageId(this.id, key.id); } catch (e) { this.log.warn(`findByProviderMessageId: ${e.message}`); }
      }
      if (!deliveryId) continue;
      this.pendingSends.delete(key.id);
      await this.d.deliveries.setStatus(deliveryId, this.d.deliveries.STATUS.SENT, { providerMessageId: key.id });
    }
  }

  // ── Отправка ─────────────────────────────────────────────────
  requireReady() {
    if (this.authState !== 'ready') throw httpError(`аккаунт не авторизован (${this.authState})`, 422);
  }

  async resolveJid(phone) {
    const p = normalizePhone(phone);
    if (!p) throw httpError('нет получателя: phone обязателен', 422);
    const hit = this.existsCache.get(p);
    if (!hit || this.d.now() - hit > EXISTS_TTL_MS) {
      let res = null;
      try { res = await this.sock.onWhatsApp(p); }
      catch (e) { this.log.warn(`onWhatsApp(${p}): ${e.message} — шлём без проверки`); }
      const r = Array.isArray(res) ? res[0] : null;
      if (r && r.exists === false) throw httpError(`номер ${p} не в WhatsApp`, 422);
      if (r && r.exists) this.existsCache.set(p, this.d.now());
    }
    return { jid: `${p}@s.whatsapp.net`, phone: p };
  }

  async sendText({ text, phone }) {
    this.requireReady();
    const { jid, phone: p } = await this.resolveJid(phone);
    const deliveryId = await this.d.deliveries.create({ accountId: this.id, chatId: null, phone: p, kind: 'text', text });
    await this.invokeSend(jid, { text }, deliveryId, p);
    return deliveryId;
  }

  async sendFile({ filePath, fileName, caption, type, phone, mimeType }) {
    this.requireReady();
    const { jid, phone: p } = await this.resolveJid(phone);
    const deliveryId = await this.d.deliveries.create({ accountId: this.id, chatId: null, phone: p, kind: 'file', text: caption || fileName });
    let buf;
    try { buf = fs.readFileSync(filePath); } finally { fs.rm(filePath, { force: true }, () => { fs.rmdir(path.dirname(filePath), () => {}); }); }
    const content = type === 'image'
      ? { image: buf, caption: caption || '' }
      : { document: buf, mimetype: mimeType || 'application/octet-stream', fileName: fileName || 'file', caption: caption || '' };
    await this.invokeSend(jid, content, deliveryId, p);
    return deliveryId;
  }

  async invokeSend(jid, content, deliveryId, phone) {
    let sent;
    try { sent = await this.sock.sendMessage(jid, content); }
    catch (e) {
      try { await this.d.deliveries.setStatus(deliveryId, this.d.deliveries.STATUS.FAILED, { error: e.message }); }
      catch (e2) { this.log.error(`delivery g${deliveryId}: статус FAILED не записан (${e2.message})`); }
      throw httpError(`WhatsApp: ${e.message}`, /rate|overlimit|too many/i.test(e.message) ? 429 : 422);
    }
    const msgId = sent && sent.key && sent.key.id;
    if (msgId) {
      this.pendingSends.set(msgId, deliveryId);
      try { await this.d.deliveries.setProviderMessageId(deliveryId, msgId); } catch (e) { this.log.warn(`delivery g${deliveryId}: provider_message_id не записан (${e.message})`); }
    }
    // Эхо своей отправки — сами, не ждём append-апсерта библиотеки.
    const echo = { key: { remoteJid: jid, fromMe: true, id: msgId || `g${deliveryId}` }, message: sent && sent.message ? sent.message : (content.text !== undefined ? { conversation: content.text } : {}), messageTimestamp: mapper.tsOf(sent && sent.messageTimestamp) || Math.floor(this.d.now() / 1000) };
    this.enqueueChat(jid, () => this.emitMessage(echo, `g${deliveryId}`)).catch(e => this.log.warn(`эхо g${deliveryId}: ${e.message}`));
  }

  async logout() {
    try { await this.sock.logout(); } catch (_) { /* уже разлогинен */ }
    await this.close();
    fs.rmSync(this.dirs().wa, { recursive: true, force: true });
    await this.d.repo.setAuth(this.id, 'logged_out');
  }

  async close() {
    this.closed = true;
    try { this.sock && this.sock.end && this.sock.end(undefined); } catch (_) { /* уже закрыт */ }
    this.pendingSends.clear();
  }
}

module.exports = { WhatsappClient, MAX_MESSAGE_AGE_S, RECONNECT_MS };
```

ГОТЧА для исполнителя: в `onConnection` при `close` код `loggedOut` берётся из `deps.disconnectReason` (тест его не передаёт → дефолт `{loggedOut:401}`); в `defaultDeps` добавить `disconnectReason: baileys().DisconnectReason` ленивым геттером нельзя — просто положить `disconnectReason: { loggedOut: 401 }` константой (значение в Baileys 6.7.24 ровно 401, `restartRequired` 515) и убрать тернарий, оставив `const DisconnectReason = this.d.disconnectReason;`.

- [ ] **Step 4: Тест зелёный** `node --test test/whatsapp-client.test.js` → `fail 0`; затем весь `node --test` → `fail 0`.

- [ ] **Step 5: Сверить с результатами Task 1** (лог спайка): если `messages.update` со статусом ≥2 для своих отправок НЕ приходит — в `invokeSend` после `setProviderMessageId` ставить `SENT` сразу (одна строка `await this.d.deliveries.setStatus(deliveryId, STATUS.SENT, { providerMessageId: msgId })`) и поправить ожидание в тесте.

- [ ] **Step 6: Коммит**

```bash
cd /root/loyalpro && git add gateway/lib/whatsapp-client.js gateway/test/whatsapp-client.test.js && git commit -m "feat(gateway): клиент WhatsApp на Baileys — QR/код привязки, входящие, эхо с delivery_id, статусы

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 6: Реестр и сервер: класс по каналу, QR в статусе — 🟢 Sonnet

**Files:**
- Modify: `gateway/lib/registry.js`
- Modify: `gateway/server.js` (функция `accepted`, маршрут `/internal/accounts/:id/status`)
- Test: `gateway/test/server.test.js`

- [ ] **Step 1: Тесты** — в `gateway/test/server.test.js` добавить:

```js
test('accepted(): channel из строки аккаунта (whatsapp), а не константа tdlib', async () => {
  const d = deps({ deps: { repo: { byToken: async (t) => (t === 'TOK' ? { id: 7, channel: 'whatsapp' } : null), get: async () => null } } });
  const r = await call(createApp(d), 'POST', '/api/v1/delivery?text=hi&phone=79001112233', { headers: { authorization: 'Bearer TOK' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.delivery.channel, 'whatsapp');
});

test('GET /internal/accounts/:id/status: qr и pairingCode из status() клиента прокидываются', async () => {
  const d = deps({ tg: { status: () => ({ authState: 'wait_qr', phone: null, displayName: null, error: null, qr: 'data:image/png;base64,AAA', pairingCode: 'ABCDEFGH' }) } });
  const r = await call(createApp(d), 'GET', '/internal/accounts/7/status', { headers: { 'x-gateway-secret': 'sec' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.qr, 'data:image/png;base64,AAA');
  assert.equal(r.json.pairingCode, 'ABCDEFGH');
});
```

- [ ] **Step 2: Запустить — первый падает** (`channel` = `'tdlib'`), второй — проверить: если `/status` уже отдаёт `c.status()` целиком, он зелёный сразу (так и есть: `res.json(c.status())`) — оставить как регрессионный.

- [ ] **Step 3: `server.js`**

Заменить
```js
  const accepted = (id) => ({ meta: { status: 'success' }, delivery: { id: `g${id}`, channel: 'tdlib', status: { status_id: 1, description: 'Принято' } } });
```
на
```js
  const accepted = (id, account) => ({ meta: { status: 'success' }, delivery: { id: `g${id}`, channel: (account && account.channel) || 'tdlib', status: { status_id: 1, description: 'Принято' } } });
```
и оба вызова `res.json(accepted(id))` → `res.json(accepted(id, req.account))`. В `send_file` передать клиенту MIME: `req.tg.sendFile({ …, mimeType: req.file.mimetype })` (TelegramClient лишний аргумент игнорирует).

- [ ] **Step 4: `registry.js`** — заменить импорт и `doStart`:

```js
const { TelegramClient } = require('./telegram-client');
const { WhatsappClient } = require('./whatsapp-client');

// Класс клиента по каналу строки. Неизвестный канал — ошибка, а не молчаливый Telegram.
function clientClassFor(account) {
  if (account.channel === 'tdlib') return TelegramClient;
  if (account.channel === 'whatsapp') return WhatsappClient;
  throw Object.assign(new Error(`канал ${account.channel} шлюзом не поддерживается`), { status: 422 });
}

async function doStart(id) {
  const account = await repo.get(id);
  if (!account) throw Object.assign(new Error('аккаунт не найден'), { status: 404 });
  const c = new (clientClassFor(account))(account);
  clients.set(id, c);
  try { await c.start(); }
  catch (e) { clients.delete(id); throw e; }
  return c;
}
```

В `logout(id)` ветка «не запущен, но сессия есть» сейчас смотрит `TelegramClient.dirsFor(config, id).db`; заменить на проверку обоих каталогов:

```js
    const tgDirs = TelegramClient.dirsFor(config, id);
    const waDirs = WhatsappClient.dirsFor(config, id);
    if (fs.existsSync(tgDirs.db) || fs.existsSync(waDirs.wa)) {
      c = await start(id);
    } else {
      fs.rmSync(tgDirs.base, { recursive: true, force: true });
      await repo.setAuth(id, 'logged_out');
      return;
    }
```
(`tgDirs.base === waDirs.base` — один каталог `acc-<id>`.) Экспортировать `clientClassFor`.

- [ ] **Step 5: Тест реестра** — создать `gateway/test/registry.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const dbPath = require.resolve('../db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { db: { oneOrNone: async () => null, any: async () => [], query: async () => {} } } };
const cfgPath = require.resolve('../config');
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: { DATA_DIR: require('os').tmpdir(), PUBLIC_FILES_DIR: '/tmp', PUBLIC_FILES_URL: '/u', TDLIB_VERBOSITY: 0 } };
const { clientClassFor } = require('../lib/registry');
const { TelegramClient } = require('../lib/telegram-client');
const { WhatsappClient } = require('../lib/whatsapp-client');

test('clientClassFor: tdlib → TelegramClient, whatsapp → WhatsappClient, прочее → 422', () => {
  assert.equal(clientClassFor({ channel: 'tdlib' }), TelegramClient);
  assert.equal(clientClassFor({ channel: 'whatsapp' }), WhatsappClient);
  assert.throws(() => clientClassFor({ channel: 'max' }), e => e.status === 422);
});
```

- [ ] **Step 6: Все тесты зелёные** `node --test` → `fail 0`.

- [ ] **Step 7: Коммит**

```bash
cd /root/loyalpro && git add gateway/lib/registry.js gateway/server.js gateway/test/server.test.js gateway/test/registry.test.js && git commit -m "feat(gateway): реестр выбирает клиент по каналу, channel в ответе delivery, QR в статусе

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Ревью 1 — 🔵 Opus

Промпт ревьюеру: прочитать спеку §3, `gateway/lib/wa-mapper.js`, `whatsapp-client.js`, `registry.js`, `server.js`, тесты; прогнать `cd /root/loyalpro/gateway && node --test`. Проверить особо: (1) эхо своей отправки не задваивается при `append`-апсерте; (2) `fromMe notify` без доставки даёт `delivery_id:null`; (3) при `close` с 401 нет реконнекта и каталог удалён; (4) расширение файла только из белого списка; (5) `authState='ready'` ставится после записи в БД; (6) ни один путь не оставляет `pendingSends` расти бесконечно (ack или FAILED чистят). Замечания — правками в тех же файлах + коммит.

---

## Часть C. Бэкенд и админка

### Task 7: Бэкенд — создание WhatsApp-аккаунта, QR в статусе, дедуп эха — 🟢 Sonnet

**Files:**
- Modify: `backend/routes/messaging-accounts.js`
- Modify: `backend/routes/chatpush-webhook.js` (ветка дедупа WhatsApp-эха, ≈ строки 170–182)
- Test: `backend/messaging-accounts-routes.test.js`, `backend/chatpush-webhook-route.test.js`

- [ ] **Step 1: Тесты**

В `backend/messaging-accounts-routes.test.js` (после describe `createTelegramAccount`):

```js
describe('createGatewayAccount(whatsapp)', () => {
  const { createGatewayAccount } = router;
  test('вставляет pending-строку channel=whatsapp с display_name WhatsApp, external_id=id, start', async () => {
    db.oneOrNone.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 43 });
    gw.start.mockResolvedValue({ authState: 'starting' });
    const r = await createGatewayAccount(1, 'whatsapp');
    expect(r).toEqual({ id: 43, authState: 'starting', status: 'pending' });
    const ins = db.oneOrNone.mock.calls[1];
    expect(ins[0]).toMatch(/'gateway', 'whatsapp', 'pending'/);
    expect(ins[0]).toMatch(/WhatsApp \(свой шлюз\)/);
    expect(db.oneOrNone.mock.calls[0][1]).toEqual([1, 'whatsapp']);
    expect(gw.start).toHaveBeenCalledWith(43);
  });
  test('неизвестный канал → ошибка 400 без запросов', async () => {
    await expect(createGatewayAccount(1, 'max')).rejects.toMatchObject({ status: 400 });
    expect(db.oneOrNone).not.toHaveBeenCalled();
  });
  test('createTelegramAccount = createGatewayAccount(…, tdlib)', async () => {
    db.oneOrNone.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 44 });
    gw.start.mockResolvedValue({ authState: 'starting' });
    await createTelegramAccount(1);
    expect(db.oneOrNone.mock.calls[0][1]).toEqual([1, 'tdlib']);
  });
});
```

В `backend/chatpush-webhook-route.test.js`:

```js
test('/gateway whatsapp: эхо своей отправки с delivery_id g12 дедупится по строке api:g12', async () => {
  accounts.resolveSalon.mockResolvedValue(3);
  accounts.credentialsFor.mockResolvedValue({ id: 9, provider: 'gateway' });
  db.oneOrNone.mockImplementation(async (sql, p) => (/external_message_id=\$2/.test(sql) && p[1] === 'api:g12' ? { 1: 1 } : null));
  const body = { type: 'whatsapp_incoming_msg', payload: { customer_id: 9, provider: 'gateway', delivery_id: 'g12',
    new_message: { direction: 'outgoing', chat_id: '79001112233@c.us', chat_phone: '79001112233', sender_phone_number: '79250177778', recipient_phone_number: '79001112233',
      message: { id: 'true_79001112233@s.whatsapp.net_OUT1', type: 'text', text: 'hi', timestamp: 1 } } } };
  await handle({ baseUrl: '/gateway', query: { key: 'gwsecret' }, body }, fakeRes());
  expect(messageInserts()).toHaveLength(0);
  expect(log.debug).toHaveBeenCalledWith(expect.stringMatching(/skip echo of own whatsapp send \(delivery g12\)/));
});
```

- [ ] **Step 2: Запустить — падают** `cd /root/loyalpro/backend && npx jest messaging-accounts-routes chatpush-webhook-route 2>&1 | tail -15`.

- [ ] **Step 3: `routes/messaging-accounts.js`** — заменить функцию `createTelegramAccount` на:

```js
const GATEWAY_CHANNELS = { tdlib: 'Telegram (свой шлюз)', whatsapp: 'WhatsApp (свой шлюз)' };

// Завести gateway-аккаунт канала у салона (Telegram или WhatsApp) — см. комментарий
// про 'pending' и идемпотентность выше.
async function createGatewayAccount(salonId, channel) {
  const displayName = GATEWAY_CHANNELS[channel];
  if (!displayName) throw Object.assign(new Error(`канал ${channel} через шлюз не подключается`), { status: 400 });
  const existing = await db.oneOrNone(
    `SELECT id, status FROM messenger_accounts
      WHERE salon_id = $1 AND channel = $2 AND provider = 'gateway' AND status IN ('active','pending')
      ORDER BY (status = 'active') DESC, id DESC LIMIT 1`,
    [salonId, channel]);
  if (existing) {
    await db.query(`UPDATE messenger_accounts SET external_id = COALESCE(external_id, $1) WHERE id = $2`, [String(existing.id), existing.id]);
    const st = await gw.start(existing.id);
    return { id: existing.id, authState: st.authState, status: existing.status };
  }
  const token = crypto.randomBytes(24).toString('hex');
  const ins = await db.oneOrNone(
    `INSERT INTO messenger_accounts (salon_id, token, provider, channel, status, auth_state, display_name)
     VALUES ($1, $2, 'gateway', '${channel}', 'pending', 'starting', '${displayName}')
     RETURNING id`,
    [salonId, token]);
  const id = ins && ins.id;
  if (!id) throw new Error('строка аккаунта не вставилась');
  await db.query(`UPDATE messenger_accounts SET external_id = $1 WHERE id = $2`, [String(id), id]);
  accounts.invalidate();
  const st = await gw.start(id);
  return { id, authState: st.authState, status: 'pending' };
}
const createTelegramAccount = (salonId) => createGatewayAccount(salonId, 'tdlib');
```
(`channel`/`displayName` интерполируются в SQL ТОЛЬКО из `GATEWAY_CHANNELS` — пользовательский ввод туда не попадает.) Добавить маршрут после `POST /accounts/telegram`:

```js
router.post('/accounts/whatsapp', adminOnly, async (req, res) => {
  if (!config.MESSAGING_GATEWAY.url) return res.status(503).json({ error: 'шлюз мессенджеров не настроен (MESSAGING_GATEWAY_URL)' });
  try { res.json(await createGatewayAccount(req.user.salonId, 'whatsapp')); }
  catch (e) { logger.error(`create whatsapp: ${e.message}`); res.status(e.status || 500).json({ error: e.message }); }
});
```
В экспорты добавить `module.exports.createGatewayAccount = createGatewayAccount;`. Маршруты `/auth` и `/status` уже отдают `{...r, status}` — `qr`/`pairingCode` из ответа шлюза проходят без правок. В `parseAuthStep` ничего не менять: `{phone}` для WhatsApp — запрос кода привязки.

- [ ] **Step 4: `routes/chatpush-webhook.js`** — в ветке дедупа заменить

```js
        const dId = chatpush.deliveryIdFromWhatsappEchoId(msg.messageId);
```
на
```js
        // Chatpush кладёт delivery_id и в payload, и в id эха (`_d<id>THISISBOT`);
        // наш шлюз — только в payload (id у него 'g<n>', регэксп его не ловит).
        const dId = msg.deliveryId || chatpush.deliveryIdFromWhatsappEchoId(msg.messageId);
```

- [ ] **Step 5: Тесты зелёные** `npx jest messaging-accounts-routes chatpush-webhook-route chat 2>&1 | tail -6`.

- [ ] **Step 6: Коммит**

```bash
cd /root/loyalpro && git add backend/routes/messaging-accounts.js backend/routes/chatpush-webhook.js backend/messaging-accounts-routes.test.js backend/chatpush-webhook-route.test.js && git commit -m "feat(messaging): подключение WhatsApp через шлюз из админки, дедуп эха по delivery_id шлюза

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 8: Фронт — мастер подключения WhatsApp (QR / код по номеру) — 🟢 Sonnet

**Files:**
- Modify: `frontend/js/pages/messaging-accounts.js`
- Modify: `frontend/index.html` (секция `stg-messengers` ≈ строки 547–572; тег `<script … messaging-accounts.js?v=…>` ≈ строка 2539)
- Test: `frontend/js/pages/messaging-accounts.test.js`

- [ ] **Step 1: Тесты** — дополнить `messaging-accounts.test.js`:

```js
test('msgAccNextStep: wait_qr → qr', () => {
  assert.equal(ctx.msgAccNextStep('wait_qr'), 'qr');
});
test('msgAccStateLabel: wait_qr и WhatsApp', () => {
  assert.equal(ctx.msgAccStateLabel({ provider: 'gateway', status: 'pending', auth_state: 'wait_qr', channel: 'whatsapp' }), 'Свой шлюз · подключается · ждёт сканирования QR');
});
test('msgAccGatewayBusy: занят только свой канал', () => {
  const rows = [{ provider: 'gateway', channel: 'tdlib', status: 'active' }, { provider: 'chatpush', channel: 'whatsapp', status: 'active' }];
  assert.equal(ctx.msgAccGatewayBusy(rows, 'tdlib'), true);
  assert.equal(ctx.msgAccGatewayBusy(rows, 'whatsapp'), false);
});
```

- [ ] **Step 2: Запустить — падает** `cd /root/loyalpro/frontend && node --test js/pages/messaging-accounts.test.js`.

- [ ] **Step 3: JS**

В `messaging-accounts.js`:
- `MSG_ACC_AUTH` дополнить `wait_qr: 'ждёт сканирования QR'`.
- `msgAccNextStep`: перед `return 'wait'` добавить `if (authState === 'wait_qr') return 'qr';`.
- Добавить чистый помощник и переписать блок кнопок в `loadMessagingAccounts`:

```js
function msgAccGatewayBusy(rows, channel) {
  return rows.some(a => a.provider === 'gateway' && a.channel === channel && (a.status === 'active' || a.status === 'pending'));
}
```
```js
    for (const [btnId, channel, label] of [['msg-acc-connect-tg', 'tdlib', 'Telegram'], ['msg-acc-connect-wa', 'whatsapp', 'WhatsApp']]) {
      const connectBtn = document.getElementById(btnId);
      if (!connectBtn) continue;
      const busy = msgAccGatewayBusy(r.accounts, channel);
      connectBtn.disabled = !r.gatewayConfigured || busy;
      connectBtn.title = busy ? `${label} уже подключается через свой шлюз` : '';
    }
```
- Обобщить подключение:

```js
async function msgAccConnect(channel) {
  const label = channel === 'whatsapp' ? 'WhatsApp' : 'Telegram';
  if (!confirm(`Подключить ${label} салона к своему шлюзу? Канал переключится с Chatpush, когда вход будет подтверждён. Продолжить?`)) return;
  try {
    const r = await api('POST', `/api/messaging/accounts/${channel === 'whatsapp' ? 'whatsapp' : 'telegram'}`);
    _msgAccCurrent = r.id;
    msgAccRenderStep(r.authState, null);
    msgAccStartPolling();
    await loadMessagingAccounts();
  } catch (e) { alert('Не удалось начать подключение: ' + e.message); }
}
function msgAccConnectTelegram() { return msgAccConnect('tdlib'); }
function msgAccConnectWhatsapp() { return msgAccConnect('whatsapp'); }
```
- `msgAccRenderStep(authState, error, extra)` получает третий аргумент `{qr, pairingCode}` и рисует их:

```js
  const img = document.getElementById('msg-acc-qr-img');
  if (img) { if (extra && extra.qr) { img.src = extra.qr; img.style.display = ''; } else { img.removeAttribute('src'); img.style.display = 'none'; } }
  const pc = document.getElementById('msg-acc-pairing-code');
  if (pc) pc.textContent = (extra && extra.pairingCode) ? `Код для ввода на телефоне: ${extra.pairingCode}` : '';
```
В `msgAccSendStep` и в тике `msgAccStartPolling` передавать третьим аргументом сам ответ (`r` / `s`) — у него есть поля `qr`/`pairingCode`, когда шлюз их отдаёт. Шаг `phone` в мастере общий: у Telegram это «Отправить код», у WhatsApp — поле на шаге `qr` с кнопкой «Получить код привязки», которая зовёт `msgAccSendStep('wa-phone')` → `api(... { phone: value })`: в `msgAccSendStep` поле `field === 'wa-phone'` маппится в ключ тела `phone` (`const bodyKey = field === 'wa-phone' ? 'phone' : field;`).

- [ ] **Step 4: HTML** — в секции `stg-messengers`:
  - текст абзаца: «Telegram и WhatsApp можно подключить напрямую (свой шлюз), остальные каналы пока идут через Chatpush.»;
  - рядом с кнопкой Telegram: `<button class="btn btn-pri" id="msg-acc-connect-wa" onclick="msgAccConnectWhatsapp()">Подключить WhatsApp напрямую</button>`;
  - в `msg-acc-wizard` новый шаг:
```html
            <div data-step="qr">
              <p>Откройте WhatsApp на телефоне клиники → <b>Связанные устройства</b> → <b>Привязка устройства</b> и отсканируйте QR:</p>
              <img id="msg-acc-qr-img" alt="QR для привязки WhatsApp" style="display:none;width:240px;height:240px;border:1px solid #ddd;border-radius:8px">
              <p style="opacity:.8;margin-top:10px">Нет возможности сканировать? Введите номер WhatsApp клиники — получите код, его вводят на телефоне в «Привязка по номеру телефона».</p>
              <input id="msg-acc-wa-phone" autocomplete="tel" placeholder="+7 900 000-00-00" style="max-width:280px">
              <button class="btn btn-sec" onclick="msgAccSendStep('wa-phone')">Получить код привязки</button>
              <p id="msg-acc-pairing-code" style="font-size:18px;font-weight:600;letter-spacing:2px"></p>
            </div>
```
  - бамп: `js/pages/messaging-accounts.js?v=2026-10-12a`.

- [ ] **Step 5: Тест зелёный и визуальная проверка** `node --test js/pages/messaging-accounts.test.js` → `fail 0`. Открыть дев-админку → Настройки → Мессенджеры: видны две кнопки, у WhatsApp при `gatewayConfigured` активна.

- [ ] **Step 6: Коммит**

```bash
cd /root/loyalpro && git add frontend/js/pages/messaging-accounts.js frontend/js/pages/messaging-accounts.test.js frontend/index.html && git commit -m "feat(settings): подключение WhatsApp к своему шлюзу — QR и код привязки по номеру

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Ревью 2 — 🔵 Opus

Прочитать Task 7–8 diff (`git diff HEAD~2`), прогнать `npx jest messaging-accounts-routes chatpush-webhook-route` и `node --test frontend/js/pages/messaging-accounts.test.js`. Особо: SQL-интерполяция `channel`/`displayName` только из константы; `/logout` возвращает канал прежнему Chatpush-аккаунту и для whatsapp (код общий — убедиться, что `row.channel` там не захардкожен); фронт не падает, если `qr`/`pairingCode` в ответе отсутствуют (Telegram).

### Task 9: Документация — 🟡 Haiku

**Files:**
- Modify: `CLAUDE.md` — в конец раздела про шлюз (найти «### Свой шлюз мессенджеров» или первый абзац, где упоминается `gateway/`; если раздела нет — добавить после «### Multi-salon») вставить:

```markdown
- **WhatsApp через шлюз (с 2026-10):** `gateway/lib/whatsapp-client.js` (Baileys 6.7.24, ТОЧНАЯ версия — 7.x это rc с нативной зависимостью), тот же интерфейс, что у `TelegramClient`, класс выбирает `registry.clientClassFor` по `messenger_accounts.channel`. Сессия — `data/acc-<id>/wa` (`useMultiFileAuthState`). Авторизация: `auth_state='wait_qr'`, QR data-URL в `/internal/accounts/:id/status`, код привязки по номеру — `authStep({phone})`. Вебхук — ВЛОЖЕННАЯ WhatsApp-форма Chatpush (`new_message`), `chat_id` `<phone>@c.us` | `<lid>@lid` (номер неизвестен — ответить нельзя, см. спеку §6) | `<id>@g.us`. ГОТЧА LID: WhatsApp адресует чаты LID-ами, номер — из `key.senderPn`/`participantPn`, иначе кэш `gateway_contacts` (`user_id` = LID). Эхо своей отправки шлюз СИНТЕЗИРУЕТ из результата `sendMessage` (append-апсерт того же `key.id` пропускается); бэкенд дедупит его по `msg.deliveryId` (`routes/chatpush-webhook.js`), `_d<id>THISISBOT` — запасной путь Chatpush. `reply_to` в WhatsApp игнорируется. Риск: неофициальный клиент, как и Chatpush — пауза темпа и дневные лимиты обязательны. Спека `docs/superpowers/specs/2026-10-12-whatsapp-gateway-design.md`, план `docs/superpowers/plans/2026-10-12-whatsapp-gateway.md`.
```

- [ ] Коммит: `git add CLAUDE.md && git commit -m "docs: WhatsApp через свой шлюз — заметки для CLAUDE.md"` (с Co-Authored-By).

---

## Часть D. Живая проверка и выкат

### Task 10: Сквозная проверка на деве — 🟣 Fable (+ владелец на телефоне)

**Files:**
- Create: `backend/scripts/gateway-whatsapp-e2e.js`
- Create/Modify: `docs/2026-10-XX-gateway-whatsapp-live-test.md`

- [ ] **Step 1: Скрипт** — взять `backend/scripts/gateway-telegram-e2e.js` целиком и изменить: шапку (`WhatsApp`, канал `whatsapp`); `accounts.credentialsFor(SALON, 'whatsapp')`; `dispatchRouting: ['whatsapp']`; проверки эха: `row.channel === 'whatsapp'`, `external_message_id` соответствует `/^api:g\d+$/` (строка персистится бэкендом при отправке — `transport` её не пишет, поэтому в скрипте ПЕРЕД отправкой звать `chatPersist.persistWhatsappOutgoing` нельзя — вместо этого после отправки вызвать `require('../services/chat-persist').persistWhatsappOutgoing(SALON, { delivery: d, phone, chatId: null, text, msgType: 'text', authoredBy: 'agent' })`, как делает диспетчер); дополнительно проверить, что ЭХО шлюза НЕ создало второй строки: `SELECT count(*) FROM chatpush_messages WHERE salon_id=$1 AND phone=$2 AND text=$3` = 1, а в `chatpush_events` есть событие `provider='gateway'` с `payload->'payload'->>'delivery_id' = d.id` (сторож); статус по аккаунту через `transport.getDeliveryStatus(SALON, 'whatsapp', d.id, { accountId: d.accountId })` → `status_id` 2 в течение 30 с.

- [ ] **Step 2: Подключить тестовый WhatsApp** (+79200255591 владельца) через дев-админку → QR → `ready`, канал whatsapp салона 1 переключён (`messenger_accounts`: новая строка active, Chatpush whatsapp disabled).

- [ ] **Step 3: Прогнать** `cd /root/loyalpro/backend && node scripts/gateway-whatsapp-e2e.js --phone 79250177778` → все проверки PASS.

- [ ] **Step 4: Ручной чек-лист** (записать результаты в отчёт): входящий текст с 79250177778 → строка `channel=whatsapp, provider=gateway, phone=79250177778, chat_id=79250177778@c.us`; входящее фото → файл в `frontend/uploads/gateway/<id>/…jpg`, в «Чате» видно; ответ с телефона руками → `authored_by='operator'`, `agent paused`; событие Chatpush whatsapp за то же время → «skip chatpush whatsapp message: канал салона обслуживает gateway»; `pm2 restart loyalpro-gateway` → `ready` без QR; «Отключить» → строка disabled, Chatpush whatsapp снова active; второй вход через код привязки (`rm` сессии → подключить заново → «Получить код привязки»).

- [ ] **Step 5: Вернуть дев в исходное** («Отключить» — личные чаты владельца не должны литься в дев-БД) и закоммитить скрипт + отчёт.

### Task 11: Выкат на прод — 🟣 Fable, по шагам руками, с владельцем

- [ ] 0. Убедиться, что на проде уже есть фикс ложной паузы от уведомлений YClients на шлюзе (`services/outgoing-authorship.js` с `provider` в `classify`, миграция `idx_chatpush_messages_sys_out` — делается параллельной сессией 12.10.2026): без него после переключения WhatsApp каждое «Вы записаны на прием…» поставит диалог на паузу «ответил оператор».
- [ ] 1. Слить ветку в `main`, на проде `cd /root/loyalpro_new && git stash && git pull --ff-only && git stash pop`; `cd gateway && npm ci --omit=dev` (нужен `git` для `libsignal` — на проде есть, 2.43); `pm2 restart loyalpro-gateway`, `PORT=3001 pm2 restart loyalpro` (миграция добавит колонку).
- [ ] 2. Владелец: прод-админка → Настройки → Мессенджеры → «Подключить WhatsApp напрямую» → сканирует QR с телефона клиники (+79250177778) ИЛИ вводит код привязки. Ждать `ready` → лог бэкенда «канал whatsapp салона 1 переключён на шлюз».
- [ ] 3. Проверить первое входящее и первый ответ Милы (`pm2 logs loyalpro-gateway`, `agent_reply_deliveries`, «Чат»).
- [ ] 4. Выйти из WhatsApp в кабинете Chatpush (связанное устройство Chatpush — удалить и на телефоне в «Связанные устройства»).
- [ ] 5. Первые дни: WARN/ERROR в `backend/logs/app-*.log` по `WA#`, зависшие `gateway_deliveries.status_id=1`, диалоги с `chat_id LIKE '%@lid'` (номер не раскрыт).
- [ ] Откат: «Сделать активным» у строки Chatpush whatsapp (перед этим снова связать Chatpush с телефоном).

---

## Что СОЗНАТЕЛЬНО не входит

- MAX через шлюз (нет публичного клиентского протокола).
- Цитирование (`reply_to`) в WhatsApp, статусы «доставлено/прочитано», реакции, звонки, опросы.
- Ответ в диалог, у которого известен только LID (нужен номер — ждём раскрытия).
- Распределённый реестр/несколько процессов шлюза.

## Self-review

- Спека §2 (библиотека) → Task 0/1; §3 авторизация → Task 5/6/7/8; входящие и телефон по LID → Task 3/4/5; отправка, эхо, статусы → Task 5, дедуп → Task 7; §4 данные → Task 0; §5 переключение → Task 7 (общий код) + Task 11; §7 проверка → Task 1/10.
- Имена согласованы: `setProviderMessageId`/`findByProviderMessageId` (Task 4 ↔ 5), `phoneByLid` (4 ↔ 5), `clientClassFor` (6), `createGatewayAccount` (7), `msgAccGatewayBusy`/`msgAccConnect` (8), `publicFileName` (2 ↔ 5), статусы `STATUS.SENT/FAILED` (5 ↔ deliveries).
- Остаточная неопределённость вынесена в Task 1 и Task 5 Step 5 (статусы своей отправки) — других «уточнить позже» в плане нет.
