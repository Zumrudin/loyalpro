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
    revenue: 100000, visits: 40, hours: 52.4, bonus_redeemed: 3000, bonus_applied: 1000,
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

test('ecoDetailLines: прайс → − скидки → − бонусами → = выручка (к оплате деньгами); бонус сверх разрыва — справочно', () => {
  const lines = plain(ctx.ecoDetailLines({
    first_cost: 26000, price: 23400, discount: 0, bonus_redeemed: 3000, bonus_applied: 2600, revenue: 23400,
    materials_used: 4000, materials_fact: 4000, materials_norm: 3500, materials_estimated_rows: 0,
    doctor_pay: 5000, doctor_cost: 6510, acquiring_cost: 400, coverage: { acquiring_estimated: 0 },
    contribution: 12490, contribution_pct: 0.5337, overhead: 3000, equipment_cost: 500,
    operating_profit: 8990, operating_pct: 0.384, usn_estimate: 1404, profit_per_hour: 6000,
  }, { payroll_multiplier: 1.302, allocation_driver: 'minutes' }));
  const byLabel = Object.fromEntries(lines.map(l => [l.label, l]));
  assert.match(lines[0].label, /прайс/i);
  assert.strictEqual(lines[0].value, '26 000 ₽');
  assert.match(lines[1].label, /скидк/i);
  assert.strictEqual(lines[1].value, '0 ₽');
  assert.match(lines[2].label, /бонус/i);
  assert.strictEqual(lines[2].value, '2 600 ₽', 'вычитается bonus_applied — часть бонуса в разрыве до прайса');
  assert.match(lines[2].note, /всего списано 3 000 ₽/);
  assert.match(lines[2].note, /400 ₽ вне стоимости услуг/);
  assert.match(byLabel['= Выручка (к оплате деньгами)'].value, /23 400 ₽/);
  assert.ok(byLabel['= Выручка (к оплате деньгами)'].total);
  assert.strictEqual(lines.some(l => /не учтённые в сумме к оплате/.test(l.label)), false);
  const noBonus = plain(ctx.ecoDetailLines({ first_cost: 1000, price: 1000, discount: 0, bonus_redeemed: 0, bonus_applied: 0, revenue: 1000, coverage: {} }, {}));
  assert.match(noBonus[2].note, /не списывались/);
});


test('ecoVisitFlags: флаги визита в детализации', () => {
  assert.deepStrictEqual(plain(ctx.ecoVisitFlags({ materials_estimated: true, no_materials_data: false, no_price_goods: [1, 2], no_pay_rule: true, acquiring_estimated: true })),
    ['оценка материалов', 'без цены: 2', 'нет правила оплаты', 'нет оплат']);
  assert.deepStrictEqual(plain(ctx.ecoVisitFlags({ no_materials_data: true })), ['нет данных о материалах']);
  assert.deepStrictEqual(plain(ctx.ecoVisitFlags({})), []);
});

test('ecoGoodsUnit: единица списания и пересчёт упаковки', () => {
  assert.deepStrictEqual(plain(ctx.ecoGoodsUnit({ unit: 'уп', service_unit: 'мл', unit_equals: 50 })), { main: 'мл', sub: '1 уп = 50 мл' });
  assert.deepStrictEqual(plain(ctx.ecoGoodsUnit({ unit: 'шт', service_unit: 'шт', unit_equals: 1 })), { main: 'шт', sub: '' });
  assert.deepStrictEqual(plain(ctx.ecoGoodsUnit({ unit: 'шт' })), { main: 'шт', sub: '' });
  assert.deepStrictEqual(plain(ctx.ecoGoodsUnit({})), { main: '', sub: '' });
});

test('ecoCardItemsText: состав техкарты без HTML, товар без названия — по id', () => {
  assert.strictEqual(ctx.ecoCardItemsText([{ title: 'Гель', amount: 2.5, unit: 'мл' }, { good_id: 77, amount: 1 }]), 'Гель × 2,5 мл; товар 77 × 1');
  assert.strictEqual(ctx.ecoCardItemsText(null), '');
});

test('ecoParseManualItems: проверка формы нормы до отправки', () => {
  const ok = plain(ctx.ecoParseManualItems(' Чистка ', [{ goodId: '12', amount: '1,5', unit: ' мл ' }]));
  assert.deepStrictEqual(ok, { value: { title: 'Чистка', items: [{ goodId: 12, amount: 1.5, unit: 'мл' }] } });
  assert.match(ctx.ecoParseManualItems('', [{ goodId: '1', amount: '1' }]).error, /название/i);
  assert.match(ctx.ecoParseManualItems('x', []).error, /позици/i);
  assert.match(ctx.ecoParseManualItems('x', [{ goodId: '', amount: '1' }]).error, /Позиция 1.*товар/);
  assert.match(ctx.ecoParseManualItems('x', [{ goodId: '3', amount: '0' }]).error, /Позиция 1.*количество/);
  assert.match(ctx.ecoParseManualItems('x', [{ goodId: '3', amount: '1' }, { goodId: '3', amount: 'abc' }]).error, /Позиция 2/);
});

test('ecoPriceValue: пустое — снять, мусор и ≤0 — ошибка', () => {
  assert.deepStrictEqual(plain(ctx.ecoPriceValue('')), { value: null });
  assert.deepStrictEqual(plain(ctx.ecoPriceValue(' 12,5 ')), { value: 12.5 });
  assert.ok(ctx.ecoPriceValue('0').error);
  assert.ok(ctx.ecoPriceValue('abc').error);
});

test('ecoCoverageHint: подпись услуги в покрытии', () => {
  assert.strictEqual(ctx.ecoCoverageHint({ visits: 12, consumables_share: 0.5 }), '12 визитов · списания у 50,0%');
});

test('ecoIsDate: только реальные YYYY-MM-DD', () => {
  assert.strictEqual(ctx.ecoIsDate('2026-10-18'), true);
  assert.strictEqual(ctx.ecoIsDate('2026-02-30'), false);
  assert.strictEqual(ctx.ecoIsDate('18.10.2026'), false);
  assert.strictEqual(ctx.ecoIsDate(''), false);
  assert.strictEqual(ctx.ecoIsDate(null), false);
});

const schemeLine = (o) => ({ percent: '15', base: 'gross', mult: '', fixed: '', categories: [100], services: [], ...o });
const schemeForm = (o) => ({ title: ' Инъекции ', note: '', lines: [schemeLine()], names: {}, ...o });
test('ecoParseSchemeForm: тело ровно как у parsePayScheme бэкенда', () => {
  const r = plain(ctx.ecoParseSchemeForm(schemeForm({ lines: [schemeLine({ percent: '27,5', mult: '1,494', fixed: '500' }), schemeLine({ categories: [], services: ['10', 10, 11], base: 'net_of_materials' })] })));
  assert.deepStrictEqual(r, { value: { title: 'Инъекции', note: '', lines: [
    { percent: 27.5, base: 'gross', payrollMultiplier: 1.494, fixedPerVisit: 500, categories: [100], services: [] },
    { percent: 15, base: 'net_of_materials', payrollMultiplier: null, fixedPerVisit: 0, categories: [], services: [10, 11] },
  ] } });
});
test('ecoParseSchemeForm: ошибки', () => {
  assert.match(ctx.ecoParseSchemeForm(schemeForm({ title: '' })).error, /назван/i);
  assert.match(ctx.ecoParseSchemeForm(schemeForm({ lines: [] })).error, /лини/i);
  assert.match(ctx.ecoParseSchemeForm(schemeForm({ lines: [schemeLine({ percent: '101' })] })).error, /Линия 1: процент/);
  assert.match(ctx.ecoParseSchemeForm(schemeForm({ lines: [schemeLine({ percent: 'abc' })] })).error, /процент/);
  assert.match(ctx.ecoParseSchemeForm(schemeForm({ lines: [schemeLine({ base: 'x' })] })).error, /баз/i);
  assert.match(ctx.ecoParseSchemeForm(schemeForm({ lines: [schemeLine({ mult: '0,9' })] })).error, /ФОТ/);
  assert.match(ctx.ecoParseSchemeForm(schemeForm({ lines: [schemeLine({ fixed: '-5' })] })).error, /фикс/i);
  assert.match(ctx.ecoParseSchemeForm(schemeForm({ lines: [schemeLine(), schemeLine()] })).error, /#100 стоит в линиях 1 и 2/);
  assert.match(ctx.ecoParseSchemeForm(schemeForm({ lines: [schemeLine({ categories: [] }), schemeLine({ categories: [] })] })).error, /остальные услуги/);
  assert.ok(ctx.ecoParseSchemeForm(schemeForm({ note: 'я'.repeat(501) })).error);
});
test('ecoSchemeConflictText подставляет имена из справочника', () => {
  const names = { services: new Map([['5', 'Revi Strong 2 ml']]), categories: new Map([['100', 'Инъекционная косметология']]) };
  assert.strictEqual(ctx.ecoSchemeConflictText({ kind: 'service', id: 5, lines: [0, 2] }, names), 'Услуга «Revi Strong 2 ml» стоит в линиях 1 и 3 — оставьте её в одной');
  assert.strictEqual(ctx.ecoSchemeConflictText({ kind: 'category', id: 100, lines: [0, 1] }, names), 'Категория «Инъекционная косметология» стоит в линиях 1 и 2 — оставьте её в одной');
  assert.strictEqual(ctx.ecoSchemeConflictText({ kind: 'category', id: 7, lines: [0, 1] }, names), 'Категория #7 стоит в линиях 1 и 2 — оставьте её в одной');
  assert.strictEqual(ctx.ecoSchemeConflictText({ kind: 'fallback', id: null, lines: [1, 3] }, names), 'Линия «остальные услуги» может быть только одна (линии 2 и 4)');
});
test('ecoLineText / ecoLineIsFallback / ecoPlural', () => {
  assert.strictEqual(ctx.ecoLineText({ percent: 15, base: 'gross', payroll_multiplier: null, fixed_per_visit: 0, categories: [1, 2, 3], services: [7, 8] }), '15 % от выручки · 3 категории, 2 услуги');
  assert.strictEqual(ctx.ecoLineText({ percent: 20, base: 'net_of_materials', payroll_multiplier: 1.494, fixed_per_visit: 500, categories: [], services: [7] }), '20 % от выручки − материалы · ФОТ ×1,494 · фикс 500 ₽ · 1 услуга');
  assert.strictEqual(ctx.ecoLineText({ percent: 10, base: 'gross', categories: [], services: [] }), '10 % от выручки · остальные услуги');
  assert.strictEqual(ctx.ecoLineIsFallback({ categories: [], services: [] }), true);
  assert.strictEqual(ctx.ecoLineIsFallback({ categories: [1], services: [] }), false);
  assert.strictEqual(ctx.ecoPlural(5, 'категория', 'категории', 'категорий'), 'категорий');
  assert.strictEqual(ctx.ecoPlural(21, 'услуга', 'услуги', 'услуг'), 'услуга');
  assert.strictEqual(ctx.ecoPlural(12, 'услуга', 'услуги', 'услуг'), 'услуг');
});
test('ecoParseAssignmentForm: тело как у parsePayAssignment; ошибки', () => {
  assert.deepStrictEqual(plain(ctx.ecoParseAssignmentForm({ staff: '5', scheme: '3', from: '2026-02-01', to: '', note: ' n ' })), { value: { staffYcId: 5, schemeId: 3, validFrom: '2026-02-01', validTo: null, note: 'n' } });
  assert.match(ctx.ecoParseAssignmentForm({ staff: '', scheme: '3', from: '', to: '', note: '' }).error, /сотрудник/i);
  assert.match(ctx.ecoParseAssignmentForm({ staff: '5', scheme: '', from: '', to: '', note: '' }).error, /схем/i);
  assert.match(ctx.ecoParseAssignmentForm({ staff: '5', scheme: '3', from: '2026-13-01', to: '', note: '' }).error, /дат/i);
  assert.match(ctx.ecoParseAssignmentForm({ staff: '5', scheme: '3', from: '2026-05-02', to: '2026-05-01', note: '' }).error, /период/i);
});
test('ecoAssignmentsOverlap и ecoStaffWithoutScheme', () => {
  const ex = [{ id: 1, staff_yc_id: 5, scheme_id: 1, valid_from: '2026-01-01', valid_to: '2026-06-30' }, { id: 2, staff_yc_id: 5, scheme_id: 2, valid_from: '2026-07-01', valid_to: null }];
  assert.deepStrictEqual(plain(ctx.ecoAssignmentsOverlap(ex, { id: null, staff_yc_id: 5, valid_from: '2026-06-30', valid_to: null })).map(a => a.id), [1, 2]);
  assert.deepStrictEqual(plain(ctx.ecoAssignmentsOverlap(ex, { id: 2, staff_yc_id: 5, valid_from: '2026-07-01', valid_to: null })), []);
  assert.deepStrictEqual(plain(ctx.ecoAssignmentsOverlap(ex, { id: null, staff_yc_id: 6, valid_from: null, valid_to: null })), []);
  const staff = [{ id: 5, name: 'Б', is_active: true }, { id: 6, name: 'В', is_active: true }, { id: 7, name: 'Г', is_active: false }];
  assert.deepStrictEqual(plain(ctx.ecoStaffWithoutScheme(staff, ex, '2026-10-19')), [{ id: 6, name: 'В', is_active: true }]);
  assert.deepStrictEqual(plain(ctx.ecoStaffWithoutScheme(staff, [], '2026-10-19')).map(s => s.id), [5, 6]);
});


const setForm = (o) => ({ mult: '1,3', base: '0', driver: 'minutes', usn: '15', acquiring: [], ...o });
test('ecoParseSettingsForm: тело как у parseSettings', () => {
  const r = plain(ctx.ecoParseSettingsForm(setForm({ base: '1', driver: 'visits', usn: '6', acquiring: [{ account: 'Расчетный счет', value: '1,5' }, { account: 'Наличные', value: '' }] })));
  assert.deepStrictEqual(r, { value: { payrollMultiplier: 1.3, payBaseIncludesBonuses: true, allocationDriver: 'visits', usnRate: 6, acquiring: { 'Расчетный счет': 1.5, 'Наличные': 0 } } });
  assert.strictEqual(plain(ctx.ecoParseSettingsForm(setForm())).value.payBaseIncludesBonuses, false);
});
test('ecoParseSettingsForm: ошибки', () => {
  assert.match(ctx.ecoParseSettingsForm(setForm({ mult: '0,9' })).error, /множител/i);
  assert.match(ctx.ecoParseSettingsForm(setForm({ mult: '3,1' })).error, /множител/i);
  assert.match(ctx.ecoParseSettingsForm(setForm({ mult: '' })).error, /множител/i);
  assert.match(ctx.ecoParseSettingsForm(setForm({ driver: 'x' })).error, /драйвер/i);
  assert.match(ctx.ecoParseSettingsForm(setForm({ usn: '' })).error, /усн/i);
  assert.match(ctx.ecoParseSettingsForm(setForm({ usn: '51' })).error, /усн/i);
  assert.match(ctx.ecoParseSettingsForm(setForm({ acquiring: [{ account: 'A', value: '11' }] })).error, /«A»/);
  assert.match(ctx.ecoParseSettingsForm(setForm({ acquiring: [{ account: 'A', value: 'x' }] })).error, /«A»/);
  assert.ok(ctx.ecoParseSettingsForm(setForm({ acquiring: [{ account: '__proto__', value: '1' }] })).error);
  assert.ok(ctx.ecoParseSettingsForm(setForm({ acquiring: Array.from({ length: 51 }, (_, i) => ({ account: 'k' + i, value: '1' })) })).error);
});

test('ECO_FIXED_CATS совпадает с FIXED_CATEGORIES бэкенда', () => {
  const { FIXED_CATEGORIES } = require('../../../backend/services/economics/fixed-categories');
  assert.strictEqual(Object.keys(plain(k('ECO_FIXED_CATS'))).length, 9);
  assert.deepStrictEqual(Object.keys(plain(k('ECO_FIXED_CATS'))).sort(), [...FIXED_CATEGORIES].sort());
});

test('ecoNextMonth / ecoFixedForMonth / ecoFixedMonths', () => {
  assert.strictEqual(ctx.ecoNextMonth('2026-10'), '2026-11');
  assert.strictEqual(ctx.ecoNextMonth('2026-12'), '2027-01');
  const rows = [{ month_from: '2026-01-01', month_to: null, amount_month: '300000.00' }, { month_from: '2026-03-01', month_to: '2026-05-01', amount_month: '1000' }];
  assert.strictEqual(plain(ctx.ecoFixedForMonth(rows, '2026-04')).length, 2);
  assert.strictEqual(plain(ctx.ecoFixedForMonth(rows, '2026-06')).length, 1);
  assert.strictEqual(plain(ctx.ecoFixedForMonth(rows, '2025-12')).length, 0);
  assert.deepStrictEqual(plain(ctx.ecoFixedMonths(rows, '2026-10-18')), ['2026-10', '2026-03', '2026-01']);
  assert.strictEqual(ctx.ecoFixedTotal(rows), 301000);
});

test('ecoParseFixedForm: тело как у parseFixedCost', () => {
  const ok = plain(ctx.ecoParseFixedForm({ category: 'rent', title: ' Аренда ', amount: '300 000'.replace(' ', ''), from: '2026-01', to: '', note: '' }));
  assert.deepStrictEqual(ok.value, { category: 'rent', title: 'Аренда', amountMonth: 300000, monthFrom: '2026-01', monthTo: null, note: '' });
  assert.ok(ctx.ecoParseFixedForm({ category: 'x', amount: '1', from: '2026-01' }).error);
  assert.ok(ctx.ecoParseFixedForm({ category: 'rent', amount: '', from: '2026-01' }).error, 'пустая сумма — не 0');
  assert.ok(ctx.ecoParseFixedForm({ category: 'rent', amount: '-5', from: '2026-01' }).error);
  assert.ok(ctx.ecoParseFixedForm({ category: 'rent', amount: '5', from: '2026-13' }).error);
  assert.ok(ctx.ecoParseFixedForm({ category: 'rent', amount: '5', from: '2026-05', to: '2026-04' }).error);
  assert.ok(ctx.ecoParseFixedForm({ category: '__proto__', amount: '5', from: '2026-05' }).error);
  assert.strictEqual(ctx.ecoParseFixedForm({ category: 'rent', amount: '1,5', from: '2026-05', to: '2026-06' }).value.amountMonth, 1.5);
});

test('ecoParseEquipmentForm: тело как у parseEquipment', () => {
  const ok = plain(ctx.ecoParseEquipmentForm({ name: ' Lumecca ', price: '5050000', date: '', life: '60', residual: '', maint: '', serviceIds: ['5', 5, '7'], active: '1', note: '' }));
  assert.deepStrictEqual(ok.value, { name: 'Lumecca', purchasePrice: 5050000, purchaseDate: null, usefulLifeMonths: 60, residualPct: 0, maintenanceMonthly: 0, serviceIds: [5, 7], isActive: true, note: '' });
  assert.strictEqual(ctx.ecoParseEquipmentForm({ name: 'A', price: '1', life: '12', serviceIds: [], active: '0' }).value.isActive, false);
  for (const bad of [{ name: '' }, { price: '' }, { price: 'x' }, { life: '0' }, { life: '12.5' }, { life: '241' }, { residual: '101' }, { maint: '-1' }, { date: '2026-02-30' }, { serviceIds: ['abc'] }, { serviceIds: ['0'] }]) {
    const f = { name: 'A', price: '10', life: '60', serviceIds: [], ...bad };
    assert.ok(ctx.ecoParseEquipmentForm(f).error, JSON.stringify(bad));
  }
});

test('ecoSeedBody: строка сида → тело POST', () => {
  assert.deepStrictEqual(plain(ctx.ecoSeedBody({ name: 'X', purchase_price: 0, useful_life_months: 36, note: 'n' })), { name: 'X', purchasePrice: 0, usefulLifeMonths: 36, note: 'n', serviceIds: [] });
});

test('второе ревью п.5: ecoMskDate — московская дата из TIMESTAMPTZ, ДД.ММ.ГГГГ', () => {
  assert.strictEqual(ctx.ecoMskDate('2026-10-18T22:30:00.000Z'), '19.10.2026');
  assert.strictEqual(ctx.ecoMskDate('2026-10-18T20:59:59Z'), '18.10.2026');
  assert.strictEqual(ctx.ecoMskDate('2026-10-18'), '18.10.2026');   // голая дата — как есть, без сдвига
  assert.strictEqual(ctx.ecoMskDate(null), '');
  assert.strictEqual(ctx.ecoMskDate('мусор'), '');
});

test('второе ревью п.9: ecoDictsCacheable — пустой/degraded справочник не кэшируется', () => {
  assert.strictEqual(ctx.ecoDictsCacheable({ services: [{ id: 1 }], staff: [], categories: [], degraded: false }), true);
  assert.strictEqual(ctx.ecoDictsCacheable({ services: [{ id: 1 }], staff: [], categories: [], degraded: true }), false);
  assert.strictEqual(ctx.ecoDictsCacheable({ services: [], staff: [], categories: [] }), false);
  assert.strictEqual(ctx.ecoDictsCacheable(null), false);
});

test('Task 22: ecoWarningLines — тексты предупреждений без HTML, даты по Москве, порядок как у сервера', () => {
  const lines = plain(ctx.ecoWarningLines([
    { type: 'sync_gap', days: ['2026-10-01', '2026-10-08', '2026-10-16'], visits: 170 },
    { type: 'no_consumables', service_yc_id: 10, service_title: 'Ботокс <лоб>', count: 3, record_ids: [1, 2, 3], last_date: '2026-09-12' },
    { type: 'overrun', service_yc_id: 10, service_title: 'S', record_id: 7, visit_date: '2026-09-10', staff_name: 'Пери', fact: 1300, norm: 1000, ratio: 1.3 },
    { type: 'no_price', good_id: 7, good_title: 'Игла', visits: 10 },
    { type: 'price_jump', good_id: 8, good_title: 'Гель', prev: 100, prev_at: '2026-08-05', last: 130.5, ratio: 1.31, at: '2026-09-05' },
    { type: 'чужое' },
  ]));
  assert.deepStrictEqual(lines, [
    { type: 'sync_gap', text: 'Списания не загружены за 3 дня (01.10.2026 – 16.10.2026, 170 визитов): ни у одной записи этих дней нет списаний YClients — материалы по ним показаны по норме; ночной проход дотянет данные сам, вручную — догон scripts/economics-backfill-goods.js' },
    { type: 'no_consumables', text: '«Ботокс <лоб>»: 3 визита без списаний, хотя у услуги есть техкарта (последний 12.09.2026)' },
    { type: 'overrun', text: '«S», визит 10.09.2026 (Пери): материалы 1 300 ₽ при норме 1 000 ₽ — ×1,3' },
    { type: 'no_price', text: 'Товар без цены: «Игла» — списан в 10 визитах, цены нет ни в приходах, ни вручную, ни в каталоге' },
    { type: 'price_jump', text: 'Цена поступления выросла: «Гель» 100 → 130,5 ₽ за ед. списания (×1,31; приход 05.09.2026 против 05.08.2026)' },
  ]);
  assert.deepStrictEqual(plain(ctx.ecoWarningLines(null)), []);
  assert.strictEqual(ctx.ecoPlural(1, 'визит', 'визита', 'визитов'), 'визит');
  assert.strictEqual(ctx.ecoPlural(12, 'визит', 'визита', 'визитов'), 'визитов');
  assert.strictEqual(ctx.ecoPlural(22, 'визит', 'визита', 'визитов'), 'визита');
});

test('Task 22: ecoRenderWarnings — экранирует и режет список', () => {
  // esc() из utils.js ходит в DOM: минимальный document с семантикой textContent → innerHTML.
  ctx.document = { createElement: () => { let t = ''; return { set textContent(v) { t = String(v); }, get innerHTML() { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }; } };
  const el = { innerHTML: '' };
  const w = Array.from({ length: 35 }, (_, i) => ({ type: 'no_price', good_id: i, good_title: `<b>${i}</b>`, visits: 1 }));
  ctx.ecoRenderWarnings(w, el);
  assert.ok(el.innerHTML.includes('Предупреждения (35)'));
  assert.ok(el.innerHTML.includes('&lt;b&gt;0&lt;/b&gt;'));
  assert.ok(!el.innerHTML.includes('<b>0</b>'));
  assert.ok(el.innerHTML.includes('… и ещё 5'));
  ctx.ecoRenderWarnings([], el);
  assert.strictEqual(el.innerHTML, '');
  delete ctx.document;
});
