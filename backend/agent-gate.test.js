'use strict';
const {
  normalizePhoneKey, decideGate, parseHhMm, isWithinWindow, nowMskMinutes,
} = require('./services/agent-gate');

describe('normalizePhoneKey', () => {
  test('РФ 8→7 для 11 цифр', () => {
    expect(normalizePhoneKey('89200255591')).toBe('79200255591');
  });
  test('оставляет 7XXXXXXXXXX как есть', () => {
    expect(normalizePhoneKey('79200255591')).toBe('79200255591');
  });
  test('чистит форматирование и +', () => {
    expect(normalizePhoneKey('+7 (920) 025-55-91')).toBe('79200255591');
  });
  test('10-значное ядро → префикс 7', () => {
    expect(normalizePhoneKey('9200255591')).toBe('79200255591');
  });
  test('пустой/мусор → пустая строка', () => {
    expect(normalizePhoneKey('')).toBe('');
    expect(normalizePhoneKey(null)).toBe('');
  });
});

describe('parseHhMm', () => {
  test('валидное время → минуты от полуночи', () => {
    expect(parseHhMm('00:00')).toBe(0);
    expect(parseHhMm('09:30')).toBe(570);
    expect(parseHhMm('22:00')).toBe(1320);
    expect(parseHhMm('23:59')).toBe(1439);
  });
  test('пробелы по краям не мешают', () => {
    expect(parseHhMm(' 09:30 ')).toBe(570);
  });
  test('вне диапазона → null', () => {
    expect(parseHhMm('24:00')).toBe(null);
    expect(parseHhMm('09:60')).toBe(null);
  });
  test('кривой формат → null', () => {
    expect(parseHhMm('9:3')).toBe(null);
    expect(parseHhMm('0930')).toBe(null);
    expect(parseHhMm('')).toBe(null);
    expect(parseHhMm(undefined)).toBe(null);
    expect(parseHhMm(null)).toBe(null);
  });
});

describe('isWithinWindow', () => {
  test('обычное окно 09:00–18:00', () => {
    expect(isWithinWindow(540, 540, 1080)).toBe(true);    // 09:00 — начало включительно
    expect(isWithinWindow(720, 540, 1080)).toBe(true);    // 12:00
    expect(isWithinWindow(1080, 540, 1080)).toBe(false);  // 18:00 — конец исключительно
    expect(isWithinWindow(300, 540, 1080)).toBe(false);   // 05:00
  });
  test('окно через полночь 22:00–09:30', () => {
    expect(isWithinWindow(1320, 1320, 570)).toBe(true);   // 22:00 ровно
    expect(isWithinWindow(1380, 1320, 570)).toBe(true);   // 23:00
    expect(isWithinWindow(120, 1320, 570)).toBe(true);    // 02:00
    expect(isWithinWindow(569, 1320, 570)).toBe(true);    // 09:29
    expect(isWithinWindow(570, 1320, 570)).toBe(false);   // 09:30 ровно — уже вне
    expect(isWithinWindow(720, 1320, 570)).toBe(false);   // 12:00
  });
  test('start === end → окно нулевой длины, а не круглые сутки', () => {
    expect(isWithinWindow(1320, 1320, 1320)).toBe(false);
    expect(isWithinWindow(0, 1320, 1320)).toBe(false);
  });
});

describe('nowMskMinutes', () => {
  test('считает московское время независимо от TZ процесса', () => {
    // 19:07 UTC = 22:07 MSK (UTC+3 круглый год, без перехода на летнее время)
    expect(nowMskMinutes(new Date('2026-07-30T19:07:00Z'))).toBe(22 * 60 + 7);
  });
  test('переход через полночь по мск', () => {
    // 21:30 UTC 30 июля = 00:30 MSK 31 июля
    expect(nowMskMinutes(new Date('2026-07-30T21:30:00Z'))).toBe(30);
  });
});

describe('decideGate', () => {
  const base = { enabled: true, mode: 'all', allow: [], block: [], phone: '79200255591' };

  test('выключен → deny', () => {
    expect(decideGate({ ...base, enabled: false })).toEqual({ allow: false, reason: 'disabled' });
  });
  test('режим all пропускает незнакомый номер', () => {
    expect(decideGate({ ...base })).toEqual({ allow: true, reason: 'ok' });
  });
  test('чёрный список сильнее (даже в режиме all)', () => {
    expect(decideGate({ ...base, block: ['79200255591'] }))
      .toEqual({ allow: false, reason: 'blacklisted' });
  });
  test('whitelist: номер в белом (после 8→7) → allow', () => {
    expect(decideGate({ ...base, mode: 'whitelist', allow: ['79200255591'], phone: '89200255591' }))
      .toEqual({ allow: true, reason: 'ok' });
  });
  test('whitelist: номера нет в белом → deny', () => {
    expect(decideGate({ ...base, mode: 'whitelist', allow: ['79990001122'] }))
      .toEqual({ allow: false, reason: 'not-whitelisted' });
  });
  test('whitelist: пустой номер (Telegram chat_id) → deny', () => {
    expect(decideGate({ ...base, mode: 'whitelist', allow: ['79200255591'], phone: '' }))
      .toEqual({ allow: false, reason: 'not-whitelisted' });
  });
  test('чёрный список срабатывает и в whitelist', () => {
    expect(decideGate({ ...base, mode: 'whitelist', allow: ['79200255591'], block: ['79200255591'] }))
      .toEqual({ allow: false, reason: 'blacklisted' });
  });
});

describe('decideGate + расписание', () => {
  // Окно 22:00–09:30 мск. 23:00 = 1380 внутри, 12:00 = 720 вне.
  const sched = {
    enabled: true, mode: 'all', allow: [], block: [], phone: '79200255591',
    scheduleEnabled: true, scheduleStart: '22:00', scheduleEnd: '09:30',
  };

  test('внутри окна режим «Всем» пропускает незнакомый номер', () => {
    expect(decideGate({ ...sched, nowMinutes: 1380 }))
      .toEqual({ allow: true, reason: 'ok' });
  });
  test('вне окна незнакомый номер отсекается с reason outside-schedule', () => {
    expect(decideGate({ ...sched, nowMinutes: 720 }))
      .toEqual({ allow: false, reason: 'outside-schedule' });
  });
  test('вне окна номер из белого списка проходит (тестовые номера круглосуточно)', () => {
    expect(decideGate({ ...sched, nowMinutes: 720, allow: ['79200255591'] }))
      .toEqual({ allow: true, reason: 'ok' });
  });
  test('вне окна белый список нормализуется (8→7)', () => {
    expect(decideGate({ ...sched, nowMinutes: 720, allow: ['79200255591'], phone: '89200255591' }))
      .toEqual({ allow: true, reason: 'ok' });
  });
  test('чёрный список сильнее расписания (внутри окна)', () => {
    expect(decideGate({ ...sched, nowMinutes: 1380, block: ['79200255591'] }))
      .toEqual({ allow: false, reason: 'blacklisted' });
  });
  test('выключенный агент сильнее расписания', () => {
    expect(decideGate({ ...sched, enabled: false, nowMinutes: 1380 }))
      .toEqual({ allow: false, reason: 'disabled' });
  });
  test('scheduleEnabled=false → расписание не влияет, вне окна отвечаем всем', () => {
    expect(decideGate({ ...sched, scheduleEnabled: false, nowMinutes: 720 }))
      .toEqual({ allow: true, reason: 'ok' });
  });
  test('битый формат времени → расписание игнорируется (не молчание на сутки)', () => {
    expect(decideGate({ ...sched, scheduleStart: '', nowMinutes: 720 }))
      .toEqual({ allow: true, reason: 'ok' });
    expect(decideGate({ ...sched, scheduleEnd: '9:3', nowMinutes: 720 }))
      .toEqual({ allow: true, reason: 'ok' });
  });
  test('нет nowMinutes → расписание игнорируется', () => {
    expect(decideGate({ ...sched })).toEqual({ allow: true, reason: 'ok' });
  });
  test('режим whitelist: расписание ничего не меняет, reason остаётся not-whitelisted', () => {
    expect(decideGate({ ...sched, mode: 'whitelist', nowMinutes: 720 }))
      .toEqual({ allow: false, reason: 'not-whitelisted' });
    expect(decideGate({ ...sched, mode: 'whitelist', nowMinutes: 1380 }))
      .toEqual({ allow: false, reason: 'not-whitelisted' });
  });
  test('вне окна пустой номер (Telegram chat_id) → deny', () => {
    expect(decideGate({ ...sched, nowMinutes: 720, allow: ['79200255591'], phone: '' }))
      .toEqual({ allow: false, reason: 'outside-schedule' });
  });
});
