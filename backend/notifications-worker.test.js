'use strict';
// Воркер уведомлений (services/notifications/worker.js): аренда, перепроверка перед
// отправкой, режимы off/shadow/live, mark-before-send, каскад мессенджеров, сверка доставки.
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn(), query: jest.fn() } }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
jest.mock('./services/messaging/transport', () => ({
  sendMessage: jest.fn(), sendFile: jest.fn(), getDeliveryStatus: jest.fn(), configured: jest.fn(() => true),
  // Зеркало боевой isDefiniteRejection (её экспорт и семантику проверяет отдельный describe ниже):
  // 4xx — однозначный отказ; ошибка без status и code — наша собственная проверка; таймаут/5xx — нет.
  isDefiniteRejection: (e) => {
    const st = e && Number(e.status);
    if (st >= 400 && st < 500) return true;
    return !!e && !e.status && !e.code;
  },
}));
jest.mock('./services/notifications/settings', () => ({
  getSettings: jest.fn(),
  // чистая сверка номера — боевая: мок с собственной копией правила разъехался бы с settings.js
  isPilotPhone: jest.requireActual('./services/notifications/settings').isPilotPhone,
}));
jest.mock('./services/notifications/rules', () => ({ lastConversation: jest.fn() }));
jest.mock('./services/agent/pending-replies', () => ({ remember: jest.fn() }));
jest.mock('./services/outgoing-authorship', () => ({ remember: jest.fn(async () => {}) }));
jest.mock('./services/chat-persist', () => ({ persistWhatsappOutgoing: jest.fn(async () => {}) }));
// Подменяются ТОЛЬКО файлы вложений (frontend/uploads/…); остальное — настоящая ФС
// (dotenv, config и пр. читают с диска).
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  const isUpload = (p) => String(p).includes('/uploads/');
  return {
    ...actual,
    existsSync: jest.fn((p) => (isUpload(p) ? true : actual.existsSync(p))),
    readFileSync: jest.fn((p, ...rest) => (isUpload(p) ? Buffer.from('img') : actual.readFileSync(p, ...rest))),
  };
});

const fs = require('fs');
const { db } = require('./db');
const transport = require('./services/messaging/transport');
const settings = require('./services/notifications/settings');
const rules = require('./services/notifications/rules');
const pendingReplies = require('./services/agent/pending-replies');
const authorship = require('./services/outgoing-authorship');
const chatPersist = require('./services/chat-persist');
const worker = require('./services/notifications/worker');

const DAY = 24 * 3600 * 1000;
// Визит — в будущем относительно НАСТОЯЩЕГО времени (дата в тесте не должна протухнуть).
const VISIT = new Date(Date.now() + 7 * DAY);
const HOUR = 3600 * 1000;
const ago = (ms) => new Date(Date.now() - ms);
const job = (over = {}) => ({ id: 1, salon_id: 1, rule_id: 1, trigger_type: 'record_created', yclients_record_id: 100,
  visit_datetime: VISIT, scheduled_at: ago(5000), phone: '79200255591', rendered_text: 'Текст',
  attachment_url: null, attempts: 1, meta: {}, cascade_pos: 0, routing: null, ...over });
const state = (over = {}) => ({ visit_datetime: VISIT, attendance: 0, deleted: false, ...over });
const rej = (msg) => Object.assign(new Error(msg), { status: 422 });

const realFs = jest.requireActual('fs');
const isUpload = (p) => String(p).includes('/uploads/');

function setup({ jobs = [], checks = [], st = state(), mode = 'live', captured = 1, order = ['tdlib', 'whatsapp', 'max'],
  preferLast = true, conv = { lastChannel: null, chats: {} }, blacklisted = false, sibling = null, cfgOver = {},
  rule = { is_enabled: true } } = {}) {
  settings.getSettings.mockReset();
  settings.getSettings.mockResolvedValue({ mode, default_channels: order, prefer_last_channel: preferLast, ...cfgOver });
  rules.lastConversation.mockReset();
  rules.lastConversation.mockResolvedValue(conv);
  db.any.mockReset();
  db.any.mockImplementation(async (sql) => (/SET check_at = NULL/.test(sql) ? checks : (/SET attempts = j.attempts/.test(sql) ? jobs : [])));
  db.oneOrNone.mockReset();
  db.oneOrNone.mockImplementation(async (sql) => {
    if (/FROM notification_rules/.test(sql)) return rule;      // строка правила job'а; null — правила нет
    if (/FROM notification_record_state/.test(sql)) return st;
    if (/FROM clients/.test(sql)) return { is_blacklisted: blacklisted };
    if (/FROM notification_jobs/.test(sql)) return sibling;
    return null;
  });
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => ({ rowCount: /SET status='sent', sent_at/.test(sql) ? captured : 1, rows: [] }));
  transport.sendMessage.mockReset();
  transport.sendMessage.mockImplementation(async (salonId, p) => ({ id: 555, channel: p.dispatchRouting[0], accountId: 8 }));
  transport.sendFile.mockReset();
  transport.sendFile.mockImplementation(async (salonId, p) => ({ id: 556, channel: p.dispatchRouting[0], accountId: 8 }));
  transport.getDeliveryStatus.mockReset();
  pendingReplies.remember.mockReset();
  authorship.remember.mockReset();
  authorship.remember.mockImplementation(async () => {});
  chatPersist.persistWhatsappOutgoing.mockReset();
  chatPersist.persistWhatsappOutgoing.mockImplementation(async () => {});
  fs.existsSync.mockReset();
  fs.existsSync.mockImplementation((p) => (isUpload(p) ? true : realFs.existsSync(p)));
  fs.readFileSync.mockReset();
  fs.readFileSync.mockImplementation((p, ...rest) => (isUpload(p) ? Buffer.from('img') : realFs.readFileSync(p, ...rest)));
}
const calls = () => transport.sendMessage.mock.calls.map(([, p]) => p.dispatchRouting[0]);
const updates = (re) => db.query.mock.calls.filter(([sql]) => re.test(sql)).map(([, p]) => p);
const statusUpdates = () => updates(/SET status=\$2/);
const wasCancelled = (reasonRe) => statusUpdates().some((p) => p[1] === 'cancelled' && (!reasonRe || reasonRe.test(p[3])));
beforeEach(() => jest.clearAllMocks());

describe('отправка и каскад', () => {
  test('первый мессенджер каскада принял → один вызов, журнал sent, сверка доставки через 2 мин', async () => {
    setup({ jobs: [job()] });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib']);
    const sent = updates(/SET channel_used=\$2/)[0];
    expect(sent).toEqual(expect.arrayContaining(['tdlib', '555', '8', 0, 120]));
    expect(authorship.remember).toHaveBeenCalledWith(1, '79200255591', 'Текст', 'system');
    expect(pendingReplies.remember).toHaveBeenCalledWith(1, '79200255591', 'Текст');
  });

  test('мессенджер последней переписки идёт первым', async () => {
    setup({ jobs: [job()], conv: { lastChannel: 'max', chats: {} } });
    await worker.processTick();
    expect(calls()).toEqual(['max']);
  });

  test('флаг «сначала последняя переписка» выключен — порядок строго из настроек', async () => {
    setup({ jobs: [job()], preferLast: false, conv: { lastChannel: 'max', chats: {} } });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib']);
  });

  test('номер скрыт в Telegram (422) → следующий мессенджер того же каскада', async () => {
    setup({ jobs: [job()] });
    transport.sendMessage.mockImplementationOnce(async () => { throw rej('Telegram: контакт по номеру не найден'); });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib', 'whatsapp']);
    const log = JSON.parse(updates(/SET channel_used=\$2/)[0].find((v) => typeof v === 'string' && v.startsWith('[')));
    expect(log.map((s) => s.res)).toEqual(['rejected', 'sent']);
  });

  test('нет аккаунта мессенджера у салона (ошибка без status/code) — тоже однозначный отказ → дальше по каскаду', async () => {
    setup({ jobs: [job()] });
    transport.sendMessage.mockImplementationOnce(async () => { throw new Error('нет аккаунта мессенджера у салона 1 для каналов [tdlib]'); });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib', 'whatsapp']);
  });

  test('Telegram с известным id чата адресуется по id, а не по номеру', async () => {
    setup({ jobs: [job()], conv: { lastChannel: null, chats: { tdlib: '385578542' } } });
    await worker.processTick();
    expect(transport.sendMessage.mock.calls[0][1]).toMatchObject({ dispatchRouting: ['tdlib'], tdlib_user_id: '385578542', text: 'Текст' });
  });

  test('в мессенджере писать некому (нет адресата) → шаг пропускается без вызова транспорта', async () => {
    setup({ jobs: [job({ phone: '12345' })], order: ['whatsapp', 'max'] });
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    const p = statusUpdates().find((x) => x[1] === 'pending');
    expect(p[2]).toMatch(/whatsapp=no_recipient, max=no_recipient/);
  });

  test('таймаут (axios code) на шаге → каскад останавливается, failed (могло уйти — дубль хуже)', async () => {
    setup({ jobs: [job()] });
    transport.sendMessage.mockImplementationOnce(async () => { throw Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' }); });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib']);
    const p = statusUpdates().find((x) => x[1] === 'failed');
    expect(p).toBeDefined();
    expect(p[2]).toMatch(/неоднозначн/);
  });

  test('5xx шлюза — тоже неоднозначно: каскад не продолжается', async () => {
    setup({ jobs: [job()] });
    transport.sendMessage.mockImplementationOnce(async () => { throw Object.assign(new Error('Chatpush delivery 502'), { status: 502 }); });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib']);
    expect(statusUpdates().some((p) => p[1] === 'failed')).toBe(true);
  });

  describe('сбой соединения до отправки запроса — однозначный отказ на уровне воркера', () => {
    const connErr = (code) => Object.assign(new Error(`connect ${code} 127.0.0.1:3002`), { code });

    test.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])('%s на шаге → следующий мессенджер: соединения не было, запрос никуда не уходил', async (code) => {
      setup({ jobs: [job()] });
      transport.sendMessage.mockImplementationOnce(async () => { throw connErr(code); });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib', 'whatsapp']);
      const log = JSON.parse(updates(/SET channel_used=\$2/)[0].find((v) => typeof v === 'string' && v.startsWith('[')));
      expect(log.map((s) => s.res)).toEqual(['rejected', 'sent']);
    });

    test('шлюз лежит (ECONNREFUSED на всех шагах) → исчерпанный каскад возвращает строку в pending на повтор, а не в failed', async () => {
      setup({ jobs: [job({ attempts: 1 })] });
      transport.sendMessage.mockImplementation(async () => { throw connErr('ECONNREFUSED'); });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib', 'whatsapp', 'max']);
      expect(statusUpdates().some((p) => p[1] === 'pending')).toBe(true);
      expect(statusUpdates().some((p) => p[1] === 'failed')).toBe(false);
    });

    test('шлюз лежит и попытки кончились → failed (бесконечного повтора нет)', async () => {
      setup({ jobs: [job({ attempts: 3 })] });
      transport.sendMessage.mockImplementation(async () => { throw connErr('ENOTFOUND'); });
      await worker.processTick();
      expect(statusUpdates().some((p) => p[1] === 'failed')).toBe(true);
    });

    test('файл (sendFile): ECONNREFUSED — тоже отказ без отправки, каскад идёт дальше', async () => {
      setup({ jobs: [job({ trigger_type: 'visit_after', attachment_url: '/uploads/notify_1_6_1.jpg' })], st: state({ attendance: 1 }) });
      transport.sendFile.mockImplementationOnce(async () => { throw connErr('ECONNREFUSED'); });
      await worker.processTick();
      expect(transport.sendFile.mock.calls.map(([, p]) => p.dispatchRouting[0])).toEqual(['tdlib', 'whatsapp']);
    });

    // ECONNRESET в набор «соединение не установлено» сознательно НЕ входит: сокет мог оборваться
    // уже после того, как запрос ушёл (и шлюз его принял) — повтор в другой мессенджер дал бы дубль.
    test.each(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE'])('%s — неоднозначен (запрос мог уйти до обрыва): каскад останавливается, failed', async (code) => {
      setup({ jobs: [job()] });
      transport.sendMessage.mockImplementationOnce(async () => { throw connErr(code); });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib']);
      const p = statusUpdates().find((x) => x[1] === 'failed');
      expect(p).toBeDefined();
      expect(p[2]).toMatch(/неоднозначн/);
    });
  });

  test('все мессенджеры отказали, попытки остались → pending для повтора (sent_at от захвата снимается)', async () => {
    setup({ jobs: [job({ attempts: 1 })] });
    transport.sendMessage.mockImplementation(async () => { throw rej('нет'); });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib', 'whatsapp', 'max']);
    const p = statusUpdates().find((x) => x[1] === 'pending');
    expect(p).toBeDefined();
    expect(p[2]).toMatch(/ни один мессенджер не принял/);
    expect(p[6]).toBe(true);   // clearSentAt: отправки не было — метка захвата не должна остаться
  });

  test('все мессенджеры отказали на последней попытке → failed', async () => {
    setup({ jobs: [job({ attempts: 3 })] });
    transport.sendMessage.mockImplementation(async () => { throw rej('нет'); });
    await worker.processTick();
    expect(statusUpdates().some((p) => p[1] === 'failed')).toBe(true);
    expect(statusUpdates().some((p) => p[1] === 'pending')).toBe(false);
  });

  test('продолжение каскада после «Невозможно доставить» идёт с сохранённой позиции', async () => {
    setup({ jobs: [job({ cascade_pos: 1, routing: ['max', 'tdlib', 'whatsapp'] })] });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib']);
    const sent = updates(/SET channel_used=\$2/)[0];
    expect(sent).toEqual(expect.arrayContaining(['tdlib', 1]));
  });

  test('продолжение не пересобирает каскад по настройкам и не зовёт чужой порядок', async () => {
    setup({ jobs: [job({ cascade_pos: 1, routing: ['max', 'whatsapp'] })], conv: { lastChannel: 'tdlib', chats: {} } });
    await worker.processTick();
    expect(calls()).toEqual(['whatsapp']);
  });

  test('каскад пересобран (это не продолжение) → цикл идёт с нуля, даже если в строке остался cascade_pos', async () => {
    setup({ jobs: [job({ cascade_pos: 2, routing: null })] });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib']);
    expect(updates(/SET channel_used=\$2/)[0]).toEqual(expect.arrayContaining(['tdlib', 0]));
  });

  test('routing пуст ([]) при cascade_pos > 0 — тоже не продолжение: с нуля, по настройкам', async () => {
    setup({ jobs: [job({ cascade_pos: 1, routing: [] })], conv: { lastChannel: 'max', chats: {} } });
    await worker.processTick();
    expect(calls()).toEqual(['max']);
    expect(updates(/SET channel_used=\$2/)[0]).toEqual(expect.arrayContaining(['max', 0]));
  });

  test('пустой каскад в настройках → failed с понятной причиной', async () => {
    setup({ jobs: [job()], order: [] });
    await worker.processTick();
    expect(statusUpdates().some((p) => p[1] === 'failed' && /ни один мессенджер/.test(p[2]))).toBe(true);
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  test('вложение → sendFile с подписью в первый мессенджер каскада', async () => {
    setup({ jobs: [job({ trigger_type: 'visit_after', attachment_url: '/uploads/notify_1_6_1.jpg' })], st: state({ attendance: 1 }) });
    await worker.processTick();
    expect(transport.sendFile).toHaveBeenCalledWith(1, expect.objectContaining({ caption: 'Текст', type: 'image', fileName: 'notify_1_6_1.jpg', dispatchRouting: ['tdlib'] }), expect.any(Buffer), 'image/jpeg');
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  test('PDF уходит документом', async () => {
    setup({ jobs: [job({ trigger_type: 'visit_after', attachment_url: '/uploads/notify_1_6_1.pdf' })], st: state({ attendance: 1 }) });
    await worker.processTick();
    expect(transport.sendFile).toHaveBeenCalledWith(1, expect.objectContaining({ type: 'document', fileName: 'notify_1_6_1.pdf' }), expect.any(Buffer), 'application/pdf');
  });

  test('файл вложения пропал с диска → отказ на всех шагах без вызова транспорта, строка не теряется молча', async () => {
    setup({ jobs: [job({ trigger_type: 'visit_after', attachment_url: '/uploads/notify_gone.jpg' })], st: state({ attendance: 1 }) });
    fs.existsSync.mockImplementation(() => false);
    await worker.processTick();
    expect(transport.sendFile).not.toHaveBeenCalled();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    const p = statusUpdates().find((x) => x[1] === 'pending');
    expect(p[2]).toMatch(/tdlib=rejected, whatsapp=rejected, max=rejected/);
  });

  test.each(['EACCES', 'EISDIR', 'EMFILE'])('файл вложения не читается (%s) — локальный отказ, а не «могло уйти»: каскад идёт дальше, failed не ставится', async (code) => {
    setup({ jobs: [job({ trigger_type: 'visit_after', attachment_url: '/uploads/notify_1_6_1.jpg' })], st: state({ attendance: 1 }) });
    fs.readFileSync.mockImplementation(() => { throw Object.assign(new Error(`${code}: cannot read file`), { code }); });
    await worker.processTick();
    expect(transport.sendFile).not.toHaveBeenCalled();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    const p = statusUpdates().find((x) => x[1] === 'pending');
    expect(p[2]).toMatch(/tdlib=rejected, whatsapp=rejected, max=rejected/);
    expect(JSON.parse(p[5])[0].err).toMatch(/не читается/);
    expect(statusUpdates().some((x) => x[1] === 'failed')).toBe(false);
  });
});

describe('режим салона', () => {
  test('shadow: отправки нет, строка shadow с рассчитанным каскадом', async () => {
    setup({ jobs: [job()], mode: 'shadow', conv: { lastChannel: 'whatsapp', chats: {} } });
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(transport.sendFile).not.toHaveBeenCalled();
    const p = statusUpdates().find((x) => x[1] === 'shadow');
    expect(JSON.parse(p[4])).toEqual(['whatsapp', 'tdlib', 'max']);
    expect(updates(/SET status='sent', sent_at/)).toHaveLength(0);   // захвата в тени нет
    expect(authorship.remember).not.toHaveBeenCalled();
  });

  // Пилотные номера: shadow для всех, кроме списка — тем уходит по-настоящему. Так дев проверяет доставку на
  // своём номере, пока реальные пациенты клиники (дев получает те же вебхуки) остаются в журнале тени.
  test('shadow + номер в pilot_phones → боевой путь: захват sent, отправка, авторство (как live)', async () => {
    setup({ jobs: [job({ phone: '79200255591' })], mode: 'shadow', cfgOver: { pilot_phones: ['79200255591'] } });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib']);
    expect(updates(/SET status='sent', sent_at/)).toHaveLength(1);
    expect(statusUpdates().some((x) => x[1] === 'shadow')).toBe(false);
    expect(authorship.remember).toHaveBeenCalledWith(1, '79200255591', 'Текст', 'system');
  });
  test('shadow + номер НЕ в pilot_phones → тень, отправки нет', async () => {
    setup({ jobs: [job({ phone: '79160000001' })], mode: 'shadow', cfgOver: { pilot_phones: ['79200255591'] } });
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(statusUpdates().some((x) => x[1] === 'shadow')).toBe(true);
  });
  test('shadow + пилотный номер в строке записан в другой форме (+7…) → всё равно уходит', async () => {
    setup({ jobs: [job({ phone: '+79200255591' })], mode: 'shadow', cfgOver: { pilot_phones: ['79200255591'] } });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib']);
  });
  test('shadow + пилотный номер: перепроверка перед отправкой НЕ обходится (отменённая запись → cancelled)', async () => {
    setup({ jobs: [job()], mode: 'shadow', st: state({ deleted: true }), cfgOver: { pilot_phones: ['79200255591'] } });
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(wasCancelled()).toBe(true);
  });
  test('off + номер в pilot_phones → ничего: список действует только в shadow', async () => {
    setup({ jobs: [job()], mode: 'off', cfgOver: { pilot_phones: ['79200255591'] } });
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(statusUpdates()).toHaveLength(0);
  });

  test('shadow: перепроверка работает, как в бою (отменённая запись → cancelled, а не shadow)', async () => {
    setup({ jobs: [job()], mode: 'shadow', st: state({ deleted: true }) });
    await worker.processTick();
    expect(wasCancelled(/отменена/)).toBe(true);
    expect(statusUpdates().some((p) => p[1] === 'shadow')).toBe(false);
  });

  test('off: строка остаётся pending без отправки, а попытка аренды откатывается', async () => {
    setup({ jobs: [job({ id: 42, attempts: 2 })], mode: 'off' });
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(statusUpdates()).toHaveLength(0);
    const rb = db.query.mock.calls.filter(([sql]) => /SET attempts = GREATEST\(attempts-1,0\)/.test(sql));
    expect(rb).toHaveLength(1);
    expect(rb[0][0]).toMatch(/WHERE id=\$1 AND status='pending'/);
    expect(rb[0][1]).toEqual([42]);
  });

  test.each(['bogus', '', null, 'LIVE', 'Live '])('неизвестный режим %j → как off (fail-closed): не шлём, попытку откатываем', async (mode) => {
    setup({ jobs: [job({ id: 7 })], mode });
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(transport.sendFile).not.toHaveBeenCalled();
    expect(statusUpdates()).toHaveLength(0);
    expect(updates(/SET status='sent', sent_at/)).toHaveLength(0);
    expect(db.query.mock.calls.filter(([sql]) => /SET attempts = GREATEST\(attempts-1,0\)/.test(sql)).map(([, p]) => p)).toEqual([[7]]);
  });

  test('режим не задан вовсе (поле отсутствует) → как off', async () => {
    setup({ jobs: [job({ id: 7 })], cfgOver: { mode: undefined } });
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(updates(/SET status='sent', sent_at/)).toHaveLength(0);
    expect(db.query.mock.calls.filter(([sql]) => /SET attempts = GREATEST\(attempts-1,0\)/.test(sql)).map(([, p]) => p)).toEqual([[7]]);
  });

  test('live и shadow попытку НЕ откатывают (аренда считается настоящей попыткой)', async () => {
    setup({ jobs: [job()] });
    await worker.processTick();
    setup({ jobs: [job()], mode: 'shadow' });
    await worker.processTick();
    expect(db.query.mock.calls.some(([sql]) => /GREATEST\(attempts-1,0\)/.test(sql))).toBe(false);
  });

  test('сбой отката попытки в off не превращает строку в failed/pending', async () => {
    setup({ jobs: [job({ attempts: 3 })], mode: 'off' });
    db.query.mockImplementation(async () => { throw new Error('db down'); });
    await expect(worker.processTick()).resolves.toBeUndefined();
    expect(statusUpdates()).toHaveLength(0);
  });
});

describe('перепроверка состояния записи перед отправкой', () => {
  test('напоминание: запись перенесена после постановки → cancelled, без отправки', async () => {
    setup({ jobs: [job({ trigger_type: 'visit_reminder' })], st: state({ visit_datetime: new Date(VISIT.getTime() + DAY) }) });
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(wasCancelled(/перенесена/)).toBe(true);
  });

  test('напоминание: время визита то же, запись жива, не подтверждена → уходит', async () => {
    setup({ jobs: [job({ trigger_type: 'visit_reminder' })] });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib']);
  });

  test('напоминание: визит уже подтверждён (attendance 2) → cancelled «визит уже подтверждён»', async () => {
    setup({ jobs: [job({ trigger_type: 'visit_reminder' })], st: state({ attendance: 2 }) });
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(wasCancelled(/^визит уже подтверждён$/)).toBe(true);
  });

  test('подтверждённый визит не гасит другие типы (создана/перенесена уходят)', async () => {
    setup({ jobs: [job({ trigger_type: 'record_created' })], st: state({ attendance: 2 }) });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib']);
  });

  test.each(['record_created', 'record_rescheduled', 'visit_reminder', 'first_visit'])('%s: запись отменена («не придёт») к моменту отправки → cancelled', async (type) => {
    setup({ jobs: [job({ trigger_type: type })], st: state({ attendance: -1 }) });
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(wasCancelled(/^запись отменена к моменту отправки$/)).toBe(true);
  });

  test.each(['record_created', 'visit_reminder'])('%s: запись удалена к моменту отправки → cancelled', async (type) => {
    setup({ jobs: [job({ trigger_type: type })], st: state({ deleted: true }) });
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(wasCancelled(/отменена/)).toBe(true);
  });

  describe('record_cancelled — логика обратная: слать, только пока запись ВСЁ ЕЩЁ отменена', () => {
    test('«клиент не придёт» (attendance −1) → письмо об отмене уходит (не гасит само себя)', async () => {
      setup({ jobs: [job({ trigger_type: 'record_cancelled' })], st: state({ attendance: -1 }) });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib']);
      expect(wasCancelled()).toBe(false);
    });

    test('запись удалена после отметки → письмо всё равно уходит', async () => {
      setup({ jobs: [job({ trigger_type: 'record_cancelled' })], st: state({ attendance: -1, deleted: true }) });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib']);
    });

    test('запись восстановили до отправки → cancelled «запись восстановлена до отправки»', async () => {
      setup({ jobs: [job({ trigger_type: 'record_cancelled' })], st: state({ attendance: 0, deleted: false }) });
      await worker.processTick();
      expect(transport.sendMessage).not.toHaveBeenCalled();
      expect(wasCancelled(/^запись восстановлена до отправки$/)).toBe(true);
    });

    test('восстановили и клиент пришёл (attendance 1) → тоже восстановлена', async () => {
      setup({ jobs: [job({ trigger_type: 'record_cancelled' })], st: state({ attendance: 1 }) });
      await worker.processTick();
      expect(transport.sendMessage).not.toHaveBeenCalled();
      expect(wasCancelled(/восстановлена/)).toBe(true);
    });

    test('состояния записи нет → не мешаем', async () => {
      setup({ jobs: [job({ trigger_type: 'record_cancelled' })], st: null });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib']);
    });

    test('перенос времени визита письмо об отмене не гасит', async () => {
      setup({ jobs: [job({ trigger_type: 'record_cancelled' })], st: state({ attendance: -1, visit_datetime: new Date(VISIT.getTime() + DAY) }) });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib']);
    });
  });

  describe('перенос сверяется только у напоминания', () => {
    const moved = state({ visit_datetime: new Date(VISIT.getTime() + DAY) });
    test.each(['first_visit', 'record_created', 'record_rescheduled'])('%s: время визита в состоянии другое → всё равно уходит', async (type) => {
      setup({ jobs: [job({ trigger_type: type })], st: moved });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib']);
    });
  });

  test.each(['visit_review', 'visit_after'])('%s: «пришёл» снят (attendance 0) → cancelled', async (type) => {
    setup({ jobs: [job({ trigger_type: type })], st: state({ attendance: 0 }) });
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(wasCancelled(/пришёл/)).toBe(true);
  });

  test.each(['visit_review', 'visit_after'])('%s: клиент пришёл (attendance 1) → уходит', async (type) => {
    setup({ jobs: [job({ trigger_type: type })], st: state({ attendance: 1 }) });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib']);
  });

  test('состояния записи нет (создано до выката) → не мешаем', async () => {
    setup({ jobs: [job({ trigger_type: 'visit_reminder' })], st: null });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib']);
  });

  test('клиент в чёрном списке → cancelled', async () => {
    setup({ jobs: [job()], blacklisted: true });
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(wasCancelled(/чёрном списке/)).toBe(true);
  });

  test('чёрный список проверяется и без состояния записи', async () => {
    setup({ jobs: [job()], st: null, blacklisted: true });
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(wasCancelled(/чёрном списке/)).toBe(true);
  });

  test('телефон в запросе ЧС — последние 10 цифр; без телефона запрос не делается (LIKE «%» совпал бы с любым)', async () => {
    setup({ jobs: [job()] });
    await worker.processTick();
    const q = db.oneOrNone.mock.calls.find(([sql]) => /FROM clients/.test(sql));
    expect(q[1]).toEqual([1, '%9200255591']);
    setup({ jobs: [job({ phone: null })] });
    await worker.processTick();
    expect(db.oneOrNone.mock.calls.some(([sql]) => /FROM clients/.test(sql))).toBe(false);
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  test('тестовая отправка (meta.test) пропускает все перепроверки', async () => {
    setup({ jobs: [job({ trigger_type: 'visit_review', yclients_record_id: 0, visit_datetime: null, meta: { test: true } })],
      st: state({ deleted: true, attendance: -1 }), blacklisted: true, sibling: { id: 99 } });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib']);
    expect(db.oneOrNone).not.toHaveBeenCalled();
  });

  describe('«раз на телефон» — страховка в момент отправки', () => {
    test('visit_review: по этому телефону уже есть ДРУГОЙ опрос sent/shadow за 30 дней → cancelled «опрос уже отправлялся»', async () => {
      setup({ jobs: [job({ id: 5, trigger_type: 'visit_review' })], st: state({ attendance: 1 }), sibling: { id: 4 } });
      await worker.processTick();
      expect(transport.sendMessage).not.toHaveBeenCalled();
      expect(wasCancelled(/^опрос уже отправлялся$/)).toBe(true);
      const q = db.oneOrNone.mock.calls.find(([sql]) => /FROM notification_jobs/.test(sql));
      expect(q[0]).toMatch(/status IN \('sent','shadow'\)/);
      expect(q[0]).toMatch(/id <> \$4/);
      expect(q[1]).toEqual([1, '79200255591', 'visit_review', 5, 30]);
    });

    test('visit_review: другого опроса нет → уходит', async () => {
      setup({ jobs: [job({ trigger_type: 'visit_review' })], st: state({ attendance: 1 }), sibling: null });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib']);
    });

    test('first_visit: приглашение этому телефону уже уходило (sent/shadow) → cancelled, окна по давности нет', async () => {
      setup({ jobs: [job({ id: 8, trigger_type: 'first_visit' })], sibling: { id: 3 } });
      await worker.processTick();
      expect(transport.sendMessage).not.toHaveBeenCalled();
      expect(wasCancelled(/^приглашение уже отправлялось$/)).toBe(true);
      const q = db.oneOrNone.mock.calls.find(([sql]) => /FROM notification_jobs/.test(sql));
      expect(q[1]).toEqual([1, '79200255591', 'first_visit', 8, null]);
    });

    test('first_visit: раньше не отправлялось → уходит', async () => {
      setup({ jobs: [job({ trigger_type: 'first_visit' })], sibling: null });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib']);
    });

    test('запрос не учитывает тестовые отправки и саму строку', async () => {
      setup({ jobs: [job({ trigger_type: 'visit_review' })], st: state({ attendance: 1 }) });
      await worker.processTick();
      const q = db.oneOrNone.mock.calls.find(([sql]) => /FROM notification_jobs/.test(sql));
      expect(q[0]).toMatch(/meta->>'test'/);
      expect(q[0]).toMatch(/id <> \$4/);
    });

    test('считается и failed с sent_at: письмо могло дойти (неоднозначный сбой оставляет метку захвата)', async () => {
      setup({ jobs: [job({ trigger_type: 'visit_review' })], st: state({ attendance: 1 }) });
      await worker.processTick();
      const q = db.oneOrNone.mock.calls.find(([sql]) => /FROM notification_jobs/.test(sql));
      expect(q[0]).toMatch(/\(status IN \('sent','shadow'\) OR \(status = 'failed' AND sent_at IS NOT NULL\)\)/);
    });

    test.each(['record_created', 'record_rescheduled', 'record_cancelled', 'visit_reminder', 'visit_after'])('%s: проверки «раз на телефон» нет — таких писем у клиента может быть много', async (type) => {
      setup({ jobs: [job({ trigger_type: type })], st: state({ attendance: type === 'visit_after' ? 1 : (type === 'record_cancelled' ? -1 : 0) }), sibling: { id: 1 } });
      await worker.processTick();
      expect(db.oneOrNone.mock.calls.some(([sql]) => /FROM notification_jobs/.test(sql))).toBe(false);
      expect(calls()).toEqual(['tdlib']);
    });
  });
});

// job — снимок: текст и вложение уже в строке, правило воркер не читает. Без этой проверки отправка
// переживала бы и удаление правила (rule_id → NULL по ON DELETE SET NULL), и его выключение.
describe('правило удалено или выключено после постановки job\'а', () => {
  const ALL_TYPES = ['record_created', 'record_rescheduled', 'record_cancelled', 'visit_reminder', 'visit_review', 'visit_after', 'first_visit'];
  const okState = (type) => state({ attendance: type === 'record_cancelled' ? -1 : (type === 'visit_review' || type === 'visit_after' ? 1 : 0) });
  const ruleQueries = () => db.oneOrNone.mock.calls.filter(([sql]) => /FROM notification_rules/.test(sql));
  const noOtherChecks = () => db.oneOrNone.mock.calls.filter(([sql]) => !/FROM notification_rules/.test(sql));

  test.each(ALL_TYPES)('%s: правило выключено → cancelled «правило выключено», без отправки', async (type) => {
    setup({ jobs: [job({ id: 4, trigger_type: type })], st: okState(type), rule: { is_enabled: false } });
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(updates(/SET status='sent', sent_at/)).toHaveLength(0);          // даже не захватывали
    expect(wasCancelled(/^правило выключено$/)).toBe(true);
    expect(statusUpdates().filter((p) => p[1] === 'cancelled').map((p) => p[0])).toEqual([4]);
  });

  test.each(ALL_TYPES)('%s: rule_id = NULL (правило удалено) → cancelled «правило удалено», в БД за правилом не ходим', async (type) => {
    setup({ jobs: [job({ id: 5, trigger_type: type, rule_id: null })], st: okState(type) });
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(wasCancelled(/^правило удалено$/)).toBe(true);
    expect(ruleQueries()).toHaveLength(0);
  });

  test('rule_id указывает на несуществующее правило (удалили между арендой и проверкой) → «правило удалено»', async () => {
    setup({ jobs: [job({ rule_id: 77 })], rule: null });
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(wasCancelled(/^правило удалено$/)).toBe(true);
  });

  test('правило включено → отправка идёт как обычно', async () => {
    setup({ jobs: [job()], rule: { is_enabled: true } });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib']);
    expect(wasCancelled()).toBe(false);
  });

  test('запрос правила один на job и скоуплен: id правила и salon_id самой строки', async () => {
    setup({ jobs: [job({ rule_id: 7, salon_id: 3 })] });
    await worker.processTick();
    const q = ruleQueries();
    expect(q).toHaveLength(1);
    expect(q[0][0]).toMatch(/WHERE id=\$1 AND salon_id=\$2/);
    expect(q[0][1]).toEqual([7, 3]);
  });

  test('shadow: выключенное правило тоже гасит строку (в журнал тени «shadow» не попадает)', async () => {
    setup({ jobs: [job()], mode: 'shadow', rule: { is_enabled: false } });
    await worker.processTick();
    expect(wasCancelled(/^правило выключено$/)).toBe(true);
    expect(statusUpdates().some((p) => p[1] === 'shadow')).toBe(false);
  });

  test('давность решает раньше и без БД: опоздавшая строка гасится по давности, правило не запрашивается', async () => {
    const { MAX_LATENESS_MS } = worker;
    setup({ jobs: [job({ scheduled_at: ago(MAX_LATENESS_MS + 60 * 1000) })], rule: { is_enabled: false } });
    await worker.processTick();
    expect(wasCancelled(/^устарело: опоздание/)).toBe(true);
    expect(db.oneOrNone).not.toHaveBeenCalled();
  });

  test('проверка правила идёт ДО остальных запросов в БД: выключенное правило не тянет за собой чтение записи/клиента', async () => {
    setup({ jobs: [job({ trigger_type: 'visit_review' })], st: okState('visit_review'), rule: { is_enabled: false } });
    await worker.processTick();
    expect(wasCancelled(/^правило выключено$/)).toBe(true);
    expect(noOtherChecks()).toHaveLength(0);
  });

  describe('тестовая отправка (meta.test) к правилу не привязана', () => {
    const testJob = (over = {}) => job({ trigger_type: 'visit_review', yclients_record_id: 0, visit_datetime: null, meta: { test: true }, ...over });

    test('правило выключено — тест всё равно уходит (выключенное правило как раз и тестируют)', async () => {
      setup({ jobs: [testJob()], rule: { is_enabled: false } });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib']);
      expect(wasCancelled()).toBe(false);
      expect(db.oneOrNone).not.toHaveBeenCalled();
    });

    test('правило удалено (rule_id = NULL) — тест всё равно уходит', async () => {
      setup({ jobs: [testJob({ rule_id: null })], rule: null });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib']);
      expect(wasCancelled()).toBe(false);
    });
  });
});

describe('устаревшее после простоя процесса', () => {
  const { MAX_LATENESS_MS } = worker;
  // Состояние записи, при котором письмо ПО ЗАПИСИ ушло бы: отменить его может только давность.
  const goodState = (type) => state({ attendance: type === 'record_cancelled' ? -1 : (type === 'visit_review' || type === 'visit_after' ? 1 : 0) });
  const OTHER_TYPES = ['record_created', 'record_rescheduled', 'record_cancelled', 'visit_review', 'visit_after', 'first_visit'];

  test('порог — 12 часов, константа экспортируется (границы в тестах выражены через неё)', () => {
    expect(MAX_LATENESS_MS).toBe(12 * HOUR);
  });

  describe('visit_reminder: гасит не давность строки, а наступивший визит', () => {
    test('визит начался минуту назад → cancelled «визит уже начался», без отправки', async () => {
      const visit = ago(60 * 1000);
      setup({ jobs: [job({ trigger_type: 'visit_reminder', visit_datetime: visit, scheduled_at: ago(2 * HOUR) })], st: state({ visit_datetime: visit }) });
      await worker.processTick();
      expect(transport.sendMessage).not.toHaveBeenCalled();
      expect(wasCancelled(/^визит уже начался$/)).toBe(true);
      expect(updates(/SET status='sent', sent_at/)).toHaveLength(0);   // даже не захватывали
    });

    test('визит давно позади (после простоя в несколько суток) → cancelled «визит уже начался»', async () => {
      const visit = ago(3 * 24 * HOUR);
      setup({ jobs: [job({ trigger_type: 'visit_reminder', visit_datetime: visit, scheduled_at: ago(4 * 24 * HOUR) })], st: state({ visit_datetime: visit }) });
      await worker.processTick();
      expect(transport.sendMessage).not.toHaveBeenCalled();
      expect(wasCancelled(/^визит уже начался$/)).toBe(true);
    });

    test('до визита ещё минута → напоминание уходит', async () => {
      const visit = new Date(Date.now() + 60 * 1000);
      setup({ jobs: [job({ trigger_type: 'visit_reminder', visit_datetime: visit, scheduled_at: ago(10 * 1000) })], st: state({ visit_datetime: visit }) });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib']);
    });

    test('строка просрочена на 30 ч, но визит впереди → уходит (правило опоздания к напоминанию не применяется)', async () => {
      const visit = new Date(Date.now() + 3 * HOUR);
      setup({ jobs: [job({ trigger_type: 'visit_reminder', visit_datetime: visit, scheduled_at: ago(30 * HOUR) })], st: state({ visit_datetime: visit }) });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib']);
      expect(wasCancelled()).toBe(false);
    });

    test('у строки нет момента визита → «визит уже начался» не выдумывается', async () => {
      setup({ jobs: [job({ trigger_type: 'visit_reminder', visit_datetime: null })], st: state({ visit_datetime: null }) });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib']);
    });
  });

  describe('остальные типы: опоздание больше 12 ч → «устарело»', () => {
    test.each(OTHER_TYPES)('%s: опоздание 12 ч 5 мин → cancelled «устарело: опоздание 12 ч», без отправки', async (type) => {
      setup({ jobs: [job({ trigger_type: type, scheduled_at: ago(MAX_LATENESS_MS + 5 * 60 * 1000) })], st: goodState(type) });
      await worker.processTick();
      expect(transport.sendMessage).not.toHaveBeenCalled();
      expect(wasCancelled(/^устарело: опоздание 12 ч$/)).toBe(true);
      expect(updates(/SET status='sent', sent_at/)).toHaveLength(0);
    });

    test.each(OTHER_TYPES)('%s: опоздание 11 ч 55 мин (простой короче порога) → уходит', async (type) => {
      setup({ jobs: [job({ trigger_type: type, scheduled_at: ago(MAX_LATENESS_MS - 5 * 60 * 1000) })], st: goodState(type) });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib']);
      expect(wasCancelled()).toBe(false);
    });

    test('число часов в причине — настоящее опоздание (двое суток → «опоздание 50 ч»)', async () => {
      setup({ jobs: [job({ scheduled_at: ago(50 * HOUR + 10 * 60 * 1000) })] });
      await worker.processTick();
      expect(wasCancelled(/^устарело: опоздание 50 ч$/)).toBe(true);
    });

    test('shadow: устаревшая строка тоже cancelled, а не shadow (теневой журнал не врёт про «отправили бы»)', async () => {
      setup({ jobs: [job({ scheduled_at: ago(MAX_LATENESS_MS + 60 * 60 * 1000) })], mode: 'shadow' });
      await worker.processTick();
      expect(wasCancelled(/^устарело: опоздание 13 ч$/)).toBe(true);
      expect(statusUpdates().some((p) => p[1] === 'shadow')).toBe(false);
    });

    test('off: устаревшую строку не трогаем (режим off ничего не решает, попытка возвращается)', async () => {
      setup({ jobs: [job({ id: 3, scheduled_at: ago(3 * 24 * HOUR) })], mode: 'off' });
      await worker.processTick();
      expect(statusUpdates()).toHaveLength(0);
      expect(db.query.mock.calls.filter(([sql]) => /GREATEST\(attempts-1,0\)/.test(sql)).map(([, p]) => p)).toEqual([[3]]);
    });

    test('строка без scheduled_at устаревшей не считается (нечем мерить — не гасим)', async () => {
      setup({ jobs: [job({ scheduled_at: null })] });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib']);
    });

    test('продолжение каскада свежей строки уходит', async () => {
      setup({ jobs: [job({ cascade_pos: 1, routing: ['max', 'tdlib'], scheduled_at: ago(10 * 60 * 1000) })] });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib']);
    });

    // Сверка доставки scheduled_at НЕ сбрасывает: иначе продолжение обходило бы эту защиту.
    test('продолжение каскада НЕ обходит защиту: исходный scheduled_at старше порога → «устарело»', async () => {
      setup({ jobs: [job({ cascade_pos: 1, routing: ['max', 'tdlib'], scheduled_at: ago(MAX_LATENESS_MS + 5 * 60 * 1000) })] });
      await worker.processTick();
      expect(transport.sendMessage).not.toHaveBeenCalled();
      expect(wasCancelled(/^устарело: опоздание 12 ч$/)).toBe(true);
    });
  });

  // Тест — действие администратора «прямо сейчас»: правил давности визита/записи он не знает, но СВОЙ возраст
  // проверяется. Воркер не арендует строки салона в off, и без этой страховки тест, поставленный в off (или
  // провисевший простой процесса), ушёл бы при включении боевого режима сколько угодно позже.
  describe('тестовая отправка (meta.test) — исключение из обоих правил, кроме собственного возраста', () => {
    const { TEST_MAX_AGE_MS } = worker;
    const testJob = (over = {}) => job({ trigger_type: 'visit_review', yclients_record_id: 0, visit_datetime: null, meta: { test: true }, ...over });
    const STALE_RE = /^тестовая отправка устарела$/;

    test('порог — 30 минут, константа экспортируется (границы в тестах выражены через неё)', () => {
      expect(TEST_MAX_AGE_MS).toBe(30 * 60 * 1000);
    });

    test('напоминание с визитом в прошлом → уходит', async () => {
      setup({ jobs: [job({ trigger_type: 'visit_reminder', yclients_record_id: 0, visit_datetime: ago(2 * HOUR), meta: { test: true } })] });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib']);
      expect(wasCancelled()).toBe(false);
    });

    test('моложе порога уходит, даже когда запись отменена, клиент в чёрном списке и опрос «уже отправлялся»', async () => {
      setup({ jobs: [testJob({ scheduled_at: ago(TEST_MAX_AGE_MS - 60 * 1000) })],
        st: state({ deleted: true, attendance: -1 }), blacklisted: true, sibling: { id: 99 } });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib']);
      expect(wasCancelled()).toBe(false);
      expect(db.oneOrNone).not.toHaveBeenCalled();     // остальные перепроверки по-прежнему не гоняются
    });

    test.each([
      ['31 минута', TEST_MAX_AGE_MS + 60 * 1000],
      ['3 часа', 3 * HOUR],
      ['трое суток (раньше уходило: правило 12 ч тест не касалось)', 3 * 24 * HOUR],
    ])('старше порога (%s) → cancelled «тестовая отправка устарела»: не отправляется, остальные проверки не гоняются', async (_label, age) => {
      setup({ jobs: [testJob({ id: 7, scheduled_at: ago(age) })] });
      await worker.processTick();
      expect(transport.sendMessage).not.toHaveBeenCalled();
      expect(updates(/SET status='sent', sent_at/)).toHaveLength(0);     // даже не захватывали
      expect(wasCancelled(STALE_RE)).toBe(true);
      expect(statusUpdates().filter((p) => p[1] === 'cancelled').map((p) => p[0])).toEqual([7]);
      expect(db.oneOrNone).not.toHaveBeenCalled();
    });

    test.each(['record_created', 'record_rescheduled', 'record_cancelled', 'visit_reminder', 'visit_review', 'visit_after', 'first_visit'])(
      '%s: порог один для всех типов (29 минут уходит, 31 — гасится)', async (type) => {
        const mk = (age) => job({ trigger_type: type, yclients_record_id: 0, visit_datetime: null, meta: { test: true }, scheduled_at: ago(age) });
        setup({ jobs: [mk(29 * 60 * 1000)] });
        await worker.processTick();
        expect(calls()).toEqual(['tdlib']);
        expect(wasCancelled()).toBe(false);

        setup({ jobs: [mk(31 * 60 * 1000)] });
        await worker.processTick();
        expect(transport.sendMessage).not.toHaveBeenCalled();
        expect(wasCancelled(STALE_RE)).toBe(true);
      });

    describe('граница (staleReason напрямую, время подменено)', () => {
      const T0 = Date.parse('2026-10-14T12:00:00+03:00');
      let nowSpy;
      beforeEach(() => { nowSpy = jest.spyOn(Date, 'now').mockReturnValue(T0); });
      afterEach(() => nowSpy.mockRestore());

      test('ровно TEST_MAX_AGE_MS — ещё свежа (строгое «больше»), на миллисекунду старше — устарела', async () => {
        expect(await worker.staleReason(testJob({ scheduled_at: new Date(T0 - TEST_MAX_AGE_MS) }))).toBeNull();
        expect(await worker.staleReason(testJob({ scheduled_at: new Date(T0 - TEST_MAX_AGE_MS - 1) }))).toBe('тестовая отправка устарела');
      });

      test('нет scheduled_at / не разобралось — возраст не выдумываем (как у остальных типов)', async () => {
        expect(await worker.staleReason(testJob({ scheduled_at: null }))).toBeNull();
        expect(await worker.staleReason(testJob({ scheduled_at: 'не дата' }))).toBeNull();
      });

      test('строка из БД приходит Date/ISO-строкой — обе формы читаются', async () => {
        const old = T0 - TEST_MAX_AGE_MS - 1000;
        expect(await worker.staleReason(testJob({ scheduled_at: new Date(old).toISOString() }))).toBe('тестовая отправка устарела');
        expect(await worker.staleReason(testJob({ scheduled_at: new Date(old) }))).toBe('тестовая отправка устарела');
      });

      test('обычная (не тестовая) строка порогом в 30 минут не затронута: 3 часа опоздания у record_created ещё не «устарело»', async () => {
        setup({});      // штатные ответы БД: правило включено, состояния записи нет, клиент не в чёрном списке
        const r = await worker.staleReason(job({ trigger_type: 'record_created', scheduled_at: new Date(T0 - 3 * HOUR) }));
        expect(r).toBeNull();
      });
    });
  });
});

describe('тихие часы в момент отправки (отложенные типы)', () => {
  // Подменяется только Date: промисы и таймеры работают как обычно.
  const ALL_BUT_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
    'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];
  const at = (iso) => jest.useFakeTimers({ now: Date.parse(iso), doNotFake: ALL_BUT_DATE });   // вызывать ДО job(): ago() читает Date.now()
  afterEach(() => jest.useRealTimers());
  const QUIET = { quiet_from: '21:00', quiet_to: '09:00' };
  const NIGHT = '2026-10-14T23:30:00+03:00';
  const MORNING_MS = Date.parse('2026-10-15T09:00:00+03:00');
  const DEFERRED = ['visit_reminder', 'visit_review', 'visit_after', 'first_visit'];
  const IMMEDIATE = ['record_created', 'record_rescheduled', 'record_cancelled'];
  const okState = (type) => state({ attendance: type === 'record_cancelled' ? -1 : (type === 'visit_review' || type === 'visit_after' ? 1 : 0) });
  const deferUpdates = () => updates(/SET scheduled_at=\$2/);

  test.each(DEFERRED)('%s ночью → не отправляется: scheduled_at сдвигается на конец тихих часов, попытка откатывается, статус остаётся pending', async (type) => {
    at(NIGHT);
    setup({ jobs: [job({ id: 9, trigger_type: type, attempts: 2 })], st: okState(type), cfgOver: QUIET });
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(updates(/SET status='sent', sent_at/)).toHaveLength(0);   // даже не захватывали
    expect(statusUpdates()).toHaveLength(0);                          // ни cancelled, ни failed, ни pending
    const d = deferUpdates();
    expect(d).toHaveLength(1);
    expect(d[0][0]).toBe(9);
    expect(new Date(d[0][1]).getTime()).toBe(MORNING_MS);
    expect(d[0][2]).toMatch(/^тихие часы: отправка перенесена на 15\.10 09:00$/);
    const [sql] = db.query.mock.calls.find(([q]) => /SET scheduled_at=\$2/.test(q));
    expect(sql).toMatch(/attempts = GREATEST\(attempts-1,0\)/);
    expect(sql).toMatch(/WHERE id=\$1 AND status='pending'/);
  });

  test.each(DEFERRED)('%s днём → уходит как обычно', async (type) => {
    at('2026-10-14T12:00:00+03:00');
    setup({ jobs: [job({ trigger_type: type })], st: okState(type), cfgOver: QUIET });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib']);
    expect(deferUpdates()).toHaveLength(0);
  });

  test.each(IMMEDIATE)('%s ночью → уходит сразу (мгновенные типы тихие часы не сдвигают)', async (type) => {
    at(NIGHT);
    setup({ jobs: [job({ trigger_type: type })], st: okState(type), cfgOver: QUIET });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib']);
    expect(deferUpdates()).toHaveLength(0);
  });

  test('окно через полночь: в 03:00 отправка переносится на 09:00 того же дня', async () => {
    at('2026-10-15T03:00:00+03:00');
    setup({ jobs: [job({ trigger_type: 'visit_review' })], st: okState('visit_review'), cfgOver: QUIET });
    await worker.processTick();
    expect(new Date(deferUpdates()[0][1]).getTime()).toBe(MORNING_MS);
  });

  test('границы окна: 21:00 — уже тихие часы, 09:00 — уже нет', async () => {
    at('2026-10-14T21:00:00+03:00');
    setup({ jobs: [job({ trigger_type: 'visit_review' })], st: okState('visit_review'), cfgOver: QUIET });
    await worker.processTick();
    expect(deferUpdates()).toHaveLength(1);
    jest.useRealTimers();
    at('2026-10-15T09:00:00+03:00');
    setup({ jobs: [job({ trigger_type: 'visit_review' })], st: okState('visit_review'), cfgOver: QUIET });
    await worker.processTick();
    expect(deferUpdates()).toHaveLength(0);
    expect(calls()).toEqual(['tdlib']);
  });

  describe('visit_reminder: если тихие часы кончаются не раньше визита, напоминание бессмысленно', () => {
    test('визит в 08:00, тихие часы до 09:00 → cancelled «тихие часы до начала визита»', async () => {
      at(NIGHT);
      const visit = new Date('2026-10-15T08:00:00+03:00');
      setup({ jobs: [job({ trigger_type: 'visit_reminder', visit_datetime: visit })], st: state({ visit_datetime: visit }), cfgOver: QUIET });
      await worker.processTick();
      expect(transport.sendMessage).not.toHaveBeenCalled();
      expect(wasCancelled(/^тихие часы до начала визита$/)).toBe(true);
      expect(deferUpdates()).toHaveLength(0);
    });

    test('визит ровно в 09:00 (>= конца тихих часов) → тоже cancelled', async () => {
      at(NIGHT);
      const visit = new Date('2026-10-15T09:00:00+03:00');
      setup({ jobs: [job({ trigger_type: 'visit_reminder', visit_datetime: visit })], st: state({ visit_datetime: visit }), cfgOver: QUIET });
      await worker.processTick();
      expect(wasCancelled(/^тихие часы до начала визита$/)).toBe(true);
    });

    test('визит в 09:01 → напоминание переносится на 09:00', async () => {
      at(NIGHT);
      const visit = new Date('2026-10-15T09:01:00+03:00');
      setup({ jobs: [job({ trigger_type: 'visit_reminder', visit_datetime: visit })], st: state({ visit_datetime: visit }), cfgOver: QUIET });
      await worker.processTick();
      expect(new Date(deferUpdates()[0][1]).getTime()).toBe(MORNING_MS);
      expect(wasCancelled()).toBe(false);
    });
  });

  test('сначала перепроверка: отменённая ночью запись отменяется, а не откладывается до утра', async () => {
    at(NIGHT);
    setup({ jobs: [job({ trigger_type: 'visit_reminder' })], st: state({ deleted: true }), cfgOver: QUIET });
    await worker.processTick();
    expect(wasCancelled(/^запись отменена к моменту отправки$/)).toBe(true);
    expect(deferUpdates()).toHaveLength(0);
  });

  test('тестовая отправка (meta.test) тихие часы не сдвигают: админ ждёт её «в течение 10 с»', async () => {
    at(NIGHT);
    setup({ jobs: [job({ trigger_type: 'visit_review', yclients_record_id: 0, visit_datetime: null, meta: { test: true } })], cfgOver: QUIET });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib']);
    expect(deferUpdates()).toHaveLength(0);
  });

  test('shadow: ночью строка тоже переносится (журнал тени повторяет боевое поведение), shadow-строки нет', async () => {
    at(NIGHT);
    setup({ jobs: [job({ trigger_type: 'visit_review' })], st: okState('visit_review'), mode: 'shadow', cfgOver: QUIET });
    await worker.processTick();
    expect(deferUpdates()).toHaveLength(1);
    expect(statusUpdates().some((p) => p[1] === 'shadow')).toBe(false);
  });

  test('off: тихие часы ни при чём (режим off просто возвращает попытку)', async () => {
    at(NIGHT);
    setup({ jobs: [job({ trigger_type: 'visit_review' })], mode: 'off', cfgOver: QUIET });
    await worker.processTick();
    expect(deferUpdates()).toHaveLength(0);
  });

  test('тихие часы не заданы или заданы одинаковые границы → ничего не сдвигается', async () => {
    at(NIGHT);
    setup({ jobs: [job({ trigger_type: 'visit_review' })], st: okState('visit_review') });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib']);
    setup({ jobs: [job({ trigger_type: 'visit_review' })], st: okState('visit_review'), cfgOver: { quiet_from: '21:00', quiet_to: '21:00' } });
    await worker.processTick();
    expect(calls()).toEqual(['tdlib']);
    expect(deferUpdates()).toHaveLength(0);
  });

  test('сбой записи переноса не отправляет сообщение и возвращает строку на повтор', async () => {
    at(NIGHT);
    setup({ jobs: [job({ trigger_type: 'visit_review', attempts: 1 })], st: okState('visit_review'), cfgOver: QUIET });
    db.query.mockImplementation(async (sql) => {
      if (/SET scheduled_at=\$2/.test(sql)) throw new Error('db blip');
      return { rowCount: 1, rows: [] };
    });
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(statusUpdates().some((p) => p[1] === 'pending')).toBe(true);
  });
});

describe('mark-before-send', () => {
  test('захват не удался (строку уже отменили) → отправки нет', async () => {
    setup({ jobs: [job()], captured: 0 });
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(authorship.remember).not.toHaveBeenCalled();
  });

  test('захват идёт ДО вызова транспорта и сбрасывает check_at и error', async () => {
    setup({ jobs: [job()] });
    await worker.processTick();
    const capIdx = db.query.mock.calls.findIndex(([sql]) => /SET status='sent', sent_at/.test(sql));
    expect(capIdx).toBeGreaterThanOrEqual(0);
    const [capSql, capParams] = db.query.mock.calls[capIdx];
    expect(capSql).toMatch(/check_at=NULL/);
    expect(capSql).toMatch(/error=NULL/);
    expect(capSql).toMatch(/WHERE id=\$1 AND status='pending'/);
    expect(JSON.parse(capParams[1])).toEqual(['tdlib', 'whatsapp', 'max']);
    expect(db.query.mock.invocationCallOrder[capIdx]).toBeLessThan(transport.sendMessage.mock.invocationCallOrder[0]);
  });

  test('переходы статуса не затирают отмену, сделанную параллельно (только из pending/sent)', async () => {
    setup({ jobs: [job()], mode: 'shadow' });
    await worker.processTick();
    const [sql] = db.query.mock.calls.find(([s]) => /SET status=\$2/.test(s));
    expect(sql).toMatch(/WHERE id=\$1 AND status IN \('pending','sent'\)/);
  });
});

describe('после реальной отправки код дальше не бросает (иначе строка вернулась бы в pending и ушла дважды)', () => {
  const noRevert = () => {
    expect(calls()).toEqual(['tdlib']);                                    // отправка ровно одна
    expect(statusUpdates()).toHaveLength(0);                               // ни pending, ни failed
  };

  test('authorship.remember отклоняет промис', async () => {
    setup({ jobs: [job()] });
    authorship.remember.mockImplementation(async () => { throw new Error('db down'); });
    await worker.processTick();
    noRevert();
  });

  test('authorship.remember бросает синхронно', async () => {
    setup({ jobs: [job()] });
    authorship.remember.mockImplementation(() => { throw new Error('boom'); });
    await worker.processTick();
    noRevert();
  });

  test('pendingReplies.remember бросает', async () => {
    setup({ jobs: [job()] });
    pendingReplies.remember.mockImplementation(() => { throw new Error('boom'); });
    await worker.processTick();
    noRevert();
    expect(authorship.remember).toHaveBeenCalled();   // и следующий шаг не потерян
  });

  test('журнал отправки (UPDATE) падает', async () => {
    setup({ jobs: [job()] });
    db.query.mockImplementation(async (sql) => {
      if (/SET channel_used=\$2/.test(sql)) throw new Error('db blip');
      return { rowCount: 1, rows: [] };
    });
    await worker.processTick();
    noRevert();
    expect(authorship.remember).toHaveBeenCalled();
  });

  test('WhatsApp: в «Чат» пишется как system, с delivery; сбой записи не откатывает отправку', async () => {
    setup({ jobs: [job()], order: ['whatsapp'] });
    chatPersist.persistWhatsappOutgoing.mockImplementation(async () => { throw new Error('db down'); });
    await worker.processTick();
    expect(transport.sendMessage.mock.calls.map(([, p]) => p.dispatchRouting[0])).toEqual(['whatsapp']);
    expect(statusUpdates()).toHaveLength(0);
    expect(chatPersist.persistWhatsappOutgoing).toHaveBeenCalledWith(1, expect.objectContaining({
      delivery: expect.objectContaining({ id: 555, channel: 'whatsapp' }), phone: '79200255591', chatId: null,
      text: 'Текст', msgType: 'text', authoredBy: 'system',
    }));
  });

  test('WhatsApp с вложением: тип и файл попадают в «Чат»', async () => {
    setup({ jobs: [job({ trigger_type: 'visit_after', attachment_url: '/uploads/notify_1_6_1.jpg' })], st: state({ attendance: 1 }), order: ['whatsapp'] });
    await worker.processTick();
    expect(chatPersist.persistWhatsappOutgoing).toHaveBeenCalledWith(1, expect.objectContaining({
      msgType: 'image', fileUrl: '/uploads/notify_1_6_1.jpg', mimeType: 'image/jpeg', authoredBy: 'system',
    }));
  });

  test('Telegram/MAX в «Чат» руками не пишутся (их эхо приходит само)', async () => {
    setup({ jobs: [job()] });
    await worker.processTick();
    expect(chatPersist.persistWhatsappOutgoing).not.toHaveBeenCalled();
    setup({ jobs: [job()], order: ['max'] });
    await worker.processTick();
    expect(chatPersist.persistWhatsappOutgoing).not.toHaveBeenCalled();
  });

  test('у отправки нет delivery id → сверку доставки не планируем (проверять нечего)', async () => {
    setup({ jobs: [job()] });
    transport.sendMessage.mockImplementation(async (s, p) => ({ channel: p.dispatchRouting[0], accountId: 8 }));
    await worker.processTick();
    const p = updates(/SET channel_used=\$2/)[0];
    expect(p[2]).toBeNull();          // delivery_id
    expect(p[5]).toBeNull();          // секунды до сверки
    const [sql] = db.query.mock.calls.find(([s]) => /SET channel_used=\$2/.test(s));
    expect(sql).toMatch(/CASE WHEN \$6::double precision IS NULL THEN NULL/);
  });
});

describe('сбои до отправки', () => {
  test('настройки не прочитались → pending для повтора (попытки остались), строка не теряется', async () => {
    setup({ jobs: [job({ attempts: 1 })] });
    settings.getSettings.mockRejectedValue(new Error('db down'));
    await worker.processTick();
    expect(transport.sendMessage).not.toHaveBeenCalled();
    const p = statusUpdates()[0];
    expect(p[1]).toBe('pending');
    expect(p[2]).toMatch(/db down/);
  });

  test('сбой на последней попытке → failed', async () => {
    setup({ jobs: [job({ attempts: 3 })] });
    settings.getSettings.mockRejectedValue(new Error('db down'));
    await worker.processTick();
    expect(statusUpdates()[0][1]).toBe('failed');
  });

  test('сбой одной строки не мешает остальным строкам тика', async () => {
    setup({ jobs: [job({ id: 1 }), job({ id: 2, phone: '79990001122' })] });
    let n = 0;
    settings.getSettings.mockImplementation(async () => {
      if (n++ === 0) throw new Error('blip');
      return { mode: 'live', default_channels: ['tdlib'], prefer_last_channel: true };
    });
    await worker.processTick();
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
    expect(transport.sendMessage.mock.calls[0][1].phone).toBe('79990001122');
  });

  test('лимит попыток: аренда берёт пачку по 10, бэкофф 60 с', async () => {
    setup({ jobs: [] });
    await worker.processTick();
    const lease = db.any.mock.calls.find(([sql]) => /SET attempts = j.attempts/.test(sql));
    expect(lease[1]).toEqual([60, 10]);
  });
});

describe('сверка доставки', () => {
  const { CHECK_MAX_AGE_MS } = worker;
  const MIN = 60 * 1000;
  // sent_at по умолчанию — «две минуты назад», как при обычной сверке через CHECK_DELAY_S.
  const chk = (over = {}) => ({ id: 7, salon_id: 1, channel_used: 'tdlib', delivery_id: 'g12', account_id: '8', cascade_pos: 0, routing: ['tdlib', 'whatsapp'], sent_at: ago(2 * MIN), ...over });
  const flips = () => updates(/SET status=\$2, cascade_pos=\$3/);
  const stepLogs = () => updates(/SET cascade_log = cascade_log \|\| \$2::jsonb\s+WHERE id=\$1 AND status='sent'/);
  const FAILED5 = { id: 'g12', status: { status_id: 5, description: 'Невозможно доставить' } };

  test('порог «поздней» сверки — 8 минут (шлюз закрывает зависшие «Принято» через 10), константа экспортируется', () => {
    expect(CHECK_MAX_AGE_MS).toBe(8 * MIN);
  });

  test('продолжение НЕ сбрасывает scheduled_at (иначе обходит защиту «опоздание > 12 ч»), но делает строку сразу доступной для аренды', async () => {
    setup({ checks: [chk()] });
    transport.getDeliveryStatus.mockResolvedValue(FAILED5);
    await worker.processTick();
    const [sql] = db.query.mock.calls.find(([s]) => /SET status=\$2, cascade_pos=\$3/.test(s));
    expect(sql).not.toMatch(/scheduled_at/);
    expect(sql).toMatch(/attempts=0, last_attempt_at=NULL/);
  });

  test('поздняя сверка (с отправки больше 8 мин): каскад НЕ продолжается, строка остаётся sent, в журнале шаг undeliverable_unknown', async () => {
    setup({ checks: [chk({ sent_at: ago(CHECK_MAX_AGE_MS + 2 * MIN) })] });
    transport.getDeliveryStatus.mockResolvedValue(FAILED5);
    await worker.processTick();
    expect(flips()).toHaveLength(0);
    const l = stepLogs();
    expect(l).toHaveLength(1);
    expect(l[0][0]).toBe(7);
    const steps = JSON.parse(l[0][1]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ ch: 'tdlib', res: 'undeliverable_unknown' });
    expect(steps[0].err).toMatch(/10 мин/);
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  test('граница: 7 мин 30 с после отправки — ещё продолжаем, 8 мин 30 с — уже нет', async () => {
    setup({ checks: [chk({ sent_at: ago(CHECK_MAX_AGE_MS - 30 * 1000) })] });
    transport.getDeliveryStatus.mockResolvedValue(FAILED5);
    await worker.processTick();
    expect(flips()[0].slice(0, 3)).toEqual([7, 'pending', 1]);
    setup({ checks: [chk({ sent_at: ago(CHECK_MAX_AGE_MS + 30 * 1000) })] });
    transport.getDeliveryStatus.mockResolvedValue(FAILED5);
    await worker.processTick();
    expect(flips()).toHaveLength(0);
  });

  test('шлюз: «исход неизвестен» в error (failStale при старте закрыл доставку) → не продолжаем, шаг undeliverable_unknown', async () => {
    setup({ checks: [chk()] });
    transport.getDeliveryStatus.mockResolvedValue({ ...FAILED5, error: 'шлюз перезапущен, исход неизвестен' });
    await worker.processTick();
    expect(flips()).toHaveLength(0);
    const steps = JSON.parse(stepLogs()[0][1]);
    expect(steps[0]).toMatchObject({ ch: 'tdlib', res: 'undeliverable_unknown' });
    expect(steps[0].err).toMatch(/исход неизвестен/);
  });

  test('«исход неизвестен» в описании статуса — тоже не продолжаем (регистр не важен)', async () => {
    setup({ checks: [chk()] });
    transport.getDeliveryStatus.mockResolvedValue({ status: { status_id: 5, description: 'Исход неизвестен' } });
    await worker.processTick();
    expect(flips()).toHaveLength(0);
    expect(stepLogs()).toHaveLength(1);
  });

  test('настоящий отказ (шлюз: error без «исход неизвестен», свежая сверка) → нормальное продолжение со следующего мессенджера', async () => {
    setup({ checks: [chk()] });
    transport.getDeliveryStatus.mockResolvedValue({ ...FAILED5, error: '400 USER_IS_BLOCKED' });
    await worker.processTick();
    expect(flips()[0].slice(0, 3)).toEqual([7, 'pending', 1]);
    expect(stepLogs()).toHaveLength(0);
  });

  test('время отправки неизвестно (sent_at пуст) — свежесть не доказать, не продолжаем', async () => {
    setup({ checks: [chk({ sent_at: null })] });
    transport.getDeliveryStatus.mockResolvedValue(FAILED5);
    await worker.processTick();
    expect(flips()).toHaveLength(0);
    expect(JSON.parse(stepLogs()[0][1])[0].res).toBe('undeliverable_unknown');
  });

  test('поздний статус 5 на последнем мессенджере — тоже не failed: строка остаётся sent', async () => {
    setup({ checks: [chk({ channel_used: 'whatsapp', cascade_pos: 1, sent_at: ago(CHECK_MAX_AGE_MS + 5 * MIN) })] });
    transport.getDeliveryStatus.mockResolvedValue(FAILED5);
    await worker.processTick();
    expect(flips()).toHaveLength(0);
  });

  test('сбой записи шага undeliverable_unknown не теряет сверку остальных', async () => {
    setup({ checks: [chk({ id: 7, sent_at: ago(CHECK_MAX_AGE_MS + MIN) }), chk({ id: 8, delivery_id: 'g14' })] });
    transport.getDeliveryStatus.mockResolvedValue(FAILED5);
    db.query.mockImplementation(async (sql, p) => {
      if (/SET cascade_log = cascade_log \|\| \$2::jsonb\s+WHERE id=\$1 AND status='sent'/.test(sql) && p[0] === 7) throw new Error('db blip');
      return { rowCount: 1, rows: [] };
    });
    await expect(worker.processTick()).resolves.toBeUndefined();
    expect(flips().map((p) => p[0])).toEqual([8]);
  });

  test('статус 5 → строка снова pending со следующей позиции', async () => {
    setup({ checks: [chk()] });
    transport.getDeliveryStatus.mockResolvedValue({ id: 'g12', status: { status_id: 5, description: 'Невозможно доставить' } });
    await worker.processTick();
    expect(transport.getDeliveryStatus).toHaveBeenCalledWith(1, 'tdlib', 'g12', { accountId: '8' });
    const p = updates(/SET status=\$2, cascade_pos=\$3/)[0];
    expect(p.slice(0, 3)).toEqual([7, 'pending', 1]);
    expect(p[3]).toMatch(/следующий мессенджер/);
  });

  test('статус 5 на последнем мессенджере → failed', async () => {
    setup({ checks: [chk({ channel_used: 'whatsapp', delivery_id: 'g13', account_id: '9', cascade_pos: 1 })] });
    transport.getDeliveryStatus.mockResolvedValue({ status: { status_id: 5 } });
    await worker.processTick();
    expect(updates(/SET status=\$2, cascade_pos=\$3/)[0].slice(0, 3)).toEqual([7, 'failed', 1]);
  });

  test('переход из sent под защитой статуса (параллельную отмену не затираем)', async () => {
    setup({ checks: [chk()] });
    transport.getDeliveryStatus.mockResolvedValue({ status: { status_id: 5 } });
    await worker.processTick();
    const [sql] = db.query.mock.calls.find(([s]) => /SET status=\$2, cascade_pos=\$3/.test(s));
    expect(sql).toMatch(/WHERE id=\$1 AND status='sent'/);
  });

  test('ошибка чтения статуса — ничего не меняем (не знаем судьбу → считаем доставленным)', async () => {
    setup({ checks: [chk()] });
    transport.getDeliveryStatus.mockRejectedValue(new Error('500'));
    await worker.processTick();
    expect(updates(/SET status=\$2, cascade_pos=\$3/)).toHaveLength(0);
  });

  test.each([[{ status: { status_id: 3 } }], [{ status: { status_id: '2', description: 'Доставлено' } }], [{}], [null]])('ответ %j — не «Невозможно доставить» → ничего не меняем', async (answer) => {
    setup({ checks: [chk()] });
    transport.getDeliveryStatus.mockResolvedValue(answer);
    await worker.processTick();
    expect(updates(/SET status=\$2, cascade_pos=\$3/)).toHaveLength(0);
  });

  test('status_id приходит строкой "5" — тоже «Невозможно доставить»', async () => {
    setup({ checks: [chk()] });
    transport.getDeliveryStatus.mockResolvedValue({ status: { status_id: '5' } });
    await worker.processTick();
    expect(updates(/SET status=\$2, cascade_pos=\$3/)[0].slice(0, 3)).toEqual([7, 'pending', 1]);
  });

  test('сбой записи по одной строке не теряет сверку остальных (check_at у них уже обнулён)', async () => {
    setup({ checks: [chk({ id: 7 }), chk({ id: 8, delivery_id: 'g14' })] });
    transport.getDeliveryStatus.mockResolvedValue({ status: { status_id: 5 } });
    db.query.mockImplementation(async (sql, p) => {
      if (/SET status=\$2, cascade_pos=\$3/.test(sql) && p[0] === 7) throw new Error('db blip');
      return { rowCount: 1, rows: [] };
    });
    await expect(worker.processTick()).resolves.toBeUndefined();
    expect(transport.getDeliveryStatus).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls.filter(([sql]) => /SET status=\$2, cascade_pos=\$3/.test(sql)).map(([, p]) => p[0])).toEqual([7, 8]);
  });

  test('сбой сверки не роняет тик отправки', async () => {
    setup({ jobs: [job()] });
    db.any.mockImplementation(async (sql) => {
      if (/SET check_at = NULL/.test(sql)) throw new Error('db blip');
      return /SET attempts = j.attempts/.test(sql) ? [job()] : [];
    });
    await expect(worker.processTick()).resolves.toBeUndefined();
    expect(calls()).toEqual(['tdlib']);
  });
});

describe('SQL аренды и сверки', () => {
  test('аренда: due pending, бэкофф, порядок «кто раньше» с тай-брейком по id, SKIP LOCKED', () => {
    expect(worker.LEASE_SQL).toMatch(/status = 'pending' AND scheduled_at <= NOW\(\)/);
    expect(worker.LEASE_SQL).toMatch(/last_attempt_at < NOW\(\) - make_interval\(secs => \$1\)/);
    expect(worker.LEASE_SQL).toMatch(/ORDER BY scheduled_at ASC, id ASC\s+LIMIT \$2\s+FOR UPDATE SKIP LOCKED/);
    expect(worker.LEASE_SQL).toMatch(/SET attempts = j\.attempts \+ 1, last_attempt_at = NOW\(\)/);
    expect(worker.LEASE_SQL).toMatch(/RETURNING j\.\*/);
  });

  test('аренда берёт строки только салонов с режимом shadow/live (off и неизвестный режим не арендуются вовсе)', () => {
    expect(worker.LEASE_SQL).toMatch(/AND salon_id IN \(SELECT salon_id FROM notification_settings WHERE mode IN \('shadow','live'\)\)/);
  });

  test('сверка: забираем строку, обнуляя check_at; только sent с назначенной сверкой', () => {
    expect(worker.CHECK_SQL).toMatch(/SET check_at = NULL/);
    expect(worker.CHECK_SQL).toMatch(/status = 'sent' AND check_at IS NOT NULL AND check_at <= NOW\(\)/);
    expect(worker.CHECK_SQL).toMatch(/ORDER BY check_at ASC\s+LIMIT \$1\s+FOR UPDATE SKIP LOCKED/);
    expect(worker.CHECK_SQL).toMatch(/RETURNING id, salon_id, channel_used, delivery_id, account_id, cascade_pos, routing, sent_at/);
  });
});

describe('startNotificationWorker', () => {
  // Свежий экземпляр модуля (флаги _running/_inFlight живут в замыкании модуля).
  function fresh() {
    let w; let dbm; let tr;
    jest.isolateModules(() => {
      dbm = require('./db').db;
      tr = require('./services/messaging/transport');
      w = require('./services/notifications/worker');
    });
    dbm.any.mockResolvedValue([]);
    tr.configured.mockReturnValue(true);
    return { w, dbm, tr };
  }
  const leases = (dbm) => dbm.any.mock.calls.filter(([sql]) => /SET attempts = j.attempts/.test(sql)).length;
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('тик раз в 10 с; повторный запуск игнорируется', () => {
    const { w, dbm } = fresh();
    w.startNotificationWorker();
    w.startNotificationWorker();
    expect(leases(dbm)).toBe(0);
    jest.advanceTimersByTime(10000);
    expect(leases(dbm)).toBe(1);
  });

  test('пока прошлый тик не закончился, следующий не стартует', async () => {
    const { w, dbm } = fresh();
    let release;
    dbm.any.mockImplementation((sql) => (/SET attempts = j.attempts/.test(sql) ? new Promise((r) => { release = r; }) : Promise.resolve([])));
    w.startNotificationWorker();
    await jest.advanceTimersByTimeAsync(10000);
    await jest.advanceTimersByTimeAsync(30000);
    expect(leases(dbm)).toBe(1);
    release([]);
    await jest.advanceTimersByTimeAsync(10000);
    expect(leases(dbm)).toBe(2);
  });

  test('транспорт не настроен → воркер не стартует', () => {
    const { w, dbm, tr } = fresh();
    tr.configured.mockReturnValue(false);
    w.startNotificationWorker();
    jest.advanceTimersByTime(60000);
    expect(leases(dbm)).toBe(0);
  });

  test('ошибка тика не убивает таймер', async () => {
    const { w, dbm } = fresh();
    dbm.any.mockRejectedValue(new Error('db down'));
    w.startNotificationWorker();
    await jest.advanceTimersByTimeAsync(10000);
    await jest.advanceTimersByTimeAsync(10000);
    expect(leases(dbm)).toBe(2);
  });
});

describe('transport.isDefiniteRejection — экспортирован и решает, можно ли идти по каскаду дальше', () => {
  let real;
  beforeAll(() => {
    jest.isolateModules(() => {
      jest.doMock('./services/messaging/accounts', () => ({}));
      jest.doMock('./services/chatpush', () => ({}));
      jest.doMock('./config', () => ({ CHATPUSH: {}, MESSAGING_GATEWAY: {} }));
      real = jest.requireActual('./services/messaging/transport');
    });
  });

  test('экспортируется функцией', () => {
    expect(typeof real.isDefiniteRejection).toBe('function');
  });
  test('4xx — однозначный отказ', () => {
    expect(real.isDefiniteRejection(Object.assign(new Error('x'), { status: 422 }))).toBe(true);
    expect(real.isDefiniteRejection(Object.assign(new Error('x'), { status: 404 }))).toBe(true);
  });
  test('наша собственная проверка (ошибка без status и code, например «нет аккаунта») — однозначный отказ', () => {
    expect(real.isDefiniteRejection(new Error('нет аккаунта мессенджера у салона 1 для каналов [tdlib]'))).toBe(true);
  });
  test('5xx и ошибки сети/таймаута (code) — неоднозначны: сообщение могло уйти', () => {
    expect(real.isDefiniteRejection(Object.assign(new Error('x'), { status: 502 }))).toBe(false);
    expect(real.isDefiniteRejection(Object.assign(new Error('x'), { status: 500 }))).toBe(false);
    expect(real.isDefiniteRejection(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }))).toBe(false);
    expect(real.isDefiniteRejection(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(false);
  });
  test('пустая ошибка — не отказ', () => {
    expect(real.isDefiniteRejection(null)).toBe(false);
    expect(real.isDefiniteRejection(undefined)).toBe(false);
  });
});
