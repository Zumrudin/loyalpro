'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret', JOURNAL_ACCOUNT_PAYMENTS_ENABLED: true }));
jest.mock('./db', () => ({ db: { oneOrNone: jest.fn(), any: jest.fn(), query: jest.fn() }, pool: { connect: jest.fn(() => { throw new Error('no pool in sessions'); }) } }));
// Any YClients traffic from the sessions path is a defect.
jest.mock('./services/journal/yclients', () => {
  const calls = [];
  return new Proxy({}, { get: (_, key) => key === '__calls' ? calls : key === '__esModule' ? false
    : (...args) => { calls.push(String(key)); throw new Error('YClients called: ' + String(key)); } });
});
jest.mock('./services/journal/index', () => ({ availability: jest.fn() }));
jest.mock('./services/journal/sources', () => ({ local: jest.fn(() => ({ kind: 'local', services: jest.fn(async () => []) })), forSalon: jest.fn(async () => ({ kind: 'local', services: jest.fn(async () => []) })), live: jest.fn(() => { throw new Error('live source'); }) }));
jest.mock('./services/service-catalog', () => ({ resolve: jest.fn() }));
jest.mock('./services/journal/reference-cache', () => ({ getReference: jest.fn(), getBonusPercent: jest.fn() }));
const { db, pool } = require('./db');
const yc = require('./services/journal/yclients');
const index = require('./services/journal/index');
const catalog = require('./services/service-catalog');
const reference = require('./services/journal/reference-cache');
const config = require('./config');
const sources = require('./services/journal/sources');
const s = require('./services/journal/sessions');

const SID = '11111111-2222-4333-8444-555555555555';
const ACCOUNTS = [{ id: 10, title: 'Основная', type_slug: 'cash', is_acquiring: false }];
const CREATE = { date: '2030-04-01', time: '10:00', staffId: 5, serviceSource: 'internal', serviceIds: [1],
  lines: [{ serviceId: 1, quantity: 2, unitPrice: 1500, discount: 0 }], clientName: 'Анна', clientPhone: '+7 (920) 000-11-22', comment: '' };
const RECORD = { id: 42, datetime: '2030-04-01T10:00:00+03:00', staff_id: 5, seance_length: 3600, attendance: 0,
  services: [{ id: 900, title: 'Чистка', amount: 1, cost: 3000 }], client: { id: 55, name: 'Анна' } };

let state;
function setup(over = {}) {
  state = { salon: { id: 3, yclients_company_id: 77 }, record: RECORD, ledger: [], open: [], card: { yclients_card_id: 88, yclients_card_balance: 5000 }, outbox: null, inserted: [], ...over };
  db.oneOrNone.mockImplementation(async (sql, args) => {
    if (/WITH parent AS \(UPDATE journal_outbox/.test(sql)) { state.localCalls = [...(state.localCalls || []), { sql, args }]; return state.localCancel ?? null; }
    if (/FROM salons/.test(sql)) return state.salon;
    if (/FROM records/.test(sql)) return state.record ? { raw_payload: state.record } : null;
    if (/FROM clients/.test(sql)) return state.card;
    if (/INSERT INTO journal_outbox/.test(sql)) {
      if (state.outbox) return null;
      state.outbox = { id: 7, request_hash: args[3], status: 'queued' };
      state.inserted.push(args);
      return { id: 7, status: 'queued' };
    }
    if (/FROM journal_outbox WHERE salon_id=\$1 AND session_id/.test(sql)) return state.outbox;
    if (/FROM journal_outbox WHERE salon_id=\$1 AND id/.test(sql)) return state.row || null;
    if (/UPDATE journal_outbox/.test(sql)) return state.updated === undefined ? { id: args[1], status: /cancelled/.test(sql) ? 'cancelled' : 'queued' } : state.updated;
    return null;
  });
  db.any.mockImplementation(async sql => {
    if (/journal_financial_transactions/.test(sql)) return state.ledger;
    if (/journal_outbox/.test(sql)) return state.open;
    return [];
  });
  reference.getReference.mockResolvedValue(ACCOUNTS);
  reference.getBonusPercent.mockResolvedValue(null);
  index.availability.mockResolvedValue({ duration: 60, slots: ['10:00', '11:00'], servicePayload: [{ id: 900, cost: 3000 }] });
  catalog.resolve.mockResolvedValue([{ id: 1, title: 'Чистка', yclients_id: 900 }]);
}
beforeEach(() => { jest.clearAllMocks(); config.JOURNAL_ACCOUNT_PAYMENTS_ENABLED = true; setup(); });
afterEach(() => {
  expect(yc.__calls).toEqual([]);
  expect(pool.connect).not.toHaveBeenCalled();
});
const parse = body => s.parseSession({ sessionId: SID, ...body });
const pay = (method, methodId, amount, extra = {}) => ({ method, methodId, amount, ...extra });

describe('parseSession', () => {
  test('requires uuid v4', () => {
    expect(() => s.parseSession({ sessionId: 'x', recordId: 1, status: 'confirm' })).toThrow('ключ формы');
  });
  test('exactly one of recordId and create', () => {
    expect(() => parse({ status: 'confirm' })).toThrow('либо запись');
    expect(() => parse({ recordId: 1, create: CREATE })).toThrow('либо запись');
  });
  test('negative recordId = unsent new record (manual dispatch, 10.11.2026)', () => {
    expect(parse({ recordId: -7, status: 'confirm' })).toMatchObject({ recordId: -7, status: 'confirm' });
    expect(() => parse({ recordId: 0, status: 'confirm' })).toThrow(expect.objectContaining({ status: 400 }));
  });
  test('move/status only with recordId; not move+cancel', () => {
    expect(() => parse({ create: CREATE, status: 'confirm' })).toThrow('сохранённой');
    expect(() => parse({ create: CREATE, move: { date: '2030-04-01', time: '11:00', staffId: 5 } })).toThrow('сохранённой');
    expect(() => parse({ recordId: 1, move: { date: '2030-04-01', time: '11:00', staffId: 5 }, status: 'cancel' })).toThrow('одновременно');
    expect(() => parse({ recordId: 1, status: 'arrive' })).toThrow('статус');
    const ok = parse({ recordId: 1, move: { date: '2030-04-01', time: '11:00', staffId: 5, version: 'x' }, status: 'confirm' });
    expect(ok.move).toEqual({ date: '2030-04-01', time: '11:00', staffId: 5 });
  });
  test('create validated by parseDraft without operationId', () => {
    const r = parse({ create: CREATE });
    expect(r.create.operationId).toBeUndefined();
    expect(r.create).toMatchObject({ date: '2030-04-01', clientPhone: '79200001122', serviceIds: [1] });
    expect(r.create.lines[0]).toMatchObject({ serviceId: 1, quantity: 2, total: 3000 });
    expect(() => parse({ create: { ...CREATE, time: '25:00' } })).toThrow('время');
  });
  test('payment rules', () => {
    expect(() => parse({ recordId: 1, payments: [pay('cash', 1, 1)] })).toThrow('не поддерживается');
    expect(() => parse({ recordId: 1, payments: [pay('account', 0, 1)] })).toThrow('идентификатор');
    expect(() => parse({ recordId: 1, payments: [pay('account', 1, 0)] })).toThrow('больше нуля');
    expect(() => parse({ recordId: 1, payments: [pay('account', 1, '1.005')] })).toThrow('копейки');
    expect(() => parse({ recordId: 1, payments: [pay('loyalty_card', 1, 1, { confirmArrival: true })] })).toThrow('только при оплате в кассу');
    expect(() => parse({ recordId: 1, payments: [pay('account', 1, 1, { confirmArrival: false })] })).toThrow('подтверждение');
    expect(() => parse({ recordId: 1, payments: Array.from({ length: 11 }, () => pay('account', 1, 1)) })).toThrow('не больше 10');
    expect(() => parse({ recordId: 1, status: 'cancel', payments: [pay('account', 1, 1)] })).toThrow('Отменённый');
    expect(parse({ recordId: 1, payments: [pay('account', 1, '1.5', { confirmArrival: true })] }).payments).toEqual([{ method: 'account', methodId: 1, amount: 1.5, confirmArrival: true }]);
  });
  test('remove rules', () => {
    const rm = { transactionId: 5, method: 'account', methodId: 1, amount: 1 };
    expect(() => parse({ recordId: 1, removePayments: [{ ...rm, transactionId: 0 }] })).toThrow('идентификатор');
    expect(() => parse({ recordId: 1, removePayments: Array.from({ length: 11 }, (_, i) => ({ ...rm, transactionId: i + 1 })) })).toThrow('не больше 10');
    expect(() => parse({ recordId: 1, removePayments: [rm, rm] })).toThrow('дважды');
  });
  test('empty session', () => {
    expect(() => parse({ recordId: 1 })).toThrow('Нет изменений для сохранения.');
    expect(() => parse({ recordId: 1, payments: [], removePayments: [] })).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('buildSteps', () => {
  test('order: record → status → bonuses → cash → removes; unique opIds', () => {
    const session = parse({ recordId: 1, move: { date: '2030-04-01', time: '11:00', staffId: 5 }, status: 'confirm',
      payments: [pay('account', 10, 100, { confirmArrival: true }), pay('loyalty_card', 88, 50), pay('account', 11, 1)],
      removePayments: [{ transactionId: 9, method: 'account', methodId: 10, amount: 5 }] });
    const steps = s.buildSteps(session);
    expect(steps.map(x => [x.kind, x.params.method || null])).toEqual([['move', null], ['confirm', null], ['pay', 'loyalty_card'], ['pay', 'account'], ['pay', 'account'], ['remove_payment', 'account']]);
    expect(steps[3].params).toEqual({ method: 'account', methodId: 10, amount: 100, confirmArrival: true });
    expect(steps[5].params).toEqual({ transactionId: 9, method: 'account', methodId: 10, amount: 5 });
    expect(steps.every(x => x.state === 'pending')).toBe(true);
    expect(new Set(steps.map(x => x.opId)).size).toBe(steps.length);
  });
  test('create step carries the draft without operationId', () => {
    const [st] = s.buildSteps(parse({ create: CREATE }));
    expect(st.kind).toBe('create');
    expect(st.params.operationId).toBeUndefined();
    expect(st.params.serviceIds).toEqual([1]);
  });
});

describe('validate', () => {
  test('create: local slot taken → 409 busy, no insert', async () => {
    index.availability.mockResolvedValue({ duration: 60, slots: ['11:00'] });
    await expect(s.enqueue(3, 4, parse({ create: CREATE }))).rejects.toMatchObject({ status: 409, code: 'slot_taken' });
    expect(state.inserted).toHaveLength(0);
    expect(index.availability.mock.calls[0][3]).toMatchObject({ kind: 'local' });
  });
  test('create overlay: lines, services from the internal catalog', async () => {
    const r = await s.validate(3, parse({ create: CREATE }));
    expect(r.overlay).toEqual({ kind: 'create', date: '2030-04-01', time: '10:00', staffId: 5, duration: 60,
      services: [{ id: 900, title: 'Чистка', amount: 2, cost: 3000 }], lines: [{ serviceId: 1, quantity: 2, total: 3000 }],
      client: { name: 'Анна', phone: '79200001122' }, comment: '', attendance: 0 });
    expect(r.options.due).toBe(3000);
    expect(r.options.items).toEqual([expect.objectContaining({ title: 'Чистка', quantity: 2, total: 3000 })]);
  });
  test('create with bonuses then cash and arrival', async () => {
    const r = await s.validate(3, parse({ create: CREATE, payments: [pay('account', 10, 2000, { confirmArrival: true }), pay('loyalty_card', 88, 1000)] }));
    expect(r.overlay.attendance).toBe(1);
    expect(r.options.due).toBe(0);
    expect(r.steps.map(x => x.params.method || x.kind)).toEqual(['create', 'loyalty_card', 'account']);
  });
  test('amount above due → 409', async () => {
    await expect(s.validate(3, parse({ recordId: 42, payments: [pay('account', 10, 3000.01, { confirmArrival: true })] })))
      .rejects.toMatchObject({ status: 409, message: 'Сумма больше доступной: Основная' });
    await expect(s.validate(3, parse({ recordId: 42, payments: [pay('loyalty_card', 88, 2000), pay('account', 10, 1500, { confirmArrival: true })] })))
      .rejects.toMatchObject({ status: 409, message: 'Сумма больше доступной: Основная' });
  });
  test('account at attendance 0 without confirmArrival → arrival_confirmation_required', async () => {
    await expect(s.validate(3, parse({ recordId: 42, payments: [pay('account', 10, 100)] })))
      .rejects.toMatchObject({ status: 409, code: 'arrival_confirmation_required' });
  });
  test('confirmArrival OK → patch attendance 1', async () => {
    const r = await s.validate(3, parse({ recordId: 42, payments: [pay('account', 10, 100, { confirmArrival: true })] }));
    expect(r.overlay).toEqual({ kind: 'patch', patch: { attendance: 1 } });
    expect(r.options.due).toBe(2900);
  });
  test('confirm status removes the arrival requirement', async () => {
    const r = await s.validate(3, parse({ recordId: 42, status: 'confirm', payments: [pay('account', 10, 100)] }));
    expect(r.overlay.patch).toEqual({ attendance: 2 });
  });
  test('method not offered → 409', async () => {
    await expect(s.validate(3, parse({ recordId: 42, payments: [pay('account', 999, 1, { confirmArrival: true })] }))).rejects.toMatchObject({ status: 409 });
    state.card = null;
    await expect(s.validate(3, parse({ recordId: 42, payments: [pay('loyalty_card', 88, 1)] }))).rejects.toMatchObject({ status: 409 });
  });
  test('account payments disabled → 409', async () => {
    config.JOURNAL_ACCOUNT_PAYMENTS_ENABLED = false;
    await expect(s.validate(3, parse({ recordId: 42, payments: [pay('account', 10, 1, { confirmArrival: true })] }))).rejects.toMatchObject({ code: 'payment_disabled' });
  });
  test('remove of a transaction not in the local ledger (made in YClients) is allowed; the worker re-checks live', async () => {
    const rm = { transactionId: 501, method: 'account', methodId: 10, amount: 1000 };
    const r = await s.validate(3, parse({ recordId: 42, removePayments: [rm] }));
    expect(r.steps.map(x => x.kind)).toEqual(['remove_payment']);
    expect(r.steps[0].params).toMatchObject(rm);
    // Already queued for removal → refused.
    state.open = [{ steps: [{ kind: 'remove_payment', state: 'pending', params: rm }] }];
    await expect(s.validate(3, parse({ recordId: 42, removePayments: [rm] }))).rejects.toMatchObject({ status: 409, message: 'Транзакция уже изменена.' });
    // In local paid with a different method id → refused.
    state.open = [];
    state.ledger = [{ state: 'confirmed', action: 'payment', method: 'account', method_id: 11, amount: '1000', external_ids: [501] }];
    await expect(s.validate(3, parse({ recordId: 42, removePayments: [rm] }))).rejects.toMatchObject({ status: 409 });
  });
  test('remove of unknown transaction → allowed; known with other amount → 409', async () => {
    const rm = { transactionId: 501, method: 'account', methodId: 10, amount: 1000 };
    state.record = { ...RECORD, attendance: 1 };
    state.ledger = [{ state: 'confirmed', action: 'payment', method: 'account', method_id: 10, amount: '1000', external_ids: [501] }];
    await expect(s.validate(3, parse({ recordId: 42, removePayments: [{ ...rm, amount: 999 }] }))).rejects.toMatchObject({ status: 409 });
    const r = await s.validate(3, parse({ recordId: 42, removePayments: [rm] }));
    expect(r.options.due).toBe(3000);
    state.open = [{ steps: [{ kind: 'remove_payment', state: 'pending', params: rm }] }];
    await expect(s.validate(3, parse({ recordId: 42, removePayments: [rm] }))).rejects.toMatchObject({ status: 409 });
  });
  test('queued confirm: cash payment needs no confirmArrival', async () => {
    state.open = [{ id: 6, status: 'queued', yclients_record_id: 42, overlay: { kind: 'patch', patch: { attendance: 2 } }, steps: [{ kind: 'confirm', state: 'pending', params: {} }] }];
    const r = await s.validate(3, parse({ recordId: 42, payments: [pay('account', 10, 100)] }));
    expect(r.overlay).toEqual({ kind: 'patch', patch: {} });
    expect(r.options.due).toBe(2900);
  });
  test('queued arrival with cash payment: next cash payment needs no confirmArrival, due reduced', async () => {
    state.open = [{ id: 6, status: 'running', yclients_record_id: 42, overlay: { kind: 'patch', patch: { attendance: 1 } }, steps: [{ kind: 'pay', state: 'pending', params: { method: 'account', methodId: 10, amount: 1000, confirmArrival: true } }] }];
    const r = await s.validate(3, parse({ recordId: 42, payments: [pay('account', 10, 2000)] }));
    expect(r.options.due).toBe(0);
    await expect(s.validate(3, parse({ recordId: 42, status: 'confirm' }))).rejects.toMatchObject({ status: 409 });
  });
  test('queued cancel: payment and edit sessions → 409', async () => {
    state.open = [{ id: 6, status: 'queued', yclients_record_id: 42, overlay: { kind: 'patch', patch: { cancel: true } }, steps: [{ kind: 'cancel', state: 'pending', params: {} }] }];
    await expect(s.validate(3, parse({ recordId: 42, payments: [pay('account', 10, 100, { confirmArrival: true })] }))).rejects.toMatchObject({ status: 409 });
    await expect(s.validate(3, parse({ recordId: 42, status: 'confirm' }))).rejects.toMatchObject({ status: 409 });
  });
  test('queued move shifts the record passed to availability', async () => {
    state.open = [{ id: 6, status: 'failed', yclients_record_id: 42, overlay: { kind: 'patch', patch: { datetime: '2030-04-01T11:00:00+03:00', staff_id: 6 } }, steps: [] }];
    await s.validate(3, parse({ recordId: 42, move: { date: '2030-04-01', time: '10:00', staffId: 5 } }));
    expect(index.availability.mock.calls[0][2]).toMatchObject({ id: 42, datetime: '2030-04-01T11:00:00+03:00', staff_id: 6 });
  });
  test('move: local availability, patch keeps length; busy → 409', async () => {
    const r = await s.validate(3, parse({ recordId: 42, move: { date: '2030-04-01', time: '11:00', staffId: 6 } }));
    expect(r.overlay.patch).toEqual({ datetime: '2030-04-01T11:00:00+03:00', staff_id: 6, seance_length: 3600 });
    expect(index.availability.mock.calls[0][2]).toMatchObject(RECORD);
    await expect(s.validate(3, parse({ recordId: 42, move: { date: '2030-04-01', time: '12:00', staffId: 6 } }))).rejects.toMatchObject({ code: 'slot_taken' });
  });
  test('edits of cancelled / arrived / paid records → 409; missing → 404', async () => {
    state.record = { ...RECORD, attendance: -1 };
    await expect(s.validate(3, parse({ recordId: 42, status: 'confirm' }))).rejects.toMatchObject({ status: 409 });
    state.record = { ...RECORD, attendance: 1 };
    await expect(s.validate(3, parse({ recordId: 42, status: 'cancel' }))).rejects.toMatchObject({ status: 409, message: 'Пришедшие и оплаченные визиты изменяйте в YClients.' });
    state.record = { ...RECORD, paid_amount: 10 };
    await expect(s.validate(3, parse({ recordId: 42, status: 'confirm' }))).rejects.toMatchObject({ status: 409 });
    state.record = null;
    await expect(s.validate(3, parse({ recordId: 42, status: 'confirm' }))).rejects.toMatchObject({ status: 404 });
  });
  test('salon without YClients → 409', async () => {
    state.salon = { id: 3 };
    await expect(s.validate(3, parse({ recordId: 42, status: 'confirm' }))).rejects.toMatchObject({ status: 409 });
  });
  test('validate reads through sources.forSalon (live fallback when local-first is off or cold)', async () => {
    sources.forSalon.mockResolvedValueOnce({ kind: 'live', services: jest.fn(async () => []) });
    await s.validate(3, parse({ create: CREATE }));
    expect(sources.forSalon).toHaveBeenCalledWith(state.salon);
    expect(sources.local).not.toHaveBeenCalled();
    expect(index.availability.mock.calls[0][3]).toMatchObject({ kind: 'live' });
  });
  test('cold reference cache propagates 503', async () => {
    const m = require('./services/journal/model');
    index.availability.mockRejectedValue(new m.JournalError(503, 'cold', 'cache_cold'));
    await expect(s.validate(3, parse({ create: CREATE }))).rejects.toMatchObject({ status: 503, code: 'cache_cold' });
  });
});

describe('enqueue', () => {
  test('inserts one queued package and answers with -outboxId for create', async () => {
    const r = await s.enqueue(3, 4, parse({ create: CREATE }));
    expect(r).toEqual({ outboxId: 7, recordId: -7, status: 'queued' });
    const [salonId, sessionId, userId, hash, ycId, parent, steps, overlay] = state.inserted[0];
    expect([salonId, sessionId, userId, ycId, parent]).toEqual([3, SID, 4, null, null]);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(steps)[0].kind).toBe('create');
    expect(JSON.parse(overlay).kind).toBe('create');
  });
  test('existing record keeps its id', async () => {
    expect(await s.enqueue(3, 4, parse({ recordId: 42, status: 'confirm' }))).toEqual({ outboxId: 7, recordId: 42, status: 'queued' });
    expect(state.inserted[0][4]).toBe(42);
  });
  test('same session twice → same answer, one insert, replay skips validation', async () => {
    const first = await s.enqueue(3, 4, parse({ create: CREATE }));
    index.availability.mockResolvedValue({ duration: 60, slots: [] }); // its own overlay now holds the slot
    const second = await s.enqueue(3, 4, parse({ create: CREATE }));
    expect(second.outboxId).toBe(first.outboxId);
    expect(second.recordId).toBe(first.recordId);
    expect(state.inserted).toHaveLength(1);
    expect(index.availability).toHaveBeenCalledTimes(1);
  });
  test('same session, different body → 409', async () => {
    await s.enqueue(3, 4, parse({ create: CREATE }));
    await expect(s.enqueue(3, 4, parse({ create: { ...CREATE, comment: 'другое' } }))).rejects.toMatchObject({ status: 409, code: 'session_used', message: 'Ключ формы уже использован.' });
  });
  test('unknown / cancelled unsent record → 404, nothing stored', async () => {
    await expect(s.enqueue(3, 4, parse({ recordId: -7, status: 'confirm' }))).rejects.toMatchObject({ status: 404 });
    state.row = { id: 7, status: 'cancelled', yclients_record_id: null, overlay: { kind: 'create' } };
    await expect(s.enqueue(3, 4, parse({ recordId: -7, status: 'confirm' }))).rejects.toMatchObject({ status: 404 });
    expect(state.inserted).toHaveLength(0);
  });
  test('change of an unsent new record rides on its create package', async () => {
    const overlay = { kind: 'create', date: '2030-04-01', time: '10:00', staffId: 5, duration: 60,
      services: [{ id: 900, title: 'Чистка', amount: 2, cost: 3000 }], client: { name: 'Анна', phone: '79200001122' }, attendance: 0 };
    state.row = { id: 5, status: 'queued', yclients_record_id: null, overlay, steps: [{ kind: 'create', state: 'pending' }] };
    const r = await s.enqueue(3, 4, parse({ recordId: -5, edit: { attendance: 1 } }));
    expect(r).toEqual({ outboxId: 7, recordId: -5, status: 'queued' });
    const [, , , , ycId, parent, steps] = state.inserted[0];
    expect([ycId, parent]).toEqual([null, 5]);
    expect(JSON.parse(steps).map(x => x.kind)).toEqual(['edit']);
  });
  test('create already in YClients → the change goes to the real record', async () => {
    state.row = { id: 5, status: 'done', yclients_record_id: '42', overlay: { kind: 'create', date: '2030-04-01', time: '10:00', staffId: 5, duration: 60, services: [] }, steps: [] };
    await s.enqueue(3, 4, parse({ recordId: -5, edit: { attendance: 1 } }));
    expect(state.inserted[0].slice(4, 6)).toEqual([42, 5]);
  });
  test('missing table → 503', async () => {
    db.oneOrNone.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '42P01' }));
    await expect(s.enqueue(3, 4, parse({ recordId: 42, status: 'confirm' }))).rejects.toMatchObject({ status: 503 });
  });
});

describe('retry / dismiss', () => {
  const steps = [{ kind: 'create', opId: 'a', state: 'done' }, { kind: 'pay', opId: 'b', state: 'failed' }];
  test('retry of a definite failure requeues and resets the failed step', async () => {
    state.row = { id: 7, status: 'failed', error_code: 'rejected', steps };
    expect(await s.retry(3, 7)).toEqual({ outboxId: 7, status: 'queued' });
    const call = db.oneOrNone.mock.calls.find(c => /UPDATE journal_outbox/.test(c[0]));
    expect(call[0]).toMatch(/status='failed' AND error_code IS DISTINCT FROM 'uncertain'/);
    expect(call[0]).toMatch(/attempts=0/);
    const next = JSON.parse(call[1][2]);
    expect(next[0]).toEqual(steps[0]);
    expect(next[1]).toMatchObject({ kind: 'pay', state: 'pending' });
    expect(next[1].opId).not.toBe('b');
  });
  test('retry of a package blocked by another unresolved operation is allowed', async () => {
    state.row = { id: 7, status: 'failed', error_code: 'blocked_pending', steps };
    expect(await s.retry(3, 7)).toEqual({ outboxId: 7, status: 'queued' });
  });
  test('retry not allowed for uncertain or non-failed packages', async () => {
    state.row = { id: 7, status: 'failed', error_code: 'uncertain', steps };
    await expect(s.retry(3, 7)).rejects.toMatchObject({ status: 409, code: 'uncertain' });
    state.row = { id: 7, status: 'failed', error_code: null, steps: [{ kind: 'pay', state: 'uncertain' }] };
    await expect(s.retry(3, 7)).rejects.toMatchObject({ status: 409 });
    state.row = { id: 7, status: 'queued', error_code: null, steps };
    await expect(s.retry(3, 7)).rejects.toMatchObject({ status: 409 });
    state.row = null;
    await expect(s.retry(3, 7)).rejects.toMatchObject({ status: 404 });
    expect(db.oneOrNone.mock.calls.some(c => /UPDATE/.test(c[0]))).toBe(false);
  });
  test('dismiss only from failed; scoped by salon', async () => {
    state.row = { id: 7, status: 'failed', error_code: 'uncertain', steps };
    expect(await s.dismiss(3, 7)).toEqual({ outboxId: 7, status: 'cancelled' });
    const call = db.oneOrNone.mock.calls.find(c => /UPDATE journal_outbox/.test(c[0]));
    expect(call[0]).toMatch(/WHERE salon_id=\$1 AND id=\$2 AND status='failed'/);
    expect(call[1]).toEqual([3, 7]);
    for (const status of ['queued', 'running', 'done', 'cancelled']) {
      state.row = { id: 7, status, steps };
      await expect(s.dismiss(3, 7)).rejects.toMatchObject({ status: 409 });
    }
  });
  test('lost race on update → 409', async () => {
    state.row = { id: 7, status: 'failed', error_code: null, steps };
    state.updated = null;
    await expect(s.dismiss(3, 7)).rejects.toMatchObject({ status: 409 });
    await expect(s.retry(3, 7)).rejects.toMatchObject({ status: 409 });
  });
});

test('the YClients guard itself works', () => {
  expect(() => yc.getRecord()).toThrow('YClients called');
  yc.__calls.length = 0;
});

test.each([-1,0,1,2])('edit session queues status %s without external effects', async attendance => {
  setup({record:{...RECORD,attendance:1}});
  const result=await s.validate(3,parse({recordId:42,edit:{attendance}}));
  expect(result.steps).toEqual([expect.objectContaining({kind:'edit',params:{attendance}})]);
  expect(result.overlay.patch).toEqual({attendance});
});
test('edit session rejects financial mixing and malformed prices', () => {
  expect(()=>parse({recordId:42,edit:{attendance:1},payments:[pay('account',10,1)]})).toThrow('отдельно');
  expect(()=>parse({recordId:42,edit:{lines:[{serviceId:900,quantity:1,unitPrice:-5}]}})).toThrow('Проверьте');
});
test('edit services overlay preserves full pricing for immediate display', async () => {
  const result=await s.validate(3,parse({recordId:42,edit:{lines:[{serviceId:900,quantity:1,unitPrice:2000,discount:10}]}}));
  expect(result.overlay.patch.services[0]).toMatchObject({id:900,cost:1800,cost_per_unit:2000,amount:1,discount:10});
});
describe('one card = one package: status, services, time, staff (10.11.2026)', () => {
  test('status edit + move go in ONE package: move first, then edit; overlay has both', async () => {
    const result = await s.validate(3, parse({ recordId: 42, edit: { attendance: 2 }, move: { date: '2030-04-01', time: '11:00', staffId: 5 } }));
    expect(result.steps.map(x => x.kind)).toEqual(['move', 'edit']);
    expect(result.overlay.patch).toMatchObject({ attendance: 2, datetime: '2030-04-01T11:00:00+03:00', staff_id: 5 });
  });
  test('new services are checked at the NEW time and staff', async () => {
    await s.validate(3, parse({ recordId: 42, edit: { lines: [{ serviceId: 900, quantity: 1, unitPrice: 3000, discount: 0 }, { serviceId: 901, quantity: 1, unitPrice: 100, discount: 0 }] }, move: { date: '2030-04-01', time: '11:00', staffId: 5 } })).catch(() => {});
    const calls = index.availability.mock.calls.filter(c => c[2]?.services?.length === 2);
    for (const c of calls) expect(c[2].datetime).toBe('2030-04-01T11:00:00+03:00');
  });
  test('edit still cannot be mixed with payments or confirm/cancel', () => {
    expect(() => parse({ recordId: 42, edit: { attendance: 1 }, status: 'confirm' })).toThrow();
    expect(() => parse({ recordId: 42, edit: { attendance: 1 }, move: { date: '2030-04-01', time: '11:00', staffId: 5 }, payments: [pay('account', 10, 1)] })).toThrow();
  });
});

describe('edit: parity fields (12.11.2026)', () => {
  test('all new fields go into the edit step; the overlay shows them before sending', async () => {
    sources.forSalon.mockResolvedValueOnce({ kind: 'local', services: jest.fn(async () => []), labels: jest.fn(async () => [{ id: 3, title: 'VIP' }]) });
    const edit = { comment: 'Позвонить', customColor: '#F4A0A0', labelIds: [3], technicalBreak: 600, notifyClient: false, seanceLength: 75 };
    const out = await s.validate(3, parse({ recordId: 42, edit }));
    expect(out.steps).toEqual([expect.objectContaining({ kind: 'edit',
      params: { comment: 'Позвонить', customColor: '#f4a0a0', labelIds: [3], technicalBreak: 600, notifyClient: false, seanceLength: 75 } })]);
    expect(out.overlay.patch).toEqual({ comment: 'Позвонить', custom_color: 'f4a0a0', record_labels: [3], technical_break_duration: 600,
      seance_length: 4500, notify_client: false });
    expect(index.availability).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ durationOverride: 75, technicalBreak: 600, time: '10:00', staffId: 5 }), expect.anything(), expect.anything());
  });
  test('move together with a longer duration checks the new place with the new length', async () => {
    const out = await s.validate(3, parse({ recordId: 42, move: { date: '2030-04-01', time: '11:00', staffId: 5 }, edit: { seanceLength: 90 } }));
    expect(out.steps.map(x => x.kind)).toEqual(['move', 'edit']);
    expect(out.steps[0].params).toEqual({ date: '2030-04-01', time: '11:00', staffId: 5, seanceLength: 90 });
    expect(index.availability.mock.calls[0][1]).toMatchObject({ action: 'move', time: '11:00', durationOverride: 90 });
    expect(out.overlay.patch).toMatchObject({ datetime: '2030-04-01T11:00:00+03:00', seance_length: 5400 });
  });
  test('a move without a new length keeps the old move params', async () => {
    const out = await s.validate(3, parse({ recordId: 42, move: { date: '2030-04-01', time: '11:00', staffId: 5 }, edit: { comment: 'x' } }));
    expect(out.steps[0].params).toEqual({ date: '2030-04-01', time: '11:00', staffId: 5 });
  });
  test('a move with a new break carries it in the move step', async () => {
    const out = await s.validate(3, parse({ recordId: 42, move: { date: '2030-04-01', time: '11:00', staffId: 5 }, edit: { technicalBreak: 600 } }));
    expect(out.steps[0].params).toEqual({ date: '2030-04-01', time: '11:00', staffId: 5, technicalBreak: 600 });
  });
  test('notifyClient alone is a valid edit and does not touch the visit', async () => {
    const out = await s.validate(3, parse({ recordId: 42, edit: { notifyClient: false } }));
    expect(out.overlay.patch).toEqual({ notify_client: false });
    expect(index.availability).not.toHaveBeenCalled();
  });
  test('client change of an arrived visit is refused locally', async () => {
    setup({ record: { ...RECORD, attendance: 1 } });
    await expect(s.validate(3, parse({ recordId: 42, edit: { client: { name: 'Анна', phone: '79200255591' } } }))).rejects.toMatchObject({ status: 409 });
  });
});

describe('delete (12.11.2026)', () => {
  test('parse: delete alone or with edit; not with payments, move or create', () => {
    expect(parse({ recordId: 42, status: 'delete' })).toMatchObject({ status: 'delete' });
    expect(parse({ recordId: 42, status: 'delete', edit: { notifyClient: false } })).toMatchObject({ status: 'delete', edit: { notifyClient: false } });
    expect(() => parse({ recordId: 42, status: 'delete', payments: [pay('account', 10, 100)] })).toThrow('Удалённую запись нельзя оплатить');
    expect(() => parse({ recordId: 42, status: 'delete', move: { date: '2030-04-01', time: '11:00', staffId: 5 } })).toThrow('Нельзя одновременно перенести и удалить');
    expect(() => parse({ recordId: 42, status: 'confirm', edit: { comment: 'x' } })).toThrow('отдельно');
    expect(() => parse({ create: CREATE, status: 'delete' })).toThrow('сохранённой');
  });
  test('validate: delete is the last step and hides the record in the overlay', async () => {
    const out = await s.validate(3, parse({ recordId: 42, status: 'delete', edit: { notifyClient: false } }));
    expect(out.steps.map(x => x.kind)).toEqual(['edit', 'delete']);
    expect(out.overlay.patch).toEqual({ notify_client: false, deleted: true });
  });
  test('validate: arrived or paid visit cannot be deleted; a cancelled one can', async () => {
    setup({ record: { ...RECORD, attendance: 1 } });
    await expect(s.validate(3, parse({ recordId: 42, status: 'delete' }))).rejects.toMatchObject({ status: 409 });
    setup({ record: { ...RECORD, attendance: -1 } });
    await expect(s.validate(3, parse({ recordId: 42, status: 'delete' }))).resolves.toMatchObject({ overlay: { patch: { deleted: true } } });
    setup({ record: { ...RECORD, deleted: true } });
    await expect(s.validate(3, parse({ recordId: 42, status: 'delete' }))).rejects.toMatchObject({ status: 409 });
  });
});

describe('delete review fixes (12.11.2026)', () => {
  const queuedPay = { id: 6, status: 'queued', yclients_record_id: 42, overlay: { kind: 'patch', patch: {} },
    steps: [{ kind: 'pay', state: 'pending', params: { method: 'loyalty_card', methodId: 88, amount: 100 } }] };
  test('a QUEUED payment blocks delete/confirm/move like a confirmed one', async () => {
    state.open = [queuedPay];
    await expect(s.validate(3, parse({ recordId: 42, status: 'delete' }))).rejects.toMatchObject({ status: 409, message: 'Сначала удалите оплаты визита.' });
    await expect(s.validate(3, parse({ recordId: 42, status: 'confirm' }))).rejects.toMatchObject({ status: 409 });
    await expect(s.validate(3, parse({ recordId: 42, move: { date: '2030-04-01', time: '11:00', staffId: 5 } }))).rejects.toMatchObject({ status: 409 });
  });
  test('delete texts: paid → «Сначала удалите оплаты визита», arrived → «удаляйте в YClients»', async () => {
    setup({ record: { ...RECORD, paid_amount: 100 } });
    await expect(s.validate(3, parse({ recordId: 42, status: 'delete' }))).rejects.toMatchObject({ message: 'Сначала удалите оплаты визита.' });
    setup({ record: { ...RECORD, attendance: 1 } });
    await expect(s.validate(3, parse({ recordId: 42, status: 'delete' }))).rejects.toMatchObject({ message: 'Пришедший визит удаляйте в YClients.' });
  });
  const createRow = (over = {}) => ({ id: 5, status: 'queued', released_at: null, yclients_record_id: null,
    overlay: { kind: 'create', date: '2030-04-01', time: '10:00', staffId: 5, duration: 60, services: [{ id: 900, title: 'Чистка', amount: 1, cost: 3000 }], client: { name: 'Анна', phone: '79200001122' }, attendance: 0 },
    steps: [{ kind: 'create', state: 'pending' }], ...over });
  test('unsent new record: delete cancels its create and children locally, no YClients step', async () => {
    state.row = createRow();
    state.localCancel = { id: 9, status: 'cancelled' };
    const r = await s.enqueue(3, 4, parse({ recordId: -5, status: 'delete' }));
    expect(r).toEqual({ outboxId: 9, recordId: -5, status: 'cancelled' });
    expect(state.inserted).toHaveLength(0);
    const { sql, args } = state.localCalls[0];
    expect(sql).toMatch(/status='queued' AND released_at IS NULL AND yclients_record_id IS NULL/);
    expect(sql).toMatch(/create_outbox_id/);
    expect(args.slice(0, 3)).toEqual([3, 5, SID]);
    expect(JSON.parse(args[5])).toEqual([]);
    expect(index.availability).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some(([q]) => /UPDATE finance_operations/.test(q))).toBe(true);
  });
  test('unsent new record with a queued payment is still cancelled locally (nothing reached YClients)', async () => {
    state.row = createRow({ steps: [{ kind: 'create', state: 'pending' }, { kind: 'pay', state: 'pending', params: { method: 'loyalty_card', methodId: 88, amount: 100 } }] });
    state.localCancel = { id: 9, status: 'cancelled' };
    expect(await s.enqueue(3, 4, parse({ recordId: -5, status: 'delete' }))).toMatchObject({ status: 'cancelled' });
  });
  test('released or running create → regular delete package (the create may reach YClients)', async () => {
    state.row = createRow({ released_at: new Date().toISOString() });
    const r = await s.enqueue(3, 4, parse({ recordId: -5, status: 'delete' }));
    expect(r).toEqual({ outboxId: 7, recordId: -5, status: 'queued' });
    expect(state.localCalls).toBeUndefined();
    expect(JSON.parse(state.inserted[0][6]).map(x => x.kind)).toEqual(['delete']);
  });
  test('local cancel lost the race (dispatch released it) → regular delete package', async () => {
    state.row = createRow();
    state.localCancel = null;
    const r = await s.enqueue(3, 4, parse({ recordId: -5, status: 'delete' }));
    expect(state.localCalls).toHaveLength(1);
    expect(r.status).toBe('queued');
    expect(JSON.parse(state.inserted[0][6]).map(x => x.kind)).toEqual(['delete']);
  });
  test('replay of a local cancel answers the same', async () => {
    state.outbox = { id: 9, request_hash: require('./services/journal/model').fingerprint(parse({ recordId: -5, status: 'delete' })), status: 'cancelled' };
    expect(await s.enqueue(3, 4, parse({ recordId: -5, status: 'delete' }))).toEqual({ outboxId: 9, recordId: -5, status: 'cancelled', duplicate: true });
  });
});
