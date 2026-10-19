'use strict';
const { pickRule, doctorPay, ruleRank } = require('./services/economics/pay-rules');

const R = (o) => ({ id: 1, staff_yc_id: null, service_yc_id: null, category_yc_id: null, percent: 30, base: 'gross', fixed_per_visit: 0, valid_from: null, valid_to: null, ...o });

describe('pickRule', () => {
  const rules = [
    R({ id: 1 }),                                             // салон по умолчанию
    R({ id: 2, staff_yc_id: 5 }),                             // сотрудник целиком
    R({ id: 3, category_yc_id: 100 }),                        // категория
    R({ id: 4, service_yc_id: 10 }),                          // услуга
    R({ id: 5, service_yc_id: 10, staff_yc_id: 5 }),          // услуга у сотрудника
    R({ id: 6, staff_yc_id: 5, valid_from: '2026-10-01', valid_to: '2026-10-31', percent: 50 }),
  ];
  const q = (o) => ({ staffId: 5, serviceId: 10, categoryId: 100, date: '2026-09-15', ...o });
  test('приоритет: услуга+сотрудник > услуга > категория > сотрудник > салон', () => {
    expect(pickRule(rules, q()).id).toBe(5);
    expect(pickRule(rules.filter(r => r.id !== 5), q()).id).toBe(4);
    expect(pickRule(rules.filter(r => ![4, 5].includes(r.id)), q()).id).toBe(3);
    expect(pickRule(rules.filter(r => ![3, 4, 5].includes(r.id)), q()).id).toBe(2);
    expect(pickRule(rules.filter(r => ![2, 3, 4, 5].includes(r.id)), q({ date: '2026-09-15' })).id).toBe(1);
  });
  test('период действия: вне окна правило не действует; внутри — позднейшее valid_from побеждает при равном ранге', () => {
    const only = rules.filter(r => [2, 6].includes(r.id));
    expect(pickRule(only, q({ serviceId: 99, categoryId: 99 })).id).toBe(2);
    expect(pickRule(only, q({ serviceId: 99, categoryId: 99, date: '2026-10-15' })).id).toBe(6);
    expect(pickRule(only, q({ serviceId: 99, categoryId: 99, date: '2026-11-01' })).id).toBe(2);
  });
  test('чужой сотрудник не подходит под staff-правило; нет правил → null', () => {
    expect(pickRule([R({ id: 2, staff_yc_id: 5 })], q({ staffId: 6 }))).toBeNull();
    expect(pickRule([], q())).toBeNull();
  });
  test('ruleRank экспортирован (для сортировки в UI)', () => {
    expect(ruleRank(R({ service_yc_id: 1, staff_yc_id: 1 }))).toBe(0);
    expect(ruleRank(R({}))).toBe(5);
  });
});

describe('doctorPay', () => {
  const settings = { payroll_multiplier: 1.3, pay_base_includes_bonuses: false };
  const row = { price: 10000, revenue: 9000, materials_used: 1000 };
  test('gross: от выручки; множитель ФОТ', () => {
    expect(doctorPay(row, R({ percent: 30 }), settings)).toEqual({ base: 9000, pay: 2700, cost: 3510, noRule: false });
  });
  test('net_of_materials: выручка − материалы; плюс фикс за визит', () => {
    expect(doctorPay(row, R({ percent: 40, base: 'net_of_materials', fixed_per_visit: 500 }), settings)).toEqual({ base: 8000, pay: 3700, cost: 4810, noRule: false });
  });
  test('pay_base_includes_bonuses → база price (до вычета бонусов)', () => {
    expect(doctorPay(row, R({ percent: 10 }), { ...settings, pay_base_includes_bonuses: true }).base).toBe(10000);
  });
  test('нет правила → 0 и noRule; отрицательная база → 0', () => {
    expect(doctorPay(row, null, settings)).toEqual({ base: 0, pay: 0, cost: 0, noRule: true });
    expect(doctorPay({ price: 100, revenue: 100, materials_used: 500 }, R({ percent: 50, base: 'net_of_materials' }), settings).pay).toBe(0);
  });
  test('битый множитель → 1', () => {
    expect(doctorPay(row, R({ percent: 10 }), { payroll_multiplier: null }).cost).toBe(900);
  });
});
