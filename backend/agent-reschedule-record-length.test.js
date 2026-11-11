'use strict';

// Инцидент 2026-11-11 (прод, WhatsApp 79166123348, запись 2085514739 к Пери):
// запись 17.11 12:00 из ТРЁХ услуг (Profhilo + Lumecca + 600 ИМП), длина 75 мин.
// Перенос на 19.11: get_available_slots(service=Profhilo) считал окна под одну
// услугу (30 мин) → «12:00 свободно», пациентка «да», reschedule_booking →
// YClients «Выбранное время недоступно» (в 13:00 у врача чужая запись) → Мила
// перевела диалог на администратора, хотя 15:15–15:45 вся запись помещалась.
// Три слоя: (1) слоты под ВСЮ запись (record_id / автоматически), (2) гейт
// short_slot в booking-modify, (3) свежие старты под запись на отказ YClients.

jest.mock('./db', () => ({
  db: {
    one: jest.fn(async () => ({ id: 1, yclients_company_id: 100 })),
    oneOrNone: jest.fn(async () => ({ id: 1, yclients_company_id: 100 })),
    any: jest.fn(async () => []),
  },
  pool: { query: jest.fn(async (sql) => (/FROM salons/.test(sql)
    ? { rows: [{ id: 1, yclients_company_id: 100, yclients_partner_token: 'p', yclients_user_token: 'u' }] }
    : { rows: [] })) },
}));
jest.mock('./services/yclients-booking', () => ({
  ycGetBookTimes: jest.fn(async () => []),
  ycGetStaffSeances: jest.fn(async () => []),
  ycGetStaffSchedule: jest.fn(async () => []),
  ycGetDayRecords: jest.fn(async () => []),
}));
jest.mock('./services/yclients-records', () => ({ ycGetRecord: jest.fn(), ycUpdateRecord: jest.fn() }));
jest.mock('./services/agent-settings', () => ({ loadServiceFilterSafe: jest.fn(async () => ({})) }));
jest.mock('./services/agent/service-filter', () => ({
  isBookable: jest.fn(() => true),
  decideServiceVisible: jest.fn(() => true),
}));
jest.mock('./services/agent/staff-service-guard', () => ({
  checkStaffPerformsService: jest.fn(async () => ({ ok: true, unknown: false, performers: [],
    staffList: [{ yc_id: 1910274, name: 'Гаджиева Пери' }] })),
}));
jest.mock('./services/agent/equipment-context', () => ({
  loadEquipmentContext: jest.fn(async () => ({})),
  durationMin: jest.fn(() => 30),              // Profhilo в YClients — 30 мин
  instancesFor: jest.fn(() => []),
  busyForService: jest.fn(() => []),
}));
jest.mock('./services/agent/identity', () => ({ resolveYclientsClientId: jest.fn(async () => 777) }));

const { ycGetBookTimes, ycGetStaffSeances } = require('./services/yclients-booking');
const ycr = require('./services/yclients-records');
const slotsTool = require('./services/agent/tools/get-available-slots');
const reschedule = require('./services/agent/tools/reschedule-booking');
const { rescheduleBookingRecord } = require('./services/agent/booking-modify');
const { createSlotEvidence } = require('./services/agent/slot-evidence');

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

// Боевой день Пери 19.11: смена 12:00–18:00, занято 13:00–15:15 и 17:00–18:00.
const DAY_19 = grid('12:00', '18:00', [['13:00', '14:00'], ['14:00', '15:15'], ['17:00', '18:00']]);
const NOW = Date.parse('2026-11-11T09:10:30+03:00');
const PERI = 1910274;
const PROFHILO = 9536495;
const RECORD = {
  record_id: 2085514739, datetime: '2026-11-17T12:00:00+03:00', staff_yc_id: PERI, staff_name: 'Гаджиева Пери',
  services: ['Profhilo 2 ml ( 60 минут )', 'Фотоомоложение Lumeca - лицо', '600 ИМП Лицо лечение'],
  service_yc_ids: [PROFHILO, 15394152, 26099275], seance_length: 4500,
};
const CTX = { nowMs: NOW, liveBookings: [RECORD] };
const ARGS = { staff_yc_id: PERI, service_yc_id: PROFHILO, date: '2026-11-19' };

beforeEach(() => {
  jest.clearAllMocks();
  ycGetBookTimes.mockResolvedValue([]);
  ycGetStaffSeances.mockResolvedValue(DAY_19);
});

describe('get_available_slots: окна под ВСЮ переносимую запись', () => {
  test('до фикса (новый визит): под одну услугу 12:00 «свободно»', async () => {
    const res = await slotsTool.run(1, { ...ARGS, new_visit: true }, CTX);
    expect(res.slots.map(s => s.time)).toContain('12:00');
    expect(res.record_length_applied).toBeUndefined();
  });

  test('боевой вызов БЕЗ record_id: многоуслужная запись подхвачена автоматически, 12:00 нет', async () => {
    const res = await slotsTool.run(1, ARGS, CTX);
    const times = res.slots.map(s => s.time);
    expect(times).not.toContain('12:00');
    expect(times).not.toContain('12:30');
    expect(times).toEqual(['15:30']);            // 15:30 + 75 мин = 16:45 < 17:00 (сетка 30 мин)
    expect(res.slots[0].seance_length).toBe(4500);
    expect(res.record_length_applied).toEqual({ record_id: 2085514739, minutes: 75 });
    expect(res.hint).toMatch(/new_visit:true/);
  });

  test('явный record_id — то же, без оговорки про new_visit', async () => {
    const res = await slotsTool.run(1, { ...ARGS, record_id: 2085514739 }, CTX);
    expect(res.slots.map(s => s.time)).toEqual(['15:30']);
    expect(res.hint).not.toMatch(/new_visit/);
  });

  test('при длине записи онлайн-запись (старты под одну услугу) не используется', async () => {
    ycGetBookTimes.mockResolvedValue([{ time: '12:00', datetime: '2026-11-19T12:00:00+03:00', seance_length: 1800 }]);
    const res = await slotsTool.run(1, { ...ARGS, record_id: 2085514739 }, CTX);
    expect(ycGetBookTimes).not.toHaveBeenCalled();
    expect(res.slots.map(s => s.time)).toEqual(['15:30']);
  });

  test('односервисная запись автоматически НЕ применяется (повторная запись на ту же услугу обычна)', () => {
    const single = { ...RECORD, service_yc_ids: [PROFHILO] };
    expect(slotsTool.resolveRecordContext(ARGS, { liveBookings: [single] }, PROFHILO)).toBeNull();
    expect(slotsTool.resolveRecordContext({ ...ARGS, record_id: RECORD.record_id }, { liveBookings: [single] }, PROFHILO))
      .toMatchObject({ lenMin: 75, auto: false });
  });

  test('чужой record_id (нет среди записей пациента) — ничего не применяет', () => {
    expect(slotsTool.resolveRecordContext({ ...ARGS, record_id: 1 }, CTX, PROFHILO)).toBeNull();
  });

  test('две подходящие многоуслужные записи — автоматом не выбираем', () => {
    const two = [RECORD, { ...RECORD, record_id: 2 }];
    expect(slotsTool.resolveRecordContext(ARGS, { liveBookings: two }, PROFHILO)).toBeNull();
  });
});

describe('slot-evidence: длительность слота', () => {
  test('слот под одну услугу не подтверждает перенос записи на 75 мин; под всю запись — подтверждает', () => {
    const ev = createSlotEvidence();
    ev.add('get_available_slots', ARGS, { slots: [{ datetime: '2026-11-19T12:00:00+03:00', seance_length: 1800 }] });
    expect(ev.has('2026-11-19T12:00:00+03:00', { staffYcId: PERI, serviceYcIds: RECORD.service_yc_ids })).toBe(true);
    expect(ev.has('2026-11-19T12:00:00+03:00', { staffYcId: PERI, serviceYcIds: RECORD.service_yc_ids, minLengthSec: 4500 })).toBe(false);
    ev.add('get_available_slots', ARGS, { slots: [{ datetime: '2026-11-19T15:30:00+03:00', seance_length: 4500 }] });
    expect(ev.has('2026-11-19T15:30:00+03:00', { staffYcId: PERI, serviceYcIds: RECORD.service_yc_ids, minLengthSec: 4500 })).toBe(true);
  });

  test('строка без длительности (стыковка/старый журнал) — fail-open', () => {
    const ev = createSlotEvidence();
    ev.add('get_available_slots', ARGS, { slots: [{ datetime: '2026-11-19T12:00:00+03:00' }] });
    expect(ev.has('2026-11-19T12:00:00+03:00', { staffYcId: PERI, minLengthSec: 4500 })).toBe(true);
  });

  test('свежие старты из отказа reschedule_booking попадают в evidence', () => {
    const ev = createSlotEvidence();
    ev.add('reschedule_booking', { record_id: 5, datetime: '2026-11-19T12:00:00+03:00' }, {
      error: 'x', slot_unavailable: true, staff_yc_id: PERI, service_yc_id: PROFHILO,
      available_slots: [{ datetime: '2026-11-19T15:30:00+03:00', seance_length: 4500 }],
    });
    expect(ev.has('2026-11-19T15:30:00+03:00', { staffYcId: PERI, serviceYcIds: [PROFHILO], minLengthSec: 4500 })).toBe(true);
    expect(ev.has('2026-11-19T12:00:00+03:00')).toBe(false);
  });
});

const YC_REC = {
  id: 2085514739, attendance: 0, staff_id: PERI, datetime: '2026-11-17T12:00:00+03:00', seance_length: 4500,
  comment: '', client: { id: 777, name: 'Гаяна', phone: '79166123348' },
  services: [{ id: PROFHILO }, { id: 15394152 }, { id: 26099275 }],
};

describe('booking-modify: гейт short_slot и сохранение длительности', () => {
  test('боевой случай: слот 12:00 под одну услугу → shortSlot, PUT не идёт', async () => {
    ycr.ycGetRecord.mockResolvedValue(YC_REC);
    const ev = createSlotEvidence();
    ev.add('get_available_slots', ARGS, { slots: [{ datetime: '2026-11-19T12:00:00+03:00', seance_length: 1800 }] });
    const res = await rescheduleBookingRecord(1, { recordId: YC_REC.id, expectedYcClientId: 777,
      datetime: '2026-11-19T12:00:00+03:00', slotEvidence: ev });
    expect(res.ok).toBe(false);
    expect(res.shortSlot).toBe(true);
    expect(res.error).toMatch(/record_id=2085514739/);
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test('слот под всю запись → PUT, длительность записи сохраняется (не 1800 из аргумента)', async () => {
    ycr.ycGetRecord.mockResolvedValue(YC_REC);
    ycr.ycUpdateRecord.mockResolvedValue({ id: YC_REC.id });
    const ev = createSlotEvidence();
    ev.add('get_available_slots', ARGS, { slots: [{ datetime: '2026-11-19T15:30:00+03:00', seance_length: 4500 }] });
    const res = await rescheduleBookingRecord(1, { recordId: YC_REC.id, expectedYcClientId: 777,
      datetime: '2026-11-19T15:30:00+03:00', seanceLength: 1800, slotEvidence: ev });
    expect(res.ok).toBe(true);
    expect(ycr.ycUpdateRecord.mock.calls[0][2].seance_length).toBe(4500);
  });
});

describe('reschedule_booking: инструмент', () => {
  const consent = {
    clientPhone: '79166123348', nowMs: NOW, liveBookings: [RECORD],
    previousAssistantText: 'В четверг, 19 ноября, 12:00 — переносим?', patientLastText: 'да',
    recentDialogText: 'В четверг, 19 ноября, 12:00 — переносим?\nда',
  };

  test('short_slot — hint, не провал переноса', async () => {
    ycr.ycGetRecord.mockResolvedValue(YC_REC);
    const ev = createSlotEvidence();
    ev.add('get_available_slots', ARGS, { slots: [{ datetime: '2026-11-19T12:00:00+03:00', seance_length: 1800 }] });
    const res = await reschedule.run(1, { record_id: YC_REC.id, datetime: '2026-11-19T12:00:00+03:00', patient_confirmed: true },
      { ...consent, slotEvidence: ev });
    expect(res.short_slot).toBe(true);
    expect(reschedule.isHintResult(res)).toBe(true);
  });

  test('YClients «время недоступно» → свежие старты ПОД ВСЮ запись, а не голая ошибка', async () => {
    ycr.ycGetRecord.mockResolvedValue(YC_REC);
    ycr.ycUpdateRecord.mockRejectedValue(new Error('Выбранное время недоступно. Выберите другое время.'));
    const res = await reschedule.run(1, { record_id: YC_REC.id, datetime: '2026-11-19T12:00:00+03:00', patient_confirmed: true },
      consent);   // без slotEvidence — гейты fail-open, доходим до YClients
    expect(res.slot_unavailable).toBe(true);
    expect(res.available_slots.map(s => s.time)).toEqual(['15:30']);
    expect(res.available_slots[0].seance_length).toBe(4500);
    expect(res.staff_yc_id).toBe(PERI);
    expect(res.error).toMatch(/не повод передавать диалог администратору/);
    expect(reschedule.isHintResult(res)).toBe(false);   // настоящий отказ YClients
  });

  test('прочие ошибки YClients — как раньше, без перезапроса слотов', async () => {
    ycr.ycGetRecord.mockResolvedValue(YC_REC);
    ycr.ycUpdateRecord.mockRejectedValue(new Error('Request failed with status code 500'));
    const res = await reschedule.run(1, { record_id: YC_REC.id, datetime: '2026-11-19T12:00:00+03:00', patient_confirmed: true },
      consent);
    expect(res.error).toMatch(/500/);
    expect(res.slot_unavailable).toBeUndefined();
    expect(ycGetStaffSeances).not.toHaveBeenCalled();
  });
});
