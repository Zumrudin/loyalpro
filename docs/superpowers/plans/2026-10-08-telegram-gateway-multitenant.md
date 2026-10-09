# Свой шлюз мессенджеров: Telegram (TDLib) + мультисалонные аккаунты — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Принимать и отправлять сообщения Telegram напрямую (аккаунт клиники через TDLib) своим сервисом вместо Chatpush, причём так, чтобы любой новый филиал или организация подключали свой мессенджер отдельной строкой в базе, а не правкой env.

**Architecture:** Отдельный процесс `gateway/` (PM2 `loyalpro-gateway`, порт 3002) держит TDLib-сессии всех подключённых аккаунтов и говорит с бэкендом **на контракте Chatpush**: те же ручки отправки (`/api/v1/delivery`, `/api/v1/send_file`, `/api/v1/delivery/:id`) и те же вебхук-события (`tdlib_incoming_msg` с `delivery_id`). Благодаря этому диспетчер Милы, авторство исходящих, сторож доставки и «Чат» работают без правок логики. В бэкенде привязка «аккаунт мессенджера → салон» и токены переезжают из env в таблицу `messenger_accounts` (провайдер `chatpush` или `gateway`, одна строка на пару «салон + канал»), а все отправки идут через единый `services/messaging/transport.js`, который выбирает аккаунт по салону и каналу.

**Tech Stack:** Node 22, Express, PostgreSQL (та же БД `loyalpro`/`loyalpro_test`), `tdl` 8.x + `prebuilt-tdlib` (TDLib 1.8.67, prebuilt для linux x64 glibc ≥ 2.17 — на деве glibc 2.35), axios, PM2. Тесты: backend — Jest (`npx jest <имя>`), gateway и фронт — `node --test`.

---

## Контекст для исполнителя (прочитать целиком до первой задачи)

**Что такое Chatpush для нашего кода.** Платформа, которая держит личные аккаунты клиники в WhatsApp/Telegram/MAX и даёт единый API. Мы:
- шлём: `POST {apiBase}/api/v1/delivery?text=&phone=&dispatch_routing[]=tdlib&reply_to_message_id=&tdlib_user_id=` с `Authorization: Bearer <token>`; ответ `{meta:{status:'success'}, delivery:{id, status:{status_id, description}}}`; файлы — `POST /api/v1/send_file` (multipart `file`); судьба — `GET /api/v1/delivery/:id`. Всё это в `backend/services/chatpush.js`.
- принимаем вебхук `POST /chatpush/webhook?key=<секрет>` (`backend/routes/chatpush-webhook.js`): тело `{type:'tdlib_incoming_msg', payload:{direction, customer_id, chat_id, chat_type, sender_phone_number, recipient_phone_number, sender_name, delivery_id, timestamp, message:{id, type, text, timestamp, reply_to_message_id, file_data?}}}`. Парсер `chatpush.parseMessageEvent` → строка в `chatpush_messages` (+ сырой лог `chatpush_events`), авторство исходящего по `delivery_id` (есть у всего, что ушло через API; нет у текста, набранного руками в телефоне → пауза «ответил оператор»), SSE в «Чат», постановка в очередь Милы.

**Сегодняшняя однопользовательность.** `config.CHATPUSH.instanceToken` используется напрямую в 9 местах (диспетчер ×2, `routes/chat.js` ×3, `notifications.js`, `delivery-watchdog.js`, `followup-worker.js`, `care/worker.js`, `reminders/worker.js`), а салон из входящего события резолвится функцией `resolveSalonId` из env `CHATPUSH_SALON_ID`/`CHATPUSH_CUSTOMER_ID`.

**Правила проекта, которые нельзя нарушать (из CLAUDE.md):**
- Все схемы — через `backend/migrations.js`, только `IF NOT EXISTS`/`DO NOTHING`, никогда деструктивно.
- Каждый запрос скоупится `salon_id`.
- `db.one` НЕ бросает на пустой выборке — возвращает `null`, проверяй явно.
- Jest идёт в `TZ=Europe/Moscow` через `jest.global-setup.js` (ничего делать не надо, просто знай).
- Правка JS/CSS фронта — с бампом `?v=` в `frontend/index.html`.
- Коммиты — по одному на задачу, сообщение по-русски, в конце строка `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- На деве рестарт бэкенда: `PORT=3001 pm2 restart loyalpro` (без `--update-env`).
- Прямые SQL-проверки — через MCP `mcp__postgres__query`, не `psql`.

**Единицы и форматы.** `msg_ts` — unix-секунды (в SQL `to_timestamp(msg_ts)`). Телефоны в отправке — цифры с ведущей 7 (`79001112233`). `delivery_id` в `agent_reply_deliveries` — `VARCHAR(40)`, у шлюза id вида `g<число>` (не пересекается с числовыми id Chatpush). Message id у TDLib уникален только в пределах чата, поэтому шлюз отдаёт составной `"<chat_id>:<message_id>"` и сам же его разбирает в `reply_to_message_id`.

**Контракт шлюза (зафиксирован здесь, задачи ссылаются на него):**

Публичный (Chatpush-совместимый, `Authorization: Bearer <messenger_accounts.token>`):
- `POST /api/v1/delivery?text&phone&tdlib_user_id&dispatch_routing[]&reply_to_message_id` → `200 {meta:{status:'success'}, delivery:{id:'g12', channel:'tdlib', status:{status_id:1, description:'Принято'}}}`; `401 {meta:{status:'error',message:'unauthorized'}}`; `422 {meta:{status:'error',message:'<причина>'}}` (нет получателя / аккаунт не авторизован).
- `POST /api/v1/send_file?file_name&caption&type&phone&tdlib_user_id&dispatch_routing[]` multipart `file` → то же.
- `GET /api/v1/delivery/:id` → `200 {delivery:{id, status:{status_id, description}, error}}`. `status_id`: 1 «Принято», 2 «Отправлено», 5 «Невозможно доставить» (бэкенд проверяет ровно 5 и регэксп «невозможно|ошибк|не доставлен|failed|error»).

Внутренний (header `X-Gateway-Secret: <GATEWAY_INTERNAL_SECRET>`):
- `POST /internal/accounts/:id/start` → `{authState}`
- `POST /internal/accounts/:id/auth` body `{phone}` | `{code}` | `{password}` → `{authState, error}`
- `GET /internal/accounts/:id/status` → `{authState, phone, displayName, error}`
- `POST /internal/accounts/:id/logout` → `{ok:true}`

`auth_state`: `starting | wait_phone | wait_code | wait_password | ready | logged_out | error`.

Вебхук шлюз → бэкенд: `POST {BACKEND_WEBHOOK_URL}` (= `http://127.0.0.1:3001/gateway/webhook?key=<GATEWAY_WEBHOOK_SECRET>`), тело — плоская tdlib-форма Chatpush (см. выше) плюс `payload.provider:'gateway'`, `payload.customer_id = <messenger_accounts.id>`.

---

## Структура файлов

**Бэкенд (modify):**
- `backend/migrations.js` — таблицы `messenger_accounts`, `gateway_deliveries`, `gateway_contacts`, сид из env.
- `backend/config.js` — блок `MESSAGING_GATEWAY` (url, secret, webhookSecret).
- `backend/services/chatpush.js` — принимать креды объектом `{apiBase, token}` (строка-токен остаётся).
- `backend/routes/chatpush-webhook.js` — провайдер из пути, резолв салона через `accounts`.
- `backend/routes/index.js` — второй маунт того же роутера на `/gateway`.
- `backend/services/agent/dispatcher.js`, `backend/routes/chat.js`, `backend/services/notifications.js`, `backend/services/agent/delivery-watchdog.js`, `backend/services/agent/followup-worker.js`, `backend/services/care/worker.js`, `backend/services/reminders/worker.js` — отправка через `transport`.

**Бэкенд (create):**
- `backend/services/messaging/accounts.js` — реестр аккаунтов: `credentialsFor`, `resolveSalon`, `listForSalon`, кэш, fallback на env. Тест `backend/messaging-accounts.test.js`.
- `backend/services/messaging/transport.js` — единая отправка по салону+каналу. Тест `backend/messaging-transport.test.js`.
- `backend/services/messaging/gateway-client.js` — вызовы внутреннего API шлюза.
- `backend/routes/messaging-accounts.js` — админ-API `/api/messaging`. Тест `backend/messaging-accounts-routes.test.js`.
- `backend/scripts/gateway-telegram-e2e.js` — живая проверка на деве.

**Шлюз (create, новый компонент):**
- `gateway/package.json`, `gateway/config.js`, `gateway/db.js`, `gateway/logger.js`, `gateway/server.js`.
- `gateway/lib/mapper.js` — чистые функции: TDLib-сообщение → тело вебхука, составные id, телефоны, статусы. Тест `gateway/test/mapper.test.js`.
- `gateway/lib/deliveries.js` — строки `gateway_deliveries`.
- `gateway/lib/webhook-sender.js` — POST в бэкенд с повторами.
- `gateway/lib/telegram-client.js` — обёртка TDLib одного аккаунта: авторизация, апдейты, отправка, резолв получателя.
- `gateway/lib/registry.js` — аккаунт → клиент, старт всех активных.
- `gateway/scripts/tdlib-spike.js` — разовая проверка поведения библиотеки.
- `ecosystem.config.js` — второе приложение PM2.

**Фронт (create/modify):**
- `frontend/js/pages/messaging-accounts.js` — раздел «Мессенджеры» в настройках. Тест `frontend/js/pages/messaging-accounts.test.js` (`node --test`).
- `frontend/index.html`, `frontend/js/core/nav.js` — пункт меню, секция, загрузка.

---

## Часть A. Бэкенд: мультисалонные аккаунты и единая отправка

Часть A самодостаточна: после неё Chatpush продолжает работать, но из базы, и любой второй салон подключается строкой в таблице.

### Task 1: Таблица `messenger_accounts` и сид из env

**Files:**
- Modify: `backend/migrations.js` (добавить блок в конец функции миграций, рядом с `agent_reply_deliveries`)

- [ ] **Step 1: Добавить миграцию**

Найти в `backend/migrations.js` блок `CREATE TABLE IF NOT EXISTS agent_reply_deliveries` и ПОСЛЕ его индекса вставить:

```js
  // ── messenger_accounts — аккаунты мессенджеров по салонам (2026-10) ─────
  // Одна строка = один КАНАЛ одного салона у одного провайдера. До этого токен
  // Chatpush и связка «инстанс → салон» жили в env и второй салон подключить
  // было нельзя. provider: 'chatpush' (external_id = customer_id инстанса,
  // token = Bearer инстанса) | 'gateway' (наш шлюз: external_id = id этой же
  // строки, token генерируется бэкендом). На (salon_id, channel) активная
  // строка одна — переключение Telegram с Chatpush на шлюз = disable старой +
  // новая строка, откат — обратно.
  await client.query(`
    CREATE TABLE IF NOT EXISTS messenger_accounts (
      id SERIAL PRIMARY KEY,
      salon_id INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      provider VARCHAR(16) NOT NULL,
      channel VARCHAR(16) NOT NULL,
      external_id VARCHAR(64),
      api_base VARCHAR(200),
      token VARCHAR(200) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      display_name VARCHAR(120),
      phone VARCHAR(32),
      auth_state VARCHAR(32),
      auth_error TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS messenger_accounts_active_channel_idx
      ON messenger_accounts (salon_id, channel) WHERE status = 'active'
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS messenger_accounts_external_idx
      ON messenger_accounts (provider, external_id)
  `).catch(() => {});
  // Сид из env: у салона, настроенного в CHATPUSH_SALON_ID, ещё нет ни одной
  // строки → заводим три канала Chatpush с токеном из env ОДНИМ запросом.
  // Повторный запуск ничего не делает (NOT EXISTS). После сида env остаётся
  // только запасным путём.
  {
    const cp = require('./config').CHATPUSH;
    if (cp.salonId && cp.instanceToken) {
      await client.query(`
        INSERT INTO messenger_accounts (salon_id, provider, channel, external_id, api_base, token, status, display_name)
        SELECT $1, 'chatpush', ch, $2, $3, $4, 'active', 'Chatpush (из env)'
          FROM unnest(ARRAY['whatsapp','tdlib','max']) AS ch
         WHERE NOT EXISTS (SELECT 1 FROM messenger_accounts WHERE salon_id = $1)
      `, [cp.salonId, cp.customerId != null ? String(cp.customerId) : null, cp.apiBase, cp.instanceToken])
        .catch(() => {});
    }
  }

  // ── gateway_deliveries / gateway_contacts — таблицы ШЛЮЗА (gateway/) ────
  // Живут в той же БД: один источник правды, бэкенд их только создаёт.
  await client.query(`
    CREATE TABLE IF NOT EXISTS gateway_deliveries (
      id BIGSERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES messenger_accounts(id) ON DELETE CASCADE,
      chat_id BIGINT,
      phone VARCHAR(32),
      kind VARCHAR(16) NOT NULL DEFAULT 'text',
      text TEXT,
      status_id SMALLINT NOT NULL DEFAULT 1,
      description VARCHAR(64) NOT NULL DEFAULT 'Принято',
      tdlib_message_id BIGINT,
      error TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`
    CREATE TABLE IF NOT EXISTS gateway_contacts (
      account_id INTEGER NOT NULL REFERENCES messenger_accounts(id) ON DELETE CASCADE,
      phone VARCHAR(32) NOT NULL,
      user_id BIGINT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (account_id, phone)
    )
  `).catch(() => {});
```

ГОТЧА: условие `WHERE NOT EXISTS (… WHERE salon_id = $1)` стоит на уровне всего запроса, поэтому три строки вставляются атомарно одним INSERT. Если написать три INSERT в цикле с тем же условием, второй уже не пройдёт (первая строка салона появилась) — не делать.

- [ ] **Step 2: Прогнать миграцию на деве и проверить строки**

Run: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro && sleep 5 && pm2 logs loyalpro --lines 30 --nostream | grep -i "migrat\|error" | tail -5`
Expected: без строк `error` про `messenger_accounts`.

Затем через MCP `mcp__postgres__query`:
```sql
SELECT id, salon_id, provider, channel, external_id, status FROM messenger_accounts ORDER BY id;
```
Expected: три строки `chatpush` для салона из `CHATPUSH_SALON_ID` (на деве — 1), каналы whatsapp/tdlib/max.

- [ ] **Step 3: Коммит**

```bash
cd /root/loyalpro && git add backend/migrations.js && git commit -m "feat(messaging): таблица messenger_accounts + сид из env, таблицы шлюза

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 2: Реестр аккаунтов `services/messaging/accounts.js`

**Files:**
- Create: `backend/services/messaging/accounts.js`
- Create: `backend/messaging-accounts.test.js`
- Modify: `backend/config.js` (блок `MESSAGING_GATEWAY`)

- [ ] **Step 1: Добавить конфиг шлюза**

В `backend/config.js` сразу ПОСЛЕ блока `CHATPUSH: { ... },` вставить:

```js
  // Свой шлюз мессенджеров (gateway/). url — внутренний адрес (отправка идёт
  // по Chatpush-совместимому API шлюза), secret — заголовок X-Gateway-Secret
  // для внутреннего API (старт/авторизация аккаунтов), webhookSecret — ?key=
  // у /gateway/webhook, которым шлюз шлёт события в бэкенд. Пусто → шлюз
  // не подключён, подключать Telegram из админки нельзя (503).
  MESSAGING_GATEWAY: {
    url:           process.env.MESSAGING_GATEWAY_URL           || '',
    secret:        process.env.MESSAGING_GATEWAY_SECRET        || '',
    webhookSecret: process.env.GATEWAY_WEBHOOK_SECRET          || '',
  },
```

- [ ] **Step 2: Написать падающие тесты**

`backend/messaging-accounts.test.js`:

```js
'use strict';

jest.mock('./db', () => ({ db: { query: jest.fn(), oneOrNone: jest.fn(), any: jest.fn() } }));
jest.mock('./config', () => ({
  CHATPUSH: { apiBase: 'https://api.chatpush.ru', instanceToken: 'ENVTOKEN', customerId: 777, salonId: 1 },
  MESSAGING_GATEWAY: { url: 'http://127.0.0.1:3002', secret: 's', webhookSecret: 'w' },
}));

const { db } = require('./db');
const accounts = require('./services/messaging/accounts');

beforeEach(() => { jest.clearAllMocks(); accounts.invalidate(); });

describe('credentialsFor', () => {
  test('строка chatpush → apiBase из строки, token из строки', async () => {
    db.oneOrNone.mockResolvedValueOnce({ id: 5, provider: 'chatpush', channel: 'tdlib', api_base: 'https://api.chatpush.ru', token: 'ROWTOKEN' });
    const c = await accounts.credentialsFor(1, 'tdlib');
    expect(c).toEqual({ id: 5, provider: 'chatpush', channel: 'tdlib', apiBase: 'https://api.chatpush.ru', token: 'ROWTOKEN' });
    const [sql, params] = db.oneOrNone.mock.calls[0];
    expect(sql).toMatch(/FROM messenger_accounts/);
    expect(sql).toMatch(/status = 'active'/);
    expect(params).toEqual([1, 'tdlib']);
  });

  test('строка gateway → apiBase из config.MESSAGING_GATEWAY.url, не из строки', async () => {
    db.oneOrNone.mockResolvedValueOnce({ id: 9, provider: 'gateway', channel: 'tdlib', api_base: null, token: 'GW' });
    const c = await accounts.credentialsFor(1, 'tdlib');
    expect(c.apiBase).toBe('http://127.0.0.1:3002');
    expect(c.token).toBe('GW');
  });

  test('строки нет, салон из env → legacy-креды из env', async () => {
    db.oneOrNone.mockResolvedValueOnce(null);
    const c = await accounts.credentialsFor(1, 'whatsapp');
    expect(c).toEqual({ id: 'env', provider: 'chatpush', channel: 'whatsapp', apiBase: 'https://api.chatpush.ru', token: 'ENVTOKEN' });
  });

  test('строки нет, чужой салон → null (не подставлять чужой токен)', async () => {
    db.oneOrNone.mockResolvedValueOnce(null);
    expect(await accounts.credentialsFor(2, 'whatsapp')).toBeNull();
  });

  test('кэш 60 с: второй вызов не ходит в БД, invalidate сбрасывает', async () => {
    db.oneOrNone.mockResolvedValue({ id: 5, provider: 'chatpush', channel: 'max', api_base: 'x', token: 't' });
    await accounts.credentialsFor(1, 'max');
    await accounts.credentialsFor(1, 'max');
    expect(db.oneOrNone).toHaveBeenCalledTimes(1);
    accounts.invalidate();
    await accounts.credentialsFor(1, 'max');
    expect(db.oneOrNone).toHaveBeenCalledTimes(2);
  });

  test('сбой БД → fallback на env для своего салона, null для чужого', async () => {
    db.oneOrNone.mockRejectedValue(new Error('db down'));
    expect((await accounts.credentialsFor(1, 'tdlib')).token).toBe('ENVTOKEN');
    expect(await accounts.credentialsFor(2, 'tdlib')).toBeNull();
  });
});

describe('resolveSalon', () => {
  test('по (provider, external_id) из БД', async () => {
    db.oneOrNone.mockResolvedValueOnce({ salon_id: 3 });
    expect(await accounts.resolveSalon('gateway', 12)).toBe(3);
    expect(db.oneOrNone.mock.calls[0][1]).toEqual(['gateway', '12']);
  });
  test('chatpush без строки → env-мэппинг (customer совпал)', async () => {
    db.oneOrNone.mockResolvedValueOnce(null);
    expect(await accounts.resolveSalon('chatpush', 777)).toBe(1);
  });
  test('chatpush без строки, customer не совпал → null', async () => {
    db.oneOrNone.mockResolvedValueOnce(null);
    expect(await accounts.resolveSalon('chatpush', 1)).toBeNull();
  });
  test('gateway без строки → null (env к шлюзу не относится)', async () => {
    db.oneOrNone.mockResolvedValueOnce(null);
    expect(await accounts.resolveSalon('gateway', 777)).toBeNull();
  });
});

describe('listForSalon', () => {
  test('отдаёт строки салона без токена', async () => {
    db.any.mockResolvedValueOnce([{ id: 1, provider: 'chatpush', channel: 'tdlib', status: 'active', token: 'SECRET', phone: null, auth_state: null, auth_error: null, display_name: 'x', created_at: 'd' }]);
    const rows = await accounts.listForSalon(1);
    expect(rows[0].token).toBeUndefined();
    expect(rows[0]).toMatchObject({ id: 1, provider: 'chatpush', channel: 'tdlib', status: 'active' });
  });
});
```

- [ ] **Step 3: Запустить — убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest messaging-accounts 2>&1 | tail -5`
Expected: FAIL, `Cannot find module './services/messaging/accounts'`.

- [ ] **Step 4: Реализовать модуль**

`backend/services/messaging/accounts.js`:

```js
'use strict';
// ============================================================
// Messaging accounts — аккаунты мессенджеров по салонам (messenger_accounts).
// ------------------------------------------------------------
// credentialsFor(salonId, channel) → {id, provider, channel, apiBase, token}
//   Куда и с каким токеном слать в ЭТОМ канале ЭТОГО салона. У провайдера
//   'gateway' apiBase всегда из config.MESSAGING_GATEWAY.url (адрес шлюза —
//   настройка процесса, а не салона). Нет строки → legacy-фолбэк на env ТОЛЬКО
//   для салона CHATPUSH_SALON_ID (чужому салону чужой токен не подставляем).
// resolveSalon(provider, externalId) → salon_id | null
//   Обратная задача для вебхука: от кого пришло событие.
// Кэш 60 с по ключу salon:channel — функция зовётся на каждую отправку.
// ============================================================
const { db } = require('../../db');
const config = require('../../config');

const TTL_MS = 60 * 1000;
const cache = new Map();   // `${salonId}:${channel}` → { at, value }

function envCreds(salonId, channel) {
  const cp = config.CHATPUSH || {};
  if (!cp.instanceToken || !cp.salonId || Number(cp.salonId) !== Number(salonId)) return null;
  return { id: 'env', provider: 'chatpush', channel, apiBase: cp.apiBase, token: cp.instanceToken };
}

function rowToCreds(row) {
  const gw = config.MESSAGING_GATEWAY || {};
  return {
    id: row.id,
    provider: row.provider,
    channel: row.channel,
    apiBase: row.provider === 'gateway' ? (gw.url || '') : (row.api_base || (config.CHATPUSH || {}).apiBase || ''),
    token: row.token,
  };
}

async function credentialsFor(salonId, channel) {
  const key = `${salonId}:${channel}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value = null;
  try {
    const row = await db.oneOrNone(
      `SELECT id, provider, channel, api_base, token
         FROM messenger_accounts
        WHERE salon_id = $1 AND channel = $2 AND status = 'active'
        LIMIT 1`,
      [salonId, channel]);
    value = row ? rowToCreds(row) : envCreds(salonId, channel);
  } catch (_) {
    value = envCreds(salonId, channel);
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function resolveSalon(provider, externalId) {
  if (externalId === undefined || externalId === null) return provider === 'chatpush' ? envSalon(null) : null;
  try {
    const row = await db.oneOrNone(
      `SELECT salon_id FROM messenger_accounts WHERE provider = $1 AND external_id = $2 LIMIT 1`,
      [provider, String(externalId)]);
    if (row) return row.salon_id;
  } catch (_) { /* fallback ниже */ }
  return provider === 'chatpush' ? envSalon(externalId) : null;
}

// Прежний single-tenant мэппинг из env (routes/chatpush-webhook.resolveSalonId).
function envSalon(customerId) {
  const cp = config.CHATPUSH || {};
  if (cp.salonId && (!cp.customerId || Number(cp.customerId) === Number(customerId))) return cp.salonId;
  return null;
}

async function listForSalon(salonId) {
  const rows = await db.any(
    `SELECT id, provider, channel, status, display_name, phone, auth_state, auth_error, created_at
       FROM messenger_accounts WHERE salon_id = $1 ORDER BY channel, id`,
    [salonId]);
  return rows.map(r => ({ ...r, token: undefined }));
}

function invalidate() { cache.clear(); }

module.exports = { credentialsFor, resolveSalon, listForSalon, invalidate, TTL_MS };
```

- [ ] **Step 5: Прогнать тесты**

Run: `cd /root/loyalpro/backend && npx jest messaging-accounts 2>&1 | tail -5`
Expected: PASS, 11 tests.

- [ ] **Step 6: Коммит**

```bash
cd /root/loyalpro && git add backend/config.js backend/services/messaging/accounts.js backend/messaging-accounts.test.js && git commit -m "feat(messaging): реестр аккаунтов мессенджеров по салонам (credentialsFor/resolveSalon)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 3: `chatpush.js` принимает креды объектом

**Files:**
- Modify: `backend/services/chatpush.js` (функции `sendMessage`, `sendFile`, `getDeliveryStatus`)
- Modify: `backend/chat.test.js` (добавить сьют) — или создать `backend/chatpush-creds.test.js`

- [ ] **Step 1: Тест**

Создать `backend/chatpush-creds.test.js`:

```js
'use strict';
jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
const axios = require('axios');
const chatpush = require('./services/chatpush');

beforeEach(() => jest.clearAllMocks());

test('sendMessage: строка-токен → apiBase из config, Bearer = строка', async () => {
  axios.post.mockResolvedValueOnce({ data: { meta: { status: 'success' }, delivery: { id: 1 } } });
  await chatpush.sendMessage('TOK', { text: 'hi', phone: '79001112233', dispatchRouting: ['tdlib'] });
  const [url, , opts] = axios.post.mock.calls[0];
  expect(url).toMatch(/^https:\/\/api\.chatpush\.ru\/api\/v1\/delivery\?/);
  expect(opts.headers.Authorization).toBe('Bearer TOK');
});

test('sendMessage: объект {apiBase, token} → свой base и свой Bearer', async () => {
  axios.post.mockResolvedValueOnce({ data: { meta: { status: 'success' }, delivery: { id: 'g1' } } });
  const d = await chatpush.sendMessage({ apiBase: 'http://127.0.0.1:3002', token: 'GW' }, { text: 'hi', phone: '79001112233', dispatchRouting: ['tdlib'] });
  const [url, , opts] = axios.post.mock.calls[0];
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:3002\/api\/v1\/delivery\?/);
  expect(opts.headers.Authorization).toBe('Bearer GW');
  expect(d).toEqual({ id: 'g1' });
});

test('getDeliveryStatus: объект кредов', async () => {
  axios.get.mockResolvedValueOnce({ data: { delivery: { id: 'g1', status: { status_id: 2 } } } });
  await chatpush.getDeliveryStatus({ apiBase: 'http://127.0.0.1:3002', token: 'GW' }, 'g1');
  expect(axios.get.mock.calls[0][0]).toBe('http://127.0.0.1:3002/api/v1/delivery/g1');
});

test('sendFile: объект кредов', async () => {
  axios.post.mockResolvedValueOnce({ data: { meta: { status: 'success' }, delivery: { id: 'g2' } } });
  await chatpush.sendFile({ apiBase: 'http://127.0.0.1:3002', token: 'GW' },
    { fileName: 'a.jpg', type: 'image', phone: '79001112233', dispatchRouting: ['tdlib'] }, Buffer.from('x'), 'image/jpeg');
  expect(axios.post.mock.calls[0][0]).toMatch(/^http:\/\/127\.0\.0\.1:3002\/api\/v1\/send_file\?/);
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /root/loyalpro/backend && npx jest chatpush-creds 2>&1 | tail -8`
Expected: FAIL — url начинается с `https://api.chatpush.ru` в тестах с объектом.

- [ ] **Step 3: Реализовать**

В `backend/services/chatpush.js` после `const { apiBase, apiKey, instanceToken } = config.CHATPUSH;` добавить:

```js
/**
 * Креды отправки: строка — Bearer-токен инстанса Chatpush (apiBase из config,
 * прежний контракт), объект {apiBase, token} — любой Chatpush-совместимый
 * провайдер (наш шлюз gateway/ говорит на том же API). Источник объектов —
 * services/messaging/accounts.credentialsFor.
 */
function authOf(creds) {
  if (creds && typeof creds === 'object') {
    return { base: (creds.apiBase || apiBase).replace(/\/+$/, ''), token: creds.token };
  }
  return { base: apiBase, token: creds };
}
```

В `sendMessage`: заменить сигнатуру `async function sendMessage(instanceToken, {...})` на `async function sendMessage(creds, {...})`, в начале тела `const { base, token } = authOf(creds);`, URL — `${base}/api/v1/delivery?${query}`, заголовок — `Bearer ${token}`.

В `sendFile`: то же — `creds`, `const { base, token } = authOf(creds);`, `${base}/api/v1/send_file?${query}`, `Bearer ${token}`.

В `getDeliveryStatus(creds, id)`: `const { base, token } = authOf(creds);`, `${base}/api/v1/delivery/${id}`, `Bearer ${token}`.

Функции webhooks/getAccount не трогать (они про Chatpush-инстанс).

- [ ] **Step 4: Прогнать**

Run: `cd /root/loyalpro/backend && npx jest chatpush-creds chat 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/chatpush.js backend/chatpush-creds.test.js && git commit -m "feat(chatpush): креды отправки объектом {apiBase, token} — под Chatpush-совместимый шлюз

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 4: Единая отправка `services/messaging/transport.js`

**Files:**
- Create: `backend/services/messaging/transport.js`
- Create: `backend/messaging-transport.test.js`

- [ ] **Step 1: Тесты**

`backend/messaging-transport.test.js`:

```js
'use strict';
jest.mock('./services/messaging/accounts', () => ({ credentialsFor: jest.fn() }));
jest.mock('./services/chatpush', () => ({ sendMessage: jest.fn(), sendFile: jest.fn(), getDeliveryStatus: jest.fn() }));
jest.mock('./config', () => ({ CHATPUSH: { instanceToken: '' }, MESSAGING_GATEWAY: { url: '' } }));

const accounts = require('./services/messaging/accounts');
const chatpush = require('./services/chatpush');
const transport = require('./services/messaging/transport');

const CP = { id: 5, provider: 'chatpush', apiBase: 'https://api.chatpush.ru', token: 'CP' };
const GW = { id: 9, provider: 'gateway', apiBase: 'http://127.0.0.1:3002', token: 'GW' };

beforeEach(() => jest.clearAllMocks());

describe('sendMessage', () => {
  test('все каналы на одном аккаунте Chatpush → ОДИН вызов с полным routing (фолбэк делает Chatpush)', async () => {
    accounts.credentialsFor.mockImplementation(async (s, ch) => ({ ...CP, channel: ch }));
    chatpush.sendMessage.mockResolvedValueOnce({ id: 1 });
    const d = await transport.sendMessage(1, { text: 'hi', phone: '79001112233', dispatchRouting: ['whatsapp', 'tdlib'] });
    expect(d).toEqual({ id: 1 });
    expect(chatpush.sendMessage).toHaveBeenCalledTimes(1);
    expect(chatpush.sendMessage.mock.calls[0][0]).toMatchObject({ token: 'CP' });
    expect(chatpush.sendMessage.mock.calls[0][1].dispatchRouting).toEqual(['whatsapp', 'tdlib']);
  });

  test('каналы на РАЗНЫХ аккаунтах → по вызову на аккаунт, первый успешный побеждает', async () => {
    accounts.credentialsFor.mockImplementation(async (s, ch) => (ch === 'tdlib' ? { ...GW, channel: ch } : { ...CP, channel: ch }));
    chatpush.sendMessage.mockRejectedValueOnce(new Error('wa down')).mockResolvedValueOnce({ id: 'g1' });
    const d = await transport.sendMessage(1, { text: 'hi', phone: '79001112233', dispatchRouting: ['whatsapp', 'tdlib'] });
    expect(d).toEqual({ id: 'g1' });
    expect(chatpush.sendMessage).toHaveBeenCalledTimes(2);
    expect(chatpush.sendMessage.mock.calls[0][1].dispatchRouting).toEqual(['whatsapp']);
    expect(chatpush.sendMessage.mock.calls[1][0]).toMatchObject({ token: 'GW' });
    expect(chatpush.sendMessage.mock.calls[1][1].dispatchRouting).toEqual(['tdlib']);
  });

  test('канал без аккаунта пропускается; ни одного аккаунта → ошибка с перечислением каналов', async () => {
    accounts.credentialsFor.mockResolvedValue(null);
    await expect(transport.sendMessage(1, { text: 'hi', phone: 'x', dispatchRouting: ['max'] }))
      .rejects.toThrow(/нет аккаунта мессенджера.*max/);
    expect(chatpush.sendMessage).not.toHaveBeenCalled();
  });

  test('все вызовы упали → бросается ПОСЛЕДНЯЯ ошибка', async () => {
    accounts.credentialsFor.mockImplementation(async (s, ch) => (ch === 'tdlib' ? { ...GW, channel: ch } : { ...CP, channel: ch }));
    chatpush.sendMessage.mockRejectedValueOnce(new Error('one')).mockRejectedValueOnce(new Error('two'));
    await expect(transport.sendMessage(1, { text: 'hi', phone: 'x', dispatchRouting: ['whatsapp', 'tdlib'] })).rejects.toThrow('two');
  });

  test('salonId обязателен', async () => {
    await expect(transport.sendMessage(null, { text: 'hi', dispatchRouting: ['tdlib'] })).rejects.toThrow(/salonId/);
  });
});

describe('sendFile / getDeliveryStatus', () => {
  test('sendFile идёт по первому каналу с аккаунтом', async () => {
    accounts.credentialsFor.mockResolvedValueOnce({ ...GW, channel: 'tdlib' });
    chatpush.sendFile.mockResolvedValueOnce({ id: 'g2' });
    const buf = Buffer.from('x');
    const d = await transport.sendFile(1, { fileName: 'a.jpg', type: 'image', phone: 'p', dispatchRouting: ['tdlib'] }, buf, 'image/jpeg');
    expect(d).toEqual({ id: 'g2' });
    expect(chatpush.sendFile.mock.calls[0][0]).toMatchObject({ token: 'GW' });
    expect(chatpush.sendFile.mock.calls[0][2]).toBe(buf);
  });
  test('getDeliveryStatus(salonId, channel, id)', async () => {
    accounts.credentialsFor.mockResolvedValueOnce({ ...GW, channel: 'tdlib' });
    chatpush.getDeliveryStatus.mockResolvedValueOnce({ id: 'g1' });
    expect(await transport.getDeliveryStatus(1, 'tdlib', 'g1')).toEqual({ id: 'g1' });
    expect(chatpush.getDeliveryStatus.mock.calls[0][0]).toMatchObject({ token: 'GW' });
  });
  test('getDeliveryStatus без аккаунта → null', async () => {
    accounts.credentialsFor.mockResolvedValueOnce(null);
    expect(await transport.getDeliveryStatus(1, 'tdlib', 'g1')).toBeNull();
  });
});

describe('configured', () => {
  test('false, когда ни env-токена, ни шлюза', () => {
    expect(transport.configured()).toBe(false);
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /root/loyalpro/backend && npx jest messaging-transport 2>&1 | tail -5`
Expected: FAIL, модуль не найден.

- [ ] **Step 3: Реализовать**

`backend/services/messaging/transport.js`:

```js
'use strict';
// ============================================================
// Transport — единая отправка в мессенджеры по салону и каналу.
// ------------------------------------------------------------
// Раньше 9 мест звали chatpush.sendMessage(config.CHATPUSH.instanceToken, …):
// один токен на весь процесс. Теперь аккаунт выбирается через
// messaging/accounts.credentialsFor(salonId, channel). dispatchRouting — это
// порядок фолбэка по каналам; соседние каналы ОДНОГО аккаунта уходят одним
// вызовом (Chatpush умеет фолбэк сам, прежнее поведение сохранено), каналы
// разных аккаунтов — отдельными вызовами по порядку, побеждает первый успешный.
// ============================================================
const chatpush = require('../chatpush');
const accounts = require('./accounts');
const config = require('../../config');

async function groupsFor(salonId, routing) {
  const groups = [];
  for (const ch of routing) {
    const creds = await accounts.credentialsFor(salonId, ch);
    if (!creds) continue;
    const last = groups[groups.length - 1];
    if (last && String(last.creds.id) === String(creds.id)) last.channels.push(ch);
    else groups.push({ creds, channels: [ch] });
  }
  return groups;
}

function requireSalon(salonId) {
  if (salonId === undefined || salonId === null) throw new Error('transport: salonId обязателен');
}

async function sendMessage(salonId, payload) {
  requireSalon(salonId);
  const routing = Array.isArray(payload.dispatchRouting) ? payload.dispatchRouting : [payload.dispatchRouting].filter(Boolean);
  const groups = await groupsFor(salonId, routing);
  if (!groups.length) throw new Error(`нет аккаунта мессенджера у салона ${salonId} для каналов [${routing.join(',')}]`);
  let lastErr = null;
  for (const g of groups) {
    try {
      return await chatpush.sendMessage(g.creds, { ...payload, dispatchRouting: g.channels });
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function sendFile(salonId, payload, buffer, mimeType) {
  requireSalon(salonId);
  const routing = Array.isArray(payload.dispatchRouting) ? payload.dispatchRouting : [payload.dispatchRouting].filter(Boolean);
  const groups = await groupsFor(salonId, routing);
  if (!groups.length) throw new Error(`нет аккаунта мессенджера у салона ${salonId} для каналов [${routing.join(',')}]`);
  let lastErr = null;
  for (const g of groups) {
    try {
      return await chatpush.sendFile(g.creds, { ...payload, dispatchRouting: g.channels }, buffer, mimeType);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function getDeliveryStatus(salonId, channel, deliveryId) {
  requireSalon(salonId);
  const creds = await accounts.credentialsFor(salonId, replyChannel(channel));
  if (!creds) return null;
  return chatpush.getDeliveryStatus(creds, deliveryId);
}

// telegram_bot в событиях = routing-канал telegram (как chatpush.replyRoutingFor).
function replyChannel(channel) { return channel === 'telegram_bot' ? 'telegram' : channel; }

// Есть ли куда слать вообще (гейт запуска воркеров вместо проверки env-токена).
function configured() {
  return !!((config.CHATPUSH && config.CHATPUSH.instanceToken) || (config.MESSAGING_GATEWAY && config.MESSAGING_GATEWAY.url));
}

module.exports = { sendMessage, sendFile, getDeliveryStatus, configured };
```

- [ ] **Step 4: Прогнать**

Run: `cd /root/loyalpro/backend && npx jest messaging-transport 2>&1 | tail -5`
Expected: PASS, 9 tests.

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/messaging/transport.js backend/messaging-transport.test.js && git commit -m "feat(messaging): transport — единая отправка по салону и каналу с фолбэком между аккаунтами

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 5: Перевести все отправки на `transport`

**Files:**
- Modify: `backend/services/agent/dispatcher.js:72-80, 426-500`
- Modify: `backend/routes/chat.js:268-330, 370-400`
- Modify: `backend/services/notifications.js:248, 302`
- Modify: `backend/services/agent/delivery-watchdog.js:199-207`
- Modify: `backend/services/agent/followup-worker.js:145, 703, 838`
- Modify: `backend/services/care/worker.js:83, 392, 509`
- Modify: `backend/services/reminders/worker.js:169, 576, 829`

- [ ] **Step 1: dispatcher.js**

В `process(salonId, dialogKey, meta, opts)` сразу после проверки `isGroupDialog` добавить:

```js
  // Отправка идёт по аккаунту САЛОНА (services/messaging/transport): defaultSend
  // читает салон из meta. Мутируем meta, а не копируем: опции/тесты передают
  // тот же объект в send(meta, …) и ждут его же.
  if (meta && meta.salonId == null) meta.salonId = salonId;
```

`defaultSend`:
```js
async function defaultSend(meta, text) {
  if (meta.salonId == null) { logger.error('defaultSend: meta.salonId не задан — некуда слать'); return null; }
  const params = recipientParams(meta.channel, {
    phone: meta.phone,
    chat_id: meta.chatId,
    isGroup: groupChat.isGroupMessage(meta),
  });
  if (!params) {
    logger.error(`нет получателя для ответа ${meta.channel} phone=${meta.phone || ''} chatId=${meta.chatId || ''}`);
    return null;
  }
  const delivery = await transport.sendMessage(meta.salonId, {
    text,
    ...params,
    replyToMessageId: meta.messageId,
  });
```
(остальное тело без изменений). Удалить строки `const token = config.CHATPUSH.instanceToken; if (!token) {…}`.

`defaultSendFile`: аналогично — убрать проверку токена, добавить проверку `meta.salonId`, вызов `transport.sendFile(meta.salonId, { fileName: …, type: 'image', ...params }, buf, att.mimeType)`.

В начале файла: `const transport = require('../messaging/transport');`. Если `config` после правок больше нигде в файле не используется — `require('../../config')` оставить (он используется в других местах диспетчера; проверить `grep -n "config\." services/agent/dispatcher.js`).

- [ ] **Step 2: routes/chat.js**

Добавить `const transport = require('../services/messaging/transport');`.

`scheduleDeliveryCheck(deliveryId, { key, channel, kind, salonId }, deps)`: заменить дефолт
```js
  const get = deps.getDeliveryStatus
    || ((id) => transport.getDeliveryStatus(salonId, channel, id));
```
и в обоих местах вызова передать `salonId`: `scheduleDeliveryCheck(delivery && delivery.id, { key, channel, salonId })` и `{ key, channel, kind: 'file', salonId }`.

`POST /dialogs/:key/send`: `const delivery = await transport.sendMessage(salonId, { text, ...params, replyToMessageId: rcp.reply_to || undefined });`

`POST …/send-file`: `const delivery = await transport.sendFile(salonId, { fileName, caption, type: isImage ? 'image' : 'document', ...params }, req.file.buffer, req.file.mimetype);`

Проверить: `grep -n "chatpush\.\|config.CHATPUSH" routes/chat.js` — `chatpush.` может остаться только для `ownOutgoingExternalId`/`replyRoutingFor`; `config.CHATPUSH.instanceToken` — ни одного вхождения.

- [ ] **Step 3: notifications.js**

Строка 248: `const delivery = await transport.sendMessage(row.salon_id, { text: row.rendered_text, phone: row.phone, dispatchRouting: routing });`

Строка 302 (гейт запуска воркера): заменить `if (!config.CHATPUSH.instanceToken) { log.warn('CHATPUSH_INSTANCE_TOKEN is not set — notification worker disabled'); return; }` на
```js
  if (!transport.configured()) {
    log.warn('ни CHATPUSH_INSTANCE_TOKEN, ни MESSAGING_GATEWAY_URL не заданы — notification worker disabled');
    return;
  }
```
Добавить `const transport = require('./messaging/transport');`.

- [ ] **Step 4: delivery-watchdog.js**

`defaultResend`:
```js
async function defaultResend(row) {
  const transport = require('../messaging/transport');
  return transport.sendMessage(row.salon_id, {
    text: row.text,
    phone: row.phone,
    dispatchRouting: [chatpush.replyRoutingFor(row.channel)],
    replyToMessageId: row.reply_to_message_id,
  });
}
```
(`require` внутри функции — как у `cleanup` в том же файле, чтобы не тянуть БД-модули в чистые тесты.)

- [ ] **Step 5: followup-worker.js, care/worker.js, reminders/worker.js**

Во всех трёх в `defaultDeps`:
```js
  sendMessage: (payload) => transport.sendMessage(payload.salonId, payload),
```
и в месте вызова добавить салон в payload:
- followup-worker.js:703 → `const delivery = await d.sendMessage({ salonId: row.salon_id, text, ...recipient });`
- care/worker.js:392 → `const delivery = await d.sendMessage({ salonId: row.salon_id, text, phone: row.phone, dispatchRouting: routing });`
- reminders/worker.js:576 → `const delivery = await d.sendMessage({ salonId: row.salon_id, text, phone: row.phone, dispatchRouting: routing });`

Гейты запуска (followup 838, care 509, reminders 829): `if (!config.CHATPUSH.instanceToken)` → `if (!transport.configured())` с тем же текстом WARN, что в Step 3. В каждом файле добавить `const transport = require('<относительный путь>/messaging/transport');` (`../messaging/transport` из `services/agent`, `../messaging/transport` из `services/care` и `services/reminders`).

- [ ] **Step 6: Полный прогон Jest и правка ожиданий**

Run: `cd /root/loyalpro/backend && npx jest 2>&1 | tail -30`

Ожидаемые падения и как чинить:
- Тесты воркеров, которые проверяют `sendMessage` через `toHaveBeenCalledWith({ text: …, phone: …, dispatchRouting: … })` точным равенством, теперь видят лишнее поле `salonId`. Чинить добавлением `salonId: <id салона из фикстуры>` в ожидаемый объект (НЕ `expect.objectContaining` — поле обязано присутствовать, это и проверяем).
- Тесты, где `jest.mock('./services/chatpush')` стабил `sendMessage` и ждал первым аргументом строку-токен (`expect(chatpush.sendMessage.mock.calls[0][0]).toBe('…')`), ломаются, потому что теперь вызов идёт через `transport` → `accounts.credentialsFor` → БД-мок. В таких тестах добавить `jest.mock('./services/messaging/transport', () => ({ sendMessage: jest.fn(), sendFile: jest.fn(), getDeliveryStatus: jest.fn(), configured: () => true }))` и переписать ожидания на `transport.sendMessage.mock.calls[0]` (`[salonId, payload]`).
- Известный флейк `primary-clients.test.js` (зовёт `process.exit(1)`) — к этой задаче не относится.

Expected после правок: все сьюты зелёные, кроме известного флейка.

- [ ] **Step 7: Живая проверка на деве**

`PORT=3001 pm2 restart loyalpro`, затем из «Чата» отправить тестовое сообщение в диалог тестового номера `79200255591` (канал tdlib). В логе:
Run: `tail -50 /root/loyalpro/backend/logs/*.log | grep -i "operator sent\|delivery="`
Expected: строка `operator sent tdlib to 79200255591: delivery=<число>` — отправка прошла через Chatpush-строку из БД.

- [ ] **Step 8: Коммит**

```bash
cd /root/loyalpro && git add backend/services backend/routes && git commit -m "refactor(messaging): все отправки через transport по аккаунту салона, env-токен — только фолбэк

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 6: Вебхук: провайдер из пути, салон из реестра

**Files:**
- Modify: `backend/routes/chatpush-webhook.js:35-65, 93-105`
- Modify: `backend/routes/index.js:13`
- Create: `backend/chatpush-webhook-provider.test.js`

- [ ] **Step 1: Тест**

`backend/chatpush-webhook-provider.test.js`:

```js
'use strict';
jest.mock('./config', () => ({
  CHATPUSH: { webhookSecret: 'cpsecret', agentEnabled: false, salonId: 1, customerId: 777 },
  MESSAGING_GATEWAY: { webhookSecret: 'gwsecret' },
}));
const { verifySecret, providerOf } = require('./routes/chatpush-webhook');

const req = (baseUrl, key) => ({ baseUrl, query: key === undefined ? {} : { key } });

test('providerOf: /gateway → gateway, иначе chatpush', () => {
  expect(providerOf({ baseUrl: '/gateway' })).toBe('gateway');
  expect(providerOf({ baseUrl: '/chatpush' })).toBe('chatpush');
  expect(providerOf({ baseUrl: '' })).toBe('chatpush');
});

test('verifySecret сверяет ключ СВОЕГО провайдера', () => {
  expect(verifySecret(req('/chatpush', 'cpsecret')).ok).toBe(true);
  expect(verifySecret(req('/chatpush', 'gwsecret')).ok).toBe(false);
  expect(verifySecret(req('/gateway', 'gwsecret')).ok).toBe(true);
  expect(verifySecret(req('/gateway', 'cpsecret')).ok).toBe(false);
  expect(verifySecret(req('/gateway')).ok).toBe(false);
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /root/loyalpro/backend && npx jest chatpush-webhook-provider 2>&1 | tail -5`
Expected: FAIL — `verifySecret`/`providerOf` не экспортированы.

- [ ] **Step 3: Реализовать**

В `backend/routes/chatpush-webhook.js`:

Заменить `verifySecret`:
```js
// Провайдер — из точки монтирования: тот же роутер стоит на /chatpush и /gateway
// (routes/index.js). У каждого свой секрет и своя таблица «кто прислал».
function providerOf(req) {
  return String(req.baseUrl || '').startsWith('/gateway') ? 'gateway' : 'chatpush';
}

function verifySecret(req) {
  const provider = providerOf(req);
  const secret = provider === 'gateway'
    ? config.MESSAGING_GATEWAY.webhookSecret
    : config.CHATPUSH.webhookSecret;
  // У шлюза legacy-режима нет: это наш собственный процесс, секрет задаётся при установке.
  if (!secret) return provider === 'gateway' ? { ok: false, reason: 'gateway secret not configured' } : { ok: true, mode: 'legacy' };
  const provided = typeof req.query.key === 'string' ? req.query.key : '';
  if (!provided) return { ok: false, reason: 'missing key' };
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return { ok: false, reason: 'key mismatch' };
  return crypto.timingSafeEqual(a, b)
    ? { ok: true, mode: 'verified' }
    : { ok: false, reason: 'key mismatch' };
}
```

Удалить `resolveSalonId` целиком. В обработчике заменить
```js
  const customerId = body.payload?.instance?.customer_id ?? msg?.customerId ?? null;
  const salonId = resolveSalonId(customerId);
```
на
```js
  const customerId = body.payload?.instance?.customer_id ?? msg?.customerId ?? null;
  const salonId = await accounts.resolveSalon(providerOf(req), customerId);
```
Добавить `const accounts = require('../services/messaging/accounts');`.

В конец файла: `module.exports = router; module.exports.verifySecret = verifySecret; module.exports.providerOf = providerOf;`

В `backend/routes/index.js` после строки 13 (`app.use('/chatpush', require('./chatpush-webhook'));`) добавить:
```js
  // Тот же приёмник для нашего шлюза (gateway/): события в формате Chatpush.
  app.use('/gateway', require('./chatpush-webhook'));
```

- [ ] **Step 4: Прогнать**

Run: `cd /root/loyalpro/backend && npx jest chatpush-webhook 2>&1 | tail -5`
Expected: PASS (новый сьют + существующие тесты вебхука, если есть).

- [ ] **Step 5: Живая проверка: входящее от Chatpush по-прежнему ложится в салон**

`PORT=3001 pm2 restart loyalpro`; написать с тестового номера в Telegram клиники; через MCP:
```sql
SELECT id, salon_id, channel, direction, text FROM chatpush_messages ORDER BY id DESC LIMIT 1;
```
Expected: `salon_id = 1`, текст сообщения.

- [ ] **Step 6: Коммит**

```bash
cd /root/loyalpro && git add backend/routes/chatpush-webhook.js backend/routes/index.js backend/chatpush-webhook-provider.test.js && git commit -m "feat(messaging): вебхук резолвит салон по реестру аккаунтов; маунт /gateway для своего шлюза

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 7: Клиент шлюза и админ-API `/api/messaging`

**Files:**
- Create: `backend/services/messaging/gateway-client.js`
- Create: `backend/routes/messaging-accounts.js`
- Create: `backend/messaging-accounts-routes.test.js`
- Modify: `backend/routes/index.js` (маунт)

- [ ] **Step 1: gateway-client.js**

```js
'use strict';
// Внутренний API шлюза (gateway/server.js, /internal/*). Секрет — заголовок.
const axios = require('axios');
const config = require('../../config');

function base() {
  const url = (config.MESSAGING_GATEWAY && config.MESSAGING_GATEWAY.url) || '';
  if (!url) { const e = new Error('шлюз мессенджеров не настроен (MESSAGING_GATEWAY_URL)'); e.status = 503; throw e; }
  return url.replace(/\/+$/, '');
}
function headers() { return { 'X-Gateway-Secret': config.MESSAGING_GATEWAY.secret || '' }; }

async function call(method, path, body) {
  try {
    const { data } = await axios({ method, url: `${base()}${path}`, data: body, headers: headers(), timeout: 20000 });
    return data;
  } catch (e) {
    if (e.status === 503) throw e;
    const st = e.response && e.response.status;
    const msg = (e.response && e.response.data && e.response.data.error) || e.message;
    const err = new Error(`шлюз: ${msg}`); err.status = st || 502; throw err;
  }
}

module.exports = {
  start:  (id) => call('post', `/internal/accounts/${id}/start`),
  auth:   (id, step) => call('post', `/internal/accounts/${id}/auth`, step),
  status: (id) => call('get',  `/internal/accounts/${id}/status`),
  logout: (id) => call('post', `/internal/accounts/${id}/logout`),
};
```

- [ ] **Step 2: Тест маршрута (чистые помощники + проводка)**

`backend/messaging-accounts-routes.test.js`:

```js
'use strict';
jest.mock('./db', () => ({ db: { query: jest.fn(), oneOrNone: jest.fn(), any: jest.fn() } }));
jest.mock('./services/messaging/gateway-client', () => ({ start: jest.fn(), auth: jest.fn(), status: jest.fn(), logout: jest.fn() }));
jest.mock('./services/messaging/accounts', () => ({ listForSalon: jest.fn(), invalidate: jest.fn() }));
jest.mock('./config', () => ({ MESSAGING_GATEWAY: { url: 'http://127.0.0.1:3002', secret: 's' }, CHATPUSH: {} }));

const { db } = require('./db');
const gw = require('./services/messaging/gateway-client');
const accounts = require('./services/messaging/accounts');
const { createTelegramAccount, parseAuthStep } = require('./routes/messaging-accounts');

beforeEach(() => jest.clearAllMocks());

describe('parseAuthStep', () => {
  test('phone → цифры с 7', () => expect(parseAuthStep({ phone: '+7 (900) 111-22-33' })).toEqual({ phone: '79001112233' }));
  test('8 → 7', () => expect(parseAuthStep({ phone: '89001112233' })).toEqual({ phone: '79001112233' }));
  test('code → только цифры, 4–6', () => {
    expect(parseAuthStep({ code: ' 12345 ' })).toEqual({ code: '12345' });
    expect(parseAuthStep({ code: '12' })).toBeNull();
  });
  test('password как есть, непустой', () => {
    expect(parseAuthStep({ password: ' secret ' })).toEqual({ password: ' secret ' });
    expect(parseAuthStep({ password: '' })).toBeNull();
  });
  test('ничего → null', () => expect(parseAuthStep({})).toBeNull());
});

describe('createTelegramAccount', () => {
  test('гасит активную tdlib-строку другого провайдера, вставляет gateway-строку, зовёт start, сбрасывает кэш', async () => {
    db.oneOrNone.mockResolvedValueOnce(null);                 // активной gateway-строки нет
    db.query.mockResolvedValueOnce({ rowCount: 1 });           // disable chatpush tdlib
    db.oneOrNone.mockResolvedValueOnce({ id: 42 });            // INSERT … RETURNING id
    db.query.mockResolvedValueOnce({ rowCount: 1 });           // external_id = id
    gw.start.mockResolvedValueOnce({ authState: 'wait_phone' });
    const out = await createTelegramAccount(1);
    expect(out).toEqual({ id: 42, authState: 'wait_phone' });
    const disableSql = db.query.mock.calls[0][0];
    expect(disableSql).toMatch(/UPDATE messenger_accounts SET status = 'disabled'/);
    expect(db.query.mock.calls[0][1]).toEqual([1, 'tdlib']);
    const [insSql, insParams] = db.oneOrNone.mock.calls[1];
    expect(insSql).toMatch(/INSERT INTO messenger_accounts/);
    expect(insParams[0]).toBe(1);
    expect(insParams[1]).toMatch(/^[0-9a-f]{48}$/);           // token
    expect(gw.start).toHaveBeenCalledWith(42);
    expect(accounts.invalidate).toHaveBeenCalled();
  });

  test('активная gateway-строка уже есть → идемпотентно: start по ней, без вставки', async () => {
    db.oneOrNone.mockResolvedValueOnce({ id: 7 });
    gw.start.mockResolvedValueOnce({ authState: 'ready' });
    expect(await createTelegramAccount(1)).toEqual({ id: 7, authState: 'ready' });
    expect(db.query).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Запустить — падает**

Run: `cd /root/loyalpro/backend && npx jest messaging-accounts-routes 2>&1 | tail -5`
Expected: FAIL, модуль маршрута не найден.

- [ ] **Step 4: Реализовать маршрут**

`backend/routes/messaging-accounts.js`:

```js
'use strict';
// ============================================================
// /api/messaging — аккаунты мессенджеров салона (owner/admin).
// Список, подключение Telegram через свой шлюз (телефон → код → пароль 2FA),
// статус, отключение. Chatpush-строки создаются сидом/руками в БД — у них
// авторизация на стороне Chatpush, здесь они только видны.
// ============================================================
const router = require('express').Router();
const crypto = require('crypto');
const { db } = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const accounts = require('../services/messaging/accounts');
const gw = require('../services/messaging/gateway-client');
const config = require('../config');
const { createLogger } = require('../logger');
const logger = createLogger('MessagingAccounts');

const adminOnly = [auth, requireRole('owner', 'admin')];

// Шаг авторизации из тела запроса → {phone}|{code}|{password} | null.
function parseAuthStep(body) {
  const b = body || {};
  if (typeof b.phone === 'string' && b.phone.trim()) {
    let d = b.phone.replace(/\D/g, '');
    if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
    if (d.length === 10) d = '7' + d;
    return d.length >= 10 && d.length <= 15 ? { phone: d } : null;
  }
  if (typeof b.code === 'string') {
    const c = b.code.replace(/\D/g, '');
    return c.length >= 4 && c.length <= 6 ? { code: c } : null;
  }
  if (typeof b.password === 'string' && b.password.length) return { password: b.password };
  return null;
}

// Завести gateway-аккаунт Telegram у салона. Активная tdlib-строка на (salon,
// channel) одна (частичный уникальный индекс), поэтому прежний провайдер
// гасится ТУТ ЖЕ: подключение Telegram к шлюзу = переключение канала.
async function createTelegramAccount(salonId) {
  const existing = await db.oneOrNone(
    `SELECT id FROM messenger_accounts WHERE salon_id = $1 AND channel = 'tdlib' AND provider = 'gateway' AND status = 'active'`,
    [salonId]);
  if (existing) {
    const st = await gw.start(existing.id);
    return { id: existing.id, authState: st.authState };
  }
  await db.query(
    `UPDATE messenger_accounts SET status = 'disabled', updated_at = NOW()
      WHERE salon_id = $1 AND channel = $2 AND status = 'active'`,
    [salonId, 'tdlib']);
  const token = crypto.randomBytes(24).toString('hex');
  const row = await db.oneOrNone(
    `INSERT INTO messenger_accounts (salon_id, token, provider, channel, status, auth_state, display_name)
     VALUES ($1, $2, 'gateway', 'tdlib', 'active', 'starting', 'Telegram (свой шлюз)')
     RETURNING id`,
    [salonId, token]);
  if (!row) throw new Error('строка аккаунта не вставилась');
  await db.query(`UPDATE messenger_accounts SET external_id = $1 WHERE id = $2`, [String(row.id), row.id]);
  accounts.invalidate();
  const st = await gw.start(row.id);
  return { id: row.id, authState: st.authState };
}

async function ownRow(salonId, id) {
  return db.oneOrNone(
    `SELECT id, provider, channel, status, auth_state FROM messenger_accounts WHERE id = $1 AND salon_id = $2`,
    [id, salonId]);
}

router.get('/accounts', adminOnly, async (req, res) => {
  try { res.json({ accounts: await accounts.listForSalon(req.user.salonId), gatewayConfigured: !!config.MESSAGING_GATEWAY.url }); }
  catch (e) { logger.error(`list: ${e.message}`); res.status(500).json({ error: 'Не удалось загрузить аккаунты' }); }
});

router.post('/accounts/telegram', adminOnly, async (req, res) => {
  try { res.json(await createTelegramAccount(req.user.salonId)); }
  catch (e) { logger.error(`create telegram: ${e.message}`); res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/accounts/:id/auth', adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  const step = parseAuthStep(req.body);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Неверный id' });
  if (!step) return res.status(400).json({ error: 'Нужен телефон, код или пароль' });
  try {
    const row = await ownRow(req.user.salonId, id);
    if (!row || row.provider !== 'gateway') return res.status(404).json({ error: 'Аккаунт не найден' });
    res.json(await gw.auth(id, step));
  } catch (e) { logger.error(`auth #${id}: ${e.message}`); res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/accounts/:id/status', adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Неверный id' });
  try {
    const row = await ownRow(req.user.salonId, id);
    if (!row) return res.status(404).json({ error: 'Аккаунт не найден' });
    if (row.provider !== 'gateway') return res.json({ authState: null, provider: row.provider, status: row.status });
    res.json(await gw.status(id));
  } catch (e) { logger.error(`status #${id}: ${e.message}`); res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/accounts/:id/logout', adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Неверный id' });
  try {
    const row = await ownRow(req.user.salonId, id);
    if (!row || row.provider !== 'gateway') return res.status(404).json({ error: 'Аккаунт не найден' });
    await gw.logout(id);
    await db.query(`UPDATE messenger_accounts SET status = 'disabled', auth_state = 'logged_out', updated_at = NOW() WHERE id = $1 AND salon_id = $2`,
      [id, req.user.salonId]);
    accounts.invalidate();
    res.json({ ok: true });
  } catch (e) { logger.error(`logout #${id}: ${e.message}`); res.status(e.status || 500).json({ error: e.message }); }
});

// Вернуть канал на другой аккаунт (откат на Chatpush): активируем выбранную
// строку, гасим прочие активные того же канала.
router.post('/accounts/:id/activate', adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Неверный id' });
  try {
    const row = await ownRow(req.user.salonId, id);
    if (!row) return res.status(404).json({ error: 'Аккаунт не найден' });
    await db.query(`UPDATE messenger_accounts SET status = 'disabled', updated_at = NOW()
                     WHERE salon_id = $1 AND channel = $2 AND status = 'active' AND id <> $3`,
      [req.user.salonId, row.channel, id]);
    await db.query(`UPDATE messenger_accounts SET status = 'active', updated_at = NOW() WHERE id = $1 AND salon_id = $2`,
      [id, req.user.salonId]);
    accounts.invalidate();
    res.json({ ok: true });
  } catch (e) { logger.error(`activate #${id}: ${e.message}`); res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.parseAuthStep = parseAuthStep;
module.exports.createTelegramAccount = createTelegramAccount;
```

В `backend/routes/index.js` после `app.use('/api/agent', require('./agent-settings'));` добавить:
```js
  app.use('/api/messaging',         require('./messaging-accounts'));
```

- [ ] **Step 5: Прогнать**

Run: `cd /root/loyalpro/backend && npx jest messaging-accounts-routes 2>&1 | tail -5`
Expected: PASS, 7 tests.

- [ ] **Step 6: Коммит**

```bash
cd /root/loyalpro && git add backend/services/messaging/gateway-client.js backend/routes/messaging-accounts.js backend/messaging-accounts-routes.test.js backend/routes/index.js && git commit -m "feat(messaging): админ-API /api/messaging — аккаунты салона, подключение Telegram через шлюз

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Часть B. Шлюз `gateway/` — Telegram через TDLib

### Task 8: Каркас шлюза и спайк TDLib

**Files:**
- Create: `gateway/package.json`, `gateway/config.js`, `gateway/db.js`, `gateway/logger.js`, `gateway/.env.example`, `gateway/scripts/tdlib-spike.js`
- Modify: `.gitignore` (данные шлюза)

- [ ] **Step 1: package.json и установка**

`gateway/package.json`:
```json
{
  "name": "loyalpro-gateway",
  "version": "0.1.0",
  "private": true,
  "description": "LoyalPro — собственный шлюз мессенджеров (Telegram через TDLib), Chatpush-совместимый API",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "node --test test/"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "axios": "^1.6.0",
    "dotenv": "^16.3.0",
    "express": "^4.18.2",
    "multer": "^2.1.1",
    "pg": "^8.11.3",
    "prebuilt-tdlib": "td-1.8.67",
    "tdl": "^8.1.0"
  }
}
```

Run: `cd /root/loyalpro/gateway && npm install 2>&1 | tail -3 && node -e "const {getTdjson}=require('prebuilt-tdlib');console.log(getTdjson())"`
Expected: путь к `libtdjson.so` внутри `node_modules/@prebuilt-tdlib/...`.

- [ ] **Step 2: config.js, db.js, logger.js, .env.example**

`gateway/config.js`:
```js
'use strict';
require('dotenv').config();
const path = require('path');
const must = (k) => { const v = process.env[k]; if (!v) throw new Error(`gateway: не задан ${k}`); return v; };
module.exports = {
  PORT: parseInt(process.env.PORT || '3002', 10),
  DATABASE_URL: must('DATABASE_URL'),
  DB_SSL: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  TG_API_ID: parseInt(must('TG_API_ID'), 10),
  TG_API_HASH: must('TG_API_HASH'),
  INTERNAL_SECRET: must('GATEWAY_INTERNAL_SECRET'),
  BACKEND_WEBHOOK_URL: must('BACKEND_WEBHOOK_URL'),
  DATA_DIR: process.env.GATEWAY_DATA_DIR || path.join(__dirname, 'data'),
  // Куда класть скачанные медиа, чтобы бэкенд отдавал их статикой (express.static ../frontend).
  PUBLIC_FILES_DIR: process.env.GATEWAY_PUBLIC_FILES_DIR || path.join(__dirname, '../frontend/uploads/gateway'),
  PUBLIC_FILES_URL: process.env.GATEWAY_PUBLIC_FILES_URL || '/uploads/gateway',
  TDLIB_VERBOSITY: parseInt(process.env.TDLIB_VERBOSITY || '1', 10),
};
```

`gateway/db.js`:
```js
'use strict';
const { Pool } = require('pg');
const config = require('./config');
const pool = new Pool({ connectionString: config.DATABASE_URL, ssl: config.DB_SSL, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
const db = {
  query: (sql, p) => pool.query(sql, p),
  oneOrNone: async (sql, p) => { const r = await pool.query(sql, p); return r.rows[0] || null; },
  any: async (sql, p) => { const r = await pool.query(sql, p); return r.rows; },
};
module.exports = { pool, db };
```

`gateway/logger.js`:
```js
'use strict';
function ts() { return new Date().toISOString(); }
function createLogger(name) {
  const line = (lvl, msg) => `${ts()} [${lvl}] [${name}] ${msg}`;
  return {
    info:  (m) => console.log(line('INFO', m)),
    warn:  (m) => console.warn(line('WARN', m)),
    error: (m) => console.error(line('ERROR', m)),
    debug: (m) => { if (process.env.GATEWAY_DEBUG === 'true') console.log(line('DEBUG', m)); },
  };
}
module.exports = { createLogger };
```

`gateway/.env.example`:
```
PORT=3002
DATABASE_URL=postgresql://user:pass@host:5432/loyalpro_test
DB_SSL=true
TG_API_ID=123456
TG_API_HASH=0123456789abcdef0123456789abcdef
GATEWAY_INTERNAL_SECRET=change-me-internal
BACKEND_WEBHOOK_URL=http://127.0.0.1:3001/gateway/webhook?key=change-me-webhook
GATEWAY_DATA_DIR=/root/loyalpro/gateway/data
GATEWAY_PUBLIC_FILES_DIR=/root/loyalpro/frontend/uploads/gateway
GATEWAY_PUBLIC_FILES_URL=/uploads/gateway
TDLIB_VERBOSITY=1
```

В корневой `.gitignore` добавить строки:
```
gateway/data/
gateway/.env
frontend/uploads/gateway/
```

`TG_API_ID`/`TG_API_HASH` получить на https://my.telegram.org → API development tools (одно приложение на весь шлюз, аккаунтов под ним может быть много). Записать в `gateway/.env` на деве.

- [ ] **Step 3: Спайк — проверить поведение tdl 8 на авторизации**

`gateway/scripts/tdlib-spike.js`:
```js
'use strict';
// Разовая проверка: (1) шлёт ли tdl 8 setTdlibParameters сам; (2) какие
// authorizationState приходят; (3) имя поля reply у TDLib 1.8.67.
// Запуск: node scripts/tdlib-spike.js  — ждёт 15 с и выходит, НИЧЕГО не шлёт.
const tdl = require('tdl');
const { getTdjson } = require('prebuilt-tdlib');
const config = require('../config');
tdl.configure({ tdjson: getTdjson() });
const client = tdl.createClient({
  apiId: config.TG_API_ID, apiHash: config.TG_API_HASH,
  databaseDirectory: `${config.DATA_DIR}/spike/db`, filesDirectory: `${config.DATA_DIR}/spike/files`,
});
client.on('update', (u) => {
  if (u._ === 'updateAuthorizationState') console.log('AUTH STATE:', u.authorization_state._);
  else if (u._ === 'updateOption') console.log('OPTION', u.name, JSON.stringify(u.value));
});
client.on('error', (e) => console.error('ERR', e));
setTimeout(async () => {
  try { const v = await client.invoke({ _: 'getOption', name: 'version' }); console.log('TDLib version:', v.value); } catch (e) { console.error(e); }
  await client.close(); process.exit(0);
}, 15000);
```

Run: `cd /root/loyalpro/gateway && node scripts/tdlib-spike.js 2>&1 | head -20`
Expected: среди строк `AUTH STATE: authorizationStateWaitTdlibParameters` затем `AUTH STATE: authorizationStateWaitPhoneNumber` (tdl отправил параметры сам). Если после `WaitTdlibParameters` дальше ничего не идёт — tdl параметры НЕ шлёт, и в Task 11 ветка `authorizationStateWaitTdlibParameters` обязана вызывать `setTdlibParameters` (код для этого в Task 11 уже есть, оставить). Версия должна напечататься `1.8.67`. Результат спайка записать одной строкой в комментарий шапки `gateway/lib/telegram-client.js` (Task 11).

- [ ] **Step 4: Коммит**

```bash
cd /root/loyalpro && git add gateway/package.json gateway/package-lock.json gateway/config.js gateway/db.js gateway/logger.js gateway/.env.example gateway/scripts/tdlib-spike.js .gitignore && git commit -m "feat(gateway): каркас своего шлюза мессенджеров (tdl + prebuilt-tdlib), спайк авторизации

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 9: Чистый маппер `gateway/lib/mapper.js`

**Files:**
- Create: `gateway/lib/mapper.js`
- Create: `gateway/test/mapper.test.js`

- [ ] **Step 1: Тесты**

`gateway/test/mapper.test.js`:
```js
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

test('deliveryStatus: маппинг в форму Chatpush', () => {
  assert.deepEqual(m.deliveryStatus({ id: 12, status_id: 1, description: 'Принято', error: null }),
    { id: 'g12', status: { status_id: 1, description: 'Принято' }, error: null });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /root/loyalpro/gateway && node --test test/ 2>&1 | tail -5`
Expected: FAIL, `Cannot find module '../lib/mapper'`.

- [ ] **Step 3: Реализовать**

`gateway/lib/mapper.js`:
```js
'use strict';
// ============================================================
// Mapper — чистые функции без TDLib/БД/HTTP: сообщение TDLib → тело вебхука
// в плоской tdlib-форме Chatpush (её разбирает backend/services/chatpush.js
// envelope()), составные id, телефоны, статусы доставки.
// ============================================================

function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return d.length >= 10 && d.length <= 15 ? d : null;
}

// Message id TDLib уникален только внутри чата → наружу уходит "<chat>:<msg>".
function compositeId(chatId, messageId) { return `${chatId}:${messageId}`; }
function parseCompositeId(s) {
  const mm = /^(-?\d+):(\d+)$/.exec(String(s || ''));
  return mm ? { chatId: Number(mm[1]), messageId: Number(mm[2]) } : null;
}

function largestPhoto(photo) {
  const sizes = (photo && photo.sizes) || [];
  let best = null;
  for (const s of sizes) if (!best || (s.width || 0) > (best.width || 0)) best = s;
  return best ? best.photo : null;
}

// Содержимое → {type, text, file:{id, mimeType, fileName}|null}. type — как у
// Chatpush: текст 'formattedText', медиа 'image'|'document'|'voice'|'video'.
function contentOf(content) {
  const c = content || {};
  switch (c._) {
    case 'messageText':
      return { type: 'formattedText', text: (c.text && c.text.text) || '', file: null };
    case 'messagePhoto': {
      const f = largestPhoto(c.photo);
      return { type: 'image', text: (c.caption && c.caption.text) || '', file: f ? { id: f.id, mimeType: 'image/jpeg', fileName: null } : null };
    }
    case 'messageDocument': {
      const d = c.document || {};
      return { type: 'document', text: (c.caption && c.caption.text) || '',
        file: d.document ? { id: d.document.id, mimeType: d.mime_type || 'application/octet-stream', fileName: d.file_name || null } : null };
    }
    case 'messageVoiceNote': {
      const v = c.voice_note || {};
      return { type: 'voice', text: '', file: v.voice ? { id: v.voice.id, mimeType: v.mime_type || 'audio/ogg', fileName: null } : null };
    }
    case 'messageVideo': {
      const v = c.video || {};
      return { type: 'video', text: (c.caption && c.caption.text) || '',
        file: v.video ? { id: v.video.id, mimeType: v.mime_type || 'video/mp4', fileName: v.file_name || null } : null };
    }
    default:
      return { type: 'unsupported', text: '', file: null };
  }
}

function isGroupChat(chat) {
  const t = chat && chat.type && chat.type._;
  return t === 'chatTypeBasicGroup' || t === 'chatTypeSupergroup';
}

function fullName(user) {
  return [user && user.first_name, user && user.last_name].filter(Boolean).join(' ').trim() || null;
}

/**
 * Тело вебхука. peer — собеседник (в личке — второй участник, в группе —
 * отправитель сообщения). Номера строго по стороне клиента, как ждёт
 * envelope(): у incoming клиент в sender_phone_number, у outgoing — в
 * recipient_phone_number; наш номер стоит на второй стороне.
 */
function buildWebhookBody({ accountId, ownPhone, message, chat, peer, deliveryId, fileUrl }) {
  const msg = message || {};
  const content = contentOf(msg.content);
  const outgoing = !!msg.is_outgoing;
  const peerPhone = normalizePhone(peer && peer.phone_number);
  const peerName = fullName(peer);
  const replyTo = msg.reply_to && msg.reply_to._ === 'messageReplyToMessage'
    ? compositeId(msg.reply_to.chat_id != null ? msg.reply_to.chat_id : msg.chat_id, msg.reply_to.message_id) : null;
  const m = {
    id: compositeId(msg.chat_id, msg.id),
    type: content.type,
    text: content.text,
    timestamp: msg.date || null,
    reply_to_message_id: replyTo,
  };
  if (content.file && fileUrl) {
    m.file_data = { download_url: fileUrl, mime_type: content.file.mimeType, caption: content.text };
  }
  return {
    type: 'tdlib_incoming_msg',
    payload: {
      provider: 'gateway',
      customer_id: accountId,
      instance_id: accountId,
      direction: outgoing ? 'outgoing' : 'incoming',
      chat_id: String(msg.chat_id),
      chat_type: isGroupChat(chat) ? 'group' : 'person',
      sender_phone_number: outgoing ? (ownPhone || null) : peerPhone,
      recipient_phone_number: outgoing ? peerPhone : (ownPhone || null),
      sender_name: outgoing ? null : peerName,
      recipient_username: outgoing ? peerName : null,
      delivery_id: deliveryId || null,
      timestamp: msg.date || null,
      message: m,
    },
  };
}

// Строка gateway_deliveries → объект delivery в форме Chatpush.
function deliveryStatus(row) {
  return { id: `g${row.id}`, status: { status_id: Number(row.status_id), description: row.description }, error: row.error || null };
}

module.exports = { normalizePhone, compositeId, parseCompositeId, contentOf, buildWebhookBody, deliveryStatus, isGroupChat, fullName };
```

- [ ] **Step 4: Прогнать**

Run: `cd /root/loyalpro/gateway && node --test test/ 2>&1 | tail -5`
Expected: `# pass 11`, `# fail 0`.

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add gateway/lib/mapper.js gateway/test/mapper.test.js && git commit -m "feat(gateway): чистый маппер TDLib → вебхук в форме Chatpush

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 10: Доставки и отправитель вебхуков

**Files:**
- Create: `gateway/lib/deliveries.js`
- Create: `gateway/lib/webhook-sender.js`
- Create: `gateway/test/webhook-sender.test.js`

- [ ] **Step 1: deliveries.js**

```js
'use strict';
// Строки gateway_deliveries: id → наружу как 'g<id>' (не пересекается с
// числовыми id Chatpush; влезает в agent_reply_deliveries.delivery_id VARCHAR(40)).
const { db } = require('../db');

const STATUS = {
  ACCEPTED: [1, 'Принято'],
  SENT:     [2, 'Отправлено'],
  FAILED:   [5, 'Невозможно доставить'],   // ровно 5: его проверяет backend/routes/chat.js
};

async function create({ accountId, chatId, phone, kind, text }) {
  const row = await db.oneOrNone(
    `INSERT INTO gateway_deliveries (account_id, chat_id, phone, kind, text, status_id, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [accountId, chatId, phone, kind, text, STATUS.ACCEPTED[0], STATUS.ACCEPTED[1]]);
  return row.id;
}

async function setStatus(id, [statusId, description], { tdlibMessageId = null, error = null } = {}) {
  await db.query(
    `UPDATE gateway_deliveries SET status_id=$2, description=$3, tdlib_message_id=COALESCE($4, tdlib_message_id), error=$5, updated_at=NOW() WHERE id=$1`,
    [id, statusId, description, tdlibMessageId, error]);
}

async function get(accountId, id) {
  return db.oneOrNone(`SELECT * FROM gateway_deliveries WHERE id=$1 AND account_id=$2`, [id, accountId]);
}

function parseId(s) { const mm = /^g(\d+)$/.exec(String(s || '')); return mm ? Number(mm[1]) : null; }

module.exports = { create, setStatus, get, parseId, STATUS };
```

- [ ] **Step 2: Тест отправителя вебхуков**

`gateway/test/webhook-sender.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeSender } = require('../lib/webhook-sender');

test('успех с первой попытки', async () => {
  const calls = [];
  const send = makeSender({ url: 'http://x/gateway/webhook?key=k', post: async (url, body) => { calls.push([url, body]); return { status: 200 }; }, sleep: async () => {} });
  await send({ type: 't' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'http://x/gateway/webhook?key=k');
});

test('повторяет до 3 раз, потом бросает', async () => {
  let n = 0;
  const send = makeSender({ url: 'u', post: async () => { n++; throw new Error('down'); }, sleep: async () => {}, attempts: 3 });
  await assert.rejects(send({}), /down/);
  assert.equal(n, 3);
});

test('401 от бэкенда не повторяется (неверный секрет)', async () => {
  let n = 0;
  const send = makeSender({ url: 'u', post: async () => { n++; const e = new Error('401'); e.response = { status: 401 }; throw e; }, sleep: async () => {}, attempts: 3 });
  await assert.rejects(send({}), /401/);
  assert.equal(n, 1);
});
```

- [ ] **Step 3: Запустить — падает**

Run: `cd /root/loyalpro/gateway && node --test test/webhook-sender.test.js 2>&1 | tail -3`
Expected: FAIL, модуль не найден.

- [ ] **Step 4: Реализовать**

`gateway/lib/webhook-sender.js`:
```js
'use strict';
// POST события в бэкенд (/gateway/webhook?key=…). Бэкенд отвечает 200 сразу и
// обрабатывает асинхронно, как с Chatpush. Повторы — на сетевые/5xx ошибки,
// 401 (секрет) не повторяем.
const axios = require('axios');
const config = require('../config');
const { createLogger } = require('../logger');
const logger = createLogger('Webhook');

function makeSender({ url, post, sleep, attempts = 3 } = {}) {
  const doPost = post || ((u, body) => axios.post(u, body, { timeout: 10000 }));
  const doSleep = sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  return async function send(body) {
    let lastErr = null;
    for (let i = 1; i <= attempts; i++) {
      try { await doPost(url, body); return; }
      catch (e) {
        lastErr = e;
        const st = e.response && e.response.status;
        if (st === 401) throw e;
        if (i < attempts) await doSleep(500 * i);
      }
    }
    throw lastErr;
  };
}

const send = makeSender({ url: config.BACKEND_WEBHOOK_URL });
async function sendSafe(body) {
  try { await send(body); }
  catch (e) { logger.error(`вебхук не доставлен в бэкенд: ${e.message} (type=${body && body.type})`); }
}

module.exports = { makeSender, send, sendSafe };
```

- [ ] **Step 5: Прогнать**

Run: `cd /root/loyalpro/gateway && node --test test/ 2>&1 | tail -3`
Expected: `# pass 14`.

- [ ] **Step 6: Коммит**

```bash
cd /root/loyalpro && git add gateway/lib/deliveries.js gateway/lib/webhook-sender.js gateway/test/webhook-sender.test.js && git commit -m "feat(gateway): журнал доставок и отправитель вебхуков с повторами

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 11: Обёртка TDLib одного аккаунта `telegram-client.js`

**Files:**
- Create: `gateway/lib/telegram-client.js`
- Create: `gateway/lib/accounts-repo.js`

- [ ] **Step 1: accounts-repo.js**

```js
'use strict';
const { db } = require('../db');

async function get(id) {
  return db.oneOrNone(`SELECT * FROM messenger_accounts WHERE id=$1 AND provider='gateway'`, [id]);
}
async function listActive() {
  return db.any(`SELECT * FROM messenger_accounts WHERE provider='gateway' AND channel='tdlib' AND status='active' ORDER BY id`);
}
async function byToken(token) {
  return db.oneOrNone(`SELECT * FROM messenger_accounts WHERE provider='gateway' AND token=$1 AND status='active'`, [token]);
}
async function setAuth(id, authState, { error = null, phone, displayName } = {}) {
  await db.query(
    `UPDATE messenger_accounts
        SET auth_state=$2, auth_error=$3,
            phone=COALESCE($4, phone), display_name=COALESCE($5, display_name), updated_at=NOW()
      WHERE id=$1`,
    [id, authState, error, phone || null, displayName || null]);
}
async function contactUserId(accountId, phone) {
  const r = await db.oneOrNone(`SELECT user_id FROM gateway_contacts WHERE account_id=$1 AND phone=$2`, [accountId, phone]);
  return r ? Number(r.user_id) : null;
}
async function rememberContact(accountId, phone, userId) {
  await db.query(
    `INSERT INTO gateway_contacts (account_id, phone, user_id) VALUES ($1,$2,$3)
     ON CONFLICT (account_id, phone) DO UPDATE SET user_id=EXCLUDED.user_id`,
    [accountId, phone, userId]);
}
module.exports = { get, listActive, byToken, setAuth, contactUserId, rememberContact };
```

- [ ] **Step 2: telegram-client.js**

```js
'use strict';
// ============================================================
// TelegramClient — один TDLib-клиент = один аккаунт (строка messenger_accounts).
// ------------------------------------------------------------
// Авторизация — конечный автомат по updateAuthorizationState, шаги приходят
// из админки через внутренний API (телефон → код → пароль 2FA). Состояние
// пишется в messenger_accounts.auth_state, чтобы фронт мог опрашивать.
// Входящие и исходящие (в т.ч. набранные администратором в телефоне) идут
// в бэкенд вебхуком в форме Chatpush (lib/mapper). Наши собственные отправки
// получают delivery_id: эхо для них берём из updateMessageSendSucceeded, а
// updateNewMessage с sending_state (ещё не отправлено) пропускаем — иначе
// одно сообщение легло бы в «Чат» дважды.
// Результат спайка (Task 8): <вписать: шлёт ли tdl setTdlibParameters сам; версия TDLib>.
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tdl = require('tdl');
const { getTdjson } = require('prebuilt-tdlib');
const config = require('../config');
const repo = require('./accounts-repo');
const deliveries = require('./deliveries');
const mapper = require('./mapper');
const webhook = require('./webhook-sender');
const { createLogger } = require('../logger');

let configured = false;
function ensureConfigured() {
  if (configured) return;
  tdl.configure({ tdjson: getTdjson() });
  tdl.execute({ _: 'setLogVerbosityLevel', new_verbosity_level: config.TDLIB_VERBOSITY });
  configured = true;
}

const AUTH_MAP = {
  authorizationStateWaitTdlibParameters: 'starting',
  authorizationStateWaitPhoneNumber: 'wait_phone',
  authorizationStateWaitCode: 'wait_code',
  authorizationStateWaitPassword: 'wait_password',
  authorizationStateReady: 'ready',
  authorizationStateLoggingOut: 'logged_out',
  authorizationStateClosing: 'logged_out',
  authorizationStateClosed: 'logged_out',
};

class TelegramClient {
  constructor(account) {
    this.account = account;
    this.id = account.id;
    this.log = createLogger(`TG#${account.id}`);
    this.authState = 'starting';
    this.ownPhone = mapper.normalizePhone(account.phone);
    this.me = null;
    this.pendingSends = new Map();   // temp message id → delivery id
    this.client = null;
    this.closed = false;
  }

  dirs() {
    const base = path.join(config.DATA_DIR, `acc-${this.id}`);
    return { db: path.join(base, 'db'), files: path.join(base, 'files'), base };
  }

  async start() {
    ensureConfigured();
    const d = this.dirs();
    fs.mkdirSync(d.db, { recursive: true }); fs.mkdirSync(d.files, { recursive: true });
    this.client = tdl.createClient({
      apiId: config.TG_API_ID, apiHash: config.TG_API_HASH,
      databaseDirectory: d.db, filesDirectory: d.files,
      tdlibParameters: { system_language_code: 'ru', device_model: 'LoyalPro Gateway', application_version: '1.0', use_message_database: true, use_secret_chats: false },
    });
    this.client.on('update', (u) => { this.onUpdate(u).catch(e => this.log.error(`update ${u._}: ${e.message}`)); });
    this.client.on('error', (e) => this.log.error(`tdlib error: ${e && e.message ? e.message : JSON.stringify(e)}`));
    await repo.setAuth(this.id, 'starting');
    this.log.info('клиент запущен');
  }

  async onUpdate(u) {
    switch (u._) {
      case 'updateAuthorizationState': return this.onAuthState(u.authorization_state);
      case 'updateNewMessage': return this.onNewMessage(u.message);
      case 'updateMessageSendSucceeded': return this.onSendSucceeded(u);
      case 'updateMessageSendFailed': return this.onSendFailed(u);
      default: return undefined;
    }
  }

  async onAuthState(st) {
    const mapped = AUTH_MAP[st._] || 'error';
    this.authState = mapped;
    this.log.info(`auth: ${st._}`);
    if (st._ === 'authorizationStateWaitTdlibParameters') {
      // tdl 8 обычно шлёт параметры сам (см. спайк); если нет — шлём мы.
      // Повторный вызов отвечает ошибкой 400 "Unexpected setTdlibParameters" — глотаем.
      try {
        await this.client.invoke({ _: 'setTdlibParameters', api_id: config.TG_API_ID, api_hash: config.TG_API_HASH,
          database_directory: this.dirs().db, files_directory: this.dirs().files, use_message_database: true,
          use_secret_chats: false, system_language_code: 'ru', device_model: 'LoyalPro Gateway', application_version: '1.0' });
      } catch (_) { /* уже отправлены */ }
      return;
    }
    if (st._ === 'authorizationStateReady') {
      this.me = await this.client.invoke({ _: 'getMe' });
      this.ownPhone = mapper.normalizePhone(this.me.phone_number) || this.ownPhone;
      await repo.setAuth(this.id, 'ready', { phone: this.ownPhone, displayName: mapper.fullName(this.me) });
      this.log.info(`готов: ${this.ownPhone} (${mapper.fullName(this.me)})`);
      return;
    }
    if (st._ === 'authorizationStateClosed') { this.closed = true; }
    await repo.setAuth(this.id, mapped);
  }

  // Шаг авторизации из админки. Ошибка TDLib (неверный код/пароль) → в auth_error и в ответ.
  async authStep(step) {
    try {
      if (step.phone) {
        await this.client.invoke({ _: 'setAuthenticationPhoneNumber', phone_number: '+' + step.phone });
      } else if (step.code) {
        await this.client.invoke({ _: 'checkAuthenticationCode', code: step.code });
      } else if (step.password) {
        await this.client.invoke({ _: 'checkAuthenticationPassword', password: step.password });
      } else {
        return { authState: this.authState, error: 'пустой шаг' };
      }
      await this.waitStateChange(this.authState, 8000);
      await repo.setAuth(this.id, this.authState, { error: null });
      return { authState: this.authState, error: null };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      await repo.setAuth(this.id, this.authState, { error: msg });
      return { authState: this.authState, error: msg };
    }
  }

  // TDLib отвечает на шаг до прихода нового состояния — дождёмся его (или таймаута).
  waitStateChange(prev, ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (this.authState !== prev || Date.now() - t0 > ms) return resolve();
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  status() {
    return { authState: this.authState, phone: this.ownPhone, displayName: this.me ? mapper.fullName(this.me) : null, error: null };
  }

  // ── Входящие/эхо ─────────────────────────────────────────────
  async onNewMessage(message) {
    if (this.authState !== 'ready') return;
    if (message.sending_state) return;          // наша отправка в пути — эхо придёт из onSendSucceeded
    await this.emitMessage(message, null);
  }

  async onSendSucceeded({ message, old_message_id }) {
    const deliveryId = this.pendingSends.get(old_message_id) || null;
    this.pendingSends.delete(old_message_id);
    if (deliveryId) await deliveries.setStatus(deliveryId, deliveries.STATUS.SENT, { tdlibMessageId: message.id });
    await this.emitMessage(message, deliveryId ? `g${deliveryId}` : null);
  }

  async onSendFailed({ old_message_id, error }) {
    const deliveryId = this.pendingSends.get(old_message_id) || null;
    this.pendingSends.delete(old_message_id);
    const text = error ? `${error.code} ${error.message}` : 'send failed';
    this.log.warn(`отправка не удалась: ${text}`);
    if (deliveryId) await deliveries.setStatus(deliveryId, deliveries.STATUS.FAILED, { error: text });
  }

  async emitMessage(message, deliveryId) {
    const chat = await this.client.invoke({ _: 'getChat', chat_id: message.chat_id });
    let peer = null;
    if (mapper.isGroupChat(chat)) {
      const uid = message.sender_id && message.sender_id._ === 'messageSenderUser' ? message.sender_id.user_id : null;
      peer = uid ? await this.client.invoke({ _: 'getUser', user_id: uid }) : null;
    } else if (chat.type && chat.type._ === 'chatTypePrivate') {
      peer = await this.client.invoke({ _: 'getUser', user_id: chat.type.user_id });
    } else {
      return; // секретные чаты и прочее не поддерживаем
    }
    const content = mapper.contentOf(message.content);
    let fileUrl = null;
    if (content.file) {
      try { fileUrl = await this.downloadToPublic(content.file); }
      catch (e) { this.log.warn(`медиа не скачано (${e.message})`); }
    }
    const body = mapper.buildWebhookBody({ accountId: this.id, ownPhone: this.ownPhone, message, chat, peer, deliveryId, fileUrl });
    await webhook.sendSafe(body);
  }

  // Скачать файл TDLib и положить в публичный каталог под случайным именем.
  async downloadToPublic(file) {
    const f = await this.client.invoke({ _: 'downloadFile', file_id: file.id, priority: 1, offset: 0, limit: 0, synchronous: true });
    const src = f.local && f.local.path;
    if (!src || !fs.existsSync(src)) throw new Error('файл не скачан');
    const ext = (file.fileName && path.extname(file.fileName)) || (file.mimeType === 'image/jpeg' ? '.jpg' : file.mimeType === 'audio/ogg' ? '.ogg' : path.extname(src) || '');
    const dir = path.join(config.PUBLIC_FILES_DIR, String(this.id));
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`;
    fs.copyFileSync(src, path.join(dir, name));
    return `${config.PUBLIC_FILES_URL}/${this.id}/${name}`;
  }

  // ── Получатель ───────────────────────────────────────────────
  // chat_id = user_id для лички (TDLib). По номеру: кэш gateway_contacts →
  // searchUserByPhoneNumber → importContacts (добавляет в контакты аккаунта —
  // так же делает Chatpush). 0 в user_ids = номера нет в Telegram.
  async resolveChatId({ tdlibUserId, phone }) {
    if (tdlibUserId) {
      const id = Number(tdlibUserId);
      if (id < 0) return id;                     // группа: chat_id как есть
      const chat = await this.client.invoke({ _: 'createPrivateChat', user_id: id, force: false });
      return chat.id;
    }
    const p = mapper.normalizePhone(phone);
    if (!p) throw new Error('нет получателя: ни tdlib_user_id, ни phone');
    let userId = await repo.contactUserId(this.id, p);
    if (!userId) {
      try {
        const u = await this.client.invoke({ _: 'searchUserByPhoneNumber', phone_number: '+' + p });
        userId = u && u.id;
      } catch (_) { userId = null; }
    }
    if (!userId) {
      const r = await this.client.invoke({ _: 'importContacts', contacts: [{ _: 'importedContact', phone_number: '+' + p, first_name: 'Клиент', last_name: '' }] });
      userId = r && r.user_ids && r.user_ids[0];
    }
    if (!userId) throw new Error(`номер ${p} не найден в Telegram`);
    await repo.rememberContact(this.id, p, userId);
    const chat = await this.client.invoke({ _: 'createPrivateChat', user_id: userId, force: false });
    return chat.id;
  }

  // ── Отправка ─────────────────────────────────────────────────
  async sendText({ text, phone, tdlibUserId, replyToMessageId }) {
    if (this.authState !== 'ready') throw Object.assign(new Error('аккаунт не авторизован'), { status: 422 });
    const chatId = await this.resolveChatId({ tdlibUserId, phone });
    const deliveryId = await deliveries.create({ accountId: this.id, chatId, phone: mapper.normalizePhone(phone), kind: 'text', text });
    const reply = mapper.parseCompositeId(replyToMessageId);
    const req = {
      _: 'sendMessage', chat_id: chatId,
      input_message_content: { _: 'inputMessageText', text: { _: 'formattedText', text, entities: [] } },
    };
    if (reply && reply.chatId === chatId) req.reply_to = { _: 'inputMessageReplyToMessage', message_id: reply.messageId };
    try {
      const msg = await this.client.invoke(req);
      this.pendingSends.set(msg.id, deliveryId);
    } catch (e) {
      await deliveries.setStatus(deliveryId, deliveries.STATUS.FAILED, { error: e.message });
      throw Object.assign(new Error(`TDLib: ${e.message}`), { status: 422 });
    }
    return deliveryId;
  }

  async sendFile({ filePath, fileName, caption, type, phone, tdlibUserId }) {
    if (this.authState !== 'ready') throw Object.assign(new Error('аккаунт не авторизован'), { status: 422 });
    const chatId = await this.resolveChatId({ tdlibUserId, phone });
    const deliveryId = await deliveries.create({ accountId: this.id, chatId, phone: mapper.normalizePhone(phone), kind: 'file', text: caption || fileName });
    const cap = { _: 'formattedText', text: caption || '', entities: [] };
    const local = { _: 'inputFileLocal', path: filePath };
    const content = type === 'image'
      ? { _: 'inputMessagePhoto', photo: { _: 'inputPhoto', photo: local }, caption: cap }
      : { _: 'inputMessageDocument', document: { _: 'inputDocument', document: local }, caption: cap };
    try {
      const msg = await this.client.invoke({ _: 'sendMessage', chat_id: chatId, input_message_content: content });
      this.pendingSends.set(msg.id, deliveryId);
    } catch (e) {
      await deliveries.setStatus(deliveryId, deliveries.STATUS.FAILED, { error: e.message });
      throw Object.assign(new Error(`TDLib: ${e.message}`), { status: 422 });
    }
    return deliveryId;
  }

  async logout() {
    try { await this.client.invoke({ _: 'logOut' }); } catch (_) {}
    try { await this.client.close(); } catch (_) {}
    this.closed = true;
    fs.rmSync(this.dirs().base, { recursive: true, force: true });
    await repo.setAuth(this.id, 'logged_out');
  }

  async close() {
    try { await this.client.close(); } catch (_) {}
    this.closed = true;
  }
}

module.exports = { TelegramClient };
```

ГОТЧА: файл `inputFileLocal` для `sendFile` должен лежать на диске — сервер (Task 12) сохраняет multipart во временный файл внутри `DATA_DIR/tmp` и удаляет его после ответа TDLib на `sendMessage` (TDLib копирует файл в свой кэш при отправке).

- [ ] **Step 3: Синтаксис**

Run: `cd /root/loyalpro/gateway && node -e "require('./lib/telegram-client'); console.log('ok')"`
Expected: `ok` (при отсутствующем `.env` — ошибка `не задан DATABASE_URL`; тогда запустить с `.env` из Task 8).

- [ ] **Step 4: Коммит**

```bash
cd /root/loyalpro && git add gateway/lib/telegram-client.js gateway/lib/accounts-repo.js && git commit -m "feat(gateway): обёртка TDLib одного аккаунта — авторизация, приём, отправка, резолв получателя

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 12: HTTP-сервер шлюза и реестр клиентов

**Files:**
- Create: `gateway/lib/registry.js`
- Create: `gateway/server.js`
- Create: `gateway/test/server-auth.test.js`
- Modify: `ecosystem.config.js`

- [ ] **Step 1: registry.js**

```js
'use strict';
// Аккаунт → живой TelegramClient. При старте процесса поднимаем все активные.
const repo = require('./accounts-repo');
const { TelegramClient } = require('./telegram-client');
const { createLogger } = require('../logger');
const logger = createLogger('Registry');

const clients = new Map();

async function start(id) {
  if (clients.has(id)) return clients.get(id);
  const account = await repo.get(id);
  if (!account) throw Object.assign(new Error('аккаунт не найден'), { status: 404 });
  const c = new TelegramClient(account);
  clients.set(id, c);
  try { await c.start(); }
  catch (e) { clients.delete(id); throw e; }
  return c;
}

function get(id) { return clients.get(Number(id)) || null; }

async function stop(id) {
  const c = clients.get(Number(id));
  if (!c) return;
  await c.close();
  clients.delete(Number(id));
}

async function logout(id) {
  const c = clients.get(Number(id));
  if (c) { await c.logout(); clients.delete(Number(id)); }
  else { const tmp = new TelegramClient({ id: Number(id), phone: null }); try { tmp.closed = true; require('fs').rmSync(tmp.dirs().base, { recursive: true, force: true }); } catch (_) {} await repo.setAuth(Number(id), 'logged_out'); }
}

async function startAllActive() {
  const rows = await repo.listActive();
  for (const r of rows) {
    try { await start(r.id); logger.info(`аккаунт #${r.id} (${r.phone || 'без номера'}) запущен`); }
    catch (e) { logger.error(`аккаунт #${r.id} не запущен: ${e.message}`); }
  }
}

async function closeAll() { for (const id of [...clients.keys()]) await stop(id); }

module.exports = { start, get, stop, logout, startAllActive, closeAll, _clients: clients };
```

- [ ] **Step 2: Тест авторизации публичного API (без TDLib)**

`gateway/test/server-auth.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bearerOf, internalOk, chatpushError } = require('../lib/http-auth');

test('bearerOf', () => {
  assert.equal(bearerOf({ headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.equal(bearerOf({ headers: {} }), null);
});
test('internalOk — timing-safe сравнение секрета', () => {
  assert.equal(internalOk({ headers: { 'x-gateway-secret': 's3' } }, 's3'), true);
  assert.equal(internalOk({ headers: { 'x-gateway-secret': 'x' } }, 's3'), false);
  assert.equal(internalOk({ headers: {} }, 's3'), false);
});
test('chatpushError — форма тела как у Chatpush', () => {
  assert.deepEqual(chatpushError('нет получателя'), { meta: { status: 'error', message: 'нет получателя' } });
});
```

- [ ] **Step 3: http-auth.js и server.js**

`gateway/lib/http-auth.js`:
```js
'use strict';
const crypto = require('crypto');
function bearerOf(req) {
  const h = (req.headers && req.headers.authorization) || '';
  const mm = /^Bearer\s+(.+)$/i.exec(h);
  return mm ? mm[1].trim() : null;
}
function internalOk(req, secret) {
  const got = String((req.headers && req.headers['x-gateway-secret']) || '');
  if (!got || !secret) return false;
  const a = Buffer.from(got), b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function chatpushError(message) { return { meta: { status: 'error', message } }; }
module.exports = { bearerOf, internalOk, chatpushError };
```

`gateway/server.js`:
```js
'use strict';
// ============================================================
// LoyalPro Gateway — Chatpush-совместимый API поверх TDLib (см. план
// docs/superpowers/plans/2026-10-08-telegram-gateway-multitenant.md, раздел «Контракт шлюза»).
// ============================================================
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const repo = require('./lib/accounts-repo');
const registry = require('./lib/registry');
const deliveries = require('./lib/deliveries');
const mapper = require('./lib/mapper');
const { bearerOf, internalOk, chatpushError } = require('./lib/http-auth');
const { createLogger } = require('./logger');
const logger = createLogger('Server');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const tmpDir = path.join(config.DATA_DIR, 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });
const upload = multer({ dest: tmpDir, limits: { fileSize: 50 * 1024 * 1024 } });

// ── Публичный API: Bearer = messenger_accounts.token ─────────────────
async function accountAuth(req, res, next) {
  const token = bearerOf(req);
  const row = token ? await repo.byToken(token).catch(() => null) : null;
  if (!row) return res.status(401).json(chatpushError('unauthorized'));
  const client = registry.get(row.id);
  if (!client) return res.status(422).json(chatpushError('аккаунт не запущен'));
  req.account = row; req.tg = client;
  next();
}

// Query-параметры Chatpush: dispatch_routing[] — массив; qs() бэкенда кодирует `k[]=v`.
function q(req, name) { const v = req.query[name]; return Array.isArray(v) ? v[0] : (v == null ? undefined : String(v)); }

app.post('/api/v1/delivery', accountAuth, async (req, res) => {
  try {
    const text = q(req, 'text') || '';
    if (!text.trim()) return res.status(422).json(chatpushError('пустой text'));
    const id = await req.tg.sendText({
      text, phone: q(req, 'phone'), tdlibUserId: q(req, 'tdlib_user_id'), replyToMessageId: q(req, 'reply_to_message_id'),
    });
    logger.info(`#${req.account.id} delivery g${id} → ${q(req, 'phone') || q(req, 'tdlib_user_id')}: ${text.slice(0, 60)}`);
    res.json({ meta: { status: 'success' }, delivery: { id: `g${id}`, channel: 'tdlib', status: { status_id: 1, description: 'Принято' } } });
  } catch (e) {
    logger.warn(`#${req.account.id} delivery failed: ${e.message}`);
    res.status(e.status || 500).json(chatpushError(e.message));
  }
});

app.post('/api/v1/send_file', accountAuth, upload.single('file'), async (req, res) => {
  const tmp = req.file && req.file.path;
  try {
    if (!tmp) return res.status(422).json(chatpushError('нет файла'));
    const fileName = q(req, 'file_name') || req.file.originalname || 'file';
    const id = await req.tg.sendFile({
      filePath: tmp, fileName, caption: q(req, 'caption') || '', type: q(req, 'type') || 'document',
      phone: q(req, 'phone'), tdlibUserId: q(req, 'tdlib_user_id'),
    });
    logger.info(`#${req.account.id} send_file g${id} ${fileName}`);
    res.json({ meta: { status: 'success' }, delivery: { id: `g${id}`, channel: 'tdlib', status: { status_id: 1, description: 'Принято' } } });
  } catch (e) {
    logger.warn(`#${req.account.id} send_file failed: ${e.message}`);
    res.status(e.status || 500).json(chatpushError(e.message));
  } finally {
    // TDLib копирует файл при sendMessage; временный можно убрать с задержкой.
    if (tmp) setTimeout(() => fs.rm(tmp, { force: true }, () => {}), 60 * 1000).unref();
  }
});

app.get('/api/v1/delivery/:id', accountAuth, async (req, res) => {
  const id = deliveries.parseId(req.params.id);
  if (!id) return res.status(404).json(chatpushError('not found'));
  const row = await deliveries.get(req.account.id, id);
  if (!row) return res.status(404).json(chatpushError('not found'));
  res.json({ delivery: mapper.deliveryStatus(row) });
});

// ── Внутренний API: X-Gateway-Secret ────────────────────────────────
function internalAuth(req, res, next) {
  if (!internalOk(req, config.INTERNAL_SECRET)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.post('/internal/accounts/:id/start', internalAuth, async (req, res) => {
  try { const c = await registry.start(Number(req.params.id)); res.json({ authState: c.authState }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.post('/internal/accounts/:id/auth', internalAuth, async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) return res.status(404).json({ error: 'аккаунт не запущен' });
  res.json(await c.authStep(req.body || {}));
});
app.get('/internal/accounts/:id/status', internalAuth, async (req, res) => {
  const c = registry.get(req.params.id);
  if (!c) { const row = await repo.get(Number(req.params.id)); return row ? res.json({ authState: row.auth_state || 'logged_out', phone: row.phone, displayName: row.display_name, error: row.auth_error }) : res.status(404).json({ error: 'not found' }); }
  res.json(c.status());
});
app.post('/internal/accounts/:id/logout', internalAuth, async (req, res) => {
  try { await registry.logout(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/health', (req, res) => res.json({ ok: true, accounts: [...registry._clients.values()].map(c => ({ id: c.id, authState: c.authState })) }));

app.listen(config.PORT, '127.0.0.1', () => {
  logger.info(`gateway слушает 127.0.0.1:${config.PORT}`);
  registry.startAllActive().catch(e => logger.error(`startAllActive: ${e.message}`));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { registry.closeAll().finally(() => process.exit(0)); });
}
```

ВНИМАНИЕ: сервер слушает ТОЛЬКО `127.0.0.1` — наружу шлюз не светится, бэкенд ходит к нему локально.

- [ ] **Step 4: Прогнать тесты и поднять процесс на деве**

Run: `cd /root/loyalpro/gateway && node --test test/ 2>&1 | tail -3`
Expected: `# pass 17`.

В `ecosystem.config.js` добавить второе приложение (prod-пути, как у `loyalpro`):
```js
  , {
    name: 'loyalpro-gateway',
    script: '/var/www/loyalpro/gateway/server.js',
    cwd: '/var/www/loyalpro/gateway',
    env: { NODE_ENV: 'production', PORT: 3002, TZ: 'Europe/Moscow' }
  }
```
(остальные переменные шлюз читает из `gateway/.env`).

На деве запуск вручную: `cd /root/loyalpro/gateway && pm2 start server.js --name loyalpro-gateway && sleep 3 && curl -s http://127.0.0.1:3002/health`
Expected: `{"ok":true,"accounts":[]}`.

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add gateway/server.js gateway/lib/registry.js gateway/lib/http-auth.js gateway/test/server-auth.test.js ecosystem.config.js && git commit -m "feat(gateway): HTTP-сервер — Chatpush-совместимая отправка, внутренний API авторизации, реестр аккаунтов

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Часть C. Админка: раздел «Мессенджеры»

### Task 13: Страница подключения Telegram

**Files:**
- Create: `frontend/js/pages/messaging-accounts.js`
- Create: `frontend/js/pages/messaging-accounts.test.js`
- Modify: `frontend/index.html` (пункт меню, секция, `<script>`)
- Modify: `frontend/js/core/nav.js:113` (загрузка секции)

- [ ] **Step 1: Тест чистых помощников**

`frontend/js/pages/messaging-accounts.test.js`:
```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const ctx = { window: {}, document: {}, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/messaging-accounts.js', 'utf8'), ctx);

test('msgAccStateLabel', () => {
  assert.equal(ctx.msgAccStateLabel({ provider: 'chatpush', status: 'active' }), 'Chatpush · активен');
  assert.equal(ctx.msgAccStateLabel({ provider: 'gateway', status: 'active', auth_state: 'ready', phone: '79250177778' }), 'Свой шлюз · подключён · +79250177778');
  assert.equal(ctx.msgAccStateLabel({ provider: 'gateway', status: 'active', auth_state: 'wait_code' }), 'Свой шлюз · ждёт код');
  assert.equal(ctx.msgAccStateLabel({ provider: 'gateway', status: 'disabled', auth_state: 'logged_out' }), 'Свой шлюз · отключён');
});

test('msgAccNextStep — какой ввод показывать по состоянию', () => {
  assert.equal(ctx.msgAccNextStep('wait_phone'), 'phone');
  assert.equal(ctx.msgAccNextStep('wait_code'), 'code');
  assert.equal(ctx.msgAccNextStep('wait_password'), 'password');
  assert.equal(ctx.msgAccNextStep('ready'), null);
  assert.equal(ctx.msgAccNextStep('starting'), 'wait');
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /root/loyalpro/frontend && node --test js/pages/messaging-accounts.test.js 2>&1 | tail -3`
Expected: FAIL, файла нет.

- [ ] **Step 3: Реализовать страницу**

`frontend/js/pages/messaging-accounts.js`:
```js
'use strict';
// Настройки → «Мессенджеры»: аккаунты салона и подключение Telegram через свой
// шлюз (телефон → код → пароль). Чистые помощники наверху — под node --test.

const MSG_ACC_CHANNEL = { whatsapp: 'WhatsApp', tdlib: 'Telegram', max: 'MAX' };
const MSG_ACC_AUTH = { starting: 'запускается', wait_phone: 'ждёт номер', wait_code: 'ждёт код', wait_password: 'ждёт пароль', ready: 'подключён', logged_out: 'отключён', error: 'ошибка' };

function msgAccStateLabel(a) {
  if (a.provider === 'chatpush') return 'Chatpush · ' + (a.status === 'active' ? 'активен' : 'отключён');
  const parts = ['Свой шлюз'];
  parts.push(a.status !== 'active' ? 'отключён' : (MSG_ACC_AUTH[a.auth_state] || a.auth_state || 'неизвестно'));
  if (a.status === 'active' && a.auth_state === 'ready' && a.phone) parts.push('+' + a.phone);
  return parts.join(' · ');
}

function msgAccNextStep(authState) {
  if (authState === 'wait_phone') return 'phone';
  if (authState === 'wait_code') return 'code';
  if (authState === 'wait_password') return 'password';
  if (authState === 'ready' || authState === 'logged_out' || authState === 'error') return null;
  return 'wait';
}

let _msgAccPoll = null;
let _msgAccCurrent = null;   // id подключаемого gateway-аккаунта

async function loadMessagingAccounts() {
  const root = document.getElementById('msg-acc-list');
  if (!root) return;
  root.textContent = 'Загрузка…';
  try {
    const r = await api('GET', '/api/messaging/accounts');
    root.replaceChildren();
    for (const a of r.accounts) {
      const row = document.createElement('div');
      row.className = 'msg-acc-row';
      const ch = document.createElement('b'); ch.textContent = MSG_ACC_CHANNEL[a.channel] || a.channel;
      const st = document.createElement('span'); st.textContent = ' — ' + msgAccStateLabel(a);
      row.append(ch, st);
      if (a.provider === 'gateway' && a.status === 'active') {
        const btn = document.createElement('button'); btn.className = 'btn btn-sec'; btn.textContent = 'Отключить';
        btn.onclick = () => msgAccLogout(a.id);
        row.append(' ', btn);
        if (a.auth_state !== 'ready') { _msgAccCurrent = a.id; msgAccStartPolling(); }
      }
      if (a.status !== 'active') {
        const btn = document.createElement('button'); btn.className = 'btn btn-sec'; btn.textContent = 'Сделать активным';
        btn.onclick = () => msgAccActivate(a.id);
        row.append(' ', btn);
      }
      root.appendChild(row);
    }
    if (!r.accounts.length) root.textContent = 'Аккаунтов нет.';
    const connectBtn = document.getElementById('msg-acc-connect-tg');
    if (connectBtn) connectBtn.disabled = !r.gatewayConfigured;
    const note = document.getElementById('msg-acc-gw-note');
    if (note) note.textContent = r.gatewayConfigured ? '' : 'Свой шлюз не настроен на сервере (MESSAGING_GATEWAY_URL).';
  } catch (e) {
    root.textContent = 'Не удалось загрузить: ' + e.message;
  }
}

async function msgAccConnectTelegram() {
  if (!confirm('Telegram салона будет переключён с Chatpush на свой шлюз. Продолжить?')) return;
  try {
    const r = await api('POST', '/api/messaging/accounts/telegram');
    _msgAccCurrent = r.id;
    msgAccRenderStep(r.authState, null);
    msgAccStartPolling();
    await loadMessagingAccounts();
  } catch (e) { alert('Не удалось начать подключение: ' + e.message); }
}

function msgAccRenderStep(authState, error) {
  const box = document.getElementById('msg-acc-wizard');
  if (!box) return;
  const step = msgAccNextStep(authState);
  const err = document.getElementById('msg-acc-error');
  if (err) err.textContent = error || '';
  box.querySelectorAll('[data-step]').forEach(el => { el.style.display = el.dataset.step === step ? '' : 'none'; });
  box.style.display = step ? '' : 'none';
  if (!step && _msgAccPoll) { clearInterval(_msgAccPoll); _msgAccPoll = null; }
}

async function msgAccSendStep(field) {
  const input = document.getElementById('msg-acc-' + field);
  const value = input ? input.value : '';
  if (!value) return;
  try {
    const r = await api('POST', `/api/messaging/accounts/${_msgAccCurrent}/auth`, { [field]: value });
    if (input && field !== 'phone') input.value = '';
    msgAccRenderStep(r.authState, r.error);
    if (r.authState === 'ready') await loadMessagingAccounts();
  } catch (e) { msgAccRenderStep(null, e.message); }
}

function msgAccStartPolling() {
  if (_msgAccPoll) clearInterval(_msgAccPoll);
  _msgAccPoll = setInterval(async () => {
    if (!_msgAccCurrent || document.body.dataset.page !== 'settings') { clearInterval(_msgAccPoll); _msgAccPoll = null; return; }
    try {
      const s = await api('GET', `/api/messaging/accounts/${_msgAccCurrent}/status`);
      msgAccRenderStep(s.authState, s.error);
      if (s.authState === 'ready') await loadMessagingAccounts();
    } catch (_) { /* следующий тик */ }
  }, 2000);
}

async function msgAccLogout(id) {
  if (!confirm('Отключить Telegram от своего шлюза? Сессия будет удалена.')) return;
  try { await api('POST', `/api/messaging/accounts/${id}/logout`); await loadMessagingAccounts(); }
  catch (e) { alert('Не удалось отключить: ' + e.message); }
}

async function msgAccActivate(id) {
  if (!confirm('Сделать этот аккаунт активным для его канала? Текущий активный будет отключён.')) return;
  try { await api('POST', `/api/messaging/accounts/${id}/activate`); await loadMessagingAccounts(); }
  catch (e) { alert('Не удалось: ' + e.message); }
}
```

В `frontend/index.html`:

1. В меню настроек после пункта `agent-model` (найти `data-sec="agent-model"`) добавить:
```html
          <div class="stg-item" data-sec="messengers" onclick="navStg('messengers',this)"><span class="stg-ic">💬</span>Мессенджеры</div>
```

2. После секции `stg-agent-model` добавить:
```html
        <div class="stg-section" id="stg-messengers">
          <div class="stg-hdr">Мессенджеры</div>
          <p>Через какие аккаунты салон получает и отправляет сообщения. Telegram можно подключить напрямую (свой шлюз), остальные каналы пока идут через Chatpush.</p>
          <div id="msg-acc-list">Загрузка…</div>
          <p id="msg-acc-gw-note" class="muted"></p>
          <button class="btn btn-pri" id="msg-acc-connect-tg" onclick="msgAccConnectTelegram()">Подключить Telegram напрямую</button>
          <div id="msg-acc-wizard" style="display:none;margin-top:12px">
            <div data-step="wait">Запускаем сессию…</div>
            <div data-step="phone">
              <label class="fl" for="msg-acc-phone">Номер телефона аккаунта Telegram клиники</label>
              <input id="msg-acc-phone" placeholder="+7 900 000-00-00" style="max-width:280px">
              <button class="btn btn-pri" onclick="msgAccSendStep('phone')">Отправить код</button>
            </div>
            <div data-step="code">
              <label class="fl" for="msg-acc-code">Код из Telegram (придёт в приложение на телефоне)</label>
              <input id="msg-acc-code" inputmode="numeric" style="max-width:160px">
              <button class="btn btn-pri" onclick="msgAccSendStep('code')">Подтвердить</button>
            </div>
            <div data-step="password">
              <label class="fl" for="msg-acc-password">Пароль двухэтапной проверки</label>
              <input id="msg-acc-password" type="password" style="max-width:280px">
              <button class="btn btn-pri" onclick="msgAccSendStep('password')">Войти</button>
            </div>
            <p id="msg-acc-error" style="color:#c33"></p>
          </div>
        </div>
```

3. Рядом с `<script src="js/pages/agent-model.js?v=…">` добавить `<script src="js/pages/messaging-accounts.js?v=2026-10-08a"></script>`.

В `frontend/js/core/nav.js` после `if (id === 'agent-model') loadAgentModel();` добавить `if (id === 'messengers') loadMessagingAccounts();`. Бамп `?v=` у `nav.js` в `index.html` (например `?v=2026-10-08-msgacc`).

- [ ] **Step 4: Прогнать тест и посмотреть живьём**

Run: `cd /root/loyalpro/frontend && node --test js/pages/messaging-accounts.test.js 2>&1 | tail -3`
Expected: `# pass 2`.

Через MCP Playwright: открыть дев-админку, Настройки → Мессенджеры. Expected: три строки Chatpush (WhatsApp/Telegram/MAX · активен), кнопка «Подключить Telegram напрямую» (активна, если `MESSAGING_GATEWAY_URL` задан в `backend/.env`).

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add frontend/js/pages/messaging-accounts.js frontend/js/pages/messaging-accounts.test.js frontend/index.html frontend/js/core/nav.js && git commit -m "feat(settings): раздел «Мессенджеры» — аккаунты салона и подключение Telegram через свой шлюз

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Часть D. Живая проверка и выкат

### Task 14: Сквозная проверка на деве

**Files:**
- Create: `backend/scripts/gateway-telegram-e2e.js`

Предусловия: в `backend/.env` заданы `MESSAGING_GATEWAY_URL=http://127.0.0.1:3002`, `MESSAGING_GATEWAY_SECRET=<s>`, `GATEWAY_WEBHOOK_SECRET=<w>`; в `gateway/.env` — те же секреты (`GATEWAY_INTERNAL_SECRET=<s>`, `BACKEND_WEBHOOK_URL=http://127.0.0.1:3001/gateway/webhook?key=<w>`), `TG_API_ID/HASH`; оба процесса перезапущены. Нужен ТЕСТОВЫЙ аккаунт Telegram с отдельной SIM (не аккаунт клиники!) и тестовый номер пациента `79200255591`.

- [ ] **Step 1: Подключить тестовый аккаунт через админку**

Настройки → Мессенджеры → «Подключить Telegram напрямую» → ввести номер тестового аккаунта → код → (пароль). Expected: строка «Telegram — Свой шлюз · подключён · +7…». В логе шлюза (`pm2 logs loyalpro-gateway --lines 20 --nostream`): `готов: 7… (<имя>)`.

Через MCP: `SELECT id, channel, provider, status, auth_state FROM messenger_accounts WHERE salon_id=1 ORDER BY id;` Expected: Chatpush-tdlib `disabled`, gateway-tdlib `active/ready`.

- [ ] **Step 2: Скрипт сквозной проверки**

`backend/scripts/gateway-telegram-e2e.js`:
```js
'use strict';
// Живая проверка своего шлюза Telegram (дев). Ничего не стабит: шлёт РЕАЛЬНОЕ
// сообщение на тестовый номер через transport и ждёт эха в chatpush_messages.
//   node scripts/gateway-telegram-e2e.js [--phone 79200255591]
// Проверяет: (1) отправка через gateway-аккаунт даёт delivery g<n>;
// (2) эхо исходящего легло в chatpush_messages с authored_by='agent' (мы
// записали авторство заранее), channel=tdlib, salon_id=1; (3) статус доставки
// по GET /api/v1/delivery/:id — «Отправлено».
require('dotenv').config();
const { db } = require('../db');
const transport = require('../services/messaging/transport');
const accounts = require('../services/messaging/accounts');
const authorship = require('../services/outgoing-authorship');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const phone = arg('--phone', '79200255591');
const SALON = 1;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const creds = await accounts.credentialsFor(SALON, 'tdlib');
  if (!creds || creds.provider !== 'gateway') throw new Error(`tdlib салона ${SALON} не на шлюзе: ${JSON.stringify(creds)}`);
  const text = `Проверка шлюза ${new Date().toISOString().slice(11, 19)}`;
  await authorship.remember(SALON, phone, text, 'agent');
  const d = await transport.sendMessage(SALON, { text, phone, dispatchRouting: ['tdlib'] });
  console.log('delivery:', d);
  if (!/^g\d+$/.test(String(d.id))) throw new Error('ожидался id вида g<n>');

  let row = null;
  for (let i = 0; i < 30 && !row; i++) {
    await sleep(1000);
    row = await db.oneOrNone(
      `SELECT id, channel, direction, authored_by, salon_id, text, external_message_id
         FROM chatpush_messages WHERE salon_id=$1 AND phone=$2 AND text=$3 ORDER BY id DESC LIMIT 1`,
      [SALON, phone, text]);
  }
  console.log('echo row:', row);
  if (!row) throw new Error('эхо исходящего не пришло за 30 с');
  if (row.channel !== 'tdlib' || row.direction !== 'outgoing') throw new Error('эхо не tdlib/outgoing');
  if (row.authored_by !== 'agent') throw new Error(`authored_by=${row.authored_by}, ожидался agent`);
  if (!/^-?\d+:\d+$/.test(row.external_message_id)) throw new Error('external_message_id не составной');

  const st = await transport.getDeliveryStatus(SALON, 'tdlib', d.id);
  console.log('status:', st);
  if (!st || Number(st.status.status_id) !== 2) throw new Error('статус не «Отправлено»');

  const ev = await db.oneOrNone(`SELECT 1 FROM chatpush_events WHERE payload->'payload'->>'delivery_id' = $1`, [String(d.id)]);
  if (!ev) throw new Error('в chatpush_events нет события с этим delivery_id — сторож доставки не подтвердит реплику');
  console.log('OK: отправка, эхо с delivery_id, авторство, статус');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
```

Run: `cd /root/loyalpro/backend && node scripts/gateway-telegram-e2e.js`
Expected: `OK: отправка, эхо с delivery_id, авторство, статус`.

- [ ] **Step 3: Ручные проверки входящих и оператора**

1. С тестового номера пациента написать в Telegram тестового аккаунта клиники. Expected: в «Чате» появился диалог, в логе бэкенда `stored incoming tdlib 79200255591…`; если `CHATPUSH_AGENT_ENABLED=true` и салон в окне — Мила отвечает, ответ приходит в Telegram, в логе `reply … принят в доставку (delivery=g…)`.
2. Ответить пациенту РУКАМИ с телефона тестового аккаунта клиники. Expected: строка в `chatpush_messages` с `authored_by='operator'`, в логе `agent paused 79200255591: ответил оператор`.
3. Из «Чата» отправить файл (картинку) в этот диалог. Expected: картинка приходит в Telegram, лог `operator sent file tdlib … delivery=g…`, через 30 с `status=2 Отправлено`.
4. Прислать с телефона пациента фото. Expected: в «Чате» «📎 Фото» с открывающейся картинкой по `/uploads/gateway/<id>/…jpg`.
5. `pm2 restart loyalpro-gateway`. Expected: в логе `аккаунт #N (7…) запущен` → `готов` без повторного ввода кода (сессия сохранена в `gateway/data/acc-N`).

Результаты записать в `docs/2026-10-XX-gateway-telegram-live-test.md` (дата прогона, что прошло, что нет).

- [ ] **Step 4: Коммит**

```bash
cd /root/loyalpro && git add backend/scripts/gateway-telegram-e2e.js docs/ && git commit -m "test(gateway): живая сквозная проверка Telegram-шлюза на деве + отчёт

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 15: Выкат на прод (чек-лист, выполняется руками по шагам)

**Files:** нет новых; `docs/superpowers/plans/…` этот раздел.

- [ ] **Step 1: Предусловия на проде**

На `ssh root@217.114.0.254`: `node -v` (≥ 20), `ldd --version | head -1` (glibc ≥ 2.17), свободно ≥ 1 ГБ диска под `gateway/data` и `node_modules` TDLib (~100 МБ).

- [ ] **Step 2: Слить ветку и установить шлюз**

`git pull` в `/var/www/loyalpro` (или актуальный каталог прода из memory `deploy_prod_setup`), `cd gateway && npm ci --omit=dev`, создать `gateway/.env` (TG_API_ID/HASH те же, `DATABASE_URL` прода, секреты сгенерировать `openssl rand -hex 24` ×2), в `backend/.env` добавить `MESSAGING_GATEWAY_URL`, `MESSAGING_GATEWAY_SECRET`, `GATEWAY_WEBHOOK_SECRET`. `mkdir -p frontend/uploads/gateway`.

- [ ] **Step 3: Поднять бэкенд с миграцией, затем шлюз**

`pm2 restart loyalpro` → проверить через MCP `SELECT … FROM messenger_accounts` — три строки Chatpush салона 1 из env. `pm2 start ecosystem.config.js --only loyalpro-gateway && pm2 save` → `curl -s http://127.0.0.1:3002/health` → `{"ok":true,"accounts":[]}`.

На этом шаге прод ВСЁ ЕЩЁ на Chatpush по всем каналам. Понаблюдать сутки: `grep -c "delivery=" backend/logs/*.log` растёт, ошибок `нет аккаунта мессенджера` нет.

- [ ] **Step 4: Переключить Telegram клиники (в окно без нагрузки, днём, когда администратор на связи)**

1. Настройки → Мессенджеры → «Подключить Telegram напрямую» → номер клиники → код приходит в Telegram клиники на телефон администратора → (пароль 2FA). Chatpush-строка tdlib гасится автоматически.
2. Проверить входящее и исходящее по шагам Task 14 Step 3 (пп. 1–3) на тестовом номере.
3. В личном кабинете Chatpush выйти из Telegram-аккаунта клиники (иначе Chatpush продолжит слать `tdlib_incoming_msg`, и каждое сообщение ляжет в «Чат» ДВАЖДЫ: от Chatpush и от шлюза — дедуп по `external_message_id` их не склеит, id разные). Либо, если выходить нельзя сразу, снять `tdlib_incoming_msg` из типов вебхука Chatpush (`chatpush.updateWebhook`).
4. Сутки наблюдать: `pm2 logs loyalpro-gateway`, лог бэкенда на `НЕ ДОСТАВЛЕНО`, `agent_reply_deliveries` на `status='failed'`.

- [ ] **Step 5: Откат (если что-то не так)**

Настройки → Мессенджеры → у строки «Telegram — Chatpush · отключён» нажать «Сделать активным» (шлюзовая строка гасится, отправки идут в Chatpush), в Chatpush снова войти в Telegram. Шлюзовую сессию можно оставить запущенной — она только принимает, а вебхуки с `provider=gateway` по-прежнему резолвятся в салон; чтобы не было двойных входящих, после отката нажать «Отключить» у шлюзовой строки.

- [ ] **Step 6: Зафиксировать результат**

В `MEMORY.md`/memory-файл проекта: дата переключения, id аккаунта, что наблюдалось. В CLAUDE.md — короткий раздел «Свой шлюз мессенджеров (gateway/)» со ссылкой на этот план и контракт.

---

## Что СОЗНАТЕЛЬНО не входит в этот план

- WhatsApp и MAX остаются на Chatpush. Реестр аккаунтов и transport уже готовы принять для них другой провайдер (новая строка `provider='gateway'` + адаптер в шлюзе), но риски WhatsApp (неофициальный протокол, бан номера) — отдельное решение владельца.
- QR-вход в Telegram (`requestQrCodeAuthentication`) — не нужен: у Telegram вход по коду достаточно прост, QR добавим, если администраторам будет удобнее.
- Алерт в Telegram ops-чат при `auth_state` ≠ `ready` у активного шлюзового аккаунта дольше 5 минут (через существующий `services/ops-alert.js`) — следующий шаг после выката; до него разлогин виден в разделе «Мессенджеры» и в логе шлюза.
- Удаление/ротация медиа в `frontend/uploads/gateway/` — файлы копятся; чистка по возрасту (например 90 дней) кроном бэкенда — отдельная задача.
- Обновление профиля клиента (`clients`) по данным Telegram — не делаем, как и Chatpush.

## Self-review (выполнен при написании)

- Покрытие: таблица + сид (T1), реестр и резолв (T2), креды объектом (T3), единая отправка (T4), все 9 точек отправки (T5), вебхук с провайдером (T6), админ-API и клиент шлюза (T7), каркас и спайк (T8), маппер (T9), доставки/вебхуки (T10), TDLib-клиент (T11), сервер+реестр (T12), UI (T13), живая проверка (T14), выкат и откат (T15). Мультисалонность: строка на (салон, канал), резолв входящего по `(provider, external_id)`, отправка по салону — второй салон = строки в таблице + подключение из его админки.
- Согласованность имён: `accounts.credentialsFor/resolveSalon/listForSalon/invalidate` (T2) используются в T4, T6, T7; `transport.sendMessage(salonId, payload)/sendFile(salonId, payload, buf, mime)/getDeliveryStatus(salonId, channel, id)/configured()` (T4) — в T5, T14; `gatewayClient.start/auth/status/logout` (T7) ↔ `/internal/accounts/:id/{start,auth,status,logout}` (T12); `mapper.buildWebhookBody/contentOf/parseCompositeId/deliveryStatus/normalizePhone/isGroupChat/fullName` (T9) — в T11, T12; `deliveries.create/setStatus/get/parseId/STATUS` (T10) — в T11, T12; `repo.get/listActive/byToken/setAuth/contactUserId/rememberContact` (T11) — в T12; `auth_state` значения одни и те же в T7 (parse), T11 (`AUTH_MAP`), T13 (`MSG_ACC_AUTH`, `msgAccNextStep`).
- Известный тонкий момент: в T11 `onNewMessage` пропускает сообщения с `sending_state`; если TDLib на конкретной версии НЕ присылает `updateMessageSendSucceeded` для некоторых типов (например, при мгновенной отправке), эхо нашей отправки потеряется — проверяется T14 Step 2 (`echo row` обязан найтись). Если не найдётся — в `onNewMessage` разрешить `sending_state` и дедупить по `pendingSends` (эмитить из `onNewMessage` с `deliveryId` из карты, а из `onSendSucceeded` только статус).
