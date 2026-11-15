'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret' }));
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn() } }));
const audit = require('./services/journal/audit');
const history = require('./services/journal/history');

const before = {
  datetime: '2030-04-01T10:00:00+03:00', staff_id: 5, attendance: 0,
  seance_length: 3600, technical_break_duration: 0, notify_client: true,
  client: { name: 'Synthetic A' }, comment: 'Before', custom_color: '', record_labels: [],
  services: [{ id: 10, title: 'Synthetic service', amount: 1, cost_per_unit: 1000, first_cost: 1000, cost: 1000 }],
};
function row(session, overlay, extras = {}) {
  return { id: 1, user_id: 4, created_at: '2030-04-01T06:12:37Z', status: 'queued', steps: [],
    overlay: audit.attach(overlay, audit.build({ session, overlay, beforeRecord: before, ...extras }), { userId: 4, name: 'Synthetic operator' }) };
}
test('capture and reader preserve every editable field before any webhook exists', () => {
  const session = { edit: { attendance: 2, lines: [], comment: 'After', seanceLength: 30,
    client: { name: 'Synthetic B' }, customColor: '#112233', labelIds: [3], technicalBreak: 300, notifyClient: false } };
  const overlay = { kind: 'patch', patch: { attendance: 2, services: [{ id: 10, title: 'Synthetic service', amount: 2,
    cost_per_unit: 1000, first_cost: 2000, discount: 10, cost: 1800 }], comment: 'After', seance_length: 1800,
    client: { name: 'Synthetic B' }, custom_color: '112233', record_labels: [3], technical_break_duration: 300, notify_client: false } };
  const stored = row(session, overlay);
  const [event] = history.mergeHistory([], [stored]);
  expect(event.author).toBe('LoyalPro: Synthetic operator');
  expect(event.at).toBe('2030-04-01T06:12:37.000Z');
  const captured = stored.overlay.audit.events.flatMap(e => e.changes).map(c => c.field).sort();
  expect(event.changes.map(c => c.field).sort()).toEqual(captured);
  expect(event.changes).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'notify', from: 'включены', to: 'выключены' }),
    expect.objectContaining({ field: 'client', from: 'Synthetic A', to: 'Synthetic B' }),
  ]));
});
test('original payment detail survives removal of its queued step', () => {
  const stored = row({ payments: [{ method: 'account', methodId: 5, amount: 1250 }] }, { kind: 'patch', patch: {} });
  stored.status = 'cancelled';
  stored.steps = [];
  const events = history.mergeHistory([], [stored]);
  expect(events).toHaveLength(1);
  expect(JSON.stringify(events[0].changes).replace(/\s/g, '')).toContain('1250');
  expect(events[0].author).toBe('LoyalPro: Synthetic operator');
});
test('audit and worker payment provenance do not create duplicate payment events', () => {
  const op = '00000000-0000-4000-8000-000000000001';
  const stored = row({ payments: [{ method: 'loyalty_card', methodId: 5, amount: 200 }] }, { kind: 'patch', patch: {} });
  stored.steps = [{ opId: op, kind: 'pay', state: 'done' }]; stored.status = 'done';
  const ledger = { operation_id: op, action: 'payment', method: 'loyalty_card', amount: 200, state: 'confirmed', created_at: stored.created_at };
  const finance = { journal_operation_id: op, step_op_id: op, outbox_id: 1, kind: 'bonus_redemption', method: 'bonus', amount: -200, status: 'confirmed', occurred_at: stored.created_at };
  expect(history.mergeHistory([], [stored], new Map(), [], [ledger], [finance])).toHaveLength(1);
});
test('legacy direct payment and its finance mirror represent one operation', () => {
  const op = '00000000-0000-4000-8000-000000000002';
  const ledger = { operation_id: op, action: 'payment', method: 'account', amount: 500, state: 'confirmed', created_at: '2030-04-01T06:12:37Z' };
  const finance = { journal_operation_id: op, kind: 'visit_payment', method: 'cash', amount: 500, status: 'confirmed', occurred_at: ledger.created_at };
  expect(history.mergeHistory([], [], new Map(), [], [ledger], [finance])).toHaveLength(1);
});
test('a completed bonus step stays successful when the next cash step fails', () => {
  const steps = [
    { kind: 'pay', opId: 'bonus-step', state: 'done', params: { method: 'loyalty_card', methodId: 5, amount: 200 } },
    { kind: 'pay', opId: 'cash-step', state: 'failed', params: { method: 'account', methodId: 6, amount: 800 } },
  ];
  const stored = row({ payments: [steps[1].params, steps[0].params] }, { kind: 'patch', patch: {} }, { steps });
  stored.steps = steps; stored.status = 'failed'; stored.error_text = 'Synthetic failure';
  const events = history.mergeHistory([], [stored]);
  const bonus = events.find(e => e.changes.some(c => c.field === 'bonus_payment'));
  const cash = events.find(e => e.changes.some(c => c.field === 'payment'));
  expect(bonus.status).toBe('done');
  expect(bonus.error).toBeNull();
  expect(cash.status).toBe('failed');
  expect(cash.error).toBe('Synthetic failure');
});
test('old queued packages retain known payment amounts without a webhook or new audit', () => {
  const stored = { id: 10, user_id: 4, status: 'queued', created_at: '2030-04-01T06:12:37Z',
    steps: [{ kind: 'pay', opId: 'legacy-payment', state: 'pending', params: { method: 'account', methodId: 5, amount: 750 } }] };
  const events = history.mergeHistory([], [stored], new Map([[4, 'Synthetic operator']]));
  expect(JSON.stringify(events.flatMap(e => e.changes))).toContain('750');
  const mirrored = history.mergeHistory([], [stored], new Map(), [], [], [{ outbox_id: 10,
    step_op_id: 'legacy-payment', kind: 'visit_payment', method: 'cash', amount: 750, status: 'queued', occurred_at: stored.created_at }]);
  expect(mirrored.filter(e => e.changes.length)).toHaveLength(1);
});
test('an uncertain payment is not described as definitely failed or confirmed', () => {
  const steps = [{ kind: 'pay', opId: 'uncertain-step', state: 'uncertain', params: { method: 'account', methodId: 6, amount: 800 } }];
  const stored = row({ payments: [steps[0].params] }, { kind: 'patch', patch: {} }, { steps });
  stored.steps = steps; stored.status = 'failed'; stored.error_text = 'Требуется сверка';
  const [event] = history.mergeHistory([], [stored]);
  expect(event.status).toBe('uncertain');
  expect(event.title).toContain('результат не подтверждён');
  expect(event.error).toBe('Требуется сверка');
});
