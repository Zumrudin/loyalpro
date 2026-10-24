'use strict';
// /api/edocs/admin — настройки F.Doc, реквизиты, шаблоны (владелец и администратор).
jest.mock('./db', () => ({ db: {}, pool: {}, withTransaction: jest.fn() }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
jest.mock('./middleware/auth', () => ({
  auth: (req, res, next) => { req.user = req.__user; next(); },
  requireRole: (...roles) => (req, res, next) => (roles.includes(req.user && req.user.role) ? next() : res.status(403).json({ error: 'Нет доступа' })),
}));
jest.mock('./services/edocs/store', () => ({
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  getSettings: jest.fn(), saveSettings: jest.fn(), getCredentials: jest.fn(), saveCredentials: jest.fn(), deleteCredentials: jest.fn(),
  listUsersWithCredentials: jest.fn(), listTemplates: jest.fn(), getTemplate: jest.fn(), updateTemplateMeta: jest.fn(), deleteTemplate: jest.fn(),
  searchClients: jest.fn(), getClient: jest.fn(), getIdentityRow: jest.fn(), upsertIdentity: jest.fn(), getLatestCertRequest: jest.fn(),
  listClientPackages: jest.fn(), listClientVisits: jest.fn(), actStatusesForRecords: jest.fn(), getRecord: jest.fn(),
  listPackages: jest.fn(), getPackage: jest.fn(), listDocuments: jest.fn(), listEvents: jest.fn(), getDocument: jest.fn(),
  logEvent: jest.fn(), touchWebhook: jest.fn(), findSalonByWebhookSecret: jest.fn(), findPackageByAnyId: jest.fn(),
}));
jest.mock('./services/edocs/packages', () => ({
  MAX_DOCS: 10, send: jest.fn(), resend: jest.fn(), refreshRows: jest.fn(), employeeUrl: jest.fn(), permalink: jest.fn(), annul: jest.fn(),
  preview: jest.fn(), check: jest.fn(), credFor: jest.fn(),
  fdocConfig: jest.fn(() => ({ baseUrl: 'https://demo.fdoc.ru', apiKey: 'K', appLogin: 'a', appPassword: 'p', appCode: 'c', corpId: 'C1' })),
}));
jest.mock('./services/fdoc/client', () => ({ client: { verifyApiKey: jest.fn(), checkCredentials: jest.fn(), forget: jest.fn(), tariffInfo: jest.fn(), putWebhooks: jest.fn(), recognize: jest.fn() } }));
jest.mock('./services/s3', () => ({ presignGet: jest.fn(async (k) => `https://s3/${k}?sig`), putObject: jest.fn(), deleteObjects: jest.fn(async () => ({})) }));
jest.mock('./utils/secret-box', () => ({
  isConfigured: jest.fn(() => true),
  box: () => ({ encrypt: (x) => `enc:${x}`, decrypt: (x) => String(x).slice(4), encryptJson: (o) => `enc:${JSON.stringify(o)}`, decryptJson: (x) => JSON.parse(String(x).slice(4)) }),
}));

const store = require('./services/edocs/store');
const { client: fdoc } = require('./services/fdoc/client');
const admin = require('./routes/edocs-admin');

function call(router, method, url, { user = { role: 'admin', salonId: 1, userId: 4 }, body, query } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      end() { resolve({ status: this.statusCode, body: null }); return this; },
    };
    const req = { method, url, headers: { host: 'dev.zumrudin.ru' }, body, query: query || {}, __user: user, protocol: 'https', get: (h) => (h === 'host' ? 'dev.zumrudin.ru' : undefined) };
    router.handle(req, res, () => resolve({ status: 404, body: null }));
  });
}
beforeEach(() => jest.clearAllMocks());

describe('parseSettings', () => {
  const { parseSettings } = admin;
  test('домен только fdoc.ru по https; секреты: нет поля — не менять, пустая строка — очистить', () => {
    expect(parseSettings({ baseUrl: 'https://demo.fdoc.ru/', appLogin: ' app ', unsignDays: '7', requisites: { inn: ' 9724060392 ', junk: 'x' } }).value)
      .toEqual({ enabled: false, base_url: 'https://demo.fdoc.ru', app_login: 'app', app_code: null, qes_cert_alias: null, employee_position: null, unsign_days: 7, requisites: { inn: '9724060392' } });
    expect(parseSettings({ apiKey: '', appPassword: ' s3cr3t ' }).value).toMatchObject({ api_key: '', app_password: 's3cr3t' });
    for (const bad of ['http://demo.fdoc.ru', 'https://fdoc.ru.evil.com', 'https://evil.com', 'https://demo.fdoc.ru/api', 'https://u:p@demo.fdoc.ru', 'https://demo.fdoc.ru:8443', 'not a url']) {
      expect(parseSettings({ baseUrl: bad }).error).toMatch(/fdoc\.ru/);
    }
    expect(parseSettings({ unsignDays: 0 }).error).toMatch(/Срок/);
    expect(parseSettings({ unsignDays: [7] }).error).toMatch(/Срок/);
    expect(parseSettings({ apiKey: 123 }).error).toMatch(/Ключ API/);
  });
});

describe('/api/edocs/admin', () => {
  test('специалист и кассир — 403', async () => {
    expect((await call(admin, 'GET', '/settings', { user: { role: 'admin_cashier', salonId: 1, userId: 5 } })).status).toBe(403);
    expect((await call(admin, 'GET', '/settings', { user: { role: 'specialist', salonId: 1, userId: 5 } })).status).toBe(403);
  });
  test('GET /settings не отдаёт секреты, отдаёт признак и URL вебхука', async () => {
    store.getSettings.mockResolvedValue({ enabled: true, base_url: 'https://demo.fdoc.ru', api_key_enc: 'enc:K', app_password_enc: 'enc:P', app_login: 'a', webhook_secret: 'ab'.repeat(24), corp_id: 'C1', requisites: {} });
    const r = await call(admin, 'GET', '/settings');
    expect(r.body).toMatchObject({ hasApiKey: true, hasAppPassword: true, corpId: 'C1', webhookUrl: `https://dev.zumrudin.ru/fdoc/webhook/${'ab'.repeat(24)}`, encReady: true });
    expect(JSON.stringify(r.body)).not.toMatch(/enc:/);
  });
  test('PUT /settings: смена ключа сбрасывает corpId; включить без проверки нельзя', async () => {
    store.getSettings.mockResolvedValue({ base_url: 'https://demo.fdoc.ru', app_login: 'a', app_code: 'c', corp_id: 'C1' });
    let r = await call(admin, 'PUT', '/settings', { body: { baseUrl: 'https://demo.fdoc.ru', appLogin: 'a', appCode: 'c', apiKey: 'NEW' } });
    expect(r.body).toEqual({ ok: true, needVerify: true });
    expect(store.saveSettings.mock.calls[0][1]).toMatchObject({ api_key_enc: 'enc:NEW', corp_id: null, enabled: false });
    r = await call(admin, 'PUT', '/settings', { body: { enabled: true, baseUrl: 'https://demo.fdoc.ru', appLogin: 'a', appCode: 'c', apiKey: 'NEW2' } });
    expect(r.status).toBe(400);
    r = await call(admin, 'PUT', '/settings', { body: { enabled: true, baseUrl: 'https://demo.fdoc.ru', appLogin: 'a', appCode: 'c' } });
    expect(r.body).toEqual({ ok: true, needVerify: false });
    expect(store.saveSettings.mock.calls[1][1]).not.toHaveProperty('corp_id');
  });
  test('POST /settings/verify сохраняет corpId; ошибка F.Doc — 502 с текстом', async () => {
    store.getSettings.mockResolvedValue({});
    fdoc.verifyApiKey.mockResolvedValueOnce('777');
    expect((await call(admin, 'POST', '/settings/verify')).body).toEqual({ corpId: '777' });
    expect(store.saveSettings).toHaveBeenCalledWith(1, { corp_id: '777' });
    fdoc.verifyApiKey.mockRejectedValueOnce(Object.assign(new Error('F.Doc GET /x 401: Неверный ключ'), { name: 'FdocError', code: 'fdoc_unauthorized' }));
    expect(await call(admin, 'POST', '/settings/verify')).toEqual({ status: 502, body: { error: 'F.Doc GET /x 401: Неверный ключ', code: 'fdoc_unauthorized' } });
  });
  test('POST /settings/webhook создаёт секрет один раз и подписывается', async () => {
    store.getSettings.mockResolvedValue({ webhook_secret: null });
    const r = await call(admin, 'POST', '/settings/webhook');
    const secret = store.saveSettings.mock.calls[0][1].webhook_secret;
    expect(secret).toMatch(/^[a-f0-9]{48}$/);
    expect(r.body.url).toBe(`https://dev.zumrudin.ru/fdoc/webhook/${secret}`);
    expect(fdoc.putWebhooks).toHaveBeenCalledWith(expect.anything(), r.body.url);
  });
  test('шаблоны: смена вида проверяет теги; удаление занятого — 409', async () => {
    store.getTemplate.mockResolvedValue({ id: 3, kind: 'act', placeholders: ['fio', 'services'] });
    let r = await call(admin, 'PUT', '/templates/3', { body: { title: 'Акт', kind: 'contract', isActive: true, sortOrder: 1 } });
    expect(r.status).toBe(400);
    expect(r.body.details).toEqual(['Тег {services} разрешён только в шаблоне акта']);
    r = await call(admin, 'PUT', '/templates/3', { body: { title: 'Акт', kind: 'act', isActive: 'false', sortOrder: '2' } });
    expect(store.updateTemplateMeta).toHaveBeenCalledWith(1, 3, { title: 'Акт', kind: 'act', is_active: false, sort_order: 2 });
    store.deleteTemplate.mockResolvedValueOnce('busy');
    expect((await call(admin, 'DELETE', '/templates/3')).status).toBe(409);
    store.deleteTemplate.mockResolvedValueOnce({ fileKey: 'edocs/1/templates/x.docx' });
    expect((await call(admin, 'DELETE', '/templates/3')).body).toEqual({ ok: true });
  });
  test('словарь тегов — статический путь раньше :id', async () => {
    const r = await call(admin, 'GET', '/templates/dictionary');
    expect(r.body.fields.length).toBeGreaterThan(30);
  });
});
