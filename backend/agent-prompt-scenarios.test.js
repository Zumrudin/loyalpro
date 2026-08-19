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
});
