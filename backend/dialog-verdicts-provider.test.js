// backend/dialog-verdicts-provider.test.js
'use strict';
// Цепочка провайдеров анализа: те же звенья, что у Милы (resilient.js), но БЕЗ
// чтения и записи agent_model_routing — падение ночного анализа не должно
// переключать Милу на резервную модель.
jest.mock('./services/agent/model-routing', () => { throw new Error('model-routing не должен импортироваться'); });

const { createVerdictProvider, buildChain, BUSY_CODES } = require('./services/dialog-verdicts/provider');

const err = (code) => Object.assign(new Error(code), { code });
const okRes = (model) => ({ text: '{"verdicts":[]}', toolCalls: [], model });
const link = (name, impl) => ({ name, createMessage: jest.fn(impl) });

describe('buildChain', () => {
  const links = { gpt: 'G', claude: 'C', polza: 'P', codex: 'X' };
  test('прод (codex-relay): gpt → claude → polza', () => {
    expect(buildChain('codex-relay', links)).toEqual(['G', 'C', 'P']);
  });
  test('дев (codex): codex → polza', () => {
    expect(buildChain('codex', links)).toEqual(['X', 'P']);
  });
  test('прочее: только polza', () => {
    expect(buildChain('polza', links)).toEqual(['P']);
    expect(buildChain('aitunnel', links)).toEqual(['P']);
  });
});

describe('createVerdictProvider', () => {
  const req = { system: 's', messages: [{ role: 'user', content: 'u' }], tools: [] };

  test('первое звено ответило — остальные не трогаются, модель возвращается', async () => {
    const a = link('a', async () => okRes('gpt-6-sol')), b = link('b', async () => okRes('x'));
    const p = createVerdictProvider({ chain: [a, b], sleep: async () => {} });
    const r = await p.createMessage(req);
    expect(r.model).toBe('gpt-6-sol');
    expect(b.createMessage).not.toHaveBeenCalled();
  });

  test('ошибка звена → следующее звено; пустой текст считается ошибкой', async () => {
    const a = link('a', async () => { throw err('RELAY_MODEL_FAILED'); });
    const b = link('b', async () => ({ text: '  ', toolCalls: [], model: 'c' }));
    const c = link('c', async () => okRes('polza-model'));
    const r = await createVerdictProvider({ chain: [a, b, c], sleep: async () => {} }).createMessage(req);
    expect(r.model).toBe('polza-model');
  });

  test('BUSY → пауза и один повтор на том же звене', async () => {
    let n = 0;
    const a = link('a', async () => { if (n++ === 0) throw err('CODEX_BUSY'); return okRes('m'); });
    const sleep = jest.fn(async () => {});
    const r = await createVerdictProvider({ chain: [a], sleep, busyWaitMs: 123 }).createMessage(req);
    expect(r.model).toBe('m');
    expect(a.createMessage).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(123);
    expect(BUSY_CODES).toEqual(expect.arrayContaining(['CODEX_BUSY', 'RELAY_BUSY']));
  });

  test('второй BUSY подряд → дальше по цепочке', async () => {
    const a = link('a', async () => { throw err('RELAY_BUSY'); });
    const b = link('b', async () => okRes('fallback'));
    const r = await createVerdictProvider({ chain: [a, b], sleep: async () => {} }).createMessage(req);
    expect(a.createMessage).toHaveBeenCalledTimes(2);
    expect(r.model).toBe('fallback');
  });

  test('все звенья упали → ошибка VERDICT_PROVIDER_FAILED с последней причиной', async () => {
    const a = link('a', async () => { throw err('RELAY_UPSTREAM'); });
    const b = link('b', async () => { throw new Error('polza down'); });
    await expect(createVerdictProvider({ chain: [a, b], sleep: async () => {} }).createMessage(req))
      .rejects.toMatchObject({ code: 'VERDICT_PROVIDER_FAILED', message: expect.stringContaining('VERDICT_ANALYSIS_FAILED') });
  });

  test('polza получает maxTokens и без ретраев SDK-таймаута', async () => {
    const polza = link('polza', async () => okRes('p'));
    polza.isPolza = true;
    await createVerdictProvider({ chain: [polza], sleep: async () => {} }).createMessage(req);
    expect(polza.createMessage.mock.calls[0][1]).toMatchObject({ maxTokens: 8000, maxRetries: 1 });
  });
});

test('transport failure skips Claude on the same bridge', async () => {
  const gpt = link('gpt', async () => { throw err('RELAY_UPSTREAM'); });
  const claude = link('claude', async () => okRes('c'));
  const polza = link('polza', async () => okRes('p'));
  expect((await createVerdictProvider({ chain: [gpt, claude, polza] }).createMessage({})).model).toBe('p');
  expect(claude.createMessage).not.toHaveBeenCalled();
});
test('local input errors are not replayed', async () => {
  const gpt = link('gpt', async () => { throw err('RELAY_INPUT_TOO_LARGE'); });
  const polza = link('polza', async () => okRes('p'));
  await expect(createVerdictProvider({ chain: [gpt, polza] }).createMessage({})).rejects.toMatchObject({ code: 'RELAY_INPUT_TOO_LARGE' });
  expect(polza.createMessage).not.toHaveBeenCalled();
});
test('default chain imports no routing store', () => {
  expect(() => createVerdictProvider()).not.toThrow();
});
