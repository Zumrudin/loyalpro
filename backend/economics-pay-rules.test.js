'use strict';
const P = require('./services/economics/pay-rules');

const L = (o) => ({ percent: 30, base: 'gross', payroll_multiplier: null, fixed_per_visit: 0, categories: [], services: [], ...o });
const A = (o) => ({ id: 1, staff_yc_id: 5, scheme_id: 1, valid_from: null, valid_to: null, ...o });
const pay = (schemes, assignments) => ({ schemes, assignments });
const q = (o) => ({ staffId: 5, serviceId: 10, categoryId: 100, date: '2026-09-15', ...o });

describe('resolvePay: назначение', () => {
  const scheme = { id: 1, lines: [L({})] };
  test('нет назначения / чужой сотрудник / нет схемы → null', () => {
    expect(P.resolvePay(pay([scheme], []), q())).toBeNull();
    expect(P.resolvePay(pay([scheme], [A({ staff_yc_id: 6 })]), q())).toBeNull();
    expect(P.resolvePay(pay([], [A({})]), q())).toBeNull();
    expect(P.resolvePay(null, q())).toBeNull();
  });
  test('период назначения: вне окна null, границы включительно, NULL = бесконечность', () => {
    const a = A({ valid_from: '2026-09-01', valid_to: '2026-09-30' });
    expect(P.resolvePay(pay([scheme], [a]), q({ date: '2026-08-31' }))).toBeNull();
    expect(P.resolvePay(pay([scheme], [a]), q({ date: '2026-09-01' })).schemeId).toBe(1);
    expect(P.resolvePay(pay([scheme], [a]), q({ date: '2026-09-30' })).schemeId).toBe(1);
    expect(P.resolvePay(pay([scheme], [a]), q({ date: '2026-10-01' }))).toBeNull();
    expect(P.resolvePay(pay([scheme], [A({ valid_from: '2026-09-01' })]), q({ date: '2099-01-01' })).schemeId).toBe(1);
  });
  test('два действующих назначения → позднейшее valid_from, затем больший id', () => {
    const s2 = { id: 2, lines: [L({ percent: 50 })] };
    const both = [A({ id: 1, scheme_id: 1, valid_from: '2026-01-01' }), A({ id: 2, scheme_id: 2, valid_from: '2026-06-01' })];
    expect(P.resolvePay(pay([scheme, s2], both), q()).schemeId).toBe(2);
    const tie = [A({ id: 1, scheme_id: 1 }), A({ id: 2, scheme_id: 2 })];
    expect(P.resolvePay(pay([scheme, s2], tie), q()).schemeId).toBe(2);
  });
  test('schemes принимает и Map', () => {
    expect(P.resolvePay({ schemes: new Map([[1, scheme]]), assignments: [A({})] }, q()).lineIdx).toBe(0);
  });
  test('id сравниваются как строки (bigint из pg приходит строкой)', () => {
    expect(P.resolvePay(pay([{ id: '1', lines: [L({ services: ['10'] })] }], [A({ staff_yc_id: '5', scheme_id: '1' })]), q()).lineIdx).toBe(0);
  });
});

describe('resolvePay: приоритет линий', () => {
  const scheme = { id: 1, lines: [
    L({ percent: 10 }),                                  // 0: остальные
    L({ percent: 15, categories: [100] }),               // 1: категория
    L({ percent: 20, services: [10], base: 'net_of_materials' }), // 2: услуга
  ] };
  const r = (o) => P.resolvePay(pay([scheme], [A({})]), q(o));
  test('услуга прямо > её категория > остальные', () => {
    expect(r()).toMatchObject({ schemeId: 1, lineIdx: 2, line: { percent: 20, base: 'net_of_materials' } });
    expect(r({ serviceId: 11 })).toMatchObject({ lineIdx: 1 });
    expect(r({ serviceId: 11, categoryId: 999 })).toMatchObject({ lineIdx: 0 });
    expect(r({ serviceId: 11, categoryId: null })).toMatchObject({ lineIdx: 0 });
  });
  test('без линии «остальные» непокрытая услуга → null', () => {
    const s = { id: 1, lines: [L({ categories: [100] })] };
    expect(P.resolvePay(pay([s], [A({})]), q({ categoryId: 999 }))).toBeNull();
  });
  test('схема без линий → null', () => {
    expect(P.resolvePay(pay([{ id: 1, lines: [] }], [A({})]), q())).toBeNull();
    expect(P.resolvePay(pay([{ id: 1 }], [A({})]), q())).toBeNull();
  });
});

describe('doctorPay', () => {
  const settings = { payroll_multiplier: 1.3, pay_base_includes_bonuses: false };
  const row = { price: 10000, revenue: 9000, materials_used: 1000 };
  test('gross: от выручки; множитель салона', () => {
    expect(P.doctorPay(row, L({ percent: 30 }), settings)).toEqual({ base: 9000, pay: 2700, cost: 3510, noRule: false });
  });
  test('множитель линии главнее салона; 0/отрицательный/мусор → салонный', () => {
    expect(P.doctorPay(row, L({ percent: 10, payroll_multiplier: 1.494 }), settings).cost).toBeCloseTo(1344.6, 6);
    expect(P.doctorPay(row, L({ percent: 10, payroll_multiplier: 0 }), settings).cost).toBe(1170);
    expect(P.doctorPay(row, L({ percent: 10, payroll_multiplier: 'x' }), settings).cost).toBe(1170);
  });
  test('net_of_materials: выручка − материалы; плюс фикс за визит', () => {
    expect(P.doctorPay(row, L({ percent: 40, base: 'net_of_materials', fixed_per_visit: 500 }), settings)).toEqual({ base: 8000, pay: 3700, cost: 4810, noRule: false });
  });
  test('pay_base_includes_bonuses → база price', () => {
    expect(P.doctorPay(row, L({ percent: 10 }), { ...settings, pay_base_includes_bonuses: true }).base).toBe(10000);
  });
  test('нет линии → 0 и noRule; отрицательная база → 0', () => {
    expect(P.doctorPay(row, null, settings)).toEqual({ base: 0, pay: 0, cost: 0, noRule: true });
    expect(P.doctorPay({ price: 100, revenue: 100, materials_used: 500 }, L({ percent: 50, base: 'net_of_materials' }), settings).pay).toBe(0);
  });
  test('битый множитель салона и пустой у линии → 1', () => {
    expect(P.doctorPay(row, L({ percent: 10 }), { payroll_multiplier: null }).cost).toBe(900);
  });
});

describe('schemeLineConflicts', () => {
  test('пусто — нет конфликтов; услуга в двух линиях; категория в двух линиях', () => {
    expect(P.schemeLineConflicts([L({ services: [1] }), L({ categories: [1] })])).toEqual([]);
    expect(P.schemeLineConflicts([L({ services: [1, 2] }), L({ services: [2] })])).toEqual([{ kind: 'service', id: 2, lines: [0, 1] }]);
    expect(P.schemeLineConflicts([L({ categories: [7] }), L({}), L({ categories: ['7'] })])).toEqual([{ kind: 'category', id: 7, lines: [0, 2] }]);
  });
  test('повтор id внутри ОДНОЙ линии — не конфликт', () => {
    expect(P.schemeLineConflicts([L({ services: [1, 1] })])).toEqual([]);
  });
  test('две линии без целей — конфликт fallback', () => {
    expect(P.schemeLineConflicts([L({}), L({ services: [1] }), L({})])).toEqual([{ kind: 'fallback', id: null, lines: [0, 2] }]);
  });
  test('conflictText — текст на русском с номерами линий (1-based)', () => {
    expect(P.conflictText({ kind: 'service', id: 2, lines: [0, 1] })).toBe('Услуга #2 стоит в линиях 1 и 2 — оставьте её в одной');
    expect(P.conflictText({ kind: 'category', id: 7, lines: [0, 2] })).toBe('Категория #7 стоит в линиях 1 и 3 — оставьте её в одной');
    expect(P.conflictText({ kind: 'fallback', id: null, lines: [0, 2] })).toBe('Линия «остальные услуги» может быть только одна (линии 1 и 3)');
  });
  test('isFallbackLine', () => {
    expect(P.isFallbackLine(L({}))).toBe(true);
    expect(P.isFallbackLine(L({ services: [1] }))).toBe(false);
    expect(P.isFallbackLine({})).toBe(true);
  });
});

describe('assignmentsOverlap', () => {
  const ex = [
    A({ id: 1, staff_yc_id: 5, valid_from: '2026-01-01', valid_to: '2026-06-30' }),
    A({ id: 2, staff_yc_id: 5, valid_from: '2026-07-01', valid_to: null }),
    A({ id: 3, staff_yc_id: 6, valid_from: null, valid_to: null }),
  ];
  test('пересечение по датам, открытые границы — бесконечность; чужой сотрудник не считается', () => {
    expect(P.assignmentsOverlap(ex, { staff_yc_id: 5, valid_from: '2026-06-30', valid_to: '2026-07-01' }).map(a => a.id)).toEqual([1, 2]);
    expect(P.assignmentsOverlap(ex, { staff_yc_id: 5, valid_from: '2025-01-01', valid_to: '2025-12-31' })).toEqual([]);
    expect(P.assignmentsOverlap(ex, { staff_yc_id: 5, valid_from: null, valid_to: null }).map(a => a.id)).toEqual([1, 2]);
    expect(P.assignmentsOverlap(ex, { staff_yc_id: 7, valid_from: null, valid_to: null })).toEqual([]);
  });
  test('редактируемая строка исключается по id', () => {
    expect(P.assignmentsOverlap(ex, { id: 2, staff_yc_id: 5, valid_from: '2026-07-01', valid_to: null })).toEqual([]);
    expect(P.assignmentsOverlap(ex, { id: '2', staff_yc_id: '5', valid_from: '2026-06-01', valid_to: null }).map(a => a.id)).toEqual([1]);
  });
});
