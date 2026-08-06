# Плотная запись: какое время Мила предлагает первым — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `get_available_slots` детерминированно подбирает 1–2 времени, примыкающих к уже существующим записям мастера, и отдаёт их отдельным полем `offer_slots`, из которого промпт разрешает называть время пациенту.

**Architecture:** Новый чистый модуль `services/agent/slot-density.js` считает «мёртвое время» до/после ближайшей занятости и сортирует слоты. Занятость берётся из сетки `/timetable/seances`, которую инструмент уже загружает, — лишних запросов в YClients нет. Массив `slots` остаётся полным и хронологическим (его читает `allowedTimes` reply-guard'а), рядом появляется короткий `offer_slots`.

**Tech Stack:** Node.js (CommonJS), Jest 30, без новых зависимостей.

**Спека:** `docs/superpowers/specs/2026-08-06-agent-slot-density-design.md`

---

## Файловая структура

| Файл | Ответственность |
|---|---|
| `backend/services/agent/slot-density.js` | **Создать.** Чистая логика: сетка сеансов → занятость; слоты + занятость → топ-N по плотности. Без БД и HTTP. |
| `backend/agent-slot-density.test.js` | **Создать.** Юнит-тесты чистого модуля, включая фикстуру боевого дня 07.08. |
| `backend/agent-slots-offer.test.js` | **Создать.** Тесты инструмента: `offer_slots` в одномастерной выдаче, обе ветки источника. |
| `backend/services/agent/tools/get-available-slots.js` | **Изменить.** Считать занятость, класть `offer_slots` в три вида выдачи, переписать хинты. |
| `backend/services/agent/system-prompt.js` | **Изменить.** Новое правило «КАКОЕ ВРЕМЯ ПРЕДЛАГАТЬ ПЕРВЫМ» + правки Шага 5, «ВЫБОР СПЕЦИАЛИСТА», «АЛЬТЕРНАТИВНЫЙ СПЕЦИАЛИСТ». |
| `backend/services/agent/tool-memory.js` | **Изменить.** Экстрактор `get_available_slots` рендерит показанные времена, а не первые из `slots`. |
| `backend/agent-slots-staff-options.test.js` | **Изменить.** Починить `toEqual` по форме объекта + регресс на `offer_slots`. |
| `backend/agent-slots-alternative-staff.test.js` | **Изменить.** Починить три `toEqual` + регресс на `offer_slots`. |
| `backend/agent-system-prompt.test.js` | **Изменить.** Связь промпта с полем `offer_slots`. |
| `backend/agent-tool-memory.test.js` | **Изменить.** Память рендерит `offer_slots`. |

Все команды выполняются из `/root/loyalpro/backend`, если не сказано иное.

**Важно про моки соседних сьютов.** В `agent-slots-staff-options.test.js` и `agent-slots-alternative-staff.test.js` длительность услуги замокана как **60 минут** (`equipment-context.durationMin → 60`), а не 30, как в боевом кейсе. Ожидаемые времена в задачах ниже посчитаны именно под 60 — не переносить числа из Task 1–2 механически.

---

## Task 1: Чистый модуль — сетка сеансов в занятость

**Files:**
- Create: `backend/services/agent/slot-density.js`
- Test: `backend/agent-slot-density.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/agent-slot-density.test.js`:

```js
'use strict';

// Мила предлагала САМОЕ РАННЕЕ свободное окно и рвала день мастера.
// Инцидент 2026-08-06 (диалог 79037504378): у Гаджиевой Пери на 07.08 сплошной
// блок 14:30–21:00 и свободно 11:00–14:30, а запись ушла на 11:30 — огрызок
// 11:00–11:30 плюс 2.5 часа простоя. Вплотную к блоку встаёт только 14:00.

const density = require('./services/agent/slot-density');

// Сетка /timetable/seances: точки через 5 минут с флагом is_free.
// from/to — 'HH:MM', to ЭКСКЛЮЗИВНО. busy — интервалы [['HH:MM','HH:MM']].
function grid(from, to, busy = []) {
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const cuts = busy.map(([a, b]) => [toMin(a), toMin(b)]);
  const out = [];
  for (let m = toMin(from); m < toMin(to); m += 5) {
    out.push({ time: toHHMM(m), is_free: !cuts.some(([a, b]) => m >= a && m < b) });
  }
  return out;
}

describe('seancesToBusy: занятость мастера из сетки сеансов', () => {
  test('интервалы склеиваются, свободное не попадает', () => {
    const busy = density.seancesToBusy(grid('11:00', '15:00', [['12:00', '13:00']]));
    expect(busy).toEqual([{ start: 12 * 60, end: 13 * 60 }]);
  });

  test('две занятости не склеиваются между собой', () => {
    const busy = density.seancesToBusy(grid('10:00', '16:00', [['11:00', '11:30'], ['14:00', '15:00']]));
    expect(busy).toEqual([
      { start: 11 * 60, end: 11 * 60 + 30 },
      { start: 14 * 60, end: 15 * 60 },
    ]);
  });

  // ГЛАВНАЯ ГОТЧА. Сетка ограничена сменой (проверено на проде: для смены
  // 11:00–21:00 пришли ровно точки 11:00…20:55). Если бы края смены попали в
  // занятость, слот в начале смены получил бы разрыв 0 «вплотную к занятому»
  // и снова побеждал бы — то есть фикс молча не работал бы на инцидентном кейсе.
  test('края смены занятостью НЕ становятся', () => {
    const busy = density.seancesToBusy(grid('11:00', '21:00', [['14:30', '21:00']]));
    expect(busy).toEqual([{ start: 14 * 60 + 30, end: 21 * 60 }]);
    expect(busy.some(b => b.start === 11 * 60)).toBe(false);
  });

  test('пустой и мусорный вход не роняют', () => {
    expect(density.seancesToBusy([])).toEqual([]);
    expect(density.seancesToBusy(null)).toEqual([]);
    expect(density.seancesToBusy([null, { is_free: true }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx jest agent-slot-density --silent`
Expected: FAIL — `Cannot find module './services/agent/slot-density'`

- [ ] **Step 3: Написать модуль**

Создать `backend/services/agent/slot-density.js`:

```js
'use strict';

const { mergeRanges } = require('./equipment');

// ============================================================
// ПЛОТНАЯ ЗАПИСЬ: какое из свободных времён предложить пациенту первым.
//
// Инцидент 2026-08-06 (диалог 79037504378): пациентка времени не называла,
// get_available_slots вернул 11:00…14:00 строго по возрастанию, модель взяла из
// начала списка и записала на 11:30. У мастера при этом был сплошной блок
// 14:30–21:00, то есть запись оставила огрызок 11:00–11:30 и 2.5 часа простоя.
// Вплотную к блоку встаёт ровно один слот — 14:00.
//
// Промпт-правилами это не чинится: правило «предлагай 1–2 времени из slots»
// модель выполнила дословно, а понятия «плотно» у неё нет вовсе. Считаем кодом.
//
// Все интервалы — минуты от полуночи по Москве, конец эксклюзивный: [start, end).
// Без БД и HTTP — юнит-тестируемо (agent-slot-density.test.js).
// ============================================================

const SEANCE_STEP_MIN = 5;   // шаг сетки /timetable/seances
// Ровно столько, сколько промпт велит называть («предложи 1 или 2 времени»).
// Экспортируется РАДИ ТЕСТОВ: фикстура с зашитой двойкой осталась бы зелёной и
// после сдвига капа.
const MAX_OFFER_SLOTS = 2;

const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };

// Сетка /timetable/seances → занятые интервалы мастера.
//
// ЗАЧЕМ сетка, а не /records: она уже загружена в schedule-ветке инструмента —
// расчёт не стоит ни одного лишнего запроса в YClients. И она знает не только
// записи, но и любую другую занятость кресла (перерыв, блокировку), а примыкать
// к перерыву для плотности так же хорошо, как к записи.
//
// ГОТЧА: границы сетки = границы смены (проверено на проде: смена 11:00–21:00 →
// ровно 120 точек 11:00…20:55). Поэтому края смены в занятость НЕ попадают и
// анкорами не становятся. Если YClients когда-нибудь начнёт присылать сутки
// целиком с is_free:false вне смены, слот в начале смены получит разрыв 0 и
// снова победит — то есть фикс сломается МОЛЧА. На это стоит тест.
function seancesToBusy(seances) {
  const out = [];
  for (const s of (Array.isArray(seances) ? seances : [])) {
    if (!s || s.is_free) continue;
    const start = toMin(s.time);
    if (!Number.isFinite(start)) continue;
    out.push({ start, end: start + SEANCE_STEP_MIN });
  }
  return mergeRanges(out);
}

module.exports = { seancesToBusy, MAX_OFFER_SLOTS };
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `npx jest agent-slot-density --silent`
Expected: PASS, 4 теста

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/slot-density.js backend/agent-slot-density.test.js && git commit -m "feat(agent): занятость мастера из сетки сеансов (чистый модуль плотности)

Первый шаг к плотной записи: seancesToBusy склеивает не-свободные точки
/timetable/seances в интервалы. Границы сетки = границы смены (проверено на
проде), поэтому края смены анкорами не становятся — на это отдельный тест:
иначе слот в начале смены получил бы «вплотную к занятому» и фикс сломался бы
молча.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Чистый модуль — ранжирование слотов по плотности

**Files:**
- Modify: `backend/services/agent/slot-density.js`
- Test: `backend/agent-slot-density.test.js`

- [ ] **Step 1: Написать падающий тест**

Дописать в конец `backend/agent-slot-density.test.js` (функция `grid` объявлена выше в этом же файле):

```js
describe('pickOfferSlots: минимум мёртвого времени до/после', () => {
  const at = (time, seconds) => ({ time, datetime: `2026-08-07T${time}:00+03:00`, seance_length: seconds });

  // Боевой день Гаджиевой Пери 07.08: смена 11:00–21:00, сплошной блок
  // 14:30–21:00, свободно 11:00–14:30, ботулинотерапия 30 мин.
  const REAL_DAY_BUSY = density.seancesToBusy(grid('11:00', '21:00', [['14:30', '21:00']]));
  const REAL_DAY_SLOTS = ['11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00']
    .map(t => at(t, 1800));

  test('инцидент 07.08: первым идёт 14:00, а не 11:00', () => {
    const offers = density.pickOfferSlots(REAL_DAY_SLOTS, REAL_DAY_BUSY, { durationMin: 30 });
    expect(offers.map(s => s.time)).toEqual(['14:00', '13:30']);
  });

  test('слот возвращается целым объектом — datetime нужен create_booking', () => {
    const [first] = density.pickOfferSlots(REAL_DAY_SLOTS, REAL_DAY_BUSY, { durationMin: 30 });
    expect(first).toEqual(at('14:00', 1800));
  });

  test('примыкание ПОСЛЕ записи считается так же, как ПЕРЕД', () => {
    const busy = density.seancesToBusy(grid('10:00', '20:00', [['10:00', '12:00']]));
    const slots = ['12:00', '13:00', '17:00'].map(t => at(t, 3600));
    const offers = density.pickOfferSlots(slots, busy, { durationMin: 60 });
    expect(offers[0].time).toBe('12:00');
  });

  // Второй ключ сортировки: слот, закрывающий дыру ЦЕЛИКОМ, обязан выигрывать у
  // примыкающего одной стороной — иначе «плотно» получается только наполовину.
  test('точное попадание в дыру между двумя записями выигрывает', () => {
    const busy = density.seancesToBusy(grid('10:00', '20:00', [['10:00', '12:00'], ['13:00', '15:00']]));
    // 12:00 закрывает дыру 12:00–13:00 целиком; 15:00 примыкает только слева.
    const slots = ['12:00', '15:00'].map(t => at(t, 3600));
    const offers = density.pickOfferSlots(slots, busy, { durationMin: 60 });
    expect(offers[0].time).toBe('12:00');
  });

  // Регресс на сегодняшнее поведение: у пустого дня анкоров нет, и порядок
  // обязан остаться хронологическим. Тут же ловится NaN-компаратор:
  // Infinity - Infinity = NaN, и sort с таким компаратором молча ломает порядок.
  test('день без единой записи → самые ранние слоты', () => {
    const busy = density.seancesToBusy(grid('10:00', '20:00', []));
    const slots = ['10:00', '11:00', '12:00', '13:00'].map(t => at(t, 3600));
    const offers = density.pickOfferSlots(slots, busy, { durationMin: 60 });
    expect(offers.map(s => s.time)).toEqual(['10:00', '11:00']);
  });

  test('длительность из слота главнее durationMin', () => {
    const busy = density.seancesToBusy(grid('10:00', '20:00', [['14:00', '16:00']]));
    // Услуга 120 мин: вплотную к 14:00 встаёт старт 12:00, а не 13:00.
    const slots = ['12:00', '13:00'].map(t => at(t, 7200));
    const offers = density.pickOfferSlots(slots, busy, { durationMin: 30 });
    expect(offers[0].time).toBe('12:00');
  });

  test('кап берётся из модуля и уважает limit', () => {
    const busy = density.seancesToBusy(grid('10:00', '20:00', []));
    const slots = ['10:00', '11:00', '12:00'].map(t => at(t, 3600));
    expect(density.pickOfferSlots(slots, busy, { durationMin: 60 }))
      .toHaveLength(density.MAX_OFFER_SLOTS);
    expect(density.pickOfferSlots(slots, busy, { durationMin: 60, limit: 1 })).toHaveLength(1);
  });

  test('пустой и мусорный вход не роняют', () => {
    expect(density.pickOfferSlots([], [], {})).toEqual([]);
    expect(density.pickOfferSlots(null, null, {})).toEqual([]);
    expect(density.pickOfferSlots([{ foo: 1 }], [], {})).toEqual([]);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx jest agent-slot-density --silent`
Expected: FAIL — `density.pickOfferSlots is not a function`

- [ ] **Step 3: Реализовать ранжирование**

В `backend/services/agent/slot-density.js` заменить строку

```js
module.exports = { seancesToBusy, MAX_OFFER_SLOTS };
```

на:

```js
// Стоимость слота [start, start+dur): расстояние до ближайшей занятости слева и
// справа. Бесконечность = с этой стороны занятости нет вовсе.
function slotCost(slot, busy, durationMin) {
  const start = toMin(slot.time);
  const fromSlot = Math.round((Number(slot.seance_length) || 0) / 60);
  const dur = fromSlot > 0 ? fromSlot : (durationMin > 0 ? durationMin : 0);
  const end = start + dur;
  let before = Infinity;
  let after = Infinity;
  for (const b of busy) {
    if (b.end <= start) before = Math.min(before, start - b.end);
    if (b.start >= end) after = Math.min(after, b.start - end);
  }
  return { near: Math.min(before, after), far: Math.max(before, after), start };
}

// Сравнение чисел ВЫЧИТАНИЕМ ЗАПРЕЩЕНО: у слота без соседей near/far равны
// Infinity, а Infinity - Infinity === NaN. Компаратор, вернувший NaN, оставляет
// порядок неопределённым — и «пустой день → самые ранние» тихо перестаёт
// работать ровно там, где регресс никто не заметит.
const cmp = (a, b) => (a === b ? 0 : (a < b ? -1 : 1));

// Топ-N слотов по плотности. Критерий (утверждён с салоном): минимум мёртвого
// времени до/после ближайшей существующей записи; при равенстве — слот, который
// примыкает ВТОРОЙ стороной тоже (закрывает дыру целиком); при равенстве —
// раньше по времени.
//
// Слот возвращается ЦЕЛЫМ объектом из входного массива: модель цитирует то же
// самое, что лежит в slots, и create_booking получает тот же datetime.
//
// Поля-причины («примыкает к записи») тут намеренно НЕТ: модель процитирует её
// пациенту, а это внутренняя кухня клиники — тот же класс, что «у главного врача
// на завтра всё занято» (инцидент 2026-08-04).
function pickOfferSlots(slots, busy, opts = {}) {
  const list = (Array.isArray(slots) ? slots : []).filter(s => s && s.time);
  if (!list.length) return [];
  const ranges = Array.isArray(busy) ? busy : [];
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : MAX_OFFER_SLOTS;
  const durationMin = Number(opts.durationMin) || 0;
  const scored = list.map((slot, i) => Object.assign({ slot, i }, slotCost(slot, ranges, durationMin)));
  scored.sort((a, b) => cmp(a.near, b.near) || cmp(a.far, b.far) || cmp(a.start, b.start) || cmp(a.i, b.i));
  return scored.slice(0, limit).map(x => x.slot);
}

module.exports = { seancesToBusy, pickOfferSlots, MAX_OFFER_SLOTS };
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `npx jest agent-slot-density --silent`
Expected: PASS, 12 тестов

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/slot-density.js backend/agent-slot-density.test.js && git commit -m "feat(agent): ранжирование слотов по плотности записи

pickOfferSlots ставит первым слот с минимальным мёртвым временем до/после
ближайшей записи. На боевой фикстуре дня 07.08 это 14:00 вместо предложенного
пациентке 11:30. Пустой день анкоров не имеет — порядок остаётся хронологическим.

Компаратор сравнивает, а не вычитает: Infinity - Infinity = NaN молча ломал бы
сортировку ровно на пустом дне.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `offer_slots` в одномастерной выдаче инструмента

**Files:**
- Create: `backend/agent-slots-offer.test.js`
- Modify: `backend/services/agent/tools/get-available-slots.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/agent-slots-offer.test.js`:

```js
'use strict';

// Инцидент 2026-08-06 (79037504378): инструмент отдавал slots строго по
// возрастанию времени, модель брала из начала и записала пациентку на 11:30 при
// сплошном блоке мастера 14:30–21:00. Теперь рядом со slots едет offer_slots —
// детерминированно подобранные времена, примыкающие к существующим записям.

jest.mock('./db', () => ({
  db: {
    one: jest.fn(async () => ({ id: 1, yclients_company_id: 100 })),
    oneOrNone: jest.fn(async () => ({ id: 1, yclients_company_id: 100 })),
    any: jest.fn(async () => []),
  },
}));
jest.mock('./services/yclients-booking', () => ({
  ycGetBookTimes: jest.fn(async () => []),
  ycGetStaffSeances: jest.fn(async () => []),
}));
jest.mock('./services/agent-settings', () => ({ loadServiceFilterSafe: jest.fn(async () => ({})) }));
jest.mock('./services/agent/service-filter', () => ({
  isBookable: jest.fn(() => true),
  decideServiceVisible: jest.fn(() => true),
}));
jest.mock('./services/agent/staff-service-guard', () => ({
  checkStaffPerformsService: jest.fn(async () => ({ ok: true, unknown: false, performers: [], staffList: [] })),
}));
jest.mock('./services/agent/equipment-context', () => ({
  loadEquipmentContext: jest.fn(async () => ({})),
  durationMin: jest.fn(() => 30),
  instancesFor: jest.fn(() => []),
  busyForService: jest.fn(() => []),
}));

const { ycGetBookTimes, ycGetStaffSeances } = require('./services/yclients-booking');
const tool = require('./services/agent/tools/get-available-slots');

// Сетка сеансов: точки через 5 минут, to эксклюзивно, busy — интервалы 'HH:MM'.
function grid(from, to, busy = []) {
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const cuts = busy.map(([a, b]) => [toMin(a), toMin(b)]);
  const out = [];
  for (let m = toMin(from); m < toMin(to); m += 5) {
    out.push({ time: toHHMM(m), is_free: !cuts.some(([a, b]) => m >= a && m < b) });
  }
  return out;
}

// 06.08.2026 13:45 мск — момент боевого вызова (lead-time на завтра не режет).
const CTX = { nowMs: Date.parse('2026-08-06T13:45:00+03:00') };
const ARGS = { staff_yc_id: 1910274, service_yc_id: 9536676, date: '2026-08-07' };

beforeEach(() => {
  jest.clearAllMocks();
  ycGetBookTimes.mockResolvedValue([]);
  ycGetStaffSeances.mockResolvedValue([]);
});

describe('offer_slots: одномастерная выдача', () => {
  test('боевой день 07.08 — первым 14:00, slots остаётся полным', async () => {
    ycGetStaffSeances.mockResolvedValue(grid('11:00', '21:00', [['14:30', '21:00']]));
    const res = await tool.run(1, ARGS, CTX);
    expect(res.slots.map(s => s.time))
      .toEqual(['11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00']);
    expect(res.offer_slots.map(s => s.time)).toEqual(['14:00', '13:30']);
  });

  test('offer_slots — это объекты ИЗ slots (тот же datetime для create_booking)', async () => {
    ycGetStaffSeances.mockResolvedValue(grid('11:00', '21:00', [['14:30', '21:00']]));
    const res = await tool.run(1, ARGS, CTX);
    for (const o of res.offer_slots) expect(res.slots).toContainEqual(o);
  });

  test('booking-ветка: занятость дотягивается сеткой, offer_slots считается', async () => {
    ycGetBookTimes.mockResolvedValue([
      { time: '11:00', datetime: '2026-08-07T11:00:00+03:00', seance_length: 1800 },
      { time: '14:00', datetime: '2026-08-07T14:00:00+03:00', seance_length: 1800 },
    ]);
    ycGetStaffSeances.mockResolvedValue(grid('11:00', '21:00', [['14:30', '21:00']]));
    const res = await tool.run(1, ARGS, CTX);
    expect(res.source).toBe('booking');
    expect(res.offer_slots.map(s => s.time)).toEqual(['14:00', '11:00']);
  });

  // Fail-open: без занятости деградируем в сегодняшнее поведение (самые ранние),
  // а не в отсутствие ответа. Сбой сетки не должен стоить пациенту времени.
  test('booking-ветка: сетка недоступна → самые ранние, ответ не падает', async () => {
    ycGetBookTimes.mockResolvedValue([
      { time: '11:00', datetime: '2026-08-07T11:00:00+03:00', seance_length: 1800 },
      { time: '14:00', datetime: '2026-08-07T14:00:00+03:00', seance_length: 1800 },
    ]);
    ycGetStaffSeances.mockRejectedValue(new Error('YClients 500'));
    const res = await tool.run(1, ARGS, CTX);
    expect(res.offer_slots.map(s => s.time)).toEqual(['11:00', '14:00']);
  });

  test('пустой день у мастера → offer_slots пуст, а не выдуман', async () => {
    ycGetStaffSeances.mockResolvedValue(grid('11:00', '21:00', [['11:00', '21:00']]));
    const res = await tool.run(1, ARGS, CTX);
    expect(res.slots).toEqual([]);
    expect(res.offer_slots).toEqual([]);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx jest agent-slots-offer --silent`
Expected: FAIL — `Cannot read properties of undefined (reading 'map')` на `res.offer_slots`

- [ ] **Step 3: Подключить модуль в инструмент**

В `backend/services/agent/tools/get-available-slots.js` после строки

```js
const leadTime = require('../lead-time');
```

добавить:

```js
const density = require('../slot-density');
```

Заменить booking-ветку внутри `computeStaffSlots` — было:

```js
    if (slots.length) return dropDisallowedStarts({ slots, source: 'booking' }, date, nowMs);
```

стало:

```js
    if (slots.length) {
      const out = dropDisallowedStarts({ slots, source: 'booking' }, date, nowMs);
      // Занятость для ранжирования здесь взять неоткуда: онлайн-запись отдаёт
      // только свободные старты. Тянем сетку смены ОТДЕЛЬНО — это один лишний
      // запрос, но только на салонах с включённой онлайн-записью (у PERI это
      // 4 услуги из 317, обычный путь идёт ниже и сетку уже загрузил).
      // Сбой → пустая занятость → offer_slots = самые ранние, то есть ровно
      // сегодняшнее поведение. Ранжирование не должно стоить пациенту ответа.
      let busy = [];
      try { busy = density.seancesToBusy(await ycGetStaffSeances(salon, staffId, date)); } catch (_) { busy = []; }
      out.offer_slots = density.pickOfferSlots(out.slots, busy, {});
      return out;
    }
```

Заменить хвост `computeStaffSlots` — было:

```js
  const out = { slots, source: 'schedule' };
  if (equipmentBusy) out.equipment_busy = true;   // часть окон срезана занятым аппаратом
  return dropDisallowedStarts(out, date, nowMs);
```

стало:

```js
  const out = { slots, source: 'schedule' };
  if (equipmentBusy) out.equipment_busy = true;   // часть окон срезана занятым аппаратом
  const ranked = dropDisallowedStarts(out, date, nowMs);
  // Плотность считаем ПОСЛЕ lead-time и ПОСЛЕ вычета занятого оборудования:
  // иначе порекомендуем старт, который сам же отфильтровали, и create_booking
  // упрётся в save_if_busy:false уже после согласования времени с пациентом.
  ranked.offer_slots = density.pickOfferSlots(ranked.slots, density.seancesToBusy(seances),
    { durationMin: svcDurationMin });
  return ranked;
```

- [ ] **Step 4: Убедиться, что новые тесты проходят**

Run: `npx jest agent-slots-offer --silent`
Expected: PASS, 5 тестов

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/tools/get-available-slots.js backend/agent-slots-offer.test.js && git commit -m "feat(agent): get_available_slots отдаёт offer_slots рядом с полным slots

slots остаётся полным и хронологическим — его читает allowedTimes reply-guard'а
и он нужен, когда пациент сам просит «а можно в 12?». Рядом едет offer_slots:
1-2 времени, примыкающих к существующим записям мастера.

Занятость в обычной ветке берётся из уже загруженной сетки сеансов (ноль лишних
запросов), в booking-ветке — отдельным best-effort вызовом. Считается ПОСЛЕ
lead-time и вычета оборудования, иначе рекомендовали бы отфильтрованный старт.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `offer_slots` у `staff_options` и `alternative_staff` + хинты

**Files:**
- Modify: `backend/services/agent/tools/get-available-slots.js`
- Test: `backend/agent-slots-staff-options.test.js`, `backend/agent-slots-alternative-staff.test.js`

Новое поле ломает четыре существующих `toEqual` по ТОЧНОЙ форме объекта — их надо починить в этой же задаче, иначе Step 4 останется красным.

- [ ] **Step 1: Починить существующие `toEqual` и написать новые падающие тесты**

**(a)** В `backend/agent-slots-staff-options.test.js` заменить

```js
    expect(out.staff_options).toEqual([
      { staff_yc_id: 11, name: 'Юлия', position: null, slots: bookSlot('12:00') },
      { staff_yc_id: 12, name: 'Пери Исамудиновна', position: null, slots: bookSlot('15:00') },
    ]);
```

на

```js
    expect(out.staff_options).toEqual([
      { staff_yc_id: 11, name: 'Юлия', position: null, slots: bookSlot('12:00'), offer_slots: bookSlot('12:00') },
      { staff_yc_id: 12, name: 'Пери Исамудиновна', position: null, slots: bookSlot('15:00'), offer_slots: bookSlot('15:00') },
    ]);
```

**(b)** В `backend/agent-slots-alternative-staff.test.js` заменить (три места, все три — точная форма объекта):

```js
    expect(out.alternative_staff).toEqual([
      { staff_yc_id: 12, name: 'Татьяна', slots: bookSlot('14:00') },
    ]);
```
→
```js
    expect(out.alternative_staff).toEqual([
      { staff_yc_id: 12, name: 'Татьяна', slots: bookSlot('14:00'), offer_slots: bookSlot('14:00') },
    ]);
```

```js
    expect(out.alternative_staff).toEqual([
      { staff_yc_id: 13, name: 'Мария', slots: bookSlot('14:00') },
    ]);
```
→
```js
    expect(out.alternative_staff).toEqual([
      { staff_yc_id: 13, name: 'Мария', slots: bookSlot('14:00'), offer_slots: bookSlot('14:00') },
    ]);
```

```js
    expect(out.alternative_staff).toEqual([
      { staff_yc_id: 13, name: 'Мария', slots: bookSlot('16:30') },
    ]);
```
→
```js
    expect(out.alternative_staff).toEqual([
      { staff_yc_id: 13, name: 'Мария', slots: bookSlot('16:30'), offer_slots: bookSlot('16:30') },
    ]);
```

**(c)** Дописать в конец `backend/agent-slots-staff-options.test.js`:

```js
// Сетка сеансов: точки через 5 минут, to эксклюзивно, busy — интервалы 'HH:MM'.
function seanceGrid(from, to, busy = []) {
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const cuts = busy.map(([a, b]) => [toMin(a), toMin(b)]);
  const out = [];
  for (let m = toMin(from); m < toMin(to); m += 5) {
    out.push({ time: toHHMM(m), is_free: !cuts.some(([a, b]) => m >= a && m < b) });
  }
  return out;
}

describe('offer_slots в staff_options', () => {
  const { ycGetStaffSeances } = require('./services/yclients-booking');

  // ВНИМАНИЕ: в этом файле equipment-context.durationMin замокан на 60 минут,
  // поэтому вплотную к блоку 14:30 встаёт старт 13:30, а не 14:00, как в
  // 30-минутном боевом кейсе.
  test('у каждого специалиста своё offer_slots, посчитанное по ЕГО дню', async () => {
    ycGetStaffSeances.mockImplementation(async (_salon, staffId) => (staffId === 11
      ? seanceGrid('11:00', '21:00', [['14:30', '21:00']])    // блок после обеда
      : seanceGrid('11:00', '21:00', [['11:00', '13:00']]))); // блок с утра
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    const byId = Object.fromEntries(out.staff_options.map(o => [String(o.staff_yc_id), o]));
    expect(byId['11'].offer_slots.map(s => s.time)).toEqual(['13:30', '13:00']);
    expect(byId['12'].offer_slots[0].time).toBe('13:00');
    // Полный список сохраняется — пациент может попросить другое время.
    expect(byId['11'].slots.length).toBeGreaterThan(byId['11'].offer_slots.length);
  });

  test('хинт велит называть время из offer_slots', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) =>
      staffId === 13 ? [] : bookSlot('12:00'));
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.hint).toMatch(/offer_slots/);
  });
});
```

**(d)** Дописать в конец `backend/agent-slots-alternative-staff.test.js`:

```js
function seanceGrid(from, to, busy = []) {
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const cuts = busy.map(([a, b]) => [toMin(a), toMin(b)]);
  const out = [];
  for (let m = toMin(from); m < toMin(to); m += 5) {
    out.push({ time: toHHMM(m), is_free: !cuts.some(([a, b]) => m >= a && m < b) });
  }
  return out;
}

describe('offer_slots у альтернативных специалистов', () => {
  // durationMin в этом файле замокан на 60 минут → вплотную к блоку 14:30
  // встаёт старт 13:30.
  test('альтернативный мастер приходит с offer_slots', async () => {
    ycGetStaffSeances.mockImplementation(async (_salon, staffId) => (staffId === 11
      ? seanceGrid('11:00', '21:00', [['11:00', '21:00']])     // у запрошенного всё занято
      : seanceGrid('11:00', '21:00', [['14:30', '21:00']])));
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.slots).toEqual([]);
    expect(out.alternative_staff.length).toBeGreaterThan(0);
    for (const a of out.alternative_staff) {
      expect(a.offer_slots[0].time).toBe('13:30');
      expect(a.slots.length).toBeGreaterThan(a.offer_slots.length);
    }
  });

  test('хинт альтернативы велит брать время из offer_slots', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) =>
      staffId === 12 ? bookSlot('14:00') : []);
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.hint).toMatch(/offer_slots/);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `npx jest agent-slots-staff-options agent-slots-alternative-staff --silent`
Expected: FAIL — `offer_slots` отсутствует в объектах и в хинтах

- [ ] **Step 3: Пробросить `offer_slots` и переписать хинты**

В `backend/services/agent/tools/get-available-slots.js`:

**(a)** в `findAlternativeStaff` заменить

```js
      const r = await computeStaffSlots(salon, m.yc_id, serviceId, date, nowMs);
      return { staff_yc_id: m.yc_id, name: m.name, slots: r.slots || [] };
```

на

```js
      const r = await computeStaffSlots(salon, m.yc_id, serviceId, date, nowMs);
      return { staff_yc_id: m.yc_id, name: m.name, slots: r.slots || [], offer_slots: r.offer_slots || [] };
```

**(b)** в `computeStaffOptions` заменить

```js
      const r = await computeStaffSlots(salon, m.yc_id, serviceId, date, nowMs);
      return { staff_yc_id: m.yc_id, name: m.name, position: null, slots: r.slots || [] };
```

на

```js
      const r = await computeStaffSlots(salon, m.yc_id, serviceId, date, nowMs);
      return {
        staff_yc_id: m.yc_id, name: m.name, position: null,
        slots: r.slots || [], offer_slots: r.offer_slots || [],
      };
```

**(c)** в `HINT_STAFF_CHOICE` заменить

```js
  'Перечисли в ОДНОМ сообщении ВСЕХ из staff_options: имя, должность (position) и 1–2 времени ' +
  'ДОСЛОВНО из его slots, и спроси, к кому удобнее записать. НЕ выбирай сама и никого не советуй ' +
```

на

```js
  'Перечисли в ОДНОМ сообщении ВСЕХ из staff_options: имя, должность (position) и время ' +
  'ДОСЛОВНО из его offer_slots (это уже подобранные 1–2 времени; полный slots бери, только если ' +
  'пациент сам попросил другое), и спроси, к кому удобнее записать. НЕ выбирай сама и никого не советуй ' +
```

**(d)** в `HINT_STAFF_SINGLE` заменить

```js
  'назови его имя, должность (position) и 1–2 времени ДОСЛОВНО из slots и предложи записать.';
```

на

```js
  'назови его имя, должность (position) и время ДОСЛОВНО из offer_slots и предложи записать.';
```

**(e)** в `HINT_STAFF_ONE_OF_PARTIAL` заменить

```js
  'Назови его имя, должность (position) и 1–2 времени ДОСЛОВНО из slots и предложи записать. ' +
```

на

```js
  'Назови его имя, должность (position) и время ДОСЛОВНО из offer_slots и предложи записать. ' +
```

**(f)** в `run()`, в хинте альтернативного специалиста, заменить

```js
        'записаться к одному из них (назови имя), время бери ДОСЛОВНО из их slots. ' +
```

на

```js
        'записаться к одному из них (назови имя), время бери ДОСЛОВНО из их offer_slots. ' +
```

- [ ] **Step 4: Убедиться, что все четыре сьюта инструмента зелёные**

Run: `npx jest agent-slots --silent`
Expected: PASS — `agent-slots-offer`, `agent-slots-staff-options`, `agent-slots-staff-check`, `agent-slots-alternative-staff`

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/tools/get-available-slots.js backend/agent-slots-staff-options.test.js backend/agent-slots-alternative-staff.test.js && git commit -m "feat(agent): offer_slots у staff_options и alternative_staff, хинты про него

Плотность считается по дню КАЖДОГО мастера отдельно. Порядок самих специалистов
не тронут — он по-прежнему по ближайшему окну: плотность решает, какое время
назвать, а не какого врача предложить (выбор врача за пациентом, цена у разных
мастеров разная).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Правило промпта

**Files:**
- Modify: `backend/services/agent/system-prompt.js`
- Test: `backend/agent-system-prompt.test.js`

- [ ] **Step 1: Написать падающий тест**

Дописать в конец `backend/agent-system-prompt.test.js` (`buildSystemPrompt` уже импортирован в первой строке файла):

```js
describe('КАКОЕ ВРЕМЯ ПРЕДЛАГАТЬ ПЕРВЫМ (плотная запись)', () => {
  const p = buildSystemPrompt({});

  test('правило есть и называет поле offer_slots', () => {
    expect(p).toContain('КАКОЕ ВРЕМЯ ПРЕДЛАГАТЬ ПЕРВЫМ');
    expect(p).toContain('offer_slots');
  });

  // Пациент главнее подобранного времени: иначе просьба «а есть пораньше?»
  // упирается в правило и остаётся без ответа.
  test('просьба пациента о другом времени разрешает полный slots', () => {
    expect(p).toContain('пораньше');
    expect(p).toContain('просьба пациента всегда важнее');
  });

  // Внутренняя кухня: «чтобы врачу было удобнее» пациенту знать не надо —
  // тот же класс, что «у главного врача на завтра всё занято» (04.08).
  test('причину подбора пациенту объяснять запрещено', () => {
    expect(p).toContain('чтобы врачу было удобнее');
  });

  // Промпт и хинты инструмента обязаны говорить об ОДНОМ И ТОМ ЖЕ поле:
  // переименование в одном месте молча оставит второе с мёртвой ссылкой.
  test('хинты инструмента и правило говорят про одно и то же поле', () => {
    const src = require('fs').readFileSync(
      require.resolve('./services/agent/tools/get-available-slots'), 'utf8');
    expect(src).toContain('offer_slots');
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx jest agent-system-prompt --silent`
Expected: FAIL — промпт не содержит `КАКОЕ ВРЕМЯ ПРЕДЛАГАТЬ ПЕРВЫМ`

- [ ] **Step 3: Добавить правило и поправить соседние**

В `backend/services/agent/system-prompt.js`:

**(a)** сразу ПОСЛЕ элемента массива, начинающегося с `` `Шаг 5. Предложи 1 или 2 конкретных времени `` (то есть между Шагом 5 и правилом «ВЫБОР СПЕЦИАЛИСТА ДЕЛАЕТ ПАЦИЕНТ»), вставить новый элемент:

```js
    `КАКОЕ ВРЕМЯ ПРЕДЛАГАТЬ ПЕРВЫМ. Если в ответе get_available_slots есть НЕПУСТОЕ поле offer_slots — называй пациенту время ТОЛЬКО оттуда (это уже подобранные 1–2 времени, поля time/datetime копируй ДОСЛОВНО). Полный массив slots бери ТОЛЬКО тогда, когда пациент САМ назвал конкретное время или попросил другое — пораньше, попозже, утром, вечером, в другой половине дня: просьба пациента всегда важнее подобранного времени, и если названное им время есть в slots, подтверждай именно его. ПОЧЕМУ предложено именно это время, пациенту НЕ объясняй — не пиши «чтобы врачу было удобнее», «подстроим под расписание врача», «так плотнее» и подобное: это внутренняя кухня клиники. Если offer_slots в ответе нет или он пуст — работай по slots, как обычно.`,
```

**(b)** в Шаге 5 заменить

```
Шаг 5. Предложи 1 или 2 конкретных времени, ДОСЛОВНО скопированных из массива slots ответа get_available_slots (поле time/datetime).
```

на

```
Шаг 5. Предложи 1 или 2 конкретных времени, ДОСЛОВНО скопированных из ответа get_available_slots (поле time/datetime): из offer_slots, если он непустой, иначе из slots — см. правило «КАКОЕ ВРЕМЯ ПРЕДЛАГАТЬ ПЕРВЫМ».
```

**(c)** в правиле «ВЫБОР СПЕЦИАЛИСТА ДЕЛАЕТ ПАЦИЕНТ» заменить

```
имя, должность (поле position) и 1–2 времени ДОСЛОВНО из его slots, и спроси, к кому удобнее записать
```

на

```
имя, должность (поле position) и время ДОСЛОВНО из его offer_slots (если он пуст — из slots), и спроси, к кому удобнее записать
```

**(d)** в правиле «АЛЬТЕРНАТИВНЫЙ СПЕЦИАЛИСТ» заменить

```
назови имя специалиста из alternative_staff и 1–2 времени ДОСЛОВНО из его slots, ясно обозначив
```

на

```
назови имя специалиста из alternative_staff и время ДОСЛОВНО из его offer_slots (если он пуст — из slots), ясно обозначив
```

- [ ] **Step 4: Убедиться, что весь сьют промпта зелёный**

Run: `npx jest agent-system-prompt --silent`
Expected: PASS, весь файл

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/system-prompt.js backend/agent-system-prompt.test.js && git commit -m "feat(agent): промпт-правило «КАКОЕ ВРЕМЯ ПРЕДЛАГАТЬ ПЕРВЫМ»

Есть непустой offer_slots — называть время только оттуда. Полный slots
разрешён ровно тогда, когда пациент сам назвал время или попросил другое:
просьба пациента важнее подобранного времени. Причину подбора объяснять
запрещено явно — «чтобы врачу было удобнее» это внутренняя кухня.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Память между ходами рендерит показанные времена

**Files:**
- Modify: `backend/services/agent/tool-memory.js`
- Test: `backend/agent-tool-memory.test.js`

- [ ] **Step 1: Написать падающий тест**

Дописать в конец `backend/agent-tool-memory.test.js` (`renderMemory`, `ev`, `MIN`, `NOW` объявлены в начале файла; `renderMemory` возвращает объект с полем `lines`):

```js
describe('память: рендерятся ПОКАЗАННЫЕ времена, а не начало slots', () => {
  const INP = { service_yc_id: 9536676, date: '2026-08-07' };
  const ALL = ['11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00'].map(t => ({ time: t }));
  const OFFER = [{ time: '14:00' }, { time: '13:30' }];

  // В журнал должно попадать то, что пациент реально услышал: иначе следующим
  // ходом модель процитирует время, которое сама никогда не предлагала.
  test('одномастерная выдача: в память идёт offer_slots с многоточием', () => {
    const { lines } = renderMemory(
      [ev({ tool: 'get_available_slots', input: { ...INP, staff_yc_id: 1910274 }, age_ms: MIN,
        result: { slots: ALL, offer_slots: OFFER } })], { nowMs: NOW });
    expect(lines.join('\n')).toContain('14:00, 13:30…');
    expect(lines.join('\n')).not.toContain('11:00');
  });

  test('staff_options: в память идёт offer_slots каждого мастера', () => {
    const { lines } = renderMemory(
      [ev({ tool: 'get_available_slots', input: INP, age_ms: MIN,
        result: { staff_options: [{ name: 'Пери', slots: ALL, offer_slots: OFFER }] } })], { nowMs: NOW });
    expect(lines.join('\n')).toContain('Пери: 14:00, 13:30…');
  });

  // События, записанные ДО выката, offer_slots не имеют, а память читает журнал
  // за 48 часов — для них поведение обязано остаться прежним.
  test('события без offer_slots рендерятся по slots, как раньше', () => {
    const { lines } = renderMemory(
      [ev({ tool: 'get_available_slots', input: { ...INP, staff_yc_id: 1910274 }, age_ms: MIN,
        result: { slots: ALL } })], { nowMs: NOW });
    expect(lines.join('\n')).toContain('11:00');
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx jest agent-tool-memory --silent`
Expected: FAIL — вывод содержит `11:00` там, где ожидался `14:00, 13:30…`

- [ ] **Step 3: Поправить экстрактор**

В `backend/services/agent/tool-memory.js` добавить хелпер сразу после функции `isPiiKey`:

```js
// Времена, которые пациент РЕАЛЬНО услышал. Инструмент подбирает их сам
// (offer_slots — слоты, примыкающие к существующим записям мастера), и в журнал
// должно попадать именно это: рендер первых элементов полного slots писал бы в
// память время, которое модель никогда не называла, и следующим ходом она
// сослалась бы на него как на предложенное.
// Старые события журнала (до выката offer_slots) живут в памяти ещё 48 часов —
// для них фолбэк на slots обязателен.
function shownTimes(holder, cap) {
  const offer = Array.isArray(holder.offer_slots) ? holder.offer_slots : [];
  const all = Array.isArray(holder.slots) ? holder.slots : [];
  const src = offer.length ? offer : all;
  return src.slice(0, cap).map(s => s && s.time).filter(Boolean);
}
```

В экстракторе `get_available_slots` заменить

```js
      const per = res.staff_options.slice(0, 3).map((o) => {
        const all = Array.isArray(o.slots) ? o.slots : [];
        const times = all.slice(0, 6).map(s => s && s.time).filter(Boolean);
        return `${o.name}: ${times.join(', ')}${all.length > 6 ? '…' : ''}`;
      });
```

на

```js
      const per = res.staff_options.slice(0, 3).map((o) => {
        const all = Array.isArray(o.slots) ? o.slots : [];
        const times = shownTimes(o, 6);
        return `${o.name}: ${times.join(', ')}${all.length > times.length ? '…' : ''}`;
      });
```

и заменить

```js
    const times = slots.slice(0, 12).map(s => s && s.time).filter(Boolean);
    return `${base}: показаны ${times.join(', ')}${slots.length > 12 ? '…' : ''}`;
```

на

```js
    const times = shownTimes(res, 12);
    return `${base}: показаны ${times.join(', ')}${slots.length > times.length ? '…' : ''}`;
```

- [ ] **Step 4: Убедиться, что весь сьют памяти зелёный**

Run: `npx jest agent-tool-memory --silent`
Expected: PASS, весь файл

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/tool-memory.js backend/agent-tool-memory.test.js && git commit -m "fix(agent): память рендерит показанные времена, а не начало slots

Экстрактор писал в журнал первые элементы полного slots — то есть время,
которое модель пациенту не называла, и следующим ходом она сослалась бы на него
как на предложенное. Теперь в журнал идёт offer_slots; для событий до выката
фолбэк на slots остаётся (память читает 48 часов назад).

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Полный прогон и проверка на боевой форме данных

**Files:** весь сьют

- [ ] **Step 1: Прогнать весь агентский сьют**

Run: `npx jest agent- --silent 2>&1 | tail -20`
Expected: PASS, ни одного упавшего файла

- [ ] **Step 2: Прогнать весь сьют, кроме известного флейка**

Run: `npx jest --silent --testPathIgnorePatterns primary-clients 2>&1 | tail -20`
Expected: PASS. `primary-clients.test.js` исключён намеренно — он зовёт `process.exit(1)` и убивает соседний сьют; это известный флейк, а не регресс этой работы.

- [ ] **Step 3: Проверить ранжирование на БОЕВОЙ сетке мастера**

Скрипт читает реальную сетку 07.08 у мастера 1910274 через дев-подключение к YClients и печатает порядок. Ничего не пишет и никому не отправляет.

Run:

```bash
cd /root/loyalpro/backend && node -e "
const { db } = require('./db');
const { ycGetStaffSeances } = require('./services/yclients-booking');
const density = require('./services/agent/slot-density');
(async () => {
  const salon = await db.one('SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token FROM salons WHERE id=1');
  const seances = await ycGetStaffSeances(salon, 1910274, '2026-08-07');
  const busy = density.seancesToBusy(seances);
  console.log('busy:', busy.map(b => b.start + '-' + b.end).join(' '));
  const slots = ['11:00','11:30','12:00','12:30','13:00','13:30','14:00']
    .map(t => ({ time: t, datetime: '2026-08-07T' + t + ':00+03:00', seance_length: 1800 }));
  console.log('offer:', density.pickOfferSlots(slots, busy, { durationMin: 30 }).map(s => s.time).join(', '));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
"
```

Expected: строка `busy:` не начинается с `0-` (края смены не попали в занятость), `offer: 14:00, 13:30`.

Если дев не достучался до YClients или до БД — записать это в отчёт как НЕПРОВЕРЕННЫЙ пункт и не выдавать за успех. Юнит-тест на ту же фикстуру (Task 2) остаётся зелёным независимо.

- [ ] **Step 4: Убедиться, что рабочее дерево чисто**

Run: `cd /root/loyalpro && git status --short`
Expected: пусто. Если Step 1–2 потребовали правок — закоммитить их отдельным коммитом с описанием, что именно чинилось.

---

## Self-review плана против спеки

| Требование спеки | Задача |
|---|---|
| §3.1 `seancesToBusy`, края смены не анкоры | Task 1 |
| §3.2 `pickOfferSlots`, сортировка, пустой день, отсутствие поля-причины | Task 2 |
| §3.3 `MAX_OFFER_SLOTS = 2`, экспорт ради тестов | Task 2 |
| §4.1 `slots` полный, `offer_slots` после lead-time и оборудования | Task 3 |
| §4.2 занятость: schedule — из сетки, booking — best-effort, fail-open | Task 3 |
| §4.3 хинты про `offer_slots` | Task 4 |
| §4.4 порядок `staff_options` не меняется | Task 4 — сортировка не трогается, её стерегут существующие тесты «порядок — по времени первого свободного окна» и «кап/сортировка кандидатов» |
| §5 правило промпта, приоритет просьбы пациента, запрет объяснять причину | Task 5 |
| §6 память рендерит `offer_slots` | Task 6 |
| §7 тесты | Task 1–6, прогон Task 7 |
| §8 не трогать parallel/sequential/dates | в плане нет ни одной правки этих файлов |
