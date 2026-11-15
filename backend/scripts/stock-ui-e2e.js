'use strict';
// Browser acceptance against the real stock router and isolated PostgreSQL TEMP tables.
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict'),
  puppeteer = require('puppeteer');
const { withEnvironment } = require('./stock-e2e');
const { pool } = require('../db');
const root = path.join(__dirname, '../../frontend');
async function browserCheck({ app, base, token, request, q }) {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const section = html.slice(
    html.indexOf('    <div class="page" id="page-stock">'),
    html.indexOf('    <div class="page" id="page-economics">'),
  );
  const dialogs = [...html.matchAll(/<dialog id="stock\w+Modal"[\s\S]*?<\/dialog>/g)].map((m) => m[0]).join('');
  const files = [
    'core/utils.js',
    'core/api.js',
    ...[
      'economics-table',
      'economics',
      'journal',
      'journal-card',
      'journal-grid',
      'journal-forms',
      'journal-payment',
      'journal-dispatch',
      'journal-visits',
      'journal-loyalty',
      'journal-chat',
      'journal-stock',
      'stock',
      'stock-balances',
      'stock-docs',
      'stock-sale',
      'stock-inventory',
      'stock-refs',
      'clients',
    ].map((f) => 'pages/' + f + '.js'),
  ];
  app.get('/__stock-test', (_, res) =>
    res
      .type('html')
      .send(
        `<!doctype html><html><head><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/stock.css"><link rel="stylesheet" href="/css/journal.css"><link rel="stylesheet" href="/css/ivory-brass.css"><style>#page-stock{display:block}*{transition:none!important;animation:none!important}body{padding:20px}</style></head><body>${section}${dialogs}<div id="ecoTechCards"></div><dialog id="jrModal" class="stock-modal"><div id="jrModalBody"></div></dialog><div id="testPurchases"></div><script>window.ME={role:'owner'};window.showLbar=()=>{};window.notify=()=>{};window.addEventListener('hashchange',()=>stockOnHashArg(location.hash.replace(/^#stock\\/?/,'')));</script>${files.map((f) => `<script src="/js/${f}"></script>`).join('')}<script>window.showLbar=()=>{};window.notify=()=>{};</script></body></html>`,
      ),
  );
  // Economics rendering is already separately tested; only its read-only API data is stubbed here.
  // The sale dialog searches clients through the staff API. Keep this fixture
  // read-only and synthetic instead of mounting the production clients router.
  app.get('/api/clients', (req, res) => {
    const q = String(req.query.search || '').toLowerCase();
    const clients = [{ id: 1, name: 'Synthetic Client', phone: '+79990000001', email: 'synthetic@example.test' }];
    res.json({ clients: clients.filter((c) => !q || c.name.toLowerCase().includes(q) || c.phone.includes(q)), total: 1, page: 1 });
  });
  app.get('/api/economics/coverage', (_, res) => res.json({ services: [], summary: {} }));
  app.get('/api/economics/tech-cards', async (_, res) =>
    res.json({ cards: await require('../services/economics/store').listTechCards(1) }),
  );
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());
    await page.evaluateOnNewDocument((t) => localStorage.setItem('lp_tk', t), token());
    await page.goto(base + '/__stock-test#stock', { waitUntil: 'networkidle0' });
    await page.evaluate(() => loadStock());
    for (const width of [1280, 390])
      for (const theme of ['light', 'dark']) {
        await page.setViewport({ width, height: 1000 });
        await page.evaluate((t) => {
          document.documentElement.dataset.theme = t;
          document.documentElement.dataset.skin = t === 'light' ? 'ivory' : '';
        }, theme);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          'page overflow',
        );
        await page.screenshot({ path: `/tmp/stock-${theme}-${width}.png`, fullPage: true });
      }
    await page.evaluate(() => stockDocumentOpen('receipt'));
    assert.equal(
      await page.$eval('#stockDocModal', (el) => el.open),
      true,
      'Receipt dialog: ' + (await page.$eval('#stockStatus', (el) => el.textContent)) + ' errors=' + errors.join(';'),
    );
    await page.select('#stockDocStorage', '1');
    await page.evaluate(() => stockLineGood('stockDoc', 0, '1 — Synthetic <cream>'));
    await page.$eval('#stockDocLines [data-field="qty"]', (el) => (el.value = '10'));
    await page.$eval('#stockDocLines [data-field="costPerUnit"]', (el) => (el.value = '2'));
    await page.click('#stockDocSave');
    await page
      .waitForFunction(() => !document.getElementById('stockDocModal').open, { timeout: 5000 })
      .catch(async () => {
        throw new Error('Receipt save: ' + (await page.$eval('#stockDocError', (el) => el.textContent)));
      });
    console.log('browser receipt passed');
    assert.equal(Number((await request('GET', '/balances'))[0].qty_base), 10);
    await page.evaluate(() => stockSaleOpen({ clientId: 1, recordId: 90, staffYcId: 30 }));
    await page.waitForSelector('#stockSaleModal[open]');
    await page.evaluate(() => stockLineGood('stockSale', 0, '1 — Synthetic <cream>'));
    await page.$eval('#stockSaleCash', (el) => (el.value = '9'));
    await page.click('#stockSaleSave');
    await page.waitForFunction(() => document.getElementById('stockSaleError').textContent.length > 0);
    assert.equal((await request('GET', '/clients/1/purchases')).length, 0);
    await page.$eval('#stockSaleCash', (el) => (el.value = '10'));
    await page.click('#stockSaleSave');
    await page.waitForFunction(() => !document.getElementById('stockSaleModal').open);
    console.log('browser sale passed');
    const purchases = await request('GET', '/clients/1/purchases');
    assert.equal(purchases.length, 1);
    await page.evaluate(
      (rows) => (document.getElementById('testPurchases').innerHTML = cdPurchasesHtml(rows)),
      purchases,
    );
    assert.equal(await page.$eval('#testPurchases', (el) => el.querySelectorAll('cream').length), 0);
    await page.evaluate((id) => stockOpenDocument(id), purchases[0].id);
    await page.type('#stockCancelReason', 'Synthetic cleanup');
    await page.evaluate((id) => stockCancelDocument(id), purchases[0].id);
    console.log('browser cancel passed');
    await page.evaluate(() => stockDocumentClose());
    await page.setViewport({ width: 928, height: 677 });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; document.documentElement.dataset.skin = ''; });
    await page.evaluate(() => stockSaleOpen());
    await page.type('#stockSaleClientSearch', 'Synthetic');
    await page.waitForSelector('[data-stock-sale-client="0"]');
    await page.click('[data-stock-sale-client="0"]');
    await page.waitForFunction(() => document.getElementById('stockSaleName').value === 'Synthetic client');
    assert.equal(await page.$eval('#stockSaleEmail', el => el.readOnly), true);
    assert.equal(await page.$eval('#stockSaleClientSearchLabel', el => el.hidden), true);
    await page.evaluate(() => stockSaleShowGoods());
    await page.click('[data-stock-sale-good="1"]');
    await page.$eval('#stockSaleLines [data-field="qty"]', el => { el.value = '2'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.$eval('#stockSaleLines [data-field="discount"]', el => { el.value = '10'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.match(await page.$eval('#stockSaleTotal', el => el.textContent), /18,00/);
    for (const width of [928, 390]) for (const theme of ['light', 'dark']) {
      await page.setViewport({ width, height: width === 928 ? 677 : 844 });
      await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
      assert.equal(await page.$eval('#stockSaleBody', el => el.scrollWidth <= el.clientWidth + 1), true, 'sale body horizontal overflow');
      assert.equal(await page.$eval('#stockSaleLines [data-field="discount"]', el => getComputedStyle(el).display !== 'none'), true);
      await page.screenshot({ path: `/tmp/stock-sale-${theme}-${width}.png`, fullPage: true });
    }
    await page.click('#stockSaleSaveUnpaid');
    await page.waitForFunction(() => !document.getElementById('stockSaleModal').open);
    const debtSale = (await request('GET', '/clients/1/purchases')).find(d => d.status === 'posted');
    assert.ok(debtSale);
    assert.equal((await request('GET', '/documents/' + debtSale.id)).outstandingAmount, 18);
    assert.equal((await request('GET', '/documents/' + debtSale.id)).payments.length, 0);
    await page.evaluate(id => stockOpenDocument(id), debtSale.id);
    await page.$eval('#stockSalePaymentAmount', el => { el.value = '4'; });
    await page.evaluate(id => stockPaySale(id), debtSale.id);
    assert.equal((await request('GET', '/documents/' + debtSale.id)).outstandingAmount, 14);
    await page.select('#stockSalePaymentMethod', 'card');
    await page.evaluate(id => stockPaySale(id), debtSale.id);
    const settled = await request('GET', '/documents/' + debtSale.id);
    assert.equal(settled.outstandingAmount, 0);
    assert.equal(settled.payments.length, 2);
    assert.equal(settled.lines.length, 1);
    assert.equal(Number((await request('GET', '/balances'))[0].qty_base), 8);
    await page.type('#stockCancelReason', 'Synthetic debt cleanup');
    await page.evaluate(id => stockCancelDocument(id), debtSale.id);
    await page.evaluate(() => stockDocumentClose());
    assert.equal(Number((await request('GET', '/balances'))[0].qty_base), 10);
    console.log('browser client selection, readonly identity, goods picker, unpaid sale, partial/full debt payment and cancellation passed');

    for (const tab of ['docs', 'suppliers', 'settings', 'turnover', 'inventory', 'tech-cards']) {
      await page.evaluate((t) => stockSwitchTab(t, false), tab);
      assert.equal(await page.$eval('#stockTab-' + tab, (el) => el.hidden), false);
    }
    console.log('browser tabs passed');
    await page.evaluate(() => stockSwitchTab('inventory', false));
    await page.select('#stockInvStorage', '1');
    await page.evaluate(() => stockNewInventory());
    await page.waitForSelector('[id^="stockInvDiff-"]');
    await page.evaluate(() => stockInventoryChanged(1, '10'));
    await page.evaluate(() => stockPostInventory());
    assert.equal(await page.$eval('#stockInvStatus', (el) => el.textContent), 'Проведено');
    await page.evaluate(() => {
      journal.modalRequest = 1;
      journal.clientSummary = { clientId: 1 };
      const r = { id: 90, staffId: 30, services: [{ id: 20, title: 'Synthetic service', cost: 20 }] };
      document.getElementById('jrModalBody').innerHTML =
        jrAppointmentCard(r) + '<textarea id="syntheticUnsaved">keep me</textarea>';
      jrStockBind(r);
      document.getElementById('jrModal').showModal();
    });
    await page.evaluate(() => jrStockTab('goods'));
    await page.evaluate(() => jrStockSell());
    await page.waitForSelector('#stockSaleModal[open]');
    assert.equal(await page.$eval('#jrModal', (el) => el.open), true);
    await page.screenshot({ path: '/tmp/stock-stacked-dialogs.png', fullPage: true });
    await page.evaluate(() => stockSaleClose());
    await page.evaluate(() => jrStockTab('consumables'));
    await page.evaluate(() => jrStockEdit(20));
    await page.$eval('[data-stock-good="1"]', (el) => (el.value = '4'));
    await page.evaluate(() => jrStockSave(20));
    assert.equal((await request('GET', '/records/90/consumables')).summary.actual, 8);
    await page.evaluate(() => jrStockTab('services'));
    assert.equal(await page.$eval('#syntheticUnsaved', (el) => el.value), 'keep me');
    await page.evaluate(() => document.getElementById('jrModal').close());
    await page.evaluate(() => {
      ME.role = 'admin';
      return loadStock();
    });
    assert.equal(await page.$eval('#stockTabBtn-settings', (el) => el.hidden), true);
    assert.deepEqual(errors, []);
    console.log(
      'PASS browser/real API: all tabs, 2 themes/2 viewports, receipt, sale mismatch/success/cancel, inventory autosave/post, purchases, stacked dialogs, consumable edit, preserved appointment input, admin settings hidden.',
    );
  } finally {
    await browser.close();
  }
}
withEnvironment(browserCheck)
  .catch((e) => {
    console.error('FAIL browser', e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
