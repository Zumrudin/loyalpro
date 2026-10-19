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
    expect(bel.revenue).toBeCloseTo(21681.82, 2); expect(btx.revenue).toBeCloseTo(4818.18, 2);
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
    expect(bel.doctor_pay).toBeCloseTo(6504.55, 2);
    expect(bel.doctor_cost).toBeCloseTo(8455.91, 2);
    expect(btx.doctor_cost).toBeCloseTo(1879.09, 2);
    expect(bel.no_pay_rule).toBe(false);
    expect(btx.category_yc_id).toBe(100);
  });
  test('эквайринг по кассе 1.5 % от 27 500, деление по цене; не оценка', () => {
    expect(bel.acquiring_cost).toBeCloseTo(337.5, 2);
    expect(btx.acquiring_cost).toBeCloseTo(75, 2);
    expect(bel.acquiring_estimated).toBe(false);
  });
  test('маржинальная прибыль и %', () => {
    expect(bel.contribution).toBeCloseTo(7500.78, 2);
    expect(btx.contribution).toBeCloseTo(2863.73, 2);
    expect(bel.contribution_pct).toBeCloseTo(7500.78 / 21681.82, 4);
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
    expect(rows[0].pay_base).toBeCloseTo(21681.82 - 5387.63, 2);
    expect(rows[0].doctor_pay).toBeCloseTo((21681.82 - 5387.63) * 0.3, 2);
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
    expect(rows[0].doctor_pay).toBeCloseTo(21681.82 * 0.3, 2);
    expect(rows[1].pay_rule_id).toBe(4);
    expect(rows[1].doctor_pay).toBeCloseTo(4818.18 * 0.1 + 300, 2);
  });
  test('нет оплат → эквайринг по средней доле периода, estimated', () => {
    const rows = C.buildRows({ ...RECORD, payments: [] }, ctx());
    C.finalizeRows(rows, { avgAcquiringRate: 0.012 });
    expect(rows[0].acquiring_estimated).toBe(true);
    expect(rows[0].acquiring_cost).toBeCloseTo(21681.82 * 0.012, 2);
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
    expect(C.avgAcquiringRate(rows)).toBeCloseTo(412.5 / 26500, 6);
    expect(C.avgAcquiringRate([])).toBe(0);
    const noPay = C.buildRows({ ...RECORD, record_id: 2, payments: [] }, ctx());
    expect(C.avgAcquiringRate([...rows, ...noPay])).toBeCloseTo(412.5 / 26500, 6);
  });
  test('длительности каталога делят минуты; нет услуг → []', () => {
    const c = ctx(); c.durations = new Map([['9536380', 2700], ['25013124', 900]]);
    const rows = C.buildRows(RECORD, c);
    expect(rows[0].minutes).toBe(45);
    expect(rows[0].hours).toBe(0.75);
    expect(C.buildRows({ ...RECORD, services: [] }, c)).toEqual([]);
  });
  test('скидка = first_cost − cost_to_pay, справочно; без cost_to_pay берётся cost', () => {
    const rows = C.buildRows({ ...RECORD, services: [
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
    expect(rows[0].operating_profit).toBeCloseTo(7500.78 - 300, 2);
    expect(rows[1].operating_profit).toBeCloseTo(2863.73 - 400, 2);
    expect(rows[0].usn_estimate).toBeCloseTo((7500.78 - 300) * 0.15, 2);
    expect(rows[0].profit_per_hour).toBeCloseTo(7500.78 / 0.5, 2);
    expect(rows[0].operating_pct).toBeCloseTo((7500.78 - 300) / 21681.82, 4);
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
    expect(bel.revenue).toBeCloseTo(21681.82, 2);
    expect(bel.materials_used).toBeCloseTo(5387.63, 2);
    expect(bel.materials_estimated_rows).toBe(0);
    expect(bel.contribution).toBeCloseTo(7500.78, 2);
    expect(bel.contribution_pct).toBeCloseTo(7500.78 / 21681.82, 4);
    expect(bel.hours).toBe(0.5);
    expect(bel.profit_per_hour).toBeCloseTo(15001.56, 2);
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
    expect(s.revenue).toBeCloseTo(26500, 2);
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
