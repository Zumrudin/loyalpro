'use strict';
jest.mock('./services/edocs/store', () => ({
  getSettings: jest.fn(), getCredentials: jest.fn(), pickCredentials: jest.fn(), markCredentialsOk: jest.fn(), markCredentialsFail: jest.fn(),
  getClient: jest.fn(), getTemplatesByIds: jest.fn(), getRecord: jest.fn(), getIdentityRow: jest.fn(),
  insertPackage: jest.fn(), markSent: jest.fn(), markSendError: jest.fn(), logEvent: jest.fn(), getPackage: jest.fn(),
  listDocuments: jest.fn(), applyStatus: jest.fn(), touchStatusCheck: jest.fn(), setDocumentPdf: jest.fn(), setEmployeeUrl: jest.fn(),
  listDuePackages: jest.fn(),
}));
jest.mock('./services/s3', () => ({ getObjectBuffer: jest.fn(), putObject: jest.fn() }));
jest.mock('./services/fdoc/client', () => ({
  client: { sendPackage: jest.fn(), workflowStatuses: jest.fn(), downloadPdf: jest.fn(), employeeUrl: jest.fn(), sendPermalink: jest.fn(), declinePackage: jest.fn(), recognize: jest.fn() },
}));
jest.mock('./utils/secret-box', () => ({
  box: () => ({ decrypt: (x) => String(x).replace(/^enc:/, ''), decryptJson: (x) => JSON.parse(String(x).replace(/^enc:/, '')) }),
}));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));
jest.mock('./config', () => ({ EDOCS_DEMO_PHONES: ['79200255591'] }));

const store = require('./services/edocs/store');
const s3 = require('./services/s3');
const { client: fdoc } = require('./services/fdoc/client');
const pk = require('./services/edocs/packages');
const { makeDocx, docText, p, table } = require('./services/edocs/__fixtures__/docx');

const tick = () => new Promise((r) => setImmediate(r));
/** Ждать, пока асинхронная цепочка дойдёт до нужного места (моки резолвятся микрозадачами). */
async function until(cond) {
  for (let i = 0; i < 200 && !cond(); i++) await tick();
  if (!cond()) throw new Error('условие так и не наступило');
}
/** Промис, который открывается вручную: «медленный» ответ F.Doc. */
function gate() { let open; const promise = new Promise((r) => { open = r; }); return { promise, open }; }

const SETTINGS = { salon_id: 1, enabled: true, base_url: 'https://demo.fdoc.ru', api_key_enc: 'enc:KEY', app_login: 'app', app_password_enc: 'enc:APW', app_code: 'crm', corp_id: 'C1', qes_cert_alias: 'peri-qes', employee_position: 'Администратор', unsign_days: 7, requisites: { name: 'ООО «Пери Клиник»', inn: '9724060392', city: 'Москва' } };
const CLIENT = { id: 52, name: 'Иванова Анна Сергеевна', phone: '+79200255591', yclients_data: {} };
const IDENTITY = { client_id: 52, last_name: 'Иванова', first_name: 'Анна', middle_name: 'Сергеевна', birth_date: '1983-03-21', gender: 'F', phone: '79200255591', email: null, contract_no: '1739', contract_date: null,
  secure_enc: 'enc:' + JSON.stringify({ passport_series: '4510', passport_number: '123456' }), secure_fields: ['passport_series', 'passport_number'] };
const T_CONTRACT = { id: 10, kind: 'contract', title: 'Договор', is_active: true, file_key: 'k/contract.docx', placeholders: ['fio', 'passport', 'org_name'] };
const T_ACT = { id: 11, kind: 'act', title: 'Акт', is_active: true, file_key: 'k/act.docx', placeholders: ['fio', 'services', 'total_sum'] };
const RECORD = { id: 30252, client_id: 52, yclients_record_id: 2056697734, attendance: '1', deleted: false, visit_date: '2026-10-23',
  staff: { name: 'Гаджиева Пери', position: { title: 'Врач-косметолог' } },
  services: [{ id: 1, title: 'Чистка', amount: 1, discount: 0, first_cost: 3500, manual_cost: 3500, cost: 3500 }] };
const FILES = {
  'k/contract.docx': makeDocx({ body: p('Договор с {fio}, паспорт {passport}, исполнитель {org_name}') }),
  'k/act.docx': makeDocx({ body: p('Акт: {fio}') + table([['{#services}{title}', '{sum}{/services}']]) + p('Итого {total_sum}') }),
};

beforeEach(() => {
  jest.clearAllMocks();
  pk._reset();
  store.getSettings.mockResolvedValue(SETTINGS);
  store.getCredentials.mockResolvedValue({ user_id: 4, login: 'ivanova', password_enc: 'enc:pw', fail_count: 0 });
  store.getClient.mockResolvedValue(CLIENT);
  store.getIdentityRow.mockResolvedValue(IDENTITY);
  store.getTemplatesByIds.mockImplementation(async (sid, ids) => [T_CONTRACT, T_ACT].filter((t) => ids.includes(t.id)));
  store.getRecord.mockResolvedValue(RECORD);
  store.getPackage.mockImplementation(async (sid, id) => ({ id, salon_id: 1, client_id: 52, status: 'sent', sent_by: 4, title: 'Документы', payload: {} }));
  store.listDocuments.mockResolvedValue([]);
  store.applyStatus.mockResolvedValue(true);
  s3.getObjectBuffer.mockImplementation(async (key) => FILES[key]);
  fdoc.sendPackage.mockResolvedValue({ url: 'https://demo.fdoc.ru/employee/xyz' });
  fdoc.workflowStatuses.mockResolvedValue({ packages: [], failures: [] });
});

describe('send', () => {
  test('собирает DOCX с данными, вставляет комплект, отправляет с маршрутом «клиника → пациент»', async () => {
    const r = await pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10], docDate: '2026-10-24' });
    expect(r.packageId).toMatch(/^[0-9a-f-]{36}$/);
    const [pkg, docs] = store.insertPackage.mock.calls[0];
    expect(pkg).toMatchObject({ id: r.packageId, salon_id: 1, client_id: 52, record_id: null, kind: 'onboarding', title: 'Документы от 24.10.2026', sent_by: 4 });
    expect(pkg.payload).toEqual({ templateIds: [10], docDate: '2026-10-24', act: null, patient: { fio: 'Иванова Анна Сергеевна', phone: '79200255591' } });
    expect(docs).toEqual([{ id: expect.any(String), template_id: 10, title: 'Договор', file_name: 'Договор.docx', sort_order: 0 }]);
    const [cfg, cred, body] = fdoc.sendPackage.mock.calls[0];
    expect(cfg).toEqual({ baseUrl: 'https://demo.fdoc.ru', apiKey: 'KEY', appLogin: 'app', appPassword: 'APW', appCode: 'crm', corpId: 'C1' });
    expect(cred).toMatchObject({ userId: 4, login: 'ivanova', password: 'pw' });
    expect(body.package).toEqual({ id: r.packageId, name: 'Документы от 24.10.2026', objectId: 'client:52', signers: [
      { type: 'corp', priority: 1, operatorAutoSign: true, qesCertAlias: 'peri-qes', employeePosition: 'Администратор' },
      { type: 'client', priority: 2, id: '52', name: 'Иванова Анна Сергеевна', phone: '+79200255591' },
    ] });
    expect(body.documents[0]).toMatchObject({ id: docs[0].id, name: 'Договор.docx', unsignExpiredDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(docText(Buffer.from(body.documents[0].file, 'base64'))).toBe('Договор с Иванова Анна Сергеевна, паспорт 4510 123456, исполнитель ООО «Пери Клиник»');
    expect(store.markSent).toHaveBeenCalledWith(1, r.packageId, { employeeUrl: 'https://demo.fdoc.ru/employee/xyz', userId: 4 });
    expect(fdoc.workflowStatuses).toHaveBeenCalledWith(expect.anything(), expect.anything(), [r.packageId]);
  });

  test('не хватает данных — 400 со списком, в F.Doc ничего не уходит', async () => {
    store.getIdentityRow.mockResolvedValue({ ...IDENTITY, secure_enc: null, secure_fields: [] });
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] })).rejects.toMatchObject({
      code: 'missing_fields', status: 400, missing: { identity: [{ key: 'passport_number', label: 'Номер паспорта' }, { key: 'passport_series', label: 'Серия паспорта' }], org: [] },
    });
    expect(store.insertPackage).not.toHaveBeenCalled();
    expect(fdoc.sendPackage).not.toHaveBeenCalled();
  });

  test('модуль выключен, F.Doc не подключён, нет учётки сотрудника — 409', async () => {
    store.getSettings.mockResolvedValueOnce({ ...SETTINGS, enabled: false });
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] })).rejects.toMatchObject({ code: 'not_enabled', status: 409 });
    store.getSettings.mockResolvedValueOnce({ ...SETTINGS, corp_id: null });
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] })).rejects.toMatchObject({ code: 'not_configured' });
    store.getCredentials.mockResolvedValueOnce(null);
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] })).rejects.toMatchObject({ code: 'fdoc_no_credentials', status: 409 });
  });

  test('F.Doc отверг комплект (HTTP 4xx) — черновик с ошибкой, 502 fdoc_rejected с id комплекта', async () => {
    fdoc.sendPackage.mockRejectedValue(Object.assign(new Error('F.Doc POST /x 400: Файл повреждён'), { name: 'FdocError', code: 'fdoc_rejected', status: 400 }));
    const e = await pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] }).catch((x) => x);
    expect(e).toMatchObject({ name: 'EdocsError', code: 'fdoc_rejected', status: 502, packageId: expect.any(String), message: 'F.Doc не принял комплект: F.Doc POST /x 400: Файл повреждён' });
    expect(store.markSendError).toHaveBeenCalledWith(1, e.packageId, 'F.Doc POST /x 400: Файл повреждён');
    expect(store.markSent).not.toHaveBeenCalled();
    expect(store.logEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'send_error', packageId: e.packageId }));
  });

  test('неоднозначный сбой отправки (сеть, таймаут, 5xx) — 502 fdoc_send_unknown: сначала проверить, не дошёл ли', async () => {
    const unknown = 'Не удалось подтвердить отправку в F.Doc — откройте комплект и нажмите «Повторить»: сначала проверим, не дошёл ли он';
    for (const err of [
      Object.assign(new Error('F.Doc POST /x network: ECONNABORTED'), { name: 'FdocError', code: 'fdoc_network', status: null }),
      Object.assign(new Error('F.Doc POST /x 502: bad gateway'), { name: 'FdocError', code: 'fdoc_server', status: 502 }),
      new Error('socket hang up'),
    ]) {
      store.markSendError.mockClear();
      fdoc.sendPackage.mockRejectedValueOnce(err);
      const e = await pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] }).catch((x) => x);
      expect(e).toMatchObject({ name: 'EdocsError', code: 'fdoc_send_unknown', status: 502, packageId: expect.any(String), message: unknown });
      expect(store.markSendError).toHaveBeenCalledWith(1, e.packageId, err.message);
    }
    expect(store.markSent).not.toHaveBeenCalled();
  });

  test('F.Doc не принял пароль сотрудника — счётчик отказов и 409 с id комплекта', async () => {
    fdoc.sendPackage.mockRejectedValue(Object.assign(new Error('bad'), { code: 'fdoc_credentials_invalid', status: 401 }));
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] })).rejects.toMatchObject({ code: 'fdoc_credentials_invalid', status: 409, packageId: expect.any(String) });
    expect(store.markCredentialsFail).toHaveBeenCalledWith(1, 4, 'bad');
  });

  test('ошибка записи ошибки не теряет класс ответа: всё равно EdocsError с id комплекта', async () => {
    fdoc.sendPackage.mockRejectedValue(Object.assign(new Error('F.Doc POST /x 400: x'), { name: 'FdocError', code: 'fdoc_rejected', status: 400 }));
    store.markSendError.mockRejectedValueOnce(new Error('connection terminated'));
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] })).rejects.toMatchObject({ code: 'fdoc_rejected', packageId: expect.any(String) });
  });

  test('F.Doc принял, а сохранить не удалось — 500 saved_partially без текста БД; ошибки отправки нет', async () => {
    store.markSent.mockRejectedValueOnce(Object.assign(new Error('deadlock detected on relation edoc_packages'), { code: '40P01' }));
    const e = await pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] }).catch((x) => x);
    expect(e).toMatchObject({ name: 'EdocsError', code: 'saved_partially', status: 500, packageId: expect.any(String),
      message: 'F.Doc принял комплект, но статус не сохранился — откройте комплект и нажмите «Повторить»: мы найдём его в F.Doc и отметим отправленным' });
    expect(e.message).not.toMatch(/deadlock|edoc_packages/);
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('deadlock detected'));
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining(e.packageId));
    expect(store.markSendError).not.toHaveBeenCalled();
    expect(store.logEvent).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'send_error' }));
  });

  test('markSent → false (статус уже сдвинут перечитыванием) — не ошибка', async () => {
    store.markSent.mockResolvedValueOnce(false);
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] })).resolves.toMatchObject({ packageId: expect.any(String) });
    expect(store.logEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'send' }));
  });

  test('акт: строки из записи, привязка к визиту, номер акта — id записи YClients', async () => {
    const r = await pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [11], recordId: 30252, docDate: '2026-10-24' });
    const [pkg] = store.insertPackage.mock.calls[0];
    expect(pkg).toMatchObject({ kind: 'act', record_id: 30252, title: 'Акт от 24.10.2026' });
    expect(pkg.payload.act).toEqual({ act_no: '2056697734', visit_date: '2026-10-23', doctor_name: 'Гаджиева Пери', doctor_position: 'Врач-косметолог',
      lines: [{ service_id: 1, title: 'Чистка', qty: 1, price: 3500, sum: 3500 }] });
    const body = fdoc.sendPackage.mock.calls[0][2];
    expect(docText(Buffer.from(body.documents[0].file, 'base64'))).toBe('Акт: Иванова Анна СергеевнаЧистка3 500,00Итого 3 500,00');
    expect(r.packageId).toBe(pkg.id);
  });

  test('акт по несостоявшемуся визиту — 409; без визита — 400; чужой визит — 404', async () => {
    store.getRecord.mockResolvedValueOnce({ ...RECORD, attendance: '2' });
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [11], recordId: 30252 })).rejects.toMatchObject({ code: 'act_visit_not_done', status: 409 });
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [11] })).rejects.toMatchObject({ code: 'act_needs_record', status: 400 });
    store.getRecord.mockResolvedValueOnce({ ...RECORD, client_id: 99 });
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [11], recordId: 30252 })).rejects.toMatchObject({ status: 404 });
  });

  test('акт без врача — 409 act_no_doctor, без даты визита — 409 act_no_date; должность врача не обязательна', async () => {
    const act = { salonId: 1, userId: 4, clientId: 52, templateIds: [11], recordId: 30252 };
    store.getRecord.mockResolvedValueOnce({ ...RECORD, staff: { name: '  ', position: { title: 'Врач-косметолог' } } });
    await expect(pk.send(act)).rejects.toMatchObject({ code: 'act_no_doctor', status: 409, message: 'В визите не указан врач — укажите исполнителя в YClients и повторите' });
    store.getRecord.mockResolvedValueOnce({ ...RECORD, staff: null });
    await expect(pk.send(act)).rejects.toMatchObject({ code: 'act_no_doctor', status: 409 });
    store.getRecord.mockResolvedValueOnce({ ...RECORD, visit_date: null });
    await expect(pk.send(act)).rejects.toMatchObject({ code: 'act_no_date', status: 409, message: 'У визита нет даты' });
    expect(store.insertPackage).not.toHaveBeenCalled();
    expect(fdoc.sendPackage).not.toHaveBeenCalled();
    store.getRecord.mockResolvedValueOnce({ ...RECORD, staff: { name: 'Гаджиева Пери' } });
    await pk.send(act);
    expect(store.insertPackage.mock.calls[0][0].payload.act).toMatchObject({ doctor_name: 'Гаджиева Пери', doctor_position: '' });
  });

  test('демо-стенд: отправка только на тестовые номера; боевой стенд — без ограничения', async () => {
    store.getIdentityRow.mockResolvedValue({ ...IDENTITY, phone: '79001112233' });
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] })).rejects.toMatchObject({ code: 'demo_phone_blocked', status: 409 });
    expect(store.insertPackage).not.toHaveBeenCalled();
    store.getSettings.mockResolvedValue({ ...SETTINGS, base_url: 'https://fdoc.ru' });
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] })).resolves.toMatchObject({ packageId: expect.any(String) });
  });

  test('правленые строки акта проверяются', async () => {
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [11], recordId: 30252, actLines: [{ title: '', qty: 1, price: 1, sum: 1 }] }))
      .rejects.toMatchObject({ code: 'bad_act_lines', status: 400 });
  });

  test('выключенный или чужой шаблон, больше 10 документов', async () => {
    store.getTemplatesByIds.mockResolvedValueOnce([{ ...T_CONTRACT, is_active: false }]);
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] })).rejects.toMatchObject({ code: 'bad_templates' });
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10, 999] })).rejects.toMatchObject({ code: 'bad_templates' });
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: Array.from({ length: 11 }, (_, i) => i + 1) })).rejects.toMatchObject({ code: 'bad_templates' });
  });
});

describe('resend', () => {
  const DRAFT = { id: '11111111-1111-4111-8111-111111111111', salon_id: 1, client_id: 52, status: 'draft', sent_by: 4, title: 'Документы от 24.10.2026', record_id: null,
    payload: { templateIds: [10], docDate: '2026-10-24' }, last_error: 'F.Doc POST /x network: ETIMEDOUT', created_at: new Date() };
  const DOCS = [{ id: 'd-1', template_id: 10, title: 'Договор', file_name: 'Договор.docx', sort_order: 0 }];
  const credOf = (uid, failCount = 0) => ({ user_id: uid, login: `u${uid}`, password_enc: 'enc:pw', fail_count: failCount });
  const CHECK_FAILED = { name: 'EdocsError', code: 'fdoc_check_failed', status: 502, message: 'Не удалось проверить комплект в F.Doc — повторите позже' };

  test('свежий черновик без ошибки — 409 send_in_progress, F.Doc не трогаем', async () => {
    store.getPackage.mockResolvedValue({ ...DRAFT, last_error: null, created_at: new Date(Date.now() - 60 * 1000) });
    await expect(pk.resend({ salonId: 1, userId: 4, packageId: DRAFT.id })).rejects.toMatchObject({ code: 'send_in_progress', status: 409, message: 'Комплект ещё отправляется — повторить можно через 5 минут после начала отправки' });
    expect(fdoc.workflowStatuses).not.toHaveBeenCalled();
    expect(fdoc.sendPackage).not.toHaveBeenCalled();
  });
  test('черновик без ошибки старше 5 минут (процесс упал посреди отправки) — повтор разрешён', async () => {
    store.getPackage.mockResolvedValue({ ...DRAFT, last_error: null, created_at: new Date(Date.now() - 6 * 60 * 1000) });
    store.listDocuments.mockResolvedValue(DOCS);
    await pk.resend({ salonId: 1, userId: 4, packageId: DRAFT.id });
    expect(fdoc.workflowStatuses).toHaveBeenCalledTimes(2);   // проверка + перечитывание после отправки
    expect(fdoc.sendPackage).toHaveBeenCalledTimes(1);
  });
  test('пока ждали замок, комплект ушёл из черновиков — 409 already_sent без запросов в F.Doc', async () => {
    store.getPackage.mockResolvedValueOnce(DRAFT).mockResolvedValue({ ...DRAFT, status: 'sent' });
    await expect(pk.resend({ salonId: 1, userId: 4, packageId: DRAFT.id })).rejects.toMatchObject({ code: 'already_sent', status: 409 });
    expect(fdoc.workflowStatuses).not.toHaveBeenCalled();
  });
  test('проверка — учёткой отправителя; найден — отправителем остаётся тот, кому F.Doc его показал', async () => {
    store.getPackage.mockResolvedValue({ ...DRAFT, sent_by: 7 });
    store.getCredentials.mockImplementation(async (sid, uid) => credOf(uid));
    fdoc.workflowStatuses.mockResolvedValue({ packages: [{ id: DRAFT.id, status: 'WAIT_SIGN', documents: [] }], failures: [] });
    expect(await pk.resend({ salonId: 1, userId: 4, packageId: DRAFT.id })).toEqual({ packageId: DRAFT.id, recovered: true });
    expect(fdoc.workflowStatuses.mock.calls[0][1]).toMatchObject({ userId: 7, login: 'u7' });
    expect(store.markSent).toHaveBeenCalledWith(1, DRAFT.id, { userId: 7 });
  });
  test('учётки отправителя нет или она заперта — проверка учёткой текущего пользователя', async () => {
    store.getPackage.mockResolvedValue({ ...DRAFT, sent_by: 7 });
    fdoc.workflowStatuses.mockResolvedValue({ packages: [{ id: DRAFT.id, status: 'WAIT_SIGN', documents: [] }], failures: [] });
    store.getCredentials.mockImplementation(async (sid, uid) => (uid === 7 ? null : credOf(uid)));
    await pk.resend({ salonId: 1, userId: 4, packageId: DRAFT.id });
    expect(fdoc.workflowStatuses.mock.calls[0][1]).toMatchObject({ userId: 4 });
    fdoc.workflowStatuses.mockClear();
    store.getCredentials.mockImplementation(async (sid, uid) => credOf(uid, uid === 7 ? 3 : 0));
    await pk.resend({ salonId: 1, userId: 4, packageId: DRAFT.id });
    expect(fdoc.workflowStatuses.mock.calls[0][1]).toMatchObject({ userId: 4 });
  });
  test('пароль отправителя отвергнут при проверке — счётчик его учётки и 502 fdoc_check_failed без отправки', async () => {
    store.getPackage.mockResolvedValue({ ...DRAFT, sent_by: 7 });
    store.getCredentials.mockImplementation(async (sid, uid) => credOf(uid));
    fdoc.workflowStatuses.mockRejectedValue(Object.assign(new Error('bad'), { name: 'FdocError', code: 'fdoc_credentials_invalid', status: 401 }));
    await expect(pk.resend({ salonId: 1, userId: 4, packageId: DRAFT.id })).rejects.toMatchObject(CHECK_FAILED);
    expect(store.markCredentialsFail).toHaveBeenCalledWith(1, 7, 'bad');
    expect(fdoc.sendPackage).not.toHaveBeenCalled();
  });
  test('свой пароль отвергнут при проверке — 409 «Мой F.Doc»', async () => {
    store.getPackage.mockResolvedValue(DRAFT);
    fdoc.workflowStatuses.mockRejectedValue(Object.assign(new Error('bad'), { name: 'FdocError', code: 'fdoc_credentials_invalid', status: 401 }));
    await expect(pk.resend({ salonId: 1, userId: 4, packageId: DRAFT.id })).rejects.toMatchObject({ code: 'fdoc_credentials_invalid', status: 409 });
    expect(fdoc.sendPackage).not.toHaveBeenCalled();
  });
  test('повторный POST — только при однозначном «нет»; иначе 502 fdoc_check_failed без отправки', async () => {
    store.getPackage.mockResolvedValue(DRAFT);
    store.listDocuments.mockResolvedValue(DOCS);
    for (const answer of [
      { packages: [], failures: [{ id: DRAFT.id, code: 'ACCESS_DENIED', message: 'нет доступа' }] },   // другая ошибка по нашему id
      { packages: [{ id: 'чужой-комплект', status: 'WAIT_SIGN' }], failures: [] },                     // единственный, но чужой
      { packages: [], failures: [{ code: 'NOT_FOUND' }] },                                               // NOT_FOUND без id
      { packages: [], failures: [{ id: 'другой-id', code: 'NOT_FOUND' }] },                              // NOT_FOUND не по нашему id
      { packages: [null], failures: [] },                                                                // непонятный ответ
    ]) {
      fdoc.workflowStatuses.mockResolvedValueOnce(answer);
      await expect(pk.resend({ salonId: 1, userId: 4, packageId: DRAFT.id })).rejects.toMatchObject(CHECK_FAILED);
    }
    fdoc.workflowStatuses.mockRejectedValueOnce(Object.assign(new Error('F.Doc POST /x network: ETIMEDOUT'), { name: 'FdocError', code: 'fdoc_network', status: null }));
    await expect(pk.resend({ salonId: 1, userId: 4, packageId: DRAFT.id })).rejects.toMatchObject(CHECK_FAILED);
    expect(fdoc.sendPackage).not.toHaveBeenCalled();
    expect(store.markSent).not.toHaveBeenCalled();
  });
  test('однозначное «нет»: пустой ответ без failures — повторная отправка', async () => {
    store.getPackage.mockResolvedValue(DRAFT);
    store.listDocuments.mockResolvedValue(DOCS);
    fdoc.workflowStatuses.mockResolvedValue({ packages: [], failures: [] });
    await pk.resend({ salonId: 1, userId: 4, packageId: DRAFT.id });
    expect(fdoc.sendPackage).toHaveBeenCalledTimes(1);
  });
  test('единственный комплект без id в ответе — считается нашим', async () => {
    store.getPackage.mockResolvedValue(DRAFT);
    fdoc.workflowStatuses.mockResolvedValue({ packages: [{ status: 'WAIT_SIGN', documents: [] }], failures: [] });
    expect(await pk.resend({ salonId: 1, userId: 4, packageId: DRAFT.id })).toEqual({ packageId: DRAFT.id, recovered: true });
    expect(fdoc.sendPackage).not.toHaveBeenCalled();
  });
  test('F.Doc уже знает комплект — отмечаем отправленным без повторной отправки', async () => {
    store.getPackage.mockResolvedValue(DRAFT);
    fdoc.workflowStatuses.mockResolvedValue({ packages: [{ id: DRAFT.id, status: 'WAIT_SIGN', documents: [] }], failures: [] });
    expect(await pk.resend({ salonId: 1, userId: 4, packageId: DRAFT.id })).toEqual({ packageId: DRAFT.id, recovered: true });
    expect(fdoc.sendPackage).not.toHaveBeenCalled();
    expect(store.markSent).toHaveBeenCalledWith(1, DRAFT.id, { userId: 4 });
  });
  test('F.Doc комплекта не знает — повторная отправка с теми же id', async () => {
    store.getPackage.mockResolvedValue(DRAFT);
    store.listDocuments.mockResolvedValue([{ id: 'd-1', template_id: 10, title: 'Договор', file_name: 'Договор.docx', sort_order: 0 }]);
    fdoc.workflowStatuses.mockResolvedValue({ packages: [], failures: [{ id: DRAFT.id, code: 'NOT_FOUND' }] });
    await pk.resend({ salonId: 1, userId: 4, packageId: DRAFT.id });
    const body = fdoc.sendPackage.mock.calls[0][2];
    expect(body.package.id).toBe(DRAFT.id);
    expect(body.documents.map((d) => d.id)).toEqual(['d-1']);
  });
  test('уже отправленный — 409', async () => {
    store.getPackage.mockResolvedValue({ ...DRAFT, status: 'sent' });
    await expect(pk.resend({ salonId: 1, userId: 4, packageId: DRAFT.id })).rejects.toMatchObject({ code: 'already_sent', status: 409 });
  });
});

describe('refreshRows и refreshDue', () => {
  const ROW = { id: '22222222-2222-4222-8222-222222222222', salon_id: 1, client_id: 52, status: 'sent', sent_by: 4, fdoc_package_guid: null };
  const BAD = Object.assign(new Error('F.Doc не принял логин или пароль сотрудника: x'), { name: 'FdocError', code: 'fdoc_credentials_invalid', status: 401 });
  test('статус меняется — журнал; подписан — PDF в S3', async () => {
    store.listDocuments.mockResolvedValue([{ id: 'd-1', file_name: 'Договор.docx', title: 'Договор', pdf_key: null }]);
    fdoc.workflowStatuses.mockResolvedValue({ packages: [{ id: ROW.id, status: 'SIGNED', documents: [{ id: 'd-1', status: 'SIGNED', clientSigners: [{ isSigned: true, dateSignOrCancel: '2026-10-24T10:00:00+03:00' }] }] }] });
    // Под замком строка читается заново (ещё sent), после применения — уже signed (докачка PDF).
    store.getPackage.mockResolvedValueOnce({ ...ROW }).mockResolvedValue({ ...ROW, status: 'signed' });
    fdoc.downloadPdf.mockResolvedValue(Buffer.from('%PDF-1.7'));
    expect(await pk.refreshRows(1, [ROW])).toEqual({ checked: 1, changed: 1 });
    expect(store.listDocuments).toHaveBeenCalledWith(1, ROW.id);
    expect(store.applyStatus).toHaveBeenCalledWith(1, ROW.id, expect.objectContaining({ package: expect.objectContaining({ status: 'signed' }) }));
    expect(store.logEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'status', payload: { from: 'sent', to: 'signed', fdoc: 'SIGNED' } }));
    expect(fdoc.downloadPdf).toHaveBeenCalledWith(expect.anything(), expect.anything(), ROW.id, 'd-1');
    expect(s3.putObject).toHaveBeenCalledWith(`edocs/1/packages/${ROW.id}/d-1.pdf`, Buffer.from('%PDF-1.7'), 'application/pdf');
    expect(store.setDocumentPdf).toHaveBeenCalledWith(1, 'd-1', `edocs/1/packages/${ROW.id}/d-1.pdf`);
    expect(store.touchStatusCheck).toHaveBeenCalledWith(1, [ROW.id]);
  });
  test('откат статуса отвергнут (applyStatus → false) — без события и без «изменился»', async () => {
    store.getPackage.mockResolvedValue({ ...ROW, status: 'signed' });
    store.applyStatus.mockResolvedValue(false);
    fdoc.workflowStatuses.mockResolvedValue({ packages: [{ id: ROW.id, status: 'WAIT_SIGN', documents: [] }] });
    expect(await pk.refreshRows(1, [{ ...ROW, status: 'signed' }])).toEqual({ checked: 1, changed: 0 });
    expect(store.logEvent).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'status' }));
  });
  test('фоновое перечитывание не меняет счётчик отказов учётки', async () => {
    fdoc.workflowStatuses.mockRejectedValueOnce(BAD);
    // Ни один комплект не проверен — ошибка уходит вызывающему как есть (без «Мой F.Doc»: учётка могла быть чужой).
    await expect(pk.refreshRows(1, [ROW])).rejects.toBe(BAD);
    expect(store.markCredentialsFail).not.toHaveBeenCalled();
    expect(store.markCredentialsOk).not.toHaveBeenCalled();
  });
  test('два тика подряд с неверным паролем → один вход в F.Doc, а не два', async () => {
    fdoc.workflowStatuses.mockRejectedValue(BAD);   // вход паролем внутри вызова отвергнут
    store.pickCredentials.mockResolvedValue(null);  // другой рабочей учётки в салоне нет
    store.listDuePackages.mockResolvedValue([ROW]);
    await pk.refreshDue();
    await pk.refreshDue();
    expect(fdoc.workflowStatuses).toHaveBeenCalledTimes(1);
    expect(store.markCredentialsFail).not.toHaveBeenCalled();
  });
  test('пауза учётки в фоне — 60 минут, потом фон пробует её снова', async () => {
    const now = jest.spyOn(Date, 'now');
    try {
      const t0 = Date.UTC(2026, 9, 24, 7, 0, 0);
      now.mockReturnValue(t0);
      fdoc.workflowStatuses.mockRejectedValue(BAD);
      store.pickCredentials.mockResolvedValue(null);
      await expect(pk.refreshRows(1, [ROW])).rejects.toBe(BAD);
      now.mockReturnValue(t0 + 59 * 60 * 1000);
      expect(await pk.refreshRows(1, [ROW])).toEqual({ checked: 0, changed: 0 });   // пропуск группы, без входа
      expect(fdoc.workflowStatuses).toHaveBeenCalledTimes(1);
      now.mockReturnValue(t0 + 61 * 60 * 1000);
      await expect(pk.refreshRows(1, [ROW])).rejects.toBe(BAD);
      expect(fdoc.workflowStatuses).toHaveBeenCalledTimes(2);
    } finally { now.mockRestore(); }
  });
  test('учётка на паузе — фон берёт другую рабочую по прежнему порядку; остальные пачки группы — уже ею', async () => {
    const id = (n) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;
    const rows = Array.from({ length: 11 }, (_, i) => ({ ...ROW, id: id(i) }));   // две пачки одного отправителя
    store.getPackage.mockImplementation(async (sid, pid) => rows.find((r) => r.id === pid) || null);
    store.pickCredentials.mockResolvedValue({ user_id: 9, login: 'admin2', password_enc: 'enc:pw2', fail_count: 0 });
    fdoc.workflowStatuses.mockImplementation(async (cfg, cred, ids) => {
      if (cred.userId === 4) throw BAD;
      return { packages: ids.map((x) => ({ id: x, status: 'WAIT_SIGN', documents: [] })), failures: [] };
    });
    expect(await pk.refreshRows(1, rows)).toEqual({ checked: 1, changed: 0 });
    expect(fdoc.workflowStatuses.mock.calls.map((c) => c[1].userId)).toEqual([4, 9]);   // второй раз тем же паролем не входим
    expect(store.pickCredentials).toHaveBeenCalledWith(1, 4, { failBelow: 1, exclude: [4] });
    fdoc.workflowStatuses.mockClear();
    await pk.refreshRows(1, rows.slice(0, 1));   // следующий тик: отправитель на паузе — сразу другая учётка
    expect(fdoc.workflowStatuses.mock.calls.map((c) => c[1].userId)).toEqual([9]);
  });
  test('учётку с записанным отказом (fail_count ≥ 1) фон не берёт: пусть человек обновит пароль', async () => {
    store.getCredentials.mockResolvedValue({ user_id: 4, login: 'ivanova', password_enc: 'enc:pw', fail_count: 1 });
    store.pickCredentials.mockResolvedValue(null);
    expect(await pk.refreshRows(1, [ROW])).toEqual({ checked: 0, changed: 0 });
    expect(fdoc.workflowStatuses).not.toHaveBeenCalled();
    expect(store.pickCredentials).toHaveBeenCalledWith(1, 4, { failBelow: 1, exclude: [] });
    expect(store.markCredentialsOk).not.toHaveBeenCalled();
  });
  test('действия пользователя паузу не учитывают; удачный вход пользователя её снимает', async () => {
    fdoc.workflowStatuses.mockRejectedValueOnce(BAD);
    store.pickCredentials.mockResolvedValue(null);
    await expect(pk.refreshRows(1, [ROW])).rejects.toBe(BAD);   // фон: учётка 4 на паузе
    await pk.refreshRows(1, [ROW]);
    expect(fdoc.workflowStatuses).toHaveBeenCalledTimes(1);
    fdoc.employeeUrl.mockResolvedValue('https://demo.fdoc.ru/w/1');
    await pk.employeeUrl({ salonId: 1, userId: 4, packageId: 'p' });   // пользователь входит той же учёткой
    expect(fdoc.employeeUrl.mock.calls[0][1]).toMatchObject({ userId: 4 });
    await pk.refreshRows(1, [ROW]);
    expect(fdoc.workflowStatuses).toHaveBeenCalledTimes(2);
    expect(fdoc.workflowStatuses.mock.calls[1][1]).toMatchObject({ userId: 4 });
  });
  test('новый пароль в «Мой F.Doc» снимает паузу (clearCredentialPause)', async () => {
    fdoc.workflowStatuses.mockRejectedValueOnce(BAD);
    store.pickCredentials.mockResolvedValue(null);
    await expect(pk.refreshRows(1, [ROW])).rejects.toBe(BAD);
    pk.clearCredentialPause(1, 4);
    await pk.refreshRows(1, [ROW]);
    expect(fdoc.workflowStatuses).toHaveBeenCalledTimes(2);
  });
  test('докачка PDF — тоже фон: отказ входа не наращивает счётчик и ставит учётку на паузу', async () => {
    store.listDocuments.mockResolvedValue([{ id: 'd-1', pdf_key: null }]);
    store.pickCredentials.mockResolvedValue(null);
    fdoc.downloadPdf.mockRejectedValue(BAD);
    const signed = { id: ROW.id, client_id: 52, sent_by: 4 };
    await expect(pk.fetchPdfs(1, signed, {})).rejects.toBe(BAD);
    expect(store.markCredentialsFail).not.toHaveBeenCalled();
    await expect(pk.fetchPdfs(1, signed, {})).rejects.toMatchObject({ code: 'fdoc_no_credentials' });
    expect(fdoc.downloadPdf).toHaveBeenCalledTimes(1);
  });
  test('действие пользователя ведёт счётчик: удача после отказов сбрасывает его в салоне учётки', async () => {
    store.getCredentials.mockResolvedValue({ user_id: 4, login: 'ivanova', password_enc: 'enc:pw', fail_count: 1 });
    fdoc.employeeUrl.mockResolvedValue('https://demo.fdoc.ru/w/1');
    await pk.employeeUrl({ salonId: 1, userId: 4, packageId: 'p' });
    expect(store.markCredentialsOk).toHaveBeenCalledWith(1, 4);
  });
  test('сбой одной группы или пачки не обрывает остальные; после каждой пачки — отметка проверки', async () => {
    const id = (n) => `66666666-6666-4666-8666-${String(n).padStart(12, '0')}`;
    const rows = [...Array.from({ length: 11 }, (_, i) => ({ ...ROW, id: id(i), sent_by: 4 })), { ...ROW, id: id(70), sent_by: 7 }, { ...ROW, id: id(90), sent_by: 9 }];
    store.getPackage.mockImplementation(async (sid, pid) => rows.find((r) => r.id === pid) || null);
    store.getCredentials.mockImplementation(async (sid, uid) => {
      if (uid === 7) throw new Error('connection terminated');   // группа 7: сбой БД при чтении учётки
      return { user_id: uid, login: `u${uid}`, password_enc: 'enc:pw', fail_count: 0 };
    });
    let n = 0;
    fdoc.workflowStatuses.mockImplementation(async (cfg, cred, ids) => {
      n++;
      if (n === 1) throw Object.assign(new Error('F.Doc POST /x 503: down'), { name: 'FdocError', code: 'fdoc_server', status: 503 });   // первая пачка группы 4
      return { packages: ids.map((x) => ({ id: x, status: 'WAIT_SIGN', documents: [] })), failures: [] };
    });
    expect(await pk.refreshRows(1, rows)).toEqual({ checked: 2, changed: 0 });
    expect(fdoc.workflowStatuses).toHaveBeenCalledTimes(3);
    expect(store.touchStatusCheck.mock.calls.map((c) => c[1])).toEqual([rows.slice(0, 10).map((r) => r.id), [id(10)], [id(70)], [id(90)]]);
  });
  test('WARN об опросе салона — не чаще раза в час на пару салон+причина', async () => {
    const now = jest.spyOn(Date, 'now');
    try {
      const t0 = Date.UTC(2026, 9, 24, 7, 0, 0);
      now.mockReturnValue(t0);
      store.getCredentials.mockResolvedValue(null);
      store.pickCredentials.mockResolvedValue(null);
      store.listDuePackages.mockResolvedValue([{ ...ROW, salon_id: 7 }]);
      await pk.refreshDue();
      await pk.refreshDue();
      expect(mockLog.warn).toHaveBeenCalledTimes(1);
      now.mockReturnValue(t0 + 61 * 60 * 1000);
      await pk.refreshDue();
      expect(mockLog.warn).toHaveBeenCalledTimes(2);
    } finally { now.mockRestore(); }
  });
  test('учётки отправителя нет — берётся любая рабочая в салоне', async () => {
    store.getCredentials.mockResolvedValue(null);
    store.pickCredentials.mockResolvedValue({ user_id: 9, login: 'admin2', password_enc: 'enc:pw2', fail_count: 0 });
    await pk.refreshRows(1, [ROW]);
    expect(fdoc.workflowStatuses.mock.calls[0][1]).toMatchObject({ userId: 9, login: 'admin2' });
  });
  test('ни одной рабочей учётки — опрос пропущен без исключения', async () => {
    store.getCredentials.mockResolvedValue(null);
    store.pickCredentials.mockResolvedValue(null);
    expect(await pk.refreshRows(1, [ROW])).toEqual({ checked: 0, changed: 0 });
    expect(fdoc.workflowStatuses).not.toHaveBeenCalled();
  });
  test('refreshDue раскладывает по салонам; сбой салона не останавливает остальные', async () => {
    store.listDuePackages.mockResolvedValue([{ ...ROW, salon_id: 1 }, { ...ROW, id: '33333333-3333-4333-8333-333333333333', salon_id: 2 }]);
    store.getSettings.mockImplementation(async (sid) => (sid === 2 ? null : SETTINGS));
    const r = await pk.refreshDue();
    expect(r).toEqual({ checked: 0, changed: 0 });
    expect(store.touchStatusCheck).toHaveBeenCalledWith(2, ['33333333-3333-4333-8333-333333333333']);
  });
});

describe('замок комплекта', () => {
  const ROW = { id: '44444444-4444-4444-8444-444444444444', salon_id: 1, client_id: 52, status: 'sent', sent_by: 4, fdoc_package_guid: null };
  const SIGNED = { id: ROW.id, status: 'SIGNED', documents: [{ id: 'd-1', status: 'SIGNED', clientSigners: [{ isSigned: true, dateSignOrCancel: '2026-10-24T10:00:00+03:00' }] }] };

  test('одновременные перечитывания одного комплекта: без параллельных запросов статусов, PDF один раз, одно доп. перечитывание после «грязной» пометки', async () => {
    let status = 'sent';
    const docs = [{ id: 'd-1', file_name: 'Договор.docx', title: 'Договор', pdf_key: null }];
    store.getPackage.mockImplementation(async () => ({ ...ROW, status }));
    store.applyStatus.mockImplementation(async (sid, id, upd) => { status = upd.package.status; return true; });
    store.listDocuments.mockImplementation(async () => docs.map((d) => ({ ...d })));
    store.setDocumentPdf.mockImplementation(async (sid, id, key) => { docs.find((d) => d.id === id).pdf_key = key; });
    fdoc.downloadPdf.mockResolvedValue(Buffer.from('%PDF-1.7'));
    const slow = gate();
    let inFlight = 0;
    let maxInFlight = 0;
    fdoc.workflowStatuses.mockImplementation(async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await slow.promise;
      inFlight--;
      return { packages: [SIGNED], failures: [] };
    });
    const first = pk.refreshRows(1, [ROW]);
    await until(() => fdoc.workflowStatuses.mock.calls.length === 1);
    const second = pk.refreshRows(1, [ROW]);   // вебхук SetStatus
    const third = pk.refreshRows(1, [ROW]);    // ещё один — склеивается со вторым
    await tick(); await tick();
    expect(fdoc.workflowStatuses).toHaveBeenCalledTimes(1);
    slow.open();
    const res = await Promise.all([first, second, third]);
    expect(maxInFlight).toBe(1);
    expect(fdoc.workflowStatuses).toHaveBeenCalledTimes(2);   // одно перечитывание после «грязной» пометки
    expect(fdoc.downloadPdf).toHaveBeenCalledTimes(1);
    expect(store.logEvent.mock.calls.filter(([e]) => e.kind === 'status')).toHaveLength(1);
    expect(store.logEvent.mock.calls.filter(([e]) => e.kind === 'pdf')).toHaveLength(1);
    expect(res).toEqual([{ checked: 1, changed: 1 }, { checked: 1, changed: 0 }, { checked: 1, changed: 0 }]);
  });

  test('вебхук во время отправки ждёт её и перечитывает комплект после markSent', async () => {
    const slow = gate();
    const order = [];
    fdoc.sendPackage.mockImplementation(async () => { await slow.promise; order.push('POST'); return { url: 'https://demo.fdoc.ru/employee/xyz' }; });
    store.markSent.mockImplementation(async () => { order.push('markSent'); return true; });
    fdoc.workflowStatuses.mockImplementation(async () => { order.push('status'); return { packages: [], failures: [] }; });
    const sending = pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] });
    await until(() => fdoc.sendPackage.mock.calls.length === 1);
    const id = store.insertPackage.mock.calls[0][0].id;
    const hook = pk.refreshRows(1, [{ id, salon_id: 1, client_id: 52, status: 'draft', sent_by: 4 }]);
    await tick(); await tick();
    expect(fdoc.workflowStatuses).not.toHaveBeenCalled();
    slow.open();
    await Promise.all([sending, hook]);
    expect(order).toEqual(['POST', 'markSent', 'status', 'status']);   // перечитывание после отправки + одно за вебхук
  });

  test('крон не ждёт занятый комплект: помечает «грязным» и идёт дальше', async () => {
    const slow = gate();
    fdoc.workflowStatuses.mockImplementationOnce(async () => { await slow.promise; return { packages: [], failures: [] }; });
    const hook = pk.refreshRows(1, [ROW]);
    await until(() => fdoc.workflowStatuses.mock.calls.length === 1);
    store.listDuePackages.mockResolvedValue([ROW]);
    expect(await pk.refreshDue()).toEqual({ checked: 0, changed: 0 });
    expect(fdoc.workflowStatuses).toHaveBeenCalledTimes(1);
    slow.open();
    await hook;
    await until(() => fdoc.workflowStatuses.mock.calls.length === 2);   // перечитывание за крон — после вебхука
    await until(() => store.touchStatusCheck.mock.calls.length === 2);  // дождаться его конца: не просочиться в следующий тест
    await tick(); await tick();
  });

  test('повтор отправки, пока по комплекту идёт отправка, — сразу 409 busy без запросов в F.Doc', async () => {
    const DRAFT = { id: '55555555-5555-4555-8555-555555555555', salon_id: 1, client_id: 52, status: 'draft', sent_by: 4, title: 'Документы', record_id: null,
      payload: { docDate: '2026-10-24' }, last_error: 'F.Doc POST /x network: ETIMEDOUT', created_at: new Date() };
    store.getPackage.mockResolvedValue(DRAFT);
    const slow = gate();
    fdoc.workflowStatuses.mockImplementation(async () => { await slow.promise; return { packages: [{ id: DRAFT.id, status: 'WAIT_SIGN', documents: [] }], failures: [] }; });
    const first = pk.resend({ salonId: 1, userId: 4, packageId: DRAFT.id });
    await until(() => fdoc.workflowStatuses.mock.calls.length === 1);
    // Второй повтор отказывает сразу, пока первый ещё ждёт F.Doc (иначе тест повис бы до таймаута).
    const second = await pk.resend({ salonId: 1, userId: 4, packageId: DRAFT.id }).catch((e) => e);
    expect(second).toMatchObject({ code: 'busy', status: 409, message: 'Комплект уже отправляется' });
    expect(fdoc.workflowStatuses).toHaveBeenCalledTimes(1);
    slow.open();
    await expect(first).resolves.toEqual({ packageId: DRAFT.id, recovered: true });
  });
});

describe('действия', () => {
  test('ссылка в окно сотрудника — под учёткой текущего пользователя', async () => {
    fdoc.employeeUrl.mockResolvedValue('https://demo.fdoc.ru/w/1');
    expect(await pk.employeeUrl({ salonId: 1, userId: 4, packageId: 'p' })).toEqual({ url: 'https://demo.fdoc.ru/w/1' });
    expect(store.setEmployeeUrl).toHaveBeenCalledWith(1, 'p', 'https://demo.fdoc.ru/w/1');
  });
  test('аннулировать подписанный нельзя', async () => {
    store.getPackage.mockResolvedValue({ id: 'p', status: 'signed', client_id: 52 });
    await expect(pk.annul({ salonId: 1, userId: 4, packageId: 'p' })).rejects.toMatchObject({ code: 'bad_status', status: 409 });
    expect(fdoc.declinePackage).not.toHaveBeenCalled();
  });
  test('ссылку повторно — только по ожидающему подписи', async () => {
    await pk.permalink({ salonId: 1, userId: 4, packageId: 'p' });
    expect(fdoc.sendPermalink).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'p', ['52']);
  });
  test('preview: без F.Doc и с пропусками', async () => {
    store.getSettings.mockResolvedValue(null);
    store.getIdentityRow.mockResolvedValue(null);
    const r = await pk.preview({ salonId: 1, userId: 4, clientId: 52, templateId: 10, docDate: '2026-10-24' });
    expect(r.fileName).toBe('Договор.docx');
    expect(docText(Buffer.from(r.base64, 'base64'))).toBe('Договор с ________, паспорт ________, исполнитель ________');
  });
  test('check: чего не хватает', async () => {
    store.getIdentityRow.mockResolvedValue(null);
    const r = await pk.check({ salonId: 1, clientId: 52, templateIds: [10] });
    expect(r.missing.identity.map((x) => x.key)).toEqual(['first_name', 'last_name', 'passport_number', 'passport_series', 'phone']);
  });
  test('имена файлов: запрещённые символы и дубли', () => {
    const { safeFileName, uniqueNames } = require('./services/edocs/send-body');
    expect(safeFileName('Договор №1 / копия: "А"')).toBe('Договор №1 копия А.docx');
    expect(safeFileName('')).toBe('Документ.docx');
    expect(uniqueNames(['А.docx', 'а.docx', 'Б.docx'])).toEqual(['А.docx', 'а (2).docx', 'Б.docx']);
  });
});

describe('recognize', () => {
  test('под учёткой пользователя: расшифрованные настройки и пароль, фото уходит как есть', async () => {
    fdoc.recognize.mockResolvedValue({ confidence: true });
    expect(await pk.recognize({ salonId: 1, userId: 4, imageBase64: 'QUJD' })).toEqual({ confidence: true });
    const [cfg, cred, b64, ext] = fdoc.recognize.mock.calls[0];
    expect(cfg).toEqual({ baseUrl: 'https://demo.fdoc.ru', apiKey: 'KEY', appLogin: 'app', appPassword: 'APW', appCode: 'crm', corpId: 'C1' });
    expect(cred).toMatchObject({ userId: 4, login: 'ivanova', password: 'pw' });
    expect([b64, ext]).toEqual(['QUJD', 'jpg']);
  });
  test('F.Doc не принял пароль: это действие пользователя, а не фон — счётчик отказов растёт, ответ 409', async () => {
    fdoc.recognize.mockRejectedValue(Object.assign(new Error('bad'), { name: 'FdocError', code: 'fdoc_credentials_invalid', status: 401 }));
    await expect(pk.recognize({ salonId: 1, userId: 4, imageBase64: 'QUJD' })).rejects.toMatchObject({ name: 'EdocsError', code: 'fdoc_credentials_invalid', status: 409 });
    expect(store.markCredentialsFail).toHaveBeenCalledWith(1, 4, 'bad');
  });
  test('удачное распознавание снимает прежние отказы учётки', async () => {
    store.getCredentials.mockResolvedValue({ user_id: 4, login: 'ivanova', password_enc: 'enc:pw', fail_count: 2 });
    fdoc.recognize.mockResolvedValue(null);
    expect(await pk.recognize({ salonId: 1, userId: 4, imageBase64: 'QUJD' })).toBeNull();   // документ на фото не найден — не ошибка
    expect(store.markCredentialsOk).toHaveBeenCalledWith(1, 4);
  });
  test('модуль выключен, нет учётки, учётка заперта после трёх отказов — 409, F.Doc не зовётся', async () => {
    store.getSettings.mockResolvedValueOnce({ ...SETTINGS, enabled: false });
    await expect(pk.recognize({ salonId: 1, userId: 4, imageBase64: 'QUJD' })).rejects.toMatchObject({ code: 'not_enabled', status: 409 });
    store.getCredentials.mockResolvedValueOnce(null);
    await expect(pk.recognize({ salonId: 1, userId: 4, imageBase64: 'QUJD' })).rejects.toMatchObject({ code: 'fdoc_no_credentials', status: 409 });
    store.getCredentials.mockResolvedValueOnce({ user_id: 4, login: 'ivanova', password_enc: 'enc:pw', fail_count: 3 });
    await expect(pk.recognize({ salonId: 1, userId: 4, imageBase64: 'QUJD' })).rejects.toMatchObject({ code: 'fdoc_credentials_invalid', status: 409 });
    expect(fdoc.recognize).not.toHaveBeenCalled();
  });
});
