'use strict';

jest.mock('./db', () => {
  const client = { query: jest.fn(async () => ({ rows: [] })), release: jest.fn() };
  return {
    db: { query: jest.fn(async () => ({ rows: [] })), any: jest.fn() },
    pool: { connect: jest.fn(async () => client) },
    __client: client,
  };
});
jest.mock('./services/yclients-booking', () => ({ ycCreateRecord: jest.fn() }));
jest.mock('./services/yclients-records', () => ({ ycGetRecord: jest.fn() }));
// Схемы оставляем настоящие (реестр инструментов проверяется ниже по именам),
// подменяем только run: create_booking зовёт их на своём guard-пути.
jest.mock('./services/agent/tools/get-available-slots', () => ({
  ...jest.requireActual('./services/agent/tools/get-available-slots'), run: jest.fn(),
}));
jest.mock('./services/agent/tools/list-services', () => ({
  ...jest.requireActual('./services/agent/tools/list-services'), run: jest.fn(async () => ({ services: [] })),
}));
jest.mock('./services/agent-settings', () => ({
  loadServiceFilterSafe: jest.fn(async () => ({
    mode: 'all', denyServices: new Set(), allowServices: new Set(), denyPairs: new Set(),
  })),
}));

const dbMod = require('./db');
const { db } = dbMod;
const client = dbMod.__client;
const { ycCreateRecord } = require('./services/yclients-booking');
const { ycGetRecord } = require('./services/yclients-records');
const booking = require('./services/agent/booking');
const createBookingTool = require('./services/agent/tools/create-booking');
const escalate = require('./services/agent/tools/escalate-to-operator');
const registry = require('./services/agent/tools/index');

// Программируем client.query (транзакционный клиент) по SQL.
function programClient({ prior = null, salon = { id: 1, yclients_company_id: 100 } } = {}) {
  client.query.mockImplementation(async (sql) => {
    if (/FROM agent_events/i.test(sql)) return { rows: prior ? [prior] : [] };
    if (/FROM salons/i.test(sql)) return { rows: salon ? [salon] : [] };
    return { rows: [] };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  client.query.mockImplementation(async () => ({ rows: [] }));
  // По умолчанию помеченная ключом запись ЖИВА — идемпотентность работает как раньше.
  ycGetRecord.mockResolvedValue({ id: 999, attendance: 0 });
});

describe('booking.buildIdempotencyKey', () => {
  const base = {
    dialogKey: '79001112233', serviceYcId: 7, staffYcId: 55,
    datetime: '2026-07-20T10:00:00+03:00', clientPhone: '79001112233',
  };

  test('детерминирован по одному и тому же черновику', () => {
    expect(booking.buildIdempotencyKey(base)).toBe(booking.buildIdempotencyKey({ ...base }));
  });

  test('различает время и услугу', () => {
    expect(booking.buildIdempotencyKey(base))
      .not.toBe(booking.buildIdempotencyKey({ ...base, datetime: '2026-07-20T11:00:00+03:00' }));
    expect(booking.buildIdempotencyKey(base))
      .not.toBe(booking.buildIdempotencyKey({ ...base, serviceYcId: 8 }));
  });

  // Параллельная запись двух гостей идёт из ОДНОГО диалога. Если ключ не
  // различает гостей, вторая бронь схлопнется в «дубликат» и человек окажется
  // незаписанным, а агент отрапортует об успехе.
  test('различает гостей одного диалога: разные мастера при той же услуге и времени', () => {
    expect(booking.buildIdempotencyKey(base))
      .not.toBe(booking.buildIdempotencyKey({ ...base, staffYcId: 56 }));
  });

  test('различает гостей одного диалога: разные телефоны', () => {
    expect(booking.buildIdempotencyKey(base))
      .not.toBe(booking.buildIdempotencyKey({ ...base, clientPhone: '79005556677' }));
  });
});

describe('createBookingRecord', () => {
  const draft = {
    dialogKey: '79001112233', staffYcId: 55, serviceYcId: 7,
    datetime: '2026-07-20T10:00:00+03:00', seanceLength: 3600,
    clientPhone: '79001112233', clientName: 'Аня',
  };

  test('создаёт запись под транзакцией с advisory-lock и логирует идемпотентно', async () => {
    programClient({ prior: null });
    ycCreateRecord.mockResolvedValue({ id: 999 });
    const out = await booking.createBookingRecord(1, draft);
    expect(out.created).toBe(true);
    expect(out.record_id).toBe(999);
    const sqls = client.query.mock.calls.map(c => c[0]);
    expect(sqls.some(s => /BEGIN/i.test(s))).toBe(true);
    expect(sqls.some(s => /pg_advisory_xact_lock/i.test(s))).toBe(true);
    expect(sqls.some(s => /INSERT INTO agent_events/i.test(s))).toBe(true);
    expect(sqls.some(s => /COMMIT/i.test(s))).toBe(true);
    expect(ycCreateRecord).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalled();
  });

  test('дубль по idempotency_key → не создаёт вторую запись', async () => {
    programClient({ prior: { id: 5, payload: { record_id: 999 } } });
    const out = await booking.createBookingRecord(1, draft);
    expect(out.created).toBe(false);
    expect(out.duplicate).toBe(true);
    expect(out.record_id).toBe(999);
    expect(ycCreateRecord).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });

  // ── Протухший идемпотентный ключ ────────────────────────────────────────
  // Ключ (диалог+услуга+мастер+время+телефон) жил вечно и о судьбе брони не знал.
  // Инцидент 2026-08-04: тестовую запись удалили в YClients, и повтор записи на
  // тот же слот вернул бы duplicate:true с МЁРТВЫМ record_id — Мила отчиталась бы
  // «вы записаны», а записи бы не появилось. То же ломало штатное «запись
  // отменили, надо вернуть в работу»: cancel/reschedule ключ не гасят.
  describe('протухший ключ (запись удалили или отменили)', () => {
    const prior = { id: 5, payload: { record_id: 999 } };

    test('удалённая в YClients (deleted:true) → ключ гасится, запись создаётся заново', async () => {
      programClient({ prior });
      // YClients НЕ отдаёт 404 на удалённую запись — возвращает тело с deleted:true.
      ycGetRecord.mockResolvedValue({ id: 999, attendance: 0, deleted: true });
      ycCreateRecord.mockResolvedValue({ id: 1001 });

      const out = await booking.createBookingRecord(1, draft);
      expect(out).toEqual({ created: true, record_id: 1001 });
      expect(ycCreateRecord).toHaveBeenCalledTimes(1);
      // Строку журнала не удаляем (форензика) — гасим только ключ.
      const sqls = client.query.mock.calls.map(c => c[0]);
      expect(sqls.some(s => /UPDATE agent_events SET idempotency_key = NULL/i.test(s))).toBe(true);
      expect(sqls.some(s => /DELETE FROM agent_events/i.test(s))).toBe(false);
    });

    test('отменённая агентом (attendance=-1) → тоже перезаписываем', async () => {
      programClient({ prior });
      ycGetRecord.mockResolvedValue({ id: 999, attendance: -1 });
      ycCreateRecord.mockResolvedValue({ id: 1002 });
      expect(await booking.createBookingRecord(1, draft)).toEqual({ created: true, record_id: 1002 });
    });

    // Fail-safe в неизвестность: ошибиться в сторону «уже записан» дешевле, чем
    // создать пациенту вторую бронь на то же время.
    test('YClients недоступен → ключ считается действующим (дубликат, как раньше)', async () => {
      programClient({ prior });
      ycGetRecord.mockRejectedValue(new Error('ETIMEDOUT'));
      const out = await booking.createBookingRecord(1, draft);
      expect(out).toEqual({ created: false, duplicate: true, record_id: 999 });
      expect(ycCreateRecord).not.toHaveBeenCalled();
    });

    test('404 однозначен → перезаписываем', async () => {
      programClient({ prior });
      const e = new Error('Not found'); e.status = 404;
      ycGetRecord.mockRejectedValue(e);
      ycCreateRecord.mockResolvedValue({ id: 1003 });
      expect((await booking.createBookingRecord(1, draft)).created).toBe(true);
    });

    test('старая строка журнала без record_id → проверять нечего, остаёмся дубликатом', async () => {
      programClient({ prior: { id: 5, payload: {} } });
      const out = await booking.createBookingRecord(1, draft);
      expect(out.duplicate).toBe(true);
      expect(ycGetRecord).not.toHaveBeenCalled();
      expect(ycCreateRecord).not.toHaveBeenCalled();
    });
  });

  test('ошибка YClients → created:false, ROLLBACK, без idempotency-события', async () => {
    programClient({ prior: null });
    ycCreateRecord.mockRejectedValue(new Error('busy'));
    const out = await booking.createBookingRecord(1, draft);
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/busy/);
    const sqls = client.query.mock.calls.map(c => c[0]);
    expect(sqls.some(s => /ROLLBACK/i.test(s))).toBe(true);
    expect(sqls.some(s => /INSERT INTO agent_events/i.test(s) && /idempotency_key/i.test(s))).toBe(false);
    expect(client.release).toHaveBeenCalled();
  });

  test('соединение всегда освобождается', async () => {
    programClient({ prior: null });
    ycCreateRecord.mockResolvedValue({ id: 1 });
    await booking.createBookingRecord(1, draft);
    expect(dbMod.pool.connect).toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('create_booking tool', () => {
  // Провал записи ИМЕННО по времени → guard перезапрашивает свежие старты той же
  // услуги у того же мастера и кладёт их в available_slots.
  describe('перезапрос слотов при отказе по времени', () => {
    const getSlots = require('./services/agent/tools/get-available-slots');
    const CTX = { clientPhone: '79001112233', dialogKey: '79001112233',
      nowMs: Date.parse('2026-08-01T09:00:00+03:00') };
    const INPUT = { staff_yc_id: 55, service_yc_id: 7, datetime: '2026-08-05T12:00:00+03:00' };

    beforeEach(() => {
      programClient({ prior: null });
      ycCreateRecord.mockRejectedValue(new Error('Выбранное время недоступно'));
      getSlots.run.mockResolvedValue({ slots: [{ time: '15:00', datetime: '2026-08-05T15:00:00+03:00' }] });
    });

    test('мастер известен → слоты перезапрашиваются, ответ несёт available_slots', async () => {
      const out = await createBookingTool.run(1, INPUT, CTX);
      expect(getSlots.run).toHaveBeenCalledTimes(1);
      expect(getSlots.run.mock.calls[0][1]).toMatchObject({ staff_yc_id: 55, service_yc_id: 7, date: '2026-08-05' });
      expect(out.slot_unavailable).toBe(true);
      expect(out.available_slots).toHaveLength(1);
    });

    // Без staff_yc_id get_available_slots уходит в мультимастерный режим и отдаёт
    // staff_options БЕЗ slots — guard прочитал бы пустоту и сказал пациенту
    // «свободных стартов на эту дату больше нет». Детерминированная защита от
    // вранья соврала бы сама; перезапрашивать тут нечего.
    test('staff_yc_id отсутствует (модель нарушила схему) → слоты не перезапрашиваем', async () => {
      const out = await createBookingTool.run(1, { ...INPUT, staff_yc_id: undefined }, CTX);
      expect(getSlots.run).not.toHaveBeenCalled();
      expect(out.slot_unavailable).toBeUndefined();
      expect(out.available_slots).toBeUndefined();
      expect(out.error).toMatch(/недоступно/);   // исходная ошибка YClients как есть
    });

    // Плотная запись: повторное предложение после отказа YClients тоже обязано
    // идти по offer_slots, а не по самому раннему из полного списка.
    test('свежая выдача несёт offer_slots → ответ несёт offer_slots рядом с полным available_slots, текст ошибки называет offer_slots', async () => {
      getSlots.run.mockResolvedValue({
        slots: [
          { time: '15:00', datetime: '2026-08-05T15:00:00+03:00' },
          { time: '20:30', datetime: '2026-08-05T20:30:00+03:00' },
        ],
        offer_slots: [{ time: '20:30', datetime: '2026-08-05T20:30:00+03:00' }],
      });
      const out = await createBookingTool.run(1, INPUT, CTX);
      expect(out.slot_unavailable).toBe(true);
      expect(out.available_slots).toHaveLength(2);
      expect(out.offer_slots).toEqual([{ time: '20:30', datetime: '2026-08-05T20:30:00+03:00' }]);
      expect(out.error).toMatch(/offer_slots/);
    });

    // Без offer_slots в свежей выдаче (фолбэк/поле не пришло) текст ошибки и
    // форма ответа обязаны остаться РОВНО прежними — их и так один раз уже
    // выстрадали инцидентом 2026-07-31.
    test('свежая выдача без offer_slots → поля offer_slots в ответе нет, текст ошибки прежний', async () => {
      const out = await createBookingTool.run(1, INPUT, CTX);
      expect(out.slot_unavailable).toBe(true);
      expect(out.available_slots).toHaveLength(1);
      expect(out).not.toHaveProperty('offer_slots');
      expect(out.error).not.toMatch(/offer_slots/);
      expect(out.error).toBe(
        'Записать на это время не удалось. Причина неизвестна — НЕ выдумывай её и не утверждай ' +
        'пациенту, что слот «только что заняли». Извинись нейтрально («к сожалению, это время уже ' +
        'недоступно») и предложи время ТОЛЬКО из available_slots — это свежие реально свободные ' +
        'старты для этой услуги и этого мастера на ту же дату.'
      );
    });
  });

  test('schema требует поля брони', () => {
    const p = createBookingTool.schema.input_schema.properties;
    expect(p.staff_yc_id).toBeDefined();
    expect(p.service_yc_id).toBeDefined();
    expect(p.datetime).toBeDefined();
    expect(createBookingTool.schema.input_schema.required).toEqual(
      expect.arrayContaining(['staff_yc_id', 'service_yc_id', 'datetime']));
  });
});

describe('escalate_to_operator tool', () => {
  test('флипает статус диалога в escalated', async () => {
    const out = await escalate.run(1, { reason: 'жалоба' }, { dialogKey: '79001112233' });
    expect(out.escalated).toBe(true);
    const upd = db.query.mock.calls.find(c => /UPDATE agent_dialogs/i.test(c[0]) && /escalated/i.test(c[0]));
    expect(upd).toBeTruthy();
  });
});

describe('tools registry', () => {
  test('экспортирует schemas и handlers по всем инструментам', () => {
    const names = registry.schemas.map(s => s.name).sort();
    expect(names).toEqual([
      'cancel_booking', 'create_booking', 'book_chain', 'escalate_to_operator', 'get_available_dates',
      'get_available_slots', 'get_client', 'get_client_visit_history', 'get_parallel_slots',
      'get_sequential_slots', 'list_client_bookings', 'list_services', 'list_staff', 'modify_booking_services',
      'reschedule_booking', 'search_knowledge_base', 'get_bonus_balance', 'get_client_abonements',
      'send_price_list',
    ].sort());
    for (const n of names) expect(typeof registry.handlers[n]).toBe('function');
  });
});
