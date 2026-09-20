'use strict';

// Инцидент 2026-09-19 (79651442032): reschedule_booking на 21.09 10:00 и 11:00
// без единого вызова слот-инструмента — времена выдуманы. Описание инструмента
// («datetime — ТОЧНУЮ строку из get_available_slots») было промпт-only.
// slot-evidence — множество стартов, которые инструменты РЕАЛЬНО вернули за ход
// (плюс свежий журнал), и write-инструменты сверяют datetime с ним.

const { createSlotEvidence, SLOT_EVIDENCE_TOOLS } = require('./services/agent/slot-evidence');

const slot = (t, date = '2026-09-23') => ({ time: t, datetime: `${date}T${t}:00+03:00`, seance_length: 3000 });

describe('createSlotEvidence.add / has', () => {
  test('пустая evidence ничего не подтверждает', () => {
    const ev = createSlotEvidence();
    expect(ev.size).toBe(0);
    expect(ev.has('2026-09-23T13:30:00+03:00')).toBe(false);
  });

  test('get_available_slots: slots запрошенного мастера подтверждают datetime с этим мастером', () => {
    const ev = createSlotEvidence();
    ev.add('get_available_slots', { staff_yc_id: 3356928, service_yc_id: 1, date: '2026-09-23' },
      { slots: [slot('13:30'), slot('17:00')], offer_slots: [slot('13:30')] });
    expect(ev.size).toBe(2);
    expect(ev.has('2026-09-23T17:00:00+03:00', { staffYcId: 3356928 })).toBe(true);
    // Мастер известен с обеих сторон и не совпадает → не подтверждено.
    expect(ev.has('2026-09-23T17:00:00+03:00', { staffYcId: 1 })).toBe(false);
    // Мастер не указан на стороне write → достаточно совпадения времени.
    expect(ev.has('2026-09-23T17:00:00+03:00')).toBe(true);
    expect(ev.has('2026-09-23T18:00:00+03:00', { staffYcId: 3356928 })).toBe(false);
  });

  test('сравнение по моменту: «2026-09-23 17:00:00» и ISO с +03:00 — одно время', () => {
    const ev = createSlotEvidence();
    ev.add('get_available_slots', { staff_yc_id: 5 }, { slots: [slot('17:00')] });
    expect(ev.has('2026-09-23T17:00:00+03:00')).toBe(true);
    expect(ev.has('2026-09-23T14:00:00Z')).toBe(true);        // тот же момент в UTC
    expect(ev.has('2026-09-23T17:00:00Z')).toBe(false);
    expect(ev.has('мусор')).toBe(false);
    expect(ev.has(null)).toBe(false);
  });

  test('alternative_staff / staff_options — слоты со СВОИМ staff_yc_id', () => {
    const ev = createSlotEvidence();
    ev.add('get_available_slots', { staff_yc_id: 3356928, date: '2026-09-22' }, {
      slots: [], staff_not_working: true,
      alternative_staff: [{ name: 'Юлия', staff_yc_id: 111, slots: [slot('10:00', '2026-09-22')] }],
    });
    ev.add('get_available_slots', { date: '2026-09-24' }, {
      staff_options: [{ staff_yc_id: 222, name: 'Т', slots: [slot('12:00', '2026-09-24')] }],
    });
    expect(ev.has('2026-09-22T10:00:00+03:00', { staffYcId: 111 })).toBe(true);
    expect(ev.has('2026-09-22T10:00:00+03:00', { staffYcId: 3356928 })).toBe(false);
    expect(ev.has('2026-09-24T12:00:00+03:00', { staffYcId: 222 })).toBe(true);
  });

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

  test('get_sequential_slots: каждое звено цепочки со своим мастером', () => {
    const ev = createSlotEvidence();
    ev.add('get_sequential_slots', { date: '2026-09-23' }, {
      variants: [{ type: 'same_staff', starts: [{
        time: '13:30', option_id: 'o1',
        chain: [
          { datetime: '2026-09-23T13:30:00+03:00', staff_yc_id: 3356928, service_yc_id: 1 },
          { datetime: '2026-09-23T14:20:00+03:00', staff_yc_id: 3356928, service_yc_id: 2 },
        ],
      }] }],
    });
    expect(ev.has('2026-09-23T13:30:00+03:00', { staffYcId: 3356928 })).toBe(true);
    expect(ev.has('2026-09-23T14:20:00+03:00', { staffYcId: 3356928 })).toBe(true);
    expect(ev.has('2026-09-23T14:20:00+03:00', { staffYcId: 9 })).toBe(false);
  });

  test('get_parallel_slots: старты гостей', () => {
    const ev = createSlotEvidence();
    ev.add('get_parallel_slots', { date: '2026-09-23' }, {
      starts: [{ time: '12:00', guests: [
        { staff_yc_id: 1, datetime: '2026-09-23T12:00:00+03:00' },
        { staff_yc_id: 2, datetime: '2026-09-23T12:00:00+03:00' },
      ] }],
    });
    expect(ev.has('2026-09-23T12:00:00+03:00', { staffYcId: 2 })).toBe(true);
    expect(ev.has('2026-09-23T12:00:00+03:00', { staffYcId: 3 })).toBe(false);
  });

  test('create_booking с available_slots после отказа — свежие старты того же мастера', () => {
    const ev = createSlotEvidence();
    ev.add('create_booking', { staff_yc_id: 7, datetime: '2026-09-23T12:00:00+03:00' },
      { created: false, slot_unavailable: true, available_slots: [slot('15:00')] });
    expect(ev.has('2026-09-23T15:00:00+03:00', { staffYcId: 7 })).toBe(true);
    // Сам отвергнутый старт evidence не становится.
    expect(ev.has('2026-09-23T12:00:00+03:00', { staffYcId: 7 })).toBe(false);
  });

  test('прочие инструменты и ошибочные результаты игнорируются', () => {
    const ev = createSlotEvidence();
    ev.add('list_client_bookings', {}, { bookings: [{ datetime: '2026-09-23T12:00:00+03:00' }] });
    ev.add('get_available_slots', { staff_yc_id: 1 }, { error: 'boom', slots: [slot('10:00')] });
    ev.add('get_available_slots', { staff_yc_id: 1 }, null);
    expect(ev.size).toBe(0);
  });

  test('SLOT_EVIDENCE_TOOLS перечисляет ровно источники', () => {
    expect([...SLOT_EVIDENCE_TOOLS].sort()).toEqual(
      ['create_booking', 'get_available_slots', 'get_parallel_slots', 'get_sequential_slots']);
  });
});

describe('seedFromJournal', () => {
  const NOW = Date.parse('2026-09-23T10:00:00+03:00');
  const row = (ageMs, extra = {}) => ({
    tool: 'get_available_slots', input: { staff_yc_id: 3356928 },
    result: { slots: [slot('13:30')] }, is_error: false, delivered: true, age_ms: ageMs, ...extra,
  });

  test('свежая строка журнала (< 30 мин) засевает evidence', () => {
    const ev = createSlotEvidence();
    ev.seedFromJournal([row(5 * 60 * 1000)], { nowMs: NOW });
    expect(ev.has('2026-09-23T13:30:00+03:00', { staffYcId: 3356928 })).toBe(true);
  });

  test('протухшая строка (> 30 мин) не засевает — слоты уже могли уйти', () => {
    const ev = createSlotEvidence();
    ev.seedFromJournal([row(31 * 60 * 1000)], { nowMs: NOW });
    expect(ev.size).toBe(0);
  });

  test('ошибочные строки и выброшенные черновики: ошибка — нет, черновик — да (слот реален)', () => {
    const ev = createSlotEvidence();
    ev.seedFromJournal([row(1000, { is_error: true }), row(1000, { delivered: false })], { nowMs: NOW });
    expect(ev.size).toBe(1);
  });

  test('battery: null/не массив — no-op', () => {
    const ev = createSlotEvidence();
    ev.seedFromJournal(null, { nowMs: NOW });
    ev.seedFromJournal('x', { nowMs: NOW });
    expect(ev.size).toBe(0);
  });
});

// Сверка предложенного времени по паре «дата + мастер» (offer-attribution):
// evidence хранит и ИМЯ мастера, и отдаёт старты по московской дате.
describe('slotsOn / имена мастеров', () => {
  test('старты по дате с именами из всех источников', () => {
    const ev = createSlotEvidence();
    ev.add('get_available_slots', { staff_yc_id: 1, date: '2026-09-23' }, {
      staff_name: 'Богатырева Татьяна', slots: [slot('13:30')],
      alternative_staff: [{ staff_yc_id: 2, name: 'Гатауллина Юлия', slots: [slot('10:00')] }],
    });
    ev.add('get_sequential_slots', {}, { variants: [{ starts: [{ chain: [
      { datetime: '2026-09-23T14:00:00+03:00', staff_yc_id: 1, staff_name: 'Богатырева Татьяна' }] }] }] });
    const on = ev.slotsOn('2026-09-23');
    expect(on).toEqual(expect.arrayContaining([
      { time: '13:30', staffId: 1, name: 'Богатырева Татьяна' },
      { time: '10:00', staffId: 2, name: 'Гатауллина Юлия' },
      { time: '14:00', staffId: 1, name: 'Богатырева Татьяна' },
    ]));
    expect(ev.slotsOn('2026-09-24')).toEqual([]);
    expect(ev.dateKeys()).toEqual(['2026-09-23']);
  });

  test('дата считается по Москве: 23:30 UTC 22.09 — это 02:30 мск 23.09', () => {
    const ev = createSlotEvidence();
    ev.add('get_available_slots', { staff_yc_id: 1 }, { slots: [{ datetime: '2026-09-22T23:30:00Z' }] });
    expect(ev.dateKeys()).toEqual(['2026-09-23']);
    expect(ev.slotsOn('2026-09-23')[0].time).toBe('02:30');
  });
});
