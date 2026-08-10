'use strict';

// Регресс на инцидент 2026-08-10 (79166524647). У Гаджиевой Пери отпуск 12–31.08;
// журнал agent_tool_events показывает 12 вызовов get_available_slots по ней на
// 9 разных дат — и КАЖДЫЙ вернул голое `slots: []`. Ни одного слова о том, что
// мастера нет в графике, модель не получила: снаружи отпуск выглядит ровно как
// «работает, но день расписан». Дальше она перебирала даты и в итоге выдала окна
// Астемира Боташева за окна Пери.
//
// Фикс: при пустой выдаче тул сам сверяется с графиком (management /schedule —
// тот же источник, что у get_available_dates) и говорит прямо: не работает,
// ближайший приёмный день такой-то.

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
  ycGetStaffSchedule: jest.fn(async () => []),
}));
jest.mock('./services/agent-settings', () => ({ loadServiceFilterSafe: jest.fn(async () => ({})) }));
jest.mock('./services/agent/service-filter', () => ({ isBookable: jest.fn(() => true) }));
jest.mock('./services/agent/equipment-context', () => ({
  loadEquipmentContext: jest.fn(async () => ({ busy: [], resources: [] })),
  durationMin: jest.fn(() => 60),
  instancesFor: jest.fn(() => []),
  busyForService: jest.fn(() => []),
}));
jest.mock('./services/agent/tools/list-services', () => ({ run: jest.fn() }));

const { ycGetBookTimes, ycGetStaffSeances, ycGetStaffSchedule } = require('./services/yclients-booking');
const listServices = require('./services/agent/tools/list-services');
const slots = require('./services/agent/tools/get-available-slots');

// Услуга 900: Пери (1910274) и Астемир (5708379) — как на проде.
const CATALOG = {
  services: [
    { yc_id: 900, title: 'Биоревитализация', staff: [
      { yc_id: 1910274, name: 'Гаджиева Пери' }, { yc_id: 5708379, name: 'Астемир Боташев' },
    ] },
  ],
};
const NOW = Date.parse('2026-08-10T08:34:00+03:00');
const DATE = '2026-08-14';
const ARGS = { staff_yc_id: 1910274, service_yc_id: 900, date: DATE };

const off = (date) => ({ date, is_working: 0, slots: [] });
const on = (date) => ({ date, is_working: 1, slots: [{ from: '10:00', to: '22:00' }] });

beforeEach(() => {
  jest.clearAllMocks();
  listServices.run.mockResolvedValue(CATALOG);
  ycGetBookTimes.mockResolvedValue([]);
  ycGetStaffSeances.mockResolvedValue([]);
  ycGetStaffSchedule.mockResolvedValue([]);
});

// Имя запрошенного мастера в выдаче нужно не модели, а reply-guard'у: без него
// оркестратор не знает, ЧЬЯ выдача оказалась пустой, и проверка приписывания
// чужого времени (checkStaffAttribution) сравнивать не с чем.
describe('get_available_slots — имя запрошенного мастера в выдаче', () => {
  test('слоты есть → staff_name рядом с ними', async () => {
    ycGetBookTimes.mockResolvedValue([{ time: '11:00', datetime: `${DATE}T11:00:00+03:00`, seance_length: 3600 }]);
    const out = await slots.run(1, ARGS, { nowMs: NOW });
    expect(out.staff_name).toBe('Гаджиева Пери');
  });

  test('слотов нет → staff_name всё равно есть', async () => {
    const out = await slots.run(1, ARGS, { nowMs: NOW });
    expect(out.slots).toEqual([]);
    expect(out.staff_name).toBe('Гаджиева Пери');
  });

  test('каталог не знает мастера (fail-open предпроверки) → поля просто нет', async () => {
    listServices.run.mockResolvedValue({ services: [] });
    const out = await slots.run(1, ARGS, { nowMs: NOW });
    expect(out.staff_name).toBeUndefined();
  });
});

describe('get_available_slots — мастера нет в графике', () => {
  test('отпуск: пустые слоты + график без рабочих дней → staff_not_working и ближайший приёмный день', async () => {
    // Пери в отпуске с 12.08, выходит 01.09; у Астемира на 14.08 тоже пусто,
    // чтобы ветка альтернативы не мешала читать результат.
    ycGetStaffSchedule.mockImplementation(async (_salon, staffId) => (
      staffId === 1910274
        ? ['2026-08-14', '2026-08-15', '2026-08-16'].map(off).concat([on('2026-09-01')])
        : []));
    const out = await slots.run(1, ARGS, { nowMs: NOW });
    expect(out.slots).toEqual([]);
    expect(out.staff_not_working).toBe(true);
    expect(out.staff_next_working_date).toBe('2026-09-01');
    expect(out.hint).toMatch(/не работает/i);
    // Имя в хинте не украшение: без него «мастер не работает» рядом с окнами
    // другого специалиста снова читается как утверждение про кого угодно.
    expect(out.hint).toContain('Гаджиева Пери');
  });

  test('ближайшего приёмного дня в окне нет → staff_next_working_date null, названа граница проверки', async () => {
    ycGetStaffSchedule.mockResolvedValue(['2026-08-14', '2026-08-15', '2026-08-20'].map(off));
    const out = await slots.run(1, ARGS, { nowMs: NOW });
    expect(out.staff_not_working).toBe(true);
    expect(out.staff_next_working_date).toBe(null);
    expect(out.staff_schedule_checked_until).toBe('2026-08-20');
  });

  // Иначе «занят» и «в отпуске» снова слипаются, только уже в обратную сторону:
  // мастер на работе, весь день расписан — это НЕ повод говорить «не принимает».
  test('мастер работает, но день расписан → флага нет', async () => {
    ycGetStaffSchedule.mockResolvedValue([on(DATE)]);
    const out = await slots.run(1, ARGS, { nowMs: NOW });
    expect(out.slots).toEqual([]);
    expect(out.staff_not_working).toBeUndefined();
  });

  // Fail-open: сбой графика не должен ни ронять выдачу, ни превращаться в
  // выдуманный отпуск (тот же класс, что «это время только что заняли», 31.07).
  test('график не ответил → флага нет, выдача цела', async () => {
    ycGetStaffSchedule.mockRejectedValue(new Error('502 upstream'));
    const out = await slots.run(1, ARGS, { nowMs: NOW });
    expect(out.slots).toEqual([]);
    expect(out.staff_not_working).toBeUndefined();
    expect(out.error).toBeUndefined();
  });

  test('пустая выдача графика (молчание API) отпуском не считается', async () => {
    ycGetStaffSchedule.mockResolvedValue([]);
    const out = await slots.run(1, ARGS, { nowMs: NOW });
    expect(out.staff_not_working).toBeUndefined();
  });

  // График спрашиваем ТОЛЬКО когда слотов нет: на счастливом пути это лишний
  // запрос в YClients на каждый ход каждого диалога.
  test('слоты есть → в график не ходим вовсе', async () => {
    ycGetBookTimes.mockResolvedValue([{ time: '11:00', datetime: `${DATE}T11:00:00+03:00`, seance_length: 3600 }]);
    const out = await slots.run(1, ARGS, { nowMs: NOW });
    expect(out.slots.length).toBe(1);
    expect(ycGetStaffSchedule).not.toHaveBeenCalled();
  });

  // Инцидентная комбинация: у Пери отпуск, а у Астемира окна есть. Оба факта
  // обязаны доехать до модели одновременно — иначе она снова склеит их в одно.
  test('отпуск запрошенного + окна у другого мастера → и alternative_staff, и staff_not_working', async () => {
    ycGetStaffSchedule.mockImplementation(async (_salon, staffId) => (
      staffId === 1910274 ? [off(DATE), on('2026-09-01')] : [on(DATE)]));
    ycGetBookTimes.mockImplementation(async (_salon, staffId) => (
      staffId === 5708379
        ? [{ time: '17:30', datetime: `${DATE}T17:30:00+03:00`, seance_length: 3600 }]
        : []));
    const out = await slots.run(1, ARGS, { nowMs: NOW });
    expect(out.staff_not_working).toBe(true);
    expect(out.alternative_staff.map(a => a.name)).toEqual(['Астемир Боташев']);
    expect(out.hint).toMatch(/не работает/i);
    expect(out.hint).toMatch(/alternative_staff/);
  });
});
