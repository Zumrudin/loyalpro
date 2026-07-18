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

  test('пустой ответ на всех попытках → ретраит attempts раз и бросает', async () => {
    let n = 0;
    const fakeClient = { embeddings: { create: async () => { n++; return { data: [] }; } } };
    await expect(kb.embedTextAitunnel('x', { client: fakeClient, attempts: 3, sleepFn: () => Promise.resolve() }))
      .rejects.toThrow(/пустой ответ/);
    expect(n).toBe(3);
  });

  test('транзиентный пустой ответ → ретрай и успех', async () => {
    let n = 0;
    const fakeClient = { embeddings: { create: async () => {
      n++;
      return n < 2 ? { data: [] } : { data: [{ embedding: [0.5, 0.6] }] };
    } } };
    const vec = await kb.embedTextAitunnel('x', { client: fakeClient, sleepFn: () => Promise.resolve() });
    expect(vec).toEqual([0.5, 0.6]);
    expect(n).toBe(2);
  });

  test('брошенная ошибка вызова → ретрай и успех', async () => {
    let n = 0;
    const fakeClient = { embeddings: { create: async () => {
      n++;
      if (n < 2) throw new Error('429 Too Many Requests');
      return { data: [{ embedding: [1, 2, 3] }] };
    } } };
    const vec = await kb.embedTextAitunnel('x', { client: fakeClient, sleepFn: () => Promise.resolve() });
    expect(vec).toEqual([1, 2, 3]);
    expect(n).toBe(2);
  });
});
