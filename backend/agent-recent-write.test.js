'use strict';

// Свежий успешный write-инструмент в журнале agent_tool_events как ДОКАЗАТЕЛЬСТВО
// для анти-ложь-guard'а. Инцидент 2026-09-13 (79231471109): reschedule_booking
// отработал в предыдущем прогоне той же серии (rerun после сообщения, пришедшего
// во время обработки), а во втором прогоне Мила правдиво повторила «перенесла» —
// guard видел только СВОЙ ход без write-инструмента и увёл диалог на администратора.

const { findRecentWrite, vouchesFor, RECENT_WRITE_WINDOW_MS } = require('./services/agent/recent-write');

const NOW = 1_800_000_000_000;
const row = (tool, ageMs, extra = {}) => ({ tool, age_ms: ageMs, is_error: false, result: {}, ...extra });

describe('findRecentWrite', () => {
  test('успешный reschedule_booking полминуты назад → доказательство', () => {
    const out = findRecentWrite([row('get_available_slots', 40_000), row('reschedule_booking', 30_000)], { nowMs: NOW });
    expect(out).toEqual({ tool: 'reschedule_booking', ageMs: 30_000 });
  });

  test('write старше окна → null (старый перенос не прикрывает свежую выдумку)', () => {
    const out = findRecentWrite([row('reschedule_booking', RECENT_WRITE_WINDOW_MS + 1)], { nowMs: NOW });
    expect(out).toBe(null);
  });

  test('write ровно на границе окна ещё считается', () => {
    const out = findRecentWrite([row('cancel_booking', RECENT_WRITE_WINDOW_MS)], { nowMs: NOW });
    expect(out).toEqual({ tool: 'cancel_booking', ageMs: RECENT_WRITE_WINDOW_MS });
  });

  test('is_error → не доказательство', () => {
    expect(findRecentWrite([row('reschedule_booking', 5_000, { is_error: true })], { nowMs: NOW })).toBe(null);
  });

  test('read-инструменты не считаются', () => {
    expect(findRecentWrite([row('list_client_bookings', 5_000), row('get_available_slots', 1_000)], { nowMs: NOW })).toBe(null);
  });

  test('book_chain — только с реально созданными записями (booked_all / partial)', () => {
    expect(findRecentWrite([row('book_chain', 5_000, { result: { option_expired: true } })], { nowMs: NOW })).toBe(null);
    expect(findRecentWrite([row('book_chain', 5_000, { result: { partial: true } })], { nowMs: NOW }))
      .toEqual({ tool: 'book_chain', ageMs: 5_000 });
    expect(findRecentWrite([row('book_chain', 5_000, { result: JSON.stringify({ booked_all: true }) })], { nowMs: NOW }))
      .toEqual({ tool: 'book_chain', ageMs: 5_000 });
  });

  test('из нескольких write — самый свежий', () => {
    const out = findRecentWrite([row('create_booking', 600_000), row('cancel_booking', 20_000)], { nowMs: NOW });
    expect(out).toEqual({ tool: 'cancel_booking', ageMs: 20_000 });
  });

  test('без nowMs / пустой или битый ввод → null', () => {
    expect(findRecentWrite([row('reschedule_booking', 5_000)], {})).toBe(null);
    expect(findRecentWrite(null, { nowMs: NOW })).toBe(null);
    expect(findRecentWrite([], { nowMs: NOW })).toBe(null);
  });
});

// Полярность: перенос подтверждает и «перенесла», и «вы записаны», и «старая
// запись отменена» (законное описание переноса); создание — только «вы записаны»,
// отмена — только «отменила». Свежая запись НЕ должна прикрывать «отменила».
describe('vouchesFor', () => {
  test('reschedule_booking → completion, booked, cancelled', () => {
    expect([...vouchesFor('reschedule_booking')].sort()).toEqual(['booked', 'cancelled', 'completion']);
  });
  test('create_booking / book_chain → только booked', () => {
    expect([...vouchesFor('create_booking')]).toEqual(['booked']);
    expect([...vouchesFor('book_chain')]).toEqual(['booked']);
  });
  test('cancel_booking → только cancelled', () => {
    expect([...vouchesFor('cancel_booking')]).toEqual(['cancelled']);
  });
  test('modify_booking_services → completion, booked', () => {
    expect([...vouchesFor('modify_booking_services')].sort()).toEqual(['booked', 'completion']);
  });
  test('неизвестный / пустой инструмент → ничего', () => {
    expect(vouchesFor('get_available_slots').size).toBe(0);
    expect(vouchesFor(null).size).toBe(0);
  });
});
