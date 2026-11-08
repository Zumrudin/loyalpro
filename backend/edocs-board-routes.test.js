'use strict';
// Роутеры дашборда «Документов» (routes/edocs-board.js), публичной анкеты (routes/public-anketa.js)
// и настройки автоматики (routes/edocs-admin.js → parseAutomation).
jest.mock('./db', () => ({ db: { oneOrNone: jest.fn() }, pool: {}, withTransaction: jest.fn() }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
jest.mock('./middleware/auth', () => ({
  auth: (req, res, next) => { req.user = req.__user; next(); },
  requireRole: (...roles) => (req, res, next) => (roles.includes(req.user && req.user.role) ? next() : res.status(403).json({ error: 'Нет доступа' })),
}));
jest.mock('./services/edocs/store', () => ({
  getCredentials: jest.fn(), listTemplates: jest.fn(), getClient: jest.fn(), getIdentityRow: jest.fn(), listClientPackages: jest.fn(),
  getSettings: jest.fn(), saveSettings: jest.fn(), listUsersWithCredentials: jest.fn(),
}));
jest.mock('./services/edocs/board-store', () => ({
  BASE_FILTERS: { all: '', no_contract: '', no_consent: '', open_acts: '', pending: '', ready: '' },
  getBoardSettings: jest.fn(), ensureSettingsRow: jest.fn(), listBoardRecords: jest.fn(), listDocsForClients: jest.fn(),
  listIdentitiesForClients: jest.fn(), listLatestForms: jest.fn(), listAutoNotes: jest.fn(), listBaseClients: jest.fn(),
  listClientRecords: jest.fn(), listClientEvents: jest.fn(),
}));
jest.mock('./services/edocs/paper', () => ({ MAX_SCAN_BYTES: 10 * 1024 * 1024, markPaper: jest.fn(), revokePaper: jest.fn(), scanUrl: jest.fn() }));
jest.mock('./services/edocs/forms', () => ({
  createForm: jest.fn(), formLink: jest.fn(), resendForm: jest.fn(), revokeForm: jest.fn(),
  publicView: jest.fn(), publicSubmit: jest.fn(), publicPhoto: jest.fn(), DEFAULT_MESSAGE: 'Здравствуйте, {имя}! {ссылка}',
}));
jest.mock('./services/edocs/counter', () => ({ yclientsNumber: jest.fn(() => null), peek: jest.fn(async () => ({ next: 1999, maxUsed: 1998 })), setNext: jest.fn() }));
jest.mock('./services/edocs/packages', () => ({ MAX_DOCS: 10 }));
jest.mock('./services/fdoc/client', () => ({ client: {} }));
jest.mock('./services/s3', () => ({}));
jest.mock('./utils/secret-box', () => ({ isConfigured: jest.fn(() => true), box: () => ({}) }));
jest.mock('./config', () => ({ EDOCS_PUBLIC_URL: 'https://dev.zumrudin.ru', EDOCS_TEST_PHONES: [], CERT_REQUEST_POLICY_URL: '/privacy-policy.html' }));

const { Readable } = require('stream');
const store = require('./services/edocs/store');
const boardStore = require('./services/edocs/board-store');
const paper = require('./services/edocs/paper');
const forms = require('./services/edocs/forms');
const counter = require('./services/edocs/counter');
const { EdocsError } = require('./services/edocs/errors');
const boardRouter = require('./routes/edocs-board');
const anketaRouter = require('./routes/public-anketa');
const { parseAutomation } = require('./routes/edocs-admin');

function call(router, method, url, { user = { role: 'admin', salonId: 1, userId: 4 }, body, query, file, fields, ip = '10.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(k, v) { headers[k.toLowerCase()] = v; },
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b, headers }); return this; },
      sendFile(p) { resolve({ status: this.statusCode, file: p, headers }); },
      end() { resolve({ status: this.statusCode, body: null, headers }); return this; },
    };
    const common = { method, url, body, query: query || {}, __user: user, protocol: 'https', ip, get: (h) => (h === 'host' ? 'dev.zumrudin.ru' : undefined) };
    let req;
    if (file || fields) {
      const boundary = '----edocs-test';
      const parts = Object.entries(fields || {}).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
      if (file) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.buffer, Buffer.from('\r\n'));
      const payload = Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]);
      req = Object.assign(Readable.from([payload]), common, {
        body: {}, headers: { host: 'dev.zumrudin.ru', 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(payload.length) },
      });
    } else {
      req = { ...common, headers: { host: 'dev.zumrudin.ru' } };
    }
    router.handle(req, res, () => resolve({ status: 404, body: null, headers }));
  });
}
const UUID = '11111111-1111-4111-8111-111111111111';
const T = [{ id: 5, kind: 'contract', title: 'Договор', is_active: true, sort_order: 0, placeholders: ['fio'] },
  { id: 6, kind: 'consent_pd', title: 'Согласие', is_active: true, sort_order: 1, placeholders: ['fio', 'org_inn'] }];
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());

beforeEach(() => {
  jest.clearAllMocks();
  boardStore.getBoardSettings.mockResolvedValue({ salon_id: 1, enabled: false, acts_from: '2026-10-01', contract_autonumber: true, requisites: {},
    auto_previsit: true, auto_previsit_hours: 24, auto_sender_name: 'Ольга' });
  boardStore.listBoardRecords.mockResolvedValue([]);
  for (const f of ['listDocsForClients', 'listIdentitiesForClients', 'listLatestForms', 'listAutoNotes', 'listClientRecords', 'listClientEvents']) boardStore[f].mockResolvedValue([]);
  store.listTemplates.mockResolvedValue(T);
  store.getCredentials.mockResolvedValue(null);
  store.getClient.mockResolvedValue({ id: 52, name: 'Иванова Анна', phone: '+79200255591', yclients_data: {} });
  store.getIdentityRow.mockResolvedValue({ client_id: 52, last_name: 'Иванова', first_name: 'Анна', phone: '79200255591', secure_enc: 'enc:{"x":1}', secure_fields: [], source: 'manual' });
  store.listClientPackages.mockResolvedValue([]);
});

describe('GET /board', () => {
  test('сегодняшняя карточка, сводка, счётчики периодов, состояние модуля и автоматики, предупреждения', async () => {
    const d = today();
    boardStore.listBoardRecords.mockResolvedValue([{ id: 100, client_id: 52, client_name: 'Иванова Анна', client_phone: '+79200255591', visit_date: d,
      visit_at: new Date(Date.now() + 30 * 60000).toISOString(), attendance: '0', paid_full: '0', services: [{ title: 'Чистка' }], staff: {}, has_prior_visit: true }]);
    const r = await call(boardRouter, 'GET', '/board?range=today', { query: { range: 'today' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ range: 'today', today: d, rangeCounts: { today: 1, tomorrow: 0, week: 1 },
      summary: { total: 1, red: 1 }, chips: { no_contract: 1, no_consent: 1 },
      module: { enabled: false, configured: false, encReady: true, me: { connected: false, broken: false } },
      automation: { previsit: { on: true, hours: 24, scope: 'first', form: true }, act: { on: false }, remind: { on: false }, senderName: 'Ольга' },
      kinds: { contract: { id: 5, title: 'Договор' }, consent_pd: { id: 6, title: 'Согласие' }, act: null } });
    expect(r.body.cards[0]).toMatchObject({ clientId: 52, color: 'red', label: 'Нужно до визита' });
    expect(r.body.warnings).toEqual([{ code: 'no_template', kind: 'act' }, { code: 'org_missing', fields: ['ИНН'] }]);
    expect(boardStore.listBoardRecords.mock.calls[0][1]).toBe('2026-10-01');   // окно — с acts_required_from
  });

  test('неизвестный период — сегодня; строки настроек нет — заводится', async () => {
    boardStore.getBoardSettings.mockResolvedValueOnce(null).mockResolvedValueOnce({ salon_id: 1, acts_from: today(), requisites: {} });
    const r = await call(boardRouter, 'GET', '/board', { query: { range: 'year' } });
    expect(r.body.range).toBe('today');
    expect(boardStore.ensureSettingsRow).toHaveBeenCalledWith(1);
  });

  test('роли: специалисту — 403, кассиру — можно', async () => {
    expect((await call(boardRouter, 'GET', '/board', { user: { role: 'specialist', salonId: 1, userId: 9 } })).status).toBe(403);
    expect((await call(boardRouter, 'GET', '/board', { user: { role: 'admin_cashier', salonId: 1, userId: 9 } })).status).toBe(200);
  });
});

test('GET /board/clients — флаги «Вся база», фильтр из белого списка', async () => {
  boardStore.listBaseClients.mockResolvedValue([{ id: 52, name: 'Иванова', phone: '+7920', last_visit_at: null, contract_signed: true, consent_signed: false, pending: false, open_acts: 2, total: '120' }]);
  const r = await call(boardRouter, 'GET', '/board/clients', { query: { filter: 'evil', page: '2', search: 'Иван' } });
  expect(r.body).toEqual({ page: 2, filter: 'all', total: 120, rows: [{ id: 52, name: 'Иванова', phone: '+7920', lastVisitAt: null, contract: true, consent: false, pending: false, openActs: 2 }] });
  expect(boardStore.listBaseClients).toHaveBeenCalledWith(1, { search: 'Иван', filter: 'all', actsFrom: '2026-10-01', limit: 50, offset: 50 });
});

describe('GET /clients/:id/page', () => {
  test('страница без расшифровки паспорта; превью следующего номера договора', async () => {
    const r = await call(boardRouter, 'GET', '/clients/52/page');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ client: { id: 52, initials: 'ИА' }, numbering: { auto: true, contractNo: null, yclientsNo: null, next: 1999 },
      identity: { exists: true, source: 'manual', secureFields: [] }, templates: [{ id: 5 }, { id: 6 }] });
    expect(JSON.stringify(r.body)).not.toContain('enc:');
    expect(boardStore.listClientRecords.mock.calls[0].slice(0, 2)).toEqual([1, 52]);
  });
  test('нет пациента — 404', async () => {
    store.getClient.mockResolvedValueOnce(null);
    expect((await call(boardRouter, 'GET', '/clients/52/page')).status).toBe(404);
    expect((await call(boardRouter, 'GET', '/clients/abc/page')).status).toBe(404);
  });
});

describe('бумага', () => {
  test('multipart: шаблоны строкой, визит, дата, скан', async () => {
    paper.markPaper.mockResolvedValue({ packageId: UUID });
    const r = await call(boardRouter, 'POST', '/clients/52/paper', { fields: { templateIds: '5,6', signedDate: '2026-07-03', note: 'в клинике' },
      file: { field: 'scan', name: 'scan.pdf', type: 'application/pdf', buffer: Buffer.from('%PDF-1.7') } });
    expect(r).toMatchObject({ status: 200, body: { packageId: UUID } });
    const arg = paper.markPaper.mock.calls[0][0];
    expect(arg).toMatchObject({ salonId: 1, userId: 4, clientId: 52, templateIds: [5, 6], recordId: null, signedDate: '2026-07-03', note: 'в клинике' });
    expect(arg.file.buffer.toString()).toBe('%PDF-1.7');
  });
  test('без шаблонов — 400; снять отметку кассиру нельзя, администратору — можно', async () => {
    expect((await call(boardRouter, 'POST', '/clients/52/paper', { fields: { templateIds: '' } })).status).toBe(400);
    expect((await call(boardRouter, 'POST', `/packages/${UUID}/paper-revoke`, { user: { role: 'admin_cashier', salonId: 1, userId: 9 }, body: { reason: 'ошибка' } })).status).toBe(403);
    paper.revokePaper.mockResolvedValue({ ok: true });
    expect((await call(boardRouter, 'POST', `/packages/${UUID}/paper-revoke`, { body: { reason: 'ошибка' } })).body).toEqual({ ok: true });
    expect(paper.revokePaper).toHaveBeenCalledWith({ salonId: 1, userId: 4, packageId: UUID, reason: 'ошибка' });
    expect((await call(boardRouter, 'GET', '/packages/123/scan')).status).toBe(404);
  });
});

describe('анкеты (администратор)', () => {
  test('создание: проверка тела, адрес из запроса как запасной, ошибки модуля — их кодом', async () => {
    expect((await call(boardRouter, 'POST', '/clients/52/forms', { body: { kinds: ['ids'] } })).status).toBe(400);
    expect((await call(boardRouter, 'POST', '/clients/52/forms', { body: { deliver: 'sms' } })).status).toBe(400);
    forms.createForm.mockResolvedValue({ formId: UUID, url: 'https://dev.zumrudin.ru/anketa/x', qr: 'data:', expiresAt: 'x', delivery: null });
    const r = await call(boardRouter, 'POST', '/clients/52/forms', { body: { kinds: ['contract'], deliver: 'messenger', recordId: 100 } });
    expect(r.body.formId).toBe(UUID);
    expect(forms.createForm).toHaveBeenCalledWith({ salonId: 1, userId: 4, clientId: 52, recordId: 100, kinds: ['contract'], sendDocs: true,
      deliver: 'messenger', source: 'manual', publicBase: 'https://dev.zumrudin.ru' });
    forms.createForm.mockRejectedValueOnce(new EdocsError('no_templates', 'Нет активных шаблонов', 409));
    expect(await call(boardRouter, 'POST', '/clients/52/forms', { body: {} })).toMatchObject({ status: 409, body: { code: 'no_templates' } });
  });
  test('ссылка, повтор, отзыв — по UUID', async () => {
    expect((await call(boardRouter, 'GET', '/forms/abc/link')).status).toBe(404);
    forms.formLink.mockResolvedValue({ url: 'u' });
    expect((await call(boardRouter, 'GET', `/forms/${UUID}/link`)).body).toEqual({ url: 'u' });
    forms.resendForm.mockResolvedValue({ ok: true, channel: 'tdlib' });
    expect((await call(boardRouter, 'POST', `/forms/${UUID}/send`)).body).toEqual({ ok: true, channel: 'tdlib' });
    forms.revokeForm.mockResolvedValue({ ok: true });
    await call(boardRouter, 'POST', `/forms/${UUID}/revoke`);
    expect(forms.revokeForm).toHaveBeenCalledWith({ salonId: 1, formId: UUID, userId: 4 });
  });
});

describe('публичная анкета', () => {
  const TOKEN = 'B'.repeat(43);
  test('страница: строгий CSP, без кэша и Referrer, noindex', async () => {
    const r = await call(anketaRouter, 'GET', `/anketa/${TOKEN}`, { user: null });
    expect(r.file).toMatch(/frontend\/anketa\.html$/);
    expect(r.headers['content-security-policy']).toMatch(/script-src 'self';/);
    expect(r.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(r.headers).toMatchObject({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow' });
  });
  test('данные и отправка; промис фоновой отправки наружу не уходит; ошибки модуля — текстом', async () => {
    forms.publicView.mockResolvedValue({ status: 'active', fields: [] });
    expect((await call(anketaRouter, 'GET', `/api/public/anketa/${TOKEN}`, { user: null })).body).toEqual({ status: 'active', fields: [] });
    forms.publicSubmit.mockResolvedValue({ ok: true, docs: 'sending', _background: Promise.resolve('p') });
    const r = await call(anketaRouter, 'POST', `/api/public/anketa/${TOKEN}`, { user: null, body: { consent: true }, ip: '10.0.0.2' });
    expect(r.body).toEqual({ ok: true, docs: 'sending' });
    expect(forms.publicSubmit).toHaveBeenCalledWith(TOKEN, { consent: true }, { ip: '10.0.0.2' });
    forms.publicSubmit.mockRejectedValueOnce(new EdocsError('form_expired', 'Срок действия ссылки истёк', 410));
    expect(await call(anketaRouter, 'POST', `/api/public/anketa/${TOKEN}`, { user: null, body: {}, ip: '10.0.0.3' }))
      .toMatchObject({ status: 410, body: { error: 'Срок действия ссылки истёк', code: 'form_expired' } });
    forms.publicSubmit.mockRejectedValueOnce(new Error('SELECT … failed'));
    expect(await call(anketaRouter, 'POST', `/api/public/anketa/${TOKEN}`, { user: null, body: {}, ip: '10.0.0.4' }))
      .toMatchObject({ status: 500, body: { code: 'internal' } });
  });
  test('лимит: 11-я отправка одной анкеты за час — 429', async () => {
    forms.publicSubmit.mockResolvedValue({ ok: true, docs: 'none' });
    const tok = 'C'.repeat(43);
    for (let i = 0; i < 10; i++) expect((await call(anketaRouter, 'POST', `/api/public/anketa/${tok}`, { user: null, body: {}, ip: `10.1.0.${i}` })).status).toBe(200);
    expect((await call(anketaRouter, 'POST', `/api/public/anketa/${tok}`, { user: null, body: {}, ip: '10.1.0.99' })).status).toBe(429);
  });
  test('фото — multipart в publicPhoto', async () => {
    forms.publicPhoto.mockResolvedValue({ recognized: false, fields: {} });
    const r = await call(anketaRouter, 'POST', `/api/public/anketa/${TOKEN}/photo`, { user: null, ip: '10.2.0.1',
      file: { field: 'photo', name: 'p.jpg', type: 'image/jpeg', buffer: Buffer.from([0xFF, 0xD8, 0xFF, 0, 1, 2, 3, 4]) } });
    expect(r.body).toEqual({ recognized: false, fields: {} });
    expect(forms.publicPhoto.mock.calls[0][1].originalname).toBe('p.jpg');
  });
});

describe('parseAutomation', () => {
  test('пустое тело — всё выключено, значения по умолчанию', () => {
    expect(parseAutomation({}, { today: '2026-10-25' })).toEqual({ value: {
      auto_previsit: false, auto_previsit_hours: 24, auto_previsit_form: true, auto_previsit_scope: 'first', auto_act: false, auto_act_delay_min: 15,
      auto_remind: false, auto_remind_hours: 2, form_ttl_days: 7, contract_autonumber: true, auto_sender_user_id: null, form_message: null,
    }, nextNo: undefined });
  });
  test('включённая автоматика требует сотрудника; границы чисел; флаги строго boolean', () => {
    expect(parseAutomation({ act: { on: true } }).error).toMatch(/сотрудника/);
    expect(parseAutomation({ act: { on: true }, senderUserId: 4 }).value).toMatchObject({ auto_act: true, auto_sender_user_id: 4 });
    expect(parseAutomation({ previsit: { hours: 1 } }).error).toMatch(/от 2 до 168/);
    expect(parseAutomation({ act: { on: 'yes' } }).error).toMatch(/да или нет/);
    expect(parseAutomation({ previsit: { scope: 'vip' } }).error).toMatch(/первичным или всем/);
  });
  test('текст анкеты с {ссылка}, дата актов не в будущем, следующий номер', () => {
    expect(parseAutomation({ formMessage: 'Заполните анкету' }).error).toMatch(/\{ссылка\}/);
    expect(parseAutomation({ formMessage: ' Анкета: {ссылка} ' }).value.form_message).toBe('Анкета: {ссылка}');
    expect(parseAutomation({ actsRequiredFrom: '2026-12-01' }, { today: '2026-10-25' }).error).toMatch(/не позже сегодняшней/);
    expect(parseAutomation({ actsRequiredFrom: '2026-10-20' }, { today: '2026-10-25' }).value.acts_required_from).toBe('2026-10-20');
    expect(parseAutomation({ contractNextNo: '2100' }).nextNo).toBe(2100);
    expect(parseAutomation({ contractNextNo: '0' }).error).toMatch(/Следующий номер/);
  });
});
