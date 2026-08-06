'use strict';

// Мокаем логгер (тот же модуль, что резолвит '../../logger' из orchestrator.js)
// чтобы проверять, что вызовы инструментов реально логируются — logger не
// инжектится через deps, поэтому перехватываем сам модуль createLogger.
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLogger }));

// Оркестратор провайдер-агностичен: мокаем provider.createMessage, реальный
// toolResultMessages берём из aitunnel-провайдера (формат {role:'tool'}).
const realProvider = require('./services/agent/providers/aitunnel');
const orchestrator = require('./services/agent/orchestrator');

// Журнал tool-цикла (agent_tool_events) ходит в БД — во всех тестах он застабан,
// иначе существующие сценарии полезли бы в реальную базу.
function makeToolEventsStub() {
  const buffers = [];
  return {
    buffers,
    mod: {
      createBuffer: jest.fn(() => {
        const buf = { turnId: `turn-${buffers.length + 1}`, push: jest.fn(), flush: jest.fn(async () => {}) };
        buffers.push(buf);
        return buf;
      }),
      loadRecent: jest.fn(async () => []),
    },
  };
}

function makeDeps(overrides = {}) {
  return {
    provider: {
      createMessage: jest.fn(),
      toolResultMessages: realProvider.toolResultMessages,
      ...overrides.provider,
    },
    registry: {
      schemas: [{ name: 'get_available_slots' }, { name: 'escalate_to_operator' }, { name: 'create_booking' }],
      handlers: {
        get_available_slots: jest.fn(async () => ({ slots: [{ time: '10:00' }] })),
        escalate_to_operator: jest.fn(async () => ({ escalated: true, reason: 'жалоба' })),
        create_booking: jest.fn(async () => ({ created: true, record_id: 999 })),
        ...(overrides.handlers || {}),
      },
    },
    history: {
      loadTranscript: jest.fn(async () => ({ messages: [{ role: 'user', content: 'привет' }], watermark: 100 })),
      hasIncomingAfter: jest.fn(async () => false),
      // Дефолт «мы этому пациенту уже отвечали»: блок ПЕРВОГО ОБРАЩЕНИЯ не
      // должен всплывать в сценариях, которые про него ничего не утверждают.
      hasEverAnswered: jest.fn(async () => true),
      ...overrides.history,
    },
    state: {
      getOrCreate: jest.fn(async () => ({ status: 'bot' })),
      setWatermark: jest.fn(async () => {}),
      ...overrides.state,
    },
    identity: {
      resolveClient: jest.fn(async () => null),
      ...overrides.identity,
    },
    toolEvents: (overrides.toolEvents && overrides.toolEvents.mod) || makeToolEventsStub().mod,
    toolMemory: {
      renderMemory: jest.fn(() => ({ lines: [], dropped: 0 })),
      ...(overrides.toolMemory || {}),
    },
    // Сверка записей пациента с CRM (только при известном номере) ходит в
    // YClients — во всех тестах застабана, иначе ход полез бы в сеть и в БД.
    listBookings: {
      run: jest.fn(async () => ({ bookings: [] })),
      ...(overrides.listBookings || {}),
    },
  };
}

// Нормализованные ответы провайдера (не сырой формат SDK).
const textResp = (t) => ({ text: t, toolCalls: [], stopReason: 'stop', assistantMsg: { role: 'assistant', content: t } });
const toolResp = (name, input, id = 'c1', text = '') => ({
  text,
  toolCalls: [{ id, name, input }],
  stopReason: 'tool_calls',
  assistantMsg: { role: 'assistant', content: text || null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] },
});

describe('runDialog', () => {
  test('только текст → возвращает реплику, инструменты не звались', async () => {
    const deps = makeDeps();
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте! Чем помочь?'));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-07-18' });
    expect(out.replies).toEqual(['Здравствуйте! Чем помочь?']);
    expect(out.escalated).toBe(false);
    expect(out.sideEffect).toBe(false);
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(1);
    expect(deps.state.setWatermark).toHaveBeenCalledWith(1, 'k', 100);
  });

  test('tool_call → выполняет инструмент с ctx.dialogKey, скармливает результат, финализирует', async () => {
    const deps = makeDeps();
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { staff_yc_id: 55, service_yc_id: 7, date: '2026-07-20' }))
      .mockResolvedValueOnce(textResp('Свободно 10:00. Записать?'));
    const out = await orchestrator.runDialog(1, 'k', { deps, ctx: { phone: '79001112233' } });
    expect(deps.registry.handlers.get_available_slots)
      .toHaveBeenCalledWith(1, { staff_yc_id: 55, service_yc_id: 7, date: '2026-07-20' },
        { dialogKey: 'k', clientPhone: '79001112233', clientName: null, nowMs: expect.any(Number) });
    expect(out.replies).toContain('Свободно 10:00. Записать?');
    expect(out.sideEffect).toBe(false);
    const secondCallMessages = deps.provider.createMessage.mock.calls[1][0].messages;
    const toolTurn = secondCallMessages[secondCallMessages.length - 1];
    expect(toolTurn.role).toBe('tool');
    expect(toolTurn.tool_call_id).toBe('c1');
  });

  test('escalate_to_operator → escalated:true и цикл останавливается', async () => {
    const deps = makeDeps();
    deps.provider.createMessage.mockResolvedValueOnce(toolResp('escalate_to_operator', { reason: 'жалоба' }));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.escalated).toBe(true);
    expect(out.sideEffect).toBe(true);
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(1);
  });

  // Регресс: book_chain partial + escalate_to_operator в одном ходе — модель пишет
  // честный отчёт («чистку записала, консультация не встала») И зовёт эскалацию
  // ОДНИМ ответом. Раньше text уходил в никуда: реплика пушится в replies ТОЛЬКО
  // когда toolCalls пуст (строка «if (!resp.toolCalls.length)» выше), а после
  // escalate цикл сразу прерывается — текстового хода больше не будет. Диспетчер
  // получал replies:[] и слал только generic DEFAULT_HANDOVER_TEXT, клиент никогда
  // не узнавал, что часть цепочки УЖЕ забронирована.
  test('escalate_to_operator с текстом в том же ходе → текст доходит в replies (честный отчёт при передаче администратору)', async () => {
    const deps = makeDeps();
    const text = 'Чистку записала на 14:00, консультация не встала — передаю администратору';
    deps.provider.createMessage.mockResolvedValueOnce(
      toolResp('escalate_to_operator', { reason: 'partial' }, 'c1', text));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.escalated).toBe(true);
    expect(out.replies).toContain(text);
  });

  // Regression-guard: без текста рядом с вызовом (обычная молчаливая эскалация)
  // replies по-прежнему пуст — диспетчер сам подставляет DEFAULT_HANDOVER_TEXT.
  test('escalate_to_operator БЕЗ текста в том же ходе → replies остаётся пустым', async () => {
    const deps = makeDeps();
    deps.provider.createMessage.mockResolvedValueOnce(toolResp('escalate_to_operator', { reason: 'жалоба' }));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.escalated).toBe(true);
    expect(out.replies).toEqual([]);
  });

  test('create_booking вернул ошибку → bookingFailed:true (диспетчер переведёт на человека)', async () => {
    const deps = makeDeps({ handlers: { create_booking: jest.fn(async () => ({ invalid_args: true, error: 'выдуманный id' })) } });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('create_booking', { staff_yc_id: 1, service_yc_id: 2, datetime: 'x', client_phone: '7' }))
      .mockResolvedValueOnce(textResp('Секундочку, уточняю детали 🤍'));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.bookingFailed).toBe(true);
    // Пустая отписка «секундочку» без перепроверки слотов и без конкретного времени —
    // НЕ переигровка: диспетчер обязан перевести на человека.
    expect(out.bookingFailRecoverable).toBe(false);
    expect(out.sideEffect).toBe(false);
  });

  test('провал записи → бот перепроверил слоты и предложил другое время → bookingFailRecoverable:true', async () => {
    const deps = makeDeps({ handlers: { create_booking: jest.fn(async () => ({ created: false, error: 'Выбранное время недоступно.' })) } });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('create_booking', { staff_yc_id: 1, service_yc_id: 2, datetime: 'x', client_phone: '7' }))
      .mockResolvedValueOnce(toolResp('get_available_slots', { staff_yc_id: 1, service_yc_id: 2, date: '2026-07-30' }, 'c2'))
      .mockResolvedValueOnce(textResp('К сожалению, это время только что заняли. Могу предложить 15:00 или 16:00 🤍'));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.bookingFailed).toBe(true);
    expect(out.bookingFailRecoverable).toBe(true);   // перепроверила слоты + назвала конкретное время
  });

  test('провал записи → бот соврал об успехе («записала») → НЕ переигровка (falseSuccess гейтит)', async () => {
    const deps = makeDeps({ handlers: { create_booking: jest.fn(async () => ({ created: false, error: 'Выбранное время недоступно.' })) } });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('create_booking', { staff_yc_id: 1, service_yc_id: 2, datetime: 'x', client_phone: '7' }))
      .mockResolvedValueOnce(textResp('Готово, записала вас на 16:00 ✅'));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.bookingFailed).toBe(true);
    expect(out.falseSuccess).toBe(true);
    expect(out.bookingFailRecoverable).toBe(false);
  });

  test('create_booking успех → bookingFailed:false', async () => {
    const deps = makeDeps();   // дефолтный create_booking → { created:true, record_id:999 }
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('create_booking', { staff_yc_id: 1, service_yc_id: 2, datetime: 'x', client_phone: '7' }))
      .mockResolvedValueOnce(textResp('Записала вас, всё готово ✨'));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.bookingFailed).toBe(false);
    expect(out.sideEffect).toBe(true);
  });

  test('book_chain booked_all → writeSucceeded: реплика «записала» не считается ложным успехом', async () => {
    const deps = makeDeps({ handlers: { book_chain: jest.fn(async () => ({
      booked_all: true,
      records: [{ record_id: 555, service_title: 'Чистка', datetime: '2026-07-30T14:00:00+03:00' }],
    })) } });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('book_chain', { option_id: 'o1', comment: 'чистка+консультация' }))
      .mockResolvedValueOnce(textResp('Записала вас на обе процедуры, ждём! ✅'));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.falseSuccess).toBe(false);
    expect(out.bookingFailed).toBe(false);
    expect(out.sideEffect).toBe(true);
  });

  test('book_chain провал без partial → bookingFailed', async () => {
    const deps = makeDeps({ handlers: { book_chain: jest.fn(async () => ({
      booked_all: false, partial: false, failed_at: 'svc101', error: 'занято', records: [],
    })) } });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('book_chain', { option_id: 'o1', comment: 'к' }))
      .mockResolvedValueOnce(textResp('Секундочку, уточняю детали 🤍'));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.bookingFailed).toBe(true);
  });

  test('book_chain частичный успех (partial) → sideEffect+bookingFailed, falseSuccess подавлен (writeSucceeded)', async () => {
    const deps = makeDeps({ handlers: { book_chain: jest.fn(async () => ({
      booked_all: false, partial: true, failed_at: 'svc102',
      records: [{ record_id: 555, service_title: 'Чистка', datetime: '2026-07-30T14:00:00+03:00' }],
      error: 'вторую занято', hint: 'скажи честно',
    })) } });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('book_chain', { option_id: 'o1', comment: 'к' }))
      .mockResolvedValueOnce(textResp('Записала вас на чистку, а по второй процедуре предложу другое время 🤍'));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.sideEffect).toBe(true);        // partial → ход нельзя выбросить перегенерацией
    expect(out.bookingFailed).toBe(true);     // bookingErrored && !bookingSucceeded
    expect(out.falseSuccess).toBe(false);     // writeSucceeded подавляет ложный успех, хотя реплика «записала вас»
  });

  test('диалог уже escalated → ничего не делаем', async () => {
    const deps = makeDeps({ state: { getOrCreate: jest.fn(async () => ({ status: 'escalated' })) } });
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.escalated).toBe(true);
    expect(deps.provider.createMessage).not.toHaveBeenCalled();
  });

  test('вернули боту после эскалации (status=bot + escalated_reason) → в промпт идёт анти-ре-эскалация', async () => {
    const deps = makeDeps({
      state: { getOrCreate: jest.fn(async () => ({ status: 'bot', escalated_reason: 'прошлый негатив' })) },
    });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Конечно, помогу с записью!'));
    await orchestrator.runDialog(1, 'k', { deps });
    const sentSystem = deps.provider.createMessage.mock.calls[0][0].system;
    expect(sentSystem).toMatch(/ВЕРНУЛ ТЕБЕ АДМИНИСТРАТОР/i);
  });

  test('клиент найден по номеру → имя идёт в промпт и в toolCtx (create_booking подставит номер сам)', async () => {
    const deps = makeDeps({ identity: { resolveClient: jest.fn(async () => ({ id: 5, name: 'Анна', givenName: 'Анна', phone: '+79001112233' })) } });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { staff_yc_id: 1, service_yc_id: 1, date: '2026-07-20' }))
      .mockResolvedValueOnce(textResp('Свободно 10:00. Записать?'));
    await orchestrator.runDialog(1, 'k', { deps, ctx: { phone: '79001112233' } });
    expect(deps.identity.resolveClient).toHaveBeenCalledWith(1, '79001112233');
    const sentSystem = deps.provider.createMessage.mock.calls[0][0].system;
    expect(sentSystem).toMatch(/ИДЕНТИФИКАЦИЯ ПАЦИЕНТА/);
    expect(sentSystem).toContain('Анна');
    expect(deps.registry.handlers.get_available_slots)
      .toHaveBeenCalledWith(1, expect.anything(), expect.objectContaining({ clientName: 'Анна', clientPhone: '79001112233' }));
  });

  test('в промпт уходит только ЛИЧНОЕ имя, в запись — ФИО целиком', async () => {
    // Инцидент 2026-08-04: пациентке «Вихарева Мария Андреевна» Мила написала
    // «Мария Андреевна, …» — в промпт уходило ФИО из карточки целиком.
    const deps = makeDeps({ identity: { resolveClient: jest.fn(async () => (
      { id: 5, name: 'Вихарева Мария Андреевна', givenName: 'Мария', phone: '+79133850883' })) } });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { staff_yc_id: 1, service_yc_id: 1, date: '2026-07-20' }))
      .mockResolvedValueOnce(textResp('Свободно 10:00. Записать?'));
    await orchestrator.runDialog(1, 'k', { deps, ctx: { phone: '79133850883' } });
    const sentSystem = deps.provider.createMessage.mock.calls[0][0].system;
    expect(sentSystem).toContain('Мария');
    expect(sentSystem).not.toContain('Андреевна');
    expect(sentSystem).not.toContain('Вихарева');
    // В карточку записи YClients уходит полное ФИО — там оно и нужно.
    expect(deps.registry.handlers.get_available_slots)
      .toHaveBeenCalledWith(1, expect.anything(),
        expect.objectContaining({ clientName: 'Вихарева Мария Андреевна' }));
  });

  test('имя из карточки не распознано (телефон вместо имени) → ветка «имени не знаем»', async () => {
    const deps = makeDeps({ identity: { resolveClient: jest.fn(async () => (
      { id: 6, name: '79265303607', givenName: null, phone: '+79265303607' })) } });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте!'));
    await orchestrator.runDialog(1, 'k', { deps, ctx: { phone: '79265303607' } });
    expect(deps.provider.createMessage.mock.calls[0][0].system)
      .toMatch(/как могу к вам обращаться/i);
  });

  test('резолвинг клиента упал (нет БД) → ход не падает, работаем без имени', async () => {
    const deps = makeDeps({ identity: { resolveClient: jest.fn(async () => { throw new Error('no db'); }) } });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте!'));
    const out = await orchestrator.runDialog(1, 'k', { deps, ctx: { phone: '79001112233' } });
    expect(out.replies).toEqual(['Здравствуйте!']);
  });

  test('канал без номера → resolveClient не зовётся, промпт просит уточнить имя как у нового', async () => {
    const deps = makeDeps();
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте!'));
    await orchestrator.runDialog(1, 'k', { deps });   // ctx без phone
    expect(deps.identity.resolveClient).not.toHaveBeenCalled();
    const sentSystem = deps.provider.createMessage.mock.calls[0][0].system;
    expect(sentSystem).toMatch(/как.*обращаться/i);
  });

  test('обычный диалог (bot, без escalated_reason) → блока анти-ре-эскалации НЕТ', async () => {
    const deps = makeDeps();
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте!'));
    await orchestrator.runDialog(1, 'k', { deps });
    const sentSystem = deps.provider.createMessage.mock.calls[0][0].system;
    expect(sentSystem).not.toMatch(/ВЕРНУЛ ТЕБЕ АДМИНИСТРАТОР/i);
  });

  test('новое входящее во время прогона без side-effect → черновик выброшен, перегенерация', async () => {
    let calls = 0;
    const deps = makeDeps({ history: { hasIncomingAfter: jest.fn(async () => (++calls === 1)) } });
    deps.provider.createMessage
      .mockResolvedValueOnce(textResp('ответ про маникюр'))
      .mockResolvedValueOnce(textResp('ответ про педикюр'));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.replies).toEqual(['ответ про педикюр']);
    expect(deps.history.loadTranscript).toHaveBeenCalledTimes(2);
  });

  test('защитный лимит итераций: бесконечный tool_call не зацикливается', async () => {
    const deps = makeDeps();
    deps.provider.createMessage.mockResolvedValue(
      toolResp('get_available_slots', { staff_yc_id: 1, service_yc_id: 1, date: '2026-07-20' }));
    await orchestrator.runDialog(1, 'k', { deps });
    // MAX_ITERS вызовов в цикле + 1 добивочный без инструментов (реплик-то нет).
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(orchestrator.MAX_ITERS + 1);
  });

  // Инцидент 2026-08-05: диалог, возобновлённый через неделю, был неотличим от
  // продолжающегося, и Мила не поздоровалась.
  test('транскрипт грузится с метками времени, граница переписки уходит в промпт', async () => {
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({
          messages: [{ role: 'user', content: '[05.08 08:47] доброе утро' }],
          watermark: 100,
          session: { newSession: true, gapText: '7 дней' },
        })),
      },
    });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте! 🤍'));
    await orchestrator.runDialog(1, 'k', { deps });

    expect(deps.history.loadTranscript.mock.calls[0][2]).toMatchObject({ withTime: true });
    const { system } = deps.provider.createMessage.mock.calls[0][0];
    expect(system).toContain('НАЧАЛО НОВОЙ ПЕРЕПИСКИ');
    expect(system).toContain('7 дней назад');
  });

  test('без границы переписки блока в промпте нет', async () => {
    const deps = makeDeps();   // дефолтный loadTranscript отдаёт транскрипт без session
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Есть окошко в 18:30'));
    await orchestrator.runDialog(1, 'k', { deps });
    // withTime безусловен: промпт ВСЕГДА описывает формат метки [дд.мм чч:мм],
    // и транскрипт без меток сделал бы это описание ложью.
    expect(deps.history.loadTranscript.mock.calls[0][2]).toMatchObject({ withTime: true });
    const { system } = deps.provider.createMessage.mock.calls[0][0];
    expect(system).not.toContain('НАЧАЛО НОВОЙ ПЕРЕПИСКИ');
  });

  test('при новой переписке приветствие не считается повтором (reply-guard молчит)', async () => {
    mockLogger.warn.mockClear();
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({
          messages: [
            { role: 'assistant', content: '[29.07 09:44] Записала вас на 29 июля' },
            { role: 'user', content: '[05.08 08:47] доброе утро' },
          ],
          watermark: 100,
          session: { newSession: true, gapText: '7 дней' },
        })),
      },
    });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте! Чем могу помочь?'));
    await orchestrator.runDialog(1, 'k', { deps });
    const guardLogs = mockLogger.warn.mock.calls.filter(([msg]) => String(msg).includes('reply-guard'));
    expect(guardLogs.join(' ')).not.toContain('repeat_greeting');
  });

  test('внутри одной переписки повторное приветствие всё ещё ловится reply-guard', async () => {
    mockLogger.warn.mockClear();
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({
          messages: [
            { role: 'assistant', content: '[05.08 08:40] Здравствуйте! Я Мила' },
            { role: 'user', content: '[05.08 08:47] хочу записаться' },
          ],
          watermark: 100,
          session: { newSession: false, gapText: null },
        })),
      },
    });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте! Чем могу помочь?'));
    await orchestrator.runDialog(1, 'k', { deps });
    const guardLogs = mockLogger.warn.mock.calls.filter(([msg]) => String(msg).includes('reply-guard'));
    expect(guardLogs.join(' ')).toContain('repeat_greeting');
  });

  // Инцидент 2026-08-06 (79165370505): первое в истории обращение, Мила
  // ответила по делу без приветствия и без представления. Признак первого
  // обращения детерминированный: в транскрипте нет НИ ОДНОЙ своей реплики
  // (ловит свежую pending-отправку) И в БД нет ни одного исходящего за всю
  // историю диалога (ловит всё, что не влезло в окно LIMIT 20).
  test('первое обращение → блок ПЕРВОЕ ОБРАЩЕНИЕ в промпте', async () => {
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({
          messages: [{ role: 'user', content: '[06.08 08:27] Доброе утро! Можете записать меня?' }],
          watermark: 100,
          session: { newSession: true, gapText: null },
        })),
        hasEverAnswered: jest.fn(async () => false),
      },
    });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте! Я Мила'));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(deps.history.hasEverAnswered).toHaveBeenCalledWith(1, 'k');
    expect(deps.provider.createMessage.mock.calls[0][0].system).toContain('ПЕРВОЕ ОБРАЩЕНИЕ');
  });

  test('мы уже отвечали в этом диалоге → блока нет', async () => {
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({
          messages: [{ role: 'user', content: '[06.08 08:27] я снова к вам' }],
          watermark: 100,
          session: { newSession: true, gapText: null },
        })),
        hasEverAnswered: jest.fn(async () => true),
      },
    });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Конечно, слушаю вас'));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(deps.provider.createMessage.mock.calls[0][0].system).not.toContain('ПЕРВОЕ ОБРАЩЕНИЕ');
  });

  // Своя реплика в транскрипте — вопрос закрыт без похода в БД: лишний запрос
  // на КАЖДОМ ходу живого диалога не нужен.
  test('своя реплика в транскрипте → в БД не ходим и блока нет', async () => {
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({
          messages: [
            { role: 'assistant', content: '[06.08 08:28] Есть 16:00' },
            { role: 'user', content: '[06.08 08:29] да' },
          ],
          watermark: 100,
          session: { newSession: false, gapText: null },
        })),
        hasEverAnswered: jest.fn(async () => false),
      },
    });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Записала вас'));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(deps.history.hasEverAnswered).not.toHaveBeenCalled();
    expect(deps.provider.createMessage.mock.calls[0][0].system).not.toContain('ПЕРВОЕ ОБРАЩЕНИЕ');
  });

  // Признак первого обращения — новый запрос в БД на пути, который до него
  // работал. Сбой не должен ронять ход: без блока Мила отвечает как раньше,
  // а с исключением пациент не получил бы вообще ничего.
  test('сбой проверки первого обращения не роняет ход (fail-open, блока нет)', async () => {
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({
          messages: [{ role: 'user', content: 'Доброе утро!' }],
          watermark: 100,
          session: { newSession: true, gapText: null },
        })),
        hasEverAnswered: jest.fn(async () => { throw new Error('db down'); }),
      },
    });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте! Чем помочь?'));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.replies).toEqual(['Здравствуйте! Чем помочь?']);
    expect(deps.provider.createMessage.mock.calls[0][0].system).not.toContain('ПЕРВОЕ ОБРАЩЕНИЕ');
  });

  // Промпт-блока мало: на живом пробнике ветка известного пациента с отказом
  // по времени дала приветствие 1 раз из 3 (scripts/agent-greeting-probe.js).
  // Дописываем детерминированно — как блок актуальных записей бьёт память.
  test('первое обращение без приветствия → приветствие дописывается к реплике', async () => {
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({
          messages: [{ role: 'user', content: 'Доброе утро! Запишите меня на 12.08 в 16:00' }],
          watermark: 100,
          session: { newSession: true, gapText: null },
        })),
        hasEverAnswered: jest.fn(async () => false),
      },
      identity: { resolveClient: jest.fn(async () => ({ id: 1, name: 'Тестова Юлия', givenName: 'Юлия', phone: '79165370505' })) },
    });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('К сожалению, 16:00 занято — есть 18:30.'));
    const out = await orchestrator.runDialog(1, 'k', {
      deps, salonName: 'PERI CLINIC', ctx: { phone: '79165370505' },
    });
    expect(out.replies[0]).toBe(
      'Здравствуйте, Юлия! Я Мила, виртуальный администратор PERI CLINIC.\n\n'
      + 'К сожалению, 16:00 занято — есть 18:30.');
  });

  test('первое обращение С приветствием от модели → реплика не трогается', async () => {
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({
          messages: [{ role: 'user', content: 'Доброе утро!' }],
          watermark: 100,
          session: { newSession: true, gapText: null },
        })),
        hasEverAnswered: jest.fn(async () => false),
      },
    });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте! Я Мила. Чем помочь?'));
    const out = await orchestrator.runDialog(1, 'k', { deps, salonName: 'PERI CLINIC' });
    expect(out.replies).toEqual(['Здравствуйте! Я Мила. Чем помочь?']);
  });

  test('не первое обращение → приветствие не дописывается', async () => {
    const deps = makeDeps();   // hasEverAnswered → true
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Есть окошко в 18:30'));
    const out = await orchestrator.runDialog(1, 'k', { deps, salonName: 'PERI CLINIC' });
    expect(out.replies).toEqual(['Есть окошко в 18:30']);
  });

  test('первое обращение без приветствия в ответе → reply-guard пишет missing_greeting', async () => {
    mockLogger.warn.mockClear();
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({
          messages: [{ role: 'user', content: '[06.08 08:27] Доброе утро! Можете записать меня?' }],
          watermark: 100,
          session: { newSession: true, gapText: null },
        })),
        hasEverAnswered: jest.fn(async () => false),
      },
    });
    deps.provider.createMessage.mockResolvedValueOnce(
      textResp('Да, на 12 августа есть свободное время. Записать вас?'));
    await orchestrator.runDialog(1, 'k', { deps });
    const guardLogs = mockLogger.warn.mock.calls.filter(([msg]) => String(msg).includes('reply-guard'));
    expect(guardLogs.join(' ')).toContain('missing_greeting');
  });

  test('newSession без измеренного разрыва: приветствие всё ещё считается повтором', async () => {
    // Без gapText блок «НАЧАЛО НОВОЙ ПЕРЕПИСКИ» не рендерится (system-prompt.js),
    // то есть приветствие промптом НЕ предписано — глушить guard не за что.
    mockLogger.warn.mockClear();
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({
          messages: [
            { role: 'assistant', content: '[05.08 08:40] Здравствуйте! Я Мила' },
            { role: 'user', content: '[05.08 08:47] хочу записаться' },
          ],
          watermark: 100,
          session: { newSession: true, gapText: null },
        })),
      },
    });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте! Чем могу помочь?'));
    await orchestrator.runDialog(1, 'k', { deps });
    const sentSystem = deps.provider.createMessage.mock.calls[0][0].system;
    expect(sentSystem).not.toContain('НАЧАЛО НОВОЙ ПЕРЕПИСКИ');
    const guardLogs = mockLogger.warn.mock.calls.filter(([msg]) => String(msg).includes('reply-guard'));
    expect(guardLogs.join(' ')).toContain('repeat_greeting');
  });

  // Метка времени реплики — не предложенное пациенту время: reply-guard иначе
  // считал бы разрешённым любое время отправки сообщения.
  test('время из метки транскрипта не становится разрешённым для reply-guard', async () => {
    mockLogger.warn.mockClear();
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({
          messages: [{ role: 'user', content: '[05.08 08:47] хочу записаться' }],
          watermark: 100,
        })),
      },
    });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Могу предложить 08:47'));
    await orchestrator.runDialog(1, 'k', { deps, today: '2026-08-05', now: '07:00' });
    const guardLogs = mockLogger.warn.mock.calls.filter(([msg]) => String(msg).includes('reply-guard'));
    expect(guardLogs.join(' ')).toContain('unknown_time');
  });

  // Метка стоит в начале каждой ассистентской реплики транскрипта и работает
  // как образец: промпт-запрета «не пиши её» недостаточно.
  test('метку времени из ответа модели пациент не получает', async () => {
    const deps = makeDeps();
    deps.provider.createMessage.mockResolvedValueOnce(
      textResp('[05.08 09:12] Здравствуйте! Есть окошко в 18:30'));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.replies).toEqual(['Здравствуйте! Есть окошко в 18:30']);
  });

  test('обычная реплика проходит без изменений', async () => {
    const deps = makeDeps();
    const text = 'Здравствуйте!\nПодскажите, на какой день удобно?';
    deps.provider.createMessage.mockResolvedValueOnce(textResp(text));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.replies).toEqual([text]);
  });

  // Ради этого сборка промпта и перенесена внутрь цикла: граница переписки
  // известна только после загрузки транскрипта, и на второй попытке она своя.
  test('перегенерация пересобирает промпт со свежей границей переписки', async () => {
    let loads = 0;
    let checks = 0;
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => (++loads === 1
          ? { messages: [{ role: 'user', content: 'привет' }], watermark: 100,
            session: { newSession: false, gapText: null } }
          : { messages: [{ role: 'user', content: 'привет' }], watermark: 101,
            session: { newSession: true, gapText: '7 дней' } })),
        hasIncomingAfter: jest.fn(async () => (++checks === 1)),
      },
    });
    deps.provider.createMessage
      .mockResolvedValueOnce(textResp('ответ про маникюр'))
      .mockResolvedValueOnce(textResp('ответ про педикюр'));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(2);
    expect(deps.provider.createMessage.mock.calls[0][0].system).not.toContain('НАЧАЛО НОВОЙ ПЕРЕПИСКИ');
    expect(deps.provider.createMessage.mock.calls[1][0].system).toContain('НАЧАЛО НОВОЙ ПЕРЕПИСКИ');
  });
});

// ── Логирование вызовов инструментов (Task 13: «в логах виден вызов book_chain») ──
describe('логирование tool-вызовов', () => {
  beforeEach(() => { mockLogger.info.mockClear(); mockLogger.warn.mockClear(); mockLogger.error.mockClear(); });

  test('успешный вызов инструмента логируется через logger.info: имя, длительность, префикс диалога', async () => {
    const deps = makeDeps();
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { staff_yc_id: 1, service_yc_id: 1, date: '2026-07-20' }))
      .mockResolvedValueOnce(textResp('Свободно 10:00.'));
    await orchestrator.runDialog(1, 'k', { deps });
    const call = mockLogger.info.mock.calls.find(([msg]) => msg.includes('tool get_available_slots'));
    expect(call).toBeTruthy();
    expect(call[0]).toMatch(/^dialog k: tool get_available_slots\(.+\) \d+ms ok/);
  });

  // Разбор инцидента 2026-07-31 упёрся в отсутствие аргументов в логе: по нему
  // нельзя было понять, с какой услугой модель спрашивала слоты.
  test('лог вызова содержит аргументы инструмента (для разбора инцидентов)', async () => {
    const deps = makeDeps();
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { staff_yc_id: 1914276, service_yc_id: 9536496, date: '2026-08-04' }))
      .mockResolvedValueOnce(textResp('Свободно 10:00.'));
    await orchestrator.runDialog(1, 'k', { deps });
    const call = mockLogger.info.mock.calls.find(([msg]) => msg.includes('tool get_available_slots'));
    expect(call[0]).toContain('staff_yc_id=1914276');
    expect(call[0]).toContain('service_yc_id=9536496');
    expect(call[0]).toContain('date=2026-08-04');
  });

  test('успешная запись логирует record_id, но НЕ телефон клиента (PII)', async () => {
    const deps = makeDeps();
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('create_booking',
        { staff_yc_id: 1, service_yc_id: 2, datetime: '2026-07-30T10:30:00+03:00', client_phone: '79001234567' }))
      .mockResolvedValueOnce(textResp('Готово ✅'));
    await orchestrator.runDialog(1, 'k', { deps });
    const call = mockLogger.info.mock.calls.find(([msg]) => msg.includes('tool create_booking'));
    expect(call).toBeTruthy();
    expect(call[0]).toContain('record_id=999');
    expect(call[0]).not.toContain('79001234567');
  });

  test('провалившийся инструмент (исключение) — старое logger.error не задваивается новым logger.info', async () => {
    const deps = makeDeps({
      handlers: { get_available_slots: jest.fn(async () => { throw new Error('boom'); }) },
    });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { staff_yc_id: 1, service_yc_id: 1, date: '2026-07-20' }))
      .mockResolvedValueOnce(textResp('Секундочку 🤍'));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.info.mock.calls.some(([msg]) => msg.includes('tool get_available_slots'))).toBe(false);
  });

  test('лог не превышает разумную длину (нет дампа всего результата)', async () => {
    const deps = makeDeps({
      handlers: {
        get_available_slots: jest.fn(async () => ({
          slots: Array.from({ length: 200 }, (_, i) => ({ time: `${String(i % 24).padStart(2, '0')}:00`, extra: 'x'.repeat(50) })),
        })),
      },
    });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { staff_yc_id: 1, service_yc_id: 1, date: '2026-07-20' }))
      .mockResolvedValueOnce(textResp('Есть окошки.'));
    await orchestrator.runDialog(1, 'k', { deps });
    const call = mockLogger.info.mock.calls.find(([msg]) => msg.includes('tool get_available_slots'));
    expect(call).toBeTruthy();
    expect(call[0].length).toBeLessThan(300);
  });
});

// ── Регресс: немой ход (инцидент 2026-07-19, диалог 79200255591) ──
// Flash Lite отдаёт tool_calls с пустым content. Мультизапрос (2 услуги × 2 пациента)
// упёрся в MAX_ITERS=6, цикл вышел с replies=[] — клиент не получил НИЧЕГО.
describe('исчерпание лимита tool-итераций', () => {
  test('7 подряд tool-итераций укладываются в лимит и дают ответ', async () => {
    const deps = makeDeps();
    for (let i = 0; i < 7; i++) {
      deps.provider.createMessage.mockResolvedValueOnce(
        toolResp('get_available_slots', { date: '2026-07-20' }, `c${i}`));
    }
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Свободно в 16:00 или 18:30.'));

    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-07-19' });

    expect(out.replies).toEqual(['Свободно в 16:00 или 18:30.']);
    expect(out.exhausted).toBeFalsy();
  });

  test('лимит исчерпан без единой реплики → добивочный вызов БЕЗ инструментов даёт ответ', async () => {
    const deps = makeDeps();
    deps.provider.createMessage.mockImplementation(async ({ tools }) => {
      if (!tools || tools.length === 0) return textResp('Завтра есть окошки в 16:00 и 18:30.');
      return toolResp('get_available_slots', { date: '2026-07-20' });
    });

    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-07-19' });

    expect(out.replies).toEqual(['Завтра есть окошки в 16:00 и 18:30.']);
    expect(out.exhausted).toBe(true);
    // Добивочный вызов идёт с пустым списком инструментов — модель обязана ответить прозой.
    const lastArgs = deps.provider.createMessage.mock.calls.at(-1)[0];
    expect(lastArgs.tools).toEqual([]);
  });

  test('даже добивочный вызов молчит → ход помечен exhausted, реплик нет', async () => {
    const deps = makeDeps();
    deps.provider.createMessage.mockImplementation(async ({ tools }) => {
      if (!tools || tools.length === 0) return textResp('');
      return toolResp('get_available_slots', { date: '2026-07-20' });
    });

    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-07-19' });

    expect(out.replies).toEqual([]);
    expect(out.exhausted).toBe(true);
  });

  test('промежуточный нарратив на tool-ходах НЕ идёт клиенту → добивочный вызов даёт реальный ответ', async () => {
    // Раньше филлер «Секунду, уточняю…» на каждом tool-ходе считался репликой и
    // спамил клиента. Теперь пациенту уходит ТОЛЬКО финальная реплика (ход без
    // инструментов); филлер отбрасывается, и добивочный вызов даёт нормальный ответ.
    const deps = makeDeps();
    deps.provider.createMessage.mockImplementation(async ({ tools }) => {
      if (!tools || tools.length === 0) return textResp('Завтра свободно в 16:00 и 18:30.');
      return toolResp('get_available_slots', { date: '2026-07-20' }, 'c1', 'Секунду, уточняю…');
    });

    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-07-19' });

    expect(out.replies).toEqual(['Завтра свободно в 16:00 и 18:30.']);
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(orchestrator.MAX_ITERS + 1);
  });
});

// Инцидент 2026-07-24: create_booking успешно создал запись, но следующий вызов
// LLM (за подтверждающей фразой) упал 421 → диалог ушёл на оператора при УЖЕ
// созданной брони. Если запись сделана, а провайдер потом падает — не роняем ход,
// а отдаём детерминированное подтверждение (без LLM) и НЕ эскалируем.
describe('runDialog — деградация после успешной записи', () => {
  test('провайдер падает ПОСЛЕ успешного create_booking → детерминированное подтверждение, без эскалации', async () => {
    const deps = makeDeps();
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('create_booking',
        { staff_yc_id: 1, service_yc_id: 2, datetime: '2026-07-27T19:30:00+03:00', client_name: 'Ирина' }))
      .mockRejectedValueOnce(Object.assign(new Error('421 отсутствует поле usage'), { status: 421 }));

    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-07-24' });

    expect(out.degradedAfterWrite).toBe(true);
    expect(out.escalated).toBe(false);
    expect(out.sideEffect).toBe(true);
    expect(out.replies).toHaveLength(1);
    expect(out.replies[0]).toMatch(/Ирина/);
    expect(out.replies[0]).toMatch(/27 июля/);
    expect(out.replies[0]).toMatch(/19:30/);
  });

  test('провайдер падает БЕЗ успешной записи → исключение пробрасывается (эскалация как раньше)', async () => {
    const deps = makeDeps();
    deps.provider.createMessage.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    await expect(orchestrator.runDialog(1, 'k', { deps, today: '2026-07-24' })).rejects.toThrow('boom');
  });
});

// ── reply-guard в оркестраторе (инцидент 2026-07-28: выдуманное 14:00; утечка
// внутренней кухни правила 9). Жёсткие нарушения → один корректирующий довызов,
// время/стиль → только лог (меряем шум неделю). ──
describe('reply-guard в оркестраторе (2026-07-29)', () => {
  test('жёсткое нарушение (слово-табу) → один корректирующий довызов, отдаётся переписанная реплика', async () => {
    const deps = makeDeps();
    deps.provider.createMessage
      .mockResolvedValueOnce(textResp('Посмотрела в нашем прайсе, чистка 6500 ₽'))
      .mockResolvedValueOnce(textResp('Чистка лица стоит 6500 ₽'));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-07-29', now: '09:00' });
    expect(out.replies).toEqual(['Чистка лица стоит 6500 ₽']);
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(2);
    // Корректирующий довызов — без инструментов.
    const fixArgs = deps.provider.createMessage.mock.calls[1][0];
    expect(fixArgs.tools).toEqual([]);
  });

  test('переписанная реплика всё ещё грязная → отдаём её как есть (без второго ретрая)', async () => {
    const deps = makeDeps();
    deps.provider.createMessage
      .mockResolvedValueOnce(textResp('В нашем прайсе чистка 6500'))
      .mockResolvedValueOnce(textResp('Смотрю прайс — 6500'));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-07-29', now: '09:00' });
    // Доставляется именно переписанная (пусть и грязная) реплика, не исходная.
    expect(out.replies).toEqual(['Смотрю прайс — 6500']);
    // Ровно 2 вызова: исходный + один ретрай. Второй раз не переписываем.
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(2);
  });

  test('корректирующий довызов упал → отдаём исходную реплику как есть (без throw)', async () => {
    const deps = makeDeps();
    deps.provider.createMessage
      .mockResolvedValueOnce(textResp('Посмотрела в нашем прайсе, чистка 6500 ₽'))
      .mockRejectedValueOnce(new Error('421 boom'));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-07-29', now: '09:00' });
    expect(out.replies).toEqual(['Посмотрела в нашем прайсе, чистка 6500 ₽']);
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(2);
  });

  test('unknown_time НЕ переписывается (лог-only)', async () => {
    const deps = makeDeps({ handlers: { get_available_slots: jest.fn(async () => ({ slots: [{ time: '14:30' }] })) } });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { staff_yc_id: 1, service_yc_id: 1, date: '2026-07-30' }))
      .mockResolvedValueOnce(textResp('могу предложить 15:00'));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-07-29', now: '09:00' });
    // Реплика доставлена как есть, без корректирующего довызова: 1 tool-итерация + 1 финал = 2 вызова.
    expect(out.replies).toEqual(['могу предложить 15:00']);
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(2);
  });

  test('время, названное клиентом в истории, не считается unknown_time', async () => {
    const deps = makeDeps({
      history: { loadTranscript: jest.fn(async () => ({ messages: [{ role: 'user', content: 'хочу на 15:00' }], watermark: 100 })) },
    });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Хорошо, 15:00 вам подходит?'));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-07-29', now: '09:00' });
    expect(out.replies).toEqual(['Хорошо, 15:00 вам подходит?']);
    // Нет ретрая: только исходный вызов.
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(1);
  });
});

describe('AGENT_CATALOG_IN_PROMPT', () => {
  test('флаг + блок собрался → каталог в system, реестр catalogMode (без list_services)', async () => {
    const deps = makeDeps();
    deps.registry = undefined;                          // пусть оркестратор выберет сам
    deps.config = { AGENT_CATALOG_IN_PROMPT: true };
    deps.catalogBlock = { buildSafe: jest.fn(async () => 'КАТАЛОГ УСЛУГ КЛИНИКИ (…):\n7|Ботокс|60|5000||55') };
    deps.provider.createMessage.mockResolvedValue({ text: 'Здравствуйте!', toolCalls: [], assistantMsg: { role: 'assistant', content: 'Здравствуйте!' } });

    await orchestrator.runDialog(1, 'dlg', { deps });

    expect(deps.catalogBlock.buildSafe).toHaveBeenCalledWith(1);
    const call = deps.provider.createMessage.mock.calls[0][0];
    expect(call.system).toContain('КАТАЛОГ УСЛУГ КЛИНИКИ');
    expect(call.system).toContain('ИСТОЧНИК КАТАЛОГА УСЛУГ');
    const names = call.tools.map(t => t.name);
    expect(names).not.toContain('list_services');
    expect(names).toContain('get_service_masters');
  });

  test('флаг есть, но блок не собрался (null) → штатный legacy: list_services в схемах, каталога в system нет', async () => {
    const deps = makeDeps();
    deps.registry = undefined;
    deps.config = { AGENT_CATALOG_IN_PROMPT: true };
    deps.catalogBlock = { buildSafe: jest.fn(async () => null) };
    deps.provider.createMessage.mockResolvedValue({ text: 'Здравствуйте!', toolCalls: [], assistantMsg: { role: 'assistant', content: 'Здравствуйте!' } });

    await orchestrator.runDialog(1, 'dlg', { deps });

    const call = deps.provider.createMessage.mock.calls[0][0];
    expect(call.system).not.toContain('КАТАЛОГ УСЛУГ КЛИНИКИ');
    expect(call.tools.map(t => t.name)).toContain('list_services');
  });

  test('флаг выключен → buildSafe даже не зовётся', async () => {
    const deps = makeDeps();
    deps.config = { AGENT_CATALOG_IN_PROMPT: false };
    deps.catalogBlock = { buildSafe: jest.fn() };
    deps.provider.createMessage.mockResolvedValue({ text: 'Здравствуйте!', toolCalls: [], assistantMsg: { role: 'assistant', content: 'Здравствуйте!' } });

    await orchestrator.runDialog(1, 'dlg', { deps });

    expect(deps.catalogBlock.buildSafe).not.toHaveBeenCalled();
  });

  test('buildSafe бросает исключение → ход не падает, legacy: list_services в схемах, каталога в system нет', async () => {
    const deps = makeDeps();
    deps.registry = undefined;
    deps.config = { AGENT_CATALOG_IN_PROMPT: true };
    deps.catalogBlock = { buildSafe: jest.fn(async () => { throw new Error('boom'); }) };
    deps.provider.createMessage.mockResolvedValue({ text: 'Здравствуйте!', toolCalls: [], assistantMsg: { role: 'assistant', content: 'Здравствуйте!' } });

    const out = await orchestrator.runDialog(1, 'dlg', { deps });

    expect(out.replies).toEqual(['Здравствуйте!']);
    const call = deps.provider.createMessage.mock.calls[0][0];
    expect(call.system).not.toContain('КАТАЛОГ УСЛУГ КЛИНИКИ');
    expect(call.tools.map(t => t.name)).toContain('list_services');
  });
});

// Модель видит option_id только в результате инструмента ТОГО хода, а транскрипт
// пересобирается из текстов сообщений — на следующем ходу («давайте первый») id
// потерян. Живые варианты подкладываем в волатильный хвост промпта.
describe('активные варианты стыковки в системном промпте', () => {
  const seqOffers = require('./services/agent/sequential-offers');
  const CHAIN = [
    { service_yc_id: 101, service_title: 'Чистка', staff_yc_id: 7, staff_name: 'Юлия',
      datetime: '2026-07-30T10:30:00+03:00', seance_length: 3600 },
    { service_yc_id: 202, service_title: 'Консультация', staff_yc_id: 12, staff_name: 'Астемир',
      datetime: '2026-07-30T12:00:00+03:00', seance_length: 1800 },
  ];

  const NOW = Date.parse('2026-07-30T09:00:00+03:00');   // до стартов CHAIN

  beforeEach(() => seqOffers._reset());
  afterEach(() => { jest.restoreAllMocks(); seqOffers._reset(); });

  test('есть живые варианты диалога → их option_id и время попали в system', async () => {
    seqOffers.remember(1, 'k', {
      o1: { chain: CHAIN, booking_mode: 'separate_records' },
      o2: { chain: [CHAIN[0]], booking_mode: 'single_record' },
    });
    const deps = makeDeps();
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Оформляю?'));

    await orchestrator.runDialog(1, 'k', { deps, nowMs: NOW });

    const sys = deps.provider.createMessage.mock.calls[0][0].system;
    expect(sys).toContain('АКТИВНЫЕ ВАРИАНТЫ СТЫКОВКИ');
    expect(sys).toContain('o1 — 30.07: 10:30 «Чистка» (Юлия) → 12:00 «Консультация» (Астемир)');
    expect(sys).toContain('o2 — 30.07: 10:30 «Чистка» (Юлия)');
  });

  test('вариантов нет → блока в промпте нет', async () => {
    const deps = makeDeps();
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте!'));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(deps.provider.createMessage.mock.calls[0][0].system).not.toContain('АКТИВНЫЕ ВАРИАНТЫ СТЫКОВКИ');
  });

  test('варианты чужого диалога не подмешиваются', async () => {
    seqOffers.remember(1, 'other', { o1: { chain: CHAIN } });
    const deps = makeDeps();
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте!'));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(deps.provider.createMessage.mock.calls[0][0].system).not.toContain('АКТИВНЫЕ ВАРИАНТЫ СТЫКОВКИ');
  });

  test('протухшие варианты (часы берём из opts.nowMs) в промпт не идут', async () => {
    seqOffers.remember(1, 'k', { o1: { chain: CHAIN } }, { nowMs: 1000 });
    const deps = makeDeps();
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте!'));
    await orchestrator.runDialog(1, 'k', { deps, nowMs: 1000 + seqOffers.TTL_MS + 1 });
    expect(deps.provider.createMessage.mock.calls[0][0].system).not.toContain('АКТИВНЫЕ ВАРИАНТЫ СТЫКОВКИ');
  });

  test('старт, который уже прошёл, в промпт не попадает (часы — opts.nowMs)', async () => {
    const at = Date.parse('2026-07-30T10:45:00+03:00');           // кэш свежий, TTL ни при чём
    seqOffers.remember(1, 'k', {
      o1: { chain: [CHAIN[0]] },                                   // старт 10:30 — уже прошёл
      o2: { chain: [CHAIN[1]] },                                   // старт 12:00 — впереди
    }, { nowMs: at });
    const deps = makeDeps();
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте!'));

    await orchestrator.runDialog(1, 'k', { deps, nowMs: at + 60 * 1000 });

    const sys = deps.provider.createMessage.mock.calls[0][0].system;
    expect(sys).toContain('o2 — 30.07: 12:00 «Консультация» (Астемир)');
    expect(sys).not.toContain('o1 —');
  });

  test('оформленный book_chain вариант больше не рекламируется', async () => {
    seqOffers.remember(1, 'k', { o1: { chain: [CHAIN[0]] }, o2: { chain: [CHAIN[1]] } });
    seqOffers.markBooked(1, 'k', 'o1');
    const deps = makeDeps();
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте!'));

    await orchestrator.runDialog(1, 'k', { deps, nowMs: NOW });

    const sys = deps.provider.createMessage.mock.calls[0][0].system;
    expect(sys).toContain('o2 —');
    expect(sys).not.toContain('o1 —');
  });

  test('peek упал → ход не ломается, просто без блока', async () => {
    jest.spyOn(seqOffers, 'peek').mockImplementation(() => { throw new Error('boom'); });
    const deps = makeDeps();
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте!'));

    const out = await orchestrator.runDialog(1, 'k', { deps });

    expect(out.replies).toEqual(['Здравствуйте!']);
    expect(deps.provider.createMessage.mock.calls[0][0].system).not.toContain('АКТИВНЫЕ ВАРИАНТЫ СТЫКОВКИ');
  });
});

describe('журнал инструментов (tool-events/tool-memory)', () => {
  test('каждый tool-вызов буферизуется, попытка флашится с delivered=null, turnId в результате', async () => {
    const te = makeToolEventsStub();
    const deps = makeDeps({ toolEvents: te });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { staff_yc_id: 55, service_yc_id: 7, date: '2026-07-20' }))
      .mockResolvedValueOnce(textResp('Свободно 10:00.'));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    const buf = te.buffers[0];
    expect(buf.push).toHaveBeenCalledWith('get_available_slots',
      { staff_yc_id: 55, service_yc_id: 7, date: '2026-07-20' },
      { slots: [{ time: '10:00' }] }, false);
    expect(buf.flush).toHaveBeenCalledWith(null);
    expect(out.turnId).toBe('turn-1');
  });

  test('выжимка журнала уходит в системный промпт', async () => {
    const te = makeToolEventsStub();
    te.mod.loadRecent.mockResolvedValue([{ tool: 'x', age_ms: 1000 }]);
    const deps = makeDeps({
      toolEvents: te,
      toolMemory: { renderMemory: jest.fn(() => ({ lines: ['[сегодня 10:00] называла цены — «Чистка»: Юлия 5 000 ₽'], dropped: 0 })) },
    });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('ок'));
    await orchestrator.runDialog(1, 'k', { deps });
    const system = deps.provider.createMessage.mock.calls[0][0].system;
    expect(system).toContain('ЖУРНАЛ ТВОИХ ДЕЙСТВИЙ В ПРЕДЫДУЩИХ ХОДАХ');
    expect(system).toContain('Юлия 5 000 ₽');
    // Рендереру уходят именно строки loadRecent и часы хода: без nowMs гейт
    // свежести посчитал бы все слот-выдачи устаревшими.
    expect(deps.toolEvents.loadRecent).toHaveBeenCalledWith(1, 'k');
    expect(deps.toolMemory.renderMemory).toHaveBeenCalledWith(
      [{ tool: 'x', age_ms: 1000 }], { nowMs: expect.any(Number) });
  });

  // Аварийный рычаг AGENT_TOOL_MEMORY=false: память меняет поведение модели в
  // КАЖДОМ ходе и включена сразу для всех салонов — выключать её откатом кода
  // (или переименованием таблицы, которую migrations.js вернёт на рестарте)
  // нельзя. Гасится ровно ЧТЕНИЕ в промпт, запись журнала продолжается.
  describe('флаг AGENT_TOOL_MEMORY', () => {
    test('выключен → loadRecent не зовётся и блока в промпте нет', async () => {
      const te = makeToolEventsStub();
      const deps = makeDeps({
        toolEvents: te,
        toolMemory: { renderMemory: jest.fn(() => ({ lines: ['[сегодня 10:00] что-то'], dropped: 0 })) },
      });
      deps.config = { AGENT_TOOL_MEMORY: false };
      deps.provider.createMessage
        .mockResolvedValueOnce(toolResp('get_available_slots', { date: 'd' }))
        .mockResolvedValueOnce(textResp('ок'));
      const out = await orchestrator.runDialog(1, 'k', { deps });
      expect(out.replies).toEqual(['ок']);
      expect(deps.toolEvents.loadRecent).not.toHaveBeenCalled();
      expect(deps.toolMemory.renderMemory).not.toHaveBeenCalled();
      expect(deps.provider.createMessage.mock.calls[0][0].system).not.toContain('ЖУРНАЛ ТВОИХ ДЕЙСТВИЙ');
      // Форензика не зависит от флага: журнал хода всё равно пишется.
      expect(te.buffers[0].push).toHaveBeenCalledWith('get_available_slots', { date: 'd' }, { slots: [{ time: '10:00' }] }, false);
      expect(te.buffers[0].flush).toHaveBeenCalledWith(null);
    });

    test('включён → блок на месте (по умолчанию флаг включён)', async () => {
      const te = makeToolEventsStub();
      te.mod.loadRecent.mockResolvedValue([{ tool: 'x', age_ms: 1000 }]);
      const deps = makeDeps({
        toolEvents: te,
        toolMemory: { renderMemory: jest.fn(() => ({ lines: ['[сегодня 10:00] называла цены'], dropped: 0 })) },
      });
      deps.config = { AGENT_TOOL_MEMORY: true };
      deps.provider.createMessage.mockResolvedValueOnce(textResp('ок'));
      await orchestrator.runDialog(1, 'k', { deps });
      expect(deps.toolEvents.loadRecent).toHaveBeenCalledWith(1, 'k');
      expect(deps.provider.createMessage.mock.calls[0][0].system).toContain('ЖУРНАЛ ТВОИХ ДЕЙСТВИЙ');
      // Дефолт конфига — включено: тот же ход без deps.config ведёт себя так же.
      expect(require('./config').AGENT_TOOL_MEMORY).toBe(true);
    });
  });

  test('сбой loadRecent не роняет ход — промпт без блока (fail-open)', async () => {
    const te = makeToolEventsStub();
    te.mod.loadRecent.mockRejectedValue(new Error('db down'));
    const deps = makeDeps({ toolEvents: te });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('ок'));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.replies).toEqual(['ок']);
    expect(deps.provider.createMessage.mock.calls[0][0].system).not.toContain('ЖУРНАЛ ТВОИХ ДЕЙСТВИЙ');
  });

  test('перегенерация: выброшенная попытка флашится с delivered=false, доставленная — с null', async () => {
    const te = makeToolEventsStub();
    const deps = makeDeps({ toolEvents: te });
    deps.history.hasIncomingAfter = jest.fn(async () => true).mockResolvedValueOnce(true).mockResolvedValue(false);
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { date: 'd' }, 'c1'))
      .mockResolvedValueOnce(textResp('черновик'))
      .mockResolvedValueOnce(toolResp('get_available_slots', { date: 'd' }, 'c2'))
      .mockResolvedValueOnce(textResp('финальный ответ'));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.replies).toEqual(['финальный ответ']);
    expect(te.buffers).toHaveLength(2);
    expect(te.buffers[0].flush).toHaveBeenCalledWith(false);
    // Страховочный флаш обёртки добирает ТОЛЬКО актуальный буфер: вердикт
    // выброшенного черновика не должен переписываться вторым вызовом.
    expect(te.buffers[0].flush).toHaveBeenCalledTimes(1);
    expect(te.buffers[1].flush).toHaveBeenCalledWith(null);
    expect(out.turnId).toBe('turn-2');
  });

  test('провайдер упал без записи → flush(null) успевает до проброса исключения', async () => {
    const te = makeToolEventsStub();
    const deps = makeDeps({ toolEvents: te });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { date: 'd' }))
      .mockRejectedValueOnce(new Error('LLM down'));
    await expect(orchestrator.runDialog(1, 'k', { deps })).rejects.toThrow('LLM down');
    expect(te.buffers[0].flush).toHaveBeenCalledWith(null);
  });

  // Не из плана: выходы, которые НЕ прикрыты явным флашем, — их добирает
  // страховочный flush(null) в finally обёртки runDialog. Именно эту страховку
  // и закрепляют два теста ниже (падения БД в хвосте попытки).
  test('падение hasIncomingAfter → буфер попытки всё равно флашится', async () => {
    const te = makeToolEventsStub();
    const deps = makeDeps({ toolEvents: te });
    deps.history.hasIncomingAfter = jest.fn(async () => { throw new Error('db down'); });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { date: 'd' }))
      .mockResolvedValueOnce(textResp('ок'));
    await expect(orchestrator.runDialog(1, 'k', { deps })).rejects.toThrow('db down');
    expect(te.buffers[0].flush).toHaveBeenCalledWith(null);
  });

  test('падение setWatermark → буфер попытки всё равно флашится', async () => {
    const te = makeToolEventsStub();
    const deps = makeDeps({ toolEvents: te });
    deps.state.setWatermark = jest.fn(async () => { throw new Error('db down'); });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { date: 'd' }))
      .mockResolvedValueOnce(textResp('ок'));
    await expect(orchestrator.runDialog(1, 'k', { deps })).rejects.toThrow('db down');
    expect(te.buffers[0].flush).toHaveBeenCalledWith(null);
  });

  // Пустой транскрипт — ранний возврат ДО первого tool-вызова: буфер там ещё не
  // создан (turnId в ответе нет — так и задумано, вердикт диспетчеру не нужен).
  test('пустой транскрипт → буфер не создаётся вовсе', async () => {
    const te = makeToolEventsStub();
    const deps = makeDeps({ toolEvents: te });
    deps.history.loadTranscript = jest.fn(async () => ({ messages: [], watermark: 100 }));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.replies).toEqual([]);
    expect(out.turnId).toBeUndefined();
    expect(te.buffers).toHaveLength(0);
  });

  test('добивочный вызов упал без записи → flush(null) до проброса', async () => {
    const te = makeToolEventsStub();
    const deps = makeDeps({ toolEvents: te });
    deps.provider.createMessage.mockImplementation(async ({ tools }) => {
      if (!tools || tools.length === 0) throw new Error('LLM down');
      return toolResp('get_available_slots', { date: 'd' });
    });
    await expect(orchestrator.runDialog(1, 'k', { deps })).rejects.toThrow('LLM down');
    expect(te.buffers[0].flush).toHaveBeenCalledWith(null);
  });

  // Самая ценная строка журнала для разбора инцидента — та, где инструмент упал.
  test('обработчик инструмента БРОСИЛ → событие в буфере с isError=true', async () => {
    const te = makeToolEventsStub();
    const deps = makeDeps({
      toolEvents: te,
      handlers: { get_available_slots: jest.fn(async () => { throw new Error('boom'); }) },
    });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { date: '2026-07-20' }))
      .mockResolvedValueOnce(textResp('Секундочку 🤍'));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(te.buffers[0].push).toHaveBeenCalledWith(
      'get_available_slots', { date: '2026-07-20' }, { error: 'boom' }, true);
  });

  test('деградация после успешной записи → ход доходит до штатного флаша, запись в буфере', async () => {
    const te = makeToolEventsStub();
    const deps = makeDeps({ toolEvents: te });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('create_booking',
        { staff_yc_id: 1, service_yc_id: 2, datetime: '2026-07-27T19:30:00+03:00', client_name: 'Ирина' }))
      .mockRejectedValueOnce(Object.assign(new Error('421 boom'), { status: 421 }));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-07-24' });
    expect(out.degradedAfterWrite).toBe(true);
    expect(te.buffers[0].push).toHaveBeenCalledWith(
      'create_booking', expect.objectContaining({ staff_yc_id: 1 }), { created: true, record_id: 999 }, false);
    expect(te.buffers[0].flush).toHaveBeenCalledWith(null);
    expect(out.turnId).toBe('turn-1');
  });
});

// ── Сверка записей пациента с CRM ───────────────────────────────────────────
// Инцидент 2026-08-04 (79200255591): запись оформлена в 23:06, удалена в CRM в
// 23:35, а в 23:40 Мила без единого вызова инструмента заявила «вы уже записаны
// на завтра, 12:00» — и транскрипт, и журнал действий это ИСТОРИЯ, об отмене они
// не знают. Оркестратор теперь сверяется с CRM сам, каждый ход.
describe('блок актуальных записей в промпте', () => {
  const HEAD = 'АКТУАЛЬНЫЕ ЗАПИСИ ПАЦИЕНТА (сверено с CRM';
  const NOW = Date.parse('2026-08-04T23:40:00+03:00');
  const REC = {
    record_id: 1886730339, datetime: '2026-08-05T12:00:00+03:00',
    services: ['Лазерное удаление сосудов'], staff_name: 'Гатауллина Юлия',
  };
  const sysOf = (deps) => deps.provider.createMessage.mock.calls[0][0].system;

  async function run(overrides, ctx = { phone: '79200255591' }) {
    const deps = makeDeps(overrides);
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте!'));
    await orchestrator.runDialog(1, 'k', { deps, ctx, nowMs: NOW });
    return deps;
  }

  test('записи пациента попали в промпт', async () => {
    const deps = await run({ listBookings: { run: jest.fn(async () => ({ bookings: [REC] })) } });
    expect(sysOf(deps)).toContain(HEAD);
    expect(sysOf(deps)).toContain('05.08 (ср) 12:00 — Лазерное удаление сосудов, мастер Гатауллина Юлия [record_id 1886730339]');
    expect(deps.listBookings.run).toHaveBeenCalledWith(1, {}, { clientPhone: '79200255591', nowMs: NOW });
  });

  // Главное: пустой результат сверки — это УТВЕРЖДЕНИЕ «записей нет», которое
  // перебивает журнал, а не отсутствие информации.
  test('записей нет → блок всё равно есть и говорит «НЕТ»', async () => {
    const deps = await run({ listBookings: { run: jest.fn(async () => ({ bookings: [] })) } });
    expect(sysOf(deps)).toContain(HEAD);
    expect(sysOf(deps)).toMatch(/Будущих записей у пациента сейчас НЕТ/);
  });

  test('канал без номера → сверки нет, блока нет', async () => {
    const deps = await run({}, {});
    expect(sysOf(deps)).not.toContain(HEAD);
    expect(deps.listBookings.run).not.toHaveBeenCalled();
  });

  test('сбой YClients → fail-open: ход идёт, блока нет (а не «записей нет»)', async () => {
    for (const stub of [
      jest.fn(async () => { throw new Error('ETIMEDOUT'); }),
      jest.fn(async () => ({ bookings: [], error: 'Не удалось получить записи: 502' })),
      jest.fn(async () => ({ bookings: [], reason: 'no_yclients' })),
    ]) {
      const deps = await run({ listBookings: { run: stub } });
      expect(sysOf(deps)).not.toContain(HEAD);
    }
  });

  // client_not_found — это карточки в YClients нет, то есть записей и правда нет.
  test('клиент не найден в CRM → это честное «записей нет»', async () => {
    const deps = await run({ listBookings: { run: jest.fn(async () => ({ bookings: [], reason: 'client_not_found' })) } });
    expect(sysOf(deps)).toMatch(/Будущих записей у пациента сейчас НЕТ/);
  });
});
