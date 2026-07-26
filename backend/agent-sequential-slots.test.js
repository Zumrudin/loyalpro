'use strict';

// Оркестрация get_sequential_slots: лестница приоритета мастеров, ранний стоп,
// with_gap, сортировка, деградация при сбоях графика. Чистая арифметика цепочек
// покрыта в services/agent/sequential.test.js — здесь только логика run().

jest.mock('./db', () => ({
  db: { oneOrNone: jest.fn(async () => ({ id: 1, yclients_company_id: 100 })) },
}));
jest.mock('./services/yclients-booking', () => ({
  ycGetStaffSeances: jest.fn(async () => []),
}));
jest.mock('./services/agent-settings', () => ({ loadServiceFilterSafe: jest.fn(async () => ({})) }));
jest.mock('./services/agent/service-filter', () => ({ isBookable: jest.fn(() => true) }));
jest.mock('./services/agent/equipment-context', () => ({
  loadEquipmentContext: jest.fn(async () => ({})),
  durationMin: jest.fn(),
  busyForService: jest.fn(() => []),
}));
jest.mock('./services/agent/tools/list-services', () => ({ run: jest.fn() }));

const { ycGetStaffSeances } = require('./services/yclients-booking');
const svcFilter = require('./services/agent/service-filter');
const eqContext = require('./services/agent/equipment-context');
const listServices = require('./services/agent/tools/list-services');
const tool = require('./services/agent/tools/get-sequential-slots');

const YULIA = { yc_id: 11, name: 'Юлия' };
const TANYA = { yc_id: 12, name: 'Татьяна' };
const ASTEMIR = { yc_id: 21, name: 'Астемир' };
const BIO = 900, CLEAN = 901;

const CATALOG = {
  services: [
    { yc_id: BIO, title: 'Био', staff: [YULIA, TANYA, ASTEMIR] },
    { yc_id: CLEAN, title: 'Чистка', staff: [YULIA, TANYA] },
  ],
};

// 5-мин грид is_free для окна [fromMin, toMin) — как отдаёт /timetable/seances.
const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const grid = (fromMin, toMin) => {
  const out = [];
  for (let m = fromMin; m < toMin; m += 5) out.push({ time: toHHMM(m), is_free: true });
  return out;
};

const DATE = '2026-08-10';                       // будущее — dropPast не мешает
const CTX = { nowMs: Date.parse('2026-08-01T09:00:00+03:00') };
const runTool = (input) => tool.run(1, input, CTX);
const baseInput = { services: [{ service_yc_id: BIO }, { service_yc_id: CLEAN }], date: DATE };

beforeEach(() => {
  jest.clearAllMocks();
  listServices.run.mockResolvedValue(CATALOG);
  svcFilter.isBookable.mockReturnValue(true);
  eqContext.durationMin.mockImplementation((ctx, id) => (id === BIO ? 30 : 90));
  eqContext.busyForService.mockReturnValue([]);
  ycGetStaffSeances.mockResolvedValue([]);      // по умолчанию никто не работает
});

describe('get_sequential_slots — лестница приоритета', () => {
  test('preferred-универсал → same_staff первым и ранний стоп на первом дне', async () => {
    // Юлия работает каждый день 10:00–13:00; preferred = Юлия.
    ycGetStaffSeances.mockImplementation(async (s, staffId) =>
      String(staffId) === '11' ? grid(600, 780) : []);
    const r = await runTool({ ...baseInput, preferred_staff_yc_id: 11 });
    expect(r.variants[0].type).toBe('same_staff');
    expect(r.variants[0].date).toBe(DATE);
    expect(r.variants[0].starts[0].time).toBe('10:00');
    // цепочка: био 10:00–10:30, чистка 10:30–12:00
    expect(r.variants[0].starts[0].chain[1].datetime).toBe(`${DATE}T10:30:00+03:00`);
    // ранний стоп: график запрашивался только на запрошенную дату
    const dates = new Set(ycGetStaffSeances.mock.calls.map(c => c[2]));
    expect(dates).toEqual(new Set([DATE]));
    expect(r.preferred_staff_cannot).toBeUndefined();
  });

  test('preferred не делает часть услуг → preferred_staff_cannot и нет same_staff', async () => {
    // Все работают 10:00–13:00; preferred = Астемир (чистку не делает).
    ycGetStaffSeances.mockResolvedValue(grid(600, 780));
    const r = await runTool({ ...baseInput, preferred_staff_yc_id: 21 });
    expect(r.preferred_staff_cannot).toEqual(['Чистка']);
    expect(r.variants.some(v => v.type === 'same_staff')).toBe(false);
    if (r.variants.length > 0) {
      expect(r.variants[0].type).toBe('other_staff');           // Юлия или Татьяна целиком
    }
  });

  test('встык на другой день сортируется раньше with_gap на запрошенный', async () => {
    // Запрошенный день: у Юлии био-окно 10:00–10:30 и чистка только 20:00–21:30 (перерыв).
    // Следующий день: у Юлии сплошное окно 10:00–13:00 (встык).
    const NEXT = '2026-08-11';
    ycGetStaffSeances.mockImplementation(async (s, staffId, day) => {
      if (String(staffId) !== '11') return [];
      if (day === DATE) return [...grid(600, 630), ...grid(1200, 1290)];
      if (day === NEXT) return grid(600, 780);
      return [];
    });
    const r = await runTool(baseInput);
    const types = r.variants.map(v => `${v.type}${v.with_gap ? '+gap' : ''}@${v.date}`);
    const noGapIdx = types.findIndex(t => t === `other_staff@${NEXT}`);
    const gapIdx = types.findIndex(t => t.startsWith('other_staff+gap@' + DATE));
    expect(noGapIdx).toBeGreaterThanOrEqual(0);
    expect(gapIdx).toBeGreaterThanOrEqual(0);
    expect(noGapIdx).toBeLessThan(gapIdx);                    // встык раньше with_gap
    const gapVariant = r.variants[gapIdx];
    expect(gapVariant.starts[0].gap_minutes).toBeGreaterThan(15);
    expect(r.variants.filter(v => v.with_gap).length).toBe(1); // gap-вариант один
  });

  test('сбой графика → schedule_degraded и осторожный hint при пустой выдаче', async () => {
    ycGetStaffSeances.mockRejectedValue(new Error('YClients 500'));
    const r = await runTool(baseInput);
    expect(r.variants).toEqual([]);
    expect(r.schedule_degraded).toBe(true);
    expect(r.reason).toBe('no_combo_in_horizon');
    expect(r.hint).toMatch(/schedule_degraded|не удалось/i);
  });

  test('все пары услуги скрыты фильтром → filtered с hint, YClients не дёргаем', async () => {
    svcFilter.isBookable.mockImplementation((f, svcId) => String(svcId) !== String(CLEAN));
    const r = await runTool(baseInput);
    expect(r).toMatchObject({ variants: [], filtered: true });
    expect(r.hint).toMatch(/не подбирай другого мастера|отдельные визиты/i);
    expect(ycGetStaffSeances).not.toHaveBeenCalled();
  });
});
