'use strict';
// Подстановки в текст напоминания. Ключевой инвариант — {first_name} идёт через
// общий resolveGivenName: на боевой базе PERI 73.5% карточек это «Фамилия Имя
// Отчество» одной строкой, и «первое слово» дало бы клиенту «Вихарева, пора
// повторить процедуру».
const { renderReminderText, pickTierText } = require('./services/reminders/template');

describe('renderReminderText', () => {
  test('подставляет личное имя, а не фамилию', () => {
    const out = renderReminderText('{first_name}, пора повторить!', { name: 'Вихарева Мария Андреевна' });
    expect(out).toBe('Мария, пора повторить!');
  });

  test('имя не опознано → осиротевшая запятая схлопывается', () => {
    const out = renderReminderText('{first_name}, пора повторить!', { name: '89201234567' });
    expect(out).toBe('Пора повторить!');
  });

  test('подставляет бонусы, баланс, услугу, мастера и срок', () => {
    const out = renderReminderText(
      '{услуга} у {мастер} была {дней} дн. назад. Начислили {бонусы}, всего {баланс}. {салон}',
      { service: 'Лазерная эпиляция', staff: 'Юлия', days: 30, accrued: 300, balance: 800, salon: 'PERI CLINIC' });
    expect(out).toBe('Лазерная эпиляция у Юлия была 30 дн. назад. Начислили 300, всего 800. PERI CLINIC');
  });

  // Ноль — валидное значение и обязан отрендериться как «0», а не исчезнуть:
  // «на вашей карте 0 бонусов» это осмысленная фраза, «на вашей карте бонусов» — нет.
  test('нулевые числа подставляются, отсутствующие — пустой строкой', () => {
    expect(renderReminderText('{баланс}|{бонусы}', { balance: 0, accrued: 0 })).toBe('0|0');
    expect(renderReminderText('{баланс}|{бонусы}', {})).toBe('|');
  });

  test('пустой шаблон → пустая строка', () => {
    expect(renderReminderText('', { name: 'Мария' })).toBe('');
    expect(renderReminderText(null, {})).toBe('');
  });
});

describe('pickTierText', () => {
  test('текст ступени побеждает базовый', () => {
    expect(pickTierText({ text: 'ступень' }, 'база')).toBe('ступень');
  });

  // Пустой текст ступени означает «взять базовый текст правила» — это
  // единственный способ настроить ступень 'none', не дублируя основной текст.
  test('пустой текст ступени → базовый текст правила', () => {
    expect(pickTierText({ text: '' }, 'база')).toBe('база');
    expect(pickTierText({ text: '   ' }, 'база')).toBe('база');
    expect(pickTierText(null, 'база')).toBe('база');
  });
});
