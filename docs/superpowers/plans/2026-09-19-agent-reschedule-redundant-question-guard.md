# Reschedule Redundant-Question Guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two code-level gaps found in the prod incident `79096664042` (2026-09-19): Мила asked "на какую процедуру вас записать?" despite the patient having exactly one active booking and having clearly asked to reschedule it, and — even after the patient answered — the slot search that followed used a *different* service than the one actually attached to the booking being rescheduled.

**Architecture:** Two independent, code-only guards, both following patterns already established in this codebase (no new prompt rules, per the CLAUDE.md moratorium):
- **Part A** hardens `reschedule_booking` so slots found under the wrong `service_yc_id` can never be used to move a booking — a pure data-correctness check, reusing the existing `slot-evidence.js` mechanism that already guards `unverified_slot`/`needs_confirmation`.
- **Part B** adds a `reply-guard.js` check (same mechanism as `unbacked_unavailability`/`rejected_repeat`) that detects the exact redundant-question pattern and forces one corrective rewrite, using facts already sitting in the "АКТУАЛЬНЫЕ ЗАПИСИ ПАЦИЕНТА" prompt block.

**Tech Stack:** Node.js, Jest (`npx jest <file>` from `backend/`), existing `services/agent/*` modules.

---

## Investigation summary (context for the engineer)

Prod dialog `79096664042` (Гаджиева Пери, record `1981003965`, service «Миотокс 1ед», id `15394061`, 30-min slot grid):

1. Patient (replying to a same-day visit reminder): *«Завтра, к сожалению, не смогу. Перенесите, пожалуйста, на пятницу»* — an unambiguous single-booking reschedule request.
2. Мила's first-ever reply in this dialog: *«…Уточните, пожалуйста, на какую процедуру вас записать в пятницу?»* — no tool call this turn (confirmed via `agent_tool_events`: zero rows for this turn). The system prompt's own "АКТУАЛЬНЫЕ ЗАПИСИ ПАЦИЕНТА" block already contained the one live booking with its service, staff and `record_id`. Сценарий 3 Шаг 2 in `system-prompt.js:449` literally says *«Если запись одна — не переспрашивай»*. The model ignored both.
3. Patient answered *«Коррекция ботулинотерапии»*. Мила then called `get_available_slots` with `service_yc_id=9536676` — **not** `15394061`, the service actually on the record. It happened to have the same 30-minute grid, so `reschedule_booking(record_id, datetime)` (which always keeps `rec.seance_length`/`rec.services`, ignoring what the slot search used) succeeded without error. Had the durations differed, this would have produced the exact "slot found under the wrong service" failure class documented for `create_booking` (incident 2026-07-31) — a failed reschedule surfacing as a normal error, not silent corruption, but still a wasted round trip and unnecessary escalation risk.

Both defects are pure LLM-adherence failures the prompt cannot reliably prevent (per CLAUDE.md's moratorium on new prompt rules — this exact rule already existed and was ignored). Both close deterministically:
- Part A never lets a slot found for the wrong service actually move the booking — completely independent of chat wording.
- Part B catches the exact narrow text pattern (one booking + patient said "перенес…" + reply asks "на какую процедуру") and forces one corrective rewrite before the reply ever reaches the patient.

---

## File Structure

- Modify: `backend/services/agent/slot-evidence.js` — track `service` per evidence entry, extend `has()`, add `wrongServiceHint`.
- Modify: `backend/services/agent/booking-modify.js` — `rescheduleBookingRecord` gains a service-consistency check right after it fetches the record (no extra YClients call).
- Modify: `backend/services/agent/tools/reschedule-booking.js` — thread `ctx.slotEvidence` through, surface the new `wrong_service` hint.
- Modify: `backend/services/agent/orchestrator.js` — `isWriteHint()` recognizes `wrong_service`; lint loop gets a new check wired in.
- Modify: `backend/services/agent/reply-guard.js` — new `checkRedundantProcedureQuestion` + regexes + `HARD_TYPES` entry.
- Modify: `backend/services/agent/system-prompt.js` — Сценарий 3 Шаг 5 mentions `wrong_service`; `PROMPT_RULE_MARKERS` extended.
- Modify: `backend/agent-slot-evidence.test.js`, `backend/agent-booking-modify.test.js`, `backend/agent-reschedule-booking.test.js`, `backend/agent-reply-guard.test.js`, `backend/agent-orchestrator.test.js`.
- Modify: `CLAUDE.md` — one new bullet under the existing "Перенос записи под гейтами кода" section.

---

## Part A — anchor reschedule slots to the record's real service

### Task A1: `slot-evidence.js` tracks service per entry and exposes it in `has()`

**Files:**
- Modify: `backend/services/agent/slot-evidence.js:42-146` (and exports at `:190-193`)
- Test: `backend/agent-slot-evidence.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `backend/agent-slot-evidence.test.js`, inside the existing `describe('createSlotEvidence.add / has', ...)` block (after the `alternative_staff / staff_options` test, before `get_sequential_slots`):

```javascript
  test('service_yc_id сверяется, когда обе стороны его знают', () => {
    const ev = createSlotEvidence();
    ev.add('get_available_slots', { staff_yc_id: 3356928, service_yc_id: 15394061, date: '2026-09-25' },
      { slots: [slot('16:30', '2026-09-25')] });
    expect(ev.has('2026-09-25T16:30:00+03:00', { staffYcId: 3356928, serviceYcIds: [15394061] })).toBe(true);
    expect(ev.has('2026-09-25T16:30:00+03:00', { staffYcId: 3356928, serviceYcIds: [9536676] })).toBe(false);
    // Мастер известен, услуга не проверяется (пустой список) — прежнее поведение.
    expect(ev.has('2026-09-25T16:30:00+03:00', { staffYcId: 3356928 })).toBe(true);
  });

  test('evidence без service (старые/журнальные записи) — fail-open по услуге', () => {
    const ev = createSlotEvidence();
    ev.add('get_available_slots', { staff_yc_id: 3356928, date: '2026-09-25' },
      { slots: [slot('16:30', '2026-09-25')] });
    expect(ev.has('2026-09-25T16:30:00+03:00', { staffYcId: 3356928, serviceYcIds: [15394061] })).toBe(true);
  });

  test('alternative_staff/staff_options наследуют service_yc_id вызова', () => {
    const ev = createSlotEvidence();
    ev.add('get_available_slots', { staff_yc_id: 1, service_yc_id: 15394061, date: '2026-09-22' }, {
      slots: [],
      alternative_staff: [{ name: 'Юлия', staff_yc_id: 111, slots: [slot('10:00', '2026-09-22')] }],
    });
    expect(ev.has('2026-09-22T10:00:00+03:00', { staffYcId: 111, serviceYcIds: [15394061] })).toBe(true);
    expect(ev.has('2026-09-22T10:00:00+03:00', { staffYcId: 111, serviceYcIds: [9536676] })).toBe(false);
  });
```

- [ ] **Step 2: Run tests, confirm they fail**

```bash
cd /root/loyalpro/backend && npx jest agent-slot-evidence.test.js -t "service_yc_id"
```
Expected: 3 failures (`has(...)` currently ignores `serviceYcIds` entirely — the "fail" assertions expecting `false` will pass by accident, but the `true`-with-matching-service assertions plus the "wrong service → false" ones will not both hold correctly; run to see actual failures before implementing).

- [ ] **Step 3: Implement**

Replace `extractPairs` in `backend/services/agent/slot-evidence.js` (lines 42-88) with:

```javascript
function extractPairs(tool, input, result) {
  const out = [];
  if (!result || typeof result !== 'object' || result.error) return out;
  const push = (datetime, staff, name, service) => {
    const ms = toMs(datetime);
    if (Number.isFinite(ms)) {
      out.push({ ms, staff: idOrNull(staff), name: (typeof name === 'string' && name.trim()) || null,
        service: idOrNull(service) });
    }
  };
  const pushSlots = (list, staff, name, service) => {
    for (const s of (Array.isArray(list) ? list : [])) if (s) push(s.datetime, staff, name, service);
  };
  const inputStaff = input && input.staff_yc_id;
  const inputService = input && input.service_yc_id;

  if (tool === 'get_available_slots') {
    pushSlots(result.slots, inputStaff, result.staff_name, inputService);
    for (const key of ['alternative_staff', 'staff_options']) {
      for (const item of (Array.isArray(result[key]) ? result[key] : [])) {
        // Один вызов — одна услуга: alternative_staff/staff_options ищут ТУ ЖЕ
        // услугу у других мастеров, service_yc_id общий для всей выдачи.
        if (item) pushSlots(item.slots, item.staff_yc_id, item.name, inputService);
      }
    }
  } else if (tool === 'get_sequential_slots') {
    for (const v of (Array.isArray(result.variants) ? result.variants : [])) {
      for (const st of (Array.isArray(v && v.starts) ? v.starts : [])) {
        for (const link of (Array.isArray(st && st.chain) ? st.chain : [])) {
          if (link) push(link.datetime, link.staff_yc_id, link.staff_name, link.service_yc_id);
        }
      }
    }
  } else if (tool === 'get_parallel_slots') {
    for (const st of (Array.isArray(result.starts) ? result.starts : [])) {
      for (const g of (Array.isArray(st && st.guests) ? st.guests : [])) {
        if (g) push(g.datetime, g.staff_yc_id, null, g.service_yc_id);
      }
    }
  } else if (tool === 'create_booking') {
    pushSlots(result.available_slots, inputStaff, null, inputService);
  }
  return out;
}
```

Replace `createSlotEvidence` (lines 94-146) with:

```javascript
function createSlotEvidence() {
  const byMs = new Map();   // ms → Set<staff|null>
  const rows = [];          // {ms, staff, name, service} — для slotsOn и service-сверки
  const seen = new Set();   // дедуп rows по ms|staff|name|service
  const api = {
    get size() {
      let n = 0;
      for (const set of byMs.values()) n += set.size;
      return n;
    },
    add(tool, input, result) {
      if (!SLOT_EVIDENCE_TOOLS.has(tool)) return;
      for (const p of extractPairs(tool, input, result)) {
        if (!byMs.has(p.ms)) byMs.set(p.ms, new Set());
        byMs.get(p.ms).add(p.staff);
        const k = `${p.ms}|${p.staff}|${p.name}|${p.service}`;
        if (!seen.has(k)) { seen.add(k); rows.push(p); }
      }
    },
    slotsOn(dateKey) {
      return rows.filter(r => moscowDateKey(r.ms) === dateKey)
        .map(r => ({ time: moscowHHMM(r.ms), staffId: r.staff, name: r.name }));
    },
    dateKeys() {
      return [...new Set(rows.map(r => moscowDateKey(r.ms)))].sort();
    },
    // @param {string} datetime  ISO (или «YYYY-MM-DD HH:MM:SS») из аргументов write
    // @param {{staffYcId?: number, serviceYcIds?: number[]}} opts
    //   serviceYcIds — реальные услуги записи (при переносе); непустой список
    //   требует, чтобы подтверждающая строка evidence либо не знала услуги
    //   (fail-open — старый источник без service_yc_id), либо несла ОДНУ из
    //   перечисленных. Инцидент 2026-09-19 (79096664042): слот найден под
    //   услугу, которую назвал пациент СВОИМИ словами, а не под ту, что
    //   реально стоит в переносимой записи — совпало по счастливой случайности
    //   (одинаковая длительность), а могло и не совпасть.
    has(datetime, opts = {}) {
      const ms = toMs(datetime);
      if (!Number.isFinite(ms) || !byMs.has(ms)) return false;
      const want = idOrNull(opts.staffYcId);
      const set = byMs.get(ms);
      if (want !== null && !(set.has(want) || set.has(null))) return false;
      const wantServices = Array.isArray(opts.serviceYcIds)
        ? opts.serviceYcIds.map(idOrNull).filter(v => v !== null)
        : null;
      if (!wantServices || !wantServices.length) return true;
      const matches = rows.filter(r => r.ms === ms && (want === null || r.staff === want || r.staff === null));
      return matches.some(r => r.service === null || wantServices.includes(r.service));
    },
    seedFromJournal(rows, opts = {}) {
      if (!Array.isArray(rows)) return;
      const maxAge = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : SLOT_TIMES_FRESH_MS;
      for (const r of rows) {
        if (!r || r.is_error) continue;
        const age = Number(r.age_ms);
        if (!Number.isFinite(age) || age > maxAge) continue;
        api.add(r.tool, r.input, r.result);
      }
    },
  };
  return api;
}
```

Add after `needsConfirmationHint` (before `PROMPT_RULE_MARKERS`, currently line 184-188):

```javascript
// Гейт booking-modify.rescheduleBookingRecord: слот найден по ДРУГОЙ услуге,
// чем та, что реально стоит в переносимой записи (инцидент 2026-09-19).
function wrongServiceHint(datetime, recordServiceIds) {
  return `Слот ${datetime} подтверждён выдачей get_available_slots, но по ДРУГОЙ услуге, чем в переносимой ` +
    `записи (её реальные услуги: id ${recordServiceIds.join(', ')}). Перенос ВСЕГДА сохраняет исходную услугу ` +
    'записи — вызови get_available_slots заново со staff_yc_id и РЕАЛЬНЫМ service_yc_id этой записи (не тем, ' +
    'что пациент назвал своими словами), и повтори reschedule_booking с datetime ДОСЛОВНО из новой выдачи. ' +
    'Пациенту про эту проверку не пиши.';
}
```

Update `module.exports` (lines 190-193):

```javascript
module.exports = {
  createSlotEvidence, SLOT_EVIDENCE_TOOLS, extractPairs,
  timeMentioned, moscowHHMM, moscowDateKey, unverifiedSlotHint, needsConfirmationHint, wrongServiceHint,
  PROMPT_RULE_MARKERS,
};
```

- [ ] **Step 4: Run tests, confirm they pass**

```bash
cd /root/loyalpro/backend && npx jest agent-slot-evidence.test.js
```
Expected: all tests PASS (existing ones untouched by the backward-compatible signature change).

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro/backend && git add services/agent/slot-evidence.js agent-slot-evidence.test.js
git commit -m "feat(agent): slot-evidence сверяет service_yc_id, не только время+мастер"
```

---

### Task A2: `booking-modify.rescheduleBookingRecord` enforces the service check

**Files:**
- Modify: `backend/services/agent/booking-modify.js:1-8` (require) and `:102-127` (`rescheduleBookingRecord`)
- Test: `backend/agent-booking-modify.test.js`

- [ ] **Step 1: Write the failing test**

Find the `describe('rescheduleBookingRecord', ...)` block in `backend/agent-booking-modify.test.js` and add:

```javascript
  test('слот подтверждён под ДРУГУЮ услугу записи → wrongService, PUT не идёт', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC); // REC.services = [{ id: 10, title: 'Пилинг' }]
    const { createSlotEvidence } = require('./services/agent/slot-evidence');
    const ev = createSlotEvidence();
    ev.add('get_available_slots', { staff_yc_id: 7, service_yc_id: 999, date: '2026-07-27' },
      { slots: [{ datetime: '2026-07-27T19:30:00+03:00' }] });
    const res = await rescheduleBookingRecord(1, {
      dialogKey: 'd', recordId: 555, expectedYcClientId: 777,
      datetime: '2026-07-27T19:30:00+03:00', slotEvidence: ev,
    });
    expect(res.ok).toBe(false);
    expect(res.wrongService).toBe(true);
    expect(res.error).toMatch(/10/);
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test('слот подтверждён под РЕАЛЬНУЮ услугу записи (id 10) → PUT идёт', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);
    ycr.ycUpdateRecord.mockResolvedValue({ id: 555 });
    const { createSlotEvidence } = require('./services/agent/slot-evidence');
    const ev = createSlotEvidence();
    ev.add('get_available_slots', { staff_yc_id: 7, service_yc_id: 10, date: '2026-07-27' },
      { slots: [{ datetime: '2026-07-27T19:30:00+03:00' }] });
    const res = await rescheduleBookingRecord(1, {
      dialogKey: 'd', recordId: 555, expectedYcClientId: 777,
      datetime: '2026-07-27T19:30:00+03:00', slotEvidence: ev,
    });
    expect(res.ok).toBe(true);
  });

  test('без slotEvidence (fail-open) — прежнее поведение', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);
    ycr.ycUpdateRecord.mockResolvedValue({ id: 555 });
    const res = await rescheduleBookingRecord(1, {
      dialogKey: 'd', recordId: 555, expectedYcClientId: 777, datetime: '2026-07-27T19:30:00+03:00',
    });
    expect(res.ok).toBe(true);
  });
```

- [ ] **Step 2: Run tests, confirm they fail**

```bash
cd /root/loyalpro/backend && npx jest agent-booking-modify.test.js -t "wrongService|РЕАЛЬНУЮ услугу|fail-open"
```
Expected: FAIL — `rescheduleBookingRecord` doesn't accept/use `slotEvidence` yet, first test's `res.wrongService` is `undefined`.

- [ ] **Step 3: Implement**

Add the import at the top of `backend/services/agent/booking-modify.js` (after the existing `withRateLimitRetry` require, line 8):

```javascript
const { wrongServiceHint } = require('./slot-evidence');
```

Replace `rescheduleBookingRecord` (lines 102-127) with:

```javascript
async function rescheduleBookingRecord(salonId, {
  dialogKey, recordId, expectedYcClientId, datetime, staffYcId, seanceLength, slotEvidence,
}) {
  const salon = await loadSalon(salonId);
  if (!salon) return { ok: false, error: 'YClients не подключён для салона.' };

  let rec;
  try { rec = await ycGetRecord(salon, recordId); }
  catch (e) { return { ok: false, error: e.message }; }
  if (!rec || !rec.id) return { ok: false, error: 'Запись не найдена.' };
  if (ownershipError(rec, expectedYcClientId)) return { ok: false, foreign: true, error: ownershipError(rec, expectedYcClientId) };

  // Слот, из которого взят datetime, обязан быть найден по РЕАЛЬНОЙ услуге
  // этой записи — не по той, что модель (пере)спросила у пациента своими
  // словами (инцидент 2026-09-19, 79096664042: service_yc_id разошёлся с
  // записью, совпало лишь длительностью). fail-open без slotEvidence или без
  // услуг записи (пустая запись сюда обычным путём не доходит).
  if (slotEvidence) {
    const recordServiceIds = serviceIds(rec).map(s => Number(s.id)).filter(Boolean);
    if (recordServiceIds.length
        && !slotEvidence.has(datetime, { staffYcId: staffYcId || rec.staff_id, serviceYcIds: recordServiceIds })) {
      return { ok: false, wrongService: true, error: wrongServiceHint(datetime, recordServiceIds) };
    }
  }

  // Лимит запросов YClients (429) повторяем: инцидент 2026-09-19 — два переноса
  // подряд упали на «Превышен лимит… через 0 секунд» без единого повтора.
  try {
    await withRateLimitRetry(() => ycUpdateRecord(authSalonFor(salon), recordId, {
      staff_id: staffYcId || rec.staff_id,
      services: serviceIds(rec),
      client: clientOf(rec),
      datetime,
      seance_length: seanceLength || rec.seance_length,
      comment: rec.comment || '',
    }));
  } catch (e) { return { ok: false, error: e.message }; }

  await logEvent(salonId, dialogKey, 'booking_rescheduled', 'reschedule_booking',
    { record_id: recordId, datetime });
  return { ok: true, record_id: recordId, datetime };
}
```

- [ ] **Step 4: Run tests, confirm they pass**

```bash
cd /root/loyalpro/backend && npx jest agent-booking-modify.test.js
```
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro/backend && git add services/agent/booking-modify.js agent-booking-modify.test.js
git commit -m "feat(agent): reschedule_booking отвергает слот, найденный под чужую услугу записи"
```

---

### Task A3: wire `ctx.slotEvidence` through `tools/reschedule-booking.js`, surface `wrong_service`

**Files:**
- Modify: `backend/services/agent/tools/reschedule-booking.js`
- Test: `backend/agent-reschedule-booking.test.js`

- [ ] **Step 1: Write the failing test**

Add to `backend/agent-reschedule-booking.test.js` (after the existing `too_soon и провал YClients` test):

```javascript
test('booking-modify вернул wrongService → hint invalid_args, не провал записи', async () => {
  bookingModify.rescheduleBookingRecord.mockResolvedValueOnce({
    ok: false, wrongService: true, error: 'Слот найден под другую услугу…',
  });
  const res = await tool.run(1, { record_id: 5, datetime: DT }, {
    clientPhone: '79651442032', nowMs: NOW, slotEvidence: evidenceWith(['17:00']),
    recentDialogText: 'на 17:00',
  });
  expect(res.invalid_args).toBe(true);
  expect(res.wrong_service).toBe(true);
  expect(tool.isHintResult(res)).toBe(true);
});
```

- [ ] **Step 2: Run test, confirm it fails**

```bash
cd /root/loyalpro/backend && npx jest agent-reschedule-booking.test.js -t "wrongService"
```
Expected: FAIL — current tool code returns `{ error: res.error, foreign: res.foreign }` without `invalid_args`/`wrong_service`, and doesn't pass `slotEvidence` to `rescheduleBookingRecord` at all yet.

- [ ] **Step 3: Implement**

In `backend/services/agent/tools/reschedule-booking.js`, replace the body of `run` from the `bookingModify.rescheduleBookingRecord` call onward (lines 65-74):

```javascript
  const res = await bookingModify.rescheduleBookingRecord(salonId, {
    dialogKey: ctx.dialogKey || ctx.clientPhone,
    recordId,
    expectedYcClientId,
    datetime,
    staffYcId: input.staff_yc_id,
    seanceLength: input.seance_length,
    slotEvidence: ctx.slotEvidence,
  });
  if (!res.ok) {
    if (res.wrongService) return { invalid_args: true, wrong_service: true, error: res.error };
    return { error: res.error, foreign: res.foreign };
  }
  return { rescheduled: true, record_id: res.record_id, datetime: res.datetime };
}
```

Update `isHintResult` (lines 80-82):

```javascript
function isHintResult(res) {
  return !!(res && (res.invalid_args || res.too_soon || res.unverified_slot || res.needs_confirmation || res.wrong_service));
}
```

- [ ] **Step 4: Run tests, confirm they pass**

```bash
cd /root/loyalpro/backend && npx jest agent-reschedule-booking.test.js
```
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro/backend && git add services/agent/tools/reschedule-booking.js agent-reschedule-booking.test.js
git commit -m "feat(agent): reschedule_booking пробрасывает slotEvidence, wrong_service — hint"
```

---

### Task A4: orchestrator treats `wrong_service` as a hint, not a write failure

**Files:**
- Modify: `backend/services/agent/orchestrator.js:212-215` (`isWriteHint`)
- Test: `backend/agent-orchestrator.test.js`

- [ ] **Step 1: Write the failing test**

Find an existing test that exercises `isWriteHint`/`writeErrored` behavior for `unverified_slot` (search `unverified_slot` in `agent-orchestrator.test.js`) and add an analogous one nearby (adjust mock handler name/shape to match the surrounding describe block's conventions — the key assertion is that `wrong_service` does NOT set `writeErrored`):

```javascript
test('reschedule_booking wrong_service — hint, не writeErrored (не считается провалом записи)', async () => {
  const deps = makeDeps({ handlers: {
    reschedule_booking: jest.fn(async () => ({ invalid_args: true, wrong_service: true, error: 'слот под другую услугу' })),
  } });
  deps.provider.createMessage
    .mockResolvedValueOnce(toolResp('reschedule_booking', { record_id: 5, datetime: '2026-09-25T16:30:00+03:00' }))
    .mockResolvedValueOnce(textResp('Секунду, уточню ещё раз.'));
  await orchestrator.runDialog(1, 'k', { deps });
  // «Занято» без слот-вызова оценивается по writeErrored: если бы wrong_service
  // считался провалом, unbacked_unavailability-класс проверок вёл бы себя иначе.
  // Здесь достаточно факта, что ход не эскалировал и не долетел до
  // «извинись и переведи на администратора» — ассерт по количеству вызовов.
  expect(deps.provider.createMessage).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run test, confirm it fails or passes by accident**

```bash
cd /root/loyalpro/backend && npx jest agent-orchestrator.test.js -t "wrong_service"
```
If this passes already (likely, since the test as written doesn't yet assert `writeErrored` directly), skip to Step 3 anyway — the real regression this task prevents is `writeErrored` being set, which would silently change `checkUnbackedUnavailability`'s `slotToolCalled || writeErrored` bypass condition for any later reply mentioning availability. Proceed with the implementation regardless; this test is a smoke check that the tool-call path itself still works.

- [ ] **Step 3: Implement**

In `backend/services/agent/orchestrator.js`, update `isWriteHint` (lines 212-215):

```javascript
function isWriteHint(res) {
  return !!(res && (res.invalid_args || res.too_soon || res.needs_phone
    || res.generic_service_hint || res.unverified_slot || res.needs_confirmation || res.wrong_service));
}
```

- [ ] **Step 4: Run tests, confirm they pass**

```bash
cd /root/loyalpro/backend && npx jest agent-orchestrator.test.js
```
Expected: all tests PASS (this is a one-line additive change to an `||` chain — no existing behavior changes).

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro/backend && git add services/agent/orchestrator.js agent-orchestrator.test.js
git commit -m "fix(agent): wrong_service — hint write-инструмента, не writeErrored"
```

---

### Task A5: document the hint in the system prompt's Сценарий 3 Шаг 5

**Files:**
- Modify: `backend/services/agent/system-prompt.js:452`
- (Test coverage: `backend/agent-system-prompt.test.js` already asserts every string in `slot-evidence.PROMPT_RULE_MARKERS` appears in the prompt — extending the array is the test.)

- [ ] **Step 1: Extend `PROMPT_RULE_MARKERS` (this IS the failing-test step — the marker won't be in the prompt yet)**

In `backend/services/agent/slot-evidence.js`, change (this was already exported in Task A1, now extend the array itself):

```javascript
const PROMPT_RULE_MARKERS = ['unverified_slot', 'needs_confirmation', 'wrong_service'];
```

- [ ] **Step 2: Run the prompt test, confirm it fails**

```bash
cd /root/loyalpro/backend && npx jest agent-system-prompt.test.js -t "PROMPT_RULE_MARKERS"
```
Expected: FAIL — `wrong_service` isn't mentioned in `system-prompt.js` yet.

- [ ] **Step 3: Implement — update Шаг 5 text**

In `backend/services/agent/system-prompt.js`, line 452, change:

```javascript
    `- Шаг 5. После того как пациент подтвердил новый слот — вызови reschedule_booking с record_id и ТОЧНЫМ datetime из get_available_slots. Система проверяет оба условия сама: ответ unverified_slot значит, что этого времени не было в выдаче слотов (сначала вызови get_available_slots на эту дату со staff_yc_id мастера записи), ответ needs_confirmation — что время ещё не звучало в переписке (назови его пациенту цифрами и дождись «да»). Оба ответа — не провал переноса, а пропущенный шаг: сделай его и повтори вызов.`,
```

to:

```javascript
    `- Шаг 5. После того как пациент подтвердил новый слот — вызови reschedule_booking с record_id и ТОЧНЫМ datetime из get_available_slots. Система проверяет условия сама: ответ unverified_slot значит, что этого времени не было в выдаче слотов (сначала вызови get_available_slots на эту дату со staff_yc_id мастера записи), needs_confirmation — что время ещё не звучало в переписке (назови его пациенту цифрами и дождись «да»), wrong_service — что слот найден по ДРУГОЙ услуге, а не по той, что реально стоит в переносимой записи (вызови get_available_slots заново с service_yc_id и staff_yc_id именно этой записи, не тем, что назвал пациент). Все три ответа — не провал переноса, а пропущенный шаг: сделай его и повтори вызов.`,
```

- [ ] **Step 4: Run tests, confirm they pass**

```bash
cd /root/loyalpro/backend && npx jest agent-system-prompt.test.js
```
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro/backend && git add services/agent/slot-evidence.js services/agent/system-prompt.js
git commit -m "docs(agent): промпт объясняет hint wrong_service (Сценарий 3, Шаг 5)"
```

---

## Part B — stop the redundant "which procedure" question

### Task B1: `reply-guard.js` — new `checkRedundantProcedureQuestion` check

**Files:**
- Modify: `backend/services/agent/reply-guard.js` (add near `checkRejectedRepeat`, before the `HARD_TYPES` set at line 451; extend `HARD_TYPES`; extend `module.exports`)
- Test: `backend/agent-reply-guard.test.js`

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `backend/agent-reply-guard.test.js`, after the existing `describe('checkRejectedRepeat', ...)` block:

```javascript
// ── Лишний вопрос «на какую процедуру» при одной активной записи ──────────
// Инцидент 2026-09-19 (79096664042): пациентка ответила на напоминание о визите
// «Перенесите, пожалуйста, на пятницу» — у неё РОВНО одна будущая запись, её
// услуга/мастер/record_id уже в блоке «АКТУАЛЬНЫЕ ЗАПИСИ ПАЦИЕНТА». Мила всё
// равно спросила «на какую процедуру вас записать», хотя Сценарий 3 Шаг 2
// прямо запрещает переспрашивать при одной записи.
describe('checkRedundantProcedureQuestion', () => {
  const { checkRedundantProcedureQuestion } = g;
  const ONE_BOOKING = ['20.09 (вс) 17:40 — Миотокс 1ед, мастер Гаджиева Пери [record_id 1981003965]'];

  test('одна запись + «перенесите» от пациента + вопрос про процедуру → нарушение', () => {
    const v = checkRedundantProcedureQuestion(
      'Уточните, пожалуйста, на какую процедуру вас записать в пятницу?',
      { liveBookings: ONE_BOOKING, patientLastText: 'Перенесите, пожалуйста, на пятницу' });
    expect(v).toEqual([{ type: 'redundant_procedure_question', value: ONE_BOOKING[0] }]);
  });

  test('вариант «на какую услугу»', () => {
    const v = checkRedundantProcedureQuestion(
      'Подскажите, на какую услугу вас записать?',
      { liveBookings: ONE_BOOKING, patientLastText: 'перенести бы на среду' });
    expect(v).toHaveLength(1);
  });

  test('несколько записей → не ловим (там легально уточнять, какую именно)', () => {
    const v = checkRedundantProcedureQuestion(
      'На какую процедуру вас записать?',
      { liveBookings: [...ONE_BOOKING, 'ещё одна запись'], patientLastText: 'Перенесите на пятницу' });
    expect(v).toEqual([]);
  });

  test('записей нет вовсе → не ловим', () => {
    const v = checkRedundantProcedureQuestion(
      'На какую процедуру вас записать?',
      { liveBookings: [], patientLastText: 'Перенесите на пятницу' });
    expect(v).toEqual([]);
  });

  test('пациент не просил перенос → не ловим (обычный новый вопрос про процедуру законен)', () => {
    const v = checkRedundantProcedureQuestion(
      'На какую процедуру вас записать?',
      { liveBookings: ONE_BOOKING, patientLastText: 'Здравствуйте, хочу записаться' });
    expect(v).toEqual([]);
  });

  test('модель спрашивает дату, а не процедуру → не ловим (Шаг 3 законен)', () => {
    const v = checkRedundantProcedureQuestion(
      'На какую дату хотите перенести запись?',
      { liveBookings: ONE_BOOKING, patientLastText: 'Перенесите, пожалуйста, на пятницу' });
    expect(v).toEqual([]);
  });

  test('склонения «перенос»/«перенести»/«перенесите» — все ловятся', () => {
    for (const phrase of ['перенос', 'перенесите', 'перенести', 'переносить', 'перенесла']) {
      const v = checkRedundantProcedureQuestion(
        'На какую процедуру вас записать?',
        { liveBookings: ONE_BOOKING, patientLastText: phrase });
      expect(v).toHaveLength(1);
    }
  });
});
```

Add to the `hardViolations` describe block (`backend/agent-reply-guard.test.js`, after the `alien_time_attribution` test):

```javascript
  test('redundant_procedure_question — жёсткое', () => {
    expect(g.hardViolations([{ type: 'redundant_procedure_question', value: 'запись' }]))
      .toEqual([{ type: 'redundant_procedure_question', value: 'запись' }]);
  });
```

- [ ] **Step 2: Run tests, confirm they fail**

```bash
cd /root/loyalpro/backend && npx jest agent-reply-guard.test.js -t "checkRedundantProcedureQuestion|redundant_procedure_question"
```
Expected: FAIL — `g.checkRedundantProcedureQuestion` is `undefined`.

- [ ] **Step 3: Implement**

In `backend/services/agent/reply-guard.js`, add after `checkRejectedRepeat` (after line 437, before the `HARD_TYPES` comment block):

```javascript
// ── Лишний вопрос «на какую процедуру» при ОДНОЙ активной записи ──────────
// Инцидент 2026-09-19 (79096664042): пациентка ответила на напоминание о визите
// «Перенесите, пожалуйста, на пятницу» — у неё РОВНО одна будущая запись, услуга,
// мастер и record_id уже лежат в блоке «АКТУАЛЬНЫЕ ЗАПИСИ ПАЦИЕНТА» промпта, и
// Сценарий 3 Шаг 2 прямо требует «если запись одна — не переспрашивай». Модель
// спросила «на какую процедуру вас записать» — вопрос из ветки НОВОЙ записи, не
// имеющий отношения к переносу существующей. Признак узкий и однозначный: ОДНА
// живая запись (несколько — там уточнение «какую именно» легально и НЕ ловится)
// + пациент сам сказал «перенес…»/«перенос…» + реплика буквально спрашивает про
// процедуру/услугу — ложных срабатываний не ждём.
const RESCHEDULE_INTENT_RE = /(?<![\p{L}])перен[ео]с[а-яё]*(?![\p{L}])/iu;
const ASK_PROCEDURE_RE = /(?<![\p{L}])на\s+как[а-яё]*\s+(?:процедур|услуг)[а-яё]*/iu;

function checkRedundantProcedureQuestion(text, opts = {}) {
  const bookings = opts.liveBookings;
  if (!Array.isArray(bookings) || bookings.length !== 1) return [];
  if (!RESCHEDULE_INTENT_RE.test(String(opts.patientLastText || ''))) return [];
  if (!ASK_PROCEDURE_RE.test(String(text || ''))) return [];
  return [{ type: 'redundant_procedure_question', value: bookings[0] }];
}
```

Add `'redundant_procedure_question'` to `HARD_TYPES` (currently lines 451-464):

```javascript
const HARD_TYPES = new Set([
  'taboo_word', 'id_leak', 'unknown_time', 'alien_time_attribution', 'staff_not_working_claim',
  'unverified_offer', 'fabricated_unavailability_reason',
  'false_unavailability',
  'unbacked_unavailability', 'rejected_repeat',
  'unverified_offer_date',
  // Лишний вопрос «на какую процедуру» при одной активной записи и явном
  // намерении её перенести (инцидент 2026-09-19, 79096664042) — тратит время
  // пациента и уже известно, что открывает путь к сервис-рассинхрону.
  'redundant_procedure_question',
]);
```

Update `module.exports` (currently lines 485-492) — add `checkRedundantProcedureQuestion, RESCHEDULE_INTENT_RE, ASK_PROCEDURE_RE` to the export list.

- [ ] **Step 4: Run tests, confirm they pass**

```bash
cd /root/loyalpro/backend && npx jest agent-reply-guard.test.js
```
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro/backend && git add services/agent/reply-guard.js agent-reply-guard.test.js
git commit -m "feat(agent): reply-guard ловит лишний вопрос про процедуру при одной записи"
```

---

### Task B2: wire the check into the orchestrator's lint loop + `buildHardFixPrompt`

**Files:**
- Modify: `backend/services/agent/orchestrator.js:146-207` (`buildHardFixPrompt`) and `:1280-1328` (`lint` array)
- Test: `backend/agent-orchestrator.test.js`

- [ ] **Step 1: Write the failing end-to-end test**

Add to `backend/agent-orchestrator.test.js`, right after the `describe('reply-guard: «занято» без слот-вызова и повтор отвергнутого (инцидент 2026-09-19)', ...)` block (around line 2857):

```javascript
// ── Лишний вопрос «на какую процедуру» при одной записи (2026-09-19, 79096664042) ──
describe('reply-guard: лишний вопрос про процедуру при одной активной записи', () => {
  const NOW = Date.parse('2026-09-19T19:01:00+03:00');
  const REC = {
    record_id: 1981003965, datetime: '2026-09-20T17:40:00+03:00',
    services: ['Миотокс 1ед'], staff_name: 'Гаджиева Пери',
  };

  test('«перенесите на пятницу» + вопрос про процедуру → корректирующий довызов', async () => {
    const deps = makeDeps({
      listBookings: { run: jest.fn(async () => ({ bookings: [REC] })) },
      history: { loadTranscript: jest.fn(async () => ({
        messages: [{ role: 'user', content: 'Перенесите, пожалуйста, на пятницу' }], watermark: 100 })) },
    });
    deps.provider.createMessage
      .mockResolvedValueOnce(textResp('Здравствуйте! Уточните, пожалуйста, на какую процедуру вас записать в пятницу?'))
      .mockResolvedValueOnce(textResp('Здравствуйте! На пятницу вам удобнее в первой или во второй половине дня?'));
    const out = await orchestrator.runDialog(1, 'k', { deps, ctx: { phone: '79096664042' }, nowMs: NOW });
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(2);
    const fix = deps.provider.createMessage.mock.calls[1][0].messages.at(-1).content;
    expect(fix).toMatch(/на какую процедуру/i);
    expect(fix).toMatch(/1981003965/);
    expect(out.replies[0]).toMatch(/половине дня/);
  });

  test('несколько записей — вопрос «какую именно» не трогаем', async () => {
    const deps = makeDeps({
      listBookings: { run: jest.fn(async () => ({ bookings: [REC, { ...REC, record_id: 2 }] })) },
      history: { loadTranscript: jest.fn(async () => ({
        messages: [{ role: 'user', content: 'Перенесите, пожалуйста, на пятницу' }], watermark: 100 })) },
    });
    deps.provider.createMessage
      .mockResolvedValueOnce(textResp('У вас несколько записей — уточните, какую именно перенести?'));
    await orchestrator.runDialog(1, 'k', { deps, ctx: { phone: '79096664042' }, nowMs: NOW });
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests, confirm they fail**

```bash
cd /root/loyalpro/backend && npx jest agent-orchestrator.test.js -t "лишний вопрос про процедуру"
```
Expected: FAIL — first test currently makes only 1 provider call (no corrective recall yet); second test should already pass (nothing wired in yet), confirming it as a safe baseline.

- [ ] **Step 3: Implement**

In `backend/services/agent/orchestrator.js`, add a new case to `buildHardFixPrompt` (after the `rejected` block, before the `fabricated_unavailability_reason` block — around line 200):

```javascript
  const redundant = val('redundant_procedure_question');
  if (redundant.length) {
    parts.push('переспрашивает у пациента, на какую процедуру его записать, хотя у него РОВНО ОДНА ' +
      `активная запись и он сам попросил её перенести: «${redundant[0]}». Услуга, мастер и запись уже ` +
      'известны — процедуру не спрашивай. Продолжи со следующего шага переноса: если пациент уже назвал ' +
      'дату — предложи 1–2 времени по мастеру и услуге именно этой записи; если дату ещё не назвал — спроси ' +
      'только дату переноса');
  }
```

In the `lint` array (currently lines 1280-1327), add after `checkRejectedRepeat` (before `checkGiftRepeat`):

```javascript
        // Лишний вопрос «на какую процедуру» при единственной активной записи
        // и явном намерении её ПЕРЕНЕСТИ (инцидент 2026-09-19, 79096664042):
        // услуга/мастер/record_id уже в блоке «АКТУАЛЬНЫЕ ЗАПИСИ ПАЦИЕНТА».
        ...replyGuard.checkRedundantProcedureQuestion(joined,
          { liveBookings, patientLastText: toolCtx.patientLastText }),
```

- [ ] **Step 4: Run tests, confirm they pass**

```bash
cd /root/loyalpro/backend && npx jest agent-orchestrator.test.js
```
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro/backend && git add services/agent/orchestrator.js agent-orchestrator.test.js
git commit -m "feat(agent): корректирующий довызов на лишний вопрос про процедуру при переносе"
```

---

### Task B3: full backend test suite + CLAUDE.md documentation

**Files:**
- Modify: `CLAUDE.md` (under the existing "Перенос записи под гейтами кода" section)

- [ ] **Step 1: Run the full backend test suite**

```bash
cd /root/loyalpro/backend && npx jest
```
Expected: all suites PASS (the one known flake, `primary-clients.test.js` calling `process.exit(1)`, is a pre-existing issue unrelated to this change — see project memory `jest_full_run_flake_primary_clients`; if it's the *only* failure, that's expected).

- [ ] **Step 2: Document in CLAUDE.md**

In `CLAUDE.md`, find the paragraph ending `«ВНЕ scope: гейт согласия для create_booking; «вечерних нет» при 17:00 в выдаче ПРЕДЫДУЩЕГО хода для цепочки услуг (честность зависит от того, влезает ли цепочка); интервал напоминаний followup_delay1_min=10 — настройка салона.»` (end of the "Перенос записи под гейтами кода" bullet) and append a new bullet right after it, before the next `- Сценарий 3 на канале без номера…` bullet:

```markdown
- Лишний вопрос «на какую процедуру» при переносе ЕДИНСТВЕННОЙ активной записи, и слот, найденный под ЧУЖУЮ услугу записи (инцидент 2026-09-19, 79096664042, WhatsApp): пациентка ответила на напоминание о визите «Перенесите, пожалуйста, на пятницу» — единственная будущая запись, её услуга/мастер/record_id уже лежали в блоке «АКТУАЛЬНЫЕ ЗАПИСИ ПАЦИЕНТА», а Сценарий 3 Шаг 2 прямо запрещает переспрашивать при одной записи. Мила спросила «на какую процедуру вас записать» (0 вызовов инструментов за ход), а после ответа пациентки вызвала `get_available_slots` с `service_yc_id`, ОТЛИЧНЫМ от реальной услуги записи («Миотокс 1ед»/15394061 vs 9536676) — перенос прошёл только потому, что у обеих услуг совпала 30-минутная сетка. ДВА независимых кодовых гейта, промпт-правило («если запись одна — не переспрашивай», уже существовало и было проигнорировано) само по себе не чинится: (1) `slot-evidence.js` теперь сверяет НЕ ТОЛЬКО время+мастер, но и `service_yc_id` — `has(datetime, {staffYcId, serviceYcIds})`; `booking-modify.rescheduleBookingRecord` (уже фетчит запись ради PUT, лишнего похода в YClients нет) отвергает слот, найденный под чужую услугу, hint `wrong_service` (тот же класс, что `unverified_slot`/`needs_confirmation` — пропущенный шаг, не провал переноса). (2) `reply-guard.checkRedundantProcedureQuestion` (жёсткое, корректирующий довызов) ловит УЗКИЙ признак: РОВНО одна запись в блоке + пациент сам сказал «перенес…»/«перенос…» + реплика спрашивает «на какую процедуру/услугу» — при НЕСКОЛЬКИХ записях уточнение «какую именно» легально и не ловится. Тесты — `agent-slot-evidence.test.js`, `agent-booking-modify.test.js`, `agent-reschedule-booking.test.js`, `agent-reply-guard.test.js`, `agent-orchestrator.test.js`.
```

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro && git add CLAUDE.md
git commit -m "docs(agent): CLAUDE.md — лишний вопрос про процедуру + wrong_service при переносе"
```

---

## Self-Review

**Spec coverage:**
- Redundant "which procedure" question when exactly one booking exists → Part B (Task B1-B2). ✓
- Slot search using a different service than the record's real one → Part A (Task A1-A5). ✓
- Both fixed via code, no new prompt *rules* (Task A5 only documents the meaning of a new hint flag, same category as existing `unverified_slot`/`needs_confirmation` documentation — consistent with the moratorium's carve-out for clarifying existing rules). ✓
- Fail-open behavior preserved everywhere data is missing (no `slotEvidence`, no service info in evidence, no live-bookings sync). ✓
- CLAUDE.md documentation task included, matching project convention. ✓

**Placeholder scan:** none found — every step has complete code and exact file/line references.

**Type/name consistency check:**
- `wrong_service` (tool-result flag) vs `wrongService` (internal `booking-modify` return field) — intentionally different casing, matching the existing `res.foreign` (internal) → tool surfaces its own flag name pattern (e.g. `unverified_slot`/`needs_confirmation` are already the literal tool-result field names, `foreign`/`ok` are `booking-modify`-internal). Verified consistent across Task A2 → A3 → A4.
- `checkRedundantProcedureQuestion` name used identically in `reply-guard.js` export, `orchestrator.js` call site, and both test files.
- `liveBookings` (array of rendered strings) reused as-is from existing orchestrator scope (line 516) — no new variable introduced, confirmed already in scope at the lint call site (same enclosing `runDialogInner` function, `liveBookings` declared before the tool loop).

## Out of scope (noted, not actioned)

- Extending the same `service_yc_id` cross-check to `create_booking`'s slot-evidence gate — that tool already receives `service_yc_id` as an explicit, required argument from the model rather than re-deriving it from a record, so the failure mode this plan targets (service silently drifting from what a *record* actually has) doesn't apply there.
- Widening `RESCHEDULE_INTENT_RE`/`checkRedundantProcedureQuestion` to also catch the analogous case in ОТМЕНА (cancel) flow — Сценарий 3's ОТМЕНА text doesn't contain the same explicit "if one — don't re-ask" sentence as ПЕРЕНОС does, and no incident evidence exists yet for that path. Revisit if telemetry (the `logger.warn` line the lint loop already emits for every violation) shows it recurring.
