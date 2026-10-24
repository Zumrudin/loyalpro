'use strict';
// /api/edocs — оформление документов (+ администратор-кассир) и вебхук F.Doc.
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
  preview: jest.fn(), check: jest.fn(), credFor: jest.fn(), clearCredentialPause: jest.fn(),
  fdocConfig: jest.fn(() => ({ baseUrl: 'https://demo.fdoc.ru', apiKey: 'K', appLogin: 'a', appPassword: 'p', appCode: 'c', corpId: 'C1' })),
}));
jest.mock('./services/fdoc/client', () => ({ client: { verifyApiKey: jest.fn(), checkCredentials: jest.fn(), forget: jest.fn(), tariffInfo: jest.fn(), putWebhooks: jest.fn(), recognize: jest.fn() } }));
jest.mock('./services/s3', () => ({ presignGet: jest.fn(async (k) => `https://s3/${k}?sig`), putObject: jest.fn(), deleteObjects: jest.fn(async () => ({})) }));
jest.mock('./utils/secret-box', () => ({
  isConfigured: jest.fn(() => true),
  box: () => ({ encrypt: (x) => `enc:${x}`, decrypt: (x) => String(x).slice(4), encryptJson: (o) => `enc:${JSON.stringify(o)}`, decryptJson: (x) => JSON.parse(String(x).slice(4)) }),
}));

const store = require('./services/edocs/store');
const packages = require('./services/edocs/packages');
const { client: fdoc } = require('./services/fdoc/client');
const { EdocsError } = require('./services/edocs/errors');
const ops = require('./routes/edocs');
const webhook = require('./routes/fdoc-webhook');

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
const PKG_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => jest.clearAllMocks());

describe('parsePackageBody', () => {
  const { parsePackageBody } = ops;
  test('валидное тело и ошибки', () => {
    expect(parsePackageBody({ clientId: '52', templateIds: [10, '11', 10], docDate: '2026-10-24' }, { today: '2026-10-24' }).value)
      .toEqual({ clientId: 52, templateIds: [10, 11], recordId: null, docDate: '2026-10-24', actLines: null });
    expect(parsePackageBody({ templateIds: [1] }).error).toMatch(/пациент/);
    expect(parsePackageBody({ clientId: 1, templateIds: [] }).error).toMatch(/от 1 до 10/);
    expect(parsePackageBody({ clientId: 1, templateIds: [1, 'x'] }).error).toMatch(/шаблон/);
    expect(parsePackageBody({ clientId: 1, templateIds: [1], recordId: 'abc' }).error).toMatch(/визит/);
    expect(parsePackageBody({ clientId: 1, templateIds: [1], docDate: '2027-01-01' }, { today: '2026-10-24' }).error).toMatch(/Дата/);
    expect(parsePackageBody({ clientId: 1, templateIds: [1], actLines: 'x' }).error).toMatch(/Строки/);
    expect(parsePackageBody({ clientId: 1, templateId: 7 }, { single: true }).value.templateIds).toEqual([7]);
  });
});

describe('/api/edocs', () => {
  test('кассир допущен, специалист — нет', async () => {
    store.getSettings.mockResolvedValue({ enabled: true, corp_id: 'C1' });
    store.getCredentials.mockResolvedValue(null);
    expect((await call(ops, 'GET', '/state', { user: { role: 'admin_cashier', salonId: 1, userId: 5 } })).body)
      .toEqual({ enabled: true, configured: true, encReady: true, role: 'admin_cashier', me: { connected: false, login: null, broken: false, lastError: null } });
    expect((await call(ops, 'GET', '/state', { user: { role: 'specialist', salonId: 1, userId: 6 } })).status).toBe(403);
  });
  test('PUT /me/credentials: проверка входом до сохранения; неверный пароль — 400', async () => {
    store.getSettings.mockResolvedValue({ corp_id: 'C1' });
    fdoc.checkCredentials.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'fdoc_credentials_invalid' }));
    expect((await call(ops, 'PUT', '/me/credentials', { body: { login: 'ivanova', password: 'bad' } })).status).toBe(400);
    expect(store.saveCredentials).not.toHaveBeenCalled();
    expect(packages.clearCredentialPause).not.toHaveBeenCalled();
    fdoc.checkCredentials.mockResolvedValueOnce(true);
    store.saveCredentials.mockResolvedValueOnce(true);
    expect((await call(ops, 'PUT', '/me/credentials', { body: { login: ' ivanova ', password: 'pw' } })).body).toEqual({ ok: true });
    expect(store.saveCredentials).toHaveBeenCalledWith(1, 4, 'ivanova', 'enc:pw');
    expect(packages.clearCredentialPause).toHaveBeenCalledWith(1, 4);   // новый пароль проверен входом — фон снова берёт учётку
    expect((await call(ops, 'PUT', '/me/credentials', { body: { login: 'x' } })).status).toBe(400);
  });
  test('PUT /me/credentials: строка учётки в другом салоне — 409, журнал не пишется', async () => {
    store.getSettings.mockResolvedValue({ corp_id: 'C1' });
    fdoc.checkCredentials.mockResolvedValueOnce(true);
    store.saveCredentials.mockResolvedValueOnce(false);
    expect(await call(ops, 'PUT', '/me/credentials', { body: { login: 'ivanova', password: 'pw' } }))
      .toEqual({ status: 409, body: { error: 'Учётная запись принадлежит другому салону' } });
    expect(store.logEvent).not.toHaveBeenCalled();
    expect(packages.clearCredentialPause).not.toHaveBeenCalled();
  });
  test('GET identity расшифровывает и пишет просмотр в журнал', async () => {
    store.getClient.mockResolvedValue({ id: 52 });
    store.getIdentityRow.mockResolvedValue({ last_name: 'Иванова', first_name: 'Анна', secure_enc: `enc:${JSON.stringify({ passport_series: '4510' })}`, secure_fields: ['passport_series'], source: 'manual' });
    const r = await call(ops, 'GET', '/clients/52/identity');
    expect(r.body).toMatchObject({ exists: true, plain: { last_name: 'Иванова' }, secure: { passport_series: '4510' } });
    expect(store.logEvent).toHaveBeenCalledWith({ salonId: 1, clientId: 52, kind: 'identity_view', userId: 4 });
  });
  test('PUT identity: ошибка формы — 400, иначе шифротекст и журнал правки без значений', async () => {
    store.getClient.mockResolvedValue({ id: 52 });
    expect((await call(ops, 'PUT', '/clients/52/identity', { body: { secure: { passport_series: '1' } } })).status).toBe(400);
    const r = await call(ops, 'PUT', '/clients/52/identity', { body: { last_name: 'Иванова', phone: '89200255591', secure: { passport_series: '4510', passport_number: '123456' } } });
    expect(r.body).toEqual({ ok: true });
    const saved = store.upsertIdentity.mock.calls[0][2];
    expect(saved.secure_enc).toBe(`enc:${JSON.stringify({ passport_series: '4510', passport_number: '123456' })}`);
    expect(saved.plain.phone).toBe('79200255591');
    expect(store.logEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'identity_edit', payload: { plain: ['last_name', 'phone'], secure: ['passport_series', 'passport_number'], source: 'manual' } }));
    expect(JSON.stringify(store.logEvent.mock.calls)).not.toContain('123456');
  });
  test('нет ключа шифрования — 503 с понятным текстом', async () => {
    const sb = require('./utils/secret-box');
    const orig = sb.box;
    sb.box = () => { const e = new Error('no key'); e.name = 'SecretBoxError'; e.code = 'no_key'; throw e; };
    store.getClient.mockResolvedValue({ id: 52 });
    const r = await call(ops, 'PUT', '/clients/52/identity', { body: { last_name: 'Иванова' } });
    sb.box = orig;
    expect(r).toMatchObject({ status: 503, body: { code: 'enc_not_configured' } });
  });
  test('POST /packages: нехватка данных уходит списком; F.Doc-ошибка — 502 с id комплекта', async () => {
    packages.send.mockRejectedValueOnce(new EdocsError('missing_fields', 'Не хватает данных', 400, { missing: { identity: [{ key: 'phone', label: 'Телефон' }], org: [] } }));
    let r = await call(ops, 'POST', '/packages', { body: { clientId: 52, templateIds: [10] } });
    expect(r).toEqual({ status: 400, body: { error: 'Не хватает данных', code: 'missing_fields', missing: { identity: [{ key: 'phone', label: 'Телефон' }], org: [] } } });
    packages.send.mockRejectedValueOnce(new EdocsError('fdoc_rejected', 'F.Doc не принял комплект: x', 502, { packageId: PKG_ID }));
    r = await call(ops, 'POST', '/packages', { body: { clientId: 52, templateIds: [10] } });
    expect(r.body).toMatchObject({ code: 'fdoc_rejected', packageId: PKG_ID });
    packages.send.mockResolvedValueOnce({ packageId: PKG_ID });
    r = await call(ops, 'POST', '/packages', { body: { clientId: 52, templateIds: [10] } });
    expect(packages.send).toHaveBeenLastCalledWith({ salonId: 1, userId: 4, clientId: 52, templateIds: [10], recordId: null, docDate: null, actLines: null });
  });
  test('комплект по не-UUID — 404 без запроса в БД; карточка с документами', async () => {
    expect((await call(ops, 'GET', '/packages/123')).status).toBe(404);
    expect(store.getPackage).not.toHaveBeenCalled();
    store.getPackage.mockResolvedValue({ id: PKG_ID, kind: 'onboarding', title: 'Документы', status: 'signed', client_id: 52, payload: { patient: { fio: 'Иванова Анна' } } });
    store.listDocuments.mockResolvedValue([{ id: 'd', title: 'Договор', file_name: 'Договор.docx', pdf_key: 'k' }]);
    store.listEvents.mockResolvedValue([]);
    const r = await call(ops, 'GET', `/packages/${PKG_ID}`);
    expect(r.body).toMatchObject({ id: PKG_ID, status: 'signed', patient: { fio: 'Иванова Анна' }, documents: [{ id: 'd', title: 'Договор', fileName: 'Договор.docx', hasPdf: true }] });
    expect(store.listDocuments).toHaveBeenCalledWith(1, PKG_ID);
  });
  test('действия по комплекту передают salonId/userId', async () => {
    packages.annul.mockResolvedValue({ ok: true });
    await call(ops, 'POST', `/packages/${PKG_ID}/annul`);
    expect(packages.annul).toHaveBeenCalledWith({ salonId: 1, userId: 4, packageId: PKG_ID });
  });
  test('PDF: нет ещё — 409; есть — ссылка на 15 минут', async () => {
    store.getDocument.mockResolvedValueOnce({ id: 'd', pdf_key: null });
    expect((await call(ops, 'GET', `/documents/${PKG_ID}/pdf`)).status).toBe(409);
    store.getDocument.mockResolvedValueOnce({ id: 'd', pdf_key: 'edocs/1/p/d.pdf' });
    expect((await call(ops, 'GET', `/documents/${PKG_ID}/pdf`)).body).toEqual({ url: 'https://s3/edocs/1/p/d.pdf?sig' });
  });
  test('сводка по пациенту отдаётся и при выключенном модуле (мастер работает без F.Doc)', async () => {
    store.getSettings.mockResolvedValue({ enabled: false });
    store.getClient.mockResolvedValue({ id: 52, name: 'Иванова Анна', phone: '79200255591' });
    store.getIdentityRow.mockResolvedValue(null);
    store.listClientPackages.mockResolvedValue([]);
    expect((await call(ops, 'GET', '/clients/52/summary')).body).toEqual({
      enabled: false, client: { id: 52, name: 'Иванова Анна', phone: '79200255591' }, identity: { exists: false }, packages: [],
    });
  });
  test('статусы актов по записям', async () => {
    store.getSettings.mockResolvedValue({ enabled: true });
    store.actStatusesForRecords.mockResolvedValue([{ record_id: 30252, package_id: PKG_ID, status: 'sent' }]);
    const r = await call(ops, 'GET', '/records/act-status', { query: { ids: '30252,abc,30253' } });
    expect(store.actStatusesForRecords).toHaveBeenCalledWith(1, [30252, 30253]);
    expect(r.body).toEqual({ enabled: true, statuses: { 30252: { packageId: PKG_ID, status: 'sent' } } });
  });
  test('черновик акта: только по состоявшемуся визиту', async () => {
    store.getRecord.mockResolvedValueOnce({ id: 1, attendance: '2', deleted: false });
    expect((await call(ops, 'GET', '/records/1/act-draft')).status).toBe(409);
    store.getRecord.mockResolvedValueOnce({ id: 1, client_id: 52, yclients_record_id: 99, attendance: '1', deleted: false, visit_date: '2026-10-23',
      staff: { name: 'Пери', position: { title: 'Врач' } }, services: [{ id: 5, title: 'Чистка', amount: 1, first_cost: 3500, manual_cost: 3500 }] });
    const r = await call(ops, 'GET', '/records/1/act-draft');
    expect(r.body).toMatchObject({ record: { id: 1, clientId: 52, actNo: '99' }, doctor: { name: 'Пери', position: 'Врач' }, totals: { total_sum: 3500 } });
  });
});

describe('вебхук F.Doc', () => {
  test('неизвестный или кривой секрет — 404 без тела', async () => {
    expect((await call(webhook, 'POST', '/webhook/short')).status).toBe(404);
    store.findSalonByWebhookSecret.mockResolvedValueOnce(null);
    expect((await call(webhook, 'POST', `/webhook/${'a'.repeat(48)}`)).status).toBe(404);
  });
  test('известный секрет — 200 сразу, затем журнал и перечитывание статуса', async () => {
    store.findSalonByWebhookSecret.mockResolvedValue(1);
    store.findPackageByAnyId.mockResolvedValue({ id: PKG_ID, salon_id: 1 });
    packages.refreshRows.mockResolvedValue({ checked: 1, changed: 1 });
    const r = await call(webhook, 'POST', `/webhook/${'a'.repeat(48)}`, { body: { packageId: PKG_ID, status: 'SIGNED', documentIds: [PKG_ID], evil: 'x'.repeat(10) } });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    await new Promise((s) => setImmediate(s));
    await new Promise((s) => setImmediate(s));
    expect(store.logEvent).toHaveBeenCalledWith({ salonId: 1, packageId: PKG_ID, kind: 'webhook', payload: { packageId: PKG_ID, status: 'SIGNED', documentIds: [PKG_ID] } });
    expect(packages.refreshRows).toHaveBeenCalledWith(1, [{ id: PKG_ID, salon_id: 1 }]);
  });
  test('processWebhook: чужой комплект — без перечитывания', async () => {
    store.findPackageByAnyId.mockResolvedValue(null);
    await webhook.processWebhook(1, { packageId: 'foreign' });
    expect(packages.refreshRows).not.toHaveBeenCalled();
  });
});
