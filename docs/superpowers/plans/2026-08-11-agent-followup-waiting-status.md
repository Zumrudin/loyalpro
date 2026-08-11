# Ожидание ответа клиента: статусы переписки и автонапоминания — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Мила отслеживает диалоги, где пациент замолчал после её реплики, показывает это
администратору чипом в списке диалогов и сама возвращается к молчащему диалогу — напоминание
через 15 минут (текст пишет LLM) и финальное сообщение через 60 минут (готовый шаблон).

**Architecture:** Очередь `agent_followups` — одна живая строка на диалог, по образцу
`reminder_queue` и `care_touch_sends`. Строку заводит диспетчер в единой точке доставки реплик;
гасят её вебхук (входящее), пауза оператора и сам воркер перед отправкой. Воркер
(`* * * * *`) арендует просроченные строки `FOR UPDATE SKIP LOCKED`, гоняет гейты от дешёвых к
дорогим и шлёт тем же путём, что диспетчер. Статус переписки не хранится — выводится из строки
очереди и `agent_dialogs`.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`, без ORM), jest для бэкенда, `node --test` для
чистых фронтовых модулей, ванильный JS на фронте, `node-cron`.

**Спека:** `docs/superpowers/specs/2026-08-11-agent-followup-waiting-status-design.md`

**Два уточнения к спеке, принятые при написании плана** (спека обновлена):

1. Выдуманное время в тексте напоминания ведёт к **отказу от отправки** (`cancelled`), а не к
   вырезанию подстроки: вырезание рвёт фразу и оставляет пациенту огрызок. Молчание безопаснее —
   тот же принцип, что в `parseCareDecision`.
2. Дефолт `followup_delay1_min` в БД — **0 (выключено)**, а не 15. Выкат не должен сам начать
   писать живым пациентам; 15/60 подставляет форма в админке как рекомендуемые значения.

---

## Структура файлов

**Создаются:**

| Файл | Ответственность |
|---|---|
| `backend/services/agent/followup-schedule.js` | чистый расчёт: сроки, стадии, позднее время |
| `backend/services/agent/followup-queue.js` | тонкие обёртки над SQL очереди (постановка, гашение) |
| `backend/services/agent/followup-prompt.js` | промпт напоминания (только stage 0) |
| `backend/services/agent/followup-guard.js` | чистая проверка «время выдумано» |
| `backend/services/agent/followup-worker.js` | аренда, гейты, отправка |
| `backend/agent-followup-schedule.test.js` | юниты чистого расчёта |
| `backend/agent-followup-queue.test.js` | юниты SQL-обёрток на моке `db` |
| `backend/agent-followup-prompt.test.js` | юниты промпта |
| `backend/agent-followup-guard.test.js` | юниты guard'а |
| `backend/agent-followup-worker.test.js` | юниты воркера на инжектированных deps |
| `backend/agent-followup-settings.test.js` | юниты валидации настроек |
| `backend/scripts/agent-followup-e2e.js` | живой прогон (LLM реальный, отправка застаблена) |
| `frontend/js/pages/chat-wait-status.js` | чистый модуль чипа и фильтра |
| `frontend/js/pages/chat-wait-status.test.js` | `node --test` |

**Изменяются:**

| Файл | Что |
|---|---|
| `backend/migrations.js` | таблица `agent_followups`, колонки `agent_settings` |
| `backend/services/agent-settings.js` | чтение/запись новых полей |
| `backend/routes/agent-settings.js` | код ошибки валидации |
| `backend/services/agent/orchestrator.js` | вернуть `writeSucceeded` наружу |
| `backend/services/agent/dispatcher.js` | постановка строки после доставки |
| `backend/services/agent/dialog-state.js` | гашение при паузе оператора |
| `backend/routes/chatpush-webhook.js` | гашение при входящем |
| `backend/routes/chat.js` | JOIN очереди в `/dialogs`, гашение кнопкой |
| `backend/services/chat-events.js` | SSE-событие `followup_status` |
| `backend/server.js` | крон воркера |
| `frontend/js/pages/chat.js` | чип, фильтр, обработчик SSE |
| `frontend/js/pages/agent-settings.js` | поля настроек |
| `frontend/index.html` | разметка настроек, `<script>` нового модуля |
| `CLAUDE.md` | раздел про фичу |

---

## Task 1: Схема БД

**Files:**
- Modify: `backend/migrations.js`

- [ ] **Step 1: Добавить таблицу очереди**

В `migrations.js` найти блок с `CREATE TABLE IF NOT EXISTS agent_dialogs` (около строки 1562) и
сразу ПОСЛЕ его индекса `agent_dialogs_lookup_idx` вставить:

```js
  // ── Ожидание ответа клиента: очередь напоминаний Милы о себе ──
  // Одна ЖИВАЯ строка на диалог (частичный уникальный индекс ниже), завершённые
  // остаются историей: по ним разбирается, кому и почему написали. Спека —
  // docs/superpowers/specs/2026-08-11-agent-followup-waiting-status-design.md.
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_followups (
      id              SERIAL PRIMARY KEY,
      salon_id        INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      dialog_key      TEXT NOT NULL,
      phone           TEXT,
      channel         VARCHAR(32),
      chat_id         TEXT,
      anchor_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      stage           SMALLINT NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'scheduled',
      close_reason    TEXT,
      next_at         TIMESTAMPTZ NOT NULL,
      nudge1_at       TIMESTAMPTZ,
      final_at        TIMESTAMPTZ,
      rendered_text   TEXT,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `).catch(() => {});
  // Одна живая строка на диалог. Частичный индекс, а не UNIQUE(salon_id,
  // dialog_key): завершённые строки обязаны накапливаться историей.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_followups_live_uniq
      ON agent_followups (salon_id, dialog_key) WHERE status = 'scheduled'
  `).catch(() => {});
  // Ключ аренды. Тай-брейк по id обязателен: строки одной минуты иначе идут
  // в неспецифицированном порядке.
  await client.query(`
    CREATE INDEX IF NOT EXISTS agent_followups_due_idx
      ON agent_followups (next_at, id) WHERE status = 'scheduled'
  `).catch(() => {});
  // Чип в списке диалогов берёт ПОСЛЕДНЮЮ строку по диалогу.
  await client.query(`
    CREATE INDEX IF NOT EXISTS agent_followups_dialog_idx
      ON agent_followups (salon_id, dialog_key, created_at DESC)
  `).catch(() => {});
```

- [ ] **Step 2: Добавить колонки настроек**

Найти блок `ALTER TABLE agent_settings … ADD COLUMN IF NOT EXISTS price_list_url` (около строки
1537) и сразу после него вставить:

```js
  // Напоминания Милы о себе. delay1=0 — ВЫКЛЮЧЕНО, и это дефолт: выкат не
  // должен сам начать писать живым пациентам, салон включает фичу явно.
  // latest_time пустой = верхней границы нет (действует только окно расписания).
  await client.query(`
    ALTER TABLE agent_settings
      ADD COLUMN IF NOT EXISTS followup_delay1_min INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS followup_delay2_min INTEGER NOT NULL DEFAULT 60,
      ADD COLUMN IF NOT EXISTS followup_final_text TEXT,
      ADD COLUMN IF NOT EXISTS followup_latest_time VARCHAR(5)
  `).catch(() => {});
```

- [ ] **Step 3: Прогнать миграции и проверить схему**

Run: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro && sleep 4 && pm2 logs loyalpro --lines 30 --nostream | grep -i migrat`

Затем через MCP PostgreSQL (`mcp__postgres__query`, НЕ через psql):

```sql
SELECT column_name, data_type, column_default
  FROM information_schema.columns WHERE table_name = 'agent_followups' ORDER BY ordinal_position;
SELECT indexname FROM pg_indexes WHERE tablename = 'agent_followups';
SELECT column_name, column_default FROM information_schema.columns
  WHERE table_name = 'agent_settings' AND column_name LIKE 'followup%';
```

Expected: 18 колонок `agent_followups`, три индекса (`agent_followups_live_uniq`,
`agent_followups_due_idx`, `agent_followups_dialog_idx`) плюс PK, четыре колонки `followup_*` в
`agent_settings` с дефолтом `0` у `followup_delay1_min`.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations.js
git commit -m "feat(agent): схема очереди agent_followups и настройки напоминаний о себе"
```

---

## Task 2: Чистый расчёт сроков (`followup-schedule.js`)

**Files:**
- Create: `backend/services/agent/followup-schedule.js`
- Test: `backend/agent-followup-schedule.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/agent-followup-schedule.test.js`:

```js
'use strict';

const {
  resolveDelays, nextAtFor, isTooLate,
  DEFAULT_DELAY1_MIN, DEFAULT_DELAY2_MIN,
} = require('./services/agent/followup-schedule');

describe('resolveDelays', () => {
  test('нули и мусор → фича выключена', () => {
    expect(resolveDelays({ followupDelay1Min: 0, followupDelay2Min: 60 }).enabled).toBe(false);
    expect(resolveDelays({}).enabled).toBe(false);
    expect(resolveDelays({ followupDelay1Min: 'нет', followupDelay2Min: 60 }).enabled).toBe(false);
  });

  test('нормальные значения проходят как есть', () => {
    expect(resolveDelays({ followupDelay1Min: 15, followupDelay2Min: 60 }))
      .toEqual({ enabled: true, delay1: 15, delay2: 60 });
  });

  // Второй интервал меряется от ЯКОРЯ, а не от первого напоминания. Значение,
  // не превышающее первый, означало бы «финал раньше напоминания» — берём
  // безопасный дефолт, а не отправляем два сообщения подряд.
  test('второй интервал не больше первого → дефолт', () => {
    expect(resolveDelays({ followupDelay1Min: 30, followupDelay2Min: 20 }))
      .toEqual({ enabled: true, delay1: 30, delay2: DEFAULT_DELAY2_MIN });
  });
});

describe('nextAtFor', () => {
  const anchor = new Date('2026-08-11T10:00:00.000Z');

  test('stage 0 → якорь + первый интервал', () => {
    expect(nextAtFor({ anchorAt: anchor, stage: 0, delay1Min: 15, delay2Min: 60 }).toISOString())
      .toBe('2026-08-11T10:15:00.000Z');
  });

  test('stage 1 → якорь + второй интервал (не «плюс 60 к напоминанию»)', () => {
    expect(nextAtFor({ anchorAt: anchor, stage: 1, delay1Min: 15, delay2Min: 60 }).toISOString())
      .toBe('2026-08-11T11:00:00.000Z');
  });

  test('stage 2 — финал уже отправлен, срока больше нет', () => {
    expect(nextAtFor({ anchorAt: anchor, stage: 2, delay1Min: 15, delay2Min: 60 })).toBeNull();
  });

  test('битый якорь → null, а не Invalid Date в БД', () => {
    expect(nextAtFor({ anchorAt: 'вчера', stage: 0, delay1Min: 15, delay2Min: 60 })).toBeNull();
  });
});

describe('isTooLate', () => {
  // 21:30 мск = 18:30 UTC.
  const at = new Date('2026-08-11T18:30:00.000Z');

  test('пустая граница → ограничения нет', () => {
    expect(isTooLate(at, null)).toBe(false);
    expect(isTooLate(at, '')).toBe(false);
  });

  test('позже границы → поздно', () => {
    expect(isTooLate(at, '21:00')).toBe(true);
  });

  test('ровно на границе → ещё можно (граница включающая)', () => {
    expect(isTooLate(at, '21:30')).toBe(false);
  });

  test('раньше границы → можно', () => {
    expect(isTooLate(at, '22:00')).toBe(false);
  });

  // Битая граница не должна МОЛЧА запрещать напоминания: fail-open в прежнее
  // поведение — тот же принцип, что у расписания в agent-gate.
  test('битая граница игнорируется', () => {
    expect(isTooLate(at, '25:99')).toBe(false);
    expect(isTooLate(at, 'вечером')).toBe(false);
  });
});

describe('константы дефолтов', () => {
  test('совпадают с рекомендованными значениями формы', () => {
    expect(DEFAULT_DELAY1_MIN).toBe(15);
    expect(DEFAULT_DELAY2_MIN).toBe(60);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-schedule --silent`
Expected: FAIL — `Cannot find module './services/agent/followup-schedule'`

- [ ] **Step 3: Реализовать модуль**

Создать `backend/services/agent/followup-schedule.js`:

```js
'use strict';
// ============================================================
// Ожидание ответа клиента — ЧИСТЫЙ расчёт сроков. Ни БД, ни сети.
//
// Лестница: t0 (доставка реплики Милы) + delay1 → напоминание,
// t0 + delay2 → финальное сообщение. ОБА срока меряются от ЯКОРЯ, а не
// «плюс N к предыдущему касанию»: администратор в форме задаёт «через
// сколько после нашего ответа», и цепочка «+15, потом ещё +60» дала бы
// финал на 75-й минуте вместо 60-й.
//
// Юнит-тесты: agent-followup-schedule.test.js
// ============================================================

const { parseHhMm, nowMskMinutes } = require('../agent-gate');

// Рекомендованные значения формы. В БД дефолт delay1 = 0 (выключено): выкат
// не должен сам начать писать живым пациентам.
const DEFAULT_DELAY1_MIN = 15;
const DEFAULT_DELAY2_MIN = 60;

// Верхняя граница интервала: сутки. Больше — это уже не «напомнить о себе»,
// а плановое напоминание (services/reminders) с его собственными правилами.
const MAX_DELAY_MIN = 1440;

function toPositiveInt(raw, max) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > max) return null;
  return n;
}

/**
 * Нормализовать интервалы салона.
 * @param {object} settings настройки агента (camelCase, services/agent-settings)
 * @returns {{enabled:boolean, delay1:number, delay2:number}}
 *   enabled=false означает «в этом салоне не напоминаем» — либо явный 0,
 *   либо мусор в колонке (рассинхрон схемы с кодом: молча слать нельзя).
 */
function resolveDelays(settings = {}) {
  const d1 = toPositiveInt(settings.followupDelay1Min, MAX_DELAY_MIN);
  if (!d1) return { enabled: false, delay1: 0, delay2: 0 };
  const d2raw = toPositiveInt(settings.followupDelay2Min, MAX_DELAY_MIN);
  // Финал обязан быть ПОЗЖЕ напоминания: иначе два сообщения ушли бы подряд.
  const d2 = d2raw && d2raw > d1 ? d2raw : DEFAULT_DELAY2_MIN;
  return { enabled: true, delay1: d1, delay2: d2 > d1 ? d2 : d1 + DEFAULT_DELAY2_MIN };
}

/**
 * Срок следующего касания.
 * @param {object} o
 * @param {Date|string|number} o.anchorAt момент доставки реплики Милы
 * @param {number} o.stage 0 — ждём напоминания, 1 — ждём финала, 2 — всё сказано
 * @returns {Date|null} null — срока больше нет либо якорь битый
 */
function nextAtFor({ anchorAt, stage, delay1Min, delay2Min } = {}) {
  const base = new Date(anchorAt).getTime();
  if (!Number.isFinite(base)) return null;
  const minutes = stage === 0 ? delay1Min : stage === 1 ? delay2Min : null;
  if (!Number.isFinite(minutes) || minutes === null) return null;
  return new Date(base + minutes * 60000);
}

/**
 * Позже ли момент верхней границы суток. Граница ВКЛЮЧАЮЩАЯ (21:00 при
 * границе '21:00' — ещё можно): круглое значение в форме читается как «до
 * девяти вечера», а не «до 20:59».
 * Битая или пустая граница → false (fail-open): выдуманный запрет молча
 * лишил бы пациента ответа — тот же принцип, что у расписания в agent-gate.
 */
function isTooLate(at, latestTime) {
  const limit = parseHhMm(latestTime);
  if (limit === null) return false;
  const when = new Date(at);
  if (!Number.isFinite(when.getTime())) return false;
  return nowMskMinutes(when) > limit;
}

module.exports = {
  resolveDelays, nextAtFor, isTooLate,
  DEFAULT_DELAY1_MIN, DEFAULT_DELAY2_MIN, MAX_DELAY_MIN,
};
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-schedule --silent`
Expected: PASS, 12 тестов

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/followup-schedule.js backend/agent-followup-schedule.test.js
git commit -m "feat(agent): чистый расчёт сроков напоминаний о себе"
```

---

## Task 3: Настройки салона

**Files:**
- Modify: `backend/services/agent-settings.js:12-74`
- Modify: `backend/routes/agent-settings.js:53-63`
- Test: `backend/agent-followup-settings.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/agent-followup-settings.test.js`:

```js
'use strict';

// Проверяем ЧИСТУЮ часть: нормализацию тела запроса. Работа с БД (INSERT …
// ON CONFLICT) в юните не нужна — её покрывает живой прогон настроек.
const { pickFollowup } = require('./services/agent-settings');

const cur = {
  followupDelay1Min: 15, followupDelay2Min: 60,
  followupFinalText: 'старый текст', followupLatestTime: '03:00',
};

describe('pickFollowup', () => {
  // ГОТЧА контракта роута: PUT /api/agent/settings трактует ОТСУТСТВИЕ
  // enabled/mode как «выключено». Новые поля обязаны вести себя иначе, иначе
  // сохранение одного интервала гасило бы остальные настройки.
  test('поле не передано → остаётся текущее значение', () => {
    expect(pickFollowup({}, cur)).toEqual(cur);
    expect(pickFollowup({ followupDelay1Min: null }, cur).followupDelay1Min).toBe(15);
  });

  test('явный 0 — законное «не напоминать»', () => {
    expect(pickFollowup({ followupDelay1Min: 0 }, cur).followupDelay1Min).toBe(0);
  });

  test('пустая строка в тексте — осознанная очистка', () => {
    expect(pickFollowup({ followupFinalText: '' }, cur).followupFinalText).toBe(null);
  });

  test('пустая строка во времени — снять верхнюю границу', () => {
    expect(pickFollowup({ followupLatestTime: '' }, cur).followupLatestTime).toBe(null);
  });

  test('корректное время сохраняется', () => {
    expect(pickFollowup({ followupLatestTime: '22:30' }, cur).followupLatestTime).toBe('22:30');
  });

  test('битое время → BAD_TIME', () => {
    expect(() => pickFollowup({ followupLatestTime: '25:00' }, cur)).toThrow(
      expect.objectContaining({ code: 'BAD_TIME' }));
  });

  test('нечисловой или отрицательный интервал → BAD_FOLLOWUP', () => {
    expect(() => pickFollowup({ followupDelay1Min: -5 }, cur)).toThrow(
      expect.objectContaining({ code: 'BAD_FOLLOWUP' }));
    expect(() => pickFollowup({ followupDelay2Min: 'час' }, cur)).toThrow(
      expect.objectContaining({ code: 'BAD_FOLLOWUP' }));
  });

  test('финал не позже напоминания → BAD_FOLLOWUP (при включённой фиче)', () => {
    expect(() => pickFollowup({ followupDelay1Min: 30, followupDelay2Min: 30 }, cur)).toThrow(
      expect.objectContaining({ code: 'BAD_FOLLOWUP' }));
  });

  test('текст режется по потолку', () => {
    const long = 'а'.repeat(2000);
    expect(pickFollowup({ followupFinalText: long }, cur).followupFinalText.length).toBe(1200);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-settings --silent`
Expected: FAIL — `pickFollowup is not a function`

- [ ] **Step 3: Реализовать в `services/agent-settings.js`**

3a. В объект `DEFAULTS` (строка 12) добавить поля:

```js
const DEFAULTS = {
  enabled: false, mode: 'all',
  scheduleEnabled: false, scheduleStart: '22:00', scheduleEnd: '09:30',
  priceListUrl: null,
  // Напоминания Милы о себе. delay1=0 — выключено (дефолт схемы): выкат не
  // должен сам начать писать живым пациентам.
  followupDelay1Min: 0, followupDelay2Min: 60,
  followupFinalText: null, followupLatestTime: null,
};
```

3b. В `rowToSettings` (строка 19) добавить:

```js
    priceListUrl: row.price_list_url || null,
    followupDelay1Min: Number(row.followup_delay1_min) || 0,
    followupDelay2Min: Number(row.followup_delay2_min) || DEFAULTS.followupDelay2Min,
    followupFinalText: row.followup_final_text || null,
    followupLatestTime: row.followup_latest_time || null,
```

3c. Сразу после функции `pickTime` добавить:

```js
// Потолок финального текста. Совпадает с лимитом strict-режима «Заботы»:
// это готовое сообщение живому пациенту, а не служебная строка.
const FOLLOWUP_TEXT_MAX = 1200;
const FOLLOWUP_DELAY_MAX = 1440;

function badFollowup(msg) {
  const e = new Error(msg); e.code = 'BAD_FOLLOWUP'; return e;
}

function pickDelay(raw, current) {
  if (raw === undefined || raw === null || raw === '') return current;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > FOLLOWUP_DELAY_MAX)
    throw badFollowup('bad followup delay');
  return n;
}

/**
 * Нормализовать поля напоминаний из тела запроса.
 * ОТСУТСТВИЕ поля (undefined/null/'') означает «не передано» и сохраняет
 * текущее значение — в отличие от enabled/mode, где отсутствие означает
 * «выключено» (прежний контракт роута, менять его нельзя). Иначе точечное
 * сохранение одного интервала молча стёрло бы остальные настройки.
 * Пустая строка в ТЕКСТЕ и во ВРЕМЕНИ — осознанная очистка (там '' отличимо
 * от «не передано» по смыслу поля: пустой текст и снятая граница законны).
 */
function pickFollowup(body = {}, cur = {}) {
  const delay1 = pickDelay(body.followupDelay1Min, cur.followupDelay1Min || 0);
  const delay2 = pickDelay(body.followupDelay2Min, cur.followupDelay2Min || DEFAULTS.followupDelay2Min);
  // Проверяем, только когда напоминания включены: при delay1=0 второе поле
  // ни на что не влияет, и запрещать его форме незачем.
  if (delay1 > 0 && !(delay2 > delay1))
    throw badFollowup('followup delay2 must be greater than delay1');
  const rawText = body.followupFinalText;
  const finalText = rawText === undefined || rawText === null
    ? (cur.followupFinalText || null)
    : (String(rawText).trim().slice(0, FOLLOWUP_TEXT_MAX) || null);
  const rawTime = body.followupLatestTime;
  let latest;
  if (rawTime === undefined || rawTime === null) latest = cur.followupLatestTime || null;
  else if (String(rawTime).trim() === '') latest = null;
  else {
    if (parseHhMm(rawTime) === null) { const e = new Error('bad time'); e.code = 'BAD_TIME'; throw e; }
    latest = String(rawTime).trim();
  }
  return {
    followupDelay1Min: delay1, followupDelay2Min: delay2,
    followupFinalText: finalText, followupLatestTime: latest,
  };
}
```

3d. В `updateSettings` (строка 50) после вычисления `priceUrl` добавить `const fu = pickFollowup(body || {}, cur);` и заменить INSERT:

```js
  const row = await db.one(
    `INSERT INTO agent_settings
       (salon_id, enabled, mode, schedule_enabled, schedule_start, schedule_end, price_list_url,
        followup_delay1_min, followup_delay2_min, followup_final_text, followup_latest_time, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT (salon_id) DO UPDATE SET
       enabled=$2, mode=$3, schedule_enabled=$4,
       schedule_start=$5, schedule_end=$6, price_list_url=$7,
       followup_delay1_min=$8, followup_delay2_min=$9,
       followup_final_text=$10, followup_latest_time=$11, updated_at=NOW()
     RETURNING enabled, mode, schedule_enabled, schedule_start, schedule_end, price_list_url,
               followup_delay1_min, followup_delay2_min, followup_final_text, followup_latest_time`,
    [salonId, !!enabled, m, schedOn, start, end, priceUrl,
     fu.followupDelay1Min, fu.followupDelay2Min, fu.followupFinalText, fu.followupLatestTime]
  );
```

3e. В `getSettings` (строка 39) расширить `SELECT`:

```js
    `SELECT enabled, mode, schedule_enabled, schedule_start, schedule_end, price_list_url,
            followup_delay1_min, followup_delay2_min, followup_final_text, followup_latest_time
       FROM agent_settings WHERE salon_id=$1`, [salonId]
```

3f. В `module.exports` добавить `pickFollowup`.

- [ ] **Step 4: Добавить код ошибки в роут**

В `backend/routes/agent-settings.js` в обработчик ошибок `PUT /settings` (строка 57) добавить
ПЕРЕД `logger.error`:

```js
    if (e.code === 'BAD_FOLLOWUP')
      return res.status(400).json({ error: 'Интервалы напоминаний: 0–1440 минут, второй строго больше первого' });
```

- [ ] **Step 5: Запустить тесты**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-settings agent-settings --silent`
Expected: PASS, новые 9 тестов зелёные, старые тесты настроек не сломаны

- [ ] **Step 6: Commit**

```bash
git add backend/services/agent-settings.js backend/routes/agent-settings.js backend/agent-followup-settings.test.js
git commit -m "feat(agent): настройки напоминаний о себе (интервалы, финальный текст, поздний час)"
```

---

## Task 4: Очередь — SQL-обёртки

**Files:**
- Create: `backend/services/agent/followup-queue.js`
- Test: `backend/agent-followup-queue.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/agent-followup-queue.test.js`:

```js
'use strict';

const queue = require('./services/agent/followup-queue');

// Мок пула: собираем вызовы, отдаём заранее подготовленные результаты.
function mockDb(result = { rowCount: 1, rows: [] }) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return result; },
    oneOrNone: async (sql, params) => { calls.push({ sql, params }); return result.rows[0] || null; },
  };
}

const SETTINGS = { followupDelay1Min: 15, followupDelay2Min: 60 };
const META = { phone: '79200255591', channel: 'whatsapp', chatId: null };

describe('schedule', () => {
  test('выключенная фича не пишет в БД вовсе', async () => {
    const db = mockDb();
    const r = await queue.schedule(1, '79200255591', META,
      { followupDelay1Min: 0, followupDelay2Min: 60 }, { db });
    expect(r).toBe(false);
    expect(db.calls).toHaveLength(0);
  });

  test('ставит строку на якорь + первый интервал', async () => {
    const db = mockDb();
    const anchor = new Date('2026-08-11T10:00:00.000Z');
    await queue.schedule(1, '79200255591', META, SETTINGS, { db, now: anchor });
    expect(db.calls).toHaveLength(1);
    const { sql, params } = db.calls[0];
    expect(sql).toMatch(/INSERT INTO agent_followups/);
    // Свежая реплика Милы перезаводит ожидание: якорь и стадия сбрасываются.
    expect(sql).toMatch(/ON CONFLICT/);
    expect(params[1]).toBe('79200255591');
    expect(new Date(params[6]).toISOString()).toBe('2026-08-11T10:15:00.000Z');
  });

  test('без dialogKey не пишет ничего', async () => {
    const db = mockDb();
    expect(await queue.schedule(1, '', META, SETTINGS, { db })).toBe(false);
    expect(db.calls).toHaveLength(0);
  });

  test('сбой БД не бросает наружу — ход клиента важнее строки очереди', async () => {
    const db = { query: async () => { throw new Error('db down'); } };
    await expect(queue.schedule(1, 'k', META, SETTINGS, { db })).resolves.toBe(false);
  });
});

describe('close', () => {
  test('гасит только живую строку и пишет причину', async () => {
    const db = mockDb({ rowCount: 1, rows: [] });
    await queue.close(1, '79200255591', 'answered', 'client_replied', { db });
    const { sql, params } = db.calls[0];
    expect(sql).toMatch(/UPDATE agent_followups/);
    expect(sql).toMatch(/status\s*=\s*'scheduled'/);
    expect(params).toEqual([1, '79200255591', 'answered', 'client_replied']);
  });

  test('неизвестный статус отвергается — опечатка не должна писать мусор', async () => {
    const db = mockDb();
    await expect(queue.close(1, 'k', 'ответили', 'x', { db })).rejects.toThrow(/bad status/);
  });

  test('сбой БД не бросает наружу', async () => {
    const db = { query: async () => { throw new Error('db down'); } };
    await expect(queue.close(1, 'k', 'answered', 'client_replied', { db })).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-queue --silent`
Expected: FAIL — `Cannot find module './services/agent/followup-queue'`

- [ ] **Step 3: Реализовать модуль**

Создать `backend/services/agent/followup-queue.js`:

```js
'use strict';
// ============================================================
// Очередь ожидания ответа клиента — тонкие обёртки над SQL.
//
// ВСЁ здесь BEST-EFFORT: сбой БД не имеет права уронить ход диалога или
// обработку вебхука. Не поставили строку — пациент просто не получит
// напоминания; бросили бы исключение — остались бы без ответа вовсе.
//
// Юнит-тесты: agent-followup-queue.test.js
// ============================================================

const { db: realDb } = require('../../db');
const { resolveDelays, nextAtFor } = require('./followup-schedule');
const { createLogger } = require('../../logger');

const log = createLogger('Followup');

// Терминальные статусы. Держим списком, а не свободной строкой: опечатка в
// имени статуса иначе молча создала бы строку, которую не видит ни чип, ни
// аренда.
const CLOSE_STATUSES = new Set(['answered', 'cancelled', 'expired', 'done', 'failed']);

/**
 * Завести (или перезавести) ожидание ответа после реплики Милы.
 * ON CONFLICT сбрасывает якорь и стадию: свежая реплика начинает отсчёт
 * заново — предыдущее ожидание этим же ответом и закрыто по смыслу.
 * @returns {Promise<boolean>} поставлена ли строка
 */
async function schedule(salonId, dialogKey, meta = {}, settings = {}, opts = {}) {
  const db = opts.db || realDb;
  if (!salonId || !dialogKey) return false;
  const { enabled, delay1, delay2 } = resolveDelays(settings);
  if (!enabled) return false;
  const anchor = opts.now ? new Date(opts.now) : new Date();
  const next = nextAtFor({ anchorAt: anchor, stage: 0, delay1Min: delay1, delay2Min: delay2 });
  if (!next) return false;
  try {
    await db.query(
      `INSERT INTO agent_followups
         (salon_id, dialog_key, phone, channel, chat_id, anchor_at, next_at,
          stage, status, close_reason, attempts, last_attempt_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,'scheduled',NULL,0,NULL,now())
       ON CONFLICT (salon_id, dialog_key) WHERE status='scheduled'
       DO UPDATE SET phone=$3, channel=$4, chat_id=$5, anchor_at=$6, next_at=$7,
                     stage=0, close_reason=NULL, attempts=0, last_attempt_at=NULL,
                     updated_at=now()`,
      [salonId, dialogKey, meta.phone || null, meta.channel || null, meta.chatId || null,
       anchor, next]);
    return true;
  } catch (e) {
    log.warn(`dialog ${dialogKey}: не поставить ожидание ответа (${e.message})`);
    return false;
  }
}

/**
 * Погасить живую строку диалога.
 * @param {string} status один из CLOSE_STATUSES
 * @param {string} reason машинная причина (client_replied, operator, …)
 * @returns {Promise<boolean>} была ли строка (false и при сбое БД)
 */
async function close(salonId, dialogKey, status, reason, opts = {}) {
  const db = opts.db || realDb;
  if (!CLOSE_STATUSES.has(status)) throw new Error(`bad status: ${status}`);
  if (!salonId || !dialogKey) return false;
  try {
    const r = await db.query(
      `UPDATE agent_followups
          SET status = $3, close_reason = $4, updated_at = now()
        WHERE salon_id = $1 AND dialog_key = $2 AND status = 'scheduled'`,
      [salonId, dialogKey, status, reason || null]);
    return !!(r && r.rowCount);
  } catch (e) {
    log.warn(`dialog ${dialogKey}: не погасить ожидание ответа (${e.message})`);
    return false;
  }
}

module.exports = { schedule, close, CLOSE_STATUSES };
```

- [ ] **Step 4: Запустить тест**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-queue --silent`
Expected: PASS, 7 тестов

- [ ] **Step 5: Проверить SQL живьём**

`ON CONFLICT … WHERE` с частичным индексом моки не проверяют. Через
`mcp__postgres__query` на дев-БД:

```sql
INSERT INTO agent_followups (salon_id, dialog_key, anchor_at, next_at)
VALUES (1, 'test-followup-key', now(), now() + interval '15 minutes')
ON CONFLICT (salon_id, dialog_key) WHERE status='scheduled'
DO UPDATE SET next_at = EXCLUDED.next_at, updated_at = now();
```

Выполнить ДВАЖДЫ. Expected: обе команды успешны, строка одна:

```sql
SELECT count(*) FROM agent_followups WHERE dialog_key = 'test-followup-key';
DELETE FROM agent_followups WHERE dialog_key = 'test-followup-key';
```

- [ ] **Step 6: Commit**

```bash
git add backend/services/agent/followup-queue.js backend/agent-followup-queue.test.js
git commit -m "feat(agent): очередь ожидания ответа — постановка и гашение строки"
```

---

## Task 5: Постановка строки из диспетчера

**Files:**
- Modify: `backend/services/agent/orchestrator.js:1158-1160`
- Modify: `backend/services/agent/dispatcher.js:127-149, 261-270`
- Test: `backend/agent-followup-worker.test.js` (создаётся здесь, дополняется в Task 8)

- [ ] **Step 1: Написать падающий тест на решение «ставить или нет»**

Решение о постановке — чистое, вынесем его отдельной функцией, чтобы не гонять весь диспетчер.
Создать `backend/agent-followup-worker.test.js`:

```js
'use strict';

const { shouldAwaitReply } = require('./services/agent/followup-queue');

describe('shouldAwaitReply', () => {
  const ok = { delivered: true, writeSucceeded: false, escalated: false, silent: false };

  test('обычный ответ Милы → ждём клиента', () => {
    expect(shouldAwaitReply(ok)).toBe(true);
  });

  test('реплики не доставлены → ждать нечего', () => {
    expect(shouldAwaitReply({ ...ok, delivered: false })).toBe(false);
  });

  // Запись оформлена: молчание пациента означает «всё понятно», а не лид.
  test('запись оформлена в этом ходу → не ждём', () => {
    expect(shouldAwaitReply({ ...ok, writeSucceeded: true })).toBe(false);
  });

  test('диалог ушёл на человека → не ждём', () => {
    expect(shouldAwaitReply({ ...ok, escalated: true })).toBe(false);
  });

  // closing.js и высокая оценка визита: Мила сознательно промолчала.
  test('ход решил промолчать → не ждём', () => {
    expect(shouldAwaitReply({ ...ok, silent: true })).toBe(false);
  });

  test('пустой аргумент не роняет вызов', () => {
    expect(shouldAwaitReply()).toBe(false);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-worker --silent`
Expected: FAIL — `shouldAwaitReply is not a function`

- [ ] **Step 3: Добавить `shouldAwaitReply` в `followup-queue.js`**

Перед `module.exports` в `backend/services/agent/followup-queue.js`:

```js
/**
 * Ждём ли ответа клиента после этого хода.
 *
 * Три из четырёх утверждённых исключений сюда даже не доходят и это НЕ
 * забытые проверки: служебные исходящие (автоуведомления YClients, касания
 * «Заботы», плановые напоминания) идут мимо диспетчера, closing.js и высокая
 * оценка визита возвращают silent без реплик, низкая — сразу эскалирует.
 * Четвёртое («Мила вежливо отказала») детерминированного признака не имеет и
 * отсекается LLM-проходом воркера через skip.
 */
function shouldAwaitReply(res = {}) {
  return !!res.delivered && !res.writeSucceeded && !res.escalated && !res.silent;
}
```

И в экспорт: `module.exports = { schedule, close, shouldAwaitReply, CLOSE_STATUSES };`

- [ ] **Step 4: Запустить тест**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-worker --silent`
Expected: PASS, 6 тестов

- [ ] **Step 5: Отдать `writeSucceeded` из оркестратора**

В `backend/services/agent/orchestrator.js` в возврате около строки 1158 добавить поле:

```js
    return { replies, escalated, sideEffect, exhausted, falseSuccess, falseSuccessKind,
      bookingFailed, bookingFailRecoverable, degradedAfterWrite, turnId: evBuffer.turnId,
      // Нужен диспетчеру, чтобы не заводить ожидание ответа после оформленной
      // записи. sideEffect для этого не годится: он ШИРЕ (включает
      // escalate_to_operator).
      writeSucceeded,
      attachments: toolCtx.attachments };
```

- [ ] **Step 6: Поставить строку в диспетчере**

6a. В `backend/services/agent/dispatcher.js` добавить импорт рядом с остальными:

```js
const followupQueue = require('./followup-queue');
```

6b. В `process()` в блоке `finally` (около строки 261), СРАЗУ ПОСЛЕ строки с `markDelivered`:

```js
      if (turnId) void toolEventsLog.markDelivered(turnId, deliveredReplies);
      // Ожидание ответа клиента. ТА ЖЕ точка, что и вердикт памяти, и по той же
      // причине: веток отправки в process() уже пять, и отдельный вызов рядом с
      // каждой рано или поздно забыли бы. Best-effort и без await — строка
      // очереди не должна задерживать возврат из хода.
      if (followupQueue.shouldAwaitReply({
        delivered: deliveredReplies,
        writeSucceeded: res && res.writeSucceeded,
        escalated: res && res.escalated,
        silent: res && res.silent,
      })) {
        void settings.getSettings(salonId)
          .then(s => followupQueue.schedule(salonId, dialogKey, meta, s))
          .catch(e => logger.warn(`dialog ${dialogKey}: ожидание ответа не поставлено (${e.message})`));
      }
```

**Внимание:** `res` объявлена внутри `try` — вынести объявление наверх (`let res = null;` перед
`try`) и заменить `const res = await runDialog(...)` на `res = await runDialog(...)`, иначе в
`finally` она недоступна.

- [ ] **Step 7: Проверить, что диспетчер не сломан**

Run: `cd /root/loyalpro/backend && npx jest agent-dispatcher agent-orchestrator --silent`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add backend/services/agent/followup-queue.js backend/services/agent/orchestrator.js backend/services/agent/dispatcher.js backend/agent-followup-worker.test.js
git commit -m "feat(agent): диспетчер заводит ожидание ответа после доставленной реплики"
```

---

## Task 6: Гашение строки

**Files:**
- Modify: `backend/routes/chatpush-webhook.js:170-190`
- Modify: `backend/services/agent/dialog-state.js:49-60`
- Modify: `backend/routes/chat.js:159-190`

- [ ] **Step 1: Гасить при входящем сообщении**

В `backend/routes/chatpush-webhook.js` добавить импорт рядом с `dialogState`:

```js
const followupQueue = require('../services/agent/followup-queue');
```

И сразу ПОСЛЕ блока `adoptPhoneForChat` (около строки 176) вставить:

```js
      // Клиент ответил — ожидание закрыто. Гасим ЗДЕСЬ, а не только в воркере:
      // чип в «Чате» обязан погаснуть сразу, не дожидаясь тика. Второй рубеж —
      // перепроверка «нет входящих после anchor_at» в самом воркере: она
      // закрывает гонку «ответил ровно в момент отправки», которую этот вход
      // закрыть не может.
      if (storedNew && salonId && msg.direction === 'incoming' && !groupChat.isGroupMessage(msg)) {
        const waitKey = (msg.phone && msg.phone.trim()) || msg.chatId;
        if (waitKey) {
          await followupQueue.close(salonId, waitKey, 'answered', 'client_replied')
            .then(closed => { if (closed) chatEvents.emitFollowupStatus(salonId, waitKey, 'answered', 0); })
            .catch(e => logger.warn(`followup close failed: ${e.message}`));
        }
      }
```

- [ ] **Step 2: Гасить при паузе оператора**

В `backend/services/agent/dialog-state.js` в конец функции `pauseForOperator` (после
`emitAgentStatus`) добавить:

```js
  // Диалог ведёт человек — напоминания Милы отменяются. Лениво по той же
  // причине, что chat-events: юнит-тесты агента подключают dialog-state без
  // express-слоя.
  await require('./followup-queue').close(salonId, dialogKey, 'cancelled', 'operator');
```

То же добавить в `setStatus` — но только для перехода в `escalated`:

```js
async function setStatus(salonId, dialogKey, status, reason = null) {
  await db.query(
    `UPDATE agent_dialogs
        SET status = $3, escalated_reason = $4, updated_at = now()
      WHERE salon_id = $1 AND dialog_key = $2`,
    [salonId, dialogKey, status, reason]);
  // Эскалация Милы (escalate_to_operator) тоже закрывает ожидание: дальше
  // отвечает человек. Возврат боту ('bot') строку НЕ воскрешает — ожидание
  // заведётся заново первой же репликой Милы.
  if (status === 'escalated') {
    await require('./followup-queue').close(salonId, dialogKey, 'cancelled', 'operator');
  }
}
```

- [ ] **Step 3: Гасить кнопкой «Передать оператору»**

В `backend/routes/chat.js` в обработчике `POST /dialogs/:key/agent` после успешного upsert
добавить (импорт `followupQueue` — рядом с прочими):

```js
    if (status === 'escalated') {
      await followupQueue.close(req.user.salonId, key, 'cancelled', 'operator')
        .catch(e => logger.warn(`followup close failed: ${e.message}`));
    }
```

- [ ] **Step 4: Проверить, что ничего не сломано**

Run: `cd /root/loyalpro/backend && npx jest agent-dialog-state chat --silent`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/routes/chatpush-webhook.js backend/services/agent/dialog-state.js backend/routes/chat.js
git commit -m "feat(agent): гашение ожидания ответа — входящее, пауза и эскалация"
```

---

## Task 7: SSE-событие смены статуса

**Files:**
- Modify: `backend/services/chat-events.js:37-52`

- [ ] **Step 1: Добавить эмиттер**

В `backend/services/chat-events.js` после `emitAgentStatus`:

```js
// Смена стадии ожидания ответа клиента: чип в списке диалогов обязан
// обновиться без F5 — список перестраивается локально по SSE.
function emitFollowupStatus(salonId, dialogKey, status, stage = 0) {
  emit(salonId, { type: 'followup_status', dialogKey, status, stage: Number(stage) || 0 });
}
```

И в экспорт: `module.exports = { subscribe, unsubscribe, emit, emitAgentStatus, emitFollowupStatus };`

- [ ] **Step 2: Проверить**

Run: `cd /root/loyalpro/backend && node -e "const c=require('./services/chat-events'); c.emitFollowupStatus(1,'k','answered',0); console.log(typeof c.emitFollowupStatus)"`
Expected: `function`, без исключений

- [ ] **Step 3: Commit**

```bash
git add backend/services/chat-events.js
git commit -m "feat(chat): SSE-событие смены стадии ожидания ответа"
```

---

## Task 8: Guard выдуманного времени

**Files:**
- Create: `backend/services/agent/followup-guard.js`
- Test: `backend/agent-followup-guard.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/agent-followup-guard.test.js`:

```js
'use strict';

const { hasInventedTime, collectTimes } = require('./services/agent/followup-guard');

describe('collectTimes', () => {
  test('собирает все HH:MM', () => {
    expect([...collectTimes('Есть 12:30 и 13:30, а также 9:00')])
      .toEqual(['12:30', '13:30', '9:00']);
  });

  test('дата и цена временем не считаются', () => {
    // 11.08 — дата, 2500 ₽ — цена: двоеточия нет, в набор не попадают.
    expect([...collectTimes('11.08 приём стоит 2500 ₽')]).toEqual([]);
  });
});

describe('hasInventedTime', () => {
  const prior = 'Свободно 12:30 и 13:30. Записать вас?';

  test('время из прошлых реплик Милы — законно', () => {
    expect(hasInventedTime('Подошло ли 12:30?', prior)).toBe(false);
  });

  test('новое время — выдумка', () => {
    expect(hasInventedTime('Могу предложить 15:00', prior)).toBe(true);
  });

  test('текст без времени всегда проходит', () => {
    expect(hasInventedTime('Подскажите, удобно ли вам записаться?', prior)).toBe(false);
  });

  // Ведущий ноль: модель пишет «9:00» там, где в выдаче было «09:00».
  test('9:00 и 09:00 — одно и то же время', () => {
    expect(hasInventedTime('Ждём в 9:00', 'Свободно 09:00')).toBe(false);
  });

  test('пустая история → любое время выдумано', () => {
    expect(hasInventedTime('в 12:00', '')).toBe(true);
    expect(hasInventedTime('в 12:00', null)).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-guard --silent`
Expected: FAIL — `Cannot find module './services/agent/followup-guard'`

- [ ] **Step 3: Реализовать модуль**

Создать `backend/services/agent/followup-guard.js`:

```js
'use strict';
// ============================================================
// Напоминание о себе идёт БЕЗ инструментов: модель не видит ни слотов, ни
// каталога. Оставленная без данных, она начинает время СОЧИНЯТЬ — этот класс
// дефекта у проекта уже был (инцидент 2026-08-10, alien_time_attribution).
//
// Правило: время в напоминании законно, ТОЛЬКО если оно дословно звучало в
// прошлых репликах Милы. Нарушение → напоминание НЕ отправляется вовсе.
// Вырезать подстроку нельзя: фраза рвётся и пациент получает огрызок, а
// молчание безопаснее (тот же принцип, что fail-safe в care/decision.js).
//
// Юнит-тесты: agent-followup-guard.test.js
// ============================================================

// Границы слева/справа — не \b: в JS он считает словом только ASCII, и на
// кириллице вокруг числа срабатывал бы непредсказуемо (та же готча, что в
// address-guard).
const TIME_RE = /(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])/g;

// 'HH:MM' → минуты суток. Через число, а не строку: '9:00' и '09:00' — одно
// время, а строковое сравнение объявило бы второе выдумкой.
function toMinutes(h, m) {
  const hh = Number(h), mm = Number(m);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

/** Все времена текста в исходном написании (порядок сохраняется). */
function collectTimes(text) {
  const out = [];
  for (const m of String(text || '').matchAll(TIME_RE)) {
    if (toMinutes(m[1], m[2]) !== null) out.push(m[0]);
  }
  return out;
}

function timeMinutesSet(text) {
  const set = new Set();
  for (const m of String(text || '').matchAll(TIME_RE)) {
    const min = toMinutes(m[1], m[2]);
    if (min !== null) set.add(min);
  }
  return set;
}

/**
 * Есть ли в тексте время, которого не было в прошлых репликах Милы.
 * @param {string} text текст напоминания
 * @param {string} priorAssistantText склеенные прошлые реплики Милы
 */
function hasInventedTime(text, priorAssistantText) {
  const allowed = timeMinutesSet(priorAssistantText);
  for (const min of timeMinutesSet(text)) {
    if (!allowed.has(min)) return true;
  }
  return false;
}

module.exports = { hasInventedTime, collectTimes };
```

- [ ] **Step 4: Запустить тест**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-guard --silent`
Expected: PASS, 7 тестов

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/followup-guard.js backend/agent-followup-guard.test.js
git commit -m "feat(agent): guard выдуманного времени в напоминании о себе"
```

---

## Task 9: Промпт напоминания

**Files:**
- Create: `backend/services/agent/followup-prompt.js`
- Test: `backend/agent-followup-prompt.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/agent-followup-prompt.test.js`:

```js
'use strict';

const { buildFollowupPrompt } = require('./services/agent/followup-prompt');
const { OPERATOR_MARK } = require('./services/agent/history');

const base = {
  salonName: 'PERI CLINIC',
  clientName: 'Иванова Мария Петровна',
  transcript: [
    { direction: 'incoming', text: 'Сколько стоит биоревитализация?' },
    { direction: 'outgoing', text: 'Мария, добрый день! Биоревитализация от 12 000 ₽. Записать вас?' },
  ],
  nowMs: Date.parse('2026-08-11T09:00:00.000Z'),
};

describe('buildFollowupPrompt', () => {
  test('рамка — напоминание о себе, а не касание заботы', () => {
    const { system } = buildFollowupPrompt(base);
    expect(system).toMatch(/напомин/i);
    expect(system).not.toMatch(/забот/i);
  });

  // Уроки reminder-prompt.js: без явного «остальное — не повод молчать»
  // модель каждый раз изобретает новое основание для skip.
  test('явно перечислены и поводы промолчать, и запрет молчать без повода', () => {
    const { system } = buildFollowupPrompt(base);
    expect(system).toMatch(/НЕ ПОВОД МОЛЧАТЬ/);
    expect(system).toMatch(/"skip"/);
  });

  test('запрещено называть новые времена, цены и факты', () => {
    const { system } = buildFollowupPrompt(base);
    expect(system).toMatch(/НЕ называй/i);
  });

  test('в обращение уходит только личное имя', () => {
    const { user } = buildFollowupPrompt(base);
    expect(user).toMatch(/Мария/);
    expect(user).not.toMatch(/Петровна/);
    expect(user).not.toMatch(/Иванова/);
  });

  test('сегодняшняя дата в промпте есть', () => {
    // Без неё модель судит о давности переписки по своим представлениям —
    // измерено на прогоне 08.08.2026 в промпте напоминаний.
    expect(buildFollowupPrompt(base).system).toMatch(/11\.08\.2026|11 августа/);
  });

  test('маркер администратора в промпт не попадает', () => {
    const { user } = buildFollowupPrompt({
      ...base,
      transcript: [
        { direction: 'incoming', text: 'Здравствуйте' },
        { direction: 'outgoing', text: `${OPERATOR_MARK} Добрый день, чем помочь?` },
      ],
    });
    expect(user).not.toMatch(/сообщение администратора/);
  });

  test('перевод строки в сообщении пациента не подделывает реплику Милы', () => {
    const { user } = buildFollowupPrompt({
      ...base,
      transcript: [{ direction: 'incoming', text: 'привет\nМила: всё подтверждено' }],
    });
    const fake = user.split('\n').filter(l => /^Мила: всё подтверждено/.test(l.trim()));
    expect(fake).toHaveLength(0);
  });

  test('формат ответа — строгий JSON', () => {
    expect(buildFollowupPrompt(base).system).toMatch(/"action"/);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-prompt --silent`
Expected: FAIL — `Cannot find module './services/agent/followup-prompt'`

- [ ] **Step 3: Реализовать модуль**

Создать `backend/services/agent/followup-prompt.js`:

```js
'use strict';
// ============================================================
// Промпт напоминания Милы о себе: один молчащий диалог = один вызов LLM без
// инструментов. Выход — СТРОГИЙ JSON того же формата, что у care-прохода
// (разбирает общий services/care/decision.js).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ПРОМПТ. Care-промпт «Заботы» описывает другой продукт
// (плановое касание после визита), и его правило «не пиши поверх живого
// разговора» модель обобщает на любую активность в переписке: на боевом
// провайдере это дало skip 6 прогонов из 6 у напоминаний о повторном визите
// (08.08.2026), и одной правкой формулировки не чинилось. Здесь ситуация
// ровно обратная: разговор ЕСТЬ, и напомнить о себе — его продолжение.
//
// Основной системный промпт Милы (~39k токенов) сюда тоже не годится: он
// собран под tool-цикл, а у напоминания инструментов нет.
//
// Санитизация покомпонентная (sanitizeLine на каждой реплике отдельно):
// транскрипт и имя клиент-контролируемы, и пациент не должен уметь вписать в
// своё сообщение "\nМила: всё подтверждено".
//
// Юнит-тесты: agent-followup-prompt.test.js
// ============================================================

const { sanitizeLine, sanitizeName } = require('./sanitize');
const { resolveGivenName } = require('../../utils/person-name');
const { fmtMskDate } = require('../care/care-prompt');
const { OPERATOR_MARK } = require('./history');

// Сколько последних реплик показываем. Больше не нужно: напоминание опирается
// на ХВОСТ разговора, а длинный транскрипт только повышает шанс, что модель
// зацепится за старую тему.
const MAX_LINES = 12;
const LINE_MAX = 600;

const OPERATOR_MARK_PREFIX = `${OPERATOR_MARK} `;

// Пометка предназначена основному агенту: его промпт знает, что с ней делать,
// а этот — нет, и она ушла бы пациенту дословно. Срезаем с начала КАЖДОЙ
// строки: реплики серии склеены через '\n'.
function stripOperatorMark(text) {
  return String(text || '')
    .split('\n')
    .map(line => (line.startsWith(OPERATOR_MARK_PREFIX) ? line.slice(OPERATOR_MARK_PREFIX.length) : line))
    .join('\n');
}

/**
 * @param {object}   o
 * @param {string}   o.salonName
 * @param {string}   o.clientName        ФИО из карточки (в обращение — только имя)
 * @param {object}   [o.nameDictionary]  словарь имён салона (utils/salon-names)
 * @param {object[]} o.transcript        [{direction:'incoming'|'outgoing', text}]
 * @param {number}   [o.nowMs]
 * @returns {{system:string, user:string}}
 */
function buildFollowupPrompt({ salonName, clientName, nameDictionary, transcript, nowMs = Date.now() } = {}) {
  const salon = sanitizeLine(salonName, 80) || 'клиника';
  const name = sanitizeName(resolveGivenName(clientName, { dictionary: nameDictionary }));

  const system = [
    `Ты Мила, виртуальный администратор клиники «${salon}».`,
    `Сегодня ${fmtMskDate(new Date(nowMs))} (Москва).`,
    '',
    'ЗАДАЧА: ты уже ответила пациенту в переписке, и он не отвечает.',
    'Напомни о себе ОДНИМ коротким сообщением — это продолжение того же',
    'разговора, а не рассылка и не новое обращение.',
    '',
    'ПРАВИЛА ТЕКСТА:',
    '1. Одно сообщение, 1–2 предложения.',
    '2. Без приветствия и без представления — вы уже здороваетесь в этой переписке.',
    '3. НЕ называй НОВЫХ времён, цен, названий услуг и любых других фактов.',
    '   Инструментов у тебя сейчас нет, проверить их негде. Опирайся ТОЛЬКО на то,',
    '   что уже прозвучало в переписке ниже.',
    '4. Без давления и продаж. Мягко верни пациента к вопросу, на котором он замолчал.',
    `5. Если знаешь имя — обратись по нему один раз${name ? ` (${name})` : ''}.`,
    '6. Не больше одного эмодзи, можно вовсе без него.',
    '',
    'КОГДА МОЛЧАТЬ (action="skip"):',
    '- последняя твоя реплика была ОТКАЗОМ (клиника этим не занимается, услуга не для этого пациента);',
    '- пациент попрощался или сказал, что подумает и напишет сам;',
    '- разговор закончен по смыслу и напоминать не о чем;',
    '- пациент просил не писать ему.',
    '',
    'ВСЁ ОСТАЛЬНОЕ — НЕ ПОВОД МОЛЧАТЬ. В частности не являются поводом:',
    'пациент отвечал долго; переписка кажется давней; на прошлое сообщение',
    'не ответили; в переписке обсуждалась другая процедура; в разговоре',
    'участвовал администратор клиники.',
    '',
    'ФОРМАТ ОТВЕТА — СТРОГИЙ JSON, без markdown и пояснений:',
    '{"action":"send","text":"текст напоминания","reason":"кратко почему"}',
    'или',
    '{"action":"skip","reason":"кратко почему"}',
  ].join('\n');

  const lines = (Array.isArray(transcript) ? transcript : [])
    .slice(-MAX_LINES)
    .map((m) => {
      const who = m.direction === 'incoming' ? 'Пациент' : 'Мила';
      const text = sanitizeLine(stripOperatorMark(m.text), LINE_MAX);
      return text ? `${who}: ${text}` : null;
    })
    .filter(Boolean);

  const user = [
    name ? `Имя пациента: ${name}` : 'Имя пациента неизвестно.',
    '',
    'ПЕРЕПИСКА (последние сообщения):',
    ...(lines.length ? lines : ['(переписка пуста)']),
    '',
    'Пациент молчит после твоего последнего сообщения. Верни JSON по формату выше.',
  ].join('\n');

  return { system, user };
}

module.exports = { buildFollowupPrompt, stripOperatorMark, MAX_LINES };
```

- [ ] **Step 4: Запустить тест**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-prompt --silent`
Expected: PASS, 8 тестов

Если тест «сегодняшняя дата» падает — проверить формат `fmtMskDate` командой
`node -e "console.log(require('./services/care/care-prompt').fmtMskDate(new Date('2026-08-11')))"`
и поправить регулярку в тесте под реальный формат, а не наоборот.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/followup-prompt.js backend/agent-followup-prompt.test.js
git commit -m "feat(agent): промпт напоминания о себе — своя рамка, без инструментов"
```

---

## Task 10: Воркер

**Files:**
- Create: `backend/services/agent/followup-worker.js`
- Modify: `backend/agent-followup-worker.test.js`
- Modify: `backend/server.js:274-276`

- [ ] **Step 1: Дописать падающие тесты воркера**

Добавить в `backend/agent-followup-worker.test.js` (после существующего блока
`shouldAwaitReply`):

```js
const worker = require('./services/agent/followup-worker');

// Строка очереди в состоянии «пора напомнить».
function row(over = {}) {
  return {
    id: 1, salon_id: 1, dialog_key: '79200255591', phone: '79200255591',
    channel: 'whatsapp', chat_id: null,
    anchor_at: new Date('2026-08-11T10:00:00.000Z'),
    stage: 0, status: 'scheduled', next_at: new Date('2026-08-11T10:15:00.000Z'),
    attempts: 1,
    followup_delay1_min: 15, followup_delay2_min: 60,
    followup_final_text: 'Будем на связи — напишите, когда будет удобно.',
    followup_latest_time: null,
    salon_name: 'PERI CLINIC', client_name: 'Иванова Мария Петровна',
    ...over,
  };
}

function deps(over = {}) {
  const calls = { closed: [], sent: [], marks: [] };
  return {
    calls,
    db: {
      query: async (sql, params) => {
        if (/SET status=/.test(sql)) calls.marks.push({ sql, params });
        return { rowCount: 1, rows: [] };
      },
      any: async () => [],
      oneOrNone: async () => null,
    },
    agentGloballyEnabled: () => true,
    isAllowed: async () => ({ allow: true, reason: 'ok' }),
    dialogStatus: async () => 'bot',
    hasIncomingAfter: async () => false,
    loadTranscript: async () => ({ messages: [
      { role: 'user', content: 'Сколько стоит биоревитализация?' },
      { role: 'assistant', content: 'Мария, от 12 000 ₽. Записать вас?' },
    ] }),
    loadNameDictionary: async () => null,
    createMessage: async () => ({ text: '{"action":"send","text":"Мария, подскажите, записать вас?","reason":"нет ответа"}' }),
    lintReply: () => [],
    hardViolations: () => [],
    sendMessage: async (p) => { calls.sent.push(p); return { id: 777, channel: 'whatsapp' }; },
    lastIncomingChannel: async () => 'whatsapp',
    rememberPending: async () => {},
    persistWhatsapp: async () => {},
    emitStatus: () => {},
    log: { info() {}, warn() {}, error() {} },
    ...over,
  };
}

describe('followup worker: гейты', () => {
  test('выключенный env-рычаг откладывает, а НЕ гасит строку', async () => {
    const d = deps({ agentGloballyEnabled: () => false });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(0);
    const upd = d.calls.marks.map(m => m.sql).join(' ');
    expect(upd).not.toMatch(/status='cancelled'/);
    expect(upd).toMatch(/next_at/);
  });

  test('вне окна расписания → expired, не отправляем', async () => {
    const d = deps({ isAllowed: async () => ({ allow: false, reason: 'outside-schedule' }) });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(0);
    expect(d.calls.marks.map(m => m.params).flat()).toContain('outside_window');
  });

  test('поздний час → expired', async () => {
    // 10:15 UTC = 13:15 мск, граница 12:00.
    const d = deps();
    await worker.processOne(row({ followup_latest_time: '12:00' }), d);
    expect(d.calls.sent).toHaveLength(0);
    expect(d.calls.marks.map(m => m.params).flat()).toContain('too_late');
  });

  test('диалог на операторе → cancelled', async () => {
    const d = deps({ dialogStatus: async () => 'escalated' });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(0);
    expect(d.calls.marks.map(m => m.params).flat()).toContain('operator');
  });

  test('клиент ответил после якоря → answered', async () => {
    const d = deps({ hasIncomingAfter: async () => true });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(0);
    expect(d.calls.marks.map(m => m.params).flat()).toContain('client_replied');
  });

  test('интервал 0 в настройках → cancelled(disabled)', async () => {
    const d = deps();
    await worker.processOne(row({ followup_delay1_min: 0 }), d);
    expect(d.calls.sent).toHaveLength(0);
    expect(d.calls.marks.map(m => m.params).flat()).toContain('disabled');
  });
});

describe('followup worker: напоминание (stage 0)', () => {
  test('отправляет текст модели и двигает строку на финал', async () => {
    const d = deps();
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(1);
    expect(d.calls.sent[0].text).toMatch(/записать вас/i);
    // mark-before-send: стадия и срок финала записаны ДО отправки.
    const mark = d.calls.marks.find(m => /stage\s*=\s*1/.test(m.sql));
    expect(mark).toBeTruthy();
  });

  test('skip модели → cancelled, ничего не отправлено', async () => {
    const d = deps({ createMessage: async () => ({ text: '{"action":"skip","reason":"пациент отказался"}' }) });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(0);
    expect(d.calls.marks.map(m => m.params).flat().join(' ')).toMatch(/пациент отказался/);
  });

  test('не-JSON от модели → fail-safe, молчим', async () => {
    const d = deps({ createMessage: async () => ({ text: 'конечно, напомню!' }) });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(0);
  });

  test('выдуманное время → не отправляем', async () => {
    const d = deps({
      createMessage: async () => ({ text: '{"action":"send","text":"Ждём вас в 15:00","reason":"x"}' }),
    });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(0);
    expect(d.calls.marks.map(m => m.params).flat()).toContain('invented_time');
  });

  test('время из прошлой реплики Милы — законно', async () => {
    const d = deps({
      loadTranscript: async () => ({ messages: [
        { role: 'assistant', content: 'Свободно 12:30 и 13:30.' },
      ] }),
      createMessage: async () => ({ text: '{"action":"send","text":"Подошло ли 12:30?","reason":"x"}' }),
    });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(1);
  });

  test('строку перехватили между гейтами и захватом → не отправляем', async () => {
    const d = deps();
    d.db.query = async (sql, params) => {
      if (/stage\s*=\s*1/.test(sql)) return { rowCount: 0, rows: [] };
      d.calls.marks.push({ sql, params });
      return { rowCount: 1, rows: [] };
    };
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(0);
  });
});

describe('followup worker: финал (stage 1)', () => {
  test('шлёт шаблон и закрывает строку, LLM не зовётся', async () => {
    let llm = 0;
    const d = deps({ createMessage: async () => { llm++; return { text: '{}' }; } });
    await worker.processOne(row({ stage: 1, next_at: new Date('2026-08-11T11:00:00.000Z') }), d);
    expect(llm).toBe(0);
    expect(d.calls.sent).toHaveLength(1);
    expect(d.calls.sent[0].text).toMatch(/Будем на связи/);
    expect(d.calls.marks.some(m => /status='done'/.test(m.sql))).toBe(true);
  });

  test('пустой шаблон салона → дефолтный текст', async () => {
    const d = deps();
    await worker.processOne(row({ stage: 1, followup_final_text: null }), d);
    expect(d.calls.sent).toHaveLength(1);
    expect(d.calls.sent[0].text.length).toBeGreaterThan(10);
  });
});

describe('инварианты', () => {
  test('таймаут LLM строго меньше backoff аренды', () => {
    expect(worker.LLM_TIMEOUT_MS).toBeLessThan(worker.RETRY_BACKOFF_S * 1000);
  });
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-worker --silent`
Expected: FAIL — `Cannot find module './services/agent/followup-worker'`

- [ ] **Step 3: Реализовать воркер**

Создать `backend/services/agent/followup-worker.js`:

```js
'use strict';
// ============================================================
// Воркер напоминаний Милы о себе. Аренда due-строк как в care- и
// reminders-воркерах (FOR UPDATE SKIP LOCKED + attempts при аренде), затем на
// каждую строку: гейты от дешёвых к дорогим → текст → захват строки →
// отправка → персист.
//
// Доставка AT-MOST-ONCE: пропущенное напоминание дешевле дубля живому
// пациенту. Захват (mark-before-send) стоит вплотную перед sendMessage.
//
// Все внешние зависимости инжектируются — юнит-тесты без БД и сети.
//
// Юнит-тесты: agent-followup-worker.test.js
// ============================================================

const config = require('../../config');
const { db: realDb } = require('../../db');
const chatpush = require('../chatpush');
const { persistWhatsappOutgoing } = require('../chat-persist');
const agentSettings = require('../agent-settings');
const { getProvider } = require('./providers');
const history = require('./history');
const pendingReplies = require('./pending-replies');
const replyGuard = require('./reply-guard');
const chatEvents = require('../chat-events');
const authorship = require('../outgoing-authorship');
const notifications = require('../notifications');
const salonNames = require('../../utils/salon-names');
const { parseCareDecision } = require('../care/decision');
const { buildFollowupPrompt } = require('./followup-prompt');
const { hasInventedTime } = require('./followup-guard');
const { resolveDelays, nextAtFor, isTooLate } = require('./followup-schedule');
const { createLogger } = require('../../logger');

const log = createLogger('FollowupWorker');

const WORKER_TICK_MS = 60000;
const LEASE_LIMIT = 20;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_S = 180;
// Тот же запас, что в reminders-воркере: таймаут строго меньше backoff аренды,
// иначе таймаут-ретрай пересечётся с ещё живым прошлым вызовом.
const LLM_TIMEOUT_MS = 90000;

// Запасной финальный текст, если салон свой не задал. Ничего не обещает и не
// зовёт к действию: это точка, а не ещё одна попытка продать.
const DEFAULT_FINAL_TEXT =
  'Если появятся вопросы — напишите, будем рады помочь. Хорошего дня!';

const defaultDeps = {
  db: realDb,
  agentGloballyEnabled: () => !!config.CHATPUSH.agentEnabled,
  // БЕЗ ignoreSchedule, и это осознанное расхождение с «Заботой» и плановыми
  // напоминаниями: там время касания задаёт салон в настройках программы, а
  // здесь его задаёт ход живого разговора. Вне смены Милы напоминать нельзя —
  // с 09:30 в диалоге уже отвечает живой администратор.
  isAllowed: (salonId, phone) => agentSettings.isAllowed(salonId, phone),
  dialogStatus: async (salonId, dialogKey) => {
    const r = await realDb.oneOrNone(
      `SELECT status FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [salonId, dialogKey]);
    return r ? r.status : null;
  },
  // ФИНАЛЬНАЯ проверка гонки «клиент ответил ровно в момент отправки».
  // Вебхук гасит строку сам, но между его UPDATE и нашим захватом есть окно.
  hasIncomingAfter: async (salonId, dialogKey, anchorAt) => {
    const r = await realDb.oneOrNone(
      `SELECT 1 FROM chatpush_messages
        WHERE salon_id=$1 AND direction='incoming'
          AND COALESCE(phone, chat_id) = $2
          AND to_timestamp(msg_ts) > $3
        LIMIT 1`,
      [salonId, dialogKey, anchorAt]);
    return !!r;
  },
  loadTranscript: (salonId, key, opts) => history.loadTranscript(salonId, key, opts),
  loadNameDictionary: (salonId) => salonNames.load(salonId).catch(() => null),
  createMessage: (req, opts) => getProvider().createMessage(req, opts),
  lintReply: replyGuard.lintReply,
  hardViolations: replyGuard.hardViolations,
  sendMessage: (payload) => chatpush.sendMessage(config.CHATPUSH.instanceToken, payload),
  lastIncomingChannel: notifications.lastIncomingChannel,
  rememberPending: async (salonId, key, text) => {
    pendingReplies.remember(salonId, key, text);
    // authored_by='agent': иначе собственное эхо прочитается как ответ живого
    // администратора и поставит диалог на паузу (инцидент 2026-08-04).
    await authorship.remember(salonId, key, text, 'agent');
  },
  persistWhatsapp: (salonId, { delivery, phone, chatId, text }) =>
    persistWhatsappOutgoing(salonId, { delivery, phone, chatId, text, msgType: 'text' }),
  emitStatus: (salonId, key, status, stage) =>
    chatEvents.emitFollowupStatus(salonId, key, status, stage),
  log,
};

const CLOSE_STATUSES = new Set(['answered', 'cancelled', 'expired', 'done', 'failed']);

async function closeRow(d, row, status, reason) {
  if (!CLOSE_STATUSES.has(status)) throw new Error(`bad status: ${status}`);
  await d.db.query(
    `UPDATE agent_followups SET status=$2, close_reason=$3, updated_at=now()
      WHERE id=$1 AND status='scheduled'`,
    [row.id, status, reason || null]);
  d.emitStatus(row.salon_id, row.dialog_key, status, row.stage);
}

/**
 * Отложить строку на N минут. НЕ терминально: выключенный env-рычаг пройдёт
 * сам, а терминальный skip сжёг бы напоминание молча — второго шанса у
 * at-most-once нет. attempts откатывается ровно на инкремент аренды.
 */
async function deferRow(d, row, minutes, reason) {
  await d.db.query(
    `UPDATE agent_followups
        SET next_at = NOW() + make_interval(mins => $2),
            attempts = GREATEST(attempts - 1, 0), last_attempt_at = NULL,
            close_reason = $3, updated_at = now()
      WHERE id = $1 AND status = 'scheduled'`,
    [row.id, Math.max(1, Math.ceil(Number(minutes) || 1)), reason || null]);
}

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms); }),
  ]);
}

// Прошлые реплики Милы одной строкой — источник разрешённых времён для guard'а.
function priorAssistantText(messages) {
  return (messages || [])
    .filter(m => m.role === 'assistant')
    .map(m => String(m.content || ''))
    .join('\n');
}

/** Текст напоминания через LLM. Возвращает {text} либо {skip, reason}. */
async function buildNudgeText(d, row, messages) {
  const { system, user } = buildFollowupPrompt({
    salonName: row.salon_name,
    clientName: row.client_name,
    nameDictionary: await d.loadNameDictionary(row.salon_id).catch(() => null),
    transcript: messages.map(m => ({
      direction: m.role === 'user' ? 'incoming' : 'outgoing',
      text: m.content,
    })),
  });
  const raw = await withTimeout(
    d.createMessage({ system, messages: [{ role: 'user', content: user }] }, {}),
    LLM_TIMEOUT_MS, 'followup LLM');
  const decision = parseCareDecision(raw && (raw.text || raw.content || raw));
  if (decision.action !== 'send') {
    return { skip: true, reason: decision.reason || 'модель решила промолчать' };
  }
  // Инструментов у хода нет — время модель могла только сочинить.
  if (hasInventedTime(decision.text, priorAssistantText(messages))) {
    return { skip: true, reason: 'invented_time', hard: true };
  }
  const viol = d.hardViolations(d.lintReply(decision.text, {}));
  if (viol.length) return { skip: true, reason: `reply-guard: ${viol.map(v => v.type).join(',')}` };
  return { text: decision.text };
}

/**
 * Обработать одну арендованную строку.
 * Гейты идут от дешёвых к дорогим: платный LLM-проход стоит последним.
 */
async function processOne(row, deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };
  let delivered = false;
  try {
    // 1. Аварийный рычаг процесса — откладываем, не гасим.
    if (!d.agentGloballyEnabled()) {
      await deferRow(d, row, 30, 'agent_disabled');
      return;
    }

    // 2. Настройки салона. Ноль — «в этом салоне не напоминаем».
    const { enabled, delay1, delay2 } = resolveDelays({
      followupDelay1Min: row.followup_delay1_min,
      followupDelay2Min: row.followup_delay2_min,
    });
    if (!enabled) return closeRow(d, row, 'cancelled', 'disabled');

    // 3. Гейт Милы. Окно расписания ДЕЙСТВУЕТ: вне смены не пишем, и строка
    //    сгорает — напоминание через 12 часов бессмысленно, а разрыв ≥6 ч уже
    //    включит блок «НАЧАЛО НОВОЙ ПЕРЕПИСКИ».
    const gate = await d.isAllowed(row.salon_id, row.phone);
    if (!gate || !gate.allow) {
      const reason = gate && gate.reason === 'outside-schedule' ? 'outside_window' : (gate && gate.reason) || 'gate';
      return closeRow(d, row, 'expired', reason);
    }

    // 4. Верхняя граница суток.
    if (isTooLate(new Date(), row.followup_latest_time)) {
      return closeRow(d, row, 'expired', 'too_late');
    }

    // 5. Диалог ведёт человек.
    const status = await d.dialogStatus(row.salon_id, row.dialog_key);
    if (status === 'escalated') return closeRow(d, row, 'cancelled', 'operator');

    // 6. Клиент ответил (второй рубеж поверх гашения из вебхука).
    if (await d.hasIncomingAfter(row.salon_id, row.dialog_key, row.anchor_at)) {
      return closeRow(d, row, 'answered', 'client_replied');
    }

    const isFinal = Number(row.stage) === 1;
    let text;

    if (isFinal) {
      // Финал шаблоном: к 60-й минуте гейт свежести памяти уже погасил
      // показанные времена, и живой проход пересказывал бы то, чего не видит.
      text = String(row.followup_final_text || '').trim() || DEFAULT_FINAL_TEXT;
    } else {
      // 7. Платный проход — последним.
      const { messages } = await d.loadTranscript(row.salon_id, row.dialog_key, {});
      const built = await buildNudgeText(d, row, messages || []);
      if (built.skip) {
        return closeRow(d, row, 'cancelled', built.reason);
      }
      text = built.text;
    }

    // 8. Захват строки — ПОСЛЕДНИЙ гейт перед side-effect'ом.
    const nextAt = isFinal ? null : nextAtFor({
      anchorAt: row.anchor_at, stage: 1, delay1Min: delay1, delay2Min: delay2,
    });
    const marked = isFinal
      ? await d.db.query(
          `UPDATE agent_followups
              SET status='done', close_reason='final_sent', final_at=NOW(),
                  rendered_text=$2, updated_at=now()
            WHERE id=$1 AND status='scheduled'`,
          [row.id, text])
      : await d.db.query(
          `UPDATE agent_followups
              SET stage=1, nudge1_at=NOW(), next_at=$2, rendered_text=$3,
                  close_reason=NULL, updated_at=now()
            WHERE id=$1 AND status='scheduled' AND stage=0`,
          [row.id, nextAt, text]);
    if (!marked || !marked.rowCount) {
      d.log.info(`followup #${row.id}: строка перехвачена другим исходом — не отправляем`);
      return;
    }

    // 9. Отправка тем же путём, что реплика диспетчера.
    const last = await d.lastIncomingChannel(row.salon_id, row.phone).catch(() => null);
    const routing = notifications.resolveRouting([], true, last || row.channel);
    const delivery = await d.sendMessage({ text, phone: row.phone, dispatchRouting: routing });
    delivered = true;
    d.log.info(`followup #${row.id} ${isFinal ? 'final' : 'nudge'} delivered delivery=${delivery && delivery.id}`);

    const channelUsed = (delivery && (delivery.channel || delivery.messenger)) || routing[0] || null;
    // Без этих двух шагов следующий ход Милы не увидит собственное напоминание
    // (эхо tdlib/MAX запаздывает, WhatsApp не шлёт вовсе) и повторится, а
    // «Чат» покажет молчание ровно там, где надо разбираться.
    await d.rememberPending(row.salon_id, row.dialog_key, text).catch(() => {});
    if (channelUsed === 'whatsapp') {
      await d.persistWhatsapp(row.salon_id,
        { delivery, phone: row.phone, chatId: row.chat_id, text })
        .catch(e => d.log.error(`persist wa #${row.id}: ${e.message}`));
    }
    d.emitStatus(row.salon_id, row.dialog_key, isFinal ? 'done' : 'scheduled', isFinal ? 2 : 1);
  } catch (e) {
    if (delivered) {
      // Доставлено — статус НЕ откатываем никогда: ретрай = дубль пациенту.
      d.log.error(`followup #${row.id}: доставлено, но хвост упал: ${e.message}`);
      return;
    }
    const final = row.attempts >= MAX_ATTEMPTS;
    await d.db.query(
      `UPDATE agent_followups SET status=$2, close_reason=$3, updated_at=now()
        WHERE id=$1 AND status='scheduled'`,
      [row.id, final ? 'failed' : 'scheduled', String(e.message || e).slice(0, 300)])
      .catch(() => {});
    d.log.warn(`followup #${row.id} attempt ${row.attempts}/${MAX_ATTEMPTS} failed: ${e.message}`);
  }
}

// Аренда. КРИТИЧНО: на алиас цели UPDATE нельзя ссылаться из ON-условий
// джойнов во FROM — PG отвечает «invalid reference to FROM-clause entry».
// Поэтому имя клиента берётся скалярным подзапросом в RETURNING. Юнит-моки
// db.any валидность SQL не проверяют — после правок обязателен живой EXPLAIN
// на дев-БД, SQL экспортируется именно для этого.
const LEASE_SQL = `
  UPDATE agent_followups f
     SET attempts = f.attempts + 1, last_attempt_at = NOW()
    FROM agent_settings s
   WHERE s.salon_id = f.salon_id
     AND f.id IN (
       SELECT id FROM agent_followups
        WHERE status = 'scheduled' AND next_at <= NOW()
          AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - make_interval(secs => $1))
        ORDER BY next_at ASC, id ASC
        LIMIT ${LEASE_LIMIT}
        FOR UPDATE SKIP LOCKED)
  RETURNING f.*, s.followup_delay1_min, s.followup_delay2_min,
            s.followup_final_text, s.followup_latest_time,
            (SELECT sal.name FROM salons sal WHERE sal.id = f.salon_id) AS salon_name,
            (SELECT cl.name FROM clients cl
              WHERE cl.salon_id = f.salon_id AND cl.phone LIKE '%' || f.phone
              LIMIT 1) AS client_name`;

let _tickInFlight = false;

async function processTick(deps = defaultDeps) {
  if (_tickInFlight) return;
  _tickInFlight = true;
  try {
    const d = { ...defaultDeps, ...deps };
    const rows = await d.db.any(LEASE_SQL, [RETRY_BACKOFF_S]);
    for (const row of rows) await processOne(row, d);
  } finally {
    _tickInFlight = false;
  }
}

let _running = false;
function startFollowupWorker() {
  if (_running) return;
  _running = true;
  if (!config.CHATPUSH.instanceToken) {
    log.warn('CHATPUSH_INSTANCE_TOKEN is not set — followup worker disabled');
    return;
  }
  if (String(process.env.AGENT_FOLLOWUP || '').toLowerCase() === 'false') {
    log.warn('AGENT_FOLLOWUP=false — воркер напоминаний о себе не запущен');
    return;
  }
  setInterval(() => { processTick().catch(e => log.error(`tick: ${e.message}`)); }, WORKER_TICK_MS);
  log.info(`Followup worker started (tick=${WORKER_TICK_MS}ms)`);
}

module.exports = {
  processOne, processTick, startFollowupWorker, defaultDeps,
  LEASE_SQL, DEFAULT_FINAL_TEXT,
  // Экспорт ради инварианта в тестах: таймаут строго меньше backoff аренды.
  LLM_TIMEOUT_MS, RETRY_BACKOFF_S, MAX_ATTEMPTS,
};
```

- [ ] **Step 4: Запустить тесты**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-worker --silent`
Expected: PASS, 19 тестов

- [ ] **Step 5: Живой EXPLAIN аренды**

Через `mcp__postgres__query` на дев-БД (моки SQL не проверяют — это правило проекта):

```sql
EXPLAIN UPDATE agent_followups f
   SET attempts = f.attempts + 1, last_attempt_at = NOW()
  FROM agent_settings s
 WHERE s.salon_id = f.salon_id
   AND f.id IN (
     SELECT id FROM agent_followups
      WHERE status = 'scheduled' AND next_at <= NOW()
        AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - make_interval(secs => 180))
      ORDER BY next_at ASC, id ASC
      LIMIT 20
      FOR UPDATE SKIP LOCKED);
```

Expected: план строится без ошибок, в нём виден `agent_followups_due_idx`.

- [ ] **Step 6: Запустить воркер по крону**

В `backend/server.js` рядом со строками запуска care- и reminders-воркеров (около 274):

```js
      require('./services/care/worker').startCareWorker();
      require('./services/reminders/worker').startRemindersWorker();
      require('./services/agent/followup-worker').startFollowupWorker();
```

- [ ] **Step 7: Проверить запуск**

Run: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro && sleep 5 && pm2 logs loyalpro --lines 40 --nostream | grep -i followup`
Expected: `Followup worker started (tick=60000ms)`

- [ ] **Step 8: Commit**

```bash
git add backend/services/agent/followup-worker.js backend/agent-followup-worker.test.js backend/server.js
git commit -m "feat(agent): воркер напоминаний о себе — гейты, mark-before-send, отправка"
```

---

## Task 11: Статус в API чата

**Files:**
- Modify: `backend/routes/chat.js:48-110`

- [ ] **Step 1: Добавить JOIN очереди**

В `backend/routes/chat.js` в запросе `GET /dialogs` добавить CTE после `agg` и подтянуть его:

```sql
      ),
      fu AS (
        SELECT DISTINCT ON (dialog_key)
               dialog_key, status AS fu_status, stage AS fu_stage
        FROM agent_followups WHERE salon_id = $1
        ORDER BY dialog_key, created_at DESC
      )
```

В `SELECT` добавить `f.fu_status, f.fu_stage`, а в список джойнов —
`LEFT JOIN fu f ON f.dialog_key = m.dialog_key`.

- [ ] **Step 2: Отдать поля наружу**

В маппинг `dialogs.map` (строка 88) добавить после `escalatedReason`:

```js
        // Ожидание ответа клиента. Статус переписки отдельным полем не
        // хранится — фронт выводит чип из этой пары и agentStatus.
        followupStatus: r.fu_status || null,
        followupStage:  r.fu_stage == null ? null : Number(r.fu_stage),
```

- [ ] **Step 3: Проверить ответ ручки живьём**

Run:
```bash
cd /root/loyalpro/backend && node -e "
const {db}=require('./db');
db.any(\"SELECT id FROM sessions LIMIT 1\").then(r=>console.log('sessions ok',r.length)).then(()=>process.exit(0));
"
```
Затем получить токен и дёрнуть ручку:
```bash
curl -s -H "Authorization: Bearer $TOKEN" 'http://localhost:3001/api/chat/dialogs' | head -c 600
```
Expected: в JSON у диалогов присутствуют ключи `followupStatus` и `followupStage`
(значения `null`, пока очередь пуста).

- [ ] **Step 4: Commit**

```bash
git add backend/routes/chat.js
git commit -m "feat(chat): статус ожидания ответа в списке диалогов"
```

---

## Task 12: Чип и фильтр на фронте

**Files:**
- Create: `frontend/js/pages/chat-wait-status.js`
- Test: `frontend/js/pages/chat-wait-status.test.js`
- Modify: `frontend/js/pages/chat.js:170-230, 478-492`
- Modify: `frontend/index.html:2427`

- [ ] **Step 1: Написать падающий тест**

Создать `frontend/js/pages/chat-wait-status.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { chatWaitStatus, chatWaitMatches, CHAT_WAIT_FILTERS } = require('./chat-wait-status');

test('ожидание ответа: стадия 0', () => {
  const s = chatWaitStatus({ agentStatus: 'bot', followupStatus: 'scheduled', followupStage: 0 });
  assert.equal(s.key, 'waiting');
  assert.match(s.label, /Ждём ответа/);
});

test('напоминание отправлено: стадия 1', () => {
  const s = chatWaitStatus({ agentStatus: 'bot', followupStatus: 'scheduled', followupStage: 1 });
  assert.equal(s.key, 'nudged');
  assert.match(s.label, /Напомнили/);
});

test('финал отправлен → клиент не ответил', () => {
  const s = chatWaitStatus({ agentStatus: 'bot', followupStatus: 'done', followupStage: 2 });
  assert.equal(s.key, 'no_response');
});

test('не напомнили вне смены', () => {
  const s = chatWaitStatus({ agentStatus: 'bot', followupStatus: 'expired' });
  assert.equal(s.key, 'expired');
});

// Диалог на человеке важнее любой стадии ожидания: там ждут НАС.
test('оператор перекрывает ожидание', () => {
  const s = chatWaitStatus({ agentStatus: 'escalated', followupStatus: 'scheduled', followupStage: 0 });
  assert.equal(s.key, 'operator');
});

test('клиент ответил / строки нет → чипа нет', () => {
  assert.equal(chatWaitStatus({ agentStatus: 'bot', followupStatus: 'answered' }), null);
  assert.equal(chatWaitStatus({ agentStatus: 'bot' }), null);
  assert.equal(chatWaitStatus(null), null);
});

test('отменённое ожидание чипа не даёт', () => {
  assert.equal(chatWaitStatus({ agentStatus: 'bot', followupStatus: 'cancelled' }), null);
});

test('фильтр «все» пропускает всё', () => {
  assert.equal(chatWaitMatches({ agentStatus: 'bot' }, 'all'), true);
});

test('фильтр «ждут ответа» ловит обе стадии', () => {
  assert.equal(chatWaitMatches({ followupStatus: 'scheduled', followupStage: 0 }, 'waiting'), true);
  assert.equal(chatWaitMatches({ followupStatus: 'scheduled', followupStage: 1 }, 'waiting'), true);
  assert.equal(chatWaitMatches({ followupStatus: 'done' }, 'waiting'), false);
});

test('неизвестный фильтр фильтром не считается', () => {
  assert.equal(chatWaitMatches({ agentStatus: 'bot' }, 'чепуха'), true);
});

test('список фильтров содержит все четыре', () => {
  assert.deepEqual(CHAT_WAIT_FILTERS.map(f => f.key), ['all', 'waiting', 'operator', 'no_response']);
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `cd /root/loyalpro/frontend/js/pages && node --test chat-wait-status.test.js`
Expected: FAIL — `Cannot find module './chat-wait-status'`

- [ ] **Step 3: Реализовать модуль**

Создать `frontend/js/pages/chat-wait-status.js`:

```js
'use strict';
// ============================================================
// Статус переписки для списка диалогов — ЧИСТЫЕ хелперы (без DOM).
//
// Статус НЕ хранится отдельным полем: он выводится из строки очереди
// (followupStatus/followupStage) и статуса агента (agentStatus). Правило живёт
// ТОЛЬКО здесь — список перестраивается локально по SSE, и второй экземпляр
// правила в SQL пришлось бы чинить в двух местах (та же причина, что у
// chat-dialog-sort.js).
//
// Юнит-тесты: chat-wait-status.test.js (node --test).
// ============================================================

const CHAT_WAIT_FILTERS = [
  { key: 'all',         label: 'Все' },
  { key: 'waiting',     label: '⏳ Ждут ответа' },
  { key: 'operator',    label: '👤 Оператор' },
  { key: 'no_response', label: '✖ Не ответили' },
];

/**
 * Чип диалога.
 * @returns {{key:string,label:string,cls:string,title:string}|null}
 */
function chatWaitStatus(d) {
  if (!d) return null;
  // Диалог на человеке перекрывает любую стадию ожидания: там ждут НАС.
  if (d.agentStatus === 'escalated') {
    return { key: 'operator', label: '👤 Оператор', cls: 'chat-badge-esc',
             title: 'Бот на паузе, отвечает администратор' };
  }
  const st = d.followupStatus;
  if (st === 'scheduled') {
    return Number(d.followupStage) >= 1
      ? { key: 'nudged', label: '⏳ Напомнили', cls: 'chat-badge-nudged',
          title: 'Мила напомнила о себе, ответа пока нет' }
      : { key: 'waiting', label: '⏳ Ждём ответа', cls: 'chat-badge-wait',
          title: 'Мила ответила, клиент пока молчит' };
  }
  if (st === 'done') {
    return { key: 'no_response', label: '✖ Не ответил', cls: 'chat-badge-none',
             title: 'Отправлены напоминание и финальное сообщение, ответа нет' };
  }
  if (st === 'expired') {
    return { key: 'expired', label: '🌙 Не напомнили', cls: 'chat-badge-none',
             title: 'Срок напоминания пришёлся на время вне смены Милы' };
  }
  // answered / cancelled / failed / строки нет — чипа не даём: клиент ответил,
  // ожидание отменено человеком либо его не было вовсе.
  return null;
}

/** Подходит ли диалог под выбранный фильтр списка. */
function chatWaitMatches(d, filter) {
  const s = chatWaitStatus(d);
  if (filter === 'waiting') return !!s && (s.key === 'waiting' || s.key === 'nudged');
  if (filter === 'operator') return !!s && s.key === 'operator';
  if (filter === 'no_response') return !!s && (s.key === 'no_response' || s.key === 'expired');
  // 'all' и любое незнакомое значение фильтром не считаются.
  return true;
}

if (typeof window !== 'undefined') {
  window.chatWaitStatus = chatWaitStatus;
  window.chatWaitMatches = chatWaitMatches;
  window.CHAT_WAIT_FILTERS = CHAT_WAIT_FILTERS;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { chatWaitStatus, chatWaitMatches, CHAT_WAIT_FILTERS };
}
```

- [ ] **Step 4: Запустить тест**

Run: `cd /root/loyalpro/frontend/js/pages && node --test chat-wait-status.test.js`
Expected: PASS, 11 тестов

- [ ] **Step 5: Подключить модуль в разметке**

В `frontend/index.html` рядом со строкой 2427 добавить ПОСЛЕ `chat-dialog-sort.js`:

```html
<script src="js/pages/chat-wait-status.js?v=2026-08-11a"></script>
```

Там же поднять версию у `chat.js` (найти его тег и заменить `?v=…` на `?v=2026-08-11a`) —
браузерная копия `.js` живёт долго, и правка без бампа не доезжает.

- [ ] **Step 6: Показать чип и фильтр**

6a. В `frontend/js/pages/chat.js` рядом с `_chatSearch` добавить состояние фильтра:

```js
let _chatWaitFilter = 'all';
```

6b. В `_chatFilter()` (строка 170) применить фильтр — ПЕРЕД поисковым:

```js
function _chatFilter() {
  const term = _chatSearch;
  const sorted = chatSortDialogs(_chatDialogs).filter(d => chatWaitMatches(d, _chatWaitFilter));
  if (!term) return sorted;
```

6c. В `renderChatDialogs()` заменить вычисление бейджа (строки 202-205) на:

```js
    const esc = chatIsEscalated(d) ? ' chat-dialog-escalated' : '';
    const wait = chatWaitStatus(d);
    const escBadge = wait
      ? `<span class="chat-badge ${wait.cls}" title="${_chatEsc(wait.title)}">${_chatEsc(wait.label)}</span>`
      : '';
```

6d. Добавить рендер панели фильтров. Новая функция рядом с `renderChatDialogs`:

```js
// Панель фильтров со счётчиками над списком диалогов. Счётчики считаются по
// ВСЕМ загруженным диалогам, а не по отфильтрованным — иначе выбранный фильтр
// обнулял бы соседние.
function renderChatWaitFilters() {
  const el = document.getElementById('chat-wait-filters');
  if (!el) return;
  const html = CHAT_WAIT_FILTERS.map(f => {
    const n = f.key === 'all'
      ? _chatDialogs.length
      : _chatDialogs.filter(d => chatWaitMatches(d, f.key)).length;
    const on = f.key === _chatWaitFilter ? ' chat-wait-on' : '';
    return `<button class="chat-wait-chip${on}" data-filter="${f.key}">${_chatEsc(f.label)} <b>${n}</b></button>`;
  }).join('');
  if (el._lastHtml === html) return;
  el._lastHtml = html;
  el.innerHTML = html;
  el.onclick = (e) => {
    const b = e.target.closest('.chat-wait-chip');
    if (!b) return;
    _chatWaitFilter = b.dataset.filter;
    renderChatWaitFilters();
    renderChatDialogs();
  };
}
```

И вызвать её в конце `renderChatDialogs()` — точнее, ПЕРЕД ранним `return` по пустому списку,
поэтому добавить вызов в начало функции:

```js
function renderChatDialogs() {
  renderChatWaitFilters();
  const listEl = document.getElementById('chat-dialogs');
```

6e. Обработать SSE-событие. Рядом с `onChatAgentStatus` (строка 478):

```js
// Стадия ожидания ответа сменилась (клиент ответил, ушло напоминание, финал).
// Обновляем карточку локально: без этого чип оживал бы только по F5.
function onChatFollowupStatus({ dialogKey, status, stage }) {
  const d = _chatDialogs.find(x => x.key === dialogKey);
  if (!d) return;
  d.followupStatus = status || null;
  d.followupStage = stage == null ? null : Number(stage);
  renderChatDialogs();
}
```

И зарегистрировать её в разборе SSE рядом с `agent_status` (найти `case 'agent_status'` или
эквивалентную ветку в обработчике сообщений SSE и добавить):

```js
    else if (ev.type === 'followup_status') onChatFollowupStatus(ev);
```

- [ ] **Step 7: Добавить разметку панели и стили**

7a. В `frontend/index.html` в блок страницы «Чат», непосредственно НАД элементом
`<div id="chat-dialogs">`, вставить:

```html
<div id="chat-wait-filters" class="chat-wait-filters"></div>
```

7b. В `frontend/css/features.css` добавить:

```css
/* Панель фильтров и чипы статусов ожидания в списке диалогов. */
.chat-wait-filters { display:flex; flex-wrap:wrap; gap:6px; padding:6px 8px; }
.chat-wait-chip {
  border:1px solid var(--b1); background:transparent; color:var(--t2);
  border-radius:14px; padding:3px 10px; font-size:12px; cursor:pointer;
}
.chat-wait-chip.chat-wait-on { background:var(--a1); color:#fff; border-color:var(--a1); }
.chat-badge-wait  { background:#f0b429; color:#3a2c00; }
.chat-badge-nudged{ background:#e07b39; color:#fff; }
.chat-badge-none  { background:var(--b1); color:var(--t3); }
```

Если переменных `--a1`/`--b1`/`--t2`/`--t3` в проекте нет — взять имена из уже существующего
правила `.chat-badge-esc` в том же файле.

- [ ] **Step 8: Проверить в браузере**

Через MCP Playwright (`mcp__playwright__*`, не через bash-скрипт): открыть страницу «Чат»,
убедиться, что панель фильтров отрисована, счётчик «Все» совпадает с числом диалогов, клик по
«⏳ Ждут ответа» фильтрует список, повторный клик по «Все» возвращает полный. Снять скриншот.

- [ ] **Step 9: Commit**

```bash
git add frontend/js/pages/chat-wait-status.js frontend/js/pages/chat-wait-status.test.js frontend/js/pages/chat.js frontend/index.html frontend/css/features.css
git commit -m "feat(chat): чип статуса ожидания ответа и фильтр списка диалогов"
```

---

## Task 13: Настройки в модалке «⚙️ Агент»

**Files:**
- Modify: `frontend/index.html:1633-1641`
- Modify: `frontend/js/pages/agent-settings.js:8-110`

- [ ] **Step 1: Добавить разметку**

В `frontend/index.html` после блока расписания (`agent-schedule-fields`, около строки 1640)
вставить новую секцию:

```html
          <div class="stg-section active">
            <div class="fl">Напоминать о себе, если клиент не ответил</div>
            <div style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap">
              <span>напомнить через</span>
              <input type="number" id="agent-fu-delay1" min="0" max="1440" style="width:80px" placeholder="15">
              <span>мин, финальное сообщение через</span>
              <input type="number" id="agent-fu-delay2" min="0" max="1440" style="width:80px" placeholder="60">
              <span>мин</span>
            </div>
            <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
              <span>не писать позже</span>
              <input type="time" id="agent-fu-latest" style="width:120px">
              <span style="opacity:.7">(пусто — только окно расписания)</span>
            </div>
            <div style="margin-top:6px">
              <div class="fl">Финальное сообщение</div>
              <textarea id="agent-fu-final" rows="2" style="width:100%"
                placeholder="Если появятся вопросы — напишите, будем рады помочь. Хорошего дня!"></textarea>
            </div>
            <div class="fl" style="opacity:.7;margin-top:4px">
              0 в первом поле — не напоминать. Оба срока считаются от вашего последнего сообщения клиенту.
              Напоминания уходят только внутри окна расписания.
            </div>
          </div>
```

- [ ] **Step 2: Заполнять поля при открытии**

В `frontend/js/pages/agent-settings.js` в `openAgentSettings` после строки с
`agent-schedule-end` добавить:

```js
    document.getElementById('agent-fu-delay1').value = s.followupDelay1Min || 0;
    document.getElementById('agent-fu-delay2').value = s.followupDelay2Min || 60;
    document.getElementById('agent-fu-latest').value = s.followupLatestTime || '';
    document.getElementById('agent-fu-final').value = s.followupFinalText || '';
```

- [ ] **Step 3: Отправлять поля при сохранении**

В `saveAgentSettings` перед вызовом `api` добавить проверку и расширить тело:

```js
  const fuDelay1 = Number(document.getElementById('agent-fu-delay1').value || 0);
  const fuDelay2 = Number(document.getElementById('agent-fu-delay2').value || 0);
  if (fuDelay1 > 0 && !(fuDelay2 > fuDelay1)) {
    notify('Финальное сообщение должно уходить позже напоминания', 'err');
    return;
  }
  try {
    await api('PUT', '/api/agent/settings', {
      enabled: document.getElementById('agent-enabled').checked,
      mode: _agentMode(),
      scheduleEnabled,
      scheduleStart,
      scheduleEnd,
      followupDelay1Min: fuDelay1,
      followupDelay2Min: fuDelay2,
      followupLatestTime: document.getElementById('agent-fu-latest').value,
      followupFinalText: document.getElementById('agent-fu-final').value,
    });
```

- [ ] **Step 4: Бампнуть версию скрипта**

В `frontend/index.html` найти тег `agent-settings.js` и заменить `?v=…` на `?v=2026-08-11a`.

- [ ] **Step 5: Проверить в браузере**

Через MCP Playwright: открыть «Чат» → «⚙️ Агент», ввести 15 и 60, «03:00», текст финала,
сохранить, закрыть, открыть заново — значения сохранились. Затем ввести 30 и 20 — форма
показывает ошибку и не шлёт запрос.

Проверить БД через `mcp__postgres__query`:

```sql
SELECT followup_delay1_min, followup_delay2_min, followup_latest_time, followup_final_text
  FROM agent_settings WHERE salon_id = 1;
```

- [ ] **Step 6: Commit**

```bash
git add frontend/index.html frontend/js/pages/agent-settings.js
git commit -m "feat(chat): настройки напоминаний о себе в модалке агента"
```

---

## Task 14: Живая проверка e2e

**Files:**
- Create: `backend/scripts/agent-followup-e2e.js`

- [ ] **Step 1: Написать скрипт**

Создать `backend/scripts/agent-followup-e2e.js`:

```js
'use strict';
// ============================================================
// Живой прогон напоминания о себе: реальный LLM, РЕАЛЬНАЯ БД, отправка
// ЗАСТАБЛЕНА (флаг --send шлёт по-настоящему).
//
//   node scripts/agent-followup-e2e.js [--phone 79200255591] [--send]
//
// Скрипт ОТКАЗЫВАЕТСЯ работать при живом pm2-процессе без --send или
// --allow-worker-running: его воркер тикает раз в минуту и может арендовать
// строку первым, отправив сообщение живому человеку (та же защита, что в
// scripts/reminders-e2e.js).
// ============================================================

const { execSync } = require('child_process');
const { db } = require('../db');
const worker = require('../services/agent/followup-worker');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, dflt) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : dflt; };

const PHONE = val('--phone', '79200255591');
const SALON_ID = Number(val('--salon', '1'));

function workerOnline() {
  try {
    const out = execSync('pm2 jlist', { encoding: 'utf8' });
    return JSON.parse(out).some(p => p.name === 'loyalpro' && p.pm2_env.status === 'online');
  } catch { return false; }
}

(async () => {
  if (workerOnline() && !has('--send') && !has('--allow-worker-running')) {
    console.error('pm2 loyalpro online — боевой воркер может перехватить строку. Останови процесс или передай --allow-worker-running.');
    process.exit(1);
  }

  const sent = [];
  const deps = has('--send') ? {} : {
    sendMessage: async (p) => { sent.push(p); return { id: 0, channel: 'whatsapp' }; },
    persistWhatsapp: async () => {},
    rememberPending: async () => {},
  };

  const ins = await db.one(
    `INSERT INTO agent_followups (salon_id, dialog_key, phone, channel, anchor_at, next_at, stage, status)
     VALUES ($1,$2,$3,'whatsapp', now() - interval '20 minutes', now() - interval '1 minute', 0, 'scheduled')
     ON CONFLICT (salon_id, dialog_key) WHERE status='scheduled'
     DO UPDATE SET next_at = now() - interval '1 minute', stage = 0
     RETURNING id`,
    [SALON_ID, PHONE, PHONE]);
  console.log(`строка #${ins.id} поставлена (диалог ${PHONE})`);

  await worker.processTick(deps);

  const row = await db.oneOrNone(
    `SELECT stage, status, close_reason, rendered_text FROM agent_followups WHERE id=$1`, [ins.id]);
  console.log('итог:', row);
  if (!has('--send')) console.log('перехвачено сообщений:', sent.length, sent.map(s => s.text));

  await db.query(`DELETE FROM agent_followups WHERE id=$1`, [ins.id]);
  console.log('строка удалена');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Прогнать**

Run: `cd /root/loyalpro/backend && pm2 stop loyalpro && node scripts/agent-followup-e2e.js && PORT=3001 pm2 start loyalpro`

Expected: в выводе `stage: 1`, `status: 'scheduled'`, непустой `rendered_text` (текст
напоминания от живой модели), одно перехваченное сообщение. Если вместо этого
`status: 'cancelled'` с причиной — прочитать `close_reason`: `disabled` означает, что интервалы
в салоне ещё нули (Task 13 не применён к этому салону), `client_replied` — у номера есть свежие
входящие, возьми другой номер.

- [ ] **Step 3: Commit**

```bash
git add backend/scripts/agent-followup-e2e.js
git commit -m "test(agent): живой прогон напоминания о себе"
```

---

## Task 15: Документация и полный прогон тестов

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Полный прогон тестов**

Run: `cd /root/loyalpro/backend && npx jest --silent --testPathIgnorePatterns primary-clients`
Expected: PASS. (`primary-clients.test.js` исключён — он зовёт `process.exit(1)` и роняет прогон,
это известный флейк проекта.)

Run: `cd /root/loyalpro/frontend/js/pages && node --test chat-wait-status.test.js chat-dialog-sort.test.js`
Expected: PASS

- [ ] **Step 2: Дописать раздел в `CLAUDE.md`**

В раздел «AI-агент: управление и гейт допуска» добавить пункт:

```markdown
- Ожидание ответа клиента и напоминания Милы о себе (`services/agent/followup-*.js`, очередь
  `agent_followups`, воркер кроном `* * * * *`, спека
  `docs/superpowers/specs/2026-08-11-agent-followup-waiting-status-design.md`): Мила ответила,
  пациент замолчал — через `followup_delay1_min` (дефолт схемы 0 = ВЫКЛЮЧЕНО, салон включает
  явно) уходит напоминание, текст пишет LLM своим промптом `followup-prompt.js`; через
  `followup_delay2_min` от ТОГО ЖЕ якоря — финальный шаблон из настроек, и строка закрывается.
  Оба срока меряются от якоря, а не «плюс N к предыдущему касанию». Строку заводит ДИСПЕТЧЕР в
  той же точке, где ставится вердикт `markDelivered` — единственная точка на все пять веток
  отправки; три из четырёх исключений («запись оформлена», `closing.js`/высокая оценка визита,
  служебные исходящие) отсекаются САМИМ этим местом, а не отдельными проверками: служебное идёт
  мимо диспетчера, молчание возвращает `silent`. Четвёртое («вежливый отказ») признака в коде не
  имеет и отсекается `skip`-ом LLM-прохода. Гасят строку три входа, и все обязательны: вебхук на
  входящем, пауза/эскалация оператора и сам воркер перепроверкой «нет входящих после
  `anchor_at`» (первые два опаздывают на секунды, третий закрывает гонку). Окно расписания
  ДЕЙСТВУЕТ — намеренное расхождение с «Заботой» и напоминаниями (`ignoreSchedule`): там время
  задаёт салон, здесь ход разговора, а у PERI окно ночное и напоминание в 10:20 легло бы поверх
  живого администратора; выпавшая строка СГОРАЕТ (`expired`), а не откладывается — через 12
  часов это уже не напоминание, и разрыв ≥6 ч включит блок «НАЧАЛО НОВОЙ ПЕРЕПИСКИ». Время
  (`HH:MM`) в напоминании законно, ТОЛЬКО если дословно звучало в прошлых репликах Милы
  (`followup-guard.js`), иначе отправки НЕ будет вовсе: вырезать подстроку нельзя — фраза рвётся,
  а у хода нет инструментов и проверить время негде (класс инцидента 10.08). Отправка идёт тем же
  путём, что реплика диспетчера (`pendingReplies.remember` + `persistWhatsappOutgoing` +
  `outgoing_authored` с `authored_by='agent'`) — без этого Мила не увидит собственное напоминание
  и повторится, «Чат» покажет молчание, а своё же эхо поставит диалог на паузу. Сторож доставки
  напоминания НЕ покрывает осознанно: повторять «напоминаю о себе» навязчиво, а переводить на
  человека диалог, который клиент игнорирует, — создавать салону ложную работу. Статус переписки
  отдельным полем НЕ хранится: `GET /api/chat/dialogs` отдаёт `followupStatus`/`followupStage`, а
  чип выводит чистый `frontend/js/pages/chat-wait-status.js` (`node --test`) — правило в одном
  месте по той же причине, что сортировка в `chat-dialog-sort.js`; смена стадии рассылается SSE
  `followup_status`. Аварийный рычаг — env `AGENT_FOLLOWUP=false` (гасит запуск воркера; строки
  очереди пишутся всегда — иначе у инцидента не будет журнала). Живая проверка —
  `scripts/agent-followup-e2e.js`.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: раздел про ожидание ответа клиента и напоминания Милы о себе"
```

---

## Самопроверка плана

**Покрытие спеки:**

| Требование спеки | Задача |
|---|---|
| Таблица `agent_followups`, частичный уникальный индекс, индекс аренды | Task 1 |
| Колонки настроек в `agent_settings` | Task 1, 3 |
| Лестница 15/60 от якоря | Task 2 |
| Валидация настроек, щадящий контракт `PUT` | Task 3 |
| Постановка строки в единой точке диспетчера, `writeSucceeded` наружу | Task 5 |
| Исключения (запись, `closing`, служебные, отказ) | Task 5 (`shouldAwaitReply`), Task 9 (skip) |
| Гашение: вебхук, оператор, воркер | Task 6, Task 10 (гейт 6) |
| Воркер, порядок гейтов, окно расписания без `ignoreSchedule` | Task 10 |
| Выпавшее сгорает (`expired`) | Task 10 (гейты 3–4) |
| Отправка тем же путём + `authored_by='agent'` | Task 10 (`defaultDeps`) |
| Сторож доставки не покрывает | Task 10 (не регистрируем), Task 15 (документируем) |
| Промпт своей рамкой, JSON, `OPERATOR_MARK` | Task 9 |
| Guard выдуманного времени | Task 8, применён в Task 10 |
| Финал шаблоном | Task 10 (`isFinal`) |
| Чип, фильтр, SSE | Task 7, 11, 12 |
| Настройки в модалке | Task 13 |
| Тесты, живой EXPLAIN, e2e | Task 2–13 (юниты), Task 10 (EXPLAIN), Task 14 |
| Документация | Task 15 |

**Согласованность имён:** `resolveDelays`/`nextAtFor`/`isTooLate` (Task 2) зовутся в
`followup-queue.js` (Task 4) и `followup-worker.js` (Task 10); `shouldAwaitReply` объявлен в
Task 5 и вызван там же в диспетчере; `hasInventedTime` (Task 8) вызван в Task 10;
`buildFollowupPrompt` (Task 9) — в Task 10; `emitFollowupStatus` (Task 7) — в Task 6 и Task 10;
`chatWaitStatus`/`chatWaitMatches`/`CHAT_WAIT_FILTERS` (Task 12) — в `chat.js` там же. Поля
ответа API `followupStatus`/`followupStage` (Task 11) читаются ровно этими именами в Task 12.
