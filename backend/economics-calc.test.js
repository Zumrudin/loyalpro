'use strict';
const C = require('./services/economics/calc');

// Визит 2049113510 (прод, 18.10.2026): Belotero 22 500 + ботулинотерапия 5 000, seance 3600 с.
// Списания — только по Belotero (service 9536380) + одно без service_id (перчатки).
const RECORD = {
  record_id: 2049113510, visit_date: '2026-10-18', staff_yc_id: 1910274, staff_name: 'Гаджиева Пери', seance_length: 3600,
  services: [
    { id: 9536380, title: 'Belotero lips contur 0,6 ml', cost_to_pay: 22500, first_cost: 22500 },
    { id: 25013124, title: 'Ботулинотерапия-Круговая мышца рта', cost_to_pay: 5000, first_cost: 5000 },
  ],
  consumables: [
    { good_id: 1, service_id: 9536380, amount: -1, cost: 5267 },      // Belotero
    { good_id: 2, service_id: 9536380, amount: -15, cost: 117 },      // анестезия 15 мг × 7.8
    { good_id: 3, service_id: 9536380, amount: -1, cost: 2 },         // маска
    { good_id: 4, service_id: null, amount: -1, cost: 1.99 },         // перчатки — без услуги
  ],
  bonus_redeemed: 1000,
  payments: [{ amount: 27500, account_title: 'Расчетный счет' }],
};
const PRICES = { 1: 5267, 2: 7.8, 3: 2, 4: 1.99, 5: 0 };
const ctx = () => ({
  durations: new Map(), categories: new Map([['25013124', 100]]),
  priceFn: (goodId) => ({ price: PRICES[goodId] ?? 0, source: PRICES[goodId] ? 'receipt' : 'none' }),
  techCardFor: () => null,
  payRules: [{ id: 1, staff_yc_id: null, service_yc_id: null, category_yc_id: null, percent: 30, base: 'gross', fixed_per_visit: 0, valid_from: null, valid_to: null }],
  settings: { payroll_multiplier: 1.3, pay_base_includes_bonuses: false, acquiring: { 'Расчетный счет': 1.5 } },
});

describe('buildRows + finalizeRows на визите 2049113510', () => {
  const rows = C.buildRows(RECORD, ctx());
  C.finalizeRows(rows, { avgAcquiringRate: 0 });
  const [bel, btx] = rows;
  test('две строки, минуты поровну (длительностей нет), бонусы и перчатки по доле цены', () => {
    expect(rows).toHaveLength(2);
    expect(bel.minutes).toBe(30); expect(btx.minutes).toBe(30);
    expect(bel.bonus_redeemed).toBeCloseTo(818.18, 2); expect(btx.bonus_redeemed).toBeCloseTo(181.82, 2);
    expect(bel.revenue).toBe(22500); expect(btx.revenue).toBe(5000);
    expect(bel.discount).toBe(0);
  });
  test('материалы: факт по услуге + доля записи; у второй услуги только доля записи, но это факт (списания по записи есть)', () => {
    expect(bel.materials_fact).toBeCloseTo(5386 + 1.63, 2);
    expect(bel.materials_yc_cost).toBeCloseTo(5386 + 1.63, 2);
    expect(btx.materials_fact).toBeCloseTo(0.36, 2);
    expect(bel.materials_used).toBeCloseTo(5387.63, 2);
    expect(bel.materials_estimated).toBe(false);
    expect(btx.no_materials_data).toBe(false);
    expect(bel.has_consumables).toBe(true);
  });
  test('оплата врача 30 % gross × 1.3; категория берётся из ctx', () => {
    expect(bel.doctor_pay).toBeCloseTo(6750, 2);
    expect(bel.doctor_cost).toBeCloseTo(8775, 2);
    expect(btx.doctor_cost).toBeCloseTo(1950, 2);
    expect(bel.no_pay_rule).toBe(false);
    expect(btx.category_yc_id).toBe(100);
  });
  test('эквайринг по кассе 1.5 % от 27 500, деление по цене; не оценка', () => {
    expect(bel.acquiring_cost).toBeCloseTo(337.5, 2);
    expect(btx.acquiring_cost).toBeCloseTo(75, 2);
    expect(bel.acquiring_estimated).toBe(false);
  });
  test('маржинальная прибыль и %', () => {
    expect(bel.contribution).toBeCloseTo(7999.87, 2);
    expect(btx.contribution).toBeCloseTo(2974.64, 2);
    expect(bel.contribution_pct).toBeCloseTo(7999.87 / 22500, 4);
  });
});

describe('норма и флаги покрытия', () => {
  test('нет списаний + есть техкарта → materials_used = норма, estimated; нет ни того ни другого → 0 + no_materials_data', () => {
    const c = ctx();
    c.techCardFor = (sid) => (sid === 9536380 ? { items: [{ good_id: 1, amount: 1 }, { good_id: 5, amount: 2 }] } : null);
    const rows = C.buildRows({ ...RECORD, consumables: [] }, c);
    expect(rows[0].materials_norm).toBe(5267);
    expect(rows[0].materials_used).toBe(5267);
    expect(rows[0].materials_estimated).toBe(true);
    expect(rows[0].has_tech_card).toBe(true);
    expect(rows[0].no_price_goods).toEqual([5]);
    expect(rows[1].materials_used).toBe(0);
    expect(rows[1].no_materials_data).toBe(true);
  });
  test('есть списания и техкарта → used = факт, норма рядом справочно, не оценка', () => {
    const c = ctx();
    c.techCardFor = (sid) => (sid === 9536380 ? { items: [{ good_id: 1, amount: 1 }] } : null);
    const rows = C.buildRows(RECORD, c);
    expect(rows[0].materials_norm).toBe(5267);
    expect(rows[0].materials_used).toBeCloseTo(5387.63, 2);
    expect(rows[0].materials_estimated).toBe(false);
    expect(rows[0].has_tech_card).toBe(true);
  });
  test('товар без цены в списании → no_price_goods у строки; без service_id — у всех строк записи', () => {
    const c = ctx();
    const rows = C.buildRows({ ...RECORD, consumables: [
      { good_id: 5, service_id: 9536380, amount: -2, cost: 10 },
      { good_id: 5, service_id: null, amount: -1, cost: 5 },
    ] }, c);
    expect(rows[0].no_price_goods).toEqual([5]);
    expect(rows[1].no_price_goods).toEqual([5]);
    expect(rows[0].materials_fact).toBe(0);
    expect(rows[0].materials_yc_cost).toBeCloseTo(10 + 4.09, 2);
    expect(rows[0].has_consumables).toBe(true);
    expect(rows[0].materials_estimated).toBe(false);
  });
  test('списание в единицах продажи пересчитывается через unit_equals (простынь 0.01 рулона = 1 шт)', () => {
    const c = ctx(); c.priceFn = () => ({ price: 6.79, source: 'receipt' });
    const rows = C.buildRows({ ...RECORD, consumables: [
      { good_id: 9, service_id: 9536380, amount: -0.01, cost_per_unit: 6.79, cost: 6.79, unit_equals: 100 },
      { good_id: 9, service_id: 9536380, amount: -1, cost_per_unit: 6.79, cost: 6.79, unit_equals: 100 },
    ] }, c);
    expect(rows[0].materials_fact).toBeCloseTo(13.58, 2);
    expect(rows[0].materials_yc_cost).toBeCloseTo(13.58, 2);
  });
  test('списание с service_id, которого нет в записи, делится как списание на запись', () => {
    const rows = C.buildRows({ ...RECORD, consumables: [{ good_id: 1, service_id: 999, amount: -1, cost: 5267 }] }, ctx());
    expect(rows[0].materials_fact).toBeCloseTo(5267 * 22500 / 27500, 2);
    expect(rows[1].materials_fact).toBeCloseTo(5267 - 4309.36, 2);
  });
  test('нет правила оплаты → 0 и no_pay_rule', () => {
    const c = ctx(); c.payRules = [];
    const rows = C.buildRows(RECORD, c);
    expect(rows[0].doctor_cost).toBe(0);
    expect(rows[0].no_pay_rule).toBe(true);
  });
  test('база net_of_materials вычитает materials_used; pay_base_includes_bonuses → база price', () => {
    const c = ctx();
    c.payRules = [{ id: 2, staff_yc_id: null, service_yc_id: null, category_yc_id: null, percent: 30, base: 'net_of_materials', fixed_per_visit: 0 }];
    let rows = C.buildRows(RECORD, c);
    expect(rows[0].pay_base).toBeCloseTo(22500 - 5387.63, 2);
    expect(rows[0].doctor_pay).toBeCloseTo((22500 - 5387.63) * 0.3, 2);
    c.settings.pay_base_includes_bonuses = true;
    rows = C.buildRows(RECORD, c);
    expect(rows[0].pay_base).toBeCloseTo(22500 - 5387.63, 2);
  });
  test('fixed_per_visit — ОДИН раз на запись: у общего правила делится между строками записи по цене', () => {
    const c = ctx();
    c.payRules = [{ id: 3, staff_yc_id: 1910274, service_yc_id: null, category_yc_id: null, percent: 0, base: 'gross', fixed_per_visit: 500 }];
    const rows = C.buildRows(RECORD, c);
    expect(rows[0].doctor_pay).toBeCloseTo(409.09, 2);
    expect(rows[1].doctor_pay).toBeCloseTo(90.91, 2);
    expect(rows[0].doctor_pay + rows[1].doctor_pay).toBeCloseTo(500, 6);
    expect(rows[0].doctor_cost).toBeCloseTo(409.09 * 1.3, 2);
  });
  test('fixed_per_visit у правила на конкретную услугу — целиком на её строку, другая строка по своему правилу', () => {
    const c = ctx();
    c.payRules = [
      { id: 1, staff_yc_id: null, service_yc_id: null, category_yc_id: null, percent: 30, base: 'gross', fixed_per_visit: 0 },
      { id: 4, staff_yc_id: null, service_yc_id: 25013124, category_yc_id: null, percent: 10, base: 'gross', fixed_per_visit: 300 },
    ];
    const rows = C.buildRows(RECORD, c);
    expect(rows[0].pay_rule_id).toBe(1);
    expect(rows[0].doctor_pay).toBeCloseTo(22500 * 0.3, 2);
    expect(rows[1].pay_rule_id).toBe(4);
    expect(rows[1].doctor_pay).toBeCloseTo(5000 * 0.1 + 300, 2);
  });
  test('нет оплат → эквайринг по средней доле периода, estimated', () => {
    const rows = C.buildRows({ ...RECORD, payments: [] }, ctx());
    C.finalizeRows(rows, { avgAcquiringRate: 0.012 });
    expect(rows[0].acquiring_estimated).toBe(true);
    expect(rows[0].acquiring_cost).toBeCloseTo(22500 * 0.012, 2);
  });
  test('оплаты есть, но касса без процента → эквайринг 0, не оценка', () => {
    const rows = C.buildRows({ ...RECORD, payments: [{ amount: 27500, account_title: 'Касса' }] }, ctx());
    C.finalizeRows(rows, { avgAcquiringRate: 0.012 });
    expect(rows[0].acquiring_cost).toBe(0);
    expect(rows[0].acquiring_estimated).toBe(false);
    expect(rows[0].has_payments).toBe(true);
  });
  test('avgAcquiringRate: Σ эквайринг / Σ выручка по строкам с оплатами', () => {
    const rows = C.buildRows(RECORD, ctx());
    expect(C.avgAcquiringRate(rows)).toBeCloseTo(412.5 / 27500, 6);
    expect(C.avgAcquiringRate([])).toBe(0);
    const noPay = C.buildRows({ ...RECORD, record_id: 2, payments: [] }, ctx());
    expect(C.avgAcquiringRate([...rows, ...noPay])).toBeCloseTo(412.5 / 27500, 6);
  });
  test('длительности каталога делят минуты; нет услуг → []', () => {
    const c = ctx(); c.durations = new Map([['9536380', 2700], ['25013124', 900]]);
    const rows = C.buildRows(RECORD, c);
    expect(rows[0].minutes).toBe(45);
    expect(rows[0].hours).toBe(0.75);
    expect(C.buildRows({ ...RECORD, services: [] }, c)).toEqual([]);
  });
  test('скидка = прайс − к оплате без бонусов, справочно; без cost_to_pay цена = cost', () => {
    const rows = C.buildRows({ ...RECORD, bonus_redeemed: 0, services: [
      { id: 9536380, title: 'A', cost_to_pay: 20000, first_cost: 22500 },
      { id: 25013124, title: 'B', cost: 5000 },
    ] }, ctx());
    expect(rows[0].price).toBe(20000);
    expect(rows[0].discount).toBe(2500);
    expect(rows[1].price).toBe(5000);
    expect(rows[1].first_cost).toBe(5000);
    expect(rows[1].discount).toBe(0);
  });
});

// Правило с 19.10.2026 (разбор 2006141556, docs/superpowers/plans/2026-10-19-economics-bugfix-bonus-and-writeoff-gap.md):
// выручка = cost_to_pay ВСЕГДА — YClients уже вычел и скидки, и бонусы (платёжные операции
// по записи равны cost_to_pay в 254 визитах из 256 за квартал). Бонус распределяется по
// разрывам first_cost×amount − cost_to_pay услуг (bonus_applied), остаток разрыва — скидка.
describe('бонусы: выручка = cost_to_pay, бонус объясняет разрыв до прайса (дев-БД 01.07–18.10.2026)', () => {
  const base = { ...RECORD, consumables: [], payments: [] };
  // Боташев 08.10.2026 10:00: бонус 1500 вычтен в cost И cost_to_pay всех услуг, discount 0.
  const BOTASHEV = [
    { id: 9536663, title: 'Revi strong 2 ml', amount: 1, discount: 0, first_cost: 21000, cost: 20300, cost_to_pay: 20300 },
    { id: 15394048, title: 'Ботулинотерапия Лоб + межбровье', amount: 1, discount: 0, first_cost: 14000, cost: 13533.33, cost_to_pay: 13533.33 },
    { id: 15394051, title: 'Ботулинотерапия Подбородок', amount: 1, discount: 0, first_cost: 4000, cost: 3866.67, cost_to_pay: 3866.67 },
    { id: 15394054, title: 'Ботулинотерапия Уголки глаз', amount: 1, discount: 0, first_cost: 6000, cost: 5800, cost_to_pay: 5800 },
  ];
  test('эталон 2006141556: Revi strong — прайс 21000, скидка 0, бонусами 700, выручка 20300; бонус второй раз не вычитается', () => {
    const rows = C.buildRows({ ...base, record_id: 2006141556, services: BOTASHEV, bonus_redeemed: 1500 }, ctx());
    const revi = rows[0];
    expect(revi.first_cost).toBe(21000);
    expect(revi.price).toBe(20300);
    expect(revi.discount).toBeCloseTo(0, 6);
    expect(revi.bonus_applied).toBeCloseTo(700, 2);
    expect(revi.bonus_redeemed).toBeCloseTo(700, 2);
    expect(revi.revenue).toBe(20300);
    expect(rows.reduce((a, r) => a + r.bonus_applied, 0)).toBeCloseTo(1500, 2);
    expect(rows.reduce((a, r) => a + r.revenue, 0)).toBeCloseTo(43500, 2);
    expect(rows.reduce((a, r) => a + r.discount, 0)).toBeCloseTo(0, 6);
  });
  test('бонус вычтен только в cost_to_pay (1881121110, Profhilo: cost 26000 → 23400) — выручка 23400, бонусами 2600, скидка 0', () => {
    const [r] = C.buildRows({ ...base, services: [{ id: 9536380, title: 'Profhilo', cost: 26000, cost_to_pay: 23400, first_cost: 26000 }], bonus_redeemed: 2600 }, ctx());
    expect(r.price).toBe(23400); expect(r.revenue).toBe(23400);
    expect(r.bonus_applied).toBe(2600); expect(r.discount).toBe(0);
  });
  test('разрыва нет, а бонус по записи есть (деньгами заплачен полный прайс: товары/дрейф баланса) — выручка НЕ уменьшается', () => {
    const [r] = C.buildRows({ ...base, services: [{ id: 9536380, title: 'A', cost: 10000, cost_to_pay: 10000, first_cost: 10000 }], bonus_redeemed: 1500 }, ctx());
    expect(r.revenue).toBe(10000);
    expect(r.bonus_applied).toBe(0);
    expect(r.bonus_redeemed).toBe(1500);
  });
  test('разрыв больше бонуса: остаток разрыва — скидка (first 20000, к оплате 17000, бонус 1000 → скидка 2000)', () => {
    const [r] = C.buildRows({ ...base, services: [{ id: 9536380, title: 'A', cost: 18000, cost_to_pay: 17000, first_cost: 20000 }], bonus_redeemed: 1000 }, ctx());
    expect(r.revenue).toBe(17000); expect(r.bonus_applied).toBe(1000); expect(r.discount).toBe(2000);
  });
  test('разрыв меньше бонуса: бонус ложится по разрывам услуг, не по цене; услуга без разрыва бонуса не получает', () => {
    const rows = C.buildRows({ ...base, services: [
      { id: 9536380, title: 'A', cost: 8000, cost_to_pay: 7000, first_cost: 8000 },
      { id: 25013124, title: 'B', cost: 3000, cost_to_pay: 3000, first_cost: 3000 },
    ], bonus_redeemed: 1500 }, ctx());
    expect(rows[0].bonus_applied).toBeCloseTo(1000, 2); expect(rows[1].bonus_applied).toBe(0);
    expect(rows[0].discount).toBeCloseTo(0, 6); expect(rows[1].discount).toBe(0);
    expect(rows[0].revenue).toBe(7000); expect(rows[1].revenue).toBe(3000);
    expect(rows[0].bonus_redeemed + rows[1].bonus_redeemed).toBeCloseTo(1500, 2);
  });
  test('количество услуги умножает прайс: first_cost 10500 × 2, к оплате 20300, бонус 700 → прайс 21000, бонусами 700', () => {
    const [r] = C.buildRows({ ...base, services: [{ id: 9536663, title: 'Revi strong 2 ml', amount: 2, first_cost: 10500, cost: 20300, cost_to_pay: 20300 }], bonus_redeemed: 700 }, ctx());
    expect(r.first_cost).toBe(21000); expect(r.bonus_applied).toBe(700); expect(r.revenue).toBe(20300);
  });
  test('абонемент: cost_to_pay 0 без бонусов → выручка 0, разрыв до прайса показан скидкой (осознанно, вопрос владельцу)', () => {
    const [r] = C.buildRows({ ...base, services: [{ id: 9536380, title: 'Tesla former Аб', cost: 6000, cost_to_pay: 0, first_cost: 6000 }], bonus_redeemed: 0 }, ctx());
    expect(r.revenue).toBe(0); expect(r.bonus_applied).toBe(0); expect(r.discount).toBe(6000);
  });
  test('эталон 2049113510 (cost_to_pay = first_cost, бонус 1000): выручка = cost_to_pay, бонус справочно по доле цены', () => {
    const rows = C.buildRows(RECORD, ctx());
    expect(rows[0].revenue).toBe(22500); expect(rows[1].revenue).toBe(5000);
    expect(rows[0].bonus_applied).toBe(0); expect(rows[1].bonus_applied).toBe(0);
    expect(rows[0].bonus_redeemed).toBeCloseTo(818.18, 2); expect(rows[1].bonus_redeemed).toBeCloseTo(181.82, 2);
  });
  test('bonus_applied и first_cost суммируются в aggregate и summary; bonus_in_revenue больше нет', () => {
    const rows = C.finalizeRows(C.buildRows({ ...base, record_id: 2006141556, services: BOTASHEV, bonus_redeemed: 1500 }, ctx()));
    expect(C.SUM_FIELDS).toContain('bonus_applied');
    expect(C.SUM_FIELDS).toContain('first_cost');
    expect(C.SUM_FIELDS).not.toContain('bonus_in_revenue');
    const s = C.summary(rows);
    expect(s.bonus_applied).toBe(1500); expect(s.first_cost).toBe(45000); expect(s.revenue).toBe(43500); expect(s.price).toBe(43500);
    expect(rows[0]).not.toHaveProperty('bonus_in_revenue');
  });
});

describe('applyOverhead + aggregate', () => {
  function rowsFixture() {
    const rows = C.buildRows(RECORD, ctx());
    C.finalizeRows(rows, { avgAcquiringRate: 0 });
    return rows;
  }
  test('постоянные по минутам, аппарат только на свои услуги, УСН 15 % с положительной прибыли, прибыль/час', () => {
    const rows = rowsFixture();
    C.applyOverhead(rows, { driver: 'minutes', fixedTotal: 600, equipment: [{ id: 1, name: 'Laser', service_ids: [25013124], periodCost: 100 }], usnRate: 15 });
    expect(rows[0].overhead).toBe(300); expect(rows[1].overhead).toBe(300);
    expect(rows[0].equipment_cost).toBe(0); expect(rows[1].equipment_cost).toBe(100);
    expect(rows[0].operating_profit).toBeCloseTo(7999.87 - 300, 2);
    expect(rows[1].operating_profit).toBeCloseTo(2974.64 - 400, 2);
    expect(rows[0].usn_estimate).toBeCloseTo((7999.87 - 300) * 0.15, 2);
    expect(rows[0].profit_per_hour).toBeCloseTo(7999.87 / 0.5, 2);
    expect(rows[0].operating_pct).toBeCloseTo((7999.87 - 300) / 22500, 4);
  });
  test('драйвер visits — поровну; убыток → УСН 0', () => {
    const rows = rowsFixture();
    C.applyOverhead(rows, { driver: 'visits', fixedTotal: 20000, equipment: [], usnRate: 15 });
    expect(rows[0].overhead).toBe(10000);
    expect(rows[1].operating_profit).toBeLessThan(0);
    expect(rows[1].usn_estimate).toBe(0);
  });
  test('повторный applyOverhead не накапливает аппараты', () => {
    const rows = rowsFixture();
    const eq = [{ id: 1, service_ids: [25013124], periodCost: 100 }];
    C.applyOverhead(rows, { driver: 'minutes', fixedTotal: 0, equipment: eq, usnRate: 15 });
    C.applyOverhead(rows, { driver: 'minutes', fixedTotal: 0, equipment: eq, usnRate: 15 });
    expect(rows[1].equipment_cost).toBe(100);
  });
  test('aggregate по услуге: суммы, визиты, флаги покрытия, проценты', () => {
    const rows = rowsFixture();
    C.applyOverhead(rows, { driver: 'minutes', fixedTotal: 0, equipment: [], usnRate: 15 });
    const g = C.aggregate(rows, r => r.service_yc_id, r => r.service_title);
    expect(g).toHaveLength(2);
    const bel = g.find(x => x.key === 9536380);
    expect(bel.label).toBe('Belotero lips contur 0,6 ml');
    expect(bel.visits).toBe(1);
    expect(bel.revenue).toBeCloseTo(22500, 2);
    expect(bel.materials_used).toBeCloseTo(5387.63, 2);
    expect(bel.materials_estimated_rows).toBe(0);
    expect(bel.contribution).toBeCloseTo(7999.87, 2);
    expect(bel.contribution_pct).toBeCloseTo(7999.87 / 22500, 4);
    expect(bel.hours).toBe(0.5);
    expect(bel.profit_per_hour).toBeCloseTo(15999.74, 2);
    expect(bel.coverage).toEqual({ rows: 1, with_consumables: 1, with_tech_card: 0, no_pay_rule: 0, no_price_goods: [], acquiring_estimated: 0 });
  });
  test('aggregate: две записи одной услуги → visits 2, оценка материалов и товары без цены собираются', () => {
    const c = ctx();
    c.techCardFor = (sid) => (sid === 9536380 ? { items: [{ good_id: 1, amount: 1 }, { good_id: 5, amount: 1 }] } : null);
    const rows = [
      ...C.buildRows(RECORD, c),
      ...C.buildRows({ ...RECORD, record_id: 2, consumables: [], payments: [] }, c),
    ];
    C.finalizeRows(rows, { avgAcquiringRate: C.avgAcquiringRate(rows) });
    C.applyOverhead(rows, { driver: 'minutes', fixedTotal: 0, equipment: [], usnRate: 15 });
    const g = C.aggregate(rows, r => r.service_yc_id, r => r.service_title);
    const bel = g.find(x => x.key === 9536380);
    expect(bel.visits).toBe(2);
    expect(bel.rows).toBe(2);
    expect(bel.materials_used).toBeCloseTo(5387.63 + 5267, 2);
    expect(bel.materials_estimated_sum).toBe(5267);
    expect(bel.materials_estimated_rows).toBe(1);
    expect(bel.materials_norm).toBe(5267 * 2);
    expect(bel.materials_norm_rows).toBe(2);
    expect(bel.coverage).toEqual({ rows: 2, with_consumables: 1, with_tech_card: 2, no_pay_rule: 0, no_price_goods: [5], acquiring_estimated: 1 });
    expect(bel.hours).toBe(1);
  });
  test('summary: ставки минуты (факт / при полной загрузке), простой, покрытие', () => {
    const rows = rowsFixture();
    C.applyOverhead(rows, { driver: 'minutes', fixedTotal: 600, equipment: [], usnRate: 15 });
    const s = C.summary(rows, { fixedTotal: 600, capacityMinutes: 120, driver: 'minutes', equipmentTotal: 0 });
    expect(s.minutes).toBe(60);
    expect(s.rate_minute_fact).toBe(10);
    expect(s.rate_minute_capacity).toBe(5);
    expect(s.idle_cost).toBe(300);                 // 600 − 5 × 60
    expect(s.visits).toBe(1);
    expect(s.revenue).toBeCloseTo(27500, 2);
    expect(s.overhead).toBe(600);
    expect(s.coverage.consumables_share).toBe(1);
    expect(s.coverage.services_without_tech_card).toBe(2);
    expect(s.coverage.staff_without_pay_rule).toBe(0);
  });
  test('summary: без графика простой null; мощность меньше факта → простой 0, не отрицательный', () => {
    const rows = rowsFixture();
    C.applyOverhead(rows, { driver: 'minutes', fixedTotal: 600, equipment: [], usnRate: 15 });
    expect(C.summary(rows, { fixedTotal: 600, capacityMinutes: 0 }).idle_cost).toBeNull();
    expect(C.summary(rows, { fixedTotal: 600, capacityMinutes: 30 }).idle_cost).toBe(0);
    const empty = C.summary([], { fixedTotal: 600, capacityMinutes: 120 });
    expect(empty.visits).toBe(0);
    expect(empty.rate_minute_fact).toBe(0);
    expect(empty.contribution_pct).toBeNull();
  });
});

describe('ревью: база оплаты, скидка, свои списания повторной услуги', () => {
  const base = { ...RECORD, consumables: [], payments: [] };
  test('pay_base_includes_bonuses → база ДО бонусов = cost_to_pay + bonus_applied (Profhilo 23400+2600 → 26000; Revi 20300+700 → 21000)', () => {
    const c = ctx(); c.settings.pay_base_includes_bonuses = true;
    const [r] = C.buildRows({ ...base, services: [{ id: 9536380, title: 'Profhilo', cost: 26000, cost_to_pay: 23400, first_cost: 26000 }], bonus_redeemed: 2600 }, c);
    expect(r.pay_base).toBe(26000);
    expect(r.doctor_pay).toBe(7800);
    const [revi] = C.buildRows({ ...base, services: [{ id: 9536663, title: 'Revi', cost: 20300, cost_to_pay: 20300, first_cost: 21000 }], bonus_redeemed: 700 }, c);
    expect(revi.pay_base).toBe(21000);
    c.settings.pay_base_includes_bonuses = false;
    const [r2] = C.buildRows({ ...base, services: [{ id: 9536380, title: 'Profhilo', cost: 26000, cost_to_pay: 23400, first_cost: 26000 }], bonus_redeemed: 2600 }, c);
    expect(r2.pay_base).toBe(23400);
  });
  test('скидка = разрыв до прайса минус бонус (Profhilo: разрыв 2600 = бонус → 0; A: разрыв 3000, бонус 1000 → 2000)', () => {
    const [r] = C.buildRows({ ...base, services: [{ id: 9536380, title: 'Profhilo', cost: 26000, cost_to_pay: 23400, first_cost: 26000 }], bonus_redeemed: 2600 }, ctx());
    expect(r.discount).toBe(0);
    const [r2] = C.buildRows({ ...base, services: [{ id: 9536380, title: 'A', cost: 18000, cost_to_pay: 17000, first_cost: 20000 }], bonus_redeemed: 1000 }, ctx());
    expect(r2.discount).toBe(2000);
  });
  test('одна услуга дважды в записи: её списания делятся между строками по цене, а не целиком в каждую', () => {
    const rows = C.buildRows({ ...base,
      services: [{ id: 9536380, title: 'A', cost_to_pay: 3000, first_cost: 3000 }, { id: 9536380, title: 'A', cost_to_pay: 1000, first_cost: 1000 }],
      consumables: [{ good_id: 1, service_id: 9536380, amount: -1, cost: 5267 }] }, ctx());
    expect(rows[0].materials_fact + rows[1].materials_fact).toBeCloseTo(5267, 2);
    expect(rows[0].materials_fact).toBeCloseTo(3950.25, 2);
    expect(rows[1].materials_fact).toBeCloseTo(1316.75, 2);
    expect(rows[0].materials_yc_cost + rows[1].materials_yc_cost).toBeCloseTo(5267, 2);
  });
});

describe('buildRows: поля для предупреждений (Task 22)', () => {
  test('no_price_consumed — только товары РЕАЛЬНЫХ списаний; товар без цены из нормы туда не попадает', () => {
    const c = ctx();
    c.techCardFor = (sid) => (sid === 9536380 ? { items: [{ good_id: 1, amount: 1 }, { good_id: 5, amount: 2 }] } : null);
    const est = C.buildRows({ ...RECORD, consumables: [] }, c);
    expect(est[0].no_price_goods).toEqual([5]);              // покрытие — как раньше
    expect(est[0].no_price_consumed).toEqual([]);            // но не «списан без цены»
    expect(est[0].norm_complete).toBe(false);                // в норме товар без цены
    const fact = C.buildRows({ ...RECORD, consumables: [{ good_id: 5, service_id: 9536380, amount: -1, cost: 1 }] }, ctx());
    expect(fact[0].no_price_consumed).toEqual([5]);
  });
  test('norm_complete — норма есть и все её товары с ценой; fact_shared — в факте доля общих списаний записи на разные услуги', () => {
    const c = ctx();
    c.techCardFor = (sid) => (sid === 9536380 ? { items: [{ good_id: 1, amount: 1 }] } : null);
    const rows = C.buildRows(RECORD, c);                     // перчатки без service_id на 2 услуги
    expect(rows[0].norm_complete).toBe(true);
    expect(rows[0].fact_shared).toBe(true);
    expect(rows[1].norm_complete).toBe(false);               // нормы нет
    const own = C.buildRows({ ...RECORD, consumables: RECORD.consumables.filter(t => t.service_id) }, c);
    expect(own[0].fact_shared).toBe(false);
    const single = C.buildRows({ ...RECORD, services: [RECORD.services[0]] }, c);
    expect(single[0].fact_shared).toBe(false);               // одна услуга — делить не с кем
  });
});

describe('warnings (Task 22): только то, что доказуемо данными', () => {
  const base = { record_id: 1, visit_date: '2026-09-10', staff_name: 'A', service_yc_id: 10, service_title: 'S', has_consumables: true, has_tech_card: true,
    materials_fact: 100, materials_norm: 100, norm_complete: true, fact_shared: false, no_price_goods: [], no_price_consumed: [] };
  const P = { from: '2026-09-01', to: '2026-09-30', today: '2026-10-19' };
  const run = (rows, extra = {}) => C.warnings(rows, { receiptsByGood: new Map(), catalogByGood: new Map(), ...P, ...extra });

  test('визит без списаний — только у услуги с нормой (техкарта с товарами); одна запись считается один раз', () => {
    const w = run([
      { ...base, record_id: 1, has_consumables: false },
      { ...base, record_id: 1, has_consumables: false },                         // та же услуга дважды в записи
      { ...base, record_id: 2, has_consumables: false, visit_date: '2026-09-12' },
      { ...base, record_id: 4, service_yc_id: 11, has_consumables: false, has_tech_card: false, materials_norm: null },
      { ...base, record_id: 5, service_yc_id: 12, has_consumables: false, has_tech_card: true, materials_norm: null }, // карта без товаров
      { ...base, record_id: 6, service_yc_id: 13 }, { ...base, record_id: 7, service_yc_id: 13, visit_date: '2026-09-12' }, // в эти дни списания в салоне были
    ]);
    expect(w.filter(x => x.type === 'no_consumables')).toEqual([
      { type: 'no_consumables', service_yc_id: 10, service_title: 'S', count: 2, record_ids: [1, 2], last_date: '2026-09-12' },
    ]);
  });
  test('день без единого списания в салоне — не предупреждение: это дыра синка, а не «не списали»', () => {
    const rows = [
      { ...base, record_id: 1, has_consumables: false, visit_date: '2026-09-05' },          // в этот день списаний нет ни у кого
      { ...base, record_id: 2, has_consumables: false, visit_date: '2026-09-02' },
      { ...base, record_id: 3, service_yc_id: 99, has_tech_card: false, materials_norm: null, visit_date: '2026-09-02' }, // списания в этот день есть
    ];
    expect(run(rows).filter(w => w.type === 'no_consumables').map(w => w.record_ids)).toEqual([[2]]);
  });
  test('sync_gap: дни без единого списания в салоне перечислены одной строкой — визиты по записям, сегодня не считается, первым в списке', () => {
    const rows = [
      { ...base, record_id: 1, has_consumables: false, visit_date: '2026-09-05' },
      { ...base, record_id: 1, service_yc_id: 11, has_consumables: false, visit_date: '2026-09-05' }, // та же запись, вторая услуга
      { ...base, record_id: 4, has_consumables: false, visit_date: '2026-09-03' },
      { ...base, record_id: 2, has_consumables: false, visit_date: '2026-09-02' },
      { ...base, record_id: 3, service_yc_id: 99, has_tech_card: false, materials_norm: null, visit_date: '2026-09-02' }, // списания в этот день есть
      { ...base, record_id: 9, has_consumables: false, visit_date: '2026-10-19' },                                      // сегодня
    ];
    const w = run(rows, { from: '2026-09-01', to: '2026-10-31' });
    expect(w[0]).toEqual({ type: 'sync_gap', days: ['2026-09-03', '2026-09-05'], visits: 2 });
    expect(w.filter(x => x.type === 'sync_gap')).toHaveLength(1);
    expect(run([{ ...base, record_id: 1 }]).filter(x => x.type === 'sync_gap')).toEqual([]);
  });
  test('визит сегодня/в будущем без списаний — не предупреждение (списание ещё могут провести)', () => {
    const w = run([{ ...base, has_consumables: false, visit_date: '2026-10-19' }, { ...base, record_id: 2, visit_date: '2026-10-19', materials_norm: null, has_tech_card: false }], { from: '2026-10-01', to: '2026-10-31' });
    expect(w).toEqual([]);
  });
  test('перерасход > 20 % против ПОЛНОЙ нормы и только по своим списаниям услуги', () => {
    const w = run([
      { ...base, record_id: 2, materials_fact: 130 },
      { ...base, record_id: 3, materials_fact: 119 },                             // +19 % — нет
      { ...base, record_id: 6, materials_fact: 500, norm_complete: false },       // норма неполная — сравнивать нечестно
      { ...base, record_id: 7, materials_fact: 500, fact_shared: true },          // факт — доля общих списаний
      { ...base, record_id: 8, materials_fact: 500, materials_norm: null, has_tech_card: false },
      { ...base, record_id: 9, materials_fact: 500, has_consumables: false },
    ]);
    expect(w.filter(x => x.type === 'overrun')).toEqual([
      { type: 'overrun', service_yc_id: 10, service_title: 'S', record_id: 2, visit_date: '2026-09-10', staff_name: 'A', fact: 130, norm: 100, ratio: 1.3 },
    ]);
  });
  test('товар без цены — только из реальных списаний периода; визиты считаются по записям', () => {
    const w = run([
      { ...base, record_id: 3, no_price_consumed: [7], no_price_goods: [7] },
      { ...base, record_id: 3, service_yc_id: 11, no_price_consumed: [7], no_price_goods: [7] },
      { ...base, record_id: 4, no_price_consumed: [], no_price_goods: [9] },      // только в норме — нет
    ], { catalogByGood: new Map([[7, { title: 'G7' }]]) });
    expect(w.filter(x => x.type === 'no_price')).toEqual([{ type: 'no_price', good_id: 7, good_title: 'G7', visits: 1 }]);
  });
  test('скачок цены прихода ≥ 20 %: последний приход в периоде против предыдущего СОПОСТАВИМОГО', () => {
    const receiptsByGood = new Map([
      [7, [{ create_date: '2026-09-05T09:00:00Z', amount: 1, cost: 130, operation_unit_type: 2 }, { create_date: '2026-08-05T09:00:00Z', amount: 1, cost: 100, operation_unit_type: 2 }]],
      [8, [{ create_date: '2026-09-05', amount: 1, cost: 105, operation_unit_type: 2 }, { create_date: '2026-08-05', amount: 1, cost: 100, operation_unit_type: 2 }]],
      // флакон без unit_equals — несопоставим, пропускается; сравнение с приходом до него
      [9, [{ create_date: '2026-09-20', amount: 2, cost: 300, operation_unit_type: 2 }, { create_date: '2026-09-01', amount: 1, cost: 5000, operation_unit_type: 1 }, { create_date: '2026-07-01', amount: 1, cost: 100, operation_unit_type: 2 }]],
      // флаконы, пересчёт через unit_equals: 10 мл по 1000 → 100/мл; затем 150/мл
      [10, [{ create_date: '2026-09-10', amount: 2, cost: 300, operation_unit_type: 2 }, { create_date: '2026-06-01', amount: 1, cost: 1000, operation_unit_type: 1 }]],
      // только приход в упаковках без коэффициента — нечего сравнивать
      [11, [{ create_date: '2026-09-10', amount: 1, cost: 900, operation_unit_type: 1 }, { create_date: '2026-06-01', amount: 1, cost: 100, operation_unit_type: 2 }]],
      // один приход — нет истории
      [12, [{ create_date: '2026-09-10', amount: 1, cost: 900, operation_unit_type: 2 }]],
      // последний приход до периода — не про этот период
      [13, [{ create_date: '2026-08-10', amount: 1, cost: 900, operation_unit_type: 2 }, { create_date: '2026-06-01', amount: 1, cost: 100, operation_unit_type: 2 }]],
      // два прихода в один день: средняя за день (100+200)/2=150 против 100
      [14, [{ create_date: '2026-09-10T08:00:00Z', amount: 1, cost: 100, operation_unit_type: 2 }, { create_date: '2026-09-10T12:00:00Z', amount: 1, cost: 200, operation_unit_type: 2 }, { create_date: '2026-08-01', amount: 1, cost: 100, operation_unit_type: 2 }]],
      // бесплатный образец (cost 0) не база для сравнения
      [15, [{ create_date: '2026-09-10', amount: 1, cost: 100, operation_unit_type: 2 }, { create_date: '2026-08-01', amount: 1, cost: 0, operation_unit_type: 2 }]],
    ]);
    const catalogByGood = new Map([[7, { title: 'G7', unit_equals: 1 }], [9, { title: 'G9', unit_equals: null }], [10, { title: 'G10', unit_equals: 10 }], [11, { title: 'G11', unit_equals: 0 }], [14, { title: 'G14' }]]);
    const w = run([], { receiptsByGood, catalogByGood }).filter(x => x.type === 'price_jump');
    expect(w).toEqual([
      { type: 'price_jump', good_id: 9, good_title: 'G9', prev: 100, prev_at: '2026-07-01', last: 150, ratio: 1.5, at: '2026-09-20' },
      { type: 'price_jump', good_id: 10, good_title: 'G10', prev: 100, prev_at: '2026-06-01', last: 150, ratio: 1.5, at: '2026-09-10' },
      { type: 'price_jump', good_id: 14, good_title: 'G14', prev: 100, prev_at: '2026-08-01', last: 150, ratio: 1.5, at: '2026-09-10' },
      { type: 'price_jump', good_id: 7, good_title: 'G7', prev: 100, prev_at: '2026-08-05', last: 130, ratio: 1.3, at: '2026-09-05' },
    ]);
  });
  test('пусто → []', () => { expect(run([])).toEqual([]); });
});

describe('количество услуги в записи (amount) — живой прогон предупреждений 19.10.2026', () => {
  // Запись 1900695399 (дев-БД): «Revi strong 2 ml» amount 2, first_cost 24000 (за единицу),
  // cost 48000; списано 2 шприца при техкарте на 1. Без учёта amount — ложный «перерасход ×2».
  const rec = { record_id: 1900695399, visit_date: '2026-09-08', staff_yc_id: 1, staff_name: 'П', seance_length: 3600,
    services: [{ id: 9536663, title: 'Revi strong 2 ml', amount: 2, first_cost: 24000, cost: 43200, cost_to_pay: 43200 }],
    consumables: [{ good_id: 1, service_id: 9536663, amount: -2, cost: 10534 }], bonus_redeemed: 0, payments: [] };
  test('норма техкарты умножается на количество; first_cost — за единицу, скидка считается от first_cost × amount', () => {
    const c = ctx(); c.techCardFor = () => ({ items: [{ good_id: 1, amount: 1 }] });
    const [row] = C.buildRows(rec, c);
    expect(row.materials_norm).toBe(5267 * 2);
    expect(row.materials_fact).toBe(5267 * 2);
    expect(row.first_cost).toBe(48000);
    expect(row.discount).toBe(4800);
    expect(C.warnings([row], { from: '2026-09-01', to: '2026-09-30' }).filter(w => w.type === 'overrun')).toEqual([]);
    const [est] = C.buildRows({ ...rec, consumables: [] }, c);
    expect(est.materials_used).toBe(5267 * 2);              // оценка по норме — тоже на 2 единицы
  });
  test('нет amount / мусор → количество 1', () => {
    const c = ctx(); c.techCardFor = () => ({ items: [{ good_id: 1, amount: 1 }] });
    for (const amount of [undefined, null, 0, -1, 'x']) {
      const [row] = C.buildRows({ ...rec, services: [{ ...rec.services[0], amount }] }, c);
      expect(row.materials_norm).toBe(5267);
      expect(row.first_cost).toBe(24000);
    }
  });
});
