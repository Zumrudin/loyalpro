'use strict';
const kb = require('./services/kb-assistant');

describe('callAitunnel', () => {
  test('шлёт system+user, возвращает content из choices[0]', async () => {
    const calls = [];
    const fakeClient = { chat: { completions: { create: async (p) => {
      calls.push(p);
      return { choices: [{ message: { content: '  Ответ из базы.  ' } }] };
    } } } };
    const out = await kb.callAitunnel({ system: 'S', user: 'U' }, { client: fakeClient });
    expect(out).toBe('Ответ из базы.');
    expect(calls[0].messages).toEqual([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);
    expect(calls[0].temperature).toBe(0.2);
  });
});

describe('embedTextAitunnel', () => {
  test('возвращает вектор из data[0].embedding, шлёт dimensions', async () => {
    const calls = [];
    const fakeClient = { embeddings: { create: async (p) => {
      calls.push(p);
      return { data: [{ embedding: [0.1, 0.2, 0.3] }] };
    } } };
    const vec = await kb.embedTextAitunnel('текст', { client: fakeClient });
    expect(vec).toEqual([0.1, 0.2, 0.3]);
    expect(calls[0].input).toBe('текст');
    expect(typeof calls[0].dimensions).toBe('number');
  });

  test('пустой ответ → бросает', async () => {
    const fakeClient = { embeddings: { create: async () => ({ data: [] }) } };
    await expect(kb.embedTextAitunnel('x', { client: fakeClient })).rejects.toThrow(/пустой ответ/);
  });
});
