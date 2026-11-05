'use strict';
const { createProvider } = require('./services/agent/providers/resilient');
const { createStore } = require('./services/agent/model-routing');
const input = { system: 'Synthetic', messages: [{ role: 'user', content: 'Hello' }], tools: [] };
const ok = { text: 'Hello', toolCalls: [], model: 'synthetic-model' };
const fail = code => Object.assign(new Error(code), { code });
function setup(active = 'gpt') {
  let state = { active, revision: '0' };
  const store = {
    get: jest.fn(async () => ({ ...state })),
    transition: jest.fn(async (salon, before, next, reason) => {
      if (before.revision !== state.revision) return null;
      state = { active: next, revision: String(+state.revision + 1), reason };
      return { ...state };
    }),
    outcome: jest.fn(async () => {}),
  };
  const providers = Object.fromEntries(['gpt', 'sol', 'claude', 'polza'].map(key => [key, {
    createMessage: jest.fn(async () => ok), toolResultMessages: results => results,
  }]));
  const log = { info: jest.fn(), warn: jest.fn() };
  return { store, providers, log, change: next => { state = next; },
    provider: createProvider({ salonId: 17, store, providers, legacy: providers.gpt, log }) };
}
test('GPT model error falls back to Sol on the same request; sticks across requests', async () => {
  const s = setup(); s.providers.gpt.createMessage.mockRejectedValue(fail('RELAY_MODEL_FAILED'));
  expect(await s.provider.createMessage(input)).toBe(ok);
  await s.provider.createMessage(input);
  expect(s.providers.gpt.createMessage).toHaveBeenCalledTimes(1);
  expect(s.providers.sol.createMessage).toHaveBeenCalledTimes(2);
  expect(s.providers.sol.createMessage.mock.calls[0][0]).toBe(input);
  expect(s.providers.claude.createMessage).not.toHaveBeenCalled();
  expect(s.providers.polza.createMessage).not.toHaveBeenCalled();
  expect(s.store.transition).toHaveBeenCalledWith(17, expect.anything(), 'sol', 'model_failed');
});
test('Sol model error falls back to Claude', async () => {
  const s = setup('sol'); s.providers.sol.createMessage.mockRejectedValue(fail('RELAY_MODEL_FAILED'));
  await s.provider.createMessage(input);
  expect(s.providers.claude.createMessage).toHaveBeenCalledTimes(1);
  expect(s.providers.polza.createMessage).not.toHaveBeenCalled();
  expect(s.store.transition).toHaveBeenCalledWith(17, expect.anything(), 'claude', 'model_failed');
});
test('Sol bridge failure skips Claude (same bridge) and goes to Polza', async () => {
  const s = setup('sol'); s.providers.sol.createMessage.mockRejectedValue(fail('RELAY_TIMEOUT'));
  await s.provider.createMessage(input);
  expect(s.providers.claude.createMessage).not.toHaveBeenCalled();
  expect(s.store.transition).toHaveBeenCalledWith(17, expect.anything(), 'polza', 'bridge_unavailable');
});
test('every failure and switch is journaled with its diagnostics, success after fallback too', async () => {
  const s = setup();
  s.providers.gpt.createMessage.mockRejectedValue(Object.assign(fail('RELAY_MODEL_FAILED'),
    { bridgeCause: 'CODEX_PROCESS_FAILED', httpStatus: 502, requestId: 'req-1' }));
  await s.provider.createMessage(input);
  const warn = s.log.warn.mock.calls.map(c => c[0]).join('\n');
  expect(warn).toMatch(/салон 17: gpt отказала: RELAY_MODEL_FAILED, мост: CODEX_PROCESS_FAILED, http 502, \d+ мс, req req-1 → переключаю на sol \(model_failed\)/);
  expect(s.log.info.mock.calls[0][0]).toMatch(/ответила sol \(synthetic-model\) за \d+ мс после отказа gpt/);
});
test('a lost switch (manual change in between) is journaled, not silent', async () => {
  const s = setup();
  s.providers.gpt.createMessage.mockImplementation(async () => {
    s.change({ active: 'polza', revision: '5' }); throw fail('RELAY_MODEL_FAILED');
  });
  await s.provider.createMessage(input);
  expect(s.log.warn.mock.calls.map(c => c[0]).join('\n')).toMatch(/переключение на sol не записано — выбор уже polza \(rev 5\)/);
});
test('no content of the request reaches the journal', async () => {
  const s = setup();
  const secret = { ...input, system: 'PRIVATE-PROMPT', messages: [{ role: 'user', content: 'PRIVATE-PATIENT' }] };
  for (const id of ['gpt', 'sol', 'claude', 'polza']) s.providers[id].createMessage.mockRejectedValue(fail('RELAY_MODEL_FAILED'));
  await expect(s.provider.createMessage(secret)).rejects.toThrow();
  const all = [...s.log.warn.mock.calls, ...s.log.info.mock.calls].map(c => c[0]).join('\n');
  expect(all).not.toMatch(/PRIVATE/);
});
test.each(['RELAY_FAILED', 'RELAY_TIMEOUT', 'RELAY_BUSY', 'RELAY_UPSTREAM', 'RELAY_AUTH', 'RELAY_CONFIG'])(
  '%s skips Sol and Claude and switches straight to Polza', async code => {
    const s = setup(); s.providers.gpt.createMessage.mockRejectedValue(fail(code));
    await s.provider.createMessage(input);
    expect(s.providers.sol.createMessage).not.toHaveBeenCalled();
    expect(s.providers.claude.createMessage).not.toHaveBeenCalled();
    expect(s.providers.polza.createMessage).toHaveBeenCalledTimes(1);
  });
test('all bridge models fail → Polza, no rerun of previous tool steps', async () => {
  const s = setup();
  for (const id of ['gpt', 'sol', 'claude']) s.providers[id].createMessage.mockRejectedValue(fail('RELAY_MODEL_FAILED'));
  await s.provider.createMessage(input);
  expect(s.store.transition.mock.calls.map(c => c[2])).toEqual(['sol', 'claude', 'polza']);
  expect(s.providers.polza.createMessage.mock.calls[0][0]).toBe(input);
});
test.each(['sol', 'claude', 'polza'])('manual %s starts at selected provider', async active => {
  const s = setup(active); await s.provider.createMessage(input);
  expect(s.providers[active].createMessage).toHaveBeenCalledTimes(1);
  expect(s.providers.gpt.createMessage).not.toHaveBeenCalled();
});
test('all providers fail: retain Polza with error status, no infinite retry', async () => {
  const s = setup();
  for (const p of Object.values(s.providers)) p.createMessage.mockRejectedValue(fail('RELAY_MODEL_FAILED'));
  await expect(s.provider.createMessage(input)).rejects.toThrow();
  expect(s.store.outcome).toHaveBeenCalledWith(17, expect.objectContaining({ active: 'polza' }), 'error');
  for (const p of Object.values(s.providers)) expect(p.createMessage).toHaveBeenCalledTimes(1);
});
test('bad input does not change selection or resend', async () => {
  const s = setup(); s.providers.gpt.createMessage.mockRejectedValue(fail('RELAY_INPUT'));
  await expect(s.provider.createMessage(input)).rejects.toThrow('RELAY_INPUT');
  expect(s.store.transition).not.toHaveBeenCalled();
});
test('empty generation triggers fallback', async () => {
  const s = setup(); s.providers.gpt.createMessage.mockResolvedValue({ text: '', toolCalls: [] });
  await s.provider.createMessage(input);
  expect(s.providers.sol.createMessage).toHaveBeenCalledTimes(1);
  expect(s.providers.claude.createMessage).not.toHaveBeenCalled();
});
test('late failing request respects a concurrent manual switch', async () => {
  const s = setup();
  s.providers.gpt.createMessage.mockImplementation(async () => {
    s.change({ active: 'polza', revision: '1' }); throw fail('RELAY_MODEL_FAILED');
  });
  await s.provider.createMessage(input);
  expect(s.providers.claude.createMessage).not.toHaveBeenCalled();
  expect(s.providers.polza.createMessage).toHaveBeenCalledTimes(1);
});
test('state persistence error never causes successful LLM response to be replayed', async () => {
  const s = setup(); s.store.outcome.mockRejectedValue(new Error('storage unavailable'));
  await expect(s.provider.createMessage(input)).rejects.toThrow('storage unavailable');
  expect(s.store.transition).not.toHaveBeenCalled();
  expect(s.providers.claude.createMessage).not.toHaveBeenCalled();
});
const config = { AGENT_PROVIDER: 'codex-relay', POLZA_CHAT_MODEL: 'test-polza' };
test('new salon inherits configured provider without a DB write', async () => {
  const db = { oneOrNone: jest.fn(async () => null), query: jest.fn() };
  const status = await createStore({ db, config }).status(17, 4);
  expect(status).toMatchObject({ active: 'gpt', model: 'gpt-6-astra', notice: null });
  expect(status.choices.find(c => c.id === 'gpt')).toMatchObject({ title: 'GPT-6 Astra', model: 'gpt-6-astra' });
  expect(status.choices.map(c => c.id)).toEqual(['gpt', 'sol', 'claude', 'polza']);
  expect(status.choices.find(c => c.id === 'sol')).toMatchObject({ title: 'GPT-5.6 Sol', model: 'gpt-5.6-sol' });
  expect(db.query).not.toHaveBeenCalled();
  expect(db.oneOrNone.mock.calls.map(c => c[1])).toEqual([[17], [17, 4]]);
});
test('notice receipt is per salon and admin; acknowledged notice disappears', async () => {
  const row = { active: 'claude', revision: '3', health: 'ok', last_auto: {
    revision: '3', from: 'gpt', to: 'claude', reason: 'model_failed' } };
  const db = { oneOrNone: jest.fn(async (sql, args) => sql.includes('notice_reads')
    ? (args[1] === 4 ? { revision: '3' } : null) : row) };
  const store = createStore({ db, config });
  expect((await store.status(17, 4)).notice).toBeNull();
  expect((await store.status(17, 5)).notice).toMatchObject({ revision: '3', toTitle: 'Claude Sonnet' });
});
test('manual conflict and invalid model are rejected', async () => {
  const db = { query: jest.fn(), oneOrNone: jest.fn(async () => null) };
  const store = createStore({ db, config });
  await expect(store.manual(17, 'custom-command', '1')).rejects.toMatchObject({ code: 'BAD_SELECTION' });
  expect(db.query).not.toHaveBeenCalled();
  await expect(store.manual(17, 'claude', '1')).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(db.oneOrNone.mock.calls[0][0]).toMatch(/WHERE salon_id=\$1 AND revision=\$2/);
  expect(db.oneOrNone.mock.calls[0][1]).toEqual([17, '1', 'claude', null]);
});
test('stale notice ack cannot consume a later event or another tenant', async () => {
  const db = { query: jest.fn() };
  await createStore({ db, config }).acknowledge(17, 4, '3');
  expect(db.query.mock.calls[0][1]).toEqual([17, 4, '3']);
  expect(db.query.mock.calls[0][0]).toMatch(/WHERE salon_id=\$1 AND last_auto->>'revision'=\$3::text/);
});
