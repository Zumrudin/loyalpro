'use strict';

const { buildPhoneRequest, isNeedsPhone, NEEDS_PHONE_ERROR, PROMPT_RULE_MARKER } =
  require('./services/agent/phone-request');

describe('phone-request: детерминированный запрос номера для записи', () => {
  test('время из datetime называется, только если оно уже разрешено в ходе', () => {
    const t = buildPhoneRequest({
      datetime: '2026-09-18T17:30:00+03:00', allowedTimes: new Set(['17:30', '21:00']),
    });
    expect(t).toContain('18 сентября в 17:30');
    expect(t).toMatch(/номер телефона/);
  });

  test('время НЕ разрешено (могло быть выдумано моделью) → «это время»', () => {
    const t = buildPhoneRequest({ datetime: '2026-09-18T17:30:00+03:00', allowedTimes: new Set(['21:00']) });
    expect(t).not.toContain('17:30');
    expect(t).toContain('это время');
  });

  test('без datetime / без allowedTimes / битый datetime — текст всё равно есть', () => {
    for (const args of [{}, { datetime: 'x' }, { datetime: '2026-09-18T17:30:00+03:00' }]) {
      const t = buildPhoneRequest(args);
      expect(t).toMatch(/номер телефона/);
      expect(t).not.toContain('17:30');
    }
  });

  test('время в тексте — московское, независимо от смещения в datetime', () => {
    const t = buildPhoneRequest({ datetime: '2026-09-18T14:30:00Z', allowedTimes: new Set(['17:30']) });
    expect(t).toContain('в 17:30');
  });

  test('«ваш» в тексте нет: на канале без номера тот же текст уходит и при записи гостя', () => {
    expect(buildPhoneRequest({})).not.toMatch(/\bваш\b/i);
  });

  test('isNeedsPhone — строго по флагу needs_phone:true', () => {
    expect(isNeedsPhone({ needs_phone: true, error: 'x' })).toBe(true);
    expect(isNeedsPhone({ invalid_args: true, error: 'x' })).toBe(false);
    expect(isNeedsPhone({ needs_phone: 'true' })).toBe(false);
    expect(isNeedsPhone(null)).toBe(false);
    expect(isNeedsPhone('needs_phone')).toBe(false);
  });

  test('текст ошибки инструмента объясняет модели, что номер уже спрошен кодом', () => {
    expect(NEEDS_PHONE_ERROR).toMatch(/client_phone/);
    expect(NEEDS_PHONE_ERROR).toMatch(/САМА попросила/);
    expect(PROMPT_RULE_MARKER).toMatch(/попросит номер/);
  });
});
