'use strict';
// Isolated browser acceptance: actual journal HTML/CSS/scripts, synthetic API.
// No app server, database, credentials, or external integrations are used.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../frontend');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

async function main() {
  const index = read('index.html');
  const start = index.indexOf('<div class="page" id="page-journal">');
  const end = index.indexOf('<!-- ── RECORDS', start);
  assert(start > 0 && end > start);
  const scripts = [...index.matchAll(/<script src="(js\/pages\/journal[^"?]*\.js)[^"]*"><\/script>/g)].map(m => m[1]);
  const styles = ['css/journal.css', 'css/base.css', 'css/features.css', 'css/ivory-brass.css'];
  const html = `<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles.map(f => `<link rel="stylesheet" href="/${f}">`).join('')}</head><body data-page="journal"><main style="padding:12px">${index.slice(start, end)}</main><script>const TOKEN='synthetic';const ME={role:'owner'};function notify(){};</script>${scripts.map(f => `<script src="/${f}"></script>`).join('')}<style>#page-journal{display:block!important}body{margin:0}</style></body></html>`;
  const date = '2030-04-02';
  const staff = [
    { id: 1, name: 'Специалист А', working: true, workRanges: [{ start: 600, end: 1320 }] },
    { id: 2, name: 'Специалист Б', working: true, workRanges: [{ start: 600, end: 1320 }] },
    { id: 3, name: 'Специалист В', working: false, workRanges: [] },
  ];
  const records = [{ id: 101, staffId: 1, clientName: 'Тестовый клиент', date, time: '11:00', duration: 60, attendance: 0, services: [{ title: 'Тестовая услуга', cost: 1000 }] }];
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const errors = [], writes = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1654, height: 900 });
    page.on('pageerror', e => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (request.method() !== 'GET') writes.push(url.pathname);
      if (url.origin !== 'https://journal.test') return request.abort();
      const send = (body, type = 'application/json') => request.respond({ status: 200, contentType: type, body: typeof body === 'string' ? body : JSON.stringify(body) });
      if (url.pathname === '/') return send(html, 'text/html');
      if (url.pathname.startsWith('/js/') || url.pathname.startsWith('/css/')) return send(read(url.pathname.slice(1)), url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      if (url.pathname === '/api/journal/day') return send({ date: url.searchParams.get('date'), staff, records, fetchedAt: '2030-04-02T06:00:00Z', unsent: 0 });
      if (url.pathname === '/api/journal/month') return send({ days: [] });
      if (url.pathname === '/api/journal/week') return send({ staff: staff[0], allStaff: staff, days: Array.from({ length: 7 }, (_, i) => ({ date: `2030-04-0${i + 1}`, working: true, workRanges: staff[0].workRanges, records: i === 1 ? records : [] })) });
      if (url.pathname === '/favicon.ico') return request.respond({ status: 204 });
      return send({ date, clientCount: 1, total: 1000, cash: 400, cashless: 600, completedAmount: 1000, bookedAmount: 1000, loyaltyAmount: 0, goodsAmount: 0 });
    });
    await page.goto('https://journal.test/', { waitUntil: 'networkidle0' });
    await page.evaluate(async d => { jrEl('jrDate').value = d; await loadJournal(); }, date);
    assert.equal(await page.$$eval('.jr-visit', nodes => nodes.length), 1);
    assert.equal(await page.$eval('#jrSummaryPlus', el => el.disabled), false);
    assert.equal(await page.$eval('#jrDateLabel', el => el.textContent), '2 апреля, вторник');
    assert.equal(await page.$$eval('.jr-toolbar-popup', nodes => nodes.filter(el => el.getClientRects().length).length), 0);
    await page.screenshot({ path: '/tmp/journal-toolbar-desktop.png' });
    const gridTop = await page.$eval('#jrGrid', el => el.getBoundingClientRect().top);
    await page.click('#jrMonthBtn');
    await page.waitForSelector('#jrMonth .jr-month-day');
    assert.equal(await page.$eval('#jrGrid', el => el.getBoundingClientRect().top), gridTop, 'Calendar must overlay the grid without shifting it');
    assert(await page.evaluate(() => {
      const box = document.querySelector('#jrMonth'), r = box.getBoundingClientRect();
      return box.contains(document.elementFromPoint(r.left + r.width / 2, r.bottom - 10));
    }), 'Calendar must be above the schedule');
    await page.screenshot({ path: '/tmp/journal-toolbar-calendar.png' });
    await page.keyboard.press('Escape');
    await page.click('#jrScaleBtn');
    await page.screenshot({ path: '/tmp/journal-toolbar-scale.png' });
    await page.click('[data-jr-step][value="5"]');
    assert.equal(await page.$eval('.jr-cell', el => Math.round(el.getBoundingClientRect().height)), 24);
    assert.equal(await page.$eval('.jr-visit', el => Math.round(el.getBoundingClientRect().height)), 286);
    await page.click('#jrStatusBtn');
    await page.screenshot({ path: '/tmp/journal-toolbar-status.png' });
    await page.click('[data-jr-status][value="0"]');
    assert.equal(await page.$$eval('.jr-visit', nodes => nodes.length), 0);
    assert(await page.$$eval('.jr-cell-busy', nodes => nodes.length) > 0);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'jrStatusBtn');
    await page.click('#jrMoreBtn');
    await page.click('#jrSearch');
    await page.type('#jrSearch', 'Несуществующая услуга');
    assert.equal(await page.$$eval('.jr-visit', nodes => nodes.length), 0);
    await page.click('#jrScaleBtn');
    assert.equal(await page.$eval('#jrMorePopup', el => el.hidden), true);
    await page.keyboard.press('Escape');
    await page.evaluate(async () => { await jrSetView('week'); });
    await page.waitForFunction(() => !!document.querySelector('.jr-week'));
    await page.evaluate(() => jrSetGridStep(10));
    assert.equal(await page.$$eval('.jr-week .jr-column', nodes => nodes.length), 7);
    assert.equal(await page.$eval('.jr-cell', el => Math.round(el.getBoundingClientRect().height)), 24);
    await page.evaluate(() => jrSetView('day'));
    await page.waitForFunction(() => !!document.querySelector('.jr-calendar:not(.jr-week)'));
    await page.evaluate(() => { jrEl('jrSearch').value=''; journal.statusFilter = new Set([0, 1, -1, 2]); jrSetGridStep(15); });
    await page.click('#jrScheduleAdd');
    assert(await page.$eval('#jrModal', el => el.open));
    await page.screenshot({ path: '/tmp/journal-toolbar-add-staff.png' });
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme','dark'));
    await page.screenshot({ path: '/tmp/journal-toolbar-dark.png' });
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
    await page.evaluate(() => jrClose(true));
    await page.evaluate(async () => { await jrSummaryLoad(jrEl('jrDate').value); });
    await page.click('#jrSummaryBtn');
    await page.screenshot({ path: '/tmp/journal-toolbar-summary.png' });
    await page.keyboard.press('Escape');
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => jrRender());
    await page.screenshot({ path: '/tmp/journal-toolbar-mobile.png' });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.evaluate(() => document.documentElement.setAttribute('data-skin', 'ivory'));
    const mobileGridTop = await page.$eval('#jrGrid', el => el.getBoundingClientRect().top);
    await page.click('#jrMonthBtn');
    await page.waitForSelector('#jrMonth .jr-month-day');
    assert.equal(await page.$eval('#jrGrid', el => el.getBoundingClientRect().top), mobileGridTop);
    assert(await page.$eval('#jrMonth', el => {
      const r=el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth;
    }));
    await page.screenshot({ path: '/tmp/journal-toolbar-calendar-mobile.png' });
    await page.keyboard.press('Escape');
    for (const trigger of ['#jrScaleBtn', '#jrStatusBtn', '#jrMoreBtn', '#jrSummaryBtn']) {
      await page.click(trigger);
      assert(await page.evaluate(() => [...document.querySelectorAll('.jr-toolbar-popup')].filter(el => !el.hidden).every(el => {
        const r=el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth;
      })));
      await page.keyboard.press('Escape');
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, []);
    console.log('PASS: desktop/mobile, popups, keyboard, 5/10/15 scales, day/week, hidden appointments remain busy, add-staff form, summary, dark theme; no API writes.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
