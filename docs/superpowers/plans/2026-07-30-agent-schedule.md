# Расписание работы агента «Мила» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать салону окно времени (например 22:00–09:30 мск), внутри которого ИИ-агент отвечает всем клиентам, а вне окна — только номерам белого списка.

**Architecture:** Расписание — сужающий фильтр поверх существующего гейта. Чистая функция `decideGate` (`backend/services/agent-gate.js`) получает границы окна и текущее время в минутах и, если сейчас вне окна, принудительно считает режим `whitelist`. Настройки живут тремя новыми колонками в `agent_settings`. UI — блок в существующей модалке «⚙️ Агент» на странице «Чат».

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`, без ORM), Jest для юнит-тестов, ванильный JS во фронтенде.

**Спека:** `docs/superpowers/specs/2026-07-30-agent-schedule-design.md`

---

## File Structure

| Файл | Ответственность | Действие |
|------|-----------------|----------|
| `backend/services/agent-gate.js` | чистые хелперы допуска: `parseHhMm`, `isWithinWindow`, `nowMskMinutes`, `decideGate` | изменить |
| `backend/agent-gate.test.js` | юнит-тесты этих хелперов (без БД) | изменить |
| `backend/migrations.js` | три `ADD COLUMN IF NOT EXISTS` к `agent_settings` | изменить |
| `backend/services/agent-settings.js` | чтение/запись настроек, склейка с правилами номеров, вызов `decideGate` | изменить |
| `backend/routes/agent-settings.js` | HTTP-слой, маппинг ошибки валидации в 400 | изменить |
| `frontend/index.html` | разметка блока расписания в модалке агента | изменить |
| `frontend/js/pages/agent-settings.js` | заполнение/сохранение контролов, гашение секций | изменить |

Новых файлов нет: фича целиком ложится в существующие границы (чистый гейт → сервис с БД → роут → UI).

**Отличия от спеки** (сознательные, спека обновлена):
1. `nowMskMinutes` живёт в `agent-gate.js`, а не в `agent-settings.js` — так его можно тестировать Jest'ом, не подтягивая `db.js` (реквайр `db.js` в тестах открывает пул к Beget).
2. `updateSettings` при **отсутствующем** поле расписания в теле запроса сохраняет текущее значение из БД, а не сбрасывает в дефолт. Иначе старый закэшированный фронт, шлющий только `{enabled, mode}`, молча выключил бы расписание.

---

## Task 1: Хелперы времени в чистом гейте

**Files:**
- Modify: `backend/services/agent-gate.js`
- Test: `backend/agent-gate.test.js`

- [ ] **Step 1: Написать падающие тесты**

Добавить в `backend/agent-gate.test.js` **после** блока `describe('normalizePhoneKey', ...)` (то есть перед `describe('decideGate', ...)`), и дописать импорт в строке 2.

Строка 2 становится:

```js
const {
  normalizePhoneKey, decideGate, parseHhMm, isWithinWindow, nowMskMinutes,
} = require('./services/agent-gate');
```

Новые блоки:

```js
describe('parseHhMm', () => {
  test('валидное время → минуты от полуночи', () => {
    expect(parseHhMm('00:00')).toBe(0);
    expect(parseHhMm('09:30')).toBe(570);
    expect(parseHhMm('22:00')).toBe(1320);
    expect(parseHhMm('23:59')).toBe(1439);
  });
  test('пробелы по краям не мешают', () => {
    expect(parseHhMm(' 09:30 ')).toBe(570);
  });
  test('вне диапазона → null', () => {
    expect(parseHhMm('24:00')).toBe(null);
    expect(parseHhMm('09:60')).toBe(null);
  });
  test('кривой формат → null', () => {
    expect(parseHhMm('9:3')).toBe(null);
    expect(parseHhMm('0930')).toBe(null);
    expect(parseHhMm('')).toBe(null);
    expect(parseHhMm(undefined)).toBe(null);
    expect(parseHhMm(null)).toBe(null);
  });
});

describe('isWithinWindow', () => {
  test('обычное окно 09:00–18:00', () => {
    expect(isWithinWindow(540, 540, 1080)).toBe(true);    // 09:00 — начало включительно
    expect(isWithinWindow(720, 540, 1080)).toBe(true);    // 12:00
    expect(isWithinWindow(1080, 540, 1080)).toBe(false);  // 18:00 — конец исключительно
    expect(isWithinWindow(300, 540, 1080)).toBe(false);   // 05:00
  });
  test('окно через полночь 22:00–09:30', () => {
    expect(isWithinWindow(1320, 1320, 570)).toBe(true);   // 22:00 ровно
    expect(isWithinWindow(1380, 1320, 570)).toBe(true);   // 23:00
    expect(isWithinWindow(120, 1320, 570)).toBe(true);    // 02:00
    expect(isWithinWindow(569, 1320, 570)).toBe(true);    // 09:29
    expect(isWithinWindow(570, 1320, 570)).toBe(false);   // 09:30 ровно — уже вне
    expect(isWithinWindow(720, 1320, 570)).toBe(false);   // 12:00
  });
  test('start === end → окно нулевой длины, а не круглые сутки', () => {
    expect(isWithinWindow(1320, 1320, 1320)).toBe(false);
    expect(isWithinWindow(0, 1320, 1320)).toBe(false);
  });
});

describe('nowMskMinutes', () => {
  test('считает московское время независимо от TZ процесса', () => {
    // 19:07 UTC = 22:07 MSK (UTC+3 круглый год, без перехода на летнее время)
    expect(nowMskMinutes(new Date('2026-07-30T19:07:00Z'))).toBe(22 * 60 + 7);
  });
  test('переход через полночь по мск', () => {
    // 21:30 UTC 30 июля = 00:30 MSK 31 июля
    expect(nowMskMinutes(new Date('2026-07-30T21:30:00Z'))).toBe(30);
  });
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что они падают**

Run: `cd /root/loyalpro/backend && npx jest agent-gate`
Expected: FAIL — `TypeError: parseHhMm is not a function` (и то же для `isWithinWindow`, `nowMskMinutes`).

- [ ] **Step 3: Реализовать хелперы**

В `backend/services/agent-gate.js` вставить **после** функции `normalizePhoneKey` (перед комментарием «Решение допуска»):

```js
// 'HH:MM' → минуты от полуночи. Любой мусор → null (вызывающий решает, что делать).
function parseHhMm(raw) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Попадает ли момент в окно. Начало включительно, конец исключительно.
// start > end — окно через полночь (22:00–09:30). start === end — окно нулевой
// длины (НЕ круглые сутки: молчаливое превращение в 24/7 — опасный сюрприз).
function isWithinWindow(nowMinutes, startMin, endMin) {
  if (startMin === endMin) return false;
  if (startMin < endMin) return nowMinutes >= startMin && nowMinutes < endMin;
  return nowMinutes >= startMin || nowMinutes < endMin;
}

// Текущее московское время в минутах от полуночи. TZ задан явно: процесс сейчас
// живёт на Europe/Moscow, но опираться на это — скрытая зависимость.
function nowMskMinutes(date = new Date()) {
  const s = date.toLocaleTimeString('ru-RU', {
    timeZone: 'Europe/Moscow', hour12: false, hour: '2-digit', minute: '2-digit',
  });
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}
```

И заменить последнюю строку файла:

```js
module.exports = { normalizePhoneKey, decideGate };
```

на:

```js
module.exports = {
  normalizePhoneKey, decideGate, parseHhMm, isWithinWindow, nowMskMinutes,
};
```

- [ ] **Step 4: Запустить тесты и убедиться, что они проходят**

Run: `cd /root/loyalpro/backend && npx jest agent-gate`
Expected: PASS — все тесты зелёные (12 старых + 9 новых).

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro
git add backend/services/agent-gate.js backend/agent-gate.test.js
git commit -m "feat(agent): хелперы окна расписания (parseHhMm, isWithinWindow, nowMskMinutes)"
```

---

## Task 2: Расписание в решении гейта

**Files:**
- Modify: `backend/services/agent-gate.js` (функция `decideGate`)
- Test: `backend/agent-gate.test.js`

- [ ] **Step 1: Написать падающие тесты**

Добавить в `backend/agent-gate.test.js` новый блок в самый конец файла:

```js
describe('decideGate + расписание', () => {
  // Окно 22:00–09:30 мск. 23:00 = 1380 внутри, 12:00 = 720 вне.
  const sched = {
    enabled: true, mode: 'all', allow: [], block: [], phone: '79200255591',
    scheduleEnabled: true, scheduleStart: '22:00', scheduleEnd: '09:30',
  };

  test('внутри окна режим «Всем» пропускает незнакомый номер', () => {
    expect(decideGate({ ...sched, nowMinutes: 1380 }))
      .toEqual({ allow: true, reason: 'ok' });
  });
  test('вне окна незнакомый номер отсекается с reason outside-schedule', () => {
    expect(decideGate({ ...sched, nowMinutes: 720 }))
      .toEqual({ allow: false, reason: 'outside-schedule' });
  });
  test('вне окна номер из белого списка проходит (тестовые номера круглосуточно)', () => {
    expect(decideGate({ ...sched, nowMinutes: 720, allow: ['79200255591'] }))
      .toEqual({ allow: true, reason: 'ok' });
  });
  test('вне окна белый список нормализуется (8→7)', () => {
    expect(decideGate({ ...sched, nowMinutes: 720, allow: ['79200255591'], phone: '89200255591' }))
      .toEqual({ allow: true, reason: 'ok' });
  });
  test('чёрный список сильнее расписания (внутри окна)', () => {
    expect(decideGate({ ...sched, nowMinutes: 1380, block: ['79200255591'] }))
      .toEqual({ allow: false, reason: 'blacklisted' });
  });
  test('выключенный агент сильнее расписания', () => {
    expect(decideGate({ ...sched, enabled: false, nowMinutes: 1380 }))
      .toEqual({ allow: false, reason: 'disabled' });
  });
  test('scheduleEnabled=false → расписание не влияет, вне окна отвечаем всем', () => {
    expect(decideGate({ ...sched, scheduleEnabled: false, nowMinutes: 720 }))
      .toEqual({ allow: true, reason: 'ok' });
  });
  test('битый формат времени → расписание игнорируется (не молчание на сутки)', () => {
    expect(decideGate({ ...sched, scheduleStart: '', nowMinutes: 720 }))
      .toEqual({ allow: true, reason: 'ok' });
    expect(decideGate({ ...sched, scheduleEnd: '9:3', nowMinutes: 720 }))
      .toEqual({ allow: true, reason: 'ok' });
  });
  test('нет nowMinutes → расписание игнорируется', () => {
    expect(decideGate({ ...sched })).toEqual({ allow: true, reason: 'ok' });
  });
  test('режим whitelist: расписание ничего не меняет, reason остаётся not-whitelisted', () => {
    expect(decideGate({ ...sched, mode: 'whitelist', nowMinutes: 720 }))
      .toEqual({ allow: false, reason: 'not-whitelisted' });
    expect(decideGate({ ...sched, mode: 'whitelist', nowMinutes: 1380 }))
      .toEqual({ allow: false, reason: 'not-whitelisted' });
  });
  test('вне окна пустой номер (Telegram chat_id) → deny', () => {
    expect(decideGate({ ...sched, nowMinutes: 720, allow: ['79200255591'], phone: '' }))
      .toEqual({ allow: false, reason: 'outside-schedule' });
  });
});
```

- [ ] **Step 2: Запустить тесты и убедиться, что они падают**

Run: `cd /root/loyalpro/backend && npx jest agent-gate`
Expected: FAIL — тесты «вне окна… outside-schedule» получают `{ allow: true, reason: 'ok' }`, потому что `decideGate` ещё не знает про расписание.

- [ ] **Step 3: Реализовать ветку расписания**

В `backend/services/agent-gate.js` заменить блок комментария и функцию `decideGate` целиком на:

```js
// Решение допуска. Чистая функция. Порядок: enabled → чёрный список →
// расписание (сужает режим до whitelist вне окна) → режим/белый список.
// @param {boolean} enabled
// @param {'all'|'whitelist'} mode
// @param {string[]} allow  нормализованные номера белого списка
// @param {string[]} block  нормализованные номера чёрного списка
// @param {string}   phone  сырой номер входящего (нормализуем внутри)
// @param {boolean}  scheduleEnabled  учитывать окно расписания
// @param {string}   scheduleStart    'HH:MM' мск, включительно
// @param {string}   scheduleEnd      'HH:MM' мск, исключительно
// @param {number}   nowMinutes       текущее мск-время в минутах (см. nowMskMinutes)
// @returns {{allow: boolean, reason: string}}
function decideGate({
  enabled, mode, allow, block, phone,
  scheduleEnabled, scheduleStart, scheduleEnd, nowMinutes,
}) {
  if (!enabled) return { allow: false, reason: 'disabled' };
  const key = normalizePhoneKey(phone);
  if (key && (block || []).includes(key)) return { allow: false, reason: 'blacklisted' };

  // Расписание ТОЛЬКО сужает: вне окна эффективный режим — whitelist, чтобы
  // тестовые номера работали круглосуточно. При mode='whitelist' сужать нечего.
  // Битые границы или отсутствие времени → расписание игнорируем (fail-open к
  // текущему поведению: круглосуточное молчание выглядит как «бот сломался»).
  const startMin = parseHhMm(scheduleStart);
  const endMin = parseHhMm(scheduleEnd);
  const narrowed = !!scheduleEnabled && mode !== 'whitelist'
    && startMin !== null && endMin !== null && typeof nowMinutes === 'number'
    && !isWithinWindow(nowMinutes, startMin, endMin);

  if (narrowed || mode === 'whitelist') {
    if (!key || !(allow || []).includes(key)) {
      return { allow: false, reason: narrowed ? 'outside-schedule' : 'not-whitelisted' };
    }
  }
  return { allow: true, reason: 'ok' };
}
```

- [ ] **Step 4: Запустить тесты и убедиться, что они проходят**

Run: `cd /root/loyalpro/backend && npx jest agent-gate`
Expected: PASS — 32 теста (12 исходных + 9 из Task 1 + 11 новых). Старые кейсы `decideGate` должны пройти без правок: новые параметры опциональны.

- [ ] **Step 5: Прогнать соседние наборы тестов агента**

Run: `cd /root/loyalpro/backend && npx jest agent`
Expected: PASS во всех agent-наборах (включая `agent-dispatcher.test.js`). Регрессов быть не должно — сигнатура `isAllowed` не менялась.

- [ ] **Step 6: Коммит**

```bash
cd /root/loyalpro
git add backend/services/agent-gate.js backend/agent-gate.test.js
git commit -m "feat(agent): расписание сужает допуск до белого списка вне окна"
```

---

## Task 3: Колонки расписания в agent_settings

**Files:**
- Modify: `backend/migrations.js:1008-1012` (после ALTER для `service_mode`)

- [ ] **Step 1: Добавить миграцию**

В `backend/migrations.js` сразу **после** блока `service_mode` (заканчивается на строке 1012 `).catch(() => {});`) вставить:

```js
  // Расписание работы агента: окно «отвечаем всем» в мск. Вне окна режим
  // принудительно сужается до whitelist — см. services/agent-gate.decideGate.
  // Время строкой 'HH:MM': не зависит от того, как pg отдаёт TIME в JS,
  // и читается глазами в БД.
  await client.query(`
    ALTER TABLE agent_settings
      ADD COLUMN IF NOT EXISTS schedule_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS schedule_start VARCHAR(5) NOT NULL DEFAULT '22:00',
      ADD COLUMN IF NOT EXISTS schedule_end VARCHAR(5) NOT NULL DEFAULT '09:30'
  `).catch(() => {});
```

- [ ] **Step 2: Применить миграцию перезапуском дев-сервера**

Run: `pm2 restart loyalpro && sleep 3 && pm2 logs loyalpro --lines 30 --nostream`
Expected: сервер поднялся без ошибок миграций.

- [ ] **Step 3: Проверить схему в БД**

Через MCP PostgreSQL (`mcp__postgres__query`, не `psql`):

```sql
SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name = 'agent_settings'
 ORDER BY ordinal_position;
```

Expected: в выдаче есть `schedule_enabled` (boolean, default false), `schedule_start` (character varying, default `'22:00'::character varying`), `schedule_end` (default `'09:30'`).

- [ ] **Step 4: Коммит**

```bash
cd /root/loyalpro
git add backend/migrations.js
git commit -m "feat(agent): колонки расписания в agent_settings"
```

---

## Task 4: Настройки расписания в сервисе

**Files:**
- Modify: `backend/services/agent-settings.js:11-30` (DEFAULTS, `getSettings`, `updateSettings`) и `:60-70` (`isAllowed`)

- [ ] **Step 1: Расширить DEFAULTS и импорт гейта**

Заменить строку 9:

```js
const { normalizePhoneKey, decideGate } = require('./agent-gate');
```

на:

```js
const { normalizePhoneKey, decideGate, parseHhMm, nowMskMinutes } = require('./agent-gate');
```

Заменить строку 11:

```js
const DEFAULTS = { enabled: false, mode: 'all' };
```

на:

```js
const DEFAULTS = {
  enabled: false, mode: 'all',
  scheduleEnabled: false, scheduleStart: '22:00', scheduleEnd: '09:30',
};

// Строка БД → camelCase-настройки для API и гейта.
function rowToSettings(row) {
  return {
    enabled: !!row.enabled,
    mode: row.mode === 'whitelist' ? 'whitelist' : 'all',
    scheduleEnabled: !!row.schedule_enabled,
    scheduleStart: row.schedule_start || DEFAULTS.scheduleStart,
    scheduleEnd: row.schedule_end || DEFAULTS.scheduleEnd,
  };
}

// Валидация времени из тела запроса. undefined → оставить текущее значение.
function pickTime(raw, current) {
  if (raw === undefined) return current;
  if (parseHhMm(raw) === null) { const e = new Error('bad time'); e.code = 'BAD_TIME'; throw e; }
  return String(raw).trim();
}
```

- [ ] **Step 2: Переписать getSettings и updateSettings**

Заменить функции `getSettings` и `updateSettings` (строки 13–30) целиком на:

```js
async function getSettings(salonId) {
  if (!salonId) return { ...DEFAULTS };
  const row = await db.oneOrNone(
    `SELECT enabled, mode, schedule_enabled, schedule_start, schedule_end
       FROM agent_settings WHERE salon_id=$1`, [salonId]
  );
  return row ? rowToSettings(row) : { ...DEFAULTS };
}

// Поля расписания, не переданные в теле, сохраняют текущее значение — иначе
// старый закэшированный фронт (шлёт только enabled+mode) молча сбросил бы окно.
async function updateSettings(salonId, body) {
  const { enabled, mode, scheduleEnabled, scheduleStart, scheduleEnd } = body || {};
  const cur = await getSettings(salonId);
  const m = mode === 'whitelist' ? 'whitelist' : 'all';
  const schedOn = scheduleEnabled === undefined ? cur.scheduleEnabled : !!scheduleEnabled;
  const start = pickTime(scheduleStart, cur.scheduleStart);
  const end = pickTime(scheduleEnd, cur.scheduleEnd);
  const row = await db.one(
    `INSERT INTO agent_settings
       (salon_id, enabled, mode, schedule_enabled, schedule_start, schedule_end, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (salon_id) DO UPDATE SET
       enabled=$2, mode=$3, schedule_enabled=$4,
       schedule_start=$5, schedule_end=$6, updated_at=NOW()
     RETURNING enabled, mode, schedule_enabled, schedule_start, schedule_end`,
    [salonId, !!enabled, m, schedOn, start, end]
  );
  return rowToSettings(row);
}
```

- [ ] **Step 3: Прокинуть расписание в гейт**

Заменить тело `isAllowed` (строки 60–70) на:

```js
async function isAllowed(salonId, phone) {
  // Fail-closed без салона: не даём авто-ответ на неопознанный инстанс,
  // независимо от DEFAULTS (нет salon_id → нет контекста списков).
  if (!salonId) return { allow: false, reason: 'no-salon' };
  const settings = await getSettings(salonId);
  if (!settings.enabled) return { allow: false, reason: 'disabled' };
  const rules = await listNumberRules(salonId, null);
  const allow = rules.filter(r => r.rule_type === 'allow').map(r => r.phone);
  const block = rules.filter(r => r.rule_type === 'block').map(r => r.phone);
  return decideGate({
    enabled: true, mode: settings.mode, allow, block, phone,
    scheduleEnabled: settings.scheduleEnabled,
    scheduleStart: settings.scheduleStart,
    scheduleEnd: settings.scheduleEnd,
    nowMinutes: nowMskMinutes(),
  });
}
```

- [ ] **Step 4: Убедиться, что модуль грузится и тесты агента зелёные**

Run: `cd /root/loyalpro/backend && node -e "require('./services/agent-settings'); console.log('ok')" && npx jest agent`
Expected: `ok`, затем все agent-наборы PASS.

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro
git add backend/services/agent-settings.js
git commit -m "feat(agent): чтение/запись расписания и прокидывание окна в гейт"
```

---

## Task 5: API-слой

**Files:**
- Modify: `backend/routes/agent-settings.js:20-26` (`PUT /settings`)

- [ ] **Step 1: Прокинуть поля и вернуть 400 на кривом времени**

Заменить хендлер `PUT /settings` (строки 20–26) на:

```js
// PUT /api/agent/settings { enabled, mode, scheduleEnabled, scheduleStart, scheduleEnd }
router.put('/settings', adminOnly, async (req, res) => {
  try {
    res.json(await settings.updateSettings(req.user.salonId, req.body || {}));
  } catch (e) {
    if (e.code === 'BAD_TIME')
      return res.status(400).json({ error: 'Некорректное время расписания' });
    logger.error(e.message); res.status(500).json({ error: 'server error' });
  }
});
```

Комментарий над `GET /settings` (строка 14) заменить на:

```js
// GET /api/agent/settings → { enabled, mode, scheduleEnabled, scheduleStart, scheduleEnd }
```

- [ ] **Step 2: Перезапустить дев и проверить круг чтения-записи**

```bash
pm2 restart loyalpro && sleep 3
```

Получить токен owner'а и проверить (подставить реальные логин/пароль дев-стенда):

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"<owner>","password":"<pass>"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

curl -s http://localhost:3001/api/agent/settings -H "Authorization: Bearer $TOKEN"
```

Expected: JSON с `scheduleEnabled:false`, `scheduleStart:"22:00"`, `scheduleEnd:"09:30"`.

- [ ] **Step 3: Проверить валидацию и сохранение**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X PUT http://localhost:3001/api/agent/settings \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"enabled":true,"mode":"all","scheduleEnabled":true,"scheduleStart":"9:3","scheduleEnd":"09:30"}'

curl -s -X PUT http://localhost:3001/api/agent/settings \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"enabled":true,"mode":"all","scheduleEnabled":true,"scheduleStart":"22:00","scheduleEnd":"09:30"}'
```

Expected: первый запрос → `400`; второй → JSON с `scheduleEnabled:true`, `scheduleStart:"22:00"`, `scheduleEnd:"09:30"`.

- [ ] **Step 4: Проверить, что неполное тело не сбрасывает окно**

```bash
curl -s -X PUT http://localhost:3001/api/agent/settings \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"enabled":true,"mode":"all"}'
```

Expected: в ответе `scheduleEnabled:true`, `scheduleStart:"22:00"`, `scheduleEnd:"09:30"` — значения сохранились.

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro
git add backend/routes/agent-settings.js
git commit -m "feat(agent): API настроек расписания + 400 на кривом времени"
```

---

## Task 6: UI в модалке «⚙️ Агент»

**Files:**
- Modify: `frontend/index.html:1181-1193` (модалка `agent-settings-modal`)
- Modify: `frontend/js/pages/agent-settings.js`

- [ ] **Step 1: Добавить разметку блока расписания**

В `frontend/index.html` вставить новую секцию **между** блоком режима (заканчивается на строке 1185 `</div>`) и секцией `agent-allow-section` (начинается на строке 1186):

```html
          <div class="stg-section active">
            <label class="fl"><input type="checkbox" id="agent-schedule-enabled" onchange="agentToggleSchedule()"> Работать по расписанию</label>
            <div id="agent-schedule-fields" style="display:flex;gap:8px;align-items:center;margin-top:6px">
              <span>с</span><input type="time" id="agent-schedule-start" style="width:120px">
              <span>до</span><input type="time" id="agent-schedule-end" style="width:120px">
            </div>
            <div class="fl" style="opacity:.7;margin-top:4px">Внутри окна отвечает по выбранному режиму, вне окна — только номерам из белого списка. Время московское.</div>
          </div>
```

- [ ] **Step 2: Заполнять контролы при открытии модалки**

В `frontend/js/pages/agent-settings.js` заменить функцию `openAgentSettings` (строки 8–22) на:

```js
async function openAgentSettings() {
  document.getElementById('agent-settings-modal').classList.add('open');
  try {
    const s = await api('GET', '/api/agent/settings');
    document.getElementById('agent-enabled').checked = !!s.enabled;
    document.querySelectorAll('input[name="agent-mode"]').forEach(r => {
      r.checked = r.value === (s.mode || 'all');
    });
    document.getElementById('agent-schedule-enabled').checked = !!s.scheduleEnabled;
    document.getElementById('agent-schedule-start').value = s.scheduleStart || '22:00';
    document.getElementById('agent-schedule-end').value = s.scheduleEnd || '09:30';
    agentToggleSchedule();
    document.querySelectorAll('input[name="agent-mode"]').forEach(r => {
      r.onchange = _agentToggleAllowSection;
    });
    await loadAgentRules();
  } catch (e) { console.error('agent settings:', e); notify('Ошибка загрузки настроек', 'err'); }
}
```

(`agentToggleSchedule` сама зовёт `_agentToggleAllowSection`, поэтому отдельного вызова больше не нужно.)

- [ ] **Step 3: Гасить секции по состоянию**

Заменить функцию `_agentToggleAllowSection` (строки 33–40) на:

```js
function _agentToggleAllowSection() {
  // Белый список значим в режиме whitelist, а также при включённом расписании:
  // вне окна гейт сам сужает режим до whitelist (services/agent-gate.decideGate).
  const scheduleOn = document.getElementById('agent-schedule-enabled').checked;
  const active = _agentMode() === 'whitelist' || scheduleOn;
  const sec = document.getElementById('agent-allow-section');
  sec.style.opacity = active ? '1' : '0.5';
  sec.style.pointerEvents = active ? '' : 'none';
}

function agentToggleSchedule() {
  const on = document.getElementById('agent-schedule-enabled').checked;
  const box = document.getElementById('agent-schedule-fields');
  box.style.opacity = on ? '1' : '0.5';
  box.style.pointerEvents = on ? '' : 'none';
  _agentToggleAllowSection();
}
```

- [ ] **Step 4: Отправлять расписание при сохранении**

Заменить функцию `saveAgentSettings` (строки 78–87) на:

```js
async function saveAgentSettings() {
  try {
    await api('PUT', '/api/agent/settings', {
      enabled: document.getElementById('agent-enabled').checked,
      mode: _agentMode(),
      scheduleEnabled: document.getElementById('agent-schedule-enabled').checked,
      scheduleStart: document.getElementById('agent-schedule-start').value,
      scheduleEnd: document.getElementById('agent-schedule-end').value,
    });
    notify('Настройки агента сохранены');
    closeAgentSettings();
  } catch (e) { console.error(e); notify('Ошибка сохранения', 'err'); }
}
```

И добавить экспорт рядом с остальными (в конце файла, после `window.closeAgentSettings = ...`):

```js
window.agentToggleSchedule = agentToggleSchedule;
```

- [ ] **Step 5: Проверить в браузере**

Через MCP Playwright (`mcp__playwright__*`, не bash-скрипты):
1. Открыть `http://localhost:3001`, залогиниться owner'ом.
2. Перейти на страницу «Чат», нажать «⚙️ Агент».
3. Убедиться: чекбокс «Работать по расписанию» отражает сохранённое состояние, поля времени показывают `22:00` и `09:30`.
4. Снять чекбокс — поля времени гаснут; вернуть — оживают.
5. Поставить режим «Всем» при снятом расписании — секция белого списка гаснет; включить расписание — секция снова активна.
6. Сохранить, закрыть, открыть заново — значения на месте.

Expected: все шесть пунктов ведут себя как описано, в консоли браузера ошибок нет.

- [ ] **Step 6: Коммит**

```bash
cd /root/loyalpro
git add frontend/index.html frontend/js/pages/agent-settings.js
git commit -m "feat(agent): UI расписания в модалке настроек агента"
```

---

## Task 7: Сквозная проверка гейта на живом стенде

**Files:** только чтение логов и БД, изменений кода нет.

- [ ] **Step 1: Настроить окно так, чтобы «сейчас» было ВНЕ него**

В UI: агент включён, режим «Всем», расписание включено, окно — заведомо не покрывающее текущее московское время (например, если сейчас 15:00, поставить 22:00–09:30).

- [ ] **Step 2: Проверить, что незнакомый номер отсекается расписанием**

Написать боту с номера, которого нет ни в белом, ни в чёрном списке (или дёрнуть вебхук Chatpush тестовым сообщением).

Run: `pm2 logs loyalpro --lines 50 --nostream | grep "gate skip"`
Expected: строка `gate skip ... (outside-schedule)`, ответа клиенту нет.

- [ ] **Step 3: Проверить, что тестовый номер проходит вне окна**

Добавить свой тестовый номер (`79200255591`) в белый список, написать с него.

Expected: Мила отвечает; в логах нет `gate skip` для этого диалога.

- [ ] **Step 4: Проверить работу внутри окна**

Поставить окно, покрывающее текущее время (например `00:00`–`23:59`), написать с номера не из белого списка.

Expected: Мила отвечает — режим «Всем» действует внутри окна.

- [ ] **Step 5: Вернуть боевую настройку**

Выставить целевое окно `22:00`–`09:30`, режим «Всем», расписание включено, тестовые номера — в белом списке.

Проверить в БД через MCP PostgreSQL:

```sql
SELECT salon_id, enabled, mode, schedule_enabled, schedule_start, schedule_end
  FROM agent_settings;
```

Expected: `enabled=true`, `mode='all'`, `schedule_enabled=true`, `schedule_start='22:00'`, `schedule_end='09:30'`.

- [ ] **Step 6: Финальный прогон тестов**

Run: `cd /root/loyalpro/backend && npx jest`
Expected: все наборы PASS.

- [ ] **Step 7: Обновить документацию**

В `CLAUDE.md`, в разделе «AI-агент: управление и гейт допуска», после строки про `services/agent-gate.js` добавить пункт:

```markdown
- Расписание: `agent_settings.schedule_enabled/schedule_start/schedule_end` ('HH:MM', мск). Окно **только сужает** допуск — вне окна режим принудительно `whitelist` (reason `outside-schedule`), внутри действует выбранный режим. Окно через полночь поддержано (`start > end`), начало включительно, конец исключительно; битые границы → расписание игнорируется (fail-open). Отсечка жёсткая по часам: диалог, начатый в окне, после его конца бот не продолжает.
```

```bash
cd /root/loyalpro
git add CLAUDE.md
git commit -m "docs: расписание работы агента в CLAUDE.md"
```

---

## Проверка плана против спеки

| Требование спеки | Задача |
|---|---|
| Колонки `schedule_enabled/start/end` в `agent_settings` | Task 3 |
| `parseHhMm`, `isWithinWindow`, окно через полночь, границы | Task 1 |
| `start === end` → окно нулевой длины | Task 1 (тест + код) |
| Расписание сужает до whitelist; reason `outside-schedule` | Task 2 |
| Чёрный список выше расписания; `enabled=false` выше всего | Task 2 |
| Fail-open при битых границах | Task 2 |
| Московское время через явный `timeZone` | Task 1 (`nowMskMinutes`) |
| `getSettings`/`updateSettings`/`isAllowed` | Task 4 |
| API + 400 на кривом `HH:MM` | Task 5 |
| UI: чекбокс, два `input[type=time]`, подпись | Task 6 |
| `_agentToggleAllowSection` учитывает расписание | Task 6 |
| Жёсткая отсечка по часам (без грейса) | по построению: гейт вызывается на каждое входящее, состояние диалога не читается — новых механизмов не нужно |
| Тесты гейта | Task 1, Task 2 |
