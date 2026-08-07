# Напоминания о повторном визите — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** После состоявшегося визита напомнить клиенту о повторной процедуре, если он не записался, начислить бонусы по настраиваемым ступеням и записать результат в журнал с отметкой конверсии.

**Architecture:** Отдельный модуль `services/reminders/*` рядом с «Заботой»: три новые таблицы, событийное планирование из вебхука YClients, собственный воркер с доставкой at-most-once. Вся содержательная логика — в чистых модулях без БД и сети; воркер и планировщик получают зависимости через DI и тестируются без сети.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg` напрямую, без ORM), Jest, ванильный JS во фронте.

**Спека:** `docs/superpowers/specs/2026-08-07-repeat-visit-reminders-design.md`

**Как гонять тесты:** из `backend/`, `npx jest <файл> --silent`. Полный прогон — `npx jest --silent --testPathIgnorePatterns primary-clients` (у `primary-clients.test.js` есть `process.exit(1)`, который убивает соседний сьют — известный флак, не регресс).

---

## Структура файлов

**Создаются (бэкенд):**

| Файл | Ответственность |
|---|---|
| `services/reminders/tiers.js` | Чистый. Подбор бонусной ступени по балансу |
| `services/reminders/template.js` | Чистый. Подстановки в текст напоминания |
| `services/reminders/eligibility.js` | Чистый. Есть ли будущая запись под условия правила |
| `services/reminders/attribution.js` | Чистый. Какая строка журнала засчитывает конверсию |
| `services/reminders/backfill.js` | Чистый. Раскладка догона по дням с капом |
| `services/messaging/daily-limit.js` | Общий анти-спам «одно сообщение в день» на обе очереди |
| `services/reminders/enroll.js` | Планирование и атрибуция по вебхуку (БД) |
| `services/reminders/bonus.js` | Чтение баланса и начисление в YClients |
| `services/reminders/worker.js` | Аренда очереди, гейты, отправка |
| `services/reminders/preview.js` | Превью догона |
| `routes/reminders.js` | HTTP API `/api/reminders` |

**Создаются (фронт):** `frontend/js/pages/conditions-editor.js` (вынесенный из `care.js` конструктор условий), `frontend/js/pages/reminders.js`.

**Изменяются:** `migrations.js`, `routes/webhook.js`, `routes/index.js`, `server.js`, `services/care/worker.js` (одна строка — анти-спам), `frontend/js/pages/care.js`, `frontend/index.html`.

**Тесты:** `reminders-tiers.test.js`, `reminders-template.test.js`, `reminders-eligibility.test.js`, `reminders-attribution.test.js`, `reminders-backfill.test.js`, `reminders-daily-limit.test.js`, `reminders-enroll.test.js`, `reminders-bonus.test.js`, `reminders-worker.test.js` — все в `backend/`, рядом с существующими `care-*.test.js`.

---

## Task 1: Таблицы в миграциях

**Files:**
- Modify: `backend/migrations.js` (вставить сразу после блока `care_touch_sends`, перед комментарием `// ── Medical certificate`)

- [ ] **Step 1: Добавить три таблицы и индексы**

В `backend/migrations.js` найти конец care-блока — строку с индексом `idx_care_touch_sends_due` и закрывающим `).catch(() => {});`. Сразу после неё вставить:

```js
  // ── Напоминания о повторном визите ─────────────────────────────
  // Правило = условия отбора визита (тот же формат, что care_programs) +
  // задержка + текст + ступени бонусов. На каждый подходящий состоявшийся
  // визит заводится строка reminder_queue (очередь и журнал в одной таблице).
  // Статусы очереди: scheduled | sent | skipped | cancelled | failed.
  await client.query(`
    CREATE TABLE IF NOT EXISTS reminder_rules (
      id                   SERIAL PRIMARY KEY,
      salon_id             INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      title                VARCHAR(255) NOT NULL,
      is_enabled           BOOLEAN NOT NULL DEFAULT TRUE,
      conditions           JSONB NOT NULL DEFAULT '{"logic":"and","items":[]}',
      delay_days           INTEGER NOT NULL,
      send_time            VARCHAR(5) NOT NULL DEFAULT '11:00',
      text_mode            VARCHAR(10) NOT NULL DEFAULT 'strict',
      text                 TEXT NOT NULL DEFAULT '',
      attribution_days     INTEGER NOT NULL DEFAULT 30,
      bonus_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
      bonus_tiers          JSONB NOT NULL DEFAULT '[]',
      backfill_max_per_day INTEGER NOT NULL DEFAULT 30,
      created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_reminder_rules_salon
      ON reminder_rules (salon_id, is_enabled)
  `).catch(() => {});

  // rule_id — ON DELETE SET NULL (в отличие от «Заботы», где журнал уходит
  // каскадом): история «кому что по какому правилу» обязана пережить удаление
  // правила. Отсюда же денормализованный rule_title.
  await client.query(`
    CREATE TABLE IF NOT EXISTS reminder_queue (
      id                   BIGSERIAL PRIMARY KEY,
      salon_id             INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      rule_id              INTEGER REFERENCES reminder_rules(id) ON DELETE SET NULL,
      rule_title           VARCHAR(255),
      client_id            INTEGER,
      phone                VARCHAR(20),
      yclients_client_id   BIGINT,
      anchor_record_id     BIGINT,
      anchor_visit_at      TIMESTAMPTZ,
      anchor_staff_name    VARCHAR(255),
      anchor_services      JSONB DEFAULT '[]',
      scheduled_at         TIMESTAMPTZ NOT NULL,
      status               VARCHAR(20) NOT NULL DEFAULT 'scheduled',
      attempts             INTEGER NOT NULL DEFAULT 0,
      defers               INTEGER NOT NULL DEFAULT 0,
      last_attempt_at      TIMESTAMPTZ,
      error                TEXT,
      decision_reason      TEXT,
      rendered_text        TEXT,
      routing              JSONB,
      channel_used         VARCHAR(30),
      delivery_id          TEXT,
      sent_at              TIMESTAMPTZ,
      balance_before       INTEGER,
      bonus_tier           VARCHAR(20),
      bonus_accrued        INTEGER,
      bonus_txn_ok         BOOLEAN,
      conversion_record_id BIGINT,
      converted_at         TIMESTAMPTZ,
      visited_at           TIMESTAMPTZ,
      source               VARCHAR(20) NOT NULL DEFAULT 'webhook',
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (rule_id, anchor_record_id)
    )
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_reminder_queue_due
      ON reminder_queue (scheduled_at) WHERE status = 'scheduled'
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_reminder_queue_phone
      ON reminder_queue (salon_id, phone, sent_at DESC)
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_reminder_queue_history
      ON reminder_queue (salon_id, rule_id, created_at DESC)
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS reminder_suppressions (
      id         BIGSERIAL PRIMARY KEY,
      salon_id   INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      rule_id    INTEGER NOT NULL REFERENCES reminder_rules(id) ON DELETE CASCADE,
      phone      VARCHAR(20) NOT NULL,
      muted      BOOLEAN NOT NULL DEFAULT TRUE,
      reason     TEXT,
      source     VARCHAR(10) NOT NULL DEFAULT 'auto',
      muted_at   TIMESTAMPTZ,
      reset_at   TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (rule_id, phone)
    )
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_reminder_suppressions_salon
      ON reminder_suppressions (salon_id, phone) WHERE muted = TRUE
  `).catch(() => {});
```

- [ ] **Step 2: Прогнать миграции на дев-БД**

Перезапустить дев-сервер (миграции идут на старте):

```bash
cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro --update-env && sleep 5 && pm2 logs loyalpro --lines 30 --nostream
```

Ожидается: сервер `online`, в логах нет ошибок миграций. Флаг `PORT=3001` обязателен — в шелле `PORT=8080` занят, без него сервер уходит в краш-луп.

- [ ] **Step 3: Проверить схему в БД**

Через MCP PostgreSQL (`mcp__postgres__query`, не `psql`):

```sql
SELECT table_name, count(*) AS cols
  FROM information_schema.columns
 WHERE table_name IN ('reminder_rules','reminder_queue','reminder_suppressions')
 GROUP BY table_name ORDER BY table_name;
```

Ожидается три строки: `reminder_queue` 34, `reminder_rules` 17, `reminder_suppressions` 11.

- [ ] **Step 4: Commit**

```bash
cd /root/loyalpro && git add backend/migrations.js && git commit -m "feat(reminders): таблицы правил, очереди и флагов анти-повтора"
```

---

## Task 2: Подбор бонусной ступени (чистый модуль)

**Files:**
- Create: `backend/services/reminders/tiers.js`
- Test: `backend/reminders-tiers.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/reminders-tiers.test.js`:

```js
'use strict';
// Подбор бонусной ступени по балансу карты. Ступени задаёт салон в правиле;
// баланс попадает в ПЕРВУЮ ступень, для которой balance < up_to.
const { pickTier, normalizeTiers } = require('./services/reminders/tiers');

// Утверждённая салоном схема из спеки: мало бонусов — начисляем, средняя
// полоса — молчим про бонусы, много — напоминаем о накопленном.
const TIERS = [
  { up_to: 500,  action: 'accrue',  amount: 300, text: 'начислили {бонусы}' },
  { up_to: 1000, action: 'none',    amount: 0,   text: '' },
  { up_to: null, action: 'mention', amount: 0,   text: 'у вас {баланс}' },
];

describe('pickTier', () => {
  test('баланс ниже первого порога → начисление', () => {
    expect(pickTier(0, TIERS)).toMatchObject({ action: 'accrue', amount: 300 });
    expect(pickTier(499, TIERS)).toMatchObject({ action: 'accrue', amount: 300 });
  });

  test('граница порога исключающая: ровно 500 уже средняя полоса', () => {
    expect(pickTier(500, TIERS)).toMatchObject({ action: 'none' });
    expect(pickTier(999, TIERS)).toMatchObject({ action: 'none' });
  });

  test('ступень up_to:null принимает любой остаток', () => {
    expect(pickTier(1000, TIERS)).toMatchObject({ action: 'mention' });
    expect(pickTier(999999, TIERS)).toMatchObject({ action: 'mention' });
  });

  // Баланс неизвестен — нет карты или YClients не ответил. Утверждённое
  // поведение: напоминание уходит, но про бонусы в нём ни слова.
  test('неизвестный баланс → no_bonus', () => {
    expect(pickTier(null, TIERS).action).toBe('no_bonus');
    expect(pickTier(undefined, TIERS).action).toBe('no_bonus');
    expect(pickTier(NaN, TIERS).action).toBe('no_bonus');
    expect(pickTier('много', TIERS).action).toBe('no_bonus');
  });

  test('пустой список ступеней → no_bonus', () => {
    expect(pickTier(100, []).action).toBe('no_bonus');
    expect(pickTier(100, null).action).toBe('no_bonus');
  });

  // Без бесконечной ступени высокий баланс не покрыт ничем — молчим про
  // бонусы, а не проваливаемся в последнюю конечную ступень.
  test('все ступени конечные, баланс выше последней → no_bonus', () => {
    expect(pickTier(5000, [{ up_to: 500, action: 'accrue', amount: 300 }]).action).toBe('no_bonus');
  });
});

describe('normalizeTiers', () => {
  test('сортирует по возрастанию порога независимо от порядка в JSON', () => {
    const out = normalizeTiers([
      { up_to: 1000, action: 'none' },
      { up_to: 500,  action: 'accrue', amount: 300 },
    ]);
    expect(out.map(t => t.upTo)).toEqual([500, 1000]);
  });

  test('бесконечная ступень всегда последняя', () => {
    const out = normalizeTiers([
      { up_to: null, action: 'mention' },
      { up_to: 500,  action: 'accrue', amount: 300 },
    ]);
    expect(out[out.length - 1].upTo).toBeNull();
  });

  test('мусорные ступени отбрасываются, суммы приводятся к целым', () => {
    const out = normalizeTiers([
      { up_to: 500, action: 'магия', amount: 300 },
      { up_to: 'ой', action: 'accrue', amount: 10 },
      { up_to: 700, action: 'accrue', amount: '250.7' },
      null,
    ]);
    expect(out).toEqual([{ upTo: 700, action: 'accrue', amount: 251, text: '' }]);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd /root/loyalpro/backend && npx jest reminders-tiers --silent
```

Ожидается: FAIL, `Cannot find module './services/reminders/tiers'`.

- [ ] **Step 3: Реализовать модуль**

Создать `backend/services/reminders/tiers.js`:

```js
'use strict';
// Подбор бонусной ступени по балансу карты лояльности. Чистый модуль: ни БД,
// ни сети. Ступени приходят из reminder_rules.bonus_tiers как есть (их пишет
// администратор через админку), поэтому нормализация обязана быть
// недоверчивой: неизвестное действие или нечисловой порог не должны молча
// превратиться в начисление реальных денег на карту клиента.
//
// Порог up_to ИСКЛЮЧАЮЩИЙ: ступень ловит баланс строго меньше своего порога.
// Последняя ступень с up_to:null — «весь остаток».

const TIER_ACTIONS = ['accrue', 'mention', 'none'];

/** Ступень «про бонусы молчим»: нет карты, сбой YClients, кривые настройки. */
const NO_BONUS = Object.freeze({ upTo: null, action: 'no_bonus', amount: 0, text: '' });

/** Сырые ступени из JSONB → отсортированный валидный список. */
function normalizeTiers(raw) {
  const list = (Array.isArray(raw) ? raw : [])
    .filter(t => t && TIER_ACTIONS.includes(t.action))
    .map(t => ({
      upTo: t.up_to === null || t.up_to === undefined ? null : Number(t.up_to),
      action: t.action,
      amount: Math.max(0, Math.round(Number(t.amount) || 0)),
      text: String(t.text || ''),
    }))
    .filter(t => t.upTo === null || Number.isFinite(t.upTo));

  const finite = list.filter(t => t.upTo !== null).sort((a, b) => a.upTo - b.upTo);
  const infinite = list.find(t => t.upTo === null);
  return infinite ? [...finite, infinite] : finite;
}

/**
 * Баланс → ступень. Возвращает объект вида
 * { upTo, action: 'accrue'|'mention'|'none'|'no_bonus', amount, text }.
 * Неизвестный баланс и непокрытый остаток дают 'no_bonus' — сообщение уйдёт
 * без бонусной части, а не по случайной ступени.
 */
function pickTier(balance, rawTiers) {
  const b = Number(balance);
  if (balance === null || balance === undefined || !Number.isFinite(b)) return NO_BONUS;
  for (const t of normalizeTiers(rawTiers)) {
    if (t.upTo === null || b < t.upTo) return t;
  }
  return NO_BONUS;
}

module.exports = { pickTier, normalizeTiers, TIER_ACTIONS, NO_BONUS };
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cd /root/loyalpro/backend && npx jest reminders-tiers --silent
```

Ожидается: PASS, 9 тестов.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/reminders/tiers.js backend/reminders-tiers.test.js && git commit -m "feat(reminders): подбор бонусной ступени по балансу"
```

---

## Task 3: Подстановки в текст напоминания (чистый модуль)

**Files:**
- Create: `backend/services/reminders/template.js`
- Test: `backend/reminders-template.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/reminders-template.test.js`:

```js
'use strict';
// Подстановки в текст напоминания. Ключевой инвариант — {first_name} идёт через
// общий resolveGivenName: на боевой базе PERI 73.5% карточек это «Фамилия Имя
// Отчество» одной строкой, и «первое слово» дало бы клиенту «Вихарева, пора
// повторить процедуру».
const { renderReminderText, pickTierText } = require('./services/reminders/template');

describe('renderReminderText', () => {
  test('подставляет личное имя, а не фамилию', () => {
    const out = renderReminderText('{first_name}, пора повторить!', { name: 'Вихарева Мария Андреевна' });
    expect(out).toBe('Мария, пора повторить!');
  });

  test('имя не опознано → осиротевшая запятая схлопывается', () => {
    const out = renderReminderText('{first_name}, пора повторить!', { name: '89201234567' });
    expect(out).toBe('Пора повторить!');
  });

  test('подставляет бонусы, баланс, услугу, мастера и срок', () => {
    const out = renderReminderText(
      '{услуга} у {мастер} была {дней} дн. назад. Начислили {бонусы}, всего {баланс}. {салон}',
      { service: 'Лазерная эпиляция', staff: 'Юлия', days: 30, accrued: 300, balance: 800, salon: 'PERI CLINIC' });
    expect(out).toBe('Лазерная эпиляция у Юлия была 30 дн. назад. Начислили 300, всего 800. PERI CLINIC');
  });

  // Ноль — валидное значение и обязан отрендериться как «0», а не исчезнуть:
  // «на вашей карте 0 бонусов» это осмысленная фраза, «на вашей карте бонусов» — нет.
  test('нулевые числа подставляются, отсутствующие — пустой строкой', () => {
    expect(renderReminderText('{баланс}|{бонусы}', { balance: 0, accrued: 0 })).toBe('0|0');
    expect(renderReminderText('{баланс}|{бонусы}', {})).toBe('|');
  });

  test('пустой шаблон → пустая строка', () => {
    expect(renderReminderText('', { name: 'Мария' })).toBe('');
    expect(renderReminderText(null, {})).toBe('');
  });
});

describe('pickTierText', () => {
  test('текст ступени побеждает базовый', () => {
    expect(pickTierText({ text: 'ступень' }, 'база')).toBe('ступень');
  });

  // Пустой текст ступени означает «взять базовый текст правила» — это
  // единственный способ настроить ступень 'none', не дублируя основной текст.
  test('пустой текст ступени → базовый текст правила', () => {
    expect(pickTierText({ text: '' }, 'база')).toBe('база');
    expect(pickTierText({ text: '   ' }, 'база')).toBe('база');
    expect(pickTierText(null, 'база')).toBe('база');
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd /root/loyalpro/backend && npx jest reminders-template --silent
```

Ожидается: FAIL, `Cannot find module './services/reminders/template'`.

- [ ] **Step 3: Реализовать модуль**

Создать `backend/services/reminders/template.js`:

```js
'use strict';
// Подстановки в текст напоминания. Чистый модуль.
//
// {first_name} резолвится ТЕМ ЖЕ utils/person-name.resolveGivenName, что и в
// автоуведомлениях: подставлять первое слово карточки нельзя — на боевой базе
// PERI 73.5% карточек это «Фамилия Имя Отчество» одной строкой, а 11.6% вместо
// имени содержат телефон или «Тест 2». Имя не опознано → подстановка пустая, а
// осиротевшая запятая в начале строки схлопывается (иначе «, пора повторить»).

const { resolveGivenName } = require('../../utils/person-name');

/** Число, включая 0, рендерится; null/undefined → пустая строка. */
function num(v) {
  return v === null || v === undefined || v === '' ? '' : String(v);
}

/**
 * @param {string} tpl текст правила или ступени
 * @param {object} ctx { name, nameDictionary, service, staff, days, accrued, balance, salon }
 */
function renderReminderText(tpl, ctx = {}) {
  if (!tpl) return '';
  const firstName = resolveGivenName(ctx.name, { dictionary: ctx.nameDictionary }) || '';
  return String(tpl)
    .replace(/\{first_name\}/g, firstName)
    .replace(/\{name\}/g,       ctx.name || '')
    .replace(/\{услуга\}/g,     ctx.service || '')
    .replace(/\{мастер\}/g,     ctx.staff || '')
    .replace(/\{дней\}/g,       num(ctx.days))
    .replace(/\{бонусы\}/g,     num(ctx.accrued))
    .replace(/\{баланс\}/g,     num(ctx.balance))
    .replace(/\{салон\}/g,      ctx.salon || '')
    // «{first_name}, пора повторить» без имени → «Пора повторить»
    .replace(/^[ \t]*,\s*(\p{L})/gmu, (_, ch) => ch.toUpperCase());
}

/** Текст ступени, а при пустом — базовый текст правила. */
function pickTierText(tier, ruleText) {
  const t = String((tier && tier.text) || '').trim();
  return t || String(ruleText || '');
}

module.exports = { renderReminderText, pickTierText };
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cd /root/loyalpro/backend && npx jest reminders-template --silent
```

Ожидается: PASS, 7 тестов. Если тест про «Вихарева Мария Андреевна» упал — проверить, что `utils/given-names.js` содержит «Мария»; резолвер опирается на словарь имён и отчество.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/reminders/template.js backend/reminders-template.test.js && git commit -m "feat(reminders): подстановки в текст напоминания"
```

---

## Task 4: Проверка будущей записи (чистый модуль)

**Files:**
- Create: `backend/services/reminders/eligibility.js`
- Test: `backend/reminders-eligibility.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/reminders-eligibility.test.js`:

```js
'use strict';
// «Клиент уже записан на аналогичную услугу» — утверждённый критерий:
// будущая запись попадает под ТЕ ЖЕ условия правила (мастер/категория/услуга).
const { hasFutureMatchingBooking } = require('./services/reminders/eligibility');

const CAT_MAP = new Map([['101', '9'], ['102', '9'], ['200', '7']]);
const BY_CATEGORY = { logic: 'and', items: [{ type: 'category', ids: [9] }] };
const BY_SERVICE  = { logic: 'and', items: [{ type: 'service',  ids: [101] }] };

const rec = (serviceId, staffId) => ({
  services: [{ id: serviceId, title: 'услуга' }],
  staff: { id: staffId || 55 },
});

test('другая услуга той же категории считается аналогичной', () => {
  expect(hasFutureMatchingBooking([rec(102)], BY_CATEGORY, CAT_MAP)).toBe(true);
});

test('услуга чужой категории аналогичной не считается', () => {
  expect(hasFutureMatchingBooking([rec(200)], BY_CATEGORY, CAT_MAP)).toBe(false);
});

test('правило по конкретной услуге не ловит соседнюю', () => {
  expect(hasFutureMatchingBooking([rec(102)], BY_SERVICE, CAT_MAP)).toBe(false);
  expect(hasFutureMatchingBooking([rec(101)], BY_SERVICE, CAT_MAP)).toBe(true);
});

test('пустой список будущих записей → false', () => {
  expect(hasFutureMatchingBooking([], BY_CATEGORY, CAT_MAP)).toBe(false);
  expect(hasFutureMatchingBooking(null, BY_CATEGORY, CAT_MAP)).toBe(false);
});

// Пустая карта категорий — это сбой getServiceCategoryMap, а не «категорий
// нет». Условие по категории не сматчится, и напоминание уйдёт — осознанный
// fail-open, но он обязан быть виден в тесте.
test('пустая карта категорий не матчит условие по категории', () => {
  expect(hasFutureMatchingBooking([rec(102)], BY_CATEGORY, new Map())).toBe(false);
});

test('условие по мастеру работает', () => {
  const byStaff = { logic: 'and', items: [{ type: 'staff', ids: [55] }] };
  expect(hasFutureMatchingBooking([rec(200, 55)], byStaff, CAT_MAP)).toBe(true);
  expect(hasFutureMatchingBooking([rec(200, 77)], byStaff, CAT_MAP)).toBe(false);
});

// YClients кладёт мастера то в staff.id, то в staff_id — оба пути обязаны
// работать, иначе часть записей молча не сматчится.
test('мастер читается и из staff_id, и из staff.id', () => {
  const byStaff = { logic: 'and', items: [{ type: 'staff', ids: [55] }] };
  expect(hasFutureMatchingBooking([{ services: [], staff_id: 55 }], byStaff, CAT_MAP)).toBe(true);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd /root/loyalpro/backend && npx jest reminders-eligibility --silent
```

Ожидается: FAIL, `Cannot find module './services/reminders/eligibility'`.

- [ ] **Step 3: Реализовать модуль**

Создать `backend/services/reminders/eligibility.js`:

```js
'use strict';
// «Клиент уже записан на аналогичную услугу?» Чистый модуль.
//
// «Аналогичная» = попадает под ТЕ ЖЕ условия правила, что и визит-якорь
// (утверждено при обсуждении): правило на категорию «Лазерная эпиляция» считает
// аналогичной запись на любую услугу этой категории, а не только на ту же самую.
// Отсюда переиспользование evaluateRule — второй копии критерия быть не должно.
//
// Форма записи повторяет care/context.hasMatchingRepeatVisit: YClients отдаёт
// мастера то как staff.id, то как staff_id.

const { evaluateRule } = require('../notifications');

function recordContext(r, catMap) {
  const serviceIds = (Array.isArray(r.services) ? r.services : [])
    .map(s => s && s.id).filter(v => v != null);
  return {
    staffId: r.staff_id || (r.staff && r.staff.id) || null,
    serviceIds,
    categoryIds: [...new Set(serviceIds
      .map(id => (catMap || new Map()).get(String(id)))
      .filter(Boolean))],
  };
}

/** Есть ли среди будущих записей хоть одна под условия правила. */
function hasFutureMatchingBooking(future, conditions, catMap) {
  return (future || []).some(r => {
    if (!r) return false;
    try { return evaluateRule(conditions, recordContext(r, catMap)); }
    catch { return false; }
  });
}

module.exports = { hasFutureMatchingBooking, recordContext };
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cd /root/loyalpro/backend && npx jest reminders-eligibility --silent
```

Ожидается: PASS, 7 тестов.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/reminders/eligibility.js backend/reminders-eligibility.test.js && git commit -m "feat(reminders): проверка будущей записи под условия правила"
```

---

## Task 5: Общий анти-спам «одно сообщение в день»

**Files:**
- Create: `backend/services/messaging/daily-limit.js`
- Modify: `backend/services/care/worker.js` (только `defaultDeps.sentTodayExists`, строки 72–82)
- Test: `backend/reminders-daily-limit.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/reminders-daily-limit.test.js`:

```js
'use strict';
// Анти-спам общий для «Заботы» и напоминаний: клиент не должен получить в один
// день и «как самочувствие», и «пора повторить». Проверяем, что запрос
// действительно смотрит В ОБЕ очереди и считает московские сутки.
const { sentTodayExists, SENT_TODAY_SQL } = require('./services/messaging/daily-limit');

test('SQL смотрит обе очереди', () => {
  expect(SENT_TODAY_SQL).toContain('care_touch_sends');
  expect(SENT_TODAY_SQL).toContain('reminder_queue');
});

// Сервер живёт в Europe/Moscow, но «сутки» обязаны считаться явно: без
// AT TIME ZONE граница дня уедет вместе с TZ процесса.
test('сутки считаются по Москве', () => {
  expect(SENT_TODAY_SQL).toContain(`AT TIME ZONE 'Europe/Moscow'`);
});

test('строка найдена → true', async () => {
  const db = { oneOrNone: jest.fn(async () => ({ ok: 1 })) };
  await expect(sentTodayExists(db, 1, '79001234567')).resolves.toBe(true);
  expect(db.oneOrNone).toHaveBeenCalledWith(SENT_TODAY_SQL, [1, '79001234567']);
});

test('строки нет → false', async () => {
  const db = { oneOrNone: jest.fn(async () => null) };
  await expect(sentTodayExists(db, 1, '79001234567')).resolves.toBe(false);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd /root/loyalpro/backend && npx jest reminders-daily-limit --silent
```

Ожидается: FAIL, `Cannot find module './services/messaging/daily-limit'`.

- [ ] **Step 3: Реализовать модуль**

Создать `backend/services/messaging/daily-limit.js`:

```js
'use strict';
// Анти-спам «одно плановое сообщение клиенту в день», ОБЩИЙ для «Отдела заботы»
// и напоминаний о повторном визите. Две независимые очереди со своими воркерами
// легко сложились бы в два сообщения одному человеку в одно утро — «как
// самочувствие» от «Заботы» и «пора повторить» от напоминаний.
//
// Сутки считаются явно по Москве, а не по TZ процесса: сервер сегодня
// Europe/Moscow, но зависеть от этого нельзя (см. правило про AT TIME ZONE
// в CLAUDE.md).
//
// Ответ ОБЕИХ очередей на сработавший лимит — сдвиг на завтра, а не skip:
// плановое сообщение переносится, а не сгорает.

const SENT_TODAY_SQL = `
  SELECT 1 FROM (
    SELECT s.sent_at
      FROM care_touch_sends s
      JOIN care_enrollments e ON e.id = s.enrollment_id
     WHERE e.salon_id = $1 AND e.phone = $2 AND s.status = 'sent'
    UNION ALL
    SELECT q.sent_at
      FROM reminder_queue q
     WHERE q.salon_id = $1 AND q.phone = $2 AND q.status = 'sent'
  ) t
   WHERE (t.sent_at AT TIME ZONE 'Europe/Moscow')::date
       = (NOW() AT TIME ZONE 'Europe/Moscow')::date
   LIMIT 1`;

/** Уходило ли этому телефону плановое сообщение сегодня (любой из очередей). */
async function sentTodayExists(db, salonId, phone) {
  const row = await db.oneOrNone(SENT_TODAY_SQL, [salonId, phone]);
  return !!row;
}

module.exports = { sentTodayExists, SENT_TODAY_SQL };
```

- [ ] **Step 4: Подключить в воркер «Заботы»**

В `backend/services/care/worker.js` заменить целиком блок `sentTodayExists` из `defaultDeps` (строки 72–82, от `sentTodayExists: async (salonId, phone) => {` до закрывающей `},`) на:

```js
  // Анти-спам общий с напоминаниями о повторном визите: клиент не должен
  // получить в один день и касание «Заботы», и напоминание (см.
  // services/messaging/daily-limit.js).
  sentTodayExists: (salonId, phone) => dailyLimit.sentTodayExists(realDb, salonId, phone),
```

И добавить импорт рядом с остальными, после строки `const notifications = require('../notifications');`:

```js
const dailyLimit = require('../messaging/daily-limit');
```

- [ ] **Step 5: Убедиться, что тесты проходят и «Забота» не сломалась**

```bash
cd /root/loyalpro/backend && npx jest reminders-daily-limit care- --silent
```

Ожидается: PASS во всех сьютах (`reminders-daily-limit`, `care-worker`, `care-enroll`, `care-context`, `care-decision`, `care-preview`, `care-prompt`, `care-schedule`).

- [ ] **Step 6: Проверить SQL живым запросом**

Через MCP PostgreSQL — запрос обязан выполниться на реальной схеме, юнит-тест валидность SQL не проверяет:

```sql
SELECT 1 FROM (
  SELECT s.sent_at FROM care_touch_sends s
    JOIN care_enrollments e ON e.id = s.enrollment_id
   WHERE e.salon_id = 1 AND e.phone = '79000000000' AND s.status = 'sent'
  UNION ALL
  SELECT q.sent_at FROM reminder_queue q
   WHERE q.salon_id = 1 AND q.phone = '79000000000' AND q.status = 'sent'
) t
 WHERE (t.sent_at AT TIME ZONE 'Europe/Moscow')::date
     = (NOW() AT TIME ZONE 'Europe/Moscow')::date
 LIMIT 1;
```

Ожидается: 0 строк без ошибки синтаксиса.

- [ ] **Step 7: Commit**

```bash
cd /root/loyalpro && git add backend/services/messaging/daily-limit.js backend/reminders-daily-limit.test.js backend/services/care/worker.js && git commit -m "feat(reminders): общий анти-спам на очереди «Заботы» и напоминаний"
```

---

## Task 6: Атрибуция конверсии (чистый модуль)

**Files:**
- Create: `backend/services/reminders/attribution.js`
- Test: `backend/reminders-attribution.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/reminders-attribution.test.js`:

```js
'use strict';
// Какая отправленная строка журнала засчитывает себе новую запись клиента.
// Утверждено: окно 30 дней (настраивается в правиле), считаем и запись, и
// состоявшийся визит.
const { pickAttributionRow } = require('./services/reminders/attribution');

const CAT_MAP = new Map([['101', '9'], ['200', '7']]);
const HOUR = 3600000;
const NOW = Date.parse('2026-08-07T10:00:00Z');

const row = (over = {}) => ({
  id: 1,
  rule_id: 5,
  conditions: { logic: 'and', items: [{ type: 'category', ids: [9] }] },
  attribution_days: 30,
  sent_at: new Date(NOW - 24 * HOUR).toISOString(),
  conversion_record_id: null,
  ...over,
});

const booking = { services: [{ id: 101 }], staff: { id: 55 } };

test('свежая отправка под условия правила засчитывается', () => {
  expect(pickAttributionRow([row()], booking, CAT_MAP, NOW)).toMatchObject({ id: 1 });
});

test('запись чужой категории не засчитывается', () => {
  const other = { services: [{ id: 200 }], staff: { id: 55 } };
  expect(pickAttributionRow([row()], other, CAT_MAP, NOW)).toBeNull();
});

test('отправка старше окна атрибуции не засчитывается', () => {
  const old = row({ sent_at: new Date(NOW - 31 * 24 * HOUR).toISOString() });
  expect(pickAttributionRow([old], booking, CAT_MAP, NOW)).toBeNull();
});

// Граница окна включающая: ровно 30 дней ещё считается, 30 дней + час — нет.
test('граница окна', () => {
  const edge = row({ sent_at: new Date(NOW - 30 * 24 * HOUR).toISOString() });
  expect(pickAttributionRow([edge], booking, CAT_MAP, NOW)).toMatchObject({ id: 1 });
  const over = row({ sent_at: new Date(NOW - 30 * 24 * HOUR - HOUR).toISOString() });
  expect(pickAttributionRow([over], booking, CAT_MAP, NOW)).toBeNull();
});

test('уже размеченная строка второй раз не засчитывает', () => {
  expect(pickAttributionRow([row({ conversion_record_id: 99 })], booking, CAT_MAP, NOW)).toBeNull();
});

// Правило удалено — rule_id и conditions NULL, сверять запись не с чем.
test('строка без правила пропускается', () => {
  expect(pickAttributionRow([row({ rule_id: null, conditions: null })], booking, CAT_MAP, NOW)).toBeNull();
});

// Из нескольких подходящих строк конверсию забирает САМАЯ СВЕЖАЯ: именно она
// с наибольшей вероятностью и привела клиента.
test('из нескольких подходящих выбирается самая свежая', () => {
  const older = row({ id: 1, sent_at: new Date(NOW - 20 * 24 * HOUR).toISOString() });
  const newer = row({ id: 2, sent_at: new Date(NOW - 2 * 24 * HOUR).toISOString() });
  expect(pickAttributionRow([older, newer], booking, CAT_MAP, NOW)).toMatchObject({ id: 2 });
});

test('пустой список → null', () => {
  expect(pickAttributionRow([], booking, CAT_MAP, NOW)).toBeNull();
  expect(pickAttributionRow(null, booking, CAT_MAP, NOW)).toBeNull();
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd /root/loyalpro/backend && npx jest reminders-attribution --silent
```

Ожидается: FAIL, `Cannot find module './services/reminders/attribution'`.

- [ ] **Step 3: Реализовать модуль**

Создать `backend/services/reminders/attribution.js`:

```js
'use strict';
// Атрибуция конверсии: клиент создал новую запись — какому напоминанию её
// засчитать. Чистый модуль.
//
// Условия отбора те же, что у правила (переиспользуем recordContext из
// eligibility.js — второй копии разбора записи YClients быть не должно).
// Окно атрибуции берётся из самой строки (attribution_days правила), граница
// ВКЛЮЧАЮЩАЯ. Из нескольких подходящих строк побеждает самая свежая: именно
// последнее напоминание вероятнее всего и привело клиента.
//
// Строки с удалённым правилом (rule_id IS NULL) пропускаются: сверять новую
// запись не с чем, а угадывать условия по тексту нельзя.

const { evaluateRule } = require('../notifications');
const { recordContext } = require('./eligibility');

const DAY_MS = 86400000;

/**
 * @param {object[]} rows    строки reminder_queue со status='sent', с полями
 *                           id, rule_id, conditions, attribution_days, sent_at,
 *                           conversion_record_id
 * @param {object}   booking сырая запись YClients
 * @param {Map}      catMap  serviceId(str) → categoryId(str)
 * @param {number}   nowMs
 * @returns {object|null} строка-победитель
 */
function pickAttributionRow(rows, booking, catMap, nowMs = Date.now()) {
  if (!booking) return null;
  const ctx = recordContext(booking, catMap);

  const candidates = (rows || []).filter(r => {
    if (!r || r.conversion_record_id != null) return false;
    if (r.rule_id == null || !r.conditions) return false;
    const sentMs = Date.parse(r.sent_at);
    if (!Number.isFinite(sentMs)) return false;
    const windowDays = Number(r.attribution_days);
    const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 30;
    if (nowMs - sentMs > days * DAY_MS) return false;
    try { return evaluateRule(r.conditions, ctx); } catch { return false; }
  });
  if (!candidates.length) return null;

  candidates.sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at));
  return candidates[0];
}

module.exports = { pickAttributionRow };
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cd /root/loyalpro/backend && npx jest reminders-attribution --silent
```

Ожидается: PASS, 8 тестов.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/reminders/attribution.js backend/reminders-attribution.test.js && git commit -m "feat(reminders): атрибуция конверсии по окну и условиям правила"
```

---

## Task 7: Планирование и атрибуция по вебхуку

**Files:**
- Create: `backend/services/reminders/enroll.js`
- Test: `backend/reminders-enroll.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/reminders-enroll.test.js`:

```js
'use strict';
// Планирование напоминаний по вебхуку записи. Все зависимости инжектируются —
// БД и сеть не трогаются. Проверки идут по подстрокам SQL в вызовах db, как в
// care-worker.test.js.
const enroll = require('./services/reminders/enroll');

const SALON = { id: 1, yclients_company_id: 100 };

const RULE = {
  id: 5, salon_id: 1, title: 'Эпиляция раз в месяц',
  conditions: { logic: 'and', items: [{ type: 'category', ids: [9] }] },
  delay_days: 30, send_time: '11:00',
};

// Состоявшийся визит по услуге 101 (категория 9 в catMap).
const VISIT = {
  id: 777, date: '2026-08-01 14:00:00', attendance: 1,
  client: { id: 42, phone: '+7 (920) 025-55-91', name: 'Мария' },
  staff: { id: 55, name: 'Юлия' },
  services: [{ id: 101, title: 'Лазерная эпиляция' }],
};

function makeDeps(over = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      db: {
        any: jest.fn(async () => [RULE]),
        query: jest.fn(async (sql, params) => { calls.push({ sql, params }); return { rowCount: 1 }; }),
        oneOrNone: jest.fn(async (sql, params) => {
          calls.push({ sql, params });
          if (/FROM clients/i.test(sql)) return { id: 42, name: 'Мария', is_blacklisted: false };
          return null;
        }),
      },
      getCatMap: jest.fn(async () => new Map([['101', '9']])),
      log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      ...over,
    },
  };
}

const sqlsOf = (calls, re) => calls.filter(c => re.test(c.sql));

describe('handleRecordEvent — визит состоялся', () => {
  test('ставит строку очереди на visit_at + delay_days', async () => {
    const { calls, deps } = makeDeps();
    await enroll.handleRecordEvent(SALON, { status: 'update', data: VISIT }, deps);
    const ins = sqlsOf(calls, /INSERT INTO reminder_queue/i);
    expect(ins).toHaveLength(1);
    // 2026-08-01 + 30 дней = 2026-08-31, 11:00 МСК = 08:00 UTC
    const at = ins[0].params.find(p => p instanceof Date);
    expect(at.toISOString()).toBe('2026-08-31T08:00:00.000Z');
  });

  // Порядок обязателен: снятие флага ДО планирования, иначе новая строка
  // упрётся в собственный muted от прошлого цикла и не уйдёт никогда.
  test('снимает muted ДО постановки в очередь', async () => {
    const { calls, deps } = makeDeps();
    await enroll.handleRecordEvent(SALON, { status: 'update', data: VISIT }, deps);
    const resetIdx = calls.findIndex(c => /reminder_suppressions[\s\S]*muted\s*=\s*FALSE/i.test(c.sql));
    const insertIdx = calls.findIndex(c => /INSERT INTO reminder_queue/i.test(c.sql));
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(resetIdx);
  });

  test('отменяет запланированные строки от более ранних визитов', async () => {
    const { calls, deps } = makeDeps();
    await enroll.handleRecordEvent(SALON, { status: 'update', data: VISIT }, deps);
    const sup = sqlsOf(calls, /UPDATE reminder_queue[\s\S]*'cancelled'/i);
    expect(sup.length).toBeGreaterThan(0);
    expect(sup[0].sql).toMatch(/anchor_visit_at\s*<\s*\$/i);
  });

  test('клиент в чёрном списке не планируется', async () => {
    const { calls, deps } = makeDeps({
      db: {
        any: jest.fn(async () => [RULE]),
        query: jest.fn(async () => ({ rowCount: 1 })),
        oneOrNone: jest.fn(async () => ({ id: 42, name: 'М', is_blacklisted: true })),
      },
    });
    await enroll.handleRecordEvent(SALON, { status: 'update', data: VISIT }, deps);
    expect(sqlsOf(calls, /INSERT INTO reminder_queue/i)).toHaveLength(0);
  });

  test('визит без телефона не планируется', async () => {
    const { calls, deps } = makeDeps();
    const noPhone = { ...VISIT, client: { id: 42, phone: '', name: 'М' } };
    await enroll.handleRecordEvent(SALON, { status: 'update', data: noPhone }, deps);
    expect(sqlsOf(calls, /INSERT INTO reminder_queue/i)).toHaveLength(0);
  });

  test('визит вне условий правила не планируется', async () => {
    const { calls, deps } = makeDeps({ getCatMap: jest.fn(async () => new Map([['101', '7']])) });
    await enroll.handleRecordEvent(SALON, { status: 'update', data: VISIT }, deps);
    expect(sqlsOf(calls, /INSERT INTO reminder_queue/i)).toHaveLength(0);
  });

  // Оплата бонусами — тоже состоявшийся визит: критерий attendance=1 ИЛИ
  // paid_full=1, ровно как в care/enroll.js.
  test('paid_full=1 без attendance тоже считается визитом', async () => {
    const { calls, deps } = makeDeps();
    const paid = { ...VISIT, attendance: 0, paid_full: 1 };
    await enroll.handleRecordEvent(SALON, { status: 'update', data: paid }, deps);
    expect(sqlsOf(calls, /INSERT INTO reminder_queue/i)).toHaveLength(1);
  });
});

describe('handleRecordEvent — отмена', () => {
  test('удаление записи гасит её запланированные строки', async () => {
    const { calls, deps } = makeDeps();
    await enroll.handleRecordEvent(SALON, { status: 'delete', data: VISIT }, deps);
    const cancels = sqlsOf(calls, /UPDATE reminder_queue[\s\S]*'cancelled'/i);
    expect(cancels).toHaveLength(1);
    expect(cancels[0].params).toContain(777);
    expect(sqlsOf(calls, /INSERT INTO reminder_queue/i)).toHaveLength(0);
  });

  // Предоплаченная неявка несёт paid_full=1 ОДНОВРЕМЕННО с attendance=-1 —
  // это отмена, а не повод начинать цикл напоминаний.
  test('attendance=-1 при paid_full=1 — это отмена', async () => {
    const { calls, deps } = makeDeps();
    const noShow = { ...VISIT, attendance: -1, paid_full: 1 };
    await enroll.handleRecordEvent(SALON, { status: 'update', data: noShow }, deps);
    expect(sqlsOf(calls, /INSERT INTO reminder_queue/i)).toHaveLength(0);
    expect(sqlsOf(calls, /UPDATE reminder_queue[\s\S]*'cancelled'/i)).toHaveLength(1);
  });
});

describe('handleAttribution', () => {
  test('размечает подходящую отправленную строку', async () => {
    const sentRow = {
      id: 11, rule_id: 5, conditions: RULE.conditions, attribution_days: 30,
      sent_at: new Date(Date.now() - 86400000).toISOString(), conversion_record_id: null,
    };
    const { calls, deps } = makeDeps({
      db: {
        any: jest.fn(async () => [sentRow]),
        query: jest.fn(async (sql, params) => { return { rowCount: 1 }; }),
        oneOrNone: jest.fn(async () => null),
      },
    });
    deps.db.query = jest.fn(async (sql, params) => { calls.push({ sql, params }); return { rowCount: 1 }; });
    await enroll.handleAttribution(SALON, { status: 'create', data: VISIT }, deps);
    const upd = sqlsOf(calls, /UPDATE reminder_queue[\s\S]*conversion_record_id/i);
    expect(upd).toHaveLength(1);
    expect(upd[0].params).toEqual(expect.arrayContaining([11, 777]));
  });

  test('состоявшийся визит по приведённой записи проставляет visited_at', async () => {
    const { calls, deps } = makeDeps({
      db: {
        any: jest.fn(async () => []),
        query: jest.fn(async (sql, params) => { calls.push({ sql, params }); return { rowCount: 1 }; }),
        oneOrNone: jest.fn(async () => null),
      },
    });
    await enroll.handleAttribution(SALON, { status: 'update', data: VISIT }, deps);
    const visited = sqlsOf(calls, /UPDATE reminder_queue[\s\S]*visited_at/i);
    expect(visited).toHaveLength(1);
    expect(visited[0].params).toContain(777);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd /root/loyalpro/backend && npx jest reminders-enroll --silent
```

Ожидается: FAIL, `Cannot find module './services/reminders/enroll'`.

- [ ] **Step 3: Реализовать модуль**

Создать `backend/services/reminders/enroll.js`:

```js
'use strict';
// Планирование напоминаний о повторном визите и атрибуция конверсии.
// Зовётся из routes/webhook.js на resource='record', в собственном try/catch:
// падение напоминаний не должно ронять «Заботу» и начисление кэшбэка.
//
// Планирование ЧИСТО СОБЫТИЙНОЕ — бэкфилла нет, для догона по базе есть
// отдельная ручка (services/reminders/preview.js + routes/reminders.js).
//
// Критерий «визит состоялся» и классификация события — те же, что у «Заботы»
// (care/enroll.js): attendance=1 ИЛИ paid_full=1, а отмена/неявка проверяется
// ПЕРВОЙ, потому что предоплаченная неявка несёт paid_full=1 одновременно с
// attendance=-1.

const { db: realDb } = require('../../db');
const { evaluateRule, getServiceCategoryMap } = require('../notifications');
const { normalizePhoneKey } = require('../agent-gate');
const { parseVisitAt, computeScheduledAt } = require('../care/schedule');
const { isVisitCompleted, classifyRecordEvent } = require('../care/enroll');
const { recordContext } = require('./eligibility');
const { pickAttributionRow } = require('./attribution');
const { createLogger } = require('../../logger');

const defaultDeps = {
  db: realDb,
  getCatMap: (salon) => getServiceCategoryMap(salon),
  log: createLogger('Reminders'),
};

/** Отменить запланированные строки конкретной записи (отмена/неявка). */
async function cancelForRecord(db, salonId, recordId, reason) {
  await db.query(
    `UPDATE reminder_queue
        SET status = 'cancelled', decision_reason = $3
      WHERE salon_id = $1 AND anchor_record_id = $2 AND status = 'scheduled'`,
    [salonId, recordId, reason]);
}

async function handleRecordEvent(salon, payload, deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };
  const { db, log } = d;
  const data = (payload && payload.data) || {};
  if (!data.id) return;

  const kind = classifyRecordEvent(data, payload && payload.status);
  if (kind === 'unenroll') {
    await cancelForRecord(db, salon.id, data.id, 'запись отменена/неявка');
    return;
  }
  if (kind !== 'enroll') return;

  const rules = await db.any(
    `SELECT * FROM reminder_rules WHERE salon_id = $1 AND is_enabled = TRUE`,
    [salon.id]);
  if (!rules.length) return;

  const phone = normalizePhoneKey(data.client && data.client.phone);
  if (!phone) { log.info(`record=${data.id}: нет телефона — напоминание невозможно`); return; }

  const catMap = await d.getCatMap(salon).catch(() => new Map());
  const ctx = recordContext(data, catMap);
  const matched = rules.filter(r => {
    try { return evaluateRule(r.conditions, ctx); }
    catch (e) { log.warn(`rule #${r.id} evaluate failed: ${e.message}`); return false; }
  });
  if (!matched.length) return;

  // Фолбэк по телефону — как в care/enroll.js: несинкнутый клиент не должен
  // проскочить мимо чёрного списка.
  const client = await db.oneOrNone(
    `SELECT id, name, is_blacklisted FROM clients
      WHERE salon_id = $1 AND (yclients_client_id = $2 OR phone = $3)
      ORDER BY (yclients_client_id = $2) DESC NULLS LAST
      LIMIT 1`,
    [salon.id, data.client && data.client.id, phone]);
  if (client && client.is_blacklisted) {
    log.info(`record=${data.id}: клиент в ЧС — напоминания не планируем`); return;
  }

  const visitAt = parseVisitAt(data.date);
  const services = (Array.isArray(data.services) ? data.services : [])
    .map(s => ({ id: s && s.id, title: s && s.title })).filter(s => s.title);

  for (const rule of matched) {
    // 1) Клиент дошёл — снимаем флаг анти-повтора. ДО планирования: иначе новая
    //    строка упрётся в собственный muted от прошлого цикла (гейт воркера
    //    читает suppressions в момент отправки).
    await db.query(
      `UPDATE reminder_suppressions
          SET muted = FALSE, reset_at = NOW(), updated_at = NOW(),
              reason = 'клиент пришёл на визит'
        WHERE rule_id = $1 AND phone = $2 AND muted = TRUE`,
      [rule.id, phone]);

    // 2) Прежние запланированные строки от БОЛЕЕ РАННИХ визитов устарели.
    //    Условие по anchor_visit_at обязательно: правка старой записи может
    //    перевыстрелить вебхук годы спустя и погасила бы живое напоминание
    //    от актуального визита (тот же урок, что в care/enroll.js).
    if (visitAt) {
      await db.query(
        `UPDATE reminder_queue
            SET status = 'cancelled', decision_reason = 'новый визит перепланировал напоминание'
          WHERE salon_id = $1 AND rule_id = $2 AND phone = $3
            AND status = 'scheduled' AND anchor_record_id <> $4
            AND (anchor_visit_at IS NULL OR anchor_visit_at < $5)`,
        [salon.id, rule.id, phone, data.id, visitAt]);
    }

    // 3) Планируем. ON CONFLICT — дедуп ретраев вебхука.
    const at = computeScheduledAt(visitAt || new Date(), rule.delay_days, rule.send_time);
    if (!at) {
      log.warn(`rule #${rule.id}: computeScheduledAt вернул null (delay_days=${rule.delay_days}, send_time=${rule.send_time}) — напоминание пропущено`);
      continue;
    }
    await db.query(
      `INSERT INTO reminder_queue
         (salon_id, rule_id, rule_title, client_id, phone, yclients_client_id,
          anchor_record_id, anchor_visit_at, anchor_staff_name, anchor_services,
          scheduled_at, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,'webhook')
       ON CONFLICT (rule_id, anchor_record_id) DO NOTHING`,
      [salon.id, rule.id, rule.title, client ? client.id : null, phone,
       (data.client && data.client.id) || null, data.id, visitAt,
       (data.staff && data.staff.name) || null, JSON.stringify(services), at]);
    log.info(`rule #${rule.id} «${rule.title}»: напоминание record=${data.id} на ${at.toISOString()}`);
  }
}

/**
 * Атрибуция: клиент создал запись — засчитать её отправленному напоминанию;
 * визит по уже засчитанной записи состоялся — проставить visited_at.
 * Отдельная функция, потому что зовётся на ЛЮБОМ событии записи, а не только
 * на состоявшемся визите.
 */
async function handleAttribution(salon, payload, deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };
  const { db, log } = d;
  const data = (payload && payload.data) || {};
  if (!data.id) return;

  // Визит по приведённой записи состоялся — размечаем «дошёл».
  if (isVisitCompleted(data)) {
    await db.query(
      `UPDATE reminder_queue SET visited_at = NOW()
        WHERE salon_id = $1 AND conversion_record_id = $2 AND visited_at IS NULL`,
      [salon.id, data.id]);
  }
  if (payload && payload.status === 'delete') return;

  const phone = normalizePhoneKey(data.client && data.client.phone);
  if (!phone) return;

  // Кандидаты: отправленные напоминания клиента без отметки конверсии.
  // Окно и условия проверяет чистый pickAttributionRow — LIMIT здесь только
  // чтобы не тянуть годовую историю.
  const rows = await db.any(
    `SELECT q.id, q.rule_id, q.sent_at, q.conversion_record_id,
            r.conditions, r.attribution_days
       FROM reminder_queue q
       JOIN reminder_rules r ON r.id = q.rule_id
      WHERE q.salon_id = $1 AND q.phone = $2 AND q.status = 'sent'
        AND q.conversion_record_id IS NULL
      ORDER BY q.sent_at DESC
      LIMIT 20`,
    [salon.id, phone]);
  if (!rows.length) return;

  const catMap = await d.getCatMap(salon).catch(() => new Map());
  const win = pickAttributionRow(rows, data, catMap, Date.now());
  if (!win) return;

  await db.query(
    `UPDATE reminder_queue
        SET conversion_record_id = $2, converted_at = NOW()
      WHERE id = $1 AND conversion_record_id IS NULL`,
    [win.id, data.id]);
  log.info(`конверсия: напоминание #${win.id} привело запись ${data.id}`);
}

module.exports = { handleRecordEvent, handleAttribution, cancelForRecord, defaultDeps };
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cd /root/loyalpro/backend && npx jest reminders-enroll --silent
```

Ожидается: PASS, 11 тестов.

- [ ] **Step 5: Подключить в вебхук**

В `backend/routes/webhook.js` рядом с импортом care (строка 6) добавить:

```js
const reminders = require('../services/reminders/enroll');
```

И сразу после блока вызова care (строки 85–86, `await care.handleRecordEvent(...)`) добавить:

```js
      // Напоминания о повторном визите — в СВОЁМ catch: их падение не должно
      // ронять «Заботу» и начисление кэшбэка.
      await reminders.handleRecordEvent(salon, payload).catch(e =>
        logger.error(`reminders enroll: ${e.message}`));
      await reminders.handleAttribution(salon, payload).catch(e =>
        logger.error(`reminders attribution: ${e.message}`));
```

- [ ] **Step 6: Проверить, что сервер поднимается**

```bash
cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro --update-env && sleep 5 && pm2 logs loyalpro --lines 20 --nostream
```

Ожидается: `online`, без ошибок require.

- [ ] **Step 7: Commit**

```bash
cd /root/loyalpro && git add backend/services/reminders/enroll.js backend/reminders-enroll.test.js backend/routes/webhook.js && git commit -m "feat(reminders): планирование по визиту и атрибуция конверсии"
```

---

## Task 8: Бонусы — чтение баланса и начисление

**Files:**
- Create: `backend/services/reminders/bonus.js`
- Test: `backend/reminders-bonus.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/reminders-bonus.test.js`:

```js
'use strict';
// Чтение баланса карты и начисление. Внешние вызовы YClients инжектируются.
// Главный инвариант: любой сбой YClients деградирует в 'no_bonus' и НЕ мешает
// напоминанию уйти — утверждено при обсуждении («слать без бонусов»).
const bonus = require('./services/reminders/bonus');

const TIERS = [
  { up_to: 500,  action: 'accrue',  amount: 300, text: 'начислили {бонусы}' },
  { up_to: null, action: 'mention', amount: 0,   text: 'у вас {баланс}' },
];
const SALON = { id: 1, yclients_company_id: 100 };

const deps = (over = {}) => ({
  getCards: jest.fn(async () => [{ id: 900, balance: 120, number: '1', type: { title: 'samosale' } }]),
  accrue: jest.fn(async () => ({ id: 1 })),
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  ...over,
});

test('низкий баланс → начисление на карту, факт записан', async () => {
  const d = deps();
  const out = await bonus.applyBonus(SALON, 777, TIERS, 'Эпиляция', d);
  expect(out).toMatchObject({ balanceBefore: 120, tier: 'accrue', accrued: 300, txnOk: true });
  expect(d.accrue).toHaveBeenCalledWith(SALON, 900, 300, expect.stringContaining('Эпиляция'));
});

test('высокий баланс → упоминание без начисления', async () => {
  const d = deps({ getCards: jest.fn(async () => [{ id: 900, balance: 1500 }]) });
  const out = await bonus.applyBonus(SALON, 777, TIERS, 'Эпиляция', d);
  expect(out).toMatchObject({ balanceBefore: 1500, tier: 'mention', accrued: 0 });
  expect(d.accrue).not.toHaveBeenCalled();
});

test('карты нет → no_bonus, начисления нет', async () => {
  const d = deps({ getCards: jest.fn(async () => []) });
  const out = await bonus.applyBonus(SALON, 777, TIERS, 'Эпиляция', d);
  expect(out).toMatchObject({ balanceBefore: null, tier: 'no_bonus', accrued: 0, txnOk: null });
  expect(d.accrue).not.toHaveBeenCalled();
});

test('сбой чтения карт → no_bonus, исключение наружу не летит', async () => {
  const d = deps({ getCards: jest.fn(async () => { throw new Error('502'); }) });
  const out = await bonus.applyBonus(SALON, 777, TIERS, 'Эпиляция', d);
  expect(out).toMatchObject({ tier: 'no_bonus', accrued: 0 });
});

// Начисление упало — сообщение обязано уйти БЕЗ бонусной части, иначе клиент
// прочтёт про 300 бонусов, которых у него нет.
test('сбой начисления → no_bonus и txnOk=false', async () => {
  const d = deps({ accrue: jest.fn(async () => { throw new Error('YClients 500'); }) });
  const out = await bonus.applyBonus(SALON, 777, TIERS, 'Эпиляция', d);
  expect(out).toMatchObject({ balanceBefore: 120, tier: 'no_bonus', accrued: 0, txnOk: false });
});

test('нет клиента в YClients → no_bonus без вызовов', async () => {
  const d = deps();
  const out = await bonus.applyBonus(SALON, null, TIERS, 'Эпиляция', d);
  expect(out).toMatchObject({ tier: 'no_bonus' });
  expect(d.getCards).not.toHaveBeenCalled();
});

// Ступень accrue с нулевой суммой — настроечная ошибка администратора.
// Дёргать YClients на ноль бессмысленно, но и врать про начисление нельзя.
test('accrue с amount=0 не зовёт YClients и даёт no_bonus', async () => {
  const d = deps();
  const out = await bonus.applyBonus(SALON, 777,
    [{ up_to: null, action: 'accrue', amount: 0 }], 'Эпиляция', d);
  expect(d.accrue).not.toHaveBeenCalled();
  expect(out.tier).toBe('no_bonus');
});

test('несколько карт — берётся первая с максимальным балансом', async () => {
  const d = deps({ getCards: jest.fn(async () => [
    { id: 1, balance: 50 }, { id: 2, balance: 900 },
  ]) });
  const out = await bonus.applyBonus(SALON, 777, TIERS, 'Эпиляция', d);
  expect(out.balanceBefore).toBe(900);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd /root/loyalpro/backend && npx jest reminders-bonus --silent
```

Ожидается: FAIL, `Cannot find module './services/reminders/bonus'`.

- [ ] **Step 3: Реализовать модуль**

Создать `backend/services/reminders/bonus.js`:

```js
'use strict';
// Бонусная часть напоминания: прочитать баланс карты, подобрать ступень,
// при необходимости начислить.
//
// ГЛАВНЫЙ ИНВАРИАНТ: наружу этот модуль НИКОГДА не бросает. Любой сбой —
// нет карты, YClients не ответил, начисление отвалилось — деградирует в
// ступень 'no_bonus', и напоминание уходит без единого слова про бонусы
// (утверждено при обсуждении). Обратный порядок — «сначала пообещать, потом
// начислить» — отвергнут: клиент не должен прочитать про 300 бонусов, которых
// у него нет.
//
// Начисление НЕОБРАТИМО (ручная транзакция по карте лояльности), поэтому
// вызывающий обязан звать applyBonus не более одного раза на строку очереди —
// защита стоит в воркере (проверка bonus_accrued IS NULL).

const { ycGetClientCards, ycAccrueCard } = require('../yclients');
const { pickTier } = require('./tiers');
const { createLogger } = require('../../logger');

const defaultDeps = {
  getCards: (salon, ycClientId) => ycGetClientCards(salon, ycClientId),
  accrue: (salon, cardId, amount, title) => ycAccrueCard(salon, cardId, amount, title),
  log: createLogger('RemindersBonus'),
};

const NO_BONUS_RESULT = { balanceBefore: null, tier: 'no_bonus', accrued: 0, txnOk: null };

/**
 * @returns {{balanceBefore:number|null, tier:string, accrued:number, txnOk:boolean|null}}
 *   tier — 'accrue' | 'mention' | 'none' | 'no_bonus';
 *   txnOk — null если начисления не требовалось.
 */
async function applyBonus(salon, ycClientId, rawTiers, ruleTitle, deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };
  if (!ycClientId) return { ...NO_BONUS_RESULT };

  let cards = [];
  try { cards = await d.getCards(salon, ycClientId); }
  catch (e) { d.log.warn(`карты клиента ${ycClientId} недоступны (${e.message}) — без бонусов`); return { ...NO_BONUS_RESULT }; }
  if (!Array.isArray(cards) || !cards.length) return { ...NO_BONUS_RESULT };

  // Карт может быть несколько (разные программы). Берём ту, где больше денег:
  // именно её клиент и потратит, и именно её баланс честно называть.
  const card = cards
    .map(c => ({ id: c && c.id, balance: Number(c && c.balance) || 0 }))
    .filter(c => c.id != null)
    .sort((a, b) => b.balance - a.balance)[0];
  if (!card) return { ...NO_BONUS_RESULT };

  const tier = pickTier(card.balance, rawTiers);
  if (tier.action !== 'accrue' || tier.amount <= 0) {
    return {
      balanceBefore: card.balance,
      tier: tier.action === 'accrue' ? 'no_bonus' : tier.action,
      accrued: 0,
      txnOk: null,
    };
  }

  try {
    await d.accrue(salon, card.id, tier.amount, `Бонусы по напоминанию «${ruleTitle || ''}»`);
    return { balanceBefore: card.balance, tier: 'accrue', accrued: tier.amount, txnOk: true };
  } catch (e) {
    d.log.error(`начисление ${tier.amount} на карту ${card.id} упало: ${e.message}`);
    return { balanceBefore: card.balance, tier: 'no_bonus', accrued: 0, txnOk: false };
  }
}

module.exports = { applyBonus, defaultDeps };
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cd /root/loyalpro/backend && npx jest reminders-bonus --silent
```

Ожидается: PASS, 8 тестов.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/reminders/bonus.js backend/reminders-bonus.test.js && git commit -m "feat(reminders): чтение баланса и начисление бонусов по ступеням"
```

---

## Task 9: Воркер — аренда и гейты

**Files:**
- Create: `backend/services/reminders/worker.js`
- Test: `backend/reminders-worker.test.js`

- [ ] **Step 1: Написать падающий тест на гейты**

Создать `backend/reminders-worker.test.js`:

```js
'use strict';
// Воркер напоминаний. Все зависимости замоканы через DI, БД и сеть не
// трогаются. Проверки идут по подстрокам SQL в вызовах db.query — тот же
// стиль, что в care-worker.test.js.
const worker = require('./services/reminders/worker');

const ROW = {
  id: 10, salon_id: 1, rule_id: 5, phone: '79200255591',
  client_id: 42, yclients_client_id: 777,
  anchor_record_id: 700, anchor_visit_at: '2026-07-08T11:00:00.000Z',
  anchor_services: [{ id: 101, title: 'Лазерная эпиляция' }],
  scheduled_at: '2026-08-07T08:00:00.000Z',
  status: 'scheduled', attempts: 1, defers: 0,
  bonus_accrued: null, rule_title: 'Эпиляция раз в месяц',
  rule_enabled: true, rule_conditions: { logic: 'and', items: [{ type: 'category', ids: [9] }] },
  rule_text: '{first_name}, пора повторить {услуга}!',
  text_mode: 'strict', bonus_enabled: true,
  bonus_tiers: [{ up_to: 500, action: 'accrue', amount: 300, text: '{first_name}, начислили {бонусы} бонусов!' }],
  delay_days: 30, salon_name: 'PERI CLINIC', client_name: 'Мария',
};

function makeDeps(over = {}) {
  const updates = [];
  return {
    updates,
    deps: {
      db: {
        any: jest.fn(async () => []),
        query: jest.fn(async (sql, params) => { updates.push({ sql, params }); return { rowCount: 1 }; }),
        oneOrNone: jest.fn(async () => null),
      },
      isAllowed: jest.fn(async () => ({ allow: true, reason: 'ok' })),
      agentGloballyEnabled: () => true,
      dialogStatus: jest.fn(async () => null),
      isMuted: jest.fn(async () => false),
      sentTodayExists: jest.fn(async () => false),
      loadClientRecords: jest.fn(async () => ({ completedAfter: [], future: [] })),
      getCatMap: jest.fn(async () => new Map([['101', '9']])),
      applyBonus: jest.fn(async () => ({ balanceBefore: 120, tier: 'accrue', accrued: 300, txnOk: true })),
      loadTranscript: jest.fn(async () => ({ messages: [] })),
      createMessage: jest.fn(async () => ({ text: 'Мария, пора повторить!' })),
      lintReply: jest.fn(() => []),
      hardViolations: jest.fn(() => []),
      sendMessage: jest.fn(async () => ({ id: 777, channel: 'telegram' })),
      lastIncomingChannel: jest.fn(async () => 'telegram'),
      loadNameDictionary: jest.fn(async () => null),
      rememberPending: jest.fn(async () => {}),
      persistWhatsapp: jest.fn(async () => {}),
      mute: jest.fn(async () => {}),
      log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      ...over,
    },
  };
}

const find = (updates, re) => updates.filter(u => re.test(u.sql));

describe('гейты', () => {
  test('правило выключено → skipped', async () => {
    const { updates, deps } = makeDeps();
    await worker.processOne({ ...ROW, rule_enabled: false }, deps);
    expect(find(updates, /status='skipped'/).length).toBe(1);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  // Env kill-switch — временное состояние проекта, а не «этой строке нельзя
  // навсегда». Терминальный skip сжёг бы напоминание молча.
  test('агент выключен глобально → отложено, не сожжено', async () => {
    const { updates, deps } = makeDeps({ agentGloballyEnabled: () => false });
    await worker.processOne(ROW, deps);
    expect(find(updates, /SET scheduled_at/).length).toBe(1);
    expect(find(updates, /status='skipped'/).length).toBe(0);
  });

  test('чёрный список → skipped', async () => {
    const { updates, deps } = makeDeps({ isAllowed: jest.fn(async () => ({ allow: false, reason: 'blacklist' })) });
    await worker.processOne(ROW, deps);
    expect(find(updates, /status='skipped'/).length).toBe(1);
  });

  // Окно расписания на напоминания не распространяется (ignoreSchedule).
  // Если причина всё-таки пришла — это дефект конфигурации: откладываем и
  // ГРОМКО пишем в лог, а не сжигаем строку.
  test('гейт вернул outside-schedule → отложено + WARN', async () => {
    const { updates, deps } = makeDeps({ isAllowed: jest.fn(async () => ({ allow: false, reason: 'outside-schedule' })) });
    await worker.processOne(ROW, deps);
    expect(find(updates, /SET scheduled_at/).length).toBe(1);
    expect(deps.log.warn).toHaveBeenCalled();
  });

  test('гейт зовётся с ignoreSchedule', async () => {
    const { deps } = makeDeps();
    await worker.processOne(ROW, deps);
    expect(deps.isAllowed).toHaveBeenCalledWith(1, '79200255591');
  });

  test('диалог на операторе → отложено с инкрементом defers', async () => {
    const { updates, deps } = makeDeps({ dialogStatus: jest.fn(async () => 'escalated') });
    await worker.processOne(ROW, deps);
    const def = find(updates, /SET scheduled_at/);
    expect(def.length).toBe(1);
    expect(def[0].sql).toMatch(/defers\s*=\s*reminder_queue\.defers\s*\+\s*1|defers\s*=\s*defers\s*\+\s*1/);
  });

  test('терпение к паузе оператора кончается на третьем откладывании', async () => {
    const { updates, deps } = makeDeps({ dialogStatus: jest.fn(async () => 'escalated') });
    await worker.processOne({ ...ROW, defers: 3 }, deps);
    expect(find(updates, /status='skipped'/).length).toBe(1);
    expect(find(updates, /SET scheduled_at/).length).toBe(0);
  });

  test('флаг анти-повтора → cancelled', async () => {
    const { updates, deps } = makeDeps({ isMuted: jest.fn(async () => true) });
    await worker.processOne(ROW, deps);
    expect(find(updates, /status='cancelled'/).length).toBe(1);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  test('анти-спам «сообщение уже было сегодня» → отложено на день', async () => {
    const { updates, deps } = makeDeps({ sentTodayExists: jest.fn(async () => true) });
    await worker.processOne(ROW, deps);
    expect(find(updates, /SET scheduled_at/).length).toBe(1);
  });

  // Ради этого гейта модуль и делался: клиент уже записан — молчим.
  test('есть будущая запись под условия правила → cancelled', async () => {
    const { updates, deps } = makeDeps({
      loadClientRecords: jest.fn(async () => ({ completedAfter: [], future: [{ services: [{ id: 101 }], staff: { id: 55 } }] })),
    });
    await worker.processOne(ROW, deps);
    expect(find(updates, /status='cancelled'/).length).toBe(1);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  test('будущая запись на чужую услугу напоминание не гасит', async () => {
    const { deps } = makeDeps({
      loadClientRecords: jest.fn(async () => ({ completedAfter: [], future: [{ services: [{ id: 999 }], staff: { id: 55 } }] })),
    });
    await worker.processOne(ROW, deps);
    expect(deps.sendMessage).toHaveBeenCalled();
  });

  test('повторный подходящий визит уже состоялся → cancelled', async () => {
    const { updates, deps } = makeDeps({
      loadClientRecords: jest.fn(async () => ({ completedAfter: [{ services: [{ id: 101 }], staff: { id: 55 } }], future: [] })),
    });
    await worker.processOne(ROW, deps);
    expect(find(updates, /status='cancelled'/).length).toBe(1);
  });

  // Fail-open: перманентный сбой YClients не должен молча остановить ВСЕ
  // напоминания. Цена — редкое лишнее сообщение уже записавшемуся клиенту.
  test('сбой YClients на проверке записей не блокирует отправку', async () => {
    const { deps } = makeDeps({ loadClientRecords: jest.fn(async () => { throw new Error('502'); }) });
    await worker.processOne(ROW, deps);
    expect(deps.sendMessage).toHaveBeenCalled();
    expect(deps.log.warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd /root/loyalpro/backend && npx jest reminders-worker --silent
```

Ожидается: FAIL, `Cannot find module './services/reminders/worker'`.

- [ ] **Step 3: Реализовать воркер**

Создать `backend/services/reminders/worker.js`:

```js
'use strict';
// Воркер напоминаний о повторном визите. Аренда due-строк как в
// notification- и care-воркерах (FOR UPDATE SKIP LOCKED + attempts при
// аренде), затем на каждую строку: детерминированные гейты → бонусы →
// рендер текста → отправка → персист.
//
// Доставка AT-MOST-ONCE: пропущенное напоминание дешевле дубля живому
// клиенту. Отсюда захват строки условным UPDATE перед любыми side-effect'ами.
//
// Все внешние зависимости инжектируются — юнит-тесты без БД и сети.

const config = require('../../config');
const { db: realDb } = require('../../db');
const chatpush = require('../chatpush');
const { persistWhatsappOutgoing } = require('../chat-persist');
const agentSettings = require('../agent-settings');
const { getProvider } = require('../agent/providers');
const history = require('../agent/history');
const pendingReplies = require('../agent/pending-replies');
const replyGuard = require('../agent/reply-guard');
const salonNames = require('../../utils/salon-names');
const authorship = require('../outgoing-authorship');
const notifications = require('../notifications');
const dailyLimit = require('../messaging/daily-limit');
const careContext = require('../care/context');
const { plusOneDay } = require('../care/schedule');
const { hasFutureMatchingBooking } = require('./eligibility');
const { renderReminderText, pickTierText } = require('./template');
const { pickTier } = require('./tiers');
const bonusSvc = require('./bonus');
const { buildCarePrompt } = require('../care/care-prompt');
const { parseCareDecision } = require('../care/decision');
const { createLogger } = require('../../logger');

const log = createLogger('RemindersWorker');

const WORKER_TICK_MS      = 60000;
const MAX_ATTEMPTS        = 3;
const RETRY_BACKOFF_S     = 120;
const LLM_TIMEOUT_MS      = 60000;
// Предел терпения к паузе администратора: она обычно снимается вечерним
// sweep'ом, но ждать бесконечно нельзя — напоминание протухнет по смыслу.
const MAX_OPERATOR_DEFERS = 3;

const SEND_STATUSES = new Set(['scheduled', 'sent', 'skipped', 'cancelled', 'failed']);

// Маркер «[сообщение администратора клиники]» предназначен основному агенту:
// его промпт знает, что с ним делать, а care-промпт (который мы переиспользуем
// в режиме free) — нет, и пометка ушла бы клиенту дословно. Срезаем с начала
// КАЖДОЙ строки: реплики серии в транскрипте склеены через '\n'.
const OPERATOR_MARK_PREFIX = `${history.OPERATOR_MARK} `;
function stripOperatorMark(text) {
  return String(text || '')
    .split('\n')
    .map((line) => (line.startsWith(OPERATOR_MARK_PREFIX) ? line.slice(OPERATOR_MARK_PREFIX.length) : line))
    .join('\n');
}

const defaultDeps = {
  db: realDb,
  // ignoreSchedule: ночное окно Милы на плановые напоминания не
  // распространяется — время задаёт сам салон в правиле. Чёрный список,
  // режим whitelist и тумблер агента продолжают действовать.
  isAllowed: (salonId, phone) => agentSettings.isAllowed(salonId, phone, { ignoreSchedule: true }),
  agentGloballyEnabled: () => !!config.CHATPUSH.agentEnabled,
  dialogStatus: async (salonId, phone) => {
    const r = await realDb.oneOrNone(
      `SELECT status FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [salonId, phone]);
    return r ? r.status : null;
  },
  isMuted: async (ruleId, phone) => {
    const r = await realDb.oneOrNone(
      `SELECT 1 FROM reminder_suppressions WHERE rule_id=$1 AND phone=$2 AND muted=TRUE`,
      [ruleId, phone]);
    return !!r;
  },
  mute: async (salonId, ruleId, phone, reason) => {
    await realDb.query(
      `INSERT INTO reminder_suppressions (salon_id, rule_id, phone, muted, reason, source, muted_at, updated_at)
       VALUES ($1,$2,$3,TRUE,$4,'auto',NOW(),NOW())
       ON CONFLICT (rule_id, phone) DO UPDATE
         SET muted=TRUE, reason=$4, source='auto', muted_at=NOW(), reset_at=NULL, updated_at=NOW()`,
      [salonId, ruleId, phone, reason]);
  },
  sentTodayExists: (salonId, phone) => dailyLimit.sentTodayExists(realDb, salonId, phone),
  loadClientRecords: careContext.loadClientRecords,
  getCatMap: async (salonId) => {
    const salon = await realDb.one(
      `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
         FROM salons WHERE id=$1`, [salonId]);
    return notifications.getServiceCategoryMap(salon);
  },
  applyBonus: async (salonId, ycClientId, tiers, ruleTitle) => {
    const salon = await realDb.one(
      `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
         FROM salons WHERE id=$1`, [salonId]);
    return bonusSvc.applyBonus(salon, ycClientId, tiers, ruleTitle);
  },
  loadNameDictionary: (salonId) => salonNames.load(salonId).catch(() => null),
  loadTranscript: (salonId, key, opts) => history.loadTranscript(salonId, key, opts),
  createMessage: (req, opts) => getProvider().createMessage(req, opts),
  lintReply: replyGuard.lintReply,
  hardViolations: replyGuard.hardViolations,
  sendMessage: (payload) => chatpush.sendMessage(config.CHATPUSH.instanceToken, payload),
  lastIncomingChannel: notifications.lastIncomingChannel,
  rememberPending: async (salonId, key, text) => {
    pendingReplies.remember(salonId, key, text);
    await authorship.remember(salonId, key, text, 'system');
  },
  persistWhatsapp: (salonId, { delivery, phone, text }) =>
    persistWhatsappOutgoing(salonId, { delivery, phone, chatId: null, text, msgType: 'text' }),
  log,
};

async function markRow(db, id, status, reason) {
  if (!SEND_STATUSES.has(status)) throw new Error(`bad status: ${status}`);
  await db.query(
    `UPDATE reminder_queue SET status='${status}', decision_reason=$2 WHERE id=$1`,
    [id, reason || null]);
}

/**
 * Отложить строку на сутки. НЕ терминально: строка остаётся scheduled и видна
 * в интерфейсе, бюджет попыток обнуляется. База сдвига — max(scheduled_at,
 * now()), чтобы просроченная строка уехала в будущее одним шагом, а не по дню
 * за тик. bumpDefers — только для паузы оператора (у остальных откладываний
 * предела нет: выключенный агент и анти-спам пройдут сами).
 */
async function deferRow(db, row, reason, bumpDefers = false) {
  const base = Math.max(new Date(row.scheduled_at || Date.now()).getTime(), Date.now());
  await db.query(
    `UPDATE reminder_queue
        SET scheduled_at=$2, attempts=0, last_attempt_at=NULL, decision_reason=$3
            ${bumpDefers ? ', defers = reminder_queue.defers + 1' : ''}
      WHERE id=$1`,
    [row.id, plusOneDay(new Date(base)), reason]);
}

/** Текст напоминания: strict — шаблон, free — Мила по заготовке смысла. */
async function buildText(row, bonus, deps) {
  const services = Array.isArray(row.anchor_services) ? row.anchor_services : [];
  const days = row.anchor_visit_at
    ? Math.round((Date.now() - new Date(row.anchor_visit_at).getTime()) / 86400000)
    : null;
  const tier = pickTier(bonus.balanceBefore, row.bonus_tiers);
  const tplCtx = {
    name: row.client_name,
    nameDictionary: await deps.loadNameDictionary(row.salon_id),
    service: services.map(s => s.title).filter(Boolean).join(', '),
    staff: row.anchor_staff_name || '',
    days,
    accrued: bonus.accrued || null,
    balance: bonus.balanceBefore,
    salon: row.salon_name,
  };
  // Ступень применяется, только если бонусная часть реально состоялась:
  // при 'no_bonus' уходит базовый текст правила без единого слова о бонусах.
  const raw = bonus.tier === 'no_bonus' ? String(row.rule_text || '')
                                        : pickTierText(tier, row.rule_text);

  if (row.text_mode !== 'free') return renderReminderText(raw, tplCtx);

  // free: заготовка смысла (уже с подставленными цифрами) уходит в тот же
  // care-промпт — отдельного промпта для напоминаний не заводим.
  const transcript = await deps.loadTranscript(row.salon_id, row.phone, { limit: 15 })
    .catch(() => ({ messages: [] }));
  const { system, user } = buildCarePrompt({
    salonName: row.salon_name,
    clientName: row.client_name,
    nameDictionary: tplCtx.nameDictionary,
    touch: { title: row.rule_title, intent_text: renderReminderText(raw, tplCtx), text_mode: 'free' },
    enrollment: { staff_name: row.anchor_staff_name, visit_at: row.anchor_visit_at, services },
    transcript: (transcript.messages || []).map(m => ({
      direction: m.role === 'user' ? 'incoming' : 'outgoing',
      // stripOperatorMark — care-промпт про пометку администратора не знает и
      // отдал бы её клиенту дословно в тексте (тот же дефект чинили в «Заботе»).
      text: stripOperatorMark(typeof m.content === 'string' ? m.content
        : (Array.isArray(m.content) ? m.content.map(b => b.text || '').join(' ') : '')),
    })).filter(m => m.text),
    futureBookings: [],
  });
  let resp, timer;
  try {
    resp = await Promise.race([
      deps.createMessage({ system, messages: [{ role: 'user', content: user }] }, {}),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`reminder LLM timeout ${LLM_TIMEOUT_MS}ms`)), LLM_TIMEOUT_MS);
        if (timer.unref) timer.unref();
      }),
    ]);
  } finally { clearTimeout(timer); }
  const decision = parseCareDecision(resp && resp.text);
  return decision.action === 'send' ? decision.text : null;
}

async function processOne(row, deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };
  const { db } = d;
  const sid = row.salon_id;
  let delivered = false;
  let terminal = false;

  const finish = async (status, reason) => { await markRow(db, row.id, status, reason); terminal = true; };

  try {
    // ── детерминированные гейты ────────────────────────────────
    if (!row.rule_enabled) return finish('skipped', 'правило выключено');
    if (!d.agentGloballyEnabled()) {
      await deferRow(db, row, 'отложено: агент выключен (env)');
      return;
    }
    const gate = await d.isAllowed(sid, row.phone);
    if (!gate.allow) {
      if (gate.reason === 'outside-schedule') {
        d.log.warn(`row #${row.id}: гейт вернул outside-schedule вопреки ignoreSchedule — откладываю`);
        await deferRow(db, row, 'отложено: вне окна расписания агента');
        return;
      }
      return finish('skipped', `гейт Милы: ${gate.reason}`);
    }
    if (await d.dialogStatus(sid, row.phone) === 'escalated') {
      if (Number(row.defers) >= MAX_OPERATOR_DEFERS) {
        return finish('skipped', 'диалог на операторе дольше срока ожидания');
      }
      await deferRow(db, row, 'отложено: диалог на операторе', true);
      return;
    }
    if (await d.isMuted(row.rule_id, row.phone)) {
      return finish('cancelled', 'анти-повтор: напоминание уже отправлялось');
    }
    if (await d.sentTodayExists(sid, row.phone)) {
      await deferRow(db, row, 'анти-спам: сдвинуто на день');
      return;
    }

    // Проверки по живым записям YClients. Fail-open: перманентный сбой API не
    // должен молча остановить все напоминания (тот же размен, что в «Заботе»).
    const anchorMs = row.anchor_visit_at ? new Date(row.anchor_visit_at).getTime() : Date.now();
    let records = { completedAfter: [], future: [] };
    try { records = await d.loadClientRecords(sid, row.phone, anchorMs, Date.now()); }
    catch (e) { d.log.warn(`row #${row.id}: записи YClients недоступны (${e.message}) — без проверки записей`); }
    const catMap = await d.getCatMap(sid).catch(e => {
      d.log.warn(`row #${row.id}: карта категорий недоступна (${e.message})`);
      return new Map();
    });
    if (hasFutureMatchingBooking(records.future, row.rule_conditions, catMap)) {
      return finish('cancelled', 'клиент уже записан на аналогичную услугу');
    }
    if (hasFutureMatchingBooking(records.completedAfter, row.rule_conditions, catMap)) {
      return finish('cancelled', 'повторный визит уже состоялся');
    }

    // ── захват строки: с этого момента она наша ────────────────
    const marked = await db.query(
      `UPDATE reminder_queue SET status='sent', sent_at=NOW(), error=NULL
        WHERE id=$1 AND status='scheduled'`, [row.id]);
    if (!marked || !marked.rowCount) {
      d.log.info(`row #${row.id}: строка перехвачена другим исходом — не отправляем`);
      return;
    }

    // ── бонусы: строго один раз на строку ──────────────────────
    // Начисление НЕОБРАТИМО, поэтому повторная попытка (сбой отправки → откат
    // в scheduled) обязана взять уже записанный результат, а не начислить ещё раз.
    let bonus;
    if (row.bonus_accrued != null || row.bonus_tier != null) {
      bonus = { balanceBefore: row.balance_before, tier: row.bonus_tier,
                accrued: row.bonus_accrued || 0, txnOk: row.bonus_txn_ok };
    } else if (row.bonus_enabled) {
      bonus = await d.applyBonus(sid, row.yclients_client_id, row.bonus_tiers, row.rule_title);
      await db.query(
        `UPDATE reminder_queue SET balance_before=$2, bonus_tier=$3, bonus_accrued=$4, bonus_txn_ok=$5
          WHERE id=$1`,
        [row.id, bonus.balanceBefore, bonus.tier, bonus.accrued, bonus.txnOk]);
    } else {
      bonus = { balanceBefore: null, tier: 'no_bonus', accrued: 0, txnOk: null };
    }

    // ── текст ──────────────────────────────────────────────────
    const text = await buildText(row, bonus, d);
    if (!text || !String(text).trim()) return finish('skipped', 'текст напоминания пуст');
    const viol = d.hardViolations(d.lintReply(text, {}));
    if (viol.length) return finish('skipped', `reply-guard: ${viol.map(v => v.type).join(',')}`);

    const last = await d.lastIncomingChannel(sid, row.phone).catch(() => null);
    const routing = notifications.resolveRouting([], true, last);
    await db.query(
      `UPDATE reminder_queue SET rendered_text=$2, routing=$3::jsonb WHERE id=$1`,
      [row.id, text, JSON.stringify(routing)]);

    // ── отправка ───────────────────────────────────────────────
    const delivery = await d.sendMessage({ text, phone: row.phone, dispatchRouting: routing });
    delivered = true;
    d.log.info(`delivered #${row.id} delivery=${delivery && delivery.id}`);

    const channelUsed = (delivery && (delivery.channel || delivery.messenger)) || routing[0] || null;
    await db.query(
      `UPDATE reminder_queue SET delivery_id=$2, channel_used=$3, decision_reason=$4 WHERE id=$1`,
      [row.id, delivery && delivery.id != null ? String(delivery.id) : null, channelUsed,
       `отправлено, ступень ${bonus.tier}`]
    ).catch(e => d.log.error(`persist delivery #${row.id}: ${e.message}`));

    // Флаг анти-повтора вешается ТОЛЬКО за фактически отправленное сообщение.
    await d.mute(sid, row.rule_id, row.phone, 'напоминание отправлено')
      .catch(e => d.log.error(`mute #${row.id}: ${e.message}`));

    await d.rememberPending(sid, row.phone, text);
    if (channelUsed === 'whatsapp') {
      await d.persistWhatsapp(sid, { delivery, phone: row.phone, text })
        .catch(e => d.log.error(`persist wa: ${e.message}`));
    }
  } catch (e) {
    if (delivered) {
      // Доставлено клиенту — статус НЕ откатывать НИКОГДА: ретрай = дубль.
      d.log.error(`row #${row.id}: доставлено, но пост-обработка упала: ${e.message}`);
      await d.db.query(`UPDATE reminder_queue SET status='sent', error=$2 WHERE id=$1`,
        [row.id, String(e.message || e).slice(0, 500)]).catch(() => {});
      return;
    }
    if (terminal) {
      d.log.error(`row #${row.id}: терминальный статус записан, хвост упал: ${e.message}`);
      return;
    }
    // Отправки не было. Возврат в scheduled безопасен: бонусы уже записаны в
    // строку и повторно не начислятся.
    const final = row.attempts >= MAX_ATTEMPTS;
    await d.db.query(
      `UPDATE reminder_queue SET status='${final ? 'failed' : 'scheduled'}', sent_at=NULL, error=$2 WHERE id=$1`,
      [row.id, String(e.message || e).slice(0, 500)]).catch(() => {});
    d.log.warn(`row #${row.id} attempt ${row.attempts}/${MAX_ATTEMPTS} failed: ${e.message}`);
  }
}

// Аренда. КРИТИЧНО: на алиас цели UPDATE (rq) нельзя ссылаться из ON-условий
// джойнов во FROM — PG отвечает «invalid reference to FROM-clause entry».
// Поэтому имя клиента берётся скалярным подзапросом в RETURNING (там ссылка
// на rq легальна). Юнит-моки db.any валидность SQL не проверяют — после правок
// обязателен живой EXPLAIN на дев-БД, SQL экспортируется именно для этого.
const LEASE_SQL =
  `UPDATE reminder_queue rq
      SET attempts = rq.attempts + 1, last_attempt_at = NOW()
     FROM reminder_rules r
     JOIN salons sal ON sal.id = r.salon_id
    WHERE r.id = rq.rule_id
      AND rq.id IN (
        SELECT id FROM reminder_queue
         WHERE status = 'scheduled' AND scheduled_at <= NOW()
           AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - make_interval(secs => $1))
         ORDER BY scheduled_at ASC
         LIMIT 5
         FOR UPDATE SKIP LOCKED)
    RETURNING rq.*, r.is_enabled AS rule_enabled, r.conditions AS rule_conditions,
              r.text AS rule_text, r.text_mode, r.bonus_enabled, r.bonus_tiers,
              r.delay_days, r.attribution_days, sal.name AS salon_name,
              (SELECT cl.name FROM clients cl WHERE cl.id = rq.client_id) AS client_name`;

// Строки удалённых правил join не вернёт — они висели бы scheduled вечно.
const ORPHAN_SQL =
  `UPDATE reminder_queue SET status='cancelled', decision_reason='правило удалено'
    WHERE status='scheduled' AND rule_id IS NULL`;

let _tickInFlight = false;

async function processTick(deps = defaultDeps) {
  if (_tickInFlight) return;
  _tickInFlight = true;
  try {
    const d = { ...defaultDeps, ...deps };
    await d.db.query(ORPHAN_SQL).catch(e => d.log.error(`orphan cleanup: ${e.message}`));
    const rows = await d.db.any(LEASE_SQL, [RETRY_BACKOFF_S]);
    for (const row of rows) await processOne(row, d);
  } finally {
    _tickInFlight = false;
  }
}

let _running = false;
function startRemindersWorker() {
  if (_running) return;
  _running = true;
  if (!config.CHATPUSH.instanceToken) {
    log.warn('CHATPUSH_INSTANCE_TOKEN is not set — reminders worker disabled');
    return;
  }
  setInterval(() => { processTick().catch(e => log.error(`tick: ${e.message}`)); }, WORKER_TICK_MS);
  log.info(`Reminders worker started (tick=${WORKER_TICK_MS}ms)`);
}

module.exports = {
  processOne, processTick, startRemindersWorker, defaultDeps,
  LEASE_SQL, ORPHAN_SQL, MAX_OPERATOR_DEFERS,
};
```

- [ ] **Step 4: Убедиться, что тесты гейтов проходят**

```bash
cd /root/loyalpro/backend && npx jest reminders-worker --silent
```

Ожидается: PASS, 13 тестов.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/reminders/worker.js backend/reminders-worker.test.js && git commit -m "feat(reminders): воркер — аренда очереди и детерминированные гейты"
```

---

## Task 10: Воркер — тесты отправки, бонусов и at-most-once

**Files:**
- Modify: `backend/reminders-worker.test.js` (дописать блок в конец)

- [ ] **Step 1: Дописать тесты отправки**

В конец `backend/reminders-worker.test.js` добавить:

```js
describe('отправка и бонусы', () => {
  test('happy path: текст по ступени, бонусы записаны, флаг повешен', async () => {
    const { updates, deps } = makeDeps();
    await worker.processOne(ROW, deps);
    expect(deps.applyBonus).toHaveBeenCalledWith(1, 777, ROW.bonus_tiers, ROW.rule_title);
    expect(deps.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      phone: '79200255591',
      text: 'Мария, начислили 300 бонусов!',
    }));
    expect(deps.mute).toHaveBeenCalledWith(1, 5, '79200255591', expect.any(String));
    expect(find(updates, /bonus_accrued=\$4/).length).toBe(1);
  });

  // Захват строки условным UPDATE — последний гейт перед side-effect'ами.
  test('перехваченная строка не отправляется и бонусы не начисляет', async () => {
    const { deps } = makeDeps({
      db: {
        any: jest.fn(async () => []),
        query: jest.fn(async (sql) => ({ rowCount: /SET status='sent'/.test(sql) ? 0 : 1 })),
        oneOrNone: jest.fn(async () => null),
      },
    });
    await worker.processOne(ROW, deps);
    expect(deps.applyBonus).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.mute).not.toHaveBeenCalled();
  });

  // Начисление необратимо: повторный заход по строке, где бонусы уже
  // записаны, обязан взять сохранённое значение, а не начислить второй раз.
  test('повторная попытка не начисляет бонусы дважды', async () => {
    const { deps } = makeDeps();
    const retried = { ...ROW, balance_before: 120, bonus_tier: 'accrue', bonus_accrued: 300, bonus_txn_ok: true };
    await worker.processOne(retried, deps);
    expect(deps.applyBonus).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Мария, начислили 300 бонусов!',
    }));
  });

  // Сбой отправки: строка возвращается в scheduled, бонусы НЕ откатываются
  // (утверждено: «сначала начислить, отката нет»), флаг анти-повтора не висит.
  test('сбой отправки возвращает строку в scheduled и не вешает флаг', async () => {
    const { updates, deps } = makeDeps({ sendMessage: jest.fn(async () => { throw new Error('chatpush 500'); }) });
    await worker.processOne(ROW, deps);
    expect(find(updates, /status='scheduled'/).length).toBe(1);
    expect(deps.mute).not.toHaveBeenCalled();
  });

  test('исчерпание попыток → failed', async () => {
    const { updates, deps } = makeDeps({ sendMessage: jest.fn(async () => { throw new Error('chatpush 500'); }) });
    await worker.processOne({ ...ROW, attempts: 3 }, deps);
    expect(find(updates, /status='failed'/).length).toBe(1);
  });

  // Доставлено, но упала пост-обработка — статус НЕ откатывать: ретрай = дубль.
  test('падение после доставки не откатывает статус', async () => {
    const { updates, deps } = makeDeps({ mute: jest.fn(async () => { throw new Error('db'); }) });
    await worker.processOne(ROW, deps);
    expect(find(updates, /status='scheduled'/).length).toBe(0);
    expect(deps.sendMessage).toHaveBeenCalled();
  });

  // Бонусов нет (нет карты / сбой YClients) — уходит БАЗОВЫЙ текст правила,
  // ни слова про бонусы. Это утверждённое поведение «слать без бонусов».
  test('no_bonus → базовый текст правила без бонусной части', async () => {
    const { deps } = makeDeps({
      applyBonus: jest.fn(async () => ({ balanceBefore: null, tier: 'no_bonus', accrued: 0, txnOk: null })),
    });
    await worker.processOne(ROW, deps);
    expect(deps.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Мария, пора повторить Лазерная эпиляция!',
    }));
  });

  test('bonus_enabled=false → YClients не дёргается вовсе', async () => {
    const { deps } = makeDeps();
    await worker.processOne({ ...ROW, bonus_enabled: false }, deps);
    expect(deps.applyBonus).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalled();
  });

  test('режим free зовёт LLM и шлёт её текст', async () => {
    const { deps } = makeDeps({
      createMessage: jest.fn(async () => ({ text: '{"action":"send","text":"Мария, будем рады видеть вас снова!","reason":"ок"}' })),
    });
    await worker.processOne({ ...ROW, text_mode: 'free' }, deps);
    expect(deps.createMessage).toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Мария, будем рады видеть вас снова!',
    }));
  });

  test('в режиме free решение «не слать» даёт skipped без отправки', async () => {
    const { updates, deps } = makeDeps({
      createMessage: jest.fn(async () => ({ text: '{"action":"skip","reason":"клиент просил не писать"}' })),
    });
    await worker.processOne({ ...ROW, text_mode: 'free' }, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(find(updates, /status='skipped'/).length).toBe(1);
  });

  test('reply-guard заблокировал текст → skipped', async () => {
    const { updates, deps } = makeDeps({ hardViolations: jest.fn(() => [{ type: 'internals_leak' }]) });
    await worker.processOne(ROW, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(find(updates, /status='skipped'/).length).toBe(1);
  });

  test('whatsapp дополнительно персистится в историю чата', async () => {
    const { deps } = makeDeps({ sendMessage: jest.fn(async () => ({ id: 1, channel: 'whatsapp' })) });
    await worker.processOne(ROW, deps);
    expect(deps.persistWhatsapp).toHaveBeenCalled();
  });
});

describe('processTick', () => {
  test('гасит строки удалённых правил', async () => {
    const { updates, deps } = makeDeps();
    await worker.processTick(deps);
    expect(updates.some(u => /rule_id IS NULL/.test(u.sql))).toBe(true);
  });
});
```

- [ ] **Step 2: Прогнать тесты**

```bash
cd /root/loyalpro/backend && npx jest reminders-worker --silent
```

Ожидается: PASS, 26 тестов.

- [ ] **Step 3: Живой EXPLAIN арендного SQL**

Юнит-моки `db.any` валидность SQL не проверяют. Через MCP PostgreSQL выполнить:

```sql
EXPLAIN UPDATE reminder_queue rq
    SET attempts = rq.attempts + 1, last_attempt_at = NOW()
   FROM reminder_rules r
   JOIN salons sal ON sal.id = r.salon_id
  WHERE r.id = rq.rule_id
    AND rq.id IN (
      SELECT id FROM reminder_queue
       WHERE status = 'scheduled' AND scheduled_at <= NOW()
         AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - make_interval(secs => 120))
       ORDER BY scheduled_at ASC
       LIMIT 5
       FOR UPDATE SKIP LOCKED)
  RETURNING rq.*, r.is_enabled AS rule_enabled, r.conditions AS rule_conditions,
            r.text AS rule_text, r.text_mode, r.bonus_enabled, r.bonus_tiers,
            r.delay_days, r.attribution_days, sal.name AS salon_name,
            (SELECT cl.name FROM clients cl WHERE cl.id = rq.client_id) AS client_name;
```

Ожидается: план запроса без ошибки. Если пришло `invalid reference to FROM-clause entry for table "rq"` — какая-то колонка уехала из `RETURNING` в `ON`-условие джойна, вернуть её в скалярный подзапрос.

- [ ] **Step 4: Запустить воркер в `server.js`**

В `backend/server.js` рядом со строкой `require('./services/care/worker').startCareWorker();` (строка 258) добавить следующей строкой:

```js
      require('./services/reminders/worker').startRemindersWorker();
```

- [ ] **Step 5: Проверить старт**

```bash
cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro --update-env && sleep 6 && pm2 logs loyalpro --lines 30 --nostream | grep -i remind
```

Ожидается строка `Reminders worker started (tick=60000ms)`.

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro && git add backend/reminders-worker.test.js backend/server.js && git commit -m "feat(reminders): отправка с бонусами, at-most-once и запуск воркера"
```

---

## Task 11: Догон по базе — отбор и раскладка по дням

**Files:**
- Create: `backend/services/reminders/backfill.js`
- Test: `backend/reminders-backfill.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/reminders-backfill.test.js`:

```js
'use strict';
// Догон: «кому ушло бы напоминание, если бы правило работало последние N дней».
// Планирование чисто событийное, бэкфилла нет — без этой ручки только что
// созданное правило выглядит сломанным (очередь пуста, и непонятно, условия
// кривые или подходящих визитов не было).
const { matchBackfillVisits, spreadOverDays } = require('./services/reminders/backfill');

const CAT_MAP = new Map([['101', '9'], ['200', '7']]);
const COND = { logic: 'and', items: [{ type: 'category', ids: [9] }] };
const NOW = Date.parse('2026-08-07T09:00:00+03:00');

const visit = (over = {}) => ({
  id: 1, date: '2026-07-08 14:00:00', attendance: 1,
  client: { id: 42, phone: '79200255591', name: 'Мария' },
  staff: { id: 55, name: 'Юлия' },
  services: [{ id: 101, title: 'Лазерная эпиляция' }],
  ...over,
});

const run = (records, over = {}) => matchBackfillVisits({
  records, conditions: COND, catMap: CAT_MAP,
  blacklisted: new Set(), mutedPhones: new Set(), queuedRecordIds: new Set(),
  nowMs: NOW, ...over,
});

test('подходящий состоявшийся визит попадает в выборку', () => {
  const out = run([visit()]);
  expect(out.rows).toHaveLength(1);
  expect(out.rows[0].skipReason).toBeNull();
  expect(out.totals.willSend).toBe(1);
});

test('несостоявшийся визит не попадает вовсе', () => {
  expect(run([visit({ attendance: 0 })]).rows).toHaveLength(0);
});

test('визит вне условий не попадает вовсе', () => {
  expect(run([visit({ services: [{ id: 200, title: 'Другое' }] })]).rows).toHaveLength(0);
});

test('нет телефона → no_phone', () => {
  const out = run([visit({ client: { id: 42, phone: '', name: 'М' } })]);
  expect(out.rows[0].skipReason).toBe('no_phone');
});

test('чёрный список → blacklist', () => {
  const out = run([visit()], { blacklisted: new Set(['79200255591']) });
  expect(out.rows[0].skipReason).toBe('blacklist');
});

test('флаг анти-повтора → muted', () => {
  const out = run([visit()], { mutedPhones: new Set(['79200255591']) });
  expect(out.rows[0].skipReason).toBe('muted');
});

test('визит уже в очереди → already_queued', () => {
  const out = run([visit()], { queuedRecordIds: new Set(['1']) });
  expect(out.rows[0].skipReason).toBe('already_queued');
});

// Будущие записи приходят тем же сводным запросом /records — отдельных
// вызовов YClients на каждого клиента не делаем.
test('есть будущая запись под условия → future_booking', () => {
  const future = visit({ id: 2, date: '2026-08-20 14:00:00', attendance: 0 });
  const out = run([visit(), future]);
  const row = out.rows.find(r => r.recordId === 1);
  expect(row.skipReason).toBe('future_booking');
});

test('будущая запись на чужую услугу не мешает', () => {
  const future = visit({ id: 2, date: '2026-08-20 14:00:00', attendance: 0, services: [{ id: 200, title: 'Другое' }] });
  expect(run([visit(), future]).rows.find(r => r.recordId === 1).skipReason).toBeNull();
});

// Из нескольких визитов клиента напоминание ушло бы только от самого позднего.
test('ранний визит того же клиента → superseded', () => {
  const later = visit({ id: 2, date: '2026-07-20 14:00:00' });
  const out = run([visit(), later]);
  expect(out.rows.find(r => r.recordId === 2).skipReason).toBeNull();
  expect(out.rows.find(r => r.recordId === 1).skipReason).toBe('superseded');
});

describe('spreadOverDays', () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ recordId: i + 1 }));

  test('кап соблюдается: 70 строк по 30 в день → 3 дня', () => {
    const out = spreadOverDays(rows(70), { maxPerDay: 30, sendTime: '11:00', nowMs: NOW });
    const byDay = new Map();
    for (const r of out) {
      const k = r.scheduledAt.toISOString().slice(0, 10);
      byDay.set(k, (byDay.get(k) || 0) + 1);
    }
    expect([...byDay.values()]).toEqual([30, 30, 10]);
  });

  test('время отправки — send_time правила по Москве', () => {
    const out = spreadOverDays(rows(1), { maxPerDay: 30, sendTime: '11:00', nowMs: NOW });
    expect(out[0].scheduledAt.toISOString()).toBe('2026-08-07T08:00:00.000Z');
  });

  // Время сегодня уже прошло — начинаем с завтра, иначе строка встанет в
  // прошлое и воркер выстрелит ей немедленно, минуя кап.
  test('если send_time сегодня уже прошло — старт с завтра', () => {
    const late = Date.parse('2026-08-07T20:00:00+03:00');
    const out = spreadOverDays(rows(1), { maxPerDay: 30, sendTime: '11:00', nowMs: late });
    expect(out[0].scheduledAt.toISOString()).toBe('2026-08-08T08:00:00.000Z');
  });

  test('нулевой или отрицательный кап трактуется как 1', () => {
    const out = spreadOverDays(rows(2), { maxPerDay: 0, sendTime: '11:00', nowMs: NOW });
    expect(out[0].scheduledAt.toISOString().slice(0, 10)).not.toBe(out[1].scheduledAt.toISOString().slice(0, 10));
  });

  test('пустой список → пустой результат', () => {
    expect(spreadOverDays([], { maxPerDay: 30, sendTime: '11:00', nowMs: NOW })).toEqual([]);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd /root/loyalpro/backend && npx jest reminders-backfill --silent
```

Ожидается: FAIL, `Cannot find module './services/reminders/backfill'`.

- [ ] **Step 3: Реализовать модуль**

Создать `backend/services/reminders/backfill.js`:

```js
'use strict';
// Разовый догон по базе: «кому ушло бы напоминание, если бы правило работало
// последние N дней». Чистые функции — ни БД, ни сети (сеть в routes/reminders.js).
//
// Нужен потому, что планирование ЧИСТО СОБЫТИЙНОЕ: у только что созданного
// правила очередь пуста, и без превью не отличить «условия кривые» от
// «подходящих визитов ещё не было».
//
// Отбор гоняет ТОТ ЖЕ evaluateRule и тот же критерий «визит состоялся», что и
// боевое планирование (services/reminders/enroll.js). Расхождение — это баг:
// правки условий обязаны идти в оба места.
//
// Будущие записи берутся из ТОЙ ЖЕ сводной выдачи /records (вызывающий тянет
// диапазон, захватывающий будущее) — по отдельному запросу на каждого клиента
// догон по базе в сотни человек стоил бы сотни обращений к YClients.

const { evaluateRule } = require('../notifications');
const { normalizePhoneKey } = require('../agent-gate');
const { parseVisitAt, computeScheduledAt } = require('../care/schedule');
const { isVisitCompleted } = require('../care/enroll');
const { recordContext } = require('./eligibility');

/**
 * @returns {{ totals: object, rows: object[] }}
 * skipReason: null | 'no_phone' | 'blacklist' | 'muted' | 'already_queued'
 *             | 'future_booking' | 'superseded'
 */
function matchBackfillVisits({ records = [], conditions, catMap = new Map(),
                               blacklisted = new Set(), mutedPhones = new Set(),
                               queuedRecordIds = new Set(), nowMs = Date.now() } = {}) {
  const matches = (r) => {
    try { return evaluateRule(conditions, recordContext(r, catMap)); } catch { return false; }
  };

  // Телефоны, у которых есть БУДУЩАЯ запись под условия правила.
  const busy = new Set();
  for (const r of records) {
    if (!r || r.deleted) continue;
    if (Number(r.attendance) === -1) continue;
    const at = parseVisitAt(r.date);
    if (!at || at.getTime() < nowMs) continue;
    if (!matches(r)) continue;
    const p = normalizePhoneKey(r.client && r.client.phone);
    if (p) busy.add(p);
  }

  const rows = [];
  let completed = 0;
  for (const r of records) {
    if (!r || r.id == null) continue;
    if (!isVisitCompleted(r)) continue;
    completed++;
    if (!matches(r)) continue;

    const phone = normalizePhoneKey(r.client && r.client.phone);
    const visitAt = parseVisitAt(r.date);
    let skipReason = null;
    if (!phone) skipReason = 'no_phone';
    else if (blacklisted.has(phone)) skipReason = 'blacklist';
    else if (mutedPhones.has(phone)) skipReason = 'muted';
    else if (queuedRecordIds.has(String(r.id))) skipReason = 'already_queued';
    else if (busy.has(phone)) skipReason = 'future_booking';

    rows.push({
      recordId: r.id,
      phone: phone || null,
      ycClientId: (r.client && r.client.id) || null,
      clientName: (r.client && r.client.name) || '',
      visitAt: visitAt ? visitAt.toISOString() : null,
      visitMs: visitAt ? visitAt.getTime() : 0,
      staffName: (r.staff && r.staff.name) || '',
      services: (Array.isArray(r.services) ? r.services : [])
        .map(s => ({ id: s && s.id, title: s && s.title })).filter(s => s.title),
      skipReason,
    });
  }

  // Свежие визиты сверху; из нескольких визитов клиента напоминание ушло бы
  // только от САМОГО ПОЗДНЕГО (боевое планирование supersede'ит прежние).
  rows.sort((a, b) => b.visitMs - a.visitMs || Number(b.recordId) - Number(a.recordId));
  const seen = new Set();
  for (const row of rows) {
    if (row.skipReason) continue;
    if (seen.has(row.phone)) row.skipReason = 'superseded';
    else seen.add(row.phone);
  }
  for (const row of rows) delete row.visitMs;

  const willSend = rows.filter(r => !r.skipReason).length;
  return {
    totals: { records: records.length, completed, matched: rows.length, willSend,
              clients: seen.size, excluded: rows.length - willSend },
    rows,
  };
}

/**
 * Раскладка по ближайшим дням с капом: веерная рассылка сотне клиентов в одну
 * минуту исключена по построению. Старт — сегодня в send_time, а если это
 * время уже прошло, то завтра: строка в прошлом ушла бы немедленно, минуя кап.
 */
function spreadOverDays(rows, { maxPerDay = 30, sendTime = '11:00', nowMs = Date.now() } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];
  const cap = Math.max(1, Math.floor(Number(maxPerDay) || 1));
  const now = new Date(nowMs);
  const today = computeScheduledAt(now, 0, sendTime);
  const startOffset = today && today.getTime() > nowMs ? 0 : 1;

  return list.map((row, i) => ({
    ...row,
    scheduledAt: computeScheduledAt(now, startOffset + Math.floor(i / cap), sendTime),
  }));
}

module.exports = { matchBackfillVisits, spreadOverDays };
```

- [ ] **Step 4: Убедиться, что тесты проходят**

```bash
cd /root/loyalpro/backend && npx jest reminders-backfill --silent
```

Ожидается: PASS, 15 тестов.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/reminders/backfill.js backend/reminders-backfill.test.js && git commit -m "feat(reminders): догон по базе — отбор визитов и раскладка по дням"
```

---

## Task 12: HTTP API `/api/reminders`

**Files:**
- Create: `backend/routes/reminders.js`
- Modify: `backend/routes/index.js:68` (рядом с монтированием `/api/care`)

- [ ] **Step 1: Создать роутер**

Создать `backend/routes/reminders.js`:

```js
// ============================================================
// Напоминания о повторном визите (вкладки страницы «Забота»)
// ============================================================
//
// Mounted at /api/reminders. owner/admin only (глобальный гейт в
// routes/index.js: /api/reminders не входит в SPECIALIST/CASHIER_ALLOWED_PREFIXES).
//
//   GET    /rules                       правила со счётчиками
//   POST   /rules                       создать
//   PUT    /rules/:id                   обновить
//   POST   /rules/:id/toggle            вкл/выкл
//   DELETE /rules/:id                   удалить (история остаётся: rule_id → NULL)
//   POST   /rules/:id/backfill/preview  превью догона
//   POST   /rules/:id/backfill          выполнить догон
//   POST   /queue/:id/cancel            отменить запланированную
//   GET    /history                     журнал с фильтрами (включая scheduled)
//   POST   /suppressions/toggle         ручной тумблер анти-повтора
//
// ВНИМАНИЕ: поля JWT — req.user.salonId и req.user.userId (НЕ salon_id).
const router = require('express').Router();
const { auth, requireRole } = require('../middleware/auth');
const { db } = require('../db');
const { createLogger } = require('../logger');
const { ycGet } = require('../services/yclients');
const { getServiceCategoryMap } = require('../services/notifications');
const { normalizePhoneKey } = require('../services/agent-gate');
const { matchBackfillVisits, spreadOverDays } = require('../services/reminders/backfill');
const { TIER_ACTIONS } = require('../services/reminders/tiers');

const log = createLogger('Reminders');
const guard = [auth, requireRole('owner', 'admin')];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const TEXT_MODES = ['free', 'strict'];
const PAGE = 200;
const MAX_PAGES = 25;                 // 5000 записей — потолок одного догона

/** 'YYYY-MM-DD' московской даты (как в care/preview.js). */
function mskDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d);
}

/** Валидация тела правила → { error } | { value }. */
function parseRuleBody(body) {
  const b = body || {};
  const title = String(b.title || '').trim();
  if (!title) return { error: 'Название обязательно' };
  if (title.length > 255) return { error: 'Название слишком длинное' };

  const c = b.conditions || {};
  const logic = c.logic === 'or' ? 'or' : 'and';
  const items = (Array.isArray(c.items) ? c.items : [])
    .filter(it => it && ['staff', 'category', 'service'].includes(it.type))
    .map(it => ({ type: it.type, ids: (Array.isArray(it.ids) ? it.ids : []).map(Number).filter(Number.isFinite) }))
    .filter(it => it.ids.length);
  if (!items.length) return { error: 'Нужно хотя бы одно условие: без него напоминание уйдёт после ЛЮБОГО визита' };

  const delay = Number(b.delayDays);
  if (!Number.isInteger(delay) || delay < 1 || delay > 730) return { error: 'Задержка 1–730 дней' };

  const text = String(b.text || '').trim();
  if (!text) return { error: 'Текст напоминания пуст' };
  if (text.length > 2000) return { error: 'Текст слишком длинный' };

  const attributionDays = Number(b.attributionDays);
  if (!Number.isInteger(attributionDays) || attributionDays < 1 || attributionDays > 365) {
    return { error: 'Окно атрибуции 1–365 дней' };
  }
  const cap = Number(b.backfillMaxPerDay);
  if (!Number.isInteger(cap) || cap < 1 || cap > 500) return { error: 'Кап догона 1–500 в день' };

  // Ступени бонусов: суммы уходят реальными деньгами на карту клиента,
  // поэтому валидация недоверчивая — неизвестное действие отвергаем, а не
  // молча игнорируем.
  const rawTiers = Array.isArray(b.bonusTiers) ? b.bonusTiers : [];
  const tiers = [];
  for (const [i, t] of rawTiers.entries()) {
    if (!t || !TIER_ACTIONS.includes(t.action)) return { error: `Ступень ${i + 1}: неизвестное действие` };
    const upTo = t.upTo === null || t.upTo === undefined || t.upTo === '' ? null : Number(t.upTo);
    if (upTo !== null && (!Number.isFinite(upTo) || upTo < 0)) return { error: `Ступень ${i + 1}: неверный порог` };
    const amount = Math.max(0, Math.round(Number(t.amount) || 0));
    if (t.action === 'accrue' && amount <= 0) return { error: `Ступень ${i + 1}: сумма начисления должна быть больше нуля` };
    if (amount > 100000) return { error: `Ступень ${i + 1}: сумма начисления слишком велика` };
    tiers.push({ up_to: upTo, action: t.action, amount, text: String(t.text || '').slice(0, 2000) });
  }
  if (b.bonusEnabled && !tiers.length) return { error: 'Бонусы включены, но ни одной ступени не задано' };

  return { value: {
    title,
    conditions: { logic, items },
    delayDays: delay,
    sendTime: TIME_RE.test(String(b.sendTime || '')) ? b.sendTime : '11:00',
    textMode: TEXT_MODES.includes(b.textMode) ? b.textMode : 'strict',
    text,
    attributionDays,
    bonusEnabled: !!b.bonusEnabled,
    bonusTiers: tiers,
    backfillMaxPerDay: cap,
  } };
}

const RULE_COLUMNS = `
  id, title, is_enabled AS "isEnabled", conditions, delay_days AS "delayDays",
  send_time AS "sendTime", text_mode AS "textMode", text,
  attribution_days AS "attributionDays", bonus_enabled AS "bonusEnabled",
  bonus_tiers AS "bonusTiers", backfill_max_per_day AS "backfillMaxPerDay",
  created_at AS "createdAt"`;

// GET /rules — правила со счётчиками очереди, отправок и конверсии.
router.get('/rules', guard, async (req, res) => {
  try {
    const rows = await db.any(
      `SELECT ${RULE_COLUMNS},
              (SELECT count(*) FROM reminder_queue q
                WHERE q.rule_id = r.id AND q.status = 'scheduled')::int AS "queuedCount",
              (SELECT count(*) FROM reminder_queue q
                WHERE q.rule_id = r.id AND q.status = 'sent')::int AS "sentCount",
              (SELECT count(*) FROM reminder_queue q
                WHERE q.rule_id = r.id AND q.conversion_record_id IS NOT NULL)::int AS "convertedCount",
              (SELECT count(*) FROM reminder_queue q
                WHERE q.rule_id = r.id AND q.visited_at IS NOT NULL)::int AS "visitedCount",
              (SELECT COALESCE(sum(q.bonus_accrued), 0) FROM reminder_queue q
                WHERE q.rule_id = r.id)::int AS "bonusTotal"
         FROM reminder_rules r
        WHERE r.salon_id = $1
        ORDER BY r.created_at DESC`,
      [req.user.salonId]);
    res.json({ rules: rows });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Не удалось загрузить правила' }); }
});

router.post('/rules', guard, async (req, res) => {
  const parsed = parseRuleBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.value;
  try {
    const row = await db.one(
      `INSERT INTO reminder_rules
         (salon_id, title, conditions, delay_days, send_time, text_mode, text,
          attribution_days, bonus_enabled, bonus_tiers, backfill_max_per_day, created_by)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
       RETURNING ${RULE_COLUMNS}`,
      [req.user.salonId, v.title, JSON.stringify(v.conditions), v.delayDays, v.sendTime,
       v.textMode, v.text, v.attributionDays, v.bonusEnabled, JSON.stringify(v.bonusTiers),
       v.backfillMaxPerDay, req.user.userId]);
    res.json({ rule: row });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Не удалось создать правило' }); }
});

router.put('/rules/:id', guard, async (req, res) => {
  const parsed = parseRuleBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.value;
  try {
    const row = await db.oneOrNone(
      `UPDATE reminder_rules
          SET title=$3, conditions=$4::jsonb, delay_days=$5, send_time=$6, text_mode=$7,
              text=$8, attribution_days=$9, bonus_enabled=$10, bonus_tiers=$11::jsonb,
              backfill_max_per_day=$12, updated_at=NOW()
        WHERE id=$1 AND salon_id=$2
        RETURNING ${RULE_COLUMNS}`,
      [req.params.id, req.user.salonId, v.title, JSON.stringify(v.conditions), v.delayDays,
       v.sendTime, v.textMode, v.text, v.attributionDays, v.bonusEnabled,
       JSON.stringify(v.bonusTiers), v.backfillMaxPerDay]);
    if (!row) return res.status(404).json({ error: 'Правило не найдено' });
    // rule_title в очереди денормализован ради истории — синхронизируем.
    await db.query(`UPDATE reminder_queue SET rule_title=$2 WHERE rule_id=$1`, [req.params.id, v.title]);
    res.json({ rule: row });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Не удалось сохранить правило' }); }
});

router.post('/rules/:id/toggle', guard, async (req, res) => {
  try {
    const row = await db.oneOrNone(
      `UPDATE reminder_rules SET is_enabled = NOT is_enabled, updated_at=NOW()
        WHERE id=$1 AND salon_id=$2 RETURNING id, is_enabled AS "isEnabled"`,
      [req.params.id, req.user.salonId]);
    if (!row) return res.status(404).json({ error: 'Правило не найдено' });
    res.json(row);
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Не удалось переключить правило' }); }
});

// DELETE — история НЕ удаляется: rule_id уходит в NULL (ON DELETE SET NULL),
// rule_title в строках остаётся. Запланированные строки гасит воркер (ORPHAN_SQL).
router.delete('/rules/:id', guard, async (req, res) => {
  try {
    const row = await db.oneOrNone(
      `DELETE FROM reminder_rules WHERE id=$1 AND salon_id=$2 RETURNING id`,
      [req.params.id, req.user.salonId]);
    if (!row) return res.status(404).json({ error: 'Правило не найдено' });
    res.json({ ok: true });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Не удалось удалить правило' }); }
});

/** Общая подготовка догона: тянет записи и считает выборку (ничего не пишет). */
async function buildBackfill(salonId, ruleId, days) {
  const rule = await db.oneOrNone(
    `SELECT * FROM reminder_rules WHERE id=$1 AND salon_id=$2`, [ruleId, salonId]);
  if (!rule) return { error: 'Правило не найдено', code: 404 };

  const salon = await db.one(
    `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
       FROM salons WHERE id=$1`, [salonId]);
  if (!salon.yclients_company_id) return { error: 'У салона не настроен YClients', code: 400 };

  const nowMs = Date.now();
  // Диапазон захватывает и будущее: будущие записи нужны, чтобы отсеять уже
  // записавшихся клиентов, и брать их отдельным запросом на каждого нельзя.
  const startDate = mskDate(new Date(nowMs - days * 86400000));
  const endDate = mskDate(new Date(nowMs + 90 * 86400000));
  let records = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const chunk = await ycGet(salon, `/records/${salon.yclients_company_id}`,
      { start_date: startDate, end_date: endDate, page, count: PAGE });
    if (!Array.isArray(chunk) || !chunk.length) break;
    records = records.concat(chunk);
    if (chunk.length < PAGE) break;
  }

  const catMap = await getServiceCategoryMap(salon).catch(() => new Map());
  const bl = await db.any(
    `SELECT phone FROM clients WHERE salon_id=$1 AND is_blacklisted = TRUE AND phone IS NOT NULL`,
    [salonId]);
  const muted = await db.any(
    `SELECT phone FROM reminder_suppressions WHERE rule_id=$1 AND muted = TRUE`, [ruleId]);
  const queued = await db.any(
    `SELECT anchor_record_id FROM reminder_queue WHERE rule_id=$1`, [ruleId]);

  const out = matchBackfillVisits({
    records,
    conditions: rule.conditions,
    catMap,
    blacklisted: new Set(bl.map(r => normalizePhoneKey(r.phone)).filter(Boolean)),
    mutedPhones: new Set(muted.map(r => r.phone)),
    queuedRecordIds: new Set(queued.map(r => String(r.anchor_record_id))),
    nowMs,
  });
  return { rule, out, catMapFailed: catMap.size === 0, startDate, endDate };
}

router.post('/rules/:id/backfill/preview', guard, async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.body && req.body.days) || 30));
  try {
    const r = await buildBackfill(req.user.salonId, req.params.id, days);
    if (r.error) return res.status(r.code).json({ error: r.error });
    const planned = spreadOverDays(r.out.rows.filter(x => !x.skipReason), {
      maxPerDay: r.rule.backfill_max_per_day, sendTime: r.rule.send_time });
    res.json({
      totals: r.out.totals, rows: r.out.rows, days,
      catMapFailed: r.catMapFailed,
      lastScheduledAt: planned.length ? planned[planned.length - 1].scheduledAt : null,
    });
  } catch (e) { log.error(e.message); res.status(500).json({ error: `Не удалось построить выборку: ${e.message}` }); }
});

router.post('/rules/:id/backfill', guard, async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.body && req.body.days) || 30));
  try {
    const r = await buildBackfill(req.user.salonId, req.params.id, days);
    if (r.error) return res.status(r.code).json({ error: r.error });
    const planned = spreadOverDays(r.out.rows.filter(x => !x.skipReason), {
      maxPerDay: r.rule.backfill_max_per_day, sendTime: r.rule.send_time });

    let queued = 0;
    for (const row of planned) {
      if (!row.scheduledAt) continue;
      const client = await db.oneOrNone(
        `SELECT id FROM clients WHERE salon_id=$1 AND (yclients_client_id=$2 OR phone=$3) LIMIT 1`,
        [req.user.salonId, row.ycClientId, row.phone]);
      const ins = await db.query(
        `INSERT INTO reminder_queue
           (salon_id, rule_id, rule_title, client_id, phone, yclients_client_id,
            anchor_record_id, anchor_visit_at, anchor_staff_name, anchor_services,
            scheduled_at, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,'backfill')
         ON CONFLICT (rule_id, anchor_record_id) DO NOTHING`,
        [req.user.salonId, r.rule.id, r.rule.title, client ? client.id : null, row.phone,
         row.ycClientId, row.recordId, row.visitAt, row.staffName || null,
         JSON.stringify(row.services), row.scheduledAt]);
      queued += (ins && ins.rowCount) || 0;
    }
    log.info(`догон правила #${r.rule.id}: поставлено ${queued} из ${planned.length}`);
    res.json({ queued, planned: planned.length, totals: r.out.totals });
  } catch (e) { log.error(e.message); res.status(500).json({ error: `Не удалось выполнить догон: ${e.message}` }); }
});

const QUEUE_COLUMNS = `
  q.id, q.rule_id AS "ruleId", q.rule_title AS "ruleTitle", q.phone,
  q.scheduled_at AS "scheduledAt", q.status, q.decision_reason AS "reason",
  q.rendered_text AS "text", q.sent_at AS "sentAt", q.channel_used AS "channel",
  q.balance_before AS "balanceBefore", q.bonus_tier AS "bonusTier",
  q.bonus_accrued AS "bonusAccrued", q.bonus_txn_ok AS "bonusTxnOk",
  q.conversion_record_id AS "conversionRecordId", q.converted_at AS "convertedAt",
  q.visited_at AS "visitedAt", q.source, q.anchor_services AS "anchorServices",
  q.anchor_visit_at AS "anchorVisitAt", c.name AS "clientName",
  EXISTS (SELECT 1 FROM reminder_suppressions s
           WHERE s.rule_id = q.rule_id AND s.phone = q.phone AND s.muted = TRUE) AS "muted"`;

// Отдельной вкладки «очередь» нет: запланированные строки видны в истории по
// фильтру статуса «Запланировано», оттуда же их можно отменить.
router.post('/queue/:id/cancel', guard, async (req, res) => {
  try {
    const row = await db.oneOrNone(
      `UPDATE reminder_queue SET status='cancelled', decision_reason='отменено вручную'
        WHERE id=$1 AND salon_id=$2 AND status='scheduled' RETURNING id`,
      [req.params.id, req.user.salonId]);
    if (!row) return res.status(404).json({ error: 'Строка не найдена или уже обработана' });
    res.json({ ok: true });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Не удалось отменить' }); }
});

router.get('/history', guard, async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const ruleId = req.query.ruleId ? Number(req.query.ruleId) : null;
  const status = req.query.status || null;
  const converted = req.query.converted === '1' ? true : (req.query.converted === '0' ? false : null);
  try {
    const rows = await db.any(
      `SELECT ${QUEUE_COLUMNS}
         FROM reminder_queue q LEFT JOIN clients c ON c.id = q.client_id
        WHERE q.salon_id = $1
          AND ($2::int  IS NULL OR q.rule_id = $2)
          AND ($3::text IS NULL OR q.status  = $3)
          AND ($4::bool IS NULL OR (q.conversion_record_id IS NOT NULL) = $4)
        ORDER BY COALESCE(q.sent_at, q.scheduled_at) DESC
        LIMIT $5 OFFSET $6`,
      [req.user.salonId, ruleId, status, converted, limit, offset]);
    res.json({ rows, limit, offset });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Не удалось загрузить историю' }); }
});

// Ручной тумблер анти-повтора по паре клиент+правило.
router.post('/suppressions/toggle', guard, async (req, res) => {
  const ruleId = Number(req.body && req.body.ruleId);
  const phone = normalizePhoneKey(req.body && req.body.phone);
  const muted = !!(req.body && req.body.muted);
  if (!Number.isFinite(ruleId) || !phone) return res.status(400).json({ error: 'Нужны ruleId и phone' });
  try {
    const rule = await db.oneOrNone(
      `SELECT id FROM reminder_rules WHERE id=$1 AND salon_id=$2`, [ruleId, req.user.salonId]);
    if (!rule) return res.status(404).json({ error: 'Правило не найдено' });
    await db.query(
      `INSERT INTO reminder_suppressions (salon_id, rule_id, phone, muted, reason, source, muted_at, reset_at, updated_at)
       VALUES ($1,$2,$3,$4,'изменено вручную','manual',
               CASE WHEN $4 THEN NOW() END, CASE WHEN $4 THEN NULL ELSE NOW() END, NOW())
       ON CONFLICT (rule_id, phone) DO UPDATE
         SET muted=$4, reason='изменено вручную', source='manual',
             muted_at = CASE WHEN $4 THEN NOW() ELSE reminder_suppressions.muted_at END,
             reset_at = CASE WHEN $4 THEN NULL ELSE NOW() END,
             updated_at = NOW()`,
      [req.user.salonId, ruleId, phone, muted]);
    res.json({ ok: true, muted });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Не удалось изменить флаг' }); }
});

module.exports = router;
```

- [ ] **Step 2: Смонтировать роутер**

В `backend/routes/index.js` после строки `app.use('/api/care', require('./care'));` добавить:

```js
  app.use('/api/reminders',         require('./reminders'));
```

- [ ] **Step 3: Проверить, что сервер поднимается и API отвечает**

```bash
cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro --update-env && sleep 6 && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/api/reminders/rules
```

Ожидается: `401` (роут смонтирован, JWT не передан). `404` означает, что монтирование не сработало.

- [ ] **Step 4: Прогнать полный CRUD живьём**

Получить токен и создать правило (подставить логин/пароль дев-владельца):

```bash
cd /root/loyalpro/backend && TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])') && \
curl -s -X POST http://localhost:3001/api/reminders/rules -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"title":"Тест","conditions":{"logic":"and","items":[{"type":"category","ids":[1]}]},"delayDays":30,"sendTime":"11:00","textMode":"strict","text":"{first_name}, пора повторить!","attributionDays":30,"backfillMaxPerDay":30,"bonusEnabled":false,"bonusTiers":[]}' | head -c 400; echo; \
curl -s http://localhost:3001/api/reminders/rules -H "Authorization: Bearer $TOKEN" | head -c 400
```

Ожидается: JSON созданного правила, затем список с ним и нулевыми счётчиками. Удалить тестовое правило после проверки тем же токеном через `DELETE /api/reminders/rules/<id>`.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/routes/reminders.js backend/routes/index.js && git commit -m "feat(reminders): HTTP API правил, очереди, истории и догона"
```

---

## Task 13: Вынести конструктор условий из `care.js`

Конструктор условий нужен обеим вкладкам. Копировать 90 строк во второй файл нельзя — правка фильтра или лимита в 150 опций тут же разъедется между копиями.

**Files:**
- Create: `frontend/js/pages/conditions-editor.js`
- Modify: `frontend/js/pages/care.js:192-286` (заменить тела функций делегациями)
- Modify: `frontend/index.html:2229` (подключить новый файл ДО `care.js`)

- [ ] **Step 1: Создать общий модуль**

Создать `frontend/js/pages/conditions-editor.js`:

```js
// ── Конструктор условий «мастер / категория / услуга» ─────────────
// Общий для «Заботы» и «Напоминаний о повторном визите»: обе вкладки отбирают
// визиты одним и тем же форматом conditions ({logic, items}), который на
// бэкенде разбирает общий evaluateRule. Второй копии этого кода быть не должно —
// правка фильтра или лимита опций разъехалась бы между вкладками.
//
// Экземпляр адресуется префиксом ns. Требуемая разметка на странице:
//   #<ns>Conds       — контейнер списка условий
//   #<ns>LogicWrap   — обёртка переключателя И/ИЛИ (прячется при одном условии)
//   #<ns>Logic-and, #<ns>Logic-or — кнопки переключателя
//
// Зависимости страницы: esc(), escAttr() из core/utils.js.

const COND_LABELS = { staff: 'Специалист', category: 'Категория', service: 'Услуга' };
const _condEditors = {};                 // ns → { conds, logic, dicts }

/** Создать (или пересоздать) редактор. dicts — ответ /api/notification-rules/dictionaries. */
function condInit(ns, dicts) {
  _condEditors[ns] = { conds: [], logic: 'and', dicts: dicts || null };
}

/** Загрузить условия в редактор ({logic, items} с бэкенда). */
function condSet(ns, conditions) {
  const st = _condEditors[ns];
  if (!st) return;
  const c = conditions || {};
  st.logic = c.logic === 'or' ? 'or' : 'and';
  st.conds = (Array.isArray(c.items) ? c.items : []).map(it => ({
    type: ['staff', 'category', 'service'].includes(it.type) ? it.type : 'service',
    ids: new Set((it.ids || []).map(String)),
    filter: '',
  }));
  condRender(ns);
  condSetLogic(ns, st.logic);
}

/** Выгрузить условия для отправки на бэкенд. Пустые условия отбрасываются. */
function condGet(ns) {
  const st = _condEditors[ns];
  if (!st) return { logic: 'and', items: [] };
  return {
    logic: st.logic,
    items: st.conds.filter(c => c.ids.size)
      .map(c => ({ type: c.type, ids: [...c.ids].map(Number).filter(n => !isNaN(n)) })),
  };
}

function condSetLogic(ns, logic) {
  const st = _condEditors[ns];
  if (!st) return;
  st.logic = logic === 'or' ? 'or' : 'and';
  const and = document.getElementById(`${ns}Logic-and`);
  const or = document.getElementById(`${ns}Logic-or`);
  if (and) and.classList.toggle('on', st.logic === 'and');
  if (or) or.classList.toggle('on', st.logic === 'or');
}

function condAdd(ns) {
  _condEditors[ns].conds.push({ type: 'service', ids: new Set(), filter: '' });
  condRender(ns);
}

function condRemove(ns, i) {
  _condEditors[ns].conds.splice(i, 1);
  condRender(ns);
}

function condType(ns, i, type) {
  const c = _condEditors[ns].conds[i];
  c.type = type; c.ids = new Set(); c.filter = '';
  condRender(ns);
}

function condFilter(ns, i, value) {
  _condEditors[ns].conds[i].filter = value;
  condRenderList(ns, i);
}

function condToggleId(ns, i, id, checked) {
  const c = _condEditors[ns].conds[i];
  if (checked) c.ids.add(String(id)); else c.ids.delete(String(id));
  const cnt = document.getElementById(`${ns}CondCount-${i}`);
  if (cnt) cnt.textContent = `выбрано: ${c.ids.size}`;
}

function condOptions(ns, type) {
  const d = _condEditors[ns] && _condEditors[ns].dicts;
  if (!d) return [];
  if (type === 'staff') {
    return (d.staff || []).map(s => ({
      id: s.id, label: s.name + (s.specialization ? ` — ${s.specialization}` : ''),
    }));
  }
  if (type === 'category') return (d.categories || []).map(c => ({ id: c.id, label: c.title }));
  const catById = {};
  (d.categories || []).forEach(c => { catById[String(c.id)] = c.title; });
  return (d.services || []).map(s => ({
    id: s.id,
    label: s.title + (catById[String(s.category_id)] ? ` · ${catById[String(s.category_id)]}` : ''),
  }));
}

function condRender(ns) {
  const st = _condEditors[ns];
  const wrap = document.getElementById(`${ns}Conds`);
  if (!st || !wrap) return;
  wrap.innerHTML = st.conds.map((c, i) => `
    <div class="nr-cond">
      <div class="nr-cond-head">
        <select onchange="condType('${ns}', ${i}, this.value)">
          ${Object.entries(COND_LABELS).map(([k, v]) =>
            `<option value="${k}" ${c.type === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        <span class="nr-cond-count" id="${ns}CondCount-${i}">выбрано: ${c.ids.size}</span>
        <button class="mc" onclick="condRemove('${ns}', ${i})" title="Убрать условие">✕</button>
      </div>
      <input type="search" autocomplete="off" placeholder="🔎 Поиск…" value="${escAttr(esc(c.filter))}"
             oninput="condFilter('${ns}', ${i}, this.value)">
      <div class="nr-cond-list" id="${ns}CondList-${i}"></div>
    </div>`).join('');
  const lw = document.getElementById(`${ns}LogicWrap`);
  if (lw) lw.style.display = st.conds.length > 1 ? 'flex' : 'none';
  st.conds.forEach((_, i) => condRenderList(ns, i));
}

function condRenderList(ns, i) {
  const st = _condEditors[ns];
  const box = document.getElementById(`${ns}CondList-${i}`);
  if (!st || !box) return;
  const c = st.conds[i];
  const q = (c.filter || '').trim().toLowerCase();
  let opts = condOptions(ns, c.type);
  if (q) opts = opts.filter(o => o.label.toLowerCase().includes(q));
  const total = opts.length;
  // Выбранные — всегда сверху, чтобы не терялись за фильтром и лимитом.
  opts.sort((a, b) => (c.ids.has(String(b.id)) ? 1 : 0) - (c.ids.has(String(a.id)) ? 1 : 0));
  opts = opts.slice(0, 150);
  box.innerHTML = opts.map(o => `
    <label class="nr-cond-opt">
      <input type="checkbox" ${c.ids.has(String(o.id)) ? 'checked' : ''}
             onchange="condToggleId('${ns}', ${i}, '${o.id}', this.checked)">
      <span>${esc(o.label)}</span>
    </label>`).join('') || '<div class="empty" style="padding:12px 0">Ничего не найдено</div>';
  if (total > 150) {
    box.innerHTML += `<div style="font-size:11px;color:var(--t3);padding:6px 2px">Показаны первые 150 из ${total} — уточните поиск</div>`;
  }
}

/** Есть ли хоть одно непустое условие — обе страницы это проверяют перед сохранением. */
function condHasAny(ns) {
  const st = _condEditors[ns];
  return !!(st && st.conds.some(c => c.ids.size));
}
```

- [ ] **Step 2: Переписать care.js на делегации**

В `frontend/js/pages/care.js` заменить блок со строки `// — конструктор условий (паттерн broadcast-rules.js) —` (строка 192) по конец `careRenderCondList` (строка 286) на:

```js
// — конструктор условий: общий модуль conditions-editor.js —
// Имена careXxx сохранены: на них ссылается инлайн-разметка в index.html.

function careSetLogic(logic) { condSetLogic('care', logic); }
function careAddCond()       { condAdd('care'); }
function careRemoveCond(i)   { condRemove('care', i); }
function careCondType(i, t)  { condType('care', i, t); }
function careCondFilter(i, v){ condFilter('care', i, v); }
function careCondToggleId(i, id, checked) { condToggleId('care', i, id, checked); }
function careRenderConds()   { condRender('care'); }
function careRenderCondList(i) { condRenderList('care', i); }
```

Затем в `care.js` привести к общему состоянию три места, где раньше читались локальные `_careConds` / `_careLogic`:

1. Удалить объявления `let _careConds = [];` и `let _careLogic = 'and';` (строки 34–35) — состояние теперь внутри модуля.
2. В `careEnsureDicts()` после присваивания `_careDicts` добавить `condInit('care', _careDicts);`.
3. В `careOpenProgramModal(id)` заменить построение `_careConds`/`_careLogic` из загруженной программы на `condSet('care', program.conditions)` (для новой программы — `condSet('care', { logic: 'and', items: [] })`).
4. В `careSaveProgram()` заменить сборку `conditions` из `_careConds`/`_careLogic` на `const conditions = condGet('care');`, а проверку «есть ли условия» — на `condHasAny('care')`.

- [ ] **Step 3: Подключить файл в index.html**

В `frontend/index.html` перед строкой `<script src="js/pages/care.js?v=2026-08-03b"></script>` (строка 2229) вставить:

```html
<script src="js/pages/conditions-editor.js?v=2026-08-07a"></script>
```

И там же поднять версию care.js, чтобы браузер не отдал старый файл из кэша:

```html
<script src="js/pages/care.js?v=2026-08-07a"></script>
```

- [ ] **Step 4: Проверить, что «Забота» не сломалась**

Через MCP Playwright (`mcp__playwright__*`, не bash-скрипт): открыть `http://localhost:3001`, войти владельцем, перейти на «💚 Забота», нажать «+ Новая программа», добавить условие, переключить тип на «Категория», отметить пару чекбоксов, ввести текст в поиск, сохранить программу и открыть её снова.

Ожидается: условия сохранились и отрисовались при повторном открытии; в консоли браузера нет ошибок.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add frontend/js/pages/conditions-editor.js frontend/js/pages/care.js frontend/index.html && git commit -m "refactor(care): конструктор условий вынесен в общий модуль"
```

---

## Task 14: Вкладки «Напоминания» и «История напоминаний»

**Files:**
- Create: `frontend/js/pages/reminders.js`
- Modify: `frontend/index.html` (кнопки вкладок 1241–1244, разметка после блока `careTab-clients`, подключение скрипта)
- Modify: `frontend/js/pages/care.js` (`careSwitchTab`, `loadCarePage`)

- [ ] **Step 1: Расширить переключатель вкладок**

В `frontend/js/pages/care.js` заменить `careSwitchTab` и `loadCarePage` (строки 43–56) на:

```js
const CARE_TABS = ['programs', 'clients', 'reminders', 'reminders-history'];

function loadCarePage() {
  careSwitchTab('programs');
  careLoadPrograms();
  careLoadEnrollments();
}

function careSwitchTab(tab) {
  for (const t of CARE_TABS) {
    const pane = document.getElementById(`careTab-${t}`);
    const btn = document.getElementById(`careTabBtn-${t}`);
    if (pane) pane.style.display = t === tab ? '' : 'none';
    if (btn) btn.classList.toggle('active', t === tab);
  }
  // Вкладки напоминаний грузятся лениво: их данные не нужны тому, кто зашёл
  // за программами заботы, а история может быть большой.
  if (tab === 'reminders') remLoadRules();
  if (tab === 'reminders-history') remLoadHistory();
}
```

- [ ] **Step 2: Добавить разметку вкладок**

В `frontend/index.html` заменить блок кнопок (строки 1241–1244) на:

```html
      <div class="tabs" style="max-width:860px">
        <button class="tab active" id="careTabBtn-programs" onclick="careSwitchTab('programs')">💚 Программы</button>
        <button class="tab" id="careTabBtn-clients" onclick="careSwitchTab('clients')">👥 Клиенты</button>
        <button class="tab" id="careTabBtn-reminders" onclick="careSwitchTab('reminders')">🔁 Напоминания</button>
        <button class="tab" id="careTabBtn-reminders-history" onclick="careSwitchTab('reminders-history')">🧾 История напоминаний</button>
      </div>
```

И сразу после закрывающего `</div>` блока `careTab-clients` вставить две новые панели:

```html
      <div id="careTab-reminders" style="display:none">
        <div class="bc-head">
          <div>
            <div class="bc-head-title">🔁 Напоминания о повторном визите</div>
            <div class="bc-head-sub">Через N дней после визита, если клиент не записался на аналогичную услугу</div>
          </div>
          <button class="btn btn-pri" onclick="remOpenRuleModal()">+ Новое правило</button>
        </div>
        <div id="remRules" class="empty">Загрузка…</div>
      </div>

      <div id="careTab-reminders-history" style="display:none">
        <div class="bc-head">
          <div>
            <div class="bc-head-title">🧾 История напоминаний</div>
            <div class="bc-head-sub">Кому и по какому правилу ушло, бонусы, записался ли в итоге</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <select id="remHistRule" onchange="remLoadHistory()" style="width:auto;min-width:170px"></select>
            <select id="remHistStatus" onchange="remLoadHistory()" style="width:auto;min-width:150px">
              <option value="">Все статусы</option>
              <option value="scheduled">Запланировано</option>
              <option value="sent">Отправлено</option>
              <option value="skipped">Пропущено</option>
              <option value="cancelled">Отменено</option>
              <option value="failed">Ошибка</option>
            </select>
            <select id="remHistConv" onchange="remLoadHistory()" style="width:auto;min-width:150px">
              <option value="">Конверсия: любая</option>
              <option value="1">Записался</option>
              <option value="0">Не записался</option>
            </select>
          </div>
        </div>
        <div class="card" style="padding:0"><div class="tw">
          <table>
            <thead><tr>
              <th>Когда</th><th>Клиент</th><th>Правило</th><th>Бонусы</th>
              <th>Текст</th><th>Статус</th><th>Записался</th><th>Дошёл</th><th></th>
            </tr></thead>
            <tbody id="remHistBody"><tr><td colspan="9" class="empty">Загрузка…</td></tr></tbody>
          </table>
        </div></div>
      </div>

      <div class="modal" id="remRuleModal" style="display:none">
        <div class="modal-box" style="max-width:720px">
          <div class="modal-head">
            <div class="modal-title" id="remRuleTitle">Новое правило</div>
            <button class="mc" onclick="remCloseRuleModal()">✕</button>
          </div>
          <div class="modal-body">
            <div class="fg"><label class="fl">Название</label>
              <input id="remTitle" maxlength="255" placeholder="Например: Эпиляция раз в месяц"></div>

            <div class="stg-section">
              <div class="fl">Условия визита</div>
              <div id="remConds"></div>
              <div id="remLogicWrap" style="display:none;gap:6px;align-items:center;margin:6px 0">
                <span style="font-size:12px;color:var(--t3)">Совпадение:</span>
                <button class="chip on" id="remLogic-and" onclick="condSetLogic('reminders','and')">все условия</button>
                <button class="chip" id="remLogic-or" onclick="condSetLogic('reminders','or')">любое условие</button>
              </div>
              <button class="btn" onclick="condAdd('reminders')">+ Условие</button>
            </div>

            <div style="display:flex;gap:12px;flex-wrap:wrap">
              <div class="fg" style="flex:1;min-width:150px"><label class="fl">Напомнить через (дней)</label>
                <input id="remDelay" type="number" min="1" max="730" value="30"></div>
              <div class="fg" style="flex:1;min-width:150px"><label class="fl">Время отправки</label>
                <input id="remSendTime" type="time" value="11:00"></div>
              <div class="fg" style="flex:1;min-width:150px"><label class="fl">Окно атрибуции (дней)</label>
                <input id="remAttrDays" type="number" min="1" max="365" value="30"></div>
            </div>

            <div class="stg-section">
              <div class="fl">Текст</div>
              <div style="display:flex;gap:6px;margin-bottom:8px">
                <button class="chip on" id="remMode-strict" onclick="remSetMode('strict')">📋 Готовый текст</button>
                <button class="chip" id="remMode-free" onclick="remSetMode('free')">✍️ Мила пишет сама</button>
              </div>
              <textarea id="remText" rows="3" maxlength="2000"
                placeholder="{first_name}, прошло {дней} дн. с процедуры «{услуга}» — самое время повторить!"></textarea>
              <div style="font-size:11px;color:var(--t3);margin-top:4px">
                Подстановки: {first_name} {name} {услуга} {мастер} {дней} {бонусы} {баланс} {салон}
              </div>
            </div>

            <div class="stg-section">
              <label class="fl" style="display:flex;gap:8px;align-items:center">
                <input type="checkbox" id="remBonusEnabled" onchange="remRenderTiers()"> Начислять и упоминать бонусы
              </label>
              <div id="remTiers"></div>
              <button class="btn" id="remAddTierBtn" onclick="remAddTier()">+ Ступень</button>
            </div>

            <div style="display:flex;gap:12px;flex-wrap:wrap">
              <div class="fg" style="flex:1;min-width:150px"><label class="fl">Кап догона (в день)</label>
                <input id="remCap" type="number" min="1" max="500" value="30"></div>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn" onclick="remCloseRuleModal()">Отмена</button>
            <button class="btn btn-pri" onclick="remSaveRule()">Сохранить</button>
          </div>
        </div>
      </div>

      <div class="modal" id="remBackfillModal" style="display:none">
        <div class="modal-box" style="max-width:820px">
          <div class="modal-head">
            <div class="modal-title">Догон по базе</div>
            <button class="mc" onclick="remCloseBackfill()">✕</button>
          </div>
          <div class="modal-body">
            <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
              <div class="fg" style="flex:0 0 160px"><label class="fl">За последние (дней)</label>
                <input id="remBfDays" type="number" min="1" max="90" value="30"></div>
              <button class="btn" onclick="remRunBackfillPreview()">👁 Показать выборку</button>
            </div>
            <div id="remBfResult" class="empty">Задайте период и нажмите «Показать выборку»</div>
          </div>
          <div class="modal-foot">
            <button class="btn" onclick="remCloseBackfill()">Отмена</button>
            <button class="btn btn-pri" id="remBfRunBtn" onclick="remRunBackfill()" disabled>Поставить в очередь</button>
          </div>
        </div>
      </div>
```

Подключить скрипт рядом с `care.js`:

```html
<script src="js/pages/reminders.js?v=2026-08-07a"></script>
```

- [ ] **Step 3: Создать страницу**

Создать `frontend/js/pages/reminders.js`:

```js
// ── НАПОМИНАНИЯ О ПОВТОРНОМ ВИЗИТЕ (вкладки страницы «Забота») ──
// Вкладка «Напоминания»: CRUD reminder_rules + догон по базе.
// Вкладка «История напоминаний»: журнал reminder_queue с бонусами, конверсией
// и ручным тумблером анти-повтора.
// Зависимости: api(), esc(), escAttr(), notify() и модуль conditions-editor.js.

const REM_STATUS = {
  scheduled: { lbl: 'Запланировано', color: '#9ca3af' },
  sent:      { lbl: 'Отправлено',    color: '#10b981' },
  skipped:   { lbl: 'Пропущено',     color: '#f59e0b' },
  cancelled: { lbl: 'Отменено',      color: '#9ca3af' },
  failed:    { lbl: 'Ошибка',        color: '#ef4444' },
};
const REM_TIER_LBL = { accrue: 'начислено', mention: 'упомянут баланс', none: 'без бонусов', no_bonus: 'бонусы недоступны' };

let _remRules = [];
let _remEditId = null;
let _remMode = 'strict';
let _remTiers = [];          // [{ upTo, action, amount, text }]
let _remBfRuleId = null;
let _remBfRows = null;

// ── вкладка «Напоминания» ──────────────────────────────────────

async function remLoadRules() {
  try {
    const d = await api('GET', '/api/reminders/rules');
    _remRules = d.rules || [];
    remRenderRules();
    remFillHistoryFilter();
  } catch (e) { notify(e.message || 'Не удалось загрузить правила', 'error'); }
}

function remRenderRules() {
  const wrap = document.getElementById('remRules');
  if (!wrap) return;
  if (!_remRules.length) {
    wrap.className = 'empty';
    wrap.innerHTML = 'Правил пока нет. Создайте первое — например, «Лазерная эпиляция раз в месяц».';
    return;
  }
  wrap.className = '';
  wrap.innerHTML = _remRules.map(r => `
    <div class="card" style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start">
        <div>
          <div style="font-weight:600">${esc(r.title)}
            <span class="chip ${r.isEnabled ? 'on' : ''}" style="margin-left:8px">${r.isEnabled ? 'включено' : 'выключено'}</span>
          </div>
          <div style="font-size:12px;color:var(--t3);margin-top:4px">
            Через ${r.delayDays} дн. в ${esc(r.sendTime)} ·
            ${r.textMode === 'free' ? 'Мила пишет сама' : 'готовый текст'} ·
            ${r.bonusEnabled ? `бонусы: ${(r.bonusTiers || []).length} ступ.` : 'без бонусов'}
          </div>
          <div style="font-size:12px;color:var(--t3);margin-top:4px">
            В очереди: ${r.queuedCount} · отправлено: ${r.sentCount} ·
            записались: ${r.convertedCount} · дошли: ${r.visitedCount} ·
            начислено бонусов: ${r.bonusTotal}
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn" onclick="remOpenBackfill(${r.id})">👁 Догон</button>
          <button class="btn" onclick="remOpenRuleModal(${r.id})">Изменить</button>
          <button class="btn" onclick="remToggleRule(${r.id})">${r.isEnabled ? 'Выключить' : 'Включить'}</button>
          <button class="btn" onclick="remDeleteRule(${r.id})">Удалить</button>
        </div>
      </div>
    </div>`).join('');
}

async function remToggleRule(id) {
  try { await api('POST', `/api/reminders/rules/${id}/toggle`); await remLoadRules(); }
  catch (e) { notify(e.message || 'Не удалось переключить', 'error'); }
}

async function remDeleteRule(id) {
  if (!confirm('Удалить правило? История отправок сохранится.')) return;
  try { await api('DELETE', `/api/reminders/rules/${id}`); await remLoadRules(); notify('Правило удалено'); }
  catch (e) { notify(e.message || 'Не удалось удалить', 'error'); }
}

// ── редактор правила ───────────────────────────────────────────

async function remOpenRuleModal(id) {
  await careEnsureDicts();                       // общий словарь с «Заботой»
  condInit('reminders', _careDicts);
  _remEditId = id || null;
  const r = id ? _remRules.find(x => x.id === id) : null;
  document.getElementById('remRuleTitle').textContent = r ? 'Правило напоминания' : 'Новое правило';
  document.getElementById('remTitle').value = r ? r.title : '';
  document.getElementById('remDelay').value = r ? r.delayDays : 30;
  document.getElementById('remSendTime').value = r ? r.sendTime : '11:00';
  document.getElementById('remAttrDays').value = r ? r.attributionDays : 30;
  document.getElementById('remCap').value = r ? r.backfillMaxPerDay : 30;
  document.getElementById('remText').value = r ? r.text : '';
  document.getElementById('remBonusEnabled').checked = r ? !!r.bonusEnabled : false;
  _remTiers = r && Array.isArray(r.bonusTiers)
    ? r.bonusTiers.map(t => ({ upTo: t.up_to, action: t.action, amount: t.amount, text: t.text || '' }))
    : [];
  remSetMode(r ? r.textMode : 'strict');
  condSet('reminders', r ? r.conditions : { logic: 'and', items: [] });
  remRenderTiers();
  document.getElementById('remRuleModal').style.display = 'flex';
}

function remCloseRuleModal() { document.getElementById('remRuleModal').style.display = 'none'; }

function remSetMode(mode) {
  _remMode = mode === 'free' ? 'free' : 'strict';
  document.getElementById('remMode-strict').classList.toggle('on', _remMode === 'strict');
  document.getElementById('remMode-free').classList.toggle('on', _remMode === 'free');
}

function remAddTier() {
  _remTiers.push({ upTo: 500, action: 'accrue', amount: 300, text: '' });
  remRenderTiers();
}

function remRemoveTier(i) { _remTiers.splice(i, 1); remRenderTiers(); }

function remTierField(i, field, value) {
  if (field === 'upTo') _remTiers[i].upTo = value === '' ? null : Number(value);
  else if (field === 'amount') _remTiers[i].amount = Number(value) || 0;
  else _remTiers[i][field] = value;
  if (field === 'action') remRenderTiers();
}

function remRenderTiers() {
  const on = document.getElementById('remBonusEnabled').checked;
  const wrap = document.getElementById('remTiers');
  document.getElementById('remAddTierBtn').style.display = on ? '' : 'none';
  if (!on) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = _remTiers.map((t, i) => `
    <div class="nr-cond" style="margin-bottom:8px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span style="font-size:12px;color:var(--t3)">баланс меньше</span>
        <input type="number" min="0" style="width:110px" value="${t.upTo === null ? '' : t.upTo}"
               placeholder="без предела" oninput="remTierField(${i},'upTo',this.value)">
        <select style="width:auto" onchange="remTierField(${i},'action',this.value)">
          <option value="accrue"  ${t.action === 'accrue'  ? 'selected' : ''}>начислить</option>
          <option value="mention" ${t.action === 'mention' ? 'selected' : ''}>только упомянуть баланс</option>
          <option value="none"    ${t.action === 'none'    ? 'selected' : ''}>без бонусов</option>
        </select>
        ${t.action === 'accrue' ? `<input type="number" min="1" style="width:100px" value="${t.amount}"
               placeholder="бонусов" oninput="remTierField(${i},'amount',this.value)">` : ''}
        <button class="mc" onclick="remRemoveTier(${i})" title="Убрать ступень">✕</button>
      </div>
      <textarea rows="2" placeholder="Текст для этой ступени (пусто — возьмётся основной текст правила)"
                oninput="remTierField(${i},'text',this.value)">${esc(t.text || '')}</textarea>
    </div>`).join('') || '<div class="empty" style="padding:10px 0">Ступеней нет — добавьте хотя бы одну</div>';
}

async function remSaveRule() {
  const body = {
    title: document.getElementById('remTitle').value.trim(),
    conditions: condGet('reminders'),
    delayDays: Number(document.getElementById('remDelay').value),
    sendTime: document.getElementById('remSendTime').value,
    textMode: _remMode,
    text: document.getElementById('remText').value.trim(),
    attributionDays: Number(document.getElementById('remAttrDays').value),
    backfillMaxPerDay: Number(document.getElementById('remCap').value),
    bonusEnabled: document.getElementById('remBonusEnabled').checked,
    bonusTiers: _remTiers.map(t => ({ upTo: t.upTo, action: t.action, amount: t.amount, text: t.text || '' })),
  };
  if (!condHasAny('reminders')) {
    return notify('Добавьте хотя бы одно условие: без него напоминание уйдёт после любого визита', 'error');
  }
  try {
    if (_remEditId) await api('PUT', `/api/reminders/rules/${_remEditId}`, body);
    else await api('POST', '/api/reminders/rules', body);
    remCloseRuleModal();
    await remLoadRules();
    notify('Правило сохранено');
  } catch (e) { notify(e.message || 'Не удалось сохранить', 'error'); }
}

// ── догон по базе ──────────────────────────────────────────────

const REM_SKIP_LBL = {
  no_phone: 'нет телефона', blacklist: 'чёрный список', muted: 'уже напоминали',
  already_queued: 'уже в очереди', future_booking: 'уже записан', superseded: 'есть визит позже',
};

function remOpenBackfill(ruleId) {
  _remBfRuleId = ruleId;
  _remBfRows = null;
  document.getElementById('remBfResult').className = 'empty';
  document.getElementById('remBfResult').innerHTML = 'Задайте период и нажмите «Показать выборку»';
  document.getElementById('remBfRunBtn').disabled = true;
  document.getElementById('remBackfillModal').style.display = 'flex';
}

function remCloseBackfill() { document.getElementById('remBackfillModal').style.display = 'none'; }

async function remRunBackfillPreview() {
  const days = Number(document.getElementById('remBfDays').value) || 30;
  const box = document.getElementById('remBfResult');
  box.className = 'empty';
  box.innerHTML = 'Считаю…';
  try {
    const d = await api('POST', `/api/reminders/rules/${_remBfRuleId}/backfill/preview`, { days });
    _remBfRows = d;
    box.className = '';
    const willSend = d.totals.willSend;
    document.getElementById('remBfRunBtn').disabled = willSend === 0;
    box.innerHTML = `
      <div style="margin:10px 0;font-size:13px">
        Записей за период: ${d.totals.records} · состоявшихся: ${d.totals.completed} ·
        под условия: ${d.totals.matched} · <b>уйдёт напоминаний: ${willSend}</b>
        ${d.lastScheduledAt ? ` · последнее ${remFmt(d.lastScheduledAt)}` : ''}
      </div>
      ${d.catMapFailed ? '<div class="empty" style="color:#f59e0b">Карта категорий не загрузилась — условия по категории не сработают</div>' : ''}
      <div class="tw"><table><thead><tr>
        <th>Клиент</th><th>Визит</th><th>Услуги</th><th>Итог</th>
      </tr></thead><tbody>
      ${d.rows.slice(0, 200).map(r => `<tr>
        <td>${esc(r.clientName || r.phone || '')}</td>
        <td>${remFmt(r.visitAt)}</td>
        <td>${esc((r.services || []).map(s => s.title).join(', '))}</td>
        <td>${r.skipReason ? `<span style="color:var(--t3)">${esc(REM_SKIP_LBL[r.skipReason] || r.skipReason)}</span>`
                           : '<span style="color:#10b981">уйдёт</span>'}</td>
      </tr>`).join('')}
      </tbody></table></div>
      ${d.rows.length > 200 ? `<div style="font-size:11px;color:var(--t3);padding:6px 2px">Показаны первые 200 из ${d.rows.length}</div>` : ''}`;
  } catch (e) {
    box.className = 'empty';
    box.innerHTML = esc(e.message || 'Не удалось построить выборку');
  }
}

async function remRunBackfill() {
  const days = Number(document.getElementById('remBfDays').value) || 30;
  const n = _remBfRows ? _remBfRows.totals.willSend : 0;
  if (!confirm(`Поставить в очередь ${n} напоминаний? Они уйдут живым клиентам по расписанию правила.`)) return;
  try {
    const d = await api('POST', `/api/reminders/rules/${_remBfRuleId}/backfill`, { days });
    remCloseBackfill();
    await remLoadRules();
    notify(`Поставлено в очередь: ${d.queued}`);
  } catch (e) { notify(e.message || 'Не удалось выполнить догон', 'error'); }
}

// ── вкладка «История напоминаний» ──────────────────────────────

function remFillHistoryFilter() {
  const sel = document.getElementById('remHistRule');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">Все правила</option>' +
    _remRules.map(r => `<option value="${r.id}">${esc(r.title)}</option>`).join('');
  sel.value = cur;
}

async function remLoadHistory() {
  if (!_remRules.length) await remLoadRules();
  const q = new URLSearchParams();
  const rule = document.getElementById('remHistRule').value;
  const status = document.getElementById('remHistStatus').value;
  const conv = document.getElementById('remHistConv').value;
  if (rule) q.set('ruleId', rule);
  if (status) q.set('status', status);
  if (conv) q.set('converted', conv);
  q.set('limit', '100');
  try {
    const d = await api('GET', `/api/reminders/history?${q}`);
    remRenderHistory(d.rows || []);
  } catch (e) { notify(e.message || 'Не удалось загрузить историю', 'error'); }
}

function remRenderHistory(rows) {
  const body = document.getElementById('remHistBody');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="9" class="empty">Отправок пока нет</td></tr>';
    return;
  }
  body.innerHTML = rows.map(r => {
    const st = REM_STATUS[r.status] || { lbl: r.status, color: '#9ca3af' };
    const bonus = r.bonusAccrued ? `+${r.bonusAccrued}` : (REM_TIER_LBL[r.bonusTier] || '—');
    // Запланированные строки тоже живут в этой таблице (фильтр «Запланировано»):
    // отдельной вкладки очереди нет, и время у них своё — scheduled_at.
    const when = r.status === 'scheduled' ? r.scheduledAt : r.sentAt;
    return `<tr>
      <td>${remFmt(when)}</td>
      <td>${esc(r.clientName || r.phone || '')}</td>
      <td>${esc(r.ruleTitle || '—')}</td>
      <td title="баланс был: ${r.balanceBefore == null ? 'неизвестен' : r.balanceBefore}">${esc(String(bonus))}</td>
      <td style="max-width:320px">${esc((r.text || '').slice(0, 200))}</td>
      <td><span style="color:${st.color}">${esc(st.lbl)}</span>
          ${r.reason ? `<div style="font-size:11px;color:var(--t3)">${esc(r.reason)}</div>` : ''}</td>
      <td>${r.convertedAt ? remFmt(r.convertedAt) : '—'}</td>
      <td>${r.visitedAt ? remFmt(r.visitedAt) : '—'}</td>
      <td>${r.status === 'scheduled'
             ? `<button class="btn" onclick="remCancelQueued(${r.id})">Отменить</button>`
             : (r.ruleId ? `<button class="btn" onclick="remToggleMute(${r.ruleId}, '${esc(r.phone)}', ${!r.muted})">
                  ${r.muted ? 'Разрешить снова' : 'Запретить'}</button>` : '')}</td>
    </tr>`;
  }).join('');
}

async function remCancelQueued(id) {
  if (!confirm('Отменить запланированное напоминание?')) return;
  try {
    await api('POST', `/api/reminders/queue/${id}/cancel`);
    await remLoadHistory();
    notify('Напоминание отменено');
  } catch (e) { notify(e.message || 'Не удалось отменить', 'error'); }
}

async function remToggleMute(ruleId, phone, muted) {
  try {
    await api('POST', '/api/reminders/suppressions/toggle', { ruleId, phone, muted });
    await remLoadHistory();
    notify(muted ? 'Напоминания по этому правилу запрещены' : 'Напоминания разрешены снова');
  } catch (e) { notify(e.message || 'Не удалось изменить флаг', 'error'); }
}

function remFmt(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
```

- [ ] **Step 4: Проверить в браузере**

Через MCP Playwright: открыть `http://localhost:3001`, войти владельцем, «💚 Забота» → вкладка «🔁 Напоминания» → «+ Новое правило». Заполнить название, добавить условие по категории, задержку 30, включить бонусы и добавить две ступени (до 500 → начислить 300; без предела → упомянуть). Сохранить. Открыть заново — проверить, что условия и ступени восстановились. Затем «👁 Догон» → «Показать выборку» на 30 дней.

Ожидается: правило сохраняется и открывается с теми же значениями; превью догона отдаёт таблицу с причинами отсева; в консоли нет ошибок. Кнопка «Поставить в очередь» остаётся заблокированной, пока не построено превью, — на этом шаге НЕ нажимать, иначе живым клиентам уйдут реальные сообщения.

- [ ] **Step 5: Проверить вкладку истории**

Там же переключиться на «🧾 История напоминаний».

Ожидается: таблица с заглушкой «Отправок пока нет», фильтр правил заполнен созданным правилом, ошибок в консоли нет.

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro && git add frontend/js/pages/reminders.js frontend/js/pages/care.js frontend/index.html && git commit -m "feat(reminders): вкладки правил, догона и истории на странице «Забота»"
```

---

## Task 15: Живая проверка сквозного сценария

Юнит-тесты гоняют замоканный воркер. Этот скрипт прогоняет настоящую строку очереди через настоящий воркер на дев-БД: единственный способ поймать расхождение колонок `LEASE_SQL` с тем, что читает `processOne`.

**Files:**
- Create: `backend/scripts/reminders-e2e.js`

- [ ] **Step 1: Написать скрипт**

Создать `backend/scripts/reminders-e2e.js`:

```js
'use strict';
// Живая проверка напоминания на дев-БД: создаёт правило, ставит строку очереди
// на «сейчас», прогоняет ОДИН тик настоящего воркера и печатает результат.
//
// По умолчанию НИЧЕГО НЕ ОТПРАВЛЯЕТ и НИЧЕГО НЕ НАЧИСЛЯЕТ: отправка и
// начисление застаблены. Начисление необратимо (ручная транзакция по карте),
// поэтому боевой путь бонусов включается только явным флагом --accrue.
//
//   node scripts/reminders-e2e.js [--phone 79200255591] [--send] [--accrue]
//
// За собой чистит: удаляет созданное правило (строки очереди уходят каскадом
// по salon_id только при удалении салона, поэтому чистим их явно).

const { db } = require('../db');
const worker = require('../services/reminders/worker');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, def) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : def; };

const PHONE = val('--phone', '79200255591');
const REAL_SEND = flag('--send');
const REAL_ACCRUE = flag('--accrue');

(async () => {
  const salon = await db.one(`SELECT id, name FROM salons WHERE is_active = TRUE ORDER BY id LIMIT 1`);
  console.log(`салон #${salon.id} «${salon.name}», телефон ${PHONE}`);

  const rule = await db.one(
    `INSERT INTO reminder_rules
       (salon_id, title, conditions, delay_days, send_time, text_mode, text,
        attribution_days, bonus_enabled, bonus_tiers, backfill_max_per_day)
     VALUES ($1, 'E2E тест напоминаний', '{"logic":"and","items":[]}'::jsonb, 30, '11:00',
             'strict', '{first_name}, прошло {дней} дн. — пора повторить {услуга}!',
             30, $2, '[{"up_to":500,"action":"accrue","amount":10,"text":"{first_name}, начислили {бонусы} бонусов, ждём вас!"}]'::jsonb, 30)
     RETURNING *`,
    [salon.id, REAL_ACCRUE]);
  console.log(`правило #${rule.id} создано (бонусы: ${REAL_ACCRUE ? 'БОЕВЫЕ' : 'выключены'})`);

  const row = await db.one(
    `INSERT INTO reminder_queue
       (salon_id, rule_id, rule_title, phone, anchor_record_id, anchor_visit_at,
        anchor_services, scheduled_at, source)
     VALUES ($1,$2,$3,$4,$5, NOW() - interval '30 days',
             '[{"id":1,"title":"Лазерная эпиляция"}]'::jsonb, NOW() - interval '1 minute', 'webhook')
     RETURNING id`,
    [salon.id, rule.id, rule.title, PHONE, Date.now() % 1000000000]);
  console.log(`строка очереди #${row.id} поставлена на «сейчас»`);

  const deps = {};
  if (!REAL_SEND) {
    deps.sendMessage = async (p) => {
      console.log(`\n=== ТЕКСТ (не отправлен) ===\n${p.text}\n=== канал: ${(p.dispatchRouting || []).join(',')} ===\n`);
      return { id: 'stub', channel: 'telegram' };
    };
    deps.rememberPending = async () => {};
    deps.persistWhatsapp = async () => {};
  }

  await worker.processTick(deps);

  const after = await db.one(
    `SELECT status, decision_reason, rendered_text, balance_before, bonus_tier,
            bonus_accrued, bonus_txn_ok, channel_used
       FROM reminder_queue WHERE id=$1`, [row.id]);
  console.log('итог строки:', after);

  const mute = await db.oneOrNone(
    `SELECT muted, reason, source FROM reminder_suppressions WHERE rule_id=$1 AND phone=$2`,
    [rule.id, PHONE]);
  console.log('флаг анти-повтора:', mute || 'не выставлен');

  await db.query(`DELETE FROM reminder_queue WHERE rule_id=$1`, [rule.id]);
  await db.query(`DELETE FROM reminder_rules WHERE id=$1`, [rule.id]);
  console.log('прибрано');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Прогнать без отправки**

```bash
cd /root/loyalpro/backend && node scripts/reminders-e2e.js
```

Ожидается: печатается текст напоминания с подставленным именем и числом дней, `status: 'sent'`, `bonus_tier: 'no_bonus'` (бонусы выключены), флаг анти-повтора выставлен с `source: 'auto'`. Строка «прибрано» в конце.

Если пришло `status: 'skipped'` с причиной про гейт — значит на деве выключен `CHATPUSH_AGENT_ENABLED` или номер не проходит режим whitelist; это ожидаемое поведение гейта, а не баг скрипта.

- [ ] **Step 3: Полный прогон юнит-тестов**

```bash
cd /root/loyalpro/backend && npx jest --silent --testPathIgnorePatterns primary-clients 2>&1 | tail -20
```

Ожидается: все сьюты зелёные. `primary-clients.test.js` исключён намеренно — он зовёт `process.exit(1)` и убивает соседний сьют (известный флак, не регресс этой работы).

- [ ] **Step 4: Commit**

```bash
cd /root/loyalpro && git add backend/scripts/reminders-e2e.js && git commit -m "test(reminders): живой сквозной прогон одной строки очереди"
```

---

## Task 16: Документация модуля в CLAUDE.md

Без этого следующий сеанс не узнает ни про порядок «захват строки → бонусы → отправка», ни про то, почему `rule_id` здесь `SET NULL`, а в «Заботе» `CASCADE`.

**Files:**
- Modify: `CLAUDE.md` (новый раздел после «Отдел заботы» (care-программы))

- [ ] **Step 1: Добавить раздел**

В `CLAUDE.md` после последнего пункта раздела «Отдел заботы» (абзац про «Превью выборки») добавить:

```markdown
### Напоминания о повторном визите
Отдельный модуль `services/reminders/*` рядом с «Заботой», вкладки на той же странице. Спека — `docs/superpowers/specs/2026-08-07-repeat-visit-reminders-design.md`.

- Планирование СОБЫТИЙНОЕ, из `routes/webhook.js` (рядом с care, в СВОЁМ try/catch): визит состоялся → снять `muted` → отменить `scheduled` строки от БОЛЕЕ РАННИХ визитов → вставить строку `reminder_queue` на `visit_at + delay_days`. Порядок «снять флаг ДО планирования» обязателен: иначе новая строка упрётся в собственный `muted` от прошлого цикла и не уйдёт никогда.
- Анти-повтор (`reminder_suppressions`, UNIQUE `(rule_id, phone)`): `muted` вешается ТОЛЬКО за фактически отправленное сообщение (не за `cancelled` «клиент уже записан»), снимается состоявшимся визитом или кнопкой в истории. Отсюда утверждённое поведение «клиент не ответил → молчим до следующего визита».
- «Аналогичная услуга» = попадает под ТЕ ЖЕ условия правила (`eligibility.hasFutureMatchingBooking` поверх общего `evaluateRule`), а не «ровно та же услуга якоря». Второй копии критерия быть не должно — она же используется в атрибуции и в догоне.
- Порядок в воркере СОЗНАТЕЛЬНЫЙ: (1) захват строки условным `UPDATE … WHERE status='scheduled'` — с этого момента гонок нет; (2) бонусы, ТОЛЬКО если `bonus_accrued IS NULL`, с немедленной записью результата в строку; (3) рендер текста с ФАКТИЧЕСКОЙ суммой; (4) отправка. Начисление НЕОБРАТИМО (`ycAccrueCard` — ручная транзакция), поэтому сбой отправки возвращает строку в `scheduled`, но бонусы не откатывает и повторно не начисляет. Обратный порядок («сначала пообещать») отвергнут: клиент не должен прочесть про 300 бонусов, которых у него нет.
- Любой сбой бонусной части (нет карты, YClients молчит, начисление упало) деградирует в ступень `no_bonus` — уходит БАЗОВЫЙ текст правила без единого слова о бонусах. `services/reminders/bonus.js` наружу не бросает НИКОГДА.
- Ступени (`bonus_tiers`) — массив по возрастанию `up_to`, порог ИСКЛЮЧАЮЩИЙ, последняя ступень `up_to: null`. Баланс выше последней конечной ступени → `no_bonus` (не проваливаемся в последнюю). Валидация в `routes/reminders.js` недоверчивая: суммы уходят реальными деньгами на карту.
- Гейты воркера: правило выключено → skip; env kill-switch → ОТЛОЖИТЬ на сутки (не сжигать); `isAllowed(..., {ignoreSchedule:true})` — окно расписания на напоминания не распространяется, ЧС/whitelist действуют; диалог на операторе → отложить, `defers` до 3, потом skip; `muted` → cancel; общий анти-спам (`services/messaging/daily-limit.js`, считает И `care_touch_sends`, И `reminder_queue`) → отложить; будущая запись под условия → cancel; повторный визит → cancel. Сбой YClients на двух последних — fail-open с WARN.
- `rule_id` в `reminder_queue` — `ON DELETE SET NULL` плюс денормализованный `rule_title` (в «Заботе» журнал уходит каскадом, здесь так нельзя: история «кому что по какому правилу» — требование заказчика). Строки удалённых правил join аренды не вернёт, их гасит `ORPHAN_SQL` каждым тиком.
- Атрибуция: запись, созданная в окне `attribution_days` после отправки и подходящая под условия правила, размечается `conversion_record_id`; `attendance=1` по ней проставляет `visited_at`. Побеждает САМАЯ СВЕЖАЯ подходящая отправка.
- Догон по базе (`backfill.js` + ручки `/rules/:id/backfill[/preview]`): нужен потому, что бэкфилла нет по построению — у нового правила очередь пуста. Будущие записи берутся из ТОЙ ЖЕ сводной выдачи `/records` (диапазон захватывает +90 дней) — по запросу на каждого клиента догон в сотни человек стоил бы сотни обращений к YClients. Постановка идёт с капом на день: веерная рассылка в одну минуту исключена.
- `LEASE_SQL` обязан проходить живой EXPLAIN на дев-БД: на алиас цели UPDATE нельзя ссылаться из ON-условий джойнов, имя клиента берётся скалярным подзапросом в RETURNING (тот же урок, что в care-воркере). Юнит-моки `db.any` валидность SQL не проверяют.
- Конструктор условий общий с «Заботой» — `frontend/js/pages/conditions-editor.js`, адресация по префиксу `ns` (`care` / `reminders`).
- Живая проверка — `scripts/reminders-e2e.js`: по умолчанию отправка и начисление застаблены, боевые пути включаются флагами `--send` и `--accrue`.
```

- [ ] **Step 2: Commit**

```bash
cd /root/loyalpro && git add CLAUDE.md && git commit -m "docs: модуль напоминаний о повторном визите в CLAUDE.md"
```

---

## Порядок и зависимости

Задачи 2, 3, 4, 6 независимы друг от друга — их можно делать параллельно после задачи 1. Задачи 7 и 9 зависят от 4 и 6, задача 9 — ещё и от 5 и 8. Задача 10 продолжает 9, задача 12 зависит от 11, задача 14 — от 13.

Критический путь: 1 → 4 → 7 → 9 → 10 → 12 → 14 → 15 → 16.

## Что проверить перед выкатом на прод

- Все правила на проде создаются **выключенными**, включать после прогона догона в режиме превью.
- `AGENT_CATALOG_IN_PROMPT` и прочие env не затрагиваются — новых переменных окружения модуль не вводит.
- Первый прод-прогон делать при `bonus_enabled=false`: убедиться, что тексты и гейты работают, и только потом включать деньги.

