'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret' }));
const payment = require('./services/journal/visit-payment');

// visit-payment now only guards the arrival mark (PUT /record re-sends the
// record): which visits may be marked automatically, and a snapshot proving
// that nothing but attendance changed. Payments never re-send visit contents.
let record;
beforeEach(() => {
  record = {
    id: 8, company_id: 30, visit_id: 60, staff_id: 4, client: { id: 5 },
    datetime: '2030-04-01T10:00:00+03:00', seance_length: 3600, attendance: 0, comment: '', deleted: false,
    services: [
      { id: 7, title: 'Synthetic service', amount: 1, cost: 90, manual_cost: 90, cost_per_unit: 100, first_cost: 100, discount: 10, cost_to_pay: 60 },
      { id: 11, title: 'Synthetic second service', amount: 1, cost: 50, manual_cost: 50, cost_per_unit: 50, first_cost: 50, discount: 0, cost_to_pay: 50 },
    ],
    goods_transactions: [], resource_instance_ids: [16], technical_break_duration: 0,
    custom_fields: { synthetic: 'preserved' }, labels: [{ id: 2, title: 'Synthetic label' }],
    documents: [{ id: 80, type_id: 7, company_id: 30, record_id: 8, visit_id: 60 }],
  };
});

test('a simple waiting visit may be marked arrived automatically', () => {
  expect(payment.unavailableReason(record)).toBeNull();
});

test('numeric strings, lookup links, object key order and empty numeric comment normalize', () => {
  const current = structuredClone(record);
  for (const key of ['id', 'company_id', 'visit_id', 'staff_id', 'seance_length', 'attendance']) current[key] = String(current[key]);
  current.client = { id: '5', lookup: 'ignored' };
  current.resource_instance_ids = ['16'];
  current.services = current.services.reverse().map(service => ({
    company_service_link: { ignored: true }, ...Object.fromEntries(Object.entries(service).reverse().map(([key, value]) => [key, typeof value === 'number' ? String(value) : value])), staff_service_link: { ignored: true }, record_id: '8',
  }));
  current.comment = 0;
  current.deleted = '0';
  current.datetime = '2030-04-01 10:00:00';
  current.documents = current.documents.map(document => Object.fromEntries(Object.entries(document).map(([key, value]) => [key, String(value)])));
  expect(payment.snapshot(current)).toBe(payment.snapshot(record));
});

test('ISO offsets without a colon identify the same record time', () => {
  expect(payment.snapshot({ ...record, datetime: '2030-04-01T10:00:00+0300' })).toBe(payment.snapshot(record));
});

test.each([
  ['missing goods', value => { delete value.goods_transactions; }],
  ['goods', value => { value.goods_transactions = [{ id: 1 }]; }],
  ['consumables', value => { value.services[0].consumables = [{ id: 1 }]; }],
  ['quantity', value => { value.services[0].amount = 2; }],
  ['group', value => { value.activity_id = 99; }],
  ['numeric group flag', value => { value.is_group = 1; }],
  ['incomplete consumables', value => { value.consumables = {}; }],
  ['empty services', value => { value.services = []; }],
  ['missing service price', value => { delete value.services[0].cost_per_unit; }],
  ['different manual price', value => { value.services[0].manual_cost = 60; }],
  ['invalid discount', value => { value.services[0].discount = 101; }],
  ['duplicate services', value => { value.services[1].id = value.services[0].id; }],
  ['missing identity', value => { delete value.client; value.client_id = 'invalid'; }],
])('%s is not marked arrived automatically', (_, change) => {
  change(record);
  expect(payment.unavailableReason(record)).toEqual(expect.any(String));
});

test.each([
  ['service cost', current => { current.services[0].cost = 80; current.services[0].manual_cost = 80; }],
  ['attendance', current => { current.attendance = 2; }],
  ['comment', current => { current.comment = 'Synthetic changed'; }],
  ['client', current => { current.client.id = 6; }],
  ['staff', current => { current.staff_id = 6; }],
  ['datetime', current => { current.datetime = '2030-04-01T11:00:00+03:00'; }],
  ['duration', current => { current.seance_length = 1800; }],
  ['resources', current => { current.resource_instance_ids = [17]; }],
  ['custom fields', current => { current.custom_fields.synthetic = 'changed'; }],
  ['labels', current => { current.labels = []; }],
  ['technical break', current => { current.technical_break_duration = 600; }],
  ['goods', current => { current.goods_transactions = [{ id: 1 }]; }],
])('snapshot detects a changed %s', (_, change) => {
  const current = structuredClone(record);
  change(current);
  expect(payment.snapshot(current)).not.toBe(payment.snapshot(record));
});

test('payment flags and derived payable values do not change the protected booking', () => {
  const before = payment.snapshot(record);
  record.paid_full = 1; record.paid_amount = 110; record.last_change_date = '2030-04-01';
  record.services[0].cost_to_pay = 0;
  expect(payment.snapshot(record)).toBe(before);
});

test('incomplete service/document rows can be fingerprinted but are not marked arrived', () => {
  record.services = [null]; record.documents = [null];
  expect(() => payment.snapshot(record)).not.toThrow();
  expect(payment.unavailableReason(record)).toEqual(expect.any(String));
});
