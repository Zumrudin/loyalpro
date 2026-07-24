'use strict';

jest.useFakeTimers();

const dispatcher = require('./services/agent/dispatcher');

const meta = { phone: '79001112233', channel: 'whatsapp', messageId: 'm1' };

function deps(overrides = {}) {
  return {
    debounceMs: 1000,
    settings: { isAllowed: jest.fn(async () => ({ allow: true, reason: 'ok' })) },
    orchestrator: { runDialog: jest.fn(async () => ({ replies: ['Здравствуйте!'], escalated: false })) },
    send: jest.fn(async () => {}),
    escalate: jest.fn(async () => ({ escalated: true })),
    ...overrides,
  };
}

beforeEach(() => { dispatcher._reset(); jest.clearAllTimers(); });

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

// Гейт — предохранитель пилота (whitelist). Если он упал, мы НЕ знаем, можно ли
// писать этому номеру → fail-closed: молчим, несмотря на инвариант «не молчать».
test('гейт упал → страховочное сообщение НЕ шлём (fail-closed)', async () => {
  const d = deps({ settings: { isAllowed: jest.fn(async () => { throw new Error('db down'); }) } });
  await expect(dispatcher.process(1, 'k', meta, d)).resolves.toBeUndefined();
  expect(d.send).not.toHaveBeenCalled();
  expect(d.escalate).not.toHaveBeenCalled();
});
