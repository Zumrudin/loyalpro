'use strict';

const tool = require('./services/agent/tools/book-chain');
const offers = require('./services/agent/sequential-offers');
const confirmation = require('./services/agent/chain-confirmation');
const NOW = Date.parse('2026-09-30T09:00:00Z');
const chain = [
  { service_yc_id: 101, service_title: 'Услуга А', staff_yc_id: 7, staff_name: 'Анна', datetime: '2026-10-02T15:00:00+03:00', seance_length: 1800 },
  { service_yc_id: 102, service_title: 'Услуга Б', staff_yc_id: 8, staff_name: 'Мария', datetime: '2026-10-02T15:30:00+03:00', seance_length: 1800 },
];
const bookings = chain.map((l, i) => ({ record_id: 501 + i, service_yc_ids: [l.service_yc_id],
  datetime: '2026-10-01T15:00:00+03:00', staff_yc_id: l.staff_yc_id }));
const ctx = () => ({ dialogKey: 'chain-test', clientPhone: 'test-owner', nowMs: NOW,
  liveBookings: bookings.map(b => ({ ...b })), patientLastText: 'Да',
  previousAssistantText: 'Перенести существующие записи на 2 октября: 15:00 у Анны, затем 15:30 у Марии?',
});
const deps = () => ({ createBooking: jest.fn(), modifyServices: jest.fn(),
  rescheduleBooking: jest.fn(async (_salon, input) => ({ rescheduled: true, record_id: input.record_id, datetime: input.datetime })),
});
beforeEach(() => {
  offers._reset();
  offers.remember(1, 'chain-test', { o1: { booking_mode: 'separate_records', chain } }, { nowMs: NOW });
});

test('confirmed transfer preserves both original IDs and never creates records', async () => {
  const d = deps();
  const result = await tool.run(1, { option_id: 'o1' }, ctx(), d);
  expect(result).toMatchObject({ booked_all: true, rescheduled: true });
  expect(result.records.map(r => r.record_id)).toEqual([501, 502]);
  expect(d.rescheduleBooking.mock.calls.map(c => c[1])).toEqual(chain.map((l, i) => ({
    record_id: 501 + i, datetime: l.datetime, staff_yc_id: l.staff_yc_id, seance_length: l.seance_length,
  })));
  for (const call of d.rescheduleBooking.mock.calls) {
    expect(call[0]).toBe(1);
    expect(call[2].slotEvidence.has(call[1].datetime, { staffYcId: call[1].staff_yc_id })).toBe(true);
    expect(call[2].slotEvidence.has(call[1].datetime, {
      staffYcId: call[1].staff_yc_id, serviceYcIds: call[2].expectedServiceYcIds,
    })).toBe(true);
    expect(call[2].clientPhone).toBe('test-owner');
  }
  expect(d.createBooking).not.toHaveBeenCalled();
  expect(d.modifyServices).not.toHaveBeenCalled();
  expect(confirmation.confirmationReply(result)).toMatch(/^Записи перенесены:/);
});

test('a generic booking proposal requires explicit transfer confirmation before changing existing records', async () => {
  const d = deps();
  const c = { ...ctx(), previousAssistantText: '2 октября: 15:00 у Анны, затем 15:30 у Марии. Записать?' };
  const result = await tool.run(1, { option_id: 'o1' }, c, d);
  expect(result).toMatchObject({ needs_confirmation: true, reschedule_confirmation: true, matching_option_ids: ['o1'] });
  expect(d.createBooking).not.toHaveBeenCalled();
  expect(d.rescheduleBooking).not.toHaveBeenCalled();
});

test.each(['missing', 'unavailable', 'ambiguous', 'combined', 'partial', 'unknown-services', 'other-tenant'])
('unsafe source mapping (%s) cannot fall back to creation', async kind => {
  const c = ctx();
  if (kind === 'missing') c.liveBookings = [];
  if (kind === 'unavailable') c.liveBookings = null;
  if (kind === 'ambiguous') c.liveBookings.push({ ...bookings[0], record_id: 503 });
  if (kind === 'combined') c.liveBookings = [{ ...bookings[0], service_yc_ids: [101, 102] }];
  if (kind === 'partial') c.liveBookings = [bookings[0]];
  if (kind === 'unknown-services') delete c.liveBookings[0].service_yc_ids;
  const d = deps();
  const result = await tool.run(kind === 'other-tenant' ? 2 : 1, { option_id: 'o1' }, c, d);
  expect(result.error).toBeTruthy();
  expect(d.createBooking).not.toHaveBeenCalled();
  expect(d.rescheduleBooking).not.toHaveBeenCalled();
});

test('new booking with no existing visits still uses create, not transfer', async () => {
  const d = deps();
  d.createBooking.mockResolvedValue({ created: true, record_id: 900 });
  const c = { ...ctx(), liveBookings: [], previousAssistantText: '2 октября: 15:00 у Анны, затем 15:30 у Марии. Записать?' };
  const result = await tool.run(1, { option_id: 'o1' }, c, d);
  expect(result.booked_all).toBe(true);
  expect(d.createBooking).toHaveBeenCalledTimes(2);
  expect(d.rescheduleBooking).not.toHaveBeenCalled();
});

test('transfer failure on the first link does not move the second or create a replacement', async () => {
  const d = deps();
  d.rescheduleBooking.mockResolvedValue({ error: 'Отказ CRM' });
  const result = await tool.run(1, { option_id: 'o1' }, ctx(), d);
  expect(result).toMatchObject({ booked_all: false, partial: false, rescheduled: false, records: [] });
  expect(d.rescheduleBooking).toHaveBeenCalledTimes(1);
  expect(d.createBooking).not.toHaveBeenCalled();
});

test('declining the offered transfer prevents all writes', async () => {
  const d = deps();
  const result = await tool.run(1, { option_id: 'o1' }, { ...ctx(), patientLastText: 'Нет, в другое время' }, d);
  expect(result.needs_confirmation).toBe(true);
  expect(d.rescheduleBooking).not.toHaveBeenCalled();
  expect(d.createBooking).not.toHaveBeenCalled();
});

test('a proposal explicitly excluding transfer cannot authorize it', async () => {
  const d = deps();
  const c = { ...ctx(), previousAssistantText: 'Не будем переносить существующие записи. 2 октября: 15:00 у Анны, затем 15:30 у Марии. Записать?' };
  const result = await tool.run(1, { option_id: 'o1' }, c, d);
  expect(result.needs_confirmation).toBe(true);
  expect(d.rescheduleBooking).not.toHaveBeenCalled();
  expect(d.createBooking).not.toHaveBeenCalled();
});

test('expired chain cannot move existing visits', async () => {
  const d = deps();
  const result = await tool.run(1, { option_id: 'o1' }, { ...ctx(), nowMs: NOW + 31 * 60_000 }, d);
  expect(result.option_expired).toBe(true);
  expect(d.rescheduleBooking).not.toHaveBeenCalled();
});

test('partial failure is truthful and retry stays bound to original records', async () => {
  const d = deps();
  d.rescheduleBooking.mockResolvedValueOnce({ rescheduled: true, record_id: 501, datetime: chain[0].datetime })
    .mockResolvedValueOnce({ error: 'Слот недоступен' });
  const first = await tool.run(1, { option_id: 'o1' }, ctx(), d);
  expect(first).toMatchObject({ booked_all: false, partial: true, rescheduled: true });
  expect(first.records.map(r => r.record_id)).toEqual([501]);
  expect(confirmation.confirmationReply(first)).toMatch(/^Удалось перенести только часть записей:/);
  const second = await tool.run(1, { option_id: 'o1' }, ctx(), d);
  expect(second.booked_all).toBe(true);
  expect(d.rescheduleBooking.mock.calls.map(c => c[1].record_id)).toEqual([501, 502, 501, 502]);
  expect(d.createBooking).not.toHaveBeenCalled();
});

test('a disappeared source cannot be silently replaced by a different record on retry', async () => {
  const d = deps();
  await tool.run(1, { option_id: 'o1' }, ctx(), d);
  d.rescheduleBooking.mockClear();
  const c = ctx();
  c.liveBookings[0].record_id = 999;
  const result = await tool.run(1, { option_id: 'o1' }, c, d);
  expect(result.error).toBeTruthy();
  expect(d.rescheduleBooking).not.toHaveBeenCalled();
  expect(d.createBooking).not.toHaveBeenCalled();
});
