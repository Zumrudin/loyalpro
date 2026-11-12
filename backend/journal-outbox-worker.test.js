'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret', JOURNAL_LOCAL_FIRST: true, JOURNAL_OUTBOX: true }));
jest.mock('./db', () => ({ db: { oneOrNone: jest.fn(), query: jest.fn(), any: jest.fn() }, pool: { connect: jest.fn() } }));
jest.mock('./logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log, __log: log };
});
jest.mock('./services/journal/index', () => ({ mutate: jest.fn() }));
jest.mock('./services/journal/payments', () => ({ context: jest.fn(), parse: jest.fn(b => ({ ...b })), pay: jest.fn() }));
jest.mock('./services/journal/yclients', () => ({ getRecord: jest.fn() }));
jest.mock('./services/journal/reference-cache', () => ({ learnBonusPercent: jest.fn(async () => {}) }));

const { db } = require('./db');
const { __log: log } = require('./logger');
const index = require('./services/journal/index');
const payments = require('./services/journal/payments');
const yc = require('./services/journal/yclients');
const reference = require('./services/journal/reference-cache');
const m = require('./services/journal/model');
const w = require('./services/journal/outbox-worker');

const OP = n => `00000000-0000-4000-8000-00000000000${n}`;
const SALON = { id: 3, yclients_company_id: 77 };
const SALE = { state: { items: [] }, payment_methods: [] };
const CREATE_PARAMS = { action: 'create', date: '2030-04-01', time: '10:00', staffId: 5, serviceSource: 'internal', serviceIds: [1], clientName: 'Анна', clientPhone: '79200000000' };

function pkg(steps, over = {}) {
  return { id: 11, salon_id: 3, user_id: 9, yclients_record_id: null, status: 'running', attempts: 1, steps, ...over };
}
const step = (kind, n, params = {}, extra = {}) => ({ kind, opId: OP(n), params, state: 'pending', ...extra });

let calls, writes, attendance;
beforeEach(() => {
  jest.clearAllMocks();
  calls = []; writes = []; attendance = 0;
  db.oneOrNone.mockImplementation(async sql => (/FROM salons/.test(sql) ? SALON : null));
  db.query.mockImplementation(async (sql, args) => { writes.push({ sql, args }); return { rowCount: 0 }; });
  index.mutate.mockImplementation(async (s, u, d) => { calls.push(['mutate', d.action, d]); return d.action === 'create' ? { recordId: 500 } : { recordId: d.recordId }; });
  payments.context.mockImplementation(async (s, recordId) => ({ salon: SALON, record: { id: recordId, attendance }, documentId: 1, sale: SALE, version: 'v'.repeat(64) }));
  payments.pay.mockImplementation(async (s, u, d) => { calls.push(['pay', d.method, d]); if (d.method === 'loyalty_card') attendance = attendance; return { confirmed: true }; });
  yc.getRecord.mockImplementation(async () => ({ id: 500, datetime: 'x', attendance: 0 }));
});
const lastWrite = re => [...writes].reverse().find(x => re.test(x.sql));
const stepsOf = wr => JSON.parse(wr.args[1]);

describe('processPackage', () => {
  test('delete step goes through mutate with the live version (12.11.2026)', async () => {
    const live = { id: 42, datetime: '2030-04-01T10:00:00+03:00', staff_id: 5, attendance: 0 };
    yc.getRecord.mockResolvedValue(live);
    expect(await w.processPackage(pkg([step('delete', 1)], { yclients_record_id: 42 }))).toBe('done');
    expect(calls[0][2]).toEqual({ operationId: OP(1), action: 'delete', recordId: 42, version: m.revision(live) });
  });
  test('delete of a record YClients no longer has (404) is done without mutate', async () => {
    yc.getRecord.mockRejectedValue(new m.JournalError(404, 'Запись не найдена.'));
    expect(await w.processPackage(pkg([step('delete', 1)], { yclients_record_id: 42 }))).toBe('done');
    expect(index.mutate).not.toHaveBeenCalled();
    expect(stepsOf(lastWrite(/status='done'/))[0].result).toEqual({ recordId: 42, alreadyDeleted: true });
  });
  test('delete: plain HTTP 404 (ycGet Error.status) on the live read is done too', async () => {
    yc.getRecord.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
    expect(await w.processPackage(pkg([step('delete', 1)], { yclients_record_id: 42 }))).toBe('done');
    expect(index.mutate).not.toHaveBeenCalled();
  });
  test('create passes api_id = lp-outbox-<package id> outside the draft', async () => {
    await w.processPackage(pkg([step('create', 1, CREATE_PARAMS)]));
    expect(index.mutate.mock.calls[0][3]).toEqual({ apiId: 'lp-outbox-11' });
    expect(index.mutate.mock.calls[0][2]).not.toHaveProperty('apiId');
  });
  test('create + bonus + cash: order, recordId flows, confirmArrival, done', async () => {
    const row = pkg([
      step('create', 1, CREATE_PARAMS),
      step('pay', 2, { method: 'loyalty_card', methodId: 88, amount: 300 }),
      step('pay', 3, { method: 'account', methodId: 10, amount: 2700, confirmArrival: true }),
    ]);
    expect(await w.processPackage(row)).toBe('done');
    expect(calls.map(c => c[0] + ':' + c[1])).toEqual(['mutate:create', 'pay:loyalty_card', 'pay:account']);
    expect(calls[0][2]).toMatchObject({ operationId: OP(1), action: 'create', staffId: 5 });
    expect(payments.context).toHaveBeenCalledWith(3, 500);
    expect(calls[1][2]).toMatchObject({ operationId: OP(2), recordId: 500, method: 'loyalty_card', version: 'v'.repeat(64) });
    expect(calls[1][2].confirmArrival).toBeUndefined();
    expect(calls[2][2]).toMatchObject({ operationId: OP(3), recordId: 500, method: 'account', confirmArrival: true });
    expect(index.mutate.mock.calls[0][1]).toBe(9);
    expect(reference.learnBonusPercent).toHaveBeenCalledTimes(2);
    expect(reference.learnBonusPercent).toHaveBeenCalledWith(3, SALE);
    // Steps persisted after each step: three post-step persists show 1, 2, 3 done.
    const persists = writes.filter(x => /^UPDATE journal_outbox SET steps=/.test(x.sql)).map(x => stepsOf(x).filter(s => s.state === 'done').length);
    expect(persists).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(writes.filter(x => /^UPDATE journal_outbox SET steps=/.test(x.sql)).every(x => x.args[2] === 500)).toBe(true);
    const done = lastWrite(/status='done'/);
    expect(done.args[2]).toBe(500);
    expect(stepsOf(done).every(s => s.state === 'done' && !s.draft)).toBe(true);
    expect(stepsOf(done)[0].result).toEqual({ recordId: 500 });
  });

  test('confirmArrival is not sent when live attendance is not 0 or params lack it', async () => {
    attendance = 1;
    await w.processPackage(pkg([step('pay', 3, { method: 'account', methodId: 10, amount: 100, confirmArrival: true })], { yclients_record_id: 42 }));
    expect(calls[0][2].confirmArrival).toBeUndefined();
    attendance = 0; calls = [];
    await w.processPackage(pkg([step('pay', 4, { method: 'account', methodId: 10, amount: 100 })], { yclients_record_id: 42 }));
    expect(calls[0][2].confirmArrival).toBeUndefined();
  });

  test('restart: done steps are not re-executed, recordId taken from done create', async () => {
    const row = pkg([
      step('create', 1, CREATE_PARAMS, { state: 'done', result: { recordId: 500 } }),
      step('pay', 2, { method: 'loyalty_card', methodId: 88, amount: 300 }, { state: 'done' }),
      step('pay', 3, { method: 'account', methodId: 10, amount: 2700 }),
    ]);
    attendance = 1;
    expect(await w.processPackage(row)).toBe('done');
    expect(index.mutate).not.toHaveBeenCalled();
    expect(calls.map(c => c[1])).toEqual(['account']);
    expect(calls[0][2].recordId).toBe(500);
  });

  test('move/confirm use live revision', async () => {
    const live = { id: 42, datetime: '2030-04-01T10:00:00+03:00', staff_id: 5, attendance: 0 };
    yc.getRecord.mockResolvedValue(live);
    await w.processPackage(pkg([step('move', 1, { date: '2030-04-02', time: '11:00', staffId: 6 }), step('confirm', 2)], { yclients_record_id: 42 }));
    expect(calls[0][2]).toEqual({ operationId: OP(1), action: 'move', recordId: 42, version: m.revision(live), date: '2030-04-02', time: '11:00', staffId: 6 });
    expect(calls[1][2]).toEqual({ operationId: OP(2), action: 'confirm', recordId: 42, version: m.revision(live) });
  });

  test('stored draft (same opId) is replayed byte-identical; re-keyed step rebuilds it', async () => {
    const stored = { operationId: OP(1), action: 'confirm', recordId: 42, version: 'a'.repeat(64) };
    await w.processPackage(pkg([step('confirm', 1, {}, { draft: stored })], { yclients_record_id: 42 }));
    expect(yc.getRecord).not.toHaveBeenCalled();
    expect(calls[0][2]).toEqual(stored);
    calls = [];
    await w.processPackage(pkg([step('confirm', 2, {}, { draft: stored })], { yclients_record_id: 42 }));
    expect(yc.getRecord).toHaveBeenCalled();
    expect(calls[0][2].operationId).toBe(OP(2));
  });

  test('duplicate create replay: recordId from duplicate result is used', async () => {
    index.mutate.mockImplementation(async (s, u, d) => { calls.push(['mutate', d.action, d]); return { recordId: 777, duplicate: true }; });
    await w.processPackage(pkg([step('create', 1, CREATE_PARAMS), step('pay', 2, { method: 'loyalty_card', methodId: 88, amount: 300 })]));
    expect(payments.context).toHaveBeenCalledWith(3, 777);
    expect(lastWrite(/status='done'/).args[2]).toBe(777);
  });

  test("'busy' → queued again with 5 s delay; 6th attempt → failed", async () => {
    index.mutate.mockRejectedValue(new m.JournalError(409, 'Сохраняется другая запись.', 'busy'));
    expect(await w.processPackage(pkg([step('create', 1, CREATE_PARAMS)], { attempts: 1 }))).toBe('queued');
    let q = lastWrite(/status='queued'/);
    expect(q.args[3]).toBe(5);
    expect(stepsOf(q)[0].state).toBe('pending');
    expect(await w.processPackage(pkg([step('create', 1, CREATE_PARAMS)], { attempts: 3 }))).toBe('queued');
    expect(lastWrite(/status='queued'/).args[3]).toBe(120);
    expect(await w.processPackage(pkg([step('create', 1, CREATE_PARAMS)], { attempts: 5 }))).toBe('queued');
    expect(lastWrite(/status='queued'/).args[3]).toBe(600);
    expect(await w.processPackage(pkg([step('create', 1, CREATE_PARAMS)], { attempts: 6 }))).toBe('failed');
    const f = lastWrite(/status='failed'/);
    expect(f.args[3]).toBe(0);
    expect(f.args[4]).toBe('busy');
    expect(stepsOf(f)[0].state).toBe('failed');
  });

  test("'uncertain' → failed with error_code uncertain, no retry", async () => {
    payments.pay.mockRejectedValue(new m.JournalError(409, 'Оплата отправлена, но результат требует сверки.', 'uncertain'));
    const r = await w.processPackage(pkg([step('confirm', 1, {}, { state: 'done' }), step('pay', 2, { method: 'loyalty_card', methodId: 88, amount: 1 })], { yclients_record_id: 42, attempts: 1 }));
    expect(r).toBe('failed');
    expect(lastWrite(/status='queued'/)).toBeUndefined();
    const f = lastWrite(/status='failed'/);
    expect(f.args.slice(3)).toEqual([1, 'uncertain', 'Оплата отправлена, но результат требует сверки.']);
    expect(stepsOf(f)[1].state).toBe('uncertain');
  });

  test("definite 'rejected' → failed immediately with failed_step and message", async () => {
    index.mutate.mockImplementation(async (s, u, d) => {
      if (d.action === 'cancel') throw new m.JournalError(409, 'YClients отклонил операцию.', 'rejected');
      return { recordId: 42 };
    });
    const r = await w.processPackage(pkg([step('move', 1, { date: '2030-04-02', time: '11:00', staffId: 6 }), step('cancel', 2)], { yclients_record_id: 42, attempts: 1 }));
    expect(r).toBe('failed');
    const f = lastWrite(/status='failed'/);
    expect(f.args.slice(3)).toEqual([1, 'rejected', 'YClients отклонил операцию.']);
    expect(stepsOf(f).map(s => s.state)).toEqual(['done', 'failed']);
  });

  test("'stale' → retry and the stored draft is dropped", async () => {
    payments.pay.mockRejectedValue(new m.JournalError(409, 'Обновите форму.', 'stale'));
    await w.processPackage(pkg([step('pay', 1, { method: 'loyalty_card', methodId: 88, amount: 1 })], { yclients_record_id: 42 }));
    const q = lastWrite(/status='queued'/);
    expect(stepsOf(q)[0].draft).toBeUndefined();
  });

  test('document not ready (409 «не готов») → retry', async () => {
    payments.context.mockRejectedValue(new m.JournalError(409, 'Документ оплаты ещё не готов или неоднозначен.'));
    expect(await w.processPackage(pkg([step('pay', 1, { method: 'loyalty_card', methodId: 88, amount: 1 })], { yclients_record_id: 42 }))).toBe('queued');
  });

  test('non-JournalError 422 → fail; ECONNRESET → retry; raw message never logged', async () => {
    const secret = 'Bearer SECRET-TOKEN Анна +79200000000';
    const http = Object.assign(new Error(secret), { response: { status: 422, data: { message: secret } } });
    yc.getRecord.mockRejectedValue(http);
    expect(await w.processPackage(pkg([step('confirm', 1)], { yclients_record_id: 42 }))).toBe('failed');
    const f = lastWrite(/status='failed'/);
    expect(f.args[5]).toBe('YClients не ответил. Повторите позже.');
    const net = Object.assign(new Error(secret), { code: 'ECONNRESET' });
    yc.getRecord.mockRejectedValue(net);
    expect(await w.processPackage(pkg([step('confirm', 1)], { yclients_record_id: 42 }))).toBe('queued');
    const logged = [...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls].flat().join('\n');
    expect(logged).not.toMatch(/SECRET|Анна|79200000000/);
    expect(logged).toMatch(/status=422/);
    expect(logged).toMatch(/ECONNRESET/);
  });
});


// JSONB stores object keys sorted by length, then bytewise: simulate that round-trip.
function jsonbRoundTrip(v) {
  if (Array.isArray(v)) return v.map(jsonbRoundTrip);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(keys.map(k => [k, jsonbRoundTrip(v[k])]));
  }
  return v;
}

describe('review fixes', () => {
  test('C1: draft survives a JSONB round-trip byte-identical (stored as a JSON string)', async () => {
    // First run: the step builds and persists its draft, then the process "crashes" in the core.
    payments.pay.mockImplementationOnce(async () => { throw Object.assign(new Error('crash'), { code: 'ECONNRESET' }); });
    await w.processPackage(pkg([step('pay', 1, { method: 'loyalty_card', methodId: 88, amount: 300 })], { yclients_record_id: 42 }));
    const persisted = writes.find(x => /^UPDATE journal_outbox SET steps=/.test(x.sql));
    const firstDraft = payments.pay.mock.calls[0][2];
    // The row read back from JSONB has its keys reordered.
    const stored = jsonbRoundTrip(JSON.parse(persisted.args[1]));
    expect(typeof stored[0].draftJson).toBe('string');
    calls = [];
    await w.processPackage(pkg(stored, { yclients_record_id: 42 }));
    const replay = payments.pay.mock.calls[1][2];
    expect(JSON.stringify(replay)).toBe(JSON.stringify(firstDraft));
    expect(m.fingerprint(replay)).toBe(m.fingerprint(firstDraft));
    expect(payments.context).toHaveBeenCalledTimes(2);
  });

  test('move step with a new length/break: the draft carries durationOverride and technicalBreak', async () => {
    const live = { id: 42, datetime: '2030-04-01T10:00:00+03:00', staff_id: 5, attendance: 0 };
    yc.getRecord.mockResolvedValue(live);
    await w.processPackage(pkg([step('move', 1, { date: '2030-04-02', time: '11:00', staffId: 6, seanceLength: 90, technicalBreak: 600 })], { yclients_record_id: 42 }));
    expect(calls[0][2]).toEqual({ operationId: OP(1), action: 'move', recordId: 42, version: m.revision(live), date: '2030-04-02', time: '11:00', staffId: 6,
      durationOverride: 90, technicalBreak: 600 });
  });
  test('old move package without the new fields stores the same draftJson byte-for-byte', async () => {
    const live = { id: 42, datetime: '2030-04-01T10:00:00+03:00', staff_id: 5, attendance: 0 };
    yc.getRecord.mockResolvedValue(live);
    const st = step('move', 1, { date: '2030-04-02', time: '11:00', staffId: 6 });
    await w.processPackage(pkg([st], { yclients_record_id: 42 }));
    const expected = JSON.stringify({ operationId: OP(1), action: 'move', recordId: 42, version: m.revision(live), date: '2030-04-02', time: '11:00', staffId: 6 });
    expect(JSON.stringify(calls[0][2])).toBe(expected);
    expect(m.fingerprint(calls[0][2])).toBe(m.fingerprint(JSON.parse(expected)));
  });
  test('C1: move draft replay after a JSONB round-trip keeps the fingerprint', async () => {
    index.mutate.mockImplementationOnce(async () => { throw Object.assign(new Error('crash'), { code: 'ECONNRESET' }); });
    await w.processPackage(pkg([step('move', 1, { date: '2030-04-02', time: '11:00', staffId: 6 })], { yclients_record_id: 42 }));
    const first = index.mutate.mock.calls[0][2];
    const stored = jsonbRoundTrip(JSON.parse(writes.find(x => /^UPDATE journal_outbox SET steps=/.test(x.sql)).args[1]));
    await w.processPackage(pkg(stored, { yclients_record_id: 42 }));
    expect(m.fingerprint(index.mutate.mock.calls[1][2])).toBe(m.fingerprint(first));
    expect(yc.getRecord).toHaveBeenCalledTimes(1);
  });

  test('C1: an old object draft is still accepted', async () => {
    const stored = { operationId: OP(1), action: 'confirm', recordId: 42, version: 'a'.repeat(64) };
    await w.processPackage(pkg([step('confirm', 1, {}, { draft: stored })], { yclients_record_id: 42 }));
    expect(yc.getRecord).not.toHaveBeenCalled();
    expect(calls[0][2]).toEqual(stored);
  });

  test('C1: core «key already used for other data» → uncertain, never retried or re-keyable', async () => {
    expect(w.classify(new m.JournalError(400, 'Ключ оплаты уже использован для других данных.'))).toBe('uncertain');
    expect(w.classify(new m.JournalError(409, 'Ключ операции уже использован для других данных.'))).toBe('uncertain');
    payments.pay.mockRejectedValue(new m.JournalError(400, 'Ключ оплаты уже использован для других данных.'));
    expect(await w.processPackage(pkg([step('pay', 1, { method: 'loyalty_card', methodId: 88, amount: 1 })], { yclients_record_id: 42 }))).toBe('failed');
    const f = lastWrite(/status='failed'/);
    expect(f.args[4]).toBe('uncertain');
    expect(stepsOf(f)[0].state).toBe('uncertain');
  });

  test('I1: persist failure after an executed step never downgrades it; package is requeued', async () => {
    let n = 0;
    db.query.mockImplementation(async (sql, args) => {
      writes.push({ sql, args });
      if (/^UPDATE journal_outbox SET steps=/.test(sql) && ++n === 2) throw new Error('db down');
      return { rowCount: 1 };
    });
    // attempts exhausted: a plain retry would turn into 'failed'.
    const r = await w.processPackage(pkg([step('pay', 1, { method: 'loyalty_card', methodId: 88, amount: 1 })], { yclients_record_id: 42, attempts: 9 }));
    expect(r).toBe('queued');
    expect(lastWrite(/status='failed'/)).toBeUndefined();
    const q = lastWrite(/status='queued'/);
    expect(stepsOf(q)[0].state).toBe('done');
    expect(stepsOf(q)[0].draftJson).toBeUndefined();
    expect(payments.pay).toHaveBeenCalledTimes(1);
  });

  test('I1: if the requeue write also fails the package stays running (throws to the tick)', async () => {
    db.query.mockImplementation(async (sql, args) => {
      writes.push({ sql, args });
      if (/^UPDATE journal_outbox SET steps=/.test(sql) && writes.filter(x => /SET steps=/.test(x.sql)).length >= 2) throw new Error('db down');
      if (/status='queued'|status='failed'/.test(sql)) throw new Error('db down');
      return { rowCount: 1 };
    });
    await expect(w.processPackage(pkg([step('pay', 1, { method: 'loyalty_card', methodId: 88, amount: 1 })], { yclients_record_id: 42, attempts: 9 }))).rejects.toThrow();
    expect(writes.some(x => /status='failed'/.test(x.sql))).toBe(false);
  });

  test('I2: blocked_pending → retry, exhausted → failed with error_code blocked_pending', async () => {
    expect(w.classify(new m.JournalError(409, 'Есть операция с неподтверждённым результатом.', 'blocked_pending'))).toBe('retry');
    payments.pay.mockRejectedValue(new m.JournalError(409, 'У этого визита есть неподтверждённая оплата.', 'blocked_pending'));
    expect(await w.processPackage(pkg([step('pay', 1, { method: 'loyalty_card', methodId: 88, amount: 1 })], { yclients_record_id: 42, attempts: 2 }))).toBe('queued');
    expect(await w.processPackage(pkg([step('pay', 1, { method: 'loyalty_card', methodId: 88, amount: 1 })], { yclients_record_id: 42, attempts: 6 }))).toBe('failed');
    const f = lastWrite(/status='failed'/);
    expect(f.args[4]).toBe('blocked_pending');
    expect(stepsOf(f)[0].state).toBe('failed');
  });

  test('I5: a bonus write-off re-created under a new id is resolved before removal', async () => {
    const sale = { state: { items: [], payment_transactions: [], loyalty_transactions: [
      { id: 2001, type_id: 3, loyalty_card_id: 88, amount: 300 }, // re-created old write-off
      { id: 2002, type_id: 3, loyalty_card_id: 88, amount: 300 }, // paid by this package
      { id: 2003, type_id: 1, loyalty_card_id: 88, amount: 300 },
    ] }, payment_methods: [] };
    payments.context.mockImplementation(async (s, recordId) => ({ salon: SALON, record: { id: recordId, attendance: 1 }, documentId: 1, sale, version: 'v'.repeat(64) }));
    db.any.mockImplementation(async (sql, args) => (/journal_financial_transactions/.test(sql) && args[1].includes(OP(1)) ? [{ external_ids: [2002] }] : []));
    await w.processPackage(pkg([
      step('pay', 1, { method: 'loyalty_card', methodId: 88, amount: 300 }, { state: 'done' }),
      step('remove_payment', 2, { transactionId: 1500, method: 'loyalty_card', methodId: 88, amount: 300 }),
    ], { yclients_record_id: 42 }));
    const call = payments.pay.mock.calls.at(-1)[2];
    expect(call).toMatchObject({ action: 'remove', transactionId: 2001 });
    const persisted = JSON.parse(writes.find(x => /^UPDATE journal_outbox SET steps=/.test(x.sql)).args[1]);
    expect(JSON.parse(persisted[1].draftJson).transactionId).toBe(2001);
  });

  test('I5: ambiguous or live id → left as is', async () => {
    const sale = { state: { items: [], payment_transactions: [], loyalty_transactions: [
      { id: 2001, type_id: 3, loyalty_card_id: 88, amount: 300 }, { id: 2002, type_id: 3, loyalty_card_id: 88, amount: 300 },
    ] }, payment_methods: [] };
    payments.context.mockImplementation(async (s, recordId) => ({ salon: SALON, record: { id: recordId }, documentId: 1, sale, version: 'v'.repeat(64) }));
    db.any.mockResolvedValue([]);
    await w.processPackage(pkg([step('remove_payment', 2, { transactionId: 1500, method: 'loyalty_card', methodId: 88, amount: 300 })], { yclients_record_id: 42 }));
    expect(payments.pay.mock.calls.at(-1)[2].transactionId).toBe(1500);
    await w.processPackage(pkg([step('remove_payment', 3, { transactionId: 2002, method: 'loyalty_card', methodId: 88, amount: 300 })], { yclients_record_id: 42 }));
    expect(payments.pay.mock.calls.at(-1)[2].transactionId).toBe(2002);
    // Cash removals are never remapped.
    await w.processPackage(pkg([step('remove_payment', 4, { transactionId: 1500, method: 'account', methodId: 10, amount: 300 })], { yclients_record_id: 42 }));
    expect(payments.pay.mock.calls.at(-1)[2].transactionId).toBe(1500);
  });
});

describe('classify', () => {
  const J = (status, code, msg = 'x') => new m.JournalError(status, msg, code);
  test.each([
    [J(409, 'uncertain'), 'uncertain'],
    [J(409, 'busy'), 'retry'],
    [J(409, 'slot_taken'), 'fail'],
    [J(409, 'payment_pending'), 'retry'],
    [J(409, 'stale'), 'retry'],
    [J(503, 'invalid'), 'retry'],
    [J(502, 'invalid'), 'retry'],
    [J(409, undefined, 'Документ ещё не готов'), 'retry'],
    [J(409, 'rejected'), 'fail'],
    [J(409, 'payment_disabled'), 'fail'],
    [new Error('timeout'), 'retry'],
    [Object.assign(new Error('x'), { response: { status: 429 } }), 'retry'],
    [Object.assign(new Error('x'), { response: { status: 500 } }), 'retry'],
    [Object.assign(new Error('x'), { status: 503 }), 'retry'],
    [Object.assign(new Error('x'), { response: { status: 404 } }), 'fail'],
    [Object.assign(new Error('x'), { status: 400 }), 'fail'],
  ])('%#', (e, verdict) => expect(w.classify(e)).toBe(verdict));
});

describe('worker loop', () => {
  test('recoverRunning re-queues every running package', async () => {
    await w.recoverRunning();
    expect(writes[0].sql).toBe("UPDATE journal_outbox SET status='queued', updated_at=NOW() WHERE status='running'");
    expect(w.RECOVER_SQL).toBe(writes[0].sql);
  });

  test('LEASE_SQL: one running per salon, per-record order, skip locked', () => {
    expect(w.LEASE_SQL).toMatch(/p\.status='running'/);
    expect(w.LEASE_SQL).toMatch(/e\.id<o\.id/);
    expect(w.LEASE_SQL).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(w.LEASE_SQL).toMatch(/attempts=attempts\+1/);
    expect(w.DELAYS).toEqual([5, 30, 120, 600, 600]);
    expect(w.MAX_ATTEMPTS).toBe(6);
  });

  test('tick processes leased packages until none due, at most 20', async () => {
    let leased = 0;
    db.oneOrNone.mockImplementation(async sql => {
      if (/FROM salons/.test(sql)) return SALON;
      if (sql === w.LEASE_SQL) return leased++ < 3 ? pkg([step('confirm', 1, {}, { state: 'done' })], { id: 100 + leased }) : null;
      return null;
    });
    expect(await w.tick()).toBe(3);
    leased = -100;
    expect(await w.tick()).toBe(20);
  });

  test('overlapping tick is skipped', async () => {
    let release;
    db.query.mockImplementationOnce(() => new Promise(r => { release = r; }));
    const first = w.tick();
    expect(await w.tick()).toBe(0);
    release({ rowCount: 0 });
    await first;
  });
});

test('edit step persists the complete draft before mutation and replays it unchanged', async () => {
  const edit={attendance:1,lines:[{serviceId:7,quantity:1,unitPrice:100,total:100,mode:'total'}],version:'a'.repeat(64)};
  const row=pkg([step('edit',1,edit)],{yclients_record_id:42});
  await w.processPackage(row);
  // The services version was checked locally at save time; it is not resent.
  const {version:_v,servicesVersion:_sv,...sent}=edit;
  expect(calls[0][2]).toMatchObject({action:'edit',recordId:42,edit:sent});
  expect(calls[0][2].edit.version).toBeUndefined();
  const persisted=writes.find(x=>/SET steps=/.test(x.sql));
  expect(JSON.parse(stepsOf(persisted)[0].draftJson)).toEqual(calls[0][2]);
  expect(payments.pay).not.toHaveBeenCalled();
});

describe('manual dispatch (10.11.2026)', () => {
  test('LEASE_SQL takes only released packages; a change of an uncreated record waits for its id', () => {
    expect(w.LEASE_SQL).toMatch(/o\.released_at IS NOT NULL/);
    expect(w.LEASE_SQL).toMatch(/o\.create_outbox_id IS NULL OR o\.yclients_record_id IS NOT NULL/);
  });
  test('created record id is handed to changes queued for it', async () => {
    expect(await w.processPackage(pkg([step('create', 1, CREATE_PARAMS)]))).toBe('done');
    const adopt = writes.find(x => x.sql === w.ADOPT_SQL);
    expect(adopt.args).toEqual([11, 500]);
  });
  test('resumed package with a done create re-hands the id (crash after create)', async () => {
    await w.processPackage(pkg([step('create', 1, CREATE_PARAMS, { state: 'done', result: { recordId: 500 } })]));
    expect(writes.find(x => x.sql === w.ADOPT_SQL).args).toEqual([11, 500]);
    expect(index.mutate).not.toHaveBeenCalled();
  });
});
