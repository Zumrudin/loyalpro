'use strict';

jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret' }));
const audit = require('./services/journal/audit');

const base = {
  id: 42, datetime: '2030-04-01T10:00:00+03:00', staff_id: 5, staff: { id: 5, name: 'Анна' },
  seance_length: 3600, technical_break_duration: 0, attendance: 0, comment: '', deleted: false,
  client: { id: 8, name: 'Мария', phone: '79990000000' },
  services: [{ id: 900, title: 'Чистка', amount: 1, cost_per_unit: 3000, first_cost: 3000, discount: 0, cost: 3000 }],
};

test('create audit captures quantity, exact price and discount without phone', () => {
  const session = { create: { lines: [{ serviceId: 1, quantity: 2, unitPrice: 2000, gross: 4000, discount: 10, total: 3600 }] }, payments: [], removePayments: [] };
  const overlay = { kind: 'create', date: '2030-04-02', time: '09:30', staffId: 7, duration: 75,
    services: [{ id: 900, title: 'Массаж', amount: 2, cost_per_unit: 2000, first_cost: 4000, discount: 10, cost: 3600 }],
    client: { name: 'Ирина', phone: '79991112233' }, attendance: 0 };
  const out = audit.build({ session, overlay });
  const text = JSON.stringify(out);
  expect(text).toContain('скидка 10%');
  expect(text).toContain('3 600 ₽');
  expect(text).toContain('×2');
  expect(text).not.toContain('79991112233');
});

test('edit audit covers all parity fields, moved staff id and same-name client replacement safely', () => {
  const session = { move: { date: '2030-04-01', time: '11:00', staffId: 9 }, edit: { attendance: 2,
    lines: [{ serviceId: 900, quantity: 2, unitPrice: 2500, gross: 5000, discount: 20, total: 4000 }],
    comment: 'Новый', seanceLength: 90, technicalBreak: 600, client: { name: 'Мария', phone: '78880000000' },
    customColor: '#abcdef', labelIds: [3], notifyClient: false }, payments: [], removePayments: [] };
  const overlay = { kind: 'patch', patch: { datetime: '2030-04-01T11:00:00+03:00', staff_id: 9, attendance: 2,
    services: [{ id: 900, title: 'Чистка', amount: 2, cost_per_unit: 2500, first_cost: 5000, discount: 20, cost: 4000 }],
    comment: 'Новый', seance_length: 5400, technical_break_duration: 600,
    client: { name: 'Мария', phone: '78880000000' }, custom_color: 'abcdef', record_labels: [3], notify_client: false } };
  const out = audit.build({ session, overlay, beforeRecord: base });
  expect(out.events.map(e => e.action)).toEqual(['move', 'edit']);
  const changes = out.events.flatMap(e => e.changes);
  expect(changes).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'staff', from: 'Анна', to: '#9' }),
    expect.objectContaining({ field: 'discount', from: '0 ₽', to: '1 000 ₽' }),
    expect.objectContaining({ field: 'client', to: expect.stringContaining('карточка') }),
    expect.objectContaining({ field: 'notify', from: null, to: 'выключены' }),
  ]));
  expect(JSON.stringify(out)).not.toContain('78880000000');
});

test('payments, bonus spend, confirmed arrival, removal and queued drop are distinct events', () => {
  const session = { payments: [
    { method: 'account', methodId: 10, amount: 1500, confirmArrival: true },
    { method: 'loyalty_card', methodId: 88, amount: 500 },
  ], removePayments: [{ method: 'account', methodId: 10, amount: 300, transactionId: 71 }] };
  const overlay = { kind: 'patch', patch: { attendance: 1 } };
  const droppedPayments = [{ method: 'loyalty_card', methodId: 88, amount: 200, outboxId: 6, opId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }];
  const out = audit.build({ session, overlay, beforeRecord: base, droppedPayments, accounts: [{ id: 10, title: 'Основная' }] });
  expect(out.events.map(e => e.action)).toEqual(['edit', 'payment', 'payment', 'remove_payment', 'drop_payment']);
  expect(out.events[0].changes[0]).toMatchObject({ field: 'attendance', from: 'Ожидание', to: 'Пришёл' });
  expect(out.events[1].changes[0]).toMatchObject({ field: 'bonus_payment', label: 'Списание бонусов', to: '500 ₽' });
  expect(out.events[2].details).toMatchObject({ methodTitle: 'Основная', amount: 1500 });
  expect(out.events[4].details).toMatchObject({ outboxId: 6, amount: 200 });
});

test('actor snapshot is immutable audit metadata and contains no unrelated fields', () => {
  const overlay = audit.attach({ kind: 'patch', patch: { deleted: true } },
    audit.build({ session: { status: 'delete', payments: [], removePayments: [] }, overlay: { kind: 'patch', patch: { deleted: true } }, beforeRecord: base }),
    { userId: 4, name: 'Владелец' });
  expect(overlay.audit).toMatchObject({ version: 1, actor: { userId: 4, name: 'Владелец' }, events: [{ action: 'delete' }] });
  expect(overlay.audit.events[0].changes[0]).toMatchObject({ field: 'deleted', from: 'нет', to: 'да' });
});
