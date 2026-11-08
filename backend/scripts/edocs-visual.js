'use strict';
// Изолированная визуальная проверка «Документов»: настоящие разметка/CSS/JS страницы и анкеты пациента,
// подставные ответы API. Ответы дашборда и страницы пациента собирает НАСТОЯЩИЙ services/edocs/board.js
// из синтетических записей — стенд показывает ровно те цвета и подписи, что посчитает сервер.
// Ни БД, ни F.Doc, ни сессий, ни отправок. Скриншоты — /tmp/edocs-*.png.
//   node scripts/edocs-visual.js   (Chrome: CHROME_PATH или /usr/bin/google-chrome)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const puppeteer = require('puppeteer');
const QRCode = require('qrcode');
const board = require('../services/edocs/board');
const { dictionary } = require('../services/edocs/placeholders');

const PKG = '11111111-1111-4111-8111-111111111111';
const FORM_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'T'.repeat(43);
const MIN = 60000;

function fixtures(nowMs) {
  const iso = (ms) => new Date(ms).toISOString();
  const templates = [
    { id: 1, kind: 'contract', title: 'Договор на оказание платных медицинских услуг', is_active: true, sort_order: 0, placeholders: ['fio', 'passport', 'address', 'contract_no'] },
    { id: 2, kind: 'consent_pd', title: 'Согласие на обработку персональных данных', is_active: true, sort_order: 1, placeholders: ['fio', 'phone'] },
    { id: 3, kind: 'act', title: 'Акт оказанных услуг', is_active: true, sort_order: 2, placeholders: ['fio', 'services', 'total_sum'] },
    { id: 4, kind: 'other', title: 'Памятка после процедуры', is_active: true, sort_order: 3, placeholders: ['fio'] },
  ];
  const people = [
    [1, 'Абдуллаева Карина Рашидовна', 40, '0', '0', false, 'Биоревитализация', 'Гаджиева Пери'],
    [2, 'Смирнова Ольга Викторовна', -90, '1', '1', true, 'Ботулинотерапия', 'Боташев Астемир'],
    [3, 'Мамедова Дина Эльдаровна', -150, '1', '1', true, 'Контурная пластика губ', 'Гаджиева Пери'],
    [4, 'Лебедева Анна Игоревна', 360, '0', '0', true, 'Чистка лица', 'Гатауллина Юлия'],
    [5, 'Соколова Виктория Андреевна', 480, '0', '0', false, 'Лазерная эпиляция', 'Палий Татьяна'],
    [6, 'Воронина Елена Сергеевна', 90, '0', '0', false, 'Лазерная эпиляция', 'Палий Татьяна'],
    [7, 'Ким Светлана Олеговна', -120, '1', '1', true, 'Микротоки', 'Гатауллина Юлия'],
    [8, 'Котова Мария Павловна', -200, '1', '1', true, 'Пилинг PRX-T33', 'Гатауллина Юлия'],
    [9, 'Павлова Ирина Алексеевна', -60, '1', '1', true, 'Мезотерапия', 'Гаджиева Пери'],
    [10, 'Орлова Наталья Дмитриевна', 180, '0', '0', true, 'Ботулинотерапия', 'Боташев Астемир'],
    [11, 'Белова Ксения Романовна', 1440 + 120, '0', '0', true, 'Фотоомоложение', 'Палий Татьяна'],
    [12, 'Захарова Алина Тимуровна', -1440 - 60, '1', '1', true, 'Чистка лица', 'Гатауллина Юлия'],
  ];
  const records = people.map(([id, name, offset, att, paid, prior, svc, staff]) => {
    const at = nowMs + offset * MIN;
    return { id: 100 + id, client_id: id, client_name: name, client_phone: '7920' + String(1000000 + id).slice(1), visit_date: board.mskDay(at), visit_at: iso(at),
      attendance: att, paid_full: paid, has_prior_visit: prior, services: [{ title: svc, amount: 1, first_cost: 9000, manual_cost: 9000 }], staff: { name: staff, position: { title: 'Врач-косметолог' } } };
  });
  let n = 0;
  const doc = (client, kind, status, over = {}) => ({ client_id: client, package_id: over.package_id || `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, '0')}`, kind,
    package_status: status, record_id: null, source: 'manual', created_at: iso(nowMs - 3 * 86400000), sent_at: iso(nowMs - 3 * 86400000),
    signed_at: status === 'signed' || status === 'paper' ? iso(nowMs - 3 * 86400000) : null, last_error: null, ...over });
  const signedPair = (c) => [doc(c, 'contract', 'signed'), doc(c, 'consent_pd', 'signed')];
  const docs = [
    ...signedPair(2), ...signedPair(3), doc(3, 'act', 'expired', { record_id: 103, created_at: iso(nowMs - 26 * 3600000) }),
    doc(4, 'contract', 'paper'), doc(5, 'consent_pd', 'signed'),
    doc(6, 'contract', 'sent', { sent_at: iso(nowMs - 12 * MIN), created_at: iso(nowMs - 12 * MIN) }), doc(6, 'consent_pd', 'sent', { sent_at: iso(nowMs - 12 * MIN), created_at: iso(nowMs - 12 * MIN) }),
    ...signedPair(7), doc(7, 'act', 'sent', { record_id: 107, sent_at: iso(nowMs - 100 * MIN), created_at: iso(nowMs - 100 * MIN) }),
    ...signedPair(8), doc(8, 'act', 'signed', { record_id: 108, signed_at: iso(nowMs - 150 * MIN) }),
    ...signedPair(9), doc(9, 'act', 'signed', { record_id: 109, signed_at: iso(nowMs - 30 * MIN) }),
    ...signedPair(10), ...signedPair(11), ...signedPair(12),
  ];
  const full = (id) => ({ client_id: id, last_name: 'Тестова', first_name: 'Анна', middle_name: null, phone: '79200000000', contract_no: null,
    secure_fields: ['passport_series', 'passport_number', 'issue_date', 'issued_by', 'authority_code', 'address'] });
  const identities = new Map(people.map(([id]) => [id, full(id)]));
  identities.set(1, { client_id: 1, last_name: 'Абдуллаева', first_name: 'Карина', middle_name: 'Рашидовна', phone: '79200000001', secure_fields: [] });
  identities.set(5, { client_id: 5, last_name: 'Соколова', first_name: 'Виктория', phone: '79200000005', secure_fields: [] });
  const forms = [{ id: FORM_ID, client_id: 5, status: 'active', created_at: iso(nowMs - 2 * 3600000), delivered_via: 'whatsapp', delivered_at: iso(nowMs - 2 * 3600000),
    opened_at: null, submitted_at: null, expires_at: iso(nowMs + 5 * 86400000), package_id: null, last_error: null }];
  const notes = [{ client_id: 2, record_id: 102, kind: 'act', status: 'failed', reason: 'у сотрудника для автоотправки нет рабочей учётки F.Doc', created_at: iso(nowMs - 40 * MIN) }];
  return { templates, records, docs, identities, forms, notes, people };
}

async function main() {
  const frontend = path.resolve(__dirname, '../../frontend');
  const index = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  const pageFrom = index.indexOf('<div class="page" id="page-edocs">');
  const page = index.slice(pageFrom, index.indexOf('<div class="page" id="page-economics">', pageFrom));
  const modalFrom = index.indexOf('<div class="ov" id="edMeModal"');
  const modal = index.slice(modalFrom, index.indexOf('<div class="notif" id="notif"></div>', modalFrom));
  assert.ok(pageFrom > 0 && modalFrom > 0, 'блоки «Документов» не найдены в index.html');
  const nowMs = Date.now();
  const fx = fixtures(nowMs);
  const today = board.mskDay(nowMs);
  const settings = { actsRequiredFrom: board.addDays(today, -10), autonumber: true };
  const state = { enabled: true, configured: true, encReady: true, role: 'owner', me: { connected: true, login: 'admin', broken: false, lastError: null } };
  const built = () => board.buildBoard({ records: fx.records, docs: fx.docs, identities: fx.identities, templates: fx.templates, requisites: {}, forms: fx.forms, notes: fx.notes, settings, nowMs: Date.now(), today });
  const app = express();
  app.use(express.json());
  app.get('/api/edocs/state', (_q, r) => r.json(state));
  app.get('/api/edocs/board', (q, r) => {
    const range = ['today', 'tomorrow', 'week', 'open'].includes(q.query.range) ? q.query.range : 'today';
    const b = built();
    const cards = board.sliceRange(b.cards, range, today, settings.actsRequiredFrom);
    r.json({ now: new Date().toISOString(), today, range, rangeCounts: board.rangeCounts(b.cards, today, settings.actsRequiredFrom), ...board.summarize(cards), cards, kinds: b.kinds,
      module: { enabled: state.enabled, configured: true, encReady: true, me: state.me },
      automation: { previsit: { on: true, hours: 24, scope: 'first', form: true }, act: { on: false, delayMin: 15 }, remind: { on: true, hours: 2 }, senderName: 'Администратор' },
      warnings: [], actsRequiredFrom: settings.actsRequiredFrom });
  });
  app.get('/api/edocs/board/clients', (_q, r) => r.json({ page: 1, filter: 'all', total: fx.people.length, rows: fx.people.map(([id, name], i) => ({
    id, name, phone: '79200000' + String(id).padStart(3, '0'), lastVisitAt: new Date(nowMs - i * 86400000).toISOString(), contract: i % 3 !== 0, consent: i % 4 !== 0, pending: i === 5, openActs: i === 1 ? 1 : 0 })) }));
  app.get('/api/edocs/clients/:id/page', (q, r) => {
    const id = Number(q.params.id);
    const person = fx.people.find((x) => x[0] === id);
    if (!person) return r.status(404).json({ error: 'Пациент не найден' });
    const recs = fx.records.filter((x) => x.client_id === id);
    const p = board.buildClientPage({ client: { id, name: person[1], phone: recs[0].client_phone }, identity: fx.identities.get(id), records: recs,
      docs: fx.docs.filter((d) => d.client_id === id), templates: fx.templates, requisites: {}, forms: fx.forms.filter((f) => f.client_id === id), notes: [], settings,
      nowMs: Date.now(), today, focusRecordId: Number(q.query.record) || null });
    r.json({ ...p, today, numbering: { auto: true, contractNo: null, yclientsNo: id === 2 ? '1859' : null, next: 1999 }, actsRequiredFrom: settings.actsRequiredFrom,
      module: { enabled: true, configured: true, encReady: true, me: state.me }, identity: { exists: true, secureFields: [] },
      templates: fx.templates.map((t) => ({ id: t.id, kind: t.kind, title: t.title, placeholders: t.placeholders })), packages: [],
      events: [{ kind: 'form_created', packageId: null, payload: {}, createdAt: new Date(nowMs - 3 * 3600000).toISOString(), userName: 'Администратор' },
        { kind: 'identity_edit', packageId: null, payload: {}, createdAt: new Date(nowMs - 2 * 3600000).toISOString(), userName: 'Администратор' }] });
  });
  app.get('/api/edocs/clients/:id/identity', (q, r) => (Number(q.params.id) === 1
    ? r.json({ exists: true, plain: { last_name: 'Абдуллаева', first_name: 'Карина', middle_name: 'Рашидовна', birth_date: '1991-03-14', gender: 'F', phone: '79200000001', email: '', contract_no: '', contract_date: '' }, secure: {} })
    : r.json({ exists: true, plain: { last_name: 'Тестова', first_name: 'Анна', birth_date: '1985-01-02', gender: 'F', phone: '79200000000' }, secure: { passport_series: '4500', passport_number: '000001', address: 'г. Москва' } })));
  app.get('/api/edocs/clients/:id/identity/prefill', (_q, r) => r.json({ plain: {}, secure: {}, notes: [] }));
  app.get('/api/edocs/records/:id/act-draft', (q, r) => r.json({ record: { id: Number(q.params.id), clientId: 2, visitDate: today, actNo: '2006141556' }, doctor: { name: 'Боташев Астемир', position: 'Врач-косметолог' },
    lines: [{ service_id: 1, title: 'Ботулинотерапия Ботулакс, лоб + межбровье', qty: 1, price: 17000, sum: 17000 }, { service_id: 2, title: 'Консультация врача-косметолога', qty: 1, price: 2000, sum: 2000 }],
    totals: { total_sum: 19000 } }));
  app.post('/api/edocs/packages/check', (q, r) => r.json({ missing: { identity: q.body.clientId === 1 && q.body.templateIds.includes(1)
    ? [{ key: 'address', label: 'Адрес регистрации' }, { key: 'passport_number', label: 'Номер паспорта' }, { key: 'passport_series', label: 'Серия паспорта' }] : [], org: [] } }));
  const formLink = async () => { const url = `https://dev.zumrudin.ru/anketa/${TOKEN}`; return { formId: FORM_ID, url, qr: await QRCode.toDataURL(url, { margin: 1, width: 280 }), expiresAt: new Date(nowMs + 7 * 86400000).toISOString() }; };
  app.post('/api/edocs/clients/:id/forms', async (_q, r) => r.json({ ...(await formLink()), delivery: null }));
  app.get('/api/edocs/forms/:id/link', async (_q, r) => r.json(await formLink()));
  app.post('/api/edocs/forms/:id/send', (_q, r) => r.json({ ok: true, channel: 'whatsapp' }));
  const pkg = { id: PKG, kind: 'onboarding', title: 'На бумаге: Договор на оказание платных медицинских услуг', status: 'paper', source: 'paper', fdocStatus: null, clientId: 4,
    clientName: 'Лебедева Анна Игоревна', clientPhone: '79200000004', recordId: null, sentAt: null, signedAt: new Date(nowMs - 86400000).toISOString(), sentByName: 'Администратор',
    lastError: null, createdAt: new Date(nowMs - 86400000).toISOString(), act: null, patient: null, paper: { signedDate: today, note: 'подписано в клинике', hasScan: true },
    documents: [{ id: 'bbbbbbbb-1111-4111-8111-111111111111', title: 'Договор на оказание платных медицинских услуг', fileName: 'Договор.docx', corpSignedAt: null, clientSignedAt: null, hasPdf: false }],
    events: [{ kind: 'paper', payload: {}, createdAt: new Date(nowMs - 86400000).toISOString(), userName: 'Администратор' }] };
  app.get('/api/edocs/packages', (_q, r) => r.json({ total: 1, page: 1, rows: [pkg] }));
  app.get('/api/edocs/packages/:id', (_q, r) => r.json(pkg));
  app.get('/api/edocs/admin/settings', (_q, r) => r.json({ enabled: true, baseUrl: 'https://demo.fdoc.ru', appLogin: 'app', appCode: 'crm', corpId: '12345', qesCertAlias: '', employeePosition: 'Администратор',
    unsignDays: 14, requisites: { name: 'ООО «Тестовая клиника»', inn: '0000000000', city: 'Москва' }, hasApiKey: true, hasAppPassword: true, webhookUrl: null, lastWebhookAt: null, encReady: true }));
  app.get('/api/edocs/admin/templates', (_q, r) => r.json({ templates: fx.templates }));
  app.get('/api/edocs/admin/users', (_q, r) => r.json({ users: [{ id: 4, name: 'Администратор', role: 'admin', connected: true, login: 'admin', broken: false }, { id: 5, name: 'Кассир', role: 'admin_cashier', connected: false }] }));
  app.get('/api/edocs/admin/templates/dictionary', (_q, r) => r.json(dictionary()));
  app.get('/api/edocs/admin/automation', (_q, r) => r.json({ senderUserId: 4, senders: [{ id: 4, name: 'Администратор', role: 'admin', connected: true, broken: false }, { id: 5, name: 'Кассир', role: 'admin_cashier', connected: false, broken: false }],
    previsit: { on: true, hours: 24, scope: 'first', form: true }, act: { on: false, delayMin: 15 }, remind: { on: true, hours: 2 }, formMessage: '',
    formMessageDefault: 'Здравствуйте, {имя}! Перед визитом в {клиника} {дата} заполните, пожалуйста, данные для договора — это займёт 2 минуты: {ссылка}', formTtlDays: 7,
    contractAutonumber: true, contractNext: { next: 1999, maxUsed: 1998 }, actsRequiredFrom: settings.actsRequiredFrom, publicUrlConfigured: true, testPhones: ['79200255591'] }));
  // публичная анкета
  app.get('/anketa/:token', (_q, r) => r.sendFile(path.join(frontend, 'anketa.html')));
  app.get('/api/public/anketa/:token', (_q, r) => r.json({ status: 'active', clinic: 'PERI CLINIC', greetingName: 'Карина', visit: { date: today, time: '11:00', label: '26 октября, 11:00' },
    fields: [['last_name', 'Фамилия', 'text', true], ['first_name', 'Имя', 'text', true], ['middle_name', 'Отчество (если есть)', 'text', false], ['birth_date', 'Дата рождения', 'date', true],
      ['passport_series', 'Серия паспорта', 'digits', true], ['passport_number', 'Номер паспорта', 'digits', true], ['issue_date', 'Дата выдачи паспорта', 'date', true],
      ['authority_code', 'Код подразделения', 'code', true], ['issued_by', 'Кем выдан паспорт', 'text', true], ['address', 'Адрес регистрации', 'text', true]]
      .map(([key, label, type, required]) => ({ key, label, type, required })), canRecognize: true, policyUrl: '/privacy-policy.html' }));
  app.post('/api/public/anketa/:token', (_q, r) => r.json({ ok: true, docs: 'sending' }));
  app.get('/', (_q, r) => r.type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/features.css"></head><body>
    <nav id="mainNav"><div class="tn" data-p="edocs">Документы</div></nav><main class="content" style="padding:16px;max-width:1300px;margin:auto">${page}</main>${modal}
    <div class="notif" id="notif"></div><div id="lbar" class="lbar"></div>
    <script src="/js/core/utils.js"></script><script src="/js/core/api.js"></script><script src="/js/core/nav.js"></script>
    <script src="/js/pages/edocs-helpers.js"></script><script src="/js/pages/edocs.js"></script><script src="/js/pages/edocs-board.js"></script><script src="/js/pages/edocs-client.js"></script>
    <script>var ME={role:localStorage.getItem('edRole')||'owner'};function openModal(id){document.getElementById(id).classList.add('open')}function closeModal(id){document.getElementById(id).classList.remove('open')}
    if(!location.hash) history.replaceState(null,'','#edocs'); navTo('edocs',{keepHash:true});</script></body></html>`));
  app.use(express.static(frontend));
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  const pause = () => new Promise((r) => setTimeout(r, 700));   // переходы CSS (до 0,25 с) — кадр не посреди анимации
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const p = await browser.newPage();
    await p.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('dialog', (d) => d.dismiss());
    await p.setViewport({ width: 1280, height: 900 });
    const overflow = () => p.evaluate(() => document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth);

    // дашборд «Сегодня»
    await p.goto(base + '#edocs', { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edbCards .edb-card');
    const colors = await p.$$eval('#edbCards .edb-card', (els) => els.map((e) => e.className.replace('edb-card ', '').replace(' flash', '')));
    assert.ok(colors.includes('ed-c-red') && colors.includes('ed-c-green') && colors.includes('ed-c-blue'), `цвета карточек: ${colors}`);
    const boardText = await p.$eval('#edbCards', (el) => el.textContent);
    for (const label of ['Нужно до визита', 'Акт не подписан', 'Ссылка истекла', 'Ждём подпись', 'Ждём анкету', 'Всё подписано', 'Документы готовы']) {
      assert.ok(boardText.includes(label), `на дашборде нет подписи «${label}»`);
    }
    await pause();
    await p.screenshot({ path: '/tmp/edocs-board.png', fullPage: true });
    await p.click('#edbSeg-week');
    await p.waitForFunction(() => location.hash === '#edocs/r/week' && document.querySelectorAll('#edbCards .edb-group').length >= 2);
    await pause();
    await p.screenshot({ path: '/tmp/edocs-week.png', fullPage: true });
    await p.click('#edbSeg-all');
    await p.waitForSelector('#edbBaseList .edb-base-row:not(.edb-base-head)');
    await pause();
    await p.screenshot({ path: '/tmp/edocs-base.png', fullPage: true });
    await p.goto(base + '#edocs', { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edbCards .edb-card');
    await p.evaluate(() => edOpenAutomation());
    await p.waitForFunction(() => document.getElementById('edAutoModal').classList.contains('open') && !!document.getElementById('edAu-sender'), { timeout: 5000 })
      .catch(async (e) => { console.error('auto modal:', await p.evaluate(() => [document.getElementById('edAutoModal') && document.getElementById('edAutoModal').className, document.getElementById('edAutoBody') && document.getElementById('edAutoBody').innerHTML.slice(0, 300)]), errors); throw e; });
    await pause();
    await p.screenshot({ path: '/tmp/edocs-automation.png' });
    await p.evaluate(() => closeModal('edAutoModal'));

    // страница пациента: данные неполные, блок раскрыт с дашборда «Заполнить данные»
    await p.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('#edbCards button.btn-pri')).find((x) => x.textContent === 'Заполнить данные');
      setTimeout(() => btn.click(), 0);   // клик вне evaluate: переход по hash посреди вызова подвешивал протокол
    });
    await p.waitForFunction(() => /^#edocs\/c\/1/.test(location.hash));
    await p.waitForSelector('#edcData[open] #edcF-passport_series');
    assert.equal(await p.$eval('#edcData', (el) => el.classList.contains('ed-c-red')), true);
    assert.ok(await p.$eval('#edcW-passport_series', (el) => el.classList.contains('miss')), 'недостающее поле не подсвечено');
    await p.waitForFunction(() => /Не хватает данных пациента/.test(document.getElementById('edcSend').textContent));
    await pause();
    await p.screenshot({ path: '/tmp/edocs-client.png', fullPage: true });
    await p.reload({ waitUntil: 'networkidle0' });
    await p.waitForSelector('#edcHead .edc-head');
    assert.match(await p.evaluate(() => location.hash), /^#edocs\/c\/1/);
    await p.evaluate(() => edFormOpen(1));
    await p.waitForSelector('#edFormModal.open .ed-qr img');
    await pause();
    await p.screenshot({ path: '/tmp/edocs-form-modal.png' });
    await p.evaluate(() => closeModal('edFormModal'));

    // страница пациента с оплаченным визитом: акт, правка строк, бумага
    await p.goto(base + '#edocs/new/2', { waitUntil: 'networkidle0' });   // старый адрес мастера
    await p.waitForSelector('#edcDocs .edc-doc');
    assert.equal(await p.evaluate(() => location.hash), '#edocs/c/2');
    assert.match(await p.$eval('#edcDocs', (el) => el.textContent), /Акт оказанных услуг · визит/);
    await pause();
    await p.screenshot({ path: '/tmp/edocs-client-act.png', fullPage: true });
    await p.evaluate(() => edcActEdit());
    await p.waitForSelector('#edActModal.open .ed-act-edit tbody tr');
    await p.evaluate(() => { const i = document.querySelectorAll('.ed-act-edit tbody tr td:nth-child(5) input')[1]; i.value = '1000'; i.dispatchEvent(new Event('input')); });
    assert.match(await p.$eval('#edcActDiff', (el) => el.textContent), /отличается/);
    await pause();
    await p.screenshot({ path: '/tmp/edocs-act-modal.png' });
    await p.evaluate(() => closeModal('edActModal'));
    await p.evaluate(() => edcPaperOpen());
    await p.waitForSelector('#edPaperModal.open .edcP-t');
    await pause();
    await p.screenshot({ path: '/tmp/edocs-paper-modal.png' });
    await p.evaluate(() => closeModal('edPaperModal'));

    // комплект «на бумаге», настройки
    await p.goto(base + `#edocs/p/${PKG}`, { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edView-package .ed-pkg-head');
    const actions = await p.$$eval('#edView-package .ed-actions button', (els) => els.map((e) => e.textContent));
    assert.ok(actions.includes('Скан') && actions.includes('Снять отметку') && !actions.includes('Открыть в F.Doc'), `кнопки бумажного комплекта: ${actions}`);
    await pause();
    await p.screenshot({ path: '/tmp/edocs-package.png', fullPage: true });
    await p.goto(base + '#edocs/settings', { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edS-baseUrl');
    await pause();
    await p.screenshot({ path: '/tmp/edocs-settings.png', fullPage: true });

    // тёмная тема
    await p.goto(base + '#edocs', { waitUntil: 'networkidle0' });
    await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await p.waitForSelector('#edbCards .edb-card');
    await pause();
    await p.screenshot({ path: '/tmp/edocs-board-dark.png', fullPage: true });
    await p.goto(base + '#edocs/c/1', { waitUntil: 'networkidle0' });
    await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await p.waitForSelector('#edcHead .edc-head');
    await pause();
    await p.screenshot({ path: '/tmp/edocs-client-dark.png', fullPage: true });
    await p.evaluate(() => document.documentElement.removeAttribute('data-theme'));

    // телефон
    await p.setViewport({ width: 390, height: 844, isMobile: true });
    await p.goto(base + '#edocs', { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edbCards .edb-card');
    await pause();
    await p.screenshot({ path: '/tmp/edocs-board-mobile.png', fullPage: true });
    assert.ok((await overflow()) <= 1, `горизонтальная прокрутка дашборда на 390px: ${await overflow()}px`);
    await p.goto(base + '#edocs/c/2', { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edcDocs .edc-doc');
    await pause();
    await p.screenshot({ path: '/tmp/edocs-client-mobile.png', fullPage: true });
    assert.ok((await overflow()) <= 1, `горизонтальная прокрутка страницы пациента на 390px: ${await overflow()}px`);

    // анкета пациента на телефоне
    const a = await browser.newPage();
    a.on('pageerror', (e) => errors.push('anketa: ' + e.message));
    await a.setViewport({ width: 390, height: 844, isMobile: true });
    await a.goto(base + `anketa/${TOKEN}`, { waitUntil: 'networkidle0' });
    await a.waitForSelector('#aForm:not([hidden]) #af-passport_series');
    assert.equal(await a.$eval('#aHello', (el) => el.textContent), 'Здравствуйте, Карина!');
    await pause();
    await a.screenshot({ path: '/tmp/edocs-anketa-mobile.png', fullPage: true });
    await a.click('#aSubmit');
    assert.match(await a.$eval('#aMsg', (el) => el.textContent), /Заполните отмеченные поля/);
    for (const [k, v] of [['last_name', 'Абдуллаева'], ['first_name', 'Карина'], ['birth_date', '1991-03-14'], ['passport_series', '4512'], ['passport_number', '123456'],
      ['issue_date', '2011-04-22'], ['authority_code', '770-093'], ['issued_by', 'ОВД района'], ['address', 'Москва, ул. Профсоюзная, 1']]) {
      await a.$eval('#af-' + k, (el, val) => { el.value = val; }, v);
    }
    await a.click('#aConsent');
    await a.click('#aSubmit');
    await a.waitForSelector('#aDone:not([hidden])');
    await pause();
    await a.screenshot({ path: '/tmp/edocs-anketa-done.png' });

    // роль кассира: настроек нет
    await p.evaluate(() => localStorage.setItem('edRole', 'admin_cashier'));
    await p.setViewport({ width: 1280, height: 900 });
    await p.goto(base + '?role=cashier#edocs/settings', { waitUntil: 'networkidle0' });   // полная загрузка: роль читается при старте
    await p.waitForSelector('#edbCards .edb-card');
    assert.equal(await p.evaluate(() => location.hash), '#edocs');
    assert.equal(await p.$eval('#edTabBtn-settings', (el) => el.style.display), 'none');

    assert.deepEqual(errors, []);
    console.log('OK: дашборд (сегодня, неделя, вся база), автоматизация, страница пациента (данные, анкета, акт, бумага, F5, старый адрес), комплект на бумаге, настройки, '
      + 'тёмная тема, 390px, анкета пациента, роль кассира. Скриншоты /tmp/edocs-*.png');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
