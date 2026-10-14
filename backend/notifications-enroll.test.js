'use strict';
jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn(), query: jest.fn() } }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
jest.mock('./services/notifications/settings', () => ({ getSettings: jest.fn() }));
jest.mock('./services/notifications/rules', () => ({
  ...jest.requireActual('./services/notifications/rules'),
  getServiceCategoryMap: jest.fn(async () => new Map([['1', '10']])),
}));
jest.mock('./utils/salon-names', () => ({ load: jest.fn(async () => null) }));
const { db } = require('./db');
const settings = require('./services/notifications/settings');
const enroll = require('./services/notifications/enroll');

const salon = { id: 1, name: 'PERI CLINIC', yclients_company_id: 5 };
const NOW = Date.parse('2026-10-18T10:00:00+03:00');
const payload = (over = {}, status = 'create') => ({ status, data: {
  id: 100, datetime: '2026-10-20T13:30:00+03:00', seance_length: 3600, attendance: 0, deleted: false, sms_before: 24,
  client: { id: 7, phone: '79200255591', name: 'Анна' }, staff: { id: 55, name: 'Татьяна' },
  services: [{ id: 1, title: 'Пилинг' }], created_user_id: 13287477, ...over } });
const rule = (over) => ({ id: 1, title: 'r', trigger_type: 'record_created', conditions: { logic: 'and', items: [] },
  message_template: '{first_name}, вы записаны {date} {time}', channels: ['tdlib'], prefer_last_channel: true,
  hours_before: 24, delay_minutes: 5, on_no_show: true, ask_confirmation: true, ...over });
const prevOf = (visit, over = {}) => ({ visit_datetime: new Date(visit), attendance: 0, deleted: false, ...over });

function setup({ prev = null, rules = [], client = { id: 9, name: 'Иванова Анна', is_blacklisted: false }, mode = 'live',
  recentReview = false, priorVisits = 0 } = {}) {
  settings.getSettings.mockResolvedValue({ mode, quiet_from: null, quiet_to: null, default_channels: ['tdlib'] });
  db.oneOrNone.mockImplementation(async (sql) => {
    if (/FROM notification_record_state/.test(sql)) return prev;
    if (/FROM clients/.test(sql)) return client;
    if (/FROM records/.test(sql)) return { n: String(priorVisits) };
    if (/FROM notification_jobs/.test(sql)) return recentReview ? { hit: 1 } : null;
    return null;
  });
  db.any.mockImplementation(async (sql) => (/FROM notification_rules/.test(sql) ? rules : []));
  db.query.mockResolvedValue({ rowCount: 1, rows: [{ id: 1 }] });
}
const inserts = () => db.query.mock.calls.filter(([sql]) => /INSERT INTO notification_jobs/.test(sql)).map(([, p]) => p);
const cancels = () => db.query.mock.calls.filter(([sql]) => /UPDATE notification_jobs SET status='cancelled'/.test(sql)).map(([, p]) => p);
// индексы параметров insertJob: [2] trigger, [3] rule_title, [4] record, [5] visit, [6] scheduled_at,
// [8] text, [9] status, [11] attachment, [12] meta, [13] reason
const at = (iso) => Date.parse(iso);

beforeEach(() => { jest.clearAllMocks(); });

test('режим off → состояние пишется, job не создаётся', async () => {
  setup({ mode: 'off', rules: [rule()] });
  await enroll.handleRecordEvent(salon, payload(), NOW);
  expect(db.query.mock.calls.some(([sql]) => /INSERT INTO notification_record_state/.test(sql))).toBe(true);
  expect(inserts()).toHaveLength(0);
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
  setup({ prev, rules: [rule({ id: 5, trigger_type: 'visit_review', delay_minutes: 5 })] });
  settings.getSettings.mockResolvedValue({ mode: 'live', quiet_from: '21:00', quiet_to: '09:00', default_channels: ['tdlib'] });
  const late = at('2026-10-20T21:10:00+03:00');
  await enroll.handleRecordEvent(salon, payload({ datetime: '2026-10-20T20:00:00+03:00', attendance: 1 }, 'update'), late);
  expect(new Date(inserts()[0][6]).getTime()).toBe(at('2026-10-21T09:00:00+03:00'));
  jest.clearAllMocks();
  setup({ rules: [rule()] });
  settings.getSettings.mockResolvedValue({ mode: 'live', quiet_from: '21:00', quiet_to: '09:00', default_channels: ['tdlib'] });
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

  test('insertJob оживляет погашенную строку того же ключа и не трогает остальные', async () => {
    setup({ rules: [reminder()] });
    await enroll.handleRecordEvent(salon, payload(), NOW);
    const sql = db.query.mock.calls.find(([s]) => /INSERT INTO notification_jobs/.test(s))[0];
    expect(sql).toMatch(/ON CONFLICT \(rule_id, yclients_record_id, COALESCE\(visit_datetime, 'epoch'::timestamptz\)\)\s+DO UPDATE SET/);
    for (const col of ['status=EXCLUDED.status', 'scheduled_at=EXCLUDED.scheduled_at', 'rendered_text=EXCLUDED.rendered_text',
      'meta=EXCLUDED.meta', 'decision_reason=EXCLUDED.decision_reason', 'phone=EXCLUDED.phone', 'attempts=0', 'error=NULL',
      'last_attempt_at=NULL', 'created_at=NOW()']) {
      expect(sql.replace(/\s+/g, '')).toContain(col);
    }
    expect(sql).toMatch(/WHERE notification_jobs\.status\s*=\s*'cancelled'/);
  });

  // Мини-модель таблиц: ровно та семантика, на которую опирается enroll — уникальный ключ
  // (правило, запись, момент визита), оживление строки в статусе cancelled, гашение pending.
  function fakeTables(rules) {
    const jobs = []; const states = new Map();
    const keyOf = (p) => `${p[1]}|${p[4]}|${p[5] ? new Date(p[5]).getTime() : 0}`;
    settings.getSettings.mockResolvedValue({ mode: 'live', quiet_from: null, quiet_to: null, default_channels: ['tdlib'] });
    db.any.mockImplementation(async (sql) => (/FROM notification_rules/.test(sql) ? rules : []));
    db.oneOrNone.mockImplementation(async (sql, p) => {
      if (/FROM notification_record_state/.test(sql)) return states.get(p[1]) || null;
      if (/FROM clients/.test(sql)) return { id: 9, name: 'Иванова Анна', is_blacklisted: false };
      if (/FROM records/.test(sql)) return { n: '0' };
      return null;
    });
    db.query.mockImplementation(async (sql, p) => {
      if (/INSERT INTO notification_record_state/.test(sql)) {
        states.set(p[1], { visit_datetime: p[2], attendance: p[4], deleted: p[5] });
        return { rowCount: 1, rows: [] };
      }
      if (/INSERT INTO notification_jobs/.test(sql)) {
        const key = keyOf(p);
        const row = { key, rule_id: p[1], trigger: p[2], record_id: p[4], visit: p[5], scheduled: p[6], text: p[8], status: p[9], reason: p[13] };
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
    return jobs;
  }

  test('перенос A→B→A: напоминание на A оживает, на B гасится, оба «перенесена» уходят', async () => {
    const jobs = fakeTables([reminder(), rule({ id: 3, trigger_type: 'record_rescheduled' })]);
    await enroll.handleRecordEvent(salon, payload({ datetime: A }), NOW);
    await enroll.handleRecordEvent(salon, payload({ datetime: B }, 'update'), NOW + 3600e3);
    await enroll.handleRecordEvent(salon, payload({ datetime: A }, 'update'), NOW + 3600e3 + 300e3);
    const view = (trigger, visit) => jobs.find((j) => j.trigger === trigger && new Date(j.visit).getTime() === at(visit));
    expect(view('visit_reminder', B).status).toBe('cancelled');
    const onA = view('visit_reminder', A);
    expect(onA.status).toBe('pending');
    expect(new Date(onA.scheduled).getTime()).toBe(at('2026-10-24T12:00:00+03:00'));
    expect(onA.reason).toBeNull();
    expect(view('record_rescheduled', B).status).toBe('pending');
    expect(view('record_rescheduled', A).status).toBe('pending');
    expect(jobs).toHaveLength(4);
  });

  test('уже отправленное напоминание не оживает и не дублируется', async () => {
    const jobs = fakeTables([reminder()]);
    await enroll.handleRecordEvent(salon, payload({ datetime: A }), NOW);
    jobs[0].status = 'sent';                                          // воркер отправил
    await enroll.handleRecordEvent(salon, payload({ datetime: A, attendance: -1 }, 'update'), NOW + 3600e3);   // «не придёт»
    await enroll.handleRecordEvent(salon, payload({ datetime: A, attendance: 0 }, 'update'), NOW + 7200e3);    // вернули
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('sent');
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
    const call = db.oneOrNone.mock.calls.find(([sql]) => /FROM notification_jobs/.test(sql));
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
  });

  test('проверка касается только visit_review: «рекомендации» и «первый визит» идут как обычно', async () => {
    setup({ prev, recentReview: true, rules: [rule({ id: 6, trigger_type: 'visit_after', delay_minutes: 7 }), rule({ id: 8, trigger_type: 'first_visit' })] });
    await enroll.handleRecordEvent(salon, payload({ attendance: 1 }, 'update'), later);
    expect(inserts().map((p) => [p[2], p[9]]).sort()).toEqual([['first_visit', 'pending'], ['visit_after', 'pending']]);
  });
});

test('пришёл → visit_review через delay от конца визита, visit_after по условиям, first_visit при 0 прошлых', async () => {
  const prev = prevOf('2026-10-20T13:30:00+03:00');
  const later = at('2026-10-20T13:40:00+03:00');
  setup({ prev, rules: [
    rule({ id: 5, trigger_type: 'visit_review', delay_minutes: 5 }),
    rule({ id: 6, trigger_type: 'visit_after', delay_minutes: 7, attachment_url: '/uploads/a.jpg', conditions: { logic: 'and', items: [{ type: 'category', ids: [10] }] } }),
    rule({ id: 7, trigger_type: 'visit_after', delay_minutes: 7, conditions: { logic: 'and', items: [{ type: 'category', ids: [99] }] } }),
    rule({ id: 8, trigger_type: 'first_visit' }),
  ] });
  await enroll.handleRecordEvent(salon, payload({ attendance: 1 }, 'update'), later);
  const rows = inserts();
  expect(rows.map((p) => p[2]).sort()).toEqual(['first_visit', 'visit_after', 'visit_review']);
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
  setup({ prev, rules: [rule({ id: 5, trigger_type: 'visit_review', delay_minutes: null }), rule({ id: 6, trigger_type: 'visit_after', delay_minutes: null })] });
  await enroll.handleRecordEvent(salon, payload({ attendance: 1 }, 'update'), at('2026-10-20T13:40:00+03:00'));
  const byType = Object.fromEntries(inserts().map((p) => [p[2], new Date(p[6]).getTime()]));
  expect(byType).toEqual({ visit_review: at('2026-10-20T14:35:00+03:00'), visit_after: at('2026-10-20T14:37:00+03:00') });   // не задано → 5 и 7
});

test('first_visit не ставится, если были прошлые состоявшиеся визиты', async () => {
  const prev = prevOf('2026-10-20T13:30:00+03:00');
  setup({ prev, rules: [rule({ id: 8, trigger_type: 'first_visit' })], priorVisits: 2 });
  await enroll.handleRecordEvent(salon, payload({ attendance: 1 }, 'update'), NOW);
  expect(inserts()).toHaveLength(0);
});

test('first_visit: прошлые визиты — arrived/completed этого клиента, не считая саму запись и с учётом одновременных', async () => {
  const prev = prevOf('2026-10-20T13:30:00+03:00');
  setup({ prev, rules: [rule({ id: 8, trigger_type: 'first_visit' })] });
  await enroll.handleRecordEvent(salon, payload({ attendance: 1 }, 'update'), NOW);
  const call = db.oneOrNone.mock.calls.find(([sql]) => /FROM records/.test(sql));
  const norm = call[0].replace(/\s+/g, ' ');
  expect(norm).toMatch(/status IN \('arrived', ?'completed'\)/);
  expect(norm).toMatch(/yclients_record_id <> \$3/);
  expect(norm).toMatch(/visit_datetime <= \$4/);
  expect(call[1][0]).toBe(1);
  expect(call[1][1]).toBe(9);                              // clients.id
  expect(call[1][2]).toBe(100);                            // сама запись исключается
  expect(call[1][3].getTime()).toBe(at('2026-10-20T13:30:00+03:00'));
});

test('first_visit: клиента нет в нашей базе → прошлых визитов не найти, это первый визит', async () => {
  const prev = prevOf('2026-10-20T13:30:00+03:00');
  setup({ prev, rules: [rule({ id: 8, trigger_type: 'first_visit' })], client: null });
  await enroll.handleRecordEvent(salon, payload({ attendance: 1 }, 'update'), NOW);
  expect(inserts().map((p) => p[2])).toEqual(['first_visit']);
  expect(db.oneOrNone.mock.calls.some(([sql]) => /FROM records/.test(sql))).toBe(false);
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

test('событие без id записи игнорируется целиком', async () => {
  setup({ rules: [rule()] });
  await enroll.handleRecordEvent(salon, { status: 'create', data: {} }, NOW);
  expect(db.query).not.toHaveBeenCalled();
});
