'use strict';
jest.mock('./db', () => ({ db: { oneOrNone: jest.fn(), any: jest.fn(), query: jest.fn() }, pool: {} }));
jest.mock('./services/journal/reference-cache', () => ({ getReference: jest.fn(), getBonusPercent: jest.fn(), learnBonusPercent: jest.fn() }));
const { db } = require('./db');
const reference = require('./services/journal/reference-cache');
const { localOptions, localPaymentOptions } = require('./services/journal/payments-local');

const ACCOUNTS = [
  { id: 10, title: 'Основная', type_slug: 'cash', is_acquiring: false },
  { id: 11, title: 'Терминал', type_slug: 'cashless', is_acquiring: false },
  { id: 12, title: 'Эквайринг', type_slug: 'cashless', is_acquiring: true },
];
const rec = (over = {}) => ({ services: [{ title: 'Чистка', amount: 1, cost: 20000 }, { title: 'Маска', amount: 2, cost: 10000 }], attendance: 1, client: { name: 'Анна' }, ...over });
const base = (over = {}) => ({ recordId: 5, record: rec(), ledger: [], queued: [], accounts: ACCOUNTS, card: null, bonusPercent: null, ...over });
const method = (r, kind) => r.methods.find(v => v.method === kind);

describe('localOptions', () => {
  test('bill and due', () => {
    const r = localOptions(base());
    expect(r.local).toBe(true);
    expect(r.items.map(i => [i.title, i.quantity, i.total])).toEqual([['Чистка', 1, 20000], ['Маска', 2, 10000]]);
    expect(r.due).toBe(30000);
    expect(r).toMatchObject({ recordId: 5, clientName: 'Анна', paid: [], pending: [], history: [], version: null });
  });
  test('confirmed payments count, later removes cancel them, pending/rejected ignored', () => {
    const ledger = [
      { state: 'confirmed', action: 'payment', method: 'account', method_id: '10', amount: '5000.00', external_ids: [101] },
      { state: 'confirmed', action: 'payment', method: 'account', method_id: '11', amount: '7000.00', external_ids: [102] },
      { state: 'confirmed', action: 'remove', method: 'account', method_id: '11', amount: '7000.00', external_ids: [102], target_transaction_id: 102 },
      { state: 'pending', action: 'payment', method: 'account', method_id: '10', amount: '1000', external_ids: [] },
      { state: 'rejected', action: 'payment', method: 'account', method_id: '10', amount: '1000', external_ids: [] },
    ];
    const r = localOptions(base({ ledger }));
    expect(r.paid).toEqual([{ id: 101, method: 'account', methodId: 10, amount: 5000, title: 'Наличные · Основная' }]);
    expect(r.due).toBe(25000);
  });
  test('bonus paid row titled Бонусы', () => {
    const r = localOptions(base({ ledger: [{ state: 'confirmed', action: 'payment', method: 'loyalty_card', method_id: 77, amount: 1000, external_ids: ['9'] }] }));
    expect(r.paid).toEqual([{ id: 9, method: 'loyalty_card', methodId: 77, amount: 1000, title: 'Бонусы' }]);
  });
  test('queued pays reduce due, queued removes increase it', () => {
    const ledger = [{ state: 'confirmed', action: 'payment', method: 'account', method_id: 10, amount: 10000, external_ids: [1] }];
    expect(localOptions(base({ ledger, queued: [{ kind: 'pay', method: 'account', methodId: 10, amount: 15000 }] })).due).toBe(5000);
    expect(localOptions(base({ ledger, queued: [{ kind: 'remove_payment', amount: 10000 }] })).due).toBe(30000);
    const full = localOptions(base({ queued: [{ kind: 'pay', method: 'account', methodId: 10, amount: 40000 }] }));
    expect(full.due).toBe(0);
    expect(method(full, 'account')).toMatchObject({ available: false, unavailableReason: 'Визит оплачен', limit: 0 });
  });
  test('acquiring accounts hidden; account methods shape', () => {
    const r = localOptions(base());
    expect(r.methods.map(v => v.id)).toEqual([10, 11]);
    expect(r.methods[0]).toEqual({ method: 'account', id: 10, title: 'Основная', cash: true, available: true, limit: 30000, requiresArrivalConfirmation: false, unavailableReason: null, balance: null });
    expect(r.methods[1].cash).toBe(false);
  });
  test('requiresArrivalConfirmation only when attendance 0', () => {
    expect(method(localOptions(base({ record: rec({ attendance: 0 }) })), 'account').requiresArrivalConfirmation).toBe(true);
    expect(method(localOptions(base({ record: rec({ attendance: 2 }) })), 'account').requiresArrivalConfirmation).toBe(false);
  });
  test('bonus limit = min(balance, due, percent cap)', () => {
    const card = { id: '77', balance: '5000' };
    expect(method(localOptions(base({ card, bonusPercent: 10 })), 'loyalty_card')).toEqual({ method: 'loyalty_card', id: 77, title: 'Бонусы', cash: false, available: true, limit: 3000, requiresArrivalConfirmation: false, unavailableReason: null, balance: 5000, balanceAfter: 5000 });
    const ledger = [{ state: 'confirmed', action: 'payment', method: 'loyalty_card', method_id: 77, amount: 1000, external_ids: [3] }];
    expect(method(localOptions(base({ card, bonusPercent: 10, ledger })), 'loyalty_card').limit).toBe(2000);
    const queued = [{ kind: 'pay', method: 'loyalty_card', methodId: 77, amount: 1000 }];
    expect(method(localOptions(base({ card, bonusPercent: 10, queued })), 'loyalty_card').limit).toBe(2000);
    expect(method(localOptions(base({ card })), 'loyalty_card').limit).toBe(5000);
    expect(method(localOptions(base({ card: { id: 77, balance: 50000 } })), 'loyalty_card').limit).toBe(30000);
    const none = method(localOptions(base({ card: { id: 77, balance: 0 } })), 'loyalty_card');
    expect(none).toMatchObject({ available: false, limit: 0, unavailableReason: 'Нет доступных бонусов', balance: 0 });
  });
  test('no card → no bonus method', () => {
    expect(method(localOptions(base()), 'loyalty_card')).toBeUndefined();
  });
  test('kopeck arithmetic', () => {
    const r = localOptions(base({ record: rec({ services: [{ title: 'a', amount: 1, cost: 0.1 }, { title: 'b', amount: 1, cost: 0.2 }] }), queued: [{ kind: 'pay', method: 'account', methodId: 10, amount: 0.3 }] }));
    expect(r.due).toBe(0);
  });
});

describe('breakdown (stage 1)', () => {
  const pkg = (over = {}) => ({ outboxId: 39, pkgStatus: 'queued', releasedAt: null, ...over });
  test('items: price x quantity, percent discount, kopeck math', () => {
    const r = localOptions(base({ record: rec({ services: [{ title: 'Маска', amount: 3, cost_per_unit: 333.33, first_cost: 999.99, discount: 10, cost: 899.99 }] }) }));
    expect(r.items).toEqual([{ title: 'Маска', quantity: 3, unitPrice: 333.33, gross: 999.99, discountPercent: 10, discount: 100, total: 899.99 }]);
    expect(r.summary).toMatchObject({ gross: 999.99, discount: 100, total: 899.99, due: 899.99 });
  });
  test('fallbacks: no first_cost uses price x amount; nothing uses total', () => {
    const r = localOptions(base({ record: rec({ services: [{ title: 'a', amount: 2, cost_per_unit: 50, cost: 90 }, { title: 'b', amount: 1, cost: 70 }] }) }));
    expect(r.items.map(i => [i.gross, i.discount, i.discountPercent, i.total])).toEqual([[100, 10, 10, 90], [70, 0, 0, 70]]);
    expect(r.summary).toMatchObject({ gross: 170, discount: 10, total: 160 });
  });
  test('queued pay steps are listed with statuses; paid stays confirmed-only', () => {
    const ledger = [{ state: 'confirmed', action: 'payment', method: 'account', method_id: 10, amount: 10000, external_ids: [1] }];
    const queued = [
      { kind: 'pay', method: 'loyalty_card', methodId: 77, amount: 6500, ...pkg() },
      { kind: 'pay', method: 'account', methodId: 11, amount: 5000, ...pkg({ outboxId: 40, releasedAt: '2026-11-12T10:00:00Z' }) },
      { kind: 'pay', method: 'account', methodId: 10, amount: 1000, ...pkg({ outboxId: 41, pkgStatus: 'failed' }) },
      { kind: 'remove_payment', method: 'account', methodId: 10, amount: 100, transactionId: 1, ...pkg({ outboxId: 42, pkgStatus: 'running' }) },
    ];
    const r = localOptions(base({ ledger, queued, card: { id: 77, balance: 10000 } }));
    expect(r.paid).toHaveLength(1);
    expect(r.payments.map(p => [p.kind, p.status, p.amount, p.title, p.outboxId])).toEqual([
      ['payment', 'confirmed', 10000, 'Наличные · Основная', null],
      ['payment', 'queued', 6500, 'Бонусы', 39],
      ['payment', 'sending', 5000, 'Банковская карта · Терминал', 40],
      ['payment', 'failed', 1000, 'Наличные · Основная', 41],
      ['remove_payment', 'sending', 100, 'Наличные · Основная', 42],
    ]);
    expect(r.summary).toMatchObject({ paidConfirmed: 10000, paidQueued: 12400, bonusSpent: 6500, due: 30000 - 10000 - 12400 });
    expect(method(r, 'loyalty_card')).toMatchObject({ balance: 10000, balanceAfter: 3500 });
  });
  test('balanceAfter ignores confirmed bonus (already in the card balance)', () => {
    const ledger = [{ state: 'confirmed', action: 'payment', method: 'loyalty_card', method_id: 77, amount: 1000, external_ids: [3] }];
    const r = localOptions(base({ ledger, card: { id: 77, balance: 4000 } }));
    expect(method(r, 'loyalty_card').balanceAfter).toBe(4000);
    expect(r.summary.bonusSpent).toBe(1000);
  });
  test('create draft (negative id): lines give price, discount, queued child pay is listed', async () => {
    jest.resetAllMocks(); reference.getReference.mockResolvedValue(ACCOUNTS); reference.getBonusPercent.mockResolvedValue(null);
    const create = { id: 36, status: 'queued', released_at: null, overlay: { kind: 'create', services: [{ id: 1, title: 'Маска', cost: 900 }], lines: [{ serviceId: 1, quantity: 3, unitPrice: 333.33, discount: 10, total: 899.99 }], client: {} }, steps: [{ kind: 'create', state: 'pending', params: {} }] };
    const child = { id: 39, status: 'queued', released_at: null, steps: [{ kind: 'pay', state: 'pending', params: { method: 'loyalty_card', methodId: 77, amount: 6.5 } }, { kind: 'pay', state: 'pending', params: { method: 'account', methodId: 11, amount: 58.5 } }] };
    db.oneOrNone.mockImplementation(async sql => /journal_outbox/.test(sql) ? create : null);
    db.any.mockResolvedValue([child]);
    const r = await localPaymentOptions(3, -36);
    expect(r.items[0]).toMatchObject({ quantity: 3, unitPrice: 333.33, gross: 999.99, discountPercent: 10, discount: 100, total: 899.99 });
    expect(r.payments.map(p => [p.status, p.amount, p.outboxId])).toEqual([['queued', 6.5, 39], ['queued', 58.5, 39]]);
  });
});

describe('localPaymentOptions', () => {
  beforeEach(() => { jest.resetAllMocks(); reference.getReference.mockResolvedValue(ACCOUNTS); reference.getBonusPercent.mockResolvedValue(10); });

  test('negative id uses the queued create package', async () => {
    db.oneOrNone.mockImplementation(async (sql) => {
      if (/journal_outbox/.test(sql)) return { id: 7, salon_id: 3, yclients_record_id: null, status: 'queued', overlay: { kind: 'create', services: [{ id: 1, title: 'Чистка', cost: 20000 }], client: { name: 'Анна', phone: '+7 (920) 000-11-22' }, attendance: 0 }, steps: [{ kind: 'create', state: 'pending', params: {} }, { kind: 'pay', state: 'pending', params: { method: 'account', methodId: 10, amount: 5000 } }] };
      if (/FROM clients/.test(sql)) return { yclients_card_id: '77', yclients_card_balance: '1000' };
      return null;
    });
    db.any.mockResolvedValue([]);
    const r = await localPaymentOptions(3, -7);
    expect(db.oneOrNone.mock.calls[0][1]).toEqual([3, 7]);
    expect(r).toMatchObject({ recordId: -7, clientName: 'Анна', due: 15000, items: [expect.objectContaining({ title: 'Чистка', quantity: 1, total: 20000 })] });
    expect(method(r, 'account').requiresArrivalConfirmation).toBe(true);
    expect(method(r, 'loyalty_card')).toMatchObject({ id: 77, limit: 1000 });
    const clientCall = db.oneOrNone.mock.calls.find(c => /FROM clients/.test(c[0]));
    expect(clientCall[1]).toEqual([3, '9200001122']);
  });
  test('negative id: overlay lines carry quantities', async () => {
    db.oneOrNone.mockImplementation(async sql => /journal_outbox/.test(sql) ? { id: 7, overlay: { kind: 'create', services: [{ id: 1, title: 'Маска', cost: 3000 }], lines: [{ serviceId: 1, quantity: 3, total: 3000 }], client: {} }, steps: [] } : null);
    db.any.mockResolvedValue([]);
    const r = await localPaymentOptions(3, -7);
    expect(r.items).toEqual([{ title: 'Маска', quantity: 3, unitPrice: 1000, gross: 3000, discountPercent: 0, discount: 0, total: 3000 }]);
  });
  test('negative id not a create package → 404', async () => {
    db.oneOrNone.mockResolvedValue({ id: 7, overlay: { kind: 'patch' }, steps: [] });
    await expect(localPaymentOptions(3, -7)).rejects.toMatchObject({ status: 404 });
    db.oneOrNone.mockResolvedValue(null);
    await expect(localPaymentOptions(3, -7)).rejects.toMatchObject({ status: 404 });
  });
  test('positive id missing in mirror → 404', async () => {
    db.oneOrNone.mockResolvedValue(null);
    await expect(localPaymentOptions(3, 5)).rejects.toMatchObject({ status: 404 });
  });
  test('positive id: mirror + ledger + open outbox steps + card', async () => {
    db.oneOrNone.mockImplementation(async sql => {
      if (/FROM records/.test(sql)) return { raw_payload: { ...rec(), client: { id: 55, name: 'Анна' } } };
      if (/FROM clients/.test(sql)) return { yclients_card_id: 77, yclients_card_balance: 5000 };
      return null;
    });
    db.any.mockImplementation(async sql => {
      if (/journal_financial_transactions/.test(sql)) return [{ state: 'confirmed', action: 'payment', method: 'account', method_id: 10, amount: 10000, external_ids: [1] }];
      if (/journal_outbox/.test(sql)) return [{ steps: [{ kind: 'pay', state: 'pending', params: { method: 'loyalty_card', methodId: 77, amount: 1000 } }, { kind: 'pay', state: 'done', params: { method: 'account', methodId: 10, amount: 999 } }, { kind: 'move', state: 'pending', params: {} }] }];
      return [];
    });
    const r = await localPaymentOptions(3, 5);
    expect(r.due).toBe(19000);
    expect(method(r, 'loyalty_card').limit).toBe(2000);
    const clientCall = db.oneOrNone.mock.calls.find(c => /FROM clients/.test(c[0]));
    expect(clientCall[1]).toEqual([3, 55]);
  });
});

test('a removed bonus does not hide a cash payment that happens to share its id', () => {
  const { localOptions } = require('./services/journal/payments-local');
  const r = localOptions({
    recordId: 8, record: { services: [{ title: 'S', amount: 1, cost: 100 }], attendance: 1, client: { name: 'N' } },
    ledger: [
      { state: 'confirmed', action: 'payment', method: 'account', method_id: 9, amount: 40, external_ids: [77] },
      { state: 'confirmed', action: 'payment', method: 'loyalty_card', method_id: 10, amount: 10, external_ids: [77] },
      { state: 'confirmed', action: 'remove', method: 'loyalty_card', method_id: 10, amount: 10, external_ids: [77], target_transaction_id: 77 },
    ],
    queued: [], accounts: [{ id: 9, title: 'Касса', type_slug: 'cash' }], card: null, bonusPercent: null,
  });
  expect(r.paid.map(p => [p.method, p.amount])).toEqual([['account', 40]]);
  expect(r.due).toBe(60);
});

test('positive id: open outbox overlay is applied to the mirror record', async () => {
  const { localPaymentOptions } = require('./services/journal/payments-local');
  jest.resetAllMocks();
  reference.getReference.mockResolvedValue(ACCOUNTS); reference.getBonusPercent.mockResolvedValue(null);
  db.oneOrNone.mockImplementation(async sql => /FROM records/.test(sql) ? { raw_payload: { ...rec(), id: 5, attendance: 0 } } : null);
  db.any.mockImplementation(async sql => /journal_outbox/.test(sql)
    ? [{ id: 9, status: 'queued', yclients_record_id: 5, overlay: { kind: 'patch', patch: { attendance: 2 } }, steps: [] }] : []);
  const r = await localPaymentOptions(3, 5);
  expect(method(r, 'account').requiresArrivalConfirmation).toBe(false);
  const call = db.any.mock.calls.find(c => /journal_outbox/.test(c[0]));
  expect(call[1]).toEqual([3, 5, ['queued', 'running', 'failed']]);
});

describe('localOptions: our bonus ledger balance (stage 3)', () => {
  test('ledger set: limit = min(ledger, due, cap); balance = ledger + visit queue; balanceAfter = ledger', () => {
    const queued = [{ kind: 'pay', method: 'loyalty_card', methodId: 77, amount: 1000 }];
    const m = method(localOptions(base({ card: { id: 77, balance: 99999, ledger: 4000 }, queued })), 'loyalty_card');
    expect(m).toMatchObject({ limit: 4000, balance: 5000, balanceAfter: 4000 });
    // due caps
    expect(method(localOptions(base({ card: { id: 77, balance: 0, ledger: 50000 } })), 'loyalty_card').limit).toBe(30000);
    // percent cap (10% of 30000 = 3000)
    expect(method(localOptions(base({ card: { id: 77, balance: 0, ledger: 50000 }, bonusPercent: 10 })), 'loyalty_card').limit).toBe(3000);
    // card reading is ignored for the limit when ledger is set
    expect(method(localOptions(base({ card: { id: 77, balance: 100, ledger: 2500 } })), 'loyalty_card').limit).toBe(2500);
  });
  test('ledger zero: no bonuses available', () => {
    const m = method(localOptions(base({ card: { id: 77, balance: 9000, ledger: 0 } })), 'loyalty_card');
    expect(m).toMatchObject({ available: false, limit: 0, unavailableReason: 'Нет доступных бонусов' });
  });
  test('ledger null: old behaviour unchanged', () => {
    const queued = [{ kind: 'pay', method: 'loyalty_card', methodId: 77, amount: 1000 }];
    const a = method(localOptions(base({ card: { id: 77, balance: 5000, ledger: null }, queued })), 'loyalty_card');
    const b = method(localOptions(base({ card: { id: 77, balance: 5000 }, queued })), 'loyalty_card');
    expect(a).toEqual(b);
    expect(a).toMatchObject({ balance: 5000, balanceAfter: 4000 });
  });
});
