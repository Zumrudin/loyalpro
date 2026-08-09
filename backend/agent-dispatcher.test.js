'use strict';

jest.useFakeTimers();

// Логгер не инжектится через deps — перехватываем сам модуль createLogger:
// погашенный черновик обязан попадать в лог (иначе разбор инцидента упирается
// в «неизвестно, что модель написала» — прод 2026-08-06, 79200255591).
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLogger }));

const dispatcher = require('./services/agent/dispatcher');

const meta = { phone: '79001112233', channel: 'whatsapp', messageId: 'm1' };

function deps(overrides = {}) {
  return {
    debounceMs: 1000,
    settings: { isAllowed: jest.fn(async () => ({ allow: true, reason: 'ok' })) },
    orchestrator: { runDialog: jest.fn(async () => ({ replies: ['Здравствуйте!'], escalated: false })) },
    send: jest.fn(async () => {}),
    // Журнал авторства ходит в БД — в юнит-тесте подменяем (иначе pg тянет
    // реальное соединение и падает после teardown).
    authorship: { remember: jest.fn() },
    toolEvents: { markDelivered: jest.fn() },
    escalate: jest.fn(async () => ({ escalated: true })),
    ...overrides,
  };
}

beforeEach(() => {
  dispatcher._reset();
  jest.clearAllTimers();
  // Логгер общий на файл — без чистки поиск строки по подстроке находит запись
  // предыдущего теста (и тест зеленеет/краснеет по чужому ходу).
  for (const fn of Object.values(mockLogger)) fn.mockClear();
});

test('серия из двух сообщений в окне дебаунса → один прогон', async () => {
  const d = deps();
  dispatcher.enqueue(1, 'k', meta, d);
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.orchestrator.runDialog).toHaveBeenCalledTimes(1);
  expect(d.send).toHaveBeenCalledWith(meta, 'Здравствуйте!');
});

test('гейт запретил → прогон не запускается', async () => {
  const d = deps({ settings: { isAllowed: jest.fn(async () => ({ allow: false, reason: 'whitelist' })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.orchestrator.runDialog).not.toHaveBeenCalled();
  expect(d.send).not.toHaveBeenCalled();
});

test('несколько реплик отправляются по очереди', async () => {
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: ['раз', 'два'] })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.send).toHaveBeenCalledTimes(2);
  expect(d.send).toHaveBeenNthCalledWith(1, meta, 'раз');
  expect(d.send).toHaveBeenNthCalledWith(2, meta, 'два');
});

test('групповой чат → прогона нет, даже если в meta есть номер участника', async () => {
  const d = deps();
  const groupMeta = { ...meta, channel: 'tdlib', chatId: '-1003759304044' };
  // Ключ диалога = номер участника (так его считает вебхук) — раньше это уводило
  // Милу в ЛИЧНУЮ переписку с этим участником.
  dispatcher.enqueue(1, '79001112233', groupMeta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.settings.isAllowed).not.toHaveBeenCalled();
  expect(d.orchestrator.runDialog).not.toHaveBeenCalled();
  expect(d.send).not.toHaveBeenCalled();
});

test('групповой ключ диалога → process молчит (второй уровень защиты)', async () => {
  const d = deps();
  await expect(dispatcher.process(1, 'g:-1003759304044', meta, d)).resolves.toBeUndefined();
  expect(d.orchestrator.runDialog).not.toHaveBeenCalled();
  expect(d.send).not.toHaveBeenCalled();
});

test('гейт проверяется по телефону из meta', async () => {
  const d = deps();
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.settings.isAllowed).toHaveBeenCalledWith(1, '79001112233');
});

test('гейт бросил исключение → process не реджектит, прогона нет (C1)', async () => {
  const d = deps({ settings: { isAllowed: jest.fn(async () => { throw new Error('db down'); }) } });
  // process должен проглотить ошибку и НЕ реджектить (иначе unhandledRejection → падение процесса)
  await expect(dispatcher.process(1, 'k', meta, d)).resolves.toBeUndefined();
  expect(d.orchestrator.runDialog).not.toHaveBeenCalled();
});

test('эскалация с текстом → объявление о переводе доставляется (де-эскалация)', async () => {
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: ['Передаю вас администратору 🤍'], escalated: true })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.orchestrator.runDialog).toHaveBeenCalledTimes(1);
  expect(d.send).toHaveBeenCalledTimes(1);
  expect(d.send).toHaveBeenCalledWith(meta, 'Передаю вас администратору 🤍');
});

test('эскалация без текста → дефолтная фраза перевода (страховка от молчания)', async () => {
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: [], escalated: true })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.send).toHaveBeenCalledTimes(1);
  expect(d.send).toHaveBeenCalledWith(meta, expect.stringContaining('администратор'));
});

test('эскалация с пустой (пробельной) репликой → дефолтная фраза перевода (страховка)', async () => {
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: ['   '], escalated: true })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.send).toHaveBeenCalledTimes(1);
  expect(d.send).toHaveBeenCalledWith(meta, expect.stringContaining('администратор'));
});

test('эскалация с репликой БЕЗ упоминания администратора → фраза перевода добавляется', async () => {
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: ['Спасибо, что предупредили!'], escalated: true })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.send).toHaveBeenCalledTimes(2);
  expect(d.send).toHaveBeenNthCalledWith(1, meta, 'Спасибо, что предупредили!');
  expect(d.send).toHaveBeenNthCalledWith(2, meta, expect.stringContaining('администратору'));
});

test('эскалация с репликой, где перевод уже объявлен → ничего не добавляем', async () => {
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: ['Передаю ваш диалог администратору клиники — он подключится с минуты на минуту 🤍'], escalated: true })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.send).toHaveBeenCalledTimes(1);
});

test('уже-эскалированный диалог → бот молчит, не переотправляет фразу перевода (регрессия)', async () => {
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: [], escalated: true, alreadyEscalated: true })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.orchestrator.runDialog).toHaveBeenCalledTimes(1);
  expect(d.send).not.toHaveBeenCalled();
});

test('сообщение во время прогона → ровно один повторный прогон, лишнего от таймера нет (I1)', async () => {
  const d = deps();
  let runs = 0;
  d.orchestrator.runDialog = jest.fn(async () => {
    runs += 1;
    if (runs === 1) dispatcher.enqueue(1, 'k', meta, d);   // новое входящее во время 1-го прогона
    return { replies: [`r${runs}`] };
  });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);   // debounce → прогон 1 (внутри придёт msg2 → rerun)
  await jest.advanceTimersByTimeAsync(5000);   // прокрутить дальше любого возможного лишнего таймера
  // Прогон 1 + один повторный по rerun = 2. Никакого третьего от заново взведённого таймера.
  expect(d.orchestrator.runDialog).toHaveBeenCalledTimes(2);
});

// ── Инвариант: агент НИКОГДА не оставляет клиента без ответа ──
// Инцидент 2026-07-19: оркестратор вернул replies=[], цикл send прошёл по нулю
// элементов, клиент завис навсегда (watermark уже сдвинут — ретрая не будет).
test('оркестратор вернул ноль реплик → отправляется страховочное сообщение', async () => {
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: [], escalated: false })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.send).toHaveBeenCalledTimes(1);
  expect(d.send.mock.calls[0][1]).toMatch(/администратор/i);
  // Обещание «администратор подключится» должно быть правдой: диалог реально уходит человеку.
  expect(d.escalate).toHaveBeenCalledTimes(1);
  expect(d.escalate.mock.calls[0][0]).toBe(1);
  expect(d.escalate.mock.calls[0][1]).toBe('k');
});

test('реплики из пробелов считаются пустым ответом → страховочное сообщение', async () => {
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: ['  ', ''], escalated: false })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.send).toHaveBeenCalledTimes(1);
  expect(d.send.mock.calls[0][1]).toMatch(/администратор/i);
});

test('create_booking провалился, бот не эскалировал → принудительный перевод, не «секундочку»', async () => {
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => (
    { replies: ['Секундочку, уточняю детали 🤍'], escalated: false, bookingFailed: true })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.escalate).toHaveBeenCalledTimes(1);                 // диалог реально уходит человеку
  expect(d.send).toHaveBeenCalledTimes(1);
  expect(d.send.mock.calls[0][1]).toMatch(/администратор/i);   // клиент получил перевод, а не заглушку
});

test('booking провалился, но бот ПЕРЕИГРАЛ (предложил другое время) → доставляем, НЕ переводим', async () => {
  const reoffer = 'К сожалению, 14:00 только что заняли. Могу предложить 15:00 или 16:00 — что удобнее?';
  const d = deps({
    orchestrator: { runDialog: jest.fn(async () => (
      { replies: [reoffer], escalated: false, bookingFailed: true, bookingFailRecoverable: true })) },
    priorBookingFailure: jest.fn(async () => false),   // первый провал в серии
  });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.escalate).not.toHaveBeenCalled();           // на человека НЕ переводим
  expect(d.send).toHaveBeenCalledTimes(1);
  expect(d.send).toHaveBeenCalledWith(meta, reoffer);  // пациент получил переигровку
});

test('booking провалился, переигровка есть, но это ПОВТОРНЫЙ провал → всё равно перевод', async () => {
  const d = deps({
    orchestrator: { runDialog: jest.fn(async () => (
      { replies: ['Могу предложить 15:00'], escalated: false, bookingFailed: true, bookingFailRecoverable: true })) },
    priorBookingFailure: jest.fn(async () => true),    // в серии уже был провал
  });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.escalate).toHaveBeenCalledTimes(1);
  expect(d.send).toHaveBeenCalledTimes(1);
  expect(d.send.mock.calls[0][1]).toMatch(/администратор/i);
});

test('booking провалился, НО бот уже сам эскалировал → без двойного перевода', async () => {
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => (
    { replies: ['Передаю администратору 🤍'], escalated: true, bookingFailed: true })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.send).toHaveBeenCalledTimes(1);
  expect(d.send).toHaveBeenCalledWith(meta, 'Передаю администратору 🤍');
});

test('прогон упал с ошибкой → клиент всё равно получает сообщение', async () => {
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => { throw new Error('provider timeout'); }) } });
  await expect(dispatcher.process(1, 'k', meta, d)).resolves.toBeUndefined();
  expect(d.send).toHaveBeenCalledTimes(1);
  expect(d.send.mock.calls[0][1]).toMatch(/администратор/i);
  expect(d.escalate).toHaveBeenCalledTimes(1);
});

test('падение самой отправки не роняет process (C1)', async () => {
  const d = deps({
    orchestrator: { runDialog: jest.fn(async () => { throw new Error('provider timeout'); }) },
    send: jest.fn(async () => { throw new Error('chatpush 500'); }),
  });
  await expect(dispatcher.process(1, 'k', meta, d)).resolves.toBeUndefined();
});

test('эскалация тоже упала (БД недоступна) → клиент всё равно получает сообщение', async () => {
  const d = deps({
    orchestrator: { runDialog: jest.fn(async () => ({ replies: [], escalated: false })) },
    escalate: jest.fn(async () => { throw new Error('db down'); }),
  });
  await expect(dispatcher.process(1, 'k', meta, d)).resolves.toBeUndefined();
  expect(d.send).toHaveBeenCalledTimes(1);
});

test('диалог уже у оператора → молчим, страховочное сообщение НЕ шлём', async () => {
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => (
    { replies: [], escalated: true, alreadyEscalated: true })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.send).not.toHaveBeenCalled();
});

// Инцидент 2026-07-24: запись создана, но добивочный вызов LLM упал → сегодня диалог
// уходил на оператора при УЖЕ созданной брони. Оркестратор теперь отдаёт правдивое
// подтверждение с флагом degradedAfterWrite (escalated:false, writeSucceeded → falseSuccess:false,
// bookingFailed:false). Инвариант: подтверждение доставляется КЛИЕНТУ, эскалации НЕТ.
test('деградация после успешной записи → подтверждение доставлено, эскалации нет', async () => {
  const confirm = 'Готово! Записала Ирину на 27 июля в 19:30 ✅ Будем ждать 🤍';
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => (
    { replies: [confirm], escalated: false, sideEffect: true, degradedAfterWrite: true })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.send).toHaveBeenCalledTimes(1);
  expect(d.send).toHaveBeenCalledWith(meta, confirm);
  expect(d.escalate).not.toHaveBeenCalled();
});

// ── Серия сообщений: устаревший черновик не отправляется ──
// Инцидент 2026-07-31: сообщение пришло в последние секунды прогона (после
// stale-check оркестратора) → черновик отправлялся, а повторный прогон отвечал
// на серию ещё раз — клиент получал два почти одинаковых ответа с приветствием.
test('новое сообщение до отправки (без side-effect) → черновик выброшен, один общий ответ', async () => {
  const d = deps();
  let runs = 0;
  d.orchestrator.runDialog = jest.fn(async () => {
    runs += 1;
    if (runs === 1) dispatcher.enqueue(1, 'k', meta, d);   // новое входящее во время 1-го прогона
    return { replies: [`r${runs}`] };
  });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.orchestrator.runDialog).toHaveBeenCalledTimes(2);
  // Черновик r1 не ушёл: клиент получил ровно один ответ — из повторного прогона.
  expect(d.send).toHaveBeenCalledTimes(1);
  expect(d.send).toHaveBeenCalledWith(meta, 'r2');
});

test('ход с side-effect (запись создана) НЕ выбрасывается даже при новом сообщении', async () => {
  const d = deps();
  let runs = 0;
  d.orchestrator.runDialog = jest.fn(async () => {
    runs += 1;
    if (runs === 1) {
      dispatcher.enqueue(1, 'k', meta, d);
      return { replies: ['Записала вас на 20:00'], sideEffect: true };
    }
    return { replies: [`r${runs}`] };
  });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  // Подтверждение реальной записи обязано дойти, потом ответ на новое сообщение.
  expect(d.send).toHaveBeenCalledTimes(2);
  expect(d.send).toHaveBeenNthCalledWith(1, meta, 'Записала вас на 20:00');
  expect(d.send).toHaveBeenNthCalledWith(2, meta, 'r2');
});

test('успешно отправленная реплика запоминается в pending-replies (для транскрипта)', async () => {
  const pending = require('./services/agent/pending-replies');
  pending._reset();
  const d = deps();
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(pending.peek(1, 'k').map(e => e.text)).toEqual(['Здравствуйте!']);
});

test('упавшая отправка НЕ запоминается в pending-replies', async () => {
  const pending = require('./services/agent/pending-replies');
  pending._reset();
  const d = deps({
    orchestrator: { runDialog: jest.fn(async () => ({ replies: ['ответ'] })) },
    send: jest.fn(async () => { throw new Error('chatpush 500'); }),
  });
  await dispatcher.process(1, 'k', meta, d);
  expect(pending.peek(1, 'k').map(e => e.text)).not.toContain('ответ');
});

// Гейт — предохранитель пилота (whitelist). Если он упал, мы НЕ знаем, можно ли
// писать этому номеру → fail-closed: молчим, несмотря на инвариант «не молчать».
test('гейт упал → страховочное сообщение НЕ шлём (fail-closed)', async () => {
  const d = deps({ settings: { isAllowed: jest.fn(async () => { throw new Error('db down'); }) } });
  await expect(dispatcher.process(1, 'k', meta, d)).resolves.toBeUndefined();
  expect(d.send).not.toHaveBeenCalled();
  expect(d.escalate).not.toHaveBeenCalled();
});

// Пауза «отвечал администратор» снимается на ОТКРЫТИИ окна расписания. Без
// этого красный диалог не вернулся бы боту никогда: на проде админы отвечают
// из приложения Chatpush, и за неделю так помечается ≈24% диалогов.
describe('снятие паузы оператора на открытии окна', () => {
  const withWindow = (minutes, dialogState) => deps({
    settings: { isAllowed: jest.fn(async () => ({ allow: true, reason: 'ok', minutesSinceWindowStart: minutes })) },
    dialogState,
  });

  test('внутри окна — пробуем снять паузу, дальше обычный прогон', async () => {
    const dialogState = { resumeOperatorPauseIfWindowReopened: jest.fn(async () => true) };
    const d = withWindow(180, dialogState);
    dispatcher.enqueue(1, 'k', meta, d);
    await jest.advanceTimersByTimeAsync(1000);
    expect(dialogState.resumeOperatorPauseIfWindowReopened).toHaveBeenCalledWith(1, 'k', 180);
    expect(d.orchestrator.runDialog).toHaveBeenCalledTimes(1);
  });

  test('вне окна (null) — паузу не трогаем', async () => {
    const dialogState = { resumeOperatorPauseIfWindowReopened: jest.fn(async () => false) };
    const d = withWindow(null, dialogState);
    dispatcher.enqueue(1, 'k', meta, d);
    await jest.advanceTimersByTimeAsync(1000);
    expect(dialogState.resumeOperatorPauseIfWindowReopened).not.toHaveBeenCalled();
  });

  test('сбой снятия паузы не роняет ход', async () => {
    const dialogState = { resumeOperatorPauseIfWindowReopened: jest.fn(async () => { throw new Error('db down'); }) };
    const d = withWindow(10, dialogState);
    dispatcher.enqueue(1, 'k', meta, d);
    await jest.advanceTimersByTimeAsync(1000);
    expect(d.orchestrator.runDialog).toHaveBeenCalledTimes(1);
  });
});

// ── Вердикт delivered для журнала tool-цикла ──
// Смысл: факты, которых пациент НЕ видел, не должны всплыть в памяти следующего
// хода как «уже сказанное». true — только когда реплики МОДЕЛИ реально ушли.
describe('вердикт delivered для журнала инструментов', () => {
  test('реплики отправлены → markDelivered(turnId, true)', async () => {
    const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: ['ответ'], escalated: false, turnId: 't1' })) } });
    dispatcher.enqueue(1, 'k', meta, d);
    await jest.advanceTimersByTimeAsync(1000);
    expect(d.toolEvents.markDelivered).toHaveBeenCalledWith('t1', true);
  });

  test('ложный успех: реплика погашена → markDelivered(turnId, false)', async () => {
    const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: ['Готово, перенесла!'], falseSuccess: true, escalated: false, turnId: 't2' })) } });
    dispatcher.enqueue(1, 'k', meta, d);
    await jest.advanceTimersByTimeAsync(1000);
    expect(d.toolEvents.markDelivered).toHaveBeenCalledWith('t2', false);
  });

  // Разбор инцидента 2026-08-06 (79200255591) упёрся в то, что текста погашенной
  // реплики нет НИГДЕ: guard логировал только факт, а в БД черновики не ложатся.
  // Пишем в лог сам текст (с видом утверждения) — это единственный след.
  test('ложный успех: текст погашенной реплики и вид утверждения попадают в лог', async () => {
    const draft = 'Я вижу, что вы уже записаны\nна 7 августа в 12:00 🤍';
    const d = deps({ orchestrator: { runDialog: jest.fn(async () => (
      { replies: [draft], falseSuccess: true, falseSuccessKind: 'booked', escalated: false, turnId: 't9' })) } });
    dispatcher.enqueue(1, 'k', meta, d);
    await jest.advanceTimersByTimeAsync(1000);
    const line = mockLogger.warn.mock.calls.map(c => String(c[0])).find(t => t.includes('гашу ложь'));
    expect(line).toContain('booked');
    // Перевод строки схлопнут: многострочная реплика не должна рвать лог.
    expect(line).toContain('Я вижу, что вы уже записаны на 7 августа в 12:00');
  });

  test('без turnId (ранние выходы runDialog) — вердикт не пишется', async () => {
    const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: ['ответ'], escalated: false })) } });
    dispatcher.enqueue(1, 'k', meta, d);
    await jest.advanceTimersByTimeAsync(1000);
    expect(d.toolEvents.markDelivered).not.toHaveBeenCalled();
  });

  test('эскалация с репликой → true (клиент реплику видел)', async () => {
    const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: ['Передаю администратору'], escalated: true, turnId: 't3' })) } });
    dispatcher.enqueue(1, 'k', meta, d);
    await jest.advanceTimersByTimeAsync(1000);
    expect(d.toolEvents.markDelivered).toHaveBeenCalledWith('t3', true);
  });

  test('эскалация БЕЗ реплик модели (только страховочная фраза) → false', async () => {
    const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: [], escalated: true, turnId: 't4' })) } });
    dispatcher.enqueue(1, 'k', meta, d);
    await jest.advanceTimersByTimeAsync(1000);
    expect(d.send).toHaveBeenCalledTimes(1);   // ушёл детерминированный текст диспетчера
    expect(d.toolEvents.markDelivered).toHaveBeenCalledWith('t4', false);
  });

  test('диалог уже у оператора (бот молчит) → false', async () => {
    const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: [], escalated: true, alreadyEscalated: true, turnId: 't5' })) } });
    dispatcher.enqueue(1, 'k', meta, d);
    await jest.advanceTimersByTimeAsync(1000);
    expect(d.toolEvents.markDelivered).toHaveBeenCalledWith('t5', false);
  });

  // Исчерпанный tool-цикл: модель текста не дала, пациенту ушла только
  // детерминированная страховка → фактов хода он не видел.
  test('ход без реплик модели (страховка + эскалация) → false', async () => {
    const d = deps({ orchestrator: { runDialog: jest.fn(async () => (
      { replies: [], escalated: false, exhausted: true, turnId: 't9' })) } });
    dispatcher.enqueue(1, 'k', meta, d);
    await jest.advanceTimersByTimeAsync(1000);
    expect(d.send).toHaveBeenCalledTimes(1);                     // только silentFallbackText
    expect(d.send.mock.calls[0][1]).toMatch(/администратор/i);
    expect(d.toolEvents.markDelivered).toHaveBeenCalledWith('t9', false);
  });

  test('восстановимый провал записи: переигровка доставлена → true', async () => {
    const d = deps({
      orchestrator: { runDialog: jest.fn(async () => (
        { replies: ['Могу предложить 15:00'], escalated: false, bookingFailed: true, bookingFailRecoverable: true, turnId: 't6' })) },
      priorBookingFailure: jest.fn(async () => false),
    });
    dispatcher.enqueue(1, 'k', meta, d);
    await jest.advanceTimersByTimeAsync(1000);
    expect(d.toolEvents.markDelivered).toHaveBeenCalledWith('t6', true);
  });

  test('провал записи без переигровки: реплика погашена переводом → false', async () => {
    const d = deps({ orchestrator: { runDialog: jest.fn(async () => (
      { replies: ['Секундочку 🤍'], escalated: false, bookingFailed: true, turnId: 't7' })) } });
    dispatcher.enqueue(1, 'k', meta, d);
    await jest.advanceTimersByTimeAsync(1000);
    expect(d.toolEvents.markDelivered).toHaveBeenCalledWith('t7', false);
  });

  test('устаревший черновик (rerun) выброшен → false для того хода', async () => {
    const d = deps();
    let runs = 0;
    d.orchestrator.runDialog = jest.fn(async () => {
      runs += 1;
      if (runs === 1) dispatcher.enqueue(1, 'k', meta, d);
      return { replies: [`r${runs}`], turnId: `t${runs}` };
    });
    dispatcher.enqueue(1, 'k', meta, d);
    await jest.advanceTimersByTimeAsync(1000);
    expect(d.toolEvents.markDelivered).toHaveBeenNthCalledWith(1, 't1', false);
    expect(d.toolEvents.markDelivered).toHaveBeenNthCalledWith(2, 't2', true);
  });

  // Отправка бросила на середине серии: часть реплик ушла, часть нет. Пишем
  // false — консервативно. Показать в памяти факт, которого пациент не видел,
  // хуже, чем повторить уже сказанное; к тому же ход всё равно уходит человеку.
  test('отправка упала на середине → вердикт всё равно пишется, и он false', async () => {
    const d = deps({
      orchestrator: { runDialog: jest.fn(async () => ({ replies: ['раз', 'два'], turnId: 't8' })) },
      send: jest.fn(async (m, text) => { if (text === 'два') throw new Error('chatpush 500'); }),
    });
    await expect(dispatcher.process(1, 'k', meta, d)).resolves.toBeUndefined();
    expect(d.toolEvents.markDelivered).toHaveBeenCalledWith('t8', false);
  });

  test('прогон упал целиком (turnId неизвестен) → вердикт не пишется', async () => {
    const d = deps({ orchestrator: { runDialog: jest.fn(async () => { throw new Error('provider timeout'); }) } });
    await expect(dispatcher.process(1, 'k', meta, d)).resolves.toBeUndefined();
    expect(d.toolEvents.markDelivered).not.toHaveBeenCalled();
  });
});

// Молчание на завершающей вежливости. Ключевое отличие от «хода без реплик»:
// silent — это РЕШЕНИЕ промолчать, а не отказ, поэтому ни эскалации, ни
// страховочной фразы быть не должно (иначе на «спасибо» пациент получал бы
// «сейчас подключу администратора»).
test('silent → ни отправки, ни эскалации', async () => {
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: [], silent: true })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.send).not.toHaveBeenCalled();
  expect(d.escalate).not.toHaveBeenCalled();
});

test('ход без реплик и БЕЗ silent → по-прежнему эскалация + страховочный ответ', async () => {
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: [] })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.escalate).toHaveBeenCalled();
  expect(d.send).toHaveBeenCalledTimes(1);
});

// ============================================================
// Доставка реплики: журнал отправок и своя строка в «Чате».
// Инцидент 2026-08-09 (79773115566): Chatpush вернул meta.status=success, а в
// WhatsApp не ушло ничего. Разбирать было нечем — delivery.id нигде не
// сохранялся, а реплика Милы попадает в «Чат» только эхом, которого не было.
// ============================================================
describe('журнал доставок и своя строка в «Чате»', () => {
  test('каждая отправленная реплика попадает в журнал доставок вместе с delivery', async () => {
    const deliveryLog = { record: jest.fn(async () => 1) };
    const d = deps({
      send: jest.fn(async () => ({ id: 555 })),
      persistOwn: jest.fn(async () => {}),
      deliveryLog,
    });
    await dispatcher.process(1, 'k', meta, d);
    expect(deliveryLog.record).toHaveBeenCalledWith(1, 'k', meta, 'Здравствуйте!', { id: 555 });
  });

  test('своя реплика кладётся в «Чат» тем же ходом', async () => {
    const persistOwn = jest.fn(async () => {});
    const d = deps({ send: jest.fn(async () => ({ id: 555 })), persistOwn, deliveryLog: { record: jest.fn() } });
    await dispatcher.process(1, 'k', meta, d);
    expect(persistOwn).toHaveBeenCalledWith(1, 'k', meta, 'Здравствуйте!', { id: 555 });
  });

  // Обе записи служебные: их сбой не имеет права стоить клиенту ответа и не
  // должен рвать серию на второй реплике.
  test('сбой журнала/персиста не ломает доставку серии', async () => {
    const d = deps({
      orchestrator: { runDialog: jest.fn(async () => ({ replies: ['раз', 'два'] })) },
      send: jest.fn(async () => ({ id: 555 })),
      persistOwn: jest.fn(async () => { throw new Error('db down'); }),
      deliveryLog: { record: jest.fn(async () => { throw new Error('db down'); }) },
    });
    await expect(dispatcher.process(1, 'k', meta, d)).resolves.toBeUndefined();
    expect(d.send).toHaveBeenCalledTimes(2);
  });

  test('defaultPersistOwn: WhatsApp — своя строка с авторством agent', async () => {
    const persist = require('./services/chat-persist');
    const spy = jest.spyOn(persist, 'persistWhatsappOutgoing').mockResolvedValue(undefined);
    await dispatcher.defaultPersistOwn(1, 'k', meta, 'текст', { id: 555 });
    expect(spy).toHaveBeenCalledWith(1, expect.objectContaining({
      delivery: { id: 555 }, phone: meta.phone, text: 'текст', authoredBy: 'agent',
    }));
    spy.mockRestore();
  });

  test('defaultPersistOwn: tdlib/max не трогаем — их строку кладёт эхо вебхука', async () => {
    const persist = require('./services/chat-persist');
    const spy = jest.spyOn(persist, 'persistWhatsappOutgoing').mockResolvedValue(undefined);
    await dispatcher.defaultPersistOwn(1, 'k', { ...meta, channel: 'tdlib' }, 'текст', { id: 555 });
    await dispatcher.defaultPersistOwn(1, 'k', meta, 'текст', undefined);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// delivery.id в логе — единственный способ узнать судьбу сообщения постфактум
// (GET /api/v1/delivery/:id). Без него разбор 09.08 упёрся в стену: чужие id
// отдают 404, а свои разрежены среди глобальной нумерации Chatpush.
test('defaultSend пишет delivery_id в лог', async () => {
  const chatpush = require('./services/chatpush');
  const config = require('./config');
  const prevToken = config.CHATPUSH.instanceToken;
  config.CHATPUSH.instanceToken = 'tok';
  const spy = jest.spyOn(chatpush, 'sendMessage').mockResolvedValue({ id: 376412700 });
  try {
    const out = await dispatcher.defaultSend(meta, 'Здравствуйте!');
    expect(out).toEqual({ id: 376412700 });
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('delivery=376412700'));
  } finally {
    spy.mockRestore();
    config.CHATPUSH.instanceToken = prevToken;
  }
});

describe('фото прайса', () => {
  const ATT = [{ nodeKey: 'c12', category: 'Лазерная эпиляция', fileUrl: '/uploads/a.jpg', fileName: 'a.jpg', mimeType: 'image/jpeg' }];
  const withFiles = (over) => deps({
    sendFile: jest.fn(async () => ({ id: 7 })),
    persistOwnFile: jest.fn(async () => {}),
    ...over,
  });

  test('обычный ход: сначала текст, потом фото', async () => {
    const d = withFiles({
      orchestrator: { runDialog: jest.fn(async () => ({ replies: ['Отправляю прайс'], attachments: ATT, escalated: false })) },
    });
    dispatcher.enqueue(1, 'k', meta, d);
    await jest.advanceTimersByTimeAsync(1000);
    expect(d.send).toHaveBeenCalledWith(meta, 'Отправляю прайс');
    expect(d.sendFile).toHaveBeenCalledTimes(1);
    expect(d.sendFile.mock.calls[0][1]).toMatchObject({ fileUrl: '/uploads/a.jpg' });
  });

  test('ложный успех: реплика погашена — фото тоже не уходит', async () => {
    const d = withFiles({
      orchestrator: { runDialog: jest.fn(async () => ({
        replies: ['Я вас записала'], attachments: ATT,
        falseSuccess: true, falseSuccessKind: 'booked', escalated: false,
      })) },
    });
    dispatcher.enqueue(1, 'k', meta, d);
    await jest.advanceTimersByTimeAsync(1000);
    expect(d.sendFile).not.toHaveBeenCalled();
  });

  test('сбой отправки файла не роняет ход — текст уже доставлен', async () => {
    const d = withFiles({
      orchestrator: { runDialog: jest.fn(async () => ({ replies: ['Отправляю прайс'], attachments: ATT, escalated: false })) },
      sendFile: jest.fn(async () => { throw new Error('chatpush 502'); }),
    });
    dispatcher.enqueue(1, 'k', meta, d);
    await jest.advanceTimersByTimeAsync(1000);
    expect(d.send).toHaveBeenCalledWith(meta, 'Отправляю прайс');
    expect(mockLogger.warn.mock.calls.some(c => /фото прайса/.test(c[0]))).toBe(true);
  });

  test('канал доезжает до оркестратора: без него send_price_list не знает про файлы', async () => {
    const d = withFiles({
      orchestrator: { runDialog: jest.fn(async () => ({ replies: ['ок'], escalated: false })) },
    });
    dispatcher.enqueue(1, 'k', meta, d);
    await jest.advanceTimersByTimeAsync(1000);
    expect(d.orchestrator.runDialog.mock.calls[0][2].ctx)
      .toMatchObject({ phone: meta.phone, channel: 'whatsapp' });
  });
});
