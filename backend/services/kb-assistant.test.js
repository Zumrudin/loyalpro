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

const kb = require('./kb-assistant');

describe('callGemini (dual-key fallback)', () => {
  const prompt = { system: 'S', user: 'U' };
  const okJson = { candidates: [{ content: { parts: [{ text: 'Ответ.' }] } }] };

  function fakeFetch(sequence) {
    // sequence: массив { status, json } по порядку вызовов
    let i = 0;
    return async () => {
      const r = sequence[i++] || sequence[sequence.length - 1];
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => r.json || {},
      };
    };
  }

  test('free-ключ отвечает 200 → paid не зовём', async () => {
    const calls = [];
    const fetchFn = async (url) => { calls.push(url); return (fakeFetch([{ status: 200, json: okJson }]))(); };
    const text = await kb.callGemini(prompt, { free: 'FREE', paid: 'PAID', model: 'm', fetchFn });
    expect(text).toBe('Ответ.');
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('FREE');
  });

  test('free возвращает 429 → ретрай на paid-ключе', async () => {
    const calls = [];
    const seq = [{ status: 429 }, { status: 200, json: okJson }];
    let i = 0;
    const fetchFn = async (url) => {
      calls.push(url);
      const r = seq[i++];
      return { ok: r.status < 300, status: r.status, json: async () => r.json || {} };
    };
    const text = await kb.callGemini(prompt, { free: 'FREE', paid: 'PAID', model: 'm', fetchFn });
    expect(text).toBe('Ответ.');
    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('PAID');
  });

  test('оба ключа 429 → бросает ошибку', async () => {
    const fetchFn = async () => ({ ok: false, status: 429, json: async () => ({}) });
    await expect(kb.callGemini(prompt, { free: 'FREE', paid: 'PAID', model: 'm', fetchFn }))
      .rejects.toThrow();
  });

  test('только paid задан → сразу платный, без free-ступени', async () => {
    const calls = [];
    const fetchFn = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => okJson }; };
    const text = await kb.callGemini(prompt, { free: '', paid: 'PAID', model: 'm', fetchFn });
    expect(text).toBe('Ответ.');
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('PAID');
  });

  test('ни одного ключа → бросает ошибку', async () => {
    await expect(kb.callGemini(prompt, { free: '', paid: '', model: 'm', fetchFn: async () => ({}) }))
      .rejects.toThrow();
  });
});
