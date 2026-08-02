'use strict';
// Юнит-тесты воркера «Отдела заботы»: все внешние зависимости замоканы через
// DI (deps), БД/сеть не трогаются. Проверки статусов идут по подстрокам SQL
// в вызовах db.query — тот же стиль, что notification-воркер.
const worker = require('./services/care/worker');

// Общий конструктор моков: happy-path, отдельные тесты переопределяют куски.
function makeDeps(over = {}) {
  const updates = [];
  return {
    updates,
    deps: {
      db: {
        any: jest.fn(async () => []),
        query: jest.fn(async (sql, params) => { updates.push({ sql, params }); return { rowCount: 1 }; }),
        oneOrNone: jest.fn(async () => null),
      },
      isAllowed: jest.fn(async () => ({ allow: true, reason: 'ok' })),
      agentGloballyEnabled: () => true,
      dialogStatus: jest.fn(async () => null),                     // не эскалирован
      sentTodayExists: jest.fn(async () => false),                 // анти-спам
      loadClientRecords: jest.fn(async () => ({ completedAfter: [], future: [] })),
      getCatMap: jest.fn(async () => new Map()),
      loadTranscript: jest.fn(async () => ({ messages: [] })),
      createMessage: jest.fn(async () => ({ text: '{"action":"send","text":"Добрый день! Как самочувствие?","reason":"ок"}' })),
      lintReply: jest.fn(() => []),
      hardViolations: jest.fn(() => []),
      sendMessage: jest.fn(async () => ({ id: 777, channel: 'telegram' })),
      lastIncomingChannel: jest.fn(async () => 'telegram'),
      rememberPending: jest.fn(),
      persistWhatsapp: jest.fn(async () => {}),
      escalateDialog: jest.fn(async () => {}),
      log: { info: () => {}, warn: () => {}, error: () => {} },
      ...over,
    },
  };
}

const row = {
  id: 1, salon_id: 5, enrollment_id: 11, touch_id: 21, attempts: 1,
  phone: '79200255591', enrollment_status: 'active', program_enabled: true,
  program_conditions: { logic: 'and', items: [] },
  staff_name: 'Пери', visit_at: new Date('2026-08-02T11:00:00Z'),
  visit_services: [{ id: 10, title: 'Биорев' }],
  intent_text: 'Узнать самочувствие', touch_title: 'Т+1', delay_days: 1,
  salon_name: 'PERI', client_name: 'Анна',
};

describe('care worker processOne', () => {
  test('happy path: LLM send → отправлено, строка sent', async () => {
    const { deps } = makeDeps();
    await worker.processOne(row, deps);
    expect(deps.sendMessage).toHaveBeenCalled();
    expect(deps.rememberPending).toHaveBeenCalledWith(5, '79200255591', 'Добрый день! Как самочувствие?');
    const sent = deps.db.query.mock.calls.find(c => c[0].includes(`'sent'`));
    expect(sent).toBeTruthy();
  });
  test('гейт запретил → skipped, LLM не зовётся', async () => {
    const { deps } = makeDeps({ isAllowed: jest.fn(async () => ({ allow: false, reason: 'whitelist' })) });
    await worker.processOne(row, deps);
    expect(deps.createMessage).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
    const skipped = deps.db.query.mock.calls.find(c => c[0].includes(`'skipped'`));
    expect(skipped).toBeTruthy();
  });
  test('диалог на операторе → skipped', async () => {
    const { deps } = makeDeps({ dialogStatus: jest.fn(async () => 'escalated') });
    await worker.processOne(row, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
  test('анти-спам: уже слали сегодня → сдвиг на завтра, не skip', async () => {
    const { deps } = makeDeps({ sentTodayExists: jest.fn(async () => true) });
    await worker.processOne(row, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    const moved = deps.db.query.mock.calls.find(c => c[0].includes('scheduled_at'));
    expect(moved).toBeTruthy();
  });
  test('повторный визит по условиям → enrollment completed, касание cancelled', async () => {
    const { deps } = makeDeps({
      loadClientRecords: jest.fn(async () => ({
        completedAfter: [{ datetime: '2026-08-06T12:00:00+03:00', attendance: 1, services: [{ id: 10 }] }],
        future: [],
      })),
    });
    await worker.processOne(row, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    const completed = deps.db.query.mock.calls.find(c => c[0].includes(`'completed'`));
    expect(completed).toBeTruthy();
  });
  test('LLM stop_program declined → enrollment declined, остальные касания cancelled', async () => {
    const { deps } = makeDeps({
      createMessage: jest.fn(async () => ({ text: '{"action":"stop_program","status":"declined","reason":"просил не писать"}' })),
    });
    await worker.processOne(row, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    const declined = deps.db.query.mock.calls.find(c => c[0].includes(`'declined'`));
    expect(declined).toBeTruthy();
  });
  test('LLM вернул мусор → fail-safe skipped', async () => {
    const { deps } = makeDeps({ createMessage: jest.fn(async () => ({ text: 'ой' })) });
    await worker.processOne(row, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
  test('reply-guard жёсткое нарушение → skipped, не отправляем', async () => {
    const { deps } = makeDeps({ hardViolations: jest.fn(() => [{ type: 'id_leak' }]) });
    await worker.processOne(row, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
  test('сбой отправки → строка остаётся на ретрай (attempts<3)', async () => {
    const { deps } = makeDeps({ sendMessage: jest.fn(async () => { throw new Error('net'); }) });
    await worker.processOne(row, deps);
    const backToScheduled = deps.db.query.mock.calls.find(c => c[0].includes(`'scheduled'`) || c[0].includes(`'failed'`));
    expect(backToScheduled).toBeTruthy();
  });

  // ── escalate: осложнение в переписке (ревизия Task 4, ОБЯЗАТЕЛЬНО) ──
  test('LLM escalate → полный путь: диалог на оператора, enrollment escalated, строка skipped', async () => {
    const { deps } = makeDeps({
      createMessage: jest.fn(async () => ({ text: '{"action":"escalate","reason":"жалоба на отёк"}' })),
    });
    await worker.processOne(row, deps);
    // Диалог передан оператору тем же механизмом, что escalate_to_operator.
    expect(deps.escalateDialog).toHaveBeenCalledWith(5, '79200255591', 'жалоба на отёк');
    // Enrollment помечен escalated, его scheduled-касания отменены.
    const escalated = deps.db.query.mock.calls.find(c => c[0].includes(`'escalated'`));
    expect(escalated).toBeTruthy();
    const cancelled = deps.db.query.mock.calls.find(c => c[0].includes(`'cancelled'`));
    expect(cancelled).toBeTruthy();
    // Строка отправки — skipped с внятной причиной.
    const skipped = deps.db.query.mock.calls.find(c => c[0].includes(`'skipped'`));
    expect(skipped).toBeTruthy();
    expect(skipped[1]).toEqual(expect.arrayContaining(['Мила: эскалация — жалоба на отёк']));
  });
  test('LLM escalate при осложнении → сообщение пациенту НЕ отправляется', async () => {
    const { deps } = makeDeps({
      createMessage: jest.fn(async () => ({ text: '{"action":"escalate","reason":"покраснение после процедуры"}' })),
    });
    await worker.processOne(row, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.rememberPending).not.toHaveBeenCalled();
    const sent = deps.db.query.mock.calls.find(c => c[0].includes(`'sent'`));
    expect(sent).toBeFalsy();
  });
});
