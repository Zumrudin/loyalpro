'use strict';

const { stripRepeatedTitles, namesWithTitle } = require('./services/agent/title-dedup');

describe('namesWithTitle', () => {
  test('собирает стемы имён, у которых должность уже звучала', () => {
    const seen = namesWithTitle('Вас примет косметолог-эстетист Юлия в 12:00. Главный врач Пери Исамудиновна ведёт приём.');
    expect(seen.has('Юлия'.slice(0, 4))).toBe(true);
    expect(seen.has('Пери')).toBe(true);
  });
  test('пусто на тексте без пар', () => {
    expect(namesWithTitle('Здравствуйте! Чем могу помочь?').size).toBe(0);
  });
});

describe('stripRepeatedTitles', () => {
  const prior = 'Завтра свободна косметолог-эстетист Юлия.';

  test('повтор должности срезается, имя с падежом остаётся', () => {
    const { replies, stripped } = stripRepeatedTitles(
      ['Записала вас к косметологу-эстетисту Юлии на 12:00.'], prior);
    expect(replies).toEqual(['Записала вас к Юлии на 12:00.']);
    expect(stripped).toHaveLength(1);
  });

  test('первое упоминание ДРУГОГО специалиста не трогается', () => {
    const { replies, stripped } = stripRepeatedTitles(
      ['Эту процедуру ведёт главный врач Пери Исамудиновна.'], prior);
    expect(replies).toEqual(['Эту процедуру ведёт главный врач Пери Исамудиновна.']);
    expect(stripped).toHaveLength(0);
  });

  test('прошлых пар нет → реплики нетронуты', () => {
    const { replies } = stripRepeatedTitles(['косметолог-эстетист Юлия свободна'], 'Добрый день!');
    expect(replies).toEqual(['косметолог-эстетист Юлия свободна']);
  });

  test('склонение должности тоже ловится в прошлом тексте', () => {
    const { replies } = stripRepeatedTitles(
      ['Вас ждёт косметолог-эстетист Юлия.'],
      'Я записала вас к косметологу-эстетисту Юлии.');
    expect(replies).toEqual(['Вас ждёт Юлия.']);
  });
});
