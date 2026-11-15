'use strict';
jest.mock('./db', () => ({ db: { oneOrNone: jest.fn() } }));

const { db } = require('./db');
const summary = require('./services/journal/day-summary');

beforeEach(() => jest.clearAllMocks());

test('record summary uses Moscow start date, unique raw client ids, line totals, and integer cents', () => {
  const records = [
    { datetime: '2030-04-01T09:00:00+03:00', attendance: 0, client: { id: 5 }, services: [{ cost: 0.1 }, { cost: 0.2 }] },
    { datetime: '2030-04-01T10:00:00+03:00', attendance: 1, client: { id: '5' }, services: [{ cost: 10, amount: 3 }] },
    { datetime: '2030-04-01T11:00:00+03:00', attendance: 2, client: { id: 6 }, services: [{ cost: 2 }] },
    { datetime: '2030-04-01T12:00:00+03:00', attendance: 0, client: {}, services: [{ cost: 1 }] },
    // Missing attendance is the same waiting-state default as normalizeRecord.
    { datetime: '2030-04-01T12:30:00+03:00', client: { id: '005' }, services: [{ cost: 0.7 }] },
    // Explicit malformed attendance is ignored rather than silently made waiting.
    { datetime: '2030-04-01T12:45:00+03:00', attendance: 'bad', client: { id: 11 }, services: [{ cost: 100 }] },
    // Invalid client ids do not inflate the client count; their valid booking value still counts.
    { datetime: '2030-04-01T12:50:00+03:00', attendance: 0, client: { id: 'unsafe' }, services: [{ cost: 0.4 }] },
    { datetime: '2030-04-01T13:00:00+03:00', attendance: -1, client: { id: 7 }, services: [{ cost: 100 }] },
    { datetime: '2030-04-01T14:00:00+03:00', attendance: 1, deleted: true, client: { id: 8 }, services: [{ cost: 100 }] },
    // Starts on the previous Moscow day: do not count it again as an overnight continuation.
    { datetime: '2030-03-31T23:30:00+03:00', seance_length: 7200, attendance: 1, client: { id: 9 }, services: [{ cost: 100 }] },
    // This UTC instant is already 2 April in Moscow.
    { datetime: '2030-04-01T21:30:00Z', attendance: 1, client: { id: 10 }, services: [{ cost: 100 }] },
  ];

  expect(summary.summarizeRecords(records, '2030-04-01')).toEqual({
    clientCount: 2,
    completedAmount: 10,
    bookedAmount: 14.4,
  });
  expect(summary.toCents(0.1) + summary.toCents(0.2)).toBe(30);
});

test('load overlays local create/edit data and returns the exact summary contract', async () => {
  db.oneOrNone.mockResolvedValue({
    total: '300.30', cash: '100.10', cashless_amount: '150.10', other_amount: '50.10',
    goods_amount: '75.55', loyalty_amount: '20.20', pending_count: '2',
    records: [
      // Mirrored outside the neighbour window in a real query, loaded because outbox targets it; moved into the day.
      { id: 8, datetime: '2030-03-01T09:00:00+03:00', attendance: 0,
        client: { id: 5 }, services: [{ id: 1, cost: 100 }] },
      // Starts on the day but an open patch moves it out.
      { id: 9, datetime: '2030-04-01T10:00:00+03:00', attendance: 0,
        client: { id: 7 }, services: [{ id: 1, cost: 50 }] },
      // Open delete removes it from the day summary.
      { id: 10, datetime: '2030-04-01T10:30:00+03:00', attendance: 1,
        client: { id: 8 }, services: [{ id: 1, cost: 70 }] },
      // A recent done create and its mirrored record must remain one record.
      { id: 12, datetime: '2030-04-01T12:00:00+03:00', attendance: 0,
        client: { id: 12 }, services: [{ id: 4, cost: 5 }] },
    ],
    outbox: [
      { id: 10, status: 'queued', yclients_record_id: 8,
        overlay: { kind: 'patch', patch: { datetime: '2030-04-01T09:00:00+03:00', attendance: 1, services: [{ id: 1, cost: 120 }] } } },
      { id: 11, status: 'queued', yclients_record_id: 9,
        overlay: { kind: 'patch', patch: { datetime: '2030-04-02T10:00:00+03:00' } } },
      { id: 12, status: 'queued', yclients_record_id: 10,
        overlay: { kind: 'patch', patch: { deleted: true } } },
      { id: 13, status: 'done', updated_at: new Date().toISOString(), yclients_record_id: 12,
        overlay: { kind: 'create', date: '2030-04-01', time: '12:00', duration: 30, staffId: 2,
          attendance: 0, client: { id: 12 }, services: [{ id: 4, cost: 5 }] } },
      { id: 14, status: 'queued', yclients_record_id: null,
        overlay: { kind: 'create', date: '2030-04-01', time: '11:00', duration: 30, staffId: 2,
          attendance: 0, client: { id: 6 }, services: [{ id: 2, cost: 0.1 }, { id: 3, cost: 0.2 }] } },
    ],
  });

  await expect(summary.load(7, '2030-04-01')).resolves.toEqual({
    date: '2030-04-01', clientCount: 3,
    total: 300.3, cash: 100.1, cashless: 150.1, otherAmount: 50.1,
    completedAmount: 120, bookedAmount: 125.3,
    loyaltyAmount: 20.2, goodsAmount: 75.55, pendingCount: 2,
  });
  expect(db.oneOrNone).toHaveBeenCalledWith(summary.SUMMARY_SQL, [7, '2030-04-01']);
});

test('single read-only query scopes finance, records, and outbox by salon and date', async () => {
  db.oneOrNone.mockResolvedValue({});
  await summary.load(19, '2030-04-01');
  expect(db.oneOrNone).toHaveBeenCalledTimes(1);
  expect(summary.SUMMARY_SQL).toMatch(/FROM finance_operations WHERE salon_id=\$1 AND op_date=\$2::date/);
  expect(summary.SUMMARY_SQL).toMatch(/FROM records r WHERE salon_id=\$1[\s\S]*visit_date BETWEEN \$2::date - 1 AND \$2::date \+ 1/);
  expect(summary.SUMMARY_SQL).toMatch(/yclients_record_id IN \(SELECT yclients_record_id FROM open_outbox/);
  expect(summary.SUMMARY_SQL).toMatch(/SELECT \* FROM journal_outbox WHERE salon_id=\$1/);
  expect(summary.SUMMARY_SQL).toMatch(/status='confirmed'/);
  expect(summary.SUMMARY_SQL).toMatch(/kind='goods_sale' AND method<>'bonus'/);
  expect(summary.SUMMARY_SQL).toMatch(/status IN \('queued','sending'\)/);
  expect(summary.SUMMARY_SQL).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
});

test('invalid date is rejected before any database read', async () => {
  await expect(summary.load(7, '2030-02-30')).rejects.toMatchObject({ status: 400 });
  expect(db.oneOrNone).not.toHaveBeenCalled();
});
