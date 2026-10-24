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
  isTemplateBusy: jest.fn(), replaceTemplateFile: jest.fn(), saveCorpIdIfUnchanged: jest.fn(),
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

const { Readable } = require('stream');
const store = require('./services/edocs/store');
const s3 = require('./services/s3');
const { client: fdoc } = require('./services/fdoc/client');
const admin = require('./routes/edocs-admin');
const { makeDocx, p } = require('./services/edocs/__fixtures__/docx');

function call(router, method, url, { user = { role: 'admin', salonId: 1, userId: 4 }, body, query, file } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      end() { resolve({ status: this.statusCode, body: null }); return this; },
    };
    const common = { method, url, body, query: query || {}, __user: user, protocol: 'https', get: (h) => (h === 'host' ? 'dev.zumrudin.ru' : undefined) };
    let req;
    if (file) {
      // Файл — настоящим multipart-потоком: multer разбирает его как боевой запрос (сокетов нет).
      const boundary = '----edocs-test';
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`),
        file.buffer,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      req = Object.assign(Readable.from([payload]), common, {
        body: {}, headers: { host: 'dev.zumrudin.ru', 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(payload.length) },
      });
    } else {
      req = { ...common, headers: { host: 'dev.zumrudin.ru' } };
    }
    router.handle(req, res, () => resolve({ status: 404, body: null }));
  });
}
const tick = () => new Promise((r) => setImmediate(r));
async function until(cond) {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  if (!cond()) throw new Error('условие так и не наступило');
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
    const row = { api_key_enc: 'enc:K', base_url: 'https://demo.fdoc.ru' };
    store.getSettings.mockResolvedValue(row);
    store.saveCorpIdIfUnchanged.mockResolvedValueOnce(true);
    fdoc.verifyApiKey.mockResolvedValueOnce('777');
    expect((await call(admin, 'POST', '/settings/verify')).body).toEqual({ corpId: '777' });
    expect(store.saveCorpIdIfUnchanged).toHaveBeenCalledWith(1, '777', row);
    fdoc.verifyApiKey.mockRejectedValueOnce(Object.assign(new Error('F.Doc GET /x 401: Неверный ключ'), { name: 'FdocError', code: 'fdoc_unauthorized' }));
    expect(await call(admin, 'POST', '/settings/verify')).toEqual({ status: 502, body: { error: 'F.Doc GET /x 401: Неверный ключ', code: 'fdoc_unauthorized' } });
    expect(store.saveCorpIdIfUnchanged).toHaveBeenCalledTimes(1);   // после отказа F.Doc corpId не пишется
  });
  test('POST /settings/verify: пока шла проверка, PUT сохранил другой ключ — corpId не записывается, 409', async () => {
    const before = { api_key_enc: 'enc:OLD', base_url: 'https://demo.fdoc.ru', corp_id: null };
    const after = { api_key_enc: 'enc:NEW', base_url: 'https://demo.fdoc.ru', corp_id: null };
    store.getSettings.mockResolvedValueOnce(before).mockResolvedValue(after);
    fdoc.verifyApiKey.mockResolvedValueOnce('777');
    store.saveCorpIdIfUnchanged.mockResolvedValueOnce(false);   // в БД уже другой ключ — условный UPDATE ничего не записал
    expect(await call(admin, 'POST', '/settings/verify')).toEqual({ status: 409, body: { error: 'Настройки изменились во время проверки — проверьте ещё раз' } });
    // сверяемся с тем, что было прочитано ДО проверки (а не с перечитанными настройками)
    expect(store.saveCorpIdIfUnchanged).toHaveBeenCalledWith(1, '777', before);
    expect(store.saveSettings).not.toHaveBeenCalled();
  });
  test('POST /settings/webhook создаёт секрет один раз и подписывается', async () => {
    store.getSettings.mockResolvedValue({ webhook_secret: null });
    const r = await call(admin, 'POST', '/settings/webhook');
    const secret = store.saveSettings.mock.calls[0][1].webhook_secret;
    expect(secret).toMatch(/^[a-f0-9]{48}$/);
    expect(r.body.url).toBe(`https://dev.zumrudin.ru/fdoc/webhook/${secret}`);
    expect(fdoc.putWebhooks).toHaveBeenCalledWith(expect.anything(), r.body.url);
  });
  test('POST /settings/webhook: параллельный вызов того же салона — 409, подписка не задваивается; другой салон не мешает', async () => {
    store.getSettings.mockResolvedValue({ webhook_secret: null });
    let release;
    fdoc.putWebhooks.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const first = call(admin, 'POST', '/settings/webhook');
    try {
      await until(() => fdoc.putWebhooks.mock.calls.length === 1);   // первый дошёл до подписки в F.Doc и ждёт ответа
      expect(await call(admin, 'POST', '/settings/webhook')).toEqual({ status: 409, body: { error: 'Подписка уже выполняется' } });
      expect(store.saveSettings).toHaveBeenCalledTimes(1);   // второй секрет не создан
      expect(fdoc.putWebhooks).toHaveBeenCalledTimes(1);
      expect((await call(admin, 'POST', '/settings/webhook', { user: { role: 'admin', salonId: 2, userId: 9 } })).status).toBe(200);
    } finally { if (release) release(); }   // замок не должен пережить упавшую проверку и испортить соседние тесты
    expect((await first).status).toBe(200);
    expect((await call(admin, 'POST', '/settings/webhook')).status).toBe(200);   // замок снят
  });
  test('POST /settings/webhook: ошибка F.Doc тоже снимает замок', async () => {
    store.getSettings.mockResolvedValue({ webhook_secret: 'ab'.repeat(24) });
    fdoc.putWebhooks.mockRejectedValueOnce(Object.assign(new Error('F.Doc PUT /x 403: IP не зарегистрирован'), { name: 'FdocError', code: 'fdoc_forbidden' }));
    expect((await call(admin, 'POST', '/settings/webhook')).status).toBe(502);
    expect((await call(admin, 'POST', '/settings/webhook')).status).toBe(200);
  });
  test('шаблоны: смена вида проверяет теги; удаление занятого — 409', async () => {
    store.getTemplate.mockResolvedValue({ id: 3, kind: 'act', is_active: true, placeholders: ['fio', 'services'] });
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
  describe('шаблон в неподписанном комплекте', () => {
    const BUSY = { error: 'Шаблон в неподписанном комплекте — дождитесь подписи или аннулируйте комплект' };
    const docxUpload = () => ({ file: { field: 'file', name: 'new.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: makeDocx({ body: p('Договор с {fio}') }) } });
    beforeEach(() => {
      store.getTemplate.mockResolvedValue({ id: 3, kind: 'contract', title: 'Договор', is_active: true, sort_order: 0, placeholders: ['fio'], file_key: 'edocs/1/templates/old.docx' });
      store.updateTemplateMeta.mockResolvedValue(true);
      store.replaceTemplateFile.mockResolvedValue('edocs/1/templates/old.docx');
    });

    test('замена файла: 409 тем же ответом, что у удаления; S3 и БД не тронуты, прежний файл цел', async () => {
      store.isTemplateBusy.mockResolvedValue(true);
      const r = await call(admin, 'POST', '/templates/3/file', docxUpload());
      expect(r).toEqual({ status: 409, body: BUSY });
      expect(store.isTemplateBusy).toHaveBeenCalledWith(1, 3);
      expect(s3.putObject).not.toHaveBeenCalled();
      expect(store.replaceTemplateFile).not.toHaveBeenCalled();
      expect(s3.deleteObjects).not.toHaveBeenCalled();
      store.deleteTemplate.mockResolvedValueOnce('busy');
      expect(await call(admin, 'DELETE', '/templates/3')).toEqual(r);
    });
    test('замена файла свободного шаблона проходит: новый файл в S3, запись в БД, прежний файл удалён', async () => {
      store.isTemplateBusy.mockResolvedValue(false);
      const r = await call(admin, 'POST', '/templates/3/file', docxUpload());
      expect(r).toEqual({ status: 200, body: { ok: true, placeholders: ['fio'] } });
      expect(s3.putObject).toHaveBeenCalledTimes(1);
      expect(store.replaceTemplateFile).toHaveBeenCalledWith(1, 3, expect.objectContaining({ placeholders: ['fio'] }));
      expect(s3.deleteObjects).toHaveBeenCalledWith(['edocs/1/templates/old.docx']);
    });
    test('выключение занятого шаблона — 409; смена названия, порядка и включение — можно', async () => {
      store.isTemplateBusy.mockResolvedValue(true);
      let r = await call(admin, 'PUT', '/templates/3', { body: { title: 'Договор', kind: 'contract', isActive: false, sortOrder: 0 } });
      expect(r).toEqual({ status: 409, body: BUSY });
      expect(store.updateTemplateMeta).not.toHaveBeenCalled();
      // название и порядок, шаблон остаётся включённым
      r = await call(admin, 'PUT', '/templates/3', { body: { title: 'Договор (новый)', kind: 'contract', isActive: true, sortOrder: 5 } });
      expect(r.status).toBe(200);
      expect(store.updateTemplateMeta).toHaveBeenLastCalledWith(1, 3, { title: 'Договор (новый)', kind: 'contract', is_active: true, sort_order: 5 });
      // включение выключенного шаблона
      store.getTemplate.mockResolvedValue({ id: 3, kind: 'contract', title: 'Договор', is_active: false, sort_order: 0, placeholders: ['fio'] });
      r = await call(admin, 'PUT', '/templates/3', { body: { title: 'Договор', kind: 'contract', isActive: true, sortOrder: 0 } });
      expect(r.status).toBe(200);
      // выключенный остаётся выключенным (правка названия) — это не «выключение»
      r = await call(admin, 'PUT', '/templates/3', { body: { title: 'Договор 2', kind: 'contract', isActive: false, sortOrder: 0 } });
      expect(r.status).toBe(200);
      expect(store.updateTemplateMeta).toHaveBeenCalledTimes(3);
    });
    test('смена вида занятого шаблона — 409; тот же вид — можно', async () => {
      store.isTemplateBusy.mockResolvedValue(true);
      let r = await call(admin, 'PUT', '/templates/3', { body: { title: 'Договор', kind: 'consent_pd', isActive: true, sortOrder: 0 } });
      expect(r).toEqual({ status: 409, body: BUSY });
      expect(store.updateTemplateMeta).not.toHaveBeenCalled();
      r = await call(admin, 'PUT', '/templates/3', { body: { title: 'Договор', kind: 'contract', isActive: true, sortOrder: 0 } });
      expect(r.status).toBe(200);
    });
    test('свободный шаблон: вид и включённость меняются без помех', async () => {
      store.isTemplateBusy.mockResolvedValue(false);
      expect((await call(admin, 'PUT', '/templates/3', { body: { title: 'Договор', kind: 'consent_pd', isActive: false, sortOrder: 0 } })).status).toBe(200);
      expect(store.updateTemplateMeta).toHaveBeenCalledWith(1, 3, { title: 'Договор', kind: 'consent_pd', is_active: false, sort_order: 0 });
    });
  });
  test('словарь тегов — статический путь раньше :id', async () => {
    const r = await call(admin, 'GET', '/templates/dictionary');
    expect(r.body.fields.length).toBeGreaterThan(30);
  });
});
