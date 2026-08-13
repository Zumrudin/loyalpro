'use strict';

const {
  resolveDelays, nextAtFor, isTooLate,
  DEFAULT_DELAY1_MIN, DEFAULT_DELAY2_MIN,
} = require('./services/agent/followup-schedule');

describe('resolveDelays', () => {
  test('нули и мусор → фича выключена', () => {
    expect(resolveDelays({ followupDelay1Min: 0, followupDelay2Min: 60 }).enabled).toBe(false);
    expect(resolveDelays({}).enabled).toBe(false);
    expect(resolveDelays({ followupDelay1Min: 'нет', followupDelay2Min: 60 }).enabled).toBe(false);
  });

  test('нормальные значения проходят как есть', () => {
    expect(resolveDelays({ followupDelay1Min: 15, followupDelay2Min: 60 }))
      .toEqual({ enabled: true, delay1: 15, delay2: 60 });
  });

  // Второй интервал меряется от ЯКОРЯ, а не от первого напоминания. Значение,
  // не превышающее первый, означало бы «финал раньше напоминания» — берём
  // безопасный дефолт, а не отправляем два сообщения подряд.
  test('второй интервал не больше первого → дефолт', () => {
    expect(resolveDelays({ followupDelay1Min: 30, followupDelay2Min: 20 }))
      .toEqual({ enabled: true, delay1: 30, delay2: DEFAULT_DELAY2_MIN });
  });

  // Плоский дефолт 60 сам нарушил бы инвариант «финал позже напоминания»,
  // когда первый интервал уже больше часа. Ветка защиты от испорченных данных.
  test('первый интервал ≥ 60 и битый второй → дефолт прибавляется к первому', () => {
    expect(resolveDelays({ followupDelay1Min: 90 }))
      .toEqual({ enabled: true, delay1: 90, delay2: 150 });
  });

  test('граничный случай: первый интервал ровно 60', () => {
    expect(resolveDelays({ followupDelay1Min: 60 }))
      .toEqual({ enabled: true, delay1: 60, delay2: 120 });
  });
});

describe('nextAtFor', () => {
  const anchor = new Date('2026-08-11T10:00:00.000Z');

  test('stage 0 → якорь + первый интервал', () => {
    expect(nextAtFor({ anchorAt: anchor, stage: 0, delay1Min: 15, delay2Min: 60 }).toISOString())
      .toBe('2026-08-11T10:15:00.000Z');
  });

  test('stage 1 → якорь + второй интервал (не «плюс 60 к напоминанию»)', () => {
    expect(nextAtFor({ anchorAt: anchor, stage: 1, delay1Min: 15, delay2Min: 60 }).toISOString())
      .toBe('2026-08-11T11:00:00.000Z');
  });

  test('stage 2 — финал уже отправлен, срока больше нет', () => {
    expect(nextAtFor({ anchorAt: anchor, stage: 2, delay1Min: 15, delay2Min: 60 })).toBeNull();
  });

  test('битый якорь → null, а не Invalid Date в БД', () => {
    expect(nextAtFor({ anchorAt: 'вчера', stage: 0, delay1Min: 15, delay2Min: 60 })).toBeNull();
  });
});

describe('isTooLate', () => {
  // 21:30 мск = 18:30 UTC.
  const at = new Date('2026-08-11T18:30:00.000Z');

  test('пустая граница → ограничения нет', () => {
    expect(isTooLate(at, null)).toBe(false);
    expect(isTooLate(at, '')).toBe(false);
  });

  test('позже границы → поздно', () => {
    expect(isTooLate(at, '21:00')).toBe(true);
  });

  test('ровно на границе → ещё можно (граница включающая)', () => {
    expect(isTooLate(at, '21:30')).toBe(false);
  });

  test('раньше границы → можно', () => {
    expect(isTooLate(at, '22:00')).toBe(false);
  });

  // Битая граница не должна МОЛЧА запрещать напоминания: fail-open в прежнее
  // поведение — тот же принцип, что у расписания в agent-gate.
  test('битая граница игнорируется', () => {
    expect(isTooLate(at, '25:99')).toBe(false);
    expect(isTooLate(at, 'вечером')).toBe(false);
  });
});

describe('константы дефолтов', () => {
  test('совпадают с рекомендованными значениями формы', () => {
    expect(DEFAULT_DELAY1_MIN).toBe(15);
    expect(DEFAULT_DELAY2_MIN).toBe(60);
  });
});
