'use strict';

const { renderBookings, MAX_LINES } = require('./services/agent/bookings-block');
const { isRecordAlive } = require('./services/agent/record-liveness');

// 04.08.2026 23:40 мск — момент инцидента 79200255591.
const NOW = Date.parse('2026-08-04T23:40:00+03:00');

const REC = {
  record_id: 1886730339,
  datetime: '2026-08-05T12:00:00+03:00',
  services: ['Лазерное удаление сосудов'],
  staff_yc_id: 1914276,
  staff_name: 'Гатауллина Юлия',
};

describe('record-liveness.isRecordAlive', () => {
  test('живая запись', () => {
    expect(isRecordAlive({ id: 1, attendance: 0 })).toBe(true);
    expect(isRecordAlive({ id: 1, attendance: 2, deleted: false })).toBe(true);
  });

  // Удалённую запись YClients отдаёт ТЕЛОМ с deleted:true, а не 404 — проверено
  // на боевой записи 1886730339 (удалена из интерфейса 2026-08-04).
  test('удалённая в YClients — мертва', () => {
    expect(isRecordAlive({ id: 1886730339, attendance: 0, deleted: true })).toBe(false);
  });

  test('отменённая агентом (attendance=-1) — мертва', () => {
    expect(isRecordAlive({ id: 1, attendance: -1 })).toBe(false);
  });

  test('пустой ответ — мертва (не бросает)', () => {
    expect(isRecordAlive(null)).toBe(false);
    expect(isRecordAlive({})).toBe(false);
    expect(isRecordAlive(undefined)).toBe(false);
  });
});

describe('bookings-block.renderBookings', () => {
  test('строка: дата с днём недели, время по Москве, услуги, мастер, record_id', () => {
    const { lines } = renderBookings([REC], { nowMs: NOW });
    expect(lines).toEqual([
      '05.08 (ср) 12:00 — Лазерное удаление сосудов, мастер Гатауллина Юлия [record_id 1886730339]',
    ]);
  });

  test('несколько услуг перечисляются через запятую', () => {
    const { lines } = renderBookings(
      [{ ...REC, services: ['Чистка', 'Массаж лица'] }], { nowMs: NOW });
    expect(lines[0]).toContain('Чистка, Массаж лица, мастер');
  });

  test('без мастера и без услуг строка всё равно валидна', () => {
    const { lines } = renderBookings(
      [{ record_id: 7, datetime: '2026-08-05T12:00:00+03:00' }], { nowMs: NOW });
    expect(lines[0]).toBe('05.08 (ср) 12:00 — услуга не указана [record_id 7]');
  });

  test('сортировка по времени, ближайшая первой', () => {
    const { lines } = renderBookings([
      { ...REC, record_id: 2, datetime: '2026-08-09T10:00:00+03:00' },
      { ...REC, record_id: 1, datetime: '2026-08-05T12:00:00+03:00' },
    ], { nowMs: NOW });
    expect(lines[0]).toContain('record_id 1');
    expect(lines[1]).toContain('record_id 2');
  });

  test('прошедшие визиты и битые даты не показываются', () => {
    const { lines } = renderBookings([
      { ...REC, record_id: 1, datetime: '2026-08-04T10:00:00+03:00' },  // уже прошёл
      { ...REC, record_id: 2, datetime: 'вчера' },                       // не разбирается
      REC,
    ], { nowMs: NOW });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('record_id 1886730339');
  });

  // Блок — последнее слово о том, что у пациента есть. Он не имеет права
  // рекламировать отменённое, даже если мёртвая запись как-то до него дошла.
  test('мёртвые записи отсеиваются тем же предикатом, что и в list_client_bookings', () => {
    const { lines } = renderBookings([
      { ...REC, record_id: 1, deleted: true },
      { ...REC, record_id: 2, attendance: -1 },
    ], { nowMs: NOW });
    expect(lines).toHaveLength(0);
  });

  test('потолок строк: лишнее в dropped, а не в промпте', () => {
    const many = Array.from({ length: MAX_LINES + 3 }, (_, i) => ({
      ...REC, record_id: 100 + i,
      datetime: `2026-08-${String(5 + i).padStart(2, '0')}T12:00:00+03:00`,
    }));
    const { lines, dropped } = renderBookings(many, { nowMs: NOW });
    expect(lines).toHaveLength(MAX_LINES);
    expect(dropped).toBe(3);
  });

  test('мусор на входе не роняет рендер', () => {
    for (const bad of [null, undefined, 'записи', [null, undefined, {}]]) {
      expect(renderBookings(bad, { nowMs: NOW }).lines).toEqual([]);
    }
  });
});
