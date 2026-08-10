'use strict';

const { detectRating, parseRating, buildThanks, buildApology } =
  require('./services/agent/visit-rating');

describe('parseRating', () => {
  test('чистая цифра 2–5', () => {
    expect(parseRating('5')).toBe(5);
    expect(parseRating('2')).toBe(2);
    expect(parseRating(' 4 ')).toBe(4);
  });
  test('цифра с пунктуацией и эмодзи', () => {
    expect(parseRating('5!')).toBe(5);
    expect(parseRating('5)')).toBe(5);
    expect(parseRating('5 ❤️')).toBe(5);
    expect(parseRating('⭐ 5')).toBe(5);
  });
  test('метка времени транскрипта срезается', () => {
    expect(parseRating('[10.08 09:09] 5')).toBe(5);
  });
  test('НЕ оценка: цифра вне 2–5, слова рядом, несколько цифр', () => {
    expect(parseRating('1')).toBe(null);
    expect(parseRating('6')).toBe(null);
    expect(parseRating('5 отлично')).toBe(null);
    expect(parseRating('5 из 5')).toBe(null);
    expect(parseRating('запишите на 5')).toBe(null);
    expect(parseRating('55')).toBe(null);
    expect(parseRating('')).toBe(null);
  });
});

describe('detectRating', () => {
  test('последний блок — user с чистой цифрой → рейтинг', () => {
    const messages = [
      { role: 'assistant', content: '[09.08 12:00] Записала вас' },
      { role: 'user', content: '[10.08 09:09] 5' },
    ];
    expect(detectRating(messages)).toBe(5);
  });
  test('серия из нескольких строк с цифрой И словами → null (пусть решает LLM)', () => {
    expect(detectRating([{ role: 'user', content: '[10.08 09:09] 5\n[10.08 09:10] и запишите ещё' }])).toBe(null);
  });
  test('последний блок не user → null', () => {
    expect(detectRating([{ role: 'user', content: '5' }, { role: 'assistant', content: 'ок' }])).toBe(null);
    expect(detectRating([])).toBe(null);
    expect(detectRating(null)).toBe(null);
  });
});

describe('тексты ответов', () => {
  test('благодарность: с именем и без, без вопросов', () => {
    expect(buildThanks({ givenName: 'Марина' })).toMatch(/^Марина, /);
    expect(buildThanks({})).toMatch(/[Сс]пасибо/);
    expect(buildThanks({})).not.toContain('?');
    // Имя проходит sanitizeName: телефон вместо имени → ветка без имени.
    expect(buildThanks({ givenName: '+79001112233' })).not.toContain('7900');
  });
  test('извинение всегда содержит «администратор» (диспетчер не дошлёт вторую фразу перевода)', () => {
    expect(buildApology({ adminOff: false })).toMatch(/администратор/i);
    expect(buildApology({ adminOff: true })).toMatch(/администратор/i);
    // Ночью не обещаем «в ближайшее время» — как handoverText в admin-hours.
    expect(buildApology({ adminOff: true })).toMatch(/рабочего дня/i);
    expect(buildApology({ adminOff: false })).not.toMatch(/рабочего дня/i);
  });
});
