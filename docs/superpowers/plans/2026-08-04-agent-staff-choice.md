# Выбор специалиста пациентом — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Когда пациент не назвал врача, Мила показывает свободное время всех исполнителей услуги и даёт выбрать, вместо того чтобы молча взять одного (обычно более дорогого главврача).

**Architecture:** У инструмента `get_available_slots` параметр `staff_yc_id` становится необязательным. Без него инструмент перебирает исполнителей услуги из каталога (до 3), считает окна каждому уже существующим `computeStaffSlots` (те же lead-time, оборудование, fallback на график), выбрасывает тех, у кого пусто, и возвращает `staff_options: [{staff_yc_id, name, position, slots}]`. Промпт получает правило «ВЫБОР СПЕЦИАЛИСТА ДЕЛАЕТ ПАЦИЕНТ».

**Tech Stack:** Node.js, Jest (тесты в `backend/*.test.js`, запуск `npx jest <паттерн>`), PostgreSQL (`staff_members.specialization`), YClients API через `services/yclients-booking`.

Спека: `docs/superpowers/specs/2026-08-04-agent-staff-choice-design.md`.

---

## Файлы

- Modify: `backend/services/agent/tools/get-available-slots.js` — мультимастерный режим (schema, ветка в `run`, `computeStaffOptions`, должности, хинты).
- Create: `backend/agent-slots-staff-options.test.js` — юнит-тесты мультирежима.
- Modify: `backend/services/agent/tool-memory.js:183` — экстрактор `get_available_slots` должен понимать `staff_options` (иначе журнал соврёт «времени не было»).
- Modify: `backend/agent-tool-memory.test.js` — тест на мультирежим в памяти.
- Modify: `backend/services/agent/system-prompt.js` — Шаг 2, Шаг 4, новое правило, сужение «Любой специалист».
- Modify: `backend/agent-system-prompt.test.js` — связка правила с полями инструмента.
- Modify: `CLAUDE.md` — абзац про выбор специалиста.

Не трогаем: `get_parallel_slots`, `get_sequential_slots`, Сценарий 3 (перенос), цены и `get_service_masters`.

---

### Task 1: Мультимастерный режим `get_available_slots`

**Files:**
- Modify: `backend/services/agent/tools/get-available-slots.js`
- Test: `backend/agent-slots-staff-options.test.js` (создать)

- [ ] **Step 1: Написать падающие тесты основного пути**

Создать `backend/agent-slots-staff-options.test.js`:

```js
'use strict';

// Пациент не назвал врача → выбор мастера делает ОН, а не модель: без staff_yc_id
// инструмент считает окна у всех исполнителей услуги и отдаёт их списком.
// Раньше модель брала мастера сама и молча предлагала его (у главврача цена выше).

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
jest.mock('./services/agent/service-filter', () => ({ isBookable: jest.fn(() => true) }));
jest.mock('./services/agent/equipment-context', () => ({
  loadEquipmentContext: jest.fn(async () => ({ busy: [], resources: [] })),
  durationMin: jest.fn(() => 60),
  instancesFor: jest.fn(() => []),
  busyForService: jest.fn(() => []),
}));
jest.mock('./services/agent/tools/list-services', () => ({ run: jest.fn() }));

const { ycGetBookTimes } = require('./services/yclients-booking');
const svcFilter = require('./services/agent/service-filter');
const listServices = require('./services/agent/tools/list-services');
const slots = require('./services/agent/tools/get-available-slots');

// Услуга 900: Юлия (11), Пери Исамудиновна (12), Мария (13).
const CATALOG = {
  services: [
    { yc_id: 900, title: 'Биоревитализация', staff: [
      { yc_id: 11, name: 'Юлия' }, { yc_id: 12, name: 'Пери Исамудиновна' }, { yc_id: 13, name: 'Мария' },
    ] },
  ],
};
const NOON = Date.parse('2026-08-01T09:00:00+03:00');
const DATE = '2026-08-02';
const ARGS = { service_yc_id: 900, date: DATE };   // БЕЗ staff_yc_id

const bookSlot = (time) => [{ time, datetime: `${DATE}T${time}:00+03:00`, seance_length: 3600 }];

beforeEach(() => {
  jest.clearAllMocks();
  listServices.run.mockResolvedValue(CATALOG);
  ycGetBookTimes.mockResolvedValue([]);
  svcFilter.isBookable.mockReturnValue(true);
});

describe('get_available_slots без staff_yc_id — выбор специалиста пациентом', () => {
  test('окна есть у двоих → staff_options с обоими, слоты дословно', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) => {
      if (staffId === 11) return bookSlot('12:00');
      if (staffId === 12) return bookSlot('15:00');
      return [];
    });
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options).toEqual([
      { staff_yc_id: 11, name: 'Юлия', position: null, slots: bookSlot('12:00') },
      { staff_yc_id: 12, name: 'Пери Исамудиновна', position: null, slots: bookSlot('15:00') },
    ]);
    expect(out.slots).toBeUndefined();
  });

  test('мастер без окон в список не попадает', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) =>
      staffId === 12 ? bookSlot('15:00') : []);
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options.map(o => o.staff_yc_id)).toEqual([12]);
  });

  test('порядок — по времени первого свободного окна', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) => {
      if (staffId === 11) return bookSlot('16:00');
      if (staffId === 12) return bookSlot('11:00');
      return [];
    });
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options.map(o => o.staff_yc_id)).toEqual([12, 11]);
  });

  test('hint требует перечислить всех и запрещает выбирать за пациента и называть цену', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) =>
      staffId === 13 ? [] : bookSlot('12:00'));
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.hint).toMatch(/staff_options/);
    expect(out.hint).toMatch(/НЕ выбирай|не выбирай сама/);
    expect(out.hint).toMatch(/[Цц]ену не называй/);
  });

  test('передан staff_yc_id → поведение прежнее (slots одного мастера, без staff_options)', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) =>
      staffId === 11 ? bookSlot('12:00') : []);
    const out = await slots.run(1, { ...ARGS, staff_yc_id: 11 }, { nowMs: NOON });
    expect(out.slots).toEqual(bookSlot('12:00'));
    expect(out.staff_options).toBeUndefined();
  });

  test('без date — прежняя ошибка', async () => {
    const out = await slots.run(1, { service_yc_id: 900 }, { nowMs: NOON });
    expect(out.error).toMatch(/date/);
  });

  test('без service_yc_id — прежняя ошибка про услугу', async () => {
    const out = await slots.run(1, { date: DATE }, { nowMs: NOON });
    expect(out.error).toMatch(/service_yc_id/);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd /root/loyalpro/backend && npx jest agent-slots-staff-options`
Expected: FAIL — сейчас без `staff_yc_id` инструмент возвращает `{ error: 'Нужны staff_yc_id и date (YYYY-MM-DD).' }`, поля `staff_options` нет.

- [ ] **Step 3: Схема — `staff_yc_id` необязателен**

В `backend/services/agent/tools/get-available-slots.js` заменить блок `schema`:

```js
const schema = {
  name: 'get_available_slots',
  description: 'Свободное время под КОНКРЕТНУЮ УСЛУГУ на дату. Если пациент назвал мастера — передай ' +
    'его staff_yc_id. Если НЕ называл — staff_yc_id не передавай: инструмент вернёт свободные окна ВСЕХ ' +
    'исполнителей услуги в staff_options, и выбор сделает пациент. Если у салона включена онлайн-запись — ' +
    'отдаёт слоты под услугу. Иначе считает свободность из графика (старты шагом 30 мин, куда услуга ' +
    'влезает целиком). Дата в формате YYYY-MM-DD. Само расписание (в какие дни работает) — get_available_dates.',
  input_schema: {
    type: 'object',
    properties: {
      staff_yc_id:   { type: 'integer', description: 'YClients-id мастера (из каталога услуг). НЕ передавай, если пациент специалиста не называл.' },
      service_yc_id: { type: 'integer', description: 'YClients-id услуги (из каталога услуг).' },
      date:          { type: 'string',  description: 'Дата YYYY-MM-DD.' },
    },
    required: ['service_yc_id', 'date'],
    additionalProperties: false,
  },
};
```

- [ ] **Step 4: Добавить константу и хинт**

Там же, рядом с `MAX_ALT_STAFF` (после строки `const MAX_ALT_STAFF = 3;`):

```js
// Столько исполнителей проверяем, когда мастера выбирает пациент. Кап тот же, что у
// альтернатив: каждый мастер — отдельный запрос в YClients. Следствие — там, где
// исполнителей больше, часть в выдачу не попадёт, поэтому хинт запрещает модели
// утверждать «это все специалисты».
const MAX_STAFF_OPTIONS = 3;

const HINT_STAFF_CHOICE = 'Пациент специалиста не называл — выбор за НИМ, а не за тобой. ' +
  'Перечисли в ОДНОМ сообщении ВСЕХ из staff_options: имя, должность (position) и 1–2 времени ' +
  'ДОСЛОВНО из его slots, и спроси, к кому удобнее записать. НЕ выбирай сама и никого не советуй ' +
  'как «лучшего». Цену не называй, пока пациент сам о ней не спросил. НЕ утверждай, что это все ' +
  'специалисты клиники: здесь только те, у кого в этот день есть свободное время.';
```

- [ ] **Step 5: Функция перебора мастеров**

Там же, сразу после `findAlternativeStaff` (перед `async function run`):

```js
// Пациент мастера не называл → окна считаем у ВСЕХ исполнителей услуги, а выбор
// отдаём пациенту. Раньше исполнителя выбирала сама модель (промпт это разрешал), и
// пациент молча получал одного специалиста — при том что цена зависит от мастера.
async function computeStaffOptions(salon, filter, staffList, serviceId, date, nowMs) {
  const candidates = (staffList || [])
    .filter(m => m && m.yc_id)
    .filter(m => svcFilter.isBookable(filter, serviceId, m.yc_id))
    .slice(0, MAX_STAFF_OPTIONS);
  const checked = await Promise.all(candidates.map(async (m) => {
    try {
      const r = await computeStaffSlots(salon, m.yc_id, serviceId, date, nowMs);
      return { staff_yc_id: m.yc_id, name: m.name, position: null, slots: r.slots || [] };
    } catch (_) { return null; }   // сбой по одному мастеру не валит весь ответ
  }));
  return checked
    .filter(Boolean)
    .filter(o => o.slots.length)
    // Ближайшее окно — первым. Порядок детерминированный: тай-брейк по yc_id.
    .sort((a, b) => (toMin(a.slots[0].time) - toMin(b.slots[0].time)) || (a.staff_yc_id - b.staff_yc_id));
}
```

- [ ] **Step 6: Ветка в `run` и общий загрузчик салона**

В том же файле заменить начало `run` — блок от `if (!staffId || !date)` до строки `const salon = await db.one(...)` включительно.

Было:

```js
  if (!staffId || !date) return { error: 'Нужны staff_yc_id и date (YYYY-MM-DD).' };
```

Стало (остальные строки блока не трогаем, кроме перечисленного ниже):

```js
  if (!date) return { error: 'Нужна date (YYYY-MM-DD).' };
```

Дальше существующая проверка `if (!serviceId) { ... }` остаётся без изменений. Сразу ПОСЛЕ неё вставить мультирежим:

```js
  // Мастер не назван — считаем окна у всех исполнителей услуги (выбор за пациентом).
  if (!staffId) {
    const filter = await settings.loadServiceFilterSafe(salonId);
    const chk = await staffGuard.checkStaffPerformsService(salonId, serviceId, 0);
    const salon = await db.one(`SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token FROM salons WHERE id=$1`, [salonId]);
    if (!salon || !salon.yclients_company_id) return { error: 'YClients не подключён для салона.' };
    const options = await computeStaffOptions(salon, filter, chk.staffList, serviceId, date, nowMs);
    return { staff_options: options, hint: HINT_STAFF_CHOICE };
  }
```

Остальной код `run` (ветка с `staffId`) не меняется.

- [ ] **Step 7: Прогнать тесты**

Run: `cd /root/loyalpro/backend && npx jest agent-slots-staff-options`
Expected: PASS, 7 тестов.

- [ ] **Step 8: Регресс соседних сьютов**

Run: `cd /root/loyalpro/backend && npx jest agent-slots-alternative-staff agent-slots-staff-check`
Expected: PASS — одномастерная ветка не тронута.

- [ ] **Step 9: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/tools/get-available-slots.js backend/agent-slots-staff-options.test.js
git commit -m "feat(agent): get_available_slots без staff_yc_id — окна всех исполнителей услуги"
```

---

### Task 2: Граничные случаи — пусто у всех, один исполнитель, каталог недоступен

**Files:**
- Modify: `backend/services/agent/tools/get-available-slots.js`
- Test: `backend/agent-slots-staff-options.test.js`

- [ ] **Step 1: Дописать падающие тесты**

Добавить в `backend/agent-slots-staff-options.test.js` новый `describe` в конец файла:

```js
describe('get_available_slots без staff_yc_id — граничные случаи', () => {
  test('окон нет ни у кого → no_staff_available:true и подсказка про другой день', async () => {
    ycGetBookTimes.mockResolvedValue([]);
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.no_staff_available).toBe(true);
    expect(out.staff_options).toEqual([]);
    expect(out.hint).toMatch(/другой день/);
  });

  test('услугу ведёт один специалист → выбора не устраиваем (hint об этом говорит)', async () => {
    listServices.run.mockResolvedValue({
      services: [{ yc_id: 900, title: 'Биоревитализация', staff: [{ yc_id: 11, name: 'Юлия' }] }],
    });
    ycGetBookTimes.mockImplementation(async (_salon, staffId) =>
      staffId === 11 ? bookSlot('12:00') : []);
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options.map(o => o.staff_yc_id)).toEqual([11]);
    expect(out.hint).toMatch(/один специалист/);
  });

  test('каталог недоступен → просим повторить с конкретным staff_yc_id, а не молчим', async () => {
    listServices.run.mockResolvedValue({ services: [] });
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.error).toMatch(/staff_yc_id/);
    expect(out.staff_options).toBeUndefined();
  });

  // Регресс-страховки: код Task 1 их уже покрывает, тесты фиксируют поведение.
  test('скрытая пара услуга+мастер в выбор не попадает', async () => {
    svcFilter.isBookable.mockImplementation((_f, _svc, staffId) => staffId !== 11);
    ycGetBookTimes.mockResolvedValue(bookSlot('12:00'));
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options.map(o => o.staff_yc_id)).not.toContain(11);
  });

  test('сбой YClients по одному мастеру не валит ответ', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) => {
      if (staffId === 11) throw new Error('502 YClients');
      if (staffId === 12) return bookSlot('15:00');
      return [];
    });
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options.map(o => o.staff_yc_id)).toEqual([12]);
  });
});
```

- [ ] **Step 2: Убедиться, что первые три теста падают**

Run: `cd /root/loyalpro/backend && npx jest agent-slots-staff-options`
Expected: FAIL — три первых теста нового describe (`no_staff_available` не выставляется, hint один на все случаи, при пустом каталоге возвращается пустой список вместо ошибки). Два последних (скрытая пара, сбой мастера) проходят сразу — это ожидаемо, они страхуют код Task 1.

- [ ] **Step 3: Дописать хинты**

В `backend/services/agent/tools/get-available-slots.js` после `HINT_STAFF_CHOICE` добавить:

```js
const HINT_STAFF_SINGLE = 'Эту услугу в этот день ведёт один специалист — выбора не устраивай: ' +
  'назови его имя, должность (position) и 1–2 времени ДОСЛОВНО из slots и предложи записать.';

const HINT_NO_STAFF = 'На эту дату свободного времени нет ни у одного исполнителя услуги — ' +
  'честно скажи об этом и предложи другой день (get_available_slots на другую дату).';
```

- [ ] **Step 4: Обработать три случая в ветке `run`**

Заменить вставленный в Task 1 блок мультирежима на:

```js
  // Мастер не назван — считаем окна у всех исполнителей услуги (выбор за пациентом).
  if (!staffId) {
    const filter = await settings.loadServiceFilterSafe(salonId);
    const chk = await staffGuard.checkStaffPerformsService(salonId, serviceId, 0);
    // Каталог не отдал исполнителей (fail-open предпроверки) — перебирать некого.
    // Не молчим: просим модель повторить вызов с конкретным мастером.
    if (!chk.staffList || !chk.staffList.length) {
      return { error: 'Не удалось получить список исполнителей услуги. Вызови get_available_slots ещё раз, ' +
        'указав конкретный staff_yc_id (id мастера — в колонке мастеров строки услуги в каталоге).' };
    }
    const salon = await db.one(`SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token FROM salons WHERE id=$1`, [salonId]);
    if (!salon || !salon.yclients_company_id) return { error: 'YClients не подключён для салона.' };
    const options = await computeStaffOptions(salon, filter, chk.staffList, serviceId, date, nowMs);
    if (!options.length) return { staff_options: [], no_staff_available: true, hint: HINT_NO_STAFF };
    return { staff_options: options, hint: options.length > 1 ? HINT_STAFF_CHOICE : HINT_STAFF_SINGLE };
  }
```

- [ ] **Step 5: Прогнать тесты**

Run: `cd /root/loyalpro/backend && npx jest agent-slots-staff-options`
Expected: PASS, 12 тестов.

- [ ] **Step 6: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/tools/get-available-slots.js backend/agent-slots-staff-options.test.js
git commit -m "feat(agent): выбор мастера — пусто у всех, один исполнитель, недоступный каталог"
```

---

### Task 3: Должность специалиста в `staff_options`

Без должности модель либо промолчит о ней, либо придумает: в каталоге промпта должностей нет, они живут в `staff_members.specialization` (то же поле отдаёт `list_staff`).

**Files:**
- Modify: `backend/services/agent/tools/get-available-slots.js`
- Test: `backend/agent-slots-staff-options.test.js`

- [ ] **Step 1: Написать падающие тесты**

Добавить в конец `backend/agent-slots-staff-options.test.js`:

```js
const { db } = require('./db');

describe('get_available_slots без staff_yc_id — должность специалиста', () => {
  test('position подставляется из staff_members', async () => {
    db.any.mockResolvedValue([
      { yclients_staff_id: 11, specialization: 'косметолог-эстетист' },
      { yclients_staff_id: 12, specialization: 'главный врач' },
    ]);
    ycGetBookTimes.mockImplementation(async (_salon, staffId) => (staffId === 13 ? [] : bookSlot('12:00')));
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options.map(o => o.position)).toEqual(['косметолог-эстетист', 'главный врач']);
  });

  test('должности в базе нет → position остаётся null, ответ не ломается', async () => {
    db.any.mockResolvedValue([{ yclients_staff_id: 11, specialization: null }]);
    ycGetBookTimes.mockImplementation(async (_salon, staffId) => (staffId === 11 ? bookSlot('12:00') : []));
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options[0].position).toBeNull();
  });

  test('сбой БД при чтении должностей не валит выдачу слотов', async () => {
    db.any.mockRejectedValue(new Error('db down'));
    ycGetBookTimes.mockImplementation(async (_salon, staffId) => (staffId === 11 ? bookSlot('12:00') : []));
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options.map(o => o.staff_yc_id)).toEqual([11]);
    expect(out.staff_options[0].position).toBeNull();
  });
});
```

В `beforeEach` этого файла (в самом верху, где уже есть `jest.clearAllMocks()`) добавить строку после `svcFilter.isBookable.mockReturnValue(true);`:

```js
  db.any.mockResolvedValue([]);
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd /root/loyalpro/backend && npx jest agent-slots-staff-options -t "должность"`
Expected: FAIL первого теста — `position` всегда `null`, `db.any` никто не зовёт.

- [ ] **Step 3: Реализовать подстановку должностей**

В `backend/services/agent/tools/get-available-slots.js` после `computeStaffOptions` добавить:

```js
// Должность — из карточки сотрудника (то же поле, что отдаёт list_staff). Мутируем
// на месте: строго best-effort, сбой БД оставляет position=null, слоты не страдают.
async function attachPositions(salonId, options) {
  if (!options.length) return;
  try {
    const rows = await db.any(
      `SELECT yclients_staff_id, specialization
         FROM staff_members
        WHERE salon_id = $1 AND yclients_staff_id = ANY($2::int[])`,
      [salonId, options.map(o => Number(o.staff_yc_id))]);
    const byId = new Map((rows || []).map(r => [Number(r.yclients_staff_id), r.specialization || null]));
    for (const o of options) o.position = byId.get(Number(o.staff_yc_id)) || null;
  } catch (_) { /* без должности реплика просто короче */ }
}
```

И в ветке мультирежима в `run` вызвать её перед возвратом — заменить

```js
    if (!options.length) return { staff_options: [], no_staff_available: true, hint: HINT_NO_STAFF };
    return { staff_options: options, hint: options.length > 1 ? HINT_STAFF_CHOICE : HINT_STAFF_SINGLE };
```

на

```js
    if (!options.length) return { staff_options: [], no_staff_available: true, hint: HINT_NO_STAFF };
    await attachPositions(salonId, options);
    return { staff_options: options, hint: options.length > 1 ? HINT_STAFF_CHOICE : HINT_STAFF_SINGLE };
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd /root/loyalpro/backend && npx jest agent-slots-staff-options`
Expected: PASS, 15 тестов.

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/tools/get-available-slots.js backend/agent-slots-staff-options.test.js
git commit -m "feat(agent): должность специалиста в staff_options (staff_members.specialization)"
```

---

### Task 4: Память между ходами понимает мультирежим

Экстрактор `get_available_slots` в `tool-memory.js` читает `res.slots`. В мультирежиме его нет — журнал написал бы модели «свободного времени не было» и «staff_yc_id=undefined», хотя времена пациенту показывались.

**Files:**
- Modify: `backend/services/agent/tool-memory.js:183-194`
- Test: `backend/agent-tool-memory.test.js`

- [ ] **Step 1: Написать падающий тест**

Добавить в `backend/agent-tool-memory.test.js` (в конец файла, отдельным `describe`):

Файл уже импортирует `renderMemory` и `SLOT_TIMES_FRESH_MS`, события строит хелпером `ev({...})` (возраст задаётся полем `age_ms`), а `renderMemory(rows, { nowMs: NOW })` возвращает объект с массивом `lines` — используем те же соглашения:

```js
describe('память: get_available_slots без мастера (выбор специалиста)', () => {
  const OPTIONS = {
    staff_options: [
      { staff_yc_id: 11, name: 'Юлия', position: 'косметолог-эстетист', slots: [{ time: '12:00' }, { time: '14:00' }] },
      { staff_yc_id: 12, name: 'Пери Исамудиновна', position: 'главный врач', slots: [{ time: '15:00' }] },
    ],
  };
  const INPUT = { service_yc_id: 900, date: '2026-08-02' };   // staff_yc_id не передавался

  test('времена всех показанных мастеров попадают в выжимку', () => {
    const { lines } = renderMemory(
      [ev({ tool: 'get_available_slots', input: INPUT, result: OPTIONS, age_ms: 10 * MIN })],
      { nowMs: NOW });
    expect(lines[0]).toMatch(/Юлия/);
    expect(lines[0]).toMatch(/12:00, 14:00/);
    expect(lines[0]).toMatch(/Пери Исамудиновна/);
    expect(lines[0]).toMatch(/15:00/);
    expect(lines[0]).not.toMatch(/свободного времени не было/);
    expect(lines[0]).not.toMatch(/undefined/);
  });

  test('устаревшее событие времён не показывает', () => {
    const { lines } = renderMemory(
      [ev({ tool: 'get_available_slots', input: INPUT, result: OPTIONS, age_ms: SLOT_TIMES_FRESH_MS + MIN })],
      { nowMs: NOW });
    expect(lines[0]).not.toMatch(/12:00|15:00/);
    expect(lines[0]).toMatch(/перезапроси/);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd /root/loyalpro/backend && npx jest agent-tool-memory -t "выбор специалиста"`
Expected: FAIL — в выжимке «свободного времени не было», времён нет.

- [ ] **Step 3: Научить экстрактор мультирежиму**

В `backend/services/agent/tool-memory.js` заменить тело `get_available_slots` на:

```js
  get_available_slots(e, ctx) {
    const inp = e.input || {}, res = e.result || {};
    // Мастера могло не быть в запросе: пациент его не называл, и инструмент вернул
    // окна всех исполнителей (staff_options) — тогда в памяти нужны имена, а не id.
    const who = inp.staff_yc_id ? `staff_yc_id=${inp.staff_yc_id}` : 'у всех исполнителей';
    const base = `смотрела слоты service_yc_id=${inp.service_yc_id} ${who} на ${inp.date}`;
    if (!ctx.fresh) return `${base} (выдача устарела — при вопросе о времени перезапроси)`;
    if (Array.isArray(res.staff_options)) {
      const per = res.staff_options.slice(0, 3).map((o) => {
        const times = (Array.isArray(o.slots) ? o.slots : []).slice(0, 6).map(s => s && s.time).filter(Boolean);
        return `${o.name}: ${times.join(', ')}`;
      });
      if (!per.length) return `${base}: свободного времени не было ни у кого`;
      return `${base}: показаны ${per.join('; ')}`;
    }
    const slots = Array.isArray(res.slots) ? res.slots : [];
    if (!slots.length) {
      return `${base}: свободного времени не было${res.alternative_staff ? ', предлагала альтернативных мастеров' : ''}`;
    }
    const times = slots.slice(0, 12).map(s => s && s.time).filter(Boolean);
    return `${base}: показаны ${times.join(', ')}${slots.length > 12 ? '…' : ''}`;
  },
```

- [ ] **Step 4: Прогнать тесты памяти**

Run: `cd /root/loyalpro/backend && npx jest agent-tool-memory agent-tool-events`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/tool-memory.js backend/agent-tool-memory.test.js
git commit -m "fix(agent): память понимает выдачу слотов без мастера (staff_options)"
```

---

### Task 5: Промпт — правило «ВЫБОР СПЕЦИАЛИСТА ДЕЛАЕТ ПАЦИЕНТ»

**Files:**
- Modify: `backend/services/agent/system-prompt.js` (Шаг 2 и Шаг 4 Сценария 2, новое правило перед «АЛЬТЕРНАТИВНЫЙ СПЕЦИАЛИСТ», строка про «Любой специалист»)
- Test: `backend/agent-system-prompt.test.js`

- [ ] **Step 1: Написать падающие тесты промпта**

Добавить в `backend/agent-system-prompt.test.js` новый `describe` рядом с блоком про `АЛЬТЕРНАТИВНЫЙ СПЕЦИАЛИСТ` (около строки 972):

```js
describe('выбор специалиста делает пациент', () => {
  const p = buildSystemPrompt({});

  test('правило есть и опирается на staff_options', () => {
    expect(p).toMatch(/ВЫБОР СПЕЦИАЛИСТА ДЕЛАЕТ ПАЦИЕНТ/);
    expect(p).toMatch(/staff_options[\s\S]{0,600}к кому удобнее/);
  });

  test('мастера не назвали → зови инструмент БЕЗ staff_yc_id', () => {
    expect(p).toMatch(/БЕЗ staff_yc_id/);
  });

  test('в момент выбора цену не называем', () => {
    expect(p).toMatch(/[Цц]ену[^.]{0,80}не называй/);
  });

  test('пусто у всех — только при no_staff_available:true', () => {
    expect(p).toMatch(/no_staff_available:true/);
  });

  test('«любой специалист» — только по словам пациента', () => {
    expect(p).toMatch(/САМ сказал[^.]{0,80}любой специалист/);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd /root/loyalpro/backend && npx jest agent-system-prompt -t "выбор специалиста"`
Expected: FAIL — таких строк в промпте нет.

- [ ] **Step 3: Переписать Шаг 2**

В `backend/services/agent/system-prompt.js` заменить строку

```js
    `Шаг 2. Определи специалиста (по желанию пациента или из тех, кто выполняет выбранную услугу в list_services).`,
```

на

```js
    `Шаг 2. Определи специалиста. Пациент назвал мастера — работаем с ним (см. проверку ниже). Пациент врача НЕ называл — НЕ выбирай его за пациента и не бери «кого-нибудь»: вызови get_available_slots БЕЗ staff_yc_id (только услуга и дата), инструмент вернёт свободные окна всех исполнителей услуги в staff_options.`,
```

- [ ] **Step 4: Переписать Шаг 4**

Заменить строку

```js
    `Шаг 4. ОБЯЗАТЕЛЬНО вызови get_available_slots для выбранной услуги и специалиста на нужную дату. Никогда не называй время «на глаз».`,
```

на

```js
    `Шаг 4. ОБЯЗАТЕЛЬНО вызови get_available_slots для выбранной услуги на нужную дату: со staff_yc_id, если специалист выбран, и БЕЗ staff_yc_id, если пациент его не называл. Никогда не называй время «на глаз».`,
```

- [ ] **Step 5: Добавить правило**

Вставить новую строку НЕПОСРЕДСТВЕННО перед строкой, начинающейся с `` `АЛЬТЕРНАТИВНЫЙ СПЕЦИАЛИСТ (ГЛАВНАЯ ЦЕЛЬ ``:

```js
    `ВЫБОР СПЕЦИАЛИСТА ДЕЛАЕТ ПАЦИЕНТ. Если в ответе get_available_slots есть staff_options — эту услугу в выбранный день ведут несколько специалистов, и у каждого есть реальные свободные окна. В ОДНОМ сообщении перечисли ВСЕХ из staff_options: имя, должность (поле position) и 1–2 времени ДОСЛОВНО из его slots, и спроси, к кому удобнее записать (например: «В четверг эту процедуру проводят Юлия, косметолог-эстетист — 12:00 и 14:00, и Пери Исамудиновна, главный врач — 15:00. К кому вам удобнее записать?»). Специалиста за пациента НЕ выбирай и никого не советуй как «лучшего» или «опытнее». Цену при этом не называй — только если пациент сам о ней спросит. НЕ утверждай, что это все специалисты клиники: в staff_options только те, у кого в этот день есть свободное время. Должность каждого назови ОДИН раз (правило «ДОЛЖНОСТЬ НАЗЫВАЙ ОДИН РАЗ»), дальше — только имя. Если в staff_options один специалист — выбора не устраивай: назови его имя, должность и время. Если пациент САМ сказал «любой специалист» / «мне без разницы» — не переспрашивай, бери из staff_options того, у кого ближайшее свободное окно. Если вернулось no_staff_available:true — на эту дату свободного времени нет ни у кого из исполнителей: честно скажи об этом и предложи другой день.`,
```

- [ ] **Step 6: Сузить строку «Любой специалист»**

В строке про id мастера заменить фрагмент

```
«Любой специалист» — сама выбери любого мастера из поля staff нужной услуги (кто свободен), не спрашивая пациента и не выдумывая id.
```

на

```
Если пациент САМ сказал «любой специалист» / «мне без разницы» — бери того, у кого ближайшее свободное окно (id — из поля staff нужной услуги, не выдумывай числа). Если пациент про мастера НЕ говорил — выбирать за него нельзя, см. правило «ВЫБОР СПЕЦИАЛИСТА ДЕЛАЕТ ПАЦИЕНТ».
```

- [ ] **Step 7: Прогнать тесты промпта**

Run: `cd /root/loyalpro/backend && npx jest agent-system-prompt`
Expected: PASS весь сьют (правило про `АЛЬТЕРНАТИВНЫЙ СПЕЦИАЛИСТ` не тронуто).

- [ ] **Step 8: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/system-prompt.js backend/agent-system-prompt.test.js
git commit -m "feat(agent): промпт — выбор специалиста делает пациент, а не модель"
```

---

### Task 6: Документация и полная проверка

**Files:**
- Modify: `CLAUDE.md` (раздел «AI-агент: управление и гейт допуска», рядом с абзацем про альтернативного специалиста)

- [ ] **Step 1: Записать поведение в CLAUDE.md**

Добавить абзац сразу после абзаца «Альтернативный специалист при пустых слотах…»:

```markdown
- Выбор специалиста делает ПАЦИЕНТ, а не модель: если врач не назван, `get_available_slots` зовётся БЕЗ `staff_yc_id` и возвращает `staff_options:[{staff_yc_id,name,position,slots}]` (до 3 исполнителей, скрытые пары `service-filter` отсеяны, порядок — по времени первого окна, тай-брейк по yc_id) + `hint`; пусто у всех → `no_staff_available:true`. Должность берётся из `staff_members.specialization` (best-effort: сбой БД оставляет `position:null`). Промпт-правило «ВЫБОР СПЕЦИАЛИСТА ДЕЛАЕТ ПАЦИЕНТ» требует перечислить всех имя+должность+1–2 времени и спросить «к кому удобнее», цену в этот момент не называть и не утверждать, что это все специалисты клиники. ЗАЧЕМ: раньше промпт разрешал модели взять исполнителя самой, и пациент молча получал одного мастера — при том что цена зависит от мастера (у главного врача выше). Строка «Любой специалист — сама выбери любого» теперь срабатывает, только когда пациент САМ так сказал. Экстрактор памяти (`tool-memory.js`) знает мультирежим: без него журнал писал бы «свободного времени не было» на ходе, где пациенту показали времена. Тесты — `agent-slots-staff-options.test.js`.
```

- [ ] **Step 2: Полный прогон тестов**

Run: `cd /root/loyalpro/backend && npx jest --testPathIgnorePatterns primary-clients 2>&1 | tail -20`
Expected: все сьюты зелёные. (`primary-clients.test.js` исключён намеренно: он зовёт `process.exit(1)` и роняет соседний сьют — известная особенность, не регресс этой задачи.)

- [ ] **Step 3: Коммит**

```bash
cd /root/loyalpro && git add CLAUDE.md
git commit -m "docs(agent): выбор специалиста делает пациент — заметка в CLAUDE.md"
```

- [ ] **Step 4: Живой прогон на тестовом номере**

1. Перезапустить дев: `PORT=3001 pm2 restart loyalpro --update-env` (в шелле `PORT=8080` занят — без явного PORT будет краш-луп).
2. Очистить историю тестового номера: `/clear-history` (по умолчанию 79200255591).
3. Написать боту: «Хочу биоревитализацию на завтра» — без имени врача.

Ожидаемо: в ответе несколько специалистов с должностями и временами и вопрос «к кому удобнее записать?», цены нет. Проверить лог: `pm2 logs loyalpro --lines 50 | grep get_available_slots` — в аргументах вызова НЕ должно быть `staff_yc_id`.

Если модель всё равно подставляет `staff_yc_id` — усилить формулировку Шага 2, а не менять код инструмента.
