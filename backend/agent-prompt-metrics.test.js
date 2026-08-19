'use strict';

const { countHeadings, measurePrompt } = require('./services/agent/prompt-metrics');

describe('prompt-metrics', () => {
  test('считает размер, строки, заголовки и помеченную оценку токенов', () => {
    const metrics = measurePrompt('РОЛЬ:\nТекст\n\nФАКТЫ:\n- факт');
    expect(metrics).toEqual({ chars: 26, lines: 5, headings: 2, estimatedTokens: 8 });
  });

  test('пустой промпт имеет нулевые метрики', () => {
    expect(measurePrompt('')).toEqual({ chars: 0, lines: 0, headings: 0, estimatedTokens: 0 });
    expect(countHeadings(null)).toBe(0);
  });
});
