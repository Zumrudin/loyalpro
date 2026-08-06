'use strict';

// Инцидент 2026-08-06 (79037504378): инструмент отдавал slots строго по
// возрастанию времени, модель брала из начала и записала пациентку на 11:30 при
// сплошном блоке мастера 14:30–21:00. Теперь рядом со slots едет offer_slots —
// детерминированно подобранные времена, примыкающие к существующим записям.

jest.mock('./db', () => ({
  db: {
    one: jest.fn(async () => ({ id: 1, yclients_company_id: 100 })),
    oneOrNone: jest.fn(async () => ({ id: 1, yclients_company_id: 100 })),
    any: jest.fn(async () => []),
  },
}));
jest.mock('./services/yclients-booking', () => ({
  ycGetBookTimes: jest.fn(async () => []),
  ycGetStaffSeances: jest.fn(async () => []),
}));
jest.mock('./services/agent-settings', () => ({ loadServiceFilterSafe: jest.fn(async () => ({})) }));
jest.mock('./services/agent/service-filter', () => ({
  isBookable: jest.fn(() => true),
  decideServiceVisible: jest.fn(() => true),
}));
jest.mock('./services/agent/staff-service-guard', () => ({
  checkStaffPerformsService: jest.fn(async () => ({ ok: true, unknown: false, performers: [], staffList: [] })),
}));
jest.mock('./services/agent/equipment-context', () => ({
  loadEquipmentContext: jest.fn(async () => ({})),
  durationMin: jest.fn(() => 30),
  instancesFor: jest.fn(() => []),
  busyForService: jest.fn(() => []),
}));

const { ycGetBookTimes, ycGetStaffSeances } = require('./services/yclients-booking');
const tool = require('./services/agent/tools/get-available-slots');

// Сетка сеансов: точки через 5 минут, to эксклюзивно, busy — интервалы 'HH:MM'.
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

// 06.08.2026 13:45 мск — момент боевого вызова (lead-time на завтра не режет).
const CTX = { nowMs: Date.parse('2026-08-06T13:45:00+03:00') };
const ARGS = { staff_yc_id: 1910274, service_yc_id: 9536676, date: '2026-08-07' };

beforeEach(() => {
  jest.clearAllMocks();
  ycGetBookTimes.mockResolvedValue([]);
  ycGetStaffSeances.mockResolvedValue([]);
});

describe('offer_slots: одномастерная выдача', () => {
  test('боевой день 07.08 — первым 14:00, slots остаётся полным', async () => {
    ycGetStaffSeances.mockResolvedValue(grid('11:00', '21:00', [['14:30', '21:00']]));
    const res = await tool.run(1, ARGS, CTX);
    expect(res.slots.map(s => s.time))
      .toEqual(['11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00']);
    expect(res.offer_slots.map(s => s.time)).toEqual(['14:00', '13:30']);
  });

  test('offer_slots — это объекты ИЗ slots (тот же datetime для create_booking)', async () => {
    ycGetStaffSeances.mockResolvedValue(grid('11:00', '21:00', [['14:30', '21:00']]));
    const res = await tool.run(1, ARGS, CTX);
    for (const o of res.offer_slots) expect(res.slots).toContainEqual(o);
  });

  test('booking-ветка: занятость дотягивается сеткой, offer_slots считается', async () => {
    ycGetBookTimes.mockResolvedValue([
      { time: '11:00', datetime: '2026-08-07T11:00:00+03:00', seance_length: 1800 },
      { time: '14:00', datetime: '2026-08-07T14:00:00+03:00', seance_length: 1800 },
    ]);
    ycGetStaffSeances.mockResolvedValue(grid('11:00', '21:00', [['14:30', '21:00']]));
    const res = await tool.run(1, ARGS, CTX);
    expect(res.source).toBe('booking');
    expect(res.offer_slots.map(s => s.time)).toEqual(['14:00', '11:00']);
  });

  // Fail-open: без занятости деградируем в сегодняшнее поведение (самые ранние),
  // а не в отсутствие ответа. Сбой сетки не должен стоить пациенту времени.
  test('booking-ветка: сетка недоступна → самые ранние, ответ не падает', async () => {
    ycGetBookTimes.mockResolvedValue([
      { time: '11:00', datetime: '2026-08-07T11:00:00+03:00', seance_length: 1800 },
      { time: '14:00', datetime: '2026-08-07T14:00:00+03:00', seance_length: 1800 },
    ]);
    ycGetStaffSeances.mockRejectedValue(new Error('YClients 500'));
    const res = await tool.run(1, ARGS, CTX);
    expect(res.offer_slots.map(s => s.time)).toEqual(['11:00', '14:00']);
  });

  test('пустой день у мастера → offer_slots пуст, а не выдуман', async () => {
    ycGetStaffSeances.mockResolvedValue(grid('11:00', '21:00', [['11:00', '21:00']]));
    const res = await tool.run(1, ARGS, CTX);
    expect(res.slots).toEqual([]);
    expect(res.offer_slots).toEqual([]);
  });
});
