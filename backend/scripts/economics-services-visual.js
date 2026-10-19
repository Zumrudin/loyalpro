'use strict';
// Изолированная визуальная проверка вкладки «Экономика → Услуги»: настоящие разметка/CSS/JS
// страницы, синтетические ответы /api/economics/*. Без сессий, БД, YClients и отправок.
// node scripts/economics-services-visual.js   → скриншоты в /tmp/econ16/
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const puppeteer = require('puppeteer');

const OUT = '/tmp/econ16';
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

async function main() {
  const frontend = path.resolve(__dirname, '../../frontend');
  const index = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  const start = index.indexOf('<div class="page" id="page-economics">');
  const end = index.indexOf('<div id="ecoTab-settings"', start);
  const block = index.slice(start, index.indexOf('</div>', end) + 6) + '</div>';
  const app = express();
  app.get('/api/economics/services', (_q, res) => res.json({ services, summary, settings: detail.settings }));
  app.get('/api/economics/services/:id', (_q, res) => res.json(detail));
  app.get('/', (_q, res) => res.type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/features.css"></head>
  <body><main class="content" style="padding:20px;max-width:1400px;margin:auto">${block.replace('class="page"', 'class="page active"')}</main>
  <script src="/js/core/utils.js"></script><script src="/js/pages/economics-table.js"></script><script src="/js/pages/economics.js"></script>
  <script>function notify(){};async function api(m,u){const r=await fetch(u);return r.json();}
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
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); server.close(); }
}
main().catch(e => { console.error(e); process.exit(1); });
