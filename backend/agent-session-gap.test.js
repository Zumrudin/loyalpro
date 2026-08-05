'use strict';

const { detectSession } = require('./services/agent/session-gap');

const H = 3600;
// Базовое время — произвольная точка, важны только разрывы между сообщениями.
const T = 1_785_900_000;

const inc = (ts, text = 'x') => ({ direction: 'incoming', text, msg_ts: ts });
const out = (ts, text = 'y') => ({ direction: 'outgoing', text, msg_ts: ts });

describe('detectSession', () => {
  test('разрыв больше 6 часов → новая переписка, разрыв словами', () => {
    const r = detectSession([out(T - 7 * 24 * H), inc(T)]);
    expect(r).toEqual({ newSession: true, gapText: '7 дней' });
  });

  test('разрыв меньше 6 часов → та же переписка', () => {
    const r = detectSession([out(T - 5 * H), inc(T)]);
    expect(r).toEqual({ newSession: false, gapText: null });
  });

  test('ровно 6 часов → уже новая переписка (порог включительно)', () => {
    expect(detectSession([out(T - 6 * H), inc(T)]).newSession).toBe(true);
  });

  // Ради этого кейса и написан модуль: после долгого молчания клиент пишет
  // серию сообщений подряд, и разрыв между ДВУМЯ ПОСЛЕДНИМИ — секунды.
  test('серия сообщений подряд после молчания: разрыв меряется до начала серии', () => {
    const rows = [out(T - 7 * 24 * H), inc(T - 20), inc(T - 10), inc(T)];
    expect(detectSession(rows)).toEqual({ newSession: true, gapText: '7 дней' });
  });

  test('серия внутри живого разговора новой перепиской не считается', () => {
    const rows = [out(T - 120), inc(T - 20), inc(T)];
    expect(detectSession(rows).newSession).toBe(false);
  });

  // Задержанное эхо Chatpush получает msg_ts ПОЗЖЕ нового входящего
  // (см. комментарий в history.js) — хвостовая строка может быть outgoing.
  test('задержанное эхо в хвосте не ломает счёт: меряем до серии клиента', () => {
    const rows = [out(T - 7 * 24 * H), inc(T), out(T + 60)];
    expect(detectSession(rows)).toEqual({ newSession: true, gapText: '7 дней' });
  });

  test('единственное сообщение в истории → новая переписка', () => {
    expect(detectSession([inc(T)])).toEqual({ newSession: true, gapText: null });
  });

  test('пустая история → новая переписка', () => {
    expect(detectSession([])).toEqual({ newSession: true, gapText: null });
  });

  test('в окне только сообщения клиента → новая переписка', () => {
    expect(detectSession([inc(T - 10), inc(T)]).newSession).toBe(true);
  });

  test('входящих в окне нет вовсе → не новая переписка', () => {
    expect(detectSession([out(T - 10), out(T)])).toEqual({ newSession: false, gapText: null });
  });

  test('битый msg_ts → не новая переписка (fail-safe, лишнего приветствия не даём)', () => {
    expect(detectSession([out(null), inc(T)])).toEqual({ newSession: false, gapText: null });
  });

  test('порог настраивается', () => {
    expect(detectSession([out(T - 3 * H), inc(T)], { gapHours: 2 }).newSession).toBe(true);
  });

  describe('склонение разрыва', () => {
    const gap = (sec) => detectSession([out(T - sec), inc(T)]).gapText;
    test('часы: 6/7/21', () => {
      expect(gap(6 * H)).toBe('6 часов');
      expect(gap(7 * H)).toBe('7 часов');
      expect(gap(21 * H)).toBe('21 час');
    });
    test('до 48 часов считаем в часах', () => {
      expect(gap(47 * H)).toBe('47 часов');
    });
    test('от 48 часов — в сутках, округление вниз', () => {
      expect(gap(48 * H)).toBe('2 дня');
      expect(gap(71 * H)).toBe('2 дня');
      expect(gap(5 * 24 * H)).toBe('5 дней');
      expect(gap(21 * 24 * H)).toBe('21 день');
    });
  });
});
