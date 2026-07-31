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
    // один мастер, встык без перерыва → одна запись
    expect(r.variants[0].starts[0].booking_mode).toBe('single_record');
    // ранний стоп: график запрашивался только на запрошенную дату
    const dates = new Set(ycGetStaffSeances.mock.calls.map(c => c[2]));
    expect(dates).toEqual(new Set([DATE]));
    expect(r.preferred_staff_cannot).toBeUndefined();
    // hint нормального успешного ответа предписывает оформление ОДНИМ вызовом book_chain
    expect(r.hint).toMatch(/book_chain[\s\S]{0,80}option_id/i);
  });

  test('preferred не делает часть услуг → preferred_staff_cannot + mixed с его участием', async () => {
    // Все работают 10:00–13:00, но ТОЛЬКО в запрошенный день — иначе other_staff
    // по трём датам заполняет потолок MAX_VARIANTS и вытесняет mixed из шортлиста.
    ycGetStaffSeances.mockImplementation(async (s, staffId, day) =>
      (day === DATE ? grid(600, 780) : []));
    const r = await runTool({ ...baseInput, preferred_staff_yc_id: 21 });
    expect(r.preferred_staff_cannot).toEqual(['Чистка']);
    expect(r.variants.some(v => v.type === 'same_staff')).toBe(false);
    expect(r.variants.length).toBeGreaterThan(0);
    expect(r.variants.length).toBeLessThanOrEqual(6);            // потолок MAX_VARIANTS
    expect(r.variants[0].type).toBe('other_staff');              // Юлия или Татьяна целиком
    const mixed = r.variants.find(v => v.type === 'mixed');
    expect(mixed).toBeDefined();
    expect(mixed.starts[0].chain[0].staff_yc_id).toBe(21);       // био у преферред-Астемира
    expect([11, 12]).toContain(mixed.starts[0].chain[1].staff_yc_id);
    // разные мастера → каждую услугу отдельной записью
    expect(mixed.starts[0].booking_mode).toBe('separate_records');
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
    // ГЛАВНОЕ: даже один мастер, но с внутренним перерывом → отдельные записи,
    // иначе одна непрерывная запись стёрла бы перерыв и заняла бы чужой аппарат.
    expect(gapVariant.starts[0].booking_mode).toBe('separate_records');
    // а встык на другой день у того же мастера — одной записью
    expect(r.variants[noGapIdx].starts[0].booking_mode).toBe('single_record');
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

  test('каждый старт выдачи имеет уникальный option_id формата oN', async () => {
    ycGetStaffSeances.mockImplementation(async (s, staffId) =>
      String(staffId) === '11' ? grid(600, 780) : []);
    const r = await runTool({ ...baseInput, preferred_staff_yc_id: 11 });
    const ids = r.variants.flatMap(v => v.starts.map(s => s.option_id));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^o\d+$/);
  });

  test('варианты запоминаются в sequential-offers: take по option_id отдаёт chain и booking_mode', async () => {
    const offers = require('./services/agent/sequential-offers');
    offers._reset();
    ycGetStaffSeances.mockImplementation(async (s, staffId) =>
      String(staffId) === '11' ? grid(600, 780) : []);
    const r = await tool.run(1, { ...baseInput, preferred_staff_yc_id: 11 }, { ...CTX, dialogKey: 'dlg' });
    const st = r.variants[0].starts[0];
    const saved = offers.take(1, 'dlg', st.option_id);
    expect(saved.chain).toEqual(st.chain);
    expect(saved.booking_mode).toBe(st.booking_mode);
  });
});

// Якорный режим: первая услуга уже забронирована, её НЕ двигаем — добавляем следующую после неё.
describe('get_sequential_slots — якорь (первая услуга уже записана)', () => {
  const PERI = { yc_id: 31, name: 'Пери' };            // врач, ведёт консультацию; чистку — нет
  const CONSULT = 902;
  // Чистка у Юлии (записана), консультацию ведёт только врач Пери.
  const ANCHOR_CATALOG = {
    services: [
      { yc_id: CLEAN, title: 'Чистка', staff: [YULIA] },
      { yc_id: CONSULT, title: 'Консультация', staff: [PERI] },
    ],
  };
  const anchorInput = {
    services: [{ service_yc_id: CLEAN }, { service_yc_id: CONSULT }],
    date: DATE,
    preferred_staff_yc_id: 11,                          // Юлия — мастер записанной чистки
    first_booked_datetime: `${DATE}T15:30`,             // чистка уже стоит 15:30
  };

  beforeEach(() => {
    listServices.run.mockResolvedValue(ANCHOR_CATALOG);
    // Чистка 60 мин, консультация 30 мин.
    eqContext.durationMin.mockImplementation((ctx, id) => (id === CLEAN ? 60 : 30));
  });

  test('чистка остаётся в 15:30, консультация встаёт в окно врача 17:00 (перерыв 30), запись не двигается', async () => {
    // Пери свободна ТОЛЬКО 17:00–18:00. Чистка 15:30–16:30 → консультация раньше 17:00 невозможна.
    ycGetStaffSeances.mockImplementation(async (s, staffId) =>
      String(staffId) === '31' ? grid(1020, 1080) : grid(600, 900));  // Пери 17–18; Юлия до полудня (не важно — якорь)
    const r = await runTool(anchorInput);

    expect(r.anchored).toBe(true);
    expect(r.variants).toHaveLength(1);
    const v = r.variants[0];
    expect(v.type).toBe('mixed');
    expect(v.with_gap).toBe(true);
    const start = v.starts[0];
    // Чистка НЕ сдвинута — стоит ровно в 15:30 и помечена как уже записанная.
    expect(start.chain[0].datetime).toBe(`${DATE}T15:30:00+03:00`);
    expect(start.chain[0].already_booked).toBe(true);
    expect(start.chain[0].staff_yc_id).toBe(11);
    // Консультация — у врача Пери в 17:00, честный перерыв 30 мин.
    expect(start.chain[1].datetime).toBe(`${DATE}T17:00:00+03:00`);
    expect(start.chain[1].staff_yc_id).toBe(31);
    expect(start.gap_minutes).toBe(30);
    // Добавляемую услугу оформляем ОТДЕЛЬНОЙ записью, записанную чистку не трогаем.
    expect(start.booking_mode).toBe('separate_records');
    // Записанный мастер консультацию не ведёт — подсказка назвать исполнителя.
    expect(r.preferred_staff_cannot).toEqual(['Консультация']);
    // hint якорного успешного ответа тоже предписывает ОДИН вызов book_chain
    expect(r.hint).toMatch(/book_chain[\s\S]{0,80}option_id/i);
  });

  test('консультация встык (врач свободен сразу после чистки) → перерыв 0, не with_gap', async () => {
    ycGetStaffSeances.mockImplementation(async (s, staffId) =>
      String(staffId) === '31' ? grid(990, 1080) : grid(600, 900));  // Пери с 16:30
    const r = await runTool(anchorInput);

    const start = r.variants[0].starts[0];
    expect(start.chain[1].datetime).toBe(`${DATE}T16:30:00+03:00`);
    expect(start.gap_minutes).toBe(0);
    expect(r.variants[0].with_gap).toBeUndefined();
    expect(start.booking_mode).toBe('separate_records');  // не единая запись: чистка уже существует
  });

  test('после записанной чистки врач в этот день не свободен → no_slot_after_booked, чистку не переносим', async () => {
    ycGetStaffSeances.mockImplementation(async (s, staffId) =>
      String(staffId) === '31' ? grid(600, 700) : grid(600, 900));  // Пери свободна только утром, ДО чистки
    const r = await runTool(anchorInput);

    expect(r.anchored).toBe(true);
    expect(r.variants).toEqual([]);
    expect(r.reason).toBe('no_slot_after_booked');
    expect(r.hint).toMatch(/НЕ переноси|отдельным визитом/i);
  });
});

describe('get_sequential_slots — schema.description направляет на book_chain', () => {
  test('description упоминает оформление выбранного варианта через book_chain по option_id', () => {
    expect(tool.schema.description).toMatch(/book_chain[\s\S]{0,80}option_id/i);
  });
});

describe('get_sequential_slots — минимальный срок до визита', () => {
  test('заявка в 22:00+ на завтра: старты цепочек раньше 12:00 не предлагаются', async () => {
    // Юлия-универсал работает завтра 10:00–15:00; цепочка био+чистка = 120 мин →
    // без ограничения старты были бы 10:00…13:00, с вечерним floor — только с 12:00.
    ycGetStaffSeances.mockImplementation(async (s, staffId) =>
      String(staffId) === '11' ? grid(600, 900) : []);
    const EVENING = { nowMs: Date.parse('2026-08-09T22:30:00+03:00') };  // DATE = завтра
    const r = await tool.run(1, { ...baseInput, preferred_staff_yc_id: 11 }, EVENING);
    const v = r.variants.find(x => x.date === DATE);
    expect(v).toBeDefined();
    const times = v.starts.map(st => st.time);
    expect(times[0]).toBe('12:00');
    expect(times.every(t => t >= '12:00')).toBe(true);
  });

  test('днём накануне ограничения нет — ранние старты на месте', async () => {
    ycGetStaffSeances.mockImplementation(async (s, staffId) =>
      String(staffId) === '11' ? grid(600, 900) : []);
    const DAYTIME = { nowMs: Date.parse('2026-08-09T15:00:00+03:00') };
    const r = await tool.run(1, { ...baseInput, preferred_staff_yc_id: 11 }, DAYTIME);
    expect(r.variants[0].starts[0].time).toBe('10:00');
  });
});
