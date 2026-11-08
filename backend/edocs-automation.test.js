'use strict';
// Автоматика «Документов» (services/edocs/automation.js). SQL выборок — scripts/edocs-board-smoke.js.
jest.mock('./services/edocs/store', () => ({ getCredentials: jest.fn(), listTemplates: jest.fn(), getIdentityRow: jest.fn() }));
jest.mock('./services/edocs/board-store', () => ({ listDocsForClients: jest.fn(), listLatestForms: jest.fn() }));
jest.mock('./services/edocs/automation-store', () => ({
  listAutomationSalons: jest.fn(), previsitCandidates: jest.fn(), actCandidates: jest.fn(), remindPackages: jest.fn(), remindForms: jest.fn(),
  claim: jest.fn(), finish: jest.fn(),
}));
jest.mock('./services/edocs/packages', () => ({ send: jest.fn(), permalink: jest.fn(), usesAutoContractNo: jest.fn(() => false) }));
jest.mock('./services/edocs/forms', () => ({ createForm: jest.fn(), resendForm: jest.fn(), expireForms: jest.fn() }));
jest.mock('./services/notifications/settings', () => ({ getSettings: jest.fn() }));
jest.mock('./config', () => ({ EDOCS_PUBLIC_URL: 'https://dev.zumrudin.ru', EDOCS_TEST_PHONES: [] }));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));

const store = require('./services/edocs/store');
const boardStore = require('./services/edocs/board-store');
const auto = require('./services/edocs/automation-store');
const packages = require('./services/edocs/packages');
const forms = require('./services/edocs/forms');
const notifSettings = require('./services/notifications/settings');
const config = require('./config');
const automation = require('./services/edocs/automation');

const NOW = Date.parse('2026-10-25T10:00:00+03:00');
const NIGHT = Date.parse('2026-10-25T22:30:00+03:00');
const SALON = { salon_id: 1, enabled: true, corp_id: 'C1', auto_sender_user_id: 4, auto_previsit: true, auto_previsit_hours: 24,
  auto_previsit_scope: 'first', auto_previsit_form: true, auto_act: true, auto_act_delay_min: 15, auto_remind: true, auto_remind_hours: 2,
  acts_required_from: '2026-10-24', requisites: { name: 'ООО «Пери Клиник»' } };
const T = [
  { id: 5, kind: 'contract', title: 'Договор', sort_order: 0, placeholders: ['fio', 'passport'] },
  { id: 6, kind: 'consent_pd', title: 'Согласие', sort_order: 1, placeholders: ['fio'] },
  { id: 7, kind: 'act', title: 'Акт', sort_order: 2, placeholders: ['fio', 'services'] },
];
const FULL = { last_name: 'Иванова', first_name: 'Анна', phone: '79200255591', secure_fields: ['passport_series', 'passport_number'] };
const NO_PASSPORT = { ...FULL, secure_fields: [] };
const CAND = { id: 100, client_id: 52, visit_datetime: '2026-10-26T08:00:00Z', phone: '+79200255591', name: 'Иванова Анна' };

beforeEach(() => {
  jest.clearAllMocks();
  automation._reset();
  config.EDOCS_PUBLIC_URL = 'https://dev.zumrudin.ru';
  config.EDOCS_TEST_PHONES = [];
  notifSettings.getSettings.mockResolvedValue({ quiet_from: '21:00', quiet_to: '09:00' });
  auto.listAutomationSalons.mockResolvedValue([SALON]);
  auto.previsitCandidates.mockResolvedValue([]);
  auto.actCandidates.mockResolvedValue([]);
  auto.remindPackages.mockResolvedValue([]);
  auto.remindForms.mockResolvedValue([]);
  auto.claim.mockResolvedValue(901);
  store.getCredentials.mockResolvedValue({ user_id: 4, fail_count: 0 });
  store.listTemplates.mockResolvedValue(T);
  store.getIdentityRow.mockResolvedValue(FULL);
  boardStore.listDocsForClients.mockResolvedValue([]);
  boardStore.listLatestForms.mockResolvedValue([]);
  packages.send.mockResolvedValue({ packageId: 'pkg-1' });
  forms.createForm.mockResolvedValue({ formId: 'f-1', delivery: { ok: true, channel: 'whatsapp' } });
  forms.expireForms.mockResolvedValue(0);
});

test('тихие часы — салон пропускается целиком, ничего не столбится', async () => {
  auto.previsitCandidates.mockResolvedValue([CAND]);
  expect(await automation.runSalon(SALON, NIGHT)).toEqual({ quiet: true });
  expect(auto.claim).not.toHaveBeenCalled();
});

describe('перед визитом', () => {
  beforeEach(() => { auto.previsitCandidates.mockResolvedValue([CAND]); });

  test('окно и «только первичные» уходят в выборку', async () => {
    await automation.runSalon(SALON, NOW);
    expect(auto.previsitCandidates).toHaveBeenCalledWith(1, new Date(NOW).toISOString(), new Date(NOW + 24 * 3600000).toISOString(), true);
    await automation.runSalon({ ...SALON, auto_previsit_scope: 'all', auto_previsit_hours: 999 }, NOW);
    expect(auto.previsitCandidates).toHaveBeenLastCalledWith(1, expect.any(String), new Date(NOW + 168 * 3600000).toISOString(), false);
  });

  test('данных хватает — один комплект из недостающих видов от имени сотрудника автоматики', async () => {
    boardStore.listDocsForClients.mockResolvedValue([{ kind: 'consent_pd', package_status: 'signed', package_id: 'old', created_at: '2026-01-01' }]);
    expect((await automation.runSalon(SALON, NOW)).previsit).toBe(1);
    expect(auto.claim).toHaveBeenCalledWith(1, 'previsit', 100, { clientId: 52, recordId: 100 });
    expect(packages.send).toHaveBeenCalledWith({ salonId: 1, userId: 4, clientId: 52, templateIds: [5], source: 'auto' });
    expect(auto.finish).toHaveBeenCalledWith(901, 'done', 'отправлено: договор', { packageId: 'pkg-1' });
  });

  test('данных не хватает — анкета в мессенджер, после заполнения уйдут все недостающие', async () => {
    store.getIdentityRow.mockResolvedValue(NO_PASSPORT);
    await automation.runSalon(SALON, NOW);
    expect(forms.createForm).toHaveBeenCalledWith({ salonId: 1, clientId: 52, recordId: 100, kinds: ['contract', 'consent_pd'], sendDocs: true,
      deliver: 'messenger', source: 'auto', senderUserId: 4 });
    expect(auto.finish).toHaveBeenCalledWith(901, 'done', 'анкета отправлена в WhatsApp', { formId: 'f-1' });
    forms.createForm.mockResolvedValueOnce({ formId: 'f-2', delivery: { ok: false, error: 'Ни один мессенджер не принял' } });
    auto.claim.mockResolvedValueOnce(902);
    await automation.runSalon(SALON, NOW);
    expect(auto.finish).toHaveBeenCalledWith(902, 'failed', 'анкета не доставлена: Ни один мессенджер не принял', { formId: 'f-2' });
  });

  test('F.Doc не готов: данных хватает — ждём (не столбим); не хватает — анкета без отправки документов', async () => {
    await automation.runSalon({ ...SALON, auto_sender_user_id: null }, NOW);
    expect(auto.claim).not.toHaveBeenCalled();
    store.getIdentityRow.mockResolvedValue(NO_PASSPORT);
    await automation.runSalon({ ...SALON, auto_sender_user_id: null }, NOW);
    expect(forms.createForm).toHaveBeenCalledWith(expect.objectContaining({ sendDocs: false, senderUserId: null }));
  });

  test('ничего не делаем: всё подписано/ждёт, анкета уже у пациента, тестовый номер, уже застолблено', async () => {
    boardStore.listDocsForClients.mockResolvedValueOnce(['contract', 'consent_pd'].map((k) => ({ kind: k, package_status: 'sent', package_id: 'p', created_at: '2026-10-25' })));
    await automation.runSalon(SALON, NOW);
    boardStore.listLatestForms.mockResolvedValueOnce([{ status: 'active', expires_at: '2026-11-01T00:00:00Z' }]);
    await automation.runSalon(SALON, NOW);
    expect(auto.claim).not.toHaveBeenCalled();
    config.EDOCS_TEST_PHONES = ['79000000000'];
    await automation.runSalon(SALON, NOW);
    expect(auto.claim).not.toHaveBeenCalled();
    config.EDOCS_TEST_PHONES = [];
    auto.claim.mockResolvedValueOnce(null);
    await automation.runSalon(SALON, NOW);
    expect(packages.send).not.toHaveBeenCalled();
  });

  test('настройка салона не готова (реквизиты, адрес ссылок) — не столбим, предупреждаем раз в час', async () => {
    await automation.runSalon({ ...SALON, requisites: {} }, NOW);
    expect(auto.claim).toHaveBeenCalled();   // реквизиты шаблонам этого теста не нужны
    auto.claim.mockClear();
    store.listTemplates.mockResolvedValue([{ ...T[0], placeholders: ['fio', 'org_inn'] }, T[1], T[2]]);
    await automation.runSalon({ ...SALON, requisites: {} }, NOW);
    expect(auto.claim).not.toHaveBeenCalled();
    store.listTemplates.mockResolvedValue(T);
    store.getIdentityRow.mockResolvedValue(NO_PASSPORT);
    config.EDOCS_PUBLIC_URL = '';
    await automation.runSalon(SALON, NOW);
    await automation.runSalon(SALON, NOW);
    expect(auto.claim).not.toHaveBeenCalled();
    expect(mockLog.warn.mock.calls.filter(([t]) => /EDOCS_PUBLIC_URL/.test(t))).toHaveLength(1);
  });

  test('анкета выключена, данных нет — skipped с перечнем; сбой отправки — failed с причиной', async () => {
    store.getIdentityRow.mockResolvedValue(NO_PASSPORT);
    await automation.runSalon({ ...SALON, auto_previsit_form: false }, NOW);
    expect(auto.finish).toHaveBeenCalledWith(901, 'skipped', 'нет данных пациента: номер паспорта, серия паспорта');
    store.getIdentityRow.mockResolvedValue(FULL);
    packages.send.mockRejectedValueOnce(new Error('F.Doc не принял комплект: 400'));
    await automation.runSalon(SALON, NOW);
    expect(auto.finish).toHaveBeenLastCalledWith(901, 'failed', 'F.Doc не принял комплект: 400');
  });
});

describe('акт после оплаты', () => {
  test('F.Doc готов — акт по записи; окно не раньше acts_required_from и не старше 3 дней', async () => {
    auto.actCandidates.mockResolvedValue([{ id: 200, client_id: 52, phone: '79200255591' }]);
    await automation.runSalon(SALON, NOW);
    expect(auto.actCandidates).toHaveBeenCalledWith(1, '2026-10-24', 15);
    expect(packages.send).toHaveBeenCalledWith({ salonId: 1, userId: 4, clientId: 52, templateIds: [7], recordId: 200, source: 'auto' });
    expect(auto.finish).toHaveBeenCalledWith(901, 'done', 'акт отправлен', { packageId: 'pkg-1' });
    await automation.runSalon({ ...SALON, acts_required_from: '2026-01-01', auto_act_delay_min: 1 }, NOW);
    expect(auto.actCandidates).toHaveBeenLastCalledWith(1, '2026-10-22', 5);
  });
  test('F.Doc не готов — автоакт ждёт, кандидаты не читаются', async () => {
    await automation.runSalon({ ...SALON, enabled: false }, NOW);
    expect(auto.actCandidates).not.toHaveBeenCalled();
  });
});

describe('повторы', () => {
  test('ссылка — учёткой отправителя, без неё — учёткой автоматики; анкета — та же ссылка', async () => {
    auto.remindPackages.mockResolvedValue([{ id: 'p-1', client_id: 52, sent_by: 9, payload: { patient: { phone: '79200255591' } } }]);
    packages.permalink.mockRejectedValueOnce(Object.assign(new Error('Подключите'), { code: 'fdoc_no_credentials' }));
    auto.remindForms.mockResolvedValue([{ id: 'f-1', client_id: 52, phone: '79200255591' }]);
    forms.resendForm.mockResolvedValue({ ok: true, channel: 'tdlib' });
    expect((await automation.runSalon(SALON, NOW)).remind).toBe(2);
    expect(packages.permalink.mock.calls.map((c) => c[0].userId)).toEqual([9, 4]);
    expect(auto.remindPackages).toHaveBeenCalledWith(1, 2);
    expect(auto.claim).toHaveBeenCalledWith(1, 'remind', 'p-1', { clientId: 52, packageId: 'p-1' });
    expect(auto.claim).toHaveBeenCalledWith(1, 'remind_form', 'f-1', { clientId: 52, formId: 'f-1' });
    expect(auto.finish).toHaveBeenCalledWith(901, 'done', 'ссылка на подпись отправлена повторно');
    expect(auto.finish).toHaveBeenCalledWith(901, 'done', 'анкета отправлена повторно в Telegram');
  });
});

test('runOnce: анкеты устаревают, сбой салона не останавливает остальных, второй прогон параллельно — пропуск', async () => {
  auto.listAutomationSalons.mockResolvedValue([{ ...SALON, salon_id: 1 }, { ...SALON, salon_id: 2 }]);
  notifSettings.getSettings.mockRejectedValueOnce(new Error('db down')).mockResolvedValue({ quiet_from: '21:00', quiet_to: '09:00' });
  auto.actCandidates.mockResolvedValue([{ id: 200, client_id: 52, phone: '79200255591' }]);
  const p = automation.runOnce({ nowMs: NOW });
  expect(await automation.runOnce({ nowMs: NOW })).toEqual({ skipped: true });
  expect(await p).toMatchObject({ errors: 1, act: 1 });
  expect(forms.expireForms).toHaveBeenCalledTimes(1);
});
