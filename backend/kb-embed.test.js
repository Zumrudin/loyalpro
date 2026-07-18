'use strict';

const kb = require('./services/kb-assistant');

function fakeFetch(payload, ok = true, status = 200) {
  return async () => ({ ok, status, json: async () => payload });
}

describe('embedContentOnce', () => {
  test('парсит embedding.values', async () => {
    const fetchFn = fakeFetch({ embedding: { values: [0.1, 0.2, 0.3] } });
    const vec = await kb.embedContentOnce('привет', { key: 'K', model: 'text-embedding-004', fetchFn });
    expect(vec).toEqual([0.1, 0.2, 0.3]);
  });

  test('не-2xx бросает ошибку со status', async () => {
    const fetchFn = fakeFetch({}, false, 429);
    await expect(kb.embedContentOnce('x', { key: 'K', model: 'm', fetchFn }))
      .rejects.toMatchObject({ status: 429 });
  });
});

describe('embedTextDirect', () => {
  test('фолбэк на второй ключ при ошибке первого', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ embedding: { values: [1, 2] } }) };
    };
    const vec = await kb.embedTextDirect('x', { free: 'F', paid: 'P', model: 'm', fetchFn });
    expect(vec).toEqual([1, 2]);
    expect(calls).toBe(2);
  });
});
