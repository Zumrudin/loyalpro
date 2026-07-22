# Слой фильтрации услуг ИИ-агента — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать салону второй слой контроля над тем, какие услуги и пары услуга×мастер ИИ-агент предлагает и бронирует, поверх сырых данных YClients.

**Architecture:** Правила видимости хранятся в БД (`agent_service_rules` + режим `service_mode` в `agent_settings`). Чистый модуль `service-filter.js` решает видимость. Загрузчик `loadServiceFilterSafe` (fail-open) применяется внутри инструментов агента `list_services`, `get_available_slots` и гардом в `create_booking`. Отдельный экран админки управляет правилами. Статья «кто что делает» пишется вручную в существующей базе знаний.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg` через `db`), ванильный JS фронт, node:test / встроенные тесты (`node <file>.test.js`), YClients REST.

**Спека:** `docs/superpowers/specs/2026-07-19-agent-service-filter-design.md`

---

## Структура файлов

- Создать: `backend/services/agent/service-filter.js` — чистая логика видимости.
- Создать: `backend/services/agent/service-filter.test.js` — юнит-тесты чистой логики.
- Изменить: `backend/migrations.js` — колонка `service_mode` + таблица `agent_service_rules`.
- Изменить: `backend/services/agent-settings.js` — режим услуг, CRUD правил, `loadServiceFilterSafe`, `getServicesForAdmin`.
- Изменить: `backend/services/agent/tools/list-services.js` — применить фильтр.
- Изменить: `backend/services/agent/tools/get-available-slots.js` — гард по услуге/паре.
- Изменить: `backend/services/agent/tools/create-booking.js` — гард перед бронированием.
- Изменить: `backend/routes/agent-settings.js` — API экрана (`/service-settings`, `/services`, `/service-rules`).
- Изменить: `backend/agent-tools.test.js` — тесты фильтрации `list_services` и гарда брони.
- Создать: `frontend/js/pages/agent-services.js` — экран «Услуги агента».
- Изменить: `frontend/index.html` + навигация — регистрация страницы (по образцу существующих страниц).
- Создать: `docs/agent-kb-who-does-what-template.md` — шаблон статьи «кто что делает».

> Примечание: `get_available_dates` НЕ трогаем — он принимает только `staff_yc_id` (график мастера), измерения услуги там нет, фильтровать нечего. Это осознанное уточнение спеки (в спеке он упомянут, но по факту гард — no-op).

---

## Task 1: Миграции БД

**Files:**
- Modify: `backend/migrations.js` (рядом с блоком `agent_number_rules`, около строки 984-995)

- [ ] **Step 1: Добавить колонку `service_mode` и таблицу правил**

В `migrations.js`, сразу после блока создания `agent_number_rules`, добавить:

```js
  // service_mode — режим фильтра услуг агента (независим от mode для номеров).
  await client.query(`
    ALTER TABLE agent_settings
      ADD COLUMN IF NOT EXISTS service_mode VARCHAR(20) NOT NULL DEFAULT 'all'
  `).catch(() => {});

  // agent_service_rules — правила видимости услуг/пар услуга×мастер для агента.
  // yc_staff_id NULL = правило на услугу целиком; заполнен = пара услуга×мастер.
  // rule_type: 'deny' | 'allow'. Пары поддерживают только 'deny' (см. спеку).
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_service_rules (
      id            SERIAL PRIMARY KEY,
      salon_id      INTEGER REFERENCES salons(id) ON DELETE CASCADE,
      yc_service_id BIGINT NOT NULL,
      yc_staff_id   BIGINT NULL,
      rule_type     VARCHAR(10) NOT NULL,
      note          TEXT,
      created_at    TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_service_rules_uniq
      ON agent_service_rules (salon_id, yc_service_id, COALESCE(yc_staff_id, 0), rule_type)
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS agent_service_rules_salon_idx
      ON agent_service_rules (salon_id)
  `).catch(() => {});
```

- [ ] **Step 2: Запустить сервер (dev) и убедиться, что миграции прошли без ошибок**

Run: `cd backend && node -e "require('./migrations').runMigrations ? 0 : 0" ` — если экспорт называется иначе, запустить `npm run dev` и посмотреть логи старта.
Expected: старт без ошибок, в логах нет `agent_service_rules` exceptions.

- [ ] **Step 3: Проверить схему через MCP postgres**

Через `mcp__postgres__query`:
```sql
SELECT column_name FROM information_schema.columns
 WHERE table_name='agent_settings' AND column_name='service_mode';
SELECT to_regclass('agent_service_rules');
```
Expected: одна строка `service_mode`; `agent_service_rules` не NULL.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations.js
git commit -m "feat(agent): миграции — service_mode + agent_service_rules"
```

---

## Task 2: Чистый модуль фильтра `service-filter.js` (TDD)

**Files:**
- Create: `backend/services/agent/service-filter.js`
- Test: `backend/services/agent/service-filter.test.js`

- [ ] **Step 1: Написать падающий тест**

`backend/services/agent/service-filter.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const f = require('./service-filter');

const mk = (o = {}) => ({
  mode: o.mode || 'all',
  denyServices: new Set(o.denyServices || []),
  allowServices: new Set(o.allowServices || []),
  denyPairs: new Set(o.denyPairs || []),
});

test('all-режим: услуга видна, если нет deny', () => {
  assert.equal(f.decideServiceVisible(mk(), 10), true);
  assert.equal(f.decideServiceVisible(mk({ denyServices: ['10'] }), 10), false);
});

test('allowlist-режим: услуга видна только если есть allow', () => {
  assert.equal(f.decideServiceVisible(mk({ mode: 'allowlist' }), 10), false);
  assert.equal(f.decideServiceVisible(mk({ mode: 'allowlist', allowServices: ['10'] }), 10), true);
});

test('id нормализуются к строке (number и string эквивалентны)', () => {
  assert.equal(f.decideServiceVisible(mk({ denyServices: ['10'] }), '10'), false);
});

test('filterServiceStaff убирает deny-пары', () => {
  const filter = mk({ denyPairs: ['10:5'] });
  assert.deepEqual(f.filterServiceStaff(filter, 10, [5, 6, 7]), [6, 7]);
});

test('isBookable: false при скрытой услуге ИЛИ скрытой паре', () => {
  assert.equal(f.isBookable(mk(), 10, 5), true);
  assert.equal(f.isBookable(mk({ denyServices: ['10'] }), 10, 5), false);
  assert.equal(f.isBookable(mk({ denyPairs: ['10:5'] }), 10, 5), false);
  assert.equal(f.isBookable(mk({ mode: 'allowlist', allowServices: ['10'] }), 10, 5), true);
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd backend && node services/agent/service-filter.test.js`
Expected: FAIL — `Cannot find module './service-filter'`.

- [ ] **Step 3: Реализовать модуль**

`backend/services/agent/service-filter.js`:
```js
'use strict';
// ============================================================
// Чистая логика видимости услуг агента. Без БД/HTTP — юнит-тестируемо.
// Данные готовит services/agent-settings.loadServiceFilter(Safe).
//   filter = { mode:'all'|'allowlist', denyServices:Set, allowServices:Set, denyPairs:Set }
//   denyServices/allowServices — Set строковых yc_service_id
//   denyPairs — Set ключей `${serviceId}:${staffId}` (строки)
// ============================================================

const pairKey = (serviceId, staffId) => `${String(serviceId)}:${String(staffId)}`;

// Видна ли услуга целиком с учётом режима.
function decideServiceVisible(filter, ycServiceId) {
  const id = String(ycServiceId);
  if (filter.mode === 'allowlist') return filter.allowServices.has(id);
  return !filter.denyServices.has(id);
}

// Убрать из списка id мастеров те пары услуга×мастер, что помечены deny.
function filterServiceStaff(filter, ycServiceId, staffIds) {
  return (staffIds || []).filter(sid => !filter.denyPairs.has(pairKey(ycServiceId, sid)));
}

// Можно ли предлагать/бронировать конкретную пару услуга×мастер.
function isBookable(filter, ycServiceId, ycStaffId) {
  if (!decideServiceVisible(filter, ycServiceId)) return false;
  return !filter.denyPairs.has(pairKey(ycServiceId, ycStaffId));
}

module.exports = { pairKey, decideServiceVisible, filterServiceStaff, isBookable };
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `cd backend && node services/agent/service-filter.test.js`
Expected: PASS (все тесты).

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/service-filter.js backend/services/agent/service-filter.test.js
git commit -m "feat(agent): чистый модуль service-filter + юнит-тесты"
```

---

## Task 3: Сервис-слой — режим, CRUD правил, загрузчики

**Files:**
- Modify: `backend/services/agent-settings.js`

- [ ] **Step 1: Добавить функции в `agent-settings.js`**

Перед `module.exports`, добавить:
```js
// ── Фильтр услуг агента ─────────────────────────────────────
async function getServiceMode(salonId) {
  if (!salonId) return 'all';
  const row = await db.oneOrNone(
    'SELECT service_mode FROM agent_settings WHERE salon_id=$1', [salonId]);
  return (row && row.service_mode === 'allowlist') ? 'allowlist' : 'all';
}

async function updateServiceMode(salonId, mode) {
  const m = mode === 'allowlist' ? 'allowlist' : 'all';
  const row = await db.one(
    `INSERT INTO agent_settings (salon_id, service_mode, updated_at)
     VALUES ($1,$2,NOW())
     ON CONFLICT (salon_id) DO UPDATE SET service_mode=$2, updated_at=NOW()
     RETURNING service_mode`,
    [salonId, m]);
  return { serviceMode: row.service_mode };
}

async function listServiceRules(salonId) {
  return db.any(
    `SELECT id, yc_service_id, yc_staff_id, rule_type, note, created_at
       FROM agent_service_rules WHERE salon_id=$1 ORDER BY created_at DESC`,
    [salonId]);
}

async function addServiceRule(salonId, { ycServiceId, ycStaffId, ruleType, note }) {
  const svc = parseInt(ycServiceId, 10);
  if (!svc) { const e = new Error('bad service'); e.code = 'BAD_SERVICE'; throw e; }
  const staff = (ycStaffId === undefined || ycStaffId === null || ycStaffId === '')
    ? null : parseInt(ycStaffId, 10);
  // Пары поддерживают только deny (см. спеку); услуга целиком — allow|deny.
  let type = ruleType === 'allow' ? 'allow' : 'deny';
  if (staff !== null) type = 'deny';
  return db.one(
    `INSERT INTO agent_service_rules (salon_id, yc_service_id, yc_staff_id, rule_type, note)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (salon_id, yc_service_id, COALESCE(yc_staff_id,0), rule_type)
       DO UPDATE SET note=EXCLUDED.note
     RETURNING id, yc_service_id, yc_staff_id, rule_type, note, created_at`,
    [salonId, svc, staff, type, note || null]);
}

async function removeServiceRule(salonId, id) {
  await db.query('DELETE FROM agent_service_rules WHERE salon_id=$1 AND id=$2', [salonId, id]);
}

// Загрузчик правил → структуры для service-filter. Кидает при сбое БД.
async function loadServiceFilter(salonId) {
  const mode = await getServiceMode(salonId);
  const rows = await db.any(
    `SELECT yc_service_id, yc_staff_id, rule_type FROM agent_service_rules WHERE salon_id=$1`,
    [salonId]);
  const denyServices = new Set(), allowServices = new Set(), denyPairs = new Set();
  for (const r of rows) {
    const sid = String(r.yc_service_id);
    if (r.yc_staff_id === null || r.yc_staff_id === undefined) {
      if (r.rule_type === 'deny') denyServices.add(sid);
      else allowServices.add(sid);
    } else if (r.rule_type === 'deny') {
      denyPairs.add(`${sid}:${String(r.yc_staff_id)}`);
    }
  }
  return { mode, denyServices, allowServices, denyPairs };
}

// Fail-open обёртка: при любом сбое БД → пустой пермиссивный фильтр (mode 'all',
// пустые множества → видно всё). Транзиентный сбой не должен ломать агента.
async function loadServiceFilterSafe(salonId) {
  try { return await loadServiceFilter(salonId); }
  catch (e) {
    return { mode: 'all', denyServices: new Set(), allowServices: new Set(), denyPairs: new Set() };
  }
}
```

- [ ] **Step 2: Расширить `module.exports`**

Заменить строку экспорта на:
```js
module.exports = {
  getSettings, updateSettings, listNumberRules, addNumberRule, removeNumberRule, isAllowed,
  getServiceMode, updateServiceMode, listServiceRules, addServiceRule, removeServiceRule,
  loadServiceFilter, loadServiceFilterSafe,
};
```

- [ ] **Step 3: Smoke-проверка загрузки модуля**

Run: `cd backend && node -e "const s=require('./services/agent-settings'); console.log(typeof s.loadServiceFilterSafe, typeof s.addServiceRule)"`
Expected: `function function`.

- [ ] **Step 4: Commit**

```bash
git add backend/services/agent-settings.js
git commit -m "feat(agent): сервис-слой фильтра услуг (режим, CRUD правил, загрузчики)"
```

---

## Task 4: Применить фильтр в `list_services` (TDD через agent-tools.test.js)

**Files:**
- Modify: `backend/services/agent/tools/list-services.js`
- Test: `backend/agent-tools.test.js`

- [ ] **Step 1: Добавить падающий тест в `agent-tools.test.js`**

Проверить в начале файла, как замоканы `db` и `ycGet` (следовать существующему стилю мока). Добавить тест, который: мокает `ycGet` двумя услугами (id 10 активна, id 20 активна), мокает `agent-settings.loadServiceFilterSafe` вернуть `{ mode:'all', denyServices:new Set(['20']), allowServices:new Set(), denyPairs:new Set(['10:5']) }`, мокает staff-строки (мастера 5 и 6). Ожидание: в результате `list_services` услуга 20 отсутствует, у услуги 10 в `staff` нет мастера 5.

```js
// Псевдо-скелет — адаптировать под существующие моки файла:
test('list_services скрывает deny-услуги и deny-пары', async () => {
  // ycGet → [{id:10,active:1,price_max:1000,title:'A',staff:[{id:5},{id:6}]},
  //          {id:20,active:1,price_max:500,title:'B',staff:[{id:6}]}]
  // loadServiceFilterSafe → deny service 20, deny pair 10:5
  const out = await listServices.run(SALON_ID, {});
  const ids = out.services.map(s => s.yc_id);
  assert.ok(!ids.includes(20));                 // услуга целиком скрыта
  const a = out.services.find(s => s.yc_id === 10);
  assert.ok(!a.staff.includes('Мастер5'));      // пара 10:5 скрыта
  assert.ok(a.staff.includes('Мастер6'));
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `cd backend && node agent-tools.test.js`
Expected: FAIL — услуга 20 всё ещё присутствует (фильтр не применён).

- [ ] **Step 3: Внести фильтр в `list-services.js`**

Вверху файла добавить импорты:
```js
const settings = require('../../agent-settings');
const svcFilter = require('../service-filter');
```

Внутри `run`, после загрузки `staffNameById` и до `staffNamesOf`, загрузить фильтр:
```js
  const filter = await settings.loadServiceFilterSafe(salonId);
```

Заменить `staffNamesOf` так, чтобы сначала фильтровать id пар, потом маппить в имена:
```js
  const staffNamesOf = (s) => svcFilter
    .filterServiceStaff(filter, s.id, (s.staff || []).map(st => st.id))
    .map(id => staffNameById.get(String(id)))
    .filter(Boolean);
```

Отфильтровать сами услуги в ветке `active.length` — заменить `active.map(...)` на:
```js
    services = active
      .filter(s => svcFilter.decideServiceVisible(filter, s.id))
      .map(s => ({
        yc_id: s.id,
        title: s.title,
        price_min: s.price_min,
        price_max: s.price_max,
        staff: staffNamesOf(s),
      }));
```

> Фолбэк-ветка `cfg.map(...)` (нет живых данных) остаётся без фильтра — там нет мастеров и это аварийный минимум; фильтровать нечего.

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `cd backend && node agent-tools.test.js`
Expected: PASS (новый тест + существующие).

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/tools/list-services.js backend/agent-tools.test.js
git commit -m "feat(agent): list_services применяет фильтр услуг и deny-пар"
```

---

## Task 5: Гард в `create_booking` (TDD)

**Files:**
- Modify: `backend/services/agent/tools/create-booking.js`
- Test: `backend/agent-tools.test.js`

- [ ] **Step 1: Добавить падающий тест**

```js
test('create_booking отказывает при скрытой паре услуга×мастер', async () => {
  // loadServiceFilterSafe → denyPairs: new Set(['10:5'])
  const out = await createBooking.run(SALON_ID,
    { staff_yc_id: 5, service_yc_id: 10, datetime: '2026-07-20T10:00:00+03:00', client_phone: '79990000000' });
  assert.equal(out.not_bookable, true);
  // booking.createBookingRecord НЕ должен быть вызван (проверить мок)
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `cd backend && node agent-tools.test.js`
Expected: FAIL — `not_bookable` undefined, запись создаётся.

- [ ] **Step 3: Внести гард в `create-booking.js`**

Вверху добавить импорты:
```js
const settings = require('../../agent-settings');
const svcFilter = require('../service-filter');
```

В начало `run`, до вызова `booking.createBookingRecord`:
```js
  const filter = await settings.loadServiceFilterSafe(salonId);
  if (!svcFilter.isBookable(filter, input.service_yc_id, input.staff_yc_id)) {
    return {
      not_bookable: true,
      error: 'Эта услуга у выбранного мастера сейчас недоступна для записи. ' +
        'Предложи другую услугу или мастера, либо передай оператору.',
    };
  }
```

> Fail-open: при сбое БД `loadServiceFilterSafe` вернёт пермиссивный фильтр → `isBookable` true → бронь не блокируется транзиентной ошибкой.

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `cd backend && node agent-tools.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/tools/create-booking.js backend/agent-tools.test.js
git commit -m "feat(agent): create_booking гардит скрытые услуги и deny-пары"
```

---

## Task 6: Гард в `get_available_slots`

**Files:**
- Modify: `backend/services/agent/tools/get-available-slots.js`

- [ ] **Step 1: Внести гард**

Вверху добавить импорты:
```js
const settings = require('../../agent-settings');
const svcFilter = require('../service-filter');
```

В `run`, сразу после проверки `if (!staffId || !date) ...` и до запроса `salon`:
```js
  // Скрытую услугу/пару не предлагаем (мягкий пустой ответ, без «технических сложностей»).
  if (serviceId) {
    const filter = await settings.loadServiceFilterSafe(salonId);
    if (!svcFilter.isBookable(filter, serviceId, staffId)) {
      return { slots: [], filtered: true };
    }
  }
```

> Если `serviceId` не передан — это запрос свободного времени по графику (без услуги), фильтровать нечего.

- [ ] **Step 2: Ручная smoke-проверка**

Run: `cd backend && node -e "require('./services/agent/tools/get-available-slots')"` (модуль грузится без ошибок).
Expected: без исключений.

- [ ] **Step 3: Commit**

```bash
git add backend/services/agent/tools/get-available-slots.js
git commit -m "feat(agent): get_available_slots не отдаёт слоты по скрытой услуге/паре"
```

---

## Task 7: API экрана — `routes/agent-settings.js`

**Files:**
- Modify: `backend/routes/agent-settings.js`
- Modify: `backend/services/agent-settings.js` (добавить `getServicesForAdmin`)

- [ ] **Step 1: Добавить `getServicesForAdmin` в сервис-слой**

В `agent-settings.js` добавить (нужны `ycGet` и `db`; `db` уже импортирован — добавить импорт ycGet вверху: `const { ycGet } = require('./yclients');`):
```js
// Полный список услуг YClients + мастера + текущая видимость (для админки).
async function getServicesForAdmin(salonId) {
  const salon = await db.oneOrNone(
    `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
       FROM salons WHERE id=$1`, [salonId]);
  const staffRows = await db.any(
    `SELECT yclients_staff_id, name FROM staff_members
      WHERE salon_id=$1 AND is_active=true`, [salonId]);
  const staffNameById = new Map(staffRows.map(s => [String(s.yclients_staff_id), s.name]));
  let live = [];
  if (salon && salon.yclients_company_id) {
    try {
      const data = await ycGet(salon, `/services/${salon.yclients_company_id}`);
      live = Array.isArray(data) ? data : [];
    } catch (_) { live = []; }
  }
  const filter = await loadServiceFilter(salonId);   // админке нужен реальный статус, не fail-open
  return {
    serviceMode: filter.mode,
    services: live.filter(s => s.active === 1).map(s => ({
      yc_id: s.id,
      title: s.title,
      price_min: s.price_min,
      price_max: s.price_max,
      visible: (require('./agent/service-filter')).decideServiceVisible(filter, s.id),
      staff: (s.staff || []).map(st => ({
        yc_id: st.id,
        name: staffNameById.get(String(st.id)) || `#${st.id}`,
        hidden: filter.denyPairs.has(`${String(s.id)}:${String(st.id)}`),
      })),
    })),
  };
}
```
Добавить `getServicesForAdmin` в `module.exports`.

- [ ] **Step 2: Добавить роуты в `routes/agent-settings.js`**

Перед `module.exports = router;` добавить:
```js
// GET /api/agent/service-settings → { serviceMode }
router.get('/service-settings', adminOnly, async (req, res) => {
  try { res.json({ serviceMode: await settings.getServiceMode(req.user.salonId) }); }
  catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// PUT /api/agent/service-settings { serviceMode }
router.put('/service-settings', adminOnly, async (req, res) => {
  try { res.json(await settings.updateServiceMode(req.user.salonId, (req.body || {}).serviceMode)); }
  catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// GET /api/agent/services → живой список YClients + видимость
router.get('/services', adminOnly, async (req, res) => {
  try { res.json(await settings.getServicesForAdmin(req.user.salonId)); }
  catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// GET /api/agent/service-rules → { rules }
router.get('/service-rules', adminOnly, async (req, res) => {
  try { res.json({ rules: await settings.listServiceRules(req.user.salonId) }); }
  catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});

// POST /api/agent/service-rules { ycServiceId, ycStaffId?, ruleType, note }
router.post('/service-rules', adminOnly, async (req, res) => {
  try {
    const { ycServiceId, ycStaffId, ruleType, note } = req.body || {};
    res.json(await settings.addServiceRule(req.user.salonId, { ycServiceId, ycStaffId, ruleType, note }));
  } catch (e) {
    if (e.code === 'BAD_SERVICE') return res.status(400).json({ error: 'Не указана услуга' });
    logger.error(e.message); res.status(500).json({ error: 'server error' });
  }
});

// DELETE /api/agent/service-rules/:id
router.delete('/service-rules/:id', adminOnly, async (req, res) => {
  try {
    await settings.removeServiceRule(req.user.salonId, parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'server error' }); }
});
```

- [ ] **Step 3: Проверить эндпоинты (dev-сервер + токен)**

Запустить dev (`npm run dev`), получить admin-токен, дёрнуть:
```bash
curl -s -H "Authorization: Bearer $T" http://localhost:3001/api/agent/service-settings
curl -s -H "Authorization: Bearer $T" http://localhost:3001/api/agent/services | head -c 400
```
Expected: `{"serviceMode":"all"}`; `services` — массив с полями `visible`/`staff[].hidden`.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/agent-settings.js backend/services/agent-settings.js
git commit -m "feat(agent): API экрана управления фильтром услуг"
```

---

## Task 8: Фронт — экран «Услуги агента»

**Files:**
- Create: `frontend/js/pages/agent-services.js`
- Modify: `frontend/index.html` (подключить скрипт, добавить `div.page#page-agent-services`, пункт навигации) — по образцу существующих страниц (например, как подключены `pages/agent-settings.js` и другие). Роль-доступ: owner/admin.

- [ ] **Step 1: Написать модуль страницы**

`frontend/js/pages/agent-services.js`:
```js
'use strict';
// ── Экран «Услуги агента»: режим фильтра + видимость услуг/пар (owner/admin) ──
const _asEsc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let _asData = { serviceMode: 'all', services: [] };
let _asRules = [];

async function initAgentServices() {
  try {
    _asData = await api('GET', '/api/agent/services');
    const r = await api('GET', '/api/agent/service-rules');
    _asRules = r.rules || [];
    renderAgentServices();
  } catch (e) { console.error('agent-services:', e); notify('Ошибка загрузки услуг', 'err'); }
}

function _hasWholeDeny(svcId) {
  return _asRules.some(x => String(x.yc_service_id) === String(svcId)
    && x.yc_staff_id == null && x.rule_type === 'deny');
}
function _hasWholeAllow(svcId) {
  return _asRules.some(x => String(x.yc_service_id) === String(svcId)
    && x.yc_staff_id == null && x.rule_type === 'allow');
}

async function _setMode(mode) {
  try { await api('PUT', '/api/agent/service-settings', { serviceMode: mode }); await initAgentServices(); }
  catch (e) { notify('Не удалось сменить режим', 'err'); }
}

// Тумблер видимости услуги целиком: в all-режиме создаём/снимаем deny,
// в allowlist-режиме — allow.
async function _toggleService(svcId, wantVisible) {
  const mode = _asData.serviceMode;
  try {
    if (mode === 'all') {
      if (wantVisible) { await _removeRuleFor(svcId, null, 'deny'); }
      else { await api('POST', '/api/agent/service-rules', { ycServiceId: svcId, ruleType: 'deny' }); }
    } else {
      if (wantVisible) { await api('POST', '/api/agent/service-rules', { ycServiceId: svcId, ruleType: 'allow' }); }
      else { await _removeRuleFor(svcId, null, 'allow'); }
    }
    await initAgentServices();
  } catch (e) { notify('Не удалось изменить видимость', 'err'); }
}

async function _togglePair(svcId, staffId, wantHidden) {
  try {
    if (wantHidden) { await api('POST', '/api/agent/service-rules', { ycServiceId: svcId, ycStaffId: staffId, ruleType: 'deny' }); }
    else { await _removeRuleFor(svcId, staffId, 'deny'); }
    await initAgentServices();
  } catch (e) { notify('Не удалось изменить пару', 'err'); }
}

async function _removeRuleFor(svcId, staffId, ruleType) {
  const rule = _asRules.find(x => String(x.yc_service_id) === String(svcId)
    && String(x.yc_staff_id ?? '') === String(staffId ?? '')
    && x.rule_type === ruleType);
  if (rule) await api('DELETE', `/api/agent/service-rules/${rule.id}`);
}

function renderAgentServices() {
  const root = document.getElementById('agent-services-root');
  if (!root) return;
  const mode = _asData.serviceMode;
  const modeRadios = ['all', 'allowlist'].map(m =>
    `<label><input type="radio" name="as-mode" value="${m}" ${m === mode ? 'checked' : ''}> ${m === 'all' ? 'Всё, кроме скрытого' : 'Только разрешённые'}</label>`).join(' ');
  const rows = _asData.services.map(s => {
    const price = s.price_max ? `${s.price_min}–${s.price_max} ₽` : '';
    const staff = (s.staff || []).map(st =>
      `<label class="as-pair"><input type="checkbox" data-svc="${s.yc_id}" data-staff="${st.yc_id}" class="as-pair-cb" ${st.hidden ? '' : 'checked'}> ${_asEsc(st.name)}</label>`).join(' ');
    return `<div class="as-svc">
      <label class="as-svc-head"><input type="checkbox" class="as-svc-cb" data-svc="${s.yc_id}" ${s.visible ? 'checked' : ''}>
        <b>${_asEsc(s.title)}</b> <span class="muted">${price}</span></label>
      <div class="as-staff">${staff || '<span class="muted">нет мастеров</span>'}</div>
    </div>`;
  }).join('');
  root.innerHTML = `
    <div class="stg-section">
      <div class="fg"><div class="fl">Режим</div>${modeRadios}</div>
      <p class="muted">Отмеченная услуга видна агенту. Снимите галочку у мастера, чтобы скрыть ошибочную пару услуга×мастер.
        Описание «кто что делает» добавьте статьёй в Базе знаний.</p>
    </div>
    <div class="as-list">${rows || '<p class="muted">Нет активных услуг (или YClients не подключён).</p>'}</div>`;
  root.querySelectorAll('input[name="as-mode"]').forEach(r =>
    r.onchange = () => _setMode(r.value));
  root.querySelectorAll('.as-svc-cb').forEach(cb =>
    cb.onchange = () => _toggleService(cb.dataset.svc, cb.checked));
  root.querySelectorAll('.as-pair-cb').forEach(cb =>
    cb.onchange = () => _togglePair(cb.dataset.svc, cb.dataset.staff, !cb.checked));
}
```

- [ ] **Step 2: Подключить страницу в `index.html` и навигацию**

По образцу уже существующих страниц (owner/admin):
- добавить `<script src="js/pages/agent-services.js"></script>`;
- добавить контейнер страницы: `<div class="page" id="page-agent-services"><div id="agent-services-root"></div></div>`;
- добавить пункт меню, вызывающий переход на `agent-services` и `initAgentServices()` при открытии (следовать тому, как другие страницы инициализируются в роутере `app.js`).

- [ ] **Step 3: Проверить в браузере через MCP Playwright**

Залогиниться админом, открыть «Услуги агента». Проверить сценарии:
1. Снять галочку услуги → перезагрузить → услуга осталась снятой (deny записался).
2. Снять галочку мастера у услуги → перезагрузить → пара скрыта.
3. Переключить режим на «Только разрешённые» → галочки услуг отражают allow-правила.

Expected: состояние сохраняется между перезагрузками; ошибок в консоли нет.

- [ ] **Step 4: Commit**

```bash
git add frontend/js/pages/agent-services.js frontend/index.html
git commit -m "feat(agent): экран «Услуги агента» — режим и видимость услуг/пар"
```

---

## Task 9: Шаблон статьи «кто что делает» (без кода)

**Files:**
- Create: `docs/agent-kb-who-does-what-template.md`

- [ ] **Step 1: Написать шаблон**

`docs/agent-kb-who-does-what-template.md`:
```markdown
# Статья базы знаний: «Кто что делает» (шаблон)

Создайте в Базе знаний статью (категория «О мастерах» или «Услуги»),
вставьте текст ниже, отредактируйте под салон и **привяжите сущности**
(услуги/мастеров) в редакторе — тогда RAG-поиск агента будет её находить,
а живые цены подтянутся автоматически.

## Заголовок: Кто из мастеров какие услуги делает

- **<Имя мастера 1>** — <перечень услуг>. <Пара слов о специализации/опыте.>
- **<Имя мастера 2>** — <перечень услуг>. <Особенности, к кому идти с чем.>

### Нюансы записи
- <Например: сложное окрашивание — только к <имя>.>
- <Например: детская стрижка — <имена>.>

> Держите статью в согласии с экраном «Услуги агента»: если услуга/пара
> там скрыта, не упоминайте её здесь как доступную.
```

- [ ] **Step 2: Commit**

```bash
git add docs/agent-kb-who-does-what-template.md
git commit -m "docs(agent): шаблон статьи базы знаний «кто что делает»"
```

---

## Финальная проверка

- [ ] **Прогнать все затронутые тесты**

Run:
```bash
cd backend && node services/agent/service-filter.test.js && node agent-tools.test.js
```
Expected: все PASS.

- [ ] **Мини-E2E логики фильтра** (через MCP postgres + dev-сервер): создать deny-правило на услугу, убедиться, что `list_services` (через инструмент/лог агента) её не отдаёт, затем удалить правило.
```
