'use strict';

const { hasInventedTime, collectTimes } = require('./services/agent/followup-guard');

describe('collectTimes', () => {
  test('собирает все HH:MM', () => {
    expect(collectTimes('Есть 12:30 и 13:30, а также 9:00'))
      .toEqual(['12:30', '13:30', '9:00']);
  });

  test('дата и цена временем не считаются', () => {
    // 11.08 — дата, 2500 ₽ — цена: двоеточия нет, в набор не попадают.
    expect(collectTimes('11.08 приём стоит 2500 ₽')).toEqual([]);
  });

  test('диапазон «с 10:00 до 21:00» — оба конца законное время', () => {
    expect(collectTimes('с 10:00 до 21:00')).toEqual(['10:00', '21:00']);
  });

  test('часы/минуты вне диапазона суток временем не считаются', () => {
    expect(collectTimes('60:00 и 25:30')).toEqual([]);
  });

  test('время внутри более длинного числа не распознаётся', () => {
    // '12:345' — минут не ровно 2 цифры; '112:30' — часть числа '112'.
    expect(collectTimes('12:345 112:30 1:2')).toEqual([]);
  });

  test('точечная форма «14.30» — время (14 > 12)', () => {
    expect(collectTimes('Свободно в 14.30')).toEqual(['14.30']);
  });

  test('точечная форма «12.45» — время (45 > 12)', () => {
    expect(collectTimes('Встреча в 12.45')).toEqual(['12.45']);
  });

  test('не-строка не коэрсится в валидный текст', () => {
    expect(collectTimes(['12:30'])).toEqual([]);
  });
});

describe('hasInventedTime', () => {
  const prior = 'Свободно 12:30 и 13:30. Записать вас?';

  test('время из прошлых реплик Милы — законно', () => {
    expect(hasInventedTime('Подошло ли 12:30?', prior)).toBe(false);
  });

  test('новое время — выдумка', () => {
    expect(hasInventedTime('Могу предложить 15:00', prior)).toBe(true);
  });

  test('текст без времени всегда проходит', () => {
    expect(hasInventedTime('Подскажите, удобно ли вам записаться?', prior)).toBe(false);
  });

  // Ведущий ноль: модель пишет «9:00» там, где в выдаче было «09:00».
  test('9:00 и 09:00 — одно и то же время', () => {
    expect(hasInventedTime('Ждём в 9:00', 'Свободно 09:00')).toBe(false);
  });

  test('пустая история → любое время выдумано', () => {
    expect(hasInventedTime('в 12:00', '')).toBe(true);
    expect(hasInventedTime('в 12:00', null)).toBe(true);
  });

  test('выдуманное время в точечной форме ловится', () => {
    expect(hasInventedTime('в 15.00', 'Свободно 12:30')).toBe(true);
  });

  test('законное время в точечной форме — не выдумка', () => {
    expect(hasInventedTime('в 14.30', 'Свободно в 14.30')).toBe(false);
  });

  test('«11.08» в тексте — дата, не время, невидима guard\'у', () => {
    expect(hasInventedTime('Ждём вас 11.08', prior)).toBe(false);
  });

  test('не-строка в тексте напоминания — считаем время выдуманным', () => {
    expect(hasInventedTime(['15:00'], prior)).toBe(true);
  });

  test('не-строка в истории — разрешённых времён нет', () => {
    expect(hasInventedTime('в 12:30', ['12:30'])).toBe(true);
  });
});
