'use strict';

const { createAlerter, isPaymentError } = require('./services/ops-alert');

describe('ops-alert', () => {
  test('isPaymentError: 402 / «Недостаточно средств» / insufficient', () => {
    expect(isPaymentError(new Error('402 Недостаточно средств'))).toBe(true);
    expect(isPaymentError(Object.assign(new Error('x'), { status: 402 }))).toBe(true);
    expect(isPaymentError(new Error('insufficient_quota'))).toBe(true);
    expect(isPaymentError(new Error('ECONNRESET'))).toBe(false);
    expect(isPaymentError(null)).toBe(false);
    expect(isPaymentError({ response: { status: 402 }, message: 'x' })).toBe(true);
    expect(isPaymentError(new Error('insufficient permissions'))).toBe(false);
    expect(isPaymentError(new Error('Key (salon_id)=(402) is not present'))).toBe(false);
    expect(isPaymentError(new Error('record 1402 not found'))).toBe(false);
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
    const before = warned.length;
    now += 3600_001;
    await b.notify('k', 'текст');
    expect(warned.slice(before).filter(m => /не настроен/.test(m))).toHaveLength(0); // раз на процесс
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

  test('упавшая отправка не сжигает час: повтор пробует снова', async () => {
    let fail = true;
    const a = createAlerter({
      transport: async () => { if (fail) throw new Error('tg down'); },
      log: { warn() {}, error() {} },
    });
    expect(await a.notify('k', 't')).toBe(false);
    fail = false;
    expect(await a.notify('k', 't')).toBe(true);
  });

  test('в кулдауне ERROR не пишется', async () => {
    const errs = [];
    const a = createAlerter({ transport: async () => {}, log: { warn() {}, error: (m) => errs.push(m) } });
    await a.notify('k', 't'); await a.notify('k', 't'); await a.notify('k', 't');
    expect(errs).toHaveLength(1);
  });
});
