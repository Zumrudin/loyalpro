'use strict';
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn(), query: jest.fn() }, pool: { connect: jest.fn() } }));
jest.mock('./logger', () => ({ createLogger: () => mockLog }));
jest.mock('./services/notifications/settings', () => ({ getSettings: jest.fn() }));
jest.mock('./services/notifications/rules', () => ({
  ...jest.requireActual('./services/notifications/rules'),
  getServiceCategoryMap: jest.fn(async () => new Map([['1', '10']])),
}));
jest.mock('./utils/salon-names', () => ({ load: jest.fn(async () => null) }));
const { db, pool } = require('./db');
const settings = require('./services/notifications/settings');
const rulesMock = require('./services/notifications/rules');
const enroll = require('./services/notifications/enroll');

const H = 3600e3;
const salon = { id: 1, name: 'PERI CLINIC', yclients_company_id: 5 };
const NOW = Date.parse('2026-10-18T10:00:00+03:00');
const at = (iso) => Date.parse(iso);
const payload = (over = {}, status = 'create') => ({ status, data: {
  id: 100, datetime: '2026-10-20T13:30:00+03:00', seance_length: 3600, attendance: 0, deleted: false, sms_before: 24,
  client: { id: 7, phone: '79200255591', name: 'Анна' }, staff: { id: 55, name: 'Татьяна' },
  services: [{ id: 1, title: 'Пилинг' }], created_user_id: 13287477, ...over } });
const rule = (over) => ({ id: 1, title: 'r', trigger_type: 'record_created', conditions: { logic: 'and', items: [] },
  message_template: '{first_name}, вы записаны {date} {time}', channels: ['tdlib'], prefer_last_channel: true,
  hours_before: 24, delay_minutes: 5, on_no_show: true, ask_confirmation: true, ...over });
const prevOf = (visit, over = {}) => ({ visit_datetime: new Date(visit), attendance: 0, deleted: false, ...over });

function setup({ prev = null, rules = [], client = { id: 9, name: 'Иванова Анна', is_blacklisted: false }, mode = 'live',
  quiet = [null, null], recentReview = false, recentInvite = false, priorVisits = 0 } = {}) {
  settings.getSettings.mockResolvedValue({ mode, quiet_from: quiet[0], quiet_to: quiet[1], default_channels: ['tdlib'] });
  db.oneOrNone.mockImplementation(async (sql) => {
    if (/FROM notification_record_state/.test(sql)) return prev;
    if (/FROM clients/.test(sql)) return client;
    if (/FROM records/.test(sql)) return { n: String(priorVisits) };
    if (/FROM notification_jobs/.test(sql)) {
      if (/'visit_review'/.test(sql)) return recentReview ? { hit: 1 } : null;
      if (/'first_visit'/.test(sql)) return recentInvite ? { hit: 1 } : null;
    }
    return null;
  });
  db.any.mockImplementation(async (sql) => (/FROM notification_rules/.test(sql) ? rules : []));
  db.query.mockResolvedValue({ rowCount: 1, rows: [{ id: 1 }] });
}
const inserts = () => db.query.mock.calls.filter(([sql]) => /INSERT INTO notification_jobs/.test(sql)).map(([, p]) => p);
const cancels = () => db.query.mock.calls.filter(([sql]) => /UPDATE notification_jobs SET status='cancelled'/.test(sql)).map(([, p]) => p);
const jobQueries = (re) => db.oneOrNone.mock.calls.filter(([sql]) => /FROM notification_jobs/.test(sql) && re.test(sql));
// индексы параметров insertJob: [2] trigger, [3] rule_title, [4] record, [5] visit, [6] scheduled_at,
// [8] text, [9] status, [10] phone, [11] attachment, [12] meta, [13] reason

// Мини-модель таблиц: ровно та семантика, на которую опирается enroll — уникальный ключ
// (правило, запись, момент визита), оживление строки в статусе cancelled, гашение pending, состояние записи.
// yieldIO заставляет каждую операцию уступать циклу событий — так проявляются гонки конкурентных вызовов.
function fakeTables(rules, { yieldIO = false, quiet = [null, null] } = {}) {
  const jobs = []; const states = new Map();
  const tick = () => (yieldIO ? new Promise((r) => setImmediate(r)) : Promise.resolve());
  const keyOf = (p) => `${p[1]}|${p[4]}|${p[5] ? new Date(p[5]).getTime() : 0}`;
  settings.getSettings.mockResolvedValue({ mode: 'live', quiet_from: quiet[0], quiet_to: quiet[1], default_channels: ['tdlib'] });
  db.any.mockImplementation(async (sql) => (/FROM notification_rules/.test(sql) ? rules : []));
  db.oneOrNone.mockImplementation(async (sql, p) => {
    await tick();
    if (/FROM notification_record_state/.test(sql)) return states.get(p[1]) || null;
    if (/FROM clients/.test(sql)) return { id: 9, name: 'Иванова Анна', is_blacklisted: false };
    if (/FROM records/.test(sql)) return { n: '0' };
    if (/FROM notification_jobs/.test(sql)) {
      const type = /'visit_review'/.test(sql) ? 'visit_review' : (/'first_visit'/.test(sql) ? 'first_visit' : null);
      return jobs.find((j) => j.phone === p[1] && j.trigger === type && ['pending', 'sent', 'shadow'].includes(j.status)) ? { hit: 1 } : null;
    }
    return null;
  });
  db.query.mockImplementation(async (sql, p) => {
    await tick();
    if (/INSERT INTO notification_record_state/.test(sql)) {
      states.set(p[1], { visit_datetime: p[2], attendance: p[4], deleted: p[5] });
      return { rowCount: 1, rows: [] };
    }
    if (/INSERT INTO notification_jobs/.test(sql)) {
      const key = keyOf(p);
      const row = { key, rule_id: p[1], trigger: p[2], record_id: p[4], visit: p[5], scheduled: p[6], text: p[8], status: p[9], phone: p[10], reason: p[13] };
      const cur = jobs.find((j) => j.key === key);
      if (!cur) { jobs.push(row); return { rowCount: 1, rows: [] }; }
      if (/DO UPDATE/.test(sql) && cur.status === 'cancelled') { Object.assign(cur, row); return { rowCount: 1, rows: [] }; }
      return { rowCount: 0, rows: [] };
    }
    if (/UPDATE notification_jobs SET status='cancelled'/.test(sql)) {
      let n = 0;
      for (const j of jobs) {
        if (j.record_id === p[1] && j.status === 'pending' && (!p[3] || p[3].includes(j.trigger))) { j.status = 'cancelled'; j.reason = p[2]; n += 1; }
      }
      return { rowCount: n, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  });
  return { jobs, states };
}
const jobOf = (jobs, trigger, visitIso) => jobs.find((j) => j.trigger === trigger && new Date(j.visit).getTime() === at(visitIso));

const flush = () => new Promise((resolve) => setImmediate(resolve));
const newLockClient = () => ({ query: jest.fn(async () => ({ rows: [{ unlocked: true }] })), release: jest.fn() });
let lockClient;
beforeEach(() => {
  jest.clearAllMocks();
  lockClient = newLockClient();
  pool.connect.mockReset();
  pool.connect.mockResolvedValue(lockClient);
  rulesMock.getServiceCategoryMap.mockReset();
  rulesMock.getServiceCategoryMap.mockImplementation(async () => new Map([['1', '10']]));
});

// ───────────────────────────── основа плана ─────────────────────────────

test('режим off → состояние пишется, job не создаётся', async () => {
  setup({ mode: 'off', rules: [rule()] });
  await enroll.handleRecordEvent(salon, payload(), NOW);
  expect(db.query.mock.calls.some(([sql]) => /INSERT INTO notification_record_state/.test(sql))).toBe(true);
  expect(inserts()).toHaveLength(0);
});

describe('режим', () => {
  test('shadow ставит job\'ы так же, как live (статус shadow присвоит воркер при обработке)', async () => {
    setup({ mode: 'shadow', rules: [rule()] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0][9]).toBe('pending');
  });

  // Режим — строка в БД (VARCHAR), и руками туда можно записать что угодно: 'Live' с большой буквы не
  // должен молча превращаться в боевой режим ни одним из двух способов (== 'off' или != 'off').
  test.each(['Live', 'LIVE', 'Shadow', 'on', 'enabled', '', null])('неизвестный режим %p → как off: состояние пишется, ничего не ставится и не гасится', async (mode) => {
    setup({ mode, rules: [rule(), rule({ id: 2, trigger_type: 'visit_reminder' })], prev: prevOf('2026-10-20T13:30:00+03:00') });
    await enroll.handleRecordEvent(salon, payload({ attendance: -1 }, 'update'), NOW);
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO notification_record_state/.test(sql))).toBe(true);
    expect(inserts()).toHaveLength(0);
    expect(cancels()).toHaveLength(0);
    expect(db.any).not.toHaveBeenCalled();
    expect(rulesMock.getServiceCategoryMap).not.toHaveBeenCalled();
  });

  test('режим не задан вовсе (поля нет в настройках) → как off', async () => {
    setup({ rules: [rule()] });
    settings.getSettings.mockResolvedValue({ quiet_from: null, quiet_to: null, default_channels: ['tdlib'] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts()).toHaveLength(0);
  });
});

test('create → record_created немедленно + visit_reminder за 24 ч', async () => {
  setup({ rules: [rule(), rule({ id: 2, trigger_type: 'visit_reminder' })] });
  await enroll.handleRecordEvent(salon, payload(), NOW);
  const rows = inserts();
  expect(rows).toHaveLength(2);
  const [created, reminder] = rows;
  expect(created[2]).toBe('record_created');
  expect(created[8]).toBe('Анна, вы записаны 20.10.2026 13:30');
  expect(reminder[2]).toBe('visit_reminder');
  expect(new Date(reminder[6]).getTime()).toBe(at('2026-10-19T13:30:00+03:00'));
});

test('условия правила не совпали → job нет', async () => {
  setup({ rules: [rule({ conditions: { logic: 'and', items: [{ type: 'staff', ids: [999] }] } })] });
  await enroll.handleRecordEvent(salon, payload(), NOW);
  expect(inserts()).toHaveLength(0);
});

test('запись, созданная Милой (интеграционный пользователь), получает «Вы записаны» как любая', async () => {
  setup({ rules: [rule()] });
  await enroll.handleRecordEvent(salon, payload({ created_user_id: 12017996 }), NOW);
  expect(inserts()[0][9]).toBe('pending');
});

test('тихие часы сдвигают опрос, но не «Вы записаны»', async () => {
  const prev = prevOf('2026-10-20T20:00:00+03:00');
  setup({ prev, quiet: ['21:00', '09:00'], rules: [rule({ id: 5, trigger_type: 'visit_review', delay_minutes: 5 })] });
  const late = at('2026-10-20T21:10:00+03:00');
  await enroll.handleRecordEvent(salon, payload({ datetime: '2026-10-20T20:00:00+03:00', attendance: 1 }, 'update'), late);
  expect(new Date(inserts()[0][6]).getTime()).toBe(at('2026-10-21T09:00:00+03:00'));
  jest.clearAllMocks();
  setup({ quiet: ['21:00', '09:00'], rules: [rule()] });
  const night = at('2026-10-20T23:30:00+03:00');
  // запись на завтра, сделанная ночью: «Вы записаны» уходит сразу, тихие часы её не откладывают
  await enroll.handleRecordEvent(salon, payload({ datetime: '2026-10-21T15:00:00+03:00' }), night);
  expect(new Date(inserts()[0][6]).getTime()).toBe(night);
});

test('чёрный список → skipped', async () => {
  setup({ rules: [rule()], client: { id: 9, name: 'X', is_blacklisted: true } });
  await enroll.handleRecordEvent(salon, payload(), NOW);
  expect(inserts()[0][9]).toBe('skipped');
  expect(inserts()[0][13]).toBe('клиент в чёрном списке');
});

test('нет телефона или мусор вместо него → skipped «нет телефона клиента»', async () => {
  for (const phone of ['', '+7']) {
    jest.clearAllMocks();
    pool.connect.mockResolvedValue(lockClient);
    setup({ rules: [rule()] });
    await enroll.handleRecordEvent(salon, payload({ client: { id: 7, phone, name: 'Анна' } }), NOW);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0][9]).toBe('skipped');
    expect(inserts()[0][13]).toBe('нет телефона клиента');
  }
});

test('перенос: гасит pending-напоминание записи и ставит новое + record_rescheduled', async () => {
  const prev = prevOf('2026-10-20T13:30:00+03:00');
  setup({ prev, rules: [rule({ id: 3, trigger_type: 'record_rescheduled' }), rule({ id: 2, trigger_type: 'visit_reminder' })] });
  await enroll.handleRecordEvent(salon, payload({ datetime: '2026-10-21T10:00:00+03:00' }, 'update'), NOW);
  expect(db.query.mock.calls.some(([sql, p]) => /SET status='cancelled'/.test(sql) && p.includes(100))).toBe(true);
  expect(inserts().map((p) => p[2]).sort()).toEqual(['record_rescheduled', 'visit_reminder']);
});

test('перенос гасит ТОЛЬКО напоминание: приглашение новому клиенту привязано к созданию записи, а не ко времени визита', async () => {
  setup({ prev: prevOf('2026-10-20T13:30:00+03:00'), rules: [rule({ id: 3, trigger_type: 'record_rescheduled' })] });
  await enroll.handleRecordEvent(salon, payload({ datetime: '2026-10-21T10:00:00+03:00' }, 'update'), NOW);
  expect(cancels()).toHaveLength(1);
  expect(cancels()[0][2]).toBe('запись перенесена');
  expect(cancels()[0][3]).toEqual(['visit_reminder']);
});

// ── отмена: уведомляет только «клиент не придёт» до начала визита (паритет с YClients/Chatpush) ──
// on_no_show = «слать, когда поставили «клиент не придёт» до начала визита; удаление записи не
// уведомляет — как YClients» (у Chatpush 0 писем «отменена» на 58 удалений).
describe('отмена записи', () => {
  const prev = prevOf('2026-10-20T13:30:00+03:00');
  const cancelRule = (over) => rule({ id: 4, trigger_type: 'record_cancelled', ...over });

  test('удаление записи (status delete) гасит pending, но письма «запись отменена» не шлёт', async () => {
    setup({ prev, rules: [cancelRule()] });
    await enroll.handleRecordEvent(salon, payload({}, 'delete'), NOW);
    expect(inserts()).toHaveLength(0);
    expect(cancels()).toHaveLength(1);
    expect(cancels()[0][1]).toBe(100);
    expect(cancels()[0][2]).toBe('запись отменена');
    expect(cancels()[0][3]).toBeNull();               // все типы, а не только напоминания
    jest.clearAllMocks();
    pool.connect.mockResolvedValue(lockClient);
    setup({ prev: { ...prev, deleted: true }, rules: [cancelRule()] });
    await enroll.handleRecordEvent(salon, payload({}, 'delete'), NOW);   // повтор вебхука
    expect(inserts()).toHaveLength(0);
    expect(cancels()).toHaveLength(0);
  });

  test('update с deleted:true — тоже удаление: тишина, pending гасятся', async () => {
    setup({ prev, rules: [cancelRule()] });
    await enroll.handleRecordEvent(salon, payload({ deleted: true }, 'update'), NOW);
    expect(inserts()).toHaveLength(0);
    expect(cancels()).toHaveLength(1);
  });

  test('«клиент не придёт» до начала визита → record_cancelled + гашение всех pending записи', async () => {
    setup({ prev, rules: [cancelRule()] });
    await enroll.handleRecordEvent(salon, payload({ attendance: -1 }, 'update'), NOW);
    expect(inserts().map((p) => p[2])).toEqual(['record_cancelled']);
    expect(cancels()).toHaveLength(1);
    expect(cancels()[0][3]).toBeNull();
    // уведомление ставится ПОСЛЕ гашения, иначе оно погасило бы само себя
    const order = db.query.mock.calls.map(([sql]) => (/UPDATE notification_jobs/.test(sql) ? 'cancel' : (/INSERT INTO notification_jobs/.test(sql) ? 'insert' : null))).filter(Boolean);
    expect(order).toEqual(['cancel', 'insert']);
    jest.clearAllMocks();
    pool.connect.mockResolvedValue(lockClient);
    setup({ prev: { ...prev, attendance: -1 }, rules: [cancelRule()] });
    await enroll.handleRecordEvent(salon, payload({ attendance: -1 }, 'update'), NOW);   // повтор
    expect(inserts()).toHaveLength(0);
  });

  test('«клиент не придёт» уже после начала визита → письма нет, pending гасятся', async () => {
    setup({ prev, rules: [cancelRule()] });
    await enroll.handleRecordEvent(salon, payload({ attendance: -1 }, 'update'), at('2026-10-20T13:31:00+03:00'));
    expect(inserts()).toHaveLength(0);
    expect(cancels()).toHaveLength(1);
  });

  test('«не пришёл» при on_no_show=false → без уведомления, но pending гасятся', async () => {
    setup({ prev, rules: [cancelRule({ on_no_show: false })] });
    await enroll.handleRecordEvent(salon, payload({ attendance: -1 }, 'update'), NOW);
    expect(inserts()).toHaveLength(0);
    expect(cancels()).toHaveLength(1);
  });

  test('on_no_show не задан (NULL в старых строках) → считается включённым', async () => {
    setup({ prev, rules: [cancelRule({ on_no_show: null })] });
    await enroll.handleRecordEvent(salon, payload({ attendance: -1 }, 'update'), NOW);
    expect(inserts().map((p) => p[2])).toEqual(['record_cancelled']);
  });
});

// ── (a) мгновенные письма только про будущий визит ──
describe('мгновенные письма не уходят задним числом и после начала визита', () => {
  const all = () => [rule({ id: 1 }), rule({ id: 3, trigger_type: 'record_rescheduled' }), rule({ id: 4, trigger_type: 'record_cancelled' }),
    rule({ id: 2, trigger_type: 'visit_reminder' })];

  test('запись создана задним числом (визит уже прошёл) → ни «Вы записаны», ни напоминания', async () => {
    setup({ rules: all() });
    await enroll.handleRecordEvent(salon, payload({ datetime: '2026-10-17T13:30:00+03:00' }), NOW);
    expect(inserts()).toHaveLength(0);
  });

  test('визит начинается ровно сейчас — это уже не «будущее»', async () => {
    setup({ rules: all() });
    await enroll.handleRecordEvent(salon, payload({ datetime: '2026-10-18T10:00:00+03:00' }), NOW);
    expect(inserts()).toHaveLength(0);
    jest.clearAllMocks();
    pool.connect.mockResolvedValue(lockClient);
    setup({ rules: all() });
    await enroll.handleRecordEvent(salon, payload({ datetime: '2026-10-18T10:00:01+03:00' }), NOW);
    expect(inserts().map((p) => p[2])).toEqual(['record_created']);   // напоминание за сутки уже не успеть
  });

  test('перенос на прошедшее время → «запись перенесена» не шлётся', async () => {
    setup({ prev: prevOf('2026-10-20T13:30:00+03:00'), rules: all() });
    await enroll.handleRecordEvent(salon, payload({ datetime: '2026-10-17T10:00:00+03:00' }, 'update'), NOW);
    expect(inserts()).toHaveLength(0);
  });

  test('«не придёт» отмечено, когда визит уже начался → письма нет', async () => {
    setup({ prev: prevOf('2026-10-18T09:00:00+03:00'), rules: all() });
    await enroll.handleRecordEvent(salon, payload({ datetime: '2026-10-18T09:00:00+03:00', attendance: -1 }, 'update'), NOW);
    expect(inserts()).toHaveLength(0);
  });

  test('момент визита не разобран → мгновенных писем нет', async () => {
    setup({ rules: all() });
    await enroll.handleRecordEvent(salon, payload({ datetime: undefined, date: undefined }), NOW);
    expect(inserts()).toHaveLength(0);
  });
});

// ── update опередил create ──
describe('update раньше create', () => {
  const A = '2026-10-25T12:00:00+03:00';
  const B = '2026-10-26T15:00:00+03:00';
  const stateWrites = () => db.query.mock.calls.filter(([sql]) => /INSERT INTO notification_record_state/.test(sql));

  test('к приходу create состояние уже сохранено → «Вы записаны» и напоминание всё равно ставятся', async () => {
    setup({ prev: prevOf(A), rules: [rule(), rule({ id: 2, trigger_type: 'visit_reminder' })] });
    await enroll.handleRecordEvent(salon, payload({ datetime: A }), NOW);
    expect(inserts().map((p) => p[2]).sort()).toEqual(['record_created', 'visit_reminder']);
    expect(cancels()).toHaveLength(0);
  });

  test('состояние при этом НЕ перезаписывается: create несёт данные момента создания, а не нынешние', async () => {
    setup({ prev: prevOf(A), rules: [rule()] });
    await enroll.handleRecordEvent(salon, payload({ datetime: A }), NOW);
    expect(stateWrites()).toHaveLength(0);
  });

  test('create без известного состояния сохраняет его как обычно', async () => {
    setup({ rules: [rule()] });
    await enroll.handleRecordEvent(salon, payload({ datetime: A }), NOW);
    expect(stateWrites()).toHaveLength(1);
  });

  test('дубль create не плодит строк: ключ (правило, запись, визит) тот же', async () => {
    const { jobs } = fakeTables([rule(), rule({ id: 2, trigger_type: 'visit_reminder' })]);
    await enroll.handleRecordEvent(salon, payload({ datetime: A }), NOW);
    await enroll.handleRecordEvent(salon, payload({ datetime: A }), NOW + 1000);
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.status === 'pending')).toBe(true);
  });

  test('create с иным временем, чем в уже известном состоянии, не порождает «перенесена» (create — не перенос)', async () => {
    setup({ prev: prevOf(A), rules: [rule({ id: 3, trigger_type: 'record_rescheduled' })] });
    await enroll.handleRecordEvent(salon, payload({ datetime: '2026-10-26T15:00:00+03:00' }), NOW);   // create с иным временем — не перенос
    expect(inserts()).toHaveLength(0);
  });

  // Поздний дубль create (состояние давно известно, запись жила своей жизнью) раньше «возвращал из отмены»,
  // гасил неушедшее письмо об отмене и переписывал состояние на «живая» — и staleReason воркера этого уже не ловил,
  // потому что сверяется как раз с состоянием.
  describe('поздний дубль create не портит то, что случилось с записью после создания', () => {
    const cancelRule = () => rule({ id: 4, trigger_type: 'record_cancelled' });

    test('запись отменена («не придёт»): состояние остаётся отменённым, письмо об отмене не гасится, restored не срабатывает', async () => {
      const { jobs, states } = fakeTables([rule(), rule({ id: 2, trigger_type: 'visit_reminder' }), cancelRule()]);
      await enroll.handleRecordEvent(salon, payload({ datetime: A }), NOW);                                           // создание
      await enroll.handleRecordEvent(salon, payload({ datetime: A, attendance: -1 }, 'update'), NOW + 3600e3);       // «не придёт» → письмо
      expect(jobOf(jobs, 'record_cancelled', A).status).toBe('pending');
      const before = JSON.stringify([...states.entries()]);
      db.query.mockClear();
      await enroll.handleRecordEvent(salon, payload({ datetime: A }), NOW + 3600e3 + 20 * 60e3);                    // поздний дубль create
      expect(JSON.stringify([...states.entries()])).toBe(before);
      expect(states.get(100).attendance).toBe(-1);
      expect(jobOf(jobs, 'record_cancelled', A).status).toBe('pending');                                              // письмо не погашено
      expect(cancels()).toHaveLength(0);                                                                              // ни одного гашения от дубля
    });

    test('запись удалена: то же — состояние «удалена», гашений нет', async () => {
      const { states } = fakeTables([rule(), cancelRule()]);
      await enroll.handleRecordEvent(salon, payload({ datetime: A }), NOW);
      await enroll.handleRecordEvent(salon, payload({ datetime: A, deleted: true }, 'delete'), NOW + 3600e3);
      db.query.mockClear();
      await enroll.handleRecordEvent(salon, payload({ datetime: A }), NOW + 7200e3);
      expect(states.get(100).deleted).toBe(true);
      expect(cancels()).toHaveLength(0);
      expect(db.query.mock.calls.some(([sql]) => /INSERT INTO notification_record_state/.test(sql))).toBe(false);
    });

    test('запись перенесена A→B: состояние остаётся на B, «перенесена» от дубля не рождается', async () => {
      const { jobs, states } = fakeTables([rule({ id: 3, trigger_type: 'record_rescheduled' }), rule({ id: 2, trigger_type: 'visit_reminder' })]);
      await enroll.handleRecordEvent(salon, payload({ datetime: A }), NOW);
      await enroll.handleRecordEvent(salon, payload({ datetime: B }, 'update'), NOW + 3600e3);
      expect(jobOf(jobs, 'record_rescheduled', B).status).toBe('pending');
      const lettersBefore = jobs.filter((j) => j.trigger === 'record_rescheduled').length;
      await enroll.handleRecordEvent(salon, payload({ datetime: A }), NOW + 7200e3);                                  // поздний дубль create(A)
      expect(new Date(states.get(100).visit_datetime).getTime()).toBe(at(B));
      expect(jobs.filter((j) => j.trigger === 'record_rescheduled')).toHaveLength(lettersBefore);
    });

    test('у дубля ничего не «приходит» и не «подтверждается» (старый снимок с attendance 1 / 2)', async () => {
      setup({ prev: prevOf(A), rules: [rule({ id: 5, trigger_type: 'visit_review' }), rule({ id: 6, trigger_type: 'visit_after' })] });
      await enroll.handleRecordEvent(salon, payload({ datetime: A, attendance: 1 }), at('2026-10-25T13:00:00+03:00'));
      expect(inserts()).toHaveLength(0);
    });

    test('дубль, несущий отмену, ничего не отменяет: состояние живо, гашений нет', async () => {
      setup({ prev: prevOf(A), rules: [cancelRule()] });
      await enroll.handleRecordEvent(salon, payload({ datetime: A, attendance: -1 }), NOW);
      expect(cancels()).toHaveLength(0);
      expect(inserts()).toHaveLength(0);
      expect(db.query.mock.calls.some(([sql]) => /INSERT INTO notification_record_state/.test(sql))).toBe(false);
    });

    test('«update раньше create» на уже отменённой записи: job\'ы ставятся, а гасит их воркер — по состоянию, которое осталось отменённым', async () => {
      setup({ prev: prevOf(A, { attendance: -1 }), rules: [rule(), rule({ id: 2, trigger_type: 'visit_reminder' })] });
      await enroll.handleRecordEvent(salon, payload({ datetime: A }), NOW);
      expect(inserts().map((p) => p[2]).sort()).toEqual(['record_created', 'visit_reminder']);
      expect(cancels()).toHaveLength(0);
      expect(db.query.mock.calls.some(([sql]) => /INSERT INTO notification_record_state/.test(sql))).toBe(false);
    });
  });
});

// ── (c) возврат из отмены и перенос туда-обратно оживляют напоминание ──
describe('напоминание после возврата из отмены и переноса A→B→A', () => {
  const A = '2026-10-25T12:00:00+03:00';
  const B = '2026-10-26T15:00:00+03:00';
  const reminder = () => rule({ id: 2, trigger_type: 'visit_reminder' });

  test('снятие «не придёт» без смены времени → напоминание ставится заново', async () => {
    setup({ prev: prevOf(A, { attendance: -1 }), rules: [reminder(), rule({ id: 3, trigger_type: 'record_rescheduled' })] });
    await enroll.handleRecordEvent(salon, payload({ datetime: A, attendance: 0 }, 'update'), NOW);
    expect(inserts().map((p) => p[2])).toEqual(['visit_reminder']);   // перенеса не было — «перенесена» не шлём
    expect(new Date(inserts()[0][6]).getTime()).toBe(at('2026-10-24T12:00:00+03:00'));
  });

  test('перенос + снятие «не придёт» одним update → record_rescheduled и ОДНО напоминание на новое время', async () => {
    setup({ prev: prevOf(A, { attendance: -1 }), rules: [reminder(), rule({ id: 3, trigger_type: 'record_rescheduled' })] });
    await enroll.handleRecordEvent(salon, payload({ datetime: B, attendance: 0 }, 'update'), NOW);
    expect(inserts().map((p) => p[2]).sort()).toEqual(['record_rescheduled', 'visit_reminder']);
    expect(new Date(inserts().find((p) => p[2] === 'visit_reminder')[6]).getTime()).toBe(at('2026-10-25T15:00:00+03:00'));
  });

  test('перенос записи, которая остаётся отменённой, ничего не ставит', async () => {
    setup({ prev: prevOf(A, { attendance: -1 }), rules: [reminder(), rule({ id: 3, trigger_type: 'record_rescheduled' })] });
    await enroll.handleRecordEvent(salon, payload({ datetime: B, attendance: -1 }, 'update'), NOW);
    expect(inserts()).toHaveLength(0);
  });

  test('insertJob оживляет погашенную строку того же ключа: только cancelled, со сбросом аренды и следов отправки', async () => {
    setup({ rules: [reminder()] });
    await enroll.handleRecordEvent(salon, payload({ datetime: A }), NOW);
    const sql = db.query.mock.calls.find(([s]) => /INSERT INTO notification_jobs/.test(s))[0];
    expect(sql).toMatch(/ON CONFLICT \(rule_id, yclients_record_id, COALESCE\(visit_datetime, 'epoch'::timestamptz\)\)\s+DO UPDATE SET/);
    const flat = sql.replace(/\s+/g, '');
    for (const col of ['status=EXCLUDED.status', 'scheduled_at=EXCLUDED.scheduled_at', 'rendered_text=EXCLUDED.rendered_text',
      'meta=EXCLUDED.meta', 'decision_reason=EXCLUDED.decision_reason', 'phone=EXCLUDED.phone', 'attempts=0', 'error=NULL',
      'last_attempt_at=NULL', 'created_at=NOW()',
      // следы прошлой отправки/сверки: оживший job не должен выглядеть отправленным или сверенным
      'sent_at=NULL', 'channel_used=NULL', 'delivery_id=NULL', 'account_id=NULL', 'check_at=NULL', 'confirmed_at=NULL']) {
      expect(flat).toContain(col);
    }
    expect(sql).toMatch(/WHERE notification_jobs\.status\s*=\s*'cancelled'/);
  });

  test('перенос A→B→A: напоминание на A оживает, на B гасится, оба «перенесена» уходят', async () => {
    const { jobs } = fakeTables([reminder(), rule({ id: 3, trigger_type: 'record_rescheduled' })]);
    await enroll.handleRecordEvent(salon, payload({ datetime: A }), NOW);
    await enroll.handleRecordEvent(salon, payload({ datetime: B }, 'update'), NOW + 3600e3);
    await enroll.handleRecordEvent(salon, payload({ datetime: A }, 'update'), NOW + 3600e3 + 300e3);
    expect(jobOf(jobs, 'visit_reminder', B).status).toBe('cancelled');
    const onA = jobOf(jobs, 'visit_reminder', A);
    expect(onA.status).toBe('pending');
    expect(new Date(onA.scheduled).getTime()).toBe(at('2026-10-24T12:00:00+03:00'));
    expect(onA.reason).toBeNull();
    expect(jobOf(jobs, 'record_rescheduled', B).status).toBe('pending');
    expect(jobOf(jobs, 'record_rescheduled', A).status).toBe('pending');
    expect(jobs).toHaveLength(4);
  });

  test('уже отправленное напоминание не оживает и не дублируется', async () => {
    const { jobs } = fakeTables([reminder()]);
    await enroll.handleRecordEvent(salon, payload({ datetime: A }), NOW);
    jobs[0].status = 'sent';                                          // воркер отправил
    await enroll.handleRecordEvent(salon, payload({ datetime: A, attendance: -1 }, 'update'), NOW + 3600e3);   // «не придёт»
    await enroll.handleRecordEvent(salon, payload({ datetime: A, attendance: 0 }, 'update'), NOW + 7200e3);    // вернули
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('sent');
  });

  // «Не придёт» и возврат через пять секунд: письмо «запись отменена» ещё в очереди, а запись снова живая.
  describe('письмо об отмене не должно уйти после возврата записи', () => {
    const letters = () => rule({ id: 4, trigger_type: 'record_cancelled' });

    test('restored гасит pending record_cancelled (и только его)', async () => {
      setup({ prev: prevOf(A, { attendance: -1 }), rules: [letters(), reminder()] });
      await enroll.handleRecordEvent(salon, payload({ datetime: A, attendance: 0 }, 'update'), NOW);
      expect(cancels()).toHaveLength(1);
      expect(cancels()[0]).toEqual([1, 100, 'запись восстановлена', ['record_cancelled']]);
      // гашение — до постановки нового напоминания
      const order = db.query.mock.calls.map(([sql]) => (/UPDATE notification_jobs/.test(sql) ? 'cancel' : (/INSERT INTO notification_jobs/.test(sql) ? 'insert' : null))).filter(Boolean);
      expect(order).toEqual(['cancel', 'insert']);
    });

    test('не restored — не гасит: обычный update, создание, перенос', async () => {
      setup({ prev: prevOf(A), rules: [letters()] });
      await enroll.handleRecordEvent(salon, payload({ datetime: A, attendance: 2 }, 'update'), NOW);
      expect(cancels()).toHaveLength(0);
    });

    test('сценарий целиком: «не придёт» → письмо в очереди → возврат → письмо погашено, напоминание живо; повторное «не придёт» письмо оживляет', async () => {
      const { jobs } = fakeTables([letters(), reminder()]);
      await enroll.handleRecordEvent(salon, payload({ datetime: A }), NOW);                                              // создание → напоминание
      await enroll.handleRecordEvent(salon, payload({ datetime: A, attendance: -1 }, 'update'), NOW + 3600e3);          // «не придёт»
      expect(jobOf(jobs, 'record_cancelled', A).status).toBe('pending');
      expect(jobOf(jobs, 'visit_reminder', A).status).toBe('cancelled');
      await enroll.handleRecordEvent(salon, payload({ datetime: A, attendance: 0 }, 'update'), NOW + 3600e3 + 5000);    // возврат через 5 с
      expect(jobOf(jobs, 'record_cancelled', A).status).toBe('cancelled');
      expect(jobOf(jobs, 'record_cancelled', A).reason).toBe('запись восстановлена');
      expect(jobOf(jobs, 'visit_reminder', A).status).toBe('pending');
      await enroll.handleRecordEvent(salon, payload({ datetime: A, attendance: -1 }, 'update'), NOW + 7200e3);          // снова «не придёт»
      expect(jobOf(jobs, 'record_cancelled', A).status).toBe('pending');                                                // оживлено, а не потеряно
      expect(jobs.filter((j) => j.trigger === 'record_cancelled')).toHaveLength(1);
    });
  });
});

// ── (d) опрос после визита — не чаще раза в 30 дней на телефон ──
describe('visit_review: не чаще раза в 30 дней на телефон', () => {
  const prev = prevOf('2026-10-20T13:30:00+03:00');
  const later = at('2026-10-20T13:40:00+03:00');
  const review = (over) => rule({ id: 5, trigger_type: 'visit_review', delay_minutes: 5, ...over });

  test('по телефону уже есть опрос за 30 дней → строка skipped с причиной', async () => {
    setup({ prev, rules: [review()], recentReview: true });
    await enroll.handleRecordEvent(salon, payload({ attendance: 1 }, 'update'), later);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0][2]).toBe('visit_review');
    expect(inserts()[0][9]).toBe('skipped');
    expect(inserts()[0][13]).toBe('опрос уже был за 30 дней');
  });

  test('запрос смотрит pending/sent/shadow по салону и телефону за последние 30 дней', async () => {
    setup({ prev, rules: [review()] });
    await enroll.handleRecordEvent(salon, payload({ attendance: 1 }, 'update'), later);
    const [call] = jobQueries(/'visit_review'/);
    expect(call).toBeTruthy();
    const norm = call[0].replace(/\s+/g, ' ');
    expect(norm).toMatch(/trigger_type = 'visit_review'/);
    expect(norm).toMatch(/status IN \('pending', ?'sent', ?'shadow'\)/);
    expect(norm).toMatch(/created_at > NOW\(\) - INTERVAL '30 days'/);
    expect(call[1]).toEqual([1, '79200255591']);
  });

  test('опроса за 30 дней не было → обычная pending-строка', async () => {
    setup({ prev, rules: [review()] });
    await enroll.handleRecordEvent(salon, payload({ attendance: 1 }, 'update'), later);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0][9]).toBe('pending');
    expect(inserts()[0][13]).toBeNull();
  });

  test('чёрный список главнее: причина «в чёрном списке», запрос по опросам не нужен', async () => {
    setup({ prev, rules: [review()], recentReview: true, client: { id: 9, name: 'X', is_blacklisted: true } });
    await enroll.handleRecordEvent(salon, payload({ attendance: 1 }, 'update'), later);
    expect(inserts()[0][13]).toBe('клиент в чёрном списке');
    expect(jobQueries(/'visit_review'/)).toHaveLength(0);
  });

  test('проверка касается только visit_review: «рекомендации» идут как обычно', async () => {
    setup({ prev, recentReview: true, rules: [rule({ id: 6, trigger_type: 'visit_after', delay_minutes: 7 })] });
    await enroll.handleRecordEvent(salon, payload({ attendance: 1 }, 'update'), later);
    expect(inserts().map((p) => [p[2], p[9]])).toEqual([['visit_after', 'pending']]);
  });
});

// ── свежесть визита для опроса и рекомендаций ──
// Задним числом внесённое «пришёл» (администратор разбирает вчерашнее или прошлонедельное) опроса не
// порождает: на retro-«пришёл» Chatpush не отвечал ни разу, а клиенту через сутки «Спасибо, что посетили»
// выглядит странно. Граница — 12 часов после КОНЦА визита (начало + длительность).
describe('опрос и рекомендации — только про свежий визит', () => {
  const START = '2026-10-20T13:30:00+03:00';
  const END = at('2026-10-20T14:30:00+03:00');            // seance_length 3600
  const STALE = 'визит завершился более 12 ч назад (внесён задним числом)';
  const both = () => [rule({ id: 5, trigger_type: 'visit_review', delay_minutes: 5 }), rule({ id: 6, trigger_type: 'visit_after', delay_minutes: 7 })];
  const arrive = async (now, rules = both(), over = {}, setupOver = {}) => {
    setup({ prev: prevOf(START), rules, ...setupOver });
    await enroll.handleRecordEvent(salon, payload({ attendance: 1, ...over }, 'update'), now);
    return inserts();
  };

  test('«пришёл» во время визита и в пределах 12 ч после его конца → обычные pending', async () => {
    for (const now of [at('2026-10-20T13:40:00+03:00'), END, END + 6 * H]) {
      jest.clearAllMocks(); pool.connect.mockResolvedValue(lockClient);
      const rows = await arrive(now);
      expect(rows.map((p) => [p[2], p[9]]).sort()).toEqual([['visit_after', 'pending'], ['visit_review', 'pending']]);
    }
  });

  test('граница включительно: ровно 12 ч после конца ещё свежий, на миллисекунду позже — уже нет', async () => {
    let rows = await arrive(END + enroll.AFTER_VISIT_MAX_AGE_MS);
    expect(rows.map((p) => p[9])).toEqual(['pending', 'pending']);
    jest.clearAllMocks(); pool.connect.mockResolvedValue(lockClient);
    rows = await arrive(END + enroll.AFTER_VISIT_MAX_AGE_MS + 1);
    expect(rows.map((p) => [p[2], p[9], p[13]]).sort()).toEqual([['visit_after', 'skipped', STALE], ['visit_review', 'skipped', STALE]]);
    expect(enroll.AFTER_VISIT_MAX_AGE_MS).toBe(12 * H);
  });

  test('внесено через несколько суток → skipped с причиной у обоих типов', async () => {
    const rows = await arrive(at('2026-10-24T11:00:00+03:00'));
    expect(rows).toHaveLength(2);
    for (const p of rows) { expect(p[9]).toBe('skipped'); expect(p[13]).toBe(STALE); }
  });

  test('конец визита считается с длительностью: длинный сеанс остаётся свежим дольше', async () => {
    // начало 13:30, 3 часа → конец 16:30; 12 ч после — 04:30 следующих суток
    const ok = await arrive(at('2026-10-21T04:30:00+03:00'), both(), { seance_length: 10800 });
    expect(ok.map((p) => p[9])).toEqual(['pending', 'pending']);
    jest.clearAllMocks(); pool.connect.mockResolvedValue(lockClient);
    const stale = await arrive(at('2026-10-21T04:31:00+03:00'), both(), { seance_length: 10800 });
    expect(stale.map((p) => p[9])).toEqual(['skipped', 'skipped']);
  });

  test('для устаревшего визита запрос «опрос уже был» не делается (причина известна без БД)', async () => {
    await arrive(at('2026-10-24T11:00:00+03:00'), [rule({ id: 5, trigger_type: 'visit_review' })]);
    expect(jobQueries(/'visit_review'/)).toHaveLength(0);
  });

  test('чёрный список и отсутствие телефона главнее причины «задним числом»', async () => {
    const rows = await arrive(at('2026-10-24T11:00:00+03:00'), both(), {}, { client: { id: 9, name: 'X', is_blacklisted: true } });
    expect(rows.map((p) => p[13])).toEqual(['клиент в чёрном списке', 'клиент в чёрном списке']);
  });

  test('момент визита не разобран → свежесть не проверить, ставим как раньше (fail-open)', async () => {
    const rows = await arrive(NOW, both(), { datetime: undefined, date: undefined }, { prev: prevOf('2026-10-20T13:30:00+03:00') });
    expect(rows.map((p) => p[9])).toEqual(['pending', 'pending']);
  });

  test('свежесть касается только «после визита»: мгновенные письма и напоминание живут по своим правилам', async () => {
    setup({ rules: [rule(), rule({ id: 2, trigger_type: 'visit_reminder' })] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts().map((p) => p[2])).toEqual(['record_created', 'visit_reminder']);
  });
});

// ── first_visit: приглашение в лояльность при СОЗДАНИИ записи клиенту без визитов ──
// Данные (ревью T3–T5, реальные вебхуки и отправки Chatpush): приглашение уходит через секунды после create
// клиенту без прошлых визитов (85 из 92 за 2 минуты) и не уходит клиентам с визитами (0 из 776). Привязка к
// «пришёл» (прежний план) опаздывала бы на часы и дни и не доходила бы до тех, кто так и не пришёл.
describe('first_visit: приглашение при записи клиенту без визитов', () => {
  const invite = (over) => rule({ id: 8, trigger_type: 'first_visit', ...over });

  test('новая запись клиента без состоявшихся визитов → приглашение сразу', async () => {
    setup({ rules: [invite()] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0][2]).toBe('first_visit');
    expect(inserts()[0][9]).toBe('pending');
    expect(inserts()[0][13]).toBeNull();
    expect(new Date(inserts()[0][6]).getTime()).toBe(NOW);
  });

  test('это промо, а не транзакционное письмо: ночью откладывается до конца тихих часов', async () => {
    const night = at('2026-10-20T23:30:00+03:00');
    setup({ rules: [invite()], quiet: ['21:00', '09:00'] });
    await enroll.handleRecordEvent(salon, payload({ datetime: '2026-10-22T12:00:00+03:00' }), night);
    expect(new Date(inserts()[0][6]).getTime()).toBe(at('2026-10-21T09:00:00+03:00'));
    jest.clearAllMocks(); pool.connect.mockResolvedValue(lockClient);
    setup({ rules: [invite()], quiet: ['21:00', '09:00'] });
    await enroll.handleRecordEvent(salon, payload({ datetime: '2026-10-22T12:00:00+03:00' }), at('2026-10-20T14:00:00+03:00'));
    expect(new Date(inserts()[0][6]).getTime()).toBe(at('2026-10-20T14:00:00+03:00'));   // днём — сразу
  });

  test('клиент с состоявшимися визитами приглашения не получает — строки нет вовсе', async () => {
    setup({ rules: [invite()], priorVisits: 2 });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts()).toHaveLength(0);
    expect(jobQueries(/'first_visit'/)).toHaveLength(0);          // до проверки «уже приглашали» дело не доходит
  });

  test('прошлые визиты — arrived/completed клиента YClients, саму запись исключаем', async () => {
    setup({ rules: [invite()] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    const call = db.oneOrNone.mock.calls.find(([sql]) => /FROM records/.test(sql));
    const norm = call[0].replace(/\s+/g, ' ');
    expect(norm).toMatch(/yclients_client_id = \$2/);
    expect(norm).toMatch(/status IN \('arrived', ?'completed'\)/);
    expect(norm).toMatch(/yclients_record_id <> \$3/);
    expect(call[1]).toEqual([1, 7, 100]);
  });

  test('не чаще раза на телефон: приглашение уже было → skipped «приглашение уже отправлялось»', async () => {
    setup({ rules: [invite()], recentInvite: true });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0][9]).toBe('skipped');
    expect(inserts()[0][13]).toBe('приглашение уже отправлялось');
  });

  test('«уже приглашали» ищется среди pending/sent/shadow по салону и телефону, без срока давности', async () => {
    setup({ rules: [invite()] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    const [call] = jobQueries(/'first_visit'/);
    const norm = call[0].replace(/\s+/g, ' ');
    expect(norm).toMatch(/trigger_type = 'first_visit'/);
    expect(norm).toMatch(/status IN \('pending', ?'sent', ?'shadow'\)/);
    expect(norm).not.toMatch(/INTERVAL/);
    expect(call[1]).toEqual([1, '79200255591']);
  });

  test('на «пришёл» приглашение больше не ставится', async () => {
    setup({ prev: prevOf('2026-10-20T13:30:00+03:00'), rules: [invite()] });
    await enroll.handleRecordEvent(salon, payload({ attendance: 1 }, 'update'), at('2026-10-20T13:40:00+03:00'));
    expect(inserts()).toHaveLength(0);
    expect(db.oneOrNone.mock.calls.some(([sql]) => /FROM records/.test(sql))).toBe(false);
  });

  test('запись задним числом (визит уже начался) → приглашения нет', async () => {
    setup({ rules: [invite()] });
    await enroll.handleRecordEvent(salon, payload({ datetime: '2026-10-17T13:30:00+03:00' }), NOW);
    expect(inserts()).toHaveLength(0);
  });

  test('чёрный список и отсутствие телефона → skipped (но клиенту с визитами строки нет даже тогда)', async () => {
    setup({ rules: [invite()], client: { id: 9, name: 'X', is_blacklisted: true } });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts().map((p) => [p[9], p[13]])).toEqual([['skipped', 'клиент в чёрном списке']]);
    jest.clearAllMocks(); pool.connect.mockResolvedValue(lockClient);
    setup({ rules: [invite()], client: { id: 9, name: 'X', is_blacklisted: true }, priorVisits: 3 });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts()).toHaveLength(0);
    jest.clearAllMocks(); pool.connect.mockResolvedValue(lockClient);
    setup({ rules: [invite()] });
    await enroll.handleRecordEvent(salon, payload({ client: { id: 7, phone: '', name: 'Анна' } }), NOW);
    expect(inserts().map((p) => [p[9], p[13]])).toEqual([['skipped', 'нет телефона клиента']]);
  });

  test('без id клиента YClients прошлых визитов не узнать: приглашение ставится, повторы ограничит «раз на телефон»', async () => {
    setup({ rules: [invite()], priorVisits: 5 });
    await enroll.handleRecordEvent(salon, payload({ client: { phone: '79200255591', name: 'Анна' } }), NOW);
    expect(inserts().map((p) => p[2])).toEqual(['first_visit']);
    expect(db.oneOrNone.mock.calls.some(([sql]) => /FROM records/.test(sql))).toBe(false);
  });

  test('условия правила (мастер/категория) работают как у других типов', async () => {
    setup({ rules: [invite({ conditions: { logic: 'and', items: [{ type: 'staff', ids: [999] }] } })] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts()).toHaveLength(0);
  });

  test('перенос записи приглашение не гасит, отмена — гасит', async () => {
    const A = '2026-10-25T12:00:00+03:00';
    const { jobs } = fakeTables([invite(), rule({ id: 3, trigger_type: 'record_rescheduled' })], { quiet: ['21:00', '09:00'] });
    await enroll.handleRecordEvent(salon, payload({ datetime: A }), at('2026-10-20T23:30:00+03:00'));              // ночью: приглашение ждёт 09:00
    expect(jobs.find((j) => j.trigger === 'first_visit').status).toBe('pending');
    await enroll.handleRecordEvent(salon, payload({ datetime: '2026-10-26T15:00:00+03:00' }, 'update'), at('2026-10-21T08:00:00+03:00'));
    expect(jobs.find((j) => j.trigger === 'first_visit').status).toBe('pending');
    await enroll.handleRecordEvent(salon, payload({ datetime: '2026-10-26T15:00:00+03:00', attendance: -1 }, 'update'), at('2026-10-21T08:30:00+03:00'));
    expect(jobs.find((j) => j.trigger === 'first_visit').status).toBe('cancelled');
  });

  test('две записи нового клиента подряд → приглашение одно (вторая строка skipped)', async () => {
    const { jobs } = fakeTables([invite()]);
    await enroll.handleRecordEvent(salon, payload({ id: 101 }), NOW);
    await enroll.handleRecordEvent(salon, payload({ id: 102, datetime: '2026-10-21T12:00:00+03:00' }), NOW + 1000);
    expect(jobs.map((j) => [j.record_id, j.status])).toEqual([[101, 'pending'], [102, 'skipped']]);
    expect(jobs[1].reason).toBe('приглашение уже отправлялось');
  });
});

// ── каталог услуг YClients недоступен ──
describe('условие по категории при недоступном каталоге', () => {
  const CATALOG = 'каталог услуг YClients недоступен';
  const catRule = (over) => rule({ id: 1, conditions: { logic: 'and', items: [{ type: 'category', ids: [10] }] }, ...over });

  test('пустой каталог (сбой ycGet) + условие по категории → skipped с причиной, а не молчаливое «не подошло»', async () => {
    rulesMock.getServiceCategoryMap.mockImplementation(async () => new Map());
    setup({ rules: [catRule()] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0][9]).toBe('skipped');
    expect(inserts()[0][13]).toBe(CATALOG);
  });

  test('getServiceCategoryMap бросил → то же самое', async () => {
    rulesMock.getServiceCategoryMap.mockImplementation(async () => { throw new Error('YClients 429'); });
    setup({ rules: [catRule()] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts().map((p) => [p[9], p[13]])).toEqual([['skipped', CATALOG]]);
  });

  test('это не зависит от типа правила: напоминание и опрос тоже получают строку с причиной', async () => {
    rulesMock.getServiceCategoryMap.mockImplementation(async () => new Map());
    setup({ rules: [catRule({ id: 2, trigger_type: 'visit_reminder' })] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts().map((p) => [p[2], p[9], p[13]])).toEqual([['visit_reminder', 'skipped', CATALOG]]);
    jest.clearAllMocks(); pool.connect.mockResolvedValue(lockClient);
    setup({ prev: prevOf('2026-10-20T13:30:00+03:00'), rules: [catRule({ id: 5, trigger_type: 'visit_review' })] });
    await enroll.handleRecordEvent(salon, payload({ attendance: 1 }, 'update'), at('2026-10-20T13:40:00+03:00'));
    expect(inserts().map((p) => [p[2], p[9], p[13]])).toEqual([['visit_review', 'skipped', CATALOG]]);
  });

  test('правила без условия по категории каталог не трогает', async () => {
    rulesMock.getServiceCategoryMap.mockImplementation(async () => new Map());
    setup({ rules: [rule({ id: 1, conditions: { logic: 'and', items: [{ type: 'staff', ids: [55] }] } }), rule({ id: 2, conditions: { logic: 'and', items: [] } })] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts().map((p) => p[9])).toEqual(['pending', 'pending']);
  });

  test('честное несовпадение при живом каталоге → строки нет', async () => {
    setup({ rules: [catRule({ conditions: { logic: 'and', items: [{ type: 'category', ids: [99] }] } })] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts()).toHaveLength(0);
  });

  test('живой каталог, но услуги записи в нём нет → это несовпадение, а не сбой', async () => {
    rulesMock.getServiceCategoryMap.mockImplementation(async () => new Map([['777', '10']]));
    setup({ rules: [catRule()] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts()).toHaveLength(0);
  });

  test('«или»: истинное условие по мастеру побеждает недоступный каталог — обычная pending-строка', async () => {
    rulesMock.getServiceCategoryMap.mockImplementation(async () => new Map());
    setup({ rules: [rule({ conditions: { logic: 'or', items: [{ type: 'staff', ids: [55] }, { type: 'category', ids: [10] }] } })] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts().map((p) => [p[9], p[13]])).toEqual([['pending', null]]);
  });

  test('«и»: ложное условие по мастеру даёт «не подошло» независимо от каталога — строки нет', async () => {
    rulesMock.getServiceCategoryMap.mockImplementation(async () => new Map());
    setup({ rules: [rule({ conditions: { logic: 'and', items: [{ type: 'staff', ids: [999] }, { type: 'category', ids: [10] }] } })] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts()).toHaveLength(0);
  });

  test('«или»: ложное по мастеру + категория при недоступном каталоге — исход неизвестен → skipped', async () => {
    rulesMock.getServiceCategoryMap.mockImplementation(async () => new Map());
    setup({ rules: [rule({ conditions: { logic: 'or', items: [{ type: 'staff', ids: [999] }, { type: 'category', ids: [10] }] } })] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts().map((p) => [p[9], p[13]])).toEqual([['skipped', CATALOG]]);
  });

  test('условие по категории без id ничего не ограничивает и на каталог не опирается', async () => {
    rulesMock.getServiceCategoryMap.mockImplementation(async () => new Map());
    setup({ rules: [rule({ conditions: { logic: 'and', items: [{ type: 'category', ids: [] }] } })] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts().map((p) => p[9])).toEqual(['pending']);
  });

  test('чёрный список главнее причины про каталог', async () => {
    rulesMock.getServiceCategoryMap.mockImplementation(async () => new Map());
    setup({ rules: [catRule()], client: { id: 9, name: 'X', is_blacklisted: true } });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(inserts().map((p) => p[13])).toEqual(['клиент в чёрном списке']);
  });
});

test('пришёл → visit_review через delay от конца визита, visit_after по условиям', async () => {
  const prev = prevOf('2026-10-20T13:30:00+03:00');
  const later = at('2026-10-20T13:40:00+03:00');
  setup({ prev, rules: [
    rule({ id: 5, trigger_type: 'visit_review', delay_minutes: 5 }),
    rule({ id: 6, trigger_type: 'visit_after', delay_minutes: 7, attachment_url: '/uploads/a.jpg', conditions: { logic: 'and', items: [{ type: 'category', ids: [10] }] } }),
    rule({ id: 7, trigger_type: 'visit_after', delay_minutes: 7, conditions: { logic: 'and', items: [{ type: 'category', ids: [99] }] } }),
  ] });
  await enroll.handleRecordEvent(salon, payload({ attendance: 1 }, 'update'), later);
  const rows = inserts();
  expect(rows.map((p) => p[2]).sort()).toEqual(['visit_after', 'visit_review']);
  const review = rows.find((p) => p[2] === 'visit_review');
  expect(new Date(review[6]).getTime()).toBe(at('2026-10-20T14:35:00+03:00'));
  const after = rows.find((p) => p[2] === 'visit_after');
  expect(after[11]).toBe('/uploads/a.jpg');
});

test('delay_minutes=0 — законное значение (0..1440): опрос сразу по окончании визита, а не через 5 минут', async () => {
  const prev = prevOf('2026-10-20T13:30:00+03:00');
  setup({ prev, rules: [rule({ id: 5, trigger_type: 'visit_review', delay_minutes: 0 }), rule({ id: 6, trigger_type: 'visit_after', delay_minutes: 0 })] });
  await enroll.handleRecordEvent(salon, payload({ attendance: 1 }, 'update'), at('2026-10-20T13:40:00+03:00'));
  for (const row of inserts()) expect(new Date(row[6]).getTime()).toBe(at('2026-10-20T14:30:00+03:00'));
  jest.clearAllMocks();
  pool.connect.mockResolvedValue(lockClient);
  setup({ prev, rules: [rule({ id: 5, trigger_type: 'visit_review', delay_minutes: null }), rule({ id: 6, trigger_type: 'visit_after', delay_minutes: null })] });
  await enroll.handleRecordEvent(salon, payload({ attendance: 1 }, 'update'), at('2026-10-20T13:40:00+03:00'));
  const byType = Object.fromEntries(inserts().map((p) => [p[2], new Date(p[6]).getTime()]));
  expect(byType).toEqual({ visit_review: at('2026-10-20T14:35:00+03:00'), visit_after: at('2026-10-20T14:37:00+03:00') });   // не задано → 5 и 7
});

test('сбой одного правила не мешает остальным правилам того же события', async () => {
  setup({ rules: [rule({ id: 1 }), rule({ id: 2, trigger_type: 'visit_reminder' })] });
  let first = true;
  db.query.mockImplementation(async (sql) => {
    if (/INSERT INTO notification_jobs/.test(sql) && first) { first = false; throw new Error('db down'); }
    return { rowCount: 1, rows: [] };
  });
  await expect(enroll.handleRecordEvent(salon, payload(), NOW)).resolves.toBeUndefined();
  expect(db.query.mock.calls.filter(([sql]) => /INSERT INTO notification_jobs/.test(sql))).toHaveLength(2);
});

test('событие без id записи игнорируется целиком (и блокировку не берёт)', async () => {
  setup({ rules: [rule()] });
  await enroll.handleRecordEvent(salon, { status: 'create', data: {} }, NOW);
  expect(db.query).not.toHaveBeenCalled();
  expect(pool.connect).not.toHaveBeenCalled();
});

// ── каталог услуг YClients: только по нужде ──
// Каталог — внешний HTTP (30 с, сбой не кэшируется) под общим лимитом YClients. В режиме off («только состояние»)
// и без правил с условием по категории он не нужен вовсе.
describe('каталог услуг YClients запрашивается только по нужде', () => {
  const catRule = (over) => rule({ conditions: { logic: 'and', items: [{ type: 'category', ids: [10] }] }, ...over });

  test('режим off — ни одного вызова каталога, даже когда правило с категорией есть, а услуги у записи есть', async () => {
    setup({ mode: 'off', rules: [catRule()] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(rulesMock.getServiceCategoryMap).not.toHaveBeenCalled();
    expect(db.any).not.toHaveBeenCalled();                                // и правила в этом режиме не читаются
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO notification_record_state/.test(sql))).toBe(true);   // состояние пишется
  });

  test.each(['Live', 'on', '', null])('неизвестный режим %p — тоже ни одного вызова каталога', async (mode) => {
    setup({ mode, rules: [catRule()] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(rulesMock.getServiceCategoryMap).not.toHaveBeenCalled();
  });

  test.each(['live', 'shadow'])('режим %s и правило с условием по категории → каталог запрашивается ОДИН раз на событие', async (mode) => {
    setup({ mode, rules: [catRule({ id: 1 }), catRule({ id: 2, trigger_type: 'visit_reminder' })] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(rulesMock.getServiceCategoryMap).toHaveBeenCalledTimes(1);
    expect(inserts()).toHaveLength(2);
  });

  test('среди включённых правил нет условия по категории → каталог не нужен (мастер, услуга, пустые условия)', async () => {
    setup({ rules: [
      rule({ id: 1 }),
      rule({ id: 2, conditions: { logic: 'and', items: [{ type: 'staff', ids: [55] }] } }),
      rule({ id: 3, conditions: { logic: 'or', items: [{ type: 'service', ids: [1] }] } }),
    ] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(rulesMock.getServiceCategoryMap).not.toHaveBeenCalled();
    expect(inserts()).toHaveLength(3);
  });

  test('условие по категории без id категорией не считается — каталог не нужен', async () => {
    setup({ rules: [rule({ conditions: { logic: 'and', items: [{ type: 'category', ids: [] }] } })] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(rulesMock.getServiceCategoryMap).not.toHaveBeenCalled();
    expect(inserts()).toHaveLength(1);
  });

  test('правил нет вовсе → каталога нет', async () => {
    setup({ rules: [] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(rulesMock.getServiceCategoryMap).not.toHaveBeenCalled();
  });

  test('правило с категорией есть, но у записи нет услуг → каталог не нужен', async () => {
    setup({ rules: [catRule()] });
    await enroll.handleRecordEvent(salon, payload({ services: [] }), NOW);
    expect(rulesMock.getServiceCategoryMap).not.toHaveBeenCalled();
  });

  test('запрос каталога идёт ДО замка: внешний HTTP (таймаут 30 с) не держит соединение пула', async () => {
    setup({ rules: [catRule()] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(rulesMock.getServiceCategoryMap).toHaveBeenCalledTimes(1);
    expect(rulesMock.getServiceCategoryMap.mock.invocationCallOrder[0]).toBeLessThan(pool.connect.mock.invocationCallOrder[0]);
    expect(rulesMock.getServiceCategoryMap.mock.invocationCallOrder[0]).toBeLessThan(lockClient.query.mock.invocationCallOrder[0]);
  });
});

// ── блокировка по клиенту ──
// YClients отмечает «пришёл» по всем записям визита за миллисекунды. Без сериализации два вебхука одного клиента
// одновременно проходят проверки «опрос/приглашение уже были» (оба видят пусто) и оба ставят строку.
describe('блокировка по клиенту (advisory lock)', () => {
  const LOCK = /pg_advisory_lock\(\$1, hashtext\(\$2\)\)/;
  const UNLOCK = /pg_advisory_unlock\(\$1, hashtext\(\$2\)\)/;
  const SET_TIMEOUT = "SET lock_timeout = '15s'";
  const RESET_TIMEOUT = 'RESET lock_timeout';
  const kind = (sql) => {
    if (LOCK.test(sql)) return 'lock';
    if (UNLOCK.test(sql)) return 'unlock';
    if (sql === SET_TIMEOUT) return 'set';
    return sql === RESET_TIMEOUT ? 'reset' : '?';
  };
  const lockSeq = () => lockClient.query.mock.calls.map(([sql]) => kind(sql));
  // работа с записью под замком: состояние, клиент, постановка job'ов (настройки и правила читаются ДО замка)
  const workCalls = () => [db.oneOrNone, db.query].flatMap((f) => f.mock.invocationCallOrder);

  test('порядок: настройки и правила — до замка; SET lock_timeout → lock → RESET до работы с записью, unlock после; ключ — салон и клиент YClients', async () => {
    setup({ rules: [rule(), rule({ id: 2, trigger_type: 'visit_reminder' })] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(lockSeq()).toEqual(['set', 'lock', 'reset', 'unlock']);
    const calls = lockClient.query.mock.calls;
    expect(calls[0]).toEqual([SET_TIMEOUT]);                              // на ВЫДЕЛЕННОМ соединении, до самого lock
    expect(calls[1][1]).toEqual([enroll.NOTIFY_LOCK_NS, '1:c7']);
    expect(calls[3][1]).toEqual([enroll.NOTIFY_LOCK_NS, '1:c7']);
    const [setAt, lockAt, resetAt, unlockAt] = lockClient.query.mock.invocationCallOrder;
    expect(setAt).toBeLessThan(lockAt);
    expect(settings.getSettings).toHaveBeenCalledTimes(1);                // настройки читаются один раз и до замка
    expect(settings.getSettings.mock.invocationCallOrder[0]).toBeLessThan(setAt);
    expect(db.any.mock.invocationCallOrder[0]).toBeLessThan(setAt);       // правила — тоже
    expect(lockAt).toBeLessThan(Math.min(...workCalls()));
    expect(resetAt).toBeLessThan(Math.min(...workCalls()));               // лимит сбрасывается сразу после взятия замка
    expect(unlockAt).toBeGreaterThan(Math.max(...workCalls()));
    expect(lockClient.release).toHaveBeenCalledTimes(1);
    expect(lockClient.release.mock.calls[0][0]).toBeUndefined();          // соединение вернулось в пул целым
  });

  test('пространство ключей не пересекается с блокировками кэшбэка (их ключ — один bigint, у нас пара int)', () => {
    expect(Number.isInteger(enroll.NOTIFY_LOCK_NS)).toBe(true);
    expect(enroll.NOTIFY_LOCK_NS).toBeGreaterThan(2 ** 24);              // не salon_id вроде booking.js
    expect(enroll.NOTIFY_LOCK_NS).not.toBe(1280266064);                  // не ключ миграции вердиктов
    expect(enroll.NOTIFY_LOCK_NS).toBeLessThanOrEqual(2147483647);       // int4
  });

  test.each([
    ['загрузка состояния', () => db.oneOrNone.mockRejectedValue(new Error('db down'))],
    ['запись состояния', () => db.query.mockRejectedValue(new Error('db down'))],
    ['запрос клиента', () => {
      const base = db.oneOrNone.getMockImplementation();
      db.oneOrNone.mockImplementation(async (sql, p) => { if (/FROM clients/.test(sql)) throw new Error('db down'); return base(sql, p); });
    }],
  ])('исключение (%s): блокировка отпускается, клиент возвращается в пул, ошибка пробрасывается', async (_, breakIt) => {
    setup({ rules: [rule()] });
    breakIt();
    await expect(enroll.handleRecordEvent(salon, payload(), NOW)).rejects.toThrow('db down');
    expect(lockSeq()).toEqual(['set', 'lock', 'reset', 'unlock']);
    expect(lockClient.release).toHaveBeenCalledTimes(1);
    expect(lockClient.release.mock.calls[0][0]).toBeUndefined();
  });

  test.each([
    ['чтение настроек', () => settings.getSettings.mockRejectedValue(new Error('db down'))],
    ['чтение правил', () => db.any.mockRejectedValue(new Error('db down'))],
  ])('сбой до замка (%s): ошибка пробрасывается, соединение под замок не берётся', async (_, breakIt) => {
    setup({ rules: [rule()] });
    breakIt();
    await expect(enroll.handleRecordEvent(salon, payload(), NOW)).rejects.toThrow('db down');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('ключ: без id клиента — по номеру; другой салон — другой ключ', async () => {
    setup({ rules: [rule()] });
    await enroll.handleRecordEvent(salon, payload({ client: { phone: '79200255591', name: 'Анна' } }), NOW);
    expect(lockClient.query.mock.calls[1][1]).toEqual([enroll.NOTIFY_LOCK_NS, '1:p79200255591']);
    jest.clearAllMocks(); lockClient = newLockClient(); pool.connect.mockResolvedValue(lockClient);
    setup({ rules: [rule()] });
    await enroll.handleRecordEvent({ ...salon, id: 2 }, payload(), NOW);
    expect(lockClient.query.mock.calls[1][1]).toEqual([enroll.NOTIFY_LOCK_NS, '2:c7']);
  });

  test('нет ни id клиента, ни номера → без блокировки, обработка идёт', async () => {
    setup({ rules: [rule()] });
    await enroll.handleRecordEvent(salon, payload({ client: { phone: '', name: 'Анна' } }), NOW);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(inserts()).toHaveLength(1);                                    // skipped «нет телефона клиента»
  });

  // Ожидающий замка вебхук держит соединение пула; застрявший держатель не должен держать пул бесконечно.
  describe('ожидание замка ограничено: lock_timeout 15 с на выделенном соединении', () => {
    const timeoutError = () => Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    const failOn = (re, err) => lockClient.query.mockImplementation(async (sql) => { if (re.test(sql)) throw err; return { rows: [] }; });

    test('константы: 15 с в SQL, без обёрток', () => {
      expect(enroll.LOCK_TIMEOUT_MS).toBe(15000);
      expect(SET_TIMEOUT).toBe(`SET lock_timeout = '${enroll.LOCK_TIMEOUT_MS / 1000}s'`);
    });

    test('таймаут (55P03): обработка без замка, WARN, лимит сброшен, соединение возвращено в пул целым и ДО работы', async () => {
      setup({ rules: [rule()] });
      failOn(LOCK, timeoutError());
      await enroll.handleRecordEvent(salon, payload(), NOW);
      expect(lockSeq()).toEqual(['set', 'lock', 'reset']);                 // unlock не нужен: замка нет
      expect(inserts()).toHaveLength(1);                                   // событие обработано
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringMatching(/не получена за 15 с/));
      expect(lockClient.release).toHaveBeenCalledTimes(1);
      expect(lockClient.release.mock.calls[0][0]).toBeUndefined();         // сброс удался — соединение не выбрасываем
      expect(lockClient.release.mock.invocationCallOrder[0]).toBeLessThan(Math.min(...workCalls()));   // обработке оно нужнее
    });

    test('таймаут, но RESET не прошёл → соединение уничтожается (лимит не должен утечь в пул)', async () => {
      setup({ rules: [rule()] });
      lockClient.query.mockImplementation(async (sql) => {
        if (LOCK.test(sql)) throw timeoutError();
        if (sql === RESET_TIMEOUT) throw new Error('connection lost');
        return { rows: [] };
      });
      await enroll.handleRecordEvent(salon, payload(), NOW);
      expect(inserts()).toHaveLength(1);
      expect(lockClient.release.mock.calls[0][0]).toBeTruthy();
    });

    test('не удалось взять замок по другой причине: без него, соединение уничтожается', async () => {
      setup({ rules: [rule()] });
      failOn(LOCK, new Error('connection lost'));
      await enroll.handleRecordEvent(salon, payload(), NOW);
      expect(inserts()).toHaveLength(1);
      expect(lockClient.query.mock.calls.some(([sql]) => UNLOCK.test(sql))).toBe(false);
      expect(lockClient.release.mock.calls[0][0]).toBeTruthy();
    });

    test('SET lock_timeout не прошёл → замок не берём вовсе (без лимита ждать нельзя), соединение уничтожается', async () => {
      setup({ rules: [rule()] });
      failOn(/^SET lock_timeout/, new Error('connection lost'));
      await enroll.handleRecordEvent(salon, payload(), NOW);
      expect(lockClient.query.mock.calls.some(([sql]) => LOCK.test(sql))).toBe(false);
      expect(inserts()).toHaveLength(1);
      expect(lockClient.release.mock.calls[0][0]).toBeTruthy();
    });

    test('замок взят, но RESET не прошёл: работа идёт под замком, замок отпускается, соединение уничтожается', async () => {
      setup({ rules: [rule()] });
      failOn(/^RESET lock_timeout/, new Error('connection lost'));
      await enroll.handleRecordEvent(salon, payload(), NOW);
      expect(lockSeq()).toEqual(['set', 'lock', 'reset', 'unlock']);
      expect(inserts()).toHaveLength(1);
      expect(lockClient.release.mock.calls[0][0]).toBeTruthy();
    });

    test('нет соединения для блокировки (пул исчерпан) → тоже без неё', async () => {
      setup({ rules: [rule()] });
      pool.connect.mockRejectedValue(new Error('timeout exceeded when trying to connect'));
      await enroll.handleRecordEvent(salon, payload(), NOW);
      expect(inserts()).toHaveLength(1);
    });
  });

  test('не удалось отпустить: клиент уничтожается (release с ошибкой), результат обработки не теряется', async () => {
    setup({ rules: [rule()] });
    lockClient.query.mockImplementation(async (sql) => { if (UNLOCK.test(sql)) throw new Error('connection lost'); return { rows: [] }; });
    await expect(enroll.handleRecordEvent(salon, payload(), NOW)).resolves.toBeUndefined();
    expect(inserts()).toHaveLength(1);
    expect(lockClient.release).toHaveBeenCalledTimes(1);
    expect(lockClient.release.mock.calls[0][0]).toBeTruthy();
  });

  test('не удалось отпустить после исключения: пробрасывается исходная ошибка, а не ошибка отпускания', async () => {
    setup({ rules: [rule()] });
    db.oneOrNone.mockRejectedValue(new Error('db down'));
    lockClient.query.mockImplementation(async (sql) => { if (UNLOCK.test(sql)) throw new Error('connection lost'); return { rows: [] }; });
    await expect(enroll.handleRecordEvent(salon, payload(), NOW)).rejects.toThrow('db down');
    expect(lockClient.release.mock.calls[0][0]).toBeTruthy();
  });

  // ── число одновременных обработчиков под замками ──
  test('под замками одновременно не больше LOCK_SLOTS вебхуков (пул общий с приложением); остальные ждут очереди без соединения', async () => {
    let active = 0; let maxActive = 0; const grants = [];
    pool.connect.mockImplementation(() => new Promise((resolve) => {
      grants.push(() => { active += 1; maxActive = Math.max(maxActive, active); resolve({ query: jest.fn(async () => ({ rows: [] })), release: jest.fn(() => { active -= 1; }) }); });
    }));
    setup({ rules: [rule()] });
    let done = 0;
    const runs = [1, 2, 3, 4, 5, 6].map((i) => enroll.handleRecordEvent(salon,
      payload({ id: i, client: { id: i, phone: `7920000000${i}`, name: 'А' } }), NOW).then(() => { done += 1; }));
    await flush();
    expect(pool.connect).toHaveBeenCalledTimes(enroll.LOCK_SLOTS);        // остальным слота нет — соединение они не просят
    expect(enroll.LOCK_SLOTS).toBeLessThan(10);                           // и хвост пула остаётся приложению
    for (let i = 0; i < 200 && done < 6; i += 1) { while (grants.length) grants.shift()(); await flush(); }
    await Promise.all(runs);
    expect(done).toBe(6);
    expect(pool.connect).toHaveBeenCalledTimes(6);
    expect(maxActive).toBeLessThanOrEqual(enroll.LOCK_SLOTS);
  });

  test('место, переданное ожидающему, остаётся занятым: поздний вебхук после передачи тоже ждёт', async () => {
    const grants = [];
    pool.connect.mockImplementation(() => new Promise((resolve) => {
      grants.push(() => resolve({ query: jest.fn(async () => ({ rows: [] })), release: jest.fn() }));
    }));
    setup({ rules: [rule()] });
    const run = (i) => enroll.handleRecordEvent(salon, payload({ id: i, client: { id: i, phone: `7920000000${i}`, name: 'А' } }), NOW);
    const runs = [run(1), run(2), run(3), run(4)];
    await flush();
    expect(pool.connect).toHaveBeenCalledTimes(enroll.LOCK_SLOTS);          // четвёртый ждёт места
    grants.shift()();                                                        // первый получил соединение, отработал и отдал место
    await flush();
    expect(pool.connect).toHaveBeenCalledTimes(enroll.LOCK_SLOTS + 1);      // место перешло к четвёртому
    runs.push(run(5));
    await flush();
    expect(pool.connect).toHaveBeenCalledTimes(enroll.LOCK_SLOTS + 1);      // пятому места нет, пока кто-то не освободит
    let done = 0;
    runs.forEach((p) => p.then(() => { done += 1; }));
    for (let i = 0; i < 200 && done < runs.length; i += 1) { while (grants.length) grants.shift()(); await flush(); }
    await Promise.all(runs);
    expect(done).toBe(5);
    expect(pool.connect).toHaveBeenCalledTimes(5);
  });

  test('сбой обработчика место не занимает: после ошибок очередь не застревает', async () => {
    setup({ rules: [rule()] });
    db.oneOrNone.mockRejectedValue(new Error('db down'));
    for (let i = 0; i < enroll.LOCK_SLOTS + 2; i += 1) {
      await expect(enroll.handleRecordEvent(salon, payload({ id: 200 + i }), NOW)).rejects.toThrow('db down');
    }
    setup({ rules: [rule()] });
    await expect(enroll.handleRecordEvent(salon, payload({ id: 300 }), NOW)).resolves.toBeUndefined();
    expect(inserts()).toHaveLength(1);
  });

  // ── ожидание места ограничено 30 с ──
  describe('ожидание места под замок не дольше 30 с, дальше — обработка без замка', () => {
    // setImmediate/nextTick не подменяем: flush() и разбор промисов должны работать как обычно
    beforeEach(() => { jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] }); });
    afterEach(() => { jest.useRealTimers(); });
    const hangingConnect = () => {
      const grants = [];
      pool.connect.mockImplementation(() => new Promise((resolve) => { grants.push(() => resolve(newLockClient())); }));
      return grants;
    };
    const run = (i) => enroll.handleRecordEvent(salon, payload({ id: i, client: { id: i, phone: `7920000000${i}`, name: 'А' } }), NOW);

    test('константа: 30 с', () => {
      expect(enroll.SLOT_WAIT_MS).toBe(30000);
    });

    test('все места заняты: четвёртый ждёт ровно 30 с, затем обрабатывается без замка и без соединения, с WARN', async () => {
      const grants = hangingConnect();
      setup({ rules: [rule()] });
      const holders = [run(1), run(2), run(3)];                             // три места заняты (зависли на pool.connect)
      await flush();
      expect(pool.connect).toHaveBeenCalledTimes(enroll.LOCK_SLOTS);
      let fourthDone = false;
      const fourth = run(4).then(() => { fourthDone = true; });
      await flush();
      await jest.advanceTimersByTimeAsync(enroll.SLOT_WAIT_MS - 1);
      await flush();
      expect(fourthDone).toBe(false);                                       // 29,999 с — ещё ждёт
      expect(inserts().filter((p) => p[4] === 4)).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(1);
      await fourth;
      expect(inserts().filter((p) => p[4] === 4)).toHaveLength(1);          // событие обработано
      expect(pool.connect).toHaveBeenCalledTimes(enroll.LOCK_SLOTS);        // под замок соединение не просили
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringMatching(/нет места под замок за 30 с/));
      // учёт мест цел: ушедший по тайм-ауту место не занимал, в очереди не остался и свободным не «возвращает»
      while (grants.length) grants.shift()();
      await Promise.all(holders);
      const more = [5, 6, 7].map(run);                                       // все три места снова свободны
      await flush();
      expect(pool.connect).toHaveBeenCalledTimes(enroll.LOCK_SLOTS + 3);
      for (let i = 0; i < 20 && grants.length; i += 1) { while (grants.length) grants.shift()(); await flush(); }
      await Promise.all(more);
    });

    test('место, полученное до тайм-аута, таймер за собой не оставляет', async () => {
      const grants = hangingConnect();
      setup({ rules: [rule()] });
      const runs = [run(1), run(2), run(3), run(4)];                         // четвёртый встаёт в очередь с таймером
      await flush();
      expect(jest.getTimerCount()).toBe(1);
      let done = 0;
      runs.forEach((p) => p.then(() => { done += 1; }));
      for (let i = 0; i < 200 && done < 4; i += 1) { while (grants.length) grants.shift()(); await flush(); }
      await Promise.all(runs);
      expect(jest.getTimerCount()).toBe(0);
      expect(mockLog.warn).not.toHaveBeenCalled();
    });

    test('тайм-аут одного ожидающего не мешает следующему: передача идёт тому, кто ещё ждёт', async () => {
      const grants = hangingConnect();
      setup({ rules: [rule()] });
      const holders = [run(1), run(2), run(3)];
      await flush();
      const early = run(4);                                                   // встал в очередь первым
      await flush();
      await jest.advanceTimersByTimeAsync(20000);
      const late = run(5);                                                    // встал на 20-й секунде
      await flush();
      await jest.advanceTimersByTimeAsync(10000);                             // 30 с у early истекли, у late — 10 с
      await early;
      expect(inserts().filter((p) => p[4] === 4)).toHaveLength(1);
      expect(inserts().filter((p) => p[4] === 5)).toHaveLength(0);
      grants.shift()();                                                       // первый держатель закончил → место достаётся late
      await flush();
      expect(pool.connect).toHaveBeenCalledTimes(enroll.LOCK_SLOTS + 1);
      for (let i = 0; i < 50; i += 1) { while (grants.length) grants.shift()(); await flush(); }
      await Promise.all([...holders, late]);
      expect(inserts().filter((p) => p[4] === 5)).toHaveLength(1);
    });
  });

  // Менеджер блокировок: pg_advisory_lock ждёт, пока предыдущий владелец того же ключа не отпустит.
  function lockManager() {
    const held = new Set(); const waiting = new Map();
    return () => ({
      query: jest.fn(async (sql, p) => {
        if (LOCK.test(sql)) {
          const key = `${p[0]}:${p[1]}`;
          while (held.has(key)) await new Promise((resolve) => { if (!waiting.has(key)) waiting.set(key, []); waiting.get(key).push(resolve); });
          held.add(key);
        } else if (UNLOCK.test(sql)) {
          const key = `${p[0]}:${p[1]}`;
          held.delete(key);
          const next = (waiting.get(key) || []).shift();
          if (next) next();
        }
        return { rows: [{ unlocked: true }] };
      }),
      release: jest.fn(),
    });
  }
  const arrivePair = async () => {
    const { jobs, states } = fakeTables([rule({ id: 5, trigger_type: 'visit_review', delay_minutes: 5 })], { yieldIO: true });
    const visit = '2026-10-20T13:30:00+03:00';
    for (const id of [9004, 9005]) states.set(id, { visit_datetime: new Date(visit), attendance: 0, deleted: false });
    const now = at('2026-10-20T13:40:00+03:00');
    // «пришёл» по двум записям одного визита одного клиента — почти одновременно
    await Promise.all([9004, 9005].map((id) => enroll.handleRecordEvent(salon, payload({ id, attendance: 1 }, 'update'), now)));
    return jobs;
  };

  test('КОНТРОЛЬ без сериализации: два «пришёл» одного клиента одновременно оба проходят дедуп и ставят опрос', async () => {
    pool.connect.mockImplementation(async () => ({ query: async () => ({ rows: [] }), release() {} }));   // блокировка «не держит»
    const jobs = await arrivePair();
    expect(jobs.filter((j) => j.trigger === 'visit_review' && j.status === 'pending')).toHaveLength(2);
  });

  test('с блокировкой события одного клиента идут по очереди: опрос один, второй — skipped «опрос уже был»', async () => {
    const make = lockManager();                              // один менеджер на всех: блокировки видят друг друга
    pool.connect.mockImplementation(async () => make());
    const jobs = await arrivePair();
    const reviews = jobs.filter((j) => j.trigger === 'visit_review');
    expect(reviews.map((j) => j.status).sort()).toEqual(['pending', 'skipped']);
    expect(reviews.find((j) => j.status === 'skipped').reason).toBe('опрос уже был за 30 дней');
  });

  test('разные клиенты не ждут друг друга', async () => {
    const make = lockManager();
    pool.connect.mockImplementation(async () => make());
    setup({ rules: [rule()] });
    const done = [];
    const runOne = (clientId, phone) => enroll.handleRecordEvent(salon, payload({ id: clientId, client: { id: clientId, phone, name: 'А' } }), NOW).then(() => done.push(clientId));
    await Promise.all([runOne(11, '79200000011'), runOne(12, '79200000012')]);
    expect(done.sort()).toEqual([11, 12]);
    expect(pool.connect).toHaveBeenCalledTimes(2);
  });
});
