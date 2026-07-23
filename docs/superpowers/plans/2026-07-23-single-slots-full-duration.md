# get_available_slots: полная длительность услуги в fallback-режиме — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Одиночный `get_available_slots` в fallback-режиме (по management-графику) предлагает только те старты, куда услуга помещается **целиком**, а не первые 30 минут — как уже делает `get_parallel_slots`.

**Architecture:** Расширяем чистый хелпер `rangesToSlots` параметром `durationMin` (обратная совместимость: без параметра — прежнее поведение «влезает один шаг»). В `run()` поднимаем загрузку `eqCtx` и берём длительность услуги из меты (`eqContext.durationMin`), с дефолтом 60 мин — тем же, что у `get_parallel_slots` (`DEFAULT_DURATION_MIN`). Заодно кладём `seance_length` в fallback-слоты (параллельный инструмент уже так отдаёт; это же защита от 422 при create_booking). Без `service_yc_id` поведение не меняется — длительность знать неоткуда.

**Tech Stack:** Node.js (без ORM), Jest. Чистые хелперы экспортируются из модуля инструмента и тестируются в `backend/get-available-slots.test.js` (паттерн репо — тестируем чистую логику, `run()` остаётся тонкой обвязкой).

**Контекст для исполнителя (важно):**
- Файл инструмента: `backend/services/agent/tools/get-available-slots.js`. Сейчас `rangesToSlots(ranges, date, step)` пускает старт, если `t + step <= r.end` (строка ~84) — 60-минутная услуга может быть предложена в окно-хвост на 30 минут, и создание записи упрётся в занятое кресло мастера.
- Эталон: `backend/services/agent/tools/get-parallel-slots.js` — `fitsIn(e.ranges, t, e.durationMin)` с `durationMin = eqContext.durationMin(eqCtx, id) || DEFAULT_DURATION_MIN (60)`.
- `eqContext.durationMin(ctx, ycServiceId)` (`backend/services/agent/equipment-context.js:51`) возвращает минуты, **0 = неизвестна**.
- Интервалы — минуты от полуночи, конец эксклюзивный `[start, end)`. Старты — на чистой сетке, кратной `step` от полуночи (`:00`/`:30`), это поведение менять нельзя (тесты «привязка к чистой сетке»).
- Booking-режим (`ycGetBookTimes`, `source:'booking'`) не трогаем — там слоты и `seance_length` отдаёт YClients.
- Прогон тестов: `cd /root/loyalpro/backend && npx jest get-available-slots.test.js`.

---

### Task 1: `rangesToSlots` учитывает длительность услуги

**Files:**
- Modify: `backend/services/agent/tools/get-available-slots.js` (функция `rangesToSlots`, ~строки 80–90)
- Test: `backend/get-available-slots.test.js`

- [ ] **Step 1: Написать падающие тесты**

Добавить в `backend/get-available-slots.test.js` новый `describe` рядом с существующим `describe('rangesToSlots — привязка к чистой сетке', ...)`:

```js
describe('rangesToSlots — полная длительность услуги', () => {
  // Интервалы в минутах от полуночи: 19:00–20:00 = {start: 1140, end: 1200}.
  const win = [{ start: 1140, end: 1200 }];

  test('60-минутная услуга в часовом окне — только 19:00', () => {
    const slots = rangesToSlots(win, '2026-07-24', 30, 60);
    expect(slots.map(s => s.time)).toEqual(['19:00']);
  });

  test('30-минутная услуга — 19:00 и 19:30, как раньше', () => {
    const slots = rangesToSlots(win, '2026-07-24', 30, 30);
    expect(slots.map(s => s.time)).toEqual(['19:00', '19:30']);
  });

  test('45 минут — старт 19:30 отпадает (19:30+45 > 20:00), остаётся 19:00', () => {
    const slots = rangesToSlots(win, '2026-07-24', 30, 45);
    expect(slots.map(s => s.time)).toEqual(['19:00']);
  });

  test('услуга длиннее окна — слотов нет', () => {
    const slots = rangesToSlots(win, '2026-07-24', 30, 90);
    expect(slots).toEqual([]);
  });

  test('длительность неизвестна (0/не передана) — прежнее поведение по шагу', () => {
    expect(rangesToSlots(win, '2026-07-24', 30, 0).map(s => s.time))
      .toEqual(['19:00', '19:30']);
    expect(rangesToSlots(win, '2026-07-24', 30).map(s => s.time))
      .toEqual(['19:00', '19:30']);
  });

  test('длительность не ломает привязку к чистой сетке (окно 18:05–20:00, 60 мин)', () => {
    const slots = rangesToSlots([{ start: 1085, end: 1200 }], '2026-07-24', 30, 60);
    expect(slots.map(s => s.time)).toEqual(['18:30', '19:00']);
  });
});
```

- [ ] **Step 2: Прогнать — убедиться, что падают**

Run: `cd /root/loyalpro/backend && npx jest get-available-slots.test.js`
Expected: FAIL — новые тесты с длительностью (60/45/90) падают: текущая сигнатура игнорирует 4-й аргумент и отдаёт лишние старты.

- [ ] **Step 3: Минимальная реализация**

В `backend/services/agent/tools/get-available-slots.js` заменить `rangesToSlots`:

```js
// Из интервалов — старты с шагом step, куда услуга влезает ЦЕЛИКОМ (durationMin);
// если длительность неизвестна (0/не передана) — по-прежнему хотя бы один шаг.
// Старт привязываем к ЧИСТОЙ сетке (кратной step от полуночи → :00/:30), а НЕ к
// r.start. Иначе окно, начатое в 19:05 (хвост от предыдущей записи чужой длительности),
// тянуло смещение через все старты: 19:05, 19:35, 20:05 — и прятало свободные 19:00/20:00.
function rangesToSlots(ranges, date, step, durationMin) {
  const need = durationMin > 0 ? durationMin : step;
  const slots = [];
  for (const r of ranges) {
    const first = Math.ceil(r.start / step) * step;   // ближайший чистый старт ≥ r.start
    for (let t = first; t + need <= r.end; t += step) {
      const hhmm = toHHMM(t);
      slots.push({ time: hhmm, datetime: `${date}T${hhmm}:00+03:00` });
    }
  }
  return slots;
}
```

- [ ] **Step 4: Прогнать — тесты зелёные**

Run: `cd /root/loyalpro/backend && npx jest get-available-slots.test.js`
Expected: PASS — все, включая старые тесты «привязка к чистой сетке» (обратная совместимость: 3-аргументные вызовы работают как раньше).

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro
git add backend/services/agent/tools/get-available-slots.js backend/get-available-slots.test.js
git commit -m "feat(agent): rangesToSlots проверяет полную длительность услуги"
```

---

### Task 2: `run()` передаёт длительность из меты услуги + `seance_length` в слотах

**Files:**
- Modify: `backend/services/agent/tools/get-available-slots.js` (константы вверху и блок fallback в `run()`, ~строки 11 и 129–150)

- [ ] **Step 1: Константа дефолтной длительности (та же, что в параллельном инструменте)**

Рядом с `DEFAULT_STEP_MIN` вверху файла:

```js
const DEFAULT_STEP_MIN = 30;       // шаг предлагаемых стартов в fallback-режиме
const DEFAULT_DURATION_MIN = 60;   // если YClients не отдал duration услуги (как в get_parallel_slots)
```

- [ ] **Step 2: Поднять eqCtx и вычислить длительность**

В `run()` заменить fallback-блок (сейчас `eqCtx` — локальная константа внутри `if (serviceId)`):

```js
    // 2) Иначе (или пусто) — свободность из графика (management API, без онлайн-записи).
    // Этот график знает только занятость кресла мастера и слеп к аппаратам,
    // поэтому вычитаем время, когда занято оборудование услуги: иначе предложим
    // окно, на котором создание записи упрётся в save_if_busy:false.
    const seances = await ycGetStaffSeances(salon, staffId, date);
    let ranges = seancesToRanges(seances);
    let equipmentBusy = false;
    // Длительность услуги: старт годится, только если услуга влезает целиком до
    // конца окна мастера (как в get_parallel_slots). Без service_yc_id длительность
    // знать неоткуда — остаётся прежняя проверка «хотя бы один шаг».
    let svcDurationMin = 0;
    if (serviceId) {
      const eqCtx = await eqContext.loadEquipmentContext(salon, date);
      svcDurationMin = eqContext.durationMin(eqCtx, serviceId) || DEFAULT_DURATION_MIN;
      const busy = eqContext.busyForService(eqCtx, serviceId);
      if (busy.length) {
        const trimmed = eq.subtractRanges(ranges, busy);
        equipmentBusy = trimmed.length !== ranges.length
          || trimmed.some((r, i) => !ranges[i] || r.start !== ranges[i].start || r.end !== ranges[i].end);
        ranges = trimmed;
      }
    }
    const freeRanges = ranges.map(r => ({ from: toHHMM(r.start), to: toHHMM(r.end) }));
    let slots = rangesToSlots(ranges, date, DEFAULT_STEP_MIN, svcDurationMin);
    // seance_length — как у get_parallel_slots: create_booking без него ловил 422
    // на салонах с выключенной онлайн-записью.
    if (svcDurationMin) {
      slots = slots.map(s => ({ ...s, seance_length: svcDurationMin * 60 }));
    }
    const out = { slots, free_ranges: freeRanges, source: 'schedule' };
```

Остальное в `run()` (в т.ч. `if (equipmentBusy) out.equipment_busy = true;` и `dropPastToday`) — без изменений. `free_ranges` считаем ДО фильтра длительности намеренно: это «сырые» окна кресла для ответа пациенту, слоты — уже с гарантией вместимости.

- [ ] **Step 3: Полный прогон тестов инструмента и промпта**

Run: `cd /root/loyalpro/backend && npx jest get-available-slots.test.js agent-system-prompt.test.js equipment.test.js`
Expected: PASS, без регрессов.

- [ ] **Step 4: Commit**

```bash
cd /root/loyalpro
git add backend/services/agent/tools/get-available-slots.js
git commit -m "fix(agent): fallback-слоты только там, куда услуга влезает целиком

get_available_slots по графику предлагал старт, если свободны первые 30
минут, — 60-минутная услуга попадала в хвост окна и упиралась в занятое
кресло на create_booking. Теперь длительность берётся из меты услуги
(дефолт 60 мин — как в get_parallel_slots), в слоты добавлен
seance_length. Без service_yc_id поведение прежнее."
```

---

### Task 3: Живая проверка на dev

- [ ] **Step 1: Перезапустить dev-сервер**

Run: `pm2 restart loyalpro --update-env && sleep 3 && pm2 ls | grep loyalpro`
Expected: `loyalpro … online`.

- [ ] **Step 2: Сверить слоты до конца дня**

Прогнать инструмент напрямую (салон 1, мастер лазерной эпиляции из `list_services`, услуга «Ноги полностью» yc_id 9536746, дата — завтра):

```bash
cd /root/loyalpro/backend && node -e "
require('dotenv').config();
const t = require('./services/agent/tools/get-available-slots');
(async () => {
  const d = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const r = await t.run(1, { staff_yc_id: 1914276, service_yc_id: 9536746, date: d });
  console.log(JSON.stringify(r, null, 2).slice(0, 2000));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
"
```

(1914276 — Гатауллина Юлия; запасной мастер той же услуги — Богатырева Татьяна, 3356928. Если оба недоступны — взять любой yc_id из поля `staff` услуги 9536746 в `list_services`.)

Expected: `source:'schedule'`, у каждого слота есть `seance_length`, последний слот заканчивается не позже конца окна мастера (`free_ranges`): `toMin(последний slot.time) + seance_length/60 <= toMin(последний range.to)`.

- [ ] **Step 3: Push**

```bash
cd /root/loyalpro && git push origin main
```
