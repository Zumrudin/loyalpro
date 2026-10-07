'use strict';
// Воркер напоминаний Милы о себе. Все зависимости замоканы через DI, БД и сеть
// не трогаются. Проверки идут по подстрокам SQL в вызовах db.query — тот же
// стиль, что в care-worker.test.js и reminders-worker.test.js.
const worker = require('./services/agent/followup-worker');
const history = require('./services/agent/history');

// Строка очереди в состоянии «пора напомнить». anchor_at — 10:00 UTC (13:00
// мск), next_at — 10:15 UTC.
function row(over = {}) {
  return {
    id: 1, salon_id: 1, dialog_key: '79200255591', phone: '79200255591',
    channel: 'whatsapp', chat_id: null,
    anchor_at: new Date('2026-08-11T10:00:00.000Z'),
    stage: 0, status: 'scheduled', next_at: new Date('2026-08-11T10:15:00.000Z'),
    attempts: 1,
    followup_delay1_min: 15, followup_delay2_min: 60,
    followup_final_text: 'Будем на связи — напишите, когда будет удобно.',
    followup_latest_time: null,
    salon_name: 'PERI CLINIC', client_name: 'Иванова Мария Петровна',
    ...over,
  };
}

function deps(over = {}) {
  const calls = { sent: [], marks: [], pending: [], persisted: [], events: [] };
  const d = {
    calls,
    db: {
      query: async (sql, params) => { calls.marks.push({ sql, params }); return { rowCount: 1, rows: [] }; },
      any: async () => [],
      oneOrNone: async () => null,
    },
    followupEnabled: () => true,
    agentGloballyEnabled: () => true,
    isAllowed: async () => ({ allow: true, reason: 'ok' }),
    dialogStatus: async () => 'bot',
    hasIncomingAfter: async () => false,
    loadTranscript: async () => ({ messages: [
      { role: 'user', content: 'Сколько стоит биоревитализация?' },
      { role: 'assistant', content: 'Мария, от 12 000 ₽. Записать вас?' },
    ] }),
    loadNameDictionary: async () => null,
    createMessage: async () => ({ text: '{"action":"send","text":"Мария, подскажите, записать вас?","reason":"нет ответа"}' }),
    lintReply: () => [],
    hardViolations: () => [],
    sendMessage: async (p) => { calls.sent.push(p); return { id: 777, channel: 'whatsapp' }; },
    lastIncomingChannel: async () => 'whatsapp',
    rememberPending: async (salonId, key, text) => { calls.pending.push({ salonId, key, text }); },
    persistWhatsapp: async (salonId, p) => { calls.persisted.push({ salonId, ...p }); },
    emitStatus: (salonId, key, status, stage) => calls.events.push({ salonId, key, status, stage }),
    // Бонусный довод: по умолчанию карта «недоступна», журнал хода пуст,
    // недавних фраз не было — то есть дописки НЕТ, старые тесты не затронуты.
    readCardBalance: async () => ({ status: 'unavailable', reason: 'test' }),
    loadTurnEvents: async () => [],
    recentBonusSent: async () => false,
    // Записи в CRM после якоря нет. Обязателен: processOne мёржит deps ПОВЕРХ
    // defaultDeps, и без заглушки старые тесты ходили бы в настоящую БД.
    bookedSinceAnchor: async () => false,
    // Справка об услуге: по умолчанию не найдена — без заглушки класс price
    // (фикстура с ценой) ходил бы в настоящий RAG.
    serviceFact: async () => null,
    log: { info() {}, warn() {}, error() {} },
    ...over,
  };
  return d;
}

// Все параметры всех UPDATE'ов одной плоской строкой — по ним проверяются
// машинные коды причин (close_reason).
const reasons = (d) => d.calls.marks.map((m) => m.params).flat().map(String).join(' | ');
const sqls = (d) => d.calls.marks.map((m) => m.sql).join(' ');

describe('followup worker: гейты', () => {
  test('запись в CRM после якоря гасит строку до LLM-прохода (booked_in_crm)', async () => {
    let llmCalled = false;
    const d = deps({
      bookedSinceAnchor: async (salonId, phone, anchorAt) => {
        expect(salonId).toBe(1); expect(phone).toBe('79200255591');
        expect(anchorAt).toEqual(new Date('2026-08-11T10:00:00.000Z'));
        return true;
      },
      createMessage: async () => { llmCalled = true; return { text: '{}' }; },
    });
    await worker.processOne(row(), d);
    expect(llmCalled).toBe(false);
    expect(d.calls.sent).toHaveLength(0);
    expect(reasons(d)).toMatch(/booked_in_crm/);
    expect(sqls(d)).toMatch(/SET status=\$2/);
  });

  test('боевой bookedSinceAnchor: отменённые/неявки/удалённые записью не считаются', async () => {
    const realDb = require('./db').db;
    const spy = jest.spyOn(realDb, 'oneOrNone').mockResolvedValue(null);
    try {
      const anchor = new Date('2026-08-11T10:00:00.000Z');
      expect(await worker.defaultDeps.bookedSinceAnchor(1, '79200255591', anchor)).toBe(false);
      const [sql, params] = spy.mock.calls[0];
      expect(sql).toMatch(/r\.salon_id = \$1/);
      expect(sql).toMatch(/NOT IN \('deleted','no_show','cancelled'\)/);
      expect(sql).toMatch(/raw_payload->>'deleted'/);
      expect(sql).toMatch(/raw_payload->>'attendance','\'\) <> '-1'/);
      expect(params).toEqual([1, ['+79200255591', '79200255591', '89200255591', '9200255591'], anchor]);
      // Номер короче 10 цифр — без запроса.
      spy.mockClear();
      expect(await worker.defaultDeps.bookedSinceAnchor(1, '123', anchor)).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  test('сбой проверки записи — fail-open, напоминание уходит', async () => {
    const d = deps({ bookedSinceAnchor: async () => { throw new Error('db down'); } });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(1);
  });

  test('выключенный env-рычаг ОТКЛАДЫВАЕТ, а не гасит строку', async () => {
    const d = deps({ followupEnabled: () => false });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(0);
    // терминального статуса не записано — только сдвиг срока
    expect(sqls(d)).not.toMatch(/SET status/);
    expect(sqls(d)).toMatch(/next_at\s*=\s*NOW\(\)/);
    // attempts откатывается ровно на инкремент аренды.
    expect(sqls(d)).toMatch(/attempts\s*=\s*GREATEST/);
  });

  test('выключенный глобальный kill-switch агента тоже откладывает', async () => {
    const d = deps({ agentGloballyEnabled: () => false });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(0);
    expect(sqls(d)).not.toMatch(/SET status/);
    expect(sqls(d)).toMatch(/next_at\s*=\s*NOW\(\)/);
  });

  test('интервал 0 в настройках → cancelled(disabled)', async () => {
    const d = deps();
    await worker.processOne(row({ followup_delay1_min: 0 }), d);
    expect(d.calls.sent).toHaveLength(0);
    expect(reasons(d)).toMatch(/cancelled/);
    expect(reasons(d)).toMatch(/disabled/);
  });

  test('нет строки agent_settings (интервалы NULL) → cancelled(disabled), а не зависание', async () => {
    const d = deps();
    await worker.processOne(row({ followup_delay1_min: null, followup_delay2_min: null }), d);
    expect(d.calls.sent).toHaveLength(0);
    expect(reasons(d)).toMatch(/disabled/);
  });

  test('вне окна расписания → expired(outside_window), не отправляем', async () => {
    const d = deps({ isAllowed: async () => ({ allow: false, reason: 'outside-schedule' }) });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(0);
    expect(reasons(d)).toMatch(/expired/);
    expect(reasons(d)).toMatch(/outside_window/);
  });

  test('гейт Милы зовётся БЕЗ ignoreSchedule (окно расписания действует)', async () => {
    const seen = [];
    const d = deps({ isAllowed: async (...args) => { seen.push(args); return { allow: true }; } });
    await worker.processOne(row(), d);
    // третьего аргумента-опций быть не должно вовсе
    expect(seen[0]).toHaveLength(2);
  });

  test('прочий отказ гейта (чёрный список) → expired с кодом гейта', async () => {
    const d = deps({ isAllowed: async () => ({ allow: false, reason: 'blacklist' }) });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(0);
    expect(reasons(d)).toMatch(/gate_blacklist/);
  });

  test('поздний час → expired(too_late), а до границы — отправка', async () => {
    // isTooLate меряет РЕАЛЬНОЕ «сейчас» (мск), поэтому границы считаются от
    // него: минутой раньше — поздно, минутой позже — ещё можно. Две крайние
    // минуты суток (00:00 и 23:59) из проверки выпадают: там соседняя минута
    // уезжает за границу суток, а разбирать переход через полночь — работа
    // самого isTooLate (у него на это свои тесты).
    const msk = new Date(Date.now() + 3 * 3600000);
    const m = msk.getUTCHours() * 60 + msk.getUTCMinutes();
    if (m < 1 || m > 1438) return;
    const fmt = (x) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;

    const late = deps();
    await worker.processOne(row({ followup_latest_time: fmt(m - 1) }), late);
    expect(late.calls.sent).toHaveLength(0);
    expect(reasons(late)).toMatch(/expired/);
    expect(reasons(late)).toMatch(/too_late/);

    const ok = deps();
    await worker.processOne(row({ followup_latest_time: fmt(m + 1) }), ok);
    expect(ok.calls.sent).toHaveLength(1);
  });

  test('диалог на операторе → cancelled(operator)', async () => {
    const d = deps({ dialogStatus: async () => 'escalated' });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(0);
    expect(reasons(d)).toMatch(/cancelled/);
    expect(reasons(d)).toMatch(/operator/);
  });

  test('клиент ответил после якоря → answered(client_replied)', async () => {
    const seen = [];
    const d = deps({ hasIncomingAfter: async (...a) => { seen.push(a); return true; } });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(0);
    expect(reasons(d)).toMatch(/answered/);
    expect(reasons(d)).toMatch(/client_replied/);
    // сверка идёт по ключу диалога и ЯКОРЮ строки
    expect(seen[0][1]).toBe('79200255591');
    expect(seen[0][2]).toEqual(new Date('2026-08-11T10:00:00.000Z'));
  });

  test('слать некуда (tdlib без номера и без chat_id) → cancelled, LLM не зовётся', async () => {
    let llm = 0;
    const d = deps({ createMessage: async () => { llm++; return { text: '{}' }; } });
    await worker.processOne(row({ channel: 'tdlib', phone: null, chat_id: null }), d);
    expect(llm).toBe(0);
    expect(d.calls.sent).toHaveLength(0);
    expect(reasons(d)).toMatch(/no_recipient/);
  });

  test('порядок гейтов: платный LLM-проход не зовётся ни на одном отказе', async () => {
    for (const over of [
      { followupEnabled: () => false },
      { agentGloballyEnabled: () => false },
      { isAllowed: async () => ({ allow: false, reason: 'disabled' }) },
      { dialogStatus: async () => 'escalated' },
      { hasIncomingAfter: async () => true },
    ]) {
      let llm = 0;
      const d = deps({ createMessage: async () => { llm++; return { text: '{}' }; }, ...over });
      await worker.processOne(row(), d);
      expect(llm).toBe(0);
      expect(d.calls.sent).toHaveLength(0);
    }
  });
});

describe('followup worker: напоминание (stage 0)', () => {
  test('отправляет текст модели, стадия и срок финала записаны ДО отправки', async () => {
    const order = [];
    const d = deps();
    d.db.query = async (sql, params) => {
      d.calls.marks.push({ sql, params });
      order.push('mark');
      return { rowCount: 1, rows: [] };
    };
    d.sendMessage = async (p) => { d.calls.sent.push(p); order.push('send'); return { id: 777, channel: 'whatsapp' }; };
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(1);
    expect(d.calls.sent[0].text).toMatch(/записать вас/i);
    const mark = d.calls.marks.find((m) => /stage\s*=\s*1/.test(m.sql));
    expect(mark).toBeTruthy();
    expect(mark.sql).toMatch(/nudge1_at\s*=\s*NOW\(\)/);
    expect(mark.sql).toMatch(/next_at\s*=\s*\$2/);
    // mark-before-send: захват строго раньше отправки
    expect(order.indexOf('mark')).toBeLessThan(order.indexOf('send'));
    // канал взят снимком строки, адресация — recipientParams
    expect(d.calls.sent[0].dispatchRouting).toEqual(['whatsapp']);
    expect(d.calls.sent[0].phone).toBe('79200255591');
  });

  // Дефект найден живым прогоном scripts/agent-followup-e2e.js 2026-08-12:
  // loadTranscript по умолчанию переносит хвостовой assistant-блок перед
  // последний user-блок (правка для оркестратора — задержанное эхо читается
  // как ответ на ПРЕДЫДУЩЕЕ сообщение клиента). У воркера напоминаний посылка
  // ОБРАТНАЯ: транскрипт ОБЯЗАН кончаться репликой Милы, иначе модель либо не
  // видит её вовсе (уезжает в leadingClinic), либо читает клиента как уже
  // отвеченного — оба исхода дают систематический skip. Без явной проверки
  // аргумента «оптимизация» тихо уберёт флаг и дефект вернётся молча — прежние
  // юнит-тесты этого не ловят, потому что подменяют loadTranscript целиком.
  test('loadTranscript зовётся с keepTrailingAssistant:true', async () => {
    const calls = [];
    const d = deps({
      loadTranscript: async (salonId, key, opts) => {
        calls.push({ salonId, key, opts });
        return {
          messages: [
            { role: 'user', content: 'Сколько стоит биоревитализация?' },
            { role: 'assistant', content: 'Мария, от 12 000 ₽. Записать вас?' },
          ],
        };
      },
    });
    await worker.processOne(row(), d);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toMatchObject({ keepTrailingAssistant: true });
  });

  test('срок финала считается от ЯКОРЯ и не может быть впритык к напоминанию', async () => {
    const d = deps();
    await worker.processOne(row(), d);
    const mark = d.calls.marks.find((m) => /stage\s*=\s*1/.test(m.sql));
    const finalAt = mark.params[1];
    // Якорь 2026-08-11 давно прошёл, поэтому срабатывает нижний порог: финал
    // отодвигается от «сейчас», а не уходит в прошлое.
    expect(finalAt.getTime()).toBeGreaterThan(Date.now() + (worker.MIN_FINAL_GAP_MIN - 1) * 60000);
  });

  test('при свежем якоре срок финала берётся ИЗ НАСТРОЕК, без зажима', async () => {
    // Якорь только что: delay2=60 мин от него — далеко за минимальным зазором,
    // поэтому финал обязан встать РОВНО на настройку салона.
    const anchor = new Date(Date.now() - 15 * 60000);
    const d = deps();
    await worker.processOne(row({ anchor_at: anchor }), d);
    const mark = d.calls.marks.find((m) => /stage\s*=\s*1/.test(m.sql));
    expect(mark.params[1].getTime()).toBe(anchor.getTime() + 60 * 60000);
  });

  test('тесная пара интервалов зажимается и это ВИДНО в логе', async () => {
    // delay2 - delay1 = 2 мин: валидация настроек такую пару пропускает, а
    // финал ушёл бы почти вплотную за напоминанием. Сдвиг законен, молчаливым
    // быть не должен.
    const info = [];
    const d = deps({ log: { info: (m) => info.push(m), warn() {}, error() {} } });
    await worker.processOne(row({
      anchor_at: new Date(Date.now() - 15 * 60000),
      followup_delay1_min: 15, followup_delay2_min: 17,
    }), d);
    const mark = d.calls.marks.find((m) => /stage\s*=\s*1/.test(m.sql));
    expect(mark.params[1].getTime()).toBeGreaterThan(Date.now() + (worker.MIN_FINAL_GAP_MIN - 1) * 60000);
    expect(info.join(' ')).toMatch(/сдвинут/);
  });

  test('после отправки — pending-реплика и персист в «Чат» для whatsapp', async () => {
    const d = deps();
    await worker.processOne(row(), d);
    expect(d.calls.pending).toHaveLength(1);
    expect(d.calls.pending[0].key).toBe('79200255591');
    expect(d.calls.persisted).toHaveLength(1);
    // чип в списке диалогов обязан обновиться без F5
    expect(d.calls.events.some((e) => e.stage === 1)).toBe(true);
  });

  test('skip модели → cancelled, ничего не отправлено', async () => {
    const d = deps({ createMessage: async () => ({ text: '{"action":"skip","reason":"пациент отказался"}' }) });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(0);
    expect(reasons(d)).toMatch(/пациент отказался/);
    expect(reasons(d)).toMatch(/cancelled/);
  });

  test('не-JSON от модели → fail-safe, молчим', async () => {
    const d = deps({ createMessage: async () => ({ text: 'конечно, напомню!' }) });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(0);
    expect(reasons(d)).toMatch(/llm_no_json/);
  });

  test('выдуманное время → не отправляем, причина invented_time', async () => {
    const d = deps({
      createMessage: async () => ({ text: '{"action":"send","text":"Ждём вас в 15:00","reason":"x"}' }),
    });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(0);
    expect(reasons(d)).toMatch(/invented_time/);
  });

  test('время из прошлой реплики Милы — законно, отправляем', async () => {
    const d = deps({
      loadTranscript: async () => ({ messages: [
        { role: 'user', content: 'А когда можно?' },
        { role: 'assistant', content: 'Свободно 12:30 и 13:30.' },
      ] }),
      createMessage: async () => ({ text: '{"action":"send","text":"Подошло ли 12:30?","reason":"x"}' }),
    });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(1);
  });

  test('время из реплики АДМИНИСТРАТОРА не легализует его', async () => {
    // Строка с OPERATOR_MARK склеена loadTranscript'ом в один assistant-блок с
    // собственной репликой Милы — исключать её надо ПОСТРОЧНО.
    const d = deps({
      loadTranscript: async () => ({ messages: [
        { role: 'user', content: 'А когда можно?' },
        { role: 'assistant', content: `Секунду, уточню.\n${history.OPERATOR_MARK} Приходите в 15:00` },
      ] }),
      createMessage: async () => ({ text: '{"action":"send","text":"Ждём вас в 15:00","reason":"x"}' }),
    });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(0);
    expect(reasons(d)).toMatch(/invented_time/);
  });

  // Воспроизведение конкретного обхода (ревью 2026-08-12): время стоит во
  // ВТОРОЙ строке ОДНОГО сообщения администратора (Shift+Enter в WhatsApp).
  // Пока loadTranscript помечал только первую строку тела, строка «приходите к
  // 15:00» проходила построчный фильтр как собственный текст Милы, и guard
  // молча пропускал время, которого она НИКОГДА не называла. Транскрипт здесь
  // собирается НАСТОЯЩИМ markOperatorLines, а не написан руками, — иначе тест
  // проверял бы фикстуру, а не поведение.
  test('время во ВТОРОЙ строке одного сообщения администратора не легализует его', async () => {
    const operatorMsg = history.markOperatorLines('Ждём вас завтра,\nприходите к 15:00');
    expect(operatorMsg.split('\n')[1]).toContain('15:00');   // фикстура именно про это
    const d = deps({
      loadTranscript: async () => ({ messages: [
        { role: 'user', content: 'А когда можно?' },
        { role: 'assistant', content: `Секунду, уточню.\n${operatorMsg}` },
      ] }),
      createMessage: async () => ({ text: '{"action":"send","text":"Ждём вас в 15:00","reason":"x"}' }),
    });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(0);
    expect(reasons(d)).toMatch(/invented_time/);
  });

  test('время из сообщения КЛИЕНТА не легализует его', async () => {
    const d = deps({
      loadTranscript: async () => ({ messages: [
        { role: 'user', content: 'А в 15:00 можно?' },
      ] }),
      createMessage: async () => ({ text: '{"action":"send","text":"Записать вас на 15:00?","reason":"x"}' }),
    });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(0);
    expect(reasons(d)).toMatch(/invented_time/);
  });

  // Прод, 2026-09-08 (79200255591, 79166392549): промпт прямо запрещает
  // приветствие в напоминании (правило 1), но модель его игнорирует ощутимо
  // часто — «Зумрудин, здравствуйте! …» и «Вера, добрый день! …» ушли ВТОРЫМ
  // сообщением Милы подряд. Мораторий на новые промпт-правила требует
  // детерминированного фикса: тот же срез, что у оркестратора
  // (greeting.stripGreeting) — само слово приветствия вырезается, обращение
  // по имени остаётся на месте.
  test('повторное приветствие в тексте напоминания срезается', async () => {
    const d = deps({
      loadTranscript: async () => ({ messages: [
        { role: 'user', content: 'Сколько стоит биоревитализация?' },
        { role: 'assistant', content: 'Мария, добрый день! От 12 000 ₽. Записать вас?' },
      ] }),
      createMessage: async () => ({
        text: '{"action":"send","text":"Мария, добрый день! Удалось ли определиться со временем?","reason":"x"}',
      }),
    });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(1);
    expect(d.calls.sent[0].text).toBe('Мария! Удалось ли определиться со временем?');
    expect(d.calls.sent[0].text).not.toMatch(/добрый день/i);
  });

  // Приветствия в прошлых репликах Милы не было (транскрипт не содержит его) —
  // резать нечего, реплика уходит как есть. Мираж: без этого условия срез
  // рисковал бы убить ЛЕГИТИМНОЕ первое приветствие переписки.
  test('без приветствия в прошлых репликах Милы текст не трогаем', async () => {
    const d = deps({
      loadTranscript: async () => ({ messages: [
        { role: 'user', content: 'Сколько стоит биоревитализация?' },
        { role: 'assistant', content: 'От 12 000 ₽. Записать вас?' },
      ] }),
      createMessage: async () => ({
        text: '{"action":"send","text":"Мария, добрый день! Записать вас?","reason":"x"}',
      }),
    });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(1);
    expect(d.calls.sent[0].text).toBe('Мария, добрый день! Записать вас?');
  });

  test('строку перехватили между гейтами и захватом → не отправляем', async () => {
    const d = deps();
    d.db.query = async (sql, params) => {
      d.calls.marks.push({ sql, params });
      if (/stage\s*=\s*1/.test(sql)) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    };
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(0);
  });

  test('сбой отправки ПОСЛЕ захвата не откатывает строку (at-most-once)', async () => {
    const d = deps({ sendMessage: async () => { throw new Error('chatpush 500'); } });
    await worker.processOne(row(), d);
    // текст ошибки — в отдельную колонку error, не в close_reason
    const err = d.calls.marks.find((m) => /SET error\s*=/.test(m.sql));
    expect(err).toBeTruthy();
    expect(String(err.params[1])).toMatch(/chatpush 500/);
    expect(sqls(d)).not.toMatch(/status\s*=\s*'failed'/);
  });

  test('сбой ДО захвата с исчерпанными попытками → failed, ошибка в колонку error', async () => {
    const d = deps({ createMessage: async () => { throw new Error('provider down'); } });
    await worker.processOne(row({ attempts: 3 }), d);
    expect(d.calls.sent).toHaveLength(0);
    const err = d.calls.marks.find((m) => /SET status='failed'/.test(m.sql));
    expect(err).toBeTruthy();
    expect(String(err.params[1])).toMatch(/provider down/);
  });

  test('сбой ДО захвата с остатком попыток → строка остаётся scheduled', async () => {
    const d = deps({ createMessage: async () => { throw new Error('timeout'); } });
    await worker.processOne(row({ attempts: 1 }), d);
    expect(sqls(d)).not.toMatch(/status='failed'/);
    expect(sqls(d)).toMatch(/SET status=status/);
  });
});

describe('followup worker: бонусный довод (stage 0)', () => {
  const BONUS_ROW = {
    followup_bonus_text: 'На карте {balance} бонусов.',
    followup_welcome_text: 'Дарим 500 баллов при регистрации.',
    followup_bonus_min_balance: 100,
    anchor_turn_id: 'turn-1',
  };
  // Транскрипт с ценой в реплике Милы — класс price без единого инструмента.
  const priceTranscript = async () => ({ messages: [
    { role: 'user', content: 'Сколько стоит биоревитализация?' },
    { role: 'assistant', content: 'Мария, от 12 000 ₽. Записать вас?' },
  ] });

  test('держатель карты: фраза дописана отдельным абзацем, журнал в захвате', async () => {
    const d = deps({ loadTranscript: priceTranscript, readCardBalance: async () => ({ status: 'ok', balance: 3024, cardId: 1 }) });
    await worker.processOne(row(BONUS_ROW), d);
    expect(d.calls.sent).toHaveLength(1);
    expect(d.calls.sent[0].text).toBe('Мария, подскажите, записать вас?\n\nНа карте 3 024 бонусов.');
    const mark = d.calls.marks.find((m) => /stage\s*=\s*1/.test(m.sql));
    expect(mark.sql).toMatch(/bonus_kind\s*=\s*\$4/);
    expect(mark.sql).toMatch(/bonus_balance\s*=\s*\$5/);
    expect(mark.params[3]).toBe('balance');
    expect(mark.params[4]).toBe(3024);
    expect(mark.params[2]).toBe(d.calls.sent[0].text); // rendered_text = весь текст
  });

  test('без карты → welcome; шаблоны пустые → без фразы и без похода за картой', async () => {
    const d = deps({ loadTranscript: priceTranscript, readCardBalance: async () => ({ status: 'no_card' }) });
    await worker.processOne(row(BONUS_ROW), d);
    expect(d.calls.sent[0].text).toMatch(/\n\nДарим 500 баллов при регистрации\.$/);
    const mark = d.calls.marks.find((m) => /stage\s*=\s*1/.test(m.sql));
    expect(mark.params[3]).toBe('welcome');
    expect(mark.params[4]).toBe(null);

    const calls = [];
    const d2 = deps({ loadTranscript: priceTranscript, readCardBalance: async () => { calls.push(1); return { status: 'ok', balance: 999 }; } });
    await worker.processOne(row(), d2); // в row() шаблонов нет
    expect(calls).toHaveLength(0);
    expect(d2.calls.sent[0].text).toBe('Мария, подскажите, записать вас?');
    const mark2 = d2.calls.marks.find((m) => /stage\s*=\s*1/.test(m.sql));
    expect(mark2.params[3]).toBe(null);
  });

  test('ситуация clarify по журналу хода → без фразы, карта не читается', async () => {
    const calls = [];
    const d = deps({
      loadTranscript: priceTranscript,
      loadTurnEvents: async (turnId) => { calls.push(turnId); return [{ tool: 'create_booking', result: { needs_phone: true }, is_error: true }]; },
      readCardBalance: async () => { throw new Error('не должен зваться'); },
    });
    await worker.processOne(row(BONUS_ROW), d);
    expect(calls).toEqual(['turn-1']);
    expect(d.calls.sent[0].text).toBe('Мария, подскажите, записать вас?');
  });

  test('бонусы уже звучали в переписке / недавно слали → без фразы', async () => {
    const d = deps({
      loadTranscript: async () => ({ messages: [
        { role: 'user', content: 'А бонусы у меня есть?' },
        { role: 'assistant', content: 'Да, 3 024 бонуса. Чистка от 4500 ₽. Записать?' },
      ] }),
      readCardBalance: async () => ({ status: 'ok', balance: 3024 }),
    });
    await worker.processOne(row(BONUS_ROW), d);
    expect(d.calls.sent[0].text).not.toMatch(/На карте/);

    const d2 = deps({ loadTranscript: priceTranscript, recentBonusSent: async () => true,
      readCardBalance: async () => ({ status: 'ok', balance: 3024 }) });
    await worker.processOne(row(BONUS_ROW), d2);
    expect(d2.calls.sent[0].text).not.toMatch(/На карте/);
  });

  test('нет номера → без фразы; исключение в бонусной ветке не ломает отправку', async () => {
    // Канал без номера — tdlib со скрытым номером: адресат по chat_id
    // (recipientParams), карту читать не по чему.
    const calls = [];
    const d = deps({ loadTranscript: priceTranscript,
      readCardBalance: async () => { calls.push(1); return { status: 'ok', balance: 3024 }; } });
    await worker.processOne(row({ ...BONUS_ROW, phone: null, channel: 'tdlib', chat_id: '5245186003' }), d);
    expect(d.calls.sent).toHaveLength(1);
    expect(d.calls.sent[0].tdlib_user_id).toBe('5245186003');
    expect(d.calls.sent[0].text).not.toMatch(/На карте/);
    expect(calls).toHaveLength(0);

    const d2 = deps({ loadTranscript: priceTranscript, loadTurnEvents: async () => { throw new Error('boom'); } });
    await worker.processOne(row(BONUS_ROW), d2);
    expect(d2.calls.sent).toHaveLength(1);
    expect(d2.calls.sent[0].text).toBe('Мария, подскажите, записать вас?');
  });

  test('skip модели не стоит похода за картой; финал (stage 1) фразу не получает', async () => {
    const calls = [];
    const d = deps({ loadTranscript: priceTranscript,
      createMessage: async () => ({ text: '{"action":"skip","reason":"попрощались"}' }),
      readCardBalance: async () => { calls.push(1); return { status: 'ok', balance: 3024 }; } });
    await worker.processOne(row(BONUS_ROW), d);
    expect(calls).toHaveLength(0);

    const d2 = deps({ readCardBalance: async () => { calls.push(2); return { status: 'ok', balance: 3024 }; } });
    await worker.processOne(row({ ...BONUS_ROW, stage: 1 }), d2);
    expect(calls).toHaveLength(0);
    expect(d2.calls.sent[0].text).not.toMatch(/На карте/);
  });

  test('reply-guard и guard времени проверяют текст МОДЕЛИ, а не шаблон салона', async () => {
    const seen = [];
    const d = deps({ loadTranscript: priceTranscript, readCardBalance: async () => ({ status: 'ok', balance: 3024 }),
      lintReply: (text) => { seen.push(text); return []; } });
    await worker.processOne(row(BONUS_ROW), d);
    expect(seen).toEqual(['Мария, подскажите, записать вас?']);
  });
});

describe('followup worker: финал (stage 1)', () => {
  test('шлёт шаблон и закрывает строку, LLM не зовётся', async () => {
    let llm = 0;
    const d = deps({ createMessage: async () => { llm++; return { text: '{}' }; } });
    await worker.processOne(row({ stage: 1, next_at: new Date('2026-08-11T11:00:00.000Z') }), d);
    expect(llm).toBe(0);
    expect(d.calls.sent).toHaveLength(1);
    expect(d.calls.sent[0].text).toMatch(/Будем на связи/);
    expect(sqls(d)).toMatch(/status='done'/);
    expect(sqls(d)).toMatch(/close_reason='final_sent'/);
    expect(sqls(d)).toMatch(/final_at=NOW\(\)/);
  });

  test('пустой шаблон салона → дефолтный текст', async () => {
    const d = deps();
    await worker.processOne(row({ stage: 1, followup_final_text: null }), d);
    expect(d.calls.sent).toHaveLength(1);
    expect(d.calls.sent[0].text).toBe(worker.DEFAULT_FINAL_TEXT);
  });

  test('{first_name} в шаблоне разворачивается в ЛИЧНОЕ имя, а не в ФИО', async () => {
    const d = deps();
    await worker.processOne(row({ stage: 1, followup_final_text: '{first_name}, будем на связи!' }), d);
    expect(d.calls.sent[0].text).toBe('Мария, будем на связи!');
  });

  test('гейты действуют и на финале: клиент ответил → answered', async () => {
    const d = deps({ hasIncomingAfter: async () => true });
    await worker.processOne(row({ stage: 1 }), d);
    expect(d.calls.sent).toHaveLength(0);
    expect(reasons(d)).toMatch(/client_replied/);
  });
});

describe('followup worker: тик', () => {
  test('аренда идёт по next_at с тай-брейком по id и не наслаивается', async () => {
    const leases = [];
    const d = deps();
    d.db.any = async (sql, params) => { leases.push({ sql, params }); return []; };
    await worker.processTick(d);
    expect(leases).toHaveLength(1);
    expect(leases[0].sql).toMatch(/ORDER BY next_at ASC, id ASC/);
    expect(leases[0].sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(leases[0].params).toEqual([worker.RETRY_BACKOFF_S]);
  });
});

describe('инварианты', () => {
  test('таймаут LLM строго меньше backoff аренды', () => {
    expect(worker.LLM_TIMEOUT_MS).toBeLessThan(worker.RETRY_BACKOFF_S * 1000);
  });

  test('аренда тянет настройки салона и не теряет строки без agent_settings', () => {
    // Скалярные подзапросы, а не JOIN: join сузил бы выборку и строка салона
    // без записи в agent_settings висела бы 'scheduled' вечно.
    expect(worker.LEASE_SQL).not.toMatch(/\bFROM agent_settings\s+s\s+WHERE\s+s\.salon_id\s*=\s*f\.salon_id\s*\n?\s*AND/);
    expect(worker.LEASE_SQL).toMatch(/followup_delay1_min/);
    expect(worker.LEASE_SQL).toMatch(/followup_final_text/);
    expect(worker.LEASE_SQL).toMatch(/followup_latest_time/);
  });

  test('LEASE_SQL отдаёт шаблоны бонусного довода и порог', () => {
    expect(worker.LEASE_SQL).toMatch(/followup_bonus_text/);
    expect(worker.LEASE_SQL).toMatch(/followup_welcome_text/);
    expect(worker.LEASE_SQL).toMatch(/followup_bonus_min_balance/);
  });
});

// Synthetic reminder exchange; no patient data or external calls.
function confirmedVisitRows() {
  return [
    { direction: 'outgoing', authored_by: 'system', text: 'Напоминаем о записи. Для подтверждения отправьте +.', msg_ts: 1000 },
    { direction: 'incoming', text: '+', msg_ts: 1020 },
    { direction: 'outgoing', authored_by: 'system', text: 'Ваша запись подтверждена. Спасибо!', msg_ts: 1030 },
    { direction: 'outgoing', authored_by: 'agent', text: 'Ждём вас завтра!', msg_ts: 1040 },
  ].reverse();
}
test.each([0, 1])('confirmed visit cancels stage %s without sending or generating', async stage => {
  const d = deps(); d.db.any = async () => confirmedVisitRows();
  d.createMessage = jest.fn();
  await worker.processOne(row({ stage }), d);
  expect(d.calls.sent).toHaveLength(0);
  expect(d.createMessage).not.toHaveBeenCalled();
  expect(reasons(d)).toContain('visit_confirmed');
});
test('acknowledgement arriving during generation stops the nudge', async () => {
  const d = deps(); let reads = 0;
  d.db.any = async () => ++reads === 1 ? [] : confirmedVisitRows();
  await worker.processOne(row(), d);
  expect(reads).toBe(2);
  expect(d.calls.sent).toHaveLength(0);
  expect(reasons(d)).toContain('visit_confirmed');
});
test('confirmation context read failure never sends a final message', async () => {
  const d = deps(); d.db.any = async () => { throw new Error('test read unavailable'); };
  await worker.processOne(row({ stage: 1 }), d);
  expect(d.calls.sent).toHaveLength(0);
  expect(d.calls.marks.some(m => /SET status='done'/.test(m.sql))).toBe(false);
});

test.each([0, 1])('illness stops followup stage %s even before cancellation is done', async stage => {
  const d = deps();
  d.db.any = async () => [
    { direction: 'outgoing', authored_by: 'agent', text: 'Уточните, какую запись отменить?', msg_ts: 1010 },
    { direction: 'incoming', text: 'Простудилась и не смогу приехать. Отмените запись.', msg_ts: 1000 },
  ];
  d.createMessage = jest.fn();
  await worker.processOne(row({ stage }), d);
  expect(d.calls.sent).toHaveLength(0);
  expect(d.createMessage).not.toHaveBeenCalled();
  expect(reasons(d)).toContain('client_unavailable');
});

describe('справка об услуге в stage 0', () => {
  test('класс price → serviceFact зовётся названием услуги из журнала хода и уходит в промпт', async () => {
    const queries = [];
    let systemSeen = '';
    let userSeen = '';
    const d = deps({
      loadTurnEvents: async () => [{ tool: 'get_service_masters', input: { service_yc_ids: [1] },
        result: { services: [{ title: 'Комбинированная чистка лица' }] }, is_error: false }],
      serviceFact: async (salonId, query) => { queries.push(query); return { title: 'Чистки', text: 'Входит уход.' }; },
      createMessage: async ({ system, messages }) => {
        systemSeen = system; userSeen = messages[0].content;
        return { text: '{"action":"send","text":"Мария, в стоимость чистки входит уход. Подобрать время?","reason":"ок"}' };
      },
    });
    await worker.processOne(row(), d);
    expect(queries).toEqual(['Комбинированная чистка лица']);
    expect(userSeen).toContain('СПРАВКА ОБ УСЛУГЕ (статья «Чистки»');
    expect(systemSeen).toContain('кроме фактов из блока');
    expect(d.calls.sent).toHaveLength(1);
  });

  test('класс price без вызова инструмента → запрос по ВОПРОСУ ПАЦИЕНТА, не по реплике Милы', async () => {
    const queries = [];
    const d = deps({ serviceFact: async (salonId, query) => { queries.push(query); return null; } });
    await worker.processOne(row(), d);
    expect(queries).toEqual(['Сколько стоит биоревитализация?']);
    expect(d.calls.sent).toHaveLength(1);
  });

  test('вопроса пациента в окне нет → справка не запрашивается', async () => {
    let called = false;
    const d = deps({
      loadTranscript: async () => ({ messages: [{ role: 'assistant', content: 'Мария, от 12 000 ₽. Записать вас?' }] }),
      serviceFact: async () => { called = true; return { title: 'X', text: 'Y' }; },
    });
    await worker.processOne(row(), d);
    expect(called).toBe(false);
  });

  test('словарь Милы («консультация в подарок») не легализует статью «Консультация …»', async () => {
    const { pickServiceFact } = require('./services/agent/service-fact');
    const ctx = 'Консультация врача-косметолога\nПервичная консультация проводится бесплатно.';
    const mila = 'Мария, биоревитализация от 12 000 ₽, консультация в подарок. Записать вас?';
    // Контроль: по реплике Милы фильтр заголовка прошёл бы — ровно дефект.
    expect(pickServiceFact(ctx, mila)).not.toBeNull();
    let userSeen = '';
    const d = deps({
      loadTranscript: async () => ({ messages: [
        { role: 'user', content: 'Сколько стоит биоревитализация?' },
        { role: 'assistant', content: mila },
      ] }),
      serviceFact: async (salonId, query) => pickServiceFact(ctx, query),
      createMessage: async ({ messages }) => {
        userSeen = messages[0].content;
        return { text: '{"action":"send","text":"Мария, подскажите, записать вас?","reason":"ок"}' };
      },
    });
    await worker.processOne(row(), d);
    expect(userSeen).not.toContain('СПРАВКА');
    expect(d.calls.sent).toHaveLength(1);
  });

  test('пациент не назвал услугу («Сколько стоит?»), Мила — «консультация в подарок» → справки нет', async () => {
    const { pickServiceFact } = require('./services/agent/service-fact');
    const ctx = 'Консультация врача-косметолога\nПервичная консультация проводится бесплатно.';
    let userSeen = '';
    const d = deps({
      loadTranscript: async () => ({ messages: [
        { role: 'user', content: 'Сколько стоит?' },
        { role: 'assistant', content: 'Мария, от 12 000 ₽, консультация в подарок. Записать вас?' },
      ] }),
      serviceFact: async (salonId, query) => pickServiceFact(ctx, query),
      createMessage: async ({ messages }) => {
        userSeen = messages[0].content;
        return { text: '{"action":"send","text":"Мария, подскажите, записать вас?","reason":"ок"}' };
      },
    });
    await worker.processOne(row(), d);
    expect(userSeen).not.toContain('СПРАВКА');
    expect(d.calls.sent).toHaveLength(1);
  });

  test('пациент спросил «сколько стоит чистка?» → статья «Чистка лица» уходит в промпт', async () => {
    const { pickServiceFact } = require('./services/agent/service-fact');
    const ctx = 'Чистка лица\nВ стоимость входит уходовая маска.';
    const queries = [];
    let userSeen = '';
    const d = deps({
      loadTranscript: async () => ({ messages: [
        { role: 'user', content: 'сколько стоит чистка?' },
        { role: 'assistant', content: 'Мария, от 5 000 ₽, консультация в подарок. Записать вас?' },
      ] }),
      serviceFact: async (salonId, query) => { queries.push(query); return pickServiceFact(ctx, query); },
      createMessage: async ({ messages }) => {
        userSeen = messages[0].content;
        return { text: '{"action":"send","text":"Мария, в чистку входит маска. Записать вас?","reason":"ок"}' };
      },
    });
    await worker.processOne(row(), d);
    expect(queries).toEqual(['сколько стоит чистка?']);
    expect(userSeen).toContain('СПРАВКА ОБ УСЛУГЕ (статья «Чистка лица»');
    expect(userSeen).toContain('уходовая маска');
    expect(d.calls.sent).toHaveLength(1);
  });

  test('класс choice — справка не запрашивается', async () => {
    let called = false;
    const d = deps({
      loadTurnEvents: async () => [{ tool: 'get_available_slots', input: {}, result: { slots: [{ time: '12:00' }] }, is_error: false }],
      serviceFact: async () => { called = true; return null; },
    });
    await worker.processOne(row(), d);
    expect(called).toBe(false);
  });

  test('флаг AGENT_SERVICE_FACT_PREFETCH=false — справка не запрашивается', async () => {
    let called = false;
    const d = deps({
      serviceFactEnabled: () => false,
      serviceFact: async () => { called = true; return { title: 'X', text: 'Y' }; },
    });
    await worker.processOne(row(), d);
    expect(called).toBe(false);
    expect(d.calls.sent).toHaveLength(1);
  });

  test('сбой справки — напоминание уходит без неё', async () => {
    let userSeen = '';
    const d = deps({
      serviceFact: async () => { throw new Error('rag down'); },
      createMessage: async ({ messages }) => {
        userSeen = messages[0].content;
        return { text: '{"action":"send","text":"Мария, подскажите, записать вас?","reason":"ок"}' };
      },
    });
    await worker.processOne(row(), d);
    expect(userSeen).not.toContain('СПРАВКА');
    expect(d.calls.sent).toHaveLength(1);
  });

  test('defaultDeps.serviceFact: зависший RAG обрывается таймаутом (fail-open выше)', async () => {
    jest.useFakeTimers();
    try {
      let w;
      jest.isolateModules(() => {
        jest.doMock('./services/agent-rag', () => ({ buildKnowledgeContext: () => new Promise(() => {}) }));
        w = require('./services/agent/followup-worker');
      });
      expect(w.SERVICE_FACT_TIMEOUT_MS).toBeLessThanOrEqual(10000);
      const p = w.defaultDeps.serviceFact(1, 'чистка');
      const assertion = expect(p).rejects.toThrow(/timeout/);
      jest.advanceTimersByTime(w.SERVICE_FACT_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      jest.dontMock('./services/agent-rag');
      jest.useRealTimers();
    }
  });

  test('defaultDeps: флаг справки читается из config', () => {
    expect(typeof worker.defaultDeps.serviceFactEnabled).toBe('function');
    expect(typeof worker.defaultDeps.serviceFact).toBe('function');
  });
});
