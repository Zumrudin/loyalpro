'use strict';
// Юнит-тесты воркера «Отдела заботы»: все внешние зависимости замоканы через
// DI (deps), БД/сеть не трогаются. Проверки статусов идут по подстрокам SQL
// в вызовах db.query — тот же стиль, что notification-воркер.
const worker = require('./services/care/worker');
const { OPERATOR_MARK } = require('./services/agent/history');

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
      log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
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
  // Ревью Task 3: history.loadTranscript помечает старые/операторские реплики
  // OPERATOR_MARK для ОСНОВНОГО агента (его промпт про пометку знает) — но care-
  // проход того же транскрипта не различает авторство вовсе, а его промпт ничего
  // не знает про маркер, и reply-guard на этом пути нет. Без среза служебная
  // пометка ушла бы пациенту дословно в тексте касания.
  test('OPERATOR_MARK из транскрипта не попадает в care-промпт', async () => {
    const { deps } = makeDeps({
      loadTranscript: jest.fn(async () => ({
        messages: [
          { role: 'user', content: 'привет' },
          { role: 'assistant', content: `${OPERATOR_MARK} Доброе утро!` },
        ],
      })),
    });
    await worker.processOne(row, deps);
    expect(deps.createMessage).toHaveBeenCalled();
    const [{ messages }] = deps.createMessage.mock.calls[0];
    const userPrompt = messages[0].content;
    expect(userPrompt).toContain('Доброе утро!');
    expect(userPrompt).not.toContain(OPERATOR_MARK);
  });
  test('гейт запретил → skipped, LLM не зовётся', async () => {
    const { deps } = makeDeps({ isAllowed: jest.fn(async () => ({ allow: false, reason: 'whitelist' })) });
    await worker.processOne(row, deps);
    expect(deps.createMessage).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
    const skipped = deps.db.query.mock.calls.find(c => c[0].includes(`'skipped'`));
    expect(skipped).toBeTruthy();
  });
  test('env kill-switch выключен → отложено на сутки, НЕ skipped, цепочка не завершена', async () => {
    const { deps } = makeDeps({ agentGloballyEnabled: () => false });
    await worker.processOne(row, deps);
    expect(deps.createMessage).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
    const skipped = deps.db.query.mock.calls.find(c => c[0].includes(`'skipped'`));
    expect(skipped).toBeFalsy();
    const completed = deps.db.query.mock.calls.find(c => c[0].includes(`'completed'`));
    expect(completed).toBeFalsy();
    const moved = deps.db.query.mock.calls.find(c => c[0].includes('scheduled_at') && c[1].includes('отложено: агент выключен (env)'));
    expect(moved).toBeTruthy();
  });
  test('гейт outside-schedule → отложено на сутки, НЕ skipped, цепочка не завершена', async () => {
    const { deps } = makeDeps({ isAllowed: jest.fn(async () => ({ allow: false, reason: 'outside-schedule' })) });
    await worker.processOne(row, deps);
    expect(deps.createMessage).not.toHaveBeenCalled();
    expect(deps.sendMessage).not.toHaveBeenCalled();
    const skipped = deps.db.query.mock.calls.find(c => c[0].includes(`'skipped'`));
    expect(skipped).toBeFalsy();
    const completed = deps.db.query.mock.calls.find(c => c[0].includes(`'completed'`));
    expect(completed).toBeFalsy();
    const moved = deps.db.query.mock.calls.find(c => c[0].includes('scheduled_at') && c[1].includes('отложено: вне окна расписания агента'));
    expect(moved).toBeTruthy();
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
  // Требование M1: раздельные исходы сбоя отправки. При at-most-once сбой
  // sendMessage случается ПОСЛЕ записанного sent-маркера — откат в scheduled
  // обязан идти строго после него (порядок проверяется по списку запросов).
  test('сбой отправки при attempts=1 → строка возвращена в scheduled (ретрай)', async () => {
    const { deps } = makeDeps({ sendMessage: jest.fn(async () => { throw new Error('net'); }) });
    await worker.processOne({ ...row, attempts: 1 }, deps);
    const sqls = deps.db.query.mock.calls.map(c => c[0]);
    // SET-форма: sent-маркер сам содержит status='scheduled' в WHERE (гейт).
    const sentIdx = sqls.findIndex(s => s.includes(`SET status='sent'`));
    const backIdx = sqls.findIndex(s => s.includes(`SET status='scheduled'`));
    expect(sentIdx).toBeGreaterThanOrEqual(0);          // маркер был записан до отправки
    expect(backIdx).toBeGreaterThan(sentIdx);           // и откатан после сбоя
    expect(sqls.some(s => s.includes(`'failed'`))).toBe(false);
  });
  test('сбой отправки при attempts=3 → ретраи исчерпаны, строка failed', async () => {
    const { deps } = makeDeps({ sendMessage: jest.fn(async () => { throw new Error('net'); }) });
    await worker.processOne({ ...row, attempts: 3 }, deps);
    const sqls = deps.db.query.mock.calls.map(c => c[0]);
    expect(sqls.some(s => s.includes(`SET status='failed'`))).toBe(true);
    expect(sqls.some(s => s.includes(`SET status='scheduled'`))).toBe(false);
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

// ── at-most-once, таймаут LLM, завершение цепочки, анти-спам (ревизия 2026-08-02) ──
describe('care worker at-most-once', () => {
  test('mark-before-send: UPDATE sent записан в БД ДО вызова sendMessage', async () => {
    const order = [];
    const { deps } = makeDeps();
    deps.db.query = jest.fn(async (sql) => { order.push(sql); return { rowCount: 1 }; });
    deps.sendMessage = jest.fn(async () => { order.push('SEND'); return { id: 777, channel: 'telegram' }; });
    await worker.processOne(row, deps);
    const sentIdx = order.findIndex(s => typeof s === 'string' && s.includes(`status='sent'`));
    const sendIdx = order.indexOf('SEND');
    expect(sentIdx).toBeGreaterThanOrEqual(0);
    expect(sendIdx).toBeGreaterThan(sentIdx);
  });
  test('sendMessage упал при записанном sent-маркере → откат в scheduled + лог отката', async () => {
    const { deps } = makeDeps({ sendMessage: jest.fn(async () => { throw new Error('net down'); }) });
    await worker.processOne(row, deps);
    const rolled = deps.db.query.mock.calls.find(c => c[0].includes(`SET status='scheduled'`));
    expect(rolled).toBeTruthy();
    // Откат стирает и sent_at несостоявшейся отправки (форензика).
    expect(rolled[0]).toContain('sent_at=NULL');
    expect(deps.log.warn).toHaveBeenCalledWith(expect.stringContaining('sent-маркер откатан'));
  });
  test('sent-маркер условный: rowCount=0 (строка перехвачена другим исходом) → не отправляем и не откатываем', async () => {
    // Сценарий: два касания одного enrollment в одном LIMIT-5 батче, первая
    // строка остановила программу и отменила вторую — арендованный
    // enrollment_status='active' второй строки устарел, последний гейт ловит.
    const { deps } = makeDeps();
    deps.db.query = jest.fn(async (sql) => {
      if (sql.includes(`SET status='sent'`)) return { rowCount: 0 };   // маркер не взял строку
      return { rowCount: 1 };
    });
    await worker.processOne(row, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.rememberPending).not.toHaveBeenCalled();
    const sqls = deps.db.query.mock.calls.map(c => c[0]);
    expect(sqls.some(s => s.includes(`SET status='scheduled'`))).toBe(false);   // никакого отката
    expect(sqls.some(s => s.includes(`SET status='failed'`))).toBe(false);
    expect(deps.log.info).toHaveBeenCalledWith(expect.stringContaining('перехвачена другим исходом'));
  });
  test('падение дозаписи delivery_id ПОСЛЕ доставки → sent НЕ откатывается в scheduled', async () => {
    const { deps } = makeDeps();
    deps.db.query = jest.fn(async (sql) => {
      if (sql.includes('delivery_id')) throw new Error('db hiccup');
      return { rowCount: 1 };
    });
    await worker.processOne(row, deps);
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    const sqls = deps.db.query.mock.calls.map(c => c[0]);
    expect(sqls.some(s => s.includes(`SET status='scheduled'`))).toBe(false);
    expect(deps.log.error).toHaveBeenCalledWith(expect.stringContaining('persist delivery'));
  });
  test('падение пост-обработки ПОСЛЕ доставки → re-mark sent, никакого scheduled', async () => {
    // rememberPending бросает синхронно уже после успешного sendMessage —
    // единственный путь в общий catch при delivered=true.
    const { deps } = makeDeps({ rememberPending: jest.fn(() => { throw new Error('boom'); }) });
    await worker.processOne(row, deps);
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    const sqls = deps.db.query.mock.calls.map(c => c[0]);
    expect(sqls.some(s => s.includes(`SET status='scheduled'`))).toBe(false);
    // Best-effort re-mark 'sent' с текстом ошибки (запрос с error=, без sent_at).
    const remark = deps.db.query.mock.calls.find(c => c[0].includes(`status='sent', error=`));
    expect(remark).toBeTruthy();
    expect(deps.log.error).toHaveBeenCalledWith(expect.stringContaining('доставлено'));
  });
  test('детерминированный skip (гейт) последнего касания → проверка завершения цепочки', async () => {
    // oneOrNone → null: scheduled-строк не осталось → enrollment completed.
    const { deps } = makeDeps({ isAllowed: jest.fn(async () => ({ allow: false, reason: 'whitelist' })) });
    await worker.processOne(row, deps);
    const chainCheck = deps.db.oneOrNone.mock.calls.find(c => c[0].includes(`status='scheduled'`));
    expect(chainCheck).toBeTruthy();
    expect(chainCheck[1]).toEqual([11]);   // enrollment_id
    const completed = deps.db.query.mock.calls.find(c => c[0].includes(`'completed'`));
    expect(completed).toBeTruthy();
  });
  test('детерминированный skip при оставшихся scheduled → enrollment НЕ completed', async () => {
    const { deps } = makeDeps({ isAllowed: jest.fn(async () => ({ allow: false, reason: 'whitelist' })) });
    deps.db.oneOrNone = jest.fn(async () => ({ '?column?': 1 }));   // ещё есть scheduled
    await worker.processOne(row, deps);
    const completed = deps.db.query.mock.calls.find(c => c[0].includes(`'completed'`));
    expect(completed).toBeFalsy();
  });
  test('таймаут LLM: зависший провайдер → строка на ретрай, sendMessage не вызван', async () => {
    jest.useFakeTimers();
    try {
      const { deps } = makeDeps({ createMessage: jest.fn(() => new Promise(() => {})) });   // висит вечно
      const p = worker.processOne(row, deps);
      // Прогоняем цепочку await'ов до Promise.race (моки резолвятся микротасками).
      for (let i = 0; i < 200; i++) await Promise.resolve();
      jest.advanceTimersByTime(60001);
      await p;
      expect(deps.sendMessage).not.toHaveBeenCalled();
      const rolled = deps.db.query.mock.calls.find(c => c[0].includes(`SET status='scheduled'`));
      expect(rolled).toBeTruthy();
      expect(String(rolled[1][1])).toMatch(/timeout/);
    } finally { jest.useRealTimers(); }
  });
  test('анти-спам: просроченная на неделю строка уезжает в будущее одним сдвигом', async () => {
    const { deps } = makeDeps({ sentTodayExists: jest.fn(async () => true) });
    const stale = { ...row, scheduled_at: new Date(Date.now() - 7 * 24 * 3600 * 1000) };
    await worker.processOne(stale, deps);
    const moved = deps.db.query.mock.calls.find(c => c[0].includes('scheduled_at'));
    expect(moved).toBeTruthy();
    const next = moved[1][1];
    expect(next instanceof Date).toBe(true);
    expect(next.getTime()).toBeGreaterThan(Date.now());   // > now, а не «вчера + день»
  });
});

describe('care worker processTick', () => {
  test('guard: тик не наслаивается на ещё живой предыдущий', async () => {
    let release;
    let firstLease = true;
    const { deps } = makeDeps();
    deps.db.any = jest.fn(() => {
      if (!firstLease) return Promise.resolve([]);
      firstLease = false;
      return new Promise(res => { release = () => res([]); });   // висит до release()
    });
    const p1 = worker.processTick(deps);
    await worker.processTick(deps);               // guard: выходит сразу, аренду не зовёт
    expect(deps.db.any).toHaveBeenCalledTimes(1);
    release();
    await p1;
    await worker.processTick(deps);               // после завершения тик снова работает
    expect(deps.db.any).toHaveBeenCalledTimes(2);
  });
  test('касание удалено из программы → cancelled + проверка завершения цепочки', async () => {
    const { deps } = makeDeps();
    deps.db.any = jest.fn(async () => [{ ...row, intent_text: null }]);
    await worker.processTick(deps);
    const cancelled = deps.db.query.mock.calls.find(c => c[0].includes(`'cancelled'`));
    expect(cancelled).toBeTruthy();
    const chainCheck = deps.db.oneOrNone.mock.calls.find(c => c[0].includes(`status='scheduled'`));
    expect(chainCheck).toBeTruthy();
  });
});
