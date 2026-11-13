'use strict';

// Exercise the real orchestration and HTTP adapter against an independent,
// synthetic YClients store. No request or database connection leaves this test.
// The store models what was observed live on 08–09.11.2026 (dev, company 668791):
// - POST /company/{cid}/sale/{doc}/payment creates the cash transaction and
//   returns it; if the visit is «Ожидание» (attendance 0) YClients re-saves the
//   record and deletes the transaction ~0.3 s later;
// - PUT /record with only {attendance} is rejected (422), the full record is accepted
//   and re-creates the visit's bonus write-offs under new IDs (871653710 → 871653865).
jest.mock('./config', () => ({
  JWT_SECRET: 'synthetic-contract-secret',
  JOURNAL_ACCOUNT_PAYMENTS_ENABLED: true,
  YC: 'https://yclients.invalid/api/v1',
}));
jest.mock('./logger', () => ({ createLogger: () => ({ warn: jest.fn() }) }));
jest.mock('./db', () => ({
  db: { oneOrNone: jest.fn(), any: jest.fn(), query: jest.fn() },
  pool: { connect: jest.fn() },
}));
jest.mock('./services/yclients', () => ({ ycGet: jest.fn(), ycHeaders: jest.fn(() => ({})) }));
jest.mock('axios', () => jest.fn());

const axios = require('axios');
const { db, pool } = require('./db');
const { ycGet } = require('./services/yclients');
const payments = require('./services/journal/payments');

const operationId = '12345678-1234-4123-8123-123456789012';
const nextOperationId = '12345678-1234-4123-8123-123456789013';
const clone = value => structuredClone(value);
let record, sale, ledger, events, conn, persistPayment, persistAttendance, revertArrival;
const bonusOperation = '12345678-1234-4123-8123-123456789014';

beforeEach(() => {
  jest.clearAllMocks();
  payments._setSettleMs(0);
  ledger = new Map();
  events = [];
  persistPayment = true;
  persistAttendance = true;
  revertArrival = false;
  record = {
    id: 8, company_id: 30, visit_id: 800, staff_id: 4,
    client: { id: 5, name: 'Synthetic client' },
    datetime: '2030-01-01T12:00:00+03:00', seance_length: 3600,
    attendance: 1, comment: '', deleted: false, activity_id: 0,
    services: [{
      id: 7, record_id: 8, title: 'Synthetic service', amount: 1,
      cost: 100, manual_cost: 100, cost_to_pay: 70,
      cost_per_unit: 100, first_cost: 100, discount: 0,
    }],
    goods_transactions: [], consumables: [],
    documents: [{ id: 80, type_id: 7, company_id: 30, record_id: 8, visit_id: 800 }],
  };
  sale = {
    state: {
      items: [{ id: 7, type: 'service', title: 'Synthetic service', amount: 1, cost_to_pay_total: 100 }],
      payment_transactions: [],
      loyalty_transactions: [{ id: 500, type_id: 3, loyalty_card_id: 10, amount: 30, document_id: 80 }],
    },
    payment_methods: [{
      slug: 'account', account_id: 9, is_applicable: true, applicable_amount: 70,
      account: { id: 9, title: 'Synthetic card account', is_cash: false },
    }],
  };

  db.oneOrNone.mockResolvedValue({ id: 3, yclients_company_id: 30 });
  db.any.mockResolvedValue([]);
  db.query.mockResolvedValue({ rows: [] });
  conn = { release: jest.fn(), query: jest.fn(async (sql, args = []) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('pg_advisory_unlock')) return { rows: [] };
    if (sql.startsWith('INSERT INTO journal_financial_transactions')) {
      events.push('pending');
      ledger.set(args[1], {
        salon_id: args[0], operation_id: args[1], user_id: args[2],
        yclients_company_id: args[3], yclients_record_id: args[4], document_id: args[5],
        method: args[6], method_id: args[7], amount: args[8], state: 'pending',
        request_hash: args[9], before_ids: JSON.parse(args[10]), quote: JSON.parse(args[11]),
        action: args[12], target_transaction_id: args[13], external_ids: [],
      });
      return { rows: [] };
    }
    if (sql.includes("SET state='confirmed'")) {
      events.push('confirmed');
      Object.assign(ledger.get(args[1]), { state: 'confirmed', external_ids: JSON.parse(args[2]) });
      return { rows: [] };
    }
    if (sql.includes('SET external_ids=$3')) {
      events.push('remap');
      ledger.get(args[1]).external_ids = JSON.parse(args[2]);
      return { rows: [] };
    }
    if (sql.includes("SET state='rejected'")) {
      ledger.get(args[1]).state = 'rejected';
      return { rows: [] };
    }
    if (sql.startsWith('SELECT * FROM journal_financial_transactions')) {
      const row = ledger.get(args[1]);
      return { rows: row && row.salon_id === args[0] ? [clone(row)] : [] };
    }
    if (sql.includes('FROM journal_operations')) return { rows: [] };
    if (sql.includes('FROM journal_financial_transactions')) {
      const rows = [...ledger.values()].filter(row => row.salon_id === args[0]
        && row.yclients_record_id === args[1] && row.yclients_company_id === args[2]);
      return { rows: clone(rows.filter(row => row.state === (sql.includes("state='pending'") ? 'pending' : 'confirmed'))) };
    }
    throw new Error('Unexpected synthetic database query');
  }) };
  pool.connect.mockResolvedValue(conn);

  ycGet.mockImplementation(async (salon, path) => {
    expect(salon.yclients_company_id).toBe(30);
    events.push('GET ' + path);
    if (path === '/record/30/8') return clone(record);
    if (path === '/company/30/sale/80') return clone(sale);
    throw new Error('Unexpected synthetic YClients read');
  });
  axios.mockImplementation(async request => {
    if (request.method === 'put' && request.url === 'https://yclients.invalid/api/v1/record/30/8') {
      events.push('PUT record');
      expect(ledger.get(operationId)).toBeUndefined();
      const { data } = request;
      if (!data.staff_id || !Array.isArray(data.services) || !data.client) {
        const error = new Error('Request failed with status code 422'); error.response = { status: 422 }; throw error;
      }
      if (persistAttendance) record.attendance = data.attendance;
      if (revertArrival) record.attendance = 0;
      sale.state.loyalty_transactions = sale.state.loyalty_transactions.map(t => ({ ...t, id: t.id + 1000 }));
      return { status: 200, data: { success: true, data: { id: 8 } } };
    }
    expect(request.method).toBe('post');
    expect(request.url).toBe('https://yclients.invalid/api/v1/company/30/sale/80/payment');
    events.push('POST payment');
    expect(ledger.get(operationId)?.state).toBe('pending');
    expect(request.data).toEqual({ payment: { method: { slug: 'account', account_id: 9 }, amount: 70 } });
    const response = clone(sale);
    if (persistPayment) response.state.payment_transactions.push({ id: 901, document_id: 80, record_id: 8, account_id: 9, amount: 70 });
    // A waiting visit keeps the payment only in this response: YClients deletes it right after.
    if (persistPayment && Number(record.attendance) !== 0) {
      sale = clone(response);
      sale.payment_methods[0].applicable_amount = 0;
      record.paid_full = 1; record.paid_amount = 70;
    }
    return { status: 201, data: { success: true, data: response } };
  });
});

async function draft(patch = {}) {
  const current = await payments.context(3, 8);
  return { operationId, recordId: 8, method: 'account', methodId: 9, amount: 70, version: current.version, ...patch };
}

test.each([1, 2])('card payment of a visit in attendance %i is one sale POST without re-sending the visit', async attendance => {
  record.attendance = attendance;
  const originalServices = clone(record.services);
  const originalBonus = clone(sale.state.loyalty_transactions);
  const input = await draft();

  await expect(payments.pay(3, 4, input)).resolves.toMatchObject({ confirmed: true, recordId: 8 });

  expect(axios).toHaveBeenCalledTimes(1);
  expect(record.attendance).toBe(attendance);
  expect(record.services).toEqual(originalServices);
  expect(sale.state.loyalty_transactions).toEqual(originalBonus);
  expect(ledger.get(operationId)).toMatchObject({ state: 'confirmed', external_ids: [901], amount: 70 });
  const writeIndex = events.indexOf('POST payment');
  expect(events.indexOf('pending')).toBeLessThan(writeIndex);
  expect(events.slice(writeIndex + 1)).toEqual(['GET /record/30/8', 'GET /company/30/sale/80', 'confirmed']);
  expect(ycGet).toHaveBeenCalledWith(expect.any(Object), '/record/30/8', { include_consumables: 1 });

  await expect(payments.pay(3, 4, input)).resolves.toMatchObject({ confirmed: true, duplicate: true });
  expect(axios).toHaveBeenCalledTimes(1);
});

test.each([undefined, false])('waiting visit without explicit arrival confirmation (%s) fails before intent or HTTP', async confirmArrival => {
  record.attendance = 0;
  await expect(payments.pay(3, 4, await draft({ confirmArrival }))).rejects.toMatchObject({ code: 'arrival_confirmation_required' });
  expect(record.attendance).toBe(0);
  expect(ledger.size).toBe(0);
  expect(axios).not.toHaveBeenCalled();
});

test('explicit arrival confirmation marks the visit arrived first, then pays with a sale POST', async () => {
  record.attendance = 0;
  const originalServices = clone(record.services);
  const originalBonus = clone(sale.state.loyalty_transactions);
  const input = await draft({ confirmArrival: true });

  await expect(payments.pay(3, 4, input)).resolves.toMatchObject({ confirmed: true, recordId: 8 });

  expect(axios).toHaveBeenCalledTimes(2);
  expect(axios.mock.calls[0][0].data).toMatchObject({ staff_id: 4, attendance: 1, services: originalServices, client: record.client, save_if_busy: false, send_sms: false });
  expect(record.attendance).toBe(1);
  expect(record.services).toEqual(originalServices);
  // Same bonus write-off, re-created by YClients under a new ID.
  expect(sale.state.loyalty_transactions.map(({ id, ...rest }) => rest)).toEqual(originalBonus.map(({ id, ...rest }) => rest));
  expect(ledger.get(operationId)).toMatchObject({ state: 'confirmed', external_ids: [901] });
  expect(events.indexOf('PUT record')).toBeLessThan(events.indexOf('pending'));
  expect(events.indexOf('pending')).toBeLessThan(events.indexOf('POST payment'));

  await expect(payments.pay(3, 4, input)).resolves.toMatchObject({ confirmed: true, duplicate: true });
  expect(axios).toHaveBeenCalledTimes(2);
});

test('a bonus paid in the journal before arrival keeps its receipt when YClients re-creates it', async () => {
  record.attendance = 0;
  ledger.set(bonusOperation, { salon_id: 3, operation_id: bonusOperation, yclients_company_id: 30, yclients_record_id: 8, document_id: 80,
    method: 'loyalty_card', method_id: 10, amount: 30, state: 'confirmed', action: 'payment', before_ids: [], external_ids: [500] });
  await expect(payments.pay(3, 4, await draft({ confirmArrival: true }))).resolves.toMatchObject({ confirmed: true });
  expect(sale.state.loyalty_transactions.map(t => t.id)).toEqual([1500]);
  expect(ledger.get(bonusOperation).external_ids).toEqual([1500]);
  expect(ledger.get(operationId)).toMatchObject({ state: 'confirmed', external_ids: [901] });
  // The payment form no longer reports the bonus as unverified.
  db.query.mockImplementation(async (sql, args) => (sql.includes('external_ids') ? conn.query(sql, args) : { rows: [] }));
  db.any.mockImplementation(async (sql, args) => (await conn.query(sql, args)).rows);
  const view = await payments.options(3, 8);
  expect(view.history.find(t => t.operation_id === bonusOperation)?.state).toBe('confirmed');
});

test('an arrival that YClients did not save stops before any payment intent', async () => {
  record.attendance = 0;
  persistAttendance = false;
  await expect(payments.pay(3, 4, await draft({ confirmArrival: true }))).rejects.toMatchObject({ code: 'stale' });
  expect(events).toContain('PUT record');
  expect(events).not.toContain('POST payment');
  expect(ledger.size).toBe(0);
});

test('the observed rollback (visit back in waiting, payment deleted after the response) stays pending', async () => {
  record.attendance = 0;
  const input = await draft({ confirmArrival: true });
  // Arrival is saved and verified, then something returns the visit to waiting before payment.
  const realGet = ycGet.getMockImplementation();
  let readsAfterArrival = 0;
  ycGet.mockImplementation(async (salon, path, params) => {
    if (events.includes('PUT record') && path === '/company/30/sale/80' && ++readsAfterArrival === 1) record.attendance = 0;
    return realGet(salon, path, params);
  });

  await expect(payments.pay(3, 4, input)).rejects.toMatchObject({ code: 'uncertain' });
  expect(events).toContain('POST payment');
  expect(sale.state.payment_transactions).toEqual([]);
  expect(ledger.get(operationId)).toMatchObject({ state: 'pending', external_ids: [] });
  expect(events).not.toContain('confirmed');
  await expect(payments.pay(3, 4, input)).rejects.toMatchObject({ code: 'uncertain' });
  await expect(payments.pay(3, 4, { ...input, operationId: nextOperationId })).rejects.toMatchObject({ code: 'blocked_pending' });
  expect(events.filter(e => e === 'POST payment')).toHaveLength(1);
});

test('a successful response without the cash transaction remains pending and blocks retries', async () => {
  persistPayment = false;
  const input = await draft();
  await expect(payments.pay(3, 4, input)).rejects.toMatchObject({ code: 'uncertain' });
  expect(ledger.get(operationId)).toMatchObject({ state: 'pending', external_ids: [] });
  await expect(payments.pay(3, 4, { ...input, operationId: nextOperationId })).rejects.toMatchObject({ code: 'blocked_pending' });
  expect(axios).toHaveBeenCalledTimes(1);
});

test.each(['goods', 'quantity'])('arrived visit with %s is paid without touching its contents', async kind => {
  if (kind === 'goods') record.goods_transactions = [{ id: 700, good_id: 70, amount: 1 }];
  if (kind === 'quantity') record.services[0].amount = 2;
  const before = clone(record);
  await expect(payments.pay(3, 4, await draft())).resolves.toMatchObject({ confirmed: true });
  expect(axios).toHaveBeenCalledTimes(1);
  expect(record.services).toEqual(before.services);
  expect(record.goods_transactions).toEqual(before.goods_transactions);
});

test.each(['goods', 'quantity'])('waiting visit with %s is not marked arrived automatically', async kind => {
  record.attendance = 0;
  if (kind === 'goods') record.goods_transactions = [{ id: 700, good_id: 70, amount: 1 }];
  if (kind === 'quantity') record.services[0].amount = 2;
  await expect(payments.pay(3, 4, await draft({ confirmArrival: true }))).rejects.toMatchObject({ code: 'payment_unsupported' });
  expect(ledger.size).toBe(0);
  expect(axios).not.toHaveBeenCalled();
});
