'use strict';

const { createAlerter, isPaymentError } = require('./services/ops-alert');

describe('ops-alert', () => {
  test('isPaymentError: 402 / «Недостаточно средств» / insufficient', () => {
    expect(isPaymentError(new Error('402 Недостаточно средств'))).toBe(true);
    expect(isPaymentError(Object.assign(new Error('x'), { status: 402 }))).toBe(true);
    expect(isPaymentError(new Error('insufficient_quota'))).toBe(true);
    expect(isPaymentError(new Error('ECONNRESET'))).toBe(false);
    expect(isPaymentError(null)).toBe(false);
  });

  test('шлёт раз в час на ключ, без транспорта — только лог', async () => {
    const sent = [];
    const warned = [];
    let now = 1_000_000;
    const a = createAlerter({
      transport: async (text) => { sent.push(text); },
      log: { warn: (m) => warned.push(m), error: (m) => warned.push(m) },
      nowMs: () => now,
      cooldownMs: 3600_000,
    });
    expect(await a.notify('provider_402', 'баланс провайдера исчерпан')).toBe(true);
    expect(await a.notify('provider_402', 'баланс провайдера исчерпан')).toBe(false);
    now += 3600_001;
    expect(await a.notify('provider_402', 'баланс провайдера исчерпан')).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('provider_402');

    const b = createAlerter({ transport: null, log: { warn: (m) => warned.push(m), error: (m) => warned.push(m) } });
    expect(await b.notify('k', 'текст')).toBe(false);
    expect(warned.join('\n')).toMatch(/транспорт алертов не настроен/);
  });

  test('падение транспорта не бросает наружу и не раскрывает токен', async () => {
    const warned = [];
    const a = createAlerter({
      transport: async () => { throw new Error('https://api.telegram.org/botSECRET/sendMessage failed'); },
      log: { warn: (m) => warned.push(m), error() {} },
    });
    await expect(a.notify('k', 't')).resolves.toBe(false);
    expect(warned.join('\n')).not.toContain('SECRET');
  });
});
