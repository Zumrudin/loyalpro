'use strict';
// Full actual staff index/assets, intercepted synthetic API, no DB or integrations.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const frontend = path.resolve(__dirname, '../../frontend');
const origin = 'https://journal-role.test';
const date = '2030-04-02';
async function main() {
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    for (const role of ['owner', 'admin', 'admin_cashier', 'specialist']) {
      const page = await browser.newPage();
      const errors = [], requests = [];
      const specialist = role === 'specialist';
      const capabilities = { canEdit: !specialist, canViewPhones: !specialist, canUseClientTools: !specialist, canManageSchedule: ['owner', 'admin'].includes(role) };
      const staff = [{ id: 1, name: 'Синтетический специалист', working: true, workRanges: [{ start: 600, end: 1320 }] }];
      const record = { id: 101, staffId: 1, staffName: staff[0].name, date, time: '11:00', duration: 60, attendance: 0,
        clientName: 'Синтетический пациент', ...(specialist ? {} : { clientPhone: '70000000000' }),
        comment: specialist ? 'Контакт скрыт' : 'Синтетический комментарий', services: [{ id: 1, title: 'Синтетическая услуга', cost: 100, duration: 60 }], capabilities };
      await page.setViewport({ width: 1440, height: 1000 });
      await page.evaluateOnNewDocument(() => localStorage.setItem('lp_tk', 'synthetic-only'));
      page.on('pageerror', error => errors.push(error.message));
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin !== origin) return request.abort();
        const send = (body, type = 'application/json', status = 200) => request.respond({ status, contentType: type, body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
        if (!url.pathname.startsWith('/api/')) {
          const file = path.resolve(frontend, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
          if (!file.startsWith(frontend + path.sep) || !fs.existsSync(file)) return request.respond({ status: 404 });
          return send(fs.readFileSync(file), ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
        }
        requests.push({ path: url.pathname, method: request.method() });
        if (url.pathname === '/api/auth/me') return send({ id: 1, role, name: 'Синтетический сотрудник', salon_id: 1 });
        if (url.pathname === '/api/journal/day') return send({ date: url.searchParams.get('date'), staff, records: [record], services: [{ id: 1, title: 'Синтетическая услуга', duration: 60, cost: 100, staffIds: [1] }], capabilities, fetchedAt: date + 'T06:00:00Z' });
        if (url.pathname === '/api/journal/day-summary') return send({ date: url.searchParams.get('date'), total: 100, clientCount: 1, capabilities });
        if (url.pathname === '/api/journal/records/101') return send(record);
        if (url.pathname === '/api/journal/records/101/history') return send({ capabilities, events: [{ at: date + 'T06:00:00Z', author: 'Сотрудник', title: 'Изменение записи', changes: [{ label: 'Комментарий', from: '', to: 'Без контактных данных' }] }] });
        if (url.pathname === '/api/journal/week') return send({ staff: staff[0], allStaff: staff, capabilities, days: Array.from({ length: 7 }, (_, index) => ({ date: `2030-04-0${index + 1}`, working: true, workRanges: staff[0].workRanges, records: index === 1 ? [record] : [] })) });
        if (url.pathname === '/api/journal/month') return send({ capabilities, days: [] });
        if (url.pathname === '/api/journal/clients/summary') return send({ clientId: 7, visits: { success: 1, fail: 0 }, lastVisits: [], abonements: [] });
        if (url.pathname === '/api/stock/dictionaries') return send({ storages: [] });
        if (url.pathname === '/api/stock/records/101/goods') return send({ lines: [], total: 0, paid: 0 });
        if (specialist && url.pathname.startsWith('/api/journal/')) return send({ error: 'Недоступно' }, 'application/json', 403);
        return send({});
      });
      await page.goto(origin + '/#journal', { waitUntil: 'networkidle0' });
      await page.waitForSelector('.jr-visit');
      await page.evaluate(async selectedDate => { document.getElementById('jrDate').value = selectedDate; await loadJournal(); }, date);
      assert.equal(await page.evaluate(() => document.body.dataset.page), 'journal');
      assert.equal(await page.$eval('#jrNew', element => element.hidden), specialist);
      assert.equal(await page.$eval('#jrSummaryPlus', element => element.disabled), specialist);
      assert.equal(await page.$eval('#jrScheduleAdd', element => element.hidden), !capabilities.canManageSchedule);
      assert.equal(await page.$eval('#jrDispatch', element => element.hidden), specialist);
      if (specialist) {
        assert.equal(await page.$$('.jr-cell-free[data-time]').then(elements => elements.length), 0);
        assert.equal(await page.$$('.jr-draggable, .jr-resize, [data-staff-action]').then(elements => elements.length), 0);
      }
      await page.click('.jr-visit');
      await page.waitForSelector('#jrHistoryOpen');
      if (specialist) {
        assert((await page.$eval('#jrModalBody', element => element.textContent)).includes('Только просмотр'));
        assert.equal(await page.$('#jrCopyPhone'), null);
        assert.equal(await page.$('#jrTabChat'), null);
        assert.equal(await page.$('#jrPaymentOpen'), null);
        assert.equal(await page.$('#jrMove'), null);
        assert.equal(await page.$('#jrSaveChanges'), null);
        assert(!(await page.content()).includes('70000000000'));
      } else {
        assert(await page.$('#jrCopyPhone'));
        assert(await page.$('#jrTabChat'));
        assert(await page.$('#jrPaymentOpen'));
        if (role === 'admin_cashier') {
          assert.equal(await page.$('#jrClientLink'), null);
          assert.equal(await page.$eval('#jrTabGoods', element => element.hidden), true);
        }
      }
      await page.click('#jrHistoryOpen');
      await page.waitForFunction(() => document.getElementById('jrHistory').textContent.includes('Изменение записи'));
      await (await page.$('#jrModal')).screenshot({ path: `/tmp/journal-role-${role}-detail.png` });
      await page.evaluate(() => jrClose(true));
      await page.evaluate(() => jrSetView('week'));
      await page.waitForSelector('.jr-week');
      await page.evaluate(() => jrMonthPicker('2030-04'));
      await page.waitForSelector('.jr-month-day');
      await page.evaluate(() => { jrEl('jrMonth').hidden = true; jrSetView('day'); });
      await page.setViewport({ width: 390, height: 844 });
      await page.evaluate(() => jrRender());
      // jrSetView starts an asynchronous day reload; wait for its actual grid.
      await page.waitForFunction(() => journal.view === 'day' && journal.data && !!document.querySelector('.jr-calendar:not(.jr-week) .jr-visit'));
      await page.click('.jr-calendar:not(.jr-week) .jr-visit');
      await page.waitForSelector('#jrHistoryOpen');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile viewport must not overflow');
      await (await page.$('#jrModal')).screenshot({ path: `/tmp/journal-role-${role}-mobile.png` });
      if (specialist) {
        const before = requests.length;
        await page.evaluate(async () => { await jrSave({}); jrForm(); jrScheduleAddOpen(); await jrDispatchOpen(); });
        assert.equal(requests.length, before, 'Specialist mutation entry points must not issue requests');
        const journalRequests = requests.filter(request => request.path.startsWith('/api/journal/'));
        assert(journalRequests.every(request => request.method === 'GET' && /^\/api\/journal\/(?:day|day-summary|week|month|records\/101(?:\/history)?)$/.test(request.path)));
        assert(!requests.some(request => /^\/api\/(?:clients|stock|chat)/.test(request.path)));
      }
      if (role === 'admin_cashier') assert(!requests.some(request => /^\/api\/(?:clients|stock)/.test(request.path)));
      assert(requests.every(request => request.method === 'GET'), 'Smoke must not send API mutations');
      assert.deepEqual(errors, [], 'No uncaught browser errors');
      await page.close();
      console.log(`PASS ${role}: actual-index navigation, day/week/month, detail/history, phone and edit controls, mobile; all API responses synthetic.`);
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
