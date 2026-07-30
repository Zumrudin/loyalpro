'use strict';

// Оркестратор провайдер-агностичен: мокаем provider.createMessage, реальный
// toolResultMessages берём из aitunnel-провайдера (формат {role:'tool'}).
const realProvider = require('./services/agent/providers/aitunnel');
const orchestrator = require('./services/agent/orchestrator');

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
    const deps = makeDeps({ identity: { resolveClient: jest.fn(async () => ({ id: 5, name: 'Анна', phone: '+79001112233' })) } });
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
