'use strict';

jest.mock('./services/agent/booking', () => ({ createBookingRecord: jest.fn(async () => ({ created: true, record_id: 900 })) }));
jest.mock('./services/agent/booking-modify', () => ({ rescheduleBookingRecord: jest.fn(async (_s, a) => ({ ok: true, record_id: a.recordId, datetime: a.datetime })) }));
jest.mock('./services/agent/identity', () => ({ resolveYclientsClientId: jest.fn(async () => 777) }));
jest.mock('./services/agent/tools/list-services', () => ({ run: jest.fn(async () => ({ services: [] })) }));
jest.mock('./services/agent/tools/list-client-bookings', () => ({ run: jest.fn(async () => ({ bookings: [] })) }));
jest.mock('./services/agent-settings', () => ({ loadServiceFilterSafe: jest.fn(async () => null) }));
jest.mock('./services/agent/service-filter', () => ({ isBookable: () => true }));
const create = require('./services/agent/tools/create-booking');
const move = require('./services/agent/tools/reschedule-booking');
const booking = require('./services/agent/booking');
const modify = require('./services/agent/booking-modify');
const list = require('./services/agent/tools/list-client-bookings');
const guard = require('./services/agent/booking-write-guard');
const chainTool = require('./services/agent/tools/book-chain');
const offers = require('./services/agent/sequential-offers');
const NOW = Date.parse('2026-09-27T09:00:00Z');
const DT = '2026-10-02T15:00:00+03:00';
const input = { service_yc_id: 101, staff_yc_id: 7, datetime: DT };
const source = { record_id: 501, service_yc_ids: [101], datetime: '2026-10-01T15:00:00+03:00' };
const ctx = () => ({ dialogKey: 'guards-test', clientPhone: 'test-owner', nowMs: NOW,
  liveBookings: [source], slotEvidence: { has: () => true }, patientLastText: 'Да',
  previousAssistantText: 'Перенести запись на 2 октября в 15:00?',
  recentDialogText: 'Перенести запись на 2 октября в 15:00? Да', rescheduleRequested: true });
beforeEach(() => { jest.clearAllMocks(); offers._reset(); });

test('direct create cannot turn a transfer into a new visit', async () => {
  const result = await create.run(1, input, ctx());
  expect(result.requires_reschedule).toBe(true);
  expect(booking.createBookingRecord).not.toHaveBeenCalled();
});
test('same-service future visit also blocks creation when intent was lost', async () => {
  const c = { ...ctx(), rescheduleRequested: false, previousAssistantText: '2 октября в 15:00. Записать?' };
  const result = await create.run(1, input, c);
  expect(result.requires_reschedule).toBe(true);
  expect(booking.createBookingRecord).not.toHaveBeenCalled();
});
test.each([null, [{ record_id: 501 }]])('unavailable source data cannot be treated as no visits: %j', liveBookings =>
  create.run(1, input, { ...ctx(), liveBookings, rescheduleRequested: false, previousAssistantText: '' }).then(result => {
    expect(result.error).toBeTruthy();
    expect(booking.createBookingRecord).not.toHaveBeenCalled();
  }));
test('a genuinely new visit remains available', async () => {
  const result = await create.run(1, input, { ...ctx(), liveBookings: [], rescheduleRequested: false,
    previousAssistantText: '2 октября в 15:00. Записать?' });
  expect(result.created).toBe(true);
});
test('a new unrelated request supersedes old transfer intent', async () => {
  const result = await create.run(1, input, { ...ctx(), liveBookings: [{ ...source, service_yc_ids: [202] }],
    previousAssistantText: '2 октября в 15:00. Записать?',
    patientRecentTexts: ['Перенесите прежнюю запись', 'Хочу записаться на другую услугу', 'Да'] });
  expect(result.created).toBe(true);
});
test('explicit additional visit may coexist with the old visit', async () => {
  const result = await create.run(1, input, { ...ctx(), rescheduleRequested: false,
    previousAssistantText: 'Дополнительная запись на 2 октября в 15:00, прежнюю оставляем. Записать?',
    patientRecentTexts: ['Хочу ещё одну запись, прежнюю оставьте', 'Да'] });
  expect(result.created).toBe(true);
});
test('explicitly changing the target phone cannot bypass transfer intent', async () => {
  const result = await create.run(1, { ...input, client_phone: 'test-guest' }, ctx());
  expect(result.requires_reschedule).toBe(true);
  expect(booking.createBookingRecord).not.toHaveBeenCalled();
});

test('a later refusal cannot reuse an older additional-booking request', async () => {
  const result = await create.run(1, input, { ...ctx(), rescheduleRequested: false,
    previousAssistantText: 'Дополнительная запись на 2 октября в 15:00?', patientLastText: 'Нет',
    patientRecentTexts: ['Хочу ещё одну запись', 'Нет'] });
  expect(result.requires_reschedule).toBe(true);
  expect(booking.createBookingRecord).not.toHaveBeenCalled();
});
test('extra visit requires a matching proposal and fresh consent', async () => {
  const result = await create.run(1, input, { ...ctx(), rescheduleRequested: false,
    previousAssistantText: 'Дополнительная запись на 3 октября в 15:00?',
    patientRecentTexts: ['Хочу ещё одну запись', 'Да'] });
  expect(result.needs_confirmation).toBe(true);
  expect(booking.createBookingRecord).not.toHaveBeenCalled();
});
test('retry for an already existing identical slot does not create another record', async () => {
  const result = await create.run(1, input, { ...ctx(), rescheduleRequested: false,
    previousAssistantText: '2 октября в 15:00. Записать?', liveBookings: [{ ...source, datetime: DT, staff_yc_id: 7 }] });
  expect(result).toMatchObject({ duplicate: true, record_id: 501 });
  expect(booking.createBookingRecord).not.toHaveBeenCalled();
});
test('guest history is read within the current salon, not replaced by owner history', async () => {
  const guest = String(10 ** 10);
  list.run.mockResolvedValueOnce({ bookings: [source] });
  const result = await create.run(9, { ...input, client_phone: guest }, { ...ctx(),
    liveBookings: [], rescheduleRequested: false, previousAssistantText: 'Записать на 2 октября в 15:00?' });
  expect(list.run).toHaveBeenCalledWith(9, {}, { clientPhone: guest, nowMs: NOW });
  expect(result.requires_reschedule).toBe(true);
  expect(booking.createBookingRecord).not.toHaveBeenCalled();
});

test.each([
  { patientLastText: 'Нет, это время не подходит' },
  { patientLastText: 'Да, но на другой день' },
  { patientLastText: 'Да?' },
  { patientLastText: '' },
  { previousAssistantText: 'Перенести на 1 октября в 15:00?' },
  { previousAssistantText: 'Перенести на 2 октября в 16:00?' },
  { previousAssistantText: 'Перенести на 2 октября в 15:00 или 16:00?' },
  { previousAssistantText: 'Перенести 2 или 3 октября в 15:00?' },
  { previousAssistantText: 'Перенести на 2 октября 2027 года в 15:00?' },
  { previousAssistantText: 'Перенести на 15:00?' },
  { previousAssistantText: 'Не будем переносить существующую запись. 2 октября в 15:00?' },
  { previousAssistantText: 'Перенос на 2 октября в 15:00 вам не подходит?' },
])('single transfer rejects unconfirmed terms: %j', async patch => {
  const result = await move.run(1, { record_id: 501, datetime: DT }, { ...ctx(), ...patch });
  expect(result.needs_confirmation).toBe(true);
  expect(modify.rescheduleBookingRecord).not.toHaveBeenCalled();
});
test('missing consent context fails closed', async () => {
  const result = await move.run(1, { record_id: 501, datetime: DT }, { clientPhone: 'test-owner', nowMs: NOW });
  expect(result.needs_confirmation).toBe(true);
  expect(modify.rescheduleBookingRecord).not.toHaveBeenCalled();
});
test.each(['Да', 'Да, пожалуйста', 'Подтверждаю', '15:00', 'Давайте на 15.00'])('confirmed transfer: %s', async patientLastText => {
  const result = await move.run(1, { record_id: 501, datetime: DT }, { ...ctx(), patientLastText });
  expect(result.rescheduled).toBe(true);
});
test('explicit time selects one of several times on a single offered date', async () => {
  const result = await move.run(1, { record_id: 501, datetime: DT }, { ...ctx(), patientLastText: '15:00',
    previousAssistantText: '2 октября есть 15:00 или 16:00. На какое время перенести?' });
  expect(result.rescheduled).toBe(true);
});
test('equivalent UTC timestamp uses the Moscow date and time', async () => {
  const result = await move.run(1, { record_id: 501, datetime: '2026-10-02T12:00:00Z' }, ctx());
  expect(result.rescheduled).toBe(true);
});

test('chain transfer passes through the real single-transfer guard with exact bound targets', async () => {
  const links = [
    { service_yc_id: 101, staff_yc_id: 7, staff_name: 'Анна', service_title: 'Услуга А', datetime: DT, seance_length: 1800 },
    { service_yc_id: 102, staff_yc_id: 8, staff_name: 'Мария', service_title: 'Услуга Б', datetime: DT.replace('15:00', '15:30'), seance_length: 1800 },
  ];
  const c = { ...ctx(), previousAssistantText: 'Перенести на 2 октября: 15:00 у Анны, затем 15:30 у Марии?',
    liveBookings: [source, { ...source, record_id: 502, service_yc_ids: [102] }] };
  offers.remember(1, c.dialogKey, { o1: { chain: links, booking_mode: 'separate_records' } }, { nowMs: NOW });
  const result = await chainTool.run(1, { option_id: 'o1' }, c);
  expect(result).toMatchObject({ booked_all: true, rescheduled: true });
  expect(modify.rescheduleBookingRecord.mock.calls.map(c => c[1].recordId)).toEqual([501, 502]);
  expect(booking.createBookingRecord).not.toHaveBeenCalled();
  const bound = guard.withChainTransfer(c, links.map((l, i) => ({ ...l, record_id: 501 + i })));
  expect(guard.rescheduleRejection({ record_id: 999, datetime: DT, staff_yc_id: 7 }, bound).needs_confirmation).toBe(true);
  expect(guard.rescheduleRejection({ record_id: 501, datetime: DT.replace('15:00', '16:00'), staff_yc_id: 7 }, bound).needs_confirmation).toBe(true);
});

test('model arguments cannot fabricate chain consent', async () => {
  const result = await move.run(1, { record_id: 501, datetime: DT, confirmed: true, confirmedChainTransfer: true }, {
    ...ctx(), patientLastText: 'Нет', confirmedChainTransfer: true,
  });
  expect(result.needs_confirmation).toBe(true);
  expect(modify.rescheduleBookingRecord).not.toHaveBeenCalled();
});
