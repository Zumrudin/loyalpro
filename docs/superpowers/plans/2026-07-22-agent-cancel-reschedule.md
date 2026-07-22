# Мила: отмена и перенос записи — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать ИИ-администратору «Мила» два новых сценария — отмену записи (с предложением переноса) и перенос записи (уточнить какую → дату → слот).

**Architecture:** Три новых tool-модуля (`list_client_bookings`, `cancel_booking`, `reschedule_booking`) поверх сервиса `booking-modify.js` и YClients-хелперов в `yclients-records.js`. Разговорный поток (предложить перенос до отмены, уточнить какую запись, спросить дату, показать слоты) — промпт-управляемый, как consent-gate `create_booking`. Отмена = модификация записи (`PUT /record`): `attendance=-1`, `seance_length=300` (5 мин, освобождает график) + добавление услуги «Запрет на отправку» (глушит уведомления).

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`), YClients REST API, jest.

**Spec:** `docs/superpowers/specs/2026-07-22-agent-cancel-reschedule-design.md`

---

## Файловая структура

**Создаём:**
- `backend/services/agent/booking-modify.js` — исполнитель отмены/переноса (YClients-вызовы + `agent_events`).
- `backend/services/agent/tools/list-client-bookings.js` — tool: живой список будущих записей клиента.
- `backend/services/agent/tools/cancel-booking.js` — tool: отмена.
- `backend/services/agent/tools/reschedule-booking.js` — tool: перенос.
- `backend/yclients-records.test.js` — юнит новых YClients-хелперов.
- `backend/agent-booking-modify.test.js` — юнит исполнителя.

**Правим:**
- `backend/services/yclients-records.js` — добавить `ycGetRecord`, `ycGetClientRecords`, `ycUpdateRecord`.
- `backend/services/agent/identity.js` — добавить `resolveYclientsClientId`.
- `backend/services/agent/tools/index.js` — зарегистрировать три новых tool.
- `backend/services/agent/orchestrator.js` — добавить новые tool в `SIDE_EFFECT_TOOLS`.
- `backend/services/agent/system-prompt.js` — Сценарий 4 (отмена/перенос).
- `backend/agent-tools.test.js` — юниты новых tool.
- `backend/agent-system-prompt.test.js` — кейсы Сценария 4.

---

## Task 1: YClients-хелперы (read + update записи)

**Files:**
- Modify: `backend/services/yclients-records.js`
- Test: `backend/yclients-records.test.js` (create)

- [ ] **Step 1: Написать падающий тест**

Create `backend/yclients-records.test.js`:

```javascript
'use strict';

jest.mock('axios');
jest.mock('./services/yclients', () => ({
  ycHeaders: jest.fn(() => ({ Authorization: 'Bearer p, User u' })),
  ycGet: jest.fn(),
}));

const axios = require('axios');
const { ycGet } = require('./services/yclients');
const {
  ycGetRecord, ycGetClientRecords, ycUpdateRecord,
} = require('./services/yclients-records');

const salon = { id: 1, yclients_company_id: 100, yclients_partner_token: 'p', yclients_user_token: 'u' };

beforeEach(() => jest.clearAllMocks());

describe('ycGetRecord', () => {
  test('GET /record/{cid}/{id} через ycGet', async () => {
    ycGet.mockResolvedValue({ id: 555, attendance: 0 });
    const rec = await ycGetRecord(salon, 555);
    expect(ycGet).toHaveBeenCalledWith(salon, '/record/100/555', {});
    expect(rec.id).toBe(555);
  });
});

describe('ycGetClientRecords', () => {
  test('GET /records/{cid} с client_id и start_date', async () => {
    ycGet.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const recs = await ycGetClientRecords(salon, 777, { startDate: '2026-07-22' });
    expect(ycGet).toHaveBeenCalledWith(salon, '/records/100',
      { client_id: 777, count: 300, start_date: '2026-07-22' });
    expect(recs).toHaveLength(2);
  });
  test('не массив → []', async () => {
    ycGet.mockResolvedValue(null);
    const recs = await ycGetClientRecords(salon, 777, {});
    expect(recs).toEqual([]);
  });
});

describe('ycUpdateRecord', () => {
  test('PUT /record/{cid}/{id} с телом, возвращает data.data', async () => {
    axios.put.mockResolvedValue({ data: { success: true, data: { id: 555 } } });
    const out = await ycUpdateRecord(salon, 555, { attendance: -1 });
    expect(axios.put).toHaveBeenCalledWith(
      expect.stringContaining('/record/100/555'),
      { attendance: -1 },
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(out.id).toBe(555);
  });
  test('success:false → бросает', async () => {
    axios.put.mockResolvedValue({ data: { success: false, meta: { message: 'нет' } } });
    await expect(ycUpdateRecord(salon, 555, {})).rejects.toThrow('нет');
  });
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `cd backend && npx jest yclients-records.test.js`
Expected: FAIL — `ycGetRecord is not a function` (хелперов ещё нет).

- [ ] **Step 3: Реализовать хелперы**

В `backend/services/yclients-records.js` заменить строку импорта и добавить функции. Текущий импорт:

```javascript
const { ycHeaders } = require('./yclients');
```

заменить на:

```javascript
const { ycHeaders, ycGet } = require('./yclients');
```

и добавить перед `module.exports`:

```javascript
/**
 * Получить одну запись целиком: GET /record/{company_id}/{record_id}.
 */
async function ycGetRecord(salon, ycRecordId) {
  return ycGet(salon, `/record/${salon.yclients_company_id}/${ycRecordId}`, {});
}

/**
 * Живой список записей клиента: GET /records/{company_id}?client_id=…
 * start_date/end_date — необязательные границы (YYYY-MM-DD).
 */
async function ycGetClientRecords(salon, clientId, { startDate, endDate } = {}) {
  const params = { client_id: clientId, count: 300 };
  if (startDate) params.start_date = startDate;
  if (endDate) params.end_date = endDate;
  const data = await ycGet(salon, `/records/${salon.yclients_company_id}`, params);
  return Array.isArray(data) ? data : [];
}

/**
 * Обновить запись целиком: PUT /record/{company_id}/{record_id}.
 * body — поля записи (attendance, services, datetime, seance_length, staff_id, comment…).
 * Throws on YClients failure.
 */
async function ycUpdateRecord(salon, ycRecordId, body) {
  const url = `${YC}/record/${salon.yclients_company_id}/${ycRecordId}`;
  logger.info(`PUT ${url} keys=${Object.keys(body).join(',')}`);
  const { data } = await axios.put(url, body, { headers: ycHeaders(salon), timeout: 15000 });
  if (!data.success) {
    const msg = data.meta?.message || 'YClients update failed';
    logger.error(`YClients refused update: ${msg}`);
    throw new Error(msg);
  }
  return data.data;
}
```

Обновить экспорт:

```javascript
module.exports = { updateAttendance, ycGetRecord, ycGetClientRecords, ycUpdateRecord };
```

- [ ] **Step 4: Запустить — зелёный**

Run: `cd backend && npx jest yclients-records.test.js`
Expected: PASS (все describe).

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/yclients-records.js backend/yclients-records.test.js
git commit -m "feat(agent): YClients-хелперы чтения и обновления записи (для отмены/переноса)"
```

---

## Task 2: identity.resolveYclientsClientId

**Files:**
- Modify: `backend/services/agent/identity.js`
- Test: `backend/agent-tools.test.js` (покрывается косвенно через tool-тесты Task 4; отдельный тест не нужен)

- [ ] **Step 1: Реализовать функцию**

В `backend/services/agent/identity.js` добавить перед `module.exports`:

```javascript
// YClients client_id пациента по номеру. В таблице clients его нет — берём из
// последней синхронизированной записи (records.yclients_client_id стабилен для
// клиента). Нужен для живого запроса записей и проверки принадлежности при
// отмене/переносе. null, если у клиента нет ни одной синхронизированной записи.
async function resolveYclientsClientId(salonId, rawPhone) {
  const phone = normalizePhoneKey(String(rawPhone || ''));
  if (!salonId || !phone) return null;
  const row = await db.oneOrNone(
    `SELECT r.yclients_client_id AS yc_client_id
       FROM records r
       JOIN clients c ON c.id = r.client_id
      WHERE c.salon_id = $1 AND c.phone LIKE '%' || $2
        AND r.yclients_client_id IS NOT NULL
      ORDER BY r.visit_datetime DESC NULLS LAST
      LIMIT 1`,
    [salonId, phone]);
  return row && row.yc_client_id ? Number(row.yc_client_id) : null;
}
```

Обновить экспорт:

```javascript
module.exports = { resolveClient, resolveYclientsClientId };
```

- [ ] **Step 2: Проверить, что модуль грузится**

Run: `cd backend && node -e "const i=require('./services/agent/identity'); console.log(typeof i.resolveYclientsClientId)"`
Expected: `function`

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/identity.js
git commit -m "feat(agent): resolveYclientsClientId — YClients-id клиента по телефону из records"
```

---

## Task 3: Исполнитель booking-modify (отмена/перенос)

**Files:**
- Create: `backend/services/agent/booking-modify.js`
- Test: `backend/agent-booking-modify.test.js` (create)

- [ ] **Step 1: Написать падающий тест**

Create `backend/agent-booking-modify.test.js`:

```javascript
'use strict';

jest.mock('./db', () => ({ pool: { query: jest.fn() } }));
jest.mock('./services/yclients-records', () => ({
  ycGetRecord: jest.fn(), ycUpdateRecord: jest.fn(),
}));

const { pool } = require('./db');
const ycr = require('./services/yclients-records');
const { cancelBookingRecord, rescheduleBookingRecord, CANCEL_SEANCE_LENGTH } =
  require('./services/agent/booking-modify');

const SALON_ROW = {
  id: 1, yclients_company_id: 100, yclients_partner_token: 'p', yclients_user_token: 'u',
};
const REC = {
  id: 555, attendance: 0, staff_id: 7, datetime: '2026-07-25T12:00:00+03:00',
  seance_length: 3600, comment: 'старый', client: { id: 777, name: 'Аня', phone: '79001112233' },
  services: [{ id: 10, title: 'Пилинг' }],
};

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockImplementation((sql) =>
    /FROM salons/.test(sql) ? Promise.resolve({ rows: [SALON_ROW] }) : Promise.resolve({ rows: [] }));
});

describe('cancelBookingRecord', () => {
  test('ставит attendance -1, 5 мин и добавляет услугу «Запрет на отправку»', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);
    ycr.ycUpdateRecord.mockResolvedValue({ id: 555 });
    const res = await cancelBookingRecord(1, {
      dialogKey: 'd', recordId: 555, expectedYcClientId: 777, noNotifyServiceId: 99,
    });
    expect(res.ok).toBe(true);
    expect(res.no_notify_applied).toBe(true);
    const body = ycr.ycUpdateRecord.mock.calls[0][2];
    expect(body.attendance).toBe(-1);
    expect(body.seance_length).toBe(CANCEL_SEANCE_LENGTH);
    expect(body.services).toEqual([{ id: 10 }, { id: 99 }]);
    // событие записано
    const kinds = pool.query.mock.calls.map(c => c[1]).filter(Boolean).flat();
    expect(kinds).toContain('booking_cancelled');
  });

  test('запись уже отменена (attendance -1) → already, без PUT', async () => {
    ycr.ycGetRecord.mockResolvedValue({ ...REC, attendance: -1 });
    const res = await cancelBookingRecord(1, { dialogKey: 'd', recordId: 555, expectedYcClientId: 777 });
    expect(res.ok).toBe(true);
    expect(res.already).toBe(true);
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test('чужая запись → foreign, без PUT', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC); // client.id=777
    const res = await cancelBookingRecord(1, { dialogKey: 'd', recordId: 555, expectedYcClientId: 888 });
    expect(res.ok).toBe(false);
    expect(res.foreign).toBe(true);
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test('без noNotifyServiceId — отмена всё равно проходит, услуга не добавляется', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);
    ycr.ycUpdateRecord.mockResolvedValue({ id: 555 });
    const res = await cancelBookingRecord(1, { dialogKey: 'd', recordId: 555, expectedYcClientId: 777 });
    expect(res.ok).toBe(true);
    expect(res.no_notify_applied).toBe(false);
    expect(ycr.ycUpdateRecord.mock.calls[0][2].services).toEqual([{ id: 10 }]);
  });
});

describe('rescheduleBookingRecord', () => {
  test('PUT нового datetime, услуги и мастер сохраняются', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);
    ycr.ycUpdateRecord.mockResolvedValue({ id: 555 });
    const res = await rescheduleBookingRecord(1, {
      dialogKey: 'd', recordId: 555, expectedYcClientId: 777,
      datetime: '2026-07-26T15:00:00+03:00',
    });
    expect(res.ok).toBe(true);
    const body = ycr.ycUpdateRecord.mock.calls[0][2];
    expect(body.datetime).toBe('2026-07-26T15:00:00+03:00');
    expect(body.staff_id).toBe(7);
    expect(body.services).toEqual([{ id: 10 }]);
    const kinds = pool.query.mock.calls.map(c => c[1]).filter(Boolean).flat();
    expect(kinds).toContain('booking_rescheduled');
  });

  test('чужая запись → foreign', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);
    const res = await rescheduleBookingRecord(1, {
      dialogKey: 'd', recordId: 555, expectedYcClientId: 888, datetime: '2026-07-26T15:00:00+03:00',
    });
    expect(res.ok).toBe(false);
    expect(res.foreign).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd backend && npx jest agent-booking-modify.test.js`
Expected: FAIL — модуля `booking-modify` ещё нет.

- [ ] **Step 3: Реализовать модуль**

Create `backend/services/agent/booking-modify.js`:

```javascript
'use strict';

const { pool } = require('../../db');
const config = require('../../config');
const { ycGetRecord, ycUpdateRecord } = require('../yclients-records');

// ── Исполнитель отмены и переноса записи агентом. ──
// Отмена — НЕ удаление: помечаем «клиент не пришёл» (attendance=-1), режем
// длительность до 5 минут (освобождаем место в графике мастера) и добавляем
// услугу «Запрет на отправку» (глушит уведомления YClients по записи). Перенос —
// PUT нового datetime с сохранением услуг/мастера. record_id всегда приходит из
// list_client_bookings; принадлежность клиенту проверяем по rec.client.id.
// Спека: docs/superpowers/specs/2026-07-22-agent-cancel-reschedule-design.md.

const CANCEL_SEANCE_LENGTH = 300;   // 5 минут в секундах

// Автор изменения в YClients = владелец User-токена. Если задан отдельный
// YCLIENTS_INTEGRATION_USER_TOKEN (УЗ приложения LoyalPRO) — пишем под ним, как
// и при создании записи (ycCreateRecord), чтобы автор был «LoyalPRO».
function authSalonFor(salon) {
  return config.YCLIENTS_INTEGRATION_USER_TOKEN
    ? { ...salon, yclients_user_token: config.YCLIENTS_INTEGRATION_USER_TOKEN }
    : salon;
}

async function loadSalon(salonId) {
  const salon = (await pool.query(`SELECT * FROM salons WHERE id=$1`, [salonId])).rows[0];
  return salon && salon.yclients_company_id ? salon : null;
}

// Best-effort лог действия. Не должен ломать ответ агенту.
async function logEvent(salonId, dialogKey, kind, toolName, payload) {
  try {
    await pool.query(
      `INSERT INTO agent_events (salon_id, dialog_key, kind, tool_name, payload)
       VALUES ($1,$2,$3,$4,$5)`,
      [salonId, dialogKey, kind, toolName, JSON.stringify(payload)]);
  } catch (_) { /* лог не должен ломать ответ агенту */ }
}

// Услуги записи → формат для PUT [{id}].
function serviceIds(rec) {
  return (Array.isArray(rec.services) ? rec.services : []).map(s => ({ id: s.id }));
}

// Проверка принадлежности записи клиенту. Возвращает строку-ошибку или null.
function ownershipError(rec, expectedYcClientId) {
  if (expectedYcClientId && rec.client && Number(rec.client.id) !== Number(expectedYcClientId)) {
    return 'Запись принадлежит другому клиенту.';
  }
  return null;
}

async function cancelBookingRecord(salonId, { dialogKey, recordId, expectedYcClientId, noNotifyServiceId }) {
  const salon = await loadSalon(salonId);
  if (!salon) return { ok: false, error: 'YClients не подключён для салона.' };

  let rec;
  try { rec = await ycGetRecord(salon, recordId); }
  catch (e) { return { ok: false, error: e.message }; }
  if (!rec || !rec.id) return { ok: false, error: 'Запись не найдена.' };
  if (ownershipError(rec, expectedYcClientId)) return { ok: false, foreign: true, error: ownershipError(rec, expectedYcClientId) };

  // Идемпотентность: уже отменена — второй дубль-вебхук не должен падать.
  if (Number(rec.attendance) === -1) return { ok: true, already: true, record_id: rec.id };

  const services = serviceIds(rec);
  let noNotifyApplied = false;
  if (noNotifyServiceId && !services.some(s => Number(s.id) === Number(noNotifyServiceId))) {
    services.push({ id: noNotifyServiceId });
    noNotifyApplied = true;
  }

  try {
    await ycUpdateRecord(authSalonFor(salon), recordId, {
      staff_id: rec.staff_id,
      services,
      datetime: rec.datetime,
      seance_length: CANCEL_SEANCE_LENGTH,
      attendance: -1,
      comment: rec.comment || '',
    });
  } catch (e) { return { ok: false, error: e.message }; }

  await logEvent(salonId, dialogKey, 'booking_cancelled', 'cancel_booking',
    { record_id: recordId, no_notify_applied: noNotifyApplied });
  return { ok: true, record_id: recordId, no_notify_applied: noNotifyApplied };
}

async function rescheduleBookingRecord(salonId, { dialogKey, recordId, expectedYcClientId, datetime, staffYcId, seanceLength }) {
  const salon = await loadSalon(salonId);
  if (!salon) return { ok: false, error: 'YClients не подключён для салона.' };

  let rec;
  try { rec = await ycGetRecord(salon, recordId); }
  catch (e) { return { ok: false, error: e.message }; }
  if (!rec || !rec.id) return { ok: false, error: 'Запись не найдена.' };
  if (ownershipError(rec, expectedYcClientId)) return { ok: false, foreign: true, error: ownershipError(rec, expectedYcClientId) };

  try {
    await ycUpdateRecord(authSalonFor(salon), recordId, {
      staff_id: staffYcId || rec.staff_id,
      services: serviceIds(rec),
      datetime,
      seance_length: seanceLength || rec.seance_length,
      comment: rec.comment || '',
    });
  } catch (e) { return { ok: false, error: e.message }; }

  await logEvent(salonId, dialogKey, 'booking_rescheduled', 'reschedule_booking',
    { record_id: recordId, datetime });
  return { ok: true, record_id: recordId, datetime };
}

module.exports = { cancelBookingRecord, rescheduleBookingRecord, CANCEL_SEANCE_LENGTH };
```

- [ ] **Step 4: Запустить — зелёный**

Run: `cd backend && npx jest agent-booking-modify.test.js`
Expected: PASS (все кейсы).

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/booking-modify.js backend/agent-booking-modify.test.js
git commit -m "feat(agent): исполнитель отмены (attendance -1 + 5 мин + запрет на отправку) и переноса записи"
```

---

## Task 4: Tool list_client_bookings

**Files:**
- Create: `backend/services/agent/tools/list-client-bookings.js`
- Modify: `backend/agent-tools.test.js`

- [ ] **Step 1: Добавить моки и падающий тест**

В `backend/agent-tools.test.js` в блок моков сверху добавить (рядом с другими `jest.mock`):

```javascript
jest.mock('./services/yclients-records', () => ({
  ycGetClientRecords: jest.fn(), ycGetRecord: jest.fn(), ycUpdateRecord: jest.fn(),
}));
jest.mock('./services/agent/booking-modify', () => ({
  cancelBookingRecord: jest.fn(), rescheduleBookingRecord: jest.fn(),
}));
jest.mock('./services/agent/identity', () => ({
  resolveClient: jest.fn(), resolveYclientsClientId: jest.fn(),
}));
```

Рядом с другими `require` инструментов добавить:

```javascript
const { ycGetClientRecords } = require('./services/yclients-records');
const bookingModify = require('./services/agent/booking-modify');
const identity = require('./services/agent/identity');
const listClientBookings = require('./services/agent/tools/list-client-bookings');
const cancelBooking = require('./services/agent/tools/cancel-booking');
const rescheduleBooking = require('./services/agent/tools/reschedule-booking');
```

В конец файла добавить блок:

```javascript
describe('list_client_bookings', () => {
  test('нет телефона в ctx → reason no_phone', async () => {
    const out = await listClientBookings.run(1, {}, {});
    expect(out.bookings).toEqual([]);
    expect(out.reason).toBe('no_phone');
  });

  test('клиент без yclients_client_id → reason client_not_found', async () => {
    identity.resolveYclientsClientId.mockResolvedValue(null);
    const out = await listClientBookings.run(1, {}, { clientPhone: '79001112233' });
    expect(out.reason).toBe('client_not_found');
    expect(ycGetClientRecords).not.toHaveBeenCalled();
  });

  test('возвращает только будущие и не отменённые записи', async () => {
    identity.resolveYclientsClientId.mockResolvedValue(777);
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    const nowMs = Date.parse('2026-07-22T10:00:00+03:00');
    ycGetClientRecords.mockResolvedValue([
      { id: 1, datetime: '2026-07-25T12:00:00+03:00', attendance: 0,
        services: [{ id: 10, title: 'Пилинг' }], staff_id: 7, staff: { id: 7, name: 'Иванова' } },
      { id: 2, datetime: '2026-07-24T12:00:00+03:00', attendance: -1,  // отменена — отфильтровать
        services: [{ id: 11, title: 'Чистка' }], staff: { id: 8, name: 'Петрова' } },
      { id: 3, datetime: '2026-07-20T12:00:00+03:00', attendance: 0,   // прошлое — отфильтровать
        services: [{ id: 12, title: 'Массаж' }], staff: { id: 9, name: 'Сидорова' } },
    ]);
    const out = await listClientBookings.run(1, {}, { clientPhone: '79001112233', nowMs });
    expect(out.bookings).toHaveLength(1);
    expect(out.bookings[0]).toMatchObject({
      record_id: 1, staff_yc_id: 7, staff_name: 'Иванова', services: ['Пилинг'],
    });
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd backend && npx jest agent-tools.test.js -t list_client_bookings`
Expected: FAIL — модуля `list-client-bookings` нет.

- [ ] **Step 3: Реализовать tool**

Create `backend/services/agent/tools/list-client-bookings.js`:

```javascript
'use strict';

const { db } = require('../../../db');
const identity = require('../identity');
const { ycGetClientRecords } = require('../../yclients-records');

const schema = {
  name: 'list_client_bookings',
  description: 'Показать БУДУЩИЕ записи текущего пациента — для отмены или переноса. ' +
    'Телефон берётся из системы автоматически, аргументы не нужны. Возвращает список ' +
    'записей: record_id, дата/время, услуга(и), мастер. record_id из этого списка ' +
    'передавай в cancel_booking / reschedule_booking — НИКОГДА не придумывай его.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

// YYYY-MM-DD по Москве — нижняя граница живого запроса записей.
function moscowDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(ms));
}

async function run(salonId, _input, ctx = {}) {
  const phone = String((ctx && ctx.clientPhone) || '').trim();
  if (!phone) {
    return { bookings: [], reason: 'no_phone',
      note: 'Телефон пациента неизвестен — вежливо попроси номер, чтобы найти его записи.' };
  }
  const ycClientId = await identity.resolveYclientsClientId(salonId, phone);
  if (!ycClientId) {
    return { bookings: [], reason: 'client_not_found',
      note: 'Активных записей у пациента не найдено — предложи создать новую запись.' };
  }
  const salon = await db.one(
    `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
       FROM salons WHERE id=$1`, [salonId]);
  if (!salon.yclients_company_id) return { bookings: [], reason: 'no_yclients' };

  const nowMs = (ctx && ctx.nowMs) || Date.now();
  let recs;
  try { recs = await ycGetClientRecords(salon, ycClientId, { startDate: moscowDate(nowMs) }); }
  catch (e) { return { bookings: [], error: `Не удалось получить записи: ${e.message}` }; }

  const bookings = recs
    .filter(r => Number(r.attendance) !== -1 && !r.deleted)
    .filter(r => {
      const t = Date.parse(r.datetime || r.date || '');
      return !Number.isFinite(t) || t >= nowMs;   // прошлое отбрасываем
    })
    .map(r => ({
      record_id: r.id,
      datetime: r.datetime || r.date || null,
      services: (Array.isArray(r.services) ? r.services : []).map(s => s.title).filter(Boolean),
      staff_yc_id: r.staff_id || (r.staff && r.staff.id) || null,
      staff_name: (r.staff && r.staff.name) || null,
    }));
  return { bookings };
}

module.exports = { schema, run };
```

- [ ] **Step 4: Запустить — зелёный**

Run: `cd backend && npx jest agent-tools.test.js -t list_client_bookings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/tools/list-client-bookings.js backend/agent-tools.test.js
git commit -m "feat(agent): tool list_client_bookings — живой список будущих записей клиента"
```

---

## Task 5: Tool cancel_booking

**Files:**
- Create: `backend/services/agent/tools/cancel-booking.js`
- Modify: `backend/agent-tools.test.js`

- [ ] **Step 1: Написать падающий тест**

В конец `backend/agent-tools.test.js` добавить:

```javascript
describe('cancel_booking', () => {
  test('нет record_id → invalid_args', async () => {
    const out = await cancelBooking.run(1, {}, { clientPhone: '79001112233' });
    expect(out.invalid_args).toBe(true);
    expect(bookingModify.cancelBookingRecord).not.toHaveBeenCalled();
  });

  test('услуга «Запрет на отправку» найдена → отмена без предупреждения', async () => {
    identity.resolveYclientsClientId.mockResolvedValue(777);
    jest.spyOn(listServices, 'run').mockResolvedValue({
      services: [{ yc_id: 10, title: 'Пилинг' }, { yc_id: 99, title: 'Запрет на отправку' }],
    });
    bookingModify.cancelBookingRecord.mockResolvedValue({ ok: true, record_id: 555, no_notify_applied: true });
    const out = await cancelBooking.run(1, { record_id: 555 }, { clientPhone: '79001112233', dialogKey: 'd' });
    expect(out.cancelled).toBe(true);
    expect(out.no_notify_warning).toBe(false);
    // услуга «Запрет на отправку» (yc_id 99) передана в исполнитель
    expect(bookingModify.cancelBookingRecord.mock.calls[0][1].noNotifyServiceId).toBe(99);
    expect(bookingModify.cancelBookingRecord.mock.calls[0][1].expectedYcClientId).toBe(777);
    listServices.run.mockRestore();
  });

  test('услуги «Запрет на отправку» нет в каталоге → no_notify_warning:true', async () => {
    identity.resolveYclientsClientId.mockResolvedValue(777);
    jest.spyOn(listServices, 'run').mockResolvedValue({ services: [{ yc_id: 10, title: 'Пилинг' }] });
    bookingModify.cancelBookingRecord.mockResolvedValue({ ok: true, record_id: 555, no_notify_applied: false });
    const out = await cancelBooking.run(1, { record_id: 555 }, { clientPhone: '79001112233', dialogKey: 'd' });
    expect(out.cancelled).toBe(true);
    expect(out.no_notify_warning).toBe(true);
    expect(bookingModify.cancelBookingRecord.mock.calls[0][1].noNotifyServiceId).toBeNull();
    listServices.run.mockRestore();
  });

  test('исполнитель вернул foreign → error проброшен, cancelled нет', async () => {
    identity.resolveYclientsClientId.mockResolvedValue(888);
    jest.spyOn(listServices, 'run').mockResolvedValue({ services: [] });
    bookingModify.cancelBookingRecord.mockResolvedValue({ ok: false, foreign: true, error: 'чужая' });
    const out = await cancelBooking.run(1, { record_id: 555 }, { clientPhone: '79001112233' });
    expect(out.cancelled).toBeUndefined();
    expect(out.error).toBe('чужая');
    listServices.run.mockRestore();
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd backend && npx jest agent-tools.test.js -t cancel_booking`
Expected: FAIL — модуля `cancel-booking` нет.

- [ ] **Step 3: Реализовать tool**

Create `backend/services/agent/tools/cancel-booking.js`:

```javascript
'use strict';

const bookingModify = require('../booking-modify');
const identity = require('../identity');
const listServices = require('./list-services');

const schema = {
  name: 'cancel_booking',
  description: 'ОТМЕНИТЬ запись пациента. Вызывать ТОЛЬКО после того, как пациент подтвердил ' +
    'отмену И отказался от переноса (сначала всегда предлагай перенос — см. сценарий отмены/переноса ' +
    'в промпте). record_id бери из list_client_bookings — НИКОГДА не придумывай.',
  input_schema: {
    type: 'object',
    properties: {
      record_id: { type: 'integer', description: 'YClients-id записи из list_client_bookings.' },
    },
    required: ['record_id'],
    additionalProperties: false,
  },
};

// Услуга-флаг «Запрет на отправку» глушит уведомления YClients по записи.
// Ищем её в каталоге по нормализованному названию (отдельной настройки нет).
const NO_NOTIFY_TITLE = 'запрет на отправку';
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

async function findNoNotifyServiceId(salonId) {
  let catalog = null;
  try { catalog = await listServices.run(salonId); } catch (_) { return null; }
  const svc = (catalog && Array.isArray(catalog.services) ? catalog.services : [])
    .find(s => norm(s.title).includes(NO_NOTIFY_TITLE));
  return svc ? svc.yc_id : null;
}

async function run(salonId, input, ctx = {}) {
  const recordId = input && input.record_id;
  if (!recordId) return { invalid_args: true, error: 'Нужен record_id из list_client_bookings.' };

  const expectedYcClientId = await identity.resolveYclientsClientId(salonId, ctx.clientPhone);
  const noNotifyServiceId = await findNoNotifyServiceId(salonId);

  const res = await bookingModify.cancelBookingRecord(salonId, {
    dialogKey: ctx.dialogKey || ctx.clientPhone,
    recordId,
    expectedYcClientId,
    noNotifyServiceId,
  });
  if (!res.ok) return { error: res.error, foreign: res.foreign };
  return {
    cancelled: true,
    record_id: res.record_id,
    already: !!res.already,
    // услуга «Запрет на отправку» не найдена в каталоге → уведомления могли не заглушиться
    no_notify_warning: !noNotifyServiceId,
  };
}

module.exports = { schema, run };
```

- [ ] **Step 4: Запустить — зелёный**

Run: `cd backend && npx jest agent-tools.test.js -t cancel_booking`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/tools/cancel-booking.js backend/agent-tools.test.js
git commit -m "feat(agent): tool cancel_booking — отмена с услугой «Запрет на отправку»"
```

---

## Task 6: Tool reschedule_booking

**Files:**
- Create: `backend/services/agent/tools/reschedule-booking.js`
- Modify: `backend/agent-tools.test.js`

- [ ] **Step 1: Написать падающий тест**

В конец `backend/agent-tools.test.js` добавить:

```javascript
describe('reschedule_booking', () => {
  test('нет datetime → invalid_args', async () => {
    const out = await rescheduleBooking.run(1, { record_id: 555 }, { clientPhone: '79001112233' });
    expect(out.invalid_args).toBe(true);
    expect(bookingModify.rescheduleBookingRecord).not.toHaveBeenCalled();
  });

  test('делегирует в исполнитель и возвращает rescheduled', async () => {
    identity.resolveYclientsClientId.mockResolvedValue(777);
    bookingModify.rescheduleBookingRecord.mockResolvedValue({
      ok: true, record_id: 555, datetime: '2026-07-26T15:00:00+03:00',
    });
    const out = await rescheduleBooking.run(1,
      { record_id: 555, datetime: '2026-07-26T15:00:00+03:00' },
      { clientPhone: '79001112233', dialogKey: 'd' });
    expect(out.rescheduled).toBe(true);
    expect(out.datetime).toBe('2026-07-26T15:00:00+03:00');
    expect(bookingModify.rescheduleBookingRecord.mock.calls[0][1]).toMatchObject({
      recordId: 555, expectedYcClientId: 777, datetime: '2026-07-26T15:00:00+03:00',
    });
  });

  test('исполнитель вернул ошибку → error проброшен', async () => {
    identity.resolveYclientsClientId.mockResolvedValue(777);
    bookingModify.rescheduleBookingRecord.mockResolvedValue({ ok: false, error: 'занято' });
    const out = await rescheduleBooking.run(1,
      { record_id: 555, datetime: '2026-07-26T15:00:00+03:00' }, { clientPhone: '79001112233' });
    expect(out.rescheduled).toBeUndefined();
    expect(out.error).toBe('занято');
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd backend && npx jest agent-tools.test.js -t reschedule_booking`
Expected: FAIL — модуля `reschedule-booking` нет.

- [ ] **Step 3: Реализовать tool**

Create `backend/services/agent/tools/reschedule-booking.js`:

```javascript
'use strict';

const bookingModify = require('../booking-modify');
const identity = require('../identity');

const schema = {
  name: 'reschedule_booking',
  description: 'ПЕРЕНЕСТИ запись пациента на новое время. record_id бери из list_client_bookings; ' +
    'datetime — ТОЧНУЮ строку из get_available_slots.datetime (…+03:00), не собирай вручную. ' +
    'Вызывать ТОЛЬКО после того, как пациент подтвердил новый слот. По умолчанию услуга и мастер ' +
    'сохраняются (staff_yc_id передавай, только если пациент меняет мастера).',
  input_schema: {
    type: 'object',
    properties: {
      record_id:     { type: 'integer', description: 'YClients-id записи из list_client_bookings.' },
      datetime:      { type: 'string',  description: 'ISO datetime нового слота из get_available_slots.datetime (с +03:00).' },
      staff_yc_id:   { type: 'integer', description: 'Новый мастер (необязательно; по умолчанию прежний).' },
      seance_length: { type: 'integer', description: 'Длительность из слота, если известна (необязательно).' },
    },
    required: ['record_id', 'datetime'],
    additionalProperties: false,
  },
};

async function run(salonId, input, ctx = {}) {
  const recordId = input && input.record_id;
  const datetime = input && input.datetime;
  if (!recordId || !datetime) return { invalid_args: true, error: 'Нужны record_id и datetime.' };

  const expectedYcClientId = await identity.resolveYclientsClientId(salonId, ctx.clientPhone);
  const res = await bookingModify.rescheduleBookingRecord(salonId, {
    dialogKey: ctx.dialogKey || ctx.clientPhone,
    recordId,
    expectedYcClientId,
    datetime,
    staffYcId: input.staff_yc_id,
    seanceLength: input.seance_length,
  });
  if (!res.ok) return { error: res.error, foreign: res.foreign };
  return { rescheduled: true, record_id: res.record_id, datetime: res.datetime };
}

module.exports = { schema, run };
```

- [ ] **Step 4: Запустить — зелёный**

Run: `cd backend && npx jest agent-tools.test.js -t reschedule_booking`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/tools/reschedule-booking.js backend/agent-tools.test.js
git commit -m "feat(agent): tool reschedule_booking — перенос записи на новое время"
```

---

## Task 7: Регистрация инструментов + SIDE_EFFECT_TOOLS

**Files:**
- Modify: `backend/services/agent/tools/index.js`
- Modify: `backend/services/agent/orchestrator.js`

- [ ] **Step 1: Написать падающий тест регистрации**

В конец `backend/agent-tools.test.js` добавить:

```javascript
describe('реестр инструментов', () => {
  test('новые инструменты зарегистрированы', () => {
    const registry = require('./services/agent/tools');
    const names = registry.schemas.map(s => s.name);
    expect(names).toContain('list_client_bookings');
    expect(names).toContain('cancel_booking');
    expect(names).toContain('reschedule_booking');
    expect(typeof registry.handlers.cancel_booking).toBe('function');
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd backend && npx jest agent-tools.test.js -t "реестр инструментов"`
Expected: FAIL — имён нет в реестре.

- [ ] **Step 3: Зарегистрировать инструменты**

В `backend/services/agent/tools/index.js` после строки `const escalate = require('./escalate-to-operator');` добавить:

```javascript
const listBookings = require('./list-client-bookings');
const cancelBk  = require('./cancel-booking');
const reschedBk = require('./reschedule-booking');
```

и изменить массив `tools`:

```javascript
const tools = [searchKb, listSvc, listStaff, getSlots, getParSlot, getDates, getClient,
  createBk, listBookings, cancelBk, reschedBk, escalate];
```

- [ ] **Step 4: Добавить в SIDE_EFFECT_TOOLS**

В `backend/services/agent/orchestrator.js:20` заменить:

```javascript
const SIDE_EFFECT_TOOLS = new Set(['create_booking', 'escalate_to_operator']);
```

на:

```javascript
const SIDE_EFFECT_TOOLS = new Set([
  'create_booking', 'cancel_booking', 'reschedule_booking', 'escalate_to_operator',
]);
```

- [ ] **Step 5: Запустить — зелёный**

Run: `cd backend && npx jest agent-tools.test.js -t "реестр инструментов"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/tools/index.js backend/services/agent/orchestrator.js backend/agent-tools.test.js
git commit -m "feat(agent): регистрация cancel/reschedule tool + side-effect защита"
```

---

## Task 8: Системный промпт — Сценарий 4 (отмена/перенос)

**Files:**
- Modify: `backend/services/agent/system-prompt.js`
- Modify: `backend/agent-system-prompt.test.js`

- [ ] **Step 1: Написать падающие тесты промпта**

В `backend/agent-system-prompt.test.js` внутри `describe('buildSystemPrompt', …)` добавить:

```javascript
test('Сценарий 4 — упоминает инструменты отмены/переноса', () => {
  const p = buildSystemPrompt({});
  expect(p).toContain('list_client_bookings');
  expect(p).toContain('cancel_booking');
  expect(p).toContain('reschedule_booking');
});

test('при отмене сначала предлагает перенос', () => {
  const p = buildSystemPrompt({});
  expect(p).toMatch(/сначала[^]*предложи[^]*перенест/i);
});

test('при переносе уточняет какую запись, если их несколько', () => {
  const p = buildSystemPrompt({});
  expect(p).toMatch(/если записей несколько[^]*уточни, какую/i);
});

test('требует согласие и запрещает подтверждать до успеха инструмента', () => {
  const p = buildSystemPrompt({});
  expect(p).toMatch(/cancelled:true/);
  expect(p).toMatch(/rescheduled:true/);
  expect(p).toMatch(/ТОЛЬКО после явного подтвержд/i);
});

test('отмена/перенос только для идентифицированного пациента', () => {
  const p = buildSystemPrompt({});
  expect(p).toMatch(/ТОЛЬКО идентифицированному пациенту/i);
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd backend && npx jest agent-system-prompt.test.js -t "Сценарий 4"`
Expected: FAIL — блока Сценария 4 нет.

- [ ] **Step 3: Добавить блок в промпт**

В `backend/services/agent/system-prompt.js` в возвращаемом массиве, ПОСЛЕ строки `id мастера и услуги для create_booking бери ТОЛЬКО из list_services…` (последняя строка Сценария 2, перед `` `` `` и `СЦЕНАРИЙ 3`), вставить:

```javascript
    ``,
    `СЦЕНАРИЙ 4 — Отмена и перенос записи:`,
    `Отмена и перенос доступны ТОЛЬКО идентифицированному пациенту (его номер известен системе — см. блок «ИДЕНТИФИКАЦИЯ ПАЦИЕНТА»). Если номер неизвестен — вежливо попроси номер телефона, чтобы найти записи, и только потом продолжай. Все записи и record_id бери ТОЛЬКО из list_client_bookings — придумывать record_id НЕЛЬЗЯ.`,
    `ОТМЕНА — если пациент просит отменить запись:`,
    `- Шаг 1. Сначала мягко предложи ПЕРЕНЕСТИ запись на другой день, чтобы не терять место (например: «Понимаю вас 🌸 Возможно, вам будет удобнее перенести визит на другой день, чтобы не потерять запись?»). Прояви заботу, не дави.`,
    `- Шаг 2. Если пациент согласен на перенос — переходи к блоку ПЕРЕНОС ниже.`,
    `- Шаг 3. Если пациент отказывается и настаивает на отмене — вызови cancel_booking с record_id нужной записи. Если запись не уточнена, а их несколько — сначала уточни, какую именно отменить (назови услугу и дату/время каждой).`,
    `ПЕРЕНОС — если пациент просит перенести запись:`,
    `- Шаг 1. Вызови list_client_bookings и посмотри будущие записи пациента.`,
    `- Шаг 2. Если записей несколько и пациент НЕ указал явно какую переносить — уточни, какую именно запись перенести (назови услугу и дату/время каждой). Если запись одна — не переспрашивай.`,
    `- Шаг 3. Уточни, на какую ДАТУ пациент хочет перенести запись.`,
    `- Шаг 4. Вызови get_available_slots для мастера этой записи на новую дату и предложи 1–2 конкретных слота (как в Сценарии 2). Никогда не называй время «на глаз».`,
    `- Шаг 5. После того как пациент подтвердил новый слот — вызови reschedule_booking с record_id и ТОЧНЫМ datetime из get_available_slots.`,
    `СОГЛАСИЕ: cancel_booking и reschedule_booking вызывай ТОЛЬКО после явного подтверждения пациента (для отмены — что он точно хочет отменить и отказался от переноса; для переноса — что выбранный новый слот ему подходит).`,
    `⛔ ОТМЕНА/ПЕРЕНОС СЧИТАЮТСЯ ВЫПОЛНЕННЫМИ ТОЛЬКО ПОСЛЕ УСПЕШНОГО ВЫЗОВА ИНСТРУМЕНТА. НИКОГДА не пиши «отменила», «перенесла», «готово», пока cancel_booking не вернул cancelled:true или reschedule_booking не вернул rescheduled:true. Если инструмент вернул ошибку — не подтверждай, извинись и вызови escalate_to_operator.`,
    `Если list_client_bookings вернул пусто (reason client_not_found или список пуст) — мягко скажи, что не видишь активных записей, и предложи создать новую запись или соединить с администратором. Никогда не выдумывай записи, которых нет.`,
```

- [ ] **Step 4: Запустить — зелёный**

Run: `cd backend && npx jest agent-system-prompt.test.js`
Expected: PASS (новые кейсы + старые не сломаны).

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/system-prompt.js backend/agent-system-prompt.test.js
git commit -m "feat(agent): Сценарий 4 в промпте — отмена (с предложением переноса) и перенос записи"
```

---

## Task 9: Полный прогон тестов агента

**Files:** (нет правок — только верификация)

- [ ] **Step 1: Прогнать все агентские тесты**

Run: `cd backend && npx jest agent-tools agent-system-prompt agent-booking-modify yclients-records agent-orchestrator`
Expected: PASS во всех сьютах, 0 failed.

- [ ] **Step 2: Прогнать весь бэкенд-jest (регресс)**

Run: `cd backend && npx jest`
Expected: PASS. Если какой-то ранее зелёный сьют упал — чинить до зелёного (не игнорировать).

- [ ] **Step 3: Синтаксическая загрузка ключевых модулей**

Run: `cd backend && node -e "require('./services/agent/tools'); require('./services/agent/booking-modify'); require('./services/agent/system-prompt'); console.log('ok')"`
Expected: `ok`

---

## Self-Review Notes (проверено против спеки)

- **Отмена = attendance −1 + 5 мин + «Запрет на отправку»** → Task 3 (`CANCEL_SEANCE_LENGTH=300`, добавление услуги), Task 5 (поиск услуги по названию).
- **Услуга «Запрет на отправку» по названию** → Task 5 `findNoNotifyServiceId` (нормализованный `includes`).
- **Живой запрос записей в YClients** → Task 1 `ycGetClientRecords`, Task 4 tool.
- **Уточнить какую запись / предложить перенос до отмены / согласие / ⛔-после-успеха / гейт личности** → Task 8 (промпт) + тесты.
- **Проверка принадлежности (чужая запись)** → Task 3 `ownershipError`, тесты в Task 3/5.
- **Идемпотентность повторной отмены** → Task 3 (attendance −1 → already).
- **SIDE_EFFECT_TOOLS** → Task 7.
- **Только будущие записи** → Task 4 (фильтр `t >= nowMs` + `start_date`).
- **Автор изменения = LoyalPRO (integration token)** → Task 3 `authSalonFor`.
- Типы согласованы: tool → `bookingModify.cancelBookingRecord/rescheduleBookingRecord` (`{ok, foreign, error, already, no_notify_applied, record_id, datetime}`); `identity.resolveYclientsClientId(salonId, phone)`; хелперы `ycGetRecord/ycGetClientRecords/ycUpdateRecord`.
