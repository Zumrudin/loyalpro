'use strict';

jest.mock('./db', () => {
  const q = jest.fn(async () => ({ rows: [] }));
  return { db: { one: jest.fn(), oneOrNone: jest.fn(), query: q, any: jest.fn() }, pool: {} };
});
jest.mock('./services/yclients-booking', () => ({ ycCreateRecord: jest.fn() }));

const { db } = require('./db');
const { ycCreateRecord } = require('./services/yclients-booking');
const booking = require('./services/agent/booking');
const createBookingTool = require('./services/agent/tools/create-booking');
const escalate = require('./services/agent/tools/escalate-to-operator');
const registry = require('./services/agent/tools/index');

beforeEach(() => jest.clearAllMocks());

describe('booking.buildIdempotencyKey', () => {
  test('детерминирован по dialog+service+datetime', () => {
    const a = booking.buildIdempotencyKey('79001112233', 7, '2026-07-20T10:00:00+03:00');
    const b = booking.buildIdempotencyKey('79001112233', 7, '2026-07-20T10:00:00+03:00');
    const c = booking.buildIdempotencyKey('79001112233', 7, '2026-07-20T11:00:00+03:00');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('createBookingRecord', () => {
  const draft = {
    dialogKey: '79001112233', staffYcId: 55, serviceYcId: 7,
    datetime: '2026-07-20T10:00:00+03:00', seanceLength: 3600,
    clientPhone: '79001112233', clientName: 'Аня',
  };

  test('создаёт запись и логирует идемпотентно', async () => {
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100, yclients_partner_token: 'p', yclients_user_token: 'u' });
    db.oneOrNone.mockResolvedValue(null); // нет прежней записи с этим ключом
    ycCreateRecord.mockResolvedValue({ id: 999 });
    const out = await booking.createBookingRecord(1, draft);
    expect(out.created).toBe(true);
    expect(out.record_id).toBe(999);
    // advisory-lock взят
    const lockCall = db.query.mock.calls.find(c => /pg_advisory_xact_lock/i.test(c[0]));
    expect(lockCall).toBeTruthy();
    // событие с idempotency_key записано
    const evCall = db.query.mock.calls.find(c => /INSERT INTO agent_events/i.test(c[0]));
    expect(evCall).toBeTruthy();
    expect(ycCreateRecord).toHaveBeenCalledTimes(1);
  });

  test('дубль по idempotency_key → не создаёт вторую запись', async () => {
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    db.oneOrNone.mockResolvedValue({ id: 5, payload: { record_id: 999 } }); // уже есть
    const out = await booking.createBookingRecord(1, draft);
    expect(out.created).toBe(false);
    expect(out.duplicate).toBe(true);
    expect(out.record_id).toBe(999);
    expect(ycCreateRecord).not.toHaveBeenCalled();
  });

  test('ошибка YClients → created:false с сообщением, запись не помечена созданной', async () => {
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    db.oneOrNone.mockResolvedValue(null);
    ycCreateRecord.mockRejectedValue(new Error('busy'));
    const out = await booking.createBookingRecord(1, draft);
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/busy/);
    // не логируем успешный idempotency-ключ на провале
    const evCall = db.query.mock.calls.find(c => /INSERT INTO agent_events/i.test(c[0]) && /idempotency_key/i.test(c[0]));
    expect(evCall).toBeFalsy();
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
    db.query.mockResolvedValue({ rows: [] });
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
      'create_booking', 'escalate_to_operator', 'get_available_slots',
      'get_client', 'list_services', 'list_staff', 'search_knowledge_base',
    ].sort());
    for (const n of names) expect(typeof registry.handlers[n]).toBe('function');
  });
});
