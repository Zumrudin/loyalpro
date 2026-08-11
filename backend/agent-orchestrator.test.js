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
    // Индекс прайс-листов ходит в БД и в YClients. Стаб «прайсов нет» —
    // дефолт для всех сценариев, которые про них ничего не утверждают.
    priceListData: { loadPriceIndex: jest.fn(async () => null), ...overrides.priceListData },
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
        { dialogKey: 'k', clientPhone: '79001112233', clientName: null, nowMs: expect.any(Number),
          channel: null, priceIndex: null, attachments: [],
          // patientText — текст сообщений пациента для generic-booking-guard в
          // create_booking (сверка «называл ли пациент препарат»).
          patientText: expect.any(String) });
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

  // Инцидент 2026-08-06 (79037504378): после успешной записи Мила дописала
  // «Наш адрес: 2-й Троицкий переулок, 6Ас4» — адрес выдуман, а
  // search_knowledge_base за ход не вызывался ни разу.
  describe('адрес клиники без источника', () => {
    const FAKE = 'Отлично, записала вас на ботулинотерапию на завтра, 7 августа, в 11:30.\n\nНаш адрес: 2-й Троицкий переулок, 6Ас4. Будем ждать вас! 🤍';
    const KB_HIT = { found: true, chunks: [{ title: 'Информация о клинике',
      text: 'Адрес: г. Москва, ул. Генерала Белова, д. 28, к. 3 (метро Домодедовская)' }] };

    test('вымышленный адрес вырезан, подтверждение записи сохранено', async () => {
      const deps = makeDeps();
      deps.provider.createMessage
        .mockResolvedValueOnce(toolResp('create_booking', { staff_yc_id: 1, service_yc_id: 2, datetime: 'x' }))
        .mockResolvedValueOnce(textResp(FAKE));
      const out = await orchestrator.runDialog(1, 'k', { deps });
      expect(out.replies.join('\n')).not.toMatch(/Троицкий/);
      expect(out.replies.join('\n')).toMatch(/записала вас на ботулинотерапию/);
      expect(out.falseSuccess).toBe(false);
    });

    test('адрес из статьи базы знаний, прочитанной в этом ходе, проходит', async () => {
      const deps = makeDeps({ handlers: { search_knowledge_base: jest.fn(async () => KB_HIT) } });
      deps.registry.schemas.push({ name: 'search_knowledge_base' });
      deps.provider.createMessage
        .mockResolvedValueOnce(toolResp('search_knowledge_base', { query: 'адрес клиники, как добраться' }))
        .mockResolvedValueOnce(textResp('Мы находимся по адресу: г. Москва, ул. Генерала Белова, д. 28, к. 3 — это метро Домодедовская.'));
      const out = await orchestrator.runDialog(1, 'k', { deps });
      expect(out.replies).toEqual(['Мы находимся по адресу: г. Москва, ул. Генерала Белова, д. 28, к. 3 — это метро Домодедовская.']);
    });

    test('реплика была ОДНИМ адресом, а запись оформлена → детерминированное подтверждение вместо тишины', async () => {
      const deps = makeDeps();
      deps.provider.createMessage
        .mockResolvedValueOnce(toolResp('create_booking', {
          staff_yc_id: 1, service_yc_id: 2, datetime: '2026-08-07T11:30:00+03:00' }))
        .mockResolvedValueOnce(textResp('Ждём вас по адресу: 2-й Троицкий переулок, 6Ас4!'));
      const out = await orchestrator.runDialog(1, 'k', { deps });
      expect(out.replies.join('\n')).not.toMatch(/Троицкий/);
      expect(out.replies.length).toBe(1);
      expect(out.replies[0]).toMatch(/11:30/);
    });
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
    // Время в реплике — из выдачи инструмента (дефолтный хендлер отдаёт 10:00):
    // с 10.08.2026 выдуманное время требует корректирующего довызова, и фикстура
    // с «16:00 и 18:30» мерила бы уже не нарратив, а срабатывание guard'а.
    const deps = makeDeps();
    deps.provider.createMessage.mockImplementation(async ({ tools }) => {
      if (!tools || tools.length === 0) return textResp('Завтра свободно в 10:00.');
      return toolResp('get_available_slots', { date: '2026-07-20' }, 'c1', 'Секунду, уточняю…');
    });

    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-07-19' });

    expect(out.replies).toEqual(['Завтра свободно в 10:00.']);
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

  // 10.08.2026: unknown_time переведён из лога в жёсткие. Инцидент 79166524647 —
  // «на вторник, 18 августа, есть время в 12:00 и 14:30» на дату, которую тул в
  // тот ход вообще не спрашивали. Замер по проду: за весь лог (91 ход) проверка
  // сработала дважды, и оба раза на выдуманном времени — ложных не было.
  test('unknown_time → корректирующий довызов, отдаётся переписанная реплика', async () => {
    const deps = makeDeps({ handlers: { get_available_slots: jest.fn(async () => ({ slots: [{ time: '14:30' }] })) } });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { staff_yc_id: 1, service_yc_id: 1, date: '2026-07-30' }))
      .mockResolvedValueOnce(textResp('могу предложить 15:00'))
      .mockResolvedValueOnce(textResp('свободно только в 14:30'));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-07-29', now: '09:00' });
    expect(out.replies).toEqual(['свободно только в 14:30']);
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(3);
    // Инструкция довызова обязана говорить ПРО ВРЕМЯ: прежний текст про
    // «внутренние термины и идентификаторы» на выдуманном времени бессмыслен —
    // модель не поймёт, что именно переписывать.
    const fixMsg = deps.provider.createMessage.mock.calls[2][0].messages.slice(-1)[0].content;
    expect(fixMsg).toMatch(/врем/i);
    expect(fixMsg).toContain('15:00');
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

// ── Инцидент 2026-08-10 (79166524647): окна чужого мастера выданы за окна
// запрошенного. У Гаджиевой Пери отпуск — get_available_slots вернул пустые
// slots и alternative_staff с окнами Астемира Боташева, а Мила написала «у
// главного врача Пери Исамудиновны … есть окошки в 11:00 и 15:30». Времена
// Астемира лежали в allowedTimes, поэтому старая проверка молчала. ──
describe('reply-guard: чужое время приписано запрошенному мастеру (2026-08-10)', () => {
  const VACANT = {
    slots: [], staff_name: 'Гаджиева Пери', staff_not_working: true,
    alternative_staff: [{ staff_yc_id: 5708379, name: 'Астемир Боташев', slots: [{ time: '11:00' }, { time: '15:30' }], offer_slots: [{ time: '17:30' }] }],
  };
  const slotsCall = () => toolResp('get_available_slots', { staff_yc_id: 1910274, service_yc_id: 900, date: '2026-08-17' });

  test('назван только мастер без окон → корректирующий довызов с его именем', async () => {
    const deps = makeDeps({ handlers: { get_available_slots: jest.fn(async () => VACANT) } });
    deps.provider.createMessage
      .mockResolvedValueOnce(slotsCall())
      .mockResolvedValueOnce(textResp('У Пери Исамудиновны есть окошки в 11:00 и 15:30.'))
      .mockResolvedValueOnce(textResp('У Пери в этот день приёма нет, но записать можно к Астемиру на 17:30.'));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-08-10', now: '09:00' });
    expect(out.replies).toEqual(['У Пери в этот день приёма нет, но записать можно к Астемиру на 17:30.']);
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(3);
    const fixMsg = deps.provider.createMessage.mock.calls[2][0].messages.slice(-1)[0].content;
    expect(fixMsg).toContain('Гаджиева Пери');
  });

  test('назван владелец окон → довызова нет, реплика уходит как есть', async () => {
    const deps = makeDeps({ handlers: { get_available_slots: jest.fn(async () => VACANT) } });
    const good = 'У Пери в этот день приёма нет. Эту процедуру ведёт и Астемир Боташев — у него свободно в 11:00.';
    deps.provider.createMessage
      .mockResolvedValueOnce(slotsCall())
      .mockResolvedValueOnce(textResp(good));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-08-10', now: '09:00' });
    expect(out.replies).toEqual([good]);
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(2);
  });

  // Мастер с окнами в «пустые» попасть не должен: иначе честный ответ «у
  // Астемира свободно в 11:00» сам себя объявит нарушением.
  test('у запрошенного мастера окна ЕСТЬ → проверка молчит', async () => {
    const deps = makeDeps({
      handlers: { get_available_slots: jest.fn(async () => ({
        slots: [{ time: '11:00' }], offer_slots: [{ time: '11:00' }], staff_name: 'Гаджиева Пери',
      })) },
    });
    deps.provider.createMessage
      .mockResolvedValueOnce(slotsCall())
      .mockResolvedValueOnce(textResp('У Пери свободно в 11:00.'));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-08-10', now: '09:00' });
    expect(out.replies).toEqual(['У Пери свободно в 11:00.']);
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(2);
  });

  // Тот же водораздел, что у staff_options: мастер без окон в ветке выбора
  // специалиста — такой же «пустой», его имя тоже нельзя клеить к чужому времени.
  test('staff_options: мастер без окон в выдаче тоже считается пустым', async () => {
    const deps = makeDeps({
      handlers: { get_available_slots: jest.fn(async () => ({
        staff_options: [
          { staff_yc_id: 1910274, name: 'Гаджиева Пери', slots: [], offer_slots: [] },
          { staff_yc_id: 5708379, name: 'Астемир Боташев', slots: [{ time: '11:00' }], offer_slots: [{ time: '11:00' }] },
        ],
      })) },
    });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { service_yc_id: 900, date: '2026-08-17' }))
      .mockResolvedValueOnce(textResp('У Гаджиевой Пери свободно в 11:00.'))
      .mockResolvedValueOnce(textResp('Свободное время в 11:00 есть у Астемира Боташева.'));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-08-10', now: '09:00' });
    expect(out.replies).toEqual(['Свободное время в 11:00 есть у Астемира Боташева.']);
  });
});

// ── Плотная запись (§8 docs/superpowers/specs/2026-08-06-agent-slot-density-design.md):
// модель называет время из полного slots МИМО подобранного offer_slots — только
// лог (offer_bypass), никакого корректирующего довызова. ──
describe('reply-guard: offer_bypass (плотная запись, только лог)', () => {
  beforeEach(() => { mockLogger.warn.mockClear(); });

  test('время из slots, но НЕ из offer_slots и НЕ названное пациентом → лог offer_bypass, реплика доставлена как есть', async () => {
    const deps = makeDeps({
      handlers: {
        get_available_slots: jest.fn(async () => ({
          slots: [{ time: '11:00' }, { time: '15:00' }],
          offer_slots: [{ time: '14:00' }],
        })),
      },
    });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { staff_yc_id: 1, service_yc_id: 1, date: '2026-08-07' }))
      .mockResolvedValueOnce(textResp('Могу предложить 15:00'));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-08-06', now: '09:00' });
    // Реплика доставлена как есть, без корректирующего довызова: 1 tool-итерация + 1 финал = 2 вызова.
    expect(out.replies).toEqual(['Могу предложить 15:00']);
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(2);
    const guardLogs = mockLogger.warn.mock.calls.filter(([msg]) => String(msg).includes('reply-guard'));
    expect(guardLogs.join(' ')).toContain('offer_bypass');
    expect(guardLogs.join(' ')).toContain('15:00');
  });

  // Свободный день (правка 07.08): времени в ответе быть не должно ВООБЩЕ — только
  // вопрос о половине дня. Тоже лишь метрика: реплику не глушим, иначе повторим
  // дефект анти-ложь-guard'а 04.08 на честном подтверждении времени пациента.
  test('free_day, а модель назвала время → лог free_day_time, реплика доставлена', async () => {
    const deps = makeDeps({
      handlers: {
        get_available_slots: jest.fn(async () => ({
          slots: [{ time: '11:00' }, { time: '11:30' }],
          offer_slots: [], free_day: true,
        })),
      },
    });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { staff_yc_id: 1, service_yc_id: 1, date: '2026-08-07' }))
      .mockResolvedValueOnce(textResp('Могу записать на 11:00'));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-08-06', now: '09:00' });
    expect(out.replies).toEqual(['Могу записать на 11:00']);
    const guardLogs = mockLogger.warn.mock.calls.filter(([msg]) => String(msg).includes('reply-guard'));
    expect(guardLogs.join(' ')).toContain('free_day_time');
  });

  test('free_day и вопрос про половину дня без времени → лога нет', async () => {
    const deps = makeDeps({
      handlers: {
        get_available_slots: jest.fn(async () => ({
          slots: [{ time: '11:00' }, { time: '11:30' }],
          offer_slots: [], free_day: true,
        })),
      },
    });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { staff_yc_id: 1, service_yc_id: 1, date: '2026-08-07' }))
      .mockResolvedValueOnce(textResp('Свободное время есть в течение дня. В какой половине дня вам удобнее?'));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-08-06', now: '09:00' });
    expect(out.replies).toHaveLength(1);
    const guardLogs = mockLogger.warn.mock.calls.filter(([msg]) => String(msg).includes('reply-guard'));
    expect(guardLogs.join(' ')).not.toContain('free_day_time');
  });

  test('время из offer_slots — не offer_bypass', async () => {
    const deps = makeDeps({
      handlers: {
        get_available_slots: jest.fn(async () => ({
          slots: [{ time: '11:00' }, { time: '14:00' }],
          offer_slots: [{ time: '14:00' }],
        })),
      },
    });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { staff_yc_id: 1, service_yc_id: 1, date: '2026-08-07' }))
      .mockResolvedValueOnce(textResp('Могу предложить 14:00'));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-08-06', now: '09:00' });
    expect(out.replies).toEqual(['Могу предложить 14:00']);
    const guardLogs = mockLogger.warn.mock.calls.filter(([msg]) => String(msg).includes('reply-guard'));
    expect(guardLogs.join(' ')).not.toContain('offer_bypass');
  });

  test('пациент сам назвал время вне offer_slots — подтверждение НЕ offer_bypass', async () => {
    const deps = makeDeps({
      handlers: {
        get_available_slots: jest.fn(async () => ({
          slots: [{ time: '11:00' }, { time: '15:00' }],
          offer_slots: [{ time: '14:00' }],
        })),
      },
      history: {
        loadTranscript: jest.fn(async () => ({
          messages: [{ role: 'user', content: 'а можно на 15:00?' }], watermark: 100,
        })),
      },
    });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { staff_yc_id: 1, service_yc_id: 1, date: '2026-08-07' }))
      .mockResolvedValueOnce(textResp('Хорошо, 15:00 вам подходит?'));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-08-06', now: '09:00' });
    expect(out.replies).toEqual(['Хорошо, 15:00 вам подходит?']);
    const guardLogs = mockLogger.warn.mock.calls.filter(([msg]) => String(msg).includes('reply-guard'));
    expect(guardLogs.join(' ')).not.toContain('offer_bypass');
  });

  test('offer_slots за ход не было вовсе — проверка выключена, время из slots не логируется как offer_bypass', async () => {
    const deps = makeDeps({
      handlers: {
        get_available_slots: jest.fn(async () => ({ slots: [{ time: '11:00' }, { time: '15:00' }] })),
      },
    });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { staff_yc_id: 1, service_yc_id: 1, date: '2026-08-07' }))
      .mockResolvedValueOnce(textResp('Могу предложить 15:00'));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-08-06', now: '09:00' });
    expect(out.replies).toEqual(['Могу предложить 15:00']);
    const guardLogs = mockLogger.warn.mock.calls.filter(([msg]) => String(msg).includes('reply-guard'));
    expect(guardLogs.join(' ')).not.toContain('offer_bypass');
  });

  // Второе разрешение правила «КАКОЕ ВРЕМЯ ПРЕДЛАГАТЬ ПЕРВЫМ»: пациент попросил
  // время СЛОВАМИ («а можно пораньше?»), без цифр — самый частый разговорный
  // паттерн. Без patientAskedOtherTime такой ход систематически ловился бы как
  // offer_bypass, хотя ответ полностью соответствует правилу.
  test('пациент попросил пораньше СЛОВАМИ → offer_bypass не пишется', async () => {
    const deps = makeDeps({
      handlers: {
        get_available_slots: jest.fn(async () => ({
          slots: [{ time: '11:00' }, { time: '15:00' }],
          offer_slots: [{ time: '14:00' }],
        })),
      },
      history: {
        loadTranscript: jest.fn(async () => ({
          messages: [{ role: 'user', content: 'а можно пораньше?' }], watermark: 100,
        })),
      },
    });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { staff_yc_id: 1, service_yc_id: 1, date: '2026-08-07' }))
      .mockResolvedValueOnce(textResp('Тогда 11:00, подойдёт?'));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-08-06', now: '09:00' });
    expect(out.replies).toEqual(['Тогда 11:00, подойдёт?']);
    const guardLogs = mockLogger.warn.mock.calls.filter(([msg]) => String(msg).includes('reply-guard'));
    expect(guardLogs.join(' ')).not.toContain('offer_bypass');
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

// Вежливое завершение переписки: круг взаимных благодарностей (инцидент
// 2026-08-06, 79165370505). Проверяем, что ход обрывается ДО провайдера —
// платный вызов на «Всегда пожалуйста» не нужен.
describe('runDialog: молчание на завершающей вежливости', () => {
  const closingTranscript = [
    { role: 'user', content: 'Спасибо!' },
    { role: 'assistant', content: 'Пожалуйста! Рада была помочь. 🤍' },
    { role: 'user', content: 'Благодарю!И Вам🌹' },
  ];

  test('чистая благодарность после чистого прощания → silent, провайдер не звался', async () => {
    const deps = makeDeps({
      history: { loadTranscript: jest.fn(async () => ({ messages: closingTranscript, watermark: 100 })) },
    });
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.silent).toBe(true);
    expect(out.replies).toEqual([]);
    expect(out.escalated).toBe(false);
    expect(deps.provider.createMessage).not.toHaveBeenCalled();
    // Ватермарк двигать обязательно: иначе то же сообщение будет обрабатываться заново.
    expect(deps.state.setWatermark).toHaveBeenCalledWith(1, 'k', 100);
  });

  test('содержательное сообщение → ход идёт как обычно', async () => {
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({
          messages: [
            { role: 'user', content: 'Спасибо!' },
            { role: 'assistant', content: 'Всегда пожалуйста! ✨' },
            { role: 'user', content: 'А перенесите меня на 17:00' },
          ],
          watermark: 100,
        })),
      },
    });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Сейчас посмотрю.'));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.silent).toBeFalsy();
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(1);
  });
});

describe('прайс-листы в картинках', () => {
  const INDEX = require('./services/agent/price-list').buildIndex({
    categories: [{ id: 12, title: 'Лазерная эпиляция' }],
    subcats: [],
    photos: [{ id: 1, yc_category_id: 12, subcategory_id: null, file_url: '/uploads/a.jpg', file_name: 'a.jpg', mime_type: 'image/jpeg' }],
    priceListUrl: 'https://peri.ru/price',
  });

  test('вложения инструмента возвращаются ходом и канал доезжает до toolCtx', async () => {
    const deps = makeDeps({
      handlers: {
        send_price_list: jest.fn(async (salonId, input, ctx) => {
          ctx.attachments.push({ nodeKey: 'c12', category: 'Лазерная эпиляция', fileUrl: '/uploads/a.jpg', fileName: 'a.jpg', mimeType: 'image/jpeg' });
          return { attached: true, photos: 1 };
        }),
      },
      priceListData: { loadPriceIndex: jest.fn(async () => INDEX) },
    });
    deps.registry.schemas.push({ name: 'send_price_list' });
    deps.provider.createMessage
      .mockResolvedValueOnce({ text: '', toolCalls: [{ id: 't1', name: 'send_price_list', input: { category: 'c12' } }], assistantMsg: {} })
      .mockResolvedValueOnce({ text: 'Отправляю прайс', toolCalls: [], assistantMsg: {} });

    const res = await orchestrator.runDialog(1, 'k', { deps, ctx: { phone: '79001112233', channel: 'whatsapp' } });
    expect(res.attachments).toHaveLength(1);
    expect(res.sideEffect).toBe(false);   // отправки не было — ход можно выбросить
    const toolCtx = deps.registry.handlers.send_price_list.mock.calls[0][2];
    expect(toolCtx.channel).toBe('whatsapp');
    expect(toolCtx.priceIndex).toBe(INDEX);
  });

  test('перегенерация выбрасывает вложения вместе с черновиком', async () => {
    const deps = makeDeps({
      handlers: {
        send_price_list: jest.fn(async (salonId, input, ctx) => {
          ctx.attachments.push({ nodeKey: 'c12', category: 'Лазерная эпиляция', fileUrl: '/uploads/a.jpg', fileName: 'a.jpg', mimeType: 'image/jpeg' });
          return { attached: true, photos: 1 };
        }),
      },
      priceListData: { loadPriceIndex: jest.fn(async () => INDEX) },
    });
    deps.registry.schemas.push({ name: 'send_price_list' });
    // Первая попытка: инструмент сработал, но пока думали — пришло входящее.
    deps.history.hasIncomingAfter
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    deps.provider.createMessage
      .mockResolvedValueOnce({ text: '', toolCalls: [{ id: 't1', name: 'send_price_list', input: { category: 'c12' } }], assistantMsg: {} })
      .mockResolvedValueOnce({ text: 'Черновик', toolCalls: [], assistantMsg: {} })
      .mockResolvedValueOnce({ text: 'Финальный ответ', toolCalls: [], assistantMsg: {} });

    const res = await orchestrator.runDialog(1, 'k', { deps, ctx: { phone: '79001112233', channel: 'whatsapp' } });
    expect(res.replies).toEqual(['Финальный ответ']);
    expect(res.attachments).toHaveLength(0);   // фото первой попытки не уехали
  });

  test('сбой загрузки прайсов не роняет ход', async () => {
    const deps = makeDeps({
      priceListData: { loadPriceIndex: jest.fn(async () => { throw new Error('db down'); }) },
    });
    deps.provider.createMessage.mockResolvedValueOnce({ text: 'Здравствуйте', toolCalls: [], assistantMsg: {} });
    const res = await orchestrator.runDialog(1, 'k', { deps, ctx: { phone: '79001112233', channel: 'whatsapp' } });
    expect(res.replies).toEqual(['Здравствуйте']);
  });

  test('send_price_list не объявлен side-effect-инструментом', () => {
    const src = require('fs').readFileSync(require.resolve('./services/agent/orchestrator'), 'utf8');
    const m = /SIDE_EFFECT_TOOLS = new Set\(\[([\s\S]*?)\]\)/.exec(src);
    expect(m).toBeTruthy();
    expect(m[1]).not.toContain('send_price_list');
  });
});

// ── Представление, когда Мила пишет в диалог ВПЕРВЫЕ (инцидент 2026-08-10) ──
// 79166524647 и 79295059889: обеим пациенткам раньше отвечал живой
// администратор, Мила — ни разу, и в обоих диалогах она не представилась.
// hasEverAnswered в них честно true («разговор был»), поэтому блок ПЕРВОЕ
// ОБРАЩЕНИЕ, где единственно и живёт требование представиться, не рендерился.
describe('представление при первой реплике Милы (2026-08-10)', () => {
  const withHistory = (over = {}) => makeDeps({
    history: {
      loadTranscript: jest.fn(async () => ({
        messages: [{ role: 'user', content: 'Перепишите пожалуйста меня к Пери на пятницу' }],
        watermark: 100,
        session: { newSession: true, gapText: '17 дней' },
      })),
      hasEverAnswered: jest.fn(async () => true),
      ...over,
    },
  });

  test('отвечал только администратор → представление дописывается к реплике', async () => {
    const deps = withHistory({ hasAgentEverWritten: jest.fn(async () => false) });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте, Марина! 👋\n\nСейчас проверю.'));
    const out = await orchestrator.runDialog(1, 'k', { deps, salonName: 'PERI CLINIC' });
    expect(out.replies).toEqual([
      'Здравствуйте, Марина! 👋 Я Мила, виртуальный администратор PERI CLINIC.\n\nСейчас проверю.',
    ]);
  });

  test('Мила в диалоге уже писала → ничего не дописываем', async () => {
    const deps = withHistory({ hasAgentEverWritten: jest.fn(async () => true) });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте, Марина! Сейчас проверю.'));
    const out = await orchestrator.runDialog(1, 'k', { deps, salonName: 'PERI CLINIC' });
    expect(out.replies).toEqual(['Здравствуйте, Марина! Сейчас проверю.']);
  });

  // Блок «НАЧАЛО НОВОЙ ПЕРЕПИСКИ» запрещал представляться «второй раз», а
  // первого раза не было — запрет обязан быть условным, иначе промпт спорит
  // с детерминированной допиской.
  test('запрета «представляться второй раз» в промпте нет, пока Мила не писала', async () => {
    const deps = withHistory({ hasAgentEverWritten: jest.fn(async () => false) });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте! Я Мила, виртуальный администратор PERI CLINIC.'));
    await orchestrator.runDialog(1, 'k', { deps, salonName: 'PERI CLINIC' });
    const sys = deps.provider.createMessage.mock.calls[0][0].system;
    expect(sys).toContain('НАЧАЛО НОВОЙ ПЕРЕПИСКИ');
    expect(sys).not.toContain('Представляться второй раз');
  });

  // Никто не отвечал вовсе → представление уже приходит вместе с приветствием
  // (ensureGreeting). Второй раз представляться нельзя, и лишний запрос в БД
  // тут не нужен: ответ известен из firstContact.
  test('первое обращение: одно представление и БЕЗ запроса в БД', async () => {
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({
          messages: [{ role: 'user', content: 'Здравствуйте! Хочу записаться' }],
          watermark: 100,
          session: { newSession: false, gapText: null },
        })),
        hasEverAnswered: jest.fn(async () => false),
        hasAgentEverWritten: jest.fn(async () => false),
      },
    });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Конечно, на какую процедуру?'));
    const out = await orchestrator.runDialog(1, 'k', { deps, salonName: 'PERI CLINIC' });
    expect(out.replies[0].match(/Я Мила/g)).toHaveLength(1);
    expect(deps.history.hasAgentEverWritten).not.toHaveBeenCalled();
  });

  // Fail-open в сторону ПРЕЖНЕГО поведения: сбой БД не должен заставлять Милу
  // представляться в каждом сообщении подряд.
  test('сбой проверки не роняет ход и не дописывает представление', async () => {
    const deps = withHistory({ hasAgentEverWritten: jest.fn(async () => { throw new Error('db down'); }) });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте, Марина! Сейчас проверю.'));
    const out = await orchestrator.runDialog(1, 'k', { deps, salonName: 'PERI CLINIC' });
    expect(out.replies).toEqual(['Здравствуйте, Марина! Сейчас проверю.']);
  });
});

// ── Оценка визита: срезанный опрос доезжает до модели (инцидент 2026-08-10) ──
// 79776646672: пациентка ответила «5» на автоматический опрос об оценке визита.
// Все три исходящих в диалоге были служебными и шли подряд в начале окна —
// ведущие assistant-реплики срезаются (Messages API требует user первым), и в
// модель ушла ровно одна строка «5», без вопроса, ответом на который она была.
describe('срезанные сообщения клиники доезжают в промпт (2026-08-10)', () => {
  const SURVEY = 'Просим Вас оценить обслуживание, отправив в ответ сообщение с цифрой от 2 до 5';

  test('leadingClinic из транскрипта попадает в системный промпт', async () => {
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({
          messages: [{ role: 'user', content: '5' }],
          watermark: 100,
          leadingClinic: [SURVEY],
        })),
      },
    });
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Спасибо за оценку!'));
    await orchestrator.runDialog(1, 'k', { deps });
    const sys = deps.provider.createMessage.mock.calls[0][0].system;
    expect(sys).toContain('ПРЕДЫДУЩИЕ СООБЩЕНИЯ КЛИНИКИ ЭТОМУ ПАЦИЕНТУ:');
    expect(sys).toContain(SURVEY);
  });

  // Старый инжектор history в тестах и на care-пути поля не отдаёт — ход не
  // должен от этого падать, просто блока нет.
  test('транскрипт без leadingClinic → блока нет, ход цел', async () => {
    const deps = makeDeps();
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте!'));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.replies).toEqual(['Здравствуйте!']);
    expect(deps.provider.createMessage.mock.calls[0][0].system)
      .not.toContain('ПРЕДЫДУЩИЕ СООБЩЕНИЯ КЛИНИКИ ЭТОМУ ПАЦИЕНТУ:');
  });
});

// Инцидент 2026-08-10 (79166524647, turn 5ef41c78): за один ход 15 вызовов
// get_available_slots, из них 9 — с байт-в-байт одинаковым input (одна дата
// запрошена 7 раз подряд). Промпт-правило «не вызывай инструмент повторно с
// теми же аргументами» модель игнорирует — дедуп обязан быть детерминированным.
describe('дедуп повторных tool-вызовов внутри хода (2026-08-10)', () => {
  const SLOTS_INPUT = { staff_yc_id: 1910274, service_yc_id: 9536676, date: '2026-08-14' };

  test('повтор read-вызова с теми же аргументами → хендлер не исполняется, в результат идёт кэш хода с подсказкой', async () => {
    const events = makeToolEventsStub();
    const deps = makeDeps({ toolEvents: events });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', SLOTS_INPUT, 'c1'))
      .mockResolvedValueOnce(toolResp('get_available_slots', { ...SLOTS_INPUT }, 'c2'))
      .mockResolvedValueOnce(textResp('Свободно 10:00. Записать?'));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.replies).toContain('Свободно 10:00. Записать?');
    // Хендлер исполнился РОВНО один раз — второй вызов сожрал бы YClients зря.
    expect(deps.registry.handlers.get_available_slots).toHaveBeenCalledTimes(1);
    // Модель на повтор получает кэш ЭТОГО хода + подсказку «не повторяй, отвечай».
    const thirdCallMessages = deps.provider.createMessage.mock.calls[2][0].messages;
    const repeatTurn = thirdCallMessages[thirdCallMessages.length - 1];
    expect(repeatTurn.role).toBe('tool');
    const repeated = JSON.parse(repeatTurn.content);
    expect(repeated.repeated_call).toBe(true);
    expect(repeated.hint).toMatch(/уже вызывала|не повторяй/i);
    expect(repeated.slots).toEqual([{ time: '10:00' }]);
  });

  test('другие аргументы того же инструмента дедупом не считаются', async () => {
    const deps = makeDeps();
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', SLOTS_INPUT, 'c1'))
      .mockResolvedValueOnce(toolResp('get_available_slots', { ...SLOTS_INPUT, date: '2026-08-15' }, 'c2'))
      .mockResolvedValueOnce(textResp('Есть время на 14-е и 15-е.'));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(deps.registry.handlers.get_available_slots).toHaveBeenCalledTimes(2);
  });

  test('write-инструменты НЕ дедупятся — у них своя идемпотентность в хендлерах', async () => {
    const BOOK = { service_yc_id: 7, staff_yc_id: 55, datetime: '2026-08-14 12:00' };
    const deps = makeDeps();
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('create_booking', BOOK, 'c1'))
      .mockResolvedValueOnce(toolResp('create_booking', { ...BOOK }, 'c2'))
      .mockResolvedValueOnce(textResp('Записала вас на 12:00.'));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(deps.registry.handlers.create_booking).toHaveBeenCalledTimes(2);
  });

  test('повтор не пишется в журнал tool-событий (память не задваивается)', async () => {
    const events = makeToolEventsStub();
    const deps = makeDeps({ toolEvents: events });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', SLOTS_INPUT, 'c1'))
      .mockResolvedValueOnce(toolResp('get_available_slots', { ...SLOTS_INPUT }, 'c2'))
      .mockResolvedValueOnce(textResp('Свободно 10:00.'));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(events.buffers[0].push).toHaveBeenCalledTimes(1);
  });

  test('ошибочный результат не кэшируется — повтор после error исполняется заново', async () => {
    const handler = jest.fn(async () => ({ error: 'таймаут YClients' }));
    const deps = makeDeps({ handlers: { get_available_slots: handler } });
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', SLOTS_INPUT, 'c1'))
      .mockResolvedValueOnce(toolResp('get_available_slots', { ...SLOTS_INPUT }, 'c2'))
      .mockResolvedValueOnce(textResp('Не получилось, попробуем ещё раз.'));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

// ── Оценка визита без LLM (спека 2026-08-10-agent-prompt-to-code-offload) ──
describe('оценка визита («5» на автоопрос)', () => {
  const SURVEY = 'Просим оценить обслуживание цифрой от 2 до 5';

  function ratingDeps(rating, lastAuthor, extra = {}, lastText = SURVEY) {
    return makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({
          messages: [{ role: 'user', content: String(rating) }], watermark: 500 })),
        lastOutgoing: jest.fn(async () => ({ author: lastAuthor, text: lastText })),
      },
      ...extra,
    });
  }

  // Ход обязан уйти в LLM: ватермарк двигает уже штатный путь, а не ветка.
  const llmAnswer = (deps) => deps.provider.createMessage.mockResolvedValue(
    { assistantMsg: { role: 'assistant', content: 'ок' }, toolCalls: [], text: 'Ответ' });

  // 4–5 → МОЛЧИМ тем же контрактом, что closing.js. Благодарность на такую
  // оценку шлёт сама клиника («Спасибо за отличную оценку… дарим 500 бонусов»,
  // по проду 42 случая из 46, задержка ~17 с) — наша ушла бы раньше и съела
  // повод для просьбы об отзыве.
  test.each([4, 5])('«%i» после опроса → молчим, провайдер НЕ вызывается, ватермарк сдвинут', async (rating) => {
    const deps = ratingDeps(rating, 'system');
    const res = await orchestrator.runDialog(1, '79001112233', { deps });
    expect(deps.provider.createMessage).not.toHaveBeenCalled();
    expect(res.replies).toEqual([]);
    expect(res.silent).toBe(true);
    expect(res.escalated).toBe(false);
    expect(res.sideEffect).toBe(false);
    expect(deps.registry.handlers.escalate_to_operator).not.toHaveBeenCalled();
    expect(deps.state.setWatermark).toHaveBeenCalledWith(1, '79001112233', 500);
    // Ход без единого вызова инструмента — запись в журнал заводить не за чем
    // (та же экономия, что у ветки молчания closing.js).
    expect(deps.toolEvents.createBuffer).not.toHaveBeenCalled();
  });

  test('«2» после автоуведомления → извинение + эскалация без LLM', async () => {
    const deps = ratingDeps(2, 'system');
    const res = await orchestrator.runDialog(1, '79001112233', { deps });
    expect(deps.provider.createMessage).not.toHaveBeenCalled();
    expect(deps.registry.handlers.escalate_to_operator).toHaveBeenCalledWith(
      1, { reason: expect.stringContaining('низкая оценка') }, expect.any(Object));
    expect(res.escalated).toBe(true);
    expect(res.replies.join(' ')).toMatch(/администратор/i);
  });

  // Эскалация — УСЛОВИЕ извинения, а не побочный шаг: текст сам объявляет
  // перевод, поэтому диспетчер (ветка res.escalated) ничего не дошлёт и диалог
  // за нас не переведёт. Не записалась — обещать перевод нельзя.
  test('сбой escalate_to_operator → извинение НЕ уходит, ход в LLM, ватермарк не сдвинут', async () => {
    const deps = ratingDeps(2, 'system');
    deps.registry.handlers.escalate_to_operator = jest.fn(async () => { throw new Error('db down'); });
    llmAnswer(deps);
    const res = await orchestrator.runDialog(1, 'k', { deps });
    expect(res.replies).toEqual(['Ответ']);
    expect(res.replies.join(' ')).not.toMatch(/очень жаль/i);
    expect(deps.provider.createMessage).toHaveBeenCalled();
    // Ватермарк тот же самый (его сдвинет штатный конец хода), поэтому сверяем
    // ПОРЯДОК: ветка двигала бы его ДО обращения к провайдеру и уносила бы
    // сообщение в никуда — при провалившейся эскалации это потерянная жалоба.
    expect(deps.state.setWatermark).toHaveBeenCalledTimes(1);
    expect(deps.state.setWatermark.mock.invocationCallOrder[0])
      .toBeGreaterThan(deps.provider.createMessage.mock.invocationCallOrder[0]);
  });

  test('escalate_to_operator вернул не-escalated → тоже отдаём ход модели', async () => {
    const deps = ratingDeps(3, 'system');
    deps.registry.handlers.escalate_to_operator = jest.fn(async () => ({ escalated: false }));
    llmAnswer(deps);
    const res = await orchestrator.runDialog(1, 'k', { deps });
    expect(res.replies).toEqual(['Ответ']);
  });

  // Под authored_by='system' идут ВСЕ автоуведомления, не только опрос.
  test('system-уведомление без маркеров опроса → ветка молчит, ход в LLM', async () => {
    const deps = ratingDeps(2, 'system', {}, 'Напоминаем о записи завтра в 12:00');
    llmAnswer(deps);
    const res = await orchestrator.runDialog(1, 'k', { deps });
    expect(res.replies).toEqual(['Ответ']);
    expect(deps.registry.handlers.escalate_to_operator).not.toHaveBeenCalled();
  });

  test('последнее исходящее — agent (Мила задавала вопрос) → ветка не срабатывает, ход в LLM', async () => {
    const deps = ratingDeps(5, 'agent');
    deps.provider.createMessage.mockResolvedValue(
      { assistantMsg: { role: 'assistant', content: 'ок' }, toolCalls: [], text: 'Отвечаю по делу' });
    const res = await orchestrator.runDialog(1, '79001112233', { deps });
    expect(deps.provider.createMessage).toHaveBeenCalled();
    expect(res.replies).toEqual(['Отвечаю по делу']);
  });

  test('последнее исходящее — operator либо автор неизвестен → ветка молчит', async () => {
    for (const author of ['operator', null]) {
      const deps = ratingDeps(5, author);
      llmAnswer(deps);
      const res = await orchestrator.runDialog(1, 'k', { deps });
      expect(res.replies).toEqual(['Ответ']);
    }
  });

  test('исходящих в диалоге нет вовсе (lastOutgoing → null) → ветка молчит', async () => {
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({ messages: [{ role: 'user', content: '5' }], watermark: 500 })),
        lastOutgoing: jest.fn(async () => null),
      },
    });
    llmAnswer(deps);
    const res = await orchestrator.runDialog(1, 'k', { deps });
    expect(res.replies).toEqual(['Ответ']);
  });

  test('сбой lastOutgoing → fail-open в LLM', async () => {
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({ messages: [{ role: 'user', content: '5' }], watermark: 500 })),
        lastOutgoing: jest.fn(async () => { throw new Error('db down'); }),
      },
    });
    llmAnswer(deps);
    const res = await orchestrator.runDialog(1, 'k', { deps });
    expect(res.replies).toEqual(['Ответ']);
  });

  test('инжектор history без lastOutgoing → ветка молча пропускается (совместимость)', async () => {
    const deps = makeDeps({
      history: { loadTranscript: jest.fn(async () => ({ messages: [{ role: 'user', content: '5' }], watermark: 500 })) },
    });
    llmAnswer(deps);
    const res = await orchestrator.runDialog(1, 'k', { deps });
    expect(res.replies).toEqual(['Ответ']);
  });

  test('AGENT_VISIT_RATING_REPLY=false → ветка выключена', async () => {
    const deps = ratingDeps(5, 'system');
    deps.config = { ...require('./config'), AGENT_VISIT_RATING_REPLY: false };
    llmAnswer(deps);
    const res = await orchestrator.runDialog(1, 'k', { deps });
    expect(res.replies).toEqual(['Ответ']);
  });
});

// ── Предвызов КБ на «+» (спека 2026-08-10-agent-prompt-to-code-offload) ──
describe('предвызов КБ на короткое «+»', () => {
  function promoDeps(lastAuthor, kbResult, text = '+') {
    const kbHandler = jest.fn(async () => kbResult);
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({ messages: [{ role: 'user', content: text }], watermark: 500 })),
        lastOutgoingAuthor: jest.fn(async () => lastAuthor),
      },
      handlers: { search_knowledge_base: kbHandler },
    });
    deps.provider.createMessage.mockResolvedValue(
      { assistantMsg: { role: 'assistant', content: 'ок' }, toolCalls: [], text: 'Расскажу про акцию' });
    return { deps, kbHandler };
  }

  test('«+» после автоуведомления → КБ вызвана кодом, статья в системном промпте', async () => {
    const { deps, kbHandler } = promoDeps('system',
      { found: true, context: 'Акция августа: скидка 20% на чистки', sources: [] });
    await orchestrator.runDialog(1, '79001112233', { deps });
    expect(kbHandler).toHaveBeenCalledWith(1, { query: 'спецпредложение месяца, акция' }, expect.any(Object));
    const system = deps.provider.createMessage.mock.calls[0][0].system;
    expect(system).toContain('СТАТЬЯ О СПЕЦПРЕДЛОЖЕНИИ МЕСЯЦА (найдена автоматически');
    expect(system).toContain('скидка 20% на чистки');
  });

  test('статья не нашлась → блока нет, ход штатный', async () => {
    const { deps } = promoDeps('system', { found: false, context: '', sources: [] });
    const res = await orchestrator.runDialog(1, '79001112233', { deps });
    const system = deps.provider.createMessage.mock.calls[0][0].system;
    expect(system).not.toContain('СТАТЬЯ О СПЕЦПРЕДЛОЖЕНИИ МЕСЯЦА (найдена автоматически');
    expect(res.replies).toEqual(['Расскажу про акцию']);
  });

  test('последнее исходящее — agent («+» может быть согласием на слот) → предвызова нет', async () => {
    const { deps, kbHandler } = promoDeps('agent', { found: true, context: 'x', sources: [] });
    await orchestrator.runDialog(1, '79001112233', { deps });
    expect(kbHandler).not.toHaveBeenCalled();
  });

  test('сообщение не «+» → предвызова нет', async () => {
    const { deps, kbHandler } = promoDeps('system', { found: true, context: 'x', sources: [] }, 'а что по акциям?');
    await orchestrator.runDialog(1, '79001112233', { deps });
    expect(kbHandler).not.toHaveBeenCalled();
  });

  // Fail-open: сбой КБ или чтения автора не должен стоить пациенту ответа —
  // модель просто позовёт search_knowledge_base сама, как до фичи.
  test('сбой предвызова → ход штатный, без блока', async () => {
    const kbHandler = jest.fn(async () => { throw new Error('rag down'); });
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({ messages: [{ role: 'user', content: '+' }], watermark: 500 })),
        lastOutgoingAuthor: jest.fn(async () => 'system'),
      },
      handlers: { search_knowledge_base: kbHandler },
    });
    deps.provider.createMessage.mockResolvedValue(
      { assistantMsg: { role: 'assistant', content: 'ок' }, toolCalls: [], text: 'Ответ' });
    const res = await orchestrator.runDialog(1, 'k', { deps });
    expect(res.replies).toEqual(['Ответ']);
    expect(deps.provider.createMessage.mock.calls[0][0].system)
      .not.toContain('СТАТЬЯ О СПЕЦПРЕДЛОЖЕНИИ МЕСЯЦА (найдена автоматически');
  });

  test('инжектор history без lastOutgoingAuthor → ветка молча пропускается', async () => {
    const kbHandler = jest.fn(async () => ({ found: true, context: 'x', sources: [] }));
    const deps = makeDeps({
      history: {
        loadTranscript: jest.fn(async () => ({ messages: [{ role: 'user', content: '+' }], watermark: 500 })),
      },
      handlers: { search_knowledge_base: kbHandler },
    });
    deps.provider.createMessage.mockResolvedValue(
      { assistantMsg: { role: 'assistant', content: 'ок' }, toolCalls: [], text: 'Ответ' });
    const res = await orchestrator.runDialog(1, 'k', { deps });
    expect(kbHandler).not.toHaveBeenCalled();
    expect(res.replies).toEqual(['Ответ']);
  });

  test('AGENT_PROMO_PREFETCH=false → предвызова нет', async () => {
    const { deps, kbHandler } = promoDeps('system', { found: true, context: 'x', sources: [] });
    deps.config = { ...require('./config'), AGENT_PROMO_PREFETCH: false };
    await orchestrator.runDialog(1, 'k', { deps });
    expect(kbHandler).not.toHaveBeenCalled();
  });

  test('предвызов пишется в журнал tool-событий (память следующего хода)', async () => {
    const stub = makeToolEventsStub();
    const { deps } = promoDeps('system', { found: true, context: 'Акция', sources: [] });
    deps.toolEvents = stub.mod;
    await orchestrator.runDialog(1, '79001112233', { deps });
    const pushed = stub.buffers[0].push.mock.calls.map(c => c[0]);
    expect(pushed).toContain('search_knowledge_base');
  });

  // Статья предвызова — легальный источник адреса для address-guard: иначе
  // адрес из статьи об акции вырезался бы как выдумка модели.
  test('адрес из предзагруженной статьи не режется address-guard', async () => {
    const { deps } = promoDeps('system',
      { found: true, context: 'Акция августа. Ждём вас: ул. Генерала Белова, 28 к. 3', sources: [] });
    deps.provider.createMessage.mockResolvedValue({
      assistantMsg: { role: 'assistant', content: 'ок' }, toolCalls: [],
      text: 'Ждём вас по адресу: ул. Генерала Белова, 28 к. 3' });
    const res = await orchestrator.runDialog(1, '79001112233', { deps });
    expect(res.replies.join(' ')).toContain('Генерала Белова');
  });
});
