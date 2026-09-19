'use strict';

// Тот же гейт, что у переноса (инцидент 2026-09-19): create_booking на время,
// которого не возвращал ни один слот-инструмент, — hint без похода в YClients.

jest.mock('./services/agent/booking', () => ({
  createBookingRecord: jest.fn(async () => ({ created: true, record_id: 777 })),
}));
jest.mock('./services/agent/tools/list-services', () => ({ run: jest.fn(async () => ({ services: [] })) }));
jest.mock('./services/agent-settings', () => ({ loadServiceFilterSafe: jest.fn(async () => null) }));
jest.mock('./services/agent/service-filter', () => ({ isBookable: () => true }));

const booking = require('./services/agent/booking');
const tool = require('./services/agent/tools/create-booking');
const bookChain = require('./services/agent/tools/book-chain');
const offers = require('./services/agent/sequential-offers');
const { createSlotEvidence } = require('./services/agent/slot-evidence');

beforeEach(() => { jest.clearAllMocks(); offers._reset(); });

const NOW = Date.parse('2026-09-19T09:00:00+03:00');
const INPUT = { staff_yc_id: 5, service_yc_id: 10, datetime: '2026-09-23T17:00:00+03:00' };
const CTX = { dialogKey: 'd', clientPhone: '79001112233', nowMs: NOW };

test('время не из выдачи → unverified_slot, YClients не зовётся', async () => {
  const res = await tool.run(1, INPUT, { ...CTX, slotEvidence: createSlotEvidence() });
  expect(res.unverified_slot).toBe(true);
  expect(res.invalid_args).toBe(true);
  expect(booking.createBookingRecord).not.toHaveBeenCalled();
});

test('время из выдачи этого мастера → запись идёт', async () => {
  const ev = createSlotEvidence();
  ev.add('get_available_slots', { staff_yc_id: 5 }, { slots: [{ datetime: INPUT.datetime }] });
  const res = await tool.run(1, INPUT, { ...CTX, slotEvidence: ev });
  expect(res.created).toBe(true);
});

test('fail-open без slotEvidence', async () => {
  const res = await tool.run(1, INPUT, CTX);
  expect(res.created).toBe(true);
});

test('book_chain НЕ наследует гейт: slotEvidence вырезается из linkCtx', async () => {
  offers.remember(1, 'd', { o1: { booking_mode: 'separate_records', chain: [
    { service_yc_id: 10, staff_yc_id: 5, datetime: INPUT.datetime, seance_length: 3600 },
  ] } });
  const createBooking = jest.fn(async (_s, _i, ctx) => {
    expect(ctx.slotEvidence).toBeUndefined();
    return { created: true, record_id: 1 };
  });
  const res = await bookChain.run(1, { option_id: 'o1', comment: 'к' },
    { ...CTX, slotEvidence: createSlotEvidence() }, { createBooking, modifyServices: jest.fn() });
  expect(res.booked_all).toBe(true);
  expect(createBooking).toHaveBeenCalledTimes(1);
});
