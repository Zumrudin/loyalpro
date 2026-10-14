'use strict';
// Ответы пациентов на НАШИ уведомления (services/notifications/replies.js): «Подтверждаю» после
// напоминания → attendance=2 в YClients + отбивка, цифра 2–5 после опроса → visit_ratings + текст
// по полосе. Работает ТОЛЬКО в режиме live; всё, что модуль не берёт, уходит Миле как раньше.
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn(), query: jest.fn() } }));
jest.mock('./logger', () => {
  const log = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: () => log, __log: log };
});
jest.mock('./services/notifications/settings', () => ({ getSettings: jest.fn() }));
jest.mock('./services/agent/history', () => ({ lastOutgoing: jest.fn() }));
jest.mock('./services/yclients-records', () => ({ updateAttendance: jest.fn() }));
jest.mock('./services/messaging/transport', () => ({ sendMessage: jest.fn() }));
jest.mock('./services/agent/pending-replies', () => ({ remember: jest.fn() }));
jest.mock('./services/outgoing-authorship', () => ({ remember: jest.fn() }));
jest.mock('./services/chat-persist', () => ({ persistWhatsappOutgoing: jest.fn() }));
jest.mock('./services/agent/dialog-state', () => ({ getOrCreate: jest.fn() }));
// Эскалация — ОДНО правило проекта (agent_dialogs + каскад «Заботы» + agent_events + SSE + гашение
// напоминания Милы): модуль зовёт инструмент, а не копирует его, поэтому мокаем сам инструмент.
jest.mock('./services/agent/tools/escalate-to-operator', () => ({ run: jest.fn() }));

const { db } = require('./db');
const { __log: log } = require('./logger');
const settings = require('./services/notifications/settings');
const history = require('./services/agent/history');
const yc = require('./services/yclients-records');
const transport = require('./services/messaging/transport');
const pendingReplies = require('./services/agent/pending-replies');
const authorship = require('./services/outgoing-authorship');
const persist = require('./services/chat-persist');
const dialogState = require('./services/agent/dialog-state');
const escalate = require('./services/agent/tools/escalate-to-operator');
const replies = require('./services/notifications/replies');

const REMINDER = 'Здравствуйте!\nНапоминаем о записи в «PERI CLINIC»\nВаша запись 14.10.2026 в 13:30\nПожалуйста, подтвердите визит';
const SURVEY = 'Спасибо что посетили «PERI CLINIC»! Просим Вас оценить обслуживание, отправив в ответ сообщение с цифрой от 2 до 5';
const KEY = '79200255591';
const DAY = 24 * 3600 * 1000;
const msg = (text, over = {}) => ({ direction: 'incoming', channel: 'tdlib', phone: KEY, chatId: '123', chatType: 'person',
  messageId: 'm-1', type: 'text', text, ...over });
const salon = { id: 1, yclients_company_id: 5 };
const REM_JOB = { id: 10, yclients_record_id: 100, meta: { askConfirmation: true } };
const REV_JOB = { id: 11, yclients_record_id: 100, client_id: 9, meta: {} };
const FROM_SYSTEM = (text) => ({ author: 'system', text });

const CAPTURE = /SET confirmed_at\s*=\s*NOW\(\)/;
const RELEASE = /SET confirmed_at\s*=\s*NULL/;
const INSERT_RATING = /INSERT INTO visit_ratings/;

/**
 * last — последнее исходящее диалога; job — что вернёт поиск job'а; capture — сколько строк захватил
 * UPDATE confirmed_at (0 = job уже захвачен другим ответом); state — notification_record_state.
 */
function setup({ last = null, job = null, mode = 'live', capture = 1, state = null, cfg = {} } = {}) {
  settings.getSettings.mockResolvedValue({
    mode, confirm_reply_text: '✅ Подтверждено', rating_high_text: 'Спасибо!',
    rating_mid_text: 'Что улучшить?', rating_low_text: 'Что не так?', rating_escalate_low: true, ...cfg,
  });
  history.lastOutgoing.mockResolvedValue(last);
  db.oneOrNone.mockImplementation(async (sql) => {
    if (/FROM salons/.test(sql)) return salon;
    if (/FROM notification_jobs/.test(sql)) return job;
    if (/FROM notification_record_state/.test(sql)) return state;
    return null;
  });
  db.query.mockImplementation(async (sql) => (CAPTURE.test(sql) ? { rowCount: capture, rows: [] } : { rowCount: 1, rows: [] }));
}
const queries = (re) => db.query.mock.calls.filter(([sql]) => re.test(sql));
const queryOrder = (re) => {
  const i = db.query.mock.calls.findIndex(([sql]) => re.test(sql));
  return i < 0 ? null : db.query.mock.invocationCallOrder[i];
};
const jobLookup = () => db.oneOrNone.mock.calls.find(([sql]) => /FROM notification_jobs/.test(sql));
const nothingTouched = () => {
  expect(yc.updateAttendance).not.toHaveBeenCalled();
  expect(transport.sendMessage).not.toHaveBeenCalled();
  expect(escalate.run).not.toHaveBeenCalled();
  expect(queries(INSERT_RATING)).toHaveLength(0);
};

beforeEach(() => {
  jest.resetAllMocks();
  transport.sendMessage.mockResolvedValue({ id: 77, channel: 'tdlib', accountId: 3 });
  authorship.remember.mockResolvedValue(undefined);
  persist.persistWhatsappOutgoing.mockResolvedValue(undefined);
  dialogState.getOrCreate.mockResolvedValue({});
  escalate.run.mockResolvedValue({ escalated: true, reason: 'low_rating' });
  yc.updateAttendance.mockResolvedValue({});
});

describe('режим салона: перехват только в live', () => {
  test.each(['off', 'shadow', 'LIVE', 'bogus', '', null])('режим %p → не перехватываем и ничего не трогаем', async (mode) => {
    setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB, mode });
    expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: false });
    expect(await replies.handleIncoming(1, msg('5'))).toEqual({ handled: false });
    nothingTouched();
    expect(db.query).not.toHaveBeenCalled();
    expect(db.oneOrNone).not.toHaveBeenCalled();
    expect(history.lastOutgoing).not.toHaveBeenCalled();
    expect(dialogState.getOrCreate).not.toHaveBeenCalled();
  });

  // Дев получает РЕАЛЬНЫЕ сообщения пациентов, настройки уведомлений на деве не заведены: строки нет →
  // дефолты (режим off). Проверяем РЕАЛЬНЫМ модулем настроек, а не моком — иначе тест доказывал бы лишь
  // то, что мы сами подложили в мок.
  describe('настоящий модуль настроек', () => {
    const real = jest.requireActual('./services/notifications/settings');
    beforeEach(() => {
      real.invalidate();
      settings.getSettings.mockImplementation(real.getSettings);
      history.lastOutgoing.mockResolvedValue(FROM_SYSTEM(REMINDER));
    });

    test('у салона нет строки notification_settings (дев) → режим off, перехвата нет', async () => {
      db.oneOrNone.mockResolvedValue(null);
      expect(real.DEFAULTS.mode).toBe('off');
      expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: false });
      expect(db.oneOrNone.mock.calls.some(([sql]) => /FROM notification_settings/.test(sql))).toBe(true);
      nothingTouched();
      expect(db.query).not.toHaveBeenCalled();
      expect(history.lastOutgoing).not.toHaveBeenCalled();
    });

    test('mode=live в строке салона → перехват работает, текст отбивки — из дефолтов настроек', async () => {
      history.lastOutgoing.mockResolvedValue(FROM_SYSTEM(SURVEY));
      db.oneOrNone.mockImplementation(async (sql) => {
        if (/FROM notification_settings/.test(sql)) return { mode: 'live' };
        if (/FROM notification_jobs/.test(sql)) return REV_JOB;
        return null;
      });
      db.query.mockResolvedValue({ rowCount: 1, rows: [] });
      expect(await replies.handleIncoming(1, msg('5'))).toEqual({ handled: true, kind: 'rating', rating: 5 });
      expect(transport.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ text: real.DEFAULTS.rating_high_text }));
    });

    test('mode=shadow в строке салона → перехвата нет', async () => {
      db.oneOrNone.mockImplementation(async (sql) => (/FROM notification_settings/.test(sql) ? { mode: 'shadow' } : null));
      expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: false });
      nothingTouched();
    });
  });
});

describe('подтверждение визита', () => {
  test('после нашего напоминания: захват → attendance=2 → отбивка ответом на сообщение пациента', async () => {
    setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB });
    const r = await replies.handleIncoming(1, msg('Здравствуйте, подтверждаю'));
    expect(r).toEqual({ handled: true, kind: 'confirmed' });
    expect(queries(CAPTURE)).toHaveLength(1);
    expect(queries(CAPTURE)[0][1]).toEqual([10, 1]);   // job и салон: захват тоже со salon_id
    expect(yc.updateAttendance).toHaveBeenCalledWith(salon, 100, 2);
    expect(transport.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
      text: '✅ Подтверждено', phone: KEY, dispatchRouting: ['tdlib'], replyToMessageId: 'm-1' }));
    // Захват — ДО обращения к YClients (иначе второй ответ успел бы пройти тем же путём).
    expect(queryOrder(CAPTURE)).toBeLessThan(yc.updateAttendance.mock.invocationCallOrder[0]);
    expect(queries(RELEASE)).toHaveLength(0);
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/record 100.*подтвержд/));
  });

  test('job ищется по ключу номера, а адресат и ключ диалога остаются как пришли', async () => {
    setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB });
    const r = await replies.handleIncoming(1, msg('Подтверждаю', { phone: '8 (920) 025-55-91' }));
    expect(r).toEqual({ handled: true, kind: 'confirmed' });
    // В notification_jobs.phone лежит канон 7XXXXXXXXXX.
    expect(jobLookup()[1]).toEqual([1, KEY, 'visit_reminder', 48]);
    // Ключ диалога и адресат — сырой номер вебхука (так же ведёт диалог диспетчер).
    expect(history.lastOutgoing).toHaveBeenCalledWith(1, '8 (920) 025-55-91');
    expect(transport.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ phone: '8 (920) 025-55-91' }));
    expect(authorship.remember).toHaveBeenCalledWith(1, '8 (920) 025-55-91', '✅ Подтверждено', 'system');
    expect(pendingReplies.remember).toHaveBeenCalledWith(1, '8 (920) 025-55-91', '✅ Подтверждено');
  });

  test.each([['89200255591'], ['+79200255591'], ['9200255591']])('номер %s → поиск job по 79200255591', async (phone) => {
    setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB });
    expect(await replies.handleIncoming(1, msg('+', { phone }))).toEqual({ handled: true, kind: 'confirmed' });
    expect(jobLookup()[1][1]).toBe(KEY);
  });

  test('поиск job: только отправленные, не тестовые (record_id>0); подтверждённые не отфильтрованы — повтор узнаётся захватом', async () => {
    setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB });
    await replies.handleIncoming(1, msg('Подтверждаю'));
    const sql = jobLookup()[0];
    expect(sql).toMatch(/status\s*=\s*'sent'/);
    expect(sql).toMatch(/yclients_record_id\s*>\s*0/);
    expect(sql).toMatch(/salon_id\s*=\s*\$1/);
    expect(sql).not.toMatch(/confirmed_at\s+IS\s+NULL/i);
  });

  test('отбивка — «наша»: журнал авторства ДО отправки, pending-replies после', async () => {
    setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB });
    await replies.handleIncoming(1, msg('Подтверждаю'));
    expect(authorship.remember).toHaveBeenCalledWith(1, KEY, '✅ Подтверждено', 'system');
    expect(authorship.remember.mock.invocationCallOrder[0]).toBeLessThan(transport.sendMessage.mock.invocationCallOrder[0]);
    expect(pendingReplies.remember).toHaveBeenCalledWith(1, KEY, '✅ Подтверждено');
    expect(pendingReplies.remember.mock.invocationCallOrder[0]).toBeGreaterThan(transport.sendMessage.mock.invocationCallOrder[0]);
    expect(persist.persistWhatsappOutgoing).not.toHaveBeenCalled();   // tdlib: эхо придёт само
  });

  test('WhatsApp: отбивка кладётся в «Чат» сразу (эха нет), авторство system', async () => {
    setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB });
    const wa = msg('Подтверждаю', { channel: 'whatsapp', chatId: `${KEY}@c.us`, chatType: undefined });
    expect(await replies.handleIncoming(1, wa)).toEqual({ handled: true, kind: 'confirmed' });
    expect(transport.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ dispatchRouting: ['whatsapp'], phone: KEY }));
    expect(persist.persistWhatsappOutgoing).toHaveBeenCalledWith(1, expect.objectContaining({
      delivery: { id: 77, channel: 'tdlib', accountId: 3 }, phone: KEY, chatId: `${KEY}@c.us`,
      text: '✅ Подтверждено', msgType: 'text', authoredBy: 'system' }));
  });

  test('MAX: адресат — номер и max_user_id из chat_id, как у диспетчера', async () => {
    setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB });
    const mx = msg('Подтверждаю', { channel: 'max', chatId: '555' });
    await replies.handleIncoming(1, mx);
    expect(transport.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
      dispatchRouting: ['max'], phone: KEY, max_user_id: '555' }));
  });

  test('пустой текст отбивки → ничего не шлём, но подтверждение засчитано', async () => {
    setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB, cfg: { confirm_reply_text: '   ' } });
    expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: true, kind: 'confirmed' });
    expect(yc.updateAttendance).toHaveBeenCalledWith(salon, 100, 2);
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  test('отбивка не ушла (сбой транспорта) → статус в YClients уже стоит, ход Миле НЕ отдаём, захват не снимаем', async () => {
    setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB });
    transport.sendMessage.mockRejectedValue(new Error('timeout'));
    expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: true, kind: 'confirmed' });
    expect(queries(RELEASE)).toHaveLength(0);
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/timeout/));
    expect(pendingReplies.remember).not.toHaveBeenCalled();   // не ушло — в транскрипт не кладём
  });

  test('YClients отказал → захват снят, отбивки нет, ход уходит Миле', async () => {
    setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB });
    yc.updateAttendance.mockRejectedValue(new Error('429'));
    expect(await replies.handleIncoming(1, msg('+'))).toEqual({ handled: false });
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(queries(RELEASE)).toHaveLength(1);
    expect(queries(RELEASE)[0][1]).toEqual([10, 1]);
    expect(queryOrder(RELEASE)).toBeGreaterThan(queryOrder(CAPTURE));
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/429/));
  });

  test('после отказа YClients следующий «Подтверждаю» снова доходит до YClients (захват был снят)', async () => {
    let held = false;
    setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB });
    db.query.mockImplementation(async (sql) => {
      if (CAPTURE.test(sql)) { if (held) return { rowCount: 0, rows: [] }; held = true; return { rowCount: 1, rows: [] }; }
      if (RELEASE.test(sql)) held = false;
      return { rowCount: 1, rows: [] };
    });
    yc.updateAttendance.mockRejectedValueOnce(new Error('429')).mockResolvedValueOnce({});
    expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: false });
    expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: true, kind: 'confirmed' });
    expect(yc.updateAttendance).toHaveBeenCalledTimes(2);
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('повтор: job уже захвачен другим ответом → duplicate, ни YClients, ни отбивки, Миле не отдаём', async () => {
    setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB, capture: 0 });
    expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: true, kind: 'duplicate' });
    expect(queries(CAPTURE)).toHaveLength(1);
    expect(queries(RELEASE)).toHaveLength(0);   // чужой захват не снимаем
    nothingTouched();
    expect(authorship.remember).not.toHaveBeenCalled();
  });

  test('«Подтверждаю» дважды подряд: первый отрабатывает, второй — duplicate', async () => {
    let captured = false;
    setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB });
    db.query.mockImplementation(async (sql) => {
      if (CAPTURE.test(sql)) { if (captured) return { rowCount: 0, rows: [] }; captured = true; }
      return { rowCount: 1, rows: [] };
    });
    expect(await replies.handleIncoming(1, msg('Подтверждаю', { messageId: 'm-1' }))).toEqual({ handled: true, kind: 'confirmed' });
    expect(await replies.handleIncoming(1, msg('Подтверждаю', { messageId: 'm-2' }))).toEqual({ handled: true, kind: 'duplicate' });
    expect(yc.updateAttendance).toHaveBeenCalledTimes(1);
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('два «Подтверждаю» одновременно: YClients и отбивка ровно по разу', async () => {
    let captured = false;
    setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB });
    db.query.mockImplementation(async (sql) => {
      if (CAPTURE.test(sql)) { if (captured) return { rowCount: 0, rows: [] }; captured = true; }
      return { rowCount: 1, rows: [] };
    });
    const [a, b] = await Promise.all([
      replies.handleIncoming(1, msg('Подтверждаю', { messageId: 'm-1' })),
      replies.handleIncoming(1, msg('Подтверждаю', { messageId: 'm-2' })),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(['confirmed', 'duplicate']);
    expect(yc.updateAttendance).toHaveBeenCalledTimes(1);
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('последнее исходящее — не напоминание (Мила спросила про время) → Миле', async () => {
    setup({ last: { author: 'agent', text: 'Вас записать на 13:30?' } });
    expect(await replies.handleIncoming(1, msg('Да'))).toEqual({ handled: false });
    expect(jobLookup()).toBeUndefined();
    nothingTouched();
  });

  test('текст напоминания, но автор не system (оператор переслал) → Миле', async () => {
    setup({ last: { author: 'operator', text: REMINDER }, job: REM_JOB });
    expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: false });
    nothingTouched();
  });

  test('исходящих в диалоге нет → Миле', async () => {
    setup({ last: null, job: REM_JOB });
    expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: false });
    nothingTouched();
  });

  test('не чистое подтверждение («да, а можно перенести?») → Миле', async () => {
    setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB });
    expect(await replies.handleIncoming(1, msg('Да, а можно перенести на 15:00?'))).toEqual({ handled: false });
    nothingTouched();
  });

  test('напоминание не наше (нет sent-job по телефону) → Миле', async () => {
    setup({ last: FROM_SYSTEM(REMINDER), job: null });
    expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: false });
    nothingTouched();
    expect(queries(CAPTURE)).toHaveLength(0);
  });

  test('напоминание без просьбы подтвердить (ask_confirmation выключен в правиле) → Миле', async () => {
    setup({ last: FROM_SYSTEM(REMINDER), job: { ...REM_JOB, meta: { askConfirmation: false } } });
    expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: false });
    nothingTouched();
    setup({ last: FROM_SYSTEM(REMINDER), job: { ...REM_JOB, meta: null } });
    expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: false });
    nothingTouched();
  });

  test('салон не нашёлся → Миле, захвата нет', async () => {
    setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB });
    db.oneOrNone.mockImplementation(async (sql) => (/FROM notification_jobs/.test(sql) ? REM_JOB : null));
    expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: false });
    expect(queries(CAPTURE)).toHaveLength(0);
    nothingTouched();
  });

  describe('устаревшее напоминание не подтверждаем (не откатываем «Пришёл», не подтверждаем старое время)', () => {
    const future = new Date(Date.now() + DAY);
    const later = new Date(Date.now() + 2 * DAY);
    const job = { ...REM_JOB, visit_datetime: future };

    test.each([
      ['визит уже начался', { ...REM_JOB, visit_datetime: new Date(Date.now() - 3600 * 1000) }, null],
      ['запись перенесена на другое время', job, { visit_datetime: later, attendance: 0, deleted: false }],
      ['запись удалена', job, { visit_datetime: future, attendance: 0, deleted: true }],
      ['пациент отмечен «не пришёл»', job, { visit_datetime: future, attendance: -1, deleted: false }],
      ['пациент уже отмечен «пришёл»', job, { visit_datetime: future, attendance: 1, deleted: false }],
    ])('%s → YClients не трогаем, ход Миле', async (_name, j, state) => {
      setup({ last: FROM_SYSTEM(REMINDER), job: j, state });
      expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: false });
      expect(queries(CAPTURE)).toHaveLength(0);
      nothingTouched();
    });

    test.each([
      ['время записи совпадает, ожидание', { visit_datetime: future, attendance: 0, deleted: false }],
      ['уже «Подтвердил» (повторный PUT безвреден)', { visit_datetime: future, attendance: 2, deleted: false }],
      ['состояния записи нет (создана до выката)', null],
    ])('%s → подтверждаем', async (_name, state) => {
      setup({ last: FROM_SYSTEM(REMINDER), job, state });
      expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: true, kind: 'confirmed' });
      expect(yc.updateAttendance).toHaveBeenCalledWith(salon, 100, 2);
    });

    test('у job нет момента визита (не разобран) → «уже начался» не выдумываем', async () => {
      setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB, state: null });
      expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: true, kind: 'confirmed' });
    });
  });
});

describe('оценка визита', () => {
  test('«5» после нашего опроса → оценка сохранена, благодарность, перевода нет', async () => {
    setup({ last: FROM_SYSTEM(SURVEY), job: REV_JOB });
    expect(await replies.handleIncoming(1, msg('5'))).toEqual({ handled: true, kind: 'rating', rating: 5 });
    const ins = queries(INSERT_RATING);
    expect(ins).toHaveLength(1);
    // salon, запись, клиент, номер (канон), оценка, job-источник
    expect(ins[0][1]).toEqual([1, 100, 9, KEY, 5, 11]);
    expect(queries(CAPTURE)[0][1]).toEqual([11, 1]);
    expect(queryOrder(CAPTURE)).toBeLessThan(queryOrder(INSERT_RATING));
    expect(jobLookup()[1]).toEqual([1, KEY, 'visit_review', 168]);
    expect(transport.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
      text: 'Спасибо!', phone: KEY, dispatchRouting: ['tdlib'], replyToMessageId: 'm-1' }));
    expect(dialogState.getOrCreate).not.toHaveBeenCalled();
    expect(escalate.run).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/record 100.*оценка 5/));
  });

  test('оценка пишется под номером в каноне, даже если вебхук прислал другую форму', async () => {
    setup({ last: FROM_SYSTEM(SURVEY), job: REV_JOB });
    await replies.handleIncoming(1, msg('5', { phone: '+7 920 025-55-91' }));
    expect(queries(INSERT_RATING)[0][1][3]).toBe(KEY);
    expect(jobLookup()[1][1]).toBe(KEY);
  });

  test('«4» → «что улучшить», без перевода на администратора', async () => {
    setup({ last: FROM_SYSTEM(SURVEY), job: REV_JOB });
    expect(await replies.handleIncoming(1, msg('4'))).toEqual({ handled: true, kind: 'rating', rating: 4 });
    expect(transport.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ text: 'Что улучшить?' }));
    expect(dialogState.getOrCreate).not.toHaveBeenCalled();
    expect(escalate.run).not.toHaveBeenCalled();
  });

  test.each([[2], [3]])('«%i» → «что не так» и перевод на администратора общим инструментом эскалации', async (n) => {
    setup({ last: FROM_SYSTEM(SURVEY), job: REV_JOB });
    expect(await replies.handleIncoming(1, msg(String(n)))).toEqual({ handled: true, kind: 'rating', rating: n });
    expect(transport.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ text: 'Что не так?' }));
    // Строка agent_dialogs нужна инструменту (его UPDATE по несуществующей строке ничего не меняет).
    expect(dialogState.getOrCreate).toHaveBeenCalledWith(1, KEY);
    expect(escalate.run).toHaveBeenCalledTimes(1);
    expect(escalate.run).toHaveBeenCalledWith(1, { reason: 'low_rating' }, { dialogKey: KEY });
    expect(dialogState.getOrCreate.mock.invocationCallOrder[0]).toBeLessThan(escalate.run.mock.invocationCallOrder[0]);
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/низкая/));
  });

  test('ключ диалога для перевода — сырой номер вебхука, как у диспетчера', async () => {
    setup({ last: FROM_SYSTEM(SURVEY), job: REV_JOB });
    await replies.handleIncoming(1, msg('2', { phone: '89200255591' }));
    expect(dialogState.getOrCreate).toHaveBeenCalledWith(1, '89200255591');
    expect(escalate.run).toHaveBeenCalledWith(1, { reason: 'low_rating' }, { dialogKey: '89200255591' });
  });

  test('перевод при 2–3 выключен в настройках → текст уходит, диалог остаётся у Милы', async () => {
    setup({ last: FROM_SYSTEM(SURVEY), job: REV_JOB, cfg: { rating_escalate_low: false } });
    expect(await replies.handleIncoming(1, msg('3'))).toEqual({ handled: true, kind: 'rating', rating: 3 });
    expect(transport.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ text: 'Что не так?' }));
    expect(escalate.run).not.toHaveBeenCalled();
    expect(dialogState.getOrCreate).not.toHaveBeenCalled();
  });

  test('повтор: оценка по этому job уже учтена → duplicate, ни записи, ни отбивки, ни второго перевода', async () => {
    setup({ last: FROM_SYSTEM(SURVEY), job: REV_JOB, capture: 0 });
    expect(await replies.handleIncoming(1, msg('3'))).toEqual({ handled: true, kind: 'duplicate' });
    expect(queries(CAPTURE)).toHaveLength(1);
    expect(queries(RELEASE)).toHaveLength(0);
    nothingTouched();
    expect(dialogState.getOrCreate).not.toHaveBeenCalled();
  });

  test('«3» дважды подряд: одна оценка, одна отбивка, один перевод', async () => {
    let captured = false;
    setup({ last: FROM_SYSTEM(SURVEY), job: REV_JOB });
    db.query.mockImplementation(async (sql) => {
      if (CAPTURE.test(sql)) { if (captured) return { rowCount: 0, rows: [] }; captured = true; }
      return { rowCount: 1, rows: [] };
    });
    expect(await replies.handleIncoming(1, msg('3', { messageId: 'm-1' }))).toEqual({ handled: true, kind: 'rating', rating: 3 });
    expect(await replies.handleIncoming(1, msg('3', { messageId: 'm-2' }))).toEqual({ handled: true, kind: 'duplicate' });
    expect(queries(INSERT_RATING)).toHaveLength(1);
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
    expect(escalate.run).toHaveBeenCalledTimes(1);
  });

  test('«5» и «5» одновременно: одна благодарность', async () => {
    let captured = false;
    setup({ last: FROM_SYSTEM(SURVEY), job: REV_JOB });
    db.query.mockImplementation(async (sql) => {
      if (CAPTURE.test(sql)) { if (captured) return { rowCount: 0, rows: [] }; captured = true; }
      return { rowCount: 1, rows: [] };
    });
    const out = await Promise.all([
      replies.handleIncoming(1, msg('5', { messageId: 'm-1' })),
      replies.handleIncoming(1, msg('5', { messageId: 'm-2' })),
    ]);
    expect(out.map((r) => r.kind).sort()).toEqual(['duplicate', 'rating']);
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
    expect(queries(INSERT_RATING)).toHaveLength(1);
  });

  test('оценка не записалась (сбой БД) → захват снят, ход уходит Миле, отбивки и перевода нет', async () => {
    setup({ last: FROM_SYSTEM(SURVEY), job: REV_JOB });
    db.query.mockImplementation(async (sql) => {
      if (INSERT_RATING.test(sql)) throw new Error('db down');
      return { rowCount: 1, rows: [] };
    });
    expect(await replies.handleIncoming(1, msg('3'))).toEqual({ handled: false });
    expect(queries(RELEASE)).toHaveLength(1);
    expect(queries(RELEASE)[0][1]).toEqual([11, 1]);
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(escalate.run).not.toHaveBeenCalled();
  });

  test('сбой отправки отбивки на «3»: оценка сохранена, перевод на администратора всё равно выполнен', async () => {
    setup({ last: FROM_SYSTEM(SURVEY), job: REV_JOB });
    transport.sendMessage.mockRejectedValue(new Error('timeout'));
    expect(await replies.handleIncoming(1, msg('3'))).toEqual({ handled: true, kind: 'rating', rating: 3 });
    expect(queries(INSERT_RATING)).toHaveLength(1);
    expect(escalate.run).toHaveBeenCalledWith(1, { reason: 'low_rating' }, { dialogKey: KEY });
    expect(queries(RELEASE)).toHaveLength(0);
  });

  test('сбой перевода на «3» не ломает результат: оценка учтена, отбивка ушла, сбой — в лог', async () => {
    setup({ last: FROM_SYSTEM(SURVEY), job: REV_JOB });
    escalate.run.mockRejectedValue(new Error('db down'));
    expect(await replies.handleIncoming(1, msg('3'))).toEqual({ handled: true, kind: 'rating', rating: 3 });
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/db down/));
  });

  test('сбой getOrCreate: инструмент не зовём (без строки диалога его UPDATE пуст, а SSE соврал бы), сбой — в лог, исключения нет', async () => {
    setup({ last: FROM_SYSTEM(SURVEY), job: REV_JOB });
    dialogState.getOrCreate.mockRejectedValue(new Error('db down'));
    expect(await replies.handleIncoming(1, msg('2'))).toEqual({ handled: true, kind: 'rating', rating: 2 });
    expect(escalate.run).not.toHaveBeenCalled();
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/db down/));
  });

  test('WhatsApp: благодарность кладётся в «Чат» сразу, авторство system', async () => {
    setup({ last: FROM_SYSTEM(SURVEY), job: REV_JOB });
    const wa = msg('5', { channel: 'whatsapp', chatId: `${KEY}@c.us`, chatType: undefined });
    await replies.handleIncoming(1, wa);
    expect(persist.persistWhatsappOutgoing).toHaveBeenCalledWith(1, expect.objectContaining({
      text: 'Спасибо!', msgType: 'text', authoredBy: 'system', phone: KEY }));
  });

  test('цифра со словами («5, спасибо!») → Миле', async () => {
    setup({ last: FROM_SYSTEM(SURVEY), job: REV_JOB });
    expect(await replies.handleIncoming(1, msg('5, спасибо большое!'))).toEqual({ handled: false });
    nothingTouched();
  });

  test.each([['1'], ['6'], ['0'], ['55'], ['2 3']])('«%s» — не оценка 2–5 → Миле', async (t) => {
    setup({ last: FROM_SYSTEM(SURVEY), job: REV_JOB });
    expect(await replies.handleIncoming(1, msg(t))).toEqual({ handled: false });
    nothingTouched();
  });

  test('цифра после напоминания (не опроса) — не оценка → Миле', async () => {
    setup({ last: FROM_SYSTEM(REMINDER), job: REV_JOB });
    expect(await replies.handleIncoming(1, msg('3'))).toEqual({ handled: false });
    nothingTouched();
    expect(jobLookup()).toBeUndefined();
  });

  test('цифра после реплики Милы (автор agent) → Миле', async () => {
    setup({ last: { author: 'agent', text: 'Оцените, пожалуйста, вариант от 2 до 5' }, job: REV_JOB });
    expect(await replies.handleIncoming(1, msg('3'))).toEqual({ handled: false });
    nothingTouched();
  });

  test('опрос не наш (нет sent-job visit_review за неделю) → Миле', async () => {
    setup({ last: FROM_SYSTEM(SURVEY), job: null });
    expect(await replies.handleIncoming(1, msg('5'))).toEqual({ handled: false });
    nothingTouched();
    expect(queries(CAPTURE)).toHaveLength(0);
  });

  test('поиск job опроса: окно 7 суток, только sent, не тестовые', async () => {
    setup({ last: FROM_SYSTEM(SURVEY), job: REV_JOB });
    await replies.handleIncoming(1, msg('5'));
    expect(jobLookup()[1][3]).toBe(168);
    expect(jobLookup()[0]).toMatch(/yclients_record_id\s*>\s*0/);
  });
});

describe('что модуль не берёт', () => {
  test.each([
    ['групповой чат', { chatType: 'group' }],
    ['групповой chat_id без chat_type', { chatType: undefined, chatId: '-100500' }],
    ['не текст (фото)', { type: 'messagePhoto' }],
    ['исходящее', { direction: 'outgoing' }],
    ['номер скрыт (нет телефона)', { phone: null }],
    ['пустой номер', { phone: '   ' }],
  ])('%s → Миле', async (_name, over) => {
    setup({ last: FROM_SYSTEM(SURVEY), job: REV_JOB });
    expect(await replies.handleIncoming(1, msg('5', over))).toEqual({ handled: false });
    nothingTouched();
  });

  test('пустой текст и не-строка → Миле', async () => {
    setup({ last: FROM_SYSTEM(SURVEY), job: REV_JOB });
    expect(await replies.handleIncoming(1, msg('   '))).toEqual({ handled: false });
    expect(await replies.handleIncoming(1, msg(null))).toEqual({ handled: false });
    expect(await replies.handleIncoming(1, msg(undefined))).toEqual({ handled: false });
    nothingTouched();
  });

  test('нет салона или сообщения → Миле', async () => {
    setup({ last: FROM_SYSTEM(SURVEY), job: REV_JOB });
    expect(await replies.handleIncoming(null, msg('5'))).toEqual({ handled: false });
    expect(await replies.handleIncoming(1, null)).toEqual({ handled: false });
    nothingTouched();
  });

  test('обычное сообщение: ни настроек, ни истории, ни БД — модуль стоит на пути КАЖДОГО входящего', async () => {
    setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB });
    expect(await replies.handleIncoming(1, msg('Здравствуйте, хочу записаться на чистку'))).toEqual({ handled: false });
    expect(await replies.handleIncoming(1, msg('Какая цена?'))).toEqual({ handled: false });
    expect(settings.getSettings).not.toHaveBeenCalled();
    expect(history.lastOutgoing).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
    expect(db.oneOrNone).not.toHaveBeenCalled();
  });
});

describe('fail-open: любой сбой → ход уходит Миле, исключение наружу не летит', () => {
  test('сбой чтения настроек', async () => {
    setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB });
    settings.getSettings.mockRejectedValue(new Error('db down'));
    expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: false });
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/db down/));
    nothingTouched();
  });

  test('сбой чтения истории диалога', async () => {
    setup({ job: REM_JOB });
    history.lastOutgoing.mockRejectedValue(new Error('db down'));
    expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: false });
    nothingTouched();
  });

  test('сбой поиска job', async () => {
    setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB });
    db.oneOrNone.mockRejectedValue(new Error('db down'));
    expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: false });
    nothingTouched();
  });

  test('сбой захвата (БД упала на UPDATE) — YClients не трогаем', async () => {
    setup({ last: FROM_SYSTEM(REMINDER), job: REM_JOB });
    db.query.mockRejectedValue(new Error('db down'));
    expect(await replies.handleIncoming(1, msg('Подтверждаю'))).toEqual({ handled: false });
    nothingTouched();
  });
});
