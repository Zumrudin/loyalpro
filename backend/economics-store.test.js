'use strict';
jest.mock('./db', () => ({ db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn(), any: jest.fn() }, pool: {} }));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));
const { db } = require('./db');
const store = require('./services/economics/store');

const ROW = {
  yclients_txn_id: 10, document_id: 20, type_id: 3, type_title: 'Приход товара', good_id: 7, good_title: 'Шприц',
  storage_id: 1, unit_title: 'уп.', operation_unit_type: 1, amount: 3, cost_per_unit: 4060, cost: 12180, discount: 0,
  record_id: null, service_id: null, service_title: null, master_id: null, supplier_title: null,
  create_date: '2026-10-18T12:10:00.000Z', last_change_date: null, raw: { id: 10 },
};

beforeEach(() => { jest.clearAllMocks(); db.query.mockResolvedValue({ rows: [], rowCount: 1 }); db.any.mockResolvedValue([]); db.oneOrNone.mockResolvedValue(null); });

describe('upsertGoodsTransaction', () => {
  test('create/update: INSERT … ON CONFLICT, deleted_at NULL, source из опций', async () => {
    await store.upsertGoodsTransaction(1, ROW, { status: 'update', source: 'webhook' });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO goods_transactions/);
    expect(sql).toMatch(/ON CONFLICT \(salon_id, yclients_txn_id\) DO UPDATE/);
    expect(params[0]).toBe(1);
    expect(params[1]).toBe(10);
    expect(params[params.length - 2]).toBe('webhook');
    expect(params[params.length - 1]).toBeNull();      // deleted_at
  });
  test('delete: deleted_at = NOW() (строка не удаляется)', async () => {
    await store.upsertGoodsTransaction(1, ROW, { status: 'delete', source: 'webhook' });
    const [sql] = db.query.mock.calls[0];
    expect(sql).toMatch(/deleted_at\s*=\s*COALESCE\(\$\d+::timestamptz, NOW\(\)\)/);
  });
});

describe('refreshLastReceipt', () => {
  test('последнее поступление ≤ сегодня → цена за единицу списания с учётом unit_equals', async () => {
    db.oneOrNone
      .mockResolvedValueOnce({ unit_equals: '10' })                                             // каталог
      .mockResolvedValueOnce({ create_date: '2026-10-18T12:10:00.000Z', amount: '3', cost: '12180', operation_unit_type: 1 }); // приход
    await store.refreshLastReceipt(1, 7);
    const upd = db.query.mock.calls.find(c => /UPDATE yclients_goods_catalog/.test(c[0]));
    expect(upd[1]).toEqual([1, 7, 406, '2026-10-18T12:10:00.000Z']); // 12180/3/10
  });
  test('приходов нет → цена и дата сбрасываются в NULL', async () => {
    db.oneOrNone.mockResolvedValueOnce({ unit_equals: null }).mockResolvedValueOnce(null);
    await store.refreshLastReceipt(1, 7);
    const upd = db.query.mock.calls.find(c => /UPDATE yclients_goods_catalog/.test(c[0]));
    expect(upd[1]).toEqual([1, 7, null, null]);
  });
});

describe('техкарты', () => {
  test('upsertTechCard: UPSERT по (salon_id, yc_card_id), items jsonb, возвращает id', async () => {
    db.oneOrNone.mockResolvedValueOnce({ id: 11 });
    const id = await store.upsertTechCard(1, { yc_card_id: 5, title: 'A', items: [{ good_id: 1, amount: 2 }] });
    expect(id).toBe(11);
    const [sql, params] = db.oneOrNone.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(salon_id, yc_card_id\) WHERE yc_card_id IS NOT NULL DO UPDATE/);
    expect(params).toEqual([1, 5, 'A', JSON.stringify([{ good_id: 1, amount: 2 }])]);
  });
  test('upsertTechCard: нет строки → null', async () => {
    expect(await store.upsertTechCard(1, { yc_card_id: 5, title: 'A', items: [] })).toBeNull();
  });
  test('upsertServiceTechCard: младший источник не перетирает старший (manual > lookup > learned)', async () => {
    await store.upsertServiceTechCard(1, { serviceYcId: 10, techCardId: 3, source: 'learned' });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(salon_id, service_yc_id, COALESCE\(staff_yc_id, 0\)\) DO UPDATE/);
    expect(sql).toMatch(/WHERE \(CASE service_tech_cards\.source WHEN 'manual' THEN 0 WHEN 'lookup' THEN 1 ELSE 2 END\)\s*>=\s*\(CASE EXCLUDED\.source WHEN 'manual' THEN 0 WHEN 'lookup' THEN 1 ELSE 2 END\)/);
    expect(params).toEqual([1, 10, null, 3, 'learned']);
  });
  test('upsertServiceTechCard: неизвестный источник отвергается', async () => {
    await expect(store.upsertServiceTechCard(1, { serviceYcId: 10, techCardId: 3, source: 'yclients' })).rejects.toThrow(/source/);
    expect(db.query).not.toHaveBeenCalled();
  });
  test('listTechCardIdsByYc → Map по строковому yc_card_id', async () => {
    db.any.mockResolvedValueOnce([{ id: 11, yc_card_id: '36069' }]);
    const m = await store.listTechCardIdsByYc(1);
    expect(m.get('36069')).toBe(11);
    expect(db.any.mock.calls[0][1]).toEqual([1]);
  });
  test('listRecordsToLearn: состоявшиеся записи дня со списаниями и непривязанной услугой', async () => {
    await store.listRecordsToLearn(1, '2026-10-17', 15);
    const [sql, params] = db.any.mock.calls[0];
    expect(sql).toBe(store.RECORDS_TO_LEARN_SQL);
    expect(sql).toMatch(/r\.visit_date = \$2::date/);
    expect(sql).toMatch(/t\.type_id = 2 AND t\.deleted_at IS NULL/);
    expect(params).toEqual([1, '2026-10-17', 15]);
  });
});
