'use strict';

// Инцидент 2026-09-19 (79651442032): «Можно перенести на пн утро?» → модель
// первым действием позвала reschedule_booking на 21.09 10:00 и 11:00 — без
// единого слот-вызова (времена выдуманы, у мастера выходной) и без согласия.
// Правила «datetime из get_available_slots» и «только после подтверждения»
// были промпт-only. Теперь оба — гейты инструмента до похода в YClients.

jest.mock('./services/agent/booking-modify', () => ({
  rescheduleBookingRecord: jest.fn(async (_s, a) => ({ ok: true, record_id: a.recordId, datetime: a.datetime })),
}));
jest.mock('./services/agent/identity', () => ({
  resolveYclientsClientId: jest.fn(async () => 777),
}));

const bookingModify = require('./services/agent/booking-modify');
const tool = require('./services/agent/tools/reschedule-booking');
const { createSlotEvidence } = require('./services/agent/slot-evidence');

beforeEach(() => jest.clearAllMocks());

// «Сейчас» — далеко до слота, чтобы lead-time не мешал.
const NOW = Date.parse('2026-09-19T09:00:00+03:00');
const DT = '2026-09-23T17:00:00+03:00';
const slot = (t) => ({ time: t, datetime: `2026-09-23T${t}:00+03:00`, seance_length: 3000 });

function evidenceWith(times, staff = 3356928) {
  const ev = createSlotEvidence();
  ev.add('get_available_slots', { staff_yc_id: staff, date: '2026-09-23' }, { slots: times.map(slot) });
  return ev;
}

test('боевой случай: слоты не запрашивались → unverified_slot, YClients не зовётся', async () => {
  const res = await tool.run(1, { record_id: 1922530986, datetime: '2026-09-21T10:00:00+03:00' }, {
    clientPhone: '79651442032', nowMs: NOW, slotEvidence: createSlotEvidence(),
    recentDialogText: 'Доброе утро. Можно перенести на пн утро?',
  });
  expect(res.unverified_slot).toBe(true);
  expect(res.invalid_args).toBe(true);
  expect(res.error).toMatch(/get_available_slots/);
  expect(tool.isHintResult(res)).toBe(true);
  expect(bookingModify.rescheduleBookingRecord).not.toHaveBeenCalled();
});

test('время в выдаче, но в диалоге не звучало → needs_confirmation, YClients не зовётся', async () => {
  const res = await tool.run(1, { record_id: 5, datetime: DT }, {
    clientPhone: '79651442032', nowMs: NOW, slotEvidence: evidenceWith(['13:30', '17:00']),
    recentDialogText: 'Или утро или ближе к вечеру',
  });
  expect(res.needs_confirmation).toBe(true);
  expect(res.invalid_args).toBe(true);
  expect(res.error).toMatch(/17:00/);
  expect(tool.isHintResult(res)).toBe(true);
  expect(bookingModify.rescheduleBookingRecord).not.toHaveBeenCalled();
});

test('время в выдаче И названо пациентом → перенос идёт', async () => {
  const res = await tool.run(1, { record_id: 5, datetime: DT }, {
    clientPhone: '79651442032', nowMs: NOW, slotEvidence: evidenceWith(['13:30', '17:00']),
    recentDialogText: 'Мила: есть 13:30 и 17:00, что удобнее?\nПациент: 17.00',
  });
  expect(res.rescheduled).toBe(true);
  expect(tool.isHintResult(res)).toBe(false);
  expect(bookingModify.rescheduleBookingRecord).toHaveBeenCalledTimes(1);
});

test('время предложила Мила, пациент ответил «да» — цифра в её реплике достаточна', async () => {
  const res = await tool.run(1, { record_id: 5, datetime: DT }, {
    clientPhone: '79651442032', nowMs: NOW, slotEvidence: evidenceWith(['17:00']),
    recentDialogText: '[19.09 09:03] В среду у Татьяны есть окошко в 17:00. Подойдёт?\nДа, давайте',
  });
  expect(res.rescheduled).toBe(true);
});

test('гейт слотов идёт ПЕРВЫМ: без выдачи — unverified_slot, даже если время названо', async () => {
  const res = await tool.run(1, { record_id: 5, datetime: DT }, {
    clientPhone: '79651442032', nowMs: NOW, slotEvidence: createSlotEvidence(),
    recentDialogText: 'давайте на 17:00',
  });
  expect(res.unverified_slot).toBe(true);
  expect(res.needs_confirmation).toBeUndefined();
});

test('смена мастера: staff_yc_id сверяется с владельцем слота', async () => {
  const res = await tool.run(1, { record_id: 5, datetime: DT, staff_yc_id: 111 }, {
    clientPhone: '79651442032', nowMs: NOW, slotEvidence: evidenceWith(['17:00'], 3356928),
    recentDialogText: 'на 17:00',
  });
  expect(res.unverified_slot).toBe(true);
});

test('fail-open: без slotEvidence и recentDialogText в ctx — прежний контракт', async () => {
  const res = await tool.run(1, { record_id: 5, datetime: DT }, { clientPhone: '79651442032', nowMs: NOW });
  expect(res.rescheduled).toBe(true);
});

test('too_soon и провал YClients: too_soon — hint, отказ YClients — провал', async () => {
  const soon = await tool.run(1, { record_id: 5, datetime: '2026-09-19T09:30:00+03:00' }, {
    clientPhone: '79651442032', nowMs: NOW,
  });
  expect(soon.too_soon).toBe(true);
  expect(tool.isHintResult(soon)).toBe(true);

  bookingModify.rescheduleBookingRecord.mockResolvedValueOnce({ ok: false, error: 'Выбранное время недоступно' });
  const fail = await tool.run(1, { record_id: 5, datetime: DT }, { clientPhone: '79651442032', nowMs: NOW });
  expect(fail.error).toMatch(/недоступно/);
  expect(tool.isHintResult(fail)).toBe(false);
});

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

test('slotEvidence из ctx пробрасывается в rescheduleBookingRecord (иначе гейт A2 неактивен)', async () => {
  const ev = evidenceWith(['17:00']);
  await tool.run(1, { record_id: 5, datetime: DT }, {
    clientPhone: '79651442032', nowMs: NOW, slotEvidence: ev,
    recentDialogText: 'на 17:00',
  });
  expect(bookingModify.rescheduleBookingRecord).toHaveBeenCalledWith(
    1, expect.objectContaining({ slotEvidence: ev })
  );
});
