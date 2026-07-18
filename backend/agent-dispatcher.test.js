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

test('эскалация → реплики не отправляются, бот молчит (I2)', async () => {
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: ['секунду, зову оператора'], escalated: true })) } });
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
