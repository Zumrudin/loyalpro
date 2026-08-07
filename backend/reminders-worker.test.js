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
      escalateDialog: jest.fn(async () => {}),
      log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      ...over,
    },
  };
}

const find = (updates, re) => updates.filter(u => re.test(u.sql));

// Порядок вызовов через глобальный счётчик jest (invocationCallOrder) — тот
// же приём для мока db.query (у него много разных SQL за один processOne):
// находим ПЕРВЫЙ вызов, чей SQL матчит regex, и берём его порядковый номер.
function firstQueryOrder(queryMock, re) {
  const idx = queryMock.mock.calls.findIndex(([sql]) => re.test(sql));
  return idx === -1 ? null : queryMock.mock.invocationCallOrder[idx];
}

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

describe('отправка и бонусы', () => {
  test('happy path: текст по ступени, бонусы записаны, флаг повешен', async () => {
    const { updates, deps } = makeDeps();
    await worker.processOne(ROW, deps);
    expect(deps.applyBonus).toHaveBeenCalledWith(1, 777, ROW.bonus_tiers, ROW.rule_title);
    expect(deps.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      phone: '79200255591',
      text: 'Мария, начислили 300 бонусов!',
    }));
    expect(deps.mute).toHaveBeenCalledWith(1, 5, '79200255591', expect.any(String));
    expect(find(updates, /bonus_accrued=\$4/).length).toBe(1);
  });

  // Захват строки условным UPDATE — теперь ПОСЛЕДНИЙ гейт перед самой
  // отправкой (после бонусов и buildText, см. «захват — после бонусов и
  // buildText» ниже), поэтому к моменту перехвата бонусы уже МОГЛИ быть
  // начислены — это ожидаемо и безопасно: результат уже записан в строку
  // (bonus_accrued и т.д.), следующая аренда его не начислит повторно
  // (ветка bonus_accrued != null), а не отправленное сообщение просто не
  // уйдёт. Поэтому здесь мы проверяем главное — не отправку и не мьют, а
  // не сами бонусы.
  test('перехваченная строка не отправляется', async () => {
    const { deps } = makeDeps({
      db: {
        any: jest.fn(async () => []),
        query: jest.fn(async (sql) => ({ rowCount: /SET status='sent'/.test(sql) ? 0 : 1 })),
        oneOrNone: jest.fn(async () => null),
      },
    });
    await worker.processOne(ROW, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.mute).not.toHaveBeenCalled();
  });

  // Начисление необратимо: повторный заход по строке, где бонусы уже
  // записаны, обязан взять сохранённое значение, а не начислить второй раз.
  test('повторная попытка не начисляет бонусы дважды', async () => {
    const { deps } = makeDeps();
    const retried = { ...ROW, balance_before: 120, bonus_tier: 'accrue', bonus_accrued: 300, bonus_txn_ok: true };
    await worker.processOne(retried, deps);
    expect(deps.applyBonus).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Мария, начислили 300 бонусов!',
    }));
  });

  // Сбой отправки: строка возвращается в scheduled, бонусы НЕ откатываются
  // (утверждено: «сначала начислить, отката нет»), флаг анти-повтора не висит.
  test('сбой отправки возвращает строку в scheduled и не вешает флаг', async () => {
    const { updates, deps } = makeDeps({ sendMessage: jest.fn(async () => { throw new Error('chatpush 500'); }) });
    await worker.processOne(ROW, deps);
    expect(find(updates, /SET status='scheduled'/).length).toBe(1);
    expect(deps.mute).not.toHaveBeenCalled();
  });

  test('исчерпание попыток → failed', async () => {
    const { updates, deps } = makeDeps({ sendMessage: jest.fn(async () => { throw new Error('chatpush 500'); }) });
    await worker.processOne({ ...ROW, attempts: 3 }, deps);
    expect(find(updates, /status='failed'/).length).toBe(1);
  });

  // Доставлено, но упала пост-обработка — статус НЕ откатывать: ретрай = дубль.
  test('падение после доставки не откатывает статус', async () => {
    const { updates, deps } = makeDeps({ mute: jest.fn(async () => { throw new Error('db'); }) });
    await worker.processOne(ROW, deps);
    expect(find(updates, /SET status='scheduled'/).length).toBe(0);
    expect(deps.sendMessage).toHaveBeenCalled();
  });

  // Бонусов нет (нет карты / сбой YClients) — уходит БАЗОВЫЙ текст правила,
  // ни слова про бонусы. Это утверждённое поведение «слать без бонусов».
  test('no_bonus → базовый текст правила без бонусной части', async () => {
    const { deps } = makeDeps({
      applyBonus: jest.fn(async () => ({ balanceBefore: null, tier: 'no_bonus', accrued: 0, txnOk: null })),
    });
    await worker.processOne(ROW, deps);
    expect(deps.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Мария, пора повторить Лазерная эпиляция!',
    }));
  });

  test('bonus_enabled=false → YClients не дёргается вовсе', async () => {
    const { deps } = makeDeps();
    await worker.processOne({ ...ROW, bonus_enabled: false }, deps);
    expect(deps.applyBonus).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalled();
  });

  test('режим free зовёт LLM и шлёт её текст', async () => {
    const { deps } = makeDeps({
      createMessage: jest.fn(async () => ({ text: '{"action":"send","text":"Мария, будем рады видеть вас снова!","reason":"ок"}' })),
    });
    await worker.processOne({ ...ROW, text_mode: 'free' }, deps);
    expect(deps.createMessage).toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Мария, будем рады видеть вас снова!',
    }));
  });

  test('в режиме free решение «не слать» даёт skipped без отправки', async () => {
    const { updates, deps } = makeDeps({
      createMessage: jest.fn(async () => ({ text: '{"action":"skip","reason":"клиент просил не писать"}' })),
    });
    await worker.processOne({ ...ROW, text_mode: 'free' }, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(find(updates, /status='skipped'/).length).toBe(1);
  });

  test('reply-guard заблокировал текст → skipped', async () => {
    const { updates, deps } = makeDeps({ hardViolations: jest.fn(() => [{ type: 'internals_leak' }]) });
    await worker.processOne(ROW, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(find(updates, /status='skipped'/).length).toBe(1);
  });

  test('whatsapp дополнительно персистится в историю чата', async () => {
    const { deps } = makeDeps({ sendMessage: jest.fn(async () => ({ id: 1, channel: 'whatsapp' })) });
    await worker.processOne(ROW, deps);
    expect(deps.persistWhatsapp).toHaveBeenCalled();
  });

  // КРИТИЧНО (ревью): захват строки (SET status='sent') обязан идти ПОСЛЕ
  // бонусов и ПОСЛЕ buildText (в т.ч. LLM-вызова в режиме free), а не до —
  // иначе крэш процесса в этом окне (OOM, pm2 restart) оставляет строку
  // status='sent' без reality отправки, и LEASE_SQL её больше не арендует
  // никогда (арендует только 'scheduled').
  test('захват строки происходит ПОСЛЕ applyBonus', async () => {
    const { deps } = makeDeps();
    await worker.processOne(ROW, deps);
    const bonusOrder = deps.applyBonus.mock.invocationCallOrder[0];
    const captureOrder = firstQueryOrder(deps.db.query, /SET status='sent'/);
    expect(bonusOrder).not.toBeNull();
    expect(captureOrder).not.toBeNull();
    expect(bonusOrder).toBeLessThan(captureOrder);
  });

  test('в режиме free захват строки происходит ПОСЛЕ createMessage (LLM)', async () => {
    const { deps } = makeDeps({
      createMessage: jest.fn(async () => ({ text: '{"action":"send","text":"Мария, привет!","reason":"ок"}' })),
    });
    await worker.processOne({ ...ROW, text_mode: 'free' }, deps);
    const llmOrder = deps.createMessage.mock.invocationCallOrder[0];
    const captureOrder = firstQueryOrder(deps.db.query, /SET status='sent'/);
    expect(llmOrder).not.toBeNull();
    expect(captureOrder).not.toBeNull();
    expect(llmOrder).toBeLessThan(captureOrder);
  });

  // КРИТИЧНО (ревью): care-промпт обещает action='escalate' при осложнении
  // после процедуры — воркер обязан реально перевести диалог на оператора
  // тем же способом, что care-воркер, а не молча гасить сообщение.
  test('free + escalate: диалог эскалирован, сообщение не отправлено, причина в строке', async () => {
    const { updates, deps } = makeDeps({
      createMessage: jest.fn(async () => ({ text: '{"action":"escalate","reason":"пациент пишет про отёк"}' })),
    });
    await worker.processOne({ ...ROW, text_mode: 'free' }, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.escalateDialog).toHaveBeenCalledWith(1, '79200255591', expect.stringContaining('пациент пишет про отёк'));
    const skipped = find(updates, /status='skipped'/);
    expect(skipped.length).toBe(1);
    expect(skipped[0].params.some(p => typeof p === 'string' && p.includes('пациент пишет про отёк'))).toBe(true);
  });

  // КРИТИЧНО (ревью): action='stop_program' (просьба «не пишите мне»)
  // обязан гасить правило НАВСЕГДА (source='manual' — автоснятие при визите
  // в enroll.js бьёт только по source='auto'), а не одно сообщение.
  test('free + stop_program: не отправлено, флаг анти-повтора с источником manual, причина в строке', async () => {
    const { updates, deps } = makeDeps({
      createMessage: jest.fn(async () => ({ text: '{"action":"stop_program","status":"declined","reason":"просил не писать"}' })),
    });
    await worker.processOne({ ...ROW, text_mode: 'free' }, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.mute).toHaveBeenCalledWith(1, 5, '79200255591', expect.stringContaining('просил не писать'), 'manual');
    const cancelled = find(updates, /status='cancelled'/);
    expect(cancelled.length).toBe(1);
    expect(cancelled[0].params.some(p => typeof p === 'string' && p.includes('просил не писать'))).toBe(true);
  });

  // decision.reason не должен теряться — раньше любой не-send исход тонул
  // в общей формулировке «текст напоминания пуст».
  test('free + skip: причина строки содержит reason LLM, а не общую формулировку', async () => {
    const { updates, deps } = makeDeps({
      createMessage: jest.fn(async () => ({ text: '{"action":"skip","reason":"пациент уже обсуждал это с оператором"}' })),
    });
    await worker.processOne({ ...ROW, text_mode: 'free' }, deps);
    const skipped = find(updates, /status='skipped'/);
    expect(skipped.length).toBe(1);
    expect(skipped[0].params.some(p => typeof p === 'string' && p.includes('пациент уже обсуждал это с оператором'))).toBe(true);
  });

  // Таймаут/сбой LLM теперь происходит ДО захвата строки — строка не должна
  // ни разу перейти в 'sent', отправка не должна происходить.
  test('таймаут/сбой LLM: строка не переходит в sent, отправка не происходит', async () => {
    const { updates, deps } = makeDeps({
      createMessage: jest.fn(async () => { throw new Error('reminder LLM timeout 60000ms'); }),
    });
    await worker.processOne({ ...ROW, text_mode: 'free' }, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(find(updates, /SET status='sent'/).length).toBe(0);
  });
});

describe('processTick', () => {
  test('гасит строки удалённых правил', async () => {
    const { updates, deps } = makeDeps();
    await worker.processTick(deps);
    expect(updates.some(u => /rule_id IS NULL/.test(u.sql))).toBe(true);
  });
});
