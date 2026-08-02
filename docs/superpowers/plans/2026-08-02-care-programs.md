# «Отдел заботы» (программы заботы) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Автоматические цепочки касаний после состоявшегося визита (post-care Т+1/Т+14 и retention в месяцах) с LLM-проходом Милы перед каждой отправкой, статусами прохождений и дашбордом.

**Architecture:** Вебхук YClients при состоявшемся визите (`attendance=1` ИЛИ `paid_full=1`) зачисляет клиента в совпавшие программы (`care_programs` + цепочка `care_touches`), кладя касания в очередь `care_touch_sends`. Отдельный воркер в момент срабатывания гонит детерминированные проверки (гейт Милы, ЧС, эскалация, анти-спам «1 в день», повторный визит), затем лёгкий LLM-проход (транскрипт + будущие записи → строгий JSON send/skip/stop), затем отправку через Chatpush с каскадом каналов и персистом в переписку.

**Tech Stack:** Node/Express, pg (без ORM), существующие модули: `evaluateRule`/`resolveRouting` (services/notifications.js), `history.loadTranscript`, `pending-replies`, `reply-guard`, провайдеры `services/agent/providers`, Chatpush.

**Спека:** `docs/superpowers/specs/2026-08-02-care-programs-design.md`

**Тесты:** jest, файлы в корне `backend/` (конвенция репо: `backend/agent-gate.test.js`). Запуск: `cd backend && npx jest care-`.

---

### Task 1: Миграции — 4 таблицы

**Files:**
- Modify: `backend/migrations.js` (в конец списка миграций, рядом с блоком `notification_rules`, строки ~778+)

- [ ] **Step 1: Добавить SQL в migrations.js**

По образцу соседних блоков (`IF NOT EXISTS`, никогда не destructive). ВАЖНО: `care_touch_sends.touch_id` — `ON DELETE SET NULL` (НЕ CASCADE), иначе редактирование цепочки в админке сотрёт журнал отправок.

```sql
CREATE TABLE IF NOT EXISTS care_programs (
  id          SERIAL PRIMARY KEY,
  salon_id    INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  title       VARCHAR(255) NOT NULL,
  is_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  conditions  JSONB NOT NULL DEFAULT '{"logic":"and","items":[]}',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_care_programs_salon
  ON care_programs (salon_id, is_enabled);

CREATE TABLE IF NOT EXISTS care_touches (
  id          SERIAL PRIMARY KEY,
  salon_id    INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  program_id  INTEGER NOT NULL REFERENCES care_programs(id) ON DELETE CASCADE,
  title       VARCHAR(255) NOT NULL DEFAULT '',
  delay_days  INTEGER NOT NULL,
  send_time   VARCHAR(5) NOT NULL DEFAULT '10:30',
  intent_text TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_care_touches_program
  ON care_touches (program_id, sort_order);

CREATE TABLE IF NOT EXISTS care_enrollments (
  id                 BIGSERIAL PRIMARY KEY,
  salon_id           INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  program_id         INTEGER NOT NULL REFERENCES care_programs(id) ON DELETE CASCADE,
  client_id          INTEGER,
  phone              VARCHAR(20),
  yclients_record_id BIGINT NOT NULL,
  visit_at           TIMESTAMPTZ,
  staff_yc_id        BIGINT,
  staff_name         VARCHAR(255),
  services           JSONB DEFAULT '[]',
  status             VARCHAR(20) NOT NULL DEFAULT 'active',
  status_reason      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (program_id, yclients_record_id)
);
CREATE INDEX IF NOT EXISTS idx_care_enrollments_salon
  ON care_enrollments (salon_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_care_enrollments_phone
  ON care_enrollments (salon_id, phone) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS care_touch_sends (
  id              BIGSERIAL PRIMARY KEY,
  salon_id        INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  enrollment_id   BIGINT NOT NULL REFERENCES care_enrollments(id) ON DELETE CASCADE,
  touch_id        INTEGER REFERENCES care_touches(id) ON DELETE SET NULL,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'scheduled',
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  error           TEXT,
  decision_reason TEXT,
  rendered_text   TEXT,
  routing         JSONB,
  channel_used    VARCHAR(30),
  delivery_id     TEXT,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (enrollment_id, touch_id)
);
CREATE INDEX IF NOT EXISTS idx_care_touch_sends_due
  ON care_touch_sends (scheduled_at) WHERE status = 'scheduled';
```

Статусы (enum'ов в БД нет, валидируем в коде):
- enrollment: `active | completed | declined | escalated | superseded | stopped`
- send: `scheduled | sent | skipped | cancelled | failed`

- [ ] **Step 2: Прогнать миграции локально**

Run: `cd backend && node -e "require('./migrations').runMigrations().then(()=>{console.log('OK');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"`
(если экспорт называется иначе — посмотреть, как migrations.js зовётся из server.js, и повторить). Expected: `OK`, таблицы созданы.

- [ ] **Step 3: Commit**

```bash
git add backend/migrations.js
git commit -m "feat(care): таблицы программ заботы (programs/touches/enrollments/sends)"
```

---

### Task 2: `services/care/schedule.js` — чистый расчёт времени касаний

**Files:**
- Create: `backend/services/care/schedule.js`
- Test: `backend/care-schedule.test.js`

- [ ] **Step 1: Написать падающие тесты**

```js
'use strict';
const { parseVisitAt, computeScheduledAt, plusOneDay } = require('./services/care/schedule');

describe('care schedule', () => {
  test('parseVisitAt: строка YClients (салон-локальная = мск) → Date', () => {
    const d = parseVisitAt('2026-08-02 14:00:00');
    expect(d.toISOString()).toBe('2026-08-02T11:00:00.000Z'); // 14:00 мск
  });
  test('parseVisitAt: мусор → null', () => {
    expect(parseVisitAt('')).toBeNull();
    expect(parseVisitAt('не дата')).toBeNull();
  });
  test('Т+1 в 10:30 мск', () => {
    const visit = parseVisitAt('2026-08-02 14:00:00');
    expect(computeScheduledAt(visit, 1, '10:30').toISOString())
      .toBe('2026-08-03T07:30:00.000Z');
  });
  test('вечерний визит не сдвигает дату (день считается по мск-дате визита)', () => {
    const visit = parseVisitAt('2026-08-02 23:30:00'); // 20:30Z
    expect(computeScheduledAt(visit, 1, '10:30').toISOString())
      .toBe('2026-08-03T07:30:00.000Z');
  });
  test('retention 120 дней', () => {
    const visit = parseVisitAt('2026-08-02 14:00:00');
    expect(computeScheduledAt(visit, 120, '11:00').toISOString())
      .toBe('2026-11-30T08:00:00.000Z');
  });
  test('битый send_time → дефолт 10:30', () => {
    const visit = parseVisitAt('2026-08-02 14:00:00');
    expect(computeScheduledAt(visit, 1, '99:99').toISOString())
      .toBe('2026-08-03T07:30:00.000Z');
  });
  test('plusOneDay: +24ч (анти-спам сдвигает, не скипает)', () => {
    expect(plusOneDay(new Date('2026-08-03T07:30:00Z')).toISOString())
      .toBe('2026-08-04T07:30:00.000Z');
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd backend && npx jest care-schedule`
Expected: FAIL — `Cannot find module './services/care/schedule'`

- [ ] **Step 3: Реализация**

```js
'use strict';
// Планирование care-касаний. Всё время — московское. Модуль не полагается на
// TZ процесса: МСК фиксируется смещением +03:00 (в Москве нет перевода часов).

/** '2026-08-02 14:00:00' (строка YClients, салон-локальная) → Date | null. */
function parseVisitAt(s) {
  const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:00+03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 'YYYY-MM-DD' московской даты момента. */
function moscowDateStr(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d);
}

/** МСК-дата визита + delayDays, в send_time ('HH:MM') по Москве → Date. */
function computeScheduledAt(visitAt, delayDays, sendTime) {
  const visit = visitAt instanceof Date ? visitAt : new Date(visitAt);
  if (Number.isNaN(visit.getTime())) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(sendTime || '').trim());
  const hm = m ? m[0] : '10:30';
  const [y, mo, d] = moscowDateStr(visit).split('-').map(Number);
  const base = new Date(Date.UTC(y, mo - 1, d + Number(delayDays || 0)));
  const ymd = `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}-${String(base.getUTCDate()).padStart(2, '0')}`;
  return new Date(`${ymd}T${hm}:00+03:00`);
}

/** +24 часа: анти-спам «1 касание в день» сдвигает касание, не скипает. */
function plusOneDay(dt) { return new Date(dt.getTime() + 24 * 3600 * 1000); }

module.exports = { parseVisitAt, computeScheduledAt, plusOneDay };
```

- [ ] **Step 4: Тесты зелёные**

Run: `cd backend && npx jest care-schedule` → PASS (7 тестов)

- [ ] **Step 5: Commit**

```bash
git add backend/services/care/schedule.js backend/care-schedule.test.js
git commit -m "feat(care): расчёт scheduled_at касаний (мск, send_time, retention)"
```

---

### Task 3: `services/care/decision.js` — разбор решения LLM (fail-safe)

**Files:**
- Create: `backend/services/care/decision.js`
- Test: `backend/care-decision.test.js`

- [ ] **Step 1: Падающие тесты**

```js
'use strict';
const { parseCareDecision } = require('./services/care/decision');

describe('parseCareDecision', () => {
  test('send с текстом', () => {
    const d = parseCareDecision('{"action":"send","text":"Добрый день!","reason":"ок"}');
    expect(d).toEqual({ action: 'send', text: 'Добрый день!', reason: 'ок' });
  });
  test('JSON в ```-заборе', () => {
    const d = parseCareDecision('```json\n{"action":"skip","reason":"жалоба в переписке"}\n```');
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('жалоба в переписке');
  });
  test('send без текста → fail-safe skip', () => {
    const d = parseCareDecision('{"action":"send","text":"","reason":"x"}');
    expect(d).toMatchObject({ action: 'skip', failSafe: true });
  });
  test('не-JSON → fail-safe skip, НЕ отправка', () => {
    expect(parseCareDecision('Здравствуйте! Как самочувствие?'))
      .toMatchObject({ action: 'skip', failSafe: true });
  });
  test('неизвестный action → fail-safe skip', () => {
    expect(parseCareDecision('{"action":"escalate","reason":"x"}'))
      .toMatchObject({ action: 'skip', failSafe: true });
  });
  test('stop_program со статусом', () => {
    const d = parseCareDecision('{"action":"stop_program","status":"declined","reason":"просил не писать"}');
    expect(d).toEqual({ action: 'stop_program', status: 'declined', reason: 'просил не писать' });
  });
  test('stop_program с левым статусом → stopped', () => {
    const d = parseCareDecision('{"action":"stop_program","status":"banana","reason":"x"}');
    expect(d.status).toBe('stopped');
  });
});
```

- [ ] **Step 2: Run** `cd backend && npx jest care-decision` → FAIL (module not found)

- [ ] **Step 3: Реализация**

```js
'use strict';
// Разбор решения care-прохода Милы. LLM обязана вернуть строгий JSON:
//   { "action": "send"|"skip"|"stop_program", "text"?: string,
//     "status"?: "declined"|"completed", "reason": string }
// Всё неразобранное/невалидное → fail-safe skip (НЕ отправка): молчание
// безопаснее выдуманного сообщения пациенту.

const ACTIONS = new Set(['send', 'skip', 'stop_program']);
const STOP_STATUSES = new Set(['declined', 'completed']);

function failSafe(code) { return { action: 'skip', reason: code, failSafe: true }; }

function parseCareDecision(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return failSafe('llm_no_json');
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return failSafe('llm_bad_json'); }
  if (!ACTIONS.has(obj.action)) return failSafe('llm_bad_action');
  const reason = String(obj.reason || '').slice(0, 500);
  if (obj.action === 'send') {
    const text = String(obj.text || '').trim();
    if (!text) return failSafe('llm_empty_text');
    return { action: 'send', text, reason };
  }
  if (obj.action === 'stop_program') {
    return {
      action: 'stop_program',
      status: STOP_STATUSES.has(obj.status) ? obj.status : 'stopped',
      reason,
    };
  }
  return { action: 'skip', reason: reason || 'skip' };
}

module.exports = { parseCareDecision };
```

- [ ] **Step 4: Run** `cd backend && npx jest care-decision` → PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/care/decision.js backend/care-decision.test.js
git commit -m "feat(care): парс решения care-прохода с fail-safe skip"
```

---

### Task 4: `services/care/care-prompt.js` — промпт care-прохода

**Files:**
- Create: `backend/services/care/care-prompt.js`
- Test: `backend/care-prompt.test.js`

Лёгкий промпт БЕЗ каталога услуг. Контекст: интент касания, якорный визит (услуги/врач/дата), транскрипт, будущие записи.

- [ ] **Step 1: Падающие тесты**

```js
'use strict';
const { buildCarePrompt } = require('./services/care/care-prompt');

const base = {
  salonName: 'PERI CLINIC',
  clientName: 'Анна',
  touch: { title: 'Т+1 самочувствие', intent_text: 'Узнать самочувствие после процедуры, нет ли отёка.' },
  enrollment: {
    staff_name: 'Гаджиева Пери', visit_at: new Date('2026-08-02T11:00:00Z'),
    services: [{ id: 1, title: 'Биоревитализация' }],
  },
  transcript: [
    { direction: 'incoming', text: 'Здравствуйте, хочу записаться' },
    { direction: 'outgoing', text: 'Записала вас на 2 августа' },
  ],
  futureBookings: [{ datetime: '2026-08-20 14:00:00', services: ['Чистка'], staff_name: 'Юлия' }],
};

describe('buildCarePrompt', () => {
  test('system: правила и строгий JSON-контракт', () => {
    const { system } = buildCarePrompt(base);
    expect(system).toContain('"action"');
    expect(system).toContain('stop_program');
    expect(system).toContain('медицинск'); // запрет мед. советов
  });
  test('user: интент, врач, услуги визита, транскрипт, будущие записи', () => {
    const { user } = buildCarePrompt(base);
    expect(user).toContain('Узнать самочувствие');
    expect(user).toContain('Гаджиева Пери');
    expect(user).toContain('Биоревитализация');
    expect(user).toContain('хочу записаться');
    expect(user).toContain('Чистка');
  });
  test('пустой транскрипт и записи не ломают сборку', () => {
    const { user } = buildCarePrompt({ ...base, transcript: [], futureBookings: [] });
    expect(user).toContain('переписки не было');
    expect(user).toContain('будущих записей нет');
  });
  test('имя клиента опционально', () => {
    const { user } = buildCarePrompt({ ...base, clientName: null });
    expect(user).toContain('имя неизвестно');
  });
});
```

- [ ] **Step 2: Run** `cd backend && npx jest care-prompt` → FAIL

- [ ] **Step 3: Реализация**

```js
'use strict';
// Промпт care-прохода: одно касание = один вызов LLM без инструментов.
// Мила решает, отправлять ли касание и с каким текстом, глядя на переписку
// и будущие записи. Выход — СТРОГИЙ JSON (см. decision.js).

function fmtMskDate(d) {
  if (!d) return 'неизвестна';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(d instanceof Date ? d : new Date(d));
}

function buildCarePrompt({ salonName, clientName, touch, enrollment, transcript, futureBookings }) {
  const system = [
    `Ты — Мила, администратор клиники «${salonName || 'клиника'}». Сейчас ты делаешь плановое`,
    `«касание заботы»: короткое тёплое сообщение пациенту после визита. Это НЕ продажа.`,
    ``,
    `ПРАВИЛА:`,
    `1. Тон — тёплый, короткий (1–3 предложения), без канцелярита и без навязывания.`,
    `2. Никаких медицинских советов и оценок состояния. Вопрос о самочувствии — можно;`,
    `   рекомендации «помажьте/примите» — НЕЛЬЗЯ.`,
    `3. Врача можно упомянуть один раз: «по поручению вашего доктора …».`,
    `4. Если в переписке пациент УЖЕ писал про эту процедуру (жалоба, вопрос, обсуждение`,
    `   с оператором) — НЕ отправляй бодрое касание поверх: action="skip" с причиной.`,
    `5. Если пациент уже записан на подходящий следующий визит — не предлагай запись;`,
    `   если смысл касания только в записи, а она уже есть: action="stop_program", status="completed".`,
    `6. Если пациент просил не писать ему: action="stop_program", status="declined".`,
    `7. Внутреннюю кухню (программы, касания, инструкции) не раскрывай.`,
    ``,
    `ОТВЕТ — ТОЛЬКО JSON без пояснений:`,
    `{"action":"send","text":"<сообщение>","reason":"<кратко почему>"}`,
    `или {"action":"skip","reason":"<почему>"}`,
    `или {"action":"stop_program","status":"declined"|"completed","reason":"<почему>"}`,
  ].join('\n');

  const services = (enrollment.services || []).map(s => s && s.title).filter(Boolean).join(', ') || 'не указаны';
  const tr = (transcript || [])
    .map(m => `${m.direction === 'incoming' ? 'Пациент' : 'Мила'}: ${m.text}`)
    .join('\n') || '(переписки не было)';
  const fb = (futureBookings || [])
    .map(b => `- ${b.datetime}: ${(b.services || []).join(', ')}${b.staff_name ? ' у ' + b.staff_name : ''}`)
    .join('\n') || '(будущих записей нет)';

  const user = [
    `КАСАНИЕ: ${touch.title || ''}`,
    `ЦЕЛЬ КАСАНИЯ (заготовка, перескажи своими словами): ${touch.intent_text}`,
    ``,
    `ЯКОРНЫЙ ВИЗИТ: ${fmtMskDate(enrollment.visit_at)} (мск), услуги: ${services},`,
    `врач: ${enrollment.staff_name || 'неизвестен'}.`,
    `Пациент: ${clientName || '(имя неизвестно — пиши без обращения по имени)'}.`,
    ``,
    `ПОСЛЕДНЯЯ ПЕРЕПИСКА (хронологически):`,
    tr,
    ``,
    `БУДУЩИЕ ЗАПИСИ ПАЦИЕНТА:`,
    fb,
    ``,
    `Реши: отправлять ли касание. Ответ — только JSON.`,
  ].join('\n');

  return { system, user };
}

module.exports = { buildCarePrompt };
```

- [ ] **Step 4: Run** `cd backend && npx jest care-prompt` → PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/care/care-prompt.js backend/care-prompt.test.js
git commit -m "feat(care): промпт care-прохода (строгий JSON, мед-границы, анти-навязывание)"
```

---

### Task 5: Экспорт хелперов из notifications.js (переиспользование)

**Files:**
- Modify: `backend/services/notifications.js:276-286` (module.exports)

- [ ] **Step 1: Экспортировать `getServiceCategoryMap` и `lastIncomingChannel` как публичные**

В `module.exports` добавить `getServiceCategoryMap`, и заменить `_lastIncomingChannel: lastIncomingChannel` на публичный `lastIncomingChannel` (оставив старый ключ `_lastIncomingChannel`, если на него есть ссылки — проверить `grep -rn "_lastIncomingChannel" backend/`):

```js
module.exports = {
  handleRecordCreated,
  startNotificationWorker,
  ALLOWED_CHANNELS,
  // чистые хелперы — для роутов и тестов
  evaluateRule,
  renderTemplate,
  resolveRouting,
  splitVisitDatetime,
  // переиспользуются «Отделом заботы»
  getServiceCategoryMap,
  lastIncomingChannel,
  _lastIncomingChannel: lastIncomingChannel,
};
```

- [ ] **Step 2: Прогнать существующие тесты**

Run: `cd backend && npx jest notifications` → PASS (без регрессов)

- [ ] **Step 3: Commit**

```bash
git add backend/services/notifications.js
git commit -m "refactor(notifications): экспорт getServiceCategoryMap/lastIncomingChannel для care"
```

---

### Task 6: `services/care/enroll.js` — зачисление в программы

**Files:**
- Create: `backend/services/care/enroll.js`
- Test: `backend/care-enroll.test.js`

- [ ] **Step 1: Падающие тесты чистой части**

```js
'use strict';
const { isVisitCompleted } = require('./services/care/enroll');

describe('isVisitCompleted', () => {
  test('attendance=1 → визит состоялся', () => {
    expect(isVisitCompleted({ attendance: 1, paid_full: 0 })).toBe(true);
  });
  test('paid_full=1 → визит состоялся (даже при attendance=2)', () => {
    expect(isVisitCompleted({ attendance: 2, paid_full: 1 })).toBe(true);
  });
  test('ожидание/не пришёл/подтвердил без оплаты → нет', () => {
    expect(isVisitCompleted({ attendance: 0, paid_full: 0 })).toBe(false);
    expect(isVisitCompleted({ attendance: -1, paid_full: 0 })).toBe(false);
    expect(isVisitCompleted({ attendance: 2, paid_full: 0 })).toBe(false);
  });
  test('строковые значения из payload', () => {
    expect(isVisitCompleted({ attendance: '1' })).toBe(true);
    expect(isVisitCompleted({ paid_full: '1' })).toBe(true);
  });
  test('пусто → нет', () => {
    expect(isVisitCompleted({})).toBe(false);
    expect(isVisitCompleted(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run** `cd backend && npx jest care-enroll` → FAIL

- [ ] **Step 3: Реализация**

```js
'use strict';
// Зачисление в программы заботы. Триггер — вебхук записи, у которой визит
// СОСТОЯЛСЯ: attendance=1 ИЛИ paid_full=1 (именно ИЛИ — кэшбэчный критерий
// «оплачено деньгами» тут не годится: визит с оплатой бонусами тоже
// заслуживает заботы). Дедуп повторных доставок — UNIQUE (program_id, record_id).
//
// Повторный подходящий визит (курсовой клиент): прежний активный enrollment
// той же программы → 'superseded', его будущие касания → 'cancelled', цепочка
// стартует заново от нового визита.

const { db } = require('../../db');
const { evaluateRule, getServiceCategoryMap } = require('../notifications');
const { normalizePhoneKey } = require('../agent-gate');
const { parseVisitAt, computeScheduledAt } = require('./schedule');
const { createLogger } = require('../../logger');

const log = createLogger('CareEnroll');

/** Визит состоялся? attendance=1 ИЛИ paid_full=1. */
function isVisitCompleted(data) {
  if (!data) return false;
  return Number(data.attendance) === 1 || Number(data.paid_full) === 1;
}

/**
 * Вызывается из routes/webhook.js на resource==='record' (любой status —
 * attendance проставляют апдейтом после визита). Ошибки ловит вызывающий.
 */
async function handleRecordEvent(salon, payload) {
  const data = (payload && payload.data) || {};
  if (!data.id || !isVisitCompleted(data)) return;

  const programs = await db.any(
    `SELECT p.*,
            COALESCE(json_agg(json_build_object(
              'id', t.id, 'delay_days', t.delay_days, 'send_time', t.send_time
            ) ORDER BY t.sort_order, t.id) FILTER (WHERE t.id IS NOT NULL), '[]') AS touches
       FROM care_programs p
       LEFT JOIN care_touches t ON t.program_id = p.id
      WHERE p.salon_id = $1 AND p.is_enabled = TRUE
      GROUP BY p.id`,
    [salon.id]
  );
  if (!programs.length) return;

  const serviceIds = (Array.isArray(data.services) ? data.services : [])
    .map(s => s && s.id).filter(v => v != null);
  const catMap = await getServiceCategoryMap(salon).catch(() => new Map());
  const ctx = {
    staffId: data.staff && data.staff.id != null ? data.staff.id : null,
    serviceIds,
    categoryIds: [...new Set(serviceIds.map(id => catMap.get(String(id))).filter(Boolean))],
  };
  const matched = programs.filter(p => {
    try { return evaluateRule(p.conditions, ctx); }
    catch (e) { log.warn(`program #${p.id} evaluate failed: ${e.message}`); return false; }
  });
  if (!matched.length) return;

  const phone = normalizePhoneKey(data.client && data.client.phone);
  if (!phone) { log.info(`record=${data.id}: нет телефона клиента — забота невозможна`); return; }

  const client = await db.oneOrNone(
    `SELECT id, name, is_blacklisted FROM clients
      WHERE salon_id = $1 AND yclients_client_id = $2`,
    [salon.id, data.client && data.client.id]
  );
  if (client && client.is_blacklisted) {
    log.info(`record=${data.id}: клиент в ЧС — не зачисляем`); return;
  }

  const visitAt = parseVisitAt(data.date);
  const servicesJson = JSON.stringify((Array.isArray(data.services) ? data.services : [])
    .map(s => ({ id: s && s.id, title: s && s.title })).filter(s => s.title));

  for (const p of matched) {
    const enr = await db.oneOrNone(
      `INSERT INTO care_enrollments
         (salon_id, program_id, client_id, phone, yclients_record_id,
          visit_at, staff_yc_id, staff_name, services)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (program_id, yclients_record_id) DO NOTHING
       RETURNING id`,
      [salon.id, p.id, client ? client.id : null, phone, data.id,
       visitAt, (data.staff && data.staff.id) || null, (data.staff && data.staff.name) || null,
       servicesJson]
    );
    if (!enr) continue; // дубль вебхука / уже зачислен этим визитом

    // Прежние активные прохождения этой программы у этого клиента — устарели.
    const old = await db.any(
      `UPDATE care_enrollments
          SET status = 'superseded', status_reason = 'новый визит перезапустил программу',
              updated_at = NOW()
        WHERE salon_id = $1 AND program_id = $2 AND phone = $3
          AND status = 'active' AND id <> $4
        RETURNING id`,
      [salon.id, p.id, phone, enr.id]
    );
    if (old.length) {
      await db.query(
        `UPDATE care_touch_sends
            SET status = 'cancelled', decision_reason = 'enrollment superseded'
          WHERE enrollment_id = ANY($1::int[]) AND status = 'scheduled'`,
        [old.map(o => o.id)]
      );
    }

    const touches = Array.isArray(p.touches) ? p.touches : JSON.parse(p.touches || '[]');
    for (const t of touches) {
      const at = computeScheduledAt(visitAt || new Date(), t.delay_days, t.send_time);
      if (!at) continue;
      await db.query(
        `INSERT INTO care_touch_sends (salon_id, enrollment_id, touch_id, scheduled_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (enrollment_id, touch_id) DO NOTHING`,
        [salon.id, enr.id, t.id, at]
      );
    }
    log.info(`программа #${p.id} «${p.title}»: enrollment #${enr.id} record=${data.id}, касаний=${touches.length}${old.length ? `, superseded=[${old.map(o => o.id)}]` : ''}`);
  }
}

module.exports = { isVisitCompleted, handleRecordEvent };
```

- [ ] **Step 4: Run** `cd backend && npx jest care-enroll` → PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/care/enroll.js backend/care-enroll.test.js
git commit -m "feat(care): зачисление в программы по состоявшемуся визиту + superseded"
```

---

### Task 7: Вебхук — вызов зачисления

**Files:**
- Modify: `backend/routes/webhook.js:74-82`

- [ ] **Step 1: Подключить care-enroll после существующего блока notifications**

Вверху файла добавить `const care = require('../services/care/enroll');`. В блок `if (resourceType === 'record')` (после `handleRecordCreated`) добавить — на ЛЮБОЙ status, отбор внутри по attendance/paid_full:

```js
      // «Отдел заботы»: визит состоялся → зачисление в программы.
      // Свой catch — сбой заботы не должен ломать начисления.
      await care.handleRecordEvent(salon, payload).catch(e =>
        logger.error(`care enroll: ${e.message}`));
```

- [ ] **Step 2: Smoke — сервер поднимается**

Run: `cd backend && node -e "require('./routes/webhook.js'); console.log('OK')"` → `OK`

- [ ] **Step 3: Commit**

```bash
git add backend/routes/webhook.js
git commit -m "feat(care): вебхук зовёт зачисление в программы заботы"
```

---

### Task 8: `services/care/context.js` — записи клиента для проверок и промпта

**Files:**
- Create: `backend/services/care/context.js`
- Test: `backend/care-context.test.js`

Один живой запрос YClients от даты якоря обслуживает и retention-проверку (состоявшиеся визиты ПОСЛЕ якоря), и контекст LLM (будущие записи).

- [ ] **Step 1: Падающие тесты чистой части**

```js
'use strict';
const { splitRecords, hasMatchingRepeatVisit } = require('./services/care/context');

const anchorMs = Date.parse('2026-08-02T11:00:00Z');
const nowMs = Date.parse('2026-08-10T09:00:00Z');
const recs = [
  { id: 1, datetime: '2026-08-02T14:00:00+03:00', attendance: 1, services: [{ id: 10, title: 'Биорев' }] },      // сам якорь
  { id: 2, datetime: '2026-08-06T12:00:00+03:00', attendance: 1, services: [{ id: 10, title: 'Биорев' }] },      // повторный визит
  { id: 3, datetime: '2026-08-20T14:00:00+03:00', attendance: 0, services: [{ id: 30, title: 'Чистка' }], staff_id: 5 }, // будущая
  { id: 4, datetime: '2026-08-05T10:00:00+03:00', attendance: -1, services: [{ id: 10, title: 'Биорев' }] },     // не пришёл
];

describe('splitRecords', () => {
  test('делит на состоявшиеся-после-якоря и будущие', () => {
    const { completedAfter, future } = splitRecords(recs, anchorMs, nowMs);
    expect(completedAfter.map(r => r.id)).toEqual([2]);   // якорь и «не пришёл» отброшены
    expect(future.map(r => r.id)).toEqual([3]);
  });
});

describe('hasMatchingRepeatVisit', () => {
  const catMap = new Map([['10', '100']]);
  test('повторный визит по условиям программы найден', () => {
    const conditions = { logic: 'and', items: [{ type: 'service', ids: [10] }] };
    const { completedAfter } = splitRecords(recs, anchorMs, nowMs);
    expect(hasMatchingRepeatVisit(completedAfter, conditions, catMap)).toBe(true);
  });
  test('условия не совпали → false', () => {
    const conditions = { logic: 'and', items: [{ type: 'service', ids: [999] }] };
    const { completedAfter } = splitRecords(recs, anchorMs, nowMs);
    expect(hasMatchingRepeatVisit(completedAfter, conditions, catMap)).toBe(false);
  });
  test('пустые условия (программа «на любую запись») → любой повтор считается', () => {
    const { completedAfter } = splitRecords(recs, anchorMs, nowMs);
    expect(hasMatchingRepeatVisit(completedAfter, { logic: 'and', items: [] }, catMap)).toBe(true);
  });
});
```

- [ ] **Step 2: Run** `cd backend && npx jest care-context` → FAIL

- [ ] **Step 3: Реализация**

```js
'use strict';
// Живые записи клиента от даты якоря: retention-проверке нужны состоявшиеся
// визиты ПОСЛЕ якоря, care-промпту — будущие записи. Один запрос YClients
// обслуживает обоих.

const { db } = require('../../db');
const identity = require('../agent/identity');
const { ycGetClientRecords } = require('../yclients-records');
const { evaluateRule } = require('../notifications');

function moscowDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(ms));
}

/** Чистая: делит записи на состоявшиеся-после-якоря и будущие. */
function splitRecords(recs, anchorMs, nowMs) {
  const completedAfter = [];
  const future = [];
  for (const r of (recs || [])) {
    if (r.deleted) continue;
    const t = Date.parse(r.datetime || r.date || '');
    if (!Number.isFinite(t)) continue;
    const att = Number(r.attendance);
    if (att === 1 && t > anchorMs) completedAfter.push(r);
    if (att !== -1 && t >= nowMs) future.push(r);
  }
  return { completedAfter, future };
}

/** Чистая: есть ли среди состоявшихся визит, попадающий под условия программы. */
function hasMatchingRepeatVisit(completedAfter, conditions, catMap) {
  return (completedAfter || []).some(r => {
    const serviceIds = (Array.isArray(r.services) ? r.services : [])
      .map(s => s && s.id).filter(v => v != null);
    const ctx = {
      staffId: r.staff_id || (r.staff && r.staff.id) || null,
      serviceIds,
      categoryIds: [...new Set(serviceIds.map(id => (catMap || new Map()).get(String(id))).filter(Boolean))],
    };
    try { return evaluateRule(conditions, ctx); } catch { return false; }
  });
}

/** Живая загрузка: null при недоступности YClients (воркер решает, что делать). */
async function loadClientRecords(salonId, phone, anchorMs, nowMs) {
  const ycClientId = await identity.resolveYclientsClientId(salonId, phone);
  if (!ycClientId) return { completedAfter: [], future: [] };
  const salon = await db.one(
    `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
       FROM salons WHERE id = $1`, [salonId]);
  if (!salon.yclients_company_id) return { completedAfter: [], future: [] };
  const recs = await ycGetClientRecords(salon, ycClientId, { startDate: moscowDate(anchorMs) });
  return splitRecords(recs, anchorMs, nowMs);
}

module.exports = { splitRecords, hasMatchingRepeatVisit, loadClientRecords };
```

Примечание: у `ycGetClientRecords` посмотреть реальную сигнатуру в `backend/services/yclients-records.js` — использовать так же, как `tools/list-client-bookings.js:39`. Формат `datetime` в ответе YClients — с таймзоной; если поле «голое» (`YYYY-MM-DD HH:MM:SS`), парсить через `parseVisitAt` из Task 2 — проверить на живом ответе в Task 13 (e2e).

- [ ] **Step 4: Run** `cd backend && npx jest care-context` → PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/care/context.js backend/care-context.test.js
git commit -m "feat(care): записи клиента для retention-проверки и контекста промпта"
```

---

### Task 9: `services/care/worker.js` — воркер отправки

**Files:**
- Create: `backend/services/care/worker.js`
- Test: `backend/care-worker.test.js`

Все зависимости инжектируются (как `opts` у dispatcher) — юнит-тесты без БД/сети.

- [ ] **Step 1: Падающие тесты (моки всех deps)**

```js
'use strict';
const worker = require('./services/care/worker');

// Общий конструктор моков: happy-path, отдельные тесты переопределяют куски.
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
      dialogStatus: jest.fn(async () => null),                     // не эскалирован
      sentTodayExists: jest.fn(async () => false),                 // анти-спам
      loadClientRecords: jest.fn(async () => ({ completedAfter: [], future: [] })),
      getCatMap: jest.fn(async () => new Map()),
      loadTranscript: jest.fn(async () => ({ messages: [] })),
      createMessage: jest.fn(async () => ({ text: '{"action":"send","text":"Добрый день! Как самочувствие?","reason":"ок"}' })),
      lintReply: jest.fn(() => []),
      hardViolations: jest.fn(() => []),
      sendMessage: jest.fn(async () => ({ id: 777, channel: 'telegram' })),
      lastIncomingChannel: jest.fn(async () => 'telegram'),
      rememberPending: jest.fn(),
      persistWhatsapp: jest.fn(async () => {}),
      log: { info: () => {}, warn: () => {}, error: () => {} },
      ...over,
    },
  };
}

const row = {
  id: 1, salon_id: 5, enrollment_id: 11, touch_id: 21, attempts: 1,
  phone: '79200255591', enrollment_status: 'active', program_enabled: true,
  program_conditions: { logic: 'and', items: [] },
  staff_name: 'Пери', visit_at: new Date('2026-08-02T11:00:00Z'),
  visit_services: [{ id: 10, title: 'Биорев' }],
  intent_text: 'Узнать самочувствие', touch_title: 'Т+1', delay_days: 1,
  salon_name: 'PERI', client_name: 'Анна',
};

describe('care worker processOne', () => {
  test('happy path: LLM send → отправлено, строка sent', async () => {
    const { deps } = makeDeps();
    await worker.processOne(row, deps);
    expect(deps.sendMessage).toHaveBeenCalled();
    expect(deps.rememberPending).toHaveBeenCalledWith(5, '79200255591', 'Добрый день! Как самочувствие?');
    const sent = deps.db.query.mock.calls.find(c => c[0].includes(`'sent'`));
    expect(sent).toBeTruthy();
  });
  test('гейт запретил → skipped, LLM не зовётся', async () => {
    const { deps } = makeDeps({ isAllowed: jest.fn(async () => ({ allow: false, reason: 'whitelist' })) });
    await worker.processOne(row, deps);
    expect(deps.createMessage).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
    const skipped = deps.db.query.mock.calls.find(c => c[0].includes(`'skipped'`));
    expect(skipped).toBeTruthy();
  });
  test('диалог на операторе → skipped', async () => {
    const { deps } = makeDeps({ dialogStatus: jest.fn(async () => 'escalated') });
    await worker.processOne(row, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
  test('анти-спам: уже слали сегодня → сдвиг на завтра, не skip', async () => {
    const { deps } = makeDeps({ sentTodayExists: jest.fn(async () => true) });
    await worker.processOne(row, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    const moved = deps.db.query.mock.calls.find(c => c[0].includes('scheduled_at'));
    expect(moved).toBeTruthy();
  });
  test('повторный визит по условиям → enrollment completed, касание cancelled', async () => {
    const { deps } = makeDeps({
      loadClientRecords: jest.fn(async () => ({
        completedAfter: [{ datetime: '2026-08-06T12:00:00+03:00', attendance: 1, services: [{ id: 10 }] }],
        future: [],
      })),
    });
    await worker.processOne(row, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    const completed = deps.db.query.mock.calls.find(c => c[0].includes(`'completed'`));
    expect(completed).toBeTruthy();
  });
  test('LLM stop_program declined → enrollment declined, остальные касания cancelled', async () => {
    const { deps } = makeDeps({
      createMessage: jest.fn(async () => ({ text: '{"action":"stop_program","status":"declined","reason":"просил не писать"}' })),
    });
    await worker.processOne(row, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    const declined = deps.db.query.mock.calls.find(c => c[0].includes(`'declined'`));
    expect(declined).toBeTruthy();
  });
  test('LLM вернул мусор → fail-safe skipped', async () => {
    const { deps } = makeDeps({ createMessage: jest.fn(async () => ({ text: 'ой' })) });
    await worker.processOne(row, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
  test('reply-guard жёсткое нарушение → skipped, не отправляем', async () => {
    const { deps } = makeDeps({ hardViolations: jest.fn(() => [{ type: 'id_leak' }]) });
    await worker.processOne(row, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
  test('сбой отправки → строка остаётся на ретрай (attempts<3)', async () => {
    const { deps } = makeDeps({ sendMessage: jest.fn(async () => { throw new Error('net'); }) });
    await worker.processOne(row, deps);
    const backToScheduled = deps.db.query.mock.calls.find(c => c[0].includes(`'scheduled'`) || c[0].includes(`'failed'`));
    expect(backToScheduled).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run** `cd backend && npx jest care-worker` → FAIL

- [ ] **Step 3: Реализация**

```js
'use strict';
// Воркер «Отдела заботы». Аренда due-строк как в notification-воркере
// (FOR UPDATE SKIP LOCKED + attempts при аренде), затем на каждую строку:
// детерминированные проверки → care-проход LLM → отправка → персист.
// Все внешние зависимости инжектируются (юнит-тесты без БД/сети).

const config = require('../../config');
const { db: realDb } = require('../../db');
const chatpush = require('../chatpush');
const agentSettings = require('../agent-settings');
const { getProvider } = require('../agent/providers');
const history = require('../agent/history');
const pendingReplies = require('../agent/pending-replies');
const replyGuard = require('../agent/reply-guard');
const notifications = require('../notifications');
const context = require('./context');
const { buildCarePrompt } = require('./care-prompt');
const { parseCareDecision } = require('./decision');
const { plusOneDay } = require('./schedule');
const { createLogger } = require('../../logger');

const log = createLogger('CareWorker');

const WORKER_TICK_MS  = 15000;
const MAX_ATTEMPTS    = 3;
const RETRY_BACKOFF_S = 120;

const defaultDeps = {
  db: realDb,
  isAllowed: (salonId, phone) => agentSettings.isAllowed(salonId, phone),
  agentGloballyEnabled: () => !!config.CHATPUSH.agentEnabled,
  dialogStatus: async (salonId, phone) => {
    const r = await realDb.oneOrNone(
      `SELECT status FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`,
      [salonId, phone]);
    return r ? r.status : null;
  },
  sentTodayExists: async (salonId, phone) => {
    const r = await realDb.oneOrNone(
      `SELECT 1 FROM care_touch_sends s
         JOIN care_enrollments e ON e.id = s.enrollment_id
        WHERE e.salon_id = $1 AND e.phone = $2 AND s.status = 'sent'
          AND (s.sent_at AT TIME ZONE 'Europe/Moscow')::date
              = (NOW() AT TIME ZONE 'Europe/Moscow')::date
        LIMIT 1`,
      [salonId, phone]);
    return !!r;
  },
  loadClientRecords: context.loadClientRecords,
  getCatMap: async (salonId) => {
    const salon = await realDb.one(
      `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
         FROM salons WHERE id=$1`, [salonId]);
    return notifications.getServiceCategoryMap(salon);
  },
  loadTranscript: (salonId, key, opts) => history.loadTranscript(salonId, key, opts),
  createMessage: (req, opts) => getProvider().createMessage(req, opts),
  lintReply: replyGuard.lintReply,
  hardViolations: replyGuard.hardViolations,
  sendMessage: (payload) => chatpush.sendMessage(config.CHATPUSH.instanceToken, payload),
  lastIncomingChannel: notifications.lastIncomingChannel,
  rememberPending: (salonId, key, text) => pendingReplies.remember(salonId, key, text),
  persistWhatsapp: async () => {},   // подключается в Task 10
  log,
};

async function markSend(db, id, status, reason) {
  await db.query(
    `UPDATE care_touch_sends SET status=$2, decision_reason=$3 WHERE id=$1`,
    [id, status, reason || null]);
}

async function stopEnrollment(db, enrollmentId, status, reason) {
  await db.query(
    `UPDATE care_enrollments SET status=$2, status_reason=$3, updated_at=NOW()
      WHERE id=$1 AND status='active'`,
    [enrollmentId, status, reason || null]);
  await db.query(
    `UPDATE care_touch_sends SET status='cancelled', decision_reason=$2
      WHERE enrollment_id=$1 AND status='scheduled'`,
    [enrollmentId, `enrollment ${status}: ${reason || ''}`.slice(0, 500)]);
}

/** Цепочка пройдена (нет больше scheduled) → enrollment completed. */
async function maybeCompleteChain(db, enrollmentId) {
  const left = await db.oneOrNone(
    `SELECT 1 FROM care_touch_sends WHERE enrollment_id=$1 AND status='scheduled' LIMIT 1`,
    [enrollmentId]);
  if (!left) {
    await db.query(
      `UPDATE care_enrollments SET status='completed', status_reason='цепочка пройдена',
              updated_at=NOW()
        WHERE id=$1 AND status='active'`, [enrollmentId]);
  }
}

async function processOne(row, deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };
  const { db } = d;
  const sid = row.salon_id;

  try {
    // ── детерминированные проверки ─────────────────────────────
    if (row.enrollment_status !== 'active') {
      return markSend(db, row.id, 'cancelled', `enrollment ${row.enrollment_status}`);
    }
    if (!row.program_enabled) return markSend(db, row.id, 'skipped', 'программа выключена');
    if (!d.agentGloballyEnabled()) return markSend(db, row.id, 'skipped', 'агент выключен (env)');

    const gate = await d.isAllowed(sid, row.phone);   // fail-closed: throw → catch ниже
    if (!gate.allow) return markSend(db, row.id, 'skipped', `гейт Милы: ${gate.reason}`);

    const dlg = await d.dialogStatus(sid, row.phone);
    if (dlg === 'escalated') return markSend(db, row.id, 'skipped', 'диалог на операторе');

    if (await d.sentTodayExists(sid, row.phone)) {
      // Анти-спам «1 касание в день»: сдвигаем на завтра, бюджет попыток обнуляем.
      await db.query(
        `UPDATE care_touch_sends SET scheduled_at=$2, attempts=0, last_attempt_at=NULL,
                decision_reason='анти-спам: сдвинуто на день'
          WHERE id=$1`,
        [row.id, plusOneDay(new Date(row.scheduled_at || Date.now()))]);
      return;
    }

    // Повторный визит по условиям программы после якоря → цель достигнута.
    const anchorMs = row.visit_at ? new Date(row.visit_at).getTime() : Date.now();
    let records = { completedAfter: [], future: [] };
    try { records = await d.loadClientRecords(sid, row.phone, anchorMs, Date.now()); }
    catch (e) { d.log.warn(`send #${row.id}: записи YClients недоступны (${e.message}) — контекст без них`); }
    const catMap = await d.getCatMap(sid).catch(() => new Map());
    if (context.hasMatchingRepeatVisit(records.completedAfter, row.program_conditions, catMap)) {
      await stopEnrollment(db, row.enrollment_id, 'completed', 'клиент уже был на повторном визите');
      return markSend(db, row.id, 'cancelled', 'повторный визит состоялся');
    }

    // ── care-проход LLM ────────────────────────────────────────
    const transcript = await d.loadTranscript(sid, row.phone, { limit: 15 })
      .catch(() => ({ messages: [] }));
    const trList = (transcript.messages || []).map(m => ({
      direction: m.role === 'user' ? 'incoming' : 'outgoing',
      text: typeof m.content === 'string' ? m.content
        : (Array.isArray(m.content) ? m.content.map(b => b.text || '').join(' ') : ''),
    })).filter(m => m.text);
    const futureBookings = records.future.map(r => ({
      datetime: r.datetime || r.date || '',
      services: (Array.isArray(r.services) ? r.services : []).map(s => s.title).filter(Boolean),
      staff_name: (r.staff && r.staff.name) || null,
    }));
    const { system, user } = buildCarePrompt({
      salonName: row.salon_name, clientName: row.client_name,
      touch: { title: row.touch_title, intent_text: row.intent_text },
      enrollment: { staff_name: row.staff_name, visit_at: row.visit_at, services: row.visit_services },
      transcript: trList, futureBookings,
    });
    const resp = await d.createMessage(
      { system, messages: [{ role: 'user', content: user }] },
      { maxTokens: 700 });
    const decision = parseCareDecision(resp && resp.text);

    if (decision.action === 'stop_program') {
      await stopEnrollment(db, row.enrollment_id, decision.status, decision.reason);
      return markSend(db, row.id, 'cancelled', `Мила: ${decision.reason}`);
    }
    if (decision.action === 'skip') {
      await markSend(db, row.id, 'skipped', `Мила: ${decision.reason}`);
      return maybeCompleteChain(db, row.enrollment_id);
    }

    // ── отправка ───────────────────────────────────────────────
    const viol = d.hardViolations(d.lintReply(decision.text, {}));
    if (viol.length) {
      await markSend(db, row.id, 'skipped',
        `reply-guard: ${viol.map(v => v.type).join(',')}`);
      return maybeCompleteChain(db, row.enrollment_id);
    }
    const last = await d.lastIncomingChannel(sid, row.phone).catch(() => null);
    const routing = notifications.resolveRouting([], true, last);   // дефолт telegram→whatsapp
    const delivery = await d.sendMessage({ text: decision.text, phone: row.phone, dispatchRouting: routing });
    const channelUsed = (delivery && (delivery.channel || delivery.messenger)) || routing[0] || null;

    await db.query(
      `UPDATE care_touch_sends
          SET status='sent', sent_at=NOW(), error=NULL, decision_reason=$2,
              rendered_text=$3, routing=$4::jsonb, delivery_id=$5, channel_used=$6
        WHERE id=$1`,
      [row.id, `Мила: ${decision.reason}`, decision.text, JSON.stringify(routing),
       delivery && delivery.id != null ? String(delivery.id) : null, channelUsed]);

    // Транскрипт/чат: pending до прихода эха; whatsapp эха не шлёт — персист сразу.
    d.rememberPending(sid, row.phone, decision.text);
    if (channelUsed === 'whatsapp') {
      await d.persistWhatsapp(sid, { delivery, phone: row.phone, text: decision.text })
        .catch(e => d.log.error(`persist wa: ${e.message}`));
    }
    d.log.info(`sent #${row.id} enrollment=${row.enrollment_id} routing=[${routing.join(',')}]`);
    await maybeCompleteChain(db, row.enrollment_id);
  } catch (e) {
    const final = row.attempts >= MAX_ATTEMPTS;
    await d.db.query(
      `UPDATE care_touch_sends SET status=$2, error=$3 WHERE id=$1`,
      [row.id, final ? 'failed' : 'scheduled', String(e.message || e).slice(0, 500)]
    ).catch(() => {});
    d.log.warn(`send #${row.id} attempt ${row.attempts}/${MAX_ATTEMPTS} failed: ${e.message}`);
  }
}

async function processTick(deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };
  const rows = await d.db.any(
    `UPDATE care_touch_sends cts
        SET attempts = cts.attempts + 1, last_attempt_at = NOW()
       FROM care_enrollments e
       JOIN care_programs p ON p.id = e.program_id
       JOIN salons sal ON sal.id = e.salon_id
       LEFT JOIN care_touches t ON t.id = cts.touch_id
       LEFT JOIN clients c ON c.id = e.client_id
      WHERE e.id = cts.enrollment_id
        AND cts.id IN (
          SELECT id FROM care_touch_sends
           WHERE status = 'scheduled' AND scheduled_at <= NOW()
             AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - make_interval(secs => $1))
           ORDER BY scheduled_at ASC
           LIMIT 5
           FOR UPDATE SKIP LOCKED)
      RETURNING cts.*, e.phone, e.status AS enrollment_status, e.staff_name, e.visit_at,
                e.services AS visit_services, e.program_id, e.client_id,
                p.is_enabled AS program_enabled, p.conditions AS program_conditions,
                p.title AS program_title, sal.name AS salon_name, c.name AS client_name,
                t.intent_text, t.title AS touch_title, t.delay_days`,
    [RETRY_BACKOFF_S]);
  for (const row of rows) {
    if (!row.touch_id || row.intent_text == null) {   // касание удалили из программы
      await markSend(d.db, row.id, 'cancelled', 'касание удалено из программы').catch(() => {});
      continue;
    }
    await processOne(row, d);
  }
}

let _running = false;
function startCareWorker() {
  if (_running) return;
  _running = true;
  if (!config.CHATPUSH.instanceToken) {
    log.warn('CHATPUSH_INSTANCE_TOKEN is not set — care worker disabled');
    return;
  }
  setInterval(() => { processTick().catch(e => log.error(`tick: ${e.message}`)); }, WORKER_TICK_MS);
  log.info(`Care worker started (tick=${WORKER_TICK_MS}ms)`);
}

module.exports = { processOne, processTick, startCareWorker, defaultDeps };
```

Замечания для реализации:
- Синтаксис `UPDATE … FROM e JOIN p …` в PG валиден (первая таблица после FROM, дальше JOIN'ы). Если по месту не заведётся — переписать FROM-часть через запятую и WHERE-связки, как в notifications.js:214.
- `row.program_conditions` приходит как объект (jsonb) — прокидывать как есть.
- Гейт `isAllowed` бросил → общий catch: строка уйдёт на ретрай, а после 3 попыток `failed` — fail-closed, отправки не будет.

- [ ] **Step 4: Run** `cd backend && npx jest care-worker` → PASS (9 тестов)

- [ ] **Step 5: Commit**

```bash
git add backend/services/care/worker.js backend/care-worker.test.js
git commit -m "feat(care): воркер касаний — детерминированные проверки + care-проход Милы"
```

---

### Task 10: Персист whatsapp-касания + запуск воркера

**Files:**
- Modify: `backend/routes/chat.js:216` (извлечь `persistWhatsappOutgoing`)
- Create: `backend/services/chat-persist.js`
- Modify: `backend/services/care/worker.js` (defaultDeps.persistWhatsapp)
- Modify: `backend/server.js` (рядом с `startNotificationWorker`)

- [ ] **Step 1: Вынести `persistWhatsappOutgoing` из routes/chat.js в services/chat-persist.js**

Перенести функцию (routes/chat.js:216-235) БЕЗ изменений логики в новый модуль `backend/services/chat-persist.js` (`module.exports = { persistWhatsappOutgoing }`), в chat.js заменить на импорт. Механизм дедупа эха (`external_message_id = 'api:'+delivery_id`, `ON CONFLICT DO NOTHING`) сохранить дословно. Если функция шлёт SSE-событие — перенести вместе с ней.

- [ ] **Step 2: Подключить в воркере**

В `backend/services/care/worker.js` заменить заглушку:

```js
const { persistWhatsappOutgoing } = require('../chat-persist');
// в defaultDeps:
  persistWhatsapp: (salonId, { delivery, phone, text }) =>
    persistWhatsappOutgoing(salonId, { delivery, phone, chatId: null, text, msgType: 'text' }),
```

(сигнатуру сверить с фактической после переноса — она принимает `{ delivery, phone, chatId, text, msgType, fileUrl, mimeType }`).

- [ ] **Step 3: Запуск воркера в server.js**

Рядом с существующим `startNotificationWorker()`:

```js
require('./services/care/worker').startCareWorker();
```

- [ ] **Step 4: Проверки**

Run: `cd backend && npx jest care- && node -e "require('./routes/chat.js'); require('./server.js? нет — только синтаксис')"` — вместо последнего: `node --check server.js && node --check routes/chat.js && node --check services/chat-persist.js`
Expected: тесты PASS, синтаксис OK. Затем перезапуск дева: `PORT=3001 pm2 restart loyalpro --update-env && sleep 3 && curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/` → `200`, в логах `Care worker started`.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/chat.js backend/services/chat-persist.js backend/services/care/worker.js backend/server.js
git commit -m "feat(care): персист whatsapp-касаний (общий chat-persist) + запуск воркера"
```

---

### Task 11: Хук эскалации → красный флаг enrollment'а

**Files:**
- Modify: `backend/services/agent/tools/escalate-to-operator.js:20-35`

- [ ] **Step 1: После UPDATE agent_dialogs добавить**

```js
  // «Отдел заботы»: активные прохождения этого клиента — красный флаг на дашборде.
  // dialogKey для телефонных каналов = номер; для групп (g:<id>) ничего не совпадёт.
  await db.query(
    `UPDATE care_enrollments
        SET status='escalated', status_reason=$3, updated_at=NOW()
      WHERE salon_id=$1 AND phone=$2 AND status='active'`,
    [salonId, dialogKey, reason]).catch(() => {});
  await db.query(
    `UPDATE care_touch_sends SET status='cancelled', decision_reason='эскалация на оператора'
      WHERE status='scheduled' AND enrollment_id IN
        (SELECT id FROM care_enrollments WHERE salon_id=$1 AND phone=$2 AND status='escalated')`,
    [salonId, dialogKey]).catch(() => {});
```

- [ ] **Step 2: Прогнать агентские тесты на регресс**

Run: `cd backend && npx jest escalate agent-` → PASS (без регрессов)

- [ ] **Step 3: Commit**

```bash
git add backend/services/agent/tools/escalate-to-operator.js
git commit -m "feat(care): эскалация помечает активные enrollments красным флагом"
```

---

### Task 12: API `routes/care.js`

**Files:**
- Create: `backend/routes/care.js`
- Modify: `backend/routes/index.js:67` (рядом с notification-rules)

Конвенции — как в `routes/notification-rules.js` (`guard = [auth, requireRole('owner','admin')]`, валидация тела в функции, логгер).

- [ ] **Step 1: Реализация роутера**

```js
// ============================================================
// «Отдел заботы»: программы + дашборд (страница «Забота»)
// ============================================================
//
// Mounted at /api/care. owner/admin only.
//
//   GET    /programs              → программы с касаниями и счётчиками
//   POST   /programs              → создать (title, conditions, touches[])
//   PUT    /programs/:id          → обновить + заменить цепочку (upsert по id)
//   POST   /programs/:id/toggle   → вкл/выкл
//   DELETE /programs/:id          → удалить (enrollments и журнал уходят каскадом!)
//   GET    /enrollments           → дашборд (?status=&program_id=)
//   GET    /enrollments/:id/sends → журнал касаний прохождения
//   POST   /enrollments/:id/stop  → ручная остановка
//
const router = require('express').Router();
const { auth, requireRole } = require('../middleware/auth');
const { db } = require('../db');
const { createLogger } = require('../logger');

const log = createLogger('Care');
const guard = [auth, requireRole('owner', 'admin')];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseProgramBody(body) {
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

  const rawTouches = Array.isArray(b.touches) ? b.touches : [];
  if (!rawTouches.length) return { error: 'Нужно хотя бы одно касание' };
  if (rawTouches.length > 20) return { error: 'Слишком много касаний (макс 20)' };
  const touches = [];
  for (const [i, t] of rawTouches.entries()) {
    const intent = String((t && t.intentText) || '').trim();
    if (!intent) return { error: `Касание ${i + 1}: текст-заготовка пуст` };
    if (intent.length > 2000) return { error: `Касание ${i + 1}: заготовка слишком длинная` };
    const delay = Number(t.delayDays);
    if (!Number.isInteger(delay) || delay < 0 || delay > 730)
      return { error: `Касание ${i + 1}: задержка 0–730 дней` };
    const sendTime = TIME_RE.test(String(t.sendTime || '')) ? t.sendTime : '10:30';
    touches.push({
      id: Number.isInteger(Number(t.id)) ? Number(t.id) : null,
      title: String((t && t.title) || '').trim().slice(0, 255),
      delayDays: delay, sendTime, intentText: intent, sortOrder: i,
    });
  }
  return { value: { title, conditions: { logic, items }, touches } };
}

// GET /programs
router.get('/programs', guard, async (req, res) => {
  try {
    const rows = await db.any(
      `SELECT p.*,
              COALESCE((SELECT json_agg(json_build_object(
                  'id', t.id, 'title', t.title, 'delayDays', t.delay_days,
                  'sendTime', t.send_time, 'intentText', t.intent_text
                ) ORDER BY t.sort_order, t.id)
                FROM care_touches t WHERE t.program_id = p.id), '[]'::json) AS touches,
              (SELECT COUNT(*) FROM care_enrollments e
                WHERE e.program_id = p.id AND e.status = 'active') AS active_count,
              (SELECT COUNT(*) FROM care_touch_sends s
                 JOIN care_enrollments e ON e.id = s.enrollment_id
                WHERE e.program_id = p.id AND s.status = 'sent') AS sent_count
         FROM care_programs p
        WHERE p.salon_id = $1
        ORDER BY p.id DESC`,
      [req.user.salon_id]);
    res.json({ programs: rows });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Ошибка загрузки программ' }); }
});

// POST /programs
router.post('/programs', guard, async (req, res) => {
  const parsed = parseProgramBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.value;
  try {
    const p = await db.one(
      `INSERT INTO care_programs (salon_id, title, conditions, created_by)
       VALUES ($1,$2,$3::jsonb,$4) RETURNING id`,
      [req.user.salon_id, v.title, JSON.stringify(v.conditions), req.user.id]);
    for (const t of v.touches) {
      await db.query(
        `INSERT INTO care_touches (salon_id, program_id, title, delay_days, send_time, intent_text, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.user.salon_id, p.id, t.title, t.delayDays, t.sendTime, t.intentText, t.sortOrder]);
    }
    res.json({ id: p.id });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Ошибка создания' }); }
});

// PUT /programs/:id — upsert касаний по id: удалённые из формы касания
// удаляются из таблицы (их scheduled-отправки отменяются; журнал сохраняется —
// touch_id в care_touch_sends становится NULL по ON DELETE SET NULL).
router.put('/programs/:id', guard, async (req, res) => {
  const parsed = parseProgramBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.value;
  const pid = Number(req.params.id);
  try {
    const owned = await db.oneOrNone(
      `SELECT id FROM care_programs WHERE id=$1 AND salon_id=$2`, [pid, req.user.salon_id]);
    if (!owned) return res.status(404).json({ error: 'Программа не найдена' });

    await db.query(
      `UPDATE care_programs SET title=$2, conditions=$3::jsonb, updated_at=NOW() WHERE id=$1`,
      [pid, v.title, JSON.stringify(v.conditions)]);

    const keepIds = [];
    for (const t of v.touches) {
      if (t.id) {
        const r = await db.query(
          `UPDATE care_touches SET title=$3, delay_days=$4, send_time=$5, intent_text=$6, sort_order=$7
            WHERE id=$1 AND program_id=$2`,
          [t.id, pid, t.title, t.delayDays, t.sendTime, t.intentText, t.sortOrder]);
        if (r.rowCount) { keepIds.push(t.id); continue; }
      }
      const ins = await db.one(
        `INSERT INTO care_touches (salon_id, program_id, title, delay_days, send_time, intent_text, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [req.user.salon_id, pid, t.title, t.delayDays, t.sendTime, t.intentText, t.sortOrder]);
      keepIds.push(ins.id);
    }
    await db.query(
      `UPDATE care_touch_sends SET status='cancelled', decision_reason='касание удалено из программы'
        WHERE status='scheduled' AND touch_id IN
          (SELECT id FROM care_touches WHERE program_id=$1 AND NOT (id = ANY($2::int[])))`,
      [pid, keepIds]);
    await db.query(
      `DELETE FROM care_touches WHERE program_id=$1 AND NOT (id = ANY($2::int[]))`,
      [pid, keepIds]);
    res.json({ ok: true });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Ошибка сохранения' }); }
});

// POST /programs/:id/toggle
router.post('/programs/:id/toggle', guard, async (req, res) => {
  try {
    const r = await db.oneOrNone(
      `UPDATE care_programs SET is_enabled = NOT is_enabled, updated_at=NOW()
        WHERE id=$1 AND salon_id=$2 RETURNING is_enabled`,
      [Number(req.params.id), req.user.salon_id]);
    if (!r) return res.status(404).json({ error: 'Программа не найдена' });
    res.json({ isEnabled: r.is_enabled });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Ошибка' }); }
});

// DELETE /programs/:id
router.delete('/programs/:id', guard, async (req, res) => {
  try {
    const r = await db.query(
      `DELETE FROM care_programs WHERE id=$1 AND salon_id=$2`,
      [Number(req.params.id), req.user.salon_id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Программа не найдена' });
    res.json({ ok: true });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Ошибка удаления' }); }
});

// GET /enrollments — дашборд «Клиенты»
router.get('/enrollments', guard, async (req, res) => {
  try {
    const cond = ['e.salon_id = $1'];
    const params = [req.user.salon_id];
    if (req.query.status) { params.push(String(req.query.status)); cond.push(`e.status = $${params.length}`); }
    if (req.query.program_id) { params.push(Number(req.query.program_id)); cond.push(`e.program_id = $${params.length}`); }
    const rows = await db.any(
      `SELECT e.id, e.status, e.status_reason, e.phone, e.visit_at, e.staff_name,
              e.services, e.created_at, p.title AS program_title,
              COALESCE(c.name, '') AS client_name,
              (SELECT MIN(s.scheduled_at) FROM care_touch_sends s
                WHERE s.enrollment_id = e.id AND s.status = 'scheduled') AS next_touch_at,
              (SELECT MAX(s.sent_at) FROM care_touch_sends s
                WHERE s.enrollment_id = e.id AND s.status = 'sent') AS last_sent_at
         FROM care_enrollments e
         JOIN care_programs p ON p.id = e.program_id
         LEFT JOIN clients c ON c.id = e.client_id
        WHERE ${cond.join(' AND ')}
        ORDER BY e.created_at DESC
        LIMIT 300`,
      params);
    res.json({ enrollments: rows });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Ошибка загрузки' }); }
});

// GET /enrollments/:id/sends — журнал
router.get('/enrollments/:id/sends', guard, async (req, res) => {
  try {
    const rows = await db.any(
      `SELECT s.id, s.status, s.scheduled_at, s.sent_at, s.decision_reason, s.error,
              s.rendered_text, s.channel_used, t.title AS touch_title, t.delay_days
         FROM care_touch_sends s
         LEFT JOIN care_touches t ON t.id = s.touch_id
         JOIN care_enrollments e ON e.id = s.enrollment_id
        WHERE s.enrollment_id = $1 AND e.salon_id = $2
        ORDER BY s.scheduled_at ASC`,
      [Number(req.params.id), req.user.salon_id]);
    res.json({ sends: rows });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Ошибка загрузки' }); }
});

// POST /enrollments/:id/stop — ручная остановка
router.post('/enrollments/:id/stop', guard, async (req, res) => {
  try {
    const r = await db.oneOrNone(
      `UPDATE care_enrollments SET status='stopped',
              status_reason='остановлено вручную', updated_at=NOW()
        WHERE id=$1 AND salon_id=$2 AND status IN ('active','escalated') RETURNING id`,
      [Number(req.params.id), req.user.salon_id]);
    if (!r) return res.status(404).json({ error: 'Прохождение не найдено или уже завершено' });
    await db.query(
      `UPDATE care_touch_sends SET status='cancelled', decision_reason='остановлено вручную'
        WHERE enrollment_id=$1 AND status='scheduled'`, [r.id]);
    res.json({ ok: true });
  } catch (e) { log.error(e.message); res.status(500).json({ error: 'Ошибка' }); }
});

module.exports = router;
```

Примечание: сверить, как ходят `req.user.salon_id` / `req.user.id` в notification-rules.js, и использовать те же поля. Словари для пикеров условий фронт берёт из существующего `GET /api/notification-rules/dictionaries`.

- [ ] **Step 2: Смонтировать в routes/index.js** (рядом со строкой 67)

```js
  app.use('/api/care', require('./care'));
```

- [ ] **Step 3: Smoke**

Run: `cd backend && node --check routes/care.js && PORT=3001 pm2 restart loyalpro --update-env && sleep 3 && curl -s http://localhost:3001/api/care/programs` → `401` без токена (роут жив). С валидным owner-токеном → `{"programs":[]}`.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/care.js backend/routes/index.js
git commit -m "feat(care): API /api/care — программы, дашборд, журнал, ручная остановка"
```

---

### Task 13: Живой смоук `scripts/care-e2e.js`

**Files:**
- Create: `backend/scripts/care-e2e.js` (образец структуры/чистки — `backend/scripts/agent-price-probe.js`)

- [ ] **Step 1: Скрипт**

Логика (реальный LLM + реальная отправка на тестовый номер `79200255591`, чистит за собой):

```js
'use strict';
// Живой смоук «Отдела заботы»: создаёт временную программу и enrollment на
// тестовый номер со scheduled_at=NOW(), гоняет ОДИН processTick (реальный LLM,
// реальная отправка в Chatpush), печатает решение и чистит за собой.
// Запуск: cd backend && node scripts/care-e2e.js [phone]

const { db } = require('../db');
const worker = require('../services/care/worker');

const PHONE = process.argv[2] || '79200255591';
const SALON_ID = Number(process.env.CARE_E2E_SALON || 1); // сверить id салона PERI на деве

(async () => {
  let programId;
  try {
    const p = await db.one(
      `INSERT INTO care_programs (salon_id, title, conditions)
       VALUES ($1, '[E2E] care-smoke', '{"logic":"and","items":[]}') RETURNING id`,
      [SALON_ID]);
    programId = p.id;
    const t = await db.one(
      `INSERT INTO care_touches (salon_id, program_id, title, delay_days, send_time, intent_text, sort_order)
       VALUES ($1,$2,'Т+1 самочувствие',1,'10:30',
               'Узнать самочувствие после вчерашней процедуры, нет ли дискомфорта.',0)
       RETURNING id`, [SALON_ID, programId]);
    const e = await db.one(
      `INSERT INTO care_enrollments (salon_id, program_id, phone, yclients_record_id,
                                     visit_at, staff_name, services)
       VALUES ($1,$2,$3, 999999901, NOW() - interval '1 day', 'Гаджиева Пери',
               '[{"id":1,"title":"Биоревитализация"}]'::jsonb)
       RETURNING id`, [SALON_ID, programId, PHONE]);
    await db.query(
      `INSERT INTO care_touch_sends (salon_id, enrollment_id, touch_id, scheduled_at)
       VALUES ($1,$2,$3, NOW())`, [SALON_ID, e.id, t.id]);

    console.log(`enrollment #${e.id} создан, гоню processTick…`);
    await worker.processTick();

    const send = await db.one(
      `SELECT status, decision_reason, rendered_text, channel_used, error
         FROM care_touch_sends WHERE enrollment_id=$1`, [e.id]);
    console.log('РЕЗУЛЬТАТ:', JSON.stringify(send, null, 2));
    const enr = await db.one(`SELECT status, status_reason FROM care_enrollments WHERE id=$1`, [e.id]);
    console.log('ENROLLMENT:', JSON.stringify(enr));
  } finally {
    if (programId) {
      await db.query(`DELETE FROM care_programs WHERE id=$1`, [programId]); // каскад чистит всё
      console.log('почищено');
    }
    process.exit(0);
  }
})();
```

- [ ] **Step 2: Запустить на деве**

Run: `cd backend && node scripts/care-e2e.js`
Expected: `РЕЗУЛЬТАТ` со `status: "sent"` и живым текстом Милы (или честный `skipped` с внятной `decision_reason` — например, гейт whitelist: тогда добавить тестовый номер в белый список агента и повторить). Проверить доставку в мессенджер и появление сообщения в чате админки.

- [ ] **Step 3: Commit**

```bash
git add backend/scripts/care-e2e.js
git commit -m "test(care): живой e2e-смоук касания (реальный LLM + отправка, чистит за собой)"
```

---

### Task 14: Фронт — страница «Забота»

**Files:**
- Create: `frontend/js/pages/care.js`
- Modify: `frontend/js/core/nav.js:30` (диспетчер страниц), `frontend/index.html` (пункт меню, контейнер страницы, `<script src="js/pages/care.js?v=2026-08-02a">`), `frontend/css/features.css` (бейджи статусов)

Образец структуры — `frontend/js/pages/broadcast-rules.js` (список правил + модалка с конструктором условий): скопировать оттуда паттерны модалки, пикеров условий (словарь из `/api/notification-rules/dictionaries`) и рендера списка.

- [ ] **Step 1: nav.js + index.html**

В nav.js добавить `if (p === 'care') loadCarePage();`. В index.html: пункт бокового меню «Забота» (`data-page="care"`, видимость owner/admin — как у «Рассылок»), контейнер `<div id="page-care" class="page">` с двумя вкладками (`Программы` / `Клиенты`) по разметке вкладок страницы «Рассылки», и script-тег с версией.

- [ ] **Step 2: care.js — вкладка «Программы»**

Функции (глобальные, как в других страницах):
- `loadCarePage()` — грузит обе вкладки; переключатель вкладок как на «Рассылках».
- `careLoadPrograms()` — `GET /api/care/programs` через `core/api.js`; рендер карточек: название, тумблер (`POST /programs/:id/toggle`), условия текстом (по словарю), цепочка бейджей `Т+{delayDays}`, счётчики active/sent, кнопки «Изменить»/«Удалить» (confirm: «Удалит и историю прохождений»).
- `careOpenProgramModal(program?)` — модалка: название; конструктор условий (скопировать из broadcast-rules.js вместе с загрузкой словаря); список касаний — строки `[название] [через N дней] [в HH:MM] [заготовка textarea]` с кнопками добавить/удалить/вверх-вниз; сохранение `POST/PUT /api/care/programs[/:id]` (тело: `{title, conditions, touches:[{id?, title, delayDays, sendTime, intentText}]}`).

- [ ] **Step 3: care.js — вкладка «Клиенты» (дашборд)**

- `careLoadEnrollments()` — `GET /api/care/enrollments?status=` с фильтром-селектом по статусу; таблица: клиент (имя+телефон), программа, визит (дата + услуги из `services`), врач, статус-бейдж (цвета: active — синий, completed — зелёный, escalated — красный, declined/stopped — серый, superseded — приглушённый), следующее касание, последняя отправка.
- Клик по строке — раскрытие с журналом `GET /api/care/enrollments/:id/sends` (касание, статус, `decision_reason`, текст) + кнопка «Остановить» (`POST /enrollments/:id/stop`) + ссылка «Открыть чат» → `location.hash = '#chat/' + phone`.
- CSS-бейджи в features.css по образцу существующих статусных бейджей.

- [ ] **Step 4: Живая проверка через MCP Playwright**

Открыть дев (`http://localhost:3001`), залогиниться owner'ом, страница «Забота»: создать программу с условием по услуге и двумя касаниями (Т+1, Т+120), убедиться в списке; вкладка «Клиенты» — пустой дашборд без ошибок в консоли. Обе темы (light/dark) — глазами через скриншоты.

- [ ] **Step 5: Commit**

```bash
git add frontend/js/pages/care.js frontend/js/core/nav.js frontend/index.html frontend/css/features.css
git commit -m "feat(care): страница «Забота» — программы + дашборд клиентов"
```

---

### Task 15: Полный прогон, CLAUDE.md, финал

**Files:**
- Modify: `CLAUDE.md` (раздел про AI-агента — краткий блок про «Отдел заботы»)

- [ ] **Step 1: Все тесты**

Run: `cd backend && npx jest` → PASS без регрессов (агентские, notifications, care-*).

- [ ] **Step 2: CLAUDE.md — краткая документация модуля**

В стиле существующих секций: таблицы, триггер (attendance=1 ИЛИ paid_full=1), порядок проверок воркера, fail-safe skip, гейт Милы общий, персист касаний, хук эскалации, страница «Забота».

- [ ] **Step 3: Живой смоук целиком на деве**

Создать программу в UI на тестовую услугу → создать и «провести» запись в YClients на тестовый номер (attendance=1) → убедиться: enrollment появился на дашборде, касание в очереди; ускорить `scheduled_at` (UPDATE … SET scheduled_at=NOW() через MCP postgres) → дождаться тика воркера → сообщение доставлено, видно в чате админки, журнал заполнен. Ответить с тестового номера «всё хорошо» → Мила отвечает в контексте касания.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(care): раздел «Отдел заботы» в CLAUDE.md"
```

---

## Self-Review (выполнен при написании)

- Спека покрыта: таблицы (T1), зачисление+superseded (T6-7), детерминированные проверки и care-проход (T9), персист+запуск (T10), эскалация (T11), API (T12), e2e (T13), UI обе вкладки (T14). Retention — те же касания с большой задержкой + проверка повторного визита (T8/T9).
- Типы согласованы: `parseCareDecision` (T3) ↔ использование в worker (T9); `computeScheduledAt/parseVisitAt/plusOneDay` (T2) ↔ enroll (T6) и worker (T9); `program_conditions` алиас в lease-SQL ↔ `row.program_conditions` в processOne; touches API-формат `{id, title, delayDays, sendTime, intentText}` ↔ фронт (T14).
- Известные точки сверки по месту (помечены в тексте задач): сигнатура `ycGetClientRecords`, формат `datetime` YClients, фактическая сигнатура `persistWhatsappOutgoing`, `req.user.salon_id` в роутере, id салона в e2e-скрипте.
