'use strict';
// Анкета пациента (services/edocs/forms.js): создание, ссылка и QR, публичная сторона, приём данных.
jest.mock('./services/edocs/store', () => ({
  getClient: jest.fn(), getSettings: jest.fn(), listTemplates: jest.fn(), logEvent: jest.fn(), getIdentityRow: jest.fn(),
  upsertIdentity: jest.fn(), getCredentials: jest.fn(),
}));
jest.mock('./services/edocs/forms-store', () => ({
  insertForm: jest.fn(), getForm: jest.fn(), getFormByHash: jest.fn(), setDelivered: jest.fn(), markOpened: jest.fn(), incAttempts: jest.fn(),
  takeRecognize: jest.fn(), markSubmitted: jest.fn(), reopen: jest.fn(), setResult: jest.fn(), revoke: jest.fn(), expireDue: jest.fn(),
  nextVisit: jest.fn(), recordVisit: jest.fn(), salonName: jest.fn(),
}));
jest.mock('./services/edocs/board-store', () => ({ listDocsForClients: jest.fn() }));
jest.mock('./services/edocs/packages', () => ({ send: jest.fn(), recognize: jest.fn() }));
jest.mock('./services/edocs/form-delivery', () => ({ deliverText: jest.fn() }));
jest.mock('./utils/secret-box', () => ({
  box: () => ({
    encrypt: (x) => `enc:${x}`, decrypt: (x) => String(x).replace(/^enc:/, ''),
    encryptJson: (o) => `enc:${JSON.stringify(o)}`, decryptJson: (x) => JSON.parse(String(x).replace(/^enc:/, '')),
  }),
}));
jest.mock('./config', () => ({ EDOCS_PUBLIC_URL: 'https://dev.zumrudin.ru', CERT_REQUEST_POLICY_URL: '/privacy-policy.html' }));
jest.mock('sharp', () => () => ({ rotate: () => ({ resize: () => ({ jpeg: () => ({ toBuffer: async () => Buffer.from('JPEG') }) }) }) }));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));

const crypto = require('crypto');
const store = require('./services/edocs/store');
const fstore = require('./services/edocs/forms-store');
const boardStore = require('./services/edocs/board-store');
const packages = require('./services/edocs/packages');
const delivery = require('./services/edocs/form-delivery');
const config = require('./config');
const forms = require('./services/edocs/forms');

const T_CONTRACT = { id: 5, kind: 'contract', title: 'Договор', sort_order: 0, placeholders: ['fio', 'passport', 'address', 'contract_no', 'phone'] };
const T_CONSENT = { id: 6, kind: 'consent_pd', title: 'Согласие', sort_order: 1, placeholders: ['fio', 'birth_date'] };
const T_ACT = { id: 7, kind: 'act', title: 'Акт', sort_order: 2, placeholders: ['fio', 'services'] };
const CLIENT = { id: 52, name: 'Иванова Анна Сергеевна', phone: '+79200255591', yclients_data: {} };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const TOKEN = 'A'.repeat(43);
const FORM = {
  id: 'f-1', salon_id: 1, client_id: 52, record_id: null, token_enc: `enc:${TOKEN}`, status: 'active',
  fields: [{ key: 'last_name', required: true }, { key: 'first_name', required: true }, { key: 'middle_name', required: false },
    { key: 'passport_series', required: true }, { key: 'passport_number', required: true }, { key: 'address', required: true }],
  kinds: ['contract', 'consent_pd'], send_docs: true, sender_user_id: 4, source: 'manual', expires_at: new Date(Date.now() + 86400000).toISOString(),
  recognize_count: 0, created_at: new Date().toISOString(),
};
const SETTINGS = { enabled: true, corp_id: 'C1', form_ttl_days: 7, form_message: null };

beforeEach(() => {
  jest.clearAllMocks();
  config.EDOCS_PUBLIC_URL = 'https://dev.zumrudin.ru';
  store.getClient.mockResolvedValue(CLIENT);
  store.getSettings.mockResolvedValue(SETTINGS);
  store.listTemplates.mockResolvedValue([T_CONTRACT, T_CONSENT, T_ACT]);
  store.getIdentityRow.mockResolvedValue(null);
  store.getCredentials.mockResolvedValue({ user_id: 4, fail_count: 0 });
  fstore.insertForm.mockResolvedValue([]);
  fstore.salonName.mockResolvedValue('PERI CLINIC');
  fstore.nextVisit.mockResolvedValue({ id: 100, visit_datetime: '2026-10-26T08:00:00Z' });
  fstore.getFormByHash.mockResolvedValue(FORM);
  fstore.getForm.mockResolvedValue(FORM);
  fstore.incAttempts.mockResolvedValue(1);
  fstore.markSubmitted.mockResolvedValue(true);
  fstore.markOpened.mockResolvedValue(true);
  boardStore.listDocsForClients.mockResolvedValue([]);
  packages.send.mockResolvedValue({ packageId: 'pkg-1' });
  delivery.deliverText.mockResolvedValue({ channel: 'whatsapp', deliveryId: '9', steps: [] });
});

describe('createForm', () => {
  test('ссылка с токеном, хэш и шифротекст в БД, QR, поля под шаблоны договора и согласия', async () => {
    const r = await forms.createForm({ salonId: 1, userId: 4, clientId: 52 });
    const row = fstore.insertForm.mock.calls[0][0];
    const token = r.url.split('/anketa/')[1];
    expect(r.url).toMatch(/^https:\/\/dev\.zumrudin\.ru\/anketa\/[A-Za-z0-9_-]{43}$/);
    expect(row).toMatchObject({ salon_id: 1, client_id: 52, token_hash: sha(token), token_enc: `enc:${token}`, kinds: ['contract', 'consent_pd'],
      send_docs: true, sender_user_id: 4, source: 'manual', created_by: 4 });
    expect(row.fields.map((f) => f.key)).toEqual(['last_name', 'first_name', 'middle_name', 'birth_date', 'passport_series', 'passport_number', 'address']);
    expect(row.fields.find((f) => f.key === 'middle_name').required).toBe(false);
    expect(Date.parse(row.expires_at) - Date.now()).toBeGreaterThan(6.9 * 86400000);
    expect(r.qr).toMatch(/^data:image\/png;base64,/);
    expect(r.delivery).toBeNull();
    expect(store.logEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'form_created', payload: expect.objectContaining({ formId: r.formId, kinds: ['contract', 'consent_pd'] }) }));
    expect(JSON.stringify(store.logEvent.mock.calls)).not.toContain(token);   // токен в журнал не попадает
  });

  test('в мессенджер: текст с именем, датой визита и ссылкой; итог доставки в ответе и журнале', async () => {
    const r = await forms.createForm({ salonId: 1, userId: 4, clientId: 52, deliver: 'messenger' });
    const { text, phone } = delivery.deliverText.mock.calls[0][0];
    expect(phone).toBe('+79200255591');
    expect(text).toBe(`Здравствуйте, Анна! Перед визитом в PERI CLINIC 26 октября в 11:00 заполните, пожалуйста, данные для договора — это займёт 2 минуты: ${r.url}`);
    expect(r.delivery).toEqual({ ok: true, channel: 'whatsapp' });
    expect(fstore.setDelivered).toHaveBeenCalledWith(r.formId, 'whatsapp');
    delivery.deliverText.mockRejectedValueOnce(Object.assign(new Error('Ни один мессенджер не принял'), { name: 'EdocsError', code: 'form_not_delivered' }));
    const r2 = await forms.createForm({ salonId: 1, userId: 4, clientId: 52, deliver: 'messenger' });
    expect(r2.delivery).toEqual({ ok: false, code: 'form_not_delivered', error: 'Ни один мессенджер не принял' });
    expect(store.logEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'form_send_error' }));
  });

  test('прежняя активная анкета отзывается и пишется в журнал', async () => {
    fstore.insertForm.mockResolvedValueOnce(['f-old']);
    await forms.createForm({ salonId: 1, userId: 4, clientId: 52 });
    expect(store.logEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'form_revoked', payload: { formId: 'f-old', reason: 'replaced' } }));
  });

  test('проверки: пациент, виды, акт без визита, нет шаблонов, нет адреса для ссылок', async () => {
    store.getClient.mockResolvedValueOnce(null);
    await expect(forms.createForm({ salonId: 1, clientId: 52 })).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(forms.createForm({ salonId: 1, clientId: 52, kinds: ['ids'] })).rejects.toMatchObject({ code: 'bad_kinds' });
    await expect(forms.createForm({ salonId: 1, clientId: 52, kinds: ['act'] })).rejects.toMatchObject({ code: 'act_needs_record' });
    store.listTemplates.mockResolvedValueOnce([]);
    await expect(forms.createForm({ salonId: 1, clientId: 52 })).rejects.toMatchObject({ code: 'no_templates', status: 409 });
    config.EDOCS_PUBLIC_URL = '';
    await expect(forms.createForm({ salonId: 1, clientId: 52 })).rejects.toMatchObject({ code: 'no_public_url' });
    const r = await forms.createForm({ salonId: 1, clientId: 52, publicBase: 'https://staff.example/' });
    expect(r.url.startsWith('https://staff.example/anketa/')).toBe(true);
  });
});

describe('ссылка, повтор, отзыв', () => {
  test('formLink и resendForm — тот же токен', async () => {
    const link = await forms.formLink({ salonId: 1, formId: 'f-1' });
    expect(link.url).toBe(`https://dev.zumrudin.ru/anketa/${TOKEN}`);
    await forms.resendForm({ salonId: 1, formId: 'f-1' });
    expect(delivery.deliverText.mock.calls[0][0].text).toContain(`/anketa/${TOKEN}`);
  });
  test('неактивная анкета — 409; отзыв — в журнал', async () => {
    fstore.getForm.mockResolvedValueOnce({ ...FORM, status: 'submitted' });
    await expect(forms.formLink({ salonId: 1, formId: 'f-1' })).rejects.toMatchObject({ code: 'form_inactive' });
    fstore.revoke.mockResolvedValueOnce({ id: 'f-1', client_id: 52 });
    expect(await forms.revokeForm({ salonId: 1, formId: 'f-1', userId: 4 })).toEqual({ ok: true });
    expect(store.logEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'form_revoked', payload: { formId: 'f-1', reason: 'manual' } }));
    fstore.revoke.mockResolvedValueOnce(null);
    await expect(forms.revokeForm({ salonId: 1, formId: 'f-1' })).rejects.toMatchObject({ code: 'form_inactive' });
  });
});

describe('публичная сторона', () => {
  test('кривой токен — not_found без запроса в БД; устаревшая, принятая, отозванная — только статус', async () => {
    expect(await forms.publicView('../etc')).toEqual({ status: 'not_found' });
    expect(fstore.getFormByHash).not.toHaveBeenCalled();
    fstore.getFormByHash.mockResolvedValueOnce({ ...FORM, expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(await forms.publicView(TOKEN)).toEqual({ status: 'expired' });
    fstore.getFormByHash.mockResolvedValueOnce({ ...FORM, status: 'submitted' });
    expect(await forms.publicView(TOKEN)).toEqual({ status: 'submitted' });
  });

  test('активная: клиника, личное имя, визит, поля с подписями; данные пациента не отдаются; первое открытие — в журнал', async () => {
    store.getIdentityRow.mockResolvedValue({ first_name: 'Анна', secure_enc: 'enc:{"passport_series":"4510"}', secure_fields: ['passport_series'] });
    const v = await forms.publicView(TOKEN);
    expect(v).toEqual({
      status: 'active', clinic: 'PERI CLINIC', greetingName: 'Анна',
      visit: { date: '2026-10-26', time: '11:00', label: '26 октября, 11:00', phrase: '26 октября в 11:00' },
      fields: [
        { key: 'last_name', label: 'Фамилия', type: 'text', required: true }, { key: 'first_name', label: 'Имя', type: 'text', required: true },
        { key: 'middle_name', label: 'Отчество (если есть)', type: 'text', required: false },
        { key: 'passport_series', label: 'Серия паспорта', type: 'digits', required: true }, { key: 'passport_number', label: 'Номер паспорта', type: 'digits', required: true },
        { key: 'address', label: 'Адрес регистрации', type: 'text', required: true },
      ],
      canRecognize: true, policyUrl: '/privacy-policy.html',
    });
    expect(JSON.stringify(v)).not.toContain('4510');
    expect(fstore.getFormByHash).toHaveBeenCalledWith(sha(TOKEN));
    expect(store.logEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'form_opened' }));
    store.getSettings.mockResolvedValueOnce({ ...SETTINGS, enabled: false });
    expect((await forms.publicView(TOKEN)).canRecognize).toBe(false);
  });

  const BODY = { last_name: 'Иванова', first_name: 'Анна', middle_name: '', passport_series: '4510', passport_number: '123456', address: 'Москва, ул. Ленина, 1', consent: true };

  test('приём: слияние с прежними данными (паспорт перезаписан, e-mail сохранён), телефон из карточки, source patient_form', async () => {
    store.getIdentityRow.mockResolvedValue({ last_name: 'Иванова', first_name: 'Анна', email: 'anna@example.ru', phone: null,
      secure_enc: 'enc:{"passport_series":"1111","passport_number":"222222","birth_place":"Москва"}', secure_fields: ['passport_series', 'passport_number', 'birth_place'] });
    const r = await forms.publicSubmit(TOKEN, BODY, { ip: '1.2.3.4' });
    expect(r).toMatchObject({ ok: true, docs: 'sending' });
    const [sid, cid, saved] = store.upsertIdentity.mock.calls[0];
    expect([sid, cid, saved.source, saved.userId]).toEqual([1, 52, 'patient_form', null]);
    expect(saved.plain).toMatchObject({ last_name: 'Иванова', first_name: 'Анна', email: 'anna@example.ru', phone: '79200255591' });
    expect(JSON.parse(saved.secure_enc.replace(/^enc:/, ''))).toEqual({ passport_series: '4510', passport_number: '123456', birth_place: 'Москва', address: 'Москва, ул. Ленина, 1' });
    const consent = fstore.markSubmitted.mock.calls[0][1];
    expect(consent).toMatchObject({ accepted: true, version: 'anketa-v1', policyUrl: '/privacy-policy.html' });
    expect(consent.ipHash).toHaveLength(16);
    expect(await r._background).toBe('pkg-1');
    expect(packages.send).toHaveBeenCalledWith({ salonId: 1, userId: 4, clientId: 52, templateIds: [5, 6], recordId: null, source: 'form' });
    expect(fstore.setResult).toHaveBeenCalledWith('f-1', { packageId: 'pkg-1' });
  });

  test('после заполнения уходят только неподписанные документы; ошибка F.Doc — в анкету и журнал', async () => {
    boardStore.listDocsForClients.mockResolvedValue([{ kind: 'contract', package_status: 'signed', package_id: 'old', created_at: '2026-01-01' }]);
    const r = await forms.publicSubmit(TOKEN, BODY);
    await r._background;
    expect(packages.send.mock.calls[0][0].templateIds).toEqual([6]);
    packages.send.mockRejectedValueOnce(Object.assign(new Error('Подключите свою учётную запись F.Doc'), { code: 'fdoc_no_credentials' }));
    const r2 = await forms.publicSubmit(TOKEN, BODY);
    expect(await r2._background).toBeNull();
    expect(fstore.setResult).toHaveBeenCalledWith('f-1', { error: 'Подключите свою учётную запись F.Doc' });
    expect(store.logEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'form_docs_error' }));
  });

  test('отказы: без согласия, пустые обязательные поля, неверная серия, повторная отправка, лимит попыток', async () => {
    await expect(forms.publicSubmit(TOKEN, { ...BODY, consent: 'yes' })).rejects.toMatchObject({ code: 'consent', status: 400 });
    await expect(forms.publicSubmit(TOKEN, { ...BODY, address: ' ', passport_number: '' })).rejects.toMatchObject({
      code: 'missing_fields', message: 'Заполните: номер паспорта, адрес регистрации' });
    await expect(forms.publicSubmit(TOKEN, { ...BODY, passport_series: '45' })).rejects.toMatchObject({ code: 'bad_field', message: 'Серия паспорта: 4 цифры' });
    fstore.markSubmitted.mockResolvedValueOnce(false);
    await expect(forms.publicSubmit(TOKEN, BODY)).rejects.toMatchObject({ code: 'form_submitted', status: 410 });
    fstore.incAttempts.mockResolvedValueOnce(21);
    await expect(forms.publicSubmit(TOKEN, BODY)).rejects.toMatchObject({ code: 'too_many_attempts', status: 429 });
    fstore.getFormByHash.mockResolvedValueOnce({ ...FORM, status: 'revoked' });
    await expect(forms.publicSubmit(TOKEN, BODY)).rejects.toMatchObject({ code: 'form_revoked', status: 410 });
    expect(store.upsertIdentity).not.toHaveBeenCalled();
  });

  test('поле, которого нет в анкете, не принимается; телефон из тела игнорируется', async () => {
    await forms.publicSubmit(TOKEN, { ...BODY, phone: '79001112233', email: 'x@y.ru' });
    const saved = store.upsertIdentity.mock.calls[0][2];
    expect(saved.plain.phone).toBe('79200255591');
    expect(saved.plain.email).toBeNull();
  });

  test('данные не сохранились — анкета снова доступна пациенту', async () => {
    store.upsertIdentity.mockRejectedValueOnce(new Error('db down'));
    await expect(forms.publicSubmit(TOKEN, BODY)).rejects.toThrow('db down');
    expect(fstore.reopen).toHaveBeenCalledWith('f-1');
  });

  test('без отправки документов — docs: none', async () => {
    fstore.getFormByHash.mockResolvedValue({ ...FORM, send_docs: false });
    const r = await forms.publicSubmit(TOKEN, BODY);
    expect(r).toMatchObject({ ok: true, docs: 'none', _background: null });
    expect(packages.send).not.toHaveBeenCalled();
  });

  test('фото паспорта: только поля анкеты, лимит распознаваний, недоступно без F.Doc', async () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(16)]);
    fstore.takeRecognize.mockResolvedValue(true);
    packages.recognize.mockResolvedValue({ confidence: true, fields: {
      surname_nat: { value: 'ИВАНОВА' }, given_name_nat: { value: 'АННА' }, document_series: { value: '4510' }, document_number: { value: '123456' },
      birth_date: { value: '1983-03-21' }, authority_nat: { value: 'ОВД' } } });
    const r = await forms.publicPhoto(TOKEN, { buffer: PNG, originalname: 'p.png' });
    expect(r).toEqual({ recognized: true, confidence: true, fields: { last_name: 'Иванова', first_name: 'Анна', passport_series: '4510', passport_number: '123456' } });
    expect(packages.recognize).toHaveBeenCalledWith({ salonId: 1, userId: 4, imageBase64: Buffer.from('JPEG').toString('base64') });
    fstore.takeRecognize.mockResolvedValueOnce(false);
    await expect(forms.publicPhoto(TOKEN, { buffer: PNG, originalname: 'p.png' })).rejects.toMatchObject({ code: 'recognize_limit', status: 429 });
    store.getSettings.mockResolvedValueOnce({ ...SETTINGS, corp_id: null });
    await expect(forms.publicPhoto(TOKEN, { buffer: PNG, originalname: 'p.png' })).rejects.toMatchObject({ code: 'recognize_unavailable' });
    await expect(forms.publicPhoto(TOKEN, { buffer: Buffer.from('not an image at all'), originalname: 'p.png' })).rejects.toMatchObject({ code: 'bad_image' });
  });
});

test('expireForms: устаревшие → expired с записью в журнал', async () => {
  fstore.expireDue.mockResolvedValueOnce([{ id: 'f-9', salon_id: 1, client_id: 52 }]);
  expect(await forms.expireForms()).toBe(1);
  expect(store.logEvent).toHaveBeenCalledWith({ salonId: 1, clientId: 52, kind: 'form_expired', payload: { formId: 'f-9' } });
});
