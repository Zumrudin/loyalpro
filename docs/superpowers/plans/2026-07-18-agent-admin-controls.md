# Agent Admin Controls & Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать админке управление ИИ-агентом (вкл/выкл, режим `all`/`whitelist`, белый/чёрный списки номеров) и подключить гейт допуска к вебхуку, чтобы на этапе теста агент отвечал только на разрешённые номера (напр. только владельцу `89200255591`), не спамя клиентов.

**Architecture:** Чистая функция допуска (`services/agent-gate.js`, нормализация номера РФ `8→7` + решение gate) под юнит-тестами; тонкий DB-слой (`services/agent-settings.js`) поверх двух таблиц (`agent_settings`, `agent_number_rules`); REST API (`routes/agent-settings.js`, owner/admin); вызов гейта в `routes/chatpush-webhook.js` перед авто-ответом; админ-панель на странице «Чат». Это первый из четырёх планов (см. спек `docs/superpowers/specs/2026-07-18-ai-booking-agent-design.md`); ядро агента/LLM/YClients — отдельными планами.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg` через `db.js`), Jest 30 (`npx jest <file>`), ванильный JS фронтенд.

---

## File Structure

**Создаются:**
- `backend/services/agent-gate.js` — чистые хелперы: `normalizePhoneKey(raw)`, `decideGate({...})`. Без БД/HTTP.
- `backend/agent-gate.test.js` — юнит-тесты чистого гейта (Jest).
- `backend/services/agent-settings.js` — DB-слой: чтение/запись настроек и правил, комбинированный `isAllowed()`.
- `backend/routes/agent-settings.js` — REST API `/api/agent/*` (owner/admin).
- `frontend/js/pages/agent-settings.js` — админ-панель (модалка) управления агентом.

**Модифицируются:**
- `backend/migrations.js` — добавить таблицы `agent_settings`, `agent_number_rules`.
- `backend/routes/index.js` — смонтировать `/api/agent`.
- `backend/routes/chatpush-webhook.js` — вызвать гейт перед авто-ответом.
- `frontend/index.html` — кнопка «⚙️ Агент» + модалка + подключить скрипт.

---

## Task 1: Чистый гейт допуска + нормализация номера (TDD)

**Files:**
- Create: `backend/services/agent-gate.js`
- Test: `backend/agent-gate.test.js`

- [ ] **Step 1: Написать падающий тест**

Create `backend/agent-gate.test.js`:

```js
'use strict';
const { normalizePhoneKey, decideGate } = require('./services/agent-gate');

describe('normalizePhoneKey', () => {
  test('РФ 8→7 для 11 цифр', () => {
    expect(normalizePhoneKey('89200255591')).toBe('79200255591');
  });
  test('оставляет 7XXXXXXXXXX как есть', () => {
    expect(normalizePhoneKey('79200255591')).toBe('79200255591');
  });
  test('чистит форматирование и +', () => {
    expect(normalizePhoneKey('+7 (920) 025-55-91')).toBe('79200255591');
  });
  test('10-значное ядро → префикс 7', () => {
    expect(normalizePhoneKey('9200255591')).toBe('79200255591');
  });
  test('пустой/мусор → пустая строка', () => {
    expect(normalizePhoneKey('')).toBe('');
    expect(normalizePhoneKey(null)).toBe('');
  });
});

describe('decideGate', () => {
  const base = { enabled: true, mode: 'all', allow: [], block: [], phone: '79200255591' };

  test('выключен → deny', () => {
    expect(decideGate({ ...base, enabled: false })).toEqual({ allow: false, reason: 'disabled' });
  });
  test('режим all пропускает незнакомый номер', () => {
    expect(decideGate({ ...base })).toEqual({ allow: true, reason: 'ok' });
  });
  test('чёрный список сильнее (даже в режиме all)', () => {
    expect(decideGate({ ...base, block: ['79200255591'] }))
      .toEqual({ allow: false, reason: 'blacklisted' });
  });
  test('whitelist: номер в белом (после 8→7) → allow', () => {
    expect(decideGate({ ...base, mode: 'whitelist', allow: ['79200255591'], phone: '89200255591' }))
      .toEqual({ allow: true, reason: 'ok' });
  });
  test('whitelist: номера нет в белом → deny', () => {
    expect(decideGate({ ...base, mode: 'whitelist', allow: ['79990001122'] }))
      .toEqual({ allow: false, reason: 'not-whitelisted' });
  });
  test('whitelist: пустой номер (Telegram chat_id) → deny', () => {
    expect(decideGate({ ...base, mode: 'whitelist', allow: ['79200255591'], phone: '' }))
      .toEqual({ allow: false, reason: 'not-whitelisted' });
  });
  test('чёрный список срабатывает и в whitelist', () => {
    expect(decideGate({ ...base, mode: 'whitelist', allow: ['79200255591'], block: ['79200255591'] }))
      .toEqual({ allow: false, reason: 'blacklisted' });
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd backend && npx jest agent-gate --silent`
Expected: FAIL — `Cannot find module './services/agent-gate'`.

- [ ] **Step 3: Написать минимальную реализацию**

Create `backend/services/agent-gate.js`:

```js
'use strict';
// ============================================================
// Agent gate — чистые хелперы допуска ИИ-агента к диалогу (без БД/HTTP).
// Юнит-тесты в backend/agent-gate.test.js.
// ============================================================

// Канонический ключ номера: только цифры, РФ-формат 8→7, 10-значное ядро → 7XXXXXXXXXX.
// '89200255591' → '79200255591', '+7 (920) 025-55-91' → '79200255591'.
function normalizePhoneKey(raw) {
  const digits = raw ? String(raw).replace(/\D/g, '') : '';
  if (!digits) return '';
  if (digits.length === 11 && (digits[0] === '8' || digits[0] === '7')) return '7' + digits.slice(1);
  if (digits.length === 10) return '7' + digits;
  return digits;
}

// Решение допуска. Чистая функция. Порядок: enabled → чёрный список → режим/белый.
// @param {boolean} enabled
// @param {'all'|'whitelist'} mode
// @param {string[]} allow  нормализованные номера белого списка
// @param {string[]} block  нормализованные номера чёрного списка
// @param {string}   phone  сырой номер входящего (нормализуем внутри)
// @returns {{allow: boolean, reason: string}}
function decideGate({ enabled, mode, allow, block, phone }) {
  if (!enabled) return { allow: false, reason: 'disabled' };
  const key = normalizePhoneKey(phone);
  if (key && (block || []).includes(key)) return { allow: false, reason: 'blacklisted' };
  if (mode === 'whitelist') {
    if (!key || !(allow || []).includes(key)) return { allow: false, reason: 'not-whitelisted' };
  }
  return { allow: true, reason: 'ok' };
}

module.exports = { normalizePhoneKey, decideGate };
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `cd backend && npx jest agent-gate --silent`
Expected: PASS (12 тестов).

- [ ] **Step 5: Коммит**

```bash
git add backend/services/agent-gate.js backend/agent-gate.test.js
git commit -m "feat(agent): чистый гейт допуска + нормализация номера 8→7"
```

---

## Task 2: Таблицы agent_settings и agent_number_rules

**Files:**
- Modify: `backend/migrations.js:926` (вставить перед закрывающей `}` функции `runMigrations`, после блока индексов `chatpush_messages`)

- [ ] **Step 1: Добавить создание таблиц в миграции**

В `backend/migrations.js` найти конец блока chatpush (строка 926, после `idx_chatpush_messages_dialogkey`) и **перед** закрывающей `}` функции вставить:

```js
  // agent_settings — настройки ИИ-агента по салону (вкл/выкл + режим допуска).
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_settings (
      salon_id INTEGER PRIMARY KEY REFERENCES salons(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      mode VARCHAR(20) NOT NULL DEFAULT 'all',
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});

  // agent_number_rules — белый/чёрный списки номеров для допуска агента.
  // phone хранится каноничным (только цифры, РФ 8→7) — см. services/agent-gate.
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_number_rules (
      id SERIAL PRIMARY KEY,
      salon_id INTEGER REFERENCES salons(id) ON DELETE CASCADE,
      phone VARCHAR(32) NOT NULL,
      rule_type VARCHAR(10) NOT NULL,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (salon_id, phone, rule_type)
    )
  `).catch(() => {});
```

- [ ] **Step 2: Прогнать миграции на dev-БД и проверить таблицы**

Миграции идут через `db.js` (dev-БД доступна из dev-сервера напрямую; `mcp__postgres` таймаутит — только `node`). Run:

```bash
cd backend && node -e "
const { runMigrations } = require('./migrations');
const { pool } = require('./db');
(async () => {
  await runMigrations();
  const r = await pool.query(\"SELECT table_name FROM information_schema.tables WHERE table_name IN ('agent_settings','agent_number_rules') ORDER BY table_name\");
  console.log(r.rows.map(x => x.table_name));
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
"
```

Expected output: `[ 'agent_number_rules', 'agent_settings' ]`

> Если `runMigrations` требует переданный клиент/иную сигнатуру — свериться с тем, как её зовёт `server.js`, и повторить тот же вызов. Индексы по `salon_id` не нужны: `agent_settings` PK = `salon_id`, а `agent_number_rules` мал и всегда фильтруется по `salon_id` с малой кардинальностью.

- [ ] **Step 3: Коммит**

```bash
git add backend/migrations.js
git commit -m "feat(agent): таблицы agent_settings и agent_number_rules"
```

---

## Task 3: DB-слой настроек агента (services/agent-settings.js)

**Files:**
- Create: `backend/services/agent-settings.js`

- [ ] **Step 1: Написать сервис**

Create `backend/services/agent-settings.js`:

```js
'use strict';
// ============================================================
// Agent settings — настройки ИИ-агента и списки номеров (БД).
// Таблицы agent_settings / agent_number_rules (migrations.js).
// Решение допуска делегируется чистому services/agent-gate.
// ============================================================
const { db } = require('../db');
const { normalizePhoneKey, decideGate } = require('./agent-gate');

const DEFAULTS = { enabled: false, mode: 'all' };

async function getSettings(salonId) {
  if (!salonId) return { ...DEFAULTS };
  const row = await db.oneOrNone(
    'SELECT enabled, mode FROM agent_settings WHERE salon_id=$1', [salonId]
  );
  return row || { ...DEFAULTS };
}

async function updateSettings(salonId, { enabled, mode }) {
  const m = mode === 'whitelist' ? 'whitelist' : 'all';
  return db.one(
    `INSERT INTO agent_settings (salon_id, enabled, mode, updated_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (salon_id) DO UPDATE SET enabled=$2, mode=$3, updated_at=NOW()
     RETURNING enabled, mode`,
    [salonId, !!enabled, m]
  );
}

async function listNumberRules(salonId, ruleType) {
  return db.any(
    `SELECT id, phone, rule_type, note, created_at
       FROM agent_number_rules
      WHERE salon_id=$1 AND ($2::text IS NULL OR rule_type=$2)
      ORDER BY created_at DESC`,
    [salonId, ruleType || null]
  );
}

async function addNumberRule(salonId, { phone, ruleType, note }) {
  const key = normalizePhoneKey(phone);
  if (!key) { const e = new Error('invalid phone'); e.code = 'BAD_PHONE'; throw e; }
  const type = ruleType === 'block' ? 'block' : 'allow';
  return db.one(
    `INSERT INTO agent_number_rules (salon_id, phone, rule_type, note)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (salon_id, phone, rule_type) DO UPDATE SET note=EXCLUDED.note
     RETURNING id, phone, rule_type, note, created_at`,
    [salonId, key, type, note || null]
  );
}

async function removeNumberRule(salonId, id) {
  await db.query('DELETE FROM agent_number_rules WHERE salon_id=$1 AND id=$2', [salonId, id]);
}

// Комбинированный допуск: настройки + списки → решение чистого гейта.
async function isAllowed(salonId, phone) {
  const settings = await getSettings(salonId);
  if (!settings.enabled) return { allow: false, reason: 'disabled' };
  const rules = await listNumberRules(salonId, null);
  const allow = rules.filter(r => r.rule_type === 'allow').map(r => r.phone);
  const block = rules.filter(r => r.rule_type === 'block').map(r => r.phone);
  return decideGate({ enabled: true, mode: settings.mode, allow, block, phone });
}

module.exports = {
  getSettings, updateSettings, listNumberRules, addNumberRule, removeNumberRule, isAllowed,
};
```

- [ ] **Step 2: Проверить сквозной путь на dev-БД (integration smoke)**

Прогнать реальный цикл против dev-БД (salon 1), с очисткой за собой:

```bash
cd backend && node -e "
const s = require('./services/agent-settings');
const { pool } = require('./db');
(async () => {
  await s.updateSettings(1, { enabled: true, mode: 'whitelist' });
  const rule = await s.addNumberRule(1, { phone: '89200255591', ruleType: 'allow', note: 'owner test' });
  console.log('stored phone:', rule.phone);                         // ждём 79200255591
  console.log('allowed owner:', (await s.isAllowed(1, '79200255591')).allow);   // true
  console.log('blocked other:', (await s.isAllowed(1, '79991112233')).allow);   // false
  await s.removeNumberRule(1, rule.id);
  await s.updateSettings(1, { enabled: false, mode: 'all' });       // вернуть в дефолт
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
"
```

Expected:
```
stored phone: 79200255591
allowed owner: true
blocked other: false
```

- [ ] **Step 3: Коммит**

```bash
git add backend/services/agent-settings.js
git commit -m "feat(agent): DB-слой настроек и списков номеров агента"
```

---

## Task 4: REST API /api/agent/* + монтирование

**Files:**
- Create: `backend/routes/agent-settings.js`
- Modify: `backend/routes/index.js:59` (после `app.use('/api/chat', ...)`)

- [ ] **Step 1: Написать роутер**

Create `backend/routes/agent-settings.js`:

```js
'use strict';
// ============================================================
// Agent settings API — управление ИИ-агентом из админки (owner/admin).
// Тумблер вкл/выкл, режим допуска (all|whitelist), белый/чёрный списки номеров.
// ============================================================
const router = require('express').Router();
const { auth, requireRole } = require('../middleware/auth');
const settings = require('../services/agent-settings');
const { createLogger } = require('../logger');
const logger = createLogger('AgentSettings');

const adminOnly = [auth, requireRole('owner', 'admin')];

// GET /api/agent/settings → { enabled, mode }
router.get('/settings', adminOnly, async (req, res) => {
  try { res.json(await settings.getSettings(req.user.salonId)); }
  catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// PUT /api/agent/settings { enabled, mode }
router.put('/settings', adminOnly, async (req, res) => {
  try {
    const { enabled, mode } = req.body || {};
    res.json(await settings.updateSettings(req.user.salonId, { enabled, mode }));
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// GET /api/agent/number-rules?type=allow|block → { rules: [...] }
router.get('/number-rules', adminOnly, async (req, res) => {
  try {
    const type = (req.query.type === 'allow' || req.query.type === 'block') ? req.query.type : null;
    res.json({ rules: await settings.listNumberRules(req.user.salonId, type) });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// POST /api/agent/number-rules { phone, ruleType, note }
router.post('/number-rules', adminOnly, async (req, res) => {
  try {
    const { phone, ruleType, note } = req.body || {};
    res.json(await settings.addNumberRule(req.user.salonId, { phone, ruleType, note }));
  } catch (e) {
    if (e.code === 'BAD_PHONE') return res.status(400).json({ error: 'Некорректный номер' });
    logger.error(e.message); res.status(500).json({ error: 'server error' });
  }
});

// DELETE /api/agent/number-rules/:id
router.delete('/number-rules/:id', adminOnly, async (req, res) => {
  try {
    await settings.removeNumberRule(req.user.salonId, parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

module.exports = router;
```

- [ ] **Step 2: Смонтировать роутер**

В `backend/routes/index.js` после строки 59 (`app.use('/api/chat', require('./chat'));`) добавить:

```js
  app.use('/api/agent',             require('./agent-settings'));
```

- [ ] **Step 3: Проверить API на запущенном dev-сервере**

Перезапустить dev (`pm2 restart loyalpro --update-env`, подождать ~8с, проверить `ss -ltnp | grep 3001` — см. память про EADDRINUSE). Получить JWT owner/admin и прогнать (подставить реальный токен):

```bash
TOKEN="<owner_jwt>"
curl -s -X PUT localhost:3001/api/agent/settings -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"enabled":true,"mode":"whitelist"}'
curl -s -X POST localhost:3001/api/agent/number-rules -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"phone":"89200255591","ruleType":"allow","note":"owner"}'
curl -s localhost:3001/api/agent/number-rules?type=allow -H "Authorization: Bearer $TOKEN"
```

Expected: PUT → `{"enabled":true,"mode":"whitelist"}`; POST → объект с `"phone":"79200255591"`; GET → `{"rules":[{...,"phone":"79200255591",...}]}`. Затем вернуть в дефолт: `curl -s -X PUT ... -d '{"enabled":false,"mode":"all"}'` и удалить правило `DELETE /api/agent/number-rules/<id>`.

- [ ] **Step 4: Коммит**

```bash
git add backend/routes/agent-settings.js backend/routes/index.js
git commit -m "feat(agent): REST API /api/agent (настройки + списки номеров)"
```

---

## Task 5: Подключить гейт к вебхуку

**Files:**
- Modify: `backend/routes/chatpush-webhook.js:21` (импорт) и `:138-150` (условие авто-ответа)

- [ ] **Step 1: Добавить импорт сервиса**

В `backend/routes/chatpush-webhook.js` после строки 21 (`const { generateReply } = require('../services/chatpush-agent');`) добавить:

```js
const agentSettings = require('../services/agent-settings');
```

- [ ] **Step 2: Обернуть авто-ответ гейтом**

Заменить блок (строки 138-150):

```js
    // 3) Авто-ответ — ТОЛЬКО при включённом агенте и только на входящее.
    if (config.CHATPUSH.agentEnabled && msg && msg.direction === 'incoming') {
      const reply = await generateReply(msg);
      if (!reply) return;
      const token = config.CHATPUSH.instanceToken;
      if (!token) { logger.error('CHATPUSH_INSTANCE_TOKEN not set — cannot reply'); return; }
      const delivery = await chatpush.sendMessage(token, {
        text: reply,
        phone: msg.phone,
        dispatchRouting: [chatpush.replyRoutingFor(msg.channel)],
        replyToMessageId: msg.messageId,
      });
      logger.info(`agent replied to ${msg.phone} (delivery=${delivery?.id}) in ${Date.now() - t0}ms`);
    }
```

на:

```js
    // 3) Авто-ответ — при глобальном флаге (env kill-switch) И допуске из админки
    //    (per-salon вкл/выкл + белый/чёрный список), только на входящее.
    if (config.CHATPUSH.agentEnabled && msg && msg.direction === 'incoming') {
      const gate = await agentSettings.isAllowed(salonId, msg.phone);
      if (!gate.allow) {
        logger.info(`agent gate: skip ${msg.phone || msg.chatId || '?'} (${gate.reason})`);
      } else {
        const reply = await generateReply(msg);
        if (!reply) return;
        const token = config.CHATPUSH.instanceToken;
        if (!token) { logger.error('CHATPUSH_INSTANCE_TOKEN not set — cannot reply'); return; }
        const delivery = await chatpush.sendMessage(token, {
          text: reply,
          phone: msg.phone,
          dispatchRouting: [chatpush.replyRoutingFor(msg.channel)],
          replyToMessageId: msg.messageId,
        });
        logger.info(`agent replied to ${msg.phone} (delivery=${delivery?.id}) in ${Date.now() - t0}ms`);
      }
    }
```

- [ ] **Step 3: Проверить гейт симуляцией вебхука (без реальной отправки)**

Временно включить агента через env для теста (`CHATPUSH_AGENT_ENABLED=true` в dev `.env`, перезапустить dev). Настроить whitelist на владельца (Task 4), затем послать симулированные входящие. Отправка chatpush к клиенту не тестового номера НЕ должна произойти — смотрим лог `agent gate: skip ... (not-whitelisted)`.

```bash
# входящее НЕ из белого списка → должно быть пропущено гейтом
curl -s -X POST "localhost:3001/chatpush/webhook?key=$CHATPUSH_WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' -d '{
    "type":"tdlib_incoming_msg",
    "payload":{"direction":"incoming","customer_id":46594,
      "message":{"id":"sim-1","text":"привет","type":"formattedText"},
      "chat_id":"111","sender_phone_number":"79991112233","sender_name":"Not Owner"}}'
```

Проверить лог: `tail -n 20 backend/logs/*.log | grep -i "agent gate"` → строка `agent gate: skip 79991112233 (not-whitelisted)`.
Затем повторить с `"sender_phone_number":"79200255591"` — лог покажет попытку ответа владельцу (`agent replied ...` или ошибку доставки, если тестовый инстанс не шлёт — это ожидаемо; главное, что гейт ПРОПУСТИЛ только владельца).

После теста вернуть `CHATPUSH_AGENT_ENABLED=false` (или оставить, но с `enabled=false` в admin-настройках) и перезапустить dev.

- [ ] **Step 4: Коммит**

```bash
git add backend/routes/chatpush-webhook.js
git commit -m "feat(agent): гейт допуска в вебхуке — авто-ответ только разрешённым номерам"
```

---

## Task 6: Админ-панель управления агентом (фронтенд)

**Files:**
- Create: `frontend/js/pages/agent-settings.js`
- Modify: `frontend/index.html:1132` (кнопка в шапке «Чат»), `frontend/index.html:1141` (модалка перед `</div>` страницы), `frontend/index.html:1902` (подключить скрипт)

- [ ] **Step 1: Добавить кнопку и модалку в разметку**

В `frontend/index.html` заменить строку 1132:

```html
        <button class="btn btn-sec" onclick="loadChat()">↻ Обновить</button>
```

на:

```html
        <div style="display:flex;gap:8px">
          <button class="btn btn-sec" onclick="openAgentSettings()">⚙️ Агент</button>
          <button class="btn btn-sec" onclick="loadChat()">↻ Обновить</button>
        </div>
```

Затем перед закрывающим `</div>` страницы `#page-chat` (после `chat-layout`, строка 1141 `</div>`, перед строкой 1142) вставить модалку:

```html
      <div class="modal-overlay" id="agent-settings-modal" style="display:none">
        <div class="modal-box">
          <div class="modal-head">
            <h3>Настройки ИИ-агента</h3>
            <button class="modal-close" onclick="closeAgentSettings()">✕</button>
          </div>
          <div class="stg-section">
            <label class="fl"><input type="checkbox" id="agent-enabled"> Агент включён</label>
          </div>
          <div class="stg-section">
            <div class="fl">Кому отвечать:</div>
            <label class="fl"><input type="radio" name="agent-mode" value="all"> Всем</label>
            <label class="fl"><input type="radio" name="agent-mode" value="whitelist"> Только указанным номерам</label>
          </div>
          <div class="stg-section" id="agent-allow-section">
            <div class="fl">Белый список (кому отвечать в режиме «только указанным»)</div>
            <div id="agent-allow-list" class="agent-num-list"></div>
            <div style="display:flex;gap:6px;margin-top:6px">
              <input class="fg" id="agent-allow-input" placeholder="Напр. 89200255591">
              <button class="btn btn-pri" onclick="addAgentNumber('allow')">Добавить</button>
            </div>
          </div>
          <div class="stg-section">
            <div class="fl">Чёрный список (кому не отвечать никогда)</div>
            <div id="agent-block-list" class="agent-num-list"></div>
            <div style="display:flex;gap:6px;margin-top:6px">
              <input class="fg" id="agent-block-input" placeholder="Напр. 79991112233">
              <button class="btn btn-pri" onclick="addAgentNumber('block')">Добавить</button>
            </div>
          </div>
          <div class="stg-section" style="text-align:right">
            <button class="btn btn-pri" onclick="saveAgentSettings()">Сохранить</button>
          </div>
        </div>
      </div>
```

> Классы `modal-overlay`/`modal-box`/`modal-head`/`modal-close`/`stg-section`/`btn`/`btn-pri`/`btn-sec`/`fl`/`fg` — уже в проекте (используются в portfolio/settings). Если имя класса модалки в проекте иное — свериться с `frontend/js/pages/portfolio.js` (модалка категории) и повторить его разметку.

- [ ] **Step 2: Подключить скрипт**

В `frontend/index.html` после строки 1902 (`<script src="js/pages/chat.js"></script>`) добавить:

```html
<script src="js/pages/agent-settings.js"></script>
```

- [ ] **Step 3: Написать логику панели**

Create `frontend/js/pages/agent-settings.js`:

```js
'use strict';
// ── Настройки ИИ-агента (модалка на странице «Чат») — owner/admin ──
let _agentRules = { allow: [], block: [] };

const _agEsc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function openAgentSettings() {
  document.getElementById('agent-settings-modal').style.display = 'flex';
  try {
    const s = await api('GET', '/api/agent/settings');
    document.getElementById('agent-enabled').checked = !!s.enabled;
    document.querySelectorAll('input[name="agent-mode"]').forEach(r => {
      r.checked = r.value === (s.mode || 'all');
    });
    _agentToggleAllowSection();
    document.querySelectorAll('input[name="agent-mode"]').forEach(r => {
      r.onchange = _agentToggleAllowSection;
    });
    await loadAgentRules();
  } catch (e) { console.error('agent settings:', e); notify('Ошибка загрузки настроек'); }
}

function closeAgentSettings() {
  document.getElementById('agent-settings-modal').style.display = 'none';
}

function _agentMode() {
  const r = document.querySelector('input[name="agent-mode"]:checked');
  return r ? r.value : 'all';
}

function _agentToggleAllowSection() {
  document.getElementById('agent-allow-section').style.opacity =
    _agentMode() === 'whitelist' ? '1' : '0.5';
}

async function loadAgentRules() {
  const data = await api('GET', '/api/agent/number-rules');
  const rules = data.rules || [];
  _agentRules.allow = rules.filter(r => r.rule_type === 'allow');
  _agentRules.block = rules.filter(r => r.rule_type === 'block');
  _renderAgentList('allow');
  _renderAgentList('block');
}

function _renderAgentList(type) {
  const el = document.getElementById(`agent-${type}-list`);
  const rows = _agentRules[type];
  if (!rows.length) { el.innerHTML = '<div class="empty">Пусто</div>'; return; }
  el.innerHTML = rows.map(r => `
    <div class="agent-num-row">
      <span>${_agEsc(r.phone)}${r.note ? ` — ${_agEsc(r.note)}` : ''}</span>
      <button class="btn btn-sec" onclick="removeAgentNumber(${r.id})">✕</button>
    </div>`).join('');
}

async function addAgentNumber(type) {
  const input = document.getElementById(`agent-${type}-input`);
  const phone = input.value.trim();
  if (!phone) return;
  try {
    await api('POST', '/api/agent/number-rules', { phone, ruleType: type, note: '' });
    input.value = '';
    await loadAgentRules();
  } catch (e) { console.error(e); notify('Не удалось добавить номер'); }
}

async function removeAgentNumber(id) {
  try { await api('DELETE', '/api/agent/number-rules/' + id); await loadAgentRules(); }
  catch (e) { console.error(e); notify('Не удалось удалить номер'); }
}

async function saveAgentSettings() {
  try {
    await api('PUT', '/api/agent/settings', {
      enabled: document.getElementById('agent-enabled').checked,
      mode: _agentMode(),
    });
    notify('Настройки агента сохранены');
    closeAgentSettings();
  } catch (e) { console.error(e); notify('Ошибка сохранения'); }
}

window.openAgentSettings = openAgentSettings;
window.closeAgentSettings = closeAgentSettings;
window.addAgentNumber = addAgentNumber;
window.removeAgentNumber = removeAgentNumber;
window.saveAgentSettings = saveAgentSettings;
```

> Сигнатура `api(method, path, body?)` и глобальный `notify(...)` — из `frontend/js/core/api.js` / `utils.js` (те же, что зовёт `chat.js`: `api('GET', '/api/chat/dialogs')`). Свериться при реализации; если `api` принимает объект — привести вызовы к местной сигнатуре.

- [ ] **Step 4: Проверить в браузере (Playwright MCP)**

Через `mcp__playwright__*`: залогиниться owner/admin на dev (`http://localhost:3001`), открыть страницу «Чат», нажать «⚙️ Агент». Проверить: модалка открывается; включить агента, выбрать «Только указанным номерам», добавить `89200255591` → в списке появляется `79200255591` (нормализация); «Сохранить» → уведомление. Переоткрыть модалку → состояние сохранилось. Удалить номер, вернуть режим «Всем», выключить агента, сохранить (вернуть дефолт).

- [ ] **Step 5: Коммит**

```bash
git add frontend/js/pages/agent-settings.js frontend/index.html
git commit -m "feat(agent): админ-панель управления агентом на странице Чат"
```

---

## Task 7: Обновить CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (секция про модули / Key constraints)

- [ ] **Step 1: Добавить краткое описание модуля**

В `CLAUDE.md` добавить абзац (рядом с описанием chatpush/чата):

```markdown
### AI-агент: управление и гейт допуска
- `services/agent-gate.js` — чистые хелперы: `normalizePhoneKey` (РФ `8→7`), `decideGate` (порядок: enabled → чёрный список → режим/белый). Юнит-тесты `agent-gate.test.js`.
- `services/agent-settings.js` — настройки (`agent_settings`) и списки номеров (`agent_number_rules`); `isAllowed(salonId, phone)` объединяет их через `decideGate`.
- `routes/agent-settings.js` (`/api/agent`, owner/admin) — тумблер, режим `all|whitelist`, CRUD номеров.
- `routes/chatpush-webhook.js` зовёт `isAllowed` перед авто-ответом. Два уровня: env `CHATPUSH_AGENT_ENABLED` (глобальный kill-switch) И per-salon настройки. Номера в списках хранятся каноничными.
- Фронт: модалка «⚙️ Агент» на странице «Чат» (`frontend/js/pages/agent-settings.js`).
```

- [ ] **Step 2: Коммит**

```bash
git add CLAUDE.md
git commit -m "docs(agent): описание модуля управления агентом в CLAUDE.md"
```

---

## Verification (полный проход)

- [ ] `cd backend && npx jest agent-gate --silent` → все тесты зелёные.
- [ ] Миграции создали `agent_settings` + `agent_number_rules` (Task 2 Step 2).
- [ ] Integration smoke сервиса прошёл (Task 3 Step 2): `89200255591` → `79200255591`, allow/deny верны.
- [ ] API отвечает корректно (Task 4 Step 3), доступ только owner/admin (specialist → 403).
- [ ] Вебхук пропускает только whitelisted-номер (Task 5 Step 3, лог `agent gate: skip ... (not-whitelisted)`).
- [ ] UI: включение/режим/списки сохраняются и переживают переоткрытие (Task 6 Step 4).
- [ ] Дефолтное состояние восстановлено на dev (agent enabled=false).

## Что НЕ входит в этот план (следующие планы спека)

- Ядро агента: диспетчер/дебаунсер, оркестратор, Claude-клиент, слой инструментов, состояние `agent_dialogs`/`agent_events`, конкурентность (watermark/dirty).
- YClients: `get_available_slots` (`book_times`/`book_dates`) и `create_booking` (`POST /records`).
- Эскалация на оператора и operator-UI (тумблер «бот ↔ оператор», баннер).
