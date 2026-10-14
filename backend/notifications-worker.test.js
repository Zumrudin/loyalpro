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
jest.mock('./services/notifications/settings', () => ({ getSettings: jest.fn() }));
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
  preferLast = true, conv = { lastChannel: null, chats: {} }, blacklisted = false, sibling = null, cfgOver = {} } = {}) {
  settings.getSettings.mockReset();
  settings.getSettings.mockResolvedValue({ mode, default_channels: order, prefer_last_channel: preferLast, ...cfgOver });
  rules.lastConversation.mockReset();
  rules.lastConversation.mockResolvedValue(conv);
  db.any.mockReset();
  db.any.mockImplementation(async (sql) => (/SET check_at = NULL/.test(sql) ? checks : (/SET attempts = j.attempts/.test(sql) ? jobs : [])));
  db.oneOrNone.mockReset();
  db.oneOrNone.mockImplementation(async (sql) => {
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

    test.each(['record_created', 'record_rescheduled', 'record_cancelled', 'visit_reminder', 'visit_after'])('%s: проверки «раз на телефон» нет — таких писем у клиента может быть много', async (type) => {
      setup({ jobs: [job({ trigger_type: type })], st: state({ attendance: type === 'visit_after' ? 1 : (type === 'record_cancelled' ? -1 : 0) }), sibling: { id: 1 } });
      await worker.processTick();
      expect(db.oneOrNone.mock.calls.some(([sql]) => /FROM notification_jobs/.test(sql))).toBe(false);
      expect(calls()).toEqual(['tdlib']);
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

    test('продолжение каскада после «Невозможно доставить» не устаревает (сверка ставит scheduled_at = сейчас)', async () => {
      setup({ jobs: [job({ cascade_pos: 1, routing: ['max', 'tdlib'], scheduled_at: ago(1000) })] });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib']);
    });
  });

  describe('тестовая отправка (meta.test) — исключение из обоих правил', () => {
    test('опоздание трое суток → уходит', async () => {
      setup({ jobs: [job({ trigger_type: 'visit_review', yclients_record_id: 0, visit_datetime: null, meta: { test: true }, scheduled_at: ago(3 * 24 * HOUR) })] });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib']);
      expect(wasCancelled()).toBe(false);
    });

    test('напоминание с визитом в прошлом → уходит', async () => {
      setup({ jobs: [job({ trigger_type: 'visit_reminder', yclients_record_id: 0, visit_datetime: ago(2 * HOUR), meta: { test: true } })] });
      await worker.processTick();
      expect(calls()).toEqual(['tdlib']);
      expect(wasCancelled()).toBe(false);
    });
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
  const chk = (over = {}) => ({ id: 7, salon_id: 1, channel_used: 'tdlib', delivery_id: 'g12', account_id: '8', cascade_pos: 0, routing: ['tdlib', 'whatsapp'], ...over });

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

  test('сверка: забираем строку, обнуляя check_at; только sent с назначенной сверкой', () => {
    expect(worker.CHECK_SQL).toMatch(/SET check_at = NULL/);
    expect(worker.CHECK_SQL).toMatch(/status = 'sent' AND check_at IS NOT NULL AND check_at <= NOW\(\)/);
    expect(worker.CHECK_SQL).toMatch(/ORDER BY check_at ASC\s+LIMIT \$1\s+FOR UPDATE SKIP LOCKED/);
    expect(worker.CHECK_SQL).toMatch(/RETURNING id, salon_id, channel_used, delivery_id, account_id, cascade_pos, routing/);
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
