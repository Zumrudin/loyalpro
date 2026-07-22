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

const dbMod = require('./db');
const { db } = dbMod;
const client = dbMod.__client;
const { ycCreateRecord } = require('./services/yclients-booking');
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
      'create_booking', 'escalate_to_operator', 'get_available_dates', 'get_available_slots',
      'get_client', 'get_parallel_slots', 'list_services', 'list_staff', 'search_knowledge_base',
    ].sort());
    for (const n of names) expect(typeof registry.handlers[n]).toBe('function');
  });
});
