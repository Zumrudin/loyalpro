'use strict';

const {
  buildContext, buildPrompt, parseGeminiResponse,
} = require('./kb-assistant');

describe('buildContext', () => {
  test('склеивает статьи как ### title + body', () => {
    const ctx = buildContext([
      { id: 1, title: 'Отмена записи', body: 'Отменить можно за 24 часа.' },
      { id: 2, title: 'Опоздание',     body: 'Ждём 15 минут.' },
    ]);
    expect(ctx).toContain('### Отмена записи');
    expect(ctx).toContain('Отменить можно за 24 часа.');
    expect(ctx).toContain('### Опоздание');
  });

  test('обрезает контекст по бюджету символов', () => {
    const big = { id: 1, title: 'T', body: 'x'.repeat(20000) };
    const ctx = buildContext([big], 5000);
    expect(ctx.length).toBeLessThanOrEqual(5000);
  });

  test('пустой список → пустая строка', () => {
    expect(buildContext([])).toBe('');
  });
});

describe('buildPrompt', () => {
  test('возвращает system и user, вопрос и контекст внутри user', () => {
    const p = buildPrompt('Как отменить запись?', '### Отмена\nЗа 24 часа.');
    expect(p.system).toMatch(/только/i);
    expect(p.user).toContain('Как отменить запись?');
    expect(p.user).toContain('За 24 часа.');
  });
});

describe('parseGeminiResponse', () => {
  test('достаёт текст из candidates[0].content.parts', () => {
    const json = { candidates: [{ content: { parts: [{ text: 'Ответ.' }] } }] };
    expect(parseGeminiResponse(json)).toBe('Ответ.');
  });

  test('склеивает несколько parts', () => {
    const json = { candidates: [{ content: { parts: [{ text: 'A' }, { text: 'B' }] } }] };
    expect(parseGeminiResponse(json)).toBe('AB');
  });

  test('нет кандидатов → пустая строка', () => {
    expect(parseGeminiResponse({})).toBe('');
    expect(parseGeminiResponse({ candidates: [] })).toBe('');
  });
});
