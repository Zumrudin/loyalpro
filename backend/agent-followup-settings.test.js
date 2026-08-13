'use strict';

// Проверяем ЧИСТУЮ часть: нормализацию тела запроса. Работа с БД (INSERT …
// ON CONFLICT) в юните не нужна — её покрывает живой прогон настроек.
const { pickFollowup } = require('./services/agent-settings');

const cur = {
  followupDelay1Min: 15, followupDelay2Min: 60,
  followupFinalText: 'старый текст', followupLatestTime: '03:00',
};

describe('pickFollowup', () => {
  // ГОТЧА контракта роута: PUT /api/agent/settings трактует ОТСУТСТВИЕ
  // enabled/mode как «выключено». Новые поля обязаны вести себя иначе, иначе
  // сохранение одного интервала гасило бы остальные настройки.
  test('поле не передано → остаётся текущее значение', () => {
    expect(pickFollowup({}, cur)).toEqual(cur);
    expect(pickFollowup({ followupDelay1Min: null }, cur).followupDelay1Min).toBe(15);
  });

  test('явный 0 — законное «не напоминать»', () => {
    expect(pickFollowup({ followupDelay1Min: 0 }, cur).followupDelay1Min).toBe(0);
  });

  test('пустая строка в тексте — осознанная очистка', () => {
    expect(pickFollowup({ followupFinalText: '' }, cur).followupFinalText).toBe(null);
  });

  test('пустая строка во времени — снять верхнюю границу', () => {
    expect(pickFollowup({ followupLatestTime: '' }, cur).followupLatestTime).toBe(null);
  });

  test('корректное время сохраняется', () => {
    expect(pickFollowup({ followupLatestTime: '22:30' }, cur).followupLatestTime).toBe('22:30');
  });

  test('битое время → BAD_FOLLOWUP_TIME', () => {
    expect(() => pickFollowup({ followupLatestTime: '25:00' }, cur)).toThrow(
      expect.objectContaining({ code: 'BAD_FOLLOWUP_TIME' }));
  });

  test('нечисловой или отрицательный интервал → BAD_FOLLOWUP', () => {
    expect(() => pickFollowup({ followupDelay1Min: -5 }, cur)).toThrow(
      expect.objectContaining({ code: 'BAD_FOLLOWUP' }));
    expect(() => pickFollowup({ followupDelay2Min: 'час' }, cur)).toThrow(
      expect.objectContaining({ code: 'BAD_FOLLOWUP' }));
  });

  test('финал не позже напоминания → BAD_FOLLOWUP (при включённой фиче)', () => {
    expect(() => pickFollowup({ followupDelay1Min: 30, followupDelay2Min: 30 }, cur)).toThrow(
      expect.objectContaining({ code: 'BAD_FOLLOWUP' }));
  });

  test('текст режется по потолку', () => {
    const long = 'а'.repeat(2000);
    expect(pickFollowup({ followupFinalText: long }, cur).followupFinalText.length).toBe(1200);
  });

  // Ноль — валидное сохранённое значение, а не «поле не передано». Подмена
  // дефолтом самоусиливается: updateSettings читает cur через getSettings.
  test('сохранённый ноль во втором интервале не подменяется дефолтом', () => {
    const zero = { ...cur, followupDelay1Min: 0, followupDelay2Min: 0 };
    expect(pickFollowup({}, zero).followupDelay2Min).toBe(0);
  });

  test('булево, массив и объект интервалом не считаются', () => {
    for (const bad of [true, [15], { min: 15 }]) {
      expect(() => pickFollowup({ followupDelay1Min: bad }, cur)).toThrow(
        expect.objectContaining({ code: 'BAD_FOLLOWUP' }));
    }
  });
});
