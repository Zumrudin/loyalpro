'use strict';

const bookChain = require('./services/agent/tools/book-chain');
const offers = require('./services/agent/sequential-offers');
const bookingModify = require('./services/agent/booking-modify');

beforeEach(() => offers._reset());
afterEach(() => jest.restoreAllMocks());

const CTX = { dialogKey: 'dlg', clientPhone: '79990001122', clientName: 'Анна' };
const LINK = (svc, staff, dt) => ({
  service_yc_id: svc, service_title: `svc${svc}`, staff_yc_id: staff,
  datetime: dt, seance_length: 3600,
});

function deps(overrides = {}) {
  return {
    createBooking: jest.fn(async () => ({ created: true, record_id: 555 })),
    modifyServices: jest.fn(async () => ({ modified: true, record_id: 555 })),
    ...overrides,
  };
}

test('option_id не найден/протух → option_expired, ничего не бронируем', async () => {
  const d = deps();
  const res = await bookChain.run(1, { option_id: 'o9', comment: 'к' }, CTX, d);
  expect(res.option_expired).toBe(true);
  expect(d.createBooking).not.toHaveBeenCalled();
});

test('single_record: create по первой услуге + modify с остальными', async () => {
  offers.remember(1, 'dlg', { o1: { booking_mode: 'single_record', chain: [
    LINK(101, 7, '2026-07-30T14:00:00+03:00'), LINK(102, 7, '2026-07-30T15:00:00+03:00'),
  ] } });
  const d = deps();
  const res = await bookChain.run(1, { option_id: 'o1', comment: 'чистка+консультация' }, CTX, d);
  expect(res.booked_all).toBe(true);
  expect(d.createBooking).toHaveBeenCalledTimes(1);
  expect(d.createBooking.mock.calls[0][1]).toMatchObject({
    staff_yc_id: 7, service_yc_id: 101, datetime: '2026-07-30T14:00:00+03:00',
    seance_length: 3600, comment: 'чистка+консультация',
  });
  expect(d.modifyServices).toHaveBeenCalledWith(1,
    { record_id: 555, add_service_yc_ids: [102] }, CTX);
});

test('separate_records: create_booking на каждый элемент chain', async () => {
  offers.remember(1, 'dlg', { o1: { booking_mode: 'separate_records', chain: [
    LINK(101, 7, '2026-07-30T14:00:00+03:00'), LINK(102, 8, '2026-07-30T15:00:00+03:00'),
  ] } });
  const d = deps();
  const res = await bookChain.run(1, { option_id: 'o1', comment: 'к' }, CTX, d);
  expect(res.booked_all).toBe(true);
  expect(res.records).toHaveLength(2);
  expect(d.createBooking).toHaveBeenCalledTimes(2);
  expect(d.modifyServices).not.toHaveBeenCalled();
});

test('anchored: элемент already_booked пропускается, бронируются только последующие', async () => {
  const first = { ...LINK(101, 7, '2026-07-30T14:00:00+03:00'), already_booked: true };
  offers.remember(1, 'dlg', { o1: { booking_mode: 'separate_records', anchored: true,
    chain: [first, LINK(102, 7, '2026-07-30T15:00:00+03:00')] } });
  const d = deps();
  const res = await bookChain.run(1, { option_id: 'o1', comment: 'к' }, CTX, d);
  expect(res.booked_all).toBe(true);
  expect(d.createBooking).toHaveBeenCalledTimes(1);
  expect(d.createBooking.mock.calls[0][1].service_yc_id).toBe(102);
});

test('провал первой записи → booked_all:false, partial:false, ничего дальше не бронируем', async () => {
  offers.remember(1, 'dlg', { o1: { booking_mode: 'separate_records', chain: [
    LINK(101, 7, '2026-07-30T14:00:00+03:00'), LINK(102, 8, '2026-07-30T15:00:00+03:00'),
  ] } });
  const d = deps({ createBooking: jest.fn(async () => ({ created: false, error: 'время недоступно' })) });
  const res = await bookChain.run(1, { option_id: 'o1', comment: 'к' }, CTX, d);
  expect(res.booked_all).toBe(false);
  expect(res.partial).toBe(false);
  expect(d.createBooking).toHaveBeenCalledTimes(1);
});

test('провал ВТОРОЙ записи → partial:true с перечнем созданного и failed_at', async () => {
  offers.remember(1, 'dlg', { o1: { booking_mode: 'separate_records', chain: [
    LINK(101, 7, '2026-07-30T14:00:00+03:00'), LINK(102, 8, '2026-07-30T15:00:00+03:00'),
  ] } });
  let n = 0;
  const d = deps({ createBooking: jest.fn(async () =>
    ++n === 1 ? { created: true, record_id: 555 } : { created: false, error: 'занято' }) });
  const res = await bookChain.run(1, { option_id: 'o1', comment: 'к' }, CTX, d);
  expect(res.booked_all).toBe(false);
  expect(res.partial).toBe(true);
  expect(res.records).toEqual([expect.objectContaining({ record_id: 555 })]);
  expect(res.failed_at).toBe('svc102');
});

test('separate_records: duplicate (идемпотентный ретрай) первого звена = успех, record_id из duplicate', async () => {
  offers.remember(1, 'dlg', { o1: { booking_mode: 'separate_records', chain: [
    LINK(101, 7, '2026-07-30T14:00:00+03:00'), LINK(102, 8, '2026-07-30T15:00:00+03:00'),
  ] } });
  let n = 0;
  const d = deps({ createBooking: jest.fn(async () =>
    ++n === 1 ? { created: false, duplicate: true, record_id: 555 } : { created: true, record_id: 556 }) });
  const res = await bookChain.run(1, { option_id: 'o1', comment: 'к' }, CTX, d);
  expect(res.booked_all).toBe(true);
  expect(res.records.map(r => r.record_id)).toEqual([555, 556]);
});

test('single_record: duplicate create → всё равно добавляем остальные услуги и booked_all', async () => {
  offers.remember(1, 'dlg', { o1: { booking_mode: 'single_record', chain: [
    LINK(101, 7, '2026-07-30T14:00:00+03:00'), LINK(102, 7, '2026-07-30T15:00:00+03:00'),
  ] } });
  const d = deps({ createBooking: jest.fn(async () => ({ created: false, duplicate: true, record_id: 555 })) });
  const res = await bookChain.run(1, { option_id: 'o1', comment: 'к' }, CTX, d);
  expect(res.booked_all).toBe(true);
  expect(d.modifyServices).toHaveBeenCalledWith(1,
    { record_id: 555, add_service_yc_ids: [102] }, CTX);
});

test('single_record: дефолтный modify зовёт booking-modify напрямую БЕЗ expectedYcClientId (ownership-гейт обойдён)', async () => {
  offers.remember(1, 'dlg', { o1: { booking_mode: 'single_record', chain: [
    LINK(101, 7, '2026-07-30T14:00:00+03:00'), LINK(102, 7, '2026-07-30T15:00:00+03:00'),
  ] } });
  const spy = jest.spyOn(bookingModify, 'modifyBookingServices')
    .mockResolvedValue({ ok: true, record_id: 555, services_count: 2 });
  // modifyServices НЕ инжектим → используется доверенный дефолт book-chain.
  const d = { createBooking: jest.fn(async () => ({ created: true, record_id: 555 })) };
  const res = await bookChain.run(1, { option_id: 'o1', comment: 'к' }, CTX, d);
  expect(res.booked_all).toBe(true);
  const arg = spy.mock.calls[0][1];
  expect(arg).toMatchObject({ recordId: 555, addServiceYcIds: [102] });
  expect(arg.expectedYcClientId).toBeUndefined();
});

test('single_record: modify вернул неуспех (modified:false) → partial:true, запись создана', async () => {
  offers.remember(1, 'dlg', { o1: { booking_mode: 'single_record', chain: [
    LINK(101, 7, '2026-07-30T14:00:00+03:00'), LINK(102, 7, '2026-07-30T15:00:00+03:00'),
  ] } });
  const d = deps({ modifyServices: jest.fn(async () => ({ modified: false, error: 'overlaps' })) });
  const res = await bookChain.run(1, { option_id: 'o1', comment: 'к' }, CTX, d);
  expect(res.booked_all).toBe(false);
  expect(res.partial).toBe(true);
  expect(res.records).toEqual([expect.objectContaining({ record_id: 555 })]);
  expect(res.failed_at).toBe('svc102');
});

test('single_record: modify БРОСАЕТ исключение → partial:true (запись звена 1 не теряется)', async () => {
  offers.remember(1, 'dlg', { o1: { booking_mode: 'single_record', chain: [
    LINK(101, 7, '2026-07-30T14:00:00+03:00'), LINK(102, 7, '2026-07-30T15:00:00+03:00'),
  ] } });
  const d = deps({ modifyServices: jest.fn(async () => { throw new Error('db down'); }) });
  const res = await bookChain.run(1, { option_id: 'o1', comment: 'к' }, CTX, d);
  expect(res.partial).toBe(true);
  expect(res.records).toEqual([expect.objectContaining({ record_id: 555 })]);
  expect(res.failed_at).toBe('svc102');
});

test('separate_records: исключение во ВТОРОМ create → partial:true с первой записью', async () => {
  offers.remember(1, 'dlg', { o1: { booking_mode: 'separate_records', chain: [
    LINK(101, 7, '2026-07-30T14:00:00+03:00'), LINK(102, 8, '2026-07-30T15:00:00+03:00'),
  ] } });
  let n = 0;
  const d = deps({ createBooking: jest.fn(async () => {
    if (++n === 1) return { created: true, record_id: 555 };
    throw new Error('yclients timeout');
  }) });
  const res = await bookChain.run(1, { option_id: 'o1', comment: 'к' }, CTX, d);
  expect(res.booked_all).toBe(false);
  expect(res.partial).toBe(true);
  expect(res.records).toEqual([expect.objectContaining({ record_id: 555 })]);
  expect(res.failed_at).toBe('svc102');
});

test('client_phone/client_name из input пробрасываются в каждую бронь (запись другого человека)', async () => {
  offers.remember(1, 'dlg', { o1: { booking_mode: 'separate_records', chain: [
    LINK(101, 7, '2026-07-30T14:00:00+03:00'), LINK(102, 8, '2026-07-30T15:00:00+03:00'),
  ] } });
  const d = deps();
  await bookChain.run(1, { option_id: 'o1', comment: 'к', client_phone: '79995556677', client_name: 'Мама' }, CTX, d);
  for (const call of d.createBooking.mock.calls) {
    expect(call[1]).toMatchObject({ client_phone: '79995556677', client_name: 'Мама' });
  }
});
