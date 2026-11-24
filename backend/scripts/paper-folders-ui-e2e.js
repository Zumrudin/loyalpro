'use strict';
// Local staff UI acceptance using the actual index/assets and synthetic API only.
// No running app, database, external service or real patient is accessed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const puppeteer = require('puppeteer');
const frontend = path.resolve(__dirname, '../../frontend');

async function main() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) { res.writeHead(500); return res.end('Unintercepted API request'); }
    const file = path.resolve(frontend, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(frontend + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (error, body) => {
      if (error) { res.writeHead(404); return res.end(); }
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const errors = [], writes = [], requestedDates = [];
  const role = process.env.PAPER_FOLDERS_UI_ROLE || 'admin';
  assert(['owner', 'admin', 'admin_cashier'].includes(role));
  let folder = { number: 24, archived: false, prepared: true, archivedAt: null };
  let listMode = 'normal';
  let rejectArchive = false;
  let acceptDialog = true;
  const confirmations = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluateOnNewDocument(() => localStorage.setItem('lp_tk', 'synthetic-local-only'));
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => {
      confirmations.push(dialog.message());
      if (acceptDialog) await dialog.accept(); else await dialog.dismiss();
    });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== origin) return request.abort();
      if (!url.pathname.startsWith('/api/')) return request.continue();
      const send = (data, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(data) });
      const method = request.method();
      if (method !== 'GET') writes.push({ method, path: url.pathname, body: JSON.parse(request.postData() || '{}') });
      if (url.pathname === '/api/auth/me') return send({ id: 1, name: 'Синтетический администратор', role, salon_id: 1 });
      if (url.pathname === '/api/records') return send({ records: [] });
      if (url.pathname === '/api/chat/dialogs') return send({ dialogs: [] });
      if (url.pathname === '/api/medical-cert/requests') return send({ items: [] });
      if (url.pathname === '/api/paper-folders/day') {
        requestedDates.push(url.searchParams.get('date'));
        if (listMode === 'error') return send({ error: 'Список временно недоступен' }, 503);
        const items = listMode === 'full' ? [{ clientId: 7, name: 'Синтетический пациент без номера', number: null, needsNumber: true, archived: false, prepared: false, task: 'Нет свободных папок' }] : [
          { clientId: 1, name: 'Синтетический пациент 100', number: 100, time: '12:00', prepared: true, task: 'Взять папку' },
          { clientId: 2, name: 'Синтетический пациент 9', number: 9, time: '11:00', archived: true, prepared: false, task: 'Подготовить новый договор' },
          { clientId: 2, name: 'Повторный визит', number: 9, time: '14:00', archived: true, prepared: false },
          { key: 'pending:synthetic', clientId: null, outboxId: 12, name: 'Новый пациент из очереди', number: 3, time: '10:00', prepared: false, task: 'Создать пакет документов' },
          { key: 'pending:synthetic', clientId: null, outboxId: 13, name: 'Повторная запись из очереди', number: 3, time: '15:00', prepared: false },
        ];
        return send({ date: url.searchParams.get('date'), capacity: 2000, updatedAt: '2030-01-02T09:30:00Z', occupied: listMode === 'full' ? 2000 : 2, free: listMode === 'full' ? 0 : 1998, items });
      }
      if (url.pathname === '/api/clients/7') return send({ client: { id: 7, name: 'Синтетический пациент', bonus_balance: 0, total_spent: 0, visits_count: 0, paper_folder: folder }, history: [], records: [] });
      if (url.pathname === '/api/clients/7/card-transactions') return send({ local: [], yclients: [] });
      if (url.pathname === '/api/stock/clients/7/purchases') return send([]);
      if (/^\/api\/paper-folders\/outbox\/\d+$/.test(url.pathname)) return send({ paperFolder: { number: 3, prepared: true } });
      if (/^\/api\/clients\/\d+\/paper-folder$/.test(url.pathname)) {
        const body = JSON.parse(request.postData() || '{}');
        if (rejectArchive && body.archived) return send({ error: 'Не удалось сохранить архив' }, 503);
        if (body.archived) folder = { number: null, archived: true, prepared: false, archivedAt: '2030-01-01T09:00:00Z' };
        if (body.number) folder = { ...folder, number: body.number, prepared: true };
        if (typeof body.prepared === 'boolean') folder = { ...folder, prepared: body.prepared };
        return send({ paperFolder: folder });
      }
      return send({});
    });
    await page.goto(origin + (role === 'admin_cashier' ? '/' : '/#workday'), { waitUntil: 'networkidle0' });
    await page.waitForSelector('#wdFolderList .pf-row');
    assert.equal(await page.$eval('#wdCareCard', element => getComputedStyle(element).display !== 'none'), role !== 'admin_cashier');
    if (role === 'admin_cashier') {
      await page.$eval('#wdCareCard a', element => element.click());
      assert.equal(await page.evaluate(() => location.hash), '#workday', 'Cashier cannot activate the Care link');
    }
    assert.equal(await page.$('#wdRecords'), null, 'Old records card must be removed');
    assert.equal(await page.$eval('#wdFolders > .ct', element => element.textContent), 'Номер папки пациента');
    assert(await page.$eval('#page-workday .g32', element => element.firstElementChild.id === 'wdFolders'), 'Folders must occupy the first grid column');
    assert(await page.$eval('#wdFolders', element => element.scrollWidth <= element.clientWidth), 'Desktop folder panel must not overflow');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Desktop page must not overflow horizontally');
    const tomorrow = await page.evaluate(() => wdTomorrowMsk());
    assert.equal(await page.$eval('#wdFolderDate', element => element.value), tomorrow);
    assert.equal(requestedDates[0], tomorrow);
    assert.deepEqual(await page.$$eval('.pf-number', elements => elements.map(element => element.textContent)), ['№ 3', '№ 9', '№ 100']);
    assert.equal(await page.$$eval('.pf-row', elements => elements.length), 3);
    assert((await page.$eval('#wdFolderCounts', element => element.textContent)).includes('Пациентов: 3'));
    assert.equal(await page.$eval('[data-folder-prepared="2"]', element => element.disabled), false);
    await page.click('[data-folder-outbox="12"]');
    await page.waitForFunction(() => !document.querySelector('#wdFolderList .empty'));
    assert(writes.some(write => write.path === '/api/paper-folders/outbox/12' && write.body.prepared === true));
    assert((await page.$eval('#wdFolderCounts', element => element.textContent)).includes('12:30 МСК'));
    await page.click('[data-folder-prepared="2"]');
    await page.waitForFunction(() => !document.querySelector('#wdFolderList .empty'));
    assert(writes.some(write => write.path === '/api/clients/2/paper-folder' && write.body.prepared === true));
    await page.$eval('#wdFolders', element => element.scrollIntoView({ block: 'center' }));
    await (await page.$('#wdFolders')).screenshot({ path: '/tmp/paper-folders-workday-desktop.png' });

    listMode = 'full';
    await page.evaluate(async () => { document.getElementById('wdFolderDate').value = '2030-01-02'; await wdLoadFolders(); });
    assert.equal(requestedDates.at(-1), '2030-01-02');
    assert((await page.$eval('#wdFolderCounts', element => element.textContent)).includes('Свободно: 0'));
    assert((await page.$eval('#wdFolderList', element => element.textContent)).includes('Номер не назначен'));
    assert.equal(await page.$eval('[data-folder-prepared="7"]', element => element.disabled), true);
    await page.screenshot({ path: '/tmp/paper-folders-no-slots.png' });
    listMode = 'error';
    await page.evaluate(() => wdLoadFolders());
    assert((await page.$eval('#wdFolderList', element => element.textContent)).includes('Не удалось загрузить'));
    assert.equal(await page.$eval('#wdTotal', element => element.textContent), '0');

    if (role !== 'admin_cashier') {
    await page.evaluate(() => openCD(7));
    await page.waitForSelector('#clientModal.open #cdPaperArchive');
    acceptDialog = false;
    let writesBefore = writes.length;
    await page.click('#cdPaperArchive');
    assert.equal(writes.length, writesBefore);
    assert.equal(await page.$eval('#cdPaperArchive', element => element.checked), false);
    acceptDialog = true;
    rejectArchive = true;
    await page.click('#cdPaperArchive');
    await page.waitForFunction(() => document.getElementById('notif').textContent.includes('Не удалось сохранить архив'));
    assert.equal(await page.$eval('#cdPaperArchive', element => element.checked), false);
    rejectArchive = false;
    await page.click('#cdPaperArchive');
    await page.waitForFunction(() => document.getElementById('cdPaperArchive').disabled);
    assert.equal(await page.$eval('#cdPaperArchive', element => element.checked), true);
    assert(confirmations.every(message => message.includes('Бумаги пациента вынуты')));
    await page.screenshot({ path: '/tmp/paper-folders-client-archive.png' });

    folder = { number: null, archived: false, prepared: false, archivedAt: null };
    await page.evaluate(() => openCD(7));
    await page.click('#cdPaperFolder summary');
    await page.type('#cdPaperNumber', '2001');
    writesBefore = writes.length;
    await page.click('#cdPaperNumberSave');
    assert.equal(writes.length, writesBefore);
    await page.$eval('#cdPaperNumber', element => { element.value = '2000'; });
    await page.click('#cdPaperNumberSave');
    await page.waitForFunction(() => document.querySelector('#cdPaperFolder .ct').textContent.includes('2000'));
    assert.deepEqual(writes.at(-1).body, { number: 2000 });
    assert.equal(folder.number, 2000);

    folder = { number: 2000, archived: true, prepared: true, archivedAt: '2030-01-01T09:00:00Z' };
    await page.evaluate(() => openCD(7));
    assert.equal(await page.$eval('#cdPaperArchive', element => element.disabled), true);
    assert((await page.$eval('#cdPaperFolder', element => element.textContent)).includes('полностью оплаченного визита'));
    await page.click('#cdPaperReturn');
    await page.waitForFunction(() => !document.querySelector('#cdPaperReturn'));
    assert.equal(folder.number, null);
    assert.equal(folder.archived, true);

    await page.evaluate(() => closeModal('clientModal'));
    }
    listMode = 'normal';
    await page.evaluate(() => wdLoadFolders());
    await page.setViewport({ width: 390, height: 844 });
    await page.waitForFunction(() => getComputedStyle(document.getElementById('clientModal')).opacity === '0');
    await page.$eval('#wdFolders', element => element.scrollIntoView({ block: 'center' }));
    await (await page.$('#wdFolders')).screenshot({ path: '/tmp/paper-folders-workday-mobile.png' });
    assert(await page.$eval('#wdFolders', element => element.scrollWidth <= element.clientWidth), 'Mobile folder panel must not overflow');
    assert(await page.$eval('#page-workday .g32', element => element.firstElementChild.id === 'wdFolders'), 'Mobile folders must remain first in the grid');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile page must not overflow horizontally');
    // A cached pre-rollout index still has the old records card instead of the slot.
    await page.evaluate(() => {
      const legacy = document.createElement('div');
      legacy.className = 'card';
      legacy.innerHTML = '<div class="ct">Записи на сегодня</div><div id="wdRecords"></div>';
      document.getElementById('wdFolders').replaceWith(legacy);
      wdEnsureFolders();
    });
    assert.equal(await page.$('#wdRecords'), null, 'Cached old records card must also be replaced');
    assert(await page.$eval('#page-workday .g32', element => element.firstElementChild.id === 'wdFolders'));
    assert.deepEqual(errors, []);
    assert(writes.every(write => write.method === 'PATCH' && (/^\/api\/clients\/\d+\/paper-folder$/.test(write.path) || /^\/api\/paper-folders\/outbox\/\d+$/.test(write.path))));
    console.log(`PASS (${role}): actual index/assets; renamed folder panel replaces records card in first grid column; tomorrow Moscow, numeric order, client/provisional patient deduplication and preparation, refreshed time, archived preparation, full pool/error isolation, ${role === 'admin_cashier' ? 'cashier startup and Care restriction' : 'archive cancel/failure/success, number bounds/2000, archived package return'}, desktop/mobile; all API effects synthetic.`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
