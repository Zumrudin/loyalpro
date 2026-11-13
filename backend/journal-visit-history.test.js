'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'synthetic-test-secret' }));
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn() } }));
jest.mock('./services/yclients', () => ({ ycGetClientAbonements: jest.fn() }));
jest.mock('./services/journal/sources', () => ({ openOutbox: jest.fn(async () => []) }));
const { db } = require('./db');
const sources = require('./services/journal/sources');
const vh = require('./services/journal/visit-history');

const rec = (id, dt, services, over = {}) => ({ id, datetime: dt, staff_id: 5, staff: { name: 'Юлия' }, attendance: 1, services, client: { phone: '+79200255591' }, ...over });
const svc = (id, title, cost, amount = 1) => ({ id, title, cost, amount });
const op = over => ({ kind: 'visit_payment', method: 'card', amount: '0', status: 'confirmed', origin: 'yclients', yclients_record_id: null, outbox_id: null, occurred_at: new Date('2026-11-10T09:00:00Z'), ...over });

describe('build', () => {
  test('visits newest first; payments laid over lines; bonus and reversals counted', () => {
    const out = vh.build({ salonName: 'PERI', records: [
      rec(1, '2026-10-01T10:00:00+03:00', [svc(11, 'Чистка', 6500)]),
      rec(2, '2026-11-20T14:45:00+03:00', [svc(21, 'Био', 21000), svc(22, 'Миотокс', 370)], { attendance: 0 }),
    ], ops: [
      op({ yclients_record_id: 2, amount: '20000' }),
      op({ yclients_record_id: 2, kind: 'bonus_redemption', method: 'bonus', amount: '-1000' }),
      op({ yclients_record_id: 2, kind: 'payment_reversal', method: 'card', amount: '-500' }),
      op({ yclients_record_id: 1, amount: '6500' }),
    ], consumables: [] });
    expect(out.salonName).toBe('PERI');
    expect(out.entries.map(e => e.recordId)).toEqual([2, 1]);
    const [v2, v1] = out.entries;
    expect(v2).toMatchObject({ date: '2026-11-20', time: '14:45', attendance: 0, total: 21370, paid: 20500, staffName: 'Юлия' });
    expect(v2.services.map(s => s.paid)).toEqual([20500, 0]);
    expect(v1.services[0]).toMatchObject({ cost: 6500, paid: 6500 });
  });
  test('paid in full (bonuses, abonement): every line is paid', () => {
    const [e] = vh.build({ records: [rec(3, '2026-11-01T10:00:00+03:00', [svc(1, 'A', 100), svc(2, 'B', 200)], { paid_full: 1 })], ops: [], consumables: [] }).entries;
    expect(e.services.map(s => s.paid)).toEqual([100, 200]);
  });
  test('purchase made in a visit sits inside it; one without a visit is its own entry; title and quantity', () => {
    const out = vh.build({ records: [rec(4, '2026-11-05T12:00:00+03:00', [svc(1, 'Чистка', 3000)])], consumables: [], ops: [
      op({ kind: 'goods_sale', yclients_record_id: 4, amount: '7490', good_title: 'Сыворотка', qty: '-1.0000', unit_title: 'шт.' }),
      op({ kind: 'certificate_sale', amount: '20000', good_title: null, title: 'Продажа сертификатов', occurred_at: new Date('2026-11-11T11:51:00Z'), staff_yc_id: '7' }),
      op({ kind: 'abonement_sale', amount: '29000', good_title: 'RSL 6', occurred_at: new Date('2026-11-01T09:00:00Z') }),
    ] });
    expect(out.entries.map(e => [e.kind, e.date])).toEqual([['purchase', '2026-11-11'], ['visit', '2026-11-05'], ['purchase', '2026-11-01']]);
    expect(out.entries[1].purchases).toEqual([{ type: 'goods', title: 'Сыворотка', quantity: '1 шт.', amount: 7490, status: 'confirmed' }]);
    expect(out.entries[1].services[0].paid).toBe(0); // a goods sale does not pay the service
    expect(out.entries[0]).toMatchObject({ recordId: null, staffId: 7, time: '14:51', purchases: [{ type: 'certificate', title: 'Продажа сертификатов' }] });
  });
  test('an external payment twin of a journal payment is counted once', () => {
    const ops = [op({ yclients_record_id: 9, amount: '27000', origin: 'journal' }), op({ yclients_record_id: 9, amount: '27000', origin: 'yclients' }),
      op({ yclients_record_id: 9, kind: 'bonus_redemption', method: 'bonus', amount: '-3000', origin: 'journal' })];
    const [e] = vh.build({ records: [rec(9, '2026-11-16T16:45:00+03:00', [svc(1, 'ИМП', 30000)], { paid_full: 1 })], ops, consumables: [] }).entries;
    expect(e.paid).toBe(30000);
    expect(vh.dropUnlinkedTwins([op({ yclients_record_id: 9, amount: '100' }), op({ yclients_record_id: 9, amount: '100' })])).toHaveLength(2);
  });
  test('queued payment of a new record not sent yet (by package) and consumables per service', () => {
    const out = vh.build({ records: [rec(-36, '2026-11-12T17:00:00+03:00', [svc(1, 'ИМП', 30000)])],
      outboxOf: new Map([['40', '-36']]),
      ops: [op({ outbox_id: '40', amount: '30000', status: 'queued', origin: 'journal' })],
      consumables: [] });
    expect(out.entries[0]).toMatchObject({ recordId: -36, paid: 30000 });
    const [c] = vh.build({ records: [rec(5, '2026-11-01T10:00:00+03:00', [svc(77, 'Чистка', 100)])], ops: [],
      consumables: [{ record_id: '5', service_id: '77', good_title: 'Салфетки', amount: '-2.0000', unit_title: 'шт.', cost: '7.50' }] }).entries;
    expect(c.services[0].consumables).toEqual([{ title: 'Салфетки', quantity: '2 шт.', cost: 7.5 }]);
  });
});

describe('load', () => {
  beforeEach(() => jest.clearAllMocks());
  test('by phone: salon-scoped records, unsent new record of the same phone joins, foreign one does not', async () => {
    db.oneOrNone.mockImplementation(async sql => /FROM salons/.test(sql) ? { id: 3, name: 'PERI' } : null);
    db.any.mockImplementation(async (sql, args) => {
      if (/FROM records/.test(sql)) { expect(args).toEqual([3, '79200255591']); return [{ raw_payload: rec(8, '2026-11-01T10:00:00+03:00', [svc(1, 'A', 100)]) }]; }
      if (/FROM finance_operations/.test(sql)) { expect(args[0]).toBe(3); expect(args[2]).toEqual([8]); expect(args[3]).toEqual([40]); return []; }
      if (/FROM goods_transactions/.test(sql)) return [];
      return [];
    });
    const create = (id, phone) => ({ id, status: 'queued', released_at: null, yclients_record_id: null, overlay: { kind: 'create', date: '2026-11-20', time: '12:00', staffId: 5, duration: 60, services: [svc(1, 'A', 100)], client: { name: 'X', phone } }, steps: [] });
    sources.openOutbox.mockResolvedValue([create(40, '79200255591'), create(41, '79001112233')]);
    const out = await vh.load(3, { phone: '8 920 025-55-91' });
    expect(out.entries.map(e => e.recordId)).toEqual([-40, 8]);
  });
  test('SQL: records not deleted, ops only queued/sending/confirmed, consumables are write-offs', () => {
    expect(vh.RECORDS_BY_ID_SQL).toMatch(/salon_id=\$1 AND yclients_client_id=\$2/);
    expect(vh.RECORDS_BY_ID_SQL).toMatch(/<>'deleted'/);
    expect(vh.OPS_SQL).toMatch(/f\.salon_id=\$1 AND f\.status = ANY\(\$2::text\[\]\)/);
    expect(vh.CONSUMABLES_SQL).toMatch(/type_id=2 AND deleted_at IS NULL/);
  });
});
