'use strict';
// Offline browser acceptance for goods, certificates and memberships embedded
// in an appointment card.  It loads the real journal files, serves only
// synthetic in-page responses, blocks every network request, and never starts
// a server or touches a database.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

const frontend = path.resolve(__dirname, '../../frontend');
const read = file => fs.readFileSync(path.join(frontend, file), 'utf8');
const index = read('index.html');
const journalScripts = [...index.matchAll(/<script src="(js\/pages\/journal[^"?]*\.js)(?:\?[^"']+)?"><\/script>/g)].map(m => m[1]);
const styles = ['css/base.css', 'css/features.css', 'css/ivory-brass.css', 'css/journal.css']
  .map(file => `<style>${read(file)}</style>`).join('\n');
const scripts = journalScripts.map(file => `<script>${read(file)}\n</script>`).join('\n');
const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="https://journal-inline-goods.test/">${styles}</head><body data-page="journal">
<dialog id="jrModal" class="jr-dialog" aria-labelledby="jrModalTitle"><div class="jr-dialog-head"><h2 id="jrModalTitle">Запись</h2><button type="button" aria-label="Закрыть" onclick="jrClose()">×</button></div><div id="jrModalBody"></div><div id="jrModalError" role="alert"></div><div id="jrCloseAsk" hidden></div></dialog>
<script>const TOKEN='synthetic-token';const ME={role:'owner'};function notify(){};function stockMoney(value){return Number(value||0).toLocaleString('ru-RU')+' ₽';}function stockEsc(value){const node=document.createElement('span');node.textContent=String(value??'');return node.innerHTML;}</script>${scripts}</body></html>`;

const RECORD = {
  id: 701, staffId: 11, staffName: 'Синтетический специалист', clientId: 91,
  clientName: 'Синтетический клиент', clientPhone: '79000000001', date: '2030-04-02', time: '11:00',
  duration: 60, attendance: 0, paid: false, paidFull: false, comment: 'Исходный комментарий',
  servicesVersion: 'synthetic-v1', services: [{ id: 1001, title: 'Тестовая услуга', quantity: 1, unitPrice: 1500, cost: 1500 }],
  paymentSummary: { due: 1500, paidConfirmed: 0 },
};
const DICTIONARY = {
  storages: [{ id: 21, title: 'Витрина', is_active: true, for_sale: true }, { id: 22, title: 'Резерв', is_active: true, for_sale: true }],
  categories: [[{ id: 10, title: 'Косметика' }], [{ id: 20, title: 'Подарки' }]],
  staff: [{ id: 11, name: 'Синтетический специалист' }],
};
const CATALOG = [
  { id: 101, title: 'Косметика Synthetic', article: 'COS-1', kind: 'good', sale_price: 1200, unit: 1, category_path: DICTIONARY.categories[0] },
  { id: 102, title: 'Сертификат Synthetic', article: 'CERT-1', kind: 'certificate', loyalty_certificate_type_id: 5, sale_price: 3000, unit: 1, category_path: DICTIONARY.categories[1] },
  { id: 103, title: 'Абонемент Synthetic', article: 'ABO-1', kind: 'abonement', loyalty_abonement_type_id: 7, sale_price: 5000, unit: 1, category_path: DICTIONARY.categories[1] },
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function waitFor(page, selector) { await page.waitForSelector(selector, { timeout: 3000 }); }
async function selectCatalog(page, id) {
  await page.waitForFunction(expected => [...document.querySelectorAll('[data-jr-catalog-good]')].some(b => Number(b.dataset.jrCatalogGood) === expected), { timeout: 3000 }, id);
  await page.$eval(`[data-jr-catalog-good="${id}"]`, el => { el.closest("details").open = true; });
  await page.click(`[data-jr-catalog-good="${id}"]`);
}
async function expectNoOverflow(page, label) {
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, dialog: document.getElementById('jrModal')?.getBoundingClientRect().width || 0 }));
  assert(geometry.page <= geometry.viewport + 1, `${label} overflows horizontally: ${JSON.stringify(geometry)}`);
}

async function main() {
  assert(journalScripts.includes('js/pages/journal-stock.js'), 'index.html must load the inline journal stock script');
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const errors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 960 });
    page.on('pageerror', error => errors.push(error.stack || error.message));
    const unexpected = [];
    await page.setRequestInterception(true);
    page.on('request', request => { unexpected.push(`${request.method()} ${request.url()}`); request.abort(); });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate((record, dictionary, catalog) => {
      const makeUuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      window.__goodsCalls = [];
      window.__savedGoods = { recordId: record.id, version: 0, documents: [], lines: [], total: 0, paid: 0, outstanding: 0 };
      window.__saveAttempts = 0;
      window.__failNextGoodsSave = true;
      window.__codeSequence = 0;
      // The fixture contains only the appointment dialog, not the journal
      // page controls that loadJournal normally refreshes after a save.
      window.loadJournal = () => {};
      window.crypto.randomUUID = () => makeUuid(++window.__codeSequence + 100);
      jrApi = async request => {
        const key = String(request);
        if (key.startsWith('records/')) return structuredClone(record);
        if (key.startsWith('clients/summary')) return { clientId: 91, name: record.clientName, phone: record.clientPhone, visits: { success: 1, fail: 0 }, bonusBalance: 0, lastVisits: [] };
        if (key.startsWith('day-summary')) return { total: 0 };
        return {};
      };
      stockApi = async (url, body, method) => {
        const key = String(url); const verb = method || 'GET';
        window.__goodsCalls.push({ url: key, verb, body: body ? structuredClone(body) : null });
        if (key === '/dictionaries') return structuredClone(dictionary);
        if (key.startsWith('/records/701/goods') && verb === 'GET') return structuredClone(window.__savedGoods);
        if (key.startsWith('/goods?')) {
          const query = new URLSearchParams(key.split('?')[1]);
          const wantedCategory = query.get('category'); const search = (query.get('search') || '').toLowerCase();
          return { goods: catalog.filter(g => {
            const categoryMatches = !wantedCategory || (wantedCategory === '10' ? Number(g.id) === 101 : [102, 103].includes(Number(g.id)));
            return (query.get('storage') !== '21' || Number(g.id) === 101) && categoryMatches && (!search || [g.title, g.article].join(' ').toLowerCase().includes(search));
          }) };
        }
        if (/^\/goods\/\d+\/code-reservations$/.test(key)) {
          const goodId = Number(key.split('/')[2]); const kind = goodId === 102 ? 'certificate' : 'abonement';
          return { id: makeUuid(goodId), value: `${kind === 'certificate' ? 'CERT' : 'ABO'}-SYNTHETIC`, kind, goodRowId: goodId, status: 'reserved' };
        }
        if (key === '/sales/501/payments' && body) {
          const amount = Number(body.amount);
          window.__savedGoods.paid += amount;
          window.__savedGoods.outstanding -= amount;
          window.__savedGoods.documents[0].outstanding -= amount;
          window.__savedGoods.lines[0].paid += amount;
          return { paymentId: body.paymentId, amount, method: body.method };
        }
        if (key === '/records/701/goods' && verb === 'PUT') {
          window.__saveAttempts++;
          if (window.__failNextGoodsSave) { window.__failNextGoodsSave = false; throw new Error('synthetic save failure'); }
          const lines = body.lines.map(line => ({ ...line, title: catalog.find(g => Number(g.id) === Number(line.goodRowId)).title, kind: catalog.find(g => Number(g.id) === Number(line.goodRowId)).kind, paid: Number(line.goodRowId) === 101 ? 50 : 0, code: line.codeReservationId ? { id: line.codeReservationId, value: Number(line.goodRowId) === 102 ? 'CERT-SYNTHETIC' : 'ABO-SYNTHETIC', status: 'issued' } : null }));
          const total = lines.reduce((sum, line) => sum + Number(line.total), 0); const paid = 50;
          window.__savedGoods = { recordId: 701, version: 1, documents: [{ id: 501, storageId: 21, status: 'posted', outstanding: total - paid }], lines, total, paid, outstanding: total - paid };
          return structuredClone(window.__savedGoods);
        }
        throw new Error(`unexpected synthetic stock request: ${verb} ${key}`);
      };
    }, RECORD, DICTIONARY, CATALOG);

    await page.evaluate(() => jrOpen(701));
    await waitFor(page, '#jrModal[open] #jrGoodsLines');
    await page.waitForFunction(() => !!jrStockState.dictionary, { timeout: 3000 });
    assert.equal(await page.$('[onclick*="stockSaleOpen"]'), null, 'inline card must not expose the separate sale modal');

    await page.click('#jrTabGoods');
    await waitFor(page, '#jrGoodsCatalog');
    await page.waitForFunction(() => document.querySelectorAll('#jrGoodsCatalog details').length > 0);
    assert.equal(await page.$$eval('#jrGoodsCatalog details[open]', els => els.length), 0, 'categories start collapsed');
    const gap = await page.evaluate(() => {
      const tabs = document.querySelector('.jr-service-tabs');
      let previous = tabs.previousElementSibling;
      while (previous && getComputedStyle(previous).display === 'none') previous = previous.previousElementSibling;
      return tabs.getBoundingClientRect().top - previous.getBoundingClientRect().bottom;
    });
    assert(gap <= 16, `empty goods sections create a ${gap}px gap`);
    await page.screenshot({ path: '/tmp/journal-goods-collapsed.png' });
    assert.equal(await page.$$eval('[data-jr-catalog-good]', els => els.length), 1, 'first warehouse has only its goods');
    await page.focus('#jrGoodsStorage');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__goodsCalls.some(c => /storage=22/.test(c.url)), { timeout: 2000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-jr-catalog-good]').length === 3);
    await page.select('#jrGoodsCategory', '10');
    await sleep(300);
    assert(await page.evaluate(() => window.__goodsCalls.some(c => /category=10/.test(c.url))), 'category filter did not request category=10');
    await sleep(300);
    const categoryState = await page.evaluate(() => ({ count: document.querySelectorAll('[data-jr-catalog-good]').length, text: document.getElementById('jrGoodsCatalog')?.textContent, catalog: jrStockState.catalog }));
    assert.equal(categoryState.count, 1, `category UI did not render its filtered result: ${JSON.stringify(categoryState)}`);
    assert.equal(await page.$eval('[data-jr-catalog-good]', el => el.dataset.jrCatalogGood), '101');
    await page.$eval('#jrGoodsSearch', el => { el.value = 'cos'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(240);
    await page.waitForFunction(() => window.__goodsCalls.some(c => /search=cos/.test(c.url)), { timeout: 2000 });
    await page.click('#jrTabServices');
    await page.click('#jrTabGoods');
    assert.equal(await page.$eval('#jrGoodsStorage', el => el.value), '22');
    assert.equal(await page.$eval('#jrGoodsCategory', el => el.value), '10');
    assert.equal(await page.$eval('#jrGoodsSearch', el => el.value), 'cos');
    await selectCatalog(page, 101);

    await page.select('#jrGoodsCategory', '20');
    await sleep(300);
    assert(await page.evaluate(() => window.__goodsCalls.some(c => /category=20/.test(c.url))), 'category filter did not request category=20');
    await page.$eval('#jrGoodsSearch', el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(240);
    await selectCatalog(page, 102);
    await selectCatalog(page, 103);
    await page.waitForFunction(() => document.querySelectorAll('[data-jr-good-line]').length === 3, { timeout: 2000 });
    assert.match(await page.$eval('#jrGoodsLines', el => el.textContent), /Косметика Synthetic[\s\S]*Сертификат Synthetic[\s\S]*Абонемент Synthetic/);

    await page.click('[data-jr-good-code="1"]');
    await sleep(80);
    const certificateState = await page.evaluate(() => ({ value: document.querySelector('[data-jr-good-line="1"] .jr-goods-line-code input')?.value, error: document.getElementById('jrGoodsError')?.textContent, calls: window.__goodsCalls }));
    assert.equal(certificateState.value, 'CERT-SYNTHETIC', `certificate-code generation failed: ${JSON.stringify(certificateState)}`);
    await page.click('[data-jr-good-code="2"]');
    await page.waitForFunction(() => document.querySelector('[data-jr-good-line="2"] .jr-goods-line-code input')?.value === 'ABO-SYNTHETIC', { timeout: 2000 });
    // Each input event updates the draft but must not rebuild the card: doing
    // so would blur a number field after its first digit.
    const priceSelector = '[data-jr-good-field="price"][data-jr-good-index="0"]';
    await page.click(priceSelector);
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
    await page.keyboard.type('1234');
    const typedPrice = await page.$eval(priceSelector, el => ({ value: el.value, focused: document.activeElement === el }));
    assert.deepEqual(typedPrice, { value: '1234', focused: true }, 'multi-digit price entry lost focus or a digit');
    await page.click('#jrTabServices');
    await page.click('#jrTabGoods');
    await page.waitForFunction(() => document.querySelectorAll('[data-jr-good-line]').length === 3, { timeout: 2000 });
    assert.equal(await page.$eval(priceSelector, el => el.value), '1234', 'price draft was lost after a tab switch');
    assert.equal(await page.$eval('[data-jr-good-line="1"] .jr-goods-line-code input', el => el.value), 'CERT-SYNTHETIC');

    // First PUT is a synthetic transport failure. The draft must stay rendered
    // and retry exactly the same idempotency key rather than creating a sale twice.
    await page.click('#jrSaveChanges');
    await page.waitForFunction(() => /synthetic save failure/.test(document.getElementById('jrModalError')?.textContent || '') || /synthetic save failure/.test(document.getElementById('jrGoodsError')?.textContent || ''), { timeout: 3000 });
    assert.equal(await page.evaluate(() => jrStockState.dirty), true, 'failed save discarded the goods draft');
    assert.equal(await page.$$eval('[data-jr-good-line]', els => els.length), 3, 'failed save removed selected lines');
    await page.click('#jrSaveChanges');
    await page.waitForFunction(() => window.__goodsCalls.filter(c => c.verb === 'PUT').length >= 2, { timeout: 3000 });
    const saves = await page.evaluate(() => window.__goodsCalls.filter(c => c.verb === 'PUT'));
    assert.equal(saves[0].body.requestId, saves[1].body.requestId, 'retry changed the goods idempotency key');
    assert.equal(saves[1].body.lines.length, 3);
    assert(saves[1].body.lines.every(l => l.goodRowId === 101 || l.codeReservationId), 'certificate or membership save omitted its reservation');

    // Reopen is served from the persisted in-memory response. It proves codes
    // and a partial payment survive a card rerender without any separate modal.
    await page.evaluate(() => jrClose(true));
    await page.evaluate(() => jrOpen(701));
    await waitFor(page, '#jrModal[open] #jrGoodsLines');
    await page.waitForFunction(() => document.querySelectorAll('[data-jr-good-line]').length === 3, { timeout: 3000 });
    assert.equal(await page.$eval('[data-jr-good-line="1"] .jr-goods-line-code input', el => el.value), 'CERT-SYNTHETIC');
    assert.equal(await page.$eval('[data-jr-good-line="2"] .jr-goods-line-code input', el => el.value), 'ABO-SYNTHETIC');
    assert.match(await page.$eval('#jrGoodsLines', el => el.textContent), /Оплачено/);
    await waitFor(page, '[data-jr-good-pay="501"]');
    await page.$eval('[data-jr-good-pay-amount="501"]', el => { el.value = '25'; });
    await page.select('[data-jr-good-pay-method="501"]', 'card');
    await page.click('[data-jr-good-pay="501"]');
    await page.waitForFunction(() => window.__goodsCalls.some(c => c.url === '/sales/501/payments' && c.body?.amount === 25 && c.body?.method === 'card'), { timeout: 3000 });
    const payment = await page.evaluate(() => window.__goodsCalls.find(c => c.url === '/sales/501/payments'));
    assert(payment.body.paymentId, 'partial payment must carry an idempotency key');

    await page.click('#jrTabGoods');
    await page.evaluate(() => document.getElementById('jrGoodsLines')?.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: '/tmp/journal-inline-goods-light-desktop.png', fullPage: true });
    await expectNoOverflow(page, 'light desktop');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.screenshot({ path: '/tmp/journal-inline-goods-dark-desktop.png', fullPage: true });
    await expectNoOverflow(page, 'dark desktop');
    await page.setViewport({ width: 390, height: 844 });
    await sleep(80);
    await page.evaluate(() => document.getElementById('jrGoodsLines')?.scrollIntoView({ block: 'start' }));
    await expectNoOverflow(page, 'dark mobile');
    await page.screenshot({ path: '/tmp/journal-inline-goods-dark-mobile.png', fullPage: true });
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
    await expectNoOverflow(page, 'light mobile');
    await page.screenshot({ path: '/tmp/journal-inline-goods-light-mobile.png', fullPage: true });

    assert.deepEqual(unexpected, [], `unexpected browser requests: ${unexpected.join('; ')}`);
    assert.deepEqual(errors, [], `browser errors: ${errors.join('; ')}`);
    console.log('PASS: offline inline cosmetics/certificate/membership workflow, filters, code persistence, tab draft, retry idempotency, partial payment display, themes and 390px/1440px overflow.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error('FAIL', error.stack || error.message); process.exitCode = 1; });
