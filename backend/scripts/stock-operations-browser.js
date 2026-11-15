'use strict';
// Synthetic browser acceptance for the stock operations journal.  It never
// contacts a real backend or uses patient data.
const assert = require('assert/strict');
const express = require('express');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const frontend = path.join(__dirname, '../../frontend');
const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
const pageStock = html.slice(html.indexOf('<div class="page" id="page-stock">'), html.indexOf('<div class="page" id="page-economics">'));
const dialogs = [...html.matchAll(/<dialog id="stock\w+Modal"[\s\S]*?<\/dialog>/g)].map((m) => m[0]).join('');

const operations = Array.from({ length: 52 }, (_, i) => ({
  document_id: Math.floor(i / 4) + 1,
  occurred_at: `2026-11-${String(15 - Math.floor(i / 8)).padStart(2, '0')}T11:2${i % 10}:00+03:00`,
  document_number: `DOC-${String(5000 + Math.floor(i / 4))}`,
  counterparty_name: i % 2 ? 'Синтетический поставщик' : 'Синтетический получатель',
  kind: i % 3 ? 'writeoff' : 'receipt',
  storage_title: i % 2 ? 'Основной склад' : 'Расходники',
  comment: 'Синтетическая операция',
  good_row_id: i + 1,
  good_title: `Товар операции ${i + 1}`,
  article: `ART-${i + 1}`,
  qty_base: i % 2 ? -0.1 - (i % 9) / 100 : 0.1 + (i % 9) / 100,
  qty_pack: i % 2 ? -0.1 - (i % 9) / 100 : 0.1 + (i % 9) / 100,
  unit_title: 'уп.', service_unit_title: 'уп.',
  cost_basis: (i + 1) * 10,
  balance_after: 100 - i,
  service_yc_id: i % 3 === 1 ? 7 : null,
  record_id: i % 4 === 0 ? 700 : null,
  visit_at: i % 4 === 0 ? '2026-11-15T10:00:00+03:00' : null,
}));

function filtered(q) {
  return operations.filter((row) => (!q.search || row.good_title.toLowerCase().includes(String(q.search).toLowerCase())) &&
    (!q.service || String(row.service_yc_id) === String(q.service)) && (!q.kind || row.kind === q.kind));
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use(express.static(frontend));
  app.get('/__stock-operations-test', (_, res) => res.type('html').send(`<!doctype html><html><head>
    <link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/stock.css"><link rel="stylesheet" href="/css/ivory-brass.css">
    <style>#page-stock{display:block}body{padding:20px}*{animation:none!important;transition:none!important}</style>
    </head><body>${pageStock}${dialogs}<script>window.ME={role:'owner'};window.TOKEN='synthetic';window.notify=()=>{};window.navTo=()=>{};window.jrOpen=()=>{};</script>
    <script>window.ecoLoadTechCards=()=>{};</script><script src="/js/pages/stock.js"></script><script src="/js/pages/stock-balances.js"></script><script src="/js/pages/stock-docs.js"></script><script src="/js/pages/stock-sale.js"></script><script src="/js/pages/stock-inventory.js"></script><script src="/js/pages/stock-refs.js"></script>
    </body></html>`));
  app.get('/api/stock/dictionaries', (_, res) => res.json({ storages: [{ id: 1, title: 'Основной склад' }], units: [], suppliers: [], staff: [], categories: [] }));
  app.get('/api/stock/goods', (_, res) => res.json({ goods: [], total: 0 }));
  app.get('/api/stock/documents', (_, res) => res.json({ documents: [], total: 0, limit: 25 }));
  app.get('/api/stock/documents/:id', (req, res) => res.json({ id: Number(req.params.id), kind: 'writeoff', status: 'posted', doc_date: '2026-11-15T11:20:00+03:00', total_cost: 10, lines: [], payments: [] }));
  app.get('/api/stock/goods/:id', (req, res) => res.json({ good: { id: Number(req.params.id), title: `Товар операции ${req.params.id}`, unit: 'уп.', service_unit: 'уп.', unit_equals: 1 }, balances: [], openings: [], receipts: [], techCards: [], movements: { movements: [], total: 0, page: 1, limit: 50 } }));
  app.get('/api/stock/operations/export', (_, res) => res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment('stock-operations.xlsx').send('synthetic-xlsx'));
  app.get('/api/stock/operations/services', (_, res) => res.json({ services: [{ id: 7, title: 'Синтетическая процедура' }] }));
  app.get('/api/stock/documents/:id/history', (_, res) => res.json({ history_since: '2026-11-01T00:00:00+03:00', events: [{ occurred_at: '2026-11-15T11:20:00+03:00', action: 'document_created', actor_name: 'Система', source: 'LoyalPro', changes: { status: { from: null, to: 'posted' } } }] }));
  app.get('/api/stock/operations', (req, res) => {
    const rows = filtered(req.query);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const page = Math.max(1, Number(req.query.page) || 1);
    res.json({ operations: rows.slice((page - 1) * limit, page * limit), total: rows.length, limit, page });
  });

  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());
    await page.goto(`http://127.0.0.1:${server.address().port}/__stock-operations-test#stock/docs`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => loadStock());
    await page.waitForSelector('#stockTab-docs:not([hidden])');
    await page.waitForFunction(() => (document.querySelector('#stockOperationsList') || document.querySelector('.stock-operations-table'))?.textContent.includes('Товар операции 1'));
    await page.setViewport({ width: 1633, height: 1000 });
    for (const selector of ['#stockOperationsForm', '#stockOpsFrom', '#stockOpsTo', '#stockOpsKind', '#stockOpsCounterparty', '#stockOpsStorage', '#stockOpsSearch', '#stockOpsService', '#stockOpsClient', '#stockOpsDocumentNumber', '#stockOpsPaymentStatus', '#stockOpsOrigin', '#stockOpsStatus', '#stockOpsLimit', '#stockOperationsCount', '#stockOperationsList', '#stockOperationsError'])
      assert.ok(await page.$(selector), `missing operations control ${selector}`);
    const table = '.stock-operations-table';
    assert.equal(await page.$$eval(`${table} thead th`, (nodes) => nodes.length), 13, 'operations table has 13 columns');
    assert.equal(await page.$$eval(`${table} tbody tr`, (nodes) => nodes.length), 25, 'default page has 25 rows');
    await page.screenshot({ path: '/tmp/stock-operations-light-1633.png', fullPage: true });
    await page.click('.stock-operations-pagination button:last-child');
    await page.waitForFunction(() => document.querySelector('.stock-operations-table tbody tr')?.textContent.includes('Товар операции 26'));
    assert.match(await page.$eval('.stock-operations-pagination', (el) => el.textContent), /Страница 2 из 3/);
    await page.click('.stock-operations-pagination button:first-child');
    await page.waitForFunction(() => document.querySelector('.stock-operations-table tbody tr')?.textContent.includes('Товар операции 1'));

    const size = await page.$('#stockOpsLimit');
    await size.evaluate((el) => { el.value = '50'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.$eval('#stockOperationsForm', (form) => form.requestSubmit());
    await page.waitForFunction(() => document.querySelectorAll('#stockOperationsList table tbody tr').length === 50);
    const service = await page.$('#stockOpsService');
    await page.select('#stockOpsService', '7');
    await page.$eval('#stockOpsSearch', (el) => { el.value = 'Товар операции 1'; });
    await page.$eval('#stockOperationsForm', (form) => form.requestSubmit());
    await page.waitForFunction(() => document.querySelectorAll('#stockOperationsList table tbody tr').length > 0);
    assert.match(await page.$eval('#stockOperationsList', (el) => el.textContent), /Списание/);
    assert.equal(await page.$$eval('.stock-operations-table tbody tr', (nodes) => nodes.length), 3, 'combined service and search filter returns exact rows');
    const history = await page.$('button[onclick^="stockOpenOperationHistory"]');
    assert.ok(history, 'history control exists');
    const documentLink = await page.$('button[onclick^="stockOpenDocument"]');
    assert.ok(documentLink, 'document link exists');
    await documentLink.click();
    await page.waitForSelector('#stockDocModal[open]');
    assert.match(await page.$eval('#stockDocBody', (el) => el.textContent), /Списание/);
    await page.$eval('#stockDocModal', (el) => el.close());
    const goodLink = await page.$('button[onclick^="stockOpenGood"]');
    assert.ok(goodLink, 'good link exists');
    await goodLink.click();
    await page.waitForSelector('#stockGoodModal[open]');
    await page.$eval('#stockGoodModal', (el) => el.close());
    await history.click();
    await page.waitForSelector('#stockDocModal[open]');
    assert.match(await page.$eval('#stockDocBody', (el) => el.textContent), /Документ создан/);
    await page.$eval('#stockDocModal', (el) => el.close());
    const exportButton = await page.$('button[onclick="stockExportOperations()"]');
    assert.ok(exportButton, 'export control exists');
    const download = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('export response timeout')), 5000);
      const handler = (response) => {
        if (!response.url().includes('/api/stock/operations/export')) return;
        clearTimeout(timer);
        page.off('response', handler);
        resolve(response);
      };
      page.on('response', handler);
    });
    await exportButton.click();
    const exportResponse = await download;
    assert.equal(exportResponse.status(), 200, 'export response is successful');
    assert.match(exportResponse.headers()['content-disposition'] || '', /\.xlsx/);
    await page.click('.stock-operations-menu > summary');
    await page.click('.stock-operations-menu button[onclick="stockDocumentOpen(\'receipt\')"]');
    await page.waitForSelector('#stockDocModal[open]');
    assert.match(await page.$eval('#stockDocBody', (el) => el.textContent), /Приход/);
    await page.$eval('#stockDocModal', (el) => el.close());
    let failNext = true;
    await page.setRequestInterception(true);
    const failHandler = (request) => {
      if (failNext && /\/api\/stock\/operations(?:\?|$)/.test(request.url())) {
        failNext = false;
        request.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Синтетическая ошибка журнала' }) });
      } else request.continue();
    };
    page.on('request', failHandler);
    await page.$eval('#stockOperationsForm', (form) => form.requestSubmit());
    await page.waitForFunction(() => document.body.textContent.includes('Синтетическая ошибка журнала'));
    assert.equal(await page.$$eval('#stockOperationsList table tbody tr', (nodes) => nodes.length), 0, 'error clears stale operations');
    page.off('request', failHandler);
    await page.setRequestInterception(false);
    await page.$eval('#stockOperationsForm', (form) => form.requestSubmit());
    await page.waitForFunction(() => document.querySelectorAll('#stockOperationsList table tbody tr').length > 0);
    await page.$eval('#stockOpsSearch', (el) => { el.value = ''; });
    await page.select('#stockOpsService', '');
    await page.select('#stockOpsLimit', '25');
    await page.$eval('#stockOperationsForm', (form) => form.requestSubmit());
    await page.waitForFunction(() => document.querySelectorAll('#stockOperationsList table tbody tr').length === 25);

    for (const [width, theme] of [[1280, 'light'], [1280, 'dark'], [390, 'light'], [390, 'dark']]) {
      await page.setViewport({ width, height: 1000 });
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; document.documentElement.dataset.skin = t === 'light' ? 'ivory' : ''; }, theme);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `page overflow at ${width}/${theme}`);
      await page.screenshot({ path: `/tmp/stock-operations-${theme}-${width}.png`, fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log('PASS synthetic stock operations: 13 columns, multi-row page, pagination/filter hooks, history/export hooks, four viewports/themes, no page overflow.');
  } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
}
main().catch((error) => { console.error('FAIL synthetic stock operations:', error.stack || error); process.exitCode = 1; });
