'use strict';
// Планирование напоминаний по вебхуку записи. Все зависимости инжектируются —
// БД и сеть не трогаются. Проверки идут по подстрокам SQL в вызовах db, как в
// care-worker.test.js.
const enroll = require('./services/reminders/enroll');

const SALON = { id: 1, yclients_company_id: 100 };

const RULE = {
  id: 5, salon_id: 1, title: 'Эпиляция раз в месяц',
  conditions: { logic: 'and', items: [{ type: 'category', ids: [9] }] },
  delay_days: 30, send_time: '11:00',
};

// Состоявшийся визит по услуге 101 (категория 9 в catMap).
const VISIT = {
  id: 777, date: '2026-08-01 14:00:00', attendance: 1,
  client: { id: 42, phone: '+7 (920) 025-55-91', name: 'Мария' },
  staff: { id: 55, name: 'Юлия' },
  services: [{ id: 101, title: 'Лазерная эпиляция' }],
};

function makeDeps(over = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      db: {
        any: jest.fn(async () => [RULE]),
        query: jest.fn(async (sql, params) => { calls.push({ sql, params }); return { rowCount: 1 }; }),
        oneOrNone: jest.fn(async (sql, params) => {
          calls.push({ sql, params });
          if (/FROM clients/i.test(sql)) return { id: 42, name: 'Мария', is_blacklisted: false };
          return null;
        }),
      },
      getCatMap: jest.fn(async () => new Map([['101', '9']])),
      log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      ...over,
    },
  };
}

const sqlsOf = (calls, re) => calls.filter(c => re.test(c.sql));

describe('handleRecordEvent — визит состоялся', () => {
  test('ставит строку очереди на visit_at + delay_days', async () => {
    const { calls, deps } = makeDeps();
    await enroll.handleRecordEvent(SALON, { status: 'update', data: VISIT }, deps);
    const ins = sqlsOf(calls, /INSERT INTO reminder_queue/i);
    expect(ins).toHaveLength(1);
    // 2026-08-01 + 30 дней = 2026-08-31, 11:00 МСК = 08:00 UTC
    const at = ins[0].params.find(p => p instanceof Date);
    expect(at.toISOString()).toBe('2026-08-31T08:00:00.000Z');
  });

  // Порядок обязателен: снятие флага ДО планирования, иначе новая строка
  // упрётся в собственный muted от прошлого цикла и не уйдёт никогда.
  test('снимает muted ДО постановки в очередь', async () => {
    const { calls, deps } = makeDeps();
    await enroll.handleRecordEvent(SALON, { status: 'update', data: VISIT }, deps);
    const resetIdx = calls.findIndex(c => /reminder_suppressions[\s\S]*muted\s*=\s*FALSE/i.test(c.sql));
    const insertIdx = calls.findIndex(c => /INSERT INTO reminder_queue/i.test(c.sql));
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(resetIdx);
  });

  test('отменяет запланированные строки от более ранних визитов', async () => {
    const { calls, deps } = makeDeps();
    await enroll.handleRecordEvent(SALON, { status: 'update', data: VISIT }, deps);
    const sup = sqlsOf(calls, /UPDATE reminder_queue[\s\S]*'cancelled'/i);
    expect(sup.length).toBeGreaterThan(0);
    expect(sup[0].sql).toMatch(/anchor_visit_at\s*<\s*\$/i);
  });

  test('клиент в чёрном списке не планируется', async () => {
    const { calls, deps } = makeDeps({
      db: {
        any: jest.fn(async () => [RULE]),
        query: jest.fn(async () => ({ rowCount: 1 })),
        oneOrNone: jest.fn(async () => ({ id: 42, name: 'М', is_blacklisted: true })),
      },
    });
    await enroll.handleRecordEvent(SALON, { status: 'update', data: VISIT }, deps);
    expect(sqlsOf(calls, /INSERT INTO reminder_queue/i)).toHaveLength(0);
  });

  test('визит без телефона не планируется', async () => {
    const { calls, deps } = makeDeps();
    const noPhone = { ...VISIT, client: { id: 42, phone: '', name: 'М' } };
    await enroll.handleRecordEvent(SALON, { status: 'update', data: noPhone }, deps);
    expect(sqlsOf(calls, /INSERT INTO reminder_queue/i)).toHaveLength(0);
  });

  test('визит вне условий правила не планируется', async () => {
    const { calls, deps } = makeDeps({ getCatMap: jest.fn(async () => new Map([['101', '7']])) });
    await enroll.handleRecordEvent(SALON, { status: 'update', data: VISIT }, deps);
    expect(sqlsOf(calls, /INSERT INTO reminder_queue/i)).toHaveLength(0);
  });

  // Оплата бонусами — тоже состоявшийся визит: критерий attendance=1 ИЛИ
  // paid_full=1, ровно как в care/enroll.js.
  test('paid_full=1 без attendance тоже считается визитом', async () => {
    const { calls, deps } = makeDeps();
    const paid = { ...VISIT, attendance: 0, paid_full: 1 };
    await enroll.handleRecordEvent(SALON, { status: 'update', data: paid }, deps);
    expect(sqlsOf(calls, /INSERT INTO reminder_queue/i)).toHaveLength(1);
  });
});

describe('handleRecordEvent — отмена', () => {
  test('удаление записи гасит её запланированные строки', async () => {
    const { calls, deps } = makeDeps();
    await enroll.handleRecordEvent(SALON, { status: 'delete', data: VISIT }, deps);
    const cancels = sqlsOf(calls, /UPDATE reminder_queue[\s\S]*'cancelled'/i);
    expect(cancels).toHaveLength(1);
    expect(cancels[0].params).toContain(777);
    expect(sqlsOf(calls, /INSERT INTO reminder_queue/i)).toHaveLength(0);
  });

  // Предоплаченная неявка несёт paid_full=1 ОДНОВРЕМЕННО с attendance=-1 —
  // это отмена, а не повод начинать цикл напоминаний.
  test('attendance=-1 при paid_full=1 — это отмена', async () => {
    const { calls, deps } = makeDeps();
    const noShow = { ...VISIT, attendance: -1, paid_full: 1 };
    await enroll.handleRecordEvent(SALON, { status: 'update', data: noShow }, deps);
    expect(sqlsOf(calls, /INSERT INTO reminder_queue/i)).toHaveLength(0);
    expect(sqlsOf(calls, /UPDATE reminder_queue[\s\S]*'cancelled'/i)).toHaveLength(1);
  });
});

describe('handleAttribution', () => {
  test('размечает подходящую отправленную строку', async () => {
    const sentRow = {
      id: 11, rule_id: 5, conditions: RULE.conditions, attribution_days: 30,
      sent_at: new Date(Date.now() - 86400000).toISOString(), conversion_record_id: null,
    };
    const { calls, deps } = makeDeps({
      db: {
        any: jest.fn(async () => [sentRow]),
        query: jest.fn(async (sql, params) => { return { rowCount: 1 }; }),
        oneOrNone: jest.fn(async () => null),
      },
    });
    deps.db.query = jest.fn(async (sql, params) => { calls.push({ sql, params }); return { rowCount: 1 }; });
    await enroll.handleAttribution(SALON, { status: 'create', data: VISIT }, deps);
    const upd = sqlsOf(calls, /UPDATE reminder_queue[\s\S]*conversion_record_id/i);
    expect(upd).toHaveLength(1);
    expect(upd[0].params).toEqual(expect.arrayContaining([11, 777]));
  });

  test('состоявшийся визит по приведённой записи проставляет visited_at', async () => {
    const { calls, deps } = makeDeps({
      db: {
        any: jest.fn(async () => []),
        query: jest.fn(async (sql, params) => { calls.push({ sql, params }); return { rowCount: 1 }; }),
        oneOrNone: jest.fn(async () => null),
      },
    });
    await enroll.handleAttribution(SALON, { status: 'update', data: VISIT }, deps);
    const visited = sqlsOf(calls, /UPDATE reminder_queue[\s\S]*visited_at/i);
    expect(visited).toHaveLength(1);
    expect(visited[0].params).toContain(777);
  });
});
