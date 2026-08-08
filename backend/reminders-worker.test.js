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
  // SELECT общий у боевого applyBonus и у сухого applyBonusDry (тестовая
  // отправка) — источник истины тут функция.toString() загрузчика, как и для
  // LEASE_SQL/ORPHAN_SQL ниже.
  test('SELECT салона для бонусов содержит yclients_card_type_id', () => {
    expect(worker.loadBonusSalon.toString()).toMatch(/yclients_card_type_id/);
    expect(worker.defaultDeps.applyBonus.toString()).toMatch(/loadBonusSalon/);
    expect(worker.defaultDeps.applyBonusDry.toString()).toMatch(/loadBonusSalon/);
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

  // Воркер обязан звать СВОЙ промпт напоминаний, а не care-промпт «Заботы».
  // До 08.08.2026 тут стоял buildCarePrompt, и его рамка («плановое касание
  // заботы после визита, это НЕ продажа» + правило «не пиши поверх переписки
  // про эту процедуру») давала систематический skip на любой живой переписке:
  // измерено 6 отказов из 6 на боевом провайдере. Возврат к care-промпту
  // выглядел бы безобидной унификацией — этот тест его ловит.
  test('режим free зовёт ПРОМПТ НАПОМИНАНИЙ, а не care-промпт', async () => {
    const { deps } = makeDeps({
      createMessage: jest.fn(async () => ({ text: '{"action":"send","text":"Мария, пора повторить","reason":"ок"}' })),
    });
    await worker.processOne({ ...ROW, text_mode: 'free' }, deps);
    const { system, messages } = deps.createMessage.mock.calls[0][0];
    expect(system).toContain('НАПОМИНАНИЕ О ПОВТОРНОМ ВИЗИТЕ');
    expect(system).toContain('НЕ ПОВОД МОЛЧАТЬ');
    expect(system).not.toMatch(/касание заботы:/);
    // Заготовка смысла приходит УЖЕ с подставленными цифрами (renderReminderText):
    // текст ступени бонусов с реально начисленной суммой, а не обещание.
    expect(messages[0].content).toContain('начислили 300 бонусов');
    expect(messages[0].content).toContain('Лазерная эпиляция');
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

// КРИТИЧНО (финальное ревью): у ycAccrueCard (внутри applyBonus) НЕТ ключа
// идемпотентности. Если между успешным начислением и записью результата
// (UPDATE ... bonus_accrued=$4) процесс упадёт/оборвёт соединение с БД,
// строка вернётся в scheduled с bonus_accrued IS NULL, и следующая аренда
// СНОВА войдёт в ветку начисления — деньги спишутся дважды, откатить нельзя.
// Единственная защита — записать НАМЕРЕНИЕ ('pending') ДО вызова applyBonus:
// тогда при обрыве повторная аренда видит pending и НЕ начисляет повторно
// (пропущенное начисление дешевле двойного — та же философия at-most-once).
describe('окно двойного начисления (bonus_tier=pending)', () => {
  test('сбой записи результата после успешного начисления: строка scheduled, помечена pending, повтор не начисляет', async () => {
    const { updates, deps } = makeDeps({
      db: {
        any: jest.fn(async () => []),
        query: jest.fn(async (sql, params) => {
          updates.push({ sql, params });
          if (/bonus_accrued=\$4/.test(sql)) throw new Error('connection lost');
          return { rowCount: 1 };
        }),
        oneOrNone: jest.fn(async () => null),
      },
    });
    await worker.processOne(ROW, deps);
    expect(deps.applyBonus).toHaveBeenCalledTimes(1);
    // Намерение записано ДО падения — строка в БД осталась помеченной pending.
    expect(find(updates, /bonus_tier='pending'/).length).toBe(1);
    // Отправки не произошло, строка вернулась в scheduled (не sent, не failed).
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(find(updates, /SET status='scheduled'/).length).toBe(1);

    // Повторный заход "как из БД" после сбоя: bonus_tier уже 'pending',
    // bonus_accrued всё ещё NULL — applyBonus звать НЕЛЬЗЯ.
    const { deps: deps2 } = makeDeps();
    const retried = { ...ROW, bonus_tier: 'pending' };
    await worker.processOne(retried, deps2);
    expect(deps2.applyBonus).not.toHaveBeenCalled();
  });

  test('строка bonus_tier=pending уходит с базовым текстом без бонусной части и WARN в логе', async () => {
    const { deps } = makeDeps();
    const pendingRow = { ...ROW, bonus_tier: 'pending' };
    await worker.processOne(pendingRow, deps);
    expect(deps.applyBonus).not.toHaveBeenCalled();
    expect(deps.log.warn).toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Мария, пора повторить Лазерная эпиляция!',
    }));
  });

  test('пометка pending ставится ДО вызова applyBonus', async () => {
    const { deps } = makeDeps();
    await worker.processOne(ROW, deps);
    const claimOrder = firstQueryOrder(deps.db.query, /bonus_tier='pending'/);
    const bonusOrder = deps.applyBonus.mock.invocationCallOrder[0];
    expect(claimOrder).not.toBeNull();
    expect(bonusOrder).not.toBeNull();
    expect(claimOrder).toBeLessThan(bonusOrder);
  });

  test('claim rowCount=0 (кто-то опередил) → applyBonus не зовётся', async () => {
    const { deps } = makeDeps({
      db: {
        any: jest.fn(async () => []),
        query: jest.fn(async (sql) => ({ rowCount: /bonus_tier='pending'/.test(sql) ? 0 : 1 })),
        oneOrNone: jest.fn(async () => null),
      },
    });
    await worker.processOne(ROW, deps);
    expect(deps.applyBonus).not.toHaveBeenCalled();
  });
});

// Менее острая, но видимая проблема (финальное ревью): бонусы считаются
// РАНЬШЕ решения Милы (текст обязан содержать фактическую сумму), поэтому
// если решение окажется escalate/stop_program (сообщение не уйдёт вовсе),
// деньги на карте клиента уже необратимо начислены. Порядок НЕ меняем — это
// решение владельца продукта, а не техническое; здесь только наблюдаемость.
describe('видимость: бонус начислен, а сообщение не уйдёт (escalate/stop_program)', () => {
  test('free + escalate после начисления: decision_reason содержит причину модели И упоминание бонусов, WARN вызван', async () => {
    const { updates, deps } = makeDeps({
      applyBonus: jest.fn(async () => ({ balanceBefore: 120, tier: 'accrue', accrued: 300, txnOk: true })),
      createMessage: jest.fn(async () => ({ text: '{"action":"escalate","reason":"пациент пишет про отёк"}' })),
    });
    await worker.processOne({ ...ROW, text_mode: 'free' }, deps);
    expect(deps.log.warn).toHaveBeenCalled();
    const skipped = find(updates, /status='skipped'/);
    expect(skipped.length).toBe(1);
    const reasonParam = skipped[0].params.find(p => typeof p === 'string');
    expect(reasonParam).toEqual(expect.stringContaining('пациент пишет про отёк'));
    expect(reasonParam).toEqual(expect.stringContaining('300'));
  });

  test('free + escalate без начисления (no_bonus): в decision_reason нет лишнего упоминания бонусов', async () => {
    const { updates, deps } = makeDeps({
      applyBonus: jest.fn(async () => ({ balanceBefore: null, tier: 'no_bonus', accrued: 0, txnOk: null })),
      createMessage: jest.fn(async () => ({ text: '{"action":"escalate","reason":"пациент пишет про отёк"}' })),
    });
    await worker.processOne({ ...ROW, text_mode: 'free' }, deps);
    const skipped = find(updates, /status='skipped'/);
    expect(skipped.length).toBe(1);
    const reasonParam = skipped[0].params.find(p => typeof p === 'string');
    expect(reasonParam).toEqual(expect.stringContaining('пациент пишет про отёк'));
    expect(reasonParam).not.toMatch(/бонус/i);
  });
});

describe('processTick', () => {
  test('гасит строки удалённых правил', async () => {
    const { updates, deps } = makeDeps();
    await worker.processTick(deps);
    expect(updates.some(u => /rule_id IS NULL/.test(u.sql))).toBe(true);
  });
});

// ── тестовая отправка на свой номер ────────────────────────────
// Прогон идёт ТЕМ ЖЕ processOne, что и боевой: расхождение теста с боевым
// путём означало бы, что тест ничего не доказывает. Отличий ровно четыре, и
// каждое — про то, что тест не должен портить боевое состояние клиента.

const TEST_ROW = { ...ROW, id: 11, source: 'test', scheduled_at: '2026-08-08T10:00:00.000Z' };

function testDeps(over = {}) {
  const made = makeDeps({ applyBonusDry: jest.fn(async () => ({
    balanceBefore: 120, tier: 'accrue', accrued: 300, txnOk: null,
    note: 'ТЕСТ: бонусы РЕАЛЬНО НЕ начислялись (сухой прогон)',
  })), ...over });
  made.deps.db.any = jest.fn(async () => [TEST_ROW]);
  return made;
}

describe('тестовая отправка: аренда по id', () => {
  // Тестовая строка стоит в БУДУЩЕМ (test-send.js), чтобы её не перехватил
  // боевой тик со своими deps. Условие due её бы не нашло — адресуемся по id.
  test('LEASE_ONE_SQL адресуется по id и не смотрит на scheduled_at', () => {
    expect(worker.LEASE_ONE_SQL).toMatch(/id = \$1/);
    expect(worker.LEASE_ONE_SQL).not.toMatch(/scheduled_at <= NOW\(\)/);
    expect(worker.LEASE_SQL).toMatch(/scheduled_at <= NOW\(\)/);
  });

  // Колонки RETURNING — контракт со всем processOne (rule_text, text_mode,
  // bonus_tiers, client_name…). Разъехавшиеся копии означали бы, что тест
  // гоняет строку с другим набором полей, чем боевой путь.
  test('набор колонок RETURNING общий с боевой арендой', () => {
    const ret = (sql) => sql.slice(sql.indexOf('RETURNING'));
    expect(ret(worker.LEASE_ONE_SQL)).toBe(ret(worker.LEASE_SQL));
  });

  test('строку уже забрали → null, processOne не зовётся', async () => {
    const { deps } = testDeps();
    deps.db.any = jest.fn(async () => []);
    expect(await worker.processTestRow(11, {}, deps)).toBeNull();
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
});

describe('тестовая отправка: чего тест НЕ портит', () => {
  test('анти-повтор не ставится и прошлый не мешает', async () => {
    const { deps } = testDeps({ isMuted: jest.fn(async () => true) });
    await worker.processTestRow(11, {}, deps);
    expect(deps.sendMessage).toHaveBeenCalled();
    expect(deps.mute).not.toHaveBeenCalled();
  });

  // Иначе второй тест в тот же день (и любое сегодняшнее плановое сообщение
  // этому клиенту) молча уезжал бы на завтра вместо отправки.
  test('дневной лимит не применяется', async () => {
    const { deps } = testDeps({ sentTodayExists: jest.fn(async () => true) });
    await worker.processTestRow(11, {}, deps);
    expect(deps.sendMessage).toHaveBeenCalled();
  });

  // У живого администратора своя история визитов: боевые гейты «уже записан» /
  // «повторный визит состоялся» отменили бы тест, и он не увидел бы ни текста,
  // ни ступени — ровно того, ради чего тест и запускается.
  test('живые записи клиента тест не отменяют', async () => {
    const { updates, deps } = testDeps({
      loadClientRecords: jest.fn(async () => ({ completedAfter: [ROW], future: [ROW] })),
    });
    await worker.processTestRow(11, {}, deps);
    // Уборочный UPDATE в finally тоже ставит 'cancelled', но только строке,
    // оставшейся 'scheduled' — отменой ПО ГЕЙТУ он не является.
    const byGate = find(updates, /status='cancelled'/).filter(u => !/AND status='scheduled'/.test(u.sql));
    expect(byGate.length).toBe(0);
    expect(deps.sendMessage).toHaveBeenCalled();
  });
});

describe('тестовая отправка: бонусы', () => {
  // Ради этого тест и нужен: правило проверяют ДО того, как включить его в
  // массы, то есть выключенным. Гейт rule_enabled защищает очередь от строк
  // отключённого правила — а тут администратор нажал «тест» на нём явно.
  test('выключенное правило всё равно тестируется', async () => {
    const { deps } = testDeps();
    deps.db.any = jest.fn(async () => [{ ...TEST_ROW, rule_enabled: false }]);
    await worker.processTestRow(11, {}, deps);
    expect(deps.sendMessage).toHaveBeenCalled();
  });

  test('по умолчанию сухой прогон: ступень считается, деньги не уходят', async () => {
    const { updates, deps } = testDeps();
    await worker.processTestRow(11, {}, deps);
    expect(deps.applyBonusDry).toHaveBeenCalled();
    expect(deps.applyBonus).not.toHaveBeenCalled();
    // Ступень и сумма всё равно записаны — иначе тест не показал бы, ЧТО
    // начислилось бы, и текст ступени отрендерился бы не тот.
    const bonusUpd = find(updates, /SET balance_before/)[0];
    expect(bonusUpd.params).toEqual(expect.arrayContaining([120, 'accrue', 300]));
    const sentReason = find(updates, /SET delivery_id/)[0].params.join(' ');
    expect(sentReason).toMatch(/сухой прогон/i);
  });

  test('явное согласие → боевое начисление', async () => {
    const { deps } = testDeps();
    await worker.processTestRow(11, { accrue: true }, deps);
    expect(deps.applyBonus).toHaveBeenCalled();
    expect(deps.applyBonusDry).not.toHaveBeenCalled();
  });
});

describe('тестовая отправка: что остаётся в силе', () => {
  // Чёрный список и тумблер агента — «этому номеру нельзя», и тест не повод.
  test('гейт Милы тест не обходит', async () => {
    const { updates, deps } = testDeps({
      isAllowed: jest.fn(async () => ({ allow: false, reason: 'blacklist' })),
    });
    await worker.processTestRow(11, {}, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(find(updates, /status='skipped'/).length).toBe(1);
  });

  // Отложенная строка остаётся scheduled, а стоит она в БУДУЩЕМ — через час её
  // арендовал бы боевой тик и отправил бы тестовое сообщение по-настоящему,
  // уже с боевыми deps. Гасим сразу.
  test('отложенная тестовая строка гасится, а не уезжает боевому воркеру', async () => {
    const { updates, deps } = testDeps({ agentGloballyEnabled: () => false });
    await worker.processTestRow(11, {}, deps);
    expect(find(updates, /SET scheduled_at/).length).toBe(1);
    const killed = find(updates, /status='cancelled'/);
    expect(killed.length).toBe(1);
    expect(killed[0].sql).toMatch(/status='scheduled'/);
  });
});
