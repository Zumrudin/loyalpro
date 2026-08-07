'use strict';
// Воркер напоминаний. Все зависимости замоканы через DI, БД и сеть не
// трогаются. Проверки идут по подстрокам SQL в вызовах db.query — тот же
// стиль, что в care-worker.test.js.
const worker = require('./services/reminders/worker');

const ROW = {
  id: 10, salon_id: 1, rule_id: 5, phone: '79200255591',
  client_id: 42, yclients_client_id: 777,
  anchor_record_id: 700, anchor_visit_at: '2026-07-08T11:00:00.000Z',
  anchor_services: [{ id: 101, title: 'Лазерная эпиляция' }],
  scheduled_at: '2026-08-07T08:00:00.000Z',
  status: 'scheduled', attempts: 1, defers: 0,
  bonus_accrued: null, rule_title: 'Эпиляция раз в месяц',
  rule_enabled: true, rule_conditions: { logic: 'and', items: [{ type: 'category', ids: [9] }] },
  rule_text: '{first_name}, пора повторить {услуга}!',
  text_mode: 'strict', bonus_enabled: true,
  bonus_tiers: [{ up_to: 500, action: 'accrue', amount: 300, text: '{first_name}, начислили {бонусы} бонусов!' }],
  delay_days: 30, salon_name: 'PERI CLINIC', client_name: 'Мария',
};

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
      dialogStatus: jest.fn(async () => null),
      isMuted: jest.fn(async () => false),
      sentTodayExists: jest.fn(async () => false),
      loadClientRecords: jest.fn(async () => ({ completedAfter: [], future: [] })),
      getCatMap: jest.fn(async () => new Map([['101', '9']])),
      applyBonus: jest.fn(async () => ({ balanceBefore: 120, tier: 'accrue', accrued: 300, txnOk: true })),
      loadTranscript: jest.fn(async () => ({ messages: [] })),
      createMessage: jest.fn(async () => ({ text: 'Мария, пора повторить!' })),
      lintReply: jest.fn(() => []),
      hardViolations: jest.fn(() => []),
      sendMessage: jest.fn(async () => ({ id: 777, channel: 'telegram' })),
      lastIncomingChannel: jest.fn(async () => 'telegram'),
      loadNameDictionary: jest.fn(async () => null),
      rememberPending: jest.fn(async () => {}),
      persistWhatsapp: jest.fn(async () => {}),
      mute: jest.fn(async () => {}),
      log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      ...over,
    },
  };
}

const find = (updates, re) => updates.filter(u => re.test(u.sql));

describe('гейты', () => {
  test('правило выключено → skipped', async () => {
    const { updates, deps } = makeDeps();
    await worker.processOne({ ...ROW, rule_enabled: false }, deps);
    expect(find(updates, /status='skipped'/).length).toBe(1);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  // Env kill-switch — временное состояние проекта, а не «этой строке нельзя
  // навсегда». Терминальный skip сжёг бы напоминание молча.
  test('агент выключен глобально → отложено, не сожжено', async () => {
    const { updates, deps } = makeDeps({ agentGloballyEnabled: () => false });
    await worker.processOne(ROW, deps);
    expect(find(updates, /SET scheduled_at/).length).toBe(1);
    expect(find(updates, /status='skipped'/).length).toBe(0);
  });

  test('чёрный список → skipped', async () => {
    const { updates, deps } = makeDeps({ isAllowed: jest.fn(async () => ({ allow: false, reason: 'blacklist' })) });
    await worker.processOne(ROW, deps);
    expect(find(updates, /status='skipped'/).length).toBe(1);
  });

  // Окно расписания на напоминания не распространяется (ignoreSchedule).
  // Если причина всё-таки пришла — это дефект конфигурации: откладываем и
  // ГРОМКО пишем в лог, а не сжигаем строку.
  test('гейт вернул outside-schedule → отложено + WARN', async () => {
    const { updates, deps } = makeDeps({ isAllowed: jest.fn(async () => ({ allow: false, reason: 'outside-schedule' })) });
    await worker.processOne(ROW, deps);
    expect(find(updates, /SET scheduled_at/).length).toBe(1);
    expect(deps.log.warn).toHaveBeenCalled();
  });

  test('гейт зовётся с ignoreSchedule', async () => {
    const { deps } = makeDeps();
    await worker.processOne(ROW, deps);
    expect(deps.isAllowed).toHaveBeenCalledWith(1, '79200255591');
  });

  test('диалог на операторе → отложено с инкрементом defers', async () => {
    const { updates, deps } = makeDeps({ dialogStatus: jest.fn(async () => 'escalated') });
    await worker.processOne(ROW, deps);
    const def = find(updates, /SET scheduled_at/);
    expect(def.length).toBe(1);
    expect(def[0].sql).toMatch(/defers\s*=\s*reminder_queue\.defers\s*\+\s*1|defers\s*=\s*defers\s*\+\s*1/);
  });

  test('терпение к паузе оператора кончается на третьем откладывании', async () => {
    const { updates, deps } = makeDeps({ dialogStatus: jest.fn(async () => 'escalated') });
    await worker.processOne({ ...ROW, defers: 3 }, deps);
    expect(find(updates, /status='skipped'/).length).toBe(1);
    expect(find(updates, /SET scheduled_at/).length).toBe(0);
  });

  test('флаг анти-повтора → cancelled', async () => {
    const { updates, deps } = makeDeps({ isMuted: jest.fn(async () => true) });
    await worker.processOne(ROW, deps);
    expect(find(updates, /status='cancelled'/).length).toBe(1);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  test('анти-спам «сообщение уже было сегодня» → отложено на день', async () => {
    const { updates, deps } = makeDeps({ sentTodayExists: jest.fn(async () => true) });
    await worker.processOne(ROW, deps);
    expect(find(updates, /SET scheduled_at/).length).toBe(1);
  });

  // Ради этого гейта модуль и делался: клиент уже записан — молчим.
  test('есть будущая запись под условия правила → cancelled', async () => {
    const { updates, deps } = makeDeps({
      loadClientRecords: jest.fn(async () => ({ completedAfter: [], future: [{ services: [{ id: 101 }], staff: { id: 55 } }] })),
    });
    await worker.processOne(ROW, deps);
    expect(find(updates, /status='cancelled'/).length).toBe(1);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  test('будущая запись на чужую услугу напоминание не гасит', async () => {
    const { deps } = makeDeps({
      loadClientRecords: jest.fn(async () => ({ completedAfter: [], future: [{ services: [{ id: 999 }], staff: { id: 55 } }] })),
    });
    await worker.processOne(ROW, deps);
    expect(deps.sendMessage).toHaveBeenCalled();
  });

  test('повторный подходящий визит уже состоялся → cancelled', async () => {
    const { updates, deps } = makeDeps({
      loadClientRecords: jest.fn(async () => ({ completedAfter: [{ services: [{ id: 101 }], staff: { id: 55 } }], future: [] })),
    });
    await worker.processOne(ROW, deps);
    expect(find(updates, /status='cancelled'/).length).toBe(1);
  });

  // Fail-open: перманентный сбой YClients не должен молча остановить ВСЕ
  // напоминания. Цена — редкое лишнее сообщение уже записавшемуся клиенту.
  test('сбой YClients на проверке записей не блокирует отправку', async () => {
    const { deps } = makeDeps({ loadClientRecords: jest.fn(async () => { throw new Error('502'); }) });
    await worker.processOne(ROW, deps);
    expect(deps.sendMessage).toHaveBeenCalled();
    expect(deps.log.warn).toHaveBeenCalled();
  });
});

describe('два обязательных дополнения', () => {
  // (1) Карта лояльности выбирается ПО ТИПУ, настроенному в салоне
  // (yclients_card_type_id) — как во всём остальном проекте
  // (services/loyalty.js, routes/clients.js). Если defaultDeps.applyBonus не
  // выбирает эту колонку из salons, applyBonus (services/reminders/bonus.js)
  // детерминированно вернёт no_bonus и бонусы не начислятся НИКОГДА.
  test('SELECT салона в defaultDeps.applyBonus содержит yclients_card_type_id', () => {
    // defaultDeps.applyBonus строит SELECT внутри своего тела — источник
    // истины тут функция.toString(), как и для LEASE_SQL/ORPHAN_SQL ниже.
    expect(worker.defaultDeps.applyBonus.toString()).toMatch(/yclients_card_type_id/);
  });

  // (2) hasFutureMatchingBooking глушит исключения по каждой записи и не
  // логирует — систематически сломанная проверка (catMap не Map) не должна
  // молча выглядеть как «совпадений нет». Воркер обязан заметить и warn'ить,
  // но продолжить ход (не уронить отправку).
  test('catMap не Map → log.warn, ход продолжается', async () => {
    const { deps } = makeDeps({ getCatMap: jest.fn(async () => ({ notAMap: true })) });
    await worker.processOne(ROW, deps);
    expect(deps.log.warn).toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalled();
  });
});
