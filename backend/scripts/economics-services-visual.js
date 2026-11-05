'use strict';
// Изолированная визуальная проверка вкладок «Экономика → Услуги / Материалы / Техкарты / Оплата труда / Постоянные расходы / Аппараты / Настройки»: настоящие разметка/CSS/JS
// страницы, синтетические ответы /api/economics/*. Без сессий, БД, YClients и отправок.
// node scripts/economics-services-visual.js   → скриншоты в $ECON_SHOTS или /tmp/econ-fix2/
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const puppeteer = require('puppeteer');

const OUT = process.env.ECON_SHOTS || '/tmp/econ-fix2';
const svc = (key, label, o) => ({ key, label, visits: 0, revenue: 0, materials_used: 0, doctor_cost: 0, acquiring_cost: 0, contribution: 0, overhead: 0,
  equipment_cost: 0, operating_profit: 0, usn_estimate: 0, hours: 0, materials_estimated_rows: 0, first_cost: 0, discount: 0, bonus_redeemed: 0, bonus_applied: 0,
  coverage: { rows: 1, with_consumables: 1, with_tech_card: 1, no_pay_rule: 0, no_price_goods: [], acquiring_estimated: 0 }, ...o });
const services = [
  svc(101, 'Биоревитализация Profhilo', { visits: 12, revenue: 298000, materials_used: 96000, doctor_cost: 52000, acquiring_cost: 5900, contribution: 144100, contribution_pct: 0.4836,
    overhead: 18000, equipment_cost: 0, operating_profit: 126100, operating_pct: 0.4232, hours: 9, profit_per_hour: 16011, bonus_redeemed: 7800 }),
  svc(102, 'Лазерная эпиляция <b>бикини</b>', { visits: 30, revenue: 81000, materials_used: 1200, doctor_cost: 16200, acquiring_cost: 1600, contribution: 62000, contribution_pct: 0.765,
    overhead: 22000, equipment_cost: 14000, operating_profit: 26000, operating_pct: 0.321, hours: 15, profit_per_hour: 4133, materials_estimated_rows: 4,
    coverage: { rows: 30, with_consumables: 26, with_tech_card: 30, no_pay_rule: 0, no_price_goods: [], acquiring_estimated: 30 } }),
  svc(103, 'Чистка лица комбинированная', { visits: 8, revenue: 36000, materials_used: 9000, doctor_cost: 14000, acquiring_cost: 700, contribution: 12300, contribution_pct: 0.3417,
    overhead: 16000, equipment_cost: 0, operating_profit: -3700, operating_pct: -0.103, hours: 12, profit_per_hour: 1025,
    coverage: { rows: 8, with_consumables: 0, with_tech_card: 0, no_pay_rule: 3, no_price_goods: [7, 9], acquiring_estimated: 0 } }),
];
const summary = { revenue: 415000, visits: 48, hours: 36, bonus_redeemed: 7800, bonus_applied: 7800, contribution: 218400, contribution_pct: 0.526,
  operating_profit: 148400, operating_pct: 0.357, usn_estimate: 22260, rate_minute_fact: 25.9, rate_minute_capacity: 9.4, idle_cost: 36000,
  coverage: { consumables_share: 0.66, services_without_tech_card: 1, services_total: 3, goods_without_price: [7, 9], staff_without_pay_rule: 1 },
  // Task 22: по одному каждого вида + тег в названии (экранирование)
  warnings: [
    { type: 'no_consumables', service_yc_id: 10, service_title: 'Ботулинотерапия <b>лоб</b>', count: 3, record_ids: [1, 2, 3], last_date: '2026-09-28' },
    { type: 'overrun', service_yc_id: 11, service_title: 'Биоревитализация Profhilo', record_id: 9, visit_date: '2026-09-12', staff_name: 'Гаджиева Пери', fact: 13500, norm: 10534, ratio: 1.28 },
    { type: 'no_price', good_id: 21232086, good_title: 'Игла 0.3 х 13', visits: 10 },
    { type: 'price_jump', good_id: 8, good_title: 'Гель для УЗИ', prev: 0.15, prev_at: '2026-08-05', last: 0.19, ratio: 1.27, at: '2026-09-05' },
  ] };
const detail = {
  service: { ...services[0], first_cost: 309800, price: 298000, discount: 4000, bonus_redeemed: 7800, bonus_applied: 7800, materials_fact: 90000, materials_norm: 96000, doctor_pay: 40000,
    coverage: { acquiring_estimated: 1 }, usn_estimate: 18900 },
  byStaff: [{ label: 'Пери <i>Исамудиновна</i>', visits: 8, revenue: 208000, materials_used: 64000, doctor_cost: 36000, contribution: 104000, contribution_pct: 0.5 },
    { label: 'Татьяна', visits: 4, revenue: 90000, materials_used: 32000, doctor_cost: 16000, contribution: 40100, contribution_pct: 0.4456 }],
  visits: [{ record_id: 1, visit_date: '2026-10-15', staff_name: 'Татьяна', first_cost: 26000, price: 23400, discount: 0, bonus_redeemed: 2600, bonus_applied: 2600, revenue: 23400, materials_used: 8000, doctor_cost: 4300,
    acquiring_cost: 470, contribution: 10630, minutes: 45, materials_estimated: true, no_price_goods: [7], no_pay_rule: false, acquiring_estimated: false },
  { record_id: 2, visit_date: '2026-10-10', staff_name: 'Пери', first_cost: 26000, price: 26000, discount: 0, bonus_redeemed: 0, bonus_applied: 0, revenue: 26000, materials_used: 30000, doctor_cost: 4300,
    acquiring_cost: 520, contribution: -8820, minutes: 45, no_price_goods: [], acquiring_estimated: true }],
  settings: { payroll_multiplier: 1.302, allocation_driver: 'minutes' },
};


const goods = [
  { good_id: 7, title: 'Гель <u>Profhilo</u>', category_title: 'Мезопрепараты', unit: 'уп', service_unit: 'мл', unit_equals: 2, unit_actual_cost: 1200, last_receipt_price: 1350.5, last_receipt_at: '2026-10-01T21:30:00.000Z', override_price: null },
  { good_id: 9, title: 'Перчатки нитриловые', category_title: 'Расходники', unit: 'пара', service_unit: 'пара', unit_equals: 1, unit_actual_cost: 12, last_receipt_price: null, last_receipt_at: null, override_price: 15 },
];
const receipts = [{ yclients_txn_id: 1, create_date: '2026-10-18T22:30:00.000Z', amount: 10, cost: 27010, cost_per_unit: 2701, discount: 5, supplier_title: 'ООО <b>Мед</b>', unit_title: 'уп' }];
const cards = [
  { id: 1, yc_card_id: 55, title: 'Чистка лица (YC)', source: 'yclients', links: 1, items: [{ good_id: 9, title: 'Перчатки нитриловые', amount: 2, unit: 'пара' }] },
  { id: 2, yc_card_id: null, title: 'Норма <i>биоревит</i>', source: 'manual', links: 0, items: [{ good_id: 7, title: 'Гель Profhilo', amount: 1.5, unit: 'мл' }] },
];
const coverage = { cards, services: [
  { service_yc_id: 101, title: 'Биоревитализация Profhilo', visits: 12, consumables_share: 0.9, staff_yc_ids: [1, 2], tech_card: { id: 2, title: 'Норма <i>биоревит</i>', source: 'manual', staff_yc_id: null, items: cards[1].items }, suggestions: [] },
  { service_yc_id: 103, title: 'Чистка лица комбинированная', visits: 8, consumables_share: 0, staff_yc_ids: [1], tech_card: null, suggestions: [{ tech_card_id: 1, title: 'Чистка лица (YC)' }] },
] };
const calls = [];

async function main() {
  const frontend = path.resolve(__dirname, '../../frontend');
  const index = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  const start = index.indexOf('<div class="page" id="page-economics">');
  const end = index.indexOf('<div id="ecoTab-settings"', start);
  const block = index.slice(start, index.indexOf('</div>', end) + 6) + '</div>';
  const app = express();
  app.use(express.json());
  app.use('/api/economics', (q, _r, n) => { if (q.method !== 'GET' || /goods|tech-cards|coverage|pay-rules|settings|sync|fixed-costs|equipment|dictionaries/.test(q.path)) calls.push(`${q.method} ${q.originalUrl}${q.body && Object.keys(q.body).length ? ' ' + JSON.stringify(q.body) : ''}`); n(); });
  app.get('/api/economics/goods', (q, res) => res.json({ goods: goods.filter(g => g.title.toLowerCase().includes(String(q.query.search || '').toLowerCase())) }));
  app.get('/api/economics/goods/:id/receipts', (_q, res) => res.json({ receipts }));
  app.put('/api/economics/goods/:id/price', (_q, res) => res.json({ ok: true }));
  app.get('/api/economics/tech-cards', (_q, res) => res.json({ cards }));
  app.get('/api/economics/coverage', (_q, res) => res.json({ ...coverage }));
  app.put('/api/economics/services/:id/tech-card', (_q, res) => res.json({ ok: true }));
  app.delete('/api/economics/services/:id/tech-card', (_q, res) => res.json({ ok: true, removed: 1 }));
  app.post('/api/economics/services/:id/tech-card/lookup', (_q, res) => res.json({ checked: 2, found: [] }));
  app.post('/api/economics/tech-cards', (_q, res) => res.json({ id: 3 }));
  let rules = [{ id: 1, staff_yc_id: null, service_yc_id: null, category_yc_id: null, percent: '30.00', base: 'gross', fixed_per_visit: '0.00', valid_from: null, valid_to: null, note: 'По умолчанию <b>салон</b>' },
    { id: 2, staff_yc_id: 1, service_yc_id: 101, category_yc_id: null, percent: '45.50', base: 'net_of_materials', fixed_per_visit: '500.00', valid_from: '2026-01-01', valid_to: null, note: '' }];
  let settingsState = { payroll_multiplier: '1.300', pay_base_includes_bonuses: false, allocation_driver: 'minutes', usn_rate: '15.00', acquiring: { 'Расчетный счет': 1.5, 'Старая касса': 2 } };
  let dictCalls = 0;
  app.get('/api/notification-rules/dictionaries', (_q, res) => res.status(410).json({ error: 'экономика не должна ходить сюда' }));
  app.get('/api/economics/dictionaries', (_q, res) => {
    dictCalls++;
    // первый ответ — YClients «не ответил» (degraded): фронт не должен его закэшировать
    if (dictCalls === 1) return res.json({ staff: [{ id: 1, name: 'Пери <i>Исамудиновна</i>', is_active: true }], services: [], categories: [], degraded: true });
    res.json({ staff: [{ id: 1, name: 'Пери <i>Исамудиновна</i>', is_active: true }, { id: 2, name: 'Татьяна', is_active: true }, { id: 4, name: 'Уволенная', is_active: false }],
      services: [{ id: 101, title: 'Биоревитализация Profhilo', in_catalog: true }, { id: 103, title: 'Чистка лица', in_catalog: true }, { id: 104, title: 'Старая услуга', in_catalog: false }], categories: [{ id: 9, title: 'Эпиляция' }], degraded: false });
  });
  app.get('/api/economics/pay-rules', (_q, res) => res.json({ rules }));
  app.post('/api/economics/pay-rules', (q, res) => { rules.push({ id: 3, staff_yc_id: q.body.staffYcId, service_yc_id: q.body.serviceYcId, category_yc_id: q.body.categoryYcId, percent: String(q.body.percent), base: q.body.base, fixed_per_visit: String(q.body.fixedPerVisit), valid_from: q.body.validFrom, valid_to: q.body.validTo, note: q.body.note }); res.json({ id: 3 }); });
  app.put('/api/economics/pay-rules/:id', (_q, res) => res.json({ ok: true }));
  app.delete('/api/economics/pay-rules/:id', (q, res) => { rules = rules.filter(r => r.id !== Number(q.params.id)); res.json({ ok: true }); });
  let fixed = [{ id: 1, category: 'rent', title: 'Аренда <b>2 этаж</b>', amount_month: '300000.00', month_from: '2026-01-01', month_to: null, note: 'Договор <i>№5</i>' },
    { id: 2, category: 'admin', title: 'Администраторы', amount_month: '150000.00', month_from: '2026-09-01', month_to: '2026-10-01', note: '' }];
  app.get('/api/economics/fixed-costs', (_q, res) => res.json({ rows: fixed }));
  app.post('/api/economics/fixed-costs/copy', (q, res) => res.json({ copied: q.query.from === '2026-10' ? 2 : 0 }));
  app.post('/api/economics/fixed-costs', (q, res) => { fixed.push({ id: 3, category: q.body.category, title: q.body.title, amount_month: String(q.body.amountMonth), month_from: q.body.monthFrom + '-01', month_to: q.body.monthTo ? q.body.monthTo + '-01' : null, note: q.body.note }); res.json({ id: 3 }); });
  app.put('/api/economics/fixed-costs/:id', (_q, res) => res.json({ ok: true }));
  app.delete('/api/economics/fixed-costs/:id', (q, res) => { fixed = fixed.filter(r => r.id !== Number(q.params.id)); res.json({ ok: true }); });
  let equip = [];
  const eqMonthly = (b) => ({ total: Math.round(b.purchasePrice * (1 - (b.residualPct || 0) / 100) / b.usefulLifeMonths + (b.maintenanceMonthly || 0)) });
  app.get('/api/economics/equipment/seed', (_q, res) => res.json({ seed: [{ name: 'Lumecca (InMode)', purchase_price: 5050000, useful_life_months: 60, note: 'prosalonoff' }, { name: 'PlaDuo', purchase_price: 0, useful_life_months: 60, note: 'цена не найдена' }] }));
  app.get('/api/economics/equipment', (_q, res) => res.json({ rows: equip.map(e => ({ ...e, monthly: eqMonthly({ purchasePrice: e.purchase_price, residualPct: e.residual_pct, usefulLifeMonths: e.useful_life_months, maintenanceMonthly: e.maintenance_monthly }) })) }));
  app.post('/api/economics/equipment', (q, res) => { const b = q.body; equip.push({ id: equip.length + 1, name: b.name, purchase_price: String(b.purchasePrice), purchase_date: b.purchaseDate || null, useful_life_months: b.usefulLifeMonths, residual_pct: String(b.residualPct || 0), maintenance_monthly: String(b.maintenanceMonthly || 0), service_ids: b.serviceIds, is_active: b.isActive !== false, note: b.note }); res.json({ id: equip.length }); });
  app.put('/api/economics/equipment/:id', (_q, res) => res.json({ ok: true }));
  app.delete('/api/economics/equipment/:id', (q, res) => { equip = equip.filter(r => r.id !== Number(q.params.id)); res.json({ ok: true }); });
  app.get('/api/economics/settings', (_q, res) => res.json({ settings: settingsState, accounts: [{ title: 'Расчетный счет', operations: 120 }, { title: 'Касса <u>1</u>', operations: 40 }] }));
  app.put('/api/economics/settings', (q, res) => res.json({ ok: true, settings: q.body }));
  app.post('/api/economics/sync', (_q, res) => res.json({ ok: false, steps: {}, errors: { catalog: 'лимит' } }));
  app.get('/api/economics/services', (_q, res) => res.json({ services, summary, settings: detail.settings }));
  app.get('/api/economics/services/:id', (_q, res) => res.json(detail));
  app.get('/', (_q, res) => res.type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/features.css"></head>
  <body><main class="content" style="padding:20px;max-width:1400px;margin:auto">${block.replace('class="page"', 'class="page active"')}</main>
  <script src="/js/core/utils.js"></script><script src="/js/pages/economics-table.js"></script><script src="/js/pages/economics.js"></script>
  <script>const _n=[];function notify(t,k){_n.push(t+'|'+(k||''));window._notes=_n};async function api(m,u,b){const r=await fetch(u,{method:m,headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);return j;}
  ecoTodayMsk=()=>'2026-10-18';loadEconomics();</script></body></html>`));
  app.use(express.static(frontend));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  let browser;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewport({ width: 1400, height: 900 });
    const base = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(base, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#ecoServices tr.eco-total');
    assert.equal(await page.$$eval('#ecoSummary .sc', e => e.length), 6);
    assert.equal(await page.$$eval('#ecoServices thead th', e => e.length), 13);
    assert.equal(await page.$$eval('#ecoServices tbody tr.eco-row', e => e.length), 3);
    // экранирование: теги из названий — текст, а не разметка
    assert.equal(await page.$$eval('#ecoServices tbody b', e => e.length), 0);
    assert.ok((await page.$eval('#ecoServices', e => e.textContent)).includes('<b>бикини</b>'));
    const firstLabel = () => page.$eval('#ecoServices tbody tr.eco-row td', e => e.firstChild.textContent);
    assert.equal(await firstLabel(), 'Биоревитализация Profhilo');
    const clickTh = (title) => page.$$eval('#ecoServices thead th', (ths, t) => ths.find(th => th.textContent === t).click(), title);
    await clickTh('Выручка'); // повторный клик → asc
    assert.equal(await firstLabel(), 'Чистка лица комбинированная');
    await clickTh('Прибыль'); // новая колонка → desc
    assert.equal(await firstLabel(), 'Биоревитализация Profhilo');
    assert.equal(await page.$$eval('#ecoServices td.eco-neg', e => e.length) >= 1, true);
    console.log('PASS: сводка 6 плиток, 13 колонок, итог, сортировка, экранирование');
    assert.equal(await page.$$eval('#ecoWarnings li', e => e.length), 4);
    assert.equal(await page.$$eval('#ecoWarnings b', e => e.length), 0);
    const wtxt = await page.$eval('#ecoWarnings', e => e.textContent);
    assert.ok(wtxt.includes('Предупреждения (4)'));
    assert.ok(wtxt.includes('«Ботулинотерапия <b>лоб</b>»: 3 визита без списаний'));
    assert.ok(wtxt.includes('визит 12.09.2026 (Гаджиева Пери)'));
    assert.ok(wtxt.includes('приход 05.09.2026 против 05.08.2026'));
    console.log('PASS: предупреждения — 4 вида, экранирование, московские даты');
    await page.screenshot({ path: `${OUT}/services-light.png`, fullPage: true });
    await (await page.$('#ecoWarnings')).screenshot({ path: `${OUT}/warnings-light.png` });

    // ── Материалы ──
    await page.evaluate(() => { document.documentElement.removeAttribute('data-theme'); });
    await page.click('#ecoTabBtn-goods');
    await page.waitForSelector('#ecoGoodsBody tr td:not(.empty)');
    assert.equal(await page.$$eval('#ecoGoodsBody tr', e => e.length), 2);
    assert.equal(await page.$$eval('#ecoGoods u', e => e.length), 0, 'теги в названии товара экранированы');
    assert.match(await page.$eval('#ecoGoodsBody', e => e.textContent), /1 уп = 2 мл/);
    assert.match(await page.$eval('#ecoGoodsBody', e => e.textContent), /1 350,50/);
    await page.click('#ecoGoodsBody tr button');
    await page.waitForSelector('tr.eco-receipts');
    assert.equal(await page.$$eval('tr.eco-receipts b', e => e.length), 0, 'поставщик экранирован');
    assert.match(await page.$eval('tr.eco-receipts tbody td', e => e.textContent), /^19\.10\.2026$/, 'дата прихода — московская (22:30Z → 19.10)');
    assert.match(await page.$eval('#ecoGoodsBody', e => e.textContent), /02\.10\.2026/, 'последняя закупка — московская дата');
    await page.type('#ecoGoodsBody tr input.eco-price', '99,5'); await page.keyboard.press('Tab');
    await new Promise(r => setTimeout(r, 300));
    assert.ok(calls.some(c => c.startsWith('PUT /api/economics/goods/7/price') && c.includes('"unitPrice":99.5')), 'ручная цена ушла числом');
    await page.type('#ecoGoodsSearch', 'перч'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#ecoGoodsBody tr').length === 1);
    assert.equal(await page.$eval('#ecoGoodsSearch', e => e.value), 'перч', 'поиск не теряет ввод');
    await page.$eval('#ecoGoodsSearch', e => { e.value = ''; }); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#ecoGoodsBody tr').length === 2);
    console.log('PASS: Материалы — таблица, пересчёт упаковки, история, ручная цена, поиск, экранирование');
    await page.screenshot({ path: `${OUT}/goods-light.png`, fullPage: true });

    // ── Техкарты ──
    await page.click('#ecoTabBtn-tech-cards');
    await page.waitForSelector('#ecoTechCards table');
    assert.equal(await page.$$eval('#ecoTechCards i', e => e.length), 0, 'теги в названии нормы экранированы');
    assert.equal(await page.$eval('#ecoTechCards tbody', b => b.rows.length), 2);
    assert.match(await page.$eval('#ecoTechCards', e => e.textContent), /Похоже: Чистка лица \(YC\)/);
    await page.$$eval('#ecoTechCards button', bs => bs.find(b => b.textContent === 'Найти в YClients').click());
    await new Promise(r => setTimeout(r, 300));
    assert.ok(calls.some(c => c.includes('/services/101/tech-card/lookup') && c.includes('"staffYcIds":[1,2]')), 'lookup по исполнителям услуги');
    // плейсхолдер «— выбрать техкарту —» ничего не шлёт
    const callsBefore = calls.length;
    await page.select('#ecoTechCards tbody tr:first-child select', '');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(calls.slice(callsBefore).filter(c => c.includes('/tech-card')).length, 0, 'плейсхолдер не отвязывает');
    // явная отвязка ручной привязки — DELETE после confirm
    page.once('dialog', d => d.accept());
    await page.$$eval('#ecoTechCards button', bs => bs.find(b => b.textContent === 'Отвязать').click());
    await new Promise(r => setTimeout(r, 300));
    assert.ok(calls.some(c => c === 'DELETE /api/economics/services/101/tech-card'), 'отвязка — DELETE');
    assert.match(await page.evaluate(() => window._notes.join('\n')), /Ручная привязка снята/);
    await page.waitForSelector('#ecoTechCards table');
    await page.$$eval('#ecoTechCards button', bs => bs.find(b => b.textContent === '+ Завести норму').click());
    await page.waitForSelector('.eco-man-item');
    await page.$$eval('#ecoTechCards button', bs => bs.find(b => b.textContent === 'Сохранить').click()); // пустая форма — отказ на клиенте
    assert.match(await page.evaluate(() => window._notes.join('\n')), /Укажите название нормы/);
    await page.type('#ecoManTitle', 'Норма теста');
    await page.select('.eco-man-good', '7');
    assert.equal(await page.$eval('.eco-man-unit', e => e.value), 'мл', 'единица подставилась из товара');
    await page.type('.eco-man-amount', '1,5');
    await page.screenshot({ path: `${OUT}/techcards-light.png`, fullPage: true });
    await page.$$eval('#ecoTechCards button', bs => bs.find(b => b.textContent === 'Сохранить').click());
    await new Promise(r => setTimeout(r, 300));
    assert.ok(calls.some(c => c.startsWith('POST /api/economics/tech-cards ') && c.includes('"goodId":7') && c.includes('"amount":1.5')), 'норма ушла');
    console.log('PASS: Техкарты — покрытие, подсказки, lookup, форма нормы с проверкой и подстановкой единицы');

    // ── Оплата труда ──
    await page.evaluate(() => { document.documentElement.removeAttribute('data-theme'); window._notes.length = 0; });
    await page.click('#ecoTabBtn-pay');
    await page.waitForSelector('#ecoPay table tbody tr td:not(.empty)');
    assert.match(await page.evaluate(() => window._notes.join('\n')), /Каталог услуг YClients не ответил/, 'degraded — предупреждение');
    await page.click('#ecoTabBtn-pay');   // повторный заход: degraded не закэширован → новый запрос
    await page.waitForSelector('#ecoPay table tbody tr td:not(.empty)');
    assert.equal(dictCalls, 2, 'degraded-справочник не кэшируется, полный — кэшируется');
    assert.equal(await page.$$eval('#ecoPay tbody tr', e => e.length), 2);
    assert.equal(await page.$$eval('#ecoPay b, #ecoPay i', e => e.length), 0, 'теги в заметке/имени экранированы');
    assert.match(await page.$eval('#ecoPay tbody', e => e.textContent), /салон по умолчанию/);
    assert.match(await page.$eval('#ecoPay tbody', e => e.textContent), /сотрудник: Пери <i>Исамудиновна<\/i> · услуга: Биоревитализация Profhilo/);
    assert.match(await page.$eval('#ecoPay tbody', e => e.textContent), /45,50%/);
    const clickBtn = (sel, text) => page.$$eval(sel, (bs, t) => bs.find(b => b.textContent === t).click(), text);
    await clickBtn('#ecoPay button', '+ Правило');
    await page.waitForSelector('#ecoRPct');
    await page.$eval('#ecoRPct', e => { e.value = '150'; });
    await clickBtn('#ecoRuleForm button', 'Сохранить');
    assert.match(await page.evaluate(() => window._notes.join('\n')), /Процент/);
    assert.match(await page.$eval('#ecoRStaff', e => e.textContent), /Уволенная \(не работает\)/);
    assert.match(await page.$eval('#ecoRService', e => e.textContent), /Старая услуга \(нет в каталоге\)/);
    await page.select('#ecoRService', '103'); await page.select('#ecoRCat', '9');
    await page.$eval('#ecoRPct', e => { e.value = '20,5'; });
    await clickBtn('#ecoRuleForm button', 'Сохранить');
    assert.match(await page.evaluate(() => window._notes.join('\n')), /услугу, либо на категорию/);
    await page.select('#ecoRCat', '');
    await page.select('#ecoRStaff', '2'); await page.select('#ecoRBase', 'net_of_materials');
    await page.screenshot({ path: `${OUT}/pay-light.png`, fullPage: true });
    await clickBtn('#ecoRuleForm button', 'Сохранить');
    await page.waitForFunction(() => document.querySelectorAll('#ecoPay tbody tr').length === 3);
    assert.ok(calls.some(c => c.startsWith('POST /api/economics/pay-rules') && c.includes('"staffYcId":2') && c.includes('"serviceYcId":103') && c.includes('"categoryYcId":null') && c.includes('"percent":20.5') && c.includes('"base":"net_of_materials"') && c.includes('"fixedPerVisit":0')), 'правило ушло в формате бэкенда');
    await clickBtn('#ecoPay button', 'Изменить');
    await page.waitForSelector('#ecoRPct');
    assert.equal(await page.$eval('#ecoRPct', e => e.value), '30');
    await clickBtn('#ecoRuleForm button', 'Сохранить');
    await new Promise(r => setTimeout(r, 300));
    assert.ok(calls.some(c => c.startsWith('PUT /api/economics/pay-rules/1 ')), 'правка уходит PUT');
    page.once('dialog', d => d.accept());
    await page.$$eval('#ecoPay tbody tr:last-child button', bs => bs.find(b => b.textContent === 'Удалить').click());
    await new Promise(r => setTimeout(r, 400));
    assert.ok(calls.some(c => c.startsWith('DELETE /api/economics/pay-rules/3')));
    console.log('PASS: Оплата труда — список, экранирование, проверка формы, POST/PUT/DELETE в формате бэкенда');

    // ── Настройки ──
    await page.click('#ecoTabBtn-settings');
    await page.waitForSelector('#ecoSettings .eco-acq');
    assert.equal(await page.$$eval('#ecoSettings .eco-acq', e => e.length), 3, 'кассы из оплат + сохранённая «Старая касса»');
    assert.equal(await page.$$eval('#ecoSettings u', e => e.length), 0, 'название кассы экранировано');
    assert.equal(await page.$eval('#ecoSMult', e => e.value), '1.3');
    await page.screenshot({ path: `${OUT}/settings-light.png`, fullPage: true });
    await page.$eval('#ecoSUsn', e => { e.value = '70'; });
    await clickBtn('#ecoSettings button', 'Сохранить');
    assert.match(await page.evaluate(() => window._notes.join('\n')), /УСН/);
    await page.$eval('#ecoSUsn', e => { e.value = '6'; });
    await page.select('#ecoSBase', '1'); await page.select('#ecoSDriver', 'visits');
    await page.$$eval('.eco-acq', es => { es[1].value = '1,8'; });
    await clickBtn('#ecoSettings button', 'Сохранить');
    await new Promise(r => setTimeout(r, 300));
    const put = calls.find(c => c.startsWith('PUT /api/economics/settings'));
    assert.ok(put, 'настройки ушли');
    const body = JSON.parse(put.slice(put.indexOf('{')));
    assert.deepEqual(body, { payrollMultiplier: 1.3, payBaseIncludesBonuses: true, allocationDriver: 'visits', usnRate: 6, acquiring: { 'Расчетный счет': 1.5, 'Касса <u>1</u>': 1.8, 'Старая касса': 2 } });
    await clickBtn('#ecoSettings button', '⟳ Синхронизировать с YClients сейчас');
    await new Promise(r => setTimeout(r, 300));
    assert.match(await page.evaluate(() => window._notes.join('\n')), /Синхронизация с ошибками: catalog\|err/);
    console.log('PASS: Настройки — кассы, проверка диапазонов, тело PUT, синк');
    // ── Постоянные расходы ──
    await page.evaluate(() => { document.documentElement.removeAttribute('data-theme'); window._notes.length = 0; });
    await page.click('#ecoTabBtn-fixed');
    await page.waitForSelector('#ecoFixed table tbody tr td:not(.empty)');
    assert.equal(await page.$$eval('#ecoFixed .card', e => e.length), 3, 'блоки: 2026-10 (сегодня), 2026-09, 2026-01');
    assert.equal(await page.$$eval('#ecoFixed b, #ecoFixed i', e => e.length), 0, 'теги в названии/заметке экранированы');
    assert.match(await page.$eval('#ecoFixed', e => e.textContent), /2026-10 · 450 000 ₽ в месяц/);
    assert.match(await page.$eval('#ecoFixed', e => e.textContent), /Аренда <b>2 этаж<\/b>/);
    await page.screenshot({ path: `${OUT}/fixed-light.png`, fullPage: true });
    await clickBtn('#ecoFixed button', '+ Статья');
    await page.waitForSelector('#ecoFAmount');
    await clickBtn('#ecoFixedForm button', 'Сохранить'); // пустая сумма
    assert.match(await page.evaluate(() => window._notes.join('\n')), /Сумма в месяц/);
    await page.select('#ecoFCat', 'cleaning'); await page.type('#ecoFTitle', 'Уборка'); await page.type('#ecoFAmount', '25000,5');
    await clickBtn('#ecoFixedForm button', 'Сохранить');
    await new Promise(r => setTimeout(r, 400));
    assert.ok(calls.some(c => c.startsWith('POST /api/economics/fixed-costs ') && c.includes('"category":"cleaning"') && c.includes('"amountMonth":25000.5') && c.includes('"monthFrom":"2026-10"') && c.includes('"monthTo":null')), 'статья ушла в формате бэкенда');
    await clickBtn('#ecoFixed button', 'Скопировать в 2026-11');
    await new Promise(r => setTimeout(r, 400));
    assert.ok(calls.some(c => c.startsWith('POST /api/economics/fixed-costs/copy?from=2026-10&to=2026-11')), 'копирование месяца');
    assert.match(await page.evaluate(() => window._notes.join('\n')), /Скопировано статей: 2 → 2026-11/);
    page.once('dialog', d => d.accept());
    await page.$$eval('#ecoFixed tbody tr:last-child button', bs => bs.find(b => b.textContent === 'Удалить').click());
    await new Promise(r => setTimeout(r, 400));
    assert.ok(calls.some(c => c.startsWith('DELETE /api/economics/fixed-costs/')));
    console.log('PASS: Постоянные расходы — блоки по месяцам, экранирование, проверка формы, POST/копирование/DELETE');

    // ── Аппараты ──
    await page.click('#ecoTabBtn-equipment');
    await page.waitForSelector('#ecoEqSeed');
    assert.match(await page.$eval('#ecoEquipment', e => e.textContent), /Реестр пуст/);
    await page.click('#ecoEqSeed');
    await page.waitForFunction(() => document.querySelectorAll('#ecoEquipment tbody tr').length === 2 && !document.querySelector('#ecoEquipment tbody td.empty'));
    assert.ok(calls.filter(c => c.startsWith('POST /api/economics/equipment ')).length === 2, 'сид — два POST');
    assert.match(await page.$eval('#ecoEquipment tbody', e => e.textContent), /84 167 ₽/, 'Lumecca: 5 050 000 / 60');
    assert.equal(await page.$$eval('#ecoEquipment .eco-badge-warn', e => e.length), 2, 'без привязки к услугам — бейдж');
    await page.$$eval('#ecoEquipment button', bs => bs.find(b => b.textContent === 'Изменить').click());
    await page.waitForSelector('#ecoESvc');
    await page.select('#ecoESvc', '101', '103');
    await page.$eval('#ecoELife', e => { e.value = '12.5'; });
    await clickBtn('#ecoEqForm button', 'Сохранить');
    assert.match(await page.evaluate(() => window._notes.join('\n')), /Срок службы/);
    await page.$eval('#ecoELife', e => { e.value = '60'; });
    await page.screenshot({ path: `${OUT}/equipment-light.png`, fullPage: true });
    await clickBtn('#ecoEqForm button', 'Сохранить');
    await new Promise(r => setTimeout(r, 400));
    assert.ok(calls.some(c => c.startsWith('PUT /api/economics/equipment/1 ') && c.includes('"serviceIds":[101,103]') && c.includes('"usefulLifeMonths":60') && c.includes('"purchasePrice":5050000')), 'привязка услуг ушла числами');
    console.log('PASS: Аппараты — сид, расчёт в месяц, привязка услуг, проверка формы');
    assert.equal(await page.evaluate(() => _eco.report), null, 'отчёт сброшен после мутаций');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await new Promise(r => setTimeout(r, 800));
    await page.screenshot({ path: `${OUT}/equipment-dark.png`, fullPage: true });
    await page.click('#ecoTabBtn-fixed'); await page.waitForSelector('#ecoFixed table'); await new Promise(r => setTimeout(r, 800));
    await page.screenshot({ path: `${OUT}/fixed-dark.png`, fullPage: true });
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));

    // после сохранения отчёт «Услуг» перезапрашивается
    const before = await page.evaluate(() => _eco.report);
    assert.equal(before, null, 'кэш отчёта сброшен после сохранения');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await new Promise(r => setTimeout(r, 800));
    await page.screenshot({ path: `${OUT}/settings-dark.png`, fullPage: true });
    await page.click('#ecoTabBtn-pay'); await page.waitForSelector('#ecoPay table'); await new Promise(r => setTimeout(r, 800));
    await page.screenshot({ path: `${OUT}/pay-dark.png`, fullPage: true });
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));

    await page.click('#ecoTabBtn-services');
    await page.waitForSelector('#ecoServices tr.eco-total');
    await page.click('#ecoServices tbody tr.eco-row');
    await page.waitForSelector('#ecoDetail .eco-detail');
    assert.equal(await page.$$eval('#ecoDetail table', e => e.length), 3);
    assert.equal(await page.$$eval('#ecoDetail i', e => e.length), 0);
    const pl = await page.$eval('#ecoDetail .eco-pl', e => e.textContent);
    assert.match(pl, /списано 7 800 ₽, из них 7 800 ₽ уже учтено YClients/);
    console.log('PASS: детализация — 3 таблицы, бонусы, экранирование');
    await page.screenshot({ path: `${OUT}/detail-light.png`, fullPage: true });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await new Promise(r => setTimeout(r, 800)); // дождаться transition темы
    await page.screenshot({ path: `${OUT}/detail-dark.png`, fullPage: true });
    const wb = await page.$('#ecoWarnings'); await wb.screenshot({ path: `${OUT}/warnings-dark.png` });
    await page.click('#ecoTabBtn-tech-cards'); await page.waitForSelector('#ecoTechCards table');
    await new Promise(r => setTimeout(r, 800));
    await page.screenshot({ path: `${OUT}/techcards-dark.png`, fullPage: true });
    const activeTab = await page.$eval('#ecoTabBtn-tech-cards', e => { const c = getComputedStyle(e); return { bg: c.backgroundColor, color: c.color }; });
    const lum = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map(Number); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
    assert.ok(Math.abs(lum(activeTab.bg) - lum(activeTab.color)) > 0.4, `активная вкладка в тёмной теме нечитаема: ${JSON.stringify(activeTab)}`);
    await page.click('#ecoTabBtn-goods'); await new Promise(r => setTimeout(r, 300));
    await page.screenshot({ path: `${OUT}/goods-dark.png`, fullPage: true });
    console.log('PASS: тёмная тема — активная вкладка контрастна');
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
    await page.goto(base, { waitUntil: 'networkidle0' }); await page.waitForSelector('#ecoServices tr.eco-total');
    const cols = await page.$eval('#ecoSummary', e => getComputedStyle(e).gridTemplateColumns.split(' ').length);
    assert.equal(cols, 2);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 0, `страница шире экрана на ${overflow}px`);
    assert.ok(await page.$eval('#ecoServices .tw', e => e.scrollWidth > e.clientWidth), 'таблица листается внутри .tw');
    await page.screenshot({ path: `${OUT}/services-390.png`, fullPage: true });
    await (await page.$('#ecoWarnings')).screenshot({ path: `${OUT}/warnings-390.png` });
    console.log('PASS: 390px — сводка в 2 колонки, таблица листается в .tw, страница не шире экрана');
    const tabsBox = await page.$eval('.eco-tabs', e => ({ sw: e.scrollWidth, cw: e.clientWidth, right: e.getBoundingClientRect().right }));
    assert.ok(tabsBox.right <= 390 + 1, `полоса вкладок вылезает за экран: ${JSON.stringify(tabsBox)}`);
    assert.ok(tabsBox.sw > tabsBox.cw, 'полоса вкладок листается горизонтально');
    for (const t of ['goods', 'tech-cards', 'pay', 'fixed', 'equipment', 'settings']) {
      await page.click(`#ecoTabBtn-${t}`); await new Promise(r => setTimeout(r, 500));
      const ov = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(ov <= 0, `${t}: страница шире экрана на ${ov}px`);
      await page.screenshot({ path: `${OUT}/${t}-390.png`, fullPage: true });
    }
    console.log('PASS: 390px — полоса вкладок в пределах экрана и листается, Материалы/Техкарты не раздувают страницу');
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); server.close(); }
}
main().catch(e => { console.error(e); process.exit(1); });
