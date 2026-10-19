// Чистые помощники страницы «Экономика» + проверка общей глобальной области.
// Запуск: node --test frontend/js/pages/economics-table.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FRONT = path.join(__dirname, '..', '..');
function browserContext() {
  const ctx = vm.createContext({ console, URLSearchParams, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
  ctx.window = ctx; return ctx;
}
const ctx = browserContext();
for (const f of ['js/core/utils.js', 'js/core/api.js', 'js/pages/economics-table.js', 'js/pages/economics.js']) {
  vm.runInContext(fs.readFileSync(path.join(FRONT, f), 'utf8'), ctx, { filename: f });
}
const plain = (x) => JSON.parse(JSON.stringify(x));
const k = (name) => vm.runInContext(name, ctx);

test('файлы грузятся в одну область (нет редекларации имён)', () => {
  for (const n of ['ecoMoney', 'ecoPct', 'ecoSort', 'ecoTotals', 'loadEconomics', 'ecoSwitchTab']) assert.strictEqual(typeof ctx[n], 'function', n);
  assert.ok(Array.isArray(plain(k('ECO_SERVICE_COLS'))));
});

test('ecoMoney / ecoPct / ecoNum', () => {
  assert.strictEqual(ctx.ecoMoney(1234567.891), '1 234 568 ₽');
  assert.strictEqual(ctx.ecoMoney(-50.4), '−50 ₽');
  assert.strictEqual(ctx.ecoMoney(null), '—');
  assert.strictEqual(ctx.ecoPct(0.4256), '42,6%');
  assert.strictEqual(ctx.ecoPct(null), '—');
  assert.strictEqual(ctx.ecoNum(2.5, 1), '2,5');
});

test('ecoSort: по числу и строке, направление, null в конец', () => {
  const rows = [{ label: 'б', revenue: 10 }, { label: 'а', revenue: null }, { label: 'в', revenue: 30 }];
  assert.deepStrictEqual(plain(ctx.ecoSort(rows, 'revenue', 'desc')).map(r => r.label), ['в', 'б', 'а']);
  assert.deepStrictEqual(plain(ctx.ecoSort(rows, 'revenue', 'asc')).map(r => r.label), ['б', 'в', 'а']);
  assert.deepStrictEqual(plain(ctx.ecoSort(rows, 'label', 'asc')).map(r => r.label), ['а', 'б', 'в']);
});

test('ecoTotals: суммы по колонкам, проценты и прибыль/час пересчитываются от сумм', () => {
  const t = plain(ctx.ecoTotals([
    { visits: 1, revenue: 100, materials_used: 10, doctor_cost: 20, acquiring_cost: 1, contribution: 69, overhead: 9, equipment_cost: 0, operating_profit: 60, usn_estimate: 9, hours: 0.5, materials_estimated_rows: 1, discount: 0, bonus_redeemed: 0 },
    { visits: 2, revenue: 300, materials_used: 30, doctor_cost: 60, acquiring_cost: 3, contribution: 207, overhead: 27, equipment_cost: 10, operating_profit: 170, usn_estimate: 25.5, hours: 1.5, materials_estimated_rows: 0, discount: 5, bonus_redeemed: 2 },
  ]));
  assert.strictEqual(t.visits, 3);
  assert.strictEqual(t.revenue, 400);
  assert.strictEqual(t.contribution, 276);
  assert.strictEqual(t.contribution_pct, 0.69);
  assert.strictEqual(t.profit_per_hour, 138);
  assert.strictEqual(t.materials_estimated_rows, 1);
});

test('ecoPeriodPreset: месяц и квартал по московской дате', () => {
  assert.deepStrictEqual(plain(ctx.ecoPeriodPreset('month', '2026-10-18')), { from: '2026-10-01', to: '2026-10-18' });
  assert.deepStrictEqual(plain(ctx.ecoPeriodPreset('quarter', '2026-10-18')), { from: '2026-10-01', to: '2026-10-18' });
  assert.deepStrictEqual(plain(ctx.ecoPeriodPreset('prev-month', '2026-10-18')), { from: '2026-09-01', to: '2026-09-30' });
});

test('ecoFlags: бейджи покрытия строки услуги', () => {
  const f = plain(ctx.ecoFlags({ coverage: { rows: 4, with_consumables: 2, with_tech_card: 0, no_pay_rule: 1, no_price_goods: [5], acquiring_estimated: 4 }, materials_estimated_rows: 2 }));
  assert.deepStrictEqual(f.map(x => x.key), ['estimated', 'no_tech_card', 'no_pay_rule', 'no_price', 'acq_est']);
});

test('все <script> index.html в одном vm-контексте без конфликта глобальных имён', () => {
  const html = fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8');
  const srcs = [...html.matchAll(/<script[^>]+src="(js\/[^"?]+)/g)].map(m => m[1]);
  assert.ok(srcs.includes('js/pages/economics.js'));
  const noop = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, appendChild() {}, setAttribute() {}, dataset: {} });
  const c = vm.createContext({ console, URLSearchParams, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { hash: '', href: '' }, history: { replaceState() {} },
    navigator: { userAgent: '' }, matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null, createElement: noop, addEventListener() {}, body: noop(), documentElement: noop(), readyState: 'loading' },
    fetch: async () => ({ ok: true, json: async () => ({}) }), addEventListener() {}, Chart: function () {}, EventSource: function () {} });
  c.window = c;
  for (const s of srcs) {
    try { vm.runInContext(fs.readFileSync(path.join(FRONT, s), 'utf8'), c, { filename: s }); }
    catch (e) { if (e instanceof SyntaxError) throw new Error(`${s}: ${e.message}`); /* рантайм-ошибки заглушек DOM не интересуют */ }
  }
});

test('ecoSortNext: повторный клик меняет направление, новая колонка — desc, «Услуга» — asc', () => {
  assert.deepStrictEqual(plain(ctx.ecoSortNext({ sortKey: 'revenue', sortDir: 'desc' }, 'revenue')), { sortKey: 'revenue', sortDir: 'asc' });
  assert.deepStrictEqual(plain(ctx.ecoSortNext({ sortKey: 'revenue', sortDir: 'asc' }, 'revenue')), { sortKey: 'revenue', sortDir: 'desc' });
  assert.deepStrictEqual(plain(ctx.ecoSortNext({ sortKey: 'revenue', sortDir: 'asc' }, 'contribution_pct')), { sortKey: 'contribution_pct', sortDir: 'desc' });
  assert.deepStrictEqual(plain(ctx.ecoSortNext({ sortKey: 'revenue', sortDir: 'desc' }, 'label')), { sortKey: 'label', sortDir: 'asc' });
  // неизвестная колонка не ломает состояние
  assert.deepStrictEqual(plain(ctx.ecoSortNext({ sortKey: 'revenue', sortDir: 'desc' }, 'evil')), { sortKey: 'revenue', sortDir: 'desc' });
});

test('ecoSummaryTiles: шесть плиток, бонусы показаны, нет графика — подпись', () => {
  const tiles = plain(ctx.ecoSummaryTiles({
    revenue: 100000, visits: 40, hours: 52.4, bonus_redeemed: 3000, bonus_in_revenue: 1000,
    contribution: 60000, contribution_pct: 0.6, operating_profit: 20000, operating_pct: 0.2, usn_estimate: 6000,
    rate_minute_fact: 12.34, rate_minute_capacity: 0, idle_cost: null,
    coverage: { consumables_share: 0.5, services_without_tech_card: 3, services_total: 10, goods_without_price: [1, 2], staff_without_pay_rule: 1 },
  }));
  assert.strictEqual(tiles.length, 6);
  assert.strictEqual(tiles[0].kpi, '100 000 ₽');
  assert.match(tiles[0].sub, /40 визитов/);
  assert.match(tiles[0].sub, /бонусов списано 3 000 ₽/);
  assert.match(tiles[3].sub, /график сотрудников не загружен/);
  assert.strictEqual(tiles[4].kpi, '50,0%');
  assert.strictEqual(tiles[5].kpi, '2');
  const withCap = plain(ctx.ecoSummaryTiles({ rate_minute_fact: 10, rate_minute_capacity: 5, idle_cost: 1500, coverage: {} }));
  assert.match(withCap[3].sub, /простой 1 500 ₽/);
});

test('ecoDetailLines: выручка = цена − бонусы, не учтённые YClients; списанное показано отдельно', () => {
  const lines = plain(ctx.ecoDetailLines({
    price: 23400, discount: 500, bonus_redeemed: 2600, bonus_in_revenue: 0, revenue: 23400,
    materials_used: 4000, materials_fact: 4000, materials_norm: 3500, materials_estimated_rows: 0,
    doctor_pay: 5000, doctor_cost: 6510, acquiring_cost: 400, coverage: { acquiring_estimated: 0 },
    contribution: 12490, contribution_pct: 0.5337, overhead: 3000, equipment_cost: 500,
    operating_profit: 8990, operating_pct: 0.384, usn_estimate: 1404, profit_per_hour: 6000,
  }, { payroll_multiplier: 1.302, allocation_driver: 'minutes' }));
  const byLabel = Object.fromEntries(lines.map(l => [l.label, l]));
  const bonus = lines[1];
  assert.match(bonus.label, /бонус/i);
  assert.strictEqual(bonus.value, '0 ₽', 'вычитается bonus_in_revenue, а не bonus_redeemed');
  assert.match(bonus.note, /списано 2 600 ₽/);
  assert.match(bonus.note, /2 600 ₽ уже учтено YClients/);
  assert.strictEqual(byLabel['= Выручка'].value, '23 400 ₽');
  assert.ok(byLabel['= Выручка'].total);
  assert.match(lines[0].note, /скидки 500 ₽/);
  assert.match(byLabel['− Постоянные расходы'].note, /по минутам/);
  assert.strictEqual(lines.filter(l => l.total).length, 3);
  const visitsDriver = plain(ctx.ecoDetailLines({ coverage: {} }, { allocation_driver: 'visits' }));
  assert.match(visitsDriver.find(l => l.label === '− Постоянные расходы').note, /на визит/);
});

test('ecoVisitFlags: флаги визита в детализации', () => {
  assert.deepStrictEqual(plain(ctx.ecoVisitFlags({ materials_estimated: true, no_materials_data: false, no_price_goods: [1, 2], no_pay_rule: true, acquiring_estimated: true })),
    ['оценка материалов', 'без цены: 2', 'нет правила оплаты', 'нет оплат']);
  assert.deepStrictEqual(plain(ctx.ecoVisitFlags({ no_materials_data: true })), ['нет данных о материалах']);
  assert.deepStrictEqual(plain(ctx.ecoVisitFlags({})), []);
});
