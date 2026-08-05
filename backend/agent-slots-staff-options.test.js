'use strict';

// Пациент не назвал врача → выбор мастера делает ОН, а не модель: без staff_yc_id
// инструмент считает окна у всех исполнителей услуги и отдаёт их списком.
// Раньше модель брала мастера сама и молча предлагала его (у главврача цена выше).

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
jest.mock('./services/agent/equipment-context', () => ({
  loadEquipmentContext: jest.fn(async () => ({ busy: [], resources: [] })),
  durationMin: jest.fn(() => 60),
  instancesFor: jest.fn(() => []),
  busyForService: jest.fn(() => []),
}));
jest.mock('./services/agent/tools/list-services', () => ({ run: jest.fn() }));

const { db } = require('./db');
const { ycGetBookTimes } = require('./services/yclients-booking');
const svcFilter = require('./services/agent/service-filter');
const listServices = require('./services/agent/tools/list-services');
const slots = require('./services/agent/tools/get-available-slots');

// Услуга 900: Юлия (11), Пери Исамудиновна (12), Мария (13).
const CATALOG = {
  services: [
    { yc_id: 900, title: 'Биоревитализация', staff: [
      { yc_id: 11, name: 'Юлия' }, { yc_id: 12, name: 'Пери Исамудиновна' }, { yc_id: 13, name: 'Мария' },
    ] },
  ],
};
const NOON = Date.parse('2026-08-01T09:00:00+03:00');
const DATE = '2026-08-02';
const ARGS = { service_yc_id: 900, date: DATE };   // БЕЗ staff_yc_id

const bookSlot = (time) => [{ time, datetime: `${DATE}T${time}:00+03:00`, seance_length: 3600 }];

beforeEach(() => {
  jest.clearAllMocks();
  listServices.run.mockResolvedValue(CATALOG);
  ycGetBookTimes.mockResolvedValue([]);
  svcFilter.isBookable.mockReturnValue(true);
  svcFilter.decideServiceVisible.mockReturnValue(true);
  db.any.mockResolvedValue([]);
});

describe('get_available_slots без staff_yc_id — выбор специалиста пациентом', () => {
  test('окна есть у двоих → staff_options с обоими, слоты дословно', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) => {
      if (staffId === 11) return bookSlot('12:00');
      if (staffId === 12) return bookSlot('15:00');
      return [];
    });
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options).toEqual([
      { staff_yc_id: 11, name: 'Юлия', position: null, slots: bookSlot('12:00') },
      { staff_yc_id: 12, name: 'Пери Исамудиновна', position: null, slots: bookSlot('15:00') },
    ]);
    expect(out.slots).toBeUndefined();
  });

  test('мастер без окон в список не попадает', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) =>
      staffId === 12 ? bookSlot('15:00') : []);
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options.map(o => o.staff_yc_id)).toEqual([12]);
  });

  test('порядок — по времени первого свободного окна', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) => {
      if (staffId === 11) return bookSlot('16:00');
      if (staffId === 12) return bookSlot('11:00');
      return [];
    });
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options.map(o => o.staff_yc_id)).toEqual([12, 11]);
  });

  test('hint требует перечислить всех и запрещает выбирать за пациента и называть цену', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) =>
      staffId === 13 ? [] : bookSlot('12:00'));
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.hint).toMatch(/staff_options/);
    expect(out.hint).toMatch(/НЕ выбирай|не выбирай сама/);
    expect(out.hint).toMatch(/[Цц]ену не называй/);
  });

  test('передан staff_yc_id → поведение прежнее (slots одного мастера, без staff_options)', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) =>
      staffId === 11 ? bookSlot('12:00') : []);
    const out = await slots.run(1, { ...ARGS, staff_yc_id: 11 }, { nowMs: NOON });
    expect(out.slots).toEqual(bookSlot('12:00'));
    expect(out.staff_options).toBeUndefined();
  });

  // Услуга, скрытая админкой целиком, отфильтровала бы ВСЕХ кандидатов, и пустой
  // выбор прочитался бы как «на этот день никого нет» → бесконечные «а другой день?»
  // вместо мягкого отказа. Ответ обязан быть тем же, что у одномастерной ветки.
  test('скрытая целиком услуга → filtered:true, а не пустой выбор', async () => {
    svcFilter.decideServiceVisible.mockReturnValue(false);
    ycGetBookTimes.mockImplementation(async () => bookSlot('12:00'));
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out).toEqual({ slots: [], filtered: true });
    expect(out.staff_options).toBeUndefined();
    expect(listServices.run).not.toHaveBeenCalled();   // до каталога и БД не идём
    expect(ycGetBookTimes).not.toHaveBeenCalled();
  });

  // Порядок staffList приходит из SELECT без ORDER BY — без сортировки кап срезал бы
  // случайных мастеров, и выдача была бы невоспроизводимой.
  test('исполнителей больше капа → берём первых по yc_id, детерминированно', async () => {
    listServices.run.mockResolvedValue({
      services: [{ yc_id: 900, title: 'Биоревитализация', staff: [
        { yc_id: 14, name: 'Пери Исамудиновна' }, { yc_id: 11, name: 'Юлия' },
        { yc_id: 13, name: 'Мария' }, { yc_id: 12, name: 'Татьяна' },
      ] }],
    });
    const times = { 11: '16:00', 12: '11:00', 13: '13:00', 14: '09:00' };
    ycGetBookTimes.mockImplementation(async (_salon, staffId) => bookSlot(times[staffId]));
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    // проверены ровно трое с наименьшими yc_id — 14 в перебор не попал…
    expect(ycGetBookTimes.mock.calls.map(c => c[1]).sort()).toEqual([11, 12, 13]);
    // …а сама выдача упорядочена по времени первого окна, как и раньше
    expect(out.staff_options.map(o => o.staff_yc_id)).toEqual([12, 13, 11]);
  });

  test('одинаковое время первого окна → тай-брейк по yc_id', async () => {
    listServices.run.mockResolvedValue({
      services: [{ yc_id: 900, title: 'Биоревитализация', staff: [
        { yc_id: 12, name: 'Пери Исамудиновна' }, { yc_id: 11, name: 'Юлия' },
      ] }],
    });
    ycGetBookTimes.mockImplementation(async () => bookSlot('12:00'));
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options.map(o => o.staff_yc_id)).toEqual([11, 12]);
  });

  test('без date — прежняя ошибка', async () => {
    const out = await slots.run(1, { service_yc_id: 900 }, { nowMs: NOON });
    expect(out.error).toMatch(/date/);
  });

  test('без service_yc_id — прежняя ошибка про услугу', async () => {
    const out = await slots.run(1, { date: DATE }, { nowMs: NOON });
    expect(out.error).toMatch(/service_yc_id/);
  });
});

describe('get_available_slots без staff_yc_id — граничные случаи', () => {
  // Пустой staff_options с общим хинтом «перечисли ВСЕХ» — это указание перечислить
  // пустоту: модель либо молчит, либо выдумывает мастера. Пустой день должен звучать
  // как пустой день и вести к предложению другой даты.
  test('окон нет ни у кого → no_staff_available:true и подсказка про другой день', async () => {
    ycGetBookTimes.mockResolvedValue([]);
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.no_staff_available).toBe(true);
    expect(out.staff_options).toEqual([]);
    expect(out.hint).toMatch(/другой день/);
  });

  // «Выбор за пациентом» из одного варианта — это не выбор, а лишний вопрос в переписке.
  test('услугу ведёт один специалист → выбора не устраиваем (hint об этом говорит)', async () => {
    listServices.run.mockResolvedValue({
      services: [{ yc_id: 900, title: 'Биоревитализация', staff: [{ yc_id: 11, name: 'Юлия' }] }],
    });
    ycGetBookTimes.mockImplementation(async (_salon, staffId) =>
      staffId === 11 ? bookSlot('12:00') : []);
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options.map(o => o.staff_yc_id)).toEqual([11]);
    expect(out.hint).toMatch(/один специалист/);
  });

  // Предпроверка исполнителей fail-open: при сбое каталога staffList пуст, и перебирать
  // некого. Молчаливый пустой выбор здесь неотличим от «на этот день никого нет».
  test('каталог недоступен → просим повторить с конкретным staff_yc_id, а не молчим', async () => {
    listServices.run.mockResolvedValue({ services: [] });
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.error).toMatch(/staff_yc_id/);
    expect(out.staff_options).toBeUndefined();
  });

  // Пустая выдача мастера и недостижимый мастер снаружи выглядят одинаково, а значат
  // разное: «занят» против «не знаем». Сказать пациенту «свободного времени нет ни у
  // кого» в момент, когда до YClients просто не достучались, — выдумка о клинике.
  test('до всех исполнителей не достучались → ошибка, а не no_staff_available', async () => {
    ycGetBookTimes.mockRejectedValue(new Error('502 YClients'));
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.error).toMatch(/Не удалось получить слоты/);
    expect(out.no_staff_available).toBeUndefined();
    expect(out.staff_options).toBeUndefined();
  });

  test('часть мастеров недостижима, у достижимых пусто → no_staff_available НЕ выставляем', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) => {
      if (staffId === 11) throw new Error('502 YClients');
      return [];   // 12 и 13 ответили и просто заняты
    });
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options).toEqual([]);
    expect(out.no_staff_available).toBeUndefined();
    expect(out.hint).toMatch(/проверить не удалось/);
  });

  // Регресс-страховки: код Task 1 их уже покрывает, тесты фиксируют поведение.
  test('скрытая пара услуга+мастер в выбор не попадает', async () => {
    svcFilter.isBookable.mockImplementation((_f, _svc, staffId) => staffId !== 11);
    ycGetBookTimes.mockResolvedValue(bookSlot('12:00'));
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options.map(o => o.staff_yc_id)).not.toContain(11);
  });

  // Скрыты пары по КАЖДОМУ мастеру (услуга целиком не скрыта) — перебирать некого,
  // но это решение админки, а не сбой: ответ обязан быть тем же мягким filtered.
  test('скрыты пары со всеми мастерами → filtered:true, а не «сбой»', async () => {
    svcFilter.isBookable.mockReturnValue(false);
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out).toEqual({ slots: [], filtered: true });
    expect(ycGetBookTimes).not.toHaveBeenCalled();
  });

  test('сбой YClients по одному мастеру не валит ответ', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) => {
      if (staffId === 11) throw new Error('502 YClients');
      if (staffId === 12) return bookSlot('15:00');
      return [];
    });
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options.map(o => o.staff_yc_id)).toEqual([12]);
  });
});

// Хинт требует назвать должность каждого специалиста, а в каталоге промпта должностей
// нет: без подстановки модель либо промолчит о ней, либо выдумает.
describe('get_available_slots без staff_yc_id — должность специалиста', () => {
  test('position подставляется из staff_members', async () => {
    db.any.mockResolvedValue([
      { yclients_staff_id: 11, specialization: 'косметолог-эстетист' },
      { yclients_staff_id: 12, specialization: 'главный врач' },
    ]);
    ycGetBookTimes.mockImplementation(async (_salon, staffId) => (staffId === 13 ? [] : bookSlot('12:00')));
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options.map(o => o.position)).toEqual(['косметолог-эстетист', 'главный врач']);
  });

  // Читаем ТОЛЬКО карточки своего салона: staff_members общая на все салоны,
  // и yclients_staff_id у разных салонов совпадают.
  test('запрос за должностями ограничен салоном и нужными мастерами', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) => (staffId === 11 ? bookSlot('12:00') : []));
    await slots.run(1, ARGS, { nowMs: NOON });
    const [sql, params] = db.any.mock.calls[0];
    expect(sql).toMatch(/salon_id\s*=\s*\$1/);
    expect(params).toEqual([1, [11]]);
  });

  test('должности в базе нет → position остаётся null, ответ не ломается', async () => {
    db.any.mockResolvedValue([{ yclients_staff_id: 11, specialization: null }]);
    ycGetBookTimes.mockImplementation(async (_salon, staffId) => (staffId === 11 ? bookSlot('12:00') : []));
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options[0].position).toBeNull();
  });

  test('сбой БД при чтении должностей не валит выдачу слотов', async () => {
    db.any.mockRejectedValue(new Error('db down'));
    ycGetBookTimes.mockImplementation(async (_salon, staffId) => (staffId === 11 ? bookSlot('12:00') : []));
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options.map(o => o.staff_yc_id)).toEqual([11]);
    expect(out.staff_options[0].position).toBeNull();
  });
});
