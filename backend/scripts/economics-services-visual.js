'use strict';
// Изолированная визуальная проверка вкладок «Экономика → Услуги / Материалы / Техкарты»: настоящие разметка/CSS/JS
// страницы, синтетические ответы /api/economics/*. Без сессий, БД, YClients и отправок.
// node scripts/economics-services-visual.js   → скриншоты в /tmp/econ17/
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const puppeteer = require('puppeteer');

const OUT = '/tmp/econ17';
const svc = (key, label, o) => ({ key, label, visits: 0, revenue: 0, materials_used: 0, doctor_cost: 0, acquiring_cost: 0, contribution: 0, overhead: 0,
  equipment_cost: 0, operating_profit: 0, usn_estimate: 0, hours: 0, materials_estimated_rows: 0, discount: 0, bonus_redeemed: 0, bonus_in_revenue: 0,
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
const summary = { revenue: 415000, visits: 48, hours: 36, bonus_redeemed: 7800, bonus_in_revenue: 0, contribution: 218400, contribution_pct: 0.526,
  operating_profit: 148400, operating_pct: 0.357, usn_estimate: 22260, rate_minute_fact: 25.9, rate_minute_capacity: 9.4, idle_cost: 36000,
  coverage: { consumables_share: 0.66, services_without_tech_card: 1, services_total: 3, goods_without_price: [7, 9], staff_without_pay_rule: 1 } };
const detail = {
  service: { ...services[0], price: 298000, discount: 4000, bonus_in_revenue: 0, materials_fact: 90000, materials_norm: 96000, doctor_pay: 40000,
    coverage: { acquiring_estimated: 1 }, usn_estimate: 18900 },
  byStaff: [{ label: 'Пери <i>Исамудиновна</i>', visits: 8, revenue: 208000, materials_used: 64000, doctor_cost: 36000, contribution: 104000, contribution_pct: 0.5 },
    { label: 'Татьяна', visits: 4, revenue: 90000, materials_used: 32000, doctor_cost: 16000, contribution: 40100, contribution_pct: 0.4456 }],
  visits: [{ record_id: 1, visit_date: '2026-10-15', staff_name: 'Татьяна', price: 23400, bonus_redeemed: 2600, revenue: 23400, materials_used: 8000, doctor_cost: 4300,
    acquiring_cost: 470, contribution: 10630, minutes: 45, materials_estimated: true, no_price_goods: [7], no_pay_rule: false, acquiring_estimated: false },
  { record_id: 2, visit_date: '2026-10-10', staff_name: 'Пери', price: 26000, bonus_redeemed: 0, revenue: 26000, materials_used: 30000, doctor_cost: 4300,
    acquiring_cost: 520, contribution: -8820, minutes: 45, no_price_goods: [], acquiring_estimated: true }],
  settings: { payroll_multiplier: 1.302, allocation_driver: 'minutes' },
};


const goods = [
  { good_id: 7, title: 'Гель <u>Profhilo</u>', category_title: 'Мезопрепараты', unit: 'уп', service_unit: 'мл', unit_equals: 2, unit_actual_cost: 1200, last_receipt_price: 1350.5, last_receipt_at: '2026-10-02T00:00:00.000Z', override_price: null },
  { good_id: 9, title: 'Перчатки нитриловые', category_title: 'Расходники', unit: 'пара', service_unit: 'пара', unit_equals: 1, unit_actual_cost: 12, last_receipt_price: null, last_receipt_at: null, override_price: 15 },
];
const receipts = [{ yclients_txn_id: 1, create_date: '2026-10-02T09:00:00.000Z', amount: 10, cost: 27010, cost_per_unit: 2701, discount: 5, supplier_title: 'ООО <b>Мед</b>', unit_title: 'уп' }];
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
  app.use('/api/economics', (q, _r, n) => { if (q.method !== 'GET' || /goods|tech-cards|coverage/.test(q.path)) calls.push(`${q.method} ${q.originalUrl}${q.body && Object.keys(q.body).length ? ' ' + JSON.stringify(q.body) : ''}`); n(); });
  app.get('/api/economics/goods', (q, res) => res.json({ goods: goods.filter(g => g.title.toLowerCase().includes(String(q.query.search || '').toLowerCase())) }));
  app.get('/api/economics/goods/:id/receipts', (_q, res) => res.json({ receipts }));
  app.put('/api/economics/goods/:id/price', (_q, res) => res.json({ ok: true }));
  app.get('/api/economics/tech-cards', (_q, res) => res.json({ cards }));
  app.get('/api/economics/coverage', (_q, res) => res.json({ ...coverage }));
  app.put('/api/economics/services/:id/tech-card', (_q, res) => res.json({ ok: true }));
  app.post('/api/economics/services/:id/tech-card/lookup', (_q, res) => res.json({ checked: 2, found: [] }));
  app.post('/api/economics/tech-cards', (_q, res) => res.json({ id: 3 }));
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
    await page.screenshot({ path: `${OUT}/services-light.png`, fullPage: true });

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
    console.log('PASS: 390px — сводка в 2 колонки, таблица листается в .tw, страница не шире экрана');
    const tabsBox = await page.$eval('.eco-tabs', e => ({ sw: e.scrollWidth, cw: e.clientWidth, right: e.getBoundingClientRect().right }));
    assert.ok(tabsBox.right <= 390 + 1, `полоса вкладок вылезает за экран: ${JSON.stringify(tabsBox)}`);
    assert.ok(tabsBox.sw > tabsBox.cw, 'полоса вкладок листается горизонтально');
    for (const t of ['goods', 'tech-cards']) {
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
