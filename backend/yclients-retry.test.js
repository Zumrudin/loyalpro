'use strict';

// Инцидент 2026-09-19 (79651442032): два reschedule_booking подряд получили от
// YClients «Превышен лимит запросов, попробуйте повторить запрос через 0 секунд»
// — и ни один не был повторён. Ретрай 429 жил только в синке каталога товаров.

const { withRateLimitRetry, isRateLimitError } = require('./services/yclients-retry');

function rateLimitErr(withStatus) {
  const e = new Error('Превышен лимит запросов, попробуйте повторить запрос через 0 секунд.');
  if (withStatus) e.status = 429;
  return e;
}

describe('isRateLimitError', () => {
  test('status 429 → true', () => expect(isRateLimitError(Object.assign(new Error('x'), { status: 429 }))).toBe(true));
  test('текст YClients без статуса (ycUpdateRecord теряет status) → true', () =>
    expect(isRateLimitError(rateLimitErr(false))).toBe(true));
  test('прочая ошибка → false', () => expect(isRateLimitError(new Error('Выбранное время недоступно'))).toBe(false));
  test('не Error → false', () => expect(isRateLimitError(null)).toBe(false));
});

describe('withRateLimitRetry', () => {
  test('успех с первой попытки — без задержек', async () => {
    const sleep = jest.fn(async () => {});
    const fn = jest.fn(async () => 'ok');
    await expect(withRateLimitRetry(fn, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test('429 → пауза → повтор → успех', async () => {
    const sleep = jest.fn(async () => {});
    const fn = jest.fn()
      .mockRejectedValueOnce(rateLimitErr(true))
      .mockResolvedValueOnce({ id: 1 });
    await expect(withRateLimitRetry(fn, { sleep, delayMs: 1000 })).resolves.toEqual({ id: 1 });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  test('лимит попыток исчерпан → последняя ошибка наружу', async () => {
    const sleep = jest.fn(async () => {});
    const fn = jest.fn(async () => { throw rateLimitErr(false); });
    await expect(withRateLimitRetry(fn, { sleep, retries: 2 })).rejects.toThrow(/Превышен лимит/);
    expect(fn).toHaveBeenCalledTimes(3);   // 1 + 2 повтора
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test('не-429 ошибка не повторяется', async () => {
    const sleep = jest.fn(async () => {});
    const fn = jest.fn(async () => { throw new Error('Выбранное время недоступно'); });
    await expect(withRateLimitRetry(fn, { sleep })).rejects.toThrow(/недоступно/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test('дефолт: 2 повтора, 1000 мс', async () => {
    const sleep = jest.fn(async () => {});
    const fn = jest.fn(async () => { throw rateLimitErr(true); });
    await expect(withRateLimitRetry(fn, { sleep })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
  });
});
