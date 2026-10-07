'use strict';

const { SCENARIOS, detectPromptScenarios } = require('./services/agent/prompt-scenarios');

describe('detectPromptScenarios', () => {
  test('определяет несколько независимых намерений последнего сообщения', () => {
    expect(detectPromptScenarios('Сколько стоит чистка и можно записаться завтра?'))
      .toEqual([SCENARIOS.BOOKING, SCENARIOS.PRICE]);
  });

  test('перенос не теряет сценарий записи', () => {
    expect(detectPromptScenarios('Перенесите, пожалуйста, мою запись на пятницу'))
      .toEqual([SCENARIOS.MANAGE_BOOKING]);
  });

  test('неясное сообщение получает безопасный общий сценарий', () => {
    expect(detectPromptScenarios('Здравствуйте')).toEqual([SCENARIOS.GENERAL]);
    expect(detectPromptScenarios(null)).toEqual([SCENARIOS.GENERAL]);
  });

  test('сомнение и нерешительность — отдельные сценарии', () => {
    expect(detectPromptScenarios('Дорого как-то, подумаю')).toEqual([SCENARIOS.OBJECTION]);
    expect(detectPromptScenarios('Спасибо, напишу сама')).toEqual([SCENARIOS.OBJECTION]);
    expect(detectPromptScenarios('Пока сравниваю с другой клиникой')).toEqual([SCENARIOS.OBJECTION]);
    expect(detectPromptScenarios('Не знаю, что выбрать, хочу выглядеть свежее'))
      .toEqual([SCENARIOS.UNDECIDED]);
    expect(detectPromptScenarios('Посоветуйте, что подойдёт для лица'))
      .toEqual([SCENARIOS.UNDECIDED]);
  });

  test('«дорого, но запишите» несёт и сомнение, и запись — приоритет решает модуль', () => {
    expect(detectPromptScenarios('Дорого, но меня устраивает — запишите на пятницу'))
      .toEqual([SCENARIOS.BOOKING, SCENARIOS.OBJECTION]);
  });

  test('«доброе утро» и «подготовка» не считаются сомнением', () => {
    expect(detectPromptScenarios('Доброе утро! Подскажите адрес')).toEqual([SCENARIOS.CLINIC]);
    expect(detectPromptScenarios('Какая подготовка нужна?')).toEqual([SCENARIOS.MEDICAL]);
  });

  test('отрицание перед «дорого»/«сомнева» — не сомнение', () => {
    expect(detectPromptScenarios('А это не дорого?')).not.toContain(SCENARIOS.OBJECTION);
    expect(detectPromptScenarios('Вроде не очень дорого')).not.toContain(SCENARIOS.OBJECTION);
    expect(detectPromptScenarios('Не сомневаюсь, запишите')).not.toContain(SCENARIOS.OBJECTION);
    expect(detectPromptScenarios('Не сомневайтесь')).not.toContain(SCENARIOS.OBJECTION);
    // «не» как часть слова отрицанием не считается
    expect(detectPromptScenarios('Мне дорого')).toEqual([SCENARIOS.OBJECTION]);
    expect(detectPromptScenarios('Сомневаюсь пока')).toEqual([SCENARIOS.OBJECTION]);
  });
});
