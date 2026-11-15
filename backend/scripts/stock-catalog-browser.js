'use strict';
// Local visual acceptance for the stock catalog. It serves only synthetic data;
// no app server, database, or production endpoint is contacted.
const assert = require('assert/strict');
const express = require('express');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const frontend = path.join(__dirname, '../../frontend');
const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
const pageStock = html.slice(html.indexOf('<div class="page" id="page-stock">'), html.indexOf('<div class="page" id="page-economics">'));
const dialogs = [...html.matchAll(/<dialog id="stock\w+Modal"[\s\S]*?<\/dialog>/g)].map((m) => m[0]).join('');
const goods = Array.from({ length: 52 }, (_, i) => ({
  id: i + 1,
  title: i === 30 ? 'Крем по артикулу' : i === 31 ? 'Крем по штрихкоду' : `Синтетический товар ${i + 1}`,
  article: i === 30 ? 'ART-770' : `ART-${i + 1}`,
  barcode: i === 31 ? '4601234567890' : `000${i + 1}`,
  unit: 'шт', service_unit: 'мл', unit_equals: 10,
  local_sale_price: 100 + i, stock_active: true, source: 'loyalpro',
  local_category: i % 2 ? 'Уход' : 'Расходники', comment: i === 1 ? '<не исполняется>' : 'Комментарий', balances: [],
}));

function filtered(query) {
  const search = String(query.search || '').toLowerCase();
  return goods.filter((g) => (!search || [g.title, g.article, g.barcode].some((x) => String(x).toLowerCase().includes(search))) &&
    (query.active !== '0' || !g.stock_active) && (query.active !== '1' || g.stock_active) &&
    (!query.category || String(g.local_category) === String({ 1: 'Уход', 2: 'Расходники' }[query.category] || query.category)));
}
async function main() {
  const app = express();
  app.use(express.json());
  app.use(express.static(frontend));
  app.get('/__stock-catalog-test', (_, res) => res.type('html').send(`<!doctype html><html><head>
    <link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/stock.css"><link rel="stylesheet" href="/css/ivory-brass.css">
    <style>#page-stock{display:block}body{padding:20px}*{animation:none!important;transition:none!important}</style>
    </head><body>${pageStock}${dialogs}<script>window.ME={role:'owner'};window.TOKEN='synthetic';window.notify=()=>{};</script>
    <script>window.ecoLoadTechCards=()=>{};</script><script src="/js/pages/stock.js"></script><script src="/js/pages/stock-balances.js"></script><script src="/js/pages/stock-docs.js"></script><script src="/js/pages/stock-sale.js"></script><script src="/js/pages/stock-inventory.js"></script><script src="/js/pages/stock-refs.js"></script>
    </body></html>`));
  app.get('/api/stock/dictionaries', (_, res) => res.json({ storages: [], units: [], suppliers: [], staff: [], categories: [[{ id: 1, title: 'Уход' }], [{ id: 2, title: 'Расходники' }]] }));
  app.get('/api/stock/goods', (req, res) => res.json({ goods: filtered(req.query) }));
  app.get('/api/stock/documents', (_, res) => res.json({ documents: [], total: 0 }));
  app.get('/api/stock/goods/:id', (req, res) => {
    const good = goods.find((g) => g.id === Number(req.params.id));
    if (!good) return res.status(404).json({ error: 'Нет товара' });
    return res.json({ good, balances: [], openings: [], receipts: [], techCards: [], movements: { movements: [], total: 0, page: 1, limit: 50 } });
  });
  app.put('/api/stock/goods/:id', (req, res) => {
    // ID 2 simulates an ambiguous write, proving the UI stops the batch.
    if (Number(req.params.id) === 2) return res.status(503).json({ error: 'Синтетическая недоступность' });
    const good = goods.find((g) => g.id === Number(req.params.id));
    if (good) good.stock_active = req.body.stockActive !== false;
    return res.json({ good });
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(`${base}/__stock-catalog-test#stock`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => loadStock());
    await page.waitForSelector('#stockTab-goods:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('[data-stock-select-good]').length === 25);
    assert.equal(await page.$eval('#stockTab-goods', (el) => !el.hidden), true, 'default #stock opens goods');
    assert.match(await page.$eval('#stockTab-goods', (el) => el.textContent), /Найдено: 52/);

    for (const [width, theme] of [[1858, 'light'], [1280, 'dark'], [600, 'dark'], [390, 'light']]) {
      await page.setViewport({ width, height: 1000 });
      await page.evaluate((current) => { document.documentElement.dataset.theme = current; document.documentElement.dataset.skin = current === 'light' ? 'ivory' : ''; }, theme);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `page overflow at ${width}px/${theme}`);
      await page.screenshot({ path: `/tmp/stock-catalog-${theme}-${width}.png`, fullPage: true });
    }

    await page.setViewport({ width: 1280, height: 1000 });
    await page.$eval('#stockSearch', (el) => { el.value = 'ART-770'; });
    await page.$eval('#stockFilters', (form) => form.requestSubmit());
    await page.waitForFunction(() => document.querySelector('#stockCatalogContent').textContent.includes('Крем по артикулу'));
    assert.equal(await page.$eval('#stockCatalogContent', (el) => el.textContent.includes('Крем по штрихкоду')), false, 'article search filters catalog');
    await page.$eval('#stockSearch', (el) => { el.value = '4601234567890'; });
    await page.$eval('#stockFilters', (form) => form.requestSubmit());
    await page.waitForFunction(() => document.querySelector('#stockCatalogContent').textContent.includes('Крем по штрихкоду'));

    await page.$eval('#stockSearch', (el) => { el.value = ''; });
    await page.$eval('#stockFilters', (form) => form.requestSubmit());
    await page.waitForFunction(() => document.querySelectorAll('[data-stock-select-good]').length === 25);
    await page.select('#stockPageSize', '50');
    await page.waitForFunction(() => document.querySelectorAll('[data-stock-select-good]').length === 50);
    await page.click('[data-stock-category="1"]');
    await page.waitForFunction(() => document.querySelector('#stockCatalogContent').textContent.includes('Найдено: 26'));
    await page.click('[data-stock-category=""]');
    await page.waitForFunction(() => document.querySelector('#stockCatalogContent').textContent.includes('Найдено: 52'));
    await page.select('#stockPageSize', '25');
    await page.waitForFunction(() => document.querySelectorAll('[data-stock-select-good]').length === 25);
    await page.click('[data-stock-select-page]');
    assert.equal(await page.$$eval('[data-stock-select-good]', (nodes) => nodes.every((node) => node.checked)), true, 'select-all reflects row checkboxes');
    await page.click('[data-stock-select-page]');
    await page.click('[data-stock-select-good="1"]');
    await page.click('[data-stock-page="2"]');
    await page.waitForFunction(() => document.querySelector('#stockCatalogContent').textContent.includes('Страница 2 из 3'));
    assert.equal(await page.$eval('[data-stock-bulk-archive]', (el) => el.disabled), true, 'selection resets on page change');
    await page.click('[data-stock-open-good="26"]');
    await page.waitForSelector('#stockGoodModal[open]');
    await page.screenshot({ path: '/tmp/stock-catalog-card.png', fullPage: true });
    await page.$eval('#stockGoodModal', (el) => el.close());

    await page.evaluate(() => { _stock.catalogPage = 1; _stock.selectedGoods = new Set([1, 2, 3]); stockRenderGoodsCatalog(); });
    await page.click('[data-stock-bulk-archive]');
    await page.waitForFunction(() => document.querySelector('#stockStatus').textContent.includes('Архивировано: 1 из 3'));
    assert.match(await page.$eval('#stockStatus', (el) => el.textContent), /Результат операции неизвестен/);
    await page.click('[data-stock-show-archive]');
    await page.waitForFunction(() => document.querySelectorAll('[data-stock-select-good]').length === 1);
    assert.equal(await page.$eval('#stockActive', (el) => el.value), '0');
    await page.click('[data-stock-show-active]');
    await page.waitForFunction(() => document.querySelector('#stockCatalogContent').textContent.includes('Найдено: 51'));
    assert.deepEqual(errors, []);
    console.log('PASS synthetic stock catalog: default goods, title/article/barcode search, pagination selection reset, card, partial archive, 4 viewports/themes, no overflow.');
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error('FAIL synthetic stock catalog:', error.stack || error); process.exitCode = 1; });
