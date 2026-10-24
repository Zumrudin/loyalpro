'use strict';
// Изолированная визуальная проверка «Документов»: настоящие разметка/CSS/JS страницы,
// подставные ответы API. Ни БД, ни F.Doc, ни сессий. Скриншоты — /tmp/edocs-*.png.
// node scripts/edocs-visual.js   (Chrome: CHROME_PATH или /usr/bin/google-chrome)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const puppeteer = require('puppeteer');
const { dictionary } = require('../services/edocs/placeholders');

const PKG = '11111111-1111-4111-8111-111111111111';
const PKG2 = '22222222-2222-4222-8222-222222222222';

function fixtures() {
  const identity = { exists: true, plain: { last_name: 'Тестова', first_name: 'Анна', middle_name: 'Сергеевна', birth_date: '1990-01-15', gender: 'F', phone: '79000000001', email: '', contract_no: '17', contract_date: '' },
    secure: { passport_series: '4500', passport_number: '000001', issue_date: '2015-05-01', authority_code: '770-001', issued_by: 'Тестовое отделение', birth_place: 'г. Москва', address: 'г. Москва, ул. Тестовая, д. 1' } };
  const templates = [{ id: 1, kind: 'contract', title: 'Договор на оказание медицинских услуг', placeholders: ['fio', 'passport'] },
    { id: 2, kind: 'consent_pd', title: 'Согласие на обработку персональных данных', placeholders: ['fio'] },
    { id: 3, kind: 'act', title: 'Акт оказанных услуг', placeholders: ['fio', 'services', 'total_sum'] }];
  const pkg = { id: PKG, kind: 'onboarding', title: 'Документы от 24.10.2026', status: 'sent', fdocStatus: 'WAIT_SIGN', clientId: 52, clientName: 'Тестова Анна Сергеевна',
    clientPhone: '79000000001', recordId: null, sentAt: '2026-10-24T08:00:00Z', signedAt: null, sentByName: 'Администратор', lastError: null, createdAt: '2026-10-24T08:00:00Z',
    act: null, patient: { fio: 'Тестова Анна Сергеевна', phone: '79000000001' },
    documents: [{ id: 'aaaaaaaa-1111-4111-8111-111111111111', title: 'Договор на оказание медицинских услуг', fileName: 'Договор.docx', corpSignedAt: '2026-10-24T08:00:05Z', clientSignedAt: null, hasPdf: false },
      { id: 'bbbbbbbb-1111-4111-8111-111111111111', title: 'Согласие на обработку персональных данных', fileName: 'Согласие.docx', corpSignedAt: '2026-10-24T08:00:05Z', clientSignedAt: null, hasPdf: false }],
    events: [{ kind: 'send', payload: { documents: 2 }, createdAt: '2026-10-24T08:00:00Z', userName: 'Администратор' }] };
  return { identity, templates, pkg };
}

async function main() {
  const frontend = path.resolve(__dirname, '../../frontend');
  const index = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  const pageFrom = index.indexOf('<div class="page" id="page-edocs">');
  const page = index.slice(pageFrom, index.indexOf('<div class="page" id="page-economics">', pageFrom));
  const modalFrom = index.indexOf('<div class="ov" id="edMeModal"');
  const modal = index.slice(modalFrom, index.indexOf('<div class="notif" id="notif"></div>', modalFrom));
  assert.ok(pageFrom > 0 && modalFrom > 0, 'блоки «Документов» не найдены в index.html');
  const fx = fixtures();
  const role = { value: 'owner' };
  const app = express();
  app.use(express.json());
  app.get('/api/edocs/state', (_q, r) => r.json({ enabled: true, configured: true, encReady: true, role: role.value, me: { connected: true, login: 'admin', broken: false, lastError: null } }));
  app.get('/api/edocs/packages', (_q, r) => r.json({ total: 2, page: 1, rows: [fx.pkg, { ...fx.pkg, id: PKG2, title: 'Акт от 23.10.2026', kind: 'act', status: 'signed', signedAt: '2026-10-23T12:00:00Z' }] }));
  app.get('/api/edocs/packages/:id', (q, r) => r.json(q.params.id === PKG2 ? { ...fx.pkg, id: PKG2, status: 'expired', title: 'Акт от 23.10.2026', recordId: 30252 } : fx.pkg));
  app.get('/api/edocs/clients', (_q, r) => r.json({ clients: [{ id: 52, name: 'Тестова Анна Сергеевна', phone: '79000000001', hasIdentity: true }] }));
  app.get('/api/edocs/clients/:id/summary', (_q, r) => r.json({ enabled: true, client: { id: 52, name: 'Тестова Анна Сергеевна', phone: '79000000001' }, identity: { exists: true, fio: 'Тестова Анна Сергеевна', passportMask: '45** ****01' }, packages: [] }));
  app.get('/api/edocs/clients/:id/identity', (_q, r) => r.json(fx.identity));
  app.get('/api/edocs/clients/:id/identity/prefill', (_q, r) => r.json({ plain: fx.identity.plain, secure: {}, notes: [] }));
  app.get('/api/edocs/clients/:id/records', (_q, r) => r.json({ records: [{ id: 30252, visitDate: '2026-10-23', staffName: 'Тестовый врач', services: ['Чистка лица', 'Пилинг'], total: 9500, act: null }] }));
  app.get('/api/edocs/templates', (_q, r) => r.json({ templates: fx.templates }));
  app.get('/api/edocs/records/:id/act-draft', (_q, r) => r.json({ record: { id: 30252, clientId: 52, visitDate: '2026-10-23', actNo: '2056697734' }, doctor: { name: 'Тестовый врач', position: 'Врач-косметолог' },
    lines: [{ service_id: 1, title: 'Чистка лица', qty: 1, price: 3500, sum: 3500 }, { service_id: 2, title: 'Фотоомоложение — лицо', qty: 1, price: 17500, sum: 15750 }], totals: { total_sum: 19250 } }));
  app.post('/api/edocs/packages/check', (_q, r) => r.json({ missing: { identity: [], org: [] } }));
  app.get('/api/edocs/admin/settings', (_q, r) => r.json({ enabled: true, baseUrl: 'https://demo.fdoc.ru', appLogin: 'app', appCode: 'crm', corpId: '12345', qesCertAlias: '', employeePosition: 'Администратор',
    unsignDays: 14, requisites: { name: 'ООО «Тестовая клиника»', inn: '0000000000', city: 'Москва' }, hasApiKey: true, hasAppPassword: true, webhookUrl: null, lastWebhookAt: null, encReady: true }));
  app.get('/api/edocs/admin/templates', (_q, r) => r.json({ templates: fx.templates.map((t) => ({ ...t, is_active: true })) }));
  app.get('/api/edocs/admin/users', (_q, r) => r.json({ users: [{ id: 4, name: 'Администратор', role: 'admin', connected: true, login: 'admin', broken: false }, { id: 5, name: 'Кассир', role: 'admin_cashier', connected: false }] }));
  app.get('/api/edocs/admin/templates/dictionary', (_q, r) => r.json(dictionary()));
  app.get('/', (_q, r) => r.type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/features.css"></head><body>
    <nav id="mainNav"><div class="tn" data-p="edocs">Документы</div></nav><main class="content" style="padding:16px;max-width:1300px;margin:auto">${page}</main>${modal}
    <div class="notif" id="notif"></div><div id="lbar" class="lbar"></div>
    <script src="/js/core/utils.js"></script><script src="/js/core/api.js"></script><script src="/js/core/nav.js"></script>
    <script src="/js/pages/edocs-helpers.js"></script><script src="/js/pages/edocs.js"></script>
    <script>var ME={role:localStorage.getItem('edRole')||'owner'};function openModal(id){document.getElementById(id).classList.add('open')}function closeModal(id){document.getElementById(id).classList.remove('open')}
    if(!location.hash) history.replaceState(null,'','#edocs'); navTo('edocs',{keepHash:true});</script></body></html>`));
  app.use(express.static(frontend));
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const p = await browser.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('dialog', (d) => d.dismiss());
    await p.setViewport({ width: 1280, height: 900 });

    await p.goto(base + '#edocs', { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edListBody .ed-row');
    assert.equal(await p.$$eval('#edListBody .ed-row', (els) => els.length), 2);
    await p.screenshot({ path: '/tmp/edocs-list.png', fullPage: true });

    await p.click('#edListBody .ed-row');
    await p.waitForSelector('#edView-package .ed-pkg-head');
    assert.match(await p.evaluate(() => location.hash), new RegExp(`#edocs/p/${PKG}`));
    assert.equal(await p.$$eval('#edView-package tbody tr', (els) => els.length), 2);
    await p.screenshot({ path: '/tmp/edocs-package.png', fullPage: true });

    await p.goto(base + `#edocs/p/${PKG2}`, { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edView-package .ed-pkg-head');
    const again = await p.$$eval('#edView-package .ed-actions button', (els) => els.map((e) => e.textContent));
    assert.ok(again.includes('Оформить заново'), `у истёкшего комплекта нет «Оформить заново»: ${again}`);
    await p.click('#edView-package .ed-actions .btn-pri');
    await p.waitForSelector('.ed-act tbody tr');
    assert.match(await p.evaluate(() => location.hash), /#edocs\/new\/52\/30252$/);

    await p.goto(base + '#edocs/new/52', { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edF-last_name');
    assert.equal(await p.$eval('#edF-last_name', (el) => el.value), 'Тестова');
    await p.waitForFunction(() => !document.getElementById('edSendBtn').disabled === false || true);
    await p.click('.ed-tpl input[type=checkbox]');
    await p.waitForFunction(() => document.getElementById('edSendBtn') && !document.getElementById('edSendBtn').disabled);
    await p.screenshot({ path: '/tmp/edocs-wizard.png', fullPage: true });
    await p.reload({ waitUntil: 'networkidle0' });
    await p.waitForSelector('#edF-last_name');
    assert.match(await p.evaluate(() => location.hash), /#edocs\/new\/52$/);

    await p.goto(base + '#edocs/new/52/30252', { waitUntil: 'networkidle0' });
    await p.waitForSelector('.ed-act tbody tr');
    assert.equal(await p.$$eval('.ed-act tbody tr', (els) => els.length), 2);
    assert.match(await p.$eval('#edActTotal', (el) => el.textContent), /19\s250,00 ₽/);
    await p.screenshot({ path: '/tmp/edocs-act.png', fullPage: true });

    await p.goto(base + '#edocs/settings', { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edS-baseUrl');
    assert.equal(await p.$$eval('#edView-settings tbody tr', (els) => els.length) >= 3, true);
    await p.screenshot({ path: '/tmp/edocs-settings.png', fullPage: true });

    await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await p.goto(base + `#edocs/p/${PKG}`, { waitUntil: 'networkidle0' });
    await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await p.waitForSelector('#edView-package .ed-pkg-head');
    await p.screenshot({ path: '/tmp/edocs-package-dark.png', fullPage: true });

    await p.setViewport({ width: 390, height: 844, isMobile: true });
    await p.goto(base + '#edocs/new/52/30252', { waitUntil: 'networkidle0' });
    await p.waitForSelector('.ed-act tbody tr');
    const overflow = await p.evaluate(() => document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth);
    await p.screenshot({ path: '/tmp/edocs-mobile.png', fullPage: true });
    assert.ok(overflow <= 1, `горизонтальная прокрутка страницы на 390px: ${overflow}px`);

    await p.evaluate(() => localStorage.setItem('edRole', 'admin_cashier'));
    await p.setViewport({ width: 1280, height: 900 });
    await p.goto(base + '#edocs/settings', { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edListBody');
    assert.equal(await p.evaluate(() => location.hash), '#edocs');
    assert.equal(await p.$eval('#edTabBtn-settings', (el) => el.style.display), 'none');

    assert.deepEqual(errors, []);
    console.log('OK: список, карточка, «Оформить заново», оформление, F5, акт, настройки, тёмная тема, 390px, роль кассира. Скриншоты /tmp/edocs-*.png');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
