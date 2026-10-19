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

describe('loadPeriod', () => {
  test('собирает записи с consumables/payments, товары, карты, правила, настройки, бюджет, аппараты, мощность', async () => {
    db.any.mockImplementation(async (sql, params) => {
      if (/FROM records r/.test(sql)) return [{ record_id: '1', visit_date: '2026-09-10', staff_yc_id: '5', staff_name: 'A', seance_length: 3600,
        services: [{ id: 10, cost_to_pay: 1000 }], bonus_redeemed: '100' }];
      if (/FROM goods_transactions t WHERE t.salon_id = \$1 AND t.type_id = 2/.test(sql)) { expect(params[1]).toEqual([1]); return [{ record_id: '1', service_id: '10', good_id: '7', amount: '-1', cost: '50' }]; }
      if (/FROM revenue_operations/.test(sql)) return [{ record_id: '1', amount: '1000', account_title: 'Расчетный счет' }];
      if (/FROM tech_cards/.test(sql)) return [{ id: 3, yc_card_id: '36', title: 'C', items: [{ good_id: 8, amount: 2 }], source: 'yclients' }];
      if (/FROM service_tech_cards/.test(sql)) return [{ service_yc_id: '10', staff_yc_id: null, tech_card_id: 3, source: 'learned' }];
      if (/type_id = 3/.test(sql)) { expect(new Set(params[1])).toEqual(new Set([7, 8])); return [{ good_id: '7', create_date: new Date('2026-09-01T10:00:00Z'), amount: '2', cost: '100', operation_unit_type: 1 }]; }
      if (/FROM yclients_goods_catalog/.test(sql)) return [{ good_id: '7', title: 'G', unit_equals: '1', unit_actual_cost: '45' }];
      if (/FROM goods_price_overrides/.test(sql)) return [{ good_id: '8', unit_price: '9' }];
      if (/FROM staff_pay_rules/.test(sql)) return [{ id: 1, percent: '30', base: 'gross', fixed_per_visit: '0', valid_from: null, valid_to: null, staff_yc_id: null, service_yc_id: null, category_yc_id: null }];
      if (/FROM fixed_costs/.test(sql)) return [{ id: 1, category: 'rent', amount_month: '1000', month_from: '2026-01-01', month_to: null }];
      if (/FROM equipment/.test(sql)) return [{ id: 1, name: 'L', purchase_price: '100', purchase_date: '2025-01-01', useful_life_months: 60, residual_pct: '0', maintenance_monthly: '0', service_ids: [10], is_active: true }];
      return [];
    });
    db.oneOrNone.mockImplementation(async (sql) => {
      if (/FROM economics_settings/.test(sql)) return { payroll_multiplier: '1.3', pay_base_includes_bonuses: false, allocation_driver: 'minutes', usn_rate: '15', acquiring: { 'Расчетный счет': 1.5 } };
      if (/FROM staff_schedule/.test(sql)) return { minutes: '58415' };
      return null;
    });
    const d = await store.loadPeriod(1, '2026-09-01', '2026-09-30');
    expect(d.records).toHaveLength(1);
    const r = d.records[0];
    expect(r.record_id).toBe(1); expect(r.staff_yc_id).toBe(5); expect(r.bonus_redeemed).toBe(100);
    expect(r.consumables).toEqual([{ good_id: 7, service_id: 10, amount: -1, cost: 50 }]);
    expect(r.payments).toEqual([{ amount: 1000, account_title: 'Расчетный счет' }]);
    expect(d.receiptsByGood.get(7)).toHaveLength(1);
    expect(d.catalogByGood.get(7).unit_actual_cost).toBe(45);
    expect(d.overridesByGood.get(8).unit_price).toBe(9);
    expect(d.cards.get(3).title).toBe('C');
    expect(d.links[0].service_yc_id).toBe(10);
    expect(d.payRules[0].percent).toBe(30);
    expect(d.settings.payroll_multiplier).toBe(1.3);
    expect(d.settings.acquiring).toEqual({ 'Расчетный счет': 1.5 });
    expect(d.fixedCosts[0].amount_month).toBe(1000);
    expect(d.equipment[0].service_ids).toEqual([10]);
    expect(d.capacityMinutes).toBe(58415);
    // Все запросы скоупятся салоном: первый параметр — salon_id.
    for (const [, params] of [...db.any.mock.calls, ...db.oneOrNone.mock.calls]) expect(params[0]).toBe(1);
  });
  test('пустой период и нет настроек → дефолты и пустые коллекции, без запросов по id', async () => {
    db.any.mockResolvedValue([]); db.oneOrNone.mockResolvedValue(null);
    const d = await store.loadPeriod(1, '2026-09-01', '2026-09-30');
    expect(d.records).toEqual([]);
    expect(d.settings).toEqual(store.DEFAULT_SETTINGS);
    expect(d.capacityMinutes).toBe(0);
    expect(db.any.mock.calls.some(([sql]) => /FROM revenue_operations|type_id = 3/.test(sql))).toBe(false);
  });
  test('normSettings: мусор → дефолты, acquiring не разделяется с DEFAULT_SETTINGS', () => {
    const s = store.normSettings({ payroll_multiplier: null, allocation_driver: 'x', usn_rate: '6', acquiring: null });
    expect(s).toEqual({ ...store.DEFAULT_SETTINGS, usn_rate: 6 });
    expect(s.acquiring).not.toBe(store.DEFAULT_SETTINGS.acquiring);
    expect(store.normSettings({ usn_rate: '0' }).usn_rate).toBe(0);
  });
});
