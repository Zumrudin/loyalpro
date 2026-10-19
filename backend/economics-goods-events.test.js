'use strict';
const { parseGoodsOperation, parseTransaction, GOODS_RESOURCES } = require('./services/economics/goods-events');

const CONSUMABLE = {
  resource: 'goods_operations_consumable', status: 'create', company_id: 668791, resource_id: 1926952027,
  data: {
    id: 1926952027, cost: 6800, good: { id: 20999974, title: 'Meso-Wharton P199' }, type: 'Списание расходников',
    unit: { id: 216760, title: 'Штука', short_title: 'шт.' }, amount: -1,
    client: { id: 143396511, name: 'Мамедова Айнура', phone: '79850306156' }, master: [], comment: '',
    service: { id: 9536494, title: 'MesoWharton 1,5 ml ( 60 минут)' }, storage: { id: 1334902, title: 'Расходники' },
    type_id: 2, discount: 0, supplier: [], record_id: 2037605603, create_date: '2026-10-18T12:30:00+0400',
    document_id: 2320695578, cost_per_unit: 6800, last_change_date: '2026-10-18T22:36:55+04:00', operation_unit_type: 2,
  },
};

describe('parseGoodsOperation', () => {
  test('списание: все поля, record/service, PII вырезан, дата нормализована', () => {
    const r = parseGoodsOperation(CONSUMABLE);
    expect(r.resource).toBe('goods_operations_consumable');
    expect(r.status).toBe('create');
    const row = r.row;
    expect(row.yclients_txn_id).toBe(1926952027);
    expect(row.type_id).toBe(2);
    expect(row.good_id).toBe(20999974);
    expect(row.good_title).toBe('Meso-Wharton P199');
    expect(row.unit_title).toBe('шт.');
    expect(row.amount).toBe(-1);
    expect(row.cost_per_unit).toBe(6800);
    expect(row.cost).toBe(6800);
    expect(row.record_id).toBe(2037605603);
    expect(row.service_id).toBe(9536494);
    expect(row.master_id).toBeNull();
    expect(row.supplier_title).toBeNull();
    expect(row.operation_unit_type).toBe(2);
    expect(row.create_date).toBe('2026-10-18T08:30:00.000Z');
    expect(row.raw.client).toBeUndefined();
    expect(row.raw.good.title).toBe('Meso-Wharton P199');
  });

  test('приход: record_id 0 → null, service [] → null, числа из API-строк', () => {
    const r = parseGoodsOperation({
      resource: 'goods_operations_receipt', status: 'update',
      data: { id: '1927251299', cost: '12180', good: { id: '20933400', title: 'Шприц' }, unit: { id: '216764', title: 'Упаковка' },
        amount: '3', client: [], master: { id: '112233445', title: 'Василий' }, service: [], storage: { id: 1334902, title: 'Расходники' },
        type_id: 3, discount: '5.00', supplier: { id: '11112222', title: 'Поставщик' }, record_id: 0,
        create_date: '2026-10-18T16:10:00+0400', document_id: 2336035170, cost_per_unit: '4060', operation_unit_type: 1 },
    });
    expect(r.status).toBe('update');
    expect(r.row.yclients_txn_id).toBe(1927251299);
    expect(r.row.record_id).toBeNull();
    expect(r.row.service_id).toBeNull();
    expect(r.row.master_id).toBe(112233445);
    expect(r.row.supplier_title).toBe('Поставщик');
    expect(r.row.unit_title).toBe('Упаковка');
    expect(r.row.amount).toBe(3);
    expect(r.row.cost).toBe(12180);
    expect(r.row.discount).toBe(5);
  });

  test('delete-статус проходит, неизвестный ресурс/статус/битые данные → null', () => {
    expect(parseGoodsOperation({ ...CONSUMABLE, status: 'delete' }).status).toBe('delete');
    expect(parseGoodsOperation({ ...CONSUMABLE, resource: 'record' })).toBeNull();
    expect(parseGoodsOperation({ ...CONSUMABLE, status: 'archive' })).toBeNull();
    expect(parseGoodsOperation({ ...CONSUMABLE, data: null })).toBeNull();
    expect(parseGoodsOperation({ ...CONSUMABLE, data: { ...CONSUMABLE.data, id: 'abc' } })).toBeNull();
    expect(parseGoodsOperation({ ...CONSUMABLE, data: { ...CONSUMABLE.data, amount: null } })).toBeNull();
    expect(parseGoodsOperation(null)).toBeNull();
  });

  test('parseTransaction применим к строке /storages/transactions напрямую', () => {
    const row = parseTransaction({ id: 1, amount: '-0.25', type_id: 2, good: { id: 5, title: 'X' }, record_id: 7, create_date: '2012-12-21T19:08:00+0400', cost: '0.00', cost_per_unit: '1.07' });
    expect(row.amount).toBe(-0.25);
    expect(row.record_id).toBe(7);
    expect(row.cost_per_unit).toBe(1.07);
  });

  test('GOODS_RESOURCES — четыре ресурса', () => {
    expect([...GOODS_RESOURCES].sort()).toEqual(['goods_operations_consumable', 'goods_operations_receipt', 'goods_operations_sale', 'goods_operations_stolen']);
  });
});
