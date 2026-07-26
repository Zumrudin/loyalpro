# get_sequential_slots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Детерминированный инструмент агента `get_sequential_slots`: код (не LLM) подбирает время для нескольких услуг подряд одному клиенту с приоритетом текущего мастера и авто-сканом до 7 дней.

**Architecture:** Чистая цепочечная подгонка в новом модуле `services/agent/sequential.js` (без сети/БД, jest); обёртка-инструмент `services/agent/tools/get-sequential-slots.js` собирает кандидатов-мастеров из каталога `list_services`, окна из `ycGetStaffSeances` минус занятость аппаратов, и возвращает ранжированные варианты (`same_staff` → `other_staff` → `mixed`, `with_gap` — флагом). Промпт-блок «несколько услуг подряд» переписывается на вызов инструмента.

**Tech Stack:** Node.js/Express, jest 30 (уже в devDependencies), существующие хелперы `equipment.js`/`equipment-context.js`/`service-filter.js`, YClients management API.

**Спека:** `docs/superpowers/specs/2026-07-26-get-sequential-slots-design.md`

**Контекст для исполнителя без истории:**
- Все пути ниже — от корня репо `/root/loyalpro`. Рабочий код бэкенда — в `backend/`.
- Дев-сервер — PM2-процесс `loyalpro` из `/root/loyalpro/backend` (порт 3001), БД `loyalpro_test`.
- jest запускается как `npx jest <паттерн>` из `backend/` (script `npm test` захардкожен на clients-api — не использовать).
- В интервальной арифметике всё в минутах от полуночи по Москве, конец эксклюзивный `[start, end)` — как в `services/agent/equipment.js`.
- Реальные id для смок-проверок на dev-БД (salon_id=1): мастера — Астемир Боташев `5708379`, Гатауллина Юлия `1914276`, Богатырева Татьяна `3356928`; услуги — биоревитализация `9536674` (30 мин), чистка лица `9536777` (90 мин).

---

### Task 1: Закоммитить висящие правки промпта (утренний фикс)

В рабочем дереве уже есть незакоммиченные изменения `backend/services/agent/system-prompt.js` (+10 строк) и `backend/agent-system-prompt.test.js` (+49 строк) — это фикс от 26.07 «Мила стыкует сама, эскалация — крайняя мера». Их нельзя смешивать с нашей фичей.

**Files:**
- Commit as-is: `backend/services/agent/system-prompt.js`, `backend/agent-system-prompt.test.js`
- НЕ коммитить: `.claude/settings.local.json`, `backend/.env.bak-*`

- [ ] **Step 1: Посмотреть diff и убедиться, что это правки про стыковку/эскалацию**

Run: `cd /root/loyalpro && git diff backend/services/agent/system-prompt.js backend/agent-system-prompt.test.js`
Expected: изменения в блоке «ЗАПИСЬ НА НЕСКОЛЬКО УСЛУГ ПОДРЯД…» (строки ~175–179) и в Сценарии 4 (~223), плюс новые тесты на эти формулировки. Если diff про другое — остановиться и спросить пользователя.

- [ ] **Step 2: Прогнать тесты промпта**

Run: `cd /root/loyalpro/backend && npx jest agent-system-prompt`
Expected: PASS (все тесты).

- [ ] **Step 3: Закоммитить**

```bash
cd /root/loyalpro
git add backend/services/agent/system-prompt.js backend/agent-system-prompt.test.js
git commit -m "fix(agent): промпт стыковки услуг — Мила стыкует сама, эскалация крайняя мера"
```

---

### Task 2: Чистый модуль `sequential.js` (TDD)

Цепочечная подгонка: старт первой услуги на сетке 30 мин, каждая следующая — с ближайшего подходящего времени (выравнивание 5 мин), зазор между услугами ≤ 15 мин для «встык», без ограничения — для варианта «с перерывом».

**Files:**
- Create: `backend/services/agent/sequential.js`
- Test: `backend/services/agent/sequential.test.js`

- [ ] **Step 1: Написать падающие тесты**

Создать `backend/services/agent/sequential.test.js`:

```js
'use strict';

const seq = require('./sequential');

// Интервалы в минутах от полуночи, [start, end). 600=10:00, 630=10:30, 720=12:00.
const R = (start, end) => ({ start, end });

describe('fitChain', () => {
  test('две услуги встык в одном окне', () => {
    // Окно 10:00–13:00 у обоих мастеров; био 30 мин + чистка 90 мин.
    const entries = [
      { ranges: [R(600, 780)], durationMin: 30 },
      { ranges: [R(600, 780)], durationMin: 90 },
    ];
    const fit = seq.fitChain(entries, 600);
    expect(fit).toEqual({ starts: [600, 630], totalGap: 0 });
  });

  test('первая услуга не влезает в t — null', () => {
    const entries = [
      { ranges: [R(600, 620)], durationMin: 30 },   // окно 20 мин < 30
      { ranges: [R(600, 780)], durationMin: 90 },
    ];
    expect(seq.fitChain(entries, 600)).toBeNull();
  });

  test('зазор ≤15 мин допустим и попадает в totalGap', () => {
    // Чистка может начаться не раньше 10:40 (окно второй услуги с 640) → зазор 10 мин.
    const entries = [
      { ranges: [R(600, 630)], durationMin: 30 },
      { ranges: [R(640, 780)], durationMin: 90 },
    ];
    const fit = seq.fitChain(entries, 600);
    expect(fit).toEqual({ starts: [600, 640], totalGap: 10 });
  });

  test('зазор >15 мин по умолчанию отвергается', () => {
    const entries = [
      { ranges: [R(600, 630)], durationMin: 30 },
      { ranges: [R(650, 780)], durationMin: 90 },   // зазор 20 мин
    ];
    expect(seq.fitChain(entries, 600)).toBeNull();
  });

  test('maxLinkGap=Infinity пропускает большой перерыв', () => {
    const entries = [
      { ranges: [R(600, 630)], durationMin: 30 },
      { ranges: [R(1230, 1320)], durationMin: 90 },  // 20:30–22:00
    ];
    const fit = seq.fitChain(entries, 600, { maxLinkGap: Infinity });
    expect(fit).toEqual({ starts: [600, 1230], totalGap: 600 });
  });

  test('старт следующей услуги выравнивается к 5-мин сетке', () => {
    // Первая заканчивается в 10:33 → следующая не в 10:33, а в 10:35.
    const entries = [
      { ranges: [R(600, 633)], durationMin: 33 },
      { ranges: [R(600, 780)], durationMin: 60 },
    ];
    const fit = seq.fitChain(entries, 600);
    expect(fit).toEqual({ starts: [600, 635], totalGap: 2 });
  });

  test('три услуги цепочкой', () => {
    const entries = [
      { ranges: [R(600, 780)], durationMin: 30 },
      { ranges: [R(600, 780)], durationMin: 30 },
      { ranges: [R(600, 780)], durationMin: 60 },
    ];
    const fit = seq.fitChain(entries, 600);
    expect(fit).toEqual({ starts: [600, 630, 660], totalGap: 0 });
  });
});

describe('chainStarts', () => {
  test('перебирает сетку 30 мин и требует полного размещения', () => {
    // Окно 10:00–12:30. Цепочка 30+90=120 мин → старты только 10:00 и 10:30.
    const entries = [
      { ranges: [R(600, 750)], durationMin: 30 },
      { ranges: [R(600, 750)], durationMin: 90 },
    ];
    const starts = seq.chainStarts(entries).map(c => c.start);
    expect(starts).toEqual([600, 630]);
  });

  test('окна разных мастеров учитываются раздельно', () => {
    // У первого мастера окно 10:00–10:30, у второго 10:30–12:00 → единственный старт 10:00.
    const entries = [
      { ranges: [R(600, 630)], durationMin: 30 },
      { ranges: [R(630, 720)], durationMin: 90 },
    ];
    const chains = seq.chainStarts(entries);
    expect(chains).toHaveLength(1);
    expect(chains[0]).toEqual({ start: 600, starts: [600, 630], totalGap: 0 });
  });

  test('пустые окна → пусто', () => {
    const entries = [
      { ranges: [], durationMin: 30 },
      { ranges: [R(600, 780)], durationMin: 90 },
    ];
    expect(seq.chainStarts(entries)).toEqual([]);
  });
});

describe('bestGapChain', () => {
  test('выбирает минимальный суммарный перерыв', () => {
    // Старт 10:00 → чистка ждёт до 20:30 (перерыв 600 мин).
    // Старт 19:30 (окно 19:30–20:00) → чистка в 20:30 (перерыв 30 мин) — лучше.
    const entries = [
      { ranges: [R(600, 630), R(1170, 1200)], durationMin: 30 },
      { ranges: [R(1230, 1320)], durationMin: 90 },
    ];
    const best = seq.bestGapChain(entries);
    expect(best).toEqual({ start: 1170, starts: [1170, 1230], totalGap: 30 });
  });

  test('ничего не собирается → null', () => {
    const entries = [
      { ranges: [R(600, 630)], durationMin: 30 },
      { ranges: [], durationMin: 90 },
    ];
    expect(seq.bestGapChain(entries)).toBeNull();
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd /root/loyalpro/backend && npx jest sequential`
Expected: FAIL — `Cannot find module './sequential'`.

- [ ] **Step 3: Реализовать модуль**

Создать `backend/services/agent/sequential.js`:

```js
'use strict';

// ============================================================
// Чистая логика ПОСЛЕДОВАТЕЛЬНОЙ стыковки услуг одного клиента
// («встык», одна за другой). Без БД/HTTP — юнит-тестируемо
// (sequential.test.js). Параллельная запись двоих — equipment.js.
//
// Все интервалы — минуты от полуночи по Москве, конец эксклюзивный
// [start, end). entries — по одной записи на услугу В ПОРЯДКЕ
// выполнения: { ranges, durationMin }, где ranges — свободные окна
// мастера этой услуги, уже за вычетом занятости аппаратов.
// ============================================================

const eq = require('./equipment');

const GRID_STEP = 30;     // сетка стартов первой услуги (чистые :00/:30)
const LINK_ALIGN = 5;     // выравнивание стартов внутри цепочки
const MAX_LINK_GAP = 15;  // максимальный зазор между услугами для «встык»

// Ближайший старт ≥ from (выравнивание к 5-мин сетке), где услуга
// длительностью dur влезает целиком в одно из окон. null — не влезает.
function earliestFitAtOrAfter(ranges, from, dur) {
  for (const r of eq.mergeRanges(ranges)) {
    let s = Math.max(r.start, from);
    s = Math.ceil(s / LINK_ALIGN) * LINK_ALIGN;
    if (s + dur <= r.end) return s;
  }
  return null;
}

// Подогнать цепочку от старта t первой услуги. Каждая следующая —
// с ближайшего подходящего времени; зазор звена ≤ maxLinkGap.
// Возврат { starts:[минуты по услугам], totalGap } или null.
function fitChain(entries, t, opts = {}) {
  const maxLinkGap = opts.maxLinkGap === undefined ? MAX_LINK_GAP : opts.maxLinkGap;
  if (!entries.length || !eq.fitsIn(entries[0].ranges, t, entries[0].durationMin)) return null;
  const starts = [t];
  let cursor = t + entries[0].durationMin;
  let totalGap = 0;
  for (let i = 1; i < entries.length; i++) {
    const s = earliestFitAtOrAfter(entries[i].ranges, cursor, entries[i].durationMin);
    if (s === null || s - cursor > maxLinkGap) return null;
    starts.push(s);
    totalGap += s - cursor;
    cursor = s + entries[i].durationMin;
  }
  return { starts, totalGap };
}

// Все старты первой услуги на чистой сетке GRID_STEP, где цепочка
// собирается. Возврат [{ start, starts, totalGap }] по возрастанию.
function chainStarts(entries, opts = {}) {
  if (!entries || !entries.length) return [];
  const step = opts.step || GRID_STEP;
  const out = [];
  const seen = new Set();
  for (const r of eq.mergeRanges(entries[0].ranges)) {
    for (let t = Math.ceil(r.start / step) * step; t + entries[0].durationMin <= r.end; t += step) {
      if (seen.has(t)) continue;
      seen.add(t);
      const fit = fitChain(entries, t, opts);
      if (fit) out.push({ start: t, starts: fit.starts, totalGap: fit.totalGap });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// Лучший вариант «с перерывом»: минимальный суммарный зазор,
// при равенстве — более ранний старт. null — не собирается вовсе.
function bestGapChain(entries, opts = {}) {
  let best = null;
  for (const c of chainStarts(entries, { ...opts, maxLinkGap: Infinity })) {
    if (!best || c.totalGap < best.totalGap) best = c;
  }
  return best;
}

module.exports = {
  GRID_STEP, LINK_ALIGN, MAX_LINK_GAP,
  earliestFitAtOrAfter, fitChain, chainStarts, bestGapChain,
};
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `cd /root/loyalpro/backend && npx jest sequential`
Expected: PASS, 12 тестов.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro
git add backend/services/agent/sequential.js backend/services/agent/sequential.test.js
git commit -m "feat(agent): sequential.js — чистая цепочечная подгонка услуг подряд"
```

---

### Task 3: Инструмент `get-sequential-slots.js` + регистрация

Обёртка над `sequential.js`: кандидаты-мастера из каталога, скан дней, ранжирование, лимиты выдачи, машинные причины пустоты. Побочных эффектов нет (только чтение) — юнит-тесты не нужны, проверяем смоком на dev-БД в Task 4.

**Files:**
- Create: `backend/services/agent/tools/get-sequential-slots.js`
- Modify: `backend/services/agent/tools/index.js`

- [ ] **Step 1: Создать инструмент**

Создать `backend/services/agent/tools/get-sequential-slots.js`:

```js
'use strict';

const { db } = require('../../../db');
const { ycGetStaffSeances } = require('../../yclients-booking');
const settings = require('../../agent-settings');
const svcFilter = require('../service-filter');
const listServices = require('./list-services');
const { seancesToRanges } = require('./get-available-slots');
const eq = require('../equipment');
const eqContext = require('../equipment-context');
const seq = require('../sequential');

// ── Несколько услуг ПОДРЯД одному клиенту («встык»). ────────────────────────
// Отдельный инструмент, а не «сравни слоты двух услуг сама»: стыковка окон —
// интервальная арифметика, на которой модель ошибается (см. get_parallel_slots
// для записи двоих ПАРАЛЛЕЛЬНО). Здесь код сам подбирает исполнителей по
// каталогу, сканирует до HORIZON_DAYS дней и отдаёт готовые варианты по
// приоритетной лестнице: всё у текущего мастера → всё у другого одного
// мастера → разные мастера по очереди. Разбор 26.07: без этого слабые модели
// выдумывали слоты и ходили кругами.

const HORIZON_DAYS = 7;        // дней вперёд после запрошенной даты
const MAX_DATES = 3;           // дат с вариантами в выдаче
const MAX_STARTS = 4;          // стартов на вариант
const MAX_OTHER_STAFF = 3;     // «универсалов» помимо текущего мастера
const MAX_MIXED_COMBOS = 6;    // потолок комбинаций мастеров в mixed
const DEFAULT_DURATION_MIN = 60;

const schema = {
  name: 'get_sequential_slots',
  description: 'Подобрать время для НЕСКОЛЬКИХ услуг ПОДРЯД одному пациенту за один визит ' +
    '(«встык», одна за другой; НЕ для двоих гостей одновременно — это get_parallel_slots). ' +
    'Сам находит исполнителей по каталогу, проверяет текущего мастера, других мастеров и ' +
    'ближайшие дни (до 7) и возвращает готовые варианты по приоритету: всё у текущего мастера → ' +
    'всё у другого одного мастера → разные мастера по очереди; вариант с перерывом помечен ' +
    'with_gap/gap_minutes. Вызывай ВМЕСТО ручного сравнения слотов разных услуг. ' +
    'Нужны yc_id услуг из list_services в желаемом порядке выполнения. Дата YYYY-MM-DD.',
  input_schema: {
    type: 'object',
    properties: {
      services: {
        type: 'array', minItems: 2,
        description: 'Услуги в желаемом порядке выполнения (минимум 2).',
        items: {
          type: 'object',
          properties: { service_yc_id: { type: 'integer', description: 'YClients-id услуги.' } },
          required: ['service_yc_id'],
          additionalProperties: false,
        },
      },
      date: { type: 'string', description: 'С какого дня искать, YYYY-MM-DD.' },
      preferred_staff_yc_id: {
        type: 'integer',
        description: 'Мастер, у которого пациент уже записан или которого предпочитает — приоритет сохранить всё у него.',
      },
    },
    required: ['services', 'date'],
    additionalProperties: false,
  },
};

const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Текущий момент по Москве (как в get_available_slots/get_parallel_slots).
function moscowNow(ms) {
  const d = new Date(ms);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d);
  const hm = new Intl.DateTimeFormat('en-GB',
    { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const [h, m] = hm.split(':').map(Number);
  return { date, minutes: h * 60 + m };
}

async function run(salonId, input, ctx = {}) {
  const date = input && input.date;
  const items = (input && Array.isArray(input.services)) ? input.services : [];
  const preferredId = input && input.preferred_staff_yc_id ? String(input.preferred_staff_yc_id) : null;
  const nowMs = (ctx && ctx.nowMs) || Date.now();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || items.length < 2) {
    return { error: 'Нужны date (YYYY-MM-DD) и минимум две услуги в services.' };
  }

  const salon = await db.oneOrNone(
    `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
       FROM salons WHERE id=$1`, [salonId]);
  if (!salon || !salon.yclients_company_id) return { error: 'YClients не подключён для салона.' };

  // Исполнители — только из каталога (per-staff привязка, общий /services урезан).
  // Без каталога стыковать не из чего — честная ошибка, модель уйдёт в get_available_slots.
  let catalog = null;
  try { catalog = await listServices.run(salonId); } catch (_) { catalog = null; }
  if (!catalog || !Array.isArray(catalog.services) || !catalog.services.length) {
    return { error: 'Каталог услуг недоступен — подбери время по каждой услуге через get_available_slots.' };
  }

  const filter = await settings.loadServiceFilterSafe(salonId);

  // Услуги цепочки в порядке выполнения + допустимые исполнители каждой.
  const chainSvcs = [];
  const performersByService = {};
  for (const it of items) {
    const svcId = it && it.service_yc_id;
    const svc = catalog.services.find(s => String(s.yc_id) === String(svcId));
    if (!svc) return { error: `Услуга ${svcId} не найдена в каталоге — возьми верный yc_id из list_services.` };
    const performers = (svc.staff || [])
      .filter(m => m && m.yc_id && svcFilter.isBookable(filter, svcId, m.yc_id));
    if (!performers.length) return { variants: [], filtered: true };
    chainSvcs.push({ yc_id: svcId, title: svc.title, performers });
    performersByService[String(svcId)] = performers.map(m => m.name).filter(Boolean);
  }

  // «Универсалы» — делают ВСЕ услуги цепочки (порядок — как в каталоге).
  const universal = chainSvcs[0].performers.filter(m =>
    chainSvcs.every(s => s.performers.some(p => String(p.yc_id) === String(m.yc_id))));
  const preferredUniversal =
    (preferredId && universal.find(m => String(m.yc_id) === preferredId)) || null;
  const preferredCannot = preferredId
    ? chainSvcs.filter(s => !s.performers.some(p => String(p.yc_id) === preferredId)).map(s => s.title)
    : [];

  // Кандидаты-назначения по приоритетной лестнице: staff[i] ведёт услугу i.
  const assignments = [];
  if (preferredUniversal) {
    assignments.push({ type: 'same_staff', staff: chainSvcs.map(() => preferredUniversal) });
  }
  for (const m of universal.filter(m => String(m.yc_id) !== preferredId).slice(0, MAX_OTHER_STAFF)) {
    assignments.push({ type: 'other_staff', staff: chainSvcs.map(() => m) });
  }
  // Микс: на услугу — preferred, если делает, иначе до 2 исполнителей; комбо капаем.
  const perSvcChoices = chainSvcs.map(s => {
    const pref = s.performers.find(p => String(p.yc_id) === preferredId);
    return pref ? [pref] : s.performers.slice(0, 2);
  });
  let combos = [[]];
  for (const choices of perSvcChoices) {
    const next = [];
    for (const c of combos) for (const ch of choices) next.push([...c, ch]);
    combos = next.slice(0, MAX_MIXED_COMBOS);
  }
  for (const combo of combos) {
    if (new Set(combo.map(m => String(m.yc_id))).size === 1) continue;  // одиночный мастер уже покрыт выше
    assignments.push({ type: 'mixed', staff: combo });
  }

  const now = moscowNow(nowMs);
  const seancesCache = new Map();   // `${staffYcId}|${day}` → ranges кресла
  const getStaffRanges = async (staffYcId, day) => {
    const k = `${staffYcId}|${day}`;
    if (!seancesCache.has(k)) {
      let s = [];
      try { s = await ycGetStaffSeances(salon, staffYcId, day); } catch (_) { s = []; }
      seancesCache.set(k, seancesToRanges(s));
    }
    return seancesCache.get(k);
  };

  // entries для sequential.js: окна мастера услуги минус занятость её аппаратов.
  const entriesFor = async (assignment, day, eqCtx) => {
    const entries = [];
    for (let i = 0; i < chainSvcs.length; i++) {
      const svc = chainSvcs[i];
      const staff = assignment.staff[i];
      let ranges = await getStaffRanges(staff.yc_id, day);
      const busy = eqContext.busyForService(eqCtx, svc.yc_id);
      if (busy.length) ranges = eq.subtractRanges(ranges, busy);
      entries.push({
        ranges,
        durationMin: eqContext.durationMin(eqCtx, svc.yc_id) || DEFAULT_DURATION_MIN,
        staff, svc,
      });
    }
    return entries;
  };

  const buildVariant = (assignment, day, entries, chains) => {
    const staff = [];
    for (const m of assignment.staff) {
      if (!staff.some(u => String(u.yc_id) === String(m.yc_id))) {
        staff.push({ yc_id: m.yc_id, name: m.name });
      }
    }
    return {
      type: assignment.type, date: day, staff,
      starts: chains.map(c => ({
        time: eq.toHHMM(c.start),
        gap_minutes: c.totalGap,
        chain: c.starts.map((s, i) => ({
          service_yc_id: entries[i].svc.yc_id,
          service_title: entries[i].svc.title,
          staff_yc_id: entries[i].staff.yc_id,
          datetime: `${day}T${eq.toHHMM(s)}:00+03:00`,
          seance_length: entries[i].durationMin * 60,
        })),
      })),
    };
  };

  const variants = [];
  const datesWithHits = new Set();
  let foundSameStaff = false;
  for (let d = 0; d <= HORIZON_DAYS; d++) {
    const day = addDays(date, d);
    const eqCtx = await eqContext.loadEquipmentContext(salon, day);

    for (const a of assignments) {
      const entries = await entriesFor(a, day, eqCtx);
      let chains = seq.chainStarts(entries);
      if (day === now.date) chains = chains.filter(c => c.start > now.minutes);
      if (!chains.length) continue;
      variants.push(buildVariant(a, day, entries, chains.slice(0, MAX_STARTS)));
      datesWithHits.add(day);
      if (a.type === 'same_staff') foundSameStaff = true;
    }

    // «С перерывом» — только для запрошенного дня и только там, где встык не вышло.
    if (d === 0) {
      for (const a of assignments) {
        if (variants.some(v => v.date === day && v.type === a.type)) continue;
        const entries = await entriesFor(a, day, eqCtx);
        let best = seq.bestGapChain(entries);
        if (best && day === now.date && best.start <= now.minutes) best = null;
        if (!best || best.totalGap <= seq.MAX_LINK_GAP) continue;  // ≤15 мин нашёл бы chainStarts
        const v = buildVariant(a, day, entries, [best]);
        v.with_gap = true;
        variants.push(v);
        datesWithHits.add(day);
        break;  // одного честного варианта «с перерывом» достаточно
      }
    }

    // Ранний стоп: всё у текущего мастера найдено, либо дат уже достаточно.
    if (foundSameStaff || datesWithHits.size >= MAX_DATES) break;
  }

  // same_staff → other_staff → mixed; встык раньше with_gap; внутри — по дате.
  const rank = { same_staff: 0, other_staff: 1, mixed: 2 };
  variants.sort((x, y) =>
    (rank[x.type] - rank[y.type])
    || ((x.with_gap ? 1 : 0) - (y.with_gap ? 1 : 0))
    || x.date.localeCompare(y.date));

  const out = { requested_date: date, variants, performers_by_service: performersByService };
  if (preferredCannot.length) out.preferred_staff_cannot = preferredCannot;
  if (!variants.length) {
    out.reason = 'no_combo_in_horizon';
    out.hint = `За ${HORIZON_DAYS + 1} дней с ${date} собрать эти услуги в один визит не получилось. ` +
      'ЧЕСТНО скажи это пациенту и предложи: процедуры отдельными визитами (get_available_slots по каждой) ' +
      'или другой удобный период. Эскалация — крайняя мера.';
  } else {
    out.hint = 'Предлагай варианты в порядке списка (приоритет — сохранить всё у текущего мастера) и ' +
      'называй мастера каждой процедуры. Время предлагай ТОЛЬКО из starts. Вариант with_gap подавай честно, ' +
      'сразу называя перерыв gap_minutes. Если preferred_staff_cannot непуст — скажи, что текущий мастер ' +
      'эти процедуры не выполняет, и назови исполнителей из performers_by_service.';
  }
  return out;
}

module.exports = { schema, run };
```

- [ ] **Step 2: Зарегистрировать в реестре**

В `backend/services/agent/tools/index.js` добавить require после `getParSlot` и элемент в массив `tools` между `getParSlot` и `getDates`:

```js
const getSeqSlot = require('./get-sequential-slots');
```

```js
const tools = [searchKb, listSvc, listStaff, getSlots, getParSlot, getSeqSlot, getDates, getClient,
  createBk, listBookings, visitHistory, cancelBk, reschedBk, modifySvc,
  bonusBal, abonement, escalate];
```

- [ ] **Step 3: Проверить, что реестр собирается**

Run: `cd /root/loyalpro/backend && node -e "const t=require('./services/agent/tools'); console.log(t.schemas.map(s=>s.name).join('\n')); if(!t.handlers.get_sequential_slots) throw new Error('нет get_sequential_slots')"`
Expected: список имён инструментов содержит `get_sequential_slots`, без ошибок.

- [ ] **Step 4: Commit**

```bash
cd /root/loyalpro
git add backend/services/agent/tools/get-sequential-slots.js backend/services/agent/tools/index.js
git commit -m "feat(agent): инструмент get_sequential_slots — стыковка услуг подряд с приоритетом текущего мастера"
```

---

### Task 4: Смок на реальных данных dev-БД

Проверяем инструмент на сценарии из разбора 26.07: био (9536674) + чистка (9536777), запись у Астемира (5708379), искать с 2026-07-27. Известная реальность: у Юлии чистка оба дня только в 20:30, встык у неё невозможен; Татьяна 01.08 не работает.

**Files:** нет изменений (только запуск).

- [ ] **Step 1: Прогнать инструмент**

Run:
```bash
cd /root/loyalpro/backend && node -e "
require('./services/agent/tools/get-sequential-slots')
  .run(1, { services: [{service_yc_id: 9536674}, {service_yc_id: 9536777}], date: '2026-07-27', preferred_staff_yc_id: 5708379 })
  .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
  .catch(e => { console.error('FAIL', e); process.exit(1); });
"
```

- [ ] **Step 2: Проверить выдачу по чек-листу**

Expected (структурно, конкретные даты зависят от живого расписания):
- `preferred_staff_cannot: ["<название чистки>"]` — Астемир чистку не делает;
- `performers_by_service` содержит Юлию/Татьяну для чистки;
- в `variants` НЕТ типа `same_staff` (преферред не универсал);
- варианты отсортированы `other_staff` → `mixed`, встык раньше `with_gap`, внутри по дате;
- у каждого элемента `chain`: `datetime` следующей услуги = `datetime` предыдущей + её `seance_length` (+ зазор ≤ 15 мин, кроме `with_gap`);
- НЕТ выдуманных стартов: для Юлии 27.07 старт чистки только 20:30 (сверить с `get_available_slots` при сомнении);
- если вариантов нет вовсе — `reason: no_combo_in_horizon` и `hint` (это тоже валидный исход, главное — не пустой объект без причины).

Если структура нарушена (гэп в chain не сходится, сортировка неверная, фантомные слоты) — вернуться в Task 3, починить, повторить смок.

- [ ] **Step 3: Смок краевого случая — услуга не из каталога**

Run: `cd /root/loyalpro/backend && node -e "require('./services/agent/tools/get-sequential-slots').run(1,{services:[{service_yc_id:1},{service_yc_id:2}],date:'2026-07-27'}).then(r=>{console.log(JSON.stringify(r));process.exit(0)})"`
Expected: `{"error":"Услуга 1 не найдена в каталоге — возьми верный yc_id из list_services."}`

---

### Task 5: Промпт — блок «несколько услуг подряд» через инструмент (TDD)

**Files:**
- Modify: `backend/services/agent/system-prompt.js` (блок строк ~175–179 и упоминание в ~223)
- Test: `backend/agent-system-prompt.test.js`

- [ ] **Step 1: Добавить падающие тесты**

В конец `describe('buildSystemPrompt', …)` в `backend/agent-system-prompt.test.js` добавить:

```js
  test('несколько услуг подряд — через get_sequential_slots, без ручной арифметики окон', () => {
    const p = buildSystemPrompt({});
    expect(p).toContain('get_sequential_slots');
    expect(p).toMatch(/окон[^]{0,80}НЕ сравнивай вручную|НЕ сравнивай слоты разных услуг вручную/i);
    expect(p).toContain('preferred_staff_cannot');
    expect(p).toContain('gap_minutes');
    expect(p).toMatch(/ТОЛЬКО из (поля )?starts/);
    expect(p).toMatch(/не обещай[^]{0,60}(встык|одним визитом)/i);
  });
```

- [ ] **Step 2: Убедиться, что новый тест падает (и запомнить, какие старые формулировки проверяются)**

Run: `cd /root/loyalpro/backend && npx jest agent-system-prompt`
Expected: FAIL только новый тест (`get_sequential_slots` в промпте ещё нет). Записать имена существующих тестов про стыковку из Task 1 — их формулировки предстоит сохранить или синхронно обновить.

- [ ] **Step 3: Переписать блок промпта**

В `backend/services/agent/system-prompt.js` найти строки блока (сейчас ~175–179, после утреннего коммита могли сместиться):

```
`ЗАПИСЬ НА НЕСКОЛЬКО УСЛУГ ПОДРЯД ОДНОМУ пациенту (не путать с параллельной записью двоих). Это ШТАТНАЯ ситуация, ты справляешься с ней САМА: на каждую услугу оформляй ОТДЕЛЬНУЮ запись через create_booking …`,
`- Проверь через get_available_slots ВСЕХ мастеров …`,
`- Если в нужный день окон «встык» нет — посмотри соседние дни …`,
`- Если одна из процедур уже записана — предложи ПЕРЕНОС …`,
`- Эскалация — КРАЙНЯЯ мера. …`,
```

и заменить целиком на:

```js
    `ЗАПИСЬ НА НЕСКОЛЬКО УСЛУГ ПОДРЯД ОДНОМУ пациенту (не путать с параллельной записью двоих). Это ШТАТНАЯ ситуация, ты справляешься с ней САМА. Арифметику окон в голове НЕ считай и слоты разных услуг НЕ сравнивай вручную — вызови get_sequential_slots: услуги в желаемом порядке (yc_id из list_services), дата и, если у пациента уже есть запись или любимый мастер, preferred_staff_yc_id. Инструмент сам проверит текущего мастера, других мастеров и ближайшие дни (до 7) и вернёт готовые варианты.`,
    `- Предлагай варианты В ПОРЯДКЕ выдачи инструмента: сначала всё у текущего мастера, затем всё у другого одного мастера, затем разные мастера друг за другом. ВСЕГДА называй, кто выполняет каждую процедуру.`,
    `- Вернулся preferred_staff_cannot — мягко скажи, что текущий мастер эти процедуры не выполняет, и назови исполнителей из performers_by_service.`,
    `- Вариант с пометкой with_gap предлагай честно: сразу называй перерыв между процедурами (gap_minutes).`,
    `- Конкретное время называй ТОЛЬКО из starts последнего ответа get_sequential_slots. НИКОГДА заранее не обещай «сделаем встык/одним визитом», пока инструмент не вернул такой вариант.`,
    `- Пациент выбрал вариант → оформляй строго по его chain: у одного мастера — ОДНА запись со всеми услугами (create_booking по первой услуге, затем modify_booking_services с полным списком services из chain); у разных мастеров — отдельная запись на каждый элемент chain (datetime и seance_length бери из chain). Если одна из процедур уже записана — перенос через reschedule_booking (Сценарий 3) на время из выбранного варианта.`,
    `- Пустой ответ (reason=no_combo_in_horizon) — ЧЕСТНО скажи, что одним визитом собрать не получилось, и предложи процедуры отдельными визитами или другой период. Эскалация — КРАЙНЯЯ мера: только когда варианты инструмента исчерпаны или не подошли пациенту.`,
```

В блоке Сценария 4 (~223) заменить фрагмент «сначала отработай варианты из Сценария 2 (все мастера, соседние дни, перенос)» на «сначала предложи варианты из get_sequential_slots (все мастера, соседние дни, перенос)».

- [ ] **Step 4: Прогнать тесты промпта и синхронизировать старые ожидания**

Run: `cd /root/loyalpro/backend && npx jest agent-system-prompt`
Expected: новый тест PASS. Если упали тесты из утреннего коммита, привязанные к старым формулировкам («get_available_slots ВСЕХ мастеров», «соседние дни (get_available_dates…»), — обновить их ожидания на новые формулировки, СОХРАНИВ проверяемую семантику (сам стыкует / все мастера / соседние дни / перенос / эскалация крайняя мера). Семантику НЕ ослаблять и тесты НЕ удалять.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro
git add backend/services/agent/system-prompt.js backend/agent-system-prompt.test.js
git commit -m "feat(agent): промпт стыковки услуг — через get_sequential_slots вместо ручной арифметики окон"
```

---

### Task 6: Синхронизация спеки, полный прогон, выкат на dev

**Files:**
- Modify: `docs/superpowers/specs/2026-07-26-get-sequential-slots-design.md` (раздел «Выход»)

- [ ] **Step 1: Обновить пример выхода в спеке под фактическую форму**

В разделе «Выход» спеки: `with_gap` — не отдельное значение `type`, а булев флаг у варианта (`type` остаётся `same_staff|other_staff|mixed`); `gap_minutes` лежит в каждом элементе `starts`; добавлено поле `requested_date` и `service_title` в `chain`. Поправить JSON-пример и два упоминания в тексте («лестница», «сортировка») соответственно. Из списка причин пустой выдачи убрать `nobody_performs_all` — этот кейс закрывается mixed-вариантами и отдельной причиной не является (остаются `no_combo_in_horizon` и `filtered`).

- [ ] **Step 2: Полный прогон затронутых jest-сьютов**

Run: `cd /root/loyalpro/backend && npx jest sequential equipment service-filter agent-gate agent-system-prompt`
Expected: PASS все сьюты.

- [ ] **Step 3: Перезапустить dev-сервер и убедиться, что схема инструмента доехала**

Run: `pm2 restart loyalpro && sleep 3 && pm2 logs loyalpro --lines 20 --nostream`
Expected: рестарт без ошибок в логе (нет stack trace при старте).

- [ ] **Step 4: Commit + итоговое сообщение**

```bash
cd /root/loyalpro
git add docs/superpowers/specs/2026-07-26-get-sequential-slots-design.md
git commit -m "docs(agent): спека get_sequential_slots — синхронизация формы выхода с реализацией"
```

Сообщить пользователю: код на dev, для живого E2E нужно написать Миле с тестового номера 79200255591 (историю чистить скиллом clear-history) сценарий «чистку сразу после био». Ожидание: Мила сразу честно говорит, что встык у Юлии не выйдет ни 27.07, ни 01.08, предлагает варианты из инструмента (ближайший день встык / 27.07 с перерывом, чистка 20:30) и после согласия реально вызывает инструменты записи. Напомнить: на dev сейчас пилот deepseek-v4-flash — проверка покажет, вытягивает ли слабая модель сценарий с новым инструментом; при провале переключить POLZA_CHAT_MODEL обратно на gemini-2.5-pro.
