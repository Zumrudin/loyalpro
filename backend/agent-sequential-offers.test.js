'use strict';

const offers = require('./services/agent/sequential-offers');

beforeEach(() => offers._reset());

const CHAIN = [{ service_yc_id: 101, staff_yc_id: 7, datetime: '2026-07-30T14:00:00+03:00', seance_length: 3600 }];

test('remember/take: вариант возвращается по option_id', () => {
  offers.remember(1, 'dlg', { o1: { chain: CHAIN, booking_mode: 'separate_records' } });
  expect(offers.take(1, 'dlg', 'o1')).toEqual({ chain: CHAIN, booking_mode: 'separate_records' });
});

test('неизвестный option_id → null', () => {
  offers.remember(1, 'dlg', { o1: { chain: CHAIN, booking_mode: 'separate_records' } });
  expect(offers.take(1, 'dlg', 'o2')).toBeNull();
});

test('повторный remember того же диалога перезаписывает предложения (актуален последний вызов)', () => {
  offers.remember(1, 'dlg', { o1: { chain: CHAIN, booking_mode: 'separate_records' } });
  offers.remember(1, 'dlg', { o1: { chain: CHAIN, booking_mode: 'single_record' } });
  expect(offers.take(1, 'dlg', 'o1').booking_mode).toBe('single_record');
});

test('диалоги и салоны изолированы', () => {
  offers.remember(1, 'a', { o1: { chain: CHAIN, booking_mode: 'single_record' } });
  expect(offers.take(1, 'b', 'o1')).toBeNull();
  expect(offers.take(2, 'a', 'o1')).toBeNull();
});

test('TTL: протухшее предложение не возвращается', () => {
  offers.remember(1, 'dlg', { o1: { chain: CHAIN, booking_mode: 'single_record' } }, { nowMs: 1000 });
  expect(offers.take(1, 'dlg', 'o1', { nowMs: 1000 + offers.TTL_MS + 1 })).toBeNull();
});

test('option_id не ходит по прототипу (LLM может прислать constructor/__proto__)', () => {
  offers.remember(1, 'dlg', { o1: { chain: CHAIN, booking_mode: 'separate_records' } });
  expect(offers.take(1, 'dlg', 'constructor')).toBeNull();
  expect(offers.take(1, 'dlg', '__proto__')).toBeNull();
});
